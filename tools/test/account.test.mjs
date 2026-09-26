/* The account VIEW, driven through the same accountView({ navigate }) entry point
 * src/main.js uses.  The small document stand-in records the real markup and
 * dispatches the view's own submit handler; it does not reimplement account
 * state or the enabled/disabled decision. */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostedAccountClient } from '../../shell/hosted-account-client.cjs'
import { createHostedAccountController } from '../../shell/hosted-account-controller.cjs'
import { createAccountStore } from '../../shell/product-account.cjs'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const { accountView } = await import('../../src/views/account.js')

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function settle() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve()
}

function accountDocument(fields = {}, { resetFieldsOnPaint = false } = {}) {
  let markup = ''
  let paints = 0
  let focusedName = null
  const liveFields = { ...fields }
  const listeners = new Map()
  const fieldNode = name => ({
    get value() { return liveFields[name] ?? '' },
    set value(value) { liveFields[name] = String(value) },
  })
  const section = {
    get innerHTML() { return markup },
    set innerHTML(value) {
      markup = String(value)
      paints += 1
      if (resetFieldsOnPaint) {
        for (const name of Object.keys(liveFields)) liveFields[name] = ''
        focusedName = null
      }
    },
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type) },
    querySelector(selector) {
      const name = /^\[name="([^"]+)"\]$/.exec(selector)?.[1]
      if (name) return fieldNode(name)
      if (selector === '[data-account-form]:focus-within') return focusedName === null ? null : {}
      return null
    },
    querySelectorAll(selector) {
      return selector === '[data-account-form] input'
        ? Object.keys(liveFields).map(fieldNode)
        : []
    },
  }
  const root = { querySelector: selector => selector === '[data-account-section]' ? section : null }
  const document = {
    createElement(tag) {
      assert.equal(tag, 'template', 'accountView should build its root through a template')
      return {
        set innerHTML(_value) {},
        content: { firstElementChild: root },
      }
    },
  }
  return {
    document,
    markup: () => markup,
    paintCount: () => paints,
    fieldValue: name => liveFields[name] ?? '',
    focus(name) { focusedName = name },
    type(name, value) {
      liveFields[name] = String(value)
      focusedName = name
    },
    submit(kind) {
      const form = { dataset: { accountForm: kind } }
      listeners.get('submit')({
        target: { closest: selector => selector === '[data-account-form]' ? form : null },
        preventDefault() {},
      })
    },
    /* PRESSING A CONTROL, through the view's OWN click listener. The stand-in
       does not know what any selector means; it reports a match for exactly the
       one being pressed, which is what lets the view's real branch chain decide
       what happens. */
    press(selector) {
      const listener = listeners.get('click')
      assert.ok(listener, 'the account view must listen for clicks to be pressable')
      listener({
        target: { closest: candidate => (candidate === selector ? { dataset: {} } : null) },
        preventDefault() {},
      })
    },
  }
}

function signedOutBridge(overrides = {}) {
  return {
    availability: async () => ({ ok: true, accountCount: 1, canPersistSession: true }),
    current: async () => ({ ok: true, signedIn: false }),
    googleAvailability: async () => ({ ok: false, reason: 'Google is unavailable in this fixture.' }),
    signIn: async () => ({ ok: true, persisted: true }),
    ...overrides,
  }
}

async function drive(bridge, fields = {}, localData = undefined, documentOptions = {}) {
  const priorDocument = globalThis.document
  const priorAccount = globalThis.mcAccount
  const priorLocalData = globalThis.mcLocalData
  const standIn = accountDocument(fields, documentOptions)
  globalThis.document = standIn.document
  globalThis.mcAccount = bridge
  if (localData !== undefined) globalThis.mcLocalData = localData
  const view = accountView({ navigate: () => {} })
  await settle()
  return {
    ...standIn,
    view,
    restore() {
      view.destroy()
      if (priorDocument === undefined) delete globalThis.document
      else globalThis.document = priorDocument
      if (priorAccount === undefined) delete globalThis.mcAccount
      else globalThis.mcAccount = priorAccount
      if (priorLocalData === undefined) delete globalThis.mcLocalData
      else globalThis.mcLocalData = priorLocalData
    },
  }
}

