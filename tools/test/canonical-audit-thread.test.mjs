/* THE LEDGER'S OWN THREAD, DRIVEN FOR REAL.
 *
 * Nothing here is a mock of the mechanism: every case below starts a real
 * worker_threads Worker running the real shell/canonical-audit-worker.cjs
 * against a real payload directory this file writes to a temporary folder. What
 * is fake is only the thing that was too expensive to keep on the main thread:
 * the payload's own vault work. The stand-in blocks its thread with
 * Atomics.wait for a stated number of milliseconds, which is exactly what
 * execFileSync('powershell.exe', ...) does to whatever thread runs it -- and
 * which is why the measured window freeze was fifteen seconds long.
 *
 * The case that matters most is the first one: while a record is inside a
 * 500 ms synchronous vault, a timer on the main thread must keep firing. That
 * is the whole claim of the change, stated as something that can go red.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { nightlySkipReason, nightlySuitesEnabled } from '../lib/test-suite-result.mjs'

const require_ = createRequire(import.meta.url)
const { createCanonicalAuditQueue } = require_('../../shell/canonical-audit-queue.cjs')
const canonical = require_('../../shell/canonical-audit.cjs')
const AUDIT_MODULE = canonical.AUDIT_MODULE
const WORKER_FILE = path.resolve('shell', 'canonical-audit-worker.cjs')

/* A payload whose ledger writer behaves like the real one in the only two ways
 * this seam can observe -- it answers a receipt, or it throws a coded refusal --
 * and which can be told to hold its thread for a stated time the way a
 * synchronous powershell.exe does. */
const PAYLOAD_SOURCE = `
'use strict'
function hold(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
let sequence = 0
let closes = 0
exports.verify = () => ({ valid: true })
exports.resetForTests = () => { closes += 1 }
exports.closeCount = () => closes
exports.requireRecord = (action, target, details = {}) => {
  hold(Number(details.holdMs) || 0)
  if (action === 'ledger.refuse') {
    throw Object.assign(new Error('the head anchor could not be advanced'), { code: 'AUDIT_HEAD_UNAVAILABLE' })
  }
  if (action === 'ledger.die') process.exit(7)
  sequence += 1
  return { sequence, eventHash: 'event-hash-' + sequence, ignored: 'not part of the shell contract' }
}
exports.findEvents = ({ action, target, limit }) => {
  if (action === 'ledger.slow-read') hold(500)
  if (action === 'ledger.wedged-read') hold(10000)
  if (action === 'ledger.refused-read') throw Object.assign(new Error('untrusted head'), { code: 'AUDIT_ANCHOR_STALE' })
  return [{ sequence, action, target, limit }]
}
`

function stagePayload() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'canonical-audit-thread-'))
  const payloadRoot = path.join(scratch, 'payload')
  mkdirSync(path.join(payloadRoot, 'src', 'lib'), { recursive: true })
  writeFileSync(path.join(payloadRoot, AUDIT_MODULE), PAYLOAD_SOURCE)
  return { scratch, payloadRoot, stateRoot: path.join(scratch, 'capability') }
}

function queueFor({ payloadRoot, stateRoot }, options = {}) {
  return createCanonicalAuditQueue({
    workerFile: WORKER_FILE,
    workerData: { stateRoot, payloadRoot, auditModule: AUDIT_MODULE },
    ...options,
  })
}

test('a protected-head read uses the worker and leaves the calling thread responsive', async t => {
  const staged = stagePayload()
  const options = { stateRoot: staged.stateRoot, root: staged.payloadRoot }
  let ticker
  try {
    assert.equal((await canonical.findCanonicalEvents({ action: 'ledger.warm-read', target: 'target', limit: 7 }, options)).ok, true)
    const gaps = []
    let previous = performance.now()
    ticker = setInterval(() => {
      const now = performance.now()
      gaps.push(now - previous)
      previous = now
    }, 10)
    const start = performance.now()
    const result = await canonical.findCanonicalEvents({ action: 'ledger.slow-read', target: 'target', limit: 7 }, options)
    const elapsedMs = performance.now() - start
    clearInterval(ticker)
    assert.deepEqual(result, { ok: true, events: [{ sequence: 0, action: 'ledger.slow-read', target: 'target', limit: 7 }] })
    assert.ok(elapsedMs >= 450, 'the fixture must actually block its worker for half a second')
    assert.ok(gaps.length >= 10, 'the calling thread must keep processing timers during the read')
    assert.ok(Math.max(...gaps) < 200, 'the synchronous reader must not run on the calling thread')
    t.diagnostic(JSON.stringify({ scope: 'real audit worker with a synthetic blocking reader', elapsedMs, timerTicks: gaps.length, maximumTimerGapMs: Math.max(...gaps) }))
  } finally {
    clearInterval(ticker)
    await canonical.closeCanonical()
    canonical.resetForTests()
    rmSync(staged.scratch, { recursive: true, force: true })
  }
})

