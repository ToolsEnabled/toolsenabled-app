import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ROLE_COLORS_KEY, ROLE_COLOR_DEFAULTS, ROLE_COLOR_THEMES,
  normalizeRoleColor, readRoleColors, saveRoleColor, resetRoleColors,
  applyRoleColors, roleColorCss, roleColorTone, colorContrast, validRoleColorId,
  paintRoleColor, defaultRoleColor, defaultAgentColor, roleColorStyle,
} from '../../src/role-colors.js'
import { createRoleColorSettings } from '../../src/role-color-settings.js'
import { roleAppearance } from '../../src/vocab.js'

const memory = () => {
  const values = new Map()
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}
const documentFixture = theme => {
  const properties = new Map()
  return { properties, documentElement: { dataset: { theme }, style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) } } }
}

test('hex colors are canonicalized and CSS/HTML injection is rejected', () => {
  assert.equal(normalizeRoleColor(' #AbC '), '#aabbcc')
  assert.equal(normalizeRoleColor('#ABC123'), '#abc123')
  for (const invalid of ['red', 'transparent', '#12345678', 'url(x)', '#000; color:red', '<script>', null, 42]) assert.equal(normalizeRoleColor(invalid), null)
  for (const invalid of ['Role name', '<role>', 'worker;color:red', '', '__proto__', 'UPPERCASE', 'a'.repeat(65)]) assert.equal(validRoleColorId(invalid), false)
  assert.equal(validRoleColorId('custom-role_7'), true)
})

test('preferences persist exact stable IDs independently of role names and menu order', () => {
  const storage = memory()
  assert.equal(saveRoleColor('release-captain', '#123456', storage).ok, true)
  assert.equal(saveRoleColor('worker', '#ABC', storage).ok, true)
  assert.deepEqual(JSON.parse(storage.getItem(ROLE_COLORS_KEY)), { version: 1, colors: { 'release-captain': '#123456', worker: '#aabbcc' } })
  assert.equal(readRoleColors(storage).colors['release-captain'], '#123456')
  assert.equal(saveRoleColor('worker', null, storage).ok, true)
  assert.deepEqual({ ...readRoleColors(storage).colors }, { 'release-captain': '#123456' })
  assert.equal(saveRoleColor('release-captain', null, storage).ok, true)
  assert.equal(storage.getItem(ROLE_COLORS_KEY), null)
})

test('a legal ID that is also an Object property cannot pollute or inherit the preference map', () => {
  const storage = memory()
  assert.equal(saveRoleColor('constructor', '#123456', storage).ok, true)
  const record = readRoleColors(storage)
  assert.equal(Object.getPrototypeOf(record.colors), null)
  assert.equal(record.colors.constructor, '#123456')
  assert.equal(roleAppearance('constructor').label, 'Agent')
})

test('bad IDs or colors never overwrite the previous saved choice', () => {
  const storage = memory()
  saveRoleColor('worker', '#abcdef', storage)
  const before = storage.getItem(ROLE_COLORS_KEY)
  assert.equal(saveRoleColor('worker', 'url(secret)', storage).ok, false)
  assert.equal(saveRoleColor('bad id', '#ffffff', storage).ok, false)
  assert.equal(storage.getItem(ROLE_COLORS_KEY), before)
})

test('damaged and newer-format preferences are not treated as absence or silently overwritten', () => {
  const storage = memory()
  for (const raw of ['{broken', '{"version":2,"colors":{}}', '{"version":1,"colors":{"worker":"red"}}']) {
    storage.setItem(ROLE_COLORS_KEY, raw)
    assert.equal(readRoleColors(storage).ok, false)
    assert.equal(saveRoleColor('worker', '#abcdef', storage).ok, false)
    assert.equal(storage.getItem(ROLE_COLORS_KEY), raw)
  }
  assert.equal(resetRoleColors(storage).ok, true)
  assert.equal(readRoleColors(storage).ok, true)
})

