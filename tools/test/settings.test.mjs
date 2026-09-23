/* The Settings view owns the final, customer-visible decision about whether
 * the example-fleet switch can do anything.  Exercise the exported view with
 * the same URLSearchParams object main.js passes, rather than pinning its
 * private markup helpers. */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const stored = new Map()
const listeners = new Map()
let painted = ''
let storageReadable = true
let refusedWrite = null
let paints = 0
const renderedRows = new Map()

const classList = () => ({
  add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false,
})

/* A REAL CLASS LIST, AND ONLY ON body.
 *
 * The stub above answers `contains: () => false` to everything, and for one row
 * that is not a simplification, it is the row's whole truth: settings.js
 * readValue() for `reduce_motion` IS
 * `document.body.classList.contains('reduce-motion')`. With a permanently false
 * answer, staging the row to `false` always matched the read and was unstaged, so
 * NO TEST IN THIS FILE COULD EVER TURN REDUCE MOTION OFF -- which is exactly the
 * gap that let tools/appearance-persistence-drive.mjs report, twice, that an
 * accessibility setting could not be switched off, when what it had not done was
 * press Save. Recorded here so the same row cannot become unobservable again. */
function recordingClassList() {
  const names = new Set()
  return {
    add: name => names.add(name),
    remove: name => names.delete(name),
    toggle(name, on) {
      if (on === undefined) return names.has(name) ? (names.delete(name), false) : (names.add(name), true)
      if (on) names.add(name)
      else names.delete(name)
      return Boolean(on)
    },
    contains: name => names.has(name),
  }
}

function node() {
  return {
    dataset: {}, value: '', checked: false, textContent: '', hidden: false,
    classList: classList(),
    style: { setProperty: () => {}, getPropertyValue: () => '' },
    handlers: new Map(),
    addEventListener(type, handler) { this.handlers.set(type, handler) }, removeEventListener: () => {},
    setAttribute: () => {}, removeAttribute: () => {}, toggleAttribute: () => {},
    getAttribute: () => null, querySelector: () => node(), querySelectorAll: () => [],
    closest: () => null, contains: () => true,
    /* The page hands a LIVE element to one row rather than a string of markup:
       'This computer' hosts src/this-computer-settings.js, and mountThisComputer()
       appends that element into the row's socket after every render. A stub
       without appendChild made every test in this file die with
       'programs.appendChild is not a function' before it reached its own
       subject. The child is kept rather than dropped, so a mount that never
       happened cannot look like one that did. */
    children: [],
    appendChild(child) { this.children.push(child); return child },
    getBoundingClientRect: () => ({ top: 0 }), getClientRects: () => [{ top: 0 }], scrollIntoView: () => {}, focus: () => {},
  }
}

const sections = node()
Object.defineProperty(sections, 'innerHTML', {
  get: () => painted,
  set: value => {
    painted = String(value); paints += 1
    renderedRows.clear()
    for (const match of painted.matchAll(/<article[^>]*data-setting-id="([^"]+)"[\s\S]*?<\/article>/g)) {
      const row = node(), input = node()
      input.checked = /<input[^>]*\schecked(?=[\s/>])/.test(match[0])
      row.querySelector = selector => selector === '.settings-toggle input' ? input : null
      renderedRows.set(match[1], row)
    }
  },
})

const save = node(), draftStatus = node()
const root = node()
root.querySelector = selector => {
  if (selector === '.settings-sections') return sections
  if (selector === '[data-settings-save]') return save
  if (selector === '[data-settings-draft-status]') return draftStatus
  return node()
}
root.querySelectorAll = selector => {
  const id = selector.match(/^\[data-setting-id="([^"]+)"\]$/)?.[1]
  return renderedRows.has(id) ? [renderedRows.get(id)] : []
}

