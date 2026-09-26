/* IS THIS COMPUTER STEADY ENOUGH FOR ITS OWN TIMING TESTS TO MEAN ANYTHING?
 *
 * WHAT WENT WRONG, MEASURED 2026-08-16.
 *
 * `account-isolation-session-qa` passed against the 1.0.12 sealed tree on
 * 2026-08-15 and failed against THE SAME BYTES a day later. The recorded cause
 * was "a DPAPI outage on this machine", which a positive control refuted. The
 * replacement theory was "the machine is 2.5-4x slower", which a second control
 * also refuted -- the median and the floor are healthy.
 *
 * What is actually true is narrower and worse for every timing test here:
 * identical fixed CPU work on this machine varied from 356ms to 5408ms in one
 * run of twenty passes. The product's own account create, on byte-identical
 * builds, took 3.305s, then 7.696s, then 9.211s, then 13.713s on successive
 * days. The drivers meanwhile assert against FIXED wall-clock budgets -- an
 * 11.450s window in tools/test-account-harness.mjs, a 900ms route budget in
 * tools/performance-budget-qa.mjs. A constant compared against a quantity that
 * varies fifteen-fold does not measure the product. It measures the weather.
 *
 * A RED THAT MEANS "YOUR MACHINE WAS BUSY" TRAINS EVERYONE TO IGNORE REDS. That
 * is how the account failure spent three days attributed to DPAPI. So a driver
 * that cannot measure should say so, by name, instead of blaming the product.
 *
 * TWO DESIGN ERRORS THIS MODULE ALREADY SURVIVED, both caught by measuring
 * rather than reasoning, and both recorded so nobody re-introduces them:
 *
 *   1. A CHEAP probe looked like it could not see the stalls: twenty passes at
 *      N=2^12 spread only 1.4x while N=2^17 spread 3.9x. The obvious reading --
 *      "jitter only affects long work" -- was wrong. Interleaving both in ONE
 *      window put cheap at 3.6x and dear at 2.5x. The cheap set had simply run
 *      during a calm minute. Jitter here is TIME-dependent, not DURATION-
 *      dependent, so a cheap probe is a valid instrument.
 *
 *   2. A PRE-FLIGHT probe is the wrong shape, and this is the important one.
 *      The degradation is not noise, it is a state change: in two separate runs
 *      the first six-to-eight passes held ~390ms and then EVERY later pass cost
 *      1.0-5.4s and never recovered. Sustained load moves the machine into a
 *      slow state and it stays there. A probe that runs before the measurement
 *      reports a cool machine, and then the measurement itself does the heating.
 *      So steadiness is sampled ACROSS the run, never once at the start.
 *
 * The work is scrypt because the product already depends on it, it is purely
 * CPU-bound, and its cost is fixed by its parameters rather than by anything on
 * this disk -- so a slow sample is the machine, never the workload.
 */

import crypto from 'node:crypto'

/* ~15-40ms per pass on a quiet machine: cheap enough to sample repeatedly
   through a run without becoming a meaningful part of what is being measured. */
export const PROBE_N = 4096
const PROBE_SALT = Buffer.alloc(16, 7)

/* MEASURED, NOT CHOSEN. A calm window on this machine reads 1.3-1.4x; a
   turbulent one reads 2.5-3.6x, and the run that started this work reached
   3.9x. Two sits above every calm reading and below every turbulent one. It is
   a threshold on the SPREAD rather than on absolute speed on purpose: a
   uniformly slow computer can still hold a budget proportionally, but one that
   changes speed mid-run cannot be measured at all. */
export const STEADY_RATIO_LIMIT = 2

/* Fewer than this and a single outlier sets the ratio, which would refuse to
   measure on one unlucky scheduling slice. */
export const MIN_SAMPLES = 6

export function probeOnce() {
  const started = process.hrtime.bigint()
  crypto.scryptSync('steadiness-probe', PROBE_SALT, 32, { N: PROBE_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  return Number(process.hrtime.bigint() - started) / 1e6
}

/* THE RATIO IS p90/p10, AND THE OBVIOUS max/median IS WRONG -- test 5 caught it.
 *
 * The failure this guard exists for is a run that degrades PART WAY THROUGH and
 * stays degraded. Once roughly half the samples are slow, the median moves INTO
 * the slow half, and max/median collapses: [380, 390, 400, 3000, 3100, 3200] --
 * a machine that got eight times slower mid-run -- reads 3200/3000 = 1.1x and
 * would have been called steady. The statistic was blind to precisely the shape
 * it was written for.
 *
 * So the baseline is the FAST end (what this computer can do when nothing is in
 * its way) and the ratio measures how far the slow end departs from it. The
 * tenth and ninetieth percentiles rather than min and max, so one unlucky
 * scheduling slice at either end cannot decide the run on its own. */
function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}

/* Pure, so the decision can be tested without needing a busy computer. */
export function steadinessOf(samples) {
  const clean = (Array.isArray(samples) ? samples : []).filter(n => Number.isFinite(n) && n > 0)
  if (clean.length < MIN_SAMPLES) {
    return Object.freeze({
      count: clean.length, minMs: null, medianMs: null, maxMs: null, ratio: null,
      steady: null, reason: 'not enough samples to say',
    })
  }
  const sorted = [...clean].sort((a, b) => a - b)
  const fast = percentile(sorted, 0.1)
  const slow = percentile(sorted, 0.9)
  const ratio = fast > 0 ? slow / fast : Infinity
  return Object.freeze({
    count: clean.length,
    minMs: Math.round(sorted[0]),
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]),
    maxMs: Math.round(sorted[sorted.length - 1]),
    ratio: Math.round(ratio * 10) / 10,
    steady: ratio <= STEADY_RATIO_LIMIT,
    reason: ratio <= STEADY_RATIO_LIMIT ? 'steady enough to measure' : 'timing changed too much while measuring',
  })
}

/* One sentence a person can act on. No identifiers, no ratio jargon in the
   lead: what happened, then what it means, then what to do. */
export function steadinessSentence(reading) {
  if (!reading || reading.steady === null) {
    return 'This computer\'s steadiness was not measured during this run, so treat any timing result here as unconfirmed.'
  }
  if (reading.steady) return null
  return `This computer's speed changed by about ${reading.ratio} times while the test ran, ` +
    `so a timing result would say more about the computer than about the product. ` +
    `Close other heavy programs and run it again on an otherwise idle machine.`
}

/* Sampled ACROSS a run. See design error 2 above -- a single reading at the
   start cannot see a machine that degrades once the work begins. */
export function createSteadinessTracker({ probe = probeOnce } = {}) {
  const samples = []
  return {
    sample() {
      const ms = probe()
      samples.push(ms)
      return ms
    },
    samples: () => [...samples],
    read: () => steadinessOf(samples),
  }
}

/* The line a driver prints so the suite can classify the run without parsing
   prose. tools/packaged-qa-suite.mjs reads this exact prefix. */
export const UNMEASURABLE_MARK = 'CANNOT MEASURE ON THIS COMPUTER:'

export function unmeasurableLine(reading) {
  return `${UNMEASURABLE_MARK} ${steadinessSentence(reading)} ` +
    `(fixed work ran ${reading.minMs}-${reading.maxMs}ms, middle ${reading.medianMs}ms, over ${reading.count} samples)`
}
