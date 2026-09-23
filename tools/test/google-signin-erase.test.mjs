import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'
import { createGoogleSignIn, TOKEN_ENDPOINT } from '../../shell/google-signin.cjs'
import { GOOGLE_JWKS_URI } from '../../shell/google-oidc.cjs'

// Actual owned ephemeral loopback listeners; every provider response is a fake
// fetch or an in-memory Response. No Google request or profile data is used.
const CLIENT = 'synthetic-erase-client'
const NOW = 1_780_000_000_000
const OK = { ok: true, sealed: true, closed: true }
const turn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: 'erase-fixture', use: 'sig', alg: 'RS256' }
function token(nonce) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'RS256', kid: jwk.kid })
  const payload = encode({ iss: 'https://accounts.google.com', aud: CLIENT, nonce,
    sub: 'synthetic-subject', email: 'erase-fixture@example.com', email_verified: true,
    iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 3600 })
  return `${header}.${payload}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key.privateKey).toString('base64url')}`
}
function fixture(t, overrides = {}) {
  const opened = deferred()
  const servers = []
  const sockets = new Set()
  const observed = { browserCalls: 0, fetchCalls: 0, address: null, handler: null }
  const attempt = createGoogleSignIn({
    clientId: CLIENT, timeoutMs: 2000, now: () => NOW,
    openExternal: address => { observed.browserCalls++; observed.address = new URL(address); opened.resolve(observed.address) },
    fetchImpl: async () => { observed.fetchCalls++; throw new Error('Unexpected fake provider request') },
    ...overrides,
    createServer: handler => {
      observed.handler = handler
      const listener = overrides.createServer ? overrides.createServer(handler) : http.createServer(handler)
      listener.on('connection', socket => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
      servers.push(listener)
      return listener
    },
  })
  t.after(async () => {
    attempt.cancel()
    for (const socket of sockets) socket.destroy()
    // Force only these fixture-owned native listeners closed on an assertion
    // failure. Calling the prototype bypasses a deliberately held close seam.
    await Promise.all(servers.map(listener => new Promise(resolve => {
      http.Server.prototype.close.call(listener, () => resolve())
      http.Server.prototype.closeAllConnections.call(listener)
    })))
  })
  return { attempt, opened: opened.promise, observed, servers }
}
async function callback(h) {
  const address = await h.opened
  const target = new URL(address.searchParams.get('redirect_uri'))
  target.searchParams.set('state', address.searchParams.get('state'))
  target.searchParams.set('code', 'synthetic-code')
  await new Promise((resolve, reject) => {
    http.get(target, response => { response.resume(); response.on('end', resolve) }).on('error', reject)
  })
}
async function stillPending(promise) {
  let ended = false
  void promise.then(() => { ended = true })
  await turn()
  assert.equal(ended, false, 'UI cancellation must not masquerade as owned cleanup')
}
function heldCloseFactory() {
  const closing = deferred()
  let finish
  return {
    closing: closing.promise,
    finish: () => finish(),
    createServer(handler) {
      const server = http.createServer(handler)
      const nativeClose = server.close.bind(server)
      server.close = callback => {
        nativeClose(error => {
          finish = () => callback(error)
          closing.resolve()
        })
        return server
      }
      return server
    },
  }
}

test('Erase seals a never-run attempt without admitting a listener, browser or provider', async t => {
  const h = fixture(t)
  const cleanup = h.attempt.quiesceForErase({ timeoutMs: 100 })
  assert.deepEqual(await cleanup, OK)
  assert.strictEqual(h.attempt.quiesceForErase(), cleanup)
  assert.equal((await h.attempt.run()).code, 'GOOGLE_SIGNIN_CANCELLED')
  assert.equal((await h.attempt.run()).code, 'GOOGLE_SIGNIN_ALREADY_USED')
  assert.equal(h.servers.length, 0)
  assert.equal(h.observed.browserCalls, 0)
  assert.equal(h.observed.fetchCalls, 0)
})

test('ordinary cancellation before run cannot later open a listener or hang the result', async t => {
  const h = fixture(t)
  assert.deepEqual(h.attempt.cancel(), { ok: true })
  assert.equal((await h.attempt.run()).code, 'GOOGLE_SIGNIN_CANCELLED')
  assert.deepEqual(await h.attempt.quiesceForErase(), OK)
  assert.equal(h.servers.length, 0)
})

test('Erase waits for the retained native close callback after run has already cancelled', async t => {
  const close = heldCloseFactory()
  const h = fixture(t, { createServer: close.createServer })
  const run = h.attempt.run()
  await h.opened
  const cleanup = h.attempt.quiesceForErase({ timeoutMs: 500 })
  assert.equal((await run).code, 'GOOGLE_SIGNIN_CANCELLED')
  await close.closing
  assert.equal(h.servers[0].listening, false, 'the native close occurred, but its acknowledgment is still held')
  await stillPending(cleanup)
  close.finish()
  assert.deepEqual(await cleanup, OK)
})

test('a real retained loopback connection prevents cleanup proof until its actual exit', async t => {
  const partialRequest = deferred()
  let acceptedSocket = null, completedRequest = false
  const prefix = 'GET /held-cleanup-fixture HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Fixture: pending'
  const h = fixture(t, { createServer: handler => {
    const listener = http.createServer((request, response) => {
      completedRequest = true
      handler(request, response)
    })
    listener.on('connection', socket => {
      acceptedSocket = socket
      let received = ''
      socket.on('data', chunk => {
        received += chunk.toString('ascii')
        if (received === prefix) partialRequest.resolve()
      })
    })
    listener.closeAllConnections = () => {} // Fault: force-close request did not drain the owned socket.
    return listener
  } })
  const run = h.attempt.run()
  const address = await h.opened
  const connection = net.connect({ host: '127.0.0.1', port: Number(new URL(address.searchParams.get('redirect_uri')).port) })
  t.after(() => connection.destroy())
  await new Promise((resolve, reject) => { connection.once('connect', resolve); connection.once('error', reject) })
  connection.write(prefix)
  // Client connect can precede server accept on Windows. Observe bytes on the
  // actual accepted socket, with HTTP headers still incomplete, so this is an
  // active owned connection and ordinary idle-socket cleanup cannot satisfy it.
  await partialRequest.promise
  assert.ok(acceptedSocket)
  assert.equal(acceptedSocket.destroyed, false)
  assert.equal(completedRequest, false)
  const closed = new Promise(resolve => h.servers[0].once('close', resolve))
  const cleanup = h.attempt.quiesceForErase({ timeoutMs: 40 })
  assert.equal((await run).code, 'GOOGLE_SIGNIN_CANCELLED')
  const refused = await cleanup
  assert.equal(refused.code, 'GOOGLE_SIGNIN_CLEANUP_UNCONFIRMED')
  assert.equal(refused.closed, false)
  assert.equal(connection.destroyed, false)
  assert.equal(acceptedSocket.destroyed, false)
  connection.destroy()
  await closed
  assert.equal(acceptedSocket.destroyed, true)
  assert.strictEqual(h.attempt.quiesceForErase(), cleanup, 'late closure cannot turn a refused Erase into permission')
  assert.strictEqual(await cleanup, refused)
})

for (const late of [false, true]) test(`Erase retains a listener still binding${late ? ' past its deadline' : ''}`, async t => {
  const ready = deferred()
  let bind, closeCalls = 0
  const h = fixture(t, { createServer: handler => {
    const listener = http.createServer(handler)
    const listen = listener.listen.bind(listener)
    const close = listener.close.bind(listener)
    listener.listen = (...args) => { bind = () => listen(...args); ready.resolve(); return listener }
    listener.close = callback => { closeCalls++; return close(callback) }
    return listener
  } })
  const run = h.attempt.run()
  await ready.promise
  const cleanup = h.attempt.quiesceForErase({ timeoutMs: late ? 30 : 500 })
  assert.equal((await run).code, 'GOOGLE_SIGNIN_CANCELLED')
  await stillPending(cleanup)
  assert.equal(closeCalls, 0, 'not-yet-listening is not an acknowledged close')
  if (late) assert.equal((await cleanup).ok, false)
  const closed = new Promise(resolve => h.servers[0].once('close', resolve))
  bind()
  await closed
  assert.equal(closeCalls, 1)
  assert.equal(h.observed.browserCalls, 0)
  assert.equal((await cleanup).ok, !late)
  assert.strictEqual(h.attempt.quiesceForErase(), cleanup)
})

test('a synchronously refused bind is closed and observed without opening the browser', async t => {
  const h = fixture(t, { createServer: handler => {
    const listener = http.createServer(handler)
    listener.listen = () => { listener.emit('error', Object.assign(new Error('private fixture refusal'), { code: 'EACCES' })); return listener }
    return listener
  } })
  assert.equal((await h.attempt.run()).code, 'GOOGLE_SIGNIN_PORT_REFUSED')
  assert.deepEqual(await h.attempt.quiesceForErase(), OK)
  assert.equal(h.observed.browserCalls, 0)
})

test('a close exception refuses cleanup while retaining the actual listener for cancellation retry', async t => {
  let fail = true, calls = 0
  const h = fixture(t, { createServer: handler => {
    const listener = http.createServer(handler)
    const close = listener.close.bind(listener)
    listener.close = callback => { calls++; if (fail) throw new Error('synthetic secret detail'); return close(callback) }
    return listener
  } })
  const run = h.attempt.run()
  await h.opened
  const cleanup = h.attempt.quiesceForErase({ timeoutMs: 100 })
  const refused = await cleanup
  assert.equal(refused.ok, false)
  assert.equal(h.servers[0].listening, true)
  assert.equal(JSON.stringify(refused).includes('synthetic secret detail'), false)
  assert.equal((await run).code, 'GOOGLE_SIGNIN_CANCELLED')
  const beforeRetry = calls
  const closed = new Promise(resolve => h.servers[0].once('close', resolve))
  fail = false
  assert.strictEqual(h.attempt.quiesceForErase(), cleanup)
  await closed
  assert.ok(calls > beforeRetry)
  assert.equal((await cleanup).ok, false)
})

test('Erase requests token abort and waits for an uncooperative fetch continuation', async t => {
  const gate = deferred(), entered = deferred()
  let signal, textCalls = 0
  t.after(() => gate.resolve())
  const h = fixture(t, { fetchImpl: async (_url, init) => {
    signal = init.signal; entered.resolve()
    await gate.promise
    return { ok: true, text: async () => { textCalls++; return '{}' } }
  } })
  const run = h.attempt.run()
  await callback(h)
  await entered.promise
  const cleanup = h.attempt.quiesceForErase({ timeoutMs: 500 })
  assert.equal((await run).code, 'GOOGLE_SIGNIN_CANCELLED')
  assert.equal(signal.aborted, true)
  await stillPending(cleanup)
  gate.resolve()
  assert.deepEqual(await cleanup, OK)
  assert.equal(textCalls, 0, 'a cancelled late response cannot start another body reader')
})

test('an abort-aware token request actually rejects before Erase acknowledges cleanup', async t => {
  const entered = deferred()
  let observedAbort = false
  const h = fixture(t, { fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { observedAbort = true; reject(new Error('synthetic abort')) }, { once: true })
    entered.resolve()
  }) })
  const run = h.attempt.run()
  await callback(h); await entered.promise
  assert.deepEqual(await h.attempt.quiesceForErase(), OK)
  assert.equal(observedAbort, true)
  assert.equal((await run).code, 'GOOGLE_SIGNIN_CANCELLED')
})

