import assert from 'node:assert/strict'
import test from 'node:test'
import { createFleetTreeStore, treeRecord, parseFleetTrees, EMPTY_FLEET_TREES, FLEET_TREES_RECORD_VERSION } from '../../src/fleet-trees.js'

const PROJECT_A = 'rp-a111'
const PROJECT_B = 'rp-b222'

function fixture() {
  const cells = new Map()
  const storage = {
    read: key => cells.has(key) ? JSON.parse(cells.get(key)) : null,
    write: (key, value) => { cells.set(key, JSON.stringify(value)); return true },
  }
  let id = 0
  let tick = 0
  const options = {
    computerId: 'research-test-computer',
    storage,
    makeId: kind => `${kind}-${++id}`,
    now: () => `2026-09-19T00:00:${String(++tick).padStart(2, '0')}.000Z`,
  }
  return { store: createFleetTreeStore(options), reopen: () => createFleetTreeStore(options) }
}

function root(store, projectId = null, name = 'Lean Bench') {
  const added = store.addNode({ role: '', message: 'Inspect the assigned research.' })
  assert.equal(added.ok, true)
  if (projectId) assert.equal(store.setTreeResearchProject(added.node.treeId, projectId, name).ok, true)
  return added.node
}

function start(store, nodeId, state = 'running') {
  if (state === 'starting') {
    assert.equal(store.setNodeStatus(nodeId, 'starting').ok, true)
  } else {
    assert.equal(store.attachSession(nodeId, `session-${nodeId}`).ok, true)
    assert.equal(store.setNodeStatus(nodeId, state).ok, true)
  }
}

test('research binding clears folder scope and persists exact project identity and display name', () => {
  const { store, reopen } = fixture()
  const node = root(store)
  assert.equal(store.setTreeProfile(node.treeId, 'folder-a').ok, true)
  assert.equal(store.setTreeResearchProject(node.treeId, PROJECT_A, 'Lean Bench / replication').ok, true)
  assert.equal(store.treeProfile(node.treeId), null)
  const tree = store.getTree(node.treeId)
  assert.equal(tree.researchProjectId, PROJECT_A)
  assert.equal(tree.researchProjectName, 'Lean Bench / replication')
  assert.equal(tree.profileId, null)
  assert.deepEqual(reopen().getTree(node.treeId), tree)
  const projected = treeRecord(store.snapshot(), node.treeId)
  assert.equal(projected.researchProjectId, PROJECT_A)
  assert.equal(projected.researchProjectName, 'Lean Bench / replication')
  const before = store.snapshot()
  assert.equal(store.setTreeProfile(node.treeId, 'folder-b').ok, false)
  assert.deepEqual(store.snapshot(), before)
})

test('research binding validates saved project ids and permits deliberate changes only before a start', () => {
  const { store } = fixture()
  const node = root(store, PROJECT_A)
  for (const bad of ['plain-project', 'rp-nothex', 'rp-a', 42, {}]) {
    const before = store.snapshot()
    assert.equal(store.setTreeResearchProject(node.treeId, bad, 'Invalid').ok, false)
    assert.deepEqual(store.snapshot(), before)
  }
  assert.equal(store.setTreeResearchProject(node.treeId, PROJECT_B, 'Replication').ok, true)
  assert.equal(store.getTree(node.treeId).researchProjectId, PROJECT_B)
  assert.equal(store.setTreeResearchProject(node.treeId, null).ok, true)
  assert.equal(store.getTree(node.treeId).researchProjectId, null)
  assert.equal(store.setTreeProfile(node.treeId, 'folder-b').ok, true)
  assert.equal(store.treeProfile(node.treeId), 'folder-b')
})

test('a malformed saved Research binding never reloads as an ordinary folder tree', () => {
  const { store } = fixture()
  root(store, PROJECT_A)
  const snapshot = store.snapshot()
  const damaged = {
    version: FLEET_TREES_RECORD_VERSION,
    computerId: snapshot.computerId,
    trees: snapshot.trees.map(tree => ({ ...tree, researchProjectId: 'rp-broken' })),
    nodes: snapshot.nodes,
  }
  assert.equal(parseFleetTrees(damaged, { computerId: snapshot.computerId }), EMPTY_FLEET_TREES)
  let writes = 0
  assert.throws(() => createFleetTreeStore({
    computerId: snapshot.computerId,
    storage: { read: () => damaged, write: () => { writes += 1; return true } },
  }), { code: 'MC_TREE_STORAGE_INVALID' })
  assert.equal(writes, 0, 'refusing a damaged binding must not overwrite its saved tree')
})

