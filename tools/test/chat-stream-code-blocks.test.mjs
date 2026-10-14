/* A REAL AGENT'S LIVE ANSWER, NOT JUST ITS HISTORY REPLAY, DRAWS CODE AND
 * TABLES AS SUCH.
 *
 * Owner, 2026-09-03: "chat formatting needs to be fixed - its messy right
 * now", and a minute later, "try your best to make it formatted cleanly in
 * your inline response since thats exactly part of the messy issue i meant
 * earlier".
 *
 * src/components.js's makeMsg() now draws an agent turn through
 * src/chat-markdown.js's renderChatMarkdown() instead of formatInlineText --
 * tools/test/chat-msg-markdown.test.mjs pins that, and every test in it
 * builds its message through `history: [...]`, which calls makeMsg once with
 * the complete, final text already in hand.
 *
 * MEASURED before this file's fix: that was the ONLY path fixed. A message
 * that ARRIVES live -- which is how every real agent turn reaches the glass,
 * per src/agent-session.js and the header on buildChat's own openStream
 * property ("the real thing's door") -- is built by makeMsg with EMPTY text,
 * then repainted by openStream's own `paint`, which still called
 * formatInlineText, both while streaming and in the one paint that runs
 * after close(). So a working agent's fenced code, its inline `code` and any
 * table it drew reached the transcript as literal backticks and pipes on the
 * one surface that matters most -- not while it was still arriving, and not
 * once it had fully arrived either. The same gap existed on
 * buildChat's OTHER streaming path, the sample-conversation reply
 * (`startReply`'s reduced-motion branch and its word-by-word `streamWord`),
 * which is source-pinned below the same way
 * tools/test/chat-stream-min-height.test.mjs already pins that function --
 * driving its 30-120ms word timers from a test is not worth the flakiness
 * when the source itself says plainly which renderer runs.
 *
 *   node --test tools/test/chat-stream-code-blocks.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const componentsPath = process.env.CHAT_COMPONENTS_MODULE
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'components.js')
const { buildChat } = await import(pathToFileURL(componentsPath).href)

function chat(options) {
  const root = buildChat({ history: [], composerReason: 'test', ...options })
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
/* Grounded in real openStream() markup, never assumed -- the same discipline
   tools/test/chat-msg-markdown.test.mjs uses for the history path. classList
   checks, not a chained ".msg.them" selector: dom-stand-in.mjs's own header
   lists "tag.class" as a supported step shape but not two bare classes
   chained with no tag, matching chat-msg-markdown.test.mjs's own helper. */
function lastBubble(root) {
  const rows = root.querySelectorAll('.msg').filter(node => node.classList.contains('them'))
  const bubble = rows.at(-1)
  assert.ok(bubble, 'no .msg.them row exists -- openStream() did not build one')
  const body = bubble.querySelector('.chat-msg-text')
  assert.ok(body, '.chat-msg-text is gone from the bubble openStream() built')
  return body
}

test('the first live reply removes the empty conversation notice', () => {
  const root = chat({ title: 'agent-x', seed: 0 })
  assert.ok(root.querySelector('.chat-log-empty'))
  const stream = root.openStream()
  stream.push('The first response.')
  assert.equal(root.querySelector('.chat-log-empty'), null)
  assert.match(lastBubble(root).textContent, /The first response/)
  stream.close('The first response.')
  disposeChat(root)
})

test('a live push draws a fenced code block as a bounded element, not literal backticks', () => {
  const root = chat({ title: 'agent-x' })
  const stream = root.openStream({ at: 0 })
  stream.push('Here:\n\n```js\nconst a = 1\n```\n')
  const body = lastBubble(root)
  assert.equal(body.querySelectorAll('.md-pre').length, 1, 'the fence must be drawn as .md-pre while the stream is still open')
  // This DOM fixture trims individual text nodes; browser checks verify exact whitespace.
  assert.equal(body.querySelector('code').textContent.replace(/\s+/g, ''), 'consta=1', 'the code itself must still reach the glass')
  assert.ok(!body.textContent.includes('```'), 'the fence marks must not survive as literal text')
  disposeChat(root)
})

