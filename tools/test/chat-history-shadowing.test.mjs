/* THREE WAYS A CONVERSATION WAS LOST WITHOUT ANYBODY BEING TOLD.
 *
 * Owner, on the preview build: "the messages in history disappear or combine
 * into each other", and a screenshot of a panel showing one YOU bubble over a
 * node that had held a five-line conversation.
 *
 * WHAT THIS FILE CAN MEASURE. src/views/computers.js reaches three stylesheets,
 * echarts, a canvas and a ResizeObserver at module load, so a plain Node
 * process cannot import it -- the same limit tools/test/tree-chat-transcript.
 * test.mjs records. So the decision that had to be made was moved OUT of the
 * view into src/agent-session-events.js, where it is tested as behaviour with a
 * synthetic out-of-order event pair, and the view is pinned at the source level
 * for consulting it. The runtime proof is tools/chat-history-drive.mjs.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { completionSettlesOpenTurn } from '../../src/agent-session-events.js'

const SRC = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'src')
const view = readFileSync(join(SRC, 'views', 'computers.js'), 'utf8')

/* ---------------------------------------------------------------
   A. Window memory and the durable record are ONE history.
   --------------------------------------------------------------- */

test('an append seeds window memory from the record before it adds a word', () => {
  /* THE DEFECT. `treeChatConfigFor` reads the durable record only
     `if (!history.length)`, and deliberately never seeds the map. So the map
     and the record were two independent histories, and the FIRST line appended
     into an empty map permanently shadowed a five-line saved record for the
     life of the window -- the owner's screenshot exactly: a panel showing only
     the latest YOU bubble. Reading is reading; the WRITE side is where the two
     halves have to become one. */
  const append = view.slice(view.indexOf('function transcriptAppend'), view.indexOf('function persistTranscript'))
  assert.match(
    append,
    /if \(!sessionTranscripts\.has\(sessionId\)\)/,
    'an append into a session this window has never held does not consult the record, so it shadows one',
  )
  assert.match(append, /transcriptStore\.get\(/, 'the seed does not come from the durable record')
  assert.ok(
    append.indexOf('transcriptStore.get(') < append.indexOf('held.push(entry)'),
    'the record is read after the new line is pushed, which is the shadowing this fixes',
  )
})

test('the phantom you-line is stripped before the recovery can refuse', () => {
  /* treeCardSend appends a "you" line BEFORE the send. When the send is
     refused with MC_AGENT_UNKNOWN_SESSION the strip that removes it again sat
     BELOW three early returns in recoverDeadSessionSend -- the start-control
     switch, the one-per-quarter-minute limiter, and the already-recovering
     guard. A refused or rate-limited recovery therefore left the orphan
     standing as the only thing in window memory. */
  const send = view.slice(view.indexOf('function treeCardSend'), view.indexOf('const recoveringNodes'))
  const branch = send.slice(send.indexOf("['MC_AGENT_UNKNOWN_SESSION', 'MC_AGENT_SESSION_ENDED'"))
  assert.match(branch, /stripPhantomYouLine\(/, 'the refusal branch hands to the recovery without stripping the line it just appended')
  assert.ok(
    branch.indexOf('stripPhantomYouLine(') < branch.indexOf('recoverDeadSessionSend('),
    'the strip happens after the recovery is dispatched, so a refused recovery keeps the orphan',
  )
})

test('the strip still compares the WHOLE line, so it cannot eat a saved one', () => {
  /* The store truncates at maxLineChars, so a stored tail can legitimately be
     the first 600 characters of what was typed. That prefix is admitted only
     where it is explained; anything looser deletes real saved lines. */
  const strip = view.slice(view.indexOf('function stripPhantomYouLine'))
  const body = strip.slice(0, strip.indexOf('\n  }\n') + 5)
  assert.match(body, /tail\.text\.length === TRANSCRIPT_LIMITS\.maxLineChars/, 'the only legitimate prefix is no longer the only one admitted')
  assert.match(body, /tail\.text === text \|\| wasTruncated/, 'the whole-line comparison is gone')
  assert.ok(
    !/tail\.text === text\.slice\(0, tail\.text\.length\)/.test(view),
    'the loose prefix match is back; a short line that starts an earlier one erases the saved conversation',
  )
})

/* ---------------------------------------------------------------
   C. A save must not null what it does not know.
   --------------------------------------------------------------- */

test('persisting a transcript keeps the engine thread handle it was not told about', () => {
  /* transcriptStore.save REPLACES a node record whole; it never merges of its
     own accord. So persistTranscript, taking threadId and effort from window
     memory, could erase the engine handle that makes a real Resume possible --
     from a window that had never opened that session and so knew neither.
     THE GUARANTEE IS THE SAME; THE PLACE IT IS KEPT MOVED. This used to be a
     transcriptStore.get(nodeId) here whose answers were merged in by hand, and
     that read parses and re-cleans every conversation stored for the computer,
     so each appended turn paid for the whole envelope twice (measured
     2026-09-03: 2.514 ms per turn over a full store, 0.948 ms without the
     second read). The merge is now the store's, asked for by name, and it is
     DRIVEN with values rather than matched as text in
     tools/test/transcript-append-cost.test.mjs -- "what this window does not
     know is kept, and what it does know still wins". What stays pinned here is
     that this view still asks for it. */
  const persist = view.slice(view.indexOf('function persistTranscript'), view.indexOf('const tierEffortOf'))
  assert.match(persist, /keepUnknown: true/, 'the save does not ask the store to keep what this window cannot supply, so it writes null over the saved thread name and depth')
  assert.ok(!/kept\?\./.test(persist.replace(/\/\*[\s\S]*?\*\//g, '')), 'the by-hand merge is back, and with it the second read of the whole envelope')
})

test('a plain start still records the session, so nothing later has to guess', () => {
  /* THE RULE MOVED, THE PROPERTY DID NOT. What a resumed session opens on now
     lives in src/tree-resume-transcript.js, because six lines inside a view no
     test process can import are six lines nothing drives -- and they deleted a
     person's conversation (see tools/test/resume-keeps-the-conversation.test.mjs,
     which DRIVES the empty-history decision and the excerpt-wins decision this
     used to match as text).
     What stays pinned here is the half that is still this view's: the session is
     recorded UNCONDITIONALLY. There is no branch left that can return without
     setting it, so nothing downstream has to guess what an absent key meant. */
  const resume = view.slice(view.indexOf('async function resumeNodeSession'), view.indexOf('async function runPaletteAction'))
  const tail = resume.slice(resume.indexOf('sessionTranscripts.set(result.sessionId'), resume.indexOf('nodeActivity.delete(node.id)'))
  assert.match(
    tail,
    /sessionTranscripts\.set\(result\.sessionId, result\.roleIntroduction/,
    'a resume that plain-starts leaves the session absent from window memory entirely',
  )
  assert.match(resume, /const resumedLines = resumedTranscriptLines\(\{/,
    'the unconditional session write no longer starts from the one recovered transcript decision')
  assert.equal(
    (tail.match(/sessionTranscripts\.set\(/g) || []).length, 1,
    'the resume branches on what to record again; one of those branches is how a session went unrecorded',
  )
})

/* ---------------------------------------------------------------
   D. One turn's words, filed as another turn's answer.
   --------------------------------------------------------------- */

test('a completion for the turn that is open files what that turn said', () => {
  const packet = { sessionId: 's1', event: { type: 'turn_completed', status: 'completed', turnId: 'turn-a' } }
  assert.equal(completionSettlesOpenTurn(packet, 's1', 'turn-a'), true)
})

test('a completion arriving AFTER the next turn started does not take its words', () => {
  /* THE SYNTHETIC REPRO, and it is the owner's "combine into each other" from
     the other side. The completion branch read sessionTurnStatus, which
     carries the status and NOT the turn id, and filed whatever was in the
     accumulator. Order the two events like this --
         delta(turn-a) -> delta(turn-b) -> completed(turn-a)
     -- and turn B's partial words are recorded as turn A's answer, and B's
     accumulator is emptied under it. */
  const completedA = { sessionId: 's1', event: { type: 'turn_completed', status: 'completed', turnId: 'turn-a' } }
  assert.equal(
    completionSettlesOpenTurn(completedA, 's1', 'turn-b'),
    false,
    'a stale completion must not settle the next open turn',
  )
})

test('an engine that does not name its turns behaves exactly as it did before', () => {
  /* Claude's CLI result packets carry no turn id. If a nameless completion
     stopped filing, completions would stop being recorded at all on that
     engine -- a far worse defect than the one being fixed. */
  const nameless = { sessionId: 's1', event: { type: 'turn_completed', status: 'success' } }
  assert.equal(completionSettlesOpenTurn(nameless, 's1', 'turn-b'), true)
  assert.equal(completionSettlesOpenTurn(nameless, 's1', null), true)
})

test('a completion with nothing else in flight files, named or not', () => {
  const named = { sessionId: 's1', event: { type: 'turn_completed', status: 'completed', turnId: 'turn-a' } }
  assert.equal(completionSettlesOpenTurn(named, 's1', null), true)
})

test('a packet for another session, or no completion at all, decides nothing', () => {
  assert.equal(
    completionSettlesOpenTurn({ sessionId: 's2', event: { type: 'turn_completed', turnId: 'x' } }, 's1', 'y'),
    false,
    'another session must not settle this session’s open turn',
  )
  assert.equal(completionSettlesOpenTurn({ sessionId: 's1', event: { type: 'assistant_text_delta', turnId: 'x' } }, 's1', 'y'), false)
  assert.equal(completionSettlesOpenTurn(null, 's1', 'y'), false)
})

test('the completion branch asks before it files', () => {
  const completion = view.slice(view.indexOf('const status = sessionTurnStatus(packet, sessionId)'))
  const head = completion.slice(0, completion.indexOf('nodeActivity.delete(nodeId)'))
  assert.match(head, /completionSettlesOpenTurn\(packet, sessionId, sessionOpenTurns\.get\(sessionId\)\)/,
    'the completion branch still files whatever is in the accumulator, whichever turn put it there')
  assert.ok(
    head.indexOf('completionSettlesOpenTurn') < head.indexOf("sessionTurnText.get(sessionId)"),
    'the accumulator is read before the question is asked, so a stale completion has already taken it',
  )
})
