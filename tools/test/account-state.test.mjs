import test from 'node:test'
import assert from 'node:assert/strict'

import {
  loadAccountState,
  loadGoogleAvailability,
  readAccountState,
  readPaymentPresence,
} from '../../src/account-state.js'

const READY = Object.freeze({ ok: true, accountCount: 1, canPersistSession: true })
const CURRENT = Object.freeze({
  signedIn: true,
  account: {
    id: '0123456789abcdef0123456789abcdef',
    username: 'person@example.com',
    displayName: 'Person Example',
    signInMethod: 'google',
    email: 'person@example.com',
  },
  session: { expiresAtMs: 1_900_000_000_000 },
})

function bridge(overrides = {}) {
  return {
    availability: async () => READY,
    current: async () => CURRENT,
    signIn: async () => ({ ok: true }),
    ...overrides,
  }
}

test('the account reply used by the views preserves the signed-in identity and session controls', () => {
  const state = readAccountState(READY, CURRENT)

  assert.deepEqual({
    available: state.available,
    signedIn: state.signedIn,
    accountId: state.accountId,
    username: state.username,
    displayName: state.displayName,
    signInMethod: state.signInMethod,
    verifiedEmail: state.verifiedEmail,
    expiresAtMs: state.expiresAtMs,
    canPersistSession: state.canPersistSession,
  }, {
    available: true,
    signedIn: true,
    accountId: '0123456789abcdef0123456789abcdef',
    username: 'person@example.com',
    displayName: 'Person Example',
    signInMethod: 'google',
    verifiedEmail: 'person@example.com',
    expiresAtMs: 1_900_000_000_000,
    canPersistSession: true,
  })
})

test('an unavailable hosted verification cannot carry cached identity or offer another sign-in form', () => {
  const state = readAccountState(READY, { ...CURRENT, ok: false,
    code: 'HOSTED_ACCOUNT_STATUS_UNAVAILABLE', reason: 'private transport diagnostics',
  })
  assert.equal(state.available, false)
  assert.equal(state.signedIn, false)
  assert.equal(state.username, null)
  assert.equal(state.code, 'HOSTED_ACCOUNT_STATUS_UNAVAILABLE')
  assert.match(state.reason, /could not be verified/)
  assert.doesNotMatch(state.reason, /private transport/)
  assert.equal(state.accountCount, 1)
})

test('a failed account-store read stays unavailable and retains the existing-account warning', () => {
  const state = readAccountState({
    ok: false,
    code: 'ACCOUNT_STORE_CORRUPT',
    reason: 'The account store could not be read.',
    accountCount: 2,
  }, CURRENT)

  assert.deepEqual({
    available: state.available,
    signedIn: state.signedIn,
    accountCount: state.accountCount,
    code: state.code,
    reason: state.reason,
  }, {
    available: false,
    signedIn: false,
    accountCount: 2,
    code: 'ACCOUNT_STORE_CORRUPT',
    reason: 'The account store could not be read.',
  })
})

test('a rejected current-account read cannot reuse the available reply as a definite identity', async () => {
  const state = await loadAccountState({ mcAccount: bridge({
    current: async () => { throw new Error('store closed') },
  }) })

  assert.deepEqual({
    available: state.available,
    signedIn: state.signedIn,
    displayName: state.displayName,
  }, {
    available: true,
    signedIn: false,
    displayName: null,
  })
})

test('Google sign-in control state is enabled only on explicit availability and reports why it is disabled', async () => {
  const enabled = await loadGoogleAvailability({ mcAccount: bridge({
    googleAvailability: async () => ({ ok: true, available: true, source: 'google' }),
    googleCancel: async () => ({ ok: true }),
  }) })
  const disabled = await loadGoogleAvailability({ mcAccount: bridge({
    googleAvailability: async () => { throw new Error('channel closed') },
  }) })

  assert.deepEqual({
    available: enabled.available,
    source: enabled.source,
    canCancel: enabled.canCancel,
    reason: enabled.reason,
  }, { available: true, source: 'google', canCancel: true, reason: null })
  assert.deepEqual({
    available: disabled.available,
    code: disabled.code,
    reason: disabled.reason,
  }, {
    available: false,
    code: 'MC_GOOGLE_SIGNIN_READ_FAILED',
    reason: 'The application did not answer whether signing in with Google is available, so it is not offered.',
  })
})
test('the previous-profile control requires its own bridge method even when main reports a stored profile', async () => {
  const reply={ok:false,available:false,localProfile:{exists:true,available:true}}
  const absent=await loadGoogleAvailability({mcAccount:bridge({googleAvailability:async()=>reply})})
  assert.equal(absent.localProfile.available,false)
  const present=await loadGoogleAvailability({mcAccount:bridge({googleAvailability:async()=>reply,googleLocalProfile:async()=>({ok:true})})})
  assert.equal(present.available,false)
  assert.equal(present.localProfile.available,true)
})

test('an unreadable payment-presence reply remains unknown rather than becoming no card', () => {
  const payment = readPaymentPresence({
    ok: false,
    code: 'VAULT_UNREADABLE',
    detail: 'vault read failed',
  })

  assert.deepEqual({
    ok: payment.ok,
    attached: payment.attached,
    present: payment.present,
    checked: payment.checked,
    code: payment.code,
    detail: payment.detail,
  }, {
    ok: false,
    attached: false,
    present: null,
    checked: false,
    code: 'MC_PAYMENT_PRESENCE_UNAVAILABLE',
    detail: 'This copy could not check whether the attached record is in its vault, so whether a card is on file is unknown.',
  })
})
