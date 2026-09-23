/* TREE CARD ACTIVITY LINES MUST NOT BREAK MID-WORD.
 *
 * Owner, in a real capture (two independent reports, 2026-09-02 and
 * 2026-09-03): a tree card's activity line read "asked: ROLE: MANAGER
 * working in C:\Users\ToolsEnabled-…" — cut off mid-word, reported as "tree
 * cards clip mid-word" and left "not investigated in code" both times.
 *
 * THE MECHANISM WAS ALREADY FOUND ONCE IN THIS EXACT FILE, for a different
 * selector. Commit c06c44c ("The tree acts like before again"), 2026-08-15,
 * on `.node-name .nn-t`:
 *
 *   "break-word, not anywhere: `anywhere` broke names mid-word at the first
 *    opportunity ('Coordinat / or 1' — owner walkthrough, iteration 6).
 *    ... this rule is the backstop for text it never measured, and it only
 *    breaks a word that would otherwise overflow the box."
 *
 * `overflow-wrap: anywhere` forces a break at ANY character once a box's
 * available width runs out — including mid-word — the instant wrapping is
 * needed, because (per spec) it also reports the box's min-content size as
 * if any character were breakable, which is what let "Coordinator" break to
 * "Coordinat" / "or 1" even though the whole word could have fit on a line.
 * `overflow-wrap: break-word` breaks mid-word only as the last resort, after
 * normal line-breaking finds nowhere better to go.
 *
 * THE CARD-COPY RULE (`.cl-current`/`.cl-previous`/`.cl-chat`/
 * `.cl-unavailable`/`.cl-name b`, added 2026-08-08, a week BEFORE the
 * node-name fix) still reads `overflow-wrap: anywhere` — the exact same
 * shape of box (`-webkit-line-clamp`, `white-space: normal`, arbitrary text
 * `escapeMarkup()`d straight from `feed.current`/`feed.previous`/
 * `feed.chat`/`feed.unavailable` and `formattedName`, never pre-measured the
 * way `.node-name`'s `labelFor()` output is) that the node-name fix already
 * proved breaks mid-word. The lesson was never carried over.
 *
 * A SWEEP, NOT A LIST OF THE ONE RULE FIXED HERE — src/tree-graph.css has
 * exactly one legitimate reason to force a mid-word break (the same backstop
 * `.node-name .nn-t` uses), so `overflow-wrap: anywhere` has no honest use
 * anywhere in this file: the general assertion below catches the next one
 * written, not only the rule this file names.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CSS_PATH = path.join(REPO, 'src', 'tree-graph.css')

const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, ' ')

// A selector such as `.cl-name b` legitimately appears twice in this file —
// a base rule (ellipsis, single line) and the later 2-line card-copy
// override this test is about — so this returns every block for `selector`,
// not just the first, and the caller picks the one that is actually the
// card-copy rule (the one carrying -webkit-line-clamp).
function rulesFor(css, selector) {
  const needle = `${selector} {`
  const blocks = []
  let from = 0
  while (true) {
    const start = css.indexOf(needle, from)
    if (start < 0) break
    const close = css.indexOf('}', start)
    blocks.push(css.slice(start, close))
    from = close + 1
  }
  assert.ok(blocks.length > 0, `src/tree-graph.css must still declare a rule for ${selector}`)
  return blocks
}

function cardCopyRuleFor(css, selector) {
  const blocks = rulesFor(css, selector)
  // The card-copy override is identified by carrying a multi-line
  // -webkit-line-clamp at all, not by which number it names: W16e raised
  // this from 2 to 16 (measured against the panel's own reserved room), and
  // a test that pinned "2" would have failed against that fix -- exactly the
  // spelling-pin this file's own header warns against for overflow-wrap.
  // Read the clamp as a NUMBER and compare it, rather than pattern-matching
  // its digits: the first attempt at widening this used /[2-9]\d*/, which
  // silently excludes every value beginning with 1 -- including the 16 this
  // lane actually shipped, so the test failed against its own fix. A number is
  // compared as a number.
  const clampOf = block => {
    const found = /-webkit-line-clamp:\s*(\d+)/.exec(block)
    return found ? Number(found[1]) : 0
  }
  const cardCopy = blocks.find(block => clampOf(block) >= 2)
  assert.ok(cardCopy, `src/tree-graph.css must still carry a multi-line card-copy rule for ${selector} (found: ${blocks.length} rule(s), none clamped past 1 line)`)
  return cardCopy
}

