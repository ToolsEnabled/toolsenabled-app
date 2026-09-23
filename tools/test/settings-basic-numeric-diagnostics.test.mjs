/*
 * Settings regressions for T1300 (Basic landing hid the This computer
 * install and sign-in row), T1321 ('1 seconds'), T1333 (the Diagnostic files
 * panel kept the previous retention choice after Save), T1335 (every closed
 * file read 'Expires' under Keep and Archive), T1336 (MiB choices described
 * as decimal MB) and T1337 (invalid transcript quota staged as a normal
 * change).
 *
 * It mounts the shipped settingsView and controllers. The stand-in supplies
 * bounded HTML/selectors/events and a local outerHTML replacement needed by
 * these controllers' repaint contract. It does not compute CSS, layout,
 * browser visibility, native bridge behavior, or real settings persistence;
 * the rig hand test covers those.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const dom = installDomStandIn()
const cells = new Map()
const calls = {
  diagnosticInspect: [],
  productRead: 0,
  productSet: [],
  transcriptRead: 0,
  transcriptWrite: [],
}
const MIB = 1024 * 1024
const retention = { value: '30 days / 256 MiB' }
const transcript = {
  archiveDirectory: '/diagnostic-archive',
  archiveMaxBytes: 256 * MIB,
  deleteNodesOnExit: false,
}

globalThis.localStorage = {
  getItem: key => cells.get(key) ?? null,
  setItem: (key, value) => cells.set(key, String(value)),
  removeItem: key => cells.delete(key),
}
globalThis.CustomEvent = class {
  constructor(type, options = {}) {
    this.type = type
    this.detail = options.detail
  }
}
document.getElementById = id => document.body.querySelector('#' + id)
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.location = window.location = { hash: '#/settings', reload() {} }
globalThis.confirm = () => true

/*
 * The production controllers replace a mounted section with outerHTML. The
 * shipped stand-in intentionally keeps its parser small and does not provide
 * that browser property. This test-local adapter only gives those actual
 * replacement calls their DOM lifecycle; it adds no CSS/layout semantics.
 */
const elementPrototype = Object.getPrototypeOf(document.createElement('div'))
if (!Object.getOwnPropertyDescriptor(elementPrototype, 'outerHTML')) {
  Object.defineProperty(elementPrototype, 'outerHTML', {
    configurable: true,
    get() { return this.innerHTML },
    set(value) {
      if (!this.parentNode) return
      const holder = document.createElement('div')
      holder.innerHTML = String(value)
      const replacement = holder.firstElementChild
      if (replacement) this.replaceWith(replacement)
      else this.remove()
    },
  })
}

const providerPresence = [
  { id: 'codex', installed: 'yes', signedIn: 'no' },
  { id: 'claude', installed: 'yes', signedIn: 'no' },
  { id: 'gemini', installed: 'no', signedIn: 'no' },
  { id: 'grok', installed: 'no', signedIn: 'no' },
  { id: 'local', installed: 'no', signedIn: 'no' },
]

window.mcProviders = {
  presence: async () => ({ ok: true, providers: providerPresence.map(item => ({ ...item })) }),
  accounts: async () => ({ ok: true, accounts: [], active: null }),
  detectLocal: async () => ({ ok: true, runtimes: [] }),
  onLoginEvent: () => () => {},
  loginStart: async () => ({ ok: true }),
  loginStop: async () => ({ ok: true }),
  installStart: async () => ({ ok: true }),
  installSnapshot: async () => ({ ok: false }),
}
window.mcAgent = {
  nodeStatusRepairPreview: async () => ({ ok: true, previewToken: 'test-preview' }),
  nodeStatusRepairConfirm: async () => ({ ok: false, reason: 'not used by this fixture' }),
}
window.mcShell = {
  getBridgeProof: async () => ({ ok: false }),
  getBridgeEndpoint: async () => ({ ok: false }),
  getBridgeTransport: async () => ({ ok: false }),
}
globalThis.fetch = async () => ({
  ok: false,
  status: 503,
  json: async () => ({ ok: false }),
  text: async () => '',
})

const closedFile = Object.freeze({
  id: 'closed-1',
  kind: 'main-lag',
  pid: 4242,
  createdAt: Date.UTC(2026, 8, 20, 12, 0, 0),
  bytes: 2048,
  active: false,
  keep: false,
  archive: false,
  outputSuppressed: null,
})

