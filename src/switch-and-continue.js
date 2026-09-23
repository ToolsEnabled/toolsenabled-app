/* SWITCH AND CONTINUE: one dialog on the circle for account, model and depth.
 *
 * OWNER (T381, 2026-09-18): "when you close and reopen or an agent stops it
 * should just restart without issues. if that account cant then pop up a
 * switch accounts, then let them switch account, model (and provider),
 * effort, so that they can continue. like it should be super easy."
 *
 * WHAT THIS FILE OWNS. The choice, its route and the words on the dialog. The
 * three continuation mechanisms the choice lands on already exist and are not
 * duplicated here:
 *   - a native resume of the saved thread (src/views/computers.js
 *     resumeNodeSession): same account, same provider, any model or depth
 *     that provider offers. Nothing is re-sent, nothing is charged.
 *   - the account continuation (continueNodeOnAnotherAccount): a fresh session
 *     on another account carrying the saved conversation as a handoff.
 *   - the model continuation (continueNodeOnAnotherModel): a fresh session on
 *     another tier, same handoff.
 *
 * WHY THE ROUTE IS A PURE FUNCTION. shell/agent-host.cjs refuses a start that
 * names both a provider thread and continueFromAccount ("Continuing on another
 * account requires a fresh tree replacement without a provider thread"), and
 * "a native thread belongs to the home that made it". So a thread can only be
 * RESUMED on its own account and provider; any other account or provider is a
 * handoff. That rule lives in continuationRouteFor, asserted by value, and the
 * dialog's cost line is drawn from it so the person is told before pressing.
 */
import { SWITCH_PANEL } from './fleet-tree-copy.js'
import { mountTranscriptHistory } from './node-transcript-history.js'
import { setChatMessageBody } from './chat-message-body.js'

const escapeMarkup = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

/* Words the dialog needs that an older `copy` object may not carry. The
   SWITCH_PANEL in fleet-tree-copy.js has them; a caller passing its own copy
   still gets a readable pane rather than "undefined". */
const TARGET_COPY = Object.freeze({
  target: 'This agent',
  targetHint: 'Its saved conversation is shown here so you can see which agent this restart is for.',
  noConversation: 'No saved messages yet.',
  targetChanged: 'This agent has changed since this was opened. Close this and open Switch and continue again from the agent.',
})
const targetWords = copy => ({ ...TARGET_COPY, ...Object.fromEntries(Object.entries(copy || {}).filter(([key, value]) => key in TARGET_COPY && typeof value === 'string' && value)) })

/* THE CONVERSATION BESIDE THE MENU.
 *
 * OWNER (T775, 2026-09-21): "in the popup we need to show the chat next to
 * the menu so the user knows what agent is being restarted." The dialog opens
 * by itself when a saved account is refused, so the person may be looking at
 * a different circle when it appears; a menu with no name and no words on it
 * cannot tell them whose conversation the choice carries on.
 *
 * DRAWN BY THE CHAT'S OWN RENDERER, NOT A SECOND ONE. The pane mounts
 * src/node-transcript-history.js -- the same "Saved conversation" browser the
 * chat surface shows -- against the same store and node id, opened at its
 * newest page, so what the dialog shows is exactly what the conversation shows,
 * paging included. A store without readPage (the legacy window-memory store)
 * is drawn from its held lines with the same row shape and the same message
 * body renderer. Nothing here writes to the store; the dialog still starts
 * nothing itself. */
