import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { agentBoardLines, treePickGroups, activityStatus } from '../../src/home-activity.js'
import { glanceFigures, glanceLiveTreeRows, homeOverviewMarkup, homeGlanceMarkup } from '../../src/home-overview.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

test('the At-a-glance figures count current agents while Runs recorded includes anonymous history', () => {
  const rows = [
    { agentKey: 'claude', working: true, status: 'working' },
    { agentKey: 'claude', working: false, status: 'finished' },
    { agentKey: 'codex', working: false, status: 'attention' },
    { agentKey: '', working: false, status: 'attention' },
    { agentKey: 'luna', working: true, status: 'working' },
  ]
  const result = glanceFigures(rows)
  assert.deepEqual(result.figures, { agents: 3, runs: 5, working: 2, attention: 1 })
  assert.deepEqual(result.states, { working: true, attention: true })
  assert.equal(result.shown, true)
})

test('an idle fleet carries no colour, and no runs means no strip', () => {
  const idle = glanceFigures([{ agentKey: 'a', working: false, status: 'finished' }])
  assert.deepEqual(idle.states, { working: false, attention: false })
  assert.equal(idle.shown, true)
  for (const empty of [[], undefined, null, [null]]) {
    const result = glanceFigures(empty)
    assert.deepEqual(result.figures, { agents: 0, runs: 0, working: 0, attention: 0 })
    assert.equal(result.shown, false, `no strip for ${JSON.stringify(empty)}`)
  }
})

test('last-seen running records do not become a claim of current work', () => {
  const result = glanceFigures([
    { agentKey: 'stale', working: true, status: 'other' },
    { agentKey: 'active', working: true, status: 'working' },
    { agentKey: 'done', working: true, status: 'finished' },
  ])
  assert.equal(result.figures.working, 1)
  assert.equal(glanceFigures([{ agentKey: 'stale', working: true, status: 'other' }]).states.working, false)
})

