import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { unavailableReason, refusalCode } from '../../src/agent-availability-copy.js'
const require = createRequire(import.meta.url)
const engineRoot = canonicalRootForTests({ warn: () => {} })
const rotation = require(path.join(engineRoot, 'src/lib/multi-account/rotation.js'))
const { createAccountRegistryStore } = require('../../shell/account-registry.cjs')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-choice-app-'))
  const file = path.join(root, 'accounts.json'), stateFile = path.join(root, 'multi-account-state.json')
  fs.writeFileSync(file, JSON.stringify({ accounts: [
    { provider: 'codex', name: 'chosen', profileDir: 'chosen-home' },
    { provider: 'codex', name: 'other', profileDir: 'other-home' },
    { provider: 'claude', name: 'chosen', configDir: 'claude-home' },
  ] }))
  const store = createAccountRegistryStore({ file, stateFile, servicesRoot: root, homedir: () => root })
  const probe = async account => ({ account: account.name, status: 'healthy', canServe: true, reason: 'Ready.' })
  // Bind only the registry path; every state read/write uses the real synthetic metadata file.
  const fsImpl = { ...fs, readFileSync(target, ...args) {
    return fs.readFileSync(path.basename(target) === 'accounts.json' ? file : target, ...args)
  } }
  const resolve = options => rotation.resolveAccountForSession({ provider: 'codex', servicesRoot: root,
    homeDir: root, statePath: stateFile, fsImpl, probe, ...options })
  return { root, file, stateFile, store, probe, resolve }
}

test('A2: Accounts read preserves choose-again through repeated Start and explicit repair', async () => {
  const f = fixture()
  fs.writeFileSync(f.stateFile, '{ damaged selection metadata')
  const first = f.store.activeAccount()
  assert.equal(first.code, 'ACCOUNT_STATE_UNREADABLE')
  assert.match(first.reason, /choose an account/i)
  for (let start = 0; start < 3; start++) {
    const result = await f.resolve()
    assert.equal(result.code, 'ACCOUNT_STATE_UNREADABLE')
    assert.equal(result.blocked, true)
  }
  f.store.switchTo({ provider: 'codex', name: 'chosen' })
  assert.equal((await f.resolve()).account.name, 'chosen')
  assert.equal((await f.resolve({ provider: 'claude' })).code, 'ACCOUNT_STATE_UNREADABLE')
})

test('A2: structurally unreadable pins remain a named refusal after Accounts reads them', async () => {
  const f = fixture()
  fs.writeFileSync(f.stateFile, JSON.stringify({ manualPinByProvider: { codex: 42 } }))
  assert.equal(f.store.activeAccount().code, 'ACCOUNT_STATE_UNREADABLE')
  assert.equal((await f.resolve()).code, 'ACCOUNT_STATE_UNREADABLE')
  f.store.switchTo({ provider: 'codex', name: 'chosen' })
  assert.equal((await f.resolve()).account.name, 'chosen')
})

test('A2: interrupted Accounts quarantine remains a named refusal after reopening the store', () => {
  const f = fixture()
  fs.writeFileSync(f.stateFile, '{ damaged selection metadata')
  const refusingFs = { ...fs, writeFileSync() { throw Object.assign(new Error('Synthetic state write failed.'), { code: 'EIO' }) } }
  const interrupted = createAccountRegistryStore({ file: f.file, stateFile: f.stateFile, homedir: () => f.root, fsImpl: refusingFs })
  assert.equal(interrupted.activeAccount().code, 'ACCOUNT_STATE_UNREADABLE')
  assert.equal(f.store.activeAccount().code, 'ACCOUNT_STATE_UNREADABLE')
})

test('A3: a manual choice away and back changes the admission revision', async () => {
  const f = fixture()
  f.store.switchTo({ provider: 'codex', name: 'chosen' })
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'))
  fs.writeFileSync(f.stateFile, JSON.stringify({ ...state, activeAccount: 'other', activeByProvider: { codex: 'other' } }))
  let entered, release
  const observed = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { release = resolve })
  const pending = f.resolve({ probe: async account => { entered(); await held; return f.probe(account) } })
  await observed
  f.store.switchTo({ provider: 'codex', name: 'other' })
  f.store.switchTo({ provider: 'codex', name: 'chosen' })
  const newer = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'))
  fs.writeFileSync(f.stateFile, JSON.stringify({ ...newer, activeAccount: 'other', activeByProvider: { codex: 'other' } }))
  const beforeCommit = fs.readFileSync(f.stateFile, 'utf8')
  release()
  assert.equal((await pending).code, 'ACCOUNT_LAUNCH_COMMIT_CONFLICT')
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), beforeCommit)
})

