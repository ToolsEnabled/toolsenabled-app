/* COMING BACK TO AN AGENT MUST NOT DELETE THE CONVERSATION IT IS COMING BACK TO.
 *
 * THE DEFECT, driven on a packaged build from HEAD (lap 3, node #2). Close the
 * app, reopen it, open a node whose agent has ended, type one more question and
 * press Send. The engine still holds the thread, so the resume is a real one --
 * and the chat came back MISSING the person's opening request and the only row
 * showing what the agent actually did:
 *
 *   before, 6 rows   YOU "Read notes.md ... which items are still unfinished."
 *                    ADDED BY THE TREE · 105 words
 *                    COMMAND Get-Content -LiteralPath .\notes.md   finished
 *                    COORDINATOR "I'll read notes.md ..."
 *                    YOU "Which of those three should I do first, and why?"
 *                    COORDINATOR "Call the tiler first ..."
 *
 *   after,  4 rows   ADDED BY THE TREE · 442 words      <- the person's request
 *                    COORDINATOR "I'll read notes.md ..."   is now INSIDE this
 *                    YOU "Which of those three ..."         collapsed aside
 *                    COORDINATOR "Call the tiler first ..."
 *
 * It survived a relaunch, because the shortened list was written straight over
 * the durable record.
 *
 * THE CAUSE, measured rather than read. src/views/computers.js replaced the
 * kept excerpt with lines rebuilt from `engineResumed.turns[].said`, on the
 * stated belief that the engine's turns are "longer and truer than the excerpt
 * we kept". They are neither. `said` is a DIFFERENT PROJECTION, and the engine
 * says so itself -- src/lib/agent-engine/codex-adapter.js, parseThreadTurn:
 * only `userMessage` and `agentMessage` items are kept, "anything richer (tool
 * payloads, reasoning) is deliberately left on the engine side -- this crosses
 * into a UI", which the engine's own suite pins ("only what was said crosses
 * into a UI"). So a rebuild from `said`:
 *
 *   - cannot contain a single `who:'action'` row, because none crossed the wire;
 *   - returns the product's TWO opening `you` lines (the person's words, then
 *     the tree address block) as the ONE user message that went out, which
 *     markTreeContext then folds shut whole -- readTreeAddress matches the
 *     address line anywhere in the blob, so the person's own question is drawn
 *     inside the plumbing aside;
 *   - carries no timestamps, so a restored action row cannot rejoin the live
 *     buffer that still holds its output.
 *
 * THE RULE NOW. A resume that really restored the thread changed nothing about
 * the past, so the conversation on screen must not change either: the kept
 * excerpt IS the record and it wins. The engine's turns are used for exactly
 * the case they were added for -- a thread the engine still has and this
 * computer has no record of.
 *
 * Nothing here touches a DOM, a store or a bridge, so the suite drives the real
 * rule; the durable half is driven through the real transcript store.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readAccountList } from '../../src/account-switcher-state.js'
import { resumedTranscriptLines } from '../../src/tree-resume-transcript.js'
import { createTranscriptStore } from '../../src/session-transcript-store.js'
import { nodeManagerContext, readTreeAddress } from '../../src/tree-node-brief.js'

const ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

const MARKER = 'A fresh agent read the conversation above.'
const TREE_CONTEXT = nodeManagerContext({ me: 'Coordinator', manager: null, children: [], treeName: 'walk' })
const ASKED = 'Read notes.md in this folder and tell me which items are still unfinished.'

/* The six rows the driver photographed, in the shape the record keeps them. */
const savedLines = () => ([
  { who: 'you', text: ASKED, at: 1_000 },
  { who: 'you', text: TREE_CONTEXT, at: 1_001 },
  { who: 'action', tool: 'Command', text: "Get-Content -LiteralPath '.\\notes.md'", at: 1_002, state: 'finished' },
  { who: 'agent', text: "I'll read notes.md and list only the items that are not marked complete.", at: 1_003 },
  { who: 'you', text: 'Which of those three should I do first, and why?', at: 1_004 },
  { who: 'agent', text: 'Call the tiler first, because the samples take two weeks.', at: 1_005 },
])

