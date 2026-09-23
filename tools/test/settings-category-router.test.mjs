/* THE SETTINGS RAIL IS A ROUTER, AND THIS IS WHAT THAT MEANS ON THE GLASS.
 *
 * The owner: "the settings categories should be THEIR OWN SEPERATED FULLY
 * SEPERATE PAGES FOR EACH SECTION so when i press one on the list on the left
 * hand side it pulls up just that category of settings and no other categories
 * from the list."
 *
 * WHAT THIS SUITE HOLDS, and each of the four is a way the old page could come
 * back without anybody noticing:
 *
 *   1  ONE CATEGORY IS ON SCREEN. The page renders the category the address
 *      names and no part of any other. Asserted as a SET of section names read
 *      back out of the markup, not as a count: 'System' is two controllers
 *      drawing two sections under one name, so counting would have to know
 *      that and would go red the day a third joined.
 *
 *   2  EVERY CATEGORY CAN BE THE ONLY ONE. Each of the twelve is mounted on its
 *      own and has to render its own section. This is the half that catches a
 *      controller which assumed the whole page was in the DOM around it: five
 *      of the twelve sections are built by their own module, and a module that
 *      reached for a node in a neighbouring section used to find one.
 *
 *   3  THE ADDRESS IS THE STATE. A press navigates rather than scrolling, an
 *      unknown category is a person following an old link rather than an error,
 *      and `?setting=` still lands on the page holding the row it names.
 *
 *   4  THE SCROLL-SPY STAYS DEAD. It reassigned the highlighted category from
 *      whatever was nearest the top of the window, which is a thing only a
 *      single long document can do, and it would silently overrule the address.
 *
 * THE WINDOW IS THE ONE src/views/settings.js ALREADY GETS TESTED THROUGH
 * (tools/test/settings.test.mjs): the view imports stylesheets and reads back
 * almost nothing it writes, so what is asserted here is the markup it paints
 * into `.settings-sections` plus the two handlers it binds.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/* ---------- the window ---------- */

const stored = new Map()
const listeners = new Map()
let painted = ''
let footerText = ''
let railHandlers = []

const classList = () => ({
  add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false,
})

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
    /* The page hands a live element to one row rather than a string of markup
       ("This computer" hosts src/this-computer-settings.js), so the stub has to
       accept a child the way a real node does. It keeps the child rather than
       dropping it, because a stub that silently swallows what a view mounts
       would let a mount that never happened look exactly like one that did. */
    children: [],
    appendChild(child) { this.children.push(child); return child },
    getBoundingClientRect: () => ({ top: 0 }), getClientRects: () => [{ top: 0 }], scrollIntoView: () => {}, focus: () => {},
  }
}

const sections = node()
Object.defineProperty(sections, 'innerHTML', {
  get: () => painted,
  set: value => { painted = String(value) },
})

const footer = node()
Object.defineProperty(footer, 'textContent', {
  get: () => footerText,
  set: value => { footerText = String(value) },
})

/* The rail hands its click handler over so a press can be delivered without a
   real event system; everything else on the page is the generic stub. */
const rail = node()
rail.addEventListener = (type, handler) => { if (type === 'click') railHandlers.push(handler) }

const save = node(), discard = node(), draftStatus = node(), searchInput = node()
const root = node()
root.querySelector = selector => {
  if (selector === '.settings-search input') return searchInput
  if (selector === '[data-settings-save]') return save
  if (selector === '[data-settings-discard]') return discard
  if (selector === '[data-settings-draft-status]') return draftStatus
  if (selector === '.settings-sections') return sections
  if (selector === '.settings-rail') return rail
  if (selector === '.settings-footer') return footer
  return node()
}

/* The page's own frame, kept as it was written: the rail is built into this
   template rather than painted into `.settings-sections`, so it is the only
   place a test can read what the menu offered. */
