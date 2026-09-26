import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettingsDraft, draftSettingsBridge } from '../../src/settings-draft.js'

const store = new Map()
let writes = [], refuseKey = null
globalThis.localStorage = {
  getItem: key => store.get(key) ?? null,
  setItem(key, value) {
    writes.push([key, String(value)])
    if (key === refuseKey) throw new Error('fixture preference locked')
    store.set(key, String(value))
  },
  removeItem(key) {
    writes.push([key, null])
    if (key === refuseKey) throw new Error('fixture preference locked')
    store.delete(key)
  },
}
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } }
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail } }

const { noteTierRecorded } = await import('../../src/setup-state.js')
const { writeStoredProfile, readStoredProfile } = await import('../../src/setup-profile.js')
const { createSetupProfileSettings } = await import('../../src/setup-profile-settings.js')
const { WRITE_ACTION_FLAGS, isWriteEnabled, setWriteEnabled } = await import('../../src/write-flags.js')
const { isExampleMode, setExampleMode } = await import('../../src/data-source.js')

async function settle() { for (let turn = 0; turn < 60; turn += 1) await Promise.resolve() }

async function fixture({ savedFailover = 'auto', mode = 'manual', rejectAccounts = false, accounts = true, tier = 'unrestricted', status = 'complete' } = {}) {
  store.clear(); writes = []; refuseKey = null
  noteTierRecorded(tier)
  const state = {
    approval: 'Stop and wait for me', importPolicy: 'none', accountReads: 0, policyWrites: [], rejectAccounts,
    accounts: accounts ? [{ name: 'fixture', provider: 'codex' }] : [],
    policy: { selectionMode: mode, recorded: true, reservePercent: 37, rankWindow: 'weekly',
      recoverOnLimit: true, byProvider: { codex: { selectionMode: 'most-available', reservePercent: 43, own: { selectionMode: true, reservePercent: true } } } },
  }
  globalThis.mcProviders = {
    accounts: async () => {
      state.accountReads += 1
      if (state.rejectAccounts) throw new Error('fixture account list unreadable')
      return { ok: true, accounts: state.accounts, policy: { ok: true, policy: structuredClone(state.policy) } }
    },
    accountPolicy: async request => {
      state.policyWrites.push(request)
      if (state.rejectPolicy) return { ok: false, reason: 'fixture account policy locked' }
      Object.assign(state.policy, request)
      return { ok: true }
    },
  }
  globalThis.mcSetup = {
    workspaceState: async () => ({ ok: true, available: true, roots: ['/fixture'], chosen: true }),
    tierConsent: async () => ({ ok: true, recorded: false }),
    editorSessionState: async () => ({ ok: true, importPolicy: state.importPolicy, imported: [], offered: [] }),
    setEditorImportPolicy: async value => { state.importPolicy = value; return { ok: true } },
  }
  globalThis.mcSettings = {
    read: async () => ({ ok: true, rows: [{ id: 'agent.blocked_question', value: state.approval }] }),
    set: async (id, value) => { state.approval = value; return { ok: true, value } },
  }
  writeStoredProfile({ status, answers: { autonomy: 'assisted', screens: 'live', approvals: 'stop', attach: 'mirror', ideImport: 'none', failover: savedFailover } })
  for (const flag of WRITE_ACTION_FLAGS) setWriteEnabled(flag.id, ['report-read', 'agent-session', 'dispatch', 'cloud-launch'].includes(flag.id))
  setExampleMode(false)
  writes = []
  const draft = createSettingsDraft()
  const controller = createSetupProfileSettings({ draft, productSettings: draftSettingsBridge(mcSettings, draft), stageWrite: (...args) => draft.stage(...args) })
  let click
  const section = { querySelector: () => null, set outerHTML(value) {} }
  const root = {
    querySelector: selector => selector === '[data-setup-profile-system]' ? section : null,
    querySelectorAll: () => [], contains: () => true,
    addEventListener(type, handler) { if (type === 'click') click = handler }, removeEventListener() {},
  }
  controller.bind(root); controller.afterRender(root); await settle()
  return { state, draft, controller,
    markup: () => controller.markup(),
    async choose(field, value) {
      click({ target: { closest: selector => selector === '[data-setup-profile-set]' ? { dataset: { setupProfileSet: field, setupProfileValue: value } } : null } })
      await settle()
    },
    async action(action) {
      click({ target: { closest: selector => selector === '[data-setup-profile-action]' ? { dataset: { setupProfileAction: action } } : null } })
      await settle()
    },
    stageFlag(id, value) {
      const key = `row:write_${id}`
      if (value === isWriteEnabled(id)) draft.unstage(key)
      else draft.stage(key, value, next => setWriteEnabled(id, next))
    },
    stageExample(value) {
      if (value === isExampleMode()) draft.unstage('row:example_mode')
      else draft.stage('row:example_mode', value, next => setExampleMode(next))
    },
  }
}

