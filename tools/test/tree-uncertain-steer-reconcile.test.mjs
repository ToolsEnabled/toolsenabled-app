import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

/* AN UNCERTAIN MID-TURN DELIVERY IS RECONCILED AT THE TURN BOUNDARY (T1745,
 * follow-up to Builder 2's diagnostics packet f6a0a172).
 *
 * With Message delivery set to Instant, a message arriving mid-turn is steered
 * into the running turn. A steer that fails without a JSON-RPC code may or may
 * not have landed, so the host holds the batch (treeDeliveryUncertain) and
 * stops steering that session (treeSteerUnavailable). Nothing ever cleared
 * either flag: every later message waited unread until someone restarted the
 * agent. Now the boundary of the turn it was steered into settles it from the
 * provider thread: the words are there -> recorded as delivered; they are not,
 * or the thread cannot be read -> offered once more as a new turn, marked as a
 * possible duplicate. Both flags clear, and steering is tried again next turn.
 *
 * The real host with the inbox-only fixture provider and a fixture Codex
 * adapter whose thread history the test controls. */
const require_ = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtures = path.join(root, 'tools/test/fixtures/confined-engine/src/lib')
const enginePath = path.join(fixtures, 'agent-engine/codex-process.js')
const providerPath = path.join(fixtures, 'providers/agent-comms-local.js')
const directoryPath = path.join(fixtures, 'agent-comms/tree-node-directory.js')
const engine = require_(enginePath), provider = require_(providerPath), directory = require_(directoryPath)
const { createAgentHost } = require_(path.join(root, 'shell/agent-host.cjs'))
const DUPLICATE = /Possible duplicate/

async function until(predicate, label, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (predicate()) return; await delay(10) }
  assert.fail(label)
}

// history: 'shown' (the thread holds the steered words), 'absent', 'unreadable'
// strictReadOrder: the read-receipt stub accepts only the next sequence after
// its cursor, as the fabric does, and answers the first receipt slowly.
async function setup(t, { history = 'shown', steerFailures = 1, rpcCode = null, strictReadOrder = false } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'host-uncertain-steer-'))
  provider.reset(); directory.reset()
  const turns = [], steers = [], reads = [], acknowledged = [], outOfOrder = []
  let readCursor = 0, readAttempts = 0
  let onEvent = null, turnNumber = 0, active = null
  require_.cache[require_.resolve(enginePath)].exports = { ...engine, startCodexSession: async options => {
    onEvent = options.onEvent
    return { threadId: 'thread-steer', close() {}, adapter: {
      sendTurn: async request => { active = `turn-${++turnNumber}`; turns.push({ turnId: active, text: request.text }); return { turnId: active } },
      steerTurn: async request => {
        steers.push({ ...request })
        if (steers.length <= steerFailures) {
          throw Object.assign(new Error('ambiguous synthetic steer'), rpcCode === null ? { code: 'CODEX_STEER_RESPONSE_INVALID' } : { code: 'CODEX_RPC_ERROR', rpcCode })
        }
        return { threadId: request.threadId, turnId: request.turnId }
      },
      readThread: async () => {
        if (history === 'unreadable') throw Object.assign(new Error('thread read failed'), { code: 'CODEX_PROTOCOL_INVALID' })
        const said = turns.map(turn => ({ id: turn.turnId, said: [{ who: 'you', text: turn.text }] }))
        if (history === 'shown') for (const steer of steers) said.find(turn => turn.id === steer.turnId)?.said.push({ who: 'you', text: steer.text })
        return { threadId: 'thread-steer', turns: said }
      },
      interrupt: async () => {},
    } }
  } }
  require_.cache[require_.resolve(providerPath)].exports = { ...provider,
    discard: async () => ({ accepted: true }), defer: async () => ({ accepted: true }),
    acknowledgeRead: async input => {
      if (!strictReadOrder) { reads.push(input.sequence); return { accepted: true } }
      if (++readAttempts === 1) await delay(400)
      if (input.sequence <= readCursor) return { accepted: false, code: 'FABRIC_READ_OUT_OF_ORDER', cursor: readCursor }
      if (input.sequence !== readCursor + 1) { outOfOrder.push(input.sequence); return { accepted: false, code: 'FABRIC_READ_OUT_OF_ORDER', cursor: readCursor } }
      readCursor = input.sequence; reads.push(input.sequence); return { accepted: true }
    },
    acknowledgeDeferred: async input => { acknowledged.push(input.message?.id); return { accepted: true } },
  }
  const host = createAgentHost({ enginePath, defaultCwd: scratch, freeMemory: () => 64 * 1024 ** 3,
    treeCourier: { pollMs: 15, heartbeatMs: 1000, readDeadlineMs: 100 },
    messageDeliveryReader: () => ({ mode: 'instant', intervalMs: 30_000 }),
    confinementPlanner: () => ({ ok: true, tier: 'standard', isolated: true, threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(scratch, 'agent-home') }, servers: ['toolsenabled-readonly', 'toolsenabled'] }) })
  const events = []
  host.onEvent(packet => events.push(packet))
  t.after(async () => {
    await host.closeAll()
    require_.cache[require_.resolve(enginePath)].exports = engine
    require_.cache[require_.resolve(providerPath)].exports = provider
    provider.reset(); directory.reset()
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  })
  await host.startSession({ sessionId: 'steer-recipient', treeIdentity: { selfName: 'Steer recipient', managerName: null } })
  const recipientAgentId = directory.agentIdForSession('steer-recipient')
  return {
    host, turns, steers, reads, acknowledged, events, outOfOrder,
    deliver: body => provider.deliver({ recipientAgentId, senderAgentId: 'steer-sender', body }),
    personTurn: text => host.sendTurn({ sessionId: 'steer-recipient', text }),
    endTurn: () => onEvent({ type: 'turn_completed', turnId: active, status: 'completed' }),
    turnsWith: body => turns.filter(turn => turn.text.includes(body)),
    shown: pattern => events.some(packet => pattern.test(packet.event?.text || '')),
  }
}