let mounted = ''
globalThis.document = {
  /* EVERY TEMPLATE THIS PAGE BUILDS, NOT MERELY THE LAST ONE.
     The page frame is one el() call, but a row may build its own: 'This
     computer' hosts a live element from src/this-computer-settings.js, which
     is two more templates, created DURING the first render. A stub that let
     the last write win reported the rail as missing -- 'the rail has no button
     for "Tool use"' -- when the rail had in fact been drawn and then followed
     by somebody else's markup through the same shared stub. A real document
     hands out a separate template each time and loses nothing, so neither does
     this. The frame is still the only markup carrying `settings-rail`, so the
     reads below are unambiguous. */
  createElement: () => ({
    set innerHTML(value) { mounted += String(value) },
    content: { firstElementChild: root },
  }),
  documentElement: node(), body: node(), getElementById: () => null, querySelectorAll: () => [],
}
globalThis.localStorage = {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => { stored.set(key, String(value)) },
  removeItem: key => { stored.delete(key) },
}
globalThis.location = { hash: '#/settings' }
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

const { FIRST_VISIT_SECTION, SETTINGS_GROUPS, categorySlug, sectionFromSlug } = await import('../../src/settings-presentation.js')
const { THIS_COMPUTER_PROGRAMS_ROW, THIS_COMPUTER_SECTION } = await import('../../src/this-computer-settings.js')
const { settingsView } = await import('../../src/views/settings.js')

const CATEGORIES = SETTINGS_GROUPS.flatMap(group => group.sections)

test('the one-agent-at-a-time control is reachable through Settings search from another category', () => {
  const view = settingsView({ query: new URLSearchParams('category=appearance') })
  searchInput.value = 'one agent at a time'
  searchInput.handlers.get('input')({ target: searchInput })
  assert.match(painted, /data-screen-control-settings/)
  view.destroy()
})

/** Which sections the last paint actually drew, in the order they appear. */
function sectionsInMarkup() {
  const seen = []
  for (const match of painted.matchAll(/data-settings-section="([^"]*)"/g)) {
    const name = match[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'")
    if (!seen.includes(name)) seen.push(name)
  }
  return seen
}

/** The rail's entry for one group: its head and the list under it. */
function railGroup(id) {
  const wrap = mounted.match(
    new RegExp(`<div class="settings-rail-group[^"]*" data-rail-group-wrap="${id}">([\\s\\S]*?)</div>\\s*</div>`),
  )
  assert.ok(wrap, `the rail has no entry for the ${id} group`)
  return wrap[1]
}

/** Mount the page at one address and hand back the view, already painted. */
function open({ category = null, setting = null } = {}) {
  painted = ''
  mounted = ''
  railHandlers = []
  const query = new URLSearchParams()
  if (category !== null) query.set('category', category)
  if (setting !== null) query.set('setting', setting)
  globalThis.location.hash = query.toString() ? `#/settings?${query}` : '#/settings'
  const navigated = []
  const view = settingsView({ query, navigate: hash => navigated.push(hash) })
  return { view, navigated }
}

/* ---------- 1. one category, and no part of any other ---------- */

test('Settings search finds optional Docker setup from another category', () => {
  const { view } = open({ category: categorySlug('Appearance') })
  try {
    for (const query of ['Docker', 'sandbox']) {
      searchInput.value = query
      searchInput.handlers.get('input')()
      assert.match(painted, /data-setup-profile-row="sandbox-setup"/)
      assert.match(painted, /Docker and sandbox setup \(optional\)/)
      assert.match(painted, /data-setup-profile-action="walkthrough">Open setup/)
      assert.doesNotMatch(painted, /No settings match this search/)
    }
  } finally {
    searchInput.value = ''
    view.destroy()
  }
})

test('the address names one category and the page draws that one alone', () => {
  const { view } = open({ category: categorySlug('Appearance') })
  assert.deepEqual(sectionsInMarkup(), ['Appearance'],
    `the page drew ${JSON.stringify(sectionsInMarkup())} for the Appearance address`)
  for (const other of CATEGORIES.filter(section => section !== 'Appearance')) {
    assert.ok(!painted.includes(`data-settings-section="${other}"`),
      `${other} was on screen under the Appearance address`)
  }
  view.destroy()
})

test('no group container is drawn around the category, so nothing promises the other eleven', () => {
  const { view } = open({ category: categorySlug('Ledger') })
  assert.doesNotMatch(painted, /settings-group/,
    'the long document\'s group boxes came back into the main column')
  view.destroy()
})

/* ---------- 2. every category can be the only thing on screen ---------- */

