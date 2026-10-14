import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
const require = createRequire(import.meta.url)
const app = path.resolve(import.meta.dirname, '../..')
const fixtures = path.join(import.meta.dirname, 'fixtures/confined-engine/src/lib')
const enginePath = path.join(fixtures, 'agent-engine/codex-process.js')
const directoryPath = path.join(fixtures, 'agent-comms/tree-node-directory.js')
const providerPath = path.join(fixtures, 'providers/agent-comms-local.js')
const { createAgentHost } = require('../../shell/agent-host.cjs')
const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')
/* The courier's poll in these fixtures. The per-boundary yield and the yield bound in
   shell/tree-turn-priority.cjs are small multiples of it. */
const POLL_MS = 20
async function until(check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await delay(10)
  }
  assert.fail(message)
}
async function fixture(t, { recoveryHoldMs } = {}) {
  const provider = require(providerPath), engine = require(enginePath)
  require(directoryPath)
  provider.reset()
  const originalDirectory = require.cache[directoryPath].exports
  const originalProvider = require.cache[providerPath].exports
  const originalStart = engine.startCodexSession
  const rows = new Map(), events = new Map(), sends = [], retired = [], confirmed = new Set()
  const idFor = id => `fixture-${id}`
  const directory = {
    supportsExactReplacement: true,
    registerNode(request) {
      const entry = { ...request, agentId: idFor(request.sessionId), stoppedAt: null }
      const prior = rows.get(request.replacesSessionId)
      if (prior) Object.assign(prior, { stoppedAt: 1, supersededBy: entry.agentId })
      rows.set(request.sessionId, entry)
      return entry
    },
    unregisterNode({ sessionId }) { if (rows.has(sessionId)) rows.get(sessionId).stoppedAt = 1; return { removed: true } },
    heartbeatNode() { return { found: true } },
    bindThread() { return { found: true } },
    listNodes() { return [...rows.values()] },
    successorOf(agentId) { return [...rows.values()].find(row => row.agentId === agentId)?.supersededBy || null },
  }
  require.cache[directoryPath].exports = { createTreeNodeDirectory: () => directory }
  require.cache[providerPath].exports = { ...provider,
    async defer({ message }) { retired.push({ verb: 'defer', id: message.id }); return { accepted: true } },
    async discard({ message }) { retired.push({ verb: 'discard', id: message.id }); return { accepted: true } },
    async acknowledgeDeferred({ message }) { confirmed.add(message.id); return { accepted: true } },
  }
  engine.startCodexSession = async options => {
    const ordinal = events.size
    events.set(ordinal, options.onEvent)
    return { threadId: `thread-${ordinal}`, close() {}, adapter: {
      async sendTurn(request) { sends.push({ ordinal, request }); return { turnId: `turn-${sends.length}` } },
      async interrupt() {},
    } }
  }
  const host = createAgentHost({ enginePath, defaultCwd: app, freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    recoveryEnabled: () => true,
    accountResolver: async request => ({ rotated: true, account: { name: request.excludeAccounts ? 'backup' : 'primary', provider: 'codex' } }),
    treeCourier: { pollMs: POLL_MS, heartbeatMs: 1000, ...(recoveryHoldMs ? { recoveryHoldMs } : {}) },
    messageDeliveryReader: () => ({ mode: 'end-of-turn', intervalMs: 30000 }),
  })
  t.after(async () => {
    await host.closeAll()
    engine.startCodexSession = originalStart
    require.cache[directoryPath].exports = originalDirectory
    require.cache[providerPath].exports = originalProvider
    provider.reset()
  })
  const packets = []
  host.onEvent(packet => packets.push(packet))
  const identity = { requestKeys: { treeAnchors: ['root', 'node'], threadId: 'node' },
    treeIdentity: { selfName: 'Worker', managerName: 'Manager' } }
  await host.startSession({ sessionId: 'original', ...identity })
  await host.sendTurn({ sessionId: 'original', text: 'Synthetic assigned work' })
  const record = provider.deliver({ recipientAgentId: idFor('original'), senderAgentId: idFor('manager'), body: 'Synthetic queued work' })
  await until(() => packets.some(packet => packet.event?.treeDelivery), 'the real host must hold the queued envelope')
  return { host, identity, events, packets, sends, retired, record, confirmed, reads: () => provider.readCount() }
}

/* EVERY CHANCE THE COURIER GETS BEFORE A REAL WINDOW ACCEPTS THE OFFER. The recovery coordinator
   (src/account-recovery-coordinator.js, recover()) reads the saved retry choice and saves the
   handoff and the conversation before it closes the limited session, so in the app the courier
   polls several times between the offer and the close. Wait until the courier's per-boundary
   yield and its yield bound have both run out, then for two more whole rounds, so this order is
   the same on every machine instead of depending on how late a 10 ms timer fires. */
async function courierHadItsChance(f, since) {
  await until(() => Date.now() - since >= POLL_MS * 6, 'the clock must move')
  const reads = f.reads()
  await until(() => f.reads() >= reads + 2, 'the courier must keep reading while the offer is open')
}







test('a deliberate Stop retains its existing explicit queue-discard behavior', async t => {
  const f = await fixture(t)
  await f.host.closeSession({ sessionId: 'original' })
  assert.deepEqual(f.retired, [{ verb: 'discard', id: f.record.message.id }])
})

function surfaceFor(host, sessionId = 'original') {
  const owner = {}, sessions = new Map([[sessionId, { owner }]]), ends = []
  const unexpected = () => { throw new Error('unexpected dependency') }
  const deps = Object.fromEntries(Object.entries(REQUIRED_DEPS).map(([key, kind]) =>
    [key, kind === 'function' ? unexpected : kind === 'number' ? 128 : kind === 'string' ? app : {}]))
  Object.assign(deps, { agentSessions: sessions, currentAgentHost: () => host,
    dialog: { showOpenDialog: unexpected }, AGENT_EFFORT_VALUES: [],
    agentIpcError: (code, message) => { throw Object.assign(new Error(message), { code }) },
    agentPayload: (value, allowed) => { assert.ok(Object.keys(value).every(key => allowed.includes(key))); return value },
    boundedAgentString: value => { assert.equal(typeof value, 'string'); return value },
    parseAgentSessionCommand: value => value,
    rendererSafeAgentError: error => Object.assign(new Error(error.code), { code: error.code }),
    recordSessionEnd: (...args) => ends.push(args),
  })
  return { surface: createAgentCommandSurface(deps), sessions, ends,
    principal: { kind: 'window', owner, mayWrite: true, label: 'fixture' } }
}
