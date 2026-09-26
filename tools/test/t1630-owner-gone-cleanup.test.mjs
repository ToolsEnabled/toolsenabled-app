/* T1630 privacy cleanup producer boundary.
 *
 * These retained fixtures exercise the real node-privacy-cleanup producer with
 * inert storage, organisation, Ledger-owner-gone and read-back dependencies.
 * Full-reset orchestration belongs to shell/main.cjs and is deliberately not
 * represented by fabricated task rows in this producer suite.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createNodePrivacyCleanup, PENDING_KEY } = require('../../shell/node-privacy-cleanup.cjs')

const operationId = 'cleanup-privacy-fixture-1'
const mode = 'privacy-exit'
const reason = 'privacy cleanup on exit'

/* The real producer answers with the task Ledger's receipt (durable, phase,
   operation id). It has no `ok`; a fixture that added one hid B22. */
function committedReceipt(marker) {
  return {
    operationId: marker.operationId,
    cleanupKind: 'owner-gone-all',
    mode: marker.mode,
    phase: 'committed',
    durable: true,
    sourceBarrier: 'retained',
    sourcePreimageRetained: true,
    sourceTombstone: false,
    sourceNodeIds: ['cleanup-child', 'cleanup-parent'],
    taskIds: ['T1', 'T2'],
    taskSetDigest: 'a'.repeat(64),
    taskCount: 2,
    reason: marker.reason,
  }
}

function fixture({ pendingMarker = null, ownerGone = null, readback = null } = {}) {
  const values = {}
  if (pendingMarker) values[PENDING_KEY] = typeof pendingMarker === 'string'
    ? pendingMarker
    : JSON.stringify(pendingMarker)
  const calls = []
  const ownerGoneMarkers = []
  const finalized = []
  const prefs = {
    snapshot: () => {
      calls.push('snapshot')
      return { ok: true, values: { ...values } }
    },
    set: (key, value) => {
      calls.push('marker-set')
      values[key] = value
      return { ok: true }
    },
    prepareNodePrivacyCleanup: () => {
      calls.push('prefs-prepare')
      return { ok: true }
    },
    confirmNodePrivacyCleanup: () => {
      calls.push('readback')
      return readback ? readback() : { ok: true, durable: true, sourceBytesAbsent: true }
    },
    remove: key => {
      calls.push('marker-remove')
      delete values[key]
      return { ok: true }
    },
  }
  const cleanup = createNodePrivacyCleanup({
    prefs,
    org: { resetOrg: () => { calls.push('org-reset'); return { ok: true } } },
    transcripts: { clearForPrivacy: async () => { calls.push('transcripts-clear') } },
    ownerGone: marker => {
      calls.push('owner-gone')
      ownerGoneMarkers.push({ ...marker })
      return ownerGone ? ownerGone(marker) : committedReceipt(marker)
    },
    finalizeOwnerGone: input => {
      calls.push('finalize')
      finalized.push(input)
      return { ...committedReceipt(input), phase: 'finalized', sourceBarrier: 'released', sourcePreimageRetained: false, sourceTombstone: true }
    },
    makeOperationId: () => operationId,
  })
  return { cleanup, calls, values, ownerGoneMarkers, finalized }
}

test('privacy prepare records owner-gone before the destructive stores', () => {
  const f = fixture()
  const committed = f.cleanup.prepare()

  assert.deepEqual(f.calls, ['marker-set', 'owner-gone', 'prefs-prepare', 'org-reset'])
  assert.deepEqual(f.ownerGoneMarkers, [{ operationId, mode, reason }])
  assert.deepEqual(JSON.parse(f.values[PENDING_KEY]), { operationId, mode, reason })
  assert.equal(committed.durable, true)
  assert.equal(committed.phase, 'committed')
})

