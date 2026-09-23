import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SETTINGS_MODE, SETTINGS_MODES, SETTINGS_MODE_KEY, createSettingsMode, readSettingsMode, settingsModePanel } from '../../src/settings-mode.js'

/* BASIC IS THE DEFAULT (owner direction 2026-09-20, T782: "it should default
   to genuinely basic user settings"). Nothing saved, an unreadable store, an
   old or unknown value, and Expert (never remembered) all open Basic. A saved
   Advanced or Enterprise choice is the person's and is kept. */
test('Basic is the default, including old, invalid, unreadable or Expert preferences', () => {
  assert.equal(DEFAULT_SETTINGS_MODE, 'simple')
  for (const value of [null, undefined, '', 'expert', 'everything', 'Simple', 'Basic', 'basic']) {
    assert.equal(readSettingsMode({ getItem: () => value }), 'simple', JSON.stringify(value))
  }
  assert.equal(readSettingsMode({ getItem() { throw new Error('unavailable') } }), 'simple')
  assert.equal(readSettingsMode(undefined), 'simple', 'no storage at all still opens Basic')
  assert.equal(readSettingsMode(null), 'simple', 'an explicit no-storage still opens Basic')
  assert.equal(readSettingsMode({ getItem: () => 'simple' }), 'simple')
  assert.equal(readSettingsMode({ getItem: () => 'advanced' }), 'advanced', 'an explicit Advanced choice is kept')
  assert.equal(readSettingsMode({ getItem: () => 'enterprise' }), 'enterprise', 'an explicit Enterprise choice is kept')
  assert.deepEqual(SETTINGS_MODES.map(mode => mode.id), ['simple', 'advanced', 'expert', 'enterprise'])
  assert.equal(SETTINGS_MODES[0].label, 'Basic', 'the person-facing name is Basic; the stored id stays simple for older saved choices')
})

/* THE STORAGE ITSELF CAN REFUSE TO BE REACHED (Controller review of T782 v1):
   a document with storage disabled answers its localStorage getter with a
   SecurityError. The default used to be a parameter default, which runs
   before the function body's try, so the throw escaped and the Settings view
   could not mount. Both entry points resolve the default inside the guard
   now: the read opens Basic, the controller mounts on Basic, and choosing
   Advanced still works for the visit. */
test('a localStorage getter that throws still opens Basic and still mounts the mode switch', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError: storage is disabled for this document') } })
  try {
    assert.throws(() => globalThis.localStorage, /storage is disabled/, 'the fixture really throws on access')
    assert.equal(readSettingsMode(), 'simple', 'the read opens Basic instead of throwing')
    const changes = [], listeners = new Map(), description = {}
    const root = { dataset: {}, querySelectorAll: () => [], querySelector: () => description,
      addEventListener: (kind, handler) => listeners.set(kind, handler), removeEventListener: kind => listeners.delete(kind) }
    const controller = createSettingsMode({ root, onChange: mode => changes.push(mode) })
    assert.equal(controller.mode, 'simple', 'the controller mounts on Basic')
    assert.equal(root.dataset.settingsMode, 'simple')
    listeners.get('click')({ target: { closest: () => ({ dataset: { settingsModeChoice: 'advanced' }, closest: () => null }) } })
    assert.equal(controller.mode, 'advanced', 'the view still changes for this visit; the write is dropped quietly')
    assert.deepEqual(changes, ['advanced'])
    controller.destroy()
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else delete globalThis.localStorage
  }
})

test('the Basic view says what stays off, and every gate says that showing a view changes nothing', () => {
  assert.match(SETTINGS_MODES[0].detail, /stay off until you set them up in Advanced/)
  assert.match(SETTINGS_MODES[1].detail, /turns nothing on/)
  for (const mode of ['advanced', 'expert', 'enterprise']) {
    const panel = settingsModePanel('<p>content</p>', 'Audit', mode)
    assert.match(panel, /Showing them changes no setting/)
    assert.match(panel, new RegExp(`data-settings-show-mode="${mode}"`))
  }
})

test('browsing modes persist independently of saved product settings and pending edits', () => {
  const stored = new Map([['mc.theme', 'black'], ['mc.write.dispatch', '1']])
  const changes = [], listeners = new Map(), description = {}
  const root = {
    dataset: {},
    querySelectorAll: () => [], querySelector: () => description,
    addEventListener: (kind, handler) => listeners.set(kind, handler),
    removeEventListener: kind => listeners.delete(kind),
  }
  const storage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) }
  const controller = createSettingsMode({ root, storage, onChange: mode => changes.push(mode) })
  assert.equal(controller.mode, 'simple', 'a fresh copy opens Basic')
  assert.deepEqual(changes, [], 'mounting must not change any preference')
  assert.equal(stored.has(SETTINGS_MODE_KEY), false, 'opening Basic writes nothing')
  const choose = mode => listeners.get('click')({ target: { closest: () => ({
    dataset: { settingsModeChoice: mode }, closest: () => null,
  }) } })
  choose('advanced')
  assert.equal(root.dataset.settingsMode, 'advanced')
  assert.equal(readSettingsMode(storage), 'advanced')
  assert.deepEqual([...stored], [['mc.theme', 'black'], ['mc.write.dispatch', '1'], [SETTINGS_MODE_KEY, 'advanced']],
    'opening Advanced records the view and nothing else: no product setting, no policy')
  choose('not-a-mode')
  assert.equal(controller.mode, 'advanced')
  choose('simple')
  choose('enterprise')
  assert.equal(readSettingsMode(storage), 'enterprise')
  assert.deepEqual(changes, ['advanced', 'simple', 'enterprise'])
  assert.deepEqual([...stored], [['mc.theme', 'black'], ['mc.write.dispatch', '1'], [SETTINGS_MODE_KEY, 'enterprise']])
  controller.destroy()
  assert.equal(listeners.size, 0)
})
