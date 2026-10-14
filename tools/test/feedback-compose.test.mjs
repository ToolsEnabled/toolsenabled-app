import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FEEDBACK_COPY, FEEDBACK_ENDPOINT, MAX_MESSAGE_CHARACTERS,
  composeFeedback, probeFeedbackAvailable, submitFeedback,
} from '../../src/feedback-compose.js'

/* WHAT A PERSON SENDS US WHEN SOMETHING IS WRONG, AND WHERE IT GOES NOW.
 *
 * This used to build a mailto: and hand it to the person's own mail client.
 * It now POSTs to /v1/feedback on the account service, per the owner's own
 * ruling that the mailto version must never ship (S6 lane). The tests that
 * matter have shifted with it:
 *
 *   - composeFeedback still validates first, exactly as before -- a
 *     refused message must never reach the network.
 *   - probeFeedbackAvailable is what the "?" door's render gates on, and it
 *     is two-valued by design: only a confirmed `available: true` counts,
 *     everything else -- a false, a malformed reply, a thrown fetch -- is
 *     `false`. There is no third "could not check" value here, unlike
 *     src/capability-probes.js's general convention, because the owner's
 *     rule for this specific door is "absent when the backend doesn't
 *     answer, never a dead button" -- a probe that could not run must
 *     behave exactly like one that ran and said no.
 *   - submitFeedback never trusts the network: a thrown fetch, a malformed
 *     reply, an unnamed status are all folded into the same `ok: false`
 *     shape a caller can render without knowing which happened.
 */

// ---------------------------------------------------------------------------
// composeFeedback: unchanged validation, new destination
// ---------------------------------------------------------------------------

test('a message is trimmed and shaped into the POST body, not a mailto', () => {
  const answer = composeFeedback({ message: '  The tree froze when I pressed Start.  ' })
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.body, { message: 'The tree froze when I pressed Start.' })
  assert.equal('url' in answer, false, 'no mailto URL should be built any more')
  assert.equal('address' in answer, false, 'no support mailbox address belongs in the renderer any more')
})

test('the build facts ride only when asked, and stay in a labelled block', () => {
  const without = composeFeedback({ message: 'x', build: { version: '1.0.33', commit: 'abc1234' } })
  assert.equal(without.body.message, 'x', 'build facts travelled with includeBuild false')

  const withBuild = composeFeedback({ message: 'x', includeBuild: true, build: { version: '1.0.33', commit: 'abc1234' } })
  assert.match(withBuild.body.message, /^x\n\n--\nVersion: 1\.0\.33\nBuild: abc1234$/,
    'the facts must be one labelled block at the end')
})

test('nothing to send is refused before anything is posted', () => {
  for (const empty of ['', '   ', '\n\n', undefined, null, 42, {}]) {
    const answer = composeFeedback({ message: empty })
    assert.equal(answer.ok, false, `${JSON.stringify(empty)} produced a message`)
    assert.equal(answer.code, 'FEEDBACK_EMPTY')
    assert.equal(answer.why, FEEDBACK_COPY.empty)
  }
})

test('a message over the server\'s own ceiling is refused, never quietly cut', () => {
  const answer = composeFeedback({ message: 'y'.repeat(MAX_MESSAGE_CHARACTERS + 1) })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'FEEDBACK_TOO_LONG')

  const justUnder = composeFeedback({ message: 'y'.repeat(MAX_MESSAGE_CHARACTERS) })
  assert.equal(justUnder.ok, true, 'the boundary itself must still send')
})

// ---------------------------------------------------------------------------
// probeFeedbackAvailable: the "?" door's render gate
// ---------------------------------------------------------------------------

function stubFetch(map) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    const make = map[url] || map.default
    if (!make) throw new Error(`unstubbed url: ${url}`)
    if (make === 'throw') throw new Error('network unreachable')
    return make
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function fakeResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

test('a live backend answering available:true makes the probe true', async () => {
  const fetchImpl = stubFetch({ [FEEDBACK_ENDPOINT]: fakeResponse(200, { available: true }) })
  assert.equal(await probeFeedbackAvailable({ fetchImpl }), true)
  assert.equal(fetchImpl.calls[0].options.method, 'GET')
})

