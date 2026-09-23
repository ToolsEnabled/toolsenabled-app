'use strict'

/* THE SIGNUP SERVICE BEHIND THE SUBSCRIPTION PAGE.
 *
 * It does exactly three things, in this order, and refuses at any step:
 *   1. records the account the subscription will belong to,
 *   2. mints the relay pair id the fulfilment path REQUIRES, and
 *   3. asks the payment provider for a checkout session for one priced plan.
 *
 * It never grants a tier. Granting happens on the operator side when the
 * provider's SIGNED webhook arrives (the engine's src/lib/entitlement-fulfilment.js),
 * which is a different machine, a different lane, and the only party that has
 * evidence a payment actually happened. Everything here is pre-payment.
 *
 * ------------------------------------------------------------------------
 * WHY IT LIVES IN shell/ AND NOT IN tools/
 *
 * It used to be tools/subscribe-service.mjs, and it was unreachable from the
 * product for exactly that reason: package.json's build.files excludes tools/**
 * from the archive, so the shipped application contained a page that posts to
 * /v1/signup and nothing at all that answers there. The shell's own file server
 * fell through to the SPA fallback and handed the page index.html with a 200,
 * which the page could only read as "the service is not answering" -- so a
 * customer pressing "Continue to payment" was told they were offline.
 *
 * shell/** is in build.files. Putting the service here is what makes the
 * endpoint exist in a packaged build; shell/subscribe-endpoint.cjs mounts it.
 *
 * ------------------------------------------------------------------------
 * WHY IT NO LONGER READS THE ENGINE
 *
 * It used to resolve an engine checkout at runtime (src/lib/entitlement.js) to
 * learn what is sold and which metadata keys a paid session must carry. The
 * shipped payload deliberately does not contain that module -- the owner ruled
 * on 2026-08-11 that the tier table, the licence provider and the revocation
 * store do not ship -- so on a customer's machine that lookup could only ever
 * fail. The facts it needed are now PRECOMPUTED at pack time into
 * shell/subscription-signup-model.json (see readSignupModel below and
 * `node tools/subscribe-service.mjs --emit-model`), which is a shipped data
 * file rather than a source tree that has to be present.
 *
 * ------------------------------------------------------------------------
 * WHY STEP 2 EXISTS, AND WHY IT IS NOT OPTIONAL
 *
 * The engine's fulfilment module refuses any paid event whose session does not
 * carry BOTH metadata keys in its REQUIRED_METADATA table -- the tier and the
 * relay pair id. A checkout session created without them produces a customer
 * who has been CHARGED and whose licence can never be issued: the money moves,
 * fulfilment throws ENTITLEMENT_FULFILMENT_PAIR_MISSING, and the person owns
 * nothing. So this service takes those key NAMES from the precomputed model
 * rather than restating them, and refuses to create a session that is missing
 * either. A missing pair id is a refusal BEFORE the charge, which costs a
 * signup; the alternative costs a customer.
 *
 * ------------------------------------------------------------------------
 * MONEY SAFETY IS STRUCTURAL, NOT A FLAG
 *
 * This program cannot be configured into placing a real charge:
 *   - `mode` must be the exact string 'test'. Unset, empty, 'live', or anything
 *     else refuses at construction. Absence is not permission.
 *   - the secret must match ^(sk|rk)_test_ . A live-prefixed secret is refused
 *     by shape, before any request is built, so a mis-set environment variable
 *     cannot become a charge.
 *   - the API base must be https, or http on loopback (which is how a local
 *     provider double is driven). A plaintext request to anywhere else refuses.
 *   - the session the provider returns must have a test-mode id. If a live id
 *     ever comes back the reply is DISCARDED and the signup fails: whatever went
 *     wrong, the customer is not being handed a live payment link.
 * The vault card is not referenced here at all. This service reads no card, no
 * live key, and no owner credential of any kind.
 *
 * ------------------------------------------------------------------------
 * WHAT IS PER-DEPLOYMENT AND SO IS NOT IN THE REPOSITORY
 *
 * The signup ledger holds customer email addresses and the price map holds a
 * merchant's own price ids. Neither has a built-in default value: a MISSING
 * price map is a refusal naming the file, never an empty map that silently
 * sells nothing. In the shipped application both resolve under this install's
 * own userData directory (shell/subscribe-endpoint.cjs); on a builder's machine
 * they default under private/, which .gitignore anchors, for the same reason
 * the engine keeps config/entitlement.profile.json out of its tree.
 */

