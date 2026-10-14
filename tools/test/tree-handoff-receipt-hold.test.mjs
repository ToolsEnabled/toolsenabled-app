import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

/* A HANDOFF RECEIPT THE BROKER WILL NOT RECORD NO LONGER STOPS THE COURIER
 * (the third courier pause that never cleared; shares T1790's retirement path).
 *
 * After the model accepts a batch, the host confirms the handoff with the
 * broker (acknowledgeTreeBatch -> acknowledgeDeferred). If that confirmation
 * is refused, the batch is re-queued and every tick decides 'persist': the
 * confirmation is retried and nothing newer is handed to the model. A broker
 * that keeps refusing (for example BROKER_DELIVERY_NOT_RETAINED once its
 * bounded delivery list has trimmed the row) held that agent for the rest of
 * its session; on LIVE 5 of 11 agents then failed to close with
 * AGENT_TREE_RECOVERY_UNCONFIRMED (09-24 09:05:38Z), and their logs never said
 * why. Now the hold is bounded, the confirmation is owed and retried on its
 * own schedule, later messages flow, the broker's code is named, and closing
 * still refuses while the confirmation is missing -- as it did before. */
const require_ = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtures = path.join(root, 'tools/test/fixtures/confined-engine/src/lib')
const enginePath = path.join(fixtures, 'agent-engine/codex-process.js')
const providerPath = path.join(fixtures, 'providers/agent-comms-local.js')
const directoryPath = path.join(fixtures, 'agent-comms/tree-node-directory.js')
const engine = require_(enginePath), provider = require_(providerPath), directory = require_(directoryPath)
const { createAgentHost } = require_(path.join(root, 'shell/agent-host.cjs'))

async function until(predicate, label, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (predicate()) return; await delay(10) }
  assert.fail(label)
}

async function setup(t, { refuse = () => false } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'host-receipt-hold-'))
  provider.reset(); directory.reset()
  const turns = [], confirmations = []
  let onEvent = null, turnNumber = 0
  require_.cache[require_.resolve(enginePath)].exports = { ...engine, startCodexSession: async options => {
    onEvent = options.onEvent
    return { threadId: 'thread-receipt-hold', close() {}, adapter: {
      sendTurn: async request => {
        const turnId = `turn-${++turnNumber}`
        turns.push({ turnId, text: request.text })
        setTimeout(() => onEvent({ type: 'turn_completed', turnId, status: 'completed' }), 5)
        return { turnId }
      },
      interrupt: async () => {},
    } }
  } }
  require_.cache[require_.resolve(providerPath)].exports = { ...provider,
    discard: async () => ({ accepted: true }), defer: async () => ({ accepted: true }),
    acknowledgeRead: async () => ({ accepted: true }),
    acknowledgeDeferred: async input => {
      const refused = refuse(input.message, confirmations.filter(entry => entry.id === input.message?.id).length + 1)
      confirmations.push({ id: input.message?.id, refused })
      return refused ? { accepted: false, code: 'BROKER_DELIVERY_NOT_RETAINED' } : { accepted: true, code: 'BROKER_MODEL_HANDOFF_CONFIRMED' }
    },
  }
  const host = createAgentHost({ enginePath, defaultCwd: scratch, freeMemory: () => 64 * 1024 ** 3,
    treeCourier: { pollMs: 15, heartbeatMs: 1000, readDeadlineMs: 100 },
    messageDeliveryReader: () => ({ mode: 'end-of-turn', intervalMs: 30_000 }),
    confinementPlanner: () => ({ ok: true, tier: 'standard', isolated: true, threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(scratch, 'agent-home') }, servers: ['toolsenabled-readonly', 'toolsenabled'] }) })
  const events = []
  host.onEvent(packet => events.push(packet))
  t.after(async () => {
    await host.closeAll().catch(() => {})
    require_.cache[require_.resolve(enginePath)].exports = engine
    require_.cache[require_.resolve(providerPath)].exports = provider
    provider.reset(); directory.reset()
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  })
  await host.startSession({ sessionId: 'hold-recipient', treeIdentity: { selfName: 'Hold recipient', managerName: null } })
  const recipientAgentId = directory.agentIdForSession('hold-recipient')
  return {
    host, turns, confirmations, events,
    deliver: body => provider.deliver({ recipientAgentId, senderAgentId: 'hold-sender', body }),
    turnsWith: body => turns.filter(turn => turn.text.includes(body)),
    tries: id => confirmations.filter(entry => entry.id === id).length,
    shown: pattern => events.some(packet => pattern.test(packet.event?.text || '')),
  }
}

test('a handoff confirmation the broker keeps refusing no longer holds later messages, and closing still names why', async t => {
  let first = null
  const f = await setup(t, { refuse: message => message?.id === first?.message.id })
  first = f.deliver('Assignment whose handoff the broker will not record.')
  await until(() => f.turnsWith('Assignment whose handoff').length === 1, 'the first assignment never reached the model')
  await until(() => f.tries(first.message.id) >= 2, 'the refused confirmation was not retried while held')
  f.deliver('Report behind it.')
  // RED before: every tick decides 'persist' for the refused confirmation and
  // the report behind it waits unread for as long as the broker refuses.
  await until(() => f.turnsWith('Report behind it').length === 1, 'a refused handoff confirmation held every later message')
  assert.equal(f.turnsWith('Assignment whose handoff').length, 1, 'the accepted assignment was sent to the model again')
  assert.ok(f.shown(/could not record that it did \(BROKER_DELIVERY_NOT_RETAINED\)/), 'the chat does not name the broker refusal')
  // Owed, it is retried on the backoff schedule, not on every tick.
  const before = f.tries(first.message.id)
  await delay(15 * 60)
  assert.ok(f.tries(first.message.id) - before <= 6, 'an owed confirmation was retried on every courier tick')
  // Closing still refuses while the confirmation is missing, and now says which refusal.
  await assert.rejects(f.host.closeSession({ sessionId: 'hold-recipient' }),
    error => error.code === 'AGENT_TREE_RECOVERY_UNCONFIRMED' && /BROKER_DELIVERY_NOT_RETAINED/.test(error.message))
})

test('an owed handoff confirmation that the broker later records is settled, and the session then closes', async t => {
  let first = null
  const f = await setup(t, { refuse: (message, attempt) => message?.id === first?.message.id && attempt <= 7 })
  first = f.deliver('Assignment whose confirmation is refused for a while.')
  await until(() => f.turnsWith('Assignment whose confirmation').length === 1, 'the assignment never reached the model')
  f.deliver('Report behind it.')
  await until(() => f.turnsWith('Report behind it').length === 1, 'the report was held behind the refused confirmation')
  await until(() => f.confirmations.some(entry => entry.id === first.message.id && !entry.refused), 'the owed confirmation was never retried to success', 5000)
  await f.host.closeSession({ sessionId: 'hold-recipient' })
  assert.equal(f.turnsWith('Assignment whose confirmation').length, 1)
})
