/* AN AGENT'S TURN, DRAWN AS THE AGENT WROTE IT -- ON EVERY buildChat() WINDOW,
 * NOT JUST THE ONE ON THE HOME PAGE.
 *
 * Owner, 2026-09-03: "chat formatting needs to be fixed - its messy right
 * now", and a minute later, "try your best to make it formatted cleanly in
 * your inline response since thats exactly part of the messy issue i meant
 * earlier".
 *
 * tools/test/chat-msg-text-newlines.test.mjs pinned the first half of this
 * defect on this surface: a reply's own line breaks now survive on every
 * buildChat() window (the agent page, the tree node chat popup, the
 * computers page -- src/styles.css's own comment above `.chat-msg-text`
 * names all three). This file pins the half that comment left open: the
 * MARKUP itself.
 *
 * MEASURED before this round: formatInlineText('## Findings\n\n- one\n- two')
 * returns '## Findings' and '- one' and '- two' as literal, undecorated
 * punctuation -- it highlights paths, ids and numbers, and has no idea what a
 * heading or a list is. src/chat-markdown.js already existed, was already
 * safe (escapes first, builds markup only from its own literals -- see that
 * file's header and tools/test/chat-markdown.test.mjs, neither repeated
 * here), and was already wired into exactly one place: src/views/home.js.
 *
 * This suite pins that src/components.js makeMsg() now draws an AGENT turn
 * with that same function, that the person's own words are untouched by it
 * (an agent's markdown and a person's literal asterisks are different rules,
 * not one rule turned off), and that the CSS the rendered blocks need to be
 * scannable -- paragraph spacing, list spacing, a code block that scrolls
 * instead of widening the panel -- actually exists under `.chat-msg-text`.
 *
 *   node --test tools/test/chat-msg-markdown.test.mjs
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
const styles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8') + readFileSync(new URL('../../src/chat-content.css', import.meta.url), 'utf8')

/* Assertions below read structure (querySelectorAll, which walks the real
   children dom-stand-in.mjs builds) and .textContent (built from the same
   children) rather than the .innerHTML GETTER: dom-stand-in.mjs's own
   replaceChildren() resets `_text` to '' as part of clearing the old
   children, and the innerHTML setter never restores it afterward, so that
   getter reads back '' for markup whose top-level parse is all elements --
   which block markup always is. MEASURED with a standalone repro against
   this exact harness: querySelectorAll/.textContent see the real tree;
   .innerHTML does not. A harness bug, not a src/components.js one -- see
   this file's own header for why it is worked around here rather than
   fixed in shared test infrastructure this round. */

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
/* Grounded in real buildChat() markup, the same way
   tools/test/chat-msg-text-newlines.test.mjs is -- never assumed. */
