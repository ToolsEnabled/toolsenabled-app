/* THE PERSON'S HAND ON ONE ROW OF THE LEDGER PAGE.
 *
 * Edit turns the words into a box with Save and Cancel and sends the new words
 * exactly as typed. Delete takes two presses, and the first says what the
 * second will do. Approve counts a rule an agent filed; Decline takes two
 * presses too, with room for a reason between them. Every write goes through
 * window.mcAgent, whose main-process side refuses any caller that is not the
 * person at the window -- this module draws nothing it cannot back, and the
 * view draws no control whose verb the bridge lacks.
 *
 * PURE OVER THE ELEMENT IT IS HANDED. The register is any object with
 * addEventListener; a row is found from the pressed button with closest(), and
 * the two slots under a row -- the hint line and the editor slot -- are found
 * with querySelector. tools/test/ledger-row-actions.test.mjs drives it against
 * stand-ins and a recording bridge. The person's words go to the bridge and to
 * the text box, nowhere else: nothing here logs them.
 */

import { armOnce } from './arm-press.js'
import { REQUEST_PANEL } from './tree-standing-requests.js'
import { ANSWER_ROW, COMPLETE_ROW, DECIDE_ROW, DELETE_ROW, EXAMPLE_WRITE_NOTE, LEDGER_LIMITS, ROW_ACTIONS, ledgerRefusalSentence, utf8Bytes } from './ledger-copy.js'

/* THE LEDGER'S OWN ID GRAMMAR (2026-09-07): R1..R9999 as it always was, and
   now T and A the same shape -- the owner's four subsets share one counter
   grammar, only the leading letter differs (LEDGER-KINDS-INTERFACE-
   20260907.md). P is deliberately absent: P's rows are not drawn by this
   module at all (src/views/ledger.js mounts approvals.js for the P tab,
   which decides through its own bridge), so a P id reaching this regex would
   only ever be a control this module never drew. */
const SAFE_ID = /^[RTA](?:0\d|[1-9]\d{0,3})(?:\.[1-9]\d*)*$/
const ACTIONS = new Set(['edit', 'delete', 'approve', 'decline', 'complete', 'answer', 'save', 'cancel'])
const CODE_SHAPED = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g

const escapeText = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))

/* The code on a refusal, whether it crossed as `error.code` or -- the way the
   main process hands a throw to the window -- as the last code-shaped word of
   the message. */
function refusalCodeOf(error) {
  if (error && typeof error.code === 'string' && error.code.length > 0) return error.code
  const message = error && typeof error.message === 'string' ? error.message : ''
  const found = message.match(CODE_SHAPED) || []
  return found.length ? found[found.length - 1] : ''
}

/* A refusal because the record moved on under the press (an agent answered
   the ask, the task was blocked, the rule was decided elsewhere): the page
   re-reads, since the row on screen is out of date. */
const STALE_CODES = new Set(['AGENT_REQUEST_STATUS_INVALID', 'R_LEDGER_STATUS_INVALID', 'AGENT_REQUEST_ENTRY_UNKNOWN', 'R_LEDGER_ENTRY_UNKNOWN'])

function refusalSentence(error, id, verb) {
  const code = refusalCodeOf(error)
  if (code === 'R_LEDGER_STATUS_INVALID') {
    if (verb === 'complete') return COMPLETE_ROW.gone(id)
    if (verb === 'answer') return ANSWER_ROW.gone(id)
    return DECIDE_ROW.gone(id)
  }
  if (code === 'AGENT_REQUEST_UNAVAILABLE') return REQUEST_PANEL.unavailableWrite
  if (code === 'AGENT_REQUEST_ENTRY_UNKNOWN') return verb === 'decide' ? DECIDE_ROW.gone(id) : REQUEST_PANEL.entryGone(id)
  if (code === 'AGENT_REQUEST_STATUS_INVALID') return DECIDE_ROW.gone(id)
  if (code === 'AGENT_REQUEST_WORDS_EMPTY') return REQUEST_PANEL.editEmpty
  if (code === 'AGENT_REQUEST_WORDS_TOO_LONG') return REQUEST_PANEL.tooLong
  if (code === 'AGENT_REQUEST_WORDS_HEADING') return REQUEST_PANEL.heading
  if (code === 'MC_AGENT_PRINCIPAL_READ_ONLY' || code === 'MC_AGENT_PRINCIPAL_INVALID') return REQUEST_PANEL.readOnly
  /* History that needs review, damaged history, text over the store's limit:
     no retry can fix these, so they are never "Try once more". */
  const shared = ledgerRefusalSentence(code)
  if (shared) return shared
  if (verb === 'edit') return REQUEST_PANEL.editFailed
  if (verb === 'decide') return DECIDE_ROW.failed
  if (verb === 'complete') return COMPLETE_ROW.failed
  if (verb === 'answer') return ANSWER_ROW.failed
  return DELETE_ROW.failedFor(id)
}

