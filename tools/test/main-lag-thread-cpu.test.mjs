/* WHOSE CPU WAS THAT? THE PROCESS-WIDE READING CANNOT SAY, AND IT ALREADY MISLED US.
 *
 * `cpuMs` is `process.cpuUsage()`, which is PROCESS-wide. main-lag.cjs says so
 * itself: "A busy worker inflates it while the main thread sits idle. So a LOW
 * value is decisive ... and a HIGH value is only suggestive." The existing
 * discriminator suite (main-lag-cpu-discriminator.test.mjs) proves cpuMs splits
 * working from waiting -- but only in a process where nothing else runs, which
 * is the one case where process CPU and main-thread CPU are the same number.
 *
 * The product is not that process. shell/canonical-audit-queue.cjs runs a
 * hash-chain signer on a worker_threads worker inside this very process, and on
 * the live record for 2026-09-07 `cpuMs` EXCEEDS `lagMs` on 100 of 139 rows --
 * arithmetically impossible for one thread, so another thread was burning. Read
 * the wrong way round (high cpu => "the main thread is CPU-bound"), that reading
 * sent a ruling at work that would move code which is already off the thread.
 *
 * So the record must carry the CALLING thread's own CPU as well. These cases
 * assert the division behaviourally -- a worker burns while the main thread
 * parks, and the record must still report the main thread as having waited.
 * Nothing here names an internal function; any implementation reporting the same
 * division passes.
 *
 *   node --test tools/test/main-lag-thread-cpu.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createMainLagMonitor } = require('../../shell/main-lag.cjs')

const park = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
const burn = ms => { const until = Date.now() + ms; while (Date.now() < until) { /* hold this thread */ } }
const idle = ms => new Promise(resolve => setTimeout(resolve, ms))

function monitorInTemp(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-threadcpu-'))
  const file = path.join(dir, 'main-lag.log')
  return { monitor: createMainLagMonitor({ file, intervalMs: 10, thresholdMs: 20, ...options }), file }
}
const recordsIn = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])

/* A worker that burns CPU for `ms` and exits. This is the canonical-audit
   signer's shape, reduced to the only property that matters here: it consumes
   CPU in this process without touching the main thread. */
function burningWorker(ms) {
  return new Worker(
    `const until = Date.now() + ${ms}; while (Date.now() < until) {} `,
    { eval: true },
  )
}

test('a worker burning CPU while the MAIN thread waits is not reported as main-thread work', async () => {
  const { monitor, file } = monitorInTemp()
  const worker = burningWorker(500)
  monitor.start()
  /* The main thread does nothing but wait, exactly as it does on an fsync or a
     lock. The worker meanwhile burns, inflating the process-wide figure. */
  park(400)
  await idle(80)
  monitor.stop()
  await worker.terminate()

  const rows = recordsIn(file).filter(r => r.lagMs >= 250)
  assert.ok(rows.length > 0, 'a 400 ms park must cross the 20 ms threshold')
  const row = rows[0]

  assert.equal(typeof row.threadCpuMs, 'number',
    'a record must carry the calling thread\'s own cpu, not only the process total')
  assert.ok(row.threadCpuMs <= row.lagMs * 0.25,
    `the main thread waited, so its own cpu must be near zero: threadCpuMs ${row.threadCpuMs} against lagMs ${row.lagMs}`)
  assert.equal(row.mainThread, 'waited',
    `the row must say the main thread waited, saw ${row.mainThread} (threadCpuMs ${row.threadCpuMs}, cpuMs ${row.cpuMs}, lagMs ${row.lagMs})`)
})

test('a stall the MAIN thread really did burn is reported as worked', async () => {
  const { monitor, file } = monitorInTemp()
  monitor.start()
  burn(300)
  await idle(80)
  monitor.stop()

  const rows = recordsIn(file).filter(r => r.lagMs >= 200)
  assert.ok(rows.length > 0, 'a 300 ms burn must cross the threshold')
  const row = rows[0]
  assert.ok(row.threadCpuMs >= row.lagMs * 0.5,
    `a spinning main thread must show its own cpu near the lag: threadCpuMs ${row.threadCpuMs} against lagMs ${row.lagMs}`)
  assert.equal(row.mainThread, 'worked',
    `the row must say the main thread worked, saw ${row.mainThread} (threadCpuMs ${row.threadCpuMs}, lagMs ${row.lagMs})`)
})

/* THE WHOLE POINT, IN ONE COMPARISON. Same lag, and the process-wide figure is
   high in BOTH cases -- so process cpu cannot separate them and thread cpu must.
   This is the case the live log presented and the board answered wrongly. */
test('worker-burn and main-burn are indistinguishable by process cpu and separated by thread cpu', async () => {
  const parked = monitorInTemp()
  const worker = burningWorker(500)
  parked.monitor.start(); park(400); await idle(80); parked.monitor.stop()
  await worker.terminate()

  const spun = monitorInTemp()
  spun.monitor.start(); burn(400); await idle(80); spun.monitor.stop()

  const a = recordsIn(parked.file).filter(r => r.lagMs >= 250)[0]
  const b = recordsIn(spun.file).filter(r => r.lagMs >= 250)[0]
  assert.ok(a && b, 'both means must produce a recorded stall')

  assert.ok(b.threadCpuMs > a.threadCpuMs * 2,
    `thread cpu must separate them: worker-burn ${a.threadCpuMs}ms vs main-burn ${b.threadCpuMs}ms`)
  assert.notEqual(a.mainThread, b.mainThread,
    `the two rows must not carry the same verdict: both said ${a.mainThread}`)
})

test('thread cpu is a per-tick delta, not a running total', async () => {
  /* Driven with values through the same seam shape the suite already uses for
     cpuUsage: a reading that advances a fixed amount per call. However the tick
     is written, consecutive records must each report one interval. */
  let calls = 0
  const { monitor, file } = monitorInTemp({
    threadCpuUsage: () => { calls += 1; return { user: calls * 1000, system: 0 } },
  })
  monitor.start()
  burn(120); await idle(40); burn(120); await idle(60)
  monitor.stop()

  const rows = recordsIn(file)
  assert.ok(rows.length >= 2, 'two burns should produce at least two records')
  for (const row of rows) {
    assert.ok(row.threadCpuMs <= 5,
      `each record must carry ONE interval's delta, not a running total, saw ${row.threadCpuMs}`)
  }
})

/* FAIL CLOSED, AND SAY SO. A runtime without process.threadCpuUsage must not
   invent a number and must not crash the monitor: the row simply does not claim
   a verdict it cannot support. Bundled Electron 43.3.0 ships Node 24.18.1 and
   DOES expose it (measured 2026-09-07), so this is the defence for older
   payloads, not the expected path. */
test('a runtime without a thread-cpu reading still records the stall, and claims no verdict', async () => {
  const { monitor, file } = monitorInTemp({ threadCpuUsage: null })
  monitor.start()
  burn(300)
  await idle(80)
  monitor.stop()

  const rows = recordsIn(file).filter(r => r.lagMs >= 200)
  assert.ok(rows.length > 0, 'the stall must still be recorded without a thread-cpu reading')
  const row = rows[0]
  assert.equal(typeof row.lagMs, 'number', 'the rest of the record must be intact')
  assert.equal(row.mainThread, 'unknown',
    `without a reading the row must say unknown rather than guess, saw ${row.mainThread}`)
})
