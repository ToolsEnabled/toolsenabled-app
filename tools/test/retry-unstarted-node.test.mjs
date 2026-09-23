import test from 'node:test'
import assert from 'node:assert/strict'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { canRetryUnstartedNode, executeRetryUnstartedNode } from '../../src/retry-unstarted-node.js'

function fixture() {
  let saved = null
  let writesFail = false
  const store = createFleetTreeStore({ computerId: 'retry-test', storage: {
    read: () => saved,
    write: (_key, value) => { if (writesFail) return false; saved = structuredClone(value); return true },
  } })
  const tree = store.createTree({ name: 'Saved team' }).tree
  const parent = store.addNode({ treeId: tree.id, role: 'manager', message: 'Coordinate this work.' }).node
  const node = store.addNode({ parentId: parent.id, role: 'builder', tier: 'claude-opus', effort: 'high', message: 'Keep this exact task.' }).node
  store.setNodeStatus(node.id, 'failed', { note: 'Nothing was started.' })
  const started = []
  const args = { nodeId: node.id, treeStore: store, canStart: () => true, refreshAuthority: async () => true,
    startDraftNode: async current => { started.push(current); store.attachSession(current.id, 'retried-session'); store.setNodeStatus(current.id, 'running'); return { ok: true, sessionId: 'retried-session' } } }
  return { store, node: store.getNode(node.id), started, args, failWrites: () => { writesFail = true } }
}

test('retry keeps the same tree, parent, role, model, effort and saved task', async () => {
  const f = fixture()
  const before = f.store.snapshot()
  assert.equal((await executeRetryUnstartedNode(f.args)).ok, true)
  assert.equal(f.started.length, 1)
  for (const key of ['id', 'treeId', 'parentId', 'role', 'tier', 'effort', 'message']) assert.equal(f.started[0][key], f.node[key], key)
  assert.equal(f.started[0].status, 'draft')
  assert.equal(f.store.snapshot().nodes.length, before.nodes.length)
  assert.equal(f.store.snapshot().trees.length, before.trees.length)
})

test('a live/saved conversation, pending cleanup or another start never becomes a first-start retry', () => {
  const { node } = fixture()
  assert.equal(canRetryUnstartedNode(node), true)
  for (const status of ['draft', 'starting', 'running', 'finished', 'interrupted']) assert.equal(canRetryUnstartedNode({ ...node, status }), false)
  assert.equal(canRetryUnstartedNode({ ...node, sessionId: 'existing' }), false)
  for (const key of ['hasSavedConversation', 'cleanupPending', 'busy']) assert.equal(canRetryUnstartedNode(node, { [key]: true }), false)
})

for (const change of ['authority-unavailable', 'permission-revoked', 'node-started', 'removed']) {
  test(`retry rechecks after authority refresh: ${change}`, async () => {
    const f = fixture()
    let allowed = true
    f.args.canStart = () => allowed
    f.args.refreshAuthority = async () => {
      if (change === 'permission-revoked') allowed = false
      if (change === 'node-started') f.store.attachSession(f.node.id, 'already-started')
      if (change === 'removed') f.store.removeNode(f.node.id)
      return change !== 'authority-unavailable'
    }
    assert.equal((await executeRetryUnstartedNode(f.args)).ok, false)
    assert.equal(f.started.length, 0)
  })
}

test('a retry that cannot be saved never invokes the provider launcher', async () => {
  const f = fixture()
  f.failWrites()
  assert.equal((await executeRetryUnstartedNode(f.args)).ok, false)
  assert.equal(f.started.length, 0)
  assert.equal(f.store.getNode(f.node.id).message, f.node.message)
})

test('overlapping retry presses start the existing node only once', async () => {
  const f = fixture()
  const results = await Promise.all([executeRetryUnstartedNode(f.args), executeRetryUnstartedNode(f.args)])
  assert.equal(results.filter(r => r.ok).length, 1)
  assert.equal(f.started.length, 1)
})
