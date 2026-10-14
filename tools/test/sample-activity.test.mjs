/* The example activity is product data, not a loose fixture: Home and Metrics
 * send its raw reply through the same reader as a computer's run ledger, while
 * Home joins its conversations by session id.  These tests exercise those
 * caller-visible contracts rather than pinning the example's prose verbatim. */

import assert from 'node:assert/strict'
import test from 'node:test'

import { readLocalSessions } from '../../src/local-activity.js'
import { sampleConversations, sampleSessionsRaw } from '../../src/sample-activity.js'

const NOW = Date.UTC(2026, 7, 20, 15, 30, 0)
/* The fixed ladder's length, named so the assertions below can say "more than
   the ladder" without pinning the moving total. */
const AGO_LADDER_RUNS = 19

test('the sample reply survives the real activity reader as a full run record', () => {
  const raw = sampleSessionsRaw(NOW)
  const sessions = readLocalSessions(raw)

  assert.equal(sessions.readable, true, 'the real activity reader must accept the sample reply')
  assert.equal(sessions.verified, true, 'the sample record must identify itself as verified')
  /* THE PROPERTY, NOT THE NUMBER. This pinned a literal 19 -- the fixed
     ladder's length -- to guard a real defect: outcome rows once counted as
     runs, and "19 starts plus 17 outcomes" was reported as 36. The example now
     carries a rolling live head as well, so the count is a function of the
     clock and a literal can only be wrong. Asserting starts-in === runs-out
     guards the same defect at any clock, and more tightly. */
  const startRows = raw.entries.filter((e) => e.action === 'agent_session_start').length
  assert.equal(sessions.runs.length, startRows,
    'outcome ledger rows must not be counted as additional runs')
  assert.ok(sessions.runs.length > AGO_LADDER_RUNS,
    'and the record carries more than the fixed ladder, or the demonstration is not moving')
  assert.equal(sessions.total, sessions.runs.length, 'the advertised run total must match the runs callers can render')
  assert.ok(sessions.runs.every(run => run.atMs < NOW), 'every sample run must be in the caller-provided clock’s past')
  assert.ok(sessions.runs.every(run => typeof run.sessionId === 'string'), 'every sample run must carry its conversation join key')
})

test('missing outcomes remain unknown rather than becoming a definite answer', () => {
  const sessions = readLocalSessions(sampleSessionsRaw(NOW))
  const unknown = sessions.runs.filter(run => run.result === null)

  /* Two on the fixed ladder, plus the live head's newest run, which is left
     unresolved ON PURPOSE -- that in-flight row is what makes the
     demonstration read as alive rather than as a longer list of finished
     things. So this is a floor, not an equality: the ladder's two must still
     be exercised, and the moving head may add one. */
  assert.ok(unknown.length >= 2, 'the sample must exercise the could-not-determine outcome paths')
  assert.equal(sessions.started + sessions.refused + unknown.length, sessions.total,
    'unknown outcomes must remain outside both the started and refused tallies')
  for (const run of unknown) {
    assert.equal(run.reason, null, `unknown run ${run.sessionId} must not invent a refusal reason`)
  }
})

test('conversation joins preserve useful asks, answers, and honest refusals', () => {
  const sessions = readLocalSessions(sampleSessionsRaw(NOW))
  const conversations = sampleConversations(NOW)

  assert.equal(conversations.size, sessions.runs.length, 'every rendered run must join to one sample conversation')
  for (const run of sessions.runs) {
    const conversation = conversations.get(run.sessionId)
    assert.ok(conversation, `sample conversation is missing for ${run.sessionId}`)
    assert.ok(conversation.asked.trim().split(/\s+/).length >= 4,
      `sample ask for ${run.sessionId} must remain useful rather than placeholder copy`)
    assert.equal(conversation.turns[0]?.who, 'you', `sample conversation ${run.sessionId} must begin with the user’s ask`)
    assert.equal(conversation.turns[0]?.text, conversation.asked,
      `sample conversation ${run.sessionId} must show the same ask as its summary`)

    if (run.result === 'refused') {
      assert.equal(conversation.status, 'failed', `refused run ${run.sessionId} must be presented as failed`)
      assert.equal(conversation.reply, '', `refused run ${run.sessionId} must not claim an answer was produced`)
      assert.equal(conversation.turns.length, 1, `refused run ${run.sessionId} must not claim that work ran`)
    } else {
      assert.ok(conversation.reply.trim().split(/\s+/).length >= 4,
        `answered run ${run.sessionId} must retain a substantive example reply`)
      assert.equal(conversation.turns.at(-1)?.text, conversation.reply,
        `sample conversation ${run.sessionId} must end with the answer shown in its summary`)
    }
  }
})

