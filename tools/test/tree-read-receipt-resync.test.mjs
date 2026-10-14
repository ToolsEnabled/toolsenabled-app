import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { canonicalRootForTests } from '../canonical-root.mjs'

/* READ RECEIPTS CATCH UP FROM THE STORED BOOKMARK AND NEVER HOLD LATER
 * MESSAGES FOR LONG (T1742, follow-up to Builder 2's host packet 60756569).
 *
 * The fabric takes read receipts strictly in order. Builder 2's packet keeps
 * an accepted batch whose receipt was refused and retries it on every courier
 * tick, deciding 'persist' -- so nothing newer reaches the model until the
 * receipt is recorded. When the refusal is permanent (a dead letter ahead
 * that the installed engine cannot pass, as on the v6/live48 engine), that is
 * a new permanent stop: every later message waits unread. Without any retry
 * (live48 itself) the stored bookmark simply stays behind forever.
 *
 * These cases drive the real engine provider (strict fabric, real broker)
 * behind the fixture Codex engine, the way the other courier suites do. */
const require_ = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const engineRoot = canonicalRootForTests()
require_(path.join(engineRoot, 'tests/lib/isolated-environment')).activate('app-tree-read-receipt-resync')
const { createTreeNodeDirectory } = require_(path.join(engineRoot, 'src/lib/agent-comms/tree-node-directory'))
const { createLocalAgentMessageProvider } = require_(path.join(engineRoot, 'src/lib/providers/agent-comms-local'))
const fixtures = path.join(root, 'tools/test/fixtures/confined-engine/src/lib')
const directoryPath = path.join(fixtures, 'agent-comms/tree-node-directory.js')
const providerPath = path.join(fixtures, 'providers/agent-comms-local.js')
const enginePath = path.join(fixtures, 'agent-engine/codex-process.js')
const { createAgentHost } = require_(path.join(root, 'shell/agent-host.cjs'))
const POLL_MS = 25
let index = 0

async function until(predicate, label, ms = 6000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (predicate()) return; await delay(15) }
  assert.fail(label)
}

async function fixture(t, { failReads = () => false } = {}) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'host-read-resync-'))
  const key = `resync-${++index}`
  const file = path.join(scratch, 'tree.json'), brokerFile = path.join(scratch, 'broker.json')
  const directory = createTreeNodeDirectory({ file })
  const provider = createLocalAgentMessageProvider({ directory, brokerFile })
  const originalDirectory = require_(directoryPath), originalProvider = require_(providerPath), engine = require_(enginePath)
  const originalStart = engine.startCodexSession
  const turns = [], reads = []
  let started = 0, holdInbox = false
  // Each session gets its own adapter; a recipient's turn completes on its own
  // shortly after it is accepted, so the next boundary opens.
  engine.startCodexSession = async options => {
    const ordinal = started++
    return {
      threadId: `${key}-thread-${ordinal}`,
      close() {},
      adapter: {
        sendTurn: async request => {
          const turnId = `${key}-turn-${turns.length + 1}`
          turns.push({ ordinal, text: request.text })
          setTimeout(() => options.onEvent({ type: 'turn_completed', turnId, status: 'completed' }), 5)
          return { turnId }
        },
        interrupt: async () => ({ requiresResume: true }),
      },
    }
  }
  require_.cache[require_.resolve(directoryPath)].exports = {
    createTreeNodeDirectory: options => createTreeNodeDirectory({ ...options, file }),
  }
  require_.cache[require_.resolve(providerPath)].exports = { ...provider,
    async inboxes(requests) {
      if (holdInbox) return []
      return provider.inboxes(requests)
    },
    async acknowledgeRead(request) {
      const read = { sequence: request.sequence, messageId: request.message?.id, accepted: false }
      reads.push(read)
      if (failReads(request, reads.length)) throw new Error('read receipt storage refused')
      const answer = await provider.acknowledgeRead(request)
      read.accepted = answer?.accepted === true
      return answer
    },
  }
  const host = createAgentHost({ enginePath, defaultCwd: scratch, freeMemory: () => 64 * 1024 ** 3,
    treeCourier: { pollMs: POLL_MS, heartbeatMs: 1000, readDeadlineMs: 500 },
    messageDeliveryReader: () => ({ mode: 'end-of-turn', intervalMs: 30_000 }),
    confinementPlanner: () => ({ ok: true, tier: 'standard', isolated: true,
      threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(scratch, 'agent-home') }, servers: ['toolsenabled-readonly', 'toolsenabled'] }),
  })
  const visible = []
  host.onEvent(packet => visible.push(packet))
  const managerId = `${key}-manager`, recipientId = `${key}-recipient`
  t.after(async () => {
    await host.closeAll()
    engine.startCodexSession = originalStart
    require_.cache[require_.resolve(directoryPath)].exports = originalDirectory
    require_.cache[require_.resolve(providerPath)].exports = originalProvider
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  })
  await host.startSession({ sessionId: managerId, treeIdentity: { selfName: 'Manager', managerName: null },
    requestKeys: { treeAnchors: [key], threadId: key } })
  await host.startSession({ sessionId: recipientId, treeIdentity: { selfName: 'Recipient', managerName: 'Manager' },
    requestKeys: { treeAnchors: [key, `${key}-node`], threadId: `${key}-node` } })
  const recipientAgentId = directory.agentIdForSession(recipientId)
  const context = { agentSessionId: managerId, agentPrincipal: { sessionId: managerId } }
  return {
    host, provider, turns, reads, visible, recipientAgentId,
    holdInbox: value => { holdInbox = value },
    async send(body) {
      const sent = await provider.send({ from: 'Manager', to: 'Recipient', body }, context)
      assert.equal(sent.delivered, true, `send refused: ${sent.code}`)
      return sent
    },
    offers: body => turns.filter(turn => turn.ordinal === 1 && turn.text.includes(body)).length,
    // The stored bookmark, as the fabric itself reports it. The probe names a
    // position no record has, so the fabric can only refuse it and answer
    // with the bookmark: the probe never records a read itself.
    async storedBookmark(envelope) {
      const answer = await provider.acknowledgeRead({ agentId: recipientAgentId, message: envelope, sequence: 1_000_000 })
      assert.equal(answer.accepted, false, 'the bookmark probe must never be accepted')
      return answer.cursor
    },
    async untilBookmark(envelope, want, label) {
      const deadline = Date.now() + 6000
      while (Date.now() < deadline) { if (await this.storedBookmark(envelope) === want) return; await delay(25) }
      assert.fail(label)
    },
    async envelopeAt(sequence) {
      const page = (await provider.inbox({ agentId: recipientAgentId, cursor: sequence - 1, limit: 1 })).page
      return page.records.find(record => record.sequence === sequence)?.message || null
    },
  }
}