function policyForRetention(value) {
  if (value === 'Keep diagnostics') return { mode: 'keep', cleanup: false, maxAgeDays: null, maxBytes: null }
  if (value === 'Archive diagnostics') return { mode: 'archive', cleanup: true, maxAgeDays: 7, maxBytes: 64 * MIB }
  if (value === '7 days / 64 MiB') return { mode: 'remove', cleanup: true, maxAgeDays: 7, maxBytes: 64 * MIB }
  return { mode: 'remove', cleanup: true, maxAgeDays: 30, maxBytes: 256 * MIB }
}

function diagnosticPage() {
  const policy = policyForRetention(retention.value)
  calls.diagnosticInspect.push({ value: retention.value, policy: { ...policy } })
  return {
    ok: true,
    reason: null,
    complete: true,
    scanComplete: true,
    unknownCount: 0,
    entriesThisPage: 1,
    files: [{ ...closedFile }],
    managedBytes: 2048,
    protectedBytes: 0,
    projectedBytes: 2048,
    budgetMet: true,
    policy,
  }
}

function productRows() {
  return [{
    id: 'diagnostics.retention',
    present: true,
    applicable: true,
    enforcement: { declared: true },
    control: 'seg',
    value: retention.value,
    savedValue: retention.value,
    options: ['Keep diagnostics', 'Archive diagnostics', '7 days / 64 MiB', '30 days / 256 MiB'],
    label: 'Diagnostic retention',
    consequence: 'Controls closed diagnostic files.',
    capabilities: [],
    risks: [],
  }]
}

window.mcSettings = {
  stagesWrites: true,
  read: async () => {
    calls.productRead += 1
    return { ok: true, available: true, rows: productRows() }
  },
  set: async (id, value) => {
    calls.productSet.push({ id, value })
    if (id === 'diagnostics.retention') retention.value = String(value)
    return { ok: true, value }
  },
  diagnosticsInspect: async () => diagnosticPage(),
}

window.mcTranscripts = {
  getSettings: async () => {
    calls.transcriptRead += 1
    return { ok: true, transcript: { ...transcript } }
  },
  configure: async value => {
    calls.transcriptWrite.push({ ...value })
    Object.assign(transcript, value)
    return { ok: true, transcript: { ...transcript } }
  },
  chooseArchiveDirectory: async () => ({ ok: false, reason: 'chooser not used by this fixture' }),
}

const { resolveDataSource } = await import('../../src/data-source.js')
await resolveDataSource()
const { settingsView } = await import('../../src/views/settings.js')
const { categorySlug } = await import('../../src/settings-presentation.js')
const { createDiagnosticSettings } = await import('../../src/diagnostic-settings.js')
const { createResearchSettings } = await import('../../src/research-settings.js')
const { createTranscriptSettings } = await import('../../src/transcript-settings.js')
const { createSettingsDraft } = await import('../../src/settings-draft.js')

const settle = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve))
}

function resetCalls() {
  calls.diagnosticInspect.length = 0
  calls.productRead = 0
  calls.productSet.length = 0
  calls.transcriptRead = 0
  calls.transcriptWrite.length = 0
}

function resetSettingsState() {
  cells.clear()
  cells.set('mc.settings.mode', 'advanced')
  retention.value = '30 days / 256 MiB'
  transcript.archiveDirectory = '/diagnostic-archive'
  transcript.archiveMaxBytes = 256 * MIB
  transcript.deleteNodesOnExit = false
  resetCalls()
}

async function mountSettings(section = 'Data & Privacy') {
  const view = settingsView({
    query: new URLSearchParams({ category: categorySlug(section) }),
    navigate() {},
  })
  document.body.appendChild(view.el)
  await settle(12)
  return view
}

function dispatchValue(node, value, type = 'input') {
  node.value = value
  node.dispatchEvent({ type })
}

function pageForPolicy(policy) {
  return {
    ok: true,
    reason: null,
    complete: true,
    scanComplete: true,
    unknownCount: 0,
    entriesThisPage: 1,
    files: [{ ...closedFile }],
    managedBytes: 2048,
    protectedBytes: 0,
    projectedBytes: 2048,
    budgetMet: true,
    policy,
  }
}