test('reads stay ordered with writes and preserve the canonical reader refusal', async () => {
  const staged = stagePayload()
  const queue = queueFor(staged)
  try {
    const first = queue.record('ledger.one', 'target', { holdMs: 40 })
    const read = queue.findEvents({ action: 'ledger.read', target: 'target', limit: 3 })
    const next = queue.record('ledger.two', 'target')
    assert.deepEqual(await first, { ok: true, sequence: 1, eventHash: 'event-hash-1' })
    assert.deepEqual(await read, { ok: true, events: [{ sequence: 1, action: 'ledger.read', target: 'target', limit: 3 }] })
    assert.deepEqual(await next, { ok: true, sequence: 2, eventHash: 'event-hash-2' })
    assert.deepEqual(await queue.findEvents({ action: 'ledger.refused-read', target: 'target' }),
      { ok: false, code: 'AUDIT_ANCHOR_STALE', reason: 'The signed record could not be read.' })
  } finally {
    await queue.close()
    rmSync(staged.scratch, { recursive: true, force: true })
  }
})

test('a protected-head read that stops answering remains bounded', async () => {
  const staged = stagePayload()
  const queue = queueFor(staged, { timeoutMs: 200 })
  try {
    const start = performance.now()
    const result = await queue.findEvents({ action: 'ledger.wedged-read', target: 'target' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'AUDIT_UNAVAILABLE')
    assert.ok(performance.now() - start < 5000)
  } finally {
    await queue.close()
    rmSync(staged.scratch, { recursive: true, force: true })
  }
})

/* NIGHTLY, NOT SILENT, AND NOT WEAKENED.
 *
 * The case below is the one the header calls "the case that matters most", and
 * its subject is real scheduler behaviour, so it cannot be given an injected
 * clock without deleting what it measures. It already refuses to rule on a
 * reading it could not take -- `gaps.length >= 20` -- and that is the right
 * design. What it cannot do is tell a release gate the difference between "the
 * main thread stalled" and "this machine was too busy to run a 10 ms timer".
 * MEASURED 2026-09-07 at app 4ba0ceac, whole-suite run with three other test
 * runs in progress: 12 ticks where 20 are needed, reported as a failure.
 *
 * So the assertions are untouched and it runs in full under
 * TOOLSENABLED_NIGHTLY=1; the release run counts it as unexecuted coverage BY
 * NAME. See RELEASE_SKIP_REGISTER in tools/lib/test-suite-result.mjs. */
test('a record that blocks its thread for half a second does not stop the main thread', {
  skip: nightlySuitesEnabled() ? false : nightlySkipReason('canonical-audit-thread-main-thread-stall'),
}, async () => {
  const staged = stagePayload()
  const queue = queueFor(staged)
  try {
    /* Warm the thread first, so the module load is not what this measures. */
    assert.equal((await queue.record('ledger.warm', 'target', {})).ok, true)

    const gaps = []
    let last = process.hrtime.bigint()
    const ticker = setInterval(() => {
      const now = process.hrtime.bigint()
      gaps.push(Number(now - last) / 1e6)
      last = now
    }, 10)
    const startedAt = process.hrtime.bigint()
    const recorded = await queue.record('ledger.slow', 'target', { holdMs: 500 })
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    clearInterval(ticker)

    assert.equal(recorded.ok, true, 'the slow record did not succeed')
    assert.ok(elapsedMs >= 450, `the stand-in vault did not actually hold its thread (${elapsedMs.toFixed(1)} ms)`)
    assert.ok(gaps.length >= 20, `the main thread's timer did not fire often enough to prove anything (${gaps.length} ticks)`)
    const worst = Math.max(...gaps)
    assert.ok(worst < 50, `the main thread stalled for ${worst.toFixed(1)} ms while the ledger thread was in its vault`)
  } finally {
    await queue.close()
    rmSync(staged.scratch, { recursive: true, force: true })
  }
})

test('the thread answers in exactly the shape the in-process path answered in', async () => {
  const staged = stagePayload()
  const queue = queueFor(staged)
  try {
    const onThread = await queue.record('account.create', 'account-7', { surface: 'app.ipc' })
    const here = canonical.recordCanonicalHere('account.create', 'account-7', { surface: 'app.ipc' }, {
      stateRoot: staged.stateRoot,
      root: staged.payloadRoot,
    })
    assert.deepEqual(onThread, { ok: true, sequence: 1, eventHash: 'event-hash-1' },
      'the thread did not answer the receipt the shell contract names')
    assert.deepEqual(onThread, here, 'the thread and the in-process path answered different things for the same record')

    const refusedOnThread = await queue.record('ledger.refuse', 'session-9', {})
    const refusedHere = canonical.recordCanonicalHere('ledger.refuse', 'session-9', {}, {
      stateRoot: staged.stateRoot,
      root: staged.payloadRoot,
    })
    assert.deepEqual(refusedOnThread, refusedHere,
      'a refusal must carry the writer’s own code and the same sentence on either side of the boundary')
    assert.equal(refusedOnThread.ok, false)
    assert.equal(refusedOnThread.code, 'AUDIT_HEAD_UNAVAILABLE',
      'the writer’s own refusal code was replaced by a generic one')
  } finally {
    await queue.close()
    canonical.resetForTests()
    rmSync(staged.scratch, { recursive: true, force: true })
  }
})

test('a thread that dies refuses the record instead of leaving the caller waiting', async () => {
  const staged = stagePayload()
  const queue = queueFor(staged, { timeoutMs: 5_000 })
  try {
    const died = await queue.record('ledger.die', 'target', {})
    assert.equal(died.ok, false, 'a record whose thread exited mid-write reported success')
    assert.equal(died.code, 'AUDIT_UNAVAILABLE', `a dead thread answered ${died.code} instead of AUDIT_UNAVAILABLE`)
    assert.ok(typeof died.reason === 'string' && died.reason.length > 0, 'a dead thread refused without saying anything')

    /* And the lane is usable again: the next record starts a fresh thread
       rather than inheriting the dead one. */
    const after = await queue.record('ledger.after', 'target', {})
    assert.equal(after.ok, true, 'the lane did not recover after its thread died')
    assert.ok(queue.inspect().workerStarts >= 2, 'a fresh thread was not started for the record after the death')
  } finally {
    await queue.close()
    rmSync(staged.scratch, { recursive: true, force: true })
  }
})

test('a thread that stops answering is torn down and the record is refused, never left hanging', async () => {
  const staged = stagePayload()
  const queue = queueFor(staged, { timeoutMs: 150 })
  try {
    const startedAt = process.hrtime.bigint()
    const wedged = await queue.record('ledger.wedge', 'target', { holdMs: 10_000 })
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    assert.equal(wedged.ok, false, 'a record that never came back reported success')
    assert.equal(wedged.code, 'AUDIT_UNAVAILABLE')
    assert.ok(elapsedMs < 5_000, `the caller waited ${elapsedMs.toFixed(0)} ms on a bounded record`)
  } finally {
    await queue.close()
    rmSync(staged.scratch, { recursive: true, force: true })
  }
})

test('closing finishes the records already asked for before it stops the thread', async () => {
  const staged = stagePayload()
  const queue = queueFor(staged)
  try {
    const pending = [
      queue.record('ledger.one', 'target', { holdMs: 60 }),
      queue.record('ledger.two', 'target', { holdMs: 60 }),
      queue.record('ledger.three', 'target', { holdMs: 60 }),
    ]
    assert.equal(queue.inspect().queued + (queue.inspect().inFlight ? 1 : 0), 3, 'the three records were not all accepted')
    const closed = await queue.close()
    const results = await Promise.all(pending)
    assert.deepEqual(results.map(row => row.ok), [true, true, true],
      'closing dropped a record that had already been accepted')
    assert.deepEqual(results.map(row => row.sequence), [1, 2, 3],
      'the records were not appended in the order they were asked for')
    assert.deepEqual(closed, { ok: true, closed: true },
      'the close did not report that the ledger handle was released')
  } finally {
    rmSync(staged.scratch, { recursive: true, force: true })
  }
})

test('a close drain timeout refuses pending work and waits for the real worker to exit', async () => {
  const staged = stagePayload()
  const { Worker } = require_('node:worker_threads')
  let observed = null
  class ObservedWorker extends Worker {
    constructor(...args) {
      super(...args)
      observed = this
    }
  }
  const queue = queueFor(staged, { WorkerClass: ObservedWorker, timeoutMs: 20_000, flushMs: 50 })
  try {
    assert.equal((await queue.record('ledger.warm', 'target')).ok, true)
    const pending = queue.record('ledger.blocked', 'target', { holdMs: 10_000 })
    const closed = await queue.close()
    assert.equal(closed.ok, false)
    assert.equal(closed.code, 'AUDIT_CLOSE_FAILED')
    assert.equal((await pending).ok, false)
    // removeAllListeners in disposal intentionally detaches observers; Node's
    // actual worker identity proves termination has completed, not requested.
    assert.equal(observed.threadId, -1)
    assert.equal(queue.inspect().inFlight, false)
    assert.equal(queue.inspect().queued, 0)
    assert.equal((await queue.record('ledger.late', 'target')).ok, false)
  } finally {
    await queue.close()
    rmSync(staged.scratch, { recursive: true, force: true })
  }
})

test('a record that can be refused without opening anything never starts a thread', async () => {
  /* The two cheap refusals stay on the calling thread on purpose: an invalid
     state root is a statement about the CALLER, and a copy with no capability
     payload has no ledger at all. Starting a thread to say either would put a
     thread start on every keystroke of a copy that has no ledger. */
  const relative = await canonical.recordCanonical('settings.set', 'id', {}, { stateRoot: 'relative/capability' })
  assert.equal(relative.ok, false)
  assert.equal(relative.code, 'AUDIT_STATE_ROOT_INVALID')

  const absent = await canonical.recordCanonical('settings.set', 'id', {}, {
    stateRoot: path.resolve('test-state', 'capability'),
    root: null,
  })
  assert.equal(absent.ok, false)
  assert.equal(absent.code, 'AUDIT_PAYLOAD_ABSENT')
  canonical.resetForTests()
})

test('a thread whose entry file the loader cannot resolve is started from its source instead', async () => {
  /* THE ARCHIVE CASE, and why it is worth a test rather than an argument. This
     shell ships inside app.asar, and a worker's entry is resolved by a module
     loader running on a thread this process did not bootstrap. Rather than
     reason about whether that loader sees the archive, the lane falls back to
     reading the entry with fs -- which unambiguously does see it -- and starting
     the worker from that source. Here the loader is given a path that is not on
     the disk while the reader is given the real file: the same shape, forced. */
  const staged = stagePayload()
  const source = require_('node:fs').readFileSync(WORKER_FILE, 'utf8')
  const queue = createCanonicalAuditQueue({
    workerFile: path.join(staged.scratch, 'not-on-this-disk.cjs'),
    workerData: { stateRoot: staged.stateRoot, payloadRoot: staged.payloadRoot, auditModule: AUDIT_MODULE },
    readFileSync: () => source,
  })
  try {
    const recorded = await queue.record('ledger.archive', 'target', {})
    assert.deepEqual(recorded, { ok: true, sequence: 1, eventHash: 'event-hash-1' },
      'the record did not survive an entry file the loader could not resolve')
    assert.equal(queue.inspect().usedSourceFallback, true, 'the source fallback was not the route that answered')
  } finally {
    await queue.close()
    rmSync(staged.scratch, { recursive: true, force: true })
  }
})
