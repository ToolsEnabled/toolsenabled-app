import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// The standard source and cut runners provide a retained fixture boundary.
if (process.env.TOOLSENABLED_TEST_STRICT !== '1' || process.env.TOOLSENABLED_TEST_RETAIN_FIXTURES !== '1') {
  throw new Error('Courier host proof requires the strict retained-fixture preload')
}
const retainedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-courier-late-read-'))
for (const name of ['rmSync', 'unlinkSync', 'rmdirSync', 'rm', 'unlink', 'rmdir']) {
  fs[name] = () => { throw new Error('Deletion is forbidden in this retained test') }
}
for (const name of ['rm', 'unlink', 'rmdir']) {
  fs.promises[name] = async () => { throw new Error('Deletion is forbidden in this retained test') }
}
const require_ = createRequire(import.meta.url)
const { createAgentHost } = require_('../../shell/agent-host.cjs')
const fixture = path.join(sourceRoot, 'tools/test/fixtures/confined-engine/src/lib')
const enginePath = path.join(fixture, 'agent-engine/codex-process.js')
const providerPath = path.join(fixture, 'providers/agent-comms-local.js')
const directoryPath = path.join(fixture, 'agent-comms/tree-node-directory.js')
const provider = require_(providerPath)
const directory = require_(directoryPath)
const engine = require_(enginePath)

async function until(predicate, message, timeoutMs = 700) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail(message)
}

async function setup(t, readDelayMs, { holdAfter = Infinity } = {}) {
  fs.mkdirSync(retainedRoot, { recursive: true })
  const scratch = fs.mkdtempSync(path.join(retainedRoot, 'case-'))
  t.diagnostic('Retained fixture: ' + scratch)
  provider.reset()
  directory.reset()
  engine.calls.length = 0
  engine.adapterCalls.length = 0
  engine.control.holdTurns = false
  const state = { reads: 0, inFlight: 0, maxInFlight: 0 }
  const gates = []
  let laterReadsReleased = false
  const releaseLaterReads = () => {
    laterReadsReleased = true
    for (const resolve of gates.splice(0)) resolve()
  }
  require_.cache[require_.resolve(providerPath)].exports = {
    ...provider,
    inboxes: async requests => {
      const readNumber = ++state.reads
      state.inFlight += 1
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      try {
        if (readNumber > holdAfter && !laterReadsReleased) await new Promise(resolve => gates.push(resolve))
        if (readDelayMs) await delay(readDelayMs)
        return await Promise.all(requests.map(async request => ({
          agentId: request.agentId, ...(await provider.inbox(request)),
        })))
      } finally { state.inFlight -= 1 }
    },
  }
  const host = createAgentHost({
    enginePath, defaultCwd: scratch,
    freeMemory: () => 64 * 1024 * 1024 * 1024,
    treeCourier: { pollMs: 15, heartbeatMs: 25, readDeadlineMs: 30 },
    confinementPlanner: () => ({
      ok: true, tier: 'standard', isolated: true,
      threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(scratch, 'synthetic-agent-home') },
      servers: ['toolsenabled-readonly', 'toolsenabled'],
    }),
  })
  t.after(async () => {
    releaseLaterReads()
    await host.closeAll()
    await until(() => state.inFlight === 0, 'synthetic inbox reads did not settle')
    require_.cache[require_.resolve(providerPath)].exports = provider
    provider.reset()
    directory.reset()
  })
  await host.startSession({
    sessionId: 'synthetic-current-session',
    treeIdentity: { selfName: 'Synthetic recipient', managerName: null },
  })
  const record = provider.deliver({
    recipientAgentId: directory.agentIdForSession('synthetic-current-session'),
    senderAgentId: 'synthetic-sender', body: 'Synthetic retained handoff 731',
  })
  const sends = () => engine.adapterCalls.filter(call =>
    call.method === 'sendTurn' && call.request.text.includes('Synthetic retained handoff 731'))
  return { host, state, sends, record, releaseLaterReads }
}

test('a prompt inbox page reaches the model once', async t => {
  const f = await setup(t, 0)
  await until(() => f.sends().length === 1, 'prompt inbox did not reach the model')
  await delay(140)
  assert.equal(f.sends().length, 1)
})

test('a successful page slower than every deadline still reaches the model once', async t => {
  const f = await setup(t, 90)
  await until(() => f.sends().length === 1,
    'completed inbox pages were discarded after the read deadline')
  await delay(180)
  assert.equal(f.sends().length, 1, 'a retained late page must not duplicate model delivery')
  assert.equal(f.state.maxInFlight, 1, 'deadline must not launch overlapping reads')
  assert.ok(provider.readReceiptsSeen().some(r => r.messageId === f.record.message.id),
    'the delivered durable message must reach the normal read-receipt path')
})

test('a late page cannot start a turn on a retired session', async t => {
  const f = await setup(t, 90)
  await until(() => f.state.inFlight === 1, 'delayed read did not start')
  await f.host.closeAll()
  await delay(140)
  assert.equal(f.sends().length, 0)
})


async function replacementCase(t) {
  const f = await setup(t, 90, { holdAfter: 1 })
  await until(() => f.state.inFlight === 1, 'old session read did not start')
  await f.host.closeSession({ sessionId: 'synthetic-current-session' })
  await f.host.startSession({
    sessionId: 'synthetic-current-session',
    treeIdentity: { selfName: 'Synthetic recipient', managerName: null },
  })
  await until(() => f.state.reads >= 2, 'replacement did not request a fresh read')
  assert.equal(f.sends().length, 0, 'old session page was delivered to a replacement with the same ID')
  f.releaseLaterReads()
  await until(() => f.sends().length === 1, 'fresh replacement page was not delivered')
  await delay(140)
  assert.equal(f.sends().length, 1, 'replacement must deliver once after its own fresh read')
  assert.equal(f.state.maxInFlight, 1)
  assert.ok(provider.readReceiptsSeen().some(r => r.messageId === f.record.message.id))
}

test('a replacement reusing the same session ID must wait for its own fresh page', replacementCase)
