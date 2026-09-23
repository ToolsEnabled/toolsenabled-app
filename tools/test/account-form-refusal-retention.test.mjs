/*
 * Mounted account and first-run account paths.
 *
 * These fixtures install the actual accountView/setupView entry points, then
 * expose only the DOM/bridge seams those views use. The controls are dispatched
 * through each view's own listeners. No source implementation is copied into
 * the assertions: outcomes are observed in rendered markup, field values and
 * bridge calls.
 *
 * Static baseline evidence:
 * - outside-lane hunt-accounts p3-firstrun-account.mjs observed setup usernameAfter=""
 *   after refusal; out/fa-result.json SHA-256
 *   8d71b8d983677e7c6402c60f69d972dbea29788270a3d4c52ebe30635143a416.
 * - out/ap-result.json SHA-256
 *   6060c064a197031d24f26a45bdc3049b2bcb7ac15ac13445fb4d21d4041680c3;
 *   its short-password and email-in-create paths observed empty account fields
 *   and the character-rule refusal.
 *
 * This file is authoring only in T1305. No RED/GREEN or rig result is claimed
 * until the parent admits the focused suite.
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import test, { after } from 'node:test'
import { setBridgeTransport } from '../../src/mission-bridge.js'
import { currentDataSource, resolveDataSource } from '../../src/data-source.js'

register('./helpers/css-stub-loader.mjs', import.meta.url)

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function settle(rounds = 24) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

function fixtureStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
  }
}

function fieldNode(liveFields, name, getAttributeExtra = () => null, typeValue = name === 'password' ? 'password' : 'text') {
  return {
    name,
    get type() { return typeValue },
    get value() { return liveFields[name] ?? '' },
    set value(value) { liveFields[name] = String(value) },
    getAttribute(attribute) {
      if (attribute === 'name') return name
      if (attribute === 'type') return typeValue
      return getAttributeExtra(attribute)
    },
    getAttributeNames() { return ['name', 'type'] },
    setAttribute() {},
    focus() {},
    setSelectionRange() {},
    classList: { contains: () => false },
    tagName: 'INPUT',
    selectionStart: null,
    selectionEnd: null,
  }
}

function selectorAttribute(selector) {
  const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector.trim())
  return match ? { name: match[1], value: match[2] } : null
}

function selectorMatches(candidate, selected) {
  const candidateAttribute = selectorAttribute(candidate)
  const selectedAttribute = selectorAttribute(selected)
  return Boolean(candidateAttribute && selectedAttribute
    && candidateAttribute.name === selectedAttribute.name
    && (candidateAttribute.value === undefined || candidateAttribute.value === selectedAttribute.value))
}

function renderedDataset(markup, selector) {
  const attribute = selectorAttribute(selector)
  assert.ok(attribute, 'dispatch selector must name a rendered data attribute')
  const escapedValue = attribute.value === undefined
    ? ''
    : attribute.value.replace(/[.*+?^{}()|[\]\\]/g, '\\$&')
  const expression = attribute.value === undefined
    ? new RegExp(attribute.name + '(?:="([^"]*)")?')
    : new RegExp(attribute.name + '="' + escapedValue + '"')
  const match = expression.exec(markup)
  assert.ok(match, 'dispatch selector must match a rendered control')
  const key = attribute.name.replace(/^data-/, '').replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())
  return { [key]: match[1] ?? attribute.value ?? '' }
}

function accountDocument(fields = {}, { resetFieldsOnPaint = true } = {}) {
  let markup = ''
  let paints = 0
  let focusedName = null
  const liveFields = { username: '', displayName: '', password: '', ...fields }
  const listeners = new Map()
  let forms = []

  function attribute(attrs, name) {
    const match = new RegExp(name + '="([^"]*)"').exec(attrs)
    return match ? match[1] : null
  }

  function parseForms() {
    forms = []
    const formPattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi
    let formMatch
    while ((formMatch = formPattern.exec(markup))) {
      const attrs = formMatch[1]
      const kind = attribute(attrs, 'data-account-form')
      if (!kind) continue
      const controls = []
      const inputPattern = /<input\b([^>]*)>/gi
      let inputMatch
      while ((inputMatch = inputPattern.exec(formMatch[2]))) {
        const inputAttrs = inputMatch[1]
        const name = attribute(inputAttrs, 'name')
        if (!name) continue
        const initial = attribute(inputAttrs, 'value') || ''
        const type = attribute(inputAttrs, 'type') || undefined
        liveFields[name] = initial
        controls.push(fieldNode(liveFields, name, () => null, type))
      }
      forms.push({
        dataset: { accountForm: kind },
        controls,
        querySelector(selector) {
          const match = /^(?:input)?\[name="([^"]+)"\]$/.exec(selector)
          return match ? controls.find(field => field.name === match[1]) || null : null
        },
        querySelectorAll(selector) {
          if (selector === 'input[name="username"], input[name="displayName"]') {
            return controls.filter(field => field.name === 'username' || field.name === 'displayName')
          }
          if (selector === 'input[type="password"]') return controls.filter(field => field.type === 'password')
          if (selector === 'input') return controls
          return []
        },
      })
    }
  }

  function formFor(kind) {
    return forms.find(form => form.dataset.accountForm === kind) || null
  }

  function fieldFor(name) {
    for (const form of forms) {
      const field = form.controls.find(control => control.name === name)
      if (field) return field
    }
    return null
  }

  function controlExists(selector) {
    return selector.split(',').some(part => {
      const trimmed = part.trim()
      const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(trimmed)
      if (!match) return false
      const [, name, value] = match
      if (value === undefined) return markup.includes(name)
      return new RegExp(name + '="' + value.replace(/[.*+?^{}()|[\]\\]/g, '\\$&') + '"').test(markup)
    })
  }

  const section = {
    get innerHTML() { return markup },
    set innerHTML(value) {
      markup = String(value)
      paints += 1
      if (resetFieldsOnPaint) {
        for (const name of Object.keys(liveFields)) liveFields[name] = ''
      }
      parseForms()
      focusedName = null
    },
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
    querySelector(selector) {
      const formMatch = /^form\[data-account-form="([^"]+)"\]$/.exec(selector)
      if (formMatch) return formFor(formMatch[1])
      if (selector === 'form[data-account-form]') return forms[0] || null
      if (selector === 'form[data-account-form="create"], form[data-account-form="sign-in"]') {
        return formFor('create') || formFor('sign-in')
      }
      if (selector === '[data-account-form]:focus-within') {
        const focused = fieldFor(focusedName)
        return focused ? forms.find(form => form.controls.includes(focused)) || null : null
      }
      const fieldMatch = /^\[name="([^"]+)"\]$/.exec(selector)
      if (fieldMatch) return fieldFor(fieldMatch[1])
      /* Two reset controls a focus can be moved to. Present only when the
         rendered markup carries them; focusing one records which. */
      if ((selector === '[data-reset-focus]' || selector === '[data-reset-plan]') && controlExists(selector)) {
        const target = { selector, focus() { document.activeElement = target } }
        return target
      }
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-account-form] input') return forms.flatMap(form => form.controls)
      if (selector === '[data-account-form]') return forms
      if (selector === 'input[type="password"]') {
        return forms.flatMap(form => form.controls).filter(field => field.type === 'password')
      }
      return []
    },
  }

  const root = {
    querySelector(selector) {
      return selector === '[data-account-section]' ? section : null
    },
    scrollTo() {},
  }
  const document = {
    activeElement: null,
    createElement(tag) {
      assert.equal(tag, 'template', 'accountView/setupView must build their root through a template')
      return {
        set innerHTML(_value) {},
        content: { firstElementChild: root },
      }
    },
  }

  return {
    document,
    section,
    markup: () => markup,
    paintCount: () => paints,
    fieldValue(name) {
      const field = fieldFor(name)
      return field ? field.value : ''
    },
    type(name, value) {
      const field = fieldFor(name)
      assert.ok(field, 'cannot type into an account control absent from the rendered form')
      field.value = String(value)
      focusedName = name
    },
    focus(name) {
      const field = fieldFor(name)
      assert.ok(field, 'cannot focus an account control absent from the rendered form')
      focusedName = name
    },
    submit(kind) {
      const listener = listeners.get('submit')
      assert.ok(listener, 'the actual account form must be submit-listenable')
      const form = formFor(kind)
      assert.ok(form, 'cannot submit an account form absent from the rendered markup')
      listener({
        target: { closest: selector => selector === '[data-account-form]' ? form : null },
        preventDefault() {},
      })
    },
    press(selector, dataset = {}) {
      const listener = listeners.get('click')
      assert.ok(listener, 'the actual account view must listen for clicks')
      assert.ok(controlExists(selector), 'cannot dispatch a control absent from the rendered account markup')
      const actualDataset = renderedDataset(markup, selector)
      for (const [key, value] of Object.entries(dataset)) {
        assert.equal(actualDataset[key], value, 'dispatch metadata must match the rendered account control')
      }
      listener({
        target: {
          closest(candidate) {
            return selectorMatches(candidate, selector) ? { dataset: actualDataset } : null
          },
        },
        preventDefault() {},
      })
    },
    restoreFields() {
      for (const name of Object.keys(liveFields)) liveFields[name] = ''
    },
  }
}

