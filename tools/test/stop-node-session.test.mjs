/* A STOP RACING A REPLACEMENT ON THE SAME NODE MUST NOT CLAIM THE
 * REPLACEMENT'S SESSION IS STOPPED.
 *
 * THE DEFECT, measured by reading both of computers.js's stop handlers (the
 * runTreeNodeCommand 'stop-node' branch an assistant's agent.stop reaches,
 * and the palette's own `id === 'stop'` row a person's own press reaches):
 * both capture node.sessionId ONCE, before the only await in the whole
 * handler (`await bridge.close({ sessionId })`), then write
 * treeStore.setNodeStatus(node.id, 'finished', { note: 'Stopped...' })
 * unconditionally once that settles -- using the SAME pre-await node, never
 * re-read.
 *
 * freshStartExistingNode and resumeNodeSession hold nodeReplacementFlight
 * across their own close-then-reopen so two REPLACEMENTS cannot run at once
 * for one node (see tools/test/resume-restart-share-replacement-guard.
 * test.mjs). Stop was deliberately left OUT of that guard -- the engine's
 * own commandOnTree carries a comment explaining why stop is not serialised
 * against OTHER nodes' commands, which says nothing about a stop and a
 * replacement racing on the SAME node. Nothing stops that pair: while a
 * stop's own bridge.close(...) is in flight, a concurrent restart or resume
 * for the SAME node can run start to finish -- close the OLD session (the
 * very one this stop is also closing), open a NEW one, and attach it. If the
 * stop's own close happens to land first, its close still succeeds, and the
 * write that follows lands on top of the REPLACEMENT's brand new, live
 * session: the tree says "Stopped" over an agent that is still there,
 * spending, with nothing that acted on the stop request left running to
 * correct it -- the identical "nothing on screen able to reach it" failure
 * single-flight.js was written to name, reached this time through stop
 * racing a replacement rather than two replacements racing each other.
 *
 * THE FIX (src/stop-node-session.js): re-read the node fresh, right before
 * the write the race actually lands on, and skip the write when the node's
 * CURRENT session is no longer the one this stop just closed -- the close
 * already genuinely happened; only the tree's status write for a session
 * that has moved on is skipped, left for the replacement's own writes to
 * govern.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { stopStillOwnsNode } from '../../src/stop-node-session.js'

test('the ordinary case: nothing raced, the node still holds the session that was just closed', () => {
  assert.equal(stopStillOwnsNode('session-a', { sessionId: 'session-a' }), true)
})

test('BAD VALUE if true: a replacement already gave the node a different, newer live session', () => {
  /* This is the exact shape the bug produces: node.sessionId used to be
     'session-a' (what this stop closed), a concurrent restart already moved
     it to 'session-b' before this stop's own final write ran. A `true` here
     is the defect -- it would tell the caller (and, upstream, the tree
     status write) that stopping 'session-a' is still the right thing to
     stamp onto this node, when the node now means a different, live agent
     this stop was never asked about. */
  assert.equal(stopStillOwnsNode('session-a', { sessionId: 'session-b' }), false)
})

test('BAD VALUE if true: the node was removed out from under the stop entirely', () => {
  assert.equal(stopStillOwnsNode('session-a', null), false)
  assert.equal(stopStillOwnsNode('session-a', undefined), false)
})

test('BAD VALUE if true: the node was detached back to no session (a concurrent stop or remove already ran)', () => {
  assert.equal(stopStillOwnsNode('session-a', { sessionId: null }), false)
})

test('a missing or empty closed-session id never reads as still owning the node', () => {
  /* Defence in depth: a caller cannot pass an unidentifiable "session" and
     have it collapse onto a node that also carries no session, the same
     unidentifiable-subject rule single-flight.js's own null-key case
     documents for a different guard. */
  assert.equal(stopStillOwnsNode(null, { sessionId: null }), false)
  assert.equal(stopStillOwnsNode(undefined, { sessionId: undefined }), false)
  assert.equal(stopStillOwnsNode('', { sessionId: '' }), false)
})

test('a session id that only looks similar is not the same session', () => {
  assert.equal(stopStillOwnsNode('session-a', { sessionId: 'session-a2' }), false)
  assert.equal(stopStillOwnsNode('session-a2', { sessionId: 'session-a' }), false)
})