const { createServer } = require('node:http')
const { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_STORE = path.join(REPO_ROOT, 'private', 'subscription-signups.json')
const DEFAULT_PRICES = path.join(REPO_ROOT, 'private', 'subscription-prices.json')
const DEFAULT_MODEL = path.join(__dirname, 'subscription-signup-model.json')

const SIGNUP_MODEL_SCHEMA_VERSION = 1

const MAX_BODY_BYTES = 16 * 1024
const MAX_EMAIL = 254
const MAX_SEATS = 10000
const SESSION_TTL_MS = 30 * 60 * 1000

class SignupRefusal extends Error {
  constructor(state, reason, { status = 400, field = null, extra = {} } = {}) {
    super(reason)
    this.name = 'SignupRefusal'
    this.state = state
    this.reason = reason
    this.status = status
    this.field = field
    this.extra = extra
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function atomicWrite(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } finally {
    try { unlinkSync(temporary) } catch { /* renamed away, or never created */ }
  }
}

// ---------------------------------------------------------------------------
// The provider adapter
// ---------------------------------------------------------------------------

const TEST_SECRET = /^(sk|rk)_test_[A-Za-z0-9_]+$/
const LIVE_SECRET = /^(sk|rk)_live_/

/** Loopback only, so a local provider double can be driven without TLS. */
function isLoopbackHttp(url) {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
}

/**
 * Build the checkout-session creator.
 *
 * Every refusal below happens at CONSTRUCTION, before a request exists, so a
 * misconfigured deployment cannot start and then discover the problem halfway
 * through a customer's payment.
 */
function createCheckoutProvider({ mode, secretKey, apiBase, request } = {}) {
  if (mode !== 'test') {
    throw new SignupRefusal('unavailable',
      `the payment provider mode is ${JSON.stringify(mode ?? null)}; this service only runs in 'test'. `
      + 'An unset mode is not permission to charge anybody.', { status: 503 })
  }
  if (typeof secretKey !== 'string' || !secretKey) {
    throw new SignupRefusal('unavailable', 'no payment provider key is configured, so no session can be created.', { status: 503 })
  }
  if (LIVE_SECRET.test(secretKey)) {
    throw new SignupRefusal('unavailable',
      'a LIVE payment provider key was supplied to a test-mode service. Refused by shape, before any request '
      + 'was built. Nothing was sent and nothing could have been charged.', { status: 503 })
  }
  if (!TEST_SECRET.test(secretKey)) {
    throw new SignupRefusal('unavailable',
      'the payment provider key is not a recognisable test-mode key. Deny by default: an unrecognised key is '
      + 'refused rather than tried.', { status: 503 })
  }
  let base
  try {
    base = new URL(apiBase)
  } catch {
    throw new SignupRefusal('unavailable', `the payment provider base URL ${JSON.stringify(apiBase ?? null)} is not a URL.`, { status: 503 })
  }
  if (base.protocol !== 'https:' && !isLoopbackHttp(base)) {
    throw new SignupRefusal('unavailable',
      'the payment provider base URL is plaintext http to a host that is not loopback. A signup request carries '
      + 'a customer address and a secret key; it does not go out in the clear.', { status: 503 })
  }
  const doRequest = request || defaultRequest

  return {
    mode,
    apiBase: base.toString().replace(/\/$/, ''),
    async createSession(input) {
      const form = new URLSearchParams()
      form.set('mode', 'subscription')
      form.set('customer_email', input.email)
      form.set('line_items[0][price]', input.priceId)
      form.set('line_items[0][quantity]', String(input.quantity))
      form.set('success_url', input.successUrl)
      form.set('cancel_url', input.cancelUrl)
      for (const [key, value] of Object.entries(input.metadata)) {
        form.set(`metadata[${key}]`, value)
        // The subscription carries the same metadata: the fulfilment path reads
        // it from invoice.paid on every RENEWAL, long after the session is gone.
        form.set(`subscription_data[metadata][${key}]`, value)
      }

      const reply = await doRequest({
        url: `${base.toString().replace(/\/$/, '')}/checkout/sessions`,
        secretKey,
        idempotencyKey: input.idempotencyKey,
        body: form.toString()
      })

      if (!isPlainObject(reply) || typeof reply.id !== 'string' || typeof reply.url !== 'string' || !reply.url) {
        throw new SignupRefusal('unavailable',
          'the payment provider did not return a usable checkout session, so there is nothing to pay with.',
          { status: 502 })
      }
      /* THE LAST BELT. Even with every construction check passed, a session id
         without the test marker means we are not where we thought we were. The
         reply is thrown away rather than handed to a customer. */
      if (!reply.id.startsWith('cs_test_')) {
        throw new SignupRefusal('unavailable',
          'the payment provider returned a session that is not test-mode. It has been discarded and no payment '
          + 'link was issued. This service does not hand out live checkout links.', { status: 502 })
      }
      if (reply.livemode === true) {
        throw new SignupRefusal('unavailable',
          'the payment provider reported the session as live-mode. Discarded; no payment link was issued.',
          { status: 502 })
      }
      return { id: reply.id, url: reply.url, testMode: true }
    }
  }
}

async function defaultRequest({ url, secretKey, idempotencyKey, body }) {
  const headers = {
    authorization: `Basic ${Buffer.from(`${secretKey}:`, 'utf8').toString('base64')}`,
    'content-type': 'application/x-www-form-urlencoded'
  }
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey
  const response = await fetch(url, { method: 'POST', headers, body })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* handled below */ }
  if (!response.ok) {
    const message = parsed?.error?.message || `${response.status} ${response.statusText}`
    const declineCodes = new Set(['card_declined', 'expired_card', 'incorrect_cvc', 'insufficient_funds', 'processing_error'])
    if (declineCodes.has(parsed?.error?.code) || parsed?.error?.type === 'card_error') {
      throw new SignupRefusal('declined', `The card was declined: ${message}. Nothing was charged.`, { status: 402 })
    }
    throw new SignupRefusal('unavailable', `the payment provider refused the request: ${message}`, { status: 502 })
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Configuration that is per-deployment and must be present
// ---------------------------------------------------------------------------

/**
 * planId + billing period -> provider price id.
 *
 * A MISSING file is a refusal naming the file. An EMPTY map is a refusal too:
 * "no prices configured" and "this plan has no price" are different failures and
 * only one of them is a deployment that simply has not been set up yet.
 */
function readPriceMap(file = DEFAULT_PRICES) {
  if (!existsSync(file)) {
    throw new SignupRefusal('unavailable',
      `no provider price map at ${file}. Without it no plan has anything to charge against, so no session can `
      + 'be created. Copy config/subscription-prices.example.json and fill in your test-mode price ids.',
      { status: 503 })
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new SignupRefusal('unavailable', `the provider price map is not valid JSON (${error.message}).`, { status: 503 })
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.prices) || Object.keys(parsed.prices).length === 0) {
    throw new SignupRefusal('unavailable', 'the provider price map declares no prices.', { status: 503 })
  }
  if (parsed.mode !== 'test') {
    throw new SignupRefusal('unavailable',
      `the provider price map declares mode ${JSON.stringify(parsed.mode ?? null)}; this service only loads a `
      + "map marked 'test'. A live price id must not be reachable from here.", { status: 503 })
  }
  for (const [key, value] of Object.entries(parsed.prices)) {
    if (typeof value !== 'string' || !/^price_[A-Za-z0-9_]+$/.test(value)) {
      throw new SignupRefusal('unavailable', `price map entry "${key}" is not a provider price id.`, { status: 503 })
    }
  }
  return parsed.prices
}

/**
 * WHAT IS SOLD AND WHAT A PAID SESSION MUST CARRY, READ FROM A SHIPPED FILE.
 *
 * This is the replacement for loading the engine's src/lib/entitlement.js at
 * runtime, and the reason the endpoint can exist in a packaged build at all.
 * The file is written at pack time by `node tools/subscribe-service.mjs
 * --emit-model`, from the same engine tree tools/gen-subscription-catalog.mjs
 * prices the page from, so the two cannot describe different products.
 *
 * EVERY FAILURE HERE IS A REFUSAL, INCLUDING THE EMPTY ONES. A model with no
 * paid tier, or with a blank metadata key name, would let this service create a
 * session that fulfilment must later reject -- a customer charged for an
 * entitlement nothing can issue. Absent, unreadable, wrong-version and empty are
 * all "do not sell anything", never "sell with defaults".
 */
function readSignupModel(file = DEFAULT_MODEL) {
  if (!existsSync(file)) {
    throw new SignupRefusal('unavailable',
      `no subscription model at ${file}. It states what is sold and what a paid session must carry, and without `
      + 'it nothing can be sold. Run "node tools/subscribe-service.mjs --emit-model" against the engine tree.',
      { status: 503 })
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new SignupRefusal('unavailable', `the subscription model is not valid JSON (${error.message}).`, { status: 503 })
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== SIGNUP_MODEL_SCHEMA_VERSION) {
    throw new SignupRefusal('unavailable',
      `the subscription model states schema version ${JSON.stringify(parsed?.schemaVersion ?? null)}, and this `
      + `build reads version ${SIGNUP_MODEL_SCHEMA_VERSION}. Nothing was sold against a model it cannot read.`,
      { status: 503 })
  }
  const metadata = parsed.requiredMetadata
  if (!isPlainObject(metadata)) {
    throw new SignupRefusal('unavailable',
      'the subscription model names no required session metadata, so a session created from it would be refused '
      + 'by the fulfilment path after the customer had paid. Nothing was started.', { status: 503 })
  }
  for (const key of ['tier', 'pairId']) {
    if (typeof metadata[key] !== 'string' || !metadata[key].trim()) {
      throw new SignupRefusal('unavailable',
        `the subscription model gives no name for the "${key}" metadata key a paid session must carry. A session `
        + 'without it produces a charge that can never become a licence, so nothing was started.', { status: 503 })
    }
  }
  if (!isPlainObject(parsed.tiers) || Object.keys(parsed.tiers).length === 0) {
    throw new SignupRefusal('unavailable', 'the subscription model declares no plans, so there is nothing to sell.', { status: 503 })
  }
  const tiers = {}
  for (const [id, tier] of Object.entries(parsed.tiers)) {
    if (!isPlainObject(tier) || tier.id !== id || typeof tier.label !== 'string' || !tier.label.trim()) {
      throw new SignupRefusal('unavailable', `the subscription model's "${id}" plan has no usable identity.`, { status: 503 })
    }
    tiers[id] = tier
  }
  if (!Object.values(tiers).some(tier => tier.requiresLicense === true)) {
    throw new SignupRefusal('unavailable',
      'the subscription model declares no plan that needs a licence, so this service has nothing it could sell.',
      { status: 503 })
  }
  return { TIERS: tiers, REQUIRED_METADATA: { tier: metadata.tier, pairId: metadata.pairId } }
}

// ---------------------------------------------------------------------------
// The signup ledger
// ---------------------------------------------------------------------------

class SignupStore {
  constructor(file = DEFAULT_STORE) {
    this.file = path.resolve(file)
  }

  read() {
    let raw
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { schemaVersion: 1, accounts: {}, attempts: {}, signups: {} }
      throw new SignupRefusal('unavailable', `the signup ledger could not be read (${error?.code}).`, { status: 503 })
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      /* Never silently replaced with an empty one: that would forget every
         existing subscriber and let each of them be sold a second one. */
      throw new SignupRefusal('unavailable',
        'the signup ledger is not valid JSON; refusing to overwrite it. No signup can be recorded until a '
        + 'human looks at it.', { status: 503 })
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.accounts) || !isPlainObject(parsed.attempts) || !isPlainObject(parsed.signups)) {
      throw new SignupRefusal('unavailable', 'the signup ledger has an unrecognised shape; refusing to overwrite it.', { status: 503 })
    }
    return parsed
  }

  write(state) {
    atomicWrite(this.file, `${JSON.stringify(state, null, 2)}\n`)
  }
}

