/* THE PANEL'S PICKER LISTS TREES, AND THE AGENTS UNDER EACH. Owner, 2026-09-19:
 * "the top button instead of listing every agent or all agents, it should just
 * list trees or all trees, then, from the drop down you can select the agent to
 * chat right there from the list immediately."
 *
 * These call the pure half (src/home-activity.js treePickGroups) with values:
 * rows as the panel holds them and tree records as the view resolves them from
 * the fleet tree store. Nothing here pins the view's markup.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { treePickGroups, treePickChoices, TREE_PICK } from '../../src/home-activity.js'
import { TREE_CHOICE_PREFIX, agentFilterFor } from '../../src/home-circle-action.js'

const CONTROL = { id: 't-ctl', name: 'Control lane', active: true, tipKey: 'ctl', memberKeys: ['w1', 'ctl', 'w2'] }
const DELIVERY = { id: 't-del', name: 'Delivery lane', active: false, tipKey: 'del', memberKeys: ['del', 'd1'] }
const TREES = [DELIVERY, CONTROL]
const ROWS = [
  { agentKey: 'w1', agentName: 'worker one', working: true },
  { agentKey: 'ctl', agentName: 'controller', working: false },
  { agentKey: 'ctl', agentName: 'controller', working: false },
  { agentKey: 'w2', agentName: 'worker two', working: false },
  { agentKey: 'del', agentName: 'deliverer', working: false },
  { agentKey: 'orphan', agentName: 'orphan run', working: true },
]

test('all trees leads, then one group per tree by name, then the agents in no tree', () => {
  const groups = treePickGroups(ROWS, TREES)
  assert.deepEqual(groups.map(group => group.kind), ['all', 'tree', 'tree', 'loose'])
  assert.equal(groups[0].id, '', 'the whole view is the empty choice, as it always was')
  assert.equal(groups[0].label, TREE_PICK.allTrees)
  assert.deepEqual(groups.slice(1, 3).map(group => group.name), ['Control lane', 'Delivery lane'])
  assert.equal(groups[1].id, `${TREE_CHOICE_PREFIX}t-ctl`, 'a tree entry carries the id the filter already understands')
  assert.deepEqual(ROWS.filter(agentFilterFor(groups[1].id, TREES)).map(row => row.agentKey), ['w1', 'ctl', 'ctl', 'w2'])
})

test('a tree group is headed by how many agents it has and how many are working; its own entry is the plain name', () => {
  const [, control, delivery] = treePickGroups(ROWS, TREES)
  assert.equal(control.heading, 'Control lane · 3 agents, 1 working')
  assert.equal(delivery.heading, 'Delivery lane · 2 agents')
  assert.equal(control.label, 'Control lane', 'the closed control shows the entry, so the entry stays short')
  assert.equal(control.working, 1)
})

test('the agents under a tree lead with its tip, then by name, each once, and say when they are working', () => {
  const [, control, delivery] = treePickGroups(ROWS, TREES)
  assert.deepEqual(control.agents.map(agent => agent.id), ['ctl', 'w1', 'w2'])
  assert.deepEqual(control.agents.map(agent => agent.label), ['controller', 'worker one · working', 'worker two'])
  /* d1 is a member with no run yet: still listed, because the point of the
     list is to open a chat with it, and named by the record when a row cannot. */
  assert.deepEqual(delivery.agents.map(agent => agent.id), ['del', 'd1'])
  assert.equal(delivery.agents[1].label, 'd1')
})

test('an agent the store names but no row has run keeps the store name', () => {
  const [, , delivery] = treePickGroups(ROWS, [{ ...DELIVERY, memberNames: { d1: 'Delivery helper' } }, CONTROL])
  assert.equal(delivery.agents[1].label, 'Delivery helper')
})

test('a node the store says is live counts as working even before its row lands', () => {
  const [, , delivery] = treePickGroups(ROWS, [{ ...DELIVERY, liveKeys: ['d1'] }, CONTROL])
  assert.equal(delivery.heading, 'Delivery lane · 2 agents, 1 working')
  assert.equal(delivery.agents[1].working, true)
})

test('agents in no tree are grouped last, by name, and reachable', () => {
  const groups = treePickGroups(ROWS, TREES)
  const loose = groups.at(-1)
  assert.equal(loose.kind, 'loose')
  assert.equal(loose.label, TREE_PICK.loose)
  assert.deepEqual(loose.agents.map(agent => agent.id), ['orphan'])
  const flat = treePickChoices(groups)
  assert.ok(flat.some(choice => choice.id === 'orphan' && choice.kind === 'agent'))
})

test('with no trees at all the agents are one plain group and nothing claims a tree', () => {
  const groups = treePickGroups(ROWS, [])
  assert.deepEqual(groups.map(group => group.kind), ['all', 'loose'])
  assert.equal(groups[1].label, TREE_PICK.agents, 'not "Not in a tree" when there are no trees to be in')
  assert.deepEqual(groups[1].agents.map(agent => agent.id), ['ctl', 'del', 'orphan', 'w1', 'w2'])
})

test('the flat list is every selectable entry in menu order, and only those', () => {
  const flat = treePickChoices(treePickGroups(ROWS, TREES))
  assert.deepEqual(flat.map(choice => choice.id), ['', `${TREE_CHOICE_PREFIX}t-ctl`, 'ctl', 'w1', 'w2', `${TREE_CHOICE_PREFIX}t-del`, 'del', 'd1', 'orphan'])
  assert.deepEqual(flat.map(choice => choice.kind), ['all', 'tree', 'agent', 'agent', 'agent', 'tree', 'agent', 'agent', 'agent'])
})

test('an empty panel offers only the whole view', () => {
  assert.deepEqual(treePickGroups([], []).map(group => group.kind), ['all'])
  assert.equal(treePickChoices(treePickGroups([], [])).length, 1)
})
