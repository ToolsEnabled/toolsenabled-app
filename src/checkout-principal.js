// WHO IS CONFIRMING, and the two separate questions behind that.
//
// The owner's constraint, verbatim: "if i am not logged in as a real user with
// my vault and such attached correctly i refuse to finish the form. it must be
// correct and secure and safe."
//
// That sentence contains TWO conditions and they are kept apart all the way
// down this file, because they have different owners, different failure modes
// and different fixes:
//
//   1. Logged in as a real user  -- answered by window.mcAccount, which
//      product-login-build owns. Real, live, and checked here.
//   2. Vault attached correctly  -- NOT answered by anything in this build.
//      product-login-build explicitly refused to put a `vaultVerified` boolean
//      on the account object, and was right to: a module that has never looked
//      at the vault cannot report on it, and a hardcoded true would be a vault
//      claim with nothing behind it. So this build cannot verify condition 2,
//      and the screen says exactly that rather than letting a green "signed in"
//      badge imply both.
//
// WHAT SIGNING IN HERE IS, AND IS NOT. It names the person on the record and
// gates the action. It is not an attestation: there is no server, and someone
// already signed in to Windows as this user can remove the account and make a
// new one. The surface must not let a sign-in read as more than attribution.
//
// AND THE LIMIT THIS MODULE CANNOT FIX, stated because it would otherwise be
// implied away: the decision record this gate protects is composed and stored
// IN THE RENDERER. That makes it a durable note of what he chose, for him. It
// is not an audit record and this lane does not call it one -- an identity a
// page can choose is not an identity, and anything with devtools could write a
// different name into localStorage. The gate below is a real guard against the
// ordinary case (nobody is signed in, so nothing gets recorded in his name by
// whoever is sitting at the machine). It is not evidence, and the screen says
// so where the record is shown.
//
// EVERY UNKNOWN IS A REFUSAL. There is no branch here that returns an approver
// from a missing, malformed, slow or throwing source.

import { readAccountState } from './account-state.js'
import { currentDataSource } from './data-source.js'

const CALL_TIMEOUT_MS = 5_000

/**
 * The vault half of the owner's condition, answered honestly.
 *
 * KEPT, and no longer the only answer. This is what condition 2 resolves to
 * when nothing checked: a build with no vault channel, a page outside the
 * installed application, a shell that did not reply. It is a stated absence of
 * knowledge, not a finding, and it must never be dressed up as one.
 */
export const VAULT_VERIFICATION_UNAVAILABLE = Object.freeze({
  verified: false,
  checked: false,
  code: 'VAULT_VERIFICATION_UNAVAILABLE',
  summary: 'Signing in names you on this record. It does not check your vault.',
  detail: 'This build has no way to verify that the vault is attached and protected, so it does not claim to have checked. An approval is only ever as strong as the vault underneath it. Nothing here reads, writes or unlocks the vault.',
})

/* Preserve the shell's closed failure class through the checkout condition.
 * The old single VAULT_UNREADABLE code erased the difference between a store
 * that refused a read, a child that timed out, missing local tooling, and a
 * probe that stopped without answering. Never carry an arbitrary renderer
 * string into a recorded approval: only codes this shell owns are admitted. */
const VAULT_UNKNOWN_CODES = new Set([
  'VAULT_KEY_INVALID',
  'VAULT_PROBE_FAILED',
  'VAULT_TIMEOUT',
  'VAULT_TOOLING_ABSENT',
  'VAULT_TOOLING_UNAVAILABLE',
  'VAULT_UNREADABLE',
])

function vaultUnknownCode(payment) {
  return VAULT_UNKNOWN_CODES.has(payment?.code) ? payment.code : 'VAULT_UNREADABLE'
}