test('pending token text remains owned and cannot start verification after cancellation', async t => {
  const gate = deferred(), entered = deferred()
  let verified = 0
  t.after(() => gate.resolve())
  const h = fixture(t, {
    fetchImpl: async () => ({ ok: true, text: async () => { entered.resolve(); await gate.promise; return '{"id_token":"synthetic"}' } }),
    verify: async () => { verified++; return { ok: true, identity: {} } },
  })
  const run = h.attempt.run()
  await callback(h); await entered.promise
  const cleanup = h.attempt.quiesceForErase({ timeoutMs: 500 })
  await stillPending(cleanup)
  gate.resolve()
  assert.deepEqual(await cleanup, OK)
  assert.equal((await run).code, 'GOOGLE_SIGNIN_CANCELLED')
  assert.equal(verified, 0)
})

test('verification already in flight must actually settle and its late identity is never delivered', async t => {
  const gate = deferred(), entered = deferred()
  let completed = false
  t.after(() => gate.resolve())
  const h = fixture(t, {
    fetchImpl: async () => ({ ok: true, text: async () => '{"id_token":"synthetic"}' }),
    verify: async () => { entered.resolve(); await gate.promise; completed = true; return { ok: true, identity: { secret: 'must-not-escape' } } },
  })
  const run = h.attempt.run()
  await callback(h); await entered.promise
  const cleanup = h.attempt.quiesceForErase({ timeoutMs: 500 })
  const outcome = await run
  assert.equal(outcome.code, 'GOOGLE_SIGNIN_CANCELLED')
  await stillPending(cleanup)
  assert.equal(completed, false)
  gate.resolve()
  assert.deepEqual(await cleanup, OK)
  assert.equal(completed, true)
  assert.equal('identity' in outcome, false)
})

