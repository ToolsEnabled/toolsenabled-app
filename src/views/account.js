/* THE SIGN-IN SCREEN.
 *
 * One screen, two entry points: the first-run walkthrough links to it, and it
 * stays reachable afterwards at #/account so a person can sign out, sign in as
 * somebody else, or change a password. Building it twice would produce two
 * sign-in forms that drift, which on an auth surface is not a cosmetic problem.
 *
 * WHAT IT SAYS BEFORE IT ASKS. src/account-state.js holds the three sentences,
 * and they are on the screen rather than in a policy document because every one
 * of them corrects an assumption the words "create an account" produce by
 * default: that there is a server, that there is an email address, and that a
 * forgotten password can be reset. None of those is true here.
 *
 * THE PASSWORD IS READ AND DROPPED. It is taken from the input at the moment of
 * submit, passed to the shell, and the field is cleared. It is never held in
 * the closure between actions, never put in `state`, never written to
 * localStorage, and never included in a status message -- the refusals below
 * render `result.reason`, which comes from the main process and is written not
 * to quote the input.
 *
 * `autocomplete` is set on every field so a password manager fills the right
 * one, and `new-password` on creation so it offers to generate rather than to
 * reuse. A sign-in form that fights the browser's password manager pushes
 * people towards passwords they can remember, which is the opposite of the
 * point.
 */

import { el } from '../components.js'
import { screenMarkup } from '../account-markup.js'
import { watchBrowserSignInAddress } from '../account-browser-wait.js'
import {
  ACCOUNT_QUESTION,
  ACCOUNT_QUESTION_SUB,
  ACCOUNT_SCOPE_LEAD,
  ACCOUNT_SCOPE_NOTICE,
  MIN_PASSWORD_LENGTH,
  accountBridge,
  loadAccountState,
  loadAccountBelongings,
  loadGoogleAvailability,
  readActionResult,
  readGoogleSignInResult,
} from '../account-state.js'
import { readPlan, readSweep } from '../account-reset-copy.js'
import { RESET_SUBJECT_HERE, RESET_SUBJECT_REMOTE } from '../account-reset-copy.js'
import { normalizeOwnerPromptSnapshot } from '../owner-popup.js'
import { ownerPromptSnapshot } from '../mission-bridge.js'
import { cartSummary } from '../purchase-cart-view.js'
import { withDeadline } from '../read-deadline.js'
import { currentDataSource } from '../data-source.js'
import { websiteAccountHref } from '../website-account-route.js'

import '../settings.css'
import '../fleet-profile-settings.css'
import '../setup.css'

/* HOW LONG THE PURCHASE-LIST ROW MAY SAY IT IS STILL READING.
 *
 * Two numbers rather than one, because they answer different questions. The
 * READ deadline bounds the wire call; the ROW deadline bounds the STATE, and
 * fires even when no call was ever made -- which is the failure that shipped.
 * The row's is the longer of the two so that an answer arriving at the edge of
 * its own budget still gets to be the answer, rather than racing the refusal it
 * was about to make unnecessary.
 *
 * Eight seconds is not a guess about the network. It is what a person will sit
 * in front of a sentence that says something is being read before they decide
 * the program is broken -- and about this product's money surface, on which
 * doing nothing is a denial, being thought broken is the expensive outcome. */
const CART_READ_DEADLINE_MS = 8_000
const CART_ROW_DEADLINE_MS = 10_000

