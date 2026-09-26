import { sessionEventTurnId, sessionTurnStatus, sessionEndedEvent } from './agent-session-events.js'

const TERMINAL_NODE_STATUSES = new Set(['finished', 'turn-failed', 'cancelled', 'interrupted'])
const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 512

/*
 * Bind automatic image custody to a coordinator lifetime. The coordinator owns
 * the predecessor/successor transaction; this binder owns the part that must
 * survive that transaction: an image queue waiting for a real successor turn
 * boundary, even when no chat is mounted.
 *
 * The input.isCurrent predicate belongs to one recovery flight and therefore
 * expires when recover() returns. deferredIsCurrent is intentionally built
 * from the retained node incarnation, successor session, owner context and
 * live host bridge. It is the only predicate used by a later boundary signal.
 */
export function createAutomaticImageRecoveryBinder({
  transfer,
  bridge,
  getNode,
  nodeBusy = node => ['starting', 'running'].includes(node?.status),
  readinessRevision = () => null,
  readiness = null,
  ownerIsCurrent = () => true,
  canContinue = () => true,
  subscribeNodeStatus = () => () => {},
  subscribeAgentEvents = listener => typeof bridge?.onEvent === 'function' ? bridge.onEvent(listener) : () => {},
} = {}) {
  if (!transfer || typeof transfer.prepare !== 'function' || typeof transfer.transfer !== 'function'
      || typeof transfer.drain !== 'function' || typeof transfer.signalBoundary !== 'function') {
    throw new TypeError('Automatic image recovery needs the transfer implementation.')
  }
  const watches = new Map()
  const flights = new Map()
  let disposed = false

  const safe = check => {
    try { return check() === true } catch { return false }
  }
  const nodeOf = nodeId => {
    try { return getNode?.(nodeId) || null } catch { return null }
  }
  const expectedSessionIdOf = input => input.destinationSessionId || input.expectedSessionId || input.sourceSessionId
  const ownerCurrent = input => safe(() => ownerIsCurrent(input.nodeId, input.sourceBinding?.ownerContext
    || input.ownerContext || null))
  const liveCurrent = input => {
    const node = nodeOf(input.nodeId)
    const expectedCreatedAt = input.expectedNodeCreatedAt
    const expectedSessionId = expectedSessionIdOf(input)
    return !disposed && safe(canContinue)
      && Boolean(node)
      && (expectedCreatedAt === undefined || node.createdAt === expectedCreatedAt)
      && (!expectedSessionId || node.sessionId === expectedSessionId)
      && ownerCurrent(input)
  }
  const flightCurrent = input => liveCurrent(input) && safe(input.isCurrent || (() => true))
  const independentInput = input => ({
    ...input,
    isCurrent: () => liveCurrent(input),
    deferredIsCurrent: undefined,
  })
  // Without a turn identity, differing status words cannot prove a fresh
  // boundary. Coalesce anonymous completions for this watch's lifetime.
  const completedTurnRevision = (sessionId, turnId) =>
    JSON.stringify(['completed-turn', sessionId, textId(turnId) ? turnId : null])
  const revisionFor = input => {
    const node = nodeOf(input.nodeId)
    // Event and persisted status are two observations of the same turn.
    // Provider completion words and node status labels are not new boundaries.
    const completed = TERMINAL_NODE_STATUSES.has(node?.status)
      ? completedTurnRevision(expectedSessionIdOf(input), node?.lastTurnId) : null
    if (completed !== null) return completed
    try {
      const value = readinessRevision(input.nodeId, expectedSessionIdOf(input), nodeOf(input.nodeId))
      if (typeof value === 'string' && value.length > 0 && value.length <= 256) return value
      if (Number.isSafeInteger(value)) return value
    } catch { /* Missing status is not an automatic retry authorization. */ }
    return node ? `${node.sessionId || expectedSessionIdOf(input) || 'none'}:${node.lastTurnId || 'none'}:${node.status || 'unknown'}:${safe(() => nodeBusy(node)) ? 'busy' : 'idle'}` : null
  }
  const eventRevisionFor = (packet, sessionId, node) => {
    const turnId = sessionEventTurnId(packet, sessionId)
    const observedTurn = !turnId && TERMINAL_NODE_STATUSES.has(node?.status)
      ? node?.lastTurnId : null
    return completedTurnRevision(sessionId, turnId || observedTurn)
  }
  const boundaryFor = async input => {
    const node = nodeOf(input.nodeId)
    const revision = revisionFor(input)
    let native = null
    if (typeof readiness === 'function') {
      try { native = await readiness({ input, node }) } catch { native = { known: true, busy: true } }
    }
    const nativeKnown = native?.known === true
    const busy = nativeKnown
      ? native.busy !== false
      : (node ? safe(() => nodeBusy(node)) : true)
    const status = node?.status
    return {
      ok: true,
      ready: !busy && (!status || TERMINAL_NODE_STATUSES.has(status)),
      readinessRevision: revision,
      retryAfterMs: 1000,
    }
  }
  const stopWatch = key => {
    const watch = watches.get(key)
    if (!watch) return
    watch.unsubscribeEvent?.()
    watch.unsubscribeStatus?.()
    watches.delete(key)
  }
  const signal = (key, revision, boundaryCurrent = null, retryOf = null) => {
    const watch = watches.get(key)
    if (!watch || disposed) return Promise.resolve({ ok: false, code: 'IMAGE_RECOVERY_DISPOSED' })
    if (watch.seen.has(revision)) {
      return watch.flight || Promise.resolve({ ok: true, attempted: false,
        retryable: true, reason: 'readiness-unchanged', boundaryKey: key })
    }
    // Keep only the latest distinct boundary while native dispatch is pending.
    // Dispatch stays serial; repeated notifications cannot create extra sends.
    if (watch.pendingBoundary && watch.pendingBoundary.revision !== revision) {
      watch.seen.add(watch.pendingBoundary.revision)
    }
    watch.pendingBoundary = { revision, boundaryCurrent, retryOf }
    if (watch.flight) return watch.flight
    watch.flight = Promise.resolve().then(async () => {
      let result
      while (watch.pendingBoundary && watches.get(key) === watch && !disposed) {
        const next = watch.pendingBoundary
        watch.pendingBoundary = null
        watch.seen.add(next.revision)
        // An identified echo may retry a proven refusal, but cannot advance
        // another envelope after the anonymous completion already succeeded.
        if (next.retryOf !== null && (watch.lastOutcome?.revision !== next.retryOf
          || watch.lastOutcome.result?.retryable !== true)) continue
        result = await transfer.signalBoundary({
          key,
          readinessRevision: next.revision,
          isCurrent: () => liveCurrent(watch.input),
          boundaryCurrent: next.boundaryCurrent || (() => liveCurrent(watch.input)),
        })
        watch.lastOutcome = { revision: next.revision, result }
        /* Terminal/unknown/stale outcomes retire automatic work, including any
         * boundary that arrived during the awaited request. Custody stays put. */
        const keep = result?.retryable === true
          || (result?.ok === true && result?.dispatched === true && result.remaining > 0)
        if (!keep) { stopWatch(key); break }
      }
      return result
    }).catch(error => {
      const result = {
        ok: false,
        code: error?.code || 'IMAGE_RECOVERY_BOUNDARY_UNAVAILABLE',
        retained: true,
        reconcile: true,
        boundaryKey: key,
      }
      stopWatch(key)
      return result
    }).finally(() => {
      watch.flight = null
      // A callback may arrive after the loop settles but before this cleanup.
      const next = watch.pendingBoundary
      if (next && watches.get(key) === watch && !disposed) {
        watch.pendingBoundary = null
        void signal(key, next.revision, next.boundaryCurrent, next.retryOf)
      }
    })
    return watch.flight
  }
  const watchBoundary = (input, boundaryKey, initialRevision) => {
    if (!textId(boundaryKey) && typeof boundaryKey !== 'string') return
    if (watches.has(boundaryKey)) return
    const watch = { input: independentInput(input), flight: null, pendingBoundary: null,
      seen: new Set([initialRevision]), lastOutcome: null, observationSequence: 0, anonymousStatusPending: false, unsubscribeEvent: null, unsubscribeStatus: null }
    // Publish the watch before subscribing: a host may synchronously replay its
    // current status/event during registration, and that first real boundary
    // must not be lost between the two operations.
    watches.set(boundaryKey, watch)
    const sessionId = expectedSessionIdOf(input)
    const onStatus = () => {
      const sequence = ++watch.observationSequence
      const node = nodeOf(watch.input.nodeId)
      if (safe(() => nodeBusy(node))) watch.anonymousStatusPending = false
      const revision = revisionFor(watch.input)
      if (revision === null) return
      void boundaryFor(watch.input).then(boundary => {
        if (boundary?.ready === true && sequence === watch.observationSequence) {
          // A status may supply the identity missing from the preceding event.
          // Until another busy transition, that is evidence about the same
          // completion. Only a proven retryable refusal can retry that send.
          if (watch.anonymousStatusPending && textId(node?.lastTurnId) && !watch.seen.has(revision)) {
            watch.anonymousStatusPending = false
            void signal(boundaryKey, revision, null, completedTurnRevision(sessionId, null))
            return
          }
          void signal(boundaryKey, boundary.readinessRevision ?? revision)
        }
      }).catch(() => { /* an unreadable status is not a send boundary */ })
    }
    const onEvent = packet => {
      if (!packet || packet.sessionId !== sessionId || !sessionTurnStatus(packet, sessionId)
          || sessionEndedEvent(packet, sessionId)) return
      const node = nodeOf(watch.input.nodeId)
      const revision = eventRevisionFor(packet, sessionId, node)
      if (watch.seen.has(revision)) return
      if (!sessionEventTurnId(packet, sessionId)
        && !(TERMINAL_NODE_STATUSES.has(node?.status) && textId(node?.lastTurnId))) {
        watch.anonymousStatusPending = true
      }
      // A new completion supersedes a pending read of older node status.
      // An old echo must not invalidate a newer status observation.
      watch.observationSequence++
      void signal(boundaryKey, revision)
    }
    try { watch.unsubscribeStatus = subscribeNodeStatus(input.nodeId, onStatus) || (() => {}) } catch { watch.unsubscribeStatus = () => {} }
    try { watch.unsubscribeEvent = subscribeAgentEvents(onEvent) || (() => {}) } catch { watch.unsubscribeEvent = () => {} }
    // A turn can finish while the initial readiness/dispatch request is in
    // flight, before either subscription exists. Reconcile once after both
    // listeners are attached. The transfer's revision check keeps an unchanged
    // boundary from sending another envelope; no polling loop is needed.
    onStatus()
  }
  const withFlightGuard = input => ({
    ...input,
    isCurrent: () => flightCurrent(input),
    deferredIsCurrent: () => liveCurrent(input),
    readinessRevision: revisionFor(input),
  })

  async function prepare(input = {}) {
    return transfer.prepare(withFlightGuard(input))
  }
  async function recover(input = {}) {
    return transfer.transfer(withFlightGuard(input))
  }
  async function drain(input = {}) {
    const initial = withFlightGuard(input)
    const result = await transfer.drain({
      ...initial,
      awaitBoundary: async () => boundaryFor(input),
    })
    const needsBoundaryWatch = result?.retryable === true
      || (result?.ok === true && result?.dispatched === true && result.remaining > 0)
    if (typeof result?.boundaryKey === 'string' && needsBoundaryWatch) {
      // The first attempt already consumed its readiness observation. A late
      // echo must not become fresh merely because registration was overtaken.
      watchBoundary(input, result.boundaryKey, result.readinessRevision ?? initial.readinessRevision)
    }
    return result
  }
  function dispose() {
    if (disposed) return
    disposed = true
    for (const key of [...watches.keys()]) stopWatch(key)
    flights.clear()
    transfer.dispose?.()
  }

  return Object.freeze({ prepare, recover, drain, signal, dispose, pending: () => watches.size })
}