test('the supplied clock makes both exported records deterministic and movable', () => {
  assert.deepEqual(sampleSessionsRaw(NOW), sampleSessionsRaw(NOW),
    'the same clock must produce the same sample ledger')
  assert.deepEqual(sampleConversations(NOW), sampleConversations(NOW),
    'the same clock must produce the same sample conversations')

  const movedBy = 90_000
  /* READ A LADDER ROW, NOT entries[0]. entries[0] is now the live head's newest
     run, and the head is QUANTISED TO SLOTS on purpose -- it advances a slot at
     a time rather than continuously, which is what lets a screenshot stay
     comparable within a slot. The ladder is the part that follows the caller's
     clock exactly, and that is the property this test is about. */
  const ladderAt = (ms) => Date.parse(sampleSessionsRaw(ms).entries
    .find((e) => e.action === 'agent_session_start' && !e.sessionId.includes('/live-')).at)
  assert.equal(ladderAt(NOW + movedBy) - ladderAt(NOW), movedBy,
    'ledger timestamps must follow the caller’s clock')
  const firstConversationAt = sampleConversations(NOW).values().next().value.turns[0].at
  const movedConversationAt = sampleConversations(NOW + movedBy).values().next().value.turns[0].at
  assert.equal(movedConversationAt - firstConversationAt, movedBy, 'conversation timestamps must follow the caller’s clock')
})

/* ---- THE LIVING DEMONSTRATION (owner, 2026-08-26: "make it move ... just
   make it feel alive a bit") ----

   A NOTE ON HOW THESE ARE WRITTEN, because the first version of them was
   worthless. The ladder above already slides with nowMs, so "a later clock
   gives a newer timestamp" and "something is in flight" were BOTH TRUE OF THE
   OLD FILE -- five tests that passed against the code they were meant to pin.
   The property that actually distinguishes a moving demonstration from a
   sliding photograph is that the SET OF RUNS GAINS A MEMBER. That is what
   these assert. */

const startIds = (ms) => new Set(sampleSessionsRaw(ms).entries
  .filter((e) => e.action === 'agent_session_start')
  .map((e) => e.sessionId))

test('crossing a slot brings a run that DID NOT EXIST before -- not the same list re-dated', () => {
  const base = 1787800000000
  const before = startIds(base)
  const after = startIds(base + 45_000)
  const appeared = [...after].filter((id) => !before.has(id))
  assert.ok(appeared.length >= 1, 'a slot later, at least one session id is new')
  assert.ok(before.size > 0 && after.size === before.size,
    'and the window holds steady -- the oldest live run falls off as a new one arrives')
})

test('and it is STILL deterministic in nowMs, which is the rule it must not break', () => {
  /* This file opens by forbidding Math.random and persisted state: "a
     demonstration that reshuffles itself on every navigation reads as broken,
     and it also makes a screenshot impossible to compare against the next
     one." Randomness was the easy way to look alive and would have broken
     exactly that, so the head is a function of the clock instead. */
  const at = 1787800012345
  assert.equal(JSON.stringify(sampleSessionsRaw(at)), JSON.stringify(sampleSessionsRaw(at)),
    'the same nowMs gives the same record, so a screenshot is stable within its slot')
  /* THE LIVE HEAD is what must be stable within a slot -- that is what makes a
     screenshot comparable to the next one. The LADDER has always slid
     continuously (every row is nowMs minus a fixed age), so asserting the
     whole record is byte-identical a second later was never true of this file
     and is not something my change broke. Narrowed to the claim that holds. */
  const headIds = (ms) => sampleSessionsRaw(ms).entries
    .filter((e) => e.action === 'agent_session_start' && e.sessionId.includes('/live-'))
    .map((e) => `${e.sessionId}@${e.at}`)
  assert.deepEqual(headIds(at), headIds(at + 1_000),
    'the live head is identical within a slot, so a screenshot is comparable')
})

test('every run a person can press opens onto a conversation, live ones included', () => {
  /* The join test above pins this for the ladder. It is repeated here for the
     live head because the two are built by different functions, and the first
     draft of this feature had the head in only ONE of them -- so the newest
     rows on screen led nowhere. */
  const at = 1787800000000
  const conversations = sampleConversations(at)
  for (const id of startIds(at)) {
    assert.ok(conversations.has(id), `no conversation behind ${id}`)
  }
})

test('the run in flight withholds its answer rather than inventing one', () => {
  const at = 1787800000000
  const conversations = sampleConversations(at)
  const running = [...conversations.values()].filter((c) => c.status === 'running')
  assert.equal(running.length, 1, 'exactly one run is presented as still going')
  assert.equal(running[0].reply, '', 'a run still going has produced no answer yet')
  assert.ok(running[0].turns.length >= 1, 'but its ask and any work so far are shown')
})

test('no run is dated in the future', () => {
  /* The head sits inside its slot rather than on the boundary, so an
     off-by-one there would render a run that has not happened yet. */
  const at = 1787800031234
  for (const e of sampleSessionsRaw(at).entries) {
    assert.ok(Date.parse(e.at) <= at + 1200, `entry at ${e.at} is later than now`)
  }
})
