import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
const require = createRequire(import.meta.url)
const { createMainLagMonitor } = require('../../shell/main-lag.cjs')

// Fake time and an in-memory sink; real monitor instrumentation and IPC callbacks.
// No native process, profile, filesystem fixture or deleting teardown.
function fixture({ refuse = () => false } = {}) {
  let at = Date.parse('2026-09-23T12:00:00.000Z'), tick
  const rows = [], handlers = new Map()
  const monitor = createMainLagMonitor({ file: '/inert/main-lag.log',
    observeIpcWindows: true, now: () => at, monotonic: () => at,
    cpuUsage: () => ({ user: 0, system: 0 }), threadCpuUsage: null,
    setTimer: fn => { tick = fn; return { unref() {} } }, clearTimer() {},
    appendSink: text => { const row = JSON.parse(text); if (refuse(row)) return { written: false }; rows.push(row); return { written: true } },
  })
  const ipc = { on: (channel, callback) => handlers.set(channel, callback) }
  monitor.instrument(ipc)
  ipc.on('mc-settings:tree-slots', event => { event.returnValue = { ok: true } })
  ipc.on('mc-settings:read', () => {})
  monitor.start()
  return { rows, monitor,
    read() { const event = {}; handlers.get('mc-settings:tree-slots')(event); return event.returnValue },
    other() { handlers.get('mc-settings:read')({}) },
    time(ms, fire = false) { at = Date.parse('2026-09-23T12:00:00.000Z') + ms; if (fire) tick() },
    tick() { tick() },
    windows: () => rows.filter(row => row.event === 'ipc-count-window'),
  }
}
test('T837 continuous windows count every tree-slots IPC and retain quiet zero windows', () => {
  const f = fixture()
  for (let i = 0; i < 40; i++) { f.time(i * 250); if (i === 1 || i === 4 || i === 19) f.read(); f.other(); f.tick() }
  f.time(10000, true)
  assert.deepEqual(f.windows().map(row => row.count), [3, 0])
  assert.deepEqual(f.windows().map(row => row.windowIndex), [0, 1])
  assert.deepEqual(f.windows().map(row => row.cumulativeCount), [3, 3])
  assert.ok(f.windows().every(row => row.windowMs === 5000 && row.partial === false))
  assert.equal(f.rows.some(row => Object.hasOwn(row, 'lagMs')), false, 'quiet time does not become invented lag observations')
  assert.deepEqual(f.rows.map(row => row.sequence), [1, 2, 3])
  f.monitor.stop()
})
test('T837 a delayed timer assigns boundary calls to their actual five-second windows', () => {
  const f = fixture()
  f.time(4999); f.read()
  f.time(5000); f.read()
  f.time(10001); f.read()
  f.time(15000, true)
  assert.deepEqual(f.windows().map(row => row.count), [1, 1, 1])
  assert.deepEqual(f.windows().map(row => Date.parse(row.windowEnd) - Date.parse(row.windowStart)), [5000, 5000, 5000])
  assert.equal(f.rows.filter(row => row.lagMs >= 1000).length, 1)
  f.monitor.stop()
})
test('T837 route lifecycle uses the lag sink envelope and refuses unbounded renderer fields', () => {
  const f = fixture()
  assert.equal(typeof f.monitor.pageLifecycle, 'function', 'the real monitor must accept the trusted route marker')
  assert.equal(f.monitor.pageLifecycle({ route: 'computers', phase: 'mount', mountId: 1 }, { senderId: 7 }), true)
  assert.equal(f.monitor.pageLifecycle({ route: 'computers', phase: 'unmount', mountId: 1 }, { senderId: 7 }), true)
  for (const request of [
    { route: 'computers/private-owner', phase: 'mount', mountId: 2 },
    { route: 'computers', phase: 'mount', mountId: 2, text: 'must never enter logs' },
    { route: 'computers', phase: 'mount', mountId: -1 },
    { route: 'home', phase: 'tick', mountId: 2 },
  ]) assert.equal(f.monitor.pageLifecycle(request, { senderId: 7 }), false)
  const markers = f.rows.filter(row => row.event === 'page-lifecycle')
  assert.equal(markers.length, 2)
  assert.deepEqual(markers.map(({ route, phase, mountId }) => ({ route, phase, mountId })),
    [{ route: 'computers', phase: 'mount', mountId: 1 }, { route: 'computers', phase: 'unmount', mountId: 1 }])
  for (const row of markers) {
    assert.equal(row.diagnosticsVersion, 1); assert.equal(row.pid, process.pid)
    assert.equal(row.monitorId, f.rows[0].monitorId); assert.equal(row.senderId, 7)
    assert.ok(Number.isFinite(Date.parse(row.at))); assert.equal(row.writeFailures, 0)
    assert.equal(Object.hasOwn(row, 'lagMs'), false)
  }
  f.monitor.stop()
})
test('T837 a refused sink write leaves an explicit sequence gap and failure count', () => {
  const f = fixture({ refuse: row => row.event === 'ipc-count-window' && row.windowIndex === 0 })
  f.read(); f.time(5000, true); f.time(10000, true)
  const saved = f.windows()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].windowIndex, 1)
  assert.equal(saved[0].writeFailures, 1)
  assert.ok(saved[0].sequence > 2, 'missing append cannot look like continuous evidence')
  f.monitor.stop()
})
test('T837 stop records a partial tail and privacy seal admits no later diagnostic writes', () => {
  const f = fixture()
  f.read(); f.time(1100)
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const registration = main.split('\n').find(line => line.includes("prependOnceListener('exit'") && line.includes('mainLagMonitor.stop()'))
  assert.ok(registration, 'normal process exit must close the observation before the existing sink disposer')
  const processEvents = new EventEmitter()
  let closedBeforeDispose = false
  processEvents.once('exit', () => { closedBeforeDispose = f.rows.at(-1)?.event === 'diagnostic-observation-stop' })
  Function('process', 'mainLagMonitor', registration)(processEvents, f.monitor)
  processEvents.emit('exit')
  assert.equal(closedBeforeDispose, true)
  const tail = f.windows().at(-1)
  assert.equal(tail?.partial, true); assert.equal(tail.count, 1)
  assert.equal(Date.parse(tail.windowEnd) - Date.parse(tail.windowStart), 1100)
  assert.equal(f.rows.at(-1).event, 'diagnostic-observation-stop')
  f.monitor.start()
  f.monitor.sealForErase()
  const before = JSON.stringify(f.rows)
  f.read(); f.time(10000, true)
  f.monitor.pageLifecycle?.({ route: 'computers', phase: 'mount', mountId: 3 }, { senderId: 7 })
  assert.equal(JSON.stringify(f.rows), before)

  // A call and exit may share the exact boundary millisecond. Its terminal
  // bucket has no duration, but the call must remain in the cumulative total.
  const boundary = fixture()
  boundary.time(5000); boundary.read(); boundary.monitor.stop()
  assert.deepEqual(boundary.windows().map(row => [row.count, row.partial]), [[0, false], [1, true]])
  const terminal = boundary.windows().at(-1)
  assert.equal(terminal.windowStart, terminal.windowEnd)
  assert.equal(terminal.cumulativeCount, 1)
})
test('T837 clock regressions and long suspended intervals cannot claim uninterrupted coverage', () => {
  const f = fixture()
  f.read(); f.time(1000, true); f.time(500, true)
  assert.ok(f.rows.some(row => row.event === 'diagnostic-observation-gap' && row.reason === 'clock-regressed'))
  f.time(24 * 60 * 60 * 1000, true)
  assert.ok(f.rows.some(row => row.event === 'diagnostic-observation-gap' && row.reason === 'clock-gap'))
  assert.ok(f.windows().length < 130, 'resuming after suspension cannot synchronously write thousands of empty rows')
  f.monitor.stop()
})
