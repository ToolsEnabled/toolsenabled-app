import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withDeadline } from '../../src/read-deadline.js'

function fakeClock() {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const scheduled = []
  const cleared = []

  globalThis.setTimeout = (callback, ms) => {
    const handle = { callback, ms }
    scheduled.push(handle)
    return handle
  }
  globalThis.clearTimeout = handle => { cleared.push(handle) }

  return {
    scheduled,
    cleared,
    restore() {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    },
  }
}

test('a purchase-list answer is returned unchanged and retires its deadline', async () => {
  const clock = fakeClock()
  try {
    const answer = { ok: true, prompts: [{ id: 'purchase-1' }] }
    const received = await withDeadline(Promise.resolve(answer), 8_000, 'your purchase list')

    assert.strictEqual(received, answer,
      'a successful read must return the caller\'s answer, not a substitute')
    assert.equal(clock.scheduled[0]?.ms, 8_000,
      'the timer must use the whole budget passed by the caller')
    assert.deepEqual(clock.cleared, clock.scheduled,
      'a read that answers must clear its deadline timer')
  } finally {
    clock.restore()
  }
})

test('a could-not-read rejection remains a rejection with its original reason', async () => {
  const clock = fakeClock()
  try {
    const couldNotRead = new Error('capability layer could not read the queue')
    await assert.rejects(
      withDeadline(Promise.reject(couldNotRead), 8_000, 'your purchase list'),
      error => error === couldNotRead,
      'a failed read must preserve its rejection rather than collapse into an answer',
    )
    assert.deepEqual(clock.cleared, clock.scheduled,
      'a failed read must clear its deadline timer')
  } finally {
    clock.restore()
  }
})

test('an unanswered read is refused with an actionable identity and budget', async () => {
  const clock = fakeClock()
  try {
    const bounded = withDeadline(new Promise(() => {}), 8_000, 'your purchase list')
    const refusal = assert.rejects(
      bounded,
      error => error instanceof Error
        && /purchase list/i.test(error.message)
        && /answer/i.test(error.message)
        && /8000\s*ms/i.test(error.message),
      'a deadline refusal must say which read did not answer and name its budget',
    )

    clock.scheduled[0].callback()
    await refusal
  } finally {
    clock.restore()
  }
})

test('the default refusal still identifies a read without inventing success', async () => {
  const clock = fakeClock()
  try {
    const bounded = withDeadline(new Promise(() => {}), 25)
    const refusal = assert.rejects(
      bounded,
      error => error instanceof Error
        && /read/i.test(error.message)
        && /did not answer/i.test(error.message),
      'the default deadline refusal must identify an unanswered read',
    )
    clock.scheduled[0].callback()
    await refusal
  } finally {
    clock.restore()
  }
})

test('invalid budgets are programming errors, not immediate read refusals', () => {
  for (const budget of [0, -1, NaN, Infinity, -Infinity, undefined, null, '8000']) {
    assert.throws(
      () => withDeadline(Promise.resolve({ ok: true }), budget),
      error => error instanceof TypeError && /positive/i.test(error.message),
      `invalid budget ${String(budget)} must be rejected as a positive-budget programming error`,
    )
  }
})
