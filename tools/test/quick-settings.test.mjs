/* Public contract of the page-aware quick-settings drawer. The real caller in
 * src/main.js passes the current route name and a drawer body; these tests use
 * those same values.
 *
 * WHAT CHANGED HERE, AND WHY THE OLD ASSERTIONS ARE GONE RATHER THAN RELAXED.
 * This suite used to drive the drawer's tool checkboxes: a strip of two-state
 * controls on the research route, with the tools the permission level withholds
 * reduced to a count. Those are a page now (#/tools), because a checkbox cannot
 * hold the owner's three answers and a count is not a way to see what was taken
 * away. tools/test/agent-tools-page.test.mjs pins the rows themselves and
 * tools/test/agent-tool-states.test.mjs pins the model behind them.
 *
 * So what the drawer owes is exactly two things, and this suite pins both: it
 * must offer the DOOR, and it must not grow a second copy of the list.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createDocument } from './lib/dom-stand-in.mjs'
import { fontOptionMarkup } from '../../src/font-choice.js'
import { currentHomeStatusColor, defaultHomeStatusColors } from '../../src/home-status-colors.js'

const source = readFileSync(new URL('../../src/quick-settings.js', import.meta.url), 'utf8')
  .replace("from './home-status-quick-settings.js'", `from ${JSON.stringify(new URL('../../src/home-status-quick-settings.js', import.meta.url).href)}`)
  .replace("from './home-circle-choice.js'", `from ${JSON.stringify(new URL('../../src/home-circle-choice.js', import.meta.url).href)}`)
  .replace("from './home-circle-playful-moment.js'", `from ${JSON.stringify(new URL('../../src/home-circle-playful-moment.js', import.meta.url).href)}`)
  .replace("import './home-status-colors.css'", '')
  .replace("from './agent-api-setting.js'", `from ${JSON.stringify(new URL('../../src/agent-api-setting.js', import.meta.url).href)}`)
  .replace("from './audit-performance-settings.js'", `from ${JSON.stringify(new URL('../../src/audit-performance-settings.js', import.meta.url).href)}`)
  .replace("from './theme-choice.js'", `from ${JSON.stringify(new URL('../../src/theme-choice.js', import.meta.url).href)}`)
  .replace("from './appearance-persistence.js'", `from ${JSON.stringify(new URL('../../src/appearance-persistence.js', import.meta.url).href)}`)
  .replace("from './settings-numeric.js'", `from ${JSON.stringify(new URL('../../src/settings-numeric.js', import.meta.url).href)}`)
  .replace("import { isExampleMode, setExampleMode } from './data-source.js'", 'const { isExampleMode, setExampleMode } = globalThis.__quickSettingsStubs')
  .replace("import { rangeFill } from './views/computers.js'", 'const { rangeFill } = globalThis.__quickSettingsStubs')
  .replace("import { guidanceMarkup } from './guided-step.js'", 'const { guidanceMarkup } = globalThis.__quickSettingsStubs')
  .replace(/import \{\s*FONT_CHOICES,\s*FONT_EVENT_ID,\s*FONT_STORAGE_KEY,\s*applyFontChoice,\s*currentFontChoice,\s*fontOptionMarkup,\s*\} from '\.\/font-choice\.js'/,
    'const { FONT_CHOICES, FONT_EVENT_ID, FONT_STORAGE_KEY, applyFontChoice, currentFontChoice, fontOptionMarkup } = globalThis.__quickSettingsStubs')
  .replace("import { phoneCanvasOn } from './phone-canvas.js'",
    'const phoneCanvasOn = (...args) => globalThis.__quickSettingsStubs.phoneCanvasOn(...args)')
  .replace(/import \{\s*readPhoneLedgerChoice,\s*setPhoneLedgerChoice,\s*\} from '\.\/phone-ledger\.js'/,
    'const readPhoneLedgerChoice = (...a) => globalThis.__quickSettingsStubs.readPhoneLedgerChoice(...a);'
    + ' const setPhoneLedgerChoice = (...a) => globalThis.__quickSettingsStubs.setPhoneLedgerChoice(...a)')
  /* THE REAL MODULE, NOT A STUB. src/text-size.js is dependency-free and
     imports no stylesheet, so the only thing standing between it and this
     harness is that a data: URL cannot resolve a RELATIVE specifier -- an
     absolute one it can. Stubbing it would have let the drawer's text row pass
     against a fake that always says yes; this way the press below applies the
     product's own zoom rules. */
  .replace("} from './text-size.js'",
    `} from ${JSON.stringify(new URL('../../src/text-size.js', import.meta.url).href)}`)