export function accountView({ navigate = hash => { location.hash = hash } } = {}) {
  const websiteAccount = websiteAccountHref()
  if (websiteAccount) {
    const root = el(`<div class="view-pad setup-page">
      <p>Opening your ToolsEnabled account…</p>
      <a class="ctl-btn" href="/account/">Open Account</a>
    </div>`)
    // Replace the internal route so Back does not return to a redirect loop.
    // If this browser refuses navigation, the same-origin link stays usable.
    try { globalThis.location.replace(websiteAccount) } catch { /* keep the link */ }
    return { el: root, destroy() {} }
  }
  const root = el(`<div class="view-pad setup-page">
    <div class="settings-shell setup-shell">
      <section class="settings-section setup-section" data-account-section></section>
    </div>
  </div>`)
  const section = root.querySelector('[data-account-section]')
  const readingOverRelay = () => currentDataSource() === 'relay'
  const readerComputer = () => readingOverRelay() ? 'the computer you are driving' : 'this computer'
  let destroyed = false
  let refreshVersion = 0

  /* `null` means "not asked yet", which is distinct from a reply that came back
     unavailable. Painting an empty form during the read would show a
     create-account screen to somebody who already has one. */
  let state = null
  let busy = false
  let notice = null
  /* Which form is showing. `mode` is only ever set from this file's own
     buttons, never from a reply, so a malformed shell answer cannot select a
     form. */
  let mode = 'sign-in'

  /* The markup lives in src/account-markup.js, called rather than inlined.
     Two planted defects -- an empty form and an empty scope notice -- survived
     every source-searching assertion, including ones narrowed to the function
     slice, because an early `return ''` leaves the real markup below it and
     dead code still matches a text search. Builders that a test can CALL are
     the only thing that catches it. This view now owns state and events; it
     owns no HTML. */
  /* WHAT IS HIS, read separately from WHO HE IS.
   *
   * Two reads rather than one because they fail differently and the screen has
   * to say which failed. A damaged settings partition must not stop the page
   * saying who is signed in, and a vault that cannot be read must not make the
   * account look signed out. `null` here means "not asked yet", exactly like
   * `state`; the markup renders unknown rather than empty for it. */
  let data = null
  let payment = null
  let history = null
  /* WHAT IS WAITING TO BE BOUGHT. `null` means "not asked yet", exactly like
     `state`; a reply that could not be read comes back with readable false, and
     the row draws those two differently. See cartMarkup in account-markup.js. */
  let cart = null
  /* The handle for the row's own deadline. Held so it can be re-armed on each
     refresh and cleared on teardown; a timer that paints a destroyed view is
     how a "fixed" loading state becomes a console error instead. */
  let cartDeadline = null
  /* `null` means "not asked yet", exactly like `state`. It is NOT the same as
     "unavailable", and the markup renders the two differently -- a screen that
     showed "Google sign-in is not available on this copy" while it was still
     reading would be telling somebody something false for a few hundred
     milliseconds, and they would act on it. */
  let google = null
  let browserSignIn = null
  let stopBrowserWait = null
  function beginBrowserSignIn(bridge, provider) {
    endBrowserSignIn()
    const attempt = { provider, canCancel: typeof bridge?.googleCancel === 'function', address: null }
    browserSignIn = attempt
    stopBrowserWait = watchBrowserSignInAddress({ bridge, onAddress(address) {
      if (destroyed || browserSignIn !== attempt) return
      attempt.address = address
      paint()
    } })
  }
  function endBrowserSignIn() {
    stopBrowserWait?.()
    stopBrowserWait = null
    browserSignIn = null
  }

  /* REMOVING THIS COMPUTER'S DATA lives in its own piece of state, deliberately
     NOT in `mode`. `mode` is which sign-in form is showing and is reset by every
     refresh(); a person who has just been shown a measured list of what is about
     to be deleted must not lose it because the account state happened to
     re-read. `phase` only ever moves from this file's own buttons.
     `plan` is the measurement, and it is DROPPED on cancel rather than kept for
     a later press: a list measured five minutes ago is a claim about a disk that
     has changed since. */
  let reset = { phase: 'idle', plan: null, sweep: null }

  const view = () => ({
    state, mode, busy, notice, data, payment, history, cart, google, browserSignIn, reset,
    /* Relay copy must not reuse the local host's platform-specific guidance. */
    platform: readingOverRelay() ? null : globalThis.mcSetup?.platform,
    subject: readingOverRelay() ? RESET_SUBJECT_REMOTE : RESET_SUBJECT_HERE,
  })

  let signedOutDraft = {}
  function paint() {
    if (destroyed) return
    /* Only the signed-out create/sign-in forms may carry typed values across a
       paint. Signed-in sub-forms have server-derived defaults and must never
       be overwritten by a stale draft from a previous form. */
    const previousForm = section.querySelector('form[data-account-form="create"], form[data-account-form="sign-in"]')
    const formValues = previousForm
      ? [...previousForm.querySelectorAll('input[name="username"], input[name="displayName"]')]
        .map(field => [field.name, field.value])
      : []
    /* ACROSS A MODE SWITCH TOO (T1493). "I already have an account" shows a
       form with no "Shown as", so what was typed there is held here and put
       back when the person switches back to create. A signed-in state ends
       the draft, so it can never refill a later signed-out form. */
    for (const [name, value] of formValues) signedOutDraft[name] = value
    if (state?.signedIn) signedOutDraft = {}
    section.innerHTML = screenMarkup(view())
    const nextForm = section.querySelector('form[data-account-form="create"], form[data-account-form="sign-in"]')
    for (const [name, value] of Object.entries(signedOutDraft)) {
      const field = nextForm?.querySelector(`[name="${name}"]`)
      if (field) field.value = value
    }
  }

  /* A LATE GOOGLE-AVAILABILITY ANSWER MUST NOT ERASE A FORM IN PROGRESS.
   *
   * The signed-out refresh paints the local-account form immediately, then asks
   * the shell whether Google sign-in is available. Replacing section.innerHTML
   * when that asynchronous answer arrives replaces every input too. Measured in
   * exact-candidate QA: the answer landed while the first account was being
   * typed, submit then read an empty username, and account creation was refused.
   *
   * This asks only two booleans: whether focus is inside the form, or whether an
   * input has any characters. It deliberately never copies a field value into
   * view state -- especially the password, whose lifetime remains the DOM field
   * until submit reads and drops it. The Google answer is still retained in the
   * `google` state and appears on the next safe paint. */
  function accountFormInProgress() {
    if (section.querySelector('[data-account-form]:focus-within')) return true
    return [...section.querySelectorAll('[data-account-form] input')]
      .some(field => typeof field.value === 'string' && field.value.length > 0)
  }

  /* HOW MANY OF THIS COMPUTER'S RUNS ARE YOURS.
   *
   * Counted here, in the page, from the records the shell already returns,
   * because the ledger is deliberately one file for the whole device (see
   * shell/product-account.cjs's partition note) and what a person wants to see
   * is their own slice of it. The principal is compared to `account:<id>` --
   * the SAME string the main process writes into the record, produced there and
   * never here, so the page cannot decide that a record is his.
   *
   * Never throws and never blocks the rest of the screen: a ledger this build
   * cannot read leaves `history` null and the row simply does not appear. */
  async function loadHistory() {
    const agent = globalThis.mcAgent
    if (!agent || typeof agent.history !== 'function' || !state?.signedIn) return null
    let reply
    try { reply = await agent.history({ limit: 200 }) } catch { return null }
    if (!reply || reply.ok !== true || !Array.isArray(reply.entries)) return null
    const accountId = state.accountId
    if (typeof accountId !== 'string' || !accountId) return null
    const wanted = `account:${accountId}`
    const mine = reply.entries.filter(entry => entry && entry.principal === wanted).length
    const total = Number.isSafeInteger(reply.total) ? reply.total : reply.entries.length
    return { mine, total }
  }

  /* WHAT IS WAITING TO BE BOUGHT, READ FROM THE ONE LIST THAT HOLDS IT.
   *
   * The owner asked for his purchase list to be in front of him inside his
   * signed-in account, so this screen reads the same queue #/approvals reads,
   * over the same audited connection, and hands it to the same counting code.
   * NOTHING is stored here and nothing is totalled here: a second copy of his
   * buy list, held by a screen, is precisely the drift this design forbids.
   *
   * IT NEVER THROWS AND NEVER BLOCKS THE REST OF THE SCREEN. A queue this build
   * cannot reach comes back readable:false and the row says so in a sentence,
   * because "I could not look" and "nothing is waiting" are different facts and
   * only one of them would let him relax. It also DECIDES NOTHING and cannot:
   * this is the read route, and a decision needs measured evidence that a card
   * was on the glass, which this screen does not draw. */
  async function loadCart() {
    if (!state?.signedIn) return null
    let raw
    /* THE READ IS BOUNDED, AND THAT IS NOT BELT-AND-BRACES. Every hop under
       ownerPromptSnapshot() carries its own 30s budget -- wait for the shell to
       settle its capability layer, confirm the pinned origin, exchange the
       bootstrap proof, then the request itself -- and those budgets ADD. Four of
       them in a row is a worst case near two minutes, during which this row says
       only that it is reading. Nobody waits two minutes at a sentence; they
       conclude the product is broken, and on the evidence available to them they
       are right. So the row takes its own deadline and reports a refusal it can
       act on rather than inheriting a sum of timeouts nobody chose. */
    try { raw = await withDeadline(ownerPromptSnapshot(), CART_READ_DEADLINE_MS, 'your purchase list') } catch { raw = null }
    if (raw?.ok !== true) return { readable: false }
    try {
      return cartSummary(normalizeOwnerPromptSnapshot(raw).prompts, Date.now())
    } catch {
      /* A queue that did not match its expected shape, or a total that is not
         the sum of its own lines. Not shown wrongly rather than not shown. */
      return { readable: false }
    }
  }

  /* THE ROW RESOLVES EVEN IF NOTHING EVER READS IT. THIS IS THE DEFECT ITSELF.
   *
   * WHAT SHIPPED IN 1.0.6, read out of the packaged bundle rather than guessed:
   * cartMarkup() was in the build and loadCart() was not. The renderer declared
   * the cart variable, passed it through view(), rendered the "not asked yet"
   * branch from it -- and never assigned it. So the row printed "Reading what is
   * waiting for you to decide…" on every paint, for as long as the window was
   * open, having never attempted a read. That is why the report of it carried no
   * console error, no network error and no exception: there was nothing to fail.
   * Measured on that build, the row was still identical after 120 seconds while
   * every channel it would have used answered in under 3ms.
   *
   * WHY A TIMER AND NOT JUST THE MISSING CALL. Adding loadCart() back repairs
   * this instance and leaves the shape intact: a "loading" state whose only exit
   * is a caller remembering to assign it. The next refactor that drops the
   * assignment reproduces it exactly, silently, and nothing fails. So the
   * loading state is given a DEADLINE OF ITS OWN. If the row is still on "not
   * asked yet" when the deadline passes, it stops claiming to be busy and states
   * a refusal a person can act on -- Open your purchase list -- whatever the
   * reason it was never answered.
   *
   * IT NEVER OVERWRITES A REAL ANSWER, and a real answer that lands later still
   * wins: the guard is `cart === null`, and refresh() assigns straight over the
   * refusal when the read comes back. A surface that gave up and then refused to
   * accept the truth would be a second defect wearing the fix's clothes. */
  function armCartDeadline() {
    if (cartDeadline !== null) clearTimeout(cartDeadline)
    cartDeadline = setTimeout(() => {
      cartDeadline = null
      if (destroyed || cart !== null || !state?.signedIn) return
      cart = { readable: false }
      paint()
    }, CART_ROW_DEADLINE_MS)
  }

  async function refresh() {
    const version = ++refreshVersion
    const current = () => !destroyed && version === refreshVersion
    const nextState = await loadAccountState()
    if (!current()) return
    if (state?.accountId !== nextState.accountId || state?.username !== nextState.username) {
      data = null
      payment = null
      history = null
      cart = null
    }
    state = nextState
    /* Tell the settings store who is signed in now, so the appearance, the
       settings page and the purchase selection follow the account rather than
       the computer. Optional: absent in a plain browser, and a no-op there. */
    try { if (globalThis.mcDurableStorage) globalThis.mcDurableStorage.onAccountChanged() } catch (error) { /* storage layer is optional */ }
    /* The mode follows the facts on the first read only. A computer with no
       account opens on "create"; one that has accounts opens on "sign in", so
       the common case is one field and a password. */
    if (!state.signedIn && mode !== 'create' && state.available && state.accountCount === 0) mode = 'create'
    /* The two sub-forms of the signed-in screen survive a refresh; every other
       mode collapses back to it. Leaving `display-name` out of this list was
       the first version, and it threw the person out of the rename form the
       moment anything re-read the account. */
    if (state.signedIn && mode !== 'change-password' && mode !== 'display-name') mode = 'signed-in'
    if (!state.signedIn) {
      /* Cleared on sign-out. Leaving the previous account's counts on the
         screen after somebody signs out is the partition failing in the one
         place a person would actually notice it. */
      data = null
      payment = null
      history = null
      cart = null
      /* The row is not on this screen, so nothing is waiting on a deadline. A
         timer left running here would fire against a signed-out view. */
      if (cartDeadline !== null) { clearTimeout(cartDeadline); cartDeadline = null }
      paint()
      if (!state.available) return
      /* Read AFTER the first paint, so the screen appears immediately and the
         Google row fills in. Only while signed out: it is the sign-out screen
         that offers it, and asking on every read would ask on every paint. */
      const nextGoogle = await loadGoogleAvailability()
      if (!current()) return
      google = nextGoogle
      if (!accountFormInProgress()) paint()
      return
    }
    /* ARMED BEFORE THE FIRST AWAIT, not beside the read it guards. Every line
       below this one can fail to be reached -- an earlier channel that never
       settles, an early return added later, or the read simply not being wired
       at all, which is what shipped. The deadline has to be older than all of
       them or it guards only the case somebody already thought of. */
    armCartDeadline()
    paint()
    const belongings = await loadAccountBelongings()
    if (!current()) return
    data = belongings.data
    payment = belongings.payment
    paint()
    const nextHistory = await loadHistory()
    if (!current()) return
    history = nextHistory
    paint()
    const nextCart = await loadCart()
    if (!current()) return
    cart = nextCart
    if (cartDeadline !== null) { clearTimeout(cartDeadline); cartDeadline = null }
    paint()
  }

  /* ---------- actions ----------
   *
   * Each one reads its inputs at the moment it runs, hands them to the shell,
   * and clears the password fields before painting. The values are function-
   * local; nothing here closes over a password. */

  function passwordFields() {
    return [...section.querySelectorAll('input[type="password"]')]
  }

  function clearPasswords() {
    for (const field of passwordFields()) field.value = ''
  }

  function fieldValue(name) {
    const field = section.querySelector(`[name="${name}"]`)
    return field ? field.value : ''
  }

  async function run(action, onSuccess, { browserProvider = null } = {}) {
    if (busy) return
    const bridge = accountBridge()
    if (!bridge) {
      notice = { tone: 'bad', title: 'This page is not the installed application.', detail: 'There is no computer here to sign in to.' }
      paint()
      return
    }
    busy = true
    notice = null
    if (browserProvider) beginBrowserSignIn(bridge, browserProvider)
    paint()
    let result
    try {
      result = readActionResult(await action(bridge))
    } catch (error) {
      result = readActionResult(null)
    }
    endBrowserSignIn()
    if (destroyed) return
    busy = false
    /* Cleared on every outcome, not only on success. A refused sign-in that
       leaves the password sitting in the field leaves it in the DOM of a window
       somebody may walk away from. */
    clearPasswords()
    if (!result.ok) {
      notice = { tone: 'bad', title: 'That did not work.', detail: result.reason }
      await refresh()
      paint()
      return
    }
    await onSuccess(result)
  }

  function submit(kind) {
    if (kind === 'create') {
      const username = fieldValue('username')
      const displayName = fieldValue('displayName')
      const password = fieldValue('password')
      /* An @ suggests an email address, but does not prove a ToolsEnabled
         account. Keep this local: do not invoke account.create with an email
         and do not authenticate on the person's behalf. */
      if (username.includes('@')) {
        clearPasswords()
        mode = 'sign-in'
        notice = {
          tone: 'warn',
          title: 'Sign in with your email',
          detail: 'To sign in with an email address, use the sign-in form below.',
        }
        paint()
        return
      }
      return run(
        bridge => bridge.create({ username, displayName, password }),
        async () => {
          /* Created and then signed in, as one action from the person's point
             of view. Making them type the password twice in a row to get
             through their own first run is friction that buys nothing. */
          let signedIn
          try {
            signedIn = readActionResult(await accountBridge().signIn({ username, password }))
          } catch { signedIn = readActionResult(null) }
          await refresh()
          notice = signedIn.ok
            ? {
              tone: 'good',
              title: 'Account created, and you are signed in.',
              detail: signedIn.persisted
                ? 'Work your assistant does is now recorded against this account. You will stay signed in when you reopen the program.'
                : 'Work your assistant does is now recorded against this account. This computer cannot remember the sign-in, so you will be asked again next time.',
            }
            : { tone: 'warn', title: 'The account was created.', detail: 'Signing in did not complete, so sign in below.' }
          paint()
        },
      )
    }
    if (kind === 'sign-in') {
      const username = fieldValue('username')
      const password = fieldValue('password')
      return run(
        bridge => bridge.signIn({ username, password }),
        async result => {
          await refresh()
          if (!state?.signedIn) {
            notice = state?.available ? { tone: 'warn', title: 'Sign-in could not be confirmed.',
              detail: 'The account no longer reports a signed-in session. Sign in again to continue.' } : null
            paint()
            return
          }
          notice = {
            tone: 'good',
            title: 'Signed in.',
            detail: result.persisted
              ? 'Work your assistant does is recorded against this account.'
              : 'Work your assistant does is recorded against this account. This computer cannot remember the sign-in, so you will be asked again next time.',
          }
          paint()
        },
        { browserProvider: username.includes('@') ? 'password' : null },
      )
    }
    if (kind === 'display-name') {
      /* READ AS TYPED, and deliberately not trimmed or defaulted here. An empty
         field means "show me as my username again" and the shell is the one
         place that decides what a name normalizes to -- a renderer that
         pre-emptied or pre-trimmed would be a second opinion, and the two would
         eventually disagree about what somebody is called. */
      const displayName = fieldValue('displayName')
      const bridge = accountBridge()
      if (!bridge || typeof bridge.changeDisplayName !== 'function') {
        /* SAID, NOT HIDDEN. A build without the channel must not show a Save
           that appears to work; the person is told the copy cannot do it. */
        notice = {
          tone: 'bad',
          title: readingOverRelay() ? `${readerComputer()} cannot change the name it shows.` : 'This copy cannot change the name it shows.',
          detail: readingOverRelay()
            ? 'The installed application on that computer did not offer that, so nothing was changed and you are still shown as before.'
            : 'The installed application did not offer that, so nothing was changed and you are still shown as before.',
        }
        paint()
        return undefined
      }
      return run(
        signedInBridge => signedInBridge.changeDisplayName({ displayName }),
        async () => {
          mode = 'signed-in'
          /* Re-read BEFORE the sentence is written, so what it claims is what
             the shell now holds rather than what was typed. They differ
             whenever the name was emptied or normalized, and those are exactly
             the cases where a person needs to be told. */
          await refresh()
          /* THE SESSION CAN HAVE ENDED WHILE THIS RAN -- an expiry, or another
             window signing out everywhere. The name WAS saved; this window
             just has nothing to show it on. Printing "You are shown as  now."
             with an empty name is the shape of failure this codebase keeps
             finding, so the signed-out case gets its own sentence. */
          if (!state?.signedIn) {
            notice = {
              tone: 'warn',
              title: 'The new name was saved.',
              detail: 'This window is signed out now, so it is not showing it back to you — sign in again and it will be there.',
            }
            paint()
            return
          }
          notice = {
            tone: 'good',
            title: `You are shown as ${state.displayName} now.`,
            detail: state.displayName === state.username
              /* "as often as you like", not "whenever": the copy scanner in
                 tools/test/product-account-surface.test.mjs matches absolute
                 words by substring, and "whe-never" trips it. Rewording is
                 honest; classifying an accidental match as a promise would
                 leave a fake entry in the register. */
              ? 'That is the name you sign in with, which is what an empty box means. Change it again as often as you like.'
              : 'That name goes on the record of work from now on. Everything already recorded stays exactly as it was written.',
          }
          paint()
        },
      )
    }
    const currentPassword = fieldValue('currentPassword')
    const newPassword = fieldValue('newPassword')
    /* A MISMATCH IS REFUSED HERE, BEFORE ANYTHING IS SENT (T1589). The change
       ends every sign-in, and a local account has no reset, so a password the
       person could not check would lock the account for good. The current
       password stays typed; the two new ones are cleared to be typed again,
       and the keyboard goes to the first of them. */
    if (newPassword !== fieldValue('newPasswordAgain')) {
      notice = {
        tone: 'bad',
        title: 'The two new passwords are different.',
        detail: 'Your password was not changed. Type the new password again in both boxes.',
      }
      paint()
      const current = section.querySelector('[name="currentPassword"]')
      if (current) current.value = currentPassword
      section.querySelector('[name="newPassword"]')?.focus?.()
      return undefined
    }
    return run(
      bridge => bridge.changePassword({ currentPassword, newPassword }),
      async () => {
        mode = 'sign-in'
        await refresh()
        notice = {
          tone: 'good',
          title: 'Password changed, and every sign-in was ended.',
          detail: readingOverRelay()
            ? `Any sign-in saved elsewhere from ${readerComputer()} is now refused. Sign in with the new password.`
            : 'Any sign-in saved elsewhere from this computer is now refused. Sign in with the new password.',
        }
        paint()
      },
    )
  }

  function onSubmit(event) {
    const form = event.target.closest('[data-account-form]')
    if (!form) return
    event.preventDefault()
    submit(form.dataset.accountForm)
  }

  /* SIGN IN WITH GOOGLE, from the page's side.
   *
   * The page starts it and waits. It sends NOTHING -- no email address, no
   * account name, no token -- because the identity is decided in the main
   * process from what Google signed, and a page that could name the person
   * would make the whole flow decorative.
   *
   * WHILE IT IS RUNNING the button says so and a Cancel appears next to it. The
   * person's browser is a separate window they may close, lose behind this one,
   * or walk away from, and none of those is observable from here -- so Cancel
   * is the honest control, and the attempt also times out on the shell side.
   *
   * EVERY FAILURE LANDS SIGNED OUT WITH THE SENTENCE THE SHELL WROTE. There is
   * no branch here that retries, that falls back to the password form on the
   * person's behalf, or that treats an unrecognised reply as success. */
  async function startGoogleSignIn(localProfile = false) {
    if (busy) return
    const bridge = accountBridge()
    const signInMethod = localProfile ? 'googleLocalProfile' : 'googleSignIn'
    if (!bridge || typeof bridge[signInMethod] !== 'function') {
      notice = {
        tone: 'bad',
        title: readingOverRelay() ? `${readerComputer()} cannot sign in with Google.` : 'This copy cannot sign in with Google.',
        detail: readingOverRelay()
          ? `Use an account on ${readerComputer()} instead — it records the same thing.`
          : 'Use an account on this computer instead — it records the same thing.',
      }
      paint()
      return
    }
    busy = true
    notice = null
    beginBrowserSignIn(bridge, 'google')
    paint()

    let result
    try {
      result = readGoogleSignInResult(await bridge[signInMethod]())
    } catch {
      result = readGoogleSignInResult(null)
    }
    endBrowserSignIn()
    if (destroyed) return
    busy = false

    if (!result.ok) {
      /* The shell's own sentence, unedited. It names which of the six things
         went wrong -- no network, Google refusing, a token that did not verify,
         the port, the browser, or the person not finishing -- and the person is
         still signed out. */
      notice = { tone: 'bad', title: 'You were not signed in.', detail: result.reason }
      await refresh()
      paint()
      return
    }

    await refresh()
    if (!state?.signedIn) {
      notice = state?.available ? { tone: 'warn', title: 'Sign-in could not be confirmed.',
        detail: 'The account no longer reports a signed-in session. Sign in again to continue.' } : null
      paint()
      return
    }
    const testWarning = result.usedTestProvider
      ? readingOverRelay()
        ? ` ${readerComputer()} is pointed at a test sign-in service rather than at Google, so this is not a real Google account.`
        : ' This copy is pointed at a test sign-in service rather than at Google, so this is not a real Google account.'
      : ''
    notice = {
      tone: result.usedTestProvider ? 'warn' : 'good',
      title: result.created ? 'Signed in with Google, and an account was made for you.' : 'Signed in with Google.',
      detail: `${result.persisted
        ? 'Work your assistant does is recorded against this account. You will stay signed in when you reopen the program.'
        : 'Work your assistant does is recorded against this account. This computer cannot remember the sign-in, so you will be asked again next time.'}${testWarning}`,
    }
    paint()
  }

  /* ---------- removing this computer's data ----------
   *
   * TWO PRESSES, AND THE FIRST ONE CANNOT DELETE. The first asks the shell to
   * MEASURE and paints what it found; only the second calls erase(). That is not
   * a confirmation dialog for politeness -- it is the only moment at which the
   * person has been told what they are about to lose, measured on their disk
   * rather than described in general.
   *
   * A MISSING BRIDGE IS SAID, NOT HIDDEN. In a plain browser, or a build without
   * the channel, the row renders `unavailable` with a sentence. Hiding it would
   * leave somebody hunting for a control they had been told about; a button that
   * silently did nothing would be worse than both. */
  function resetBridge() {
    const bridge = globalThis.mcLocalData
    return bridge && typeof bridge.plan === 'function' && typeof bridge.erase === 'function' ? bridge : null
  }

  async function startResetPlan() {
    if (busy) return
    const bridge = resetBridge()
    if (!bridge) { reset = { phase: 'unavailable', plan: null, sweep: null }; paint(); return }
    busy = true
    reset = { phase: 'measuring', plan: null, sweep: null }
    paint()
    let reply
    try { reply = await bridge.plan() } catch { reply = null }
    if (destroyed) return
    busy = false
    reset = { phase: 'confirm', plan: readPlan(reply), sweep: null }
    paint()
    /* T1585: THE PLAN IS READ BEFORE "DELETE IT ALL NOW" IS REACHED. The press
       that asked for it is gone after the repaint, which left the keyboard on
       the page body and the plan unannounced; the first sentence of the plan
       takes the focus instead. */
    section.querySelector('[data-reset-focus]')?.focus?.()
  }

  async function runReset() {
    if (busy) return
    const bridge = resetBridge()
    if (!bridge) { reset = { phase: 'unavailable', plan: null, sweep: null }; paint(); return }
    busy = true
    reset = { ...reset, phase: 'working' }
    paint()
    let reply
    try { reply = await bridge.erase() } catch (error) { reply = { ok: false, reason: error?.message || '' } }
    if (destroyed) return
    busy = false
    reset = { phase: 'done', plan: reset.plan, sweep: readSweep(reply) }
    /* The account state is re-read because the erase revoked every sign-in
       before it deleted anything: the header above must not still say "Signed in
       as" over a deleted account. It is read AFTER the outcome is stored, and
       refresh() cannot clear it -- `reset` is not part of what refresh() owns. */
    await refresh()
    if (destroyed) return
    paint()
  }

  function onClick(event) {
    if (event.target.closest('[data-account-set-aside]')) {
      /* T1520: moves only the account file that will not read; see
         shell/product-account.cjs setAsideDamagedStore(). */
      run(bridge => typeof bridge.setAsideDamaged === 'function'
        ? bridge.setAsideDamaged()
        : { ok: false, reason: 'This installed copy cannot set the account file aside. Update the app, then try again.' },
      async result => {
        await refresh()
        notice = {
          tone: 'good',
          title: 'The damaged account file was set aside.',
          detail: `It is kept as ${(Array.isArray(result.keptAs) ? result.keptAs : []).join(' and ') || 'a copy beside the new one'}. Create an account or sign in below.`,
        }
        paint()
      })
      return
    }
    if (event.target.closest('[data-reset-plan]')) { startResetPlan(); return }
    if (event.target.closest('[data-reset-cancel]')) {
      reset = { phase: 'idle', plan: null, sweep: null }
      paint()
      /* T1585: back to the press that opened the plan, not to the page body. */
      section.querySelector('[data-reset-plan]')?.focus?.()
      return
    }
    if (event.target.closest('[data-reset-confirm]')) { runReset(); return }
    if (event.target.closest('[data-reset-close]')) {
      /* The window's own close, the same act as pressing the X. Nothing else is
         offered afterwards: this program's state on this computer is gone, and a
         session that keeps running would start writing a new one. */
      try { globalThis.close() } catch { /* a browser tab may refuse; the sentence above still stands */ }
      return
    }

    if (event.target.closest('[data-account-home]')) { navigate('#/'); return }

    if (event.target.closest('[data-google-signin-legacy]')) { startGoogleSignIn(true); return }
    if (event.target.closest('[data-account-status-retry]')) {
      if (busy || state?.code !== 'HOSTED_ACCOUNT_STATUS_UNAVAILABLE') return
      busy = true
      notice = null
      paint()
      void refresh().finally(() => {
        if (destroyed) return
        busy = false
        paint()
      })
      return
    }
    if (event.target.closest('[data-google-signin-start]')) { startGoogleSignIn(); return }
    if (event.target.closest('[data-google-signin-cancel], [data-account-signin-cancel]')) {
      const bridge = accountBridge()
      const attempt = browserSignIn
      if (!attempt || typeof bridge?.googleCancel !== 'function') return
      void Promise.resolve().then(() => bridge.googleCancel()).then(result => {
        if (result?.ok === true || destroyed || browserSignIn !== attempt) return
        notice = { tone: 'bad', title: 'Cancellation was not confirmed.',
          detail: result?.reason || 'Close the browser window and wait for the sign-in attempt to end.' }
        paint()
      }).catch(() => {
        if (destroyed || browserSignIn !== attempt) return
        notice = { tone: 'bad', title: 'Cancellation was not confirmed.',
          detail: 'Close the browser window and wait for the sign-in attempt to end.' }
        paint()
      })
      return
    }

    const next = event.target.closest('[data-account-mode]')
    if (next) {
      if (busy) return
      mode = next.dataset.accountMode
      notice = null
      paint()
      return
    }

    if (event.target.closest('[data-account-sign-out-everywhere]')) {
      run(bridge => bridge.signOutEverywhere(), async (result) => {
        mode = 'sign-in'
        await refresh()
        /* THE VERB ANSWERS TWO THINGS, AND THIS READS BOTH.
           { ok: true, revoked: false } means it signed out here and revoked
           nothing, because there was no signed-in account to revoke for. The
           sentence below used to be printed either way, so a person could be
           told every saved sign-in was refused when none of them was. */
        notice = result?.allRequested === true && result.revoked !== true
          ? { tone:'warn', title:'Signed out on this computer.', detail: result.localCleared === false
              ? 'The saved login could not be removed, and ending the other sessions was not confirmed.'
              : result.stepUpRequired === true
                ? 'Ending other sessions requires passkey verification. Open your account on toolsenabled.ai to verify your passkey.'
                : 'The saved login was removed here. The account service did not confirm that other sessions ended.' }
          : result && result.revoked === false
          ? {
            tone: 'good',
            title: 'Signed out on this computer.',
            detail: readingOverRelay()
              ? `No account was signed in on ${readerComputer()}, so no saved sign-in was refused. Sign in to use this account.`
              : 'No account was signed in here, so no saved sign-in was refused. Sign in to use this account.',
          }
          : {
            tone: 'good',
            title: 'Signed out everywhere.',
            detail: readingOverRelay()
              ? `Any saved sign-in taken from ${readerComputer()} earlier is now refused. Sign in again to use this account.`
              : 'Any saved sign-in taken from this computer earlier is now refused. Sign in again to use this account.',
          }
        paint()
      })
      return
    }
    if (event.target.closest('[data-account-sign-out]')) {
      run(bridge => bridge.signOut(), async result => {
        mode = 'sign-in'
        await refresh()
        notice = result.localCleared === false
          ? { tone: 'warn', title: 'Signed out for this run.', detail: 'The saved login could not be removed from this computer. Its removal has not been confirmed.' }
          : result.remoteEnded === false
            ? { tone: 'warn', title: 'Signed out on this computer.', detail: 'The saved login was removed. The account service did not confirm that the remote session ended.' }
            : { tone: 'good', title: 'Signed out.', detail: 'Work started from now on is recorded without a name until somebody signs in.' }
        paint()
      })
    }
  }

  section.addEventListener('click', onClick)
  section.addEventListener('submit', onSubmit)
  paint()
  refresh()

  return {
    el: root,
    destroy() {
      destroyed = true
      endBrowserSignIn()
      section.removeEventListener('click', onClick)
      section.removeEventListener('submit', onSubmit)
      /* The purchase-list row's deadline, dropped with the view. `destroyed`
         already stops it painting, but a timer left armed on every visit to this
         screen is a leak the next reader has to reason about. */
      if (cartDeadline !== null) { clearTimeout(cartDeadline); cartDeadline = null }
      /* The last thing this view does is clear any password still in a field.
         A destroyed view's nodes can outlive it in a morph snapshot. */
      clearPasswords()
    },
  }
}
