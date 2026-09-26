// Admission only. This client neither chooses a storage namespace nor writes a queue.
export function createImageOwnerClient({ bridge, onChange = () => {} }) {
  const listeners = new Set()
  let disposed = false
  let started = false
  let unsubscribe = null
  let subscribing = false
  let observation = 0
  let accepted = null
  let flight = null
  let reread = false
  let status = 'unavailable'
  let code = 'IMAGE_OWNER_BRIDGE_UNAVAILABLE'
  const valid = value => value?.version === 1 && value.invalidated !== true
    && typeof value.ownerId === 'string' && value.ownerId.length > 0
    && typeof value.currentEpoch === 'string' && value.currentEpoch.length > 0
    && (value.kind === 'account' || value.kind === 'local')
  const snapshot = () => ({ status, code, ownerContext: accepted })
  function fence(reason = 'IMAGE_OWNER_CHANGED') {
    observation++
    accepted = null
    status = 'pending'
    code = reason
  }
  function publish() {
    if (disposed) return
    onChange(snapshot())
    for (const listener of [...listeners]) { try { listener(snapshot()) } catch { /* observers cannot change authority */ } }
  }
  async function readLoop() {
    do {
      if (disposed) return snapshot()
      reread = false
      const seen = observation
      try {
        const value = await bridge.ownerContext()
        if (disposed) return snapshot()
        if (seen !== observation) { reread = true; continue }
        if (!valid(value)) throw Object.assign(new Error('Invalid owner context'), { code: 'IMAGE_OWNER_CONTEXT_INVALID' })
        accepted = Object.freeze({ version: 1, ownerId: value.ownerId, currentEpoch: value.currentEpoch, kind: value.kind })
        status = 'ready'
        code = null
        publish()
      } catch (error) {
        if (disposed) return snapshot()
        if (seen !== observation) { reread = true; continue }
        accepted = null
        status = 'unavailable'
        code = error?.code || 'IMAGE_OWNER_CONTEXT_UNAVAILABLE'
        publish()
      }
    } while (!disposed && reread)
    return snapshot()
  }
  function refresh() {
    if (disposed) return Promise.resolve(snapshot())
    if (!started) return start()
    if (flight) { reread = true; return flight }
    fence()
    // Defer invocation until the promise is installed: a synchronous event from
    // the host read must coalesce into this flight, not start a second reader.
    flight = Promise.resolve().then(readLoop).finally(() => {
      flight = null
      if (!disposed && reread) void refresh()
    })
    publish()
    return flight
  }
  function start() {
    if (disposed) return Promise.resolve(snapshot())
    if (started) return refresh()
    if (typeof bridge?.ownerContext !== 'function' || typeof bridge?.onOwnerContextChanged !== 'function') {
      publish()
      return Promise.resolve(snapshot())
    }
    started = true
    subscribing = true
    try {
      unsubscribe = bridge.onOwnerContextChanged(() => {
        if (disposed) return
        fence()
        reread = true
        publish()
        if (!disposed && !subscribing && !flight) void refresh()
      })
      subscribing = false
      if (typeof unsubscribe !== 'function') throw new Error('Missing owner subscription cleanup')
      if (disposed) { unsubscribe(); unsubscribe = null; return Promise.resolve(snapshot()) }
    } catch {
      subscribing = false
      started = false
      accepted = null
      status = 'unavailable'
      code = 'IMAGE_OWNER_SUBSCRIPTION_UNAVAILABLE'
      publish()
      return Promise.resolve(snapshot())
    }
    return refresh()
  }
  return {
    start, refresh, snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener) },
    async prepareImages(prepare) {
      if (!started) await start()
      else if (flight) await flight
      const captured = accepted
      const isCurrent = () => !disposed && status === 'ready' && captured !== null && captured === accepted
      if (!isCurrent()) return { ok: false, code: code || 'IMAGE_OWNER_UNAVAILABLE', detached: true }
      try {
        const value = await prepare({ ownerContext: captured, isCurrent })
        return isCurrent() ? { ok: true, value, ownerContext: captured, isCurrent }
          : { ok: false, code: 'IMAGE_OWNER_CHANGED', detached: true, ownerContext: captured }
      } catch (error) {
        return { ok: false, code: error?.code || 'IMAGE_PREPARATION_UNCONFIRMED', detached: !isCurrent(), ownerContext: captured }
      }
    },
    capture: () => disposed || status !== 'ready' ? null : accepted,
    isCurrent: captured => !disposed && status === 'ready' && captured !== null && captured === accepted,
    invalidate(reason) { if (!disposed) { fence(reason); publish() } },
    dispose() {
      if (disposed) return
      disposed = true
      observation++
      accepted = null
      status = 'disposed'
      code = null
      unsubscribe?.()
      unsubscribe = null
      listeners.clear()
    },
  }
}
