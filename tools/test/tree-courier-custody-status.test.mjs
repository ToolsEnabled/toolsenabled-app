import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

/* THE COURIER'S CUSTODY STATE IS VISIBLE, AND ONLY AS METADATA (T1745).
 *
 * Builder 2's host packet: sessionActivity() carries a `courier` object --
 * whether a delivery is uncertain, how many messages are queued, whether a
 * handoff or a receipt is pending, and how long a backoff still has to run --
 * and never the queued words, message ids, thread ids or permission
 * bindings. An uncertain steer no longer tells the person to restart the
 * agent. These are Builder 2's own cases, moved from the packet's standalone
 * runner into the repository. Clearing an uncertain delivery at the next
 * turn boundary is proved in tree-uncertain-steer-reconcile.test.mjs; here
 * the steered turn never ends, so the delivery stays uncertain. */
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

async function setup(t, { mode = 'temporary', code = 'SYNTHETIC_TEMPORARY_REFUSAL', receiptFailures = 0, deliverOnStart = true } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-custody-status-'))
  provider.reset(); directory.reset()
  let clock = realNow(), receiptCalls = 0
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
  if (deliverOnStart) deliver()
  return { host, attempts, discards, events, steers, deliver, receiptCalls: () => receiptCalls,
    step: async ms => { clock += ms; await delay(45) } }
}

test('uncertain delivery is observable without exposing payload or implying safe restart', async t => {
  const f = await setup(t, { mode: 'accept', deliverOnStart: false })
  await f.host.sendTurn({ sessionId: 'synthetic-recipient', text: 'Synthetic person turn' })
  f.deliver()
  await until(() => f.steers.length === 1, 'steer was not attempted')
  await f.step(0)
  const activity = f.host.sessionActivity('synthetic-recipient')
  assert.deepEqual(activity.courier, { deliveryUncertain: true, queuedMessages: 1, handoffPending: false, receiptPending: false, retryAfterMs: 0 })
  const { createAppContextReader } = req(path.join(root, 'shell/app-context.cjs'))
  const window = { isDestroyed: () => false, getURL: () => 'http://localhost/#/computers' }
  const sessions = new Map([['synthetic-recipient', { agentId: 'synthetic-agent', ownerKind: 'window', owner: window, state: 'ready' }]])
  const reader = createAppContextReader({ sessions,
    readOrg: () => ({ ok: true, org: { agents: [], relationships: [], revision: 1 }, roles: [] }),
    readActivity: id => f.host.sessionActivity(id) })
  const context = reader.read({ sessionId: 'synthetic-recipient', agentId: 'synthetic-agent' })
  assert.deepEqual(context.sessions[0].activity.courier, activity.courier)
  assert.doesNotMatch(JSON.stringify(context), /Synthetic retained assignment|thread-synthetic|CODEX_HOME|fixture-message/)
  assert.doesNotMatch(JSON.stringify(f.events), /restart this agent to recover/)
  assert.match(JSON.stringify(f.events), /Automatic replay is paused until this delivery can be reconciled/)
  for (let i = 0; i < 3; i++) await f.step(30000)
  assert.equal(f.steers.length, 1); assert.equal(f.attempts.length, 1); assert.equal(f.discards.length, 0)
  assert.equal(f.host.sessionActivity('synthetic-recipient').courier.deliveryUncertain, true)
})

test('backoff reports its bounded wait independently of uncertain delivery', async t => {
  const f = await setup(t, { mode: 'permanent' })
  await until(() => f.attempts.length === 1, 'no first attempt')
  await f.step(0)
  const activity = f.host.sessionActivity('synthetic-recipient')
  assert.deepEqual(activity.courier, { deliveryUncertain: false, queuedMessages: 1, handoffPending: false, receiptPending: false, retryAfterMs: 5000 })
  await f.step(4999)
  assert.equal(f.host.sessionActivity('synthetic-recipient').courier.retryAfterMs, 1)
})

test('idle courier does not invent an uncertain delivery', async t => {
  const f = await setup(t, { mode: 'accept', deliverOnStart: false })
  await f.step(0)
  assert.deepEqual(f.host.sessionActivity('synthetic-recipient').courier,
    { deliveryUncertain: false, queuedMessages: 0, handoffPending: false, receiptPending: false, retryAfterMs: 0 })
  assert.equal(f.host.sessionActivity('missing'), null)
})
