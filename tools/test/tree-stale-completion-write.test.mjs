import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/* A TURN COMPLETION SPEAKS FOR ONE SESSION, AND ONLY WHILE THE NODE HOLDS IT.
 *
 * src/stop-node-session.js already names this failure from the stop side: a
 * terminal status settling "on top of the REPLACEMENT's brand new, live
 * session, with nothing about that session's actual liveness reflected on the
 * tree and nothing that acted on this stop request left running to correct
 * it". Its own header records why the writer could not catch it --
 * "treeStore.setNodeStatus does not compare against the session it is stamping
 * over, only against the node id".
 *
 * The same write is reachable from the completion side. src/views/computers.js
 * resolves the node for a completing turn through `sessionNodeIds.get(
 * sessionId)`, and the restart path published the new session's mapping
 * without clearing the old one, leaving retireTreeSessionRuntime to do it once
 * the host proved the replaced session dead. In that window the stale mapping
 * still answers with this node, which now holds a different session, and a
 * late completion writes its outcome -- "Stopped by you." among them -- and
 * its words over a live agent.
 *
 * Two halves, both checked here: the writer can now be asked the question, and
 * the restart path no longer opens the window in the first place.
 */

const { createFleetTreeStore } = await import('../../src/fleet-trees.js')

function storeFixture() {
  let record = null
  let counter = 0
  const storage = { read: () => record, write: (_key, value) => { record = JSON.parse(JSON.stringify(value)); return true } }
  return createFleetTreeStore({
    computerId: 'stale-completion',
    storage,
    roleLabel: () => 'Agent',
    makeId: kind => `${kind}-${++counter}`,
    now: () => '2026-09-24T18:00:00.000Z',
  })
}

/* A node that has been replaced: it ran as SESSION-A, and now holds SESSION-B. */
function replacedNode() {
  const store = storeFixture()
  const node = store.addNode({ role: 'worker' }).node
  store.attachSession(node.id, 'SESSION-A')
  store.setNodeStatus(node.id, 'running', { note: '' })
  store.detachSession(node.id)
  store.attachSession(node.id, 'SESSION-B')
  store.setNodeStatus(node.id, 'running', { note: '' })
  return { store, nodeId: node.id }
}

test('a completion for the replaced session cannot report over the live one', () => {
  const { store, nodeId } = replacedNode()
  const answer = store.setNodeStatus(nodeId, 'interrupted', {
    note: 'Stopped by you.', turnId: 'turn-from-session-a', forSessionId: 'SESSION-A',
  })
  assert.equal(answer.ok, true, 'the turn really did complete; this is superseded, not an error')
  assert.equal(answer.superseded, true, 'and it says so, so a caller can tell the two apart')
  const node = store.getNode(nodeId)
  assert.equal(node.status, 'running', 'the live replacement must still read as running')
  assert.notEqual(node.statusNote, 'Stopped by you.', 'and must not carry the old session\'s note')
  assert.equal(node.sessionId, 'SESSION-B')
})

test('a completion for the session the node actually holds still lands', () => {
  const { store, nodeId } = replacedNode()
  const answer = store.setNodeStatus(nodeId, 'finished', {
    note: 'Done.', turnId: 'turn-from-session-b', forSessionId: 'SESSION-B',
  })
  assert.equal(answer.ok, true)
  assert.notEqual(answer.superseded, true)
  assert.equal(store.getNode(nodeId).status, 'finished')
  assert.equal(store.getNode(nodeId).statusNote, 'Done.')
})

test('a caller that names no session is unaffected', () => {
  const { store, nodeId } = replacedNode()
  const answer = store.setNodeStatus(nodeId, 'finished', { note: 'Done.' })
  assert.equal(answer.ok, true)
  assert.equal(store.getNode(nodeId).status, 'finished')
})

/* THE OTHER HALF. A source pin, because the window is opened by an ordering in
   a view function that no unit fixture reaches. Both replacement verbs must
   stop routing the replaced session to this node at the moment they publish
   the new one, rather than leaving it to the later runtime retirement. */
test('both replacement paths clear the replaced session mapping inline', () => {
  const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  const clears = source.match(/sessionNodeIds\.delete\(oldSessionId\)/g) || []
  assert.equal(clears.length >= 2, true,
    'resume and restart must each clear the replaced session mapping where they publish the new one')
})

test('the completion writer asks whether the node still holds its session', () => {
  const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  assert.match(source, /stopStillOwnsNode\(sessionId, treeStore\.getNode\(nodeId\)\)/,
    'the turn-completed handler must ask before it writes')
  assert.match(source, /forSessionId: sessionId/,
    'and must tell the writer which session it speaks for')
})
