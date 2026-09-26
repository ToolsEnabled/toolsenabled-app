import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import fenceModule from '../../shell/remote-connection-fence.cjs'
import lifecycleModule from '../../shell/remote-connection-lifecycle.cjs'
const { createRemoteConnectionFence } = fenceModule
const { createRemoteConnectionLifecycle } = lifecycleModule
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-disconnect-lifecycle-'))
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false)
    fs.rmSync(directory, { recursive: true, force: true })
    assert.equal(fs.existsSync(directory), false)
  })
  const events = []
  if (overrides.savedRecord) fs.writeFileSync(path.join(directory, 'remote-connection-state.json'), JSON.stringify(overrides.savedRecord), { mode: 0o600 })
  const fence = createRemoteConnectionFence({ directory })
  const state = { connected: true, childQuiescent: true, running: true, writes: 0, begins: 0, starts: 0, statuses: 0 }
  const claim = {
    invalidateForDisconnect() { events.push('invalidate'); return Promise.resolve({ quiescent: true }) },
    async disconnect() { events.push('clear'); state.writes++; state.connected = false; return { ok: true, wasConnected: true, mutationOutcome: 'REMOVED_SYNCED', childQuiescent: true } },
    async status() { state.statuses++; return { ok: true, connected: state.connected, childQuiescent: state.childQuiescent } },
    async begin() { state.begins++; return { ok: true, code: 'TC-FIXT-TEST' } },
    async poll() { state.connected = true; return { ok: true, state: 'connected' } },
    cancel() { return { ok: true } },
    ...overrides.claim,
  }
  const relay = {
    stop() { events.push('stop'); state.running = false; return Promise.resolve({ ok: true, stopped: true }) },
    status() { return { running: state.running } },
    ...overrides.relay,
  }
  const lifecycle = createRemoteConnectionLifecycle({ fence, claim, relay,
    revoke() { events.push('revoke'); return true },
    clearConsent() { events.push('off'); return true },
    onConnected() { state.starts++; state.running = true },
    ...overrides.dependencies,
  })
  return { fence, lifecycle, state, events, directory }
}

test('disconnect closes the gate and revokes grants before waiting for either child', async t => {
  const waiting = deferred()
  const { lifecycle, fence, state, events } = setup(t, { claim: { invalidateForDisconnect() { return waiting.promise } } })
  const result = lifecycle.disconnect()
  assert.equal(fence.allowsRemote(), false)
  assert.deepEqual(events, ['revoke', 'stop', 'off'])
  assert.equal(state.writes, 0)
  assert.strictEqual(lifecycle.disconnect(), result)
  assert.equal((await lifecycle.begin({ name: 'new' })).ok, false)
  waiting.resolve({ quiescent: true })
  const answer = await result
  assert.equal(answer.ok, true)
  assert.equal(answer.remoteStopped, true)
  assert.equal(answer.childQuiescent, true)
  assert.equal(answer.restartSafety, 'recorded')
  assert.equal(state.writes, 1)
  assert.equal(fence.allowsRemote(), false)
})

test('a refused vault clear still revokes remote authority and never asserts unchanged', async t => {
  const { lifecycle, fence } = setup(t, { claim: { async disconnect() {
    return { ok: false, code: 'DEVICE_CLAIM_DISCONNECT_UNCERTAIN', mutationOutcome: 'UNCERTAIN', localCause: 'SECRET_VAULT_WRITE_UNCERTAIN', childQuiescent: true }
  } } })
  const answer = await lifecycle.disconnect()
  assert.equal(answer.ok, false)
  assert.equal(answer.remoteStopped, true)
  assert.equal(answer.disconnectPending, true)
  assert.equal(answer.mutationOutcome, 'UNCERTAIN')
  assert.equal(fence.allowsRemote(), false)
  assert.equal((await lifecycle.begin({ name: 'new' })).ok, false)
})

