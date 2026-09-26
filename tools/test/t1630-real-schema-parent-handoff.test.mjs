import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createTaskTopologyAdmission } = require(process.env.T1630_ADMISSION_MODULE || '../../shell/task-assignment-authority.cjs')

// This is the saved fleet shape produced by src/fleet-trees.js. In particular,
// a parent carries tree/node identity and saved runtime settings, not a
// provider targetConfiguration. The handoff seam must transfer Ledger custody
// using the verified parent tuple without starting or configuring a provider.
const computerId = 'computer-real-schema'
const treeId = 'tree-real-schema'
const sourceNodeId = 'node-child-real-schema'
const parentNodeId = 'node-parent-real-schema'
const operationId = 'remove-real-schema-child'
const reason = 'Remove the saved child and retain its active tasks under the parent.'
const request = { computerId, sourceNodeId, operationId, reason }

function savedForest() {
  return {
    computerId,
    complete: true,
    trees: [{ id: treeId, rootId: parentNodeId, name: 'Saved tree' }],
    nodes: [
      {
        id: parentNodeId, treeId, parentId: null, role: 'Manager', status: 'idle', sessionId: null,
        tier: 'standard', effort: '', accountChoice: null, runMs: null, runStartedAt: null,
        updatedAt: '2026-09-23T00:00:00.000Z',
      },
      {
        id: sourceNodeId, treeId, parentId: parentNodeId, role: 'Worker', status: 'idle', sessionId: null,
        tier: 'standard', effort: '', accountChoice: null, runMs: null, runStartedAt: null,
        updatedAt: '2026-09-23T00:00:00.000Z',
      },
    ],
  }
}

function makeAdmission({ persistedReceipt = null, mutateForest = null } = {}) {
  const forest = savedForest()
  if (mutateForest) mutateForest(forest)
  const calls = []
  const coordinatorIdentity = {
    actor: 'agent', nodeId: sourceNodeId, hostSessionId: 'real-schema-host', orgRevision: 1,
  }
  const consumedReservations = new Set()
  let durableReadback = null
  const receipt = (phase, postimageSha256 = null) => ({
    operationId, sourceNodeId, durable: true, phase, replayed: false,
    destination: { kind: 'verified-parent', parentNodeId, parentTreeId: treeId },
    taskIds: ['T-real-schema'], taskSetDigest: 'a'.repeat(64), taskCount: 1,
    sourceBarrier: phase === 'prepared' ? 'pending' : phase === 'committed' ? 'retained' : 'released',
    sourcePreimageRetained: phase !== 'finalized', sourceTombstone: phase === 'finalized',
    reason,
    ...(postimageSha256 ? { postimageSha256 } : {}),
    history: { sequence: 4, ledgerRevision: 4, eventSha256: 'b'.repeat(64), operationSha256: 'c'.repeat(64) },
  })
  const writer = {
    prepareTaskHandoff(input, options) {
      assert.equal(options?.coordinatorIdentity?.hostSessionId, coordinatorIdentity.hostSessionId)
      assert.equal(options?.reservation?.operationId, input.operationId)
      calls.push(['prepare', structuredClone(input), structuredClone(options)])
      return receipt('prepared')
    },
    commitTaskHandoff(input, options) {
      assert.equal(options?.coordinatorIdentity?.hostSessionId, coordinatorIdentity.hostSessionId)
      assert.equal(options?.reservation?.operationId, input.operationId)
      calls.push(['commit', structuredClone(input), structuredClone(options)])
      return receipt('committed', input.postimageSha256)
    },
    consumeTaskLedgerReservation(input, options) {
      assert.equal(options?.coordinatorIdentity?.hostSessionId, coordinatorIdentity.hostSessionId)
      assert.equal(options?.reservation?.operationId, input.operationId)
      const token = options?.reservation?.token
      if (!token || consumedReservations.has(token)) {
        throw Object.assign(new Error('The synthetic writer received a missing or reused reservation.'), { code: 'TASK_LEDGER_POLICY_DENIED' })
      }
      consumedReservations.add(token)
      calls.push(['consume', structuredClone(input), structuredClone(options)])
      return { consumed: true, replayed: false, operationId: input.operationId, postimageSha256: input.postimageSha256 }
    },
    finalizeTaskHandoff(input, options) {
      assert.equal(options?.coordinatorIdentity?.hostSessionId, coordinatorIdentity.hostSessionId)
      assert.equal(options?.reservation?.operationId, input.operationId)
      calls.push(['finalize', structuredClone(input), structuredClone(options)])
      return receipt('finalized', input.postimageSha256)
    },
  }
  if (persistedReceipt) writer.readTaskHandoff = () => structuredClone(persistedReceipt)
  const admission = createTaskTopologyAdmission({
    getTaskWriter: () => writer,
    readForest: () => ({ ok: true, complete: true, forest: structuredClone(forest) }),
    parseForest: value => JSON.parse(value),
    quiesceFleet: async () => ({ ok: true }),
    confirmFleetTree: async () => durableReadback
      ? { ok: true, durable: true, value: structuredClone(durableReadback) }
      : { ok: false, code: 'READBACK_UNCONFIRMED', reason: 'No inert durable readback was supplied.' },
    principal: 'native-removal-service',
    makeOperationId: () => operationId,
    readCoordinatorIdentity: () => coordinatorIdentity,
  })
  return {
    admission, calls, forest, receipt, previous: () => JSON.stringify(forest),
    setReadback(value) { durableReadback = structuredClone(value) },
  }
}