function setupDocument(fields = {}, { resetFieldsOnPaint = true } = {}) {
  let markup = ''
  let paints = 0
  const liveFields = { username: '', displayName: '', password: '', ...fields }
  const listeners = new Map()
  let controls = []

  function attribute(attrs, name) {
    const match = new RegExp(name + '="([^"]*)"').exec(attrs)
    return match ? match[1] : null
  }

  function parseControls() {
    controls = []
    const inputPattern = /<input\b([^>]*)>/gi
    let inputMatch
    while ((inputMatch = inputPattern.exec(markup))) {
      const attrs = inputMatch[1]
      const name = attribute(attrs, 'data-setup-account-field')
      if (!name) continue
      const initial = attribute(attrs, 'value') || ''
      const type = attribute(attrs, 'type') || undefined
      liveFields[name] = initial
      controls.push(fieldNode(
        liveFields,
        name,
        attributeName => attributeName === 'data-setup-account-field' ? name : null,
        type,
      ))
    }
  }

  function controlExists(selector) {
    return selector.split(',').some(part => {
      const trimmed = part.trim()
      const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(trimmed)
      if (!match) return false
      const [, name, value] = match
      if (value === undefined) return markup.includes(name)
      return new RegExp(name + '="' + value.replace(/[.*+?^{}()|[\]\\]/g, '\\$&') + '"').test(markup)
    })
  }

  const section = {
    get innerHTML() { return markup },
    set innerHTML(value) {
      markup = String(value)
      paints += 1
      if (resetFieldsOnPaint) {
        for (const name of Object.keys(liveFields)) liveFields[name] = ''
      }
      parseControls()
    },
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
    contains() { return false },
    querySelector(selector) {
      const fieldMatch = /^\[data-setup-account-field="([^"]+)"\]$/.exec(selector)
      if (fieldMatch) return controls.find(field => field.name === fieldMatch[1]) || null
      if (selector === '[data-setup-sandbox]') return null
      if (selector === '.setup-title' && markup.includes('setup-title')) return {
        setAttribute() {},
        focus() {},
        classList: { contains: () => false },
      }
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-setup-account-field]') return controls
      if (selector === '[data-setup-details]') return []
      return []
    },
  }

  const root = {
    querySelector: selector => selector === '[data-setup-section]' ? section : null,
    scrollTo() {},
  }
  const document = {
    activeElement: null,
    createElement(tag) {
      assert.equal(tag, 'template', 'setupView must build its root through a template')
      return { set innerHTML(_value) {}, content: { firstElementChild: root } }
    },
  }

  function datasetFor(selector, supplied) {
    if (selector === '[data-setup-account-submit]') {
      return { setupAccountSubmit: supplied.setupAccountSubmit || 'create' }
    }
    if (selector === '[data-setup-account-mode]') {
      return { setupAccountMode: supplied.setupAccountMode || 'sign-in' }
    }
    if (selector === '[data-setup-tier]') {
      return { setupTier: supplied.setupTier || 'standard' }
    }
    if (selector === '[data-setup-next]') {
      return { setupNext: supplied.setupNext || 'account' }
    }
    return supplied
  }

  return {
    document,
    markup: () => markup,
    paintCount: () => paints,
    fieldValue(name) {
      const field = controls.find(control => control.name === name)
      return field ? field.value : ''
    },
    type(name, value) {
      const field = controls.find(control => control.name === name)
      assert.ok(field, 'cannot type into a setup control absent from the rendered account step')
      field.value = String(value)
    },
    pressEnter(name) {
      const listener = listeners.get('keydown')
      assert.ok(listener, 'the actual setup view must listen for keys')
      const field = controls.find(control => control.name === name)
      assert.ok(field, 'cannot press Enter in a setup control absent from the rendered account step')
      let prevented = false
      listener({
        key: 'Enter',
        target: { closest: candidate => candidate === '[data-setup-account-field]' ? field : null },
        preventDefault() { prevented = true },
      })
      return prevented
    },
    click(selector, supplied = {}) {
      const listener = listeners.get('click')
      assert.ok(listener, 'the actual setup view must listen for clicks')
      assert.ok(controlExists(selector), 'cannot dispatch a control absent from the rendered setup markup')
      const dataset = datasetFor(selector, supplied)
      /* The dispatched metadata must be what a rendered control carries, so a
         click can never name a submit kind or mode the screen does not show. */
      for (const [key, value] of Object.entries(dataset)) {
        const attribute = 'data-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())
        assert.ok(controlExists(`[${attribute}="${value}"]`), `no rendered setup control carries ${attribute}="${value}"`)
      }
      listener({
        target: {
          closest(candidate) {
            if (candidate === '[aria-disabled="true"]') return null
            if (candidate.includes('data-setup-account-submit') && selector === '[data-setup-account-submit]') {
              return { dataset }
            }
            if (candidate.includes('data-setup-account-mode') && selector === '[data-setup-account-mode]') {
              return { dataset }
            }
            if (candidate.includes('data-setup-tier') && selector === '[data-setup-tier]') {
              return { dataset }
            }
            if (candidate.includes('data-setup-next') && selector === '[data-setup-next]') {
              return { dataset }
            }
            if (candidate === selector) return { dataset }
            return null
          },
        },
        preventDefault() {},
      })
    },
  }
}

