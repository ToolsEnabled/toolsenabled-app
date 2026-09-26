// Unit E: an interval on a printed proportion. Wilson (1927) score interval, which
// Brown, Cai and DasGupta (2001) recommend over the Wald interval. The inverse normal
// CDF is a rational approximation, so its accuracy is checked here against the standard
// quantiles rather than assumed.
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalQuantile, wilsonInterval } from '../../src/benchmark/analysis.mjs'

const close = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`)

test('the inverse normal CDF reproduces the standard quantiles', () => {
  close(normalQuantile(0.975), 1.959963984540054, 1e-8, 'z at 0.975')
  close(normalQuantile(0.995), 2.5758293035489004, 1e-8, 'z at 0.995')
  close(normalQuantile(0.95), 1.6448536269514722, 1e-8, 'z at 0.95')
  close(normalQuantile(0.5), 0, 1e-12, 'z at 0.5')
  // Symmetry, and the far tails the piecewise branches cover.
  close(normalQuantile(0.025), -1.959963984540054, 1e-8, 'z at 0.025')
  close(normalQuantile(0.001), -3.090232306167813, 1e-7, 'z at 0.001')
  close(normalQuantile(0.999), 3.090232306167813, 1e-7, 'z at 0.999')
  for (const bad of [0, 1, -0.1, 1.1, Number.NaN]) assert.equal(normalQuantile(bad), null, String(bad))
})

test('the Wilson score interval reproduces its published values', () => {
  // Textbook 95 per cent values for k of 10.
  const zero = wilsonInterval(0, 10, 0.95)
  close(zero.low, 0, 1e-12, '0/10 low'); close(zero.high, 0.2775, 1e-4, '0/10 high')
  const half = wilsonInterval(5, 10, 0.95)
  close(half.low, 0.2366, 1e-4, '5/10 low'); close(half.high, 0.7634, 1e-4, '5/10 high')
  const all = wilsonInterval(10, 10, 0.95)
  close(all.low, 0.7225, 1e-4, '10/10 low'); close(all.high, 1, 1e-12, '10/10 high')
  assert.equal(half.kind, 'Wilson score interval')
  assert.deepEqual([half.successes, half.trials, half.confidence], [5, 10, 0.95])
})

test('the interval cannot leave the unit range, and does not collapse at the boundary', () => {
  for (const trials of [1, 2, 5, 10, 100, 1000]) {
    for (const successes of [0, trials]) {
      const interval = wilsonInterval(successes, trials, 0.95)
      assert.ok(interval.low >= 0 && interval.high <= 1, `${successes}/${trials} left the unit range`)
      // The Wald interval is exactly [p, p] here, which is the failure Wilson is chosen to avoid.
      assert.ok(interval.high - interval.low > 0, `${successes}/${trials} collapsed to a point`)
      assert.ok(interval.low <= successes / trials && successes / trials <= interval.high, `${successes}/${trials} excludes its own estimate`)
    }
  }
})

test('a higher confidence gives a wider interval, and more trials a narrower one', () => {
  const width = interval => interval.high - interval.low
  assert.ok(width(wilsonInterval(5, 10, 0.99)) > width(wilsonInterval(5, 10, 0.95)))
  assert.ok(width(wilsonInterval(50, 100, 0.95)) < width(wilsonInterval(5, 10, 0.95)))
})

test('an interval is refused rather than invented where it has no meaning', () => {
  assert.equal(wilsonInterval(0, 0, 0.95), null, 'no trials')
  assert.equal(wilsonInterval(3, 2, 0.95), null, 'more successes than trials')
  assert.equal(wilsonInterval(-1, 10, 0.95), null, 'negative successes')
  assert.equal(wilsonInterval(1.5, 10, 0.95), null, 'fractional successes')
  assert.equal(wilsonInterval(5, 10, 1), null, 'confidence of one')
  assert.equal(wilsonInterval(5, 10, 0), null, 'confidence of zero')
})