async function mountDiagnostic(policy) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const bridge = { diagnosticsInspect: async () => pageForPolicy(policy) }
  const controller = createDiagnosticSettings({ bridge })
  root.innerHTML = controller.markup()
  controller.bind(root)
  controller.afterRender()
  await settle()
  return { root, controller }
}

test('Basic first Settings landing keeps This computer controls reachable in the real settingsView', async t => {
  resetSettingsState()
  cells.set('mc.settings.mode', 'simple')
  const view = settingsView({ query: new URLSearchParams(), navigate() {} })
  document.body.appendChild(view.el)
  t.after(() => { view.destroy(); view.el.remove() })
  await settle(12)

  const row = view.el.querySelector('[data-setting-id="this_computer_programs"]')
  assert.ok(row, 'the first-visit This computer row is mounted')
  assert.equal(row.dataset.settingsMinMode, 'simple', 'the install/sign-in row is part of Basic')
  const programs = row.querySelector('[data-this-computer-programs]')
  assert.ok(programs, 'the actual This computer consumer is mounted')
  // The Install and Sign in buttons are painted into this slot from the
  // presence read (this-computer-settings owns and tests them); this stand-in
  // cannot resolve that compound selector, so the rig hand test sees them.
  assert.ok(programs.querySelector('[data-signin-provider="codex"]'), 'the provider sign-in slot is in the Basic row')
  assert.equal(row.hasAttribute('hidden'), false, 'the row is not structurally hidden')
})

test('numeric consumers speak singular 1 and plural 2 in range, Saved/Default and aria output', async () => {
  const rows = [
    { id: 'agent.message_queue_seconds', value: 1, savedValue: 1, default: 30, min: 1, max: 3600, step: 1, unit: 'seconds', control: 'number', present: true },
    { id: 'tools.audit_batch_size', value: 2, savedValue: 2, default: 32, min: 1, max: 100, step: 1, unit: 'records', control: 'number', present: true },
    { id: 'fleet.max_declared_agents', value: 1, savedValue: 1, default: 64, min: 1, max: 512, step: 1, unit: 'agents', control: 'number', present: true },
    { id: 'model.local_keep_alive_minutes', value: 1, savedValue: 1, default: 30, min: 1, max: 120, step: 1, unit: 'minutes', control: 'number', present: true },
  ]
  const shell = { read: async () => ({ ok: true, available: true, rows }), set: async () => ({ ok: true }) }
  const controller = createResearchSettings({ shell })
  await controller.load()
  const html = controller.markup({ section: null })
  assert.match(html, /1 second/)
  assert.match(html, /1 agent/)
  assert.match(html, /1 minute/)
  assert.match(html, /2 records/)
  assert.doesNotMatch(html, /1 seconds|1 records|1 agents|1 minutes/)
  assert.match(html, /aria-valuetext="1 second"/)
  assert.match(html, /aria-valuetext="2 records"/)
  assert.match(html, /Saved: 1 agent/)
  assert.match(html, /Default: 30 minutes/)
  controller.destroy()
})

test('one closed file follows the saved policy, and finite targets use the same MiB unit as their choices', async t => {
  const cases = [
    {
      name: 'Keep',
      policy: policyForRetention('Keep diagnostics'),
      state: 'Kept with no expiry under your retention choice',
      target: 'Your retention choice keeps every diagnostic file, with no storage limit.',
    },
    {
      name: 'Archive',
      policy: policyForRetention('Archive diagnostics'),
      state: 'Archives instead of expiring when the retention window reaches it',
      target: '64 MiB',
    },
    {
      name: 'Finite',
      policy: policyForRetention('30 days / 256 MiB'),
      state: 'Expires with the retention window',
      target: '256 MiB',
    },
  ]
  for (const item of cases) {
    const fixture = await mountDiagnostic(item.policy)
    t.after(() => { fixture.controller.destroy(); fixture.root.remove() })
    const html = fixture.controller.markup()
    assert.ok(html.includes(item.state), item.name + ' uses the policy to describe the same closed file')
    assert.ok(html.includes(item.target), item.name + ' target matches the selected policy')
    if (item.name !== 'Keep') assert.equal(html.includes('.00 MB'), false, item.name + ' does not relabel MiB as decimal MB')
  }
})

