/* THE SIGN-IN SCREEN'S MARKUP, SEPARATED SO IT CAN BE RUN.
 *
 * WHY THIS FILE EXISTS, and it is not tidiness. Every assertion about this
 * screen used to search src/views/account.js for strings. Two planted defects
 * survived the entire suite: making the form return an empty string, and making
 * the scope notice return an empty string. Either ships a sign-in screen with no
 * fields, or one that never tells anybody there is no password reset and that
 * this is not a provider login -- the SHIPMENT-PLAN B14 disclosure -- and every
 * test stayed green, because the strings they searched for still existed in the
 * file.
 *
 * Then the SECOND attempt failed too. Narrowing the search to the function's own
 * source slice also survived, because the plant was an early `return ''` with the
 * real markup left below it: dead code still matches a source search. No
 * assertion over TEXT can see reachability. The markup has to be CALLED and its
 * output inspected, and that cannot happen in src/views/account.js because that
 * file imports stylesheets and cannot be loaded outside a browser.
 *
 * So the builders live here: no DOM, no stylesheet, no closure. Every value they
 * need arrives as an argument, which is what makes them callable from a test and
 * is the same reason src/setup-state.js holds the first-run gate's logic.
 *
 * NOTHING HERE HOLDS A SECRET. These functions render field DEFINITIONS, never
 * field values -- there is no parameter on any of them that a password could
 * arrive in. The password is read from the DOM at submit and dropped; see
 * src/views/account.js.
 */

import {
  ACCOUNT_QUESTION,
  ACCOUNT_QUESTION_SUB,
  ACCOUNT_SCOPE_LEAD,
  ACCOUNT_SCOPE_SUBJECT_HERE,
  GOOGLE_SIGNIN_DESCRIPTION,
  GOOGLE_SIGNIN_LABEL,
  GOOGLE_SIGNIN_SCOPE_NOTE,
  MIN_PASSWORD_LENGTH,
  accountScopeNotice,
} from './account-state.js'
import {
  BACKUP_NOTICE,
  DELETE_BUTTON,
  DELETE_CANCEL_BUTTON,
  DELETE_CLOSE_BUTTON,
  DELETE_CONFIRM_BUTTON,
  NO_BRIDGE_DETAIL,
  NO_BRIDGE_TITLE,
  RESET_LEAD,
  RESET_TITLE,
  signOutLimits,
  RESET_SUBJECT_HERE,
  outcomeLines,
  planLines,
  rootLabel,
  survivesLines,
} from './account-reset-copy.js'

export const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* A SECTION ON THIS SCREEN IS A HEADING AND ITS OWN LIST.
 *
 * "the settings nestings are messy and could be nested better. And each section
 * should be a seperate list instead of one long list" (owner). MEASURED on a
 * real 1002x650 window before this existed: the signed-in screen was ONE
 * `.settings-section-rows` holding ten rows and no heading at all, 962px of it,
 * with "Change password", "Sign out" and "Remove this program's data from this
 * computer" as three adjacent, visually identical rows -- the irreversible one
 * indistinguishable from the two that are not. The signed-out screen was four
 * lists, two of them a single row, none of them labelled.
 *
 * `.settings-section-title` IS NOT A NEW CLASS AND NOT A NEW LOOK. It is what
 * src/views/settings.js already puts over a run of settings rows, and
 * src/setup.css says of its own `.setup-subtitle` that it is "exactly
 * .settings-section-title". The rule under the heading is what makes a list
 * read as a list rather than as more of the one above it.
 *
 * IT IS NOT A `<section>`. src/views/account.js renders this whole screen INTO
 * one `<section class="settings-section">`, so a section per group would nest
 * one inside another and inherit its 48px tail four times over -- on a screen
 * whose primary action is already below the fold. Heading plus list, at one
 * depth, is the whole structure.
 *
 * AN EMPTY GROUP DRAWS NOTHING, headline included. A titled heading over no
 * rows is the same lie one level up, and this screen has groups whose rows are
 * conditional -- the sign-in method row is not rendered for every account.
 */
function sectionMarkup(title, rows, attributes = '') {
  const body = rows.filter(Boolean).join('')
  if (body === '') return ''
  return `<h2 class="settings-section-title">${esc(title)}</h2>
    <div class="settings-section-rows"${attributes ? ` ${attributes}` : ''}>${body}</div>`
}

/* HOW LONG THIS SIGN-IN HAS LEFT, AND NEVER MORE THAN IT HAS.
 *
 * `now` is a parameter rather than a capture because this line ages in place:
 * the panel repaints on its own triggers and recomputes the figure each time.
 * A countdown that ages has to have an answer for reaching zero, and this one
 * did not -- `Math.max(0, ...)` folded every past instant onto the same branch
 * as "less than a day", so a sign-in that ran out eight days ago said "This
 * sign-in expires today." A session lives thirty days and the shell only
 * re-reads it when something asks; between the instant it lapses and that read,
 * this sentence described a dead sign-in as a live one. It is the defect
 * src/device-claim-flow.js names in its own words -- "a countdown quietly
 * showing 0:00 forever ... absence painted as a value" -- and the two sibling
 * countdowns in this app (remainingText there, resetPhrase in
 * src/account-switcher-state.js) both already carry the past branch this one
 * was missing.
 *
 * AND THE FIGURE FLOORS, BECAUSE A COUNTDOWN THAT ROUNDS PROMISES TIME THAT IS
 * NOT THERE. `Math.round` reported thirty-six hours as "2 days" and twelve
 * hours as "1 day"; over a thirty-day session that reading was over by a day
 * for twelve hours out of every twenty-four. Rounding is right for an age --
 * src/local-activity.js whenWords() is looking backwards at something already
 * finished -- and wrong for a deadline, where the only safe error is to
 * understate. `${days} days` is now a floor: there really are that many whole
 * days left, and the hours past it are the person's margin rather than a
 * promise this screen made. The last day keeps the sentence it already had. */
export function expiryText(expiresAtMs, now = Date.now()) {
  if (!Number.isSafeInteger(expiresAtMs)) return ''
  const remainingMs = expiresAtMs - now
  if (remainingMs <= 0) return 'This sign-in has run out, and you sign in again to carry on.'
  const days = Math.floor(remainingMs / 86_400_000)
  if (days <= 0) return 'This sign-in expires today.'
  return `This sign-in expires in ${days} day${days === 1 ? '' : 's'}, and you sign in again then.`
}

export function statusMarkup({ notice = null, state = null } = {}) {
  if (notice) {
    /* THE ADDRESS THE BROWSER WAS SENT TO, when there is one.
     *
     * Rendered as TEXT inside <code>, never as a link: a clickable element
     * built from a string is one more thing that has to be right, and the
     * address is here precisely for the case where handing a URL to this
     * computer did not work. It is escaped like everything else. */
    const address = typeof notice.address === 'string' && notice.address
      ? `<span data-account-notice-address>If your browser did not open, use this address: <code>${esc(notice.address)}</code></span>`
      : ''
    return `<div class="fleet-profile-status ${notice.tone === 'good' ? 'is-good' : notice.tone === 'warn' ? 'is-warn' : 'is-serious'}" role="${notice.tone === 'good' ? 'status' : 'alert'}">
      <strong>${esc(notice.title)}</strong>
      <span>${esc(notice.detail)}</span>
      ${address}
    </div>`
  }
  /* is-warn, not is-serious: a sign-in that cannot be remembered across a
     relaunch is a working product with a stated limit, not a fault. */
  if (state?.available && state.canPersistSession === false) {
    return `<div class="fleet-profile-status is-warn" role="status">
      <strong>The computer you are driving cannot remember a sign-in.</strong>
      <span>The operating system on the computer you are driving did not offer the protected storage this uses. Signing in will last until you close the program, and you will be asked for it again next time. Everything else works normally.</span>
    </div>`
  }
  return ''
}

export function scopeMarkup({ subject = ACCOUNT_SCOPE_SUBJECT_HERE } = {}) {
  return `<div class="fleet-profile-status is-warn" role="status">
    <strong>${esc(ACCOUNT_SCOPE_LEAD)}</strong>
    ${accountScopeNotice({ subject }).map(paragraph => `<span>${esc(paragraph)}</span>`).join('')}
  </div>`
}

