// CONDITION 2, AND THE FOUR ANSWERS IT CAN HAVE.
//
// The owner's refusal condition, verbatim: "if i am not logged in as a real
// user with my vault and such attached correctly i refuse to finish the form."
//
// src/checkout-principal.js kept those as two conditions on purpose, and until
// now the second one had exactly one answer -- a frozen constant,
// VAULT_VERIFICATION_UNAVAILABLE, that every machine got whether or not it was
// true there. That was the honest answer while nothing could check. Something
// can check now, so a fixed answer would have become the dishonest one.
//
// WHAT THESE TESTS ARE FOR. The failure mode of "we can check now" is that the
// check collapses to a boolean and the two unhappy answers -- "attached but not
// in this installation's vault" and "the vault could not be read" -- turn into
// "no card". Both would be false statements about the owner's money on a
// checkout screen, so both get their own test, and the unreadable one is
// asserted NOT to equal the absent one.
//
// NOTHING HERE IS A CARD. The only payment value in this file is the vault key
// NAME, which is what the product stores and all it ever stores.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  VAULT_VERIFICATION_UNAVAILABLE,
  approvalIdentityFrom,
  vaultConditionFrom,
} from '../../src/checkout-principal.js'

const AVAILABLE = Object.freeze({ ok: true, accountCount: 1, canPersistSession: true })
const SIGNED_IN = Object.freeze({
  signedIn: true,
  principal: 'account:0123456789abcdef0123456789abcdef',
  account: Object.freeze({ id: '0123456789abcdef0123456789abcdef', username: 'josh', displayName: 'Josh' }),
  session: Object.freeze({ issuedAtMs: 1, expiresAtMs: 2 ** 40 }),
})

const PRESENT = Object.freeze({ ok: true, attached: true, checked: true, present: true, vaultKey: 'payment_card_default' })
const NOT_HERE = Object.freeze({ ok: true, attached: true, checked: true, present: false, vaultKey: 'payment_card_default' })
const UNREADABLE = Object.freeze({ ok: true, attached: true, checked: false, present: null, vaultKey: 'payment_card_default' })
const NOT_ATTACHED = Object.freeze({ ok: true, attached: false, checked: true, present: false })

test('a card attached AND visible in this installation vault verifies condition 2', () => {
  const answer = vaultConditionFrom(PRESENT)
  assert.equal(answer.verified, true)
  assert.equal(answer.checked, true)
  assert.equal(answer.code, 'VAULT_PAYMENT_METHOD_PRESENT')
  // And it still refuses to overclaim. "Attached" is not "correctly protected",
  // and the copy has to say which one it means.
  assert.match(answer.detail, /not an attestation/i)
})

test('no payment method attached is a stated no, not a stated unknown', () => {
  const answer = vaultConditionFrom(NOT_ATTACHED)
  assert.equal(answer.verified, false)
  assert.equal(answer.checked, true, 'the vault WAS reachable; saying otherwise would be a different claim')
  assert.equal(answer.code, 'VAULT_NO_PAYMENT_METHOD')
})

test('attached but absent from this installation vault is its OWN answer', () => {
  const answer = vaultConditionFrom(NOT_HERE)
  assert.equal(answer.verified, false)
  assert.equal(answer.checked, true)
  assert.equal(answer.code, 'VAULT_RECORD_NOT_HERE')
  assert.notEqual(answer.code, 'VAULT_NO_PAYMENT_METHOD',
    'a record entered into another vault is being reported as "you have no card"')
  assert.match(answer.summary, /this installation/i)
})

// THE ONE A REFACTOR DELETES. `checked: false` is such a natural companion to
// `verified: false` that the two collapse into one branch, and the screen then
// tells him he has no card because a file could not be read.
test('a vault that could not be read is UNKNOWN and never reported as absent', () => {
  const answer = vaultConditionFrom(UNREADABLE)
  assert.equal(answer.verified, false)
  assert.equal(answer.checked, false)
  assert.equal(answer.code, 'VAULT_UNREADABLE')
  assert.notEqual(answer.code, vaultConditionFrom(NOT_ATTACHED).code,
    'could-not-check and has-none now produce the same answer, which is the defect this exists to prevent')
  assert.match(answer.detail, /not reported as not-there|deliberately not/i)
})

test('each shell-side unknown keeps its own closed code through checkout', () => {
  for (const code of [
    'VAULT_KEY_INVALID',
    'VAULT_PROBE_FAILED',
    'VAULT_TIMEOUT',
    'VAULT_TOOLING_ABSENT',
    'VAULT_TOOLING_UNAVAILABLE',
    'VAULT_UNREADABLE',
  ]) {
    const answer = vaultConditionFrom({ ...UNREADABLE, code })
    assert.equal(answer.code, code, `${code} was collapsed into generic unreadable`)
    assert.equal(answer.verified, false)
    assert.equal(answer.checked, false)
  }
  assert.equal(vaultConditionFrom({ ...UNREADABLE, code: 'renderer-chosen' }).code, 'VAULT_UNREADABLE')
})

test('every unrecognised payment reply falls back to the stated unavailable, never to a pass', () => {
  for (const value of [null, undefined, {}, [], 'yes', 42, { ok: false }, { ok: true }, { attached: true }]) {
    const answer = vaultConditionFrom(value)
    assert.equal(answer.verified, false, `${JSON.stringify(value)} produced a verified vault`)
  }
  assert.deepEqual(vaultConditionFrom(null), VAULT_VERIFICATION_UNAVAILABLE)
  assert.equal(VAULT_VERIFICATION_UNAVAILABLE.verified, false)
  assert.equal(VAULT_VERIFICATION_UNAVAILABLE.checked, false)
})

test('the approver carries whichever of the four answers it actually got', () => {
  const verified = approvalIdentityFrom(AVAILABLE, SIGNED_IN, PRESENT)
  assert.equal(verified.ok, true)
  assert.equal(verified.principal.vault.verified, true)
  assert.equal(verified.principal.vault.code, 'VAULT_PAYMENT_METHOD_PRESENT')

  const unreadable = approvalIdentityFrom(AVAILABLE, SIGNED_IN, UNREADABLE)
  assert.equal(unreadable.ok, true, 'an unreadable vault does not stop him being named on the record')
  assert.equal(unreadable.principal.vault.verified, false)
  assert.equal(unreadable.principal.vault.checked, false)

  // A build with no payment channel at all still gets the old, honest answer.
  const legacy = approvalIdentityFrom(AVAILABLE, SIGNED_IN)
  assert.equal(legacy.ok, true)
  assert.deepEqual(legacy.principal.vault, VAULT_VERIFICATION_UNAVAILABLE)
})

test('signed out is still a refusal, whatever the vault says', () => {
  const refused = approvalIdentityFrom(AVAILABLE, { signedIn: false }, PRESENT)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'MC_ACCOUNT_SIGNED_OUT')
  assert.equal(refused.canSignIn, true)
})

test('no answer this module can produce carries anything that could be a card', () => {
  const cardDetail = /\b(?:cardNumber|cvc|cvv|securityCode|expiryMonth|expMonth|lastFour|last4|cardToken|paymentToken)\b/i
  for (const value of [PRESENT, NOT_HERE, UNREADABLE, NOT_ATTACHED, null]) {
    const rendered = JSON.stringify(vaultConditionFrom(value))
    assert.doesNotMatch(rendered, cardDetail)
    assert.doesNotMatch(rendered, /\d{12,19}/)
  }
})