test('a reachable backend saying available:false is still false, not hidden as unknown', async () => {
  const fetchImpl = stubFetch({ [FEEDBACK_ENDPOINT]: fakeResponse(200, { available: false }) })
  assert.equal(await probeFeedbackAvailable({ fetchImpl }), false)
})

test('an HTTP-level refusal is false', async () => {
  const fetchImpl = stubFetch({ [FEEDBACK_ENDPOINT]: fakeResponse(404, { error: { code: 'NOT_FOUND' } }) })
  assert.equal(await probeFeedbackAvailable({ fetchImpl }), false)
})

test('a malformed reply is false, never assumed available', async () => {
  const fetchImpl = stubFetch({ [FEEDBACK_ENDPOINT]: fakeResponse(200, { unexpected: 'shape' }) })
  assert.equal(await probeFeedbackAvailable({ fetchImpl }), false)
})

test('a thrown fetch -- offline, no proxy, DNS failure -- is false, never a crash', async () => {
  const fetchImpl = stubFetch({ [FEEDBACK_ENDPOINT]: 'throw' })
  assert.equal(await probeFeedbackAvailable({ fetchImpl }), false)
})

test('an environment with no fetch at all -- no injected impl, no global -- is false', async () => {
  const priorFetch = globalThis.fetch
  delete globalThis.fetch
  try {
    assert.equal(await probeFeedbackAvailable({}), false)
  } finally {
    globalThis.fetch = priorFetch
  }
})

// ---------------------------------------------------------------------------
// submitFeedback: the actual send
// ---------------------------------------------------------------------------

test('a valid message is posted to /v1/feedback and reads as sent', async () => {
  const fetchImpl = stubFetch({ [FEEDBACK_ENDPOINT]: fakeResponse(202, { received: true }) })
  const result = await submitFeedback({ message: 'the export button is broken', fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.why, FEEDBACK_COPY.sent)
  const [call] = fetchImpl.calls
  assert.equal(call.options.method, 'POST')
  assert.equal(call.options.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(call.options.body), { message: 'the export button is broken' })
})

test('an empty message never reaches the network', async () => {
  const fetchImpl = stubFetch({})
  const result = await submitFeedback({ message: '   ', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'FEEDBACK_EMPTY')
  assert.equal(fetchImpl.calls.length, 0, 'a refused message must never touch the network')
})

test('a rate-limited reply reads as itself, not as a generic failure', async () => {
  const fetchImpl = stubFetch({ [FEEDBACK_ENDPOINT]: fakeResponse(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } }) })
  const result = await submitFeedback({ message: 'x', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'FEEDBACK_RATE_LIMITED')
  assert.equal(result.why, FEEDBACK_COPY.rateLimited)
})

test('a named server refusal is shown as itself', async () => {
  const fetchImpl = stubFetch({
    [FEEDBACK_ENDPOINT]: fakeResponse(400, { error: { code: 'FEEDBACK_MESSAGE_TOO_LONG', message: 'That message is too long.' } }),
  })
  const result = await submitFeedback({ message: 'x', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'FEEDBACK_MESSAGE_TOO_LONG')
  assert.equal(result.why, 'That message is too long.')
})

test('a thrown fetch reads as unavailable, with a sentence a person can read', async () => {
  const fetchImpl = stubFetch({ [FEEDBACK_ENDPOINT]: 'throw' })
  const result = await submitFeedback({ message: 'x', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'FEEDBACK_UNAVAILABLE')
  assert.equal(result.why, FEEDBACK_COPY.unavailable)
})

test('a reply with no legible error still resolves to the generic failure sentence, never a blank', async () => {
  const fetchImpl = stubFetch({ [FEEDBACK_ENDPOINT]: fakeResponse(500, {}) })
  const result = await submitFeedback({ message: 'x', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.why, FEEDBACK_COPY.failed)
})

test('an environment with no fetch at all reads as unavailable, never a crash', async () => {
  const priorFetch = globalThis.fetch
  delete globalThis.fetch
  try {
    const result = await submitFeedback({ message: 'x' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'FEEDBACK_UNAVAILABLE')
  } finally {
    globalThis.fetch = priorFetch
  }
})
