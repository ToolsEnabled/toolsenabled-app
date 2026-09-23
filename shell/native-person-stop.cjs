'use strict'

const { randomUUID } = require('node:crypto')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const validReceipt = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => ['requestId', 'token', 'savedState', 'outcome'].includes(key))
  && typeof value.requestId === 'string' && typeof value.token === 'string'

/* Trusted native-renderer protocol, separate from both remote-owned agent
   commands and delegated tree commands. Only a main-frame IPC can redeem one
   admitted operation's exact close; no target/principal arrives from that IPC. */
function createNativePersonStop({ checkContext, closeSession, send, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 30000 }) {
  const readiness = new WeakMap()
  const operations = new Map()
  const observed = new WeakSet()
  const ready = session => session?.owner && session.owner.isDestroyed?.() !== true && readiness.get(session.owner)?.ready === true
  function finish(operation, result) {
    if (operations.get(operation.request.requestId) !== operation) return
    clearTimer(operation.timer)
    operations.delete(operation.request.requestId)
    operation.resolve(result)
  }
  function lostSurface(operation) {
    operation.surfaceLost = true
    if (!operation.claimed) finish(operation, { outcome: 'not-sent', closed: false, code: 'MC_AGENT_DESKTOP_STOP_UNAVAILABLE' })
    else if (operation.closeSettled) finish(operation, operation.closeDispatched
      ? { closed: operation.closed, savedState: 'unconfirmed' }
      : { outcome: 'not-sent', closed: false, code: 'MC_AGENT_DESKTOP_STOP_UNAVAILABLE' })
  }
  function setReady(owner, value) {
    if (!observed.has(owner)) {
      observed.add(owner)
      owner.once?.('destroyed', () => setReady(owner, false))
      owner.on?.('render-process-gone', () => setReady(owner, false))
      owner.on?.('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) setReady(owner, false) })
    }
    const previous = readiness.get(owner)
    readiness.set(owner, { ready: value === true, generation: (previous?.generation || 0) + 1 })
    for (const operation of operations.values()) if (operation.session.owner === owner) lostSurface(operation)
    return { ok: true }
  }
  function dispatch(admission) {
    if (!ready(admission.session)) fail('MC_AGENT_DESKTOP_STOP_UNAVAILABLE')
    if (operations.has(admission.request.requestId)) fail('MC_AGENT_DESKTOP_STOP_PENDING')
    let resolve
    const completion = new Promise(done => { resolve = done })
    const operation = { ...admission, token: randomUUID(), generation: readiness.get(admission.session.owner).generation,
      resolve, claimed: false, closeDispatched: false, closeSettled: false, closed: false, surfaceLost: false, expiresAt: now() + timeoutMs, timer: null }
    operations.set(admission.request.requestId, operation)
    operation.timer = setTimer(() => {
      if (!operation.claimed) finish(operation, { outcome: 'not-sent', closed: false, code: 'MC_AGENT_DESKTOP_STOP_UNAVAILABLE' })
      else lostSurface(operation)
    }, timeoutMs)
    operation.timer?.unref?.()
    try { send(operation.session.owner, { requestId: operation.request.requestId, token: operation.token, target: operation.request.target }) }
    catch {
      finish(operation, { outcome: 'not-sent', closed: false, code: 'MC_AGENT_DESKTOP_STOP_UNAVAILABLE' })
    }
    return { completion }
  }
  function find(value, owner) {
    if (!validReceipt(value)) fail('MC_AGENT_DESKTOP_STOP_INVALID')
    const operation = operations.get(value.requestId)
    if (!operation || operation.session.owner !== owner || operation.token !== value.token) fail('MC_AGENT_DESKTOP_STOP_UNAVAILABLE')
    return operation
  }
  async function close(value, owner, principal) {
    if (!validReceipt(value) || Object.keys(value).some(key => !['requestId', 'token'].includes(key))) fail('MC_AGENT_DESKTOP_STOP_INVALID')
    const operation = find(value, owner)
    if (operation.claimed || operation.surfaceLost || now() >= operation.expiresAt
        || readiness.get(owner)?.generation !== operation.generation || !ready(operation.session)) fail('MC_AGENT_DESKTOP_STOP_UNAVAILABLE')
    operation.claimed = true
    try {
      await checkContext(operation.context, true)
      if (operation.surfaceLost || now() >= operation.expiresAt
          || readiness.get(owner)?.generation !== operation.generation) fail('MC_AGENT_DESKTOP_STOP_UNAVAILABLE')
      operation.assertTarget()
      // No await separates final native target/connection checks from the
      // ordinary owner close. Principal is from trusted IPC, never browser JSON.
      operation.closeDispatched = true
      const result = await closeSession(operation.request.target.sessionId, operation.session, principal)
      operation.closed = result?.ok !== false && result?.closed === true
        && (result.sessionId === undefined || result.sessionId === operation.request.target.sessionId)
      operation.closeSettled = true
      if (operation.surfaceLost) finish(operation, { closed: operation.closed, savedState: 'unconfirmed' })
      return result
    } catch (error) {
      operation.closeSettled = true
      if (operation.surfaceLost) finish(operation, operation.closeDispatched
        ? { closed: false, savedState: 'pending' }
        : { outcome: 'not-sent', closed: false, code: 'MC_AGENT_DESKTOP_STOP_UNAVAILABLE' })
      throw error
    }
  }
  function complete(value, owner) {
    const operation = find(value, owner)
    if (!operation.claimed) {
      if (value.outcome !== 'not-sent') fail('MC_AGENT_DESKTOP_STOP_UNAVAILABLE')
      finish(operation, { outcome: 'not-sent', closed: false, code: 'MC_AGENT_DESKTOP_STOP_UNAVAILABLE' })
    } else {
      if (!operation.closeSettled) fail('MC_AGENT_DESKTOP_STOP_PENDING')
      if (!operation.closeDispatched) finish(operation, { outcome: 'not-sent', closed: false, code: 'MC_AGENT_DESKTOP_STOP_UNAVAILABLE' })
      else {
        const recorded = operation.closed && value.savedState === 'recorded' && operation.savedStateRecorded() === true
        finish(operation, { closed: operation.closed, savedState: recorded ? 'recorded' : 'unconfirmed' })
      }
    }
    return { ok: true }
  }
  return Object.freeze({ ready, setReady, dispatch, close, complete })
}

module.exports = { createNativePersonStop }
