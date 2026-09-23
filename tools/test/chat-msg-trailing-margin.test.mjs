/* A REPLY'S TRAILING MARGIN, ZEROED FOR EVERY BLOCK SHAPE -- NOT JUST A
 * PARAGRAPH, BECAUSE A TIE IN THE CASCADE WAS DECIDING IT.
 *
 * Found while auditing src/styles.css's `.chat-msg-text` block for the
 * lane's own defect (a negative margin drawing text over a tool row -- see
 * tools/test/chat-action-run-overlap.test.mjs, the round that actually
 * closed the owner's "text overlaps tool use"). This is a different shape of
 * bug in the same rule block, not that one: no row overlaps another here,
 * the LAST block of a reply simply kept trailing space it was supposed to
 * lose.
 *
 * THE RULE, AS WRITTEN 2026-09-03 (src/styles.css, the chat-formatting
 * round): `.chat-msg-text > :last-child { margin-bottom: 0; }`, meant to
 * zero whichever block renderChatMarkdown() puts last, so a reply's bubble
 * ends flush rather than carrying dead space before its own bottom padding.
 *
 * MEASURED BY READING THE CASCADE. `.chat-msg-text > :last-child` and every
 * `.chat-msg-text .md-X` block rule below it (`.md-h`, `.md-list`,
 * `.md-quote`, `.md-rule`, `.md-code-block`, `.md-table-wrap`) are the SAME
 * specificity -- two simple selectors deep apiece (`:last-child` counts as
 * one, the same tier as a class). Equal specificity falls through to source
 * order, and `.chat-msg-text .md-p` is the only one of those seven rules
 * that sits ABOVE the `:last-child` reset in the file; the other six all sit
 * below it. So a reply ending in a paragraph got the intended flush edge,
 * and a reply ending in a heading, a list, a quote, a rule, a fenced block or
 * a table did not -- its OWN bottom margin (up to 0.8em, `.md-rule`'s) won
 * the tie instead, and the reset rule silently never fired for six of the
 * seven shapes it was written to cover.
 *
 * THE FIX raises `:last-child`'s selector to three simple selectors deep --
 * `.chat-msg-text > :is(.md-p, .md-h, .md-list, .md-quote, .md-rule, .md-code-block,
 * .md-table-wrap):last-child` -- the same depth `.chat-msg-text >
 * .md-h:first-child` two rules down already uses for the equivalent
 * top-margin reset, and already proven there to win on specificity alone
 * regardless of source order. This suite does not trust that arithmetic by
 * eye a second time: computeSpecificity() below is a real (CSS Selectors
 * Level 4 :is()) specificity count, and every assertion that the fixed
 * selector outguns a `.md-X` rule is made by running that count against the
 * literal selector text in src/styles.css, not by restating the conclusion.
 *
 * WHAT THIS PINS: the buggy bare selector does not come back; the fixed
 * selector's `:is()` argument list is EXACTLY the block classes
 * renderChatMarkdown() can actually put last (an entry this list is missing
 * is a reset that silently stops covering that shape again, the identical
 * defect in a new spot); and the fixed selector outweighs every `.md-X` rule
 * it has to beat, by the real specificity count, not by source position.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { renderChatMarkdown } from '../../src/chat-markdown.js'

const styles = readFileSync(new URL('../../src/chat-content.css', import.meta.url), 'utf8')

/* The FIRST top-level `selector { ... }` rule body for an exact selector
   string -- the same small helper tools/test/chat-msg-markdown.test.mjs and
   tools/test/chat-msg-text-newlines.test.mjs already use, not repeated as an
   import so this file stays readable as one self-contained pin. */
function ruleBody(css, selector) {
  const needle = `${selector} {`
  const start = css.indexOf(needle)
  if (start === -1) return null
  const openBrace = start + needle.length - 1
  const close = css.indexOf('}', openBrace)
  if (close === -1) return null
  return css.slice(openBrace + 1, close)
}

