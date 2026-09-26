// Current reusable slots count every saved child, regardless of session state.
// New ordinary slots stop at four; legacy wider branches remain intact and
// their existing children can restart without allocating another slot.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  TREE_BOUNDS,
  createFleetTreeStore,
  fleetTreesStorageKey,
  parseFleetTrees,
  planNodeAdd,
  treeRecord,
} from '../../src/fleet-trees.js'
/* The experiment exemption's constants are read off the namespace so that a
   build without them fails these tests by assertion, not by a link error that
   takes the whole file down with it. */
import * as fleetTreesModule from '../../src/fleet-trees.js'

const COMPUTER = 'c1'
const STAMP = '2026-09-10T00:00:00.000Z'

function memoryStorage(seed = new Map()) {
  const cells = new Map(seed)
  return {
    cells,
    read(key) { return cells.has(key) ? JSON.parse(cells.get(key)) : null },
    write(key, value) { cells.set(key, JSON.stringify(value)); return true },
  }
}

function stamps() {
  let tick = 0
  return () => {
    tick += 1
    return `2026-09-11T00:00:${String(tick % 60).padStart(2, '0')}.${String(tick).padStart(3, '0')}Z`
  }
}

function counterIds() {
  let count = 0
  return kind => {
    count += 1
    return `${kind}-${count}`
  }
}

const storeOn = storage => createFleetTreeStore({ computerId: COMPUTER, storage, now: stamps(), makeId: counterIds() })

const liveChildren = (store, parentId) => store.snapshot().nodes
  .filter(node => node.parentId === parentId && (node.status === 'starting' || node.status === 'running'))

const accepted = (outcome, label) => {
  assert.equal(outcome?.ok, true, `${label}: ${(outcome?.problems || []).join(' ')}`)
  return outcome
}

test('a parent holds four reusable child slots and refuses a fifth addition or move', () => {
  const store = storeOn(memoryStorage())
  const parent = accepted(store.addNode({ role: 'manager' }), 'the parent').node
  const drafts = []
  for (let i = 0; i < 4; i += 1) {
    drafts.push(accepted(store.addNode({ parentId: parent.id, role: 'worker' }), `draft ${i + 1} (a saved draft occupies a slot)`).node)
  }
  for (let i = 0; i < 4; i += 1) accepted(store.setNodeStatus(drafts[i].id, 'starting'), `live child ${i + 1} of four`)

  const fifth = store.addNode({ parentId: parent.id, role: 'worker' })
  assert.equal(fifth.ok, false, 'a fifth saved child slot was admitted')
  assert.match(fifth.problems.join(' '), /4 of 4 direct child slots/)

  // Compose: the store's own admission and the pure plan the panel reads.
  assert.equal(store.addNode({ parentId: parent.id, role: 'worker' }).ok, false, 'compose under a full parent was admitted')
  const plan = planNodeAdd(treeRecord(store.snapshot(), parent.treeId), parent.id)
  assert.equal(plan.allowed, false)
  assert.match(plan.reason, /4 of 4 direct child slots/)

  // The "+" placeholders.
  assert.deepEqual(store.extensionPoints().filter(point => point.parentId === parent.id), [],
    'a "+" is offered as the fifth child')

  // Move, and the picker built from movePoints.
  const elsewhere = accepted(store.addNode({ role: 'elsewhere' }), 'another tree').node
  const spare = accepted(store.addNode({ parentId: elsewhere.id, role: 'spare' }), 'a spare').node
  accepted(store.setNodeStatus(spare.id, 'starting'), 'the spare is live')
  const moved = store.moveNode(spare.id, parent.id)
  assert.equal(moved.ok, false, 'a move built a fifth child')
  assert.match(moved.problems.join(' '), /4 of 4 direct child slots/)
  assert.equal(store.movePoints(spare.id).some(point => point.parentId === parent.id), false, 'a full parent is offered as a destination')

  // Ending a session preserves its slot. Restarting reuses it without adding one.
  accepted(store.detachSession(drafts[0].id), 'detach one live child')
  assert.equal(liveChildren(store, parent.id).length, 3)
  assert.equal(store.addNode({ parentId: parent.id, role: 'worker' }).ok, false)
  accepted(store.setNodeStatus(drafts[0].id, 'starting'), 'restart in the retained slot')
  assert.equal(liveChildren(store, parent.id).length, 4)

  // The bounds themselves, last so the behaviour above is what reports first.
  assert.deepEqual({ ...TREE_BOUNDS }, { maxChildren: 4, maxDepth: 3, maxEmptyTrees: 1 })
})

/* A tree as a live install saved it while the cap was eight:
   a controller, a manager with `running` live children plus two finished
   ones, and a second manager with room. The children sit at depth two, so
   one more level is still legal under each of them. */
