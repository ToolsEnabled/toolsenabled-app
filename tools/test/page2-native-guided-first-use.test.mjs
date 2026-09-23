// Source-only native-driver controls: real disposable files and the actual
// exported read/grade/gesture functions, with explicitly controlled IPC/DOM
// and retained-child models. No Electron, chooser, provider or owner data.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { writeStoredProfile } from '../../src/setup-profile.js'
import { optionsFrom } from '../page2-native-audit.cjs'
import { selectScenarios } from '../lib/page2-native-report.cjs'
import { scenarios as standard } from '../lib/page2-native-first-use-scenarios.cjs'
import { scenarios, coldOpen } from '../lib/page2-native-guided-first-use-scenarios.cjs'
import { CASE_IDS, GUIDED_CASE_IDS, KEYS, FLAG_IDS, validateFirstUseOptions } from '../lib/page2-native-first-use.cjs'
import { NO_CONSENT, observeGuidedIPC, guidedPaths, readGuidedState, retainedGuided, assertGuidedDraft, assertGuidedSaved } from '../lib/page2-native-guided-first-use.cjs'

const answer = roots => ({ autonomy: 'assisted', screens: 'live', workspaceRoots: roots,
  approvals: 'other-work', attach: 'fork', ideImport: 'ask', failover: 'manual' })
function fixture(t, phase = 'initial') {
  const qaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-first-use-source-')), userData = path.join(qaRoot, 'ToolsEnabled-Page2-QA')
  t.after(() => fs.rmSync(qaRoot, { recursive: true, force: true }))
  const paths = guidedPaths({ qaRoot, userData }), workspace = path.join(qaRoot, 'workspace'), writes = []
  fs.mkdirSync(userData); fs.mkdirSync(workspace)
  const raw = Object.fromEntries(KEYS.map(key => [key, null]))
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }) }
  const profile = (status, step, roots) => {
    const stored = writeStoredProfile({ status, step, answers: answer(roots), updatedAtMs: 123 }, { localStorage: {
      setItem(key, value) { assert.equal(key, 'mc.setup.profile'); raw[key] = value; writes.push(key) },
    } }); assert.ok(stored)
  }
  const state = { source: { available: true, accountReady: true, signedIn: false, file: paths.prefs,
    notice: { damaged: null, preservedAt: null, refused: null } }, raw, host: {},
    settings: { ok: true, available: true, valuesPath: paths.settings, rejected: [],
      approval: { id: 'agent.blocked_question', present: false, value: 'Stop and wait for me', provenance: { source: 'default' } } },
    editor: { ok: true, importPolicy: 'none' }, workspace: { ok: true, available: true, configured: false, recorded: false, tier: null, roots: [], suggested: '/generated-default' },
    tierConsent: structuredClone(NO_CONSENT), accounts: { ok: true, damaged: false, count: 0, policy: { selectionMode: 'priority' } } }
  const custody = { starts: 0, codexHomeEmpty: true, registry: { path: path.join(userData, 'capability/config/accounts.json'), absent: true },
    ledger: { path: path.join(userData, 'agent-spawn-records.jsonl'), absent: true } }
  const savePrefs = () => {
    state.host = Object.fromEntries(KEYS.map(key => [key, { ok: true, value: raw[key] }]))
    write(paths.prefs, { storageVersion: 1, values: Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null)) })
  }
  function stage(next, { step = 'workspace', roots = [] } = {}) {
    if (next !== 'initial') {
      const complete = next === 'complete', machineRoots = complete ? [workspace] : ['/generated-default']
      Object.assign(state.workspace, { configured: true, recorded: true, chosen: complete, tier: 'guided', roots: machineRoots })
      write(paths.machine, { schemaVersion: 1, tier: 'guided', workspaceRoots: machineRoots, ...(complete ? { workspaceChosen: true } : {}) })
      profile(complete ? 'complete' : 'in-progress', complete ? 'review' : step, complete ? [workspace] : roots)
      if (complete) {
        for (const id of FLAG_IDS) raw['mc.write.' + id] = ['report-read', 'agent-session'].includes(id) ? 'enabled' : 'disabled'
        Object.assign(state.settings.approval, { present: true, provenance: { source: 'user' } })
        write(paths.settings, { values: { 'agent.blocked_question': 'Stop and wait for me' } })
        write(paths.consent, { importPolicy: 'none' })
      }
    }
    savePrefs()
  }
  stage(phase)
  const context = { paths: { qaRoot, userData, workspace }, page: { waitForFunction: async () => {},
    evaluate: async (callback, keys) => { assert.equal(callback, observeGuidedIPC); assert.deepEqual(keys, KEYS); return structuredClone(state) } },
    firstUse: { inspect: () => structuredClone(custody) } }
  return { context, paths, state, raw, custody, write, savePrefs, stage, profile, writes }
}