/* THE TWO PHONE STUBS ARE ARROWS THROUGH THE HOLDER, NOT VALUES.
   The other stubs are read once, at module-evaluation time, and the holder is
   deleted immediately afterwards; these two are read at RENDER time, so each
   test can decide whether this window is a phone. installGlobals() puts the
   holder back with whatever answer that test wants. */
globalThis.__quickSettingsStubs = {
  isExampleMode: () => false,
  setExampleMode: Boolean,
  rangeFill() {},
  guidanceMarkup: () => '',
  FONT_CHOICES: [{ id: 'system', label: 'System', stack: 'system-ui' }],
  FONT_EVENT_ID: 'ui_font',
  FONT_STORAGE_KEY: 'mc.font',
  applyFontChoice: value => value,
  currentFontChoice: () => 'system',
  fontOptionMarkup,
  phoneCanvasOn: () => false,
  readPhoneLedgerChoice: () => 'auto',
  setPhoneLedgerChoice: value => value,
}
const { renderQuickSettings } = await import(`data:text/javascript,${encodeURIComponent(source)}`)
delete globalThis.__quickSettingsStubs

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function installGlobals({ tools, getSetting, putSetting, phone = false, ledgerChoice = 'auto', ledgerWrites } = {}) {
  const previous = new Map()
  for (const name of ['document', 'window', 'localStorage', 'fetch', 'CustomEvent', '__quickSettingsStubs']) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }
  /* The module holds arrows into this object for the two phone answers, so a
     test decides here whether this window is a phone and what the ledger
     currently says. Restored with the rest of the globals below. */
  Object.defineProperty(globalThis, '__quickSettingsStubs', {
    configurable: true,
    writable: true,
    value: {
      phoneCanvasOn: () => phone,
      readPhoneLedgerChoice: () => ledgerChoice,
      setPhoneLedgerChoice: (value) => { ledgerWrites?.push(value); return value },
    },
  })

  const rootStyle = { getPropertyValue: () => '', setProperty() {} }
  const classList = { contains: () => false, toggle() {} }
  const windowValue = {
    mcAgent: tools ? { tools } : undefined,
    mcAccount: getSetting ? { getSetting, ...(putSetting ? { putSetting } : {}) } : undefined,
    dispatchEvent() {},
  }
  const values = {
    document: { documentElement: { dataset: {}, style: rootStyle }, body: { style: {}, classList } },
    window: windowValue,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: false }),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
  }
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
}

function drawerBody() {
  return { innerHTML: '', querySelector() { return null } }
}

async function render(routeName, bridge) {
  const restore = installGlobals(bridge)
  const body = drawerBody()
  try {
    renderQuickSettings(body, routeName)
    await tick()
    return body.innerHTML
  } finally {
    restore()
  }
}

/* A drawer body that remembers the nodes wire() asked it for, so a test can
   hand back a real-enough element and then press it. Only the ids the drawer
   binds are answered; everything else is absent, as it is in the DOM. */
function pressableBody(elements = {}) {
  return {
    innerHTML: '',
    querySelector(selector) {
      return elements[selector] || null
    },
  }
}

/** A segmented control shaped like the one segMarkup writes. */
function segElement(values) {
  const buttons = values.map(value => ({
    dataset: { ledger: value },
    classList: { toggle() {} },
    setAttribute() {},
  }))
  let handler = null
  return {
    buttons,
    addEventListener(type, fn) { if (type === 'click') handler = fn },
    querySelectorAll() { return buttons },
    press(value) {
      const button = buttons.find(candidate => candidate.dataset.ledger === value)
      handler?.({ target: { closest: () => button } })
    },
  }
}

const BRIDGE = {
  tools: async () => { throw new Error('the drawer must not read the tool list') },
  getSetting: async () => { throw new Error('the drawer must not read the tool answers') },
  putSetting: async () => { throw new Error('the drawer must not write the tool answers') },
}

