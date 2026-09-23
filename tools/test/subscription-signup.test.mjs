// EVERY PATH A PERSON CAN TAKE THROUGH "I WANT TO PAY YOU".
//
// The states here are the ones a customer actually hits: already subscribed,
// lapsed, declined, refused, offline, the back button, and the double press.
// Each of them is driven, because an unhappy path that has never run is a
// guess, and on this page a guess costs somebody money or a subscription.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SIGNUP_STATES,
  billingPeriodsFor,
  createSignupFlow,
  emailProblem,
  priceFor,
  seatsProblem,
} from '../../src/subscription-signup.js'

const OPERATOR = { id: 'operator', label: 'Operator Cloud', monthlyUsd: 19, annualUsd: 190, seatMinimum: null }
const TEAM = { id: 'team', label: 'Team', monthlyUsd: 299, annualUsd: null, seatMinimum: 3 }

function flowWith(reply, { isOnline = () => true } = {}) {
  const calls = []
  const flow = createSignupFlow({
    submit: async (request) => {
      calls.push(request)
      return typeof reply === 'function' ? reply(request, calls.length) : reply
    },
    isOnline,
  })
  flow.catalogResolved({ ok: true, catalog: {} })
  flow.setField('email', 'buyer@example.com')
  flow.setField('planId', 'operator')
  return { flow, calls }
}

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

test('an empty address is refused before a round trip', () => {
  assert.match(emailProblem(''), /Enter the email/)
  assert.match(emailProblem('   '), /Enter the email/)
  assert.match(emailProblem(null), /Enter the email/)
})

test('the address check is shallow on purpose and accepts real addresses', () => {
  for (const address of ['a@b.co', 'first.last+tag@sub.example.co.uk', "o'brien@example.com", 'ünïcode@exämple.de']) {
    assert.equal(emailProblem(address), null, `${address} must be accepted`)
  }
})

test('the address check refuses only what is certainly wrong', () => {
  assert.match(emailProblem('nope'), /needs one @/)
  assert.match(emailProblem('a@@b.com'), /needs one @/)
  assert.match(emailProblem('a@b'), /needs a dot/)
  assert.match(emailProblem('a b@c.com'), /cannot contain spaces/)
  assert.match(emailProblem(`${'x'.repeat(250)}@example.com`), /too long/)
})

test('seats are checked against the plan minimum, and absence is a refusal not a default', () => {
  assert.equal(seatsProblem(OPERATOR, ''), null, 'a plan with no minimum is not seat-based')
  assert.match(seatsProblem(TEAM, ''), /starts at 3 seats/)
  assert.match(seatsProblem(TEAM, '2'), /starts at 3 seats/)
  assert.match(seatsProblem(TEAM, '2.5'), /whole number/)
  assert.equal(seatsProblem(TEAM, '3'), null)
})

test('a plan only offers the periods the model priced', () => {
  assert.deepEqual(billingPeriodsFor(OPERATOR), ['monthly', 'annual'])
  assert.deepEqual(billingPeriodsFor(TEAM), ['monthly'])
  assert.equal(priceFor(TEAM, 'annual'), null)
  assert.equal(priceFor(OPERATOR, 'annual'), 190)
})

// ---------------------------------------------------------------------------
// The catalog gate
// ---------------------------------------------------------------------------

test('a catalog that failed closed leaves the flow unable to submit', () => {
  const flow = createSignupFlow({ submit: async () => { throw new Error('must not be called') } })
  const snapshot = flow.catalogResolved({ ok: false, reason: 'the plan catalog responded 404' })
  assert.equal(snapshot.state, 'unavailable')
  assert.equal(snapshot.canSubmit, false)
  assert.match(snapshot.detail.reason, /404/)
})

test('every state the flow can report is one it declares', async () => {
  const { flow } = flowWith({ ok: false, state: 'declined', reason: 'card declined' })
  await flow.submitAttempt(OPERATOR)
  assert.ok(SIGNUP_STATES.includes(flow.snapshot.state))
})

// ---------------------------------------------------------------------------
// The happy path, and the states around it
// ---------------------------------------------------------------------------

test('a good submit reaches checkout and carries the payment link', async () => {
  const { flow, calls } = flowWith({ ok: true, state: 'checkout', checkoutUrl: 'https://pay.example/cs_test_1', signupId: 'sub_1', testMode: true })
  await flow.submitAttempt(OPERATOR)
  assert.equal(flow.snapshot.state, 'checkout')
  assert.equal(flow.snapshot.detail.checkoutUrl, 'https://pay.example/cs_test_1')
  assert.equal(flow.snapshot.detail.testMode, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].email, 'buyer@example.com')
})

test('an "ok" reply with no way to pay is NOT a success', async () => {
  const { flow } = flowWith({ ok: true, state: 'checkout' })
  await flow.submitAttempt(OPERATOR)
  assert.equal(flow.snapshot.state, 'refused')
  assert.match(flow.snapshot.detail.reason, /no way to pay/)
})

