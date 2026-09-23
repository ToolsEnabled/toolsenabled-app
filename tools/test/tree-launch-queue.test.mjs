import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createTreeLaunchQueue } from '../../src/tree-launch-queue.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done }), resolve: value => resolve(value) } }
const fast = { schedule: callback => setImmediate(callback), unschedule: clearImmediate }
const nodes = count => Array.from({ length: count }, (_, index) => ({ id: `node-${index}` }))

test('1,000 synthetic staged identities start exactly once with bounded concurrency, not a running-agent quota', async () => {
  const called = new Set()
  let active = 0
  let maxActive = 0
  const startAt = performance.now()
  const queue = createTreeLaunchQueue({ ...fast, nodes: nodes(1000), concurrency: 4, start: async node => {
    assert.equal(called.has(node.id), false); called.add(node.id)
    active++; maxActive = Math.max(maxActive, active)
    await tick(); active--
    return { ok: true, sessionId: `synthetic-${node.id}` }
  } })
  const report = await queue.done
  assert.equal(report.started, 1000); assert.equal(report.pending, 0); assert.equal(called.size, 1000)
  assert.equal(maxActive, 4)
  console.log(`Synthetic queue only: 1,000 starts in ${(performance.now() - startAt).toFixed(1)} ms; peak in-flight ${maxActive}. No provider process was launched.`)
})
test('all declared identities are prepared sequentially before any parallel fresh bind', async () => {
  const prepared = []
  let preparing = 0
  const queue = createTreeLaunchQueue({ ...fast, nodes: nodes(20), prepare: async node => {
    assert.equal(preparing++, 0); await tick(); preparing--; prepared.push(node.id); return { ok: true }
  }, start: async () => { assert.equal(prepared.length, 20); return { ok: true } } })
  assert.equal((await queue.done).started, 20)
})
test('pause stops pending starts and resume preserves identities without duplicating the active start', async () => {
  const first = deferred()
  let called = 0
  const queue = createTreeLaunchQueue({ ...fast, nodes: nodes(3), concurrency: 1, start: async () => { called++; if (called === 1) await first.promise; return { ok: true } } })
  await tick(); await tick(); queue.pause(); first.resolve()
  await tick(); await tick(); assert.equal(called, 1); assert.equal(queue.snapshot().pending, 2)
  queue.resume(); assert.equal((await queue.done).started, 3); assert.equal(called, 3)
})
test('cancel leaves pending drafts intact while the already active start returns its real receipt', async () => {
  const first = deferred()
  let called = 0
  const queue = createTreeLaunchQueue({ ...fast, nodes: nodes(5), concurrency: 1, start: async () => { called++; await first.promise; return { ok: true, sessionId: 'real-receipt' } } })
  await tick(); await tick(); queue.cancel(); first.resolve()
  const report = await queue.done
  assert.equal(called, 1); assert.equal(report.started, 1); assert.equal(report.cancelled, true)
  assert.deepEqual(report.remainingIds, ['node-1', 'node-2', 'node-3', 'node-4'])
})
test('a proved pre-spawn resource hold waits, but a start with a session or uncertain error is never replayed', async () => {
  let clock = 1000
  const scheduled = []
  const counts = new Map()
  const queue = createTreeLaunchQueue({ nodes: nodes(3), concurrency: 1, now: () => clock,
    schedule(fn, delay) { scheduled.push({ fn, at: clock + delay }); return fn }, unschedule() {},
    start: async node => {
      const count = (counts.get(node.id) || 0) + 1; counts.set(node.id, count)
      if (node.id === 'node-0' && count === 1) return { ok: false, retryable: true, code: 'AGENT_RESOURCE_PRESSURE', retryAfterMs: 1000, message: 'Waiting for CPU.' }
      if (node.id === 'node-1') return { ok: false, retryable: true, code: 'AGENT_RESOURCE_PRESSURE', sessionId: 'already-started' }
      if (node.id === 'node-2') throw new Error('transport outcome unknown')
      return { ok: true }
    } })
  for (let iterations = 0; !queue.snapshot().finished && iterations < 30; iterations++) {
    const job = scheduled.shift(); if (job) { clock = job.at; job.fn() }
    await tick()
  }
  const report = await queue.done
  assert.equal(clock, 2000); assert.equal(report.started, 1); assert.equal(report.refused, 2)
  assert.deepEqual([...counts.values()], [2, 1, 1])
})
test('disposal before a scheduled batch begins starts nothing and retains all queued identities', async () => {
  const queue = createTreeLaunchQueue({ ...fast, nodes: nodes(1000), start() { assert.fail('cancelled queue started a session') } })
  queue.cancel()
  assert.equal((await queue.done).remainingIds.length, 1000)
})
test('a node that is no longer startable finishes without an endless automatic retry', async () => {
  let calls = 0
  const queue = createTreeLaunchQueue({ ...fast, nodes: nodes(1), start() { calls++; return { ok: false, notStarted: true } } })
  const report = await queue.done
  assert.equal(calls, 1); assert.equal(report.refused, 1); assert.equal(report.pending, 0)
})