test('every category renders its own section when it is the only one asked for', () => {
  for (const section of CATEGORIES) {
    const { view } = open({ category: categorySlug(section) })
    assert.deepEqual(sectionsInMarkup(), [section],
      `asking for "${section}" drew ${JSON.stringify(sectionsInMarkup())}`)
    assert.ok(painted.length > 0, `"${section}" painted nothing`)
    view.destroy()
  }
})

test('the twelve slugs are twelve different addresses', () => {
  const slugs = CATEGORIES.map(categorySlug)
  assert.equal(new Set(slugs).size, slugs.length,
    `two categories share an address: ${slugs.join(', ')}`)
  for (const section of CATEGORIES) {
    assert.ok(categorySlug(section).length > 0, `"${section}" has no address`)
    assert.equal(sectionFromSlug(categorySlug(section)), section)
  }
})

/* A SECTION WITH NO GROUP USED TO RENDER AT THE END OF THE PAGE, and that was
   the whole safety net: a section the grouping model did not know still reached
   the glass. There is no end of the page to fall onto now -- one category is
   drawn and the rail is built from the same model -- so a section outside the
   model has no button, no address and no way to be seen. Derived from the
   source at run time, like tools/test/settings-rows-do-something.test.mjs: a
   row added tomorrow under a section nobody grouped fails here, by name. */
test('every section the page writes rows for is a category the rail can reach', () => {
  const source = readFileSync(path.join(ROOT, 'src', 'views', 'settings.js'), 'utf8')
  const named = new Set()
  for (const match of source.matchAll(/section: '([^']+)'/g)) named.add(match[1])
  assert.ok(named.size > 0, 'no section names could be read out of the settings page')
  for (const section of named) {
    assert.equal(sectionFromSlug(categorySlug(section)), section,
      `"${section}" is in no group, so nothing on the page can open it`)
  }
})

/* A LINK THAT NAMES A CATEGORY IS A PROMISE ABOUT A PAGE THAT EXISTS.
   The slug is derived from the section name, so a rename silently turns every
   written-down address into "the default category" -- which is not an error a
   person sees and not a page anybody meant. Every `?category=` literal in the
   product and in its drivers is resolved here instead, by name. */
test('every category address written down anywhere still names a category', () => {
  const roots = [path.join(ROOT, 'src'), path.join(ROOT, 'tools')]
  const found = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue
      const source = readFileSync(full, 'utf8')
      for (const match of source.matchAll(/#\/settings\?category=([a-z0-9-]+)/g)) {
        found.push({ file: path.relative(ROOT, full), slug: match[1] })
      }
    }
  }
  for (const root of roots) walk(root)
  assert.ok(found.length > 0, 'no category address was found to check, so this test proves nothing')
  for (const { file, slug } of found) {
    assert.ok(sectionFromSlug(slug), `${file} links to "${slug}", which is no category`)
  }
})

/* ---------- 3. the address is the state ---------- */

test('pressing a category in the rail navigates to that category, and does not scroll to it', () => {
  const { view, navigated } = open()
  const before = sectionsInMarkup()
  assert.equal(railHandlers.length, 1, 'the rail bound no click handler')
  railHandlers[0]({
    target: {
      closest: selector => (selector === 'button[data-category]'
        ? { dataset: { category: 'Motion & Effects' } }
        : null),
    },
  })
  assert.deepEqual(navigated, [`#/settings?category=${categorySlug('Motion & Effects')}`])
  /* The press changed the address and nothing else: the page is rebuilt from
     the address, so a press that also swapped the section here would be a
     second opinion about what is on screen. */
  assert.deepEqual(sectionsInMarkup(), before,
    'the press repainted the page instead of navigating')
  view.destroy()
})

test('no category chosen still lands on a real category, never an empty page', () => {
  const { view } = open()
  const drawn = sectionsInMarkup()
  assert.equal(drawn.length, 1, `the default address drew ${JSON.stringify(drawn)}`)
  assert.ok(CATEGORIES.includes(drawn[0]), `${drawn[0]} is not one of the rail's categories`)
  view.destroy()
})

/* A PAGE THAT SHOWS ONE CATEGORY HAS TO CHOOSE ONE FOR SOMEBODY WHO CHOSE
   NOTHING, and this is the choice: the category holding the product's one
   persistent door to #/account. It was measured 0x0 on a first visit once
   already -- a packaged driver reported `sign-in-link:zero-size` for a night --
   and a default that landed elsewhere would take the same door off the same
   screen by a different mechanism. */