test('unconfirmed old helper keeps new claims fenced even after the first reply resolves', async t => {
  const { lifecycle, state } = setup(t, { claim: { invalidateForDisconnect: async () => ({ quiescent: false }) } })
  state.childQuiescent = false
  const result = await lifecycle.disconnect()
  assert.equal(result.ok, false)
  assert.equal(state.writes, 0)
  assert.equal((await lifecycle.begin({ name: 'new' })).ok, false)
  state.connected = false
  assert.equal((await lifecycle.status()).disconnectPending, true)
  assert.equal((await lifecycle.begin({ name: 'new' })).ok, false)
  state.childQuiescent = true
  const observed = await lifecycle.status()
  assert.equal(observed.credentialObservedAbsent, true)
  assert.equal(observed.childQuiescent, true)
  assert.equal((await lifecycle.begin({ name: 'new' })).ok, true)
})

test('a prior GUI owner must be reconciled before any status or credential mutation can start', async t => {
  const { publicKey } = generateKeyPairSync('ed25519')
  const owner = { version: 1, id: randomUUID(), publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
  let terminal = false
  let reconciliations = 0
  const { lifecycle, fence, state, directory } = setup(t, {
    savedRecord: { version: 2, state: 'active', pendingOwner: owner, disconnectPending: false, mutationOutcome: 'UNCERTAIN' },
    claim: { async reconcileOwnership(expected) {
      reconciliations++
      assert.deepEqual(expected, owner)
      return terminal ? { quiescent: true, receipt: { version: 1, kind: 'claim-lifetime-terminal',
        id: owner.id, quiescent: true, started: true, exitedNormally: false, exitCode: null } } : { quiescent: false }
    } },
  })
  assert.equal(fence.allowsRemote(), false)
  state.connected = false
  const unknown = await lifecycle.status()
  assert.equal(unknown.childQuiescent, false)
  assert.equal(unknown.credentialObservedAbsent, false)
  assert.equal(unknown.disconnectPending, true)
  assert.equal(state.statuses, 0, 'a new helper reporting itself clean proves nothing about the old owner')
  assert.equal((await lifecycle.begin({ name: 'new' })).ok, false)
  assert.equal((await lifecycle.disconnect()).ok, false)
  assert.equal(state.writes, 0)
  assert.equal(state.statuses, 0)
  terminal = true
  const observed = await lifecycle.status()
  assert.equal(state.statuses, 1)
  assert.ok(reconciliations >= 3)
  assert.equal(observed.childQuiescent, true)
  assert.equal(observed.credentialObservedAbsent, true)
  assert.equal(observed.disconnectPending, false)
  assert.equal(observed.mutationOutcome, 'UNCERTAIN')
  assert.equal(fence.allowsRemote(), false)
  const restarted = createRemoteConnectionFence({ directory })
  assert.equal(restarted.snapshot().pendingOwner, null)
  assert.equal(restarted.snapshot().mutationOutcome, 'UNCERTAIN')
  assert.equal(restarted.allowsRemote(), false)
})

test('a second status caller joins the current owner without confusing it with a previous GUI', async t => {
  const { publicKey } = generateKeyPairSync('ed25519')
  const current = { version: 1, id: randomUUID(), publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
  const waiting = deferred()
  let calls = 0
  const { lifecycle, fence } = setup(t, { claim: {
    ownsPendingOwnership: expected => expected.id === current.id && expected.publicKey === current.publicKey,
    reconcileOwnership: () => assert.fail('a current status flight is joined through its retained owner'),
    status: () => { calls++; return waiting.promise },
  } })
  assert.equal(fence.admitOwnership(current), true)
  const first = lifecycle.status()
  const second = lifecycle.status()
  assert.equal(calls, 2, 'the claim module owns sharing the one retained status invocation')
  assert.equal(fence.allowsRemote(), true)
  fence.completeOwnership(current, { version: 1, kind: 'claim-lifetime-terminal', id: current.id, quiescent: true })
  waiting.resolve({ ok: true, connected: true, childQuiescent: true })
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.ok, true)
    assert.equal(result.remoteAccessBlocked, false)
    assert.equal(result.disconnectPending, false)
  }
})

