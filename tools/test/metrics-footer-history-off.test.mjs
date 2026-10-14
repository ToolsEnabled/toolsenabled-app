/* THE METRICS FOOTER, AND THE OFF COPY, BY VALUE (BUG08 root review
 * 2026-09-21). The prior BUG08 fix said the off-message only when BOTH the
 * sessions and usage reads were disabled; a page where history is off and
 * usage read fine (or the reverse) still fell through to "Some records could
 * not be read. Try Refresh data." -- an intentional-off state reported as a
 * failure. This drives the ACTUAL footer expression (src/metrics-footer-status.js,
 * which src/views/metrics.js calls) with the four inputs the root probe
 * measured (t782-bug08-mixed-read-probe-controller-1.json), plus the timeout,
 * healthy and genuine-partial cases, and holds intentional-off apart from a
 * genuine read failure. It also pins the copy narrowing: the off copy no
 * longer claims "Nothing is broken and nothing was lost" (a machine/data-health
 * guarantee this page cannot make) and is scoped to NEW operations, because
 * work already admitted to the audit may still finish recording after a toggle.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

register('./helpers/css-stub-loader.mjs', import.meta.url)
import { metricsFooterStatus, METRICS_AUDIT_OFF_STATUS } from '../../src/metrics-footer-status.js'
import { LOCAL_METRICS_COPY, LOCAL_USAGE_COPY } from '../../src/local-metrics.js'

const off = { disabled: true, readable: false }              // AUDIT_NOT_ENABLED, the person's setting
const healthy = { disabled: false, readable: true }          // read fine
const broken = { disabled: false, readable: false }          // a genuine read failure

test('the four probe inputs: intentional off (mixed or both) is the off message; off beside a genuinely broken side stays an error', () => {
  // Row 1: history off, usage read fine. The bug reported "Some records could
  // not be read"; it must be the off message.
  assert.equal(metricsFooterStatus({ sessions: off, usage: healthy, readErrors: { history: 'AUDIT_NOT_ENABLED', usage: null }, updatedLabel: 'Updated 12:00' }),
    METRICS_AUDIT_OFF_STATUS)
  // Row 2: usage off, history read fine. Symmetric.
  assert.equal(metricsFooterStatus({ sessions: healthy, usage: off, readErrors: { history: null, usage: 'AUDIT_NOT_ENABLED' }, updatedLabel: 'Updated 12:00' }),
    METRICS_AUDIT_OFF_STATUS)
  // Row 3: both off. Already correct before; still the off message.
  assert.equal(metricsFooterStatus({ sessions: off, usage: off, readErrors: { history: 'AUDIT_NOT_ENABLED', usage: 'AUDIT_NOT_ENABLED' }, updatedLabel: 'Updated 12:00' }),
    METRICS_AUDIT_OFF_STATUS)
  // Row 4: history off, usage GENUINELY broken (METRICS_READ_UNAVAILABLE).
  // Off beside a real failure is still a failure; neither side readable -> total.
  assert.equal(metricsFooterStatus({ sessions: off, usage: broken, readErrors: { history: 'AUDIT_NOT_ENABLED', usage: 'METRICS_READ_UNAVAILABLE' }, updatedLabel: 'Updated 12:00' }),
    'Could not read records. Try Refresh data.')
})

test('genuine failures and healthy reads keep their own verdicts, unchanged', () => {
  assert.equal(metricsFooterStatus({ needsUpdate: true, sessions: healthy, usage: healthy }), 'App update needed')
  // A timeout on either side is an error, regardless of the other side.
  assert.equal(metricsFooterStatus({ sessions: off, usage: broken, readErrors: { usage: 'METRICS_READ_TIMEOUT' } }),
    'Some records took too long to load. Try Refresh data.')
  // One side readable, the other genuinely broken (not off) -> partial.
  assert.equal(metricsFooterStatus({ sessions: healthy, usage: broken, updatedLabel: 'Updated 12:00' }),
    'Some records could not be read. Try Refresh data.')
  // A genuine failure that is off on the other side is not "off": it is broken.
  assert.equal(metricsFooterStatus({ sessions: broken, usage: off, updatedLabel: 'Updated 12:00' }),
    'Could not read records. Try Refresh data.')
  // Both readable -> the ordinary Updated stamp, passed in so the verdict is pure.
  assert.equal(metricsFooterStatus({ sessions: healthy, usage: healthy, updatedLabel: 'Updated 09:41' }), 'Updated 09:41')
  // Nothing readable and nothing disabled -> a failure, not the off message.
  assert.equal(metricsFooterStatus({ sessions: broken, usage: broken, updatedLabel: 'Updated 12:00' }),
    'Could not read records. Try Refresh data.')
})

test('the off status is scoped to new operations and claims no machine or data-health guarantee', () => {
  assert.match(METRICS_AUDIT_OFF_STATUS, /off for new operations/)
  assert.doesNotMatch(METRICS_AUDIT_OFF_STATUS, /nothing new is recorded|Nothing is broken|nothing was lost/)
  assert.match(METRICS_AUDIT_OFF_STATUS, /Turn it on under Advanced settings\./)
})

test('the run and usage off copy is narrowed the same way: new operations, saved history preserved, no health guarantee', () => {
  for (const copy of [LOCAL_METRICS_COPY.disabled, LOCAL_USAGE_COPY.disabled]) {
    assert.match(copy, /Activity auditing is off for new operations/)
    assert.match(copy, /Saved history is preserved\./)
    assert.match(copy, /Turn on Signed activity audit under Advanced settings/)
    assert.doesNotMatch(copy, /Nothing is broken and nothing was lost/, 'the off read is not a whole-machine health guarantee')
    assert.doesNotMatch(copy, /nothing new is recorded/)
  }
  assert.match(LOCAL_METRICS_COPY.disabled, /record new runs\./)
  assert.match(LOCAL_USAGE_COPY.disabled, /record new turns\./)
})


/* Mount the production view: native-shaped replies cross the real
 * readMetricsRecords validation, loadLocalMetrics currentness fence and DOM
 * footer publisher. Only the bridge, browser and clock are synthetic.
 * As in metrics.test.mjs, chart RAF work is outside this footer contract. */
