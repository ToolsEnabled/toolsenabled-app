import test from 'node:test'
import assert from 'node:assert/strict'
import { createCommsFeed } from '../../src/comms-feed.js'
const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => Promise.withResolvers()
const message = (sequence, extra = {}) => ({ id: `m${sequence}`, sequence, sender: 'Manager', recipient: 'Builder', text: `Report ${sequence}`, at: `2026-09-08T00:00:${String(sequence % 60).padStart(2, '0')}Z`, ...extra })
const page = (messages, nextCursor, headSequence = nextCursor, extra = {}) => ({ ok: true, messages, history: { nextCursor, headSequence, floorSequence: 1 }, ...extra })
function fixture(source = async () => 'local') {
  const timers = new Map(), reads = [], paints = []
  let id = 0
  const feed = createCommsFeed({ resolveSource: source,
    readMessages(options) { const d = deferred(); reads.push({ ...d, options }); return d.promise },
    sample: () => ({ messages: { value: [message(9)] }, channels: { value: [] } }),
    paint: snapshot => paints.push(snapshot), now: () => 1700,
    setTimer(fn, ms) { timers.set(++id, { fn, ms }); return id }, clearTimer: id => timers.delete(id),
  })
  return { feed, reads, paints, timers, last: () => paints.at(-1),
    async fire(ms) { const entry = [...timers].find(([, task]) => task.ms === ms); assert.ok(entry, `no ${ms}ms timer`); timers.delete(entry[0]); entry[1].fn(); await flush() } }
}
test('slow reads share one flight, then preserve the incremental cursor', async t => {
  const f = fixture(); t.after(() => f.feed.destroy()); void f.feed.start(); await flush()
  for (let i = 0; i < 10; i++) void f.feed.refresh()
  await flush(); assert.equal(f.reads.length, 1)
  assert.deepEqual(f.reads[0].options, { limit: 200 })
  f.reads[0].resolve(page([message(1)], 1)); await flush()
  await f.fire(4000); assert.deepEqual(f.reads[1].options, { limit: 200, cursor: 1 })
})
test('a timeout retains visible history, releases the poll, and ignores the abandoned result', async t => {
  const f = fixture(); t.after(() => f.feed.destroy()); void f.feed.start(); await flush()
  f.reads[0].resolve(page([message(1)], 1)); await flush(); await f.fire(4000)
  await f.fire(12000)
  assert.equal(f.last().phase, 'stale'); assert.deepEqual(f.last().messages.map(m => m.id), ['m1'])
  await f.fire(4000); assert.equal(f.reads.length, 3)
  f.reads[2].resolve(page([message(2)], 2)); await flush()
  f.reads[1].resolve(page([message(99)], 99)); await flush()
  assert.deepEqual(f.last().messages.map(m => m.id), ['m1', 'm2']); assert.equal(f.last().phase, 'ready')
})
test('switching source clears old data immediately and ignores both old reads and stale source resolutions', async t => {
  const resolutions = []; const f = fixture(() => { const d = deferred(); resolutions.push(d); return d.promise })
  t.after(() => f.feed.destroy()); void f.feed.start(); await flush()
  resolutions[0].resolve('local'); await flush(); f.reads[0].resolve(page([message(1)], 1)); await flush()
  await f.fire(4000); void f.feed.start({ reask: true }); await flush()
  assert.deepEqual(f.last().messages, []); assert.equal(f.last().phase, 'loading')
  void f.feed.start({ reask: true }); await flush(); resolutions[2].resolve('mock'); await flush()
  resolutions[1].resolve('relay'); f.reads[1].resolve(page([message(2)], 2)); await flush()
  assert.equal(f.last().example, true); assert.deepEqual(f.last().messages.map(m => m.id), ['m9']); assert.equal(f.timers.size, 0)
})
test('unresolved identity and destroyed views cannot issue reads or repaint', async () => {
  const source = deferred(); const f = fixture(() => source.promise)
  void f.feed.start(); void f.feed.refresh(); await flush(); assert.equal(f.reads.length, 0)
  f.feed.destroy(); const count = f.paints.length; source.resolve('local'); await flush()
  assert.equal(f.paints.length, count); assert.equal(f.reads.length, 0); assert.equal(f.timers.size, 0)
})
test('retained bursts drain every page in order with no duplicates', async t => {
  const f = fixture(); t.after(() => f.feed.destroy()); void f.feed.start(); await flush()
  const first = Array.from({ length: 200 }, (_, i) => message(i + 1))
  f.reads[0].resolve(page(first, 200, 450)); await flush(); assert.equal(f.last().catchingUp, true)
  await f.fire(0); assert.equal(f.reads[1].options.cursor, 200)
  f.reads[1].resolve(page(Array.from({ length: 200 }, (_, i) => message(i + 201)), 400, 450)); await flush()
  await f.fire(0); f.reads[2].resolve(page([message(400), ...Array.from({ length: 50 }, (_, i) => message(i + 401))], 450)); await flush()
  assert.equal(f.last().messages.length, 450)
  assert.deepEqual(f.last().messages.map(m => m.sequence), Array.from({ length: 450 }, (_, i) => i + 1))
  assert.equal(f.last().catchingUp, false)
})
test('a refused or malformed page does not advance the cursor or erase messages', async t => {
  const f = fixture(); t.after(() => f.feed.destroy()); void f.feed.start(); await flush()
  f.reads[0].resolve(page([message(1)], 1)); await flush()
  for (const answer of [{ ok: false, reason: 'temporary read failure' }, page([{ id: 'bad' }], 100), page([], 8, 4)]) {
    void f.feed.refresh(); await flush(); f.reads.at(-1).resolve(answer); await flush()
    assert.equal(f.last().phase, 'stale'); assert.deepEqual(f.last().messages.map(m => m.id), ['m1'])
  }
  void f.feed.refresh(); await flush(); assert.equal(f.reads.at(-1).options.cursor, 1)
})
test('a reset journal restarts at its current tail instead of polling beyond the new head', async t => {
  const f = fixture(); t.after(() => f.feed.destroy()); void f.feed.start(); await flush()
  f.reads[0].resolve(page([message(100)], 100)); await flush(); await f.fire(4000)
  f.reads[1].resolve(page([], 100, 2)); await flush(); await f.fire(4000)
  assert.deepEqual(f.reads[2].options, { limit: 200 })
  f.reads[2].resolve(page([message(2)], 2)); await flush(); assert.deepEqual(f.last().messages.map(m => m.id), ['m2'])
})
test('an unconfirmed message is reconciled without holding newer traffic behind it', async t => {
  const f = fixture(); t.after(() => f.feed.destroy()); void f.feed.start(); await flush()
  f.reads[0].resolve(page([message(1, { deliveryState: 'unconfirmed' })], 1)); await flush(); await f.fire(4000)
  assert.equal(f.reads[1].options.cursor, 1)
  f.reads[1].resolve(page([message(2)], 2)); await flush()
  assert.deepEqual(f.reads[2].options, { cursor: 0, limit: 1 })
  f.reads[2].resolve(page([message(1, { deliveryState: 'available' })], 1, 2)); await flush()
  assert.deepEqual(f.last().messages.map(m => m.id), ['m1', 'm2']); assert.equal(f.last().messages[0].deliveryState, 'available')
  await f.fire(4000); assert.equal(f.reads[3].options.cursor, 2)
})
test('a source-resolution deadline is visible and retries resolution, without guessing the source', async t => {
  const f = fixture(() => new Promise(() => {})); t.after(() => f.feed.destroy())
  void f.feed.start(); await flush(); await f.fire(12000)
  assert.equal(f.last().phase, 'unavailable'); assert.equal(f.reads.length, 0)
  await f.fire(4000); assert.equal(f.last().phase, 'loading'); assert.equal(f.reads.length, 0)
})

