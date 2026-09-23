// The rules behind the trees a person builds by pressing empty placeholders.
//
// Three of these assertions are the ones worth reading twice, because they are
// the ones a future change is most likely to break while everything still looks
// right on screen:
//
//   1. A new store on a fresh computer holds NOTHING. The owner's first
//      sentence about this surface is that the tree is empty until he has
//      started something, and seed data is the kind of helpfulness that shows a
//      person a structure they did not build.
//   2. Saved state that is broken in any way reads back as NO trees, never as
//      the readable half. A dropped parent silently promotes a child to the top
//      of a tree, which is a structure nobody drew being shown as one they did.
//   3. A node is a DRAFT before any session exists, and running means there IS
//      a session id. Those two facts are what every screen reading this state
//      acts on.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  EMPTY_FLEET_TREES,
  FLEET_TREES_RECORD_VERSION,
  FLEET_TREE_LIMITS,
  NODE_REMOVE_REFUSALS,
  NODE_STATUSES,
  NODE_STATUS_UNREADABLE,
  SAVED_STATUS,
  TREE_BOUNDS,
  createFleetTreeStore,
  displayName,
  fleetTreesStorageKey,
  nodeDisplayName,
  nodeNamesByKey,
  nodeSavedForm,
  parseFleetTrees,
  savedNodeStatus,
  planNodeAdd,
  planTreeAdd,
  planTreeRemove,
  safeTreeStorage,
  seatShortageSentence,
  treeRecord,
  treeStatus,
} from '../../src/fleet-trees.js'
import { NODE_STATUS_WORDS } from '../../src/fleet-tree-copy.js'
import { nodeIsBusy, treeNodeClock } from '../../src/tree-session-liveness.js'

const COMPUTER = 'c1'

/* A storage seam with no disk behind it. This is the whole point of the seam:
   every rule below is exercised without a browser, a file, or a temp folder. */
function memoryStorage(seed = new Map()) {
  const cells = new Map(seed)
  return {
    cells,
    read(key) { return cells.has(key) ? JSON.parse(cells.get(key)) : null },
    write(key, value) { cells.set(key, JSON.stringify(value)); return true },
  }
}

const failingStorage = () => ({ read: () => null, write: () => false })

function stamps() {
  let tick = 0
  return () => {
    tick += 1
    return `2026-08-12T00:00:${String(tick).padStart(2, '0')}.000Z`
  }
}

function counterIds() {
  let count = 0
  return kind => {
    count += 1
    return `${kind}-${count}`
  }
}

const storeOf = (overrides = {}) => createFleetTreeStore({
  computerId: COMPUTER,
  storage: memoryStorage(),
  now: stamps(),
  makeId: counterIds(),
  ...overrides,
})

test('cancelled outcome and its native turn identity survive reopening the saved forest', () => {
  const storage = memoryStorage()
  const store = storeOf({ storage })
  const node = store.addNode({ role: 'reviewer', message: 'Review this' }).node
  assert.equal(store.setNodeStatus(node.id, 'cancelled', { note: 'This turn ended without finishing.', turnId: 'native-turn-1' }).ok, true)
  const restored = storeOf({ storage }).getNode(node.id)
  assert.equal(restored.status, 'cancelled')
  assert.equal(restored.lastTurnId, 'native-turn-1')
  assert.equal(store.setNodeStatus(node.id, 'cancelled', { turnId: 'bad\nturn' }).ok, false)
  assert.equal(storeOf({ storage }).getNode(node.id).lastTurnId, 'native-turn-1')
})

test('a reserved child identity is preserved and collisions refuse without replacing a node', () => {
  const store = storeOf()
  const parent = store.addNode({ role: 'manager' })
  assert.equal(parent.ok, true)
  const child = store.addNode({ parentId: parent.node.id, role: 'worker', reservedNodeId: 'node-reserved-scope' })
  assert.equal(child.ok, true)
  assert.equal(child.node.id, 'node-reserved-scope')
  assert.equal(store.addNode({ parentId: parent.node.id, reservedNodeId: child.node.id }).ok, false)
  assert.equal(store.getNode(child.node.id), child.node)
  assert.equal(store.addNode({ parentId: parent.node.id, reservedNodeId: '../not a safe id' }).ok, false)
})

test('a replacement session cannot inherit the previous session completed-turn identity', () => {
  const store = storeOf()
  const node = store.addNode({ role: 'reviewer' }).node
  store.attachSession(node.id, 'previous-session')
  store.setNodeStatus(node.id, 'interrupted', { note: 'Stopped by you.', turnId: 'reused-turn' })
  store.attachSession(node.id, 'previous-session')
  assert.equal(store.getNode(node.id).lastTurnId, 'reused-turn')
  store.attachSession(node.id, 'replacement-session')
  assert.equal(store.getNode(node.id).lastTurnId, null)
})

function record(overrides = {}) {
  return {
    version: FLEET_TREES_RECORD_VERSION,
    computerId: COMPUTER,
    trees: [{ id: 'tree-1', name: 'Front desk', createdAt: 'a', updatedAt: 'a' }],
    nodes: [{
      id: 'node-1', treeId: 'tree-1', parentId: null, role: 'planner', message: 'plan it',
      status: 'draft', statusNote: '', sessionId: null, createdAt: 'a', updatedAt: 'a',
    }],
    ...overrides,
  }
}

/* --------------------------------------------------------------- constants */

test('the storage key names the computer the trees belong to', () => {
  assert.notEqual(fleetTreesStorageKey('c1'), fleetTreesStorageKey('c2'))
  assert.ok(fleetTreesStorageKey('c1').includes('c1'))
})

test('the states are fixed and frozen', () => {
  /* 'turn-failed' joined 2026-08-19: a TURN that ended badly on a session that
     really ran, distinct from 'failed' (a START that never happened) so the
     chip cannot un-say a start the signed record shows.
     'interrupted' joined the same day: a not-successful completion the PERSON
     asked for — recorded when this window's interrupt was accepted, consumed
     per turn — so a deliberate stop stops reading "the last turn failed". */
  assert.deepEqual([...NODE_STATUSES], ['draft', 'starting', 'running', 'finished', 'failed', 'turn-failed', 'interrupted', 'cancelled'])
  assert.ok(Object.isFrozen(NODE_STATUSES))
  assert.ok(Object.isFrozen(FLEET_TREE_LIMITS))
  assert.equal(FLEET_TREES_RECORD_VERSION, 1)
})

test('empty means empty, and cannot be edited by a caller', () => {
  assert.equal(EMPTY_FLEET_TREES.trees.length, 0)
  assert.equal(EMPTY_FLEET_TREES.nodes.length, 0)
  assert.equal(EMPTY_FLEET_TREES.computerId, null)
  assert.ok(Object.isFrozen(EMPTY_FLEET_TREES))
  assert.throws(() => { EMPTY_FLEET_TREES.trees.push({}) })
})

/* ----------------------------------------------------------- storage seam */

test('the storage face survives a backing that throws', () => {
  const throwing = safeTreeStorage({
    getItem() { throw new Error('private mode') },
    setItem() { throw new Error('quota') },
  })
  assert.equal(throwing.read('k'), null)
  assert.equal(throwing.write('k', { a: 1 }), false)

  const cells = new Map()
  const working = safeTreeStorage({
    getItem: key => (cells.has(key) ? cells.get(key) : null),
    setItem: (key, value) => cells.set(key, value),
  })
  assert.equal(working.read('k'), null)
  assert.equal(working.write('k', { a: 1 }), true)
  assert.deepEqual(working.read('k'), { a: 1 })

  cells.set('bad', '{not json')
  assert.equal(working.read('bad'), null)
})

/* ------------------------------------------------------- reading saved state */

test('a good record reads back whole, from an object or from text', () => {
  const fromObject = parseFleetTrees(record(), { computerId: COMPUTER })
  assert.equal(fromObject.trees.length, 1)
  assert.equal(fromObject.nodes[0].status, 'draft')
  assert.equal(fromObject.nodes[0].effort, '', 'records from before effort was stored remain readable')
  assert.ok(Object.isFrozen(fromObject.nodes[0]))

  const fromText = parseFleetTrees(JSON.stringify(record()), { computerId: COMPUTER })
  assert.deepEqual(fromText.nodes, fromObject.nodes)
})

test('anything unreadable means no trees at all', () => {
  const cases = [
    ['nothing saved', null],
    ['not an object', 42],
    ['a list', []],
    ['text that is not data', '{oh no'],
    ['a version this build does not write', record({ version: 99 })],
    ['no computer named', record({ computerId: null })],
    ['a tree with no name', record({ trees: [{ id: 'tree-1', name: '  ', createdAt: 'a', updatedAt: 'a' }] })],
    ['a tree with no time on it', record({ trees: [{ id: 'tree-1', name: 'x', createdAt: '', updatedAt: 'a' }] })],
  ]
  for (const [why, value] of cases) {
    assert.equal(parseFleetTrees(value, { computerId: COMPUTER }), EMPTY_FLEET_TREES, why)
  }
})

test('a record from another computer is not adopted', () => {
  assert.equal(parseFleetTrees(record({ computerId: 'c2' }), { computerId: COMPUTER }), EMPTY_FLEET_TREES)
  assert.equal(parseFleetTrees(record({ computerId: 'c2' })).computerId, 'c2')
})

test('one broken agent throws away the whole file, never half of it', () => {
  const orphan = record({
    nodes: [
      { id: 'node-1', treeId: 'tree-1', parentId: null, role: '', message: '', status: 'draft', statusNote: '', sessionId: null, createdAt: 'a', updatedAt: 'a' },
      { id: 'node-2', treeId: 'tree-1', parentId: 'node-gone', role: '', message: '', status: 'draft', statusNote: '', sessionId: null, createdAt: 'a', updatedAt: 'a' },
    ],
  })
  // The readable half is one perfectly good top agent. It is still refused.
  assert.equal(parseFleetTrees(orphan, { computerId: COMPUTER }), EMPTY_FLEET_TREES)
})

test('the invariants are checked on the way in', () => {
  const node = extra => ({
    id: 'node-1', treeId: 'tree-1', parentId: null, role: '', message: '',
    status: 'draft', statusNote: '', sessionId: null, createdAt: 'a', updatedAt: 'a', ...extra,
  })
  const second = extra => node({ id: 'node-2', ...extra })
  const trees = [
    { id: 'tree-1', name: 'One', createdAt: 'a', updatedAt: 'a' },
    { id: 'tree-2', name: 'Two', createdAt: 'a', updatedAt: 'a' },
  ]
  const cases = [
    ['an id used twice', record({ nodes: [node(), node()] })],
    ['a tree and an agent sharing an id', record({ nodes: [node({ id: 'tree-1' })] })],
    ['an agent in a tree that is not there', record({ nodes: [node({ treeId: 'tree-9' })] })],
    ['two tops in one tree', record({ nodes: [node(), second()] })],
    ['a parent in another tree', record({
      trees,
      nodes: [node(), second({ treeId: 'tree-2', parentId: 'node-1' })],
    })],
    ['a loop', record({ nodes: [node({ parentId: 'node-2' }), second({ parentId: 'node-1' })] })],
    ['running with no session', record({ nodes: [node({ status: 'running' })] })],
    ['a draft holding a session', record({ nodes: [node({ sessionId: 'run-1' })] })],
    ['two agents on one session', record({
      nodes: [node({ status: 'finished', sessionId: 'run-1' }), second({ status: 'finished', sessionId: 'run-1' })],
    })],
  ]
  for (const [why, value] of cases) {
    assert.equal(parseFleetTrees(value, { computerId: COMPUTER }), EMPTY_FLEET_TREES, why)
  }
})

/* ------------------------------------------- a status this build cannot read */

