import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const { createHeapGuard, MAX_LOG_BYTES } = createRequire(import.meta.url)('../../shell/heap-guard.cjs')

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-erase-'))
  const file = path.join(directory, 'main-heap.log')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const callbacks = [], cancelled = [], writes = [], prunes = []
  let share = 0.86
  const guard = createHeapGuard({
    memoryUsage: () => ({ heapUsed: share * 1000, rss: 2000 }),
    heapStatistics: () => ({ heap_size_limit: 1000 }),
    caches: () => [{ name: 'recomputable', size: 4, prune: () => { prunes.push('recomputable'); return 4 } }],
    write: line => { writes.push(line); fs.appendFileSync(file, line) },
    logBytes: () => { try { return fs.statSync(file).size } catch { return 0 } },
    resetLog: () => fs.writeFileSync(file, ''),
    setTimer: callback => {
      const timer = { unref() {} }
      callbacks.push({ callback, timer })
      return timer
    },
    clearTimer: timer => cancelled.push(timer),
    ...overrides,
  })
  return { directory, file, guard, callbacks, cancelled, writes, prunes, setShare: value => { share = value } }
}

test('sealing an unopened heap guard creates no log and invokes no diagnostic reader or writer', t => {
  const untouched = () => assert.fail('sealing must not invoke diagnostic IO or callbacks')
  const f = fixture(t, { memoryUsage: untouched, heapStatistics: untouched, caches: untouched,
    write: untouched, logBytes: untouched, resetLog: untouched, setTimer: untouched, clearTimer: untouched })
  assert.deepEqual(f.guard.sealForErase(), { ok: true, sealed: true })
  assert.deepEqual(f.guard.sealForErase(), { ok: true, sealed: true })
  assert.equal(f.guard.start(), false)
  assert.equal(f.guard.stop(), false)
  assert.deepEqual(f.guard.check(), { level: 'sealed', share: null, pruned: 0 })
  assert.deepEqual(fs.readdirSync(f.directory), [])
})

test('ordinary heap monitor stop and restart remain usable before terminal erase', t => {
  const f = fixture(t)
  assert.equal(f.guard.start(), true)
  assert.equal(f.guard.stop(), true)
  assert.equal(f.guard.stop(), false)
  assert.equal(f.guard.start(), true)
  f.callbacks[1].callback()
  assert.match(fs.readFileSync(f.file, 'utf8'), /main-heap warn/)
  assert.equal(f.cancelled.length, 1)
  assert.equal(f.callbacks.length, 2)
  assert.equal(f.guard.stop(), true)
})

for (const next of ['warn', 'prune', 'recovered']) test(`terminal erase blocks a retained ${next} callback, direct check and late restart`, t => {
  const f = fixture(t)
  assert.equal(f.guard.start(), true)
  const retained = f.callbacks[0].callback
  retained()
  assert.match(fs.readFileSync(f.file, 'utf8'), /main-heap warn/)
  assert.deepEqual(f.guard.sealForErase(), { ok: true, sealed: true })
  assert.equal(f.cancelled.length, 1)
  fs.unlinkSync(f.file) // The product's real sweep removes this existing log.
  const writes = f.writes.length, prunes = f.prunes.length
  f.setShare(next === 'prune' ? 0.95 : next === 'recovered' ? 0.4 : 0.86)
  retained() // Deliberately deliver a callback already retained by a scheduler.
  assert.deepEqual(f.guard.check(), { level: 'sealed', share: null, pruned: 0 })
  assert.equal(f.guard.start(), false)
  assert.deepEqual(f.guard.sealForErase(), { ok: true, sealed: true })
  assert.equal(f.callbacks.length, 1)
  assert.equal(f.cancelled.length, 1)
  assert.equal(f.writes.length, writes)
  assert.equal(f.prunes.length, prunes)
  assert.equal(fs.existsSync(f.file), false, 'A post-erase diagnostic must never recreate its log')
})

test('sealing during log-size inspection prevents both queued rotation and append', t => {
  let f
  f = fixture(t, {
    logBytes() { f.guard.sealForErase(); return MAX_LOG_BYTES + 1 },
    resetLog() { assert.fail('rotation must not run after erase seal') },
  })
  assert.deepEqual(f.guard.check(), { level: 'sealed', share: null, pruned: 0 })
  assert.equal(f.writes.length, 0)
  assert.equal(fs.existsSync(f.file), false)
})

test('sealing during a prune prevents later prune callbacks and recovery or prune logging', t => {
  const pruned = []
  let f
  f = fixture(t, { caches: () => [
    { name: 'first', size: 1, prune() {
      pruned.push('first')
      f.guard.sealForErase()
      fs.unlinkSync(f.file)
      return 1
    } },
    { name: 'second', size: 1, prune() { pruned.push('second'); return 1 } },
  ] })
  f.setShare(0.95)
  assert.deepEqual(f.guard.check(), { level: 'sealed', share: null, pruned: 1 })
  assert.deepEqual(pruned, ['first'])
  assert.equal(f.writes.length, 1, 'Only the pressure line before the seal may be written')
  assert.equal(fs.existsSync(f.file), false)
  f.setShare(0.4)
  f.guard.check()
  assert.equal(fs.existsSync(f.file), false)
})

test('failed timer cancellation retains cleanup ownership while terminal sealing already blocks writes', t => {
  let fail = true
  const cancelled = []
  const f = fixture(t, { clearTimer(timer) {
    cancelled.push(timer)
    if (fail) throw new Error('fixture timer cancellation failed')
  } })
  f.guard.start()
  assert.throws(() => f.guard.sealForErase(), /timer cancellation failed/)
  f.callbacks[0].callback()
  assert.equal(f.guard.start(), false)
  assert.equal(f.writes.length, 0)
  assert.equal(fs.existsSync(f.file), false)
  fail = false
  assert.deepEqual(f.guard.sealForErase(), { ok: true, sealed: true })
  assert.equal(cancelled.length, 2)
  assert.equal(cancelled[0], cancelled[1], 'The failed cancellation must retain its exact timer handle')
})
