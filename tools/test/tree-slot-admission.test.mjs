import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createFleetTreeStore, parseFleetTrees } from '../../src/fleet-trees.js'
import * as policy from '../../shell/tree-slot-policy.mjs'
const { createTreeSlotAdmission } = createRequire(import.meta.url)('../../shell/tree-slot-admission.cjs')

function fixture(count = 0) {
  let serial = 0, text = null
  const store = createFleetTreeStore({ computerId: 'fixture',
    readBounds: () => ({ maxChildren: 64, maxDepth: 16 }),
    makeId: kind => kind + '-' + (++serial),
    storage: { read: () => text, write: (_key, value) => { text = JSON.stringify(value); return true } } })
  const add = (parentId = null, reservedNodeId = undefined) => {
    const result = store.addNode({ parentId, role: 'worker', message: 'Synthetic task', reservedNodeId })
    assert.equal(result.ok, true, result.problems?.join(' '))
    return result.node
  }
  const root = add()
  assert.equal(store.attachSession(root.id, 'parent-session').ok, true)
  const children = Array.from({ length: count }, () => add(root.id))
  const state = { result: { ok: true, bounds: { maxChildren: 4, maxDepth: 3 } } }
  const admission = createTreeSlotAdmission({
    readBounds: () => state.result, readForest: () => parseFleetTrees(text, { computerId: 'fixture' }),
    parseRecord: parseFleetTrees, policy, makeId: () => 'reservation-' + (++serial),
  })
  const reserve = (parentSessionId = 'parent-session') => admission.reserve({ computerId: 'fixture', parentSessionId })
  const validate = (previous, value = text) => admission.validateWrite({ computerId: 'fixture', previous, value })
  return { store, add, root, children, state, admission, reserve, validate, raw: () => text }
}
test('native reservations serialize two requests for the last total slot', () => {
  const f = fixture(3), before = f.raw()
  const first = f.reserve()
  assert.throws(() => f.reserve(), error => error.code === 'TREE_SLOT_LIMIT')
  assert.equal(f.raw(), before)
  first.release(); first.release()
  assert.ok(f.reserve().nodeId)
})
test('a persisted reserved child counts once and blocks another sibling', () => {
  const f = fixture(3), permit = f.reserve(), before = f.raw()
  f.add(f.root.id, permit.nodeId)
  assert.equal(f.validate(before).ok, true)
  assert.throws(() => f.reserve(), error => error.code === 'TREE_SLOT_LIMIT')
  permit.release()
  assert.throws(() => f.reserve(), error => error.code === 'TREE_SLOT_LIMIT')
})
test('native write admission blocks direct growth around command reservations', () => {
  const f = fixture(3), permit = f.reserve(), before = f.raw()
  f.add(f.root.id)
  const refused = f.validate(before)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'TREE_SLOT_LIMIT')
  permit.release()
  assert.equal(f.validate(before).ok, true, 'cancelling an unfilled reservation permits legitimate admission')
})
test('native writes cannot create a fifth saved nonrunning child', () => {
  const f = fixture(4), before = f.raw()
  f.add(f.root.id)
  assert.equal(f.validate(before).ok, false)
})
test('limits are re-read at write time after a reservation', () => {
  const f = fixture(3), permit = f.reserve(), before = f.raw()
  f.state.result.bounds = { maxChildren: 3, maxDepth: 3 }
  f.add(f.root.id, permit.nodeId)
  assert.equal(f.validate(before).ok, false)
})
test('native lifecycle writes preserve over-limit saved history even when settings are unavailable', () => {
  const f = fixture(6), before = f.raw()
  f.state.result = { ok: false, reason: 'Synthetic unreadable settings' }
  assert.equal(f.store.attachSession(f.children[0].id, 'resumed-in-same-slot').ok, true)
  assert.equal(f.validate(before).ok, true)
  assert.equal(parseFleetTrees(f.raw()).nodes.length, 7)
  assert.throws(() => f.reserve(), error => error.code === 'TREE_SLOT_SETTINGS_UNAVAILABLE')
})
test('native admissions apply width to the actual parent and depth to a moved branch', () => {
  const f = fixture(2), [left, right] = f.children
  f.add(left.id); f.add(left.id)
  f.state.result.bounds = { maxChildren: 2, maxDepth: 2 }
  assert.equal(f.store.attachSession(right.id, 'right-session').ok, true)
  const permit = f.reserve('right-session')
  permit.release()
  const before = f.raw()
  assert.equal(f.store.moveNode(left.id, right.id).ok, true)
  assert.equal(f.validate(before).ok, false, 'moving the branch cannot hide its descendants below the depth limit')
})
test('native writes preserve the parent identity of a reserved slot', () => {
  const f = fixture(1), permit = f.reserve(), before = f.raw()
  f.add(f.children[0].id, permit.nodeId)
  const refused = f.validate(before)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'TREE_SLOT_ID_CONFLICT')
})
test('malformed saved forest or unknown requesting session cannot grant capacity', () => {
  const f = fixture(0)
  assert.throws(() => f.reserve('missing-session'), error => error.code === 'TREE_SLOT_PARENT_UNAVAILABLE')
  assert.equal(f.validate(f.raw(), '{"nodes":[]}').ok, false)
})
