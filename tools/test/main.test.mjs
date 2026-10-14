/* The application entry point, exercised as a browser would exercise it.
 * CSS and fonts are the only parts Node cannot execute. All browser globals
 * are installed before the entry point is dynamically imported. */

import assert from 'node:assert/strict'
import path from 'node:path'
import { register } from 'node:module'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'

register('./helpers/css-stub-loader.mjs', import.meta.url)
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@fontsource-variable/')) {
      return { url: 'data:text/javascript,export default {}', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
`)}`, import.meta.url)

const domModuleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn, Element, ClassList } = await import(domModuleUrl)
const { document, restore } = installDomStandIn(globalThis)

const localNames = [
  'HTMLElement', 'location', 'history', 'localStorage', 'CustomEvent', 'performance',
  'navigator', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
]
const priorGlobals = new Map(localNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
const setGlobal = (name, value) => Object.defineProperty(globalThis, name, {
  configurable: true, enumerable: true, writable: true, value,
})

setGlobal('HTMLElement', Element)
const priorInert = Object.getOwnPropertyDescriptor(Element.prototype, 'inert')
Object.defineProperty(Element.prototype, 'inert', { configurable: true, writable: true, value: false })

const make = (tag, attributes = {}) => {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
  return node
}
const header = make('header', { class: 'topbar' })
const stage = make('main')
const drawer = make('aside', { class: 'settings-drawer' })
const drawerBody = make('div', { class: 'drawer-body' })
const allSettings = make('a', { class: 'drawer-all', href: '' })
const gear = make('button')
const close = make('button')
const back = make('button')
const next = make('button')
const routeStatus = make('div', { role: 'status', 'aria-live': 'polite' })
header.append(back, next, gear)
drawer.append(close, drawerBody, allSettings)
document.body.append(header, stage, drawer, routeStatus)
document.activeElement = document.body
document.title = ''
document.visibilityState = 'hidden'

const ids = new Map([
  ['stage', stage], ['drawer', drawer], ['open-settings', gear],
  ['close-settings', close], ['nav-back', back], ['nav-next', next],
  ['route-status', routeStatus],
])
const documentListeners = new Map()
document.getElementById = id => ids.get(id) || null
document.querySelector = selector => document.body.querySelector(selector)
document.querySelectorAll = selector => document.body.querySelectorAll(selector)
document.addEventListener = (type, listener) => documentListeners.set(type, [...(documentListeners.get(type) || []), listener])
document.removeEventListener = (type, listener) => documentListeners.set(type, (documentListeners.get(type) || []).filter(item => item !== listener))
document.hasFocus = () => true

const windowListeners = new Map()
const location = { hash: '#/subscribe', search: '', hostname: '127.0.0.1' }
const fixtureState = { damaged: String(0), file: path.join(String(0), String(0)) }
const storedValues = new Map()
const window = globalThis.window
window.location = location
window.addEventListener = (type, listener) => windowListeners.set(type, [...(windowListeners.get(type) || []), listener])
window.removeEventListener = (type, listener) => windowListeners.set(type, (windowListeners.get(type) || []).filter(item => item !== listener))
window.dispatchEvent = event => { for (const listener of [...(windowListeners.get(event.type) || [])]) listener.call(window, event); return true }
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
window.mcPrefsNotice = { read: () => fixtureState, subscribe: () => () => {} }
setGlobal('location', location)
setGlobal('history', { replaceState(_state, _unused, url) { location.hash = String(url) } })
setGlobal('localStorage', {
  getItem: key => storedValues.has(key) ? storedValues.get(key) : null,
  setItem: (key, value) => storedValues.set(key, String(value)),
  removeItem: key => storedValues.delete(key),
})
setGlobal('CustomEvent', class { constructor(type, init = {}) { this.type = type; this.detail = init.detail } })
setGlobal('performance', { now: () => 0 })
setGlobal('navigator', { userAgent: '', language: '', platform: '' })
setGlobal('fetch', async () => ({ ok: false, status: 0, json: async () => ({}) }))
setGlobal('setInterval', () => 1)
setGlobal('clearInterval', () => {})
setGlobal('setTimeout', callback => { callback(); return 1 })
setGlobal('clearTimeout', () => {})

const focusToken = Object.freeze({})
for (const node of [gear, close, allSettings]) Object.defineProperty(node, 'offsetParent', { configurable: true, value: focusToken })
Object.defineProperty(drawerBody, 'offsetParent', { configurable: true, value: null })
let retiringWithAnimationAdapter = null
/* A route change starts the view's own asynchronous load (the Ledger reads its
   register and probes the audited connection). A test that returns before that
   load has painted leaves it running into the next test, or into after() once
   the stand-in globals are restored. Each macrotask turn drains every promise
   queued before it, and this fixture's timers call back at once, so a few
   turns let the load finish inside the test that started it. */
const settle = async () => { for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve)) }
/* The T tab's load has finished: its register reached the decision form (this
   fixture has sample rows and no audited connection, so the form offers them
   in a picker) and the connection probe has answered. */
