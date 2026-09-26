/* B29: with audit off (Basic, the default since an earlier commit), the shell answers a
 * bounded start with the engine's unsigned not-required receipt
 * (main.cjs recordSpawnIntent -> operation.skippedStatus('controller.agent.launch',
 * sessionId); agent-command-surface.cjs agent:start / agent:work-status `record`),
 * and a close with { ...started, action: 'agent_session_end', target: sessionId }
 * (main.cjs recordSessionEndImpl). The renderer's controller must accept those
 * exact receipts, start the Team's members, and confirm Stop -- while still
 * refusing a Basic receipt for another session or one carrying a sequence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createTreeWorkController, verifiedTreeWork, verifiedTreeWorkStatus } from '../../src/tree-bounded-work.js'

// The engine's operation-audit.js skippedStatus shape, exactly 12 keys.
const basic = (action, target) => ({ action, target, ok: true, disposition: 'not-required', required: false,
  recorded: false, durable: false, anchored: false, signed: false, sequence: null, eventId: null, eventHash: null })
const plan = { computerId: 'this-computer', treeId: 'tree-1', parentNodeId: 'controller', parentSessionId: 'controller-session',
  tier: 'claude-sonnet-5', effort: null, capMs: 1_200_000, brief: 'Every member: reply TEAMOK.', members: ['claude-haiku-4-5'] }

function basicStart(request, index) {
  const sessionId = `session-${index}`, nodeId = `node-${index}`
  // capMs one ms short: inheritBoundedWork re-caps a direct child to its own remaining time.
  return { ok: true, sessionId, nodeId, record: basic('controller.agent.launch', sessionId), boundedWork: {
    action: 'tree.dispatch', computerId: request.computerId, treeId: request.treeId,
    parentNodeId: request.parentNodeId, parentSessionId: request.parentSessionId,
    sessionId, nodeId, agentId: nodeId, capMs: request.capMs - 3, startedAt: 1000, deadlineAt: 1000 + request.capMs,
    state: 'ready', reason: null, endedAt: null } }
}

function fixture() {
  const starts = [], closes = [], statuses = new Map()
  const controller = createTreeWorkController({ kind: 'team',
    start: async request => {
      starts.push(request)
      const result = basicStart(request, starts.length)
      statuses.set(result.sessionId, { ok: true, ...result.boundedWork, state: 'ready', record: result.record, audit: result.record, endRecord: null })
      return result
    },
    readStatus: async sessionId => statuses.get(sessionId),
    close: async sessionId => {
      closes.push(sessionId)
      const status = statuses.get(sessionId)
      statuses.set(sessionId, { ...status, state: 'closed', endRecord: { ...status.record, action: 'agent_session_end', target: sessionId } })
      return { ok: true }
    },
    isBusy: () => false,
    setTimer: () => null, clearTimer: () => {},
  })
  return { controller, starts, closes, statuses }
}

test('B29: a Team under Basic audit starts its lead, then each member under that lead', async () => {
  const f = fixture()
  await f.controller.run(plan)
  const state = f.controller.getState()
  assert.equal(state.rows[0]?.phase, 'started', `lead row: ${state.rows[0]?.detail}`)
  assert.equal(f.starts.length, 2, 'the ticked member was started')
  assert.equal(f.starts[1].tier, 'claude-haiku-4-5')
  assert.equal(f.starts[1].parentNodeId, 'node-1', 'the member reports to the lead circle')
  assert.equal(f.starts[1].parentSessionId, 'session-1')
  assert.equal(state.phase, 'active')
  assert.doesNotMatch(state.message, /could not be confirmed/)
})

test('B29: Stop is confirmed from the Basic end receipts', async () => {
  const f = fixture()
  await f.controller.run(plan)
  await f.controller.stop()
  assert.deepEqual(f.closes, ['session-2', 'session-1'])
  assert.equal(f.controller.getState().phase, 'stopped')
})

test('B29: a Basic receipt still binds to its own session and cannot carry a sequence', () => {
  const result = basicStart(plan, 1)
  assert.equal(verifiedTreeWork(result, plan), true)
  assert.equal(verifiedTreeWork({ ...result, record: basic('controller.agent.launch', 'session-9') }, plan), false, 'another session\'s receipt')
  assert.equal(verifiedTreeWork({ ...result, record: basic('agent_session_end', 'session-1') }, plan), false, 'wrong action')
  assert.equal(verifiedTreeWork({ ...result, record: { ...basic('controller.agent.launch', 'session-1'), sequence: 4 } }, plan), false, 'Basic with a sequence')
  assert.equal(verifiedTreeWork({ ...result, record: { ...basic('controller.agent.launch', 'session-1'), extra: 1 } }, plan), false, 'extra key')
  assert.equal(verifiedTreeWork({ ...result, record: null }, plan), false)
  assert.equal(verifiedTreeWork({ ...result, record: { sequence: 1, eventHash: 'unsigned' } }, plan), false)
  assert.equal(verifiedTreeWork({ ...result, record: { sequence: 1, eventHash: 'a'.repeat(64) } }, plan), true, 'audited receipts still pass')
  const status = { ok: true, ...result.boundedWork, state: 'closed', record: result.record,
    endRecord: { ...result.record, action: 'agent_session_end', target: 'session-1' } }
  assert.equal(verifiedTreeWorkStatus(status, result.boundedWork, { closed: true }), true)
  assert.equal(verifiedTreeWorkStatus({ ...status, endRecord: { ...status.endRecord, target: 'session-2' } }, result.boundedWork, { closed: true }), false)
  assert.equal(verifiedTreeWorkStatus({ ...status, endRecord: status.record }, result.boundedWork, { closed: true }), false, 'a start receipt is not an end')
  assert.equal(verifiedTreeWorkStatus({ ...status, endRecord: null }, result.boundedWork, { closed: true }), false)
})
