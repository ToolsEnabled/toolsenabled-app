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
async function until(check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await delay(10)
  }
  assert.fail(message)
}
async function fixture(t) {
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
    treeCourier: { pollMs: 20, heartbeatMs: 1000 },
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
  return { host, identity, events, packets, sends, retired, record, confirmed }
}

test('automatic account recovery preserves queued tree work for one successor handoff', async t => {
  const f = await fixture(t)
  f.events.get(0)({ type: 'turn_completed', turnId: 'turn-1', status: 'failed', code: 'ACP_RATE_LIMITED' })
  await until(() => f.packets.some(packet => packet.event?.type === 'account_recovery_needed'), 'limit must issue a real recovery ticket')
  const offer = f.packets.find(packet => packet.event?.type === 'account_recovery_needed').event
  await f.host.closeSession({ sessionId: 'original', accountRecovery: { recoveryId: offer.recoveryId } })
  assert.deepEqual(f.retired, [{ verb: 'defer', id: f.record.message.id }], 'recovery must park accepted work, never tell its sender it was discarded')
  await f.host.startSession({ sessionId: 'successor', replacesSessionId: 'original', accountRecovery: { recoveryId: offer.recoveryId }, ...f.identity })
  await until(() => f.sends.some(row => row.ordinal === 1 && row.request.text.includes('Synthetic queued work')), 'successor must receive the retained envelope')
  await delay(100)
  assert.equal(f.sends.filter(row => row.ordinal === 1 && row.request.text.includes('Synthetic queued work')).length, 1)
  assert.equal(f.retired.filter(row => row.verb === 'discard').length, 0)
  assert.equal(f.confirmed.has(f.record.message.id), true, 'the recovered model handoff must be acknowledged')
})

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

test('a stale recovery close returns a coded result and leaves the live session owned', async t => {
  const f = await fixture(t), surface = surfaceFor(f.host)
  const result = await surface.surface.run('agent:close', { sessionId: 'original', accountRecovery: { recoveryId: 'stale-ticket' } }, surface.principal)
  assert.equal(result.ok, false)
  assert.equal(result.closed, false)
  assert.equal(result.code, 'AGENT_ACCOUNT_RECOVERY_UNAVAILABLE')
  assert.equal(surface.ends.length, 0)
  assert.equal(surface.sessions.has('original'), true)
  assert.equal(f.host.sessionAccounts().some(row => row.sessionId === 'original'), true)
  assert.deepEqual(f.retired, [])
  // The other losing path arrives after an earlier close removed the session.
  // A recovery retry must remain a coded result, never an Electron handler error.
  await surface.surface.run('agent:close', { sessionId: 'original' }, surface.principal)
  const alreadyClosed = await surface.surface.run('agent:close', { sessionId: 'original', accountRecovery: { recoveryId: 'stale-ticket' } }, surface.principal)
  assert.equal(alreadyClosed.ok, false)
  assert.equal(alreadyClosed.closed, false)
  assert.equal(alreadyClosed.code, 'AGENT_ACCOUNT_RECOVERY_UNAVAILABLE')
  assert.equal(surface.ends.length, 1, 'the repeated recovery close records no second ending')
  await assert.rejects(() => surface.surface.run('agent:close', { sessionId: 'original' }, surface.principal), { code: 'MC_AGENT_UNKNOWN_SESSION' })
})
