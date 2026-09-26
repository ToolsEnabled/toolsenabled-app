import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatMarkdownStream, setChatMessageBody } from '../../src/chat-message-body.js'
import { createDocument } from './lib/dom-stand-in.mjs'

function streamFixture() {
  const doc = createDocument(), node = doc.createElement('div'), frames = new Map()
  let next = 0
  const stream = createChatMarkdownStream({
    node,
    scheduleFrame: fn => { frames.set(++next, fn); return next },
    cancelFrame: id => frames.delete(id),
  })
  return { node, stream, frames, tick() { const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn()) } }
}

test('rail deltas coalesce before rendering complete Markdown without losing words', () => {
  const { node, stream, frames, tick } = streamFixture()
  stream.push('## A response\n\nUse **')
  stream.push('care** with the result.\n\n')
  assert.equal(frames.size, 1)
  assert.equal(node.textContent, '')
  tick()
  assert.equal(node.querySelector('.md-h').textContent, 'A response')
  assert.equal(node.querySelector('strong').textContent, 'care')
  assert.equal(stream.pendingCount, 0)
  stream.push('\n\nThe final detail.')
  stream.flushNow()
  assert.equal(frames.size, 0)
  assert.match(node.textContent, /The final detail\./)
})

test('reset cancels unfinished words and the next turn starts with an empty source', () => {
  const { node, stream, frames, tick } = streamFixture()
  stream.push('Old completed words'); stream.flushNow()
  stream.push(' and a queued old tail')
  stream.reset()
  assert.equal(frames.size, 0)
  assert.equal(node.hidden, true)
  /* The subject here is RESET, not withholding: the new turn must show its own
     words and none of the cancelled tail. The intermediate '' this used to
     assert came from the readable hold, which no longer withholds prose --
     see the rule at the top of src/chat-readable-stream.js. */
  stream.push('New words'); tick()
  assert.equal(node.textContent, 'New words')
  stream.flushNow()
  assert.equal(node.textContent, 'New words')
  assert.equal(node.textContent.includes('queued old tail'), false, 'the cancelled tail came back')
  assert.equal(node.hidden, false)
})

test('disposing a rail cancels its pending frame and rejects late deltas', () => {
  const { node, stream, frames, tick } = streamFixture()
  stream.push('Retained answer'); stream.flushNow()
  stream.push(' stale continuation')
  stream.dispose()
  stream.push(' late words')
  stream.flushNow(); tick()
  assert.equal(frames.size, 0)
  assert.equal(node.textContent, 'Retained answer')
})

test('the same source can switch between literal user text and rich assistant text', () => {
  const doc = createDocument(), node = doc.createElement('div')
  setChatMessageBody(node, '**Literal** <script>bad()</script>', { plain: true })
  assert.equal(node.querySelector('strong'), null)
  assert.equal(node.textContent, '**Literal** <script>bad()</script>')
  setChatMessageBody(node, '**Literal** <script>bad()</script>')
  assert.equal(node.querySelector('strong').textContent, 'Literal')
  assert.equal(node.querySelector('script'), null)
})

test('chat updates do not rewrite unchanged formatting attributes on every stream or repaint', () => {
  const doc = createDocument(), node = doc.createElement('div')
  setChatMessageBody(node, 'First words')
  let classWrites = 0, formatWrites = 0
  const add = node.classList.add.bind(node.classList)
  node.classList.add = (...names) => { classWrites++; add(...names) }
  node.dataset = new Proxy(node.dataset, { set(target, key, value) { formatWrites++; target[key] = value; return true } })
  for (let n = 0; n < 100; n++) setChatMessageBody(node, 'First words')
  for (let n = 0; n < 100; n++) setChatMessageBody(node, `First words and ${n}`)
  assert.equal(classWrites, 0)
  assert.equal(formatWrites, 0)
  assert.equal(node.textContent, 'First words and 99')
  setChatMessageBody(node, '**literal**', { plain: true })
  assert.equal(formatWrites, 1)
  assert.equal(node.dataset.chatFormat, 'plain')
  assert.equal(node.querySelector('strong'), null)
})
