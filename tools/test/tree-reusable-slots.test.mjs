import test from 'node:test'
import assert from 'node:assert/strict'
import { createFleetTreeStore, fleetTreesStorageKey, treeRecord, planNodeAdd, treeSlotUsage } from '../../src/fleet-trees.js'

function fixture({ bounds = { maxChildren: 4, maxDepth: 3 }, saved = null } = {}) {
  let serial = 0
  const cells = new Map()
  if (saved) cells.set(fleetTreesStorageKey('fixture'), structuredClone(saved))
  const storage = { read: key => structuredClone(cells.get(key) ?? null),
    write: (key, value) => { cells.set(key, structuredClone(value)); return true } }
  const state = { bounds, reads: 0 }
  const store = createFleetTreeStore({ computerId: 'fixture', storage,
    readBounds: () => { state.reads++; return state.read ? state.read() : state.bounds }, makeId: kind => kind + '-' + (++serial) })
  return { store, state, cells, storage }
}
const add = (store, parentId = null) => {
  const answer = store.addNode({ parentId, role: parentId ? 'worker' : 'controller', message: 'Fixture work' })
  assert.equal(answer.ok, true, answer.problems?.join(' '))
  return answer.node
}
for (const status of ['draft', 'finished', 'failed', 'cancelled', 'running']) {
  test('four total direct slots include ' + status + ' children', () => {
    const { store } = fixture()
    const parent = add(store)
    for (let i = 0; i < 4; i++) {
      const child = add(store, parent.id)
      if (status === 'running') assert.equal(store.attachSession(child.id, 'session-' + i).ok, true)
      if (status !== 'draft') assert.equal(store.setNodeStatus(child.id, status).ok, true)
    }
    const before = store.snapshot()
    const fifth = store.addNode({ parentId: parent.id, role: 'worker', message: 'Extra work' })
    assert.equal(fifth.ok, false, 'a nonrunning record still owns its reusable slot')
    assert.deepEqual(store.snapshot().nodes, before.nodes)
    assert.equal(store.extensionPoints().some(point => point.parentId === parent.id), false)
    assert.equal(planNodeAdd(treeRecord(store.snapshot(), parent.treeId), parent.id).allowed, false)
  })
}
test('each actual parent has its own width and the saved setting changes the next admission', () => {
  const { store, state } = fixture({ bounds: { maxChildren: 2, maxDepth: 4 } })
  const root = add(store), left = add(store, root.id), right = add(store, root.id)
  assert.equal(store.addNode({ parentId: root.id }).ok, false)
  add(store, left.id); add(store, left.id); add(store, right.id); add(store, right.id)
  assert.equal(store.addNode({ parentId: left.id }).ok, false)
  state.bounds = { maxChildren: 3, maxDepth: 4 }
  add(store, left.id)
  assert.equal(store.addNode({ parentId: left.id }).ok, false)
  assert.equal(store.childrenOf(right.id).length, 2)
})
test('configured depth controls new descendants including drafts', () => {
  const { store, state } = fixture({ bounds: { maxChildren: 4, maxDepth: 1 } })
  const root = add(store), child = add(store, root.id)
  assert.equal(store.addNode({ parentId: child.id }).ok, false)
  state.bounds = { maxChildren: 4, maxDepth: 4 }
  const grandchild = add(store, child.id), fourth = add(store, grandchild.id), fifth = add(store, fourth.id)
  assert.equal(store.addNode({ parentId: fifth.id }).ok, false)
})
test('root-only depth preserves roots while refusing direct children', () => {
  const { store } = fixture({ bounds: { maxChildren: 4, maxDepth: 0 } })
  const root = add(store)
  assert.equal(store.addNode({ parentId: root.id }).ok, false)
})
test('lowering limits preserves slots, conversations and restart in the same identity', () => {
  const { store, state } = fixture({ bounds: { maxChildren: 4, maxDepth: 3 } })
  const root = add(store), children = Array.from({ length: 4 }, () => add(store, root.id))
  const target = children[0]
  assert.equal(store.attachSession(target.id, 'old-thread-session').ok, true)
  assert.equal(store.setNodeReply(target.id, 'Keep this reply').ok, true)
  assert.equal(store.getNode(target.id).reply, 'Keep this reply')
  assert.equal(store.setNodeStatus(target.id, 'finished').ok, true)
  state.bounds = { maxChildren: 2, maxDepth: 0 }
  const before = store.snapshot()
  assert.equal(store.addNode({ parentId: root.id }).ok, false)
  assert.equal(store.attachSession(target.id, 'replacement-session').ok, true)
  assert.equal(store.setNodeStatus(target.id, 'starting').ok, true, 'restart reuses a slot even above lowered bounds')
  assert.equal(store.setNodeStatus(target.id, 'running').ok, true)
  assert.deepEqual(store.snapshot().nodes.map(node => node.id), before.nodes.map(node => node.id))
  assert.equal(store.getNode(target.id).message, target.message)
  assert.equal(store.getNode(target.id).reply, before.nodes.find(node => node.id === target.id).reply)
})
test('moving a branch cannot allocate a fifth total child or exceed configured depth', () => {
  const { store } = fixture({ bounds: { maxChildren: 2, maxDepth: 2 } })
  const root = add(store), left = add(store, root.id), right = add(store, root.id)
  const a = add(store, left.id), b = add(store, left.id), spare = add(store, right.id)
  assert.equal(store.moveNode(spare.id, left.id).ok, false)
  assert.equal(store.moveNode(right.id, a.id).ok, false)
  assert.equal(store.getNode(spare.id).parentId, right.id)
  assert.equal(store.childrenOf(left.id).length, 2)
  assert.equal(store.getNode(b.id).parentId, left.id)
})
test('unreadable or invalid bounds refuse growth while retaining existing lifecycle', () => {
  const { store, state } = fixture()
  const root = add(store), child = add(store, root.id)
  for (const bounds of [null, { maxChildren: 1.5, maxDepth: 3 }, { maxChildren: 0, maxDepth: 3 }, { maxChildren: 4, maxDepth: -1 }]) {
    state.bounds = bounds
    assert.equal(store.addNode({ parentId: root.id }).ok, false, 'invalid bounds cannot fall back to extra capacity')
    assert.equal(store.attachSession(child.id, 'same-slot-session').ok, true)
  }
  assert.equal(store.snapshot().nodes.length, 2)
})
test('only explicit successful removal frees a child slot', () => {
  const { store } = fixture({ bounds: { maxChildren: 1, maxDepth: 3 } })
  const root = add(store), child = add(store, root.id)
  store.attachSession(child.id, 'child-session'); store.setNodeStatus(child.id, 'running')
  assert.equal(store.removeNode(child.id).ok, false, 'existing live-removal refusal remains')
  store.setNodeStatus(child.id, 'finished'); store.detachSession(child.id)
  assert.equal(store.addNode({ parentId: root.id }).ok, false)
  assert.equal(store.removeNode(child.id).ok, true) // Only synthetic in-memory fixture state.
  const next = add(store, root.id)
  assert.notEqual(next.id, child.id)
  assert.equal(store.childrenOf(root.id).length, 1)
})

