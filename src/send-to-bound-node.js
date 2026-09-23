/* The second half of coordinator recovery: one sanitized turn, only after the
 * exact fresh session is present in both the saved node and RUN_SESSION_NODES.
 * The caller's append function is the Computers view's durable transcript
 * writer, so a confirmed send appears in the same record as a typed turn.
 */

export async function executeSendToBoundNode({
  command,
  node,
  bridge,
  sessionNodeIds,
  sessionThreadIds,
  appendTranscript,
  appendTurnLog,
  treeStore = null,
  refreshTree = () => {},
  now = Date.now,
  refusalCodeFromError = () => null,
  refusalCodeFromResult = () => null,
} = {}) {
  const refused = code => ({ ok: false, code, nodeId: node?.id || command?.nodeId || null, sessionId: null, threadId: null })
  if (!command || command.action !== 'send-to-bound-node' || typeof command.message !== 'string'
      || !command.message.trim() || command.message.includes('\0')
      || new TextEncoder().encode(command.message).byteLength > 32 * 1024) {
    return refused('MC_TREE_COMMAND_MESSAGE_INVALID')
  }
  if (!node || !command.expectedSessionId || node.sessionId !== command.expectedSessionId) {
    return refused('MC_TREE_COMMAND_SESSION_CHANGED')
  }
  const sessionId = command.expectedSessionId
  if (!sessionNodeIds || sessionNodeIds.get(sessionId) !== node.id) {
    return refused('MC_TREE_COMMAND_SESSION_NOT_BOUND')
  }
  if (!bridge || typeof bridge.send !== 'function') return refused('MC_TREE_COMMAND_AGENT_BRIDGE_UNAVAILABLE')
  if (typeof appendTranscript !== 'function' || typeof appendTurnLog !== 'function') {
    return refused('MC_TREE_COMMAND_TRANSCRIPT_WRITER_UNAVAILABLE')
  }

  let sent = null
  try {
    /* The event map check above is synchronous and precedes this call. Agent
       deltas emitted by the provider can therefore route to the node from the
       first instant this send exists. */
    sent = await bridge.send({ sessionId, text: command.message })
  } catch (error) {
    return refused(refusalCodeFromError(error) || 'MC_TREE_COMMAND_SEND_FAILED')
  }
  if (sent && sent.ok === false) {
    return refused(refusalCodeFromResult(sent) || 'MC_TREE_COMMAND_SEND_FAILED')
  }

  const turnId = typeof sent?.turnId === 'string' && sent.turnId ? sent.turnId : null
  const entry = { who: 'you', text: command.message, at: now() }
  if (turnId) entry.turnStamp = turnId
  appendTranscript(sessionId, entry)
  if (turnId) appendTurnLog(sessionId, turnId, command.message)
  if (treeStore) treeStore.setNodeStatus(node.id, 'running', { note: '' })
  refreshTree()
  const threadId = sessionThreadIds?.get(sessionId) || null
  return { ok: true, code: null, nodeId: node.id, sessionId, threadId }
}