test('the actual OIDC verifier receives the owned signal and a pending JWKS fetch blocks Erase', async t => {
  const gate = deferred(), entered = deferred()
  let jwksSignal
  t.after(() => gate.resolve())
  const h = fixture(t, { fetchImpl: async (url, init) => {
    if (url === TOKEN_ENDPOINT) return new Response(JSON.stringify({ id_token: token(h.observed.address.searchParams.get('nonce')) }))
    assert.equal(url, GOOGLE_JWKS_URI)
    jwksSignal = init.signal; entered.resolve()
    await gate.promise
    return new Response(JSON.stringify({ keys: [jwk] }))
  } })
  const run = h.attempt.run()
  await callback(h); await entered.promise
  const cleanup = h.attempt.quiesceForErase({ timeoutMs: 500 })
  assert.equal(jwksSignal.aborted, true)
  await stillPending(cleanup)
  gate.resolve()
  assert.deepEqual(await cleanup, OK)
  assert.equal((await run).code, 'GOOGLE_SIGNIN_CANCELLED')
})

test('a real JWKS body reader that ignores abort remains owned after bounded refusal', async t => {
  const entered = deferred()
  let controller
  const h = fixture(t, { fetchImpl: async url => {
    if (url === TOKEN_ENDPOINT) return new Response(JSON.stringify({ id_token: token(h.observed.address.searchParams.get('nonce')) }))
    assert.equal(url, GOOGLE_JWKS_URI)
    return new Response(new ReadableStream({ start(value) { controller = value; entered.resolve() } }))
  } })
  const run = h.attempt.run()
  await callback(h); await entered.promise; await turn()
  const cleanup = h.attempt.quiesceForErase({ timeoutMs: 40 })
  assert.equal((await cleanup).closed, false)
  assert.equal((await run).code, 'GOOGLE_SIGNIN_CANCELLED')
  controller.enqueue(Buffer.from(JSON.stringify({ keys: [jwk] }))); controller.close()
  await turn()
  assert.strictEqual(h.attempt.quiesceForErase(), cleanup)
  assert.equal((await cleanup).ok, false)
})

