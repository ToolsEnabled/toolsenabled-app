// Execute the real Settings view and its real controllers. The small DOM and
// bridge below provide explicit component fixtures; native disk-backed replay
// is recorded separately and this file makes no Electron or disk-I/O claim.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

register('./helpers/css-stub-loader.mjs', import.meta.url)


const stored = new Map()
const listeners = new Map()
let painted = ''
let refuseTheme = false, refuseFleet = false, confirmLeave = false, reloads = 0
let writes = [], navigated = []
const profile = { schemaVersion: 1, id: 'fixture-fleet', label: 'Original fixture fleet',
  machines: [{ id: 'fixture-machine', name: 'Original fixture machine', ip: '192.0.2.44' }],
  transports: [{ id: 'relay', port: null, note: 'not configured' }] }
let durable = structuredClone(profile)
const bridge = { bootstrap: { ok: true, state: 'configured', configured: true, profile },
  save: async value => {
    if (refuseFleet) return { ok: false, error: { message: 'Owned fleet write refused' } }
    durable = structuredClone(value); writes.push('fleet'); return { ok: true }
  },
  reset: async () => { durable = null; writes.push('reset'); return { ok: true } },
  probe: async () => ({ ok: false, error: { message: 'No network in this fixture' } }),
}
globalThis.mcFleetProfile = bridge

const classList = () => ({
  add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false,
})

function node() {
  return {
    dataset: {}, value: '', checked: false, textContent: '', hidden: false,
    children: [], appendChild(child) { this.children.push(child); return child },
    classList: classList(),
    style: { setProperty: () => {}, getPropertyValue: () => '' },
    handlers: new Map(),
    addEventListener(type, handler) {
      const group = this.handlers.get(type) || new Set(); group.add(handler); this.handlers.set(type, group)
    },
    removeEventListener(type, handler) { this.handlers.get(type)?.delete(handler) },
    setAttribute: () => {}, removeAttribute: () => {}, toggleAttribute: () => {},
    getAttribute: () => null, querySelector: () => node(), querySelectorAll: () => [],
    closest: () => null, contains: () => true,
    getBoundingClientRect: () => ({ top: 0 }), getClientRects: () => [{ top: 0 }], scrollIntoView: () => {}, focus: () => {},
  }
}

const sections = node()
Object.defineProperty(sections, 'innerHTML', {
  get: () => painted,
  set: value => { painted = String(value) },
})

const rail = node(), footer = node()

const save = node(), discard = node(), draftStatus = node(), searchInput = node()
const auditPanel = node(), auditControls = new Map()
auditPanel.querySelector = selector => {
  if (!auditControls.has(selector)) auditControls.set(selector, node())
  return auditControls.get(selector)
}
let expertDialog = null
const workingProfile = node(), workingProfileControls = new Map()
workingProfile.querySelector = selector => {
  if (!workingProfileControls.has(selector)) workingProfileControls.set(selector, node())
  return workingProfileControls.get(selector)
}
const root = node()
root.querySelector = selector => {
  if (selector === '[data-working-profile]') return workingProfile
  if (selector === '[data-audit-settings]') return painted.includes('data-audit-settings') ? auditPanel : null
  if (selector === '[data-setup-profile-system]') return painted.includes('data-setup-profile-system') ? node() : null
  if (selector === '.settings-search input') return searchInput
  if (selector === '[data-settings-save]') return save
  if (selector === '[data-settings-discard]') return discard
  if (selector === '[data-settings-draft-status]') return draftStatus
  if (selector === '.settings-sections') return sections
  if (selector === '.settings-rail') return rail
  if (selector === '.settings-footer') return footer
  return node()
}

