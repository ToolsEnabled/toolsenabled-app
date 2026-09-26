/* The local activity decision is paid-for product truth: it turns the signed
 * run ledger into the statements on Home, the computers page, and Metrics.
 * Keep this test runnable by itself; none of these pure readers needs a DOM. */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COPY,
  describeRun,
  readAgentEngine,
  readLocalSessions,
  summariseRunWork,
} from '../../src/local-activity.js'

const NOW = Date.parse('2026-08-25T12:00:00.000Z')

test('keystore readiness refusals remain fail-closed without inventing an operating system or cause', () => {
  for (const code of ['SPAWN_RECORD_NO_KEYSTORE', 'SPAWN_RECORD_KEYSTORE_UNAVAILABLE']) {
    const reading = readAgentEngine({ ok: false, code }, true)
    assert.equal(reading.ready, false)
    assert.match(reading.why, /secure key storage/)
    assert.match(reading.why, /will not start an agent/)
    assert.doesNotMatch(reading.why, /Windows|Linux|macOS|password|locked|denied/i)
  }
})

function recordedRun() {
  return {
    ok: true,
    total: 2,
    verified: true,
    outcomes: { starts: 1, started: 0, refused: 1 },
    entries: [
      {
        sequence: 2,
        at: '2026-08-25T11:59:03.000Z',
        action: 'agent_session_outcome',
        outcome: { resolves: 1, result: 'refused', reason: 'AGENT_HOST_INVALID_CWD' },
      },
      {
        sequence: 1,
        at: '2026-08-25T11:59:00.000Z',
        action: 'agent_session_start',
        sessionId: 'session-real-caller-kept',
      },
    ],
  }
}

test('a failed history read remains unknown rather than becoming a definite empty record', () => {
  const unavailable = readLocalSessions({ ok: false, entries: [] })

  assert.equal(unavailable.supported, true, 'a reply means the installed history channel exists')
  assert.equal(unavailable.readable, false, 'a failed history read must remain unreadable, not become a definite answer')
  assert.equal(unavailable.started, null, 'an unreadable ledger must not claim that zero agents started')
  assert.equal(unavailable.refused, null, 'an unreadable ledger must not claim that zero agents were refused')
})

test('the shell ledger shape rejoins a start with its outcome and refusal reason', () => {
  const sessions = readLocalSessions(recordedRun())

  assert.equal(sessions.runs.length, 1, 'outcome ledger lines must not be counted as additional agent runs')
  assert.deepEqual(
    sessions.runs[0],
    {
      sequence: 1,
      atMs: Date.parse('2026-08-25T11:59:00.000Z'),
      result: 'refused',
      reason: 'AGENT_HOST_INVALID_CWD',
      sessionId: 'session-real-caller-kept',
      // This start named no lane, and null says so rather than guessing one.
      agentId: null,
    },
    'a run must retain the join key and the recorded refusal facts that callers display',
  )
})

/* WHOSE RUN IT WAS, OFF THE START RECORD. The home panel names the lane on
   every row; until this was read, it could only name one once a saved
   conversation for the session existed, so the newest row -- written a beat
   before its conversation -- had no lane on it at all. Both writers are read:
   the shell puts it in details.agentId, the example fleet puts it in `agent`. */
test("a start record names the lane that ran, under either writer’s field", () => {
  const started = (start) => readLocalSessions({
    ok: true, total: 1, verified: true,
    entries: [{ sequence: 1, at: '2026-08-25T11:59:00.000Z', action: 'agent_session_start', sessionId: 's1', ...start }],
  }).runs[0]

  assert.equal(started({ details: { agentId: 'gem-lane-2' } }).agentId, 'gem-lane-2')
  assert.equal(started({ agent: 'terra-02' }).agentId, 'terra-02')
  assert.equal(started({ agent: '  codex  ' }).agentId, 'codex', 'the name is trimmed, not reshaped')
  assert.equal(started({ details: { agentId: 'gem-lane-2' }, agent: 'ignored' }).agentId, 'gem-lane-2',
    "the shell’s own field answers first")
  assert.equal(started({}).agentId, null, 'a record that does not say answers null')
  assert.equal(started({ agent: '   ' }).agentId, null, 'and blank is not a name')
  assert.equal(started({ details: { agentId: 42 } }).agentId, null, 'nor is a value that is not text')
})

