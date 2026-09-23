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
  const state = { parent: { nodeId: 'manager', treeId: 'tree', owner: 'owner', permissionSession: { origin: 'local', tier: 'full' } }, owner: 'owner' }
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
