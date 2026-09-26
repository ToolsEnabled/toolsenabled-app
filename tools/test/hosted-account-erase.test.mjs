import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createHostedAccountClient } = require('../../shell/hosted-account-client.cjs')
const { createHostedAccountController } = require('../../shell/hosted-account-controller.cjs')
const { createHostedSessionStorage } = require('../../shell/hosted-session-storage.cjs')
const { createAccountStore, REQUIRED_IDENTITY_ASSURANCE } = require('../../shell/product-account.cjs')

const account = { id:'synthetic-reset-account', email:'synthetic-reset@example.invalid' }
const token = 'synthetic_closed_fetch_cookie_'.repeat(2)
const cookie = `__Host-te_desktop=${token}; Path=/; Secure; HttpOnly; Expires=Thu, 01 Jan 2099 00:00:00 GMT`
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const response = (value, status = 200, withCookie = false) => new Response(JSON.stringify(value), {
  status, headers:withCookie ? { 'set-cookie':cookie } : {},
})
function fixture(t, { intercept, openExternal, sessionStorage: suppliedStorage } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-account-erase-'))
  const directory = path.join(scratch, 'profile')
  fs.mkdirSync(directory)
  t.after(() => fs.rmSync(scratch, { recursive:true, force:true }))
  const calls = []
  const safeStorage = { isEncryptionAvailable:() => true,
    encryptString:value => Buffer.from(`fixture:${value}`),
    decryptString:value => { assert.ok(value.toString().startsWith('fixture:')); return value.toString().slice(8) } }
  const sessionStorage = suppliedStorage || createHostedSessionStorage({ directory, safeStorage })
  const client = createHostedAccountClient({ sessionStorage, openExternal, fetchImpl:async (url, options) => {
    const address = new URL(url)
    assert.equal(address.origin, 'https://app.toolsenabled.ai')
    const route = address.pathname
    calls.push({ route, method:options.method })
    const held = intercept?.(route, options)
    if (held !== undefined) return held
    if (options.method === 'DELETE') {
      assert.equal(route, '/v1/desktop/sessions/all')
      assert.equal(options.headers.Cookie, `__Host-te_desktop=${token}`)
      return response({ revoked:true })
    }
    if (route === '/v1/auth/methods') return response({ google:true, desktopBrowser:1 })
    return response({ account }, 200, options.method === 'POST')
  } })
  const store = createAccountStore({ directory, safeStorage, hostedAccount:client })
  const controller = createHostedAccountController({ client, store })
  return { directory, client, store, controller, calls }
}
async function login(subject) {
  const result = await subject.controller.signIn({ username:account.email, password:'synthetic-password' })
  assert.equal(result.ok, true)
  assert.equal(subject.store.current().signedIn, true)
  return result
}
async function stillPending(promise) {
  let settled = false
  promise.then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'cleanup must retain the original unfinished operation')
}

test('actual client, controller and private stores cannot refresh or write erased account files', async t => {
  const subject = fixture(t)
  await login(subject)
  assert.equal(subject.store.putSetting({ key:'mc.theme', value:'black' }).ok, true)
  const result = await subject.controller.sealForErase()
  assert.equal(result.ok, true)
  assert.equal(result.sealed, true)
  assert.equal(result.localQuiesced, true)
  assert.equal(result.revoked.localRevoked, true)
  assert.equal(result.revoked.remoteEnded, true)
  assert.equal(result.revoked.revoked, true)
  assert.equal(subject.client.hasSession(), false)
  assert.equal(subject.client.verifiedAccount(), null)
  assert.equal(subject.client.sessionPersisted(), false)
  assert.deepEqual(subject.calls, [
    { route:'/v1/desktop/sessions', method:'POST' },
    { route:'/v1/desktop/sessions/all', method:'DELETE' },
  ])
  const calls = subject.calls.length
  fs.rmSync(subject.directory, { recursive:true })
  for (const value of [
    await subject.controller.refresh(), await subject.controller.current(),
    await subject.controller.signIn({ username:account.email, password:'synthetic-password' }),
    await subject.controller.signInHostedGoogle(), await subject.controller.signInGoogle(() => { throw Error('must not launch') }),
    await subject.controller.signOut(), await subject.controller.signOutEverywhere(), await subject.controller.cancelSignIn(),
    await subject.client.current(), await subject.client.signIn(), await subject.client.signInBrowser(),
    await subject.client.googleAvailability(), await subject.client.signOut(), await subject.client.cancelSignIn(),
    subject.store.signInWithHostedAccount(), subject.store.putSetting({ key:'mc.theme', value:'black' }),
  ]) assert.equal(value.code, 'ACCOUNT_DATA_ERASED')
  assert.equal(subject.calls.length, calls)
  assert.equal(fs.existsSync(subject.directory), false)
  assert.equal(await subject.controller.sealForErase(), result)
})

