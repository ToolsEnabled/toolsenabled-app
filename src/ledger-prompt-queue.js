import { isDarkTheme } from './theme-choice.js'
// Owner prompt queue mounted within Ledger.
// Presentation verification, decisions and late outcomes retain their existing contracts.

import { el } from './components.js'
import {
  applyOwnerPopupTheme,
  formatExactAmount,
  measuredPresentationEvidence,
  normalizeOwnerPromptSnapshot,
  renderOwnerPrompt,
} from './owner-popup.js'
import {
  decideOwnerPrompt,
  markOwnerPromptPresented,
  ownerPromptSnapshot,
} from './mission-bridge.js'
import {
  beginDecisionOutcome,
  clearUndeliveredDecision,
  recordUndeliveredDecision,
  reconcileUndeliveredDecisions,
  undeliveredDecision,
} from './approval-outcomes.js'
import { cartSummary } from './purchase-cart-view.js'
import { cartChanges, recordCartReading } from './purchase-cart-changes.js'
import { currentDataSource } from './data-source.js'
import { readerRemedy } from './refusal-copy.js'
/* THE DEMONSTRATION FACE (the paid lane's finding, via legal, 2026-08-18):
   every other landing view labels its own example data and this one labelled
   nothing. Which face this screen wears, the words of the marking and the
   example queue itself are all in one pure module, so the label here and the
   labels on home, metrics and research cannot drift apart. */
import { APPROVALS_EXAMPLE_MARKING, approvalsFace, exampleOwnerPrompts } from './approvals-example.js'
import './ledger.css'
import './owner-popup.css'
import './ledger-prompt-queue.css'

// The modal polled at 750ms because it had to appear promptly over whatever
// the owner was doing. A screen he is already looking at does not, and this
// call crosses the audited bridge, so it asks less often.
const POLL_MS = 2_000
const THEME_NAMES = new Set(['white', 'tan', 'black'])

/* Owner prompts and bridge refusals are written by the machine that owns the
   queue. On the relay face that is the computer being driven, not the browser
   painting this screen. Keep the original validated record for decisions, but
   translate each prose field at the point where it is handed to the renderer. */
const readerSentence = sentence => readerRemedy(sentence, { viaRelay: currentDataSource() === 'relay' })

function readerPrompt(prompt) {
  return {
    ...prompt,
    title: readerSentence(prompt.title),
    message: readerSentence(prompt.message),
    ...(prompt.kind === 'purchase_batch' ? {
      items: prompt.items.map(item => ({
        ...item,
        description: readerSentence(item.description),
        merchant: readerSentence(item.merchant),
        purpose: readerSentence(item.purpose),
      })),
    } : {}),
  }
}

function selectedTheme(manifest) {
  const chosen = document.documentElement.dataset.theme
  return isDarkTheme(chosen) ? 'black' : THEME_NAMES.has(chosen) ? chosen : manifest.defaultTheme
}

function pendingPurchaseTotal(prompts) {
  const carts = prompts.filter(prompt => prompt.kind === 'purchase_batch')
  if (carts.length === 0) return null
  const currency = carts[0].currency
  // Only sum what is genuinely comparable. Mixed currencies get no invented
  // conversion rate; the tile falls back to a count instead of a wrong total.
  if (carts.some(cart => cart.currency !== currency)) return null
  return { totalCents: carts.reduce((sum, cart) => sum + cart.totalCents, 0), currency }
}

