import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
import { mountComputers, family, hover, settle } from './helpers/t1391-computers-fixture.mjs'

test('mounted drag hover and Reports-to agree on legal, current, cyclic, full and too-deep parents', async t => {
  const nodes = [...family(), { id: 'descendant', parentId: 'worker' },
    { id: 'full', treeId: 'tree-full' }, ...['f1', 'f2', 'f3', 'f4'].map(id => ({ id, treeId: 'tree-full', parentId: 'full' })),
    { id: 'deep-root', treeId: 'tree-deep' }, { id: 'deep-1', treeId: 'tree-deep', parentId: 'deep-root' },
    { id: 'deep-2', treeId: 'tree-deep', parentId: 'deep-1' }]
  const f = await mountComputers(t, nodes)
  await f.openNode('worker')
  const offered = new Set(f.choices())
  for (const [id, expected] of [['manager-b', true], ['manager-a', false], ['descendant', false], ['full', false], ['deep-2', false]]) {
    assert.equal(offered.has(id), expected, id + ' canonical picker premise')
    const result = hover(f.graph, 'worker', id)
    assert.equal(result.allowed, expected, id + ' hover matches picker')
    assert.equal(result.target.el.classList.contains('drop-ok'), expected, id + ' ring')
  }
  assert.deepEqual(f.operations, [])
})

test('mounted blocked drag names the target parent and leaves the saved branch unchanged', async t => {
  const f = await mountComputers(t, [...family(), { id: 'full-parent', treeId: 'tree-full', name: 'Full parent' },
    ...['f1', 'f2', 'f3', 'f4'].map(id => ({ id, treeId: 'tree-full', parentId: 'full-parent' }))])
  const before = f.saved().nodes.find(node => node.id === 'worker')
  const { record, target, allowed } = hover(f.graph, 'worker', 'full-parent')
  assert.equal(allowed, false)
  f.graph._finishEditDrag(record, { recordX: record.x, recordY: record.y })
  await settle()
  const status = f.query('.org-status').textContent
  assert.ok(status.includes(target.agent.name), status)
  assert.match(status, /parent|report/i)
  assert.deepEqual(f.saved().nodes.find(node => node.id === 'worker'), before)
  assert.deepEqual(f.operations, [])
})

test('mounted drag still refuses a target filled after hover and names that target', async t => {
  const f = await mountComputers(t, [...family(), { id: 'other', parentId: 'manager-a' },
    ...['b1', 'b2', 'b3'].map(id => ({ id, parentId: 'manager-b' }))])
  assert.equal(hover(f.graph, 'worker', 'manager-b').allowed, true)
  assert.equal(await f.move('other', 'manager-b'), true)
  assert.equal(await f.move('worker', 'manager-b'), false)
  assert.equal(f.saved().nodes.find(node => node.id === 'worker').parentId, 'manager-a')
  const targetName = f.graph.nodes.get('manager-b').agent.name
  assert.ok(f.query('.org-status').textContent.includes(targetName))
  assert.match(f.query('.org-status').textContent, /4 of 4/)
  assert.deepEqual(f.operations, [])
})

test('mounted split graph forwards canonical parent admission and does not light a full target', async t => {
  const f = await mountComputers(t, [...family(), ...['b1', 'b2', 'b3', 'b4'].map(id => ({ id, parentId: 'manager-b' }))])
  f.graph.treeWindows.add([...f.graph.windowRootIds])
  await settle()
  const second = f.graph.treeWindows.windows[1]?.graph
  assert.ok(second, 'real second graph mounted')
  assert.equal(hover(second, 'worker', 'manager-b').allowed, false)
  assert.equal(hover(second, 'worker', 'root').allowed, true)
  assert.deepEqual(f.operations, [])
})
