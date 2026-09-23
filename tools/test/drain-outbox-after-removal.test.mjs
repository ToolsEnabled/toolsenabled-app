/* A DELIVERY ALREADY ON THE WIRE MUST NOT RESURRECT A NODE THAT WAS REMOVED
 * WHILE IT WAS IN FLIGHT.
 *
 * THE RACE. queueForSession() (an idle "/queue" or the busy composer's queue
 * door landing on a node that just went idle) takes the front entry and
 * calls drainOutboxMessage() without awaiting it -- the same shape the
 * turn-completed listener uses for the ordinary case. checkedOut
 * (src/session-outbox.js) holds that entry's seat for as long as the
 * resulting bridge.send() round trip is unresolved, and nodeBusy() reads the
 * node's STATUS, which nothing sets to 'running' until that same round trip
 * resolves inside drainOutboxMessage's own success branch. So for the whole
 * span of that one IPC round trip, nodeBusy(node) reads false over a node
 * that genuinely has a delivery in flight -- the exact window the previous
 * two waves' commits (d40226d, c1deccc, 3fbcb92, 04e7719) already measured
 * and fixed for a resume, a Stop, and the Send-now button.
 *
 * performNodeRemoval() is gated on the identical nodeBusy() read
 * ("if (nodeBusy(live)) { ...refuse...; return false }"), so it is refused
 * by exactly nothing during that same window. A person who removes the node
 * in it gets everything performNodeRemoval() promises: the tree store no
 * longer holds the node, transcriptStore.remove() erases the durable
 * conversation, and every session-keyed cache -- sessionTranscripts,
 * sessionTurnLog, sessionNodeIds and outboxClearSession()'s own
 * checkedOut/deliveryRedirect bookkeeping among them -- is deleted "so
 * nothing can deliver into a record that is gone" (performNodeRemoval's own
 * comment, pinned below).
 *
 * drainOutboxMessage()'s bridge.send() promise is still out there, holding a
 * `nodeId` and `sessionId` that name a node which, by the time it settles,
 * has already been removed. Before this fix it never asked. A refusal called
 * setOrgStatus(QUEUE_PANEL.notSent, ...) and, on the rail, repaintRailStatus
 * -- a sticky "did not reach the agent" banner naming a node nobody can see
 * on the canvas any more. A success was worse: it called transcriptAppend(),
 * broadcastOwnerMessage() and turnLogAppend() straight into the exact Maps
 * performNodeRemoval() had just finished deleting for `sessionId` -- silently
 * recreating a lone entry in each of them, keyed by an id no removal will
 * ever run for again -- and then treeStore.setNodeStatus(nodeId, 'running',
 * ...), a call the store correctly refuses ('That agent is not on the
 * computer you are driving.') but whose caller never checks the answer, and
 * setOrgStatus(QUEUE_PANEL.sentNext, 'ok') -- "Sent the next queued
 * message." -- about a node the person had already deleted.
 *
 * THE PRECEDENT ALREADY ON THIS FILE. The shared live/history dispatcher
 * below drainOutboxMessage answers the identical question for
 * every packet it reads, before touching anything: "if (!sessionId ||
 * !sessionNodeIds.has(sessionId)) return". drainOutboxMessage reaches the
 * same session-keyed state through a promise instead of an event and must
 * honour the same gate -- checked against treeStore.getNode(nodeId) rather
 * than sessionNodeIds directly, so a node whose session is merely from an
 * earlier run and never resumed (zombie-session.test.mjs's own scenario,
 * where the node still exists and sessionNodeIds legitimately does not carry
 * it yet) is not swept up by the same fix.
 *
 * THE OUTBOX SIDE ALREADY GOT THIS RIGHT. outboxClearSession() (clearSession
 * in session-outbox.js) already redirects a taken, unresolved reservation to
 * nowhere the instant a node is removed -- proven directly below with the
 * real store, no mock. This suite is about the OTHER half: the caller in
 * src/views/computers.js that has to notice the same fact before it acts on
 * stale identifiers, which src/session-outbox.js has no way to tell it by
 * itself.
 *
 * drainOutboxMessage is closure-private inside computersView (a CSS loader
 * hook makes the module importable under Node, but nothing exported reaches
 * this specific function without a full DOM + tree-store + palette harness --
 * see resume-destroyed-session-leak.test.mjs's own header for the same wall).
 * The production function is evaluated with a deferred bridge receipt and the
 * real store/outbox. The remaining structural assertion also guards the UI
 * integration point; neither layer starts an Electron window or provider.
 *
 *   node tools/test/drain-outbox-after-removal.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { treeSessionEventSource } from './lib/tree-session-event-source.mjs'
import { acceptRemoteSequence } from '../../src/remote-session-history.js'

import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { clearSession, enqueue, requeueFront, takeNext, list, confirmDelivered } from '../../src/session-outbox.js'

const ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const VIEW = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

/* --------------------------------------------------- the real store, driven for real -- */