for (const refusalStatus of [503, 401]) test(refusalStatus === 503
  ? 'hosted sign-in status failure shows retry without a success notice or another password form, then recovers on a fresh 200'
  : 'a hosted session revoked immediately after sign-in is cleared and never gets a success notice or status retry', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-status-view-'))
  const priorFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('This fixture permits no network') }
  const account = { id: 'hosted-status-fixture', email: 'fixture@example.invalid' }
  let saved = null
  let status = refusalStatus
  let logins = 0
  let reads = 0
  let clears = 0
  const client = createHostedAccountClient({
    sessionStorage: {
      read: () => saved,
      clear() { clears++; saved = null; return true },
      write(value) { saved = value; return true },
    },
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname
      if (route === '/v1/desktop/sessions' && options.method === 'POST') {
        logins++
        return new Response(JSON.stringify({ account }), { status: 200, headers: {
          'set-cookie': `__Host-te_desktop=${'x'.repeat(43)}; Path=/; Secure; HttpOnly; Expires=Thu, 01 Jan 2099 00:00:00 GMT`,
        } })
      }
      assert.equal(route, '/v1/desktop/account')
      assert.equal(options.method, 'GET')
      reads++
      return new Response(JSON.stringify(status === 200 ? { account } : { error: { code: 'UNAVAILABLE' } }), { status })
    },
  })
  const store = createAccountStore({ directory, hostedAccount: client })
  const controller = createHostedAccountController({ client, store })
  let loginResult
  let screen
  const waitFor = async predicate => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve))
    assert.ok(predicate(), 'the real view must finish its pending status read')
  }
  try {
    screen = await drive({
      // An existing installation opens the sign-in form. All authorization
      // and status decisions below use the production client/controller/store.
      availability: async () => ({ ...store.availability(), accountCount: 1 }),
      current: () => controller.current(),
      signIn: async value => { loginResult = await controller.signIn(value); return loginResult },
      googleAvailability: async () => ({ ok: false }),
      googleUrl: async () => ({ ok: false }),
      data: async () => ({ ok: true, settingCount: 0 }),
    }, { username: account.email, password: 'fixture-only-password' })
    screen.submit('sign-in')
    await waitFor(() => loginResult && reads === 1 && !screen.markup().includes('Signing in…'))
    assert.equal(loginResult.ok, true)
    if (refusalStatus === 401) {
      assert.equal(client.hasSession(), false)
      assert.equal(saved, null)
      assert.equal(store.current().signedIn, false)
      assert.match(screen.markup(), /data-account-form="sign-in"/)
      assert.match(screen.markup(), /Sign-in could not be confirmed/)
      assert.doesNotMatch(screen.markup(), /data-account-status-retry|<strong>Signed in\./)
      assert.equal(logins, 1)
      return
    }
    assert.equal(client.hasSession(), true)
    assert.equal(client.verifiedAccount(), null, 'a failed verification grants no cached authority')
    assert.equal(store.current().signedIn, false)
    const held = saved
    const clearedBeforeRetry = clears
    assert.ok(held, 'the saved hosted session must remain available for a status retry')
    assert.match(screen.markup(), /Account status is temporarily unavailable/)
    assert.match(screen.markup(), /data-account-status-retry/)
    assert.doesNotMatch(screen.markup(), /data-account-form=|<strong>Signed in\./)

    status = 200
    screen.press('[data-account-status-retry]')
    await waitFor(() => reads === 2 && screen.markup().includes('data-account-sign-out'))
    assert.equal(store.current().signedIn, true)
    assert.equal(saved, held, 'retry must reuse the existing session, not replace its credential')
    assert.equal(clears, clearedBeforeRetry)
    assert.equal(logins, 1, 'status recovery must not repeat the password sign-in')
    assert.doesNotMatch(screen.markup(), /data-account-status-retry|data-account-form=/)
  } finally {
    screen?.restore()
    globalThis.fetch = priorFetch
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Google completion does not claim success while the confirmed account status is unavailable', async () => {
  let pending = false
  const screen = await drive(signedOutBridge({
    current: async () => pending
      ? { ok: false, code: 'HOSTED_ACCOUNT_STATUS_UNAVAILABLE' }
      : { signedIn: false },
    googleSignIn: async () => { pending = true; return { ok: true, persisted: true } },
    googleUrl: async () => ({ ok: false }),
  }))
  try {
    screen.press('[data-google-signin-start]')
    for (let i = 0; i < 100 && !screen.markup().includes('data-account-status-retry'); i++) await new Promise(resolve => setImmediate(resolve))
    assert.match(screen.markup(), /Account status is temporarily unavailable/)
    assert.doesNotMatch(screen.markup(), /data-account-form=|<strong>Signed in with Google/)
  } finally { screen.restore() }
})

