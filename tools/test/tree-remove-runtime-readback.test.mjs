import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createFleetTreeStore, NODE_REMOVE_REFUSALS, NODE_STATUSES, FLEET_TREE_LIMITS } from '../../src/fleet-trees.js'
import { nodeIsBusy } from '../../src/tree-session-liveness.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const makeView = new Function('NODE_REMOVE_REFUSALS', 'NODE_STATUSES', 'FLEET_TREE_LIMITS', 'nodeIsBusy',
  'RUN_TREE_RUNTIME_STORES', 'RUN_SESSION_CLEANUPS', 'TREE_RUNTIME_NOT_SAVED_TEXT',
  `${declaredFunctionSource(source, 'createTreeRuntimeView')}; return createTreeRuntimeView`
)(NODE_REMOVE_REFUSALS, NODE_STATUSES, FLEET_TREE_LIMITS, nodeIsBusy, new Map(), new Map(), 'Runtime changes remain unsaved.')

function fixture() {
  const cells = new Map()
  let unavailable = false, writable = true, counter = 0, tick = 0
  const storage = {
    read(key) { if (unavailable) throw Error('Synthetic transient read failure'); return cells.has(key) ? structuredClone(cells.get(key)) : null },
    write(key, value) { if (!writable) return false; cells.set(key, structuredClone(value)); return true },
  }
  const store = createFleetTreeStore({ computerId: 'remove-readback-fixture', storage,
    makeId: kind => `${kind}-${++counter}`, now: () => new Date(1_700_000_000_000 + ++tick * 1000).toISOString() })
  const node = store.addNode({ name: 'Finished work' }).node
  const sibling = store.addNode({ name: 'Preserved work' }).node
  store.attachSession(node.id, 'exact-session')
  store.setNodeStatus(node.id, 'running')
  const owned = new Map([['exact-session', node.id]])
  const cleanups = new Map()
  const view = makeView(store, owned, cleanups)
  return { store, view, node, sibling, owned, cleanups, cells,
    setUnavailable(value) { unavailable = value },
    setWritable(value) { writable = value },
  }
}

test('Remove respects an observed completed session after the same saved tree becomes readable again', () => {
  const f = fixture()
  const siblingBefore = f.store.getNode(f.sibling.id)
  f.setUnavailable(true)
  const completed = f.view.setNodeStatus(f.node.id, 'finished', { note: 'Completed.', turnId: 'turn-1' })
  assert.equal(completed.runtimeUpdated, true)
  assert.equal(f.view.getNode(f.node.id).status, 'finished')
  assert.equal(f.store.getNode(f.node.id).status, 'running', 'failed freshness read prevented the original store mutation')
  f.setUnavailable(false)
  const removed = f.view.removeNode(f.node.id)
  assert.equal(removed.ok, true, removed.problems?.join(' '))
  assert.equal(f.view.getNode(f.node.id), null)
  assert.equal(f.view.snapshot().persistenceFailed, false)
  assert.deepEqual(f.store.getNode(f.sibling.id), siblingBefore)
})

test('ordinary persisted completion retains the existing Remove behavior without a readback repair', () => {
  const f = fixture()
  assert.equal(f.view.setNodeStatus(f.node.id, 'finished', { turnId: 'turn-1' }).ok, true)
  assert.equal(f.store.getNode(f.node.id).status, 'finished')
  assert.equal(f.view.removeNode(f.node.id).ok, true)
  assert.equal(f.view.getNode(f.node.id), null)
})

test('Remove keeps the exact observed run when persistence still cannot be read', () => {
  const f = fixture()
  f.setUnavailable(true)
  f.view.setNodeStatus(f.node.id, 'finished', { turnId: 'turn-1' })
  const removed = f.view.removeNode(f.node.id)
  assert.equal(removed.ok, false)
  assert.ok(f.view.getNode(f.node.id))
  assert.equal(f.view.getNode(f.node.id).status, 'finished')
})

test('Remove refuses a newer durable tree instead of silently adopting its revision', () => {
  const f = fixture()
  f.setUnavailable(true)
  f.view.setNodeStatus(f.node.id, 'finished', { turnId: 'turn-1' })
  f.setUnavailable(false)
  const [key, record] = [...f.cells][0]
  const newer = structuredClone(record)
  newer.nodes.find(node => node.id === f.sibling.id).name = 'Newer sibling name'
  f.cells.set(key, newer)
  const removed = f.view.removeNode(f.node.id)
  assert.equal(removed.ok, false)
  assert.match(removed.problems.join(' '), /changed after this page read/)
  assert.deepEqual(f.cells.get(key), newer, 'no write overwrites a newer saved tree')
  assert.ok(f.view.getNode(f.node.id))
})

test('a failed synchronization write remains a removal refusal and can be retried after storage recovers', () => {
  const f = fixture()
  f.setUnavailable(true)
  f.view.setNodeStatus(f.node.id, 'finished', { turnId: 'turn-1' })
  f.setUnavailable(false)
  f.setWritable(false)
  const before = structuredClone([...f.cells])
  const refused = f.view.removeNode(f.node.id)
  assert.equal(refused.ok, false, 'an in-memory update with persistenceFailed is not a removal acknowledgement')
  assert.ok(f.view.getNode(f.node.id))
  assert.deepEqual([...f.cells], before)
  f.setWritable(true)
  assert.equal(f.view.removeNode(f.node.id).ok, true)
  assert.equal(f.view.getNode(f.node.id), null)
})

for (const guard of ['busy', 'cleanup']) test(`Remove preserves an observed ${guard} session after readback recovers`, () => {
  const f = fixture()
  f.setUnavailable(true)
  f.view.setNodeStatus(f.node.id, guard === 'busy' ? 'running' : 'finished', { turnId: 'turn-1' })
  if (guard === 'cleanup') f.cleanups.set('exact-session', f.node.id)
  f.setUnavailable(false)
  const before = structuredClone([...f.cells])
  assert.equal(f.view.removeNode(f.node.id).ok, false)
  assert.ok(f.view.getNode(f.node.id))
  assert.deepEqual([...f.cells], before)
})

for (const flight of ['starting', 'replacement']) test(`the actual Remove entrypoint preserves a ${flight} flight before any synchronization`, async () => {
  const f = fixture()
  f.setUnavailable(true)
  f.view.setNodeStatus(f.node.id, 'finished', { turnId: 'turn-1' })
  f.setUnavailable(false)
  const reports = []
  const scope = { treeStore:f.view, nodeCleanupPending:() => false, nodeBusy:node => nodeIsBusy(node,f.owned),
    startDraftFlight:{busy:() => flight === 'starting'}, nodeReplacementFlight:{busy:() => flight === 'replacement'},
    setOrgStatus:(...args) => reports.push(args), NODE_REMOVE_REFUSALS }
  const remove = new Function(...Object.keys(scope),`${declaredFunctionSource(source,'performNodeRemoval')}; return performNodeRemoval`)(...Object.values(scope))
  const before = structuredClone([...f.cells])
  assert.equal(await remove(f.view.getNode(f.node.id)),false)
  assert.match(reports[0][0], /Stop this agent first/)
  assert.deepEqual([...f.cells],before)
  assert.ok(f.view.getNode(f.node.id))
})
