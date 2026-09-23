/* THE MODEL'S OWN WORKING, SHOWN -- AND NEVER MISTAKEN FOR THE ANSWER.
 *
 * Lane: thinking-visible. The owner wants the model's thinking shown, and
 * engine/src/lib/agent-engine/claude-cli-adapter.js now forwards it as its
 * own `thinking` event type rather than dropping it or folding it into
 * assistant speech (engine-contract.js's EVENT_TYPES, landed 2026-09-03; the
 * capability/ copy this app vendors is byte-identical) -- but forwarding it
 * as a type is not the same as showing it, and nothing painted it before this.
 *
 * This file proves the RECEIVING side built for that event, and proves the
 * one property that must survive however the wiring is read: thinking is its
 * own painted entry, never a paragraph folded into the answer bubble.
 *
 *   node --test tools/test/agent-thinking-aside.test.mjs
 *
 * Two techniques, for the two halves of the change:
 *  - src/components.js's addThinking is DOM-mounting code, proven by REAL
 *    EXECUTION through the same DOM stand-in tools/test/chat-msg-text-
 *    newlines.test.mjs already established for buildChat() -- built through
 *    buildChat() itself, not assumed, the same discipline that file documents
 *    at length in its own header.
 *  - src/views/agent.js's composer wiring reaches a live `window.mcAgent`
 *    bridge this suite does not have (see tools/test/agent-session-panel.
 *    test.mjs's header for why: `node --test` carries no jsdom, so nothing
 *    in this tree calls that composer's listener directly). It is proven on
 *    the source text instead, the same way tools/test/tree-chat-transcript.
 *    test.mjs already pins this exact composer's message-boundary wiring --
 *    each assertion below is mutation-refuted the same way: broken in the
 *    module, confirmed red, restored, confirmed green.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const standInModule = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(standInModule)
const { document, restore } = installDomStandIn(globalThis)
const components = new Map()

after(() => {
  for (const [root, dispose] of components) { dispose(); root.remove() }
  restore()
})

const { buildChat } = await import('../../src/components.js')
const styles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')


function chat(options) {
  const root = buildChat(options)
  components.set(root, root.dispose)
  document.documentElement.appendChild(root)
  return root
}
function disposeChat(root) {
  const dispose = components.get(root)
  dispose()
  components.delete(root)
  root.remove()
}

/* The FIRST top-level `selector { ... }` rule body for an exact selector
   string, matching tools/test/chat-msg-text-newlines.test.mjs's own helper. */
function ruleBody(css, selector) {
  const needle = `${selector} {`
  const start = css.indexOf(needle)
  if (start === -1) return null
  const openBrace = start + needle.length - 1
  const close = css.indexOf('}', openBrace)
  if (close === -1) return null
  return css.slice(openBrace + 1, close)
}

// ------------------------------------------------------------------
// (a) src/components.js's addThinking -- real execution against buildChat().
// ------------------------------------------------------------------

test('addThinking paints its own entry, labelled "Thinking", never the agent\'s name', () => {
  const root = chat({ title: 'agent-x', seed: 0 })
  const painted = root.addThinking('Weighing two approaches before answering.')
  assert.ok(painted, 'addThinking must report the row it painted')
  const row = root.querySelector('.thinking')
  assert.ok(row, 'no ".thinking" row reached the log -- addThinking painted nothing a reader could see')
  assert.equal(row.querySelector('.who')?.textContent, 'Thinking', 'the row must be labelled "Thinking", never the agent\'s own name')
  assert.match(row.querySelector('.chat-msg-text')?.textContent || '', /Weighing two approaches/, 'the thinking text itself must reach the row')
  disposeChat(root)
})

test('a blank or whitespace-only thought paints nothing -- a turn that thought nothing leaves no empty aside', () => {
  const root = chat({ title: 'agent-x', seed: 0 })
  assert.equal(root.addThinking(''), null, 'empty text must not paint a row')
  assert.equal(root.addThinking('   \n  '), null, 'whitespace-only text must not paint a row')
  assert.equal(root.addThinking(null), null, 'a non-string must not paint a row')
  assert.equal(root.addThinking(undefined), null, 'a missing argument must not paint a row')
  assert.equal(root.querySelector('.thinking'), null, 'no whitespace-only call may have left a row behind')
  disposeChat(root)
})