function failoverRow(markup) { return markup.match(/<article[^>]*data-setup-profile-row="failover"[\s\S]*?<\/article>/)?.[0] || '' }
function selected(markup, field, value) { return markup.includes(`data-setup-profile-set="${field}" data-setup-profile-value="${value}" aria-pressed="true"`) }
function intentButton(markup, field, value) {
  return markup.match(new RegExp(`<button[^>]*data-setup-profile-set="intent:${field}"[^>]*data-setup-profile-value="${value}"[^>]*>`))?.[0] || ''
}

const choiceCeilings = {
  guided: { approvals: ['stop'], attach: ['mirror'], ideImport: ['none'], failover: ['manual'] },
  standard: { approvals: ['stop', 'other-work', 'judgement'], attach: ['mirror', 'fork', 'adopt'], ideImport: ['none', 'ask'], failover: ['manual', 'auto'] },
  unrestricted: { approvals: ['stop', 'other-work', 'judgement'], attach: ['mirror', 'fork', 'adopt'], ideImport: ['none', 'ask', 'all-detected'], failover: ['manual', 'auto'] },
}
for (const tier of ['guided', 'standard', 'unrestricted']) test(`${tier} Setup explains and disables every above-tier intent choice without staging a clamped no-op`, async () => {
  const f = await fixture({ tier })
  const before = readStoredProfile()
  try {
    for (const [field, choices] of Object.entries(choiceCeilings.unrestricted)) {
      const allowed = choiceCeilings[tier][field]
      for (const value of choices) {
        const button = intentButton(f.markup(), field, value)
        assert.ok(button, `${field}:${value} should remain discoverable`)
        assert.equal(/\sdisabled(?:\s|>|=)/.test(button), !allowed.includes(value), `${tier} ${field}:${value}`)
        if (!allowed.includes(value)) {
          assert.match(button, /title="[^"]*permission level/i)
          assert.match(f.markup(), new RegExp(`data-setup-tier-limit="${field}"`))
          await f.choose(`intent:${field}`, value)
          assert.equal(f.draft.dirty, false, `${field}:${value} must not stage a clamped profile`)
        }
      }
    }
    assert.deepEqual(readStoredProfile(), before)
    assert.deepEqual(f.state.policyWrites, [])
    assert.deepEqual(writes, [])
  } finally { f.controller.destroy() }
})

for (const tier of ['standard', 'unrestricted']) test(`${tier} allowed intent choices reach their saved policy rather than silently clamping`, async () => {
  const f = await fixture({ tier })
  const policy = structuredClone(f.state.policy)
  try {
    for (const field of ['approvals', 'attach', 'ideImport', 'failover']) {
      const value = choiceCeilings[tier][field].at(-1)
      await f.choose(`intent:${field}`, value)
      assert.equal(selected(f.markup(), `intent:${field}`, value), true)
      await f.draft.save()
      assert.equal(readStoredProfile().answers[field], value)
    }
    assert.equal(f.state.approval, 'Decide for itself')
    assert.equal(f.state.importPolicy, tier === 'standard' ? 'ask' : 'all-detected')
    assert.deepEqual(f.state.policy, { ...policy, selectionMode: 'priority' })
    assert.deepEqual(f.state.policyWrites, [{ selectionMode: 'priority' }])
  } finally { f.controller.destroy() }
})

