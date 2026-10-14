import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { AGENT_ACTIONS, actionForTool, actionForLive, sampleAction, actionLabel, followedRow, agentChoices, followingActivityRow, homeActivityTone, homeAvatarToken } from '../../src/home-following.js'
import { agentMonogram, ACTIVITY_LABELS, ACTIVITY_MARKS } from '../../src/home-activity.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
const home = readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8')

test('tool names sort into reading, writing and running', () => {
  assert.equal(actionForTool('Read'), 'reading')
  assert.equal(actionForTool('Grep'), 'reading')
  assert.equal(actionForTool('web_search'), 'reading')
  assert.equal(actionForTool('Edit'), 'writing')
  assert.equal(actionForTool('apply_patch'), 'writing')
  assert.equal(actionForTool('write_file'), 'writing')
  assert.equal(actionForTool('Bash'), 'running')
  assert.equal(actionForTool(''), 'running')
  for (const word of ['reading', 'writing', 'running']) assert.ok(AGENT_ACTIONS.includes(word))
})

test('a live record answers with the engine\'s own activity, and says nothing when it has nothing', () => {
  assert.equal(actionForLive(null), null)
  assert.equal(actionForLive({ working: false, status: null }), null, 'no stream yet: the row decides')
  assert.equal(actionForLive({ working: false, status: 'completed' }), 'idle')
  assert.equal(actionForLive({ working: true, waiting: true }), 'waiting')
  assert.equal(actionForLive({ working: true, ended: true }), 'idle')
  assert.equal(actionForLive({ working: true, kind: 'thinking' }), 'thinking')
  assert.equal(actionForLive({ working: true, kind: 'call', tool: 'Read' }), 'reading')
  assert.equal(actionForLive({ working: true, kind: 'result', tool: 'Edit' }), 'writing')
  assert.equal(actionForLive({ working: true, kind: 'text' }), 'writing')
  assert.equal(actionForLive({ working: true }), 'running')
})

test('the example acts a scripted turn as its slot ages, one numbered event per tool call', () => {
  const atMs = 1_000_000, slot = 100_000
  const at = ms => sampleAction({ atMs }, atMs + ms, slot)
  assert.deepEqual(at(1_000), { action: 'thinking', event: 0, tool: '' })
  assert.deepEqual(at(17_000), { action: 'reading', event: 1, tool: 'Read' })
  assert.deepEqual(at(23_000), { action: 'reading', event: 2, tool: 'Grep' })
  assert.deepEqual(at(40_000), { action: 'thinking', event: 4, tool: '' })
  assert.deepEqual(at(47_000), { action: 'writing', event: 5, tool: 'Edit' })
  assert.deepEqual(at(70_000), { action: 'running', event: 8, tool: 'Bash' })
  assert.deepEqual(at(90_000), { action: 'writing', event: 10, tool: 'reply' })
  assert.equal(sampleAction({ at: new Date(atMs).toISOString() }, atMs + 1_000, slot).action, 'thinking', 'an ISO time also counts')
  assert.deepEqual(sampleAction({ at: 'nonsense' }, 5, slot), { action: 'running', event: 0, tool: '' })
  assert.equal(actionLabel('reading', 'Grep'), 'reading with Grep')
  assert.equal(actionLabel('writing', 'reply'), 'writing its reply')
  assert.equal(actionLabel('running', 'Bash'), 'running Bash')
  assert.equal(actionLabel('idle'), '')
})

test('the retained followedRow export follows the topmost run, including a recent completion ahead of older work', () => {
  const rows = [
    { agentKey: 'luna', agentName: 'luna-02', working: false, status: 'finished', updatedAt: 500 },
    { agentKey: 'claude', agentName: 'claude', working: true, status: 'working', updatedAt: 300 },
    { agentKey: 'codex', agentName: 'codex', working: true, status: 'working', updatedAt: 400 },
    { agentKey: 'terra', agentName: 'terra-01', working: false, status: 'attention', updatedAt: 900 },
  ]
  assert.equal(followedRow(rows).agentKey, 'luna', 'the first listed run wins without a working-state bias')
  assert.equal(followedRow(rows, 'luna').agentKey, 'luna', 'the picked agent even while idle')
  assert.equal(followedRow(rows, 'nobody'), null)
  assert.equal(followedRow(rows.filter(row => !row.working)).agentKey, 'luna', 'status does not reorder the selection')
  assert.equal(followedRow([]), null)
  assert.deepEqual(agentChoices(rows).map(choice => choice.label), ['All agents', 'claude', 'codex', 'luna-02', 'terra-01'])
  assert.equal(agentChoices([]).length, 1)
})