const CONVERSATION_TAIL = 40
function mountTargetConversation({ document: doc, host, conversation, words, isClosed = () => false }) {
  const store = conversation?.store || null
  const nodeId = conversation?.nodeId
  if (!doc || !host || !store || nodeId == null || nodeId === '') return null
  /* THE PANE IS THE SCROLLPORT. `host` is the .switch-target-chat pane, the
     one element the stylesheet lets scroll (overflow: auto); the renderer's
     own entries list is overflow: visible inside it. So it is the PANE that
     is scrolled to its end once rows exist -- scrolling the inner list moved
     nothing and left the latest reply out of view (M11, T775 review). The
     renderer appends after its own await, so a timer (not a microtask) lands
     after the rows do; a dialog that closed meanwhile is left alone. */
  const scrollToNewest = () => { if (!isClosed()) host.scrollTop = host.scrollHeight }
  if (typeof store.readPage === 'function') {
    const chat = doc.createElement('div')
    chat.className = 'switch-target-chat-surface'
    host.appendChild(chat)
    const watched = { readPage: async (...args) => { const page = await store.readPage(...args); setTimeout(scrollToNewest, 0); return page } }
    const section = mountTranscriptHistory({ host: chat, store: watched, nodeId, document: doc, chat, toggle: 'none' })
    if (!section) return null
    section.toggleSavedConversation()
    return section
  }
  const record = typeof store.get === 'function' ? store.get(nodeId) : null
  const lines = (Array.isArray(record?.lines) ? record.lines : []).filter(line => line && typeof line.text === 'string' && line.text)
  const section = doc.createElement('section')
  section.className = 'node-transcript-history saved-conversation switch-target-chat-legacy'
  section.setAttribute('aria-label', 'Saved conversation')
  const status = doc.createElement('p')
  status.setAttribute('role', 'status')
  status.textContent = lines.length ? 'Saved conversation' : words.noConversation
  const entries = doc.createElement('div')
  entries.className = 'node-transcript-history-entries saved-messages'
  entries.setAttribute('tabindex', '0')
  entries.setAttribute('aria-label', 'Saved messages')
  const WHO = { you: 'You', owner: 'You', me: 'You', action: 'Activity', act: 'Activity' }
  for (const line of lines.slice(-CONVERSATION_TAIL)) {
    const owner = ['you', 'owner', 'me'].includes(line.who)
    const plain = owner || ['action', 'act'].includes(line.who)
    const row = doc.createElement('div')
    row.className = `saved-message ${owner ? 'is-owner' : plain ? 'is-act' : 'is-agent'}`
    const label = doc.createElement('div')
    label.className = 'saved-message-who'
    label.textContent = WHO[line.who] || 'Agent'
    const body = doc.createElement('div')
    body.className = 'chat-msg-text chat-message-body'
    setChatMessageBody(body, line.text, { plain })
    row.append(label, body)
    entries.appendChild(row)
  }
  section.append(status, entries)
  host.appendChild(section)
  /* Same timer as the paged path: the pane has its height once the browser
     has laid the rows out, and a closed dialog is left alone. */
  setTimeout(scrollToNewest, 0)
  return section
}

/* WHICH MODELS THIS DIALOG OFFERS -- ASKED, NOT DECIDED HERE.
 *
 * OWNER (R1238): "why cant i choose to switch models between codex or claude
 * or local or grok or gemini mid session ... why does the button hide now".
 * What stood here dropped the local node and every tree-only row outright:
 * `.filter(row => row.provider !== 'local' && !row.treeOnly)`. Grok, gemini and
 * local were therefore not refused, they were ABSENT, which from the outside is
 * indistinguishable from the product not having them.
 *
 * NOTHING IS DROPPED, AND NOTHING NEW IS PROMISED. Every tier the caller lists
 * now gets a row. A row this dialog cannot route says so in one sentence, and
 * that sentence is about THIS DIALOG, never about the product: the conversation's
 * own model chip does carry a thread onto another provider (the T137/T158
 * continuation path), so a reason here that called grok or gemini unavailable
 * would be false. It says what this dialog does not do and where the route is.
 *
 * `startable` IS THE SHELL'S OWN ANSWER, NOT A GUESS. When the caller has asked
 * the production bridge (mcAgent.startableTiers -> host.startableTiers) it passes
 * the resolved launch-tier ids here and they decide the list, with a valid empty
 * list authoritative. When it has not asked -- the default -- this dialog keeps
 * exactly the set it could already route, so no tier becomes dispatchable that
 * was not dispatchable before. A provider name is never used to rank, entitle or
 * permanently refuse anything, and no reason is invented for a tier nobody asked
 * about.
 *
 * The row the circle ALREADY runs on is never refused: it is the "keep this
 * model" option, and a circle must be able to keep what it has. */
/* WHY TWO SENTENCES AND NOT ONE. This file's first draft sent EVERY refused row
   to the model chip. Builder 7's review found that false for the local node: the
   chip's own list comes from sessionModelChoices, whose startability test falls
   back to `tier.provider !== 'local'` whenever nobody has asked the shell -- and
   src/views/computers.js declares `let startableTierAnswered = false`, so the
   unasked state is the ORDINARY one, not a corner case. Pointing a person at a
   route that also refuses them is the same class of lie the suite here forbids,
   and it got past me because I checked what this dialog does rather than what
   the sentence promises about somewhere else. Tree-only rows keep the chip
   pointer -- that same fallback leaves grok and gemini continuable there -- and
   local gets the sentence that is true of it. */