test('a never-selected hosted account seals without a service, installation identifier, or account file', async t => {
  let identifiers = 0
  const subject = fixture(t, { sessionStorage:{ read:() => null, clear:() => true,
    installationId() { identifiers++; throw Error('must not enroll during reset') }, write() { throw Error('must not save') } } })
  assert.deepEqual(fs.readdirSync(subject.directory), [])
  const result = await subject.controller.sealForErase()
  assert.equal(result.localQuiesced, true)
  assert.equal(result.revoked.revoked, false)
  assert.equal(result.revoked.remoteEnded, false, 'no remote success is invented for the unused path')
  assert.equal(identifiers, 0)
  assert.deepEqual(subject.calls, [])
  assert.deepEqual(fs.readdirSync(subject.directory), [])
})

test('damaged saved credentials do not prevent proven local writer cleanup or imply remote revocation', async t => {
  const subject = fixture(t)
  fs.writeFileSync(path.join(subject.directory, 'hosted-session.enc'), 'damaged fixture', { mode:0o600 })
  fs.writeFileSync(path.join(subject.directory, 'hosted-product-accounts.json'), '{damaged fixture', { mode:0o600 })
  const result = await subject.controller.sealForErase()
  assert.equal(result.ok, true)
  assert.equal(result.localQuiesced, true)
  assert.equal(result.revoked.ok, false)
  assert.equal(result.revoked.remoteEnded, false)
  assert.deepEqual(subject.calls, [])
  fs.rmSync(subject.directory, { recursive:true })
  assert.equal((await subject.controller.refresh()).code, 'ACCOUNT_DATA_ERASED')
  assert.equal(fs.existsSync(subject.directory), false)
})

for (const outcome of ['unavailable', 'step-up']) test(`settled remote ${outcome} stays separate from local cleanup`, async t => {
  const subject = fixture(t, { intercept:(route, options) => {
    if (options.method !== 'DELETE') return
    if (outcome === 'unavailable') throw Error('private fixture diagnostics must not cross')
    return response({ error:{ code:'PASSKEY_REQUIRED' } }, 403)
  } })
  await login(subject)
  const result = await subject.controller.sealForErase()
  assert.equal(result.ok, true)
  assert.equal(result.localQuiesced, true)
  assert.equal(result.revoked.ok, false)
  assert.equal(result.revoked.remoteEnded, false)
  assert.equal(result.revoked.attempted, true)
  assert.equal(JSON.stringify(result).includes('private fixture diagnostics'), false)
})

test('a refresh already in transport is drained before cleanup, and its late account projection cannot write', async t => {
  const entered = deferred(), release = deferred()
  const subject = fixture(t, { intercept:route => {
    if (route === '/v1/desktop/account') { entered.resolve(); return release.promise }
  } })
  await login(subject)
  const refresh = subject.controller.refresh()
  await entered.promise
  const seal = subject.controller.sealForErase()
  const afterRevocation = fs.readFileSync(path.join(subject.directory, 'hosted-product-accounts.json'))
  await stillPending(seal)
  release.resolve(response({ account }))
  await refresh
  assert.equal((await seal).ok, true)
  assert.deepEqual(fs.readFileSync(path.join(subject.directory, 'hosted-product-accounts.json')), afterRevocation)
  assert.equal(subject.store.current().signedIn, false)
})