test('a late Google-availability answer does not erase an account form in progress or retain its password', async () => {
  const google = deferred()
  const passwordMarker = 'fixture-password-that-must-stay-in-the-field'
  let submitted = null
  const screen = await drive(signedOutBridge({
    availability: async () => ({ ok: true, accountCount: 0, canPersistSession: true }),
    googleAvailability: () => google.promise,
    create: async request => {
      submitted = {
        username: request.username,
        displayName: request.displayName,
        passwordMatched: request.password === passwordMarker,
      }
      return { ok: false, code: 'FIXTURE_STOP', reason: 'The fixture stops after observing submit.' }
    },
  }), {}, undefined, { resetFieldsOnPaint: true })
  try {
    assert.match(screen.markup(), /data-account-form="create"/, 'the deferred read must leave a create form to type into')
    screen.type('username', 'first-person-standin')
    screen.type('displayName', 'First Person Stand-In')
    screen.type('password', passwordMarker)
    const beforeAnswer = screen.paintCount()

    google.resolve({ ok: false, code: 'FIXTURE_GOOGLE_OFF', reason: 'Google is unavailable in this fixture.' })
    await settle()

    assert.equal(screen.paintCount(), beforeAnswer, 'the late availability answer repainted and replaced the live form')
    assert.equal(screen.fieldValue('username'), 'first-person-standin')
    assert.equal(screen.fieldValue('displayName'), 'First Person Stand-In')
    assert.equal(screen.fieldValue('password'), passwordMarker, 'the password must remain only in its live DOM field until submit')
    assert.doesNotMatch(screen.markup(), new RegExp(passwordMarker), 'a password must never be copied into rendered markup')

    screen.submit('create')
    await settle()
    assert.deepEqual(submitted, {
      username: 'first-person-standin',
      displayName: 'First Person Stand-In',
      passwordMatched: true,
    })
    assert.equal(screen.fieldValue('password'), '', 'the view must not retain the password after submit repaints the form')
    assert.doesNotMatch(screen.markup(), new RegExp(passwordMarker), 'the submitted password must not enter rendered markup')
  } finally { screen.restore() }
})

test('a late Google-availability answer does not replace an empty focused account form', async () => {
  const google = deferred()
  const screen = await drive(signedOutBridge({
    availability: async () => ({ ok: true, accountCount: 0, canPersistSession: true }),
    googleAvailability: () => google.promise,
  }), {}, undefined, { resetFieldsOnPaint: true })
  try {
    screen.focus('username')
    const beforeAnswer = screen.paintCount()
    google.resolve({ ok: false, code: 'FIXTURE_GOOGLE_OFF', reason: 'Google is unavailable in this fixture.' })
    await settle()
    assert.equal(screen.paintCount(), beforeAnswer, 'a focused empty field was replaced before the person typed')
  } finally { screen.restore() }
})

test('a pristine account form still repaints when Google availability settles', async () => {
  const google = deferred()
  const reason = 'The pristine-form positive control received this answer.'
  const screen = await drive(signedOutBridge({
    availability: async () => ({ ok: true, accountCount: 0, canPersistSession: true }),
    googleAvailability: () => google.promise,
  }), {}, undefined, { resetFieldsOnPaint: true })
  try {
    assert.match(screen.markup(), /data-google-state="unknown"/, 'the control must begin with a genuinely pending answer')
    const beforeAnswer = screen.paintCount()
    google.resolve({ ok: false, code: 'FIXTURE_GOOGLE_OFF', reason })
    await settle()
    assert.ok(screen.paintCount() > beforeAnswer, 'the guard suppressed the availability repaint on an untouched form')
    assert.match(screen.markup(), /data-google-state="unavailable"/)
    assert.match(screen.markup(), new RegExp(reason), 'the resolved availability answer did not reach the pristine screen')
  } finally { screen.restore() }
})

function signInSubmitTag(markup) {
  return markup.match(/<button type="submit" class="ctl-btn"[^>]*>(?:Sign in|Working…)<\/button>/)?.[0] ?? null
}

test('a failed account read remains unknown and states why instead of offering a definite answer', async () => {
  const screen = await drive(signedOutBridge({
    availability: async () => { throw new Error('fixture read failure') },
  }))
  try {
    assert.match(
      screen.markup(),
      /did not report whether .* holds an account/i,
      'a failed account read must render its could-not-read reason',
    )
    assert.match(
      screen.markup(),
      /class="fleet-profile-status is-serious" role="alert"/,
      'a failed account read must remain an alert state rather than become a definite signed-out answer',
    )
  } finally { screen.restore() }
})

test('the sign-in control is live while idle and disabled for the whole pending action', async () => {
  const pending = deferred()
  const screen = await drive(signedOutBridge({ signIn: () => pending.promise }), {
    username: 'real-caller', password: 'not-retained-by-the-view',
  })
  try {
    assert.doesNotMatch(
      signInSubmitTag(screen.markup()) ?? '',
      /\sdisabled(?:\s|>)/,
      'the idle sign-in control must be enabled',
    )
    screen.submit('sign-in')
    await settle()
    assert.match(
      signInSubmitTag(screen.markup()) ?? '',
      /\sdisabled(?:\s|>)/,
      'the sign-in control must be disabled while its account action is pending',
    )
    assert.match(
      screen.markup(),
      />Working…<\/button>/,
      'the disabled pending control must state that it is working',
    )
    pending.resolve({ ok: true, persisted: true })
    await settle()
  } finally { screen.restore() }
})

