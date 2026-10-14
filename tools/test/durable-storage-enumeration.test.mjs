/* WHAT THE REPLACED `localStorage` SAYS WHEN SOMETHING ASKS WHAT IS IN IT.
 *
 * public/durable-storage.js used to answer `Object.keys(localStorage)` with its
 * own five method names and `length`. On 2026-09-20 a probe read that as a
 * backup of the owner's settings, cleared the store, and wrote the six pairs
 * back; six trees, 82 agent nodes and every preference went, and the record was
 * left holding keys called `getItem`, `clear` and `length` -- which it still
 * holds today, so every case below is a case the owner's record is in.
 *
 * The rule under test is the platform's, not an invention: Storage is a legacy
 * platform object without [LegacyOverrideBuiltIns], so a stored key whose name
 * the object or its prototype chain already carries is NOT exposed as an own
 * property and is reachable only through getItem(). It still counts in length
 * and still appears in key(i). Confirmed against node --experimental-webstorage,
 * which implements the same algorithm:
 *   Object.keys           -> the visible keys only
 *   getOwnPropertyNames   -> every stored key, including the hidden ones
 *   gOPD('getItem')       -> undefined, while localStorage.getItem is the method
 *
 * These tests evaluate the real shipped file, as tools/test/durable-storage.test.mjs
 * does.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'public', 'durable-storage.js'), 'utf8')

/* The six names the bad restore left in the owner's record, with the text it
   wrote under them, plus the settings a person would actually have. */
const JUNK = {
  getItem: 'function getItem(key) { [native code] }',
  setItem: 'function setItem(key, value) { [native code] }',
  removeItem: 'function removeItem(key) { [native code] }',
  clear: 'function clear() { [native code] }',
  key: 'function key(index) { [native code] }',
  length: '107',
}
const REAL = {
  'mc.theme': 'black',
  'mc.write.agent-session': 'enabled',
  'mc.fleet.trees.v1:home': '{"nodes":[]}',
  'mc.text': '1.12',
}

function install(values = {}) {
  const store = new Map(Object.entries(values))
  const warnings = []
  const window = {
    console: { warn: (...parts) => warnings.push(parts.join(' ')) },
    localStorage: { length: 0, key: () => null, getItem: () => null },
    mcPrefs: {
      available: true,
      values,
      drainRequired: false,
      write(key, value) { store.set(key, value); return { ok: true } },
      remove(key) { store.delete(key); return { ok: true } },
      clear() { store.clear(); return { ok: true } },
      drain: () => ({ ok: true, values: {} }),
    },
  }
  vm.runInNewContext(SOURCE, { window })
  return { storage: window.localStorage, store, warnings }
}

function typed(value) { return typeof value === 'function' ? `FUNCTION(${value.name})` : value }

test('Object.keys answers the stored keys, not the store\'s own methods', () => {
  const { storage } = install({ 'mc.theme': 'black', 'mc.write.agent-session': 'enabled' })

  assert.deepEqual(Object.keys(storage).sort(), ['mc.theme', 'mc.write.agent-session'])
})

test('an empty store enumerates as empty rather than as six methods', () => {
  const { storage } = install()

  assert.deepEqual(Object.keys(storage), [])
  assert.deepEqual(Object.entries(storage), [])
  assert.equal(JSON.stringify(storage), '{}')
})

test('Object.entries answers pairs of strings, never a method', () => {
  const { storage } = install({ ...JUNK, ...REAL })

  const entries = Object.entries(storage).map(([key, value]) => [key, typed(value)])
  assert.deepEqual(Object.fromEntries(entries), REAL)
  assert.equal(entries.some(([, value]) => String(value).startsWith('FUNCTION')), false)
})

test('spread copies the stored pairs, and the copy is structuredClone-able', () => {
  const { storage } = install({ ...JUNK, ...REAL })

  const copy = { ...storage }
  assert.deepEqual(copy, REAL)
  assert.deepEqual(structuredClone(copy), REAL)
})

test('JSON.stringify serialises every key it reports, dropping none', () => {
  const { storage } = install({ ...JUNK, ...REAL })

  const text = JSON.stringify(storage)
  assert.deepEqual(JSON.parse(text), REAL)
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), Object.keys(storage).sort())
})

