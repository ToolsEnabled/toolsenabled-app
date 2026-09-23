import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { createVoiceController } from '../../src/voice-controller.js'
import * as realQueue from '../../src/session-outbox.js'

const { createVoiceHost } = createRequire(import.meta.url)('../../shell/voice-host.cjs')
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// In-memory fixtures only: no profile lookup, temporary directory, subprocess,
// microphone, cloud provider, persisted settings, or live agent is involved.
function controllerHarness({ send, interrupt, reply } = {}) {
  const sent = [], spoken = [], entries = [], notices = []
  let next = 0
  const binding = { sessionId: 'voice-a', targetAgentId: 'agent-a', generation: 1, speechEpoch: 0 }
  const controller = createVoiceController({ settleMs: 0,
    agent: { interrupt: async () => { throw new Error('AGENT_TURN_NONE') }, send: async value => { sent.push(value); return send ? send(value, sent.length) : { turnId: 'new-turn' } } },
    voice: {
      interrupt: interrupt || (async () => ({ speechEpoch: 1 })),
      reply: async value => { spoken.push(value); return reply ? reply(value, spoken.length) : { accepted: true } },
    },
    queue: {
      enqueue: (sessionId, text) => { const entry = { sessionId, text, id: ++next }; entries.push(entry); return { ok: true, entry } },
      takeNext: sessionId => { const index = entries.findIndex(item => item.sessionId === sessionId); return index < 0 ? null : entries.splice(index, 1)[0] },
      confirmDelivered: () => {},
      requeueFront: (_sessionId, entry) => entries.unshift(entry),
    },
    id: () => 'speech-' + ++next,
    notify: text => notices.push(text),
  })
  controller.bind(binding)
  return { controller, binding, sent, spoken, entries, notices,
    voice: event => controller.onVoice({ ...binding, sequence: ++next, ...event }),
    agent: event => controller.onAgent({ sessionId: binding.targetAgentId, event: { turnId: 'new-turn', ...event } }),
  }
}

function hostHarness({ manualReady = false, replyCode = null } = {}) {
  const owner = {}, processes = [], calls = []
  let errorCode = replyCode
  const host = createVoiceHost({
    appRoot: '.', sessions: new Map([['agent-a', { owner, state: 'ready' }]]), emit: () => {},
    findRuntime: () => ({ python: 'fixture-python-not-executed', worker: 'fixture-worker.py', dataRoot: 'fixture-data-not-written' }),
    spawnProcess() {
      const proc = new EventEmitter()
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.stdin = new EventEmitter()
      proc.stdin.write = () => { if (!manualReady) queueMicrotask(() => ready(processes.indexOf(proc))) }
      proc.stdin.end = () => {}; proc.kill = () => {}
      processes.push(proc)
      return proc
    },
    async fetchHttp(url) {
      calls.push(url)
      if (url.includes('/events?')) return new Promise(() => {})
      if (url.endsWith('/reply') && errorCode) return { ok: false, status: 409, json: async () => ({ error: { code: errorCode } }) }
      return { ok: true, status: 200, json: async () => ({ speechEpoch: 0 }) }
    },
  })
  function ready(index) {
    processes[index].stdout.emit('data', Buffer.from(JSON.stringify({ type: 'ready', protocolVersion: 1, port: 32123 + index }) + '\n'))
  }
  return { host, owner, processes, calls, ready, setReplyCode: code => { errorCode = code } }
}

test('old-target admission cannot strand a new-target transcript', async () => {
  const pending = deferred()
  const h = controllerHarness({ send: (_value, count) => count === 1 ? pending.promise : { turnId: 'target-b-turn' } })
  h.voice({ type: 'transcript.final', text: 'Message for A', utteranceId: 'a' })
  const next = { sessionId: 'voice-b', targetAgentId: 'agent-b', generation: 2, speechEpoch: 0 }
  h.controller.bind(next)
  h.controller.onVoice({ ...next, sequence: 1, type: 'transcript.final', text: 'Message for B', utteranceId: 'b' })
  pending.resolve({ turnId: 'target-a-turn' })
  await tick()
  assert.deepEqual(h.sent, [
    { sessionId: 'agent-a', text: 'Message for A' },
    { sessionId: 'agent-b', text: 'Message for B' },
  ])
  assert.equal(h.entries.length, 0)
})

