// B1 (found by hand on the installed 1.0.46 with Codex, then reproduced on 1.0.46 v6 with Claude,
// 2026-09-25): Send now interrupted the running turn and sent the new message, the agent answered
// (the durable transcript held "KIWI"), and the tab showed nothing: the interrupted turn's late
// completion arrived while the new send was in flight, settled the new turn's open stream, and the
// real reply then had no stream to land in. These drive the real session surface through the same
// controller the Send now button uses.
import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const settled = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

async function mount(t) {
  const { document, restore } = installDomStandIn(globalThis)
  const store = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  }
  const rig = { listener: null, sessionId: null, control: null, sends: [] }
  const bridge = {
    availability: async () => ({ ok: true }),
    onEvent: fn => { rig.listener = fn; return () => { rig.listener = null } },
    start: async arg => { rig.sessionId = arg.sessionId; return { ok: true, sessionId: arg.sessionId, threadId: 'thread-b1' } },
    send: arg => new Promise(resolve => rig.sends.push({ arg, resolve })),
    interrupt: async () => ({ ok: true }),
    close: async () => ({ ok: true }),
  }
  const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
  const root = document.createElement('div')
  document.body.appendChild(root)
  const dispose = mountAgentSessionSurface(root, {
    live: true, agentId: 'agent-b1', bridge, chatComposer: true, chatTitle: 'Agent 1',
    onController: value => { rig.control = value },
  })
  t.after(() => { try { dispose?.() } finally { restore() } })
  await settled()
  rig.emit = event => rig.listener?.({ sessionId: rig.sessionId, event })
  rig.agentLines = () => rig.control.snapshot().transcript.filter(entry => entry.who === 'agent').map(entry => entry.text)
  return rig
}

async function runningTurnA(rig) {
  const first = rig.control.send('Count slowly from 1 to 80.')
  await settled()
  rig.sends[0].resolve({ ok: true, turnId: 'turn-A', deliveryDisposition: 'accepted' })
  await first
  rig.emit({ type: 'assistant_text_delta', turnId: 'turn-A', text: '1. one\n2. two\n' })
  await settled()
}

test('B1: the interrupted turn finishing while Send now is in flight does not swallow the new reply', async t => {
  const rig = await mount(t)
  await runningTurnA(rig)
  assert.equal((await rig.control.pause()).ok, true)
  const second = rig.control.send('Stop that. Reply with exactly one word: KIWI')
  await settled()
  rig.emit({ type: 'assistant_text_delta', turnId: 'turn-A', text: '3. three\n' })
  rig.emit({ type: 'turn_completed', turnId: 'turn-A', status: 'interrupted' })
  await settled()
  rig.sends[1].resolve({ ok: true, turnId: 'turn-B', deliveryDisposition: 'accepted' })
  await second
  rig.emit({ type: 'assistant_text_delta', turnId: 'turn-B', text: 'KIWI' })
  rig.emit({ type: 'turn_completed', turnId: 'turn-B', status: 'completed' })
  await settled(50)
  const lines = rig.agentLines()
  assert.ok(lines.includes('KIWI'), `the reply to the Send now message was not shown: ${JSON.stringify(lines)}`)
  assert.ok(!lines.some(line => /three/.test(line) && /KIWI/.test(line)), 'the abandoned turn was mixed into the new reply')
})

test('B1: late words of the interrupted turn after the new turn is known do not take the turn back', async t => {
  const rig = await mount(t)
  await runningTurnA(rig)
  assert.equal((await rig.control.pause()).ok, true)
  const second = rig.control.send('Stop that. Reply with exactly one word: KIWI')
  await settled()
  rig.sends[1].resolve({ ok: true, turnId: 'turn-B', deliveryDisposition: 'accepted' })
  await second
  rig.emit({ type: 'assistant_text_delta', turnId: 'turn-A', text: '3. three\n' })
  rig.emit({ type: 'assistant_text_delta', turnId: 'turn-B', text: 'KIWI' })
  rig.emit({ type: 'turn_completed', turnId: 'turn-A', status: 'interrupted' })
  rig.emit({ type: 'turn_completed', turnId: 'turn-B', status: 'completed' })
  await settled(50)
  const lines = rig.agentLines()
  assert.ok(lines.includes('KIWI'), `the reply to the Send now message was not shown: ${JSON.stringify(lines)}`)
})

test('an ordinary follow-up turn is unchanged: its reply is shown', async t => {
  const rig = await mount(t)
  await runningTurnA(rig)
  rig.emit({ type: 'turn_completed', turnId: 'turn-A', status: 'completed' })
  await settled()
  const second = rig.control.send('And now say PLUM.')
  await settled()
  rig.sends[1].resolve({ ok: true, turnId: 'turn-B', deliveryDisposition: 'accepted' })
  await second
  rig.emit({ type: 'assistant_text_delta', turnId: 'turn-B', text: 'PLUM' })
  rig.emit({ type: 'turn_completed', turnId: 'turn-B', status: 'completed' })
  await settled(50)
  assert.deepEqual(rig.agentLines(), ['1. one\n2. two\n', 'PLUM'])
})
