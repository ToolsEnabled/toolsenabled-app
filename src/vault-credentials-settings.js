/* THE SETTINGS CONTROL FOR THE OWNER'S ENCRYPTED CREDENTIAL VAULT.
 *
 * WHAT IS ON THE SCREEN. A list of the records on file BY NAME, a way to ask
 * for a new one, and a way to take one away. Nothing else, and in particular
 * nothing about what any record CONTAINS.
 *
 * THE RULE THIS FILE EXISTS TO KEEP. A name is public; everything else about a
 * record is not. So this module never asks for a value, is never handed one
 * (shell/vault-presence.cjs's `vaultRecordNames` has no value-bearing field to
 * hand it), and never draws:
 *
 *   - a value
 *   - a masked prefix like "ghp_xxxx…" -- the visible part is the part an
 *     attacker does not have to guess
 *   - a character count, a "strength", or any other number derived from a
 *     value. A length turns a password into a much smaller search space, so
 *     "12 characters" is a disclosure wearing the clothes of a reassurance.
 *
 * tools/test/vault-credentials-settings.test.mjs drives this panel over a fake
 * store that CONTAINS values and asserts none of them, and no length of any of
 * them, appears in the rendered text.
 *
 * WHY REMOVAL TAKES TWO PRESSES AND A TRIP TO ANOTHER SCREEN. Active Ledger
 * rule R1225: authority for a task arrives with the task, "except for deletion
 * which requires a prompt". A `window.confirm()` would not be that prompt --
 * it is a dialog this page draws for itself, it records nothing, and it is not
 * where the owner decides things. So "Remove" ASKS: it puts a real confirmation
 * on the product's approvals surface (#/approvals, src/ledger-prompt-queue.js)
 * and says so. The record goes only after that surface answers approve, and the
 * main process -- not this page -- is what checks the answer
 * (shell/vault-credential-page.cjs, completeCredentialRemoval).
 *
 * THE VAULT IS THE ENCRYPTED STORE, NOT localStorage. There is no read or write
 * of window.localStorage anywhere in this file. This row stores no preference:
 * it is a management surface for a store that lives on disk under the owner's
 * own state root, and inventing a `mc.set.*` key here so the row could look
 * like the rows around it would be the lie docs/design's settings rule names.
 */

import { el } from './components.js'
import './vault-credentials-settings.css'

/* THE ROW'S IDENTITY, IN ONE PLACE, for the same reason
   src/this-computer-settings.js keeps THIS_COMPUTER_PROGRAMS_ROW here: the id
   is typed into src/views/settings.js and pointed at from elsewhere, and two
   copies of it drift. */
export const VAULT_CREDENTIALS_ROW = 'vault_credentials'
export const VAULT_CREDENTIALS_SECTION = 'Data & Privacy'
/* Where a person goes to answer the confirmation this page raises. The single
   place that address is written on this path. */
export const APPROVALS_HREF = '#/approvals'

export const VAULT_COPY = Object.freeze({
  heading: 'Credentials stored on this computer',
  intro: 'These are the names of the records in this computer’s encrypted vault. '
    + 'What each one holds is never shown here, and this product never shows it to an assistant either.',
  empty: 'This computer’s vault was read and holds no credentials.',
  unreadable: 'What this vault holds is unknown, so nothing is listed. That is not the same as having none.',
  addHeading: 'Add a credential',
  addIntro: 'Name it, and this computer will open its own entry form and ask you for the value. '
    + 'What you type there goes straight into the encrypted vault; it does not pass through this screen.',
  addLabel: 'Name for the new credential',
  addPlaceholder: 'for example  my_provider_api_key',
  addButton: 'Ask me for it',
  addQueued: 'The entry form is queued. Open your prompts to type the value; nothing is stored until you do.',
  removeButton: 'Remove',
  removeAsked: 'Your approval is needed before anything is removed. Open your approvals screen to decide.',
  removeAlreadyAsked: 'You have already been asked about this one. Your answer is still waiting on the approvals screen.',
  removeApprovedWaiting: 'You approved this. Press to finish removing it.',
  removeApprovalLink: 'Open your approvals screen',
  removeFinishButton: 'I approved it — remove it now',
  removePending: 'You have not answered the approval yet, so nothing was removed.',
  removeRefused: 'You did not approve this, so nothing was removed.',
  removed: 'Removed. It is no longer in this computer’s vault.',
  bridgeAbsent: 'This screen can only manage the vault inside the installed application, so nothing is listed here.',
})

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* The key shape tools/secrets.ps1 accepts. Checked here so a name the vault
   could never have issued is refused with a sentence rather than sent to the
   main process to be refused with a code. */
