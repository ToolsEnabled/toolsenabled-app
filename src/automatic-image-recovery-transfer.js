const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const OWNER_KINDS = new Set(['local', 'account'])

const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const validOwner = value => value?.version === 1
  && value.invalidated !== true
  && typeof value.ownerId === 'string' && value.ownerId.length > 0
  && typeof value.currentEpoch === 'string' && value.currentEpoch.length > 0
  && OWNER_KINDS.has(value.kind)

function copy(value) {
  return value && typeof value === 'object' ? structuredClone(value) : value
}

function entryFingerprint(entries) {
  return JSON.stringify((entries || []).map(entry => ({
    envelopeId: entry.envelopeId,
    text: entry.text,
    imageReceipts: entry.imageReceipts,
    selection: entry.selection ?? null,
    state: entry.state,
    failure: entry.failure ?? null,
    attemptId: entry.attemptId ?? null,
  })))
}

function errorFor(code, message = code) {
  return Object.assign(new Error(message), { code })
}

function refusal(code, extra = {}) {
  return { ok: false, code, retained: true, reconcile: true, ...extra }
}

function validSnapshot(value) {
  return value?.version === 1
    && (value.generation === null || (typeof value.generation === 'string' && value.generation.length > 0))
    && value.automaticSend === false
    && Array.isArray(value.entries)
    && (value.destinationSessionId === null || textId(value.destinationSessionId))
}

function validReadResponse(response) {
  return response?.ok === true && response.operation === 'read' && validSnapshot(response.result)
}

function validMutationResponse(response, operation) {
  return response?.ok === true && response.operation === operation && validSnapshot(response.result)
}

function requireText(value, name) {
  if (!textId(value)) throw errorFor('IMAGE_RECOVERY_REQUEST_INVALID', name + ' is required')
  return value
}

function operationIdFor(input, newOperationId) {
  const supplied = input.operationId || input.recoveryId
  if (UUID.test(String(supplied || ''))) return String(supplied)
  const generated = newOperationId?.()
  if (UUID.test(String(generated || ''))) return String(generated)
  throw errorFor('IMAGE_RECOVERY_OPERATION_INVALID')
}

function sameOptionalIdentity(response, expected) {
  for (const name of ['sessionId', 'conversationId', 'envelopeId']) {
    if (response?.[name] !== undefined && response[name] !== expected[name]) return false
  }
  if (response?.ownerContext !== undefined
    && JSON.stringify(response.ownerContext) !== JSON.stringify(expected.ownerContext)) return false
  return true
}

function notSentEnvelope(snapshot, envelopeId) {
  return validSnapshot(snapshot)
    && snapshot.destinationSessionId !== null
    && snapshot.entries.some(entry => entry.envelopeId === envelopeId && entry.state === 'not-sent')
}

function pendingEntries(snapshot) {
  return snapshot.entries.filter(entry => entry.state === 'not-sent' || entry.state === 'unknown')
}

/**
 * T839 evidence implementation for automatic image custody recovery.
 *
 * prepare() captures the authenticated owner, source generation and source
 * entry fingerprint while the predecessor still owns the node. transfer() is
 * a guarded native CAS after successor attachment; it never dispatches.
 * drain() is a lifetime-owned host-boundary operation. It sends at most one
 * known not-sent envelope at a boundary and never replays unknown delivery.
 */