test('a reply naming a state this build does not know is refused, never assumed good', async () => {
  const { flow } = flowWith({ ok: false, state: 'partially-subscribed', reason: 'x' })
  await flow.submitAttempt(OPERATOR)
  assert.equal(flow.snapshot.state, 'refused')
  assert.match(flow.snapshot.detail.reason, /does not recognise/)
})

test('a reply that is not an object at all is refused', async () => {
  for (const rubbish of [null, undefined, 'ok', 42, []]) {
    const { flow } = flowWith(rubbish)
    await flow.submitAttempt(OPERATOR)
    assert.equal(flow.snapshot.state, 'refused', `${JSON.stringify(rubbish)} must refuse`)
  }
})

test('a refusal with no reason still says something, and still says nothing was started', async () => {
  const { flow } = flowWith({ ok: false, state: 'refused' })
  await flow.submitAttempt(OPERATOR)
  assert.match(flow.snapshot.detail.reason, /without saying why/)
  assert.match(flow.snapshot.detail.reason, /nothing was started/)
})

// ---------------------------------------------------------------------------
// Already subscribed, lapsed, declined
// ---------------------------------------------------------------------------

test('already subscribed is terminal for that address and cannot be re-submitted', async () => {
  const { flow, calls } = flowWith({ ok: false, state: 'already-subscribed', reason: 'This address already has an active subscription.', manageUrl: 'https://x/#/account' })
  await flow.submitAttempt(OPERATOR)
  assert.equal(flow.snapshot.state, 'already-subscribed')
  assert.equal(flow.snapshot.canSubmit, false)
  assert.equal(flow.snapshot.detail.manageUrl, 'https://x/#/account')
  await flow.submitAttempt(OPERATOR)
  assert.equal(calls.length, 1, 'a second attempt for a known subscriber must not reach the service')
})

test('changing the ADDRESS clears already-subscribed; changing the plan does not', async () => {
  const { flow } = flowWith({ ok: false, state: 'already-subscribed', reason: 'known' })
  await flow.submitAttempt(OPERATOR)
  flow.setField('planId', 'team')
  assert.equal(flow.snapshot.state, 'already-subscribed', 'it is a fact about the address, not the plan')
  flow.setField('email', 'someone-else@example.com')
  assert.equal(flow.snapshot.state, 'ready')
})

test('a lapsed subscription is reported as such and can be retried after an edit', async () => {
  const { flow } = flowWith({ ok: false, state: 'lapsed', reason: 'Your subscription ended on the 3rd.' })
  await flow.submitAttempt(OPERATOR)
  assert.equal(flow.snapshot.state, 'lapsed')
  assert.equal(flow.snapshot.canSubmit, true, 'a lapsed customer must be able to resubscribe')
  flow.setField('planId', 'operator2')
  assert.equal(flow.snapshot.state, 'ready')
})

test('a decline is reported as a decline, not as a generic failure', async () => {
  const { flow } = flowWith({ ok: false, state: 'declined', reason: 'The card was declined. Nothing was charged.' })
  await flow.submitAttempt(OPERATOR)
  assert.equal(flow.snapshot.state, 'declined')
  assert.match(flow.snapshot.detail.reason, /Nothing was charged/)
  assert.equal(flow.snapshot.canSubmit, true, 'a declined card is retryable')
})

// ---------------------------------------------------------------------------
// Offline, and the transport failing
// ---------------------------------------------------------------------------

test('an offline device never sends the request', async () => {
  const { flow, calls } = flowWith({ ok: true, state: 'checkout', checkoutUrl: 'x' }, { isOnline: () => false })
  await flow.submitAttempt(OPERATOR)
  assert.equal(flow.snapshot.state, 'offline')
  assert.equal(calls.length, 0)
  assert.match(flow.snapshot.detail.reason, /nothing was charged/i)
})

test('a thrown transport error becomes offline, not an unhandled rejection', async () => {
  const flow = createSignupFlow({ submit: async () => { throw new Error('ECONNREFUSED') } })
  flow.catalogResolved({ ok: true, catalog: {} })
  flow.setField('email', 'buyer@example.com')
  flow.setField('planId', 'operator')
  const snapshot = await flow.submitAttempt(OPERATOR)
  assert.equal(snapshot.state, 'offline')
  assert.match(snapshot.detail.reason, /ECONNREFUSED/)
  assert.equal(snapshot.busy, false, 'the spinner must not be left running')
})

// ---------------------------------------------------------------------------
// The double press and the back button
// ---------------------------------------------------------------------------

test('two presses in flight produce ONE request', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const calls = []
  const flow = createSignupFlow({
    submit: async (request) => { calls.push(request); await gate; return { ok: true, state: 'checkout', checkoutUrl: 'x' } },
  })
  flow.catalogResolved({ ok: true, catalog: {} })
  flow.setField('email', 'buyer@example.com')
  flow.setField('planId', 'operator')

  const first = flow.submitAttempt(OPERATOR)
  const second = flow.submitAttempt(OPERATOR)     // the second press, mid-flight
  release()
  await Promise.all([first, second])
  assert.equal(calls.length, 1, 'the second press must not reach the service')
})