function accountFixture({
  accountCount = 1,
  signedIn = false,
  username = 'fixture-user',
  displayName = 'Fixture User',
  googleAvailability = async () => ({ ok: false, reason: 'Google unavailable in this fixture.' }),
  create = async () => ({ ok: false, code: 'FIXTURE_REFUSED', reason: 'The fixture refused account creation.' }),
  signIn = async () => ({ ok: false, code: 'FIXTURE_REFUSED', reason: 'The fixture refused sign-in.' }),
  changeDisplayName = async () => ({ ok: false, reason: 'The fixture refused the name.' }),
  signOut = async () => ({ ok: true, localCleared: true, remoteEnded: true }),
  changePassword = async () => ({ ok: true }),
  data = async () => ({ ok: true, settingCount: 0 }),
  paymentPresence = async () => ({ ok: false, reason: 'No payment fixture is present.' }),
} = {}) {
  let current = signedIn ? {
    id: 'a'.repeat(32),
    username,
    displayName,
    signInMethod: 'local',
  } : null
  let count = accountCount
  const calls = { create: [], signIn: [], changeDisplayName: [], signOut: [], changePassword: [] }
  const bridge = {
    availability: async () => ({ ok: true, accountCount: count, canPersistSession: true }),
    current: async () => current
      ? { ok: true, signedIn: true, account: { ...current }, session: { expiresAtMs: 4102444800000 } }
      : { ok: true, signedIn: false },
    googleAvailability,
    create: async request => {
      calls.create.push(request)
      return create(request)
    },
    signIn: async request => {
      calls.signIn.push(request)
      const result = await signIn(request)
      if (result?.ok === true) {
        current = {
          id: 'b'.repeat(32),
          username: request.username,
          displayName: request.username,
          signInMethod: 'local',
        }
        count = Math.max(1, count)
      }
      return result
    },
    changeDisplayName: async request => {
      calls.changeDisplayName.push(request)
      const result = await changeDisplayName(request)
      if (result?.ok === true && current) current.displayName = request.displayName
      return result
    },
    changePassword: async request => {
      calls.changePassword.push(request)
      const result = await changePassword(request)
      if (result?.ok === true) current = null
      return result
    },
    signOut: async () => {
      calls.signOut.push({})
      const result = await signOut()
      if (result?.ok === true) current = null
      return result
    },
    data,
    paymentPresence,
  }
  return { bridge, calls, platform: () => globalThis.mcSetup?.platform }
}

function setupBridge(bridge, storage) {
  return {
    platform: 'win32',
    bootstrap: { ok: true, configured: true, tier: 'standard' },
    chooseTier: async () => ({ ok: true, tier: 'standard' }),
    workspaceState: async () => ({ ok: true, chosen: true, roots: [] }),
    saveWorkspace: async () => ({ ok: true }),
    localStorage: storage,
    ...bridge,
  }
}

function makeWindow(bridge, { relay = false } = {}) {
  const listeners = new Map()
  return {
    mcAccount: bridge,
    mcShell: relay
      ? { getBridgeTransport: () => ({}) }
      : { getBridgeProof: () => ({}) },
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type) { listeners.delete(type) },
  }
}

const initialStorage = fixtureStorage({
  'mc.setup.profile': JSON.stringify({
    schemaVersion: 1,
    status: 'in-progress',
    step: 'account',
    answers: { autonomy: 'autonomous', screens: 'live', workspaceRoots: [] },
    updatedAtMs: 1,
  }),
})
const initialSetup = {
  platform: 'win32',
  bootstrap: { ok: true, configured: true, tier: 'standard' },
  chooseTier: async () => ({ ok: true, tier: 'standard' }),
}
const initialWindow = makeWindow(null)
const priorSetupAtImport = globalThis.mcSetup
const priorWindowAtImport = globalThis.window
const priorStorageAtImport = globalThis.localStorage
globalThis.mcSetup = initialSetup
globalThis.window = initialWindow
globalThis.localStorage = initialStorage

const { accountView } = await import('../../src/views/account.js')

