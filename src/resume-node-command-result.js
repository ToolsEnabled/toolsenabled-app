// A resume refusal often returns no value. Only the actual new binding proves
// that the command succeeded; a saved thread ID alone is not a running session.
export function resumeNodeCommandResult({ nodeId, previousSessionId, node, sessionNodeIds, sessionThreadIds }) {
  const sessionId = node?.sessionId || null
  const ok = Boolean(sessionId && sessionId !== previousSessionId && sessionNodeIds.get(sessionId) === nodeId && ['running', 'finished'].includes(node.status))
  return { ok, code: ok ? null : 'MC_TREE_COMMAND_RESUME_REFUSED', nodeId, sessionId, threadId: sessionId ? sessionThreadIds.get(sessionId) || null : null }
}
