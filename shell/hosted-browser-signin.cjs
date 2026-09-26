'use strict'

// Main-process-only native authorization handoff. The hosted account client
// supplies its fixed-origin, bounded transport and consumes the returned
// response internally; no code, verifier or session header goes to a renderer.
const http = require('node:http')
const crypto = require('node:crypto')
// The browser runs on the registered Google callback host. Its API transport
// is separately pinned to app.toolsenabled.ai by hosted-account-client.cjs.
const ORIGIN = 'https://toolsenabled.ai'
const CALLBACK_PATH = '/te-desktop-login'
const RANDOM = /^[A-Za-z0-9_-]{43}$/
const refuse = code => Object.freeze({ ok:false, code })
const random = () => crypto.randomBytes(32).toString('base64url')
const hash = value => crypto.createHash('sha256').update(value).digest('base64url')
const equal = (a,b) => typeof a === 'string' && RANDOM.test(a) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

function createHostedBrowserSignIn({ installationId, provider, request, openExternal,
  timeoutMs = 5 * 60 * 1000, now = Date.now } = {}) {
  if (typeof installationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(installationId)
      || !['google','password'].includes(provider) || typeof request !== 'function' || typeof openExternal !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60 * 1000) throw new Error('Invalid browser sign-in configuration')
  const codeVerifier = random(), callbackState = random()
  let running = null, started = false, cancelled = null, finished = false
  let server = null, pendingCallback = null, requestId = null, address = null, timer = null
  let cancelOutcome = null, remoteCancellation = null, delivered = false, callbackConsumed = false
  let cancelSignalResolve
  const cancelSignal = new Promise(resolve => { cancelSignalResolve = resolve })
  function revokePending() {
    if (!remoteCancellation) remoteCancellation = (async () => {
      try {
        const ended = await request('/v1/desktop/auth/cancel', { method:'POST', session:null,
          body:{ requestId, codeVerifier } })
        cancelOutcome = Boolean(ended.ok && ended.status === 200 && ended.value?.cancelled === true)
      } catch { cancelOutcome = false }
      return cancelOutcome
    })()
    return remoteCancellation
  }
  function cancel(code = 'HOSTED_ACCOUNT_CANCELLED') {
    if (finished) return requestId && delivered ? revokePending() : Promise.resolve(cancelOutcome)
    cancelled ||= code
    address = null
    cancelSignalResolve(null)
    if (pendingCallback) pendingCallback(null)
    try { server?.closeAllConnections() } catch {}
    return running || Promise.resolve(null)
  }
  function reply(response, status, message) {
    if (!response || response.destroyed || response.writableEnded) return Promise.resolve()
    response.writeHead(status, { 'content-type':'text/plain; charset=utf-8',
      'cache-control':'no-store', 'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff',
      'content-security-policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'", 'connection':'close' })
    return new Promise(resolve => {
      response.once('finish',resolve)
      response.once('close',resolve)
      response.end(message)
    })
  }
  async function execute() {
    if (cancelled) return refuse(cancelled)
    let callback
    const callbackArrived = new Promise(resolve => { pendingCallback = resolve })
    timer = setTimeout(() => { void cancel('HOSTED_ACCOUNT_BROWSER_TIMEOUT') }, timeoutMs)
    try {
      server = http.createServer({ maxHeaderSize:8192 }, (req,res) => {
        const local = server?.address()
        const host = local && `127.0.0.1:${local.port}`
        if (cancelled || callbackConsumed || req.method !== 'GET' || req.headers.host !== host
            || req.socket.remoteAddress !== '127.0.0.1' || typeof req.url !== 'string'
            || req.url.length > 2048 || !req.url.startsWith('/') || req.url.startsWith('//')) {
          reply(res,400,'This sign-in request was not accepted. Return to ToolsEnabled.'); return
        }
        let url
        try { url = new URL(req.url, `http://${host}`) } catch { reply(res,400,'Invalid sign-in request.'); return }
        if (url.pathname !== CALLBACK_PATH || url.searchParams.getAll('code').length !== 1
            || url.searchParams.getAll('state').length !== 1 || url.hash
            || !equal(url.searchParams.get('state'), callbackState) || !RANDOM.test(url.searchParams.get('code') || '')) {
          reply(res,400,'This sign-in request was not accepted. Return to ToolsEnabled.'); return
        }
        // Consume before the exchange awaits. Another callback cannot race it.
        callbackConsumed = true
        callback = { code:url.searchParams.get('code'), response:res }
        pendingCallback(callback)
      })
      server.maxConnections = 8
      server.requestTimeout = 5000
      server.headersTimeout = 5000
      server.keepAliveTimeout = 1000
      server.on('clientError', (_error,socket) => socket.destroy())
      await new Promise((resolve,reject) => {
        server.once('error',reject)
        server.listen(0,'127.0.0.1',resolve)
      })
      server.on('error', () => { void cancel('HOSTED_ACCOUNT_BROWSER_UNAVAILABLE') })
      if (cancelled) return refuse(cancelled)
      const startedAt = now()
      const begin = await request('/v1/desktop/auth/start', { method:'POST', session:null, body:{
        installationId, provider, callbackPort:server.address().port, callbackState, codeChallenge:hash(codeVerifier) } })
      if (begin.ok && begin.status === 200 && typeof begin.value?.requestId === 'string' && RANDOM.test(begin.value.requestId)) {
        requestId = begin.value.requestId
      }
      if (cancelled) return refuse(cancelled)
      // The service enforces its own expiry; our local timer independently
      // bounds this listener. Do not compare the two machines' wall clocks.
      if (!requestId || !Number.isSafeInteger(begin.value?.expiresAtMs) || begin.value.expiresAtMs <= 0
          || now() < startedAt) return refuse('HOSTED_ACCOUNT_RESPONSE_INVALID')
      const url = new URL(begin.value.authorizationUrl)
      if (url.origin !== ORIGIN || url.pathname !== '/v1/desktop/auth/browser' || url.username || url.password || url.hash
          || [...url.searchParams.keys()].length !== 1 || url.searchParams.get('request') !== requestId) {
        return refuse('HOSTED_ACCOUNT_REDIRECT_REFUSED')
      }
      address = url.href
      const openedBrowser = await Promise.race([
        Promise.resolve().then(() => cancelled ? false : openExternal(url.href)).then(() => true, () => false), cancelSignal
      ])
      if (cancelled) return refuse(cancelled)
      if (!openedBrowser) return refuse('HOSTED_ACCOUNT_BROWSER_UNAVAILABLE')
      callback = await callbackArrived
      address = null
      if (cancelled || !callback) return refuse(cancelled || 'HOSTED_ACCOUNT_CANCELLED')
      const result = await request('/v1/desktop/auth/exchange', { method:'POST', session:null,
        body:{ code:callback.code, codeVerifier } })
      if (cancelled) return refuse(cancelled)
      if (!result.ok || result.status !== 200) return refuse('HOSTED_ACCOUNT_SIGNIN_REFUSED')
      await reply(callback.response,200,'Sign-in reached ToolsEnabled. Return to the app to continue.')
      if (cancelled) return refuse(cancelled)
      delivered = true
      return result
    } catch { return refuse(cancelled || 'HOSTED_ACCOUNT_BROWSER_UNAVAILABLE') }
    finally {
      address = null
      clearTimeout(timer)
      pendingCallback = null
      reply(callback?.response,400,'Sign-in did not finish. Start it again in ToolsEnabled.')
      if (server) {
        const closing = server
        await new Promise(resolve => {
          closing.close(() => resolve())
          closing.closeAllConnections()
        })
        server = null
      }
      // A response lost during cancellation may already have minted a login.
      // Revoke using this attempt's proof, never an account id or browser cookie.
      if ((!delivered || cancelled) && requestId) await revokePending()
      finished = true
    }
  }
  function run() {
    if (started) return Promise.resolve(refuse('HOSTED_ACCOUNT_BUSY'))
    started = true
    running = execute()
    return running
  }
  return Object.freeze({ run, cancel,
    get authorizationAddress() { return address },
    get remoteCancelled() { return cancelOutcome === true }
  })
}

module.exports = { createHostedBrowserSignIn }
