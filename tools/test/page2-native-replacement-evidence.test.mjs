import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSpawnRecorder } from '../../shell/spawn-record.cjs'
import { savedAccountResumeRefused } from '../../src/manual-account-continuation.js'
import { assertReplacementEvidence, assertVerifiedSessionSnapshot, assertRecoveryMessageOrder } from '../lib/page2-native-functions-scenarios.cjs'

function snapshot(value) {
  const records = value.records.map(row => ({ at: '2026-09-08T13:00:00.000Z', principal: 'unauthenticated', ...row }))
  const ledgerBefore = Buffer.from(records.map(row => JSON.stringify(row)).join('\n') + '\n')
  const history = { ...value.history, total: records.length, entries: records.slice(-200).reverse().map(row => ({
    sequence: row.sequence, at: row.at, action: row.action, sessionId: row.sessionId,
    principal: row.principal, outcome: row.outcome ?? null, usage: row.usage ?? null, end: row.end ?? null,
  })) }
  return { ...value, history, ledgerBefore, ledgerAfter: Buffer.from(ledgerBefore) }
}
const check = value => assertReplacementEvidence(snapshot(value))

function evidence() {
  const before = { id: 'child', sessionId: 'old', parentId: 'parent', treeId: 'tree', role: 'worker', tier: 'astra', effort: 'max' }
  const parentBefore = { id: 'parent', sessionId: 'parent-session' }
  return { history: { ok: true, verified: true }, before, after: { ...before, sessionId: 'replacement' },
    parentBefore, parentAfter: { ...parentBefore }, priorStartSequences: [1],
    records: [
      { action: 'agent_session_start', sequence: 1, sessionId: 'old', details: { agentId: 'child' } },
      { action: 'agent_session_start', sequence: 3, eventHash: 'a'.repeat(64), signature: 'test-unit-signature', sessionId: 'replacement', details: { agentId: 'child' } },
      { action: 'agent_session_outcome', sequence: 4, eventHash: 'b'.repeat(64), signature: 'test-unit-signature', sessionId: 'replacement', details: { agentId: 'child' }, outcome: { resolves: 3, result: 'started' } },
    ] }
}

test('native replacement evidence needs one successful signed child start and the unchanged parent session', () => {
  const proof = check(evidence())
  assert.equal(proof.sessionId, 'replacement')
  assert.equal(proof.parentSessionId, 'parent-session')
  assert.equal(proof.startSequence, 3)
  for (const mutate of [
    value => { value.history.verified = false },
    value => { value.after.sessionId = 'old' },
    value => { value.parentAfter.sessionId = 'wrong-parent-session' },
    value => { value.after.parentId = 'wrong-parent' },
    value => { value.after.tier = 'other-tier' },
    value => { value.records[1].details.agentId = 'wrong-child' },
    value => { value.records[1].signature = '' },
    value => { value.records[1].eventHash = 'not-a-signed-hash' },
    value => { value.records[2].outcome.result = 'refused' },
    value => { value.records[2].outcome.resolves = 9 },
    value => { value.records.push({ ...value.records[1], sequence: 5 }) },
    value => { value.records.push({ ...value.records[2], sequence: 6 }) },
  ]) {
    const changed = evidence()
    mutate(changed)
    assert.throws(() => check(changed))
  }
})

function fallbackEvidence() {
  const value = evidence()
  const [old, start, outcome] = value.records
  value.records = [old,
    { ...start, sequence: 2, sessionId: 'refused-thread' },
    { ...outcome, sequence: 3, sessionId: 'refused-thread', outcome: { resolves: 2, result: 'refused', reason: 'CODEX_APP_SERVER_ERROR' } },
    { ...start, sequence: 4 },
    { ...outcome, sequence: 5, outcome: { resolves: 4, result: 'started' } },
  ]
  return value
}

test('one signed refused saved-thread attempt may precede the one successful replacement', () => {
  const proof = check(fallbackEvidence())
  assert.equal(proof.startSequence, 4)
  assert.deepEqual(proof.refusedAttempts, [{ sessionId: 'refused-thread', startSequence: 2, startHash: 'a'.repeat(64),
    outcomeSequence: 3, outcomeHash: 'b'.repeat(64), reason: 'CODEX_APP_SERVER_ERROR' }])
  assert.match(proof.ledgerSha256, /^[a-f0-9]{64}$/)
  assert.equal(proof.verifiedHistoryTotal, 5)
  assert.equal(proof.outcomeSequence, 5)
  assert.equal(proof.outcomeHash, 'b'.repeat(64))
})