/* WHAT A REAL RESUME HANDS BACK, in the shape codex-adapter.js builds it:
   speech only, and the product's two opening `you` lines as the one user
   message that actually went out. Driven against the real CodexAdapter over a
   fake transport while this was being fixed; it is written out here because the
   engine lives in the capability payload, which is staged and not in this
   repository. */
const engineResumedFor = lines => ({
  turnCount: 2,
  turns: [
    {
      id: 'turn-1',
      said: [
        { who: 'you', text: `${ASKED}\n\n${TREE_CONTEXT}` },
        { who: 'agent', text: lines[3].text },
      ],
    },
    { id: 'turn-2', said: [{ who: 'you', text: lines[4].text }, { who: 'agent', text: lines[5].text }] },
  ],
})

const countBy = lines => lines.reduce((acc, line) => ({ ...acc, [line.who]: (acc[line.who] || 0) + 1 }), {})

function freshStore() {
  const cells = new Map()
  return createTranscriptStore({
    computerId: 'suite',
    storage: {
      read: key => (cells.has(key) ? cells.get(key) : null),
      write: (key, value) => { cells.set(key, JSON.parse(JSON.stringify(value))); return true },
    },
  })
}

test('a real resume keeps every row the person had, tool actions included', () => {
  const kept = savedLines()
  const lines = resumedTranscriptLines({ engineResumed: engineResumedFor(kept), savedLines: kept, marker: MARKER })
  assert.equal(lines.length, kept.length,
    `the resume rewrote the conversation: ${kept.length} rows in, ${lines.length} out (${JSON.stringify(countBy(lines))})`)
  assert.equal(lines.filter(line => line.who === 'action').length, 1,
    'the row showing what the agent DID is gone; `said` never carried it, so rebuilding from `said` deletes it')
  assert.ok(lines.some(line => line.who === 'you' && line.text === ASKED),
    "the person's opening request is no longer a row of its own")
  assert.deepEqual(lines.map(line => line.at), kept.map(line => line.at),
    'the restored rows lost their timestamps, so an action row can no longer rejoin the output the window still holds')
})

test("the person's own words do not end up folded inside the tree's plumbing aside", () => {
  /* markTreeContext relabels a `you` line the moment readTreeAddress finds the
     address contract ANYWHERE in it -- the pattern is multiline-anchored. So a
     merged user turn is drawn as one collapsed "added by the tree" aside with
     the person's question inside it, which is what the driver photographed:
     the conversation opened on an answer to a question that was nowhere. */
  assert.equal(readTreeAddress(ASKED), null, 'the question alone is not tree plumbing')
  assert.ok(readTreeAddress(`${ASKED}\n\n${TREE_CONTEXT}`),
    'a merged user turn reads as tree plumbing whole — this is why it must not become a row')

  const kept = savedLines()
  const lines = resumedTranscriptLines({ engineResumed: engineResumedFor(kept), savedLines: kept, marker: MARKER })
  const asked = lines.find(line => line.who === 'you' && line.text === ASKED)
  assert.ok(asked, "the person's request did not survive as its own row")
  assert.equal(readTreeAddress(asked.text), null,
    "the person's request came back merged with the tree block, so the chat folds it shut")
})

test('the durable record does not shrink when a person comes back to an agent', () => {
  /* THE HALF THAT MADE IT PERMANENT. computers.js calls persistTranscript()
     immediately after this decision, and transcriptStore.save REPLACES a
     node's record whole. A shorter list therefore does not merely draw wrong
     once -- it is written over the only copy. */
  const store = freshStore()
  const kept = savedLines()
  store.save('node-2', { lines: kept, threadId: 'thread-walk-1', effort: 'medium' })
  const before = store.get('node-2').lines

  const resumedLines = resumedTranscriptLines({ engineResumed: engineResumedFor(kept), savedLines: before, marker: MARKER })
  store.save('node-2', { lines: resumedLines, threadId: 'thread-walk-1', effort: 'medium' })
  const after = store.get('node-2').lines

  assert.ok(after.length >= before.length,
    `the resume wrote a shorter conversation over the record: ${before.length} -> ${after.length}`)
  assert.equal(after.filter(line => line.who === 'action').length, before.filter(line => line.who === 'action').length,
    'the saved record lost its action rows, and a relaunch reads this file')
  assert.ok(after.some(line => line.who === 'you' && line.text === ASKED),
    "the saved record lost the person's opening request")
})