test('Guided admission is explicit, Linux-only and cannot mix existing Standard or provider cases', () => {
  const request = { sterileFirstUse: true, realProvider: false, level: 'guided', cases: [GUIDED_CASE_IDS[1]] }
  assert.equal(validateFirstUseOptions(request, 'linux'), true)
  assert.throws(() => validateFirstUseOptions(request, 'win32'), /Linux-only/)
  for (const patch of [{ level: 'standard' }, { level: undefined }, { level: 'unrestricted' }, { realProvider: true },
    { codexProfileHome: '/never-read' }, { cases: [GUIDED_CASE_IDS[0], CASE_IDS[0]] }, { cases: ['startup'] },
    { cases: ['root-start'] }, { cases: [GUIDED_CASE_IDS[0], GUIDED_CASE_IDS[0]] }]) {
    assert.throws(() => validateFirstUseOptions({ ...request, ...patch }, 'linux'))
  }
  if (process.platform === 'linux') assert.equal(optionsFrom(['--sterile-first-use', '--level', 'guided', '--case', GUIDED_CASE_IDS[1]]).level, 'guided')
})
test('the two literal cases retain their exact prerequisite closure beside unchanged Standard definitions', () => {
  assert.deepEqual(standard.map(row => row.id), ['startup', ...CASE_IDS])
  assert.deepEqual(scenarios.map(row => row.id), GUIDED_CASE_IDS)
  assert.deepEqual(selectScenarios([...standard, ...scenarios], [GUIDED_CASE_IDS[1]]).map(row => row.id), ['startup', ...GUIDED_CASE_IDS])
  assert.deepEqual(selectScenarios([...standard, ...scenarios], [CASE_IDS.at(-1)]).map(row => row.id), ['startup', ...CASE_IDS])
})
test('each Guided callback refuses an authenticated or wrong-family context before any gesture', async () => {
  for (const scenario of scenarios) for (const options of [{ realProvider: true }, { sterileFirstUse: true, level: 'standard' }]) {
    await assert.rejects(scenario.run({ options, firstUse: {}, unavailable: reason => { throw Error(reason) } }), /sterile Guided/)
  }
})
test('the actual serialized observer uses read-only public IPC and explicitly disables editor discovery', async t => {
  const f = fixture(t), calls = [], read = (name, value) => async arg => { calls.push([name, arg]); return structuredClone(value) }
  const window = { mcSettings: { read: read('settings', { ...f.state.settings, rows: [f.state.settings.approval] }) },
    mcProviders: { accounts: read('accounts', { ...f.state.accounts, accounts: [] }) }, mcPrefsNotice: { read: () => f.state.source.notice },
    mcPrefs: { available: true, file: f.paths.prefs, read: key => ({ ok: true, value: f.raw[key] }) },
    mcDurableStorage: { accountReady: true }, mcAccount: { current: read('account-current', { signedIn: false }) },
    mcSetup: { editorSessionState: read('editor', f.state.editor), workspaceState: read('workspace', f.state.workspace), tierConsent: read('tier-consent', NO_CONSENT) } }
  const observed = await vm.runInNewContext('(' + observeGuidedIPC.toString() + ')(keys)', { window, keys: KEYS, localStorage: { getItem: key => f.raw[key] } })
  assert.equal(observed.accounts.count, 0); assert.equal(observed.source.signedIn, false)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['settings', null], ['accounts', null], ['account-current', null], ['editor', { discover: false }], ['workspace', null], ['tier-consent', null]])
})
test('real generated policy absence is readable before Finish and remains distinct from a recorded tier', async t => {
  const f = fixture(t), before = await readGuidedState(f.context)
  assert.equal(before.disk.machine.absent, true); assert.equal(before.disk.settings.absent, true); assert.equal(before.disk.consent.absent, true)
  assert.equal(before.profile, null)
  f.stage('draft'); const draft = assertGuidedDraft(await readGuidedState(f.context), { roots: [], step: 'workspace' })
  assert.equal(draft.disk.machine.value.tier, 'guided'); assert.equal(draft.workspace.chosen, false)
  assert.equal(draft.disk.settings.absent, true)
})
test('draft folder/step writes use real profile serialization while preserving canonical policies and roots', async t => {
  const f = fixture(t, 'draft'), baseline = await readGuidedState(f.context)
  f.stage('draft', { step: 'review', roots: [f.context.paths.workspace] })
  const saved = assertGuidedDraft(await readGuidedState(f.context), { roots: [f.context.paths.workspace], step: 'review', baseline })
  assert.deepEqual(saved.profile.answers, answer([f.context.paths.workspace])); assert.deepEqual(saved.workspace.roots, ['/generated-default'])
  assert.deepEqual(f.writes, ['mc.setup.profile', 'mc.setup.profile'])
})
test('a newly materialized policy during the unfinished draft is refused even if its effective value is unchanged', async t => {
  const f = fixture(t, 'draft'), baseline = await readGuidedState(f.context)
  f.write(f.paths.consent, { importPolicy: 'none' })
  const changed = await readGuidedState(f.context)
  assert.throws(() => assertGuidedDraft(changed, { roots: [], step: 'workspace', baseline }), /unfinished answer changed/)
})
test('same-content settings, machine and consent siblings cannot substitute for the canonical leaves', async t => {
  const f = fixture(t, 'complete')
  const sibling = f.paths.settings + '.sibling'; fs.copyFileSync(f.paths.settings, sibling)
  f.state.settings.valuesPath = sibling
  await assert.rejects(readGuidedState(f.context), /exact canonical generated leaf/)
  f.state.settings.valuesPath = f.paths.settings
  for (const key of ['machine', 'consent']) {
    fs.renameSync(f.paths[key], f.paths[key] + '.sibling')
    await assert.rejects(readGuidedState(f.context))
    fs.renameSync(f.paths[key] + '.sibling', f.paths[key])
  }
  assert.equal(fs.readFileSync(sibling, 'utf8'), fs.readFileSync(f.paths.settings, 'utf8'))
})
test('malformed canonical policy is a refusal, never the pre-Finish absent-file state', async t => {
  const f = fixture(t, 'draft'); fs.mkdirSync(path.dirname(f.paths.settings), { recursive: true }); fs.writeFileSync(f.paths.settings, '{')
  await assert.rejects(readGuidedState(f.context), SyntaxError)
})
test('real linked machine leaf is refused without traversing or modifying its separate canary', async t => {
  const f = fixture(t, 'complete'), canary = f.paths.machine + '.canary'; fs.renameSync(f.paths.machine, canary)
  const before = fs.readFileSync(canary); fs.symlinkSync(canary, f.paths.machine)
  await assert.rejects(readGuidedState(f.context), /linked ancestor/)
  assert.deepEqual(fs.readFileSync(canary), before)
})
test('recommended saved state keeps all requested answers distinct from the Guided ceiling and absent account policy', async t => {
  const f = fixture(t, 'complete'), saved = assertGuidedSaved(await readGuidedState(f.context), f.context.paths.workspace)
  assert.equal(saved.profile.answers.approvals, 'other-work'); assert.equal(saved.settings.approval.value, 'Stop and wait for me')
  assert.equal(saved.profile.answers.ideImport, 'ask'); assert.equal(saved.editor.importPolicy, 'none')
  assert.equal(saved.profile.answers.failover, 'manual'); assert.equal(saved.accounts.policy.selectionMode, 'priority')
  for (const [field, wrong] of [['autonomy', 'observe'], ['screens', 'demonstration'], ['approvals', 'stop'], ['attach', 'mirror'], ['ideImport', 'none'], ['failover', 'auto']]) {
    const bad = structuredClone(saved); bad.profile.answers[field] = wrong
    assert.throws(() => assertGuidedSaved(bad, f.context.paths.workspace), /requested answers/)
  }
  for (const mutate of [s => { s.raw['mc.write.dispatch'] = 'enabled' }, s => { s.workspace.chosen = false },
    s => { s.disk.machine.value.workspaceRoots = ['/different'] }, s => { s.custody.starts = 1 }, s => { s.editor.importPolicy = 'ask' }]) {
    const bad = structuredClone(saved); mutate(bad); assert.throws(() => assertGuidedSaved(bad, f.context.paths.workspace))
  }
})
test('unavailable consent, populated accounts, lost IPC and observed start attempts cannot be accepted as sterile', async t => {
  const f = fixture(t, 'complete')
  for (const mutate of [s => { s.tierConsent = { ok: false, code: 'AUDIT_UNAVAILABLE' } }, s => { s.accounts.count = 1 },
    s => { s.source.signedIn = true }, s => { s.host['mc.example'] = { ok: false } }, s => { s.accounts.policy.selectionMode = 'manual' }]) {
    const previous = structuredClone(f.state); mutate(f.state); await assert.rejects(readGuidedState(f.context)); Object.assign(f.state, previous)
  }
  f.custody.starts = 1; await assert.rejects(readGuidedState(f.context))
})
test('cold reopening waits for exact retained closure, permits only a new lifetime, and never forces routing', async () => {
  const old = { pid: 8, startTicks: '10' }, receipt = { openings: [old], closures: [] }; let opens = 0
  const context = { firstUse: { receipt }, close: async () => { receipt.closures.push({ ...old, exited: true, oldIdentityGone: true }) },
    open: async () => { opens++; receipt.openings.push({ pid: 8, startTicks: '11' }) } }
  assert.equal((await coldOpen(context)).opening.startTicks, '11'); assert.equal(opens, 1)
  const refused = { firstUse: { receipt: { openings: [old], closures: [] } }, close: async () => {}, open: async () => assert.fail('Opened before closure') }
  await assert.rejects(coldOpen(refused))
  const reused = { firstUse: { receipt: { openings: [old], closures: [] } }, close: async () => { reused.firstUse.receipt.closures.push({ ...old, exited: true, oldIdentityGone: true }) },
    open: async () => reused.firstUse.receipt.openings.push({ ...old }) }
  await assert.rejects(coldOpen(reused))
})
/* FINISH IS THE GESTURE NOW, so this step no longer clicks Home -- it proves that
 * Finish's own navigation is what got there. The test is stricter in two ways than
 * the version it replaces: the success case must make ZERO clicks and write NO
 * route (before, one of each was required), and a receipt showing a cold restart
 * is refused, which nothing asserted at all. The hidden-Home refusal is kept. */