/* T162, ruled 2026-09-19: a status word this build does not know is NOT a
   broken record. The case used to sit in the list above as 'a state this build
   does not know' -> EMPTY_FLEET_TREES, and that rule emptied the owner's whole
   canvas over one word in one row (measured: 3 trees -> 0 trees). The node is
   kept under one named marker, holds no seat, and goes back to disk with the
   word it came with. */

const threeTrees = badStatus => ({
  version: FLEET_TREES_RECORD_VERSION,
  computerId: COMPUTER,
  trees: ['tree-1', 'tree-2', 'tree-3'].map(id => ({ id, name: null, createdAt: 'a', updatedAt: 'a' })),
  nodes: [
    { id: 'node-1', treeId: 'tree-1', parentId: null, role: 'planner', message: 'plan it', status: 'running', statusNote: '', sessionId: 'session-1', createdAt: 'a', updatedAt: 'a' },
    { id: 'node-2', treeId: 'tree-2', parentId: null, role: 'planner', message: 'plan it', status: 'finished', statusNote: '', sessionId: 'session-2', createdAt: 'a', updatedAt: 'a' },
    { id: 'node-3', treeId: 'tree-3', parentId: null, role: 'planner', message: 'plan it', status: badStatus, statusNote: '', sessionId: 'session-3', createdAt: 'a', updatedAt: 'a' },
    { id: 'node-4', treeId: 'tree-3', parentId: 'node-3', role: 'worker', message: 'do it', status: 'draft', statusNote: '', sessionId: null, createdAt: 'a', updatedAt: 'a' },
  ],
})

test('a status word this build does not know keeps every tree and every node', () => {
  for (const unknown of ['paused', 'running-v2', '', 'RUNNING', 'unreadable']) {
    const read = parseFleetTrees(threeTrees(unknown), { computerId: COMPUTER })
    assert.notEqual(read, EMPTY_FLEET_TREES, `status ${JSON.stringify(unknown)} emptied the store`)
    assert.equal(read.trees.length, 3, `status ${JSON.stringify(unknown)} lost a tree`)
    assert.equal(read.nodes.length, 4, `status ${JSON.stringify(unknown)} lost a node`)
    const marked = read.nodes.find(node => node.id === 'node-3')
    assert.equal(marked.status, NODE_STATUS_UNREADABLE, 'the node reads as the one named marker')
    assert.equal(savedNodeStatus(marked), unknown, 'the word it was saved with is kept beside the marker')
    assert.equal(marked.sessionId, 'session-3', 'the session handle is kept too')
    assert.equal(read.nodes.find(node => node.id === 'node-4').parentId, 'node-3',
      'its child still reports to it -- nothing was promoted to a second top')
    /* The other rows read exactly as they always did. */
    assert.equal(read.nodes.find(node => node.id === 'node-1').status, 'starting')
    assert.equal(read.nodes.find(node => node.id === 'node-2').status, 'finished')
  }
  /* And the marker is not a word a writer may set. */
  assert.equal(NODE_STATUSES.includes(NODE_STATUS_UNREADABLE), false)
  const store = storeOf()
  const node = store.addNode({ role: 'planner' }).node
  assert.equal(store.setNodeStatus(node.id, NODE_STATUS_UNREADABLE).ok, false,
    'only the reader may find a state unreadable; no writer may declare it')
})

test('the structural rules are not relaxed for a node with an unknown status', () => {
  const orphaned = threeTrees('paused')
  orphaned.nodes[2].parentId = 'node-gone'
  assert.equal(parseFleetTrees(orphaned, { computerId: COMPUTER }), EMPTY_FLEET_TREES,
    'an unknown status over a missing parent is still a broken record')
  const twoTops = threeTrees('paused')
  twoTops.nodes[3].parentId = null
  assert.equal(parseFleetTrees(twoTops, { computerId: COMPUTER }), EMPTY_FLEET_TREES,
    'an unknown status does not buy a tree a second top')
  const sharedSession = threeTrees('paused')
  sharedSession.nodes[2].sessionId = 'session-2'
  assert.equal(parseFleetTrees(sharedSession, { computerId: COMPUTER }), EMPTY_FLEET_TREES,
    'an unknown status does not let two agents hold one session')
})

test('an unreadable status is not a live run but retains its reusable slot', () => {
  const read = parseFleetTrees(threeTrees('paused'), { computerId: COMPUTER })
  const marked = read.nodes.find(node => node.id === 'node-3')
  assert.equal(nodeIsBusy(marked, new Set(['session-3'])), false,
    'even over a session this run owns, an unreadable state is not busy')
  const clock = treeNodeClock(marked, new Set(['session-3']))
  assert.equal(clock.running, false)
  assert.equal(clock.terminal, false, 'it is not finished either: the build does not know')
  assert.equal(typeof NODE_STATUS_WORDS[NODE_STATUS_UNREADABLE], 'string')
  assert.ok(NODE_STATUS_WORDS[NODE_STATUS_UNREADABLE].length > 0, 'the chip has a word of its own for it')
  assert.notEqual(NODE_STATUS_WORDS[NODE_STATUS_UNREADABLE], NODE_STATUS_WORDS.draft,
    'and that word is not the draft fallthrough')

  // Unknown statuses retain their structural slots without claiming live runs.
  const nodes = [{ id: 'top', treeId: 'tree-1', parentId: null, role: 'top', message: 'lead', status: 'finished', statusNote: '', sessionId: 'session-top', createdAt: 'a', updatedAt: 'a' }]
  for (let index = 1; index <= TREE_BOUNDS.maxChildren; index += 1) {
    nodes.push({ id: `kid-${index}`, treeId: 'tree-1', parentId: 'top', role: 'worker', message: 'work', status: 'paused', statusNote: '', sessionId: `session-kid-${index}`, createdAt: 'a', updatedAt: 'a' })
  }
  const storage = memoryStorage(new Map([[fleetTreesStorageKey(COMPUTER), JSON.stringify(record({ nodes }))]]))
  const store = storeOf({ storage })
  assert.equal(store.snapshot().nodes.length, TREE_BOUNDS.maxChildren + 1, 'the store opened the whole forest')
  const fresh = store.addNode({ parentId: 'top', role: 'worker' })
  assert.equal(fresh.ok, false, 'all child slots remain occupied by retained records')
  /* Removable: "Stop this agent first." would ask for the impossible. */
  assert.equal(store.removeNode('kid-1').ok, true, 'an unreadable node is not a run to be stopped first')
  assert.equal(store.addNode({ parentId: 'top', role: 'worker' }).ok, true, 'explicit removal frees the slot')
})

test('the original status word is written back unchanged, through both save seams', () => {
  const key = fleetTreesStorageKey(COMPUTER)
  const saved = JSON.stringify(threeTrees('paused'))
  /* Seam one: { read, write } whole-object. */
  const whole = memoryStorage(new Map([[key, saved]]))
  const wholeStore = storeOf({ storage: whole })
  assert.equal(wholeStore.getNode('node-3').status, NODE_STATUS_UNREADABLE)
  /* A write that does not touch the marker node -- a reply on another node --
     rewrites the whole record; node-3 must go back with 'paused', not with
     the marker and not with a field this build invented. */
  assert.equal(wholeStore.setNodeReply('node-2', 'done').ok, true)
  const wholeWritten = JSON.parse(whole.cells.get(key)).nodes.find(node => node.id === 'node-3')
  assert.equal(wholeWritten.status, 'paused', 'the original word is what reached the disk')
  assert.equal(JSON.stringify(wholeWritten).includes(NODE_STATUS_UNREADABLE), false,
    'the marker never leaks into the record under any key')
  /* A write ON the marker node that does not set its status keeps the word. */
  assert.equal(wholeStore.markPromptedByPerson('node-3').ok, true)
  assert.equal(JSON.parse(whole.cells.get(key)).nodes.find(node => node.id === 'node-3').status, 'paused')
  assert.equal(wholeStore.getNode('node-3').promptedByPerson, true)
  /* And it reads back as the marker again on the next open: the round trip is
     stable, not a one-shot. */
  const reopened = storeOf({ storage: whole })
  assert.equal(reopened.getNode('node-3').status, NODE_STATUS_UNREADABLE)
  assert.equal(savedNodeStatus(reopened.getNode('node-3')), 'paused')

  /* Seam two: the raw-text writeText door safeTreeStorage offers. Same bytes. */
  const cells = new Map([[key, saved]])
  const text = safeTreeStorage({ getItem: k => (cells.has(k) ? cells.get(k) : null), setItem: (k, v) => cells.set(k, v) })
  const textStore = storeOf({ storage: text })
  assert.equal(textStore.setNodeReply('node-2', 'done').ok, true)
  assert.equal(textStore.markPromptedByPerson('node-3').ok, true)
  assert.equal(cells.get(key), whole.cells.get(key), 'both seams wrote the same bytes')
  assert.equal(JSON.parse(cells.get(key)).nodes.find(node => node.id === 'node-3').status, 'paused')

  /* A known status written over the marker replaces the word: this build now
     knows the state, and the unread word is history. */
  assert.equal(textStore.setNodeStatus('node-3', 'finished').ok, true)
  const settled = textStore.getNode('node-3')
  assert.equal(settled.status, 'finished')
  assert.equal(savedNodeStatus(settled), 'finished')
  assert.equal(Object.hasOwn(settled, SAVED_STATUS), false, 'the saved word is dropped with the marker')
  assert.equal(JSON.parse(cells.get(key)).nodes.find(node => node.id === 'node-3').status, 'finished')
})

test('nodeSavedForm is identity for a readable node and a status-only copy for a marker', () => {
  const read = parseFleetTrees(threeTrees('paused'), { computerId: COMPUTER })
  const plain = read.nodes.find(node => node.id === 'node-2')
  assert.equal(nodeSavedForm(plain), plain, 'an ordinary node keeps its identity, so the save memo still keys on it')
  const marked = read.nodes.find(node => node.id === 'node-3')
  const form = nodeSavedForm(marked)
  assert.notEqual(form, marked)
  assert.equal(form.status, 'paused')
  assert.equal(Object.hasOwn(form, SAVED_STATUS), false)
  const { status: markedStatus, [SAVED_STATUS]: word, ...markedRest } = marked
  const { status: formStatus, ...formRest } = form
  assert.deepEqual(formRest, markedRest, 'nothing but the status word differs')
})

/* ---------------------------------------------------------------- the store */

test('a store cannot be built without a computer and a place to save', () => {
  assert.throws(() => createFleetTreeStore({ storage: memoryStorage() }), TypeError)
  assert.throws(() => createFleetTreeStore({ computerId: COMPUTER }), TypeError)
  assert.throws(() => createFleetTreeStore({ computerId: 'not an id!', storage: memoryStorage() }), TypeError)
})

test('a fresh computer holds nothing at all', () => {
  const store = storeOf()
  assert.deepEqual([...store.listTrees()], [])
  assert.deepEqual([...store.snapshot().nodes], [])
  assert.equal(store.snapshot().computerId, COMPUTER)
})

test('trees are made, renamed and removed by name', () => {
  const store = storeOf()
  const made = store.createTree({ name: 'Support' })
  assert.equal(made.ok, true)
  assert.equal(store.getTree(made.tree.id).name, 'Support')
  assert.equal(store.listTrees().length, 1)

  // One empty tree at a time. A second blank page is not a second structure.
  const tooSoon = store.createTree({ name: 'Research' })
  assert.equal(tooSoon.ok, false)
  assert.ok(tooSoon.problems.join(' ').includes('Support'), 'the refusal names the one they already have')
  store.addNode({ treeId: made.tree.id, role: 'manager', message: 'Ship the installer' })

  const unnamed = store.createTree({})
  assert.equal(unnamed.ok, true, 'a tree nobody has typed into yet has no name of its own')
  assert.equal(unnamed.tree.name, null)
  assert.equal(store.removeTree(unnamed.tree.id).ok, true)
  assert.equal(store.createTree({ name: 'x'.repeat(FLEET_TREE_LIMITS.maxNameChars + 1) }).ok, false)

  assert.equal(store.renameTree(made.tree.id, 'Support desk').ok, true)
  assert.equal(store.getTree(made.tree.id).name, 'Support desk')
  assert.equal(store.renameTree(made.tree.id, '  ').ok, true, 'clearing a name goes back to the derived one')
  assert.equal(store.getTree(made.tree.id).name, null)
  store.renameTree(made.tree.id, 'Support desk')
  assert.equal(store.renameTree('tree-nope', 'x').ok, false)

  const second = store.createTree({ name: 'Research' })
  assert.equal(second.ok, true)
  assert.equal(store.listTrees().length, 2, 'one computer may hold more than one tree')

  const removed = store.removeTree(second.tree.id)
  assert.equal(removed.ok, true)
  assert.equal(store.getTree(second.tree.id), null)
  assert.equal(store.removeTree(second.tree.id).ok, false)
})