globalThis.document = {
  createElement: () => ({
    set innerHTML(value) { this.value = value },
    content: { firstElementChild: root },
  }),
  documentElement: node(), body: Object.assign(node(), { classList: recordingClassList() }),
  getElementById: () => null,
}
globalThis.localStorage = {
  getItem: key => {
    if (!storageReadable) throw new Error('storage unavailable')
    return stored.get(key) ?? null
  },
  setItem: (key, value) => {
    if (key === refusedWrite) throw new Error('fixture preference is locked')
    stored.set(key, String(value))
  },
  removeItem: key => {
    if (key === refusedWrite) throw new Error('fixture preference is locked')
    stored.delete(key)
  },
}
globalThis.window = {
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

const { DATA_SOURCE_READ_UNAVAILABLE, announceDataSourceChange, currentDataSource, resolveDataSource, setExampleMode } = await import('../../src/data-source.js')
const { setBridgeTransport } = await import('../../src/mission-bridge.js')
const { settingsView } = await import('../../src/views/settings.js')

async function settle() { for (let turn = 0; turn < 60; turn += 1) await Promise.resolve() }
function goTo(view, setting) {
  assert.equal(view.beforeLeave({ name: 'settings', query: new URLSearchParams({ setting }) }), 'updated')
}
function toggle(id, checked) {
  const row = { dataset: { settingId: id } }
  const input = { checked, closest: selector => selector === '.settings-toggle input' ? input : selector === '[data-setting-id]' ? row : null }
  sections.handlers.get('change')({ target: input })
}

function exampleControl(markup) {
  const row = markup.match(/<article[^>]*data-setting-id="example_mode"[\s\S]*?<\/article>/)?.[0]
  assert.ok(row, 'Settings did not draw the example-fleet row for a real route query')
  const input = row.match(/<input type="checkbox"[^>]*>/)?.[0]
  assert.equal(typeof input, 'string', 'the example-fleet row has no checkbox control')
  return input
}

test('the example control refuses an impossible change, explains why, and enables a chosen example', async () => {
  stored.clear()

  /* AN UNREADABLE STORE NO LONGER REACHES THIS ROW, AND THAT IS THE POINT.
     This case used to make localStorage throw and then paint, because the old
     exampleWasStored() swallowed the throw and answered "nothing is stored".
     3eb039d replaced that contract deliberately: a store which EXISTS and
     cannot be read is could-not-tell, never absence, so the resolve now
     rejects with DATA_SOURCE_READ_UNAVAILABLE instead of settling a source
     (the rule and its mutation proof live in tools/test/data-source.test.mjs).
     Pinned here rather than quietly deleted, so this file's unreadable-storage
     branch still asserts something. */
  storageReadable = false
  await assert.rejects(
    resolveDataSource({ reask: true }),
    error => error.code === DATA_SOURCE_READ_UNAVAILABLE,
    'an unreadable example preference must not settle into a definite source',
  )

  /* THE REFUSAL THIS TEST IS ACTUALLY ABOUT is not storage: it is having NO
     HOST -- no desktop shell, no relay transport, nothing stored -- which is
     the state previewWithoutHost() answers true for and the only thing the
     row's disabled reason names. Readable and empty is how that state is
     reached now that an unreadable read is an error rather than a false. */
  storageReadable = true
  await resolveDataSource({ reask: true })

  const unavailable = settingsView({ query: new URLSearchParams({ setting: 'example_mode' }) })
  const refused = exampleControl(painted)
  assert.match(refused, /\sdisabled(?=[\s/>])/,
    'the example control stayed enabled when no computer can supply real records')
  const reason = refused.match(/\stitle="([^"]+)"/)?.[1]
  assert.equal(typeof reason, 'string',
    'the disabled example control did not carry its refusal reason')
  assert.match(reason, /no computer connected/i,
    'the disabled example control did not say that no computer is connected')
  unavailable.destroy()

  storageReadable = true
  stored.set('mc.example', 'on')
  await resolveDataSource({ reask: true })
  const chosen = settingsView({ query: new URLSearchParams({ setting: 'example_mode' }) })
  const enabled = exampleControl(painted)
  assert.doesNotMatch(enabled, /\sdisabled(?=[\s/>])/,
    'the example control stayed disabled when the person chose the example and can turn it off')
  chosen.destroy()
})

