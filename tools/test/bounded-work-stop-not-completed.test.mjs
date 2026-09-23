/* PROBE: does an explicit Stop end up reported as "completed"?
 *
 * src/tree-bounded-work.js createTreeWorkController: stop() sets phase
 * "close-unconfirmed" when a close cannot be confirmed, and deliberately KEEPS
 * the ended-subscription so a later host confirmation can still be observed.
 * refreshClosed() is what observes it -- and when the last row turns "closed"
 * it repaints the whole controller with phase "completed" and the sentence
 * "The host confirmed all started work closed. No further run is scheduled."
 *
 * The person pressed Stop. This asks whether the panel then tells them the
 * work completed.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createTreeWorkController } from '../../src/tree-bounded-work.js'

const HASH = 'a'.repeat(64)
const PLAN = {
  computerId: 'computer-1', treeId: 'tree-1',
  parentNodeId: 'node-parent', parentSessionId: 'session-parent',
  capMs: 60000, tier: 'astra', iterations: 1, intervalMs: 1000, members: [],
}
const SESSION = 'session-child'

function receiptFor () {
  return {
    action: 'tree.dispatch', sessionId: SESSION, nodeId: 'node-child', agentId: 'node-child',
    computerId: PLAN.computerId, treeId: PLAN.treeId,
    parentNodeId: PLAN.parentNodeId, parentSessionId: PLAN.parentSessionId,
    startedAt: 1000, deadlineAt: 61000, capMs: PLAN.capMs,
  }
}

function statusFrom (receipt, { closed = false } = {}) {
  return {
    ok: true, action: 'tree.dispatch',
    sessionId: receipt.sessionId, nodeId: receipt.nodeId, agentId: receipt.agentId,
    computerId: receipt.computerId, treeId: receipt.treeId,
    parentNodeId: receipt.parentNodeId, parentSessionId: receipt.parentSessionId,
    deadlineAt: receipt.deadlineAt, capMs: receipt.capMs,
    record: { sequence: 10, eventHash: HASH },
    ...(closed ? { state: 'closed', endRecord: { sequence: 20, eventHash: HASH } } : { state: 'ready' }),
  }
}

test('a Stop that the host later confirms is not reported as "completed"', async () => {
  const receipt = receiptFor()
  let hostConfirmsClosed = false
  let endedListener = null

  const controller = createTreeWorkController({
    kind: 'launch',
    start: async () => ({ ok: true, sessionId: SESSION, nodeId: receipt.nodeId, boundedWork: receipt, record: { sequence: 10, eventHash: HASH } }),
    readStatus: async () => statusFrom(receipt, { closed: hostConfirmsClosed }),
    // The close itself never confirms, which is what puts the controller into
    // close-unconfirmed and keeps its subscription alive.
    close: async () => ({ ok: false }),
    isBusy: () => false,
    subscribeEnded: listener => { endedListener = listener; return () => { endedListener = null } },
    setTimer: () => null,
    clearTimer: () => {},
  })

  await controller.run(PLAN)
  assert.equal(controller.getState().phase, 'active', 'the launch did not reach active, so the stop below proves nothing')

  await controller.stop()
  const stopped = controller.getState()
  assert.equal(stopped.phase, 'close-unconfirmed',
    `expected an unconfirmed stop to set up the case, got ${stopped.phase}`)
  assert.ok(endedListener, 'the ended-subscription was dropped, so the later confirmation could not arrive')

  // The host now confirms the session really did close, and says so through the
  // very subscription stop() kept open for this purpose.
  hostConfirmsClosed = true
  endedListener(SESSION)
  for (let i = 0; i < 20; i++) await Promise.resolve()

  const after = controller.getState()
  assert.notEqual(after.phase, 'completed',
    'the panel reports "completed" for work the person STOPPED. phase went '
    + `close-unconfirmed -> ${after.phase}, message: ${JSON.stringify(after.message)}`)
  assert.doesNotMatch(String(after.message), /No further run is scheduled/,
    'the stopped panel uses the natural-completion sentence')
})