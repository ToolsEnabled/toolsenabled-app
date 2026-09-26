import { ownerPromptSnapshot } from './mission-bridge.js'
import { reconcileUndeliveredDecisions } from './approval-outcomes.js'
import { noteResetClears } from './purchase-cart-changes.js'

const NAMES = Object.freeze({ T: 'tasks', R: 'rules', A: 'asks', P: 'purchases' })
const UNAVAILABLE = 'Reset is unavailable. Return to live Ledger data and review it before trying again.'
const CODE_SHAPED = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/
const RESET_CODES = new Set(['R_LEDGER_RESET_STALE', 'OWNER_PROMPT_RESET_STALE',
  'R_LEDGER_CHAIN_APPEND_UNCONFIRMED', 'R_LEDGER_CHAIN_BROKEN', 'R_LEDGER_CHAIN_UNAVAILABLE'])

/* A REFUSED RESET, SAID AS A SENTENCE (T1431). The dialog used to print the
   transport's own error ("Error invoking remote method 'mc-agent:ledger-reset-
   confirm': Error: R_LEDGER_CHAIN_APPEND_UNCONFIRMED"). The code is read off
   the refusal and turned into what happened and what to do; a reason the app
   wrote itself is kept; nothing code-shaped or transport-shaped reaches the
   person. */
