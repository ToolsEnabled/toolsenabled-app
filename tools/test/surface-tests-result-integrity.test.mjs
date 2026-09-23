import test from 'node:test'
import assert from 'node:assert/strict'
import { resultStatus } from '../lib/surface-tests/results.mjs'

const hosted = { id: 'hosted', kind: 'driver' }
const clean = { status: 0, cleanupConfirmed: true }
const hostedCases = [
  'chromium-390x844', 'chromium-844x390', 'chromium-320x568', 'chromium-568x320',
  'webkit-390x844', 'webkit-844x390', 'webkit-320x568', 'webkit-568x320',
]

function hostedEvidence(overrides = {}) {
  const results = hostedCases.map(label => ({
    label,
    ok: true,
    passed: 2,
    failed: 0,
    checks: [{ ok: true }, { ok: true }],
    errors: [],
    blocked: [],
  }))
  return {
    startedAt: '2026-09-22T10:00:00.000Z',
    finishedAt: '2026-09-22T10:01:00.000Z',
    ok: true,
    tests: hostedCases.length * 2,
    passed: hostedCases.length * 2,
    failed: 0,
    checks: Array.from({ length: hostedCases.length * 2 }, () => ({ ok: true })),
    errors: [],
    requestedCases: [...hostedCases],
    results,
    ...overrides,
  }
}

test('hosted result evidence binds every requested case in order', () => {
  assert.equal(resultStatus(hosted, clean, hostedEvidence()).status, 'PASS')
  for (const evidence of [
    hostedEvidence({ requestedCases: hostedCases.slice(0, 4), results: hostedEvidence().results.slice(0, 4) }),
    hostedEvidence({ requestedCases: ['chromium-390x844', ...hostedCases.slice(2)], results: hostedEvidence().results }),
    hostedEvidence({ requestedCases: ['chromium-390x844', 'chromium-390x844', ...hostedCases.slice(2)], results: hostedEvidence().results }),
    hostedEvidence({ requestedCases: ['chromium-390x844', ...hostedCases.slice(1, 7), 'unknown-568x320'], results: hostedEvidence().results }),
    hostedEvidence({ results: [hostedEvidence().results[1], ...hostedEvidence().results.slice(1)] }),
  ]) {
    assert.equal(resultStatus(hosted, clean, evidence).status, 'FAIL')
  }
})

test('hosted result evidence rejects incomplete or unverified case records', () => {
  for (const evidence of [
    hostedEvidence({ startedAt: '' }),
    hostedEvidence({ startedAt: 1 }),
    hostedEvidence({ finishedAt: [1] }),
    hostedEvidence({ finishedAt: 'not-a-date' }),
    hostedEvidence({ startedAt: '2026-09-22T10:01:00.000Z', finishedAt: '2026-09-22T10:00:00.000Z' }),
    hostedEvidence({ finishedAt: undefined }),
    hostedEvidence({ passed: hostedCases.length * 2 - 1 }),
    hostedEvidence({ errors: [{ error: 'old failure' }] }),
    hostedEvidence({ results: hostedEvidence().results.map(row => ({ ...row, errors: [{ error: 'case failure' }] })) }),
    hostedEvidence({ results: hostedEvidence().results.map(row => ({ ...row, checks: undefined })) }),
    hostedEvidence({ results: hostedEvidence().results.map(row => ({ ...row, checks: [{ ok: false }, { ok: true }] })) }),
    hostedEvidence({ results: hostedEvidence().results.map(row => ({ ...row, checks: [{ ok: true }], passed: 2 })) }),
    hostedEvidence({ results: hostedEvidence().results.map(row => ({ ...row, blocked: [{ method: 'POST' }] })) }),
    hostedEvidence({ results: hostedEvidence().results.map(row => ({ ...row, ok: false })) }),
  ]) {
    assert.equal(resultStatus(hosted, clean, evidence).status, 'FAIL')
  }
})