/* SIGN IN WITH GOOGLE: the first option on the screen.
 *
 * THREE STATES, NEVER TWO, for the same reason the payment row has three:
 * "available", "not available and here is which reason", and "not asked yet".
 * Collapsing the middle one into a hidden button is the failure this codebase
 * keeps finding -- an absence rendered as though somebody had chosen it. A
 * person who cannot use Google sign-in on this copy is TOLD SO, in a sentence,
 * with the account on this computer sitting right underneath it and working.
 *
 * THE DISABLED BUTTON IS DELIBERATE. Hiding it would leave somebody who was
 * told "sign in with Google" hunting for a control that is not there, and would
 * make the owner's one remaining setup step invisible. A control that says why
 * it cannot be used is a working screen; a missing control is a mystery.
 *
 * AND IT HAS TO LOOK DISABLED, which is the half that was missing and the half
 * a customer found. The owner installed 1.0.26 from the site, pressed this
 * button and reported that it did not work. Measured in the running window: the
 * button was `disabled` and therefore ate the click, while its computed style
 * was `cursor: pointer`, `opacity: 1`, the full .ctl-btn card and the base
 * `.ctl-btn:hover` lift -- indistinguishable from a live control. So the
 * sentence beside it was doing all the work and the control was quietly
 * contradicting it. The rule that makes the two agree is
 * [data-google-signin] .ctl-btn:disabled in src/fleet-profile-settings.css,
 * which src/views/account.js and src/views/setup.js both import, and
 * tools/test/google-signin-disabled-control.test.mjs holds it there. Every
 * state below that renders a `disabled` control depends on it.
 *
 * THE TEST-PROVIDER BANNER IS NOT DEBUG DRESSING. When a build is pointed at a
 * local identity provider instead of Google, this says so on the screen where
 * the sign-in happens. Without it a screenshot of a rehearsal is
 * indistinguishable from a screenshot of the real thing, and one of them would
 * eventually be filed as evidence for the other. */
function currentGoogleOptionMarkup({ google = null, busy = false, signingIn = busy, showCancel = true } = {}) {
  /* ONE PARAGRAPH, NOT TWO, and the reason is measured rather than aesthetic.
     As two `settings-desc` blocks this row was 90px tall and pushed the local
     form's "Create account" button to y=846 in an 832px window -- the primary
     action of the screen, off the bottom edge, on a default-size window. Same
     words, one block. */
  const description = `${esc(GOOGLE_SIGNIN_DESCRIPTION)} ${esc(GOOGLE_SIGNIN_SCOPE_NOTE)}`

  if (google === null) {
    return `<article class="settings-row" data-google-signin data-google-state="unknown">
      <div class="settings-copy">
        <div class="settings-name">${esc(GOOGLE_SIGNIN_LABEL)}</div>
        <div class="settings-desc">Checking whether this copy can sign in with Google…</div>
      </div>
      <div class="settings-control fleet-inline-control">
        <button type="button" class="ctl-btn" data-google-signin-start disabled>${esc(GOOGLE_SIGNIN_LABEL)}</button>
      </div>
    </article>`
  }

  if (google.available !== true) {
    const reason = google.reason || 'This copy did not say why.'
    /* THE BUTTON STAYS, DISABLED, AND THAT IS A DECISION RATHER THAN AN
     * OVERSIGHT. The 2026-08-22 triage lists it under "controls that cannot
     * work" and asks for it to be taken off this row.
     * tools/test/google-signin-disabled-control.test.mjs asks for the opposite,
     * in as many words: "Hiding it is not the repair: a person told to sign in
     * with Google would be hunting for a control that is not there." The defect
     * the owner actually reported on 1.0.26 was that the disabled button LOOKED
     * LIVE, and that is closed -- [data-google-signin] .ctl-btn:disabled in
     * src/fleet-profile-settings.css, held there by that suite. What was still
     * wrong on this row was the SENTENCE beside it, which was a build note
     * addressed to us; see shell/google-signin-config.cjs. */
    /* SAID ONCE. Some refusals already name the alternative -- the
       not-configured one does, because it also travels through channels that no
       screen wraps -- and appending it unconditionally printed the same sentence
       twice on the shipped screen. Measured on the packaged window before this
       line existed. */
    const alternative = /account on this computer/i.test(reason)
      ? ''
      : ' Making an account on this computer — the computer you are driving — using the form below works now and records the same thing.'
    return `<article class="settings-row" data-google-signin data-google-state="unavailable" data-google-code="${esc(google.code || '')}">
      <div class="settings-copy">
        <div class="settings-name">${esc(GOOGLE_SIGNIN_LABEL)} — not available on this copy</div>
        <div class="settings-desc">${esc(reason)}${alternative}</div>
      </div>
      <div class="settings-control fleet-inline-control">
        <button type="button" class="ctl-btn" data-google-signin-start disabled>${esc(GOOGLE_SIGNIN_LABEL)}</button>
      </div>
    </article>`
  }

  const testBanner = google.testProvider
    ? `<div class="fleet-profile-status is-serious" role="alert" data-google-test-provider>
        <strong>This copy is pointed at a test sign-in service, not at Google.</strong>
        <span>It will sign in against ${esc(google.testProvider.issuer)}. Nothing here reaches Google, and no real Google account is involved.</span>
      </div>`
    : ''

  const cancelControl = controlState({
    enabled: google.canCancel === true,
    why: 'This installed copy cannot cancel the Google sign-in. Close the browser window to cancel it.',
  })
  return `${testBanner}<article class="settings-row" data-google-signin data-google-state="available" data-google-source="${esc(google.source || '')}">
    <div class="settings-copy">
      <div class="settings-name">${esc(GOOGLE_SIGNIN_LABEL)}</div>
      <div class="settings-desc">${description}</div>
    </div>
    <div class="settings-control fleet-inline-control">
      <button type="button" class="ctl-btn" data-google-signin-start ${busy ? 'disabled' : ''}>${signingIn ? 'Waiting for your browser…' : esc(GOOGLE_SIGNIN_LABEL)}</button>
      ${signingIn && showCancel ? `<button type="button" class="ctl-btn" data-google-signin-cancel${cancelControl.disabled ? ` disabled title="${esc(cancelControl.why)}"` : ''}>Cancel</button>` : ''}
    </div>
    ${signingIn && showCancel && cancelControl.disabled ? `<div class="settings-desc">${esc(cancelControl.why)}</div>` : ''}
  </article>`
}

export function googleOptionMarkup(options = {}) {
  const primary = currentGoogleOptionMarkup(options)
  const local = options.google?.localProfile
  if (local?.exists !== true) return primary
  return primary + `<article class="settings-row" data-google-local-profile>
    <div class="settings-copy"><div class="settings-name">Previous Google profile</div>
      <div class="settings-desc">Open the settings and history saved under your previous Google sign-in on this computer.</div>
      ${local.available !== true ? `<div class="settings-desc">${esc(local.reason || 'This copy cannot open that profile right now.')}</div>` : ''}
      ${local.testProvider ? `<div class="fleet-profile-status is-serious" role="alert" data-google-test-provider>
        This previous profile uses a test sign-in service at ${esc(local.testProvider.issuer)}. No real Google account is involved.</div>` : ''}
    </div><div class="settings-control fleet-inline-control">
      <button type="button" class="ctl-btn" data-google-signin-legacy ${options.busy || local.available !== true ? 'disabled' : ''}>Open previous profile</button>
    </div></article>`
}

export function browserSignInMarkup(attempt = null) {
  if (!attempt) return ''
  const inBrowser = attempt.provider === 'google' || Boolean(attempt.address)
  const reason = 'This copy cannot cancel sign-in. Close the browser window and wait for the attempt to end.'
  return `<div class="fleet-profile-status is-warn" role="status" data-account-browser-wait>
    <strong>${inBrowser ? 'Finish signing in in your browser.' : 'Signing in…'}</strong>
    ${inBrowser ? '<span>Complete sign-in in the browser on the computer you are signing in to, then return here. Nothing is signed in until you do.</span>' : ''}
    ${attempt.address ? `<span data-account-notice-address>If your browser did not open, use this address: <code>${esc(attempt.address)}</code></span>` : ''}
    <button type="button" class="ctl-btn" data-account-signin-cancel${attempt.canCancel === true ? '' : ` disabled title="${esc(reason)}"`}>Cancel sign-in</button>
    ${attempt.canCancel === true ? '' : `<span>${esc(reason)}</span>`}
  </div>`
}

