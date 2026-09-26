// THE THING THAT ANSWERS AT /v1/feedback ON THIS MACHINE, AND WHETHER IT
// ACTUALLY REACHES THE REAL ACCOUNT SERVICE.
//
// Same shape as tools/test/subscribe-endpoint.test.mjs, and for the same
// reason: a fixture that only mounts the proxy cannot tell "the proxy
// answered" from "nothing else was there to answer", so every server below
// carries the same SPA-fallback shape serveDist() has.
//
// THE PROPERTY THAT MATTERS MOST: what this window's renderer sees at
// /v1/feedback must be indistinguishable from what the REAL account service
// would have answered directly, for both the probe and a submission -- and
// when the real service cannot be reached at all, the reply must read as
// "not available" to src/feedback-compose.js's probeFeedbackAvailable and
// submitFeedback, never as a crash and never as a false positive.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { FEEDBACK_PATH, FEEDBACK_ORIGIN_HEADER, createFeedbackProxy } = require_('../../shell/feedback-proxy.cjs')

/** A server shaped like serveDist(): the proxy first, the SPA fallback last. */
async function localSite(t, proxy) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (proxy.serve(url.pathname, request, response)) return
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><html><body>the app shell</body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

/** A fake account service, standing in for the real server's /v1/feedback. */
async function fakeAccountService(t, handler) {
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => handler(request, response, Buffer.concat(chunks)))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

function json(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(text)
}

// ---------------------------------------------------------------------------
// Routing: what the proxy claims, and what it leaves alone
// ---------------------------------------------------------------------------

test('the proxy claims exactly /v1/feedback and nothing else', () => {
  const proxy = createFeedbackProxy({ baseUrl: 'http://127.0.0.1:1' })
  assert.equal(proxy.handles(FEEDBACK_PATH), true)
  assert.equal(proxy.handles('/v1/feedback/'), false, 'a trailing slash is a different path')
  assert.equal(proxy.handles('/v1/feedbacks'), false, 'a prefix is not a route')
  assert.equal(proxy.handles('/'), false)
  assert.equal(proxy.handles(undefined), false)
})

// ---------------------------------------------------------------------------
// The probe: GET /v1/feedback
// ---------------------------------------------------------------------------

test('a live account service answering available:true is relayed verbatim', async t => {
  const accountApi = await fakeAccountService(t, (request, response) => {
    assert.equal(request.method, 'GET')
    assert.equal(request.headers.origin, FEEDBACK_ORIGIN_HEADER, 'the proxy must assert the native-client Origin fra\'s engine uses')
    json(response, 200, { available: true })
  })
  const proxy = createFeedbackProxy({ baseUrl: accountApi })
  const site = await localSite(t, proxy)

  const response = await fetch(`${site}${FEEDBACK_PATH}`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { available: true })
})

test('an unreachable account service reads as unavailable, never as a crash', async t => {
  // Port 1 refuses every connection on a normal machine -- nothing is listening
  // there and nothing ever will be, which is the point: this proves the NO
  // ANSWER AT ALL case, distinct from a service that answered false.
  const proxy = createFeedbackProxy({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 })
  const site = await localSite(t, proxy)

  const response = await fetch(`${site}${FEEDBACK_PATH}`)
  assert.notEqual(response.status, 200, 'an unreachable backend must not be answered as though it were live')
  const body = await response.json()
  assert.equal(body.available, undefined, 'must never claim availability it could not verify')
  assert.equal(body.error.code, 'FEEDBACK_UNAVAILABLE')
})

test('an account service that explicitly says available:false is relayed, not overridden', async t => {
  const accountApi = await fakeAccountService(t, (request, response) => json(response, 200, { available: false }))
  const proxy = createFeedbackProxy({ baseUrl: accountApi })
  const site = await localSite(t, proxy)

  const response = await fetch(`${site}${FEEDBACK_PATH}`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { available: false })
})

// ---------------------------------------------------------------------------
// The submission: POST /v1/feedback
// ---------------------------------------------------------------------------

test('a submission is forwarded with the native-client Origin and the exact body', async t => {
  let seenOrigin = null
  let seenBody = null
  const accountApi = await fakeAccountService(t, (request, response, buffer) => {
    seenOrigin = request.headers.origin
    seenBody = JSON.parse(buffer.toString('utf8'))
    json(response, 202, { received: true })
  })
  const proxy = createFeedbackProxy({ baseUrl: accountApi })
  const site = await localSite(t, proxy)

  const response = await fetch(`${site}${FEEDBACK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'the export button is broken' }),
  })
  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { received: true })
  assert.equal(seenOrigin, FEEDBACK_ORIGIN_HEADER)
  assert.deepEqual(seenBody, { message: 'the export button is broken' })
})

test('a named refusal from the account service is relayed verbatim, status and body', async t => {
  const accountApi = await fakeAccountService(t, (request, response) => {
    json(response, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } })
  })
  const proxy = createFeedbackProxy({ baseUrl: accountApi })
  const site = await localSite(t, proxy)

  const response = await fetch(`${site}${FEEDBACK_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x' }),
  })
  assert.equal(response.status, 429)
  assert.deepEqual(await response.json(), { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } })
})

test('a submission made while the account service is unreachable is refused, not silently dropped', async t => {
  const proxy = createFeedbackProxy({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 })
  const site = await localSite(t, proxy)

  const response = await fetch(`${site}${FEEDBACK_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello' }),
  })
  assert.notEqual(response.status, 202)
  const body = await response.json()
  assert.equal(body.error.code, 'FEEDBACK_UNAVAILABLE')
})

test('an oversized body is refused before anything is forwarded', async t => {
  let forwarded = false
  const accountApi = await fakeAccountService(t, (request, response) => {
    forwarded = true
    json(response, 202, { received: true })
  })
  const proxy = createFeedbackProxy({ baseUrl: accountApi })
  const site = await localSite(t, proxy)

  /* THE SOCKET MAY RESET INSTEAD OF ANSWERING CLEANLY, and that is not a
     defect in this test: readBoundedBody destroys the request the instant
     it decides the body is too large -- deliberately, matching the exact
     trade-off server/src/http-service.js documents for the identical
     situation ("the caller sees a hang rather than the 400 we just sent"
     is the alternative being avoided). A client mid-write can therefore see
     a connection error rather than the 413 body. Either outcome proves the
     one property this test actually cares about: the oversized body never
     reached the real account service. */
  let status = null
  try {
    const response = await fetch(`${site}${FEEDBACK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'y'.repeat(200_000) }),
    })
    status = response.status
  } catch {
    status = null // the connection reset before a response arrived -- also a refusal
  }
  if (status !== null) assert.equal(status, 413)
  assert.equal(forwarded, false, 'an oversized body must never reach the real account service')
})

// ---------------------------------------------------------------------------
// Everything else on this window still falls through to the app shell
// ---------------------------------------------------------------------------

test('a path the proxy does not own reaches the SPA fallback untouched', async t => {
  const proxy = createFeedbackProxy({ baseUrl: 'http://127.0.0.1:1' })
  const site = await localSite(t, proxy)
  const response = await fetch(`${site}/`)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /the app shell/)
})
