/* WHO SPOKE ON THE FIRST PAGE, AND WHEN ONE TURN IS TOO BIG TO SIT WHOLE.
 *
 * Owner, 2026-09-03: "the pg1 full chat needs a full rework."
 *
 * src/chat-markdown.js's renderChatVoice() settled which RENDERER a turn's body
 * gets, by taking the turn's class instead of its speaker id, and
 * tools/test/home-chat-structure.test.mjs measures that on the mounted view.
 * Two defects sit upstream and downstream of it and are measured here, by
 * calling with values -- a speaker id and a message in, a class, a label and a
 * fold verdict out -- rather than by looking at how src/views/home.js spells
 * anything.
 *
 *   UPSTREAM: WHAT DECIDES THE CLASS. src/views/home.js resolved a thread
 *     speaker with `SPEAKERS[who] || { cls: 'is-agent', label: who }`, and
 *     SPEAKERS is only what the fleet profile declared. Two roads reach that
 *     pane with different vocabularies -- the run rows say 'you'/'action',
 *     the thread says 'owner'/'act' or whatever bridge actor recorded the
 *     line -- so on a profile that names no owner voice the person's own line
 *     resolved to `is-agent`, which is the agent's dress AND the markdown
 *     renderer. A turn carrying no sender resolved to `label: undefined`,
 *     which the painter reads as no label at all, so it was drawn as an
 *     unlabelled agent line and read as more of what the agent above it said.
 *
 *   DOWNSTREAM: A WALL OF TEXT COULD NOT BE PUT AWAY, on the one screen whose
 *     run list folds because the owner asked for exactly that.
 *
 * RUN IT:
 *   node --test tools/test/home-turns.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { renderChatVoice } from '../../src/chat-markdown.js'
import {
  TURN_FOLD_CHARS,
  TURN_FOLD_LINES,
  UNNAMED_SENDER,
  turnFold,
  turnSpeaker,
} from '../../src/home-turns.js'

const homeCss = readFileSync(new URL('../../src/home.css', import.meta.url), 'utf8')

/* The shape src/fleet-profile.js ships, reduced to the four entries this pane
   actually has to tell apart. Written out rather than imported so a profile
   edit cannot quietly change what these assertions mean. */
const PROFILE = {
  owner: { cls: 'is-owner', label: 'owner' },
  codex: { cls: 'is-coord', label: 'codex · coordinator', hue: 'var(--c-coordinator)' },
  'luna-02': { cls: 'is-agent', label: 'luna-02', hue: 'var(--c-manager)' },
  act: { cls: 'is-act', label: '' },
}

/* A profile that names its agents and NOT the person or the product -- which
   is every profile that is under no obligation to, and the state the floor
   under SPEAKERS exists for. */
const AGENTS_ONLY = { 'luna-02': { cls: 'is-agent', label: 'luna-02' } }

/* What a reader would see, given a speaker id and what was written: the
   resolved voice, and the body that voice's class gets. This is exactly what
   src/views/home.js turnNode() composes. */
const painted = (who, text, speakers = null) => {
  const speaker = turnSpeaker(who, speakers)
  return { ...speaker, body: renderChatVoice(speaker.cls, text) }
}

const TYPED = 'ship it -- 3 * 4 is 12, and _not_ a list:\n- one\n- two'

/* ------------------------------------------------------------------
   Upstream: what decides the class, in both vocabularies and with no
   profile help at all.
   ------------------------------------------------------------------ */

test("the person's own line lands in the person's register, in BOTH vocabularies", () => {
  for (const [who, speakers, where] of [
    ['you', null, 'run rows, no profile'],
    ['you', AGENTS_ONLY, 'run rows, profile names only agents'],
    ['owner', null, 'thread, no profile'],
    ['owner', AGENTS_ONLY, 'thread, profile names only agents'],
    ['owner', PROFILE, 'thread, profile names the owner'],
  ]) {
    const turn = painted(who, TYPED, speakers)
    assert.equal(turn.cls, 'is-owner', `"${who}" (${where}) is not painted in the person's own register`)
    assert.ok(turn.label, `"${who}" (${where}) was drawn with no name over it`)
    assert.ok(
      turn.body.includes('- one'),
      `the person typed "- one" and it was turned into markup (${where}): ${turn.body}`,
    )
    assert.ok(!/<ul|<li|<em|<strong/.test(turn.body), `the person's own line was restructured (${where}): ${turn.body}`)
  }
})

test("the product's own action lines are one clause, not markdown, in BOTH vocabularies", () => {
  const line = 'read sample/questions/open.md -- 3 * 4 matches, _open_'
  for (const [who, speakers] of [
    ['action', null], ['action', AGENTS_ONLY], ['act', null], ['act', AGENTS_ONLY], ['act', PROFILE],
  ]) {
    const turn = painted(who, line, speakers)
    assert.equal(turn.cls, 'is-act', `"${who}" is not painted as an action line`)
    assert.equal(turn.label, '', 'an action line was given a speaker label')
    assert.ok(turn.body.includes('3 * 4'), `an action line lost its own characters: ${turn.body}`)
    assert.ok(!/<em|<strong/.test(turn.body), `an action line was read as markdown: ${turn.body}`)
  }
})

