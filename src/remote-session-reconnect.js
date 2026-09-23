/* A browser reload does not stop the desktop's agent process. A saved id alone
 * proves nothing: the existing session-scoped models read verifies both host
 * liveness and ownership without starting, resuming, or changing an agent.
 *
 * `refusals` is the memory of what the host has already refused (see
 * src/saved-session-refusals.js). A circle it says to skip is not probed at
 * all; a probe the host refuses terminally is remembered against the circle
 * as it was probed; a session the host answers for is forgotten there. Absent,
 * every candidate is probed on every sweep, as before. */
export async function reconnectRemoteSessions({ nodes, bindings, readSession, readHistory,
  getNode, isCurrent = () => true, onReconnect = () => {}, onProbe = () => {},
  onProbeEnd = () => {}, concurrency = 4, refusals = null }) {
  const candidates = (nodes || []).filter(node => typeof node?.sessionId === 'string'
    && node.sessionId && !bindings.has(node.sessionId) && !(refusals && refusals.skip(node)))
  let index = 0
  const restored = []
  async function worker() {
    while (index < candidates.length && isCurrent()) {
      const node = candidates[index++]
      const sessionId = node.sessionId
      let answer
      let history
      onProbe(sessionId)
      try {
        answer = await readSession({ sessionId })
        if (!answer || answer.ok === false || !Array.isArray(answer.models)) {
          refusals?.remember(node, answer)
          throw new Error('Session ownership unavailable')
        }
        refusals?.forget(sessionId)
        if (readHistory) history = await readHistory(sessionId)
      } catch (error) { refusals?.remember(node, error); onProbeEnd(sessionId); continue }
      if (!answer || answer.ok === false || !Array.isArray(answer.models)
          || !isCurrent() || getNode(node.id)?.sessionId !== sessionId
          || bindings.has(sessionId)) { onProbeEnd(sessionId); continue }
      bindings.set(sessionId, node.id)
      restored.push(node.id)
      try { onReconnect(getNode(node.id), answer, history) }
      finally { onProbeEnd(sessionId) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(candidates.length,
    Math.max(1, Math.min(8, Math.floor(concurrency) || 4))) }, worker))
  return restored
}
