import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { reconnectRemoteSessions } from '../../src/remote-session-reconnect.js'
import { createSavedSessionRefusals } from '../../src/saved-session-refusals.js'
import { createEngineModelCatalog } from '../../src/engine-model-catalog.js'
import { remoteHistoryReplay } from '../../src/remote-session-history.js'
import { sessionTurnSucceeded } from '../../src/agent-session-events.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { computersViewAuthorityBindings } from './lib/computers-view-authority-bindings.mjs'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(nodes = [{ id: 'one', sessionId: 'live' }]) {
  const bindings = new Map()
  const restored = []
  return { nodes, bindings, getNode: id => nodes.find(node => node.id === id),
    readSession: async () => ({ models: [] }), onReconnect: node => restored.push(node.id), restored }
}

test('only a successful session-scoped host read restores a saved binding', async () => {
  const f = fixture([{ id: 'one', sessionId: 'live' }, { id: 'two', sessionId: 'dead' },
    { id: 'three', sessionId: 'foreign' }, { id: 'four', sessionId: null }])
  const reads = []
  f.readSession = async ({ sessionId }) => {
    reads.push(sessionId)
    if (sessionId !== 'live') throw Object.assign(new Error(), { code: 'MC_AGENT_UNKNOWN_SESSION' })
    assert.equal(f.bindings.size, 0)
    return { models: [] }
  }
  assert.deepEqual(await reconnectRemoteSessions(f), ['one'])
  assert.deepEqual([...f.bindings], [['live', 'one']])
  assert.deepEqual(reads.sort(), ['dead', 'foreign', 'live'])
})

test('a malformed answer or explicit refusal never establishes liveness', async () => {
  for (const answer of [null, {}, { ok: false, models: [] }, { models: 'not a catalog' }]) {
    const f = fixture(); f.readSession = async () => answer
    assert.deepEqual(await reconnectRemoteSessions(f), [])
    assert.equal(f.bindings.size, 0)
  }
})

test('a late answer cannot restore a removed or replaced node', async () => {
  for (const mutate of [f => f.nodes.splice(0), f => { f.nodes[0].sessionId = 'replacement' }]) {
    const f = fixture(), read = deferred()
    f.readSession = () => read.promise
    const pending = reconnectRemoteSessions(f)
    mutate(f); read.resolve({ models: [] })
    assert.deepEqual(await pending, [])
    assert.equal(f.bindings.size, 0)
  }
})

test('a late answer cannot attach after changing computer, source, or retiring the view', async () => {
  const f = fixture(), read = deferred()
  let current = true
  f.isCurrent = () => current; f.readSession = () => read.promise
  const pending = reconnectRemoteSessions(f)
  current = false; read.resolve({ models: [] })
  assert.deepEqual(await pending, [])
  assert.equal(f.bindings.size, 0)
})

test('an existing binding is never probed or overwritten by a racing read', async () => {
  const f = fixture(), read = deferred()
  f.readSession = () => read.promise
  const pending = reconnectRemoteSessions(f)
  f.bindings.set('live', 'new-owner'); read.resolve({ models: [] })
  assert.deepEqual(await pending, [])
  assert.equal(f.bindings.get('live'), 'new-owner')
  f.readSession = () => { assert.fail('an attached session must not be probed') }
  await reconnectRemoteSessions(f)
})

test('large saved fleets use bounded concurrency and stop when retired', async () => {
  const f = fixture(Array.from({ length: 30 }, (_, n) => ({ id: `node-${n}`, sessionId: `session-${n}` })))
  const reads = []
  let current = true
  f.isCurrent = () => current
  f.readSession = () => { const d = deferred(); reads.push(d); return d.promise }
  const pending = reconnectRemoteSessions(f)
  assert.equal(reads.length, 4)
  current = false
  for (const read of reads) read.resolve({ models: [] })
  await pending
  assert.equal(reads.length, 4)
  assert.equal(f.bindings.size, 0)
})

