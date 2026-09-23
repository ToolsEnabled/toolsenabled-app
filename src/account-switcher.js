/* THE ACCOUNTS MENU ON PAGE 2: the half that has a DOM.
 *
 * Every rule, every sentence and every normalising decision lives next door in
 * src/account-switcher-state.js, for the reason that file's header gives. What
 * is here is what a function cannot do: build the control, open and close it,
 * and put the answers on the glass. There is no sentence of this module's own
 * in it -- every visible word is a key of COPY, so the copy gates can see them.
 *
 * WHERE IT SITS, AND WHY THERE. The owner asked for it "on page 2 right below
 * settings and to the right". The quick-settings gear is the last thing in the
 * page chrome; the machine tab strip is the first row of the page itself. This
 * control is the right-hand end of that row -- under the gear, across from the
 * tabs -- which is the only spot on this page that is both immediately under
 * settings and out of the canvas's way.
 *
 * Like Roles, Accounts opens a native modal dialog. It keeps the controls
 * together without covering the tree with a small, crowded dropdown. The
 * browser keeps keyboard focus inside the popup; closing returns to its
 * launcher. Existing account reads and writes keep their own contracts.
 *
 * IT READS THE LIST ON OPEN AND THE ALLOWANCES ONLY WHEN ASKED. The list is a
 * file read and costs nothing. The allowances start one short-lived program
 * per Codex account and one per Claude account (a Gemini account is a file
 * presence check), so that is a button a person presses -- there is no timer
 * here and there must not be one. A menu that polled providers in the
 * background would be a background job nobody started, which is the thing
 * this codebase refuses everywhere else it comes up.
 *
 * A PRESS NEVER LEAVES THE KEYBOARD ON THE PAGE BODY. Every press disables
 * its button for the round trip, and "Use this one" redraws the whole list,
 * so without a deliberate move a keyboard user ends every press nowhere. The
 * rule is in focusAnswer(): on success the status line, where the answer is;
 * on a refusal the button that was pressed, so trying again is one press away.
 *
 * ADDING AN ACCOUNT IS ONE PRESS. The owner: "it should just be easy to add
 * them in the app, just a few clicks". The Add section is three buttons named
 * for the programs and one optional name box. A press asks the shell to make
 * the folder and to open that program's sign-in window; the person signs in
 * there and then presses Check allowances. No folder is ever typed here.
 */
import { el } from './components.js'
import { currentDataSource } from './data-source.js'
import { readerRemedy } from './refusal-copy.js'
import { accountPolicyWriter } from './account-policy-writer.js'
import { sampleAccountListing } from './sample-accounts.js'
/* THE ONE ADDRESS OF THE PLACE THAT INSTALLS AND SIGNS IN. It is read rather
   than spelled: this menu has no Install button and both of its doors have to
   land on the row that does, wherever that row lives. */
import { GUIDE_HREF } from './first-run-needs.js'
import {
  accountKey,
  accountsBridge,
  signInQueue,
  COPY,
  PROVIDER_IDS,
  SELECTION_MODE_CHOICES,
  RANK_WINDOW_CHOICES,
  rankWindowChoice,
  accountBars,
  allowanceBucketNotes,
  allowanceBucketIssueNotes,
  allowanceBucketPercent,
  accountRoomLeft,
  accountSentence,
  addManagedAccount,
  addRegisteredAccount,
  agePhrase,
  removeAccount,
  renameAccount,
  resetPhrase,
  groupByProvider,
  isRankedMode,
  lastSwitchSentence,
  loadAccounts,
  loadProviderPrograms,
  programKey,
  loadUsage,
  revokeExplicitUsage,
  mergeAccounts,
  movedOffParagraph,
  needsSignIn,
  onSignInChanged,
  orderParagraph,
  providerLabel,
  providerMeasuresUsage,
  rowFlags,
  rowLines,
  selectionModeChoice,
  signInAccount,
  switchAccount,
  usageIsStale,
  windowSentence,
} from './account-switcher-state.js'
import './account-switcher.css'

const readerSentence = sentence => readerRemedy(sentence, { viaRelay: currentDataSource() === 'relay' })

const escapeMarkup = (value) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))

/* One id per mounted menu, so the button's aria-controls names its own panel
   and two pages mounted in one document (the phone preview beside the desktop
   page) cannot point at each other's. */
let menuCount = 0

/* THE BAR THAT SHOWS A WINDOW, AND THE ONE THING IT MAY NOT DO.
 *
 * An unread window draws NO BAR AT ALL and says so in words. A zero-width bar
 * and an unmeasured window look identical, and "nothing used" is the opposite
 * of "we could not ask" -- the second invites a run the first cannot promise.
 * This is the same rule src/cloud-tasks-controller.js states for its account
 * line, at the one place on this menu where a picture could tell the lie.
 *
 * The fill and the headline both show the share remaining. Used allowance
 * and a reported reset are visible below it, rather than hidden in a title.
 *
 * THE SENTENCE IS HANDED IN, not derived here. One row can draw two weekly
 * bars -- Claude meters the week across all models and again for the model in
 * use -- and only accountBars() sees both at once, so only it can name each
 * against the other. Deriving the sentence from the window alone gave the two
 * bars accessible names differing by a percentage and nothing else. */
function windowBar(window, label, { measured = false, sentence = null, bucket = null, tokenLabel = null } = {}) {
  if (bucket) {
    const node = el('<div class="acct-bar acct-bucket"></div>')
    node.dataset.bucketKey = bucket.key
    node.dataset.bucketStatus = bucket.status
    node.appendChild(el('<span class="acct-bar-label"></span>')).textContent = label
    node.appendChild(el('<span class="acct-bucket-scope"></span>')).textContent = tokenLabel
    if (bucket.remainingFraction !== null) {
      const percent = bucket.remainingFraction * 100
      const phrase = COPY.bucketFraction(allowanceBucketPercent(bucket.remainingFraction))
      node.dataset.tone = percent <= 5 ? 'spent' : percent <= 25 ? 'tight' : 'fine'
      node.appendChild(el('<span class="acct-bar-figure"></span>')).textContent = phrase
      const meter = el('<span class="acct-bar-track" role="meter" aria-valuemin="0" aria-valuemax="100"><span class="acct-bar-fill"></span></span>')
      meter.setAttribute('aria-valuenow', String(percent))
      meter.setAttribute('aria-label', `${label} · ${tokenLabel}`)
      meter.setAttribute('aria-valuetext', phrase)
      meter.querySelector('.acct-bar-fill').style.width = `${percent}%`
      node.appendChild(meter)
    }
    if (bucket.remainingAmount !== null) {
      node.appendChild(el('<span class="acct-bucket-amount"></span>')).textContent = COPY.bucketAmount(bucket.remainingAmount)
    }
    if (bucket.remainingFraction === null && bucket.remainingAmount === null) {
      node.appendChild(el('<span class="acct-bar-none"></span>')).textContent = COPY.notKnown
    }
    const reset = node.appendChild(el('<span class="acct-bar-reset"></span>'))
    reset.textContent = resetPhrase(bucket.resetsAt) || COPY.bucketResetUnknown
    if (bucket.resetsAt) reset.title = bucket.resetsAt
    for (const note of allowanceBucketIssueNotes(bucket)) {
      node.appendChild(el('<span class="acct-bucket-note"></span>')).textContent = note
    }
    return node
  }
  if (!window) {
    /* "not known" for an account that answered no reading at all; "none
       reported" for an account that answered and simply has no such window
       (Codex Pro meters only a week). The second is a fact about the plan. */
    return el(`<div class="acct-bar acct-bar-unread">
      <span class="acct-bar-label">${escapeMarkup(label)}</span>
      <span class="acct-bar-none">${escapeMarkup(measured ? COPY.noneReported : COPY.notKnown)}</span>
    </div>`)
  }
  const used = Math.round(window.usedPercent)
  const free = Math.round(window.remainingPercent)
  const reset = resetPhrase(window.resetsAt)
  /* `tone` is read off the room LEFT rather than the amount used, because the
     thing a person is deciding is whether this account can carry the next run.
     The thresholds are the same ones the dynamic mode reserves at. */
  const tone = window.remainingPercent <= 5 ? 'spent'
    : window.remainingPercent <= 25 ? 'tight' : 'fine'
  const node = el(`<div class="acct-bar" data-tone="${tone}">
    <span class="acct-bar-label">${escapeMarkup(label)}</span>
    <span class="acct-bar-track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${free}"><span class="acct-bar-fill" style="width:${free}%"></span></span>
    <span class="acct-bar-figure">${escapeMarkup(COPY.percentRemaining(free))}</span>
    <span class="acct-bar-detail"><span>${escapeMarkup(COPY.percentUsed(used))}</span>${reset ? `<span class="acct-bar-reset">${escapeMarkup(reset)}</span>` : ''}</span>
  </div>`)
  /* The accessible name carries the whole sentence, because the bar itself is
     a picture and a screen reader gets nothing from a width. */
  const say = sentence || windowSentence(window)
  node.querySelector('.acct-bar-track').setAttribute('aria-label', `${label}: ${say}`)
  node.querySelector('.acct-bar-track').setAttribute('aria-valuetext', `${say} · ${COPY.percentUsed(used)}`)
  node.title = say
  return node
}

/**
 * Build the accounts menu. Returns the element plus a `destroy()` that removes
 * every listener this control put on the document -- the page mounts and
 * retires per navigation, and a menu that outlived its page would keep the view
 * it closed over alive.
 */
