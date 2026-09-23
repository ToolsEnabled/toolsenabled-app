/* The subscription view is tested through the DOM it gives a reader.  In
 * particular, do not replace these drives with source-text assertions: CSS is
 * made inert by the same loader used by the other view tests in this folder. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setImmediate as defer } from 'node:timers/promises'
import test from 'node:test'

import { SUBSCRIPTION_DISABLED_HINT } from '../../src/subscription-availability.js'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const domStandIn = await import(process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : './lib/dom-stand-in.mjs')
/* The catalog is read from config/, not from public/, and that is load-bearing
 * rather than tidy: R1214 took the price list OUT of the renderer payload, so a
 * fixture read from public/data/ would be reading the file whose absence this
 * suite now asserts. It is still the real generated catalog -- a hand-written
 * fixture would let the view drift from the shape the generator emits. */
const catalog = JSON.parse(await readFile(new URL('../../config/subscription-catalog.json', import.meta.url), 'utf8'))
const annualUnavailablePlan = catalog.plans.find(plan => plan.requiresLicense
  && plan.monthlyUsd !== null && plan.annualUsd === null)

assert.ok(annualUnavailablePlan, 'the generated catalog must retain a paid plan with monthly but no annual pricing')

class WindowTarget {
  constructor(installedWindow) {
    this.listeners = new Map()
    this.matchMedia = installedWindow.matchMedia.bind(installedWindow)
  }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]) }
  removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== handler)) }
  dispatchEvent(event) {
    for (const handler of this.listeners.get(event.type) || []) handler.call(this, event)
    return !event.defaultPrevented
  }
}

async function settle() {
  for (let count = 0; count < 12; count += 1) await Promise.resolve()
  await defer()
}

async function mount(options = {}) {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const installed = domStandIn.installDomStandIn(globalThis)
  globalThis.window = new WindowTarget(globalThis.window)
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: { onLine: true },
  })
  let view
  try {
    const { subscribeView } = await import('../../src/views/subscribe.js')
    view = subscribeView(options)
    installed.document.body.appendChild(view.el)
    await settle()
    return {
      view,
      restore() {
        try { view.destroy() } finally {
          if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
          else delete globalThis.navigator
          installed.restore()
        }
      },
    }
  } catch (error) {
    try { view?.destroy() } finally {
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
      else delete globalThis.navigator
      installed.restore()
    }
    throw error
  }
}

const catalogReply = async () => ({ ok: true, status: 200, json: async () => structuredClone(catalog) })

test('shared element events preserve identity, bubble, and report cancellation', () => {
  const installed = domStandIn.installDomStandIn(globalThis)
  try {
    const parent = installed.document.createElement('div')
    const child = installed.document.createElement('button')
    parent.appendChild(child)
    const deliveries = []
    child.addEventListener('neutral', function (event) {
      deliveries.push({ receiver: this, target: event.target })
      event.preventDefault()
    })
    parent.addEventListener('neutral', function (event) {
      deliveries.push({ receiver: this, target: event.target })
    })
    const event = { type: 'neutral', bubbles: true, cancelable: true, defaultPrevented: false }
    assert.equal(child.dispatchEvent(event), false, 'a canceled event must not report successful delivery')
    assert.deepEqual(deliveries, [
      { receiver: child, target: child },
      { receiver: parent, target: child },
    ], 'delivery must bind each current target while retaining the original target')
  } finally { installed.restore() }
})

test('a plan control is enabled only for a priced period, with its visible reason retained', async () => {
  const mounted = await mount({ fetchImpl: catalogReply })
  try {
    const card = mounted.view.el.querySelectorAll('.sub-plan')
      .find(candidate => candidate.dataset.plan === annualUnavailablePlan.id)
    assert.ok(card, 'data-plan reflection must locate the catalog-derived paid plan card')
    const radio = card.querySelector('.sub-plan-radio')
    assert.equal(radio.value, annualUnavailablePlan.id, 'the selected control must belong to the derived plan')
    assert.equal(radio.disabled, false, 'a monthly-priced plan control must begin enabled')

    const annual = mounted.view.el.querySelectorAll('.sub-seg-btn')
      .find(button => button.dataset.period === 'annual')
    assert.ok(annual, 'the other catalog plan must make the annual control reachable')
    annual.dispatchEvent({ type: 'click' })

    assert.equal(radio.disabled, true, 'a plan without an annual price must become disabled')
    assert.equal(card.querySelector('.sub-plan-noprice')?.hidden, false,
      'the unavailable-period reason must remain visible')
  } finally { mounted.restore() }
})

