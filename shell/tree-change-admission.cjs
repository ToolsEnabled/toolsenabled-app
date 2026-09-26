'use strict'

const UNAVAILABLE_CODE = 'TASK_TOPOLOGY_ADMISSION_UNAVAILABLE'
const UNAVAILABLE_REASON = 'The saved-tree removal authority is not ready or the fleet is unreadable. No tree change was saved.'

function unavailable(error) {
  return {
    ok: false,
    code: error?.code || UNAVAILABLE_CODE,
    reason: error?.message || UNAVAILABLE_REASON,
  }
}

/*
 * The renderer-prefs callback is deliberately kept as a small host-side
 * function. The same callback is exercised by the real durable prefs path in
 * the focused lifecycle test; it must not be duplicated in a test or in a
 * renderer. Slot admission remains first, and an already-created topology
 * admission remains in force for every tree write. Only a single-node
 * removal receives the private reservation options needed by that operation.
 */
function createTreeChangeValidator({
  treeSlotAdmission = null,
  readTreeSlotAdmission = () => treeSlotAdmission,
  readTaskTopologyAdmission = () => null,
  getTaskTopologyAdmission = () => null,
  treeChangeRemovesNode,
  treeChangeRemovedNodeId,
} = {}) {
  if (typeof treeChangeRemovesNode !== 'function' || typeof treeChangeRemovedNodeId !== 'function') {
    throw new TypeError('createTreeChangeValidator requires tree-change classifiers')
  }

  return function validateTreeChange(request = {}) {
    let slotAdmission
    try { slotAdmission = readTreeSlotAdmission() } catch (error) { return unavailable(error) }
    const slots = slotAdmission
      ? slotAdmission.validateWrite(request)
      : { ok: false, code: 'TREE_SLOT_ADMISSION_UNAVAILABLE', reason: 'The saved tree admission reader is not ready. No slots were changed.' }
    if (slots?.ok !== true) return slots

    const removal = treeChangeRemovesNode(request)
    let admission
    try { admission = readTaskTopologyAdmission() } catch (error) { return unavailable(error) }
    if (admission) {
      if (removal === null) return unavailable()
      try {
        const sourceNodeId = removal === true ? treeChangeRemovedNodeId(request) : null
        const topologyRequest = removal === true && sourceNodeId && !Object.hasOwn(request, 'taskLedgerOptions')
          ? { ...request, taskLedgerOptions: admission.taskLedgerOptionsForWrite({ computerId: request.computerId, sourceNodeId }) }
          : request
        return admission.validateWrite(topologyRequest)
      } catch (error) {
        return unavailable(error)
      }
    }

    /* Ordinary, non-removal settings may continue before the private handoff
       authority is initialized. A removal cannot take that path: initialize
       the trusted authority and fail closed if it is unavailable. */
    if (removal === false) return { ok: true }
    if (removal === null) return unavailable()
    try {
      admission = getTaskTopologyAdmission()
      if (!admission) return unavailable()
      const sourceNodeId = treeChangeRemovedNodeId(request)
      const topologyRequest = sourceNodeId && !Object.hasOwn(request, 'taskLedgerOptions')
        ? { ...request, taskLedgerOptions: admission.taskLedgerOptionsForWrite({ computerId: request.computerId, sourceNodeId }) }
        : request
      return admission.validateWrite(topologyRequest)
    } catch (error) {
      return unavailable(error)
    }
  }
}

module.exports = { createTreeChangeValidator }