function savedUnderTheOldCap({ running, finished = 2 }) {
  const node = (id, fields) => ({
    id, treeId: 'tree-wide', createdAt: STAMP, updatedAt: STAMP, role: 'worker', message: '',
    statusNote: '', sessionId: null, parentId: 'wide-parent', status: 'draft', ...fields,
  })
  const nodes = [
    node('wide-top', { role: 'controller', parentId: null, status: 'running', sessionId: 'session-top' }),
    node('wide-parent', { role: 'manager', parentId: 'wide-top', status: 'running', sessionId: 'session-parent' }),
    node('roomy-manager', { role: 'manager', parentId: 'wide-top', status: 'running', sessionId: 'session-roomy' }),
  ]
  for (let i = 0; i < running; i += 1) nodes.push(node(`wide-live-${i}`, { status: 'running', sessionId: `session-live-${i}` }))
  for (let i = 0; i < finished; i += 1) nodes.push(node(`wide-done-${i}`, { status: 'finished', sessionId: `session-done-${i}` }))
  return {
    version: 1, computerId: COMPUTER,
    trees: [{ id: 'tree-wide', name: null, createdAt: STAMP, updatedAt: STAMP, profileId: null }],
    nodes,
  }
}

for (const running of [8, 14]) {
  test(`a tree saved with ${running} live children under one parent loads, offers, resumes, moves and saves`, () => {
    const key = fleetTreesStorageKey(COMPUTER)
    const storage = memoryStorage(new Map([[key, JSON.stringify(savedUnderTheOldCap({ running }))]]))
    const total = 3 + running + 2

    // Loads: nothing is dropped and nothing is refused. `running` comes back
    // `starting` -- nothing comes back off disk running -- which is still live.
    const store = storeOn(storage)
    assert.equal(store.snapshot().nodes.length, total, 'every saved agent is on the tree')
    assert.equal(liveChildren(store, 'wide-parent').length, running, 'every saved live child is still live')

    // Offers: no "+" under the over-cap parent, the ordinary "+" everywhere else.
    const points = store.extensionPoints()
    assert.equal(points.some(point => point.parentId === 'wide-parent'), false, 'a "+" is offered under an over-cap parent')
    assert.ok(points.some(point => point.parentId === 'roomy-manager'), 'a parent with room lost its "+"')
    assert.ok(points.some(point => point.parentId === 'wide-live-0'), 'an over-cap parent\'s child lost its own "+"')

    // Resumes: each live child settles starting -> running, and a live child's
    // note can change, without a single refusal. These claim no NEW seat.
    for (let i = 0; i < running; i += 1) accepted(store.setNodeStatus(`wide-live-${i}`, 'running'), `live child ${i + 1} resumes`)
    accepted(store.setNodeStatus('wide-live-1', 'running', { note: 'Still working.' }), 'a live child\'s note changes')

    // Restarting an existing finished child reuses its saved slot. New slots refuse.
    accepted(store.setNodeStatus('wide-done-0', 'running'), 'restart the existing finished child')
    accepted(store.setNodeStatus('wide-done-0', 'finished'), 'finish the reused child')
    const claim = store.addNode({ parentId: 'wide-parent', role: 'worker' })
    assert.equal(claim.ok, false, 'a new saved slot was granted under an over-cap parent')
    assert.match(claim.problems.join(' '), new RegExp(`${running + 2} of 4 direct child slots`))
    const plan = planNodeAdd(treeRecord(store.snapshot(), 'tree-wide'), 'wide-parent')
    assert.equal(plan.allowed, false)
    assert.match(plan.reason, new RegExp(`${running + 2} of 4 direct child slots`))

    // Moves: one live child leaves for a parent with room, and the over-cap
    // parent then moves with every child it still holds.
    accepted(store.moveNode('wide-live-0', 'wide-top'), 'a live child moves out to a parent with room')
    accepted(store.moveNode('wide-parent', 'roomy-manager'), 'the over-cap parent moves with its branch')
    assert.equal(store.getNode('wide-parent').parentId, 'roomy-manager')
    assert.equal(store.childrenOf('wide-parent').length, running - 1 + 2, 'the branch arrived whole')
    assert.ok(store.movePoints('wide-done-1').some(point => point.parentId === 'wide-top'), 'the move picker still offers a parent with room')
    assert.equal(store.movePoints('wide-live-0').some(point => point.parentId === 'wide-parent'), false,
      'the move picker offers the over-cap parent')

    // Finishing children never erases their saved slots or their assignments.
    for (let index = 1; index < running; index += 1) {
      accepted(store.setNodeStatus(`wide-live-${index}`, 'finished'), `finish child ${index + 1}`)
      assert.equal(store.addNode({ parentId: 'wide-parent', role: 'worker' }).ok, false)
    }
    accepted(store.setNodeStatus('wide-done-0', 'running'), 'a finished child may reuse its slot')
    accepted(store.setNodeStatus('wide-done-1', 'running'), 'another finished child may reuse its slot')
    assert.equal(store.childrenOf('wide-parent').length, running + 1, 'all legacy slots remain')

    // Saves: the record on disk reads back whole.
    const saved = parseFleetTrees(storage.cells.get(key), { computerId: COMPUTER })
    assert.equal(saved.nodes.length, total, 'the saved record lost agents')
    assert.equal(store.snapshot().persistenceFailed, false)
  })
}