test('loading earlier history fills the preceding interval without rewinding live updates', async t => {
  const f = fixture(); t.after(() => f.feed.destroy()); void f.feed.start(); await flush()
  f.reads[0].resolve(page(Array.from({ length: 200 }, (_, i) => message(i + 301)), 500)); await flush()
  assert.equal(f.last().hasEarlier, true)
  void f.feed.loadEarlier(); await flush()
  assert.deepEqual(f.reads[1].options, { limit: 200, cursor: 100 })
  f.reads[1].resolve(page(Array.from({ length: 200 }, (_, i) => message(i + 101)), 300, 500)); await flush()
  assert.equal(f.last().prepending, true); assert.equal(f.last().messages.length, 400)
  await f.fire(4000); assert.equal(f.reads[2].options.cursor, 500)
  f.reads[2].resolve(page([message(501)], 501)); await flush()
  assert.equal(f.last().prepending, false)
  void f.feed.loadEarlier(); await flush()
  assert.equal(f.reads[3].options.cursor, 0)
  f.reads[3].resolve(page(Array.from({ length: 100 }, (_, i) => message(i + 1)), 100, 501)); await flush()
  assert.equal(f.last().hasEarlier, false)
  assert.deepEqual(f.last().messages.map(m => m.sequence), Array.from({ length: 501 }, (_, i) => i + 1))
})

test('byte-limited older pages finish the interval before moving the older-history boundary', async t => {
  const f = fixture(); t.after(() => f.feed.destroy()); void f.feed.start(); await flush()
  f.reads[0].resolve(page([message(301)], 301)); await flush()
  void f.feed.loadEarlier(); await flush()
  assert.equal(f.reads[1].options.cursor, 100)
  f.reads[1].resolve(page(Array.from({ length: 50 }, (_, i) => message(i + 101)), 150, 301)); await flush()
  assert.deepEqual(f.reads[2].options, { limit: 150, cursor: 150 })
  void f.feed.refresh(); await flush(); assert.equal(f.reads.length, 3, 'manual refresh shares the older read')
  f.reads[2].resolve(page(Array.from({ length: 150 }, (_, i) => message(i + 151)), 300, 301)); await flush()
  assert.deepEqual(f.last().messages.map(m => m.sequence), Array.from({ length: 201 }, (_, i) => i + 101))
  await f.fire(4000); assert.equal(f.reads[3].options.cursor, 301)
})

test('a stuck cursor reports the problem without a hot catch-up loop', async t => {
  const f = fixture(); t.after(() => f.feed.destroy()); void f.feed.start(); await flush()
  f.reads[0].resolve(page([message(1)], 1)); await flush(); await f.fire(4000)
  f.reads[1].resolve(page([], 1, 20)); await flush()
  assert.equal(f.last().phase, 'stale')
  assert.equal([...f.timers.values()].some(timer => timer.ms === 0), false)
  await f.fire(4000); assert.equal(f.reads[2].options.cursor, 1)
})
