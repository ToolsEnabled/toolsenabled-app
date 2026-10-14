import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { canonicalRootForTests } from '../canonical-root.mjs'

/* A REPLACED SESSION'S INBOX IS READ FROM ITS STORED READ POSITION (T1744).
 *
 * Builder 2's packet, both halves: when a session discovers the predecessor
 * it replaced, the courier's first page of that predecessor's inbox asks the
 * engine for its durable read cursor (includeReadPosition), and the courier
 * starts there. Starting at zero instead counted already-read, compacted
 * history as lost ("N missing") and replayed its retained tail. Missing or
 * invalid position data holds that predecessor and says so once; a failed
 * position read omits the page for a retry; a pending handoff above the
 * stored cursor is still delivered and acknowledged. These are Builder 2's
 * own cases, moved from the packet's standalone runner into the repository.
 * They drive the real engine provider over a synthetic fabric and directory. */
const require_ = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const engineRoot = canonicalRootForTests()
const { createLocalAgentMessageProvider } = require_(path.join(engineRoot, 'src/lib/providers/agent-comms-local.js'))
const { createAgentHost } = require_(path.join(root, 'shell/agent-host.cjs'))
const fixture = path.join(root, 'tools/test/fixtures/confined-engine/src/lib')
const enginePath = path.join(fixture, 'agent-engine/codex-process.js')
const providerPath = path.join(fixture, 'providers/agent-comms-local.js')
const directoryPath = path.join(fixture, 'agent-comms/tree-node-directory.js')
const originalProvider = require_(providerPath)
const originalDirectory = require_(directoryPath)
const engine = require_(enginePath)

async function until(fn, message, ms = 1200) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return; await delay(15) }
  assert.fail(message)
}

async function setup(t, storedCursor, { single = false, noPosition = false, badPosition = false, pending = false } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'predecessor-read-position-'))
  const oldId = 'fixture-old', currentId = 'fixture-current'
  const rows = new Map([[oldId, { agentId: oldId, sessionId: 'old', nodeName: 'Synthetic worker', nodeKey: 'synthetic-node',
    treeKey: 'synthetic-node', supersededBy: null }]])
  const directory = {
    agentIdForSession: id => 'fixture-' + id,
    registerNode: input => {
      const agentId = 'fixture-' + input.sessionId
      if (agentId === currentId) rows.get(oldId).supersededBy = currentId
      const row = { ...input, agentId, nodeKey: 'synthetic-node', treeKey: 'synthetic-node' }
      rows.set(agentId, row)
      return row
    },
    listNodes: () => [...rows.values()].map(x => ({ ...x })),
    successorOf: id => rows.get(id)?.supersededBy || null,
    heartbeatNode: () => ({ found: true }), unregisterNode: () => ({ removed: true }),
    bindThread: () => ({ found: true }), findByThreadId: () => null,
  }
  const reads = [], events = [], positionReads = []
  let acked = false
  const envelope = n => ({ id: 'old-' + n, sender: { agentId: 'synthetic-sender', machineId: 'synthetic-machine' },
    audience: { type: 'direct', agent: { agentId: oldId, machineId: 'synthetic-machine' } }, kind: 'notice', body: 'Previously retained record ' + n })
  const pendingMessage = { ...envelope('pending'), body: 'Pending retained envelope' }
  const fabric = {
    read: async ({ agent, cursor, limit }) => {
      reads.push({ agentId: agent.agentId, cursor })
      if (agent.agentId !== oldId) return { status: 'CAUGHT_UP', floorSequence: 1, headSequence: 0, records: [] }
      return { status: cursor < 222 ? 'TRUNCATED' : 'CAUGHT_UP', floorSequence: 223, headSequence: 243,
        records: cursor < 222 ? [] : Array.from({ length: 21 }, (_, i) => 223 + i).filter(n => n > cursor).slice(0, limit)
          .map(sequence => ({ sequence, message: envelope(sequence) })) }
    },
    deliveryFailures: () => pending && !acked ? [{ code: 'BROKER_DELIVERY_AWAITING_MODEL', recipientAgentId: oldId,
      messageId: pendingMessage.id, message: pendingMessage, at: 1 }] : [],
    markRead: () => ({ accepted: true }),
    acknowledgeDeferredDelivery: () => { acked = true; return { accepted: true } },
  }
  if (!noPosition) {
    fabric.position = ({ agent }) => {
      positionReads.push(agent.agentId)
      if (badPosition) throw Error('synthetic read failure')
      return { cursor: agent.agentId === oldId ? storedCursor : 0 }
    }
  }
  const runtime = { identity: agentId => ({ agentId, machineId: 'synthetic-machine' }), fabric }
  const provider = createLocalAgentMessageProvider({ directory, runtimeFactory: () => runtime,
    brokerFile: path.join(scratch, 'inert-broker.json'), readDelegationPolicy: () => ({}) })
  const exposed = { ...provider }
  if (single) delete exposed.inboxes
  require_.cache[require_.resolve(providerPath)].exports = exposed
  require_.cache[require_.resolve(directoryPath)].exports = { createTreeNodeDirectory: () => directory }
  engine.calls.length = 0; engine.adapterCalls.length = 0; engine.control.holdTurns = false
  const host = createAgentHost({ enginePath, defaultCwd: scratch, freeMemory: () => 64 * 1024 ** 3,
    treeCourier: { pollMs: 15, heartbeatMs: 1000, readDeadlineMs: 100 }, onEvent: event => events.push(event),
    confinementPlanner: () => ({ ok: true, tier: 'standard', isolated: true,
      threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(scratch, 'synthetic-agent-home') }, servers: ['toolsenabled-readonly', 'toolsenabled'] }) })
  host.onEvent(event => events.push(event))
  t.after(async () => {
    await host.closeAll()
    require_.cache[require_.resolve(providerPath)].exports = originalProvider
    require_.cache[require_.resolve(directoryPath)].exports = originalDirectory
    fs.rmSync(scratch, { recursive: true, force: true })
  })
  await host.startSession({ sessionId: 'current', replacesSessionId: 'old', treeIdentity: { selfName: 'Synthetic worker', managerName: null },
    requestKeys: { treeAnchors: ['synthetic-node'], threadId: 'synthetic-node' } })
  return { reads, events, positionReads, acked: () => acked, oldReads: () => reads.filter(r => r.agentId === oldId),
    bodies: () => engine.adapterCalls.filter(c => ['sendTurn', 'steerTurn'].includes(c.method)).map(c => c.request.text).join('\n') }
}

