/* A TURN THAT FAILS IS NOT A START THAT FAILED, AND THE ENGINE'S OWN SENTENCE
 * REACHES THE PERSON.
 *
 * Two measured defects from the 2026-08-18 fresh-install walkthrough share
 * this suite because they share one code path:
 *
 *   1. A real Fable turn ended {"is_error":true,"api_error_status":429,
 *      "result":"You're out of usage credits · resets Aug 25, 12am"} and the
 *      card said "The turn finished without any words back" — the engine's one
 *      human sentence never left the adapter's promise.
 *   2. The same completion wrote node status 'failed', and the chip word for
 *      'failed' is "did not start" — so a session whose start the signed spawn
 *      record shows was un-said by its own turn failing.
 *
 * The fix is one vocabulary: 'failed' stays the word for a start that never
 * happened, 'turn-failed' is the word for a turn that ended badly on a session
 * that genuinely ran, and the words for both live in src/fleet-tree-copy.js
 * where every surface reads them.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { NODE_STATUSES, FLEET_TREE_LIMITS } from '../../src/fleet-trees.js'
import {
  NODE_STATUS_WORDS,
  PALETTE_PANEL,
  SAID_PANEL,
  TURN_FAILED,
  turnCompletionWords,
} from '../../src/fleet-tree-copy.js'
import { treeNodeClock, nodeIsBusy } from '../../src/tree-session-liveness.js'
import { sessionTurnFailureText } from '../../src/agent-session-events.js'

const VIEW = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')

test('the store vocabulary separates a failed start from a failed turn', () => {
  assert.ok(NODE_STATUSES.includes('failed'), "'failed' (the start that never happened) left the vocabulary")
  assert.ok(NODE_STATUSES.includes('turn-failed'), "'turn-failed' is not a status the store accepts")
})

test('every status the store accepts has a word, and the two failures do not share one', () => {
  for (const status of NODE_STATUSES) {
    assert.equal(typeof NODE_STATUS_WORDS[status], 'string', `no chip word for status '${status}'`)
    assert.ok(NODE_STATUS_WORDS[status].length > 0, `an empty chip word for status '${status}'`)
  }
  assert.equal(NODE_STATUS_WORDS.failed, 'did not start')
  assert.notEqual(NODE_STATUS_WORDS['turn-failed'], NODE_STATUS_WORDS.failed,
    'a failed turn reads as a start that never happened — the measured defect, back')
  assert.match(NODE_STATUS_WORDS['turn-failed'], /turn failed/,
    'the turn-failure word does not say a turn failed')
})

test("a failed turn's completion words carry the engine's sentence", () => {
  const sentence = "You're out of usage credits · resets Aug 25, 12am"
  const words = turnCompletionWords({ succeeded: false, spoken: '', engineSentence: sentence })
  assert.ok(words.includes(sentence), "the engine's own sentence was dropped from the reply")
  assert.notEqual(words, SAID_PANEL.emptyTurn,
    'a failed turn with words still reads "finished without any words back"')
})

test('a failed turn that also streamed words keeps both truths', () => {
  const words = turnCompletionWords({ succeeded: false, spoken: 'partial answer', engineSentence: 'the child died' })
  assert.ok(words.includes('partial answer'), 'the words the agent really said were dropped')
  assert.ok(words.includes('the child died'), 'the failure sentence was dropped because words streamed first')
})

test('a successful turn is untouched: its own words, or the honest empty sentence', () => {
  assert.equal(turnCompletionWords({ succeeded: true, spoken: 'done', engineSentence: null }), 'done')
  assert.equal(turnCompletionWords({ succeeded: true, spoken: '', engineSentence: null }), SAID_PANEL.emptyTurn)
  assert.equal(turnCompletionWords({ succeeded: false, spoken: '', engineSentence: null }), SAID_PANEL.emptyTurn)
})

test('a turn-failed node reads as stopped, not as a corpse with a ticking clock', () => {
  const node = {
    status: 'turn-failed',
    sessionId: 'sess-1',
    createdAt: '2026-08-19T01:00:00.000Z',
    updatedAt: '2026-08-19T01:05:00.000Z',
  }
  const owned = new Set(['sess-1'])
  const clock = treeNodeClock(node, owned)
  assert.equal(clock.terminal, true, 'turn-failed is not terminal, so the canvas binds a live clock over it')
  assert.ok(clock.stoppedAt !== null, 'a turn-failed node has no stop time')
  assert.equal(nodeIsBusy(node, owned), false)
})

/* The view's completion branch is a closure, so the two load-bearing choices
   are pinned against its source, the same device tools/test/palette-rows.test.mjs
   uses: the branch must file the failure as 'turn-failed' (never 'failed', which
   is the start-failure word), and it must compose the reply through
   turnCompletionWords so the engine's sentence can reach the glass. */
