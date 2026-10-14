import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
import { mountComputers, family, settle } from './helpers/t1391-computers-fixture.mjs'

const isDetails = fixture => {
  assert.equal(fixture.query('[data-rail-tab="details"]').classList.contains('on'), true)
  assert.equal(fixture.query('[data-rail-body="details"]').hidden, false)
}
const choose = (fixture, value) => {
  const select = fixture.query('[data-tree-move-select]')
  select.value = value
  select.dispatchEvent(new Event('change'))
  return select
}

test('mounted childless slot advice offers Add while existing-child and full guidance stay truthful', async t => {
  const f = await mountComputers(t, [...family(),
    { id: 'extra-a', parentId: 'manager-b' }, { id: 'extra-b', parentId: 'manager-b' },
    { id: 'extra-c', parentId: 'manager-b' }, { id: 'extra-d', parentId: 'manager-b' }])
  await f.openNode('worker')
  assert.match(f.query('[data-direct-slot-usage]').textContent, /0 of 4/)
  assert.match(f.query('[data-direct-slot-usage]').textContent, /Add an agent/)
  assert.doesNotMatch(f.query('[data-direct-slot-usage]').textContent, /Reuse|restart/)
  await f.openNode('manager-a')
  assert.match(f.query('[data-direct-slot-usage]').textContent, /1 of 4.*Reuse a child/s)
  await f.openNode('manager-b')
  assert.match(f.query('[data-direct-slot-usage]').textContent, /4 of 4.*Reuse or restart/s)
  assert.deepEqual(f.operations, [])
})

test('mounted Reports-to Save keeps Details selected with the accepted move confirmation', async t => {
  const f = await mountComputers(t)
  await f.openNode('worker')
  choose(f, 'manager-b')
  f.query('[data-tree-move-save]').click()
  await settle()
  assert.equal(f.saved().nodes.find(node => node.id === 'worker').parentId, 'manager-b')
  isDetails(f)
  assert.match(f.query('[data-tree-move-out]').textContent, /^Saved\./)
  assert.match(f.query('[data-tree-move-out]').textContent, /reports to/)
  assert.deepEqual(f.operations, [])
})

test('mounted Reports-to refused Save stays in Details and preserves the saved parent', async t => {
  const f = await mountComputers(t)
  await f.openNode('worker')
  f.query('[data-tree-move-save]').click()
  isDetails(f)
  assert.match(f.query('[data-tree-move-out]').textContent, /pick|choose/i)
  // Insert a stale option as a native menu could retain during a competing
  // change; the production click handler must re-read canonical admission.
  const select = f.query('[data-tree-move-select]')
  const stale = document.createElement('option'); stale.value = 'manager-a'; stale.textContent = 'Old choice'
  select.appendChild(stale); select.value = 'manager-a'
  f.query('[data-tree-move-save]').click()
  isDetails(f)
  assert.match(f.query('[data-tree-move-out]').textContent, /tree changed/i)
  assert.equal(f.saved().nodes.find(node => node.id === 'worker').parentId, 'manager-a')
  assert.deepEqual(f.operations, [])
})

test('mounted Reports-to refreshes after drag without replacing the picker or losing a legal unsaved choice', async t => {
  const f = await mountComputers(t, [...family(), { id: 'other', parentId: 'manager-a' }])
  await f.openNode('worker')
  const select = choose(f, 'manager-b')
  select.focus()
  assert.equal(await f.move('other', 'manager-b'), true)
  assert.equal(f.query('[data-tree-move-select]'), select)
  assert.equal(select.value, 'manager-b')
  assert.equal(document.activeElement, select)
  isDetails(f)
  assert.equal(f.saved().nodes.find(node => node.id === 'worker').parentId, 'manager-a')
  assert.deepEqual(f.operations, [])
})

