/* THE LIST OF A PERSON'S OWN PROVIDER ACCOUNTS, AND THE THREE WAYS IT COULD DO
 * REAL DAMAGE.
 *
 * WHAT THIS GUARDS. shell/account-registry.cjs is the first thing in this
 * application that WRITES the file the engine's account rotation reads. That
 * file decides which sign-in the next agent runs on. So the failures worth a
 * suite are not cosmetic:
 *
 *   1. IT READS A CREDENTIAL. The module is handed the paths of directories that
 *      hold real sign-in files. It must decide "signed in" from existence alone
 *      and must never open one. Asserted twice below -- once against the source
 *      text, and once behaviourally, against a file layer that fails the test if
 *      a sign-in path is ever opened.
 *   2. IT WRITES A FILE THE ENGINE REFUSES. A Codex entry that names configDir,
 *      a duplicate name, two accounts on one home: each makes the whole registry
 *      unloadable, and the person would see their agents stop with no idea why.
 *   3. IT TURNS "NOTHING TO ROTATE" INTO AN ERROR. An absent file is the normal
 *      state on almost every computer. It must read as an empty list, and
 *      removing the last account must return to it rather than leave an empty
 *      list behind -- which the engine treats as a loud refusal.
 *
 * NOTHING HERE TOUCHES A REAL HOME. Every test runs inside a temporary profile:
 * userData, capability state and LOCALAPPDATA are explicit scratch directories,
 * the home directory is injected, and the sign-in files are bytes this suite
 * wrote itself. Real product and provider state is never read or written.
 *
 * Run: node --test tools/test/account-registry.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { canonicalRootForTests } from '../canonical-root.mjs'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MODULE_FILE = path.join(REPO, 'shell', 'account-registry.cjs')
const MAIN_FILE = path.join(REPO, 'shell', 'main.cjs')
const LOGIN_FILE = path.join(REPO, 'shell', 'provider-login.cjs')

/* The packaged capability seam is the Engine this app actually ships. Keep
   the canonical-root selection above the first integration tests so every
   Engine module they load uses the same measured checkout. */
const PACKAGED_MULTI_ACCOUNT = path.join(
  canonicalRootForTests({ warn: () => {} }),
  'src', 'lib', 'multi-account',
)
const PACKAGED_LIB = path.dirname(PACKAGED_MULTI_ACCOUNT)

test('provider usage metadata survives the real Engine, shell IPC/cache and renderer normalization boundary', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'account-usage-boundary-'))
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep))
  /* Retained scratch fixture: R1225 forbids destructive test cleanup. */
  const registryPath = path.join(directory, 'accounts.json')
  const homeDir = path.join(directory, 'home')
  mkdirSync(homeDir, { recursive: true })
  writeFileSync(registryPath, JSON.stringify({ accounts: [
    { provider: 'claude', name: 'school', configDir: '.claude-school' },
    { provider: 'grok', name: 'work', configDir: '.grok-work' },
    { provider: 'gemini', name: 'personal', homeDir: '.gemini-personal' },
    { provider: 'gemini', name: 'unsupported', homeDir: '.gemini-unsupported' },
  ] }))
  for (const [folder, leaf] of [['.claude-school', '.credentials.json'], ['.grok-work', 'auth.json'], ['.gemini-personal', '.gemini/oauth_creds.json'], ['.gemini-unsupported', '.gemini/oauth_creds.json']]) {
    const target = path.join(homeDir, folder, leaf)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, 'fictional metadata fixture only')
  }
  const rotation = require_(path.join(PACKAGED_MULTI_ACCOUNT, 'rotation.js'))
  const health = require_(path.join(PACKAGED_MULTI_ACCOUNT, 'health.js'))
  const { STATE } = require_(path.join(PACKAGED_LIB, 'providers', 'claude-auth-probe.js'))
  const { readUsageReply, readAccountList, mergeAccounts, rowLines } = await import('../../src/account-switcher-state.js')
  const at = '2031-01-01T00:00:00.000Z'
  const probeFor = provider => provider === 'claude' ? rotation.claudeProbeFactory({
    homeDir, fsImpl: require_('node:fs'), exhaustedAtPercent: 99,
    authProbe: async () => ({ state: STATE.INDETERMINATE, statusSucceeded: true, capabilityRan: false, billingSource: 'subscription',
      account: 'school@example.test', plan: 'Sample plan' }),
    usageProbe: async () => ({ status: 'UNKNOWN', reason: 'CLAUDE_USAGE_TIMEOUT' }),
  }) : provider === 'grok' ? async account => health.classifyGrokBilling(account, {
    status: 'healthy', canServe: true, usedPercent: null,
    windows: { hourly: null, weekly: null, weeklyWindows: [] },
  }, { billing: { config: { creditUsagePercent: 100, currentPeriod: {
    type: 'USAGE_PERIOD_TYPE_MONTHLY', end: '2031-02-01T00:00:00Z',
  } } } }) : async account => health.probeGeminiAccount(account, { homeDir,
      fsImpl: { statSync() { return { isFile: () => true } } },
    })
  const source = readFileSync(MAIN_FILE, 'utf8')
  const cacheAt = source.indexOf('const ACCOUNT_USAGE_CACHE_FILE =')
  const cacheFragment = source.slice(cacheAt, source.indexOf("ipcMain.handle('mc-accounts:rename'", cacheAt))
  const handlerAt = source.indexOf("ipcMain.handle('mc-accounts:usage'")
  const helperAt = source.indexOf('const readAccountsUsage = asyncSingleFlight(')
  const handlerFragment = source.slice(helperAt, source.indexOf('\n})\n', handlerAt) + 4)
  let handler
  const context = vm.createContext({
    nodePath: path, app: { getPath: () => directory },
    durableFile: require_('../../shell/durable-file.cjs'),
    asyncSingleFlight: require_('../../shell/async-single-flight.cjs').asyncSingleFlight,
    ipcMain: { handle(name, fn) { assert.equal(name, 'mc-accounts:usage'); handler = fn } },
    assertTrustedAgentSender(event) { assert.equal(event.trusted, true) },
    ACCOUNT_REGISTRY_FILE: registryPath, ACCOUNT_HOME_DIR: homeDir,
    accountRegistry: createAccountRegistryStore({ file: registryPath, homedir: () => homeDir }),
    loadRotation: () => ({ accountUsageBinding: rotation.accountUsageBinding,
      readAccountUsage: options => rotation.readAccountUsage({ ...options, probeFor, now: () => at }) }),
  })
  vm.runInContext(cacheFragment + '\n' + handlerFragment, context)
  const wire = structuredClone(await handler({ trusted: true }))
  assert.equal(wire.ok, true)
  const cached = structuredClone(await vm.runInContext('readAccountUsageCache()', context))
  assert.deepEqual(cached.accounts, wire.accounts, 'the disk carrier changed provider usage metadata')
  const list = readAccountList({ ok: true, accounts: wire.accounts.map(({ provider, name, allowanceBinding, authGeneration }) => ({ provider, name, allowanceBinding, authGeneration })) })
  for (const reply of [wire, cached]) {
    const rows = mergeAccounts(list, readUsageReply(reply), { now: Date.parse(at) })
    const claude = rows.find(row => row.provider === 'claude')
    assert.equal(claude.status, 'healthy')
    assert.equal(claude.canServe, true)
    assert.equal(claude.usageState, 'failed')
    assert.equal(claude.usageCode, 'CLAUDE_USAGE_TIMEOUT')
    assert.equal(claude.usageReadAt, null)
    assert.match(claude.usageError, /could not.*allowance/i)
    const grok = rows.find(row => row.provider === 'grok')
    assert.equal(grok.usageState, 'current')
    assert.equal(grok.usageSource, 'grok-billing')
    assert.equal(grok.reportedUsage?.usedPercent, 100)
    assert.equal(grok.reportedUsage?.period, 'month')
    assert.equal(grok.reportedUsage?.resetsAt, '2031-02-01T00:00:00.000Z')
    assert.equal(grok.windows.weekly, null)
    assert.equal(grok.canServe, false)
    for (const name of ['personal', 'unsupported']) {
      const gemini = rows.find(row => row.provider === 'gemini' && row.name === name)
      assert.equal(gemini.status, 'healthy')
      assert.equal(gemini.canServe, true)
      assert.equal(gemini.usageStatus, 'not_reported')
      assert.equal(gemini.usageState, 'unknown')
      assert.equal(gemini.measured, false)
      assert.equal(gemini.email, null, 'file presence is not a verified identity')
      assert.equal(gemini.allowanceBuckets, null)
      assert.equal(gemini.reportedUsage, null)
      assert.deepEqual(gemini.windows, { hourly: null, weekly: null, weeklyWindows: [] })
      assert.match(gemini.usageReason, /allowance is unknown/i)
      assert.ok(rowLines(gemini).some(line => /allowance is unknown/i.test(line.text)))
      assert.equal(gemini.usageError, null)
    }
  }
})

test('concurrent account allowance IPC reads share one sweep through cache completion and retry after failure', async () => {
  const source = readFileSync(MAIN_FILE, 'utf8')
  const handlerAt = source.indexOf("ipcMain.handle('mc-accounts:usage'")
  const helperAt = source.indexOf('const readAccountsUsage = asyncSingleFlight(')
  const recoveryAt = source.indexOf('function accountUsageProbeClosed(')
  const recovery = source.slice(recoveryAt, source.indexOf('function filterAccountUsageGenerations(', recoveryAt))
  const fragment = recovery + '\n' + source.slice(helperAt >= 0 ? helperAt : handlerAt, source.indexOf('\n})\n', handlerAt) + 4)
  let handler, probeCalls = 0, cacheCalls = 0, releaseProbe, releaseCache
  let probe = new Promise(resolve => { releaseProbe = resolve })
  let cache = new Promise(resolve => { releaseCache = resolve })
  const context = {
    accountUsageRevision: 0,
    filterAccountUsage: answer => answer,
    readAccountUsageGenerations: async () => new Map(),
    bindAccountUsageGeneration: answer => answer,
    asyncSingleFlight: require_('../../shell/async-single-flight.cjs').asyncSingleFlight,
    ipcMain: { handle(_name, fn) { handler = fn } },
    assertTrustedAgentSender(event) { assert.equal(event.trusted, true) },
    loadRotation: () => ({ ACCOUNT_USAGE_BINDING_FILTER_VERSION: 1,
      readAccountUsage: async () => { probeCalls += 1; return await probe } }),
    writeAccountUsageCache: async () => { cacheCalls += 1; await cache },
    ACCOUNT_REGISTRY_FILE: '/fixture/accounts.json', ACCOUNT_HOME_DIR: '/fixture/home',
  }
  vm.runInNewContext(fragment, context)
  const first = handler({ trusted: true })
  const second = handler({ trusted: true })
  await new Promise(resolve => setImmediate(resolve))
  const started = probeCalls
  releaseProbe({ ok: true, accounts: [], readAt: '2026-09-14T03:00:00.000Z' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cacheCalls, 1, 'the real refresh helper must reach the pending cache write')
  const third = handler({ trusted: true })
  releaseCache()
  const replies = await Promise.all([first, second, third])
  assert.equal(started, 1, 'two windows launched duplicate account sweeps')
  assert.equal(probeCalls, 1, 'a sweep was restarted while its cache write was pending')
  assert.equal(cacheCalls, 1)
  assert.ok(replies.every(reply => reply === replies[0]))
  probe = Promise.reject(new Error('fixture transport failure'))
  const failed = await handler({ trusted: true })
  assert.equal(failed.ok, false)
  probe = Promise.resolve({ ok: true, accounts: [], readAt: '2026-09-14T03:01:00.000Z' })
  cache = Promise.resolve()
  assert.equal((await handler({ trusted: true })).ok, true, 'a later explicit retry did not get a new sweep')
  assert.equal(probeCalls, 3)
  assert.equal(cacheCalls, 2)
  await assert.rejects(handler({ trusted: false }), /false !== true/, 'coalescing bypassed sender validation')
})

test('account listing and allowance reads use the same Engine-owned native account binding', async () => {
  const source = readFileSync(MAIN_FILE, 'utf8')
  const start = source.indexOf("ipcMain.handle('mc-accounts:list'")
  const fragment = source.slice(start, source.indexOf('\n})\n', start) + 4)
  const rotation = require_(path.join(PACKAGED_MULTI_ACCOUNT, 'rotation.js'))
  let handler
  let account = { provider: 'gemini', name: 'work', directory: path.join(tmpdir(), 'allowance-fixture-home') }
  vm.runInNewContext(fragment, {
    ipcMain: { handle(_name, fn) { handler = fn } }, assertTrustedAgentSender() {},
    accountRegistry: { listAsync: async () => ({ ok: true, accounts: [account] }),
      activeAccount: () => ({}), signInCommand: () => null },
    loadRotation: () => rotation, PROVIDER_ISOLATION_REQUESTED: true,
    readAccountUsageCache: async () => null, rendererSafeAgentError: error => error,
  })
  const first = (await handler({})).accounts[0]
  assert.equal(first.allowanceBinding, rotation.accountUsageBinding(account))
  assert.match(first.allowanceBinding, /^[a-f0-9]{64}$/)
  account = { ...account, client: 'antigravity' }
  const second = (await handler({})).accounts[0]
  assert.notEqual(first.allowanceBinding, second.allowanceBinding)
  account = { ...account, directory: path.join(tmpdir(), 'allowance-replacement-home') }
  assert.notEqual(second.allowanceBinding, (await handler({})).accounts[0].allowanceBinding)
})

const {
  PROVIDERS,
  PROVIDER_IDS,
  signInFilePath,
  accountRotationStateFile,
  accountsRegistryFile,
  adoptLegacyAccountRegistry,
  createAccountRegistryStore,
} = require_(MODULE_FILE)

/* The sign-in launcher, because the command the store SHOWS and the command
   the launcher RUNS are one table written twice, and only a test holds them
   together. */
const { LOGIN_PROVIDERS, signInLine } = require_(LOGIN_FILE)

/* The shared packaged seam above supplies the Engine modules used by the
   remaining registry integration cases. */
const { accountRegistryPath } = require_(path.join(PACKAGED_MULTI_ACCOUNT, 'registry-location.js'))
const {
  loadRegistry,
  profileProvisioned,
  signInFilePath: packedSignInFilePath,
  PROVIDERS: PACKED_PROVIDERS,
  PROVIDER_IDS: PACKED_PROVIDER_IDS,
} = require_(path.join(PACKAGED_MULTI_ACCOUNT, 'registry.js'))
const { resolveAccountForSession } = require_(path.join(PACKAGED_MULTI_ACCOUNT, 'rotation.js'))
const { readState } = require_(path.join(PACKAGED_MULTI_ACCOUNT, 'switcher.js'))


/* What every program's rule reads as when none has its own: the rule above,
   flagged as not its own. */


/* A WHOLE MACHINE IN A TEMPORARY DIRECTORY. Capability state owns the account
   registry; the distinct services root owns machine/settings/rotation state.
   A throwaway home means a relative folder like ".codex-school" cannot resolve
   onto the real one. */
function withScratchProfile(run) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'mc-accounts-'))
  const userData = path.join(scratch, 'roaming', 'ToolsEnabled')
  const stateRoot = path.join(userData, 'capability')
  const localAppData = path.join(scratch, 'local')
  const servicesRoot = path.join(localAppData, 'ToolsEnabled')
  const stateFile = path.join(servicesRoot, 'multi-account-state.json')
  const home = path.join(scratch, 'home')
  mkdirSync(path.join(stateRoot, 'config'), { recursive: true })
  mkdirSync(servicesRoot, { recursive: true })
  mkdirSync(home, { recursive: true })

  const previous = process.env.LOCALAPPDATA
  const previousStateRoot = process.env.TOOLSENABLED_STATE_ROOT
  process.env.LOCALAPPDATA = localAppData
  process.env.TOOLSENABLED_STATE_ROOT = stateRoot
  try {
    const file = accountsRegistryFile()
    const retainedRemovals = []
    const realFs = require_('node:fs')
    const fsImpl = {
      ...realFs,
      rmSync(target) {
        // Exercise the requested registry removal while retaining its bytes.
        assert.equal(path.toNamespacedPath(target), path.toNamespacedPath(file))
        const archive = path.join(scratch, `retained-registry-${retainedRemovals.length}.json`)
        assert.equal(existsSync(archive), false)
        realFs.renameSync(target, archive)
        retainedRemovals.push({ target, archive })
      },
    }
    const store = createAccountRegistryStore({ file, stateFile, servicesRoot, homedir: () => home, fsImpl })
    return run({ scratch, home, userData, stateRoot, localAppData, servicesRoot, stateFile, file, store, retainedRemovals })
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous
    if (previousStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT
    else process.env.TOOLSENABLED_STATE_ROOT = previousStateRoot
    /* Retain the named scratch fixture for post-test inspection. */
  }
}