test('the Computers reconnect callback retains separate provider catalogs and completes history replay', async () => {
  const nodes = [{ id: 'one', sessionId: 'codex-live' }, { id: 'two', sessionId: 'claude-live' }]
  const store = { snapshot: () => ({ nodes }), getNode: id => nodes.find(node => node.id === id) }
  const catalog = createEngineModelCatalog(), bindings = new Map(), reads = [], warnings = [], swept = []
  let refreshed = 0
  const context = vm.createContext({
    ...computersViewAuthorityBindings(),
    suppliedCatalog: catalog, source: 'relay', treeStore: store, destroyed: false,
    window: { mcAgent: { async models({ sessionId }) {
      reads.push(sessionId)
      return sessionId === 'codex-live'
        ? { provider: 'codex', catalogSupported: true, models: [{ id: 'model', efforts: [{ id: 'high' }] }] }
        : { provider: 'claude', catalogSupported: false, models: [] }
    } }, mcRemoteEvents: { read() { throw new Error('History transport is a separate fixture boundary') } } },
    reconnectingStores: new WeakSet(), sessionNodeIds: bindings,
    /* The seam the seat counters read. A sweep that really ran is what turns
       RUN_SESSION_NODES from "nobody has asked the host yet" into evidence, so
       this fixture records that the reconnect settles it exactly once. */
    finishedSavedSessionSweep: store => { swept.push(store) },
    remotePendingPackets: new Map(), remoteAppliedSequences: new Map(),
    reconnectRemoteSessions, readRemoteSessionHistory: async () => ({ events: [], seq: 0, dropped: false }),
    remoteHistoryReplay, sessionTurnSucceeded, transcriptStore: null, replayingRemoteHistory: false,
    refreshTree: () => { refreshed++ }, chatSurfacesFor: () => [], currentRailTreeNode: null,
    setOrgStatus: (...args) => warnings.push(args),
  })
  const view = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  vm.runInContext(`const engineModelCatalog = suppliedCatalog; ${declaredFunctionSource(view, 'reconnectSavedRemoteSessions')}`, context)
  await vm.runInContext('reconnectSavedRemoteSessions()', context)
  assert.deepEqual(warnings, [], 'an accepted remote read must not abort the remaining reconnect callback')
  assert.equal(refreshed, 2)
  assert.deepEqual([...bindings], [['codex-live', 'one'], ['claude-live', 'two']])
  assert.deepEqual(reads.sort(), ['claude-live', 'codex-live'], 'reuse each ownership-checked answer without another transport request')
  assert.deepEqual(catalog.efforts('codex-live', 'codex', 'model'), [{ id: 'high' }])
  assert.deepEqual(catalog.efforts('claude-live', 'claude', 'model'), [])
  assert.deepEqual(catalog.efforts('codex-live', 'claude', 'model'), [])
  assert.deepEqual(swept, [store],
    'the reconnect must settle the seat evidence for the store it swept, and only once')
})

/* T407 REVIEW: THE GAP THE SEAT COUNT MUST NOT READ AS DEATH.
 *
 * reconnectRemoteSessions restores a binding only AFTER an awaited host round
 * trip, so between a renderer reload and that answer the bindings map is empty
 * while the sessions in it are still running. A seat counter that reads the map
 * in that gap frees four occupied seats and lets the parent take a fifth. This
 * is the measurement behind createFleetTreeStore withholding the map until the
 * sweep settles; it drives the real module rather than restating it. */
test('a saved session is absent from the bindings until the host has answered for it', async () => {
  const f = fixture([{ id: 'one', sessionId: 'still-running' }])
  const answer = deferred()
  const seenDuringProbe = []
  f.readSession = async () => {
    seenDuringProbe.push([...f.bindings.keys()])
    return answer.promise
  }
  const sweep = reconnectRemoteSessions(f)
  await Promise.resolve()
  assert.deepEqual([...f.bindings.keys()], [],
    'the map is empty while the host is being asked, though the session is alive')
  answer.resolve({ models: [] })
  assert.deepEqual(await sweep, ['one'])
  assert.deepEqual([...f.bindings.keys()], ['still-running'],
    'the binding appears only once the host has confirmed it')
  assert.deepEqual(seenDuringProbe, [[]])
})