test('A3: choosing the already active account fences a held ordinary Start', async () => {
  const f = fixture()
  f.store.switchTo({ provider: 'codex', name: 'chosen' })
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'))
  fs.writeFileSync(f.stateFile, JSON.stringify({ ...state, activeAccount: 'other', activeByProvider: { codex: 'other' } }))
  let entered, release
  const observed = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { release = resolve })
  const pending = f.resolve({ probe: async account => { entered(); await held; return f.probe(account) } })
  await observed
  f.store.switchTo({ provider: 'codex', name: 'other' })
  const newer = fs.readFileSync(f.stateFile, 'utf8')
  release()
  const result = await pending
  assert.equal(result.code, 'ACCOUNT_LAUNCH_COMMIT_CONFLICT')
  assert.equal(result.blocked, true)
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), newer)
})

test('A4: chosen account rename and case-only rename preserve Start and the saved old label home', async () => {
  for (const active of ['chosen', 'other']) {
    for (const legacy of [false, true]) {
      const f = fixture()
      f.store.switchTo({ provider: 'codex', name: 'chosen' })
      const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'))
      if (legacy) delete state.manualPinByProvider
      fs.writeFileSync(f.stateFile, JSON.stringify({ ...state, activeAccount: active, activeByProvider: { codex: active, claude: 'chosen' } }))
      f.store.rename({ provider: 'codex', name: 'chosen', newName: 'Office' })
      assert.equal(f.store.activeAccount().chosenByProvider.codex, 'Office')
      assert.equal(f.store.activeAccount().byProvider.claude, 'chosen')
      const migrated = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'))
      assert.equal(migrated.history.find(entry => entry.outcome === 'manual-switch' && entry.provider === 'codex').account, 'Office')
      assert.equal(migrated.lastSwitch.to, 'Office')
      assert.equal((await f.resolve()).account.name, 'Office')
      const saved = await f.resolve({ preferred: 'chosen', persistSelection: false })
      assert.equal(saved.account.name, 'chosen')
      assert.equal(saved.env.CODEX_HOME, path.join(f.root, 'chosen-home'))
      f.store.rename({ provider: 'codex', name: 'Office', newName: 'OFFICE' })
      assert.equal((await f.resolve()).account.name, 'OFFICE')
      assert.equal((await f.resolve({ preferred: 'Office', persistSelection: false })).env.CODEX_HOME, path.join(f.root, 'chosen-home'))
    }
  }
})

test('A4: a saved old label cannot be reused by a different account', () => {
  const f = fixture()
  f.store.rename({ provider: 'codex', name: 'chosen', newName: 'Office' })
  assert.throws(() => f.store.rename({ provider: 'codex', name: 'other', newName: 'chosen' }), { code: 'ACCOUNT_NAME_TAKEN' })
  assert.throws(() => f.store.add({ provider: 'codex', name: 'chosen', directory: 'third-home' }), { code: 'ACCOUNT_NAME_TAKEN' })
  assert.equal(f.store.list().accounts.find(row => row.name === 'Office').directory, path.join(f.root, 'chosen-home'))
})

test('A4: a legacy label within the native request bound survives a rename', async () => {
  const f = fixture()
  const oldName = 'a'.repeat(100)
  const registry = JSON.parse(fs.readFileSync(f.file, 'utf8'))
  registry.accounts[0].name = oldName
  fs.writeFileSync(f.file, JSON.stringify(registry))
  f.store.switchTo({ provider: 'codex', name: oldName })
  f.store.rename({ provider: 'codex', name: oldName, newName: 'Office' })
  assert.equal((await f.resolve()).blocked, false)
  assert.equal((await f.resolve({ preferred: oldName, persistSelection: false })).env.CODEX_HOME, path.join(f.root, 'chosen-home'))
})

test('A4: rename history cap refuses without discarding an old label or writing either record', () => {
  const f = fixture()
  const registry = JSON.parse(fs.readFileSync(f.file, 'utf8'))
  registry.accounts[0].previousNames = Array.from({ length: 64 }, (_, index) => 'old-' + index)
  fs.writeFileSync(f.file, JSON.stringify(registry))
  f.store.switchTo({ provider: 'codex', name: 'chosen' })
  const registryBefore = fs.readFileSync(f.file, 'utf8'), stateBefore = fs.readFileSync(f.stateFile, 'utf8')
  assert.throws(() => f.store.rename({ provider: 'codex', name: 'chosen', newName: 'Office' }), { code: 'ACCOUNT_RENAME_HISTORY_FULL' })
  assert.equal(fs.readFileSync(f.file, 'utf8'), registryBefore)
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), stateBefore)
})

