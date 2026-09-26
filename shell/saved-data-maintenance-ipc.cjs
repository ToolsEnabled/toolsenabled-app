'use strict'

const ROUTES = Object.freeze({
  'mc-agent:continuation-prune-preview': 'continuationPrunePreview',
  'mc-agent:continuation-prune-confirm': 'continuationPruneConfirm',
  'mc-agent:node-status-repair-preview': 'nodeStatusRepairPreview',
  'mc-agent:node-status-repair-confirm': 'nodeStatusRepairConfirm',
  'mc-agent:node-status-rollback-preview': 'nodeStatusRollbackPreview',
  'mc-agent:node-status-rollback-confirm': 'nodeStatusRollbackConfirm',
})
function registerSavedDataMaintenanceIpc({ ipcMain, getAdapter, assertTrustedSender, principalFor,
  capturePolicy = () => ({ ok: false }), recordAudit = null }) {
  const auditRefusal = () => ({ ok: false, code: 'MC_SAVED_DATA_AUDIT_UNAVAILABLE',
    reason: 'The chosen audit policy could not record this maintenance request. Nothing was submitted.' })
  const permitted = principal => principal?.kind === 'window' && principal.mayWrite === true
    && principal.owner && principal.owner.isDestroyed?.() === false
  const recorded = receipt => receipt?.ok === true && Number.isSafeInteger(receipt.sequence) && receipt.sequence >= 1
    && typeof receipt.eventHash === 'string' && /^[a-f0-9]{64}$/i.test(receipt.eventHash)
    && receipt.disposition !== 'not-required' && receipt.recorded !== false
  const metadata = result => ({ surface: 'app.ipc', ok: result?.ok === true,
    ...(typeof result?.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(result.code) ? { code: result.code } : {}),
    ...(Array.isArray(result?.changedKeys) ? { changedTrees: result.changedKeys.length } : {}) })
  for (const [channel, method] of Object.entries(ROUTES)) {
    ipcMain.handle(channel, async (event, request) => {
      assertTrustedSender(event)
      const principal = principalFor(event)
      if (!permitted(principal)) return { ok: false, code: 'MC_SAVED_DATA_PERSON_REQUIRED',
          reason: 'Saved-data maintenance requires the person using this app window.' }
      let adapter
      try { adapter = getAdapter() } catch { return { ok: false, code: 'MC_SAVED_DATA_UNAVAILABLE',
        reason: 'Saved-data maintenance could not load. Existing saved data was kept.' } }
      if (typeof adapter?.[method] !== 'function') return { ok: false, code: 'MC_SAVED_DATA_UNAVAILABLE',
        reason: 'Saved-data maintenance is unavailable in this copy.' }
      let policy
      try { policy = capturePolicy() } catch { return auditRefusal() }
      const absent = policy?.ok === false && policy.code === 'AUDIT_PAYLOAD_ABSENT'
      if (policy?.ok !== true && !absent) return auditRefusal()
      const required = !absent && policy.decision?.required !== false
      const action = 'saved-data.' + channel.slice('mc-agent:'.length)
      if (required) {
        let intent
        try { intent = await recordAudit?.(action + '.intent', 'saved-data:maintenance', { surface: 'app.ipc' }, policy.decision) } catch {}
        if (!recorded(intent)) return auditRefusal()
      }
      // An audit append can wait. It cannot preserve a revoked window's authority.
      try { assertTrustedSender(event) } catch { return { ok: false, code: 'MC_SAVED_DATA_PERSON_REQUIRED',
        reason: 'This window no longer permits saved-data maintenance.' } }
      const current = principalFor(event)
      if (!permitted(current) || current.owner !== principal.owner) return { ok: false, code: 'MC_SAVED_DATA_PERSON_REQUIRED',
        reason: 'This window changed before maintenance could begin.' }
      let result
      try { result = await adapter[method](request || {}, current) }
      catch { result = { ok: false, code: 'MC_SAVED_DATA_UNAVAILABLE',
        reason: 'Saved-data maintenance could not finish. Review the saved data before retrying.' } }
      if (!required) return { ...result, audit: absent
        ? { available: false, code: 'AUDIT_PAYLOAD_ABSENT' }
        : { required: false, disposition: 'not-required' } }
      let outcome
      try { outcome = await recordAudit(action, 'saved-data:maintenance', metadata(result), policy.decision) } catch {}
      return { ...result, audit: recorded(outcome) ? { required: true, recorded: true }
        : { required: true, recorded: false, code: 'MC_SAVED_DATA_AUDIT_OUTCOME_UNAVAILABLE' } }
    })
  }
}
module.exports = { registerSavedDataMaintenanceIpc, ROUTES }