const OFF_REPLY = Object.freeze({ ok: false, code: 'AUDIT_NOT_ENABLED' })
const BROKEN_REPLY = Object.freeze({ ok: false, code: 'AUDIT_UNAVAILABLE' })
const OFF_FOOTER = 'Activity auditing is off for new operations, so new runs are not recorded here. Turn it on under Advanced settings.'
const BROKEN_FOOTER = 'Could not read records. Try Refresh data.'
const TIMEOUT_FOOTER = 'Some records took too long to load. Try Refresh data.'

function readableReply({ metrics }) {
  return { ok: true, verified: true, entries: [], total: 0,
    metrics: { v: 1, ...metrics, principal: 'unauthenticated', head: 0, count: 0, nextBefore: null } }
}
function heldReply() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
async function settleFooter() {
  for (let n = 0; n < 24; n++) await Promise.resolve()
  await nextTurn()
}

async function mountedFooter(t, replies) {
  const dom = installDomStandIn()
  // The shared stand-in has no select.options collection; supply the same
  // browser semantics as the existing Metrics DOM suite, only for this mount.
  const elementPrototype = Object.getPrototypeOf(document.createElement('select'))
  const previousOptions = Object.getOwnPropertyDescriptor(elementPrototype, 'options')
  Object.defineProperty(elementPrototype, 'options', { configurable: true,
    get() { return this.children.filter(child => child.tagName === 'OPTION') } })
  const saved = new Map(['localStorage', 'mcAgent', 'navigator', 'fetch'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const storage = new Map(), calls = [], deadlines = new Map()
  let view, retired = false, currentReplies = replies
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay !== 15000) return originalSetTimeout(callback, delay, ...args)
    const handle = {}
    deadlines.set(handle, () => callback(...args))
    return handle
  })
  t.mock.method(globalThis, 'clearTimeout', handle => {
    if (!deadlines.delete(handle)) originalClearTimeout(handle)
  })
  function retire() {
    if (retired) return
    retired = true
    view?.destroy()
    view?.el.remove()
  }
  t.after(async () => {
    try {
      retire()
      await settleFooter()
      assert.equal(deadlines.size, 0, 'disposal releases all Metrics deadlines')
    } finally {
      t.mock.restoreAll()
      if (previousOptions) Object.defineProperty(elementPrototype, 'options', previousOptions)
      else delete elementPrototype.options
      dom.restore()
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
    }
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'metrics-footer-fixture' } })
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  }
  globalThis.fetch = async () => assert.fail('Footer fixture must not use a network or owner transport')
  window.document = document
  document.defaultView = window
  document.createElementNS = (_namespace, tag) => document.createElement(tag)
  window.location = { hostname: 'desktop.test', search: '' }
  window.matchMedia = () => ({ matches: false })
  window.mcShell = { getBridgeProof: async () => ({ ok: true }) }
  globalThis.requestAnimationFrame = () => 41
  globalThis.cancelAnimationFrame = () => {}
  globalThis.mcAgent = window.mcAgent = Object.fromEntries(['history', 'usage'].map(channel =>
    [channel, async request => {
      calls.push({ channel, request })
      assert.equal(request.limit, 200)
      assert.ok(Number.isSafeInteger(request.metrics?.fromMs) && request.metrics.toMs > request.metrics.fromMs,
        'the actual reader requests its bounded window')
      const answer = currentReplies[channel]
      return typeof answer === 'function' ? answer(request) : answer
    }]))
  const { metricsView } = await import('../../src/views/metrics.js')
  view = metricsView()
  document.body.append(view.el)
  await settleFooter()
  return {
    view, calls, retire,
    footer: () => view.el.querySelector('#m-refresh-status').textContent,
    refresh: () => view.el.querySelector('#m-refresh'),
    setReplies(value) { currentReplies = value },
    changeSource() { window.dispatchEvent({ type: 'mc:data-source-changed' }) },
    expireRead() {
      assert.equal(deadlines.size, 1, 'only the held record deadline remains after source and other channel settle')
      const [handle, expire] = deadlines.entries().next().value
      deadlines.delete(handle)
      expire()
    },
  }
}

