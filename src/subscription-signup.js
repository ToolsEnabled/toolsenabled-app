// THE SIGNUP FLOW, AS A STATE MACHINE WITH NO DOM IN IT.
//
// Every path a person can take through "I want to pay you" is a named state
// here, so that each one can be driven in a test instead of only being
// discovered by a customer: already subscribed, lapsed, declined, refused,
// offline, the back button, and the double press.
//
// TWO RULES SHAPE THE WHOLE FILE.
//
// 1. NOTHING IS GRANTED BY THIS FILE. It can reach a state where a payment has
//    been STARTED; it can never reach one where an entitlement exists. The tier
//    is granted by the verified provider webhook on the operator side
//    (src/lib/entitlement-fulfilment.js in the engine), which is a different
//    machine and a different lane. A browser saying "you are subscribed" is a
//    claim from the least trustworthy party in the transaction.
//
// 2. ABSENCE IS NEVER CONSENT. An unanswered request, an unparseable reply, a
//    reply naming a state this build does not know -- all of them land in
//    `refused` or `offline` with the reason shown. None of them lands in a state
//    where the submit button is enabled and the person believes they are done.
//
// DOUBLE SUBMIT is stopped by an idempotency key rather than only by a disabled
// button, because a disabled button is a rendering and the user's second press
// may already be in flight. The key is minted once per ATTEMPT and reused for
// every retry of that attempt, so a person who presses twice, or whose network
// retries, cannot end up with two subscriptions. Changing any field starts a
// new attempt and mints a new key -- otherwise a corrected email would be sent
// under the previous attempt's key and silently ignored by the service.

/** Every state the flow can be in. A reply naming anything else is refused. */
export const SIGNUP_STATES = Object.freeze([
  'loading',            // the plan catalog has not answered yet
  'unavailable',        // the catalog failed closed: no plans, no signup
  'ready',              // plans shown, the form can be submitted
  'submitting',         // a request is in flight; the same attempt key is in force
  'checkout',           // the provider has a session for this attempt; hand off
  'already-subscribed', // this address already pays for an active subscription
  'lapsed',             // a subscription existed and has ended; renewal offered
  'declined',           // the provider refused the payment method
  'refused',            // the service refused the request and said why
  'offline'             // we could not reach the service at all
])

/** Reply states the SERVICE is allowed to name. Anything else is not a state. */
const SERVICE_STATES = Object.freeze(
  new Set(['checkout', 'already-subscribed', 'lapsed', 'declined', 'refused', 'unavailable'])
)

const MAX_EMAIL = 254           // RFC 5321 path limit; also what the service enforces
const MAX_SEATS = 10000

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A deliberately SHALLOW address check.
 *
 * It exists to catch a typo before a round trip, not to decide anything. The
 * service validates independently and is the authority; this returns a reason
 * only for things that are certainly wrong (empty, no @, whitespace, over
 * length). Anything cleverer rejects real addresses, and a signup page that
 * refuses a customer's genuine address is worse than one that asks the server.
 */
export function emailProblem(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return 'Enter the email address the subscription should belong to.'
  if (text.length > MAX_EMAIL) return 'That email address is too long.'
  if (/\s/.test(text)) return 'An email address cannot contain spaces.'
  const at = text.indexOf('@')
  if (at < 1 || at !== text.lastIndexOf('@') || at === text.length - 1) {
    return 'That does not look like an email address -- it needs one @ with text on both sides.'
  }
  if (!text.slice(at + 1).includes('.')) return 'The part after the @ needs a dot in it.'
  return null
}

/** Seats, checked against the plan's own minimum. Null plan => refuse. */
export function seatsProblem(plan, value) {
  const minimum = plan && Number.isSafeInteger(plan.seatMinimum) && plan.seatMinimum > 0 ? plan.seatMinimum : null
  if (minimum === null) return null                      // this plan is not seat-based
  if (value === '' || value === null || value === undefined) {
    return `The ${plan.label} plan starts at ${minimum} seats. Enter how many you need.`
  }
  const seats = Number(value)
  if (!Number.isSafeInteger(seats)) return 'Seats must be a whole number.'
  if (seats < minimum) return `The ${plan.label} plan starts at ${minimum} seats.`
  if (seats > MAX_SEATS) return 'That is more seats than this form can order; get in touch instead.'
  return null
}