/* A REAL CSS SPECIFICITY COUNT (Selectors Level 4), narrow to the syntax this
 * file's own selectors use: class selectors, simple pseudo-classes, and
 * `:is(...)` (whose contributed weight is its most specific branch, per
 * spec -- never the sum of its branches, and never flattened to "1" the way
 * an ad hoc reading of `:is()` often assumes). Combinators (` `, `>`) and
 * whitespace carry no weight and are left in place; they simply never match
 * the class/pseudo-class patterns below. No ID, attribute, type or
 * pseudo-element selector appears anywhere this test reads, so this function
 * does not attempt to score them -- it would need to, to be a general
 * specificity engine, and this suite would rather stay honest about being
 * narrow than carry untested branches.
 */
function computeSpecificity(selector) {
  let weight = 0
  let rest = selector
  const isFn = /:is\(([^()]*)\)/
  let match
  while ((match = isFn.exec(rest))) {
    const branches = match[1].split(',').map(part => part.trim()).filter(Boolean)
    assert.ok(branches.length > 0, `:is() with no arguments in "${selector}"; that is not a selector this counter understands`)
    weight += Math.max(...branches.map(computeSpecificity))
    rest = rest.slice(0, match.index) + rest.slice(match.index + match[0].length)
  }
  assert.doesNotMatch(rest, /:where\(|::/, `"${selector}" uses :where() or a pseudo-element; this counter does not score either and must not silently under-count them`)
  const classes = rest.match(/\.[A-Za-z_-][\w-]*/g) || []
  /* A pseudo-class only -- the negative lookbehind refuses a second colon,
     which is how a pseudo-ELEMENT (`::before`) would otherwise be misread as
     a same-tier pseudo-class and over-counted. Guarded above by the
     `::`-rejection assert, so this pattern only ever needs to handle the
     single-colon case in practice; it is written correctly regardless. */
  const pseudoClasses = rest.match(/(?<!:):[A-Za-z-]+/g) || []
  return weight + classes.length + pseudoClasses.length
}

test('computeSpecificity matches hand-verifiable cases before it is trusted for the real assertions', () => {
  assert.equal(computeSpecificity('.md-h'), 1, 'one class is specificity 1')
  assert.equal(computeSpecificity('.chat-msg-text .md-h'), 2, 'two classes, descendant combinator, is specificity 2')
  assert.equal(computeSpecificity('.chat-msg-text > .md-h:first-child'), 3, 'two classes plus one pseudo-class is specificity 3')
  /* :is()'s branches are two classes deep each (".a.b"), so its own
     contributed weight is 2, not the 1 a same-tier reading of :is() would
     give it and not 2+2=4, the sum a naive reading would give it either. */
  assert.equal(computeSpecificity(':is(.a.b, .c)'), 2, ':is() contributes its MOST SPECIFIC branch, never the sum of all branches')
  assert.equal(computeSpecificity('.x :is(.a, .b.c):last-child'), 4, '.x(1) + :is(2, from .b.c) + :last-child(1) = 4')
})

test('the buggy unscoped `:last-child` reset has not come back', () => {
  assert.doesNotMatch(
    styles,
    /\.chat-msg-text\s*>\s*:last-child\s*\{/,
    'the bare ".chat-msg-text > :last-child" reset is back; it ties every .md-X rule below it on specificity and the ' +
      'later one wins by source position alone -- six of the seven block shapes silently stop getting a flush trailing edge',
  )
})

/* .chat-message-body, not a bare .chat-msg-text, since round 3
   of the code-and-preformatted lane: src/views/computers.js's tree-node rail
   (paintSaidReply, that file) is now the same renderChatMarkdown() surface
   .chat-msg-text always was, so its last block needs the identical trailing-
   margin reset. computeSpecificity below scores this UNCHANGED at 3: a
   two-single-class :is() contributes the weight of ONE of those classes (its
   most specific branch), the same 1 a bare `.chat-msg-text` contributed --
   see the ':is() contributes its MOST SPECIFIC branch' assertion above. */
const TRAILING_MARGIN_SELECTOR = '.chat-message-body > :is(.md-p, .md-h, .md-list, .md-quote, .md-rule, .md-code-block, .md-table-wrap):last-child'

test('the fixed selector exists, in the exact shape this suite can verify the specificity of', () => {
  const body = ruleBody(styles, TRAILING_MARGIN_SELECTOR)
  assert.ok(body !== null, `"${TRAILING_MARGIN_SELECTOR}" is missing, or its shape changed; re-read this pin before trusting it`)
  assert.match(body, /margin-bottom\s*:\s*0\s*;/, 'the fixed selector no longer zeroes margin-bottom')
})

test("the fixed selector's :is() list is exactly the block classes renderChatMarkdown() can put last", () => {
  /* Anchored to the :is() immediately before :last-child, not "the first
     :is() in the selector" -- TRAILING_MARGIN_SELECTOR carries a SECOND,
     earlier :is() now (the .chat-message-body surface list),
     and an unanchored match would silently grab that one's two branches
     instead of the seven block classes this test actually means to check. */
  const listed = TRAILING_MARGIN_SELECTOR.match(/:is\(([^)]*)\):last-child/)[1].split(',').map(part => part.trim().replace(/^\./, ''))
  /* One markdown source per block shape, each built so the shape in question
     is the ONLY thing rendered -- so the last (and only) top-level element's
     class is unambiguous. Read off the real renderer, never assumed. */
  const lastBlockClass = (markdown) => {
    const html = renderChatMarkdown(markdown)
    /* The outermost element's own class -- the first class= attribute in the
       output, which for every one of these single-block sources is also the
       last (and only) top-level element renderChatMarkdown produced. */
    const opening = /<[a-z][a-z0-9]* class="([^"]+)"/.exec(html)
    assert.ok(opening, `renderChatMarkdown produced no classed element for ${JSON.stringify(markdown)}`)
    return opening[1].split(/\s+/)[0]
  }
  const rendered = {
    'a paragraph': lastBlockClass('an ordinary paragraph'),
    'a heading': lastBlockClass('## a heading'),
    'a bullet list': lastBlockClass('- one\n- two'),
    'a numbered list': lastBlockClass('1. one\n2. two'),
    'a block quote': lastBlockClass('> quoted'),
    'a horizontal rule': lastBlockClass('---'),
    'a fenced code block': lastBlockClass('```\ncode\n```'),
    'a table': lastBlockClass('| a |\n| - |\n| b |'),
  }
  for (const [shape, className] of Object.entries(rendered)) {
    assert.ok(listed.includes(className), `renderChatMarkdown draws ${shape} as class "${className}", which is missing from ${TRAILING_MARGIN_SELECTOR}'s :is() list -- that shape silently loses its trailing-margin reset again when it lands last`)
  }
  /* And nothing UNMATCHED to a real shape: an extra name in the list is not
     a bug today, but it is exactly the kind of drift ("this used to render
     something, it does not any more, nobody noticed the rule went inert")
     this suite exists to catch on the other six classes -- so it is held to
     the same exact-match standard here. Bullet and numbered lists share one
     class (`.md-list`), so the rendered set is deduplicated before compare. */
  const renderedClasses = [...new Set(Object.values(rendered))].sort()
  assert.deepEqual(listed.slice().sort(), renderedClasses, "the :is() list and the classes renderChatMarkdown actually emits have drifted apart; re-derive one from the other")
})

test('the fixed selector outweighs every .md-X block rule it has to win a tie-break against, by real specificity', () => {
  const fixedWeight = computeSpecificity(TRAILING_MARGIN_SELECTOR)
  for (const selector of ['.chat-message-body .md-p', '.chat-message-body .md-h',
    '.chat-message-body .md-list', '.chat-message-body .md-quote',
    '.chat-message-body .md-rule', '.chat-message-body .md-code-block',
    '.chat-message-body .md-table-wrap']) {
    assert.ok(ruleBody(styles, selector) !== null, `"${selector}" is missing from src/styles.css; re-read this pin before trusting it`)
    const rivalWeight = computeSpecificity(selector)
    assert.ok(
      fixedWeight > rivalWeight,
      `"${TRAILING_MARGIN_SELECTOR}" (specificity ${fixedWeight}) no longer outweighs "${selector}" (specificity ${rivalWeight}) -- ` +
        'if that rival rule is ever moved to a later line than the trailing-margin reset, its own bottom margin would win the tie again',
    )
  }
})