test('a duplicate outcome for one start resolves the same way the writer\'s own whole-chain tally does', () => {
  /* THE SHAPE THAT CAN CARRY TWO OUTCOMES FOR ONE START -- corruption, a manual
     edit, or a bug elsewhere -- and history() deliberately keeps returning
     records even then (its own rule 3: it never throws over an unverified
     chain). shell/spawn-record.cjs's cachedTally() answers this by walking the
     file in LEDGER order and keeping the FIRST outcome it meets for a given
     `resolves`; that is the count outcomeBreakdown() and statTiles() show. This
     fixture hands readLocalSessions() the same two outcomes, newest-first,
     exactly as history() delivers them, and asks it to agree with that count
     rather than crown whichever outcome happens to be newest. */
  const raw = {
    ok: true,
    total: 3,
    verified: true,
    outcomes: { starts: 1, started: 1, refused: 0 },
    entries: [
      {
        sequence: 15,
        at: '2026-08-25T12:05:00.000Z',
        action: 'agent_session_outcome',
        outcome: { resolves: 10, result: 'refused', reason: 'SPURIOUS_LATER_LINE' },
      },
      {
        sequence: 11,
        at: '2026-08-25T12:00:01.000Z',
        action: 'agent_session_outcome',
        outcome: { resolves: 10, result: 'started', reason: null },
      },
      {
        sequence: 10,
        at: '2026-08-25T12:00:00.000Z',
        action: 'agent_session_start',
        sessionId: 'session-duplicate-outcome',
      },
    ],
  }

  const sessions = readLocalSessions(raw)

  assert.equal(sessions.runs.length, 1, 'the two outcome lines must not be counted as extra runs')
  assert.equal(
    sessions.runs[0].result,
    'started',
    'the FIRST outcome ever written for a start must win, matching cachedTally() -- not the newest duplicate',
  )
  assert.equal(sessions.started, 1, 'the whole-chain tally on the same object must agree with the run row')
  assert.equal(sessions.refused, 0, 'the whole-chain tally must not count the spurious duplicate either')
})

test('a refused run explains itself without exposing an internal code or inventing an answer', () => {
  const run = readLocalSessions(recordedRun()).runs[0]
  const described = describeRun(run, new Map(), NOW)

  assert.equal(described.resultWord, 'did not start', 'a refusal must be described as a refusal rather than a start')
  assert.match(described.why, /workspace|nowhere to run/i, 'a known refusal must give the user an actionable plain-language reason')
  assert.doesNotMatch(described.why, /AGENT_HOST_INVALID_CWD/, 'an internal refusal code must never be shown to the user')
  assert.equal(described.said, '', 'a refused run must not invent words from an agent that never started')
})

test('work summaries count turn records without multiplying running session totals', () => {
  const work = summariseRunWork([
    { basis: 'turn', tier: 'codex', totalTokens: 1_200, status: 'completed' },
    { basis: 'turn', tier: 'codex', totalTokens: 345, status: 'failed' },
    { basis: 'session-total', tier: 'codex', totalTokens: 1_545, status: '' },
  ])

  assert.equal(work.turns, 2, 'only per-turn rows count as turns when finer records exist')
  assert.equal(work.tokens, 1_545, 'running session totals must not be added to their own turn token rows')
  assert.equal(work.unfinished, 1, 'only a turn with an explicit unsuccessful ending is unfinished')
  assert.match(COPY.runDid(work), /2 turns.*1,545 tokens.*1 turn did not finish/i,
    'the user-facing work sentence must preserve turns, token spend, and unfinished work')
})