/**
 * The billing periods a plan really offers, derived from the prices the model
 * gave it. A plan with no annual price does not get an annual toggle -- an
 * unpriced option on a payment form is a promise of a number nobody set.
 */
export function billingPeriodsFor(plan) {
  const periods = []
  if (Number.isFinite(plan?.monthlyUsd) && plan.monthlyUsd > 0) periods.push('monthly')
  if (Number.isFinite(plan?.annualUsd) && plan.annualUsd > 0) periods.push('annual')
  return periods
}

/** The charge for one plan on one period, or null when that pairing has no price. */
export function priceFor(plan, period) {
  if (!plan) return null
  if (period === 'annual') return Number.isFinite(plan.annualUsd) && plan.annualUsd > 0 ? plan.annualUsd : null
  if (period === 'monthly') return Number.isFinite(plan.monthlyUsd) && plan.monthlyUsd > 0 ? plan.monthlyUsd : null
  return null
}

let attemptCounter = 0

/* Stable, unguessable-enough, and NOT derived from the email address: an
   idempotency key travels in a request header and ends up in provider logs, so
   deriving it from a customer's address would put that address somewhere it
   was never meant to be. Random plus a counter, minted locally. */
function mintAttemptKey(random) {
  attemptCounter += 1
  const bytes = new Uint8Array(16)
  if (random?.getRandomValues) random.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `att_${attemptCounter.toString(36)}_${hex}`
}

/**
 * Create the flow.
 *
 * @param {object} options
 * @param {(request:object)=>Promise<object>} options.submit  performs the signup request
 * @param {()=>boolean} [options.isOnline]                    navigator.onLine, injectable
 * @param {Crypto} [options.random]                           crypto, injectable
 */
