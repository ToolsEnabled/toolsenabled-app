import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HANDOFF_VISIBILITY_TEXT,
  handoffVisibility,
  projectHandoffVisibility,
} from '../../src/ledger-handoff-visibility.js'
import { rowOf } from '../../src/ledger-live.js'

const baseHandoff = (extra = {}) => ({
  operationId: 'op-1642-1',
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
  journal: { sequence: 7, ledgerRevision: 4, eventSha256: 'e'.repeat(64), operationSha256: 'a'.repeat(64) },
  ...extra,
})

test('no handoff produces no marker, while a malformed present object stays honestly visible', () => {
  assert.deepEqual(projectHandoffVisibility(null), {
    state: 'none',
    visible: false,
    text: null,
    reason: null,
    handoff: null,
  })

  const malformed = projectHandoffVisibility({
    operationId: 'op-bad',
    phase: 'committed',
    sourceTombstone: 'true',
    sourcePreimageRetained: true,
    sourceBarrier: 'retained',
    publicationState: 'uncertain',
    ownerState: null,
    ownerNodeId: null,
    destination: { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: 'tree-new' },
  })
  assert.equal(malformed.state, 'unknown')
  assert.equal(malformed.visible, true)
  assert.equal(malformed.text, HANDOFF_VISIBILITY_TEXT.unknown)
})

test('explicit no-parent owner loss is visible with plain copy and bounded structured evidence', () => {
  const projected = projectHandoffVisibility(baseHandoff())

  assert.equal(projected.state, 'owner-gone')
  assert.equal(projected.visible, true)
  assert.equal(projected.text, HANDOFF_VISIBILITY_TEXT.ownerGone)
  assert.equal(projected.secondaryState, 'unconfirmed')
  assert.equal(projected.reason, 'The previous owner circle is no longer available.')
  assert.equal(projected.handoff.publicationReasonCode, 'T_LEDGER_HANDOFF_TOPOLOGY_UNCONFIRMED')
  assert.deepEqual(projected.handoff.destination, { kind: 'verified-no-parent', parentNodeId: null, parentTreeId: null, parentLabel: null })
  assert.deepEqual(projected.handoff.journal, {
    sequence: 7,
    ledgerRevision: 4,
    eventSha256: 'e'.repeat(64),
    operationSha256: 'a'.repeat(64),
  })
  assert.equal(projected.text.includes(projected.handoff.publicationReasonCode), false)
})

test('retained pending publication is distinct from owner-gone and exposes the supplied plain reason', () => {
  const projected = projectHandoffVisibility(baseHandoff({
    phase: 'prepared',
    sourceBarrier: 'pending',
    sourceTombstone: false,
    sourcePreimageRetained: true,
    publicationState: 'pending',
    publicationReasonCode: null,
    ownerState: null,
    ownerNodeId: null,
    destination: { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: 'tree-new' },
    reason: 'The retained handoff has not been confirmed by its destination.',
  }))

  assert.equal(projected.state, 'unconfirmed')
  assert.equal(projected.text, HANDOFF_VISIBILITY_TEXT.unconfirmed)
  assert.equal(projected.reason, 'The retained handoff has not been confirmed by its destination.')
  assert.equal(projected.handoff.publicationReasonCode, null)
  assert.equal(projected.text.includes('pending'), false)
})

test('authority contradictions do not become an owner or publication claim', () => {
  const ownerIdContradiction = projectHandoffVisibility(baseHandoff({ ownerNodeId: 'still-present' }))
  assert.equal(ownerIdContradiction.state, 'unknown')
  assert.equal(ownerIdContradiction.text, HANDOFF_VISIBILITY_TEXT.unknown)

  const publicationWithoutRetention = projectHandoffVisibility(baseHandoff({ sourcePreimageRetained: false }))
  assert.equal(publicationWithoutRetention.state, 'unknown')

  const unknownPublication = projectHandoffVisibility(baseHandoff({ publicationState: 'failed' }))
  assert.equal(unknownPublication.state, 'unknown')
})