test('mounted Reports-to removes the new parent and offers the old parent after a drag', async t => {
  const f = await mountComputers(t)
  await f.openNode('worker')
  const select = choose(f, 'manager-b')
  select.focus()
  assert.equal(await f.move('worker', 'manager-b'), true)
  assert.equal(f.query('[data-tree-move-select]'), select)
  assert.equal(select.value, '')
  assert.equal(document.activeElement, select)
  assert.ok(f.choices().includes('manager-a'))
  assert.equal(f.choices().includes('manager-b'), false)
  assert.match(f.query('[data-tree-move-out]').textContent, /no longer available|no longer.*parent/i)
  isDetails(f)
  assert.deepEqual(f.operations, [])
})

test('mounted Reports-to invalidates a choice when another agent fills its last slot', async t => {
  const f = await mountComputers(t, [...family(),
    { id: 'other', parentId: 'manager-a' },
    ...['b1', 'b2', 'b3'].map(id => ({ id, parentId: 'manager-b' }))])
  await f.openNode('worker')
  const select = choose(f, 'manager-b')
  select.focus()
  assert.equal(await f.move('other', 'manager-b'), true)
  assert.equal(select.value, '')
  assert.equal(f.choices().includes('manager-b'), false)
  assert.equal(document.activeElement, select)
  assert.match(f.query('[data-tree-move-out]').textContent, /no longer available|no longer.*parent/i)
  assert.equal(f.saved().nodes.find(node => node.id === 'worker').parentId, 'manager-a')
  isDetails(f)
  assert.deepEqual(f.operations, [])
})

test('mounted Reports-to refreshes on detach and becomes usable when an initially empty menu gains a parent', async t => {
  const f = await mountComputers(t, [{ id: 'root' }, { id: 'worker', parentId: 'root' }])
  await f.openNode('worker')
  assert.deepEqual(f.choices(), [])
  assert.equal(f.graph.onDetachToNewTree('worker'), true)
  await settle()
  assert.ok(f.choices().includes('root'))
  choose(f, 'root')
  f.query('[data-tree-move-save]').click()
  await settle()
  assert.equal(f.saved().nodes.find(node => node.id === 'worker').parentId, 'root')
  isDetails(f)
  assert.match(f.query('[data-tree-move-out]').textContent, /^Saved\./)
  assert.deepEqual(f.operations, [])
})

test('mounted Reports-to preserves the store revision refusal and keeps its remedy visible in Details', async t => {
  const f = await mountComputers(t)
  await f.openNode('worker')
  choose(f, 'manager-b')
  const external = f.saved()
  external.nodes.find(node => node.id === 'root').message = 'Concurrent retained fixture edit'
  f.replaceSaved(external)
  f.query('[data-tree-move-save]').click()
  await settle()
  isDetails(f)
  assert.match(f.query('[data-tree-move-out]').textContent, /changed|another window|reload|reopen/i)
  assert.equal(f.saved().nodes.find(node => node.id === 'worker').parentId, 'manager-a')
  assert.equal(f.saved().nodes.find(node => node.id === 'root').message, 'Concurrent retained fixture edit')
  assert.deepEqual(f.operations, [])
})

/* T1467: with two trees, Reports to listed parents only as role + id suffix
   ("Controller (d3f68efd)"), so nothing said which tree a move went to. */
test('mounted Reports-to names the tree of every choice, and this circle\'s own tree as this tree', async t => {
  const f = await mountComputers(t, [...family(),
    { id: 'other-root', role: 'controller', treeId: 'tree-2', message: 'Ship the installer' },
    { id: 'other-manager', parentId: 'other-root', role: 'manager', treeId: 'tree-2', message: 'Build the package' }])
  await f.openNode('worker')
  const labels = [...f.query('[data-tree-move-select]').querySelectorAll('option')].filter(option => option.value)
    .map(option => [option.value, option.textContent])
  const byValue = Object.fromEntries(labels)
  assert.match(byValue['other-root'], / — Ship the installer$/)
  assert.match(byValue['other-manager'], / — Ship the installer$/)
  assert.match(byValue['manager-b'], / — this tree$/)
  assert.deepEqual(labels.filter(([, text]) => /\([0-9a-f]{8}\)$/.test(text)), [], 'no choice is told apart only by an id')
  assert.deepEqual(f.operations, [])
})
