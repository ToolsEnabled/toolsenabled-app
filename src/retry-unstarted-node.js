export function canRetryUnstartedNode(node, { hasSavedConversation = false, cleanupPending = false, busy = false } = {}) {
  return Boolean(node?.id && node.status === 'failed' && !node.sessionId
    && !hasSavedConversation && !cleanupPending && !busy)
}

// A failed first start has no conversation to Resume or clear. Keep its saved
// task and position, refresh authority, and enter the ordinary draft launcher.
export async function executeRetryUnstartedNode({ nodeId, treeStore, canStart = () => false,
  isEligible = canRetryUnstartedNode, refreshAuthority = async () => false, startDraftNode } = {}) {
  const refused = message => ({ ok: false, notStarted: true, message })
  const current = () => treeStore?.getNode(nodeId)
  if (!isEligible(current()) || canStart() !== true || typeof startDraftNode !== 'function') {
    return refused('This agent cannot retry a first start right now.')
  }
  let refreshed = false
  try { refreshed = await refreshAuthority() } catch { /* leave the failed node intact */ }
  if (refreshed !== true || canStart() !== true || !isEligible(current())) {
    return refused('The current agent or its role could not be confirmed. Its saved task is unchanged.')
  }
  const node = current()
  const prepared = treeStore.setNodeStatus(nodeId, 'draft', { note: '' })
  if (prepared?.ok !== true || prepared.snapshot?.persistenceFailed) {
    if (prepared?.ok === true) treeStore.setNodeStatus(nodeId, 'failed', { note: node.statusNote || '' })
    return refused('The retry could not be saved, so no agent was started.')
  }
  return startDraftNode(current())
}
