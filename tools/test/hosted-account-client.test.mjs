import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import clientModule from '../../shell/hosted-account-client.cjs'
const { createHostedAccountClient } = clientModule
const token = 'fixture_session_cookie_value_0123456789'
const account = { id: 'account-fixture', email: 'person@example.invalid', privateServerField: 'must-not-cross' }
test('Google is offered only when the hosted service confirms its desktop browser protocol', async () => {
  for (const value of [{ google:true }, { google:false, desktopBrowser:1 }, { google:true, desktopBrowser:2 }, { google:true, desktopBrowser:1 }]) {
    const client = createHostedAccountClient({ fetchImpl:async(url,options) => {
      assert.equal(url,'https://app.toolsenabled.ai/v1/auth/methods')
      assert.equal(options.headers.Cookie,undefined)
      return new Response(JSON.stringify(value),{status:200})
    } })
    const result = await client.googleAvailability()
    assert.equal(result.available,value.google === true && value.desktopBrowser === 1)
    assert.equal(client.hasSession(),false)
    assert.equal(client.verifiedAccount(),null)
  }
})
async function service(t, handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return (url, options) => {
    assert.equal(new URL(url).origin, 'https://app.toolsenabled.ai')
    return fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options)
  }
}
const send = (res, status, body, cookie) => { res.writeHead(status, { 'Content-Type': 'application/json', ...(cookie ? { 'Set-Cookie': cookie } : {}) }); res.end(JSON.stringify(body)) }
const validCookie = `__Host-te_desktop=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 2099 00:00:00 GMT`
test('late cancellation cannot revoke a completed login or delete its persisted session', async () => {
  const methods = []
  let saved = null, clears = 0
  const client = createHostedAccountClient({ sessionStorage: {
    clear() { clears++; saved = null; return true }, read: () => saved,
    write(value) { saved = value; return true },
  }, fetchImpl: async (_url, options) => {
    methods.push(options.method)
    return new Response(JSON.stringify({ account }), { status: 200, headers: { 'set-cookie': validCookie } })
  } })
  assert.equal((await client.signIn({ email: account.email, password: 'fixture' })).ok, true)
  const admitted = saved, before = clears
  const result = await client.cancelSignIn()
  assert.equal(result.cancelled, false)
  assert.equal(client.hasSession(), true)
  assert.equal(saved, admitted)
  assert.equal(clears, before)
  assert.deepEqual(methods, ['POST'])
})
test('hosted login, identity read and logout use one private session and project only account identity', async t => {
  const seen = []
  const fetchImpl = await service(t, (req, res) => {
    seen.push({ method: req.method, path: req.url, cookie: req.headers.cookie })
    if (req.method === 'POST') return send(res, 200, { account }, validCookie)
    if (req.method === 'DELETE') return send(res, 200, { ok: true })
    send(res, 200, { account })
  })
  const client = createHostedAccountClient({ fetchImpl })
  const signedIn = await client.signIn({ email: account.email, password: 'fixture-password' })
  assert.deepEqual(signedIn, { ok: true, signedIn: true, account: { id: account.id, email: account.email } })
  assert.deepEqual(await client.current(), signedIn)
  assert.deepEqual(await client.signOut(), { ok: true, signedIn: false, remoteEnded: true })
  assert.deepEqual(await client.current(), { ok: true, signedIn: false })
  assert.deepEqual(seen, [
    { method: 'POST', path: '/v1/desktop/sessions', cookie: undefined },
    { method: 'GET', path: '/v1/desktop/account', cookie: `__Host-te_desktop=${token}` },
    { method: 'DELETE', path: '/v1/desktop/sessions', cookie: `__Host-te_desktop=${token}` },
  ])
  assert.equal(JSON.stringify(signedIn).includes(token), false)
})
test('revoked hosted session becomes signed out', async t => {
  const fetchImpl = await service(t, (req, res) => send(res, req.method === 'POST' ? 200 : 401, { account }, req.method === 'POST' ? validCookie : null))
  const client = createHostedAccountClient({ fetchImpl })
  assert.equal((await client.signIn({ email: account.email, password: 'fixture' })).ok, true)
  assert.deepEqual(await client.current(), { ok: true, signedIn: false })
})
for (const action of ['signOut', 'cancelSignIn']) test(`${action} cancels an in-flight login and never resurrects its session`, async t => {
  let arrived
  const arrival = new Promise(resolve => { arrived = resolve })
  let pending
  const fetchImpl = await service(t, (req, res) => { pending = res; arrived() })
  const client = createHostedAccountClient({ fetchImpl })
  const login = client.signIn({ email: account.email, password: 'fixture' })
  await arrival
  assert.equal(client.hasPendingSignIn(), true)
  assert.deepEqual(await client[action](), { ok: true, signedIn: false, remoteEnded: false })
  send(pending, 200, { account }, validCookie)
  assert.deepEqual(await login, { ok: false, code: 'HOSTED_ACCOUNT_CANCELLED' })
  assert.deepEqual(await client.current(), { ok: true, signedIn: false })
  assert.equal(client.hasPendingSignIn(), false)
})
for (const [name, handler, code] of [
  ['redirect', (_req,res) => { res.writeHead(302,{Location:'https://example.invalid'});res.end() }, 'HOSTED_ACCOUNT_REDIRECT_REFUSED'],
  ['oversized body', (_req,res) => res.end('a'.repeat(128*1024+1)), 'HOSTED_ACCOUNT_RESPONSE_TOO_LARGE'],
  ['insecure cookie', (_req,res) => send(res,200,{account},`__Host-te_desktop=${token}; Path=/; HttpOnly`), 'HOSTED_ACCOUNT_RESPONSE_INVALID'],
  ['wrong password', (_req,res) => send(res,401,{error:{message:'private server diagnostics'}}), 'HOSTED_ACCOUNT_SIGNIN_REFUSED'],
  ['passkey required', (_req,res) => send(res,403,{error:{code:'PASSKEY_REQUIRED'}}), 'HOSTED_ACCOUNT_PASSKEY_REQUIRED'],
  ['desktop capacity reached', (_req,res) => send(res,409,{error:{code:'DESKTOP_SESSION_LIMIT'}}), 'HOSTED_ACCOUNT_SESSION_LIMIT'],
  ['browser cookie in a desktop reply', (_req,res) => send(res,200,{account},validCookie.replace('__Host-te_desktop','__Host-te_session')), 'HOSTED_ACCOUNT_RESPONSE_INVALID'],
]) test(`hosted client refuses ${name} without accepting a session`, async t => {
  const client = createHostedAccountClient({ fetchImpl: await service(t, handler) })
  assert.deepEqual(await client.signIn({ email: account.email, password: 'fixture' }), { ok: false, code })
  assert.deepEqual(await client.current(), { ok: true, signedIn: false })
})
test('deadline remains active while response body stalls', async t => {
  const client = createHostedAccountClient({ timeoutMs: 50, fetchImpl: await service(t, (_req,res) => { res.writeHead(200,{'Content-Type':'application/json'});res.write('{') }) })
  assert.deepEqual(await client.signIn({ email: account.email, password: 'fixture' }), { ok: false, code: 'HOSTED_ACCOUNT_UNAVAILABLE' })
})

