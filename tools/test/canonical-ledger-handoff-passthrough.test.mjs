/* T1642 native reader proof. This drives the exported CommonJS reader with an
   inert in-memory store, so publicRecord and handoffRecord are exercised
   without a ledger path, engine files, or task writes. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { readCanonicalLedger } = require_('../../shell/canonical-ledger-read.cjs')

const journal = Object.freeze({
  sequence: 7,
  ledgerRevision: 4,
  eventSha256: 'e'.repeat(64),
  operationSha256: 'a'.repeat(64),
})

const uncertainNoParent = Object.freeze({
  operationId: 'op-1642-native-uncertain',
  phase: 'committed',
  sourceBarrier: 'retained',
  sourceTombstone: false,
  sourcePreimageRetained: true,
  publicationState: 'uncertain',
  publicationReasonCode: 'T_LEDGER_HANDOFF_TOPOLOGY_UNCONFIRMED',
  sourceNodeId: 'node-old',
  ownerState: 'owner-gone',
  ownerNodeId: null,
  destination: { kind: 'verified-no-parent', parentNodeId: null, parentLabel: null },
  reason: 'The previous owner circle is no longer available.',
  journal,
})

const unknownProjection = Object.freeze({
  operationId: null,
  phase: null,
  sourceBarrier: null,
  sourceTombstone: false,
  sourcePreimageRetained: true,
  publicationState: 'unknown',
  publicationReasonCode: 'T_LEDGER_HANDOFF_PROJECTION_AMBIGUOUS',
  sourceNodeId: null,
  ownerState: 'owner-gone',
  ownerNodeId: null,
  destination: null,
  reason: null,
  journal: null,
})

function record(id, handoff, includeHandoff = true) {
  const owner = handoff && typeof handoff === 'object' && !Array.isArray(handoff) ? handoff : {}
  return {
    id,
    kind: 'T',
    scope: 'global',
    scopeKey: null,
    scopeLabel: null,
    status: 'in-progress',
    words: `Task ${id}`,
    filedBy: 'owner',
    filedAt: '2026-09-23T08:00:00.000Z',
    decisions: [],
    history: [],
    gates: [],
    ownerState: owner.ownerState ?? null,
    ownerNodeId: owner.ownerNodeId ?? null,
    ...(includeHandoff ? { handoff } : {}),
  }
}

function read(records) {
  const calls = []
  let verifyHistoryCalls = 0
  const store = {
    readAll(options) {
      calls.push(options)
      return { exists: true, revision: 12, updatedAt: '2026-09-23T08:00:00.000Z', records }
    },
    verifyHistory() {
      verifyHistoryCalls += 1
      throw new Error('inert passthrough proof must not verify a history file')
    },
  }
  const reply = readCanonicalLedger({
    loadModule: () => store,
    readPolicy: () => ({ verifyHistory: false }),
  })
  return { reply, calls, verifyHistoryCalls }
}

test('native reader publicRecord preserves uncertain no-parent and unknown handoff fields', () => {
  const { reply, calls, verifyHistoryCalls } = read([
    record('T-native-uncertain', uncertainNoParent),
    record('T-native-unknown', unknownProjection),
  ])

  assert.equal(reply.ok, true)
  assert.equal(reply.records.length, 2)
  assert.deepEqual(calls[0].kinds, ['R', 'T', 'A', 'P'])
  assert.equal(verifyHistoryCalls, 0)

  const uncertain = reply.records[0]
  assert.equal(uncertain.ownerState, 'owner-gone')
  assert.equal(uncertain.ownerNodeId, null)
  assert.equal(uncertain.handoff.phase, 'committed')
  assert.equal(uncertain.handoff.sourceBarrier, 'retained')
  assert.equal(uncertain.handoff.publicationState, 'uncertain')
  assert.equal(uncertain.handoff.publicationReasonCode, 'T_LEDGER_HANDOFF_TOPOLOGY_UNCONFIRMED')
  assert.deepEqual(uncertain.handoff.destination, { kind: 'verified-no-parent', parentNodeId: null, parentTreeId: null, parentLabel: null })
  assert.deepEqual(uncertain.handoff.journal, journal)
  assert.ok(Object.isFrozen(uncertain.handoff))

  const unknown = reply.records[1]
  assert.equal(unknown.handoff.operationId, null)
  assert.equal(unknown.handoff.phase, null)
  assert.equal(unknown.handoff.publicationState, 'unknown')
  assert.equal(unknown.handoff.publicationReasonCode, 'T_LEDGER_HANDOFF_PROJECTION_AMBIGUOUS')
  assert.equal(unknown.handoff.destination, null)
  assert.equal(unknown.handoff.journal, null)
  assert.equal(unknown.ownerState, 'owner-gone')
  assert.equal(unknown.ownerNodeId, null)
})

test('native reader distinguishes an absent handoff from present scalar and array corruption', () => {
  const { reply } = read([
    record('T-native-no-handoff', undefined, false),
    record('T-native-scalar-handoff', 'malformed-handoff'),
    record('T-native-array-handoff', []),
  ])

  const [absent, scalar, array] = reply.records
  assert.equal(absent.handoff, null)
  assert.deepEqual(scalar.handoff, {})
  assert.deepEqual(array.handoff, {})
  assert.notEqual(scalar.handoff, null)
  assert.notEqual(array.handoff, null)
})
