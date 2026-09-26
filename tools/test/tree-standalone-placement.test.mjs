import assert from 'node:assert/strict'
import test from 'node:test'
import { placeStandaloneAgent } from '../../src/tree-standalone-placement.js'

function fixture() {
  const calls = [], session = { id: 'same-session' }, panel = { id: 'same-panel' }
  const record = { id: 'standalone:one', agent: { name: 'Agent 1' }, standalone: true, chatOpen: true, session, chatPanel: panel }
  const graph = { computer: { id: 'computer-one', agents: [{ id: 'parent' }] },
    workspace: { standalone: new Map([[record.id, record]]) },
    onPlaceStandalone: async request => { calls.push(request); return { ok: true, nodeId: 'placed-node', sentence: 'Added under Parent.' } } }
  return { graph, record, calls, session, panel }
}

test('placement delegates once with computer and parent while keeping the mounted record and session', async () => {
  const { graph, record, calls, session, panel } = fixture()
  const result = await placeStandaloneAgent(graph, record, 'parent')
  assert.deepEqual(result, { ok: true, nodeId: 'placed-node', sentence: 'Added under Parent.' })
  assert.deepEqual(calls, [{ record, parentId: 'parent', computerId: 'computer-one' }])
  assert.equal(record.treeNodeId, 'placed-node')
  assert.equal(record.session, session); assert.equal(record.chatPanel, panel)
  assert.equal(graph.workspace.standalone.get(record.id), record)
  assert.equal(record.chatOpen, true); assert.equal(record.placementPending, false)
  assert.deepEqual(graph.computer.agents, [{ id: 'parent' }], 'the adapter cannot write the fleet itself')
})

test('a new-tree destination uses null; a placed record cannot be adopted twice', async () => {
  const { graph, record, calls } = fixture()
  assert.equal((await placeStandaloneAgent(graph, record)).ok, true)
  assert.equal(calls[0].parentId, null)
  const again = await placeStandaloneAgent(graph, record)
  assert.equal(again.ok, false); assert.match(again.sentence, /already on a tree/)
  assert.equal(calls.length, 1)
})

test('a pending request blocks duplicate placement until the first result settles', async () => {
  const { graph, record, calls } = fixture()
  let finish
  graph.onPlaceStandalone = request => { calls.push(request); return new Promise(resolve => { finish = resolve }) }
  const first = placeStandaloneAgent(graph, record)
  assert.equal(record.placementPending, true)
  assert.equal((await placeStandaloneAgent(graph, record, 'parent')).ok, false)
  assert.equal(calls.length, 1)
  finish({ ok: true, nodeId: 'once' })
  assert.equal((await first).ok, true)
  assert.equal(record.treeNodeId, 'once'); assert.equal(record.placementPending, false)
})

test('refusals and rejected promises preserve the chat and allow a retry', async () => {
  const { graph, record, panel } = fixture()
  graph.onPlaceStandalone = async () => ({ ok: false, sentence: 'Parent is unavailable.' })
  assert.equal((await placeStandaloneAgent(graph, record)).sentence, 'Parent is unavailable.')
  graph.onPlaceStandalone = async () => { throw new Error('Connection failed.') }
  assert.equal((await placeStandaloneAgent(graph, record)).sentence, 'Connection failed.')
  assert.equal(record.placementPending, false); assert.equal(record.treeNodeId, undefined)
  assert.equal(record.chatPanel, panel); assert.equal(record.chatOpen, true)
  graph.onPlaceStandalone = async () => ({ ok: true, nodeId: 'retry' })
  assert.equal((await placeStandaloneAgent(graph, record)).ok, true)
})

for (const state of ['missing-parent', 'group-parent', 'editing', 'linking', 'destroyed', 'removed', 'closed', 'not-standalone', 'missing-callback']) {
  test(`${state} refuses before invoking the adoption callback`, async () => {
    const { graph, record, calls } = fixture()
    let parent = null
    if (state === 'missing-parent') parent = 'missing'
    if (state === 'group-parent') { parent = 'group'; graph.computer.agents.push({ id: parent, treeScope: { group: true } }) }
    if (state === 'editing') graph.editMode = true
    if (state === 'linking') graph._linkMode = true
    if (state === 'destroyed') graph._destroyed = true
    if (state === 'removed') graph.workspace.standalone.delete(record.id)
    if (state === 'closed') record.chatOpen = false
    if (state === 'not-standalone') record.standalone = false
    if (state === 'missing-callback') graph.onPlaceStandalone = null
    assert.equal((await placeStandaloneAgent(graph, record, parent)).ok, false)
    assert.equal(calls.length, 0); assert.equal(record.treeNodeId, undefined)
  })
}

test('late success cannot attach a destroyed or replaced tab record', async () => {
  for (const destroyed of [true, false]) {
    const { graph, record } = fixture()
    let finish
    graph.onPlaceStandalone = () => new Promise(resolve => { finish = resolve })
    const operation = placeStandaloneAgent(graph, record)
    if (destroyed) graph._destroyed = true
    else graph.workspace.standalone.set(record.id, { ...record })
    finish({ ok: true, nodeId: 'late' })
    assert.equal((await operation).ok, false)
    assert.equal(record.treeNodeId, undefined); assert.equal(record.placementPending, false)
  }
})

test('success without an authoritative node id is not reported as placement', async () => {
  const { graph, record } = fixture()
  graph.onPlaceStandalone = async () => ({ ok: true })
  const result = await placeStandaloneAgent(graph, record)
  assert.equal(result.ok, false); assert.match(result.sentence, /could not be confirmed/)
  assert.equal(record.treeNodeId, undefined)
})
