import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createHostedBrowserSignIn } = require('../../shell/hosted-browser-signin.cjs')
const ORIGIN = 'https://toolsenabled.ai'
const random = () => crypto.randomBytes(32).toString('base64url')
const hash = value => crypto.createHash('sha256').update(value).digest('base64url')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(t, { transformStart = value => value, openExternal, exchange, start, cancelResult = true, timeoutMs = 2000,
  now = Date.now } = {}) {
  const opened = deferred(), begun = deferred(), requestId = random(), code = random(), calls = []
  let challenge, port, state, liveSession = false
  const response = { ok:true, status:200, value:{ account:{ id:'fixture', email:'fixture@example.invalid' } }, headers:new Headers() }
  async function request(path, options) {
    assert.equal(options.method,'POST'); assert.equal(options.session,null)
    calls.push(path)
    if (path.endsWith('/start')) {
      challenge = options.body.codeChallenge; port = options.body.callbackPort; state = options.body.callbackState
      assert.equal(options.body.installationId, installationId)
      assert.match(state,/^[A-Za-z0-9_-]{43}$/)
      begun.resolve(options.body)
      if (start) await start()
      return { ok:true, status:200, value:transformStart({ requestId,
        authorizationUrl:`${ORIGIN}/v1/desktop/auth/browser?request=${requestId}`, expiresAtMs:Date.now()+60000 }) }
    }
    assert.equal(hash(options.body.codeVerifier),challenge,'PKCE possession verified')
    if (path.endsWith('/exchange')) {
      assert.equal(options.body.code,code)
      liveSession = true
      if (exchange) await exchange()
      return response
    }
    assert.equal(path,'/v1/desktop/auth/cancel')
    assert.equal(options.body.requestId,requestId)
    if (cancelResult) liveSession = false
    return { ok:true, status:200, value:{ cancelled:cancelResult } }
  }
  const installationId = crypto.randomUUID()
  const attempt = createHostedBrowserSignIn({ installationId, provider:'google', request, timeoutMs, now,
    openExternal: async url => { opened.resolve(url); if (openExternal) return openExternal(url) } })
  t.after(async () => { await attempt.cancel() })
  function callback({ method = 'GET', host = `127.0.0.1:${port}`, path = '/te-desktop-login', givenState = state,
    givenCode = code, extra = '' } = {}) {
    return new Promise((resolve,reject) => {
      const req = http.request({ host:'127.0.0.1', port, method, headers:{ Host:host },
        path:`${path}?code=${givenCode}&state=${givenState}${extra}` }, res => {
        const chunks = []; res.on('data',chunk => chunks.push(chunk))
        res.on('end',() => resolve({ status:res.statusCode, text:Buffer.concat(chunks).toString(), headers:res.headers }))
      })
      req.on('error',reject); req.end()
    })
  }
  async function closed() {
    assert.ok(port)
    await new Promise((resolve,reject) => {
      const socket = net.connect(port,'127.0.0.1')
      socket.on('connect',() => { socket.destroy(); reject(new Error('callback listener remained open')) })
      socket.on('error',error => { assert.equal(error.code,'ECONNREFUSED'); resolve() })
    })
  }
  return { attempt, opened:opened.promise, begun:begun.promise, callback, closed, calls, response,
    get liveSession() { return liveSession }, get port() { return port } }
}

test('native handoff listens only on loopback, verifies PKCE and closes its listener after one valid callback', async t => {
  const h = fixture(t), pending = h.attempt.run(), url = await h.opened
  assert.equal(new URL(url).origin,ORIGIN)
  assert.equal(h.attempt.authorizationAddress,url)
  const callback = h.callback()
  assert.equal(await pending,h.response)
  const page = await callback
  assert.equal(page.status,200)
  assert.equal(page.headers['cache-control'],'no-store')
  assert.equal(page.headers['referrer-policy'],'no-referrer')
  assert.match(page.text,/Return to the app/)
  assert.equal(h.attempt.authorizationAddress,null)
  assert.equal(h.liveSession,true)
  assert.deepEqual(h.calls,['/v1/desktop/auth/start','/v1/desktop/auth/exchange'])
  await h.closed()
})

test('wrong Host, state, method, path and repeated parameters cannot consume a native callback', async t => {
  const h = fixture(t), pending = h.attempt.run(); await h.opened
  for (const offered of [{host:'attacker.invalid'},{givenState:random()},{method:'POST'},{path:'/other'},
    {extra:'&state='+random()},{extra:'&code='+random()}]) assert.equal((await h.callback(offered)).status,400)
  assert.equal(h.calls.includes('/v1/desktop/auth/exchange'),false)
  const callback = h.callback()
  assert.equal(await pending,h.response); assert.equal((await callback).status,200)
  await h.closed()
})