globalThis.document = {
  createElement: tag => {
    if (tag === 'dialog') {
      const controls = new Map()
      expertDialog = { ...node(), markup: '',
        set innerHTML(value) { this.markup = String(value) },
        querySelector: selector => {
          if (!controls.has(selector)) controls.set(selector, node())
          return controls.get(selector)
        },
        showModal: () => {}, close: () => {}, remove: () => {},
      }
      return expertDialog
    }
    return {
      set innerHTML(value) { this.markup = String(value) },
      content: { firstElementChild: root },
    }
  },
  documentElement: node(), body: { ...node(), appendChild: () => {} }, getElementById: () => null, querySelector: () => node(), querySelectorAll: () => [],
}
globalThis.localStorage = {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => {
    if (refuseTheme && key === 'mc.theme') throw Error('Owned later preference refusal')
    stored.set(key, String(value))
  },
  removeItem: key => { stored.delete(key) },
}
globalThis.location = { hash: '#/settings', reload: () => { reloads += 1 } }
globalThis.window = {
  location: globalThis.location, confirm: () => confirmLeave,
  addEventListener: (type, listener) => {
    const group = listeners.get(type) || new Set()
    group.add(listener)
    listeners.set(type, group)
  },
  removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
  dispatchEvent: event => {
    for (const listener of listeners.get(event.type) || []) listener(event)
    return true
  },
  matchMedia: () => ({ matches: false }),
}
globalThis.CustomEvent = class CustomEvent {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail }
}
globalThis.requestAnimationFrame = callback => { callback(); return 1 }
globalThis.cancelAnimationFrame = () => {}

const { setBridgeTransport } = await import('../../src/mission-bridge.js')
setBridgeTransport(async () => ({ ok: false, reason: 'No host in this fixture' }))
const { settingsView } = await import('../../src/views/settings.js')
const fire = async (element, type, event = {}) => {
  for (const handler of element.handlers.get(type) || []) await handler(event)
}
function open({ settingsShell } = {}) {
  window.mcSettings = settingsShell
  document.documentElement.dataset.theme = 'white'
  stored.clear(); painted = ''; refuseTheme = false; refuseFleet = false
  confirmLeave = false; reloads = 0; writes = []; navigated = []
  durable = structuredClone(profile)
  for (const element of [root, sections, save, discard]) element.handlers.clear()
  const view = settingsView({ query: new URLSearchParams('category=system'), navigate: hash => navigated.push(hash) })
  return view
}
async function fleetEdit() {
  const input = { dataset: { profileField: 'label' }, value: 'Confirmed fixture fleet' }
  await fire(root, 'input', { target: { closest: selector => selector === '[data-profile-field]' ? input : null } })
}
async function laterPreference(view) {
  view.beforeLeave({ name: 'settings', query: new URLSearchParams('category=appearance') })
  const button = { dataset: { settingValue: 'cobalt' }, closest: () => ({ dataset: { settingId: 'theme' } }) }
  await fire(sections, 'click', { target: { closest: selector => selector === 'button[data-setting-value]' ? button : null } })
  refuseTheme = true
}
async function partialSave(view) {
  await fleetEdit()
  await laterPreference(view)
  await fire(save, 'click')
  assert.equal(durable.label, 'Confirmed fixture fleet')
  assert.deepEqual(writes, ['fleet'])
  assert.match(draftStatus.textContent, /^Some changes were saved before Save stopped\./)
  assert.match(draftStatus.textContent, /Unsaved changes remain\. Retry saves only the remaining changes\./)
  assert.match(draftStatus.textContent, /The interrupted save step reported: “Owned later preference refusal”/)
  assert.doesNotMatch(draftStatus.textContent, /No changes were confirmed saved/)
  assert.equal(root.dataset.settingsDirty, 'true')
  assert.equal(reloads, 0, 'failed suffix must leave the unsaved draft open')
}

test('discard after a partial fleet save reloads the confirmed profile instead of recreating its old snapshot', async () => {
  const view = open()
  try {
    await partialSave(view)
    await fire(discard, 'click')
    assert.equal(reloads, 1, 'the confirmed fleet write still requires a reload after the remaining draft is discarded')
    assert.deepEqual(navigated, [], 'a local view rebuild would reopen the old module-frozen profile')
    assert.equal(root.dataset.settingsDirty, 'false')
    assert.equal(durable.label, 'Confirmed fixture fleet')
  } finally { view.destroy() }
})

test('a refused leave after a partial save preserves the pending draft and does not reload', async () => {
  const view = open()
  try {
    await partialSave(view)
    assert.equal(view.beforeLeave({ name: 'home' }), false)
    assert.equal(reloads, 0)
    assert.equal(root.dataset.settingsDirty, 'true')
    assert.equal(durable.label, 'Confirmed fixture fleet')
  } finally { view.destroy() }
})

