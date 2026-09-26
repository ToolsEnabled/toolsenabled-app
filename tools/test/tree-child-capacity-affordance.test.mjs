// Saved child slots count in every lifecycle state. Starting or restarting an
// existing child reuses its slot; only adding or moving a new child claims one.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { slotAccountStartOptions } from '../../src/slot-account-choice.js'
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

const storeOf = (storage = memoryStorage()) => createFleetTreeStore({
  computerId: COMPUTER,
  storage,
  now: stamps(),
  makeId: counterIds(),
})

const liveChildren = (store, parentId) => store.snapshot().nodes
  .filter(node => node.parentId === parentId && (node.status === 'starting' || node.status === 'running'))

const nodeById = (store, nodeId) => store.snapshot().nodes.find(node => node.id === nodeId)

test('ordinary draft start observes a failed durable save before handing off to the provider', async () => {
  const storage = memoryStorage()
  const store = storeOf(storage)
  const parent = store.addNode({ role: 'manager' }).node
  const drafts = Array.from({ length: TREE_BOUNDS.maxChildren }, () => store.addNode({ parentId: parent.id, role: 'worker' }).node)
  for (const node of drafts.slice(0, -1)) assert.equal(store.setNodeStatus(node.id, 'starting').ok, true)
  const queued = drafts.at(-1)
  const before = new Map(storage.cells)
  storage.write = () => false
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
    treeStore: store, destroyed: false, composePanel: null, slotAccountStartOptions, LAUNCH_TIERS: [],
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
  assert.equal(liveChildren(store, parent.id).length, TREE_BOUNDS.maxChildren - 1)
  assert.deepEqual(storage.cells, before, 'the failed start leaves durable records untouched')
})

test('saved draft and ended child slots prevent adding beyond the same cap', () => {
  const store = storeOf()
  const parent = store.addNode({ role: 'manager' })
  assert.equal(parent.ok, true)
  const parentId = parent.node.id
  const children = Array.from({ length: TREE_BOUNDS.maxChildren }, (_, index) => {
    const child = store.addNode({ parentId, role: 'worker', message: `Assignment ${index + 1}` })
    assert.equal(child.ok, true)
    return child.node
  })
  for (const status of ['draft', 'starting', 'running', 'finished', 'interrupted', 'failed']) {
    for (const node of children) {
      if (status === 'running') assert.equal(store.attachSession(node.id, `session-${node.id}`).ok, true)
      assert.equal(store.setNodeStatus(node.id, status).ok, true)
    }
    const before = store.snapshot().nodes
    const refused = store.addNode({ parentId, role: 'worker' })
    assert.equal(refused.ok, false, `${status} records still occupy their saved slots`)
    assert.match(refused.problems.join(' '), /4 of 4 direct child slots/)
    assert.deepEqual(store.snapshot().nodes, before, 'refused additions preserve every saved assignment')
    assert.equal(store.extensionPoints().some(point => point.parentId === parentId), false)
  }
  for (const node of children) assert.equal(store.setNodeStatus(node.id, 'starting').ok, true, 'restart reuses the saved slot')
  assert.equal(liveChildren(store, parentId).length, TREE_BOUNDS.maxChildren)
})

test('the child affordance and addition refusal agree about a full parent', () => {
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

  assert.equal(store.addNode({ parentId, role: 'worker' }).ok, false, 'a full parent refuses another draft slot')
  assert.equal(liveChildren(store, parentId).length, TREE_BOUNDS.maxChildren,
    'the live roster must still hold exactly the cap')
})

test('a child that already holds a seat can finish starting under a full parent', () => {
  // Settling a start reuses the saved child slot, even when the parent is full.
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
