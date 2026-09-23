import assert from 'node:assert/strict'
import test from 'node:test'
import { TreeScope } from '../../src/tree-scope.js'
import { layoutBoxTree, TREE_BOX, TREE_CONTEXT_SIZES } from '../../src/tree-box-layout.js'
import { chooseTreeProjection } from '../../src/tree-readability.js'

const fleet = (count, fanout = count, prefix = 'agent') => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}-${index}`, name: `${prefix} ${index}`,
  parentId: index ? `${prefix}-${Math.floor((index - 1) / fanout)}` : null,
  treeNode: { treeId: prefix, status: ['draft', 'running', 'finished', 'interrupted'][index % 4] },
}))

function screenshotFleet() {
  const node = (id, parentId, treeId) => ({ id, name: id, parentId, treeNode: { treeId, status: 'draft' } })
  return [
    node('Controller', null, 'workspace'),
    ...Array.from({ length: 5 }, (_, i) => node(`Builder ${i}`, 'Controller', 'workspace')),
    node('Manager', 'Controller', 'workspace'),
    ...Array.from({ length: 11 }, (_, i) => node(`Worker ${i}`, 'Manager', 'workspace')),
    node('Reviewer', null, 'review'), node('Review builder', 'Reviewer', 'review'),
  ]
}

test('narrow box branches retain named children before placing the remainder in one group', () => {
  const agents = fleet(12), original = structuredClone(agents)
  for (const contextSize of ['small', 'medium', 'large']) {
    const scope = new TreeScope(agents)
    const result = chooseTreeProjection({ scope, contextSize, W: 875, H: 860 })
    const children = result.agents.filter(agent => agent.parentId === 'agent-0')
    const real = children.filter(agent => !agent.treeScope.group)
    const groups = children.filter(agent => agent.treeScope.group)
    assert.ok(real.length >= 1, `${contextSize}: the branch does not become only anonymous groups`)
    assert.equal(groups.length, 1, `${contextSize}: one overflow represents the remaining siblings`)
    const represented = [...real.map(agent => agent.id), ...scope.branch(groups[0].id)]
    assert.equal(new Set(represented).size, represented.length, 'real and grouped siblings never overlap')
    assert.deepEqual(new Set(represented), new Set(agents.slice(1).map(agent => agent.id)))
    assert.equal(result.agents.find(agent => agent.id === 'agent-0').treeScope.summary.total, 12)
    assert.equal(result.agents.find(agent => agent.id === 'agent-0').treeScope.hidden, 11 - real.length)
  }
  assert.deepEqual(agents, original, 'the view never rewrites the saved hierarchy')
})

for (const nodeStyle of ['circles', 'boxes']) {
  test(`${nodeStyle}: the narrow reference opens the small review tree while preserving full 18/2 context`, () => {
    const result = chooseTreeProjection({ scope: new TreeScope(screenshotFleet()), nodeStyle, W: 752, H: 800 })
    assert.equal(result.folded, true)
    assert.ok(result.fitScale < result.minScale)
    const byId = new Map(result.agents.map(agent => [agent.id, agent]))
    assert.equal(byId.get('Controller').treeScope.summary.total, 18)
    assert.ok(byId.get('Controller').treeScope.hidden > 0)
    assert.deepEqual(byId.get('Reviewer').treeScope, {
      summary: { total: 2, working: 0, review: 0, finished: 0 }, hidden: 0, group: false, expandable: false,
    })
    assert.equal(byId.get('Review builder').parentId, 'Reviewer')
    assert.equal(byId.get('Review builder').treeScope.hidden, 0)
    assert.ok(result.agents.length > 2, 'one dense tree must not fold its small neighbour')
  })

  test(`${nodeStyle}: a readable complete branch stays literal even inside a much larger fleet`, () => {
    const selected = fleet(3, 1, 'selected')
    const scope = new TreeScope([...selected, ...fleet(200, 8, 'elsewhere')])
    const result = chooseTreeProjection({ scope, rootId: 'selected-0', nodeStyle, W: 1200, H: 1600 })
    assert.equal(result.folded, false)
    assert.deepEqual(result.agents, selected)
    assert.ok(result.fitScale >= result.minScale)
    assert.equal(result.branchesPerLevel, null)
  })

  test(`${nodeStyle}: height can require a fold without any change to width or agent count`, () => {
    const scope = new TreeScope(fleet(7, 1))
    const tall = chooseTreeProjection({ scope, nodeStyle, W: 1200, H: 4000 })
    const short = chooseTreeProjection({ scope, nodeStyle, W: 1200, H: 400 })
    assert.equal(tall.folded, false)
    assert.equal(short.folded, true)
    assert.ok(short.agents.length < tall.agents.length)
    assert.ok(short.fitScale < short.minScale)
  })

  test(`${nodeStyle}: excluded trees and communication links do not consume the selected forest's space`, () => {
    const selected = screenshotFleet(), unrelated = fleet(40, 3, 'unrelated')
    const original = structuredClone([...selected, ...unrelated])
    const rootIds = ['Controller', 'Reviewer']
    const isolated = chooseTreeProjection({ scope: new TreeScope(selected), nodeStyle, W: 752, H: 800 })
    const scope = new TreeScope([...selected, ...unrelated], [
      { from: 'Controller', to: 'Reviewer', type: 'communication' },
      { from: 'Reviewer', to: 'unrelated-0', type: 'communication' },
    ])
    const filtered = chooseTreeProjection({ scope, rootIds, nodeStyle, W: 752, H: 800 })
    assert.deepEqual(filtered, isolated)
    assert.deepEqual(scope.agents, original)
    assert.deepEqual(rootIds, ['Controller', 'Reviewer'])
  })

  test(`${nodeStyle}: declared hierarchy has the same readability cost as stored parent IDs`, () => {
    const parented = fleet(20, 3)
    const detached = parented.map(agent => ({ ...agent, parentId: null }))
    const edges = parented.filter(agent => agent.parentId).map(agent => ({ from: agent.parentId, to: agent.id, type: 'manages' }))
    const direct = chooseTreeProjection({ scope: new TreeScope(parented), nodeStyle, W: 900, H: 700 })
    const declared = chooseTreeProjection({ scope: new TreeScope(detached, edges), nodeStyle, W: 900, H: 700 })
    assert.equal(declared.fitScale, direct.fitScale)
    assert.equal(declared.folded, direct.folded)
    assert.equal(declared.branchesPerLevel, direct.branchesPerLevel)
    assert.deepEqual(declared.agents.map(agent => [agent.id, agent.treeScope?.summary]),
      direct.agents.map(agent => [agent.id, agent.treeScope?.summary]))
  })
}

