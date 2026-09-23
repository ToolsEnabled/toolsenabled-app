// Refusals must remain visible even when a caller swallows the storage error.
// All capacity examples in this suite are synthetic fixtures, not live measurements.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { mountSettingsRecoveryNotice, settingsRecoveryNotice } from '../../src/settings-recovery-notice.js'
import { safeTreeStorage } from '../../src/fleet-trees.js'
import { createRecoveryHandoffStore } from '../../src/recovery-handoff-store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'durable-storage.js'), 'utf8')

const RECORD = 'C:\\Users\\someone\\AppData\\Roaming\\ToolsEnabled\\renderer-prefs.json'
const TOO_LARGE = {
  ok: false,
  error: { code: 'MC_PREFS_TOO_LARGE', message: 'The settings file would exceed its size limit.' },
}

/* The bridge the preload exposes, with every write refused the way persist()
   refuses once the ordinary record is over its ceiling. */
function installWithRefusingBridge(failure = TOO_LARGE) {
  const window = {
    localStorage: { length: 0, key: () => null, getItem: () => null },
    mcPrefs: {
      available: true,
      values: { 'mc.theme': 'black' },
      file: RECORD,
      drainRequired: false,
      write: () => failure,
      remove: () => failure,
      clear: () => failure,
    },
  }
  vm.runInNewContext(SOURCE, { window })
  return window
}

/* ---------- the sentence ---------- */

test('a refused save produces a notice that names the setting and the reason', () => {
  const notice = settingsRecoveryNotice({
    damaged: null,
    file: RECORD,
    preservedAt: null,
    refused: { code: 'MC_PREFS_TOO_LARGE', key: 'mc.theme', action: 'save', message: 'The settings file would exceed its size limit.' },
  })

  assert.ok(notice, 'a refused save must produce a notice, not silence')
  assert.equal(notice.kind, 'refused')
  assert.match(notice.body, /mc\.theme/, 'the person must be told WHICH setting did not save')
  assert.match(notice.body, /not saved|could not be saved|was not saved/i,
    'the notice must say the change did not take effect')
})

test('a refusal outranks the damaged-file notice, because it is the live problem', () => {
  /* Both can be true at once. The damaged notice explains why the window opened
     on defaults; the refusal explains why the change the person made seconds ago
     did not stick. The second is the one they are looking at the screen about. */
  const notice = settingsRecoveryNotice({
    damaged: 'the settings file contains malformed JSON',
    file: RECORD,
    preservedAt: null,
    refused: { code: 'MC_PREFS_TOO_LARGE', key: 'mc.text', action: 'save', message: 'The settings file would exceed its size limit.' },
  })

  assert.equal(notice.kind, 'refused', 'the live refusal must win over the historical damage report')
})

test('no refusal leaves every existing notice exactly as it was', () => {
  /* The existing suite pins these. This asserts the new field cannot change them
     when it is absent, which is the regression that would matter. */
  assert.equal(settingsRecoveryNotice({ damaged: null, file: RECORD, preservedAt: null }), null)
  const damaged = settingsRecoveryNotice({ damaged: 'the settings file contains malformed JSON', file: RECORD, preservedAt: null })
  assert.equal(damaged.kind, 'damaged')
})

/* ---------- the publication ---------- */

test('a refused write is published to the notice channel AND still throws', () => {
  const window = installWithRefusingBridge()

  assert.throws(() => window.localStorage.setItem('mc.theme', 'tan'), /Could not save/,
    'the throw is the existing contract and must not be softened away')

  const state = window.mcPrefsNotice.read()
  assert.ok(state.refused, 'the refusal must reach the channel the product explains settings through')
  assert.equal(state.refused.code, 'MC_PREFS_TOO_LARGE')
  assert.equal(state.refused.key, 'mc.theme')
})

test('A CALL SITE THAT SWALLOWS THE THROW STILL CANNOT HIDE IT', () => {
  /* This is the defect. Roughly fifteen call sites in src/ do exactly this, and
     the store's own comment says so. Before the fix, this loop produced a person
     whose settings silently stopped saving and a log with nothing in it. */
  const window = installWithRefusingBridge()

  try { window.localStorage.setItem('mc.text', 'large') } catch { /* the swallowing call site */ }

  const state = window.mcPrefsNotice.read()
  assert.ok(state.refused, 'a swallowed throw must not become a silent failure')
  assert.equal(state.refused.key, 'mc.text')
})