test('a new agent is a draft with no session, wherever it was added', () => {
  const store = storeOf()
  const first = store.addNode({ role: 'planner', message: 'sketch the release' })
  assert.equal(first.ok, true)
  assert.equal(first.node.status, 'draft')
  assert.equal(first.node.sessionId, null)
  assert.equal(first.node.parentId, null)
  assert.equal(store.getTree(first.node.treeId).name, null, 'nothing is named on the person\'s behalf')
  assert.equal(store.treeLabel(first.node.treeId), 'sketch the release', 'the first message is the name')

  // The owner's flow: press the placeholder first, fill the panel in second.
  const blank = store.addNode({ parentId: first.node.id })
  assert.equal(blank.node.role, '')
  assert.equal(blank.node.message, '')
  assert.equal(blank.node.status, 'draft')
  assert.equal(blank.node.treeId, first.node.treeId)
})

test('an agent is added under a parent, at the top of a tree, or in a new one', () => {
  const store = storeOf()
  const tree = store.createTree({ name: 'Ops' })
  const top = store.addNode({ treeId: tree.tree.id, role: 'manager' })
  assert.equal(top.node.parentId, null)
  assert.equal(store.rootOf(tree.tree.id).id, top.node.id)

  const child = store.addNode({ parentId: top.node.id, role: 'worker' })
  assert.equal(child.node.parentId, top.node.id)
  assert.equal(store.childrenOf(top.node.id).length, 1)
  assert.equal(store.listNodes(tree.tree.id).length, 2)
  assert.equal(store.getNode(child.node.id).role, 'worker')

  assert.equal(store.addNode({ treeId: tree.tree.id }).ok, false, 'a tree has one top agent')
  assert.equal(store.addNode({ treeId: 'tree-nope' }).ok, false)
  assert.equal(store.addNode({ parentId: 'node-nope' }).ok, false)

  const other = store.createTree({ name: 'Other' })
  assert.equal(store.addNode({ treeId: other.tree.id, parentId: top.node.id }).ok, false, 'a parent and a tree that disagree')
  assert.equal(store.addNode({ role: 'x'.repeat(FLEET_TREE_LIMITS.maxRoleChars + 1) }).ok, false)
  assert.equal(store.addNode({ message: 'x'.repeat(FLEET_TREE_LIMITS.maxMessageChars + 1) }).ok, false)
})

/* PINNED AT 12,000, NOT MERELY "SOME NUMBER OVER 4,000". MEASURED 2026-09-03
 * (REPORT-controller-2-tree-spawn-regression-20260903.md): this is the same
 * ceiling engine/src/lib/tool-registry.js's MAX_TREE_BRIEF_CHARS enforces for
 * a create-and-start-node brief BEFORE anything is drawn, and the two "MUST
 * move together" by that file's own comment -- a brief the engine accepts and
 * this store then refuses is a circle that appears and cannot be saved. This
 * pins the actual value, not just the +1-over-whatever-it-is shape already
 * asserted above, so a change back toward 4,000 fails here even though the
 * relative test still would not. */
test('the message ceiling matches the engine\'s MAX_TREE_BRIEF_CHARS, not the smaller number it replaced', () => {
  assert.equal(FLEET_TREE_LIMITS.maxMessageChars, 12000)
  const store = storeOf()
  const atCeiling = store.addNode({ message: 'x'.repeat(FLEET_TREE_LIMITS.maxMessageChars) })
  assert.equal(atCeiling.ok, true, 'a message exactly at the ceiling is accepted')
  assert.equal(atCeiling.node.message.length, 12000)
  /* The real range measured in the live log for a refused expanded contract:
     4,229 to 5,035 characters, past the OLD ceiling and inside the real one. */
  const measuredRange = store.addNode({ message: 'x'.repeat(4500) })
  assert.equal(measuredRange.ok, true, 'a 4,500-character message -- refused before this fix, in the live log -- is accepted')
})

test('the placeholders offered are the places an agent may actually go', () => {
  const store = storeOf()
  assert.deepEqual([...store.extensionPoints()], [{ kind: 'tree', treeId: null, parentId: null }])

  const tree = store.createTree({ name: 'Ops' })
  const points = store.extensionPoints()
  assert.ok(points.some(point => point.kind === 'root' && point.treeId === tree.tree.id))

  const top = store.addNode({ treeId: tree.tree.id })
  const after = store.extensionPoints()
  assert.equal(after.some(point => point.kind === 'root'), false, 'the top is taken')
  assert.ok(after.some(point => point.kind === 'child' && point.parentId === top.node.id))
  // Every offered slot is one addNode accepts.
  for (const point of after.filter(entry => entry.kind !== 'tree')) {
    assert.equal(store.addNode({ treeId: point.treeId, parentId: point.parentId }).ok, true)
  }
})

test('the role and the message are editable only while it is a draft', () => {
  const store = storeOf()
  const node = store.addNode({}).node
  assert.equal(store.updateNode(node.id, { role: 'reviewer', message: 'read the diff' }).ok, true)
  assert.equal(store.getNode(node.id).role, 'reviewer')
  assert.equal(store.getNode(node.id).message, 'read the diff')
  assert.equal(store.updateNode(node.id, { message: 'a line\nand another' }).ok, true, 'a brief may have paragraphs')
  assert.equal(store.updateNode(node.id, { role: 'two\nlines' }).ok, false, 'a role is one line')
  assert.equal(store.updateNode('node-nope', { role: 'x' }).ok, false)

  store.attachSession(node.id, 'run-1')
  const refused = store.updateNode(node.id, { message: 'changed my mind' })
  assert.equal(refused.ok, false)
  assert.equal(store.getNode(node.id).message, 'a line\nand another', 'what was sent stays what was sent')
})

test('a branch moves inside its tree and never into itself', () => {
  const store = storeOf()
  const top = store.addNode({ role: 'top' }).node
  const middle = store.addNode({ parentId: top.id, role: 'middle' }).node
  const leaf = store.addNode({ parentId: middle.id, role: 'leaf' }).node

  assert.equal(store.moveNode(leaf.id, top.id).ok, true)
  assert.equal(store.getNode(leaf.id).parentId, top.id)
  assert.equal(store.moveNode(leaf.id, top.id).ok, true, 'moving where it already is changes nothing')

  assert.equal(store.moveNode(top.id, top.id).ok, false)
  assert.equal(store.moveNode(top.id, middle.id).ok, false, 'a loop')
  assert.equal(store.moveNode(top.id, null).ok, true, 'it is already the top')
  assert.equal(store.moveNode(middle.id, null).ok, false, 'the top is taken')
  assert.equal(store.moveNode('node-nope', top.id).ok, false)
  assert.equal(store.moveNode(leaf.id, 'node-nope').ok, false)

  /* ACROSS TREES IS A CONNECTION. Every agent starts as its own single-node
     tree, so "connect these two" is a cross-tree move — supported since
     2026-08-13 as a deliberate adoption: the branch joins the parent's tree,
     and a tree left empty is removed instead of lingering as a husk. */
  const elsewhere = store.addNode({ role: 'other tree' }).node
  const treesBefore = store.listTrees().length
  const adopted = store.moveNode(leaf.id, elsewhere.id)
  assert.equal(adopted.ok, true, 'a cross-tree move is a connection, not an accident')
  assert.equal(adopted.node.treeId, elsewhere.treeId, 'the moved agent joins the parent\'s tree')
  assert.equal(store.getNode(leaf.id).parentId, elsewhere.id)
  assert.equal(store.listTrees().length, treesBefore, 'the source tree survives while it still holds agents')
  // Moving the LAST agent out of a tree removes the emptied tree.
  const lonely = store.addNode({ role: 'lonely tree' }).node
  const treesWithLonely = store.listTrees().length
  assert.equal(store.moveNode(lonely.id, elsewhere.id).ok, true)
  assert.equal(store.getNode(lonely.id).treeId, elsewhere.treeId)
  assert.equal(store.listTrees().length, treesWithLonely - 1, 'an emptied tree is removed, not kept as a husk')

  // Whatever the moves, the saved shape still reads back.
  assert.notEqual(parseFleetTrees(store.snapshot().nodes.length ? recordFrom(store) : null, { computerId: COMPUTER }), EMPTY_FLEET_TREES)
})

test('a cross-tree move clears its ordinal with the destination tree, not the one it left', () => {
  /* MEASURED 2026-09-03: a "Worker" (ordinal 1) dragged onto a parent in a
     tree that already had its OWN "Worker" (ordinal 1) landed as two nodes
     sharing one tree, one role and one ordinal — moveNode rewrote treeId
     across the branch but never touched nameOrdinal, the one field that has
     to change WITH it. nodeDisplayName then drew identical words over two
     different agents (the "found by the name shown on screen" failure this
     store exists to prevent), and the very next save round-tripped the
     duplicate through this file's own ordinal-uniqueness check in
     parseFleetTrees — which does not repair a broken record, it discards the
     whole forest. Both symptoms are asserted below so a regression here
     cannot hide behind only checking the one a future edit happens to look
     at. */
  const store = storeOf()
  const aTop = store.addNode({ role: 'Worker' }).node
  const bTop = store.addNode({ role: 'Manager' }).node
  const bWorker = store.addNode({ parentId: bTop.id, role: 'Worker' }).node
  assert.equal(aTop.nameOrdinal, 1)
  assert.equal(bWorker.nameOrdinal, 1, 'each tree keeps its own ordinal pool until they are joined')

  const moved = store.moveNode(aTop.id, bTop.id)
  assert.equal(moved.ok, true)
  assert.equal(moved.node.treeId, bTop.treeId, 'the branch joins the parent\'s tree')

  const peers = store.listNodes(bTop.treeId)
  const inDestination = peers.filter(peer => peer.role === 'Worker')
  assert.equal(inDestination.length, 2, 'both Workers now live in one tree')
  assert.notEqual(
    inDestination[0].nameOrdinal, inDestination[1].nameOrdinal,
    'one tree cannot hold two agents with the same role and the same ordinal',
  )
  assert.notEqual(
    nodeDisplayName(inDestination[0], peers), nodeDisplayName(inDestination[1], peers),
    'two different agents must not draw as the same name',
  )

  // The record this move produced must still be the whole forest on reload,
  // not EMPTY_FLEET_TREES — a duplicate ordinal is exactly what the reader's
  // own uniqueness check above refuses.
  const reloaded = parseFleetTrees(recordFrom(store), { computerId: COMPUTER })
  assert.notEqual(reloaded, EMPTY_FLEET_TREES)
  assert.equal(reloaded.nodes.length, store.snapshot().nodes.length)
})

