import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
const { createNativePersonStop } = createRequire(import.meta.url)('../../shell/native-person-stop.cjs')
const deferred = () => { let resolve; const promise = new Promise(go => { resolve = go }); return { promise, resolve } }
const code = expected => error => error.code === expected

function fixture({ check, close, now, timeoutMs } = {}) {
  const owner = {}, principal = { kind: 'window', owner }, context = { secret: 'native-only' }
  const session = { owner, treeNodeId: 'node-a' }
  const target = { version: 1, nodeId: 'node-a', treeId: 'tree-a', sessionId: 'session-a', revision: 'a'.repeat(64) }
  const sent = [], closed = [], timers = []
  const state = { recorded: false, targetCurrent: true }
  const broker = createNativePersonStop({
    now, timeoutMs,
    checkContext: async received => { assert.equal(received, context); if (check) await check() },
    closeSession: async (id, expectedSession, caller) => {
      assert.equal(expectedSession, session)
      assert.equal(caller, principal)
      closed.push(id)
      return close ? close() : { ok: true, closed: true, sessionId: id }
    },
    send: (receiver, payload) => { assert.equal(receiver, owner); sent.push(payload) },
    setTimer: callback => { timers.push(callback); return callback }, clearTimer: () => {},
  })
  const dispatch = () => broker.dispatch({ request: { requestId: 'request-a', target }, session, context,
    assertTarget: () => { if (!state.targetCurrent) throw Object.assign(new Error('replaced'), { code: 'MC_AGENT_DESKTOP_STOP_STALE_TARGET' }) },
    savedStateRecorded: () => state.recorded,
  })
  return { broker, owner, principal, session, sent, closed, state, timers, dispatch,
    key: () => ({ requestId: sent[0].requestId, token: sent[0].token }) }
}

test('no capability/delivery without a ready native handler; readiness never changes navigation', () => {
  const f = fixture()
  assert.equal(f.broker.ready(f.session), false)
  assert.throws(f.dispatch, code('MC_AGENT_DESKTOP_STOP_UNAVAILABLE'))
  f.broker.setReady(f.owner, true)
  assert.equal(f.broker.ready(f.session), true)
  assert.deepEqual(f.sent, [])
})

test('only exact admitted native owner and one-use token can close the bound session', async () => {
  const f = fixture()
  f.broker.setReady(f.owner, true)
  const delivered = f.dispatch()
  assert.doesNotMatch(JSON.stringify(f.sent), /native-only|secret|owner/)
  await assert.rejects(f.broker.close(f.key(), {}, f.principal), code('MC_AGENT_DESKTOP_STOP_UNAVAILABLE'))
  await assert.rejects(f.broker.close({ ...f.key(), sessionId: 'other-session' }, f.owner, f.principal), code('MC_AGENT_DESKTOP_STOP_INVALID'))
  assert.equal((await f.broker.close(f.key(), f.owner, f.principal)).closed, true)
  await assert.rejects(f.broker.close(f.key(), f.owner, f.principal), code('MC_AGENT_DESKTOP_STOP_UNAVAILABLE'))
  f.state.recorded = true
  f.broker.complete({ ...f.key(), savedState: 'recorded' }, f.owner)
  assert.deepEqual(await delivered.completion, { closed: true, savedState: 'recorded' })
  assert.deepEqual(f.closed, ['session-a'])
})

test('native response cannot forge a closed session or a persisted note', async () => {
  const f = fixture()
  f.broker.setReady(f.owner, true)
  const delivered = f.dispatch()
  assert.throws(() => f.broker.complete({ ...f.key(), savedState: 'recorded' }, f.owner), code('MC_AGENT_DESKTOP_STOP_UNAVAILABLE'))
  await f.broker.close(f.key(), f.owner, f.principal)
  f.broker.complete({ ...f.key(), savedState: 'recorded' }, f.owner)
  assert.deepEqual(await delivered.completion, { closed: true, savedState: 'unconfirmed' })
})

test('native view replacement before claim refuses without close', async () => {
  const f = fixture()
  f.broker.setReady(f.owner, true)
  const delivered = f.dispatch()
  f.broker.setReady(f.owner, false)
  const result = await delivered.completion
  assert.equal(result.outcome, 'not-sent')
  await assert.rejects(f.broker.close(f.key(), f.owner, f.principal), code('MC_AGENT_DESKTOP_STOP_UNAVAILABLE'))
  assert.deepEqual(f.closed, [])
})

