'use strict'

const crypto = require('node:crypto')

const PENDING_KEY = 'mc.node-privacy.pending.v1'
/* EARLIER OPERATIONS THIS APP COULD NOT FINISH, KEPT ON RECORD (c5).
   The task Ledger binds an owner-gone operation to the app session that
   prepared it, so a later process can neither continue nor finalize it, and
   while it is unfinished the engine holds all task filing. The next close
   with the setting on deletes under a NEW operation and replaces the pending
   marker, which was the only record of the earlier one: the Settings note then
   went away and nothing said filing was still held. prepare() writes the
   earlier operation here first; heldCleanup() and recover() keep reporting it.
   Only an engine takeover path can finish it; nothing here removes it. */
const HELD_KEY = 'mc.node-privacy.held.v1'
const MAX_HELD = 16
const MODE = 'privacy-exit'
const REASON = 'privacy cleanup on exit'

function sourceNodeIdsDigest(sourceNodeIds) {
  return crypto.createHash('sha256').update(JSON.stringify([...(Array.isArray(sourceNodeIds) ? sourceNodeIds : [])].sort())).digest('hex')
}

function markerOf(value, makeOperationId) {
  if (value === '1') return { operationId: makeOperationId(), mode: MODE, reason: REASON }
  try {
    const marker = JSON.parse(value)
    if (marker && typeof marker === 'object' && typeof marker.operationId === 'string'
        && marker.mode === MODE && marker.reason === REASON) return marker
  } catch {}
  throw new Error('Node privacy cleanup has an invalid pending operation marker.')
}

/* A kept list is data from disk: anything that is not a list of named operations is no list.
   Each entry says it is kept, so the note beside the setting can tell it from the last close. */
function heldListOf(value) {
  if (typeof value !== 'string' || !value) return []
  let list
  try { list = JSON.parse(value) } catch { return [] }
  return Array.isArray(list)
    ? list.filter(entry => entry && typeof entry.operationId === 'string' && entry.operationId && entry.operationId.length <= 200)
      .map(entry => Object.freeze({ operationId: entry.operationId,
        code: typeof entry.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(entry.code) ? entry.code : 'MC_NODE_PRIVACY_CLEANUP_HELD',
        kept: true }))
    : []
}

