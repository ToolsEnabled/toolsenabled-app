import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { postBridgeAction, resetBridgeSession, setBridgeTransport } from '../../src/mission-bridge.js'

const proof = 'p'.repeat(43)
const token = 't'.repeat(43)

async function fixture(t, handle) {
  const previousWindow = globalThis.window
  const calls = []
  let baseUrl
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.invalid').pathname
    calls.push(pathname)
    response.setHeader('content-type', 'application/json')
    if (handle(pathname, request, response)) return
    if (pathname === '/v1/runtime') {
      response.end(JSON.stringify({ ok: true, baseUrl, port: server.address().port,
        startedAt: '2026-09-07T00:00:00.000Z', pid: process.pid }))
    } else if (pathname === '/v1/bootstrap') {
      response.end(JSON.stringify({ ok: true, token }))
    } else {
      response.end(JSON.stringify({ ok: true, receipt: { accepted: true } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  setBridgeTransport(null)
  resetBridgeSession()
  globalThis.window = {
    location: { hostname: '127.0.0.1', search: '' },
    mcShell: {
      getBridgeEndpoint: async () => ({ ok: true, source: 'supervised', baseUrl, pid: process.pid }),
      getBridgeProof: async () => ({ ok: true, proof }),
    },
  }
  t.after(async () => {
    globalThis.window = previousWindow
    resetBridgeSession()
    setBridgeTransport(null)
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return calls
}

for (const route of ['/v1/runtime', '/v1/bootstrap', '/v1/actions/dispatch']) {
  test(`the local client refuses a redirect from ${route}`, async t => {
    const calls = await fixture(t, (pathname, request, response) => {
      if (pathname !== route) return false
      response.writeHead(307, { location: '/redirect-target' })
      response.end()
      return true
    })
    const result = await postBridgeAction('dispatch', { task: 'fixture only' })
    assert.equal(calls.filter(pathname => pathname === '/redirect-target').length, 0,
      'discovery, bootstrap and authenticated actions must remain on their requested routes')
    assert.equal(result.ok, false)
    assert.equal(calls.filter(pathname => pathname === route).length, 1, 'no automatic retry')
  })
}

test('an unreadable action reply reports an unknown outcome without resending the write', async t => {
  let writes = 0
  await fixture(t, (pathname, request, response) => {
    if (pathname !== '/v1/actions/dispatch') return false
    writes += 1
    response.end(writes === 1 ? '{broken' : JSON.stringify({ ok: true, receipt: { accepted: true } }))
    return true
  })
  const result = await postBridgeAction('dispatch', { task: 'fixture only' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BRIDGE_RESPONSE_UNREADABLE')
  assert.match(result.reason, /may have run/i)
  assert.equal(writes, 1, 'an unreadable response never triggers another write')
  assert.equal((await postBridgeAction('dispatch', { task: 'a separate explicit request' })).ok, true)
  assert.equal(writes, 2)
})

test('a timeout while reading the response body is reported as a timeout', async t => {
  const originalTimeout = AbortSignal.timeout
  // Exercise a real native Fetch body deadline without waiting for the full
  // production action budget. Discovery and bootstrap still complete normally.
  AbortSignal.timeout = ms => originalTimeout(Math.min(ms, 150))
  t.after(() => { AbortSignal.timeout = originalTimeout })
  const calls = await fixture(t, (pathname, request, response) => {
    if (pathname !== '/v1/actions/dispatch') return false
    response.writeHead(200)
    response.flushHeaders()
    response.write('{"ok":')
    return true
  })
  const result = await postBridgeAction('dispatch', { task: 'fixture only' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BRIDGE_TIMEOUT')
  assert.equal(calls.filter(pathname => pathname === '/v1/actions/dispatch').length, 1)
})
