import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { identity } from './owner-administration-fixture.mjs'
import fenceModule from '../../shell/remote-connection-fence.cjs'
import lifecycleModule from '../../shell/remote-connection-lifecycle.cjs'
import contract from '../../shell/owner-administration-contract.cjs'
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-admin-lifecycle-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const keys = identity(directory)
  const state = { connected: false, running: false, cache: false, consent: true, starts: 0, calls: [], claimOpen: false }
  const fence = fenceModule.createRemoteConnectionFence({ directory, ...overrides.fence })
  const claim = {
    status: async () => ({ ok: true, connected: state.connected, childQuiescent: true }),
    claimOpen: () => state.claimOpen, enrolled: () => state.cache,
    begin: async () => ({ ok: true }), poll: async () => ({ ok: true, state: 'connected' }), cancel: () => ({ ok: true }),
    invalidateForDisconnect: async () => { state.cache = false; return { quiescent: true } },
    disconnect: async () => { state.connected = false; return { ok: true, wasConnected: true, mutationOutcome: 'REMOVED_SYNCED', childQuiescent: true } },
    completeAdministration: () => { state.cache = true; return true },
    administer: async action => {
      state.calls.push(action)
      if (action === 'prepare') return { ok: true, stage: 'prepared', childQuiescent: true }
      if (action === 'cancel') return { ok: true, stage: 'cancelled', childQuiescent: true }
      if (action === 'import') state.connected = true
      return { ok: true, stage: action === 'finalize' ? 'finalized' : 'stored', childQuiescent: true, receipt: keys.receipt(action === 'finalize') }
    }, ...overrides.claim,
  }
  const lifecycle = lifecycleModule.createRemoteConnectionLifecycle({ fence, claim,
    relay: { status: () => ({ running: state.running }), stop: async () => { state.running = false; return { ok: true, stopped: true } } },
    revoke: () => true, clearConsent: () => { state.consent = false; return true },
    onConnected: () => { state.starts++; state.running = true }, ...overrides.dependencies })
  const input = { context: keys.context }
  return { directory, ...keys, state, fence, claim, lifecycle, input }
}
test('administrative storage remains fenced and only exact finalized receipt clears prior consent and starts relay', async t => {
  const f = fixture(t)
  assert.equal((await f.lifecycle.administer('prepare', f.input)).ok, true)
  assert.equal(f.fence.allowsRemote(), false)
  assert.equal(f.state.consent, true)
  assert.equal((await f.lifecycle.begin({ name: 'competing' })).ok, false)
  assert.equal((await f.lifecycle.poll()).ok, false)
  assert.equal((await f.lifecycle.administer('import', f.input)).ok, true)
  assert.equal((await f.lifecycle.status()).connected, true)
  assert.equal(f.fence.allowsRemote(), false)
  assert.equal(f.state.cache, false)
  const answer = await f.lifecycle.administer('finalize', f.input)
  assert.equal(answer.ok, true)
  assert.equal(answer.remoteAccessBlocked, false)
  assert.equal(f.state.consent, false)
  assert.equal(f.state.starts, 1)
  assert.equal(f.fence.snapshot().adminOperation, null)
  assert.equal(fenceModule.createRemoteConnectionFence({ directory: f.directory }).allowsRemote(), true)
})
test('prepare refuses enrolled running pending-claim damaged and concurrent work without admitting importer', async t => {
  for (const property of ['connected', 'running', 'claimOpen']) {
    const f = fixture(t)
    f.state[property] = true
    assert.equal((await f.lifecycle.administer('prepare', f.input)).ok, false, property)
    assert.deepEqual(f.state.calls, [])
  }
  const waiting = defer()
  const f = fixture(t, { claim: { status: () => waiting.promise } })
  const first = f.lifecycle.administer('prepare', f.input)
  assert.equal((await f.lifecycle.administer('prepare', f.input)).ok, false)
  assert.equal((await f.lifecycle.begin({ name: 'racing' })).ok, false)
  await f.lifecycle.disconnect()
  waiting.resolve({ ok: true, connected: false, childQuiescent: true })
  assert.equal((await first).ok, false)
  assert.deepEqual(f.state.calls, [])
})
test('wrong operation, unknown child and forged receipt cannot finalize or refresh enrollment cache', async t => {
  for (const mode of ['wrong-operation', 'unquiescent', 'wrong-account', 'not-durable', 'not-collected', 'wrong-stage']) {
    const f = fixture(t)
    await f.lifecycle.administer('prepare', f.input)
    const receipt = f.receipt(true)
    if (mode === 'wrong-account') receipt.accountId = 'other'
    if (mode === 'not-durable') receipt.durable = false
    if (mode === 'not-collected') receipt.serverCollected = false
    f.claim.administer = async () => ({ ok: true, stage: mode === 'wrong-stage' ? 'stored' : 'finalized', receipt, childQuiescent: mode !== 'unquiescent' })
    const input = mode === 'wrong-operation' ? { context: { ...f.context, operationId: 'd'.repeat(48) } } : f.input
    assert.equal((await f.lifecycle.administer('finalize', input)).ok, false, mode)
    assert.equal(f.fence.allowsRemote(), false)
    assert.equal(f.state.cache, false)
    assert.equal(f.state.starts, 0)
  }
})
test('disconnect synchronously invalidates an importer result and its persisted administrative operation', async t => {
  const f = fixture(t)
  await f.lifecycle.administer('prepare', f.input)
  const waiting = defer()
  f.claim.administer = () => waiting.promise
  const pending = f.lifecycle.administer('finalize', f.input)
  await Promise.resolve()
  const disconnect = f.lifecycle.disconnect()
  assert.equal(f.fence.allowsRemote(), false)
  assert.equal(f.fence.snapshot().adminOperation, null)
  await disconnect
  waiting.resolve({ ok: true, stage: 'finalized', receipt: f.receipt(true), childQuiescent: true })
  assert.equal((await pending).ok, false)
  assert.equal(f.state.starts, 0)
  assert.equal((await f.lifecycle.administer('resume', f.input)).ok, false)
})
test('failed consent persistence preserves administrative binding for fresh explicit retry', async t => {
  const f = fixture(t, { dependencies: { clearConsent: () => false } })
  await f.lifecycle.administer('prepare', f.input)
  const answer = await f.lifecycle.administer('finalize', f.input)
  assert.equal(answer.code, 'DEVICE_CLAIM_CONSENT_CLEAR_FAILED')
  assert.deepEqual(f.fence.snapshot().adminOperation, contract.binding(f.context))
  assert.equal(f.fence.allowsRemote(), false)
  assert.equal(f.state.cache, false)
  assert.equal(f.state.starts, 0)
})
test('restart keeps exact operation fenced and resumes without reminting or granting cached authority', async t => {
  const f = fixture(t)
  await f.lifecycle.administer('prepare', f.input)
  await f.lifecycle.administer('import', f.input)
  const restartedFence = fenceModule.createRemoteConnectionFence({ directory: f.directory })
  assert.equal(restartedFence.allowsRemote(), false)
  assert.deepEqual(restartedFence.snapshot().adminOperation, contract.binding(f.context))
  let starts = 0
  const restarted = lifecycleModule.createRemoteConnectionLifecycle({ fence: restartedFence, claim: f.claim,
    relay: { status: () => ({ running: false }) }, revoke: () => true, clearConsent: () => true, onConnected: () => { starts++ } })
  assert.equal((await restarted.begin({ name: 'wrong lane' })).ok, false)
  assert.equal((await restarted.administer('prepare', f.input)).ok, false)
  assert.equal((await restarted.administer('resume', f.input)).ok, true)
  assert.equal(restartedFence.allowsRemote(), false)
  assert.equal(starts, 0)
  assert.equal((await restarted.administer('finalize', f.input)).ok, true)
  assert.equal(restartedFence.allowsRemote(), true)
  assert.equal(starts, 1)
})
test('an unfinished old owner prevents restart reconciliation and a new importer', async t => {
  const f = fixture(t)
  await f.lifecycle.administer('prepare', f.input)
  const owner = { version: 1, id: '00000000-0000-4000-8000-000000000001', publicKey: Buffer.from(f.context.publicKey, 'base64url').toString('base64') }
  f.fence.admitOwnership(owner)
  f.claim.reconcileOwnership = () => ({ quiescent: false })
  assert.equal((await f.lifecycle.administer('resume', f.input)).ok, false)
  assert.deepEqual(f.state.calls, ['prepare'])
  assert.equal(f.fence.allowsRemote(), false)
})
test('failed reservation persistence starts no administrative child and fails closed', async t => {
  const f = fixture(t, { fence: { fs: { ...fs, fsyncSync() { throw Error('fixture flush failure') } } } })
  assert.equal((await f.lifecycle.administer('prepare', f.input)).ok, false)
  assert.deepEqual(f.state.calls, [])
  assert.equal(f.fence.allowsRemote(), false)
  assert.equal(f.state.starts, 0)
})
test('administrative directory-flush failure refuses completion and restores the blocked operation across restart', async t => {
  let failDirectory = false
  const f = fixture(t, { fence: { platform: 'linux', fs: { ...fs, fsyncSync(fd) {
    if (failDirectory && fs.fstatSync(fd).isDirectory()) throw Error('fixture directory flush failure')
    return fs.fsyncSync(fd)
  } } } })
  await f.lifecycle.administer('prepare', f.input)
  failDirectory = true
  assert.equal((await f.lifecycle.administer('finalize', f.input)).ok, false)
  assert.equal(f.fence.allowsRemote(), false)
  assert.equal(f.state.starts, 0)
  const restarted = fenceModule.createRemoteConnectionFence({ directory: f.directory })
  assert.equal(restarted.allowsRemote(), false)
  assert.deepEqual(restarted.snapshot().adminOperation, contract.binding(f.context))
})
test('administrative reservation revokes old in-memory owners before admitting its child', async t => {
  const events = []
  const f = fixture(t, { dependencies: { revoke: () => { events.push('revoke'); return true } } })
  f.claim.administer = async () => {
    events.push('child')
    assert.equal(f.fence.allowsRemote(), false)
    return { ok: true, stage: 'prepared', childQuiescent: true }
  }
  assert.equal((await f.lifecycle.administer('prepare', f.input)).ok, true)
  assert.deepEqual(events, ['revoke', 'child'])
})
test('exact old configuration may retire only an absent-grant operation after ordinary disconnect', async t => {
  const f = fixture(t)
  await f.lifecycle.administer('prepare', f.input)
  await f.lifecycle.administer('import', f.input)
  await f.lifecycle.disconnect()
  assert.equal(f.fence.snapshot().adminOperation, null)
  assert.equal((await f.lifecycle.administer('cancel', f.input)).ok, true)
  assert.deepEqual(f.state.calls, ['prepare', 'import', 'cancel'])
  assert.equal(f.fence.allowsRemote(), false)
  assert.equal(f.fence.snapshot().adminOperation, null)
  f.state.connected = true
  assert.equal((await f.lifecycle.administer('cancel', f.input)).ok, false)
  assert.equal(f.state.calls.length, 3)
})
