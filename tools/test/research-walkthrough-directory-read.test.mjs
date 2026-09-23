import assert from 'node:assert/strict'
import test from 'node:test'

import { walkDirectories } from '../research-walkthrough-qa.mjs'

const directory = name => ({ name, isDirectory: () => true })

test('directory evidence distinguishes absent from could-not-inspect and is never latched', () => {
  const absent = Object.assign(new Error('gone'), { code: 'ENOENT' })
  assert.deepEqual(walkDirectories('/gone', () => { throw absent }), [], 'ENOENT remains the legitimate absent answer')

  let calls = 0
  const busyThenReady = current => {
    calls += 1
    if (calls === 1) throw Object.assign(new Error('descriptor table full'), { code: 'EMFILE' })
    return current === '/artifacts' ? [directory('run-1')] : []
  }
  assert.throws(
    () => walkDirectories('/artifacts', busyThenReady),
    error => error.code === 'DIRECTORY_WALK_UNAVAILABLE'
      && /not claiming .* absent/.test(error.message)
      && error.cause?.code === 'EMFILE',
  )
  assert.deepEqual(walkDirectories('/artifacts', busyThenReady), ['run-1'], 'a transient failure is not cached or latched')
  assert.equal(calls, 3, 'the retry and its child traversal both perform fresh reads')

  assert.throws(
    () => walkDirectories('/artifacts', () => { throw 'busy without a code' }),
    error => error.code === 'DIRECTORY_WALK_UNAVAILABLE' && /not claiming .* absent/.test(error.message),
    'even a non-Error throw is could-not-tell, never absence',
  )
})
