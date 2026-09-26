import assert from 'node:assert/strict'
import test from 'node:test'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { TreeScope } from '../../src/tree-scope.js'
import { layoutBoxTree, treeBoxSize } from '../../src/tree-box-layout.js'
import { chooseTreeProjection } from '../../src/tree-readability.js'

const fleet = (count, prefix = 'agent') => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}-${index}`, name: `${prefix} ${index}`, parentId: index ? `${prefix}-0` : null,
  treeNode: { treeId: prefix, status: 'draft' },
}))

const graph = (agents, options = {}) => Object.assign(Object.create(StaticTreeGraph.prototype), {
  computer: { id: 'smart-navigation-fixture', agents },
  smartScope: true, nodeStyle: 'boxes', cardSize: 'medium', editMode: false,
  rootId: null, declaredEdges: [], W: 1200, H: 800,
  zoomHost: { clientWidth: 1200, clientHeight: 800 },
  zoom: 0.9, panX: 30, panY: 60, _destroyed: false,
  ...options,
})

const camera = subject => ({ zoom: subject.zoom, panX: subject.panX, panY: subject.panY })

test('panning and zooming reuse the same projection without changing the camera or saved fleet', () => {
  const agents = fleet(30), original = structuredClone(agents)
  const subject = graph(agents)
  const first = subject.visibleAgents(), projection = subject._projection
  let probes = 0
  const project = subject._treeScope.project.bind(subject._treeScope)
  subject._treeScope.project = (...args) => { probes++; return project(...args) }
  for (const [zoom, panX, panY] of [[0.1, -700, 100], [1.5, 1000, -400], [2.4, 30, 60]]) {
    Object.assign(subject, { zoom, panX, panY })
    assert.equal(subject.visibleAgents(), first)
    assert.equal(subject._projection, projection)
    assert.deepEqual(camera(subject), { zoom, panX, panY })
  }
  assert.equal(probes, 0, 'a camera-only movement cannot rerun structural projection')
  assert.deepEqual(agents, original)
})

for (const gesture of ['_panState', '_zoomMotion']) {
  test(`a viewport change waits until the active ${gesture} gesture finishes`, () => {
    const subject = graph(fleet(7).map((agent, index) => ({ ...agent, parentId: index ? `agent-${index - 1}` : null })), {
      zoomHost: { clientWidth: 1200, clientHeight: 4000 },
    })
    const open = subject.visibleAgents(), before = camera(subject)
    assert.equal(subject._projection.folded, false)
    subject[gesture] = { active: true }
    subject.zoomHost.clientHeight = 400
    assert.equal(subject.visibleAgents(), open, 'the hierarchy cannot move under an active gesture')
    assert.equal(subject._projection.folded, false)
    subject[gesture] = null
    const folded = subject.visibleAgents()
    assert.notEqual(folded, open)
    assert.equal(subject._projection.folded, true)
    assert.ok(folded.length < open.length)
    assert.deepEqual(camera(subject), before, 'choosing detail does not independently steer the viewport')
  })
}

test('production projection memory carries readability hysteresis across settled resizes', () => {
  const agents = fleet(21), layout = layoutBoxTree({ nodes: agents, W: 800, H: 3000 })
  const xs = [...layout.slots.values()].map(point => point.x)
  const fullWidth = Math.max(...xs) - Math.min(...xs) + treeBoxSize().width
  const minScale = chooseTreeProjection({ scope: new TreeScope(agents), W: 800, H: 3000 }).minScale
  const subject = graph(agents, { zoomHost: { clientWidth: 20 + fullWidth * minScale * 1.05, clientHeight: 3000 } })
  subject.visibleAgents()
  assert.equal(subject._projection.folded, false)
  for (const [ratio, folded] of [[0.95, false], [0.89, true], [1.05, true], [1.11, false]]) {
    subject.zoomHost.clientWidth = 20 + fullWidth * minScale * ratio
    subject.visibleAgents()
    assert.equal(subject._projection.folded, folded, `fit ratio ${ratio} respects the previous decision`)
  }
})

test('refresh invalidates cached topology and summaries even when callers mutate the same agents array', () => {
  const agents = fleet(30), subject = graph(agents)
  const first = subject.visibleAgents(), before = camera(subject)
  assert.equal(first.find(agent => agent.id === 'agent-0').treeScope.summary.total, 30)
  agents[1].treeNode.status = 'running'
  let reconciled
  subject._reconcile = () => { reconciled = subject.visibleAgents() }
  subject.refresh()
  assert.equal(reconciled.find(agent => agent.id === 'agent-0').treeScope.summary.working, 0,
    'saved running status is not evidence that a provider is currently working')
  agents[1].treeActivity = 'working'
  agents.push({ id: 'new-agent', name: 'New agent', parentId: 'agent-0', treeNode: { treeId: 'agent', status: 'finished' } })
  subject.refresh()
  assert.notEqual(reconciled, first)
  assert.deepEqual(reconciled.find(agent => agent.id === 'agent-0').treeScope.summary,
    { total: 31, working: 1, review: 0, finished: 1 })
  assert.ok(subject._scopeModel().branch('agent-0').includes('new-agent'))
  assert.deepEqual(camera(subject), before)

  agents[1].parentId = null
  subject.windowRootIds = ['agent-0']
  subject.refresh()
  assert.deepEqual(reconciled.find(agent => agent.id === 'agent-0').treeScope.summary,
    { total: 30, working: 0, review: 0, finished: 1 }, 'reparenting updates selected-tree membership and status totals')
})

test('replacing the scope instance invalidates its projection even with identical fleet and viewport sizes', () => {
  const agents = fleet(50), subject = graph(agents)
  const first = subject.visibleAgents()
  const replacement = new TreeScope(agents, subject.declaredEdges)
  let probes = 0
  const project = replacement.project.bind(replacement)
  replacement.project = (...args) => { probes++; return project(...args) }
  subject._treeScope = replacement
  const second = subject.visibleAgents()
  assert.ok(probes > 0, 'a new model must determine its own groups and summaries')
  assert.notEqual(second, first)
  const afterReplacement = probes
  assert.equal(subject.visibleAgents(), second)
  assert.equal(probes, afterReplacement, 'the new scope can then use its own cached result')
})

test('switching selected trees and branch focus keeps unrelated agents out of each view cache', () => {
  const firstTree = fleet(30, 'first'), secondTree = fleet(3, 'second'), outside = fleet(40, 'outside')
  const agents = [...firstTree, ...secondTree, ...outside], original = structuredClone(agents)
  const subject = graph(agents, { windowRootIds: ['first-0'], zoomHost: { clientWidth: 2000, clientHeight: 1200 } })
  const first = subject.visibleAgents()
  assert.equal(first[0].treeScope.summary.total, 30)
  subject.windowRootIds = ['second-0']
  assert.deepEqual(subject.visibleAgents(), secondTree)
  assert.deepEqual(subject.visibleAgents('second-1'), [secondTree[1]])
  subject.windowRootIds = ['first-0']
  assert.equal(subject.visibleAgents(), first, 'returning to a tree reuses only that tree’s projection')
  subject.windowRootIds = ['first-0', 'second-0']
  const overview = subject.visibleAgents()
  const byId = new Map(overview.map(agent => [agent.id, agent]))
  assert.deepEqual(['first-0', 'second-0'].map(id => byId.get(id).treeScope.summary.total), [30, 3])
  const selected = new Set([...firstTree, ...secondTree].map(agent => agent.id)), represented = new Set()
  for (const agent of overview) for (const id of subject._scopeModel().branch(agent.id)) {
    assert.ok(selected.has(id), 'real nodes and embedded groups cannot pull in an unselected tree')
    represented.add(id)
  }
  assert.deepEqual(represented, selected)
  assert.equal(subject.visibleAgents(), overview, 'the expanded forest retains its own stable cache entry')
  assert.deepEqual(agents, original)
})

test('context size gets an independent projection decision instead of reusing medium geometry', () => {
  const subject = graph(fleet(4), { cardSize: 'small', zoomHost: { clientWidth: 1000, clientHeight: 900 } })
  const mini = subject.visibleAgents()
  assert.equal(subject._projection.folded, false)
  subject.cardSize = 'large'
  const large = subject.visibleAgents()
  assert.equal(subject._projection.folded, true)
  assert.notEqual(large, mini)
  subject.cardSize = 'small'
  assert.equal(subject.visibleAgents(), mini)
})

test('link selection shows only selected real tree heads and returns to the previous projection afterwards', () => {
  const agents = [...fleet(30, 'first'), ...fleet(3, 'second'), ...fleet(40, 'outside')]
  const subject = graph(agents, { windowRootIds: ['first-0', 'second-0'] })
  const before = subject.visibleAgents()
  subject._linkMode = true
  const heads = subject.visibleAgents('first-2')
  assert.deepEqual(heads.map(agent => agent.id), ['first-0', 'second-0'])
  assert.ok(heads.every(agent => agent.treeScope.group === false && agent.treeScope.expandable === false))
  assert.deepEqual(heads.map(agent => agent.treeScope.summary.total), [30, 3])
  subject._linkMode = false
  assert.equal(subject.visibleAgents(), before)
})

test('legacy graphs outside the smart workspace preserve their original full-fleet behavior', () => {
  const agents = fleet(20), original = structuredClone(agents)
  const subject = graph(agents, { smartScope: false, zoomHost: { clientWidth: 1200, clientHeight: 150 } })
  assert.deepEqual(subject.visibleAgents(), agents)
  assert.equal(subject._projectionMemory, undefined, 'generic graph callers do not enter the new adaptive policy')
  assert.deepEqual(agents, original)
})

test('pan boundaries retain a reachable portion of the actual box forest at distant and close zoom', () => {
  const subject = graph([])
  subject.nodes = new Map([
    ['one', { id: 'one', x: 800, y: 500, agent: { id: 'one' }, el: { hidden: false } }],
    ['two', { id: 'two', x: 1400, y: 700, agent: { id: 'two' }, el: { hidden: false } }],
  ])
  subject.emptySlots = new Map()
  for (const zoom of [0.1, 0.5, 1, 2.4]) for (const sign of [-1, 1]) {
    Object.assign(subject, { zoom, panX: sign * 1e6, panY: sign * 1e6 })
    const bounds = subject._contentBox()
    subject._clampPan()
    const left = subject.panX + bounds.x * zoom, right = left + bounds.w * zoom
    const top = subject.panY + bounds.y * zoom, bottom = top + bounds.h * zoom
    const retainedWidth = Math.min(160, bounds.w * zoom), retainedHeight = Math.min(160, bounds.h * zoom)
    assert.ok(right >= retainedWidth - 1e-9 && left <= subject.zoomHost.clientWidth - retainedWidth + 1e-9)
    assert.ok(bottom >= retainedHeight - 1e-9 && top <= subject.zoomHost.clientHeight - retainedHeight + 1e-9)
    assert.ok(Number.isFinite(subject.panX) && Number.isFinite(subject.panY))
  }
})
