/* B36 (c5 Linux extra hand test, 09-27): the Team box keeps saying "Started"
 * after every member's first turn failed.
 *
 * Team with a Sonnet 5 lead and a Haiku 4.5 member while the Claude account was
 * at its weekly limit. Both briefs were accepted, so the box read "2 saved
 * agents started ... Started; open its circle to follow the conversation" for
 * both, while the usage records said `error` for both and the canvas said
 * "2 need review" and "the last turn failed: You've hit your weekly limit".
 *
 * This drives the real controller (src/tree-bounded-work.js) through its
 * injected collaborators, the way tools/test/tree-bounded-controller.test.mjs
 * does, with the host's own turn_completed packets delivered through
 * `subscribeHostEvents` (the view passes window.mcAgent.onEvent). The statuses
 * are the engines' own words: Claude's CLI result subtypes `success` and
 * `error_during_execution`, with a failed turn's sentence on `text`.
 *
 *   node --test tools/test/b36-team-first-turn-failed.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as bounded from '../../src/tree-bounded-work.js'

const { createTreeWorkController } = bounded
const hash = 'a'.repeat(64)
const LIMIT = 'You’ve hit your weekly limit · resets Oct 1, 12am'
const plan = { computerId: 'computer', treeId: 'saved-tree', parentNodeId: 'manager', parentSessionId: 'parent-session',
  tier: 'claude-sonnet-5', capMs: 60_000, brief: 'Every member: reply with exactly the single word TEAMOK.',
  members: ['claude-haiku-4-5'], iterations: 2, intervalMs: 60_000 }

function accepted(request, index) {
  const sessionId = `session-${index}`, nodeId = `node-${index}`
  return { ok: true, sessionId, nodeId, record: { sequence: index, eventHash: hash }, boundedWork: {
    action: 'tree.dispatch', computerId: request.computerId, treeId: request.treeId,
    parentNodeId: request.parentNodeId, parentSessionId: request.parentSessionId,
    sessionId, nodeId, agentId: nodeId, capMs: request.capMs, startedAt: 1000, deadlineAt: 1000 + request.capMs,
  } }
}

function fixture(kind = 'team', { beforeAnswer = () => {} } = {}) {
  const starts = [], closes = [], statuses = new Map()
  let hostListener = null
  let endedListener = null
  const controller = createTreeWorkController({ kind,
    /* The view names the session the moment it opens, before the brief is
       sent (startDraftNode's onBoundedSessionOpen), and answers once the
       brief is accepted. */
    start: async request => {
      starts.push(request)
      const result = accepted(request, starts.length)
      request.onSessionOpen?.(result.sessionId)
      statuses.set(result.sessionId, { ok: true, ...result.boundedWork, state: 'ready', record: result.record })
      await beforeAnswer(result.sessionId)
      return result
    },
    readStatus: async sessionId => statuses.get(sessionId),
    close: async sessionId => {
      closes.push(sessionId)
      statuses.set(sessionId, { ...statuses.get(sessionId), state: 'closed', endRecord: { sequence: 100, eventHash: hash } })
      return { ok: true }
    },
    isBusy: () => false,
    subscribeEnded: listener => { endedListener = listener; return () => { endedListener = null } },
    subscribeHostEvents: listener => { hostListener = listener; return () => { hostListener = null } },
    setTimer: () => ({}),
    clearTimer: () => {},
  })
  const STATUS = { 'turn-failed': 'error_during_execution', finished: 'success', interrupted: 'interrupted', cancelled: 'cancelled' }
  const turn = (sessionId, outcome, sentence = null) => {
    assert.ok(hostListener, 'the box must listen for the turns of the agents it started')
    hostListener({ sessionId, event: { type: 'turn_completed', status: STATUS[outcome] || outcome, ...(sentence ? { text: sentence } : {}) } })
  }
  const packet = value => { assert.ok(hostListener, 'the box must listen to the host'); hostListener(value) }
  return { controller, starts, closes, turn, packet, ended: sessionId => endedListener?.(sessionId), get hostListener() { return hostListener } }
}

test('a Team whose every first turn failed says so, and why, instead of "started"', async () => {
  const f = fixture('team')
  await f.controller.run(plan)
  const before = f.controller.getState()
  assert.equal(before.phase, 'active')
  assert.match(before.message, /^2 saved agents started\./)

  f.turn('session-1', 'turn-failed', LIMIT)
  f.turn('session-2', 'turn-failed', LIMIT)

  const after = f.controller.getState()
  assert.deepEqual(after.rows.map(row => row.phase), ['turn-failed', 'turn-failed'])
  for (const row of after.rows) {
    assert.doesNotMatch(row.detail, /Started/, `${row.label}: a failed first turn is not "Started"`)
    assert.equal(row.detail, `Its first turn failed: ${LIMIT}.`)
  }
  assert.doesNotMatch(after.message, /^2 saved agents started\. Open their circles/)
  assert.match(after.message, /every one’s first turn failed, so none of them is working on the brief/)
  assert.ok(after.message.includes(LIMIT), `the box must say why: ${after.message}`)
  assert.equal(after.phase, 'active', 'the sessions are still open')
  assert.equal(after.stoppable, true, 'Stop still closes them')

  await f.controller.stop()
  assert.deepEqual(f.closes, ['session-2', 'session-1'])
  assert.equal(f.controller.getState().phase, 'stopped')
})

