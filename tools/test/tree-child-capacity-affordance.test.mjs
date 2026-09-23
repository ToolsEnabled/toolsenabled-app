// UI-2, reproduced: what the tree OFFERS and what it ENFORCES disagree about
// how many agents may sit under one parent.
//
// The operator saw an enabled plus and Start action, then a refusal only after
// submission naming the eight-agent cap, plus a persisted roster holding more
// than eight direct children during rapid starts. Both fall out of one gap,
// and it is not the cap number:
//
//   * addNode() checks the cap (via planNodeAdd) when a child is QUEUED -- but
//     a queued child is a draft, and a draft deliberately occupies no seat
//     (2026-09-07: failed and draft records were wrongly blocking spawns, so
//     the count was narrowed to live children only). Every draft is therefore
//     admitted no matter how many are already waiting.
//   * setNodeStatus() is what actually makes a child LIVE, and it checks no
//     cap at all. Starting a queue of drafts walks straight past the limit,
//     and the roster ends up holding more live children than any plus would
//     ever have offered.
//
// The fix belongs at the transition that claims the seat, not at the draft.
// Drafts must stay free -- narrowing them back would re-break the 2026-09-07
// measurement -- so these tests pin BOTH halves: a draft is still free to
// queue, and starting one past the cap is refused with the draft preserved.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parseAst } from 'rollup/parseAst'

import {
  TREE_BOUNDS,
  createFleetTreeStore,
  planNodeAdd,
  treeRecord,
} from '../../src/fleet-trees.js'

const COMPUTER = 'c1'

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
    return `2026-09-09T00:00:${String(tick).padStart(2, '0')}.000Z`
  }
}

function counterIds() {
  let count = 0
  return kind => {
    count += 1
    return `${kind}-${count}`
  }
}

const storeOf = () => createFleetTreeStore({
  computerId: COMPUTER,
  storage: memoryStorage(),
  now: stamps(),
  makeId: counterIds(),
})

const liveChildren = (store, parentId) => store.snapshot().nodes
  .filter(node => node.parentId === parentId && (node.status === 'starting' || node.status === 'running'))

const nodeById = (store, nodeId) => store.snapshot().nodes.find(node => node.id === nodeId)

test('ordinary draft start observes the cap refusal before handing off to the provider', async () => {
  const store = storeOf()
  const parent = store.addNode({ role: 'manager' }).node
  const drafts = Array.from({ length: TREE_BOUNDS.maxChildren + 1 }, () => store.addNode({ parentId: parent.id, role: 'worker' }).node)
  for (const node of drafts.slice(0, -1)) assert.equal(store.setNodeStatus(node.id, 'starting').ok, true)
  const queued = drafts.at(-1)
  const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  let startSource = null
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'startDraftNodeUnguarded') startSource = source.slice(node.start, node.end)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseAst(source))
  assert.ok(startSource, 'exercise the actual ordinary draft-start function')
  let starts = 0
  const context = vm.createContext({
    treeStore: store, destroyed: false, composePanel: null,
    currentDataSource: () => 'local',
    window: {},
    mockSource: () => false, isWriteEnabled: () => true, START_CONTROL_FLAG: 'synthetic-start',
    draftStartEffort: () => null, tierEffortOf: () => null, identityRoleForTreeNode: role => role,
    ensureSeatForNode: async () => ({ ok: true }),
    roleBindingForStart: () => ({ ok: true, binding: { agentId: queued.id } }),
    treeNodeName: node => node.id, setOrgStatus() {}, refreshTree() {},
    startAgentForNode: async () => { starts++; throw new Error('provider must not start') },
  })
  vm.runInContext(startSource, context)
  const result = await context.startDraftNodeUnguarded(queued)
  assert.equal(result.ok, false)
  assert.equal(result.notStarted, true)
  assert.equal(result.code, 'MC_TREE_START_NOT_SAVED')
  assert.equal(starts, 0)
  assert.equal(store.getNode(queued.id).status, 'draft')
  assert.equal(store.getNode(queued.id).sessionId, null)
  assert.equal(liveChildren(store, parent.id).length, TREE_BOUNDS.maxChildren)
})

