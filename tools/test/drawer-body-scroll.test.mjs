/* THE QUICK-SETTINGS DRAWER REACHES ITS LAST ROW, AT EVERY TEXT SIZE.
 *
 * The owner, on the Text size control: "text sizes for example large on my
 * screen hides parts of the window". Most of that sentence is the viewport-unit
 * defect, which tools/test/text-size-window-fit.test.mjs gates. This is the
 * part of it that has nothing to do with a viewport unit, and which that sweep
 * therefore cannot see.
 *
 * WHAT IS WRONG. `.drawer` is `position: fixed; top: 14px; bottom: 14px` -- a
 * sheet exactly one window tall, whatever is put in it -- and nothing inside it
 * scrolled. The cost is already written down in src/quick-settings.js, at the
 * DEFAULT text size, verbatim:
 *
 *   "Measured 2026-08-27: with the appearance block on top, the tools door
 *    landed at y=890 in a 630px body — off screen at every open, on every
 *    route."
 *
 * The remedy applied then was to REORDER the rows. That changes which rows fall
 * off the bottom, not whether any do -- and the rows below the fold are still
 * "Glow intensity", "Reduce motion" and "This build" on every route.
 *
 * WHY THE TEXT SIZE BELONGS IN THIS FILE'S NAME ANYWAY. Every row in the drawer
 * is px-sized, and the size control is `zoom` on <body> (src/text-size.js), so
 * the zoom multiplies all of them while `bottom: 14px` keeps the sheet one
 * window tall. A 630px body holding a measured 890px of content at Default is
 * asked to hold about 997 at Large -- roughly two more rows past the edge. The
 * setting did not create this defect; it decides how much of it a person sees.
 *
 * WHAT A SOURCE TEST CAN AND CANNOT DO HERE, on the terms
 * tools/test/mobile-size-floor.test.mjs sets out: this repository has no DOM in
 * its node tests, so nothing below measures a rendered box. It pins the two
 * declarations whose absence was the defect, and the fixed height that makes
 * them necessary.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(REPO, 'src')
const read = name => readFileSync(path.join(SRC, name), 'utf8')

/* Prose in this codebase quotes the very declarations it is explaining -- the
   rule below carries a comment naming the measurement it answers -- so a gate
   that read comments as rules would fail on its own explanation. Same parser
   shape as mobile-size-floor / hidden-display-honesty / phone-canvas /
   setup-phone-fit, each of which carries its own copy. */
const stripCssComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '')

/** Flatten a sheet to { atRule, selector, body }, one entry per declaration block. */
function cssRules(text) {
  const cleaned = stripCssComments(text)
  const rules = []
  const stack = []
  let index = 0
  let head = ''
  while (index < cleaned.length) {
    const character = cleaned[index]
    if (character === '{') {
      const selector = head.trim()
      head = ''
      if (selector.startsWith('@')) {
        stack.push(selector)
        index += 1
        continue
      }
      const close = cleaned.indexOf('}', index)
      const end = close === -1 ? cleaned.length : close
      rules.push({ atRule: stack.join(' '), selector, body: cleaned.slice(index + 1, end) })
      index = end + 1
      continue
    }
    if (character === '}') {
      stack.pop()
      head = ''
      index += 1
      continue
    }
    head += character
    index += 1
  }
  return rules
}

test('the drawer is height-bounded by the window, which is why its body must scroll', () => {
  const drawer = cssRules(read('styles.css')).find(entry => entry.selector === '.drawer')
  assert.ok(drawer, '.drawer must still be styled')
  assert.match(drawer.body, /(?:^|;|\s)position\s*:\s*fixed/, '.drawer must still be fixed to the window')
  assert.match(drawer.body, /(?:^|;|\s)top\s*:/, '.drawer must still be pinned to the top of the window')
  assert.match(
    drawer.body,
    /(?:^|;|\s)bottom\s*:/,
    '.drawer stopped being bounded by the window; re-read this file before trusting its arithmetic',
  )
})

test('the drawer body scrolls to its last row instead of running off the window', () => {
  const body = cssRules(read('styles.css')).find(entry => entry.selector === '.drawer-body')
  assert.ok(body, '.drawer-body must still be styled')
  assert.match(
    body.body,
    /overflow-y\s*:\s*auto/,
    'a row past the bottom of a window-tall sheet cannot be reached: body is overflow: hidden',
  )
  assert.match(
    body.body,
    /min-height\s*:\s*0/,
    "without this the flex item's automatic minimum is its content, so it overflows instead of scrolling",
  )
})

/* THE ROWS THIS IS ABOUT, so a future reordering cannot quietly make the gate
   meaningless. The 2026-08-27 measurement is only worth quoting while the
   drawer still draws more rows than it did then; if these stop being built the
   sentence above has to be re-measured, not re-used. */
test('the drawer still builds the rows the measurement was taken against', () => {
  const source = readFileSync(path.join(SRC, 'quick-settings.js'), 'utf8')
  for (const label of ['Show the example fleet', 'Tools your assistants may use', 'Theme', 'Font', 'Text size', 'Glow intensity', 'Reduce motion', 'This build']) {
    assert.ok(source.includes(`>${label}<`), `the drawer stopped drawing "${label}"; the 890-in-630 measurement no longer describes it`)
  }
})
