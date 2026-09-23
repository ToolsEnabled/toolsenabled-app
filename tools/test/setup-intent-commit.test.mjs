import assert from 'node:assert/strict'
import test from 'node:test'
import { applySetupIntentChanges, applyDeferredAccountPolicy } from '../../src/setup-intent-commit.js'
import { readStoredProfile, writeStoredProfile } from '../../src/setup-profile.js'
import { createSettingsDraft } from '../../src/settings-draft.js'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)
const { createIdeSessionSettings } = require('../../shell/ide-session-settings.cjs')
const safe = { approvals: 'stop', ideImport: 'none', failover: 'manual' }

test('in-progress walkthrough writes do not change any runtime policy', () => {
  const writes = [], stored = new Map()
  const scope = { localStorage: { setItem: (key, value) => stored.set(key, value), getItem: key => stored.get(key) ?? null },
    mcProviders: { accountPolicy: value => writes.push(value) }, mcSettings: { set: (...args) => writes.push(args) } }
  writeStoredProfile({ status: 'in-progress', answers: { ...safe, failover: 'auto' } }, scope)
  writeStoredProfile({ status: 'in-progress', answers: safe }, scope)
  assert.equal(stored.size, 1)
  assert.deepEqual(writes, [])
})

test('only changed runtime intents are written and account thresholds are not supplied', async () => {
  const writes = []
  const scope = {
    mcSettings: { set: async (...args) => { writes.push(args); return { ok: true } } },
    mcSetup: { setEditorImportPolicy: async value => { writes.push(['editor', value]); return { ok: true } } },
    mcProviders: { accountPolicy: async value => { writes.push(value); return { ok: true } } },
  }
  await applySetupIntentChanges(safe, safe, scope)
  assert.deepEqual(writes, [])
  await applySetupIntentChanges(safe, { approvals: 'other-work', ideImport: 'ask', failover: 'auto' }, scope)
  assert.deepEqual(writes, [['agent.blocked_question', 'Switch to other work'], ['editor', 'ask'], { selectionMode: 'priority' }])
})

test('runtime policy write refusals stay pending and are retried', async () => {
  const draft = createSettingsDraft(), calls = []
  let fail = true
  const scope = { mcSetup: { setEditorImportPolicy: async value => {
    calls.push(value)
    return fail ? { ok: false, error: { message: 'The consent file is locked.' } } : { ok: true }
  } } }
  draft.stage('setup:profile', { ...safe, ideImport: 'all-detected' }, next => applySetupIntentChanges(safe, next, scope))
  await assert.rejects(draft.save(), /consent file is locked/)
  assert.equal(draft.dirty, true)
  fail = false
  await draft.save()
  assert.equal(draft.dirty, false)
  assert.deepEqual(calls, ['all-detected', 'all-detected'])
})

test('a missing native intent writer is a refusal; an absent account registry is explicitly deferred', async () => {
  await assert.rejects(applySetupIntentChanges(safe, { ...safe, ideImport: 'ask' }, { mcSetup: {} }), /cannot be saved/)
  const result = await applySetupIntentChanges(safe, { ...safe, failover: 'auto' }, {
    mcProviders: { accountPolicy: async () => ({ ok: false, error: { code: 'ACCOUNT_REGISTRY_ABSENT' } }) },
  })
  assert.equal(result.deferred.length, 1)
  assert.match(result.deferred[0], /no provider accounts/)
})

