import assert from 'node:assert/strict'
import test from 'node:test'
import { stopNativePersonSession } from '../../src/native-person-stop.js'
import { createNativeStopSurface } from '../../src/native-stop-surface.js'
const deferred = () => { let resolve; const promise = new Promise(go => { resolve = go }); return { promise, resolve } }
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
function fixture() {
  const events = [], state = { active: true, sessionId: 'session-a', saved: false, persistenceFailed: false }
  const node = { id: 'node-a', sessionId: 'session-a' }
  const deps = { current: () => state.active, close: async request => { events.push(['close', request.sessionId]); return { ok: true, closed: true, ...request } },
    forgetCleanup: id => events.push(['forget', id]), clearOutbox: id => { events.push(['outbox', id]); return 2 },
    settle: id => events.push(['settle', id]), retire: id => events.push(['retire', id]), resetMetrics: id => events.push(['metrics', id]),
    ownsNode: () => state.sessionId === node.sessionId,
    saveStopped: () => { events.push(['save']); state.saved = true; return { ok: true, snapshot: { persistenceFailed: state.persistenceFailed } } },
    recorded: () => state.saved,
  }
  return { node, deps, state, events }
}
test('native person Stop closes exactly once before outbox, partial reply, runtime metrics and saved note cleanup', async () => {
  const f = fixture(), result = await stopNativePersonSession(f.node, f.deps)
  assert.deepEqual(result, { closed: true, savedState: 'recorded', dropped: 2 })
  assert.deepEqual(f.events, [['close', 'session-a'], ['forget', 'session-a'], ['outbox', 'session-a'], ['settle', 'session-a'], ['metrics', 'session-a'], ['save']])
})
for (const answer of [undefined, { ok: true }, { closed: true, ok: false }, { closed: true, sessionId: 'other' }]) test(`no cleanup on an unconfirmed close ${JSON.stringify(answer)}`, async () => {
  const f = fixture(); f.deps.close = async () => answer
  assert.equal((await stopNativePersonSession(f.node, f.deps)).closed, false)
  assert.deepEqual(f.events, [])
})
test('close rejection preserves exact Stop target, queued messages and saved state', async () => {
  const f = fixture(); f.deps.close = async () => { throw Error('uncertain') }
  assert.deepEqual(await stopNativePersonSession(f.node, f.deps), { closed: false, savedState: 'pending' })
  assert.deepEqual(f.events, [])
})
test('a replacement session during close is never stamped stopped', async () => {
  const f = fixture(), close = deferred(); f.deps.close = () => close.promise
  const pending = stopNativePersonSession(f.node, f.deps); f.state.sessionId = 'session-b'; close.resolve({ closed: true })
  assert.equal((await pending).savedState, 'unconfirmed')
  assert.equal(f.state.saved, false)
  assert.equal(f.events.some(([name]) => name === 'save'), false)
})
test('navigation during admitted close retires exact old runtime and reports saved uncertainty without writing old view', async () => {
  const f = fixture(), close = deferred(); f.deps.close = () => close.promise
  const pending = stopNativePersonSession(f.node, f.deps); f.state.active = false; close.resolve({ closed: true })
  assert.equal((await pending).savedState, 'unconfirmed')
  assert.deepEqual(f.events, [['forget', 'session-a'], ['outbox', 'session-a'], ['retire', 'session-a'], ['metrics', 'session-a']])
})
test('durable write failure does not produce a saved Stop receipt', async () => {
  const f = fixture(); f.state.persistenceFailed = true
  assert.equal((await stopNativePersonSession(f.node, f.deps)).savedState, 'unconfirmed')
})
function surface() {
  const calls = []; let receive
  const bridge = { onRequest: fn => { receive = fn; return () => calls.push(['unsubscribe']) },
    ready: value => { calls.push(['ready', value]); return { ok: true } },
    close: value => { calls.push(['close', value]); return { closed: true } }, complete: value => calls.push(['complete', value]) }
  return { driver: createNativeStopSurface(bridge), calls, receive: value => receive(value) }
}
test('native controller readiness follows actual mount; late retired boot cannot advertise Stop', async () => {
  const f = surface(), old = deferred()
  f.driver.mount({ ready: old.promise, run: () => {} }); f.driver.mount(null); old.resolve(true); await tick()
  assert.equal(f.calls.some(([name, value]) => name === 'ready' && value), false)
  f.driver.mount({ ready: Promise.resolve(false), run: () => {} }); await tick()
  assert.equal(f.calls.some(([name, value]) => name === 'ready' && value), false)
})
test('surface preserves route/controller and supplies no target override to one-use native close', async () => {
  const f = surface(), target = { nodeId: 'node-a', sessionId: 'session-a' }
  f.driver.mount({ ready: Promise.resolve(true), run: async (received, close) => { assert.equal(received, target); await close(); return { savedState: 'recorded' } } })
  await tick(); await f.receive({ requestId: 'request-a', token: 'token-a', target })
  assert.deepEqual(f.calls.filter(([name]) => name === 'close'), [['close', { requestId: 'request-a', token: 'token-a' }]])
  assert.deepEqual(f.calls.at(-1), ['complete', { requestId: 'request-a', token: 'token-a', savedState: 'recorded' }])
  f.driver.dispose(); assert.deepEqual(f.calls.at(-1), ['unsubscribe'])
})
test('no mounted native controller refuses without any close or navigation', async () => {
  const f = surface(); await f.receive({ requestId: 'request-a', token: 'token-a', target: {} })
  assert.equal(f.calls.some(([name]) => name === 'close'), false)
  assert.equal(f.calls.at(-1)[1].outcome, 'not-sent')
})