test('a steer whose words are in the thread is recorded as delivered at the boundary, and delivery resumes', async t => {
  const f = await setup(t, { history: 'shown' })
  await f.personTurn('The person\'s own turn.')
  const first = f.deliver('Steered report one.')
  await until(() => f.steers.length === 1, 'the report was not steered into the running turn')
  await delay(60)
  f.deliver('Report two, arriving while the first is uncertain.')
  await delay(90)
  assert.equal(f.turnsWith('Report two').length, 0, 'the fixture must hold the second report while the first is uncertain')
  f.endTurn()
  // RED on f6a0a172: treeDeliveryUncertain is never cleared, so report two
  // waits unread for as long as the session lives.
  await until(() => f.turnsWith('Report two').length === 1, 'the courier stayed paused after the uncertain steer\'s turn ended')
  assert.equal(f.turnsWith('Steered report one').length, 0, 'a steer the thread shows was delivered again')
  assert.ok(f.reads.includes(first.sequence), 'the reconciled steer was not recorded as read')
  assert.ok(f.acknowledged.includes(first.message.id), 'the reconciled steer\'s handoff was not confirmed')
  assert.ok(!f.turnsWith('Report two').some(turn => DUPLICATE.test(turn.text)), 'a message that was never uncertain was marked as a duplicate')
  // Steering is tried again in the next turn instead of staying off for the session.
  f.endTurn()
  await f.personTurn('The person\'s next turn.')
  f.deliver('Report three, mid-turn again.')
  await until(() => f.steers.length === 2, 'steering stayed off for the rest of the session after one uncertain steer')
})

test('a reconciled steer\'s read receipt is recorded before a later message\'s receipt is offered', async t => {
  // The fabric records receipts in stream order. If the courier resumes before
  // the reconciled steer's receipt is recorded, the next message's receipt is
  // offered ahead of it and refused.
  const f = await setup(t, { history: 'shown', strictReadOrder: true })
  await f.personTurn('The person\'s own turn.')
  const first = f.deliver('Steered report one.')
  await until(() => f.steers.length === 1, 'the report was not steered into the running turn')
  await delay(60)
  const second = f.deliver('Report two, arriving while the first is uncertain.')
  await delay(90)
  f.endTurn()
  await until(() => f.turnsWith('Report two').length === 1, 'report two was not offered after the boundary', 5000)
  await until(() => f.reads.includes(second.sequence), 'report two was never recorded as read', 8000)
  assert.deepEqual(f.outOfOrder, [], 'a later message\'s read receipt was offered ahead of the reconciled steer\'s')
  assert.deepEqual(f.reads, [first.sequence, second.sequence], 'the receipts were not recorded in stream order')
  assert.ok(!f.shown(/could not record which agent messages have been read/), 'the person was told receipts could not be recorded')
})

for (const history of ['absent', 'unreadable']) {
  test(`a steer whose words are ${history === 'absent' ? 'not in the thread' : 'unreadable in the thread'} is offered once more, marked as a possible duplicate`, async t => {
    const f = await setup(t, { history })
    await f.personTurn('The person\'s own turn.')
    const first = f.deliver('Steered report one.')
    await until(() => f.steers.length === 1, 'the report was not steered into the running turn')
    await delay(60)
    assert.equal(f.reads.length, 0, 'an uncertain steer was recorded as read before it was reconciled')
    f.endTurn()
    await until(() => f.turnsWith('Steered report one').length === 1, 'the uncertain report was never offered again')
    const again = f.turnsWith('Steered report one')[0]
    assert.match(again.text, DUPLICATE, 'the second offer does not say it may be a duplicate')
    f.endTurn()
    await delay(120)
    assert.equal(f.turnsWith('Steered report one').length, 1, 'the uncertain report was offered more than once more')
    assert.equal(f.steers.length, 1, 'the re-offer was steered again instead of sent as a new turn')
    assert.ok(f.reads.includes(first.sequence), 'the re-offered report was not recorded as read once accepted')
    assert.ok(f.shown(/offered once more/), 'the chat does not say what happened to the uncertain message')
  })
}

test('an explicit "method not found" steer refusal keeps steering off after the boundary', async t => {
  const f = await setup(t, { rpcCode: -32601, steerFailures: 5 })
  await f.personTurn('The person\'s own turn.')
  f.deliver('Report for a runtime that cannot steer.')
  await until(() => f.steers.length === 1, 'the report was not steered')
  f.endTurn()
  await until(() => f.turnsWith('Report for a runtime').length === 1, 'the refused report did not go out at the boundary')
  assert.ok(!DUPLICATE.test(f.turnsWith('Report for a runtime')[0].text), 'an explicitly refused steer is not uncertain and is not a duplicate')
  f.endTurn()
  await f.personTurn('The person\'s next turn.')
  f.deliver('Second report for that runtime.')
  await delay(120)
  assert.equal(f.steers.length, 1, 'a runtime that has no steer method was asked to steer again')
})