test('real saved-fleet parent without targetConfiguration authorizes custody rehome', async () => {
  const fixture = makeAdmission()
  const parent = fixture.forest.nodes.find(node => node.id === parentNodeId)
  assert.equal(Object.hasOwn(parent, 'targetConfiguration'), false)

  const authority = fixture.admission.readAuthority(request)
  assert.deepEqual({
    kind: authority.kind,
    parentNodeId: authority.parentNodeId,
    parentTreeId: authority.parentTreeId,
  }, { kind: 'verified-parent', parentNodeId, parentTreeId: treeId })
  assert.equal(Object.hasOwn(authority, 'targetConfiguration'), false)

  await fixture.admission.prepare(request)
  fixture.admission.commit(request)
  const after = structuredClone(fixture.forest)
  after.nodes = after.nodes.filter(node => node.id !== sourceNodeId)
  const write = fixture.admission.validateWrite({ computerId, previous: fixture.previous(), value: JSON.stringify(after),
    taskLedgerOptions: fixture.admission.taskLedgerOptionsForWrite(operationId) })
  assert.equal(write.ok, true)
  assert.deepEqual(fixture.calls.map(([kind]) => kind), ['prepare', 'commit', 'consume'])
})

test('real-schema handoff refuses a parent/topology change after reservation', async () => {
  const fixture = makeAdmission()
  await fixture.admission.prepare(request)
  fixture.admission.commit(request)
  const after = structuredClone(fixture.forest)
  after.nodes = after.nodes.filter(node => node.id !== sourceNodeId)
  after.nodes[0].role = 'Changed manager'
  after.trees[0].rootId = 'another-root'
  const write = fixture.admission.validateWrite({ computerId, previous: fixture.previous(), value: JSON.stringify(after),
    taskLedgerOptions: fixture.admission.taskLedgerOptionsForWrite(operationId) })
  assert.equal(write.ok, false)
  assert.match(write.reason, /parent|topology|configuration|retained/i)
})

test('finalization refuses a durable readback that differs from the admitted postimage', async () => {
  const fixture = makeAdmission()
  await fixture.admission.prepare(request)
  fixture.admission.commit(request)
  const admitted = structuredClone(fixture.forest)
  admitted.nodes = admitted.nodes.filter(node => node.id !== sourceNodeId)
  const write = fixture.admission.validateWrite({ computerId, previous: fixture.previous(), value: JSON.stringify(admitted),
    taskLedgerOptions: fixture.admission.taskLedgerOptionsForWrite(operationId) })
  assert.equal(write.ok, true)
  const publishedDifferent = structuredClone(admitted)
  publishedDifferent.nodes[0].effort = 'changed-after-admission'
  fixture.setReadback(publishedDifferent)
  await assert.rejects(fixture.admission.finalize(request), /postimage|differs|barrier/i)
  assert.equal(fixture.calls.some(([kind]) => kind === 'finalize'), false)
})

for (const [label, mutateForest] of [
  ['the parent binding', forest => { forest.nodes.find(node => node.id === sourceNodeId).parentId = null }],
  ['a parent configuration field', forest => { forest.nodes.find(node => node.id === parentNodeId).effort = 'max' }],
  ['the source preimage', forest => { forest.nodes.find(node => node.id === sourceNodeId).role = 'Changed worker' }],
]) {
  test(`helper reconstruction refuses changed ${label} instead of rebuilding authority from current bytes`, async () => {
    const original = makeAdmission()
    await original.admission.prepare(request)
    original.admission.commit(request)
    const persistedAuthority = original.admission.readAuthority(request)
    const persistedReceipt = {
      ...original.receipt('committed'),
      sourcePreimage: persistedAuthority.sourcePreimage,
      topologyToken: persistedAuthority.topologyToken,
    }
    const restarted = makeAdmission({ persistedReceipt, mutateForest })
    await assert.rejects(restarted.admission.prepare(request), /persisted|authority|matches|kept/i)
    assert.deepEqual(restarted.calls, [])
  })
}

/* These restart cases exercise the helper's persisted-authority reconstruction
   with an inert writer double. They do not claim that a real writer can reuse
   its original opaque lease after process reconstruction; the engine's fresh-
   module test owns that retained-token contract. */
test('helper reconstruction after durable tree deletion finalizes only the persisted exact postimage', async () => {
  const original = makeAdmission()
  await original.admission.prepare(request)
  const committed = original.admission.commit(request)
  const persistedAuthority = original.admission.readAuthority(request)
  const persistedReceipt = {
    ...committed,
    sourcePreimage: persistedAuthority.sourcePreimage,
    topologyToken: persistedAuthority.topologyToken,
  }
  const restarted = makeAdmission({
    persistedReceipt,
    mutateForest: forest => { forest.nodes = forest.nodes.filter(node => node.id !== sourceNodeId) },
  })
  restarted.setReadback(restarted.forest)
  const finalized = await restarted.admission.finalize(request)
  assert.equal(finalized.phase, 'finalized')
  assert.equal(restarted.calls.some(([kind]) => kind === 'commit'), false)
  assert.equal(restarted.calls.at(-1)[0], 'finalize')
})