export function ledgerPromptQueue() {
  const root = el(`
    <section class="ledger-shell ledger-prompt-queue" aria-label="Purchases and decisions">
        <section class="ledger-summary" aria-label="Approval queue totals">
          <div class="ledger-stat" data-state="open">
            <span class="ledger-stat-value" data-summary="waiting">—</span>
            <span class="ledger-stat-label">Waiting for you</span>
            <span class="ledger-stat-note">· nothing is approved unless you approve it</span>
          </div>
          <div class="ledger-stat" data-state="gated">
            <span class="ledger-stat-value" data-summary="purchases">—</span>
            <span class="ledger-stat-label">Purchases to review</span>
            <span class="ledger-stat-note" data-purchase-note>· approving records the decision, it does not spend.</span>
          </div>
          <!-- THE THIRD TILE, AND THE ONE THAT WAS MISSING. Both of the owner's
               shopping lists have a date on which every line is refused, and the
               two requests that reach their date first are not carts at all. A
               screen that showed a total and no clock let the clock win. -->
          <div class="ledger-stat" data-state="open">
            <span class="ledger-stat-value" data-summary="deadline">—</span>
            <span class="ledger-stat-label">Soonest deadline</span>
            <span class="ledger-stat-note" data-deadline-note>· checking what runs out first.</span>
          </div>
        </section>

        <div class="ledger-toolbar">
          <p class="ledger-register-note" aria-live="polite"><span data-visible-count>Checking the queue…</span></p>
          <!-- The demonstration's badge: home's exact words, warn-toned like
               home's, hidden whenever this screen reads the live queue. -->
          <span class="approvals-badge" data-approvals-badge hidden></span>
        </div>
        <p class="approvals-source" data-approvals-source hidden></p>

        <!-- WHAT CHANGED, not just a new total. This screen re-reads the queue
             every two seconds and used to reconcile in silence, so the only
             visible trace of a line appearing or an amount moving was that the
             tile above held a different number than it had a moment before. -->
        <section class="approvals-changes" data-changes hidden aria-live="polite">
          <h2 class="approvals-changes-head">What changed since you opened the program</h2>
          <ul class="approvals-changes-list" data-changes-list></ul>
          <p class="approvals-changes-note" data-changes-note></p>
        </section>

        <section class="ledger-register approvals-list owner-popup-root" aria-live="polite"></section>
    </section>`)

  /* Which face this screen wears, decided once at mount the way home and
     research decide theirs. The demonstration face polls nothing: there is no
     bridge behind a demonstration, and a screen that asked anyway would paint
     "service unavailable" over what is supposed to be a labelled example. */
  const face = approvalsFace()
  root.dataset.face = face

  const list = root.querySelector('.approvals-list')
  const badge = root.querySelector('[data-approvals-badge]')
  const sourceLine = root.querySelector('[data-approvals-source]')
  const waitingValue = root.querySelector('[data-summary="waiting"]')
  const purchasesValue = root.querySelector('[data-summary="purchases"]')
  const purchaseNote = root.querySelector('[data-purchase-note]')
  const countNote = root.querySelector('[data-visible-count]')
  const deadlineValue = root.querySelector('[data-summary="deadline"]')
  const deadlineNote = root.querySelector('[data-deadline-note]')
  const changesBlock = root.querySelector('[data-changes]')
  const changesList = root.querySelector('[data-changes-list]')
  const changesNote = root.querySelector('[data-changes-note]')

  // promptId -> { wrapper, rendered, prompt, presented, submitting, failed }
  const cards = new Map()
  let destroyed = false
  let polling = false
  let timer = null
  let themeManifest = null

  function setUnavailable(title, reason) {
    list.replaceChildren(el(`<div class="projection-state projection-unavailable" role="status"></div>`))
    const state = list.firstElementChild
    const strong = document.createElement('strong')
    strong.textContent = title
    const span = document.createElement('span')
    span.textContent = reason
    state.append(strong, span)
    for (const card of cards.values()) card.wrapper.remove()
    cards.clear()
    waitingValue.textContent = '—'
    purchasesValue.textContent = '—'
    /* THE NOTE UNDER THE DASH HAS TO GO WITH IT. Both tiles fall back to "—"
       here, and the purchases tile kept its resting caption -- "· approving
       records the decision, it does not spend" -- which describes an action
       this screen cannot currently offer, printed under a value it could not
       read. Measured with the capability layer killed mid-session
       (tools/offline-routes-qa.mjs, state layer-killed). */
    purchaseNote.textContent = '· the queue could not be read, so nothing can be approved from here'
    countNote.textContent = 'The queue could not be read, so nothing here is a decision.'
    deadlineValue.textContent = '—'
    deadlineNote.textContent = '· the queue could not be read, so no date is claimed here'
    /* NOTHING IS FILED AS A CHANGE HERE, and that is the important half. A read
       that failed is not a queue that emptied. Comparing an unreadable answer
       against the last good one would print "no longer waiting for you" against
       every list he has, which is the one wrong thing this strip could say. */
  }

  function setCardStatus(card, text, kind = 'status') {
    card.rendered.status.textContent = text
    card.rendered.status.dataset.state = kind
    const failing = kind === 'unavailable'
    card.rendered.status.setAttribute('role', failing ? 'alert' : 'status')
    /* The element is rendered with aria-live="polite", and an explicit
       aria-live OUTRANKS the implicit assertive that role="alert" carries. So
       switching the role alone left "nothing was approved" queued behind
       whatever else the page had to say. Moved with the role, not left behind
       it. */
    card.rendered.status.setAttribute('aria-live', failing ? 'assertive' : 'polite')
  }

  function setCardEnabled(card, enabled) {
    for (const control of card.rendered.gatedControls) control.disabled = !enabled
  }

  function readyText(prompt) {
    return prompt.kind === 'purchase_batch'
      ? 'Ready for review. Undecided lines are denied when you submit.'
      : prompt.kind === 'confirmation' ? 'Ready for your decision.' : 'Ready to acknowledge.'
  }

  /** Said while the card that was submitted is still the card on screen. */
  function notRecordedText(reason) {
    return `${readerSentence(reason) || 'The decision could not be recorded.'} Nothing was approved; you can try again.`
  }

  /**
   * Said when this screen is showing a request whose earlier decision was
   * refused while the screen was gone. It states three things, in the order a
   * person needs them: it did not go through, why, and that the request is
   * still here to decide.
   *
   * "Nothing was approved" is safe to assert without qualification here, and
   * only here, because this text is only ever attached to a card the engine is
   * still reporting as PENDING in the snapshot being rendered — a decision that
   * had landed would have taken the request out of the queue.
   */
  function earlierNotRecordedText(entry) {
    return `The decision you submitted was not recorded: ${readerSentence(entry.reason)} This request is still waiting, so nothing was approved. You can decide it again below.`
  }

  function markUndelivered(card, entry) {
    card.failed = true
    card.wrapper.dataset.decisionUndelivered = 'true'
    setCardStatus(card, earlierNotRecordedText(entry), 'unavailable')
  }

  async function submit(card, body) {
    if (destroyed || card.submitting) return
    card.submitting = true
    setCardEnabled(card, false)
    setCardStatus(card, 'Recording your decision…')
    const outcome = beginDecisionOutcome(card.prompt.id)
    let result
    try { result = await decideOwnerPrompt(body) }
    catch { result = { ok: false } }
    card.submitting = false

    /* THE OUTCOME IS FILED BEFORE THIS FUNCTION ASKS WHETHER ITS SCREEN IS
       STILL THERE. `destroyed` says this view instance has no DOM left to write
       to; it says nothing whatever about whether the owner's decision landed,
       and reading it first is what made a refusal indistinguishable from a
       success. Filing first means the next mount of this screen — and home in
       the meantime — can still tell him. */
    if (result?.ok !== true) {
      card.failed = true
      const entry = recordUndeliveredDecision(card.prompt.id, result?.reason, Date.now(), outcome)
      if (destroyed) return
      if (!entry) { void poll(); return }
      card.wrapper.dataset.decisionUndelivered = 'true'
      // Nothing was recorded, so nothing was approved. Say that plainly and
      // let him try again rather than leaving a dead card behind.
      setCardStatus(card, notRecordedText(result?.reason), 'unavailable')
      setCardEnabled(card, true)
      return
    }
    clearUndeliveredDecision(card.prompt.id, outcome)
    if (destroyed) return
    delete card.wrapper.dataset.decisionUndelivered
    setCardStatus(card, 'Decision recorded.')
    setCardEnabled(card, false)
    void poll()
  }

  async function confirmPresented(card) {
    if (destroyed || card.presented || card.presenting || card.submitting) return
    const evidence = measuredPresentationEvidence(document, card.rendered)
    if (!evidence.mounted || !evidence.visible) return   // not on screen yet; try again next tick
    card.presenting = true
    let result
    try { result = await markOwnerPromptPresented(card.prompt.id, evidence) }
    catch { result = { ok: false } }
    card.presenting = false
    if (destroyed) return
    if (result?.ok !== true) {
      setCardStatus(card, `${readerSentence(result?.reason) || 'This request could not be confirmed as shown.'} No decision can be recorded for it yet.`, 'unavailable')
      return
    }
    card.presented = true
    setCardEnabled(card, true)
    /* A restated refusal is not overwritten with "Ready for review". Both
       sentences are true; only one of them is news, and the ready-text would
       quietly bury the fact that a decision he already made did not land. */
    const earlier = undeliveredDecision(card.prompt.id)
    if (earlier) markUndelivered(card, earlier)
    else setCardStatus(card, readyText(card.prompt))
  }

  function addCard(prompt) {
    const wrapper = document.createElement('div')
    wrapper.className = 'approvals-card'
    wrapper.dataset.promptId = prompt.id
    const rendered = renderOwnerPrompt(document, readerPrompt(prompt), {
      dismiss() {},   // no dismissal on a screen: leaving decides nothing
      submit(body) { void submit(cards.get(prompt.id), body) },
    }, { surface: 'screen' })
    wrapper.append(rendered.dialog)
    list.append(wrapper)
    // measuredPresentationEvidence checks that the container is connected and
    // contains the card, which is what the modal's overlay did for it.
    const card = {
      wrapper, prompt, rendered: { ...rendered, overlay: wrapper }, presented: false, presenting: false, submitting: false, failed: false,
    }
    cards.set(prompt.id, card)
    /* A refusal a previous instance of this screen received and never got to
       say, because the owner had already navigated away. This is the moment it
       reaches him. Stated at mount rather than after presentation is
       re-confirmed, so it is on the glass even if the presentation handshake
       is slow or fails. */
    const earlier = undeliveredDecision(prompt.id)
    if (earlier) markUndelivered(card, earlier)
  }

  function reconcile(prompts) {
    const live = new Set(prompts.map(prompt => prompt.id))
    /* Only reachable from poll(), and only after a snapshot that genuinely
       parsed — which is what makes this a real reading of the queue rather than
       an assumption that it is empty. Records for requests that are no longer
       pending are dropped: see src/approval-outcomes.js. */
    reconcileUndeliveredDecisions([...live])
    for (const [id, card] of [...cards]) {
      if (!live.has(id)) { card.wrapper.remove(); cards.delete(id) }
    }
    // Existing cards are never re-rendered: doing so on a poll tick would wipe
    // per-line Approve/Deny choices the owner had already made but not yet
    // submitted.
    for (const prompt of prompts) if (!cards.has(prompt.id)) addCard(prompt)
    /* A STATE PANEL AND A LIVE QUEUE MAY NEVER BE ON SCREEN TOGETHER, and they
       were. setUnavailable() replaces this list with "The approvals service is
       unavailable — nothing here is a decision", and reconcile only ever
       APPENDS, so the next successful poll drew the whole queue underneath that
       sentence and left it there. On the relay face that is the ordinary case,
       not an edge: the poll runs every two seconds over a tunnel with no retry
       and no grace, so a single failed tick paints the banner, and setUnavailable
       also clears the cards map, which is what makes the recovery re-append
       everything under it. The result is Approve and Deny buttons sitting below
       a sentence telling the reader that nothing here is a decision -- on the
       one screen whose entire subject is consent. Cards present means the read
       worked, so any state panel left over is stale by definition. */
    if (prompts.length > 0) {
      /* ANYTHING IN THIS LIST THAT IS NOT AN OWNED CARD IS STALE, by
         construction -- addCard is the only thing that puts a card here, and
         both state panels arrive through replaceChildren. Written this way
         rather than as a selector for the state panel's class: a selector has
         to name the class, which couples this repair to a stylesheet and
         silently stops working the day the class is renamed. Asking "is this
         one of my cards" cannot rot that way, and it also catches a panel
         nobody has thought of yet. */
      const owned = new Set([...cards.values()].map(card => card.wrapper))
      for (const child of [...list.children]) if (!owned.has(child)) child.remove()
    }
    if (prompts.length === 0) {
      list.replaceChildren(el(`<div class="projection-state" role="status"></div>`))
      const state = list.firstElementChild
      const strong = document.createElement('strong')
      strong.textContent = 'Nothing is waiting for you'
      const span = document.createElement('span')
      span.textContent = 'Requests that need your decision appear here. Nothing acts on your behalf while this is empty.'
      state.append(strong, span)
    }
  }

  function paintSummary(prompts) {
    waitingValue.textContent = String(prompts.length)
    const carts = prompts.filter(prompt => prompt.kind === 'purchase_batch')
    const total = pendingPurchaseTotal(prompts)
    if (carts.length === 0) {
      purchasesValue.textContent = '0'
      purchaseNote.textContent = '· no purchases are waiting'
    } else if (total) {
      purchasesValue.textContent = formatExactAmount(total.totalCents, total.currency)
      purchaseNote.textContent = '· approving records the decision, it does not spend'
    } else {
      purchasesValue.textContent = String(carts.length)
      purchaseNote.textContent = '· mixed currencies, shown as a count rather than a converted total'
    }
    const waiting = prompts.length === 0
      ? 'Queue empty.'
      : `${prompts.length} request${prompts.length === 1 ? '' : 's'} waiting for your decision.`
    /* Counted over the prompts actually being rendered, so this line can never
       report a failure against a request that is no longer in the queue. */
    const undelivered = prompts.filter(prompt => undeliveredDecision(prompt.id)).length
    countNote.textContent = undelivered === 0
      ? waiting
      : `${waiting} ${undelivered} decision${undelivered === 1 ? '' : 's'} you submitted ${undelivered === 1 ? 'was' : 'were'} not recorded, so ${undelivered === 1 ? 'it is' : 'they are'} still here.`
  }

  /* THE CLOCK TILE. Read from the same snapshot the cards are drawn from, so it
     can never name a deadline for a request that is not on the screen. */
  function paintDeadline(summary) {
    if (summary.soonest === null) {
      deadlineValue.textContent = '—'
      deadlineNote.textContent = '· nothing is waiting, so nothing runs out'
      return
    }
    deadlineValue.textContent = summary.soonest.remainingCalendarDays === 0
      ? 'Today'
      : `${summary.soonest.remainingCalendarDays}d`
    deadlineNote.textContent = `· ${summary.soonest.title} — ${summary.soonest.deadline}`
  }

  /* WHAT CHANGED, drawn from the record in src/purchase-cart-changes.js so it
     survives this view being destroyed and rebuilt while he walks the ring. */
  function paintChanges(reading) {
    const entries = cartChanges()
    if (entries.length === 0) {
      changesBlock.hidden = true
      changesList.replaceChildren()
      changesNote.textContent = ''
      return
    }
    changesBlock.hidden = false
    changesList.replaceChildren(...entries.map(entry => {
      const item = document.createElement('li')
      item.className = 'approvals-change'
      item.dataset.tone = entry.tone
      item.textContent = entry.text
      return item
    }))
    /* THE LIMIT OF THIS RECORD, said on the screen rather than left to be
       found out. It is this window's memory, so it starts empty every time the
       program is opened, and the list of requests below is always the whole
       truth whatever this strip happens to remember. */
    changesNote.textContent = reading.firstReading
      ? 'This list starts again each time you open the program. The requests below are always complete.'
      : 'Changes since you opened the program. This list starts again each time you open it.'
  }

  /* THE DEMONSTRATION, PAINTED ONCE. Everything on it is marked: the badge
     over the queue, the source line naming the way back to live data, and
     every card saying in its own status line that it is an example. The cards
     go through the same renderer as the real ones -- a demonstration of the
     product should look like the product -- but their controls are switched
     off and stay off: nothing here calls the audited connection, confirms a
     presentation, files an outcome, or records a cart reading. Example data
     must never leave a trace in a real store. */
  function paintExample() {
    const nowMs = Date.now()
    const prompts = exampleOwnerPrompts(nowMs)
    badge.hidden = false
    badge.textContent = APPROVALS_EXAMPLE_MARKING.badge
    sourceLine.hidden = false
    sourceLine.textContent = APPROVALS_EXAMPLE_MARKING.source
    waitingValue.textContent = String(prompts.length)
    const total = pendingPurchaseTotal(prompts)
    purchasesValue.textContent = total ? formatExactAmount(total.totalCents, total.currency) : '0'
    purchaseNote.textContent = APPROVALS_EXAMPLE_MARKING.purchaseNote
    countNote.textContent = APPROVALS_EXAMPLE_MARKING.queueNote
    let summary = null
    try { summary = cartSummary(prompts, nowMs) } catch { summary = null }
    if (summary?.soonest) {
      deadlineValue.textContent = summary.soonest.remainingCalendarDays === 0 ? 'Today' : `${summary.soonest.remainingCalendarDays}d`
      deadlineNote.textContent = APPROVALS_EXAMPLE_MARKING.deadlineNote
    } else {
      deadlineValue.textContent = '—'
      deadlineNote.textContent = APPROVALS_EXAMPLE_MARKING.deadlineNote
    }
    for (const prompt of prompts) {
      const wrapper = document.createElement('div')
      wrapper.className = 'approvals-card'
      wrapper.dataset.promptId = prompt.id
      wrapper.dataset.example = 'true'
      const rendered = renderOwnerPrompt(document, prompt, {
        dismiss() {},
        submit() {},   // unreachable: the controls below never enable
      }, { surface: 'screen' })
      wrapper.append(rendered.dialog)
      list.append(wrapper)
      rendered.status.textContent = APPROVALS_EXAMPLE_MARKING.cardStatus
      for (const control of rendered.gatedControls) control.disabled = true
    }
  }

  async function poll() {
    if (destroyed || polling) return
    polling = true
    let raw
    try { raw = await ownerPromptSnapshot() }
    catch { raw = null }
    polling = false
    if (destroyed) return
    if (raw?.ok !== true) {
      setUnavailable('The approvals service is unavailable',
        `${readerSentence(raw?.reason) || 'The audited bridge did not answer.'} Nothing here is a decision, and nothing has been approved.`)
      return
    }
    let snapshot
    try { snapshot = normalizeOwnerPromptSnapshot(raw) }
    catch {
      setUnavailable('The approvals response could not be read',
        'The queue or its shared visual theme did not match the expected shape, so it is not being shown rather than shown wrongly.')
      return
    }
    themeManifest = snapshot.theme
    try { applyOwnerPopupTheme(list, themeManifest, selectedTheme(themeManifest)) }
    catch {
      setUnavailable('The shared visual theme could not be applied',
        'The queue is not being rendered rather than rendered in colours that are not the product\'s.')
      return
    }
    reconcile(snapshot.prompts)
    paintSummary(snapshot.prompts)
    /* ONE READING, USED THREE TIMES. The tile, the change strip and the cards
       all come from this same snapshot, so the screen cannot say one thing at
       the top and a different thing six inches lower. A reading is only ever
       filed AFTER the snapshot has genuinely parsed -- see setUnavailable. */
    let summary
    try { summary = cartSummary(snapshot.prompts, Date.now()) }
    catch {
      /* A total that is not the sum of its own lines, or an expiry that is not
         a date. The cards above are already drawn and are the engine's own
         answer; what is refused here is the derived layer, not the queue. */
      deadlineValue.textContent = '—'
      deadlineNote.textContent = '· one request did not add up, so no date is claimed here'
      for (const card of cards.values()) void confirmPresented(card)
      return
    }
    paintChanges(recordCartReading(summary.prompts, Date.now()))
    paintDeadline(summary)
    for (const card of cards.values()) void confirmPresented(card)
  }

  // A card only becomes decidable once it is genuinely on screen, so scrolling
  // is what brings the rest of a long queue into play.
  let scrollScheduled = false
  let scrollFrame = null
  const onScroll = () => {
    if (scrollScheduled || destroyed) return
    scrollScheduled = true
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null
      scrollScheduled = false
      for (const card of cards.values()) void confirmPresented(card)
    })
  }
  root.addEventListener('scroll', onScroll, { passive: true })

  const themeObserver = new MutationObserver(() => {
    if (!themeManifest) return
    try { applyOwnerPopupTheme(list, themeManifest, selectedTheme(themeManifest)) } catch { /* leave the last good paint */ }
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  if (face === 'demonstration') {
    paintExample()
  } else {
    void poll()
    timer = setInterval(() => { void poll() }, POLL_MS)
  }

  return {
    el: root,
    destroy() {
      destroyed = true
      if (timer !== null) clearInterval(timer)
      timer = null
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
      scrollFrame = null
      themeObserver.disconnect()
      root.removeEventListener('scroll', onScroll)
      cards.clear()
    },
  }
}
