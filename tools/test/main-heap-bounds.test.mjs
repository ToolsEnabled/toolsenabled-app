/* THE MAIN PROCESS'S MEMORY HAS TO HAVE A CEILING, AND HERE IS WHERE IT IS SAID.
 *
 * The owner's app died every ten to twenty minutes on 2026-09-03 with no dump,
 * no shutdown record, and fifteen seconds of 100% CPU first -- the signature of
 * a heap reaching its limit -- and nobody had ever measured the main process's
 * heap. Lane H measured it (2026-09-04, isolated instance, Electron 43.3.0):
 * the limit is 4192 MB and 9 sessions driven through 3,303 turns in twelve
 * minutes left heapUsed flat at 23-34 MB, so the per-turn structures are bound
 * already. What the static pass DID find was one structure in the main process
 * with no ceiling at all, and no instrument that would have said so.
 *
 * This file holds both:
 *   1. the tree-node command broker's duplicate-wake memory has a ceiling and
 *      obeys it (shell/tree-node-command-broker.cjs);
 *   2. the heap guard says the right thing at the right threshold and drops
 *      only what is safe to drop (shell/heap-guard.cjs).
 *
 * Run: node --test tools/test/main-heap-bounds.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  MAX_KNOWN_REQUEST_IDS,
  createTreeNodeCommandBroker,
} = require('../../shell/tree-node-command-broker.cjs')
const { createHeapGuard } = require('../../shell/heap-guard.cjs')

const flush = () => new Promise(resolve => setImmediate(resolve))
const id = suffix => `tnc-00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const envelope = requestId => ({
  request: { requestId, nodeId: 'node-1', action: 'fresh-start-existing-node' },
})

function idleBroker(overrides = {}) {
  /* The renderer is never made ready, so nothing is ever claimed or sent: the
     only thing exercised is what queueRequest() remembers. */
  return createTreeNodeCommandBroker({
    loadAndClaim: requestId => envelope(requestId),
    publishResult: async (held, result) => result,
    sendToRenderer: () => {},
    setTimer: () => null,
    clearTimer: () => {},
    wait: async () => {},
    ...overrides,
  })
}

test('the broker remembers every request id it has ever queued, and that memory is BOUNDED', async () => {
  const ceiling = 50
  const broker = idleBroker({ maxKnownRequestIds: ceiling })
  for (let n = 0; n < ceiling * 4; n += 1) broker.queueRequest(id(n))
  await flush()
  /* THE ASSERTION THAT WAS RED BEFORE THIS CHANGE. `known` was only ever added
     to -- never trimmed, and not even cleared by dispose() -- so this read
     answered 200 (every id ever seen) instead of the ceiling. */
  assert.equal(broker.state().known, ceiling,
    'the duplicate-wake memory must not grow past its ceiling')
  assert.equal(broker.state().queued, ceiling * 4,
    'trimming the memory must not touch work that is still outstanding')
})

test('the ceiling drops the OLDEST id, so a wake that arrives twice in its own lifetime is still refused', async () => {
  const broker = idleBroker({ maxKnownRequestIds: 3 })
  broker.queueRequest(id(1))
  broker.queueRequest(id(2))
  broker.queueRequest(id(3))
  broker.queueRequest(id(4))
  await flush()
  assert.equal(broker.state().known, 3)
  /* The three most recent are still refused a second time... */
  assert.equal(broker.queueRequest(id(4)), false)
  assert.equal(broker.queueRequest(id(3)), false)
  /* ...and the one that fell off the far end is the one settled long ago. */
  assert.equal(broker.queueRequest(id(1)), true)
})

test('the shipped ceiling is a real number and far above any burst', () => {
  assert.equal(Number.isSafeInteger(MAX_KNOWN_REQUEST_IDS), true)
  assert.equal(MAX_KNOWN_REQUEST_IDS >= 1000, true)
})

test('a broker refuses a ceiling that is not a positive integer', () => {
  assert.throws(() => idleBroker({ maxKnownRequestIds: 0 }), TypeError)
  assert.throws(() => idleBroker({ maxKnownRequestIds: 2.5 }), TypeError)
})

test('dispose() lets go of the memory as well as the queue', async () => {
  const broker = idleBroker()
  broker.queueRequest(id(7))
  await flush()
  assert.equal(broker.state().known, 1)
  broker.dispose()
  assert.equal(broker.state().known, 0)
})

/* ---------------------------------------------------------------- */

