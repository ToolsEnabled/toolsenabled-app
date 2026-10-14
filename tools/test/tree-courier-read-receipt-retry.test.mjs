import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

/* A REFUSED READ RECEIPT IS RETRIED WITHOUT SENDING THE MODEL TURN AGAIN (T1742).
 *
 * Builder 2's host packet: after the model accepts a batch, a refused or
 * failed read receipt stays with that batch and only the receipt is retried.
 * Receipts stay in order, a gap ahead of them is never skipped, a lost answer
 * is settled from the authenticated cursor the engine returns, and an
 * uncertain mid-turn delivery never records a receipt. These are Builder 2's
 * own cases, moved from the packet's standalone runner into the repository.
 * The follow-up that bounds the hold and resyncs owed receipts from the
 * stored bookmark is proved in tree-read-receipt-resync.test.mjs. */
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

async function setup(t, { mode = 'accept', code = 'SYNTHETIC_TEMPORARY_REFUSAL', receiptFailures = 0, deliverOnStart = true,
  receiptCode = null, readMode = 'once', count = 1 } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-read-retry-'))
  provider.reset(); directory.reset()
  let clock = realNow(), receiptCalls = 0
  const start = clock
  Date.now = () => clock
  const attempts = [], discards = [], events = [], steers = [], reads = []
  let cursor = 0, gap = true
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
    acknowledgeRead: async input => {
      reads.push(input)
      if (readMode === 'gap' && gap) return { accepted: false, code: 'FABRIC_READ_OUT_OF_ORDER', cursor: 0 }
      if (readMode === 'once' && reads.length === 1) return { accepted: false, code: 'FABRIC_READ_OUT_OF_ORDER', cursor: 0 }
      if (readMode === 'lost' && reads.length === 1) { cursor = input.sequence; throw Error('Synthetic response lost after persistence') }
      if (input.sequence <= cursor) return { accepted: false, code: 'FABRIC_READ_OUT_OF_ORDER', cursor }
      assert.equal(input.sequence, cursor + 1, 'host skipped an unread receipt')
      cursor = input.sequence
      return { accepted: true, cursor }
    },
    acknowledgeDeferred: async () => {
      receiptCalls++
      if (receiptCalls <= receiptFailures) throw Error('Synthetic receipt write unavailable')
      return { accepted: true }
    },
  }
  const host = createAgentHost({ enginePath, defaultCwd: scratch, freeMemory: () => 64 * 1024 ** 3,
    treeCourier: { pollMs: 15, heartbeatMs: 1000, readDeadlineMs: 100 },
    assertTranscriptWritable: () => {},
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
  if (deliverOnStart) for (let n = 0; n < count; n++) deliver()
  return { host, attempts, discards, events, steers, deliver, reads, cursor: () => cursor, releaseGap: () => { gap = false },
    receiptCalls: () => receiptCalls, step: async ms => { clock += ms; await delay(45) } }
}

test('refused read receipt retries after acceptance without transport replay', async t => {
  const f = await setup(t)
  await until(() => f.cursor() === 1, 'refused receipt was dropped instead of retried')
  await delay(90)
  assert.equal(f.attempts.length, 1); assert.equal(f.discards.length, 0)
  assert.equal(f.reads.length, 2); assert.equal(f.reads[0].message.id, f.reads[1].message.id)
  assert.equal(f.reads[0].agentId, f.reads[1].agentId)
  assert.match(JSON.stringify(f.events), /recording will be retried without sending them again/)
})

test('an earlier unread gap is never skipped; repaired receipt completes the accepted batch', async t => {
  const f = await setup(t, { readMode: 'gap', count: 2 })
  await until(() => f.reads.length >= 3, 'refused batch receipts were not retained')
  assert.ok(f.reads.every(r => r.sequence === 1), 'later receipt bypassed the gap')
  assert.equal(f.cursor(), 0); assert.equal(f.attempts.length, 1)
  f.releaseGap()
  await until(() => f.cursor() === 2, 'ordered receipts did not recover after gap repair')
  const settled = f.reads.length
  await delay(70)
  assert.equal(f.reads.length, settled)
  assert.equal(f.attempts.length, 1); assert.equal(f.discards.length, 0)
})

test('a lost read-receipt response reconciles from its authenticated returned cursor', async t => {
  const f = await setup(t, { readMode: 'lost', count: 2 })
  await until(() => f.cursor() === 2, 'lost receipt response stranded the remaining receipt')
  assert.deepEqual(f.reads.map(r => r.sequence), [1, 1, 2]); assert.equal(f.attempts.length, 1)
  assert.equal(f.discards.length, 0)
})

test('handoff-receipt persistence retry still completes read receipts without resend', async t => {
  const f = await setup(t, { receiptFailures: 2 })
  await until(() => f.receiptCalls() >= 3 && f.cursor() === 1, 'receipt-only persistence did not finish')
  await delay(70)
  assert.equal(f.attempts.length, 1); assert.equal(f.discards.length, 0)
})

test('ambiguous mid-turn delivery never records a read receipt or replays transport', async t => {
  const f = await setup(t, { deliverOnStart: false })
  await f.host.sendTurn({ sessionId: 'synthetic-recipient', text: 'Synthetic person turn' })
  f.deliver()
  await until(() => f.steers.length === 1, 'missing steer fixture attempt')
  for (let n = 0; n < 3; n++) await f.step(30000)
  assert.equal(f.reads.length, 0); assert.equal(f.steers.length, 1); assert.equal(f.attempts.length, 1); assert.equal(f.discards.length, 0)
})