test('row adapter ignores task status and does not select an older journal entry', () => {
  const handoff = baseHandoff({
    publicationState: 'uncertain',
    ownerState: 'reassigned',
    ownerNodeId: 'node-new',
    destination: { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: 'tree-new' },
    journal: { sequence: 8, ledgerRevision: 5, eventSha256: 'a'.repeat(64), operationSha256: 'b'.repeat(64) },
  })
  const states = ['open', 'in-progress', 'blocked-external', 'done', 'turn-failed']
    .map(status => handoffVisibility({ status, handoff }))

  assert.deepEqual(states.map(entry => entry.state), ['unconfirmed', 'unconfirmed', 'unconfirmed', 'unconfirmed', 'unconfirmed'])
  assert.deepEqual(states.map(entry => entry.handoff.journal), [handoff.journal, handoff.journal, handoff.journal, handoff.journal, handoff.journal])
})

test('live row projection carries the selected handoff and top-level owner fields without changing task status', () => {
  const projected = rowOf({
    id: 'T-row-projection',
    kind: 'T',
    status: 'open',
    words: 'retained handoff',
    handoff: baseHandoff(),
  })

  assert.equal(projected.status, 'open')
  assert.equal(projected.ownerState, 'owner-gone')
  assert.equal(projected.ownerNodeId, null)
  assert.equal(projected.handoff.publicationState, 'uncertain')
  assert.equal(projected.handoff.destination.kind, 'verified-no-parent')
})

test('phase, barrier, publication and retention must agree before a marker is shown', () => {
  const finalized = projectHandoffVisibility(baseHandoff({
    phase: 'finalized',
    sourceBarrier: 'released',
    sourceTombstone: true,
    sourcePreimageRetained: false,
    publicationState: 'confirmed',
    ownerState: 'reassigned',
    ownerNodeId: 'node-new',
    destination: { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: 'tree-new' },
  }))
  assert.equal(finalized.state, 'confirmed')
  assert.equal(finalized.visible, false)

  for (const mismatch of [
    { phase: 'nonsense' },
    { publicationState: 'unknown' },
    { sourceBarrier: 'released' },
    { sourceTombstone: true },
    { sourcePreimageRetained: false },
    { destination: null },
    { journal: null },
  ]) {
    const result = projectHandoffVisibility(baseHandoff(mismatch))
    assert.equal(result.state, 'unknown', `mismatch ${JSON.stringify(mismatch)} stays unknown`)
    assert.equal(result.visible, true)
  }
})

test('unknown owner/publication evidence remains retained structurally without inventing a reason', () => {
  const projected = projectHandoffVisibility(baseHandoff({
    ownerState: 'unknown',
    ownerNodeId: null,
    sourceBarrier: 'retained',
    sourcePreimageRetained: true,
    publicationState: 'unknown',
    publicationReasonCode: 'DISPOSITION_UNKNOWN',
    reason: 'DISPOSITION_UNKNOWN',
    destination: { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: 'tree-new' },
  }))

  assert.equal(projected.state, 'unknown')
  assert.equal(projected.text, HANDOFF_VISIBILITY_TEXT.unknown)
  assert.equal(projected.reason, null)
  assert.equal(projected.handoff.publicationReasonCode, 'DISPOSITION_UNKNOWN')
})