test('the real Home painter follows working, attention, then displayed order within the filter', () => {
  const row = (name, status = 'finished') => ({ agentKey: name, agentName: name, inScope: true, el: { hidden: false, dataset: { status }, toggleAttribute(key, value) { this[key] = value } } })
  const older = row('older'), newest = row('newest'), middle = row('middle')
  const c = vm.createContext({
    state: { sessions: { runs: [{ sequence: 3 }, { sequence: 2 }, { sequence: 1 }] } },
    runRows: new Map([[1, older], [2, middle], [3, newest]]), agentFilter: '', sample: false,
    /* The circle follows the first row the CHOICE keeps, and the choice is
       resolved to one predicate before the paint runs (views/home.js
       resolveChoice). With no selection that predicate keeps everything, which
       is what these order assertions are about. */
    keepForChoice: () => true,
    followedRow, actionForLive, actionLabel, sampleAction, followingActivityRow, homeActivityTone, homeAvatarToken, agentMonogram, ACTIVITY_LABELS, ACTIVITY_MARKS,
    destroyed: false, following: { dataset: {} }, oneLaneSelected: () => false, rosterLines: new Map(),
    followPerson: {}, followName: {}, followStatus: { dataset: {} }, followAction: {}, followEmpty: {}, followChat: {}, followChoose: {}, followAvatar: { style: {} },
  })
  vm.runInContext(declaredFunctionSource(home, 'paintFollowing'), c)
  c.paintFollowing()
  assert.equal(c.following.dataset.agentName, 'newest', 'map insertion order must not choose the oldest row')
  assert.equal(c.following.dataset.agentKey, 'newest')
  assert.equal(c.followPerson.hidden, false, 'a finished run still identifies the followed agent')
  middle.el.dataset.status = 'attention'
  c.paintFollowing()
  assert.equal(c.following.dataset.agentName, 'middle', 'owner attention outranks a more recent finished run')
  newest.working = true
  newest.liveRecord = { kind: 'text', working: true, tool: 'Edit' }
  c.paintFollowing()
  assert.equal(c.following.dataset.agentName, 'newest', 'observed work outranks owner attention')
  assert.equal(c.following.dataset.agentTool, 'reply', 'a prior tool name must not make a text reply look like tool use')
  assert.equal(c.followAction.textContent, 'writing its reply')
  newest.el.hidden = true
  c.paintFollowing()
  assert.equal(c.following.dataset.agentName, 'middle', 'the top remaining visible record is followed')
  /* FIX-C 5: an attention row that is not a permission wait (Did not start,
     Failed, Interrupted, Session ended ...) must not say "waiting for you"
     under its own chip; the line is empty and hidden instead. */
  assert.notEqual(c.following.dataset.agentAction, 'waiting', 'an attention row without a live wait claimed "waiting for you"')
  assert.equal(c.followAction.textContent, '')
  assert.equal(c.followAction.hidden, true, 'an empty action line must be hidden, not drawn blank')
  middle.liveRecord = { working: false, waiting: true }
  c.paintFollowing()
  assert.equal(c.following.dataset.agentAction, 'waiting', 'a live permission wait is still "waiting for you"')
  assert.equal(c.followAction.textContent, 'waiting for you')
  assert.equal(c.followAction.hidden, false)
  middle.liveRecord = null
  middle.el.hidden = true; older.el.hidden = true
  c.paintFollowing()
  assert.equal(c.following.dataset.agentName, '')
  assert.equal(c.following.dataset.agentKey, '')
})


test('Home status tones distinguish an actual failure without narrowing attention semantics', () => {
  for (const label of ['Failed', 'Did not start', 'Interrupted', 'The last turn failed']) assert.equal(homeActivityTone(label), 'error')
  for (const label of ['Needs approval', 'Needs attention', 'Needs you', 'Paused', 'Session ended', 'Turn ended']) assert.equal(homeActivityTone(label), 'attention')
  assert.equal(homeActivityTone('Working'), 'working')
  for (const label of ['Finished', 'Replied', 'Not recorded', 'Running', 'Starting', 'Started', 'unknown']) assert.equal(homeActivityTone(label), 'idle')
})

test('Home avatars stay in eight stable theme-token colors for arbitrary names', () => {
  const names = ['', 'Agent', 'Same', 'same', 'Unicode 春', ...Array.from({length: 80}, (_, i) => `Agent ${i}`)]
  const colors = names.map(homeAvatarToken)
  assert.equal(new Set(colors).size, 8)
  for (const name of names) {
    assert.equal(homeAvatarToken(name), homeAvatarToken(name))
    assert.ok(homeAvatarToken(name), 'each name receives a color')
  }
})