test('the drawer offers one door to the tools page, on every route', async () => {
  for (const route of ['home', 'research', 'settings', 'metrics']) {
    const drawer = await render(route, BRIDGE)
    assert.match(drawer, /href="#\/tools"/, `the ${route} route has no path to the tools page`)
    assert.equal((drawer.match(/href="#\/tools"/g) || []).length, 1,
      `the ${route} route offers two doors to one page`)
  }
})

test('the drawer holds no copy of the tool list and asks the machine for nothing', async () => {
  /* The bridge throws on every call. A drawer that still renders is a drawer
     that never reached for the list -- which is the assertion, because reading
     three hundred tools into a popover on every gear press was the cost that
     came with the list living here. */
  const drawer = await render('research', BRIDGE)
  assert.doesNotMatch(drawer, /data-tool-name=/, 'the drawer still renders per-tool controls')
  assert.doesNotMatch(drawer, /data-drawer-tools/, 'the drawer still hosts the tool list')
  assert.doesNotMatch(drawer, /withheld/i, 'the drawer still reports withheld tools as a count')
})

test('a route with nothing of its own says so, rather than showing an invented control', async () => {
  const drawer = await render('research', BRIDGE)
  assert.match(drawer, /No settings specific to this page\./,
    'a route with no page setting must say so plainly')
})

test('Home Quick Settings exposes the three labelled ledger colors for the current theme', async () => {
  const drawer = await render('home', BRIDGE)
  for (const status of ['clear', 'attention', 'blocked']) {
    assert.match(drawer, new RegExp(`data-home-color="${status}"`))
    assert.match(drawer, new RegExp(`data-home-color-reset="${status}"`))
  }
  assert.match(drawer, /Owner asks and proposals/)
  assert.match(drawer, /Saved for this theme/)
  assert.doesNotMatch(await render('research', BRIDGE), /data-home-color=/)
})

test('Quick Settings applies colors immediately, remembers each theme, resets and reports failed writes', t => {
  const restore = installGlobals(), values = new Map(), announced = [], handlers = new Map(), themeHandlers = new Map()
  t.after(restore)
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  window.dispatchEvent = event => { if (event.type === 'mc:quick-setting-changed') announced.push(event.detail) }
  const error = {}, label = {}, nodes = {}
  for (const status of ['clear', 'attention', 'blocked']) {
    nodes[`[data-home-color="${status}"]`] = { value: defaultHomeStatusColors('white')[status], dataset: { homeColor: status } }
    nodes[`[data-home-color-reset="${status}"]`] = { dataset: { homeColorReset: status }, setAttribute(name, value) { this[name] = value } }
  }
  const root = { querySelector: selector => selector === '#quick-home-colors-error' ? error : selector === '[data-home-colors-theme]' ? label : nodes[selector], addEventListener: (type, fn) => handlers.set(type, fn) }
  const themeSeg = { addEventListener: (type, fn) => themeHandlers.set(type, fn), querySelectorAll: () => [] }
  const body = pressableBody({ '[data-home-quick-colors]': root, '#theme-seg': themeSeg })
  renderQuickSettings(body, 'home')
  const choose = (status, value) => {
    const input = nodes[`[data-home-color="${status}"]`]; input.value = value
    handlers.get('change')({ target: { closest: () => input } })
  }
  const theme = name => themeHandlers.get('click')({ target: { closest: () => ({ dataset: { theme: name } }) } })
  choose('attention', '#ab9012')
  assert.equal(currentHomeStatusColor('attention'), '#ab9012')
  assert.equal(error.hidden, true)
  theme('ember')
  assert.equal(label.textContent, 'Ember')
  assert.equal(nodes['[data-home-color="attention"]'].value, defaultHomeStatusColors('ember').attention)
  choose('attention', '#f0d060')
  theme('white')
  assert.equal(nodes['[data-home-color="attention"]'].value, '#ab9012')
  handlers.get('click')({ target: { closest: () => nodes['[data-home-color-reset="attention"]'] } })
  assert.equal(nodes['[data-home-color="attention"]'].value, defaultHomeStatusColors('white').attention)
  assert.equal(currentHomeStatusColor('attention', localStorage, 'ember'), '#f0d060')
  const before = announced.length
  localStorage.setItem = () => { throw new Error('denied') }
  choose('blocked', '#aa2233')
  assert.equal(announced.length, before)
  assert.equal(error.hidden, false)
  assert.match(error.textContent, /could not be saved/)
  assert.equal(nodes['[data-home-color="blocked"]'].value, defaultHomeStatusColors('white').blocked)
  assert.ok(announced.some(event => event.settingId === 'home_circle_attention_color' && event.value === '#ab9012'))
})

