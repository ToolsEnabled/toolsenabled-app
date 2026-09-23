/* WHAT THE WINDOW COSTS WHILE NOBODY IS TOUCHING IT.
 *
 * A timer is the one kind of work that never appears in a profile of a click,
 * because nobody clicked. These tests pin the three answers that took the idle
 * cost of the home window from 124.33 wakes a minute to 2.08, measured
 * 2026-09-03 with tools/renderer-idle-poll-inventory.mjs over sixty virtual
 * minutes:
 *
 *   1. the process clock does not run when it has nothing to write,
 *   2. a poll whose answer has not changed asks less often,
 *   3. and no two of a view's polls wake in the same task.
 *
 * Every assertion here calls something with values. Nothing greps a source
 * file for a number, and nothing asserts a spelling: a rewrite that keeps the
 * behaviour must keep these green, and one that changes the behaviour must go
 * red however it is written.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RUNTIME_TICK_MS,
  bindRuntime,
  runtimeClockScheduled,
  runtimeRegistrySize,
  startRuntimeClock,
  stopRuntimeClock,
  tickRuntimes,
} from '../../src/runtime-clock.js'
import {
  APPROVALS_MAX_POLL_MS,
  APPROVALS_POLL_MS,
  APPROVALS_RETRY_MS,
  approvalsReadingChanged,
  nextApprovalsWaitMs,
  phasedPollNames,
  pollPhaseOffsetMs,
} from '../../src/idle-cadence.js'

/* ------------------------------------------------------------------
   A clock that never advances by itself, so a cadence is counted rather
   than waited for.
   ------------------------------------------------------------------ */

function fakeTimers() {
  let nowMs = 0
  let nextHandle = 1
  const live = new Map()
  return {
    schedule(fn, everyMs) {
      const handle = nextHandle
      nextHandle += 1
      live.set(handle, { fn, everyMs, dueAtMs: nowMs + everyMs })
      return handle
    },
    cancel(handle) { live.delete(handle) },
    /* Runs every due callback in time order up to the horizon and answers with
       how many times anything fired. */
    advance(byMs) {
      const horizon = nowMs + byMs
      let fires = 0
      for (;;) {
        let due = null
        for (const timer of live.values()) {
          if (timer.dueAtMs > horizon) continue
          if (!due || timer.dueAtMs < due.dueAtMs) due = timer
        }
        if (!due) break
        nowMs = due.dueAtMs
        due.dueAtMs = nowMs + due.everyMs
        fires += 1
        due.fn()
        if (fires > 100_000) throw new Error('the clock did not settle')
      }
      nowMs = horizon
      return fires
    },
    liveCount: () => live.size,
  }
}

class Readout {
  constructor({ connected = true } = {}) { this.isConnected = connected; this._text = ''; this.writes = 0 }
  get textContent() { return this._text }
  set textContent(value) { this._text = value; this.writes += 1 }
}

/* The module holds one process-wide registry and one process-wide clock, so
   every test here has to hand both back. */
function cleanSlate() {
  const unbinds = []
  return {
    bind(elm, bornAtFn = () => 0) { const off = bindRuntime(elm, bornAtFn); unbinds.push(off); return off },
    release() { for (const off of unbinds) off(); unbinds.length = 0; stopRuntimeClock() },
  }
}

/* ==================================================================
   1. THE PROCESS CLOCK
   ================================================================== */

test('a started clock with nothing to write schedules no wake at all', () => {
  const slate = cleanSlate()
  const timers = fakeTimers()
  try {
    assert.equal(runtimeRegistrySize(), 0, 'this test needs an empty registry to mean anything')
    startRuntimeClock({ schedule: timers.schedule, cancel: timers.cancel })
    assert.equal(runtimeClockScheduled(), false, 'bad value true means the window is being woken to write nothing')
    assert.equal(timers.advance(60 * 60_000), 0,
      'bad value 7200 is the old behaviour: two wakes a second for an hour, against an empty registry')
  } finally { slate.release() }
})

test('binding a readout starts the clock, and it ticks at the same cadence as before', () => {
  const slate = cleanSlate()
  const timers = fakeTimers()
  try {
    startRuntimeClock({ schedule: timers.schedule, cancel: timers.cancel, fmt: value => `up ${value}` })
    const elm = new Readout()
    slate.bind(elm, () => 42)
    assert.equal(runtimeClockScheduled(), true, 'a readout on screen must be clocked')
    const fires = timers.advance(60_000)
    assert.equal(fires, 60_000 / RUNTIME_TICK_MS,
      `one minute must still be ${60_000 / RUNTIME_TICK_MS} ticks; a changed cadence is a changed product`)
    assert.equal(elm.textContent, 'up 42', 'and the readout must carry the formatted value')
  } finally { slate.release() }
})

