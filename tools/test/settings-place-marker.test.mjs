/* THE PLACE MARKER ABOVE A SETTINGS CATEGORY HAS TO KEEP BEING TRUE.
 *
 * The page grew a marker over its main column -- a breadcrumb and a line
 * counting the categories in the group -- so a reader can tell where they are
 * without reading the rail. It was written into the page's template once, at
 * construction, and nothing ever wrote it again.
 *
 * That is the same defect this file's neighbours were written for, in a new
 * place: TWO THINGS ON ONE SCREEN ALLOWED TO DISAGREE. Typing in the search box
 * replaces the whole main column with results drawn from every category, and
 * the footer under them says so in words -- "Search looks through all of them"
 * -- while the marker directly above them still names one group and counts the
 * categories in it. A person reading the marker is being told they are inside
 * "Start here" while the rows under it come from all twelve categories.
 *
 * WHAT THIS SUITE HOLDS:
 *
 *   1  THE MARKER NAMES THE PAGE YOU ARE ON. The category on screen is the last
 *      step of the breadcrumb, not a level the reader has to infer from the
 *      rail, and the count beside it is the group's real size.
 *
 *   2  THE MARKER MOVES WITH THE MAIN COLUMN. A search makes it say the search;
 *      clearing the search puts the category back. The marker is re-rendered by
 *      the same two functions that paint the column, so there is no third place
 *      that can hold a stale answer.
 *
 *   3  THE BREADCRUMB IS ADDRESSABLE BY ASSISTIVE TECHNOLOGY. `aria-label` on a
 *      role-less `div` is discarded by every AT that implements ARIA -- a
 *      generic element cannot be named -- so the label has to sit on an element
 *      with a role that accepts one, and the step that names the page you are on
 *      has to say it is the current one.
 *
 * The window is the one src/views/settings.js is already tested through
 * (tools/test/settings-category-router.test.mjs): what is asserted is the
 * markup the view paints, plus the two handlers it binds.
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

register('./helpers/css-stub-loader.mjs', import.meta.url)

/* ---------- the window ---------- */

const stored = new Map()
const listeners = new Map()
let painted = ''
let contextPainted = null
let mounted = ''
let railHandlers = []
let searchHandlers = []

const classList = () => ({
  add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false,
})

function node() {
  return {
    dataset: {}, value: '', checked: false, textContent: '', hidden: false,
    children: [], appendChild(child) { this.children.push(child); return child },
    classList: classList(),
    style: { setProperty: () => {}, getPropertyValue: () => '' },
    addEventListener: () => {}, removeEventListener: () => {},
    setAttribute: () => {}, removeAttribute: () => {}, toggleAttribute: () => {},
    getAttribute: () => null, querySelector: () => node(), querySelectorAll: () => [],
    closest: () => null, contains: () => true,
    getBoundingClientRect: () => ({ top: 0 }), scrollIntoView: () => {}, focus: () => {},
  }
}

const sections = node()
Object.defineProperty(sections, 'innerHTML', {
  get: () => painted,
  set: value => { painted = String(value) },
})

/* The marker's own node. `null` until something writes it, which is how this
   file tells "the render kept it true" apart from "the template said it once
   and walked away". */
const context = node()
Object.defineProperty(context, 'innerHTML', {
  get: () => contextPainted ?? '',
  set: value => { contextPainted = String(value) },
})

const footer = node()
const rail = node()
rail.addEventListener = (type, handler) => { if (type === 'click') railHandlers.push(handler) }

const searchInput = node()
searchInput.addEventListener = (type, handler) => { if (type === 'input') searchHandlers.push(handler) }

const root = node()
root.querySelector = selector => {
  if (selector === '.settings-sections') return sections
  if (selector === '.settings-main-context') return context
  if (selector === '.settings-rail') return rail
  if (selector === '.settings-footer') return footer
  if (selector === '.settings-search input') return searchInput
  return node()
}

