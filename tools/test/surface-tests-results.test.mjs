import test from 'node:test'
import assert from 'node:assert/strict'
import { resultStatus, markdown } from '../lib/surface-tests/results.mjs'
import { assertBuildInfo } from '../lib/surface-tests/identity.mjs'

const tap = { kind: 'tap', id: 'login', files: ['a.test.mjs'] }
const engine = { kind: 'engine', id: 'fra', files: ['tests/a.js', 'tests/b.js'] }
const driver = { kind: 'driver', id: 'browser' }
const clean = { cleanupConfirmed: true, status: 0 }
const validRows = [
  { file: 'tests/a.js', status: 'pass', exitCode: 0, evidence: { kind: 'reconciled-tap', unexecuted: 0, counts: { tests: 1, pass: 1, fail: 0 } }, process: { exitCode: 0, signal: null, error: null } },
  { file: 'tests/b.js', status: 'pass', exitCode: 0, evidence: { kind: 'process-exit' }, process: { exitCode: 0, signal: null, error: null } },
]
const expected = { app: 'a'.repeat(40), engine: 'b'.repeat(40) }

test('rejects absent cleanup, timeout and nonzero results before evidence', () => {
  for (const result of [{ status: 0 }, { ...clean, cleanupConfirmed: false }, { ...clean, signal: 'SIGTERM' }, { ...clean, status: 2 }, { ...clean, error: { code: 'ETIMEDOUT' } }]) {
    assert.equal(resultStatus(tap, result, null, () => ({ kind: 'reconciled-tap', unexecuted: 0 })).status, 'FAIL')
  }
})

test('rejects malformed, missing, duplicate and skipped engine manifests', () => {
  for (const evidence of [null, {}, { files: [] }, { files: [validRows[0]] },
    { files: [{ ...validRows[0] }, { ...validRows[0] }] },
    { files: validRows.map(row => ({ ...row, status: 'fail' })) },
    { files: validRows.map(row => ({ ...row, evidence: { unexecuted: 1 } })) }]) {
    assert.equal(resultStatus(engine, clean, evidence).status, 'FAIL')
  }
  for (const bad of [
    { files: validRows.map(row => ({ ...row, exitCode: 1 })) },
    { files: validRows.map(row => ({ ...row, process: { ...row.process, exitCode: 1 } })) },
    { files: validRows.map(row => ({ ...row, evidence: undefined })) },
    { files: validRows.map(row => ({ ...row, evidence: { kind: 'reconciled-tap', unexecuted: 0, counts: { tests: 0, pass: 0, fail: 0 } } })) },
  ]) assert.equal(resultStatus(engine, clean, bad).status, 'FAIL')
  assert.equal(resultStatus(engine, clean, { files: validRows }).status, 'PASS')
})

test('validates TAP through injected completion proof and rejects partial/zero/skips', () => {
  const counts = { tests: 1, pass: 1, fail: 0, skipped: 0, todo: 0 }
  const proofs = [
    { kind: 'partial', unexecuted: 0 },
    { kind: 'reconciled-tap', counts, unexecuted: 1 },
    { kind: 'reconciled-tap', counts: { ...counts, tests: 0, pass: 0 }, unexecuted: 0 },
    { kind: 'reconciled-tap', counts: undefined, unexecuted: 0 },
    { kind: 'reconciled-tap', counts: { ...counts, fail: 1 }, unexecuted: 0 },
  ]
  for (const proof of proofs) assert.equal(resultStatus(tap, clean, null, () => proof).status, 'FAIL')
  assert.equal(resultStatus(tap, clean, null, () => ({ kind: 'reconciled-tap', counts, unexecuted: 0 })).status, 'PASS')
})

test('rejects absent or incomplete driver evidence and accepts positive evidence', () => {
  for (const evidence of [null, {}, { ok: false, tests: 1, failed: 0 }, { ok: true, tests: 0, failed: 0, checks: [] },
    { ok: true, tests: 2, failed: 0, checks: [{ ok: true }] }, { ok: true, tests: 2, failed: 0, checks: [{ ok: true }, { ok: false }] },
    { ok: true, tests: 2, failed: 1, checks: [{ ok: true }, { ok: true }] }]) {
    assert.equal(resultStatus(driver, clean, evidence).status, 'FAIL')
  }
  assert.equal(resultStatus(driver, clean, { ok: true, tests: 2, failed: 0, checks: [{ ok: true }, { ok: true }] }).status, 'PASS')
  assert.equal(resultStatus({ ...driver, id: 'packaged' }, clean, null).status, 'PASS')
})

test('assertBuildInfo requires exact immutable schema, refs and clean resolved payload', () => {
  const valid = { schemaVersion: 2, dirty: false, overridden: false, ref: expected.app,
    app: { ref: expected.app, dirty: false }, payload: { ref: expected.engine, dirty: false, resolved: true }, checkedAt: 'now' }
  assert.deepEqual(assertBuildInfo(valid, expected), { app: expected.app, engine: expected.engine, checkedAt: 'now' })
  for (const bad of [
    { ...valid, schemaVersion: 1 }, { ...valid, dirty: true }, { ...valid, overridden: true },
    { ...valid, app: { ...valid.app, dirty: true } }, { ...valid, payload: { ...valid.payload, dirty: true } },
    { ...valid, payload: { ...valid.payload, resolved: false } }, { ...valid, ref: 'c'.repeat(40) },
    { ...valid, app: { ...valid.app, ref: 'c'.repeat(40) } }, { ...valid, payload: { ...valid.payload, ref: 'c'.repeat(40) } },
    { ...valid, app: undefined }, { ...valid, payload: undefined },
  ]) assert.throws(() => assertBuildInfo(bad, expected), /Build identity/)
})

test('markdown is minimal and sanitizes table cells', () => {
  const text = markdown({ status: 'BLOCKED', platform: 'linux', profile: 'smoke', elapsedMs: 3,
    results: [{ id: 'x|y', status: 'FAIL', elapsedMs: 1, reason: 'line\nreason' }], limitations: ['fixture only'] })
  assert.match(text, /Status: BLOCKED/)
  assert.match(text, /x y/)
  assert.doesNotMatch(text, /line\nreason/)
  assert.match(text, /fixture only/)
})
