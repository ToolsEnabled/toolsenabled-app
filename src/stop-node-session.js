/* A STOP THAT LANDS AFTER A REPLACEMENT HAS ALREADY REPLACED THE NODE MUST
 * NOT SAY THE REPLACEMENT'S SESSION IS STOPPED.
 *
 * MEASURED by reading the "stop" branch of runTreeNodeCommand and the
 * palette's own `id === 'stop'` row in src/views/computers.js (independently
 * confirmed identical in shape): both capture `node.sessionId` ONCE, before
 * the only await in the whole handler (`await bridge.close({ sessionId })`),
 * and then write `treeStore.setNodeStatus(node.id, 'finished', { note:
 * 'Stopped...' })` unconditionally once that await settles -- using the SAME
 * pre-await node, never re-read.
 *
 * freshStartExistingNode and resumeNodeSession hold nodeReplacementFlight
 * (src/single-flight.js) across their own close-then-reopen, exactly so two
 * REPLACEMENTS cannot run at once for one node (see single-flight.js's own
 * header: "two live agents for one node... the later bridge.start wins
 * node.sessionId, the earlier keeps running... with nothing on screen able
 * to reach it"). Stop was deliberately left OUT of that guard --
 * src/lib/agent-tree-spawn.js's own commandOnTree carries the matching
 * engine-side note: "stopping or removing two different circles is an
 * ordinary thing... serialising it would make a manager wait" -- and that
 * reasoning is sound for two DIFFERENT nodes. It says nothing about a stop
 * and a replacement landing on the SAME node, and nothing stops that pair.
 *
 * A stop's own bridge.close(...) is a real, possibly slow, network/process
 * call. While it is in flight, a replacement for the SAME node can run start
 * to finish: close the OLD session (the very one this stop is also trying to
 * close -- bridge.close on an already-closed sessionId throws
 * AGENT_SESSION_UNKNOWN in shell/agent-host.cjs, so ONE ordering is already
 * self-correcting), open a NEW one, and attach it. When the stop's own close
 * call is the one that lands first instead, its close succeeds, and the
 * stale write that follows has nothing left to check it: treeStore.
 * setNodeStatus does not compare against the session it is stamping over,
 * only against the node id -- so a stop's own "Stopped by ..." note and
 * 'finished' status land on top of the REPLACEMENT's brand new, live
 * session, with nothing about that session's actual liveness reflected on
 * the tree and nothing that acted on this stop request left running to
 * correct it. The person or assistant that asked to stop the node reads
 * "Stopped" over an agent that is still there, spending, exactly the "held
 * open with nothing on screen able to reach it" failure single-flight.js was
 * written to name -- reached this time through stop racing a replacement,
 * not through two replacements racing each other.
 *
 * THE FIX IS NOT A SHARED SLOT. Making stop wait on nodeReplacementFlight
 * would adopt the very serialisation commandOnTree's own comment argues
 * against, and stop is not "replacing" anything -- it has no second half to
 * protect from a partial run. The close it performs is real and already
 * happened; only the LAST write needs to ask its question again with a
 * fresh answer. So: re-read the node right before that write, not the one
 * word compare-and-swap.
 */

/**
 * Is it still correct to record this node's status as "stopped" for the
 * session `closedSessionId` names?
 *
 * True exactly when the node's CURRENT (freshly read, not the one captured
 * before the close's own await) session is still the one that was just
 * closed. False when a concurrent replacement (fresh-start or resume) has
 * already given the node a different, newer session -- in which case the
 * stop's own close still genuinely happened and is not undone by skipping
 * this write; only the tree's status is left for the newer session's own
 * writes to govern, rather than being told it belongs to what was closed.
 *
 * @param {string} closedSessionId the session id the close call was given
 * @param {{ sessionId?: string|null }|null|undefined} currentNode a FRESH
 *        read of the node (e.g. treeStore.getNode(nodeId)), taken after the
 *        close settled -- never the snapshot the handler already had before
 *        its own await.
 */
export function stopStillOwnsNode(closedSessionId, currentNode) {
  return Boolean(
    typeof closedSessionId === 'string' && closedSessionId
    && currentNode && currentNode.sessionId === closedSessionId,
  )
}

/* THE SENTENCES THAT MEAN "SOMEONE STOPPED THIS CIRCLE", IN ONE PLACE.
 *
 * A stop is recorded on the tree as a status note, and the automatic
 * machinery reads that note to decide whether it may start the circle again.
 * src/account-recovery-coordinator.js calls this THE STOP FENCE: a saved
 * Autonomous+ continuation is discarded rather than resumed, and a
 * keep-trying-accounts policy is cancelled rather than retried, when the note
 * says the circle was stopped.
 *
 * THE FENCE WAS AN EXACT COMPARISON AGAINST ONE SENTENCE, 'Stopped by you.',
 * and there are two stops. The person's Stop writes that sentence
 * (src/views/computers.js, two sites). A manager's agent.stop writes
 * MANAGER_STOP_NOTE instead -- deliberately, because attribution matters and
 * "you" would be a lie -- and NOTHING read that second sentence.
 *
 * MEASURED 2026-09-24 on this checkout, tools/test/account-recovery-
 * coordinator.test.mjs with a saved continuation for a stopped circle:
 *   note 'Stopped by you.'                    -> ['read', 'stop']
 *   note 'Stopped by the assistant above it.' -> ['read', 'resume', 'attached']
 * The second is the circle coming back to life and spending turns after its
 * manager stopped it, relabelled "Autonomous+ restored this conversation" so
 * that the person reading the tree cannot tell the stop was overridden.
 *
 * So the fence asks this function rather than one string, and the note a stop
 * writes is named here beside it, so a writer and the fence cannot drift
 * apart again. The UI copy that speaks the word "you" deliberately does NOT
 * use this: only the decisions about starting a circle again do.
 */
export const PERSON_STOP_NOTE = 'Stopped by you.'
export const MANAGER_STOP_NOTE = 'Stopped by the assistant above it.'
export const STOP_FENCE_NOTES = Object.freeze([PERSON_STOP_NOTE, MANAGER_STOP_NOTE])

/** Does this status note say the circle was stopped, by whoever pressed it? */
export function noteMeansStopped(note) {
  return typeof note === 'string' && STOP_FENCE_NOTES.includes(note)
}
