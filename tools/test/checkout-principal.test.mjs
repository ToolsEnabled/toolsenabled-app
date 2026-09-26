// The checkout view calls readApprovalIdentity() with no arguments and consumes
// ok, canSignIn, reason, detail, and (on success) principal. These tests pin
// that contract at the decision module rather than pinning the view's markup.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  approvalIdentityFrom,
  readApprovalIdentity,
} from '../../src/checkout-principal.js'

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef'
const AVAILABLE = Object.freeze({ ok: true, accountCount: 1, canPersistSession: true })
const SIGNED_IN = Object.freeze({
  signedIn: true,
  account: Object.freeze({ id: ACCOUNT_ID, username: 'real-caller', displayName: 'Real Caller' }),
  session: Object.freeze({ expiresAtMs: 2 ** 40 }),
})

test('an unreadable account source remains a refusal with its own reason', () => {
  const answer = approvalIdentityFrom({
    ok: false,
    code: 'MC_ACCOUNT_READ_FAILED',
    reason: 'The account store could not be read.',
  }, null)

  assert.equal(answer.ok, false, 'an account read failure became an approval')
  assert.equal(answer.code, 'MC_ACCOUNT_READ_FAILED', 'the account read failure lost its code')
  assert.equal(answer.reason, 'The account store could not be read.', 'the account read failure lost its reason')
  assert.equal(answer.canSignIn, false, 'an unavailable sign-in control was presented as usable')
})

test('signed-out callers get an actionable refusal and a usable sign-in control', () => {
  const answer = approvalIdentityFrom(AVAILABLE, { signedIn: false })

  assert.equal(answer.ok, false, 'a signed-out caller was allowed to approve')
  assert.equal(answer.code, 'MC_ACCOUNT_SIGNED_OUT', 'the signed-out refusal lost its named state')
  assert.equal(answer.canSignIn, true, 'the signed-out caller lost the usable sign-in control')
  assert.match(answer.detail, /Sign in from Settings/, 'the usable sign-in control carries no remedy')
})

test('a missing shell disables confirmation and explains why it cannot succeed', async () => {
  const answer = await readApprovalIdentity({})

  assert.equal(answer.ok, false, 'a browser without the account shell was allowed to approve')
  assert.equal(answer.code, 'MC_ACCOUNT_SHELL_ABSENT', 'the missing-shell refusal lost its named state')
  assert.equal(answer.canSignIn, false, 'a sign-in control that cannot succeed was presented as usable')
  assert.match(answer.reason, /browser rather than the installed application/, 'the disabled control lost its reason')
})

test('a signed-in caller is attributed by stable id and its display fields', () => {
  const answer = approvalIdentityFrom(AVAILABLE, SIGNED_IN)

  assert.equal(answer.ok, true, 'a well-formed signed-in caller was refused')
  assert.equal(answer.principal.id, ACCOUNT_ID, 'the approval was attributed without the stable account id')
  assert.equal(answer.principal.displayName, 'Real Caller', 'the approval lost the caller-facing name')
  assert.equal(answer.principal.username, 'real-caller', 'the approval lost the account username')
})

test('a signed-in reply without a stable id cannot create an anonymous approval', () => {
  const answer = approvalIdentityFrom(AVAILABLE, {
    ...SIGNED_IN,
    account: { username: 'real-caller', displayName: 'Real Caller' },
  })

  assert.equal(answer.ok, false, 'a signed-in reply with no stable id was allowed to approve')
  assert.equal(answer.code, 'MC_ACCOUNT_ID_MISSING', 'the missing-id refusal lost its named state')
  assert.match(answer.detail, /names nobody in particular/, 'the missing-id refusal lost its explanation')
})