function messageBody(root, from) {
  const row = root.querySelector('.chat-log').children
    .find(node => node.classList.contains('msg') && node.classList.contains(from))
  assert.ok(row, `no .msg.${from} row was built from history -- cannot ground the assertions below in real markup`)
  const body = row.querySelector('.chat-msg-text')
  assert.ok(body, '.chat-msg-text is gone from makeMsg')
  return body
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

test('an agent turn is drawn through src/chat-markdown.js, not formatInlineText', () => {
  const text = '## Findings\n\nThe run **passed**.\n\n- checked the logs\n- restarted the worker'
  const root = chat({ title: 'agent-x', seed: 0, history: [{ who: 'agent', text }] })
  const body = messageBody(root, 'them')
  assert.equal(body.querySelectorAll('.md-h').length, 1, 'the heading is drawn as a heading, in real markup')
  assert.equal(body.querySelectorAll('.md-list li').length, 2, 'the list is drawn as a list of two items, in real markup')
  assert.equal(body.querySelectorAll('strong').length, 1, 'the emphasis is drawn as emphasis, in real markup')
  /* Words either side of an inline tag boundary, not asserted together: this
     harness's own parser trims each text token at the point it is split from
     its neighbour (dom-stand-in.mjs's own header: "text-node fidelity ...
     out of scope"), so "run " ahead of <strong> loses its trailing space
     here though a real browser would not. That is a harness simplification,
     not a rendering defect -- see chat-markdown.test.mjs for renderChatMarkdown
     tested on its own output, where no such splitting happens. */
  assert.match(body.textContent, /Findings/, 'the heading text must still reach the glass')
  assert.match(body.textContent, /passed/, 'the paragraph text must still reach the glass')
  assert.match(body.textContent, /checked the logs/, 'and so must every list item')
  assert.match(body.textContent, /restarted the worker/, 'and so must every list item')
  assert.ok(!body.textContent.includes('##'), 'the heading marker must not survive as literal text')
  assert.ok(!body.textContent.includes('**'), 'the emphasis marker must not survive as literal text')
  disposeChat(root)
})

test('the message body is a div, not a span -- block markup cannot legally sit inside an inline element', () => {
  const root = chat({ title: 'agent-x', seed: 0, history: [{ who: 'agent', text: 'hello' }] })
  const body = messageBody(root, 'them')
  assert.equal(body.tagName, 'DIV', `chat-msg-text must be able to hold <p>/<ul>/<pre>; was <${body.tagName?.toLowerCase()}>`)
  disposeChat(root)
})

test('a person typing markdown-shaped characters gets those characters back, not markup', () => {
  /* The other half of the same rule (src/chat-markdown.js's own header): an
     agent's markdown is drawn as structure, and a person's asterisk is still
     an asterisk. Only `from === 'them'` in makeMsg takes the new renderer. */
  const text = 'use **stars** and a leading # is not a heading'
  const root = chat({ title: 'agent-x', seed: 0, history: [{ who: 'you', text }] })
  const body = messageBody(root, 'me')
  assert.equal(body.querySelectorAll('strong').length, 0, 'the person\'s own asterisks must not become bold')
  assert.equal(body.querySelectorAll('.md-h').length, 0, 'the person\'s own hash must not become a heading')
  assert.match(body.textContent, /\*\*stars\*\*/, `the literal characters must survive; drawn: "${body.textContent}"`)
  disposeChat(root)
})

test('an agent turn still cannot be made to draw a real tag', () => {
  /* Not a re-test of src/chat-markdown.js's own safety suite -- a test that
     THIS call site did not find a new way to defeat it (double-render,
     escape-then-unescape, or similar wiring mistakes a "safe" function
     underneath cannot protect against by itself). */
  const text = '<script>alert(1)</script>\n\n**bold**'
  const root = chat({ title: 'agent-x', seed: 0, history: [{ who: 'agent', text }] })
  const body = messageBody(root, 'them')
  assert.equal(body.querySelectorAll('script').length, 0, 'no real <script> element may exist in the drawn markup')
  assert.equal(body.querySelectorAll('img').length, 0, 'no real <img> element may exist either')
  assert.equal(body.querySelectorAll('iframe').length, 0, 'no real <iframe> element may exist either')
  assert.match(body.textContent, /script/i, 'the words must still reach the glass, not be silently dropped')
  assert.equal(body.querySelectorAll('strong').length, 1, 'and the emphasis beside the attack still renders')
  disposeChat(root)
})

test('every block class renderChatMarkdown can emit has a rule under .chat-msg-text', () => {
  /* .chat-message-body, not .chat-msg-text alone -- round 3 of
     the code-and-preformatted lane widened every rule in this block to also
     cover src/views/computers.js's tree-node rail (paintSaidReply, that
     file), the one buildChat()-shaped surface that painted a finished reply
     with raw .textContent and none of this. Same rules, same specificity
     math (a lone class inside :is() contributes exactly what the bare class
     did -- see tools/test/chat-msg-trailing-margin.test.mjs's own
     computeSpecificity for the proof), a wider selector list. */
  for (const selector of ['.chat-message-body .md-p', '.chat-message-body .md-h',
    '.chat-message-body .md-list', '.chat-message-body .md-list > li',
    '.chat-message-body .md-code', '.chat-message-body .md-pre',
    '.chat-message-body .md-quote']) {
    assert.ok(ruleBody(styles, selector) !== null, `no "${selector} {" rule in src/styles.css`)
  }
})

test('a code block scrolls inside itself instead of widening the panel', () => {
  const pre = ruleBody(styles, '.chat-message-body .md-pre')
  assert.ok(pre !== null, 'no ".chat-message-body .md-pre {" rule in src/styles.css')
  assert.match(pre, /overflow-x\s*:\s*auto\s*;/, '.md-pre must scroll rather than force the panel wider')
  assert.match(pre, /max-width\s*:\s*100%\s*;/, '.md-pre must not exceed the panel it sits in')
})

/* MEASURED gap, round 2 of the code-and-preformatted lane: `.md-pre` got the
   scroll-not-widen test above the day it was built; `.md-table-wrap` got the
   identical CSS (same commit, f08715d -- "overflow-x: auto; max-width: 100%;
   margin: 0 0 0.62em;") but no test ever pinned it. A table is exactly as
   capable of widening the panel as a code block -- a row of long paths in
   cells is the table analogue of a long code line -- so it needs the same
   gate. Confirmed absent: no other test file in tools/test matches
   "md-table-wrap" before this one. */
test('a table scrolls inside itself instead of widening the panel', () => {
  const wrap = ruleBody(styles, '.chat-message-body .md-table-wrap')
  assert.ok(wrap !== null, 'no ".chat-message-body .md-table-wrap {" rule in src/styles.css')
  assert.match(wrap, /overflow-x\s*:\s*auto\s*;/, '.md-table-wrap must scroll rather than force the panel wider')
  assert.match(wrap, /max-width\s*:\s*100%\s*;/, '.md-table-wrap must not exceed the panel it sits in')
})

test('a wide table retains every column and the exact long value inside its scrolling wrapper', () => {
  const headings = Array.from({ length: 8 }, (_, i) => `Field ${i + 1}`)
  const longValue = 'unbroken_value_'.repeat(80)
  const values = ['Words stay together', '短い説明', longValue, '4', '5', '6', '7', 'Last column']
  const text = `| ${headings.join(' | ')} |\n| ${headings.map(() => '---').join(' | ')} |\n| ${values.join(' | ')} |`
  const root = chat({ title: 'agent-x', seed: 0, history: [{ who: 'agent', text }] })
  const wrap = messageBody(root, 'them').querySelector('.md-table-wrap')
  assert.ok(wrap, 'the table must keep its own scrolling boundary')
  assert.deepEqual([...wrap.querySelectorAll('th')].map(cell => cell.textContent), headings)
  assert.deepEqual([...wrap.querySelectorAll('td')].map(cell => cell.textContent), values,
    'readability is achieved by layout, never by truncating words or omitting columns')
  disposeChat(root)
})

test('a long unbroken run of characters wraps instead of overflowing the panel', () => {
  const body = ruleBody(styles, '.chat-msg-text')
  assert.match(body, /overflow-wrap\s*:\s*anywhere\s*;/,
    '.chat-msg-text has no overflow-wrap -- one long unbroken token (a path, a hash) can still push the panel wider than it is')
})
