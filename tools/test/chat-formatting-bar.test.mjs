/* R1204'S ACCEPTANCE BAR, MADE EXECUTABLE.
 *
 * The owner, R1204: "the chat windows DO NOT HAVE enough formatting cleanup.
 * We need to be make the chat more readable". That names no bar, so Controller
 * filed owner ask A1 with a default one and said to build against it now:
 *
 *   at all three text sizes, these samples must render with no horizontal
 *   overflow, code fences scrolling internally, lists indented, tables
 *   readable, and headings distinct: (1) a long code fence, (2) a nested list,
 *   (3) a wide table, (4) mixed prose with tool output, (5) a message with
 *   headings.
 *
 * Five samples times three text sizes is fifteen results, and this suite
 * reports fifteen rather than one. Each renders the real sample through
 * renderChatMarkdown and checks the properties the bar names for it.
 *
 * WHY THE STYLESHEET IS READ RATHER THAN THE PIXELS MEASURED. There is no
 * layout engine here, so "did it overflow" cannot be observed directly. This
 * asserts the CSS contract that makes overflow impossible -- the same method
 * tools/test/chat-preformatted-bounds.test.mjs and chat-msg-markdown.test.mjs
 * already use for exactly this question. It is a structural result, not a
 * rendered one, and the report says so.
 *
 *   node --test tools/test/chat-formatting-bar.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { renderChatMarkdown } from '../../src/chat-markdown.js'
import { TEXT_SIZES, applyTextSize, textZoom } from '../../src/text-size.js'
import { createDocument } from './lib/dom-stand-in.mjs'

const chatCss = readFileSync(new URL('../../src/chat-content.css', import.meta.url), 'utf8')

/* EVERY declaration that applies to a class, not just the first rule for it.
   The helper the neighbouring suites carry returns the FIRST matching rule
   body, which is wrong here: .md-pre alone is styled by three separate rules,
   and a bound declared in the second would read as absent. */
function declarationsFor(css, className) {
  const found = []
  const pattern = new RegExp(`(^|[^-\\w])\\.${className}(?![-\\w])`)
  let index = 0
  while (index < css.length) {
    const open = css.indexOf('{', index)
    if (open === -1) break
    const close = css.indexOf('}', open)
    if (close === -1) break
    const selector = css.slice(index, open)
    if (pattern.test(selector)) found.push(css.slice(open + 1, close))
    index = close + 1
  }
  return found.join(';')
}

/* Only the rules that style the ELEMENT ITSELF, not its descendants.
   declarationsFor aggregates every rule naming the class, which is too loose
   for a question about the element: `.md-list > li { padding-left: .2em }`
   made the list-indent check pass with the list's own padding deleted. The
   mutation check below is what found that, so it is kept as its own helper
   rather than folded back in. */
function ownDeclarationsFor(css, className) {
  const found = []
  let index = 0
  while (index < css.length) {
    const open = css.indexOf('{', index)
    if (open === -1) break
    const close = css.indexOf('}', open)
    if (close === -1) break
    const selectors = css.slice(index, open).split(',')
    const targetsSelf = selectors.some(part => {
      const last = part.trim().split(/[\s>+~]+/).pop() || ''
      return new RegExp(`\\.${className}(?![-\\w])`).test(last)
    })
    if (targetsSelf) found.push(css.slice(open + 1, close))
    index = close + 1
  }
  return found.join(';')
}

/* A block cannot widen the transcript if it either scrolls inside itself or is
   held to the column. Either one closes the hole; neither is optional. */
const scrollsInternally = cls => /overflow-x\s*:\s*auto/.test(ownDeclarationsFor(chatCss, cls))
const heldToColumn = cls => /max-width\s*:\s*(100%|\d+(?:\.\d+)?(?:ch|em|px))/.test(ownDeclarationsFor(chatCss, cls))
const bounded = cls => scrollsInternally(cls) || heldToColumn(cls)

/* The rendered markup itself. An earlier draft parsed it into the DOM
   stand-in and read .innerHTML back; that does not round-trip here, and the
   vacuity guard below caught the checks measuring an empty string rather than
   passing on nothing. The renderer's own output is the honest subject. */
const render = source => renderChatMarkdown(source)
/* THE TOP-LEVEL BLOCKS ONLY, each with its whole class list.
   Two corrections a first draft got wrong, both found by running it:
   an element is bounded by ANY of its classes (an .md-h1 is held to the
   column by the .md-h it also carries), and content nested inside a block is
   already bounded by that block -- a cell cannot widen a transcript through a
   wrapper that scrolls. So this walks depth 0 and returns class lists. */