/* THE DEFAULT MOVED ON 2026-09-10, AND THE REASON IT MOVED IS THE REASON THE
   RULE EXISTS. It was 'Tool use'. 'This computer' now carries the Install and
   Sign in controls that used to live on the page called "What this copy needs",
   and it is in the SAME group as the connect screen -- so the door the 0x0
   measurement above was about is still what a default arrival opens, and the
   section drawn on top of it is now the one that answers the first question a
   copy with nothing installed has. The assertion is stronger than the one it
   replaces: it reads the drawn page for the row carrying those controls,
   rather than pinning the section's name. */
test('arriving with nothing chosen shows the section holding the install and sign-in controls', () => {
  const { view } = open()
  assert.deepEqual(sectionsInMarkup(), [FIRST_VISIT_SECTION])
  assert.equal(FIRST_VISIT_SECTION, THIS_COMPUTER_SECTION)
  assert.ok(painted.includes(`data-setting-id="${THIS_COMPUTER_PROGRAMS_ROW}"`),
    'the default category drew no row carrying the Install and Sign in controls')
  view.destroy()
})

test('a category this copy does not have lands on the default rather than on nothing', () => {
  const { view: fallback } = open({ category: 'a-category-that-was-renamed' })
  const drawn = sectionsInMarkup()
  fallback.destroy()
  const { view: plain } = open()
  assert.deepEqual(drawn, sectionsInMarkup(),
    'an unknown category drew something other than the default page')
  plain.destroy()
})

test('a link that names a row still opens the page that row is on', () => {
  const { view } = open({ setting: 'reduce_motion' })
  assert.deepEqual(sectionsInMarkup(), ['Motion & Effects'])
  assert.ok(painted.includes('data-setting-id="reduce_motion"'),
    'the row the link named is not on the page it opened')
  view.destroy()
})

test('canonical and compatibility tool-mode links both land on the tool-use page', () => {
  for (const setting of ['agent.agent_api', 'agent.tool_mode']) {
    const { view } = open({ category: categorySlug('Appearance'), setting })
    assert.deepEqual(sectionsInMarkup(), ['Tool use'])
    assert.doesNotMatch(painted, /data-setting-id="agent.tool_mode"/)
    view.destroy()
  }
})

test('the rail offers every category as its own door', () => {
  const { view } = open()
  for (const section of CATEGORIES) {
    assert.ok(mounted.includes(`data-category="${section.replace(/&/g, '&amp;')}"`),
      `the rail has no button for "${section}"`)
  }
  view.destroy()
})

test('the group holding the category on screen is open, whatever the remembered posture says', () => {
  stored.clear()
  /* A posture with one unrelated group open: the remembered state is honoured
     and is not, on its own, an answer about the category being shown. */
  stored.set('mc.settings.open-groups', JSON.stringify(['appearance']))
  const { view } = open({ category: categorySlug('Ledger') })
  assert.match(railGroup('privacy'), /aria-expanded="true"/,
    'the rail folded away the category the page is showing')
  assert.match(railGroup('appearance'), /aria-expanded="true"/,
    'the remembered posture was thrown away')
  /* And being shown is not a filing decision: the store still says what the
     person last left open, not what an address opened for them. */
  assert.deepEqual(JSON.parse(stored.get('mc.settings.open-groups')), ['appearance'])
  view.destroy()
  stored.clear()
})

test('opening a group in the rail is a menu opening, and moves nothing on the page', () => {
  stored.clear()
  const { view, navigated } = open()
  const before = painted
  railHandlers[0]({
    target: {
      closest: selector => (selector === 'button[data-rail-group]'
        ? { dataset: { railGroup: 'appearance' } }
        : null),
    },
  })
  assert.equal(painted, before, 'opening a group changed what the page was showing')
  assert.deepEqual(navigated, [], 'opening a group navigated somewhere')
  assert.deepEqual(JSON.parse(stored.get('mc.settings.open-groups')), ['appearance'],
    'the group a person opened was not remembered')
  view.destroy()
  stored.clear()
})

test('the footer says what is off screen now, which is the other categories', () => {
  const { view } = open()
  assert.match(footerText, /one category at a time/i)
  assert.doesNotMatch(footerText, /closed groups/i)
  view.destroy()
})

