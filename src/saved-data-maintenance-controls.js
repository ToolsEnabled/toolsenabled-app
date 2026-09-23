import { refreshSavedTreeMaintenance } from './saved-tree-maintenance-refresh.js'

const actions = Object.freeze({
  repair: ['nodeStatusRepairPreview', 'nodeStatusRepairConfirm'],
  rollback: ['nodeStatusRollbackPreview', 'nodeStatusRollbackConfirm'],
  prune: ['continuationPrunePreview', 'continuationPruneConfirm'],
})
const reason = (reply, fallback) => reply?.reason || reply?.error?.message || fallback

/* blockedReason() names the condition that makes mayRun() false and what to do
   about it (T1568: the three Review buttons went grey with no reason while an
   unrelated change was unsaved or the example fleet was showing). */
export function createSavedDataMaintenanceSettings({ bridge = globalThis.window?.mcAgent,
  durable = globalThis.window?.mcDurableStorage, mayRun = () => true, blockedReason = () => '', isBlocked = () => false, onBusy = () => {} } = {}) {
  let root = null, destroyed = false, busy = false, generation = 0
  let message = 'Review saved-status repair or orphaned continuation cleanup. Every change requires your native confirmation and a verified dated copy.'
  const supported = action => actions[action].every(name => typeof bridge?.[name] === 'function')
  const usable = () => !destroyed && mayRun() === true
  const current = version => usable() && version === generation
  const stopped = version => {
    if (current(version)) return false
    if (!destroyed) say('The Settings context changed during review. No further maintenance was submitted; review again from the current settings.')
    return true
  }
  function afterRender() {
    if (!root) return
    const held = !busy && !isBlocked() && !destroyed && mayRun() !== true ? String(blockedReason() || '') : ''
    for (const button of root.querySelectorAll('[data-saved-maintenance-action]')) {
      button.disabled = busy || isBlocked() || !usable() || !supported(button.dataset.savedMaintenanceAction)
      if (held && button.disabled) button.setAttribute?.('title', held)
      else button.removeAttribute?.('title')
    }
    const status = root.querySelector('[data-saved-maintenance-status]')
    if (status) status.textContent = !Object.keys(actions).some(supported) ? 'Saved conversation maintenance is unavailable in this window. Open the ToolsEnabled desktop app to review it.' : held || message
  }
  function say(text) { message = text; if (!destroyed) afterRender() }
  async function refreshConfirmed(reply) {
    if (!Array.isArray(reply.changedKeys)) throw new Error('The repair was saved, but its changed-tree list was unavailable. Existing open work was preserved.')
    const updated = await durable?.refreshFleet?.(reply.changedKeys)
    if (updated?.ok !== true) throw new Error(reason(updated, 'The repair was saved, but this window could not refresh its saved trees.'))
    const result = refreshSavedTreeMaintenance(updated.changes)
    if (!result.ok) throw new Error(result.reason)
  }
  async function run(action) {
    if (!actions[action] || busy || isBlocked() || !usable() || !supported(action)) return
    const version = ++generation
    busy = true; onBusy(true); say('Reading the saved data for your review…')
    try {
      const [previewName, confirmName] = actions[action]
      let prepared = await bridge[previewName]({})
      if (stopped(version)) return
      if (prepared?.ok !== true) throw new Error(reason(prepared, 'Saved-data review was refused.'))
      if (action === 'prune') {
        if (!Number.isSafeInteger(prepared.eligible) || prepared.eligible < 0) throw new Error('The orphan count could not be verified.')
        if (prepared.eligible === 0) { say('There are no orphaned continuation rows to remove.'); return }
        prepared = await bridge[confirmName]({ stage: 'prepare', scopeHash: prepared.scopeHash, limit: prepared.limit })
        if (stopped(version)) return
        if (prepared?.ok !== true) throw new Error(reason(prepared, 'The dated continuation backup could not be prepared.'))
        if (!prepared.token) { say('No continuation rows were selected. Nothing was removed.'); return }
      } else if (!prepared.previewToken) {
        say(reason(prepared, 'No matching status changes were selected. Nothing was changed.')); return
      }
      say('Review the native confirmation. Cancel leaves the saved data unchanged.')
      const reply = await bridge[confirmName](action === 'prune'
        ? { stage: 'confirm', token: prepared.token } : { previewToken: prepared.previewToken })
      // A committed native change still needs cache adoption if this page was
      // closed while its confirmation was open; painting remains generation-bound.
      if (reply?.ok === true && action !== 'prune') {
        if (reply.confirmed !== true) throw new Error('The status repair did not confirm its saved result. Existing open work was preserved.')
        await refreshConfirmed(reply)
      }
      if (stopped(version)) return
      if (reply?.ok !== true) { say(reason(reply, 'The operation was not confirmed. Existing saved data was kept.')); return }
      if (action === 'prune' && (!Number.isSafeInteger(reply.removed) || reply.removed < 0)) throw new Error('The cleanup returned no verified removal count. Review the saved data before retrying.')
      const auditNote = reply.audit?.required === true && reply.audit.recorded === false
        ? ' The change completed, but its audit outcome could not be recorded.' : ''
      say((action === 'prune' ? `Removed ${reply.removed} orphaned continuation rows. The dated backup is retained.`
        : action === 'repair' ? 'Matching saved statuses were restored. Open trees now use the repaired data.'
          : 'The selected saved-status repair was rolled back. Open trees now use the restored data.') + auditNote)
    } catch (error) {
      if (!destroyed && version === generation) say(error?.message || 'Saved-data maintenance could not finish. Existing data was kept.')
    } finally {
      busy = false; onBusy(false); if (!destroyed) afterRender()
    }
  }
  function click(event) {
    const button = event.target?.closest?.('[data-saved-maintenance-action]')
    if (button && root?.contains(button)) void run(button.dataset.savedMaintenanceAction)
  }
  return {
    markup: () => `<section class="settings-section" data-settings-section="Data & Privacy" data-saved-maintenance>
      <h2 class="settings-section-title">Saved conversation maintenance</h2>
      <p class="settings-desc">Restore matching finished statuses from a saved snapshot, undo a status repair, or review continuation rows whose agents no longer exist.</p>
      <button type="button" class="ctl-btn" data-saved-maintenance-action="repair">Review status repair</button>
      <button type="button" class="ctl-btn" data-saved-maintenance-action="rollback">Review status rollback</button>
      <button type="button" class="ctl-btn" data-saved-maintenance-action="prune">Review orphaned continuations</button>
      <p role="status" aria-live="polite" data-saved-maintenance-status></p>
    </section>`,
    matches: query => /repair|rollback|orphan|continuation|maintenance|saved status/i.test(query),
    bind(value) { root = value; root.addEventListener('click', click); afterRender() },
    afterRender,
    invalidate() { generation++; afterRender() },
    destroy() { destroyed = true; generation++; root?.removeEventListener('click', click); root = null },
  }
}
