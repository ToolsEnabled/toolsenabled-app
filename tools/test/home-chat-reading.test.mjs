import test from 'node:test'
import assert from 'node:assert/strict'
import { findTextMatches } from '../../src/home-chat-reading.js'

test('find treats input as literal text, preserves Unicode offsets, and finds all occurrences', () => {
  const text = 'İstanbul: [a+b] / [A+B] / 😀 checkpoint'
  assert.deepEqual(findTextMatches(text, '[a+b]'), [{ offset: 10, length: 5 }, { offset: 18, length: 5 }])
  const matches = findTextMatches(text, 'checkpoint')
  assert.equal(text.slice(matches[0].offset, matches[0].offset + matches[0].length), 'checkpoint')
  assert.deepEqual(findTextMatches(text, '  '), [])
  assert.deepEqual(findTextMatches(text, 'missing'), [])
})

test('find bounds large result sets without shortening the searched content', () => {
  const text = 'word '.repeat(1000)
  assert.equal(findTextMatches(text, 'word').length, 500)
  assert.equal(findTextMatches(text, 'word', 3).length, 3)
  assert.equal(text.length, 5000)
})
