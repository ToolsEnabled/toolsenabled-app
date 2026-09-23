/* AN ASYNC IPC LISTENER'S TIME, AND WHICH HALF OF IT IS A STALL.
 *
 * MEASURED 2026-09-06 on gen-ff2285a5: a 4,050 ms main-thread stall was
 * attributed 56 ms -- 1.4 % -- and three others carried `blockers {}` empty.
 * instrument() wraps a listener as try/finally around listener.apply, so an
 * async listener's span closes when it returns its PROMISE. Everything after
 * its first `await` was outside the span.
 *
 * The repair is NOT "close the span when the promise settles". Settle time is
 * wall clock: a handler patiently awaiting a worker reply would then be
 * reported as a multi-second stall while the loop was free, and every patient
 * handler would become a fake blocker. So this suite pins the DIVISION:
 *
 *   blocker / blockerMs   still only the longest span that HELD the thread
 *   blockers[await:CH]    how long the channel was outstanding, wall clock
 *
 * Both assertions call the real monitor with real values and read the real
 * record it writes. Neither names the wrapper or any internal function, so a
 * different implementation of the same division still passes.
 *
 *   node --test tools/test/main-lag-async-span.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createMainLagMonitor } = require('../../shell/main-lag.cjs')

const burn = ms => { const until = Date.now() + ms; while (Date.now() < until) { /* hold the thread */ } }
const idle = ms => new Promise(resolve => setTimeout(resolve, ms))

/* The smallest thing that behaves like ipcMain for registration purposes:
   instrument() only needs the five registration methods to exist. */
function fakeIpcMain() {
  const listeners = new Map()
  const register = (channel, listener) => { listeners.set(channel, listener) }
  return {
    handle: register, handleOnce: register, on: register, once: register, addListener: register,
    invoke: (channel, ...args) => listeners.get(channel)(...args),
    registered: () => [...listeners.keys()],
  }
}

function monitorInTemp(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-mainlag-'))
  const file = path.join(dir, 'main-lag.log')
  const monitor = createMainLagMonitor({ file, intervalMs: 10, thresholdMs: 20, ...options })
  return { monitor, file, dir }
}

const recordsIn = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])

test('an async listener has its outstanding time recorded, and it never becomes the blocker', async () => {
  const { monitor, file } = monitorInTemp()
  const ipc = fakeIpcMain()
  assert.equal(monitor.instrument(ipc), true)

  /* The shape of the real defect: a small prologue that IS timed today, an
     await during which the loop is free, and a continuation that holds the
     thread and was invisible. The record is only written when the sampler sees
     a stall, so the continuation is what makes the await entry observable --
     which is exactly the case anyone would be reading the record about. */
  const SYNC_MS = 60
  const AWAIT_MS = 250
  const CONTINUATION_MS = 120
  ipc.handle('slow-channel', async () => {
    burn(SYNC_MS)            // this DID hold the thread
    await idle(AWAIT_MS)     // this did NOT
    burn(CONTINUATION_MS)    // this DID, and was outside the old span
    return 'done'
  })

  monitor.start()
  assert.equal(await ipc.invoke('slow-channel'), 'done', 'the listener result must pass through untouched')
  await idle(80)             // let the settle handler and a sampler tick run
  monitor.stop()

  const rows = recordsIn(file)
  assert.ok(rows.length > 0, 'the synchronous burn should have crossed the threshold and written a record')

  const awaited = rows.map(r => r.blockers?.['await:slow-channel']).filter(Boolean)
  assert.ok(awaited.length > 0, 'the channel\'s outstanding time must be recorded under its await name')
  assert.ok(awaited.some(entry => entry.maxMs >= AWAIT_MS),
    `the recorded outstanding time must cover the settle, saw ${JSON.stringify(awaited)}`)

  /* The division. Awaited time is wall clock and must never be reported as
     time the loop was held, or a patient handler becomes a fake stall. */
  for (const row of rows) {
    assert.notEqual(row.blocker, 'await:slow-channel', 'awaited time must never be named as the blocker')
    assert.ok(row.blockerMs < AWAIT_MS,
      `blockerMs must stay synchronous time, saw ${row.blockerMs} against an await of ${AWAIT_MS}`)
  }
})

test('a rejecting async listener is timed too, and its rejection reaches the caller unchanged', async () => {
  const { monitor, file } = monitorInTemp()
  const ipc = fakeIpcMain()
  monitor.instrument(ipc)

  const boom = new Error('listener refused')
  ipc.handle('failing-channel', async () => { burn(60); await idle(120); burn(120); throw boom })

  monitor.start()
  await assert.rejects(() => ipc.invoke('failing-channel'), error => error === boom,
    'the listener\'s own rejection must reach the caller, neither swallowed nor replaced')
  await idle(80)
  monitor.stop()

  const awaited = recordsIn(file).map(r => r.blockers?.['await:failing-channel']).filter(Boolean)
  assert.ok(awaited.length > 0, 'a rejection must be timed exactly like a resolution')
})

test('a synchronous listener is unaffected: no await entry, and its own span still counts', async () => {
  const { monitor, file } = monitorInTemp()
  const ipc = fakeIpcMain()
  monitor.instrument(ipc)
  ipc.handle('sync-channel', () => { burn(60); return 42 })

  monitor.start()
  assert.equal(ipc.invoke('sync-channel'), 42)
  await idle(80)
  monitor.stop()

  const rows = recordsIn(file)
  assert.ok(rows.length > 0)
  for (const row of rows) {
    assert.equal(row.blockers?.['await:sync-channel'], undefined,
      'a listener that returns no promise must not gain an await entry')
  }
  assert.ok(rows.some(row => row.blockers?.['sync-channel']), 'its synchronous span is still recorded')
})