test('fallback evidence rejects extra starts, unresolved attempts, missing reasons and reordered outcomes', () => {
  for (const mutate of [
    value => { value.records[2].outcome.result = 'started' },
    value => { value.records.splice(2, 1) },
    value => { value.records[2].outcome.reason = '' },
    value => { value.records[2].outcome.result = 'unknown' },
    value => { value.records[2].outcome.reason = 'Unbounded internal detail' },
    value => { value.records[2].sessionId = 'wrong-session' },
    value => { value.records[2].details.agentId = 'wrong-child' },
    value => { value.records[2].sequence = 6 },
    value => { value.records[2].signature = '' },
    value => { value.records[2].eventHash = 'unsigned' },
    value => { value.records[1].sessionId = 'replacement' },
    value => { value.records[1].sessionId = ''; value.records[2].sessionId = '' },
    value => { value.records[1].sessionId = 'old'; value.records[2].sessionId = 'old' },
    value => { value.records[1].details.agentId = 'wrong-child' },
    value => { value.records.push({ ...value.records[1], sequence: 6, sessionId: 'third-attempt' }) },
    value => { value.records.push({ ...value.records[2], sequence: 6 }) },
  ]) {
    const changed = fallbackEvidence()
    mutate(changed)
    assert.throws(() => check(changed))
  }
})

test('source-forbidden saved-account refusals cannot gain credit through a successful fallback', () => {
  for (const reason of ['AGENT_RESUME_ACCOUNT_UNAVAILABLE', 'AGENT_RESUME_ACCOUNT_LIMIT', 'AGENT_RESUME_ACCOUNT_SIGNED_OUT']) {
    assert.equal(savedAccountResumeRefused(reason), true)
    const value = fallbackEvidence()
    value.records[2].outcome.reason = reason
    assert.throws(() => check(value), /refused saved account/)
  }
  assert.equal(savedAccountResumeRefused('CODEX_APP_SERVER_ERROR'), false)
  assert.equal(check(fallbackEvidence()).refusedAttempts[0].reason, 'CODEX_APP_SERVER_ERROR')
})

test('verified history binds identical ledger bytes, total and every returned entry field', () => {
  assert.equal(assertVerifiedSessionSnapshot(snapshot(fallbackEvidence())).records.length, 5)
  for (const mutate of [
    value => { value.ledgerAfter = Buffer.from(value.ledgerBefore.toString().replace('replacement', 'changed-one')) },
    value => { value.history.total-- },
    value => { value.history.entries.pop() },
    value => { value.history.entries.reverse() },
    value => { value.history.entries[0].outcome = { resolves: 99, result: 'started' } },
    ...['sequence', 'at', 'action', 'sessionId', 'principal', 'usage', 'end'].map(field => value => { value.history.entries[0][field] = 'changed' }),
  ]) {
    const changed = snapshot(fallbackEvidence())
    mutate(changed)
    assert.throws(() => assertVerifiedSessionSnapshot(changed))
  }
})

test('a replacement outside the verified returned tail cannot earn snapshot credit', () => {
  const value = fallbackEvidence()
  value.records.push(...Array.from({ length: 201 }, (_, index) => ({ sequence: 6 + index, action: 'agent_session_end', sessionId: 'older-session' })))
  assert.throws(() => check(value), /verified history snapshot/)
})

test('snapshot projection matches the maintained recorder history API in a source fixture', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'page2-history-projection-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  // An opaque in-memory keystore fixture, never a native encryption claim.
  const held = new Map()
  const recorder = createSpawnRecorder({ directory, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => { const token = `fixture-${held.size}`; held.set(token, value); return Buffer.from(token) },
    decryptString: value => held.get(value.toString()),
  } })
  recorder.record({ action: 'agent_session_start', sessionId: 'fixture-child', principal: 'unauthenticated', details: { agentId: 'child' } })
  recorder.record({ action: 'agent_session_outcome', sessionId: 'fixture-child', principal: 'unauthenticated', outcome: { result: 'started', resolves: 1 } })
  recorder.record({ action: 'agent_session_end', sessionId: 'fixture-child', principal: 'unauthenticated', end: { resolves: 1, reason: 'closed', turns: 2, lastTurnStatus: 'completed' } })
  const ledgerBefore = readFileSync(recorder.ledgerPath)
  const history = await recorder.historyAsync({ limit: 200 })
  const ledgerAfter = readFileSync(recorder.ledgerPath)
  assert.equal(assertVerifiedSessionSnapshot({ ledgerBefore, history, ledgerAfter }).verifiedHistoryTotal, 3)
  assert.equal(history.entries[0].eventHash, undefined)
})

const first = 'first recovery prompt'
const second = 'second recovery prompt'
const ordered = () => [
  { role: 'user', text: first }, { role: 'agent', text: 'PAGE2_CHILD_RECOVERY_FIRST' },
  { role: 'user', text: second }, { role: 'agent', text: 'PAGE2_CHILD_RECOVERY_SECOND' },
]
test('recovery transcript proves first user/reply before second user/reply exactly once', () => {
  assert.deepEqual(assertRecoveryMessageOrder(ordered(), first, second), { firstUser: 0, firstReply: 1, secondUser: 2, secondReply: 3 })
  const actualReversal = ordered()
  assert.throws(() => assertRecoveryMessageOrder([...actualReversal.slice(2), ...actualReversal.slice(0, 2)], first, second), /first recovery message/)
  assert.throws(() => assertRecoveryMessageOrder(ordered().slice(0, 3), first, second), /exactly once/)
  assert.throws(() => assertRecoveryMessageOrder([...ordered(), ordered()[0]], first, second), /exactly once/)
  assert.throws(() => assertRecoveryMessageOrder([...ordered(), ordered()[3]], first, second), /exactly once/)
})