const MODEL_ROW_REASON = Object.freeze({
  /* Said only of a tree-only row, where the chip really is the working route. */
  notOfferedHere: label => `This dialog does not start ${label}. Use the model chip in the conversation to move this thread to it.`,
  /* Said when the shell answered and left this tier out, and of the local node,
     which nothing has reported startable. It reports the absence of a report --
     never that the product lacks the tier. */
  notReportedStartable: label => `This copy has not reported that it can start ${label}.`,
})

/* Which mechanism a choice lands on. `resume` keeps the thread; `handoff`
   starts a fresh session that reads the saved conversation. Absent account or
   tier in the choice means "keep the current one". */
export function continuationRouteFor({ savedAccount = null, savedProvider = null, currentTier = null, tiers = [], choice = {} } = {}) {
  const tierId = typeof choice.tier === 'string' && choice.tier ? choice.tier : currentTier
  const tier = Array.isArray(tiers) ? tiers.find(row => row?.id === tierId) || null : null
  const provider = tier?.provider || savedProvider || null
  const account = typeof choice.account === 'string' && choice.account
    ? choice.account : provider === savedProvider ? savedAccount : null
  const changesAccount = Boolean(account) && account !== savedAccount
  const changesProvider = Boolean(savedProvider) && provider !== savedProvider
  const changesModel = Boolean(currentTier) && tierId !== currentTier
  const route = changesAccount || changesProvider ? 'handoff' : 'resume'
  return Object.freeze({ route, tier: tierId, provider, account, changesAccount, changesProvider, changesModel })
}

/* The rows a dialog draws, from the product's own lists. Signed-out accounts
   are left out (they cannot serve a start); the refused one stays, marked, so
   the person can see which account said no. Every model row is returned, with
   `available` and, when it is false, the `reason` a reader can act on -- see
   the note above for why none of them is dropped. */
export function switchChoices({ accounts = [], tiers = [], efforts = [], refusedAccount = null, currentTier = null, currentEffort = null, startable = null, answered = true } = {}) {
  const accountRows = (Array.isArray(accounts) ? accounts : [])
    .filter(row => row && typeof row.name === 'string' && row.name && typeof row.provider === 'string' && row.signedIn !== false && row.signedIn !== 'no')
    /* No `current` flag here on purpose: the dialog already knows the account
       the circle is on (its `current.account`) and draws it as the "Keep this
       account" row, filtering it out of the list below. A row-level flag would
       have to be computed from refusedAccount, which is a DIFFERENT thing --
       opened from Actions there is no refused account at all. */
    .map(row => Object.freeze({ name: row.name, provider: row.provider, refused: row.name === refusedAccount }))
  /* An ANSWER, or nothing. An array -- including an empty one -- is the shell
     having spoken and is honoured as given; `answered: false` and a non-array
     both mean nobody has been asked yet, which gates nothing rather than
     inventing a verdict. Same rule startableTierAnswer applies to that reply. */
  const startableIds = answered && Array.isArray(startable) ? new Set(startable) : null
  const modelRows = (Array.isArray(tiers) ? tiers : [])
    .filter(row => row && typeof row.id === 'string')
    .map(row => {
      const label = row.label || row.id
      const current = row.id === currentTier
      /* Order matters. The circle's own row is a fact and is never refused. With
         a real catalog the catalog decides. Without one this dialog keeps the
         exact set it could already route, so the patch adds rows to LOOK at
         without adding anything to dispatch. */
      const reason = current ? ''
        : startableIds ? (startableIds.has(row.id) ? '' : MODEL_ROW_REASON.notReportedStartable(label))
        : row.provider === 'local' ? MODEL_ROW_REASON.notReportedStartable(label)
        : row.treeOnly ? MODEL_ROW_REASON.notOfferedHere(label)
        : ''
      return Object.freeze({ id: row.id, label, provider: row.provider, current, available: !reason, reason })
    })
  const effortRows = (Array.isArray(efforts) ? efforts : [])
    .filter(row => row && typeof row.id === 'string')
    .map(row => Object.freeze({ id: row.id, label: row.label || row.id, description: row.description || '', current: row.id === currentEffort }))
  return Object.freeze({ accounts: Object.freeze(accountRows), models: Object.freeze(modelRows), efforts: Object.freeze(effortRows) })
}