test('a cross-tree move keeps the ordinal a node already registered when nothing collides, and still clears it when something does', () => {
  /* MEASURED 2026-09-03: the fix directly above this test (a6683d5) called
     nextNameOrdinal() unconditionally for every moved node, on every
     cross-tree move -- not only the ones that actually collided.
     nextNameOrdinal() always hands back the SMALLEST FREE number, not the
     number a node already held, so a "Worker 2" already RUNNING -- already
     registered with the tree directory and named in any child's own brief
     under that exact name -- dragged into a tree with no "Worker" in it at
     all, nothing to collide with, still came back renamed to plain "Worker".
     Reproduced against the unmodified store: ordinal 2 -> 1, on a move into
     a tree holding zero same-role peers. That is the "found by the name
     shown on screen" failure this file exists to prevent, landed on a node
     whose name had nothing wrong with it to begin with. */
  const store = storeOf()
  const aTop = store.addNode({ role: 'Coordinator' }).node
  store.addNode({ parentId: aTop.id, role: 'Worker' }) // ordinal 1, left behind
  const w2 = store.addNode({ parentId: aTop.id, role: 'Worker' }).node
  assert.equal(w2.nameOrdinal, 2)

  // w2 is not a draft being dragged around before it means anything to
  // anyone -- it is already live, exactly the case the ordinal exists to
  // protect.
  store.attachSession(w2.id, 'sess-w2')
  store.setNodeStatus(w2.id, 'running')
  assert.equal(nodeDisplayName(store.getNode(w2.id)), 'Worker 2')

  // A destination tree with NO "Worker" at all -- nothing to collide with.
  const bTop = store.addNode({ role: 'Manager' }).node
  const moved = store.moveNode(w2.id, bTop.id)
  assert.equal(moved.ok, true)
  assert.equal(moved.node.nameOrdinal, 2, 'nothing collided, so the registered number stays the registered number')
  assert.equal(nodeDisplayName(moved.node), 'Worker 2', 'the name a live session was attached under does not change under it')
  assert.equal(moved.node.sessionId, 'sess-w2', 'the same node, not a new one wearing the old one\'s session')
  assert.equal(moved.node.status, 'running', 'a move is not a stop')

  // The still-guarded case: a GENUINE collision in the destination does
  // still force a fresh ordinal. This fix narrows WHEN nextNameOrdinal() is
  // asked for one; it must not stop asking.
  const cTop = store.addNode({ role: 'Manager' }).node
  store.addNode({ parentId: cTop.id, role: 'Worker' }) // ordinal 1, left behind
  const cWorker2 = store.addNode({ parentId: cTop.id, role: 'Worker' }).node
  assert.equal(cWorker2.nameOrdinal, 2)
  const clash = store.moveNode(cWorker2.id, bTop.id) // bTop's tree already holds "Worker 2"
  assert.equal(clash.ok, true)
  assert.notEqual(clash.node.nameOrdinal, 2, 'a real collision in the destination is still resolved, not carried through')

  const peers = store.listNodes(bTop.treeId).filter(peer => peer.role === 'Worker')
  assert.equal(peers.length, 2)
  assert.notEqual(
    nodeDisplayName(peers[0], peers), nodeDisplayName(peers[1], peers),
    'two different agents still never draw as the same name',
  )

  const reloaded = parseFleetTrees(recordFrom(store), { computerId: COMPUTER })
  assert.notEqual(reloaded, EMPTY_FLEET_TREES)
  assert.equal(reloaded.nodes.length, store.snapshot().nodes.length)
})

test('a moved branch that collides with the destination cannot collide with ITSELF once the collision is resolved', () => {
  /* MEASURED 2026-09-03 (round 3), against the store as the two fixes above
     this test left it: a "Worker" (ordinal 1) with its OWN CHILD also
     "Worker" (ordinal 2) -- an ordinary report-to-your-senior-worker chain --
     dragged as one branch onto a parent in a tree that already held a
     "Worker" (ordinal 1) of its own.

     The single pass those two fixes left behind reads a branch in
     `movedIds` order: the parent is read first, collides with the
     destination's existing "Worker 1", and nextNameOrdinal() hands it 2 --
     the smallest free number IT CAN SEE, because the child had not been
     written under the destination's treeId yet and so was invisible to the
     scan. The loop then reads the child: nothing EXTERNAL sits on 2
     (`movedSet` rightly keeps the parent from counting against its own
     child), so the child keeps the 2 it already had. Two members of ONE
     branch land in the destination both called "Worker 2" -- reproduced here
     with both nodes carrying a live session, exactly the "already
     registered" case the fix two tests above this one exists to protect --
     and the very next save refuses the WHOLE record on reload, the same
     catastrophic failure both fixes above this one were written to prevent. */
  const store = storeOf()
  const aTop = store.addNode({ role: 'Coordinator' }).node
  const w1 = store.addNode({ parentId: aTop.id, role: 'Worker' }).node
  const w2 = store.addNode({ parentId: w1.id, role: 'Worker' }).node
  assert.equal(w1.nameOrdinal, 1)
  assert.equal(w2.nameOrdinal, 2, 'w2 reports to w1, but they still share one role and one ordinal pool')

  // Both already live, so a wrong rename would land on a session actually
  // running under the name that changed out from under it.
  store.attachSession(w1.id, 'sess-w1')
  store.setNodeStatus(w1.id, 'running')
  store.attachSession(w2.id, 'sess-w2')
  store.setNodeStatus(w2.id, 'running')

  // The destination already holds a "Worker" (ordinal 1) of its own -- w1
  // collides with it; w2, moving alongside w1, does not collide with
  // anything external at all.
  const bTop = store.addNode({ role: 'Manager' }).node
  store.addNode({ parentId: bTop.id, role: 'Worker' })

  const moved = store.moveNode(w1.id, bTop.id)
  assert.equal(moved.ok, true)

  const peers = store.listNodes(bTop.treeId).filter(peer => peer.role === 'Worker')
  assert.equal(peers.length, 3, 'the destination\'s own Worker plus the two the branch carried in')
  const ordinals = peers.map(peer => peer.nameOrdinal)
  assert.equal(new Set(ordinals).size, 3, 'three Workers in one tree cannot share fewer than three ordinals')
  const names = peers.map(peer => nodeDisplayName(peer, peers))
  assert.equal(new Set(names).size, 3, 'three different agents must not draw as the same name, including two from the same branch')

  // w2 collided with nothing external, so it is the one node here whose
  // number the move had no reason to touch.
  const w2After = store.getNode(w2.id)
  assert.equal(w2After.nameOrdinal, 2, 'the branch member that never collided keeps the number it already had')
  assert.equal(w2After.sessionId, 'sess-w2')
  assert.equal(w2After.status, 'running')

  // The record this move produced must still be the whole forest on reload,
  // not EMPTY_FLEET_TREES -- a duplicate ordinal is exactly what the
  // reader's own uniqueness check refuses.
  const reloaded = parseFleetTrees(recordFrom(store), { computerId: COMPUTER })
  assert.notEqual(reloaded, EMPTY_FLEET_TREES)
  assert.equal(reloaded.nodes.length, store.snapshot().nodes.length)
})

test('a move answers to the same caps the placeholders draw by, and movePoints only offers what moveNode accepts', () => {
  /* Until 2026-08-13 moveNode checked neither cap, so it was the one write
     that could build a child past the cap or a four-level branch — shapes
     every "+" refuses by construction — after which extensionPoints() silently
     withdrew the person's own placeholders. These are the missing halves. */
  const store = storeOf()
  const top = store.addNode({ role: 'top' }).node
  const children = []
  for (let i = 0; i < TREE_BOUNDS.maxChildren; i += 1) {
    children.push(store.addNode({ parentId: top.id, role: `child ${i}` }).node)
  }
  const spare = store.addNode({ parentId: children[0].id, role: 'spare' }).node
  // Each child is attached to a session so it reads starting, not draft — a
  // blank draft no longer holds a seat (see the full-looking-parent tests
  // above), so a genuinely full parent has to be built out of live children.
  for (let i = 0; i < TREE_BOUNDS.maxChildren; i += 1) {
    assert.equal(store.attachSession(children[i].id, `session-${i}`).ok, true, `child ${i} live`)
  }

  // Fan-out: the child past the cap a "+" refuses cannot arrive by move, or by offer.
  assert.equal(store.moveNode(spare.id, top.id).ok, false, 'a move must not build a child past the cap')
  assert.equal(store.movePoints(spare.id).some(point => point.parentId === top.id), false, 'a full parent is never offered')

  // Depth: the branch's HEIGHT rides in the check, not the one node's.
  const deep = store.addNode({ parentId: children[1].id, role: 'deep' }).node
  const deepest = store.addNode({ parentId: deep.id, role: 'deepest' }).node
  assert.equal(store.moveNode(spare.id, deepest.id).ok, false, 'past the depth cap')
  const b1 = store.addNode({ parentId: children[2].id, role: 'b1' }).node
  store.addNode({ parentId: b1.id, role: 'b2' })
  assert.equal(store.moveNode(b1.id, deep.id).ok, false, 'the branch under the moved node comes with it')
  assert.equal(store.movePoints(b1.id).some(point => point.parentId === deep.id), false)

  // The offer list and the write agree: an offered move is an accepted move.
  const offers = store.movePoints(spare.id)
  assert.ok(offers.length > 0, 'a movable node has somewhere to go')
  assert.equal(store.moveNode(spare.id, offers[0].parentId).ok, true)

  // What a node carries survives its move: the session, the status, the reply.
  store.attachSession(spare.id, 'run-move')
  store.setNodeReply(spare.id, 'kept')
  const before = store.getNode(spare.id)
  const target = store.movePoints(spare.id)[0]
  assert.ok(target)
  const moved = store.moveNode(spare.id, target.parentId)
  assert.equal(moved.ok, true)
  assert.equal(moved.node.sessionId, 'run-move')
  assert.equal(moved.node.reply, 'kept')
  assert.equal(moved.node.status, before.status)
})

function recordFrom(store) {
  const current = store.snapshot()
  return {
    version: FLEET_TREES_RECORD_VERSION,
    computerId: current.computerId,
    trees: current.trees.map(tree => ({ ...tree })),
    nodes: current.nodes.map(node => ({ ...node })),
  }
}

/* THE CONTRACT THIS REPLACES took the whole branch with the removed node. The
   owner's page has two sanctioned ways to move agents out from under one — the
   reports-to picker and the drag — so a removal now refuses a parent rather
   than silently deleting agents the person never named, and refuses a live
   agent rather than orphaning the run behind it. */
test('removing is one agent: a parent is refused until its agents are moved out', () => {
  const store = storeOf()
  const top = store.addNode({ role: 'top' }).node
  const middle = store.addNode({ parentId: top.id }).node
  const leaf = store.addNode({ parentId: middle.id }).node

  const refusedParent = store.removeNode(middle.id)
  assert.equal(refusedParent.ok, false)
  assert.equal(refusedParent.problems[0], NODE_REMOVE_REFUSALS.children(1))
  assert.equal(store.getNode(middle.id).id, middle.id, 'a refused removal removes nothing')
  assert.equal(store.getNode(leaf.id).id, leaf.id, 'the branch is never a surprise deletion')

  const second = store.addNode({ parentId: middle.id }).node
  assert.equal(store.removeNode(middle.id).problems[0], NODE_REMOVE_REFUSALS.children(2),
    'the reason counts the agents that have to be moved or removed first')

  assert.equal(store.removeNode(second.id).ok, true)
  assert.equal(store.removeNode(leaf.id).ok, true)
  assert.equal(store.removeNode(middle.id).ok, true, 'a leaf again once its agents are gone')
  assert.equal(store.removeNode(middle.id).ok, false, 'already gone')
  assert.equal(store.getNode(top.id).id, top.id)
})