export function createSignupFlow({ submit, isOnline, random } = {}) {
  if (typeof submit !== 'function') {
    throw new Error('createSignupFlow needs a submit function; a signup form with no service behind it must not exist.')
  }
  const online = typeof isOnline === 'function' ? isOnline : () => true

  let state = 'loading'
  let detail = null            // { reason, field?, checkoutUrl?, signupId?, manageUrl? }
  let attemptKey = null
  let inFlight = false
  let fields = { email: '', planId: null, period: 'monthly', seats: '' }

  /* A field changed => this is a NEW attempt. The old key must not be reused,
     or a corrected email is sent under the key the service already answered and
     is discarded as a duplicate -- a form that silently ignores your fix. */
  function startNewAttempt() { attemptKey = null }

  function snapshot() {
    return Object.freeze({
      state,
      detail: detail ? Object.freeze({ ...detail }) : null,
      fields: Object.freeze({ ...fields }),
      busy: inFlight,
      /* The single predicate the view asks. It is here, not in the view, so
         that "can this person be charged right now" is answered by one
         expression that a test can pin. */
      canSubmit: state !== 'loading' && state !== 'unavailable' && state !== 'already-subscribed'
        && state !== 'checkout' && !inFlight
    })
  }

  return {
    get snapshot() { return snapshot() },

    /** The catalog answered. Either we can sell, or we say why we cannot. */
    catalogResolved(result) {
      if (!result?.ok) {
        state = 'unavailable'
        detail = { reason: result?.reason || 'the plan catalog could not be read', offline: result?.offline === true }
        return snapshot()
      }
      state = 'ready'
      detail = null
      return snapshot()
    },

    setField(name, value) {
      if (!Object.prototype.hasOwnProperty.call(fields, name)) return snapshot()
      if (fields[name] === value) return snapshot()
      fields = { ...fields, [name]: value }
      startNewAttempt()
      /* Editing after a refusal clears the refusal but NOT a terminal answer
         about this address: 'already-subscribed' is a fact about the account,
         not about the form, and typing does not change it. It clears when the
         email itself changes, which is when it stops being about this address. */
      if (state === 'refused' || state === 'declined' || state === 'offline' || state === 'lapsed') {
        state = 'ready'
        detail = null
      } else if (state === 'already-subscribed' && name === 'email') {
        state = 'ready'
        detail = null
      }
      return snapshot()
    },

    /** Local validation only. Returns a map of field -> reason, possibly empty. */
    problems(plan) {
      const found = {}
      const email = emailProblem(fields.email)
      if (email) found.email = email
      if (!fields.planId) found.planId = 'Choose a plan.'
      const seats = seatsProblem(plan, fields.seats)
      if (seats) found.seats = seats
      if (plan && !billingPeriodsFor(plan).includes(fields.period)) {
        found.period = `The ${plan.label} plan is not offered on that billing period.`
      }
      return found
    },

    /**
     * Try to start a subscription.
     *
     * Returns the snapshot AFTER the attempt. Never throws: a thrown error in a
     * submit handler is an unhandled rejection and an unhandled rejection on a
     * payment page is a spinner that never stops.
     */
    async submitAttempt(plan) {
      if (inFlight) return snapshot()                        // the second press of a double press
      if (state === 'already-subscribed' || state === 'checkout') return snapshot()

      const found = this.problems(plan)
      const firstProblem = Object.keys(found)[0]
      if (firstProblem) {
        state = 'refused'
        detail = { reason: found[firstProblem], field: firstProblem, local: true }
        return snapshot()
      }
      if (!online()) {
        state = 'offline'
        detail = { reason: 'This device is offline, so nothing was sent and nothing was charged.' }
        return snapshot()
      }

      if (!attemptKey) attemptKey = mintAttemptKey(random)
      inFlight = true
      state = 'submitting'
      detail = null

      let reply
      try {
        reply = await submit({
          email: String(fields.email).trim(),
          planId: fields.planId,
          billingPeriod: fields.period,
          seats: fields.seats === '' ? null : Number(fields.seats),
          idempotencyKey: attemptKey
        })
      } catch (error) {
        inFlight = false
        state = 'offline'
        detail = { reason: `We could not reach the signup service (${error?.message || error}). Nothing was charged.` }
        return snapshot()
      }
      inFlight = false
      return applyReply(reply)
    },

    /**
     * The back button, and bfcache restore.
     *
     * A person who starts checkout and presses Back arrives at a page whose
     * JavaScript state was restored WITH `inFlight` still true and the button
     * still disabled -- a form nobody can use and nothing explains. This is the
     * call that undoes that. It never re-submits: resuming a payment without
     * being asked is the one thing a back button must not do.
     */
    restored() {
      inFlight = false
      if (state === 'submitting') {
        state = 'ready'
        detail = { reason: 'You came back before that finished, so nothing was started. You can try again.' }
      }
      return snapshot()
    },

    /** A status re-read (e.g. after returning from the provider). Same rules. */
    statusResolved(reply) {
      return applyReply(reply)
    }
  }

  function applyReply(reply) {
    if (!isPlainObject(reply)) {
      state = 'refused'
      detail = { reason: 'The signup service sent something this page could not read, so nothing was started.' }
      return snapshot()
    }
    if (reply.ok === true) {
      if (reply.state !== 'checkout' || typeof reply.checkoutUrl !== 'string' || !reply.checkoutUrl) {
        // A success with no way to pay is not a success.
        state = 'refused'
        detail = { reason: 'The signup service accepted the request but gave no way to pay, so nothing was started.' }
        return snapshot()
      }
      state = 'checkout'
      detail = {
        reason: reply.reason || null,
        checkoutUrl: reply.checkoutUrl,
        signupId: typeof reply.signupId === 'string' ? reply.signupId : null,
        testMode: reply.testMode === true
      }
      return snapshot()
    }
    const named = typeof reply.state === 'string' && SERVICE_STATES.has(reply.state) ? reply.state : null
    if (!named) {
      state = 'refused'
      detail = { reason: 'The signup service reported a state this page does not recognise, so nothing was started.' }
      return snapshot()
    }
    state = named === 'unavailable' ? 'refused' : named
    detail = {
      reason: typeof reply.reason === 'string' && reply.reason
        ? reply.reason
        : 'The signup service refused the request without saying why, so nothing was started.',
      field: typeof reply.field === 'string' ? reply.field : undefined,
      manageUrl: typeof reply.manageUrl === 'string' ? reply.manageUrl : undefined,
      checkoutUrl: typeof reply.checkoutUrl === 'string' ? reply.checkoutUrl : undefined,
      signupId: typeof reply.signupId === 'string' ? reply.signupId : undefined
    }
    return snapshot()
  }
}