test('unavailable storage is reported and a failed write cannot claim success', () => {
  const unreadable = { getItem() { throw new Error('not available') } }
  assert.equal(readRoleColors(unreadable).ok, false)
  assert.equal(saveRoleColor('worker', '#123456', unreadable).ok, false)
  const unwritable = { getItem: () => null, setItem() { throw new Error('full') }, removeItem() { throw new Error('full') } }
  assert.equal(saveRoleColor('worker', '#123456', unwritable).ok, false)
  assert.equal(resetRoleColors(unwritable).ok, false)
})

test('all default and extreme custom colors have theme-safe marks and AA text tones', () => {
  const colors = [...Object.values(ROLE_COLOR_DEFAULTS), '#000000', '#ffffff', '#ffff00', '#00ffff', '#ff00ff']
  for (const [theme, grounds] of Object.entries(ROLE_COLOR_THEMES)) for (const color of colors) {
    const mark = roleColorTone(color, theme)
    const text = roleColorTone(color, theme, 4.5)
    for (const ground of grounds) {
      assert.ok(colorContrast(mark, ground) >= 3, `${color}/${theme} mark must contrast with ${ground}`)
      assert.ok(colorContrast(text, ground) >= 4.5, `${color}/${theme} text must contrast with ${ground}`)
    }
  }
})

test('theme changes adapt visible accents without mutating the chosen color or theme selection', () => {
  const storage = memory(), documentRef = documentFixture('white')
  saveRoleColor('worker', '#ffffff', storage)
  const saved = storage.getItem(ROLE_COLORS_KEY)
  applyRoleColors({ documentRef, storage })
  const light = documentRef.properties.get('--role-accent-worker')
  documentRef.documentElement.dataset.theme = 'black'
  applyRoleColors({ documentRef, storage })
  assert.notEqual(documentRef.properties.get('--role-accent-worker'), light)
  assert.equal(storage.getItem(ROLE_COLORS_KEY), saved)
  assert.equal(documentRef.documentElement.dataset.theme, 'black')
  assert.equal(documentRef.properties.get('--c-default'), 'var(--role-accent-default)', 'no self-referencing CSS fallback cycle')
})

test('reset removes stale custom-role variables and unknown roles retain a visible fallback', () => {
  const storage = memory(), documentRef = documentFixture('tan')
  saveRoleColor('custom-role', '#123456', storage)
  applyRoleColors({ documentRef, storage })
  assert.ok(documentRef.properties.has('--role-accent-custom-role'))
  resetRoleColors(storage)
  applyRoleColors({ documentRef, storage })
  assert.equal(documentRef.properties.has('--role-accent-custom-role'), false)
  assert.match(roleColorCss('unknown'), /^var\(--role-accent-unknown, light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)\)$/)
  assert.equal(roleColorCss('bad;name'), 'var(--role-accent-default, var(--role-fallback-accent, var(--c-default)))')
})

test('custom stable IDs cannot collide with a different role’s text tone or inherit its override', () => {
  const storage = memory(), documentRef = documentFixture('white')
  saveRoleColor('worker', '#234567', storage)
  saveRoleColor('worker-text', '#dd4488', storage)
  saveRoleColor('default', '#007711', storage)
  applyRoleColors({ documentRef, storage })
  assert.equal(documentRef.properties.get('--role-text-worker'), roleColorTone('#234567', 'white', 4.5))
  assert.equal(documentRef.properties.get('--role-accent-worker-text'), roleColorTone('#dd4488', 'white'))
  assert.equal(documentRef.properties.get('--role-fallback-accent'), roleColorTone(ROLE_COLOR_DEFAULTS.worker, 'white'))
  assert.equal(documentRef.properties.get('--role-fallback-text'), roleColorTone(ROLE_COLOR_DEFAULTS.worker, 'white', 4.5))
  saveRoleColor('worker-text', null, storage)
  applyRoleColors({ documentRef, storage })
  assert.equal(documentRef.properties.has('--role-accent-worker-text'), false)
  assert.equal(documentRef.properties.get('--role-text-worker'), roleColorTone('#234567', 'white', 4.5))
})