function memoryStorage() {
  const cells = new Map()
  return {
    read(key) { return cells.has(key) ? JSON.parse(cells.get(key)) : null },
    write(key, value) { cells.set(key, JSON.stringify(value)); return true },
  }
}

const storeOf = () => {
  let count = 0
  let tick = 0
  return createFleetTreeStore({
    computerId: 'c1',
    storage: memoryStorage(),
    now: () => `2026-09-04T00:00:${String((tick += 1)).padStart(2, '0')}.000Z`,
    makeId: kind => `${kind}-${(count += 1)}`,
  })
}

test('a removed node vanishes from the store while its outbox delivery is still on the wire -- the exact window drainOutboxMessage has to notice', () => {
  const store = storeOf()
  const node = store.addNode({ role: 'worker' }).node
  store.attachSession(node.id, 'sess-1')
  store.setNodeStatus(node.id, 'running')

  clearSession('sess-1')
  enqueue('sess-1', 'do the thing')
  const entry = takeNext('sess-1')
  assert.ok(entry, 'the entry was not taken -- this test cannot set up the in-flight window it needs')

  /* THE RACE'S OWN PRECONDITION: the turn that will "release" this entry
     ended (or never started) before the take's own delivery resolved, so the
     node the composer sees is idle -- nodeBusy() reads false -- for exactly
     as long as `entry` is checked out and unresolved. */
  store.setNodeStatus(node.id, 'finished')
  assert.equal(store.getNode(node.id).status, 'finished',
    'the node must read idle for the remainder of this test, matching the real race')

  /* THE PERSON REMOVES IT, RIGHT NOW, WHILE `entry` IS STILL OUT FOR DELIVERY.
     Nothing above refused this -- the store's own removeNode() only checks
     LIVE_STATUSES (starting/running), and 'finished' is not one of them. */
  const removed = store.removeNode(node.id)
  assert.equal(removed.ok, true, 'the store refused the removal this race depends on')
  assert.equal(store.getNode(node.id), null, 'the node must be gone from the store for the rest of this test to mean anything')

  /* THE OUTBOX SIDE ALREADY GETS THIS RIGHT, proven directly: a real Stop or
     Remove on this node calls outboxClearSession('sess-1'), and the taken
     entry's reservation is redirected to nowhere before requeueFront() ever
     sees it again -- session-outbox.js's own contract, not this file's. */
  clearSession('sess-1')
  assert.equal(requeueFront('sess-1', entry), false,
    'requeueFront() resurrected a queue under a session this store was just told has nowhere to go')
})

/* -------------------------------------------------------------- the wiring -- */

function drainOutboxMessageSource() {
  const start = VIEW.indexOf('async function drainOutboxMessage')
  assert.notEqual(start, -1, 'drainOutboxMessage was renamed or removed; this test has nothing to check')
  const end = VIEW.indexOf("/* THE TREE'S OWN EAR ON THE SESSION STREAM.", start)
  assert.notEqual(end, -1, 'could not find where drainOutboxMessage ends (its neighbour was renamed or moved)')
  return VIEW.slice(start, end)
}

/* CODE ONLY -- this file's own header narrates the bug using the exact old
   code shape and the exact new guard, so a raw text scan would trip over its
   own explanation. Block comments stripped first, offsets taken after
   stripping, so what is measured is what actually runs. */
const stripBlockComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '')

