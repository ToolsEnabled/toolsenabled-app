import assert from 'node:assert/strict'
import test from 'node:test'
import { activeResearchProjectIds, createResearchProjectActivity, readResearchProjectActivity } from '../../src/research-project-activity.js'
import { createFleetTreeStore, fleetTreesStorageKey, safeTreeStorage } from '../../src/fleet-trees.js'
import { THIS_COMPUTER_ID } from '../../src/declared-fleet.js'

const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36)
const snapshot = {
  computerId: THIS_COMPUTER_ID,
  trees: [{ id: 'tree-a', name: 'Same name', researchProjectId: A }, { id: 'tree-b', name: 'Same name', researchProjectId: B }],
  nodes: [{ id: 'node-a', treeId: 'tree-a', sessionId: 'session-a', status: 'finished' },
    { id: 'node-b', treeId: 'tree-b', sessionId: 'session-b', status: 'running' }],
}

test('active project identity comes from an exact busy live session, never names or saved status', () => {
  const check = sessions => [...activeResearchProjectIds({ snapshot, sessions })]
  assert.deepEqual(check([{ sessionId: 'session-a', nodeId: 'node-a', busy: true }]), [A])
  for (const row of [
    { sessionId: 'old-session', busy: true },
    { sessionId: 'session-b', busy: false },
    { sessionId: 'session-a', busy: true, closing: true },
    { sessionId: 'session-a', nodeId: 'node-b', busy: true },
    { sessionId: 'session-a', computerId: 'another-computer', busy: true },
  ]) assert.deepEqual(check([row]), [])
  assert.deepEqual(check([]), [])
})

test('only confirmed exact observed assignments contribute, and one live session may serve two projects', () => {
  const sessions = [{ sessionId: 'session-a', busy: true }]
  const assignments = [
    { kind: 'observed', ref: 'session-a', projectId: B, active: true },
    { kind: 'observed', ref: 'session-b', projectId: 'not-live' },
    { kind: 'all', ref: '*', projectId: 'all-rule' },
    { kind: 'observed', ref: 'session-a', projectId: 'pending', pending: true },
    { kind: 'observed', ref: 'session-a', projectId: 'removed', active: false },
  ]
  assert.deepEqual([...activeResearchProjectIds({ snapshot, sessions, assignments })].sort(), [A, B].sort())
})

test('local stored links are read without a second store writer and require a current host activity receipt', async () => {
  const values = new Map(), requests = []
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  let counter = 0
  const tree = createFleetTreeStore({ computerId: THIS_COMPUTER_ID, storage: safeTreeStorage(storage), idFactory: kind => kind + '-' + ++counter })
  const made = tree.addNode({ role: 'builder', message: 'Synthetic research fixture' })
  assert.equal(made.ok, true)
  assert.equal(tree.setTreeResearchProject(made.node.treeId, A, 'Same name').ok, true)
  assert.equal(tree.attachSession(made.node.id, 'session-a').ok, true)
  let answer = { ok: true, busy: true, closing: false }
  const scope = { localStorage: storage, mcAgent: { async sessionActivity(request) { requests.push(request); return answer } } }
  assert.deepEqual([...await readResearchProjectActivity({ source: 'local' }, scope)], [A])
  assert.deepEqual(requests, [{ sessionId: 'session-a' }])
  answer = { ok: true, busy: false, closing: false }
  assert.deepEqual([...await readResearchProjectActivity({ source: 'local' }, scope)], [])
  answer = { ok: false, code: 'AGENT_SESSION_NOT_OWNED' }
  assert.deepEqual([...await readResearchProjectActivity({ source: 'local' }, scope)], [])
  const key = fleetTreesStorageKey(THIS_COMPUTER_ID), stored = JSON.parse(values.get(key))
  stored.computerId = 'another-computer'; values.set(key, JSON.stringify(stored))
  requests.length = 0
  assert.deepEqual([...await readResearchProjectActivity({ source: 'local' }, scope)], [])
  assert.equal(requests.length, 0, 'a saved record from another computer is not probed')
})

test('paired activity joins current-host assignments and checks the same destination before and after a read', async () => {
  let destination = 'account/computer-a', reads = 0, changeDuringRead = false
  const scope = {
    mcShell: { async captureResearchAssignmentDestination() { return { ok: true, key: destination } } },
    mcDesktopTree: { async read() {
      reads++
      if (changeDuringRead) destination = 'account/computer-b'
      return { ok: true, desktopTree: { version: 1, computerId: 'computer-a',
        trees: [{ id: 'tree-a' }], nodes: [{ id: 'node-a', treeId: 'tree-a', sessionId: 'session-a', status: 'running' }] },
        sessions: [{ sessionId: 'session-a', nodeId: 'node-a', busy: true }] }
    } },
  }
  const context = { source: 'relay', destination, assignments: [{ kind: 'observed', ref: 'session-a', projectId: A, active: true }] }
  assert.deepEqual([...await readResearchProjectActivity(context, scope)], [A], 'older native trees need no new metadata fields')
  changeDuringRead = true
  assert.deepEqual([...await readResearchProjectActivity(context, scope)], [])
  const before = reads
  assert.deepEqual([...await readResearchProjectActivity(context, scope)], [])
  assert.equal(reads, before, 'another destination is refused before reading activity')
  assert.deepEqual([...await readResearchProjectActivity({ source: 'mock' }, scope)], [])
  assert.equal(reads, before, 'example mode never reads the real tree')
})