test('default roles and custom tree roles keep distinct theme-safe colors without saved choices', () => {
  const roles = ['controller', 'shadow-manager', 'planner', 'manager', 'coordinator-assistant', 'builder', 'reviewer', 'worker', 'observer']
  const custom = ['ssh-fra', 'providers-qa', 'release-cuts', 'windows-phone']
  const storage = memory()
  for (const [theme, grounds] of Object.entries(ROLE_COLOR_THEMES)) {
    applyRoleColors({ documentRef: documentFixture(theme), storage })
    const colors = roles.map(id => roleColorTone(defaultRoleColor(id), theme))
    assert.equal(new Set(colors).size, roles.length, `${theme}: built-in identities stay distinct`)
    assert.equal(new Set(custom.map(defaultRoleColor)).size, custom.length, `${theme}: custom roles do not all use Worker`)
    for (const id of [...roles, ...custom]) {
      for (const ground of grounds) assert.ok(colorContrast(roleColorTone(defaultRoleColor(id), theme), ground) >= 3.5)
    }
  }
  const before = custom.map(defaultRoleColor)
  saveRoleColor('worker', '#ffffff', storage)
  applyRoleColors({ documentRef: documentFixture('black'), storage })
  assert.deepEqual([...custom].reverse().map(defaultRoleColor).reverse(), before)
  assert.equal(defaultRoleColor('bad;role'), ROLE_COLOR_DEFAULTS.worker)
})

test('repeated tree status refreshes do not rewrite unchanged role styles', () => {
  const calls = []
  const element = { style: { setProperty: (...args) => calls.push(args) } }
  paintRoleColor(element, 'worker')
  assert.equal(calls.length, 3)
  for (let i = 0; i < 100; i += 1) paintRoleColor(element, 'worker')
  assert.equal(calls.length, 3)
  paintRoleColor(element, 'reviewer')
  assert.equal(calls.length, 6)
  assert.equal(calls.at(-1)[1], 'var(--role-text-reviewer, var(--role-fallback-text, var(--ink-2)))')
})

test('settings expose labeled native color, hex, Save and Reset controls for every real built-in role', () => {
  const controller = createRoleColorSettings({ storage: memory() })
  const markup = controller.markup()
  for (const id of ['controller', 'shadow-manager', 'planner', 'manager', 'coordinator-assistant', 'builder', 'reviewer', 'worker', 'observer']) assert.match(markup, new RegExp(`data-role-color-id="${id}"`))
  assert.match(markup, /type="color"[^>]*aria-label=/)
  assert.match(markup, /data-role-color-hex[^>]*aria-describedby="role-colors-help"/)
  assert.match(markup, /data-role-color-action="save"/)
  assert.match(markup, /data-role-color-action="reset"/)
  assert.match(markup, /role="status" aria-live="polite"/)
  assert.equal(controller.matches('role'), true)
  assert.equal(controller.matches('colors'), true)
})

function settingsFixture(readRoles = async () => ({ state: 'absent' }), staged = {}) {
  const storage = memory(), documentRef = documentFixture('white'), events = [], listeners = new Map()
  const note = { textContent: '' }, source = { textContent: '' }, appended = []
  const rows = new Map()
  const makeRow = id => {
    const row = { dataset: { roleColorId: id } }
    const legend = { textContent: id }
    const input = kind => ({
      value: ROLE_COLOR_DEFAULTS[id], attributes: new Map(),
      setAttribute(key, value) { this.attributes.set(key, value) },
      removeAttribute(key) { this.attributes.delete(key) },
      closest(selector) { return selector === '[data-role-color-id]' ? row : selector === `[data-role-color-${kind}]` ? this : null },
    })
    row.hex = input('hex'); row.picker = input('picker'); row.legend = legend
    row.querySelector = selector => selector === 'legend' ? legend : selector === '[data-role-color-hex]' ? row.hex : selector === '[data-role-color-picker]' ? row.picker : null
    rows.set(id, row)
    return row
  }
  const worker = makeRow('worker'), builder = makeRow('builder')
  const root = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
    querySelector: selector => ({ '[data-role-color-status]': note, '[data-role-color-source]': source, '[data-role-color-settings]': {}, '[data-role-color-list]': { insertAdjacentHTML: (_, html) => appended.push(html) } })[selector] || null,
    querySelectorAll: () => [...rows.values()],
  }
  const controller = createRoleColorSettings({ storage, documentRef, windowRef: { dispatchEvent: event => events.push(event.type) }, readRoles, ...staged })
  controller.bind(root)
  const click = (row, action) => listeners.get('click')({ target: {
    dataset: { roleColorAction: action },
    closest(selector) { return selector === '[data-role-color-action]' ? this : selector === '[data-role-color-id]' ? row : null },
  } })
  return { storage, root, worker, builder, listeners, note, appended, controller, click, events }
}