function createNodePrivacyCleanup({ prefs, org, transcripts, recoveryHandoffs = null, ownerGone: ownerGoneAction = null, finalizeOwnerGone = null, makeOperationId = () => `privacy-${crypto.randomUUID()}` }) {
  const checked = answer => {
    if (!answer?.ok) throw new Error('Node privacy cleanup could not finish: ' + (answer?.error?.message || answer?.message || 'storage is unavailable'))
    return answer
  }
  /* The owner-gone producer answers with the task Ledger's own receipt
     (durable + phase + operation id), not a store envelope: it has no `ok`.
     Requiring `ok` threw after every successful Ledger commit, before any
     delete ran, and stranded the committed operation (B22). */
  const ledgerChecked = (receipt, marker, phases) => {
    if (receipt?.durable !== true || receipt.operationId !== marker.operationId || !phases.includes(receipt.phase)) {
      throw new Error('Node privacy cleanup could not finish: ' + (receipt?.error?.message || receipt?.message || 'the task Ledger did not confirm the owner-gone phase'))
    }
    return receipt
  }
  /* Recovery handoffs hold conversation, so they go with the transcripts:
     only after the org reset succeeded. Older isolated callers inject no
     recovery store and keep the store-only behavior. */
  const clearRecoveryHandoffs = async () => {
    if (typeof recoveryHandoffs?.clearForPrivacy !== 'function') return
    await recoveryHandoffs.clearForPrivacy()
  }
  let committed = null
  /* The operation recover() found it may not continue in this process (B22).
     Kept so complete() does not retry it at every quit and so the host can
     tell the person their delete-on-exit has not finished. */
  let held = null
  const pendingMarker = () => {
    const value = checked(prefs.snapshot()).values[PENDING_KEY]
    return typeof value === 'string' && value.length ? markerOf(value, makeOperationId) : null
  }
  const keptHeld = () => {
    try { return heldListOf(prefs.snapshot()?.values?.[HELD_KEY]) } catch { return [] }
  }
  /* The pending marker prepare() is about to replace names the operation
     recover() found at launch and could not continue (it runs before any
     quit, and a marker it finished is gone). That operation stays unfinished
     in the Ledger after this quit finishes its own, so it is kept on record. */
  const keepHeldOperation = () => {
    if (!held || committed?.operationId === held.operationId) return
    const list = keptHeld()
    if (list.some(entry => entry.operationId === held.operationId)) return
    checked(prefs.set(HELD_KEY, JSON.stringify([...list, { operationId: held.operationId, code: held.code }].slice(-MAX_HELD))))
  }
  const runOwnerGone = marker => {
    /* Older isolated callers deliberately exercise only the privacy-store
       cleanup. The native owner-gone producer is additive at the host seam;
       when it is not injected, preserve that legacy store-only behavior and
       do not claim a Ledger phase. The real host always supplies it. */
    if (typeof ownerGoneAction !== 'function') return null
    return ledgerChecked(ownerGoneAction(marker), marker, ['committed', 'finalized'])
  }
  const finalize = marker => {
    if (typeof finalizeOwnerGone !== 'function' || !committed) return committed
    const readback = typeof prefs.confirmNodePrivacyCleanup === 'function'
      ? checked(prefs.confirmNodePrivacyCleanup())
      : null
    if (!readback || readback.durable !== true || readback.sourceBytesAbsent !== true) {
      throw new Error('Node privacy cleanup bytes could not be durably read back. The owner-gone barrier remains active.')
    }
    return ledgerChecked(finalizeOwnerGone({
      ...marker,
      cleanupReceipt: {
        durable: true,
        operationId: committed.operationId,
        mode: marker.mode,
        sourceBytesAbsent: readback.sourceBytesAbsent,
        sourceNodeIdsDigest: sourceNodeIdsDigest(committed.sourceNodeIds),
        taskSetDigest: committed.taskSetDigest,
        taskCount: committed.taskCount,
      },
    }), marker, ['finalized'])
  }
  return {
    prepare() {
      // Before the marker is replaced: a refused write stops here, with nothing destroyed.
      keepHeldOperation()
      const marker = { operationId: makeOperationId(), mode: MODE, reason: REASON }
      checked(prefs.set(PENDING_KEY, JSON.stringify(marker)))
      committed = runOwnerGone(marker)
      checked(prefs.prepareNodePrivacyCleanup())
      checked(org.resetOrg())
      return committed
    },
    complete() {
      const marker = pendingMarker()
      if (!marker) return
      // With the setting off, prepare() did not replace a held operation.
      // Retrying it here only failed again at every quit; it stays held.
      if (!committed && held?.operationId === marker.operationId) return
      if (!committed) committed = runOwnerGone(marker)
      finalize(marker)
      checked(prefs.remove(PENDING_KEY))
      committed = null
      held = null
    },
    async recover() {
      const marker = pendingMarker()
      if (!marker) {
        // Nothing to resume, but an earlier operation is still unfinished: say so at every launch.
        const [kept] = keptHeld()
        return kept ? { ok: false, held: true, kept: true, operationId: kept.operationId, code: kept.code,
          reason: 'An earlier delete-on-exit operation is still unfinished in the task Ledger.' } : undefined
      }
      // The marker is persisted with the node removal, before either of the
      // other stores changes. A failed quit resumes cleanup before new nodes
      // or seats may be created, without discarding the owner's other settings.
      try {
        committed = runOwnerGone(marker)
      } catch (error) {
        // The task Ledger binds an owner-gone operation to the app session
        // that prepared it, so a later process cannot continue it (B22).
        // Fail closed without refusing startup: nothing is deleted, the marker
        // and the Ledger barrier stay, and the caller reports the hold.
        committed = null
        const code = error?.code || 'MC_NODE_PRIVACY_CLEANUP_HELD'
        held = Object.freeze({ operationId: marker.operationId, code })
        return { ok: false, held: true, operationId: marker.operationId, code,
          reason: error?.message || 'The privacy cleanup could not be resumed.' }
      }
      checked(prefs.prepareNodePrivacyCleanup())
      checked(org.resetOrg())
      await transcripts.clearForPrivacy()
      await clearRecoveryHandoffs()
      finalize(marker)
      checked(prefs.remove(PENDING_KEY))
      committed = null
      held = null
      return { ok: true }
    },
    /* The held operation: the one recover() could not continue, else the
       first earlier one kept on record; null when there is none. */
    heldCleanup: () => held || keptHeld()[0] || null,
    // The quit runs this after prepare() (the transcript store clears its own).
    clearRecoveryHandoffs,
  }
}
module.exports = { createNodePrivacyCleanup, PENDING_KEY, HELD_KEY }
