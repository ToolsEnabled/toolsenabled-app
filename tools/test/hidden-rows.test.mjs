// Direct contract coverage for src/hidden-rows.js. The ledger passes r:/q:
// record keys and keeps live and example registers apart; research passes its
// shipped queue item ids under a third storage key. Keep this test importable
// without either view, because both views also import CSS.

import test from 'node:test'
import assert from 'node:assert/strict'

import { createHiddenRows, HIDDEN_ROWS_CAP } from '../../src/hidden-rows.js'

class MemoryStorage {
  #values = new Map()

  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null }
  setItem(key, value) { this.#values.set(key, String(value)) }
  removeItem(key) { this.#values.delete(key) }
}

function withStorage(storage, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage })
  try { return run() } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
}

test('real ledger and research caller keys round-trip without crossing lists', () => {
  withStorage(new MemoryStorage(), () => {
    const live = createHiddenRows('mc.ledger.hidden:live')
    const example = createHiddenRows('mc.ledger.hidden:example')
    const research = createHiddenRows('mc.research.queue-hidden')

    assert.equal(live.add('r:R12'), true, 'a ledger request key should be accepted')
    assert.equal(live.add('q:Q7'), true, 'a ledger question key should be accepted')
    assert.equal(research.add('queue-catalog-7'), true, 'a shipped research item id should be accepted')
    assert.equal(live.add('r:R12'), true, 'adding an already-hidden row should remain a successful no-op')
    assert.deepEqual(
      createHiddenRows('mc.ledger.hidden:live').list(),
      ['r:R12', 'q:Q7'],
      'a remounted ledger should see its persisted, de-duplicated hidden rows',
    )
    assert.deepEqual(example.list(), [], 'the example register should not inherit live hidden rows')
    assert.deepEqual(research.list(), ['queue-catalog-7'], 'the research queue should retain only its own hidden ids')

    assert.equal(live.remove('r:R12'), true, 'removing a hidden row should report a change')
    assert.equal(live.remove('r:R12'), false, 'removing an already-visible row should report no change')
    live.clear()
    assert.deepEqual(live.list(), [], 'clearing a list should leave no hidden rows')
  })
})

test('stored rows are validated, de-duplicated, and bounded before callers consume them', () => {
  withStorage(new MemoryStorage(), () => {
    localStorage.setItem('damaged', '{not json')
    assert.deepEqual(createHiddenRows('damaged').list(), [], 'malformed JSON should degrade to an empty list rather than throw')

    localStorage.setItem('mixed', JSON.stringify({
      v: 1,
      ids: ['r:R1', 'r:R1', '', 7, 'x'.repeat(201), 'q:Q2'],
    }))
    assert.deepEqual(
      createHiddenRows('mixed').list(),
      ['r:R1', 'q:Q2'],
      'stored ids should include each valid bounded string exactly once',
    )

    const full = createHiddenRows('full')
    for (let index = 0; index < HIDDEN_ROWS_CAP; index += 1) {
      assert.equal(full.add(`queue-${index}`), true, `row ${index} should fit within the advertised cap`)
    }
    assert.equal(full.add('queue-over-cap'), false, 'a row beyond the advertised cap should be refused')
    assert.equal(full.count(), HIDDEN_ROWS_CAP, 'the stored row count should never exceed the advertised cap')
  })
})

test('the factory rejects keys that cannot identify a storage list', () => {
  assert.throws(
    () => createHiddenRows(''),
    { name: 'TypeError' },
    'an empty storage key should be rejected instead of sharing an anonymous list',
  )
  assert.throws(
    () => createHiddenRows(null),
    { name: 'TypeError' },
    'a non-string storage key should be rejected before storage is read',
  )
})

/* HIDES FOR LEDGER RECORDS THAT ARE GONE STOP TAKING ROOM (T1283). */
test('prune forgets Ledger hides the read no longer carries, and never a question or another list\'s key', async () => {
  const { createHiddenRows } = await import('../../src/hidden-rows.js')
  const values = new Map()
  const before = globalThis.localStorage
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  try {
    const rows = createHiddenRows('mc.ledger.hidden:live')
    for (const key of ['r:R1', 't:T5', 'a:A2', 'p:P1', 'q:Q7', 'research-item-3']) rows.add(key)
    assert.equal(rows.prune(new Set(['r:R1', 'a:A2'])), 2, 'the gone task and purchase hides were not forgotten')
    assert.deepEqual(rows.list(), ['r:R1', 'a:A2', 'q:Q7', 'research-item-3'])
    assert.equal(rows.prune(new Set(['r:R1', 'a:A2'])), 0)
    assert.equal(rows.prune(null), 0, 'no read, no forgetting')
  } finally { globalThis.localStorage = before }
})