test('the LAST unbind stops the clock; earlier ones do not', () => {
  const slate = cleanSlate()
  const timers = fakeTimers()
  try {
    startRuntimeClock({ schedule: timers.schedule, cancel: timers.cancel })
    const offOne = slate.bind(new Readout())
    const offTwo = slate.bind(new Readout())
    offOne()
    assert.equal(runtimeClockScheduled(), true, 'one readout is still on screen, so the clock must still run')
    offTwo()
    assert.equal(runtimeClockScheduled(), false, 'bad value true means an empty registry is still being woken')
    assert.equal(timers.advance(10 * 60_000), 0, 'and nothing fires after the last readout goes')
  } finally { slate.release() }
})

test('a view torn down WITHOUT unbinding still stops the clock, on the tick that releases it', () => {
  /* The teardown path that actually happens: an element is removed from the
     document and the tick is what notices. Before this, that left the clock
     running for the life of the window. */
  const slate = cleanSlate()
  const timers = fakeTimers()
  try {
    startRuntimeClock({ schedule: timers.schedule, cancel: timers.cancel })
    const elm = new Readout()
    slate.bind(elm)
    assert.equal(runtimeClockScheduled(), true)
    elm.isConnected = false
    timers.advance(RUNTIME_TICK_MS)
    assert.equal(runtimeRegistrySize(), 0, 'the tick must release the disconnected readout')
    assert.equal(runtimeClockScheduled(), false, 'bad value true means a dead page keeps waking the window')
  } finally { slate.release() }
})

test('a readout bound after the clock went to sleep is clocked again', () => {
  const slate = cleanSlate()
  const timers = fakeTimers()
  try {
    startRuntimeClock({ schedule: timers.schedule, cancel: timers.cancel, fmt: value => `up ${value}` })
    const first = slate.bind(new Readout())
    first()
    assert.equal(runtimeClockScheduled(), false)
    const elm = new Readout()
    slate.bind(elm, () => 7)
    assert.equal(runtimeClockScheduled(), true, 'sleeping must not be one-way')
    timers.advance(RUNTIME_TICK_MS)
    assert.equal(elm.textContent, 'up 7', 'and the woken clock must actually write')
  } finally { slate.release() }
})

test('stopping the clock cancels its timer rather than leaking one', () => {
  const slate = cleanSlate()
  const timers = fakeTimers()
  try {
    startRuntimeClock({ schedule: timers.schedule, cancel: timers.cancel })
    slate.bind(new Readout())
    assert.equal(timers.liveCount(), 1)
    stopRuntimeClock()
    assert.equal(timers.liveCount(), 0, 'bad value 1 means a stopped clock is still scheduled')
  } finally { slate.release() }
})

test('starting twice replaces the first clock instead of running two', () => {
  const slate = cleanSlate()
  const timers = fakeTimers()
  try {
    startRuntimeClock({ schedule: timers.schedule, cancel: timers.cancel })
    slate.bind(new Readout())
    startRuntimeClock({ schedule: timers.schedule, cancel: timers.cancel })
    assert.equal(timers.liveCount(), 1, 'bad value 2 means every boot adds another clock')
    assert.equal(timers.advance(60_000), 60_000 / RUNTIME_TICK_MS, 'and the cadence must not double')
  } finally { slate.release() }
})

test('bindRuntime schedules nothing when no window has started the clock', () => {
  /* Which is what lets the registry tests in runtime-clock.test.mjs, and every
     other test that touches a runtime readout, run without a fake timer. */
  const slate = cleanSlate()
  const timers = fakeTimers()
  try {
    slate.bind(new Readout())
    assert.equal(runtimeClockScheduled(), false)
    assert.equal(timers.liveCount(), 0, 'bad value 1 means importing this module starts a timer')
  } finally { slate.release() }
})

/* ==================================================================
   2. THE BACK-OFF
   ================================================================== */

test('a queue that keeps giving the same answer is asked for less and less often', () => {
  let waitMs = APPROVALS_POLL_MS
  const walk = []
  for (let read = 0; read < 6; read += 1) {
    waitMs = nextApprovalsWaitMs({ readable: true, changed: false, waitMs })
    walk.push(waitMs)
  }
  assert.deepEqual(walk, [40_000, 80_000, 80_000, 80_000, 80_000, 80_000],
    'bad value [20000, 20000, ...] is the old flat poll: a still queue charged three requests a minute forever')
})

test('the back-off has a ceiling, so a still queue is never abandoned', () => {
  let waitMs = APPROVALS_POLL_MS
  for (let read = 0; read < 100; read += 1) waitMs = nextApprovalsWaitMs({ readable: true, changed: false, waitMs })
  assert.equal(waitMs, APPROVALS_MAX_POLL_MS,
    'an unbounded doubling would eventually stop asking altogether, which is not a back-off but a stop')
})

