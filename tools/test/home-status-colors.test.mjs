import test from 'node:test'
import assert from 'node:assert/strict'
import { HOME_STATUS_COLORS_EVENT, HOME_STATUS_COLOR_SETTINGS, currentHomeStatusColor, defaultHomeStatusColors, resolvedHomeStatusColor, setHomeStatusColor, mountHomeStatusColors } from '../../src/home-status-colors.js'
import { createSettingsDraft } from '../../src/settings-draft.js'

function fixture() {
  const values = new Map(), events = new EventTarget(), changes = []
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  events.addEventListener(HOME_STATUS_COLORS_EVENT, event => changes.push({ ...event.detail, saved: currentHomeStatusColor(event.detail.status, storage, event.detail.theme) }))
  return { values, storage, events, changes }
}

test('three independent colors use theme defaults until deliberately overridden', () => {
  const f = fixture()
  assert.deepEqual(HOME_STATUS_COLOR_SETTINGS.map(item => item.status), ['clear', 'attention', 'blocked'])
  for (const { status } of HOME_STATUS_COLOR_SETTINGS) {
    assert.equal(currentHomeStatusColor(status, f.storage), 'auto')
    assert.equal(new Set(['white', 'tan', 'black', 'ember', 'cobalt'].map(theme => defaultHomeStatusColors(theme)[status])).size, 5)
  }
  setHomeStatusColor('attention', '#Ab9012', f)
  assert.equal(currentHomeStatusColor('attention', f.storage), '#ab9012')
  assert.equal(currentHomeStatusColor('clear', f.storage), 'auto')
  for (const theme of ['white', 'tan', 'black', 'ember', 'cobalt']) assert.equal(resolvedHomeStatusColor('attention', theme, '#ab9012'), '#ab9012')
  assert.deepEqual(f.changes, [{ status: 'attention', value: '#ab9012', theme: 'white', saved: '#ab9012' }])
  setHomeStatusColor('attention', 'auto', f)
  assert.equal(f.values.size, 0)
})

test('colors are remembered separately for each theme, preserving and resetting legacy choices', () => {
  const f = fixture()
  f.values.set('mc.set.home_circle_clear_color', '#116644')
  assert.equal(currentHomeStatusColor('clear', f.storage, 'tan'), '#116644')
  setHomeStatusColor('clear', '#227766', { ...f, theme: 'ember' })
  assert.equal(currentHomeStatusColor('clear', f.storage, 'ember'), '#227766')
  assert.equal(currentHomeStatusColor('clear', f.storage, 'tan'), '#116644')
  setHomeStatusColor('clear', 'auto', { ...f, theme: 'ember' })
  assert.equal(currentHomeStatusColor('clear', f.storage, 'ember'), 'auto')
  assert.equal(currentHomeStatusColor('clear', f.storage, 'tan'), '#116644')
  setHomeStatusColor('blocked', '#ff8877', { ...f, theme: 'cobalt' })
  assert.equal(currentHomeStatusColor('blocked', f.storage, 'cobalt'), '#ff8877')
  for (const theme of ['white', 'tan', 'black', 'ember']) assert.equal(currentHomeStatusColor('blocked', f.storage, theme), 'auto')
})

test('invalid and failed color writes never announce a false saved choice', async () => {
  const f = fixture(), draft = createSettingsDraft()
  for (const value of ['red', 'url(example)', '#12345g', '#abc', '']) assert.throws(() => setHomeStatusColor('clear', value, f), /six-digit/)
  assert.deepEqual(f.changes, [])
  const broken = { getItem() { throw new Error('unreadable') }, setItem() { throw new Error('read-only') }, removeItem() { throw new Error('read-only') } }
  assert.equal(currentHomeStatusColor('clear', broken), 'auto')
  draft.stage('color', '#116644', value => setHomeStatusColor('clear', value, { storage: broken, events: f.events }))
  await assert.rejects(draft.save(), /read-only/)
  assert.equal(draft.dirty, true)
  assert.deepEqual(f.changes, [])
})

test('mounted palette follows theme/custom changes and stops listening on teardown', t => {
  const f = fixture(), values = new Map(), root = { dataset: { theme: 'white' } }
  const host = { style: { getPropertyValue: key => values.get(key), setProperty: (key, value) => values.set(key, value) } }
  let observer
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
  Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: class { constructor(callback) { this.callback = callback; observer = this } observe() {} disconnect() { this.disconnected = true } } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'MutationObserver', previous); else delete globalThis.MutationObserver })
  const mount = mountHomeStatusColors(host, { root, events: f.events, storage: f.storage })
  assert.equal(values.get('--home-ledger-attention'), defaultHomeStatusColors('white').attention)
  root.dataset.theme = 'black'; observer.callback()
  assert.equal(values.get('--home-ledger-attention'), defaultHomeStatusColors('black').attention)
  setHomeStatusColor('attention', '#765432', { ...f, theme: 'black' })
  assert.equal(values.get('--home-ledger-attention'), '#765432')
  setHomeStatusColor('attention', '#eeee22', { ...f, theme: 'tan' })
  assert.equal(values.get('--home-ledger-attention'), '#765432', 'editing another theme does not recolor this one')
  mount.destroy()
  assert.equal(observer.disconnected, true)
  setHomeStatusColor('attention', '#123456', { ...f, theme: 'black' })
  assert.equal(values.get('--home-ledger-attention'), '#765432')
})