test('a retry of the SAME attempt reuses the idempotency key; an edited attempt does not', async () => {
  const keys = []
  const flow = createSignupFlow({
    submit: async (request) => { keys.push(request.idempotencyKey); return { ok: false, state: 'refused', reason: 'try again' } },
  })
  flow.catalogResolved({ ok: true, catalog: {} })
  flow.setField('email', 'buyer@example.com')
  flow.setField('planId', 'operator')

  await flow.submitAttempt(OPERATOR)
  await flow.submitAttempt(OPERATOR)
  assert.equal(keys.length, 2)
  assert.equal(keys[0], keys[1], 'a plain retry is the same attempt and must carry the same key')

  flow.setField('email', 'corrected@example.com')
  await flow.submitAttempt(OPERATOR)
  assert.equal(keys.length, 3)
  assert.notEqual(keys[2], keys[0], 'a corrected field is a NEW attempt and must not be deduplicated away')
})

test('an idempotency key does not carry the customer address into provider logs', async () => {
  const keys = []
  const flow = createSignupFlow({
    submit: async (request) => { keys.push(request.idempotencyKey); return { ok: false, state: 'refused', reason: 'x' } },
  })
  flow.catalogResolved({ ok: true, catalog: {} })
  flow.setField('email', 'private.person@example.com')
  flow.setField('planId', 'operator')
  await flow.submitAttempt(OPERATOR)
  assert.equal(keys.length, 1)
  assert.ok(!keys[0].includes('private.person'))
  assert.ok(!keys[0].includes('example.com'))
})

test('coming back from the provider re-enables the form and never re-submits', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const calls = []
  const flow = createSignupFlow({
    submit: async (request) => { calls.push(request); await gate; return { ok: true, state: 'checkout', checkoutUrl: 'x' } },
  })
  flow.catalogResolved({ ok: true, catalog: {} })
  flow.setField('email', 'buyer@example.com')
  flow.setField('planId', 'operator')
  const pending = flow.submitAttempt(OPERATOR)
  assert.equal(flow.snapshot.canSubmit, false, 'submitting: the button is off')

  const restored = flow.restored()                 // the bfcache restore
  assert.equal(restored.state, 'ready')
  assert.equal(restored.canSubmit, true, 'a restored page must not leave a form nobody can use')
  assert.match(restored.detail.reason, /nothing was started/i)
  assert.equal(calls.length, 1, 'restoring must never fire a second request')
  release()
  await pending
})

test('a status re-read after returning is what decides the state, not the URL', () => {
  const flow = createSignupFlow({ submit: async () => ({ ok: false, state: 'refused' }) })
  flow.catalogResolved({ ok: true, catalog: {} })
  const snapshot = flow.statusResolved({ ok: true, state: 'checkout', checkoutUrl: 'https://pay/x', testMode: true })
  assert.equal(snapshot.state, 'checkout')
  const gone = flow.statusResolved({ ok: false, state: 'refused', reason: 'That checkout link has expired.' })
  assert.equal(gone.state, 'refused')
  assert.match(gone.detail.reason, /expired/)
})

// ---------------------------------------------------------------------------
// Local validation
// ---------------------------------------------------------------------------

test('local validation refuses before the service is contacted and names the field', async () => {
  const calls = []
  const flow = createSignupFlow({ submit: async (request) => { calls.push(request); return { ok: true, state: 'checkout', checkoutUrl: 'x' } } })
  flow.catalogResolved({ ok: true, catalog: {} })
  flow.setField('planId', 'operator')            // no email
  await flow.submitAttempt(OPERATOR)
  assert.equal(flow.snapshot.state, 'refused')
  assert.equal(flow.snapshot.detail.field, 'email')
  assert.equal(calls.length, 0)
})

test('choosing no plan is refused, and a plan is never chosen for the visitor', async () => {
  const calls = []
  const flow = createSignupFlow({ submit: async (request) => { calls.push(request); return { ok: true, state: 'checkout', checkoutUrl: 'x' } } })
  flow.catalogResolved({ ok: true, catalog: {} })
  flow.setField('email', 'buyer@example.com')
  assert.equal(flow.snapshot.fields.planId, null, 'nothing is pre-selected')
  await flow.submitAttempt(null)
  assert.equal(flow.snapshot.state, 'refused')
  assert.equal(flow.snapshot.detail.field, 'planId')
  assert.equal(calls.length, 0)
})

test('a period the plan does not price is refused locally', async () => {
  const calls = []
  const flow = createSignupFlow({ submit: async (request) => { calls.push(request); return { ok: true, state: 'checkout', checkoutUrl: 'x' } } })
  flow.catalogResolved({ ok: true, catalog: {} })
  flow.setField('email', 'buyer@example.com')
  flow.setField('planId', 'team')
  flow.setField('seats', '3')
  flow.setField('period', 'annual')
  await flow.submitAttempt(TEAM)
  assert.equal(flow.snapshot.state, 'refused')
  assert.equal(flow.snapshot.detail.field, 'period')
  assert.equal(calls.length, 0)
})
