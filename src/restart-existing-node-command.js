import { composeNodeBrief, nodeManagerContext } from './tree-node-brief.js'

const nothing = () => {}

/* The agent.restart-only half of a clean replacement.
 *
 * executeFreshStartExistingNode deliberately starts and binds an empty session:
 * the person's "Start this conversation over" action depends on that property.
 * An assistant-driven restart has a different, already-published contract: the
 * circle keeps its saved brief. This function runs while the clean-replacement
 * single-flight is still held, after the new session is bound and before any
 * competing replacement can begin.
 */
export async function executeRestartExistingNodeCommand({
  node,
  restarted,
  bridge,
  sessionNodeIds,
  briefContext,
  appendTranscript,
  treeStore = null,
  refreshTree = nothing,
  failedNote = '',
  now = Date.now,
  refusalCodeFromError = () => null,
  refusalCodeFromResult = () => null,
  acknowledgeRoot = false,
} = {}) {
  const sessionId = typeof restarted?.sessionId === 'string' && restarted.sessionId
    ? restarted.sessionId
    : null
  const threadId = typeof restarted?.threadId === 'string' && restarted.threadId
    ? restarted.threadId
    : null
  const refused = code => ({
    ok: false,
    code,
    nodeId: node?.id || null,
    sessionId,
    threadId,
  })

  if (!restarted || restarted.ok !== true || !sessionId) {
    return refused(restarted?.code || 'MC_TREE_COMMAND_START_FAILED')
  }
  if (!node || node.sessionId !== sessionId) return refused('MC_TREE_COMMAND_SESSION_CHANGED')
  if (!sessionNodeIds || sessionNodeIds.get(sessionId) !== node.id) {
    return refused('MC_TREE_COMMAND_SESSION_NOT_BOUND')
  }
  if (!bridge || typeof bridge.send !== 'function') {
    return refused('MC_TREE_COMMAND_AGENT_BRIDGE_UNAVAILABLE')
  }
  if (typeof appendTranscript !== 'function') {
    return refused('MC_TREE_COMMAND_TRANSCRIPT_WRITER_UNAVAILABLE')
  }

  const message = typeof node.message === 'string' ? node.message : ''
  const context = nodeManagerContext(briefContext)
  const text = composeNodeBrief({ message, ...briefContext })
  const roleIntroduction = typeof restarted.roleIntroduction === 'string' && restarted.roleIntroduction
    ? restarted.roleIntroduction
    : null

  const markFailed = () => {
    if (sessionNodeIds.get(sessionId) !== node.id
        || (typeof treeStore?.getNode === 'function' && treeStore.getNode(node.id)?.sessionId !== sessionId)) return
    if (treeStore) treeStore.setNodeStatus(node.id, 'failed', { note: failedNote })
    refreshTree()
  }

  /* Match the ordinary Page 2 start: make every word the product sends visible
     before the provider can stream a reply back into this transcript. The fresh
     helper has already installed both session bindings, so no event can race an
     unknown session here. */
  try {
    const at = now()
    if (message) appendTranscript(sessionId, { who: 'you', text: message, at })
    appendTranscript(sessionId, { who: 'you', text: context, at })
    if (roleIntroduction) appendTranscript(sessionId, { who: 'you', text: roleIntroduction, at })
    if (treeStore) treeStore.setNodeStatus(node.id, 'running', { note: '' })
    refreshTree()
  } catch {
    markFailed()
    return refused('MC_TREE_COMMAND_TRANSCRIPT_WRITER_UNAVAILABLE')
  }

  const sendBootTurn = async () => {
  let sent = null
  try {
    sent = await bridge.send({ sessionId, text })
  } catch (error) {
    markFailed()
    return refused(refusalCodeFromError(error) || 'MC_TREE_COMMAND_SEND_FAILED')
  }
  if (sent && sent.ok === false) {
    markFailed()
    return refused(refusalCodeFromResult(sent) || 'MC_TREE_COMMAND_SEND_FAILED')
  }

  return { ok: true, code: null, nodeId: node.id, sessionId, threadId }
  }
  if (acknowledgeRoot) {
    // Release the serial tree broker once the actual replacement root is
    // bound. Its boot turn may itself ask that same broker for descendants.
    void sendBootTurn().catch(() => { markFailed() })
    return { ok: true, code: null, nodeId: node.id, sessionId, threadId, firstTurnState: 'submitted' }
  }
  return sendBootTurn()
}