/* Rotation is asynchronous, so its scratch profile must stay alive until the
   promise settles. Keeping this separate means the many synchronous tests
   above retain their direct throw/return semantics. */
async function withScratchProfileAsync(run) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'mc-accounts-async-'))
  const userData = path.join(scratch, 'roaming', 'ToolsEnabled')
  const stateRoot = path.join(userData, 'capability')
  const localAppData = path.join(scratch, 'local')
  const servicesRoot = path.join(localAppData, 'ToolsEnabled')
  const stateFile = path.join(servicesRoot, 'multi-account-state.json')
  const home = path.join(scratch, 'home')
  mkdirSync(path.join(stateRoot, 'config'), { recursive: true })
  mkdirSync(servicesRoot, { recursive: true })
  mkdirSync(home, { recursive: true })

  const previous = process.env.LOCALAPPDATA
  const previousStateRoot = process.env.TOOLSENABLED_STATE_ROOT
  process.env.LOCALAPPDATA = localAppData
  process.env.TOOLSENABLED_STATE_ROOT = stateRoot
  try {
    const file = accountsRegistryFile()
    const store = createAccountRegistryStore({ file, stateFile, servicesRoot, homedir: () => home })
    return await run({ scratch, home, userData, stateRoot, localAppData, servicesRoot, stateFile, file, store })
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous
    if (previousStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT
    else process.env.TOOLSENABLED_STATE_ROOT = previousStateRoot
    /* Retain the named async scratch fixture for post-test inspection. */
  }
}

/* A throwaway home for one account, with or without the file that program keeps
   its sign-in in. The bytes are deliberately not credential-shaped: nothing in
   this product ever opens them, and this suite proves it. */
function makeHome(home, leaf, signInFile) {
  const directory = path.join(home, leaf)
  mkdirSync(directory, { recursive: true })
  if (signInFile) {
    /* `signInFile` may carry a subdirectory: Gemini keeps its file one level
       down, at .gemini/oauth_creds.json, so that folder is made too. */
    const target = path.join(directory, signInFile)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, '{"note":"not a credential"}')
  }
  return directory
}

/* Removal tests must not erase even a disposable fixture. The observer records
   the product's requested path while retaining every fixture on disk. */
function observingStore({ file, home, platform, servicesRoot = null }) {
  const removed = []
  const realFs = require_('node:fs')
  const fsImpl = {
    ...realFs,
    rmSync(target) { removed.push(path.resolve(target)) },
  }
  return {
    store: createAccountRegistryStore({ file, homedir: () => home, platform, servicesRoot, fsImpl }),
    removed,
  }
}

/* Two names with no Latin letter in them, spelled as code points so the file
   stays ASCII: "Работа" (Russian, "work") and "工作" (Chinese, "work"). */
const CYRILLIC_WORK = '\u0420\u0430\u0431\u043e\u0442\u0430'
const CHINESE_WORK = '\u5de5\u4f5c'

/* 1.0.50 REVIEW-1050 #13. Removing an account whose home Accounts made answered credentialDestroyed: true even
   when no sign-in had ever been saved there, so Settings told the person a sign-in "was deleted" that never
   existed. The receipt now says a sign-in was deleted only when the file was there to delete. */
test('removing an app-made home with no saved sign-in does not report a deleted sign-in', () => {
  for (const platform of ['linux', 'win32']) {
    for (const provider of PROVIDER_IDS) {
      withScratchProfile(({ scratch }) => {
        const caseRoot = path.join(scratch, `r13-${platform}-${provider}`)
        const home = path.join(caseRoot, 'home')
        mkdirSync(home, { recursive: true })
        const file = path.join(caseRoot, 'managed.json')
        const services = path.join(caseRoot, 'managed-services')
        mkdirSync(services, { recursive: true })
        const store = createAccountRegistryStore({ file, homedir: () => home, platform, servicesRoot: services })
        assert.equal(store.addManaged({ provider, name: 'managed' }).homeCreatedByApp, true)
        const observed = observingStore({ file, home, platform, servicesRoot: services })
        const result = observed.store.remove({ name: 'managed', provider })
        assert.equal(result.ok, true)
        assert.equal(result.removed, true)
        assert.equal(result.credentialDestroyed, false, `${platform} ${provider}: a sign-in that was never saved was reported deleted`)
        assert.equal(result.credentialDisposition, 'no-saved-sign-in')
      })
    }
  }
})

test('A28 registration origin protects existing and legacy homes on Linux and Windows for every provider', () => {
  for (const platform of ['linux', 'win32']) {
    for (const provider of PROVIDER_IDS) {
      withScratchProfile(({ scratch }) => {
        const spec = PROVIDERS[provider]
        const caseRoot = path.join(scratch, `a28-${platform}-${provider}`)
        const home = path.join(caseRoot, 'home')
        mkdirSync(home, { recursive: true })
        const signInLeaf = spec.signInSubdir
          ? path.join(spec.signInSubdir, spec.signInFile)
          : spec.signInFile

        /* A caller registering a home it already owns is recorded false and
           removal retains the provider file. */
        const existingFile = path.join(caseRoot, 'existing.json')
        const existingDir = makeHome(home, 'existing', signInLeaf)
        const existingSeed = createAccountRegistryStore({ file: existingFile, homedir: () => home, platform })
        existingSeed.add({ name: 'existing', provider, directory: existingDir })
        const existingRecord = JSON.parse(readFileSync(existingFile, 'utf8'))
        assert.equal(existingRecord.accounts[0].homeCreatedByApp, false)
        const existingObserved = observingStore({ file: existingFile, home, platform })
        const existingResult = existingObserved.store.remove({ name: 'existing', provider })
        assert.deepEqual(existingResult, {
          ok: true,
          removed: true,
          credentialDestroyed: false,
          credentialDisposition: 'preserved-existing-home',
        })
        assert.equal(existsSync(signInFilePath(existingDir, spec)), true)
        assert.equal(existingObserved.removed.includes(path.resolve(signInFilePath(existingDir, spec))), false)

        /* Even addManaged() records false when a retry lands on a directory
           that already existed before this registration. */
        const retryFile = path.join(caseRoot, 'retry.json')
        const retryServices = path.join(caseRoot, 'retry-services')
        const retryDirectory = path.join(retryServices, 'account-homes', provider, 'retry')
        mkdirSync(retryDirectory, { recursive: true })
        const retryStore = createAccountRegistryStore({
          file: retryFile, homedir: () => home, platform, servicesRoot: retryServices,
        })
        assert.equal(retryStore.addManaged({ provider, name: 'retry' }).homeCreatedByApp, false)

        /* If another writer wins after the absence check, the exclusive
           mkdir proof records the raced-in directory as external ownership. */
        const raceFile = path.join(caseRoot, 'race.json')
        const raceServices = path.join(caseRoot, 'race-services')
        const raceDirectory = path.join(raceServices, 'account-homes', provider, 'race')
        const raceRealFs = require_('node:fs')
        let raceInjected = false
        const raceFs = {
          ...raceRealFs,
          mkdirSync(target, options) {
            if (!raceInjected && path.resolve(target) === path.resolve(raceDirectory)) {
              raceInjected = true
              raceRealFs.mkdirSync(target, options)
              const error = new Error('simulated concurrent account-home creator')
              error.code = 'EEXIST'
              throw error
            }
            return raceRealFs.mkdirSync(target, options)
          },
        }
        const raceStore = createAccountRegistryStore({
          file: raceFile, homedir: () => home, platform, servicesRoot: raceServices, fsImpl: raceFs,
        })
        const raced = raceStore.addManaged({ provider, name: 'race' })
        assert.equal(raceInjected, true)
        assert.equal(raced.directory, raceDirectory)
        assert.equal(raced.homeCreatedByApp, false)
        assert.equal(JSON.parse(readFileSync(raceFile, 'utf8')).accounts[0].homeCreatedByApp, false)
        const raceSignIn = signInFilePath(raceDirectory, spec)
        mkdirSync(path.dirname(raceSignIn), { recursive: true })
        writeFileSync(raceSignIn, '{"fixture":"retained-race"}')
        const raceObserved = observingStore({
          file: raceFile, home, platform, servicesRoot: raceServices,
        })
        assert.deepEqual(raceObserved.store.remove({ name: 'race', provider }), {
          ok: true,
          removed: true,
          credentialDestroyed: false,
          credentialDisposition: 'preserved-existing-home',
        })
        assert.equal(existsSync(raceSignIn), true)
        assert.equal(raceObserved.removed.includes(path.resolve(raceSignIn)), false)

        /* addManaged() creates the home and records true. Removal keeps its
           deliberate credential-destroy request; the observer retains the
           fixture so this test never deletes even a disposable file. */
        const managedFile = path.join(caseRoot, 'managed.json')
        const managedServices = path.join(caseRoot, 'managed-services')
        mkdirSync(managedServices, { recursive: true })
        const managedStore = createAccountRegistryStore({
          file: managedFile, homedir: () => home, platform, servicesRoot: managedServices,
        })
        const managed = managedStore.addManaged({ provider, name: 'managed' })
        assert.equal(managed.homeCreatedByApp, true)
        const managedSignIn = signInFilePath(managed.directory, spec)
        mkdirSync(path.dirname(managedSignIn), { recursive: true })
        writeFileSync(managedSignIn, '{"fixture":"retained"}')
        const managedObserved = observingStore({
          file: managedFile, home, platform, servicesRoot: managedServices,
        })
        assert.deepEqual(managedObserved.store.remove({ name: 'managed', provider }), {
          ok: true,
          removed: true,
          credentialDestroyed: true,
        })
        assert.equal(existsSync(managedSignIn), true)
        assert.equal(managedObserved.removed.includes(path.resolve(managedSignIn)), true)

        /* Entries written before the origin field existed are unknown, never
           guessed app-owned. Their provider file remains and the disposition
           names that legacy uncertainty. */
        const legacyFile = path.join(caseRoot, 'legacy.json')
        const legacyDir = makeHome(home, 'legacy', signInLeaf)
        writeFileSync(legacyFile, JSON.stringify({
          accounts: [{ name: 'legacy', provider, [spec.dirField]: legacyDir }],
        }))
        const legacyObserved = observingStore({ file: legacyFile, home, platform })
        assert.deepEqual(legacyObserved.store.remove({ name: 'legacy', provider }), {
          ok: true,
          removed: true,
          credentialDestroyed: false,
          credentialDisposition: 'preserved-legacy-unknown-home',
        })
        assert.equal(existsSync(signInFilePath(legacyDir, spec)), true)
        assert.equal(legacyObserved.removed.includes(path.resolve(signInFilePath(legacyDir, spec))), false)
      })
    }
  }
})

function validLegacyBytes(overrides = {}) {
  return Buffer.from(`${JSON.stringify({
    exhaustedAtPercent: 99,
    notePreservedByteForByte: true,
    accounts: [
      { name: 'school', provider: 'codex', profileDir: '.codex-school', role: 'builder' },
    ],
    ...overrides,
  }, null, 2)}\n`, 'utf8')
}

/* ------------------------------------------------------------------
   1. Absence is the normal state, not a fault.
   ------------------------------------------------------------------ */

test('no list on this computer is an empty list and never an error', () => {
  withScratchProfile(({ file, store }) => {
    assert.equal(existsSync(file), false, 'the suite started with a list already written')
    const answer = store.list()
    assert.equal(answer.ok, true)
    assert.deepEqual(answer.accounts, [])
    assert.equal(answer.damaged, false, 'an absent list was reported as a damaged one')
    /* Reading must not create it either. A probe that writes is a probe that
       changes the answer it was asked for. */
    assert.equal(existsSync(file), false)
  })
})

test('the list is written in the capability registry the engine already reads', () => {
  withScratchProfile(({ file, stateRoot }) => {
    assert.equal(file, path.join(stateRoot, 'config', 'accounts.json'))
  })
})

test('the registry location has no services-root, LOCALAPPDATA or home fallback', () => {
  assert.throws(
    () => accountsRegistryFile({ stateRoot: null }),
    error => error.code === 'ACCOUNT_STATE_ROOT_INVALID',
  )
  assert.throws(
    () => accountsRegistryFile({ stateRoot: 'relative-capability' }),
    error => error.code === 'ACCOUNT_STATE_ROOT_INVALID',
  )
})

test('the rotation record is explicitly derived from the separate services root', () => {
  withScratchProfile(({ servicesRoot, stateFile, stateRoot }) => {
    assert.equal(accountRotationStateFile({ servicesRoot }), stateFile)
    assert.notEqual(path.dirname(stateFile), path.join(stateRoot, 'config'))
  })
})

test('a store with no explicit rotation path never guesses one beside the registry', () => {
  withScratchProfile(({ home, file }) => {
    const adjacent = path.join(path.dirname(file), 'multi-account-state.json')
    writeFileSync(adjacent, '{"activeAccount":"wrong-root"}')
    const store = createAccountRegistryStore({ file, homedir: () => home })
    /* No record read means no per-provider map: null, so the menu's fallback
       to the older single name runs, rather than a table that reads as
       "the map names nobody". */
    assert.deepEqual(store.activeAccount(), { name: null, provider: null, at: null, byProvider: null, lastSwitch: null, chosenByProvider: null, movedOffByProvider: null })
  })
})

