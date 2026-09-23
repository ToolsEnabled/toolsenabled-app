import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AGENT_ACTIONS, actionForTool, actionForLive, sampleAction, actionLabel, followedRow, agentChoices } from '../../src/home-circle-action.js'

const home = readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8')
const fluid = readFileSync(new URL('../../src/home-circle-fluid.js', import.meta.url), 'utf8')

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

test('the circle follows the topmost run, including a recent completion ahead of older work', () => {
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

test('the page wires the dropdown, the two ring attributes and no braces', () => {
  assert.match(home, /<select class="home-agent-pick" data-home-agent/)
  assert.match(home, /ring\.el\.dataset\.agentAction = action/)
  assert.match(home, /ring\.el\.dataset\.agentName = name/)
  assert.match(home, /ring\.el\.dataset\.agentEvent = eventValue/)
  assert.match(home, /clockSlot\.append\(captionEl, digitsEl\)/, 'the timer lives in the header')
  assert.doesNotMatch(home, /BRACE_SVG|class="brace|pulseBraces/)
  assert.match(home, /live\.kind = activity\.kind/)
  assert.match(home, /live\.kind = 'text'/)
})

test('the fluid receives the actual action, identity and event inputs', () => {
  assert.match(fluid, /ring\.dataset\.agentAction/)
  assert.match(fluid, /ring\.dataset\.agentName/)
  assert.match(fluid, /ring\.dataset\.agentEvent/)
  assert.match(fluid, /import \{[^}]*\bactionMotion\b[^}]*\} from '\.\/home-circle-motion.js'/)
})
