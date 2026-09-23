/* WATCHING BY TREE — THE WIRING, not the helper.
 *
 * tools/test/home-tree-pick.test.mjs calls the pure list builder with values
 * and home-tree-filter.test.mjs the predicate. This runs the REAL
 * resolveChoice, paintAgentPick and paintRunScope out of src/views/home.js in
 * a VM, the way home-activity-filter-runtime.test.mjs already does, so that
 * what is checked is the code the app runs rather than a second copy of the
 * logic written in a test.
 *
 * Owner, 2026-09-19: "the top button instead of listing every agent or all
 * agents, it should just list trees or all trees, then, from the drop down you
 * can select the agent to chat right there from the list immediately."
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { activityMatches, treePickGroups, treePickChoices } from '../../src/home-activity.js'
import { agentFilterFor, TREE_TIPS_CHOICE, treeChoiceId } from '../../src/home-circle-action.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const source = readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8')
const resolveChoice = declaredFunctionSource(source, 'resolveChoice')
const paintAgentPick = declaredFunctionSource(source, 'paintAgentPick')
const paintRunScope = ['agentNameFor', 'paintRunScope'].map(name => declaredFunctionSource(source, name)).join('\n')

/* One active tree with a clear tip, one inactive, plus a run belonging to
   neither. */
const TREES = [
  { id: 'box:ctl', name: 'Controller tree', active: true, tipKey: 'ctl', memberKeys: ['ctl', 'w1'] },
  { id: 'box:arc', name: 'Archive tree', active: false, tipKey: 'arc', memberKeys: ['arc'] },
]
const LANES = [
  { agentKey: 'ctl', agentName: 'controller' },
  { agentKey: 'w1', agentName: 'worker one', working: true },
  { agentKey: 'arc', agentName: 'archivist' },
  { agentKey: 'loose', agentName: 'loose run' },
]

/* The select's children as the view builds them: a plain option, or an
   optgroup holding options. Flattened for the assertions. */
const flatten = children => children.flatMap(child => child.tag === 'optgroup' ? child.children : [child])

function fixture({ trees = TREES, lanes = LANES, remembered = '' } = {}) {
  const children = []
  const rows = lanes.map(lane => ({
    ...lane, inScope: true,
    el: { hidden: false, dataset: { status: 'finished' } }, unread: false,
    agent: { pressed: 'false', title: '', setAttribute(name, value) { if (name === 'aria-pressed') this.pressed = value } },
  }))
  const state = {
    // the one seam that reads the fleet tree store
    treeFilterRecords: () => trees,
    treeRecords: [],
    treePickGroups, treePickChoices, agentFilterFor, treeChoiceId, TREE_TIPS_CHOICE, TREE_CHOICE_PREFIX: 'tree:',
    COPY: { treeTipsTitle: 'Every tree, top level', treeScopeTitle: name => name || 'This tree' },
    agentFilter: remembered,
    remembered: [],
    rememberAgentPick() { state.remembered.push(state.agentFilter) },
    keepForChoice: () => true,
    scopeTitle: '',
    oneLaneSelected() { return Boolean(state.agentFilter) && state.agentFilter !== TREE_TIPS_CHOICE && !state.agentFilter.startsWith('tree:') },
    agentPickSignature: '',
    agentPick: {
      value: '', hidden: false,
      replaceChildren(...next) { children.length = 0; children.push(...next) },
    },
    document: {
      createElement: tag => tag === 'optgroup'
        ? { tag, label: '', children: [], append(...nodes) { this.children.push(...nodes) } }
        : { tag, value: '', textContent: '', dataset: {} },
    },
    takeoverSubject: null,
    runRows: new Map(rows.map((row, index) => [index, row])),
    state: { sessions: { runs: rows.map((_, sequence) => ({ sequence })) } },
    conversations: new Map(),
    subjectMatchesRun: () => true,
    activityMatches, activityFilter: 'all',
    coordinatorEmpty: {}, currentHomeView: { panel: { title: 'Activity' } }, panelTitle: {},
    scopeEmpty: {}, threadBundle: { hidden: true }, readerSentence: text => text,
    paintActivityOverview() {}, paintGlance() {}, paintCircleAction() {}, paintAgentBoard() {}, paintPanelMode() {},
  }
  vm.createContext(state)
  vm.runInContext(resolveChoice, state)
  vm.runInContext(paintAgentPick, state)
  vm.runInContext(paintRunScope, state)
  return {
    state, rows, children,
    build: () => state.paintAgentPick(),
    labels: () => flatten(children).map(option => option.textContent),
    groups: () => children.filter(child => child.tag === 'optgroup').map(group => ({ label: group.label, entries: group.children.map(option => option.textContent) })),
    choose: id => { state.agentFilter = id; state.resolveChoice(); state.paintRunScope() },
    visible: () => rows.filter(row => !row.el.hidden).map(row => row.agentKey),
  }
}