const NAME_RE = /^[A-Za-z0-9_.-]{1,120}$/

/**
 * Build the vault panel.
 *
 * @param {object} options
 * @param {object} [options.vault] the main-process seam. Defaults to the
 *   preload exposure; a test passes its own.
 */
export function createVaultCredentialsSettings({ vault, displayName = name => name, refreshNames, onChanged } = {}) {
  const bridge = vault || globalThis.window?.mcVault
  const root = el(`<section class="vault-credentials" data-vault-credentials>
    <h3 class="vault-credentials-heading">${esc(VAULT_COPY.heading)}</h3>
    <p class="vault-credentials-body">${esc(VAULT_COPY.intro)}</p>
    <ul class="vault-credentials-list" data-vault-names></ul>
    <p class="vault-credentials-body" data-vault-listing-note role="status"></p>
    <div class="vault-credentials-add">
      <h3 class="vault-credentials-heading">${esc(VAULT_COPY.addHeading)}</h3>
      <p class="vault-credentials-body">${esc(VAULT_COPY.addIntro)}</p>
      <label class="vault-credentials-label" for="vault-credential-name">${esc(VAULT_COPY.addLabel)}</label>
      <input class="vault-credentials-input" id="vault-credential-name" type="text" data-vault-new-name maxlength="120" placeholder="${esc(VAULT_COPY.addPlaceholder)}" />
      <button type="button" class="ctl-btn" data-vault-add>${esc(VAULT_COPY.addButton)}</button>
    </div>
    <p class="vault-credentials-body" data-vault-status role="status"></p>
  </section>`)
  const listNode = root.querySelector('[data-vault-names]')
  const listingNote = root.querySelector('[data-vault-listing-note]')
  const statusNode = root.querySelector('[data-vault-status]')
  const newNameNode = root.querySelector('[data-vault-new-name]')
  const awaiting = new Map()
  const pending = new Set()
  const ADD_OPERATION = 'operation:add'
  const credentialOperation = name => 'credential:' + name
  const approvalCallbacks = []
  let approvalRefreshQueued = false, approvalRead = null, heldFocus = null
  let destroyed = false, generation = 0, statusGeneration = 0
  let lastNames = [], snapshotReady = false

  function say(text) {
    statusNode.textContent = String(text ?? '')
    statusNode.hidden = !text
  }
  function syncDisabled() {
    root.querySelector('[data-vault-add]').disabled = pending.has(ADD_OPERATION)
    for (const button of listNode.querySelectorAll('button')) {
      const name = button.getAttribute('data-vault-remove') || button.getAttribute('data-vault-finish')
      button.disabled = !snapshotReady || pending.has(credentialOperation(name))
    }
  }
  function showAwaitingControls(name, href, approved) {
    const slot = root.querySelector(`[data-vault-item="${name}"] [data-vault-await]`)
    if (!slot) return
    // Only the product's own approval route is used, never a bridge URL.
    slot.innerHTML = `<a class="ctl-btn" href="${APPROVALS_HREF}" data-vault-approvals>${esc(VAULT_COPY.removeApprovalLink)}</a>`
      + (approved ? `<button type="button" class="ctl-btn" data-vault-finish="${esc(name)}">${esc(VAULT_COPY.removeFinishButton)}</button><span class="vault-credentials-body">${esc(VAULT_COPY.removeApprovedWaiting)}</span>` : '')
    slot.hidden = false
    syncDisabled()
  }
  function paintNames(answer) {
    const focused = root.ownerDocument?.activeElement
    const focusedName = focused?.getAttribute?.('data-vault-remove') || focused?.getAttribute?.('data-vault-finish')
    const focusedAction = focused?.hasAttribute?.('data-vault-finish') ? 'data-vault-finish' : 'data-vault-remove'
    if (focusedName) heldFocus = { name: focusedName, action: focusedAction }
    else if (focused && focused !== root.ownerDocument?.body) heldFocus = null
    listNode.innerHTML = ''
    if (answer?.ok !== true) {
      listingNote.textContent = answer?.reason || VAULT_COPY.unreadable
      listingNote.hidden = false
      return
    }
    lastNames = Array.isArray(answer.names) ? answer.names.filter(name => typeof name === 'string' && NAME_RE.test(name)) : []
    listingNote.textContent = lastNames.length ? '' : VAULT_COPY.empty
    listingNote.hidden = lastNames.length > 0
    for (const name of lastNames) {
      const item = el(`<li class="vault-credentials-item" data-vault-item="${esc(name)}">
        <span class="vault-credentials-name" data-vault-name>${esc(snapshotReady ? displayName(name) : 'Credential')}</span>
        <button type="button" class="ctl-btn" data-vault-remove="${esc(name)}">${esc(VAULT_COPY.removeButton)}</button>
        <span class="vault-credentials-await" data-vault-await hidden></span></li>`)
      listNode.appendChild(item)
      const held = awaiting.get(name)
      if (snapshotReady && held) showAwaitingControls(name, APPROVALS_HREF, held.decision === 'approved')
    }
    syncDisabled()
    const active = root.ownerDocument?.activeElement
    if (heldFocus && (!active || active === root.ownerDocument?.body || listNode.contains(active))) {
      const target = root.querySelector(`[${heldFocus.action}="${heldFocus.name}"]`)
      if (target && !target.disabled) target.focus()
    }
  }
  function invalidate() {
    generation++
    snapshotReady = false
    awaiting.clear()
    paintNames({ ok: true, names: lastNames })
    /* INVALIDATION IS NOT A READ. With no names to redact, paintNames has just
       written "was read and holds no credentials" -- before any read, and it
       stayed there when the owning page's read then failed (src/views/vault.js
       returns without a snapshot), beside that page's own "could not be read".
       Say nothing about the listing until a snapshot answers; redacted names,
       when there are any, are still drawn above. */
    if (!lastNames.length) { listingNote.textContent = ''; listingNote.hidden = true }
  }
  function deliverApprovalDecisions(decisions) {
    for (const callback of approvalCallbacks.splice(0)) callback(decisions)
  }
  async function restorePendingRemovals() {
    approvalRefreshQueued = true
    if (destroyed || !snapshotReady || pending.size) return null
    if (typeof bridge?.pendingRemovals !== 'function') {
      approvalRefreshQueued = false
      deliverApprovalDecisions(null)
      return null
    }
    if (approvalRead) return approvalRead
    // One read at a time. An operation invalidates an in-flight read, queues
    // reconciliation, and the final operation's completion drains that queue.
    approvalRead = Promise.resolve().then(async () => {
      let decisions = null
      while (!destroyed && snapshotReady && !pending.size && approvalRefreshQueued) {
        approvalRefreshQueued = false
        const version = generation
        let answer
        try { answer = await bridge.pendingRemovals() } catch { answer = null }
        if (destroyed) return null
        if (version !== generation || pending.size || !snapshotReady) {
          approvalRefreshQueued = true
          continue
        }
        decisions = answer?.ok === true && Array.isArray(answer.pending) ? answer.pending : null
        awaiting.clear()
        for (const entry of decisions || []) {
          if (!NAME_RE.test(String(entry?.name ?? '')) || typeof entry.promptId !== 'string' || !entry.promptId) continue
          if (entry.decision === 'approved' || entry.decision === 'waiting') {
            awaiting.set(entry.name, { promptId: entry.promptId, decision: entry.decision })
          }
        }
        paintNames({ ok: true, names: lastNames })
        deliverApprovalDecisions(decisions)
      }
      return decisions
    }).finally(() => {
      approvalRead = null
      // An operation can settle after the read loop exits but before this
      // finalizer runs. Release the slot before restarting that queued read.
      if (approvalRefreshQueued && snapshotReady && !pending.size && !destroyed) {
        void restorePendingRemovals()
      }
    })
    return approvalRead
  }
  async function setSnapshot(answer) {
    generation++
    snapshotReady = answer?.ok === true
    awaiting.clear()
    paintNames(answer)
    await restorePendingRemovals()
  }
  async function refresh() {
    if (destroyed) return
    if (refreshNames) { try { await refreshNames() } catch { invalidate(); say(VAULT_COPY.unreadable) }; return }
    const version = ++generation
    let answer
    try { answer = typeof bridge?.names === 'function' ? await bridge.names() : { ok: false, reason: VAULT_COPY.bridgeAbsent } }
    catch { answer = { ok: false, reason: VAULT_COPY.unreadable } }
    if (destroyed || version !== generation) return
    await setSnapshot(answer)
  }
  async function operation(key, action, failure) {
    if (destroyed || pending.has(key)) return
    pending.add(key)
    generation++ // Older list/approval reads cannot repaint this write.
    approvalRefreshQueued = true
    const status = ++statusGeneration
    syncDisabled()
    const report = text => { if (!destroyed && status === statusGeneration) say(text) }
    try { await action(report) } catch { report(failure) }
    finally {
      pending.delete(key)
      generation++ // A read begun during this write is also stale.
      approvalRefreshQueued = true
      if (!destroyed) {
        syncDisabled()
        if (!pending.size) await restorePendingRemovals()
      }
    }
  }
  async function add() {
    const typed = String(newNameNode.value ?? '').trim()
    if (!NAME_RE.test(typed)) { say('A credential name uses letters, numbers, dots, dashes or underscores. Nothing was asked for.'); return }
    if (typeof bridge?.add !== 'function') { say(VAULT_COPY.bridgeAbsent); return }
    await operation(ADD_OPERATION, async report => {
      const answer = await bridge.add({ credential: 'custom', customName: typed })
      if (destroyed) return
      if (answer?.ok === true) {
        if (newNameNode.value.trim() === typed) newNameNode.value = ''
        report(VAULT_COPY.addQueued)
      } else report(answer?.reason || 'This computer could not open its entry form, so nothing was asked for.')
    }, 'This computer could not open its entry form, so nothing was asked for.')
  }
  async function askToRemove(name) {
    if (!NAME_RE.test(String(name)) || !snapshotReady) return
    if (typeof bridge?.requestRemoval !== 'function') { say(VAULT_COPY.bridgeAbsent); return }
    await operation(credentialOperation(name), async report => {
      const answer = await bridge.requestRemoval({ name })
      if (destroyed) return
      if (answer?.ok !== true || typeof answer.promptId !== 'string' || !answer.promptId) {
        report(answer?.reason || 'This computer could not ask for approval, so nothing was removed.'); return
      }
      awaiting.set(name, { promptId: answer.promptId, decision: 'waiting' })
      showAwaitingControls(name, APPROVALS_HREF, false)
      if (answer.reused) {
        // requestRemoval does not carry the stored decision. Read that decision
        // from the existing pending-removals API before drawing a finish button.
        approvalCallbacks.push(decisions => {
          const decision = decisions?.find(entry => entry.name === name && entry.promptId === answer.promptId)?.decision
          report(decision === 'approved' ? VAULT_COPY.removeApprovedWaiting
            : decision === 'waiting' ? VAULT_COPY.removeAlreadyAsked
              : decision === 'refused' ? VAULT_COPY.removeRefused : 'The approval decision could not be read. Refresh before removing this credential.')
        })
        return
      }
      report(VAULT_COPY.removeAsked)
    }, 'This computer could not ask for approval, so nothing was removed.')
  }
  async function finishRemoval(name) {
    const held = awaiting.get(name)
    if (!held || held.decision !== 'approved') { say(VAULT_COPY.removePending); return }
    if (typeof bridge?.completeRemoval !== 'function') { say(VAULT_COPY.bridgeAbsent); return }
    await operation(credentialOperation(name), async report => {
      const answer = await bridge.completeRemoval({ name, promptId: held.promptId })
      if (destroyed) return
      if (answer?.ok === true && answer.removed === true) {
        awaiting.delete(name)
        lastNames = lastNames.filter(item => item !== name)
        paintNames({ ok: true, names: lastNames })
        report(VAULT_COPY.removed)
        try {
          if (onChanged) await onChanged()
          else await refresh()
        } catch {
          listingNote.textContent = VAULT_COPY.unreadable
          listingNote.hidden = false
        }
        return
      }
      if (answer?.code === 'OWNER_APPROVAL_PENDING') {
        awaiting.set(name, { promptId: held.promptId, decision: 'waiting' })
        paintNames({ ok: true, names: lastNames }); report(VAULT_COPY.removePending); return
      }
      if (answer?.code === 'OWNER_APPROVAL_NOT_GIVEN') {
        awaiting.delete(name); paintNames({ ok: true, names: lastNames }); report(VAULT_COPY.removeRefused); return
      }
      report(answer?.reason || 'Nothing was removed.')
    }, 'This computer could not finish the removal. Refresh to check its state.')
  }
  function onClick(event) {
    const target = event?.target?.closest?.('button') || event?.target
    if (!target || target.disabled || typeof target.getAttribute !== 'function') return
    if (target.hasAttribute?.('data-vault-add')) { void add(); return }
    const name = target.getAttribute('data-vault-remove') || target.getAttribute('data-vault-finish')
    if (!name) return
    if (target.hasAttribute?.('data-vault-finish')) void finishRemoval(name)
    else void askToRemove(name)
  }
  root.addEventListener('click', onClick)
  return {
    element: root, refresh, setSnapshot, invalidate, add, askToRemove, finishRemoval,
    awaitingRemoval(name) {
      if (name !== undefined) { const held = awaiting.get(name); return held ? { name, promptId: held.promptId } : null }
      if (awaiting.size > 1) throw new Error(`awaitingRemoval() needs a name: ${awaiting.size} removals are awaiting approval`)
      const [only] = [...awaiting.entries()]
      return only ? { name: only[0], promptId: only[1].promptId } : null
    },
    destroy() { destroyed = true; generation++; statusGeneration++; root.removeEventListener?.('click', onClick) },
  }
}
