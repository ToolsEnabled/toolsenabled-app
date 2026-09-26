import assert from 'node:assert/strict'
import test from 'node:test'
import startupFailureMessage from '../../shell/startup-failure-message.cjs'

const { startupFailureDetail } = startupFailureMessage
const range = { min: 4601, max: 4609 }

function exhausted(failures, cause) {
  const error = new Error('No shell port is available', cause ? { cause } : undefined)
  error.code = 'SHELL_PORT_RANGE_EXHAUSTED'
  error.host = '127.0.0.1'
  error.ports = Object.freeze([4601, 4602, 4603, 4604, 4605, 4606, 4607, 4608, 4609])
  if (failures !== undefined) error.failures = Object.freeze(failures)
  return error
}

function failure(port, code) {
  return Object.freeze({ port, code, message: `listen ${code} 127.0.0.1:${port}` })
}

test('all EADDRINUSE failures retain the close-shells remedy and raw cause', () => {
  const cause = Object.assign(new Error('listen EADDRINUSE 127.0.0.1:4609'), {
    code: 'EADDRINUSE',
    port: 4609,
  })
  const detail = startupFailureDetail(
    exhausted(Array.from({ length: 9 }, (_, index) => failure(4601 + index, 'EADDRINUSE')), cause),
    range,
  )

  assert.match(detail, /Close them and relaunch\./)
  assert.match(detail, /holding them/)
  assert.match(detail, /listen EADDRINUSE 127\.0\.0\.1:4609/)
})

test('partial EADDRINUSE records do not claim every attempted port is in use', () => {
  const error = exhausted([failure(4601, 'EADDRINUSE')])
  const detail = startupFailureDetail(error, range)

  assert.doesNotMatch(detail, /All shell ports .* are in use/)
  assert.match(detail, /Individual port failure details were not recorded/)
})

test('one EACCES among EADDRINUSE failures reports the refused port and command', () => {
  const cause = Object.assign(new Error('listen EADDRINUSE 127.0.0.1:4609'), {
    code: 'EADDRINUSE',
    port: 4609,
  })
  const failures = [
    failure(4601, 'EACCES'),
    ...Array.from({ length: 8 }, (_, index) => failure(4602 + index, 'EADDRINUSE')),
  ]
  const detail = startupFailureDetail(exhausted(failures, cause), range)

  assert.doesNotMatch(detail, /close/i)
  assert.doesNotMatch(detail, /holding/i)
  assert.match(detail, /EACCES/)
  assert.match(detail, /4601/)
  assert.match(detail, /netsh interface ipv4 show excludedportrange protocol=tcp/)
  assert.match(detail, /listen EADDRINUSE 127\.0\.0\.1:4609/)
})

test('all EACCES failures report the OS-refused branch and raw cause', () => {
  const cause = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:4609'), {
    code: 'EACCES',
    port: 4609,
  })
  const detail = startupFailureDetail(
    exhausted(Array.from({ length: 9 }, (_, index) => failure(4601 + index, 'EACCES')), cause),
    range,
  )

  assert.doesNotMatch(detail, /close/i)
  assert.doesNotMatch(detail, /holding/i)
  assert.match(detail, /operating system refused/)
  assert.match(detail, /EACCES/)
  assert.match(detail, /4601/)
  assert.match(detail, /netsh interface ipv4 show excludedportrange protocol=tcp/)
  assert.match(detail, /listen EACCES: permission denied 127\.0\.0\.1:4609/)
})

test('non-exhausted errors retain String(error) and append their cause', () => {
  const cause = new Error('socket setup failed')
  const error = new TypeError('unexpected startup failure', { cause })
  const detail = startupFailureDetail(error, range)

  assert.ok(detail.startsWith(String(error)))
  assert.match(detail, /socket setup failed/)
})

test('returns a non-empty string for incomplete and legacy error shapes', () => {
  const emptyCause = new Error('empty failures cause')
  const legacyCause = new Error('legacy failures cause')
  const emptyFailures = exhausted([], emptyCause)
  const legacy = exhausted(undefined, legacyCause)
  const plainError = new Error('plain startup error')
  const values = [null, undefined, {}, plainError, emptyFailures, legacy]

  for (const value of values) {
    assert.doesNotThrow(() => startupFailureDetail(value, range))
    assert.equal(typeof startupFailureDetail(value, range), 'string')
    assert.ok(startupFailureDetail(value, range).length > 0)
  }

  assert.equal(startupFailureDetail(plainError, range), String(plainError))
  assert.match(startupFailureDetail(emptyFailures, range), /empty failures cause/)
  assert.match(startupFailureDetail(legacy, range), /legacy failures cause/)
})