test('the strip markup carries one slot per figure and starts hidden', () => {
  const markup = homeOverviewMarkup() + homeGlanceMarkup()
  for (const key of ['runs', 'working', 'attention']) {
    assert.match(markup, new RegExp(`data-glance="${key}"`), `a slot for ${key}`)
    assert.match(markup, new RegExp(`data-glance-tile="${key}"`), `a tile for ${key}`)
  }
  assert.match(markup, /data-glance-tile="ledger"/)
  assert.match(markup, /data-glance-ledger/)
  assert.match(readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8'), /data-glance="agents"/, 'agents with activity is retained in Activity metadata')
  assert.match(markup, /<section class="home-glance" data-home-glance[^>]*\shidden>/)
})


test('a later finished run clears an older attention state without erasing run history', () => {
  const rows = [
    { computerId: 'one', agentKey: 'worker', atMs: 100, status: 'attention' },
    { computerId: 'one', agentKey: 'worker', atMs: 200, status: 'finished' },
    { computerId: 'one', agentKey: 'other', atMs: 150, status: 'attention' },
  ]
  assert.deepEqual(glanceFigures(rows).figures, { agents: 2, runs: 3, working: 0, attention: 1 })
  assert.equal(glanceFigures(rows.slice(0, 2)).states.attention, false)
})

test('the same agent name on another computer cannot clear attention or merge identities', () => {
  const result = glanceFigures([
    { computerId: 'two', agentKey: 'worker', atMs: 200, status: 'finished' },
    { computerId: 'one', agentKey: 'worker', atMs: 100, status: 'attention' },
  ])
  assert.deepEqual(result.figures, { agents: 2, runs: 2, working: 0, attention: 1 })
})

test('latest unknown state does not revive an old refusal and observed concurrent work takes precedence', () => {
  assert.equal(glanceFigures([
    { agentKey: 'a', status: 'other' }, { agentKey: 'a', status: 'attention' },
  ]).figures.attention, 0)
  const active = glanceFigures([
    { agentKey: 'a', status: 'attention' }, { agentKey: 'a', status: 'working' },
    { agentKey: 'a', status: 'working' }, { agentKey: '', status: 'attention' },
  ])
  assert.deepEqual(active.figures, { agents: 1, runs: 4, working: 1, attention: 0 })
})

test('one computer and agent with a recorded run plus repeated live keys counts once', () => {
  const live = glanceLiveTreeRows([{ computerId: 'computer-one', liveKeys: ['agent-a', 'agent-a'] }])
  const result = glanceFigures([
    { computerId: 'computer-one', agentKey: 'agent-a', status: 'finished' },
  ], live)
  assert.deepEqual(result.figures, { agents: 1, runs: 1, working: 1, attention: 0 })
})

test('the same agent key on two computers is two current agents', () => {
  const live = glanceLiveTreeRows([
    { computerId: 'computer-one', liveKeys: ['agent-a'] },
    { computerId: 'computer-two', liveKeys: ['agent-a'] },
  ])
  const result = glanceFigures([], live)
  assert.deepEqual(result.figures, { agents: 2, runs: 0, working: 2, attention: 0 })
  assert.equal(result.shown, true)
})

test('when a live member disappears, its historical result remains without a new run', () => {
  const rows = [
    { computerId: 'computer-one', agentKey: 'agent-a', status: 'finished', atMs: 20 },
  ]
  const live = glanceFigures(rows, [
    { computerId: 'computer-one', agentKey: 'agent-a', status: 'working' },
  ])
  const historical = glanceFigures(rows, [])
  assert.deepEqual(live.figures, { agents: 1, runs: 1, working: 1, attention: 0 })
  assert.deepEqual(historical.figures, { agents: 1, runs: 1, working: 0, attention: 0 })
  assert.equal(historical.shown, true)
})

const homeViewSource = readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8')

function paintGlanceFixture({ treeRecords = null, runs = [], runRows = new Map() } = {}) {
  treeRecords ||= [{
    id: 'this-computer:tree-running',
    computerId: 'this-computer',
    name: 'Running tree',
    active: true,
    tipKey: 'ghost',
    memberKeys: ['ghost'],
    memberNames: { ghost: 'Ghost' },
    liveKeys: ['ghost'],
    memberRoles: { ghost: 'builder' },
    memberSaved: { ghost: { status: 'draft', message: '', reply: '', note: '' } },
  }]
  const values = Object.fromEntries(['agents', 'runs', 'working', 'attention']
    .map(key => [key, { textContent: '0' }]))
  const glance = { dataset: {}, hidden: true }
  const context = createContext({
    root: { querySelector() { return null } },
    glanceFigures,
    glanceLiveTreeRows,
    state: { sessions: { runs } },
    runRows,
    glanceValues: values,
    glance,
    sample: false,
    treeRecords,
  })
  const paintGlance = runInContext(
    `(${declaredFunctionSource(homeViewSource, 'paintGlance')})`,
    context,
  )
  return { treeRecords, values, glance, paintGlance }
}

test('the existing paintGlance producer includes a live tree member before its first run', () => {
  const { treeRecords, values, glance, paintGlance } = paintGlanceFixture()
  const board = agentBoardLines([], treePickGroups([], treeRecords), { showAll: true })
  assert.equal(board.working, 1, 'the actual Home board sees the live tree member')
  paintGlance()
  assert.equal(values.agents.textContent, '1')
  assert.equal(values.runs.textContent, '0', 'a live tree member is not a recorded run')
  assert.equal(values.working.textContent, '1')
  assert.equal(values.attention.textContent, '0')
  assert.equal(glance.hidden, false)
})

test('tree liveness supersedes refused history in the actual board and glance', () => {
  const run = { sequence: 7 }
  const parts = {
    agentKey: 'ghost',
    computerId: 'this-computer',
    working: false,
    el: { dataset: { status: 'attention' } },
    runRecord: { atMs: 100 },
  }
  const { treeRecords, values, paintGlance } = paintGlanceFixture({
    runs: [run],
    runRows: new Map([[run.sequence, parts]]),
  })
  const rows = [{
    agentKey: 'ghost',
    agentName: 'Ghost',
    working: false,
    status: 'attention',
    statusLabel: 'Did not start',
    doing: '',
    when: '1 minute ago',
    atMs: 100,
    brief: 'A refused run.',
    tool: '',
    events: 0,
    asked: '',
    answer: '',
    why: 'The run was refused.',
    gap: '',
  }]
  const board = agentBoardLines(rows, treePickGroups(rows, treeRecords), { showAll: true })
  paintGlance()
  assert.deepEqual({ working: board.working, attention: board.attention }, { working: 1, attention: 0 })
  assert.deepEqual({
    working: Number(values.working.textContent),
    attention: Number(values.attention.textContent),
  }, { working: 1, attention: 0 })
  assert.equal(values.runs.textContent, '1')
})

test('current waiting and ended rows agree without a tree-working override', () => {
  const treeRecords = [{
    id: 'this-computer:tree-idle',
    computerId: 'this-computer',
    name: 'Idle tree',
    active: false,
    tipKey: 'ghost',
    memberKeys: ['ghost'],
    memberNames: { ghost: 'Ghost' },
    liveKeys: [],
    memberRoles: { ghost: 'builder' },
    memberSaved: { ghost: { status: 'draft', message: '', reply: '', note: '' } },
  }]
  for (const [sequence, liveState] of [[8, { waiting: true }], [9, { ended: true }]]) {
    const status = activityStatus(null, null, liveState).kind
    assert.equal(status, 'attention')
    const run = { sequence }
    const parts = {
      agentKey: 'ghost',
      computerId: 'this-computer',
      working: false,
      el: { dataset: { status } },
      runRecord: { atMs: 100 },
    }
    const { values, paintGlance } = paintGlanceFixture({
      treeRecords,
      runs: [run],
      runRows: new Map([[sequence, parts]]),
    })
    const rows = [{
      agentKey: 'ghost',
      agentName: 'Ghost',
      working: false,
      status,
      statusLabel: 'Needs attention',
      doing: '',
      when: '1 minute ago',
      atMs: 100,
      brief: '',
      tool: '',
      events: 0,
      asked: '',
      answer: '',
      why: '',
      gap: '',
    }]
    const board = agentBoardLines(rows, treePickGroups(rows, treeRecords), { showAll: true })
    paintGlance()
    assert.deepEqual({ working: board.working, attention: board.attention }, { working: 0, attention: 1 }, JSON.stringify(liveState))
    assert.deepEqual({
      working: Number(values.working.textContent),
      attention: Number(values.attention.textContent),
    }, { working: 0, attention: 1 }, JSON.stringify(liveState))
    assert.equal(values.runs.textContent, '1')
  }
})

test('restart, first work, stop and relaunch keep saved membership separate from observed activity', () => {
  const tree = {
    id: 'tree-one', computerId: 'computer-one', name: 'Saved tree',
    memberKeys: ['ready', 'failed', 'stopped'], liveKeys: [],
    memberSaved: { ready: { status: 'draft' }, failed: { status: 'failed' }, stopped: { status: 'finished' } },
  }
  const before = agentBoardLines([], treePickGroups([], [tree]), { showAll: true })
  assert.equal(before.agents, 3)
  assert.equal(before.attention, 1)
  assert.deepEqual(glanceFigures([], glanceLiveTreeRows([tree])).figures,
    { agents: 0, runs: 0, working: 0, attention: 0 })
  tree.liveKeys = ['ready']
  assert.deepEqual(glanceFigures([], glanceLiveTreeRows([tree])).figures,
    { agents: 1, runs: 0, working: 1, attention: 0 })
  const runs = [{ agentKey: 'ready', computerId: 'computer-one', status: 'finished', atMs: 10 }]
  for (const records of [[{ ...tree, liveKeys: [] }], JSON.parse(JSON.stringify([{ ...tree, liveKeys: [] }]))]) {
    assert.deepEqual(glanceFigures(runs, glanceLiveTreeRows(records)).figures,
      { agents: 1, runs: 1, working: 0, attention: 0 })
    assert.equal(agentBoardLines(runs, treePickGroups(runs, records), { showAll: true }).agents, 3)
  }
})