function guardOn(shares, { caches = () => [], pruneAt = 0.92, warnAt = 0.85 } = {}) {
  const lines = []
  let at = 0
  const limit = 1000
  const guard = createHeapGuard({
    memoryUsage: () => ({ heapUsed: shares[Math.min(at, shares.length - 1)] * limit, rss: 2000 }),
    heapStatistics: () => ({ heap_size_limit: limit }),
    caches,
    write: line => lines.push(line),
    now: () => new Date('2026-09-04T05:00:00.000Z'),
    warnAt,
    pruneAt,
  })
  return { guard, lines, step: () => { const answer = guard.check(); at += 1; return answer } }
}

test('a healthy heap writes nothing at all', () => {
  const { lines, step } = guardOn([0.1, 0.5, 0.84])
  step(); step(); step()
  assert.deepEqual(lines, [], 'main-heap.log must be empty on a healthy run')
})

test('at 85% it names every cache and drops none of them', () => {
  let pruned = 0
  const { lines, step } = guardOn([0.86], {
    caches: () => [
      { name: 'agentSessions', size: 9 },
      { name: 'treeCommandKnown', size: 4321, prune: () => { pruned += 1; return 4321 } },
    ],
  })
  const answer = step()
  assert.equal(answer.level, 'warn')
  assert.equal(pruned, 0, 'nothing may be dropped at the warning line')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /warn heapUsed=/)
  assert.match(lines[0], /agentSessions=9/)
  assert.match(lines[0], /treeCommandKnown=4321/)
})

test('at 92% it prunes what is prunable, leaves the rest, and writes down what went', () => {
  const dropped = []
  const { lines, step } = guardOn([0.93], {
    caches: () => [
      { name: 'agentSessions', size: 9 },
      { name: 'treeCommandKnown', size: 4321, prune: () => { dropped.push('treeCommandKnown'); return 4321 } },
      { name: 'spawnLedgerCaches', size: 2, prune: () => { dropped.push('spawnLedgerCaches'); return 2 } },
    ],
  })
  const answer = step()
  assert.equal(answer.level, 'prune')
  assert.equal(answer.pruned, 4323)
  assert.deepEqual(dropped, ['treeCommandKnown', 'spawnLedgerCaches'])
  assert.match(lines[0], /^2026-09-04T05:00:00.000Z main-heap prune /)
  assert.equal(lines.filter(line => line.includes('pruned ')).length, 2)
  assert.equal(lines.some(line => line.includes('pruned agentSessions')), false,
    'a cache with no prune() must never be dropped')
})

test('it says when the heap came back down, once', () => {
  const { lines, step } = guardOn([0.93, 0.4, 0.4])
  step(); step(); step()
  const recovered = lines.filter(line => line.includes('recovered'))
  assert.equal(recovered.length, 1)
})

test('a cache whose size accessor throws is reported unreadable, not allowed to break the round', () => {
  const { lines, step } = guardOn([0.86], {
    caches: () => [
      { name: 'broken', size: () => { throw new Error('no') } },
      { name: 'fine', size: 3 },
    ],
  })
  step()
  assert.match(lines[0], /broken=\?/)
  assert.match(lines[0], /fine=3/)
})

test('a write that throws never escapes the guard', () => {
  const guard = createHeapGuard({
    memoryUsage: () => ({ heapUsed: 990, rss: 1 }),
    heapStatistics: () => ({ heap_size_limit: 1000 }),
    caches: () => [],
    write: () => { throw new Error('the disk is full') },
  })
  assert.doesNotThrow(() => guard.check())
})

test('an unreadable heap statistic answers unknown rather than guessing', () => {
  const guard = createHeapGuard({
    memoryUsage: () => ({ heapUsed: 10 }),
    heapStatistics: () => { throw new Error('no v8') },
    write: () => {},
  })
  assert.equal(guard.check().level, 'unknown')
})

test('the guard never holds the process open', () => {
  let unreffed = false
  const guard = createHeapGuard({
    memoryUsage: () => ({ heapUsed: 1 }),
    heapStatistics: () => ({ heap_size_limit: 1000 }),
    write: () => {},
    setTimer: () => ({ unref: () => { unreffed = true } }),
    clearTimer: () => {},
  })
  assert.equal(guard.start(), true)
  assert.equal(unreffed, true, "the guard's timer must be unref'd")
  assert.equal(guard.start(), false, 'starting twice must not arm a second timer')
  assert.equal(guard.stop(), true)
})

test('the thresholds are refused when they are not fractions in order', () => {
  const base = { memoryUsage: () => ({ heapUsed: 1 }), heapStatistics: () => ({ heap_size_limit: 2 }), write: () => {} }
  assert.throws(() => createHeapGuard({ ...base, warnAt: 0.95, pruneAt: 0.9 }), TypeError)
  assert.throws(() => createHeapGuard({ ...base, warnAt: 0 }), TypeError)
  assert.throws(() => createHeapGuard({ ...base, intervalMs: 0 }), TypeError)
})
