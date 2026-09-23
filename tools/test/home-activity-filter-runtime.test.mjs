import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { activityMatches } from '../../src/home-activity.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const source = readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8')
const paint = ['agentNameFor', 'paintRunScope'].map(name => declaredFunctionSource(source, name)).join('\n')

function fixture({ expanded = false, status = 'attention' } = {}) {
  const rows = ['attention', 'finished', 'other'].map((kind, index) => ({
    agentKey: index === 1 ? 'second' : 'first', agentName: 'Agent',
    el: { hidden: false, dataset: { status: kind } }, unread: false,
    // The lane name is the control that follows that lane, so a row carries it.
    agent: { pressed: 'false', title: '', setAttribute(name, value) { if (name === 'aria-pressed') this.pressed = value } },
  }))
  const state = {
    takeoverSubject: expanded ? { kind: 'everything' } : null,
    coordinatorEmpty: {}, currentHomeView: { panel: { title: 'Activity' } }, panelTitle: {},
    agentFilter: '', activityFilter: status, runRows: new Map(rows.map((row, index) => [index, row])),
    /* The dropdown resolves to ONE predicate and ONE title before the paint
       runs (views/home.js resolveChoice), so the paint takes them rather than
       re-deciding what the selection means. The fixture resolves them the same
       way for the plain agent-key selections these tests use. */
    keepForChoice: row => !state.agentFilter || row.agentKey === state.agentFilter,
    scopeTitle: '', treeRecords: [], takeoverChoices: () => [],
    oneLaneSelected: () => Boolean(state.agentFilter),
    state: { sessions: { runs: rows.map((_, sequence) => ({ sequence })) } },
    conversations: new Map(), subjectMatchesRun: () => true, activityMatches,
    scopeEmpty: {}, threadBundle: { hidden: true }, readerSentence: text => text,
    paintActivityOverview() {}, paintGlance() {}, paintAgentPick() {}, paintCircleAction() {}, paintAgentBoard() {}, paintPanelMode() {},
  }
  vm.createContext(state)
  vm.runInContext(paint, state)
  return { state, rows, render: () => state.paintRunScope() }
}

test('compact and expanded activity filters hide nonmatching rows', () => {
  for (const expanded of [false, true]) {
    const f = fixture({ expanded })
    f.render()
    assert.deepEqual(f.rows.map(row => row.el.hidden), [false, true, true], `expanded=${expanded}`)
    f.state.activityFilter = 'all'
    f.render()
    assert.deepEqual(f.rows.map(row => row.el.hidden), [false, false, false])
  }
})

test('compact empty filters explain how to recover and retain agent scope', () => {
  const f = fixture({ status: 'working' })
  f.render()
  assert.equal(f.state.scopeEmpty.hidden, false)
  assert.match(f.state.scopeEmpty.textContent, /All runs/)
  f.state.activityFilter = 'all'
  f.state.agentFilter = 'second'
  f.render()
  assert.deepEqual(f.rows.map(row => row.el.hidden), [true, false, true])
  assert.equal(f.state.scopeEmpty.hidden, true)
})

/* Following a lane is a state of its name on every row, not only of the picker
   above the list, so a person can see which lane the panel is scoped to from
   the rows themselves. */
test('scoping to a lane marks that lane’s name on its rows and clears the others', () => {
  const f = fixture({ status: 'all' })
  f.render()
  assert.deepEqual(f.rows.map(row => row.agent.pressed), ['false', 'false', 'false'])
  f.state.agentFilter = 'second'
  f.render()
  assert.deepEqual(f.rows.map(row => row.agent.pressed), ['false', 'true', 'false'])
  assert.deepEqual(f.rows.map(row => row.el.hidden), [true, false, true], 'and the panel shows only that lane')
  assert.match(f.rows[1].agent.title, /Press to show every lane again/)
  assert.match(f.rows[0].agent.title, /^Show only /)
  f.state.agentFilter = ''
  f.render()
  assert.deepEqual(f.rows.map(row => row.agent.pressed), ['false', 'false', 'false'])
})