export const RESET_REFUSAL = Object.freeze({
  stale: 'The Ledger changed after this count was taken. Agents may be filing or changing records. Press Check again for the current count, then reset.',
  historyUnconfirmed: 'The reset was not done, because the Ledger history needs your review first. Close this, press Review unconfirmed history, then reset.',
  historyDamaged: 'The reset was not done, because the saved Ledger history is damaged. Everything on file is kept. Restore the history from a backup first.',
  historyCountUnavailable: 'The reset count could not be read because the saved Ledger history is unavailable. Close this, check access to its files, then review the Ledger before trying again.',
  historyUnavailable: 'The reset outcome could not be confirmed because the saved Ledger history could not be read. Close this, check access to its files, then review the Ledger before trying again.',
  failed: 'The reset outcome could not be confirmed. Close this and review the Ledger before trying again.',
  pending: 'The previous purchase reset is unfinished. The latest attempt could not be confirmed. Close this and review the Ledger before trying again.',
  previewFailed: 'The reset count could not be read. Close this and review the Ledger before trying again.',
})
function codeOf(value) {
  // Only the host's exact safe code or Electron's reset-channel wrapper is
  // evidence of a known refusal. A code mentioned in prose proves nothing.
  const code = typeof value?.code === 'string' && value.code
    ? value.code
    : String(value?.message || '').match(/^(?:Error invoking remote method ['"]mc-agent:ledger-reset-(?:preview|confirm)['"]: Error: )?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/)?.[1]
  return RESET_CODES.has(code) ? code : ''
}
function productSentence(value) {
  const said = typeof value?.reason === 'string' ? value.reason : ''
  return said && !CODE_SHAPED.test(said) && !/Error invoking|remote method/i.test(said) ? said : ''
}
export function resetRefusalSentence(value, fallback = RESET_REFUSAL.failed, phase = 'confirm') {
  const code = codeOf(value)
  if (/_RESET_STALE$/.test(code)) return RESET_REFUSAL.stale
  if (code === 'R_LEDGER_CHAIN_APPEND_UNCONFIRMED') return RESET_REFUSAL.historyUnconfirmed
  if (code === 'R_LEDGER_CHAIN_BROKEN') return RESET_REFUSAL.historyDamaged
  if (code === 'R_LEDGER_CHAIN_UNAVAILABLE') return phase === 'preview' ? RESET_REFUSAL.historyCountUnavailable : RESET_REFUSAL.historyUnavailable
  return productSentence(value) || fallback
}

export function mountLedgerResetControls(root, { bridge, onReset = () => {} } = {}) {
  const group = root.querySelector('[data-ledger-resets]')
  const status = root.querySelector('[data-ledger-reset-status]')
  const buttons = [...group.querySelectorAll('[data-reset-kind]')]
  const supported = typeof bridge?.ledgerResetPreview === 'function' && typeof bridge?.ledgerResetConfirm === 'function'
  let enabled = false, busy = false, destroyed = false, dialog = null, cancelDialog = null
  let availabilityVersion = 0, invalidateDialog = null
  function update(options = {}) {
    if (options.enabled !== undefined) {
      const wasEnabled = enabled
      enabled = options.enabled === true
      if (wasEnabled && !enabled) {
        availabilityVersion += 1
        invalidateDialog?.()
      }
    }
    group.hidden = !supported
    for (const button of buttons) button.disabled = !supported || !enabled || busy
  }
  function describe(kind, snapshot, pendingReset) {
    return pendingReset
      ? `Finish the reset you already confirmed for ${snapshot.count} purchase records and ${snapshot.promptCount} purchase prompts. Purchases added afterwards will stay. This does not cancel or refund any charge.`
      :
      `Remove ${snapshot.count === 1 ? `1 ${NAMES[kind].slice(0, -1)}` : `all ${snapshot.count} ${NAMES[kind]}`} from the Ledger, across every scope and status, including removed records. `
      + (kind === 'P' ? `This also clears ${snapshot.promptCount} pending purchase ${snapshot.promptCount === 1 ? 'prompt' : 'prompts'}. It does not cancel or refund any charge. ` : '')
      + 'This cannot be undone.'
  }
  function warning(kind, snapshot, version) {
    return new Promise(resolve => {
      // The view starts in a template document and is adopted when mounted.
      const doc = root.ownerDocument
      let pendingReset = snapshot.pending === true
      dialog = doc.createElement('dialog')
      dialog.className = 'ledger-reset-dialog'
      dialog.setAttribute('aria-labelledby', 'ledger-reset-title')
      dialog.setAttribute('aria-describedby', 'ledger-reset-description')
      dialog.innerHTML = '<h2 id="ledger-reset-title"></h2><p id="ledger-reset-description"></p><p class="ledger-reset-result" role="status"></p><div class="ledger-reset-actions"><button type="button" class="ledger-ctl" data-reset-cancel autofocus>Cancel</button><button type="button" class="ledger-ctl is-danger" data-reset-confirm></button></div>'
      dialog.querySelector('h2').textContent = pendingReset ? 'Finish the previous purchase reset?' : `Reset all ${NAMES[kind]}?`
      dialog.querySelector('#ledger-reset-description').textContent = describe(kind, snapshot, pendingReset)
      const cancel = dialog.querySelector('[data-reset-cancel]')
      const confirm = dialog.querySelector('[data-reset-confirm]')
      const result = dialog.querySelector('[role="status"]')
      confirm.textContent = pendingReset ? 'Finish reset' : `Reset ${NAMES[kind]}`
      let submitting = false, settled = false
      /* After a stale refusal the same confirmation can only fail again, so
         the button re-reads the count in place instead (T1534). */
      let recheck = false, refusal = ''
      const current = () => enabled && version === availabilityVersion
      function finish(value) {
        if (settled) return
        settled = true
        dialog.close(); dialog.remove(); dialog = null; cancelDialog = null; invalidateDialog = null
        resolve({ reply: value, pending: pendingReset, unavailable: !current(), refusal })
      }
      cancelDialog = () => finish(null)
      invalidateDialog = () => {
        confirm.disabled = true
        // A sent request may already have changed durable records. Preserve
        // its actual completion/partial outcome instead of calling it canceled.
        if (!submitting) finish(null)
      }
      cancel.addEventListener('click', () => { if (!submitting) finish(null) })
      dialog.addEventListener('cancel', event => { event.preventDefault(); if (!submitting) finish(null) })
      confirm.addEventListener('click', async () => {
        if (submitting || destroyed || settled) return
        if (!current()) { invalidateDialog(); return }
        submitting = true; cancel.disabled = true; confirm.disabled = true
        if (recheck) {
          /* CHECK AGAIN: a fresh count and challenge, the dialog's words
             updated in place, and the Reset button back. */
          result.textContent = 'Checking the entire category…'
          try {
            const fresh = await bridge.ledgerResetPreview({ kind })
            if (fresh?.ok === false || fresh?.kind !== kind || !Number.isSafeInteger(fresh.count) || fresh.count < 0
                || !Number.isSafeInteger(fresh.revision) || fresh.revision < 0 || !/^[a-f0-9]{64}$/.test(fresh.token)) throw fresh || new Error('preview')
            snapshot = fresh
            dialog.querySelector('#ledger-reset-description').textContent = describe(kind, snapshot, pendingReset)
            recheck = false; refusal = ''
            confirm.textContent = pendingReset ? 'Finish reset' : `Reset ${NAMES[kind]}`
            result.textContent = ''
          } catch (error) {
            if (!destroyed) {
              refusal = resetRefusalSentence(error, RESET_REFUSAL.previewFailed, 'preview')
              result.textContent = refusal
            }
          } finally {
            submitting = false
            if (!destroyed && !settled) { cancel.disabled = false; confirm.disabled = !current() }
          }
          return
        }
        result.textContent = 'Resetting…'
        try {
          const reply = await bridge.ledgerResetConfirm({ kind, revision: snapshot.revision, token: snapshot.token })
          if (reply?.ok !== true) {
            const pending = reply?.pending === true
            if (pending) { pendingReset = true; confirm.textContent = 'Finish reset' }
            if (reply?.aborted === true) pendingReset = false
            if (!pending && /_RESET_STALE$/.test(codeOf(reply))) { recheck = true; confirm.textContent = 'Check again' }
            throw { ...reply, reason: reply?.reason || (pending ? 'The reset is partly saved. Retry to finish this same reset.' : RESET_REFUSAL.failed) }
          }
          if (kind === 'P') {
            // Reconcile against a fresh complete queue, never against the reset
            // subset: unrelated refused decisions must remain visible.
            try {
              const fresh = await ownerPromptSnapshot()
              if (fresh?.ok === true && Array.isArray(fresh.prompts)) {
                const remaining = fresh.prompts.map(prompt => prompt.promptId || prompt.id)
                reconcileUndeliveredDecisions(remaining)
                /* What the reset cleared is said as that, not as "decided or
                   expired", when the queue next redraws (T1532). */
                noteResetClears(remaining)
              }
            } catch { /* An unreadable queue prunes nothing. */ }
          }
          onReset(reply)
          if (!destroyed) finish(reply)
        } catch (error) {
          if (!destroyed) {
            /* A pending reset keeps its own sentence; every other refusal is
               said in words, never as the transport's error text. */
            refusal = pendingReset && !/_RESET_STALE$/.test(codeOf(error))
              ? (productSentence(error) || RESET_REFUSAL.pending)
              : resetRefusalSentence(error)
            result.textContent = refusal
            if (/_RESET_STALE$/.test(codeOf(error))) { recheck = true; confirm.textContent = 'Check again' }
          }
        } finally {
          submitting = false
          if (!destroyed && !settled) { cancel.disabled = false; confirm.disabled = !current() }
        }
      })
      doc.body.append(dialog)
      dialog.showModal()
      cancel.focus()
    })
  }
  async function click(event) {
    const button = event.target.closest('[data-reset-kind]')
    const kind = button?.dataset.resetKind
    if (!NAMES[kind] || !enabled || busy || destroyed) return
    const version = availabilityVersion
    busy = true; update(); status.textContent = 'Checking the entire category…'
    try {
      const snapshot = await bridge.ledgerResetPreview({ kind })
      if (destroyed) return
      if (!enabled || version !== availabilityVersion) { status.textContent = UNAVAILABLE; return }
      if (snapshot?.ok === false) throw snapshot
      if (snapshot?.kind !== kind || !Number.isSafeInteger(snapshot.count) || snapshot.count < 0
          || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !/^[a-f0-9]{64}$/.test(snapshot.token)
          || (kind === 'P' && (!Number.isSafeInteger(snapshot.promptCount) || snapshot.promptCount < 0))) throw { reason: 'The reset count could not be verified. Reload the Ledger and try again.' }
      if (snapshot.count === 0 && (snapshot.promptCount || 0) === 0 && snapshot.pending !== true) { status.textContent = `There are no ${NAMES[kind]} to reset.`; return }
      status.textContent = ''
      const outcome = await warning(kind, snapshot, version)
      if (!destroyed) status.textContent = outcome.reply ? `Reset ${NAMES[kind]} completed.`
        : outcome.pending ? 'The previous reset is still unfinished. Open its reset button to continue.'
          : outcome.refusal || (outcome.unavailable ? UNAVAILABLE : 'Reset canceled.')
    } catch (error) {
      if (!destroyed) status.textContent = !enabled || version !== availabilityVersion ? UNAVAILABLE
        : resetRefusalSentence(error, RESET_REFUSAL.previewFailed, 'preview')
    } finally {
      busy = false
      if (!destroyed) { update(); if (enabled) button.focus() }
    }
  }
  group.addEventListener('click', click)
  update()
  return { update, destroy() { destroyed = true; cancelDialog?.(); group.removeEventListener('click', click) } }
}