/* `disabled` marks a row the person may see but not take. A disabled row is
   never also `checked`: an unpickable row must not be the one the dialog reads
   back as the choice. */
function radioRows(name, rows, { value, label, note, checked, disabled = () => false, extra = '' }) {
  if (!rows.length) return ''
  return rows.map(row => {
    const off = Boolean(disabled(row))
    return `<label class="switch-row${off ? ' switch-row-off' : ''}"><input type="radio" name="${name}" data-${name} value="${escapeMarkup(value(row))}"${extra ? ` ${extra(row)}` : ''}${off ? ' disabled' : ''}${!off && checked(row) ? ' checked' : ''}> <span>${escapeMarkup(label(row))}</span>${note?.(row) ? ` <small>${escapeMarkup(note(row))}</small>` : ''}</label>`
  }).join('')
}

/* Mount the dialog into `host`. `current` names what the circle runs now;
   `choices` comes from switchChoices; `onChoose` receives
   { account, provider, tier, effort, route } once Continue is pressed. The
   dialog never starts anything itself.

   `target` ({ name, detail }) names the circle the choice is for and
   `conversation` ({ store, nodeId }) is the saved conversation to draw beside
   the menu (see mountTargetConversation). Both are optional: without them the
   dialog is the single pane it always was. The returned `markStale(sentence)`
   is for the caller that watches the circle: once its session is no longer the
   one this dialog was opened for, Continue is disabled and the sentence says
   so, while "Not now" still closes it. `onClose` fires exactly once whenever
   the dialog leaves the document, by any path; `dispose()` is the owner's
   idempotent teardown for a view that is going away. */
