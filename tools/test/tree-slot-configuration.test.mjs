import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { createTreeSlotConfigurationAuthority } = createRequire(import.meta.url)('../../shell/tree-slot-configuration.cjs')
const rows = [
  { id: 'root', treeId: 'tree', parentId: null, sessionId: 'root-session' },
  { id: 'manager', treeId: 'tree', parentId: 'root', sessionId: 'manager-session' },
  { id: 'sibling', treeId: 'tree', parentId: 'root', sessionId: 'sibling-session' },
  { id: 'child', treeId: 'tree', parentId: 'manager', sessionId: 'child-session' },
  { id: 'stopped', treeId: 'tree', parentId: 'child', sessionId: null },
]
function fixture() {
  const state = { parent: { nodeId: 'manager', treeId: 'root', treeAnchors: ['root', 'manager'], owner: 'owner', permissionSession: { origin: 'local', tier: 'full' } }, owner: 'owner' }
  const authority = createTreeSlotConfigurationAuthority({ readParent: id => id === 'manager-session' ? state.parent : null,
    readForest: () => ({ nodes: rows }), readSessionOwner: () => state.owner })
  return { state, run: extra => authority.admit({ action: 'set-node-model', choice: 'chosen-model', computerId: 'fixture', parentSessionId: 'manager-session', nodeId: 'child', ...extra }) }
}
test('managed slot configuration permits retained direct and deeper descendants without allocating identities', () => {
  const f = fixture()
  assert.equal(f.run({}).nodeId, 'child')
  assert.equal(f.run({ nodeId: 'stopped' }).nodeId, 'stopped')
  assert.equal(f.run({ nodeId: 'stopped' }).expectedSessionId, null)
  assert.equal(rows.length, 5)
})
test('managed slot configuration refuses siblings, ancestors, self and unknown slots', () => {
  const f = fixture()
  for (const nodeId of ['sibling', 'root', 'manager', 'missing']) assert.throws(() => f.run({ nodeId }), { code: 'TREE_CONFIGURATION_REFUSED' })
})
test('managed slot configuration refuses stale parent, target identity and foreign owner', () => {
  const f = fixture()
  assert.throws(() => f.run({ parentSessionId: 'old-manager-session' }), { code: 'TREE_CONFIGURATION_REFUSED' })
  for (const parentSessionId of [null, undefined, '', 'spoofed-owner']) {
    assert.throws(() => f.run({ action: 'set-node-account', choice: 'registered-backup', parentSessionId,
      expectedSessionId: 'child-session' }), { code: 'TREE_CONFIGURATION_REFUSED' }, 'agent dispatch cannot omit its parent to become an owner command')
  }
  assert.throws(() => f.run({ expectedSessionId: 'old-child-session' }), { code: 'TREE_CONFIGURATION_REFUSED' })
  f.state.owner = 'different-owner'
  assert.throws(() => f.run({}), { code: 'TREE_CONFIGURATION_REFUSED' })
})
test('unsupported authority or malformed configuration is a named refusal', () => {
  const f = fixture()
  for (const choice of ['', '\u0000', 42]) assert.throws(() => f.run({ choice }), { code: 'TREE_CONFIGURATION_REFUSED' })
  assert.throws(() => f.run({ action: 'enable-agent' }), { code: 'TREE_CONFIGURATION_REFUSED' })
  f.state.parent.permissionSession.tier = 'standard'
  assert.throws(() => f.run({}), { code: 'TREE_CONFIGURATION_REFUSED' })
})
/* THE HOST'S REAL PARENT SHAPE. shell/agent-host.cjs readTreeParent names the
   tree by its FIRST STANDING-REQUEST ANCHOR, the top circle's node id
   (`treeId: treeRequestIdentity.treeAnchors[0]`), never by the saved tree
   record id. Measured live: a controller's own
   agent.set_account on its direct child was refused
   TREE_CONFIGURATION_REFUSED, because this check compared that anchor with
   the saved node's tree record id and so could never pass on a real tree. */
function hostShapedFixture(anchors = ['root', 'manager']) {
  const parent = { nodeId: 'manager', treeId: anchors[0], treeAnchors: anchors, owner: 'owner', permissionSession: { origin: 'local', tier: 'full' } }
  const authority = createTreeSlotConfigurationAuthority({ readParent: id => id === 'manager-session' ? parent : null,
    readForest: () => ({ nodes: rows }), readSessionOwner: () => 'owner' })
  return extra => authority.admit({ action: 'set-node-account', choice: 'fresh-account', computerId: 'fixture', parentSessionId: 'manager-session', nodeId: 'child', ...extra })
}
test('a managing session identified the way the host identifies it may configure its descendants', () => {
  const run = hostShapedFixture()
  assert.equal(run({}).nodeId, 'child')
  assert.equal(run({ nodeId: 'stopped' }).nodeId, 'stopped')
  assert.equal(run({}).treeId, 'tree', 'the answer still names the saved tree record')
})
test('a managing session whose host ancestry disagrees with the saved tree is refused', () => {
  for (const anchors of [['other-root', 'manager'], ['manager'], ['root', 'sibling'], ['root', 'manager', 'child'], []]) {
    assert.throws(() => hostShapedFixture(anchors)({}), { code: 'TREE_CONFIGURATION_REFUSED' }, JSON.stringify(anchors))
  }
})
