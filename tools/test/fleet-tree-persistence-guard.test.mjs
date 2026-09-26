import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createFleetTreeStore, fleetTreesStorageKey, safeTreeStorage,
} from '../../src/fleet-trees.js'

const COMPUTER = 'persistence-fixture'
const KEY = fleetTreesStorageKey(COMPUTER)

function fixture() {
  const cells = new Map()
  const writes = []
  let unavailable = false
  let full = false
  let sequence = 0
  const backing = {
    getItem(key) {
      if (unavailable) throw new Error('fixture read unavailable')
      return cells.get(key) ?? null
    },
    setItem(key, text) {
      if (full) throw new Error('fixture quota reached')
      cells.set(key, text)
      writes.push(text)
    },
  }
  const open = (extra = {}) => createFleetTreeStore({
    computerId: COMPUTER,
    storage: safeTreeStorage(backing),
    makeId: kind => `${kind}-${++sequence}`,
    now: () => '2026-09-05T12:00:00.000Z',
    ...extra,
  })
  return {
    backing, cells, writes, open,
    unavailable: value => { unavailable = value },
    full: value => { full = value },
    saved: () => JSON.parse(cells.get(KEY)),
  }
}

test('an unavailable initial read cannot become a writable empty tree', () => {
  const f = fixture()
  const original = f.open().addNode({ role: 'worker', message: 'Keep the original brief' }).node
  const saved = f.cells.get(KEY)
  f.unavailable(true)
  assert.throws(() => f.open(), { code: 'MC_TREE_STORAGE_UNAVAILABLE' })
  f.unavailable(false)
  assert.equal(f.cells.get(KEY), saved)
  assert.equal(f.open().getNode(original.id).message, 'Keep the original brief')
})

test('a present but refused record is preserved, never treated as a new installation', () => {
  const f = fixture()
  const node = f.open().addNode({ role: 'worker' }).node
  const good = f.saved()
  const cases = [
    '{partial json', 'null', '[]', '',
    JSON.stringify({ ...good, version: 999 }),
    JSON.stringify({ ...good, computerId: 'another-computer' }),
    JSON.stringify({ ...good, nodes: [...good.nodes, { ...node, id: 'orphan', parentId: 'missing-parent' }] }),
  ]
  for (const raw of cases) {
    f.cells.set(KEY, raw)
    const count = f.writes.length
    assert.throws(() => f.open(), { code: 'MC_TREE_STORAGE_INVALID' })
    assert.equal(f.cells.get(KEY), raw, 'the refused source must remain available for recovery')
    assert.equal(f.writes.length, count, 'opening a refused record must never migrate or replace it')
  }
})

test('genuine absence and a valid empty record still permit a fresh tree', () => {
  const f = fixture()
  assert.equal(f.open().snapshot().nodes.length, 0)
  const store = f.open()
  const node = store.addNode({ role: 'worker' }).node
  assert.equal(store.removeNode(node.id).ok, true)
  assert.equal(f.saved().nodes.length, 0, 'an intentional current last-node removal is still durable')
  const reopened = f.open()
  assert.equal(reopened.addNode({ role: 'manager' }).ok, true)
  assert.equal(f.saved().nodes.length, 1)
})

test('a stale last-node removal cannot wipe a newer tree saved by another store', () => {
  const f = fixture()
  const older = f.open()
  const oldNode = older.addNode({ role: 'worker', message: 'Original' }).node
  const newer = f.open()
  const newNode = newer.addNode({ role: 'worker', message: 'Newer work' }).node
  assert.equal(f.saved().trees.length, 2)
  const saved = f.cells.get(KEY)
  const removed = older.removeNode(oldNode.id)
  assert.equal(removed.ok, false)
  assert.match(removed.problems.join(' '), /changed.*saved|saved.*changed/i)
  assert.equal(f.cells.get(KEY), saved)
  assert.ok(older.getNode(oldNode.id), 'a refused delete must not disappear locally either')
  assert.equal(older.snapshot().persistenceFailed, true)
  assert.match(older.snapshot().persistenceProblem, /changed/i)
  const reopened = f.open()
  assert.ok(reopened.getNode(oldNode.id))
  assert.ok(reopened.getNode(newNode.id))
  assert.equal(reopened.removeNode(oldNode.id).ok, true, 'a freshly read intent may remove only its target')
  assert.deepEqual(f.saved().nodes.map(node => node.id), [newNode.id])
})