test('desktop example save refreshes the same Settings visit and preserves a failed cross-category draft for retry', async () => {
  stored.clear()
  stored.set('mc.example', 'on')
  window.mcShell = { getBridgeProof() {} }
  await resolveDataSource()
  const view = settingsView({ query: new URLSearchParams({ setting: 'example_mode' }) })
  try {
    await settle()
    assert.equal(currentDataSource(), 'mock')
    toggle('example_mode', false)
    goTo(view, 'reduce_motion')
    toggle('reduce_motion', true)
    assert.match(draftStatus.textContent, /2 unsaved changes/)
    refusedWrite = 'mc.set.reduce_motion'
    await save.handlers.get('click')()
    await settle()

    assert.equal(stored.has('mc.example'), false, 'the actual example save completed before the unrelated write failed')
    assert.equal(currentDataSource(), 'local', 'turning the example off must recognize the existing desktop without a route remount')
    assert.equal(stored.has('mc.set.reduce_motion'), false)
    assert.match(draftStatus.textContent, /storage could not be written/)
    assert.match(draftStatus.textContent, /Unsaved changes remain/)
    assert.equal(root.dataset.settingsDirty, 'true')
    goTo(view, 'example_mode')
    assert.doesNotMatch(exampleControl(painted), /\sdisabled(?=[\s/>])/)
    assert.doesNotMatch(exampleControl(painted), /\schecked(?=[\s/>])/)

    goTo(view, 'reduce_motion')
    assert.equal(renderedRows.get('reduce_motion')?.querySelector('.settings-toggle input').checked, true,
      'the unrelated draft survives source refresh and category navigation')
    refusedWrite = null
    await save.handlers.get('click')()
    assert.equal(stored.get('mc.set.reduce_motion'), 'true')
    assert.equal(root.dataset.settingsDirty, 'false')
    goTo(view, 'example_mode')
    toggle('example_mode', true)
    await save.handlers.get('click')()
    assert.equal(currentDataSource(), 'mock')
    toggle('example_mode', false)
    await save.handlers.get('click')()
    assert.equal(currentDataSource(), 'local', 'repeated changes work in the same view')
  } finally {
    refusedWrite = null
    view.destroy()
    delete window.mcShell
  }
})

test('open public Settings re-asks a changed host and keeps an unreachable host on its real source', async () => {
  stored.clear()
  setBridgeTransport(null)
  let connected = false, asks = 0
  window.mcShell = { getBridgeTransport: async () => {
    asks += 1
    if (!connected) throw new Error('fixture host is unreachable')
    return async () => ({ ok: false, code: 'FIXTURE_TRANSPORT_ONLY' })
  } }
  setExampleMode(false)
  await resolveDataSource({ reask: true })
  const view = settingsView({ query: new URLSearchParams({ setting: 'example_mode' }) })
  try {
    await settle()
    /* A HOST SEAM THAT IS PRESENT BUT UNREACHABLE IS STILL A HOST.
       c5baa6dc ("Keep unavailable hosted workspaces on their real source") made
       resolveDataSource() answer 'relay' whenever the desktop seam or the
       account seam EXISTS, even when its first offer throws, because on
       2026-08-22 somebody with the app installed and a computer connected was
       told to go and install software they already had the moment their machine
       went quiet.  tools/test/hosted-source-recovery.test.mjs is the canonical
       statement of that contract ("signed-in hosted source remains real when
       its first transport offer fails"); this case is the same rule seen from
       the Settings row, which therefore stays a real choice, not a refusal. */
    assert.equal(currentDataSource(), 'relay')
    assert.doesNotMatch(exampleControl(painted), /\sdisabled(?=[\s/>])/,
      'an unreachable host is not the same as no host, so the switch still decides')
    const before = asks
    announceDataSourceChange('host')
    await settle()
    assert.ok(asks > before, 'the event must re-ask a previously unavailable transport')
    assert.equal(currentDataSource(), 'relay')
    assert.doesNotMatch(exampleControl(painted), /no computer connected/i,
      'a quiet host must not be described to the visitor as no computer connected')

    connected = true
    announceDataSourceChange('host')
    await settle()
    assert.equal(currentDataSource(), 'relay')
    assert.doesNotMatch(exampleControl(painted), /\sdisabled(?=[\s/>])/)
    setExampleMode(true)
    await settle()
    toggle('example_mode', false)
    await save.handlers.get('click')()
    await settle()
    assert.equal(currentDataSource(), 'relay')
    assert.doesNotMatch(exampleControl(painted), /\sdisabled(?=[\s/>])/)

    /* AND THE REFUSAL KEEPS A PLACE WHERE IT IS TRUE: the seam itself goes away
       -- the desktop shell closes, or this page is opened in a plain browser --
       so there is no host left to be unreachable.  The first case in this file
       pins that state on a first paint; this pins the LIVE transition into it,
       which is how a visitor reaches it with Settings already open. */
    connected = false
    setBridgeTransport(null)
    delete window.mcShell
    announceDataSourceChange('host')
    await settle()
    assert.equal(currentDataSource(), 'mock')
    const refused = exampleControl(painted)
    assert.match(refused, /\sdisabled(?=[\s/>])/,
      'the example control stayed enabled after the host seam went away')
    assert.match(refused.match(/\stitle="([^"]+)"/)?.[1] ?? '', /no computer connected/i,
      'the disabled example control did not say that no computer is connected')
  } finally {
    view.destroy()
    delete window.mcShell
    setBridgeTransport(null)
  }
})