test('removing a live agent is refused with the words the palette shows', () => {
  const store = storeOf()
  const top = store.addNode({ role: 'top' }).node
  const leaf = store.addNode({ parentId: top.id }).node

  store.attachSession(leaf.id, 'run-live')
  assert.equal(store.getNode(leaf.id).status, 'starting')
  const starting = store.removeNode(leaf.id)
  assert.equal(starting.ok, false)
  assert.equal(starting.problems[0], NODE_REMOVE_REFUSALS.running)

  store.setNodeStatus(leaf.id, 'running')
  const running = store.removeNode(leaf.id)
  assert.equal(running.ok, false)
  assert.equal(running.problems[0], NODE_REMOVE_REFUSALS.running)

  store.setNodeStatus(leaf.id, 'finished', { note: 'It answered.' })
  const removed = store.removeNode(leaf.id)
  assert.equal(removed.ok, true)
  assert.equal(removed.removedNode.sessionId, 'run-live',
    'the record comes back, so a caller can still let the session go')
  assert.equal(store.getNode(leaf.id), null)
})

// A live STATUS is not a live AGENT, and removeNode used to confuse the two.
//
// This file's own definition of running is the pair — advanceRunClock computes
// `LIVE_STATUSES.has(after?.status) && after?.sessionId != null`, and its header
// says so in words: "RUNNING IS THE STORE'S OWN WORD FOR IT: a LIVE_STATUSES
// status over a session id." removeNode tested only the first half, so a node
// that never got a session was refused with "Stop this agent first." over a run
// that does not exist and cannot be stopped — the person is told to do a thing
// no button on any screen can do, and the row is stuck forever.
//
// The motivating case is node-1-11bbb999, root of tree-1-71d7d19a: an
// INVESTIGATOR contract that never started. Reachable through this store's own
// API, not hand-built — setNodeStatus guards 'running' against a null session
// and deliberately does not guard 'starting'.
//
// The second assertion is the one that must never move. It is green before this
// change and after it, and it is what stops "make removal work" from being
// answered by deleting the guard.
test('a live status with NO session is removable', () => {
  const store = storeOf()
  const top = store.addNode({ role: 'top' }).node

  const never = store.addNode({ parentId: top.id }).node
  assert.equal(store.setNodeStatus(never.id, 'starting').ok, true)
  assert.equal(store.getNode(never.id).status, 'starting')
  assert.equal(store.getNode(never.id).sessionId, null,
    'the contract never started, so there is no session behind the status')

  const removed = store.removeNode(never.id)
  assert.equal(removed.ok, true,
    'a status with no session behind it is not a run, and "Stop this agent first." asks for the impossible')
  assert.equal(store.getNode(never.id), null)
})

test('a live status WITH a session is still refused, in the words the palette shows', () => {
  const store = storeOf()
  const top = store.addNode({ role: 'top' }).node

  const live = store.addNode({ parentId: top.id }).node
  store.attachSession(live.id, 'run-held')
  assert.equal(store.getNode(live.id).status, 'starting')
  assert.equal(store.getNode(live.id).sessionId, 'run-held')

  const refused = store.removeNode(live.id)
  assert.equal(refused.ok, false,
    'a status OVER a session is a real run: removing the record would leave it with nothing naming it')
  assert.equal(refused.problems[0], NODE_REMOVE_REFUSALS.running)
  assert.equal(store.getNode(live.id).id, live.id, 'the refused agent is still on the tree')
})

test('the last agent takes its emptied tree with it, and the removal survives a reload', () => {
  const storage = memoryStorage()
  const store = createFleetTreeStore({ computerId: COMPUTER, storage, now: stamps(), makeId: counterIds() })
  const top = store.addNode({ role: 'top', message: 'run the release' }).node
  const child = store.addNode({ parentId: top.id }).node
  const treeId = top.treeId

  const kept = store.removeNode(child.id)
  assert.equal(kept.ok, true)
  assert.equal(kept.removedTreeId, null, 'a tree with agents left keeps its tab')
  assert.equal(store.listTrees().length, 1)

  const emptied = store.removeNode(top.id)
  assert.equal(emptied.ok, true)
  assert.equal(emptied.removedTreeId, treeId, 'the empty tree goes rather than staying as an invisible husk')
  assert.equal(store.listTrees().length, 0)
  assert.equal(store.getTree(treeId), null)

  const reopened = createFleetTreeStore({ computerId: COMPUTER, storage, now: stamps(), makeId: counterIds() })
  assert.equal(reopened.listTrees().length, 0, 'the removal was saved on the same beat')
  assert.equal(reopened.snapshot().nodes.length, 0, 'no ghost comes back on the next launch')

  assert.equal(store.removeNode('node-nope').ok, false)
})

test('running means there is a session, and draft means there is not', () => {
  const store = storeOf()
  const node = store.addNode({ role: 'worker' }).node

  assert.equal(store.setNodeStatus(node.id, 'running').ok, false, 'no session to point at')
  assert.equal(store.setNodeStatus(node.id, 'nonsense').ok, false)
  assert.equal(store.setNodeStatus('node-nope', 'failed').ok, false)
  assert.equal(store.setNodeStatus(node.id, 'starting').ok, true, 'a launch was asked for; the id has not come back')

  assert.equal(store.attachSession(node.id, 'run-1').ok, true)
  assert.equal(store.setNodeStatus(node.id, 'running').ok, true)
  assert.equal(store.setNodeStatus(node.id, 'draft').ok, false, 'a draft cannot hold a session')

  const failed = store.setNodeStatus(node.id, 'failed', { note: 'It stopped before the first check.' })
  assert.equal(failed.ok, true)
  assert.equal(store.getNode(node.id).statusNote, 'It stopped before the first check.')
  assert.equal(store.setNodeStatus(node.id, 'failed', { note: 'x'.repeat(FLEET_TREE_LIMITS.maxNoteChars + 1) }).ok, false)

  store.setNodeStatus(node.id, 'finished')
  assert.equal(store.getNode(node.id).statusNote, '', 'the note belongs to the state now showing')
})

test('a session belongs to one agent, and letting go of it says so', () => {
  const store = storeOf()
  const first = store.addNode({ role: 'one' }).node
  const second = store.addNode({ parentId: first.id, role: 'two' }).node

  const attached = store.attachSession(first.id, 'run-1')
  assert.equal(attached.ok, true)
  assert.equal(attached.node.sessionId, 'run-1')
  assert.equal(attached.node.status, 'starting', 'a draft cannot stay a draft with a session on it')

  assert.equal(store.attachSession(second.id, 'run-1').ok, false, 'two boxes, one run')
  assert.equal(store.attachSession(first.id, '').ok, false)
  assert.equal(store.attachSession('node-nope', 'run-2').ok, false)

  store.setNodeStatus(first.id, 'running')
  const detached = store.detachSession(first.id)
  assert.equal(detached.node.sessionId, null)
  assert.equal(detached.node.status, 'draft', 'nothing to open, stop or read')

  store.attachSession(second.id, 'run-1')
  store.setNodeStatus(second.id, 'running')
  store.setNodeStatus(second.id, 'finished', { note: 'It answered.' })
  const ended = store.detachSession(second.id)
  assert.equal(ended.node.status, 'finished', 'history does not need a live session')
  assert.equal(ended.node.statusNote, 'It answered.')
  assert.equal(store.detachSession('node-nope').ok, false)
})

test('ids are unique on this computer, and a generator that repeats is refused', () => {
  const store = storeOf({ makeId: () => 'same-id' })
  assert.equal(store.createTree({ name: 'One' }).ok, true)
  const clash = store.createTree({ name: 'Two' })
  assert.equal(clash.ok, false)
  assert.equal(store.listTrees().length, 1)

  const honest = storeOf()
  const a = honest.addNode({ role: 'a' }).node
  const b = honest.addNode({ role: 'b' }).node
  assert.notEqual(a.id, b.id)
  assert.notEqual(a.treeId, a.id)
})

test('the structure is saved on the same beat and read back next launch', () => {
  const storage = memoryStorage()
  const first = createFleetTreeStore({ computerId: COMPUTER, storage, now: stamps(), makeId: counterIds() })
  const top = first.addNode({ role: 'manager', message: 'run the release' }).node
  first.addNode({ parentId: top.id, role: 'worker' })
  assert.equal(first.snapshot().persistenceFailed, false)

  const next = createFleetTreeStore({ computerId: COMPUTER, storage, now: stamps(), makeId: counterIds() })
  assert.equal(next.listTrees().length, 1)
  assert.equal(next.listNodes(top.treeId).length, 2)
  assert.equal(next.getNode(top.id).message, 'run the release')

  // The same storage under a different computer is not this computer's work.
  const stranger = createFleetTreeStore({ computerId: 'c2', storage, now: stamps(), makeId: counterIds() })
  assert.equal(stranger.listTrees().length, 0)

  // Damaged storage is reported, not hidden, and never guessed at.
  storage.cells.set(fleetTreesStorageKey(COMPUTER), '{half a file')
  assert.throws(() => createFleetTreeStore({ computerId: COMPUTER, storage, now: stamps(), makeId: counterIds() }),
    { code: 'MC_TREE_STORAGE_UNAVAILABLE' }, 'a thrown read must not become a writable empty default')
  assert.equal(storage.cells.get(fleetTreesStorageKey(COMPUTER)), '{half a file', 'the original remains available for recovery')
})

test('a save that does not land is reported on every snapshot', () => {
  const store = createFleetTreeStore({
    computerId: COMPUTER, storage: failingStorage(), now: stamps(), makeId: counterIds(),
  })
  const added = store.addNode({ role: 'worker' })
  assert.equal(added.ok, false, 'failed persistence refuses the new structural slot')
  assert.deepEqual(store.snapshot().nodes, [], 'an unsaved node cannot be published as created')
  assert.equal(store.snapshot().persistenceFailed, true)
})

test('listeners hear every change, and can stop listening', () => {
  const seen = []
  const built = []
  const store = storeOf({ onChange: current => built.push(current.nodes.length) })
  const stop = store.subscribe(current => seen.push(current.nodes.length))
  assert.equal(typeof store.subscribe('not a function'), 'function')

  const node = store.addNode({ role: 'a' }).node
  store.addNode({ parentId: node.id, role: 'b' })
  assert.deepEqual(seen, [1, 2])
  assert.deepEqual(built, [1, 2])

  stop()
  store.addNode({ parentId: node.id, role: 'c' })
  assert.deepEqual(seen, [1, 2], 'a listener that stopped is not called again')
  assert.deepEqual(built, [1, 2, 3])
})

test('nothing comes back off disk running', () => {
  const storage = memoryStorage()
  const first = createFleetTreeStore({ computerId: COMPUTER, storage, now: stamps(), makeId: counterIds() })
  const node = first.addNode({ role: 'worker' }).node
  first.attachSession(node.id, 'run-1')
  first.setNodeStatus(node.id, 'running')

  const reopened = createFleetTreeStore({ computerId: COMPUTER, storage, now: stamps(), makeId: counterIds() })
  const back = reopened.getNode(node.id)
  assert.notEqual(back.status, 'running', 'a session cannot outlive the window that started it')
  assert.equal(back.status, 'starting', 'asked for, and not yet answered for')
  assert.equal(back.sessionId, 'run-1', 'the id is the only handle anything has for asking')
})

test('removing hands back the agents, not only their names', () => {
  const store = storeOf()
  const node = store.addNode({ role: 'worker' }).node
  store.attachSession(node.id, 'run-1')
  const removal = store.removeTree(node.treeId)
  assert.ok(removal.removedNodes.some(entry => entry.sessionId === 'run-1'),
    'nothing could stop a run that was removed with only its id handed back')

  const second = storeOf()
  const top = second.addNode({ role: 'top' }).node
  second.attachSession(top.id, 'run-2')
  second.setNodeStatus(top.id, 'running')
  second.setNodeStatus(top.id, 'finished')
  const cut = second.removeNode(top.id)
  assert.equal(cut.ok, true)
  assert.equal(cut.removedNode.sessionId, 'run-2')
})