const assertTasksRegisterPainted = () => {
  const surface = stage.querySelector('.ledger-write-surface')
  assert.ok(surface, 'the Ledger must draw its audited actions')
  assert.equal(surface.dataset.registerState, 'simulated', 'the T register must reach the decision form inside this test')
  assert.equal(surface.dataset.bridgeState, 'unavailable', 'the connection probe must answer inside this test')
  assert.equal(surface.querySelector('[data-decision-form]').elements.target.tagName, 'SELECT')
}

const { settingsRecoveryNotice } = await import('../../src/settings-recovery-notice.js')
const expectedNotice = settingsRecoveryNotice(fixtureState)
await import('../../src/main.js')

after(async () => {
  // Nothing the app started may outlive the stand-in globals it runs on.
  await settle()
  for (const node of [gear, close, allSettings, drawerBody]) delete node.offsetParent
  if (retiringWithAnimationAdapter) delete retiringWithAnimationAdapter.getAnimations
  if (priorInert) Object.defineProperty(Element.prototype, 'inert', priorInert)
  else delete Element.prototype.inert
  for (const [name, descriptor] of priorGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  restore()
})

test('the settings drawer exposes both operable states', () => {
  assert.ok(drawer.classList instanceof ClassList)
  assert.equal(drawer.getAttribute('aria-hidden'), 'true', 'the closed drawer must be unavailable to assistive technology')
  assert.equal(drawer.hasAttribute('inert'), true, 'the closed drawer must be inert')
  assert.equal(gear.getAttribute('aria-expanded'), 'false', 'the gear must report the closed state')
  assert.equal(header.hasAttribute('inert'), false, 'the page must remain operable while the drawer is closed')

  gear.dispatch('click')
  assert.equal(drawer.getAttribute('aria-hidden'), 'false', 'opening must expose the drawer')
  assert.equal(drawer.hasAttribute('inert'), false, 'opening must enable the drawer')
  assert.equal(gear.getAttribute('aria-expanded'), 'true', 'the gear must report the open state')
  assert.equal(drawer.classList.contains('open'), true, 'opening must update observable class state')
  assert.equal(header.hasAttribute('inert'), true, 'opening must disable the covered header')

  close.dispatch('click')
  assert.equal(drawer.classList.contains('open'), false, 'closing must remove the observable open class')
  assert.equal(drawer.hasAttribute('inert'), true, 'closing must restore drawer inertness')
  assert.equal(header.hasAttribute('inert'), false, 'closing must restore the header')
})

test('the rendered reduce-motion checkbox changes the page and durable storage', () => {
  gear.dispatch('click')
  const motion = drawerBody.querySelector('#set-motion')
  assert.ok(motion, 'the quick-settings render did not produce the checkbox its driver presses')
  assert.equal(motion.checked, false)
  assert.equal(motion.disabled, false)

  motion.checked = true
  motion.dispatch('change')
  assert.equal(document.body.classList.contains('reduce-motion'), true,
    'the rendered checkbox change handler did not apply its checked state')
  assert.equal(storedValues.get('mc.set.reduce_motion'), 'true',
    'the app-level appearance listener did not durably store the rendered change')

  motion.checked = false
  motion.dispatch('change')
  assert.equal(document.body.classList.contains('reduce-motion'), false,
    'the rendered checkbox change handler did not apply the off state')
  assert.equal(storedValues.has('mc.set.reduce_motion'), false,
    'returning the rendered checkbox to its default did not remove the durable key')
  close.dispatch('click')
})

test('the canonical settings recovery state is mounted in the shared tree', () => {
  const notice = document.body.querySelector('[data-settings-recovery]')
  assert.ok(notice, 'the entry point must mount the settings-reader state')
  assert.equal(notice.getAttribute('role'), 'status')
  assert.equal(notice.querySelector('.settings-recovery-heading').textContent, expectedNotice.heading)
  assert.equal(notice.querySelector('.settings-recovery-body').textContent, expectedNotice.body)
  const renderedPath = notice.querySelector('.settings-recovery-path')
  assert.equal(renderedPath.querySelector('span').textContent, `${expectedNotice.pathLabel}: `)
  assert.equal(path.normalize(renderedPath.querySelector('code').textContent), path.normalize(expectedNotice.path))
})

test('retirement asks only the retiring element for subtree animations', () => {
  const retiring = stage.firstElementChild
  retiringWithAnimationAdapter = retiring
  const calls = []
  Object.defineProperty(retiring, 'getAnimations', { configurable: true, value: options => { calls.push(options); return [] } })
  location.hash = '#/settings'
  window.dispatchEvent({ type: 'hashchange' })
  assert.deepEqual(calls, [{ subtree: true }], 'retirement must inspect the retiring subtree even when it has no animations')
  assert.equal(retiring.isConnected, false, 'the inspected view must actually retire')
})

/* THE NEXT ACCOUNT MUST NOT INHERIT THE LAST ONE'S MONEY LIST.
 *
 * src/purchase-cart-changes.js remembers the previous cart reading in
 * renderer memory so the #/approvals change strip survives a view being
 * destroyed and rebuilt -- see that file's own header. Its resetCartChanges()
 * was doc-commented "used ... by a sign-out" while nothing in the app called
 * it: a sign-out never fires that function, so a second account signing in on
 * the same window inherited the first account's remembered cart snapshot, and
 * the very first reading for the new account would be diffed against the old
 * one's -- describing someone else's purchases as "no longer waiting for
 * you". DATA_SOURCE_EVENT is the one event a sign-in or sign-out on the
 * website always fires (this file's own listener, above, rebuilds the whole
 * page on it for the same reason), so this asserts the real module's
 * behaviour after that real event fires on the app's real window, not a
 * pattern match against the source text. */
test('a data-source change clears the previous account\'s remembered cart changes, not only the screen', async () => {
  const { DATA_SOURCE_EVENT } = await import('../../src/data-source.js')
  const { recordCartReading, resetCartChanges } = await import('../../src/purchase-cart-changes.js')
  resetCartChanges()

  const view = (id, title) => ({
    id, kind: 'purchase_batch', title, expiresAt: '2026-01-01T00:00:00.000Z',
    deadlineDate: 'Jan 1', totalCents: 100, totalText: '$1.00',
    lines: new Map([['l1', { id: 'l1', text: 'Widget', amountCents: 100, amountText: '$1.00' }]]),
  })

  const firstAccount = recordCartReading([view('p1', "The first account's request")], 1000)
  assert.equal(firstAccount.firstReading, true, 'the very first reading of this test has nothing to compare against yet')

  window.dispatchEvent({ type: DATA_SOURCE_EVENT, detail: { why: 'signed-in' } })

  const secondAccount = recordCartReading([view('p2', "The second account's request")], 2000)
  assert.equal(secondAccount.firstReading, true,
    'a data-source change must clear the remembered snapshot, so the next account starts its own first reading')
  assert.deepEqual(secondAccount.added, [],
    'the second account must never be told the first account\'s request "is no longer waiting for you"')
})

/* THE OLD APPROVALS ROUTE REDIRECTS INTO THE LEDGER'S P TAB (owner, 2026-09-07):
   approvals.js's card renderer is now mounted inside the ledger shell, so a
   visitor at the old #/approvals address must land on the ledger already
   turned to P, not on a stop the ring no longer offers. */
test('the old #/approvals address redirects into the ledger with the P tab already chosen', async () => {
  const { MODE_KEY } = await import('../../src/views/ledger.js')
  storedValues.delete(MODE_KEY)
  location.hash = '#/approvals'
  window.dispatchEvent({ type: 'hashchange' })
  assert.equal(storedValues.get(MODE_KEY), 'p', 'the redirect must choose the P tab the same way pressing it would')
  assert.ok(stage.querySelector('.ledger-page'), 'the redirect must land on the ledger view itself, not an unrouted blank')
})

test('a Ledger purchase link opens P even when another tab was last used', async () => {
  const { MODE_KEY } = await import('../../src/views/ledger.js')
  storedValues.set(MODE_KEY, 't')
  location.hash = '#/ledger?tab=p'
  window.dispatchEvent({ type: 'hashchange' })
  assert.equal(storedValues.get(MODE_KEY), 'p')
  assert.equal(document.body.dataset.route, 'ledger')
  assert.ok(stage.querySelector('.ledger-prompt-queue'))
  assert.equal(location.hash, '#/ledger')
})

test('a consumed Ledger entry link preserves a later tab choice on refresh', async () => {
  const { MODE_KEY } = await import('../../src/views/ledger.js')
  const { DATA_SOURCE_EVENT } = await import('../../src/data-source.js')
  location.hash = '#/ledger?tab=p'
  window.dispatchEvent({ type: 'hashchange' })
  assert.equal(storedValues.get(MODE_KEY), 'p')
  storedValues.set(MODE_KEY, 't')
  window.dispatchEvent({ type: DATA_SOURCE_EVENT })
  assert.equal(storedValues.get(MODE_KEY), 't')
  assert.equal(document.body.dataset.route, 'ledger')
  await settle()
  assertTasksRegisterPainted()
})

test('an unknown Ledger tab preserves the last valid choice', async () => {
  const { MODE_KEY } = await import('../../src/views/ledger.js')
  storedValues.set(MODE_KEY, 't')
  location.hash = '#/ledger?tab=unknown'
  window.dispatchEvent({ type: 'hashchange' })
  assert.equal(storedValues.get(MODE_KEY), 't')
  assert.equal(document.body.dataset.route, 'ledger')
  await settle()
  assertTasksRegisterPainted()
})

test('T1242 Messages has its customer name in the mounted heading, arrows, title and announcement', async () => {
  const visit = name => { location.hash = `#/${name}`; window.dispatchEvent({ type: 'hashchange' }) }
  visit('research')
  assert.equal(next.dataset.dest, 'Messages')
  assert.equal(next.getAttribute('aria-label'), 'Forward to Messages')
  assert.equal(next.getAttribute('title'), 'Forward to Messages')
  next.dispatch('click')
  assert.equal(location.hash, '#/comms', 'the customer label must not rename the route')
  window.dispatchEvent({ type: 'hashchange' })
  assert.equal(stage.querySelector('.comms h1').textContent, 'Messages')
  assert.equal(document.title, 'Messages · ToolsEnabled')
  assert.equal(routeStatus.textContent, 'Messages screen loaded')
  assert.equal(document.body.dataset.route, 'comms')
  visit('ledger')
  assert.equal(back.dataset.dest, 'Messages')
  assert.equal(back.getAttribute('aria-label'), 'Back to Messages')
  assert.equal(back.getAttribute('title'), 'Back to Messages')
  visit('settings')
  assert.equal(document.title, 'settings · ToolsEnabled', 'other route labels retain their existing wording')
  assert.equal(routeStatus.textContent, 'settings screen loaded')
  // The Ledger stop starts its write surface's connection check, which keeps
  // running after the page is left (T1505). Let it answer while the stand-in
  // DOM still exists, so this case leaves no work running after it ends.
  await new Promise(resolve => setImmediate(resolve))
})