test('the no-import default avoids discovery while an explicit check offers bounded metadata', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'editor-settings-home-'))
  try {
    const calls = []
    const api = createIdeSessionSettings({ root: path.join(home, 'state'), home,
      writer: { readConsentState: () => ({ ok: true, importPolicy: 'none', importedSurfaces: [], excludedSurfaces: [] }) },
      observer: { observeAgentSessions: options => { calls.push(options); return { coverage: 'complete', sessions: [{ provider: 'claude', sessionId: 'opaque' }] } } },
      consent: { partitionObservedSessions: () => ({ offeredSurfaces: [{ surface: 'claude-vscode', imported: false, sessionCount: 1 }], imported: [] }) },
    })
    assert.equal(api.read().discovery, 'not-requested')
    assert.equal(calls.length, 0)
    assert.equal(api.read({ discover: true }).surfaces[0].surface, 'claude-vscode')
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map(row => row.providers), [['claude'], ['codex']])
    assert.equal(calls[0].home, home)
    assert.equal(calls[0].claudeRoot, path.join(home, '.claude', 'projects'))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('explicit saved-session selection keeps identifiers through discovery and reports missing choices', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'editor-selected-home-'))
  const ids = ['11111111-2222-3333-4444-555555555555', '22222222-3333-4444-5555-666666666666',
    '33333333-4444-5555-6666-777777777777', '44444444-5555-6666-7777-888888888888']
  try {
    const calls = []
    const api = createIdeSessionSettings({ root: path.join(home, 'state'), home,
      writer: { readConsentState: () => ({ ok: true, importPolicy: 'ask', importedSurfaces: [], excludedSurfaces: [] }) },
      observer: { observeAgentSessions: options => {
        calls.push(options)
        return { coverage: 'complete', sessions: options.providers[0] === 'codex' ? [{ provider: 'codex', sessionId: ids[0] }] : [], scans: [{ filesRead: 1 }] }
      } },
      consent: { partitionObservedSessions: () => ({ offeredSurfaces: [], imported: [] }) },
    })
    const result = api.read({ discover: true, selectedSessionIds: ids })
    assert.deepEqual(result.selectedSessionIds, ids)
    assert.deepEqual(result.missingSessionIds, ids.slice(1))
    assert.ok(calls.every(call => call.maxFiles === 4))
    assert.ok(calls.every(call => call.selectedSessionIds === ids))
    for (const bad of [[], ['../other-account'], Array(9).fill(ids[0])]) {
      assert.throws(() => api.read({ discover: true, selectedSessionIds: bad }), /saved session identifiers/)
    }
    assert.equal(calls.length, 2)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('reading the saved editor policy does not discover provider homes or weaken explicit discovery boundaries', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'editor-policy-only-'))
  try {
    let listed = 0
    const api = createIdeSessionSettings({ root: path.join(home, 'state'), home,
      sourceHomes: () => { listed += 1; return [{ provider: 'codex', home: path.join(home, '..', 'outside-account') }] },
      writer: { readConsentState: () => ({ ok: true, importPolicy: 'ask', importedSurfaces: ['codex-vscode'], excludedSurfaces: [] }) },
      observer: { observeAgentSessions: () => { throw new Error('Policy reads must not inspect conversations') } }, consent: {},
    })
    const saved = api.read({ policyOnly: true })
    assert.equal(saved.ok, true)
    assert.equal(saved.importPolicy, 'ask')
    assert.equal(saved.discovery, 'not-requested')
    assert.equal(listed, 0)
    assert.throws(() => api.read({ discover: true }), /inside this account/)
    assert.equal(listed, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('editor discovery uses the validated isolation root while keeping the private user home and managed accounts separate', () => {
  const accountRoot = mkdtempSync(path.join(tmpdir(), 'editor-isolated-account-'))
  const home = path.join(accountRoot, 'userprofile')
  const managed = path.join(accountRoot, 'localappdata', 'accounts', 'codex')
  mkdirSync(home, { recursive: true }); mkdirSync(managed, { recursive: true })
  try {
    const calls = []
    let chosen = managed
    const api = createIdeSessionSettings({ root: path.join(accountRoot, 'state'), home, accountRoot,
      sourceHomes: () => [{ provider: 'codex', home: chosen }],
      writer: { readConsentState: () => ({ ok: true, importPolicy: 'ask', importedSurfaces: [], excludedSurfaces: [] }) },
      observer: { observeAgentSessions: options => { calls.push(options); return { coverage: 'complete', sessions: [], scans: [] } } },
      consent: { partitionObservedSessions: () => ({ offeredSurfaces: [], imported: [] }) },
    })
    assert.equal(api.read({ discover: true }).ok, true)
    assert.equal(calls.length, 3)
    assert.ok(calls.every(options => options.home === accountRoot))
    assert.equal(calls[0].claudeRoot, path.join(home, '.claude', 'projects'))
    assert.equal(calls[2].codexRoot, path.join(managed, 'sessions'))
    chosen = path.join(accountRoot, '..', 'outside-account')
    assert.throws(() => api.read({ discover: true }), /inside this account/)
    chosen = path.join(accountRoot, 'linked-account')
    symlinkSync(managed, chosen, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => api.read({ discover: true }), /linked folders/)
    assert.equal(calls.length, 3, 'a refused source must not cause any provider scan')
  } finally { rmSync(accountRoot, { recursive: true, force: true }) }
})

test('selected lookups retain the global file cap across configured provider homes', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'editor-selected-cap-'))
  try {
    const ids = Array.from({ length: 8 }, (_, i) => `${i}1111111-2222-3333-4444-555555555555`)
    let filesRead = 0
    const api = createIdeSessionSettings({ root: path.join(home, 'state'), home,
      sourceHomes: () => Array.from({ length: 10 }, (_, i) => ({ provider: 'codex', home: path.join(home, `account-${i}`) })),
      writer: { readConsentState: () => ({ ok: true, importPolicy: 'ask', importedSurfaces: [], excludedSurfaces: [] }) },
      observer: { observeAgentSessions: options => {
        filesRead += options.maxFiles
        return { coverage: 'complete', sessions: [], scans: [{ filesRead: options.maxFiles }] }
      } },
      consent: { partitionObservedSessions: () => ({ offeredSurfaces: [], imported: [] }) },
    })
    const result = api.read({ discover: true, selectedSessionIds: ids })
    assert.equal(filesRead, 40)
    assert.equal(result.discovery, 'partial')
    assert.ok(result.notes.some(note => /file limit/.test(note)))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

/* T1582: "STOP AND LET ME SWITCH" CHOSEN BEFORE ANY ACCOUNT EXISTS IS KEPT.
   On a fresh install the switching answer cannot be written, so setup stores
   a deferral. Nothing applied it, and the first account arrived with automatic
   switching. The helper every account add now calls applies it once there is
   an account to apply it to, and never over a rule somebody already chose. */
function deferredScope({ accounts = [], recorded = false, failover = 'manual', deferred = true, policyWrite = async () => ({ ok: true }) } = {}) {
  const stored = new Map(), writes = []
  const scope = {
    localStorage: { setItem: (key, value) => stored.set(key, value), getItem: key => stored.get(key) ?? null },
    mcProviders: {
      accounts: async () => ({ ok: true, accounts, policy: { ok: true, policy: { recorded, selectionMode: recorded ? 'even' : 'priority' } } }),
      accountPolicy: async request => { writes.push(request); return policyWrite(request) },
    },
  }
  writeStoredProfile({ status: 'complete', step: 'review', answers: { ...safe, failover },
    accountPolicyDeferred: deferred ? { reason: 'There are no provider accounts to switch between yet.' } : null }, scope)
  return { scope, writes }
}

test('a deferred switching answer waits while there is no account, then is applied to the first one and retired', async () => {
  const empty = deferredScope({ accounts: [] })
  assert.deepEqual(await applyDeferredAccountPolicy(empty.scope), { applied: false })
  assert.deepEqual(empty.writes, [], 'an answer was written to a list with no accounts')
  assert.ok(readStoredProfile(empty.scope).accountPolicyDeferred, 'the deferral was dropped before an account existed')

  const first = deferredScope({ accounts: [{ name: 'work', provider: 'codex' }] })
  assert.deepEqual(await applyDeferredAccountPolicy(first.scope), { applied: true, failover: 'manual' })
  assert.deepEqual(first.writes, [{ selectionMode: 'manual' }], '"Stop and let me switch" did not reach the account switching rule')
  assert.equal(readStoredProfile(first.scope).accountPolicyDeferred, null, 'the applied deferral was left to be applied again')
  assert.deepEqual(await applyDeferredAccountPolicy(first.scope), { applied: false })
  assert.equal(first.writes.length, 1, 'the answer was applied twice')

  const auto = deferredScope({ accounts: [{ name: 'work', provider: 'codex' }], failover: 'auto' })
  await applyDeferredAccountPolicy(auto.scope)
  assert.deepEqual(auto.writes, [{ selectionMode: 'priority' }])
})

test('a deferred answer never overrides a rule already chosen, and a refused write keeps it waiting', async () => {
  const chosen = deferredScope({ accounts: [{ name: 'work', provider: 'codex' }], recorded: true })
  assert.deepEqual(await applyDeferredAccountPolicy(chosen.scope), { applied: false, failover: 'manual' })
  assert.deepEqual(chosen.writes, [], 'an older setup answer replaced a rule chosen in the Accounts menu')
  assert.equal(readStoredProfile(chosen.scope).accountPolicyDeferred, null)

  const refused = deferredScope({ accounts: [{ name: 'work', provider: 'codex' }], policyWrite: async () => ({ ok: false, code: 'ACCOUNT_REGISTRY_DAMAGED' }) })
  assert.deepEqual(await applyDeferredAccountPolicy(refused.scope), { applied: false })
  assert.ok(readStoredProfile(refused.scope).accountPolicyDeferred, 'a refused write retired the deferral')

  const none = deferredScope({ accounts: [{ name: 'work', provider: 'codex' }], deferred: false })
  assert.deepEqual(await applyDeferredAccountPolicy(none.scope), { applied: false })
  assert.deepEqual(none.writes, [], 'a policy was written with no deferral stored')
})