/* CONDITION 2, ANSWERED. What "vault attached correctly" can and cannot mean.
 *
 * The owner's refusal condition was: "if i am not logged in as a real user with
 * my vault and such attached correctly i refuse to finish the form."
 *
 * WHAT IS NOW CHECKABLE, and it is a real check and not a boolean somebody
 * typed: this account has a payment method ATTACHED -- a binding this product
 * wrote, naming a vault record -- and the installation's own vault was asked,
 * through a presence-only verb that reads no content, whether that record is on
 * file. Both halves are measured at the moment the screen is drawn.
 *
 * WHAT IS STILL NOT CHECKABLE, stated rather than implied away: nothing here
 * proves the vault is CORRECTLY protected. It does not read an ACL, it does not
 * attest to anything, and a same-user process on this computer can read
 * whatever DPAPI will decrypt for it -- which is a property of running as this
 * Windows user and not something a checkout screen can fix. So "verified" below
 * means exactly "a payment method is attached to you and this installation can
 * see the record", and the summary says that in those words.
 *
 * THE THIRD ANSWER IS PRESERVED ALL THE WAY THROUGH. A vault that could not be
 * read is UNKNOWN, never "no vault". The whole reason this replaced a frozen
 * constant is that a fixed answer cannot tell those apart either.
 */
export function vaultConditionFrom(payment, { viaRelay = false } = {}) {
  if (!payment || typeof payment !== 'object' || payment.ok !== true) return VAULT_VERIFICATION_UNAVAILABLE
  if (payment.attached !== true) {
    return Object.freeze({
      verified: false,
      checked: true,
      code: 'VAULT_NO_PAYMENT_METHOD',
      summary: 'No payment method is attached to your account.',
      detail: 'Your vault was reachable and no card is attached to this account, so there is nothing for an approval to draw on. Attaching one is not a payment.',
    })
  }
  if (payment.checked !== true) {
    return Object.freeze({
      verified: false,
      checked: false,
      code: vaultUnknownCode(payment),
      summary: 'Your vault could not be read just now, so this was not checked.',
      detail: viaRelay
        ? 'A payment method is attached to your account. The computer you are driving could not read its vault to confirm the record is there, and could-not-check is deliberately not reported as not-there. Nothing has been recorded.'
        : 'A payment method is attached to your account. This computer could not read its vault to confirm the record is there, and could-not-check is deliberately not reported as not-there. Nothing has been recorded.',
    })
  }
  if (payment.present !== true) {
    return Object.freeze({
      verified: false,
      checked: true,
      code: 'VAULT_RECORD_NOT_HERE',
      summary: viaRelay
        ? 'Your payment method is attached, but the installation on the computer you are driving does not hold it in its vault.'
        : 'Your payment method is attached, but this installation’s vault does not hold it.',
      detail: viaRelay
        ? 'The record was entered somewhere other than the vault on the computer you are driving, so the copy there cannot use it. That is not the same as having no card, and this screen will not claim you have none.'
        : 'The record was entered somewhere other than this installation’s own vault, so this copy cannot use it. That is not the same as having no card, and this screen will not claim you have none.',
    })
  }
  return Object.freeze({
    verified: true,
    checked: true,
    code: 'VAULT_PAYMENT_METHOD_PRESENT',
    summary: viaRelay
      ? 'A payment method is attached to you and the installation on the computer you are driving can see the record.'
      : 'A payment method is attached to you and this installation can see the record.',
    detail: viaRelay
      ? 'Checked when this screen was drawn: a card is attached to your account. The vault on the computer you are driving holds that record, encrypted by Windows. Nothing read its contents. This says the vault is ATTACHED. It is not an attestation that it is correctly protected. No screen in a program running as the Windows account on that computer can honestly claim that.'
      : 'Checked when this screen was drawn: a card is attached to your account and this installation’s vault holds that record, encrypted by Windows. Nothing read its contents. This says the vault is ATTACHED — it is not an attestation that it is correctly protected, which no screen in a program running as your own Windows account can honestly claim.',
  })
}

function refusal(code, reason, detail, { canSignIn = false } = {}) {
  return Object.freeze({ ok: false, code, reason, detail, canSignIn })
}

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { setTimeout(() => reject(new Error('timeout')), CALL_TIMEOUT_MS) }),
  ])
}

function boundedString(value, maximum = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum ? value : null
}

/**
 * Decide, from the two shell replies, whether a decision may be recorded and
 * against whom.
 *
 * Exported separately from the call so the whole decision table is testable
 * without a shell: every one of these branches is a refusal that a person will
 * read on a checkout screen, and the wording of a refusal is part of it working.
 */