/* Setup keeps the walk of the page it is mounted in (setup.js `liveWalk`), so
   a mount after a successful sign-in in an earlier case would resume at the
   next step. Each case is a fresh first run, so each mount gets a fresh setup
   module, the way a fresh window loads it. */
let setupMounts = 0
async function freshSetupView() {
  setupMounts += 1
  return (await import(`../../src/views/setup.js?first-run-case=${setupMounts}`)).setupView
}

/* Put back exactly what a mount replaced: a key that did not exist is deleted,
   not left as undefined. Used by restore() and by a mount that throws, so a
   failed mount cannot leak its stand-ins into the next case. */
function restoreGlobals(prior) {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete globalThis[key]
    else globalThis[key] = value
  }
}

async function mountWith(prior, mount) {
  let view
  try {
    view = await mount()
    await settle()
  } catch (error) {
    try { view?.destroy() } finally { restoreGlobals(prior) }
    throw error
  }
  return view
}

async function driveAccount(bridge, fields = {}, localData = undefined, options = {}) {
  const prior = {
    document: globalThis.document,
    mcAccount: globalThis.mcAccount,
    mcLocalData: globalThis.mcLocalData,
    mcSetup: globalThis.mcSetup,
    window: globalThis.window,
    location: globalThis.location,
    localStorage: globalThis.localStorage,
    mcAgent: globalThis.mcAgent,
    mcDurableStorage: globalThis.mcDurableStorage,
  }
  const standIn = accountDocument(fields, options)
  const storage = fixtureStorage()
  globalThis.document = standIn.document
  globalThis.mcAccount = bridge
  globalThis.mcSetup = { ...initialSetup }
  globalThis.window = makeWindow(bridge, options)
  globalThis.location = undefined
  globalThis.localStorage = storage
  if (localData !== undefined) globalThis.mcLocalData = localData
  else delete globalThis.mcLocalData
  delete globalThis.mcAgent
  delete globalThis.mcDurableStorage
  const view = await mountWith(prior, () => accountView({ navigate: () => {} }))
  return {
    ...standIn,
    view,
    restore() {
      try { view.destroy() } finally { restoreGlobals(prior) }
    },
  }
}

async function driveSetup(bridge, fields = {}, options = {}) {
  const prior = {
    document: globalThis.document,
    mcAccount: globalThis.mcAccount,
    mcSetup: globalThis.mcSetup,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
  }
  const standIn = setupDocument(fields, options)
  const storage = fixtureStorage({
    'mc.setup.profile': JSON.stringify({
      schemaVersion: 1,
      status: 'in-progress',
      step: 'account',
      answers: { autonomy: 'autonomous', screens: 'live', workspaceRoots: [] },
      updatedAtMs: 1,
    }),
  })
  const setupBridgeForTest = setupBridge(bridge, storage)
  globalThis.document = standIn.document
  globalThis.mcAccount = bridge
  globalThis.mcSetup = setupBridgeForTest
  globalThis.window = makeWindow(bridge)
  globalThis.localStorage = storage
  const view = await mountWith(prior, async () => (await freshSetupView())({ navigate: () => {} }))
  return {
    ...standIn,
    view,
    restore() {
      try { view.destroy() } finally { restoreGlobals(prior) }
    },
  }
}

test('account create refusal keeps username and shown-as through busy and refusal paints, while clearing password', async () => {
  const pending = deferred()
  const fixture = accountFixture({
    accountCount: 0,
    create: () => pending.promise,
  })
  const screen = await driveAccount(fixture.bridge)
  try {
    assert.match(screen.markup(), /data-account-form="create"/)
    screen.type('username', 'hunter-one')
    screen.type('displayName', 'Hunter One')
    screen.type('password', 'short-fixture-password')
    screen.submit('create')
    await settle(4)
    assert.equal(screen.fieldValue('username'), 'hunter-one', 'the name is still visible during the deferred create')
    assert.equal(screen.fieldValue('displayName'), 'Hunter One', 'shown-as is still visible during the deferred create')
    assert.doesNotMatch(screen.markup(), /short-fixture-password/, 'the password must never enter rendered markup')
    pending.resolve({ ok: false, code: 'FIXTURE_SHORT_PASSWORD', reason: 'Use at least 12 characters.' })
    await settle()
    assert.equal(screen.fieldValue('username'), 'hunter-one')
    assert.equal(screen.fieldValue('displayName'), 'Hunter One')
    assert.equal(screen.fieldValue('password'), '', 'refusal clears the password field')
    assert.match(screen.markup(), /Use at least 12 characters\./)
    assert.equal(fixture.calls.create.length, 1)
  } finally {
    screen.restore()
  }
})

test('account rejected create keeps the non-secret fields and exposes a truthful refusal', async () => {
  const fixture = accountFixture({
    accountCount: 0,
    create: async () => { throw new Error('fixture channel rejected') },
  })
  const screen = await driveAccount(fixture.bridge)
  try {
    screen.type('username', 'hunter-rejected')
    screen.type('displayName', 'Hunter Rejected')
    screen.type('password', 'rejected-fixture-password')
    screen.submit('create')
    await settle()
    assert.equal(screen.fieldValue('username'), 'hunter-rejected')
    assert.equal(screen.fieldValue('displayName'), 'Hunter Rejected')
    assert.equal(screen.fieldValue('password'), '')
    assert.match(screen.markup(), /The application did not answer\./)
  } finally {
    screen.restore()
  }
})

test('account sign-in refusal keeps the username through busy and refusal, and clears password', async () => {
  const pending = deferred()
  const fixture = accountFixture({
    signIn: () => pending.promise,
  })
  const screen = await driveAccount(fixture.bridge)
  try {
    assert.match(screen.markup(), /data-account-form="sign-in"/)
    screen.type('username', 'hunter-sign-in')
    screen.type('password', 'sign-in-fixture-password')
    screen.submit('sign-in')
    await settle(4)
    assert.equal(screen.fieldValue('username'), 'hunter-sign-in')
    pending.resolve({ ok: false, code: 'FIXTURE_BAD_PASSWORD', reason: 'The password was refused.' })
    await settle()
    assert.equal(screen.fieldValue('username'), 'hunter-sign-in')
    assert.equal(screen.fieldValue('password'), '')
    assert.match(screen.markup(), /The password was refused\./)
  } finally {
    screen.restore()
  }
})

