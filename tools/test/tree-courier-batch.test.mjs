import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
const { takeTreeBatch } = createRequire(import.meta.url)('../../shell/tree-courier-batch.cjs')

test('batches preserve arrival order and bound both message count and text length', () => {
  const queue = Array.from({ length: 20 }, (_, i) => `message ${i}`)
  assert.deepEqual(takeTreeBatch(queue).messages, Array.from({ length: 16 }, (_, i) => `message ${i}`))
  assert.deepEqual(queue, ['message 16', 'message 17', 'message 18', 'message 19'])
  const large = ['a'.repeat(32_000), 'b'.repeat(32_000), 'correction']
  assert.equal(takeTreeBatch(large).messages.length, 1)
  assert.equal(large.length, 2)
  const single = ['x'.repeat(65_000), 'next']
  assert.equal(takeTreeBatch(single).messages[0].length, 65_000)
  assert.deepEqual(single, ['next'])
  assert.deepEqual(takeTreeBatch([]).messages, [])
})

test('a retry keeps its exact payload and attempt budget apart from new arrivals', () => {
  const queue = ['first', 'correction']
  const original = takeTreeBatch(queue)
  original.failures = 2
  queue.push('new work')
  queue.unshift(...original.messages)
  assert.equal(takeTreeBatch(queue, original), original)
  assert.deepEqual(queue, ['new work'])
  assert.deepEqual(takeTreeBatch(queue), { messages: ['new work'], failures: 0 })
})

test('a cleared or replaced queue cannot inherit an old retry budget or messages', () => {
  const retry = { messages: ['old', 'correction'], failures: 2 }
  const queue = ['new work']
  assert.deepEqual(takeTreeBatch(queue, retry), { messages: ['new work'], failures: 0 })
  assert.deepEqual(takeTreeBatch([], retry), { messages: [], failures: 0 })
})

test('retained envelopes follow their text through batching without exceeding the turn limit', () => {
  const first = { text: 'a'.repeat(32_000), envelope: { id: 'first' } }
  const second = { text: 'b'.repeat(32_000), envelope: { id: 'second' } }
  const queue = [first, second]
  const batch = takeTreeBatch(queue)
  assert.deepEqual(batch.messages, [first])
  assert.equal(batch.messages[0], first, 'the original envelope must remain attached to its framed text')
  assert.deepEqual(queue, [second])
  queue.unshift(...batch.messages)
  assert.equal(takeTreeBatch(queue, batch), batch, 'a retry retains the same envelope and attempt state')
})
