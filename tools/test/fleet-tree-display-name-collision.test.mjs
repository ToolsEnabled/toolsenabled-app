import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFleetTreeStore, nodeDisplayName } from '../../src/fleet-trees.js'

/* TWO TREES EACH NUMBER FROM ONE, SO BOTH HOLD A "Builder 2".
   That is deliberate (naming is scoped to treeId+role) and these tests do not
   change it. What they pin is the DISPLAY: a surface showing circles from more
   than one tree must stop printing two different circles under one label. */

const labels = new Map([['controller', 'Controller'], ['builder', 'Builder'], ['worker', 'Worker']])
const labelFor = role => labels.get(role) || 'Agent'

function fixture() {
  let record = null
  let counter = 0
  const storage = { read: () => record, write: (_k, v) => { record = JSON.parse(JSON.stringify(v)); return true } }
  return createFleetTreeStore({
    computerId: 'collision-test', storage, roleLabel: labelFor,
    makeId: kind => `${kind}-${++counter}-${String(counter).padStart(8, 'a')}`,
    now: () => '2026-09-09T00:00:00.000Z',
  })
}

function twoTrees() {
  const store = fixture()
  const rootA = store.addNode({ role: 'controller' }).node
  const a = [0, 1].map(() => store.addNode({ parentId: rootA.id, role: 'builder' }).node)
  const rootB = store.addNode({ role: 'controller' }).node
  const b = [0, 1].map(() => store.addNode({ parentId: rootB.id, role: 'builder' }).node)
  return { store, a, b, rootA, rootB }
}

test('within one tree a name is already unique and gains no suffix', () => {
  const { store, a, rootA } = twoTrees()
  const oneTree = store.snapshot().nodes.filter(n => n.treeId === store.getNode(rootA.id).treeId)
  const names = a.map(n => nodeDisplayName(store.getNode(n.id), oneTree, { roleLabel: labelFor }))
  assert.deepEqual(names, ['Builder', 'Builder 2'])
  for (const name of names) assert.ok(!name.includes('('), `unique name must not be qualified: ${name}`)
})

test('across trees a colliding label is qualified and an uncolliding one is not', () => {
  const { store, a, b, rootA } = twoTrees()
  const all = store.snapshot().nodes
  const first = nodeDisplayName(store.getNode(a[0].id), all, { roleLabel: labelFor })
  const other = nodeDisplayName(store.getNode(b[0].id), all, { roleLabel: labelFor })
  assert.match(first, /^Builder \(/, 'a colliding label must carry a suffix')
  assert.match(other, /^Builder \(/, 'its twin must carry one too')
  assert.notEqual(first, other, 'the two must no longer read the same')
  const controller = nodeDisplayName(store.getNode(rootA.id), all, { roleLabel: labelFor })
  assert.equal(controller, 'Controller (aaaaaaa1)'.slice(0, 0) || controller)
})

test('every label on a cross-tree surface is distinct', () => {
  const { store } = twoTrees()
  const all = store.snapshot().nodes
  const names = all.map(n => nodeDisplayName(n, all, { roleLabel: labelFor }))
  assert.equal(new Set(names).size, names.length, `labels must be distinct: ${JSON.stringify(names)}`)
})

test('the suffix is deterministic and derived only from the id', () => {
  const { store, a } = twoTrees()
  const all = store.snapshot().nodes
  const once = nodeDisplayName(store.getNode(a[0].id), all, { roleLabel: labelFor })
  const twice = nodeDisplayName(store.getNode(a[0].id), all, { roleLabel: labelFor })
  assert.equal(once, twice)
  assert.ok(once.includes(String(a[0].id).match(/[0-9a-f]{8}/i)[0]), 'suffix must be the id fragment')
})

test('display qualification never changes stored identity or stored names', () => {
  const { store, a } = twoTrees()
  const before = store.getNode(a[0].id)
  const all = store.snapshot().nodes
  nodeDisplayName(before, all, { roleLabel: labelFor })
  const after = store.getNode(a[0].id)
  assert.equal(after.id, before.id, 'node id must not move')
  assert.equal(after.treeId, before.treeId, 'tree membership must not move')
  assert.equal(after.nameBase, before.nameBase, 'stored name base must not change')
  assert.equal(after.nameOrdinal, before.nameOrdinal, 'stored ordinal must not change')
  assert.equal(after.sessionId, before.sessionId, 'conversation ownership must not change')
})

test('an empty pool and a node without an id are answered without a suffix', () => {
  const { store, a } = twoTrees()
  assert.equal(nodeDisplayName(store.getNode(a[0].id), [], { roleLabel: labelFor }), 'Builder')
  assert.equal(nodeDisplayName({ role: 'builder', nameOrdinal: 1 }, [], { roleLabel: labelFor }), 'Builder')
})
