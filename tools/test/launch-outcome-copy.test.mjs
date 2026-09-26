/* THE PANEL MUST SAY WHAT BECAME OF THE JOB, AND SAY IT TRUTHFULLY.
 *
 * Before this, handing work to an assistant produced one sentence -- "Handed
 * over ... The assistant is starting on it now" -- and that sentence was the
 * panel's last word for ever. Driving the installed 1.0.17 on 2026-08-16: a
 * Claude assistant started, did the work, replied, and the line never moved. A
 * person could not tell a finished job from a failed one from one that never
 * started.
 *
 * Both halves are tested here without a browser and without a clock, because
 * both are pure: the sentence chosen for a state, and the loop that decides when
 * to stop asking.
 *
 * THE ASSERTION THAT MATTERS MOST IS THE NEGATIVE ONE. Two states mean "nobody
 * wrote down how this ended" and one means "this computer never heard of the
 * job". None of the three is a failed assistant, and reporting them as one would
 * be the product inventing an outcome -- the exact class of lie the audited
 * ledger exists to prevent.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { launchOutcomeCopy, watchLaunchOutcome } from '../../src/launch-outcome-copy.js'

/* ---------------------------------------------------------------
   1 · the sentence for each state
   --------------------------------------------------------------- */

test('a finished job says so, and says where it was written down', () => {
  const copy = launchOutcomeCopy({ state: 'completed' })
  assert.equal(copy.kind, 'confirmed')
  assert.match(copy.text, /Finished/)
  assert.doesNotMatch(copy.text, /starting on it now/, 'the old never-changing sentence survived')
})

test('a job that stopped without finishing says what to do next', () => {
  const copy = launchOutcomeCopy({ state: 'failed' })
  assert.equal(copy.kind, 'refused')
  assert.match(copy.text, /report|hand the job over again/i, 'a failure with no next act is a dead end')
})

test('the two do-not-know answers are never reported as a failed assistant', () => {
  const stale = launchOutcomeCopy({ state: 'stale' })
  const unrecorded = launchOutcomeCopy({ state: 'unrecorded' })
  for (const [name, copy] of [['stale', stale], ['unrecorded', unrecorded]]) {
    assert.doesNotMatch(copy.text, /\bfailed\b|\bstopped without finishing\b/i,
      `${name} claims the assistant failed, which is not what it means`)
    assert.match(copy.text, /open|hand/i, `${name} leaves the reader with nothing to do`)
  }
  assert.notEqual(stale.text, unrecorded.text,
    'the two send a person to different places and must not share one sentence')
})

test('a running job reads as running, not as finished', () => {
  const copy = launchOutcomeCopy({ state: 'running' })
  assert.equal(copy.kind, 'pending')
  assert.match(copy.text, /working on it now/)
})

test('a state this screen was never taught says so rather than guessing', () => {
  for (const receipt of [null, undefined, {}, { state: 'something-new' }, { state: 7 }]) {
    const copy = launchOutcomeCopy(receipt)
    assert.equal(copy.kind, 'pending', 'an unknown state was reported as a settled outcome')
    assert.doesNotMatch(copy.text, /Finished/, 'an unknown state was reported as finished')
    assert.match(copy.text, /check|open/i, 'an unknown state left the reader with nothing to do')
  }
})

test('every sentence is one a person can read', () => {
  for (const state of ['completed', 'failed', 'stale', 'unrecorded', 'running', 'unknown']) {
    const { text } = launchOutcomeCopy({ state })
    assert.ok(text.split(/\s+/).length <= 25, `"${text}" is longer than the readability gate allows`)
    assert.doesNotMatch(text, /launch|receipt|terminal|payload|projection/i,
      `"${text}" names a mechanism the reader has never been shown`)
  }
})

/* ---------------------------------------------------------------
   2 · the loop that decides when to stop asking
   --------------------------------------------------------------- */

function fakeClock() {
  const waits = []
  return { waits, sleep: async ms => { waits.push(ms) } }
}