test('the same seven boxes can fit as a narrow deep tree while a broad tree needs embedding', () => {
  const narrow = chooseTreeProjection({ scope: new TreeScope(fleet(7, 1)), nodeStyle: 'boxes', W: 1200, H: 4000 })
  const broad = chooseTreeProjection({ scope: new TreeScope(fleet(7)), nodeStyle: 'boxes', W: 1200, H: 4000 })
  assert.equal(narrow.folded, false)
  assert.equal(broad.folded, true)
  assert.ok(narrow.fitScale > broad.fitScale)
})

test('folding and unfolding use separate thresholds measured against the full candidate', () => {
  const nodes = fleet(21), scope = new TreeScope(nodes)
  const layout = layoutBoxTree({ nodes, W: 800, H: 3000 })
  const xs = [...layout.slots.values()].map(point => point.x)
  const fullWidth = Math.max(...xs) - Math.min(...xs) + TREE_BOX.width
  const minScale = chooseTreeProjection({ scope, nodeStyle: 'boxes', W: 800, H: 3000 }).minScale
  const choose = (ratio, previousFolded) => chooseTreeProjection({
    scope, nodeStyle: 'boxes', W: 20 + fullWidth * minScale * ratio, H: 3000, previousFolded,
  })
  assert.equal(choose(0.99).folded, true, 'a new view uses the neutral readability threshold')
  assert.equal(choose(1.01).folded, false)
  assert.equal(choose(0.95, false).folded, false, 'small decreases preserve an already open view')
  assert.equal(choose(0.89, false).folded, true, 'a substantial decrease folds the view')
  assert.equal(choose(1.05, true).folded, true, 'a folded view waits for enough extra room before reopening')
  assert.equal(choose(1.11, true).folded, false)
  assert.equal(choose(1.05, true).fitScale, choose(1.05, false).fitScale,
    'folding cannot change the geometry used to decide whether to unfold')
})

