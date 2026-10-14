/* The runtime readout, which used to be readable as a time of day.
 *
 * `19:29:53` under the word RUNTIME is an elapsed duration, and it is also a
 * perfectly good reading of half past seven in the evening. The page made that
 * worse than ambiguous: components.js renders per-segment unit captions, and
 * styles.css `.uring.compact .uring-digits .u { display: none }` hides them on
 * any ring under 240px -- which is every ring size this page ships. So the one
 * readout that carried its own units had them stripped at every window size.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { durationLabel, durationSpoken, runtimePhrase, NO_RUNTIME } from '../../src/runtime-duration.js'

const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR

test('a duration can never be read as a clock time', () => {
  /* The exact figures from the owner's screenshot, which is the point. */
  assert.equal(durationLabel(19 * HOUR + 29 * MINUTE + 53 * SECOND), '19h 29m 53s')
  assert.equal(durationLabel(16 * HOUR + 27 * MINUTE + 58 * SECOND), '16h 27m 58s')
  assert.equal(durationLabel(11 * HOUR + 45 * MINUTE + 26 * SECOND), '11h 45m 26s')
  assert.equal(durationLabel(34 * SECOND), '34s')

  for (const ms of [0, 34 * SECOND, 90 * SECOND, 19 * HOUR + 29 * MINUTE, 3 * DAY + 4 * HOUR]) {
    const label = durationLabel(ms)
    assert.equal(/^\d+:\d\d/.test(label), false, `${label} is still colon-shaped`)
    assert.match(label, /[dhms]/, `${label} carries no unit`)
  }
})

test('leading units are dropped and trailing ones are padded', () => {
  assert.equal(durationLabel(0), '0s')
  assert.equal(durationLabel(9 * SECOND), '9s', 'a nine-second session must not look like nine hours')
  assert.equal(durationLabel(MINUTE + 5 * SECOND), '1m 05s')
  assert.equal(durationLabel(HOUR + 2 * MINUTE + 3 * SECOND), '1h 02m 03s')
})

test('past a day the seconds stop being information', () => {
  assert.equal(durationLabel(3 * DAY + 4 * HOUR + 9 * MINUTE + 12 * SECOND), '3d 4h 09m')
  assert.equal(/s$/.test(durationLabel(3 * DAY)), false)
})

test('a value that is not a duration produces no label at all', () => {
  for (const bad of [null, undefined, NaN, Infinity, -1, '5000', {}]) {
    assert.equal(durationLabel(bad), null, `${String(bad)} must not render as a duration`)
    assert.equal(runtimePhrase({ elapsedMs: bad, running: true }), null)
  }
  assert.equal(NO_RUNTIME, 'no runtime reported')
})

test('the verb carries whether the clock is still moving, so greyscale loses nothing', () => {
  assert.equal(runtimePhrase({ elapsedMs: HOUR, running: true }), 'running for 1h 00m 00s')
  assert.equal(runtimePhrase({ elapsedMs: HOUR, running: false }), 'ran for 1h 00m 00s')
})

test('the spoken form spells its units out', () => {
  assert.equal(durationSpoken(HOUR + MINUTE + SECOND), '1 hour 1 minute 1 second')
  assert.equal(durationSpoken(2 * HOUR + 30 * MINUTE), '2 hours 30 minutes')
  assert.equal(durationSpoken(0), '0 seconds')
  assert.equal(/[0-9]h\b/.test(durationSpoken(5 * HOUR)), false, 'a screen reader gets words, not "h"')
})
