/* THREE STATES PER TOOL, THE UPGRADE OF AN ACCOUNT THAT HAS TWO, AND THE
 * CEILING NEITHER OF THEM MAY LIFT.
 *
 * The owner asked for enabled / permissions required / disabled. The row that
 * existed was an array of the names switched OFF, which cannot hold a third
 * answer. So this suite pins the three things that make the new one real:
 *
 *   1. THE MODEL HOLDS THREE VALUES and round-trips them.
 *   2. AN EXISTING CUSTOMER'S CHOICES SURVIVE. Every name in the old off-array
 *      comes back as disabled and everything else as enabled -- and the new row
 *      wins the moment it exists, so an upgrade cannot be undone by the row it
 *      replaced.
 *   3. THE PERMISSION LEVEL IS A CEILING. Nothing an answer here can say makes
 *      a tool more available than the level allows.
 *
 * AND THE TWO COPIES OF THE MODEL AGREE. The renderer half is an ES module and
 * the enforcement half is CommonJS; they cannot import one another. Both are
 * loaded here and driven over one fixture table, so a change made to one and
 * not the other is a red test rather than a page and a session start quietly
 * disagreeing about what a person chose.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  TOOL_STATES,
  TOOL_STATES_KEY,
  TOOLS_DISABLED_KEY,
  composeToolSurface,
  parseToolStates,
  serializeToolStates,
  toolState,
  withToolState,
} from '../../src/agent-tool-states.js'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shell = require_(path.join(REPO, 'shell', 'agent-tool-states.cjs'))

const row = states => JSON.stringify({ version: 1, states })

test('the three states are the owner’s three, and the row holds all of them', () => {
  assert.deepEqual(TOOL_STATES, ['enabled', 'ask', 'disabled'])
  const stored = row({ 'host.exec': 'ask', 'browser.stop': 'disabled', 'memory.get': 'enabled' })
  const parsed = parseToolStates(stored, null)
  assert.equal(parsed.ok, true)
  assert.equal(toolState(parsed.states, 'host.exec'), 'ask',
    'the middle state did not survive a round trip; the row is two-valued again')
  assert.equal(toolState(parsed.states, 'browser.stop'), 'disabled')
  assert.equal(toolState(parsed.states, 'memory.get'), 'enabled')
  assert.equal(toolState(parsed.states, 'a.tool.nobody.decided.about'), 'enabled',
    'a tool nobody has answered for must be on, which is what an untouched installation already has')
})

test('a state a person sets is the state that is stored, and a default clears the row', () => {
  let states = {}
  states = withToolState(states, 'host.exec', 'ask')
  states = withToolState(states, 'browser.stop', 'disabled')
  const stored = serializeToolStates(states)
  assert.equal(parseToolStates(stored, null).states['host.exec'], 'ask')

  states = withToolState(states, 'host.exec', 'enabled')
  states = withToolState(states, 'browser.stop', 'enabled')
  assert.equal(serializeToolStates(states), null,
    'an account back at every default must remove the row rather than store an empty one')
})

/* ---------- 2. THE UPGRADE ---------- */

test('an account that recorded disabled tools keeps every one of them', () => {
  /* The exact value the old drawer wrote: a JSON array of the names switched
     off, and the row absent when nothing was. */
  const legacy = JSON.stringify(['host.exec', 'browser.stop'])
  const parsed = parseToolStates(null, legacy)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.migrated, true, 'the upgrade was not reported, so the old row would never be cleared')
  assert.equal(toolState(parsed.states, 'host.exec'), 'disabled', 'a tool this customer switched off came back on')
  assert.equal(toolState(parsed.states, 'browser.stop'), 'disabled', 'a tool this customer switched off came back on')
  assert.equal(toolState(parsed.states, 'memory.get'), 'enabled',
    'a tool the customer never switched off must stay on; the upgrade may not narrow anything')
  assert.deepEqual(Object.keys(parsed.states).sort(), ['browser.stop', 'host.exec'],
    'the upgrade invented an answer for a tool nobody decided about')
})

test('an account with no answers at all upgrades to no answers at all', () => {
  const parsed = parseToolStates(null, null)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.migrated, false)
  assert.deepEqual(parsed.states, {})
})

test('the new row wins over the old one, so an upgrade cannot be undone by it', () => {
  const legacy = JSON.stringify(['host.exec'])
  const stored = row({ 'browser.stop': 'ask' })
  const parsed = parseToolStates(stored, legacy)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.migrated, false)
  assert.equal(toolState(parsed.states, 'host.exec'), 'enabled',
    'the old array switched a tool off again after the person had switched it back on')
  assert.equal(toolState(parsed.states, 'browser.stop'), 'ask')
})