export function loadingMarkup() {
  return `<h1 class="setup-title">${esc(ACCOUNT_QUESTION)}</h1><p class="setup-subtitle">Reading accounts on the computer you are driving…</p>`
}

export function unavailableMarkup({ state = null, reset = {}, busy = false, notice = null } = {}) {
  const statusUnavailable = state?.code === 'HOSTED_ACCOUNT_STATUS_UNAVAILABLE'
  /* T1520: A DAMAGED ACCOUNT FILE NAMES ITSELF AND OFFERS A NARROW WAY BACK.
     The only action here used to be removing all of this program's data. */
  const damagedStore = state?.code === 'ACCOUNT_STORE_CORRUPT' || state?.code === 'ACCOUNT_STORE_UNREADABLE'
  return `<h1 class="setup-title">${esc(ACCOUNT_QUESTION)}</h1>
    ${notice ? statusMarkup({ notice }) : ''}
    <div class="fleet-profile-status is-serious" role="alert">
      <strong>${statusUnavailable ? 'Account status is temporarily unavailable. Press Retry status to check again.' : damagedStore ? 'The account file on this computer is damaged, so its sign-ins are unavailable.' : 'There is no account on this page to sign in to.'}</strong>
      <span>${esc(state?.reason || 'The application did not say why.')}</span>
    </div>
    ${damagedStore ? `<div class="settings-desc" data-account-damaged>Your settings, history and agents are kept. Set the damaged account file aside to create an account or sign in again; it is kept beside the new one, unchanged. Local accounts that were in it are not moved over.</div>
    <button type="button" class="ctl-btn" data-account-set-aside${busy ? ' disabled' : ''}>${busy ? 'Setting it aside…' : 'Set the damaged account file aside'}</button>` : ''}
    ${statusUnavailable ? `<button type="button" class="ctl-btn" data-account-status-retry${busy ? ' disabled' : ''}>${busy ? 'Checking status…' : 'Retry status'}</button>` : ''}
    <!-- THE WAY OUT SURVIVES THE WAY IN BEING BROKEN. A copy that cannot open
         its account store is exactly when somebody wants their data off this
         computer, and gating removal behind a sign-in that cannot happen would
         be the product holding it hostage. -->
    <!-- ...AND SO DOES THE WAY TO THE PLANS. This screen is what a person gets
         when this copy cannot open its account store, and when the page is
         opened in a browser rather than in the installed application. Neither
         of those has anything to do with what is sold. Prices are not something
         a broken sign-in should be able to hide. -->
    <!-- THE SAME SECTION THE SIGNED-OUT SCREEN GIVES THESE TWO, and the same
         name, because on this screen the heading is even truer: these are
         exactly the two things that never needed the account store to work. -->
    ${sectionMarkup('Without an account', [
      resetMarkup({ reset, busy }),
    ], 'data-reset-block')}
    <div class="setup-actions">
      <div class="setup-actions-spacer"></div>
      <button type="button" class="ctl-btn" data-account-home>Back to ToolsEnabled</button>
    </div>`
}

function dateText(atMs) {
  if (!Number.isSafeInteger(atMs) || atMs <= 0) return ''
  try {
    return new Date(atMs).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  } catch {
    return ''
  }
}

/* WHAT IS YOURS ON THIS COMPUTER, said in the three sentences the product can
 * actually stand behind.
 *
 * SETTINGS. A count and, when it happened, the fact that they were adopted from
 * this computer when the account was made. That second sentence exists because
 * a person who has been using this program for months and then creates an
 * account needs to know that what was already here became THEIRS, rather than
 * wondering whether it was thrown away or is still shared with whoever else
 * signs in.
 *
 * HISTORY. Counted from the ledger's own records by principal. It says "of N on
 * this computer" so the number is honest about being a slice: the ledger is one
 * signed append-only file per device and is deliberately not partitioned, so
 * some of the runs on this machine are not yours and the screen says so.
 *
 * THE CARD. Three states, never two. "On file", "attached but this
 * installation's vault does not hold it", and "could not check" are different
 * facts and the middle one is REAL on this machine. Collapsing any of them into
 * "no card on file" would be the product making a claim about his money that it
 * did not verify.
 *
 * NOTHING RENDERED HERE IS A CARD DETAIL. The only payment value in scope is the
 * vault KEY NAME, and the only thing done with it is to say a record is on file
 * -- there is no number, no expiry, no last-four and no token anywhere in this
 * function or in the object it is given. */
/* WHY NEITHER ACCOUNT SCREEN HAS A SUBSCRIPTION ROW, and why this note is a JS
 * comment rather than an HTML one: an HTML comment inside these templates is
 * delivered to every browser that loads the page, and the first version of this
 * note quoted the advert's own words -- so the removal would have shipped the
 * exact string it removed. The guard in
 * tools/test/product-account-surface.test.mjs reads the RENDERED markup and
 * caught it, which is the guard doing its job.
 *
 * THE SUBSCRIPTION ROW IS GONE, not merely unrendered. Owner, 2026-08-26:
 * "i dont want to advertise subscriptions in the app." A markup function that
 * still returns a ready-made "Subscriptions coming soon" control is what the
 * next surface calls; leaving it here would have made the removal a decision
 * somebody could undo without reading the ruling. See src/views/home.js, which
 * dropped its own copy of this control on the same ruling. */

export function cartMarkup({ cart = null } = {}) {
  const head = '<div class="settings-name">Your purchase list</div>'
  const open = '<div class="settings-control fleet-inline-control"><a class="ctl-btn" href="#/ledger?tab=p" data-account-cart-link>Open your purchase list</a></div>'

  if (cart === null) {
    return `<article class="settings-row" data-account-cart data-cart-state="reading">
      <div class="settings-copy">${head}
        <div class="settings-desc">Reading what is waiting for you to decide…</div>
      </div>${open}
    </article>`
  }

  if (cart.readable !== true) {
    return `<article class="settings-row" data-account-cart data-cart-state="unread">
      <div class="settings-copy">${head}
        <div class="settings-desc">This screen could not read your list just now, so it does not say what is on it. That is not the same as the list being empty. Open it to look again.</div>
      </div>${open}
    </article>`
  }

  /* EMPTY IS SCOPED, BECAUSE THIS SCREEN CAN ONLY SEE ONE INSTALLATION.
   *
   * WHAT THIS COPY READS, MEASURED. The running app pins to the capability layer
   * its own shell started, and that layer's state root is <userData>/capability
   * -- set in shell/main.cjs, and set there for a load-bearing reason: derived
   * any other way it landed in the INSTALL directory, where a measured session
   * left a live bearer token, the signed audit ledger and the customer's
   * credential vault in a folder the next update deletes. So the queue this row
   * reads is THIS INSTALLATION'S queue, and there is no supported way for it to
   * be any other -- the renderer deliberately does not scan for local bridges,
   * because discovery-by-guess is how this boot's bootstrap proof gets handed to
   * whatever squats a lower port.
   *
   * WHY THE SENTENCE CHANGED. Unqualified, "Nothing is waiting to be bought" is
   * a claim about the reader's affairs, and this screen is not in a position to
   * make it. Measured on this machine while that sentence was being written: the
   * app's own store held 0 prompts and the engine's store held 10, including 2
   * shopping lists whose lines are denied by the calendar on 2026-08-18. The row
   * would have told him his money decisions were settled six days before four of
   * them expired -- which is the exact failure the "not asked yet" state above
   * exists to prevent, arriving through the other door.
   *
   * IT IS NOT A HEDGE AND IT IS NOT AN APOLOGY. For somebody with one copy it
   * reads as a plain true statement and costs them a clause. For somebody whose
   * list is somewhere else it is the difference between being told nothing is
   * wrong and being told where to look. Both readers get a sentence that is
   * true, which is the only version worth shipping on a money surface. */
  if (cart.cartCount === 0) {
    const others = cart.waitingCount > 0
      ? ` ${esc(String(cart.waitingCount))} other request${cart.waitingCount === 1 ? '' : 's'} still ${cart.waitingCount === 1 ? 'wants' : 'want'} an answer from you.`
      : ''
    return `<article class="settings-row" data-account-cart data-cart-state="empty">
      <div class="settings-copy">${head}
        <div class="settings-desc">Nothing is waiting to be bought on this copy of ToolsEnabled.${others}</div>
        <div class="settings-desc" data-account-cart-scope>This screen reads the list this installation holds, and no other. A purchase list raised on a different copy is not on this one, and would not appear here.</div>
      </div>${open}
    </article>`
  }

  /* THE TOTAL, OR THE REASON THERE IS NOT ONE. Two currencies get no invented
     exchange rate, so the sentence changes shape rather than showing a number
     that was arrived at by guessing. */
  const money = cart.totalText === null
    ? `${esc(String(cart.cartCount))} list${cart.cartCount === 1 ? '' : 's'}, priced in more than one currency, so no single total is shown here.`
    : `${esc(String(cart.lineCount))} line${cart.lineCount === 1 ? '' : 's'} across ${esc(String(cart.cartCount))} list${cart.cartCount === 1 ? '' : 's'}, ${esc(cart.totalText)} if you approve every one.`

  /* THE DATE, AND WHAT THE DATE DOES. Four of the things waiting on his real
     queue are refused by the calendar rather than by him, and no surface in
     this product said so until now. */
  const clock = cart.soonest === null ? '' : `<div class="settings-desc" data-account-cart-deadline>
        <strong>${esc(cart.soonest.deadline)}</strong> ${esc(cart.soonest.title)}${cart.soonest.deadlineDate ? ` — ${esc(cart.soonest.deadlineDate)}` : ''}
      </div>
      <div class="settings-desc" data-account-cart-consequence>${esc(cart.soonest.doNothing)}</div>`

  return `<article class="settings-row" data-account-cart data-cart-state="waiting">
    <div class="settings-copy">${head}
      <div class="settings-desc" data-account-cart-total>${money}</div>
      ${clock}
      <div class="settings-desc" data-account-cart-spend>${esc(cart.spendNotice)}</div>
    </div>${open}
  </article>`
}