test('the live subscription and shared history dispatcher ignore unmapped or removed sessions', async () => {
  const { dispatcher, subscriber } = treeSessionEventSource(VIEW)
  const reached = []
  const checkpoint = new Error('Reached the first owned-session event reader')
  const scope = vm.createContext({
    destroyed: false, replayingRemoteHistory: false,
    source: 'local',
    requestAuthoritativeDesktopTree() { assert.fail('A local event fixture must not request a relay tree') },
    chatWorkspace: false,
    confirmedFileChanges: { add() {} },
    sessionNodeIds: new Map([['owned-session', 'owned-node']]),
    remotePendingPackets: new Map(), remoteAppliedSequences: new Map(), acceptRemoteSequence,
    // The native reconnect's probe buffer and the sessions whose rejoined turn
    // its capture reconciles: read by the same subscription and dispatcher.
    nativePendingPackets: new Map(), nativeReconcileSessions: new Set(),
    reconcileRecoveredTurn: async () => {},
    // Stop at the first event reader: this checks admission to the maintained
    // handler, while the drain tests below execute the real store/outbox path.
    sessionEndedEvent(packet, sessionId) { reached.push(sessionId); throw checkpoint },
  })
  const handlers = vm.runInContext(`const handleAgentEvent = ${dispatcher}; ({
    live: ${subscriber}, history: handleAgentEvent,
  })`, scope)
  for (const handler of [handlers.live, handlers.history]) {
    for (const packet of [undefined, null, {}, { sessionId: 'removed-session' }]) await handler(packet)
    assert.deepEqual(reached, [])
    await assert.rejects(handler({ sessionId: 'owned-session' }), error => error === checkpoint)
    assert.deepEqual(reached.splice(0), ['owned-session'], 'an owned session must reach the reader')
  }
  scope.sessionNodeIds.delete('owned-session')
  await handlers.live({ sessionId: 'owned-session' })
  await handlers.history({ sessionId: 'owned-session' })
  assert.deepEqual(reached, [], 'removing the route must immediately exclude both entry points')
})

// The complete production function is executed. The only asynchronous boundary
// below is the bridge receipt; real store/outbox functions settle the delivery.
function drainFixture(t) {
  const store = storeOf()
  const node = store.addNode({ role: 'worker' }).node
  const sessionId = 'drain-behaviour'
  store.attachSession(node.id, sessionId)
  store.setNodeStatus(node.id, 'finished')
  clearSession(sessionId)
  t.after(() => clearSession(sessionId))
  enqueue(sessionId, 'retained words')
  const entry = takeNext(sessionId)
  assert.ok(entry)
  let resolve, reject
  const receipt = new Promise((yes, no) => { resolve = yes; reject = no })
  const effects = []
  const sandbox = {
    window: { mcAgent: { send: () => receipt } }, treeStore: store, destroyed: false,
    sessionModelOverride: new Map(), outboxRequeueFront: requeueFront,
    outboxConfirmDelivered: confirmDelivered, currentRailTreeNode: null,
    refusalCode: error => error.code,
    sendFailureIsUnconfirmed: code => code === 'TRANSPORT_UNCONFIRMED',
    queuedSendRefusalSentence: () => 'delivery unconfirmed',
    QUEUE_PANEL: { notSent: 'not sent', sentNext: 'sent next' },
    WRITE_OUTCOME_KEYS: { SESSION_OUTBOX: 'outbox' },
    recordUndeliveredWrite: (...args) => effects.push(['undelivered', ...args]),
    setOrgStatus: (...args) => effects.push(['status', ...args]),
    repaintRailStatus: (...args) => effects.push(['repaint', ...args]),
    transcriptAppend: (...args) => effects.push(['transcript', ...args]),
    broadcastOwnerMessage: (...args) => effects.push(['broadcast', ...args]),
    turnLogAppend: (...args) => effects.push(['turn-log', ...args]),
    refreshTree: () => effects.push(['refresh']),
  }
  const run = vm.runInNewContext(`(${drainOutboxMessageSource().trim()})`, sandbox)
  return { store, node, sessionId, entry, effects, resolve, reject,
    start: () => run(sessionId, node.id, entry),
    remove() { assert.equal(store.removeNode(node.id).ok, true); clearSession(sessionId) },
  }
}

