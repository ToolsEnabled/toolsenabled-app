import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CHECKOUT_CATALOG_URL,
  CHECKOUT_SURFACE_EVENT,
  __setCheckoutSurfaceForTest,
  checkoutSurfaceAvailable,
  checkoutSurfaceSettled,
  probeCheckoutSurface,
} from '../../src/checkout-visibility.js'

function jsonResponse() {
  return {
    ok: true,
    headers: { get: name => name === 'content-type' ? 'Application/JSON; charset=utf-8' : null },
  }
}

test('the exported state keeps not-yet-measured separate from unavailable', () => {
  __setCheckoutSurfaceForTest(false, false)
  // Mutation sentinel: inverting checkoutSurfaceAvailable's strict-true check
  // must make this assertion fail before any probe has run.
  assert.equal(checkoutSurfaceAvailable(), false, 'an unmeasured checkout must not be offered')
  assert.equal(checkoutSurfaceSettled(), false, 'an unmeasured checkout must remain distinguishable from a completed refusal')

  __setCheckoutSurfaceForTest(true, true)
  assert.equal(checkoutSurfaceAvailable(), true, 'a measured available checkout must be reported to its callers')
  assert.equal(checkoutSurfaceSettled(), true, 'a completed checkout measurement must be reported as settled')
})

test('a desktop catalogue probe uses the public contract and publishes availability', async () => {
  __setCheckoutSurfaceForTest(false, false)
  const fetchCalls = []
  const events = []
  const dispatch = { dispatchEvent: event => events.push(event) }

  const answer = await probeCheckoutSurface({
    hosted: () => true,
    fetchImpl: async (...args) => {
      fetchCalls.push(args)
      return jsonResponse()
    },
    dispatch,
    timeoutMs: 0,
  })

  assert.equal(answer, true, 'a desktop copy with a JSON catalogue must offer checkout')
  assert.deepEqual(fetchCalls, [[CHECKOUT_CATALOG_URL, { cache: 'no-store' }]], 'the probe must request the exported catalogue URL without using a cached answer')
  assert.equal(checkoutSurfaceAvailable(), true, 'the successful probe must update the availability read by the router and views')
  assert.equal(checkoutSurfaceSettled(), true, 'the successful probe must release callers waiting for measurement')
  assert.equal(events.length, 1, 'a completed probe must publish one visibility event')
  assert.equal(events[0].type, CHECKOUT_SURFACE_EVENT, 'the probe must publish the exported visibility event')
  assert.deepEqual(events[0].detail, { available: true }, 'the visibility event must describe the newly measured answer')
})

test('anything other than confirmed desktop hosting refuses without reading', async () => {
  for (const [description, hosted] of [
    ['false', () => false],
    ['a truthy non-boolean', () => 1],
    ['an exception', () => { throw new Error('bridge unavailable') }],
  ]) {
    __setCheckoutSurfaceForTest(true, false)
    let reads = 0
    const answer = await probeCheckoutSurface({
      hosted,
      fetchImpl: async () => {
        reads += 1
        return jsonResponse()
      },
      dispatch: null,
      timeoutMs: 0,
    })

    assert.equal(reads, 0, `hosting reported ${description}: the public origin must not be asked for the private catalogue`)
    assert.equal(answer, false, `hosting reported ${description}: checkout must remain unavailable`)
    assert.equal(checkoutSurfaceSettled(), true, `hosting reported ${description}: the skipped probe must still finish`)
  }
})

test('could-not-read outcomes never become affirmative checkout answers', async () => {
  const failures = [
    ['no fetch implementation', null],
    ['a rejected read', async () => { throw new Error('offline') }],
    ['a missing response', async () => null],
    ['a non-success response', async () => ({ ok: false, headers: { get: () => 'application/json' } })],
    ['an HTML fallback', async () => ({ ok: true, headers: { get: () => 'text/html' } })],
    ['an unreadable content type', async () => ({ ok: true, headers: { get: () => { throw new Error('bad headers') } } })],
  ]

  for (const [description, fetchImpl] of failures) {
    __setCheckoutSurfaceForTest(true, false)
    const answer = await probeCheckoutSurface({
      hosted: () => true,
      fetchImpl,
      dispatch: null,
      timeoutMs: 0,
    })

    assert.equal(answer, false, `${description} must not be mistaken for an available checkout`)
    assert.equal(checkoutSurfaceAvailable(), false, `${description} must clear any stale affirmative answer`)
    assert.equal(checkoutSurfaceSettled(), true, `${description} must complete the probe without claiming availability`)
  }
})

test('a desktop copy asks its shell first and fetches nothing when the shell answers', async () => {
  for (const available of [false, true]) {
    __setCheckoutSurfaceForTest(false, false)
    const fetchCalls = []
    const events = []
    const answer = await probeCheckoutSurface({
      hosted: () => true,
      ask: async () => ({ ok: true, available }),
      fetchImpl: async (...args) => { fetchCalls.push(args); return jsonResponse() },
      dispatch: { dispatchEvent: event => events.push(event) },
      timeoutMs: 0,
    })
    assert.equal(answer, available)
    assert.deepEqual(fetchCalls, [], 'nothing is requested once the shell has answered: a copy with no list must not log a 404 for a normal state')
    assert.equal(checkoutSurfaceAvailable(), available)
    assert.equal(checkoutSurfaceSettled(), true)
    assert.deepEqual(events.map(event => event.detail), [{ available }])
  }
})

test('a shell that cannot answer, refuses, or answers oddly leaves the fetch as the measurement', async () => {
  const shells = [
    undefined,
    null,
    async () => { throw new Error('no such channel') },
    async () => ({ ok: false, code: 'MC_FLEET_PROFILE_SENDER_REFUSED' }),
    async () => ({ ok: true, available: 'yes' }),
  ]
  for (const ask of shells) {
    __setCheckoutSurfaceForTest(false, false)
    const fetchCalls = []
    const answer = await probeCheckoutSurface({
      hosted: () => true,
      ask,
      fetchImpl: async (...args) => { fetchCalls.push(args); return jsonResponse() },
      dispatch: { dispatchEvent() {} },
      timeoutMs: 0,
    })
    assert.equal(answer, true, String(ask))
    assert.equal(fetchCalls.length, 1, 'the fetch is still the measurement on an older or refusing shell')
  }
})

test('a copy that is not hosted by the shell never asks it either', async () => {
  __setCheckoutSurfaceForTest(false, false)
  let asked = 0
  const answer = await probeCheckoutSurface({
    hosted: () => false,
    ask: async () => { asked += 1; return { ok: true, available: true } },
    fetchImpl: async () => jsonResponse(),
    dispatch: { dispatchEvent() {} },
    timeoutMs: 0,
  })
  assert.equal(answer, false)
  assert.equal(asked, 0)
})