test('every tree mutation refuses a stale source before changing the local maps', () => {
  const calls = [
    ['refreshNodeNames'], ['createTree'], ['setTreeProfile', 'unused', 'folder'],
    ['renameTree', 'unused', 'New name'], ['removeTree', 'unused'],
    ['addNode', { role: 'worker' }], ['updateNode', 'unused', { message: 'New brief' }],
    ['moveNode', 'unused'], ['detachToNewTree', 'unused'], ['removeNode', 'unused'],
    ['markPromptedByPerson', 'unused'], ['setNodeStatus', 'unused', 'finished'],
    ['setNodeReply', 'unused', 'New reply'], ['attachSession', 'unused', 'session-new'],
    ['detachSession', 'unused'],
  ]
  for (const [method, ...args] of calls) {
    const f = fixture()
    const older = f.open()
    older.addNode({ role: 'worker' })
    const before = older.snapshot()
    f.open().addNode({ role: 'manager' })
    const saved = f.cells.get(KEY)
    const result = older[method](...args)
    assert.equal(result.ok, false, method)
    assert.match(result.problems.join(' '), /changed/i, method)
    assert.deepEqual(older.snapshot().nodes, before.nodes, method)
    assert.deepEqual(older.snapshot().trees, before.trees, method)
    assert.equal(f.cells.get(KEY), saved, method)
  }
})

test('a transient read refusal after loading blocks edits without losing the saved or local record', () => {
  const f = fixture()
  const store = f.open()
  const node = store.addNode({ role: 'worker', message: 'Before' }).node
  const saved = f.cells.get(KEY)
  f.unavailable(true)
  const refused = store.updateNode(node.id, { message: 'During refusal' })
  assert.equal(refused.ok, false)
  assert.equal(store.getNode(node.id).message, 'Before')
  assert.equal(f.cells.get(KEY), saved)
  f.unavailable(false)
  assert.equal(store.updateNode(node.id, { message: 'After recovery' }).ok, true)
  assert.equal(store.snapshot().persistenceFailed, false)
  assert.equal(f.saved().nodes[0].message, 'After recovery')
})

test('a save failure still retains in-memory work and can recover when no other writer changed storage', () => {
  const f = fixture()
  const store = f.open()
  const node = store.addNode({ role: 'worker', message: 'Before' }).node
  f.full(true)
  assert.equal(store.updateNode(node.id, { message: 'Unsaved words' }).ok, true)
  assert.equal(store.snapshot().persistenceFailed, true)
  assert.equal(store.getNode(node.id).message, 'Unsaved words')
  assert.equal(f.saved().nodes[0].message, 'Before')
  f.full(false)
  assert.equal(store.renameTree(node.treeId, 'Recovered').ok, true)
  assert.equal(store.snapshot().persistenceFailed, false)
  assert.equal(f.saved().nodes[0].message, 'Unsaved words')
})

test('automatic name migration must not overwrite a write made after the initial read', () => {
  const f = fixture()
  f.open().addNode({ role: 'worker', message: 'Original' })
  let newerSaved
  let once = false
  const migrating = f.open({ roleLabel: () => {
    if (!once) {
      once = true
      f.open().addNode({ role: 'manager', message: 'Newer tree' })
      newerSaved = f.cells.get(KEY)
    }
    return 'Worker'
  } })
  assert.equal(f.cells.get(KEY), newerSaved)
  assert.equal(migrating.snapshot().persistenceFailed, true)
  assert.equal(f.saved().nodes.length, 2)
})

test('a current migration preserves all original fields and persists its name metadata', () => {
  const f = fixture()
  const node = f.open().addNode({ role: 'worker', message: 'Retained brief' }).node
  const store = f.open({ roleLabel: () => 'Worker' })
  assert.equal(store.snapshot().persistenceFailed, false)
  assert.equal(f.saved().nodes[0].id, node.id)
  assert.equal(f.saved().nodes[0].message, 'Retained brief')
  assert.equal(f.saved().nodes[0].nameBase, 'Worker')
})

test('the legacy read/write seam distinguishes a thrown read and detects a stale writer too', () => {
  assert.throws(() => createFleetTreeStore({
    computerId: COMPUTER,
    storage: { read: () => { throw new Error('read refused') }, write: () => true },
  }), { code: 'MC_TREE_STORAGE_UNAVAILABLE' })
  const f = fixture()
  const storage = {
    read: key => f.cells.has(key) ? JSON.parse(f.cells.get(key)) : null,
    write: (key, value) => { f.backing.setItem(key, JSON.stringify(value)); return true },
  }
  const older = f.open({ storage })
  const node = older.addNode({ role: 'worker' }).node
  f.open({ storage }).addNode({ role: 'manager' })
  const saved = f.cells.get(KEY)
  assert.equal(older.removeNode(node.id).ok, false)
  assert.equal(f.cells.get(KEY), saved)
})

test('a missing backing never claims that a tree was read or saved', () => {
  for (const backing of [null, undefined, {}]) {
    const storage = safeTreeStorage(backing)
    assert.equal(storage.write(KEY, {}), false)
    assert.equal(storage.writeText(KEY, '{}'), false)
    assert.throws(() => createFleetTreeStore({ computerId: COMPUTER, storage }), { code: 'MC_TREE_STORAGE_UNAVAILABLE' })
  }
})
