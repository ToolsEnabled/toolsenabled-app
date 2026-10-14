/* THE TREE'S OWN ADDRESS BLOCK CANNOT BE CRUSHED TO A HAIRLINE BY A SCROLLING LOG.
 *
 * Owner: "text overlaps tool use." This is not that shape -- read on, it says
 * so below -- but it is the same audit, the same file, the same mechanism
 * already proven once for a different row, and finding it and leaving it
 * fixed nothing would be dishonest.
 *
 * THE MECHANISM, ALREADY MEASURED FOR A DIFFERENT ROW.
 * tools/test/chat-action-stream.test.mjs pins it: `.chat-log` is a column
 * flex container; `.chat-action` clips with `overflow: hidden` for its
 * rounded corner; and per the flexbox spec, a flex item whose `overflow` is
 * not `visible` gets an AUTOMATIC MINIMUM SIZE OF ZERO unless something
 * overrides it. Measured on a staged packaged build, 2026-08-20: the moment
 * a conversation was tall enough to actually scroll -- every real one -- the
 * log took its negative free space out of exactly the rows with that
 * zeroed floor, and every `.chat-action` painted at ONE PIXEL, its content
 * clipped away by the very `overflow: hidden` that caused the crush. `flex:
 * none` is what stops it: it opts the row out of shrinking at all, so the
 * log scrolls instead of crushing its rows.
 *
 * THE SAME COMBINATION, FOUND ON A ROW NOBODY HAD PROTECTED.
 * `.chat-context` -- the tree's own address block, folded shut by default,
 * added with EVERY tree start (src/components.js addContext) -- clips with
 * the identical `overflow: hidden`, for the identical rounded-corner reason.
 * MEASURED IN SOURCE, not by a second packaged build (it is the identical
 * rule already proven, not a new one): addContext's own `wrap` is appended
 * straight to `log`, the same `.chat-log` flex column every `.chat-action`
 * row lands in, and until this round it carried no `flex: none` of its own.
 * Enumerating every element src/components.js ever appends directly to
 * `log` confirms it was the ONLY one exposed: the `.msg` family and
 * `.chat-time-divider` and `.chat-approval` all keep `overflow: visible`
 * and were never at risk; `.chat-action`/`.chat-action-run` and
 * `[data-chat-diff-card]` already carry `flex: none`. `.chat-context` was
 * the one gap.
 *
 * WHY THIS IS NOT THE OWNER'S OVERLAP, SAID PLAINLY. A crushed row's content
 * does not paint over its neighbours -- `overflow: hidden` clips it exactly
 * at its own (collapsed) box edge, so it disappears rather than bleeding
 * into the row above or below. That is a real, separate defect (a person's
 * own tree-start address block silently vanishing in any long conversation),
 * not the one the owner named. It is fixed here because it sits in the exact
 * rule this lane's own audit was already reading, not because this lane's
 * mandate has grown.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'src')
const styles = readFileSync(join(SRC, 'styles.css'), 'utf8')
const components = readFileSync(join(SRC, 'components.js'), 'utf8')

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  assert.notEqual(start, -1, `source section start is missing: ${startMarker}`)
  assert.notEqual(end, -1, `source section end is missing: ${endMarker}`)
  assert.ok(start < end, `source section is out of order: ${startMarker} must precede ${endMarker}`)
  return source.slice(start, end)
}

test('the context row is still appended straight into the scrolling flex column -- the shape this guard assumes', () => {
  const fn = sourceBetween(components, 'const addContext = (', 'const addThinking = (')
  assert.match(fn, /wrap\.className = 'msg context chat-context'/,
    'addContext no longer builds the exact class this CSS rule and this test both key on -- re-check both before trusting either')
  assert.match(fn, /log\.appendChild\(wrap\)/,
    'the context row no longer lands directly in .chat-log -- if it now nests inside another element, the flex-shrink risk this guard checks may have moved or gone away, and the fix below may be dead weight instead of load-bearing')
  assert.match(fn, /before\.parentNode === log\) log\.insertBefore\(wrap, before\)/,
    'a restored context row must also remain a direct child of the scrolling log')
})

test('.chat-context cannot be shrunk to a hairline by a scrolling log, the same protection .chat-action already has', () => {
  const rule = sourceBetween(styles, '.chat-context {', '.chat-context-head {')
  assert.match(rule, /flex:\s*none/,
    'the row is shrinkable again; in any scrolled conversation with an open context row it will paint at 1px, exactly as an unprotected .chat-action once did')
  assert.match(rule, /overflow:\s*hidden/,
    'the clip is part of the mechanism this pin documents (it is WHY the automatic minimum size zeroes out); if it moved, re-measure whether flex: none is still needed here')
})