test("the completion branch files a failed turn as 'turn-failed' and reads the engine's sentence", () => {
  assert.ok(!VIEW.includes("sessionTurnSucceeded(status) ? 'finished' : 'failed'"),
    "the completion branch still writes 'failed' for a failed TURN — the un-said start is back")
  /* Extended 2026-08-19: a recorded user interrupt takes precedence over
     'turn-failed' — a stop the person asked for is not a failure — and only
     over it: success still wins first, so the order is finished, then
     stopped-by-you, then failed. */
  assert.match(VIEW, /const outcome = nodeStatusForTurn\(status, \{ userStopped \}\)/,
    "the completion branch does not classify cancelled native turns separately from failed turns")
  assert.match(VIEW, /sessionTurnCancelled\(status\)/,
    'a cancelled native completion is still filed as an ordinary failed turn')
  assert.match(VIEW, /turnCompletionWords\(/,
    "the completion branch does not compose its reply through turnCompletionWords, so the engine's sentence cannot reach the card")
})

test("the shared reader hands over a failed completion's sentence, and only a failed one's", () => {
  const failed = {
    sessionId: 's1',
    event: { type: 'turn_completed', status: 'error', text: "You're out of usage credits · resets Aug 25, 12am" },
  }
  assert.equal(sessionTurnFailureText(failed, 's1'), "You're out of usage credits · resets Aug 25, 12am")
  assert.equal(sessionTurnFailureText(failed, 'other-session'), null, "another session's failure crossed transcripts")
  const succeeded = { sessionId: 's1', event: { type: 'turn_completed', status: 'success', text: 'the answer' } }
  assert.equal(sessionTurnFailureText(succeeded, 's1'), null, 'a successful result text would print the answer twice')
  const wordless = { sessionId: 's1', event: { type: 'turn_completed', status: 'failed' } }
  assert.equal(sessionTurnFailureText(wordless, 's1'), null)
  const notCompletion = { sessionId: 's1', event: { type: 'assistant_text', text: 'hello' } }
  assert.equal(sessionTurnFailureText(notCompletion, 's1'), null)
})

test('the palette owns an honest sentence for saved-but-unreachable turns', () => {
  assert.equal(typeof PALETTE_PANEL.whyOnlySavedTurns, 'string',
    'no sentence for a rewind over messages saved before this window opened')
  assert.notEqual(PALETTE_PANEL.whyOnlySavedTurns, PALETTE_PANEL.whyNoTurns,
    'the saved-conversation state reuses the never-sent sentence — the measured lie')
})

/* T1509. The recorded usage-limit ending (2026-09-22 12:01Z, reset Sep 29 2:13
   AM in the owner's clock) as the engine now emits it: the card's reply and its
   note carry the limit, the reset time and the Accounts menu, whole, inside the
   note limit the store enforces. */
test('a recorded usage-limit ending puts the limit, its reset time and the Accounts menu on the card', () => {
  const sentence = 'This Codex account has reached its usage limit. The limit resets Sep 29, 2:13 AM. Until then, choose another account in the Accounts menu.'
  const packet = { sessionId: 's1', event: { type: 'turn_completed', threadId: 't1', turnId: 'turn-1', status: 'failed', text: sentence,
    payload: { limit: 'usage', resetsAt: '2026-09-29T09:13:00.000Z' } } }
  const engineSentence = sessionTurnFailureText(packet, 's1')
  assert.equal(engineSentence, sentence)
  const words = turnCompletionWords({ succeeded: false, spoken: '', engineSentence })
  assert.equal(words, TURN_FAILED.reply(sentence))
  assert.match(words, /usage limit.*resets Sep 29, 2:13 AM.*Accounts menu/)
  assert.ok(words.length <= FLEET_TREE_LIMITS.maxNoteChars, 'the card note would cut the reset time off')
})