test('subscribers are told at the moment of refusal, not only on a later read', () => {
  const window = installWithRefusingBridge()
  const seen = []
  window.mcPrefsNotice.subscribe(state => seen.push(state.refused ? state.refused.code : null))

  try { window.localStorage.setItem('mc.theme', 'tan') } catch { /* swallowed */ }

  assert.ok(seen.includes('MC_PREFS_TOO_LARGE'),
    'a mounted notice only updates if it is announced; a read-only fix would leave the screen stale')
})

test('a removal that is refused is reported too, not only a save', () => {
  const window = installWithRefusingBridge()
  try { window.localStorage.removeItem('mc.theme') } catch { /* swallowed */ }
  const state = window.mcPrefsNotice.read()
  assert.ok(state.refused, 'a refused removal leaves the old value on disk and must be reported')
  assert.equal(state.refused.action, 'remove')
})

/* ---------- the path that matters most: the recovery handoff ---------- */

test('THE HANDOFF PATH: a lost continuation checkpoint is reported, through TWO layers that swallow it', () => {
  // A real bounded handoff passes through both storage wrappers, which contain
  // errors. The notification must survive those catches and reach the surface.
  const window = installWithRefusingBridge()
  const store = createRecoveryHandoffStore({
    computerId: 'this-computer',
    storage: safeTreeStorage(window.localStorage),
  })

  const saved = store.save('node-7', { handoff: 'h'.repeat(43_000), sessionId: 's-1', recoveryId: 'r-1' })

  assert.equal(saved, false, 'the store reports the failure to its caller, as it always did')

  const state = window.mcPrefsNotice.read()
  assert.ok(state.refused, 'a lost continuation checkpoint must not be silent')
  assert.equal(state.refused.code, 'MC_PREFS_TOO_LARGE')
  assert.match(state.refused.key, /agent-recovery/,
    'the notice must name the recovery record, so the loss can be identified')
})

/* ---------- what the person actually sees ---------- */

class FakeElement {
  constructor(doc, tagName) {
    this.doc = doc
    this.tagName = tagName
    this.attributes = new Map()
    this.listeners = new Map()
    this.children = []
    this.parentNode = null
    this._text = ''
  }
  set textContent(value) { this._text = String(value); this.children = [] }
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._text }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child }
  removeChild(child) { this.children = this.children.filter(e => e !== child); child.parentNode = null; return child }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(listener)
  }
}
class FakeDocument {
  constructor() { this.body = new FakeElement(this, 'body') }
  createElement(tagName) { return new FakeElement(this, tagName) }
}

test('THE PERSON IS TOLD: the refusal reaches the screen, not just the return value', () => {
  /* The whole point of the item. Asserted on the rendered text of the mounted
     element -- a fix that returns a richer error object but paints nothing would
     pass a weaker test and change nothing for the person.
     Note: assertions are on STRINGS, never on the stand-in nodes themselves. */
  const doc = new FakeDocument()
  let state = { damaged: null, file: RECORD, preservedAt: null }
  const listeners = []
  const source = {
    read: () => state,
    subscribe(listener) { listeners.push(listener); return () => {} },
  }

  const handle = mountSettingsRecoveryNotice({ doc, source, container: doc.body })
  assert.equal(handle.element(), null, 'a healthy store paints nothing')

  state = {
    ...state,
    refused: { code: 'MC_PREFS_TOO_LARGE', key: 'mc.theme', action: 'save', message: 'The settings file would exceed its size limit.' },
  }
  for (const listener of listeners) listener(state)

  const element = handle.element()
  assert.ok(element, 'after a refusal the person must have something on screen')
  const shown = element.textContent
  assert.match(shown, /mc\.theme/, 'the screen must name the setting that did not save')
  assert.match(shown, /not saved|could not be saved|was not saved/i)
})