test('the app-wide controls are untouched by the move', async () => {
  const drawer = await render('home', BRIDGE)
  for (const id of ['theme-seg', 'font-seg', 'text-seg', 'set-glow', 'set-motion']) {
    assert.ok(drawer.includes(id), `the drawer lost ${id}, which the settings page and the harnesses drive by name`)
  }
  assert.match(drawer, /data-quick-example/, 'the drawer lost the example switch')
})

/* ==================================================================
   THE 2026-08-27 PASS. The owner: the pop-out "is outdated from earlier days
   of the program. it needs to provide useful settings in a way more consistent
   with the theme now."
   ================================================================== */

test('no risk statement is printed twice — one disclosure per family, not one per row', async () => {
  /* THE DEFECT, MEASURED IN A BROWSER before this changed. Five appearance rows
     each carried their own guidanceMarkup call, and src/permission-guidance.js
     resolves Theme and Font to ONE `appearance` statement and Glow and Reduce
     motion to ONE `motion` statement. So the panel printed two identical bodies
     four lines apart, twice over. permission-guidance's own suite forbids one
     statement appearing under two subjects; this surface was doing it on
     screen.
     Asserted through the SUBJECT IDS the drawer asks for rather than through
     the rendered words (guidanceMarkup is stubbed to '' here, as it must be for
     the other tests): a family may be asked for exactly once. */
  const drawer = readFileSync(new URL('../../src/quick-settings.js', import.meta.url), 'utf8')
  const appRows = drawer.slice(drawer.indexOf('function appRows'), drawer.indexOf('async function fillBuildRow'))
  const asked = [...appRows.matchAll(/guidanceMarkup\('([a-z_]+)'|note\('([a-z_]+)'/g)]
    .map(match => match[1] || match[2])
  assert.deepEqual(asked, ['example_mode', 'theme', 'text_size', 'glow'],
    'each family is asked once, in row order; a second call for a family already asked is the duplicate this closes')
  /* Font and Reduce motion deliberately have NO call of their own: they share
     the statement of the row above them, and the summary line says so. */
  assert.doesNotMatch(appRows, /guidanceMarkup\('ui_font'/, 'Font would repeat the Appearance body verbatim')
  assert.doesNotMatch(appRows, /guidanceMarkup\('reduce_motion'/, 'Reduce motion would repeat the Motion body verbatim')
  for (const [id, named] of [['theme', /Theme and Font/], ['text_size', /Text size/], ['glow', /Glow and Reduce motion/]]) {
    const call = new RegExp(`note\\('${id}',\\s*'[^']*',\\s*'([^']*)'\\)`).exec(appRows)
    assert.ok(call, `the ${id} disclosure lost its summary`)
    assert.match(call[1], named, `the ${id} summary must name the rows it covers, or a shared note reads as a stray one`)
  }
})

test('the two rows that decide something real are the first two, above the cosmetic block', async () => {
  /* MEASURED 2026-08-27 at 1366x768: the body scrolled 901px inside a 630px
     box and the tools door sat at y=890 — off screen at every open, on every
     route. It is not the only way to #/tools (the settings page carries a door
     too, and RING_EXIT gives the page arrows back to Settings), but it is the
     only one a person is offered without leaving the page they are on, which
     is the whole reason the drawer was given it. A door nobody sees is not a
     door. */
  const drawer = await render('home', BRIDGE)
  const example = drawer.indexOf('data-quick-example')
  const door = drawer.indexOf('href="#/tools"')
  const theme = drawer.indexOf('id="theme-seg"')
  const glow = drawer.indexOf('id="set-glow"')
  assert.ok(example !== -1 && door !== -1 && theme !== -1 && glow !== -1, 'a named row is missing')
  assert.ok(example < door, 'the example switch is the first row')
  assert.ok(door < theme, 'the tools door must sit above the appearance block, not under it')
  assert.ok(theme < glow, 'the appearance block keeps its order')
})

test('the filler line is gone and nothing dresses it any more', async () => {
  /* "Set here, applied now — the fleet keeps running." — a three-line mono
     paragraph promising the one thing every control here demonstrates by
     doing it, in a column that was already 271px over its box. */
  const drawer = await render('home', BRIDGE)
  assert.doesNotMatch(drawer, /drawer-note/, 'the filler line came back')
  assert.doesNotMatch(drawer, /the fleet keeps running/, 'the filler sentence came back')
  const sheet = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')
  assert.doesNotMatch(sheet.replace(/\/\*[\s\S]*?\*\//g, ''), /\.drawer-note\s*\{/,
    'a rule dressing markup nobody builds is dead weight in the shipped sheet')
})

test('the three controls measured under the desktop hit floor are raised by the sheet', () => {
  /* MEASURED in a real browser at 1366x768 on four routes (2026-08-27):
     .guided-summary 16px tall, #set-glow 22px, .set-row.set-link 17px. A phone
     was already covered — src/phone-canvas.css raises every control in phone
     mode to 44px with !important, which outranks anything written here — so the
     floor that did not exist was the desktop one.
     Pinned as the DECLARATION rather than as a measurement, the way
     tools/test/mobile-size-floor.test.mjs pins its own: this repository has no
     DOM in its node tests, and a gate that claims coverage it does not have is
     worse than no gate. The browser drive is what measured it. */
  const sheet = readFileSync(new URL('../../src/settings.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const floor = /\.drawer \.drawer-body[^{]*\{[^}]*min-height:\s*var\(--s5\)[^}]*\}/.exec(sheet)
  assert.ok(floor, 'the drawer has no hit floor at all')
  const selector = floor[0].slice(0, floor[0].indexOf('{'))
  for (const [name, part] of [
    ['the risk disclosures', '.guided-summary'],
    ['the tools door', '.set-row.set-link'],
    ['the glow slider', 'input[type="range"]'],
  ]) {
    assert.ok(selector.includes(part), `${name} (${part}) is not under the floor`)
  }
  /* --s5 IS the existing 24px step. A raw length here would be a second size
     vocabulary, which is the thing the phone floor's own suite refuses. */
  assert.doesNotMatch(selector, /@media/, 'a floor conditional on width is not a floor')
})

test('the footer main.js hides on its own route is really hidden', () => {
  /* MEASURED on #/settings at 1366x768 (2026-08-27): `.drawer-all.hidden` was
     true, its computed display was still `block`, the bar drew 318x43 across
     the foot of the panel and elementFromPoint at its centre answered
     `.drawer-all`. So "all settings →" was live and pressable on the one route
     where src/main.js had decided it must not be — its own words: "A door out
     of a room you are standing in is not a door."
     The cause is specificity: `.drawer .drawer-all { display: block }` is
     (0,2,0) and the UA's `[hidden] { display: none }` is (0,0,1). Exactly the
     defect this same sheet already records for `.settings-rail-sections`. */
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
  assert.match(main, /allSettings\.hidden = route === 'settings'/,
    'main.js no longer hides the footer on the route it points at')
  const sheet = readFileSync(new URL('../../src/settings.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const authorDisplay = /\.drawer\s+\.drawer-all\s*\{[^}]*display:\s*(?!none)/.test(sheet)
  const guard = /\.drawer\s+\.drawer-all\[hidden\]\s*\{[^}]*display:\s*none/.test(sheet)
  assert.ok(!authorDisplay || guard,
    'the footer is given an author display, which out-ranks the hidden attribute; it needs the [hidden] guard beside it')
  assert.ok(guard, 'the guard that makes `hidden` mean hidden is gone')
})

/* ---------- the page setting, which had no control anywhere ---------- */

test('a desktop is offered no ledger control, because a desktop cannot use one', async () => {
  /* phoneLedgerDecision refuses unless the phone canvas is already on, and no
     desktop window at any width can turn that mode on. A row here would be a
     control that cannot move anything. */
  for (const route of ['computers', 'home', 'metrics']) {
    const drawer = await render(route, { ...BRIDGE, phone: false })
    assert.doesNotMatch(drawer, /id="ledger-seg"/, `the ${route} route drew a phone-only control on a desktop`)
  }
  const drawer = await render('computers', { ...BRIDGE, phone: false })
  assert.match(drawer, /data-quick-agent-api/,
    'the desktop fleet page carries the agent API mode even without a phone ledger control')
  assert.doesNotMatch(drawer, /No settings specific to this page\./)
})

test('Computer quick settings exposes Optimized API on desktop and phone without a Settings-mode gate', async () => {
  for (const phone of [false, true]) {
    const drawer = await render('computers', { ...BRIDGE, phone })
    const document = createDocument()
    const body = document.createElement('div')
    body.innerHTML = drawer
    const choices = [...body.querySelectorAll('[data-agent-api-mode]')].map(button => button.textContent)
    assert.ok(choices.includes('Optimized'), 'Optimized is a selectable tool-mode option in the rendered drawer')
    for (const choice of ['Only', 'Enabled', 'Disabled']) assert.ok(choices.includes(choice), choice)
    assert.match(drawer, /Tool discovery/)
    assert.match(drawer, /data-agent-api-discovery="agent.tool_summary"/)
    assert.match(drawer, /data-agent-api-discovery="agent.capability_recall"/)
    assert.match(drawer, /Introduce available tools/)
    assert.match(drawer, /Suggest relevant tools/)
  }
  assert.doesNotMatch(await render('home', { ...BRIDGE, phone: false }), /data-agent-api-discovery=/)
})

test('in phone mode the fleet page offers the ledger, and no other route does', async () => {
  const fleet = await render('computers', { ...BRIDGE, phone: true })
  assert.match(fleet, /id="ledger-seg"/, 'the fleet page is the page the ledger draws; it must carry the control')
  assert.match(fleet, /Show the tree as/, 'the row must say what it does')
  assert.match(fleet, /data-ledger="off"[^>]*>Graph</, 'the way back to the canonical graph is the point of this row')
  assert.match(fleet, /data-ledger="on"[^>]*>Rows</)
  assert.doesNotMatch(fleet, /No settings specific to this page\./,
    'the page now HAS a setting of its own, so the honest empty line would be a false one')
  for (const route of ['home', 'metrics', 'research', 'settings']) {
    const other = await render(route, { ...BRIDGE, phone: true })
    assert.doesNotMatch(other, /id="ledger-seg"/, `${route} does not draw the tree, so it must not offer its view style`)
    if (route === 'home') assert.match(other, /data-home-quick-colors/, 'Home has its own colors on phones too')
    else assert.match(other, /No settings specific to this page\./, `${route} must keep the honest line`)
  }
})

/* THE SEGMENT MUST SHOW WHAT IS ON THE SCREEN, which is the whole job of a
 * chosen segment. It used to draw Graph for everything except a literal 'on',
 * because 'auto' meant off. Now 'auto' means the ledger, so drawing Graph for
 * 'auto' would have this panel telling a person the opposite of what they are
 * looking at -- and this control is how they change it, so being wrong here is
 * worse than being absent. Only a stored 'off' selects Graph. */
test('the stored choice is what the ledger control reads back', async () => {
  for (const stored of ['on', 'auto', 'banana', null]) {
    const drawer = await render('computers', { ...BRIDGE, phone: true, ledgerChoice: stored })
    assert.match(drawer, /data-ledger="on"[^>]*class="on"/,
      `stored ${JSON.stringify(stored)} is not "off", so Rows is what is drawn and the segment must say so`)
  }
  const off = await render('computers', { ...BRIDGE, phone: true, ledgerChoice: 'off' })
  assert.match(off, /data-ledger="off"[^>]*class="on"/,
    'a stored "off" is the one case that draws Graph, and the way back must stay honest')
})

test('a storage the browser will not read is a stated refusal, never a segment drawn as chosen', async () => {
  /* readPhoneLedgerChoice throws PHONE_LEDGER_COULD_NOT_TELL rather than
     answering a default, and mountPhoneLedger returns null on the same throw —
     so the page really is showing the graph while the SETTING is unknown.
     Drawing "Graph" as the chosen segment would be this panel asserting a value
     nobody could read, and the control could not work either: the press writes
     nothing and the re-render reads nothing. */
  const restore = installGlobals({ ...BRIDGE, phone: true })
  globalThis.__quickSettingsStubs.readPhoneLedgerChoice = () => {
    throw Object.assign(new Error('private mode'), { code: 'PHONE_LEDGER_COULD_NOT_TELL' })
  }
  const body = drawerBody()
  try {
    renderQuickSettings(body, 'computers')
  } finally {
    restore()
  }
  const drawer = body.innerHTML
  assert.match(drawer, /id="ledger-seg"/, 'the row must still be there — the setting exists, it just could not be read')
  /* Only the page group: the appearance segments below it read their state off
     the document, which is readable, and one of each is legitimately chosen. */
  const pageGroup = drawer.slice(0, drawer.indexOf('drawer-group-app'))
  assert.doesNotMatch(pageGroup, /class="on"|aria-pressed="true"/,
    'a segment drawn as chosen is a value this panel could not read being asserted anyway')
  assert.equal((pageGroup.match(/data-ledger="[^"]*" disabled/g) || []).length, 2,
    'both segments must be disabled; a live control here writes nothing and changes nothing')
  /* IN PROSE, NOT ONLY IN A title. This control's whole audience is a phone,
     and a phone has no hover — a tooltip there is a sentence nobody can reach.
     The reason has to be on the panel. */
  assert.match(pageGroup, /<div class="drawer-page-empty">[^<]*will not let the app read or keep its own settings[^<]*<\/div>/,
    'the refusal must be said on the panel, not hidden in a tooltip a phone cannot open')
})

test('pressing the ledger control writes through the one licensed writer, and nothing else', async () => {
  /* THE CONTROL MUST NOT TOUCH THE KEY. tools/test/phone-ledger.test.mjs holds
     src/phone-ledger.js as the single writer of 'mc.phoneLedger'; this drawer
     asks that module and applies nothing itself, so the panel can never hold an
     opinion the page disagrees with. */
  const ledgerWrites = []
  const stored = []
  const seg = segElement(['off', 'on'])
  const restore = installGlobals({
    ...BRIDGE,
    phone: true,
    ledgerChoice: 'on',
    ledgerWrites,
  })
  const previousStorage = globalThis.localStorage
  globalThis.localStorage = {
    getItem: () => null,
    setItem: (key, value) => { stored.push([key, value]) },
    removeItem() {},
  }
  try {
    renderQuickSettings(pressableBody({ '#ledger-seg': seg }), 'computers')
    seg.press('off')
    seg.press('on')
  } finally {
    globalThis.localStorage = previousStorage
    restore()
  }
  assert.deepEqual(ledgerWrites, ['off', 'on'],
    'each press must reach setPhoneLedgerChoice with the value the button names')
  assert.deepEqual(stored, [],
    'the drawer wrote the key itself; the ledger module is the only writer there is')
})

test('a refused ledger value moves no segment', async () => {
  /* setPhoneLedgerChoice answers null for anything that is not one of its three
     choices. A control that repaints on a refusal would be showing a state the
     product does not hold. */
  const seg = segElement(['off'])
  let painted = 0
  seg.buttons[0].classList = { toggle() { painted += 1 } }
  const restore = installGlobals({
    ...BRIDGE,
    phone: true,
    ledgerWrites: { push() {} },
  })
  globalThis.__quickSettingsStubs.setPhoneLedgerChoice = () => null
  try {
    renderQuickSettings(pressableBody({ '#ledger-seg': seg }), 'computers')
    seg.press('off')
  } finally {
    restore()
  }
  assert.equal(painted, 0, 'the segment repainted after a write the module refused')
})

/* T1575: the drawer headed its page group with the route id: 'This page ·
   comms' on Messages, and a lower-case id on every other page. It names the
   page the way the rail's own link does; a page with no rail link gets its
   name with a capital. */
test('the drawer names the page the way the rail does, never by its route id', async () => {
  const restore = installGlobals()
  try {
    const rail = { comms: 'Messages', research: 'Research', home: 'Home', settings: 'Settings' }
    globalThis.document.querySelector = selector => {
      const match = /^#tb-nav a\[data-route="([^"]+)"\]$/.exec(selector)
      return match && rail[match[1]] ? { textContent: `\n        ${rail[match[1]]}\n      ` } : null
    }
    for (const [route, name] of Object.entries(rail)) {
      const body = drawerBody()
      renderQuickSettings(body, route)
      await tick()
      assert.match(body.innerHTML, new RegExp(`>This page · ${name}</h3>`), `the ${route} drawer does not use the rail's name ${name}`)
      if (name !== route) assert.doesNotMatch(body.innerHTML, new RegExp(`This page · ${route}<`))
    }
    const tools = drawerBody()
    renderQuickSettings(tools, 'tools')
    await tick()
    assert.match(tools.innerHTML, />This page · Tools<\/h3>/)
  } finally { restore() }
})