/** Addresses are compared case-insensitively on the domain AND the local part.
 *  Two rows for the same human is how one person gets charged twice. */
function accountKey(email) {
  return String(email).trim().toLowerCase()
}

/**
 * The subscription state of an existing account, as far as THIS service knows.
 *
 * Deliberately conservative in one direction only: an account whose record we
 * cannot interpret is treated as ALREADY SUBSCRIBED, not as new. Selling a
 * second subscription to someone who already pays is a charge that should never
 * have happened; refusing a signup that could have proceeded is a support email.
 */
function accountSubscriptionState(account, nowMs) {
  if (!isPlainObject(account)) return { state: 'new' }
  const status = account.status
  if (status === 'active') {
    const until = typeof account.paidUntilMs === 'number' ? account.paidUntilMs : null
    if (until !== null && until <= nowMs) return { state: 'lapsed', since: until }
    return { state: 'active', subscriptionId: account.subscriptionId || null }
  }
  if (status === 'lapsed' || status === 'cancelled') return { state: 'lapsed', since: account.paidUntilMs ?? null }
  if (status === 'pending') return { state: 'pending' }
  return { state: 'unreadable' }
}

// ---------------------------------------------------------------------------
// The request handler
// ---------------------------------------------------------------------------

function requireEmail(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new SignupRefusal('refused', 'An email address is required.', { field: 'email' })
  if (text.length > MAX_EMAIL) throw new SignupRefusal('refused', 'That email address is too long.', { field: 'email' })
  if (/\s/.test(text) || /[\x00-\x1f\x7f]/.test(text)) {
    throw new SignupRefusal('refused', 'That email address contains characters an address cannot have.', { field: 'email' })
  }
  const at = text.indexOf('@')
  if (at < 1 || at !== text.lastIndexOf('@') || at === text.length - 1 || !text.slice(at + 1).includes('.')) {
    throw new SignupRefusal('refused', 'That does not look like an email address.', { field: 'email' })
  }
  return text
}