/* THE BOX THAT REPLACES NOTHING: it opens in the slot under the row, so the
   row itself -- and the armed control on it -- is never repainted. Edit and
   Answer share this one box; `purpose` rides on the textarea itself
   (data-editor-purpose) so the 'save' press below knows which bridge verb to
   call without a second box to keep in step with this one. */
function editorMarkup(id, key, draft, escape, { purpose = 'edit', label } = {}) {
  const keyAttr = key ? ` data-key="${escape(key)}"` : ''
  const fieldLabel = label || ROW_ACTIONS.editorLabel(id)
  return `<textarea class="ledger-editor" data-row-editor-words data-editor-purpose="${escape(purpose)}" rows="3" aria-label="${escape(fieldLabel)}">${escape(draft)}</textarea>
    <div class="ledger-row-actions" role="group" aria-label="${escape(ROW_ACTIONS.groupLabel(id))}">
      <button class="ledger-ctl" type="button" data-row-action="save" data-id="${escape(id)}"${keyAttr}>${escape(ROW_ACTIONS.save)}</button>
      <button class="ledger-ctl" type="button" data-row-action="cancel" data-id="${escape(id)}">${escape(ROW_ACTIONS.cancel)}</button>
    </div>`
}

function reasonMarkup(id, escape) {
  return `<label class="ledger-reason">${escape(ROW_ACTIONS.reasonLabel)}<input class="ledger-reason-input" data-row-reason maxlength="2000" aria-describedby="ledger-reason-${escape(id).replace(/\./g, '-')}" /></label>`
}

/**
 * One handler over the register.
 *
 * @param register  the element the rows are drawn in (addEventListener)
 * @param bridge    window.mcAgent, or a stand-in with requestEdit /
 *                  requestRemove / requestDecide (R), completeTask /
 *                  removeTask (T), answerAsk / declineAsk / removeAsk (A)
 * @param arm       the two-press mechanism, src/arm-press.js by default
 * @param onChanged called after every write the bridge accepted; the view
 *                  reloads the register from it
 * @param onOutcome called just before onChanged with what the write did:
 *                  {id, verb, removed} for a delete, {decision} for a decline
 * @param refinementsOf id -> the live refinement ids a rule's Delete takes too
 * @param onStale   called after a refusal that says the record moved on under
 *                  the press ({id, verb, sentence}); the view re-reads
 * @param rowOf     id -> the row's data (its words feed the editor)
 * @param isBadged  whether the register on screen is the example
 */