/* TWO SECTIONS, NOT ONE RUN OF FIVE ROWS, and the split is the point rather
 * than a tidy-up. "Your settings" and "Your history" answer "what of mine is
 * held here"; the card, the purchase list and the plans answer "what is about
 * to be spent, and with what". A person arrives on this screen with one of
 * those two questions, never both, and until the headings existed the five rows
 * were one undifferentiated block they had to read end to end to find out which
 * ones were theirs. */
export function belongingsMarkup({ data = null, payment = null, history = null, cart = null } = {}) {
  const yours = []
  const money = []

  if (data && data.ok === true) {
    const adopted = data.adopted && data.adopted.count > 0
      ? ` They were already on the computer you are driving when you made this account, and became yours on ${esc(dateText(data.adopted.atMs))}.`
      : ''
    yours.push(`<article class="settings-row" data-account-data-settings>
      <div class="settings-copy">
        <div class="settings-name">Your settings</div>
        <div class="settings-desc">${data.settingCount === 0
          ? 'Nothing recorded against this account yet. Choices you make are kept for you and not for whoever else uses the computer you are driving. That covers theme, first-run answers, and what your assistant may do without asking.'
          : `${esc(String(data.settingCount))} recorded against this account, kept for you and not for whoever else uses the computer you are driving.${adopted}`}</div>
      </div>
    </article>`)
  } else {
    yours.push(`<article class="settings-row" data-account-data-settings>
      <div class="settings-copy">
        <div class="settings-name">Your settings</div>
        <div class="settings-desc">Could not be read on the computer you are driving, so this does not say how many there are. ${esc((data && data.reason) || '')}</div>
      </div>
    </article>`)
  }

  if (history && Number.isSafeInteger(history.mine)) {
    yours.push(`<article class="settings-row" data-account-data-history>
      <div class="settings-copy">
        <div class="settings-name">Your history</div>
        <div class="settings-desc">${history.mine === 0
          ? `Nothing recorded against you yet. The computer you are driving has ${esc(String(history.total))} recorded run${history.total === 1 ? '' : 's'} in total; runs started from now on will say your name.`
          : `${esc(String(history.mine))} of the ${esc(String(history.total))} run${history.total === 1 ? '' : 's'} recorded on the computer you are driving were started by you. The record is one signed file for the computer you are driving, so the rest were started by another sign-in or before anybody signed in. It is not split up, and no account can quietly remove its own.`}</div>
      </div>
    </article>`)
  }

  if (payment && payment.ok === true && payment.attached === true) {
    if (payment.present === true) {
      money.push(`<article class="settings-row" data-account-data-payment data-payment-state="on-file">
        <div class="settings-copy">
          <div class="settings-name">Your payment method</div>
          <div class="settings-desc">A card is on file for this account. It is held encrypted by Windows in this installation’s own vault, under <code>${esc(payment.vaultKey)}</code>, and this screen has not read it — no number, expiry or security code is shown here or anywhere else in this program.</div>
        </div>
      </article>`)
    } else if (payment.checked === true) {
      /* THE MIDDLE STATE, and the reason this function has three branches. The
         binding exists and this installation's vault does not hold the record.
         "No card on file" would be false; so would "on file". */
      money.push(`<article class="settings-row" data-account-data-payment data-payment-state="attached-not-here">
        <div class="settings-copy">
          <div class="settings-name">Your payment method</div>
          <div class="settings-desc">A card is attached to this account under <code>${esc(payment.vaultKey)}</code>, but this installation’s own vault does not hold that record, so it cannot be used from here yet. This is not the same as having no card.</div>
        </div>
      </article>`)
    } else {
      money.push(`<article class="settings-row" data-account-data-payment data-payment-state="unknown">
        <div class="settings-copy">
          <div class="settings-name">Your payment method</div>
          <div class="settings-desc">A card is attached to this account under <code>${esc(payment.vaultKey)}</code>. The computer you are driving could not read its vault just now, so whether the record is there is unknown — which is not the same as it being gone. ${esc(payment.detail || '')}</div>
        </div>
      </article>`)
    }
  } else if (payment && payment.ok === true) {
    money.push(`<article class="settings-row" data-account-data-payment data-payment-state="none">
      <div class="settings-copy">
        <div class="settings-name">Your payment method</div>
        <div class="settings-desc">No card is attached to this account. Nothing in this program can charge anything without one, and attaching one is not a payment.</div>
      </div>
    </article>`)
  } else {
    money.push(`<article class="settings-row" data-account-data-payment data-payment-state="unknown">
      <div class="settings-copy">
        <div class="settings-name">Your payment method</div>
        <div class="settings-desc">This copy could not check whether a card is attached, so it does not say. Unknown is not the same as none.</div>
      </div>
    </article>`)
  }

  /* Directly under the card, because what is about to be spent and what it
     would be spent with are one subject to the person reading them. */
  money.push(cartMarkup({ cart }))

  /* NO SUBSCRIPTION ROW. It used to sit here, next to the card. See the note in
     the signed-out section above: the owner asked that the product stop
     advertising subscriptions, and a row under "Money" is the most advertising
     placement there was. */

  /* "What is yours" first, because it is the section a person arrives on this
     screen for; money second, because it is the one they arrive on it to act
     on and an action belongs under the facts it depends on. */
  return sectionMarkup('What is yours on the computer you are driving', yours)
    + sectionMarkup('Money', money)
}

/* THE NAME THIS PROGRAM SHOWS, AND THE CONTROL THAT CHANGES IT.
 *
 * It is a row of its own rather than a line inside the Account row above,
 * because those two say different things and a person acts on only one of them.
 * The Account row says WHO the account is -- the username you sign in with, or
 * the address Google verified -- and neither of those can be edited here. This
 * row says what the product CALLS you, which is the part that is yours.
 *
 * WHY IT SHIPS AT ALL. Before it, the display name was written once and never
 * again. The first-run walkthrough creates the account with an empty one, so
 * the username became the permanent label on every record of that person's work
 * for the life of the account; a Google account got the verified email address,
 * in full, on every approval record. There was no screen anywhere in the
 * product that could change either.
 *
 * IT IS SHOWN FOR A GOOGLE ACCOUNT TOO, and that is deliberate rather than
 * incidental. The password row below is hidden for Google accounts because
 * there is no password here to change. A display name is not in that class:
 * it is held on this computer for both kinds of account, and the person whose
 * records read as a 30-character email address is the one who needs this most.
 */
