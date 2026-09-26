// THE SIGNUP SERVICE, INCLUDING EVERY WAY IT REFUSES.
//
// The refusals are tested FIRST and at length, because they are the load-bearing
// half: a service that creates checkout sessions correctly and also creates one
// when the mode is unset is not a safe service, it is a lucky one.
//
// Nothing here contacts a payment provider. The provider is injected, and the
// one test that uses a real socket uses tools/test-mode-provider-double.mjs on
// loopback.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  SignupRefusal,
  SignupStore,
  accountKey,
  accountSubscriptionState,
  createCheckoutProvider,
  createSignupService,
  listen,
  readPriceMap,
} from '../subscribe-service.mjs'
import { createProviderDouble } from '../test-mode-provider-double.mjs'

/* THE SHAPE THE SHIPPED MODEL NOW HAS, AND IT CARRIES NO PRICE.
   `engine` is handed straight to createSignupService below, so this object IS
   the model the service reads. It used to state monthlyUsd (which the service
   never reads at all) and annualUsd (which it read only to ask whether the
   number was above zero) -- and those two fields are what put an unauthorised
   Team price of 299 inside app.asar. `annualOffered` is the question the period
   rule actually asks. See tools/subscribe-service.mjs buildSignupModel. */
const ENGINE = {
  TIERS: {
    community: { id: 'community', label: 'Community', requiresLicense: false, annualOffered: false },
    operator: { id: 'operator', label: 'Operator Cloud', annualOffered: true, requiresLicense: true, productId: 'x.operator.v1' },
    team: { id: 'team', label: 'Team', annualOffered: false, seatMinimum: 3, requiresLicense: true, productId: 'x.team.v1' },
  },
  REQUIRED_METADATA: { tier: 'toolsenabled_tier', pairId: 'toolsenabled_pair_id' },
}

const PRICES = {
  'operator:monthly': 'price_test_op_m',
  'operator:annual': 'price_test_op_a',
  'team:monthly': 'price_test_team_m',
}

function tempStore() {
  const directory = mkdtempSync(path.join(tmpdir(), 'sub-service-'))
  return { directory, store: new SignupStore(path.join(directory, 'signups.json')) }
}

function fakeProvider(behaviour = {}) {
  const seen = []
  return {
    seen,
    async createSession(input) {
      seen.push(input)
      if (behaviour.throw) throw behaviour.throw
      return { id: `cs_test_${seen.length}`, url: `https://pay.example/cs_test_${seen.length}`, testMode: true }
    },
  }
}

function service({ store, provider, now, priceMap = PRICES, engine = ENGINE } = {}) {
  return createSignupService({ engine, priceMap, provider: provider || fakeProvider(), store, now, siteOrigin: 'http://127.0.0.1:4600' })
}

const GOOD = { email: 'buyer@example.com', planId: 'operator', billingPeriod: 'monthly', seats: null, idempotencyKey: 'attempt-key-0001' }

// ===========================================================================
// MONEY SAFETY -- the provider adapter refuses at construction
// ===========================================================================

test('an UNSET provider mode is refused: absence is not permission to charge', () => {
  for (const mode of [undefined, null, '', 'TEST', 'live', 'production']) {
    assert.throws(
      () => createCheckoutProvider({ mode, secretKey: 'sk_test_abcdefgh', apiBase: 'https://api.example/v1' }),
      error => error instanceof SignupRefusal && /only runs in 'test'/.test(error.reason),
      `mode ${JSON.stringify(mode)} must refuse`
    )
  }
})

test('a LIVE secret is refused by shape, before any request is built', () => {
  assert.throws(
    () => createCheckoutProvider({ mode: 'test', secretKey: 'sk_live_realmoney', apiBase: 'https://api.example/v1' }),
    error => error instanceof SignupRefusal && /LIVE payment provider key/.test(error.reason)
  )
})

test('an unrecognised secret is refused rather than tried -- deny by default', () => {
  for (const secret of ['', 'hunter2', 'pk_test_abcdefgh', 'sk_testabcdefgh']) {
    assert.throws(
      () => createCheckoutProvider({ mode: 'test', secretKey: secret, apiBase: 'https://api.example/v1' }),
      error => error instanceof SignupRefusal,
      `secret ${JSON.stringify(secret)} must refuse`
    )
  }
})