/* MORE TURNS DID NOT FINISH THAN THE RUN HAD TURNS.
 *
 * shell/usage-record.cjs writes the turn's `status` onto EVERY line, running
 * totals included, so a codex session whose engine reported its total twice
 * carried one ending word three times over. The turn count read the turn rows
 * and the unfinished count read all of them, and the row on Home said "1 turn
 * and 1,200 tokens, and 2 turns did not finish." Asserted on the composed
 * sentence rather than on the fields, because the sentence is the thing a
 * person is holding when the arithmetic stops being possible. */
test('a run never reports more unfinished turns than turns', () => {
  const work = summariseRunWork([
    { basis: 'turn', tier: 'codex', totalTokens: 1_200, status: 'error' },
    { basis: 'session-total', tier: 'codex', totalTokens: 1_500, status: 'error' },
    { basis: 'session-total', tier: 'codex', totalTokens: 1_900, status: 'error' },
  ])

  assert.equal(work.turns, 1, 'a running total was counted as a turn of its own')
  assert.ok(work.unfinished <= work.turns,
    `the row claims ${work.unfinished} of ${work.turns} turns did not finish`)
  assert.equal(work.unfinished, 1, 'one turn that ended in error was counted once per line that carried its word')
  assert.match(COPY.runDid(work), /^1 turn and 1,200 tokens, and 1 turn did not finish\.$/,
    'the sentence a person reads counts the same turn more than once')
})

/* THE ONE ENDING WORD ON A RUNNING TOTAL IS NOT A SECOND FAILURE, and the turn
   it belongs to still succeeded. This is the direction that lies loudest: the
   run went fine and the card says it did not. */
test('a running total beside a successful turn does not invent a failure', () => {
  const work = summariseRunWork([
    { basis: 'turn', tier: 'codex', totalTokens: 900, status: 'completed' },
    { basis: 'session-total', tier: 'codex', totalTokens: 900, status: 'error' },
  ])

  assert.equal(work.unfinished, 0, 'a successful run was reported as one that did not finish')
  assert.match(COPY.runDid(work), /^1 turn and 900 tokens\.$/,
    'the sentence added a failure clause to a run whose only turn completed')
})

/* A SESSION THAT OFFERED NOTHING BUT RUNNING TOTALS is unchanged by the rule
   above: there the running totals are the only rows there are, so they are what
   both figures count, exactly as they always were. */
test('a session read only as running totals still counts every reading it has', () => {
  const work = summariseRunWork([
    { basis: 'session-total', tier: 'codex', totalTokens: 900, status: 'error' },
    { basis: 'session-total', tier: 'codex', totalTokens: 2_400, status: 'error' },
  ])

  assert.equal(work.tokens, 2_400, 'a running total was summed instead of taken at its largest')
  assert.equal(work.turns, 2)
  assert.equal(work.unfinished, 2, 'the only rows this session has stopped being counted')
})

test('engine reading keeps no channel, failed readiness, and ready as distinct answers', () => {
  const absent = readAgentEngine(undefined, true)
  const failed = readAgentEngine({ ok: false, code: 'AGENT_HOST_INVALID_CWD' }, true)
  const ready = readAgentEngine({ ok: true }, true)

  assert.deepEqual(
    [absent.supported, absent.ready, absent.why],
    [false, false, null],
    'no installed channel must not be reported as a diagnosed engine refusal',
  )
  assert.equal(failed.ready, false, 'a refusal from availability must not be rounded up to ready')
  assert.match(failed.why, /workspace|nowhere to run/i, 'a known engine refusal must be translated for the user')
  assert.deepEqual(
    [ready.supported, ready.ready, ready.why, ready.sessionsEnabled],
    [true, true, null, true],
    'a successful availability reply must preserve readiness and the caller’s session setting',
  )
})