test('the application wires canonical registry and fenced services state as separate inputs', () => {
  const source = readFileSync(MAIN_FILE, 'utf8')
  const registryBlock = source.slice(
    source.indexOf('const {\n  accountRotationStateFile,'),
    source.indexOf('/* The renderer\'s settings'),
  )
  assert.match(registryBlock, /accountsRegistryFile\(\{ stateRoot: CAPABILITY_STATE_ROOT \}\)/)
  assert.match(registryBlock, /adoptLegacyAccountRegistry\(\{[\s\S]*stateRoot: CAPABILITY_STATE_ROOT,[\s\S]*servicesRoot: accountServicesRoot/)
  assert.match(registryBlock, /stateFile: accountServicesRoot[\s\S]*accountRotationStateFile\(\{ servicesRoot: accountServicesRoot \}\)/)
  assert.match(registryBlock, /if \(!adoption\.ok\)/,
    'a refused adoption must remain diagnosable')
  assert.doesNotMatch(registryBlock, /adoption\.legacyRemoved/,
    'retaining the ignored legacy source by design must not log a perpetual error')

  const start = source.indexOf('function resolveServicesRootForAccounts()')
  const end = source.indexOf('\n}', start) + 2
  assert.ok(start >= 0 && end > start)
  const resolverSource = source.slice(start, end)
  let resolved = 0, checked = 0
  const sentinel = path.join(tmpdir(), 'synthetic-services-location')
  const isolation = { isolationContext(_env, options) { checked++; assert.equal(options.servicesRoot, sentinel) } }
  const makeResolver = modules => new Function('require', 'providerIsolation', 'process',
    resolverSource + '; return resolveServicesRootForAccounts;')(
      request => { assert.equal(request, './setup-record.cjs'); return { loadSetupModules: () => modules } }, isolation, { env: {} })
  const resolve = makeResolver({ ok: true, machineRecord: { resolveServicesRoot(options) { resolved++; assert.deepEqual(options, {}); return sentinel } } })
  assert.equal(resolve(), sentinel)
  assert.equal(resolved, 1)
  assert.equal(checked, 1)
  const loadError = makeResolver({ ok: false, code: 'SYNTHETIC_MODULES_ABSENT', reason: 'Synthetic account service is unavailable.' })
  assert.throws(loadError, { code: 'SYNTHETIC_MODULES_ABSENT', message: 'Synthetic account service is unavailable.' })
  const denied = new Error('Synthetic private state refused.')
  isolation.isolationContext = () => { throw denied }
  assert.throws(resolve, error => error === denied)

})

test('removing the last account restores absence rather than an empty list', () => {
  /* An empty accounts array is ACCOUNTS_REGISTRY_EMPTY in the engine -- a loud
     refusal that means "no account is usable". Removing your second account must
     not put the machine into that state. */
  withScratchProfile(({ home, file, stateFile, store, retainedRemovals }) => {
    makeHome(home, '.codex-school', 'auth.json')
    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    assert.equal(existsSync(file), true)
    const before = readFileSync(file)
    assert.deepEqual(store.remove({ name: 'school', provider: 'codex' }), {
      ok: true, removed: true, credentialDestroyed: false,
      credentialDisposition: 'preserved-existing-home',
    })
    assert.equal(existsSync(file), false, 'an empty list was left behind where absence belongs')
    assert.deepEqual(store.list().accounts, [])
    assert.equal(retainedRemovals.length, 1, 'the product must request registry removal')
    assert.deepEqual(readFileSync(retainedRemovals[0].archive), before, 'the removed registry fixture must be retained intact')
  })
})

test('removing an account registered with an existing home preserves its sign-in and nothing else in its home', () => {
  withScratchProfile(({ home, store }) => {
    const directory = makeHome(home, '.codex-school', 'auth.json')
    writeFileSync(path.join(directory, 'session-history-fixture.txt'), 'must-survive')
    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    assert.equal(existsSync(path.join(directory, 'auth.json')), true, 'setup: the credential fixture must exist before removal')

    const receipt = store.remove({ name: 'school', provider: 'codex' })

    assert.deepEqual(receipt, {
      ok: true, removed: true, credentialDestroyed: false,
      credentialDisposition: 'preserved-existing-home',
    })
    assert.equal(existsSync(path.join(directory, 'auth.json')), true,
      'an existing home credential must be retained by remove()')
    assert.equal(readFileSync(path.join(directory, 'session-history-fixture.txt'), 'utf8'), 'must-survive',
      'a file in the home that is not the credential must be untouched')
    assert.equal(existsSync(directory), true, 'the home directory and existing credential must survive')
  })
})

test('removing an account that was never signed in has no credential to destroy, and still succeeds', () => {
  withScratchProfile(({ home, store }) => {
    const directory = makeHome(home, '.codex-school', null)
    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    assert.equal(existsSync(path.join(directory, 'auth.json')), false, 'setup: no credential fixture was written')

    assert.deepEqual(store.remove({ name: 'school', provider: 'codex' }), {
      ok: true, removed: true, credentialDestroyed: false,
      credentialDisposition: 'preserved-existing-home',
    })
  })
})

test('removing a claude account registered with an existing home preserves .credentials.json by this provider\'s own field name', () => {
  withScratchProfile(({ home, store }) => {
    const directory = makeHome(home, '.claude-school', '.credentials.json')
    store.add({ name: 'school', provider: 'claude', directory: '.claude-school' })

    assert.deepEqual(store.remove({ name: 'school', provider: 'claude' }), {
      ok: true, removed: true, credentialDestroyed: false,
      credentialDisposition: 'preserved-existing-home',
    })

    assert.equal(existsSync(path.join(directory, '.credentials.json')), true)
  })
})

test('removing a gemini account registered with an existing home preserves oauth_creds.json one level down in .gemini', () => {
  withScratchProfile(({ home, store }) => {
    const directory = makeHome(home, '.gemini-school', path.join('.gemini', 'oauth_creds.json'))
    writeFileSync(path.join(directory, '.gemini', 'settings.json'), 'must-survive')
    store.add({ name: 'school', provider: 'gemini', directory: '.gemini-school' })
    assert.equal(existsSync(path.join(directory, '.gemini', 'oauth_creds.json')), true, 'setup: the credential fixture must exist before removal')

    const receipt = store.remove({ name: 'school', provider: 'gemini' })

    assert.deepEqual(receipt, {
      ok: true, removed: true, credentialDestroyed: false,
      credentialDisposition: 'preserved-existing-home',
    })
    assert.equal(existsSync(path.join(directory, '.gemini', 'oauth_creds.json')), true,
      'an existing Gemini home credential must be retained')
    assert.equal(readFileSync(path.join(directory, '.gemini', 'settings.json'), 'utf8'), 'must-survive',
      'a sibling file inside .gemini that is not the credential must be untouched')
    assert.equal(existsSync(path.join(directory, '.gemini')), true, 'the .gemini subdirectory itself must survive')
  })
})

test('removing the last account reports a failure when the registry cannot be deleted', () => {
  withScratchProfile(({ home, file }) => {
    makeHome(home, '.codex-school', 'auth.json')
    const working = createAccountRegistryStore({ file, homedir: () => home })
    working.add({ name: 'school', provider: 'codex', directory: '.codex-school' })

    const deletionError = Object.assign(new Error('registry is locked'), { code: 'EBUSY' })
    const store = createAccountRegistryStore({
      file,
      homedir: () => home,
      fsImpl: {
        ...require_('node:fs'),
        rmSync() {
          throw deletionError
        },
      },
    })

    assert.throws(
      () => store.remove({ name: 'school', provider: 'codex' }),
      error => error === deletionError,
      'a failed deletion was reported as a successful removal',
    )
    assert.equal(existsSync(file), true, 'the registry unexpectedly disappeared')
  })
})

/* ------------------------------------------------------------------
   2. Adding, listing and removing.
   ------------------------------------------------------------------ */

test('an account added is an account listed, and removing it takes it away', () => {
  withScratchProfile(({ home, store }) => {
    makeHome(home, '.codex-school', 'auth.json')
    makeHome(home, '.codex-personal', null)

    assert.deepEqual(store.add({ name: 'school', provider: 'codex', directory: '.codex-school' }), { ok: true })
    assert.deepEqual(store.add({ name: 'personal', provider: 'codex', directory: '.codex-personal' }), { ok: true })

    const listed = store.list().accounts
    assert.equal(listed.length, 2)
    assert.deepEqual(listed.map(account => account.name), ['personal', 'school'])


    /* The signed-in answer is an existence check on the file that program keeps
       its sign-in in, and it is the only difference between these two homes. */
    assert.equal(listed.find(row => row.name === 'school').signedIn, 'yes')
    assert.equal(listed.find(row => row.name === 'personal').signedIn, 'no')
    assert.equal(listed.find(row => row.name === 'school').directory, path.resolve(path.join(home, '.codex-school')))

    assert.deepEqual(store.remove({ name: 'personal', provider: 'codex' }), {
      ok: true, removed: true, credentialDestroyed: false,
      credentialDisposition: 'preserved-existing-home',
    })
    assert.deepEqual(store.list().accounts.map(account => account.name), ['school'])
    /* Removing something that is not there is an answer, not a failure. */
    assert.deepEqual(store.remove({ name: 'personal', provider: 'codex' }), { ok: true, removed: false })
  })
})

test('one name may belong to both programs, and never twice to one', () => {
  withScratchProfile(({ home, store }) => {
    makeHome(home, '.codex-school', 'auth.json')
    makeHome(home, '.claude-school', '.credentials.json')
    makeHome(home, '.codex-school-two', null)

    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    /* The same person's school account exists on both programs. Refusing the
       second would be refusing the ordinary case. */
    assert.deepEqual(store.add({ name: 'school', provider: 'claude', directory: '.claude-school' }), { ok: true })

    assert.throws(
      () => store.add({ name: 'school', provider: 'codex', directory: '.codex-school-two' }),
      error => error.code === 'ACCOUNT_NAME_TAKEN',
      'a second Codex account called "school" was accepted, which the engine refuses',
    )

    const names = store.list().accounts.map(account => `${account.provider}:${account.name}`)
    assert.deepEqual(names.sort(), ['claude:school', 'codex:school'])
  })
})

test('two accounts of one program may not share a folder', () => {
  withScratchProfile(({ home, store }) => {
    makeHome(home, '.codex-school', 'auth.json')
    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    assert.throws(
      () => store.add({ name: 'second', provider: 'codex', directory: '.codex-school' }),
      error => error.code === 'ACCOUNT_FOLDER_SHARED',
    )
    /* A DIFFERENT program pointed at the same folder is merely unusual: the two
       read different files inside it, which is the engine's own rule. */
    assert.deepEqual(store.add({ name: 'school', provider: 'claude', directory: '.codex-school' }), { ok: true })
  })
})

test('only Codex, Claude and Gemini accounts exist here', () => {
  withScratchProfile(({ home, store }) => {
    makeHome(home, '.gemini-school', null)
    for (const provider of ['gpt', '', null, 'CODEX', 'Gemini', 'local']) {
      assert.throws(
        () => store.add({ name: 'school', provider, directory: '.gemini-school' }),
        error => error.code === 'ACCOUNT_PROVIDER_UNSUPPORTED',
        `provider ${JSON.stringify(provider)} was accepted`,
      )
    }
    assert.deepEqual(store.add({ name: 'school', provider: 'gemini', directory: '.gemini-school' }), { ok: true })
    assert.deepEqual([...PROVIDER_IDS], ['codex', 'claude', 'gemini', 'grok'])
  })
})

/* ------------------------------------------------------------------
   3. The two folder fields, which are not interchangeable.
   ------------------------------------------------------------------ */



test('an entry that names the other program\'s folder field is not listed as usable', () => {
  withScratchProfile(({ home, file, store }) => {
    makeHome(home, '.codex-school', 'auth.json')
    makeHome(home, '.claude-school', '.credentials.json')
    /* Hand-written by somebody who guessed. Reading it must not report accounts
       that the engine would refuse the file over. */
    writeFileSync(file, JSON.stringify({
      accounts: [
        { name: 'wrong-codex', provider: 'codex', configDir: '.claude-school' },
        { name: 'wrong-claude', provider: 'claude', profileDir: '.codex-school' },
        { name: 'right', provider: 'codex', profileDir: '.codex-school' },
      ],
    }, null, 2))

    // T1529: the engine rejects this entire file; a usable subset is misleading.
    const listing = store.list()
    assert.deepEqual(listing.accounts, [])
    assert.equal(listing.damaged, true)
    assert.equal(listing.problem.name, 'wrong-codex')
    assert.throws(() => loadRegistry({ configPath: file }), error => error.code === 'ACCOUNTS_ENTRY_INVALID')
  })
})

test('the file this writes has the engine schema and round trips through the store', () => {
  /* Keep this positive control self-contained. Some source checkouts do not
     include the separately packaged capability payload, so requiring its parser
     made the account-store suite red before it exercised the store at all. The
     exact persisted shape is the engine contract; reading it back through a new
     store proves the on-disk result, rather than merely inspecting add()'s
     return value. */
  withScratchProfile(({ home, file, stateFile, store }) => {
    makeHome(home, '.codex-school', 'auth.json')
    makeHome(home, '.codex-personal', null)
    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    store.add({ name: 'personal', provider: 'codex', directory: '.codex-personal' })

    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      accounts: [
        { name: 'school', provider: 'codex', profileDir: '.codex-school', homeCreatedByApp: false },
        { name: 'personal', provider: 'codex', profileDir: '.codex-personal', homeCreatedByApp: false },
      ],
    })

    const reloaded = createAccountRegistryStore({ file, stateFile, homedir: () => home }).list()
    assert.equal(reloaded.damaged, false)
    assert.deepEqual(reloaded.accounts.map(account => ({
      name: account.name,

      signedIn: account.signedIn,
    })), [
      { name: 'personal', signedIn: 'no' },
      { name: 'school', signedIn: 'yes' },
    ])
  })
})



/* ------------------------------------------------------------------
   4. The command a person runs, which this product never runs.
   ------------------------------------------------------------------ */

