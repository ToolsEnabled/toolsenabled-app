import test from 'node:test'
import assert from 'node:assert/strict'

import { retryWhileUnavailable } from '../../src/bridge-retry.js'

const instantSleep = recorded => async delay => { recorded.push(delay) }

test('returns immediately when the first probe succeeds', async () => {
  let calls = 0
  const sleeps = []
  const result = await retryWhileUnavailable(async () => {
    calls += 1
    return { ok: true, value: 'ready' }
  }, { attempts: 4, delays: [10, 20, 30], sleep: instantSleep(sleeps) })

  assert.deepEqual(result, { ok: true, value: 'ready' })
  assert.equal(calls, 1)
  assert.deepEqual(sleeps, [])
})

test('retries a failure and returns the second successful probe', async () => {
  let calls = 0
  const sleeps = []
  const result = await retryWhileUnavailable(async () => {
    calls += 1
    return calls === 2 ? { ok: true } : { ok: false, reason: 'starting' }
  }, { attempts: 4, delays: [10, 20, 30], sleep: instantSleep(sleeps) })

  assert.deepEqual(result, { ok: true })
  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [10])
})

test('is bounded and returns the last failure', async () => {
  let calls = 0
  const sleeps = []
  const result = await retryWhileUnavailable(async () => {
    calls += 1
    return { ok: false, reason: `failure ${calls}` }
  }, { attempts: 3, delays: [10, 20], sleep: instantSleep(sleeps) })

  assert.deepEqual(result, { ok: false, reason: 'failure 3' })
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [10, 20])
  assert.notEqual(result.ok, true)
})

test('converts thrown probes to fail-closed results without throwing out', async () => {
  let calls = 0
  const sleeps = []
  const result = await retryWhileUnavailable(async () => {
    calls += 1
    throw new Error(`not ready ${calls}`)
  }, { attempts: 3, delays: [10, 20], sleep: instantSleep(sleeps) })

  assert.equal(result.ok, false)
  assert.match(result.reason, /Error: not ready 3/)
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [10, 20])
  assert.notEqual(result.ok, true)
})

test('default delays increase and remain below the four-second ceiling', async () => {
  const sleeps = []
  await retryWhileUnavailable(async () => ({ ok: false, reason: 'offline' }), {
    sleep: instantSleep(sleeps),
  })

  assert.equal(sleeps.length, 3)
  for (let index = 1; index < sleeps.length; index += 1) {
    assert.ok(sleeps[index] > sleeps[index - 1])
  }
  assert.ok(sleeps.reduce((total, delay) => total + delay, 0) < 4000)
})

test('never synthesizes success for all-fail or all-throw probes', async () => {
  const options = { attempts: 2, delays: [0], sleep: async () => {} }
  const failed = await retryWhileUnavailable(
    async () => ({ ok: false, reason: 'still unavailable' }),
    options,
  )
  const threw = await retryWhileUnavailable(
    async () => { throw new Error('still unavailable') },
    options,
  )

  assert.equal(failed.ok, false)
  assert.equal(threw.ok, false)
})