test('a thread this computer has no record of still comes back from the engine', () => {
  /* The case engine-side resume was built for, unchanged: no excerpt to keep,
     so the engine's turns are the only history there is. */
  const kept = savedLines()
  const lines = resumedTranscriptLines({ engineResumed: engineResumedFor(kept), savedLines: [], marker: MARKER })
  assert.equal(lines.length, 4, 'a resume with nothing saved no longer restores the thread the engine still holds')
  assert.deepEqual(lines.map(line => line.who), ['you', 'agent', 'you', 'agent'])
})

test('the summary fallback still says a fresh agent read the conversation', () => {
  /* No engine thread: a NEW agent is seeded with the excerpt, and the marker
     line is what tells the person that is what happened. */
  const kept = savedLines()
  const lines = resumedTranscriptLines({ engineResumed: null, savedLines: kept, marker: MARKER, now: 9_000 })
  assert.equal(lines.length, kept.length + 1)
  assert.deepEqual(lines[lines.length - 1], { who: 'you', text: MARKER, at: 9_000 })
})

test('nothing saved and no engine thread is an empty conversation, still said out loud', () => {
  assert.deepEqual(resumedTranscriptLines({ engineResumed: null, savedLines: [], marker: MARKER }), [])
})

test('the view asks this module rather than deciding it again', () => {
  /* A CSS loader hook makes src/views/computers.js importable under Node, but
     resumeNodeSession is closure-private inside computersView. Exercising this
     delegation as behaviour therefore still needs either a focused view
     harness that can reach the Resume control or a callable sibling helper;
     until then this test pins the wiring at the source level. */
  assert.match(view, /from '\.\.\/tree-resume-transcript\.js'/,
    'the view no longer imports the resume rule; it is deciding the conversation again')
  const resume = view.slice(view.indexOf('async function resumeNodeSession'), view.indexOf('async function runPaletteAction'))
  assert.match(resume, /resumedTranscriptLines\(\{/, 'resumeNodeSession stopped asking the shared rule')
  assert.ok(!/engineResumed\s*\n\s*\?\s*engineResumed\.turns\.flatMap/.test(resume),
    'the in-view rebuild from engineResumed.turns is back; a resume deletes the conversation again')
})

test('the view resumes a thread with its saved account owner and keeps the returned owner with the new session', () => {
  const resume = view.slice(view.indexOf('async function resumeNodeSession'), view.indexOf('async function runPaletteAction'))
  assert.match(resume, /resumeAccount:\s*saved\.account/,
    'Resume still sends only the thread id, so account rotation can launch it from another provider home')
  assert.match(resume, /sessionAccountNames\.set\(result\.sessionId, result\.account \|\| null\)/,
    'the account returned by a successful resume is not kept with the replacement session')

  const persist = view.slice(view.indexOf('function persistTranscript'), view.indexOf('const tierEffortOf'))
  assert.match(persist, /account:\s*sessionAccountNames\.has\(sessionId\)/,
    'the account that created a provider thread is not written beside that thread')
})

/* ---- "KEEP TRYING" MUST BE ASKED, AND A FAILED ASK IS NOT A YES ----
 *
 * WHAT THIS DEFENDS. One answer decides whether the program moves somebody's
 * conversation to another account without asking them. The cases below are
 * written failure-first on purpose: every way of FAILING to learn the answer has
 * to come back false, because those are the cases that happen when something is
 * already broken, and that is exactly when the person least wants their work
 * moved underneath them.
 *
 * WHY THE REAL FUNCTION IS EXECUTED rather than its source matched. A regex over
 * the file would pass against code that reads the setting and then ignores it --
 * the same nothing-measured defect as a check that cannot fail. So the function
 * is sliced out and RUN, with the product's own readAccountList doing the policy
 * parsing, and only the bridge replaced.
 *
 * WHY NOT loadAccounts(), asserted below as well as commented: a throwing bridge
 * and a successful empty answer both come back from it as readAccountList(null),
 * whose policy reads autoRecoverOnLimit true. Anything built on it would read a
 * broken settings read as consent. */
test('keep-trying is only consent when the read SUCCEEDS and says so, never when it fails', async () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'views', 'computers.js'), 'utf8')
  const from = source.indexOf('  async function keepTryingOnLimitIsOn() {')
  assert.ok(from > 0, 'the consent read must still be findable in computers.js')
  const end = source.indexOf('\n  }\n', from)
  assert.ok(end > from, 'the consent read must be a closed function')
  const body = source.slice(from, end + 4)

  const run = async bridge => {
    const context = { accountsBridge: () => bridge, readAccountList, Array, Object }
    vm.runInNewContext(`${body}; this.ask = keepTryingOnLimitIsOn`, context)
    return context.ask()
  }

  // ---- EVERY FAILURE TO LEARN THE ANSWER IS A NO. These come first because
  // they are the cases that fire when the computer is already in trouble.
  assert.equal(await run(null), false, 'no accounts bridge at all')
  assert.equal(await run({}), false, 'a bridge that cannot be asked')
  assert.equal(await run({ accounts: 'not a function' }), false, 'a bridge whose door is not callable')
  assert.equal(await run({ accounts: () => { throw new Error('settings unreadable') } }), false, 'a read that throws')
  assert.equal(await run({ accounts: async () => { throw new Error('storage gone') } }), false, 'an async read that rejects')
  assert.equal(await run({ accounts: async () => null }), false, 'an answer of null')
  assert.equal(await run({ accounts: async () => undefined }), false, 'no answer at all')
  assert.equal(await run({ accounts: async () => 'yes' }), false, 'an answer that is not an object')
  assert.equal(await run({ accounts: async () => [] }), false, 'an answer that is an array')
  /* THE ONE MY OWN FIRST DRAFT GOT WRONG. An object that is not a real list read
     falls to readAccountList's NO_POLICY, whose autoRecoverOnLimit is true for
     drawing reasons. Consent must require a list that actually read. */
  assert.equal(await run({ accounts: async () => ({}) }), false, 'an object that is not a list read')
  assert.equal(await run({ accounts: async () => ({ ok: false, accounts: [] }) }), false, 'a list read that failed')
  assert.equal(await run({ accounts: async () => ({ ok: true }) }), false, 'an answer with no accounts array')

  // ---- AN EXPLICIT NO IS OBEYED. Somebody decided; that decision stands.
  assert.equal(await run({ accounts: async () => ({ ok: true, accounts: [], policy: { policy: { recorded: true, autoRecoverOnLimit: false } } }) }), false,
    'keep-trying turned off by a person')

  // ---- AND A SUCCESSFUL READ THAT REPORTS NO DECISION IS YES, which is not a
  // contradiction: keep-trying is on by default and persistent, and "nobody
  // decided" is a fact the shell told us. "I could not ask" is not.
  assert.equal(await run({ accounts: async () => ({ ok: true, accounts: [], policy: { policy: { recorded: true, autoRecoverOnLimit: true } } }) }), true,
    'keep-trying explicitly on')
  assert.equal(await run({ accounts: async () => ({ ok: true, accounts: [] }) }), true,
    'a successful read where nobody has decided')

  /* THE TRAP THIS AVOIDS, asserted rather than described: loadAccounts cannot
     tell a broken read from an empty one, so its policy says "on" for both. */
  assert.equal(readAccountList(null).policy.autoRecoverOnLimit, true)
  assert.equal(readAccountList(null).policy.recorded, false)
})
