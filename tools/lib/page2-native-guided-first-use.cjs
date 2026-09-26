'use strict'

// Read-only native grading. The literal expectations are independent of the
// product's deriveProfile implementation; no setter or provider call is used.
const assert = require('node:assert/strict')
const path = require('node:path')
const crypto = require('node:crypto')
const { KEYS, FLAG_IDS, ownedPath, readOwnedJSON } = require('./page2-native-first-use.cjs')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const NO_CONSENT = Object.freeze({ ok: true, recorded: false, sequence: null, atMs: null, via: null })
const requestedAnswers = roots => ({ autonomy: 'assisted', screens: 'live', workspaceRoots: roots,
  approvals: 'other-work', attach: 'fork', ideImport: 'ask', failover: 'manual' })

// This actual callback is serialized by Playwright. It has no module closure
// dependencies and is separately exercised against controlled read-only IPC.
async function observeGuidedIPC(keys) {
  const settings = await window.mcSettings.read(), accounts = await window.mcProviders.accounts()
  const notice = window.mcPrefsNotice.read()
  return { source: { available: window.mcPrefs.available, file: window.mcPrefs.file,
    accountReady: window.mcDurableStorage.accountReady, signedIn: (await window.mcAccount.current()).signedIn,
    notice: { damaged: notice.damaged, preservedAt: notice.preservedAt, refused: notice.refused } },
    raw: Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])),
    host: Object.fromEntries(keys.map(key => [key, window.mcPrefs.read(key)])),
    settings: { ok: settings.ok, available: settings.available, valuesPath: settings.valuesPath,
      approval: settings.rows?.find(row => row.id === 'agent.blocked_question'), rejected: settings.rejected },
    editor: await window.mcSetup.editorSessionState({ discover: false }),
    workspace: await window.mcSetup.workspaceState(), tierConsent: await window.mcSetup.tierConsent(),
    accounts: { ok: accounts.ok, damaged: accounts.damaged === true, count: accounts.accounts?.length, policy: accounts.policy } }
}
function optionalJSON(qaRoot, file) {
  return ownedPath(qaRoot, file, { missing: true }) ? readOwnedJSON(qaRoot, file) : { file, absent: true }
}
function guidedPaths({ qaRoot, userData }) {
  assert.equal(userData, path.join(qaRoot, 'ToolsEnabled-Page2-QA'))
  const service = path.join(qaRoot, 'profile/localappdata', path.basename(userData))
  return { prefs: path.join(userData, 'renderer-prefs.json'), settings: path.join(service, 'settings.json'),
    machine: path.join(service, 'machine.json'), consent: path.join(userData, 'capability/state/config/ide-session-consent.json') }
}
async function readGuidedState(context) {
  await context.page.waitForFunction(() => window.mcDurableStorage?.accountReady === true)
  const state = await context.page.evaluate(observeGuidedIPC, KEYS), paths = guidedPaths(context.paths)
  assert.equal(state.source.available, true); assert.equal(state.source.accountReady, true)
  assert.equal(state.source.signedIn, false)
  assert.deepEqual(state.source.notice, { damaged: null, preservedAt: null, refused: null })
  assert.equal(state.source.file, paths.prefs, 'Preferences must name the exact generated leaf')
  assert.equal(state.settings.ok, true); assert.equal(state.settings.available, true)
  assert.deepEqual(state.settings.rejected, [])
  assert.equal(state.settings.valuesPath, paths.settings, 'Settings must name the exact canonical generated leaf')
  assert.equal(state.editor.ok, true); assert.equal(state.workspace.ok, true); assert.equal(state.workspace.available, true)
  assert.equal(state.accounts.ok, true); assert.equal(state.accounts.damaged, false); assert.equal(state.accounts.count, 0)
  assert.equal(state.accounts.policy.selectionMode, 'priority', 'Absent accounts retain their read-only default; no manual account policy was written')
  assert.deepEqual(state.tierConsent, NO_CONSENT, 'Unavailable consent is not evidence of no confirmed full access')
  state.disk = Object.fromEntries(Object.entries(paths).map(([key, file]) => [key, optionalJSON(context.paths.qaRoot, file)]))
  const values = state.disk.prefs.absent ? {} : state.disk.prefs.value.values
  if (!state.disk.prefs.absent) assert.equal(state.disk.prefs.value.storageVersion, 1)
  assert.ok(values && typeof values === 'object' && !Array.isArray(values))
  assert.deepEqual(Object.keys(state.raw).sort(), [...KEYS].sort())
  for (const key of KEYS) {
    assert.equal(values[key] ?? null, state.raw[key], 'Disk and mounted preference disagree: ' + key)
    assert.deepEqual(state.host[key], { ok: true, value: state.raw[key] }, 'Actual IPC and mounted preference disagree: ' + key)
  }
  const approval = state.settings.approval
  assert.ok(approval && typeof approval.value === 'string')
  if (state.disk.settings.absent) assert.equal(approval.present, false, 'An absent file cannot supply a saved approval')
  else {
    const present = Object.hasOwn(state.disk.settings.value.values, 'agent.blocked_question')
    assert.equal(approval.present, present)
    if (present) assert.equal(state.disk.settings.value.values['agent.blocked_question'], approval.value)
  }
  if (state.disk.consent.absent) assert.equal(state.editor.importPolicy, 'none')
  else assert.equal(state.disk.consent.value.importPolicy, state.editor.importPolicy)
  if (state.disk.machine.absent) {
    assert.equal(state.workspace.configured, false); assert.equal(state.workspace.recorded, false)
    assert.equal(state.workspace.tier, null); assert.deepEqual(state.workspace.roots, [])
  } else {
    const machine = state.disk.machine.value
    assert.equal(state.workspace.configured, true); assert.equal(state.workspace.recorded, true)
    assert.equal(state.workspace.tier, machine.tier); assert.deepEqual(state.workspace.roots, machine.workspaceRoots)
    assert.equal(state.workspace.chosen, machine.workspaceChosen === true)
  }
  state.disk.protectedSha256 = hash(JSON.stringify(Object.fromEntries(Object.entries(values)
    .filter(([key]) => !KEYS.includes(key)).sort(([a], [b]) => a.localeCompare(b)))))
  state.profile = state.raw['mc.setup.profile'] === null ? null : JSON.parse(state.raw['mc.setup.profile'])
  if (state.profile?.status === 'complete') for (const key of ['prefs', 'settings', 'consent', 'machine']) {
    assert.notEqual(state.disk[key].absent, true, 'Completed setup requires its real canonical ' + key + ' file')
  }
  state.custody = context.firstUse.inspect(context.paths.userData)
  assert.equal(state.custody.starts, 0); assert.equal(state.custody.registry.absent, true); assert.equal(state.custody.codexHomeEmpty, true)
  return state
}
function retainedGuided(state, { profile = true } = {}) {
  const raw = Object.fromEntries(Object.entries(state.raw).filter(([key]) => profile || key !== 'mc.setup.profile'))
  return { raw, settings: state.disk.settings, consent: state.disk.consent, machine: state.disk.machine,
    protectedSha256: state.disk.protectedSha256, workspace: state.workspace, accounts: state.accounts,
    tierConsent: state.tierConsent, ledger: state.custody.ledger, registry: state.custody.registry }
}
function assertGuidedDraft(state, { roots, step, baseline }) {
  assert.equal(state.profile.schemaVersion, 1); assert.equal(state.profile.status, 'in-progress')
  assert.equal(state.profile.step, step); assert.deepEqual(state.profile.answers, requestedAnswers(roots))
  assert.equal(state.workspace.tier, 'guided'); assert.equal(state.workspace.chosen, false)
  assert.equal(state.disk.machine.value.tier, 'guided')
  if (baseline) assert.deepEqual(retainedGuided(state, { profile: false }), retainedGuided(baseline, { profile: false }),
    'An unfinished answer changed a policy, permission, recorded root, account, consent or start record')
  return state
}
function assertGuidedSaved(state, workspace) {
  assert.equal(state.profile.schemaVersion, 1); assert.equal(state.profile.status, 'complete'); assert.equal(state.profile.step, 'review')
  assert.deepEqual(state.profile.answers, requestedAnswers([workspace]), 'Wizard must retain requested answers, not silently replace them with the Guided ceiling')
  assert.equal(state.workspace.tier, 'guided'); assert.equal(state.workspace.chosen, true)
  assert.deepEqual(state.workspace.roots, [workspace]); assert.equal(state.disk.machine.value.workspaceChosen, true)
  assert.equal(state.disk.machine.value.tier, 'guided'); assert.deepEqual(state.disk.machine.value.workspaceRoots, [workspace])
  for (const id of FLAG_IDS) assert.equal(state.raw['mc.write.' + id], ['report-read', 'agent-session'].includes(id) ? 'enabled' : 'disabled', id)
  assert.equal(state.raw['mc.example'], null)
  assert.equal(state.settings.approval.present, true); assert.equal(state.settings.approval.value, 'Stop and wait for me')
  assert.equal(state.settings.approval.provenance.source, 'user'); assert.equal(state.editor.importPolicy, 'none')
  assert.equal(state.disk.settings.value.values['agent.blocked_question'], 'Stop and wait for me')
  assert.equal(state.disk.consent.value.importPolicy, 'none')
  assert.equal(state.accounts.policy.selectionMode, 'priority'); assert.deepEqual(state.tierConsent, NO_CONSENT)
  assert.equal(state.custody.starts, 0); assert.equal(state.custody.registry.absent, true); assert.equal(state.custody.codexHomeEmpty, true)
  return state
}

module.exports = { NO_CONSENT, requestedAnswers, observeGuidedIPC, optionalJSON, guidedPaths, readGuidedState,
  retainedGuided, assertGuidedDraft, assertGuidedSaved }
