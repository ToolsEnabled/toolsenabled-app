'use strict'
const { createHash, randomUUID } = require('node:crypto')

// Authentication here is the native sender boundary plus the host's existing
// product/local principal. A renderer may compare a context, never choose one.
function createImageOwnerContext({ readState, scope, publish = () => {} }) {
  if (typeof readState !== 'function' || typeof scope !== 'string' || !scope) throw new TypeError('image owner context configuration')
  let signature = null, value = null, mutating = 0
  const fail = () => { throw Object.assign(new Error('Image queue owner context changed; reload its state.'), { code: 'IMAGE_OWNER_CHANGED' }) }
  function read() {
    if (mutating) fail()
    const state = readState()
    if (!state || typeof state.principal !== 'string' || !state.principal || typeof state.signedIn !== 'boolean') fail()
    const next = JSON.stringify([state.principal, state.signedIn, state.session?.id ?? null, state.session?.issuedAtMs ?? null])
    if (signature !== next || !value) {
      signature = next
      value = Object.freeze({ version: 1,
        ownerId: createHash('sha256').update(JSON.stringify([scope, state.principal])).digest('hex'),
        currentEpoch: randomUUID(), kind: state.signedIn ? 'account' : 'local' })
      publish(value)
    }
    return value
  }
  function authenticate(context) {
    const current = read()
    if (!context || context.version !== 1 || context.ownerId !== current.ownerId || context.currentEpoch !== current.currentEpoch) fail()
    return { authenticated: true, productOwnerId: current.ownerId, currentEpoch: current.currentEpoch }
  }
  function beginMutation() {
    mutating++
    value = null
    publish(Object.freeze({ version: 1, invalidated: true }))
    let done = false
    return () => {
      if (done) return
      done = true
      mutating--
      if (!mutating) { try { read() } catch { /* The next authorized read returns the named refusal. */ } }
    }
  }
  return Object.freeze({ read, authenticate, beginMutation })
}
module.exports = { createImageOwnerContext }
