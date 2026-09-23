import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseAst } from 'rollup/parseAst'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { sessionTurnSucceeded, sessionTurnCancelled, nodeStatusForTurn } from '../../src/agent-session-events.js'
import { TURN_CANCELLED } from '../../src/fleet-tree-copy.js'
import { createSingleFlight } from '../../src/single-flight.js'
import { adoptStandaloneIntoTree } from '../../src/tree-standalone-adoption.js'

// Exercise the actual page adapter against a real store. Its surrounding view
// is supplied explicitly so this test can inspect ownership and saved history
// without mounting native sessions or replacing the implementation with a copy.
const source = fs.readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const ast = parseAst(source)
const pageBody = ast.body.find(node => node.declaration?.id?.name === 'computersView').declaration.body.body
const method = name => { const node = pageBody.find(node => node.id?.name === name); return source.slice(node.start, node.end) }

function fixture({ active = true, endedDuringAdoption = false, mock = false, outcome = null, hostWait = null } = {}) {
  let data = null
  const treeStore = createFleetTreeStore({ computerId: 'local', storage: { read: () => data, write: (_k, value) => { data = value; return true } } })
  const history = [{ who: 'you', text: 'Original task', at: 11 }, { who: 'agent', text: 'Previous reply', at: 12 }]
  let snapshot = { sessionId: active ? 'kept-session' : null, phase: active ? 'working' : 'draft', lastTurnStatus: outcome, prompt: 'Original task', transcript: history, currentText: 'Answer so far', turnId: 'kept-turn' }
  const saved = new Map(), calls = [], binding = {}, maps = Object.fromEntries(['standaloneSettledTurns', 'sessionNodeIds', 'sessionThreadIds', 'sessionAccountNames', 'sessionEfforts', 'sessionTranscripts', 'sessionTurnText', 'sessionOpenTurns', 'nodeReplies'].map(key => [key, new Map()]))
  const record = { id: 'standalone:one', standalone: true, session: {
    beginPlacement: () => ({ ok: true, snapshot: structuredClone(snapshot) }), snapshot: () => structuredClone(snapshot),
    commitPlacement(value) { Object.assign(binding, value); return structuredClone(snapshot) }, cancelPlacement: () => calls.push('cancel'),
  } }
  const env = {
    destroyed: false, mockSource: () => mock, treeStore, transcriptStore: { save: (id, value) => saved.set(id, value) }, computer: { id: 'local' },
    graph: { workspace: { showTrees: () => calls.push('trees') } },
    retainStartingTreeStore: () => { calls.push('retain'); return () => calls.push('release') },
    refreshTree: () => calls.push('refresh'), treeNodeName: node => node.role || 'Agent',
    rebindRailToSession: () => {},
    adoptStandaloneIntoTree, sessionTurnSucceeded, sessionTurnCancelled, nodeStatusForTurn, TURN_CANCELLED,
    ...maps, startingNodeIds: new Set(), RUN_NODE_REPLACEMENTS: createSingleFlight(),
    recordTurnActions: () => {}, deliverTurnReply: () => {},
    syncTreeBranchAddresses: async () => calls.push('address'),
    persistTranscript(id) { saved.set(maps.sessionNodeIds.get(id), { lines: structuredClone(maps.sessionTranscripts.get(id)) }) },
    transcriptAppend(id, entry) { entry.id ||= `entry-${maps.sessionTranscripts.get(id)?.length || 0}`; const lines = maps.sessionTranscripts.get(id) || []; lines.push(entry); maps.sessionTranscripts.set(id, lines) },
    window: { mcAgent: { async adoptTreeAddress(request) {
      calls.push(['adopt', request])
      if (hostWait) await hostWait
      if (endedDuringAdoption) snapshot = { ...snapshot, sessionId: null, phase: 'closed', currentText: '', transcript: [...history, { who: 'agent', text: 'Last words', at: 13 }] }
      return { ok: true, sessionId: 'kept-session', nodeId: request.requestKeys.threadId, treeKey: request.treeKey, threadId: 'original-provider-thread', account: 'signed-in-seat', phase: 'working' }
    } } },
  }
  const place = new Function(...Object.keys(env), `${method('treeAnchorsFor')}\n${method('nodeRequestKeys')}\n${method('nodeTreeIdentity')}\n${method('placeStandaloneAgent')}\nreturn placeStandaloneAgent`)(...Object.values(env))
  return { treeStore, maps, record, binding, calls, saved, env, place: parentId => place({ record, parentId, computerId: 'local' }) }
}

test('the page binds the same running session, past transcript and current turn to the new real node', async () => {
  const h = fixture(), parent = h.treeStore.addNode({ role: 'manager' }).node
  const result = await h.place(parent.id)
  assert.equal(result.ok, true)
  assert.equal(h.maps.sessionNodeIds.get('kept-session'), result.nodeId)
  assert.equal(h.maps.sessionThreadIds.get('kept-session'), 'original-provider-thread')
  assert.equal(h.maps.sessionAccountNames.get('kept-session'), 'signed-in-seat')
  assert.equal(h.maps.sessionTurnText.get('kept-session'), 'Answer so far')
  assert.equal(h.maps.sessionOpenTurns.get('kept-session'), 'kept-turn')
  assert.deepEqual(h.saved.get(result.nodeId).lines.map(line => line.text), ['Original task', 'Previous reply'])
  assert.equal(h.treeStore.getNode(result.nodeId).status, 'running')
  assert.equal(h.treeStore.getNode(result.nodeId).reply, 'Previous reply')
  assert.equal(h.calls.at(-1), 'release')
})