test('starting queued drafts cannot push a parent past its live-child cap', () => {
  const store = storeOf()
  const parent = store.addNode({ role: 'manager' })
  assert.equal(parent.ok, true, 'the fixture parent must exist before anything is queued under it')
  const parentId = parent.node.id

  // Queuing beyond the cap is allowed on purpose: a draft occupies no seat.
  const overshoot = 3
  const drafts = []
  for (let i = 0; i < TREE_BOUNDS.maxChildren + overshoot; i += 1) {
    const child = store.addNode({ parentId, role: 'worker' })
    assert.equal(child.ok, true, `queuing draft ${i + 1} must stay allowed: a draft occupies no seat`)
    drafts.push(child.node.id)
  }

  const results = drafts.map(id => store.setNodeStatus(id, 'starting'))
  const started = results.filter(result => result.ok).length

  assert.equal(liveChildren(store, parentId).length, TREE_BOUNDS.maxChildren,
    'the persisted roster holds more live children than the cap allows')
  assert.equal(started, TREE_BOUNDS.maxChildren, 'exactly the cap many starts should have been accepted')

  for (const id of drafts.slice(TREE_BOUNDS.maxChildren)) {
    const node = nodeById(store, id)
    assert.ok(node, 'a refused start must not remove the agent')
    assert.equal(node.status, 'draft', 'a refused start must leave the agent as a draft')
    assert.equal(node.role, 'worker', 'a refused start must preserve what the person typed')
  }

  const refusal = results[TREE_BOUNDS.maxChildren]
  assert.equal(refusal.ok, false, 'the start past the cap should have been refused')
  assert.match(refusal.problems.join(' '), /agents under it/,
    'the refusal should say what every other cap refusal says')
})

test('the child affordance and the start refusal agree about a full parent', () => {
  const store = storeOf()
  const parent = store.addNode({ role: 'manager' })
  const parentId = parent.node.id

  for (let i = 0; i < TREE_BOUNDS.maxChildren; i += 1) {
    const child = store.addNode({ parentId, role: 'worker' })
    assert.equal(child.ok, true)
    assert.equal(store.setNodeStatus(child.node.id, 'starting').ok, true, 'filling the cap exactly must be allowed')
  }

  const offersChild = store.extensionPoints()
    .some(point => point.kind === 'child' && point.parentId === parentId)
  assert.equal(offersChild, false, 'the plus is still offered under a parent at its live-child cap')

  const snap = store.snapshot()
  const treeId = snap.nodes.find(node => node.id === parentId).treeId
  assert.equal(planNodeAdd(treeRecord(snap, treeId), parentId).allowed, false,
    'planNodeAdd still allows a child under a parent at its cap')

  const queuedEarlier = store.addNode({ parentId, role: 'worker' })
  if (queuedEarlier.ok) {
    assert.equal(store.setNodeStatus(queuedEarlier.node.id, 'starting').ok, false,
      'a draft queued under a full parent must not be startable into a live seat past the cap')
  }
  assert.equal(liveChildren(store, parentId).length, TREE_BOUNDS.maxChildren,
    'the live roster must still hold exactly the cap')
})

test('a child that already holds a seat can finish starting under a full parent', () => {
  // The guard that makes this pass is `!LIVE_STATUSES.has(node.status)`: a
  // starting -> running step does not claim a NEW seat, it settles the one the
  // child is already sitting in. Without that clause the cap check would refuse
  // every agent's own transition to running the moment its parent filled up,
  // which would strand a whole tree mid-start.
  const store = storeOf()
  const parent = store.addNode({ role: 'manager' })
  const parentId = parent.node.id

  const started = []
  for (let i = 0; i < TREE_BOUNDS.maxChildren; i += 1) {
    const child = store.addNode({ parentId, role: 'worker' })
    assert.equal(store.setNodeStatus(child.node.id, 'starting').ok, true)
    started.push(child.node.id)
  }
  assert.equal(liveChildren(store, parentId).length, TREE_BOUNDS.maxChildren, 'the parent should now be exactly full')

  const settling = started[0]
  assert.equal(store.attachSession(settling, 'session-1').ok, true, 'the fixture session must attach')
  assert.equal(store.setNodeStatus(settling, 'running').ok, true,
    'a child already occupying a seat was refused its own starting -> running step under a full parent')
  assert.equal(nodeById(store, settling).status, 'running')
  assert.equal(liveChildren(store, parentId).length, TREE_BOUNDS.maxChildren,
    'settling a seat must not change how many are occupied')
})