test('the coarse projection keeps the greatest fanout that fits its actual box bounds', () => {
  const scope = new TreeScope(fleet(100))
  for (const [W, expected] of [[1800, 5], [1200, 4], [752, 2]]) {
    const result = chooseTreeProjection({ scope, nodeStyle: 'boxes', W, H: 900 })
    assert.equal(result.folded, true)
    assert.equal(result.branchesPerLevel, expected)
    assert.ok(result.agents.length >= expected + 1, 'later readable expansions can improve the coarse frontier')
    if (expected < 5) {
      const next = scope.project(null, { collapseAt: 0, detailLimit: 0, branchesPerLevel: expected + 1 })
      const layout = layoutBoxTree({ nodes: next, W, H: 900 })
      const xs = [...layout.slots.values()].map(point => point.x)
      const width = Math.max(...xs) - Math.min(...xs) + TREE_BOX.width
      assert.ok((W - 20) / width < result.minScale, 'the next coarse fanout would exceed the available width')
    }
  }
  assert.equal(chooseTreeProjection({ scope, nodeStyle: 'boxes', W: 200, H: 100 }).branchesPerLevel, 2,
    'a smaller pane still has a navigable two-branch fallback')
})

test('compensated box text permits a complete readable view with more than ten real agents', () => {
  const agents = fleet(16), scope = new TreeScope(agents)
  const layout = layoutBoxTree({ nodes: agents, W: 800, H: 1500 })
  const xs = [...layout.slots.values()].map(point => point.x)
  const width = Math.max(...xs) - Math.min(...xs) + TREE_BOX.width
  const result = chooseTreeProjection({ scope, W: 20 + width * 0.76, H: 1500 })
  assert.equal(result.minScale, 0.72)
  assert.ok(result.fitScale > result.minScale && result.fitScale < 0.82,
    'this complete view occupies the newly usable geometry range')
  assert.equal(result.folded, false)
  assert.deepEqual(result.agents, agents, 'agent count alone never introduces embedding')
})

test('the current wide twenty-agent fleet exposes more real names at the compensated box scale', () => {
  const agents = screenshotFleet()
  const medium = chooseTreeProjection({ scope: new TreeScope(agents), W: 1796, H: 948 })
  assert.ok(medium.agents.length > 7, 'the previous seven-node Medium overview makes use of the extra room')
  assert.ok(medium.agents.filter(agent => !agent.treeScope.group).length >= 7,
    'additional space exposes actual agents rather than extra wrapper nodes')
  const scope = new TreeScope(agents)
  const mini = chooseTreeProjection({ scope, W: 1796, H: 948, contextSize: 'small' })
  const firstLevel = [
    'Controller', ...Array.from({ length: 5 }, (_, i) => `Builder ${i}`), 'Manager', 'Reviewer', 'Review builder',
  ]
  assert.deepEqual(mini.agents.filter(agent => firstLevel.includes(agent.id)).map(agent => agent.id), firstLevel)
  assert.ok(mini.agents.filter(agent => firstLevel.includes(agent.id)).every(agent => !agent.treeScope.group))
  const shown = new Set(mini.agents.map(agent => agent.id)), parents = new Set(mini.agents.map(agent => agent.parentId))
  const represented = mini.agents.flatMap(agent => parents.has(agent.id) ? [agent.id] : scope.branch(agent.id))
  assert.equal(represented.length, agents.length, 'visible agents and their hidden frontiers represent each saved agent exactly once')
  assert.deepEqual(new Set(represented), new Set(agents.map(agent => agent.id)))
  assert.equal(mini.agents.find(agent => agent.id === 'Manager').treeScope.hidden,
    scope.branch('Manager').filter(id => !shown.has(id)).length)
})