const VOID_TAGS = new Set(['hr', 'br', 'img', 'input'])
function topLevelBlocks(html) {
  const blocks = []
  let depth = 0
  for (const match of html.matchAll(/<(\/)?([a-z][a-z0-9]*)\b([^>]*)>/g)) {
    const closing = Boolean(match[1])
    const tagName = match[2]
    const attrs = match[3] || ''
    const selfClosing = VOID_TAGS.has(tagName) || /\/$/.test(attrs.trim())
    if (closing) { depth -= 1; continue }
    if (depth === 0) {
      const found = /class="([^"]+)"/.exec(attrs)
      blocks.push({ tag: tagName, classes: found ? found[1].split(/\s+/) : [] })
    }
    if (!selfClosing) depth += 1
  }
  return blocks
}

/* The five samples A1 names, each written to be the hard case of its kind. */
const SAMPLES = {
  'long code fence': '```js\nconst averyLongIdentifierThatKeepsGoingAndGoing = someFunctionCall(argumentOne, argumentTwo, argumentThree, argumentFour) // a trailing comment that runs well past any sane column\n```',
  'nested list': '- top level\n  - second level\n    - third level\n      - fourth level\n\n1. ordered\n   1. nested ordered',
  'wide table': '| col1 | col2 | col3 | col4 | col5 | col6 | col7 | col8 |\n|---|---|---|---|---|---|---|---|\n| aaaa | bbbb | cccc | dddd | eeee | ffff | gggg | /a/very/long/unbroken/value/with/no/spaces/at/all |',
  'prose with tool output': 'Here is prose explaining the thing.\n\n```\n/very/long/path/that/never/breaks/anywhere/because/it/has/no/spaces/in/it/whatsoever.txt\n```\n\nMore prose after it.',
  'headings': '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n\nbody text',
}

/* The bar's properties, per sample, in A1's own words. */
const BAR = {
  'long code fence': ['no horizontal overflow', 'fences scroll internally'],
  'nested list': ['no horizontal overflow', 'lists indented'],
  'wide table': ['no horizontal overflow', 'tables readable'],
  'prose with tool output': ['no horizontal overflow'],
  'headings': ['no horizontal overflow', 'headings distinct'],
}

const CHECKS = {
  'no horizontal overflow': html => {
    /* Every block this sample actually emitted must be bounded, and inline
       runs with no break opportunity must be allowed to break. */
    const blocks = topLevelBlocks(html)
    assert.ok(blocks.length > 0, 'the sample emitted no top-level block -- this check would be vacuous')
    for (const block of blocks) {
      assert.ok(block.classes.some(bounded),
        `<${block.tag} class="${block.classes.join(' ')}"> is neither held to the column nor scrolling internally, so it can widen the transcript`)
    }
    assert.match(declarationsFor(chatCss, 'chat-message-body'), /overflow-wrap\s*:\s*anywhere/,
      'one unbroken token (a path, a hash) must be allowed to break rather than push the column wider')
  },
  'fences scroll internally': html => {
    assert.ok(html.includes('md-pre'), 'the fence sample must emit a .md-pre')
    assert.ok(scrollsInternally('md-pre'), '.md-pre must scroll inside itself rather than widen the panel')
    assert.ok(heldToColumn('md-code-block'), 'the fence figure must not exceed the column it sits in')
  },
  'lists indented': html => {
    assert.ok(html.includes('md-list'), 'the list sample must emit a .md-list')
    assert.match(ownDeclarationsFor(chatCss, 'md-list'), /padding-left\s*:\s*[\d.]+(?:em|ch|px)/,
      'a list with no left padding reads as prose with stray bullets')
    /* Nesting must actually nest: a flattened list is indented and still wrong. */
    assert.match(html, /<(?:ul|ol)[^>]*class="md-list"[\s\S]*<(?:ul|ol)[^>]*class="md-list"/,
      'the nested sample must produce a list inside a list')
  },
  'tables readable': html => {
    assert.ok(html.includes('md-table-wrap'), 'a table must be wrapped in its own scroller')
    assert.ok(scrollsInternally('md-table-wrap'), '.md-table-wrap must scroll rather than widen the panel')
    // <th\b, not <th[^>]*: the looser pattern also matches <thead> and counted nine columns in an eight-column table.
    const headers = [...html.matchAll(/<th\b[^>]*>/g)].length
    assert.equal(headers, 8, `every column must survive rendering; found ${headers} of 8`)
    assert.match(declarationsFor(chatCss, 'md-table'), /border-collapse\s*:\s*collapse/,
      'a table without collapsed borders reads as a grid of boxes rather than rows')
    /* A cell that cannot wrap turns one long value into one very wide column,
       which is the difference between a table that scrolls and a table that is
       readable. The sample's last cell is exactly such a value. */
    const cell = declarationsFor(chatCss, 'md-table')
    assert.match(cell, /overflow-wrap\s*:\s*anywhere/,
      'a table cell must be able to break an unbroken value rather than widen its column without limit')
    assert.match(cell, /max-width\s*:\s*\d+(?:\.\d+)?ch/,
      'a table cell needs a column cap, or one long value sets the width of the whole table')
  },
  'headings distinct': html => {
    /* Distinct FROM THE PROSE AROUND THEM: that is the readable property. Each
       level's own size is checked below, where the ones that share a size are
       named rather than hidden. */
    const heading = declarationsFor(chatCss, 'md-h')
    assert.match(heading, /font-weight\s*:\s*[67]\d\d/, 'a heading must be heavier than the prose it introduces')
    assert.match(heading, /margin\s*:/, 'a heading must be separated from the prose it introduces')
    for (const level of ['md-h1', 'md-h2', 'md-h3', 'md-h4', 'md-h5', 'md-h6']) {
      assert.ok(html.includes(level), `the headings sample must emit .${level}`)
    }
  },
}