test('retention choice plus the real Settings Save re-reads diagnostics without a manual Refresh', async t => {
  resetSettingsState()
  const view = await mountSettings()
  t.after(() => { view.destroy(); view.el.remove() })

  // The stand-in splits selectors on spaces, so the option is matched by value here.
  const choice = view.el.querySelectorAll('[data-research-choice="diagnostics.retention"]')
    .find(button => button.getAttribute('data-research-value') === 'Keep diagnostics')
  assert.ok(choice, 'the real Data & Privacy consumer exposes the retention choice')
  const beforeSaveReads = calls.diagnosticInspect.length
  choice.click()
  await settle(10)
  const save = view.el.querySelector('[data-settings-save]')
  assert.equal(save.disabled, false, 'a real retention choice makes the actual Save button available')
  save.click()
  await settle(16)

  assert.ok(calls.productSet.some(call => call.id === 'diagnostics.retention' && call.value === 'Keep diagnostics'), 'the real Save callback wrote the chosen retention value')
  assert.ok(calls.diagnosticInspect.length > beforeSaveReads, 'the real Save callback requested a fresh diagnostic page')
  assert.equal(calls.diagnosticInspect.at(-1).policy.cleanup, false, 'the post-save read returned the new Keep policy')
  const target = view.el.querySelector('[data-diagnostic-target]')
  if (target) assert.match(target.textContent, /keeps every diagnostic file/, 'when the stand-in repaints, the panel matches the saved policy')
})

test('invalid transcript quota or folder is inline-invalid, disables the real Save button, and performs zero writes', async t => {
  const cases = [
    { name: 'zero', quota: '0', directory: '/diagnostic-archive', field: 'quota' },
    { name: 'negative', quota: '-3', directory: '/diagnostic-archive', field: 'quota' },
    { name: 'fractional', quota: '1.5', directory: '/diagnostic-archive', field: 'quota' },
    { name: 'empty quota', quota: '', directory: '/diagnostic-archive', field: 'quota' },
    { name: 'empty folder', quota: '256', directory: '', field: 'directory' },
  ]
  for (const item of cases) {
    resetSettingsState()
    const view = await mountSettings()
    const field = item.field === 'quota'
      ? view.el.querySelector('[data-transcript-quota]')
      : view.el.querySelector('[data-transcript-directory]')
    assert.ok(field, item.name + ' field mounted')
    dispatchValue(field, item[item.field === 'quota' ? 'quota' : 'directory'], 'input')
    dispatchValue(field, item[item.field === 'quota' ? 'quota' : 'directory'], 'change')
    await settle(10)

    assert.equal(field.getAttribute('aria-invalid'), 'true', item.name + ' is marked invalid inline')
    assert.equal(view.el.querySelector('[data-settings-save]').disabled, true, item.name + ' disables Save')
    assert.equal(view.el.dataset.settingsSaveState, 'invalid', item.name + ' sets the save state to invalid')
    assert.match(view.el.querySelector('[data-settings-draft-status]').textContent, /Correct the highlighted value before saving/)
    assert.equal(calls.transcriptWrite.length, 0, item.name + ' performs no bridge write')
    view.destroy()
    view.el.remove()
  }
})

test('a valid transcript value crosses the same Settings Save boundary once', async t => {
  resetSettingsState()
  const view = await mountSettings()
  t.after(() => { view.destroy(); view.el.remove() })
  const directory = view.el.querySelector('[data-transcript-directory]')
  const quota = view.el.querySelector('[data-transcript-quota]')
  assert.ok(directory && quota)
  dispatchValue(quota, '300', 'input')
  dispatchValue(quota, '300', 'change')
  await settle(8)
  assert.equal(view.el.querySelector('[data-settings-save]').disabled, false)
  view.el.querySelector('[data-settings-save]').click()
  await settle(16)
  assert.equal(calls.transcriptWrite.length, 1, 'valid input writes once at Save')
  assert.equal(calls.transcriptWrite[0].archiveMaxBytes, 300 * MIB)
  assert.match(view.el.querySelector('[data-settings-draft-status]').textContent, /Settings saved/)
})

test.after(() => {
  dom.restore()
})