test('the actual settings handlers save, reject invalid hex, reset, and preserve a neighboring draft', () => {
  const state = settingsFixture()
  state.worker.hex.value = '#24688a'
  state.click(state.worker, 'save')
  assert.equal(readRoleColors(state.storage).colors.worker, '#24688a')
  assert.equal(state.worker.picker.value, '#24688a')
  assert.equal(state.note.textContent, 'Role color saved.')
  state.builder.hex.value = '#445566'
  state.listeners.get('input')({ target: state.builder.hex })
  state.worker.hex.value = 'bad'
  state.click(state.worker, 'save')
  assert.equal(readRoleColors(state.storage).colors.worker, '#24688a')
  assert.equal(state.worker.hex.attributes.get('aria-invalid'), 'true')
  state.click(state.worker, 'reset')
  assert.equal(state.storage.getItem(ROLE_COLORS_KEY), null)
  assert.equal(state.worker.hex.value, ROLE_COLOR_DEFAULTS.worker)
  assert.equal(state.builder.hex.value, '#445566')
  assert.match(state.controller.markup(), /data-role-color-hex value="#445566"/)
  state.controller.destroy()
  assert.equal(state.listeners.size, 0)
})

test('the native swatch handler saves its chosen hex; Reset all changes only role colors', () => {
  const state = settingsFixture()
  state.storage.setItem('mc.theme', 'tan')
  state.worker.picker.value = '#cc7788'
  state.listeners.get('change')({ target: state.worker.picker })
  assert.equal(readRoleColors(state.storage).colors.worker, '#cc7788')
  state.click(null, 'reset-all')
  assert.equal(state.storage.getItem(ROLE_COLORS_KEY), null)
  assert.equal(state.storage.getItem('mc.theme'), 'tan')
})

/* THE SETTINGS PAGE STAGES ROLE COLORS until Save settings. A stand-in page
   draft records what the controller stages and which error holds Save. */
function stagedFixture() {
  const staged = [], errors = []
  const state = settingsFixture(undefined, {
    stageWrite: (key, value, write) => staged.push({ key, write }),
    setStageError: (key, message) => errors.push({ key, message }),
  })
  return { ...state, staged, errors }
}

test('a half-typed role hex is marked at once and holds the page Save with the role named', () => {
  // T1428: '#12' was staged as an ordinary change and the whole Save failed later.
  const state = stagedFixture()
  state.worker.hex.value = '#12'
  state.listeners.get('input')({ target: state.worker.hex })
  assert.equal(state.worker.hex.attributes.get('aria-invalid'), 'true', 'the field is not marked invalid')
  assert.equal(state.errors.length, 1, 'the page Save is not held')
  assert.equal(state.errors[0].key, 'role:colors')
  assert.match(state.errors[0].message, /valid hex color for Worker/)
  assert.equal(state.staged.length, 0, 'a half-typed color was staged as a change')
  state.worker.hex.value = '#123456'
  state.listeners.get('input')({ target: state.worker.hex })
  assert.equal(state.worker.hex.attributes.has('aria-invalid'), false, 'a corrected color stays marked')
  assert.equal(state.staged.length, 1, 'a valid color is staged as today')
  assert.equal(state.errors.length, 1, 'a valid color raised another error')
})