test('no placeholder is offered where the engine would refuse the agent', () => {
  const store = storeOf()
  const top = store.addNode({ role: 'top' }).node
  /* Each child is attached to a session so it reads starting, not draft — a
     blank draft no longer holds a seat (see the fan-out test below), so the
     fixture has to build the cap out of children that actually occupy one. */
  for (let index = 0; index < TREE_BOUNDS.maxChildren; index += 1) {
    const child = store.addNode({ parentId: top.id }).node
    assert.equal(store.attachSession(child.id, `session-${index}`).ok, true, `child ${index + 1}`)
  }
  assert.deepEqual(store.extensionPoints().filter(point => point.parentId === top.id), [])
  assert.equal(store.addNode({ parentId: top.id }).ok, false, 'the rule is the store\'s, not the drawing\'s')

  const deep = storeOf()
  const chain = [deep.addNode({}).node]
  for (let depth = 1; depth <= TREE_BOUNDS.maxDepth; depth += 1) {
    chain.push(deep.addNode({ parentId: chain[depth - 1].id }).node)
  }
  const deepest = chain[TREE_BOUNDS.maxDepth]
  assert.ok(deep.extensionPoints().some(point => point.parentId === chain[TREE_BOUNDS.maxDepth - 1].id))
  assert.deepEqual(deep.extensionPoints().filter(point => point.parentId === deepest.id), [])
  assert.equal(deep.addNode({ parentId: deepest.id }).ok, false)
})

// Retained child slots count independently of active provider sessions.
const LIVE_OF_FULL = TREE_BOUNDS.maxChildren - 3

test('failed and draft children retain their reusable slots at the width limit', () => {
  const store = storeOf()
  const top = store.addNode({ role: 'top' }).node
  const children = []
  for (let i = 0; i < TREE_BOUNDS.maxChildren; i += 1) {
    children.push(store.addNode({ parentId: top.id, role: `child ${i}` }).node)
  }
  // The live ones: attaching a session promotes a draft to starting.
  for (let i = 0; i < LIVE_OF_FULL; i += 1) {
    assert.equal(store.attachSession(children[i].id, `session-${i}`).ok, true, `child ${i} live`)
  }
  // Two children are failed spawns.
  assert.equal(store.setNodeStatus(children[LIVE_OF_FULL].id, 'failed', { note: 'start failed' }).ok, true)
  assert.equal(store.setNodeStatus(children[LIVE_OF_FULL + 1].id, 'failed', { note: 'start failed' }).ok, true)
  // One child is left exactly as addNode made it: a draft, never started.
  assert.equal(store.getNode(children[LIVE_OF_FULL + 2].id).status, 'draft')

  const another = store.addNode({ parentId: top.id, role: 'another' })
  assert.equal(another.ok, false, 'every retained child consumes one structural slot')
  assert.equal(store.attachSession(children[LIVE_OF_FULL].id, 'reused-session').ok, true, 'the failed slot can be reused')
})

// Add, move and placeholder admission share the same total-slot rule.
function fullLookingParent() {
  const store = storeOf()
  const top = store.addNode({ role: 'top' }).node
  const children = []
  for (let i = 0; i < TREE_BOUNDS.maxChildren; i += 1) {
    children.push(store.addNode({ parentId: top.id, role: `child ${i}` }).node)
  }
  for (let i = 0; i < LIVE_OF_FULL; i += 1) {
    assert.equal(store.attachSession(children[i].id, `session-${i}`).ok, true, `child ${i} live`)
  }
  assert.equal(store.setNodeStatus(children[LIVE_OF_FULL].id, 'failed', { note: 'start failed' }).ok, true)
  assert.equal(store.setNodeStatus(children[LIVE_OF_FULL + 1].id, 'failed', { note: 'start failed' }).ok, true)
  assert.equal(store.getNode(children[LIVE_OF_FULL + 2].id).status, 'draft')
  return { store, top }
}

test('the plus placeholder is absent when retained children fill every slot', () => {
  const { store, top } = fullLookingParent()
  assert.equal(store.extensionPoints().some(point => point.parentId === top.id), false, 'no fifth slot is offered')
})

test('moveNode refuses an additional child when retained children fill the parent', () => {
  const { store, top } = fullLookingParent()
  const elsewhere = store.addNode({ role: 'elsewhere' }).node
  const spare = store.addNode({ parentId: elsewhere.id, role: 'spare' }).node
  assert.equal(store.moveNode(spare.id, top.id).ok, false, 'the destination has no free structural slot')
  assert.equal(store.getNode(spare.id).parentId, elsewhere.id, 'refused move preserves the original parent')
})

test('movePoints omits a parent whose retained children fill every slot', () => {
  const { store, top } = fullLookingParent()
  const elsewhere = store.addNode({ role: 'elsewhere' }).node
  const spare = store.addNode({ parentId: elsewhere.id, role: 'spare' }).node
  assert.equal(store.movePoints(spare.id).some(point => point.parentId === top.id), false, 'no full destination is offered')
})

/* The seven helpers docs/design/FLEET-TREES.md section 7 names, over the record
   shape that document describes. tools/test/fleet-trees-multi.test.mjs holds
   them to the engine's own numbers; these hold them to this module's record. */

test('the tree bounds are pinned: four wide (the tree\'s own), the engine\'s depth', () => {
  assert.deepEqual({ ...TREE_BOUNDS }, { maxChildren: 4, maxDepth: 3, maxEmptyTrees: 1 })
})

test('one tree is read in both records, and says the same thing in each', () => {
  const store = storeOf()
  const node = store.addNode({ role: 'builder', message: 'Ship the installer' }).node
  const asRecord = treeRecord(store.snapshot(), node.treeId)
  assert.equal(asRecord.id, node.treeId)
  assert.equal(asRecord.nodes.length, 1)
  assert.equal(treeRecord(store.snapshot(), 'tree-nope'), null)

  assert.equal(displayName(asRecord), 'Ship the installer', 'the words the person wrote')
  assert.equal(store.treeLabel(node.treeId), 'Ship the installer', 'and the store says the same')
  assert.equal(displayName({ nodes: [] }), 'New tree')
  assert.ok(!displayName({ id: 'tree-zzq', nodes: [] }).includes('tree-zzq'))
  const long = displayName({ nodes: [{ id: 'n', parentId: null, agent: { message: `${'word '.repeat(30)}` } }] })
  assert.ok(long.length <= 48 && !long.includes('\n'))

  // A tree nobody has typed into is counted, and only then.
  const blank = storeOf()
  const made = blank.createTree({})
  assert.equal(blank.treeLabel(made.tree.id), 'Tree 1')
  assert.equal(blank.treeLabel('tree-nope'), null)
})

test('a tree is empty, running, or finished, in either record', () => {
  const store = storeOf()
  const tree = store.createTree({}).tree
  assert.equal(treeStatus(treeRecord(store.snapshot(), tree.id)), 'empty')

  const node = store.addNode({ treeId: tree.id, role: 'builder', message: 'go' }).node
  assert.notEqual(treeStatus(treeRecord(store.snapshot(), tree.id)), 'running', 'a draft is not a running agent')

  store.attachSession(node.id, 'run-1')
  store.setNodeStatus(node.id, 'running')
  assert.equal(treeStatus(treeRecord(store.snapshot(), tree.id)), 'running')

  store.setNodeStatus(node.id, 'finished')
  assert.equal(treeStatus(treeRecord(store.snapshot(), tree.id)), 'finished')
})

test('a second empty tree is refused and points at the first', () => {
  const empty = { id: 'tree-a', name: null, nodes: [{ id: 'n1', parentId: null, agent: null }] }
  const busy = { id: 'tree-b', name: 'Ship it', nodes: [{ id: 'n1', parentId: null, agent: { message: 'go', state: 'running' } }] }

  const refused = planTreeAdd([empty])
  assert.equal(refused.allowed, false)
  assert.equal(refused.switchTo, 'tree-a')
  assert.ok(!refused.reason.includes('tree-a'), 'an id was printed at a person')

  assert.equal(planTreeAdd([busy]).allowed, true)
  assert.equal(planTreeAdd([]).allowed, true)
  assert.ok(planTreeAdd([]).reason.length > 0)
})

test('a position the engine refuses is refused here first', () => {
  const nodes = [{ id: 'n1', parentId: null, agent: { state: 'running' } }]
  for (let index = 0; index < TREE_BOUNDS.maxChildren; index += 1) {
    nodes.push({ id: `c${index}`, parentId: 'n1', agent: { state: 'running' } })
  }
  assert.equal(planNodeAdd({ nodes }, 'n1').allowed, false, 'a live child past the cap')
  assert.equal(planNodeAdd({ nodes }, 'c0').allowed, true)
  assert.equal(planNodeAdd({ nodes }, 'nope').allowed, false)
  assert.equal(planNodeAdd({ nodes }, null).allowed, false, 'the top is taken')
  assert.equal(planNodeAdd({ nodes: [] }, null).allowed, true)

  // Inactive records retain structural slots, regardless of live session count.
  const slack = [{ id: 'p1', parentId: null, agent: { state: 'running' } }]
  for (let index = 0; index < TREE_BOUNDS.maxChildren; index += 1) {
    const state = index < LIVE_OF_FULL ? 'running' : (index === LIVE_OF_FULL ? 'finished' : 'unknown')
    slack.push({ id: `s${index}`, parentId: 'p1', agent: index === TREE_BOUNDS.maxChildren - 1 ? null : { state } })
  }
  assert.equal(planNodeAdd({ nodes: slack }, 'p1').allowed, false, 'all retained children hold a slot')

  const chain = []
  for (let depth = 0; depth <= TREE_BOUNDS.maxDepth; depth += 1) {
    chain.push({ id: `d${depth}`, parentId: depth === 0 ? null : `d${depth - 1}`, agent: { state: 'finished' } })
  }
  assert.equal(planNodeAdd({ nodes: chain }, `d${TREE_BOUNDS.maxDepth - 1}`).allowed, true)
  assert.equal(planNodeAdd({ nodes: chain }, `d${TREE_BOUNDS.maxDepth}`).allowed, false)
})

test('removing a tree says how many agents it would stop', () => {
  const quiet = planTreeRemove({ name: 'Ship it', nodes: [{ id: 'n1', parentId: null, agent: { state: 'finished' } }] })
  assert.equal(quiet.stopsFirst, false)
  assert.equal(quiet.running, 0)
  assert.ok(quiet.sentence.includes('Ship it'))

  const busy = planTreeRemove({
    name: 'Ship it',
    nodes: [
      { id: 'n1', parentId: null, agent: { state: 'running' } },
      { id: 'n2', parentId: 'n1', agent: { state: 'running' } },
    ],
  })
  assert.equal(busy.stopsFirst, true)
  assert.equal(busy.running, 2)
  assert.match(busy.sentence, /\btwo\b/i, 'the number is the whole point of the ask')
})

test('the seat shortage names the trees holding the agents', () => {
  const mine = { id: 'tree-a', name: 'Fix the login screen', nodes: [] }
  const holder = {
    id: 'tree-b',
    name: 'Ship the installer',
    nodes: [{ id: 'n1', parentId: null, agent: { state: 'running' } }],
  }

  const sentence = seatShortageSentence({ trees: [mine, holder], currentTreeId: mine.id })
  assert.ok(sentence.includes('Ship the installer'))
  for (const id of ['tree-a', 'tree-b']) assert.ok(!sentence.includes(id))

  const alone = seatShortageSentence({ trees: [holder], currentTreeId: holder.id })
  assert.equal(alone, 'This tree is already holding every agent this computer can run.')
  assert.equal(
    seatShortageSentence({
      trees: [holder],
      currentTreeId: holder.id,
      subject: 'the computer you are driving',
    }),
    'This tree is already holding every agent the computer you are driving can run.',
  )

  const nothing = seatShortageSentence({})
  assert.ok(!/\bnull\b|\bundefined\b/.test(nothing), 'an absent value leaked into a sentence')
})

