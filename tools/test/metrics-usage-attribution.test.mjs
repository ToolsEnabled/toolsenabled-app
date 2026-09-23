import assert from 'node:assert/strict'
import test from 'node:test'

import {
  usageAttributionObservationFromResult,
  validateUsageAttributionPayload,
} from '../gen-metrics.mjs'

const generatedAt = '2026-08-08T02:39:03.311Z'

function payload({ state = 'complete', rows = [row()], tokens = 1234 } = {}) {
  const attributedUsageEvents = rows.reduce((sum, value) => sum + value.calls, 0)
  const excludedEvents = {
    nonUsage: 1, overlapWrapper: 0, missingAttribution: state === 'partial' ? 1 : 0,
    unknownAttribution: 0, invalidTokenAccounting: 0, invalidRouting: 0,
  }
  return {
    schemaVersion: 1,
    observation: 'agent-role-token-usage',
    generatedAt,
    source: { kind: 'signed-audit-tail', provenance: 'MEASURED', requestedLimit: 100 },
    window: {
      scope: 'latest-signed-event-tail', earliestSequence: 1, latestSequence: 5,
      earliestTimestamp: generatedAt, latestTimestamp: generatedAt,
    },
    coverage: {
      state, complete: state !== 'partial',
      scannedEvents: attributedUsageEvents + Object.values(excludedEvents).reduce((sum, value) => sum + value, 0),
      attributedUsageEvents,
      excludedEvents,
    },
    totals: { tokens: state === 'partial' ? null : tokens, measuredLowerBoundTokens: tokens, calls: rows.reduce((sum, value) => sum + value.calls, 0) },
    rows,
  }
}

function row(overrides = {}) {
  return {
    pool: 'northwind21', provider: 'gemini', role: 'worker', tokens: 1234, calls: 4,
    tokenProvenance: 'MEASURED', attributionProvenance: 'MEASURED', ...overrides,
  }
}

test('complete usage attribution preserves exact measured tuple and provenance', () => {
  const raw = payload()
  const checked = validateUsageAttributionPayload(raw)
  assert.equal(checked.ok, true)
  const observation = usageAttributionObservationFromResult({ ok: true, value: raw })
  assert.equal(observation.state, 'complete')
  assert.deepEqual(observation.value.rows, [row()])
  assert.equal(observation.value.rows[0].tokenProvenance, 'MEASURED')
  assert.equal(observation.value.rows[0].attributionProvenance, 'MEASURED')
})

test('complete empty is an observed empty observation, not an unavailable zero', () => {
  const raw = payload({ state: 'empty', rows: [], tokens: 0 })
  const observation = usageAttributionObservationFromResult({ ok: true, value: raw })
  assert.equal(observation.ok, true)
  assert.equal(observation.state, 'empty')
  assert.deepEqual(observation.value.rows, [])
  assert.equal(observation.value.totals.tokens, 0)
})

test('a completely empty signed tail preserves its null sequence window', () => {
  const raw = payload({ state: 'empty', rows: [], tokens: 0 })
  raw.window = {
    scope: 'latest-signed-event-tail', earliestSequence: null, latestSequence: null,
    earliestTimestamp: null, latestTimestamp: null,
  }
  raw.coverage.scannedEvents = 0
  raw.coverage.excludedEvents.nonUsage = 0
  const observation = usageAttributionObservationFromResult({ ok: true, value: raw })
  assert.equal(observation.ok, true)
  assert.equal(observation.state, 'empty')
  assert.equal(observation.value.window.earliestSequence, null)
})

test('partial retains only the measured lower bound', () => {
  const raw = payload({ state: 'partial' })
  const observation = usageAttributionObservationFromResult({ ok: true, value: raw })
  assert.equal(observation.ok, true)
  assert.equal(observation.state, 'partial')
  assert.equal(observation.value.totals.tokens, null)
  assert.equal(observation.value.totals.measuredLowerBoundTokens, 1234)
})

test('malformed rows fail closed and do not become a partial total', () => {
  const raw = payload({ rows: [row({ tokenProvenance: 'DERIVED' })] })
  const observation = usageAttributionObservationFromResult({ ok: true, value: raw })
  assert.deepEqual(observation, {
    ok: false, state: 'unavailable', reason: 'source-malformed', observedAt: null, value: null,
  })
})

test('unknown contract fields fail closed inside the isolated observation', () => {
  const raw = payload()
  raw.source.debug = true
  const observation = usageAttributionObservationFromResult({ ok: true, value: raw })
  assert.deepEqual(observation, {
    ok: false, state: 'unavailable', reason: 'source-malformed', observedAt: null, value: null,
  })
})

test('query failure isolates usage attribution from the surrounding projection', () => {
  const observation = usageAttributionObservationFromResult({ ok: false, reason: 'source-timeout', observedAt: null })
  assert.equal(observation.ok, false)
  assert.equal(observation.state, 'unavailable')
  assert.equal(observation.reason, 'source-timeout')
})

// Rows are strictly ascending by `pool\0provider\0role` -- validateUsageAttributionPayload
// rejects any other order -- so the local-machine row leads here.
test('row conservation rejects totals that would double-count or infer tokens', () => {
  const raw = payload({ rows: [row({ pool: 'local-machine', provider: 'local', role: 'worker', tokens: 6, calls: 1 }), row()] })
  assert.equal(validateUsageAttributionPayload(raw).ok, false)
  raw.totals.tokens = 1240
  raw.totals.measuredLowerBoundTokens = 1240
  raw.totals.calls = 5
  raw.coverage.attributedUsageEvents = 5
  assert.equal(validateUsageAttributionPayload(raw).ok, true)
})

test('coverage state and event accounting must match the reader contract', () => {
  const raw = payload()
  raw.coverage.scannedEvents += 1
  assert.equal(validateUsageAttributionPayload(raw).ok, false)
  raw.coverage.scannedEvents -= 1
  raw.coverage.excludedEvents.missingAttribution = 1
  raw.coverage.scannedEvents += 1
  assert.equal(validateUsageAttributionPayload(raw).ok, false)
})