for (const single of [false, true]) {
  test('fully read predecessor has no false expiry or replay; single=' + single, async t => {
    const f = await setup(t, 243, { single })
    await until(() => f.oldReads().length >= 3, 'predecessor not polled')
    await delay(100)
    assert.doesNotMatch(f.bodies(), /expired before this session|Previously retained record/)
    assert.ok(f.oldReads().some(r => r.cursor === 243), 'durable predecessor cursor was not used')
    assert.deepEqual(f.positionReads, ['fixture-old'], 'durable lookup is only needed on initial predecessor read')
  })
  test('only genuinely unread expired prefix is counted; single=' + single, async t => {
    const f = await setup(t, 200, { single })
    await until(() => f.bodies().includes('missing)'), 'missing-prefix notice not delivered')
    assert.match(f.bodies(), /\(22 missing\)/)
    assert.doesNotMatch(f.bodies(), /\(222 missing\)/)
  })
}

test('missing cursor metadata holds predecessor without invented expiry', async t => {
  const f = await setup(t, 243, { noPosition: true })
  await until(() => f.oldReads().length >= 3, 'predecessor not polled')
  await delay(100)
  assert.doesNotMatch(f.bodies(), /expired before this session|Previously retained record/)
  assert.match(JSON.stringify(f.events), /previous inbox read position could not be confirmed/i)
})

test('cursor above page head is refused without consuming predecessor', async t => {
  const f = await setup(t, 244)
  await until(() => f.oldReads().length >= 3, 'predecessor not polled')
  await delay(100)
  assert.doesNotMatch(f.bodies(), /expired before this session|Previously retained record/)
  assert.ok(f.oldReads().every(r => r.cursor === 0))
})

test('failed stored-position read is omitted instead of becoming cursor zero', async t => {
  const f = await setup(t, 243, { badPosition: true })
  await until(() => f.oldReads().length >= 3, 'predecessor not polled')
  await delay(100)
  assert.doesNotMatch(f.bodies(), /expired before this session|Previously retained record/)
})

test('acknowledged history does not hide a separately retained pending handoff', async t => {
  const f = await setup(t, 243, { pending: true })
  await until(() => f.bodies().includes('Pending retained envelope'), 'pending handoff was hidden by durable cursor')
  assert.doesNotMatch(f.bodies(), /expired before this session|Previously retained record/)
  await until(f.acked, 'pending handoff was not acknowledged')
})