export function shownAsMarkup({ state, busy = false } = {}) {
  /* SAID, NOT INFERRED. `displayName` falls back to the username in
     src/account-state.js, so "Josh" and "josh_p" arrive here as the same kind
     of string and a screen that printed only the value would leave a person
     unable to tell whether they had ever chosen one. The two sentences differ
     so that the answer to "did I set this?" is on the screen. */
  const chosen = state.displayName !== state.username
  return `<article class="settings-row" data-account-shown-as>
      <div class="settings-copy">
        <div class="settings-name">Shown as</div>
        <div class="settings-desc">${chosen
          ? `This program calls you ${esc(state.displayName)}, and that name goes on the record of what your assistant does. Change it as often as you like — the record keeps every past entry exactly as it was.`
          : `This program calls you ${esc(state.displayName)}, which is the name you sign in with, because no other one was ever chosen. Change it as often as you like — the record keeps every past entry exactly as it was.`}</div>
      </div>
      <div class="settings-control fleet-inline-control">
        <button type="button" class="ctl-btn" data-account-mode="display-name" ${busy ? 'disabled' : ''}>Change</button>
      </div>
    </article>`
}

/* REMOVING EVERYTHING, AS A PLACE ON THE SCREEN.
 *
 * IT IS RENDERED WHETHER OR NOT SOMEBODY IS SIGNED IN, and that is the whole
 * reason it lives on this screen rather than inside the signed-in block. A
 * person who never made an account still has a vault, an audit ledger, a
 * permission level and a settings file on their disk; a person who has forgotten
 * their password cannot sign in to reach a control that removes their data, and
 * "sign in before you may delete your data" is a sentence no product should be
 * able to say. It is rendered on the unavailable screen too: an account store
 * this copy cannot open is exactly when somebody wants out.
 *
 * FOUR STATES, AND THE SECOND ONE IS THE POINT. `idle` offers to LOOK. `confirm`
 * shows what was measured a moment ago and what survives, and only that state
 * carries a button that destroys anything. So the first press cannot delete, and
 * the second press cannot happen before the person has seen the list.
 *
 * THE RESULT STATE NAMES WHAT STAYED. Not "done" -- what stayed, by file name,
 * with the folder it is in, because on Windows something usually does.
 */
export function resetMarkup({ reset = {}, busy = false, subject = reset.subject || RESET_SUBJECT_HERE, platform = reset.platform } = {}) {
  const phase = typeof reset.phase === 'string' ? reset.phase : 'idle'
  const head = `<div class="settings-name">${esc(RESET_TITLE)}</div>`

  if (phase === 'unavailable') {
    return `<article class="settings-row" data-reset data-reset-phase="unavailable">
      <div class="settings-copy">
        ${head}
        <div class="settings-desc"><strong>${esc(NO_BRIDGE_TITLE)}</strong> ${esc(NO_BRIDGE_DETAIL)}</div>
      </div>
    </article>`
  }

  if (phase === 'measuring' || phase === 'working') {
    return `<article class="settings-row" data-reset data-reset-phase="${phase}">
      <div class="settings-copy">
        ${head}
        <div class="settings-desc">${phase === 'measuring'
          ? 'Measuring what is on the computer you are driving right now. Nothing has been deleted.'
          : 'Deleting. Leave this window open until it finishes — it says what was removed and what was not.'}</div>
      </div>
    </article>`
  }

  if (phase === 'confirm') {
    const plan = reset.plan || { available: false, roots: [], untouched: [], totals: { files: 0, bytes: 0 } }
    if (!plan.available) {
      return `<article class="settings-row" data-reset data-reset-phase="confirm" data-reset-plan-state="unavailable">
        <div class="settings-copy">
          ${head}
          <div class="settings-desc" tabindex="-1" data-reset-focus><strong>Nothing was measured, so nothing is offered.</strong> ${esc(plan.reason || 'This copy did not say why.')} Your data is exactly as it was.</div>
        </div>
        <div class="settings-control fleet-inline-control">
          <button type="button" class="ctl-btn" data-reset-cancel>${esc(DELETE_CANCEL_BUTTON)}</button>
        </div>
      </article>`
    }
    /* Built OUTSIDE the template rather than as a ternary inside it. The guard
       in tools/test/refusal-copy.test.mjs reads a `${...}` expression containing
       the word "code" as a refusal code interpolated into a sentence, and an
       inline `<code>` tag inside the braces looks exactly like one. Hoisting it
       keeps the scanner's job easy, which is the right trade against a scanner
       whose false negatives cost a customer a machine code on their screen. */
    const monospace = value => `<code>${esc(value)}</code>`
    const measured = planLines(plan).map(line => {
      const where = line.directory ? ` ${monospace(line.directory)}` : ''
      return `<div class="settings-desc" data-reset-line data-reset-tone="${line.tone}">
        <strong>${esc(line.title)}</strong> — ${esc(line.detail)}${where}
      </div>`
    }).join('')
    const yours = plan.untouched.filter(entry => entry.kind === 'workspace')
    const survives = survivesLines({ subject, platform }).map(entry => {
      const named = entry.title === 'Your own files' && yours.length > 0
        ? ` ${yours.map(folder => monospace(folder.directory)).join(' ')}`
        : ''
      return `<div class="settings-desc" data-reset-survives><strong>${esc(entry.title)}</strong> — ${esc(entry.detail)}${named}</div>`
    }).join('')
    /* THE ONE CASE WHERE THE SURVIVOR SENTENCE ABOVE WOULD BE FALSE, said
       immediately under it rather than left to be discovered afterwards. A
       folder the person chose for their own work can sit inside the directory
       this is about to empty, and then it goes with it. */
    const conflicts = (plan.conflicts || []).length > 0
      ? `<div class="fleet-profile-status is-serious" role="alert" data-reset-conflict>
          <strong>One folder you chose for your own work is inside what would be deleted.</strong>
          <span>${plan.conflicts.map(entry => esc(entry.directory)).join(', ')} — it would be deleted too, work and all. Move it somewhere else before you press this if you want to keep it.</span>
        </div>`
      : ''
    return `<article class="settings-row" data-reset data-reset-phase="confirm" data-reset-plan-state="measured">
      <div class="settings-copy">
        ${head}
        <div class="settings-desc" tabindex="-1" data-reset-focus data-reset-total>Measured just now: ${esc(String(plan.totals.files))} file${plan.totals.files === 1 ? '' : 's'} would be deleted.</div>
        ${measured}
        <div class="settings-name" data-reset-survives-head>What this does NOT delete</div>
        ${survives}
        ${conflicts}
        <div class="settings-desc" data-reset-backup><strong>${esc(BACKUP_NOTICE)}</strong></div>
      </div>
      <div class="settings-control fleet-inline-control">
        <button type="button" class="ctl-btn" data-reset-cancel ${busy ? 'disabled' : ''}>${esc(DELETE_CANCEL_BUTTON)}</button>
        <button type="button" class="ctl-btn" data-reset-confirm ${busy ? 'disabled' : ''}>${esc(DELETE_CONFIRM_BUTTON)}</button>
      </div>
    </article>`
  }

  if (phase === 'done') {
    const sweep = reset.sweep || { ran: false, complete: false, roots: [] }
    const outcome = outcomeLines(sweep, { subject, platform })
    const kept = (sweep.roots || []).filter(root => root.kept.length > 0).map(root => `<div class="settings-desc" data-reset-kept>
        <strong>${esc(rootLabel(root.kind))}</strong> — still on the computer you are driving in <code>${esc(root.directory)}</code>: ${esc(root.kept.map(entry => entry.name).join(', '))}.
      </div>`).join('')
    return `<article class="settings-row" data-reset data-reset-phase="done" data-reset-outcome="${outcome.tone}">
      <div class="settings-copy">
        ${head}
        <div class="fleet-profile-status ${outcome.tone === 'good' ? 'is-good' : outcome.tone === 'warn' ? 'is-warn' : 'is-serious'}" role="${outcome.tone === 'good' ? 'status' : 'alert'}">
          <strong>${esc(outcome.title)}</strong>
          <span>${esc(outcome.detail)}</span>
        </div>
        ${kept}
      </div>
      <div class="settings-control fleet-inline-control">
        <button type="button" class="ctl-btn" data-reset-close>${esc(DELETE_CLOSE_BUTTON)}</button>
      </div>
    </article>`
  }

  return `<article class="settings-row" data-reset data-reset-phase="idle">
    <div class="settings-copy">
      ${head}
      <div class="settings-desc">${esc(RESET_LEAD)}</div>
    </div>
    <div class="settings-control fleet-inline-control">
      <button type="button" class="ctl-btn" data-reset-plan ${busy ? 'disabled' : ''}>${esc(DELETE_BUTTON)}</button>
    </div>
  </article>`
}