test('Reset all on the Settings page says it is pending until Save settings', () => {
  // T1429: it said 'All role colors restored to their defaults.' while nothing was written.
  const state = stagedFixture()
  state.storage.setItem(ROLE_COLORS_KEY, JSON.stringify({ version: 1, colors: { controller: '#123456' } }))
  state.click(null, 'reset-all')
  assert.match(state.note.textContent, /pending/i)
  assert.match(state.note.textContent, /Save settings/)
  assert.doesNotMatch(state.note.textContent, /restored/)
  assert.equal(JSON.parse(state.storage.getItem(ROLE_COLORS_KEY)).colors.controller, '#123456', 'the reset wrote before Save')
  // Outside the Settings page draft the reset is immediate and says so.
  const direct = settingsFixture()
  direct.click(null, 'reset-all')
  assert.equal(direct.note.textContent, 'All role colors restored to their defaults.')
})

test('a late custom Role library read updates labels/appends fields without replacing an existing input', async () => {
  let finish
  const state = settingsFixture(() => new Promise(resolve => { finish = resolve }))
  const typedInput = state.worker.hex
  typedInput.value = '#123'
  state.listeners.get('input')({ target: typedInput })
  const pending = state.controller.afterRender(state.root)
  finish({ state: 'ready', roles: [{ id: 'worker', name: 'Renamed worker' }, { id: 'custom-review', name: 'Review <safe>' }] })
  await pending
  assert.equal(state.worker.hex, typedInput)
  assert.equal(typedInput.value, '#123')
  assert.equal(state.worker.legend.textContent, 'Renamed worker')
  assert.equal(state.appended.length, 1)
  assert.match(state.appended[0], /data-role-color-id="custom-review"/)
  assert.match(state.appended[0], /Review &lt;safe&gt;/)
  assert.doesNotMatch(state.appended[0], /Review <safe>/)
})