test('view replacement during authority check prevents the host close edge', async () => {
  const check = deferred()
  const f = fixture({ check: () => check.promise })
  f.broker.setReady(f.owner, true)
  const delivered = f.dispatch()
  const closing = f.broker.close(f.key(), f.owner, f.principal)
  f.broker.setReady(f.owner, false)
  check.resolve()
  await assert.rejects(closing, code('MC_AGENT_DESKTOP_STOP_UNAVAILABLE'))
  assert.equal((await delivered.completion).outcome, 'not-sent')
  assert.deepEqual(f.closed, [])
})

test('replacement target fails at the final synchronous lease check', async () => {
  const f = fixture()
  f.broker.setReady(f.owner, true)
  const delivered = f.dispatch()
  f.state.targetCurrent = false
  await assert.rejects(f.broker.close(f.key(), f.owner, f.principal), code('MC_AGENT_DESKTOP_STOP_STALE_TARGET'))
  f.broker.complete({ ...f.key(), outcome: 'not-sent' }, f.owner)
  assert.equal((await delivered.completion).outcome, 'not-sent')
  assert.deepEqual(f.closed, [])
})

test('authority check crossing the deadline refuses close before the expiry timer runs', async () => {
  let clock = 0
  const check = deferred()
  const f = fixture({ check: () => check.promise, now: () => clock, timeoutMs: 10 })
  f.broker.setReady(f.owner, true)
  const delivered = f.dispatch()
  clock = 5
  const closing = f.broker.close(f.key(), f.owner, f.principal)
  clock = 11
  check.resolve()
  await assert.rejects(closing, code('MC_AGENT_DESKTOP_STOP_UNAVAILABLE'))
  assert.deepEqual(f.closed, [], 'an expired authority check cannot dispatch the close')
  f.broker.complete({ ...f.key(), savedState: 'recorded' }, f.owner)
  assert.deepEqual(await delivered.completion, {
    outcome: 'not-sent', closed: false, code: 'MC_AGENT_DESKTOP_STOP_UNAVAILABLE',
  })
  f.timers[0]()
  await assert.rejects(f.broker.close(f.key(), f.owner, f.principal), code('MC_AGENT_DESKTOP_STOP_UNAVAILABLE'))
})

test('after host dispatch native view loss does not undo cleanup or promise a saved note', async () => {
  const close = deferred()
  const f = fixture({ close: () => close.promise })
  f.broker.setReady(f.owner, true)
  const delivered = f.dispatch()
  const closing = f.broker.close(f.key(), f.owner, f.principal)
  await new Promise(resolve => setImmediate(resolve))
  f.broker.setReady(f.owner, false)
  close.resolve({ ok: true, closed: true, sessionId: 'session-a' })
  await closing
  assert.deepEqual(await delivered.completion, { closed: true, savedState: 'unconfirmed' })
  assert.deepEqual(f.closed, ['session-a'])
})

test('unclaimed expiry has no close and cannot later redeem its token', async () => {
  const f = fixture()
  f.broker.setReady(f.owner, true)
  const delivered = f.dispatch()
  f.timers[0]()
  assert.equal((await delivered.completion).outcome, 'not-sent')
  await assert.rejects(f.broker.close(f.key(), f.owner, f.principal), code('MC_AGENT_DESKTOP_STOP_UNAVAILABLE'))
})

test('native renderer crash and full navigation withdraw readiness and unclaimed work', async () => {
  const { EventEmitter } = await import('node:events')
  const owner = new EventEmitter(), sent = []
  const broker = createNativePersonStop({ checkContext: async () => {}, closeSession: () => { throw Error('must not close') }, send: (_owner, value) => sent.push(value) })
  const session = { owner }, target = { sessionId: 'session-a' }
  broker.setReady(owner, true)
  const one = broker.dispatch({ request: { requestId: 'a', target }, session })
  owner.emit('render-process-gone')
  assert.equal(broker.ready(session), false)
  assert.equal((await one.completion).outcome, 'not-sent')
  broker.setReady(owner, true)
  owner.emit('did-start-navigation', {}, 'http://native/', false, false)
  assert.equal(broker.ready(session), true, 'subframe navigation does not own native readiness')
  owner.emit('did-start-navigation', {}, 'http://native/', false, true)
  assert.equal(broker.ready(session), false)
})