test('node-scoped queue state distinguishes active, waiting, unrelated and completed agents', async () => {
  const first = deferred()
  const queue = createTreeLaunchQueue({ ...fast, nodes: nodes(3), concurrency: 1, start: async node => {
    if (node.id === 'node-0') return first.promise
    return { ok: true }
  } })
  assert.equal(queue.nodeState('node-0').phase, 'queued')
  assert.equal(queue.nodeState('not-in-this-batch'), null)
  await tick(); await tick()
  assert.equal(queue.nodeState('node-0').phase, 'admitting')
  assert.equal(queue.nodeState('node-1').phase, 'queued')
  queue.pause()
  assert.equal(queue.nodeState('node-0').phase, 'admitting', 'pause does not stop an already requested start')
  assert.equal(queue.nodeState('node-1').phase, 'paused')
  first.resolve({ ok: true, sessionId: 'real-receipt' })
  await tick(); await tick()
  assert.equal(queue.nodeState('node-0'), null, 'completed nodes must not inherit the remaining queue’s hold')
  queue.cancel()
  await queue.done
  assert.equal(queue.nodeState('node-1').phase, 'cancelled')
})

/* T395. MEASURED 2026-09-14T09Z in the owner's signed spawn record: one node
   refused AGENT_RESOURCE_PRESSURE 558 times in one hour, 1.46 s apart. A
   persistent hold must reach a cap, wait longer each time on the way there,
   and leave the queue with a result that names what it waited for. Driven
   with values through the real queue; no sentence is pinned. */