test('Guided tier still displays a saved automatic Accounts policy truthfully without granting a new above-tier edit', async () => {
  const f = await fixture({ tier: 'guided', mode: 'most-available', savedFailover: 'manual' })
  const policy = structuredClone(f.state.policy)
  try {
    assert.equal(selected(f.markup(), 'intent:failover', 'auto'), true)
    assert.match(intentButton(f.markup(), 'failover', 'auto'), /\sdisabled(?:\s|>|=)/)
    assert.match(failoverRow(f.markup()), /Most room left first/)
    assert.deepEqual(f.state.policy, policy)
    assert.deepEqual(f.state.policyWrites, [])
    assert.equal(f.draft.dirty, false)
  } finally { f.controller.destroy() }
})

for (const mode of ['manual', 'priority', 'most-available']) test(`Setup reads canonical ${mode} account selection instead of the old walkthrough answer`, async () => {
  const f = await fixture({ mode, savedFailover: mode === 'manual' ? 'auto' : 'manual' })
  try {
    assert.ok(f.state.accountReads > 0)
    assert.equal(f.controller.matches('default account selection'), true)
    assert.equal(selected(f.markup(), 'intent:failover', mode === 'manual' ? 'manual' : 'auto'), true)
    if (mode === 'most-available') assert.match(failoverRow(f.markup()), /Most room left first/)
    assert.deepEqual(f.state.policyWrites, [])
    assert.deepEqual(writes, [])
  } finally { f.controller.destroy() }
})

test('an unreadable account policy is unavailable, with no selected stored fallback, and can be refreshed', async () => {
  const f = await fixture({ rejectAccounts: true })
  try {
    assert.doesNotMatch(failoverRow(f.markup()), /aria-pressed="true"/)
    assert.match(failoverRow(f.markup()), /could not be read/i)
    await f.choose('intent:failover', 'manual')
    assert.deepEqual(f.state.policyWrites, [])
    f.state.rejectAccounts = false
    await f.action('refresh-account-policy')
    assert.equal(selected(f.markup(), 'intent:failover', 'manual'), true)
  } finally { f.controller.destroy() }
})

test('an explicit account choice changes only the default selection mode and reports the effective draft', async () => {
  const f = await fixture()
  const before = structuredClone(f.state.policy)
  try {
    await f.choose('intent:failover', 'auto')
    assert.equal(selected(f.markup(), 'intent:failover', 'auto'), true)
    assert.deepEqual(f.state.policyWrites, [])
    await f.draft.save()
    assert.deepEqual(f.state.policyWrites, [{ selectionMode: 'priority' }])
    assert.deepEqual(f.state.policy, { ...before, selectionMode: 'priority' })
    assert.equal(readStoredProfile().answers.failover, 'auto')
    assert.deepEqual(writes.filter(([key]) => key !== 'mc.setup.profile'), [])
  } finally { f.controller.destroy() }
})

test('a refused account-policy write leaves its choice pending, and retry preserves every other policy field', async () => {
  const f = await fixture()
  const before = structuredClone(f.state.policy)
  try {
    await f.choose('intent:failover', 'auto')
    f.state.rejectPolicy = true
    await assert.rejects(f.draft.save(), /fixture account policy locked/)
    assert.deepEqual(f.state.policy, before)
    assert.equal(f.draft.has('setup:account-policy'), true)
    assert.equal(writes.some(([key]) => key === 'mc.setup.profile'), false)
    f.state.rejectPolicy = false
    await f.draft.save()
    assert.deepEqual(f.state.policy, { ...before, selectionMode: 'priority' })
    assert.equal(f.draft.dirty, false)
  } finally { f.controller.destroy() }
})

