import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import resourceLeaseModule from '../../shell/agent-session-resource.cjs'
const { createSessionResourceLease } = resourceLeaseModule
const turn = () => new Promise(resolve => setImmediate(resolve))
function fixture(options = {}) {
  const calls = []
  const governor = { revalidate(token) { calls.push(['check', token]); return { ok: true } },
    ready(token) { calls.push(['ready', token]) }, release(token, id) { calls.push(['release', token, id]) } }
  const lease = createSessionResourceLease({ governor, token: 'one', sessionId: 'session',
    assertAuthority() { calls.push(['authority']) }, platform: 'win32', cleanupWaitMs: 50, ...options })
  const child = new EventEmitter()
  let resolveOutcome, rejectOutcome
  child.jobOutcome = new Promise((resolve, reject) => { resolveOutcome = resolve; rejectOutcome = reject })
  child.terminateJob = async () => { calls.push(['terminate']) }
  return { lease, child, calls, resolveOutcome, rejectOutcome }
}

test('one root checks exact authority before spending its existing reservation, with no second debit', async () => {
  const f = fixture()
  f.lease.rootLaunch.spawned(f.child)
  f.lease.rootLaunch.beforeRootSpawn()
  f.lease.ready()
  assert.deepEqual(f.calls, [['authority'], ['check', 'one'], ['ready', 'one']])
  assert.throws(() => f.lease.rootLaunch.beforeRootSpawn(), { code: 'AGENT_SESSION_START_CANCELLED' })
  const ending = f.lease.release()
  f.child.emit('close'); f.resolveOutcome({ activeProcesses: 0 }); await ending
  assert.deepEqual(f.calls.at(-1), ['release', 'one', 'session'])
  await f.lease.release(); assert.equal(f.calls.filter(([kind]) => kind === 'release').length, 1)
})

test('closed wrapper without a zero-process receipt cannot return capacity; either event order works', async () => {
  for (const closeFirst of [true, false]) {
    const f = fixture(); f.lease.rootLaunch.spawned(f.child)
    const ending = f.lease.release()
    if (closeFirst) f.child.emit('close'); else f.resolveOutcome({ activeProcesses: 0 })
    await turn()
    assert.equal(f.calls.length, 0)
    if (closeFirst) f.resolveOutcome({ activeProcesses: 0 }); else f.child.emit('close')
    await ending
    assert.equal(f.calls.filter(([kind]) => kind === 'release').length, 1)
  }
})

test('startup failure retains and terminates an unreturned child, then awaits actual cleanup', async () => {
  const f = fixture(); f.lease.rootLaunch.spawned(f.child)
  const ending = f.lease.abort()
  await turn(); assert.deepEqual(f.calls, [['terminate']])
  f.child.emit('exit'); await turn(); assert.deepEqual(f.calls, [['terminate']])
  f.child.emit('close'); f.resolveOutcome({ activeProcesses: 0 }); await ending
  assert.equal(f.calls.at(-1)[0], 'release')
})

test('unknown cleanup, nonzero job and elapsed cleanup deadline all retain their reservations', async () => {
  for (const mode of ['unknown', 'nonzero', 'deadline']) {
    const f = fixture({ cleanupWaitMs: 5 }); f.lease.rootLaunch.spawned(f.child)
    const ending = f.lease.release()
    if (mode === 'unknown') { f.child.emit('close'); f.rejectOutcome(new Error('unknown')) }
    if (mode === 'nonzero') { f.child.emit('close'); f.resolveOutcome({ activeProcesses: 1 }) }
    await assert.rejects(ending, { code: 'AGENT_SESSION_CLEANUP_FAILED' })
    assert.equal(f.calls.filter(([kind]) => kind === 'release').length, 0)
    if (mode === 'deadline') {
      f.child.emit('close'); f.resolveOutcome({ activeProcesses: 0 }); await turn()
      assert.equal(f.calls.filter(([kind]) => kind === 'release').length, 1, 'later measured cleanup is still accepted')
    }
  }
})

test('a root that already exited cannot be called ready, and Off still cannot bypass identity', async () => {
  const f = fixture(); f.lease.rootLaunch.spawned(f.child); f.lease.rootLaunch.beforeRootSpawn(); f.child.emit('exit')
  assert.throws(() => f.lease.ready(), { code: 'AGENT_ENGINE_INVALID_SESSION' })
  f.child.emit('close'); f.resolveOutcome({ activeProcesses: 0 }); await f.lease.release()
  const revoked = fixture({ assertAuthority() { throw Object.assign(new Error('revoked'), { code: 'OWNER_HOST_SESSION_REFUSED' }) } })
  assert.throws(() => revoked.lease.rootLaunch.beforeRootSpawn(), { code: 'OWNER_HOST_SESSION_REFUSED' })
  assert.deepEqual(revoked.calls, [], 'resource policy is not consulted instead of mandatory authority')
  await revoked.lease.release()
})

test('direct roots also require actual close; an exit event or a kill request is insufficient', async () => {
  const f = fixture({ platform: 'linux' }); delete f.child.jobOutcome
  f.lease.rootLaunch.beforeRootSpawn(); f.lease.rootLaunch.spawned(f.child); f.lease.ready()
  const ending = f.lease.release(); f.child.emit('exit'); await turn()
  assert.equal(f.calls.some(([kind]) => kind === 'release'), false)
  f.child.emit('close'); await ending
  assert.equal(f.calls.at(-1)[0], 'release')
})

test('pre-spawn refusal has no root to reap, but a missing Windows job contract is never treated as cleanup', async () => {
  const absent = fixture(); await absent.lease.release(); assert.equal(absent.calls.at(-1)[0], 'release')
  const missing = fixture({ cleanupWaitMs: 5 }); delete missing.child.jobOutcome
  missing.lease.rootLaunch.spawned(missing.child); missing.lease.rootLaunch.beforeRootSpawn()
  assert.throws(() => missing.lease.ready(), { code: 'AGENT_ENGINE_INVALID_SESSION' })
  missing.child.emit('close')
  await assert.rejects(missing.lease.release(), { code: 'AGENT_SESSION_CLEANUP_FAILED' })
  assert.equal(missing.calls.some(([kind]) => kind === 'release'), false)
})

test('a bounded Linux session also requires complete process-tree evidence instead of a direct-root close', async () => {
  const f = fixture({ platform: 'linux', requireContainment: true, cleanupWaitMs: 5 })
  delete f.child.jobOutcome
  f.lease.rootLaunch.spawned(f.child); f.lease.rootLaunch.beforeRootSpawn()
  assert.throws(() => f.lease.ready(), { code: 'AGENT_ENGINE_INVALID_SESSION' })
  f.child.emit('close')
  await assert.rejects(f.lease.release(), { code: 'AGENT_SESSION_CLEANUP_FAILED' })
  assert.equal(f.calls.some(([kind]) => kind === 'release'), false)
})
