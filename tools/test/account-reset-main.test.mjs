import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
function between(start, end) {
  const first = main.indexOf(start), last = main.indexOf(end, first + start.length)
  assert.ok(first >= 0 && last > first)
  return main.slice(first, last)
}
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function fixture(overrides = {}) {
  const calls = [], timers = []
  const account = { ok: true, sealed: true, localQuiesced: true,
    revoked: { ok: false, revoked: false, remoteEnded: false } }
  const scope = vm.createContext({
    accountResetStarted: false, hostedAccountRefreshTimer: null,
    accountMutations: new Set(), googleSignInAttempts: new Set(),
    getImageOwnerContext: () => ({ beginMutation: () => () => {} }),
    getHostedAccountController: () => ({ sealForErase: async () => account }),
    hostedAccountController: { refresh: async () => { calls.push('refresh') } },
    app: { whenReady: () => Promise.resolve() },
    setInterval: callback => { const timer = { callback, unref() {} }; timers.push(timer); return timer },
    clearInterval: timer => { timer.cancelled = true },
    setTimeout, clearTimeout, performance,
    withFleetProfileSender: (event, action) => event.trusted ? action() : { ok: false, code: 'UNTRUSTED' },
    mirrorUninstallRetention: () => { calls.push('mirror') },
    ...overrides,
  })
  vm.runInContext(between('function accountResetRefusal()', '\nfunction getAccountStore()'), scope)
  vm.runInContext(between('function stopAccountAdmissionForReset()', '\napp.whenReady()'), scope)
  vm.runInContext(between('async function withAccountMutation(', '\n/* WRITING A SETTING'), scope)
  return { scope, calls, timers, account }
}

function configFixture(resolveConfig) {
  const channels = new Map()
  const f = fixture({
    app: { getPath: () => 'fixture-user-data' },
    path: { join: () => 'fixture-app' }, __dirname: 'fixture-shell',
    process: { env: {} }, CAPABILITY_STATE_ROOT: 'fixture-state',
    resolveCapabilityRoot: () => 'fixture-capability',
    resolveGoogleSignInConfig: resolveConfig,
    hostedAccountClient: { googleAvailability: async () => ({ ok: true }) },
    getAccountStore: () => ({ hasGoogleProfiles: () => true }),
    ipcMain: { handle: (name, handler) => channels.set(name, handler) },
  })
  vm.runInContext(between('async function googleSignInConfig()', '\n// The primary Google button'), f.scope)
  return { ...f, channels }
}