export function mountLedgerRowActions(register, {
  bridge = null,
  arm = armOnce,
  onChanged = () => {},
  rowOf = () => null,
  isBadged = () => false,
  refinementsOf = () => [],
  onOutcome = () => {},
  onStale = () => {},
  exampleNote = () => EXAMPLE_WRITE_NOTE,
  escape = escapeText,
} = {}) {
  const verbs = Object.freeze({
    edit: typeof bridge?.requestEdit === 'function',
    /* R's OWN remove and decide, untouched: requestRemove/requestDecide are
       R's verbs alone now that T, A and P have their own (see below). */
    remove: typeof bridge?.requestRemove === 'function',
    decide: typeof bridge?.requestDecide === 'function',
    /* T's Complete and Remove, A's Answer and Decline: the engine lane's own
       per-kind verbs (Worker 4, own branch) -- completeTask, removeTask,
       answerAsk, declineAsk. A's own Remove (removeAsk) is the engine
       store's actual fourth kind-A verb (src/lib/owner-request-store.js
       exports it alongside declineAsk); wired the same way so A's delete
       does not silently call R's requestRemove with an A id. */
    complete: typeof bridge?.completeTask === 'function',
    removeTask: typeof bridge?.removeTask === 'function',
    answer: typeof bridge?.answerAsk === 'function',
    declineAsk: typeof bridge?.declineAsk === 'function',
    removeAsk: typeof bridge?.removeAsk === 'function',
  })
  let pending = false

  const recordOf = button => (button && typeof button.closest === 'function' ? button.closest('.ledger-record') : null)
  const slotOf = (record, selector) => (record && typeof record.querySelector === 'function' ? record.querySelector(selector) : null)

  /* The sentence under the row, written in place. */
  function say(record, text, tone = 'note') {
    const hint = slotOf(record, '[data-row-hint]')
    if (!hint) return
    hint.textContent = text || ''
    hint.dataset.state = tone
    hint.hidden = !text
  }

  function openSlot(record, markup) {
    const slot = slotOf(record, '[data-row-editor]')
    if (!slot) return null
    slot.innerHTML = markup
    slot.hidden = false
    return slot
  }

  function closeSlot(record) {
    const slot = slotOf(record, '[data-row-editor]')
    if (!slot) return
    slot.innerHTML = ''
    slot.hidden = true
  }

  async function send(record, id, call, verb, detail = {}) {
    pending = true
    let answer = null
    let failure = null
    try {
      answer = await call()
    } catch (error) {
      failure = error
    }
    pending = false
    if (answer && answer.ok === true) {
      closeSlot(record)
      /* WHAT THE WRITE DID, before the reload redraws the row away. A delete
         answers with every id it removed (a rule takes its refinements), so
         the page can say which rows went and where they are kept. */
      const removed = verb === 'delete' && Array.isArray(answer.removed)
        ? answer.removed.filter(entry => typeof entry === 'string' && SAFE_ID.test(entry))
        : []
      onOutcome({ id, verb, ...detail, ...(verb === 'delete' ? { removed: removed.length ? removed : [id] } : {}) })
      await onChanged({ id, verb })
      return true
    }
    const sentence = refusalSentence(failure || answer, id, verb)
    say(record, sentence, 'refused')
    /* The record moved on under the press: re-read the list, keeping the
       sentence and any open box (the view holds them across the reload). */
    if (STALE_CODES.has(refusalCodeOf(failure || answer))) await onStale({ id, verb, sentence })
    return false
  }

  async function press(event) {
    const target = event && event.target
    const button = target && typeof target.closest === 'function' ? target.closest('[data-row-action]') : null
    if (!button || !button.dataset) return
    const action = button.dataset.rowAction
    const id = button.dataset.id
    const key = typeof button.dataset.key === 'string' && button.dataset.key !== '' ? button.dataset.key : null
    if (!ACTIONS.has(action) || typeof id !== 'string' || !SAFE_ID.test(id)) return
    const record = recordOf(button)
    if (!record) return
    /* AN EXAMPLE NEVER ISSUES A WRITE. The view stops these presses before
       they get here; this is the same line held once more, in case a control
       is ever drawn on an example row by a path the view did not fence. */
    if (isBadged()) { say(record, exampleNote(), 'note'); return }
    if (pending) return

    if (action === 'edit') {
      if (!verbs.edit) { say(record, REQUEST_PANEL.editUnavailable, 'unavailable'); return }
      const row = rowOf(id)
      const draft = row && typeof row.words === 'string' ? row.words : ''
      const slot = openSlot(record, editorMarkup(id, key, draft, escape, { purpose: 'edit', label: ROW_ACTIONS.editorLabel(id) }))
      const editor = slot && typeof slot.querySelector === 'function' ? slot.querySelector('[data-row-editor-words]') : null
      if (editor && typeof editor.focus === 'function') editor.focus()
      say(record, '')
      return
    }
    if (action === 'answer') {
      if (!verbs.answer) { say(record, ANSWER_ROW.unavailableWrite, 'unavailable'); return }
      /* Answer opens on a blank box, not the ask's own words: the words are
         the question, an answer is a different sentence, and prefilling one
         with the other would invite pressing Save over an unread question. */
      const slot = openSlot(record, editorMarkup(id, key, '', escape, { purpose: 'answer', label: ROW_ACTIONS.answerLabel(id) }))
      const editor = slot && typeof slot.querySelector === 'function' ? slot.querySelector('[data-row-editor-words]') : null
      if (editor && typeof editor.focus === 'function') editor.focus()
      say(record, '')
      return
    }
    if (action === 'complete') {
      if (!verbs.complete) { say(record, COMPLETE_ROW.unavailableWrite, 'unavailable'); return }
      // T/A writes identify the record by its globally unique ledger id.
      // Their strict IPC contract does not accept the row's display scope key.
      await send(record, id, () => bridge.completeTask({ id }), 'complete')
      return
    }
    if (action === 'cancel') {
      closeSlot(record)
      say(record, '')
      /* The Cancel that was pressed is gone with the box; focus goes back to
         the Edit or Answer that opened it rather than falling off the row. */
      const opener = slotOf(record, '[data-row-action="edit"]') || slotOf(record, '[data-row-action="answer"]')
      if (opener && typeof opener.focus === 'function') opener.focus()
      return
    }
    if (action === 'save') {
      const editor = slotOf(record, '[data-row-editor-words]')
      const purpose = editor && editor.dataset ? editor.dataset.editorPurpose : 'edit'
      const words = editor && typeof editor.value === 'string' ? editor.value : ''
      /* Longer than the store keeps: said before sending, and the words stay. */
      if (utf8Bytes(words.trim()) > LEDGER_LIMITS.wordsBytes) { say(record, ledgerRefusalSentence('R_LEDGER_WORDS_TOO_LONG'), 'refused'); return }
      if (purpose === 'answer') {
        if (!verbs.answer) { say(record, ANSWER_ROW.unavailableWrite, 'unavailable'); return }
        if (!words.trim()) { say(record, ANSWER_ROW.empty, 'refused'); return }
        await send(record, id, () => bridge.answerAsk({ id, words }), 'answer')
        return
      }
      if (!verbs.edit) { say(record, REQUEST_PANEL.editUnavailable, 'unavailable'); return }
      if (!words.trim()) { say(record, REQUEST_PANEL.editEmpty, 'refused'); return }
      await send(record, id, () => bridge.requestEdit({ id, ...(key ? { key } : {}), words }), 'edit')
      return
    }
    if (action === 'delete') {
      /* EACH KIND'S OWN REMOVE. R's id has no bearing on T or A's record, so
         the id's own leading letter (SAFE_ID already enforces one of R/T/A)
         picks the bridge verb: requestRemove for R, removeTask for T,
         removeAsk for A -- the engine store's own three functions, never one
         call reused across kinds it was not written for. */
      const kindLetter = id.charAt(0)
      const removeVerb = kindLetter === 'T' ? 'removeTask' : kindLetter === 'A' ? 'removeAsk' : 'remove'
      const removeCall = kindLetter === 'T' ? 'removeTask' : kindLetter === 'A' ? 'removeAsk' : 'requestRemove'
      if (!verbs[removeVerb]) { say(record, REQUEST_PANEL.deleteUnavailable, 'unavailable'); return }
      /* FIRST PRESS ARMS, SECOND ACTS. A lone press disarms and the sentence
         goes with it, so the row never sits there threatening. */
      if (!arm(button, { onDisarm: () => say(record, '') })) {
        const refinements = kindLetter === 'R' ? (refinementsOf(id) || []).filter(entry => typeof entry === 'string' && SAFE_ID.test(entry)) : []
        say(record, DELETE_ROW.armed(id, refinements), DELETE_ROW.tone)
        return
      }
      await send(record, id, () => bridge[removeCall]({ id, ...(kindLetter === 'R' && key ? { key } : {}) }), 'delete')
      return
    }
    if (action === 'approve') {
      if (!verbs.decide) { say(record, REQUEST_PANEL.unavailableWrite, 'unavailable'); return }
      await send(record, id, () => bridge.requestDecide({ id, decision: 'approve' }), 'decide')
      return
    }
    if (action === 'decline') {
      /* R'S DECLINE (a proposal an agent filed) AND A'S DECLINE (an ask the
         owner will not answer) SHARE THIS ONE BUTTON AND ITS TWO-PRESS,
         REASON-FIRST SHAPE, split only by the id's own leading letter --
         same reason the delete branch above splits by it. R keeps
         requestDecide exactly as it always called it; A calls the engine's
         own declineAsk. */
      const isAsk = id.charAt(0) === 'A'
      if (!(isAsk ? verbs.declineAsk : verbs.decide)) { say(record, REQUEST_PANEL.unavailableWrite, 'unavailable'); return }
      /* THE REASON OUTLIVES THE ARM. A lone press disarms itself after a
         moment, and that used to close the reason box with whatever had been
         typed into it -- a person who paused to word the reason lost it. The
         disarm now resets only the pressed state and the sentence; the box
         and its text stay, and the next press re-arms around them rather
         than painting a fresh box over them. */
      if (!arm(button, { onDisarm: () => say(record, '') })) {
        if (!slotOf(record, '[data-row-reason]')) openSlot(record, reasonMarkup(id, escape))
        say(record, DECIDE_ROW.declineArmed(id), DECIDE_ROW.tone)
        return
      }
      const input = slotOf(record, '[data-row-reason]')
      const reason = input && typeof input.value === 'string' ? input.value.trim() : ''
      if (utf8Bytes(reason) > LEDGER_LIMITS.reasonBytes) { say(record, ledgerRefusalSentence('R_LEDGER_REASON_INVALID'), 'refused'); return }
      if (isAsk) {
        await send(record, id, () => bridge.declineAsk({ id, ...(reason ? { reason } : {}) }), 'decide', { decision: 'decline' })
        return
      }
      await send(record, id, () => bridge.requestDecide({ id, decision: 'decline', ...(reason ? { reason } : {}) }), 'decide', { decision: 'decline' })
    }
  }

  /* REOPEN A BOX THE REDRAW TOOK AWAY. The view repaints the register on
     every reload, so it holds each open editor and reason box by row before
     the repaint and hands them back here afterwards, text and all. Nothing is
     armed by this: a reason box comes back open, and the next Decline press
     arms around it. Answers false when the row is not on screen any more. */
  function reopen({ id, kind, value = '' } = {}) {
    if (typeof id !== 'string' || !SAFE_ID.test(id)) return false
    if (!register || typeof register.querySelector !== 'function') return false
    const record = register.querySelector(`[data-row-id="${id}"]`)
    if (!record) return false
    const text = typeof value === 'string' ? value : ''
    if (kind === 'editor') {
      if (!verbs.edit) return false
      const row = rowOf(id)
      const key = row && typeof row.scopeKey === 'string' && row.scopeKey !== '' ? row.scopeKey : null
      const slot = openSlot(record, editorMarkup(id, key, text, escape, { purpose: 'edit', label: ROW_ACTIONS.editorLabel(id) }))
      const editor = slot && typeof slot.querySelector === 'function' ? slot.querySelector('[data-row-editor-words]') : null
      if (editor) editor.value = text
      return Boolean(slot)
    }
    if (kind === 'answer') {
      if (!verbs.answer) return false
      const row = rowOf(id)
      const key = row && typeof row.scopeKey === 'string' && row.scopeKey !== '' ? row.scopeKey : null
      const slot = openSlot(record, editorMarkup(id, key, text, escape, { purpose: 'answer', label: ROW_ACTIONS.answerLabel(id) }))
      const editor = slot && typeof slot.querySelector === 'function' ? slot.querySelector('[data-row-editor-words]') : null
      if (editor) editor.value = text
      return Boolean(slot)
    }
    if (kind === 'reason') {
      if (!verbs.decide) return false
      const slot = openSlot(record, reasonMarkup(id, escape))
      const input = slot && typeof slot.querySelector === 'function' ? slot.querySelector('[data-row-reason]') : null
      if (input) input.value = text
      return Boolean(slot)
    }
    return false
  }

  if (register && typeof register.addEventListener === 'function') register.addEventListener('click', press)

  function destroy() {
    if (register && typeof register.removeEventListener === 'function') register.removeEventListener('click', press)
  }

  return Object.freeze({ press, reopen, destroy, verbs })
}