test('email in create switches through the mounted mode control to truthful sign-in with zero create call', async () => {
  const fixture = accountFixture({
    accountCount: 0,
    signIn: async request => ({ ok: true, persisted: true, request }),
  })
  const screen = await driveAccount(fixture.bridge)
  try {
    screen.type('username', 'buyer@example.com')
    screen.type('displayName', 'Buyer')
    screen.type('password', 'email-fixture-password')
    screen.submit('create')
    await settle()
    assert.equal(fixture.calls.create.length, 0, 'an email typed into create must not call account.create')
    assert.match(screen.markup(), /data-account-form="sign-in"/)
    assert.match(screen.markup(), /Sign in with your email/)
    assert.match(screen.markup(), /To sign in with an email address, use the sign-in form below\./)
    assert.doesNotMatch(screen.markup(), /\[object Object\]/)
    assert.equal(screen.fieldValue('username'), 'buyer@example.com')
    assert.equal(screen.fieldValue('password'), '')
    screen.press('[data-account-mode="create"]')
    assert.match(screen.markup(), /data-account-form="create"/)
    assert.equal(screen.fieldValue('username'), 'buyer@example.com')
    screen.press('[data-account-mode="sign-in"]')
    assert.match(screen.markup(), /data-account-form="sign-in"/)
    assert.equal(screen.fieldValue('username'), 'buyer@example.com')
    screen.type('password', 'email-sign-in-password')
    screen.submit('sign-in')
    await settle()
    assert.equal(fixture.calls.create.length, 0)
    assert.equal(fixture.calls.signIn.length, 1)
    assert.deepEqual(fixture.calls.signIn[0], {
      username: 'buyer@example.com',
      password: 'email-sign-in-password',
    })
    assert.doesNotMatch(screen.markup(), /data-account-form="sign-in"/)
  } finally {
    screen.restore()
  }
})

test('signed-in account defaults remain isolated after a successful display-name edit and sign out', async () => {
  const fixture = accountFixture({
    accountCount: 1,
    signedIn: true,
    username: 'current-account',
    displayName: 'Current Account',
    changeDisplayName: async () => ({ ok: true, persisted: true }),
  })
  const screen = await driveAccount(fixture.bridge, { displayName: 'stale-draft' })
  try {
    assert.doesNotMatch(screen.markup(), /data-account-form=/)
    assert.match(screen.markup(), /Current Account/)
    screen.press('[data-account-mode="display-name"]')
    assert.match(screen.markup(), /data-account-form="display-name"/)
    assert.equal(screen.fieldValue('displayName'), 'Current Account', 'the signed-in edit form must load the current name, not a stale draft')
    screen.type('displayName', 'Edited Account')
    screen.submit('display-name')
    await settle()
    assert.match(screen.markup(), /Edited Account/)
    screen.press('[data-account-mode="display-name"]')
    assert.equal(screen.fieldValue('displayName'), 'Edited Account', 'a successful rename must repaint the current saved name')
    screen.press('[data-account-mode="signed-in"]')
    screen.press('[data-account-sign-out]')
    await settle()
    assert.match(screen.markup(), /data-account-form="sign-in"/)
    assert.equal(screen.fieldValue('username'), '')
    assert.doesNotMatch(screen.markup(), /Edited Account/)
    assert.equal(fixture.calls.signOut.length, 1)
  } finally {
    screen.restore()
  }
})

test('setup late Google availability keeps typed fields including password, then refusal clears only password', async () => {
  const google = deferred()
  const refusal = deferred()
  let googleAnswer = google.promise
  const fixture = accountFixture({
    accountCount: 0,
    googleAvailability: () => googleAnswer,
    create: () => refusal.promise,
  })
  const screen = await driveSetup(fixture.bridge)
  try {
    screen.type('username', 'setup-hunter')
    screen.type('displayName', 'Setup Hunter')
    screen.type('password', 'setup-password-fixture')
    google.resolve({ ok: false, reason: 'Google is unavailable in this fixture.' })
    await settle()
    assert.equal(screen.fieldValue('username'), 'setup-hunter')
    assert.equal(screen.fieldValue('displayName'), 'Setup Hunter')
    assert.equal(screen.fieldValue('password'), 'setup-password-fixture')
    screen.click('[data-setup-account-submit]', { setupAccountSubmit: 'create' })
    await settle(4)
    assert.equal(screen.fieldValue('username'), 'setup-hunter', 'setup keeps the name while create is busy')
    assert.equal(screen.fieldValue('displayName'), 'Setup Hunter', 'setup keeps shown-as while create is busy')
    refusal.resolve({ ok: false, code: 'FIXTURE_SHORT_PASSWORD', reason: 'Use at least 12 characters.' })
    await settle()
    assert.equal(screen.fieldValue('username'), 'setup-hunter')
    assert.equal(screen.fieldValue('displayName'), 'Setup Hunter')
    assert.equal(screen.fieldValue('password'), '')
    assert.match(screen.markup(), /Use at least 12 characters\./)
  } finally {
    screen.restore()
  }
})