test('for...in yields the stored keys and no method names', () => {
  const { storage } = install({ ...JUNK, ...REAL })

  const seen = []
  for (const key in storage) seen.push(key)
  assert.deepEqual(seen.sort(), Object.keys(REAL).sort())
})

test('`in` answers about members and about contents, and says no to neither', () => {
  const { storage } = install({ ...JUNK, ...REAL })

  assert.equal('key' in storage, true)           // the method, as on the platform
  assert.equal('length' in storage, true)
  assert.equal('mc.theme' in storage, true)      // a stored key
  assert.equal('mc.nothing' in storage, false)   // neither
  assert.equal('toString' in storage, true)      // inherited, as on the platform
})

/* THE CASE THE OWNER'S RECORD IS IN. Every trap has to give the SAME answer
   about a key named after a member, or a snapshot silently collects methods. */
test('a stored key named after a member is hidden from own properties and reaches the method', () => {
  const { storage } = install({ ...JUNK, ...REAL })

  for (const name of Object.keys(JUNK)) {
    assert.equal(Object.getOwnPropertyDescriptor(storage, name), undefined, `${name} is not an own property`)
    assert.equal(Object.keys(storage).includes(name), false, `${name} is not enumerated`)
    assert.equal(typeof storage[name], name === 'length' ? 'number' : 'function', `${name} still reaches the member`)
    assert.equal(storage.getItem(name), JUNK[name], `${name} is still readable through getItem`)
  }
  assert.equal(typeof storage.getItem, 'function')
  assert.equal(typeof storage.clear, 'function')
})

test('the hidden keys are still discoverable, counted and walkable', () => {
  const { storage } = install({ ...JUNK, ...REAL })
  const all = { ...JUNK, ...REAL }

  assert.equal(storage.length, Object.keys(all).length)
  const walked = []
  for (let index = 0; index < storage.length; index += 1) walked.push(storage.key(index))
  assert.deepEqual(walked.sort(), Object.keys(all).sort())
  assert.deepEqual(Object.getOwnPropertyNames(storage).sort(), Object.keys(all).sort())
  assert.equal(storage.key(Object.keys(all).length), null)
})

test('the store says out loud that it is hiding keys', () => {
  const { warnings } = install({ ...JUNK, ...REAL })

  assert.equal(warnings.length, 1)
  for (const name of Object.keys(JUNK)) assert.equal(warnings[0].includes(name), true, `the notice names ${name}`)
  assert.equal(install(REAL).warnings.length, 0, 'a clean record says nothing')
})

/* A write that is not durable must not look like one. A browser stores
   `localStorage.getItem = 'x'` under that name and then cannot read it back
   through that same expression; a plain object would have parked the value on
   the store and lost it at the next launch. Both are refused here, loudly. */
test('a named write is durable, and a write aimed at a member is a TypeError', () => {
  const { storage, store } = install(REAL)

  storage['mc.named'] = 'saved'
  assert.equal(store.get('mc.named'), 'saved')
  assert.equal(storage.getItem('mc.named'), 'saved')
  assert.equal(Object.keys(storage).includes('mc.named'), true)

  assert.throws(() => { 'use strict'; storage.getItem = 'clobber' }, TypeError)
  assert.equal(typeof storage.getItem, 'function')
  assert.throws(() => Object.defineProperty(storage, 'clear', { value: 'x' }), TypeError)
  assert.equal(typeof storage.clear, 'function')
})

test('delete removes the stored key and refuses to remove a member', () => {
  const { storage, store } = install({ ...JUNK, ...REAL })

  assert.equal(delete storage['mc.theme'], true)
  assert.equal(store.has('mc.theme'), false)
  assert.throws(() => { 'use strict'; delete storage.getItem }, TypeError)
  assert.equal(typeof storage.getItem, 'function')
  assert.equal(storage.getItem('getItem'), JUNK.getItem, 'removeItem is still the way to drop it')
  storage.removeItem('getItem')
  assert.equal(storage.getItem('getItem'), null)
  assert.equal(typeof storage.getItem, 'function')
})

/* ---- THE INCIDENT, END TO END, ON THE RECORD IT LEFT BEHIND ---- */

