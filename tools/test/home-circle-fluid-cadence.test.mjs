// The Home circle's quality ladder may step down only for slowness the circle
// causes. A page that is busy around a cheap circle keeps its extras; costly
// script time or a slow GPU still steps it down.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import vm from 'node:vm'

import { fluidWindowVerdict } from '../../src/home-circle-fluid.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const BUDGET = 1000 / 30 // every rung of the ladder runs at 30 or 20 steps per second
const repeat = (value, count = 16) => Array.from({ length: count }, () => value)
const source = readFileSync(new URL('../../src/home-circle-fluid.js', import.meta.url), 'utf8')

test('the LIVE measurement: steps every 50 ms that cost 0.2 to 0.3 ms keep the extras and the rung', () => {
  for (const work of [0.2, 0.3]) {
    const verdict = fluidWindowVerdict({ intervals: repeat(50), works: repeat(work), probes: [1.1, 1.4], budget: BUDGET })
    assert.equal(verdict.medianMs, 50)
    assert.equal(verdict.slow, false, `a busy page around a ${work} ms circle is not the circle being slow`)
    assert.equal(verdict.severe, false)
  }
  const stalled = fluidWindowVerdict({ intervals: repeat(120), works: repeat(0.3), probes: [0.9, 1.2], budget: BUDGET })
  assert.equal(stalled.slow, false, 'even a badly paced page does not cost a cheap circle a rung')
})

test('expensive script work still steps down, whatever the probes say', () => {
  const costly = fluidWindowVerdict({ intervals: repeat(50), works: repeat(22), probes: [1], budget: BUDGET })
  assert.equal(costly.slow, true)
  assert.equal(costly.severe, false)
  const severe = fluidWindowVerdict({ intervals: repeat(34), works: repeat(45), probes: [1], budget: BUDGET })
  assert.equal(severe.slow, true)
  assert.equal(severe.severe, true)
})

test('a slow GPU still steps down: cheap script time, slow cadence, and a costly GPU-synced step', () => {
  const gpu = fluidWindowVerdict({ intervals: repeat(50), works: repeat(0.3), probes: [21, 24], budget: BUDGET })
  assert.equal(gpu.slow, true)
  assert.equal(gpu.fullMs, 21, 'the cheaper probe is the one trusted, so one stall cannot blame the circle')
  const badly = fluidWindowVerdict({ intervals: repeat(90), works: repeat(0.3), probes: [30, 31], budget: BUDGET })
  assert.equal(badly.severe, true)
  const outlier = fluidWindowVerdict({ intervals: repeat(50), works: repeat(0.3), probes: [1.2, 40], budget: BUDGET })
  assert.equal(outlier.slow, false, 'one stalled probe beside a cheap one does not step down')
})

test('without a probe the cadence decides, as it did before', () => {
  const unmeasured = fluidWindowVerdict({ intervals: repeat(50), works: repeat(0.3), probes: [], budget: BUDGET })
  assert.equal(unmeasured.fullMs, null)
  assert.equal(unmeasured.slow, true)
  const fine = fluidWindowVerdict({ intervals: repeat(34), works: repeat(0.3), probes: [], budget: BUDGET })
  assert.equal(fine.slow, false)
})

/* RE-STATED AS BEHAVIOUR 2026-09-19 (Worker 6). Three of the claims below were
   assert.match pins on this module's TEXT: the exact readPixels argument list,
   the exact judge() call, the whole fluidWindowVerdict statement verbatim, and
   a ban on an old cadence-only line. They were GREEN when this was written --
   the contract that asked for this work reported them red, and they were not;
   the measurement is in REPORT-W-GATE-20260919.md -- but a spelling pin fails
   against a BETTER implementation of the same behaviour, and the quickest way
   back to green is then to reinstate the defect. That trap was sprung in this
   lane on 2026-09-18 in home-circle-motion-runtime.test.mjs, where a pin on a
   uniform-DECLARATION ORDER went red while four owner rejections underneath it
   silently stopped binding and reported nothing. Each claim is now made by
   RUNNING the real frame/judge/degrade out of the module against values.

   What is still read from the text, and why that is not a pin: runLoop lifts
   the three functions and the LADDER constant out of the module BY NAME in
   order to run them at all. That is the harness, not the assertion. If a
   rename breaks it the failure is "the loop could not be run" -- a refusal a
   person can see -- and not a wrong verdict about the circle. */