test('a first turn that failed before its start answered is shown once the row exists', async () => {
  let f
  f = fixture('launch', { beforeAnswer: sessionId => f.turn(sessionId, 'turn-failed', LIMIT) })
  await f.controller.run(plan)
  const state = f.controller.getState()
  assert.deepEqual(state.rows.map(row => row.phase), ['turn-failed'])
  assert.match(state.message, /^The agent started, but its first turn failed/)
  assert.ok(state.message.includes(LIMIT))
})

test('one member failing out of two says how many, and the others keep their words', async () => {
  const f = fixture('team')
  await f.controller.run({ ...plan, members: ['claude-haiku-4-5', 'claude-sonnet-5'] })
  f.turn('session-2', 'turn-failed', LIMIT)
  f.turn('session-1', 'finished')
  f.turn('session-3', 'finished')
  const state = f.controller.getState()
  assert.deepEqual(state.rows.map(row => row.phase), ['started', 'turn-failed', 'started'])
  assert.equal(state.rows[0].detail, 'Started; open its circle to follow the conversation.')
  assert.match(state.message, /^3 saved agents started, but one of them failed on its first turn, so it is not working on the brief\./)
  assert.ok(state.message.includes(LIMIT))
})

test('different reasons, or none, send the person to the circles rather than picking one', async () => {
  const f = fixture('team')
  await f.controller.run(plan)
  f.turn('session-1', 'turn-failed', LIMIT)
  f.turn('session-2', 'turn-failed', null)
  const state = f.controller.getState()
  assert.equal(state.rows[1].detail, 'Its first turn failed. Open its circle to read why.')
  assert.match(state.message, /Open their circles to read why\./)
})

test('only the brief\'s own turn counts: a later failure, a Halt, a cancel, other packets and strangers change nothing', async () => {
  const f = fixture('team')
  await f.controller.run({ ...plan, members: ['claude-haiku-4-5', 'claude-sonnet-5'] })
  const message = f.controller.getState().message
  f.packet({ sessionId: 'session-2', event: { type: 'assistant_text_delta', text: 'working' } })
  f.packet({ sessionId: 'session-2', event: { type: 'session_ended', reason: 'exited', exit: { code: 1, signal: null } } })
  f.packet(null)
  f.turn('session-1', 'finished')
  f.turn('session-1', 'turn-failed', 'a later turn failed')
  f.turn('session-2', 'interrupted')
  f.turn('session-3', 'cancelled')
  f.turn('session-3', 'turn-failed', 'a later turn failed')
  f.turn('someone-elses-session', 'turn-failed', LIMIT)
  const state = f.controller.getState()
  assert.deepEqual(state.rows.map(row => row.phase), ['started', 'started', 'started'])
  assert.equal(state.message, message)
})

test('a late failure never writes over a sentence the box did not put there', async () => {
  const f = fixture('team')
  await f.controller.run(plan)
  f.ended('parent-session')
  const parentEnded = f.controller.getState().message
  assert.match(parentEnded, /The selected parent ended/)
  f.turn('session-1', 'turn-failed', LIMIT)
  assert.equal(f.controller.getState().rows[0].phase, 'turn-failed', 'the row still says what happened')
  assert.equal(f.controller.getState().message, parentEnded)
})

test('a Loop marks the run whose first turn failed and keeps its own schedule sentence', async () => {
  const f = fixture('loop')
  await f.controller.run(plan)
  const message = f.controller.getState().message
  assert.match(message, /^Run 1 started/)
  f.turn('session-1', 'turn-failed', LIMIT)
  const state = f.controller.getState()
  assert.equal(state.rows[0].phase, 'turn-failed')
  assert.equal(state.message, message)
})

test('a new run does not inherit the last run\'s first turns, and stopping detaches from the host', async () => {
  const f = fixture('launch')
  await f.controller.run(plan)
  f.turn('session-1', 'turn-failed', LIMIT)
  await f.controller.stop()
  assert.equal(f.hostListener, null, 'a confirmed Stop stops listening')
  await f.controller.run(plan)
  const state = f.controller.getState()
  assert.deepEqual(state.rows.map(row => [row.sessionId, row.phase]), [['session-2', 'started']])
  assert.match(state.message, /^1 saved agent started\./)
})

test('the host\'s own completion packets become the box\'s first-turn facts', () => {
  assert.equal(typeof bounded.boundedTurnOutcome, 'function', 'src/tree-bounded-work.js must read turn packets for the box')
  const packet = (status, text) => ({ sessionId: 'session-1', event: { type: 'turn_completed', status, ...(text ? { text } : {}) } })
  assert.deepEqual({ ...bounded.boundedTurnOutcome(packet('error_during_execution', LIMIT)) },
    { sessionId: 'session-1', outcome: 'turn-failed', sentence: LIMIT })
  assert.deepEqual({ ...bounded.boundedTurnOutcome(packet('success', 'TEAMOK')) },
    { sessionId: 'session-1', outcome: 'finished', sentence: null }, 'a success never carries its text as a failure')
  assert.equal(bounded.boundedTurnOutcome(packet('completed')).outcome, 'finished')
  assert.equal(bounded.boundedTurnOutcome(packet('interrupted')).outcome, 'interrupted', 'a Halt is not a failure')
  assert.equal(bounded.boundedTurnOutcome(packet('cancelled')).outcome, 'cancelled')
  assert.equal(bounded.boundedTurnOutcome({ sessionId: 'session-1', event: { type: 'assistant_text_delta', text: 'x' } }), null)
  assert.equal(bounded.boundedTurnOutcome({ event: { type: 'turn_completed', status: 'error' } }), null)
  assert.equal(bounded.boundedTurnOutcome(null), null)
})
