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

const operatorPlan = catalog.plans.find(plan => plan.id === 'operator')
assert.ok(operatorPlan, 'the generated catalog must retain the operator plan for mounted refusal cases')

function enterEmail(mounted, value = 'reader@example.test') {
  const input = mounted.view.el.querySelector('#sub-email')
  input.value = value
  input.dispatchEvent({ type: 'input', bubbles: true })
  return input
}

function choosePlan(mounted, id = operatorPlan.id) {
  const radio = mounted.view.el.querySelectorAll('.sub-plan-radio')
    .find(candidate => candidate.value === id)
  assert.ok(radio, `the mounted catalog must expose plan ${id}`)
  /* The stand-in deliberately does not reflect every HTML property. Give this
     event target the same reflected name a browser radio exposes before using
     its real bubbling path. */
  radio.name = radio.getAttribute('name')
  radio.checked = true
  radio.dispatchEvent({ type: 'change', bubbles: true })
  return radio
}

function submitForm(mounted) {
  return mounted.view.el.querySelector('.sub-form').dispatchEvent({
    type: 'submit', bubbles: true, cancelable: true,
  })
}

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

test('a pending signup paints an aria-live response before the inert adapter resolves', async () => {
  let release
  let calls = 0
  const waiting = new Promise(resolve => { release = resolve })
  const mounted = await mount({
    fetchImpl: catalogReply,
    submitImpl: async request => {
      calls += 1
      assert.equal(request.planId, operatorPlan.id)
      await waiting
      return { ok: false, state: 'refused', reason: 'The retained adapter refused this fixture.' }
    },
  })
  try {
    choosePlan(mounted)
    enterEmail(mounted)
    submitForm(mounted)
    await settle()

    const status = mounted.view.el.querySelector('#sub-status')
    const submit = mounted.view.el.querySelector('.sub-submit')
    assert.equal(calls, 1, 'the mounted submit path must call only the inert adapter')
    assert.equal(status.hidden, false, 'pending feedback must be visible before the adapter resolves')
    assert.equal(status.getAttribute('role'), 'status', 'pending feedback must remain a status')
    assert.equal(status.getAttribute('aria-live'), 'polite', 'pending feedback must be announced politely')
    assert.match(status.textContent, /Asking the payment provider for a checkout page/)
    assert.equal(submit.disabled, true, 'the submit control must be unavailable while the adapter is pending')

    release()
    await settle()
    assert.equal(submit.disabled, false, 'the submit control must recover after the adapter resolves')
    assert.match(status.textContent, /That did not go through/)
  } finally {
    release?.()
    mounted.restore()
  }
})

test('a plan refusal associates its error with a radio and correction clears the response', async () => {
  const mounted = await mount({ fetchImpl: catalogReply })
  try {
    enterEmail(mounted)
    submitForm(mounted)
    await settle()

    const group = mounted.view.el.querySelector('.sub-plans-set')
    const error = mounted.view.el.querySelector('#sub-error-planId')
    const radio = mounted.view.el.querySelector('.sub-plan-radio')
    assert.equal(group.getAttribute('aria-describedby'), 'sub-error-planId')
    assert.equal(error.hidden, false, 'the local plan refusal must be visible')
    assert.equal(error.textContent, 'Choose a plan.', 'the plan refusal must expose its actionable reason')
    assert.equal(radio.getAttribute('aria-invalid'), 'true', 'the focused plan control must be marked invalid')
    assert.equal(mounted.view.el.ownerDocument.activeElement, radio,
      'the plan refusal must move focus to a reachable radio, not only the disabled submit')

    choosePlan(mounted)
    assert.equal(error.hidden, true, 'choosing a plan must clear the old plan refusal')
    assert.equal(mounted.view.el.querySelector('#sub-status').hidden, true,
      'choosing a plan must clear the old status')
    assert.equal(radio.getAttribute('aria-invalid'), 'false',
      'the corrected plan control must no longer be marked invalid')
  } finally { mounted.restore() }
})

test('a period refusal is associated with its radio group and clears on period correction', async () => {
  const mounted = await mount({
    fetchImpl: catalogReply,
    submitImpl: async () => ({
      ok: false,
      state: 'refused',
      field: 'period',
      reason: 'The retained adapter refused this billing period.',
    }),
  })
  try {
    choosePlan(mounted)
    enterEmail(mounted)
    submitForm(mounted)
    await settle()

    const group = mounted.view.el.querySelector('.sub-seg')
    const error = mounted.view.el.querySelector('#sub-error-period')
    const periodButtons = mounted.view.el.querySelectorAll('.sub-seg-btn')
    const monthly = periodButtons.find(button => button.dataset.period === 'monthly')
    const annual = periodButtons.find(button => button.dataset.period === 'annual')
    assert.equal(group.getAttribute('aria-describedby'), 'sub-error-period')
    assert.equal(error.hidden, false, 'the service period refusal must be visible')
    assert.equal(error.textContent, 'The retained adapter refused this billing period.',
      'the period refusal must expose the service reason, not only an error container')
    assert.equal(monthly.getAttribute('aria-invalid'), 'true', 'the refused period control must be marked invalid')
    assert.equal(mounted.view.el.ownerDocument.activeElement, monthly,
      'the period refusal must focus a reachable period control')

    annual.dispatchEvent({ type: 'click' })
    assert.equal(error.hidden, true, 'choosing another period must clear the old period refusal')
    assert.equal(mounted.view.el.querySelector('#sub-status').hidden, true,
      'choosing another period must clear the old status')
    assert.equal(monthly.getAttribute('aria-invalid'), 'false')
    assert.equal(annual.getAttribute('aria-checked'), 'true')
  } finally { mounted.restore() }
})

test('a late inert adapter result after destroy does not repaint the retired view', async () => {
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const mounted = await mount({
    fetchImpl: catalogReply,
    submitImpl: async () => {
      await waiting
      return { ok: false, state: 'refused', reason: 'This late result must be ignored.' }
    },
  })
  try {
    choosePlan(mounted)
    enterEmail(mounted)
    submitForm(mounted)
    await settle()
    const status = mounted.view.el.querySelector('#sub-status')
    const submit = mounted.view.el.querySelector('.sub-submit')
    const beforeDestroy = {
      statusText: status.textContent,
      statusClass: status.className,
      statusHidden: status.hidden,
      submitText: submit.textContent,
      submitDisabled: submit.disabled,
      activeElement: mounted.view.el.ownerDocument.activeElement,
    }
    mounted.view.destroy()
    release()
    await settle()
    assert.equal(status.textContent, beforeDestroy.statusText,
      'a late result must not change the retired status text')
    assert.equal(status.className, beforeDestroy.statusClass,
      'a late result must not change the retired status state')
    assert.equal(status.hidden, beforeDestroy.statusHidden,
      'a late result must not change status visibility on the retired view')
    assert.equal(submit.textContent, beforeDestroy.submitText,
      'a late result must not change the retired submit label')
    assert.equal(submit.disabled, beforeDestroy.submitDisabled,
      'a late result must not change the retired submit availability')
    assert.strictEqual(mounted.view.el.ownerDocument.activeElement, beforeDestroy.activeElement,
      'a late result must not steal focus from the retired view')
  } finally {
    release?.()
    mounted.restore()
  }
})