test('placing a never-started tab does not create a session; its later start gets its real current ancestry', async () => {
  const h = fixture({ active: false }), parent = h.treeStore.addNode({ role: 'manager' }).node
  const result = await h.place(parent.id)
  assert.equal(result.ok, true); assert.equal(h.maps.sessionNodeIds.size, 0)
  assert.equal(h.calls.some(call => call[0] === 'adopt'), false)
  assert.deepEqual(h.binding.getStartOptions().requestKeys, { threadId: result.nodeId, treeAnchors: [parent.id, result.nodeId] })
  assert.equal(h.binding.getStartOptions().surface, 'fleet-tree')
  h.binding.onSessionChange({ sessionId: 'future-session', threadId: 'future-thread', phase: 'starting' }, { kind: 'open' })
  h.binding.onSessionChange({ sessionId: 'future-session', phase: 'working' }, { kind: 'send', text: 'New work', at: 22 })
  assert.equal(h.maps.sessionNodeIds.get('future-session'), result.nodeId)
  assert.equal(h.treeStore.getNode(result.nodeId).status, 'running')
  assert.deepEqual(h.saved.get(result.nodeId).lines, [{ who: 'you', text: 'New work', at: 22, id: 'entry-0' }])
  assert.throws(() => h.binding.getStartOptions(), /current tree conversation/)
})

test('explicit pause/send failure, then Stop retire only their own binding and allow a later correctly addressed start', async () => {
  const h = fixture(), result = await h.place(null)
  h.binding.onSessionChange({ sessionId: 'kept-session', phase: 'open', lastTurnStatus: 'interrupted' }, { kind: 'state' })
  assert.equal(h.treeStore.getNode(result.nodeId).status, 'interrupted')
  h.binding.onSessionChange({ sessionId: null, phase: 'closed' }, { kind: 'closed' })
  assert.equal(h.maps.sessionNodeIds.has('kept-session'), false)
  assert.equal(h.treeStore.getNode(result.nodeId).sessionId, 'kept-session', 'the ended session remains as history')
  assert.equal(h.binding.getStartOptions().requestKeys.threadId, result.nodeId)
})

test('a provider exit during acknowledged adoption keeps history without reviving a dead session', async () => {
  const h = fixture({ endedDuringAdoption: true }), result = await h.place(null)
  assert.equal(result.ok, true); assert.equal(h.maps.sessionNodeIds.size, 0)
  assert.equal(h.treeStore.getNode(result.nodeId).status, 'interrupted')
  assert.deepEqual(h.saved.get(result.nodeId).lines.map(line => line.text), ['Original task', 'Previous reply', 'Last words'])
})

test('a newer recovered session is not overwritten when the old mounted conversation later reports closure', async () => {
  const h = fixture(), result = await h.place(null)
  h.maps.sessionNodeIds.delete('kept-session')
  h.maps.sessionNodeIds.set('recovered-session', result.nodeId)
  h.treeStore.attachSession(result.nodeId, 'recovered-session')
  h.treeStore.setNodeStatus(result.nodeId, 'running')
  h.binding.onSessionChange({ sessionId: null, phase: 'closed' }, { kind: 'closed' })
  assert.equal(h.treeStore.getNode(result.nodeId).sessionId, 'recovered-session')
  assert.equal(h.treeStore.getNode(result.nodeId).status, 'running')
  assert.equal(h.maps.sessionNodeIds.get('recovered-session'), result.nodeId)
})

test('the example source refuses placement before any tree or session mutation', async () => {
  const h = fixture({ mock: true })
  assert.equal((await h.place(null)).ok, false)
  assert.equal(h.treeStore.snapshot().nodes.length, 0)
  assert.deepEqual(h.calls, [])
})


test('paused and failed idle sessions keep their actual outcome when adopted', async () => {
  for (const [outcome, expected] of [['completed', 'finished'], ['success', 'finished'], ['failed', 'turn-failed'], ['interrupted', 'interrupted'], ['cancelled', 'cancelled'], [null, 'turn-failed']]) {
    const h = fixture({ outcome })
    const before = h.record.session.snapshot()
    h.record.session.snapshot = () => ({ ...before, phase: 'open', lastTurnStatus: outcome })
    const result = await h.place(null)
    assert.equal(h.treeStore.getNode(result.nodeId).status, expected)
  }
})

test('placement holds the existing restart/recovery guard until the host responds', async () => {
  let finish
  const h = fixture({ hostWait: new Promise(resolve => { finish = resolve }) })
  const pending = h.place(null)
  const node = h.treeStore.snapshot().nodes[0]
  assert.equal(h.env.startingNodeIds.has(node.id), true)
  assert.equal(h.env.RUN_NODE_REPLACEMENTS.busy(node.id), true)
  let replacementStarted = false
  assert.deepEqual(await h.env.RUN_NODE_REPLACEMENTS.run(node.id, () => { replacementStarted = true }), { ran: false })
  assert.equal(replacementStarted, false)
  finish()
  assert.equal((await pending).ok, true)
  assert.equal(h.env.startingNodeIds.has(node.id), false)
  assert.equal(h.env.RUN_NODE_REPLACEMENTS.busy(node.id), false)
})