test('a receipt refused behind a dead letter the engine cannot pass no longer holds later messages', async t => {
  const f = await fixture(t)
  // A message set aside before this session read it: the page reports it as
  // dead-lettered, the courier passes it without a receipt, and an engine
  // without terminal settlement refuses every later receipt behind it.
  f.holdInbox(true)
  await f.send('First instruction, set aside before it was read.')
  const first = await f.envelopeAt(1)
  assert.equal((await f.provider.discard({ agentId: f.recipientAgentId, message: first })).accepted, true)
  f.holdInbox(false)
  await f.send('Second instruction, handed to the model.')
  await until(() => f.offers('Second instruction') === 1, 'the second message never reached the model')
  await until(() => f.reads.filter(read => read.sequence === 2).length >= 1, 'no receipt was attempted for the second message')
  await f.send('Third instruction, sent while the second one\'s receipt is refused.')
  // RED on 60756569: the accepted batch is held in 'persist' on every tick and
  // the third message waits unread for as long as the gap exists.
  await until(() => f.offers('Third instruction') === 1, 'a refused read receipt held every later message from the model')
  assert.equal(f.offers('Second instruction'), 1, 'the accepted message was sent to the model again to repair a receipt')
  assert.equal(f.reads.filter(read => read.sequence === 1).length, 0, 'the courier sent a read receipt for a dead-lettered record')
  // Owed receipts back off instead of writing on every courier tick.
  const before = f.reads.length
  await delay(POLL_MS * 60)
  const during = f.reads.length - before
  assert.ok(during <= 8, `owed receipts were resent ${during} times in 60 courier rounds; they must back off`)
  assert.equal(f.offers('Third instruction'), 1)
})

test('a receipt that failed while no later message arrives still reaches the stored bookmark', async t => {
  // Four failed writes, then the store recovers: longer than the held retries.
  const f = await fixture(t, { failReads: (_request, attempt) => attempt <= 4 })
  await f.send('Only instruction; its receipt write fails for a while.')
  await until(() => f.offers('Only instruction') === 1, 'the message never reached the model')
  const envelope = await f.envelopeAt(1)
  // RED on live48 (no retry at all): the one failed receipt is abandoned
  // "for the next batch", and there is no next batch.
  await until(() => f.reads.length >= 5, 'the failed receipt was never sent again')
  await f.untilBookmark(envelope, 1, 'the stored bookmark never caught up after the receipt store recovered')
  assert.equal(f.offers('Only instruction'), 1, 'the message was sent to the model again to repair its receipt')
})

test('receipts owed behind a failure are resent in order once it clears, and later messages are not held meanwhile', async t => {
  let failing = true
  const f = await fixture(t, { failReads: () => failing })
  await f.send('Alpha instruction.')
  await until(() => f.offers('Alpha instruction') === 1, 'alpha never reached the model')
  await until(() => f.reads.length >= 3, 'alpha receipt was not retried while held')
  await f.send('Bravo instruction.')
  await until(() => f.offers('Bravo instruction') === 1, 'bravo was held behind alpha\'s unrecorded receipt')
  failing = false
  const bravo = await f.envelopeAt(2)
  await f.untilBookmark(bravo, 2, 'owed receipts did not catch up to the stored head once the store recovered')
  assert.deepEqual(f.reads.filter(read => read.accepted).map(read => read.sequence), [1, 2],
    'owed receipts were not recorded once each, in order')
  assert.equal(f.offers('Alpha instruction'), 1)
  assert.equal(f.offers('Bravo instruction'), 1)
})