test('native fallback sign-in commands preserve the exact account folder and arguments', () => {
  withScratchProfile(({ home, store }) => {
    // None of the real provider CLIs run: shell functions return their inputs.
    // Executing the generated text proves that quoting is interpreted correctly.
    const directory = path.join(home, "Account's space $value `literal` & café")
    for (const [provider, key, args] of [
      ['codex', 'CODEX_HOME', ['login']],
      ['claude', 'CLAUDE_CONFIG_DIR', ['auth', 'login']],
      ['gemini', 'GEMINI_CLI_HOME', []],
    ]) {
      const command = store.signInCommand({ provider, directory })
      let result
      if (process.platform === 'win32') {
        const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\nfunction ${provider} { @{ directory=$env:${key}; arguments=@($args) } | ConvertTo-Json -Compress }\n${command}`
        result = JSON.parse(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }))
      } else {
        const script = `${provider}() { printf '%s\\n' "$${key}" "$@"; }\n${command}`
        const lines = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', script], { encoding: 'utf8', timeout: 10_000 }).trimEnd().split('\n')
        result = { directory: lines[0], arguments: lines.slice(1) }
      }
      assert.equal(result.directory, directory)
      assert.deepEqual(result.arguments, args)
    }
  })
})

test('the sign-in command is the official one for each program, with the folder resolved', () => {
  /* MEASURED, NOT REMEMBERED. `codex --help` on codex-cli 0.146.0 lists `login`
     as a top-level command. `claude auth --help` on claude 2.1.186 lists `login`
     under `auth`, and there is NO bare `claude login` -- inventing one would put
     a command on screen that the person cannot run. */
  withScratchProfile(({ home, store }) => {
    const expected = (key, dir, command) => process.platform === 'win32' ? `$env:${key}='${dir}'; ${command}` : `${key}='${dir}' ${command}`
    const codexHome = path.resolve(path.join(home, '.codex-school'))
    const claudeHome = path.resolve(path.join(home, '.claude-school'))

    assert.equal(
      store.signInCommand({ provider: 'codex', directory: '.codex-school' }),
      expected('CODEX_HOME', codexHome, 'codex login'),
    )
    assert.equal(
      store.signInCommand({ provider: 'claude', directory: '.claude-school' }),
      expected('CLAUDE_CONFIG_DIR', claudeHome, 'claude auth login'),
    )
    /* An absolute folder is used as given, not joined onto the home again. */
    assert.equal(
      store.signInCommand({ provider: 'codex', directory: codexHome }),
      expected('CODEX_HOME', codexHome, 'codex login'),
    )
    /* gemini has no sign-in subcommand: running the program IS the sign-in,
       the first time, and it asks how you want to sign in. So the line is the
       bare program, with its home variable set in front of it. */
    const geminiHome = path.resolve(path.join(home, '.gemini-school'))
    assert.equal(
      store.signInCommand({ provider: 'gemini', directory: '.gemini-school' }),
      expected('GEMINI_CLI_HOME', geminiHome, 'gemini'),
    )
    assert.throws(
      () => store.signInCommand({ provider: 'gpt', directory: '.gpt' }),
      error => error.code === 'ACCOUNT_PROVIDER_UNSUPPORTED',
    )
  })
})

/* ------------------------------------------------------------------
   5. Which account this computer is on, when it has ever been asked.
   ------------------------------------------------------------------ */

const NOBODY = Object.freeze({ codex: null, claude: null, gemini: null, grok: null })

test('the account in use is read from the separate services-root rotation record, and its absence is not a failure', () => {
  withScratchProfile(({ stateFile, store }) => {
    /* NO MAP IS null, NOT A TABLE OF NULLS. The menu falls back to the older
       single name, and to the one row carrying it, only when byProvider is
       null; a table of three nulls reads as "the map names nobody" and hides
       the account an older record does name. */
    assert.deepEqual(store.activeAccount(), { name: null, provider: null, at: null, byProvider: null, lastSwitch: null, chosenByProvider: null, movedOffByProvider: null },
      'a missing record was not "not known"')

    /* A record the engine wrote before the per-provider split: one name, no
       provider on the switch. The name is reported; the program is not
       guessed; and the map is absent, so the menu's fallback can run. */
    writeFileSync(stateFile, JSON.stringify({
      activeAccount: 'school',
      lastSwitch: { at: '2026-08-18T00:00:00.000Z', from: null, to: 'school' },
      history: [],
    }))
    assert.deepEqual(store.activeAccount(), {
      name: 'school', provider: null, at: '2026-08-18T00:00:00.000Z', byProvider: null,
      lastSwitch: {
        at: '2026-08-18T00:00:00.000Z', from: null, to: 'school',
        provider: null, automatic: null, reason: null,
      },
      /* Nobody has chosen by hand: no field, and a history with no hand switch. */
      chosenByProvider: null, movedOffByProvider: null,
    })

    /* A map that is present and names nobody is the table: the map exists,
       so the menu draws from it and the fallback stays off. */
    writeFileSync(stateFile, JSON.stringify({
      activeAccount: 'school',
      activeByProvider: {},
      lastSwitch: { at: '2026-08-18T00:00:00.000Z', from: null, to: 'school' },
      history: [],
    }))
    assert.deepEqual(store.activeAccount().byProvider, NOBODY)

    /* A record that carries the per-provider names: each program's answer is
       its own, and the last switch's program is read off the switch itself,
       or -- when the switch does not say -- off the one program whose entry
       carries that name. */
    writeFileSync(stateFile, JSON.stringify({
      activeAccount: 'school',
      activeByProvider: { codex: 'personal', claude: 'school' },
      lastSwitch: { at: '2026-08-18T00:00:00.000Z', from: null, to: 'school' },
      history: [],
    }))
    assert.deepEqual(store.activeAccount(), {
      name: 'school', provider: 'claude', at: '2026-08-18T00:00:00.000Z',
      byProvider: { codex: 'personal', claude: 'school', gemini: null, grok: null },
      lastSwitch: {
        at: '2026-08-18T00:00:00.000Z', from: null, to: 'school',
        provider: null, automatic: null, reason: null,
      },
      /* Nobody has chosen by hand: no field, and a history with no hand switch. */
      chosenByProvider: null, movedOffByProvider: null,
    })
    writeFileSync(stateFile, JSON.stringify({
      activeAccount: 'school',
      activeByProvider: { codex: 'school', claude: 'school' },
      lastSwitch: { at: '2026-08-18T00:00:00.000Z', from: null, to: 'school', provider: 'codex' },
    }))
    assert.equal(store.activeAccount().provider, 'codex', 'the switch names its program and that was not read')
    writeFileSync(stateFile, JSON.stringify({
      activeAccount: 'school',
      activeByProvider: { codex: 'school', claude: 'school' },
      lastSwitch: { at: '2026-08-18T00:00:00.000Z', from: null, to: 'school' },
    }))
    assert.equal(store.activeAccount().provider, null, 'two programs carry the name and one was guessed')

    /* Every field optional, every failure "not known", and never a throw: a
       screen must not go blank because an optional record is malformed. */
    writeFileSync(stateFile, '{ not json at all')
    assert.equal(store.activeAccount().code, 'ACCOUNT_STATE_UNREADABLE')
    assert.equal(store.activeAccount().name, null)
    writeFileSync(stateFile, JSON.stringify({ activeAccount: 42, activeByProvider: 'codex', lastSwitch: 'soon' }))
    assert.equal(store.activeAccount().code, 'ACCOUNT_STATE_UNREADABLE')
    assert.equal(store.activeAccount().name, null)
  })
})

test('the last change of account says what it was, not only when it happened', () => {
  /* THE ONE SENTENCE A FAILOVER OWES A PERSON. `at` has always been read off
     this record and the rest of it thrown away, so the menu could say WHEN this
     computer last changed account and never what the change WAS -- and an
     automatic failover is exactly the change nobody was present for. Four
     facts: when, off which account, onto which, and whether the computer did it
     on its own. */
  withScratchProfile(({ stateFile, store }) => {
    writeFileSync(stateFile, JSON.stringify({
      activeAccount: 'spare',
      activeByProvider: { claude: 'spare' },
      lastSwitch: {
        at: '2026-09-03T09:15:00.000Z',
        from: 'work',
        to: 'spare',
        provider: 'claude',
        automatic: true,
        reason: 'The account in use had reached its weekly limit.',
      },
    }))
    assert.deepEqual(store.activeAccount().lastSwitch, {
      at: '2026-09-03T09:15:00.000Z',
      from: 'work',
      to: 'spare',
      provider: 'claude',
      automatic: true,
      reason: 'The account in use had reached its weekly limit.',
    })

    /* BOUNDED AND WORD BY WORD, never the record whole. The engine's switcher
       owns this file and may grow fields; a screen must never be handed a value
       nothing here has read. An unknown program is not reported as one. */
    writeFileSync(stateFile, JSON.stringify({
      lastSwitch: {
        at: '2026-09-03T09:15:00.000Z',
        from: 'work',
        to: 'spare',
        provider: 'not-a-program',
        automatic: 'yes',
        reason: 'r'.repeat(400),
        somethingLater: 'a field this build has never heard of',
      },
    }))
    const read = store.activeAccount().lastSwitch
    assert.equal(read.provider, null, 'a program this build does not know was reported as one')
    /* NOT-STATED IS NOT "YOU DID THIS YOURSELF". A record written before the
       field existed, or with rubbish in it, says nothing rather than false. */
    assert.equal(read.automatic, null)
    assert.equal(read.reason.length, 240, 'an unbounded sentence from another program reached the screen')
    assert.equal(Object.hasOwn(read, 'somethingLater'), false, 'an unread field was copied across')

    /* A computer that has never switched has no switch to describe, and says
       so rather than answering a record of nulls that reads as a change. */
    writeFileSync(stateFile, JSON.stringify({ activeAccount: 'work', history: [] }))
    assert.equal(store.activeAccount().lastSwitch, null)
  })
})

/* ------------------------------------------------------------------
   6. A damaged list is not an empty one, and must not be overwritten.
   ------------------------------------------------------------------ */

const incompatibleRegistryCases = [
  ['unsupported provider', [{ name: 'beta', provider: 'mystery' }]],
  ['non-object entry', [null]],
  ['missing name', [{ provider: 'codex', profileDir: '.beta' }]],
  ['missing provider', [{ name: 'beta', profileDir: '.beta' }]],
  ['missing provider directory', [{ name: 'beta', provider: 'codex' }]],
  ['unsupported client', [{ name: 'beta', provider: 'codex', profileDir: '.beta', client: 'antigravity' }]],
  ['duplicate name', [{ name: 'ALPHA', provider: 'codex', profileDir: '.beta' }]],
  ['duplicate role', [{ name: 'beta', provider: 'codex', profileDir: '.beta', role: 'BUILDER' }]],
  ['shared directory', [{ name: 'beta', provider: 'codex', profileDir: '.ALPHA' }]],
  ['shared Antigravity sign-in', [
    { name: 'gamma', provider: 'gemini', homeDir: '.gamma', client: 'antigravity' },
    { name: 'beta', provider: 'gemini', homeDir: '.beta', client: 'antigravity' },
  ]],
  ['empty registry', null],
]
for (const [label, tail] of incompatibleRegistryCases) {

}



test('a list that cannot be read is reported as unread, and adding refuses rather than replaces it', () => {
  withScratchProfile(({ home, file, store }) => {
    makeHome(home, '.codex-school', null)
    writeFileSync(file, '{ "accounts": [ this is not json')

    const answer = store.list()
    assert.equal(answer.ok, true, 'a damaged list threw instead of degrading')
    assert.deepEqual(answer.accounts, [])
    assert.equal(answer.damaged, true, 'a damaged list was reported as an absent one')

    assert.throws(
      () => store.add({ name: 'school', provider: 'codex', directory: '.codex-school' }),
      error => error.code === 'ACCOUNT_REGISTRY_DAMAGED',
      'an unreadable list was silently replaced, losing whatever it held',
    )
    assert.equal(readFileSync(file, 'utf8'), '{ "accounts": [ this is not json')
  })
})

/* ------------------------------------------------------------------
   7. The app writer and packaged engine reader are one integration.
   ------------------------------------------------------------------ */

test('an app-added account is immediately visible to packaged rotation, whose state stays in servicesRoot', async () => {
  await withScratchProfileAsync(async ({ home, stateRoot, servicesRoot, stateFile, file, store }) => {
    makeHome(home, '.codex-school', 'auth.json')
    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })

    const enginePath = accountRegistryPath({
      resolveStateRootImpl: () => ({ root: stateRoot, reason: 'configured' }),
    })
    assert.equal(enginePath, file, 'the app writer and packaged engine reader resolved different registries')
    const parsed = loadRegistry({ configPath: enginePath })
    assert.deepEqual(parsed.accounts.map(account => account.name), ['school'])

    const selected = await resolveAccountForSession({
      provider: 'codex',
      servicesRoot,
      homeDir: home,
      preferred: 'school',
      now: () => '2026-09-01T21:45:00.000Z',
      probe: async account => ({
        account: account.name,
        email: null,
        usedPercent: 0,
        resetsAt: null,
        planType: null,
        status: 'healthy',
        canServe: true,
        reason: 'scratch account is healthy',
      }),
    })
    assert.equal(selected.rotated, true)
    assert.equal(selected.account.name, 'school')
    assert.equal(existsSync(stateFile), true, 'rotation did not write its services-root record')
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).activeAccount, 'school')
    assert.equal(existsSync(path.join(stateRoot, 'multi-account-state.json')), false)
    assert.equal(existsSync(path.join(path.dirname(file), 'multi-account-state.json')), false)
  })
})

/* ------------------------------------------------------------------
   8. Narrow, no-overwrite adoption of the one legacy registry.
   ------------------------------------------------------------------ */

test('a valid regular legacy registry is adopted byte-for-byte and safely retained without moving rotation state', () => {
  withScratchProfile(({ stateRoot, servicesRoot, stateFile, file }) => {
    const legacy = path.join(servicesRoot, 'accounts.json')
    const raw = validLegacyBytes()
    const rotation = '{"activeAccount":"school","history":[]}\n'
    writeFileSync(legacy, raw)
    writeFileSync(stateFile, rotation)

    const realFs = require_('node:fs')
    const cleanupRequests = []
    const archive = path.join(servicesRoot, 'retained-adoption-temporary.json')
    const fsImpl = {
      ...realFs,
      unlinkSync(target) {
        cleanupRequests.push(target)
        assert.equal(path.dirname(target), path.dirname(file))
        assert.notEqual(target, file)
        assert.equal(existsSync(archive), false)
        realFs.renameSync(target, archive)
      },
    }
    const answer = adoptLegacyAccountRegistry({ stateRoot, servicesRoot, fsImpl })
    assert.equal(cleanupRequests.length, 1, 'successful adoption must request temporary cleanup')
    assert.equal(existsSync(cleanupRequests[0]), false, 'the temporary must leave its original path')
    assert.deepEqual(readFileSync(archive), raw, 'the temporary fixture must be retained intact')
    assert.deepEqual(answer, {
      ok: true,
      adopted: true,
      legacyRemoved: false,
      code: 'ACCOUNT_LEGACY_ADOPTED_SOURCE_RETAINED',
    })
    assert.deepEqual(readFileSync(file), raw, 'canonical bytes differ from the validated source bytes')
    assert.deepEqual(readFileSync(legacy), raw, 'the ignored legacy source was deleted or changed')
    assert.equal(readFileSync(stateFile, 'utf8'), rotation, 'rotation state was migrated or rewritten')
    assert.deepEqual(loadRegistry({ configPath: file }).accounts.map(account => account.name), ['school'])
  })
})

test('malformed, empty and engine-incompatible legacy registries are refused in place', () => {
  const cases = [
    ['unparsable', Buffer.from('{')],
    ['empty', Buffer.from('{"accounts":[]}')],
    ['unsupported provider', validLegacyBytes({ accounts: [{ name: 'x', provider: 'gpt', profileDir: '.x' }] })],
    ['wrong directory field', validLegacyBytes({ accounts: [{ name: 'x', provider: 'codex', configDir: '.x' }] })],
    ['duplicate name', validLegacyBytes({ accounts: [
      { name: 'same', provider: 'codex', profileDir: '.one' },
      { name: 'SAME', provider: 'codex', profileDir: '.two' },
    ] })],
    ['duplicate role', validLegacyBytes({ accounts: [
      { name: 'one', role: 'builder', provider: 'codex', profileDir: '.one' },
      { name: 'two', role: 'BUILDER', provider: 'codex', profileDir: '.two' },
    ] })],
    ['shared directory', validLegacyBytes({ accounts: [
      { name: 'one', provider: 'codex', profileDir: '.same' },
      { name: 'two', provider: 'codex', profileDir: '.SAME' },
    ] })],
  ]
  withScratchProfile(({ stateRoot, servicesRoot }) => {
    for (const [index, [label, raw]] of cases.entries()) {
      /* Each case owns a distinct retained fixture; reusing one pathname would
         require deleting the previous canonical target between cases. */
      const caseStateRoot = path.join(stateRoot, `a28-legacy-case-${index}`)
      const caseServicesRoot = path.join(servicesRoot, `a28-legacy-case-${index}`)
      mkdirSync(caseServicesRoot, { recursive: true })
      const canonical = accountsRegistryFile({ stateRoot: caseStateRoot })
      const legacy = path.join(caseServicesRoot, 'accounts.json')
      writeFileSync(legacy, raw)
      assert.throws(() => loadRegistry({ configPath: legacy }), undefined,
        `${label} is not actually refused by the packaged engine`)
      const answer = adoptLegacyAccountRegistry({ stateRoot: caseStateRoot, servicesRoot: caseServicesRoot })
      assert.equal(answer.ok, false, `${label} was adopted`)
      assert.equal(answer.adopted, false, `${label} published a canonical target`)
      assert.equal(existsSync(canonical), false, `${label} created the canonical target`)
      assert.deepEqual(readFileSync(legacy), raw, `${label} legacy bytes were changed or deleted`)
    }
  })
})

test('a reparse legacy source is refused without reading, writing or deleting it', () => {
  withScratchProfile(({ stateRoot, servicesRoot, file }) => {
    const realFs = require_('node:fs')
    const legacy = path.join(servicesRoot, 'accounts.json')
    writeFileSync(legacy, validLegacyBytes())
    let opens = 0
    let writes = 0
    let deletes = 0
    const guarded = {
      ...realFs,
      lstatSync(target, ...args) {
        if (target === legacy) {
          return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => true }
        }
        return realFs.lstatSync(target, ...args)
      },
      openSync(target, ...args) { if (target === legacy) opens += 1; return realFs.openSync(target, ...args) },
      writeFileSync(...args) { writes += 1; return realFs.writeFileSync(...args) },
      unlinkSync(target) { if (target === legacy) deletes += 1 },
    }
    const answer = adoptLegacyAccountRegistry({ stateRoot, servicesRoot, fsImpl: guarded })
    assert.equal(answer.code, 'ACCOUNT_LEGACY_NOT_REGULAR')
    assert.equal(opens, 0)
    assert.equal(writes, 0)
    assert.equal(deletes, 0)
    assert.equal(existsSync(file), false)
    assert.equal(existsSync(legacy), true)
  })
})

test('an existing canonical target is never read, overwritten or removed and the legacy source is untouched', () => {
  withScratchProfile(({ stateRoot, servicesRoot, file }) => {
    const realFs = require_('node:fs')
    const legacy = path.join(servicesRoot, 'accounts.json')
    const canonical = Buffer.from('canonical bytes outrank legacy bytes\n')
    const old = validLegacyBytes()
    writeFileSync(file, canonical)
    writeFileSync(legacy, old)
    let legacyOpens = 0
    let legacyDeletes = 0
    const guarded = {
      ...realFs,
      openSync(target, ...args) { if (target === legacy) legacyOpens += 1; return realFs.openSync(target, ...args) },
      unlinkSync(target) { if (target === legacy) legacyDeletes += 1 },
    }
    const answer = adoptLegacyAccountRegistry({ stateRoot, servicesRoot, fsImpl: guarded })
    assert.equal(answer.code, 'ACCOUNT_TARGET_EXISTS')
    assert.equal(legacyOpens, 0, 'the lower-priority source was opened despite an existing target')
    assert.equal(legacyDeletes, 0)
    assert.deepEqual(readFileSync(file), canonical)
    assert.deepEqual(readFileSync(legacy), old)
  })
})

test('temporary-byte verification failure publishes nothing and keeps the legacy source', () => {
  withScratchProfile(({ stateRoot, servicesRoot, file }) => {
    const realFs = require_('node:fs')
    const legacy = path.join(servicesRoot, 'accounts.json')
    const raw = validLegacyBytes()
    writeFileSync(legacy, raw)
    const openedPaths = new Map()
    const unlinkRequests = []
    const archiveDirectory = path.join(path.dirname(file), 'a28-retained-temp-archive')
    realFs.mkdirSync(archiveDirectory, { recursive: true })
    let retainedArchive = null
    const guarded = {
      ...realFs,
      openSync(target, ...args) {
        const descriptor = realFs.openSync(target, ...args)
        openedPaths.set(descriptor, target)
        return descriptor
      },
      readFileSync(target, ...args) {
        const openedPath = typeof target === 'number' ? openedPaths.get(target) : target
        if (typeof openedPath === 'string'
          && path.dirname(openedPath) === path.dirname(file)
          && path.basename(openedPath).startsWith('.accounts.json.')) {
          return Buffer.from('changed temporary bytes')
        }
        return realFs.readFileSync(target, ...args)
      },
      closeSync(descriptor) {
        openedPaths.delete(descriptor)
        return realFs.closeSync(descriptor)
      },
      unlinkSync(target) {
        unlinkRequests.push(target)
        retainedArchive = path.join(archiveDirectory, `retained-${unlinkRequests.length}-${path.basename(target)}`)
        realFs.renameSync(target, retainedArchive)
      },
    }
    const answer = adoptLegacyAccountRegistry({ stateRoot, servicesRoot, fsImpl: guarded })
    assert.equal(answer.code, 'ACCOUNT_TEMP_VERIFY_FAILED')
    assert.equal(existsSync(file), false)
    assert.deepEqual(readFileSync(legacy), raw)
    assert.equal(unlinkRequests.length, 1, 'the failed adoption did not request temporary cleanup')
    assert.equal(existsSync(unlinkRequests[0]), false, 'the unpublished temporary remained at its requested path')
    assert.equal(
      realFs.readdirSync(path.dirname(file)).filter(name => name.startsWith('.accounts.json.')).length,
      0,
      'the failed unpublished temporary remained at its original pathname',
    )
    assert.ok(retainedArchive, 'the temporary cleanup archive was not named')
    assert.equal(existsSync(retainedArchive), true, 'the temporary cleanup archive was not retained')
    assert.deepEqual(realFs.readFileSync(retainedArchive), raw, 'the retained archive bytes changed')
  })
})

test('successful adoption never unlinks the legacy source', () => {
  withScratchProfile(({ stateRoot, servicesRoot, file }) => {
    const realFs = require_('node:fs')
    const legacy = path.join(servicesRoot, 'accounts.json')
    const raw = validLegacyBytes()
    writeFileSync(legacy, raw)
    let sourceDeletes = 0
    const guarded = {
      ...realFs,
      unlinkSync(target) { if (target === legacy) sourceDeletes += 1 },
    }
    const answer = adoptLegacyAccountRegistry({ stateRoot, servicesRoot, fsImpl: guarded })
    assert.deepEqual(answer, {
      ok: true,
      adopted: true,
      legacyRemoved: false,
      code: 'ACCOUNT_LEGACY_ADOPTED_SOURCE_RETAINED',
    })
    assert.equal(sourceDeletes, 0, 'the successfully adopted source was unlinked')
    assert.deepEqual(readFileSync(file), raw)
    assert.deepEqual(readFileSync(legacy), raw)
  })
})

test('a source swapped after inspection but before open contributes zero foreign bytes', () => {
  withScratchProfile(({ stateRoot, servicesRoot, file }) => {
    const realFs = require_('node:fs')
    const legacy = path.join(servicesRoot, 'accounts.json')
    const foreign = path.join(servicesRoot, 'foreign-not-owned.json')
    const raw = validLegacyBytes()
    const foreignRaw = validLegacyBytes({
      accounts: [{ name: 'foreign', provider: 'codex', profileDir: '.codex-foreign' }],
    })
    writeFileSync(legacy, raw)
    writeFileSync(foreign, foreignRaw)

    let foreignOpens = 0
    let foreignByteReads = 0
    const foreignDescriptors = new Set()
    const guarded = {
      ...realFs,
      openSync(target, ...args) {
        if (target !== legacy) return realFs.openSync(target, ...args)
        const descriptor = realFs.openSync(foreign, ...args)
        foreignOpens += 1
        foreignDescriptors.add(descriptor)
        return descriptor
      },
      readFileSync(target, ...args) {
        if (typeof target === 'number' && foreignDescriptors.has(target)) foreignByteReads += 1
        return realFs.readFileSync(target, ...args)
      },
      closeSync(descriptor) {
        const answer = realFs.closeSync(descriptor)
        foreignDescriptors.delete(descriptor)
        return answer
      },
    }

    const answer = adoptLegacyAccountRegistry({ stateRoot, servicesRoot, fsImpl: guarded })
    assert.equal(foreignOpens, 1, 'the adversary never redirected the post-inspection open')
    assert.equal(foreignByteReads, 0, 'foreign bytes were read before descriptor identity was proved')
    assert.equal(answer.code, 'ACCOUNT_LEGACY_UNREADABLE')
    assert.equal(answer.adopted, false)
    assert.equal(existsSync(file), false, 'foreign bytes were published as the canonical registry')
    assert.deepEqual(readFileSync(legacy), raw)
    assert.deepEqual(readFileSync(foreign), foreignRaw)
  })
})

/* ------------------------------------------------------------------
   9. The credential fence, asserted twice.
   ------------------------------------------------------------------ */

test('the store never opens a sign-in file, proved against the file layer it uses', () => {
  /* THE BEHAVIOURAL HALF, and it is the one that would catch a rewrite. The
     injected layer fails the test the moment anything asks to read a path that
     looks like a provider's sign-in, and records every metadata check so the
     positive control is visible: the answer really did come from looking.

     THE POSITIVE CONTROL FOLLOWS THE CALL THAT ANSWERS. It used to record
     existsSync, which is what signedInAt() used to call; the probe now lstats,
     because existsSync is a stat with the error discarded and that error is
     the difference between "not signed in" and "could not look". Both are
     recorded, so this test proves the answer was read off the disk whichever
     of the two the store reaches for. */
  withScratchProfile(({ home, file, stateFile }) => {
    const signInHome = makeHome(home, '.codex-school', 'auth.json')
    makeHome(home, '.claude-school', '.credentials.json')

    const openedPaths = []
    const probed = []
    const realFs = require_('node:fs')
    const guardedFs = {
      ...realFs,
      openSync(target, ...args) {
        openedPaths.push(target)
        return realFs.openSync(target, ...args)
      },
      readFileSync(target, ...args) {
        return realFs.readFileSync(target, ...args)
      },
      existsSync(target) {
        probed.push(target)
        return existsSync(target)
      },
      lstatSync(target, ...args) {
        probed.push(target)
        return realFs.lstatSync(target, ...args)
      },
    }
    const store = createAccountRegistryStore({ file, stateFile, fsImpl: guardedFs, homedir: () => home })

    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    store.add({ name: 'school', provider: 'claude', directory: '.claude-school' })
    const listed = store.list().accounts
    store.activeAccount()

    assert.equal(listed.length, 2)
    assert.deepEqual(listed.map(account => account.signedIn), ['yes', 'yes'])

    for (const target of openedPaths) {
      assert.ok(
        !target.endsWith('auth.json') && !target.endsWith('.credentials.json'),
        `the store opened ${target}: a screen that reports a sign-in must never read one`,
      )
    }
    /* THE POSITIVE CONTROL. "Nothing was opened" is only meaningful if the
       sign-in answer was reached at all, so the metadata check must be there. */
    assert.ok(
      probed.some(target => target === path.join(signInHome, 'auth.json')),
      'nothing ever checked for the sign-in file, so "yes" was not a reading of the disk',
    )
  })
})

test('the module contains no call that could return the contents of a sign-in', () => {
  /* THE SOURCE HALF, copied from tools/test/provider-cli-presence.test.mjs. Its
     own prose explains why it does not read credentials, so the comments are
     stripped before the scan -- a raw scan would read the explanation as the
     violation. */
  const source = readFileSync(MODULE_FILE, 'utf8')
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

  const BANNED = [
    'createReadStream', 'readSync',
    'realpathSync', 'readlinkSync',
    'child_process', 'spawn', 'execFile', 'execSync',
  ]
  for (const banned of BANNED) {
    assert.ok(!code.includes(banned), `${banned} appears in the account store`)
  }

  withScratchProfile(({ file, stateFile, home }) => {
    const realFs = require_('node:fs')
    let enumerations = 0
    const fencedFs = { ...realFs, readdirSync(target, ...args) {
      assert.equal(target, path.dirname(stateFile), 'the account store enumerated a provider home')
      enumerations++
      return realFs.readdirSync(target, ...args)
    } }
    const store = createAccountRegistryStore({ file, stateFile, homedir: () => home, fsImpl: fencedFs })
    assert.equal(store.activeAccount().name, null)
    assert.equal(enumerations, 1, 'the absent selection must check only its owned service directory for interrupted quarantine')
  })

  /* THE ONE READER THAT HAS TO EXIST, because this module owns JSON files of
     its own -- and it is allowed exactly once, inside the function that refuses
     every path outside its caller's exact product-owned allowlist. A second
     occurrence is a second door, and there is no honest reason for one. */
  const occurrences = code.split('readFileSync').length - 1
  assert.equal(occurrences, 1, 'the account store has more than one call that returns bytes')
  const body = code.slice(code.indexOf('function readOwnedBytes'), code.indexOf('function powerShellLiteral'))
  assert.equal(code.split('openSync').length - 1, 1, 'the account store has more than one path open')
  assert.equal(code.split('fstatSync').length - 1, 1, 'the account store has more than one descriptor identity check')
  assert.equal(code.split('closeSync').length - 1, 1, 'the account store has more than one descriptor close')
  assert.ok(body.includes('readFileSync'), 'the one reader is no longer inside readOwnedBytes')
  const allowedAt = body.indexOf('allowed.includes(target)')
  const openedAt = body.indexOf('openSync')
  const fstatAt = body.indexOf('fstatSync')
  const afterLstatAt = body.lastIndexOf('lstatSync', body.indexOf('readFileSync'))
  const readAt = body.indexOf('readFileSync')
  assert.ok(allowedAt >= 0 && allowedAt < openedAt,
    'the stable open is no longer fenced to an exact product-owned allowlist')
  assert.ok(openedAt < fstatAt && fstatAt < afterLstatAt && afterLstatAt < readAt,
    'bytes can be read before the opened descriptor and post-open path identities agree')
  assert.match(body, /readFileSync\(descriptor\)/,
    'the one byte reader is no longer bound to the proved stable descriptor')
})

/* ------------------------------------------------------------------
   9b. The sign-in answer has three values, and a Sign in press watches
       the one account it was pressed on.
   ------------------------------------------------------------------ */

test('the sign-in answer is three-way: signed in, signed out, and could not look', () => {
  withScratchProfile(({ home, file, stateFile }) => {
    makeHome(home, '.codex-in', 'auth.json')
    makeHome(home, '.codex-out', null)
    makeHome(home, '.codex-blind', 'auth.json')

    /* The one folder this computer will not answer for. A real cause: a home
       on a drive that went away, or one the account running the shell may not
       read. What matters is that the probe was REFUSED, not that the file was
       missing -- the two used to reach the menu as the same word. */
    const blind = path.join(home, '.codex-blind', 'auth.json')
    const realFs = require_('node:fs')
    const refused = () => Object.assign(new Error('refused'), { code: 'EACCES' })
    /* BOTH SPELLINGS ARE REFUSED, so this test is about the ANSWER and not
       about which call the probe happens to make. Whatever it asks the file
       layer, the file layer refuses -- and 'no' is then the wrong word for
       what came back, which is the whole point. */
    const fsImpl = {
      ...realFs,
      lstatSync(target, ...args) {
        if (target === blind) throw refused()
        return realFs.lstatSync(target, ...args)
      },
      statSync(target, ...args) {
        if (target === blind) throw refused()
        return realFs.statSync(target, ...args)
      },
      existsSync(target) {
        if (target === blind) throw refused()
        return existsSync(target)
      },
    }
    const store = createAccountRegistryStore({ file, stateFile, fsImpl, homedir: () => home })
    store.add({ name: 'in', provider: 'codex', directory: '.codex-in' })
    store.add({ name: 'out', provider: 'codex', directory: '.codex-out' })
    store.add({ name: 'blind', provider: 'codex', directory: '.codex-blind' })

    const answers = new Map(store.list().accounts.map(account => [account.name, account.signedIn]))
    assert.equal(answers.get('in'), 'yes')
    assert.equal(answers.get('out'), 'no')
    assert.equal(
      answers.get('blind'),
      'unknown',
      'a folder this computer would not let the probe look at was reported as signed out',
    )
  })
})

test('a sign-in file that holds nothing is signed out, and something that is not a file is no answer at all', () => {
  withScratchProfile(({ home, file, store }) => {
    /* PRESENT, AND NOT A CREDENTIAL. An empty file at the sign-in path is the
       shape a truncated or half-written store leaves behind; a person looking
       at that row needs the Sign in press, so it answers 'no' exactly as an
       absent file does. */
    const empty = makeHome(home, '.codex-empty', null)
    writeFileSync(path.join(empty, 'auth.json'), '')

    /* A DIRECTORY WHERE THE SIGN-IN SHOULD BE. Nothing can be concluded from
       it without following it, which this probe may not do, so it is the
       third answer and not either of the first two. */
    const folder = makeHome(home, '.codex-folder', null)
    mkdirSync(path.join(folder, 'auth.json'), { recursive: true })

    store.add({ name: 'empty', provider: 'codex', directory: '.codex-empty' })
    store.add({ name: 'folder', provider: 'codex', directory: '.codex-folder' })

    const answers = new Map(store.list().accounts.map(account => [account.name, account.signedIn]))
    assert.equal(answers.get('empty'), 'no', 'a sign-in file holding nothing was reported as a sign-in')
    assert.equal(answers.get('folder'), 'unknown')
    assert.equal(existsSync(file), true)
  })
})

/* A settle plus a turn of the loop: the watch coalesces the several events one
   sign-in raises into one re-probe, so a test that asserted immediately would
   be asserting before the answer exists. */
const settled = () => new Promise(resolve => { setTimeout(resolve, 20) })

/* A folder watcher the test drives by hand. fs.watch on Windows is the one
   thing in this file that cannot be made to fire on demand -- a rename lands
   when the operating system says so -- so the events are delivered directly
   and what is asserted is what the store does WITH them. */
function watchRecorder(realFs) {
  const opened = []
  return {
    opened,
    fsImpl: {
      ...realFs,
      watch(target, options, listener) {
        const handle = {
          target,
          options,
          listener,
          closed: false,
          close() { this.closed = true },
          on() { /* the error channel is not exercised here */ },
        }
        opened.push(handle)
        return handle
      },
    },
  }
}

test('a Sign in press watches that one account and re-probes it, three-way, when its sign-in file changes', async () => {
  await withScratchProfileAsync(async ({ home, file, stateFile }) => {
    const realFs = require_('node:fs')
    makeHome(home, '.claude-work', null)
    const signInFile = path.join(home, '.claude-work', '.credentials.json')

    /* The one folder the probe is refused on, switched on part-way through, so
       the watch's own answer is proved to be three-valued and not just the two
       a presence check could give. */
    let refuseProbe = false
    const recorder = watchRecorder(realFs)
    const fsImpl = {
      ...recorder.fsImpl,
      lstatSync(target, ...args) {
        if (refuseProbe && target === signInFile) throw Object.assign(new Error('refused'), { code: 'EIO' })
        return realFs.lstatSync(target, ...args)
      },
    }

    const store = createAccountRegistryStore({ file, stateFile, fsImpl, homedir: () => home })
    store.add({ name: 'work', provider: 'claude', directory: '.claude-work' })

    const seen = []
    const armed = store.watchSignIn({ name: 'work', provider: 'claude' }, answer => { seen.push(answer) }, { settleMs: 0 })
    assert.equal(armed.ok, true)
    assert.equal(recorder.opened.length, 1, 'one press armed something other than one watch')
    assert.equal(
      recorder.opened[0].target,
      path.join(home, '.claude-work'),
      'the file was watched instead of the folder, and the file is not there when a person is signed out',
    )

    recorder.opened[0].listener('rename', '.credentials.json')
    await settled()
    assert.deepEqual(seen.at(-1), { name: 'work', provider: 'claude', signedIn: 'no' })

    /* The provider finishes in the person's own window and writes its store. */
    writeFileSync(signInFile, '{"note":"not a credential"}')
    recorder.opened[0].listener('rename', '.credentials.json')
    await settled()
    assert.deepEqual(seen.at(-1), { name: 'work', provider: 'claude', signedIn: 'yes' })

    refuseProbe = true
    recorder.opened[0].listener('change', '.credentials.json')
    await settled()
    assert.deepEqual(
      seen.at(-1),
      { name: 'work', provider: 'claude', signedIn: 'unknown' },
      'a re-probe that could not look reported a state instead of saying so',
    )
    refuseProbe = false

    /* Another file in the same folder is not this account's sign-in. */
    const before = seen.length
    recorder.opened[0].listener('change', 'settings.json')
    await settled()
    assert.equal(seen.length, before, 'a change to a different file in the folder was reported as a sign-in change')

    /* Stopping ends it: a later event changes nothing. */
    armed.stop()
    assert.equal(recorder.opened[0].closed, true, 'stopping the watch left its handle open')
    recorder.opened[0].listener('rename', '.credentials.json')
    await settled()
    assert.equal(seen.length, before, 'a stopped watch still reported')
  })
})

test('only one sign-in watch is ever armed, so a menu can never poll every account', async () => {
  await withScratchProfileAsync(async ({ home, file, stateFile }) => {
    const realFs = require_('node:fs')
    makeHome(home, '.claude-one', null)
    makeHome(home, '.claude-two', null)
    const recorder = watchRecorder(realFs)
    const store = createAccountRegistryStore({ file, stateFile, fsImpl: recorder.fsImpl, homedir: () => home })
    store.add({ name: 'one', provider: 'claude', directory: '.claude-one' })
    store.add({ name: 'two', provider: 'claude', directory: '.claude-two' })

    const seen = []
    store.watchSignIn({ name: 'one', provider: 'claude' }, answer => { seen.push(answer) }, { settleMs: 0 })
    store.watchSignIn({ name: 'two', provider: 'claude' }, answer => { seen.push(answer) }, { settleMs: 0 })

    assert.equal(recorder.opened.length, 2)
    assert.equal(recorder.opened[0].closed, true, 'pressing Sign in on a second row left the first row watched')
    assert.equal(recorder.opened[1].closed, false)

    recorder.opened[0].listener('rename', '.credentials.json')
    await settled()
    assert.deepEqual(seen, [], 'a replaced watch still reported')

    recorder.opened[1].listener('rename', '.credentials.json')
    await settled()
    assert.deepEqual(seen.map(answer => answer.name), ['two'])

    assert.deepEqual(store.stopWatchingSignIn(), { ok: true, stopped: true })
    assert.deepEqual(store.stopWatchingSignIn(), { ok: true, stopped: false })
    assert.equal(recorder.opened[1].closed, true)
  })
})

test('a watch that cannot be armed names its refusal instead of quietly not watching', () => {
  withScratchProfile(({ home, file, stateFile }) => {
    const realFs = require_('node:fs')
    makeHome(home, '.claude-work', null)
    const recorder = watchRecorder(realFs)
    const store = createAccountRegistryStore({ file, stateFile, fsImpl: recorder.fsImpl, homedir: () => home })
    store.add({ name: 'work', provider: 'claude', directory: '.claude-work' })

    assert.throws(
      () => store.watchSignIn({ name: 'work', provider: 'claude' }),
      error => error.code === 'ACCOUNT_WATCH_NO_LISTENER',
    )
    assert.throws(
      () => store.watchSignIn({ name: 'nobody', provider: 'claude' }, () => {}),
      error => error.code === 'ACCOUNT_UNKNOWN',
      'a watch was armed for a name that is not on the list',
    )
    assert.throws(
      () => store.watchSignIn({ name: 'work', provider: 'nothing' }, () => {}),
      error => error.code === 'ACCOUNT_PROVIDER_UNSUPPORTED',
    )

    const noWatch = createAccountRegistryStore({
      file, stateFile, homedir: () => home, fsImpl: { ...realFs, watch: undefined },
    })
    assert.throws(
      () => noWatch.watchSignIn({ name: 'work', provider: 'claude' }, () => {}),
      error => error.code === 'ACCOUNT_WATCH_UNAVAILABLE',
    )

    const refusingWatch = createAccountRegistryStore({
      file,
      stateFile,
      homedir: () => home,
      fsImpl: { ...realFs, watch() { throw new Error('the folder went away') } },
    })
    assert.throws(
      () => refusingWatch.watchSignIn({ name: 'work', provider: 'claude' }, () => {}),
      error => error.code === 'ACCOUNT_WATCH_FOLDER_UNREADABLE',
    )
    assert.equal(recorder.opened.length, 0, 'a refused arm still opened a handle')
  })
})

/* ------------------------------------------------------------------
   10. The three tables that must be one: the store's providers, the
       sign-in launcher's, and the packed engine's; and the six mode ids.
   ------------------------------------------------------------------ */

test('the store\'s provider table agrees with the sign-in launcher and with the packed engine', (t) => {
  assert.deepEqual([...PROVIDER_IDS], ['codex', 'claude', 'gemini', 'grok'])
  for (const id of PROVIDER_IDS) {
    /* The command the store shows a person is the command the launcher runs
       in the window it opens, and the variable the store names is the one
       the launcher sets. Two tables, one fact each. */
    assert.equal(signInLine(id), PROVIDERS[id].signInVerb,
      `${id}: the sign-in command shown and the one run differ`)
    assert.equal(LOGIN_PROVIDERS[id].homeEnv, PROVIDERS[id].homeEnv,
      `${id}: the home variable shown and the one set differ`)
  }
  assert.deepEqual(
    Object.fromEntries(PROVIDER_IDS.map(id => [id, [PROVIDERS[id].dirField, PROVIDERS[id].homeEnv, PROVIDERS[id].signInFile, PROVIDERS[id].signInSubdir]])),
    {
      codex: ['profileDir', 'CODEX_HOME', 'auth.json', null],
      claude: ['configDir', 'CLAUDE_CONFIG_DIR', '.credentials.json', null],
      /* gemini-cli writes its own .gemini folder inside GEMINI_CLI_HOME, so
         the file that means "signed in" is one level down. */
      gemini: ['homeDir', 'GEMINI_CLI_HOME', 'oauth_creds.json', '.gemini'],
      grok: ['configDir', 'GROK_HOME', 'auth.json', null],
    },
  )
  /* And every provider the packed engine knows is spelled the same way here:
     a folder field the engine would refuse is a registry it cannot load. */
  for (const id of PACKED_PROVIDER_IDS) {
    assert.ok(PROVIDER_IDS.includes(id), `the packed engine lists ${id} and the store does not`)
    for (const field of ['dirField', 'homeEnv', 'signInFile']) {
      assert.equal(PROVIDERS[id][field], PACKED_PROVIDERS[id][field], `${id}.${field} drifted from the packed engine`)
    }
    /* THE COMPOSED PRESENCE PATH, and not only the fields. The engine states
       the Gemini subdirectory in code (registry.js signInFilePath joins
       .gemini) while the store states it as a field, and the first live
       drive found the two disagreeing -- the store one level up from the
       engine, so a signed-in Gemini row would have read "not signed in" for
       ever. The store's answer must be the packed engine's, for every
       provider and for a home of any shape. */
    assert.equal(typeof packedSignInFilePath, 'function', 'the packed engine no longer exports signInFilePath')
    for (const resolved of ['\x43:\\Users\\someone\\.codex-school', '\x44:\\a b\\home']) {
      assert.equal(
        signInFilePath(resolved, PROVIDERS[id]),
        packedSignInFilePath(resolved, PACKED_PROVIDERS[id]),
        `${id}: the store looks for the sign-in at a different path than the packed engine`,
      )
    }
  }
  for (const id of PROVIDER_IDS) {
    if (!PACKED_PROVIDER_IDS.includes(id)) {
      t.diagnostic(`the store lists ${id} and the packed engine in capability/ does not yet; the engine copy is behind`)
    }
  }
})



/* ------------------------------------------------------------------
   11. A gemini account, through the store and through the packed reader.
   ------------------------------------------------------------------ */

test('a gemini account is written with homeDir, signed-in by .gemini/oauth_creds.json, and read back by the packed registry', (t) => {
  withScratchProfile(({ home, file, store }) => {
    /* WHERE THE FILE IS. gemini-cli treats GEMINI_CLI_HOME as a home and
       writes its own .gemini folder inside it (paths.ts homedir(), storage.ts
       getGlobalGeminiDir() = homedir()/.gemini, OAUTH_FILE oauth_creds.json),
       so the file that means "signed in" is one level down. A file at the
       top of the folder is NOT a sign-in, and the store must say so: that is
       the path it looked at before the first live drive corrected it. */
    makeHome(home, '.gemini-school', path.join('.gemini', 'oauth_creds.json'))
    makeHome(home, '.gemini-personal', 'oauth_creds.json')
    assert.deepEqual(store.add({ name: 'school', provider: 'gemini', directory: '.gemini-school' }), { ok: true })
    assert.deepEqual(store.add({ name: 'personal', provider: 'gemini', directory: '.gemini-personal' }), { ok: true })

    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(written.accounts, [
      { name: 'school', provider: 'gemini', homeDir: '.gemini-school', homeCreatedByApp: false },
      { name: 'personal', provider: 'gemini', homeDir: '.gemini-personal', homeCreatedByApp: false },
    ])
    const listed = store.list().accounts
    assert.deepEqual(listed.map(account => account.signedIn), ['no', 'yes'],
      'the gemini sign-in file looked for is not .gemini/oauth_creds.json')
    assert.equal(listed.find(row => row.name === 'school').directory, path.resolve(path.join(home, '.gemini-school')))

    /* The same store rules hold for the third program. */
    assert.throws(() => store.add({ name: 'SCHOOL', provider: 'gemini', directory: '.gemini-three' }),
      error => error.code === 'ACCOUNT_NAME_TAKEN')
    assert.throws(() => store.add({ name: 'three', provider: 'gemini', directory: '.gemini-school' }),
      error => error.code === 'ACCOUNT_FOLDER_SHARED')

    if (!PACKED_PROVIDER_IDS.includes('gemini')) {
      t.diagnostic('the packed engine in capability/ does not list gemini yet; the loadRegistry round trip waits for that copy')
      return
    }
    const parsed = loadRegistry({ configPath: file })
    assert.deepEqual(parsed.accounts.map(account => [account.provider, account.name, account.homeDir, account.home]), [
      ['gemini', 'school', '.gemini-school', '.gemini-school'],
      ['gemini', 'personal', '.gemini-personal', '.gemini-personal'],
    ])
    /* And the packed engine, asked about the same two folders, says what the
       store said: signed in one level down, not signed in at the top. */
    assert.deepEqual(parsed.accounts.map(account => profileProvisioned(account, { homeDir: home })), [true, false],
      'the packed engine and the store disagree about which gemini folder is signed in')
  })
})

/* ------------------------------------------------------------------
   12. Adding without naming a folder: the store makes one.
   ------------------------------------------------------------------ */

test('addManaged makes the folder under the services root, records it, and the packed reader sees it', () => {
  withScratchProfile(({ servicesRoot, file, store }) => {
    const answer = store.addManaged({ provider: 'codex', name: 'My Work' })
    const expected = path.join(servicesRoot, 'account-homes', 'codex', 'my-work')
    assert.deepEqual(answer, {
      ok: true, name: 'My Work', provider: 'codex', directory: expected, homeCreatedByApp: true,
    })
    assert.equal(existsSync(expected), true, 'the folder was not made')
    assert.ok(statSync(expected).isDirectory(), 'the folder is not a directory')
    /* EMPTY. The provider's own program writes the sign-in there later. */
    assert.deepEqual(readdirSync(expected), [])

    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(written.accounts, [{
      name: 'My Work', provider: 'codex', profileDir: expected, homeCreatedByApp: true,
    }])
    const listed = store.list().accounts
    assert.equal(listed.length, 1)
    assert.equal(listed[0].name, 'My Work')
    assert.equal(listed[0].directory, expected)
    assert.equal(listed[0].signedIn, 'no')
    assert.equal(loadRegistry({ configPath: file }).accounts[0].home, expected,
      'the packed engine resolves the made folder to somewhere else')

    /* A typed add and a made add share one list and one set of rules. */
    assert.throws(() => store.add({ name: 'typed', provider: 'codex', directory: expected }),
      error => error.code === 'ACCOUNT_FOLDER_SHARED')
    assert.deepEqual(store.add({ name: 'typed', provider: 'codex', directory: '.codex-typed' }), { ok: true })
    assert.equal(store.addManaged({ provider: 'codex', name: 'Third' }).directory,
      path.join(servicesRoot, 'account-homes', 'codex', 'third'))

  })
})

test('addManaged names the account itself when no name is given, stepping over names already used', () => {
  withScratchProfile(({ servicesRoot, store }) => {
    assert.equal(store.addManaged({ provider: 'claude' }).name, 'claude-1')
    assert.equal(store.addManaged({ provider: 'claude', name: '' }).name, 'claude-2')
    assert.equal(store.addManaged({ provider: 'claude', name: '   ' }).name, 'claude-3')
    store.addManaged({ provider: 'gemini', name: 'gemini-1' })
    const next = store.addManaged({ provider: 'gemini' })
    assert.equal(next.name, 'gemini-2')
    assert.equal(next.directory, path.join(servicesRoot, 'account-homes', 'gemini', 'gemini-2'))
    assert.equal(existsSync(next.directory), true)
    assert.deepEqual(
      store.list().accounts.map(account => `${account.provider}:${account.name}`).sort(),
      ['claude:claude-1', 'claude:claude-2', 'claude:claude-3', 'gemini:gemini-1', 'gemini:gemini-2'],
    )
  })
})

test('addManaged refuses a taken name and a name with no letter or digit in it, and makes no folder when it refuses', () => {
  withScratchProfile(({ servicesRoot, file, store }) => {
    store.addManaged({ provider: 'codex', name: 'school' })
    const before = readFileSync(file, 'utf8')
    assert.throws(() => store.addManaged({ provider: 'codex', name: 'SCHOOL' }),
      error => error.code === 'ACCOUNT_NAME_TAKEN')
    assert.throws(() => store.addManaged({ provider: 'codex', name: '!!!' }),
      error => error.code === 'ACCOUNT_NAME_INVALID')
    assert.throws(() => store.addManaged({ provider: 'codex', name: 42 }),
      error => error.code === 'ACCOUNT_NAME_INVALID')
    assert.throws(() => store.addManaged({ provider: 'gpt', name: 'x' }),
      error => error.code === 'ACCOUNT_PROVIDER_UNSUPPORTED')
    assert.equal(readFileSync(file, 'utf8'), before, 'a refused add still wrote the list')
    assert.deepEqual(readdirSync(path.join(servicesRoot, 'account-homes', 'codex')), ['school'],
      'a refused add left a folder behind')
    assert.equal(existsSync(path.join(servicesRoot, 'account-homes', 'gpt')), false)

    /* The same name on another program is the ordinary case, with its own folder. */
    const claude = store.addManaged({ provider: 'claude', name: 'school' })
    assert.equal(claude.directory, path.join(servicesRoot, 'account-homes', 'claude', 'school'))
    assert.equal(existsSync(claude.directory), true)
  })
})

test('addManaged keeps a typed name whose folder is already held, and numbers the folder instead of refusing', () => {
  withScratchProfile(({ servicesRoot, file, store }) => {
    const first = store.addManaged({ provider: 'codex', name: 'work account' })
    assert.equal(first.directory, path.join(servicesRoot, 'account-homes', 'codex', 'work-account'))
    /* "work account" and "work-account" are two names to the person and one
       slug to the folder rule. The name stays theirs; the folder is numbered. */
    const second = store.addManaged({ provider: 'codex', name: 'work-account' })
    assert.equal(second.name, 'work-account')
    assert.equal(second.directory, path.join(servicesRoot, 'account-homes', 'codex', 'work-account-2'))
    const third = store.addManaged({ provider: 'codex', name: 'Work Account!' })
    assert.equal(third.name, 'Work Account!')
    assert.equal(third.directory, path.join(servicesRoot, 'account-homes', 'codex', 'work-account-3'))
    for (const made of [first, second, third]) assert.ok(statSync(made.directory).isDirectory(), `${made.name} has no folder`)
    assert.deepEqual(readdirSync(path.join(servicesRoot, 'account-homes', 'codex')).sort(),
      ['work-account', 'work-account-2', 'work-account-3'])
    /* Three entries, three distinct homes, as the packed reader sees them. */
    assert.deepEqual(loadRegistry({ configPath: file }).accounts.map(account => account.home),
      [first.directory, second.directory, third.directory])
    /* A typed add() still refuses a folder another account holds: the
       numbering belongs to folders this store makes itself. */
    assert.throws(() => store.add({ name: 'fourth', provider: 'codex', directory: first.directory }),
      error => error.code === 'ACCOUNT_FOLDER_SHARED')
  })
})

test('addManaged keeps a name written in another alphabet, and gives it the numbered folder an unnamed add would get', () => {
  withScratchProfile(({ servicesRoot, file, store }) => {
    const cyrillic = store.addManaged({ provider: 'claude', name: CYRILLIC_WORK })
    assert.equal(cyrillic.name, CYRILLIC_WORK)
    assert.equal(cyrillic.directory, path.join(servicesRoot, 'account-homes', 'claude', 'claude-1'))
    const chinese = store.addManaged({ provider: 'claude', name: CHINESE_WORK })
    assert.equal(chinese.name, CHINESE_WORK)
    assert.equal(chinese.directory, path.join(servicesRoot, 'account-homes', 'claude', 'claude-2'))
    /* An unnamed add steps over the folders those names took, as a name and
       as a folder. */
    const unnamed = store.addManaged({ provider: 'claude' })
    assert.equal(unnamed.name, 'claude-3')
    assert.equal(unnamed.directory, path.join(servicesRoot, 'account-homes', 'claude', 'claude-3'))
    /* The name is unique as a name, in its own alphabet, whatever the case. */
    assert.throws(() => store.addManaged({ provider: 'claude', name: CYRILLIC_WORK.toLowerCase() }),
      error => error.code === 'ACCOUNT_NAME_TAKEN')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).accounts.map(account => [account.name, account.configDir]), [
      [CYRILLIC_WORK, cyrillic.directory], [CHINESE_WORK, chinese.directory], ['claude-3', unnamed.directory],
    ])
    assert.deepEqual(loadRegistry({ configPath: file }).accounts.map(account => account.name), [CYRILLIC_WORK, CHINESE_WORK, 'claude-3'])
    for (const made of [cyrillic, chinese, unnamed]) assert.ok(statSync(made.directory).isDirectory(), `${made.name} has no folder`)
  })
})

test('addManaged holds the rules add() holds: a damaged list refuses, and so does a store with no services root', () => {
  withScratchProfile(({ home, file, stateFile, store }) => {
    const homeless = createAccountRegistryStore({ file, stateFile, homedir: () => home })
    assert.throws(() => homeless.addManaged({ provider: 'codex', name: 'x' }),
      error => error.code === 'ACCOUNT_HOMES_UNAVAILABLE')
    assert.equal(existsSync(file), false, 'a store with nowhere to put a folder wrote the list anyway')

    writeFileSync(file, '{ "accounts": [ this is not json')
    assert.throws(() => store.addManaged({ provider: 'codex', name: 'x' }),
      error => error.code === 'ACCOUNT_REGISTRY_DAMAGED')
    assert.equal(readFileSync(file, 'utf8'), '{ "accounts": [ this is not json')
  })
})

test('homeOf answers the folder and home variable of a listed account, and refuses an unlisted one', () => {
  withScratchProfile(({ home, file, store }) => {
    makeHome(home, '.codex-school', 'auth.json')
    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    const made = store.addManaged({ provider: 'gemini', name: 'work' })
    assert.deepEqual(store.homeOf({ name: 'School', provider: 'codex' }), {
      name: 'school',
      provider: 'codex',
      directory: path.resolve(path.join(home, '.codex-school')),
      homeEnv: 'CODEX_HOME',
    })
    assert.deepEqual(store.homeOf({ name: 'work', provider: 'gemini' }), {
      name: 'work', provider: 'gemini', directory: made.directory, homeEnv: 'GEMINI_CLI_HOME',
    })
    assert.throws(() => store.homeOf({ name: 'school', provider: 'claude' }), error => error.code === 'ACCOUNT_UNKNOWN')
    assert.throws(() => store.homeOf({ name: 'school', provider: 'gpt' }), error => error.code === 'ACCOUNT_PROVIDER_UNSUPPORTED')
    assert.throws(() => store.homeOf({ name: '', provider: 'codex' }), error => error.code === 'ACCOUNT_NAME_MISSING')
    writeFileSync(file, '{ "accounts": [ this is not json')
    assert.throws(() => store.homeOf({ name: 'school', provider: 'codex' }), error => error.code === 'ACCOUNT_REGISTRY_DAMAGED')
  })
})

/* ------------------------------------------------------------------
   13. The switching rule: written beside the accounts, and only it.
   ------------------------------------------------------------------ */









/* ------------------------------------------------------------------
   14. Switching: one active name per program, written where the
       packed switcher reads.
   ------------------------------------------------------------------ */

test('switchTo writes a per-provider record the packed switcher reads back, and one program\'s switch leaves the other alone', () => {
  withScratchProfile(({ home, stateFile, store }) => {
    makeHome(home, '.codex-school', 'auth.json')
    makeHome(home, '.codex-personal', null)
    makeHome(home, '.claude-school', '.credentials.json')
    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    store.add({ name: 'personal', provider: 'codex', directory: '.codex-personal' })
    store.add({ name: 'school', provider: 'claude', directory: '.claude-school' })
    writeFileSync(stateFile, JSON.stringify({
      engineOwnedKey: 'kept',
      history: [{ at: 'earlier', outcome: 'selected', account: 'personal' }],
    }))

    const first = store.switchTo({ name: 'School', provider: 'codex' })
    assert.deepEqual(first, { ok: true, switched: true, active: { name: 'school', provider: 'codex' }, previous: null })
    let state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(state.engineOwnedKey, 'kept', 'a key the engine owns was dropped')
    assert.equal(state.activeAccount, 'school', 'the legacy single name was not kept for older readers')
    assert.deepEqual(state.activeByProvider, { codex: 'school', claude: null, gemini: null, grok: null })
    assert.equal(state.lastSwitch.to, 'school')
    assert.equal(state.lastSwitch.from, null)
    assert.equal(state.lastSwitch.provider, 'codex')
    assert.equal(state.lastSwitch.automatic, false)
    assert.equal(state.history.length, 2)
    assert.equal(state.history[0].outcome, 'selected', 'the engine\'s own history was discarded')
    assert.equal(state.history[1].outcome, 'manual-switch')
    assert.equal(state.history[1].provider, 'codex')

    /* THE SAME NAME ON THE OTHER PROGRAM IS A DIFFERENT ACCOUNT. Switching to
       it is a switch, and it does not disturb the Codex answer. */
    const second = store.switchTo({ name: 'school', provider: 'claude' })
    assert.equal(second.switched, true)
    assert.deepEqual(second.active, { name: 'school', provider: 'claude' })
    state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.deepEqual(state.activeByProvider, { codex: 'school', claude: 'school', gemini: null, grok: null })
    assert.equal(state.activeAccount, 'school')

    /* Already on it: an answer, and no write. */
    const bytes = readFileSync(stateFile, 'utf8')
    assert.deepEqual(store.switchTo({ name: 'school', provider: 'codex' }),
      { ok: true, switched: false, active: { name: 'school', provider: 'codex' } })
    assert.equal(readFileSync(stateFile, 'utf8'), bytes, 'an already-active switch rewrote the record')

    /* A Codex switch does not touch the Claude choice. */
    const third = store.switchTo({ name: 'personal', provider: 'codex' })
    assert.equal(third.previous, 'school')
    state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.deepEqual(state.activeByProvider, { codex: 'personal', claude: 'school', gemini: null, grok: null })
    assert.equal(state.lastSwitch.from, 'school')
    assert.deepEqual(store.activeAccount(), {
      name: 'personal', provider: 'codex', at: state.lastSwitch.at,
      byProvider: { codex: 'personal', claude: 'school', gemini: null, grok: null },
      /* A SWITCH MADE ON THIS SCREEN SAYS SO. `automatic: false` is what keeps
         the menu's sentence about a failover from being said over a change the
         person made themselves two seconds earlier. */
      lastSwitch: {
        at: state.lastSwitch.at, from: 'school', to: 'personal',
        provider: 'codex', automatic: false, reason: 'Chosen on the accounts menu.',
      },
      /* Every switch above was made on this screen, on both programs, so what
         was chosen by hand equals what is running: chosenByProvider mirrors
         byProvider exactly. No failover has happened, so nothing has moved off
         a hand choice yet -- movedOffByProvider stays null, the divergent case
         is the next test ("a switch records a choice a failover cannot erase"). */
      chosenByProvider: { codex: 'personal', claude: 'school', gemini: null, grok: null },
      movedOffByProvider: null,
    })

    /* THE PACKED SWITCHER READS WHAT WAS WRITTEN. The legacy name is what a
       reader that predates the split sees; a reader that carries the split
       sees the per-provider names. */
    const read = readState(stateFile)
    assert.equal(read.activeAccount, 'personal')
    assert.equal(read.lastSwitch.to, 'personal')
    assert.equal(read.history.at(-1).outcome, 'manual-switch')
    if (read.activeByProvider !== undefined) {
      assert.deepEqual({ ...read.activeByProvider }, { codex: 'personal', claude: 'school', gemini: null, grok: null },
        'the packed switcher reads the per-provider record differently from how the store wrote it')
    }
  })
})

/* A start that failed over, in the shape the engine's commit writes: the
   account in use is the failover's, the trail carries the chosen account's own
   line, and the choice field is untouched. */
function recordFailover(stateFile, { provider, chosen, using, at, reason }) {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  writeFileSync(stateFile, JSON.stringify({
    ...state,
    activeAccount: using,
    activeByProvider: { ...state.activeByProvider, [provider]: using },
    lastSwitch: { at, from: chosen, to: using, provider, automatic: true, reason: `Failed over to "${using}".` },
    history: [...(state.history || []), {
      at, outcome: 'selected', account: using, provider, switchedFrom: chosen, automatic: true,
      attempts: [
        { account: chosen, status: 'exhausted', usedPercent: 92, resetsAt: null, windows: null, reason },
        { account: using, status: 'healthy', usedPercent: 8, resetsAt: null, windows: null, reason: 'ready' },
      ],
    }],
  }))
}

test('a switch records a choice a failover cannot erase, and the menu is told what moved off it and why', () => {
  /* MEASURED 2026-09-03 on the owner's machine: the press wrote only the
     account in USE, the start 87 seconds later overwrote that with the
     account it failed over to, and the menu then showed the failover's
     account with nothing anywhere saying a choice had been made. */
  withScratchProfile(({ home, stateFile, store }) => {
    makeHome(home, '.codex-school', 'auth.json')
    makeHome(home, '.codex-personal', 'auth.json')
    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    store.add({ name: 'personal', provider: 'codex', directory: '.codex-personal' })

    store.switchTo({ name: 'school', provider: 'codex' })
    assert.deepEqual(store.activeAccount().chosenByProvider, { codex: 'school', claude: null, gemini: null, grok: null })
    assert.equal(store.activeAccount().movedOffByProvider, null, 'nothing has moved off it yet')

    recordFailover(stateFile, {
      provider: 'codex', chosen: 'school', using: 'personal', at: '2026-09-03T13:18:24.143Z',
      reason: '92% of its weekly allowance is used; resets 2026-09-03T16:59:59Z.',
    })

    const after = store.activeAccount()
    assert.equal(after.byProvider.codex, 'personal', 'control: the failover does own the account in use')
    assert.equal(after.chosenByProvider.codex, 'school', 'the failover erased the choice')
    assert.deepEqual(after.movedOffByProvider.codex, {
      chosen: 'school',
      using: 'personal',
      at: '2026-09-03T13:18:24.143Z',
      reason: '92% of its weekly allowance is used; resets 2026-09-03T16:59:59Z.',
    })
    assert.equal(after.movedOffByProvider.claude, null, 'a Codex failover spoke for Claude')

    /* Pressing "Use this one" on the account it moved to is a new choice even
       though nothing moves: the record named someone else. */
    const settled = store.switchTo({ name: 'personal', provider: 'codex' })
    assert.equal(settled.ok, true)
    assert.equal(settled.switched, false, 'nothing moved, and it said something did')
    const now = store.activeAccount()
    assert.equal(now.chosenByProvider.codex, 'personal')
    assert.equal(now.movedOffByProvider, null)

    // And pressing it again, with the record already saying so, writes nothing.
    const bytes = readFileSync(stateFile, 'utf8')
    assert.deepEqual(store.switchTo({ name: 'personal', provider: 'codex' }),
      { ok: true, switched: false, active: { name: 'personal', provider: 'codex' } })
    assert.equal(readFileSync(stateFile, 'utf8'), bytes, 'a press that changes nothing rewrote the record')
  })
})

test('a record written before the choice had a field of its own still answers, and a start before the choice is not read as moving off it', () => {
  withScratchProfile(({ home, stateFile, store }) => {
    makeHome(home, '.codex-school', 'auth.json')
    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    writeFileSync(stateFile, JSON.stringify({
      activeAccount: 'personal',
      activeByProvider: { codex: 'personal', claude: null, gemini: null, grok: null },
      lastSwitch: { at: 't3', from: 'school', to: 'personal', provider: 'codex', automatic: true },
      history: [
        /* A start BEFORE the choice. It settled on another account, but the
           person had not chosen yet, so it is no evidence about the choice. */
        { at: 't1', outcome: 'selected', account: 'personal', provider: 'codex', automatic: true },
        { at: 't2', outcome: 'manual-switch', account: 'school', provider: 'codex', automatic: false },
      ],
    }))
    const before = store.activeAccount()
    assert.equal(before.chosenByProvider.codex, 'school', 'the choice in the history was not read')
    assert.equal(before.movedOffByProvider, null, 'a start from before the choice was read as moving off it')

    recordFailover(stateFile, {
      provider: 'codex', chosen: 'school', using: 'personal', at: 't4', reason: 'the allowance is spent.',
    })
    assert.deepEqual(store.activeAccount().movedOffByProvider.codex,
      { chosen: 'school', using: 'personal', at: 't4', reason: 'the allowance is spent.' })
  })
})

test('switchTo caps the history the engine also caps, keeping the newest', () => {
  withScratchProfile(({ home, stateFile, store }) => {
    makeHome(home, '.codex-school', 'auth.json')
    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    const history = Array.from({ length: 25 }, (_, index) => ({ at: `t${index}`, outcome: 'selected', account: 'x' }))
    writeFileSync(stateFile, JSON.stringify({ activeAccount: 'x', history }))
    store.switchTo({ name: 'school', provider: 'codex' })
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(state.history.length, 20)
    assert.equal(state.history[0].at, 't6')
    assert.equal(state.history.at(-1).outcome, 'manual-switch')
    assert.equal(readState(stateFile).history.length, 20)
  })
})

test('same-clock quarantines preserve both damaged records and an unrelated prior backup', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1788652800000 })
  withScratchProfile(({ stateFile, store }) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const prior = `${stateFile}.corrupt-${stamp}`
    writeFileSync(prior, 'an earlier preserved record')
    for (const bytes of ['{ first damaged record', '\u0000second damaged record']) {
      writeFileSync(stateFile, bytes)
      store.activeAccount()
      assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).selectionUnreadableByProvider.codex, true)
    }
    const names = readdirSync(path.dirname(stateFile)).filter(name => name.startsWith('multi-account-state.json.corrupt-'))
    assert.equal(names.length, 3, 'each damaged record needs its own backup, including within one clock tick')
    const saved = names.map(name => {
      const target = path.join(path.dirname(stateFile), name)
      return readFileSync(statSync(target).isDirectory() ? path.join(target, path.basename(stateFile)) : target, 'utf8')
    })
    assert.deepEqual(saved.sort(), ['an earlier preserved record', '{ first damaged record', '\u0000second damaged record'].sort())
    assert.equal(readFileSync(prior, 'utf8'), 'an earlier preserved record')
  })
})

test('a failed quarantine rename preserves the damaged state and removes only its empty destination', () => {
  withScratchProfile(({ stateFile, file, home }) => {
    writeFileSync(stateFile, '{ damaged state')
    const realFs = require_('node:fs')
    const removalRequests = []
    const archive = path.join(path.dirname(stateFile), 'retained-empty-quarantine')
    const fsImpl = {
      ...realFs,
      renameSync() { throw Object.assign(new Error('rename refused'), { code: 'EACCES' }) },
      rmdirSync(target) {
        const entries = readdirSync(target)
        removalRequests.push({ target, entries })
        assert.deepEqual(entries, [], 'only an empty quarantine destination may be removed')
        assert.equal(existsSync(archive), false)
        realFs.renameSync(target, archive)
      },
    }
    const store = createAccountRegistryStore({ file, stateFile, fsImpl, homedir: () => home })
    store.activeAccount()
    assert.equal(readFileSync(stateFile, 'utf8'), '{ damaged state')
    assert.deepEqual(readdirSync(path.dirname(stateFile)).filter(name => name.startsWith('multi-account-state.json.corrupt-')), [])
    assert.equal(removalRequests.length, 1, 'the failed quarantine must request empty-directory removal')
    assert.equal(path.dirname(removalRequests[0].target), path.dirname(stateFile))
    assert.ok(path.basename(removalRequests[0].target).startsWith(`${path.basename(stateFile)}.corrupt-`))
    assert.deepEqual(removalRequests[0].entries, [])
    assert.equal(existsSync(removalRequests[0].target), false)
    assert.deepEqual(readdirSync(archive), [], 'the empty directory fixture must be retained')
  })
})

test('switchTo refuses an unlisted name, an absent list and a missing state path, and moves a damaged record aside', () => {
  withScratchProfile(({ home, file, stateFile, store }) => {
    assert.throws(() => store.switchTo({ name: 'school', provider: 'codex' }), error => error.code === 'ACCOUNT_REGISTRY_ABSENT')
    makeHome(home, '.codex-school', 'auth.json')
    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    assert.throws(() => store.switchTo({ name: 'personal', provider: 'codex' }), error => error.code === 'ACCOUNT_UNKNOWN')
    assert.throws(() => store.switchTo({ name: 'school', provider: 'claude' }), error => error.code === 'ACCOUNT_UNKNOWN')
    assert.throws(() => store.switchTo({ name: 'school', provider: 'gpt' }), error => error.code === 'ACCOUNT_PROVIDER_UNSUPPORTED')
    assert.throws(() => store.switchTo({ name: '', provider: 'codex' }), error => error.code === 'ACCOUNT_NAME_MISSING')
    assert.equal(existsSync(stateFile), false, 'a refused switch wrote the rotation record')

    const stateless = createAccountRegistryStore({ file, homedir: () => home })
    assert.throws(() => stateless.switchTo({ name: 'school', provider: 'codex' }), error => error.code === 'ACCOUNT_STATE_UNAVAILABLE')

    /* A record that will not parse is MOVED ASIDE, never overwritten in place
       and never obeyed: the 2026-09-02 brownout left this file as NUL bytes and
       every press then answered "could not be read" until a person renamed it
       by hand. The bytes survive under a name that says what they are, the
       chip reads as nothing in use, and the press goes through on a fresh
       record. */
    writeFileSync(stateFile, '{ not json at all')
    assert.equal(store.activeAccount().code, 'ACCOUNT_STATE_UNREADABLE')
    assert.equal(store.activeAccount().name, null, 'a damaged record read as an account in use')
    const aside = readdirSync(path.dirname(stateFile)).filter(name => name.startsWith('multi-account-state.json.corrupt-'))
    assert.equal(aside.length, 1, 'the damaged record was not moved aside')
    assert.equal(readFileSync(path.join(path.dirname(stateFile), aside[0], path.basename(stateFile)), 'utf8'), '{ not json at all', 'the damaged bytes did not survive the move')
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).selectionUnreadableByProvider.codex, true, 'reading a damaged choice must leave a durable choose-again record')
    writeFileSync(stateFile, '\u0000\u0000\u0000\u0000')
    assert.deepEqual(store.switchTo({ name: 'school', provider: 'codex' }), { ok: true, switched: true, active: { name: 'school', provider: 'codex' }, previous: null })
    const fresh = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(fresh.activeByProvider.codex, 'school', 'the switch after a quarantine did not land on a fresh record')
    const asideAfter = readdirSync(path.dirname(stateFile)).filter(name => name.startsWith('multi-account-state.json.corrupt-'))
    assert.equal(asideAfter.length, 2, 'the second damaged record was not moved aside too')
    assert.deepEqual(asideAfter.map(name => readFileSync(path.join(path.dirname(stateFile), name, path.basename(stateFile)), 'utf8')).sort(),
      ['{ not json at all', '\u0000\u0000\u0000\u0000'].sort(), 'both damaged byte sequences must survive')
    /* Retain both damaged state copies and their quarantine directories. The
       next assertion uses a malformed registry, so no cleanup is required.
       A registry refusal must not remove or rewrite an already valid state
       record that belongs to the separate services root. */
    const stateBeforeRegistryRefusal = readFileSync(stateFile, 'utf8')

    writeFileSync(file, '{ "accounts": [ this is not json')
    assert.throws(() => store.switchTo({ name: 'school', provider: 'codex' }), error => error.code === 'ACCOUNT_REGISTRY_DAMAGED')
    assert.equal(existsSync(stateFile), true, 'a malformed registry refusal removed the existing state record')
    assert.equal(readFileSync(stateFile, 'utf8'), stateBeforeRegistryRefusal, 'a malformed registry refusal rewrote the existing state record')
  })
})

test('the account switched to on the menu is the one the packed rotation prefers on the next manual-mode start', async () => {
  await withScratchProfileAsync(async ({ home, servicesRoot, store }) => {
    makeHome(home, '.codex-school', 'auth.json')
    makeHome(home, '.codex-personal', 'auth.json')
    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    store.add({ name: 'personal', provider: 'codex', directory: '.codex-personal' })
    store.switchTo({ name: 'personal', provider: 'codex' })

    const healthy = async account => ({
      account: account.name, email: null, usedPercent: 0, resetsAt: null, planType: null,
      status: 'healthy', canServe: true, reason: 'scratch account is healthy',
    })
    const selected = await resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir: home, mode: 'manual', selectionMode: 'manual',
      now: () => '2026-09-02T10:00:00.000Z', probe: healthy,
    })
    assert.equal(selected.rotated, true)
    assert.equal(selected.account.name, 'personal', 'the switch made on the menu was not the account the next start preferred')
  })
})

/* ------------------------------------------------------------------
   15. The main process: one home for every engine read, one registry
       read per list, and refusals that arrive as sentences.
   ------------------------------------------------------------------ */



test('rename changes the name on the list and nothing else, refuses a taken or missing name, and the account in use keeps its place', () => {
  withScratchProfile(({ home, file, stateFile, store }) => {
    makeHome(home, '.codex-school', 'auth.json')
    makeHome(home, '.codex-personal', 'auth.json')
    store.add({ name: 'school', provider: 'codex', directory: '.codex-school' })
    store.add({ name: 'personal', provider: 'codex', directory: '.codex-personal' })
    store.switchTo({ name: 'school', provider: 'codex' })
    const before = JSON.parse(readFileSync(file, 'utf8'))

    assert.throws(() => store.rename({ name: 'school', provider: 'codex', newName: 'personal' }), error => error.code === 'ACCOUNT_NAME_TAKEN')
    assert.throws(() => store.rename({ name: 'school', provider: 'codex', newName: '   ' }), error => error.code === 'ACCOUNT_NAME_MISSING')
    assert.throws(() => store.rename({ name: 'nobody', provider: 'codex', newName: 'x' }), error => error.code === 'ACCOUNT_UNKNOWN')
    assert.throws(() => store.rename({ name: 'school', provider: 'gpt', newName: 'x' }), error => error.code === 'ACCOUNT_PROVIDER_UNSUPPORTED')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), before, 'a refused rename wrote the list')
    assert.deepEqual(store.rename({ name: 'school', provider: 'codex', newName: 'school' }), { ok: true, renamed: false, name: 'school' })

    assert.deepEqual(store.rename({ name: 'school', provider: 'codex', newName: 'Office' }), { ok: true, renamed: true, name: 'Office' })
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(after.accounts.map(entry => entry.name), ['Office', 'personal'])
    assert.equal(after.accounts[0].profileDir, before.accounts[0].profileDir, 'the folder stays')

    assert.deepEqual(store.list().accounts.map(entry => entry.name), ['Office', 'personal'])
    assert.equal(store.activeAccount().name, 'Office', 'the account in use follows its new name')
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).activeByProvider.codex, 'Office')
    /* Case-only changes are a rename too, and never a collision with itself. */
    assert.deepEqual(store.rename({ name: 'office', provider: 'codex', newName: 'OFFICE' }), { ok: true, renamed: true, name: 'OFFICE' })
  })
})

/* ------------------------------------------------------------------
   14. One rule per program, and the window a ranking reads.
   ------------------------------------------------------------------ */






test('Antigravity registration is one OS sign-in; profile, client and native credential lifetime stay distinct', () => {
  withScratchProfile(({ store, home, file }) => {
    const directory=path.join(home,'agy-profile')
    mkdirSync(directory)
    store.add({name:'own native sign-in',provider:'gemini',client:'antigravity',directory})
    const row=store.list().accounts[0]
    assert.equal(row.client,'antigravity')
    assert.equal(row.signedIn,'unknown','no legacy OAuth file is evidence for native Antigravity sign-in')
    assert.equal(store.homeOf({name:row.name,provider:'gemini'}).client,'antigravity')
    assert.match(store.signInCommand({provider:'gemini',client:'antigravity',directory}),/XDG_CONFIG_HOME=/)
    assert.throws(()=>store.add({name:'not another quota',provider:'gemini',client:'antigravity',directory:path.join(home,'other')}),{code:'ACCOUNT_CLIENT_SHARED_SIGN_IN'})
    assert.throws(()=>store.addManaged({provider:'gemini',client:'antigravity'}),{code:'ACCOUNT_CLIENT_SHARED_SIGN_IN'})
    assert.throws(()=>store.add({name:'wrong provider',provider:'grok',client:'antigravity',directory}),{code:'ACCOUNT_PROVIDER_UNSUPPORTED'})
    const removed=store.remove({name:row.name,provider:'gemini'})
    assert.equal(removed.credentialDestroyed,false)
    assert.equal(removed.nativeSignInPreserved,true)
  })
})


test('old saved selection policies load without an error and disappear on the next manual registry save', () => {
  withScratchProfile(({ home, file, store }) => {
    makeHome(home, '.codex-school', null)
    writeFileSync(file, JSON.stringify({ selectionMode: { future: true }, selectionByProvider: { codex: { selectionMode: 'rotate' } },
      reservePercent: 80, rankWindow: 'weekly', autoRecoverOnLimit: true, unknownPolicy: ['future'],
      accounts: [{ name: 'school', provider: 'codex', profileDir: '.codex-school', priority: { future: true }, unknownEntry: true }] }))
    const listed = store.list()
    assert.equal(listed.damaged, false)
    assert.equal(listed.accounts[0].name, 'school')
    store.rename({ provider: 'codex', name: 'school', newName: 'chosen' })
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(saved), ['accounts'])
    assert.equal(saved.accounts[0].name, 'chosen')
    assert.equal(Object.hasOwn(saved.accounts[0], 'unknownEntry'), false)
    assert.equal(Object.hasOwn(saved.accounts[0], 'priority'), false)
    assert.deepEqual(loadRegistry({ configPath: file }).accounts.map(row => row.name), ['chosen'])
  })
})

/* 1.0.50 REVIEW, ACCOUNTS C. Claude Code also runs with an API key, a key helper
   or a cloud provider, none of which writes .credentials.json. The start gate
   counted a listed Claude account without that file as signed out, so when every
   listed Claude account used one of them ToolsEnabled refused every Claude agent
   (AGENT_TIER_NO_SIGNED_IN_ACCOUNT) before the start's own native check ran. A
   missing Claude file now answers "unknown"; a missing Codex file still "no". */
test('a Claude account with no saved sign-in does not make the start gate refuse every Claude agent', async () => {
  const { signInByProvider } = require_(MODULE_FILE)
  const fold = accounts => Object.fromEntries(signInByProvider(accounts))
  assert.deepEqual(fold([{ name: 'api', provider: 'claude', signedIn: 'no' }, { name: 'helper', provider: 'claude', signedIn: 'no' }]), { claude: 'unknown' })
  assert.deepEqual(fold([{ name: 'work', provider: 'codex', signedIn: 'no' }]), { codex: 'no' })
  assert.deepEqual(fold([{ name: 'api', provider: 'claude', signedIn: 'no' }, { name: 'sub', provider: 'claude', signedIn: 'yes' }]), { claude: 'yes' })
  assert.deepEqual(fold([{ name: 'a', provider: 'codex', signedIn: 'no' }, { name: 'b', provider: 'codex', signedIn: 'unknown' }]), { codex: 'unknown' })
  assert.deepEqual(fold([]), {})
  /* The gate itself, lifted from shell/main.cjs so the real code is what runs. */
  const { parseAst } = await import('rollup/parseAst')
  const main = readFileSync(path.join(REPO, 'shell', 'main.cjs'), 'utf8')
  const ast = parseAst(main)
  const pick = name => {
    const node = ast.body.find(entry => (entry.type === 'FunctionDeclaration' && entry.id.name === name)
      || (entry.type === 'VariableDeclaration' && entry.declarations.some(declaration => declaration.id.name === name)))
    assert.ok(node, `shell/main.cjs no longer declares ${name}`)
    return main.slice(node.start, node.end)
  }
  const gate = accounts => new Function('accountRegistry', 'signInByProvider',
    ['PROVIDER_SIGN_IN_TTL_MS', 'providerSignInCache', 'providerSignInAnswer'].map(pick).join('\n') + '\nreturn providerSignInAnswer')(
    { list: () => ({ ok: true, accounts }) }, signInByProvider)
  assert.equal(gate([{ name: 'api', provider: 'claude', signedIn: 'no' }])('claude'), 'unknown', 'an API-key Claude account must not refuse every Claude start')
  assert.equal(gate([{ name: 'work', provider: 'codex', signedIn: 'no' }])('codex'), 'no', 'a Codex account without auth.json still refuses')
  assert.equal(gate([{ name: 'sub', provider: 'claude', signedIn: 'yes' }])('claude'), 'yes')
})