export function mountSwitchAndContinueDialog({ document = globalThis.document, host, copy = SWITCH_PANEL, refusalSentence = '', choices, current = {}, tiers = [], target = null, conversation = null, onChoose = () => {}, onCancel = () => {}, onClose = () => {} } = {}) {
  if (!document || !host || !choices) return null
  const tierList = tiers.length ? tiers : choices.models
  const words = targetWords(copy)
  const targetName = typeof target?.name === 'string' ? target.name.trim() : ''
  const targetDetail = typeof target?.detail === 'string' ? target.detail.trim() : ''
  const withTarget = Boolean(targetName || (conversation?.store && conversation.nodeId != null))
  const uid = `switch-${Math.random().toString(36).slice(2, 8)}`
  const root = document.createElement('dialog')
  root.className = withTarget ? 'switch-continue switch-continue-with-target' : 'switch-continue'
  root.setAttribute('aria-labelledby', `${uid}-title`)
  /* The agent pane comes first in reading order (it answers "which agent" before
     "which account"); `autofocus` on the keep-account row keeps the keyboard
     where it landed before the pane existed, on the menu. */
  const targetPane = withTarget ? `
      <aside class="switch-target" data-switch-target aria-labelledby="${uid}-target">
        <p class="switch-target-lead">${escapeMarkup(words.target)}</p>
        <h4 id="${uid}-target" class="switch-target-name" data-switch-target-name>${escapeMarkup(targetName || words.target)}</h4>
        ${targetDetail ? `<p class="switch-target-detail" data-switch-target-detail>${escapeMarkup(targetDetail)}</p>` : ''}
        <p class="switch-target-hint">${escapeMarkup(words.targetHint)}</p>
        <div class="switch-target-chat" data-switch-target-chat></div>
      </aside>` : ''
  root.innerHTML = `
    <form method="dialog" class="switch-form">
      <h3 id="${uid}-title" class="switch-title">${escapeMarkup(copy.title)}</h3>
      <div class="switch-panes">${targetPane}
      <div class="switch-menu" data-switch-menu>
      ${refusalSentence ? `<p class="switch-why" data-switch-why>${escapeMarkup(refusalSentence)}</p>` : ''}
      <p class="switch-lead">${escapeMarkup(copy.opened)}</p>
      <fieldset class="switch-group"><legend>${escapeMarkup(copy.account)}</legend>
        <label class="switch-row"><input type="radio" name="switch-account" data-switch-account value="" checked autofocus> <span>${escapeMarkup(copy.keepAccount)}</span>${current.account ? ` <small>${escapeMarkup(current.account)}</small>` : ''}</label>
        ${radioRows('switch-account', choices.accounts.filter(row => row.name !== current.account), { value: row => row.name, label: row => row.name, note: row => row.refused ? `${row.provider} · ${copy.refused}` : row.provider, checked: () => false, extra: row => `data-provider="${escapeMarkup(row.provider)}"${row.refused ? ' data-refused="true"' : ''}` })}
        ${choices.accounts.length ? '' : `<p class="switch-note">${escapeMarkup(copy.noAccounts)}</p>`}
      </fieldset>
      <fieldset class="switch-group"><legend>${escapeMarkup(copy.model)}</legend>
        ${radioRows('switch-model', choices.models, { value: row => row.id, label: row => row.label,
          note: row => row.available === false && row.reason ? `${row.provider} · ${row.reason}` : row.provider,
          checked: row => row.id === current.tier, disabled: row => row.available === false,
          extra: row => `data-provider="${escapeMarkup(row.provider)}"${row.available === false ? ' data-unavailable="true"' : ''}` })}
      </fieldset>
      <fieldset class="switch-group"><legend>${escapeMarkup(copy.effort)}</legend>
        ${radioRows('switch-effort', choices.efforts, { value: row => row.id, label: row => row.label, note: row => row.description, checked: row => row.id === current.effort })}
      </fieldset>
      <output class="switch-cost" data-switch-cost aria-live="polite"></output>
      <div class="switch-actions">
        <button type="button" class="switch-continue-btn" data-switch-continue>${escapeMarkup(copy.continue)}</button>
        <button type="button" class="switch-cancel-btn" data-switch-cancel>${escapeMarkup(copy.cancel)}</button>
      </div>
      </div>
      </div>
    </form>`
  /* A DISABLED INPUT IS NEVER THE ANSWER, and the read has to say so itself.
     radioRows already refuses to mark a refused row checked, so on a freshly
     mounted dialog the two agree. They stop agreeing the moment anything sets
     `checked` without consulting `available` -- a form or session restore, or
     the next obvious feature here, "remember the last pick". Builder 7 drove
     exactly that by value and the dialog handed back the tier it had just drawn
     as unpickable. Reading `disabled` makes the answer depend on what the dialog
     PAINTED rather than on nobody ever writing checked. */
  const picked = selector => Array.from(root.querySelectorAll(selector)).find(input => input.checked && !input.disabled) || null
  const readChoice = () => {
    const account = picked('[data-switch-account]')
    const model = picked('[data-switch-model]')
    const effort = picked('[data-switch-effort]')
    const tier = model?.value || current.tier || null
    const provider = model?.getAttribute('data-provider') || tierList.find(row => row.id === tier)?.provider || current.provider || null
    return { account: account?.value || null, provider, tier, effort: effort?.value || current.effort || null }
  }
  /* The cost line is the stale reason's home too: once the target moved on,
     changing an account, model or depth must not paint a cost over it (M11,
     T775 review). The route is still computed for the caller's read. */
  let stale = false
  const paintCost = () => {
    const choice = readChoice()
    const route = continuationRouteFor({ savedAccount: current.account || null, savedProvider: current.provider || null, currentTier: current.tier || null, tiers: tierList, choice })
    const cost = root.querySelector('[data-switch-cost]')
    if (cost && !stale) cost.textContent = route.route === 'resume' ? copy.costResume : copy.costHandoff
    return route
  }
  const inputs = Array.from(root.querySelectorAll('input'))
  for (const input of inputs) input.addEventListener('change', () => {
    /* One pick per group. A browser keeps radios exclusive by itself; this
       keeps the read the same under a document that does not. */
    if (input.checked) for (const other of inputs) if (other !== input && other.getAttribute('name') === input.getAttribute('name')) other.checked = false
    paintCost()
  })
  /* THE CHAT THAT WAS BEING TYPED IN KEEPS ITS FOCUS. A modal dialog that opens
     on its own lands in the middle of someone's work; when it closes, whatever
     had the keyboard before gets it back (a native dialog does this too, but
     the element is removed here on close, so it is done by hand and by value).
     The composer's draft is never touched: this dialog reads the store and
     writes nothing. */
  const opener = document.activeElement && typeof document.activeElement.focus === 'function' ? document.activeElement : null
  /* ONE WAY OUT, HOWEVER IT LEAVES. Continue, Not now, Escape, the returned
     close() and dispose() all pass through here exactly once; `onClose` is the
     caller's single release hook (its per-circle slot, its status listener),
     so no exit path can leave those behind (M11, T775 review). After this the
     dialog is out of the document: a page read still in flight finds no
     connected section to paint, and the scroll timer is fenced by isClosed. */
  let closed = false
  const isClosed = () => closed
  const close = () => {
    if (closed) return
    closed = true
    try { if (typeof root.close === 'function' && root.open) root.close() } catch { /* already closed */ }
    root.remove()
    if (opener && opener.isConnected !== false && !root.contains(opener)) { try { opener.focus() } catch { /* the opener may be gone */ } }
    try { onClose() } catch { /* a release hook must not keep the dialog on screen */ }
  }
  /* Owner disposal: the view that opened this is going away (navigation,
     destroy). Idempotent; a second call after any other exit is a no-op. */
  const dispose = () => { close() }
  /* CONTINUE REFUSES RATHER THAN ANSWERING WITH NOTHING.
     A circle with no current tier, opened against an authoritative EMPTY
     catalog, has no pickable row and no fallback -- readChoice resolves tier
     null and continuationRouteFor happily returns route 'resume' for it. Before
     this guard, Continue stayed live and handed the caller a null tier, which
     computers.js would then try to start. The dialog is the last place that
     still knows the list was empty, so it is the place that has to say so.
     Refusing keeps the dialog OPEN and the conversation untouched; silently
     doing nothing would be its own defect. */
  const CONTINUE_REFUSAL = Object.freeze({
    nothingPickable: 'This copy has not reported a model this dialog can start, so there is nothing to continue on. Nothing has changed.',
    noneChosen: 'Choose a model to continue on. Nothing has changed.',
  })
  /* THE CIRCLE MOVED ON WHILE THE DIALOG WAS OPEN. The caller that watches the
     circle (offerSwitchAndContinue's status listener) reports a session that is
     no longer the one this was opened for -- a Resume that succeeded elsewhere,
     a restart, a removal. Continue would be refused by the caller anyway; this
     makes the refusal visible on the dialog instead of a silent close. The
     stale flag is declared beside paintCost, which honours it. */
  const markStale = (sentence = words.targetChanged) => {
    if (closed || stale) return false
    stale = true
    root.dataset.switchStale = 'true'
    const button = root.querySelector('[data-switch-continue]')
    if (button) { button.disabled = true; button.setAttribute('aria-disabled', 'true') }
    const cost = root.querySelector('[data-switch-cost]')
    if (cost) cost.textContent = String(sentence || words.targetChanged)
    return true
  }
  root.querySelector('[data-switch-continue]').addEventListener('click', () => {
    if (stale) return
    const route = paintCost()
    const choice = readChoice()
    const drawn = choices.models.find(row => row.id === choice.tier) || null
    /* Unknown-to-this-list tiers are left alone: a caller may legitimately hold
       a current tier it did not draw. What is refused is an ABSENT answer, and
       a tier this dialog itself marked unavailable. */
    if (!choice.tier || drawn?.available === false) {
      const cost = root.querySelector('[data-switch-cost]')
      if (cost) {
        cost.textContent = choices.models.some(row => row.available)
          ? CONTINUE_REFUSAL.noneChosen
          : CONTINUE_REFUSAL.nothingPickable
      }
      return
    }
    const chosen = { ...choice, account: choice.account || current.account || null, route: route.route }
    close()
    onChoose(chosen)
  })
  root.querySelector('[data-switch-cancel]').addEventListener('click', () => { close(); onCancel() })
  root.addEventListener('cancel', () => { close(); onCancel() })
  host.appendChild(root)
  /* Mounted once the dialog is in the document: the renderer's page load only
     paints into a connected section. */
  const conversationPane = withTarget
    ? mountTargetConversation({ document, host: root.querySelector('[data-switch-target-chat]'), conversation, words, isClosed })
    : null
  paintCost()
  try { if (typeof root.showModal === 'function') root.showModal() } catch { root.open = true }
  return { root, close, dispose, isClosed, readChoice, markStale, target: withTarget ? { name: targetName, detail: targetDetail, conversation: conversationPane } : null }
}