for (const code of ['KNOWN_REFUSAL', 'TRANSPORT_UNCONFIRMED']) {
  test(`a ${code} drain does not recreate queue or UI state after its node is removed`, async t => {
    const f = drainFixture(t)
    const sending = f.start()
    f.remove()
    f.reject(Object.assign(new Error('fixture refusal'), { code }))
    await sending
    assert.deepEqual(f.effects, [], 'a removed node must not receive a sticky refusal or a rebuilt transcript')
    assert.deepEqual(list(f.sessionId), [])
    assert.equal(f.store.getNode(f.node.id), null)
  })
  test(`a ${code} drain on an existing node returns the exact entry with the correct retry policy`, async t => {
    const f = drainFixture(t)
    const sending = f.start()
    f.reject(Object.assign(new Error('fixture refusal'), { code }))
    await sending
    const retained = list(f.sessionId)
    assert.equal(retained.length, 1)
    assert.equal(retained[0].id, f.entry.id)
    assert.equal(retained[0].text, 'retained words')
    assert.equal(retained[0].deliveryUnconfirmed === true, code === 'TRANSPORT_UNCONFIRMED')
    assert.equal(f.effects.length, 1)
    assert.equal(f.effects[0][0], 'status')
    assert.equal(f.effects[0][1], code === 'TRANSPORT_UNCONFIRMED' ? 'delivery unconfirmed' : 'not sent')
    if (code === 'TRANSPORT_UNCONFIRMED') assert.equal(takeNext(f.sessionId), null, 'uncertain delivery must wait for an explicit retry')
  })
}

test('a confirmed drain after removal releases its reservation without resurrecting transcript or status', async t => {
  const f = drainFixture(t)
  const sending = f.start()
  f.remove()
  f.resolve({ turnId: 'accepted-turn' })
  await sending
  assert.deepEqual(f.effects, [])
  assert.deepEqual(list(f.sessionId), [])
  assert.equal(f.store.getNode(f.node.id), null)
})

test('a confirmed drain does not resurrect the transcript, turn log or status of a node removed while its send was in flight', () => {
  const body = stripBlockComments(drainOutboxMessageSource())

  /* The ORDER of this file's writes is what this test pins, so it needs the
     position of the confirm call, not its argument list. Matched by name and
     opening bracket rather than by the whole call as it was spelled on
     2026-09-03: confirmDelivered now also takes the entry, because a Stop or
     a resume that lands while this send is on the wire has to be told WHICH
     delivery settled (see outstandingDeliveries in src/session-outbox.js).
     A pin on the old spelling failed against that fix, and the quickest way
     back to green would have been to put the defect back. */
  const confirmAt = body.search(/outboxConfirmDelivered\(sessionId[,)]/)
  assert.notEqual(confirmAt, -1, 'a successful drain no longer releases the seat it held for this entry')
  const destroyedAt = body.indexOf('if (destroyed) {', confirmAt)
  assert.notEqual(destroyedAt, -1, 'the confirmed branch lost its destroyed-view guard')
  const transcriptAt = body.indexOf("transcriptAppend(sessionId, { who: 'you'", destroyedAt)
  assert.notEqual(transcriptAt, -1, 'a confirmed drain no longer appends the delivered words to the transcript')
  const statusAt = body.indexOf("treeStore.setNodeStatus(nodeId, 'running'", destroyedAt)
  assert.notEqual(statusAt, -1, 'a confirmed drain no longer marks the node running')
  assert.ok(statusAt > transcriptAt, 'the pin needs re-aiming -- the status write no longer follows the transcript write')

  const existsCheck = body.indexOf('treeStore.getNode(nodeId)', destroyedAt)
  assert.ok(existsCheck !== -1 && existsCheck < transcriptAt,
    'a confirmed drain still writes sessionTranscripts/sessionTurnLog and calls treeStore.setNodeStatus for a node ' +
    'removed while the send was on the wire -- every one of those caches was deleted by performNodeRemoval() ' +
    '("so nothing can deliver into a record that is gone"), and this door recreates a ghost entry in each of them')

  /* THE PRECISE FACT, NOT A LOOSER ONE. Keyed on the node still being in the
     tree store, never on sessionNodeIds directly: a node whose session is
     merely from an earlier run and was never resumed still exists on the
     canvas (zombie-session.test.mjs's own scenario) and must keep whatever
     answer it already gets from a dead bridge.send() -- this fix is about a
     REMOVED node, not an unresumed one. */
  assert.doesNotMatch(body.slice(destroyedAt, transcriptAt), /sessionNodeIds\.has/,
    'the guard reads sessionNodeIds directly -- it would also suppress the unrelated, still-open zombie-session case')
})