test('slot summary counts retained direct children separately from descendants and lowered capacity', () => {
  const { store, state } = fixture()
  const root = add(store), child = add(store, root.id)
  add(store, child.id)
  store.setNodeStatus(child.id, 'cancelled')
  assert.deepEqual(treeSlotUsage(store.snapshot(), root.id), {
    total: 1, limit: 4, maxDepth: 3, canAdd: true, reason: '', childIds: [child.id],
  })
  state.bounds = { maxChildren: 1, maxDepth: 3 }
  const full = treeSlotUsage(store.snapshot(), root.id)
  assert.equal(full.total, 1)
  assert.equal(full.limit, 1)
  assert.equal(full.canAdd, false)
  assert.match(full.reason, /slot|child|four|1/i)
})

test('account choice and pending role survive saved readback without changing slot identity or history', () => {
  const { store, storage } = fixture()
  const root = add(store), child = add(store, root.id)
  store.attachSession(child.id, 'existing-session')
  store.setNodeReply(child.id, 'Keep the earlier reply.')
  assert.equal(store.setNodeLaunchPreferences(child.id, {
    tier: 'claude-sonnet', effort: 'high', accountChoice: { provider: 'claude', name: 'backup' },
  }).ok, true)
  assert.equal(store.setNodeRole(child.id, 'builder', { pendingSessionId: 'existing-session', appliedRole: 'worker' }).ok, true)
  const reopened = createFleetTreeStore({ computerId: 'fixture', storage })
  const node = reopened.getNode(child.id)
  assert.deepEqual(node.accountChoice, { provider: 'claude', name: 'backup' })
  assert.deepEqual(node.roleBindingPending, { sessionId: 'existing-session', role: 'worker' })
  assert.equal(node.role, 'builder')
  assert.equal(node.effort, 'high')
  assert.equal(node.parentId, root.id)
  assert.equal(node.reply, 'Keep the earlier reply.')
  assert.deepEqual(reopened.snapshot().nodes.map(row => row.id), store.snapshot().nodes.map(row => row.id))
})