test('the frame loop takes its probe THROUGH a GPU sync: the GPU time is paid inside the step', () => {
  /* A cheap script and a slow GPU. Without the probe the loop never waits for
     the GPU inside its own step, so no probe time is ever recorded and the
     only evidence left is the frame cadence. */
  const gpu = runLoop({ pageMs: 1, workMs: 0.3, gpuMs: 40 })
  assert.ok(gpu.probeCalls > 0, 'the loop never synced with the GPU at all')
  assert.ok(gpu.fullMs >= 20, `the probe carries the GPU's own time into the judgement (fullMs ${gpu.fullMs})`)
  assert.equal(gpu.extrasOn, false, 'and a slow GPU therefore costs the extras')
})

test('the probe DECIDES: two runs with the same bad cadence get opposite verdicts, and only the probe differs', () => {
  /* The banned line was `slow = median > budget * 1.35` -- a rule that can only
     see the cadence. These two runs are both far over it. In one the circle's
     own GPU step is expensive and in the other it is the page that is slow, and
     the verdicts are opposite. No cadence-only rule can tell them apart, so
     this is the claim "the probe reaches the judgement" made on behaviour. */
  const ours = runLoop({ pageMs: 1, workMs: 0.3, gpuMs: 40 })
  const theirs = runLoop({ pageMs: 40, workMs: 0.3, gpuMs: 1 })
  assert.ok(ours.medianMs > BUDGET * 1.35, `the GPU-bound run paces badly (median ${ours.medianMs} ms)`)
  assert.ok(theirs.medianMs > BUDGET * 1.35, `the page-bound run paces just as badly (median ${theirs.medianMs} ms)`)
  assert.equal(ours.extrasOn, false, 'the circle pays for its own slow step')
  assert.equal(theirs.extrasOn, true, 'and is not billed for the page around it')
  /* And the probe is what carries the difference into the verdict: the same two
     windows put through the exported judgement directly. */
  assert.equal(fluidWindowVerdict({ intervals: repeat(ours.medianMs), works: repeat(0.3), probes: [ours.fullMs], budget: BUDGET }).slow, true)
  assert.equal(fluidWindowVerdict({ intervals: repeat(theirs.medianMs), works: repeat(0.3), probes: [theirs.fullMs], budget: BUDGET }).slow, false)
})

test('the cadence-only rule is gone: a badly paced page around a cheap circle keeps everything', () => {
  /* Asserted by consequence rather than by a ban on a line of text: 40 ms of
     PAGE work a frame puts the median far over 1.35x the budget, and the
     circle must not be blamed for the page. */
  const busy = runLoop({ pageMs: 40, workMs: 0.3, gpuMs: 1 })
  assert.ok(busy.medianMs > BUDGET * 1.35,
    `the page really is pacing badly (median ${busy.medianMs} ms against ${(BUDGET * 1.35).toFixed(1)} ms)`)
  assert.equal(busy.extrasOn, true, 'and the cheap circle keeps its extras')
  assert.deepEqual(busy.changes, [])
})

/* STILL READ FROM THE TEXT, and labelled so. Both preferences are consulted in
   mountHomeCircleFluid before the frame loop exists, so the vm harness that
   runs frame/judge/degrade cannot reach them and neither can a pure call:
   proving them by behaviour needs a DOM and a matchMedia stand-in, which is a
   browser gate's job and not this file's. "Could not look" and "not there" are
   different answers; this is the first, and the weaker claim is named rather
   than dressed up as the stronger one. */
test('reduced motion and save-data are still consulted (STRUCTURAL: not reachable from the frame loop)', () => {
  assert.match(source, /prefers-reduced-motion: reduce/)
  assert.match(source, /connection\.saveData/)
})

