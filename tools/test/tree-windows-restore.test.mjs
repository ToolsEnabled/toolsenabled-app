import assert from 'node:assert/strict'
import test from 'node:test'
import { TreeWindows } from '../../src/tree-windows.js'
import { TreeScope } from '../../src/tree-scope.js'

const agents = [
  { id: 'controller', parentId: null }, { id: 'builder', parentId: 'controller' },
  { id: 'reviewer', parentId: null }, { id: 'review-child', parentId: 'reviewer' },
  { id: 'researcher', parentId: null },
]
const roots = ['controller', 'reviewer', 'researcher']

function restoring(t, views, available = roots) {
  const frames = [], paints = [], pending = [], writes = []
  t.mock.method(globalThis, 'requestAnimationFrame', callback => { pending.push(callback); return pending.length })
  const computer = { id: 'isolated-sample', agents: structuredClone(agents) }
  const graph = () => ({
    computer, declaredEdges: [], windowRootIds: [], rootId: null, editMode: false, boxFocus: new Map(),
    zoom: 0.83, panX: 12, panY: -34, _treeScope: new TreeScope(computer.agents),
    _agentFor(id) { return computer.agents.find(agent => agent.id === id) || null },
    clearRoot() { this.rootId = null },
    _reconcile() { paints.push(this) }, resize() {}, _applyZoom() {},
  })
  const main = graph()
  main.workspace = { syncTreeTabs() {}, showTrees() {} }
  const board = Object.assign(Object.create(TreeWindows.prototype), {
    main, activeId: null, getTrees: () => available.map(rootId => ({ rootId })),
    workspaces: [{ id: 'trees', name: 'Trees', views }], windows: [{ graph: main }],
    capture() {}, refreshHeaders() {}, remember() { writes.push(true) },
    add(ids) { const frame = { graph: graph() }; this.windows.push(frame); this.choose(frame, ids, { remember: false }) },
  })
  board.activate('trees', { remember: false, show: false })
  for (const callback of pending) callback()
  return { board, main, paints, writes, computer }
}

// Node does not expose RAF; the test replaces only that scheduling boundary.
if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = () => 0

test('regenerated sample roots keep the primary populated and the empty split on the right', t => {
  const views = [{ rootIds: ['old-sample-root'], focusId: 'old-sample-child' }, { rootIds: [], empty: true }]
  const before = structuredClone(views)
  const { board, main, writes, computer } = restoring(t, views)
  assert.equal(board.windows.length, 2)
  assert.equal(board.windows[0].graph, main)
  assert.deepEqual(main.windowRootIds, roots)
  assert.equal(main.rootId, null)
  assert.equal(board.windows[0].empty, false)
  assert.deepEqual(board.windows[1].graph.windowRootIds, [])
  assert.equal(board.windows[1].empty, true)
  assert.deepEqual(writes, [], 'restoration does not rewrite saved preferences')
  assert.deepEqual(views, before, 'saved pane records remain unchanged')
  assert.deepEqual(computer.agents, agents, 'restoration never rewrites fleet data')
})

test('a valid secondary remains secondary when the primary IDs are stale', t => {
  const { board, main } = restoring(t, [
    { rootIds: ['stale'] }, { rootIds: ['reviewer'], focusId: 'review-child', dropId: 'review-child' },
  ])
  assert.deepEqual(main.windowRootIds, roots)
  assert.deepEqual(board.windows[1].graph.windowRootIds, ['reviewer'])
  assert.equal(board.windows[1].graph.rootId, 'review-child')
  assert.equal(board.windows[1].dropId, 'review-child')
})

test('surviving primary selections retain order, branch focus, and camera', t => {
  const camera = { zoom: 1.27, panX: -189, panY: 63, _viewSteered: true }
  const { main, board } = restoring(t, [
    { rootIds: ['reviewer', 'stale', 'controller'], focusId: 'review-child', camera,
      focus: new Map([['reviewer', 'review-child']]) }, { rootIds: [], empty: true },
  ])
  assert.deepEqual(main.windowRootIds, ['reviewer', 'controller'])
  assert.equal(main.rootId, 'review-child')
  assert.deepEqual(main.boxFocus, new Map([['reviewer', 'review-child']]))
  for (const [key, value] of Object.entries(camera)) assert.equal(main[key], value)
  assert.equal(board.windows.length, 2)
})

test('a stale secondary becomes an empty drop pane without replacing a valid primary', t => {
  const { main, board } = restoring(t, [{ rootIds: ['reviewer'] }, { rootIds: ['stale'], dropId: 'stale-child' }])
  assert.deepEqual(main.windowRootIds, ['reviewer'])
  assert.equal(board.windows.length, 2)
  assert.equal(board.windows[1].empty, true)
  assert.deepEqual(board.windows[1].graph.windowRootIds, [])
})

test('no saved views or an explicitly empty primary restore current roots', t => {
  for (const views of [[], [{ rootIds: [] }]]) {
    const { main, board } = restoring(t, views)
    assert.deepEqual(main.windowRootIds, roots)
    assert.equal(board.windows.length, 1)
  }
})

test('an actually empty fleet stays empty without inventing a root or dropping its split', t => {
  const { main, board } = restoring(t, [{ rootIds: ['stale'] }, { rootIds: [], empty: true }], [])
  assert.deepEqual(main.windowRootIds, [])
  assert.equal(board.windows.length, 2)
  assert.equal(board.windows[1].empty, true)
})
