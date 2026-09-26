import assert from 'node:assert/strict'
import test from 'node:test'

import { claudeProcesses, fileIsAbsent } from '../owner-walkthrough-drive.mjs'

test('Claude process lookup separates absence from could-not-tell and never caches either', () => {
  let calls = 0
  const replies = [
    { status: 0, stdout: '' },
    { status: null, stdout: '', error: Object.assign(new Error('busy'), { code: 'EAGAIN' }) },
    { status: 0, stdout: '{not json' },
    { status: 0, stdout: '{"ProcessId":42,"Name":"claude.exe"}' },
  ]
  const spawn = () => {
    calls += 1
    return replies.shift()
  }

  // CONTROL: a successful empty query is the one legitimate absent answer.
  assert.deepEqual(claudeProcesses(spawn), [])
  assert.throws(
    () => claudeProcesses(spawn),
    error => error.code === 'CLAUDE_PROCESS_LOOKUP_COULD_NOT_TELL'
      && /not claiming that none exist/.test(error.message),
  )
  assert.throws(
    () => claudeProcesses(spawn),
    error => error.code === 'CLAUDE_PROCESS_LOOKUP_COULD_NOT_TELL'
      && /not claiming that none exist/.test(error.message),
  )
  assert.deepEqual(claudeProcesses(spawn), [{ ProcessId: 42, Name: 'claude.exe' }])
  assert.equal(calls, 4, 'every observation must run a fresh process query')
})

test('Claude credential lookup reserves absent for ENOENT and does not cache uncertainty', () => {
  let calls = 0
  const stat = () => {
    calls += 1
    if (calls === 1) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    if (calls === 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    return { isFile: () => true }
  }

  // CONTROL: ENOENT remains the one legitimate absent result.
  assert.equal(fileIsAbsent('credential', stat), true)
  assert.throws(
    () => fileIsAbsent('credential', stat),
    error => error.code === 'CLAUDE_SIGN_IN_LOOKUP_COULD_NOT_TELL'
      && /not claiming that it is absent/.test(error.message),
  )
  assert.equal(fileIsAbsent('credential', stat), false)
  assert.equal(calls, 3, 'a could-not-tell result must not be cached or latched')
})
