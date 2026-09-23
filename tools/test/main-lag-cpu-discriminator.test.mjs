/* WAS THE THREAD WORKING, OR WAITING? THE RECORD MUST SAY.
 *
 * A stall means the loop came back late. It does not say why, and the two
 * reasons need opposite fixes: code that HELD the thread, or a thread that was
 * never SCHEDULED. Measured 2026-09-06 on this machine, both conditions were
 * live at once -- 8 logical processors, a run queue of 9, and a durable-write
 * path known to run inside the app's own main process. Argued from CPU figures
 * taken at some other moment, the question changes answer with the weather.
 *
 * These two cases produce the SAME lag by opposite means and assert that the
 * record tells them apart:
 *
 *   burn()  spins  -> the thread ran   -> cpuMs should track lagMs
 *   park()  waits  -> the thread idled -> cpuMs should stay near zero
 *
 * park() uses Atomics.wait, which blocks the calling thread without spinning.
 * That is the honest stand-in for "not scheduled" or "parked in a syscall":
 * wall clock passes, the loop is late, and no CPU is consumed. It is the third
 * state, and it is the one a heavy durable write actually implies.
 *
 * Nothing here names an internal function. A different implementation that
 * reports the same division still passes.
 *
 *   node --test tools/test/main-lag-cpu-discriminator.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createMainLagMonitor } = require('../../shell/main-lag.cjs')

const burn = ms => { const until = Date.now() + ms; while (Date.now() < until) { /* hold the thread, consuming CPU */ } }
const park = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
const idle = ms => new Promise(resolve => setTimeout(resolve, ms))

function monitorInTemp(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-cpu-'))
  const file = path.join(dir, 'main-lag.log')
  return { monitor: createMainLagMonitor({ file, intervalMs: 10, thresholdMs: 20, ...options }), file }
}
const recordsIn = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])

test('a stall spent EXECUTING reports cpu time close to the lag', async () => {
  const { monitor, file } = monitorInTemp()
  monitor.start()
  burn(300)
  await idle(60)
  monitor.stop()

  const rows = recordsIn(file).filter(r => r.lagMs >= 200)
  assert.ok(rows.length > 0, 'a 300 ms burn should have crossed the 20 ms threshold')
  const row = rows[0]
  assert.equal(typeof row.cpuMs, 'number', 'every record must carry cpuMs')
  assert.ok(row.cpuMs >= row.lagMs * 0.5,
    `a spinning stall must show cpu time near its lag, saw cpuMs ${row.cpuMs} against lagMs ${row.lagMs}`)
})

test('a stall spent WAITING reports almost no cpu time, though the lag is the same', async () => {
  const { monitor, file } = monitorInTemp()
  monitor.start()
  park(300)
  await idle(60)
  monitor.stop()

  const rows = recordsIn(file).filter(r => r.lagMs >= 200)
  assert.ok(rows.length > 0, 'a 300 ms park should stall the loop exactly as a burn does')
  const row = rows[0]
  assert.ok(row.cpuMs <= row.lagMs * 0.25,
    `a parked stall must NOT be reported as cpu work, saw cpuMs ${row.cpuMs} against lagMs ${row.lagMs}`)
})

/* The discriminator only earns its place if the two cases differ. Same lag,
   opposite cpu, in one comparison -- which is the whole reason the field
   exists and the thing a future edit must not quietly break. */
test('the same lag by opposite means produces opposite cpu readings', async () => {
  const worst = label => {
    const rows = recordsIn(label.file).filter(r => r.lagMs >= 200)
    return rows.length ? rows[0] : null
  }
  const spun = monitorInTemp(); spun.monitor.start(); burn(300); await idle(60); spun.monitor.stop()
  const idled = monitorInTemp(); idled.monitor.start(); park(300); await idle(60); idled.monitor.stop()

  const a = worst(spun)
  const b = worst(idled)
  assert.ok(a && b, 'both means must produce a recorded stall')
  assert.ok(a.cpuMs > b.cpuMs,
    `executing must report more cpu than waiting: spun ${a.cpuMs}ms vs parked ${b.cpuMs}ms at lags ${a.lagMs}/${b.lagMs}`)
})

test('cpuMs is taken every tick, so it covers the stall window and not the gap since the last stall', async () => {
  /* Driven with values: a fake clock-free reading that advances a fixed amount
     per call. Whatever the tick does, consecutive records must not accumulate
     the whole run -- each must report only its own interval. */
  let calls = 0
  const { monitor, file } = monitorInTemp({ cpuUsage: () => { calls += 1; return { user: calls * 1000, system: 0 } } })
  monitor.start()
  burn(120); await idle(40); burn(120); await idle(60)
  monitor.stop()

  const rows = recordsIn(file)
  assert.ok(rows.length >= 2, 'two burns should produce at least two records')
  for (const row of rows) {
    assert.ok(row.cpuMs <= 5,
      `each record must carry ONE interval's delta, not a running total, saw ${row.cpuMs}`)
  }
})
