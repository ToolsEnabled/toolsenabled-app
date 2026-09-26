/* THE STANDING GOAL'S OWN RULES (T61), tested by calling them with values.
 *
 * Nothing here reads the source of anything. Every assertion is "given this
 * input, what does the product DO", so a better implementation of the same
 * behaviour passes and a reinstated defect fails -- which is the property that
 * matters, because the defect being closed here is a product that ACCEPTED a
 * goal and then did nothing with it.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const goal = require(resolve(import.meta.dirname, '..', '..', 'shell', 'session-goal.cjs'))
import { GOAL_BRIEF_MAX_BYTES, GOAL_OBJECTIVE_MAX_BYTES } from '../../src/slash-commands.js'

/* THE ONE DUPLICATED NUMBER IN THIS FEATURE, GATED.
 *
 * The renderer is ESM and the host is CJS and this package shares no module
 * between them, so the objective bound is written twice on purpose. A bound
 * written twice is a bound that can be changed once: raise it in the renderer
 * alone and a person is allowed to type an objective the host then refuses,
 * AFTER the send, with a message about a limit the screen never mentioned.
 * This reads both real modules and requires the two to agree, so editing one
 * and not the other is what goes red rather than what ships. */
test('the renderer and the host bound a goal objective at the same number', () => {
  assert.equal(GOAL_OBJECTIVE_MAX_BYTES, goal.GOAL_MAX_OBJECTIVE_BYTES,
    'the screen refuses before the send and the host refuses after it; they must refuse the same strings')
  assert.equal(GOAL_OBJECTIVE_MAX_BYTES, GOAL_BRIEF_MAX_BYTES,
    'one typed string opens a queue item and sets a goal, so it gets one bound')
})

test('a goal is made from what the person typed, trimmed, and starts active with nothing self-started yet', () => {
  const made = goal.makeGoal('   ship the release notes  ')
  assert.equal(made.objective, 'ship the release notes')
  assert.equal(made.status, 'active')
  assert.equal(made.continuations, 0, 'a goal that has started no turns of its own must not claim to have')
  assert.equal(goal.makeGoal('   '), null, 'whitespace is not an objective')
  assert.equal(goal.makeGoal(''), null)
  assert.equal(goal.makeGoal(null), null)
})

test('an active goal wants a continuation and a settled one never does', () => {
  assert.equal(goal.goalWantsContinuation(goal.makeGoal('x')), true)
  for (const status of ['paused', 'achieved', 'blocked']) {
    assert.equal(
      goal.goalWantsContinuation(goal.makeGoal('x', { status })),
      false,
      `a ${status} goal must not start another turn on its own`,
    )
  }
  assert.equal(goal.goalWantsContinuation(null), false, 'no goal is not a reason to start a turn')
  assert.equal(goal.goalWantsContinuation(undefined), false)
})

test('an active goal keeps working beyond the former eight-turn boundary', () => {
  for (const continuations of [8, 9, 100]) {
    const active = goal.makeGoal('x', { continuations })
    assert.equal(goal.goalWantsContinuation(active), true,
      `continuation ${continuations} must not be an implicit Goal ending`)
  }
  for (const status of ['paused', 'achieved', 'blocked']) {
    assert.equal(goal.goalWantsContinuation(goal.makeGoal('x', { status, continuations: 100 })), false,
      `a ${status} goal still stops for its actual status`)
  }
})

test('a goal is reported achieved only when the marker is the whole last line', () => {
  assert.equal(goal.readGoalOutcome(`done\n\n${goal.GOAL_ACHIEVED_MARKER}`), 'achieved')
  assert.equal(goal.readGoalOutcome(`done\n${goal.GOAL_ACHIEVED_MARKER}\n\n   \n`), 'achieved',
    'trailing blank lines do not hide the marker')
  assert.equal(goal.readGoalOutcome(`done\n**${goal.GOAL_ACHIEVED_MARKER}**`), 'achieved',
    'a provider that bolds the line still declared it')
  assert.equal(goal.readGoalOutcome(`done\n\`${goal.GOAL_ACHIEVED_MARKER}\`.`), 'achieved')
  assert.equal(goal.readGoalOutcome(`done\n- ${goal.GOAL_ACHIEVED_MARKER}`), 'achieved')
  assert.equal(goal.readGoalOutcome(`done\n${goal.GOAL_ACHIEVED_MARKER.toLowerCase()}`), 'achieved')
})

test('an agent TALKING about the marker has not finished, and the goal keeps going', () => {
  /* THE EXPENSIVE FALSE POSITIVE. An agent that explains the protocol back, or
     promises to use it later, is mid-work. Ending the goal on that sentence
     would stop the run on the turn that said it was continuing. */
  assert.equal(
    goal.readGoalOutcome(`I will write ${goal.GOAL_ACHIEVED_MARKER} when the tests pass.`),
    null,
  )
  assert.equal(
    goal.readGoalOutcome(`${goal.GOAL_ACHIEVED_MARKER} is what I should write at the end.`),
    null,
    'the marker opening a sentence is not a declaration',
  )
  assert.equal(
    goal.readGoalOutcome(`${goal.GOAL_ACHIEVED_MARKER}\nActually, one more thing to do.`),
    null,
    'a marker followed by more work is not the last line',
  )
  assert.equal(goal.readGoalOutcome('still working on it'), null)
  assert.equal(goal.readGoalOutcome(''), null)
  assert.equal(goal.readGoalOutcome(null), null)
})

