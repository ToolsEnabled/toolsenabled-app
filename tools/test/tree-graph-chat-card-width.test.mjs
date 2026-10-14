import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* THE CHAT CARD'S DEFAULT WIDTH, PINNED AT SOURCE.
 *
 * The owner's picked chat card ("Dense — light-mode palette",
 * design/chat/picked-card.png) sets the Card width at 420px (SIZING LAW,
 * design/chat/Sizes.dc.html: Card 420 / Panel 520 / Full). SCREEN_CHAT_W is
 * tree-graph.js's one declaration of that default -- the width an agent's
 * chat card opens to before anyone drags its own resize handle -- and it used
 * to be 360.
 *
 * tree-graph.js is a view factory over a live DOM and cannot be mounted in a
 * node test, so this reads the declaration and its call sites as source text,
 * the same limit and the same remedy tools/test/chat-expand-full.test.mjs
 * documents for this file.
 */

const read = relative => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
const graph = read('src/tree-graph.js')

test('SCREEN_CHAT_W is 420, the Dense picked card\'s Card width', () => {
  const declared = /const SCREEN_CHAT_W = (\d+)/.exec(graph)
  assert.ok(declared, 'SCREEN_CHAT_W must still be a findable numeric constant')
  assert.equal(declared[1], '420',
    'the chat card\'s default width must be the design\'s Card size (420), not the old 360')
})

test('tabbed conversations fill their workspace with a full-width transcript in full view', () => {
  // The user replaced separate resizable cards with tabs. Actual rendered
  // widths, drafts and resizing are driven by run-tree-chat-workspace.mjs.
  assert.match(graph, /record\.chatPanel\.hidden = !active/)
  assert.match(graph, /record\.chatPanel\.style\.width = '100%'/)
  const css = read('src/tree-graph.css')
  assert.match(css, /\.tree-conversation\.as-chat-full \.chat > :is\([^}]+width: 100%/)
  assert.match(css, /\.tree-conversation\.as-chat-full \.chat-msg-text \{ max-width: none/)
  assert.doesNotMatch(graph, /const SCREEN_CHAT_W = 360/)
})