const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve() }
function fixture(read) {
  let now = 0, nextId = 0
  const timers = new Map(), changes = [], subscriptions = new Set()
  const scope = new EventTarget(), document = new EventTarget()
  scope.navigator = { onLine: true }; document.visibilityState = 'visible'
  scope.mcAgent = { onEvent(listener) { subscriptions.add(listener); return () => subscriptions.delete(listener) } }
  const controller = createResearchProjectActivity({ scope, document, read, onChange: ids => changes.push([...ids].sort()),
    intervalMs: 10, staleMs: 25, now: () => now,
    schedule: (fn, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, fn }); return id },
    cancel: id => timers.delete(id),
  })
  async function advance(ms = 0) {
    const end = now + ms
    for (let turns = 0; turns < 100; turns++) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush()
      assert.notEqual(turns, 99, 'fixture timers settle')
    }
    now = end; await flush()
  }
  return { controller, scope, document, subscriptions, changes, timers, advance,
    latest: () => changes.at(-1) || [], event: packet => { for (const listener of subscriptions) listener(packet) } }
}

test('live completion refreshes to idle, read failure clears activity, and destroy unsubscribes', async () => {
  let result = new Set([A]), failed = false, reads = 0
  const f = fixture(async () => { reads++; if (failed) throw Error('offline'); return result })
  f.controller.setContext({ source: 'local', epoch: 1 })
  await f.advance(); assert.deepEqual(f.latest(), [A]); assert.equal(f.subscriptions.size, 1)
  result = new Set()
  f.event({ sessionId: 'session-a', event: { type: 'turn_completed' } })
  assert.deepEqual(f.latest(), [], 'a completed turn does not retain an active label while its read is pending')
  await f.advance(); assert.deepEqual(f.latest(), [])
  result = new Set([A]); await f.advance(10); assert.deepEqual(f.latest(), [A])
  failed = true; await f.advance(10); assert.deepEqual(f.latest(), [])
  const before = reads
  f.controller.destroy(); await f.advance(100)
  assert.equal(f.subscriptions.size, 0); assert.equal(f.timers.size, 0); assert.equal(reads, before)
})

test('a slow old account or computer read cannot mark the replacement context active', async () => {
  let release
  const f = fixture(context => context.epoch === 1 ? new Promise(resolve => { release = resolve }) : Promise.resolve(new Set([B])))
  f.controller.setContext({ source: 'relay', destination: 'first', epoch: 1 })
  await f.advance()
  f.controller.setContext({ source: 'relay', destination: 'second', epoch: 2 })
  await f.advance(); assert.deepEqual(f.latest(), [B])
  release(new Set([A])); await flush(); assert.deepEqual(f.latest(), [B])
  f.controller.setContext({ source: 'mock', epoch: 3 })
  assert.deepEqual(f.latest(), []); assert.equal(f.subscriptions.size, 0)
  await f.advance(100); assert.deepEqual(f.latest(), [])
  f.controller.destroy()
})

test('stale activity expires during a hanging refresh; hidden and offline views clear immediately', async () => {
  let hangs = false
  const f = fixture(() => hangs ? new Promise(() => {}) : Promise.resolve(new Set([A])))
  f.controller.setContext({ source: 'local', epoch: 1 })
  await f.advance(); assert.deepEqual(f.latest(), [A])
  hangs = true; await f.advance(25); assert.deepEqual(f.latest(), [])
  hangs = false
  f.controller.setContext({ source: 'local', epoch: 2 })
  await f.advance(); assert.deepEqual(f.latest(), [A])
  f.scope.navigator.onLine = false; f.scope.dispatchEvent(new Event('offline'))
  assert.deepEqual(f.latest(), [])
  f.scope.navigator.onLine = true; f.scope.dispatchEvent(new Event('online'))
  await f.advance(); assert.deepEqual(f.latest(), [A])
  f.document.visibilityState = 'hidden'; f.document.dispatchEvent(new Event('visibilitychange'))
  assert.deepEqual(f.latest(), []); assert.equal(f.timers.size, 0)
  f.document.visibilityState = 'visible'; f.document.dispatchEvent(new Event('visibilitychange'))
  await f.advance(); assert.deepEqual(f.latest(), [A])
  f.controller.destroy()
})