test('setup email in create keeps the email, gives sign-in guidance, and never creates an account', async () => {
  const fixture = accountFixture({
    accountCount: 0,
    signIn: async request => ({ ok: true, persisted: true, request }),
  })
  const screen = await driveSetup(fixture.bridge)
  try {
    assert.match(screen.markup(), /data-setup-account-field="username"/, 'the mounted setup account step must expose username')
    assert.match(screen.markup(), /data-setup-account-submit="create"/, 'the mounted setup account step must expose create')
    screen.type('username', 'buyer@example.com')
    screen.type('displayName', 'Buyer')
    screen.type('password', 'setup-email-fixture-password')
    screen.click('[data-setup-account-submit]', { setupAccountSubmit: 'create' })
    await settle()
    assert.equal(fixture.calls.create.length, 0, 'an email in setup create must not call account.create')
    assert.equal(fixture.calls.signIn.length, 0, 'email guidance must not authenticate automatically')
    assert.match(screen.markup(), /Sign in with your email/)
    assert.match(screen.markup(), /To sign in with an email address, use the sign-in form below\./)
    assert.doesNotMatch(screen.markup(), /\[object Object\]/)
    assert.equal(screen.fieldValue('username'), 'buyer@example.com')
    assert.equal(screen.fieldValue('password'), '')
    assert.match(screen.markup(), /data-setup-account-submit="sign-in"/)
    screen.click('[data-setup-account-mode]', { setupAccountMode: 'create' })
    assert.match(screen.markup(), /data-setup-account-submit="create"/)
    assert.equal(screen.fieldValue('username'), 'buyer@example.com')
    screen.click('[data-setup-account-mode]', { setupAccountMode: 'sign-in' })
    assert.match(screen.markup(), /data-setup-account-submit="sign-in"/)
    assert.equal(screen.fieldValue('username'), 'buyer@example.com')
    screen.type('password', 'setup-email-sign-in-password')
    screen.click('[data-setup-account-submit]', { setupAccountSubmit: 'sign-in' })
    await settle()
    assert.equal(fixture.calls.create.length, 0)
    assert.equal(fixture.calls.signIn.length, 1)
    assert.deepEqual(fixture.calls.signIn[0], {
      username: 'buyer@example.com',
      password: 'setup-email-sign-in-password',
    })
  } finally {
    screen.restore()
  }
})

test('setup sign-in refusal keeps username and clears only the password', async () => {
  const fixture = accountFixture({
    accountCount: 1,
    signIn: async () => ({ ok: false, code: 'FIXTURE_BAD_PASSWORD', reason: 'The password was refused.' }),
  })
  const screen = await driveSetup(fixture.bridge)
  try {
    assert.match(screen.markup(), /data-setup-account-field="username"/, 'the mounted setup account step must expose username')
    assert.match(screen.markup(), /data-setup-account-submit="sign-in"/, 'the mounted setup account step must expose sign-in')
    screen.type('username', 'setup-sign-in-user')
    screen.type('password', 'setup-sign-in-password')
    screen.click('[data-setup-account-submit]', { setupAccountSubmit: 'sign-in' })
    await settle()
    assert.equal(fixture.calls.signIn.length, 1)
    assert.equal(screen.fieldValue('username'), 'setup-sign-in-user')
    assert.equal(screen.fieldValue('password'), '')
    assert.match(screen.markup(), /The password was refused\./)
  } finally {
    screen.restore()
  }
})

test('mounted account reset uses neutral relay copy after actual data-source resolution', async () => {
  let eraseCalls = 0
  const transportRequests = []
  let fetchCalls = 0
  const priorFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('unexpected network request in the mounted relay fixture')
  }
  /* A page read over the relay legitimately asks the far computer for its own
     reads (the purchase list is one). The fake transport answers every request
     with a failure, so nothing leaves this process; what must never pass
     through it from the reset preview is a write. */
  setBridgeTransport(async (route, options = {}) => {
    transportRequests.push({ route, method: options.method || 'GET' })
    throw new Error('the fake relay transport answers no request')
  })
  const fixture = accountFixture({ signedIn: true, username: 'relay-user', displayName: 'Relay User' })
  const plan = {
    ok: true,
    roots: [{
      kind: 'installation',
      directory: '/opt/ToolsEnabled',
      present: true,
      files: 1,
      bytes: 100,
      named: [],
    }],
    untouched: [],
    conflicts: [],
    totals: { files: 1, bytes: 100 },
  }
  let screen
  try {
    screen = await driveAccount(fixture.bridge, {}, {
      plan: async () => plan,
      erase: async () => { eraseCalls += 1; return { ok: true } },
    }, { relay: true })
    assert.equal(await resolveDataSource({ reask: true }), 'relay')
    assert.equal(currentDataSource(), 'relay')
    assert.ok(screen.paintCount() > 0, 'the actual account section must have mounted before dispatch')
    assert.equal(screen.view.el.querySelector('[data-account-section]'), screen.section, 'the actual account section must be mounted')
    assert.match(screen.markup(), /data-reset-plan/, 'the mounted reset control must exist before dispatch')
    screen.press('[data-reset-plan]')
    await settle()
    assert.match(screen.markup(), /the computer you are driving/)
    assert.doesNotMatch(screen.markup(), /Windows Settings/)
    assert.equal(eraseCalls, 0, 'the relay preview path must not erase')
    assert.deepEqual(transportRequests.filter(request => request.method !== 'GET'), [], 'the relay reset preview must send no write through the transport')
    assert.ok(transportRequests.every(request => !/reset|erase|delete/i.test(request.route)), 'the relay reset preview must not ask the far computer to delete anything')
    assert.equal(fetchCalls, 0, 'the mounted relay path must not fetch outside the fake transport')
    screen.press('[data-reset-cancel]')
    assert.equal(eraseCalls, 0)
  } finally {
    screen?.restore()
    setBridgeTransport(null)
    assert.equal(await resolveDataSource({ reask: true }), 'local')
    globalThis.fetch = priorFetch
  }
})

test('mounted local Windows reset preview is read-only and keeps the local setup platform', async () => {
  let eraseCalls = 0
  const fixture = accountFixture({ signedIn: true, username: 'windows-user', displayName: 'Windows User' })
  const plan = {
    ok: true,
    roots: [{
      kind: 'installation',
      directory: 'C:\\\\ToolsEnabled',
      present: true,
      files: 3,
      bytes: 300,
      named: [],
    }],
    untouched: [],
    conflicts: [],
    totals: { files: 3, bytes: 300 },
  }
  const screen = await driveAccount(fixture.bridge, {
    resetPlan: 'unused',
  }, {
    plan: async () => plan,
    erase: async () => { eraseCalls += 1; return { ok: true } },
  })
  try {
    assert.equal(globalThis.mcSetup.platform, 'win32')
    assert.ok(screen.paintCount() > 0, 'the actual account section must have mounted before dispatch')
    assert.equal(screen.view.el.querySelector('[data-account-section]'), screen.section, 'the actual account section must be mounted')
    assert.match(screen.markup(), /data-reset-plan/, 'the mounted reset control must exist before dispatch')
    screen.press('[data-reset-plan]')
    await settle()
    assert.match(screen.markup(), /Windows Settings/)
    assert.match(screen.markup(), /What this does NOT delete/)
    assert.equal(eraseCalls, 0, 'the preview path must not erase')
    assert.equal(globalThis.mcSetup.platform, 'win32', 'local reset copy must retain the local setup platform')
    screen.press('[data-reset-cancel]')
    assert.equal(eraseCalls, 0)
  } finally {
    screen.restore()
  }
})