export function approvalIdentityFrom(availability, current, payment = null, { viaRelay = false } = {}) {
  // Their normalizer, not a second opinion. It already fails closed on every
  // malformed shape, and duplicating that judgement here is how two modules
  // start disagreeing about who is signed in.
  const state = readAccountState(availability, current)

  if (!state.available) {
    return refusal(
      state.code || 'MC_ACCOUNT_UNAVAILABLE',
      state.reason || 'This copy cannot read its accounts, so there is nobody to record a decision against.',
      'Confirming is unavailable rather than anonymous. Nothing has been recorded.',
    )
  }
  if (!state.signedIn) {
    return refusal(
      'MC_ACCOUNT_SIGNED_OUT',
      'You are not signed in, so this decision would be recorded against nobody.',
      state.accountCount > 0
        ? 'Sign in from Settings, then come back to this page. Nothing has been recorded and your choices are still here.'
        : viaRelay
          ? 'There is no account on the computer you are driving yet. Create one from Settings, then come back. Nothing has been recorded and your choices are still here.'
          : 'There is no account on this computer yet. Create one from Settings, then come back. Nothing has been recorded and your choices are still here.',
      { canSignIn: true },
    )
  }

  // Signed in. The id is what goes in the record: product-login-build's rule is
  // that the id is stable across a display-name change and the username is not,
  // so a record keyed on the username would silently re-attribute itself.
  const id = boundedString(current?.account?.id)
  if (!id) {
    return refusal(
      'MC_ACCOUNT_ID_MISSING',
      'The application reported someone signed in but did not say which account.',
      'A decision that names nobody in particular is exactly what this gate exists to prevent. Nothing has been recorded.',
    )
  }

  return Object.freeze({
    ok: true,
    principal: Object.freeze({
      id,
      displayName: state.displayName || state.username,
      username: state.username,
      // Carried so the confirmed record states, in its own words, what the
      // vault half of the owner's condition actually resolved to. A record that
      // silently omitted this would read as though both halves had passed.
      //
      // With no payment reply this is still VAULT_VERIFICATION_UNAVAILABLE --
      // the same stated absence of knowledge it always was. The difference is
      // that a build which CAN check now says so, and says which of the four
      // answers it got, instead of every machine reading the one frozen
      // sentence whether or not it was true there.
      vault: vaultConditionFrom(payment, { viaRelay }),
    }),
  })
}

/**
 * Ask the shell who is signed in. Never throws.
 *
 * The timeout matters: without it a hung shell leaves the confirm button
 * pending forever, and a gate that appears broken is a gate somebody removes.
 */
export async function readApprovalIdentity(scope = typeof window === 'undefined' ? undefined : window) {
  const viaRelay = currentDataSource() === 'relay'
  const bridge = scope?.mcAccount
  if (!bridge || typeof bridge.current !== 'function' || typeof bridge.availability !== 'function') {
    return refusal(
      'MC_ACCOUNT_SHELL_ABSENT',
      'This page is running in a browser rather than the installed application, so there is no account to sign in to.',
      'Confirming is unavailable here. Everything else on this page works normally, and your choices are saved.',
    )
  }
  let availability = null
  let current = null
  try {
    availability = await withTimeout(bridge.availability())
  } catch (error) {
    return refusal(
      'MC_ACCOUNT_READ_FAILED',
      error?.message === 'timeout'
        ? 'The application did not answer in time about who is signed in.'
        : viaRelay
          ? 'The application did not report whether the computer you are driving holds an account.'
          : 'The application did not report whether this computer holds an account.',
      'Confirming is unavailable rather than assumed. Nothing has been recorded.',
    )
  }
  try {
    current = await withTimeout(bridge.current())
  } catch {
    current = null
  }
  /* Condition 2, asked of the shell. A build without the channel, a shell that
     does not answer, or a call that hangs all leave `payment` null, which
     resolves to the stated "not checked" -- never to a silent pass. The timeout
     matters here for the same reason it does above: this one spawns a program
     to read the vault, so a hung shell would otherwise hang the confirm. */
  let payment = null
  if (typeof bridge.paymentPresence === 'function') {
    try { payment = await withTimeout(bridge.paymentPresence()) } catch { payment = null }
  }
  return approvalIdentityFrom(availability, current, payment, { viaRelay })
}
