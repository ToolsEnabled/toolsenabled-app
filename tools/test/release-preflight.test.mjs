import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyExit, overallVerdict, runCheck } from '../installer-preflight.mjs'

test('preflight result taxonomy never turns an unperformed check green', () => {
  assert.equal(classifyExit({ status: 0 }), 'PASS')
  assert.equal(classifyExit({ status: 1, output: 'the protected assertion failed' }), 'FAIL')
  assert.equal(classifyExit({ status: 2 }), 'COULD-NOT-CHECK')
  assert.equal(classifyExit({ status: null, error: new Error('spawn failed') }), 'COULD-NOT-CHECK')
  assert.equal(classifyExit({ status: 1, output: 'Artifact seal VERIFY COULD NOT RUN' }), 'COULD-NOT-CHECK')
})

test('one failing underlying command makes the named preflight check fail', () => {
  const check = runCheck({ name: 'Mutation sentinel', command: ['unused'], requires: [] }, {
    runner: () => ({ status: 1, stdout: '', stderr: 'mutated invariant failed' }),
  })
  assert.equal(check.name, 'Mutation sentinel')
  assert.equal(check.result, 'FAIL')
  assert.match(check.output, /mutated invariant failed/u)
  assert.deepEqual(overallVerdict([check]), { result: 'FAIL', exitCode: 1 })
})

test('an unavailable check makes an otherwise green preflight indeterminate', () => {
  const results = [
    { result: 'PASS' },
    { result: 'COULD-NOT-CHECK' },
  ]
  assert.deepEqual(overallVerdict(results), { result: 'COULD-NOT-CHECK', exitCode: 2 })
})

test('a runner exception is a named could-not-check result, never a crash or pass', () => {
  const check = runCheck({ name: 'Unavailable runner', command: ['unused'], requires: [] }, {
    runner: () => { throw new Error('runner exploded') },
  })
  assert.equal(check.name, 'Unavailable runner')
  assert.equal(check.result, 'COULD-NOT-CHECK')
  assert.match(check.output, /runner exploded/u)
})

test('failures take the overall red verdict while unavailable checks stay named', () => {
  const results = [
    { result: 'FAIL' },
    { result: 'COULD-NOT-CHECK' },
  ]
  assert.deepEqual(overallVerdict(results), { result: 'FAIL', exitCode: 1 })
})