test('the first answer that differs snaps the wait straight back to the base', () => {
  let waitMs = APPROVALS_POLL_MS
  for (let read = 0; read < 5; read += 1) waitMs = nextApprovalsWaitMs({ readable: true, changed: false, waitMs })
  assert.equal(waitMs, APPROVALS_MAX_POLL_MS, 'the ladder must be at the top for this to prove anything')
  assert.equal(nextApprovalsWaitMs({ readable: true, changed: true, waitMs }), APPROVALS_POLL_MS,
    'bad value 80000 means a queue that just moved is still being asked once every eighty seconds')
})

test('an unreadable snapshot keeps its own slow retry and never enters the ladder', () => {
  assert.equal(nextApprovalsWaitMs({ readable: false, changed: false, waitMs: APPROVALS_POLL_MS }), APPROVALS_RETRY_MS)
  assert.equal(nextApprovalsWaitMs({ readable: false, changed: true, waitMs: APPROVALS_MAX_POLL_MS }), APPROVALS_RETRY_MS,
    'not knowing what is pending is not the same as knowing nothing has changed')
})

test('a wait carried in from the slow retry re-enters the ladder at the base', () => {
  assert.equal(nextApprovalsWaitMs({ readable: true, changed: false, waitMs: APPROVALS_RETRY_MS }), APPROVALS_POLL_MS,
    'bad value 240000 doubles the unreadable retry into four minutes on the first answer that finally parsed')
})

test('a reading that differs in any part the row renders counts as changed', () => {
  const base = { readable: true, count: 0, undelivered: 0 }
  assert.equal(approvalsReadingChanged(base, { ...base }), false, 'an identical reading is not a change')
  assert.equal(approvalsReadingChanged(base, { ...base, count: 1 }), true, 'a new request is a change')
  assert.equal(approvalsReadingChanged(base, { ...base, undelivered: 1 }), true, 'a decision that did not land is a change')
  assert.equal(approvalsReadingChanged(base, { ...base, readable: false }), true, 'losing the queue is a change')
  assert.equal(approvalsReadingChanged(null, base), true, 'the first reading of all is a change')
})

test('the whole ladder still costs fewer reads than the flat poll, and the same reads when the queue moves', () => {
  /* The measurement, in the small: ten minutes of a still queue against ten
     minutes of a moving one. */
  const reads = (moving) => {
    let elapsed = 0
    let waitMs = APPROVALS_POLL_MS
    let count = 0
    while (elapsed < 600_000) {
      waitMs = nextApprovalsWaitMs({ readable: true, changed: moving, waitMs })
      elapsed += waitMs
      if (elapsed <= 600_000) count += 1
    }
    return count
  }
  assert.equal(reads(true), 30, 'a moving queue must still be read three times a minute')
  assert.equal(reads(false), 8, 'bad value 30 means the still queue was never backed off')
})

/* ==================================================================
   3. THE PHASE
   ================================================================== */

test('the polls a view starts together are given different phases', () => {
  const offsets = phasedPollNames().map(pollPhaseOffsetMs)
  assert.equal(new Set(offsets).size, offsets.length,
    'two polls sharing an offset share every wake their periods line up on')
})

test('an offset is a one-off nudge, never a doubled period', () => {
  for (const name of phasedPollNames()) {
    const offset = pollPhaseOffsetMs(name)
    assert.ok(offset >= 0 && offset < APPROVALS_POLL_MS,
      `${name} offset ${offset}ms must be small enough that no first reading is meaningfully delayed`)
  }
})

test('an unnamed poll is not silently delayed by an invented number', () => {
  assert.equal(pollPhaseOffsetMs('nothing:known'), 0)
  assert.equal(pollPhaseOffsetMs(undefined), 0)
})

test('the health and sample polls, which share a period, never share a wake', () => {
  /* Both are 45s and both are started in one synchronous block, so without the
     offsets they would collide on EVERY tick rather than occasionally. */
  const PERIOD_MS = 45_000
  const HORIZON_MS = 6 * 60 * 60_000
  const fires = (name) => {
    const at = []
    for (let when = PERIOD_MS + pollPhaseOffsetMs(name); when <= HORIZON_MS; when += PERIOD_MS) at.push(when)
    return at
  }
  const health = new Set(fires('home:health'))
  const shared = fires('home:sample').filter(when => health.has(when))
  assert.deepEqual(shared, [], 'bad value: every wake shared, which is what two in-phase 45s timers do')
})

test('the approvals poll and the health poll never share a wake either, at any rung of the ladder', () => {
  const HORIZON_MS = 6 * 60 * 60_000
  const healthAt = new Set()
  for (let when = 45_000 + pollPhaseOffsetMs('home:health'); when <= HORIZON_MS; when += 45_000) healthAt.add(when)

  for (const rung of [APPROVALS_POLL_MS, 40_000, APPROVALS_MAX_POLL_MS]) {
    const shared = []
    for (let when = rung; when <= HORIZON_MS; when += rung) if (healthAt.has(when)) shared.push(when)
    assert.deepEqual(shared, [],
      `bad value [180000, ...] is the in-phase case: a ${rung}ms poll landing in the same task as the health read`)
  }
})
