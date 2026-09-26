import test from 'node:test'
import assert from 'node:assert/strict'
import { glanceFigures, homeOverviewMarkup, homeGlanceMarkup } from '../../src/home-overview.js'

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
  for (const key of ['agents', 'runs', 'working', 'attention']) {
    assert.match(markup, new RegExp(`data-glance="${key}"`), `a slot for ${key}`)
    assert.match(markup, new RegExp(`data-glance-tile="${key}"`), `a tile for ${key}`)
  }
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