export function accountSwitcher({ scope = globalThis } = {}) {
  menuCount += 1
  const menuId = `acct-menu-${menuCount}`
  const root = el(`
    <div class="acct-switch">
      <button class="acct-trigger" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="${menuId}">
        <span class="acct-trigger-label">${escapeMarkup(COPY.buttonUnread)}</span>
        <span class="acct-trigger-chev" aria-hidden="true">▾</span>
      </button>
      <dialog class="acct-menu" id="${menuId}" aria-labelledby="${menuId}-title" hidden>
        <header class="acct-header">
          <div class="acct-heading">
            <span class="acct-eyebrow">${escapeMarkup(COPY.computerAccounts)}</span>
            <h3 id="${menuId}-title">${escapeMarkup(COPY.title)}</h3>
            <p class="acct-summary" data-acct="summary">${escapeMarkup(COPY.loading)}</p>
          </div>
          <button class="acct-btn acct-close" type="button" data-acct="close" aria-label="${escapeMarkup(COPY.close)}">${escapeMarkup(COPY.close)} <span aria-hidden="true">×</span></button>
        </header>
        <div class="acct-toolbar">
          <span class="acct-save-state" data-acct="save-status" data-state="idle" role="status">${escapeMarkup(COPY.autosave)}</span>
          <button class="acct-btn" type="button" data-acct="refresh-list">${escapeMarkup(COPY.refreshAccounts)}</button>
        </div>
        <div class="acct-section acct-preview" hidden>
          <p class="acct-field-label">${escapeMarkup(COPY.previewTitle)}</p>
          <p class="acct-help">${escapeMarkup(COPY.previewHelp)}</p>
          <a class="acct-btn" href="/signin/">${escapeMarkup(COPY.previewSignIn)}</a>
        </div>
        <div class="acct-workspace">
          <section class="acct-section acct-listing" aria-label="${escapeMarkup(COPY.connectedAccounts)}">
            <div class="acct-listing-head">
              <h4 class="acct-section-title">${escapeMarkup(COPY.connectedAccounts)}</h4>
              <button class="acct-btn" type="button" data-acct="refresh">${escapeMarkup(COPY.refresh)}</button>
            </div>
            <p class="acct-cost">${escapeMarkup(COPY.refreshCost)}</p>
            <div class="acct-filters">
              <label class="acct-field"><span class="acct-field-label">${escapeMarkup(COPY.searchAccounts)}</span><input class="acct-input" type="search" data-acct="query" placeholder="${escapeMarkup(COPY.searchPlaceholder)}" autocomplete="off"></label>
              <label class="acct-field"><span class="acct-field-label">${escapeMarkup(COPY.filterProvider)}</span><select class="acct-select" data-acct="provider-filter"><option value="">${escapeMarkup(COPY.allProviders)}</option>${PROVIDER_IDS.map(id => `<option value="${escapeMarkup(id)}">${escapeMarkup(providerLabel(id))}</option>`).join('')}</select></label>
            </div>
            <div class="acct-filter-summary"><span data-acct="matches" role="status"></span><button class="acct-btn acct-btn-small" type="button" data-acct="clear-query" hidden>${escapeMarkup(COPY.clearSearch)}</button></div>
            <button class="acct-btn acct-signin-each" type="button" data-acct="sign-in-each" hidden></button>
            <p class="acct-checked" data-acct="checked" hidden></p>
            <p class="acct-switched" data-acct="switched" role="status" hidden></p>
            <div class="acct-list" data-acct="list"></div>
            <p class="acct-moved" data-acct="moved" role="status" hidden></p>
            <p class="acct-order" data-acct="order" hidden></p>
          </section>
          <div class="acct-sidebar">
            <section class="acct-section acct-mode" aria-label="${escapeMarkup(COPY.switchingSettings)}">
              <h4 class="acct-section-title">${escapeMarkup(COPY.switchingSettings)}</h4>
              <p class="acct-help" data-acct="policy-empty" hidden>${escapeMarkup(COPY.policyNeedsAccount)}</p>
              <div class="acct-policy-fields" data-acct="policy-fields">
              <label class="acct-field">
                <span class="acct-field-label">${escapeMarkup(COPY.modeLabel)}</span>
                <select class="acct-select" data-acct="mode">
                  ${SELECTION_MODE_CHOICES.map(choice => `<option value="${escapeMarkup(choice.id)}">${escapeMarkup(choice.label)}</option>`).join('')}
                </select>
              </label>
              <p class="acct-help" data-acct="mode-help"></p>
              <div class="acct-override-notice" data-acct="override-notice" role="status" hidden>
                <p class="acct-help" data-acct="override-notice-text"></p>
                <button class="acct-btn acct-btn-small" type="button" data-acct="override-apply">${escapeMarkup(COPY.overrideNoticeApply)}</button>
              </div>
              <label class="acct-field acct-reserve" data-acct="reserve-field" hidden>
                <span class="acct-field-label">${escapeMarkup(COPY.reserveLabel)}</span>
                <span class="acct-reserve-input">
                  <input class="acct-num" type="number" min="0" max="100" step="1" data-acct="reserve" aria-label="${escapeMarkup(COPY.reserveLabel)}">
                  <span aria-hidden="true">${escapeMarkup(COPY.reserveUnit)}</span>
                </span>
              </label>
              <p class="acct-help acct-help-quiet" data-acct="reserve-help">${escapeMarkup(COPY.reserveHelp)}</p>
              <label class="acct-field acct-rank" data-acct="rank-field" hidden>
                <span class="acct-field-label">${escapeMarkup(COPY.rankLabel)}</span>
                <select class="acct-select" data-acct="rank">
                  ${RANK_WINDOW_CHOICES.map(choice => `<option value="${escapeMarkup(choice.id)}">${escapeMarkup(choice.label)}</option>`).join('')}
                </select>
              </label>
              <p class="acct-help acct-help-quiet" data-acct="rank-help" hidden>${escapeMarkup(COPY.rankHelp)}</p>
              <div class="acct-recovery">
                <label class="acct-toggle">
                  <span>${escapeMarkup(COPY.recoveryLabel)}</span>
                  <input type="checkbox" role="switch" data-acct="auto-recover" aria-describedby="${menuId}-recovery-help">
                </label>
                <p class="acct-help acct-help-quiet" id="${menuId}-recovery-help">${escapeMarkup(COPY.recoveryHelp)}</p>
              </div>
              <div class="acct-limits" role="group" aria-label="${escapeMarkup(COPY.limitsLabel)}">
                <span class="acct-field-label">${escapeMarkup(COPY.limitsLabel)}</span>
                ${['weekly', 'hourly'].map(window => `<label class="acct-limit">
                  <span class="acct-limit-name">${escapeMarkup(window === 'weekly' ? COPY.limitWeeklyLabel : COPY.limitHourlyLabel)}</span>
                  <output class="acct-limit-figure" data-acct="limit-${window}-figure"></output>
                  <input class="acct-slider" type="range" min="1" max="100" step="1" data-acct="limit-${window}" aria-label="${escapeMarkup(COPY.limitsLabel)} ${escapeMarkup(window === 'weekly' ? COPY.limitWeeklyLabel : COPY.limitHourlyLabel)}">
                </label>`).join('')}
                <p class="acct-help acct-help-quiet">${escapeMarkup(COPY.limitHelp)}</p>
              </div>
              </div>
            </section>
            <details class="acct-section acct-add" open>
              <summary>${escapeMarkup(COPY.addHeading)}</summary>
              <div class="acct-add-body">
                <p class="acct-help">${escapeMarkup(readerSentence(COPY.addHelp))}</p>
                <label class="acct-field">
                  <span class="acct-field-label">${escapeMarkup(COPY.addName)}</span>
                  <input class="acct-input" type="text" maxlength="64" autocomplete="off" data-acct="add-name" placeholder="${escapeMarkup(COPY.addNamePlaceholder)}">
                </label>
                <label class="acct-field">
                  <span class="acct-field-label">Existing account folder (optional)</span>
                  <input class="acct-input" type="text" maxlength="1024" autocomplete="off" data-acct="add-directory" placeholder="Leave blank to create a new sign-in">
                </label>
                <div class="acct-add-buttons" role="group" aria-label="${escapeMarkup(COPY.addProvider)}">
                  ${PROVIDER_IDS.map(id => `<button class="acct-btn" type="button" data-acct="add-provider" data-provider="${escapeMarkup(id)}">+ ${escapeMarkup(providerLabel(id))}</button><a class="acct-btn" data-acct="setup-provider" data-provider="${escapeMarkup(id)}" href="${escapeMarkup(GUIDE_HREF)}" hidden>${escapeMarkup(COPY.setupProvider(providerLabel(id)))}</a>`).join('')}
                  <button class="acct-btn" type="button" data-acct="add-provider" data-provider="gemini" data-client="antigravity">+ Antigravity (current OS sign-in)</button>
                </div>
                <p class="acct-help" data-acct="setup-help" hidden>${escapeMarkup(COPY.setupHelp)}</p>
                <a class="acct-setup-link" data-acct="setup" href="${escapeMarkup(GUIDE_HREF)}">${escapeMarkup(COPY.providerSetup)}</a>
              </div>
            </details>
          </div>
        </div>
        <output class="acct-out" data-acct="out" role="status" tabindex="-1" hidden></output>
      </dialog>
    </div>`)

  const trigger = root.querySelector('.acct-trigger')
  const triggerLabel = root.querySelector('.acct-trigger-label')
  const menu = root.querySelector('.acct-menu')
  const field = key => root.querySelector(`[data-acct="${key}"]`)
  const modeSelect = field('mode')
  const autoRecoverInput = field('auto-recover')
  const modeHelp = field('mode-help')
  const overrideNotice = field('override-notice')
  const overrideNoticeText = field('override-notice-text')
  const overrideApply = field('override-apply')
  const reserveField = field('reserve-field')
  const reserveHelp = field('reserve-help')
  const reserveInput = field('reserve')
  const rankField = field('rank-field')
  const rankSelect = field('rank')
  const rankHelp = field('rank-help')
  const limitSliders = Object.freeze({
    weekly: field('limit-weekly'),
    hourly: field('limit-hourly'),
  })
  const limitFigures = Object.freeze({
    weekly: field('limit-weekly-figure'),
    hourly: field('limit-hourly-figure'),
  })
  const refreshButton = field('refresh')
  const signInEachButton = field('sign-in-each')
  const listElement = field('list')
  const queryInput = field('query')
  const providerFilter = field('provider-filter')
  const matchesElement = field('matches')
  const clearQueryButton = field('clear-query')
  const orderElement = field('order')
  const movedElement = field('moved')
  const checkedElement = field('checked')
  const switchedElement = field('switched')
  const outElement = field('out')
  const nameInput = field('add-name')
  const directoryInput = field('add-directory')
  const addButtons = [...root.querySelectorAll('[data-acct="add-provider"]')]

  let destroyed = false
  let open = false
  let listing = null
  let usage = null
  let usageViewRevision = 0
  let busy = false
  let programs = {}
  let programsVersion = 0
  const renameForms = new Map()
  /* THE LIST READ THAT COUNTS IS THE NEWEST ONE. Every press ends by re-reading
     the list, and two presses close together are two reads in flight; without
     this token the one that lands LAST paints, which can be the older answer.
     Each read takes a number and only paints if it is still the newest. */
  let listVersion = 0
  let policySaving = false
  const policyWriter = accountPolicyWriter(scope)
  const editingPolicy = new Set()
  let usageObservedAt = 0
  const saveStatus = field('save-status')
  const refreshListButton = field('refresh-list')
  const summaryElement = field('summary')
  /* THE ONE THING THIS MENU LISTENS TO, AND ONLY AFTER A PRESS. A Sign in press
     asks the shell to watch THAT account's folder; this holds the detach for
     the subscription that carries its answer back. Null until somebody presses,
     and replaced (never stacked) by a second press, because the shell holds one
     watch at a time and a second listener would repaint for a watch that is
     already gone. */
  let detachSignInChange = null
  /* WHICH ACCOUNTS THE SIGN-IN RUN HAS ALREADY OPENED A WINDOW FOR, by
     accountKey. It cannot be derived from the list: signing in happens in the
     person's own window and this product reads nothing of it, so an account
     stays "not signed in" for as long as they take, and a queue recomputed
     from the list alone would offer the same one for ever. Only a window that
     actually OPENED is recorded -- a refusal leaves the account in the queue,
     because a run that quietly skipped what it could not do would be the
     silent-skip defect this codebase keeps finding. */
  const signInOpened = new Set()

  const say = (tone, text) => {
    outElement.dataset.tone = tone
    outElement.textContent = text || ''
    outElement.hidden = !text
  }

  /* WHERE THE KEYBOARD IS LEFT AFTER A PRESS. A press disables its button for
     the length of the round trip, and a disabled control cannot hold focus;
     after "Use this one" there is not even a button to come back to, because
     the list is redrawn from scratch and the pressed one is gone. The HTML
     focus fixup rule then puts the keyboard on the page body, outside this
     menu. So: on success the status line takes focus, since the answer is
     there (it is focusable by script only -- tabindex -1 -- never a tab stop
     of its own); on a refusal the pressed button takes it back when it still
     stands, so trying again is one press away. A menu that was closed while
     the press was in flight is left alone: Escape already put focus on the
     button that opened it. */
  function focusAnswer(button, ok) {
    if (destroyed || !open) return
    if (!ok && button && root.contains(button) && !button.disabled) {
      button.focus()
      return
    }
    outElement.focus()
  }

  /* ---- WHAT THE CLOSED BUTTON SAYS ----
   *
   * The account in use, and how much of it is left, if both are known. Never a
   * percentage on its own: a bare number with no account beside it is unreadable
   * on a computer with three accounts, and a percentage with nothing measured
   * would be invented. */
  function paintTrigger(accounts) {
    const activeAccounts = accounts.filter(account => account.active)
    if (activeAccounts.length > 1) {
      triggerLabel.textContent = COPY.buttonMultiple(activeAccounts.length)
      trigger.title = activeAccounts.map(account => `${providerLabel(account.provider)} · ${account.name} · ${accountSentence(account)}`).join('\n')
      return
    }
    const active = activeAccounts[0] || null
    if (!active) {
      triggerLabel.textContent = COPY.buttonUnread
      trigger.title = COPY.title
      return
    }
    const room = accountRoomLeft(active)
    triggerLabel.textContent = room ? `${active.name} · ${room}` : active.name
    trigger.title = room
      ? `${providerLabel(active.provider)} · ${active.name} · ${accountSentence(active)}`
      : `${providerLabel(active.provider)} · ${active.name}`
  }

  function paintModeHelp(id) {
    const choice = selectionModeChoice(id)
    modeHelp.textContent = choice ? `${COPY.modeHelpLead} ${choice.help}` : ''
    /* The reserve is only read by one mode, so it is only OFFERED by that mode.
       A number that does nothing where it stands is a control that teaches a
       person the wrong thing about what they changed. */
    const wantsReserve = id === 'dynamic'
    reserveField.hidden = !wantsReserve
    reserveHelp.hidden = !wantsReserve
    /* The same rule for the window a ranking reads: "stop and let me switch"
       and "in the order listed" read no allowance, so they ask no window. */
    const wantsRank = isRankedMode(id)
    rankField.hidden = !wantsRank
    rankHelp.hidden = !wantsRank
  }

  /* WHICH PROGRAMS THE RULE ABOVE IS NOT REACHING. A program that recorded a
     mode of its own runs that one, so the rule above is a default it does not
     follow. Read straight off the policy the shell already sent -- this draws
     state, it never computes a new one and never writes.

     PROVIDER_IDS is the list walked rather than the keys of byProvider,
     because every id here has to be one the copy table can name: a raw
     provider key on the owner's screen is breakage a cut ships silently. */
  function programsOverridingDefault(policy) {
    const byProvider = policy && policy.byProvider ? policy.byProvider : null
    if (!byProvider) return []
    return PROVIDER_IDS.filter(id => {
      const rule = byProvider[id]
      return Boolean(rule && rule.own && rule.own.selectionMode)
    })
  }

  function providerModeControl(provider) {
    return [...root.querySelectorAll('[data-acct="provider-mode"]')]
      .find(node => node.dataset.provider === provider) || null
  }

  function paintOverrideNotice(policy) {
    const programs = programsOverridingDefault(policy)
    overrideNotice.hidden = programs.length === 0
    if (programs.length === 0) return
    const choice = selectionModeChoice(policy.selectionMode)
    const text = COPY.overrideNotice(
      programs.map(providerLabel).join(' and '),
      programs.length,
      choice ? choice.label : policy.selectionMode)
    /* Written only when it actually changes. This is a live region, and
       re-announcing an unchanged sentence on every repaint is noise. */
    if (overrideNoticeText.textContent !== text) overrideNoticeText.textContent = text
  }

  /* THE ONE ACTION, AND IT HAPPENS ON THE PERSON'S CLICK OR NOT AT ALL. Every
     program the notice named is dropped through the same "Use default" its own
     row already offers -- one queued write each, no second route for clearing
     a rule -- and the notice is then redrawn from what the shell sends back
     rather than from what this assumed. A program the notice did not name is
     never touched. */
  function onApplyDefaultToOverriding() {
    if (destroyed) return
    const programs = programsOverridingDefault(listing ? listing.policy : null)
    if (programs.length === 0) return
    for (const provider of programs) {
      /* The row's own control when it is drawn, so the screen agrees with the
         write immediately; a stand-in otherwise, because a click that quietly
         did nothing is worse than one that writes. */
      const control = providerModeControl(provider) || { value: 'inherit' }
      control.value = 'inherit'
      onProviderRuleChange(provider, control, 'selectionMode')
    }
  }

  function paintMode(policy) {
    autoRecoverInput.checked = policy.autoRecoverOnLimit === true
    if (!editingPolicy.has(modeSelect)) modeSelect.value = policy.selectionMode
    paintModeHelp(modeSelect.value)
    paintOverrideNotice(policy)
    if (!editingPolicy.has(reserveInput)) reserveInput.value = String(Math.round(policy.reservePercent))
    rankSelect.value = policy.rankWindow || 'either'
    paintLimits(policy)
  }

  /* THE TWO LIMITS, AND WHICH OF THEM WAS ACTUALLY CHOSEN.

     A window with no limit of its own is using the single number, and the
     slider sits on that number so the screen is telling the truth about what
     a start would do. The figure beside it says which of the two it is, so
     the person can tell an inherited number from one they set -- moving the
     slider is what turns the first into the second. */
  function paintLimits(policy) {
    const single = Number.isFinite(policy.exhaustedAtPercent) ? policy.exhaustedAtPercent : 99
    for (const window of ['weekly', 'hourly']) {
      if (editingPolicy.has(limitSliders[window])) continue
      const own = policy[window === 'weekly' ? 'exhaustedAtPercentWeekly' : 'exhaustedAtPercentHourly']
      const shown = Number.isFinite(own) ? own : single
      limitSliders[window].value = String(shown)
      paintLimitFill(limitSliders[window])
      limitFigures[window].textContent = Number.isFinite(own)
        ? `${shown}${COPY.limitUnit}`
        : `${shown}${COPY.limitUnit} · ${COPY.limitInherited(single)}`
    }
  }

  function paintLimitFill(slider) {
    const min = Number(slider.getAttribute('min')), max = Number(slider.getAttribute('max'))
    const percent = ((Number(slider.value) - min) / (max - min)) * 100
    slider.style.setProperty('--fill', `${percent}%`)
  }

  /* While the slider is being dragged the figure follows it and nothing is
     saved. The write happens on `change`, which fires once when it is let
     go -- a save per pixel would be a file write per pixel. */
  function onLimitSlide(window) {
    markPolicyEditing(limitSliders[window])
    paintLimitFill(limitSliders[window])
    limitFigures[window].textContent = `${limitSliders[window].value}${COPY.limitUnit}`
  }

  function onLimitChange(window) {
    if (destroyed) return
    const slider = limitSliders[window]
    const chosen = Number(slider.value)
    if (!Number.isFinite(chosen) || chosen < 1 || chosen > 100) {
      say('note', COPY.limitRefused)
      return
    }
    editingPolicy.delete(slider)
    const request = window === 'weekly'
      ? { exhaustedAtPercentWeekly: chosen }
      : { exhaustedAtPercentHourly: chosen }
    const label = window === 'weekly' ? COPY.limitWeeklyLabel : COPY.limitHourlyLabel
    void savePolicyChange(request, COPY.limitSaved(label, chosen))
  }

  /* HOW OLD THE NUMBERS ARE, said whenever numbers are on screen. */
  function paintChecked() {
    const age = usage && usage.ok ? agePhrase(usage.readAt) : null
    checkedElement.textContent = age === null ? '' : (age === 'just now' ? COPY.checkedJustNow : COPY.checkedAgo(age))
    checkedElement.hidden = age === null
  }

  /* WHAT THE LAST CHANGE OF ACCOUNT WAS, whenever this computer has made one.
   *
   * Painted BEFORE the early returns below, so it still shows on a list that
   * came back damaged or empty: a failover that already happened is a fact
   * about this computer, not about whether its account file parses today. */
  function paintLastSwitch() {
    const change = listing ? lastSwitchSentence(listing) : null
    switchedElement.textContent = ''
    switchedElement.hidden = change === null
    if (!change) return
    switchedElement.appendChild(el('<span class="acct-switched-what"></span>')).textContent = change.text
    /* Marked so a change the COMPUTER made can be drawn differently from one
       the person made. The words already say which; this only lets the styling
       agree with them. */
    switchedElement.dataset.automatic = change.automatic === true ? 'yes' : (change.automatic === false ? 'no' : 'unstated')
    if (change.reason) {
      switchedElement.appendChild(el('<span class="acct-switched-why"></span>')).textContent = change.reason
    }
  }

  function paintList() {
    const focused = document.activeElement
    const editingFocus = [...renameForms.values()].find(edit => edit.form.contains(focused))
    const providerFocus = listElement.contains(focused) && focused?.dataset?.provider
      ? { provider: focused.dataset.provider, field: focused.dataset.acct } : null
    listElement.innerHTML = ''
    paintChecked()
    paintLastSwitch()
    if (!listing) return
    summaryElement.textContent = listing.available && !listing.damaged
      ? COPY.accountSummary(listing.accounts.length, groupByProvider(listing.accounts).length)
      : COPY.listUnavailable
    if (!listing.available || listing.damaged || listing.accounts.length === 0) {
      matchesElement.textContent = ''
      clearQueryButton.hidden = !queryInput.value && !providerFilter.value
      if (listing.available && !listing.damaged) renameForms.clear()
      listElement.appendChild(el(`<p class="acct-empty">${escapeMarkup(listing.note || COPY.none)}</p>`))
      paintTrigger([])
      paintSignInEach([])
      /* An explanation of an order that no longer exists is cleared with the
         rows it explained; otherwise "why this order" from an earlier read can
         stand under an empty list. */
      orderElement.textContent = ''
      orderElement.hidden = true
      movedElement.textContent = ''
      movedElement.hidden = true
      syncAccountControls()
      return
    }
    const accounts = mergeAccounts(listing, usage)
    paintTrigger(accounts)
    paintSignInEach(accounts)
    const query = queryInput.value.trim().toLocaleLowerCase()
    const visibleAccounts = accounts.filter(account => (!providerFilter.value || account.provider === providerFilter.value)
      && (!query || [account.name, account.email, account.planType, providerLabel(account.provider)].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)))
    matchesElement.textContent = COPY.matchingAccounts(visibleAccounts.length, accounts.length)
    clearQueryButton.hidden = !query && !providerFilter.value
    if (!visibleAccounts.length) listElement.appendChild(el(`<p class="acct-empty">${escapeMarkup(COPY.noMatches)}</p>`))
    for (const group of groupByProvider(visibleAccounts)) {
      const section = el(`<div class="acct-group" data-provider="${escapeMarkup(group.provider)}"><div class="acct-group-head"><div class="acct-provider-heading"><span class="acct-provider-mark" aria-hidden="true">${escapeMarkup(group.label.slice(0, 1))}</span><h4 class="acct-group-name">${escapeMarkup(group.label)}</h4><span class="acct-provider-count">${escapeMarkup(COPY.providerAccountCount(group.accounts.length))}</span></div></div></div>`)
      if (!previewing()) section.querySelector('.acct-group-head').appendChild(providerRuleControl(group))
      for (const account of group.accounts) {
        section.appendChild(accountRow(account))
      }
      listElement.appendChild(section)
    }
    for (const [key, edit] of renameForms) {
      if (!accounts.some(account => accountKey(account) === key)) {
        edit.form.remove()
        renameForms.delete(key)
      }
    }
    syncAccountControls()
    if (editingFocus && open && root.contains(focused) && !focused.disabled) focused.focus()
    if (providerFocus && open) {
      const replacement = [...listElement.querySelectorAll('[data-acct]')].find(control =>
        control.dataset.provider === providerFocus.provider && control.dataset.acct === providerFocus.field)
      replacement?.focus()
    }
    /* WHY THE ORDER IS WHAT IT IS, in the engine's own words, and only when it
       has some. orderParagraph() holds the rule: nothing under "stop and let
       me switch" or "in the order listed", where the order IS the list;
       nothing for a program whose allowance is never measured; one sentence
       shared by two programs said once. */
    const why = orderParagraph(listing.policy.selectionMode, usage)
    orderElement.textContent = why
    orderElement.hidden = !why
    /* AND WHEN THE COMPUTER IS NOT ON THE ACCOUNT THAT WAS CHOSEN, SAY SO.
       Above the order sentence because it is about a specific press this
       person made, not about the standing rule -- and it costs nothing to
       read: the shell answered it with the list. */
    const moved = movedOffParagraph(listing)
    movedElement.textContent = moved
    movedElement.hidden = !moved
  }

  /* WHEN THE ONE-CONTROL SIGN-IN RUN IS ON SCREEN, AND WHAT IT SAYS.
   *
   * IT APPEARS FOR A JOB THE ROW BUTTONS CANNOT DO. One account that needs
   * signing in already has a press of its own on its row; a second control
   * beside it would be two ways to do one thing. Two or more is the case this
   * exists for -- and the case the owner hit, with two accounts to sign in and
   * six identical windows waiting to happen. Once a run has started it stays
   * until the queue is empty, so the last account of a run of three is still
   * one press away.
   *
   * THE COUNT IS THE QUEUE'S, NOT THE LIST'S: an account whose window this run
   * already opened is out of it, however long the person takes in that window
   * and however many list reads happen meanwhile. */
  function paintSignInEach(accounts) {
    const queue = signInQueue(accounts, signInOpened)
    const needing = accounts.filter(needsSignIn).length
    const show = queue.length > 0 && (needing >= 2 || signInOpened.size > 0)
    signInEachButton.hidden = !show
    signInEachButton.textContent = show ? COPY.signInEach(queue.length) : ''
  }

  function accountRow(account) {
    const row = el(`<div class="acct-row"${account.active ? ' data-active="yes"' : ''}></div>`)
    const head = el('<div class="acct-row-head"></div>')
    const name = el('<span class="acct-name"></span>')
    /* textContent, not markup: this is the one string on the menu that came
       from outside the program -- the person typed it, and it was written to a
       file that anything could have edited since. */
    name.textContent = account.name
    head.appendChild(name)
    if (account.provider === 'gemini') {
      const client = el('<span class="acct-flag"></span>')
      client.textContent = account.client === 'antigravity' ? 'Antigravity · current OS sign-in' : 'Gemini CLI'
      head.appendChild(client)
    }
    if (account.active) head.appendChild(el(`<span class="acct-inuse">${escapeMarkup(COPY.inUse)}</span>`))
    /* Only when it is NOT the row in use: on the row that is both, "In use
       now" already says everything and a second badge would be noise. */
    if (account.chosen && !account.active) head.appendChild(el(`<span class="acct-chosen">${escapeMarkup(COPY.chosenLabel)}</span>`))
    /* ONE FACT, ONE FLAG. rowFlags() decides what is said beside the name --
       the shell's sign-in answer and the engine's status are one flag when
       they are one fact -- and this only draws it. */
    for (const flag of rowFlags(account)) {
      const node = el(`<span class="acct-flag${flag.tone === 'bad' ? ' acct-flag-bad' : ''}"></span>`)
      node.textContent = flag.text
      if (flag.title) node.title = flag.title
      head.appendChild(node)
    }
    const actions = el('<span class="acct-row-actions" role="group"></span>')
    actions.setAttribute('aria-label', COPY.accountActions(account.name, providerLabel(account.provider)))
    /* A row the shell, or the engine, says is NOT signed in offers the one
       press that fixes that. A row neither checked offers nothing: opening a
       sign-in window over a folder that is already signed in would be the
       menu guessing. */
    if (needsSignIn(account)) {
      const button = el(`<button class="acct-btn acct-btn-small" type="button">${escapeMarkup(COPY.signIn)}</button>`)
      button.addEventListener('click', () => { void onSignIn(account, button) })
      actions.appendChild(button)
    }
    if (!account.active) {
      const button = el(`<button class="acct-btn acct-btn-small" type="button">${escapeMarkup(COPY.switchTo)}</button>`)
      button.addEventListener('click', () => { void onSwitch(account, button) })
      actions.appendChild(button)
    }
    /* RENAME AND REMOVE, ON EVERY ROW (owner, 2026-09-02). Rename turns the
       name into a box on this row; Remove is armed by one press and done by
       the next, so a stray click cannot take an account off the list, and
       no dialog is raised for it. Neither touches the folder or its sign-in. */
    const renameButton = el(`<button class="acct-btn acct-btn-small" type="button" data-acct-row="rename">${escapeMarkup(COPY.rename)}</button>`)
    renameButton.addEventListener('click', () => { startRename(row, head, account) })
    actions.appendChild(renameButton)
    const removeButton = el(`<button class="acct-btn acct-btn-small acct-btn-danger" type="button" data-acct-row="remove">${escapeMarkup(COPY.remove)}</button>`)
    removeButton.addEventListener('click', () => { void onRemove(account, removeButton) })
    actions.appendChild(removeButton)
    row.appendChild(head)
    const identity = el('<div class="acct-identity"></div>')
    identity.appendChild(el('<span class="acct-signin-identity"></span>')).textContent = account.email
      ? COPY.signedInAs(account.email) : COPY.identityNotReported
    if (account.planType) identity.appendChild(el('<span class="acct-plan"></span>')).textContent = COPY.planLine(account.planType)
    row.appendChild(identity)
    const edit = renameForms.get(accountKey(account))
    if (edit) {
      name.hidden = true
      head.insertBefore(edit.form, name)
    }

    /* Show reported windows where available. An unsupported account explains
       availability without drawing empty windows that cannot be measured. */
    const showWindows = providerMeasuresUsage(account.provider) || account.measured || Boolean(account.allowanceBuckets)
    if (showWindows || account.usageState === 'failed') {
      const allowance = el(`<section class="acct-allowance" aria-label="${escapeMarkup(COPY.allowanceHeading)}"><h5 class="acct-allowance-heading">${escapeMarkup(COPY.allowanceHeading)}</h5></section>`)
      const readAt = Object.hasOwn(account, 'usageReadAt') ? account.usageReadAt : usage?.readAt
      const knownAge = Number.isFinite(Date.parse(readAt || ''))
      const readingState = account.usageState || (!usage ? 'unknown' : usage.ok !== true ? 'failed'
        : !account.measured ? 'unknown' : !knownAge ? 'undated'
          : usageIsStale(usage) ? 'stale' : 'current')
      row.dataset.allowanceState = readingState
      const readingLabel = el('<p class="acct-reading-state"></p>')
      const checked = knownAge ? COPY.allowanceLastChecked(agePhrase(readAt)) : COPY.allowanceCheckTimeUnknown
      readingLabel.textContent = readingState === 'failed'
        ? [COPY.allowanceCheckFailed, ...(account.measured ? [checked, COPY.allowanceOlderReading] : [])].join(' · ')
        : account.measured ? [checked, ...(readingState === 'stale' ? [COPY.allowanceOlderReading] : [])].join(' · ')
          : usage ? COPY.allowanceNoReading : COPY.allowanceNotChecked
      allowance.appendChild(readingLabel)
      if (account.allowanceBuckets) {
        if (account.allowanceBuckets.buckets.length) allowance.appendChild(el('<p class="acct-bucket-explanation"></p>')).textContent = COPY.bucketScopes
        for (const note of allowanceBucketNotes(account.allowanceBuckets)) {
          allowance.appendChild(el('<p class="acct-bucket-explanation"></p>')).textContent = note
        }
      }
      const bars = el('<div class="acct-bars"></div>')
      /* WHICH BARS, AND WHAT EACH IS CALLED, is accountBars()' answer -- the
         short window and then every weekly ceiling the engine reported, each
         named against the others. This draws the list and decides nothing. */
      for (const bar of showWindows ? accountBars(account) : []) {
        bars.appendChild(windowBar(bar.window, bar.label, { measured: account.measured, sentence: bar.sentence,
          bucket: bar.bucket, tokenLabel: bar.tokenLabel }))
      }
      if (bars.childElementCount) allowance.appendChild(bars)
      row.appendChild(allowance)
    }

    /* The sentences under the name, decided by rowLines() and only drawn
       here: the allowance line (or the one Gemini sentence), the quiet
       reassurance for an account nothing has read yet, and the engine's
       reason for a fault, as text a keyboard can reach. textContent for all
       of them, because the engine's sentence is the one line on this row
       that was not written in this repository. */
    const lines = rowLines(account, { includeIdentity: false, includeAllowance: !account.measured && !account.allowanceBuckets && account.usageState !== 'failed' })
    if (account.usageState === 'failed' && account.usageError && !lines.some(line => line.text.includes(account.usageError))) {
      const reason = el('<p class="acct-line acct-usage-error"></p>')
      reason.textContent = account.usageError
      const allowance = row.querySelector('.acct-allowance') || row
      allowance.appendChild(reason)
    }
    for (const line of lines) {
      const node = el(`<p class="acct-line${line.quiet ? ' acct-line-quiet' : ''}"></p>`)
      node.textContent = line.text
      row.appendChild(node)
    }
    /* The example's rows are there to be read: no press on them reaches a
       sign-in, a switch, a rename or a removal. */
    if (actions.childElementCount > 0 && !previewing()) {
      row.appendChild(actions)
    }
    return row
  }

  /* ---- THE PRESSES, AND WHAT EACH ONE DOES ---- */

  // Every saved policy is read back from the shell. Reads started before a
  // newer edit cannot replace it, and unreadable data never paints defaults.
  async function refreshList({ quiet = false, retainExplicitUsage = false } = {}) {
    /* The example's rows are the example's: no read of this computer's own
       list replaces them while the example is on (see syncPreview). */
    if (policySaving || previewing()) return null
    const version = ++listVersion
    const next = await loadAccounts(scope)
    if (destroyed || version !== listVersion || policySaving) return null
    if (!next.available || next.damaged) {
      revokeExplicitUsage(usage)
      if (!listing) { listing = next; paintList() }
      else paintList()
      if (!quiet) say('refused', next.note || COPY.unavailable)
      return false
    }
    if (!retainExplicitUsage) revokeExplicitUsage(usage)
    listing = next
    const cached = listing.cachedUsage
    const cachedAt = Date.parse(cached?.readAt || '')
    if (!usage || (cached?.ok && cachedAt > usageObservedAt)) {
      usage = cached || usage
      usageObservedAt = Number.isFinite(cachedAt) ? cachedAt : usageObservedAt
    }
    paintMode(listing.policy)
    paintList()
    return true
  }

  function markPolicyEditing(control) {
    const policy = listing?.policy
    const value = String(control.value).trim()
    const saved = control === reserveInput ? policy?.reservePercent
      : control === limitSliders.weekly ? (policy?.exhaustedAtPercentWeekly ?? policy?.exhaustedAtPercent)
        : (policy?.exhaustedAtPercentHourly ?? policy?.exhaustedAtPercent)
    if (value !== '' && Number(value) === saved) editingPolicy.delete(control)
    else editingPolicy.add(control)
    if (editingPolicy.size) paintSaveState('editing', COPY.editing)
    else if (policySaving) paintSaveState('saving', COPY.saving)
    else if (!policyWriter.state.failure) paintSaveState('idle', COPY.autosave)
  }

  function paintSaveState(state, text) {
    if (destroyed) return
    saveStatus.dataset.state = state
    saveStatus.textContent = text
  }

  function savePolicyChange(request, confirmation) {
    if (!destroyed) policyWriter.save(request, confirmation)
  }

  async function onPolicyState(state) {
    if (destroyed || state.revision === 0) return
    listVersion += 1
    policySaving = state.saving
    if (state.saving) {
      paintSaveState('saving', COPY.saving)
      say('note', COPY.saving)
      return
    }
    if (usage?.ok) usage = Object.freeze({ ...usage, orders: Object.freeze([]) })
    let refreshed = await refreshList({ quiet: true })
    const superseded = () => destroyed || policyWriter.state.revision !== state.revision
    if (superseded()) return
    // A simultaneous manual refresh may supersede this read without another
    // edit. Finish the confirmation using a current snapshot in that case.
    if (refreshed === null) refreshed = await refreshList({ quiet: true })
    if (superseded()) return
    if (state.failure) {
      paintSaveState('error', COPY.saveFailed)
      say('refused', state.failure)
    } else if (!refreshed) {
      paintSaveState('refresh-failed', COPY.savedRefreshFailed)
      say('note', COPY.savedRefreshFailed)
    } else {
      paintSaveState(editingPolicy.size ? 'editing' : 'saved', editingPolicy.size ? COPY.editing : COPY.saved)
      say('confirmed', state.confirmation)
    }
  }

  async function onRefreshAccounts() {
    if (destroyed || refreshListButton.disabled) return
    refreshListButton.disabled = true
    refreshListButton.textContent = COPY.refreshingAccounts
    void refreshPrograms()
    const refreshed = await refreshList()
    if (destroyed) return
    refreshListButton.disabled = false
    refreshListButton.textContent = COPY.refreshAccounts
    if (refreshed && !policySaving) {
      if (saveStatus.dataset.state === 'refresh-failed') paintSaveState('saved', COPY.saved)
      say('confirmed', COPY.accountsRefreshed)
    }
  }

  /* ---- RENAME, INLINE ON THE ROW ---- */

  function cancelRename(key, { focus = true } = {}) {
    const edit = renameForms.get(key)
    if (!edit) return
    const head = edit.form.parentNode
    const row = head?.parentNode
    edit.form.remove()
    renameForms.delete(key)
    const name = head?.querySelector('.acct-name')
    if (name) name.hidden = false
    if (focus && open) row?.querySelector('[data-acct-row="rename"]')?.focus()
  }

  function startRename(row, head, account) {
    if (busy || destroyed || head.querySelector('.acct-rename')) return
    const form = el(`<span class="acct-rename">
      <input class="acct-input acct-rename-input" type="text" maxlength="64" autocomplete="off" aria-label="${escapeMarkup(COPY.rename)}">
      <button class="acct-btn acct-btn-small" type="button" data-acct-row="rename-save">${escapeMarkup(COPY.renameSave)}</button>
      <button class="acct-btn acct-btn-small" type="button" data-acct-row="rename-cancel">${escapeMarkup(COPY.renameCancel)}</button>
    </span>`)
    const input = form.querySelector('input')
    input.value = account.name
    const nameNode = head.querySelector('.acct-name')
    nameNode.hidden = true
    /* Before the (now hidden) name, so the box sits where the name was. */
    head.insertBefore(form, nameNode)
    const key = accountKey(account)
    const cancel = () => { if (!busy) cancelRename(key) }
    renameForms.set(key, { form, input })
    form.querySelector('[data-acct-row="rename-cancel"]').addEventListener('click', cancel)
    form.querySelector('[data-acct-row="rename-save"]').addEventListener('click', () => { void finishRename(account, input.value, cancel) })
    input.addEventListener('keydown', (event) => {
      /* Enter saves and Escape cancels the box -- and only the box: the
         menu's own Escape listener sits on the document, so this one is
         stopped here rather than closing the whole menu under the person. */
      if (event.key === 'Enter') { event.preventDefault(); void finishRename(account, input.value, cancel) }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
    })
    input.focus()
    if (typeof input.select === 'function') input.select()
  }

  async function finishRename(account, value, cancel) {
    if (busy || destroyed) return
    const newName = String(value || '').trim()
    if (!newName || newName === account.name) { cancel(); return }
    setAccountBusy(true)
    say('note', COPY.renaming)
    const answer = await renameAccount({ name: account.name, provider: account.provider, newName }, scope)
    setAccountBusy(false)
    if (destroyed) return
    if (!answer.ok) {
      say('refused', answer.reason)
      renameForms.get(accountKey(account))?.input.focus()
      return
    }
    cancelRename(accountKey(account), { focus: false })
    say('confirmed', COPY.renamed(account.name, answer.name || newName))
    /* The kept readings are keyed by name; the renamed row is re-read on the
       next check rather than shown under the wrong key. */
    await refreshList({ quiet: true })
    focusAnswer(null, true)
  }

  /* ---- REMOVE, ARMED BY ONE PRESS AND DONE BY THE NEXT ---- */

  async function onRemove(account, button) {
    if (busy || destroyed) return
    if (button.dataset.armed !== 'yes') {
      button.dataset.armed = 'yes'
      button.textContent = COPY.removeArmed
      if (account.client === 'antigravity') say('note', 'This removes the app registration. Sign out separately in Antigravity to end its native sign-in.')
      /* Disarms on its own, so a press left half-done an hour ago is not the
         first half of a removal nobody remembers starting. */
      setTimeout(() => {
        if (!destroyed && button.isConnected && button.dataset.armed === 'yes') {
          button.dataset.armed = 'no'
          button.textContent = COPY.remove
        }
      }, 8000)
      return
    }
    setAccountBusy(true)
    button.disabled = true
    say('note', COPY.removing)
    const answer = await removeAccount({ name: account.name, provider: account.provider }, scope)
    setAccountBusy(false)
    if (destroyed) return
    button.disabled = false
    if (!answer.ok) {
      button.dataset.armed = 'no'
      button.textContent = COPY.remove
      say('refused', answer.reason)
      return
    }
    say('confirmed', COPY.removed(account.name) + (account.client === 'antigravity' ? ' The Antigravity sign-in is preserved.' : ''))
    await refreshList({ quiet: true })
    focusAnswer(button, true)
  }

  async function onRefreshUsage() {
    if (busy || destroyed) return
    setAccountBusy(true)
    refreshButton.disabled = true
    refreshButton.textContent = COPY.refreshing
    say('note', COPY.refreshing)
    const viewRevision = usageViewRevision
    // Probes can take seconds. Read policy AFTER they finish, so an edit
    // made during a check is never replaced by the pre-check snapshot.
    usage = await loadUsage(scope, { previousUsage: usage })
    if (destroyed || !open || viewRevision !== usageViewRevision) revokeExplicitUsage(usage)
    usageObservedAt = Date.parse(usage.readAt || '') || Date.now()
    const refreshed = await refreshList({ quiet: true, retainExplicitUsage: true })
    if (refreshed !== true) { revokeExplicitUsage(usage); if (!destroyed) paintList() }
    setAccountBusy(false)
    if (destroyed) return
    syncAccountControls()
    refreshButton.textContent = COPY.refresh
    const failed = listing ? mergeAccounts(listing, usage).filter(account => account.usageState === 'failed').length : 0
    if (!policySaving) say(usage.ok && refreshed && failed === 0 ? 'confirmed' : 'refused',
      !usage.ok ? usage.reason : !refreshed ? COPY.refreshFailed : failed ? COPY.allowanceSomeFailed(failed) : COPY.checked)
  }

  /* THE RESERVE BOX AS A NUMBER, OR NULL. Empty, non-numeric and out-of-range
     all answer null, and null is never sent: the first draft sent
     Number(value), and Number('') is 0, so clearing the box saved "treat
     nothing as tight" under a "Saved" confirmation. */
  function reserveValue() {
    const raw = String(reserveInput.value ?? '').trim()
    if (raw === '') return null
    if (reserveInput.validity && reserveInput.validity.valid === false) return null
    const number = Number(raw)
    if (!Number.isFinite(number) || number < 0 || number > 100) return null
    return number
  }

  /* WHICH MODE A PROGRAM RUNS UNDER: its own rule when one is recorded, the
     rule above otherwise. The shell's policy reply carries both. */
  function modeForProvider(provider) {
    if (!listing) return 'manual'
    const rule = listing.policy.byProvider ? listing.policy.byProvider[provider] : null
    return rule && rule.own.selectionMode ? rule.selectionMode : listing.policy.selectionMode
  }

  /* ONE RULE PER PROGRAM, drawn in the group head. "Same as above" is the
     recorded absence of a rule, not a copy of the rule above: the program
     follows whatever the mode field says, now and after it changes. The window
     select beside it appears only while the program's effective mode ranks. */
  function providerRuleControl(group) {
    const provider = group.provider
    const rule = listing && listing.policy.byProvider ? listing.policy.byProvider[provider] : null
    const modeOptions = [`<option value="inherit">${escapeMarkup(COPY.sameAsAbove)}</option>`]
      .concat(SELECTION_MODE_CHOICES.map(choice => `<option value="${escapeMarkup(choice.id)}">${escapeMarkup(choice.label)}</option>`))
      .join('')
    const windowOptions = [`<option value="inherit">${escapeMarkup(COPY.sameAsAbove)}</option>`]
      .concat(RANK_WINDOW_CHOICES.map(choice => `<option value="${escapeMarkup(choice.id)}">${escapeMarkup(choice.label)}</option>`))
      .join('')
    const control = el(`<div class="acct-group-rule" role="group" aria-label="${escapeMarkup(COPY.providerRule(group.label))}"><label class="acct-field"><span class="acct-field-label">${escapeMarkup(COPY.providerRule(group.label))}</span><select class="acct-select acct-select-small" data-acct="provider-mode" data-provider="${escapeMarkup(provider)}" aria-label="${escapeMarkup(COPY.providerRule(group.label))}">${modeOptions}</select></label><label class="acct-field" data-acct="provider-rank-field" hidden><span class="acct-field-label">${escapeMarkup(COPY.rankLabel)}</span><select class="acct-select acct-select-small" data-acct="provider-rank" data-provider="${escapeMarkup(provider)}" aria-label="${escapeMarkup(COPY.rankLabel)}" hidden>${windowOptions}</select></label></div>`)
    const modeControl = control.querySelector('[data-acct="provider-mode"]')
    const windowControl = control.querySelector('[data-acct="provider-rank"]')
    modeControl.value = rule && rule.own.selectionMode ? rule.selectionMode : 'inherit'
    windowControl.value = rule && rule.own.rankWindow ? rule.rankWindow : 'inherit'
    windowControl.hidden = !isRankedMode(modeForProvider(provider))
    windowControl.parentElement.hidden = windowControl.hidden
    modeControl.addEventListener('change', () => onProviderRuleChange(provider, modeControl, 'selectionMode'))
    windowControl.addEventListener('change', () => onProviderRuleChange(provider, windowControl, 'rankWindow'))
    return control
  }

  function onProviderRuleChange(provider, control, key) {
    if (destroyed) return
    const chosen = control.value
    const request = { provider, [key]: chosen === 'inherit' ? null : chosen }
    const label = chosen === 'inherit'
      ? COPY.sameAsAbove
      : key === 'selectionMode'
        ? (selectionModeChoice(chosen) || { label: chosen }).label
        : (rankWindowChoice(chosen) || { label: chosen }).label
    if (key === 'selectionMode') {
      const rank = [...root.querySelectorAll('[data-acct="provider-rank"]')].find(node => node.dataset.provider === provider)
      if (rank) {
        rank.hidden = !isRankedMode(chosen === 'inherit' ? modeSelect.value : chosen)
        rank.parentElement.hidden = rank.hidden
      }
    }
    void savePolicyChange(request, COPY.providerRuleSaved(providerLabel(provider), label))
  }

  function onRankChange() {
    if (destroyed) return
    const chosen = rankSelect.value
    const choice = rankWindowChoice(chosen)
    void savePolicyChange({ rankWindow: chosen }, COPY.rankSaved(choice ? choice.label : chosen))
  }

  function onModeChange() {
    if (destroyed) return
    const chosen = modeSelect.value
    const choice = selectionModeChoice(chosen)
    paintModeHelp(chosen)
    const request = { selectionMode: chosen }
    if (chosen === 'dynamic') {
      const reserve = reserveValue()
      if (reserve === null) {
        editingPolicy.add(modeSelect)
        editingPolicy.add(reserveInput)
        reserveInput.setAttribute('aria-invalid', 'true')
        paintSaveState('error', COPY.reserveInvalid)
        say('note', COPY.reserveInvalid)
        return
      }
      request.reservePercent = reserve
    }
    editingPolicy.delete(modeSelect)
    editingPolicy.delete(reserveInput)
    reserveInput.removeAttribute('aria-invalid')
    void savePolicyChange(request, COPY.modeSaved(choice ? choice.label : chosen))
  }

  function onRecoveryChange() {
    if (destroyed) return
    const chosen = autoRecoverInput.checked
    void savePolicyChange({ autoRecoverOnLimit: chosen }, COPY.recoverySaved(chosen))
  }

  async function onSwitch(account, button) {
    if (busy || destroyed) return
    setAccountBusy(true)
    button.disabled = true
    say('note', COPY.switching)
    const answer = await switchAccount({ name: account.name, provider: account.provider }, scope)
    setAccountBusy(false)
    if (destroyed) return
    button.disabled = false
    if (!answer.ok) {
      say('refused', answer.reason)
      focusAnswer(button, false)
      return
    }
    /* Under a ranked mode the engine honours this switch for exactly one run
       and then the ranking places every run after it. The confirmation says so,
       because "the next run starts on it" alone reads as "from now on". */
    const mode = modeForProvider(account.provider)
    const modeChoice = selectionModeChoice(mode)
    const sentence = mode === 'rotate'
      ? COPY.switchedRotate(account.name)
      : !answer.switched
      ? COPY.switchedAlready(account.name)
      : isRankedMode(mode)
        ? COPY.switchedRanked(account.name, modeChoice ? modeChoice.label : mode)
        : COPY.switched(account.name)
    say('confirmed', sentence)
    /* The repaint removes the pressed button; focus is moved AFTER it, to
       the status line, because moving it before would put it on a node the
       repaint is about to take out of the document. */
    await refreshList({ quiet: true })
    focusAnswer(button, true)
  }

  /* WHAT THE ROW DOES WHEN THE SHELL SAYS THAT ONE FOLDER CHANGED.
   *
   * The shell watches the folder a Sign in press was made for and pushes that
   * account's fresh answer. This re-reads the list -- one file read, no program
   * started, the same read opening the menu already does -- so the whole list
   * paints from one answer rather than one row being patched into a listing the
   * rest of which is older. The sentence names what changed, because a row
   * quietly redrawing itself while somebody is looking elsewhere is a change
   * they never saw. An 'unknown' answer says nothing here: the row's own
   * "sign-in not checked" flag is the honest report of it, and a status line
   * that announced "we could not look" for a folder nobody asked about would be
   * noise. */
  function watchSignInChange(account) {
    if (detachSignInChange) { detachSignInChange(); detachSignInChange = null }
    detachSignInChange = onSignInChanged(change => {
      if (destroyed) return
      if (change.name !== account.name || change.provider !== account.provider) return
      // A changed sign-in invalidates this account's previous identity and
      // allowance even when its new state could not be read. Keep other
      // accounts' measurements until an explicit refresh.
      if (usage) {
        const readings = { ...usage.readings }
        delete readings[accountKey(account)]
        usage = Object.freeze({
          ...usage,
          readings: Object.freeze(readings),
          orders: Object.freeze((usage.orders || []).filter(order => order.provider !== account.provider)),
        })
      }
      void refreshList({ quiet: true }).then(() => {
        if (destroyed || change.signedIn === null) return
        say(change.signedIn ? 'confirmed' : 'note',
          change.signedIn ? COPY.signInSeen(change.name) : COPY.signInStillOut(change.name))
      })
    }, scope)
  }

  /* The rows this menu is currently showing, or none. The sign-in run reads
     them between presses without going back to the shell: the shell's answer
     for an account whose window is open is still "not signed in" until the
     person finishes in it, so a re-read would tell the run nothing new. */
  function currentAccounts() {
    if (!listing || !listing.available || listing.damaged) return []
    return mergeAccounts(listing, usage)
  }

  /* THE ONE CALL THAT OPENS A SIGN-IN WINDOW. Both the row's own press and the
   * run below go through it, so the two cannot drift into naming the same
   * window differently, into disagreeing about what has actually been opened,
   * or -- since this change -- into disagreeing about WHICH FOLDER IS BEING
   * LISTENED TO. (onAdd has its own copy of the sequence, because the name it
   * opens for is the one the shell settled on rather than one on the list.)
   *
   * WHY THE WATCH IS ARMED HERE RATHER THAN AT EACH PRESS. MEASURED 2026-09-03
   * on this file: onSignIn() and onAdd() each called watchSignInChange() after
   * their own press and onSignInEach() called it nowhere -- while all three
   * open their window through the same `mc-account:sign-in`, whose handler arms
   * a watch on EVERY call (shell/main.cjs armSignInWatch) over a store whose
   * own note reads "Arming replaces whatever was armed before"
   * (shell/account-registry.cjs watchSignIn). So a run press moved the shell's
   * one watch onto the account it had just opened and left this side listening
   * for the account some earlier row press had named: the run's own packet was
   * dropped by the name test in watchSignInChange, and the account that filter
   * was still waiting for was no longer watched by anything. Every account
   * signed in through the run reported nothing at all, and the only way to
   * learn the outcome was Check allowances -- which starts one short-lived
   * program per account, the one cost this menu tells a person they choose.
   *
   * Arming it at the seam that opens the window makes the two sides agree by
   * construction: whichever press opened the newest window names the account
   * the shell watches AND the account this menu is listening for. It is still
   * one watch, still armed only by a press, and still nothing that polls. */
  async function openSignIn(account, button) {
    button.disabled = true
    say('note', COPY.openingSignIn(account.name))
    const answer = await signInAccount({ name: account.name, provider: account.provider }, scope)
    if (destroyed) return answer
    button.disabled = false
    /* A press that opened nothing armed nothing in the shell either, so there
       is nothing here to listen for -- and the watch that a previous window
       opened is left exactly as it was rather than being torn down by a press
       that failed. */
    if (!answer.ok) return answer
    signInOpened.add(accountKey(account))
    watchSignInChange(account)
    return answer
  }

  async function onSignIn(account, button) {
    if (busy || destroyed) return
    setAccountBusy(true)
    const answer = await openSignIn(account, button)
    setAccountBusy(false)
    if (destroyed) return
    /* Only a window that OPENED is worth listening after, and openSignIn()
       above is where that is decided now -- for this press and for the run's,
       which is the whole point of it being one call. A second arming here would
       be the second copy of a rule that already went out of step once.
       MERGE 2026-09-03: `button.disabled = false` used to sit here; openSignIn()
       above owns the button now, so leaving a second one here would re-enable a
       button the helper deliberately left alone on a destroyed menu. */
    say(answer.ok ? 'confirmed' : 'refused', answer.ok ? readerSentence(COPY.signInOpened(account.name, answer.title)) : answer.reason)
    /* A window that opened takes its account out of the run's queue, so the
       control beside the list is repainted -- and only it. Repainting the rows
       would take away the button that was just pressed, and a refusal is
       supposed to leave the keyboard on it. */
    if (answer.ok) paintSignInEach(currentAccounts())
    focusAnswer(button, answer.ok)
  }

  /* SIGN IN EVERY ACCOUNT THAT NEEDS IT, ONE WINDOW PER PRESS.
   *
   * WHY IT IS NOT A LOOP, and this is the whole design rather than a
   * shortcoming. Signing in finishes in a window this product hands over and
   * never reads (shell/provider-login.cjs, rules 1 and 5), so nothing tells us
   * a sign-in is done; a loop would therefore open every window at once, which
   * is exactly the six-identical-windows state this change exists to end. So a
   * press opens the next one and the control names how many are left. Nothing
   * blocks the person: they may press it again immediately, or use any row's
   * own Sign in button instead.
   *
   * A REFUSAL STOPS THE RUN WHERE IT IS. The account stays in the queue and the
   * shell's own sentence is shown; the run does not step past something it
   * could not do.
   *
   * IT REPORTS BACK THE SAME WAY A ROW DOES. openSignIn() arms the watch for
   * whichever window it opened, so when the person finishes in the run's window
   * the list is re-read, the account drops out of the count above and the
   * status line says so -- without a Check allowances press, which is the one
   * thing on this menu that starts a program per account. */
  async function onSignInEach() {
    if (busy || destroyed) return
    const next = signInQueue(currentAccounts(), signInOpened)[0]
    if (!next) return
    setAccountBusy(true)
    const answer = await openSignIn(next, signInEachButton)
    setAccountBusy(false)
    if (destroyed) return
    const accounts = currentAccounts()
    const left = signInQueue(accounts, signInOpened)
    paintSignInEach(accounts)
    const opened = readerSentence(COPY.signInOpened(next.name, answer.title))
    say(answer.ok ? 'confirmed' : 'refused', answer.ok
      ? (left.length === 0 ? `${opened} ${COPY.signInEachDone}` : opened)
      : answer.reason)
    focusAnswer(signInEachButton, answer.ok)
  }

  function syncAccountControls() {
    const readable = listing?.available && !listing.damaged
    const hasAccounts = readable && listing.accounts.length > 0
    for (const control of policyControls) control.disabled = !hasAccounts
    field('policy-empty').hidden = !readable || hasAccounts
    field('policy-fields').hidden = Boolean(readable && !hasAccounts)
    refreshButton.disabled = busy || !hasAccounts
    signInEachButton.disabled = busy || !hasAccounts
    for (const control of listElement.querySelectorAll('button')) control.disabled = busy
    for (const edit of renameForms.values()) edit.input.disabled = busy
    /* GATED BY ITS OWN EXECUTABLE, NOT BY ITS PROVIDER'S NAME. This read
       `programs[button.dataset.provider]` and ignored dataset.client, so the
       Antigravity button -- declared data-provider="gemini"
       data-client="antigravity" -- was gated by whatever the plain Gemini CLI
       answered, and the plain button by whatever answered for Antigravity. Each
       is a different program, and either could be offered with its own absent.
       programKey() carries the pair; a control with no client is keyed exactly
       as before. */
    for (const button of addButtons) {
      const absent = programs[programKey(button.dataset.provider, button.dataset.client || null)] === 'no'
      button.hidden = absent
      button.disabled = busy || absent || !readable
    }
    for (const link of root.querySelectorAll('[data-acct="setup-provider"]')) {
      link.hidden = programs[programKey(link.dataset.provider, link.dataset.client || null)] !== 'no'
    }
    field('setup-help').hidden = !Object.values(programs).includes('no')
    nameInput.disabled = busy || !readable
    directoryInput.disabled = busy || !readable
    listElement.setAttribute('aria-busy', busy ? 'true' : 'false')
  }

  function setAccountBusy(next) {
    busy = next
    syncAccountControls()
  }

  async function refreshPrograms() {
    const version = ++programsVersion
    const next = await loadProviderPrograms(scope)
    if (destroyed || version !== programsVersion) return
    programs = next
    syncAccountControls()
  }

  /* ONE PRESS ADDS AND OPENS THE SIGN-IN. The name is optional; the shell
     answers the one it settled on and that is the name the sign-in is opened
     for and the sentence names. If the account was added but the window did
     not open, both facts are said, in that order, and the row's own Sign in
     button is the way to try again. */
  async function onAdd(provider, button) {
    if (busy || destroyed) return
    const name = nameInput.value.trim()
    setAccountBusy(true)
    say('note', COPY.adding)
    const client = button.dataset.client || null
    const directory = directoryInput.value.trim()
    const request = { provider, ...(name ? { name } : {}), ...(client ? { client } : {}) }
    const answer = directory
      ? await addRegisteredAccount({ ...request, name, directory }, scope)
      : await addManagedAccount(request, scope)
    if (destroyed) return
    if (!answer.ok) {
      setAccountBusy(false)
      say('refused', answer.reason)
      focusAnswer(button, false)
      return
    }
    if (directory) {
      nameInput.value = ''; directoryInput.value = ''
      setAccountBusy(false)
      say('confirmed', `${answer.name} added. Use Check allowances to verify the client. ${client === 'antigravity' ? 'This folder keeps configuration and conversation history; Antigravity uses the current OS sign-in.' : ''}`)
      await refreshList({ quiet: true }); focusAnswer(button, true)
      return
    }
    say('note', COPY.openingSignIn(answer.name))
    const opened = await signInAccount({ name: answer.name, provider: answer.provider }, scope)
    setAccountBusy(false)
    if (destroyed) return
    nameInput.value = ''
    /* The add's own sign-in window is the same press as the row's, so the new
       row learns it is signed in the same way an existing one does. */
    if (opened.ok) watchSignInChange({ name: answer.name, provider: answer.provider })
    if (opened.ok) say('confirmed', readerSentence(COPY.added(answer.name)))
    if (opened.ok) signInOpened.add(accountKey({ provider: answer.provider, name: answer.name }))
    if (opened.ok) say('confirmed', readerSentence(COPY.added(answer.name, opened.title)))
    else say('refused', `${COPY.addedOnly(answer.name)} ${opened.reason}`)
    await refreshList({ quiet: true })
    /* The status line either way: the account IS on the list now, and the
       sentence there says what comes next -- sign in, or press Sign in on
       the new row -- which the add button cannot. */
    focusAnswer(button, true)
  }

  // A browser demo with no account bridge must not show editable host policy
  // or diagnose an out-of-date computer that is not connected. A real bridge
  // keeps its existing account controls, including on desktop example views.
  function syncPreview() {
    /* THE EXAMPLE SHOWS WHAT THE MENU DOES (owner, 2026-09-11: the example
       fleet should show how the product works), in the browser demo and on a
       desktop whose example switch is on alike. Its own accounts -- src/
       sample-accounts.js, read by this menu's own parser -- are drawn by the
       same rows, with no press on them and no policy beside them, under a line
       saying whose they are not: the browser demo is offered Sign in, the
       desktop is told which switch brings back the person's own accounts. The
       button keeps its plain name, because no account of the example is the
       person's. */
    const preview = currentDataSource() === 'mock'
    const desktop = Boolean(accountsBridge(scope))
    root.dataset.preview = preview ? 'yes' : 'no'
    root.querySelector('.acct-preview').hidden = !preview
    root.querySelector('.acct-preview .acct-help').textContent = desktop ? COPY.previewHelpDesktop : COPY.previewHelp
    root.querySelector('.acct-preview a').hidden = desktop
    if (preview) {
      const example = sampleAccountListing(Date.now())
      listing = example.listing
      usage = example.usage
      paintList()
      triggerLabel.textContent = COPY.buttonUnread
      trigger.title = COPY.title
    }
    return preview
  }
  function previewing() {
    return root.dataset.preview === 'yes'
  }

  /* ---- OPENING AND CLOSING ---- */

  function setOpen(next) {
    if (destroyed || open === next) return
    usageViewRevision++
    revokeExplicitUsage(usage)
    open = next
    menu.hidden = !open
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false')
    root.dataset.open = open ? 'yes' : 'no'
    if (listing) paintList()
    if (open) {
      menu.showModal()
      /* The list is re-read on every open rather than cached, because a folder
         can be signed in, and an account added from Settings, between one
         open and the next. The ALLOWANCES are not: opening starts no program
         (tools/test/account-switcher-dom pins that, and it is the owner's rule
         that the person decides what runs). What the open shows at once is the
         last read the shell kept, dated by the line above the list; the press
         refreshes it. */
      const preview = syncPreview()
      if (!preview) {
        void refreshList({ quiet: true })
        void refreshPrograms()
      }
      /* Focus goes INTO the panel, to its first control, so a keyboard or
         screen-reader user lands on something rather than being left on a
         button that now says "expanded". */
      if (preview) {
        const signIn = root.querySelector('.acct-preview a')
        ;(signIn.hidden ? field('close') : signIn).focus()
      }
      else if (listing?.accounts?.length) queryInput.focus()
      else if (!nameInput.disabled) nameInput.focus()
      else refreshListButton.focus()
    } else {
      if (menu.open) menu.close()
      say('note', '')
    }
  }

  const onDocumentPointer = (event) => {
    if (!open) return
    if (event.target === menu) {
      const bounds = menu.getBoundingClientRect()
      if (event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) return
    } else if (root.contains(event.target)) return
    setOpen(false)
    trigger.focus()
  }
  const onDocumentKey = (event) => {
    if (!open || event.key !== 'Escape') return
    /* THIS PRESS IS SPENT HERE. The rail's own Escape handler is a capture
       listener on this same document and honours defaultPrevented; the drawer
       and the popover close on bubble. All three are stopped: one key closes
       one layer, which is the rule every Escape on this page keeps. Focus goes
       back to the button that opened the menu, so a person who dismissed it
       with the keyboard is left where they started. */
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    const editing = [...renameForms].find(([, edit]) => edit.form.contains(event.target))
    if (editing) {
      if (!busy) cancelRename(editing[0])
      return
    }
    setOpen(false)
    trigger.focus()
  }

  trigger.addEventListener('click', () => setOpen(!open))
  menu.addEventListener('cancel', event => { event.preventDefault(); setOpen(false); trigger.focus() })
  menu.addEventListener('close', () => { if (open) { setOpen(false); trigger.focus() } })
  queryInput.addEventListener('input', paintList)
  providerFilter.addEventListener('change', paintList)
  clearQueryButton.addEventListener('click', () => { queryInput.value = ''; providerFilter.value = ''; paintList(); queryInput.focus() })
  field('close').addEventListener('click', () => { setOpen(false); trigger.focus() })
  refreshListButton.addEventListener('click', () => { void onRefreshAccounts() })
  reserveInput.addEventListener('input', () => {
    markPolicyEditing(reserveInput)
  })
  modeSelect.addEventListener('change', () => { void onModeChange() })
  overrideApply.addEventListener('click', () => { onApplyDefaultToOverriding() })
  autoRecoverInput.addEventListener('change', () => { void onRecoveryChange() })
  rankSelect.addEventListener('change', () => { void onRankChange() })
  reserveInput.addEventListener('change', () => { void onModeChange() })
  for (const window of ['weekly', 'hourly']) {
    limitSliders[window].addEventListener('input', () => onLimitSlide(window))
    limitSliders[window].addEventListener('change', () => { void onLimitChange(window) })
  }
  refreshButton.addEventListener('click', () => { void onRefreshUsage() })
  signInEachButton.addEventListener('click', () => { void onSignInEach() })
  for (const button of addButtons) {
    button.addEventListener('click', () => { void onAdd(button.dataset.provider, button) })
  }
  document.addEventListener('pointerdown', onDocumentPointer, true)
  document.addEventListener('keydown', onDocumentKey, true)

  /* THE FIRST READ IS THE LIST AND NOTHING ELSE. It is a file read, it is what
     the closed button needs in order to name the account in use, and it starts
     no program. */
  const policyControls = [modeSelect, reserveInput, rankSelect, autoRecoverInput, ...Object.values(limitSliders)]
  syncAccountControls()
  const detachPolicy = policyWriter.subscribe(state => { void onPolicyState(state) })
  if (!syncPreview() && policyWriter.state.revision === 0) void refreshList({ quiet: true })

  /* ARRIVED THROUGH A LINK THAT NAMES THIS MENU (T1588). Settings > Setup
     sends people here for the account rule; the menu lives only on
     Computers, so the address that reaches it asks for it open. */
  if (/[?&]accounts=open(?:&|$)/.test(String(globalThis.location?.hash || ''))) queueMicrotask(() => setOpen(true))

  root.__accountSwitcher = Object.freeze({
    destroy() {
      setOpen(false)
      revokeExplicitUsage(usage)
      destroyed = true
      renameForms.clear()
      detachPolicy()
      document.removeEventListener('pointerdown', onDocumentPointer, true)
      document.removeEventListener('keydown', onDocumentKey, true)
      /* The sign-in subscription is this mount's, exactly like the two above:
         the menu mounts per page, and a listener left behind would repaint a
         menu that is no longer on the glass. */
      if (detachSignInChange) { detachSignInChange(); detachSignInChange = null }
    },
  })
  return root
}
