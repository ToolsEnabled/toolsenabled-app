import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createTaskTopologyAdmission } = require(process.env.T1630_ADMISSION_MODULE || '../../shell/task-assignment-authority.cjs')

// These tests exercise the real admission helper against inert boundary
// dependencies. They do not establish store durability, IPC authentication,
// the native fleet parser, or the actual node-removal caller.
const computerId = 'computer-fixture'
const sourceNodeId = 'node-child'
const parentNodeId = 'node-parent'
const operationId = 'remove-child-1'
const reason = 'Remove this saved child and retain its tasks under the parent.'
const request = { computerId, sourceNodeId, operationId, reason }

function fixture({ preparePhase = 'prepared', commitPhase = 'committed', mutateForest } = {}) {
  const source = { id: sourceNodeId, parentId: parentNodeId, treeId: 'tree-fixture', label: 'Child', status: 'idle' }
  const parent = { id: parentNodeId, parentId: null, treeId: 'tree-fixture', label: 'Parent', status: 'idle' }
  const forest = {
    computerId, complete: true,
    trees: [{ id: 'tree-fixture', rootId: parentNodeId }],
    nodes: [parent, source],
  }
  if (mutateForest) mutateForest(forest)
  const calls = []
  const coordinatorIdentity = { actor: 'human', nodeId: null, hostSessionId: 'topology-review-host', orgRevision: 7 }
  const consumedReservations = new Set()
  let boundOptions = null
  let persistedReceipt = null
  function assertOptions(input, options) {
    assert.deepEqual(options?.coordinatorIdentity, coordinatorIdentity)
    assert.equal(options?.reservation?.operationId, input.operationId)
    assert.equal(options?.reservation?.sourceNodeId, sourceNodeId)
    assert.equal(options?.reservation?.parentNodeId, parentNodeId)
    assert.equal(options?.reservation?.parentTreeId, 'tree-fixture')
    assert.equal(options?.reservation?.orgRevision, coordinatorIdentity.orgRevision)
    assert.match(options?.reservation?.token || '', /^task-ledger-/)
    if (boundOptions) assert.deepEqual(options, boundOptions, 'the same private lease reaches each boundary')
    else boundOptions = structuredClone(options)
  }
  function receipt(phase, replayed = false, postimageSha256 = null) {
    return {
      operationId, sourceNodeId, durable: true, phase, replayed,
      destination: { kind: 'verified-parent', parentNodeId, parentTreeId: 'tree-fixture' },
      taskIds: ['T1'], taskSetDigest: 'a'.repeat(64), taskCount: 1,
      sourceBarrier: phase === 'prepared' ? 'pending' : phase === 'committed' ? 'retained' : 'released',
      sourcePreimageRetained: phase !== 'finalized',
      sourceTombstone: phase === 'finalized',
      topologyRevision: 'topology-7', reason,
      ...(postimageSha256 ? { postimageSha256 } : {}),
      history: { sequence: 3, ledgerRevision: 3, eventSha256: 'b'.repeat(64), operationSha256: 'c'.repeat(64) },
    }
  }
  const writer = {
    prepareTaskHandoff(input, options) {
      assertOptions(input, options)
      calls.push(['prepare', structuredClone(input), structuredClone(options)])
      persistedReceipt = receipt(preparePhase, preparePhase !== 'prepared')
      return structuredClone(persistedReceipt)
    },
    commitTaskHandoff(input, options) {
      assertOptions(input, options)
      calls.push(['commit', structuredClone(input), structuredClone(options)])
      persistedReceipt = receipt(commitPhase, false, input.postimageSha256)
      return structuredClone(persistedReceipt)
    },
    consumeTaskLedgerReservation(input, options) {
      assertOptions(input, options)
      assert.equal(persistedReceipt?.phase, 'committed')
      assert.equal(input.postimageSha256, persistedReceipt.postimageSha256)
      const token = options.reservation.token
      if (consumedReservations.has(token)) {
        throw Object.assign(new Error('The inert writer already consumed this reservation.'), { code: 'T_LEDGER_WRITER_POLICY_DENIED' })
      }
      consumedReservations.add(token)
      calls.push(['consume', structuredClone(input), structuredClone(options)])
      return { consumed: true, replayed: false, operationId: input.operationId, postimageSha256: input.postimageSha256 }
    },
    finalizeTaskHandoff(input, options) {
      assertOptions(input, options)
      calls.push(['finalize', structuredClone(input), structuredClone(options)])
      persistedReceipt = receipt('finalized', false, persistedReceipt?.postimageSha256)
      return structuredClone(persistedReceipt)
    },
    readTaskHandoff() { return persistedReceipt && structuredClone(persistedReceipt) },
  }
  const admission = createTaskTopologyAdmission({
    getTaskWriter: () => writer,
    readForest: () => ({ ok: true, complete: true, forest: structuredClone(forest) }),
    parseForest: value => JSON.parse(value),
    readTargetConfiguration: () => ({ ok: true, configuration: { model: 'fixture-model', effort: 'high' }, topologyRevision: 'topology-7' }),
    quiesceFleet: async () => ({ ok: true }),
    principal: 'native-removal-service',
    makeOperationId: () => operationId,
    readCoordinatorIdentity: () => coordinatorIdentity,
  })
  const previous = () => JSON.stringify(forest)
  const removed = () => {
    const next = structuredClone(forest)
    next.nodes = next.nodes.filter(node => node.id !== sourceNodeId)
    return next
  }
  return { admission, calls, forest, previous, removed }
}