import { MAX_RESOURCE_HOLD_ATTEMPTS, LAUNCH_ABANDONED_CODE, HOLD_BACKOFF_BASE_MS, HOLD_BACKOFF_MAX_MS, resourceHoldKind } from '../../src/tree-launch-queue.js'
function drivenHold({ code = 'AGENT_MEMORY_LOW', retryAfterMs = 1000, measured = null, message = 'The available physical memory does not cover another agent.', maxIterations = 200 } = {}) {
  let clock = 1000
  const scheduled = []
  const startsAt = []
  const queue = createTreeLaunchQueue({ nodes: nodes(1), concurrency: 1, now: () => clock,
    schedule(fn, delay) { scheduled.push({ fn, at: clock + delay }); return fn }, unschedule() {},
    start: async () => { startsAt.push(clock); return { ok: false, retryable: true, code, retryAfterMs, message, ...(measured ? { measured } : {}) } } })
  return (async () => {
    for (let iterations = 0; !queue.snapshot().finished && iterations < maxIterations; iterations++) {
      const job = scheduled.shift(); if (job) { clock = job.at; job.fn() }
      await tick()
    }
    return { queue, startsAt, finished: queue.snapshot().finished, report: queue.snapshot().finished ? await queue.done : null }
  })()
}
test('a persistent resource hold is retried a named number of times with a growing wait, then abandoned with a readable outcome', async () => {
  const { queue, startsAt, finished, report } = await drivenHold()
  assert.equal(finished, true, 'the queue must end on its own under a hold that never lifts')
  assert.equal(startsAt.length, MAX_RESOURCE_HOLD_ATTEMPTS, 'exactly N starts, no more')
  const gaps = startsAt.slice(1).map((at, index) => at - startsAt[index])
  for (let index = 1; index < gaps.length; index++) assert.ok(gaps[index] >= gaps[index - 1], `wait ${index} (${gaps[index]} ms) must not be shorter than wait ${index - 1} (${gaps[index - 1]} ms)`)
  assert.ok(gaps.at(-1) > gaps[0], 'the wait must actually grow, not repeat the monitor’s one second')
  assert.ok(gaps[0] >= HOLD_BACKOFF_BASE_MS && gaps.at(-1) <= HOLD_BACKOFF_MAX_MS)
  assert.equal(report.started, 0); assert.equal(report.refused, 1); assert.equal(report.pending, 0); assert.equal(report.abandoned, 1)
  const [result] = report.results
  assert.equal(result.ok, false); assert.equal(result.abandoned, true)
  assert.equal(result.code, LAUNCH_ABANDONED_CODE); assert.equal(result.holdCode, 'AGENT_MEMORY_LOW')
  assert.equal(result.holdKind, 'memory'); assert.equal(result.attempts, MAX_RESOURCE_HOLD_ATTEMPTS)
  assert.equal(typeof result.message, 'string'); assert.ok(result.message.length > 20)
  assert.ok(result.message.includes(String(MAX_RESOURCE_HOLD_ATTEMPTS)), 'the outcome names how many times it was refused')
  assert.equal(queue.nodeState('node-0').phase, 'abandoned')
  assert.equal(queue.snapshot().waiting, false, 'an abandoned queue is not still "waiting"')
})
test('the monitor’s retry-after is a floor for the wait, never the whole answer', async () => {
  const { startsAt } = await drivenHold({ code: 'AGENT_RESOURCE_PRESSURE', retryAfterMs: 5000 })
  const gaps = startsAt.slice(1).map((at, index) => at - startsAt[index])
  assert.ok(gaps.every(gap => gap >= 5000), `every wait honours the monitor's 5 s: ${gaps.join(',')}`)
  assert.ok(gaps.at(-1) > 5000, 'and the later waits grow past it')
})
test('a hold that lifts before the cap starts the node and counts no abandonment', async () => {
  let clock = 1000
  const scheduled = []
  let calls = 0
  const queue = createTreeLaunchQueue({ nodes: nodes(1), concurrency: 1, now: () => clock,
    schedule(fn, delay) { scheduled.push({ fn, at: clock + delay }); return fn }, unschedule() {},
    start: async () => { calls++; return calls < MAX_RESOURCE_HOLD_ATTEMPTS ? { ok: false, retryable: true, code: 'AGENT_RESOURCE_WARMING', retryAfterMs: 1000 } : { ok: true, sessionId: 'started-late' } } })
  for (let iterations = 0; !queue.snapshot().finished && iterations < 100; iterations++) {
    const job = scheduled.shift(); if (job) { clock = job.at; job.fn() }
    await tick()
  }
  const report = await queue.done
  assert.equal(report.started, 1); assert.equal(report.abandoned, 0); assert.equal(calls, MAX_RESOURCE_HOLD_ATTEMPTS)
})
test('the abandoned outcome classifies the hold by what the monitor measured, not by the code alone', () => {
  assert.equal(resourceHoldKind('AGENT_RESOURCE_PRESSURE'), 'cpu')
  assert.equal(resourceHoldKind('AGENT_RESOURCE_PRESSURE', { cause: 'loop-lag', loopLagMs: 700 }), 'memory-or-responsiveness')
  assert.equal(resourceHoldKind('AGENT_RESOURCE_PRESSURE', { cause: 'cpu-ceiling', cpuPercent: 99 }), 'cpu')
  assert.equal(resourceHoldKind('AGENT_MEMORY_LOW', { cause: 'memory' }), 'memory')
  assert.equal(resourceHoldKind('AGENT_RESOURCE_UNKNOWN'), 'measurement')
  assert.equal(resourceHoldKind('AGENT_RESOURCE_PACING'), 'other-starts')
  assert.notEqual(resourceHoldKind('AGENT_RESOURCE_PRESSURE', { cause: 'loop-lag' }), resourceHoldKind('AGENT_RESOURCE_PRESSURE', { cause: 'cpu-ceiling' }))
})