/**
 * Build the whole service. Exported so the suite can drive it with an injected
 * clock, store, provider and engine model, with no server and no sockets.
 */
function createSignupService({ engine, priceMap, provider, store, now, siteOrigin } = {}) {
  if (!engine?.TIERS || !engine?.REQUIRED_METADATA) {
    throw new SignupRefusal('unavailable',
      'the entitlement model was not loaded, so this service does not know what is sold or what metadata a paid '
      + 'session must carry. Refusing to sell anything.', { status: 503 })
  }
  const clock = typeof now === 'function' ? now : () => Date.now()
  const ledger = store || new SignupStore()
  /* A function is accepted as well as a string because the return URLs have to
     name the origin the SITE ended up on, and a harness that binds port 0 does
     not know that until after this service exists. Resolving late rather than
     capturing early is what stops the success URL pointing at a port nobody is
     listening on -- which would strand a paying customer on a dead page. */
  const originOf = typeof siteOrigin === 'function' ? siteOrigin : () => (siteOrigin || 'http://127.0.0.1:4600')

  function planFor(planId) {
    const tier = Object.prototype.hasOwnProperty.call(engine.TIERS, planId) ? engine.TIERS[planId] : null
    if (!tier || tier.requiresLicense !== true) {
      throw new SignupRefusal('refused', 'That is not a plan you can subscribe to.', { field: 'planId' })
    }
    return tier
  }

  function priceIdFor(planId, period) {
    const key = `${planId}:${period}`
    const priceId = priceMap[key]
    if (!priceId) {
      throw new SignupRefusal('unavailable',
        `no provider price is configured for ${key}, so nothing can be charged for it. Nothing was started.`,
        { status: 503 })
    }
    return priceId
  }

  return {
    /** GET /v1/signup/:id */
    status(signupId) {
      const state = ledger.read()
      const record = state.signups[signupId]
      if (!record) return { ok: false, state: 'refused', reason: 'That signup is not one this service issued.' }
      if (record.state === 'checkout' && record.expiresAtMs <= clock()) {
        return { ok: false, state: 'refused', reason: 'That checkout link has expired. Start again; nothing was charged.' }
      }
      if (record.state !== 'checkout') {
        return { ok: false, state: record.state, reason: record.reason || 'That signup did not complete.' }
      }
      return {
        ok: true, state: 'checkout', signupId, checkoutUrl: record.checkoutUrl, testMode: true
      }
    },

    /** POST /v1/signup */
    async signup(input) {
      if (!isPlainObject(input)) throw new SignupRefusal('refused', 'The signup request could not be read.')
      const email = requireEmail(input.email)
      const plan = planFor(input.planId)
      const period = input.billingPeriod === 'annual' ? 'annual' : input.billingPeriod === 'monthly' ? 'monthly' : null
      if (!period) throw new SignupRefusal('refused', 'Choose monthly or annual billing.', { field: 'period' })
      /* THE MODEL STATES WHETHER AN ANNUAL PERIOD EXISTS, NOT WHAT IT COSTS.
         This asked `Number.isFinite(plan.annualUsd) && plan.annualUsd > 0` and
         printed the amount nowhere -- a price shipped inside app.asar so that a
         boolean could be derived from it at runtime. See
         tools/subscribe-service.mjs buildSignupModel. */
      if (period === 'annual' && plan.annualOffered !== true) {
        throw new SignupRefusal('refused', `The ${plan.label} plan is not offered annually.`, { field: 'period' })
      }

      const minimum = Number.isSafeInteger(plan.seatMinimum) && plan.seatMinimum > 0 ? plan.seatMinimum : 1
      const seats = input.seats === null || input.seats === undefined ? minimum : Number(input.seats)
      if (!Number.isSafeInteger(seats) || seats < minimum || seats > MAX_SEATS) {
        throw new SignupRefusal('refused',
          `The ${plan.label} plan starts at ${minimum} seat${minimum === 1 ? '' : 's'}.`, { field: 'seats' })
      }

      const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : ''
      if (idempotencyKey.length < 8 || idempotencyKey.length > 255 || /[^A-Za-z0-9_-]/.test(idempotencyKey)) {
        /* Without a usable key this service cannot tell a retry from a second
           purchase, so it refuses rather than risking the second one. */
        throw new SignupRefusal('refused', 'The signup request carried no usable idempotency key, so it was not sent on.')
      }

      const state = ledger.read()
      const key = accountKey(email)

      // --- the second press of a double press, and the network retry --------
      const previous = state.attempts[idempotencyKey]
      if (previous) {
        if (previous.accountKey !== key || previous.planId !== input.planId || previous.period !== period || previous.seats !== seats) {
          throw new SignupRefusal('refused',
            'That request reused an idempotency key with different details. Nothing was sent on; reload the page '
            + 'and try again.')
        }
        const record = state.signups[previous.signupId]
        if (record?.state === 'checkout' && record.expiresAtMs > clock()) {
          return { ok: true, state: 'checkout', signupId: previous.signupId, checkoutUrl: record.checkoutUrl, testMode: true, replayed: true }
        }
        throw new SignupRefusal('refused', 'That attempt has already been used and its checkout link is gone. Start again; nothing was charged.')
      }

      // --- absence and presence of an existing account, absence tested first -
      const existing = state.accounts[key]
      const account = accountSubscriptionState(existing, clock())
      if (account.state === 'unreadable') {
        throw new SignupRefusal('already-subscribed',
          'There is already a record for this address that this service cannot read, so it will not start a second '
          + 'subscription for it. Get in touch and a person will sort it out.', { status: 409 })
      }
      if (account.state === 'active') {
        throw new SignupRefusal('already-subscribed',
          'This address already has an active subscription. You have not been charged again.',
          { status: 409, extra: { manageUrl: `${originOf()}/#/account` } })
      }

      // --- the pair id the fulfilment path requires --------------------------
      const pairId = typeof existing?.pairId === 'string' && existing.pairId
        ? existing.pairId
        : `pair_${crypto.randomUUID().replace(/-/g, '')}`

      const metadata = {
        [engine.REQUIRED_METADATA.tier]: plan.id,
        [engine.REQUIRED_METADATA.pairId]: pairId
      }
      for (const [name, value] of Object.entries(metadata)) {
        if (typeof value !== 'string' || !value.trim()) {
          throw new SignupRefusal('unavailable',
            `the checkout session would carry an empty "${name}", and the fulfilment path refuses such an event. `
            + 'A customer would be charged and never receive a licence, so nothing was started.', { status: 503 })
        }
      }

      const signupId = `sub_${crypto.randomUUID().replace(/-/g, '')}`
      const session = await provider.createSession({
        email,
        priceId: priceIdFor(plan.id, period),
        quantity: seats,
        metadata,
        idempotencyKey,
        successUrl: `${originOf()}/#/subscribe?signup=${signupId}&result=complete`,
        cancelUrl: `${originOf()}/#/subscribe?signup=${signupId}&result=cancelled`
      })

      const nowMs = clock()
      const next = ledger.read()
      next.accounts[key] = {
        ...(isPlainObject(existing) ? existing : {}),
        email,
        pairId,
        // PENDING, not active. This service has evidence that a checkout was
        // started and no evidence at all that anyone paid.
        status: 'pending',
        lastSignupId: signupId,
        updatedAtMs: nowMs
      }
      next.attempts[idempotencyKey] = { signupId, accountKey: key, planId: plan.id, period, seats, createdAtMs: nowMs }
      next.signups[signupId] = {
        signupId,
        accountKey: key,
        planId: plan.id,
        period,
        seats,
        pairId,
        state: 'checkout',
        providerSessionId: session.id,
        checkoutUrl: session.url,
        createdAtMs: nowMs,
        expiresAtMs: nowMs + SESSION_TTL_MS,
        testMode: true
      }
      ledger.write(next)

      const reply = { ok: true, state: 'checkout', signupId, checkoutUrl: session.url, testMode: true }
      if (account.state === 'lapsed') {
        reply.reason = 'Your previous subscription had ended, so this starts a new one. Your data was never touched.'
      }
      return reply
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  response.end(text)
}

function refusalBody(error) {
  if (error instanceof SignupRefusal) {
    return { status: error.status, body: { ok: false, state: error.state, reason: error.reason, ...(error.field ? { field: error.field } : {}), ...error.extra } }
  }
  /* An unexpected throw must not leak a stack trace to a stranger, and must not
     read as a soft failure either. It is a refusal with nothing started. */
  return { status: 500, body: { ok: false, state: 'unavailable', reason: 'The signup service hit an unexpected problem, so nothing was started.' } }
}

function createHttpHandler(service, { allowOrigin } = {}) {
  return async function handler(request, response) {
    const cors = allowOrigin ? { 'access-control-allow-origin': allowOrigin } : {}
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { ...cors, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, GET, OPTIONS' })
      response.end()
      return
    }
    for (const [name, value] of Object.entries(cors)) response.setHeader(name, value)

    const url = new URL(request.url, 'http://127.0.0.1')
    try {
      if (request.method === 'GET' && url.pathname.startsWith('/v1/signup/')) {
        const id = decodeURIComponent(url.pathname.slice('/v1/signup/'.length))
        const result = service.status(id)
        send(response, result.ok ? 200 : 200, result)
        return
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/signup') {
        send(response, 404, { ok: false, state: 'refused', reason: 'No such endpoint.' })
        return
      }
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          send(response, 413, { ok: false, state: 'refused', reason: 'That request was too large to read, so nothing was started.' })
          request.destroy()
          return
        }
        chunks.push(chunk)
      }
      let parsed
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        send(response, 400, { ok: false, state: 'refused', reason: 'That request was not readable JSON, so nothing was started.' })
        return
      }
      const result = await service.signup(parsed)
      send(response, 200, result)
    } catch (error) {
      const { status, body } = refusalBody(error)
      send(response, status, body)
    }
  }
}

/** Stand the service up on its own socket. Used by the CLI in tools/. */
async function listen({ handler, port, host = '127.0.0.1' }) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
  return server
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_PRICES,
  DEFAULT_STORE,
  SIGNUP_MODEL_SCHEMA_VERSION,
  SignupRefusal,
  SignupStore,
  accountKey,
  accountSubscriptionState,
  createCheckoutProvider,
  createHttpHandler,
  createSignupService,
  listen,
  readPriceMap,
  readSignupModel,
}
