import test from 'node:test'
import assert from 'node:assert/strict'
import { screenMarkup, setupAccountStepMarkup } from '../../src/account-markup.js'
import { RESET_SUBJECT_HERE, RESET_SUBJECT_REMOTE } from '../../src/account-reset-copy.js'

const signedOut = { available: true, signedIn: false, accountCount: 0, canPersistSession: true }
const states = [
  signedOut,
  { ...signedOut, signedIn: true, username: 'fixture', displayName: 'Fixture' },
  { available: false, signedIn: false, reason: 'Fixture account store unavailable.' },
]
const plan = { available: true, roots: [], untouched: [], conflicts: [], totals: { files: 0, bytes: 0 } }
const actions = '<div data-setup-actions><button data-setup-account-submit>Sign in and continue</button></div>'
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

test('setup email guidance is readable escaped text beside the sign-in controls', () => {
  const html = setupAccountStepMarkup({
    accountState: signedOut, mode: 'sign-in', actions,
    notice: { tone: 'warn', title: 'Sign in with your email', detail: 'Use the sign-in form below. <fixture>&' },
  })
  assert.match(html, /role="alert"/)
  assert.match(text(html), /Sign in with your email/)
  assert.match(text(html), /Use the sign-in form below/)
  assert.doesNotMatch(html, /<fixture>|\[object Object\]|That did not work/)
  assert.match(html, /&lt;fixture&gt;&amp;/)
  assert.match(html, /Email or local account name/)
  assert.match(html, /data-setup-account-field="username"/)
  assert.doesNotMatch(html, /data-setup-account-field="displayName"/)
  assert.match(html, /data-setup-account-submit/)
})

test('setup string refusals retain the existing alert and safe reason', () => {
  const html = setupAccountStepMarkup({
    accountState: signedOut, mode: 'create', actions,
    notice: 'Use at least 12 characters. <fixture>&',
  })
  assert.match(html, /class="fleet-profile-status is-serious" role="alert"/)
  assert.match(html, /<strong>That did not work<\/strong>/)
  assert.match(html, /Use at least 12 characters\. &lt;fixture&gt;&amp;/)
  assert.doesNotMatch(html, /<fixture>/)
  assert.match(html, /data-setup-account-field="displayName"/)
})

test('account reset preview forwards the selected target platform in every account state', () => {
  for (const state of states) {
    for (const subject of [RESET_SUBJECT_HERE, RESET_SUBJECT_REMOTE]) {
      for (const platform of ['win32', 'linux', 'darwin', undefined]) {
        const html = screenMarkup({ state, subject, platform, reset: { phase: 'confirm', plan } })
        assert.match(html, /data-reset-survives/)
        assert.match(text(html), /The program itself/)
        if (platform === 'win32') assert.match(text(html), /Windows Settings/)
        else assert.doesNotMatch(text(html), /Windows Settings/)
        assert.match(html, /data-reset-confirm/, 'platform copy must not remove the existing confirmation control')
      }
    }
  }
})

test('account reset outcome forwards target platform without changing confirmed outcomes', () => {
  const sweep = { ran: true, complete: true, roots: [], revokedSessions: false, revoked: false }
  for (const subject of [RESET_SUBJECT_HERE, RESET_SUBJECT_REMOTE]) {
    for (const platform of ['win32', 'linux', 'darwin', undefined]) {
      const html = screenMarkup({ state: signedOut, subject, platform, reset: { phase: 'done', sweep } })
      assert.match(html, /data-reset-outcome="good"/)
      assert.match(text(html), /It is gone/)
      assert.match(text(html), /program itself is still installed/i)
      if (platform === 'win32') assert.match(text(html), /Windows Settings/)
      else assert.doesNotMatch(text(html), /Windows Settings/)
    }
  }
})

test('an unknown target platform never inherits a reset-record Windows platform', () => {
  const html = screenMarkup({
    state: signedOut, subject: RESET_SUBJECT_REMOTE,
    reset: { phase: 'confirm', plan, platform: 'win32' },
  })
  assert.match(html, /data-reset-survives/)
  assert.doesNotMatch(text(html), /Windows Settings/)
})
