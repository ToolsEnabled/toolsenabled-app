import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const source = fs.readFileSync(new URL('../../shell/renderer-prefs.cjs', import.meta.url), 'utf8')
const key = 'mc.fleet.trees.v1:synthetic-computer'
function fixture(code, onFleetStorageStatus) {
  const timers = new Set()
  const saved = []
  let attempts = 0, full = true
  const missing = () => Object.assign(new Error('Absent inert fixture'), { code: 'ENOENT' })
  const inert = {
    readFileSync() { throw missing() }, existsSync: () => false, readdirSync: () => [],
    mkdirSync() {}, openSync: () => 1, writeFileSync() {}, fsyncSync() {}, closeSync() {},
    renameSync() {}, unlinkSync() {},
    promises: {
      mkdir: async () => {}, rename: async () => {}, unlink: async () => {},
      open: async () => ({ writeFile: async text => {
        attempts++
        if (full) throw Object.assign(new Error('Synthetic write failure'), { code })
        saved.push(JSON.parse(text))
      }, close: async () => {}, sync: async () => {} }),
    },
  }
  const context = { module: { exports: {} }, require, Buffer, process, Date,
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer },
    clearTimeout(timer) { timers.delete(timer) },
  }
  vm.runInNewContext(source, context)
  const prefs = context.module.exports.createRendererPrefs({
    directory: path.join(os.tmpdir(), 'inert-fleet-store'), fs: inert, path, randomUUID: () => 'synthetic-id', onFleetStorageStatus,
  })
  return { prefs, saved, attempts: () => attempts, timerCount: () => timers.size, recover: () => { full = false },
    async tick() {
      const pending = [...timers]; timers.clear()
      for (const timer of pending) timer.fn()
      for (let step = 0; step < 30; step++) await Promise.resolve()
    },
  }
}
for (const code of ['ENOSPC', 'EIO']) test(code + ' retains dirty fleet state and stops retries of the unchanged revision', async t => {
  const f = fixture(code)
  assert.equal(f.prefs.set(key, 'inert accepted tree document').ok, true)
  for (let cycle = 0; cycle < 3; cycle++) await f.tick()
  t.diagnostic(JSON.stringify({ code, attempts: f.attempts(), timers: f.timerCount() }))
  assert.equal(f.attempts(), 1)
  assert.equal(f.timerCount(), 0)
  assert.equal(f.prefs.snapshot().values[key], 'inert accepted tree document')
  assert.equal(f.prefs.snapshot().fleetPending, true)
  assert.equal(f.prefs.snapshot().fleetWriteError, code)
  assert.equal(f.prefs.set(key, 'inert accepted tree document').unchanged, true)
  await f.tick()
  assert.equal(f.attempts(), 1, 'repeating the same value is not a genuine change')
})
test('explicit retry saves the held fleet state and clears the retained error', async () => {
  const f = fixture('ENOSPC')
  f.prefs.set(key, 'accepted fleet state')
  await f.tick()
  f.recover()
  assert.equal((await f.prefs.flushFleetDocuments()).ok, true)
  assert.equal(f.saved.at(-1).values[key], 'accepted fleet state')
  assert.equal(f.prefs.snapshot().fleetPending, false)
  assert.equal(f.prefs.snapshot().fleetWriteError, null)
  f.prefs.set(key, 'later genuine change')
  await f.tick()
  assert.equal(f.saved.at(-1).values[key], 'later genuine change')
})
test('fleet refusal publishes once, stays retained through another failed change, and clears on saved retry', async () => {
  const statuses = []
  const f = fixture('ENOSPC', status => statuses.push(status))
  f.prefs.set(key, 'first accepted state')
  await f.tick()
  f.prefs.set(key, 'newer accepted state')
  await f.tick(); await f.tick()
  assert.equal(statuses.length, 1)
  assert.equal(statuses[0].state, 'refused')
  assert.equal(statuses[0].code, 'ENOSPC')
  assert.ok(Number.isFinite(statuses[0].at))
  assert.deepEqual(Object.keys(statuses[0]).sort(), ['at', 'code', 'state'])
  f.recover()
  await f.prefs.flushFleetDocuments()
  assert.equal(statuses.length, 2)
  assert.equal(statuses[1].state, 'saved')
  assert.equal(statuses[1].code, null)
  assert.equal(f.saved.at(-1).values[key], 'newer accepted state')
})
test('a notification callback cannot discard an otherwise retained failed fleet write', async () => {
  const f = fixture('EIO', () => { throw new Error('Inert notification failure') })
  f.prefs.set(key, 'held state')
  await f.tick(); await f.tick()
  assert.equal(f.attempts(), 1)
  assert.equal(f.prefs.snapshot().values[key], 'held state')
  assert.equal(f.prefs.snapshot().fleetWriteError, 'EIO')
})
test('a genuine new change retries once with the latest retained state', async () => {
  const f = fixture('EIO')
  f.prefs.set(key, 'first state')
  await f.tick()
  f.prefs.set(key, 'second state')
  await f.tick(); await f.tick()
  assert.equal(f.attempts(), 2)
  assert.equal(f.timerCount(), 0)
  assert.equal(f.prefs.snapshot().values[key], 'second state')
  f.recover()
  await f.prefs.flushFleetDocuments()
  assert.equal(f.saved.at(-1).values[key], 'second state')
})