test('the object snapshot / clear / restore round trip keeps every setting it reported', () => {
  const { storage } = install({ ...JUNK, ...REAL })

  const snapshot = { ...storage }
  storage.clear()
  for (const [key, value] of Object.entries(snapshot)) storage.setItem(key, value)

  for (const [key, value] of Object.entries(REAL)) assert.equal(storage.getItem(key), value, `${key} came back`)
  assert.equal(storage.getItem('mc.write.agent-session'), 'enabled', 'the switch that lets a person press Start')
  assert.equal(Object.keys(storage).length, Object.keys(REAL).length)
  assert.equal(typeof storage.getItem, 'function')
  assert.equal(storage.getItem('getItem'), null, 'the wreckage of the last incident is not re-created')
})

test('the documented Storage walk backs up everything, hidden keys included', () => {
  const { storage } = install({ ...JUNK, ...REAL })

  const snapshot = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    snapshot.push([key, storage.getItem(key)])
  }
  storage.clear()
  for (const [key, value] of snapshot) storage.setItem(key, value)

  assert.deepEqual(Object.fromEntries(snapshot), { ...JUNK, ...REAL })
  for (const [key, value] of Object.entries({ ...JUNK, ...REAL })) assert.equal(storage.getItem(key), value)
  assert.equal(typeof storage.getItem, 'function')
})

/* ---- A SYMBOL IS NOT A NAMED PROPERTY, AND A REFUSAL MUST NOT SAVE FIRST ----
 *
 * `get`, `has` and `getOwnPropertyDescriptor` hand a non-string key straight to
 * Reflect; `set`, `defineProperty` and `deleteProperty` have to do the same, or
 * `store[Symbol(...)] = x` -- how a library tags an object it did not write --
 * becomes a TypeError in a renderer for a rule that is only ever about names.
 * Before this file grew a Proxy that write simply worked.
 *
 * And `Object.defineProperty(store, name, { value, configurable: false })` asks
 * for a cell this store cannot keep. Answering `true` to it makes the Proxy
 * specification throw AFTER setItem has already saved the value; the refusal
 * belongs before the write.
 */
test('a symbol-keyed write is accepted and reads back, as it did before the Proxy', () => {
  const { storage, store } = install({ 'mc.theme': 'black' })
  const tag = Symbol('library tag')

  storage[tag] = 'marked'

  assert.equal(storage[tag], 'marked')
  assert.equal(tag in storage, true)
  assert.equal(store.has('mc.theme'), true, 'the settings file was not touched by a symbol')
  assert.equal(store.size, 1, 'a symbol is not a stored setting')
  assert.deepEqual(Object.keys(storage), ['mc.theme'], 'and it is not enumerated as one')
})

test('Object.defineProperty and delete accept a symbol too', () => {
  const { storage } = install({ 'mc.theme': 'black' })
  const tag = Symbol('library tag')

  Object.defineProperty(storage, tag, { value: 'marked', configurable: true, writable: true })
  assert.equal(storage[tag], 'marked')

  assert.equal(delete storage[tag], true)
  assert.equal(storage[tag], undefined)
  assert.deepEqual(Object.keys(storage), ['mc.theme'])
})

test('a non-configurable defineProperty is refused BEFORE anything is saved', () => {
  const { storage, store } = install({ 'mc.theme': 'black' })

  assert.throws(() => Object.defineProperty(storage, 'mc.locked', { value: 'v', configurable: false }), TypeError)
  assert.equal(store.has('mc.locked'), false, 'the refusal did not leave the value in the settings file')
  assert.equal(storage.getItem('mc.locked'), null)
  assert.equal(Object.keys(storage).includes('mc.locked'), false)
})

test('an ordinary defineProperty still saves, and a member name is still refused', () => {
  const { storage, store } = install({ 'mc.theme': 'black' })

  Object.defineProperty(storage, 'mc.named', { value: 'saved' })
  assert.equal(store.get('mc.named'), 'saved')
  assert.equal(storage.getItem('mc.named'), 'saved')

  assert.throws(() => Object.defineProperty(storage, 'clear', { value: 'x' }), TypeError)
  assert.equal(typeof storage.clear, 'function')
  assert.throws(() => { storage.getItem = 'clobber' }, TypeError)
  assert.equal(typeof storage.getItem, 'function')
})