test('global theme text/action/status colors retain AA contrast on all named surfaces', () => {
  const css = readFileSync(new URL('../../src/theme-refinements.css', import.meta.url), 'utf8')
  for (const [theme, grounds] of Object.entries(ROLE_COLOR_THEMES)) {
    // Resolve the root's shared dark declarations before its own variant.
    // Browser QA also measures the actual computed colors on these surfaces.
    const variables = new Map()
    for (const [, selector, body] of css.matchAll(/(:root(?:\[data-theme="[a-z]+"\]|:is\([^{}]+\))?)\s*\{([^{}]*)\}/g)) {
      if (selector !== ':root' && !selector.includes(`[data-theme="${theme}"]`)) continue
      for (const [, key, value] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) variables.set(key, value.trim())
    }
    const resolve = key => {
      const value = variables.get(key)
      const reference = /^var\(--([\w-]+)\)$/.exec(value || '')
      return reference ? variables.get(reference[1]) : value
    }
    for (const token of ['ink-3', 'accent-2', 's-good', 's-warn', 's-serious', 's-critical']) {
      const color = resolve(token)
      assert.match(color, /^#[0-9a-f]{6}$/, `${theme} ${token} resolves to a color`)
      for (const ground of grounds) assert.ok(colorContrast(color, ground) >= 4.5, `${theme} ${token} (${color}) on ${ground}`)
    }
  }
})

/* EACH AGENT'S OWN DEFAULT ACCENT. The owner (2026-09-10): "for the agent
   circles, they should maintain unique coloring but can you make the default
   set look nice in all themes with various tree sizes". Several Workers under
   one Manager used to share the Worker color. */
const LIVE_SIBLINGS = [ // the four Workers and providers-qa under the LIVE Manager, observed 2026-09-10
  'node-9-dbacd1bc-9894-4de1-980b-50e32100a1b3', 'node-10-b9c19a2d-c150-4bd0-b4f3-44db699cdcef',
  'node-11-86b9a3cb-360a-445a-82d7-815c3e08fbcc', 'node-12-517149d1-f6a3-4c08-8dc9-6744bc97d5fa',
  'node-1-1e51e7e7-e651-4385-bd76-86a04a0769eb',
]
// What the painted light-dark() resolves to: the tan tone on light themes, the charcoal tone on dark ones.
const agentTone = (id, theme, minimum = 3.5) => {
  const ground = ['black', 'ember', 'cobalt'].includes(theme) ? 'black' : 'tan'
  return roleColorTone(defaultAgentColor(id, ground), ground, minimum)
}
const oklab = hex => {
  const [r, g, b] = hex.slice(1).match(/../g).map(part => { const s = parseInt(part, 16) / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
const closestPair = colors => {
  let closest = Infinity
  for (let i = 0; i < colors.length; i += 1) for (let j = i + 1; j < colors.length; j += 1) {
    const [a, b] = [oklab(colors[i]), oklab(colors[j])]
    closest = Math.min(closest, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
  }
  return closest
}

test('same-role agents get their own accents, and the role never changes a node default', () => {
  const accents = LIVE_SIBLINGS.map(id => roleColorCss('worker', 'accent', id))
  assert.equal(new Set(accents).size, LIVE_SIBLINGS.length, 'several Workers no longer share the Worker color')
  for (const [index, id] of LIVE_SIBLINGS.entries()) {
    assert.match(accents[index], /^var\(--role-chosen-accent-worker, light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)\)$/)
    assert.equal(roleColorCss('reviewer', 'accent', id), accents[index].replace('-worker,', '-reviewer,'), 'the role names only the saved override')
    assert.match(roleColorStyle('worker', id), new RegExp(`^--rc:var\\(--role-chosen-accent-worker, light-dark\\(`))
  }
  // A node's color is a function of its id alone: order, siblings and tree size are not inputs.
  const before = LIVE_SIBLINGS.map(id => defaultAgentColor(id))
  for (let n = 60; n >= 1; n -= 1) paintRoleColor({ style: { setProperty() {} } }, 'worker', `node-${n}-crowd`)
  assert.deepEqual([...LIVE_SIBLINGS].reverse().map(id => defaultAgentColor(id)).reverse(), before)
})

test('siblings are clearly distinct in every theme, and any twelve agents created together get twelve colors', () => {
  for (const theme of Object.keys(ROLE_COLOR_THEMES)) {
    const siblings = LIVE_SIBLINGS.map(id => agentTone(id, theme))
    assert.ok(closestPair(siblings) >= 0.08, `${theme}: LIVE siblings ${siblings.join(' ')} stay apart`)
    for (let start = 1; start <= 48; start += 1) {
      const together = Array.from({ length: 12 }, (_, i) => agentTone(`node-${start + i}-${start}`, theme))
      assert.equal(new Set(together).size, 12, `${theme}: counters ${start}..${start + 11}`)
      assert.ok(closestPair(together) >= 0.06, `${theme}: counters ${start}..${start + 11} stay apart`)
    }
  }
})

test('agent default accents keep theme-safe marks and AA text tones, without amber or olive', () => {
  for (const [theme, grounds] of Object.entries(ROLE_COLOR_THEMES)) {
    for (let n = 1; n <= 24; n += 1) for (const id of [`node-${n}-x`, `custom-${n}x`]) {
      const mark = agentTone(id, theme), text = agentTone(id, theme, 4.5)
      for (const ground of grounds) {
        assert.ok(colorContrast(mark, ground) >= 3.5, `${id}/${theme} mark ${mark} on ${ground}`)
        assert.ok(colorContrast(text, ground) >= 4.5, `${id}/${theme} text ${text} on ${ground}`)
      }
      const [, a, b] = oklab(defaultAgentColor(id, theme))
      const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360
      assert.ok(hue < 60 || hue > 125, `${id}/${theme} hue ${hue.toFixed(0)} is not amber or olive`)
    }
  }
})

test('a saved role color overrides every node of that role; Reset and theme changes update painted circles', () => {
  const storage = memory(), documentRef = documentFixture('white'), id = LIVE_SIBLINGS[0]
  const painted = roleColorCss('worker', 'accent', id)
  applyRoleColors({ documentRef, storage })
  assert.equal(documentRef.properties.has('--role-chosen-accent-worker'), false, 'no saved color: each node shows its own default')
  saveRoleColor('worker', '#234567', storage)
  saveRoleColor('providers-qa', '#aa3355', storage)
  applyRoleColors({ documentRef, storage })
  assert.equal(documentRef.properties.get('--role-chosen-accent-worker'), roleColorTone('#234567', 'white'))
  assert.equal(documentRef.properties.get('--role-chosen-text-worker'), roleColorTone('#234567', 'white', 4.5))
  assert.equal(documentRef.properties.get('--role-chosen-accent-providers-qa'), roleColorTone('#aa3355', 'white'))
  assert.equal(documentRef.properties.has('--role-chosen-accent-reviewer'), false)
  assert.equal(roleColorCss('worker', 'accent', id), painted, 'existing circles need no repaint: their CSS reads the variable')
  documentRef.documentElement.dataset.theme = 'black'
  applyRoleColors({ documentRef, storage })
  assert.equal(documentRef.properties.get('--role-chosen-accent-worker'), roleColorTone('#234567', 'black'))
  saveRoleColor('providers-qa', null, storage)
  applyRoleColors({ documentRef, storage })
  assert.equal(documentRef.properties.has('--role-chosen-accent-providers-qa'), false)
  resetRoleColors(storage)
  applyRoleColors({ documentRef, storage })
  assert.equal(documentRef.properties.has('--role-chosen-accent-worker'), false)
  assert.equal(documentRef.properties.has('--role-chosen-text-worker'), false)
})

test('agent accents need a usable node id and repaint only when the role or node changes', () => {
  for (const nodeId of [null, '', 42, 'x'.repeat(257)]) assert.equal(roleColorCss('worker', 'accent', nodeId), roleColorCss('worker'))
  assert.match(roleColorCss('bad;role', 'text', 'node-1-x'), /^var\(--role-chosen-text-default, light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)\)$/)
  const calls = []
  const element = { style: { setProperty: (...args) => calls.push(args) } }
  paintRoleColor(element, 'worker', 'node-9-a')
  assert.equal(calls.length, 3)
  for (let i = 0; i < 50; i += 1) paintRoleColor(element, 'worker', 'node-9-a')
  assert.equal(calls.length, 3)
  paintRoleColor(element, 'worker', 'node-10-b')
  assert.deepEqual(calls.slice(3).map(call => call[1]), [roleColorCss('worker', 'accent', 'node-10-b'), roleColorCss('worker', 'accent', 'node-10-b'), roleColorCss('worker', 'text', 'node-10-b')])
  paintRoleColor(element, 'worker')
  assert.equal(calls.at(-1)[1], roleColorCss('worker', 'text'))
})

test('a tree node chat wears the node accent; other chats keep the role color', async t => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const { restore } = installDomStandIn()
  const chats = []
  t.after(() => { for (const chat of chats) chat.dispose?.(); restore() })
  const { buildChat } = await import('../../src/components.js')
  const node = buildChat({ title: 'Worker', roleKey: 'worker', accentId: LIVE_SIBLINGS[2], seed: 0, history: [] })
  const plain = buildChat({ title: 'Worker', roleKey: 'worker', seed: 0, history: [] })
  chats.push(node, plain)
  const accent = roleColorCss('worker', 'accent', LIVE_SIBLINGS[2])
  assert.ok(node.getAttribute('style').includes(`--chat-role:${accent}`))
  assert.equal(node.querySelector('.role-dot').getAttribute('style'), `background:${accent}`)
  assert.ok(plain.getAttribute('style').includes(`--chat-role:${roleColorCss('worker')}`))
})

test('every tree paint site carries the node identity, and collapsed branches keep the neutral role color', () => {
  // Source pin (tree-graph needs a full DOM to build a node): the helper is evaluated, the call sites are read.
  const graph = readFileSync(new URL('../../src/tree-graph.js', import.meta.url), 'utf8')
  const accentIdOf = new Function(`${/^const accentIdOf = .+$/m.exec(graph)[0]}\nreturn accentIdOf`)()
  assert.equal(accentIdOf({ id: 'node-9-a', treeScope: { group: false } }), 'node-9-a')
  assert.equal(accentIdOf({ id: '@tree-group:3', role: 'default', treeScope: { group: true } }), null, 'a group id is renumbered as scopes rebuild')
  const calls = [...graph.matchAll(/\b(?:paintRoleColor|roleColorStyle)\((?!\s*\{)([^\n]+)/g)].map(match => match[1])
  assert.ok(calls.length >= 7)
  for (const call of calls) assert.match(call, /, (?:accentIdOf\((?:record\.)?agent\)|record\.agent\.id)\)/, `a tree surface paints without its node: ${call}`)
})

/* T1451: the emergency 'Stop all' under Computer control drew its label with
   var(--danger, #b34550). --danger is defined nowhere, so the light-theme red
   was used on every theme: 2.9:1 on Black. It takes --s-serious, the status red
   the test above holds at 4.5:1 on every theme's grounds. */
test('Stop all is drawn in the status red each theme solves, not an undefined token', () => {
  const sheet = readFileSync(new URL('../../src/agent-screen-voice-controls.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = /\.screen-access-controls \[data-control-stop\]\s*\{([^}]*)\}/.exec(sheet)
  assert.ok(rule, 'the Stop all rule is gone')
  assert.match(rule[1], /(^|;)\s*color:\s*var\(--s-serious\b/, 'Stop all is not drawn in --s-serious')
  assert.doesNotMatch(rule[1], /var\(--danger\b/, 'Stop all still leans on --danger, which no theme defines')
})

/* T1533: White's --ink-3 is solved for its light page; Home's activity plate
   is the page with 6-7% of the ink mixed in (#e7e4df), and the pair measured
   4.3:1 for Full view's empty-state sentence and reply hint, the chat subtitle,
   the Copy buttons and the example badge. The plate's own --ink-3 must reach
   4.5:1 on the darkest plate the page draws. */
test('secondary text on Home\'s activity plate keeps AA contrast in the White theme', () => {
  const styles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')
  const refinements = readFileSync(new URL('../../src/theme-refinements.css', import.meta.url), 'utf8')
  const context = readFileSync(new URL('../../src/home-context.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const token = (css, theme, name) => {
    let found = null
    for (const [, body] of css.matchAll(new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^{}]*)\\}`, 'g'))) {
      const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(body)
      if (match) found = match[1].toLowerCase()
    }
    return found
  }
  const mix = (a, b, share) => '#' + [0, 2, 4].map(i => Math.round(parseInt(a.slice(1 + i, 3 + i), 16) * share + parseInt(b.slice(1 + i, 3 + i), 16) * (1 - share)).toString(16).padStart(2, '0')).join('')
  const ink = token(styles, 'white', 'ink'), bg = token(styles, 'white', 'bg')
  assert.ok(ink && bg, 'the White theme ink and page colours moved; re-derive the plate')
  const plate = mix(ink, bg, 0.07)
  const pageInk3 = token(refinements, 'white', 'ink-3') || token(styles, 'white', 'ink-3')
  assert.ok(colorContrast(pageInk3, plate) < 4.5, 'the page\'s own --ink-3 now passes on the plate; this override may be unnecessary')
  const override = /:root\[data-theme="white"\] \.home :is\([^)]*\.home-feed-wrap[^)]*\.home-chat-pane-body[^)]*\)\s*\{\s*--ink-3:\s*(#[0-9a-f]{6})/i.exec(context)
  assert.ok(override, 'the plate keeps the page\'s --ink-3, 4.3:1 on its darker ground')
  assert.ok(colorContrast(override[1], plate) >= 4.5, `plate --ink-3 ${override[1]} on ${plate} is ${colorContrast(override[1], plate).toFixed(2)}:1`)
})
