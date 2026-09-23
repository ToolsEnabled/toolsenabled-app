import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createFleetTreeStore, safeTreeStorage, fleetTreesStorageKey } from '../../src/fleet-trees.js'
let refreshSavedTreeMaintenance = () => ({ ok: false, code: 'REFRESH_UNAVAILABLE' })
try { ({ refreshSavedTreeMaintenance } = await import('../../src/saved-tree-maintenance-refresh.js')) }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error }
const source = fs.readFileSync(new URL('../../public/durable-storage.js', import.meta.url), 'utf8')
let serial = 0
function fixture() {
  const computerId = 'maintenance-fixture-' + (++serial), key = fleetTreesStorageKey(computerId)
  const cells = new Map(), calls = []
  let fail = false
  const window = { localStorage: {}, mcPrefs: { available: true, values: {},
    read(name) { calls.push(['read', name]); return { ok: true, value: cells.get(name) ?? null } },
    write(name, value, expected) {
      calls.push(['write', name])
      if (fail || ((cells.get(name) ?? null) !== (expected ?? null))) return { ok: false }
      cells.set(name, value); return { ok: true }
    },
  } }
  vm.runInNewContext(source, { window })
  const tree = createFleetTreeStore({ computerId, storage: safeTreeStorage(window.localStorage), makeId: kind => kind + '-' + (++serial) })
  const root = tree.addNode({ role: 'controller', message: 'Synthetic retained task' }).node
  tree.attachSession(root.id, 'repair-session')
  tree.setNodeStatus(root.id, 'turn-failed', { note: 'Synthetic stale failure', turnId: 'repair-turn' })
  const child = tree.addNode({ parentId: root.id, role: 'worker', message: 'Synthetic independent work' }).node
  tree.attachSession(child.id, 'live-child-session')
  tree.setNodeStatus(child.id, 'running', { turnId: 'live-turn' })
  const before = cells.get(key), afterObject = JSON.parse(before)
  const target = afterObject.nodes.find(node => node.id === root.id)
  target.status = 'finished'; delete target.statusNote
  const after = JSON.stringify(afterObject)
  const refresh = () => window.mcDurableStorage.refreshFleet?.([key]) || { ok: false, code: 'REFRESH_UNAVAILABLE' }
  return { window, calls, cells, tree, root, child, key, before, after, afterObject, refresh, setFail(value) { fail = value } }
}

test('native maintenance refresh updates the launch cache and open tree without losing a live sibling or writing old bytes', () => {
  const f = fixture(), sibling = f.tree.getNode(f.child.id)
  let publications = 0
  f.tree.subscribe(() => { publications++ })
  f.cells.set(f.key, f.after)
  const start = f.calls.length
  const result = f.refresh()
  assert.equal(result.ok, true)
  assert.equal(refreshSavedTreeMaintenance(result.changes).ok, true)
  assert.equal(f.window.localStorage.getItem(f.key), f.after)
  assert.equal(f.tree.getNode(f.root.id).status, 'finished')
  assert.deepEqual(f.tree.getNode(f.child.id), sibling)
  assert.equal(publications, 1)
  assert.deepEqual(f.calls.slice(start), [['read', f.key]])
  assert.equal(f.tree.setNodeReply(f.child.id, 'Synthetic next accepted progress').ok, true)
  assert.equal(JSON.parse(f.cells.get(f.key)).nodes.find(row => row.id === f.root.id).status, 'finished')
})

test('maintenance refresh refuses an unsaved runtime change and preserves its words', () => {
  const f = fixture()
  f.setFail(true)
  f.tree.setNodeReply(f.child.id, 'Synthetic unsaved progress')
  assert.equal(f.tree.snapshot().persistenceFailed, true)
  f.cells.set(f.key, f.after)
  const result = f.refresh()
  assert.equal(result.ok, true)
  assert.equal(refreshSavedTreeMaintenance(result.changes).ok, false)
  assert.equal(f.tree.getNode(f.child.id).reply, 'Synthetic unsaved progress')
  assert.equal(f.cells.get(f.key), f.after)
})

test('maintenance refresh cannot adopt a different session or turn as the repaired node', () => {
  const f = fixture()
  const changed = structuredClone(f.afterObject)
  changed.nodes.find(row => row.id === f.root.id).sessionId = 'different-session'
  f.cells.set(f.key, JSON.stringify(changed))
  const result = f.refresh()
  assert.equal(result.ok, true)
  assert.equal(refreshSavedTreeMaintenance(result.changes).ok, false)
  assert.equal(f.tree.getNode(f.root.id).sessionId, 'repair-session')
  assert.equal(f.tree.getNode(f.root.id).status, 'turn-failed')
})

test('maintenance refresh refuses changes to words even if status is also repaired', () => {
  const f = fixture()
  f.afterObject.nodes.find(row => row.id === f.root.id).message = 'Unexpected replacement words'
  f.cells.set(f.key, JSON.stringify(f.afterObject))
  const result = f.refresh()
  assert.equal(result.ok, true)
  assert.equal(refreshSavedTreeMaintenance(result.changes).ok, false)
  assert.equal(f.tree.getNode(f.root.id).message, 'Synthetic retained task')
})

test('a failed multi-document native refresh leaves every launch cache cell unchanged', () => {
  const f = fixture(), second = f.key + '-second'
  f.window.mcPrefs.read = key => key === second ? { ok: false } : { ok: true, value: f.after }
  const result = f.window.mcDurableStorage.refreshFleet?.([f.key, second])
  assert.equal(result?.ok, false)
  assert.equal(f.window.localStorage.getItem(f.key), f.before)
  assert.equal(f.window.localStorage.getItem(second), null)
})

test('native maintenance refresh refuses non-fleet keys and duplicate or over-bound input without reading', () => {
  const f = fixture(), count = f.calls.length
  for (const keys of [['mc.secret'], [f.key, f.key], Array.from({ length: 65 }, (_, n) => f.key + '-' + n)]) {
    const result = f.window.mcDurableStorage.refreshFleet?.(keys)
    assert.equal(result?.ok, false)
  }
  assert.equal(f.calls.length, count)
})

test('a confirmed status rollback refreshes the existing store and keeps its session', () => {
  const f = fixture()
  f.cells.set(f.key, f.after)
  assert.equal(refreshSavedTreeMaintenance(f.refresh().changes).ok, true)
  f.cells.set(f.key, f.before)
  assert.equal(refreshSavedTreeMaintenance(f.refresh().changes).ok, true)
  assert.equal(f.tree.getNode(f.root.id).status, 'turn-failed')
  assert.equal(f.tree.getNode(f.root.id).statusNote, 'Synthetic stale failure')
  assert.equal(f.tree.getNode(f.root.id).sessionId, 'repair-session')
})