/* Put the import-time stand-ins back only after every case has run. Restoring
   them at the end of module evaluation ran before the first case, so each case
   started from no window at all instead of the desktop window the views were
   imported under, and a relay case could not show that it handed back the
   desktop's local data source. */
after(() => {
  restoreGlobals({ mcSetup: priorSetupAtImport, window: priorWindowAtImport, localStorage: priorStorageAtImport })
})

/* T1589: ONE TYPO IN THE NEW PASSWORD MUST NOT LOCK A LOCAL ACCOUNT FOR GOOD.
   The form took the new password once, in a hidden field, and the change ends
   every sign-in; a local account has no reset. The new password is now typed
   twice, a mismatch is refused on the page with nothing sent, and only a
   matching pair reaches the bridge. */
test('change password refuses two different new passwords before sending anything, and keeps the current one typed', async () => {
  const fixture = accountFixture({ signedIn: true, username: 'local-owner', displayName: 'Local Owner' })
  const screen = await driveAccount(fixture.bridge)
  try {
    screen.press('[data-account-mode="change-password"]')
    await settle()
    assert.match(screen.markup(), /name="newPasswordAgain"/, 'the change-password form does not ask for the new password twice')
    screen.type('currentPassword', 'the old long password')
    screen.type('newPassword', 'correct horse battery staple')
    screen.type('newPasswordAgain', 'correct horse battery stapel')
    screen.submit('change-password')
    await settle()
    assert.equal(fixture.calls.changePassword.length, 0, 'a mismatched new password reached the account store')
    assert.match(screen.markup(), /The two new passwords are different\./)
    assert.match(screen.markup(), /Your password was not changed\./)
    assert.equal(screen.fieldValue('currentPassword'), 'the old long password', 'the current password had to be typed again after a mismatch')
    assert.equal(screen.fieldValue('newPassword'), '')
    assert.equal(screen.fieldValue('newPasswordAgain'), '')
    assert.match(screen.markup(), /data-account-form="change-password"/, 'the mismatch left the change-password form')

    screen.type('newPassword', 'correct horse battery staple')
    screen.type('newPasswordAgain', 'correct horse battery staple')
    screen.submit('change-password')
    await settle()
    assert.deepEqual(fixture.calls.changePassword, [{ currentPassword: 'the old long password', newPassword: 'correct horse battery staple' }],
      'a matching pair must be sent once, with exactly what was typed')
    assert.equal(screen.fieldValue('newPassword'), '', 'a password was left in the page after the change')
  } finally {
    screen.restore()
  }
})

/* T1557: ENTER IN THE FIRST-RUN ACCOUNT STEP DOES WHAT ITS BUTTON DOES. The
   fields are not in a form there, and setup had no key handling, so Enter in
   the password field did nothing; on the Account page the same Enter creates
   the account or signs in. */
test('Enter in a setup account field submits the visible create or sign-in form', async () => {
  const created = accountFixture({ accountCount: 0, create: async () => ({ ok: true }), signIn: async () => ({ ok: true }) })
  const create = await driveSetup(created.bridge)
  try {
    assert.match(create.markup(), /data-setup-account-submit="create"/, 'a fresh copy opens the create form')
    create.type('username', 'enter-key')
    create.type('password', 'a long enough password')
    assert.equal(create.pressEnter('password'), true, 'Enter in the password field was not taken as a submit')
    await settle()
    assert.deepEqual(created.calls.create.map(({ username, password }) => ({ username, password })),
      [{ username: 'enter-key', password: 'a long enough password' }], 'Enter did not create the account the button would have')
  } finally {
    create.restore()
  }

  const signingIn = accountFixture({ accountCount: 1, signIn: async () => ({ ok: false, code: 'FIXTURE_REFUSED', reason: 'The fixture refused sign-in.' }) })
  const signIn = await driveSetup(signingIn.bridge)
  try {
    assert.match(signIn.markup(), /data-setup-account-submit="sign-in"/)
    signIn.type('username', 'enter-sign-in')
    signIn.type('password', 'some password here')
    signIn.pressEnter('username')
    await settle()
    assert.equal(signingIn.calls.signIn.length, 1, 'Enter in the name field did not sign in')
    assert.equal(signingIn.calls.create.length, 0)
  } finally {
    signIn.restore()
  }
})

/* T1493: SWITCHING BETWEEN "CREATE" AND "I ALREADY HAVE AN ACCOUNT" KEEPS WHAT
   WAS TYPED. The Account page rebuilt the form on every mode press, so the
   name was gone after "I already have an account" and both the name and
   "Shown as" were gone after switching back. */
test('account mode switches keep the typed name and shown-as', async () => {
  const fixture = accountFixture({ accountCount: 0 })
  const screen = await driveAccount(fixture.bridge)
  try {
    assert.match(screen.markup(), /data-account-form="create"/, 'a copy with no account opens the create form')
    screen.type('username', 'switch-keep')
    screen.type('displayName', 'Switch Keep')
    screen.press('[data-account-mode="sign-in"]')
    await settle()
    assert.match(screen.markup(), /data-account-form="sign-in"/)
    assert.equal(screen.fieldValue('username'), 'switch-keep', 'the name was erased by "I already have an account"')
    screen.press('[data-account-mode="create"]')
    await settle()
    assert.match(screen.markup(), /data-account-form="create"/)
    assert.equal(screen.fieldValue('username'), 'switch-keep', 'the name was erased by switching back')
    assert.equal(screen.fieldValue('displayName'), 'Switch Keep', 'Shown as was erased by the round trip')
    assert.equal(fixture.calls.create.length + fixture.calls.signIn.length, 0, 'a mode switch sent something')
  } finally {
    screen.restore()
  }
})

/* T1585: THE DELETION PLAN IS ANNOUNCED, AND "LEAVE IT ALONE" GIVES THE
   KEYBOARD BACK. Both presses repainted the section and left the keyboard on
   the page body, so the plan appeared silently beside "Delete it all now". */