test('an ignored abort leaves login cleanup unconfirmed and late credentials cannot persist', async t => {
  const entered = deferred(), release = deferred()
  let signal
  const subject = fixture(t, { intercept:(route, options) => {
    if (route === '/v1/desktop/sessions' && options.method === 'POST') {
      signal = options.signal; entered.resolve(); return release.promise
    }
  } })
  const pending = subject.controller.signIn({ username:account.email, password:'synthetic-password' })
  await entered.promise
  const seal = subject.controller.sealForErase({ timeoutMs:25 })
  const failed = await seal
  assert.equal(signal.aborted, true)
  assert.equal(failed.ok, false)
  assert.equal(failed.localQuiesced, false)
  await stillPending(pending)
  fs.rmSync(subject.directory, { recursive:true })
  release.resolve(response({ account }, 200, true))
  assert.equal((await pending).code, 'HOSTED_ACCOUNT_CANCELLED')
  assert.equal(await subject.controller.sealForErase(), failed)
  assert.equal(fs.existsSync(subject.directory), false)
})

test('an unfinished remote sign-out retains its request and reports an attempted but unconfirmed revoke', async t => {
  const entered = deferred(), release = deferred()
  const subject = fixture(t, { intercept:(_route, options) => {
    if (options.method === 'DELETE') { entered.resolve(); return release.promise }
  } })
  await login(subject)
  const seal = subject.client.sealForErase({ timeoutMs:25 })
  await entered.promise
  const failed = await seal
  assert.equal(failed.localQuiesced, false)
  assert.equal(failed.revoked.attempted, true)
  assert.equal(failed.revoked.remoteEnded, false)
  release.resolve(response({ revoked:true }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await subject.client.sealForErase(), failed)
})

test('a response stream cancellation must settle before request cleanup is acknowledged', async t => {
  const cancelled = deferred(), release = deferred()
  let sent = false
  const subject = fixture(t, { intercept:(_route, options) => {
    if (options.method !== 'POST') return
    return { status:200, headers:new Headers({ 'set-cookie':cookie }), body:{ getReader:() => ({
      async read() { if (sent) return { done:true }; sent = true; return { value:Buffer.from(JSON.stringify({ account })), done:false } },
      cancel() { cancelled.resolve(); return release.promise },
    }) } }
  } })
  const pending = subject.controller.signIn({ username:account.email, password:'synthetic-password' })
  await cancelled.promise
  const seal = subject.controller.sealForErase()
  await stillPending(seal)
  release.resolve()
  assert.equal((await pending).code, 'HOSTED_ACCOUNT_CANCELLED')
  assert.equal((await seal).ok, true)
  assert.equal(fs.existsSync(path.join(subject.directory, 'hosted-session.enc')), false)
})

test('rejected stream cancellation is a cleanup refusal even when the response body was received', async t => {
  let sent = false
  const subject = fixture(t, { intercept:(_route, options) => {
    if (options.method !== 'POST') return
    return { status:200, headers:new Headers({ 'set-cookie':cookie }), body:{ getReader:() => ({
      async read() { if (sent) return { done:true }; sent = true; return { value:Buffer.from(JSON.stringify({ account })), done:false } },
      async cancel() { throw Error('private stream cleanup failure') },
    }) } }
  } })
  await login(subject)
  const result = await subject.controller.sealForErase()
  assert.equal(result.ok, false)
  assert.equal(result.localQuiesced, false)
  assert.equal(JSON.stringify(result).includes('private stream cleanup failure'), false)
})

test('an early redirect cancels its unread native response body before cleanup can succeed', async t => {
  const entered = deferred(), release = deferred()
  let cancellations = 0
  const subject = fixture(t, { intercept:route => {
    if (route !== '/v1/auth/methods') return
    return new Response(new ReadableStream({ cancel() {
      cancellations++; entered.resolve(); return release.promise
    } }), { status:302 })
  } })
  const pending = subject.client.googleAvailability()
  await entered.promise
  const seal = subject.controller.sealForErase()
  await stillPending(seal)
  release.resolve()
  assert.equal((await pending).available, false)
  assert.equal((await seal).localQuiesced, true)
  assert.equal(cancellations, 1)
})

test('a failed reader acquisition still cancels the actual unread body', async t => {
  const entered = deferred(), release = deferred()
  let cancellations = 0
  const subject = fixture(t, { intercept:route => {
    if (route !== '/v1/auth/methods') return
    return { status:200, body:{ getReader() { throw Error('synthetic reader acquisition failed') },
      cancel() { cancellations++; entered.resolve(); return release.promise } } }
  } })
  const pending = subject.client.googleAvailability()
  await entered.promise
  const seal = subject.controller.sealForErase()
  await stillPending(seal)
  release.resolve()
  await pending
  assert.equal((await seal).ok, true)
  assert.equal(cancellations, 1)
})

for (const owner of ['client', 'controller']) test(`${owner} cannot accept cleanup past its monotonic deadline before a delayed timer callback`, async t => {
  const entered = deferred(), release = deferred()
  const subject = fixture(t, { intercept:route => {
    if (route !== '/v1/auth/methods') return
    entered.resolve(); return release.promise
  } })
  const pending = subject.client.googleAvailability()
  await entered.promise
  const seal = subject[owner].sealForErase({ timeoutMs:10 })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
  release.resolve(response({ google:true, desktopBrowser:1 }))
  const result = await seal
  await pending
  assert.equal(result.ok, false)
  assert.equal(result.localQuiesced, false)
})

for (const remoteCancelled of [true, false]) test(`real hosted browser listener closes with remote cancellation ${remoteCancelled ? 'confirmed' : 'unconfirmed'}, while the OS opener remains owned`, async t => {
  const opened = deferred(), openerRelease = deferred()
  const requestId = 'R'.repeat(43)
  let port
  const subject = fixture(t, { openExternal:() => { opened.resolve(); return openerRelease.promise },
    intercept:(route, options) => {
      if (route === '/v1/desktop/auth/start') {
        port = JSON.parse(options.body).callbackPort
        return response({ requestId, expiresAtMs:Date.now() + 60000,
          authorizationUrl:`https://toolsenabled.ai/v1/desktop/auth/browser?request=${requestId}` })
      }
      if (route === '/v1/desktop/auth/cancel') return response({ cancelled:remoteCancelled })
    } })
  const pending = subject.controller.signInHostedGoogle()
  await opened.promise
  const seal = subject.controller.sealForErase()
  assert.equal((await pending).code, 'HOSTED_ACCOUNT_CANCELLED')
  // Binding the actual former port proves the original listener released it;
  // no external browser, service, or HTTP client is used by this fixture.
  const probe = net.createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve) })
  await new Promise(resolve => probe.close(resolve))
  await stillPending(seal)
  openerRelease.resolve()
  const result = await seal
  assert.equal(result.ok, true)
  assert.equal(result.revoked.remoteEnded, remoteCancelled)
  assert.equal(result.revoked.ok, remoteCancelled)
  assert.equal(subject.client.browserAuthorizationAddress(), null)
  assert.equal(subject.client.hasPendingSignIn(), false)
  assert.equal(subject.calls.filter(value => value.route.endsWith('/cancel')).length, 1)
})

test('a pending verified Google transition cannot finish after terminal controller cleanup', async t => {
  const entered = deferred(), release = deferred()
  const subject = fixture(t)
  const pending = subject.controller.signInGoogle(() => { entered.resolve(); return release.promise })
  await entered.promise
  const seal = subject.controller.sealForErase({ timeoutMs:25 })
  const failed = await seal
  assert.equal(failed.localQuiesced, false)
  fs.rmSync(subject.directory, { recursive:true })
  release.resolve({ ok:true, identity:{ provider:'google', subject:'synthetic-google',
    email:'synthetic-google@example.invalid', emailVerified:true, assurance:REQUIRED_IDENTITY_ASSURANCE } })
  assert.equal((await pending).code, 'HOSTED_ACCOUNT_CANCELLED')
  assert.equal(fs.existsSync(subject.directory), false)
  assert.equal(await subject.controller.sealForErase(), failed)
})
