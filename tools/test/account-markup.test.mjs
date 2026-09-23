import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cartMarkup,
  esc,
  expiryText,
  formMarkup,
  googleOptionMarkup,
  screenMarkup,
  setupAccountStepMarkup,
} from '../../src/account-markup.js'

const visibleText = markup => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const signedOut = Object.freeze({
  available: true,
  signedIn: false,
  accountCount: 0,
  canPersistSession: true,
})
test('an existing local Google profile remains available when hosted Google is unavailable', () => {
  const markup=googleOptionMarkup({google:{available:false,reason:'The account service is unavailable.',
    localProfile:{exists:true,available:true,testProvider:{issuer:'https://fixture.invalid/<script>'}}}})
  assert.match(markup,/data-google-signin-start disabled/)
  assert.match(markup,/<button[^>]*data-google-signin-legacy\s*>Open previous profile<\/button>/)
  assert.match(markup,/previous Google sign-in on this computer/)
  assert.match(markup,/test sign-in service/)
  assert.equal(markup.includes('<script>'),false)
  const busy=googleOptionMarkup({google:{available:true,localProfile:{exists:true,available:true}},busy:true})
  assert.match(busy,/data-google-signin-legacy disabled/)
  assert.equal(googleOptionMarkup({google:{available:true}}).includes('data-google-local-profile'),false)
})

test('caller-supplied text is escaped before it enters account markup', () => {
  const hostile = '<img src=x onerror="charge()">&'
  const markup = googleOptionMarkup({
    google: { available: false, code: hostile, reason: hostile },
  })

  assert.doesNotMatch(markup, /<img\b|onerror="charge\(\)"/,
    'provider refusal data became executable account-screen markup')
  assert.match(markup, /&lt;img src=x onerror=&quot;charge\(\)&quot;&gt;&amp;/,
    'provider refusal data was not preserved as escaped, readable text')
  assert.equal(esc(null), '', 'a missing optional value should render as empty text')
})

test('an account-store read failure is not rendered as a definite signed-out answer', () => {
  const reason = 'The protected account store could not be read.'
  const markup = screenMarkup({ state: { available: false, signedIn: false, reason } })
  const text = visibleText(markup)

  assert.match(markup, /role="alert"/, 'an unread account store is not announced as a failure')
  assert.match(text, /no account on this page to sign in to/i,
    'the unread account-store state lost its refusal')
  assert.match(text, /could not be read/i, 'the account-store failure reason was hidden')
  assert.doesNotMatch(markup, /data-account-form=/,
    'an unread account store collapsed into a definite signed-out form')
  assert.match(markup, /data-reset-plan\b/,
    'account-store failure removed the independent local-data removal path')
})

test('an unread purchase list never becomes an empty-list claim', () => {
  const markup = cartMarkup({ cart: { readable: false } })
  const text = visibleText(markup)

  assert.match(markup, /data-cart-state="unread"/,
    'a failed purchase-list read did not reach its unread state')
  assert.match(text, /could not read/i, 'the purchase-list read failure is not disclosed')
  assert.match(text, /not the same as .* empty/i,
    'the refusal no longer distinguishes unknown contents from an empty list')
  assert.doesNotMatch(text, /Nothing is waiting to be bought/i,
    'a failed purchase-list read became a definite empty-list answer')
  assert.match(markup, /href="#\/ledger\?tab=p"/,
    'the purchase-list refusal no longer offers the caller’s retry destination')
})

test('Google refusal explains the unavailable option and names the working alternative once', () => {
  const reason = 'This installed copy has no provider configuration.'
  const text = visibleText(googleOptionMarkup({
    google: { available: false, code: 'NOT_CONFIGURED', reason },
  }))

  assert.match(text, /not available/i, 'the Google refusal no longer says the option is unavailable')
  assert.match(text, /no provider configuration/i, 'the Google refusal dropped the caller-provided reason')
  assert.match(text, /account on this computer/i,
    'the Google refusal no longer points to the working local-account alternative')
  assert.equal((text.match(/account on this computer/gi) || []).length, 1,
    'the Google refusal repeats the local-account alternative')
})