test('a pending Settings source refresh cannot repaint a destroyed view', async () => {
  stored.clear()
  window.mcShell = { getBridgeProof() {} }
  await resolveDataSource()
  const view = settingsView({ query: new URLSearchParams({ setting: 'example_mode' }) })
  try {
    await settle()
    let answer
    setBridgeTransport(null)
    window.mcShell = { getBridgeTransport: () => new Promise(resolve => { answer = resolve }) }
    announceDataSourceChange('host')
    await settle()
    assert.equal(typeof answer, 'function', 'the real resolver must reach the pending host read')
    view.destroy()
    const atDestroy = paints
    answer(null)
    await settle()
    assert.equal(paints, atDestroy)
  } finally {
    view.destroy()
    delete window.mcShell
    setBridgeTransport(null)
  }
})

test('a pending public Settings probe cannot overwrite a newer example choice', async () => {
  stored.clear()
  delete window.mcShell
  setBridgeTransport(null)
  setExampleMode(false)
  await resolveDataSource({ reask: true })
  const view = settingsView({ query: new URLSearchParams({ setting: 'example_mode' }) })
  try {
    await settle()
    let answer
    window.mcShell = { getBridgeTransport: () => new Promise(resolve => { answer = resolve }) }
    announceDataSourceChange('host')
    await settle()
    assert.equal(typeof answer, 'function')
    setExampleMode(true)
    assert.equal(currentDataSource(), 'mock')
    answer(async () => ({ ok: false, code: 'FIXTURE_TRANSPORT_ONLY' }))
    await settle()
    assert.equal(stored.get('mc.example'), 'on')
    assert.equal(currentDataSource(), 'mock', 'an older relay answer must not unbadge the newly chosen example')
    assert.equal(renderedRows.get('example_mode')?.querySelector('.settings-toggle input').checked, true)
    setExampleMode(false)
    await settle()
    assert.equal(currentDataSource(), 'relay', 'the actual transport remains available when the newer choice is later cleared')
  } finally {
    view.destroy()
    delete window.mcShell
    setBridgeTransport(null)
  }
})

/* TURNING AN ACCESSIBILITY SETTING BACK OFF, WHICH NOTHING ASSERTED ANYWHERE.
 *
 * Every existing off-again round trip for reduce motion goes through the GEAR
 * DRAWER, which writes and applies on the press (main.test.mjs:141-161,
 * quick-settings-storage.test.mjs:106-123). The settings-page row had one test
 * and it stopped at on-plus-Save. So the two surfaces' different commit models
 * were untested against each other, and
 * tools/appearance-persistence-drive.mjs -- which turned it on in the drawer and
 * off on the page, without Save -- reported "turning reduce motion off removes
 * its key and its applied class" and "reduce motion stays off after close and
 * reopen" as PRODUCT failures. They are not: measured 17/17 on the packaged
 * 1.0.44 Linux candidate once the drive presses Save.
 *
 * Both halves are pinned here: a press alone must NOT be durable (the page
 * promises "Changes take effect after you save"), and Save must remove the key
 * and the class -- off is the ABSENCE of the key, never the string "false",
 * because src/appearance-persistence.js:100 writes null on the default and
 * anything present-but-not-"true" would read back as a stored choice. */
test('the settings row turns reduce motion back off, and only Save makes that durable', async () => {
  stored.clear()
  document.body.classList.remove('reduce-motion')
  const view = settingsView({ query: new URLSearchParams({ setting: 'reduce_motion' }) })
  try {
    await settle()
    toggle('reduce_motion', true)
    await save.handlers.get('click')()
    await settle()
    assert.equal(stored.get('mc.set.reduce_motion'), 'true')
    assert.equal(document.body.classList.contains('reduce-motion'), true)

    toggle('reduce_motion', false)
    assert.equal(stored.get('mc.set.reduce_motion'), 'true',
      'mutation `write the row straight through instead of staging it` survived: this page promises the change waits for Save')
    assert.equal(document.body.classList.contains('reduce-motion'), true)
    assert.equal(root.dataset.settingsDirty, 'true')

    await save.handlers.get('click')()
    await settle()
    assert.equal(stored.has('mc.set.reduce_motion'), false,
      'mutation `store "false" instead of removing the key` survived: off is the absence of the key')
    assert.equal(document.body.classList.contains('reduce-motion'), false,
      'mutation `add the class without a matching remove` survived: expected the applied class to go')
    assert.equal(root.dataset.settingsDirty, 'false')
  } finally { view.destroy() }
})
