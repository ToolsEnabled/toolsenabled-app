import test from 'node:test'
import assert from 'node:assert/strict'
import { runMemoryFixtures } from '../lib/surface-tests/memory.mjs'
import { buildPlan } from '../lib/surface-tests/plan.mjs'
import { parseOptions } from '../lib/surface-tests/options.mjs'

const root = '/canonical/engine'
const out = '/canonical/out'
const executable = '/usr/bin/node'
const options = parseOptions(['run', '--engine', root, '--out', out, '--fixture-cleanup', 'refuse', '--profile', 'smoke', '--only', 'fra-identity'])
const job = buildPlan(options, '/canonical/app')[0]
const proof = { kind: 'reconciled-tap', counts: { tests: 1, pass: 1, fail: 0 }, unexecuted: 0 }
const result = { status: 0, cleanupConfirmed: true, stdout: 'out', stderr: '', custody: 'owned' }

test('memory plan selects inert FRA files without wrappers or cleanup approval', () => {
  assert.equal(job.strategy, 'inert-files')
  assert.equal(job.fixtureCleanup, false)
  assert.deepEqual(job.args, [])
  assert.deepEqual(job.files, ['tests/online-fra-device-claim.js', 'tests/online-fra-e2e-session.js'])
})

test('runs each memory file with exact one-file argument vectors and records summaries', async () => {
  const calls = []
  const got = await runMemoryFixtures(job, {
    executable, env: { TEST: 'inert' }, timeout: 1000,
    runChild: async (...args) => { calls.push(args); return { ...result } },
    validateCompletion: () => proof,
  })
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [[executable, [job.files[0]]], [executable, [job.files[1]]]])
  assert.deepEqual(got.commands, job.files.map(file => [executable, file]))
  assert.deepEqual(got.summary.files.map(file => file.status), ['pass', 'pass'])
  assert.equal(got.result.status, 0)
})

test('timeout leaves remaining files not-run and does not claim pass', async () => {
  let clock = 0
  const got = await runMemoryFixtures(job, {
    executable, env: {}, timeout: 10, now: () => clock,
    runChild: async () => { clock = 20; return { ...result } }, validateCompletion: () => proof,
  })
  assert.equal(got.summary.files[0].status, 'pass')
  assert.equal(got.summary.files[1].status, 'not-run')
  assert.equal(got.result.status, 1)
})

test('failed cleanup stops subsequent memory files and reports failure', async () => {
  let calls = 0
  const got = await runMemoryFixtures(job, {
    executable, env: {}, timeout: 1000,
    runChild: async () => { calls++; return { ...result, cleanupConfirmed: false } }, validateCompletion: () => proof,
  })
  assert.equal(calls, 1)
  assert.deepEqual(got.summary.files.map(file => file.status), ['fail', 'not-run'])
  assert.equal(got.result.cleanupConfirmed, false)
  assert.equal(got.result.status, 1)
})

test('false TAP evidence fails and thrown child errors are not swallowed', async () => {
  const failed = await runMemoryFixtures(job, {
    executable, env: {}, timeout: 1000, runChild: async () => ({ ...result }),
    validateCompletion: () => ({ ...proof, unexecuted: 1 }),
  })
  assert.equal(failed.result.status, 1)
  assert.deepEqual(failed.summary.files.map(file => file.status), ['fail', 'fail'])
  await assert.rejects(() => runMemoryFixtures(job, {
    executable, env: {}, timeout: 1000, runChild: async () => { throw new Error('child exploded') },
    validateCompletion: () => proof,
  }), /child exploded/)
})
