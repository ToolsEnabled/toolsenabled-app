import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { canonicalRootForTests } from '../canonical-root.mjs'

const require_ = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// The engine SOURCE, not the packed capability/ layer: this suite needs
// tests/lib/isolated-environment, which the payload deliberately does not
// ship. canonicalRootForTests() honours MC_CANONICAL_ROOT, then the owner's
// private/capability-source.owner.json, exactly as the other four suites
// that load that helper do. Reading capability/ directly bailed this whole
// file out with MODULE_NOT_FOUND at the cut-1 tip (CUT1-tree-suites.tap).
const engineRoot = canonicalRootForTests()
// Use the engine's isolation helper before loading the real provider and
// durable store.
require_(path.join(engineRoot, 'tests/lib/isolated-environment')).activate('app-delivery-failure-receipt')
const { createTreeNodeDirectory } = require_(path.join(engineRoot, 'src/lib/agent-comms/tree-node-directory'))
const { createLocalAgentMessageProvider } = require_(path.join(engineRoot, 'src/lib/providers/agent-comms-local'))
const fixtures = path.join(root, 'tools/test/fixtures/confined-engine/src/lib')
const directoryPath = path.join(fixtures, 'agent-comms/tree-node-directory.js')
const providerPath = path.join(fixtures, 'providers/agent-comms-local.js')
const enginePath = path.join(fixtures, 'agent-engine/codex-process.js')
const { createAgentHost } = require_(path.join(root, 'shell/agent-host.cjs'))
let index = 0

async function until(predicate, label) {
  const deadline = Date.now() + 7000
  while (Date.now() < deadline) { if (predicate()) return; await delay(25) }
  assert.fail(label)
}

async function fixture(t, { refuseDiscardOnce = false } = {}) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'host-delivery-failure-'))
  const key = `receipt-${++index}`
  const brokerFile = path.join(scratch, 'broker.json')
  const file = path.join(scratch, 'tree.json')
  const directory = createTreeNodeDirectory({ file })
  const provider = createLocalAgentMessageProvider({ directory, brokerFile })
  const originalDirectory = require_(directoryPath)
  const originalProvider = require_(providerPath)
  const engine = require_(enginePath)
  engine.calls.length = 0; engine.adapterCalls.length = 0; engine.pendingTurns.length = 0
  engine.control.holdTurns = false
  let discardAttempts = 0
  require_.cache[require_.resolve(directoryPath)].exports = {
    createTreeNodeDirectory: options => createTreeNodeDirectory({ ...options, file }),
  }
  require_.cache[require_.resolve(providerPath)].exports = { ...provider, async discard(request) {
    discardAttempts++
    if (refuseDiscardOnce && discardAttempts === 1) throw new Error('one durable-write refusal')
    return provider.discard(request)
  } }
  const host = createAgentHost({ enginePath, defaultCwd: scratch,
    freeMemory: () => 64 * 1024 ** 3,
    treeCourier: { pollMs: 35, heartbeatMs: 1000, readDeadlineMs: 500 },
    messageDeliveryReader: () => ({ mode: 'end-of-turn', intervalMs: 30_000 }),
    confinementPlanner: () => ({ ok: true, tier: 'standard', isolated: true,
      threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(scratch, 'agent-home') }, servers: ['toolsenabled-readonly', 'toolsenabled'] }),
  })
  const visible = []
  host.onEvent(packet => visible.push(packet))
  const managerId = `${key}-manager`, recipientId = `${key}-recipient`
  const recipientStart = { treeIdentity: { selfName: 'Recipient', managerName: 'Manager' },
    requestKeys: { treeAnchors: [key, `${key}-child`], threadId: `${key}-child` } }
  await host.startSession({ sessionId: managerId, treeIdentity: { selfName: 'Manager', managerName: null },
    requestKeys: { treeAnchors: [key], threadId: key } })
  await host.startSession({ sessionId: recipientId, ...recipientStart })
  const body = `Report-${key}-refused`
  engine.control.holdTurns = true
  const rejector = setInterval(() => {
    for (const pending of engine.pendingTurns.splice(0)) {
      if (pending.request.text.includes(body)) pending.reject(Object.assign(new Error('turn refused'), { code: 'ENGINE_TRANSPORT_RESET' }))
      else pending.resolve({ turnId: 'receipt-turn' })
    }
  }, 5)
  t.after(async () => {
    clearInterval(rejector)
    engine.control.holdTurns = false
    for (const pending of engine.pendingTurns.splice(0)) pending.resolve({ turnId: 'cleanup' })
    await host.closeAll()
    require_.cache[require_.resolve(directoryPath)].exports = originalDirectory
    require_.cache[require_.resolve(providerPath)].exports = originalProvider
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  })
  const sent = await provider.send({ from: 'Manager', to: 'Recipient', body },
    { agentSessionId: managerId, agentPrincipal: { sessionId: managerId } })
  assert.equal(sent.delivered, true)
  const offers = () => engine.adapterCalls.filter(call => call.method === 'sendTurn' && call.request.text.includes(body)).length
  const notices = () => visible.filter(packet => packet.sessionId === managerId && packet.event?.text?.includes(sent.messageId))
  return { host, engine, provider, directory, recipientId, recipientStart, sent, body, offers, notices,
    discardAttempts: () => discardAttempts, state: () => JSON.parse(readFileSync(brokerFile, 'utf8')) }
}

test('bounded host refusal creates a durable dead letter and tells the sender once', async t => {
  const f = await fixture(t)
  await until(() => f.notices().length > 0, 'sender never received its later delivery failure')
  assert.equal(f.offers(), 3)
  assert.match(f.notices()[0].event.text, /set aside|dead letter/i)
  assert.equal(f.notices()[0].event.treeDelivery, false, 'the receipt is a host transport notice')
  assert.equal(f.state().deadLetters.filter(row => row.entry.messageId === f.sent.messageId).length, 1)
  await delay(180)
  assert.equal(f.notices().length, 1, 'polling must not repeat the receipt in the same session')
})

test('a replacement does not deliver a terminal predecessor record again', async t => {
  const f = await fixture(t)
  await until(() => f.notices().length > 0, 'the original refusal never settled')
  await f.host.startSession({ sessionId: `${f.recipientId}-next`, replacesSessionId: f.recipientId, ...f.recipientStart })
  await delay(250)
  assert.equal(f.offers(), 3, 'predecessor recovery replayed a message already set aside')
})

test('a refused dead-letter write retains the batch and retries recording without more model offers', async t => {
  const f = await fixture(t, { refuseDiscardOnce: true })
  await until(() => f.notices().length > 0, 'a refused durable write lost the batch instead of retrying')
  assert.equal(f.discardAttempts(), 2)
  assert.equal(f.offers(), 3, 'retrying persistence must not submit a fourth model turn')
  assert.equal(f.state().deadLetters.filter(row => row.entry.messageId === f.sent.messageId).length, 1)
})