test('a refused JWKS response still owns its unread native body until cancellation completes', async t => {
  const gate = deferred(), cancelling = deferred()
  t.after(() => gate.resolve())
  const h = fixture(t, { fetchImpl: async url => {
    if (url === TOKEN_ENDPOINT) return new Response(JSON.stringify({ id_token: token(h.observed.address.searchParams.get('nonce')) }))
    assert.equal(url, GOOGLE_JWKS_URI)
    return new Response(new ReadableStream({ cancel() { cancelling.resolve(); return gate.promise } }), { status: 503 })
  } })
  const run = h.attempt.run()
  await callback(h)
  assert.equal((await run).ok, false)
  await cancelling.promise
  const cleanup = h.attempt.quiesceForErase({ timeoutMs: 500 })
  await stillPending(cleanup)
  gate.resolve()
  assert.deepEqual(await cleanup, OK)
})

test('a failed native body cancellation refuses cleanup without discarding the response', async t => {
  const h = fixture(t, { fetchImpl: async url => {
    if (url === TOKEN_ENDPOINT) return new Response(JSON.stringify({ id_token: token(h.observed.address.searchParams.get('nonce')) }))
    return new Response(new ReadableStream({ cancel() { throw new Error('synthetic cancellation detail') } }), { status: 503 })
  } })
  const run = h.attempt.run(); await callback(h); await run
  const result = await h.attempt.quiesceForErase()
  assert.equal(result.ok, false)
  assert.equal(result.closed, false)
  assert.equal(JSON.stringify(result).includes('synthetic cancellation detail'), false)
})