test('a real ceiling refusal reaches the mounted notice and preserves disk plus renderer cache', async () => {
  const { createRequire } = await import('node:module')
  const { randomUUID } = await import('node:crypto')
  const { tmpdir } = await import('node:os')
  const require = createRequire(import.meta.url)
  const { createRendererPrefs, MAX_RECORD_BYTES } = require('../../shell/renderer-prefs.cjs')
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'te-capacity-visible-'))
  try {
    const values = { 'mc.theme': 'black', padding: '' }
    for (let index = 0; index < 22; index += 1) {
      values[`mc.agent-recovery.v1:c:n${index}`] = JSON.stringify({ v: 1, handoff: 'h'.repeat(47_000) })
    }
    const record = { storageVersion: 1, values, drainedOrigins: [] }
    values.padding = 'x'.repeat(MAX_RECORD_BYTES - Buffer.byteLength(JSON.stringify(record)))
    assert.equal(Buffer.byteLength(JSON.stringify(record)), MAX_RECORD_BYTES)
    const file = path.join(directory, 'renderer-prefs.json')
    fs.writeFileSync(file, JSON.stringify(record) + '\n')
    const before = fs.readFileSync(file)
    const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
    const window = { mcPrefs: { available: true, values: prefs.snapshot().values, file,
      write: (key, value) => prefs.set(key, value), remove: key => prefs.remove(key), clear: () => prefs.clear() } }
    vm.runInNewContext(SOURCE, { window })
    const doc = new FakeDocument()
    const handle = mountSettingsRecoveryNotice({ doc, source: window.mcPrefsNotice })
    assert.equal(handle.element(), null)
    try { window.localStorage.setItem('mc.theme', 'longer-choice') } catch { /* production callers contain this throw */ }
    assert.equal(window.mcPrefsNotice.read().refused.code, 'MC_PREFS_TOO_LARGE')
    assert.match(handle.element().textContent, /mc\.theme.*not saved/)
    assert.equal(window.localStorage.getItem('mc.theme'), 'black')
    assert.deepEqual(fs.readFileSync(file), before)
    const reopened = createRendererPrefs({ directory, fs, path, randomUUID })
    assert.equal(reopened.snapshot().values['mc.theme'], 'black')
    assert.equal(Object.keys(reopened.snapshot().values).filter(key => key.startsWith('mc.agent-recovery')).length, 22)
    handle.destroy()
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('a refused clear or removal keeps cached values and reports the refusal', () => {
  for (const operation of ['clear', 'removeItem']) {
    const window = installWithRefusingBridge()
    try { window.localStorage[operation]('mc.theme') } catch { /* swallowed */ }
    assert.equal(window.localStorage.getItem('mc.theme'), 'black')
    assert.equal(window.mcPrefsNotice.read().refused.code, 'MC_PREFS_TOO_LARGE')
  }
})

test('a thrown IPC failure is visible without changing the cached preference', () => {
  const window = installWithRefusingBridge()
  window.mcPrefs.write = () => { throw new Error('bridge disconnected') }
  try { window.localStorage.setItem('mc.theme', 'tan') } catch { /* swallowed */ }
  assert.equal(window.mcPrefsNotice.read().refused.code, 'MC_PREFS_WRITE_FAILED')
  assert.equal(window.localStorage.getItem('mc.theme'), 'black')
})

test('an unrelated successful write does not conceal the unsaved change', () => {
  const window = installWithRefusingBridge()
  try { window.localStorage.setItem('mc.theme', 'tan') } catch { /* swallowed */ }
  window.mcPrefs.write = () => ({ ok: true })
  window.localStorage.setItem('mc.text', 'large')
  assert.equal(window.mcPrefsNotice.read().refused.key, 'mc.theme')
  window.localStorage.setItem('mc.theme', 'tan')
  assert.equal(window.mcPrefsNotice.read().refused, null)
})

test('a new refusal is visible after the startup notice or an earlier refusal was dismissed', () => {
  const window = installWithRefusingBridge()
  const doc = new FakeDocument()
  const handle = mountSettingsRecoveryNotice({ doc, source: window.mcPrefsNotice })
  const fail = () => { try { window.localStorage.setItem('mc.theme', 'tan') } catch {} }
  fail()
  const dismiss = handle.element().children.find(child => child.tagName === 'button')
  for (const listener of dismiss.listeners.get('click')) listener()
  assert.equal(handle.element(), null)
  fail()
  assert.match(handle.element().textContent, /mc\.theme.*not saved/)
})

test('a bridged recovery save refusal reaches the mounted global notice even away from Computers', async () => {
  const window = installWithRefusingBridge()
  const doc = new FakeDocument()
  const handle = mountSettingsRecoveryNotice({ doc, source: window.mcPrefsNotice })
  const bridge = { get: async () => ({ ok: true, record: null }),
    save: async () => ({ ok: false, error: { code: 'RECOVERY_RECORD_TOO_LARGE' } }) }
  const store = createRecoveryHandoffStore({ computerId: 'c', storage: safeTreeStorage(window.localStorage), bridge,
    onWriteResult: (nodeId, answer) => window.mcPrefsNotice.reportRecoveryWrite(nodeId, answer) })
  assert.equal(await store.saveRecord('n', { handoff: 'h'.repeat(48_000), extra: 'x'.repeat(30_000) }), false)
  assert.match(handle.element().textContent, /recovery checkpoint was not saved/)
  assert.match(handle.element().textContent, /exceeds its size limit/)
  assert.equal(window.localStorage.getItem('mc.agent-recovery.v1:c:n'), null)
  bridge.save = async () => ({ ok: true })
  assert.equal(await store.saveRecord('n', { handoff: 'bounded' }), true)
  assert.equal(handle.element(), null)
})