test('an unreadable catalog reaches the reader as an unavailable empty state without signup controls', async () => {
  const mounted = await mount({ fetchImpl: async () => { throw new Error(SUBSCRIPTION_DISABLED_HINT) } })
  try {
    assert.equal(mounted.view.el.querySelector('.sub-form'), null,
      'a catalog failure must render no signup form rather than a partial offer')
    const status = mounted.view.el.querySelector('[role="status"]') || mounted.view.el.querySelector('.sub-refusal')
    assert.equal(status?.getAttribute('role'), 'status', 'the unavailable explanation must be exposed as a reader status')
    assert.equal(status.textContent.includes(SUBSCRIPTION_DISABLED_HINT), true,
      'the unavailable status must contain the availability owner\'s refusal copy')
  } finally { mounted.restore() }
})

test('a failed signup-status read stays uncertain and never becomes a definite subscription answer', async () => {
  const fetchImpl = async url => {
    if (url === '/data/subscription-catalog.json') return catalogReply()
    throw new Error(SUBSCRIPTION_DISABLED_HINT)
  }
  const mounted = await mount({ query: new URLSearchParams('signup=fixture-1'), fetchImpl })
  try {
    const status = mounted.view.el.querySelector('#sub-status')
    assert.ok(status, 'the status id must resolve to the status element')
    assert.equal(status.hidden, false, 'a failed status read must leave a visible result for the reader')
    assert.equal(status.classList.contains('is-refused'), true,
      'an unreadable status must remain the uncertain refusal state')
    assert.equal(status.textContent.includes(SUBSCRIPTION_DISABLED_HINT), true,
      'the rendered failure must retain its source-owned reason')
    assert.equal(status.classList.contains('is-known') || status.classList.contains('is-checkout'), false,
      'an unreadable status must not become a definite subscription or checkout result')
    assert.equal(installedFocus(status), true, 'the uncertain status must receive focus')
  } finally { mounted.restore() }
})

function installedFocus(status) {
  return status.ownerDocument.activeElement === status
}

/* THE STATE THE SHIPPED APP IS ACTUALLY IN.
 *
 * R1214: the price catalog left the renderer payload, so on a packaged build
 * /data/subscription-catalog.json is not there and the shell answers a missing
 * /data/*.json with a 404 and a JSON body. Every other test in this file hands
 * the view a catalog; this one hands it the reply a real install gets, and
 * asserts on the ABSENCE of the four things the owner ruled out -- a price, a
 * plan, a seat minimum, and a way to pay.
 *
 * It asserts absence in the rendered text rather than on the module's branches
 * because that is what a person sees. A future change that put the price back
 * some other way -- a default catalog, a cached copy, a hardcoded fallback --
 * would leave the branch structure intact and fail here. */
const missingCatalogReply = async () => ({
  ok: false, status: 404, statusText: 'Not Found', json: async () => ({ ok: false }),
})

test('with no catalog in the payload the page offers no price, no plan, no seat minimum and no way to pay', async () => {
  const mounted = await mount({ fetchImpl: missingCatalogReply })
  try {
    const el = mounted.view.el
    assert.equal(el.querySelector('.sub-plan'), null,
      'mutation `render plans from a default catalog` survived: expected no plan card when the payload carries no catalog')
    assert.equal(el.querySelector('.sub-plan-figure'), null,
      'mutation `fall back to a built-in price` survived: expected no price figure')
    assert.equal(el.querySelector('.sub-plan-seats'), null,
      'mutation `keep the seat line` survived: expected no seat minimum, which is the claim R1214 names as unauthorised')
    assert.equal(el.querySelector('.sub-submit'), null,
      'mutation `leave the purchase control rendered` survived: expected no control that continues to payment')
    assert.equal(el.querySelector('.sub-period'), null,
      'mutation `keep the monthly/annual switch` survived: expected no billing-period control')

    const text = el.textContent
    assert.doesNotMatch(text, /\$\d/,
      'mutation `print a currency figure anyway` survived: expected no money on the launch surface')
    assert.doesNotMatch(text, /per seat|seats/i,
      'mutation `keep seat wording` survived: expected nothing about seats')
    assert.equal(text.includes(SUBSCRIPTION_DISABLED_HINT), true,
      'mutation `render an empty page instead of an answer` survived: expected the reader to be told why, in the availability owner\'s words')
  } finally { mounted.restore() }
})