test('an authorization URL outside the fixed account origin never opens a browser', async t => {
  let browserCalls = 0
  for (const address of ['https://attacker.invalid/',`${ORIGIN}/other`,`${ORIGIN}/v1/desktop/auth/browser?request=wrong`]) {
    const h = fixture(t,{ transformStart:value => ({...value,authorizationUrl:address}), openExternal:() => browserCalls++ })
    assert.equal((await h.attempt.run()).code,'HOSTED_ACCOUNT_REDIRECT_REFUSED')
    assert.equal(browserCalls,0)
    assert.equal(h.attempt.remoteCancelled,true)
    await h.closed()
  }
})

test('cancel while waiting for the browser closes the listener and revokes the pending authorization', async t => {
  const h = fixture(t), pending = h.attempt.run(); await h.opened
  await h.attempt.cancel()
  assert.equal((await pending).code,'HOSTED_ACCOUNT_CANCELLED')
  assert.equal(h.attempt.remoteCancelled,true)
  assert.equal(h.attempt.authorizationAddress,null)
  await h.closed()
})

test('cancellation during exchange revokes a login even when its response arrives late', async t => {
  const entered = deferred(), release = deferred()
  const h = fixture(t,{exchange:() => { entered.resolve(); return release.promise }})
  const pending = h.attempt.run(); await h.opened
  const callback = h.callback().catch(error => ({ error:error.code }))
  await entered.promise
  const cancel = h.attempt.cancel()
  release.resolve()
  await cancel
  assert.equal((await pending).code,'HOSTED_ACCOUNT_CANCELLED')
  assert.equal(h.liveSession,false)
  assert.equal(h.attempt.remoteCancelled,true)
  await callback; await h.closed()
})

test('cancel during initiation cleans up a late start response without opening a browser', async t => {
  const release = deferred(); let opened = false
  const h = fixture(t,{start:() => release.promise,openExternal:() => { opened = true }})
  const pending = h.attempt.run(); await h.begun
  const cancel = h.attempt.cancel(); release.resolve(); await cancel
  assert.equal((await pending).code,'HOSTED_ACCOUNT_CANCELLED')
  assert.equal(opened,false); assert.equal(h.attempt.remoteCancelled,true)
  await h.closed()
})

test('timeout bounds a browser opener that never answers and cleans up the flow', async t => {
  const h = fixture(t,{timeoutMs:100,openExternal:() => new Promise(() => {})})
  assert.equal((await h.attempt.run()).code,'HOSTED_ACCOUNT_BROWSER_TIMEOUT')
  assert.equal(h.attempt.remoteCancelled,true)
  await h.closed()
})

test('failure to confirm remote cancellation is reported without claiming logout', async t => {
  const h = fixture(t,{cancelResult:false}), pending = h.attempt.run(); await h.opened
  await h.attempt.cancel()
  assert.equal((await pending).code,'HOSTED_ACCOUNT_CANCELLED')
  assert.equal(h.attempt.remoteCancelled,false)
  await h.closed()
})

test('a duplicate valid callback cannot race an in-flight exchange; late cancellation revokes its exact login', async t => {
  const entered = deferred(), release = deferred()
  const h = fixture(t,{exchange:() => { entered.resolve(); return release.promise }})
  const pending = h.attempt.run(); await h.opened
  const first = h.callback(); await entered.promise
  assert.equal((await h.callback()).status,400)
  release.resolve(); assert.equal(await pending,h.response); assert.equal((await first).status,200)
  await h.attempt.cancel()
  assert.equal(h.liveSession,false)
  assert.equal(h.attempt.remoteCancelled,true)
  assert.equal(h.calls.filter(path => path.endsWith('/exchange')).length,1)
  await h.closed()
})
test('a small difference between the computer and service clocks does not block browser sign-in', async t => {
  const h = fixture(t,{now:() => Date.now()-60000, transformStart:value => ({...value,expiresAtMs:Date.now()+600000})})
  const pending = h.attempt.run()
  // Race the browser-open signal against a refusal, so this regression fails
  // promptly rather than leaving a test waiting for a browser that never opens.
  const outcome = await Promise.race([h.opened.then(url => ({url})),pending])
  assert.ok(outcome.url,JSON.stringify(outcome))
  const callback = h.callback()
  assert.equal(await pending,h.response); assert.equal((await callback).status,200)
  await h.closed()
})
