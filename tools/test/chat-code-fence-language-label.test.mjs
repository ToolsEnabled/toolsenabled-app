import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { renderChatMarkdown } from '../../src/chat-markdown.js'
import { markdownTree } from './helpers/chat-markdown-tree.mjs'

const css = readFileSync(new URL('../../src/chat-content.css', import.meta.url), 'utf8')
const rule = selector => {
  const start = css.indexOf(selector + ' {')
  assert.ok(start >= 0, selector)
  return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
}

test('the code language is a readable caption beside accessible copy and wrap controls', () => {
  const body = markdownTree('```js\nconst a = 1\n```')
  const card = body.querySelector('figure')
  assert.ok(card)
  assert.equal(card.querySelector('figcaption .md-code-language').textContent, 'JavaScript')
  assert.equal(card.querySelector('[data-chat-code-copy]').getAttribute('aria-label'), 'Copy code')
  assert.equal(card.querySelector('[data-chat-code-wrap]').getAttribute('aria-pressed'), 'false')
  assert.equal(card.querySelector('pre').getAttribute('data-lang'), 'js')
  assert.equal(card.querySelector('pre').getAttribute('tabindex'), '0')
})

test('a fence without a language has a useful Text label and keeps its content', () => {
  const body = markdownTree('```\nplain\n```')
  assert.equal(body.querySelector('.md-code-language').textContent, 'Text')
  assert.equal(body.querySelector('code').textContent, 'plain')
  assert.match(renderChatMarkdown('```\nplain\n```'), /<code>plain\n<\/code>/)
})

test('the header sits outside the code scrollport without negative margins', () => {
  const card = rule('.chat-message-body .md-code-block')
  const head = rule('.chat-message-body .md-code-head')
  assert.match(card, /overflow:\s*hidden/)
  assert.match(head, /display:\s*flex/)
  assert.doesNotMatch(card + head, /margin[^:]*:\s*-/)
  const pre = rule('.chat-message-body .md-pre')
  assert.match(pre, /overflow-x:\s*auto/)
  assert.match(pre, /max-width:\s*100%/)
  assert.match(pre, /padding:\s*15px 17px/)
  assert.match(rule('.chat-message-body .md-pre code'), /width:\s*max-content/)
})