test('thinking and the real answer are two separate rows, never one bubble wearing two voices', () => {
  const root = chat({ title: 'agent-x', seed: 0 })
  root.addThinking('First, consider the failing case.')
  const stream = root.openStream({ at: Date.now() })
  stream.close('Here is the answer.')
  const thinkingRow = root.querySelector('.thinking')
  const answerRow = root.querySelector('.them')
  assert.ok(thinkingRow, 'the thinking row must still be there once the answer arrives')
  assert.ok(answerRow, 'the answer must still reach its own row')
  assert.notEqual(thinkingRow, answerRow, 'thinking and the answer must be two distinct elements')
  assert.equal(thinkingRow.classList.contains('them'), false, 'the thinking row must not also carry the answer\'s own class')
  assert.equal(answerRow.classList.contains('thinking'), false, 'the answer row must not carry the thinking class')
  assert.match(answerRow.querySelector('.chat-msg-text')?.textContent || '', /Here is the answer/, 'the answer text must land in the answer row, not the thinking row')
  assert.doesNotMatch(thinkingRow.querySelector('.chat-msg-text')?.textContent || '', /Here is the answer/, 'the answer text must not also appear inside the thinking row')
  disposeChat(root)
})

test('a thought is escaped exactly like every other message body -- the model\'s own words are not a markup surface', () => {
  const root = chat({ title: 'agent-x', seed: 0 })
  root.addThinking('Considering <script>alert(1)</script> as a red flag.')
  const body = root.querySelector('.thinking .chat-msg-text')
  assert.ok(body, 'the thinking body must still be reachable once the text carries markup-shaped characters')
  // The stand-in's innerHTML recognises real start/end tags by name; a
  // properly ESCAPED string contains no real "<", so parsing it can create no
  // SCRIPT element -- the angle brackets can only survive as the literal,
  // inert text formatInlineText's escapeAll produced. (formatInlineText's own
  // -- unrelated -- number highlighting legitimately wraps the "1" in its own
  // real <span>, so "no child elements at all" is not the right test here.)
  assert.ok(!body.children.some(child => child.tagName === 'SCRIPT'), 'an unescaped "<script>" would parse into a real SCRIPT element -- one must not exist')
  assert.match(body.textContent, /&lt;script&gt;/, 'the angle brackets must survive escaped, the same rule formatInlineText applies everywhere else')
  disposeChat(root)
})

// ------------------------------------------------------------------
// (b) src/components.js -- addThinking is part of the public contract.
// ------------------------------------------------------------------

test('addThinking is exposed on the built chat, not left as an unreachable internal helper', () => {
  const componentSource = readFileSync(new URL('../../src/components.js', import.meta.url), 'utf8')
  assert.match(componentSource, /Object\.defineProperty\(root, 'addThinking', \{ value: addThinking \}\)/,
    'addThinking must be defined on root the same way addAction, addDiff and openStream already are')
})

// ------------------------------------------------------------------
// (c) src/styles.css -- the aside family, deliberately, not the answer's dress.
// ------------------------------------------------------------------

test('.msg.thinking is dressed as a quiet aside (the .msg.context/.msg.note family), not as the agent\'s own bubble', () => {
  const body = ruleBody(styles, '.msg.thinking')
  assert.ok(body !== null, 'no top-level ".msg.thinking {" rule in src/styles.css -- addThinking\'s row has no dress of its own and would fall back to the agent\'s')
  assert.match(body, /color:\s*var\(--ink-25\)/, 'thinking must read in the same muted ink as the rest of the aside family, not full-strength text colour')
  assert.match(body, /border:\s*1px dashed/, 'thinking must carry the aside family\'s dashed border, the same visual promise .msg.context and .msg.note already make')
  assert.match(body, /font-style:\s*italic/, 'italic is the one property that still reads even if a person\'s eye skips straight past the label -- see the rule\'s own comment')
})

test('.msg.thinking never inherits the agent bubble\'s coloured speaker dot', () => {
  // .msg.them::before paints the round mark in --chat-role; .msg.thinking must
  // not be reachable through that selector, or a thinking row would carry the
  // same speaker mark as a real answer.
  const markStart = styles.indexOf('.msg.them::before')
  assert.ok(markStart >= 0, 'the speaker-mark rule this test guards against moved or was renamed -- re-anchor before trusting the assertion below')
  const markRule = styles.slice(markStart, styles.indexOf('}', markStart) + 1)
  assert.doesNotMatch(markRule, /\.thinking/, '.msg.thinking must not be added to the selector that paints the agent\'s coloured speaker dot')
})

// ------------------------------------------------------------------
// (d) src/views/agent.js -- the composer's wiring, pinned on the source text.
// ------------------------------------------------------------------

// Live Agent page snapshot routing is exercised against its actual functions in
// thinking-transcript-pipeline.test.mjs, including interruption and turn reset.
