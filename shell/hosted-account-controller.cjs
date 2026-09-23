'use strict'

const { performance } = require('node:perf_hooks')

// One account transition owner for hosted, local and Google sign-in. Logout
// invalidates the in-flight transition before any awaited reply can commit.
const reasons = Object.freeze({
  HOSTED_ACCOUNT_SIGNIN_REFUSED: 'The email or password was not accepted. Use the same account you use on toolsenabled.ai.',
  HOSTED_ACCOUNT_BUSY: 'A sign-in is already in progress.',
  HOSTED_ACCOUNT_PASSKEY_REQUIRED: 'This account requires a passkey. Continue sign-in in your browser.',
  HOSTED_ACCOUNT_BROWSER_UNAVAILABLE: 'The browser could not complete sign-in. Check your default browser and start again.',
  HOSTED_ACCOUNT_BROWSER_TIMEOUT: 'Browser sign-in timed out. Start again when you are ready.',
  HOSTED_ACCOUNT_SESSION_LIMIT: 'Sign out everywhere on the website, then sign in to this app again.',
  HOSTED_ACCOUNT_STORAGE_UNAVAILABLE: 'The app could not read its saved installation identifier. Check that its data folder is accessible and try again.',
  HOSTED_ACCOUNT_CANCELLED: 'The sign-in was cancelled.',
  HOSTED_ACCOUNT_LOCAL_CLEAR_FAILED: 'The previous saved login could not be removed. Switching accounts was stopped because that saved login still needs to be removed.',
  HOSTED_ACCOUNT_STATUS_UNAVAILABLE: 'Your sign-in could not be verified right now. Check your connection and retry.',
  ACCOUNT_DATA_ERASED: 'Local data removal has started. Restart ToolsEnabled before changing accounts.',
})
const refused = code => ({ ok:false, code, reason:reasons[code] || 'The account service could not complete sign-in. Try again when the connection is available.' })
function createHostedAccountController({ client, store }) {
  let initialized = false
  let refreshPending = null
  let busy = false
  let hostedTransition = false
  let hostedSelected = false
  let revision = 0
  let erased = false
  let erasePending = null
  const operations = new Set()
  const operation = action => (...args) => {
    if (erased) return Promise.resolve(refused('ACCOUNT_DATA_ERASED'))
    let resolve, reject
    const pending = new Promise((yes, no) => { resolve = yes; reject = no })
    operations.add(pending)
    pending.then(() => operations.delete(pending), () => operations.delete(pending))
    try { Promise.resolve(action(...args)).then(resolve, reject) } catch (error) { reject(error) }
    return pending
  }
  async function refresh() {
    if (erased) return refused('ACCOUNT_DATA_ERASED')
    if (!initialized) { initialized = true; hostedSelected = client.hasSession() }
    if (!hostedSelected || busy) return
    if (refreshPending) return refreshPending
    const expected = revision
    refreshPending = (async () => {
      const result = await client.current()
      if (erased || expected !== revision || !hostedSelected) return
      if (result?.ok === false) return result
      const local = store.current()
      if (result.ok && result.signedIn && !local.signedIn) store.signInWithHostedAccount()
      return result
    })()
    try { return await refreshPending } finally { refreshPending = null }
  }
  async function transition(action, hosted = false) {
    if (erased) return refused('ACCOUNT_DATA_ERASED')
    if (busy) return refused('HOSTED_ACCOUNT_BUSY')
    initialized = true
    busy = true
    hostedTransition = hosted
    const expected = ++revision
    const current = () => !erased && expected === revision
    try { return await action(current) } finally { busy = false; hostedTransition = false }
  }
  async function clearHosted(current) {
    hostedSelected = false
    const result = await client.signOut()
    if (!current()) return refused('HOSTED_ACCOUNT_CANCELLED')
    if (result.localCleared === false) return refused('HOSTED_ACCOUNT_LOCAL_CLEAR_FAILED')
    return { ok:true }
  }
  async function finishLocal(result, current) {
    if (!current()) { if (!erased) store.signOut(); return refused('HOSTED_ACCOUNT_CANCELLED') }
    return result
  }
  async function signIn({ username, password } = {}) {
    return transition(async current => {
      if (typeof username !== 'string' || !username.includes('@')) {
        const cleared = await clearHosted(current)
        if (!cleared.ok) return cleared
        return finishLocal(await store.signIn({ username, password }), current)
      }
      hostedSelected = false
      const result = await client.signIn({ email:username.trim(), password })
      if (!current()) return refused('HOSTED_ACCOUNT_CANCELLED')
      if (!result.ok) return refused(result.code)
      const local = store.signInWithHostedAccount()
      if (!local.ok) { await client.signOut(); return local }
      hostedSelected = true
      return local
    }, typeof username === 'string' && username.includes('@'))
  }
  async function signInGoogle(runVerifiedFlow, { existingOnly = false } = {}) {
    return transition(async current => {
      const cleared = await clearHosted(current)
      if (!cleared.ok) return cleared
      const outcome = await runVerifiedFlow()
      if (!current()) return refused('HOSTED_ACCOUNT_CANCELLED')
      if (!outcome?.ok) return outcome || refused('HOSTED_ACCOUNT_CANCELLED')
      const result = await finishLocal(await store.signInWithGoogle({identity:outcome.identity, existingOnly}), current)
      if (!result.ok) return result
      return { ...result, usedTestProvider:outcome.usedTestProvider === true }
    })
  }
  async function signInHostedGoogle() {
    return transition(async current => {
      hostedSelected = false
      const result = await client.signInBrowser({ provider:'google' })
      if (!current()) return refused('HOSTED_ACCOUNT_CANCELLED')
      if (!result.ok) return refused(result.code)
      const local = store.signInWithHostedAccount()
      if (!local.ok) { await client.signOut(); return local }
      hostedSelected = true
      return local
    }, true)
  }
  async function current() {
    // A failed online verification grants no authority, but does not establish
    // that the saved session ended. Keep that distinction on the renderer read.
    let result
    try { result = await refresh() } catch { return refused('HOSTED_ACCOUNT_STATUS_UNAVAILABLE') }
    if (result?.ok === false) return refused('HOSTED_ACCOUNT_STATUS_UNAVAILABLE')
    return store.currentForRenderer()
  }
  function cancelSignIn() {
    if (!busy || (hostedTransition && client.hasPendingSignIn?.() === false)) {
      return Promise.resolve({ ok:true, cancelled:false })
    }
    revision++
    return client.cancelSignIn?.()
  }
  async function signOut() {
    initialized = true
    revision++
    hostedSelected = false
    const local = store.signOut()
    const remote = await client.signOut()
    return { ...local, remoteEnded:remote.remoteEnded, ...(remote.localCleared === false ? { localCleared:false } : {}) }
  }
  async function signOutEverywhere() {
    const hosted = hostedSelected || client.hasSession()
    initialized = true
    revision++
    hostedSelected = false
    if (!hosted) return store.signOutEverywhere()
    const local = store.signOut()
    const remote = await client.signOutEverywhere()
    return { ...local, allRequested:true, revoked:remote.revoked === true, remoteEnded:remote.remoteEnded,
      stepUpRequired:remote.stepUpRequired === true, ...(remote.localCleared === false ? {localCleared:false} : {}) }
  }
  function sealForErase({ timeoutMs = 8000 } = {}) {
    if (erasePending) return erasePending
    erased = true
    initialized = true
    hostedSelected = false
    revision++
    const boundedMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 8000) : 8000
    const deadline = performance.now() + boundedMs
    let resolveSeal
    erasePending = new Promise(resolve => { resolveSeal = resolve })
    let localRevocation = { ok:false, revoked:false }
    try { localRevocation = store.signOutEverywhere() } catch {}
    let revoked = Object.freeze({ ok:false, revoked:localRevocation?.revoked === true,
      localRevoked:localRevocation?.revoked === true, remoteEnded:false,
      reason:'Remote sign-out has not been confirmed.' })
    const failed = () => Object.freeze({ ok:false, sealed:true, localQuiesced:false,
      code:'ACCOUNT_RESET_QUIESCE_UNCONFIRMED', reason:'Account writer cleanup could not be confirmed. Restart ToolsEnabled before retrying.', revoked })
    const timer = setTimeout(() => resolveSeal(failed()), boundedMs)
    let storeClosed, clientClosed
    // Both seals start synchronously, before awaiting a provider or expensive
    // password operation. A damaged sign-in can fail revocation while these
    // independent writer gates still establish local cleanup.
    try { storeClosed = store.sealForErase({ timeoutMs:boundedMs }) }
    catch { storeClosed = Promise.resolve(null) }
    try { clientClosed = client.sealForErase({ timeoutMs:boundedMs }) }
    catch { clientClosed = Promise.resolve(null) }
    const cleanup = (async () => {
      const [local, remote] = await Promise.all([storeClosed, clientClosed])
      if (remote?.revoked) revoked = Object.freeze({ ...remote.revoked,
        ok:localRevocation?.ok === true && remote.revoked.ok === true,
        revoked:localRevocation?.revoked === true || remote.revoked.revoked === true,
        localRevoked:localRevocation?.revoked === true })
      if (local?.ok !== true || local.sealed !== true || local.localQuiesced !== true
          || remote?.ok !== true || remote.sealed !== true || remote.localQuiesced !== true) return failed()
      while (operations.size) await Promise.allSettled([...operations])
      if (busy || refreshPending || performance.now() >= deadline) return failed()
      return Object.freeze({ ok:true, sealed:true, localQuiesced:true, revoked })
    })()
    cleanup.then(result => { clearTimeout(timer); resolveSeal(result) }, () => { clearTimeout(timer); resolveSeal(failed()) })
    return erasePending
  }
  return Object.freeze({ signIn:operation(signIn), signInGoogle:operation(signInGoogle),
    signInHostedGoogle:operation(signInHostedGoogle), current:operation(current), signOut:operation(signOut),
    signOutEverywhere:operation(signOutEverywhere), refresh:operation(refresh), cancelSignIn:operation(cancelSignIn), sealForErase })
}
module.exports = { createHostedAccountController }