test('an agent that is stuck can say so, and that is a different end from achieved', () => {
  assert.equal(goal.readGoalOutcome(`I need the password.\n${goal.GOAL_BLOCKED_MARKER}`), 'blocked')
  assert.notEqual(goal.GOAL_BLOCKED_MARKER, goal.GOAL_ACHIEVED_MARKER)
  const blocked = goal.makeGoal('x', { status: 'blocked' })
  assert.equal(goal.goalWantsContinuation(blocked), false, 'a blocked goal must stop, not loop')
})

test('only a turn that really succeeded may be followed by a self-started one', () => {
  for (const status of ['completed', 'end_turn', 'success']) {
    assert.equal(goal.goalTurnSucceeded(status), true, `${status} is a successful turn`)
  }
  for (const status of ['failed', 'cancelled', 'interrupted', 'refused', '', null, undefined]) {
    assert.equal(goal.goalTurnSucceeded(status), false,
      `${String(status)} must not be treated as a turn worth continuing from`)
  }
})

test('an ordinary person turn reopens only paused or blocked goals', () => {
  for (const status of ['paused', 'blocked']) {
    const resumed = goal.resumeGoalOnPersonTurn(goal.makeGoal('continue the job', {
      status, continuations: 7,
    }))
    assert.equal(resumed.status, 'active')
    assert.equal(resumed.objective, 'continue the job')
    assert.equal(resumed.continuations, 0,
      'a person is watching again, so the autonomous run starts fresh')
  }
  for (const status of ['active', 'achieved']) {
    const unchanged = goal.makeGoal('continue the job', { status, continuations: 2 })
    assert.equal(goal.resumeGoalOnPersonTurn(unchanged), unchanged,
      'an active or terminal goal is not silently rewritten by another turn')
  }
  assert.equal(goal.resumeGoalOnPersonTurn(null), null)
})

test('the instruction block carries the objective and the protocol on every active turn', () => {
  const active = goal.makeGoal('make the suite green')
  const block = goal.goalInstructions(active)
  assert.ok(block.includes('make the suite green'), 'the agent must be told what it is working toward')
  assert.ok(block.includes(goal.GOAL_ACHIEVED_MARKER), 'and how to say it is done')
  assert.ok(block.includes(goal.GOAL_BLOCKED_MARKER), 'and how to say it is stuck')
  /* A SETTLED GOAL MUST NOT KEEP INSTRUCTING. An achieved goal that still told
     the agent "this app starts your next turn automatically" would be telling
     it something untrue. */
  for (const status of ['paused', 'achieved', 'blocked']) {
    assert.equal(goal.goalInstructions(goal.makeGoal('x', { status })), null)
  }
  assert.equal(goal.goalInstructions(null), null)
})

test('a self-started turn says it is self-started, and which one it is', () => {
  const text = goal.goalContinuationText(goal.makeGoal('x', { continuations: 2 }))
  assert.ok(/self-started turn 3\b/.test(text),
    'the count is the NEXT turn, so the person can match it to what they see')
  assert.ok(text.includes('the person has not sent a new message'),
    'the provider is told this turn is autonomous without inventing a finite Goal cap')
})

test('every sentence a person reads names the objective and what will happen next', () => {
  const active = goal.makeGoal('tidy the inbox', { continuations: 3 })
  for (const [name, sentence] of [
    ['set', goal.goalSetSentence(active)],
    ['achieved', goal.goalAchievedSentence(active)],
    ['blocked', goal.goalBlockedSentence(active)],
    ['stopped', goal.goalStoppedSentence(active)],
    ['turn failed', goal.goalTurnFailedSentence(active)],
    ['current', goal.goalCurrentSentence(active)],
  ]) {
    assert.ok(sentence.includes('tidy the inbox'),
      `the ${name} sentence must say which goal it is about`)
    assert.ok(sentence.length > 40, `the ${name} sentence must say more than a word`)
  }
  assert.ok(goal.goalStartedSentence(active).includes('Stop'),
    'a self-started turn must tell the person how to end it')
  assert.ok(/not running|No goal is set/i.test(goal.goalCurrentSentence(null)),
    'with no goal set, say so rather than showing an empty objective')
  assert.ok(goal.goalClearedSentence().length > 20)
})

test('a goal record is only accepted in a shape this host can act on', () => {
  assert.equal(goal.isSessionGoal(goal.makeGoal('x')), true)
  assert.equal(goal.isSessionGoal(null), true, 'no goal is a legitimate state')
  assert.equal(goal.isSessionGoal({ objective: 'x', status: 'nonsense', continuations: 0 }), false)
  assert.equal(goal.isSessionGoal({ objective: '', status: 'active', continuations: 0 }), false)
  assert.equal(goal.isSessionGoal({ objective: 'x', status: 'active', continuations: -1 }), false)
  assert.equal(goal.isSessionGoal({ objective: 'x', status: 'active' }), false)
  assert.equal(goal.isSessionGoal('active'), false)
  assert.equal(goal.isSessionGoal([]), false)
  assert.equal(
    goal.isSessionGoal({ objective: 'x'.repeat(goal.GOAL_MAX_OBJECTIVE_BYTES + 1), status: 'active', continuations: 0 }),
    false,
    'an objective past the bound rides into context on every turn and is refused',
  )
})
