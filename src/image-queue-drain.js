// One owner/session-bound drain. Only the host dispatch operation claims work.
// A renderer drain never guesses that an unconfirmed provider result was refused.
const MIN_RETRY_DELAY_MS = 250
const MAX_RETRY_DELAY_MS = 8000
const MAX_AUTO_RETRIES = 5

export function createImageQueueDrain({ bridge, owner, ownerContext, conversationId, sessionId,
  isCurrent = () => true, mayDrain = () => false, onState = () => {},
  newOperationId = () => crypto.randomUUID(),
  scheduleRetry = (callback, delay) => setTimeout(callback, delay),
  clearScheduledRetry = timer => clearTimeout(timer),
  readinessRevision = () => null }) {
  let flight = null
  let disposed = false
  const outcomes = new Map()
  const retryTimers = new Map()
  const retryDue = new Set()
  const retryAttempts = new Map()
  const current = () => !disposed && isCurrent() && owner.isCurrent(ownerContext)
  const currentReadinessRevision = () => {
    try {
      const value = readinessRevision()
      if (typeof value === 'string' && value.length > 0 && value.length <= 256) return value
      if (Number.isSafeInteger(value)) return value
    } catch { /* A missing status signal cannot authorize an automatic retry. */ }
    return null
  }

  const publish = result => {
    if (!current()) return
    try { onState(result) } catch { result.publicationError = 'IMAGE_QUEUE_PUBLICATION_FAILED' }
  }
  const clearRetry = envelopeId => {
    const timer = retryTimers.get(envelopeId)
    if (timer !== undefined) {
      try { clearScheduledRetry(timer) } catch { /* A disposed timer is already safe. */ }
      retryTimers.delete(envelopeId)
    }
    retryDue.delete(envelopeId)
    retryAttempts.delete(envelopeId)
  }
  const failureOf = (entry, response = null) => {
    const failure = entry?.failure && typeof entry.failure === 'object'
      ? entry.failure
      : response?.failure && typeof response.failure === 'object' ? response.failure : null
    if (!failure || typeof failure.code !== 'string' || !failure.code) return null
    return {
      code: failure.code,
      retryable: failure.retryable === true,
      ...(typeof failure.changeToken === 'string' && failure.changeToken ? { changeToken: failure.changeToken } : {}),
      ...(Number.isSafeInteger(failure.retryAfterMs) && failure.retryAfterMs > 0 ? { retryAfterMs: failure.retryAfterMs } : {}),
    }
  }
  const changeTokenOf = (entry, response = null) => {
    const failure = failureOf(entry, response)
    return failure?.changeToken || response?.changeToken || null
  }
  const retain = result => {
    const revision = currentReadinessRevision()
    const retained = revision === null ? result : { ...result, readinessRevision: revision }
    if (retained.envelopeId && ['accepted', 'unknown', 'not-sent'].includes(retained.state)) outcomes.set(retained.envelopeId, retained)
    publish(retained)
    return retained
  }
  const validRetryAfter = value => Number.isSafeInteger(value)
    && value >= 1 && value <= 60000
  const boundedDelay = value => Math.min(MAX_RETRY_DELAY_MS,
    Math.max(MIN_RETRY_DELAY_MS, validRetryAfter(value) ? value : 1000))
  const scheduleTransientRetry = result => {
    const envelopeId = result.envelopeId
    const attempt = (retryAttempts.get(envelopeId) || 0) + 1
    retryAttempts.set(envelopeId, attempt)
    if (attempt > MAX_AUTO_RETRIES) {
      retryDue.delete(envelopeId)
      return retain({ ...result, retryExhausted: true, retryScheduled: false })
    }
    const delay = Math.min(MAX_RETRY_DELAY_MS, boundedDelay(result.retryAfterMs) * (2 ** (attempt - 1)))
    const prior = retryTimers.get(envelopeId)
    if (prior !== undefined) {
      try { clearScheduledRetry(prior) } catch { /* The newer timer still owns retry. */ }
    }
    const timer = scheduleRetry(async () => {
      if (retryTimers.get(envelopeId) === timer) retryTimers.delete(envelopeId)
      retryDue.add(envelopeId)
      const queued = outcomes.get(envelopeId)
      if (!current() || !mayDrain()) {
        if (queued) publish({ ...queued, retryDue: true, retryScheduled: false })
        return
      }
      await startDrain({ force: true, targetEnvelopeId: envelopeId })
    }, delay)
    retryTimers.set(envelopeId, timer)
    return retain({ ...result, retryAfterMs: delay, retryAt: Date.now() + delay, retryScheduled: true, retryExhausted: false })
  }

  async function request(operation, fields = {}) {
    if (!current()) return { ok: false, code: 'IMAGE_OWNER_CHANGED', detached: true }
    try {
      const response = await bridge.imageQueue({ operation, ownerContext, conversationId, ...fields })
      if (response?.code === 'IMAGE_OWNER_CHANGED' && current()) owner.invalidate(response.code)
      return response
    } catch (error) {
      if (error?.code === 'IMAGE_OWNER_CHANGED' && current()) owner.invalidate(error.code)
      return { ok: false, code: error?.code || 'IMAGE_QUEUE_REQUEST_UNCONFIRMED', reconcile: true }
    }
  }

  async function run({ force = false, targetEnvelopeId = null, explicit = false } = {}) {
    if (!current() || !mayDrain()) return { state: 'held', code: 'IMAGE_QUEUE_NOT_READY' }
    const read = await request('read')
    if (!current()) return { state: 'held', code: 'IMAGE_OWNER_CHANGED', detached: true }
    if (read?.ok !== true || read.operation !== 'read' || !read.result
      || read.result.version !== 1 || !Array.isArray(read.result.entries)) {
      return retain({ state: 'held', code: read?.code || 'IMAGE_QUEUE_RECEIPT_INVALID' })
    }
    const snapshot = read.result
    const cleanupRepair = snapshot.writeBlocked === 'IMAGE_OUTBOX_CLEANUP_REQUIRED'
    if ((snapshot.writeBlocked && !(explicit && cleanupRepair))
      || snapshot.destinationSessionId !== sessionId) {
      return retain({ state: 'held', code: snapshot.writeBlocked || 'IMAGE_OUTBOX_DESTINATION_STALE' })
    }
    const pending = snapshot.entries.filter(row => !['accepted', 'cancelled'].includes(row.state))
    const entry = targetEnvelopeId
      ? pending.find(row => row.envelopeId === targetEnvelopeId)
      : pending[0]
    if (!entry) return targetEnvelopeId ? { state: 'held', code: 'IMAGE_QUEUE_ENVELOPE_NOT_PENDING', envelopeId: targetEnvelopeId } : { state: 'idle' }

    const known = outcomes.get(entry.envelopeId)
    const due = retryDue.has(entry.envelopeId)
    const readinessRevisionNow = currentReadinessRevision()
    const readinessChanged = known?.state === 'not-sent' && known.retryable === true
      && known.readinessRevision !== undefined && readinessRevisionNow !== null
      && known.readinessRevision !== readinessRevisionNow
    if (known && !force) {
      const busyRetry = known.state === 'not-sent' && known.retryable === true
      if (!busyRetry || (!due && !readinessChanged)) {
        publish(known)
        return known
      }
    }
    if (readinessChanged) clearRetry(entry.envelopeId)
    if (!force && due) retryDue.delete(entry.envelopeId)
    const failure = failureOf(entry)
    if (!force && failure && failure.retryable !== true) {
      clearRetry(entry.envelopeId)
      return retain({ state: 'not-sent', envelopeId: entry.envelopeId, code: failure.code,
        failure, retryable: false, generation: snapshot.generation, changeToken: failure.changeToken })
    }
    // A fresh lifecycle signal has already released this known retryable
    // refusal. The durable failure describes the previous attempt; scheduling
    // it again here would postpone the retry after the session became idle.
    if (!force && failure?.retryable === true && !due && !readinessChanged) {
      return scheduleTransientRetry({ state: 'not-sent', envelopeId: entry.envelopeId, code: failure.code,
        failure, retryable: true, retryAfterMs: failure.retryAfterMs || 1000,
        generation: snapshot.generation, changeToken: failure.changeToken })
    }
    if (entry.state !== 'not-sent') {
      clearRetry(entry.envelopeId)
      return retain({ state: 'unknown', envelopeId: entry.envelopeId, ownerContext,
        code: entry.failure?.code || 'IMAGE_DELIVERY_UNKNOWN', reconcile: true,
        generation: snapshot.generation, detached: !current() })
    }
    if (!current() || !mayDrain()) return { state: 'held', code: 'IMAGE_QUEUE_NOT_READY' }

    const operationId = newOperationId()
    const response = await request('dispatch', { sessionId, envelopeId: entry.envelopeId,
      expectedGeneration: snapshot.generation, operationId })
    const identityMatches = response?.operation === 'dispatch' && response.operationId === operationId
      && response.sessionId === sessionId && response.conversationId === conversationId
      && response.ownerContext?.ownerId === ownerContext.ownerId
      && response.ownerContext?.currentEpoch === ownerContext.currentEpoch
      && response.envelopeId === entry.envelopeId
    const responseEntry = response?.result?.entries?.find(row => row.envelopeId === entry.envelopeId)
    // A preflight refusal is the only valid dispatch reply without an
    // attempt. It did not claim or send anything, so no attempt id may be
    // invented. The host includes the unchanged durable row: a busy refusal
    // is retryable with a bounded delay; every other preflight refusal carries
    // its terminal failure and waits for an explicit Send again.
    const noAttemptRefusal = identityMatches && response.deliveryDisposition === 'not-sent'
      && response.dispatchStarted === false && response.reconcile !== true
      && !response.attemptId && responseEntry?.state === 'not-sent'
    if (noAttemptRefusal && response.retryable === true
      && response.code === 'AGENT_TURN_ACTIVE' && validRetryAfter(response.retryAfterMs)) {
      return scheduleTransientRetry({ state: 'not-sent', envelopeId: entry.envelopeId,
        code: response.code, retryable: true, retryAfterMs: response.retryAfterMs,
        dispatchStarted: false, generation: snapshot.generation,
        changeToken: changeTokenOf(responseEntry, response) })
    }
    if (noAttemptRefusal && response.retryable === false) {
      const failure = failureOf(responseEntry, response)
      if (failure?.retryable === false) {
        clearRetry(entry.envelopeId)
        return retain({ state: 'not-sent', envelopeId: entry.envelopeId, code: failure.code,
          failure, retryable: false, dispatchStarted: false, generation: snapshot.generation,
          changeToken: failure.changeToken, detached: !current() })
      }
    }
    // Accepted is a delivery fact even when terminal persistence or owner
    // publication fails. Keep it in this initiating drain; never replay it.
    if (identityMatches && typeof response.attemptId === 'string' && response.attemptId) {
      if (response.deliveryDisposition === 'accepted') {
        clearRetry(entry.envelopeId)
        return retain({ state: 'accepted', envelopeId: entry.envelopeId,
          attemptId: response.attemptId, ownerContext, providerReceipt: response.providerReceipt || null,
          reconcile: response.reconcile === true, generation: snapshot.generation, detached: !current() })
      }
      if (response.deliveryDisposition === 'not-sent') {
        const failure = failureOf(responseEntry, response)
        if (response.reconcile === true) {
          return retain({ state: 'not-sent', envelopeId: entry.envelopeId, attemptId: response.attemptId,
            code: response.code, failure, reconcile: true, generation: snapshot.generation, detached: !current() })
        }
        const retryable = failure?.retryable === true || response.retryable === true
        const result = { state: 'not-sent', envelopeId: entry.envelopeId, attemptId: response.attemptId,
          code: response.code || failure?.code || 'IMAGE_DELIVERY_NOT_SENT',
          failure: failure || { code: response.code || 'IMAGE_DELIVERY_NOT_SENT', retryable: false },
          retryable, generation: snapshot.generation, detached: !current() }
        if (retryable) return scheduleTransientRetry(result)
        clearRetry(entry.envelopeId)
        return retain(result)
      }
    }
    // A transport error, an invalid preflight, or a general code is never
    // permission to retry dispatch. Unknown delivery stays visible and
    // requires a person to inspect it.
    clearRetry(entry.envelopeId)
    return retain({ state: 'unknown', envelopeId: entry.envelopeId, ownerContext,
      code: response?.code || 'IMAGE_DELIVERY_UNKNOWN', reconcile: true,
      generation: snapshot.generation, detached: !current() })
  }

  async function startDrain(options = {}) {
    if (flight) return flight
    if (typeof bridge?.imageQueue !== 'function') return Promise.resolve({ state: 'held', code: 'IMAGE_QUEUE_BRIDGE_UNAVAILABLE' })
    flight = Promise.resolve().then(() => run(options)).finally(() => { flight = null })
    return flight
  }

  return {
    drain(options = {}) { return startDrain(options) },
    retry(envelopeId) {
      if (typeof envelopeId !== 'string' || !envelopeId) return Promise.resolve({ state: 'held', code: 'IMAGE_QUEUE_ENVELOPE_INVALID' })
      const known = outcomes.get(envelopeId)
      if (known?.state === 'unknown') return Promise.resolve({ ...known, code: known.code || 'IMAGE_DELIVERY_UNKNOWN_RETRY_REFUSED' })
      clearRetry(envelopeId)
      outcomes.delete(envelopeId)
      retryDue.delete(envelopeId)
      return startDrain({ force: true, explicit: true, targetEnvelopeId: envelopeId })
    },
    outcome: envelopeId => outcomes.get(envelopeId) || null,
    dispose() {
      disposed = true
      for (const timer of retryTimers.values()) {
        try { clearScheduledRetry(timer) } catch { /* Best effort; disposed drains cannot publish. */ }
      }
      retryTimers.clear(); retryDue.clear(); retryAttempts.clear()
    },
  }
}
