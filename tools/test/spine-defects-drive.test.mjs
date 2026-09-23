import assert from 'node:assert/strict'
import test from 'node:test'

import { claudeChildOf, processTable, readRecordedCwd } from '../spine-defects-drive.mjs'

test('busy process and ledger reads are not reported as definite absence', () => {
  for (const error of [Object.assign(new Error('busy'), { code: 'EBUSY' }), 'not an Error']) {
    const result = processTable(() => { throw error })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'PROCESS_TABLE_COULD_NOT_TELL')
    assert.match(result.error.message, /NOT claiming/)
  }

  const timedOut = claudeChildOf(42, () => ({ status: null, stdout: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }))
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.error.code, 'PROCESS_TABLE_COULD_NOT_TELL')

  const unreadable = readRecordedCwd('ledger', () => { throw Object.assign(new Error('I/O'), { code: 'EIO' }) })
  assert.equal(unreadable.ok, false)
  assert.equal(unreadable.error.code, 'SPAWN_LEDGER_COULD_NOT_TELL')
  assert.match(unreadable.error.message, /NOT claiming/)

  // CONTROL: successful empty results and the one genuinely absent file remain
  // definite absence. Calls are deliberately repeated to prove failures are not latched.
  let calls = 0
  const empty = () => { calls += 1; return { status: 0, stdout: '[]' } }
  assert.deepEqual(claudeChildOf(42, empty), { ok: true, children: [] })
  assert.deepEqual(claudeChildOf(42, empty), { ok: true, children: [] })
  assert.equal(calls, 2)
  assert.deepEqual(readRecordedCwd('missing', () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }), { ok: true, cwd: null })
})