/* FOUR SECTIONS, NOT TEN ROWS IN A ROW.
 *
 * Measured before the grouping, on a real 1002x650 window: one list, ten rows,
 * no heading anywhere on the screen, and "Change password", "Sign out" and
 * "Remove this program's data from this computer" drawn as three adjacent
 * identical rows -- the one that cannot be undone looking exactly like the two
 * that can.
 *
 * THE GROUPS ARE WHAT A PERSON CAME TO DO, not which builder emits the row.
 * Who you are · What is yours on this computer · Money · Leaving. Every one of
 * them holds at least two rows: a heading over a single row is a category the
 * screen invented, and this codebase already refuses that one level up (see the
 * six empty settings headings removed on 2026-08-20).
 *
 * LEAVING IS LAST AND IS THE ONLY SECTION HOLDING SOMETHING IRREVERSIBLE, which
 * is the whole reason the rule above it is worth the 24px it costs.
 */
export function signedInMarkup({ state, busy = false, notice = null, now = Date.now(), data = null, payment = null, history = null, cart = null, reset = {} } = {}) {
  const accountRow = `<article class="settings-row">
        <div class="settings-copy">
          <div class="settings-name">Account</div>
          <div class="settings-desc">${state.signInMethod === 'hosted'
            ? `${esc(state.username)} — your ToolsEnabled account, checked by toolsenabled.ai. Settings and work history on this computer belong to this account.`
            : state.signInMethod === 'google'
            /* NOT "an account on this computer only". The account IS held here,
               but who it belongs to was decided by Google, and printing the
               local-only sentence over a Google identity would be telling
               somebody their sign-in is weaker than it is. Found by reading the
               packaged screen, not by reading the code. */
            ? `${esc(state.verifiedEmail || state.username)} — an account on the computer you are driving, and Google is what checked who you are. While Signed activity audit is on, work your assistant does is recorded against it. ${esc(expiryText(state.expiresAtMs, now))}`
            : `${esc(state.username)} — an account only on the computer you are driving. While Signed activity audit is on, work your assistant does is recorded against it. ${esc(expiryText(state.expiresAtMs, now))}`}</div>
        </div>
      </article>`

  const signInMethodRow = state.signInMethod === 'hosted'
    ? `<article class="settings-row" data-account-signin-method="hosted"><div class="settings-copy"><div class="settings-name">How you sign in</div><div class="settings-desc">With your ToolsEnabled account. Manage its password and account security at toolsenabled.ai.</div></div></article>`
    : state.signInMethod === 'google'
    /* A GOOGLE ACCOUNT IS NOT OFFERED A PASSWORD CHANGE, because it has no
       password on this computer to change. Showing the control and refusing
       on press would send somebody hunting for a password they never set;
       the store refuses it too (ACCOUNT_GOOGLE_NO_PASSWORD), so the screen
       and the store agree rather than one covering for the other. */
    ? `<article class="settings-row" data-account-signin-method="google">
        <div class="settings-copy">
          <div class="settings-name">How you sign in</div>
          <div class="settings-desc">With Google, as <code>${esc(state.verifiedEmail || state.username)}</code>. Google checked that address, so there is no password here to change — change it in your Google account. This program holds no Google password and no Google token.</div>
        </div>
      </article>`
    : `<article class="settings-row" data-account-signin-method="local">
        <div class="settings-copy">
          <div class="settings-name">Change password</div>
          <div class="settings-desc">Changing it signs you out on the computer you are driving. Every other sign-in to this account ends too, including any that was copied off that computer.</div>
        </div>
        <div class="settings-control fleet-inline-control">
          <button type="button" class="ctl-btn" data-account-mode="change-password" ${busy ? 'disabled' : ''}>Change password</button>
        </div>
      </article>`

  const signOutRow = `<article class="settings-row">
        <div class="settings-copy">
          <div class="settings-name">Sign out</div>
          <div class="settings-desc">“Sign out” ends this sign-in on the computer you are driving. “Sign out everywhere” also refuses any saved sign-in taken from that computer earlier — use it if you think a copy of it exists.</div>
          <!-- WHAT SIGNING OUT DOES NOT DO. Both buttons above are reversible and
               neither deletes anything, and until this line existed the screen
               left somebody to guess which -- next to a "delete everything" that
               is genuinely permanent, guessing is not acceptable. -->
          <div class="settings-desc" data-account-sign-out-limits>${esc(signOutLimits(state.signInMethod))}</div>
        </div>
        <div class="settings-control fleet-inline-control">
          <button type="button" class="ctl-btn" data-account-sign-out ${busy ? 'disabled' : ''}>${busy ? 'Working…' : 'Sign out'}</button>
          <button type="button" class="ctl-btn" data-account-sign-out-everywhere ${busy ? 'disabled' : ''}>Sign out everywhere</button>
        </div>
      </article>`

  return `<h1 class="setup-title">Signed in as ${esc(state.displayName)}</h1>
    ${statusMarkup({ notice, state })}
    ${sectionMarkup('Who you are', [accountRow, shownAsMarkup({ state, busy }), signInMethodRow])}
    ${belongingsMarkup({ data, payment, history, cart })}
    ${sectionMarkup('Leaving', [signOutRow, resetMarkup({ reset, busy })])}
    <div class="setup-actions">
      <div class="setup-actions-spacer"></div>
      <button type="button" class="ctl-btn" data-account-home>Back to ToolsEnabled</button>
    </div>`
}

export function changePasswordMarkup({ state, busy = false, notice = null } = {}) {
  return `<h1 class="setup-title">Change your password</h1>
    ${statusMarkup({ notice, state })}
    <form class="settings-section-rows" data-account-form="change-password" autocomplete="on">
      <input type="text" name="username" value="${esc(state.username)}" autocomplete="username" hidden readonly aria-hidden="true" tabindex="-1"/>
      <article class="settings-row">
        <div class="settings-copy">
          <div class="settings-name" id="account-current-label">Current password</div>
          <div class="settings-desc">Asked for even though you are signed in, so an unlocked window left alone is not enough to take the account over.</div>
        </div>
        <div class="settings-control fleet-inline-control">
          <input class="fleet-profile-input" type="password" name="currentPassword" autocomplete="current-password" aria-labelledby="account-current-label" ${busy ? 'disabled' : ''}/>
        </div>
      </article>
      <article class="settings-row">
        <div class="settings-copy">
          <div class="settings-name" id="account-new-label">New password</div>
          <div class="settings-desc">At least ${MIN_PASSWORD_LENGTH} characters. Length is what makes a password hard to guess — a few unrelated words beat a short one with symbols in it.</div>
        </div>
        <div class="settings-control fleet-inline-control">
          <input class="fleet-profile-input" type="password" name="newPassword" autocomplete="new-password" aria-labelledby="account-new-label" ${busy ? 'disabled' : ''}/>
        </div>
      </article>
      <!-- TYPED TWICE, because this is the one password that cannot be got
           back. A local account has no reset and the change ends every
           sign-in at once, so a slip in a single hidden field used to lock
           the account and everything recorded against it (T1589). The two
           are compared on this page before anything is sent. -->
      <article class="settings-row">
        <div class="settings-copy">
          <div class="settings-name" id="account-new-again-label">New password again</div>
          <div class="settings-desc">Type the new password once more. Both have to match before the password is changed, so a typing slip does not lock you out of this account.</div>
        </div>
        <div class="settings-control fleet-inline-control">
          <input class="fleet-profile-input" type="password" name="newPasswordAgain" autocomplete="new-password" aria-labelledby="account-new-again-label" ${busy ? 'disabled' : ''}/>
        </div>
      </article>
      <div class="setup-actions">
        <button type="button" class="ctl-btn" data-account-mode="signed-in" ${busy ? 'disabled' : ''}>Back</button>
        <div class="setup-actions-spacer"></div>
        <button type="submit" class="ctl-btn" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Change password'}</button>
      </div>
    </form>`
}

