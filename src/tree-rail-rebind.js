/* WHEN AN OPEN RAIL IS STALE, decided in one place.
 *
 * MEASURED 2026-09-04, tracing "one agent sometimes cannot spawn another": a
 * circle is pressed and its rail is opened while the asynchronous start is
 * still completing. The rail is therefore built from a node whose sessionId is
 * still null, which is the session-less half of the view's chat config -- a
 * read-only panel with a disabled composer, no registered chat surface, and a
 * mounted chat that records `sessionId: null`. When the start lands and the
 * real session is attached to that same node, the panel in front of the person
 * is bound to a session that does not exist: the reply is received and
 * persisted, and every door into the open chat is keyed by a session id the
 * mount does not carry. The person cannot answer the agent -- the follow-up
 * that asks it to spawn a worker -- from the panel they are looking at.
 *
 * THIS IS ONE QUESTION ONLY: does the panel in front of the person show the
 * session the node actually has? Both directions of that disagreement are the
 * same defect. A session LANDING on the node leaves a read-only panel that can
 * never reach it. A session LEAVING the node -- a restart that fails detaches
 * before it starts the replacement -- leaves a live composer pointed at a
 * process that was closed a moment ago. Neither is "should the rail be rebuilt"
 * in general: a resume that SUCCEEDS rebuilds for a different reason, because
 * it has just replaced the conversation the panel shows, and it must keep
 * rebuilding even when the session id did not change. Asking this decision
 * there would answer the wrong question, so that one tail keeps its own
 * unconditional remount and every other landing site asks here.
 *
 * THE OTHER HALF OF THE RULE IS AS LOAD-BEARING AS THE FIRST. Remounting is an
 * innerHTML rebuild: it disposes the mounted chat, and that closes an open
 * actions popup with the person's filter text and cursor in it. So a rail that
 * is already mounted on the session that just landed is left exactly as it is,
 * and so is a rail showing a different node, a rail that is not on screen, and
 * a node the store no longer holds.
 *
 * `railSessionId` is what the mounted chat recorded at build time, never the
 * store's idea of the node -- the whole defect is that those two disagree. */
export function railRebindDecision({
  railActive = false,
  railNodeId = null,
  railSessionId = null,
  node = null,
} = {}) {
  const answer = (rebind, reason) => Object.freeze({ rebind, reason })
  if (!railActive) return answer(false, 'rail-closed')
  const shown = text(railNodeId)
  if (!shown) return answer(false, 'no-rail')
  const landedOn = node && typeof node === 'object' ? text(node.id) : null
  if (!landedOn) return answer(false, 'node-gone')
  if (landedOn !== shown) return answer(false, 'other-node')
  const session = text(node.sessionId)
  const mounted = text(railSessionId)
  /* AGREEMENT IS THE WHOLE TEST, including agreement that there is nothing:
     a dashed circle whose rail is already the read-only panel must not be torn
     down and rebuilt every time something touches the node. */
  if (mounted === session) return answer(false, session ? 'already-bound' : 'no-session')
  if (!session) return answer(true, 'session-detached')
  return answer(true, mounted ? 'session-replaced' : 'session-attached')
}

/* An id is a non-empty string or it is absent. A number, a boolean and a
   whitespace-only string are all "no id" rather than a value to compare, so a
   truthy non-string can never be mistaken for a live session. */
function text(value) {
  return typeof value === 'string' && value.trim() ? value : null
}