test('the tree card activity lines break mid-word only as a last resort, never at the first character', () => {
  const css = stripComments(readFileSync(CSS_PATH, 'utf8'))

  // The exact selector group the owner's capture is inside: an untouched
  // agent's `current`/`previous`/`chat`/`unavailable` line, and the card's
  // own name — none of it pre-measured, all of it wrapped across 2 lines.
  for (const selector of [
    '.static-tree-chip-overlay .cl-current,\n.static-tree-chip-overlay .cl-previous,\n.static-tree-chip-overlay .cl-chat,\n.static-tree-chip-overlay .cl-unavailable',
    '.static-tree-chip-overlay .cl-name b',
  ]) {
    const rule = cardCopyRuleFor(css, selector)
    assert.doesNotMatch(rule, /overflow-wrap:\s*anywhere/,
      `${selector} forces a break at the first character once its 2-line box runs out of room -- ` +
      `measured on '.node-name .nn-t' (commit c06c44c): this is what turned "Coordinator" into ` +
      `"Coordinat" / "or 1", and is the owner's own reported "C:\\Users\\ToolsEnabled-…" cut mid-word. ` +
      'Use overflow-wrap: break-word, which only breaks mid-word once normal wrapping has nowhere left to go.')
    assert.match(rule, /overflow-wrap:\s*break-word/,
      `${selector} must divide its forced wrap the same way '.node-name .nn-t' does: overflow-wrap: break-word`)
  }
})

test('a card too narrow for its clamped text still tells the reader more was said', () => {
  // Measured on the owner's own running window (captures/m4-w16-chat-text-20260904.png,
  // captures/m4-w16-card-text-detail.png): a narrow card cut its activity line and its
  // name mid-word with no mark that anything was missing -- "asked: ok look a",
  // "controller was w", "It remembers noth". `-webkit-line-clamp` only draws the
  // ellipsis Blink owes a clamped box when `text-overflow` is `ellipsis`; `clip`
  // (or the UA default) suppresses it. This asserts the reader-visible outcome --
  // an ellipsis is drawn at the clamp -- not a spelling of the rule.
  const css = stripComments(readFileSync(CSS_PATH, 'utf8'))
  for (const selector of [
    '.static-tree-chip-overlay .cl-current,\n.static-tree-chip-overlay .cl-previous,\n.static-tree-chip-overlay .cl-chat,\n.static-tree-chip-overlay .cl-unavailable',
    '.static-tree-chip-overlay .cl-name b',
  ]) {
    const rule = cardCopyRuleFor(css, selector)
    assert.match(rule, /text-overflow:\s*ellipsis/,
      `${selector}'s 2-line clamp must draw an ellipsis when it cuts off text -- ` +
      'text-overflow: clip (or no text-overflow at all) leaves a truncated card silent about ' +
      'the words it dropped, which is the owner\'s own "asked: ok look a" / "controller was w" capture.')
    assert.doesNotMatch(rule, /text-overflow:\s*clip/,
      `${selector} must not silence the clamp's ellipsis with text-overflow: clip`)
  }
})

test('no rule in tree-graph.css reaches for overflow-wrap: anywhere', () => {
  // A sweep, so the NEXT card-copy-shaped rule is caught here too, not only
  // the two named above. break-word is the one proven-safe spelling in this
  // file (see .node-name .nn-t, commit c06c44c) for a box that must not
  // break its own words at the first opportunity.
  const css = stripComments(readFileSync(CSS_PATH, 'utf8'))
  const offences = (css.match(/[.#][^{}]*\{[^{}]*overflow-wrap:\s*anywhere[^{}]*\}/g) || [])
  assert.deepEqual(offences, [],
    'overflow-wrap: anywhere forces a mid-word break at the first opportunity on text this file never ' +
    'measured; every rule in src/tree-graph.css that must force a wrap uses overflow-wrap: break-word instead')
})
