/* ONE TURN BUILDER, TWO SURFACES, AND THE CLASS THAT TELLS THEM APART.
 *
 * src/views/home.js draws its turns with a single builder, on purpose: the
 * coordinator thread and the lines inside a run row must read in one register.
 * But the two sit in different places on the glass, and dressing them
 * identically is what was wrong before:
 *
 *   THE THREAD is the outermost conversation. Its lines own a 22px gutter for
 *     the speaker dot, and the person's own line and the product's action
 *     lines are nested inside a border, so a reader can see the shape of the
 *     exchange at a glance.
 *
 *   A RUN'S LINES are already inside a run row, which is itself indented,
 *     bordered and folded. Giving them the thread's gutter and the thread's
 *     borders nests a border inside a border and pushes every delegated line
 *     a second 22px to the right; what they actually need is the run's own
 *     18px delegation step, and no gutter at all (they carry no dot).
 *
 * So the builder takes a `surface` and stamps `thread-turn` or `run-turn`, and
 * src/home.css hangs the two dresses off those two classes rather than off the
 * shared `.turn`. That split is the single largest visual change on this
 * screen and NOTHING pinned it: tools/test/home-turns.test.mjs measures
 * turnSpeaker() and renderChatVoice() at a value level and never calls the
 * builder, and a repo-wide search for either class name found it only in the
 * two files that define it.
 *
 * WHAT THIS FILE DOES INSTEAD. It mounts the real screen over a real fixture
 * -- a coordinator thread AND this computer's run record, with a saved
 * transcript behind it -- and reads the classes off the nodes the view built.
 * Then it checks that the stylesheet still dresses the two surfaces apart,
 * because a class nothing styles is a class that has stopped doing its job.
 *
 * RUN IT:
 *   node tools/test/home-turn-surfaces.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { transcriptStorageKey } from '../../src/session-transcript-store.js'
import { fixture, mount, restoreGlobals, stored } from './helpers/home-view-harness.mjs'

const COMPUTER = 'fixture-one'
const SESSION = 'chat-a'
const STAMP = '2026-09-03T09:50:00.000Z'
const BRIEF = 'Check the build and report what broke.'

/* THE RUN RECORD this computer's ledger holds, in the shape bridge.history()
   answers with -- one start, resolved as started, carrying the join key that
   lets the row find the conversation. */
fixture.ledger = [{
  sequence: 41,
  at: STAMP,
  action: 'agent_session_start',
  sessionId: SESSION,
}]

/* THE NODE THE RUN BELONGS TO, and the transcript saved beside it. Both are
   read by src/session-roles.js off localStorage, under the keys their own
   modules spell, so the fixture cannot drift from the reader. */
stored.set(fleetTreesStorageKey(COMPUTER), JSON.stringify({
  version: 1,
  computerId: COMPUTER,
  trees: [{ id: 'tree-a', name: 'Work', createdAt: STAMP, updatedAt: STAMP, profileId: null }],
  nodes: [{
    id: 'node-a',
    treeId: 'tree-a',
    parentId: null,
    role: 'builder',
    message: BRIEF,
    status: 'finished',
    statusNote: '',
    reply: 'The second step failed.',
    tier: 'claude-sonnet',
    sessionId: SESSION,
    createdAt: STAMP,
    updatedAt: STAMP,
  }],
}))

/* The first line is the brief and the last agent line is the answer; the row
   prints those two itself, so describeRun trims them and the THREE in the
   middle are the ones drawn as turns. One of each voice, deliberately: the
   surface class must be decided by WHERE the turn is, never by WHO spoke. */
stored.set(transcriptStorageKey(COMPUTER), JSON.stringify({
  v: 1,
  nodes: {
    'node-a': {
      savedAt: Date.parse(STAMP),
      threadId: null,
      effort: null,
      lines: [
        { who: 'you', text: BRIEF, at: null },
        { who: 'you', text: 'And say which file.', at: null },
        { who: 'action', text: 'Read the build log', at: null, state: 'done', tool: 'Read' },
        { who: 'agent', text: 'Looking at step two now.', at: null },
        { who: 'agent', text: 'The second step failed.', at: null },
      ],
    },
  },
}))

const css = readFileSync(fileURLToPath(new URL('../../src/home.css', import.meta.url)), 'utf8')

/** A rule's body by its selector -- the slice-between-strings idiom
 *  tools/test/home-feed-dense-tokens.test.mjs uses on this same file. */
function ruleBody(selector) {
  const start = css.indexOf(selector)
  assert.ok(start >= 0, `selector not found in home.css: ${selector}`)
  const open = css.indexOf('{', start)
  return css.slice(open + 1, css.indexOf('}', open))
}

/* THE THREAD IS THE SHARED SURFACE NOW (owner: "the chat in the chat view needs
   to be the same as every chat surface in the app"): buildChat's .msg rows in
   .log-turns, never a .turn of this view's own. The run rows keep the view's
   run-turn painter, which is the split this suite exists to hold. */
const threadTurns = view => { const chat = view.el.querySelector('.log-turns').querySelector('.chat'); return chat ? chat.querySelector('.chat-log').querySelectorAll('.msg') : [] }
const runTurns = view => view.el.querySelector('.log-runs').querySelectorAll('.turn')
const shape = node => `${node.className}`

test('the fixture really puts both surfaces on the glass', async () => {
  /* Not an assertion about the split -- an assertion that the tests below are
     looking at something. Every one of them is vacuous if either list is
     empty, which is the failure mode a suite over a mounted view is most
     likely to hide. */
  const { view } = await mount()
  try {
    assert.equal(threadTurns(view).length, 3,
      `the coordinator thread must reach the pane; pane held: "${view.el.querySelector('.log-turns').textContent}"`)
    assert.equal(runTurns(view).length, 3,
      `the run's saved lines must reach the row; row held: "${view.el.querySelector('.log-runs').textContent}"`)
  } finally { view.destroy() }
})