test('completion preceding a busy refusal cannot lose the queue wakeup', async () => {
  const pending = deferred()
  const h = controllerHarness({ send: (_value, count) => count === 1 ? pending.promise : { turnId: 'new-turn' } })
  h.voice({ type: 'transcript.final', text: 'Do this next', utteranceId: 'a' })
  h.agent({ type: 'turn_completed', turnId: 'busy-turn' })
  pending.reject(new Error('AGENT_TURN_ACTIVE'))
  await tick()
  assert.equal(h.sent.length, 2)
  assert.deepEqual(h.sent[1], { sessionId: 'agent-a', text: 'Do this next' })
  assert.equal(h.entries.length, 0)
})

test('manual interrupt acknowledgement cannot regress a newer VAD epoch', async () => {
  const pending = deferred()
  const h = controllerHarness({ interrupt: () => pending.promise })
  const interrupting = h.controller.interrupt()
  h.voice({ type: 'speech.started', speechEpoch: 2 })
  h.voice({ type: 'transcript.final', text: 'New request', utteranceId: 'b', speechEpoch: 2 })
  await tick()
  pending.resolve({ speechEpoch: 1 })
  await interrupting
  h.agent({ type: 'assistant_text_delta', text: 'The new reply. ' })
  h.agent({ type: 'turn_completed' })
  await tick()
  assert.equal(h.spoken.map(item => item.text).join(''), 'The new reply. ')
  assert.ok(h.spoken.every(item => item.speechEpoch === 2))
})

test('late STT final keeps its originating epoch while newer speech is active', async () => {
  const h = controllerHarness()
  h.voice({ type: 'speech.started', speechEpoch: 1 })
  h.voice({ type: 'speech.started', speechEpoch: 2 })
  // Recognition of utterance one can finish after utterance two starts.
  h.voice({ type: 'transcript.final', text: 'Old request', utteranceId: 'a', speechEpoch: 1 })
  await tick()
  h.agent({ type: 'assistant_text_delta', text: 'Response to the old request. ' })
  h.agent({ type: 'turn_completed' })
  await tick()
  assert.deepEqual(h.sent, [], 'Recognition of an earlier segment cannot start generation during continued speech')
  assert.equal(h.spoken.length, 0, 'An old reply must not be retagged to speak over the newer utterance')
})

test('speech backpressure preserves text or explicitly pauses speech', async () => {
  const h = controllerHarness({ reply: (_value, count) => {
    if (count === 1) throw Object.assign(new Error('speech_backpressure'), { code: 'speech_backpressure' })
    return { accepted: true }
  } })
  h.agent({ type: 'assistant_text_delta', text: 'First sentence. Second sentence. ' })
  h.agent({ type: 'turn_completed' })
  await tick()
  h.voice({ type: 'playback.stopped', speechEpoch: 0 })
  await tick()
  const retried = h.spoken.filter(item => item.text === 'First sentence. ').length > 1
  const clearlyPaused = h.spoken.length === 1 && h.notices.some(text => /paused/i.test(text) && /text|reply/i.test(text))
  assert.ok(retried || clearlyPaused, 'Do not discard a rejected phrase then speak the remaining suffix as if it were complete')
})

