import test from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceController } from '../../src/voice-controller.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('trusted local Accessibility commands never enter the agent message queue', async () => {
  const h = harness()
  h.voice({ type: 'transcript.final', utteranceId: 'consent', text: 'confirm action 1234', accessibilityHandled: true, speechEpoch: 1 })
  h.voice({ type: 'transcript.final', utteranceId: 'stop', text: 'stop accessibility', accessibilityHandled: true })
  await tick()
  assert.equal(h.sent.length, 0)
  assert.equal(h.entries.length, 0)
  h.voice({ type: 'transcript.final', utteranceId: 'normal', text: 'What screen is open?' })
  await tick()
  assert.equal(h.sent.length, 1)
})
function harness({ send } = {}) {
  const spoken = [], sent = [], records = [], notices = [], entries = []
  let calls = 0
  const binding = { sessionId: 'speech', targetAgentId: 'coordinator', generation: 1, speechEpoch: 0 }
  const controller = createVoiceController({ settleMs: 0,
    voice: { reply: async value => spoken.push(value), interrupt: async () => ({ speechEpoch: 1 }) },
    agent: { interrupt: async () => { throw new Error('AGENT_TURN_NONE') }, send: async value => { sent.push(value); return send ? send(value) : { turnId: 'turn' } } },
    queue: {
      enqueue: (sessionId, text) => { const entry = { sessionId, text, id: ++calls }; entries.push(entry); return { ok: true, entry } },
      takeNext: sessionId => { const index = entries.findIndex(e => e.sessionId === sessionId); return index < 0 ? null : entries.splice(index, 1)[0] },
      requeueFront: (_sessionId, entry) => entries.unshift(entry), confirmDelivered: () => {},
    },
    notify: text => notices.push(text), record: (...value) => records.push(value), id: () => 'utterance-' + ++calls,
  })
  controller.bind(binding)
  return { controller, binding, spoken, sent, records, notices, entries,
    voice: event => controller.onVoice({ ...binding, sequence: ++calls, ...event }),
    agent: event => controller.onAgent({ sessionId: 'coordinator', event: { turnId: 'turn', ...event } }),
  }
}
test('voice contact speaks only its selected agent, never thinking or tool data', async () => {
  const h = harness()
  h.controller.onAgent({ sessionId: 'worker', event: { type: 'assistant_text_delta', turnId: 'turn', text: 'Private worker answer.' } })
  h.agent({ type: 'thinking', text: 'Private reasoning.' })
  h.agent({ type: 'tool_result', text: 'Tool contents.' })
  h.agent({ type: 'assistant_text_delta', text: 'Hello there. ' })
  h.agent({ type: 'assistant_text', text: 'Hello there. ' })
  h.agent({ type: 'turn_completed' })
  await tick()
  assert.equal(h.spoken.map(v => v.text).join(''), 'Hello there. ')
  assert.equal(h.spoken.at(-1).final, true)
})
test('barge-in suppresses old answer while interrupting agent work', async () => {
  const h = harness()
  h.agent({ type: 'assistant_text_delta', text: 'Old response. ' })
  h.voice({ type: 'speech.started', speechEpoch: 1 })
  h.agent({ type: 'assistant_text_delta', text: 'This must not play. ' })
  await tick()
  assert.equal(h.spoken.length, 0, 'even pending pre-interruption chunks are invalidated')
  h.voice({ type: 'transcript.final', text: 'Change direction', speechEpoch: 1, utteranceId: 'user-1' })
  await tick()
  assert.deepEqual(h.sent, [{ sessionId: 'coordinator', text: 'Change direction' }])
})
test('busy CLI keeps next instruction in the same agent queue until completion', async () => {
  let busy = true
  const h = harness({ send: () => { if (busy) throw new Error('AGENT_TURN_ACTIVE'); return { turnId: 'next' } } })
  h.voice({ type: 'transcript.final', text: 'Do this next', utteranceId: 'user-1' })
  await tick()
  assert.equal(h.entries.length, 1)
  assert.match(h.notices.at(-1), /queued/)
  busy = false
  h.agent({ type: 'turn_completed' })
  await tick()
  assert.equal(h.entries.length, 0)
  assert.equal(h.sent.length, 2)
  assert.equal(h.records.filter(v => v[1] === 'you').length, 1)
})
test('switching rejects stale transcripts and pending old playback', async () => {
  const h = harness()
  h.agent({ type: 'assistant_text_delta', text: 'Old pending answer. ' })
  h.controller.bind({ sessionId: 'new-speech', targetAgentId: 'worker', generation: 2 })
  h.voice({ type: 'transcript.final', text: 'Wrong contact', utteranceId: 'late' })
  await tick()
  assert.equal(h.sent.length, 0)
  assert.equal(h.spoken.length, 0)
})
test('duplicate final transcripts are delivered once and final-only adapters speak', async () => {
  const h = harness()
  const final = { type: 'transcript.final', text: 'Hello', utteranceId: 'u1' }
  h.voice(final); h.voice(final)
  await tick()
  assert.equal(h.sent.length, 1)
  h.agent({ type: 'assistant_text', text: 'One final answer.' })
  h.agent({ type: 'turn_completed' })
  await tick()
  assert.equal(h.spoken.map(v => v.text).join(''), 'One final answer.')
})
test('a fast answer emitted before send admission resolves is not lost', async () => {
  let admit
  const h = harness({ send: () => new Promise(resolve => { admit = resolve }) })
  h.voice({ type: 'speech.started', speechEpoch: 1 })
  h.voice({ type: 'transcript.final', text: 'Hello', speechEpoch: 1, utteranceId: 'u1' })
  await tick()
  h.agent({ type: 'assistant_text_delta', text: 'Fast answer.' })
  h.agent({ type: 'turn_completed' })
  admit({ turnId: 'turn' })
  await tick()
  assert.equal(h.spoken.map(v => v.text).join(''), 'Fast answer.')
})

test('formatted streamed replies speak plainly while the written record stays exact', async () => {
  const h = harness()
  const pieces = ['## Result\n**Hello there. ', '** 😊\nUse [Settings](', 'https://example.test/settings).\n', '```js\n***\n```\n', 'Do **not** delete it.']
  for (const text of pieces) h.agent({ type: 'assistant_text_delta', text })
  h.agent({ type: 'turn_completed' })
  await tick()
  assert.equal(h.spoken.map(v => v.text).join('').replace(/\s+/g, ' ').trim(),
    'Result. Hello there. Use Settings. Code block is in the written reply. Do not delete it.')
  assert.deepEqual(h.records, [['coordinator', 'agent', pieces.join('')]])
  assert.equal(h.spoken.at(-1).final, true)
  assert.equal(h.spoken.filter(v => !v.final && !v.text.trim()).length, 0)
})

test('decoration-only replies still close the speech utterance without speaking emoji', async () => {
  const h = harness()
  h.agent({ type: 'assistant_text', text: '**😊**' })
  h.agent({ type: 'turn_completed' })
  await tick()
  assert.deepEqual(h.spoken.map(v => [v.text, v.final]), [['', true]])
  assert.equal(h.records[0][2], '**😊**')
})
