/* WATCHING BY TREE (T401) — the option list and the predicate, called with
 * values. Owner: "we have all agents, we have each tree as a single option,
 * then we have ALL TREES but this shows just the tip of the tree when its
 * active so like controller or whatevers at the top."
 *
 * These assert BEHAVIOUR: what comes back for given rows and given trees, and
 * which rows a predicate keeps. Nothing here pins a spelling, an order of
 * declarations or an implementation detail, so a better implementation of the
 * same behaviour passes unchanged.
 *
 * The tree facts are produced by the view from the fleet tree store
 * (node.treeId for membership, store.rootOf for the tip, treeStatus for
 * active). This file is the pure half and takes them as plain records.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agentChoices, agentFilterFor, followedRowFor, treeEntries,
  ALL_AGENTS_CHOICE, TREE_TIPS_CHOICE, treeChoiceId,
} from '../../src/home-circle-action.js'

/* Two trees, as the hand test asks for: one active with a clear tip, one not.
   `orphan` belongs to no tree -- a run started outside the fleet trees, which
   is also every run in the example fleet. */
const CONTROLLER = { id: 't-ctl', name: 'Controller tree', active: true, tipKey: 'ctl', memberKeys: ['ctl', 'w1', 'w2'] }
const ARCHIVE = { id: 't-arc', name: 'Archive tree', active: false, tipKey: 'arc', memberKeys: ['arc', 'a1'] }
const TREES = [CONTROLLER, ARCHIVE]

const ROWS = [
  { agentKey: 'ctl', agentName: 'controller' },
  { agentKey: 'w1', agentName: 'worker one' },
  { agentKey: 'w2', agentName: 'worker two' },
  { agentKey: 'arc', agentName: 'archivist' },
  { agentKey: 'a1', agentName: 'archive helper' },
  { agentKey: 'orphan', agentName: 'orphan run' },
]
const kept = (choiceId, trees = TREES, rows = ROWS) => rows.filter(agentFilterFor(choiceId, trees)).map(row => row.agentKey)

test('the list offers every agent, then one option per tree, then all trees', () => {
  const choices = agentChoices(ROWS, TREES)
  assert.equal(choices[0].kind, 'all', 'every agent comes first')
  const kinds = choices.map(choice => choice.kind)
  const firstTree = kinds.indexOf('tree')
  const tips = kinds.indexOf('tips')
  const firstAgent = kinds.indexOf('agent')
  assert.ok(firstTree > 0, 'a tree option is offered')
  assert.ok(tips > firstTree, 'all-trees comes after the individual trees')
  assert.ok(firstAgent > tips, 'the individual agents come after')
  assert.deepEqual(
    choices.filter(choice => choice.kind === 'tree').map(choice => choice.label),
    ['Archive tree', 'Controller tree'],
    'trees are ordered by name, both of them, active or not',
  )
})

test('picking a tree shows that tree and nothing else', () => {
  assert.deepEqual(kept(treeChoiceId('t-ctl')), ['ctl', 'w1', 'w2'])
  assert.deepEqual(kept(treeChoiceId('t-arc')), ['arc', 'a1'],
    'an inactive tree is still selectable; only ALL TREES is bounded by active')
})

test('all trees shows the tip of each ACTIVE tree and nothing else', () => {
  /* The point of the view, in the owner's words: monitoring top-level agents.
     So it is the tips, not the members, and not the inactive tree's tip. */
  assert.deepEqual(kept(TREE_TIPS_CHOICE), ['ctl'])
  const bothActive = [CONTROLLER, { ...ARCHIVE, active: true }]
  assert.deepEqual(kept(TREE_TIPS_CHOICE, bothActive), ['ctl', 'arc'])
})

test('all trees is not offered when no tree is active', () => {
  const idle = TREES.map(tree => ({ ...tree, active: false }))
  assert.equal(agentChoices(ROWS, idle).some(choice => choice.kind === 'tips'), false,
    'an option that can only ever come back empty is a trap, not a view')
  assert.equal(agentChoices(ROWS, TREES).some(choice => choice.kind === 'tips'), true)
})

test('every agent still shows the runs that belong to no tree', () => {
  assert.deepEqual(kept(ALL_AGENTS_CHOICE), ROWS.map(row => row.agentKey),
    'a run outside the fleet trees must stay reachable rather than vanish')
  assert.ok(kept(treeChoiceId('t-ctl')).includes('orphan') === false)
})

test('with no trees at all the list is what it was before', () => {
  /* The example fleet carries no fleet trees, so this is the shape the owner
     sees on the demo: every agent, then the agents. Nothing tree-shaped. */
  const choices = agentChoices(ROWS, [])
  assert.deepEqual(choices.map(choice => choice.kind), ['all', ...ROWS.map(() => 'agent')])
  assert.deepEqual(kept(ALL_AGENTS_CHOICE, []), ROWS.map(row => row.agentKey))
})

test('a selection that no longer names a tree shows everything rather than nothing', () => {
  assert.deepEqual(kept(treeChoiceId('t-deleted')), ROWS.map(row => row.agentKey),
    'a stale selection must not empty the panel with no way back')
  assert.deepEqual(kept(TREE_TIPS_CHOICE, []), ROWS.map(row => row.agentKey))
})

test('a tree with no members is not offered', () => {
  const empty = [{ id: 't-empty', name: 'Empty tree', active: true, tipKey: null, memberKeys: [] }]
  assert.deepEqual(treeEntries(empty), [])
  assert.equal(agentChoices(ROWS, empty).some(choice => choice.kind === 'tree'), false)
})

test('the circle follows the first row the choice keeps', () => {
  assert.equal(followedRowFor(ROWS, TREE_TIPS_CHOICE, TREES).agentKey, 'ctl')
  assert.equal(followedRowFor(ROWS, treeChoiceId('t-arc'), TREES).agentKey, 'arc')
  assert.equal(followedRowFor(ROWS, ALL_AGENTS_CHOICE, TREES).agentKey, 'ctl')
  assert.equal(followedRowFor([], TREE_TIPS_CHOICE, TREES), null)
})

test('a single agent is still selectable by its own key', () => {
  assert.deepEqual(kept('w2'), ['w2'])
  assert.deepEqual(kept('orphan'), ['orphan'])
})

test('malformed records are survived rather than thrown on', () => {
  assert.doesNotThrow(() => agentChoices(ROWS, [null, {}, { id: 't', memberKeys: null }]))
  assert.doesNotThrow(() => agentFilterFor(null, null)(null))
  assert.equal(agentFilterFor(null, null)({ agentKey: 'x' }), true)
})