test('every line in the coordinator thread is a row of the SHARED chat surface', async () => {
  const { view } = await mount()
  try {
    const lines = threadTurns(view)
    assert.equal(lines.length, 3, 'three lines, or the loop below asserts nothing')
    for (const turn of lines) {
      assert.ok(turn.classList.contains('msg'),
        `a thread line is buildChat's own row; carried: "${shape(turn)}"`)
      assert.equal(turn.classList.contains('run-turn'), false,
        `and never the run surface; carried: "${shape(turn)}"`)
    }
    assert.equal(view.el.querySelector('.log-turns').querySelectorAll('.turn').length, 0,
      'no row of the old thread painter remains in the thread')
  } finally { view.destroy() }
})

test("every line inside a run row is dressed as a run turn", async () => {
  const { view } = await mount()
  try {
    for (const turn of runTurns(view)) {
      assert.ok(turn.classList.contains('run-turn'),
        `a run line must carry the run surface; carried: "${shape(turn)}"`)
      assert.equal(turn.classList.contains('thread-turn'), false,
        `and never the thread surface -- that is a border inside a border and a`
        + ` second 22px indent; carried: "${shape(turn)}"`)
    }
  } finally { view.destroy() }
})

test('the surface is decided by where a turn is, never by who spoke', async () => {
  /* The same three voices appear on both surfaces. If the class were being
     chosen from the speaker, one of these two sets would come back mixed. */
  const { view } = await mount()
  try {
    const voicesOf = turns => turns
      .map(turn => ['is-owner', 'is-act', 'is-agent', 'is-coord'].find(cls => turn.classList.contains(cls)))
    const runVoices = voicesOf(runTurns(view))
    assert.deepEqual(runVoices, ['is-owner', 'is-act', 'is-agent'],
      `the run's three saved lines keep their own voices; got ${JSON.stringify(runVoices)}`)
    /* The shared surface names the same three voices in its own vocabulary:
       me (the person), note (a product line), them (the agent). */
    const sharedVoicesOf = turns => turns.map(turn => ['me', 'note', 'them'].find(cls => turn.classList.contains(cls)))
    assert.deepEqual(sharedVoicesOf(threadTurns(view)), ['me', 'note', 'them'],
      'and the thread keeps its own')
    assert.equal(runTurns(view).every(turn => turn.classList.contains('run-turn')), true,
      'three different voices, one surface')
    assert.equal(threadTurns(view).every(turn => turn.classList.contains('msg')), true,
      'three different voices, one surface')
  } finally { view.destroy() }
})

test('a turn still carries the shared class both surfaces are built on', async () => {
  /* The split is an ADDITION. `.turn` still carries everything the two
     surfaces agree about (the top margin, the body type scale), and dropping
     it while adding a surface class would silently undress both. */
  const { view } = await mount()
  try {
    /* Only the run rows are this view's own turns now; the thread's rows belong
       to the shared surface and wear its classes. */
    for (const turn of runTurns(view)) {
      assert.ok(turn.classList.contains('turn'), `every turn is still a turn; carried: "${shape(turn)}"`)
    }
    assert.match(ruleBody('.home .turn {'), /margin-top:/, 'and the shared rule is still what it dresses')
  } finally { view.destroy() }
})

test('the stylesheet dresses the thread surface, and only the thread surface', (t) => {
  /* The thread painter is gone (the thread is the shared surface now), so its
     .thread-turn rules in home.css are dead and belong to the frame lane to
     delete. Until they are, they must still not reach the run rows; once they
     are, there is nothing here to check and the test says so. */
  if (css.indexOf('.home .thread-turn {') < 0) { t.diagnostic('no .thread-turn rules remain in home.css: the dead thread dress has been removed'); return }
  const threadTurn = ruleBody('.home .thread-turn {')
  assert.match(threadTurn, /position:\s*relative/, 'the thread gutter needs a positioning context for its dot')
  assert.match(threadTurn, /padding:[^;]*22px/, 'the 22px gutter is the thread surface\'s own')
  assert.match(ruleBody('.home .thread-turn .turn-dot {'), /position:\s*absolute/,
    'the dot sits in that gutter rather than in the line')

  /* The bordered nesting -- the whole readable shape of the thread -- must
     hang off the SURFACE class. Hung off bare `.turn` it would reach every
     line inside every run row as well. */
  assert.match(ruleBody('.home .thread-turn.is-owner {'), /border-left:/,
    "the person's own thread line is the nested, bordered one")
  assert.match(ruleBody('.home .thread-turn.is-act {'), /border-left:/,
    'and so is the product\'s action line')
  assert.doesNotMatch(css, /\.home \.turn\.is-owner \{[^}]*border-left/,
    'a border on bare .turn.is-owner reaches the run rows too, which is the defect')
  assert.doesNotMatch(css, /\.home \.turn\.is-act \{[^}]*border-left/,
    'a border on bare .turn.is-act reaches the run rows too, which is the defect')
})

test('the stylesheet gives the run surface its own delegation step', () => {
  assert.match(ruleBody('.home .run-turn.is-agent, .home .run-turn.is-act {'), /margin-left:\s*18px/,
    'a run\'s report-backs and tool lines sit one step in from the two principals')
  if (css.indexOf('.home .thread-turn {') >= 0) assert.doesNotMatch(ruleBody('.home .thread-turn {'), /margin-left:\s*18px/,
    'and the thread does not inherit the run\'s step')
})

test.after(restoreGlobals)
