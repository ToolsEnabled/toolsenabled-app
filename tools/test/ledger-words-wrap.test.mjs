/* THE LEDGER'S OWN "WORDS" LINE MUST NOT BREAK MID-WORD.
 *
 * `.ledger-words` (src/ledger.css) renders `item.words` -- a person's own
 * free-form sentence, HTML-escaped and printed verbatim by
 * src/views/ledger.js (`<p class="ledger-words">${esc(words)}...`), never
 * pre-measured or pre-wrapped -- inside a 6-line `-webkit-line-clamp` box
 * with `overflow: hidden`. Until this fix it declared
 * `overflow-wrap: anywhere`.
 *
 * THE MECHANISM WAS ALREADY FOUND AND FIXED TWICE IN THIS EXACT SHAPE OF BOX,
 * both times in src/tree-graph.css:
 *   - commit c06c44c, `.node-name .nn-t`: "anywhere broke names mid-word at
 *     the first opportunity ('Coordinat / or 1' -- owner walkthrough,
 *     iteration 6)".
 *   - commit 0b0087e, the tree card copy rule (`.cl-current`/`.cl-previous`/
 *     `.cl-chat`/`.cl-unavailable`/`.cl-name b`): the identical shape --
 *     `-webkit-line-clamp`, `white-space: normal`, arbitrary un-pre-measured
 *     text -- reported by the owner as "C:\Users\ToolsEnabled-..." cut off
 *     mid-word, left unfixed across two reports because the lesson from the
 *     first fix was never carried to the second rule.
 *
 * `overflow-wrap: anywhere` forces a break at ANY character the instant a
 * clamped box runs out of room -- including mid-word, even when normal
 * line-breaking still had a space to fall back to a line earlier -- because
 * (per spec) it also reports the box's min-content size as if every
 * character were a valid break point. `overflow-wrap: break-word` only
 * forces a mid-word split once ordinary wrapping has nowhere left to go.
 *
 * This file has two tests: the one named rule that is proven broken and
 * fixed here, and a SWEEP -- not a list of the one rule fixed -- of every
 * sheet under src/ for the next rule written in this exact shape (a
 * `-webkit-line-clamp` box that also reaches for `overflow-wrap: anywhere`),
 * the same generalisation principle text-size-window-fit.test.mjs and
 * tree-graph-card-copy-wrap.test.mjs already use for their own sweeps.
 */

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(REPO, 'src')

const rel = file => path.relative(REPO, file).replace(/\\/g, '/')

function walkFiles(dir, extension) {
  const found = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...walkFiles(full, extension))
    else if (entry.endsWith(extension)) found.push(full)
  }
  return found.sort()
}

const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, ' ')

// Every innermost rule block -- `selector { declarations }` with no nested
// braces -- found anywhere in the sheet, including inside @media wrappers
// (the wrapper itself never matches: its own body contains the nested
// braces this pattern excludes).
function ruleBlocks(css) {
  return css.match(/[^{}]+\{[^{}]*\}/g) || []
}

test('.ledger-words divides its forced wrap the proven way: break-word, not anywhere', () => {
  const css = stripComments(readFileSync(path.join(SRC, 'ledger.css'), 'utf8'))
  const block = ruleBlocks(css).find(rule => /^\.ledger-words\s*\{/.test(rule.trim()))
  assert.ok(block, 'src/ledger.css must still declare a .ledger-words rule')
  assert.match(block, /-webkit-line-clamp:\s*6/,
    'this test is about the clamped shape of the box; if the clamp moved, re-verify the wrap fix still applies to it')
  assert.doesNotMatch(block, /overflow-wrap:\s*anywhere/,
    '.ledger-words forces a break at the first character once its 6-line box runs out of room -- proven ' +
    'on `.node-name .nn-t` (commit c06c44c) and the tree card copy rule (commit 0b0087e) to turn an ordinary ' +
    'word into a fragment ("Coordinat" / "or 1") even though a space was available one line earlier. ' +
    'item.words is the same kind of un-pre-measured free text. Use overflow-wrap: break-word.')
  assert.match(block, /overflow-wrap:\s*break-word/,
    '.ledger-words must force its wrap the same proven way `.node-name .nn-t` does: overflow-wrap: break-word')
})

test('no line-clamped rule anywhere in src/ reaches for overflow-wrap: anywhere', () => {
  // A sweep, so the next box shaped like this one -- a -webkit-line-clamp
  // box that also sets overflow-wrap: anywhere on itself -- is caught here
  // wherever it is written next, not only at the two sites already found.
  const offences = []
  for (const sheet of walkFiles(SRC, '.css')) {
    const css = stripComments(readFileSync(sheet, 'utf8'))
    for (const block of ruleBlocks(css)) {
      if (!/-webkit-line-clamp\s*:/.test(block)) continue
      if (!/overflow-wrap\s*:\s*anywhere/.test(block)) continue
      offences.push(`${rel(sheet)}  ${block.replace(/\s+/g, ' ').trim()}`)
    }
  }
  assert.deepEqual(offences, [],
    'a -webkit-line-clamp box that also sets overflow-wrap: anywhere breaks an ordinary word at the first ' +
    'character the instant it runs out of vertical room, silently losing the rest of the word past the clamp ' +
    '-- measured on .node-name .nn-t (c06c44c), the tree card copy rule (0b0087e) and .ledger-words. Use ' +
    'overflow-wrap: break-word, which only forces a mid-word split once ordinary wrapping has nowhere left to go.')
})
