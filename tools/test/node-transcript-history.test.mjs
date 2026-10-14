import assert from 'node:assert/strict'
import test from 'node:test'

import { createDocument } from './lib/dom-stand-in.mjs'
import { mountTranscriptHistory } from '../../src/node-transcript-history.js'

// Item 10 C1+C2: closes "browse saved conversation never got updated" -- the
// archive browser drew raw markdown as literal text, with the speaker label
// and the words crammed onto one line with no turn separation. This exercises
// the hard cases named in the brief: a heading, a fenced code block, a list.
const HARD_CASE = [
  '## Findings',
  '',
  '- one',
  '- two',
  '',
  '1. first',
  '2. second',
  '',
  '```js',
  'const x = 1',
  '```',
  '',
].join('\n')

function fixture(entries) {
  const doc = createDocument()
  const store = { readPage: async () => ({ entries, before: null }) }
  mountTranscriptHistory({ host: doc.body, store, nodeId: 'n1', document: doc })
  return doc
}

async function open(doc) {
  doc.body.querySelector('button').click()
  // load() awaits store.readPage(); let its microtasks settle.
  await new Promise(resolve => setTimeout(resolve, 0))
}

test('an archive entry with a heading, a list and a fence renders through the real markdown renderer, not raw text', async () => {
  const doc = fixture([{ who: 'agent', text: HARD_CASE }])
  await open(doc)

  const heading = doc.body.querySelector('.md-h')
  const list = doc.body.querySelector('.md-list')
  const pre = doc.body.querySelector('.md-pre')
  assert.ok(heading, 'no rendered heading (.md-h) found in the produced markup')
  assert.match(heading.textContent, /Findings/)
  assert.ok(list, 'no rendered list (.md-list) found in the produced markup')
  assert.ok(pre, 'no rendered code block (.md-pre) found in the produced markup')
  assert.equal(list.querySelectorAll('li').length, 2, 'the two-item bulleted list did not produce two <li> rows')

  // The raw markers must not survive anywhere as literal text.
  assert.doesNotMatch(doc.body.textContent, /##\s*Findings/, 'a literal "## Findings" reached the glass')
  assert.doesNotMatch(doc.body.textContent, /```/, 'a literal code fence marker reached the glass')
})

test('an archive entry carries a labelled row, separate from its own text', async () => {
  const doc = fixture([{ who: 'you', text: 'a short reply' }])
  await open(doc)

  const row = doc.body.querySelectorAll('.chat-message-body')[0]
  assert.ok(row, 'no rendered message body found')
  // The label ("You") must not be baked into the same text node as the words.
  assert.doesNotMatch(row.textContent, /^You:/, 'the speaker label is still crammed onto the same line as the text')
})

test('saved history keeps its paging controls outside the scrollable entries and can close after a long page', async () => {
  const doc = fixture(Array.from({ length: 60 }, (_, n) => ({ who: 'agent', text: `Entry ${n}. ` + 'Long text '.repeat(50) })))
  const toggle = doc.body.querySelector('.node-transcript-history').querySelector('button')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  await open(doc)
  const region = doc.body.querySelector('.node-transcript-history-body')
  assert.equal(region.hidden, false)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  const entries = region.querySelector('.node-transcript-history-entries')
  const navigation = region.querySelector('.node-transcript-history-nav')
  assert.equal(entries.children.length, 60)
  assert.ok(navigation)
  assert.equal(entries.contains(navigation), false, 'paging must not scroll out with the archived entries')
  assert.equal(navigation.querySelectorAll('button').length, 2)
  toggle.click()
  assert.equal(region.hidden, true)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
})
