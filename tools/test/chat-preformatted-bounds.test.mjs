// Code, tables, long tokens, and tool output stay within their transcript.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const stylesCss = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')
const homeCss = readFileSync(new URL('../../src/home.css', import.meta.url), 'utf8')
const chatCss = readFileSync(new URL('../../src/chat-content.css', import.meta.url), 'utf8')

/* The FIRST top-level `selector { ... }` rule body for an exact selector
   string. Identical to the helper tools/test/chat-msg-markdown.test.mjs and
   tools/test/chat-msg-text-newlines.test.mjs already carry -- not imported
   from either, because neither exports it and this file reads a second
   stylesheet those files never touch. */
function ruleBody(css, selector) {
  const needle = `${selector} {`
  const start = css.indexOf(needle)
  if (start === -1) return null
  const openBrace = start + needle.length - 1
  const close = css.indexOf('}', openBrace)
  if (close === -1) return null
  return css.slice(openBrace + 1, close)
}

test('the home page code block scrolls inside itself instead of widening the panel', () => {
  const pre = ruleBody(chatCss, '.chat-message-body .md-pre')
  assert.ok(pre !== null, 'no ".home .turn-text .md-pre {" rule in src/home.css')
  assert.match(pre, /overflow-x\s*:\s*auto\s*;/, '.md-pre must scroll rather than force the panel wider')
  assert.match(pre, /max-width\s*:\s*100%\s*;/, '.md-pre must not exceed the panel it sits in')
})

test('the home page table scrolls inside itself instead of widening the panel', () => {
  const wrap = ruleBody(chatCss, '.chat-message-body .md-table-wrap')
  assert.ok(wrap !== null, 'no ".home .turn-text .md-table-wrap {" rule in src/home.css')
  assert.match(wrap, /overflow-x\s*:\s*auto\s*;/, '.md-table-wrap must scroll rather than force the panel wider')
  assert.match(wrap, /max-width\s*:\s*100%\s*;/, '.md-table-wrap must not exceed the panel it sits in')
})

test('a long unbroken run of characters wraps instead of overflowing the home page panel', () => {
  const body = ruleBody(homeCss, '.home .turn-text')
  assert.ok(body !== null, 'no ".home .turn-text {" rule in src/home.css')
  assert.match(body, /overflow-wrap\s*:\s*anywhere\s*;/,
    '.home .turn-text has no overflow-wrap -- one long unbroken token (a path, a hash) can still push the panel wider than it is')
})

test('a tool call\'s raw output wraps instead of widening its row, and stays capped', () => {
  const body = ruleBody(stylesCss, '.chat-action-body')
  assert.ok(body !== null, 'no ".chat-action-body {" rule in src/styles.css')
  /* word-break, not overflow-wrap: this is the property .chat-action-body
     actually carries, and it closes the same hole -- an unbreakable run
     (a long path, a hash with no spaces) forced to break rather than push
     the row wider than the transcript column. */
  assert.match(body, /word-break\s*:\s*break-word\s*;/,
    '.chat-action-body has no word-break -- one long unbroken token in a command\'s raw output can still push the row wider than it is')
  assert.match(body, /white-space\s*:\s*pre-wrap\s*;/,
    '.chat-action-body must wrap ordinary line breaks, not just refuse to overflow on one giant token')
  assert.match(body, /max-height\s*:\s*\d+px\s*;/,
    '.chat-action-body has no height cap -- a long command\'s output could otherwise grow the row without bound')
})
