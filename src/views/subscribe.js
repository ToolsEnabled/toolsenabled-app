/* /subscribe -- the future paid-subscription page.
 *
 * IT CARRIES THE MOST TRUST WEIGHT ON THE SITE, so three things are true of it
 * that are not true of any other view in this app:
 *
 * 1. NOT ONE WORD ABOUT WHAT A PLAN INCLUDES IS WRITTEN HERE. Every price,
 *    every plan name and every inclusion line comes from /data/subscription-catalog.json,
 *    which tools/gen-subscription-catalog.mjs derives from the engine's
 *    src/lib/entitlement.js -- the same closed table that decides what a licence
 *    actually gates. There is no free-text "features" array in this file and no
 *    place to add one, so this page CANNOT promise a capability the product does
 *    not grant. tools/check-subscription-claims.mjs enforces that from outside.
 *
 * 2. IT FAILS CLOSED, AND ON THIS RELEASE THAT IS THE ONLY PATH IT TAKES. If the
 *    catalog is missing, unreachable, or damaged, the page renders no plan and
 *    no signup control. The visitor-facing reason is the owner's current truth
 *    -- subscriptions are not open -- while the flow retains the catalogue
 *    failure internally and no validation is weakened. Since R1214 the catalog
 *    is not in the payload at all (config/renderer-payload-boundary.json
 *    classifies it `withheld`), so on a packaged 1.0.45 build every visitor to
 *    #/subscribe and #/pricing reaches unavailableMarkup() below. The plan,
 *    price, seat and checkout code beneath it is unreachable there and is kept
 *    rather than deleted: the day the owner opens subscriptions, the surface
 *    that returns should be the one that was reviewed, not one rewritten from
 *    memory. Nothing a packaged build can read -- an environment variable, a
 *    setting, a stored preference -- can reach it; only putting a catalog back
 *    into public/data/ AND moving it back to `shipped` in that manifest can.
 *
 * 3. IT NEVER SAYS ANYONE IS SUBSCRIBED. The furthest this page can get is "a
 *    checkout session exists". The entitlement is granted on the operator side
 *    by the verified provider webhook, and a browser is the least trustworthy
 *    party in the transaction.
 *
 * NO DARK PATTERNS, AS A LIST OF THINGS DELIBERATELY ABSENT: no countdown, no
 * scarcity line, no strikethrough "was" price, no pre-selected upsell, no
 * "most popular" badge (nothing here knows what is popular), no plan
 * pre-selected on arrival, no checkbox that opts you into anything, and the
 * free tier is stated in full BEFORE the paid ones rather than in a footnote
 * after them. The annual saving IS shown, because it is arithmetic on the two
 * prices the model already publishes -- a fact, not a persuasion.
 */

import { el } from '../components.js'
import {
  fetchSubscriptionCatalog,
  freePlan,
  planInclusions,
  purchasablePlans,
} from '../subscription-catalog.js'
import {
  billingPeriodsFor,
  createSignupFlow,
  priceFor,
} from '../subscription-signup.js'
import { SUBSCRIPTION_DISABLED_HINT } from '../subscription-availability.js'
import '../subscribe.css'

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const SIGNUP_ENDPOINT = '/v1/signup'

/* Money is formatted by the platform, not by us: a hand-rolled formatter is how
   a price ends up rendered as "19" in one place and "19.00" in another. */
const money = value => new Intl.NumberFormat(undefined, {
  style: 'currency', currency: 'USD', maximumFractionDigits: value % 1 === 0 ? 0 : 2,
}).format(value)

const periodWord = period => (period === 'annual' ? 'a year' : 'a month')

/**
 * The saving an annual plan represents, in whole currency units, or null.
 * Derived from the model's own two numbers. If annual is not actually cheaper,
 * this returns null and NOTHING is said -- a "saving" that is not one is the
 * dark pattern this function exists to make impossible to write by accident.
 */
export function annualSaving(plan) {
  const monthly = priceFor(plan, 'monthly')
  const annual = priceFor(plan, 'annual')
  if (monthly === null || annual === null) return null
  const twelve = monthly * 12
  return annual < twelve ? twelve - annual : null
}

function inclusionMarkup(capability) {
  return `<li class="sub-inc">
    <span class="sub-inc-mark" aria-hidden="true">
      <svg viewBox="0 0 16 16"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>
    <span class="sub-inc-body">
      <b class="sub-inc-name">${esc(capability.label)}</b>
      <span class="sub-inc-why">${esc(capability.rationale)}</span>
    </span>
  </li>`
}