test('an accepted leave after a partial save reloads without mounting a successor from old profile state', async () => {
  const view = open()
  try {
    await partialSave(view)
    confirmLeave = true
    location.hash = '#/'
    assert.equal(view.beforeLeave({ name: 'home' }), 'updated', 'the pending document reload owns this transition')
    assert.equal(reloads, 1)
    assert.equal(location.hash, '#/', 'the selected destination must survive the reload')
    assert.equal(root.dataset.settingsDirty, 'false', 'the confirmed discard must not trigger another unload prompt')
  } finally { view.destroy() }
})

test('moving between Settings categories after a partial save retains the same draft without a reload', async () => {
  const view = open()
  try {
    await partialSave(view)
    assert.equal(view.beforeLeave({ name: 'settings', query: new URLSearchParams('category=system') }), 'updated')
    assert.equal(reloads, 0)
    assert.equal(root.dataset.settingsDirty, 'true')
  } finally { view.destroy() }
})

test('a refused fleet write never creates a reload obligation or claims that profile saved', async () => {
  const view = open()
  try {
    await fleetEdit(); refuseFleet = true
    await laterPreference(view)
    await fire(save, 'click')
    assert.equal(durable.label, 'Original fixture fleet')
    assert.deepEqual(writes, [])
    assert.equal(root.dataset.settingsDirty, 'true')
    await fire(discard, 'click')
    assert.equal(reloads, 0)
    assert.equal(navigated.length, 1)
  } finally { view.destroy() }
})

test('discard after a confirmed reset reloads its tombstone rather than reopening the removed profile', async () => {
  const view = open()
  try {
    const button = { dataset: { profileAction: 'reset' } }
    const event = { target: { closest: selector => selector === '[data-profile-action]' ? button : null } }
    await fire(root, 'click', event); await fire(root, 'click', event)
    await laterPreference(view)
    await fire(save, 'click')
    assert.equal(durable, null)
    assert.deepEqual(writes, ['reset'])
    assert.equal(root.dataset.settingsDirty, 'true')
    await fire(discard, 'click')
    assert.equal(reloads, 1)
    assert.deepEqual(navigated, [])
    assert.equal(durable, null)
  } finally { view.destroy() }
})


// Post-save readback is asynchronous on the real bridge and can include local
// model discovery. It must not let the earlier Save own a successor draft.
const tick = () => new Promise(resolve => setImmediate(resolve))
function heldSettingsReadback() {
  let paused = false, readsBeforeHold = 0
  const reads = []
  const answer = { ok: true, available: false, rows: [] }
  return {
    shell: { read: () => {
      if (!paused) return Promise.resolve(answer)
      if (readsBeforeHold > 0) { readsBeforeHold -= 1; return Promise.resolve(answer) }
      return new Promise(resolve => reads.push(resolve))
    }, set: async () => ({ ok: true }) },
    hold({ skip = 0 } = {}) { paused = true; readsBeforeHold = skip },
    get pending() { return reads.length },
    release(index = 0) {
      assert.ok(reads[index], 'the ordinary Settings readback is pending')
      // A released Save may now perform an additional complete-profile read.
      // Hold only the reads already selected by this fixture gesture.
      paused = false; reads.splice(index, 1)[0](answer)
    },
    close() { paused = false; for (const resolve of reads.splice(0)) resolve(answer) },
  }
}
async function editTheme(view, value) {
  assert.equal(view.beforeLeave({ name: 'settings', query: new URLSearchParams('category=appearance') }), 'updated')
  const button = { dataset: { settingValue: value }, closest: () => ({ dataset: { settingId: 'theme' } }) }
  await fire(sections, 'click', { target: { closest: selector => selector === 'button[data-setting-value]' ? button : null } })
}

test('late Save readback preserves the status of a newer unsaved choice', async () => {
  const readback = heldSettingsReadback(), view = open({ settingsShell: readback.shell })
  let saving
  try {
    await tick(); await editTheme(view, 'cobalt')
    readback.hold(); saving = fire(save, 'click'); await tick()
    assert.equal(readback.pending, 1)
    assert.equal(sections.inert, false, 'completed writes release editing while readback is pending')
    await editTheme(view, 'ember')
    assert.match(draftStatus.textContent, /unsaved/i)
    readback.release(); await saving
    assert.equal(root.dataset.settingsDirty, 'true')
    assert.equal(save.disabled, false)
    assert.equal(stored.get('mc.theme'), 'cobalt')
    assert.match(draftStatus.textContent, /unsaved/i, 'an older Save cannot confirm the current unsaved choice')
  } finally { readback.close(); await saving; view.destroy() }
})