test('cached hosted identity expires and cannot authorize through a failed refresh', async t => {
  let at = 1000
  let fail = false
  const client = createHostedAccountClient({ now: () => at, fetchImpl: await service(t, (req,res) => send(res, fail ? 503 : 200, { account }, req.method === 'POST' ? validCookie : null)) })
  assert.equal((await client.signIn({email:account.email,password:'fixture'})).ok,true)
  assert.equal(client.verifiedAccount().id,account.id)
  at += 60000
  assert.equal(client.verifiedAccount(),null)
  assert.equal((await client.current()).ok,true)
  assert.equal(client.verifiedAccount().id,account.id)
  fail = true
  assert.equal((await client.current()).ok,false)
  assert.equal(client.verifiedAccount(),null)
})

for (const operation of ['current', 'authorizeDeviceSettings']) test(`${operation} refuses a response received after hosted session expiry`, async t => {
  let at = 1700000000000
  const expiresAt = at + 30000
  let arrived, pending
  const arrival = new Promise(resolve => { arrived = resolve })
  const device = { deviceId: 'fixture-device', pairId: 'fixture-pair' }
  const fetchImpl = await service(t, (req, res) => {
    if (req.method === 'POST') {
      return send(res, 200, { account }, `__Host-te_desktop=${token}; Path=/; Secure; HttpOnly; Expires=${new Date(expiresAt).toUTCString()}`)
    }
    pending = res
    arrived()
  })
  const client = createHostedAccountClient({ now: () => at, fetchImpl })
  assert.equal((await client.signIn({ email: account.email, password: 'fixture' })).ok, true)
  at = expiresAt - 1
  const reading = operation === 'current' ? client.current() : client.authorizeDeviceSettings(device)
  await arrival
  at = expiresAt
  send(pending, 200, { account, authorized: true, ...device })
  assert.deepEqual(await reading, operation === 'current'
    ? { ok: true, signedIn: false }
    : { ok: false, code: 'HOSTED_ACCOUNT_SIGNIN_REQUIRED' })
  assert.equal(client.verifiedAccount(), null)
  assert.equal(client.hasSession(), false)
})

