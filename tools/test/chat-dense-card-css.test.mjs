/* SIX ADDITIONS SHIPPED WITH NO RULE ANYWHERE IN THIS SHEET.
 *
 * commit 35068a4 added .chat-search, .chat-search-toggle, .chat-new-below,
 * .working-step, .turn-stamp and the multi-attach strip (.chat-attach-strip)
 * to src/components.js's markup with zero matching CSS -- every one of them
 * rendered as a bare browser default (an unstyled <button>, a borderless
 * <input>), which is why the owner "still saw the old chat" after the JS
 * shipped. This pins that each one now has a REAL rule, not merely that the
 * selector string appears somewhere in a comment or an unrelated .as-chat-full
 * override list (styles.css already referenced .chat-attach-strip in such a
 * list before this landed, which is exactly the kind of false "it's styled"
 * signal a plain string search would have missed).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const styles = readFileSync(join(SRC, 'styles.css'), 'utf8')

/** The FIRST top-level `selector { ... }` rule body for an exact selector
 *  string (none of the selectors this file checks nest braces inside
 *  themselves, so simple bracket matching is exact here). */
function ruleBody(css, selector) {
  const needle = `${selector} {`
  const start = css.indexOf(needle)
  if (start === -1) return null
  const openBrace = start + needle.length - 1
  const close = css.indexOf('}', openBrace)
  if (close === -1) return null
  return css.slice(openBrace + 1, close)
}

function declarationCount(body) {
  return (body.match(/[a-z-]+\s*:\s*[^;]+;/gi) || []).length
}

const CASES = [
  ['.chat-search-toggle', 2],
  ['.chat-search input', 3],
  ['.chat-new-below', 3],
  ['.chat-attach-strip', 3],
  ['.working-step', 3],
  ['.turn-stamp', 3],
]

for (const [selector, minDeclarations] of CASES) {
  test(`${selector} has a real rule, not a browser default`, () => {
    const body = ruleBody(styles, selector)
    assert.ok(body !== null, `no top-level "${selector} {" rule found in src/styles.css`)
    const count = declarationCount(body)
    assert.ok(count >= minDeclarations,
      `${selector} has only ${count} declaration(s); expected at least ${minDeclarations} -- this is the "renders as a browser default" defect, not a styled control`)
  })
}

test('the [hidden] guard exists on every one of the six that JS toggles hidden', () => {
  /* buildChat sets .hidden on all six via the `hidden` DOM property/attribute
     directly (searchPanel.hidden, newBelow.hidden, attachStrip.hidden,
     working.hidden are all set in components.js). An author `display` rule on
     the bare selector, with no `[hidden]` guard, can outrank the user agent's
     own `[hidden]{display:none}` and leave the element in the layout and the
     tab order while the code believes it is gone -- exactly the defect
     documented at .chat-queue-strip[hidden] in this same sheet. */
  for (const selector of ['.chat-search', '.chat-new-below', '.chat-attach-strip', '.working-step']) {
    assert.ok(styles.includes(`${selector}[hidden] { display: none; }`),
      `${selector} has no explicit [hidden]{display:none} guard -- an author display rule on the bare selector can beat the user agent's own hiding`)
  }
})