test('research project binding cannot change after a root or descendant starts or retains its session', () => {
  for (const state of ['starting', 'running', 'finished', 'interrupted']) {
    for (const descendant of [false, true]) {
      const { store, reopen } = fixture()
      const node = root(store, PROJECT_A)
      const started = descendant ? store.addNode({ parentId: node.id }).node : node
      start(store, started.id, state)
      const before = store.snapshot()
      for (const next of [PROJECT_B, null]) {
        assert.equal(store.setTreeResearchProject(node.treeId, next, 'Changed').ok, false, `${state} descendant=${descendant}`)
        assert.deepEqual(store.snapshot(), before)
      }
      assert.equal(store.setTreeResearchProject(node.treeId, PROJECT_A, 'Lean Bench').ok, true, 'same binding remains a no-op')
      assert.deepEqual(reopen().getTree(node.treeId), store.getTree(node.treeId))
      assert.equal(reopen().getNode(started.id).sessionId, store.getNode(started.id).sessionId)
    }
  }
})

test('detaching a branch preserves its Research project for every descendant and after reload', () => {
  const { store, reopen } = fixture()
  const parent = root(store, PROJECT_A)
  const child = store.addNode({ parentId: parent.id, role: 'worker' }).node
  const leaf = store.addNode({ parentId: child.id, role: 'reviewer' }).node
  start(store, leaf.id)
  const detached = store.detachToNewTree(child.id)
  assert.equal(detached.ok, true)
  assert.notEqual(detached.treeId, parent.treeId)
  for (const id of [child.id, leaf.id]) assert.equal(store.getNode(id).treeId, detached.treeId)
  assert.equal(store.getNode(child.id).parentId, null)
  assert.equal(store.getNode(leaf.id).parentId, child.id)
  const tree = store.getTree(detached.treeId)
  assert.equal(tree.researchProjectId, PROJECT_A)
  assert.equal(tree.researchProjectName, 'Lean Bench')
  assert.equal(tree.profileId, null)
  assert.deepEqual(reopen().getTree(detached.treeId), tree)
  assert.equal(reopen().getNode(leaf.id).sessionId, `session-${leaf.id}`)
  assert.equal(store.getTree(parent.treeId).researchProjectId, PROJECT_A)
})

test('a draft branch may join another project before any of its agents has started', () => {
  const { store, reopen } = fixture()
  const source = root(store, PROJECT_A)
  const child = store.addNode({ parentId: source.id }).node
  const destination = root(store, PROJECT_B, 'Replication')
  assert.ok(store.movePoints(source.id).some(point => point.parentId === destination.id))
  const moved = store.moveNode(source.id, destination.id)
  assert.equal(moved.ok, true)
  for (const id of [source.id, child.id]) assert.equal(store.getNode(id).treeId, destination.treeId)
  assert.equal(store.getTree(source.treeId), null)
  assert.equal(reopen().getTree(destination.treeId).researchProjectId, PROJECT_B)
})

test('started branches cannot be moved across Research project scopes', () => {
  for (const [from, to] of [[PROJECT_A, PROJECT_B], [PROJECT_A, null], [null, PROJECT_A]]) {
    for (const state of ['starting', 'running', 'finished']) {
      for (const startedDescendant of [false, true]) {
        const { store, reopen } = fixture()
        const source = root(store, from)
        const branchMember = startedDescendant ? store.addNode({ parentId: source.id }).node : source
        const destination = root(store, to)
        start(store, branchMember.id, state)
        const before = store.snapshot()
        const savedBefore = reopen().snapshot()
        assert.equal(store.movePoints(source.id).some(point => point.parentId === destination.id), false,
          `movePoints ${from} -> ${to}, ${state}, descendant=${startedDescendant}`)
        const moved = store.moveNode(source.id, destination.id)
        assert.equal(moved.ok, false, `${from} -> ${to}, ${state}, descendant=${startedDescendant}`)
        assert.match(moved.problems.join(' '), /research (project|workspace)/i)
        assert.deepEqual(store.snapshot(), before)
        assert.deepEqual(reopen().snapshot(), savedBefore)
      }
    }
  }
})

test('started branches may move within one Research project or between ordinary folder trees', () => {
  for (const projectId of [PROJECT_A, null]) {
    const { store, reopen } = fixture()
    const source = root(store, projectId)
    const child = store.addNode({ parentId: source.id }).node
    const destination = root(store, projectId)
    start(store, child.id, 'finished')
    assert.ok(store.movePoints(source.id).some(point => point.parentId === destination.id))
    assert.equal(store.moveNode(source.id, destination.id).ok, true)
    assert.equal(store.getNode(source.id).treeId, destination.treeId)
    assert.equal(store.getNode(child.id).treeId, destination.treeId)
    assert.equal(reopen().getNode(child.id).sessionId, `session-${child.id}`)
    assert.equal(store.getTree(destination.treeId).researchProjectId || null, projectId)
  }
})
