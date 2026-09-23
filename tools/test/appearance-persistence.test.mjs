/* GLOW INTENSITY AND REDUCE MOTION, WRITTEN DOWN.
 *
 * THE DEFECT, DRIVEN ON THE SHIPPED INSTALLER (1.0.20) BEFORE THIS EXISTED.
 * A person set both of them and closed the program:
 *
 *   settings page   Glow intensity dragged to 51 %, Reduce motion switched on.
 *                   Reopened: glow 100, reduce motion off.
 *   gear drawer     the same two controls, which are on EVERY page.
 *                   Pressed, applied, `--glow: 0.36` and body.reduce-motion on
 *                   the page. Reopened: `--glow` unset, the class gone, and
 *                   nothing in localStorage under either name.
 *
 * Ninety-eight other rows on that page survived the same restart. These two did
 * not, because they were the only two whose applied state lived ONLY in the DOM:
 * src/views/settings.js read glow back off the `--glow` custom property and
 * reduce motion off `document.body.classList`, and neither branch of
 * applyValue() ever called writeStored(). The controls were real, they applied
 * instantly, and the choice was thrown away when the window closed -- the exact
 * shape the owner has filed twice ("some of my settings buttons dont work").
 *
 * WHY THE RULES BELOW ARE THE RULES.
 *
 *   the default is not written down. Every other row on that page removes its
 *   key when the value returns to the shipped default, so an untouched install
 *   carries no appearance keys at all and a future change of default is not
 *   pinned by a stale write. These two follow it.
 *
 *   nothing is applied that was not stored. `--glow` unset and `--glow: 1` are
 *   not the same thing to a stylesheet that has its own fallback, so a launch
 *   that found nothing stored must leave the document exactly as it was.
 *
 *   storage that throws is not reported as an absent or successfully stored
 *   preference. The caller gets a coded could-not-tell error and may retry.
 *
 * Run: node --test tools/test/appearance-persistence.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import * as appearance from '../../src/appearance-persistence.js'
import { applyTextSize } from '../../src/text-size.js'

import {
  APPEARANCE_STORAGE_UNAVAILABLE,
  DEFAULT_GLOW,
  DEFAULT_REDUCE_MOTION,
  GLOW_KEY,
  GLOW_SETTING_ID,
  REDUCE_MOTION_KEY,
  REDUCE_MOTION_SETTING_ID,
  applyAppearance,
  rememberAppearance,
  storedAppearance,
} from '../../src/appearance-persistence.js'

/** A localStorage small enough to read, with a switch to make it throw. */
function fakeStorage(seed = {}, { throws = false } = {}) {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem(key) { if (throws) throw new Error('storage is not available'); return map.has(key) ? map.get(key) : null },
    setItem(key, value) { if (throws) throw new Error('storage is not available'); map.set(key, String(value)) },
    removeItem(key) { if (throws) throw new Error('storage is not available'); map.delete(key) },
  }
}

/** Only the three things applyAppearance() is allowed to touch. */
function fakeDocument() {
  const classes = new Set()
  const properties = new Map()
  const operations = []
  return {
    documentElement: { style: { setProperty(name, value) { operations.push(['property', name, value]); properties.set(name, String(value)) } } },
    body: {
      classList: {
        toggle(name, on) { operations.push(['class', name, on]); if (on) classes.add(name); else classes.delete(name) },
        contains(name) { return classes.has(name) },
      },
    },
    classes,
    operations,
    properties,
  }
}

/* ---------------------------------------------------------------- writing -- */

test('a glow that is not the default is written down', () => {
  const storage = fakeStorage()
  assert.equal(rememberAppearance(GLOW_SETTING_ID, 51, storage), 51)
  assert.equal(storage.map.get(GLOW_KEY), '51')
})

test('reduce motion switched on is written down', () => {
  const storage = fakeStorage()
  assert.equal(rememberAppearance(REDUCE_MOTION_SETTING_ID, true, storage), true)
  assert.equal(storage.map.get(REDUCE_MOTION_KEY), 'true')
})