test('it stops asking the moment the job is no longer running', async () => {
  const clock = fakeClock()
  const answers = ['running', 'running', 'completed', 'completed']
  let asked = 0
  const seen = []
  await watchLaunchOutcome({
    launchId: 'launch_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ask: async () => ({ ok: true, receipt: { state: answers[asked++] } }),
    onOutcome: receipt => seen.push(receipt.state),
    sleep: clock.sleep,
    intervalMs: 1_000,
    capMs: 60_000,
  })
  assert.equal(asked, 3, 'it kept asking after the job had already finished')
  assert.deepEqual(seen, ['completed'], 'the outcome was reported once, and only when it was known')
})

test('a dropped connection is not a failed job, so it keeps asking', async () => {
  const clock = fakeClock()
  let asked = 0
  const seen = []
  await watchLaunchOutcome({
    launchId: 'launch_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ask: async () => {
      asked += 1
      if (asked < 3) throw new Error('the connection dropped')
      return { ok: true, receipt: { state: 'completed' } }
    },
    onOutcome: receipt => seen.push(receipt.state),
    sleep: clock.sleep,
    intervalMs: 1_000,
    capMs: 60_000,
  })
  assert.deepEqual(seen, ['completed'], 'a dropped connection was mistaken for the job ending')
})

test('an unreadable status never becomes a claim that the launch record is absent', async () => {
  for (const thrown of [
    Object.assign(new Error('too many open files'), { code: 'EMFILE' }),
    Object.assign(new Error('try again'), { code: 'EAGAIN' }),
    Object.assign(new Error('input/output error'), { code: 'EIO' }),
    Object.assign(new Error('resource busy'), { code: 'EBUSY' }),
    Object.assign(new Error('child timed out'), { code: 'ETIMEDOUT' }),
    'non-Error throw with no code',
  ]) {
    const seen = []
    const result = await watchLaunchOutcome({
      launchId: 'launch_busy_machine',
      ask: async () => { throw thrown },
      onOutcome: receipt => seen.push(receipt),
      sleep: async () => {},
      intervalMs: 1,
      maxMs: 0,
    })
    assert.equal(result.code, 'LAUNCH_STATUS_UNAVAILABLE')
    assert.deepEqual(seen, [result])
    const copy = launchOutcomeCopy(result)
    assert.equal(copy.kind, 'pending', 'a failed check was presented as a settled fact')
    assert.match(copy.text, /could not check/i)
    assert.match(copy.text, /does not mean .* absent/i)
    assert.doesNotMatch(copy.text, /has no record/i)
  }

  /* CONTROL: a real running receipt remains the last-known value when polling
     reaches its ordinary ceiling. Removing lastKnown would pass the error
     assertions above while reinstating needless status loss. */
  const known = []
  await watchLaunchOutcome({
    launchId: 'launch_known_running',
    ask: async () => ({ ok: true, receipt: { state: 'running', sequence: 7 } }),
    onOutcome: receipt => known.push(receipt),
    sleep: async () => {},
    intervalMs: 1,
    maxMs: 0,
  })
  assert.deepEqual(known, [{ state: 'running', sequence: 7 }], 'the legitimate last-known receipt was not retained')
})

test('a job that never settles gives up at its own time limit rather than asking for ever', async () => {
  const clock = fakeClock()
  const seen = []
  await watchLaunchOutcome({
    launchId: 'launch_cccccccccccccccccccccccccccccccc',
    ask: async () => ({ ok: true, receipt: { state: 'running' } }),
    onOutcome: receipt => seen.push(receipt.state),
    sleep: clock.sleep,
    intervalMs: 1_000,
    capMs: 5_000,
  })
  assert.equal(clock.waits.length, 7, 'the loop ran past the job time limit plus one interval')
  assert.deepEqual(seen, ['running'], 'giving up reported the last state it actually saw')
})

test('when the panel says stop, it stops and reports nothing', async () => {
  const clock = fakeClock()
  const seen = []
  let asked = 0
  await watchLaunchOutcome({
    launchId: 'launch_dddddddddddddddddddddddddddddddd',
    ask: () => { asked += 1; return asked >= 2 ? false : { ok: true, receipt: { state: 'running' } } },
    onOutcome: receipt => seen.push(receipt.state),
    sleep: clock.sleep,
    intervalMs: 1_000,
    capMs: 60_000,
  })
  assert.equal(asked, 2, 'it kept asking after being told to stop')
  assert.deepEqual(seen, [], 'a panel that is gone was still written to')
})
