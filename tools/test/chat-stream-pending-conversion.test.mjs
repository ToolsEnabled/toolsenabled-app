/* A LIVE ROW CLAIMED TO BE THE AGENT'S ANSWER FROM ITS FIRST FRAME.
 *
 * openStream calls makeMsg('them', ...) the moment a stream opens, so the row
 * was categorised as agent speech before a single classified packet had
 * arrived. And because a row with no words yet matched
 * `.msg.them[aria-busy="true"]:has(.chat-msg-text:empty)`, it was hidden
 * outright: between a turn being accepted and its first packet -- which can
 * be seconds on a slow model -- the person was shown NOTHING, and a slow
 * start was indistinguishable from a turn that had died.
 *
 * A row now opens `pending`, visibly temporary, and converts when classified
 * content actually arrives. The invariant that makes that safe is the one
 * src/agent-session-events.js already keeps at the reading end ("a type
 * belongs to exactly one reader"): A CATEGORY IS DECIDED ONCE AND IS NEVER
 * REVISED. streamCategoryAfter is that rule as a function, and it is
 * exercised here by calling it -- including the case that matters most, an
 * empty repaint arriving after real words, which must NOT demote a message
 * the person has already read back into a placeholder.
 *
 * The DOM and CSS halves have no callable surface in this runtime (there is
 * no DOM here -- see chat-action-stream.test.mjs, which reads components.js
 * as text for the same reason) and are pinned structurally. Comments are
 * stripped before the sheet is scanned: an earlier scan in this group
 * matched its own prose and survived a mutation that removed what it checked.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { streamCategoryAfter } from '../../src/components.js'
import { STREAM_PENDING_NOTE } from '../../src/chat-copy.js'

const SRC = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'src')
const presentation = readFileSync(join(SRC, 'chat-presentation.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
const components = readFileSync(join(SRC, 'components.js'), 'utf8')

test('a row waiting on its first packet stays temporary', () => {
  assert.equal(streamCategoryAfter('pending', false), 'pending')
})

test('classified content converts the row', () => {
  assert.equal(streamCategoryAfter('pending', true), 'agent')
})

test('a category, once decided, is never revised', () => {
  /* The repaint that would otherwise do the damage: openStream's push()
     REPLACES the bubble text, so a turn that is cleared or repainted empty
     after speaking would send hasText false through a row a person has
     already read. Demoting it back to a "working" placeholder would erase
     an answer from the screen. */
  assert.equal(streamCategoryAfter('agent', false), 'agent')
  assert.equal(streamCategoryAfter('agent', true), 'agent')
})

test('a settled row is left alone entirely', () => {
  // close() deletes the attribute; a later repaint must not resurrect a
  // category on a row that is no longer live.
  for (const settled of [undefined, '', 'tool']) {
    assert.equal(streamCategoryAfter(settled, true), settled)
    assert.equal(streamCategoryAfter(settled, false), settled)
  }
})

test('the temporary row says what is happening and what comes next', () => {
  assert.ok(STREAM_PENDING_NOTE.trim().length > 0, 'the temporary row is blank, which is the defect it exists to fix')
  assert.ok(!/^\(|unavailable|unknown/i.test(STREAM_PENDING_NOTE),
    `the temporary row reads as a dead end: ${JSON.stringify(STREAM_PENDING_NOTE)}`)
})

test('a row opens temporary rather than claiming to be the answer', () => {
  assert.match(components, /message\.m\.dataset\.chatStream = 'pending'/,
    'openStream marks nothing as temporary, so the row is agent speech from its first frame')
  assert.match(components, /streamCategoryAfter\(m\.dataset\.chatStream, hasText\)/,
    'paint() never consults the category rule, so a temporary row can never convert')
})

test('a row restored from history is never demoted to temporary', () => {
  /* Reopening a settled history row must keep the category it already has.
     The pending mark is inside the `if (!message)` branch that BUILDS a new
     row; if it ever moved below that branch it would also stamp restored
     rows, and a reply the person had already read would revert to a
     placeholder the moment a late provider packet reopened it. */
  const build = components.slice(components.indexOf("let message = restored"))
  const mark = build.indexOf("message.m.dataset.chatStream = 'pending'")
  const branchEnd = build.indexOf('// Reusing history retains its original position')
  assert.ok(mark !== -1 && branchEnd !== -1, 'openStream no longer has the shape this checks')
  assert.ok(mark < branchEnd,
    'the pending mark is applied outside the new-row branch, so a restored history row is demoted to a placeholder')
})

test('the temporary row is visible, which is the whole point', () => {
  const hidden = presentation.match(/([^{}]*):has\(\.chat-msg-text:empty\)[^{}]*\{[^{}]*display:\s*none/)
  assert.ok(hidden, 'the empty-live-row rule is gone; this test no longer guards anything')
  assert.ok(hidden[0].includes(':not([data-chat-stream="pending"])'),
    'a temporary row still matches the empty-row hide, so the gap it exists to show is invisible again')
})

test('close() takes the live state off a settled row', () => {
  assert.match(components, /delete m\.dataset\.chatStream/,
    'a settled row keeps its live category, so the temporary styling and the live mark outlive the turn')
})