test('Show me what would be deleted moves focus into the plan, and Leave it alone returns it', async () => {
  const fixture = accountFixture({ signedIn: true, username: 'focus-owner', displayName: 'Focus Owner' })
  const plan = { ok: true, roots: [{ kind: 'installation', directory: '/opt/ToolsEnabled', present: true, files: 2, bytes: 20, named: [] }],
    untouched: [], conflicts: [], totals: { files: 2, bytes: 20 } }
  let erased = 0
  const screen = await driveAccount(fixture.bridge, {}, { plan: async () => plan, erase: async () => { erased += 1; return { ok: true } } })
  try {
    screen.press('[data-reset-plan]')
    await settle()
    assert.match(screen.markup(), /Measured just now/)
    assert.equal(screen.document.activeElement?.selector, '[data-reset-focus]', 'the plan appeared and the keyboard was not moved into it')
    assert.match(screen.markup(), /tabindex="-1" data-reset-focus data-reset-total>Measured just now/, 'the focused sentence is not the plan\'s first line')
    screen.press('[data-reset-cancel]')
    await settle()
    assert.equal(screen.document.activeElement?.selector, '[data-reset-plan]', 'Leave it alone did not return the keyboard to Show me what would be deleted')
    assert.equal(erased, 0, 'the preview path erased something')
  } finally {
    screen.restore()
  }
})

/* T1520: THE MOUNTED ACCOUNT PAGE SETS A DAMAGED ACCOUNT FILE ASIDE AND OFFERS
   THE CREATE FORM AGAIN. */
test('Set the damaged account file aside asks the shell once and brings back the create form', async () => {
  const fixture = accountFixture({ accountCount: 0 })
  let damaged = true
  const setAside = []
  const healthy = fixture.bridge.availability
  fixture.bridge.availability = async () => damaged
    ? { ok: false, code: 'ACCOUNT_STORE_CORRUPT', reason: 'The account file on this computer is not readable.', accountCount: 0 }
    : healthy()
  fixture.bridge.setAsideDamaged = async () => { setAside.push(1); damaged = false; return { ok: true, keptAs: ['product-accounts.json.damaged-2026-09-22T21-00-00-000Z'] } }
  const screen = await driveAccount(fixture.bridge)
  try {
    assert.match(screen.markup(), /data-account-set-aside/, 'the damaged page offers no narrow way back')
    assert.doesNotMatch(screen.markup(), /data-account-form="create"/)
    screen.press('[data-account-set-aside]')
    await settle()
    assert.equal(setAside.length, 1)
    assert.match(screen.markup(), /The damaged account file was set aside\./)
    assert.match(screen.markup(), /product-accounts\.json\.damaged-2026-09-22T21-00-00-000Z/)
    assert.match(screen.markup(), /data-account-form="create"/, 'the create form did not come back after the set-aside')
  } finally {
    screen.restore()
  }
})

/* T1557: ENTER IN THE FIRST-RUN ACCOUNT STEP DOES WHAT ITS BUTTON DOES. The
   fields are not in a form there, and setup had no key handling, so Enter in
   the password field did nothing; on the Account page the same Enter creates
   the account or signs in. */
test('Enter in a setup account field submits the visible create or sign-in form', async () => {
  const created = accountFixture({ accountCount: 0, create: async () => ({ ok: true }), signIn: async () => ({ ok: true }) })
  const create = await driveSetup(created.bridge)
  try {
    assert.match(create.markup(), /data-setup-account-submit="create"/, 'a fresh copy opens the create form')
    create.type('username', 'enter-key')
    create.type('password', 'a long enough password')
    assert.equal(create.pressEnter('password'), true, 'Enter in the password field was not taken as a submit')
    await settle()
    assert.deepEqual(created.calls.create.map(({ username, password }) => ({ username, password })),
      [{ username: 'enter-key', password: 'a long enough password' }], 'Enter did not create the account the button would have')
  } finally {
    create.restore()
  }

  const signingIn = accountFixture({ accountCount: 1, signIn: async () => ({ ok: false, code: 'FIXTURE_REFUSED', reason: 'The fixture refused sign-in.' }) })
  const signIn = await driveSetup(signingIn.bridge)
  try {
    assert.match(signIn.markup(), /data-setup-account-submit="sign-in"/)
    signIn.type('username', 'enter-sign-in')
    signIn.type('password', 'some password here')
    signIn.pressEnter('username')
    await settle()
    assert.equal(signingIn.calls.signIn.length, 1, 'Enter in the name field did not sign in')
    assert.equal(signingIn.calls.create.length, 0)
  } finally {
    signIn.restore()
  }
})

/* T1585: THE DELETION PLAN IS ANNOUNCED, AND "LEAVE IT ALONE" GIVES THE
   KEYBOARD BACK. Both presses repainted the section and left the keyboard on
   the page body, so the plan appeared silently beside "Delete it all now". */
test('Show me what would be deleted moves focus into the plan, and Leave it alone returns it', async () => {
  const fixture = accountFixture({ signedIn: true, username: 'focus-owner', displayName: 'Focus Owner' })
  const plan = { ok: true, roots: [{ kind: 'installation', directory: '/opt/ToolsEnabled', present: true, files: 2, bytes: 20, named: [] }],
    untouched: [], conflicts: [], totals: { files: 2, bytes: 20 } }
  let erased = 0
  const screen = await driveAccount(fixture.bridge, {}, { plan: async () => plan, erase: async () => { erased += 1; return { ok: true } } })
  try {
    screen.press('[data-reset-plan]')
    await settle()
    assert.match(screen.markup(), /Measured just now/)
    assert.equal(screen.document.activeElement?.selector, '[data-reset-focus]', 'the plan appeared and the keyboard was not moved into it')
    assert.match(screen.markup(), /tabindex="-1" data-reset-focus data-reset-total>Measured just now/, 'the focused sentence is not the plan\'s first line')
    screen.press('[data-reset-cancel]')
    await settle()
    assert.equal(screen.document.activeElement?.selector, '[data-reset-plan]', 'Leave it alone did not return the keyboard to Show me what would be deleted')
    assert.equal(erased, 0, 'the preview path erased something')
  } finally {
    screen.restore()
  }
})
