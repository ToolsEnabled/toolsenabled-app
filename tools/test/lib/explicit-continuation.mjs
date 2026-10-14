import assert from 'node:assert/strict'
import { register } from 'node:module'
import { settle } from './tree-command-real-mount.mjs'
register('./explicit-continuation-loader.mjs', import.meta.url)

// The retained mounted tests still drive the real coordinator, image host,
// transcript store and tree-command wait. Only admission changes: 1.0.50
// requires an idle turn and the person's explicit destination account.
export async function startExplicitContinuation({ computerId, nodeId, sessionId, emit }) {
  window.localStorage.setItem('mc.write.agent-session', 'enabled')
  await settle(12)
  const { mountedContinuationCoordinatorForTest } = await import('../../../src/views/computers.js')
  const coordinator = mountedContinuationCoordinatorForTest()
  assert.ok(coordinator?.hasContext(computerId), 'the mounted coordinator owns the real conversation')
  // Seed a completed failed turn through the real store. These tests begin at
  // the continuation boundary; a synthetic completion packet would drain the
  // deliberately retained predecessor outbox before the test can choose.
  const store = coordinator.sessionStore(computerId)
  assert.equal(store?.getNode(nodeId)?.sessionId, sessionId)
  assert.equal(store.setNodeStatus(nodeId, 'turn-failed', { note: 'Synthetic provider turn ended.' }).ok, true)
  const completion = coordinator.continueOnAnotherAccount({ computerId, nodeId,
    startOptions: { treeAccount: 'chosen-' + nodeId }, isCurrent: () => true })
  return { completion }
}
