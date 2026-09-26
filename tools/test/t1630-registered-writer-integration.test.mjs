import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const canonicalRoot = process.env.MC_CANONICAL_ROOT
const engineRoot = process.env.T1630_ENGINE_ROOT
  || process.env.TOOLSENABLED_TEST_ENGINE_ROOT
  || (canonicalRoot
    && (fs.existsSync(path.join(canonicalRoot, 'src', 'lib', 'owner-request-store.js'))
      ? canonicalRoot
      : path.join(canonicalRoot, 'engine')))
if (!engineRoot) throw new Error('T1630_ENGINE_ROOT is required for the retained registered-writer fixture.')

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't1630-registered-writer-'))
const stateRoot = path.join(scratch, 'state-root')
fs.mkdirSync(stateRoot, { recursive: true })
process.env.TOOLSENABLED_STATE_ROOT = stateRoot

const store = require(path.join(engineRoot, 'src', 'lib', 'owner-request-store.js'))
const { createTaskTopologyAdmission } = require('../../shell/task-assignment-authority.cjs')

const computerId = 'computer-registered-writer'
const treeId = 'tree-registered-writer'
const sourceNodeId = 'node-source-registered-writer'
const parentNodeId = 'node-parent-registered-writer'
const operationId = 'remove-registered-writer-source'
const principal = 'native-removal-service'
const reason = 'Retain the active task under the verified saved parent.'

function forestWithSource() {
  return {
    computerId,
    complete: true,
    trees: [{ id: treeId, rootId: parentNodeId, name: 'Registered writer tree' }],
    nodes: [
      { id: parentNodeId, treeId, parentId: null, role: 'Manager', status: 'idle' },
      { id: sourceNodeId, treeId, parentId: parentNodeId, role: 'Worker', status: 'idle' },
    ],
  }
}

function makeFixture({ coordinatorIdentity = { actor: 'agent', nodeId: sourceNodeId, sessionId: 'session-registered-writer', orgRevision: 7 } } = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(scratch, 'case-'))
  const rootPath = (...parts) => path.join(fixtureRoot, ...parts)
  const identity = Object.freeze({
    actor: coordinatorIdentity.actor || (coordinatorIdentity.nodeId ? 'agent' : 'human'),
    nodeId: coordinatorIdentity.nodeId ?? null,
    hostSessionId: coordinatorIdentity.hostSessionId || coordinatorIdentity.sessionId,
    orgRevision: coordinatorIdentity.orgRevision,
  })
  const opts = {
    rootPath,
    needsApproval: false,
    loadSettings: () => ({ values: {} }),
  }
  store.ensureLedger(opts)
  const task = store.fileTask({
    scope: 'tree', key: sourceNodeId, words: 'Active registered-writer fixture task', filedBy: 'builder-6',
  }, opts)
  store.progressTask({ id: task.id, status: 'in-progress', reason: 'The source owns active work.' }, opts)
  let forest = forestWithSource()
  let admission
  const registration = store.registerTaskLedgerWriter({
    options: { ...opts, taskLedgerOptions: { coordinatorIdentity: identity } },
    principal,
    resolveAuthority(input) {
      const authority = admission.readAuthority({ computerId, sourceNodeId: input.sourceNodeId, reason })
      return { ...authority, principal }
    },
    verifyTopologyReceipt(input) {
      const receipt = input.topologyReceipt
      return receipt?.durable === true
        ? { durable: true, operationId: input.operationId, sourceNodeId: input.sourceNodeId }
        : { durable: false }
    },
  })
  const writer = store.taskLedgerWriter(registration)
  admission = createTaskTopologyAdmission({
    getTaskWriter: () => writer,
    readForest: () => ({ ok: true, complete: true, forest: structuredClone(forest) }),
    parseForest: value => JSON.parse(value),
    principal,
    readCoordinatorIdentity: () => identity,
    makeOperationId: () => operationId,
    confirmFleetTree: () => ({ ok: true, durable: true, value: structuredClone(forest) }),
  })
  return {
    opts,
    task,
    registration,
    writer,
    admission,
    current: () => structuredClone(forest),
    persist(value) {
      forest = structuredClone(value)
    },
    removeSource() {
      forest = { ...forest, nodes: forest.nodes.filter(node => node.id !== sourceNodeId) }
    },
  }
}

test('real registered writer persists the exact postimage through the real-schema admission', async () => {
  const fixture = makeFixture()
  await fixture.admission.prepare({ computerId, sourceNodeId, operationId, reason })
  const committed = fixture.admission.commit({ computerId, sourceNodeId, operationId, reason })
  assert.equal(committed.phase, 'committed')
  assert.equal(typeof committed.postimageSha256, 'string')

  const before = fixture.current()
  const after = {
    ...before,
    nodes: before.nodes.filter(node => node.id !== sourceNodeId),
  }
  const writeOptions = fixture.admission.taskLedgerOptionsForWrite(operationId)
  const missingOptions = fixture.admission.validateWrite({
    computerId,
    previous: JSON.stringify(before),
    value: JSON.stringify(after),
  })
  assert.equal(missingOptions.ok, false)
  const write = fixture.admission.validateWrite({
    computerId,
    previous: JSON.stringify(before),
    value: JSON.stringify(after),
    taskLedgerOptions: writeOptions,
  })
  assert.equal(write.ok, true)
  assert.equal(fixture.current().nodes.some(node => node.id === sourceNodeId), true)
  const replay = fixture.admission.validateWrite({
    computerId,
    previous: JSON.stringify(before),
    value: JSON.stringify(after),
    taskLedgerOptions: writeOptions,
  })
  assert.equal(replay.ok, false)
  fixture.persist(after)
  const finalized = await fixture.admission.finalize({ computerId, sourceNodeId, operationId, reason })
  assert.equal(finalized.phase, 'finalized')
  assert.equal(finalized.postimageSha256, committed.postimageSha256)

  const readback = store.readAll({ ...fixture.opts, kinds: ['T'], includeRemoved: true, includeProposed: true })
  const row = readback.records.find(candidate => candidate.id === fixture.task.id)
  assert.equal(row.ownerNodeId, parentNodeId)
  assert.equal(row.ownerState, 'reassigned')
})

test('revoked or coordinator-mismatched registered writers fail closed with a nonretryable policy refusal', async () => {
  const fixture = makeFixture()
  await fixture.admission.prepare({ computerId, sourceNodeId, operationId, reason })
  assert.equal(typeof store.revokeTaskLedgerWriter, 'function')
  store.revokeTaskLedgerWriter(fixture.registration)
  assert.throws(
    () => fixture.writer.readTaskHandoff(operationId),
    error => error?.code === 'T_LEDGER_WRITER_POLICY_DENIED',
  )

  const nextRegistration = store.registerTaskLedgerWriter({
    options: {
      ...fixture.opts,
      taskLedgerOptions: {
        coordinatorIdentity: { actor: 'agent', nodeId: parentNodeId, hostSessionId: 'session-changed', orgRevision: 8 },
      },
    },
    principal,
    resolveAuthority(input) {
      return { ...fixture.admission.readAuthority({ computerId, sourceNodeId: input.sourceNodeId, reason }), principal }
    },
  })
  const next = { writer: store.taskLedgerWriter(nextRegistration) }
  assert.throws(
    () => next.writer.readTaskHandoff(operationId),
    error => error?.code === 'T_LEDGER_WRITER_POLICY_DENIED',
  )
})
