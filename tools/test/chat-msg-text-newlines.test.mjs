/* A REPLY'S LINE BREAKS, KEPT ON EVERY CHAT SURFACE -- NOT JUST ONE OF THEM.
 *
 * Owner, 2026-09-03: "chat formatting needs to be fixed - its messy right
 * now", and a minute later, "try your best to make it formatted cleanly in
 * your inline response since thats exactly part of the messy issue i meant
 * earlier".
 *
 * That defect had two parts (src/chat-markdown.js's own header names them):
 * no markdown rendering, and ".turn-text carried no white-space rule, so
 * every newline collapsed to a space." Both were fixed for the ONE
 * coordinator-thread panel on the home page (src/chat-markdown.js plus the
 * `white-space: pre-wrap` src/home.css gives `.turn.is-owner`/`.turn.is-act`
 * beside it).
 *
 * .chat-msg-text is the OTHER message body: what src/components.js buildChat()
 * renders, mounted by src/agent-session.js, src/tree-graph.js,
 * src/views/agent.js and src/views/computers.js -- the agent page, the tree
 * node chat popup, and the computers page. That is most of how a person
 * actually talks to an agent in this product, and it never got either half
 * of the fix. This file pins the newline half: a multi-line reply must not
 * fold into one run-on line on these surfaces either.
 *
 * MEASURED before this rule existed: zero matches for "chat-msg-text"
 * anywhere in src/styles.css, so the browser's default `white-space: normal`
 * applied and collapsed every newline `formatInlineText` left in the text.
 *
 * Computed layout needs a real browser, which this Node suite does not have
 * (see tools/test/lib/dom-stand-in.mjs's own header). So, like
 * tools/test/chat-dense-card-css.test.mjs and the stylesheet checks in
 * tools/test/chat-message-identity.test.mjs, this pins the STATIC rule a
 * browser would apply, against the REAL class name a real message carries --
 * built through buildChat() itself, not assumed.
 *
 *   node --test tools/test/chat-msg-text-newlines.test.mjs
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

const { buildChat, formatInlineText } = await import('../../src/components.js')
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
   string, matching tools/test/chat-dense-card-css.test.mjs's own helper. */
function ruleBody(css, selector) {
  const needle = `${selector} {`
  const start = css.indexOf(needle)
  if (start === -1) return null
  const openBrace = start + needle.length - 1
  const close = css.indexOf('}', openBrace)
  if (close === -1) return null
  return css.slice(openBrace + 1, close)
}

test('a multi-paragraph agent reply is built with the .chat-msg-text class, in real buildChat markup', () => {
  const root = chat({
    title: 'agent-x', seed: 0,
    history: [{ who: 'agent', text: 'Paragraph one.\n\nParagraph two, line one.\nParagraph two, line two.' }],
  })
  const row = root.querySelector('.chat-log').children.find(node => node.classList.contains('msg'))
  assert.ok(row, 'no message row was built from history -- cannot ground the selector below in real markup')
  const body = row.querySelector('.chat-msg-text')
  assert.ok(body, '.chat-msg-text is gone from makeMsg -- the class this test (and the stylesheet rule it checks) targets no longer exists')
  disposeChat(root)
})

test('formatInlineText keeps a reply\'s own line breaks -- the CSS rule below has nothing to work with otherwise', () => {
  const out = formatInlineText('Paragraph one.\n\nParagraph two, line one.\nParagraph two, line two.', { agents: [], roleKey: 'coordinator' })
  assert.equal((out.match(/\n/g) || []).length, 3, 'formatInlineText dropped or added newlines -- re-measure before trusting the stylesheet fix')
})

test('.chat-msg-text preserves those line breaks on screen (white-space: pre-wrap)', () => {
  const body = ruleBody(styles, '.chat-msg-text')
  assert.ok(body !== null, 'no top-level ".chat-msg-text {" rule in src/styles.css -- every buildChat() chat window (agent page, tree node popup, computers page) folds multi-line replies into one run-on line')
  assert.match(body, /white-space\s*:\s*pre-wrap\s*;/,
    '.chat-msg-text has a rule but not white-space: pre-wrap -- newlines still collapse on every buildChat() chat window')
})