test('additional Mini room opens a deeper frontier while preserving every real first-level name', () => {
  const agents = screenshotFleet(), original = structuredClone(agents), scope = new TreeScope(agents)
  const result = chooseTreeProjection({ scope, nodeStyle: 'boxes', contextSize: 'small', W: 1900, H: 948 })
  const firstLevel = [
    'Controller', ...Array.from({ length: 5 }, (_, i) => `Builder ${i}`), 'Manager', 'Reviewer', 'Review builder',
  ]
  assert.deepEqual(result.agents.filter(agent => firstLevel.includes(agent.id)).map(agent => agent.id), firstLevel)
  assert.ok(result.agents.filter(agent => firstLevel.includes(agent.id)).every(agent => !agent.treeScope.group))
  const groups = result.agents.filter(agent => agent.treeScope.group)
  assert.ok(result.agents.length > 10, 'a ten-node frontier is not a product limit')
  assert.ok(groups.every(agent => agent.parentId === 'Manager' && agent.treeScope.expandable))
  const workerFrontier = result.agents.filter(agent => agent.parentId === 'Manager').flatMap(agent => scope.branch(agent.id))
  assert.equal(workerFrontier.length, 11, 'additional real workers and overflow groups never duplicate a descendant')
  assert.deepEqual(new Set(workerFrontier),
    new Set(Array.from({ length: 11 }, (_, i) => `Worker ${i}`)))
  const shown = new Set(result.agents.map(agent => agent.id)), parents = new Set(result.agents.map(agent => agent.parentId))
  const represented = result.agents.flatMap(agent => parents.has(agent.id) ? [agent.id] : scope.branch(agent.id))
  assert.equal(represented.length, agents.length)
  assert.deepEqual(new Set(represented), new Set(agents.map(agent => agent.id)))
  assert.equal(result.agents.find(agent => agent.id === 'Manager').treeScope.hidden,
    scope.branch('Manager').filter(id => !shown.has(id)).length)
  assert.equal(result.agents.find(agent => agent.id === 'Manager').treeScope.expandable, false,
    'the displayed children now own deeper exploration')
  assert.deepEqual(agents, original)
})

test('inline group expansion exposes real members without retaining an extra wrapper or hierarchy row', () => {
  const scope = new TreeScope(screenshotFleet())
  const result = chooseTreeProjection({ scope, nodeStyle: 'boxes', W: 1796, H: 948 })
  const byId = new Map(result.agents.map(agent => [agent.id, agent]))
  assert.ok(result.agents.filter(agent => !agent.treeScope.group).length >= 5)
  for (const id of ['Builder 0', 'Builder 1']) assert.equal(byId.get(id).parentId, 'Controller')
  for (const agent of result.agents) {
    assert.ok(!agent.parentId || byId.has(agent.parentId), 'every visible edge lands on a visible parent')
    if (agent.treeScope.group) assert.ok(!result.agents.some(child => child.parentId === agent.id),
      'expanded synthetic wrappers are replaced by their members')
    const hidden = scope.branch(agent.id).filter(id => !byId.has(id)).length
    assert.equal(agent.treeScope.hidden, hidden, 'ancestor context updates as real descendants become visible')
    assert.deepEqual(agent.treeScope.summary, scope.summary(agent.id))
  }
  assert.deepEqual(chooseTreeProjection({ scope, nodeStyle: 'boxes', W: 1796, H: 948, previousFolded: true }), result,
    'the same viewport and fold state reproduce the same frontier')
})