/* CHANGING THE SHOWN NAME.
 *
 * NO PASSWORD IS ASKED FOR, and that is a judgement rather than an oversight.
 * The change-password form next door asks for the current password because an
 * unattended unlocked window must not be enough to take an account over
 * permanently. A rename takes nothing over: it cannot sign anybody in, cannot
 * move a past record -- those are keyed on the account id, not on this string --
 * and is undone by typing the old name back. Asking for a password to correct a
 * typo would be security theatre charged to the person who least deserves it.
 *
 * THE FIELD IS PREFILLED WITH THE CURRENT NAME, so the common act is editing
 * what is there rather than retyping it, and so an empty field is unmistakably
 * something the person did.
 *
 * AND THE EMPTY FIELD'S MEANING IS PRINTED ABOVE IT, not left to be discovered.
 * Blank means "go back to my username", stated with the username in it. An
 * absence that quietly means something is this codebase's signature defect; an
 * absence that says out loud what it means is a choice.
 */
export function changeDisplayNameMarkup({ state, busy = false, notice = null } = {}) {
  return `<h1 class="setup-title">What should this program call you?</h1>
    ${statusMarkup({ notice, state })}
    <form class="settings-section-rows" data-account-form="display-name" autocomplete="off">
      <article class="settings-row">
        <div class="settings-copy">
          <div class="settings-name" id="account-shown-as-label">Shown as</div>
          <div class="settings-desc">This is the name on the record of what your assistant does from now on. Leave it empty to go back to being shown as <code>${esc(state.username)}</code>.</div>
        </div>
        <div class="settings-control fleet-inline-control">
          <input class="fleet-profile-input" type="text" name="displayName" value="${esc(state.displayName)}" autocomplete="nickname" aria-labelledby="account-shown-as-label" ${busy ? 'disabled' : ''}/>
        </div>
      </article>
      <article class="settings-row">
        <div class="settings-copy">
          <div class="settings-name">What this does not change</div>
          <div class="settings-desc">${state.signInMethod === 'google'
            ? 'You still sign in with Google, as the same address. Every past entry in the record stays exactly as it was written. This program keeps them by account and not by name, so renaming yourself never re-labels or hides anything you already did.'
            : `You still sign in as ${esc(state.username)}, with the same password. Every past entry in the record stays exactly as it was written. This program keeps them by account and not by name, so renaming yourself never re-labels or hides anything you already did.`}</div>
        </div>
      </article>
      <div class="setup-actions">
        <button type="button" class="ctl-btn" data-account-mode="signed-in" ${busy ? 'disabled' : ''}>Back</button>
        <div class="setup-actions-spacer"></div>
        <button type="submit" class="ctl-btn" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save this name'}</button>
      </div>
    </form>`
}

/* THE SIGNED-OUT SCREEN, IN TWO SECTIONS INSTEAD OF FOUR UNLABELLED LISTS.
 *
 * WHAT WAS WRONG WITH THE NESTING, measured rather than judged. Three different
 * levels of this screen were drawn as the same 11px uppercase micro-label: the
 * page's LEDE (ACCOUNT_QUESTION_SUB, which belongs to the h1 above it) and the
 * "Or use an account on this computer" DIVIDER between the two ways to sign in.
 * A reader had no way to tell which of them opened a section and which was a
 * sentence about the title. Below them sat two more lists of one row each --
 * Subscriptions and the removal control -- with no heading at all, landing under
 * the sign-in form as though they were more of it.
 *
 * SO EACH ONE GOES BACK TO ITS OWN LEVEL. The lede becomes `.setup-lede`, which
 * src/setup.css already declares for exactly that job. The divider becomes the
 * body sentence it always was, in the `settings-section-note host-absent-body`
 * pairing src/views/settings.js uses for a sentence under a section title. Only
 * the two real sections get `.settings-section-title`.
 *
 * "How you sign in" HOLDS TWO LISTS AND THAT IS NOT A THIRD NESTING LEVEL. They
 * are two ANSWERS to one question with an "Or" between them, which is what the
 * divider has always said; the form has to be its own <form> element and cannot
 * be folded into the list above it. The heading is what was missing.
 *
 * "Without an account" IS THE HONEST NAME FOR THE OTHER TWO, and the reason is
 * already written beside each of them: somebody who is not signed in can still
 * see what is sold, and can still take their data off this computer. That
 * shared reason is the section, and it is why neither has to stand alone as a
 * category of one.
 */
export function formMarkup({ mode = 'sign-in', busy = false, notice = null, state = null, google = null, browserSignIn = null, reset = {} } = {}) {
  const creating = mode === 'create'
  return `<h1 class="setup-title">${esc(ACCOUNT_QUESTION)}</h1>
    <p class="setup-lede">${esc(ACCOUNT_QUESTION_SUB)}</p>
    ${statusMarkup({ notice, state })}
    ${browserSignInMarkup(browserSignIn)}
    <h2 class="settings-section-title">How you sign in</h2>
    <div class="settings-section-rows" data-account-google-block>
      ${googleOptionMarkup({ google, busy, signingIn: browserSignIn?.provider === 'google', showCancel: false })}
    </div>
    <p class="settings-section-note host-absent-body" data-account-or>${google && google.available === true
      ? 'Or sign in with your ToolsEnabled email and password, or a local account.'
      : 'Sign in with your ToolsEnabled email and password, or a local account.'}</p>
    <form class="settings-section-rows" data-account-form="${creating ? 'create' : 'sign-in'}" autocomplete="on">
      <article class="settings-row">
        <div class="settings-copy">
          <div class="settings-name" id="account-username-label">${creating ? 'Local account name' : 'Email or local account name'}</div>
          <div class="settings-desc">${creating
            ? 'Letters, numbers, and . _ - between them. This is what the record of your assistant’s work will name.'
            : 'Use your toolsenabled.ai email and password, or the name of an account created only on this computer.'}</div>
        </div>
        <div class="settings-control fleet-inline-control">
          <input class="fleet-profile-input" type="text" name="username" autocomplete="username" spellcheck="false" autocapitalize="off" aria-labelledby="account-username-label" ${busy ? 'disabled' : ''}/>
        </div>
      </article>
      ${creating ? `<article class="settings-row">
        <div class="settings-copy">
          <div class="settings-name" id="account-display-label">Shown as</div>
          <div class="settings-desc">Optional. How the program greets you. Leave it blank to be greeted by the name above.</div>
        </div>
        <div class="settings-control fleet-inline-control">
          <input class="fleet-profile-input" type="text" name="displayName" autocomplete="nickname" aria-labelledby="account-display-label" ${busy ? 'disabled' : ''}/>
        </div>
      </article>` : ''}
      <article class="settings-row">
        <div class="settings-copy">
          <div class="settings-name" id="account-password-label">Password</div>
          <div class="settings-desc">${creating
            ? `At least ${MIN_PASSWORD_LENGTH} characters. Length is what makes a password hard to guess — a few unrelated words beat a short one with symbols in it. There is no reset, so use your password manager.`
            : 'The password for that account.'}</div>
        </div>
        <div class="settings-control fleet-inline-control">
          <input class="fleet-profile-input" type="password" name="password" autocomplete="${creating ? 'new-password' : 'current-password'}" aria-labelledby="account-password-label" ${busy ? 'disabled' : ''}/>
        </div>
      </article>
      <!-- THE BUTTONS COME BEFORE THE EXPLANATION, AND THAT IS A MEASUREMENT
           RATHER THAN A PREFERENCE.

           At this application's own default window size -- 1400x832 -- all
           three of these measured top=833 in an innerHeight of 832. Not
           "hard to reach": one pixel below the last row of pixels the window
           has, on a screen whose entire purpose is one of those three
           presses. The cause was the scope notice, which is four paragraphs
           about what an account here is and is not, sitting between the last
           field and the actions.

           Nothing was cut. The notice is directly under the buttons now,
           where somebody reading down the form still meets it before they
           leave the screen -- and where its height can no longer push the
           only thing on the page a person can press off the bottom of the
           window. -->
      <div class="setup-actions">
        <button type="button" class="ctl-btn" data-account-mode="${creating ? 'sign-in' : 'create'}" ${busy ? 'disabled' : ''}>${creating
          ? 'I already have an account'
          : 'Create an account'}</button>
        <div class="setup-actions-spacer"></div>
        <button type="button" class="ctl-btn" data-account-home ${busy ? 'disabled' : ''}>Not now</button>
        <button type="submit" class="ctl-btn" ${busy ? 'disabled' : ''}>${busy ? 'Working…' : creating ? 'Create account' : 'Sign in'}</button>
      </div>
      ${creating ? scopeMarkup({ subject: reset.subject }) : ''}
    </form>
    ${creating ? '' : scopeMarkup({ subject: reset.subject })}
    <!-- TWO ROWS, ONE REASON, SO ONE SECTION.
         ...STILL ABLE TO SEE WHAT IS SOLD. The other copy of the plans row sits
         in the belongings list, which only a signed-in person has. A signed-out
         visitor is the one most likely to be looking for prices. Leaving it out
         here would put the page behind a sign-in that has nothing to do with
         it.
         ...AND STILL ABLE TO LEAVE. Somebody who never made an account still
         has a vault, a permission level and a settings file on this disk, and
         somebody who has forgotten their password cannot sign in to reach a
         control at all -- there is no password reset here.
         BOTH OF THE -block NAMES STAY, on the one list that holds both rows, so
         a selector written against either still finds the element that really
         does contain what it names. -->
    ${sectionMarkup('Without an account', [
      resetMarkup({ reset, busy }),
    ], 'data-reset-block')}`
}

