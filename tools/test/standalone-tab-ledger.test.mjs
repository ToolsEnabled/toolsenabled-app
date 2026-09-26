/* B4 (1.0.48, owner decision: reopen them): the New agent tabs that are open are
   written down, so a restart can bring them back and the seat sweep can tell an
   open tab from a lost one. This pins the list itself: what a row may hold, that
   damage reads as damage rather than as "no tabs", and that the sweep's union
   over every computer's list fails closed. */
import assert from 'node:assert/strict'
import test from 'node:test'

const ledger = await import('../../src/standalone-tab-ledger.js')
const { createStandaloneTabLedger, standaloneTabIdsEverywhere, STANDALONE_TABS_PREFIX } = ledger

const solo = n => `standalone-0000000${n}-0000-4000-8000-00000000000${n}`
function memory({ enumerable = true, refuseWrites = false } = {}) {
  const values = new Map()
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => {
      if (refuseWrites) throw new Error('Could not save setting: the settings file could not be written')
      values.set(key, String(value))
    },
    removeItem: key => { values.delete(key) },
  }
  if (enumerable) {
    Object.defineProperty(storage, 'length', { get: () => values.size })
    storage.key = index => [...values.keys()][index] ?? null
  }
  return { storage, values }
}
const tab = (n, extra = {}) => ({ id: solo(n), name: `Agent ${n}`, tier: 'claude-sonnet', effort: 'high', openedAt: n, sessionId: null, ...extra })

test('the list keeps tab order, update never creates, forget removes, bad rows drop alone, 64 at most, a refused write says false', () => {
  const { storage, values } = memory()
  const list = createStandaloneTabLedger({ storage, computerId: 'this-computer' })
  assert.equal(list.key, STANDALONE_TABS_PREFIX + 'this-computer')
  assert.equal(STANDALONE_TABS_PREFIX, 'mc.fleet.standalone-tabs.v1:')
  assert.deepEqual(list.read(), { ok: true, tabs: [] }, 'a list that was never written is empty, not damaged')

  assert.equal(list.remember(tab(2)), true)
  assert.equal(list.remember(tab(1)), true)
  assert.equal(list.remember(tab(3)), true)
  assert.deepEqual(list.read().tabs.map(row => row.id), [solo(2), solo(1), solo(3)], 'array order is tab order')
  assert.deepEqual(list.read().tabs[0], tab(2))

  assert.equal(list.update(solo(1), { tier: 'luna', effort: 'max', sessionId: 'session-one', unknown: 'ignored' }), true)
  assert.deepEqual(list.read().tabs[1], { ...tab(1), tier: 'luna', effort: 'max', sessionId: 'session-one' })
  assert.equal(list.update(solo(4), { tier: 'luna' }), false, 'update never creates an entry')
  assert.equal(list.read().tabs.length, 3)

  assert.equal(list.forget(solo(1)), true)
  assert.deepEqual(list.read().tabs.map(row => row.id), [solo(2), solo(3)])
  assert.deepEqual([...list.ids()], [solo(2), solo(3)])

  // Rows that fail a check are dropped one by one; unknown fields are ignored.
  values.set(list.key, JSON.stringify({ v: 1, tabs: [
    tab(5, { extra: 'kept out' }),
    { ...tab(6), id: 'standalone-not-a-uuid' },
    { ...tab(7), name: '' },
    { ...tab(8), name: 'x'.repeat(81) },
    { ...tab(9), tier: 'y'.repeat(129) },
    'not a row',
    tab(5),
    tab(1),
  ] }))
  assert.deepEqual(list.read(), { ok: true, tabs: [tab(5), tab(1)] })

  // At most 64 rows.
  const many = Array.from({ length: 70 }, (_, index) => ({
    ...tab(1), id: `standalone-${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`, name: `Agent ${index}` }))
  values.set(list.key, JSON.stringify({ v: 1, tabs: many.slice(0, 64) }))
  assert.equal(list.read().tabs.length, 64)
  assert.equal(list.remember(many[64]), false, 'a 65th tab is refused rather than written')
  values.set(list.key, JSON.stringify({ v: 1, tabs: many }))
  assert.equal(list.read().tabs.length, 64, 'a longer saved list is read as its first 64 rows')

  const refused = createStandaloneTabLedger({ storage: memory({ refuseWrites: true }).storage, computerId: 'this-computer' })
  assert.equal(refused.remember(tab(1)), false, 'durable storage throws on a refused write; the list answers false')
  assert.equal(refused.forget(solo(1)), true, 'forgetting a tab the list never held changes nothing')
})

test('a damaged list reads as damaged, never as an empty one', () => {
  for (const bytes of ['{"v":1,"tabs":', '{"v":2,"tabs":[]}', '{"v":1}', '[]', 'null']) {
    const { storage, values } = memory()
    const list = createStandaloneTabLedger({ storage, computerId: 'this-computer' })
    values.set(list.key, bytes)
    const read = list.read()
    assert.equal(read.ok, false, bytes)
    assert.equal(read.code, 'STANDALONE_TABS_UNREADABLE', bytes)
    assert.equal(list.ids(), null, `${bytes}: an unreadable list holds nothing it can name`)
  }
})

test('the sweep reads every computer\'s list, fails closed on damage, and falls back when storage cannot list its keys', () => {
  const { storage, values } = memory()
  const here = createStandaloneTabLedger({ storage, computerId: 'this-computer' })
  const there = createStandaloneTabLedger({ storage, computerId: 'other-computer' })
  here.remember(tab(1))
  there.remember(tab(2))
  values.set('mc.theme', 'black')
  assert.deepEqual([...standaloneTabIdsEverywhere(storage, here)].sort(), [solo(1), solo(2)])

  values.set(there.key, '{"v":1,"tabs":')
  assert.equal(standaloneTabIdsEverywhere(storage, here), null, 'one damaged list means the open tabs cannot be read')

  const plain = memory({ enumerable: false })
  const only = createStandaloneTabLedger({ storage: plain.storage, computerId: 'this-computer' })
  only.remember(tab(3))
  plain.values.set(STANDALONE_TABS_PREFIX + 'other-computer', JSON.stringify({ v: 1, tabs: [tab(4)] }))
  assert.deepEqual([...standaloneTabIdsEverywhere(plain.storage, only)], [solo(3)],
    'storage with no key() still answers this computer\'s own list')
  plain.values.set(only.key, 'damaged')
  assert.equal(standaloneTabIdsEverywhere(plain.storage, only), null)
})