test('the create-account form remains usable and states its account limits', () => {
  const markup = formMarkup({ mode: 'create', state: signedOut })
  const text = visibleText(markup)

  for (const name of ['username', 'displayName', 'password']) {
    assert.match(markup, new RegExp(`name="${name}"`),
      `the create-account form no longer renders its ${name} field`)
  }
  assert.match(markup, /type="submit"/, 'the create-account form has no submit control')
  assert.match(text, /no reset/i, 'the create-account form no longer discloses that passwords cannot be reset')
  assert.match(text, /on this computer/i,
    'the create-account form no longer explains that this is a local account')
})

test('the setup builder preserves caller-owned actions through every read outcome', () => {
  const actions = '<div data-setup-actions><button type="button">Continue</button></div>'
  const states = [
    null,
    { available: false, reason: 'Account storage is unavailable.' },
    { available: true, signedIn: true, displayName: 'A & B' },
    signedOut,
  ]

  for (const accountState of states) {
    const markup = setupAccountStepMarkup({ accountState, actions })
    assert.match(markup, /data-setup-actions/,
      `setup dropped its caller-owned actions for account state ${JSON.stringify(accountState)}`)
  }
  assert.match(setupAccountStepMarkup({ accountState: states[2], actions }), /A &amp; B/,
    'setup did not safely preserve the signed-in display name')
})

/* ---- how long the sign-in has left ---- */

const DAY_MS = 86_400_000
const NOW = Date.parse('2026-09-03T12:00:00.000Z')

/* A SIGN-IN THAT HAS ALREADY RUN OUT MUST NOT SAY IT EXPIRES TODAY.
 *
 * The line ages in place -- the panel repaints and recomputes it against a
 * fresh clock -- and a session lives thirty days, so the instant it lapses
 * arrives while the sentence is on screen. Clamping the remaining interval at
 * zero folded every past instant onto the "less than a day" branch, so a
 * sign-in that ran out last week described itself as a live one. */
test('a sign-in whose time has passed says so instead of promising today', () => {
  for (const [label, at] of [
    ['a week ago', NOW - 7 * DAY_MS],
    ['an hour ago', NOW - 3_600_000],
    ['this instant', NOW],
  ]) {
    const said = expiryText(at, NOW)
    assert.doesNotMatch(said, /expires/,
      `a sign-in that ran out ${label} still tells a person it is going to expire`)
    assert.match(said, /run out/, `a sign-in that ran out ${label} does not say it has`)
    assert.match(said, /sign in again/,
      `a sign-in that ran out ${label} leaves a person with nothing to do about it`)
  }
})

/* A DEADLINE FLOORS. Rounding reported thirty-six hours as two days and twelve
   hours as one, so for twelve hours out of every twenty-four this line promised
   a day that was not there. The only safe error on a deadline is to understate:
   the figure is whole days that really remain. */
test('the days left are days that are really left, never rounded up', () => {
  assert.match(expiryText(NOW + 36 * 3_600_000, NOW), /in 1 day,/,
    'thirty-six hours was reported as two days, so the figure promises time that is not there')
  assert.match(expiryText(NOW + 12 * 3_600_000, NOW), /expires today/,
    'half a day was reported as a whole one')
  assert.match(expiryText(NOW + 29.9 * DAY_MS, NOW), /in 29 days,/,
    'a fraction of a day was rounded up into the figure')
  assert.match(expiryText(NOW + 30 * DAY_MS, NOW), /in 30 days,/,
    'a whole thirty days was not reported as thirty')
  assert.match(expiryText(NOW + DAY_MS, NOW), /in 1 day, /,
    'exactly one day left is not said as one day')
})

/* An unread expiry is not an expiry of zero: the sentence is dropped whole
   rather than filled in with a figure nobody measured. */