test('A4: a legacy label beyond the native request bound refuses rename before either write', () => {
  const f = fixture()
  const oldName = 'a'.repeat(121)
  const registry = JSON.parse(fs.readFileSync(f.file, 'utf8'))
  registry.accounts[0].name = oldName
  fs.writeFileSync(f.file, JSON.stringify(registry))
  f.store.switchTo({ provider: 'codex', name: oldName })
  const registryBefore = fs.readFileSync(f.file, 'utf8'), stateBefore = fs.readFileSync(f.stateFile, 'utf8')
  assert.throws(() => f.store.rename({ provider: 'codex', name: oldName, newName: 'Office' }), error => {
    assert.equal(error.code, 'ACCOUNT_RENAME_NAME_INVALID')
    assert.match(error.message, /saved conversations.*find/i)
    return true
  })
  assert.equal(fs.readFileSync(f.file, 'utf8'), registryBefore)
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), stateBefore)
})

test('A4: contradictory historical labels make the Accounts list unreadable', () => {
  for (const previousNames of [['other'], Array.from({ length: 65 }, (_, index) => 'old-' + index), ['x'.repeat(121)], [null], 'old']) {
    const f = fixture()
    const registry = JSON.parse(fs.readFileSync(f.file, 'utf8'))
    registry.accounts[0].previousNames = previousNames
    fs.writeFileSync(f.file, JSON.stringify(registry))
    const listed = f.store.list()
    assert.equal(listed.damaged, true)
    assert.equal(listed.accounts.length, 0)
  }
})

const identity = { requestKeys: { treeAnchors: ['root', 'slot'], threadId: 'slot' },
  treeIdentity: { selfName: 'Builder', managerName: 'Controller' } }
function host(t, resolver) {
  const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
  const engine = require(enginePath)
  let starts = 0
  t.mock.method(engine, 'startCodexSession', async () => { starts++; return { threadId: 'synthetic-thread', close() {}, adapter: { interrupt() {}, sendTurn: async () => ({}) } } })
  const { createAgentHost } = require('../../shell/agent-host.cjs')
  const h = createAgentHost({ enginePath, defaultCwd: os.tmpdir(), freeMemory: () => 64 * 1024 ** 3,
    // Like the real planner, point Codex at the chosen account's own home, so a recorded origin is that home.
    confinementPlanner: ({ account } = {}) => ({ account: account?.name || null, ok: true, tier: 'unrestricted', isolated: false, threadOptions: {},
      env: typeof account?.resolvedHome === 'string' ? { CODEX_HOME: account.resolvedHome } : {} }), accountResolver: resolver })
  t.after(() => h.closeAll())
  return { h, starts: () => starts }
}

test('A4: host Resume after a rename keeps the saved label bound to its original home', async t => {
  const f = fixture()
  f.store.switchTo({ provider: 'codex', name: 'chosen' })
  const seen = []
  const h = host(t, async request => { const result = await f.resolve(request); seen.push(result); return result })
  const started = await h.h.startSession({ sessionId: 'before-rename' })
  await h.h.closeSession({ sessionId: started.sessionId })
  f.store.rename({ provider: 'codex', name: 'chosen', newName: 'Office' })
  const resumed = await h.h.startSession({ sessionId: 'after-rename', resumeThreadId: started.threadId, resumeAccount: 'chosen' })
  assert.equal(resumed.account, 'chosen')
  assert.equal(seen.at(-1).env.CODEX_HOME, path.join(f.root, 'chosen-home'))
  assert.equal(h.starts(), 1)
})

test('A7: real resolver, host and renderer retain each measured refusal for fresh and exact slot Starts', async t => {
  for (const [status, code, remedy] of [
    ['signed_out', 'ACCOUNT_SIGNED_OUT', /sign in/i], ['not_provisioned', 'ACCOUNT_NOT_PROVISIONED', /sign in/i],
    ['exhausted', 'ACCOUNT_EXHAUSTED', /allowance.*reset/i], ['account_mismatch', 'ACCOUNT_MISMATCH', /different.*account|expected account/i],
    ['transient', 'ACCOUNT_STATUS_UNKNOWN', /could not be checked/i],
  ]) {
    const f = fixture()
    f.store.switchTo({ provider: 'codex', name: 'chosen' })
    const h = host(t, request => f.resolve({ ...request, probe: async account => ({ account: account.name, status, canServe: false, reason: 'Confidential provider diagnostics.' }) }))
    for (const exact of [false, true]) {
      await assert.rejects(async () => h.h.startSession({ sessionId: status + '-' + exact,
        ...(exact ? { ...identity, treeAccount: 'chosen' } : {}) }), error => {
        assert.equal(error.code, code)
        assert.match(error.message, remedy)
        assert.doesNotMatch(error.message, /Confidential/)
        assert.equal(refusalCode(error), code)
        assert.match(unavailableReason(refusalCode(error)), remedy)
        return true
      })
    }
    assert.equal(h.starts(), 0)
  }
})
