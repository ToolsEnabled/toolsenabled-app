import assert from 'node:assert/strict'
import test from 'node:test'
import { TreeScope } from '../../src/tree-scope.js'

const fleet = (count, fanout = count) => Array.from({ length: count }, (_, i) => ({
  id: `agent-${i}`, name: `Agent ${i}`, parentId: i ? `agent-${Math.floor((i - 1) / fanout)}` : null,
  state: ['running', 'finished', 'interrupted', 'draft'][i % 4],
}))

test('the complete 20-agent starting layout is preserved', () => {
  const agents = fleet(20, 6)
  assert.deepEqual(new TreeScope(agents).project(), agents)
})

for (const fanout of [1, 8, 1000]) {
  test(`every agent in a 1000-agent tree remains reachable with fanout ${fanout}`, () => {
    const agents = fleet(1000, fanout), original = structuredClone(agents)
    const scope = new TreeScope(agents)
    const seen = new Set(), visited = new Set(), pending = [null]
    while (pending.length) {
      const root = pending.pop()
      assert.ok(!visited.has(root), 'exploring a branch must make progress')
      visited.add(root)
      const view = scope.project(root)
      assert.ok(view.length <= 21, 'each level must stay manageable')
      for (const agent of view) {
        if (!agent.treeScope?.group) seen.add(agent.id)
        if (agent.treeScope?.expandable) pending.push(agent.id)
      }
    }
    assert.equal(seen.size, 1000)
    assert.deepEqual(agents, original, 'grouping must not rewrite the actual tree')
  })
}

test('group context counts the full stack, including hidden descendants', () => {
  const scope = new TreeScope(fleet(1000, 8))
  assert.deepEqual(scope.summary('agent-0'), { total: 1000, working: 250, review: 250, finished: 250 })
  const groups = scope.project().filter(agent => agent.treeScope?.group)
  assert.equal(groups.reduce((total, agent) => total + agent.treeScope.summary.total, 0), 999)
  const covered = groups.flatMap(group => scope.branch(group.id))
  assert.equal(new Set(covered).size, 999, 'no descendants count twice')
})

test('open groups follow status changes, removals, and moves to another tree', () => {
  const agents = fleet(100), scope = new TreeScope(agents)
  const group = scope.project().find(agent => agent.treeScope?.group)
  const members = scope.branch(group.id)
  const changed = agents.filter(agent => agent.id !== members[0]).map(agent =>
    agent.id === members[1] ? { ...agent, parentId: null } : { ...agent, state: 'finished' })
  scope.update(changed)
  assert.equal(scope.branch(group.id).includes(members[0]), false)
  assert.equal(scope.branch(group.id).includes(members[1]), false)
  assert.equal(scope.summary(group.id).finished, members.length - 2)
})

test('a large forest, including malformed cycles, remains reachable', () => {
  const agents = fleet(30).map(agent => ({ ...agent, parentId: null }))
  agents[0].parentId = agents[1].id
  agents[1].parentId = agents[0].id
  const scope = new TreeScope(agents)
  const overview = scope.project()
  const represented = new Set(overview.flatMap(agent => scope.branch(agent.id)))
  assert.equal(represented.size, 30)
})

test('declared hierarchy edges participate in grouping and ancestry', () => {
  const agents = fleet(30).map(agent => ({ ...agent, parentId: null }))
  const edges = agents.slice(1).map(agent => ({ from: 'agent-0', to: agent.id, type: 'manages' }))
  const scope = new TreeScope(agents, edges)
  const group = scope.project().find(agent => agent.treeScope?.group)
  assert.equal(scope.ancestry(group.id)[0].id, 'agent-0')
  assert.equal(scope.summary('agent-0').total, 30)
})

/* T1401 (with T1239): every tree count a person reads says "1 agent", never
   "1 agents" -- group cards, the branch summary, the branch badge, the
   Explore button's accessible name and the removal sentences share one rule. */
test('tree counts are singular for one and plural otherwise', async () => {
  const scope = await import('../../src/tree-scope.js')
  assert.equal(typeof scope.countNoun, 'function', 'one shared plural helper')
  assert.deepEqual([0, 1, 2].map(n => scope.countNoun(n, 'agent')), ['0 agents', '1 agent', '2 agents'])
  assert.deepEqual([0, 1, 2].map(n => scope.countNoun(n, 'descendant')), ['0 descendants', '1 descendant', '2 descendants'])
  assert.match(scope.branchSummaryText({ total: 1 }), /^1 agent in this branch/)
  assert.match(scope.branchSummaryText({ total: 2 }), /^2 agents in this branch/)
  const { branchRemovalConfirmation } = await import('../../src/tree-node-removal.js')
  assert.match(branchRemovalConfirmation('Controller (3a5f460c)', 2), /Controller \(3a5f460c\) and the 1 agent below it \(2 agents total\)/)
  assert.match(branchRemovalConfirmation('Manager', 4), /Manager and all 3 agents below it \(4 agents total\)/)
})