test('actual Finish exit step refuses a hidden Home link, a wrong Home target or a cold restart, and never clicks, reopens or writes a route', async () => {
  const runExit = async ({ visible = true, href = '#/', closures = [] } = {}) => {
    let clicks = 0, waits = 0
    const steps = []
    const context = { options: { sterileFirstUse: true, level: 'guided' },
      firstUse: { receipt: { openings: [{ pid: 2, startTicks: '3' }], closures } },
      step: async (id, fn) => { if (id !== 'guided-finish-visible-exit') return undefined
        const value = await fn(); steps.push([id, value]); return value }, capture: async () => {},
      page: { locator: selector => { assert.equal(selector, 'nav[aria-label="Primary navigation"] a[data-route="home"]')
        return { isVisible: async () => visible, getAttribute: async () => href, click: async () => { clicks++ } } },
        waitForURL: async () => { waits++ }, url: () => 'file:///generated/#/' } }
    return { run: () => scenarios[1].run(context), counts: () => ({ clicks, waits }), steps }
  }
  for (const [options, pattern] of [
    [{ visible: false }, /must offer its primary navigation/],
    [{ closures: [{ pid: 2, startTicks: '3', exited: true }] }, /cold restart/],
    [{ href: '#/settings' }, /'#\/settings' !== '#\/'/],
  ]) {
    const refused = await runExit(options)
    await assert.rejects(refused.run(), pattern)
    assert.deepEqual(refused.counts(), { clicks: 0, waits: 0 }, `${JSON.stringify(options)} must be refused before any gesture`)
  }
  const accepted = await runExit()
  await accepted.run()
  assert.equal(accepted.steps.length, 1)
  assert.equal(accepted.steps[0][1].gesture, 'Finish setup',
    'mutation `credit the exit to a Home click` survived: expected the recorded gesture to be Finish itself')
  assert.deepEqual(accepted.counts(), { clicks: 0, waits: 0 },
    'mutation `click Home to finish the walk` survived: expected the step to observe Finish, not to supply the navigation')
})
