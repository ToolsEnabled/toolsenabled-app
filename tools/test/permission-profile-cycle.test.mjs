import test from 'node:test'
import assert from 'node:assert/strict'
import { createActionPermissionSettings, wouldCreatePermissionCycle } from '../../src/action-permission-settings.js'

const profiles = [
  { id: 'root', name: 'Root', parentId: null, actions: {} },
  { id: 'child', name: 'Child', parentId: 'root', actions: {} },
  { id: 'leaf', name: 'Leaf', parentId: 'child', actions: {} },
  { id: 'sibling', name: 'Sibling', parentId: null, actions: {} },
]
test('parent candidates exclude self and every descendant, while keeping ancestors and unrelated profiles', () => {
  for (const id of ['root', 'child', 'leaf']) assert.equal(wouldCreatePermissionCycle(profiles, 'root', id), true)
  for (const id of [null, '', 'sibling']) assert.equal(wouldCreatePermissionCycle(profiles, 'root', id), false)
  assert.equal(wouldCreatePermissionCycle(profiles, 'leaf', 'root'), false)
  assert.equal(wouldCreatePermissionCycle([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }], 'root', 'a'), true)
})
test('the picker excludes descendants and a stale cycle choice is refused without staging or losing focus', () => {
  let value = { v: 1, activeProfileId: 'root', profiles: structuredClone(profiles) }
  const stages = [], handlers = new Map(), status = { textContent: '' }
  const panel = createActionPermissionSettings({
    storage: { getItem: () => null },
    draft: { value: () => value, stage: (key, next) => { stages.push(next); value = next } },
  })
  const root = { addEventListener: (type, fn) => handlers.set(type, fn), removeEventListener() {}, querySelector: () => status }
  panel.bind(root)
  const parents = panel.markup().match(/<select data-permission-parent>(.*?)<\/select>/s)[1]
  assert.match(parents, /value="sibling"/)
  for (const id of ['root', 'child', 'leaf']) assert.equal(parents.includes(`value="${id}"`), false)
  const input = { value: 'leaf', closest: () => root, matches: s => s === '[data-permission-parent]' }
  handlers.get('change')({ target: input })
  assert.equal(stages.length, 0)
  assert.equal(input.value, '')
  assert.equal(value.profiles[0].parentId, null)
  assert.equal(status.textContent, 'Permission profiles cannot inherit in a circle.')
  input.value = 'sibling'
  handlers.get('change')({ target: input })
  assert.equal(stages.length, 1)
  assert.equal(value.profiles[0].parentId, 'sibling')
  panel.destroy()
})
