import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

/* AN ADMISSION WAIT HAS A BOUND (T1743, follow-up to Builder 2's host packet
 * fff61708).
 *
 * Builder 2's packet treats rules-context and transcript-admission refusals
 * as waits: the batch is kept at the front of the queue and offered again
 * every 5-30 s without spending the five-attempt budget. That is right for a
 * refusal that clears -- but nothing ended the wait, and the retryAt guard
 * holds every later message behind it. A rules context that never recovers
 * (or a transcript store that stays unwritable) became a new permanent stop,
 * and its sender was never told. With the bound, the batch is set aside with
 * its own refusal code once it has waited ten minutes (or 24 offers), and the
 * messages behind it are offered again.
 *
 * Driven like Builder 2's own cases: the real host, the inbox-only fixture
 * provider, and a manually advanced Date.now for the production delays. */
const require_ = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtures = path.join(root, 'tools/test/fixtures/confined-engine/src/lib')
const enginePath = path.join(fixtures, 'agent-engine/codex-process.js')
const providerPath = path.join(fixtures, 'providers/agent-comms-local.js')
const directoryPath = path.join(fixtures, 'agent-comms/tree-node-directory.js')
const engine = require_(enginePath), provider = require_(providerPath), directory = require_(directoryPath)
const { createAgentHost } = require_(path.join(root, 'shell/agent-host.cjs'))
const realNow = Date.now

async function until(predicate, label) {
  const end = realNow() + 3000
  while (realNow() < end) { if (predicate()) return; await delay(10) }
  assert.fail(label)
}

async function setup(t, { refuse = () => null } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'host-admission-cap-'))
  provider.reset(); directory.reset()
  let clock = realNow()
  Date.now = () => clock
  const attempts = [], discards = [], events = []
  require_.cache[require_.resolve(enginePath)].exports = { ...engine, startCodexSession: async () => ({ threadId: 'thread-admission', close() {}, adapter: {
    sendTurn: async request => {
      const code = refuse(request.text)
      attempts.push({ at: clock, text: request.text, refused: code || null })
      if (code) throw Object.assign(new Error('Synthetic admission refusal'), { code })
      return { turnId: `turn-${attempts.length}` }
    },
    interrupt: async () => {},
  } }) }
  require_.cache[require_.resolve(providerPath)].exports = { ...provider,
    discard: async input => { discards.push({ ...input, at: clock }); return { accepted: true } },
    defer: async () => ({ accepted: true }),
    acknowledgeRead: async () => ({ accepted: true }),
    acknowledgeDeferred: async () => ({ accepted: true }),
  }
  const host = createAgentHost({ enginePath, defaultCwd: scratch, freeMemory: () => 64 * 1024 ** 3,
    treeCourier: { pollMs: 15, heartbeatMs: 1000, readDeadlineMs: 100 },
    messageDeliveryReader: () => ({ mode: 'end-of-turn', intervalMs: 30_000 }),
    confinementPlanner: () => ({ ok: true, tier: 'standard', isolated: true, threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(scratch, 'agent-home') }, servers: ['toolsenabled-readonly', 'toolsenabled'] }) })
  host.onEvent(event => events.push(event))
  t.after(async () => {
    await host.closeAll()
    Date.now = realNow
    require_.cache[require_.resolve(enginePath)].exports = engine
    require_.cache[require_.resolve(providerPath)].exports = provider
    provider.reset(); directory.reset()
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  })
  await host.startSession({ sessionId: 'admission-recipient', treeIdentity: { selfName: 'Admission recipient', managerName: null } })
  const recipientAgentId = directory.agentIdForSession('admission-recipient')
  return {
    attempts, discards, events,
    deliver: body => provider.deliver({ recipientAgentId, senderAgentId: 'admission-sender', body }),
    offers: body => attempts.filter(attempt => attempt.text.includes(body)).length,
    delivered: body => attempts.filter(attempt => attempt.text.includes(body) && !attempt.refused).length,
    step: async ms => { clock += ms; await delay(45) },
    shown: pattern => events.some(packet => pattern.test(packet.event?.text || '')),
  }
}

test('an admission wait that never clears is set aside with its own code and releases the messages behind it', async t => {
  const f = await setup(t, { refuse: text => text.includes('Blocked assignment') ? 'RULES_CONTEXT_UNAVAILABLE' : null })
  f.deliver('Blocked assignment for a session whose rules context never recovers.')
  await until(() => f.offers('Blocked assignment') === 1, 'the blocked assignment was never offered')
  f.deliver('Later report queued behind it.')
  // Eleven minutes of the production 5/10/20/30 s schedule.
  for (let n = 0; n < 22; n++) await f.step(30_000)
  // RED on fff61708: the wait is retried for ever, never set aside, and the
  // later report is held behind it the whole time.
  await until(() => f.discards.length === 1, 'an admission wait that never cleared was never set aside')
  assert.equal(f.discards[0].refusalCode, 'RULES_CONTEXT_UNAVAILABLE', 'the set-aside receipt does not name the admission refusal')
  assert.ok(f.discards[0].at - f.attempts[0].at >= 10 * 60_000, 'set aside before the ten-minute admission bound')
  await f.step(30_000)
  await until(() => f.delivered('Later report') === 1, 'the message behind the expired wait was still held')
  assert.ok(f.shown(/set aside[^]*RULES_CONTEXT_UNAVAILABLE|RULES_CONTEXT_UNAVAILABLE[^]*set aside/), 'the recipient chat does not say why it was set aside')
})

test('an admission wait that clears inside the bound is delivered, never set aside', async t => {
  let blocked = true
  const f = await setup(t, { refuse: () => blocked ? 'MC_TRANSCRIPT_STORAGE_FAILED' : null })
  f.deliver('Assignment waiting for the transcript store.')
  await until(() => f.offers('Assignment waiting') === 1, 'the assignment was never offered')
  for (let n = 0; n < 18; n++) await f.step(30_000) // nine minutes
  assert.equal(f.discards.length, 0, 'set aside before the admission bound')
  blocked = false
  await f.step(30_000)
  await until(() => f.delivered('Assignment waiting') === 1, 'the repaired admission never delivered')
  await f.step(30_000)
  assert.equal(f.discards.length, 0)
  assert.equal(f.delivered('Assignment waiting'), 1)
})