test('late earlier Save cannot replace a newer refused-save message', async () => {
  const readback = heldSettingsReadback(), view = open({ settingsShell: readback.shell })
  let earlier, newer
  try {
    await tick(); await editTheme(view, 'cobalt')
    readback.hold(); earlier = fire(save, 'click'); await tick()
    await editTheme(view, 'ember'); refuseTheme = true
    newer = fire(save, 'click'); await tick()
    assert.equal(readback.pending, 2)
    readback.release(1); await newer
    assert.match(draftStatus.textContent, /Owned later preference refusal/)
    readback.release(); await earlier
    assert.equal(root.dataset.settingsDirty, 'true')
    assert.equal(stored.get('mc.theme'), 'cobalt')
    assert.match(draftStatus.textContent, /Owned later preference refusal/, 'the older completion cannot erase the newer refusal')
  } finally { readback.close(); await earlier; await newer; view.destroy() }
})

test('late refused Save cannot replace a newer confirmed-save message', async () => {
  const readback = heldSettingsReadback(), view = open({ settingsShell: readback.shell })
  let earlier, newer
  try {
    await tick(); await editTheme(view, 'cobalt'); refuseTheme = true
    readback.hold(); earlier = fire(save, 'click'); await tick()
    await editTheme(view, 'ember'); refuseTheme = false
    newer = fire(save, 'click'); await tick()
    assert.equal(readback.pending, 2)
    readback.release(1); await newer
    assert.equal(draftStatus.textContent, 'Settings saved.')
    readback.release(); await earlier
    assert.equal(root.dataset.settingsDirty, 'false')
    assert.equal(stored.get('mc.theme'), 'ember')
    assert.equal(draftStatus.textContent, 'Settings saved.', 'the older refusal cannot replace the newer confirmation')
  } finally { readback.close(); await earlier; await newer; view.destroy() }
})

test('a retired Settings view cannot reload the document after its profile Save readback finishes', async () => {
  const readback = heldSettingsReadback(), view = open({ settingsShell: readback.shell })
  let saving
  try {
    await tick(); await fleetEdit()
    readback.hold(); saving = fire(save, 'click'); await tick()
    assert.equal(readback.pending, 1)
    assert.equal(durable.label, 'Confirmed fixture fleet')
    view.destroy()
    readback.release(); await saving
    assert.equal(reloads, 0, 'only the current mounted view may request its document reload')
  } finally { readback.close(); await saving; view.destroy() }
})

test('a Save with no successor change retains its ordinary confirmation', async () => {
  const readback = heldSettingsReadback(), view = open({ settingsShell: readback.shell })
  let saving
  try {
    await tick(); await editTheme(view, 'cobalt')
    readback.hold(); saving = fire(save, 'click'); await tick()
    readback.release(); await saving
    assert.equal(draftStatus.textContent, 'Settings saved.')
    assert.equal(root.dataset.settingsDirty, 'false')
    assert.equal(stored.get('mc.theme'), 'cobalt')
  } finally { readback.close(); await saving; view.destroy() }
})

// DEV20 adds a second awaited readback for the complete working profile.
// Let the research read finish, then hold the actual profile controller's
// product-policy reads. Ordinary edits and Save clicks remain available.
async function holdWorkingProfileSave(readback) {
  readback.hold({ skip: 1 })
  const saving = fire(save, 'click')
  await tick()
  assert.ok(readback.pending > 0, 'the complete-profile policy read is pending')
  assert.equal(workingProfile.querySelector('[data-working-profile-current]').textContent, 'Reading saved profile…')
  assert.equal(sections.inert, false, 'the completed write has released editing')
  return { saving }
}

test('late complete-profile readback preserves a successor unsaved draft', async () => {
  const readback = heldSettingsReadback(), view = open({ settingsShell: readback.shell })
  let saving
  try {
    await tick(); await editTheme(view, 'cobalt')
    ;({ saving } = await holdWorkingProfileSave(readback))
    await editTheme(view, 'ember')
    readback.close(); await saving
    assert.equal(root.dataset.settingsDirty, 'true')
    assert.equal(stored.get('mc.theme'), 'cobalt')
    assert.match(draftStatus.textContent, /unsaved/i, 'the older complete-profile read cannot confirm the new draft')
  } finally { readback.close(); await saving; view.destroy() }
})