/* The one place that decides which of the above a given state paints.
 *
 * It is HERE rather than in the view for the reason the whole file exists: a
 * dispatcher inside the view can only be checked by reading it, and reading is
 * what missed the last two defects. This one is called by the tests with each
 * state in turn. */
export function screenMarkup({ state = null, mode = 'sign-in', busy = false, notice = null, now = Date.now(), data = null, payment = null, history = null, cart = null, google = null, browserSignIn = null, reset = {}, subject = RESET_SUBJECT_HERE, platform } = {}) {
  const readerReset = { ...reset, subject, platform }
  if (state === null) return loadingMarkup()
  if (!state.available) return unavailableMarkup({ state, reset: readerReset, busy, notice })
  if (state.signedIn) {
    /* The two sub-forms deliberately do NOT carry the removal control. A person
       halfway through typing a new password is not deciding about deletion, and
       a destructive button under a form is a mis-click. */
    if (mode === 'change-password') return changePasswordMarkup({ state, busy, notice })
    if (mode === 'display-name') return changeDisplayNameMarkup({ state, busy, notice })
    return signedInMarkup({ state, busy, notice, now, data, payment, history, cart, reset: readerReset })
  }
  return formMarkup({ mode, busy, notice, state, google, browserSignIn, reset: readerReset })
}

/* ---- the first-run step ----
 *
 * The same question, asked inside the walkthrough. It is HERE and not in
 * src/views/setup.js for the reason the rest of this file exists: that file
 * imports three stylesheets and touches the DOM, so nothing can render it in a
 * test, and a plant proved the consequence -- the step could return an empty
 * string, and the scope notice could be deleted outright, with the whole suite
 * still green. That is the SHIPMENT-PLAN B14 disclosure disappearing from the
 * screen where a first-time user creates an account.
 *
 * The step keeps its own shape rather than reusing formMarkup(): the walkthrough
 * has a step counter, Back/Not-now/Skip actions and the `fleet-profile-fields`
 * layout, and pretending the two screens are one would bend both. What they DO
 * share is the copy, imported from the same constants, so the two can never
 * disagree about what an account is.
 *
 * `actions` arrives as a rendered string. The walkthrough owns its own action
 * bar and its own idea of which step comes next; this builder does not need to
 * know, and taking it as a parameter is what keeps this file free of the
 * walkthrough's state.
 */
export function setupAccountStepMarkup({
  accountState = null,
  mode = 'sign-in',
  busy = false,
  notice = null,
  actions = '',
  /* The same three-state Google option the account screen shows, rendered here
     too. A first-time customer meets sign-in in the WALKTHROUGH, so offering
     only the password form here would leave the option the owner asked for
     invisible on the one run where it matters most. `null` is the honest
     "still checking" state, which is what a caller that has not asked yet
     should see. */
  google = null,
  browserSignIn = null,
  subject = ACCOUNT_SCOPE_SUBJECT_HERE,
} = {}) {
  if (accountState === null) {
    return `<h1 class="setup-title">${esc(ACCOUNT_QUESTION)}</h1>
      <div class="fleet-profile-status is-quiet" role="status">
        <strong>Reading accounts on the computer you are driving…</strong>
      </div>
      ${actions}`
  }
  if (!accountState.available) {
    return `<h1 class="setup-title">${esc(ACCOUNT_QUESTION)}</h1>
      <div class="fleet-profile-status is-serious" role="alert">
        <strong>This copy cannot hold an account</strong>
        <span>${esc(accountState.reason || 'The application did not say why.')} Nothing on the computer you are driving has been changed, and the rest of setup still works. Your assistant’s records will say that nobody was signed in.</span>
      </div>
      ${actions}`
  }
  if (accountState.signedIn) {
    return `<h1 class="setup-title">Signed in as ${esc(accountState.displayName)}</h1>
      <div class="fleet-profile-status is-good" role="status">
        <strong>You are signed in; while Signed activity audit is on, the record of what your assistant does says who asked for it.</strong>
        <span>You can sign out or change this later on your Account page.</span>
      </div>
      ${actions}`
  }

  const creating = mode === 'create'
  return `<h1 class="setup-title">${esc(ACCOUNT_QUESTION)}</h1>
    <p class="setup-subtitle">${esc(ACCOUNT_QUESTION_SUB)}</p>
    ${notice ? statusMarkup({ notice: typeof notice === 'string'
      ? { tone: 'bad', title: 'That did not work', detail: notice }
      : notice }) : ''}
    ${browserSignInMarkup(browserSignIn)}
    <div class="settings-section-rows" data-account-google-block>
      ${googleOptionMarkup({ google, busy, signingIn: browserSignIn?.provider === 'google', showCancel: false })}
    </div>
    <p class="setup-subtitle" data-account-or>${google && google.available === true
      ? 'Or sign in with your ToolsEnabled email and password, or a local account.'
      : 'Sign in with your ToolsEnabled email and password, or a local account.'}</p>
    <div class="settings-section-rows">
      <article class="settings-row fleet-profile-block setup-question">
        <div class="settings-copy">
          <div class="settings-name" id="setup-account-name">${creating ? 'Local account name' : 'Email or local account name'}</div>
          <div class="settings-desc">${esc(creating
            ? 'Letters, numbers, and . _ - between them. This is what your assistant’s records will name.'
            : 'Use your toolsenabled.ai email and password, or the name of an account created only on this computer.')}</div>
        </div>
        <div class="fleet-profile-fields">
          <input class="fleet-profile-input" type="text" data-setup-account-field="username" autocomplete="username" spellcheck="false" autocapitalize="off" aria-labelledby="setup-account-name" ${busy ? 'disabled' : ''}/>
        </div>
      </article>
      ${creating ? `<article class="settings-row fleet-profile-block setup-question">
        <div class="settings-copy">
          <div class="settings-name" id="setup-account-shown-as">Shown as</div>
          <div class="settings-desc">Optional. This is what the program calls you and what goes on the record of what your assistant does. Leave it blank and it uses the name above until you say otherwise. You can change it whenever you like afterwards, on your Account page — nothing you choose here is permanent.</div>
        </div>
        <div class="fleet-profile-fields">
          <input class="fleet-profile-input" type="text" data-setup-account-field="displayName" autocomplete="nickname" aria-labelledby="setup-account-shown-as" ${busy ? 'disabled' : ''}/>
        </div>
      </article>` : ''}
      <article class="settings-row fleet-profile-block setup-question">
        <div class="settings-copy">
          <div class="settings-name" id="setup-account-password">Password</div>
          <div class="settings-desc">${esc(creating
            ? `At least ${MIN_PASSWORD_LENGTH} characters. A few unrelated words beat a short one with symbols in it. There is no reset, so use your password manager.`
            : 'The password for that account.')}</div>
        </div>
        <div class="fleet-profile-fields">
          <input class="fleet-profile-input" type="password" data-setup-account-field="password" autocomplete="${creating ? 'new-password' : 'current-password'}" aria-labelledby="setup-account-password" ${busy ? 'disabled' : ''}/>
        </div>
      </article>
    </div>
    ${scopeMarkup({ subject })}
    ${actions}`
}
import { controlState } from './components.js'