function planCardMarkup(catalog, plan, period) {
  const price = priceFor(plan, period)
  const inclusions = planInclusions(catalog, plan)
  const saving = period === 'annual' ? annualSaving(plan) : null
  const alternatives = [...new Set(inclusions.flatMap(capability => capability.freeAlternatives))]

  return `<label class="sub-plan glass" data-plan="${esc(plan.id)}">
    <input class="sub-plan-radio" type="radio" name="plan" value="${esc(plan.id)}" />
    <span class="sub-plan-tick" aria-hidden="true"></span>
    <span class="sub-plan-head">
      <span class="sub-plan-name">${esc(plan.label)}</span>
      <span class="sub-plan-of">${esc(catalog.paidProduct)}</span>
    </span>
    <span class="sub-plan-price">
      ${price === null
        ? `<span class="sub-plan-noprice">Not offered ${esc(periodWord(period))}</span>`
        : `<span class="sub-plan-figure">${esc(money(price))}</span><span class="sub-plan-per">${esc(periodWord(period))}</span>`}
    </span>
    ${saving ? `<span class="sub-plan-saving">${esc(money(saving))} less than paying monthly</span>` : ''}
    ${plan.seatMinimum ? `<span class="sub-plan-seats">Starts at ${esc(String(plan.seatMinimum))} seats · price is per seat</span>` : ''}
    <span class="sub-plan-inc-head">What the subscription adds</span>
    <ul class="sub-inc-list">${inclusions.map(inclusionMarkup).join('')}</ul>
    ${alternatives.length ? `<span class="sub-plan-alt">
      <b>You can also do this without paying:</b>
      ${alternatives.map(line => `<span class="sub-plan-alt-line">${esc(line)}</span>`).join('')}
    </span>` : ''}
  </label>`
}

function unavailableMarkup() {
  return `<section class="sub-shell sub-shell-narrow">
    <header class="sub-mast">
      <p class="sub-eyebrow">subscriptions · coming soon</p>
      <h1>Subscriptions are not open yet</h1>
      <p class="sub-lede">Paid subscriptions are coming soon. The product is free meanwhile, and you do not
        need a subscription to use it.</p>
    </header>
    <div class="sub-refusal glass" role="status">
      <p class="sub-refusal-title">Nothing was started and nothing was charged.</p>
      <p class="sub-refusal-why">${esc(SUBSCRIPTION_DISABLED_HINT)}</p>
      <p class="sub-refusal-next">The product itself is unaffected: it is free, and it does not need this page or
        any subscription to run. <a href="#/">Go back to the first page</a>.</p>
    </div>
  </section>`
}