test('a preset on a computer without provider accounts applies its other choices without creating account policy', async () => {
  const f = await fixture({ accounts: false })
  try {
    assert.doesNotMatch(failoverRow(f.markup()), /data-setup-profile-set="intent:failover"/)
    assert.match(failoverRow(f.markup()), /Add a provider account/)
    await f.choose('autonomy', 'autonomous'); await f.draft.save()
    assert.equal(isWriteEnabled('decision'), true)
    assert.deepEqual(f.state.policyWrites, [])
  } finally { f.controller.destroy() }
})

test('an unrelated Setup choice preserves custom app permissions, example mode, and the complete Accounts policy', async () => {
  const f = await fixture({ mode: 'most-available', savedFailover: 'manual' })
  const before = structuredClone(f.state.policy)
  setWriteEnabled('dispatch', false); setExampleMode(true); writes = []
  try {
    await f.choose('intent:attach', 'fork'); await f.draft.save()
    assert.equal(isWriteEnabled('dispatch'), false)
    assert.equal(isExampleMode(), true)
    assert.deepEqual(f.state.policy, before)
    assert.deepEqual(f.state.policyWrites, [])
    assert.deepEqual(writes.filter(([key]) => key !== 'mc.setup.profile'), [])
  } finally { f.controller.destroy() }
})

test('unavailable Accounts does not turn an unrelated Setup save into an account-policy write', async () => {
  const f = await fixture({ rejectAccounts: true })
  try {
    await f.choose('intent:attach', 'fork'); await f.draft.save()
    assert.deepEqual(f.state.policyWrites, [])
    assert.doesNotMatch(failoverRow(f.markup()), /aria-pressed="true"/)
  } finally { f.controller.destroy() }
})

for (const order of ['setup-first', 'permission-first']) test(`Setup and App permissions share write-flag draft entries: ${order}`, async () => {
  const f = await fixture()
  try {
    if (order === 'setup-first') { await f.choose('autonomy', 'autonomous'); f.stageFlag('dispatch', false) }
    else { f.stageFlag('dispatch', false); await f.choose('autonomy', 'autonomous') }
    const expected = order === 'permission-first'
    assert.equal(f.draft.value('row:write_dispatch', isWriteEnabled('dispatch')), expected)
    await f.choose('intent:attach', 'fork')
    await f.draft.save()
    assert.equal(isWriteEnabled('dispatch'), expected)
    assert.equal(writes.filter(([key]) => key === 'mc.write.dispatch').length, expected ? 0 : 1)
  } finally { f.controller.destroy() }
})

for (const order of ['setup-first', 'example-first']) test(`Setup and the example toggle share one draft entry: ${order}`, async () => {
  const f = await fixture()
  try {
    if (order === 'setup-first') { await f.choose('screens', 'demonstration'); f.stageExample(false) }
    else { f.stageExample(true); await f.choose('screens', 'live') }
    assert.equal(f.draft.value('row:example_mode', isExampleMode()), false)
    await f.draft.save()
    assert.equal(isExampleMode(), false)
    assert.equal(readStoredProfile().answers.screens, 'live')
  } finally { f.controller.destroy() }
})

test('partial preset Save retries only failed preference writes and records the profile last', async () => {
  const f = await fixture()
  try {
    await f.choose('autonomy', 'autonomous')
    refuseKey = 'mc.write.queue'
    await assert.rejects(f.draft.save(), /fixture preference locked/)
    assert.equal(f.draft.has('setup:profile'), true)
    assert.equal(writes.some(([key]) => key === 'mc.setup.profile'), false)
    const successful = writes.filter(([key]) => key !== refuseKey).map(([key]) => key)
    refuseKey = null
    await f.draft.save()
    for (const key of successful) assert.equal(writes.filter(([written]) => written === key).length, 1, `${key} was replayed`)
    assert.equal(writes.at(-1)[0], 'mc.setup.profile')
    assert.equal(f.draft.dirty, false)
  } finally { f.controller.destroy() }
})