/* THE ONE EXEMPTION, AND HOW NARROW IT IS. Loops and grids do not need to be
   tied together or to any of this. A research grid
   run locally builds its own tree and marks it `kind: 'experiment'` when it
   mints it; that tree seats the engine's eight under one parent, as every tree
   did before the agent-tree width fell to four. The mark is an explicit field,
   given only to a NEW tree, and only that one value is kept. */
test('a tree marked as an experiment seats eight under one parent; agent trees beside it stay four', () => {
  assert.equal(fleetTreesModule.EXPERIMENT_TREE_KIND, 'experiment')
  assert.equal(fleetTreesModule.EXPERIMENT_TREE_MAX_CHILDREN, 8)
  const storage = memoryStorage()
  const store = storeOn(storage)

  // The mark is explicit and narrow: one known value, and only on a new tree.
  assert.equal(store.addNode({ role: 'helper', treeKind: 'grid' }).ok, false, 'an unknown tree kind was accepted')
  const agentTop = accepted(store.addNode({ role: 'manager' }), 'an agent tree').node
  assert.equal(store.addNode({ parentId: agentTop.id, role: 'worker', treeKind: 'experiment' }).ok, false,
    'a kind was granted to a tree that already exists')
  const root = accepted(store.addNode({ role: 'helper', treeKind: 'experiment' }), 'an experiment tree').node
  assert.equal(store.listTrees().find(tree => tree.id === root.treeId).kind, 'experiment')
  assert.equal(Object.hasOwn(store.listTrees().find(tree => tree.id === agentTop.treeId), 'kind'), false,
    'an ordinary tree grew a kind field')

  // Eight live cells under the experiment root, the way the grid starts them.
  const cells = []
  for (let i = 0; i < 8; i += 1) {
    const cell = accepted(store.addNode({ parentId: root.id, role: 'helper' }), `experiment child ${i + 1}`).node
    accepted(store.attachSession(cell.id, `cell-session-${i}`), `experiment child ${i + 1} live`)
    cells.push(cell)
  }
  assert.equal(liveChildren(store, root.id).length, 8)
  const ninth = store.addNode({ parentId: root.id, role: 'helper' })
  assert.equal(ninth.ok, false, 'a ninth live child was admitted: the engine backstop is eight')
  assert.match(ninth.problems.join(' '), /8 of 8 direct child slots/)
  assert.equal(store.extensionPoints().some(point => point.parentId === root.id), false, 'a "+" was offered past eight')
  assert.equal(planNodeAdd(treeRecord(store.snapshot(), root.treeId), root.id).allowed, false)

  // A finished experiment cell keeps its reusable slot.
  accepted(store.setNodeStatus(cells[0].id, 'finished'), 'one cell finishes')
  assert.equal(store.extensionPoints().some(point => point.parentId === root.id), false)
  assert.equal(planNodeAdd(treeRecord(store.snapshot(), root.treeId), root.id).allowed, false)
  accepted(store.setNodeStatus(cells[0].id, 'starting'), 'restart within the same experiment slot')

  // The agent tree beside it still seats four and refuses the fifth everywhere.
  const workers = []
  for (let i = 0; i < 4; i += 1) workers.push(accepted(store.addNode({ parentId: agentTop.id, role: 'worker' }), `draft ${i + 1}`).node)
  for (let i = 0; i < 4; i += 1) accepted(store.setNodeStatus(workers[i].id, 'starting'), `agent child ${i + 1} of four`)
  assert.equal(store.addNode({ parentId: agentTop.id, role: 'worker' }).ok, false, 'an agent tree admitted a fifth saved slot')
  assert.equal(store.extensionPoints().some(point => point.parentId === agentTop.id), false)

  // Borrowing the exemption by moving does not work: the destination's width rules.
  assert.equal(store.moveNode(cells[1].id, agentTop.id).ok, false, 'a live cell moved in as an agent tree\'s fifth child')
  assert.equal(store.movePoints(cells[1].id).some(point => point.parentId === agentTop.id), false)

  // The mark survives a save and a reload; an unknown kind reads as an agent tree.
  const key = fleetTreesStorageKey(COMPUTER)
  const saved = JSON.parse(storage.cells.get(key))
  assert.equal(saved.trees.find(tree => tree.id === root.treeId).kind, 'experiment')
  const reread = parseFleetTrees(storage.cells.get(key), { computerId: COMPUTER })
  assert.equal(reread.trees.find(tree => tree.id === root.treeId).kind, 'experiment')
  saved.trees.find(tree => tree.id === root.treeId).kind = 'grid'
  const unknown = parseFleetTrees(JSON.stringify(saved), { computerId: COMPUTER })
  assert.equal(unknown.nodes.length, reread.nodes.length, 'an unknown kind poisoned the record')
  assert.equal(Object.hasOwn(unknown.trees.find(tree => tree.id === root.treeId), 'kind'), false, 'an unknown kind was kept')
})