test('availability retains its actual Google configuration vault operation until cleanup observes completion', async () => {
  const entered = deferred(), pending = deferred()
  const f = configFixture(() => { entered.resolve(); return pending.promise })
  const availability = f.channels.get('mc-account:google-availability')({ trusted: true })
  await entered.promise
  assert.equal(f.scope.accountMutations.size, 1)
  f.scope.stopAccountAdmissionForReset()
  let complete = false
  const cleanup = f.scope.closeAccountWritersForReset().then(result => { complete = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(complete, false, 'the resolver can still own a vault access-log writer')
  pending.resolve({ ok: true })
  assert.equal((await availability).code, 'ACCOUNT_RESET_STARTED')
  assert.equal(await cleanup, f.account)
  assert.equal(f.scope.accountMutations.size, 0)
})

test('a queued or new Google configuration read cannot start vault work after reset admission closes', async () => {
  let calls = 0
  const f = configFixture(async () => { calls++; return { ok: true } })
  const queued = f.scope.googleSignInConfig()
  f.scope.stopAccountAdmissionForReset()
  assert.equal((await queued).code, 'ACCOUNT_RESET_STARTED')
  assert.equal((await f.scope.googleSignInConfig()).code, 'ACCOUNT_RESET_STARTED')
  assert.equal(calls, 0)
  assert.equal(f.scope.accountMutations.size, 0)
})

test('reset cancels the actual refresh timer and refuses its retained callback or a late startup', async () => {
  const code = between('app.whenReady().then(() => {\n  if (accountResetStarted)', '\n\n/**')
  const f = fixture()
  vm.runInContext(code, f.scope)
  await Promise.resolve()
  assert.equal(f.timers.length, 1)
  const timer = f.timers[0]
  timer.callback()
  assert.equal(f.calls.filter(call => call === 'refresh').length, 1)
  f.scope.stopAccountAdmissionForReset()
  assert.equal(timer.cancelled, true)
  assert.equal(f.scope.hostedAccountRefreshTimer, null)
  timer.callback()
  assert.equal(f.calls.filter(call => call === 'refresh').length, 1)
  const late = fixture({ accountResetStarted: true })
  vm.runInContext(code, late.scope)
  await Promise.resolve()
  assert.equal(late.timers.length, 0)
})

test('main retains a complete admitted account action and refuses new actions after reset begins', async () => {
  const f = fixture(), pending = deferred()
  const action = f.scope.withAccountMutation({ trusted: true }, () => pending.promise)
  assert.equal(f.scope.accountMutations.size, 1)
  f.scope.stopAccountAdmissionForReset()
  const refused = await f.scope.withAccountMutation({ trusted: true }, () => assert.fail('new account action started'))
  assert.equal(refused.code, 'ACCOUNT_RESET_STARTED')
  assert.equal(f.scope.accountMutations.size, 1, 'the admitted action remains owned until it actually settles')
  const original = { ok: true, original: true }
  pending.resolve(original)
  assert.equal(await action, original)
  assert.equal(f.scope.accountMutations.size, 0)
  assert.equal((await f.scope.withAccountMutation({ trusted: false }, () => assert.fail('untrusted action started'))).code, 'UNTRUSTED')
})

test('cleanup starts dependent cancellation together and waits for the whole admitted action', async () => {
  const f = fixture(), browser = deferred(), action = deferred(), entered = deferred()
  const attempt = { quiesceForErase: () => { entered.resolve(); return browser.promise } }
  f.scope.googleSignInAttempts.add(attempt)
  f.scope.accountMutations.add(action.promise)
  let complete = false
  const closing = f.scope.closeAccountWritersForReset().then(result => { complete = true; return result })
  await entered.promise
  browser.resolve({ ok: true, sealed: true, closed: true })
  await Promise.resolve()
  assert.equal(complete, false)
  assert.equal(f.scope.googleSignInAttempts.has(attempt), true)
  action.resolve({ ok: false, code: 'ACCOUNT_OPERATION_CANCELLED' })
  assert.equal(await closing, f.account, 'settled remote revocation refusal is kept separate from local cleanup')
  assert.equal(f.scope.googleSignInAttempts.size, 0)
})

test('an unknown account-action completion times out without discarding retained cleanup handles', async () => {
  const f = fixture(), action = deferred()
  const attempt = { quiesceForErase: async () => ({ ok: true, sealed: true, closed: true }) }
  f.scope.googleSignInAttempts.add(attempt)
  f.scope.accountMutations.add(action.promise)
  await assert.rejects(f.scope.closeAccountWritersForReset({ timeoutMs: 20 }), /did not settle/)
  assert.equal(f.scope.accountMutations.has(action.promise), true)
  assert.equal(f.scope.googleSignInAttempts.has(attempt), true)
  action.resolve()
  await Promise.resolve()
  assert.equal(f.scope.googleSignInAttempts.has(attempt), true, 'late settlement is not retrospective cleanup proof')
})

test('a completion after the monotonic deadline cannot beat an overdue timer into success', async () => {
  let clock = 0
  const f = fixture()
  f.scope.getHostedAccountController = () => ({ sealForErase: async () => { clock = 31; return f.account } })
  const attempt = { quiesceForErase: async () => ({ ok: true, sealed: true, closed: true }) }
  f.scope.googleSignInAttempts.add(attempt)
  await assert.rejects(f.scope.closeAccountWritersForReset({ timeoutMs: 10, now: () => clock }), /before its deadline/)
  assert.equal(f.scope.googleSignInAttempts.has(attempt), true)
})

for (const missing of ['ok', 'sealed', 'localQuiesced']) test(`account cleanup requires explicit ${missing} acknowledgment`, async () => {
  const receipt = { ok: true, sealed: true, localQuiesced: true }
  delete receipt[missing]
  const f = fixture({ getHostedAccountController: () => ({ sealForErase: async () => receipt }) })
  await assert.rejects(f.scope.closeAccountWritersForReset(), /Account writer cleanup is unconfirmed/)
})

for (const missing of ['ok', 'sealed', 'closed']) test(`browser sign-in cleanup requires explicit ${missing} acknowledgment`, async () => {
  const receipt = { ok: true, sealed: true, closed: true }
  delete receipt[missing]
  const f = fixture()
  const attempt = { quiesceForErase: async () => receipt }
  f.scope.googleSignInAttempts.add(attempt)
  await assert.rejects(f.scope.closeAccountWritersForReset(), /Browser sign-in cleanup is unconfirmed/)
  assert.equal(f.scope.googleSignInAttempts.has(attempt), true)
})