for (const olderRefused of [false, true]) test(`late complete-profile read cannot replace a newer ${olderRefused ? 'confirmed' : 'refused'} Save`, async () => {
  const readback = heldSettingsReadback(), view = open({ settingsShell: readback.shell })
  let earlier, newer
  try {
    await tick(); await editTheme(view, 'cobalt'); refuseTheme = olderRefused
    ;({ saving: earlier } = await holdWorkingProfileSave(readback))
    const olderReads = readback.pending
    await editTheme(view, 'ember'); refuseTheme = !olderRefused
    newer = fire(save, 'click'); await tick()
    assert.equal(readback.pending, olderReads + 1, 'the newer Save reaches its own research readback')
    readback.release(olderReads); await tick()
    // Setup may share one policy read between the profile refreshes. Resolve
    // those shared reads while retaining the older profile's own first read.
    while (readback.pending > 1) readback.release(1)
    await newer
    const currentMessage = draftStatus.textContent
    if (olderRefused) assert.equal(currentMessage, 'Settings saved.')
    else assert.match(currentMessage, /Owned later preference refusal/)
    readback.close(); await earlier
    assert.equal(draftStatus.textContent, currentMessage, 'only the newer Save owns its outcome')
    assert.equal(root.dataset.settingsDirty, String(!olderRefused))
    assert.equal(stored.get('mc.theme'), olderRefused ? 'ember' : 'cobalt')
  } finally { readback.close(); await earlier; await newer; view.destroy() }
})

test('late complete-profile read defers a confirmed fleet reload until the successor draft is explicitly discarded', async () => {
  const readback = heldSettingsReadback(), view = open({ settingsShell: readback.shell })
  let saving
  try {
    await tick(); await fleetEdit()
    ;({ saving } = await holdWorkingProfileSave(readback))
    assert.equal(durable.label, 'Confirmed fixture fleet')
    await editTheme(view, 'ember')
    readback.close(); await saving
    assert.equal(reloads, 0, 'a previous profile Save cannot reload over an unsaved successor')
    assert.equal(root.dataset.settingsDirty, 'true')
    await fire(discard, 'click')
    assert.equal(reloads, 1, 'current Discard retains the confirmed profile reload obligation')
    assert.equal(durable.label, 'Confirmed fixture fleet')
  } finally { readback.close(); await saving; view.destroy() }
})

test('a retired view cannot reload after the complete-profile read finishes', async () => {
  const readback = heldSettingsReadback(), view = open({ settingsShell: readback.shell })
  let saving
  try {
    await tick(); await fleetEdit()
    ;({ saving } = await holdWorkingProfileSave(readback))
    view.destroy()
    readback.close(); await saving
    assert.equal(reloads, 0, 'a destroyed profile controller does not authorize its old Save to reload')
  } finally { readback.close(); await saving; view.destroy() }
})

test('a complete-profile read without a successor preserves ordinary Save confirmation', async () => {
  const readback = heldSettingsReadback(), view = open({ settingsShell: readback.shell })
  let saving
  try {
    await tick(); await editTheme(view, 'cobalt')
    ;({ saving } = await holdWorkingProfileSave(readback))
    readback.close(); await saving
    assert.equal(draftStatus.textContent, 'Settings saved.')
    assert.equal(root.dataset.settingsDirty, 'false')
    assert.equal(stored.get('mc.theme'), 'cobalt')
  } finally { readback.close(); await saving; view.destroy() }
})


