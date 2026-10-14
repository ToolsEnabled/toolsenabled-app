import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { computersViewAuthorityBindings } from './lib/computers-view-authority-bindings.mjs'
import { sessionTurnSucceeded } from '../../src/agent-session-events.js'
import { createEngineModelCatalog } from '../../src/engine-model-catalog.js'
import { reconnectRemoteSessions } from '../../src/remote-session-reconnect.js'
import { readRemoteSessionHistory, remoteHistoryReplay } from '../../src/remote-session-history.js'
const source = fs.readFileSync(new URL('../../shell/agent-host.cjs', import.meta.url), 'utf8')
function host(sessions) {
  const start = source.indexOf('  async function listEngineModels(')
  const end = source.indexOf('\n  /* The shared reply carries', start)
  assert.ok(start >= 0 && end > start)
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
  return vm.runInNewContext(`${source.slice(start, end)}\nlistEngineModels`, {
    sessions, fail, assertOpen() {}, readySession(id) { const s = sessions.get(id); if (!s) fail('UNKNOWN_SESSION'); return s },
  })
}
test('ready native Claude reports unsupported catalog, not missing login/session', async () => {
  const list = host(new Map([['claude', { state: 'ready', provider: 'claude', adapter: {} }]]))
  const result = await list({ sessionId: 'claude' })
  assert.equal(result.catalogSupported, false); assert.equal(result.provider, 'claude'); assert.equal(result.models.length, 0)
})
test('real adapter discovery still executes; host owns provider capability labels', async () => {
  let calls = 0
  const models = [{ id: 'codex-model', efforts: [{ id: 'high' }] }]
  const list = host(new Map([['codex', { state: 'ready', provider: 'codex', adapter: { async listModels() {
    calls++; return { models, provider: 'forged', catalogSupported: false }
  } } }]]))
  const result = await list({ sessionId: 'codex' })
  assert.equal(calls, 1); assert.equal(result.provider, 'codex'); assert.equal(result.catalogSupported, true)
  assert.equal(result.models, models)
  await assert.rejects(host(new Map())(), { code: 'AGENT_MODELS_UNAVAILABLE' })
})
test('unsupported Claude caches once and cannot borrow Codex model efforts', async () => {
  const catalog = createEngineModelCatalog(), calls = []
  const bridge = { async models({ sessionId }) { calls.push(sessionId); return sessionId === 'claude'
    ? { provider: 'claude', catalogSupported: false, models: [] }
    : { provider: 'codex', catalogSupported: true, models: [{ id: 'codex-model', efforts: [{ id: 'high' }] }] } } }
  await catalog.read('claude', bridge); await catalog.read('claude', bridge)
  await catalog.read('codex', bridge)
  assert.deepEqual(calls, ['claude', 'codex'])
  assert.deepEqual(catalog.efforts('claude', 'claude', 'codex-model'), [])
  assert.deepEqual(catalog.efforts('codex', 'claude', 'codex-model'), [])
  assert.deepEqual(catalog.efforts('codex', 'codex', 'unknown'), [])
  assert.deepEqual(catalog.efforts('codex', 'codex', 'codex-model'), [{ id: 'high' }])
})
test('catalogs remain session scoped and in-flight queries singleflight', async () => {
  const catalog = createEngineModelCatalog()
  let resolve, calls = 0
  const bridge = { models() { calls++; return new Promise(r => { resolve = r }) } }
  const first = catalog.read('one', bridge)
  await catalog.read('one', bridge)
  assert.equal(calls, 1)
  resolve({ provider: 'codex', catalogSupported: true, models: [{ id: 'm', efforts: [{ id: 'low' }] }] })
  await first
  assert.deepEqual(catalog.efforts('two', 'codex', 'm'), [])
})
test('transport failures retry; legacy unlabeled catalogs never establish model support', async () => {
  const catalog = createEngineModelCatalog()
  await catalog.read('one', { models() { throw new Error('unavailable') } })
  await catalog.read('one', { models: async () => ({ models: [{ id: 'm', efforts: [{ id: 'high' }] }] }) })
  assert.deepEqual(catalog.efforts('one', 'codex', 'm'), [])
  await catalog.read('one', { models: async () => ({ provider: 'codex', catalogSupported: true, models: [{ id: 'm', efforts: [{ id: 'high' }] }] }) })
  assert.deepEqual(catalog.efforts('one', 'codex', 'm'), [{ id: 'high' }])
})