test('a runtime-valid long transcript is refused before the real outbox can truncate it', async () => {
  const binding = { sessionId: 'voice-long', targetAgentId: 'voice-race-long-transcript', generation: 1, speechEpoch: 1 }
  const sent = [], notices = []
  const controller = createVoiceController({ settleMs: 0, queue: realQueue,
    agent: { interrupt: async () => { throw new Error('AGENT_TURN_NONE') }, send: async value => { sent.push(value); return { turnId: 'long-turn' } } },
    voice: { reply: async () => ({}), interrupt: async () => ({ speechEpoch: 2 }) },
    notify: text => notices.push(text),
  })
  try {
    controller.bind(binding)
    const text = 'First part. '.repeat(400) + 'Do not delete any files.'
    assert.ok(text.length > 4000 && text.length < 8192)
    controller.onVoice({ ...binding, sequence: 1, type: 'transcript.final', text, utteranceId: 'long-input' })
    await tick()
    assert.equal(sent.length, 0, 'Never execute a prefix that lost the trailing qualification')
    assert.equal(realQueue.list(binding.targetAgentId).length, 0)
    assert.ok(notices.some(value => /too long/i.test(value) && /nothing was sent/i.test(value)))
  } finally { realQueue.clearSession(binding.targetAgentId) }
})

test('a late worker ready line after close cannot revive the killed origin', async () => {
  const h = hostHarness({ manualReady: true })
  try {
    const first = h.host.start(h.owner, { targetAgentId: 'agent-a', provider: 'local' }).catch(error => error)
    h.host.close(h.owner)
    h.ready(0)
    h.processes[0].emit('exit', 0)
    assert.ok(await first instanceof Error)
    const restarting = h.host.start(h.owner, { targetAgentId: 'agent-a', provider: 'local' }).catch(error => error)
    await tick()
    assert.equal(h.processes.length, 2, 'A replacement start must spawn a new worker')
    h.ready(1)
    assert.ok(!(await restarting instanceof Error))
    assert.ok(h.calls.every(url => url.startsWith('http://127.0.0.1:32124/')))
  } finally { h.host.close() }
})

test('public replies buffer until native WebRTC is connected', async () => {
  const h = controllerHarness()
  h.controller.bind(h.binding, { ready: false })
  h.agent({ type: 'assistant_text_delta', text: 'Buffered before the audio connection. ' })
  h.agent({ type: 'assistant_text', text: 'Buffered before the audio connection. ' })
  h.agent({ type: 'turn_completed' })
  await tick()
  assert.equal(h.spoken.length, 0, 'No reply can be sent during permission or ICE setup')
  h.controller.ready()
  await tick()
  assert.equal(h.spoken.map(item => item.text).join(''), 'Buffered before the audio connection. ')
  assert.equal(h.spoken.at(-1).final, true)
  assert.ok(h.spoken.every(item => item.sessionId === h.binding.sessionId && item.generation === h.binding.generation))
})

test('host distinguishes media_not_ready from legitimately stale reply conflicts', async () => {
  const h = hostHarness({ replyCode: 'media_not_ready' })
  try {
    const binding = await h.host.start(h.owner, { targetAgentId: 'agent-a', provider: 'local' })
    const reply = { ...binding, speechEpoch: 0, utteranceId: 'before-connect', text: 'Not connected.', final: true }
    await assert.rejects(h.host.reply(h.owner, reply), { code: 'VOICE_RUNTIME_REQUEST_FAILED' })
    for (const code of ['stale_speech', 'stale_utterance', 'stale_binding']) {
      h.setReplyCode(code)
      assert.deepEqual(await h.host.reply(h.owner, reply), { ok: false, dropped: true })
    }
  } finally { h.host.close() }
})

test('late failure of canceled playback cannot silence a newer answer', async()=>{
 const old=deferred();const h=controllerHarness({reply:(_v,count)=>count===1?old.promise:{accepted:true}})
 h.agent({type:'assistant_text_delta',text:'Old audio. ',turnId:'old'});await tick()
 h.voice({type:'speech.started',speechEpoch:1});h.voice({type:'transcript.final',speechEpoch:1,text:'New request',utteranceId:'new'});await tick()
 h.agent({type:'assistant_text_delta',text:'New audio. '});h.agent({type:'turn_completed'});old.reject(new Error('old request canceled'));await tick()
 assert.equal(h.spoken.at(-1).final,true);assert.ok(h.spoken.some(v=>v.text==='New audio. '));assert.equal(h.notices.some(v=>v.includes('could not keep up')),false)
})
