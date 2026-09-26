import assert from 'node:assert/strict'
import test from 'node:test'

import { widestDisplay } from '../window-size-sweep-qa.mjs'

test('display enumeration distinguishes an empty answer from a busy machine without latching either', () => {
  let calls = 0
  const busyThenReady = () => {
    calls += 1
    if (calls === 1) throw Object.assign(new Error('resources temporarily unavailable'), { code: 'EBUSY' })
    return '10,20,1920,1080\n'
  }

  assert.throws(
    () => widestDisplay(busyThenReady),
    error => error.code === 'DISPLAY_ENUMERATION_UNAVAILABLE'
      && /EBUSY/.test(error.message)
      && /NOT claiming that no display exists/.test(error.message),
  )
  assert.deepEqual(widestDisplay(busyThenReady), { x: 10, y: 20, w: 1920, h: 1080 })
  assert.equal(calls, 2, 'a could-not-tell result must not be cached or latched')

  let emptyCalls = 0
  const emptyAnswer = () => { emptyCalls += 1; return '' }
  assert.equal(widestDisplay(emptyAnswer), null, 'a successful empty screen list remains the absent answer')
  assert.equal(widestDisplay(emptyAnswer), null)
  assert.equal(emptyCalls, 2, 'the probe has never cached even legitimate answers')
})
