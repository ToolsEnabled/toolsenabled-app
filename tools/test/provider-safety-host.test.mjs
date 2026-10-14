import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { sessionTurnStatus, sessionTurnFailureText, nodeStatusForTurn } from '../../src/agent-session-events.js'

const req = createRequire(import.meta.url)
const { createAgentHost } = req('../../shell/agent-host.cjs')
const { createNodeTranscriptCapture } = req('../../shell/node-transcript-capture.cjs')
const { createAppContextReader } = req('../../shell/app-context.cjs')
const { limitReason } = req('../../shell/account-session-recovery.cjs')
const enginePath = req.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const provider = req('./fixtures/confined-engine/src/lib/providers/agent-comms-local.js')
const directory = req('./fixtures/confined-engine/src/lib/agent-comms/tree-node-directory.js')
const engine = req(enginePath)
const sentence = 'This request was blocked by our safety systems. Reason: Synthetic prohibited action.'

for (const code of ['misalignmentPolicyViolation', 'misalignment_policy_violation']) {
  test(`a safety-refused session retains peer messages without activation and remains closeable: ${code}`, async t => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-terminal-'))
    provider.reset(); directory.reset(); engine.calls.length = 0; engine.adapterCalls.length = 0
    let clock = Date.now(), continuationOptions, current
    const realNow = Date.now
    Date.now = () => clock
    const ended = [], packets = [], retained = []
    const providerPath = req.resolve('./fixtures/confined-engine/src/lib/providers/agent-comms-local.js')
    req.cache[providerPath].exports = { ...provider, defer: async input => { retained.push(input); return { accepted: true } }, discard: async input => { retained.push(input); return { accepted: true } } }
    const scheduler = new Proxy({}, { get: (_, key) => key === 'enabled' ? () => false
      : key === 'started' ? session => { current = session }
        : key === 'instructions' ? () => null : () => null })
    const host = createAgentHost({ enginePath, defaultCwd: scratch, freeMemory: () => 64 * 1024 ** 3,
      treeCourier: { pollMs: 10, heartbeatMs: 1000, readDeadlineMs: 100 },
      assertTranscriptWritable: () => {}, messageDeliveryReader: () => ({ mode: 'instant', intervalMs: 30000 }),
      ledgerContinuationLoader: () => ({ createLedgerContinuation: options => { continuationOptions = options; return scheduler } }),
      confinementPlanner: () => ({ ok: true, tier: 'standard', isolated: true,
        threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
        env: { CODEX_HOME: path.join(scratch, 'synthetic-home') }, servers: ['toolsenabled-readonly', 'toolsenabled'] }) })
    t.after(async () => { await host.closeAll(); req.cache[providerPath].exports = provider; Date.now = realNow; provider.reset(); directory.reset(); fs.rmSync(scratch, { recursive: true, force: true }) })
    host.onEvent(packet => { packets.push(packet); if (packet.event.type === 'turn_completed') ended.push(packet) })
    await host.startSession({ sessionId: 'synthetic-recipient', treeIdentity: { selfName: 'Synthetic recipient', managerName: null } })
    await host.setGoal({ sessionId: 'synthetic-recipient', objective: 'Perform a synthetic bounded check.' })
    assert.equal(engine.adapterCalls.filter(row => row.method === 'sendTurn').length, 1)
    engine.calls.at(-1).onEvent({ type: 'assistant_text_delta', threadId: 'thread-1', turnId: 't1', text: '[[GOAL-ACHIEVED]]' })
    const failure = { provider: 'codex', source: 'turn', code, summary: sentence, category: 'safety-policy', retryable: false }
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed', text: sentence, payload: { failure } })
    const terminal = ended.at(-1)
    assert.equal(terminal.event.status, 'failed')
    assert.equal(sessionTurnStatus(terminal, 'synthetic-recipient'), 'failed')
    assert.equal(nodeStatusForTurn(sessionTurnStatus(terminal, 'synthetic-recipient')), 'turn-failed')
    assert.equal(sessionTurnFailureText(terminal, 'synthetic-recipient'), sentence)
    const transcript = []
    const capture = createNodeTranscriptCapture({ store: { append: async request => { transcript.push(...request.entries); return { ok: true, durable: true } }, getStorageStatus: () => ({ durable: true }) } })
    capture.bind({ computerId: 'synthetic-computer', nodeId: 'synthetic-node', sessionId: 'synthetic-recipient' })
    await capture.packet(terminal)
    await capture.shutdown()
    assert.equal(transcript.at(-1).text, sentence)
    assert.equal(host.sessionActivity('synthetic-recipient').goal.status, 'paused')
    const ownerWindow = { isDestroyed: () => false, getURL: () => 'http://localhost/#/computers' }
    const sessions = new Map([['synthetic-recipient', { agentId: 'synthetic-agent', ownerKind: 'window', owner: ownerWindow,
      state: 'ready', lastTurnStatus: terminal.event.status, turnsCompleted: 1 }]])
    const reader = createAppContextReader({ sessions, readActivity: id => host.sessionActivity(id),
      readOrg: () => ({ ok: true, org: { agents: [], relationships: [], revision: 1 }, roles: [] }) })
    const context = reader.read({ sessionId: 'synthetic-recipient', agentId: 'synthetic-agent' })
    assert.equal(context.sessions[0].lastTurnStatus, 'failed')
    assert.equal(context.sessions[0].activity.automaticTurnBlock.code, 'PROVIDER_SAFETY_REFUSAL')
    for (let i = 0; i < 3; i++) {
      provider.deliver({ recipientAgentId: directory.agentIdForSession('synthetic-recipient'), senderAgentId: 'synthetic-sender', body: 'Synthetic retained report ' + i })
      clock += 30000
      await delay(45)
    }
    const activity = host.sessionActivity('synthetic-recipient')
    assert.equal(activity.busy, false)
    assert.equal(activity.courier.queuedMessages, 3)
    assert.equal(activity.courier.handoffPending, false)
    assert.equal(activity.courier.retryAfterMs, 0, 'the courier must hold the message without repeatedly attempting a blocked send')
    assert.equal(continuationOptions.canSend(current), false)
    for (const origin of ['agent', 'goal', 'continuation', 'person-queued', 'brief', 'automatic']) {
      await assert.rejects(host.sendTurn({ sessionId: 'synthetic-recipient', text: 'Synthetic automatic attempt', origin }), { code: 'PROVIDER_SAFETY_REFUSAL' })
    }
    assert.equal(engine.adapterCalls.filter(row => row.method === 'sendTurn' || row.method === 'steerTurn').length, 1)
    assert.equal(packets.filter(packet => packet.event.type === 'account_recovery_needed').length, 0, 'a safety refusal never emits an account recovery ticket')
    assert.equal(engine.calls.length, 1, 'no backup-account session was started')
    assert.doesNotMatch(JSON.stringify(context), /Synthetic retained report/)
    await host.sendTurn({ sessionId: 'synthetic-recipient', text: 'A distinct synthetic person request.', origin: 'person' })
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
    clock += 30000
    await delay(45)
    const later = host.sessionActivity('synthetic-recipient')
    assert.equal(later.lastTurnStatus, 'completed', 'latest success and persistent automatic hold are separate facts')
    assert.equal(later.automaticTurnBlock.code, 'PROVIDER_SAFETY_REFUSAL')
    assert.equal(later.courier.queuedMessages, 3)
    assert.equal(later.courier.handoffPending, false)
    assert.equal(continuationOptions.canSend(current), false)
    assert.equal(engine.adapterCalls.filter(row => row.method === 'sendTurn' || row.method === 'steerTurn').length, 2)
    await host.closeSession({ sessionId: 'synthetic-recipient' })
    assert.equal(host.sessionActivity('synthetic-recipient'), null)
    assert.equal(retained.length, 3, 'every queued message receives a durable custody receipt before closing')
  })
}