test('restart restores a saved cookie only after the service revalidates its bound account', async t => {
  let saved = null
  const sessionStorage = { read:()=>saved, write:value=>{saved=structuredClone(value);return true}, clear:()=>{saved=null;return true} }
  const fetchImpl=await service(t,(req,res)=>send(res,200,{account},req.method==='POST'?validCookie:null))
  const first=createHostedAccountClient({fetchImpl,sessionStorage})
  assert.equal((await first.signIn({email:account.email,password:'fixture'})).ok,true)
  assert.equal(first.sessionPersisted(),true)
  const second=createHostedAccountClient({fetchImpl,sessionStorage})
  assert.equal(second.verifiedAccount(),null)
  assert.equal((await second.current()).signedIn,true)
  assert.equal(second.verifiedAccount().id,account.id)
  assert.equal((await second.signOut()).remoteEnded,true)
  const third=createHostedAccountClient({fetchImpl,sessionStorage})
  assert.deepEqual(await third.current(),{ok:true,signedIn:false})
})
test('saved session cannot restore a different account returned by the service', async t => {
  const sessionStorage={read:()=>({version:1,origin:'https://app.toolsenabled.ai',cookie:`__Host-te_desktop=${token}`,accountId:'another-account',expiresAtMs:Date.now()+60000}),clear:()=>true}
  const client=createHostedAccountClient({sessionStorage,fetchImpl:await service(t,(_req,res)=>send(res,200,{account}))})
  assert.deepEqual(await client.current(),{ok:false,code:'HOSTED_ACCOUNT_RESPONSE_INVALID'})
  assert.equal(client.verifiedAccount(),null)
})
test('offline sign-out clears saved credentials and reports remote revocation as unconfirmed', async t => {
  let saved=null,offline=false
  const sessionStorage={read:()=>saved,write:value=>{saved=value;return true},clear:()=>{saved=null;return true}}
  const network=await service(t,(_req,res)=>send(res,200,{account},validCookie))
  const fetchImpl=(...args)=>{if(offline)throw Error('private network detail');return network(...args)}
  const client=createHostedAccountClient({fetchImpl,sessionStorage})
  assert.equal((await client.signIn({email:account.email,password:'fixture'})).ok,true)
  offline=true
  assert.deepEqual(await client.signOut(),{ok:true,signedIn:false,remoteEnded:false})
  assert.equal(saved,null)
  assert.deepEqual(await createHostedAccountClient({fetchImpl,sessionStorage}).current(),{ok:true,signedIn:false})
})
test('failure to clear a previous saved session refuses a replacement login',async()=>{
 let requests=0
 const client=createHostedAccountClient({sessionStorage:{clear(){throw Error('unwritable')}},fetchImpl:()=>{requests++;throw Error('must not call')}})
 assert.deepEqual(await client.signIn({email:account.email,password:'fixture'}),{ok:false,code:'HOSTED_ACCOUNT_LOCAL_CLEAR_FAILED'})
 assert.equal(requests,0)
})

test('sign out everywhere uses the account-wide endpoint and requires a confirmed revocation reply',async t=>{
 let ended=false
 const client=createHostedAccountClient({fetchImpl:await service(t,(req,res)=>{
  if(req.method==='POST')return send(res,200,{account},validCookie)
  assert.equal(req.url,'/v1/desktop/sessions/all')
  assert.equal(req.headers.cookie,`__Host-te_desktop=${token}`)
  ended=true
  send(res,200,{signedOut:true,revoked:true})
 })})
 assert.equal((await client.signIn({email:account.email,password:'fixture'})).ok,true)
 assert.deepEqual(await client.signOutEverywhere(),{ok:true,signedIn:false,remoteEnded:true,allRequested:true,revoked:true,stepUpRequired:false})
 assert.equal(ended,true)
 assert.equal(client.verifiedAccount(),null)
})
test('protected account-wide logout reports passkey requirement without claiming other sessions ended',async t=>{
 const client=createHostedAccountClient({fetchImpl:await service(t,(req,res)=>{
  if(req.method==='POST')return send(res,200,{account},validCookie)
  send(res,403,{error:{code:'PASSKEY_REQUIRED'}})
 })})
 assert.equal((await client.signIn({email:account.email,password:'fixture'})).ok,true)
 assert.deepEqual(await client.signOutEverywhere(),{ok:true,signedIn:false,remoteEnded:false,allRequested:true,revoked:false,stepUpRequired:true})
 assert.deepEqual(await client.current(),{ok:true,signedIn:false})
})
