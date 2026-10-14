/* THE COMPARE ROW HAS TO REACH THE PAINTED PAGE, not merely exist in a table.
 *
 * tools/test/diff-editor-settings-row.test.mjs holds everything about the row
 * EXCEPT the one thing T348 is a report about: whether opening Settings and
 * going to the section actually puts it on screen. That suite calls rowMarkup()
 * and rowMessage() directly, so it stays green for a row that no category
 * renders -- a section dropped from the group table, a mode gate the row can
 * never satisfy, or a category slug that resolves to somewhere else would all
 * pass it. This drives settingsView() itself and reads what it painted.
 *
 * NOTHING HERE PINS A SPELLING. The action token and the section name are read
 * off the row's own declaration, so renaming either keeps this green; removing
 * the row from the page does not. The two states the row has -- live where the
 * window can open, disabled with its reason where it cannot -- are exercised by
 * supplying and withholding the host bridge, which is the fact the row's own
 * `blockedReason` is a function of.
 *
 * MEASURED at the cut base while T348 was open: the row DID paint, in
 * 'App permissions', at min-mode `advanced` with the page's default mode also
 * `advanced`, and its control was present. It was disabled only where no host
 * bridge was on the window. This suite is what keeps that true.
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const stored = new Map()
const listeners = new Map()
let painted = ''

const classList = () => ({ add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false })
function node() {
  return {
    dataset: {}, value: '', checked: false, textContent: '', hidden: false,
    classList: classList(),
    style: { setProperty: () => {}, getPropertyValue: () => '' },
    addEventListener: () => {}, removeEventListener: () => {},
    setAttribute: () => {}, removeAttribute: () => {}, toggleAttribute: () => {},
    getAttribute: () => null, querySelector: () => node(), querySelectorAll: () => [],
    closest: () => null, contains: () => true, children: [],
    appendChild(child) { this.children.push(child); return child },
    getBoundingClientRect: () => ({ top: 0 }), getClientRects: () => [{ top: 0 }],
    scrollIntoView: () => {}, focus: () => {},
  }
}

const sections = node()
Object.defineProperty(sections, 'innerHTML', { get: () => painted, set: value => { painted = String(value) } })
const root = node()
root.querySelector = selector => (selector === '.settings-sections' ? sections : node())
root.querySelectorAll = () => []

globalThis.document = {
  createElement: () => ({ set innerHTML(value) { this.value = value }, content: { firstElementChild: root } }),
  documentElement: node(), body: node(), getElementById: () => null,
}
globalThis.localStorage = {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: key => stored.delete(key),
}
globalThis.window = {
  addEventListener: (type, listener) => {
    const group = listeners.get(type) || new Set()
    group.add(listener)
    listeners.set(type, group)
  },
  removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
  dispatchEvent: event => { for (const listener of listeners.get(event.type) || []) listener(event); return true },
  matchMedia: () => ({ matches: false }),
}
globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail } }
globalThis.requestAnimationFrame = callback => { callback(); return 1 }
globalThis.cancelAnimationFrame = () => {}

const { SETTINGS, settingsView } = await import('../../src/views/settings.js')
const { categorySlug } = await import('../../src/settings-presentation.js')

const row = SETTINGS.find(setting => setting.id === 'compare_files')

function paint(query) {
  painted = ''
  settingsView({ query, navigate: () => {} })
  return painted
}

/* The control the page draws for this row, whatever the row calls its action. */
function controlFor(markup, action) {
  const match = markup.match(new RegExp(`<button[^>]*data-setting-action="${action}"[^>]*>`))
  return match ? match[0] : null
}

test('opening the section the row declares puts the row on the page', () => {
  assert.ok(row, 'the settings catalogue no longer declares a compare row')
  const markup = paint(new URLSearchParams({ category: categorySlug(row.section) }))

  assert.match(markup, new RegExp(`data-settings-section="${row.section}"`),
    `going to this row's own category did not paint ${JSON.stringify(row.section)}`)
  assert.match(markup, /data-setting-id="compare_files"/,
    'the compare row is declared but the page that owns its section does not draw it')
  assert.ok(controlFor(markup, row.action),
    'the compare row painted without the control a person would press')
})

test('the row is also reachable by its own address, the way a link sends somebody', () => {
  const markup = paint(new URLSearchParams({ setting: 'compare_files' }))
  assert.match(markup, /data-setting-id="compare_files"/,
    'a link naming this setting landed somewhere the setting is not')
})

test('the row is pressable where the window can open and refuses with its reason where it cannot', () => {
  const query = () => new URLSearchParams({ category: categorySlug(row.section) })

  const previous = globalThis.mcDiff
  try {
    globalThis.mcDiff = { open: () => {} }
    const live = controlFor(paint(query()), row.action)
    assert.ok(live, 'the control vanished when a host was present')
    assert.ok(!/\sdisabled/.test(live),
      'the compare row is dead on the one kind of copy where the window can actually open')

    globalThis.mcDiff = undefined
    const blocked = controlFor(paint(query()), row.action)
    assert.ok(blocked, 'the control vanished instead of explaining itself')
    assert.match(blocked, /\sdisabled/,
      'the compare row offers a press that cannot do anything on a copy with no host')
    assert.match(blocked, /title="[^"]+"/,
      'the control is disabled and says nothing about why')
  } finally {
    if (previous === undefined) delete globalThis.mcDiff
    else globalThis.mcDiff = previous
  }
})

/* THE PAGE OPENS BASIC (owner direction 2026-09-20, T782), so a row that
   needs Advanced is not on screen the moment Settings opens. It still has to
   be REACHABLE from where the page opens: the section that owns it must paint
   the one press that shows that mode ("Show Advanced settings"), and the
   persistent mode switch must offer the mode. A row whose mode neither the
   switch nor a gate can reach is the dead end this case exists to catch. */
test('the mode the page opens in either shows this row or offers the one press that does', async () => {
  const { readSettingsMode, settingMode, SETTINGS_MODES } = await import('../../src/settings-mode.js')
  const order = SETTINGS_MODES.map(mode => mode.id)
  const needed = settingMode(row.id), opens = readSettingsMode()
  assert.ok(order.includes(needed), `the compare row declares a mode (${needed}) the page has no view for`)
  assert.ok(SETTINGS_MODES.some(mode => mode.id === needed && mode.id !== 'expert'), 'the row needs a view the persistent switch offers without a confirmation')
  /* This harness paints the sections area only (the mode switch sits in the
     page shell), so the reachability it can measure is the section's own gate. */
  const markup = paint(new URLSearchParams({ category: categorySlug(row.section) }))
  if (order.indexOf(needed) > order.indexOf(opens)) {
    assert.match(markup, new RegExp(`data-settings-show-mode="${needed}"`),
      `the page opens in ${opens} and the compare row needs ${needed}, but its section paints no "Show ${needed} settings" press to reach it`)
  }
})