test('the dropdown the view builds is all trees, then each tree with its agents under it, then the loose agents', () => {
  const f = fixture()
  f.build()
  assert.equal(f.children[0].textContent, 'All trees', 'the whole view leads, and it is not called All agents')
  assert.equal(f.children[0].value, '')
  assert.deepEqual(f.groups(), [
    { label: 'Archive tree · 1 agent', entries: ['Archive tree', 'archivist'] },
    { label: 'Controller tree · 2 agents, 1 working', entries: ['Controller tree', 'controller', 'worker one · working'] },
    { label: 'Not in a tree', entries: ['loose run'] },
  ])
  assert.ok(!f.labels().includes('All agents'), 'All agents is gone')
  assert.ok(!f.state.agentPick.hidden, 'and the control is on screen')
})

test('choosing a tree from its group shows that tree and names it', () => {
  const f = fixture()
  f.build()
  f.choose(treeChoiceId('box:ctl'))
  assert.deepEqual(f.visible(), ['ctl', 'w1'])
  assert.equal(f.state.panelTitle.textContent, 'Controller tree')
  assert.deepEqual(f.rows.map(row => row.agent.pressed), ['false', 'false', 'false', 'false'],
    'a tree is not a lane, so no row claims to be followed')
})

test('choosing an agent from under its tree scopes to that agent and marks it followed', () => {
  const f = fixture()
  f.build()
  f.choose('w1')
  assert.deepEqual(f.visible(), ['w1'])
  assert.equal(f.rows[1].agent.pressed, 'true')
  assert.equal(f.state.oneLaneSelected(), true, 'and the view treats it as one lane, which is what opens the chat')
})

test('going back to all trees restores the runs a tree hid, including the loose one', () => {
  const f = fixture()
  f.build()
  f.choose(treeChoiceId('box:arc'))
  assert.deepEqual(f.visible(), ['arc'])
  f.choose('')
  assert.deepEqual(f.visible(), ['ctl', 'w1', 'arc', 'loose'])
  assert.equal(f.state.panelTitle.textContent, 'Activity', 'and the panel goes back to its own title')
})

test('with no trees the agents are one plain group under all trees', () => {
  const f = fixture({ trees: [] })
  f.build()
  assert.equal(f.children[0].textContent, 'All trees')
  assert.deepEqual(f.groups(), [{ label: 'Agents', entries: ['archivist', 'controller', 'loose run', 'worker one · working'] }])
  f.choose('')
  assert.deepEqual(f.visible(), ['ctl', 'w1', 'arc', 'loose'])
})

test('a remembered choice survives an empty list and is dropped only once the list has entries', () => {
  const empty = fixture({ lanes: [], trees: [], remembered: 'ghost' })
  empty.build()
  assert.equal(empty.state.agentFilter, 'ghost', 'nothing to check against yet, so nothing is forgotten')
  assert.deepEqual(empty.state.remembered, [])
  assert.equal(empty.state.agentPick.hidden, true)
  const full = fixture({ remembered: 'ghost' })
  full.build()
  assert.equal(full.state.agentFilter, '', 'named nothing on this screen')
  assert.deepEqual(full.state.remembered, [''], 'and the memory is corrected, not left stale')
  const kept = fixture({ remembered: 'w1' })
  kept.build()
  assert.equal(kept.state.agentFilter, 'w1')
  assert.equal(kept.state.agentPick.value, 'w1')
})

test('the first paint scopes to a remembered choice rather than the paint after it', () => {
  const f = fixture({ remembered: treeChoiceId('box:ctl') })
  f.state.paintRunScope()
  assert.deepEqual(f.visible(), ['ctl', 'w1'])
  assert.equal(f.state.panelTitle.textContent, 'Controller tree')
})