test('Setup named action preset follows real edits, save and reload instead of its historical answer', async () => {
  const f = await fixture({ tier: 'standard', status: 'skipped' })
  let reloaded
  try {
    await f.choose('autonomy','assisted')
    assert.equal(selected(f.markup(),'autonomy','assisted'),true)
    await f.draft.save()
    f.stageFlag('dispatch',false)
    assert.match(f.markup(),/Custom action and consent settings/)
    assert.equal(selected(f.markup(),'autonomy','assisted'),false)
    await f.draft.save()
    const draft = createSettingsDraft()
    reloaded = createSetupProfileSettings({ draft, productSettings: draftSettingsBridge(mcSettings,draft), stageWrite: (...args) => draft.stage(...args) })
    await reloaded.readForProfile()
    assert.match(reloaded.markup(),/Custom action and consent settings/)
    assert.doesNotMatch(reloaded.markup(),/safe defaults|Nothing that acts is switched on and/)
    assert.equal(readStoredProfile().status,'skipped','history need not be rewritten to tell the current truth')
    assert.equal(isWriteEnabled('agent-session'),true)
    assert.equal(isWriteEnabled('dispatch'),false)
  } finally { reloaded?.destroy(); f.controller.destroy() }
})

test('an unreadable canonical permission policy selects no Setup preset even when its stored answer matched', async () => {
  const f = await fixture()
  try {
    await f.choose('autonomy','assisted'); await f.draft.save()
    globalThis.mcSettings.read = async () => { throw new Error('fixture policy read unavailable') }
    const state = await f.controller.readForProfile()
    assert.equal(state.ready,false)
    for (const value of ['observe','assisted','autonomous']) assert.equal(selected(f.markup(),'autonomy',value),false)
  } finally { f.controller.destroy() }
})

test('Guided named action presets describe their effective limits instead of unrestricted consequences', async () => {
  const f = await fixture({tier:'guided'})
  try {
    await f.choose('autonomy','autonomous')
    const row = f.markup().match(/<article[^>]*data-setup-profile-row="autonomy"[\s\S]*?<\/article>/)[0]
    assert.equal(selected(row,'autonomy','autonomous'),true)
    assert.match(row,/permission questions stop and wait for you/)
    assert.match(row,/app approval and reply controls stay off/)
    assert.doesNotMatch(row,/including approving items and replying|questions use the assistant’s judgement/)
  } finally { f.controller.destroy() }
})

/* T1588: THE ROW NAMES THE PLACE AND CARRIES THE DOOR. It sent people to
   "Accounts" with no link, and no Accounts page exists: the menu is only on
   Computers. It now names "the Accounts menu on Computers" and links to an
   address that opens that menu. */
test('Default account selection names the Accounts menu on Computers and links to it open', async () => {
  const { ACCOUNTS_MENU_HREF } = await import('../../src/setup-profile-settings.js')
  const { parseRoute } = await import('../../src/route-parse.js')
  for (const accounts of [true, false]) {
    const f = await fixture({ accounts })
    const text = f.markup()
    const row = text.slice(text.indexOf('Default account selection'), text.indexOf('Refresh account policy'))
    assert.match(row, /managed in the Accounts menu on Computers\./, 'the row still names a place that is not there')
    assert.doesNotMatch(row, /managed in Accounts\.|in Accounts before/, 'the row still says "in Accounts" with no place')
    if (!accounts) assert.match(row, /Add a provider account in the Accounts menu on Computers before changing this rule\./)
    assert.match(row, new RegExp(`<a class="ctl-btn" href="${ACCOUNTS_MENU_HREF.replace(/[?]/g, '\\?')}" data-setup-profile-open-accounts>Open the Accounts menu</a>`),
      'the row offers no control that reaches the Accounts menu')
    f.controller.destroy?.()
  }
  assert.equal(parseRoute(ACCOUNTS_MENU_HREF).name, 'computers', 'the link does not reach Computers')
  assert.match(ACCOUNTS_MENU_HREF, /[?&]accounts=open(?:&|$)/, 'the link does not ask for the Accounts menu open')
})