test('the view reconnects saved sessions, replays history and retains each provider catalog', async () => {
  const view = fs.readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  const start = view.indexOf('  const reconnectingStores = new WeakSet()')
  const end = view.indexOf('\n  /* The chat composer', start)
  assert.ok(start >= 0 && end > start, 'execute the production reconnect callback')
  const nodes = [{ id: 'one', sessionId: 'codex' }, { id: 'two', sessionId: 'claude' }]
  const sessionNodeIds = new Map(), notices = [], replayed = [], reads = [], addressSyncs = []
  let refreshed = 0
  const program = `const engineModelCatalog = createEngineModelCatalog();\n${view.slice(start, end)}\n`
    + 'handleAgentEvent = onPacket; ({ reconnect: reconnectSavedRemoteSessions, catalog: engineModelCatalog })'
  const harness = vm.runInNewContext(program, {
    ...computersViewAuthorityBindings(),
    createEngineModelCatalog, reconnectRemoteSessions, readRemoteSessionHistory, remoteHistoryReplay, sessionTurnSucceeded,
    source: 'relay', destroyed: false, sessionNodeIds,
    treeStore: { snapshot: () => ({ nodes }), getNode: id => nodes.find(node => node.id === id) },
    transcriptStore: { get: () => null }, currentRailTreeNode: null,
    setOrgStatus: message => notices.push(message), refreshTree: () => { refreshed++ },
    /* A settled sweep re-asserts the saved tree over the directory (T211) and
       repaints the canvas (T407). Recorded here rather than stubbed away, so
       this fixture notices if either stops happening. */
    syncTreeBranchAddresses: rootId => { addressSyncs.push(rootId) },
    chatSurfacesFor: () => [], onPacket: packet => replayed.push(packet),
    window: {
      mcAgent: { models: async ({ sessionId }) => {
        reads.push(sessionId)
        return sessionId === 'codex'
          ? { provider: 'codex', catalogSupported: true, models: [{ id: 'm', efforts: [{ id: 'high' }] }] }
          : { provider: 'claude', catalogSupported: false, models: [] }
      } },
      mcRemoteEvents: { read: async ({ sessionId }) => ({ ok: true, seq: 1, events: [{ seq: 1,
        packet: { sessionId, event: { type: 'assistant_text', turnId: 'turn', text: `Recovered ${sessionId}` } }
      }] }) },
    },
  })
  await harness.reconnect()
  assert.deepEqual(notices, [], 'a live saved session must not hit the reconnect error path')
  assert.deepEqual([...sessionNodeIds], [['codex', 'one'], ['claude', 'two']])
  assert.deepEqual(reads.sort(), ['claude', 'codex'], 'reuse each verified response without another transport call')
  /* One repaint per restored session, plus ONE MORE when the sweep settles.
     That last one is not decoration: extensionPoints() has by then already
     drawn the canvas against session evidence that had not arrived, so without
     it a seat freed by the sweep stays withdrawn on screen (measured on a
     private candidate 2026-09-19). Raised from 2 deliberately. */
  assert.equal(refreshed, 3)
  assert.deepEqual(replayed.filter(packet => packet.event.type === 'assistant_text')
    .map(packet => packet.event.text).sort(), ['Recovered claude', 'Recovered codex'])
  assert.deepEqual(harness.catalog.efforts('codex', 'codex', 'm'), [{ id: 'high' }])
  assert.deepEqual(harness.catalog.efforts('claude', 'claude', 'm'), [])
  assert.deepEqual(harness.catalog.efforts('codex', 'claude', 'm'), [])
  assert.deepEqual(addressSyncs.sort(), ['one', 'two'],
    'a settled sweep re-asserts the saved tree from every root')
})

test('a reconnected catalog remains session scoped and supersedes an older pending read', async () => {
  const catalog = createEngineModelCatalog()
  let release
  const pending = catalog.read('reconnected', { models: () => new Promise(resolve => { release = resolve }) })
  catalog.record('reconnected', { provider: 'codex', catalogSupported: true,
    models: [{ id: 'current-model', efforts: [{ id: 'high' }] }] })
  catalog.record('unsupported', { provider: 'claude', catalogSupported: false, models: [] })
  release({ provider: 'codex', catalogSupported: true, models: [{ id: 'old-model', efforts: [{ id: 'low' }] }] })
  await pending
  assert.deepEqual(catalog.efforts('reconnected', 'codex', 'current-model'), [{ id: 'high' }])
  assert.deepEqual(catalog.efforts('reconnected', 'codex', 'old-model'), [])
  assert.deepEqual(catalog.efforts('unsupported', 'claude', 'current-model'), [])
  assert.deepEqual(catalog.efforts('other-session', 'codex', 'current-model'), [])
})

/* T830: a session the host does not hold answers the same way every time it
   is asked, and every refused read is an Electron handler stack in the host's
   log (303 of them in 27 minutes on the 2026-09-21 LIVE generation, from the
   saved-session sweep; the catalog forgot its refusals the same way). The
   refusal arrives as the sentence Electron wraps a rejected invoke in. */
test('a session the host does not hold is asked about once; a transport failure is still retried', async () => {
  const catalog = createEngineModelCatalog()
  const calls = []
  const unknown = { models: async ({ sessionId }) => {
    calls.push(sessionId)
    throw new Error("Error invoking remote method 'mc-agent:models': Error: MC_AGENT_UNKNOWN_SESSION")
  } }
  await catalog.read('earlier-run', unknown)
  await catalog.read('earlier-run', unknown)
  await catalog.read('earlier-run', unknown)
  assert.deepEqual(calls, ['earlier-run'], 'three reads of a session the host refused cost one refused read, not three')
  assert.deepEqual(catalog.efforts('earlier-run', 'codex', 'm'), [], 'a refused session offers no efforts')
  const ended = { models: async ({ sessionId }) => { calls.push(sessionId); return { ok: false, code: 'MC_AGENT_SESSION_ENDED' } } }
  await catalog.read('ended', ended)
  await catalog.read('ended', ended)
  assert.deepEqual(calls, ['earlier-run', 'ended'], 'an ended session answered with a code is remembered the same way')
  const flaky = { models: async ({ sessionId }) => { calls.push(sessionId); throw new Error('unavailable') } }
  await catalog.read('not-ready', flaky)
  await catalog.read('not-ready', flaky)
  assert.deepEqual(calls.slice(2), ['not-ready', 'not-ready'], 'a transport failure is no verdict on the session and is retried')
  /* A reconnect that really verified the session replaces the memory. */
  catalog.record('earlier-run', { provider: 'codex', catalogSupported: true, models: [{ id: 'm', efforts: [{ id: 'high' }] }] })
  assert.deepEqual(catalog.efforts('earlier-run', 'codex', 'm'), [{ id: 'high' }])
})
