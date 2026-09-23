/* The guard that decides whether a timing driver is allowed to blame the
 * product. It has to be right in both directions: a computer that is merely
 * SLOW must still be measured (budgets are proportional), and a computer that
 * CHANGES SPEED mid-run must not be, because nothing measured there means
 * anything. The decision is pure so both directions can be tested without
 * needing a busy machine. */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MIN_SAMPLES, STEADY_RATIO_LIMIT, UNMEASURABLE_MARK, createSteadinessTracker,
  probeOnce, steadinessOf, steadinessSentence, unmeasurableLine,
} from '../machine-steadiness.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('1. a steady computer is measured, even when it is a slow one', () => {
  /* Every sample ten times the cost of a fast machine, but CONSISTENT. A
     proportionally slow computer can still hold a proportional budget, so
     refusing here would take a working instrument away from anyone on modest
     hardware -- which is most of the people this product ships to. */
  const slowButSteady = [4000, 4200, 4100, 4300, 4050, 4150, 4250]
  const reading = steadinessOf(slowButSteady)
  assert.equal(reading.steady, true, 'consistent-but-slow must remain measurable')
  assert.equal(steadinessSentence(reading), null, 'a steady reading says nothing; only trouble speaks')
})

test('2. a computer that changes speed mid-run is refused, with its numbers', () => {
  /* The measured shape from 2026-08-16: several fast passes, then a state
     change to multi-second passes that never recovers. */
  const degrading = [382, 430, 440, 448, 410, 466, 2731, 2299, 1263, 3079, 2829, 3179]
  const reading = steadinessOf(degrading)
  assert.equal(reading.steady, false)
  assert.ok(reading.ratio > STEADY_RATIO_LIMIT, `ratio ${reading.ratio} must exceed the limit`)
  assert.equal(reading.medianMs, 1263)
  assert.equal(reading.minMs, 382)
  assert.equal(reading.maxMs, 3179)

  const sentence = steadinessSentence(reading)
  assert.match(sentence, /run it again/, 'a refusal must end with something the person can do')
  assert.doesNotMatch(sentence, /ratio|p50|scrypt|ENOENT/, 'the sentence is for a person, not a log parser')
})

test('3. too few samples is "not measured", which is not the same as "steady"', () => {
  /* The dangerous failure is a FALSE ALL-CLEAR. A run that collected two
     samples must never come back saying the machine was fine. */
  const reading = steadinessOf([400, 420])
  assert.equal(reading.steady, null, 'unknown must not collapse into true')
  assert.equal(reading.count, 2)
  assert.match(steadinessSentence(reading), /unconfirmed/)

  for (const junk of [[], null, undefined, ['x', NaN, -1, 0]]) {
    assert.equal(steadinessOf(junk).steady, null, `junk input must be unknown, not steady: ${JSON.stringify(junk)}`)
  }
})

test('4. exactly at the limit is measurable; past it is not', () => {
  const atLimit = Array(MIN_SAMPLES).fill(100)
  atLimit[atLimit.length - 1] = 100 * STEADY_RATIO_LIMIT
  assert.equal(steadinessOf(atLimit).steady, true, 'the boundary itself is still measurable')

  const pastLimit = Array(MIN_SAMPLES).fill(100)
  pastLimit[pastLimit.length - 1] = 100 * STEADY_RATIO_LIMIT + 1
  assert.equal(steadinessOf(pastLimit).steady, false)
})

test('5. the tracker samples across a run rather than once at the start', () => {
  /* DESIGN ERROR 2, pinned. The degradation is a state change that sustained
     load causes, so a single pre-flight reading sees a cool machine and then
     the measurement does the heating. If this ever regresses to one reading,
     the guard becomes a false all-clear -- the worst outcome available. */
  const scripted = [380, 390, 400, 3000, 3100, 3200]
  let i = 0
  const tracker = createSteadinessTracker({ probe: () => scripted[i++] })
  for (let n = 0; n < scripted.length; n += 1) tracker.sample()

  assert.equal(i, scripted.length,
    'each requested sample must invoke the probe so a mid-run speed change is observed')
  assert.deepEqual(tracker.samples(), scripted)
  assert.equal(tracker.read().steady, false, 'a run that degrades halfway through must be refused')

  /* And the same machine judged only on its first three passes looks fine --
     which is exactly the mistake. */
  assert.equal(steadinessOf(scripted.slice(0, 3)).steady, null)
})

test('6. the machine-unmeasurable line is greppable and carries the evidence', () => {
  const reading = steadinessOf([382, 430, 440, 448, 410, 466, 2731, 3179])
  const line = unmeasurableLine(reading)
  assert.ok(line.startsWith(UNMEASURABLE_MARK), 'the suite classifies on this exact prefix')
  assert.match(line, /382-3179ms/, 'the numbers travel with the refusal so nobody has to take it on trust')
  assert.match(line, /8 samples/)
})

test('7. the probe is real work whose cost cannot vary with this disk', () => {
  /* If the probe could be affected by file IO or by another lane touching the
     tree, a slow sample would no longer mean "the machine". */
  const first = probeOnce()
  assert.ok(Number.isFinite(first) && first > 0, `the probe must return a positive duration, got ${first}`)
  const source = readFileSync(path.join(REPO_ROOT, 'tools', 'machine-steadiness.mjs'), 'utf8')
  assert.doesNotMatch(source, /readFileSync|writeFileSync|node:fs/,
    'the probe must not touch the filesystem, or a slow sample stops meaning the machine')
})