test('owner state and destination must match the producer phase matrix', () => {
  const prepared = projectHandoffVisibility(baseHandoff({
    phase: 'prepared',
    sourceBarrier: 'pending',
    publicationState: 'pending',
    ownerState: null,
    ownerNodeId: null,
    destination: { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: 'tree-new' },
  }))
  assert.equal(prepared.state, 'unconfirmed')

  const preparedAfterReassignment = projectHandoffVisibility(baseHandoff({
    phase: 'prepared',
    sourceBarrier: 'pending',
    publicationState: 'pending',
    ownerState: 'reassigned',
    ownerNodeId: 'node-old',
    destination: { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: 'tree-new' },
  }))
  assert.equal(preparedAfterReassignment.state, 'unconfirmed')

  for (const owner of [
    { ownerState: 'owner-gone', ownerNodeId: null },
    { ownerState: 'reassigned', ownerNodeId: 'wrong-source' },
    { ownerState: 'unknown', ownerNodeId: null },
  ]) {
    const invalidPrepared = projectHandoffVisibility(baseHandoff({
      phase: 'prepared',
      sourceBarrier: 'pending',
      publicationState: 'pending',
      ...owner,
      destination: { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: 'tree-new' },
    }))
    assert.equal(invalidPrepared.state, 'unknown', `prepared owner ${JSON.stringify(owner)} stays unknown`)
  }

  const committedParent = projectHandoffVisibility(baseHandoff({
    ownerState: 'reassigned',
    ownerNodeId: 'node-new',
    destination: { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: 'tree-new' },
  }))
  assert.equal(committedParent.state, 'unconfirmed')

  const committedParentWrong = projectHandoffVisibility(baseHandoff({
    ownerState: 'reassigned',
    ownerNodeId: 'wrong-parent',
    destination: { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: 'tree-new' },
  }))
  assert.equal(committedParentWrong.state, 'unknown')

  const finalizedParent = projectHandoffVisibility(baseHandoff({
    phase: 'finalized',
    sourceBarrier: 'released',
    sourceTombstone: true,
    sourcePreimageRetained: false,
    publicationState: 'confirmed',
    ownerState: 'reassigned',
    ownerNodeId: 'node-new',
    destination: { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: 'tree-new' },
  }))
  assert.equal(finalizedParent.state, 'confirmed')
  assert.equal(finalizedParent.visible, false)

  for (const owner of [
    { ownerState: null, ownerNodeId: null },
    { ownerState: 'reassigned', ownerNodeId: 'wrong-parent' },
    { ownerState: 'unknown', ownerNodeId: 'node-new' },
  ]) {
    const invalidFinalizedParent = projectHandoffVisibility(baseHandoff({
      phase: 'finalized',
      sourceBarrier: 'released',
      sourceTombstone: true,
      sourcePreimageRetained: false,
      publicationState: 'confirmed',
      ...owner,
      destination: { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: 'tree-new' },
    }))
    assert.equal(invalidFinalizedParent.state, 'unknown', `finalized owner ${JSON.stringify(owner)} stays unknown`)
    assert.equal(invalidFinalizedParent.visible, true)
  }

  const finalizedNoParent = projectHandoffVisibility(baseHandoff({
    phase: 'finalized',
    sourceBarrier: 'released',
    sourceTombstone: true,
    sourcePreimageRetained: false,
    publicationState: 'confirmed',
    ownerState: 'owner-gone',
    ownerNodeId: null,
    destination: { kind: 'verified-no-parent', parentNodeId: null, parentTreeId: null },
  }))
  assert.equal(finalizedNoParent.state, 'owner-gone')
  assert.equal(finalizedNoParent.visible, true)
  assert.equal(finalizedNoParent.secondaryState, undefined)

  const invalidFinalizedNoParent = projectHandoffVisibility(baseHandoff({
    phase: 'finalized',
    sourceBarrier: 'released',
    sourceTombstone: true,
    sourcePreimageRetained: false,
    publicationState: 'confirmed',
    ownerState: 'reassigned',
    ownerNodeId: 'node-new',
    destination: { kind: 'verified-no-parent', parentNodeId: null, parentTreeId: null },
  }))
  assert.equal(invalidFinalizedNoParent.state, 'unknown')
  assert.equal(invalidFinalizedNoParent.visible, true)
})

test('row projection preserves absent handoff null while retaining malformed presence for unknown display', () => {
  const baseRow = { id: 'T-row-boundary', kind: 'T', status: 'open', words: 'handoff boundary' }
  const absent = rowOf(baseRow)
  const scalar = rowOf({ ...baseRow, handoff: 'malformed-handoff' })
  const array = rowOf({ ...baseRow, handoff: [] })

  assert.equal(absent.handoff, null)
  for (const malformed of [scalar, array]) {
    assert.deepEqual(malformed.handoff, {})
    assert.notEqual(malformed.handoff, null)
    assert.equal(handoffVisibility(malformed).state, 'unknown')
    assert.equal(handoffVisibility(malformed).visible, true)
  }
})

test('verified parent destinations require the engine parent tree identity', () => {
  const valid = projectHandoffVisibility(baseHandoff({
    ownerState: 'reassigned',
    ownerNodeId: 'node-new',
    destination: { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: 'tree-new' },
  }))
  assert.equal(valid.state, 'unconfirmed')
  assert.equal(valid.handoff.destination.parentTreeId, 'tree-new')

  for (const destination of [
    { kind: 'verified-parent', parentNodeId: 'node-new' },
    { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: null },
    { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: '' },
    { kind: 'verified-parent', parentNodeId: 'node-new', parentTreeId: 17 },
  ]) {
    const projected = projectHandoffVisibility(baseHandoff({
      ownerState: 'reassigned',
      ownerNodeId: 'node-new',
      destination,
    }))
    assert.equal(projected.state, 'unknown', `destination ${JSON.stringify(destination)} stays unknown`)
    assert.equal(projected.visible, true)
  }
})
