/* A command that lands while an account recovery is moving a circle is judged after the move.
 *
 * The recovery coordinator retires a circle's session and starts a successor on the same circle. For
 * as long as that flight lasts, the saved node names the old session, or the new one before its
 * handoff turn has gone out, so a resume or a send judged then sees only half of the move.
 *
 * The wait is bounded and adds no authority: every check made before it is made again against the
 * circle as it is afterwards (same circle and creation, the session the caller named, the asker's
 * place on the tree), and a caller refused at the gate never waits. A command that meets no flight
 * takes the first return below and is answered as before.
 *
 * A resume answers with a successor only when the application owns that session for this circle and
 * the host reports it open. An owned successor the host does not confirm is refused, not started
 * over; a session the application does not own for this circle falls through to the ordinary gates,
 * which alone decide whether a start is allowed. This module never starts a session, so it cannot
 * start a second one. */
import { resumeNodeCommandResult } from './resume-node-command-result.js'

/* Matches the bounded projection wait in runTreeNodeCommand. */
export const NODE_SETTLE_BOUND_MS = 30_000
/* Floor for a coordinator that cannot announce the end of a flight (subscribeRecoverySettled), or an
   announcement that never comes: a wait cannot outlive its flight by more than this. */
export const NODE_SETTLE_POLL_MS = 250

const refusal = (code, nodeId, reason, extra = {}) => ({
  ok: false, code, nodeId: nodeId || null, sessionId: null, threadId: null, ...(reason ? { reason } : {}), ...extra,
})

const sameCircle = (a, b) => Boolean(a && b && a.id === b.id && a.createdAt === b.createdAt && a.treeId === b.treeId)

/** Ask the host whether it still holds this session. Unknown is no: only an
 *  explicit ok answer for a session that is not closing counts. */
export async function hostSessionAlive(bridge, sessionId) {
  if (typeof bridge?.sessionActivity !== 'function' || typeof sessionId !== 'string' || !sessionId) return false
  let activity = null
  try { activity = await bridge.sessionActivity({ sessionId }) } catch { return false }
  return Boolean(activity) && activity.ok === true && activity.closing !== true
}

/**
 * Resolve when `isSettling(nodeId)` stops being true, or when the bound passes.
 * `{ waited: false }` is the no-flight answer: nothing was subscribed to and no
 * timer was made. A question that cannot be asked (`isSettling` throws) is
 * treated as "nothing to wait for", which leaves the ordinary gates to decide.
 */
export function awaitNodeSettled({ nodeId, isSettling, subscribe = null, boundMs = NODE_SETTLE_BOUND_MS, pollMs = NODE_SETTLE_POLL_MS, now = Date.now } = {}) {
  const settling = () => { try { return isSettling(nodeId) === true } catch { return false } }
  if (!settling()) return Promise.resolve({ waited: false, settled: true, waitedMs: 0 })
  const startedAt = now()
  return new Promise(resolve => {
    let done = false, unsubscribe = null, poll = null, bound = null
    const finish = settled => {
      if (done) return
      done = true
      clearInterval(poll)
      clearTimeout(bound)
      try { unsubscribe?.() } catch { /* a retired listener registry has nothing to release */ }
      resolve({ waited: true, settled, waitedMs: Math.max(0, now() - startedAt) })
    }
    const check = () => { if (!settling()) finish(true) }
    // Any word about THIS circle is a reason to look again; only the look decides.
    if (typeof subscribe === 'function') {
      try { unsubscribe = subscribe(value => { if (value && value.nodeId === nodeId) check() }) } catch { unsubscribe = null }
      // A word delivered while subscribing ended the wait before there was anything to release
      // or any timer to arm.
      if (done) { try { unsubscribe?.() } catch { /* nothing left to release */ } return }
    }
    poll = setInterval(check, pollMs)
    bound = setTimeout(() => finish(false), boundMs)
    // A flight can end between the first look and the subscription above.
    check()
  })
}

