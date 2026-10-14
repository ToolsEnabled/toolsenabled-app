import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

/* A REFUSED HANDOFF IS RETRIED ON A TIME BUDGET, NOT ON RAPID COURIER TICKS (T1743).
 *
 * Builder 2's host packet: five offers separated by 5, 10, 20 and 30 seconds
 * before a refused batch is set aside, so a refusal that clears within a
 * minute is delivered once. Known admission waits (a transcript store or
 * rules context that is not ready) keep the batch queued without spending
 * that budget, a failed receipt write never resends an accepted model turn,
 * an uncertain steer is never counted as a retryable refusal, and the sender
 * sees only a code-shaped refusal reason. These are Builder 2's own cases,
 * moved from the packet's standalone runner into the repository. The bound
 * on an admission wait itself is proved in tree-handoff-admission-cap.test.mjs. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const req = createRequire(path.join(root, 'package.json'))
const { createAgentHost } = req(path.join(root, 'shell/agent-host.cjs'))
const fixture = path.join(root, 'tools/test/fixtures/confined-engine/src/lib')
const enginePath = path.join(fixture, 'agent-engine/codex-process.js')
const providerPath = path.join(fixture, 'providers/agent-comms-local.js')
const engine = req(enginePath), provider = req(providerPath)
const directory = req(path.join(fixture, 'agent-comms/tree-node-directory.js'))
const realNow = Date.now

async function until(fn, msg) {
  const end = realNow() + 1000
  while (realNow() < end) { if (fn()) return; await delay(10) }
  assert.fail(msg)
}

async function setup(t, { mode = 'temporary', code = 'SYNTHETIC_TEMPORARY_REFUSAL', receiptFailures = 0, deliverOnStart = true,
  receiptCode = null } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-handoff-backoff-'))
  provider.reset(); directory.reset()
  let clock = realNow(), blocked = true, receiptCalls = 0
  const start = clock
  Date.now = () => clock
  const attempts = [], discards = [], events = [], steers = []
  const error = () => Object.assign(Error('Synthetic refusal private detail not for receipt'), { code, rpcCode: -32001 })
  req.cache[req.resolve(enginePath)].exports = { ...engine, startCodexSession: async () => ({ threadId: 'thread-synthetic', close() {}, adapter: {
    sendTurn: async request => {
      attempts.push({ at: clock, text: request.text })
      if (mode === 'permanent' || (mode === 'temporary' && clock - start < 5000)) throw error()
      return { turnId: 'accepted-turn' }
    },
    steerTurn: async request => { steers.push(request); throw Object.assign(Error('ambiguous synthetic steer'), { code: 'CODEX_STEER_RESPONSE_INVALID' }) },
    interrupt: async () => {},
  } }) }
  req.cache[req.resolve(providerPath)].exports = { ...provider,
    inbox: async input => {
      const result = await provider.inbox(input)
      return receiptCode === null ? result : { page: { ...result.page, deliveryReceipts: [{
        code: 'BROKER_MESSAGE_DEAD_LETTERED', messageId: 'synthetic-failed-envelope', recipientAgentId: 'synthetic-other',
        reason: 'RECIPIENT_QUEUE_DISCARDED', at: clock, refusalCode: receiptCode,
      }] } }
    },
    discard: async input => { discards.push({ ...input, at: clock }); return { accepted: true } },
    defer: async () => ({ accepted: true }),
    acknowledgeDeferred: async () => {
      receiptCalls++
      if (receiptCalls <= receiptFailures) throw Error('Synthetic receipt write unavailable')
      return { accepted: true }
    },
  }
  const host = createAgentHost({ enginePath, defaultCwd: scratch, freeMemory: () => 64 * 1024 ** 3,
    treeCourier: { pollMs: 15, heartbeatMs: 1000, readDeadlineMs: 100 },
    assertTranscriptWritable: () => {
      if (mode === 'transcript' && blocked) throw Object.assign(Error('Synthetic transcript admission refused'), { code: 'MC_TRANSCRIPT_STORAGE_FAILED' })
    },
    messageDeliveryReader: () => ({ mode: 'instant', intervalMs: 30000 }),
    confinementPlanner: () => ({ ok: true, tier: 'standard', isolated: true,
      threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(scratch, 'synthetic-agent-home') }, servers: ['toolsenabled-readonly', 'toolsenabled'] }) })
  host.onEvent(event => events.push(event))
  t.after(async () => {
    await host.closeAll()
    Date.now = realNow
    req.cache[req.resolve(enginePath)].exports = engine
    req.cache[req.resolve(providerPath)].exports = provider
    provider.reset(); directory.reset()
    fs.rmSync(scratch, { recursive: true, force: true })
  })
  await host.startSession({ sessionId: 'synthetic-recipient', treeIdentity: { selfName: 'Synthetic recipient', managerName: null } })
  const deliver = () => provider.deliver({ recipientAgentId: directory.agentIdForSession('synthetic-recipient'),
    senderAgentId: 'synthetic-sender', body: 'Synthetic retained assignment' })
  if (deliverOnStart) deliver()
  return { host, attempts, discards, events, steers, deliver, unblock: () => { blocked = false },
    receiptCalls: () => receiptCalls, step: async ms => { clock += ms; await delay(45) } }
}

test('a refusal lasting five seconds is delivered once after backoff', async t => {
  const f = await setup(t)
  await f.step(0)
  assert.equal(f.discards.length, 0, 'transient refusal was discarded on rapid poll ticks')
  assert.equal(f.attempts.length, 1, 'retry ignored backoff')
  await f.step(4999)
  assert.equal(f.attempts.length, 1)
  await f.step(1)
  await until(() => f.attempts.length === 2, 'retry did not resume at five seconds')
  await f.step(100000)
  assert.equal(f.discards.length, 0); assert.equal(f.attempts.length, 2)
  assert.equal(provider.readReceiptsSeen().length, 1)
})

test('terminal refusal retries span at least one minute and carry only the code', async t => {
  const f = await setup(t, { mode: 'permanent' })
  await f.step(0)
  for (const ms of [5000, 10000, 20000, 29999]) {
    await f.step(ms)
    assert.equal(f.discards.length, 0, 'discard before minimum retry window')
  }
  await f.step(1)
  await until(() => f.discards.length === 1, 'exhausted refusal not retained')
  assert.equal(f.attempts.length, 5); assert.ok(f.discards[0].at - f.attempts[0].at >= 60000)
  assert.deepEqual(f.attempts.slice(1).map((a, i) => a.at - f.attempts[i].at), [5000, 10000, 20000, 30000])
  assert.equal(f.discards[0].refusalCode, 'SYNTHETIC_TEMPORARY_REFUSAL')
  assert.equal('error' in f.discards[0], false); assert.doesNotMatch(JSON.stringify(f.discards), /private detail/)
})

test('real transcript admission wait survives the retry window without dispatch or discard', async t => {
  const f = await setup(t, { mode: 'transcript' })
  await f.step(0)
  for (let n = 0; n < 8; n++) await f.step(30000)
  assert.equal(f.discards.length, 0); assert.equal(f.attempts.length, 0)
  f.unblock()
  await f.step(30000)
  await until(() => f.attempts.length === 1, 'repaired transcript admission did not deliver')
  assert.equal(f.discards.length, 0)
})

test('failed receipt persistence does not resend an accepted model turn', async t => {
  const f = await setup(t, { mode: 'accept', receiptFailures: 2 })
  await until(() => f.receiptCalls() >= 3, 'receipt retry did not finish')
  await f.step(100000)
  assert.equal(f.attempts.length, 1); assert.equal(f.discards.length, 0)
})

test('ambiguous steering remains held and is never counted as retryable refusal', async t => {
  const f = await setup(t, { mode: 'accept', deliverOnStart: false })
  await f.host.sendTurn({ sessionId: 'synthetic-recipient', text: 'Synthetic person turn' })
  f.deliver()
  await until(() => f.steers.length === 1, 'steer was not attempted')
  for (let n = 0; n < 4; n++) await f.step(30000)
  assert.equal(f.steers.length, 1); assert.equal(f.attempts.length, 1); assert.equal(f.discards.length, 0)
  assert.match(JSON.stringify(f.events), /could not be confirmed/)
})

for (const [receiptCode, expected] of [['SYNTHETIC_PROVIDER_REFUSED', true], ['unsafe/private detail', false]]) {
  test('sender sees a bounded refusal code; valid=' + expected, async t => {
    const f = await setup(t, { mode: 'accept', deliverOnStart: false, receiptCode })
    await until(() => f.attempts.length === 1, 'sender receipt did not reach its model')
    if (expected) assert.match(f.attempts[0].text, /Underlying refusal: SYNTHETIC_PROVIDER_REFUSED/)
    else assert.doesNotMatch(f.attempts[0].text, /unsafe|private detail|Underlying refusal:/)
  })
}
