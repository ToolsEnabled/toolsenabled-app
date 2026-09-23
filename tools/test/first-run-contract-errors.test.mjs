import test from 'node:test'
import assert from 'node:assert/strict'

import { availabilityReasons, ownerNameNeedles } from '../first-run-contract-qa.mjs'

test('owner-name lookup separates absent from could-not-tell and never latches the latter', () => {
  const absent = Object.assign(new Error('gone'), { code: 'ENOENT' })
  assert.deepEqual(ownerNameNeedles(() => { throw absent }), [],
    'CONTROL: ENOENT remains the one legitimate absent answer')

  let reads = 0
  const busyThenReadable = () => {
    reads += 1
    if (reads === 1) throw Object.assign(new Error('device busy'), { code: 'EBUSY' })
    return "const forbidden = ['Pinckard']"
  }

  assert.throws(
    () => ownerNameNeedles(busyThenReadable),
    error => error?.code === 'OWNER_NAME_NEEDLES_UNREADABLE'
      && /NOT claiming .* absent/.test(error.message),
    'EBUSY must be NO VERDICT with an explicit non-absence sentence')
  assert.deepEqual(ownerNameNeedles(busyThenReadable), ['Pinckard'],
    'the could-not-tell result must not be cached or latched')
  assert.equal(reads, 2)

  assert.throws(
    () => ownerNameNeedles(() => { throw 'opaque failure' }),
    error => error?.code === 'OWNER_NAME_NEEDLES_UNREADABLE',
    'a non-Error throw with no code is also could-not-tell, never absent')
})

test('availability-copy lookup separates missing from could-not-tell and does not latch failure', async () => {
  const missing = Object.assign(new Error('module is absent'), { code: 'ERR_MODULE_NOT_FOUND' })
  assert.deepEqual(
    await availabilityReasons(async () => { throw missing }),
    { reasons: [], copyLoadError: 'module is absent' },
    'CONTROL: ERR_MODULE_NOT_FOUND remains the definite missing-module answer')

  let loads = 0
  const busyThenReadable = async () => {
    loads += 1
    if (loads === 1) throw Object.assign(new Error('I/O unavailable'), { code: 'EIO' })
    return { UNAVAILABLE_TEXT: { signedOut: 'Sign in first.' } }
  }
  await assert.rejects(
    availabilityReasons(busyThenReadable),
    error => error?.code === 'AVAILABILITY_COPY_UNREADABLE'
      && /NOT claiming .* absent/.test(error.message))
  assert.deepEqual(await availabilityReasons(busyThenReadable), {
    reasons: ['Sign in first.'],
    copyLoadError: '',
  }, 'the failed load must not prevent a later retry')
  assert.equal(loads, 2)
})
