import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createRendererPrefs } = require('../../shell/renderer-prefs.cjs')
const { createTreeChangeValidator } = require('../../shell/tree-change-admission.cjs')
const mainSource = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')

const TREE_KEY = 'mc.fleet.trees.v1:fixture'

function memoryFs() {
  return {
    readFileSync() {
      throw Object.assign(new Error('synthetic absence'), { code: 'ENOENT' })
    },
  }
}

function forest(nodes) {
  return JSON.stringify({
    computerId: 'fixture',
    topologyToken: 'topology-1',
    nodes,
    trees: [{ id: 'tree-1', label: 'Fixture tree' }],
  })
}

function removedNodeIds(previous, value) {
  if ((previous !== null && typeof previous !== 'string') || typeof value !== 'string') return null
  try {
    const before = previous === null ? { nodes: [] } : JSON.parse(previous)
    const after = JSON.parse(value)
    const afterIds = new Set((after.nodes || []).map(node => node?.id).filter(Boolean))
    return (before.nodes || []).map(node => node?.id).filter(id => id && !afterIds.has(id))
  } catch {
    return null
  }
}

test('the real renderer-prefs path keeps a pending handoff barrier on parent/config edits', t => {
  assert.match(mainSource, /validateTreeChange:\s*createTreeChangeValidator\(/)
  assert.match(mainSource, /readTaskTopologyAdmission:\s*\(\)\s*=>\s*taskTopologyAdmission/)
  let currentAdmission = null
  let lazyAdmissionCalls = 0
  const topologyCalls = []
  const optionRequests = []
  const token = { reservation: { operationId: 'handoff-1', token: 'opaque-token' } }
  const validator = createTreeChangeValidator({
    readTaskTopologyAdmission: () => currentAdmission,
    getTaskTopologyAdmission: () => {
      lazyAdmissionCalls += 1
      return currentAdmission
    },
    treeSlotAdmission: { validateWrite: () => ({ ok: true }) },
    treeChangeRemovesNode: request => {
      const ids = removedNodeIds(request.previous, request.value)
      return ids === null ? null : ids.length > 0
    },
    treeChangeRemovedNodeId: request => {
      const ids = removedNodeIds(request.previous, request.value)
      return ids && ids.length === 1 ? ids[0] : null
    },
  })
  const prefs = createRendererPrefs({
    directory: path.join(process.env.TMPDIR || '/tmp', 't1630-main-topology-barrier'),
    fs: memoryFs(),
    path,
    randomUUID,
    validateTreeChange: validator,
  })
  t.after(() => prefs.sealForErase())

  const initial = forest([
    { id: 'parent-1', treeId: 'tree-1', parentId: null, role: 'controller', label: 'Parent' },
    { id: 'child-1', treeId: 'tree-1', parentId: 'parent-1', role: 'worker', label: 'Child' },
  ])
  assert.equal(prefs.set(TREE_KEY, initial).ok, true)

  currentAdmission = {
    validateWrite(request) {
      topologyCalls.push(request)
      if (request.taskLedgerOptions) return { ok: true }
      return { ok: false, code: 'TASK_TOPOLOGY_WRITE_REFUSED', reason: 'pending handoff barrier' }
    },
    taskLedgerOptionsForWrite(operation) {
      optionRequests.push(operation)
      return token
    },
  }

  const parentEdit = forest([
    { id: 'parent-1', treeId: 'tree-1', parentId: null, role: 'controller', label: 'Parent renamed' },
    { id: 'child-1', treeId: 'tree-1', parentId: 'parent-1', role: 'worker', label: 'Child' },
  ])
  const refused = prefs.set(TREE_KEY, parentEdit, { expectedValue: initial })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'TASK_TOPOLOGY_WRITE_REFUSED')
  assert.equal(topologyCalls.length, 1)
  assert.equal(Object.hasOwn(topologyCalls[0], 'taskLedgerOptions'), false)
  assert.equal(lazyAdmissionCalls, 0)
  assert.equal(prefs.snapshot().values[TREE_KEY], initial)

  const removal = forest([
    { id: 'parent-1', treeId: 'tree-1', parentId: null, role: 'controller', label: 'Parent' },
  ])
  const accepted = prefs.set(TREE_KEY, removal, { expectedValue: initial })
  assert.equal(accepted.ok, true)
  assert.deepEqual(optionRequests, [{ computerId: 'fixture', sourceNodeId: 'child-1' }])
  assert.deepEqual(topologyCalls.at(-1).taskLedgerOptions, token)
  assert.equal(prefs.snapshot().values[TREE_KEY], removal)
})