export function createAutomaticImageRecoveryTransfer({
  bridge,
  captureOwnerContext = () => bridge?.ownerContext?.(),
  newOperationId = () => globalThis.crypto?.randomUUID?.(),
  maxRemembered = 256,
  maxBoundaryRetries = 5,
} = {}) {
  if (!bridge || typeof bridge.imageQueue !== 'function') {
    throw new TypeError('Automatic image recovery needs the native imageQueue bridge.')
  }
  if (typeof captureOwnerContext !== 'function') {
    throw new TypeError('Automatic image recovery needs an owner-context reader.')
  }
  const flights = new Map()
  const waiting = new Map()
  let disposed = false

  function remember(map, key, value) {
    map.set(key, value)
    while (map.size > maxRemembered) map.delete(map.keys().next().value)
  }

  function isCurrent(input = {}) {
    if (disposed) return false
    if (typeof input.isCurrent === 'function' && input.isCurrent() !== true) return false
    if (typeof input.canContinue === 'function' && input.canContinue() !== true) return false
    if (typeof input.sameNode === 'function' && input.sameNode() !== true) return false
    if (input.expectedNodeCreatedAt !== undefined
      && typeof input.readNodeCreatedAt === 'function'
      && input.readNodeCreatedAt() !== input.expectedNodeCreatedAt) return false
    if (input.expectedSessionId !== undefined
      && typeof input.readSessionId === 'function'
      && input.readSessionId() !== input.expectedSessionId) return false
    return true
  }

  async function guarded(input, operation, code = 'IMAGE_RECOVERY_STALE') {
    if (!isCurrent(input)) throw errorFor(code)
    let result
    try {
      result = await operation()
    } catch (error) {
      throw error
    }
    if (!isCurrent(input)) throw errorFor(code)
    return result
  }

  async function readQueue(input, ownerContext, conversationId) {
    const response = await guarded(input, () => bridge.imageQueue({
      operation: 'read',
      ownerContext,
      conversationId,
    }))
    if (!validReadResponse(response)) {
      const code = response?.code || 'IMAGE_RECOVERY_READ_UNCONFIRMED'
      throw errorFor(code)
    }
    if (response.result.writeBlocked) {
      throw errorFor(response.result.writeBlocked === true
        ? 'IMAGE_OUTBOX_CLEANUP_REQUIRED' : response.result.writeBlocked)
    }
    return copy(response.result)
  }

  function bindingFor(input, snapshot, ownerContext, operationId, sourceSessionId) {
    return Object.freeze({
      version: 1,
      operationId,
      conversationId: input.conversationId || input.nodeId,
      sourceSessionId,
      destinationSessionId: snapshot.destinationSessionId,
      generation: snapshot.generation,
      fingerprint: entryFingerprint(snapshot.entries),
      ownerContext: copy(ownerContext),
      expectedNodeCreatedAt: input.expectedNodeCreatedAt ?? null,
      sourceIdentity: copy(input.sourceIdentity || { sessionId: sourceSessionId }),
      createdBeforeClose: true,
    })
  }

  async function prepare(input = {}) {
    if (disposed) return refusal('IMAGE_RECOVERY_DISPOSED')
    let conversationId, sourceSessionId, operationId
    try {
      conversationId = requireText(input.conversationId || input.nodeId, 'conversationId')
      sourceSessionId = requireText(input.sourceSessionId, 'sourceSessionId')
      operationId = operationIdFor(input, newOperationId)
    } catch (error) {
      return refusal(error.code || 'IMAGE_RECOVERY_REQUEST_INVALID')
    }
    const base = { ...input, conversationId, sourceSessionId }
    let ownerContext = input.ownerContext
    try {
      if (ownerContext === undefined) ownerContext = await guarded(base, () => captureOwnerContext())
      if (!validOwner(ownerContext)) return refusal('IMAGE_OWNER_CONTEXT_INVALID')
      const snapshot = await readQueue(base, ownerContext, conversationId)
      const entries = pendingEntries(snapshot)
      const sourceBinding = bindingFor(base, snapshot, ownerContext, operationId, sourceSessionId)
      return {
        ok: true,
        prepared: true,
        operationId,
        conversationId,
        sourceSessionId,
        pending: entries.some(entry => entry.state === 'not-sent'),
        unknown: entries.some(entry => entry.state === 'unknown'),
        sourceBinding,
        snapshot,
      }
    } catch (error) {
      return refusal(error?.code || 'IMAGE_RECOVERY_READ_UNCONFIRMED')
    }
  }

  async function transfer(input = {}) {
    if (disposed) return refusal('IMAGE_RECOVERY_DISPOSED')
    const binding = input.sourceBinding
    const conversationId = input.conversationId || input.nodeId
    let sourceSessionId, destinationSessionId, operationId
    try {
      requireText(conversationId, 'conversationId')
      sourceSessionId = requireText(input.sourceSessionId, 'sourceSessionId')
      destinationSessionId = requireText(input.destinationSessionId, 'destinationSessionId')
      operationId = operationIdFor(input, newOperationId)
    } catch (error) {
      return refusal(error.code || 'IMAGE_RECOVERY_REQUEST_INVALID')
    }
    if (!binding || binding.version !== 1) return refusal('IMAGE_RECOVERY_SOURCE_BINDING_REQUIRED')
    if (binding.conversationId !== conversationId || binding.sourceSessionId !== sourceSessionId) {
      return refusal('IMAGE_RECOVERY_SOURCE_BINDING_CHANGED')
    }
    if (sourceSessionId === destinationSessionId) return refusal('IMAGE_RECOVERY_SAME_SESSION')
    if (input.validatedSuccessor !== true) return refusal('IMAGE_RECOVERY_SUCCESSOR_UNVALIDATED')
    if (input.sourceIdentity?.sessionId !== undefined && input.sourceIdentity.sessionId !== sourceSessionId) {
      return refusal('IMAGE_RECOVERY_SOURCE_IDENTITY_CHANGED')
    }
    if (input.destinationIdentity?.sessionId !== undefined && input.destinationIdentity.sessionId !== destinationSessionId) {
      return refusal('IMAGE_RECOVERY_DESTINATION_IDENTITY_CHANGED')
    }
    const guardInput = {
      ...input,
      conversationId,
      sourceSessionId,
      expectedSessionId: destinationSessionId,
      expectedNodeCreatedAt: input.expectedNodeCreatedAt ?? binding.expectedNodeCreatedAt,
    }
    const key = JSON.stringify([conversationId, sourceSessionId, destinationSessionId, operationId])
    const prior = flights.get(key)
    if (prior) return prior
    const promise = (async () => {
      try {
        if (!isCurrent(guardInput)) return refusal('IMAGE_RECOVERY_STALE')
        const before = await readQueue(guardInput, binding.ownerContext, conversationId)
        if (before.generation !== binding.generation
          || before.destinationSessionId !== binding.destinationSessionId
          || entryFingerprint(before.entries) !== binding.fingerprint) {
          return refusal('IMAGE_RECOVERY_SOURCE_CHANGED')
        }
        const pending = pendingEntries(before)
        if (!pending.length) {
          return { ok: true, transferred: false, operationId, sourceBinding: binding, snapshot: before }
        }
        if (before.destinationSessionId === destinationSessionId) {
          return { ok: true, transferred: false, alreadyTransferred: true, operationId,
            sourceBinding: Object.freeze({ ...binding, destinationSessionId, generation: before.generation }),
            snapshot: before }
        }
        const changed = await guarded(guardInput, () => bridge.imageQueue({
          operation: 'transfer',
          ownerContext: binding.ownerContext,
          conversationId,
          expectedGeneration: before.generation,
          expectedDestinationSessionId: before.destinationSessionId,
          destinationSessionId,
          operationId,
        }))
        if (!validMutationResponse(changed, 'transfer')) {
          return refusal(changed?.code || 'IMAGE_RECOVERY_TRANSFER_UNCONFIRMED')
        }
        const after = await readQueue(guardInput, binding.ownerContext, conversationId)
        if (after.destinationSessionId !== destinationSessionId
          || entryFingerprint(after.entries) !== binding.fingerprint) {
          return refusal('IMAGE_RECOVERY_TRANSFER_RECONCILE_REQUIRED')
        }
        const destinationBinding = Object.freeze({
          ...binding,
          destinationSessionId,
          generation: after.generation,
          fingerprint: entryFingerprint(after.entries),
        })
        return {
          ok: true,
          transferred: true,
          operationId,
          sourceSessionId,
          destinationSessionId,
          conversationId,
          entries: copy(after.entries),
          snapshot: after,
          sourceBinding: destinationBinding,
          automaticSend: false,
        }
      } catch (error) {
        return refusal(error?.code || 'IMAGE_RECOVERY_TRANSFER_UNCONFIRMED')
      }
    })()
    remember(flights, key, promise)
    return promise
  }

  async function runDrain(input, boundaryKey) {
    // A recovery flight's predicate expires when recover() returns. Boundary
    // delivery belongs to the node's lifetime, so use the independent guard
    // captured by Computers for every read/dispatch await and later signal.
    const lifetimeInput = typeof input.deferredIsCurrent === 'function'
      ? { ...input, isCurrent: input.deferredIsCurrent }
      : input
    const binding = lifetimeInput.sourceBinding
    const conversationId = lifetimeInput.conversationId || lifetimeInput.nodeId
    const destinationSessionId = lifetimeInput.destinationSessionId
    /* Dispatch is a distinct native mutation from prepare/transfer. Reusing
       the recovery ticket here is an idempotency conflict after custody CAS;
       each concrete boundary attempt gets its own operation identity. */
    const operationId = operationIdFor(
      input.dispatchOperationId ? { operationId: input.dispatchOperationId } : {},
      newOperationId,
    )
    const snapshot = await readQueue(lifetimeInput, binding.ownerContext, conversationId)
    if (snapshot.destinationSessionId !== destinationSessionId) return refusal('IMAGE_RECOVERY_DESTINATION_STALE')
    const unknown = snapshot.entries.filter(entry => entry.state === 'unknown')
    const entry = snapshot.entries.find(item => item.state === 'not-sent')
    if (!entry) {
      waiting.delete(boundaryKey)
      return { ok: true, dispatched: false, skippedUnknown: unknown.length, boundaryKey, snapshot }
    }
    const request = {
      operation: 'dispatch',
      ownerContext: binding.ownerContext,
      conversationId,
      sessionId: destinationSessionId,
      envelopeId: entry.envelopeId,
      expectedGeneration: snapshot.generation,
      operationId,
      sourceSessionId: binding.sourceSessionId,
      sourceIdentity: binding.sourceIdentity,
    }
    const response = await guarded(lifetimeInput, () => bridge.imageQueue(request))
    const expected = { sessionId: destinationSessionId, conversationId, envelopeId: entry.envelopeId, ownerContext: binding.ownerContext }
    if (!sameOptionalIdentity(response, expected)) return refusal('IMAGE_RECOVERY_DISPATCH_IDENTITY_CHANGED')
    if (response?.deliveryDisposition === 'accepted') {
      if (response.ok !== true || response.dispatchStarted === false || !response.attemptId
        || !validSnapshot(response.result)
        || !sameOptionalIdentity(response, expected)) {
        return refusal('IMAGE_RECOVERY_DISPATCH_UNCONFIRMED')
      }
      const remaining = response.result.entries.some(row => row.state === 'not-sent')
      if (remaining) {
        const prior = waiting.get(boundaryKey)
        waiting.set(boundaryKey, {
          ...prior,
          input: { ...lifetimeInput, deferredIsCurrent: undefined, sourceBinding: binding },
          attempts: prior?.attempts || 0,
          lastRevision: prior?.lastRevision ?? lifetimeInput.readinessRevision ?? null,
          envelopeId: null,
        })
      } else {
        waiting.delete(boundaryKey)
      }
      return { ok: true, dispatched: true, deliveryDisposition: 'accepted', envelopeId: entry.envelopeId,
        attemptId: response.attemptId, boundaryKey, snapshot: response.result,
        remaining: remaining ? response.result.entries.filter(row => row.state === 'not-sent').length : 0 }
    }
    if (response?.deliveryDisposition === 'unknown') {
      waiting.delete(boundaryKey)
      return { ok: false, code: response.code || 'IMAGE_DELIVERY_UNKNOWN', retained: true,
        deliveryDisposition: 'unknown', replay: false, envelopeId: entry.envelopeId, boundaryKey }
    }
    if (response?.deliveryDisposition === 'not-sent') {
      if (response.dispatchStarted !== false || !notSentEnvelope(response.result, entry.envelopeId)) {
        return refusal('IMAGE_RECOVERY_DISPATCH_UNCONFIRMED')
      }
      if (response.retryable === true) {
        const prior = waiting.get(boundaryKey)
        const attempts = (prior?.attempts || 0) + 1
        waiting.set(boundaryKey, {
          ...prior,
          input: { ...lifetimeInput, deferredIsCurrent: undefined, sourceBinding: binding },
          attempts,
          lastRevision: prior?.lastRevision ?? lifetimeInput.readinessRevision ?? null,
          envelopeId: entry.envelopeId,
        })
        return { ok: true, dispatched: false, retryable: true, retryAfterMs: response.retryAfterMs || 1000,
          code: response.code || 'AGENT_TURN_ACTIVE', boundaryKey, attempts, snapshot: response.result }
      }
      waiting.delete(boundaryKey)
      return { ok: false, code: response.code || 'IMAGE_RECOVERY_TERMINAL_REFUSAL', retained: true,
        deliveryDisposition: 'not-sent', retryable: false, envelopeId: entry.envelopeId, boundaryKey,
        failure: response.result?.entries?.find(row => row.envelopeId === entry.envelopeId)?.failure || null }
    }
    return refusal(response?.code || 'IMAGE_RECOVERY_DISPATCH_UNCONFIRMED')
  }

  async function drain(input = {}) {
    if (disposed) return refusal('IMAGE_RECOVERY_DISPOSED')
    const binding = input.sourceBinding
    if (!binding || binding.version !== 1) return refusal('IMAGE_RECOVERY_SOURCE_BINDING_REQUIRED')
    const conversationId = input.conversationId || input.nodeId
    const destinationSessionId = requireText(input.destinationSessionId, 'destinationSessionId')
    const boundaryKey = JSON.stringify([conversationId, binding.sourceSessionId, destinationSessionId, binding.fingerprint])
    try {
      if (typeof input.awaitBoundary === 'function') {
        const boundary = await guarded(input, () => input.awaitBoundary({
          conversationId, destinationSessionId, sourceSessionId: binding.sourceSessionId,
          sourceBinding: binding,
        }))
        if (boundary?.ok === false) return refusal(boundary.code || 'IMAGE_RECOVERY_BOUNDARY_UNAVAILABLE')
        if (boundary?.ready === false) {
          const lifetimeInput = typeof input.deferredIsCurrent === 'function'
            ? { ...input, isCurrent: input.deferredIsCurrent }
            : input
          const prior = waiting.get(boundaryKey)
          waiting.set(boundaryKey, {
            ...prior,
            input: { ...lifetimeInput, deferredIsCurrent: undefined },
            attempts: prior?.attempts || 0,
            lastRevision: boundary.readinessRevision ?? input.readinessRevision ?? null,
            envelopeId: prior?.envelopeId || null,
          })
          return { ok: true, dispatched: false, retryable: true, boundaryKey,
            retryAfterMs: boundary.retryAfterMs || 1000, readinessRevision: boundary.readinessRevision ?? null }
        }
      }
      return await runDrain({ ...input, conversationId, destinationSessionId }, boundaryKey)
    } catch (error) {
      return refusal(error?.code || 'IMAGE_RECOVERY_DISPATCH_UNCONFIRMED')
    }
  }

  async function signalBoundary({ key, readinessRevision, isCurrent: boundaryCurrent } = {}) {
    if (disposed) return refusal('IMAGE_RECOVERY_DISPOSED')
    const pending = waiting.get(key)
    if (!pending) return { ok: true, attempted: false, reason: 'no-pending-boundary', boundaryKey: key }
    if (readinessRevision === undefined || readinessRevision === pending.lastRevision) {
      return { ok: true, attempted: false, retryable: true, reason: 'readiness-unchanged', boundaryKey: key }
    }
    if (typeof boundaryCurrent === 'function' && boundaryCurrent() !== true) return refusal('IMAGE_RECOVERY_STALE')
    if (!isCurrent(pending.input)) return refusal('IMAGE_RECOVERY_STALE')
    if (pending.attempts >= maxBoundaryRetries) {
      return { ok: false, code: 'IMAGE_RECOVERY_RETRY_EXHAUSTED', retained: true, boundaryKey: key,
        retryable: false, attempts: pending.attempts }
    }
    pending.lastRevision = readinessRevision
    return runDrain(pending.input, key)
  }

  return Object.freeze({
    prepare,
    transfer,
    drain,
    signalBoundary,
    pending: () => waiting.size,
    dispose() {
      disposed = true
      flights.clear()
      waiting.clear()
    },
  })
}