test('owner-gone refusal retains its marker and stops before destructive stores', () => {
  const f = fixture({
    ownerGone: () => ({ ok: false, error: { message: 'Ledger writer unavailable; owner-gone is unconfirmed.' } }),
  })

  assert.throws(() => f.cleanup.prepare(), /Ledger writer unavailable|owner-gone/i)
  assert.deepEqual(f.calls, ['marker-set', 'owner-gone'])
  assert.deepEqual(JSON.parse(f.values[PENDING_KEY]), { operationId, mode, reason })
})

test('complete confirms the read-back before finalizing owner-gone and clearing the marker', () => {
  const f = fixture()
  const prepared = f.cleanup.prepare()

  f.cleanup.complete()

  assert.deepEqual(f.calls, [
    'marker-set', 'owner-gone', 'prefs-prepare', 'org-reset',
    'snapshot', 'readback', 'finalize', 'marker-remove',
  ])
  assert.equal(f.values[PENDING_KEY], undefined)
  assert.equal(f.finalized.length, 1)
  assert.equal(f.finalized[0].cleanupReceipt.durable, true)
  assert.equal(f.finalized[0].cleanupReceipt.operationId, operationId)
  assert.equal(f.finalized[0].cleanupReceipt.sourceBytesAbsent, true)
  assert.equal(f.finalized[0].cleanupReceipt.taskSetDigest, 'a'.repeat(64))
  assert.equal(f.finalized[0].cleanupReceipt.taskCount, 2)
  assert.equal(prepared.phase, 'committed')
})

test('recover replays the retained marker through owner-gone, read-back and finalization', async () => {
  const f = fixture({ pendingMarker: { operationId, mode, reason } })

  await f.cleanup.recover()

  assert.deepEqual(f.calls, [
    'snapshot', 'owner-gone', 'prefs-prepare', 'org-reset',
    'transcripts-clear', 'readback', 'finalize', 'marker-remove',
  ])
  assert.deepEqual(f.ownerGoneMarkers, [{ operationId, mode, reason }])
  assert.equal(f.values[PENDING_KEY], undefined)
})

test('uncertain cleanup read-back keeps the owner-gone marker and barrier', () => {
  const f = fixture({
    readback: () => ({ ok: false, error: { message: 'privacy cleanup read-back is unconfirmed' } }),
  })
  const prepared = f.cleanup.prepare()

  assert.throws(() => f.cleanup.complete(), /read-back|unconfirmed|durable/i)
  assert.deepEqual(f.calls, [
    'marker-set', 'owner-gone', 'prefs-prepare', 'org-reset',
    'snapshot', 'readback',
  ])
  assert.deepEqual(JSON.parse(f.values[PENDING_KEY]), { operationId, mode, reason })
  assert.equal(f.finalized.length, 0)
  assert.equal(prepared.phase, 'committed')
})

test('a Ledger receipt for another operation, or not durable, is refused before the destructive stores', () => {
  for (const wrong of [{ operationId: 'another-operation' }, { durable: false }, { phase: 'prepared' }]) {
    const f = fixture({ ownerGone: marker => ({ ...committedReceipt(marker), ...wrong }) })
    assert.throws(() => f.cleanup.prepare(), /Node privacy cleanup could not finish/)
    assert.deepEqual(f.calls, ['marker-set', 'owner-gone'])
  }
})

test('B22: recover holds instead of rejecting startup when the Ledger refuses an earlier session\'s operation', async () => {
  const f = fixture({
    pendingMarker: { operationId, mode, reason },
    ownerGone: () => { throw Object.assign(new Error('The task Ledger coordinator identity does not match the durable handoff. Existing evidence remains unconfirmed.'), { code: 'T_LEDGER_WRITER_POLICY_DENIED' }) },
  })

  const result = await f.cleanup.recover()

  assert.equal(result.held, true)
  assert.equal(result.code, 'T_LEDGER_WRITER_POLICY_DENIED')
  assert.equal(result.operationId, operationId)
  assert.deepEqual(f.calls, ['snapshot', 'owner-gone'])
  assert.deepEqual(JSON.parse(f.values[PENDING_KEY]), { operationId, mode, reason })
  assert.equal(f.finalized.length, 0)
})
