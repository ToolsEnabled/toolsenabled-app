/* T301 (Controller / Worker 82 ground-truth measurement, 2026-09-17): the
 * reading window is not message loss and not a scroll clamp -- Worker 82
 * measured every message present and the scroll reaching the oldest one.
 * The real defect is size: on the default desktop Computers rail,
 * `.chat-log` rendered only 339px tall for 5397px of actual conversation,
 * roughly 228px spent on chrome around it -- a six-line porthole.
 *
 * THE CHAIN THAT WAS BROKEN. `.chat`/`.chat-log` (src/styles.css) already
 * carry `flex: 1; min-height: 0`, which only does anything inside a STRETCHED
 * flex parent. `.rail-page` is that flex column, but the tab body between it
 * and `.chat` -- `.rail-chat-body` / `.rail-chat-host` -- had no flex rule of
 * its own in the base desktop case, so it sized to its own content instead of
 * stretching, and `.chat` (and therefore `.chat-log`) shrank to fit. The SAME
 * two selectors already carry the fix inside `.board-page` and
 * `.home-agent-workspace` (src/board.css, src/home-chat.css) -- this file
 * pins the same treatment existing in the PLAIN rail too, the surface
 * Worker 82 actually measured.
 *
 * No automated harness in this tree renders real CSS layout (see
 * tools/test/chat-expand-full.test.mjs's own header: "browser fixtures own
 * painted geometry"), so this reads the rule the way that file already does
 * for the same reason, rather than pretending to measure pixels. Only a
 * disposition-level check, but a real one: this exact assertion is what
 * would have caught the corresponding rule missing, mutation-checked below.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = relative => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')

test('the default desktop rail chat body stretches to fill the rail page, not just its own content', () => {
  const styles = read('src/styles.css')
  const bodyRule = styles.match(/\.rail-chat-body\s*\{[^}]*\}/)
  assert.ok(bodyRule, '.rail-chat-body has a base rule outside .board-page/.home-agent-workspace')
  assert.match(bodyRule[0], /flex:\s*1\b/, '.rail-chat-body grows inside .rail-page\'s flex column instead of sizing to its own content')
  assert.match(bodyRule[0], /min-height:\s*0\b|display:\s*flex/, '.rail-chat-body is itself a flex container so its own children can stretch')
})

test('the default desktop rail chat host passes the stretch down to .chat, the same chain .chat-log relies on', () => {
  const styles = read('src/styles.css')
  const hostRule = styles.match(/\.rail-chat-host\s*\{[^}]*\}/)
  assert.ok(hostRule, '.rail-chat-host has a base rule outside .board-page/.home-agent-workspace/.phone-canvas')
  assert.match(hostRule[0], /flex:\s*1\b/, '.rail-chat-host grows inside .rail-chat-body')
  assert.match(hostRule[0], /min-height:\s*0\b/, '.rail-chat-host does not clamp its own min-height, or .chat inside it cannot grow past its content size')

  /* THE WHOLE CHAIN, PINNED TOGETHER, so a future edit to any one link is
     caught here rather than reintroducing the six-line porthole one rule at
     a time. `.chat`/`.chat-log` themselves are the two links this file does
     not own -- confirmed present, not re-asserted line by line. */
  assert.match(styles, /\.chat\s*\{[^}]*flex:\s*1\b[^}]*min-height:\s*0\b/,
    '.chat itself must still carry flex: 1; min-height: 0 for this chain to reach it')
  assert.match(styles, /\.chat-log\s*\{[^}]*flex:\s*1\b[^}]*min-height:\s*0\b/,
    '.chat-log itself must still carry flex: 1; min-height: 0 to be the thing that grows')
})