test('an agent IS drawn the way it wrote, because agents write markdown', () => {
  const turn = painted('luna-02', '## Findings\n\n- one\n- two\n\n`--gates-only` ran clean', PROFILE)
  assert.equal(turn.cls, 'is-agent')
  assert.ok(turn.body.includes('md-h'), `a heading arrived as its own hash marks: ${turn.body}`)
  assert.ok(turn.body.includes('<ul'), `a list arrived as a row of hyphens: ${turn.body}`)
  assert.ok(turn.body.includes('md-code'), `a code span arrived as backticks: ${turn.body}`)
  assert.ok(!turn.body.includes('## Findings'), "the heading markers were left in the reader's way")
})

test('an agent nobody has named still reads as an agent, under its own id', () => {
  const turn = painted('sandbox-w1', 'done', PROFILE)
  assert.equal(turn.cls, 'is-agent')
  assert.equal(turn.label, 'sandbox-w1', 'an undeclared agent lost the only name it had')
})

test('a fleet names its own cast and the floor under it never overrides one', () => {
  assert.equal(turnSpeaker('owner', PROFILE).label, 'owner', "the profile's own label for the owner was replaced")
  assert.equal(turnSpeaker('owner', null).label, 'You', 'a profile that names no owner leaves the line unlabelled')
  assert.equal(turnSpeaker('act', PROFILE).label, '', 'an action line was given a label it is meant not to have')
  assert.equal(turnSpeaker('codex', PROFILE).cls, 'is-coord', "a declared voice lost the profile's own class")
  assert.equal(turnSpeaker('codex', PROFILE).hue, 'var(--c-coordinator)', "a declared voice lost the profile's own colour")
})

test('a turn that names no sender says so instead of reading as the agent above it', () => {
  for (const who of [undefined, null, '', '   ']) {
    const turn = turnSpeaker(who, PROFILE)
    assert.equal(turn.named, false, `"${String(who)}" was reported as an identified speaker`)
    assert.equal(turn.label, UNNAMED_SENDER)
    assert.ok(turn.label, 'an unattributed turn was painted with no label at all')
  }
})

/* ------------------------------------------------------------------
   Downstream: a wall of text can be put away.
   ------------------------------------------------------------------ */

test('an ordinary reply is not folded', () => {
  assert.equal(turnFold('Reading the evidence tree before claiming anything.'), null)
  assert.equal(turnFold(''), null)
  assert.equal(turnFold('one\ntwo\nthree'), null)
})

test('a wall of lines can be put away, and says how much of it there is', () => {
  const wall = Array.from({ length: TURN_FOLD_LINES + 4 }, (_value, index) => `line ${index}`).join('\n')
  const fold = turnFold(wall)
  assert.ok(fold, 'a reply of more than a screenful had no way to be collapsed')
  assert.equal(fold.lines, TURN_FOLD_LINES + 4)
  assert.match(fold.label, /\d+ lines/, `the closed fold does not say what is inside it: ${fold.label}`)
})

test('one very long line is a wall too', () => {
  const essay = 'x'.repeat(TURN_FOLD_CHARS + 1)
  const fold = turnFold(essay)
  assert.ok(fold, 'a single paragraph long enough to fill the pane had no way to be collapsed')
  assert.match(fold.label, /\d+ characters/)
})

/* ------------------------------------------------------------------
   The dress. Computed appearance needs a browser; these stay narrowly on the
   distinctions the decisions above are useless without.
   ------------------------------------------------------------------ */

test('every register this pane can paint has a rule of its own', () => {
  const emitted = new Set([
    turnSpeaker('you').cls,
    turnSpeaker('owner').cls,
    turnSpeaker('action').cls,
    turnSpeaker('act').cls,
    turnSpeaker('anyone-else').cls,
    turnSpeaker('').cls,
  ])
  assert.deepEqual([...emitted].sort(), ['is-act', 'is-agent', 'is-owner'])
  for (const cls of emitted) {
    assert.match(homeCss, new RegExp(`\\.turn\\.${cls}\\b`), `.turn.${cls} has no rule; that register paints as bare text`)
  }
})

test('the fold a long turn gets is the fold this screen already uses', () => {
  assert.match(homeCss, /\.turn-fold\s*>\s*\.turn-fold-head\s*\{/, 'the long-turn fold has no head rule, so it is an unstyled summary')
  assert.match(homeCss, /\.turn-fold\[open\][^{]*\.chat-action-mark svg/, 'the fold mark does not turn, so nothing says the turn is open')
})