test('a value returned to the shipped default removes its key', () => {
  const storage = fakeStorage({ [GLOW_KEY]: '51', [REDUCE_MOTION_KEY]: 'true' })
  rememberAppearance(GLOW_SETTING_ID, DEFAULT_GLOW, storage)
  rememberAppearance(REDUCE_MOTION_SETTING_ID, DEFAULT_REDUCE_MOTION, storage)
  assert.equal(storage.map.has(GLOW_KEY), false)
  assert.equal(storage.map.has(REDUCE_MOTION_KEY), false)
})

test('a glow outside the slider is brought back inside it', () => {
  const storage = fakeStorage()
  assert.equal(rememberAppearance(GLOW_SETTING_ID, 4000, storage), 200)
  assert.equal(rememberAppearance(GLOW_SETTING_ID, -8, storage), 0)
  assert.equal(storage.map.get(GLOW_KEY), '0')
})

test('a glow that is not a number is refused rather than stored', () => {
  const storage = fakeStorage({ [GLOW_KEY]: '51' })
  assert.equal(rememberAppearance(GLOW_SETTING_ID, 'bright', storage), null)
  assert.equal(storage.map.get(GLOW_KEY), '51')
})

test('a setting this module does not own is left alone', () => {
  const storage = fakeStorage()
  assert.equal(rememberAppearance('theme', 'tan', storage), null)
  assert.equal(storage.map.size, 0)
})

test('a transient storage failure is not absence or success and is not latched', () => {
  let busy = true
  const storage = fakeStorage({ [GLOW_KEY]: '51' })
  const getItem = storage.getItem
  storage.getItem = key => {
    if (busy) throw Object.assign(new Error('machine is busy'), { code: 'EBUSY' })
    return getItem.call(storage, key)
  }

  assert.throws(
    () => storedAppearance(storage),
    error => {
      assert.equal(error.code, APPEARANCE_STORAGE_UNAVAILABLE)
      assert.match(error.message, /does not mean the setting is absent/)
      assert.equal(error.cause.code, 'EBUSY')
      return true
    },
  )

  // CONTROL: a failed read is not cached or latched; the next read pays the
  // storage cost again and observes the value as soon as storage recovers.
  busy = false
  assert.deepEqual(storedAppearance(storage), { glow: 51, reduceMotion: null })

  const unavailable = fakeStorage({}, { throws: true })
  assert.throws(() => rememberAppearance(GLOW_SETTING_ID, 51, unavailable), {
    code: APPEARANCE_STORAGE_UNAVAILABLE,
  })
})

/* ---------------------------------------------------------------- reading -- */

test('nothing stored reads as nothing chosen', () => {
  assert.deepEqual(storedAppearance(fakeStorage()), { glow: null, reduceMotion: null })
})

test('what was stored is what comes back', () => {
  const storage = fakeStorage({ [GLOW_KEY]: '51', [REDUCE_MOTION_KEY]: 'true' })
  assert.deepEqual(storedAppearance(storage), { glow: 51, reduceMotion: true })
})

test('a stored value that is not readable reads as nothing chosen', () => {
  const storage = fakeStorage({ [GLOW_KEY]: 'bright', [REDUCE_MOTION_KEY]: 'perhaps' })
  assert.deepEqual(storedAppearance(storage), { glow: null, reduceMotion: null })
})

/* ---------------------------------------------------------------- applying - */

test('a launch with nothing stored leaves the document alone', () => {
  const documentRef = fakeDocument()
  const applied = applyAppearance({ documentRef, storage: fakeStorage() })
  assert.deepEqual(applied, { glow: null, reduceMotion: null })
  assert.equal(documentRef.properties.size, 0)
  assert.equal(documentRef.classes.size, 0)
})