/* 1.0.50 review CM-2. A provider that refused this session's model would refuse every automatic send the same
   way: helper reports wait with the courier, automatic origins are refused, the person's own send is taken, and
   the turn it starts succeeding releases the hold so the waiting reports go. */
test('a model-refused session holds helper reports and automatic turns until a turn succeeds', async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'model-refused-'))
  provider.reset(); directory.reset(); engine.calls.length = 0; engine.adapterCalls.length = 0
  let clock = Date.now(), continuationOptions, current
  const realNow = Date.now
  Date.now = () => clock
  const scheduler = new Proxy({}, { get: (_, key) => key === 'enabled' ? () => false
    : key === 'started' ? session => { current = session }
      : key === 'instructions' ? () => null : () => null })
  const host = createAgentHost({ enginePath, defaultCwd: scratch, freeMemory: () => 64 * 1024 ** 3,
    treeCourier: { pollMs: 10, heartbeatMs: 1000, readDeadlineMs: 100 },
    assertTranscriptWritable: () => {}, messageDeliveryReader: () => ({ mode: 'instant', intervalMs: 30000 }),
    ledgerContinuationLoader: () => ({ createLedgerContinuation: options => { continuationOptions = options; return scheduler } }),
    confinementPlanner: () => ({ ok: true, tier: 'standard', isolated: true,
      threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(scratch, 'synthetic-home') }, servers: ['toolsenabled-readonly', 'toolsenabled'] }) })
  t.after(async () => { await host.closeAll(); Date.now = realNow; provider.reset(); directory.reset(); fs.rmSync(scratch, { recursive: true, force: true }) })
  const ended = []
  host.onEvent(packet => { if (packet.event.type === 'turn_completed') ended.push(packet) })
  await host.startSession({ sessionId: 'synthetic-model', treeIdentity: { selfName: 'Synthetic model recipient', managerName: null } })
  const sent = () => engine.adapterCalls.filter(row => row.method === 'sendTurn' || row.method === 'steerTurn').length
  await host.sendTurn({ sessionId: 'synthetic-model', text: 'A synthetic first request.', origin: 'person' })
  const said = "Codex refused this model: The 'my-typed-model' model is not supported."
  engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'failed', text: said,
    payload: { failure: { provider: 'codex', source: 'turn', code: 'other', summary: said, category: 'model-refused' } } })
  assert.equal(ended.at(-1).event.status, 'failed', 'a model refusal keeps its own status')
  assert.equal(ended.at(-1).event.text, said, 'and its own words')
  assert.deepEqual(host.sessionActivity('synthetic-model').automaticTurnBlock, { code: 'PROVIDER_MODEL_REFUSED', reason: 'model-refused' })
  const before = sent()
  for (let i = 0; i < 2; i++) {
    provider.deliver({ recipientAgentId: directory.agentIdForSession('synthetic-model'), senderAgentId: 'synthetic-sender', body: 'Synthetic helper report ' + i })
    clock += 30000
    await delay(45)
  }
  const held = host.sessionActivity('synthetic-model')
  assert.equal(held.courier.queuedMessages, 2)
  assert.equal(held.courier.retryAfterMs, 0, 'the courier holds the reports without attempting a send')
  assert.equal(continuationOptions.canSend(current), false)
  for (const origin of ['agent', 'goal', 'continuation', 'automatic']) {
    await assert.rejects(host.sendTurn({ sessionId: 'synthetic-model', text: 'Synthetic automatic attempt', origin }), { code: 'PROVIDER_MODEL_REFUSED' })
  }
  assert.equal(sent(), before, 'nothing automatic reached the refused model')
  await host.sendTurn({ sessionId: 'synthetic-model', text: 'A synthetic person request on another model.', origin: 'person' })
  assert.equal(sent(), before + 1, 'the person\u2019s own send is always taken')
  engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
  assert.equal(host.sessionActivity('synthetic-model').automaticTurnBlock, undefined, 'a successful turn releases the hold')
  for (let i = 0; i < 20 && host.sessionActivity('synthetic-model').courier.queuedMessages === 2; i++) {
    clock += 30000
    await delay(45)
  }
  assert.ok(sent() > before + 1, 'the waiting helper reports are delivered once the hold ends')
  assert.ok(host.sessionActivity('synthetic-model').courier.queuedMessages < 2)
})

test('provider safety refusal cannot be mistaken for quota recovery even if its reason mentions limits', () => {
  for (const code of ['misalignmentPolicyViolation', 'misalignment_policy_violation']) {
    assert.equal(limitReason({ type: 'turn_completed', status: 'failed', text: 'You have reached your usage limit.', payload: { failure: { code } } }), null)
  }
  assert.equal(limitReason({ type: 'turn_completed', status: 'failed', text: 'You have reached your usage limit.' }), 'account-limit')
})
