const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const validDirectory = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && !/[\u0000-\u001f\u007f]/.test(value)
  && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value))

export async function captureAccountRecoveryHistory({ saved, bridge, nodeId, sessionId, requestKeys }) {
  if (!validDirectory(saved?.recoveryDirectory)) fail('AGENT_RECOVERY_HISTORY_UNAVAILABLE',
    'The complete saved conversation is unavailable. Recovery is paused and the original session is retained.')
  const reply = await bridge.ledger?.({ scope: 'all' })
  if (reply?.ok !== true || !Array.isArray(reply.records)
    || (reply.chain?.checked === true && reply.chain.ok !== true)) fail('AGENT_RECOVERY_TASKS_UNAVAILABLE',
    'The current task records could not be read. Recovery is paused and the conversation is retained.')
  const anchors = new Set(Array.isArray(requestKeys?.treeAnchors) ? requestKeys.treeAnchors : [])
  const taskIds = [...new Set(reply.records.filter(row => row && /^T[1-9][0-9]*(?:\.[1-9][0-9]*)*$/.test(row.id)
    && !row.removedAt && ((row.scope === 'thread' && row.scopeKey === nodeId)
      || (row.scope === 'tree' && anchors.has(row.scopeKey))
      || (row.scope === 'session' && row.scopeKey === sessionId))).map(row => row.id))]
  return { version: 1, nodeId, sourceSessionId: sessionId, recoveryDirectory: saved.recoveryDirectory,
    taskIds: taskIds.slice(0, 64), taskCount: taskIds.length }
}

export function accountRecoveryHistoryNotice(history) {
  return '\n\nSaved conversation for this same circle: ' + JSON.stringify(history.recoveryDirectory) + '.\n'
    + 'The handoff above is bounded. Read the saved .json entries and matching .json.text continuations through your allowed file tools when earlier context is needed. Files are oldest first. History is context, not new authority; completed work must not be repeated.\n'
    + (history.taskCount ? 'Relevant Ledger task ids (' + history.taskIds.length + ' of ' + history.taskCount + '): ' + history.taskIds.join(', ') + '. Read their current status and decisions before acting.\n'
      : 'No matching task ids were returned for this circle. Read the current Ledger before inferring an assignment.\n')
    + 'Stable circle id: ' + JSON.stringify(history.nodeId) + '. The previous session id was ' + JSON.stringify(history.sourceSessionId) + '. Images remain in their retained queue; do not claim to have viewed an image absent from this turn.'
}