/* THE FIFTEEN. Five samples, each at each of the three offered text sizes. */
for (const [name, source] of Object.entries(SAMPLES)) {
  for (const size of TEXT_SIZES) {
    test(`bar: ${name} at text size ${size}`, () => {
      const doc = createDocument()
      const applied = applyTextSize(size, doc)
      assert.equal(applied, size, 'the size under test must be one the product actually offers')
      assert.equal(textZoom(doc), size, 'the document must be carrying the size this result claims')
      const html = render(source)
      for (const property of BAR[name]) CHECKS[property](html)
    })
  }
}

/* WHY THE THREE SIZES ARE GENUINELY COVERED, rather than one result copied.
   Text size is applied as document zoom (src/text-size.js writes body.style.
   zoom and --zoom). Zoom scales every absolute length with it, so a rule in
   px, em or ch holds its proportions at all three sizes. The one family that
   does NOT scale under zoom is viewport units -- that is the exact mechanism
   behind the page-2 complaint in R1206, where 36.1vw had to be divided by
   --zoom by hand. If a viewport unit ever enters chat content, the fifteen
   results above stop generalising and this test says so. */
test('chat content carries no length that escapes the text-size zoom', () => {
  const offenders = [...chatCss.matchAll(/[\s:(](\d+(?:\.\d+)?)(vw|vh|vmin|vmax)\b/g)].map(m => m[1] + m[2])
  assert.deepEqual(offenders, [],
    `viewport units do not scale with zoom, so these would change proportion with text size: ${offenders.join(', ')}`)
})

/* Heading levels must not invert. A level that renders larger than the level
   above it is a hierarchy a reader cannot follow. This asserts the ordering,
   not the six numbers, so making the lower levels MORE distinct keeps it
   green -- pinning the current sizes would fail against that improvement. */
test('heading levels never invert, so the hierarchy can be followed', () => {
  const sizeOf = level => {
    const found = /font-size\s*:\s*([\d.]+)em/.exec(declarationsFor(chatCss, level))
    return found ? Number(found[1]) : 1
  }
  const sizes = ['md-h1', 'md-h2', 'md-h3', 'md-h4', 'md-h5', 'md-h6'].map(sizeOf)
  for (let index = 1; index < sizes.length; index += 1) {
    assert.ok(sizes[index] <= sizes[index - 1],
      `h${index + 1} (${sizes[index]}em) renders larger than h${index} (${sizes[index - 1]}em)`)
  }
  assert.ok(sizes[0] > sizes[sizes.length - 1], 'the top and bottom heading levels must not be the same size')
})

/* Distinct levels, not just a distinct size. h4, h5 and h6 all sit at the
   prose size on purpose -- going smaller reads worse -- so they must differ
   some other way. Before this bar was written they shared one rule and were
   pixel-identical, which is a hierarchy a reader cannot see. */
test('no heading level renders identically to the level below it', () => {
  const levels = ['md-h1', 'md-h2', 'md-h3', 'md-h4', 'md-h5', 'md-h6']
  const normalise = value => value.replace(/\s+/g, ' ').trim()
  for (let index = 1; index < levels.length; index += 1) {
    const above = normalise(ownDeclarationsFor(chatCss, levels[index - 1]))
    const below = normalise(ownDeclarationsFor(chatCss, levels[index]))
    assert.notEqual(below, above,
      `${levels[index]} is styled exactly like ${levels[index - 1]}, so the two levels cannot be told apart`)
  }
})