test('close() draws the final answer the same way -- the gap this file exists to close', () => {
  /* Before this round, close()'s only paint ran through formatInlineText,
     so even a fully-arrived, no-longer-streaming answer kept its code and
     tables as literal punctuation forever -- reloading history was the only
     way to ever see them formatted, which a live session never does on its
     own. */
  const root = chat({ title: 'agent-x' })
  const stream = root.openStream({ at: 0 })
  stream.push('measuring')
  stream.close('## Findings\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.')
  const body = lastBubble(root)
  assert.equal(body.querySelectorAll('.md-h').length, 1, 'the heading must be drawn as a heading after close()')
  assert.equal(body.querySelectorAll('.md-table').length, 1, 'the table must be drawn as a table after close()')
  assert.match(body.textContent, /Findings/)
  assert.match(body.textContent, /Done\./)
  assert.ok(!body.textContent.includes('##'), 'the heading mark must not survive as literal text')
  disposeChat(root)
})

test('a growing stream keeps drawing real markup on every push, not only the first one', () => {
  const root = chat({ title: 'agent-x' })
  const stream = root.openStream({ at: 0 })
  stream.push('- one')
  stream.push('- one\n- two\n- three')
  const body = lastBubble(root)
  assert.equal(body.querySelectorAll('.md-list li').length, 3, 'the LATEST push must be what is on screen, fully drawn as a list')
  disposeChat(root)
})

test('a live turn still cannot be made to draw a real tag', () => {
  /* Not a re-test of src/chat-markdown.js's own safety suite, or of
     tools/test/chat-msg-markdown.test.mjs's -- a test that THIS call site
     (openStream's paint, reached by neither of those) did not find its own
     way to defeat the escape-first contract. */
  const root = chat({ title: 'agent-x' })
  const stream = root.openStream({ at: 0 })
  /* push() itself is exercised first (a mid-stream attempt), then close()
     REPLACES the bubble's whole text (openStream's own header: "push
     REPLACES the bubble's text"), so the string checked on the far side of
     this is close()'s -- that replacement is the entire reason the final
     assertions below read against the closed text, not the pushed one. */
  stream.push('<script>alert(1)</script>')
  stream.close('<img src=x onerror=alert(1)>\n\n**bold**')
  const body = lastBubble(root)
  assert.equal(body.querySelectorAll('script').length, 0, 'no real <script> element may exist in the drawn markup')
  assert.equal(body.querySelectorAll('img').length, 0, 'no real <img> element may exist either')
  assert.match(body.textContent, /onerror=alert\(1\)/i, 'the words must still reach the glass, not be silently dropped')
  assert.equal(body.querySelectorAll('strong').length, 1, 'and the emphasis beside the attack still renders')
  disposeChat(root)
})

/* THE SAMPLE-CONVERSATION REPLY, SOURCE-PINNED.
 *
 * startReply's two branches -- the reduced-motion full paint and the
 * word-by-word streamWord loop -- both used formatInlineText, so even the
 * product's own demo/onboarding conversation showed an agent's fenced code
 * and lists as literal punctuation. Source-pinned rather than driven,
 * matching tools/test/chat-stream-min-height.test.mjs's own reasoning:
 * streamWord schedules itself 30-120ms per word, and asserting the shape of
 * the source that runs is both simpler and less flaky than winning a race
 * against those timers from a test. */
/* Read from componentsPath itself (the mutation harness's own override when
   one is given, plain src/components.js otherwise) -- the same file
   buildChat was imported from above, so a mutation copy is pinned exactly
   like the real one. */
const source = readFileSync(componentsPath, 'utf8')
const startReplyBegin = source.indexOf('const startReply = (item)')
assert.ok(startReplyBegin !== -1, 'const startReply = (item) is gone from components.js -- re-locate this pin')
/* `pumpReplies = () =>` is declared TWICE (an empty stub above startReply, the
   real one below it) -- searched from startReplyBegin so this finds the
   LATER one and closes the slice around startReply, not before it starts. */
const startReplyEnd = source.indexOf('pumpReplies = () =>', startReplyBegin)
assert.ok(startReplyEnd > startReplyBegin, 'could not find where startReply ends -- re-locate this pin')
const startReply = source.slice(startReplyBegin, startReplyEnd)

test('the sample-conversation reduced-motion paint draws through renderChatMarkdown', () => {
  assert.match(startReply, /if \(chatReducedMotion\(\)\) \{\s*\n\s*setChatMessageBody\(body, fullText\)/,
    'the reduced-motion branch still calls formatInlineText -- a demo reply\'s code and lists stay literal punctuation')
})

test('the sample-conversation word-by-word stream draws through renderChatMarkdown', () => {
  const streamWord = startReply.slice(startReply.indexOf('const streamWord = ()'))
  assert.match(streamWord, /setChatMessageBody\(body, streamedText\)/,
    'streamWord still calls formatInlineText -- the demo reply is drawn as markup for one frame (makeMsg\'s empty first paint) and then reverts to literal punctuation as soon as the first word streams in')
})