test('an expiry this screen was never given prints no sentence at all', () => {
  for (const missing of [null, undefined, Number.NaN, 'soon', 1.5]) {
    assert.equal(expiryText(missing, NOW), '',
      `an unread expiry (${String(missing)}) was rendered as a claim about time`)
  }
})

/* T1366 and T1374: THE FIRST-RUN ACCOUNT STEP NAMES A PLACE THAT EXISTS AND A
   RECORD THAT IS KEPT. The "Shown as" help sent people to Settings "Your
   account", which no Settings row or category is called; the name is changed
   on the Account page. And the step promised that the record of what the
   assistant does says who asked for it, while a default install keeps no such
   record: Home says activity auditing is off until Signed activity audit is
   turned on. Each promise now names that condition. */
test('the first-run account step points to the Account page and says the record depends on Signed activity audit', () => {
  const create = visibleText(setupAccountStepMarkup({ accountState: signedOut, mode: 'create', actions: '' }))
  assert.match(create, /change it whenever you like afterwards, on your Account page/)
  assert.doesNotMatch(create, /Your account/, 'the help still names a Settings place that does not exist')
  assert.match(create, /Sign in so your choices are kept for you\. While Signed activity audit is on, the record of what your assistant does also says who asked for it\./)
  assert.doesNotMatch(create, /Sign in so the record of what your assistant does says who asked for it/, 'the lead still promises a record a default install does not keep')

  const done = visibleText(setupAccountStepMarkup({ accountState: { available: true, signedIn: true, displayName: 'Josh P' }, actions: '' }))
  assert.match(done, /while Signed activity audit is on, the record of what your assistant does says who asked for it/)
  assert.match(done, /change this later on your Account page/)
  assert.doesNotMatch(done, /From now on, the record of what your assistant does says who asked for it\./)
  assert.doesNotMatch(done, /later in Settings/)
})

test('the signed-in Account page says work is recorded against the account only while Signed activity audit is on', () => {
  const now = Date.UTC(2026, 8, 22)
  for (const state of [
    { available: true, signedIn: true, username: 'local-one', displayName: 'Local One', expiresAtMs: now + 86400000 },
    { available: true, signedIn: true, username: 'g-1', verifiedEmail: 'someone@example.com', signInMethod: 'google', displayName: 'Someone', expiresAtMs: now + 86400000 },
  ]) {
    const page = visibleText(screenMarkup({ state, now }))
    assert.match(page, /While Signed activity audit is on, work your assistant does is recorded against it\./)
    assert.doesNotMatch(page, /\. Work your assistant does is recorded against it\./, 'the page still promises a record without its condition')
  }
})

/* T1520: THE UNAVAILABLE PAGE NAMES A DAMAGED ACCOUNT FILE AND OFFERS THE
   NARROW WAY BACK; OTHER UNAVAILABLE STATES DO NOT OFFER IT. */
test('a damaged account file offers setting it aside, and nothing else unavailable does', () => {
  for (const code of ['ACCOUNT_STORE_CORRUPT', 'ACCOUNT_STORE_UNREADABLE']) {
    const markup = screenMarkup({ state: { available: false, signedIn: false, code, reason: 'The account file on this computer is not readable.' } })
    assert.match(markup, /<button type="button" class="ctl-btn" data-account-set-aside>Set the damaged account file aside<\/button>/)
    assert.match(visibleText(markup), /The account file on this computer is damaged, so its sign-ins are unavailable\./)
    assert.match(visibleText(markup), /Your settings, history and agents are kept\./)
    assert.match(markup, /data-reset-plan/, 'the removal control must still be offered')
  }
  const other = screenMarkup({ state: { available: false, signedIn: false, code: 'MC_ACCOUNT_UNAVAILABLE', reason: 'This page is not the installed application.' } })
  assert.doesNotMatch(other, /data-account-set-aside/, 'a page with no account store offered to set one aside')
})