for (const operation of ['launch preferences', 'role']) {
  test('refused durable ' + operation + ' write leaves both saved and visible configuration intact', () => {
    const { store, storage, cells } = fixture()
    const node = add(store)
    const before = structuredClone(store.getNode(node.id))
    const durable = structuredClone(cells.get(fleetTreesStorageKey('fixture')))
    storage.write = () => false
    const result = operation === 'role' ? store.setNodeRole(node.id, 'builder')
      : store.setNodeLaunchPreferences(node.id, { tier: 'claude-sonnet', accountChoice: { provider: 'claude', name: 'backup' } })
    assert.equal(result.ok, false)
    assert.deepEqual(store.getNode(node.id), before)
    assert.deepEqual(cells.get(fleetTreesStorageKey('fixture')), durable)
  })
}

test('invalid or provider-mismatched saved account choice refuses rather than silently selecting a default', async () => {
  const { slotAccountStartOptions } = await import('../../src/slot-account-choice.js')
  const { store, cells } = fixture()
  const node = add(store)
  assert.equal(store.setNodeLaunchPreferences(node.id, { accountChoice: { provider: 'claude', name: '' } }).ok, false)
  const saved = structuredClone(cells.get(fleetTreesStorageKey('fixture')))
  saved.nodes[0].accountChoice = { provider: 'claude', name: '' }
  const broken = fixture({ saved }).store.getNode(node.id)
  assert.equal(slotAccountStartOptions(broken, 'claude').ok, false)
  assert.equal(slotAccountStartOptions({ accountChoice: { provider: 'claude', name: 'backup' } }, 'codex').ok, false)
  assert.deepEqual(slotAccountStartOptions({ accountChoice: { provider: 'claude', name: 'backup' } }, 'claude'),
    { ok: true, options: { treeAccount: 'backup' } })
})


test('extension offers read one coherent width/depth snapshot for the whole forest', () => {
  const { store, state } = fixture()
  const root = add(store), child = add(store, root.id)
  const other = add(store)
  state.reads = 0
  state.read = () => state.reads === 1 ? { maxChildren: 2, maxDepth: 1 } : { maxChildren: 64, maxDepth: 16 }
  const offered = store.extensionPoints().filter(point => point.kind === 'child').map(point => point.parentId)
  assert.deepEqual(offered, [root.id, other.id], 'one operation must not mix first-read width with later depth')
  assert.equal(state.reads, 1, 'one forest offer calculation must make only one settings read')
  assert.equal(store.getNode(child.id).parentId, root.id)
})

test('extension snapshots refresh after settings and structure changes without granting admission from old offers', () => {
  const { store, state } = fixture({ bounds: { maxChildren: 2, maxDepth: 2 } })
  const root = add(store), child = add(store, root.id), other = add(store)
  const offers = () => store.extensionPoints().filter(point => point.kind === 'child').map(point => point.parentId)
  assert.ok(offers().includes(root.id))
  state.bounds = { maxChildren: 1, maxDepth: 1 }
  assert.equal(store.addNode({ parentId: root.id }).ok, false, 'admission must read settings changed since last render')
  state.reads = 0
  assert.deepEqual(offers(), [other.id])
  assert.equal(state.reads, 1)
  assert.equal(store.moveNode(child.id, other.id).ok, true)
  assert.deepEqual(offers(), [root.id])
  assert.equal(store.removeNode(child.id).ok, true) // Synthetic memory only.
  assert.deepEqual(offers(), [root.id, other.id])
  state.bounds = null
  assert.deepEqual(offers(), [], 'unreadable settings must remove old child allowances')
  assert.equal(store.addNode({ parentId: other.id }).ok, false)
  state.bounds = { maxChildren: 1, maxDepth: 0 }
  assert.deepEqual(offers(), [])
  state.bounds = { maxChildren: 1, maxDepth: 1 }
  assert.deepEqual(offers(), [root.id, other.id])
})

/* T837. The Computers view takes a snapshot to look up one agent's name, once per
   agent, on every render and every streamed event; each snapshot used to make a
   SYNCHRONOUS settings read into the main process. On the 2026-09-21 LIVE
   generation that was 232 to 357 reads per five seconds. The width and depth are
   asked for where they decide something, and are as fresh as they always were. */