test('every admitted progressive box frontier fits its actual rectangular bounds at the readability floor', () => {
  for (const contextSize of ['small', 'medium', 'large']) for (const [W, H] of [[1200, 800], [1796, 948], [2400, 1400]]) {
    const scope = new TreeScope(screenshotFleet())
    const result = chooseTreeProjection({ scope, nodeStyle: 'boxes', contextSize, W, H })
    const layout = layoutBoxTree({ nodes: result.agents, contextSize, W, H })
    const points = [...layout.slots.values()]
    const box = TREE_CONTEXT_SIZES[contextSize].box
    const width = Math.max(...points.map(point => point.x)) - Math.min(...points.map(point => point.x)) + box.width
    const height = Math.max(...points.map(point => point.y)) - Math.min(...points.map(point => point.y)) + box.height
    const scale = Math.min((W - 20) / width, (H - 20) / height)
    assert.ok(scale + 1e-9 >= result.minScale, `${contextSize} at ${W}×${H} fits without unreadable text`)
  }
})

test('progressive exploration has a bounded frontier even when a roomy canvas can expose many more agents', () => {
  const scope = new TreeScope(fleet(1000, 1))
  let projects = 0
  const project = scope.project.bind(scope)
  scope.project = (...args) => { projects++; return project(...args) }
  const result = chooseTreeProjection({ scope, nodeStyle: 'boxes', W: 100000, H: 100000 })
  assert.equal(result.agents.length, 80)
  assert.equal(result.folded, true)
  assert.equal(result.agents.filter(agent => agent.treeScope.expandable).length, 1)
  assert.ok(projects < 165, 'a single settled viewport cannot trigger unbounded projection work')
})

for (const fanout of [1, 8, 1000]) {
  test(`adaptive box projections keep all 1000 agents reachable with fanout ${fanout}`, () => {
    const agents = fleet(1000, fanout), original = structuredClone(agents)
    const scope = new TreeScope(agents), expected = new Set(agents.map(agent => agent.id))
    const pending = [null], visited = new Set(), seen = new Set()
    while (pending.length) {
      const rootId = pending.pop()
      assert.equal(visited.has(rootId), false, 'opening an embedded branch must progress')
      visited.add(rootId)
      const result = chooseTreeProjection({ scope, rootId, nodeStyle: 'boxes', W: 1200, H: 800 })
      assert.ok(result.agents.length > 0)
      assert.ok(result.agents.length <= 80)
      for (const agent of result.agents) {
        if (!agent.treeScope?.group) seen.add(agent.id)
        if (agent.treeScope) {
          const represented = scope.branch(agent.id).map(id => scope.byId.get(id))
          const summary = { total: represented.length, working: 0, review: 0, finished: 0 }
          for (const member of represented) {
            if (member.treeNode.status === 'running') summary.working++
            if (member.treeNode.status === 'finished') summary.finished++
            if (member.treeNode.status === 'interrupted') summary.review++
          }
          assert.deepEqual(agent.treeScope.summary, summary, 'context includes all hidden descendants')
        }
        if (agent.treeScope?.expandable) pending.push(agent.id)
      }
    }
    assert.deepEqual(seen, expected)
    assert.deepEqual(agents, original, 'adaptive views never change the saved hierarchy or state')
  })
}

test('empty, missing, and tiny viewports produce finite answers without inventing agents', () => {
  const empty = chooseTreeProjection({ scope: new TreeScope([]), W: 0, H: 0 })
  assert.deepEqual(empty.agents, [])
  assert.equal(empty.folded, false)
  assert.ok(Number.isFinite(empty.fitScale))
  const scope = new TreeScope(fleet(1))
  for (const dimensions of [{ W: 0, H: 0 }, { W: NaN, H: Infinity }]) {
    const result = chooseTreeProjection({ scope, ...dimensions })
    assert.deepEqual(result.agents.map(agent => agent.id), ['agent-0'])
    assert.ok(Number.isFinite(result.fitScale))
    assert.equal(result.folded, false, 'a lone agent has no hidden descendants to fold')
  }
})