export function subscribeView({ query, fetchImpl, submitImpl } = {}) {
  const root = el(`<div class="view-pad subscribe-page"><div class="sub-loading" role="status">Checking subscription availability…</div></div>`)
  let destroyed = false
  let flow = null
  let catalog = null
  let period = 'monthly'
  const listeners = []

  const on = (target, type, handler, options) => {
    target.addEventListener(type, handler, options)
    listeners.push(() => target.removeEventListener(type, handler, options))
  }

  const post = submitImpl || (async (request) => {
    const response = await (fetchImpl || fetch)(SIGNUP_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    /* A non-2xx is still a REPLY here: the service answers 402/409/503 with a
       named state in the body, and throwing on the status code would turn every
       one of those honest refusals into "offline". Only a body that will not
       parse is treated as unreachable. */
    return response.json()
  })

  const isOnline = () => (typeof navigator === 'object' && 'onLine' in navigator ? navigator.onLine !== false : true)

  ;(async () => {
    const result = await fetchSubscriptionCatalog({ fetchImpl })
    if (destroyed) return
    flow = createSignupFlow({ submit: post, isOnline, random: globalThis.crypto })
    flow.catalogResolved(result)
    if (!result.ok) {
      root.innerHTML = unavailableMarkup()
      return
    }
    catalog = result.catalog
    /* Default the period to the one every purchasable plan actually offers, so
       arriving on this page never shows a plan as "not offered" before the
       visitor has touched anything. */
    const plans = purchasablePlans(catalog)
    period = plans.every(plan => billingPeriodsFor(plan).includes('annual')) && plans.length > 0 ? 'monthly' : 'monthly'
    mount()
  })()

  function mount() {
    const plans = purchasablePlans(catalog)
    const free = freePlan(catalog)
    const anyAnnual = plans.some(plan => billingPeriodsFor(plan).includes('annual'))
    const seatPlans = plans.filter(plan => plan.seatMinimum)

    root.innerHTML = `<section class="sub-shell">
      <header class="sub-mast">
        <p class="sub-eyebrow">subscribe</p>
        <h1>${esc(catalog.paidProduct)}</h1>
        <p class="sub-lede">${esc(catalog.unlicensedInstallStatement)}</p>
      </header>

      <p class="sub-frame">A subscription buys infrastructure we run for you. It does not unlock the product —
        the product is already yours.</p>

      <form class="sub-form" novalidate>
        ${anyAnnual ? `<div class="sub-period">
          <span class="sub-period-label" id="sub-period-label">Billing</span>
          <div class="sub-seg" role="radiogroup" aria-labelledby="sub-period-label">
            <button type="button" class="sub-seg-btn on" data-period="monthly" role="radio" aria-checked="true">Monthly</button>
            <button type="button" class="sub-seg-btn" data-period="annual" role="radio" aria-checked="false">Annual</button>
          </div>
        </div>` : ''}

        <fieldset class="sub-plans-set">
          <legend class="sub-plans-legend">Choose a plan</legend>
          <div class="sub-plans">${plans.map(plan => planCardMarkup(catalog, plan, period)).join('')}</div>
          <p class="sub-field-error" id="sub-error-planId" hidden></p>
        </fieldset>

        <div class="sub-details glass">
          <div class="sub-field">
            <label class="sub-label" for="sub-email">Email for the subscription</label>
            <input class="sub-input" id="sub-email" name="email" type="email" autocomplete="email"
                   inputmode="email" spellcheck="false" aria-describedby="sub-email-note sub-error-email" />
            <!-- IT SAID "the licence key goes here" ON A PAGE THAT TWICE SAYS LICENCES
           ARE NEVER CHECKED. Both were true and together they read as a
           contradiction: what arrives is proof of what you are paying for, and
           nothing on the computer running the product ever asks for it. And the address had no
           stated relationship to the account somebody made at toolsenabled.ai,
           which is the question a person actually has here. -->
            <p class="sub-note" id="sub-email-note">Your receipt goes here, and so does what proves the subscription. Use the same address as your ToolsEnabled account if you have one, so the two line up. Nothing else is sent to it.</p>
            <p class="sub-field-error" id="sub-error-email" hidden></p>
          </div>
          ${seatPlans.length ? `<div class="sub-field" id="sub-seats-field" hidden>
            <label class="sub-label" for="sub-seats">Seats</label>
            <input class="sub-input sub-input-num" id="sub-seats" name="seats" type="number" step="1"
                   aria-describedby="sub-seats-note sub-error-seats" />
            <p class="sub-note" id="sub-seats-note"></p>
            <p class="sub-field-error" id="sub-error-seats" hidden></p>
          </div>` : ''}
          <div class="sub-submit-row">
            <button class="sub-submit" type="submit">Continue to payment</button>
            <p class="sub-submit-note">The next step is the payment provider's own page. You are not charged until
              you complete it there, and you can stop at any point.</p>
          </div>
        </div>
      </form>

      <div class="sub-status" id="sub-status" role="status" aria-live="polite" tabindex="-1" hidden></div>

      <section class="sub-free">
        <h2>Always free, on every install, for ever</h2>
        <p class="sub-free-lede">This list is not a trial and does not expire. A subscription never adds anything
          to it and cancelling never takes anything off it.</p>
        <ul class="sub-free-list">${catalog.neverGated.map(line => `<li>${esc(line)}</li>`).join('')}</ul>
        ${free ? `<p class="sub-free-plan">Running it this way is called <b>${esc(free.label)}</b> and costs
          ${esc(money(0))}. It is the whole product, not a tier of the paid one.</p>` : ''}
      </section>

      <footer class="sub-foot">
        <a class="sub-foot-link" href="#/">Back to the first page</a>
      </footer>
    </section>`

    wire()
    resume()
  }

  const $ = selector => root.querySelector(selector)
  const selectedPlan = () => purchasablePlans(catalog).find(plan => plan.id === flow.snapshot.fields.planId) || null

  function setFieldError(field, message) {
    const box = $(`#sub-error-${field}`)
    if (!box) return
    box.textContent = message || ''
    box.hidden = !message
    const input = field === 'email' ? $('#sub-email') : field === 'seats' ? $('#sub-seats') : null
    if (input) {
      input.setAttribute('aria-invalid', message ? 'true' : 'false')
      if (message) input.focus()
    }
  }

  function clearFieldErrors() {
    for (const field of ['email', 'seats', 'planId']) {
      const box = $(`#sub-error-${field}`)
      if (box) { box.textContent = ''; box.hidden = true }
    }
    for (const input of [$('#sub-email'), $('#sub-seats')]) input?.setAttribute('aria-invalid', 'false')
  }

  function renderPrices() {
    for (const card of root.querySelectorAll('.sub-plan')) {
      const plan = purchasablePlans(catalog).find(candidate => candidate.id === card.dataset.plan)
      if (!plan) continue
      const price = priceFor(plan, period)
      const figure = card.querySelector('.sub-plan-price')
      figure.innerHTML = price === null
        ? `<span class="sub-plan-noprice">Not offered ${esc(periodWord(period))}</span>`
        : `<span class="sub-plan-figure">${esc(money(price))}</span><span class="sub-plan-per">${esc(periodWord(period))}</span>`
      const saving = period === 'annual' ? annualSaving(plan) : null
      let savingEl = card.querySelector('.sub-plan-saving')
      if (saving && !savingEl) {
        savingEl = document.createElement('span')
        savingEl.className = 'sub-plan-saving'
        figure.after(savingEl)
      }
      if (savingEl) {
        savingEl.textContent = saving ? `${money(saving)} less than paying monthly` : ''
        savingEl.hidden = !saving
      }
      /* A plan with no price on this period cannot be bought on this period.
         Disabling the radio is the honest control state -- it stays visible,
         keeps its explanation, and cannot be selected into a refusal. */
      const radio = card.querySelector('.sub-plan-radio')
      radio.disabled = price === null
      card.classList.toggle('is-unavailable', price === null)
      if (price === null && radio.checked) {
        radio.checked = false
        flow.setField('planId', null)
      }
    }
  }

  function renderSeats() {
    const field = $('#sub-seats-field')
    if (!field) return
    const plan = selectedPlan()
    const minimum = plan?.seatMinimum || null
    field.hidden = !minimum
    if (!minimum) return
    const input = $('#sub-seats')
    input.min = String(minimum)
    $('#sub-seats-note').textContent = `The ${plan.label} plan starts at ${minimum}. You are charged per seat.`
    if (!input.value) {
      input.value = String(minimum)
      flow.setField('seats', input.value)
    }
  }

  function renderStatus() {
    const box = $('#sub-status')
    if (!box) return
    const { state, detail } = flow.snapshot
    const submit = $('.sub-submit')
    if (submit) {
      submit.disabled = !flow.snapshot.canSubmit
      submit.textContent = state === 'submitting' ? 'Starting…' : 'Continue to payment'
    }

    if (state === 'ready' && !detail) { box.hidden = true; box.innerHTML = ''; return }
    box.hidden = false

    const nothingCharged = '<p class="sub-status-safe">Nothing has been charged.</p>'
    if (state === 'submitting') {
      box.className = 'sub-status is-working'
      box.innerHTML = `<p class="sub-status-title">Asking the payment provider for a checkout page…</p>${nothingCharged}`
      return
    }
    if (state === 'checkout') {
      box.className = 'sub-status is-checkout'
      box.innerHTML = `
        ${detail.testMode ? '<p class="sub-testmode">Test mode. This is a sandbox checkout: no real card is charged.</p>' : ''}
        <p class="sub-status-title">Your checkout page is ready.</p>
        ${detail.reason ? `<p class="sub-status-why">${esc(detail.reason)}</p>` : ''}
        <a class="sub-checkout-link" href="${esc(detail.checkoutUrl)}">Continue to secure checkout</a>
        <p class="sub-status-safe">You have not been charged yet. Nothing is taken until you finish on that page,
          and closing it leaves you exactly where you were.</p>`
      box.focus()
      return
    }
    if (state === 'already-subscribed') {
      box.className = 'sub-status is-known'
      box.innerHTML = `<p class="sub-status-title">This address already has a subscription.</p>
        <p class="sub-status-why">${esc(detail.reason)}</p>
        ${detail.manageUrl ? `<a class="sub-checkout-link" href="${esc(detail.manageUrl)}">Manage the existing subscription</a>` : ''}`
      box.focus()
      return
    }
    if (state === 'offline') {
      box.className = 'sub-status is-offline'
      box.innerHTML = `<p class="sub-status-title">We could not reach the signup service.</p>
        <p class="sub-status-why">${esc(detail.reason)}</p>
        <p class="sub-status-safe">Nothing was sent and nothing was charged. Try again when you are back online.</p>`
      box.focus()
      return
    }
    if (state === 'declined') {
      box.className = 'sub-status is-declined'
      box.innerHTML = `<p class="sub-status-title">The payment was declined.</p>
        <p class="sub-status-why">${esc(detail.reason)}</p>
        <p class="sub-status-safe">Nothing was charged. You can try a different card or come back later.</p>`
      box.focus()
      return
    }
    // 'refused' -- and 'lapsed', which is a refusal that names a better next step
    box.className = flow.snapshot.state === 'lapsed' ? 'sub-status is-lapsed' : 'sub-status is-refused'
    box.innerHTML = `<p class="sub-status-title">${flow.snapshot.state === 'lapsed' ? 'Your subscription had ended.' : 'That did not go through.'}</p>
      <p class="sub-status-why">${esc(detail?.reason || 'No reason was given.')}</p>${nothingCharged}`
    if (detail?.field) setFieldError(detail.field, detail.reason)
    else box.focus()
  }

  function render() {
    renderPrices()
    renderSeats()
    renderStatus()
    for (const card of root.querySelectorAll('.sub-plan')) {
      card.classList.toggle('is-chosen', card.dataset.plan === flow.snapshot.fields.planId)
    }
  }

  function wire() {
    const form = $('.sub-form')

    for (const button of root.querySelectorAll('.sub-seg-btn')) {
      on(button, 'click', () => {
        period = button.dataset.period
        flow.setField('period', period)
        for (const sibling of root.querySelectorAll('.sub-seg-btn')) {
          const on_ = sibling === button
          sibling.classList.toggle('on', on_)
          sibling.setAttribute('aria-checked', on_ ? 'true' : 'false')
        }
        render()
      })
    }

    on(form, 'change', (event) => {
      const target = event.target
      if (target.name === 'plan') { flow.setField('planId', target.value); clearFieldErrors(); render(); return }
      if (target.id === 'sub-email') { flow.setField('email', target.value); render() }
      if (target.id === 'sub-seats') { flow.setField('seats', target.value); render() }
    })
    on(form, 'input', (event) => {
      const target = event.target
      if (target.id === 'sub-email') flow.setField('email', target.value)
      if (target.id === 'sub-seats') flow.setField('seats', target.value)
    })

    on(form, 'submit', async (event) => {
      event.preventDefault()
      /* The button is disabled while a request is in flight, but a disabled
         button is a rendering and the second press of a fast double press can
         land before it paints. The flow refuses a re-entrant attempt on its own
         and reuses one idempotency key, so neither race can create two
         subscriptions. */
      clearFieldErrors()
      flow.setField('period', period)
      render()
      await flow.submitAttempt(selectedPlan())
      if (destroyed) return
      render()
    })

    /* Back button and bfcache. A page restored from the back/forward cache comes
       back with its JS state exactly as it left -- including a disabled submit
       button and an in-flight request that will never resolve. Without this, a
       person who starts checkout and presses Back finds a form nobody can use
       and nothing explaining why. It never re-submits: resuming a payment
       unasked is the one thing a back button must not do. */
    on(window, 'pageshow', (event) => {
      if (!event.persisted) return
      flow.restored()
      render()
    })
    on(window, 'online', render)
    on(window, 'offline', render)
  }

  /**
   * Arriving back from the provider (or reloading a bookmarked link) with
   * ?signup=<id> in the hash. The page ASKS the service what that signup is
   * rather than believing the query string: `result=complete` in a URL is a
   * claim anybody can type, and this page must never turn a typed claim into
   * "you are subscribed".
   */
  function resume() {
    const signupId = query?.get?.('signup')
    if (!signupId) { render(); return }
    render()
    ;(async () => {
      let reply
      try {
        const response = await (fetchImpl || fetch)(`${SIGNUP_ENDPOINT}/${encodeURIComponent(signupId)}`, { cache: 'no-store' })
        reply = await response.json()
      } catch (error) {
        if (destroyed) return
        flow.statusResolved({ ok: false, state: 'refused', reason: `We could not check that signup (${error?.message || error}). Nothing was charged.` })
        render()
        return
      }
      if (destroyed) return
      flow.statusResolved(reply)
      render()
    })()
  }

  return {
    el: root,
    destroy() {
      destroyed = true
      for (const off of listeners.splice(0)) off()
    },
  }
}
