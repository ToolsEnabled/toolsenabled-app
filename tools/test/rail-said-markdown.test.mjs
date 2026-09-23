// The Controls rail uses the shared renderer during streaming and on finish.
// Execute the production helper and pin its call sites in the large view.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { setChatMessageBody } from '../../src/chat-message-body.js'
import { createDocument } from './lib/dom-stand-in.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')
const styles = readFileSync(join(ROOT, 'src', 'styles.css'), 'utf8') + readFileSync(join(ROOT, 'src', 'chat-content.css'), 'utf8')

/* Comments blanked to spaces (newlines kept), the same helper
   tools/test/rail-status-repaint.test.mjs uses, duplicated rather than
   imported so this file stays a self-contained pin -- that file's own
   comment gives the same reason for not sharing it further. */
const blankButNewlines = text => text.replace(/[^\n]/g, ' ')
const stripped = source => source
  .replace(/\/\*[\s\S]*?\*\//g, blankButNewlines)
  .replace(/(^|[^:"'`])\/\/[^\n]*/g, (match, before) => before + blankButNewlines(match.slice(before.length)))

const code = stripped(view)

/** Slice a whole function (or block) by its header, brace-balanced -- same
    technique and same reason as rail-status-repaint.test.mjs's own. */
function sliceBlock(source, header, what) {
  const at = source.indexOf(header)
  assert.ok(at !== -1, `${what} is gone: ${JSON.stringify(header)} is not in the source`)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(at, i + 1)
    }
  }
  assert.fail(`${what} never closes its braces; the slice marker is stale`)
}

/* The FIRST top-level `selector { ... }` rule body for an exact selector
   string -- the same helper tools/test/chat-msg-markdown.test.mjs and
   siblings use, duplicated for the same self-contained-pin reason. */
function ruleBody(css, selector) {
  const needle = `${selector} {`
  const start = css.indexOf(needle)
  if (start === -1) return null
  const openBrace = start + needle.length - 1
  const close = css.indexOf('}', openBrace)
  if (close === -1) return null
  return css.slice(openBrace + 1, close)
}

/* --------------------------- the wiring, as source ------------------------ */

test('shared rendering and streaming helpers are imported into the Controls rail', () => {
  assert.match(view, /^import \{ setChatMessageBody, createChatMarkdownStream \} from '\.\.\/chat-message-body\.js'$/m,
    'computers.js no longer imports the safe renderer paintSaidReply depends on')
})

test('paintSaidReply exists exactly once and keeps the shared safe rendering contract', () => {
  const occurrences = (code.match(/function paintSaidReply\(/g) || []).length
  assert.equal(occurrences, 1, 'paintSaidReply must be defined exactly once, at module scope, so every call site shares one contract')
  const fn = sliceBlock(code, 'function paintSaidReply(host, text) {', 'paintSaidReply')
  assert.match(fn, /if\s*\(\s*!host\s*\)\s*return/, 'paintSaidReply lost its null-host guard -- a rail that has already been torn down would throw')
  assert.match(fn, /setChatMessageBody\(host, text\)/,
    'paintSaidReply no longer renders through renderChatMarkdown the same escape-first way every other buildChat() surface does')
  assert.ok(!/\.textContent\s*=/.test(fn), 'paintSaidReply must never fall back to a raw .textContent write -- that is the exact defect this function exists to close')
})

test('every finished-reply write to the said box goes through paintSaidReply, never raw .textContent', () => {
  /* The negative half of the contract: the old shape must not come back at
     ANY of the sites this round converted. Grep, not a line-number pin --
     line numbers move; this string must not exist anywhere in the file. */
  assert.ok(!/saidHost\.textContent\s*=\s*(?:reply|ENDED_SESSION\.said)\b/.test(code),
    'a finished reply (or the ended-session tail concatenated with one) is being written to the said box as raw .textContent again -- the exact pre-round-3 defect')
  /* The positive half: paintSaidReply actually is the replacement, and at the
     count this round put it at (the full-rebuild paint, the ended-session
     paint, the in-place repaint, and the two turn-completion settles) -- an
     exact count so a future site quietly reverting to .textContent, or a
     duplicate call added by accident, is a visible, deliberate diff here. */
  /* Re-counted 2026-09-11: the example fleet's simulated turn settles the said
     box through the same call (drawSampleSaid in src/views/computers.js), which
     is the sixth call site. */
  const calls = (code.match(/paintSaidReply\(/g) || []).length
  assert.equal(calls, 7, `expected paintSaidReply to be defined once and called 6 times (7 total occurrences of "paintSaidReply("); found ${calls} -- re-count the real call sites before changing this pin`)
})

test('SAID_PANEL.waiting -- a placeholder for a turn that has not happened -- stays plain text on purpose', () => {
  /* The one branch this round deliberately left alone: there is no agent
     content to render for a node that has never spoken. Pinned so a later
     "make everything consistent" pass does not quietly delete the comment
     explaining why, or the branch itself. */
  const said = sliceBlock(code, 'const saidHost = controlsPage.querySelector(\'[data-tree-said]\')', 'the said-box full-rebuild paint')
  assert.match(said, /saidHost\.textContent = SAID_PANEL\.waiting/,
    'the "not spoken yet" placeholder no longer renders as plain text -- if it now carries agent content this guard is stale, not wrong to remove')
})

test('railSaid tracks its own host element, so a turn that settles can repaint the exact node it streamed into', () => {
  assert.match(code, /railSaid\s*=\s*\{\s*nodeId:\s*node\.id,\s*appender,\s*waitingLine,\s*host:\s*saidHost\s*\}/,
    'the railSaid object lost its `host` field -- the turn-completion handlers below have no element to repaint and cannot call paintSaidReply')
})

test('both turn-completion paths repaint the said box through paintSaidReply BEFORE disposing the stream, never after', () => {
  /* Anchored between flushNow() (the last raw text actually lands) and
     disposeRailSaid() (railSaid, and the `.host` reference on it, both go to
     null) -- paintSaidReply has to run inside that window or it either
     paints stale text (before flushNow) or has nothing left to paint
     (after disposeRailSaid). matchAll, not a line-number slice: this round
     touches two independent turn-completion handlers (an ordinary
     completion and a child-process-exit-as-implicit-completion), and a
     count pins that both were fixed, not just the first one found. */
  /* The third window is the example fleet's simulated turn completion
     (drawSampleSaid, 2026-09-11), held to the same order below. */
  const windows = [...code.matchAll(/railSaid\.appender\.flushNow\(\)([\s\S]*?)disposeRailSaid\(\)/g)]
  assert.equal(windows.length, 3, 'expected exactly three railSaid.appender.flushNow() -> disposeRailSaid() windows (the ordinary completion, the child-exit path and the example simulation); re-locate all three before trusting this pin')
  for (const [, between] of windows) {
    assert.match(between, /paintSaidReply\(railSaid\.host,\s*said\)/,
      'a turn settled and disposed its stream without ever repainting the said box through paintSaidReply -- the box is left showing raw mid-stream text forever')
  }
})

test('the rail template still carries both classes paintSaidReply and its CSS are keyed on', () => {
  assert.match(view, /class="rail-prose rail-said"\s+data-tree-said/,
    'the said box lost .rail-prose (font/line-height/overflow-wrap voice) or .rail-said (the markdown bounding rules below) or its data hook')
})

/* ----------------------------- the CSS, as text ---------------------------- */

test('the live rail uses the shared Markdown stream before completion', () => {
  assert.match(code, /const appender = createChatMarkdownStream\(\{/)
  assert.doesNotMatch(code, /createTranscriptAppender\(/)
})

for (const cls of ['.md-pre', '.md-table-wrap', '.md-code']) {
  test(`.chat-message-body ${cls} exists -- the said box is bounded the same way every buildChat() window is`, () => {
    const body = ruleBody(styles, `.chat-message-body ${cls}`)
    assert.ok(body !== null, `no ".chat-message-body ${cls} {" rule in src/styles.css -- the said box lost this rule, or never widened to include it`)
  })
}

test('a code block in the said box scrolls inside itself instead of widening the rail', () => {
  const pre = ruleBody(styles, '.chat-message-body .md-pre')
  assert.ok(pre !== null, 'no ".chat-message-body .md-pre {" rule in src/styles.css')
  assert.match(pre, /overflow-x\s*:\s*auto\s*;/, '.md-pre must scroll rather than force the rail wider')
  assert.match(pre, /max-width\s*:\s*100%\s*;/, '.md-pre must not exceed the rail it sits in')
})

test('a table in the said box scrolls inside itself instead of widening the rail', () => {
  const wrap = ruleBody(styles, '.chat-message-body .md-table-wrap')
  assert.ok(wrap !== null, 'no ".chat-message-body .md-table-wrap {" rule in src/styles.css')
  assert.match(wrap, /overflow-x\s*:\s*auto\s*;/, '.md-table-wrap must scroll rather than force the rail wider')
  assert.match(wrap, /max-width\s*:\s*100%\s*;/, '.md-table-wrap must not exceed the rail it sits in')
})

/* ------------------------- the whole thing, driven -------------------------- */

/* The same tiny mirror rail-status-repaint.test.mjs's own instantiateRepaint
   uses -- see that file's header for why a mirror rather than an export:
   paintSaidReply is a private, free-standing helper, proven by source above
   AND driven here through the REAL renderChatMarkdown import, so only the
   DOM write itself (a plain object's `.innerHTML` property standing in for a
   real element's) is a stand-in. */
const paintSaidReply = new Function('setChatMessageBody', sliceBlock(code, 'function paintSaidReply(host, text) {', 'paintSaidReply') + '; return paintSaidReply')(setChatMessageBody)

test('a finished reply with a fenced code block draws as bounded markup, not literal backticks', () => {
  const host = createDocument().createElement('div')
  paintSaidReply(host, 'Findings:\n\n```\nls -la\n```\n\nDone.')
  assert.ok(host.querySelector('.md-pre'), 'a fenced block must draw as .md-pre -- the class the CSS above bounds')
  assert.ok(!host.textContent.includes('```'), 'the fence marker must not survive as literal text once rendered')
})

test('a long unbroken token reaching the said box cannot force it wide, and escaping still holds', () => {
  const host = createDocument().createElement('div')
  const hostileToken = 'C:\\Users\\example\\AVeryLongPathSegmentWithNoSpacesAtAll\\' + 'x'.repeat(120)
  paintSaidReply(host, `See \`${hostileToken}\` and <script>alert(1)</script>`)
  assert.ok(host.querySelector('.md-code'), 'an inline code span must draw as .md-code -- the class .rail-said now bounds via the shared overflow-wrap on .rail-prose')
  assert.equal(host.querySelector('script'), null, 'no real <script> element may reach the said box')
  assert.match(host.textContent, /script/i, 'the words must still reach the glass, escaped, not silently dropped')
})