test('a launch with both stored applies both', () => {
  const documentRef = fakeDocument()
  const storage = fakeStorage({ [GLOW_KEY]: '51', [REDUCE_MOTION_KEY]: 'true' })
  const applied = applyAppearance({ documentRef, storage })
  assert.deepEqual(applied, { glow: 51, reduceMotion: true })
  assert.equal(documentRef.properties.get('--glow'), '0.51')
  assert.equal(documentRef.body.classList.contains('reduce-motion'), true)
  assert.deepEqual(documentRef.operations, [
    ['property', '--glow', '0.51'],
    ['class', 'reduce-motion', true],
  ])
})

test('reduce motion stored as off is applied as off', () => {
  const documentRef = fakeDocument()
  documentRef.body.classList.toggle('reduce-motion', true)
  const applied = applyAppearance({ documentRef, storage: fakeStorage({ [REDUCE_MOTION_KEY]: 'false' }) })
  assert.equal(applied.reduceMotion, false)
  assert.equal(documentRef.body.classList.contains('reduce-motion'), false)
})

test('a document that is not there is not a crash', () => {
  assert.deepEqual(applyAppearance({ documentRef: null, storage: fakeStorage({ [GLOW_KEY]: '51' }) }), { glow: null, reduceMotion: null })
})

// Join the shipped durable-store hydration and the real appearance boot block.
// All account records and the bridge are fictional; no filesystem-backed
// account, provider, browser, or child process is used by this fixture.
const durableSource = fs.readFileSync(new URL('../../public/durable-storage.js', import.meta.url), 'utf8')
const mainSource = fs.readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const bootStart = mainSource.indexOf('try {\n  applyTextSize(')
const bootEnd = mainSource.indexOf('/* ---------- the phone canvas', bootStart)
assert.ok(bootStart > 0 && bootEnd > bootStart, 'the actual appearance boot block is present')
const appearanceBoot = mainSource.slice(bootStart, bootEnd)
const indexSource = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const firstPaint = [...indexSource.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(match => match[1].includes("localStorage.getItem('mc.theme')"))?.[1]
assert.ok(firstPaint, 'the actual theme/font first-paint script is present')
const ACCOUNT_A = 'a'.repeat(32), ACCOUNT_B = 'b'.repeat(32)
const DEVICE_APPEARANCE = { 'mc.theme': 'black', 'mc.font': 'grotesk', 'mc.text': '1.12', [GLOW_KEY]: '180', [REDUCE_MOTION_KEY]: 'true' }
const ACCOUNT_APPEARANCE = { 'mc.theme': 'cobalt', [GLOW_KEY]: '40', [REDUCE_MOTION_KEY]: 'false', 'mc.font': 'mono', 'mc.text': '0.9' }

function hydrationFixture(accountAppearance = ACCOUNT_APPEARANCE) {
  const documentRef = fakeDocument(), listeners = new Map(), writes = [], partitions = new Map([
    [ACCOUNT_A, accountAppearance], [ACCOUNT_B, { 'mc.theme': 'ember' }],
  ])
  documentRef.documentElement.dataset = {}
  documentRef.documentElement.style.removeProperty = name => documentRef.properties.delete(name)
  documentRef.body.style = {}
  let answerCurrent, currentId = ACCOUNT_A
  const firstCurrent = new Promise(resolve => { answerCurrent = resolve })
  let initial = true
  const window = {
    document: documentRef,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail } },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
    dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) || [])]) fn(event); return true },
    mcPrefs: {
      available: true, values: DEVICE_APPEARANCE, drainRequired: false,
      write(...args) { writes.push(['write', ...args]); return { ok: true } },
      remove(...args) { writes.push(['remove', ...args]); return { ok: true } },
    },
    mcAccount: {
      current() { if (initial) { initial = false; return firstCurrent } return Promise.resolve(currentId ? { signedIn: true, account: { id: currentId } } : { signedIn: false }) },
      data: async () => ({ ok: true, settingKeys: Object.keys(partitions.get(currentId) || {}) }),
      getSetting: async key => ({ ok: true, value: partitions.get(currentId)?.[key] }),
      putSetting(...args) { writes.push(['putSetting', ...args]); return Promise.resolve({ ok: true }) },
    },
  }
  const afterHydration = () => new Promise(resolve => {
    const done = () => { window.removeEventListener('mc:account-storage-rehydrated', done); resolve() }
    window.addEventListener('mc:account-storage-rehydrated', done)
  })
  const initialReady = afterHydration()
  vm.runInNewContext(durableSource, { window })
  const storage = window.localStorage
  vm.runInNewContext(firstPaint, { document: documentRef, localStorage: storage })
  function boot() {
    vm.runInNewContext(appearanceBoot, {
      localStorage: storage, TEXT_SIZE_KEY: 'mc.text',
      applyTextSize: value => applyTextSize(value, documentRef),
      applyStoredAppearance: () => applyAppearance({ documentRef, storage }),
      bindAppearanceAccountChanges: () => appearance.bindAppearanceAccountChanges({ windowRef: window, documentRef, storage }),
      initializeRoleColors() {}, startHandControls() {},
    })
  }
  return {
    documentRef, storage, writes, boot,
    async finishInitial() { answerCurrent({ signedIn: true, account: { id: ACCOUNT_A } }); await initialReady },
    async switchTo(id) { const ready = afterHydration(); currentId = id; window.mcDurableStorage.onAccountChanged(); await ready },
  }
}