test('a plaintext base URL to a non-loopback host is refused; loopback and https are allowed', () => {
  const args = { mode: 'test', secretKey: 'sk_test_abcdefgh' }
  assert.throws(() => createCheckoutProvider({ ...args, apiBase: 'http://payments.example/v1' }), /plaintext http/)
  assert.throws(() => createCheckoutProvider({ ...args, apiBase: 'not a url' }), /is not a URL/)
  assert.ok(createCheckoutProvider({ ...args, apiBase: 'https://api.example/v1' }))
  assert.ok(createCheckoutProvider({ ...args, apiBase: 'http://127.0.0.1:4621' }))
})

test('a session that is not test-mode is DISCARDED, never handed to a customer', async () => {
  const provider = createCheckoutProvider({
    mode: 'test', secretKey: 'sk_test_abcdefgh', apiBase: 'https://api.example/v1',
    request: async () => ({ id: 'cs_live_realone', url: 'https://pay.example/live' }),
  })
  await assert.rejects(
    () => provider.createSession({ email: 'a@b.co', priceId: 'price_x', quantity: 1, metadata: {}, idempotencyKey: 'k', successUrl: 's', cancelUrl: 'c' }),
    error => /not test-mode/.test(error.reason) && /no payment link was issued/.test(error.reason)
  )
})

test('a session flagged livemode is discarded even if its id looks like a test one', async () => {
  const provider = createCheckoutProvider({
    mode: 'test', secretKey: 'sk_test_abcdefgh', apiBase: 'https://api.example/v1',
    request: async () => ({ id: 'cs_test_disguised', url: 'https://pay.example/x', livemode: true }),
  })
  await assert.rejects(
    () => provider.createSession({ email: 'a@b.co', priceId: 'price_x', quantity: 1, metadata: {}, idempotencyKey: 'k', successUrl: 's', cancelUrl: 'c' }),
    /live-mode/
  )
})

test('a reply with no usable session is refused rather than rendered as a broken link', async () => {
  for (const reply of [null, {}, { id: 'cs_test_1' }, { url: 'https://pay/x' }, { id: 'cs_test_1', url: '' }]) {
    const provider = createCheckoutProvider({
      mode: 'test', secretKey: 'sk_test_abcdefgh', apiBase: 'https://api.example/v1', request: async () => reply,
    })
    await assert.rejects(
      () => provider.createSession({ email: 'a@b.co', priceId: 'price_x', quantity: 1, metadata: {}, idempotencyKey: 'k', successUrl: 's', cancelUrl: 'c' }),
      /usable checkout session/,
      `reply ${JSON.stringify(reply)} must refuse`
    )
  }
})

// ===========================================================================
// The price map -- absence first
// ===========================================================================