/* ---------- 4. the scroll-spy stays dead ---------- */

test('nothing reassigns the category from the scroll position', () => {
  const source = readFileSync(path.join(ROOT, 'src', 'views', 'settings.js'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /addEventListener\('scroll'/,
    'the settings page listens to its own scroll again')
  assert.doesNotMatch(code, /getBoundingClientRect/,
    'the settings page measures section positions again, which is how the spy worked')
  assert.match(code, /\?category=/, 'the category is no longer written into the address')
})


test('a settings edit survives category navigation, warns on leaving, and writes after Save', async t => {
  stored.clear()
  const { view } = open({ category: categorySlug('Appearance') })
  t.after(() => view.destroy())
  const row = { dataset: { settingId: 'theme' } }
  const button = { dataset: { settingValue: 'black' }, closest: () => row }
  sections.handlers.get('click')({ target: { closest: selector => selector === 'button[data-setting-value]' ? button : null } })
  assert.equal(stored.has('mc.theme'), false)
  assert.equal(save.disabled, false)
  let confirmations = []
  window.confirm = message => { confirmations.push(message); return false }
  assert.equal(view.beforeLeave({ name: 'settings', query: new URLSearchParams({ category: categorySlug('Ledger') }) }), 'updated')
  assert.deepEqual(confirmations, [])
  assert.equal(view.beforeLeave({ name: 'home' }), false)
  assert.match(confirmations.at(-1), /discard unsaved changes/)
  await save.handlers.get('click')()
  assert.equal(stored.get('mc.theme'), 'black')
  assert.equal(confirmations.length, 1, 'an appearance save adds no unrelated permission confirmation')
  assert.equal(view.beforeLeave({ name: 'home' }), true, draftStatus.textContent)
  view.destroy()
  delete window.confirm
})

test('leaving Settings discards pending values and does not write them', () => {
  stored.clear()
  const { view } = open({ category: categorySlug('Appearance') })
  const button = { dataset: { settingValue: 'black' }, closest: () => ({ dataset: { settingId: 'theme' } }) }
  sections.handlers.get('click')({ target: { closest: selector => selector === 'button[data-setting-value]' ? button : null } })
  window.confirm = () => true
  assert.equal(view.beforeLeave({ name: 'home' }), true)
  view.destroy()
  assert.equal(stored.has('mc.theme'), false)
  const reopened = open({ category: categorySlug('Appearance') })
  assert.equal(reopened.view.beforeLeave({ name: 'home' }), true)
  reopened.view.destroy()
  delete window.confirm
})

test('the Home circle row saves a persistent style only through the shared draft', async t => {
  stored.clear()
  const { HOME_CIRCLE_STYLE_KEY, HOME_CIRCLE_STYLE_EVENT, currentHomeCircleStyle } = await import('../../src/home-circle-choice.js')
  const changes = []
  const onChange = event => changes.push(event.detail.value)
  window.addEventListener(HOME_CIRCLE_STYLE_EVENT, onChange)
  const { view } = open({ category: categorySlug('Appearance') })
  t.after(() => {
    view.destroy()
    window.removeEventListener(HOME_CIRCLE_STYLE_EVENT, onChange)
    delete window.confirm
  })
  assert.match(painted, /data-setting-id="home_circle_style"/)
  assert.match(painted, /Home circle/)
  /* Classic (id 'simple') is the default since the hotload 4623 delivery; Blob (id 'standard') is the saved choice. */
  assert.match(painted, /Classic/)
  assert.match(painted, /Blob/)
  const choose = value => {
    const button = { dataset: { settingValue: value }, closest: () => ({ dataset: { settingId: 'home_circle_style' } }) }
    sections.handlers.get('click')({ target: { closest: selector => selector === 'button[data-setting-value]' ? button : null } })
  }
  choose('standard')
  assert.equal(currentHomeCircleStyle(), 'simple')
  assert.equal(stored.has(HOME_CIRCLE_STYLE_KEY), false)
  assert.deepEqual(changes, [])
  discard.handlers.get('click')()
  assert.equal(stored.has(HOME_CIRCLE_STYLE_KEY), false)
  assert.deepEqual(changes, [])
  choose('standard')
  window.confirm = () => true
  await save.handlers.get('click')()
  assert.equal(stored.get(HOME_CIRCLE_STYLE_KEY), 'standard')
  assert.deepEqual(changes, ['standard'])
  choose('simple')
  assert.equal(currentHomeCircleStyle(), 'standard', 'pending default does not change the saved style')
  await save.handlers.get('click')()
  assert.equal(stored.has(HOME_CIRCLE_STYLE_KEY), false)
  assert.deepEqual(changes, ['standard', 'simple'])
})

test('Home circle motion applies only after Save and can return to the device default', async t => {
  stored.clear()
  const { HOME_CIRCLE_MOTION_KEY, HOME_CIRCLE_MOTION_EVENT, currentHomeCircleMotion } = await import('../../src/home-circle-choice.js')
  const changes = []
  const onChange = event => changes.push({ value: event.detail.value, saved: currentHomeCircleMotion() })
  window.addEventListener(HOME_CIRCLE_MOTION_EVENT, onChange)
  const { view } = open({ setting: 'home_circle_motion' })
  t.after(() => {
    view.destroy()
    window.removeEventListener(HOME_CIRCLE_MOTION_EVENT, onChange)
    delete window.confirm
  })
  assert.deepEqual(sectionsInMarkup(), ['Motion & Effects'])
  assert.match(painted, /data-setting-id="home_circle_motion"/)
  assert.match(painted, /data-setting-value="system"/)
  assert.match(painted, /data-setting-value="animate"/)
  assert.match(painted, /data-setting-value="still"/)
  const choose = value => {
    const button = { dataset: { settingValue: value }, closest: () => ({ dataset: { settingId: 'home_circle_motion' } }) }
    sections.handlers.get('click')({ target: { closest: selector => selector === 'button[data-setting-value]' ? button : null } })
  }
  choose('animate')
  assert.equal(currentHomeCircleMotion(), 'system')
  assert.deepEqual(changes, [])
  discard.handlers.get('click')()
  assert.equal(stored.has(HOME_CIRCLE_MOTION_KEY), false)
  assert.deepEqual(changes, [])
  choose('animate')
  window.confirm = () => true
  await save.handlers.get('click')()
  assert.equal(stored.get(HOME_CIRCLE_MOTION_KEY), 'animate')
  assert.deepEqual(changes, [{ value: 'animate', saved: 'animate' }])
  choose('still')
  assert.equal(currentHomeCircleMotion(), 'animate')
  await save.handlers.get('click')()
  assert.equal(stored.get(HOME_CIRCLE_MOTION_KEY), 'still')
  choose('system')
  assert.equal(currentHomeCircleMotion(), 'still')
  await save.handlers.get('click')()
  assert.equal(stored.has(HOME_CIRCLE_MOTION_KEY), false)
  assert.deepEqual(changes, ['animate', 'still', 'system'].map(value => ({ value, saved: value })))
})

test('Home color drafts save to the theme they were edited for and can be discarded', async t => {
  stored.clear()
  document.documentElement.dataset.theme = 'white'
  const { currentHomeStatusColor } = await import('../../src/home-status-colors.js')
  const { view } = open({ setting: 'home_circle_attention_color' })
  t.after(() => { view.destroy(); document.documentElement.dataset.theme = 'white' })
  const choose = value => {
    const input = { value, closest: () => ({ dataset: { settingId: 'home_circle_attention_color' } }) }
    sections.handlers.get('input')({ target: { closest: selector => selector === '[data-setting-color]' ? input : null } })
  }
  choose('#ab9012')
  assert.equal(currentHomeStatusColor('attention'), 'auto')
  discard.handlers.get('click')()
  assert.equal(currentHomeStatusColor('attention'), 'auto')
  choose('#ab9012')
  document.documentElement.dataset.theme = 'ember'
  window.dispatchEvent(new CustomEvent('mc:quick-setting-changed', { detail: { settingId: 'theme', value: 'ember' } }))
  choose('#eedc77')
  await save.handlers.get('click')()
  assert.equal(currentHomeStatusColor('attention', localStorage, 'white'), '#ab9012')
  assert.equal(currentHomeStatusColor('attention', localStorage, 'ember'), '#eedc77')
  assert.equal(currentHomeStatusColor('attention', localStorage, 'tan'), 'auto')
  assert.equal(save.disabled, true)
})