/* T830: THE STORM THE REFUSAL MEMORY EXISTS TO END. MEASURED 2026-09-21 on the
 * LIVE generation (app d46c18f49): 303 refused mc-agent:models reads in 27
 * minutes, in bursts of 77, 76, 75 and 75 -- one refused read per saved circle
 * of an earlier run, per mount of the Agents page or the Home chat -- because
 * the sweep asked the host about every saved circle it did not own on every
 * mount and remembered nothing between mounts. The host's refusal reaches the
 * window as the sentence Electron wraps a rejected invoke in; the code
 * property does not survive the IPC boundary, so that is what these send. */
const hostRefuses = () => { throw new Error("Error invoking remote method 'mc-agent:models': Error: MC_AGENT_UNKNOWN_SESSION") }

test('a session the host does not hold is asked about once across sweeps, and again only when its circle changes', async () => {
  const nodes = [{ id: 'gone', sessionId: 'session-from-an-earlier-run', status: 'finished' },
    { id: 'alive', sessionId: 'still-running', status: 'running' }]
  const f = fixture(nodes)
  f.refusals = createSavedSessionRefusals()
  const reads = []
  f.readSession = async ({ sessionId }) => {
    reads.push(sessionId)
    if (sessionId === 'still-running') return { models: [] }
    hostRefuses()
  }
  for (let sweep = 0; sweep < 5; sweep += 1) await reconnectRemoteSessions(f)
  assert.deepEqual(reads, ['session-from-an-earlier-run', 'still-running'],
    'five sweeps ask once about the refused session; the live one binds on the first sweep and is never probed again')
  assert.deepEqual([...f.bindings], [['still-running', 'alive']])
  nodes[0].status = 'starting'
  await reconnectRemoteSessions(f)
  assert.deepEqual(reads.slice(2), ['session-from-an-earlier-run'], 'a status change is asked about, once')
  await reconnectRemoteSessions(f)
  assert.equal(reads.length, 3, 'and not again while nothing changes')
  nodes[0].sessionId = 'a-replacement-session'
  await reconnectRemoteSessions(f)
  await reconnectRemoteSessions(f)
  assert.deepEqual(reads.slice(3), ['a-replacement-session'], 'a new session is a new question, asked once')
})

test('a refusal that is not terminal is retried on every sweep, and a session the host answers for is forgotten', async () => {
  const nodes = [{ id: 'one', sessionId: 'not-ready-yet', status: 'running' }]
  const f = fixture(nodes)
  f.refusals = createSavedSessionRefusals()
  let answer = () => { throw new Error('the host is not ready') }
  const reads = []
  f.readSession = async ({ sessionId }) => { reads.push(sessionId); return answer() }
  await reconnectRemoteSessions(f)
  await reconnectRemoteSessions(f)
  assert.equal(reads.length, 2, 'a transport failure is not a verdict on the session and is retried')
  answer = () => ({ ok: false, code: 'MC_AGENT_SESSION_ENDED' })
  await reconnectRemoteSessions(f)
  await reconnectRemoteSessions(f)
  assert.equal(reads.length, 3, 'an ended session is remembered from a coded answer as well as from a thrown refusal')
  /* The circle changed and the host holds it after all: bound, and the
     memory of the refusal is gone with it. */
  nodes[0].status = 'starting'
  answer = () => ({ models: [] })
  await reconnectRemoteSessions(f)
  assert.deepEqual([...f.bindings], [['not-ready-yet', 'one']])
  assert.equal(reads.length, 4)
  /* The session ends later and leaves the bindings; the next sweep asks the
     host exactly once more and remembers that answer. */
  f.bindings.delete('not-ready-yet')
  answer = hostRefuses
  await reconnectRemoteSessions(f)
  await reconnectRemoteSessions(f)
  assert.equal(reads.length, 5, 'a session answered for and then lost is asked about once, not on every sweep')
})