test('a MISSING price map is a named refusal, never an empty map', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sub-prices-'))
  try {
    assert.throws(() => readPriceMap(path.join(directory, 'nope.json')), /no provider price map/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a price map not marked test-mode is refused, so a live price id is unreachable from here', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sub-prices-'))
  const file = path.join(directory, 'p.json')
  try {
    writeFileSync(file, JSON.stringify({ mode: 'live', prices: { 'operator:monthly': 'price_live_x' } }), 'utf8')
    assert.throws(() => readPriceMap(file), /only loads a map marked 'test'/)
    writeFileSync(file, JSON.stringify({ prices: { 'operator:monthly': 'price_x' } }), 'utf8')
    assert.throws(() => readPriceMap(file), /only loads a map marked 'test'/)
    writeFileSync(file, JSON.stringify({ mode: 'test', prices: {} }), 'utf8')
    assert.throws(() => readPriceMap(file), /declares no prices/)
    writeFileSync(file, JSON.stringify({ mode: 'test', prices: { 'operator:monthly': 'not-a-price-id' } }), 'utf8')
    assert.throws(() => readPriceMap(file), /not a provider price id/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a plan with no configured price refuses BEFORE a session is created', async () => {
  const { directory, store } = tempStore()
  try {
    const provider = fakeProvider()
    const api = service({ store, provider, priceMap: { 'operator:monthly': 'price_test_op_m' } })
    await assert.rejects(() => api.signup({ ...GOOD, planId: 'team', seats: 3 }), /no provider price is configured for team:monthly/)
    assert.equal(provider.seen.length, 0, 'nothing may reach the provider')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

// ===========================================================================
// The metadata the fulfilment path requires
// ===========================================================================

test('every session carries the tier and the pair id the fulfilment path refuses to work without', async () => {
  const { directory, store } = tempStore()
  try {
    const provider = fakeProvider()
    await service({ store, provider }).signup(GOOD)
    const metadata = provider.seen[0].metadata
    assert.equal(metadata.toolsenabled_tier, 'operator')
    assert.match(metadata.toolsenabled_pair_id, /^pair_[0-9a-f]{32}$/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('the metadata KEY NAMES come from the engine, so a rename there cannot silently orphan a payment', async () => {
  const { directory, store } = tempStore()
  try {
    const provider = fakeProvider()
    const renamed = { ...ENGINE, REQUIRED_METADATA: { tier: 'te_tier_v2', pairId: 'te_pair_v2' } }
    await service({ store, provider, engine: renamed }).signup(GOOD)
    assert.deepEqual(Object.keys(provider.seen[0].metadata).sort(), ['te_pair_v2', 'te_tier_v2'])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a service built without the entitlement model refuses to sell anything', () => {
  assert.throws(() => createSignupService({ priceMap: PRICES, provider: fakeProvider() }), /Refusing to sell anything/)
  assert.throws(() => createSignupService({ engine: { TIERS: ENGINE.TIERS }, priceMap: PRICES, provider: fakeProvider() }), /Refusing to sell anything/)
})

// ===========================================================================
// Request validation
// ===========================================================================

test('a free plan cannot be subscribed to, and neither can an unknown one', async () => {
  const { directory, store } = tempStore()
  try {
    const api = service({ store })
    for (const planId of ['community', 'enterprise', '', null, '__proto__', 'constructor']) {
      await assert.rejects(() => api.signup({ ...GOOD, planId }), /not a plan you can subscribe to/, `planId ${JSON.stringify(planId)}`)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a period the plan does not offer is refused server-side too, and one it does offer still reaches the provider', async () => {
  const { directory, store } = tempStore()
  try {
    const provider = fakeProvider()
    const api = service({ store, provider })
    await assert.rejects(() => api.signup({ ...GOOD, planId: 'team', seats: 3, billingPeriod: 'annual' }), /not offered annually/)
    await assert.rejects(() => api.signup({ ...GOOD, billingPeriod: 'weekly' }), /monthly or annual/)
    /* THE POSITIVE HALF, WHICH NOTHING ASSERTED BEFORE. While the period rule
       read a price (annualUsd > 0), no test ever took an annual period that the
       model DOES offer -- so removing the price could have made every annual
       signup refuse and every suite stayed green. */
    await api.signup({ ...GOOD, billingPeriod: 'annual', idempotencyKey: 'k-annual-0001' })
    assert.equal(provider.seen.at(-1).priceId, PRICES['operator:annual'],
      'mutation `refuse every annual period once the price left the model` survived: expected the annual plan to reach the provider')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('seats below the plan minimum are refused server-side; an ABSENT seats value takes the minimum', async () => {
  const { directory, store } = tempStore()
  try {
    const provider = fakeProvider()
    const api = service({ store, provider })
    await assert.rejects(() => api.signup({ ...GOOD, planId: 'team', seats: 2, idempotencyKey: 'k-low-0001' }), /starts at 3 seats/)
    await api.signup({ ...GOOD, planId: 'team', seats: null, idempotencyKey: 'k-min-0001' })
    assert.equal(provider.seen.at(-1).quantity, 3)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('an unusable idempotency key is refused, because a retry could not be told from a second purchase', async () => {
  const { directory, store } = tempStore()
  try {
    const api = service({ store })
    for (const key of [undefined, '', 'short', 'has spaces!!', 'x'.repeat(300)]) {
      await assert.rejects(() => api.signup({ ...GOOD, idempotencyKey: key }), /no usable idempotency key/, `key ${JSON.stringify(key)}`)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a malformed address is refused before anything is recorded', async () => {
  const { directory, store } = tempStore()
  try {
    const provider = fakeProvider()
    const api = service({ store, provider })
    for (const email of ['', '   ', 'nope', 'a@b', 'a b@c.com', `${'x'.repeat(300)}@y.com`]) {
      await assert.rejects(() => api.signup({ ...GOOD, email }), error => error.state === 'refused', `email ${JSON.stringify(email)}`)
    }
    assert.equal(provider.seen.length, 0)
    assert.deepEqual(store.read().accounts, {}, 'nothing may be recorded for a refused request')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

// ===========================================================================
// Idempotency, already-subscribed, lapsed
// ===========================================================================

test('the same attempt key returns the SAME checkout session and creates no second one', async () => {
  const { directory, store } = tempStore()
  try {
    const provider = fakeProvider()
    const api = service({ store, provider })
    const first = await api.signup(GOOD)
    const second = await api.signup(GOOD)
    assert.equal(provider.seen.length, 1, 'the provider must be asked once')
    assert.equal(second.signupId, first.signupId)
    assert.equal(second.checkoutUrl, first.checkoutUrl)
    assert.equal(second.replayed, true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('reusing an attempt key with DIFFERENT details is refused rather than silently answered', async () => {
  const { directory, store } = tempStore()
  try {
    const provider = fakeProvider()
    const api = service({ store, provider })
    await api.signup(GOOD)
    await assert.rejects(() => api.signup({ ...GOOD, planId: 'team', seats: 3 }), /reused an idempotency key with different details/)
    assert.equal(provider.seen.length, 1)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('an address with an ACTIVE subscription is not sold a second one', async () => {
  const { directory, store } = tempStore()
  try {
    const state = store.read()
    state.accounts[accountKey('buyer@example.com')] = { email: 'buyer@example.com', status: 'active', paidUntilMs: 4102444800000 }
    store.write(state)
    const provider = fakeProvider()
    await assert.rejects(
      () => service({ store, provider }).signup(GOOD),
      error => error.state === 'already-subscribed' && /not been charged again/.test(error.reason)
    )
    assert.equal(provider.seen.length, 0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('the address match is case-insensitive -- two rows for one human is how somebody pays twice', async () => {
  const { directory, store } = tempStore()
  try {
    const state = store.read()
    state.accounts[accountKey('Buyer@Example.COM')] = { email: 'Buyer@Example.COM', status: 'active', paidUntilMs: 4102444800000 }
    store.write(state)
    await assert.rejects(() => service({ store }).signup({ ...GOOD, email: 'BUYER@example.com' }), error => error.state === 'already-subscribed')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('an account record this service cannot interpret is treated as SUBSCRIBED, not as new', () => {
  assert.equal(accountSubscriptionState({ status: 'wat' }, 0).state, 'unreadable')
  assert.equal(accountSubscriptionState({}, 0).state, 'unreadable')
  assert.equal(accountSubscriptionState(null, 0).state, 'new')
  assert.equal(accountSubscriptionState(undefined, 0).state, 'new')
})

test('an unreadable account record refuses the signup and says a person will look at it', async () => {
  const { directory, store } = tempStore()
  try {
    const state = store.read()
    state.accounts[accountKey('buyer@example.com')] = { email: 'buyer@example.com', status: 'something-else' }
    store.write(state)
    await assert.rejects(() => service({ store }).signup(GOOD), error => error.state === 'already-subscribed' && /cannot read/.test(error.reason))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('an ACTIVE subscription whose paid period has passed is lapsed, and can resubscribe', async () => {
  const { directory, store } = tempStore()
  try {
    const state = store.read()
    state.accounts[accountKey('buyer@example.com')] = { email: 'buyer@example.com', status: 'active', paidUntilMs: 1000, pairId: 'pair_keepme' }
    store.write(state)
    const provider = fakeProvider()
    const reply = await service({ store, provider, now: () => 2000 }).signup(GOOD)
    assert.equal(reply.ok, true)
    assert.match(reply.reason, /previous subscription had ended/)
    assert.match(reply.reason, /data was never touched/)
    // the SAME pair id is reused, so a renewing customer's machines stay paired
    assert.equal(provider.seen[0].metadata.toolsenabled_pair_id, 'pair_keepme')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('starting a checkout records the account as PENDING, never as active', async () => {
  const { directory, store } = tempStore()
  try {
    const reply = await service({ store }).signup(GOOD)
    const record = store.read().accounts[accountKey('buyer@example.com')]
    assert.equal(record.status, 'pending')
    assert.equal(record.lastSignupId, reply.signupId)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a provider failure records NOTHING -- no half-written account, no orphan signup', async () => {
  const { directory, store } = tempStore()
  try {
    const provider = fakeProvider({ throw: new SignupRefusal('declined', 'The card was declined.', { status: 402 }) })
    await assert.rejects(() => service({ store, provider }).signup(GOOD), error => error.state === 'declined')
    const state = store.read()
    assert.deepEqual(state.accounts, {})
    assert.deepEqual(state.attempts, {})
    assert.deepEqual(state.signups, {})
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

// ===========================================================================
// The ledger
// ===========================================================================

test('a corrupt ledger is refused, never quietly replaced with an empty one', () => {
  const { directory, store } = tempStore()
  try {
    writeFileSync(store.file, '{ not json', 'utf8')
    assert.throws(() => store.read(), /refusing to overwrite it/)
    writeFileSync(store.file, JSON.stringify({ accounts: {} }), 'utf8')
    assert.throws(() => store.read(), /unrecognised shape/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('an absent ledger is an empty one, and the file is written 0600', async () => {
  const { directory, store } = tempStore()
  try {
    assert.equal(existsSync(store.file), false)
    assert.deepEqual(store.read().accounts, {})
    await service({ store }).signup(GOOD)
    assert.ok(existsSync(store.file))
    assert.match(readFileSync(store.file, 'utf8'), /buyer@example\.com/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

// ===========================================================================
// Status
// ===========================================================================

test('a signup id this service never issued is refused, not answered optimistically', () => {
  const { directory, store } = tempStore()
  try {
    const result = service({ store }).status('sub_madeup')
    assert.equal(result.ok, false)
    assert.match(result.reason, /not one this service issued/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('an expired checkout is reported as expired, with nothing charged', async () => {
  const { directory, store } = tempStore()
  try {
    let clock = 1_000_000
    const api = service({ store, now: () => clock })
    const reply = await api.signup(GOOD)
    assert.equal(api.status(reply.signupId).ok, true)
    clock += 31 * 60 * 1000
    const later = api.status(reply.signupId)
    assert.equal(later.ok, false)
    assert.match(later.reason, /expired/)
    assert.match(later.reason, /nothing was charged/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

// ===========================================================================
// One end-to-end run over a real socket, against the local provider double
// ===========================================================================

test('listen rejects when its socket cannot be bound instead of throwing an unhandled error', async () => {
  const occupied = createServer()
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = occupied.address()
    await assert.rejects(
      () => listen({ handler: (_request, response) => response.end(), port }),
      error => error?.code === 'EADDRINUSE'
    )
  } finally {
    await new Promise(resolve => occupied.close(resolve))
  }
})

test('end to end over loopback: a signup produces a test-mode session carrying the required metadata', async () => {
  const { directory, store } = tempStore()
  const double = createProviderDouble()
  try {
    const origin = await double.listen(0)
    const provider = createCheckoutProvider({ mode: 'test', secretKey: 'sk_test_abcdefghijkl', apiBase: origin })
    const reply = await service({ store, provider }).signup(GOOD)
    assert.equal(reply.ok, true)
    assert.equal(reply.testMode, true)
    assert.match(reply.checkoutUrl, /\/hosted\/cs_test_/)

    const session = [...double.sessions.values()][0]
    assert.equal(session.livemode, false)
    assert.equal(session.metadata.toolsenabled_tier, 'operator')
    assert.match(session.metadata.toolsenabled_pair_id, /^pair_/)
  } finally {
    await double.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('end to end over loopback: a declined card is a decline, and nothing is recorded', async () => {
  const { directory, store } = tempStore()
  const double = createProviderDouble()
  try {
    const origin = await double.listen(0)
    const provider = createCheckoutProvider({ mode: 'test', secretKey: 'sk_test_abcdefghijkl', apiBase: origin })
    await assert.rejects(
      () => service({ store, provider }).signup({ ...GOOD, email: 'card_declined@example.com' }),
      error => error.state === 'declined' && /Nothing was charged/.test(error.reason)
    )
    assert.deepEqual(store.read().signups, {})
  } finally {
    await double.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('end to end over loopback: a provider outage is an unavailable refusal, not a checkout', async () => {
  const { directory, store } = tempStore()
  const double = createProviderDouble()
  try {
    const origin = await double.listen(0)
    const provider = createCheckoutProvider({ mode: 'test', secretKey: 'sk_test_abcdefghijkl', apiBase: origin })
    await assert.rejects(
      () => service({ store, provider }).signup({ ...GOOD, email: 'outage@example.com' }),
      error => error.state === 'unavailable'
    )
  } finally {
    await double.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
