import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { FLEET_INPUT_TIMING, FLEET_NODE_VISIBLE, INPUT_UI_QUIET, INPUT_METRIC_LIMIT, createPresser } from '../lib/fleet-node.mjs'

function fake() {
  const calls = []
  return { calls, session: { send: async (...args) => calls.push(args) }, evaluate: async expr => {
    calls.push(['evaluate', expr])
    if (expr.startsWith(`(${FLEET_NODE_VISIBLE})`)) return { state: 'visible', x: 4, y: 5 }
    return { waitedMs: 0, settled: true, reason: 'quiet' }
  }, delay: async () => {} }
}

test('Page 2 presser keeps real CDP gestures and exposes bounded adaptive timing', async () => {
  const f = fake(); const p = createPresser(f)
  assert.equal(p.timing.visiblePollMs, FLEET_INPUT_TIMING.visiblePollMs)
  assert.equal(p.timing.pressQuietMs, FLEET_INPUT_TIMING.pressQuietMs)
  await p.press('[data-test=button]')
  await p.key('Enter')
  await p.type('ok')
  assert.deepEqual(f.calls.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params.type), ['mousePressed', 'mouseReleased'])
  assert.deepEqual(f.calls.filter(([method]) => method === 'Input.dispatchKeyEvent').map(([, params]) => params.type), ['rawKeyDown', 'keyUp'])
  assert.deepEqual(p.metrics().map(row => row.kind), ['press', 'key', 'type'])
})

test('Page 2 presser rejects unknown named keys instead of sending undefined codes', async () => {
  const f = fake(); const p = createPresser(f)
  await assert.rejects(() => p.key('F13'), /does not know/)
  assert.equal(f.calls.filter(([method]) => method === 'Input.dispatchKeyEvent').length, 0)
})

// Drive the evaluated browser function itself with a deterministic clock. The
// observer only receives mutations in the subtree it really subscribed to.
async function quietFixture({ change = () => {}, selector = '#control' } = {}) {
  let now = 0, observed = null, disconnected = 0
  const jobs = [], subscriptions = []
  const node = { value: '', checked: false, box: { x: 1, y: 2, width: 20, height: 10 }, getBoundingClientRect() { return this.box } }
  const replacement = { ...node, box: { ...node.box } }, unrelated = {}
  const state = { node, replacement, unrelated, target: node, hit: node }
  const context = { Date: { now: () => now }, document: {
    body: {}, documentElement: {}, querySelector: () => state.target,
    get activeElement() { return state.target }, elementFromPoint: () => state.hit,
  }, setTimeout: (fn, ms) => jobs.push({ at: now + ms, fn }), MutationObserver: class {
    constructor(callback) { this.callback = callback; state.mutate = target => { if (target === observed) callback() } }
    observe(target) { observed = target; subscriptions.push(target) }
    disconnect() { observed = null; disconnected++ }
  } }
  let result
  const promise = vm.runInNewContext(`${INPUT_UI_QUIET}(120, 360, ${JSON.stringify(selector)})`, context)
    .then(value => { result = JSON.parse(JSON.stringify(value)) })
  for (let steps = 0; !result && steps < 30; steps++) {
    jobs.sort((a, b) => a.at - b.at)
    const job = jobs.shift(); assert.ok(job, 'quiet wait lost its next tick')
    now = job.at; change(state, now); job.fn(); await Promise.resolve()
  }
  await promise
  assert.equal(observed, null, 'observer must disconnect after both quiet and budget exits')
  return { result, state, subscriptions, disconnected }
}

test('input quiet ignores sibling streaming but keeps the complete control quiet window', async () => {
  const { result, state, subscriptions } = await quietFixture({ change: s => s.mutate(s.unrelated) })
  assert.deepEqual(result, { waitedMs: 120, settled: true, reason: 'quiet' })
  assert.deepEqual(subscriptions, [state.node])
})

test('a continuously changing input exhausts its budget honestly and disconnects', async () => {
  const { result } = await quietFixture({ change: s => s.mutate(s.node) })
  assert.deepEqual(result, { waitedMs: 360, settled: false, reason: 'budget' })
})

test('quiet wait follows replacement controls and notices layout or coverage changes outside their subtree', async () => {
  for (const kind of ['replacement', 'layout', 'coverage', 'value']) {
    const { result, subscriptions, state } = await quietFixture({ selector: kind === 'value' ? null : '#control', change(s, now) {
      if (now !== 80) return
      if (kind === 'replacement') { s.target = s.replacement; s.hit = s.replacement }
      if (kind === 'layout') s.node.box.x += 10
      if (kind === 'coverage') s.hit = s.unrelated
      if (kind === 'value') s.node.value = 'typed'
    } })
    assert.equal(result.waitedMs, 200, `${kind} must restart the quiet window`)
    assert.equal(result.settled, true)
    if (kind === 'replacement') assert.deepEqual(subscriptions, [state.node, state.replacement])
  }
})

test('Page 2 input metrics retain budget failures, cap history, and return independent snapshots', async () => {
  const f = fake()
  f.evaluate = async () => ({ waitedMs: 500, settled: false, reason: 'budget' })
  const p = createPresser(f)
  for (let i = 0; i < INPUT_METRIC_LIMIT + 4; i++) await p.type('x'.repeat(i + 1))
  const metrics = p.metrics()
  assert.equal(metrics.length, INPUT_METRIC_LIMIT)
  assert.equal(metrics[0].chars, 5)
  assert.equal(metrics.at(-1).chars, INPUT_METRIC_LIMIT + 4)
  assert.ok(metrics.every(row => row.waitedMs === 500 && !row.settled && row.reason === 'budget'))
  metrics[0].reason = 'quiet'; metrics.length = 0
  assert.equal(p.metrics()[0].reason, 'budget')
  assert.equal(p.metrics().length, INPUT_METRIC_LIMIT)
})