for (const [name, replies, expected] of [
  ['history off and usage readable', { history: OFF_REPLY, usage: readableReply }, OFF_FOOTER],
  ['history readable and usage off', { history: readableReply, usage: OFF_REPLY }, OFF_FOOTER],
  ['history off and usage broken', { history: OFF_REPLY, usage: BROKEN_REPLY }, BROKEN_FOOTER],
  ['history broken and usage off', { history: BROKEN_REPLY, usage: OFF_REPLY }, BROKEN_FOOTER],
]) test('mounted Metrics footer: ' + name, async t => {
  const f = await mountedFooter(t, replies)
  assert.deepEqual(f.calls.map(call => call.channel), ['history', 'usage'])
  assert.equal(f.footer(), expected, 'the actual reader result reaches the actual footer')
  assert.equal(f.refresh().disabled, false)
})

test('mounted Metrics footer: an invalid readable page beside off remains a read failure', async t => {
  const f = await mountedFooter(t, {
    history: request => { const result = readableReply(request); result.metrics.fromMs++; return result },
    usage: OFF_REPLY,
  })
  assert.equal(f.footer(), BROKEN_FOOTER, 'the real reader validates coverage before the footer can call the page readable')
})

for (const channel of ['history', 'usage']) test('mounted Metrics footer: ' + channel + ' timeout outranks off and ignores its late answer', async t => {
  const held = heldReply()
  const f = await mountedFooter(t, {
    history: OFF_REPLY, usage: OFF_REPLY, [channel]: () => held.promise,
  })
  assert.equal(f.footer(), 'Reading records')
  assert.equal(f.refresh().disabled, true)
  f.expireRead()
  await settleFooter()
  assert.equal(f.footer(), TIMEOUT_FOOTER, 'the real deadline code survives reader normalization and footer publication')
  assert.equal(f.refresh().disabled, false)
  held.resolve(readableReply(f.calls.find(call => call.channel === channel).request))
  await settleFooter()
  assert.equal(f.footer(), TIMEOUT_FOOTER, 'a late native response cannot overwrite a timed-out footer')
})

test('mounted Metrics footer: a newer source read owns publication over a held old response', async t => {
  const held = heldReply(), replacement = heldReply()
  const f = await mountedFooter(t, { history: OFF_REPLY, usage: () => held.promise })
  assert.equal(f.footer(), 'Reading records')
  f.setReplies({ history: readableReply, usage: () => replacement.promise })
  f.changeSource()
  await settleFooter()
  assert.equal(f.calls.length, 4, 'the real source-change subscription starts a replacement read')
  assert.equal(f.footer(), 'Reading records', 'the aborted old read cannot publish its cancellation over the pending replacement')
  assert.equal(f.refresh().disabled, true, 'the old finally cannot release the replacement controls')
  replacement.resolve(readableReply(f.calls[3].request))
  await settleFooter()
  assert.match(f.footer(), /^Updated /, 'only the current complete read publishes a healthy status')
  const updated = f.footer()
  held.resolve(readableReply(f.calls[1].request))
  await settleFooter()
  assert.equal(f.footer(), updated, 'the old off/readable response cannot replace the current healthy result')
  assert.equal(f.refresh().disabled, false)
})

test('mounted Metrics footer: disposal prevents a held response from publishing', async t => {
  const held = heldReply()
  const f = await mountedFooter(t, { history: OFF_REPLY, usage: () => held.promise })
  assert.equal(f.footer(), 'Reading records')
  f.retire()
  held.resolve(readableReply(f.calls[1].request))
  await settleFooter()
  assert.equal(f.footer(), 'Reading records', 'destroyed load cannot publish even into its detached DOM')
  assert.equal(f.refresh().disabled, true, 'destroyed load cannot release its retired controls')
  f.changeSource()
  await settleFooter()
  assert.equal(f.calls.length, 2, 'disposal also removes the source-change subscription')
})