globalThis.document = {
  createElement: () => ({
    set innerHTML(value) {
      if (String(value).includes('class="view-pad settings-page"')) mounted = String(value)
    },
    content: { firstElementChild: root },
  }),
  documentElement: node(), body: node(), getElementById: () => null,
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

const { SETTINGS_GROUPS, CATEGORY_DETAILS, categorySlug, groupOfSection } = await import('../../src/settings-presentation.js')
const { settingsView } = await import('../../src/views/settings.js')

const CATEGORY_COUNT = SETTINGS_GROUPS.reduce((total, group) => total + group.sections.length, 0)

/** The marker's `.settings-main-context` block out of the page's own template. */
function markerInTemplate() {
  const match = mounted.match(/<div class="settings-main-context"[^>]*>([\s\S]*?)<\/div>\s*<div class="settings-sections"/)
  return match ? match[1] : ''
}

/** WHAT THE MARKER SAYS RIGHT NOW, wherever the page chose to keep it: the node
    it has painted, or -- while nothing has painted it -- the template's copy. */
function marker() {
  return contextPainted ?? markerInTemplate()
}

/** Everything the marker says, with tags and entities out of the way. */
function markerText() {
  return marker()
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Mount the page at one address and hand back the view, already painted. */
function open({ category = null } = {}) {
  painted = ''
  contextPainted = null
  mounted = ''
  railHandlers = []
  searchHandlers = []
  searchInput.value = ''
  const query = new URLSearchParams()
  if (category !== null) query.set('category', category)
  globalThis.location.hash = query.toString() ? `#/settings?${query}` : '#/settings'
  return settingsView({ query, navigate: () => {} })
}

/** Type into the page's search box, the way the page itself is told about it. */
function type(text) {
  assert.equal(searchHandlers.length, 1, 'the search box bound no input handler')
  searchInput.value = text
  searchHandlers[0]()
}

/* ---------- 1. the marker names the page you are on ---------- */

test('the marker names the category on screen and the group it sits in', () => {
  const view = open({ category: categorySlug('Ledger') })
  const group = groupOfSection('Rules & approvals')
  const text = markerText()
  assert.ok(text.includes(group.label),
    `the marker does not name the group: ${JSON.stringify(text)}`)
  assert.ok(text.includes('Rules & approvals'),
    `the marker never names the category the page is showing: ${JSON.stringify(text)}`)
  assert.ok(text.includes(CATEGORY_DETAILS['Rules & approvals']),
    `the marker does not explain this category: ${JSON.stringify(text)}`)
  view.destroy()
})

test('the last step of the breadcrumb says it is the page you are on', () => {
  const view = open({ category: categorySlug('Ledger') })
  assert.match(marker(), /aria-current="page"[^>]*>Rules &amp; approvals</,
    'the step naming the category on screen is not marked as the current page')
  view.destroy()
})

/* ---------- 2. the marker moves with the main column ---------- */

test('a search stops the marker claiming you are inside one group', () => {
  const view = open({ category: categorySlug('Ledger') })
  const group = groupOfSection('Rules & approvals')
  type('theme')
  assert.match(painted, /class="settings-results"/,
    'the search did not paint results, so this test is not looking at a search')
  const text = markerText()
  /* Word-boundaried so a thirteenth category does not make "13 categories" read
     as the three this group holds. */
  assert.doesNotMatch(text, new RegExp(`\\b${group.sections.length} categor`),
    `the marker still counts one group's categories over a search of all of them: ${JSON.stringify(text)}`)
  assert.ok(!text.includes('in this group'),
    `the marker still says "in this group" while the results come from every group: ${JSON.stringify(text)}`)
  assert.ok(/search/i.test(text),
    `the marker does not say the page is showing a search: ${JSON.stringify(text)}`)
  assert.ok(text.includes(String(CATEGORY_COUNT)),
    `the marker does not say the search covers all ${CATEGORY_COUNT} categories: ${JSON.stringify(text)}`)
  view.destroy()
})

test('clearing the search puts the category back into the marker', () => {
  const view = open({ category: categorySlug('Ledger') })
  type('theme')
  type('')
  const group = groupOfSection('Rules & approvals')
  const text = markerText()
  assert.ok(text.includes('Rules & approvals'), `the marker lost the category: ${JSON.stringify(text)}`)
  assert.ok(text.includes(CATEGORY_DETAILS['Rules & approvals']),
    `the marker did not put the category description back: ${JSON.stringify(text)}`)
  assert.ok(!/search/i.test(text),
    `the marker still says "search" after the box was emptied: ${JSON.stringify(text)}`)
  view.destroy()
})

/* A SEARCH IS NOT A NAVIGATION, so the rail must not start claiming a different
   page under it -- the address has not moved and the category is still the one
   the reader will be returned to. */
test('a search leaves the rail pointing at the category the address names', () => {
  const view = open({ category: categorySlug('Ledger') })
  type('theme')
  assert.ok(mounted.includes('data-category="Rules &amp; approvals"'),
    'the rail lost the category button while a search was showing')
  view.destroy()
})

/* ---------- 3. the breadcrumb is addressable ---------- */

test('the breadcrumb carries its name on an element that can hold one', () => {
  const view = open({ category: categorySlug('Ledger') })
  assert.match(marker(), /<nav[^>]*class="settings-breadcrumb"[^>]*aria-label="[^"]+"/,
    'the breadcrumb is not a named landmark, so an assistive technology cannot announce it')
  view.destroy()
})

test('no name is hung on the role-less wrapper, where ARIA drops it', () => {
  const view = open({ category: categorySlug('Ledger') })
  const wrapper = mounted.match(/<div class="settings-main-context"[^>]*>/)?.[0] ?? ''
  assert.ok(wrapper, 'the marker has no wrapper in the page template')
  assert.ok(!wrapper.includes('aria-label'),
    `an aria-label on a generic div is discarded: ${wrapper}`)
  view.destroy()
})