test('what a caller reads back cannot be edited under the store', () => {
  const store = storeOf()
  store.addNode({ role: 'a' })
  const current = store.snapshot()
  assert.ok(Object.isFrozen(current))
  assert.throws(() => { current.nodes.push({}) })
  assert.throws(() => { current.nodes[0].status = 'running' })
  assert.throws(() => { store.listTrees().push({}) })
})

/* ---------- detachToNewTree: the drag OUT of a tree, as a verb ---------- */

test('detaching a branch mints a tree and takes the whole branch along', () => {
  const store = storeOf()
  const root = store.addNode({ role: 'coordinator', message: 'run the fleet' }).node
  const mid = store.addNode({ parentId: root.id, role: 'manager', message: 'run a lane' }).node
  const leaf = store.addNode({ parentId: mid.id, role: 'default', message: 'do the work' }).node

  const out = store.detachToNewTree(mid.id)
  assert.equal(out.ok, true)
  assert.notEqual(out.treeId, root.treeId, 'the branch must land in a NEW tree')
  const after = store.snapshot()
  const byId = new Map(after.nodes.map(node => [node.id, node]))
  assert.equal(byId.get(mid.id).parentId, null, 'the detached node is its new tree\'s root')
  assert.equal(byId.get(mid.id).treeId, out.treeId)
  assert.equal(byId.get(leaf.id).treeId, out.treeId, 'descendants ride along')
  assert.equal(byId.get(root.id).treeId, root.treeId, 'the old tree keeps what was not dragged')
  assert.equal(after.trees.length, 2)
})

test('detaching a sole root is a no-op accept, not a refusal and not a new id', () => {
  const store = storeOf()
  const root = store.addNode({ role: 'coordinator', message: 'solo' }).node
  const out = store.detachToNewTree(root.id)
  assert.equal(out.ok, true)
  assert.equal(out.treeId, root.treeId, 'it already IS its own tree')
  assert.equal(out.unchanged, true)
  assert.equal(store.snapshot().trees.length, 1)
})

test('detaching the last branch of a tree removes the emptied husk', () => {
  const store = storeOf()
  const root = store.addNode({ role: 'coordinator', message: 'alone up top' }).node
  const child = store.addNode({ parentId: root.id, role: 'default', message: 'below' }).node
  // Detach the ROOT's whole tree? No -- detach the child, then the root is a
  // sole root; detach the root's branch from a tree that has another member.
  const out = store.detachToNewTree(child.id)
  assert.equal(out.ok, true)
  const after = store.snapshot()
  assert.equal(after.trees.length, 2, 'old tree still holds the root; new tree holds the child')
  // Now move the root over too -- its old tree empties and must vanish.
  const move = store.moveNode(root.id, child.id)
  assert.equal(move.ok, true)
  assert.equal(store.snapshot().trees.length, 1, 'a tree left empty is removed, not kept as a husk')
})

test('detaching refuses at the tree cap with the same sentence the button uses', () => {
  const store = storeOf()
  const root = store.addNode({ role: 'coordinator', message: 'first' }).node
  const child = store.addNode({ parentId: root.id, role: 'default', message: 'second' }).node
  for (let index = store.snapshot().trees.length; index < 64; index += 1) {
    const made = store.createTree({ name: `t${index}` })
    assert.equal(made.ok, true, `tree ${index} should fit under the cap`)
    const seeded = store.addNode({ treeId: made.tree.id, role: 'default', message: 'hold the tree open' })
    assert.equal(seeded.ok, true)
  }
  const out = store.detachToNewTree(child.id)
  assert.equal(out.ok, false)
  assert.match(out.problems[0], /64 trees already/)
})

test('a circle keeps the name it registered when a same-role sibling is added', () => {
  const storage = memoryStorage()
  const names = { roleLabel: role => ({ controller: 'Controller', manager: 'Manager' }[role] || 'Agent') }
  const store = storeOf({ storage })
  const root = store.addNode({ role: 'controller', message: 'Control' }).node
  const first = store.addNode({ parentId: root.id, role: 'manager', message: 'First' }).node
  assert.equal(nodeDisplayName(first, store.snapshot().nodes, names), 'Manager')

  const second = store.addNode({ parentId: root.id, role: 'manager', message: 'Second' }).node
  const after = store.snapshot()
  assert.equal(nodeDisplayName(after.nodes.find(node => node.id === first.id), after.nodes, names), 'Manager',
    'adding the second manager renamed the first circle after it registered')
  assert.equal(nodeDisplayName(second, after.nodes, names), 'Manager 2')

  const reloaded = storeOf({ storage }).snapshot()
  assert.equal(nodeDisplayName(reloaded.nodes.find(node => node.id === first.id), reloaded.nodes, names), 'Manager',
    'the stable name did not survive the saved record')
  assert.equal(nodeDisplayName(reloaded.nodes.find(node => node.id === second.id), reloaded.nodes, names), 'Manager 2')
})

/* AUDIT (page2/tree-store, wave 4) gap closed: app commit cd2748b froze a
   blank role's ordinal the same way a named role's already was, but its own
   test (tools/test/tree-edges-name-stability.test.mjs) only ever drove the
   LIVE store's nextNameOrdinal() — one of the three places that commit
   changed. Reverting only the other two (the parseFleetTrees reader's
   `role === '' && nameOrdinal !== null` refusal, and the `!node.role ||`
   guard in both migration loops) while leaving nextNameOrdinal() fixed left
   that test fully green, because neither subtest ever calls parseFleetTrees:
   addNode() never touches the reader, so a live-only test cannot see it.
   That reader is exactly what runs on the next launch: the fix's own
   nextNameOrdinal() now hands a live blank-role circle a persisted ordinal,
   and the ONLY consumer of a saved ordinal is the reader this test drives
   directly. Left as it shipped, a later regression in the reader alone --
   restoring just that one refusal line -- would refuse the WHOLE saved
   computer (EMPTY_FLEET_TREES, every tree gone) the first time a person with
   a running blank-role circle reopened the app, and no test on this branch
   would go red. Proven red against the reader-only revert described above,
   green on the branch tip, before this comment was written. */
test('a blank-role circle keeps its registered ordinal across a reload, after a same-tree blank-role sibling exists', () => {
  const storage = memoryStorage()
  const names = { roleLabel: role => (role ? role : 'Agent') }
  const store = storeOf({ storage })
  const controller = store.addNode({ role: 'controller', message: 'Control' }).node
  const first = store.addNode({ parentId: controller.id, role: '', message: 'First' }).node
  assert.equal(nodeDisplayName(first, store.snapshot().nodes, names), 'Agent')

  const second = store.addNode({ parentId: controller.id, role: '', message: 'Second' }).node
  const after = store.snapshot()
  assert.equal(nodeDisplayName(after.nodes.find(node => node.id === first.id), after.nodes, names), 'Agent',
    'adding the second blank-role circle renamed the first after it registered')
  assert.equal(nodeDisplayName(second, after.nodes, names), 'Agent 2')

  // The reload is the point of this test: a fresh store reading the SAME
  // storage forces every node back through parseFleetTrees(), the one path
  // the live-only test above it in this file's sibling suite never reaches.
  const reloaded = storeOf({ storage }).snapshot()
  const reloadedFirst = reloaded.nodes.find(node => node.id === first.id)
  const reloadedSecond = reloaded.nodes.find(node => node.id === second.id)
  assert.notEqual(reloadedFirst, undefined,
    'a blank-role circle with a registered ordinal must still be on the computer after a reload, not discarded with the rest of the record')
  assert.notEqual(reloadedSecond, undefined)
  assert.equal(reloadedFirst.nameOrdinal, 1, 'the reader must hand back the ordinal exactly as saved, not reassign it')
  assert.equal(reloadedSecond.nameOrdinal, 2)
  assert.equal(nodeDisplayName(reloadedFirst, reloaded.nodes, names), 'Agent',
    'the stable name did not survive the saved record for a blank-role circle')
  assert.equal(nodeDisplayName(reloadedSecond, reloaded.nodes, names), 'Agent 2')
})

test('a legacy record with blank-role agents and no saved ordinals gets them assigned in saved order, one pool per tree', () => {
  // This is the literal shape every blank-role agent was saved in before app
  // commit cd2748b: nextNameOrdinal() used to refuse a role, so nameOrdinal
  // was always absent on a blank-role entry. The migration loops below the
  // reader (see 'MIGRATE OLD RECORDS IN MEMORY, DETERMINISTICALLY' in
  // src/fleet-trees.js) are what a person's very first launch after
  // upgrading runs against a real saved file, and they used to skip a
  // blank-role node outright (`if (!node.role || node.nameOrdinal === null)
  // continue`), leaving it permanently ordinal-less and back on the unstable
  // live-count fallback -- the exact defect cd2748b fixed for the live store,
  // left standing for anyone reopening an old save.
  const raw = record({
    trees: [{ id: 'tree-1', name: 'Front desk', createdAt: 'a', updatedAt: 'a' }],
    nodes: [
      {
        id: 'node-1', treeId: 'tree-1', parentId: null, role: '', message: 'first',
        status: 'draft', statusNote: '', sessionId: null, createdAt: 'a', updatedAt: 'a',
      },
      {
        id: 'node-2', treeId: 'tree-1', parentId: 'node-1', role: '', message: 'second',
        status: 'draft', statusNote: '', sessionId: null, createdAt: 'b', updatedAt: 'b',
      },
    ],
  })
  const parsed = parseFleetTrees(raw, { computerId: COMPUTER })
  assert.notEqual(parsed, EMPTY_FLEET_TREES,
    'a legacy record with no explicit ordinals on blank-role agents must still read back, not be discarded')
  const first = parsed.nodes.find(node => node.id === 'node-1')
  const second = parsed.nodes.find(node => node.id === 'node-2')
  assert.equal(first.nameOrdinal, 1, 'the first blank-role entry in saved order takes the first ordinal')
  assert.equal(second.nameOrdinal, 2, 'a second blank-role entry with no saved ordinal must not collide with the first')
  const names = { roleLabel: role => (role ? role : 'Agent') }
  assert.equal(nodeDisplayName(first, parsed.nodes, names), 'Agent')
  assert.equal(nodeDisplayName(second, parsed.nodes, names), 'Agent 2')
})

/* ---------- the words a surface says when all it holds is a key ----------
 *
 * A LEDGER ROW ARRIVES CARRYING AN ID AND NOTHING ELSE. The standing-request
 * scopes are keyed by the ids this store mints -- a circle or tree rule under
 * the node's id, a session rule under the session it is running -- and the
 * label that names them is optional on the way in, so every rule an agent
 * filed reaches the Ledger page with only the key. These pin what
 * nodeNamesByKey answers by CALLING it with a real store's own snapshot, so
 * the answer cannot drift from what the tree actually holds.
 */

/* The words the Computers page's rail uses, handed in the same way. */
const NAME_WORDS = {
  roleLabel: role => ({ coordinator: 'Coordinator', manager: 'Manager' }[role] || 'Agent'),
}

/* Ids in the shape defaultIdFactory really mints -- kind, counter, uuid -- so
   these assertions run against a key a person would actually be shown. */