test('primary preparation refreshes both the persisted owner and lifecycle state before the first child', async t => {
  const { publicKey } = generateKeyPairSync('ed25519')
  const original = { version: 1, id: randomUUID(), publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
  const { lifecycle, fence, directory, state } = setup(t, { claim: { reconcileOwnership: async () => ({ quiescent: false }) } })
  const oldPrimary = createRemoteConnectionFence({ directory })
  assert.equal(oldPrimary.admitOwnership(original), true)
  assert.equal(fence.snapshot().pendingOwner, null)
  assert.equal(lifecycle.prepareForPrimary(), true)
  assert.equal(fence.allowsRemote(), false)
  assert.equal((await lifecycle.status()).disconnectPending, true)
  assert.equal(state.statuses, 0)
  assert.equal(lifecycle.prepareForPrimary(), false)
})

test('an unconfirmed relay cannot be replaced by a new claim after the disconnect reply', async t => {
  const { lifecycle, state } = setup(t, { relay: { stop: async () => ({ ok: false, stopped: false }) } })
  assert.equal((await lifecycle.disconnect()).remoteStopped, false)
  assert.equal(state.writes, 0)
  state.connected = false
  await lifecycle.status()
  assert.equal((await lifecycle.begin({ name: 'new' })).ok, false)
  state.running = false
  await lifecycle.status()
  assert.equal((await lifecycle.begin({ name: 'new' })).ok, true)
})

test('a later absent observation does not rewrite the uncertain mutation receipt or reconnect automatically', async t => {
  const { lifecycle, state, fence } = setup(t, { claim: { async disconnect() {
    state.connected = false
    return { ok: false, mutationOutcome: 'UNCERTAIN', childQuiescent: true }
  } } })
  await lifecycle.disconnect()
  const observed = await lifecycle.status()
  assert.equal(observed.credentialObservedAbsent, true)
  assert.equal(observed.mutationOutcome, 'UNCERTAIN')
  assert.equal(fence.allowsRemote(), false)
  assert.equal(state.starts, 0)
  assert.equal(state.begins, 0)
  await lifecycle.begin({ name: 'new' })
  assert.equal(fence.allowsRemote(), false)
  assert.equal((await lifecycle.poll()).ok, true)
  assert.equal(fence.allowsRemote(), true)
  assert.equal(state.starts, 1)
})

test('late successful claim completion cannot restart the relay after disconnect intent', async t => {
  const waiting = deferred()
  const { lifecycle, state, fence } = setup(t, { claim: { poll: () => waiting.promise } })
  await lifecycle.begin({ name: 'new' })
  const old = lifecycle.poll()
  await lifecycle.disconnect()
  waiting.resolve({ ok: true, state: 'connected' })
  assert.equal((await old).ok, false)
  assert.equal(state.starts, 0)
  assert.equal(fence.allowsRemote(), false)
})

test('failed consent persistence and incomplete child evidence are separate failed outcomes', async t => {
  const first = setup(t, { dependencies: { clearConsent: () => false } })
  const answer = await first.lifecycle.disconnect()
  assert.equal(answer.ok, false)
  assert.equal(answer.credentialCleared, true)
  assert.equal(answer.remoteStopped, true)
  assert.equal(answer.webDriveConsentCleared, false)
  assert.equal(answer.disconnectPending, true)
  const second = setup(t, { claim: { disconnect: async () => ({ ok: true, childQuiescent: false }) } })
  assert.equal((await second.lifecycle.disconnect()).ok, false)
  assert.equal((await second.lifecycle.begin({ name: 'new' })).ok, false)
})
