/* Pure orchestration seam for the coordinator's clean node replacement.
 *
 * The Computers view supplies its real stores and maps. Keeping the transition
 * here makes the safety properties executable in Node tests: reset failure
 * prevents start, start failure cannot bind, and successful binding precedes
 * return. This function has no send operation and never accepts prompt text,
 * resumeThreadId, or transcript seed material.
 */

const nothing = () => {}

export async function executeFreshStartExistingNode({
  node,
  bridge,
  sourceIsReal,
  canStart = () => false,
  sessionState,
  nodeState,
  transcriptStore = null,
  diffHistoryStore = null,
  treeStore = null,
  clearOutbox = nothing,
  resetSessionMetrics = nothing,
  notifySessionMappingsChanged = nothing,
  refreshTree = nothing,
  tierEffort = null,
  profileId = null,
  requestKeys = null,
  treeIdentity = null,
  roleBinding = null,
  delegationToken = null,
  rememberBoundSessionProfile = nothing,
  failedNote = '',
  clearedNote = '',
  refusalCodeFromError = () => null,
  refusalCodeFromResult = () => null,
} = {}) {
  /* A REASON RIDES BESIDE THE CODE ON A REFUSAL, exactly as
     src/create-and-start-node.js's own `refused` already carries one. Both
     src/main.js completeTreeNodeCommand and
     shell/tree-command-refusal-sentences.cjs treeCommandRefusalSentence read
     a bounded `reason` off ANY tree-node-command refusal -- the errand table
     there already names this action ("restart that circle") -- so the two
     catches below that had a real Error sitting in scope and threw its
     message away were the one place this restart verb still answered an
     assistant with nothing but a bare code. */
  const refused = (code, reason = null) => ({
    ok: false,
    code,
    nodeId: node?.id || null,
    sessionId: null,
    threadId: null,
    ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
  })
  const markFailed = result => {
    if (treeStore) treeStore.setNodeStatus(node.id, 'failed', {
      note: typeof failedNote === 'function' ? failedNote(result) : failedNote,
    })
    refreshTree()
    return result
  }
  const startAllowed = () => {
    try {
      const answer = canStart()
      if (typeof answer?.then === 'function') void Promise.resolve(answer).catch(() => {})
      return answer === true
    } catch { return false }
  }
  if (!node || !bridge || typeof bridge.start !== 'function') return refused('MC_TREE_COMMAND_AGENT_BRIDGE_UNAVAILABLE')
  if (!sourceIsReal) return refused('MC_TREE_COMMAND_REAL_SOURCE_REQUIRED')
  if (!startAllowed()) return refused('MC_TREE_COMMAND_START_DISABLED')

  const nodeIds = sessionState?.nodeIds
  if (!nodeIds || typeof nodeIds.has !== 'function' || typeof nodeIds.set !== 'function') {
    return refused('MC_TREE_COMMAND_EVENT_MAP_UNAVAILABLE')
  }
  const oldSessionId = typeof node.sessionId === 'string' && node.sessionId ? node.sessionId : null
  const oldSessionIsOurs = Boolean(oldSessionId && nodeIds.has(oldSessionId))
  const saved = transcriptStore ? transcriptStore.get(node.id) : null
  const keptEffort = (oldSessionId ? sessionState.efforts?.get(oldSessionId) : null)
    || saved?.effort || tierEffort

  /* A live renderer-owned session must be proved closed. A persisted session
     from a previous app run is deliberately treated as stale and unknown. */
  if (oldSessionId) {
    if (typeof bridge.close !== 'function') {
      if (oldSessionIsOurs) return refused('MC_TREE_COMMAND_CLOSE_UNAVAILABLE')
    } else {
      let closed = null
      try { closed = await bridge.close({ sessionId: oldSessionId, ...(delegationToken ? { delegationToken } : {}) }) }
      catch (error) {
        const code = refusalCodeFromError(error)
        if (delegationToken && code === 'TREE_DELEGATION_REFUSED') return refused(code, error?.message)
        if (oldSessionIsOurs) return refused('MC_TREE_COMMAND_CLOSE_FAILED', error?.message || String(error))
      }
      if (oldSessionIsOurs && closed && closed.ok === false) return refused('MC_TREE_COMMAND_CLOSE_FAILED')
    }
    // Closing can wait on the old process. A revoked start must keep the
    // saved transcript and queued words rather than clearing them for nothing.
    if (!startAllowed()) return refused('MC_TREE_COMMAND_START_DISABLED')
    clearOutbox(oldSessionId)
    for (const map of [
      sessionState.transcripts,
      sessionState.turnLog,
      sessionState.usage,
      sessionState.modelOverride,
      sessionState.pendingImages,
    ]) map?.delete(oldSessionId)
    resetSessionMetrics(oldSessionId)
    for (const map of [nodeIds, sessionState.profileIds, sessionState.efforts, sessionState.threadIds, sessionState.accountNames]) map?.delete(oldSessionId)
    notifySessionMappingsChanged()
  }

  const resetRefused = (code, reason = null) => {
    treeStore?.detachSession(node.id)
    return markFailed(refused(code, reason))
  }
  /* AWAITED, NOT READ SYNCHRONOUSLY. The production transcript store
     (src/node-transcript-client.js, wired in whenever window.mcTranscripts
     exists -- always, in the packaged app) answers `remove()` with a Promise,
     never a bare boolean. Reading it without awaiting made this refuse every
     restart unconditionally, after the old session above was already closed
     and its maps cleared: MEASURED, Controller 2026-09-06, four circles for
     four attempts, before and after an app restart. */
  if (transcriptStore) {
    let removed = false
    try { removed = await transcriptStore.remove(node.id) }
    catch (error) { return resetRefused('MC_TREE_COMMAND_TRANSCRIPT_RESET_FAILED', error?.message || String(error)) }
    if (removed !== true) return resetRefused('MC_TREE_COMMAND_TRANSCRIPT_RESET_FAILED')
  }
  if (diffHistoryStore && diffHistoryStore.remove(node.id) !== true) {
    return resetRefused('MC_TREE_COMMAND_DIFF_RESET_FAILED')
  }
  for (const map of [nodeState?.diffHistories, nodeState?.replies, nodeState?.activity, nodeState?.lastTool]) map?.delete(node.id)
  treeStore?.detachSession(node.id)

  let started = null
  try {
    if (!startAllowed()) return markFailed(refused('MC_TREE_COMMAND_START_DISABLED'))
    started = await bridge.start({
      surface: 'fleet-tree',
      /* A persisted session can be unknown to this process while its directory
         row is still inside the heartbeat window. The host retires this exact
         prior row before registering the replacement, so one circle never has
         two live addresses after an app restart. */
      ...(oldSessionId ? { replacesSessionId: oldSessionId } : {}),
      ...(node.tier ? { tier: node.tier } : {}),
      ...(keptEffort ? { effort: keptEffort } : {}),
      ...(profileId ? { profileId } : {}),
      ...(roleBinding ? { roleBinding } : {}),
      ...(delegationToken ? { delegationToken } : {}),
      requestKeys,
      ...(treeIdentity ? { treeIdentity } : {}),
    })
  } catch (error) {
    return markFailed(refused(refusalCodeFromError(error) || 'MC_TREE_COMMAND_START_FAILED', error?.message || String(error)))
  }
  if (!started || started.ok === false || typeof started.sessionId !== 'string' || !started.sessionId) {
    /* THE SAME `.message` create-and-start-node.js ALREADY READS off a
       RETURNED (not thrown) start refusal -- see its own `started.message`
       check. A bridge may answer "no" either by throwing or by resolving
       with a result that says so; the catch above already carries a thrown
       error's message, and this returned-refusal branch is the other half of
       that same door. */
    return markFailed(refused(
      refusalCodeFromResult(started) || 'MC_TREE_COMMAND_START_FAILED',
      started && typeof started.message === 'string' ? started.message : null,
    ))
  }

  /* This is the critical ordering edge. The event router map is installed
     before the durable tree attachment, and both exist before sessionId can be
     returned to a caller preparing the separate sanitized send command. */
  nodeIds.set(started.sessionId, node.id)
  if (keptEffort) sessionState.efforts?.set(started.sessionId, keptEffort)
  const threadId = typeof started.threadId === 'string' && started.threadId ? started.threadId : null
  if (threadId) sessionState.threadIds?.set(started.sessionId, threadId)
  sessionState.accountNames?.set(
    started.sessionId,
    typeof started.account === 'string' && started.account ? started.account : null,
  )
  if (treeStore) {
    /* THE NODE MUST STILL BE THE ONE THIS SESSION IS FOR. bridge.start() above
       is a real, slow call -- spawning a process and resolving an account can
       take real wall-clock time -- and detachSession() already took this node
       OUT of LIVE_STATUSES before that call went out, which is exactly the
       fact treeStore.removeNode()'s own guard reads (src/fleet-trees.js). A
       Remove pressed on this same node while start() was in flight refuses
       nothing: the node treeStore knew about is simply gone by the time
       start() answers, and attachSession() below -- which already refuses
       cleanly for a missing node -- is the first thing that finds out.
       Trusting `started` anyway is the exact failure nodeReplacementFlight's
       own header names: a live, spending session with nothing on the tree
       able to reach it, reached this time through a remove instead of a
       second replacement. So its answer is read, not thrown away, and a
       session this node can no longer hold is closed rather than left
       running for nothing to find again. */
    const attached = treeStore.attachSession(node.id, started.sessionId)
    if (!attached || attached.ok !== true) {
      nodeIds.delete(started.sessionId)
      sessionState.efforts?.delete(started.sessionId)
      sessionState.threadIds?.delete(started.sessionId)
      sessionState.accountNames?.delete(started.sessionId)
      try { await bridge.close({ sessionId: started.sessionId }) }
      catch { /* nothing on the tree can reach it either way; best effort */ }
      return refused(
        'MC_TREE_COMMAND_NODE_REMOVED',
        'This circle was removed while it was restarting, so the new session was closed rather than left running with nothing to show it.',
      )
    }
    rememberBoundSessionProfile(started.sessionId, node.id, profileId)
    treeStore.setNodeReply(node.id, '')
    treeStore.setNodeStatus(node.id, 'finished', { note: clearedNote })
    refreshTree()
  }
  const roleIntroduction = typeof started.roleIntroduction === 'string' && started.roleIntroduction
    ? started.roleIntroduction
    : null
  return { ok: true, code: null, nodeId: node.id, sessionId: started.sessionId, threadId,
    ...(roleIntroduction ? { roleIntroduction } : {}) }
}