/* The real frame loop, judgement and ladder from the module, run against a
   simulated 60 Hz clock. `pageMs` is the main-thread work around the circle per
   browser frame, `workMs` the circle's script time per step, and `gpuMs` the
   GPU time of a step: it delays the next frame, and a GPU-synced probe waits
   for it inside the step instead. `probeCalls` counts the syncs the loop
   actually took, so "it probes" is an observation and not a spelling. */
function runLoop({ pageMs, workMs, gpuMs, seconds = 12 }) {
  const loop = ['frame', 'judge', 'degrade'].map(name => declaredFunctionSource(source, name)).join('\n')
  const constants = source.match(/var LADDER = \[[\s\S]*?\];/)[0]
  const context = vm.createContext({ fluidWindowVerdict, Uint8Array, Math, String })
  vm.runInContext(`
    var clock = 0;
    var performance = { now: function () { return clock; } };
    var requestAnimationFrame = function () { return 1; };
    ${constants}
    var SMALL_START = 2, WARMUP = 10, WINDOW = 16, PROBE_EVERY = 8;
    var level = SMALL_START, running = true, shown = false, extrasOn = true, dead = false;
    var rafId = 0, lastStep = 0, warm = WARMUP, strikes = 0;
    var intervals = [], works = [], probes = [], probePixel = new Uint8Array(4);
    var stats = { raf: 0, steps: 0, medianMs: 0, workMs: 0, fullMs: null, changes: [], note: '' };
    var visual = { setAttribute: function () {} };
    var probeCalls = 0;
    var gl = { RGBA: 1, UNSIGNED_BYTE: 2, readPixels: function () { probeCalls++; clock += pendingGpu; pendingGpu = 0; } };
    var WORK = 0, GPU = 0, pendingGpu = 0;
    function step() { clock += WORK; pendingGpu = GPU; }
    function reveal() { shown = true; }
    function dropExtras() { extrasOn = false; }
    function allocate() {}
    function fail(why) { dead = true; running = false; stats.note = why; }
    ${loop}
  `, context)
  context.WORK = workMs
  context.GPU = gpuMs
  let vsync = 0
  const frameMs = 1000 / 60
  while (vsync < seconds * 1000 && !context.dead) {
    context.clock = Math.max(context.clock, vsync)
    const begin = context.clock
    context.frame(begin)
    context.clock += context.pendingGpu + pageMs
    context.pendingGpu = 0
    vsync = Math.ceil((context.clock + 0.001) / frameMs) * frameMs
  }
  return JSON.parse(JSON.stringify({ extrasOn: context.extrasOn, level: context.level, shown: context.shown, changes: context.stats.changes, steps: context.stats.steps, probeCalls: context.probeCalls, fullMs: context.stats.fullMs, medianMs: context.stats.medianMs }))
}

test('through the real loop: a page busy for 40 ms a frame around a cheap circle keeps the extras and the rung', () => {
  const run = runLoop({ pageMs: 40, workMs: 0.3, gpuMs: 1 })
  assert.ok(run.steps > 100, `the loop stepped (${run.steps})`)
  assert.deepEqual(run.changes, [])
  assert.equal(run.extrasOn, true)
  assert.equal(run.level, 2)
  assert.equal(run.shown, true)
})

test('through the real loop: expensive script work or a slow GPU still steps down', () => {
  const script = runLoop({ pageMs: 1, workMs: 30, gpuMs: 1 })
  assert.equal(script.extrasOn, false, 'costly script time drops the extras')
  assert.ok(script.changes.length >= 1)
  const gpu = runLoop({ pageMs: 1, workMs: 0.3, gpuMs: 40 })
  assert.equal(gpu.extrasOn, false, 'a slow GPU drops the extras')
  assert.ok(gpu.changes.some(change => change.from === 'extras'))
})

test('through the real loop: an idle page and a cheap circle change nothing', () => {
  const run = runLoop({ pageMs: 2, workMs: 0.3, gpuMs: 1 })
  assert.deepEqual(run.changes, [])
  assert.equal(run.extrasOn, true)
})