// An inert pending audit challenge exercises actual controller admission/busy
// callbacks. No rotation callback, signing identity, file or native effect runs.
async function maintenanceSaveScenario({ phase = 'research', settled = false } = {}) {
  const readback = heldSettingsReadback()
  let releaseChallenge, challengeRequests = 0, rotations = 0
  const challenge = new Promise(resolve => { releaseChallenge = resolve })
  const shell = { ...readback.shell,
    auditProbe: async () => ({ ok: true, canRotate: true }),
    auditConfirmation: async ({ operation }) => {
      assert.equal(operation, 'rotate')
      challengeRequests += 1
      return challenge
    },
    auditRotate: async () => { rotations += 1; return { ok: false, reason: 'No maintenance effects in this fixture.' } },
  }
  const view = open({ settingsShell: shell })
  let saving, maintaining
  try {
    await tick()
    // Enter through the real display-mode confirmation, using its own shown
    // fixture code. This does not grant any policy or maintenance authority.
    const modeButton = { dataset: { settingsModeChoice: 'expert' }, closest: () => null }
    await fire(root, 'click', { target: { closest: selector => selector === '[data-settings-mode-choice], [data-settings-show-mode]' ? modeButton : null } })
    const code = expertDialog?.markup.match(/<strong>([0-9]{4})<\/strong>/)?.[1]
    assert.ok(code, 'the actual Expert gate displayed its confirmation code')
    expertDialog.querySelector('input').value = code
    await fire(expertDialog.querySelector('form'), 'submit', { preventDefault() {} })
    assert.equal(root.dataset.settingsMode, 'expert')

    await fleetEdit()
    readback.hold({ skip: phase === 'working-profile' ? 1 : 0 })
    saving = fire(save, 'click')
    await tick()
    if (phase === 'working-profile') {
      assert.ok(readback.pending > 0)
      assert.equal(workingProfile.querySelector('[data-working-profile-current]').textContent, 'Reading saved profile…')
    } else assert.equal(readback.pending, 1)
    assert.equal(durable.label, 'Confirmed fixture fleet')
    assert.equal(root.dataset.settingsDirty, 'false')
    assert.equal(reloads, 0)

    assert.equal(view.beforeLeave({ name: 'settings', query: new URLSearchParams('category=data-privacy') }), 'updated')
    await tick()
    const auditButton = { dataset: { auditAction: 'rotate' }, disabled: false }
    maintaining = fire(root, 'click', { target: { closest: selector => selector === '[data-audit-action]' ? auditButton : null } })
    await tick()
    assert.equal(challengeRequests, 1, 'the actual audit controller reached only its inert pending challenge')
    assert.equal(rotations, 0)
    const maintenanceStatus = draftStatus.textContent
    assert.equal(maintenanceStatus, 'Complete the audit operation before changing settings.')
    assert.equal(root.dataset.settingsSaveState, 'busy')
    assert.equal(view.beforeLeave({ name: 'home' }), false)

    if (settled) {
      releaseChallenge({ ok: false, reason: 'Owned inert maintenance confirmation refused.' })
      await maintaining
      assert.equal(root.dataset.settingsSaveState, 'saved', 'the inert maintenance interval has ended')
      assert.match(auditPanel.querySelector('[data-audit-body]').innerHTML, /Owned inert maintenance confirmation refused/)
      assert.equal(rotations, 0, 'the refused challenge never reaches rotation')
    }
    const currentStatus = draftStatus.textContent
    while (readback.pending) readback.release()
    await saving
    assert.equal(rotations, 0, 'no audit rotation callback ran')
    let unloadPrevented = false
    const unload = { type: 'beforeunload', preventDefault: () => { unloadPrevented = true } }
    const afterReadback = { status: draftStatus.textContent, reloadRequests: reloads }
    window.dispatchEvent(unload)
    assert.equal(unloadPrevented, !settled, 'the separate unload guard follows actual maintenance busy state')
    if (!settled) assert.equal(unload.returnValue, '')
    assert.deepEqual(afterReadback, { status: currentStatus, reloadRequests: 0 },
      'a maintenance interval permanently supersedes the older Save completion')
    if (settled) {
      location.hash = '#/'
      assert.equal(view.beforeLeave({ name: 'home' }), 'updated')
      assert.equal(reloads, 1, 'a new explicit leave still owns the committed profile reload')
    }
  } finally {
    view.destroy()
    readback.close()
    releaseChallenge({ ok: false, reason: 'The inert fixture challenge was closed.' })
    await saving
    await maintaining
    assert.equal(rotations, 0)
  }

}

test('audit maintenance owns status and reload admission after an earlier Save enters readback', () => maintenanceSaveScenario())
test('complete-profile readback respects a pending audit maintenance operation', () => maintenanceSaveScenario({ phase: 'working-profile' }))
test('refused inert maintenance still retires an earlier Save readback', () => maintenanceSaveScenario({ settled: true }))