test('unreserved source removal is refused before any task writer call', () => {
  const f = fixture()
  const result = f.admission.validateWrite({ computerId, previous: f.previous(), value: JSON.stringify(f.removed()) })
  assert.equal(result.ok, false)
  assert.equal(f.calls.length, 0)
})

test('a prepared receipt cannot authorize source removal', async () => {
  const f = fixture()
  await f.admission.prepare(request)
  const result = f.admission.validateWrite({ computerId, previous: f.previous(), value: JSON.stringify(f.removed()) })
  assert.equal(result.ok, false)
  assert.deepEqual(f.calls.map(([kind]) => kind), ['prepare'])
})

test('commit refuses a writer response that is still only prepared', async () => {
  const f = fixture({ commitPhase: 'prepared' })
  await f.admission.prepare(request)
  assert.throws(() => f.admission.commit(request), /commit|phase|prepared|unresolved/i)
  assert.notEqual(f.admission.state(operationId)?.state, 'committed')
  const result = f.admission.validateWrite({ computerId, previous: f.previous(), value: JSON.stringify(f.removed()) })
  assert.equal(result.ok, false)
})

test('prepare replay retains the actual committed phase without a duplicate commit', async () => {
  const f = fixture({ preparePhase: 'committed' })
  const actual = await f.admission.prepare(request)
  assert.equal(actual.phase, 'committed')
  assert.equal(f.admission.state(operationId)?.state, 'committed')
  f.admission.commit(request)
  assert.deepEqual(f.calls.map(([kind]) => kind), ['prepare'])
})

test('duplicate saved parent identity refuses before preparing tasks', async () => {
  const f = fixture({ mutateForest(forest) { forest.nodes.push({ ...forest.nodes[0], label: 'Conflicting parent' }) } })
  await assert.rejects(f.admission.prepare(request), /ambiguous|duplicate|identity|fleet|parent/i)
  assert.equal(f.calls.length, 0)
})

test('exact reserved leaf removal requires private options and admits only one write after commit', async () => {
  const f = fixture()
  await f.admission.prepare(request)
  f.admission.commit(request)
  const write = { computerId, previous: f.previous(), value: JSON.stringify(f.removed()) }
  const missing = f.admission.validateWrite(write)
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /missing authenticated reservation/i)
  assert.deepEqual(f.calls.map(([kind]) => kind), ['prepare', 'commit'])

  const taskLedgerOptions = f.admission.taskLedgerOptionsForWrite(operationId)
  const result = f.admission.validateWrite({ ...write, taskLedgerOptions })
  assert.equal(result.ok, true)
  assert.equal(result.operationId, operationId)
  assert.equal(result.sourceNodeId, sourceNodeId)
  assert.equal(result.durable, false)
  assert.deepEqual(f.calls.map(([kind]) => kind), ['prepare', 'commit', 'consume'])
  const replay = f.admission.validateWrite({ ...write, taskLedgerOptions })
  assert.equal(replay.ok, false)
  assert.equal(replay.code, 'T_LEDGER_WRITER_POLICY_DENIED')
  assert.equal(f.calls.filter(([kind]) => kind === 'consume').length, 1)
  assert.equal(f.calls.some(([kind]) => kind === 'finalize'), false, 'admission alone does not prove durable publication')
})

test('source removal cannot carry an unrelated parent or topology change', async () => {
  const f = fixture()
  await f.admission.prepare(request)
  f.admission.commit(request)
  const after = f.removed()
  after.nodes[0].label = 'Changed concurrently'
  after.nodes[0].model = 'different-parent-configuration'
  after.trees[0].rootId = 'another-root'
  const result = f.admission.validateWrite({ computerId, previous: f.previous(), value: JSON.stringify(after),
    taskLedgerOptions: f.admission.taskLedgerOptionsForWrite(operationId) })
  assert.equal(result.ok, false)
  assert.match(result.reason, /parent|configuration|another saved owner/i)
  assert.deepEqual(f.calls.map(([kind]) => kind), ['prepare', 'commit'])
})

test('same source id with changed preimage cannot satisfy the reservation', async () => {
  const f = fixture()
  await f.admission.prepare(request)
  f.admission.commit(request)
  const before = structuredClone(f.forest)
  before.nodes.find(node => node.id === sourceNodeId).label = 'Changed since prepare'
  const after = structuredClone(before)
  after.nodes = after.nodes.filter(node => node.id !== sourceNodeId)
  const result = f.admission.validateWrite({ computerId, previous: JSON.stringify(before), value: JSON.stringify(after),
    taskLedgerOptions: f.admission.taskLedgerOptionsForWrite(operationId) })
  assert.equal(result.ok, false)
  assert.match(result.reason, /preimage|reservation/i)
  assert.deepEqual(f.calls.map(([kind]) => kind), ['prepare', 'commit'])
})