test('a pending browser opener is retained beyond cancelled run settlement', async t => {
  const gate = deferred(), entered = deferred()
  t.after(() => gate.resolve())
  const h = fixture(t, { openExternal: async () => { entered.resolve(); await gate.promise } })
  const run = h.attempt.run(); await entered.promise
  const cleanup = h.attempt.quiesceForErase({ timeoutMs: 500 })
  assert.equal((await run).code, 'GOOGLE_SIGNIN_CANCELLED')
  await stillPending(cleanup)
  gate.resolve()
  assert.deepEqual(await cleanup, OK)
})

test('a queued valid callback after Erase sealing cannot admit an exchange', async t => {
  const h = fixture(t)
  const run = h.attempt.run()
  const address = await h.opened
  const target = new URL(address.searchParams.get('redirect_uri'))
  const cleanup = h.attempt.quiesceForErase()
  let status
  h.observed.handler({ method: 'GET', url: `${target.pathname}?code=late&state=${address.searchParams.get('state')}`, headers: { host: target.host } }, {
    writeHead(value) { status = value }, end() {},
  })
  assert.deepEqual(await cleanup, OK)
  assert.equal(status, 410)
  assert.equal(h.observed.fetchCalls, 0)
  assert.equal((await run).code, 'GOOGLE_SIGNIN_CANCELLED')
})

test('a completion delivered after the monotonic deadline cannot beat the timer into success', async t => {
  const close = heldCloseFactory()
  const h = fixture(t, { createServer: close.createServer })
  const run = h.attempt.run(); await h.opened
  const cleanup = h.attempt.quiesceForErase({ timeoutMs: 30 })
  await close.closing
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40)
  close.finish() // Queue the observed close before Node gets to the overdue timer.
  assert.equal((await cleanup).ok, false)
  assert.equal((await run).code, 'GOOGLE_SIGNIN_CANCELLED')
})

test('ordinary verified sign-in still completes, then background Erase cleanup proves the actual drain', async t => {
  const h = fixture(t, { fetchImpl: async url => {
    if (url === TOKEN_ENDPOINT) return new Response(JSON.stringify({ id_token: token(h.observed.address.searchParams.get('nonce')) }))
    assert.equal(url, GOOGLE_JWKS_URI)
    return new Response(JSON.stringify({ keys: [jwk] }))
  } })
  const run = h.attempt.run(); await callback(h)
  const outcome = await run
  assert.equal(outcome.ok, true, outcome.reason)
  assert.equal(outcome.identity.email, 'erase-fixture@example.com')
  assert.equal(outcome.identity.assurance, 'id_token-verified')
  assert.deepEqual(await h.attempt.quiesceForErase(), OK)
  assert.equal(h.servers[0].listening, false)
  assert.equal(h.attempt.authorizationAddress, null)
})