test('T837: taking a snapshot or naming a tree reads no slot settings; asking a snapshot for its bounds reads once and sees the current setting', () => {
  const { store, state } = fixture({ bounds: { maxChildren: 64, maxDepth: 16 } })
  const root = add(store)
  for (let index = 0; index < 40; index += 1) add(store, root.id)
  state.reads = 0
  for (let index = 0; index < 50; index += 1) {
    assert.equal(store.snapshot().nodes.length, 41)
    assert.equal(typeof store.treeLabel(root.treeId), 'string')
    assert.equal(treeRecord(store.snapshot(), root.treeId).nodes.length, 41)
  }
  assert.equal(state.reads, 0, 'a snapshot taken to look up a node must not cost a synchronous settings read')
  const snapshot = store.snapshot()
  assert.deepEqual(snapshot.slotBounds, { maxChildren: 64, maxDepth: 16 })
  assert.deepEqual(snapshot.slotBounds, { maxChildren: 64, maxDepth: 16 })
  assert.equal(state.reads, 1, 'one snapshot is one bounds pair, however often it is asked')
  state.bounds = { maxChildren: 2, maxDepth: 1 }
  assert.deepEqual(store.snapshot().slotBounds, { maxChildren: 2, maxDepth: 1 }, 'a later snapshot must see the changed setting')
  assert.equal(state.reads, 2)
  state.bounds = null
  assert.equal(store.snapshot().slotBounds, null, 'unreadable settings stay unreadable, never a remembered allowance')
})

test('T837: adding, moving and offering moves each read the saved slot settings once, however large the forest', () => {
  const { store, state } = fixture({ bounds: { maxChildren: 64, maxDepth: 16 } })
  const root = add(store), other = add(store)
  const children = Array.from({ length: 40 }, () => add(store, root.id))
  const counted = operation => { state.reads = 0; const answer = operation(); return { answer, reads: state.reads } }
  const added = counted(() => store.addNode({ parentId: root.id, role: 'worker', message: 'One more' }))
  assert.equal(added.answer.ok, true, added.answer.problems?.join(' '))
  assert.equal(added.reads, 1, 'an admission reads the settings once')
  const menu = counted(() => store.movePoints(children[0].id))
  assert.ok(menu.answer.length > 1, 'the fixture must offer several parents or the count below measures nothing')
  assert.equal(menu.reads, 1, 'the move menu reads once for all of its candidate parents, not once per candidate')
  const moved = counted(() => store.moveNode(children[0].id, other.id))
  assert.equal(moved.answer.ok, true, moved.answer.problems?.join(' '))
  assert.equal(moved.reads, 1, 'a move reads the settings once')
})

/* T837. Reading the bounds less often must never let a stale pair allow a slot:
   the width and depth are read again at every admission, move, move menu and offer
   calculation, so a limit lowered in Settings after a snapshot was read is the
   limit the very next one is judged by. */
test('T837: a saved limit changed after a snapshot was read is the limit the next add, move, move menu and offers use', () => {
  const { store, state } = fixture({ bounds: { maxChildren: 4, maxDepth: 3 } })
  const root = add(store), first = add(store, root.id), second = add(store, root.id), other = add(store)
  assert.deepEqual(store.snapshot().slotBounds, { maxChildren: 4, maxDepth: 3 }, 'the pair was read once and is now the last one seen')
  const offersUnder = parent => store.extensionPoints().some(point => point.kind === 'child' && point.parentId === parent.id)
  assert.equal(offersUnder(root), true)
  assert.ok(store.movePoints(other.id).some(point => point.parentId === root.id))

  state.bounds = { maxChildren: 2, maxDepth: 3 }
  assert.equal(store.addNode({ parentId: root.id }).ok, false, 'the lowered width refuses a third child')
  assert.equal(store.moveNode(other.id, root.id).ok, false, 'the lowered width refuses a move under the full parent')
  assert.equal(store.movePoints(other.id).some(point => point.parentId === root.id), false, 'the move menu no longer offers the full parent')
  assert.equal(offersUnder(root), false, 'no plus is drawn under the full parent')
  assert.equal(treeSlotUsage(store.snapshot(), root.id).canAdd, false)

  state.bounds = { maxChildren: 4, maxDepth: 0 }
  assert.equal(store.addNode({ parentId: first.id }).ok, false, 'the lowered depth refuses a grandchild')
  assert.equal(offersUnder(first), false)

  state.bounds = { maxChildren: 4, maxDepth: 3 }
  assert.equal(offersUnder(second), true, 'a raised limit is offered again')
  assert.equal(store.addNode({ parentId: first.id }).ok, true, 'a raised limit is seen by the next add')
})