const productShapedIds = (offset = 0) => {
  let count = 0
  const uuids = ['6c518599-05aa-4c77-a154-cefe49b278ed', '2f6a9c3e-1111-4222-8333-444455556666', 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', 'bb22cc33-dd44-4ee5-8ff6-001122334455']
  return kind => {
    count += 1
    return `${kind}-${count}-${uuids[(count - 1 + offset) % uuids.length]}`
  }
}

test('a scope key is answered with the words a person reads, by node id and by session id alike', () => {
  const store = storeOf({ makeId: productShapedIds() })
  const root = store.addNode({ role: 'coordinator', message: 'plan it' }).node
  const first = store.addNode({ parentId: root.id, role: 'manager', message: 'one' }).node
  const second = store.addNode({ parentId: root.id, role: 'manager', message: 'two' }).node
  assert.equal(store.attachSession(second.id, 'chat-99999999').ok, true)
  const snapshot = store.snapshot()

  const names = nodeNamesByKey([snapshot], NAME_WORDS)

  assert.equal(names.get(root.id), 'Coordinator')
  /* THE FIRST SIBLING KEEPS THE BARE ROLE WORD. This assertion read 'Manager 1'
     when it was written, which was true of the naming rule then. page2/tree-
     store's cd2748b froze the name a circle registers WITH: a circle that was
     called "Manager" when it joined is still called "Manager" after a same-role
     sibling arrives, because renaming a running agent underneath the person
     watching it is the defect that commit closed (see 'a circle keeps the name
     it registered when a same-role sibling is added' above). Only the sibling
     that arrives second carries an ordinal. What this test is actually for is
     the line below -- one rule, whatever that rule is -- and the loop under it
     holds that; this pair just names today's answer so a silent change to it
     is visible here too. */
  assert.equal(names.get(first.id), 'Manager', 'the circle that registered first keeps the name it registered under')
  assert.equal(names.get(second.id), 'Manager 2', 'the sibling that arrived second is told apart by its ordinal')
  assert.equal(names.get('chat-99999999'), 'Manager 2', 'a session key must name the circle running that session')
  /* ONE RULE, NOT TWO. The rail and the file box name these same circles with
     nodeDisplayName; a map that answered anything else would give one agent
     two names on two pages. */
  for (const node of snapshot.nodes) {
    assert.equal(names.get(node.id), nodeDisplayName(node, snapshot.nodes, NAME_WORDS))
  }
  /* And no answer is ever the key itself. */
  for (const [key, name] of names) assert.notEqual(name, key, `${key} was handed back as its own name`)
})

test('a key no saved tree holds is absent, so a surface can say it could not look instead of inventing a name', () => {
  const store = storeOf({ makeId: productShapedIds() })
  const root = store.addNode({ role: 'coordinator', message: 'plan it' }).node
  const names = nodeNamesByKey([store.snapshot()], NAME_WORDS)

  const gone = 'node-9-deadbeef-0000-4111-8222-333344445555'
  assert.equal(names.has(gone), false, 'a circle that is not on file must not be named')
  assert.equal(names.get(gone), undefined)
  assert.equal(names.get('chat-nosuchsession'), undefined, 'a session nothing holds must not be named')
  assert.equal(names.get(root.id), 'Coordinator', 'the keys that ARE on file still answer')

  /* NOTHING TO LOOK IN IS THE SAME ANSWER AS NOTHING FOUND -- an empty map --
     and neither is an exception a surface has to catch. */
  assert.equal(nodeNamesByKey([], NAME_WORDS).size, 0)
  assert.equal(nodeNamesByKey(null, NAME_WORDS).size, 0)
  assert.equal(nodeNamesByKey([null, {}, { nodes: 'not a list' }], NAME_WORDS).size, 0)
})

test('two saved records are read together, and the first to name a key keeps it', () => {
  const one = storeOf({ makeId: productShapedIds() })
  const rootOne = one.addNode({ role: 'coordinator', message: 'here' }).node
  const two = storeOf({ computerId: 'c2', makeId: productShapedIds(2) })
  const rootTwo = two.addNode({ role: 'manager', message: 'there' }).node

  const names = nodeNamesByKey([one.snapshot(), two.snapshot()], NAME_WORDS)
  assert.equal(names.get(rootOne.id), 'Coordinator', 'the first computer\'s circles are named')
  assert.equal(names.get(rootTwo.id), 'Manager', 'so are the second computer\'s')

  const shadowed = nodeNamesByKey([one.snapshot(), { nodes: [{ ...rootOne, role: 'manager' }] }], NAME_WORDS)
  assert.equal(shadowed.get(rootOne.id), 'Coordinator', 'a later record must not rename a circle already named')
})

/* T407 / T32 item 12: A CORPSE MUST NOT HOLD A SEAT.
 *
 * A session dies with the application; its record does not. A child left
 * `starting`/`running` by a shutdown kept its seat for ever, so the next spawn
 * under that parent was refused by a child that no longer existed. Measured
 * 2026-09-19 from the owner's question: an agent "says it can't spawn more
 * because it hit the limit" while the children actually alive are below the cap.
 *
 * `ownedSessions` is the caller's set of sessions THIS APP RUN opened. These
 * drive the real store with values rather than pinning how the rule is spelled.
 */

const fillWithLiveChildren = store => {
  const top = store.addNode({ role: 'top' }).node
  const children = []
  for (let i = 0; i < TREE_BOUNDS.maxChildren; i += 1) {
    const child = store.addNode({ parentId: top.id, role: `child ${i}` }).node
    assert.equal(store.attachSession(child.id, `session-${i}`).ok, true)
    children.push(child)
  }
  return { top, children }
}
const everySessionLive = () =>
  new Map(Array.from({ length: TREE_BOUNDS.maxChildren }, (_, i) => [`session-${i}`, `node-${i}`]))

test('a child whose session died with the app keeps its reusable structural slot', () => {
  // Nothing in this run's session set: every recorded child is a corpse.
  const store = storeOf({ ownedSessions: new Map() })
  const { top } = fillWithLiveChildren(store)
  const another = store.addNode({ parentId: top.id, role: 'after the restart' })
  assert.equal(another.ok, false, 'shutdown does not remove a retained child slot')
  const existing = store.childrenOf(top.id)[0]
  assert.equal(store.attachSession(existing.id, 'restarted-session').ok, true, 'restart reuses the existing slot')
})

test('a child whose session is still live keeps its seat', () => {
  const store = storeOf({ ownedSessions: everySessionLive() })
  const { top } = fillWithLiveChildren(store)
  const another = store.addNode({ parentId: top.id, role: 'one too many' })
  assert.equal(another.ok, false,
    'a genuinely full parent must still be refused, or the cap means nothing')
})

test('a store given no session evidence counts seats exactly as before', () => {
  /* No ownedSessions is "nobody measured", not "they are all dead". Freeing a
     seat on a guess would let a parent over-seat children that really are live,
     which is the worse of the two failures. */
  const store = storeOf()
  const { top } = fillWithLiveChildren(store)
  assert.equal(store.addNode({ parentId: top.id, role: 'one too many' }).ok, false,
    'without evidence the old counting rule must be kept')
})

test('a starting child that has not been handed a session yet still holds its seat', () => {
  const store = storeOf({ ownedSessions: new Map() })
  const top = store.addNode({ role: 'top' }).node
  for (let i = 0; i < TREE_BOUNDS.maxChildren; i += 1) {
    const child = store.addNode({ parentId: top.id, role: `child ${i}` }).node
    assert.equal(store.setNodeStatus(child.id, 'starting').ok, true)
  }
  assert.equal(store.addNode({ parentId: top.id, role: 'one too many' }).ok, false,
    'a child that has claimed a seat but has no session yet is not a corpse')
})

/* T407 REVIEW: EVIDENCE THAT HAS NOT ARRIVED IS NOT EVIDENCE OF DEATH.
 *
 * The session set the view hands over lives in the module, so a RENDERER
 * RELOAD empties it while the host process keeps every one of those sessions
 * running, and src/remote-session-reconnect.js refills it only after an awaited
 * per-session round trip to that host. Read as "they all died", that gap frees
 * four occupied seats and lets the parent take a fifth LIVE child -- past
 * TREE_BOUNDS.maxChildren, written to storage, and not undone when the answers
 * land. A caller that cannot answer yet says so by handing over a function that
 * returns null, and the old count is kept until it can.
 */

test('seats are not freed while the session evidence is still being gathered', () => {
  let sweptTheHost = false
  const liveSessions = everySessionLive()
  // Exactly the view's shape: the map exists all along, and is withheld from
  // the seat count until the host has actually been asked about each session.
  const store = storeOf({ ownedSessions: () => (sweptTheHost ? liveSessions : null) })
  const { top } = fillWithLiveChildren(store)

  assert.equal(store.addNode({ parentId: top.id, role: 'during the reload' }).ok, false,
    'an unasked host must not have its live children counted as corpses')

  sweptTheHost = true
  assert.equal(store.addNode({ parentId: top.id, role: 'after the sweep' }).ok, false,
    'the sweep found every session alive, so the parent is still full')
})

test('a completed liveness sweep preserves every reusable child slot', () => {
  let sweptTheHost = false
  // The app-restart case: the sweep runs, the host disowns every saved session,
  // and the map it fills is empty. That emptiness IS evidence, and frees seats.
  const store = storeOf({ ownedSessions: () => (sweptTheHost ? new Map() : null) })
  const { top } = fillWithLiveChildren(store)

  assert.equal(store.addNode({ parentId: top.id, role: 'too early' }).ok, false,
    'before the sweep the old count stands')

  sweptTheHost = true
  assert.equal(store.addNode({ parentId: top.id, role: 'after the restart' }).ok, false,
    'liveness changes do not allocate an extra structural slot')
  assert.equal(store.childrenOf(top.id).length, TREE_BOUNDS.maxChildren)
})

test('a pending sweep also holds the seat a live child claims by starting', () => {
  /* The other seat counter: setNodeStatus takes the seat at the transition, and
     it must read the same withheld evidence addNode does, or the two disagree. */
  let sweptTheHost = false
  const liveSessions = everySessionLive()
  const store = storeOf({ ownedSessions: () => (sweptTheHost ? liveSessions : null) })
  const { top } = fillWithLiveChildren(store)
  const queued = store.addNode({ role: 'queued elsewhere' }).node
  assert.equal(store.moveNode(queued.id, top.id).ok, false,
    'a move must not take a seat an unasked host still holds')
})

/* T1496: saved nodes are in creation order, so a circle made before tree Y's
   head and then moved into Y became Y's "first" node, and its brief renamed
   the whole tree. The label now follows the head. */
test('moving an older circle into another tree does not rename that tree after the moved brief', () => {
  const store = storeOf()
  const xRoot = store.addNode({ role: 'controller', message: 'Root xouopb (rig test)' }).node
  const xManager = store.addNode({ parentId: xRoot.id, role: 'manager', message: 'Manager A xouopb (rig test)' }).node
  const yRoot = store.addNode({ role: 'controller', message: 'Root ynux8y (rig test, never started)' }).node
  store.addNode({ parentId: yRoot.id, role: 'manager', message: 'Manager A ynux8y (rig test)' })
  assert.equal(store.treeLabel(yRoot.treeId), 'Root ynux8y (rig test, never started)')
  assert.equal(store.moveNode(xManager.id, yRoot.id).ok, true)
  assert.equal(store.getNode(xManager.id).treeId, yRoot.treeId, 'fixture premise: the older circle joined tree Y')
  assert.equal(store.treeLabel(yRoot.treeId), 'Root ynux8y (rig test, never started)', 'tree Y keeps its head\'s words')
  assert.equal(store.treeLabel(xRoot.treeId), 'Root xouopb (rig test)', 'tree X keeps its own head\'s words')
})

/* T1377: the store answers one agent's child slots with the admission its own
   add applies, so every door that offers a child can ask it first. */
test('childSlot reports a full parent with the same refusal the add gives', () => {
  const store = storeOf()
  const root = store.addNode({ role: 'controller', message: 'Lead' }).node
  let added
  do { added = store.addNode({ parentId: root.id, role: 'worker', message: 'Help' }) } while (added.ok)
  const slot = store.childSlot(root.id)
  assert.equal(slot.canAdd, false)
  assert.equal(slot.reason, added.problems[0], 'the same words the refused add gave')
  assert.equal(store.childSlot(store.childrenOf(root.id)[0].id).canAdd, true, 'a child with room can still take one')
  assert.equal(store.childSlot('no-such-node'), null)
})