/**
 * Identity, authority and the named session, asked again against the circle as
 * it is RIGHT NOW. `settleNodeForCommand` awaits twice (the flight, then the
 * host), and either await can let any of the three move; an approval decided
 * before an await must never be carried past it. Returns `{ answer }` on a
 * refusal, `{ node }` with the fresh circle otherwise.
 */
function revalidate({ command, node, isDestroyed, currentNode, callerRefusal }) {
  if (isDestroyed()) return { answer: refusal('MC_TREE_COMMAND_VIEW_DESTROYED', node.id, null, { retryable: true, retryAfterMs: 0 }) }
  const fresh = currentNode()
  if (!sameCircle(fresh, node)) {
    return { answer: refusal('MC_TREE_COMMAND_NODE_NOT_FOUND', node.id, 'This circle changed while it was being moved to a new session, so nothing was done.') }
  }
  if (command.expectedSessionId && fresh.sessionId !== command.expectedSessionId) {
    return { answer: refusal('MC_TREE_COMMAND_SESSION_CHANGED', node.id,
      'This circle has a different session now. Read its current session before trying again.') }
  }
  const stands = callerRefusal(fresh)
  if (stands) return { answer: stands }
  return { node: fresh }
}

/**
 * The step runTreeNodeCommand takes for the two commands that act on a circle's
 * current session (resume-node, send-to-bound-node), after every check that
 * needs no waiting has passed.
 *
 * Returns `{ answer }` when the command is finished (a refusal, or a resume the
 * successor already satisfies) and `{ node, waited }` when it carries on. `node`
 * is then the circle as it is NOW, and the caller must use it, not the one it
 * looked up before the wait.
 */
export async function settleNodeForCommand({
  command, node, isSettling, subscribe = null, boundMs, pollMs, now,
  isDestroyed = () => false, currentNode, callerRefusal = () => null,
  sessionNodeIds, sessionThreadIds = new Map(), sessionAlive = async () => false,
} = {}) {
  const waited = await awaitNodeSettled({ nodeId: node.id, isSettling, subscribe, boundMs, pollMs, now })
  if (!waited.waited) return { node, waited: false }

  if (isDestroyed()) return { answer: refusal('MC_TREE_COMMAND_VIEW_DESTROYED', node.id, null, { retryable: true, retryAfterMs: 0 }) }
  if (!waited.settled) {
    const resume = command.action === 'resume-node'
    return { answer: refusal(resume ? 'MC_TREE_COMMAND_RESUME_REFUSED' : 'MC_TREE_COMMAND_SEND_FAILED', node.id,
      'This circle is still being moved to a new session after an account limit. Nothing was changed; send this again in a moment.',
      { retryable: true, retryAfterMs: 5000 }) }
  }

  const revalidateArgs = { command, node, isDestroyed, currentNode, callerRefusal }
  const afterWait = revalidate(revalidateArgs)
  if (afterWait.answer) return afterWait
  let fresh = afterWait.node

  const successor = fresh.sessionId && fresh.sessionId !== (node.sessionId || null) ? fresh.sessionId : null
  if (command.action === 'resume-node' && successor && sessionNodeIds?.get(successor) === fresh.id) {
    // A session this application owns for this circle is not started over on
    // the strength of a host that did not say it is open: refuse, and let the
    // caller ask again, rather than risk two live sessions on one circle.
    if (!await sessionAlive(successor)) {
      return { answer: refusal('MC_TREE_COMMAND_RESUME_REFUSED', node.id,
        'This circle moved to a new session, but the host has not confirmed that session is open. Nothing was started; try again in a moment.',
        { retryable: true, retryAfterMs: 5000 }) }
    }
    // The host answered after an await: identity, authority and the named
    // session are asked again in full, not assumed to still hold from before it.
    const afterHost = revalidate(revalidateArgs)
    if (afterHost.answer) return afterHost
    const again = afterHost.node
    if (again.sessionId === successor) {
      const result = resumeNodeCommandResult({ nodeId: again.id, previousSessionId: node.sessionId || null, node: again, sessionNodeIds, sessionThreadIds })
      if (result.ok) return { answer: result }
    }
    fresh = again
  }
  return { node: fresh, waited: true }
}