test('a refused sign-in renders the producer reason rather than reducing refusal to prose-free state', async () => {
  const producerReason = 'This account was refused because the fixture session has expired.'
  const screen = await drive(signedOutBridge({
    signIn: async () => ({ ok: false, code: 'FIXTURE_EXPIRED', reason: producerReason }),
  }), { username: 'real-caller', password: 'not-retained-by-the-view' })
  try {
    screen.submit('sign-in')
    await settle()
    assert.match(screen.markup(), /That did not work\./, 'a refused action must be identified as a refusal')
    assert.match(
      screen.markup(),
      new RegExp(producerReason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `the refused sign-in must render the producer's specific reason: "${producerReason}"`,
    )
  } finally { screen.restore() }
})

test('confirming the reset really calls erase -- a no-op that reports success is caught', async () => {
  /* WHY THIS EXISTS, and it was measured rather than imagined. A mutation that
     made runReset() skip bridge.erase() entirely and hand back { ok: true } --
     so nothing is deleted and the screen still paints "done" -- left ALL 66
     assertions across account, account-markup, local-data-reset,
     account-panel-copy and account-reset-copy GREEN. The delete path could be
     turned into a complete no-op and the suite could not tell.

     That is the "claims success when nothing happened" class, on the one
     control where a person is relying on the claim most. So this asserts the
     CALL, not the painted result: painted state is what survived the mutation. */
  const calls = []
  const localData = {
    plan: async () => { calls.push('plan'); return { ok: true, items: [] } },
    erase: async () => { calls.push('erase'); return { ok: true } },
  }
  const run = await drive(signedOutBridge(), {}, localData)
  try {
    run.press('[data-reset-confirm]')
    await settle()
    assert.ok(calls.includes('erase'),
      `confirming the reset must call erase(); calls seen: ${JSON.stringify(calls)}`)
  } finally { run.restore() }
})

test('the reset refuses when no local-data bridge exists, rather than reporting a deletion', async () => {
  /* The other half, and the reason the test above cannot simply assert "no
     throw": with no bridge the view must NOT claim anything was erased. An
     assertion that only checked the happy path would pass on a build where
     erase is unreachable. */
  const run = await drive(signedOutBridge(), {}, undefined)
  try {
    run.press('[data-reset-confirm]')
    await settle()
    assert.doesNotMatch(run.markup(), /erased|deleted|done/i,
      'with nothing to erase through, the view must not report a completed deletion')
  } finally { run.restore() }
})

test('"Signed out everywhere" is only said when something was actually revoked', async () => {
  /* ok MEANS "NOTHING WENT WRONG". IT DOES NOT MEAN "IT HAPPENED."
   *
   * shell/product-account.cjs signOutEverywhere answers { ok: true, revoked:
   * false } when there was no signed-in account: it signs out locally and bumps
   * no epoch, so every saved sign-in taken from this computer earlier still
   * works. src/account-state.js readActionResult rebuilt the reply from a fixed
   * field list and DROPPED `revoked`, so the view could not see it and printed
   * "Signed out everywhere. Any saved sign-in taken from this computer earlier
   * is now refused." either way.
   *
   * That is the false-success class, on a control a person presses precisely
   * because they are worried about other sessions. A control that says nothing
   * is bad; one that claims an outcome it did not produce is worse, because they
   * stop worrying.
   *
   * Three of these assertions would pass if the sentence were simply deleted, so
   * the second case is the control: the real revocation must still say so. */
  const said = async (revoked) => {
    const run = await drive(signedOutBridge({
      signOutEverywhere: async () => ({ ok: true, revoked }),
    }))
    try {
      run.press('[data-account-sign-out-everywhere]')
      await settle()
      return run.markup()
    } finally { run.restore() }
  }

  const nothingRevoked = await said(false)
  assert.doesNotMatch(nothingRevoked, /Signed out everywhere/,
    'the view claimed every saved sign-in was refused when the application said it revoked nothing')
  assert.doesNotMatch(nothingRevoked, /is now refused/,
    'the view described saved sign-ins as refused when none were')
  assert.match(nothingRevoked, /Signed out on this computer/,
    'the honest outcome must still be reported -- going silent is not the fix')

  /* THE CONTROL. Without it, deleting the success sentence entirely would pass
     every assertion above while making a real revocation unreportable. */
  const reallyRevoked = await said(true)
  assert.match(reallyRevoked, /Signed out everywhere/,
    'a real revocation no longer says so, so the checks above are passing on silence rather than on honesty')
})