function assertDeviceTextAndFont(f) {
  assert.equal(f.storage.getItem('mc.font'), 'grotesk')
  assert.equal(f.storage.getItem('mc.text'), '1.12')
  assert.match(f.documentRef.properties.get('--font-ui'), /Space Grotesk/)
  assert.equal(f.documentRef.body.style.zoom, '1.12')
  assert.deepEqual(f.writes, [], 'hydration must not write preferences or account settings')
}

test('delayed account hydration applies its glow and motion alongside theme without changing device text/font', async () => {
  const f = hydrationFixture()
  f.boot()
  assert.equal(f.documentRef.properties.get('--glow'), '1.8')
  assert.equal(f.documentRef.documentElement.dataset.theme, 'black')
  await f.finishInitial()
  assert.equal(f.storage.getItem(GLOW_KEY), '40')
  assert.equal(f.documentRef.documentElement.dataset.theme, 'cobalt')
  assert.equal(f.documentRef.properties.get('--glow'), '0.4', 'display must match the effective hydrated account setting')
  assert.equal(f.documentRef.body.classList.contains('reduce-motion'), false)
  assertDeviceTextAndFont(f)
})

test('switching to an account without appearance choices clears the prior account effects without writing defaults', async () => {
  const f = hydrationFixture({ ...ACCOUNT_APPEARANCE, [REDUCE_MOTION_KEY]: 'true' })
  await f.finishInitial()
  f.boot()
  assert.equal(f.documentRef.properties.get('--glow'), '0.4')
  assert.equal(f.documentRef.body.classList.contains('reduce-motion'), true)
  await f.switchTo(ACCOUNT_B)
  assert.equal(f.storage.getItem(GLOW_KEY), null)
  assert.equal(f.documentRef.documentElement.dataset.theme, 'ember')
  assert.equal(f.documentRef.properties.has('--glow'), false, 'absent account choice must not retain the preceding account glow')
  assert.equal(f.documentRef.body.classList.contains('reduce-motion'), false)
  assertDeviceTextAndFont(f)
})

test('signing out reapplies the retained device appearance without changing its saved keys', async () => {
  const f = hydrationFixture()
  await f.finishInitial()
  f.boot()
  await f.switchTo(null)
  assert.equal(f.storage.getItem(GLOW_KEY), '180')
  assert.equal(f.documentRef.documentElement.dataset.theme, 'black')
  assert.equal(f.documentRef.properties.get('--glow'), '1.8')
  assert.equal(f.documentRef.body.classList.contains('reduce-motion'), true)
  assertDeviceTextAndFont(f)
})