test('a row that cannot be read fails closed with a code, and never with a guess', () => {
  for (const [label, stored, legacy] of [
    ['damaged text', '{not json', null],
    ['an array where a map belongs', JSON.stringify(['host.exec']), null],
    ['a state that is not one of the three', row({ 'host.exec': 'maybe' }), null],
    ['a damaged old row', null, '{not json'],
    ['an old row that is not a list of names', null, JSON.stringify({ 'host.exec': true })],
  ]) {
    const parsed = parseToolStates(stored, legacy)
    assert.equal(parsed.ok, false, `${label} was accepted rather than refused`)
    assert.equal(parsed.code, 'AGENT_TOOL_LIMITS_UNREADABLE', `${label} answered the wrong code`)
    assert.equal(Object.keys(parsed).sort().join(','), 'code,ok', 'a refusal carries the code and nothing else')
  }
})

/* ---------- 3. THE CEILING, AND WHAT EACH STATE COMPOSES TO ---------- */

const TOOLS = Object.freeze([
  Object.freeze({ name: 'memory.get', allowed: true, gated: false }),
  Object.freeze({ name: 'host.exec', allowed: true, gated: true }),
  Object.freeze({ name: 'drive.upload', allowed: true, gated: false }),
  Object.freeze({ name: 'browser.stop', allowed: true, gated: true }),
  Object.freeze({ name: 'screen.capture', allowed: false, gated: false }),
])

test('each state composes to its own answer, and the middle one splits honestly', () => {
  const surface = composeToolSurface(TOOLS, {
    'host.exec': 'ask',
    'drive.upload': 'ask',
    'browser.stop': 'disabled',
  })
  assert.deepEqual([...surface.allowed].sort(), ['host.exec', 'memory.get'],
    'a tool set to ask that this program can gate must stay available')
  assert.deepEqual([...surface.asking], ['host.exec'])
  assert.deepEqual([...surface.heldBack], ['drive.upload'],
    'a tool set to ask that nothing gates must be held back rather than handed over ungated')
  assert.deepEqual([...surface.off], ['browser.stop'])
  assert.deepEqual([...surface.withheld], ['screen.capture'])
  assert.ok(!surface.allowed.includes('drive.upload'),
    'a tool nobody can ask about was handed to the session anyway')
})

test('the permission level is a ceiling no answer here can lift', () => {
  for (const state of TOOL_STATES) {
    const surface = composeToolSurface(TOOLS, { 'screen.capture': state })
    assert.ok(!surface.allowed.includes('screen.capture'),
      `answering "${state}" made a tool the level withholds available`)
    assert.ok(surface.withheld.includes('screen.capture'),
      `answering "${state}" hid a withheld tool instead of naming it`)
  }
})

test('every tool off composes to an empty surface, which the caller has to refuse', () => {
  const surface = composeToolSurface(TOOLS, Object.fromEntries(TOOLS.map(tool => [tool.name, 'disabled'])))
  assert.equal(surface.allowed.length, 0,
    'an empty allowlist is read by the engine as the FULL surface, so this state must be reachable and refused')
})

/* ---------- 4. THE TWO COPIES AGREE ---------- */

test('the enforcement half and the page half answer identically', () => {
  assert.deepEqual(shell.TOOL_STATES, TOOL_STATES)
  assert.equal(shell.TOOL_STATES_KEY, TOOL_STATES_KEY)
  assert.equal(shell.TOOLS_DISABLED_KEY, TOOLS_DISABLED_KEY)

  const cases = [
    [null, null],
    [null, JSON.stringify(['host.exec', 'browser.stop'])],
    [row({ 'host.exec': 'ask', 'browser.stop': 'disabled' }), JSON.stringify(['drive.upload'])],
    [row({ 'memory.get': 'enabled' }), null],
    ['{not json', null],
    [row({ 'host.exec': 'maybe' }), null],
    [null, JSON.stringify({ 'host.exec': true })],
  ]
  let compared = 0
  for (const [stored, legacy] of cases) {
    const mine = parseToolStates(stored, legacy)
    const theirs = shell.parseToolStates(stored, legacy)
    assert.deepEqual(JSON.parse(JSON.stringify(theirs)), JSON.parse(JSON.stringify(mine)),
      `the two copies of the model disagree on ${String(stored)} / ${String(legacy)}`)
    if (mine.ok) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(shell.composeToolSurface(TOOLS, theirs.states))),
        JSON.parse(JSON.stringify(composeToolSurface(TOOLS, mine.states))),
        'the two copies compose different tool surfaces from one stored answer',
      )
    }
    compared += 1
  }
  assert.equal(compared, cases.length)
  assert.ok(compared >= 7, 'the comparison went inert')
})
