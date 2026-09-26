import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createMainLagMonitor } = require(process.env.MAIN_LAG_MODULE || '../../shell/main-lag.cjs')

function harness(t, initial = { user: 1000000, system: 1000000 }, supported = true) {
  let wall = 10000
  let processCpu = 0
  let reading = initial
  let fire
  const rows = []
  const monitor = createMainLagMonitor({
    file: 'unused-memory-sink',
    appendSink(line) { rows.push(JSON.parse(line)); return { written: true } },
    now: () => wall,
    monotonic: () => wall,
    intervalMs: 250,
    thresholdMs: 500,
    cpuUsage: () => ({ user: processCpu, system: 0 }),
    threadCpuUsage: supported ? () => {
      if (reading instanceof Error) throw reading
      return reading
    } : null,
    setTimer(callback) { fire = callback; return { unref() {} } },
    clearTimer() { fire = undefined },
  })
  t.after(() => monitor.stop())
  assert.equal(monitor.start(), true)
  return {
    rows,
    tick(next, elapsed = 1000) {
      reading = next
      wall += elapsed
      processCpu += 900000
      fire()
      return rows.at(-1)
    },
  }
}

function unknown(row) {
  assert.equal(Object.hasOwn(row, 'threadCpuMs'), false, 'an unmeasured delta must be omitted')
  assert.equal(row.mainThread, 'unknown')
  assert.equal(row.lagMs, 750)
  assert.equal(row.cpuMs, 900, 'process CPU remains a separate current-interval measurement')
}

test('consecutive thread readings measure user plus system deltas and preserve zero', t => {
  const h = harness(t)
  const a = h.tick({ user: 1000400, system: 1100100 })
  assert.equal(a.threadCpuMs, 101)
  assert.equal(a.mainThread, 'waited')
  const b = h.tick({ user: 1000400, system: 1100100 })
  assert.equal(b.threadCpuMs, 0)
  assert.equal(b.mainThread, 'waited')
  const c = h.tick({ user: 1500400, system: 1100100 })
  assert.equal(c.threadCpuMs, 500)
  assert.equal(c.mainThread, 'worked')
  assert.equal(c.cpuMs, 900)
})

for (const [name, reading] of [
  ['missing', null],
  ['throwing', new Error('thread sample unavailable')],
  ['NaN user', { user: NaN, system: 1000000 }],
  ['infinite system', { user: 1000000, system: Infinity }],
  ['negative user', { user: -1, system: 1000000 }],
  ['negative system', { user: 1000000, system: -1 }],
  ['string user', { user: '1000000', system: 1000000 }],
  ['missing system', { user: 1000000 }],
]) {
  test(`${name} reading breaks continuity until two valid samples are available`, t => {
    const h = harness(t)
    unknown(h.tick(reading))
    unknown(h.tick({ user: 1800000, system: 1000000 }))
    const resumed = h.tick({ user: 1900000, system: 1000000 })
    assert.equal(resumed.threadCpuMs, 100, 'recovered delta must cover only the latest interval')
    assert.equal(resumed.mainThread, 'waited')
    assert.equal(h.rows.length, 3, 'sampling failures do not discard lag records')
  })
}

for (const [name, reading, next] of [
  ['user', { user: 900000, system: 1500000 }, { user: 1000000, system: 1500000 }],
  ['system', { user: 1500000, system: 900000 }, { user: 1500000, system: 1000000 }],
]) {
  test(`a regressed ${name} counter is unknown even when the combined delta is positive`, t => {
    const h = harness(t)
    unknown(h.tick(reading))
    assert.equal(h.tick(next).threadCpuMs, 100, 'a later valid pair uses the reset baseline')
  })
}

test('an unavailable sample on an unrecorded tick still breaks continuity', t => {
  const h = harness(t)
  h.tick(null, 250)
  assert.equal(h.rows.length, 0, 'an on-time tick does not emit a stall')
  unknown(h.tick({ user: 1800000, system: 1000000 }))
  assert.equal(h.tick({ user: 1900000, system: 1000000 }).threadCpuMs, 100)
})

test('initially unavailable sampling can recover without inventing its first delta', t => {
  const h = harness(t, null)
  unknown(h.tick({ user: 1000000, system: 1000000 }))
  assert.equal(h.tick({ user: 1100000, system: 1000000 }).threadCpuMs, 100)
})

test('unsupported runtimes retain lag and process CPU with unknown thread CPU', t => {
  const h = harness(t, null, false)
  unknown(h.tick(null))
  unknown(h.tick(null))
})