/* A FRESH INSTALLATION MUST BE ABLE TO SAVE ITS FIRST TREE. Main installs the
   topology admission at startup (`taskTopologyAdmission: getTaskTopologyAdmission()`),
   so the very first write of a computer's fleet cell -- previous === null,
   because nothing was ever saved -- goes through admission.validateWrite. That
   write used to be refused with "The saved fleet is absent, incomplete or
   unreadable", so on a new computer "Set this agent" and Start both failed.
   Real prefs, real validator, real admission, real canonical parser, and the
   record the real tree store writes for "New tree" -> "Set this agent". */
test('a fresh store saves its first tree while the startup topology admission is installed', async t => {
  assert.match(mainSource, /taskTopologyAdmission:\s*getTaskTopologyAdmission\(\)/)
  const { createTaskTopologyAdmission } = require('../../shell/task-assignment-authority.cjs')
  const { createFleetTreeStore, parseFleetTrees, fleetTreesStorageKey } = await import('../../src/fleet-trees.js')
  const computerId = 'this-computer'
  const key = fleetTreesStorageKey(computerId)
  const writerCalls = []
  const admission = createTaskTopologyAdmission({
    getTaskWriter: () => { writerCalls.push('writer'); return null },
    readForest: () => ({ ok: false }),
    parseForest: (value, options) => parseFleetTrees(value, options),
    quiesceFleet: async () => ({ ok: true }),
    principal: 'native-removal-service',
    makeOperationId: () => 'remove-fresh',
  })
  const validator = createTreeChangeValidator({
    readTaskTopologyAdmission: () => admission,
    getTaskTopologyAdmission: () => admission,
    treeSlotAdmission: { validateWrite: () => ({ ok: true }) },
    treeChangeRemovesNode: request => {
      const ids = removedNodeIds(request.previous, request.value)
      return ids === null ? null : ids.length > 0
    },
    treeChangeRemovedNodeId: request => {
      const ids = removedNodeIds(request.previous, request.value)
      return ids && ids.length === 1 ? ids[0] : null
    },
  })
  const prefs = createRendererPrefs({
    directory: path.join(process.env.TMPDIR || '/tmp', 't1630-fresh-first-tree'),
    fs: memoryFs(),
    path,
    randomUUID,
    validateTreeChange: validator,
  })
  t.after(() => prefs.sealForErase())
  assert.equal(Object.hasOwn(prefs.snapshot().values, key), false, 'a fresh store has no fleet cell yet')

  // What "New tree" -> "Set this agent" writes: the tree store's own record.
  const cells = new Map()
  const store = createFleetTreeStore({
    computerId,
    storage: { read: k => (cells.has(k) ? JSON.parse(cells.get(k)) : null), write: (k, v) => { cells.set(k, JSON.stringify(v)); return true } },
  })
  const placed = store.addNode({ role: 'controller', message: 'Read the notes in my documents folder.' })
  assert.equal(placed.ok, true, JSON.stringify(placed.problems || []))
  const first = cells.get(key)
  assert.equal(typeof first, 'string')

  const saved = prefs.set(key, first)
  assert.equal(saved.ok, true, `the first tree must be saved, got ${JSON.stringify(saved.error || saved)}`)
  assert.equal(prefs.snapshot().values[key], first)
  assert.deepEqual(writerCalls, [], 'saving a first tree never touches the task Ledger writer')

  // The guard itself is unchanged: removing that saved owner without a
  // committed handoff is still refused, and a cell that exists but cannot be
  // parsed is still not treated as empty.
  const emptied = JSON.stringify({ ...JSON.parse(first), nodes: [], trees: [] })
  const removal = prefs.set(key, emptied, { expectedValue: first })
  assert.equal(removal.ok, false)
  assert.equal(prefs.snapshot().values[key], first)
  const unreadable = admission.validateWrite({ computerId, previous: '{"not":"a fleet"}', value: first })
  assert.equal(unreadable.ok, false)
  assert.equal(unreadable.code, 'TASK_TOPOLOGY_AUTHORITY_UNKNOWN')
})
