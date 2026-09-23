import assert from 'node:assert/strict'
import test from 'node:test'
import { assertNativeWorkEvidence, scenarios } from '../lib/page2-native-bounded-scenarios.cjs'

// These are unit fixtures for the native replay's proof checker, not native
// provider receipts or acceptance evidence. Native scenarios obtain every
// value from their actual isolated app, saved tree and signed run ledger.
function fixture() {
  const parent = { id: 'manager', sessionId: 'manager-session', treeId: 'saved-tree' }
  const row = { nodeId: 'worker', sessionId: 'worker-session' }
  const work = { action: 'tree.dispatch', computerId: 'computer', treeId: parent.treeId,
    parentNodeId: parent.id, parentSessionId: parent.sessionId, ...row, agentId: row.nodeId,
    capMs: 60000, startedAt: 1000, deadlineAt: 61000 }
  const record = { sequence: 1, eventHash: 'a'.repeat(64) }
  const endRecord = { sequence: 3, eventHash: 'c'.repeat(64) }
  const saved = { computerId: 'computer', nodes: [parent, { id: row.nodeId, sessionId: row.sessionId,
    parentId: parent.id, treeId: parent.treeId, tier: 'astra', effort: 'max' }] }
  const records = [{ ...record, action: 'agent_session_start', sessionId: row.sessionId,
    signature: 'UNIT_FIXTURE_ONLY', details: { agentId: row.nodeId, boundedWork: { ...work } } },
  { sequence: 2, action: 'agent_session_outcome', sessionId: row.sessionId, outcome: { resolves: 1, result: 'started' } },
  { ...endRecord, action: 'agent_session_end', sessionId: row.sessionId,
    signature: 'UNIT_FIXTURE_ONLY', details: { boundedWork: { ...work } }, end: { resolves: 1, reason: 'cap-reached' } }]
  return { row, saved, parent, status: { ok: true, ...work, state: 'closed', reason: 'cap-reached', record, endRecord },
    records, history: { ok: true, verified: true }, capMs: 60000, closed: true, reason: 'cap-reached' }
}

test('the bounded native checker correlates saved parent, started outcome and exact retained start/end receipts', () => {
  const value = fixture()
  const result = assertNativeWorkEvidence(value)
  assert.equal(result.parentSessionId, value.parent.sessionId)
  assert.equal(result.record.eventHash, value.records[0].eventHash)
  assert.equal(result.endRecord.eventHash, value.records[2].eventHash)
  assert.equal(result.reason, 'cap-reached')
})

test('an inherited remaining cap need not equal the duration since the earlier admission timestamp', () => {
  const value = fixture()
  value.status.capMs = 498
  value.status.deadlineAt = 1500
  for (const row of [value.records[0], value.records[2]]) {
    row.details.boundedWork.capMs = 498
    row.details.boundedWork.deadlineAt = 1500
  }
  assert.equal(assertNativeWorkEvidence(value).capMs, 498)
})

for (const [label, change] of [
  ['unverified ledger', value => { value.history.verified = false }],
  ['different visible node', value => { value.row.nodeId = 'another-node' }],
  ['different actual parent session', value => { value.status.parentSessionId = 'another-parent-session' }],
  ['saved child under a different parent', value => { value.saved.nodes[1].parentId = 'another-parent' }],
  ['signed attribution disagrees with the returned scope', value => { value.records[0].details.boundedWork.parentNodeId = 'another-parent' }],
  ['unsigned start receipt', value => { value.status.record.eventHash = '' }],
  ['start intent whose outcome refused', value => { value.records[1].outcome.result = 'refused' }],
  ['missing started outcome', value => { value.records.splice(1, 1) }],
  ['duplicate start intent', value => { value.records.push({ ...value.records[0] }) }],
  ['close still pending', value => { value.status.state = 'closing' }],
  ['missing cleanup receipt', value => { value.status.endRecord = null }],
  ['ending resolves another start', value => { value.records[2].end.resolves = 44 }],
  ['ending belongs to another session', value => { value.records[2].sessionId = 'another-session' }],
  ['different terminal reason', value => { value.records[2].end.reason = 'closed' }],
  ['longer cap than the visible request', value => { value.status.capMs = 60001 }],
]) {
  test(`native bounded evidence refuses ${label}`, () => {
    const value = fixture()
    change(value)
    assert.throws(() => assertNativeWorkEvidence(value), assert.AssertionError)
  })
}

test('native bounded scenarios declare provider prerequisites and leave the main parent running', () => {
  assert.deepEqual(scenarios.map(scenario => scenario.id), ['bounded-launch-stop', 'bounded-team-stop',
    'bounded-loop-navigation-stop', 'bounded-cap-cleanup', 'bounded-parent-stop-cleanup'])
  assert.equal(scenarios[0].requires[0], 'root-start')
  const reached = new Set(['root-start'])
  for (const scenario of scenarios) {
    assert.ok(scenario.requires.every(id => reached.has(id)), `${scenario.id} must follow its prerequisite`)
    assert.ok(scenario.controls.some(id => id.startsWith('D')))
    assert.equal(typeof scenario.run, 'function')
    reached.add(scenario.id)
  }
})
