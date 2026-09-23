'use strict'

// Main-process transport for the same account service used by the website.
// The session cookie stays in this closure. Callers receive an explicit account
// projection, never response headers, session tokens, or server exceptions.
const ORIGIN = 'https://app.toolsenabled.ai'
const COOKIE = '__Host-te_desktop'
const crypto = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { createHostedBrowserSignIn } = require('./hosted-browser-signin.cjs')
const MAX_BODY = 128 * 1024
const refusal = code => Object.freeze({ ok: false, code })
function accountProjection(value) {
  if (!value || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)
      || typeof value.email !== 'string' || value.email.length > 254
      || !/^[^\s@]+@[^\s@]+$/.test(value.email)) return null
  return Object.freeze({ id: value.id, email: value.email })
}
function sessionCookie(headers) {
  const cookies = headers.getSetCookie()
  const matches = cookies.filter(value => value.startsWith(`${COOKIE}=`))
  if (matches.length !== 1) return null
  const parts = matches[0].split(';').map(value => value.trim())
  if (!new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{32,512}$`).test(parts[0])) return null
  const attributes = parts.slice(1).map(value => value.toLowerCase())
  if (!attributes.includes('secure') || !attributes.includes('httponly')
      || !attributes.includes('path=/') || attributes.some(value => value.startsWith('domain='))) return null
  const expires = parts.slice(1).filter(value => /^expires=/i.test(value))
  const expiresAtMs = expires.length === 1 ? Date.parse(expires[0].slice(8)) : NaN
  if (!Number.isFinite(expiresAtMs)) return null
  return { cookie: parts[0], expiresAtMs }
}
function createHostedAccountClient({ fetchImpl = globalThis.fetch, timeoutMs = 15000, now = Date.now, sessionStorage = null,
  openExternal = null } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid account transport')
  let verified = null
  let verifiedAt = 0
  const remember = account => { verified = account; verifiedAt = now() }
  const verifiedAccount = () => {
    const at = now()
    // A fresh identity read cannot extend the session that authorized it.
    return cookie && verified && at >= verifiedAt && at < expiresAtMs && at - verifiedAt < 60000 ? verified : null
  }
  let restored = false
  let persisted = false
  let boundAccountId = null
  let expiresAtMs = 0
  let installationId = null
  let erased = false
  let erasePending = null
  let restoreUnconfirmed = false
  let requestCleanupUnconfirmed = false
  const cleanupPermit = Object.freeze({})
  const operations = new Set()
  const requests = new Set()
  const failedResponses = new Set()
  function track(action, pendingSet) {
    let resolve, reject
    const pending = new Promise((yes, no) => { resolve = yes; reject = no })
    pendingSet.add(pending)
    pending.then(() => pendingSet.delete(pending), () => pendingSet.delete(pending))
    try { Promise.resolve(action()).then(resolve, reject) } catch (error) { reject(error) }
    return pending
  }
  const operation = action => (...args) => erased
    ? Promise.resolve(refusal('ACCOUNT_DATA_ERASED'))
    : track(() => action(...args), operations)
  function clearSaved(permit) {
    if (erased && permit !== cleanupPermit) return false
    persisted = false
    try { return sessionStorage ? sessionStorage.clear() === true : true } catch { return false }
  }
  function retainedSessionStatus(value) {
    if (value == null) return 'signed-out'
    if (!value || value.version !== 1 || value.origin !== ORIGIN
        || typeof value.cookie !== 'string' || !new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{32,512}$`).test(value.cookie)
        || typeof value.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.accountId)
        || !Number.isSafeInteger(value.expiresAtMs)) return 'invalid'
    return value.expiresAtMs <= now() ? 'expired' : 'unverified'
  }
  function restore() {
    if (restored || erased) return
    restored = true
    let value
    try { value = sessionStorage?.read() } catch { restoreUnconfirmed = true; return }
    if (retainedSessionStatus(value) !== 'unverified') {
      if (value != null) restoreUnconfirmed = true
      return
    }
    cookie = value.cookie
    boundAccountId = value.accountId
    expiresAtMs = value.expiresAtMs
    persisted = true
  }
  // Observe the authoritative cache if initialized; otherwise inspect storage
  // without consuming restore, adopting a credential, or attempting verification.
  function observeSession() {
    const result = (status, account = null) => Object.freeze({ status, account })
    if (erased) return result('erased')
    if (restored) {
      if (!cookie) return result(restoreUnconfirmed ? 'unavailable' : 'signed-out')
      if (expiresAtMs <= now()) return result('expired')
      const account = verifiedAccount()
      return result(account ? 'current' : 'unverified', account)
    }
    let record
    try {
      if (typeof sessionStorage?.observe === 'function') record = sessionStorage.observe()
      else {
        const value = sessionStorage?.read()
        record = value == null ? { status: 'absent' } : { status: 'present', value }
      }
    } catch { return result('unavailable') }
    if (record?.status === 'absent') return result('signed-out')
    if (record?.status !== 'present') return result('unavailable')
    // A present record decoding to null is malformed, not an absent session.
    return result(record.value == null ? 'invalid' : retainedSessionStatus(record.value))
  }
  let cookie = null
  let generation = 0
  let signingIn = false
  let browserAttempt = null
  const controllers = new Set()
  function expireSession() {
    if (!cookie || expiresAtMs > now()) return false
    cookie = null
    verified = null
    generation++
    clearSaved()
    return true
  }
  function request(route, options = {}, permit) {
    if (erased && permit !== cleanupPermit) return Promise.resolve(refusal('ACCOUNT_DATA_ERASED'))
    return track(() => runRequest(route, options), requests)
  }
  async function runRequest(route, { method = 'GET', body, session = cookie } = {}) {
    const controller = new AbortController()
    controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let reader, response, responseBody
    try {
      response = await fetchImpl(ORIGIN + route, {
        method, redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: { Accept: 'application/json', Origin: ORIGIN,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(session ? { Cookie: session } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      responseBody = response.body
      if (response.status >= 300 && response.status < 400) return refusal('HOSTED_ACCOUNT_REDIRECT_REFUSED')
      reader = responseBody?.getReader()
      if (!reader) return refusal('HOSTED_ACCOUNT_RESPONSE_INVALID')
      const chunks = []
      let size = 0
      for (;;) {
        const item = await reader.read()
        if (item.done) break
        size += item.value.byteLength
        if (size > MAX_BODY) return refusal('HOSTED_ACCOUNT_RESPONSE_TOO_LARGE')
        chunks.push(Buffer.from(item.value))
      }
      if (controller.signal.aborted) return refusal('HOSTED_ACCOUNT_UNAVAILABLE')
      let value
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { return refusal('HOSTED_ACCOUNT_RESPONSE_INVALID') }
      return { ok: true, status: response.status, value, headers: response.headers }
    } catch { return refusal('HOSTED_ACCOUNT_UNAVAILABLE') }
    finally {
      clearTimeout(timer)
      controller.abort()
      // A completed fetch does not prove its response stream has closed. Keep
      // the request owned until cancellation settles, including during Erase.
      let closed = true
      try {
        if (reader) await reader.cancel()
        else {
          // Redirects and malformed-reader replies can return before a reader
          // is acquired. Their unread native body is still an owned resource.
          responseBody ||= response?.body
          if (responseBody) {
            if (responseBody.locked || typeof responseBody.cancel !== 'function') throw new Error('Response cleanup unavailable')
            await responseBody.cancel()
          }
        }
      } catch {
        requestCleanupUnconfirmed = true
        closed = false
        failedResponses.add({ response, body:responseBody, reader, controller })
      }
      if (closed) controllers.delete(controller)
    }
  }
  async function browserSession(provider) {
    if (erased) return refusal('ACCOUNT_DATA_ERASED')
    if (typeof openExternal !== 'function') return refusal('HOSTED_ACCOUNT_BROWSER_UNAVAILABLE')
    const attempt = createHostedBrowserSignIn({ installationId, provider,
      request:(route, options) => request(route, options, route === '/v1/desktop/auth/cancel' ? cleanupPermit : undefined),
      openExternal: address => {
        if (erased) return Promise.reject(new Error('Account data erased'))
        // The browser-flow cancellation race closes its listener, but the
        // actual OS opener remains owned until its own promise settles.
        return track(() => openExternal(address), operations)
      }, now })
    browserAttempt = attempt
    return attempt.run()
  }
  async function login({ email, password, browserProvider } = {}) {
    if (erased) return refusal('ACCOUNT_DATA_ERASED')
    if (signingIn) return refusal('HOSTED_ACCOUNT_BUSY')
    if (browserProvider ? !['google','password'].includes(browserProvider)
      : typeof email !== 'string' || email.length > 254 || typeof password !== 'string' || password.length > 4096) return refusal('HOSTED_ACCOUNT_INPUT_INVALID')
    try {
      installationId ||= sessionStorage?.installationId ? sessionStorage.installationId() : crypto.randomUUID()
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(installationId)) throw new Error('Invalid installation')
    } catch { return refusal('HOSTED_ACCOUNT_STORAGE_UNAVAILABLE') }
    restored = true
    if (!clearSaved()) return refusal('HOSTED_ACCOUNT_LOCAL_CLEAR_FAILED')
    signingIn = true
    const expected = ++generation
    cookie = null
    verified = null
    try {
      let result = browserProvider ? await browserSession(browserProvider)
        : await request('/v1/desktop/sessions', { method: 'POST', body: { email, password, installationId }, session: null })
      if (erased || generation !== expected) return refusal('HOSTED_ACCOUNT_CANCELLED')
      if (!browserProvider && result.ok && result.status === 403 && result.value?.error?.code === 'PASSKEY_REQUIRED'
          && typeof openExternal === 'function') {
        result = await browserSession('password')
        if (erased || generation !== expected) return refusal('HOSTED_ACCOUNT_CANCELLED')
      }
      if (!result.ok) return result
      if (result.status !== 200) {
        if (result.status === 403 && result.value?.error?.code === 'PASSKEY_REQUIRED') return refusal('HOSTED_ACCOUNT_PASSKEY_REQUIRED')
        if (result.status === 409 && result.value?.error?.code === 'DESKTOP_SESSION_LIMIT') return refusal('HOSTED_ACCOUNT_SESSION_LIMIT')
        return refusal(result.status === 401 ? 'HOSTED_ACCOUNT_SIGNIN_REFUSED' : 'HOSTED_ACCOUNT_UNAVAILABLE')
      }
      const account = accountProjection(result.value?.account)
      const received = sessionCookie(result.headers)
      if (!account || !received || received.expiresAtMs <= now()) return refusal('HOSTED_ACCOUNT_RESPONSE_INVALID')
      if (erased || generation !== expected) return refusal('HOSTED_ACCOUNT_CANCELLED')
      cookie = received.cookie
      expiresAtMs = received.expiresAtMs
      boundAccountId = account.id
      try { persisted = sessionStorage?.write({ version:1, origin:ORIGIN, cookie, accountId:account.id, expiresAtMs }) === true } catch { persisted = false }
      remember(account)
      return Object.freeze({ ok: true, signedIn: true, account })
    } finally {
      // Retain the attempt until the account projection and storage commit.
      // A malformed/lost reply or logout in this interval must revoke the
      // issued login even after the loopback exchange itself has completed.
      if (browserAttempt && (generation !== expected || !cookie)) await browserAttempt.cancel()
      browserAttempt = null
      signingIn = false
    }
  }
  const signIn = operation(({ email, password } = {}) => login({ email, password }))
  const signInBrowser = operation(({ provider = 'google' } = {}) => login({ browserProvider:provider }))
  async function current() {
    if (erased) return refusal('ACCOUNT_DATA_ERASED')
    restore()
    expireSession()
    if (!cookie) return Object.freeze({ ok: true, signedIn: false })
    const expected = generation
    const result = await request('/v1/desktop/account')
    if (erased || generation !== expected) return refusal('HOSTED_ACCOUNT_CANCELLED')
    if (expireSession()) return Object.freeze({ ok: true, signedIn: false })
    if (!result.ok) { verified = null; return result }
    if (result.status === 401) { cookie = null; verified = null; generation++; clearSaved(); return Object.freeze({ ok: true, signedIn: false }) }
    if (result.status !== 200) { verified = null; return refusal('HOSTED_ACCOUNT_UNAVAILABLE') }
    const account = accountProjection(result.value?.account)
    if (!account || account.id !== boundAccountId) { verified = null; return refusal('HOSTED_ACCOUNT_RESPONSE_INVALID') }
    remember(account)
    return Object.freeze({ ok: true, signedIn: true, account })
  }
  async function authorizeDeviceSettings({ deviceId, pairId } = {}) {
    if (![deviceId, pairId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))) {
      return refusal('HOSTED_ACCOUNT_DEVICE_REFUSED')
    }
    restore()
    expireSession()
    if (!cookie) return refusal('HOSTED_ACCOUNT_SIGNIN_REQUIRED')
    const expected = generation
    const result = await request('/v1/desktop/device-settings-access?deviceId=' + encodeURIComponent(deviceId)
      + '&pairId=' + encodeURIComponent(pairId))
    if (erased || generation !== expected) return refusal('HOSTED_ACCOUNT_CANCELLED')
    if (expireSession()) return refusal('HOSTED_ACCOUNT_SIGNIN_REQUIRED')
    if (!result.ok) return result
    if (result.status === 401) {
      cookie = null; verified = null; generation++; clearSaved()
      return refusal('HOSTED_ACCOUNT_SIGNIN_REQUIRED')
    }
    if (result.status === 404 && result.value?.error?.code === 'DEVICE_SETTINGS_REFUSED') return refusal('HOSTED_ACCOUNT_DEVICE_REFUSED')
    if ([403, 404].includes(result.status)) return refusal('HOSTED_ACCOUNT_DEVICE_CHECK_UNAVAILABLE')
    if (result.status !== 200) return refusal('HOSTED_ACCOUNT_UNAVAILABLE')
    const account = accountProjection(result.value?.account)
    if (!account || account.id !== boundAccountId || result.value?.authorized !== true
      || result.value.deviceId !== deviceId || result.value.pairId !== pairId) return refusal('HOSTED_ACCOUNT_RESPONSE_INVALID')
    remember(account)
    return Object.freeze({ ok: true, accountId: account.id })
  }
  async function endSession(everywhere) {
    if (erased) return refusal('ACCOUNT_DATA_ERASED')
    restore()
    const localCleared = clearSaved()
    const prior = cookie
    verified = null
    const loginMayHaveReachedService = signingIn
    const pendingBrowser = browserAttempt
    cookie = null
    generation++
    for (const controller of controllers) controller.abort()
    if (pendingBrowser) await pendingBrowser.cancel()
    if (!prior) return Object.freeze({ ok: true, signedIn: false,
      remoteEnded: !loginMayHaveReachedService || pendingBrowser?.remoteCancelled === true,
      ...(everywhere ? { allRequested:true, revoked:false } : {}), ...(localCleared ? {} : { localCleared:false }) })
    const result = await request(everywhere ? '/v1/desktop/sessions/all' : '/v1/desktop/sessions', { method: 'DELETE', session: prior }, cleanupPermit)
    return Object.freeze({ ok: true, signedIn: false, remoteEnded: result.ok && result.status >= 200 && result.status < 300, ...(everywhere ? { allRequested:true, revoked:result.ok && result.status === 200 && result.value?.revoked === true, stepUpRequired:result.ok && result.status === 403 && result.value?.error?.code === 'PASSKEY_REQUIRED' } : {}), ...(localCleared ? {} : { localCleared:false }) })
  }
  const signOut = operation(() => endSession(false))
  // A delayed Cancel from a finished UI attempt is not a logout request.
  // Check synchronously before endSession invalidates or clears any state.
  const cancelSignIn = operation(() => signingIn
    ? endSession(false)
    : Promise.resolve(Object.freeze({ ok:true, cancelled:false })))
  const signOutEverywhere = operation(() => endSession(true))
  async function googleAvailability() {
    const result = await request('/v1/auth/methods', { session:null })
    if (result.ok && result.status === 200 && result.value?.google === true && result.value?.desktopBrowser === 1) {
      return Object.freeze({ ok:true, available:true, source:'hosted-account', testProvider:null })
    }
    return Object.freeze({ ok:false, available:false, code:'HOSTED_ACCOUNT_GOOGLE_UNAVAILABLE',
      reason:'Google sign-in could not be confirmed with the account service. Check your connection and try again.' })
  }
  function sealForErase({ timeoutMs: cleanupTimeoutMs = 8000 } = {}) {
    if (erasePending) return erasePending
    const boundedMs = Number.isInteger(cleanupTimeoutMs) && cleanupTimeoutMs > 0 ? Math.min(cleanupTimeoutMs, 8000) : 8000
    const deadline = performance.now() + boundedMs
    // Read only the existing session. No installation id, service, or login is
    // created to clean up an installation that never selected hosted sign-in.
    restore()
    const prior = cookie
    const loginMayHaveReachedService = signingIn
    const pendingBrowser = browserAttempt
    erased = true
    restored = true
    generation++
    cookie = null
    verified = null
    const localCleared = clearSaved(cleanupPermit)
    for (const controller of controllers) controller.abort()
    let revoked = Object.freeze({ ok:!prior && !restoreUnconfirmed && !loginMayHaveReachedService,
      attempted:Boolean(prior), revoked:false, remoteEnded:false,
      ...(restoreUnconfirmed ? { reason:'The saved hosted sign-in could not be read.' } : {}) })
    const cleanup = (async () => {
      const browserClosed = pendingBrowser ? Promise.resolve(pendingBrowser.cancel()) : Promise.resolve()
      const remote = prior
        ? request('/v1/desktop/sessions/all', { method:'DELETE', session:prior }, cleanupPermit)
        : Promise.resolve(null)
      const [, result] = await Promise.all([browserClosed, remote])
      if (result) {
        const remoteEnded = result.ok && result.status >= 200 && result.status < 300
        revoked = Object.freeze({ ok:remoteEnded, attempted:true,
          revoked:result.ok && result.status === 200 && result.value?.revoked === true,
          remoteEnded, stepUpRequired:result.ok && result.status === 403 && result.value?.error?.code === 'PASSKEY_REQUIRED',
          ...(!remoteEnded ? { reason:'The account service did not confirm remote sign-out.' } : {}) })
      } else if (pendingBrowser?.remoteCancelled === true) {
        revoked = Object.freeze({ ok:true, attempted:true, revoked:false, remoteEnded:true })
      }
      // Cancellation signals are requests, not cleanup receipts. These are the
      // original promises; a timeout leaves them retained until they settle.
      while (operations.size || requests.size) {
        await Promise.allSettled([...operations, ...requests])
      }
      if (requestCleanupUnconfirmed || browserAttempt || signingIn || performance.now() >= deadline) throw new Error('Account cleanup unconfirmed')
      return Object.freeze({ ok:true, sealed:true, localQuiesced:true, localCleared, revoked })
    })()
    erasePending = new Promise(resolve => {
      const failed = () => Object.freeze({ ok:false, sealed:true, localQuiesced:false,
        code:'ACCOUNT_RESET_QUIESCE_UNCONFIRMED', reason:'Account request cleanup could not be confirmed.', revoked })
      const timer = setTimeout(() => {
        for (const controller of controllers) controller.abort()
        resolve(failed())
      }, boundedMs)
      cleanup.then(result => { clearTimeout(timer); resolve(result) }, () => { clearTimeout(timer); resolve(failed()) })
    })
    return erasePending
  }
  return Object.freeze({ signIn, signInBrowser, googleAvailability:operation(googleAvailability), current:operation(current), signOut, signOutEverywhere, cancelSignIn, verifiedAccount, observeSession,
    authorizeDeviceSettings: operation(authorizeDeviceSettings),
    browserAuthorizationAddress: () => browserAttempt?.authorizationAddress || null,
    hasPendingSignIn: () => signingIn,
    hasSession() { restore(); return Boolean(cookie) }, sessionPersisted: () => persisted, sealForErase })
}
module.exports = { createHostedAccountClient }
