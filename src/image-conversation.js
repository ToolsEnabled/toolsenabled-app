import { createImageOwnerClient } from './image-owner-client.js'
import { createImageQueueClient } from './image-queue-client.js'
import { createImageQueueDrain } from './image-queue-drain.js'

// A mounted conversation keeps admission separate from host-owned dispatch.
export function createImageConversation({ bridge, sessionId, isCurrent, mayDrain, subscribeReady, interrupt, ownerClient = null, readinessRevision = () => null }) {
  let disposed = false, client = null, drain = null, context = null
  const listeners = new Map()
  const terminal = row => row?.state === 'accepted' || row?.state === 'cancelled'
  // A confirmed delivery may precede its durable receipt. Keep that local
  // fact until storage settles, but never overwrite a settled durable row
  // with an earlier refusal or an unresolved attempt from this renderer.
  const projectOutcome = (row, outcome) => !outcome || terminal(row) ? row : { ...row, ...outcome }

  const rowListeners = new Set()
  let projection = { state: 'loading', code: null, entries: [], generation: null, destinationSessionId: null, readmissions: [] }
  let observation = 0, readFlight = null, reread = false, readAuthority = 0, displayedOwner = null, bindingId = null, mutation = null
  let drainOwner = null, drainLifecycle = 0, suspended = false
  const transfers = new Map()
  // A resend-current operation keeps its id after an uncertain native reply so
  // a later person retry replays the same idempotent replacement intent rather
  // than minting another envelope. A live promise also closes the one-flight
  // door while the first request is unresolved.
  const resendFlights = new Map()
  // Native preview returns a bounded data URL for an image whose source is at
  // most 8 MiB. 12 MiB covers the base64 expansion and data-url prefix while
  // keeping the renderer/cache contract finite.
  const previewCache = new Map()
  const previewThumbnailMaxBytes = 12 * 1024 * 1024
  const receiptHashOf = row => {
    const receipts = Array.isArray(row?.imageReceipts) ? row.imageReceipts : []
    if (!receipts.length) return null
    try {
      return receipts.map(receipt => typeof receipt?.manifestHash === 'string' && receipt.manifestHash
        ? receipt.manifestHash : JSON.stringify(receipt)).join('|')
    } catch { return null }
  }
  const previewKeyOf = (captured, row) => {
    const receiptHash = receiptHashOf(row)
    if (!receiptHash || typeof row?.envelopeId !== 'string' || !row.envelopeId) return null
    return { key: JSON.stringify([captured.ownerId, captured.currentEpoch, row.envelopeId, receiptHash]), receiptHash }
  }
  const validPreviewThumbnail = value => typeof value === 'string'
    && value.length > 0 && value.length <= previewThumbnailMaxBytes
    && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value)
  async function previewFor(captured, conversationId, row) {
    const identity = previewKeyOf(captured, row)
    if (!identity) return null
    const { key, receiptHash } = identity
    const prior = previewCache.get(key)
    if (prior) return prior
    const promise = (async () => {
      try {
        const response = await bridge.imageQueue({
          operation: 'preview', ownerContext: captured, conversationId, envelopeId: row.envelopeId,
        })
        const result = response?.result
        if (response?.ok !== true || response.operation !== 'preview'
          || result?.version !== 1 || result.envelopeId !== row.envelopeId
          || result.automaticSend !== false || !validPreviewThumbnail(result.thumbnail)
          || !Number.isSafeInteger(result.imageCount) || result.imageCount < 1) {
          return { previewState: 'unavailable', previewCode: 'IMAGE_PREVIEW_UNAVAILABLE', receiptHash }
        }
        return { previewState: 'available', thumbnail: result.thumbnail, imageCount: result.imageCount, receiptHash }
      } catch {
        return { previewState: 'unavailable', previewCode: 'IMAGE_PREVIEW_UNAVAILABLE', receiptHash }
      }
    })()
    // Keep both success and terminal failure until the receipt/owner identity
    // changes or an explicit person retry clears this exact key. A readiness
    // notification is not a new preview authorization.
    previewCache.set(key, promise)
    return promise
  }
  function forgetPreview(captured, row) {
    const identity = previewKeyOf(captured, row)
    if (identity) previewCache.delete(identity.key)
  }
  async function hydratePreviews(captured, conversationId) {
    const rows = projection.entries.filter(row => row.state === 'not-sent' && receiptHashOf(row))
    let changed = false
    for (const row of rows) {
      const preview = await previewFor(captured, conversationId, row)
      if (!preview || !current() || !owner.isCurrent(captured)) continue
      const live = projection.entries.find(item => item.envelopeId === row.envelopeId)
      if (!live || live.state !== 'not-sent' || receiptHashOf(live) !== preview.receiptHash) continue
      const next = preview.previewState === 'available'
        ? { ...live, thumbnail: preview.thumbnail, imageCount: preview.imageCount,
            previewState: 'available', previewCode: undefined }
        : { ...live, thumbnail: undefined, imageCount: undefined,
            previewState: 'unavailable', previewCode: preview.previewCode }
      const unchanged = live.previewState === next.previewState
        && live.previewCode === next.previewCode && live.thumbnail === next.thumbnail
        && live.imageCount === next.imageCount
      if (!unchanged) {
        projection = { ...projection, entries: projection.entries.map(item => item.envelopeId === row.envelopeId ? next : item) }
        changed = true
      }
    }
    if (changed) publishRows()
  }
  function publishRows() {
    const captured = displayedOwner
    const lifecycle = drainLifecycle
    for (const listener of [...rowListeners]) {
      if (disposed || drainLifecycle !== lifecycle
        || (captured && (!current() || !owner.isCurrent(captured)))) return
      try { listener(structuredClone(projection)) } catch { /* Publication is not delivery. */ }
    }
  }
  function ownerChanged(state) {
    observation++
    displayedOwner = null
    const retiredDrain = drain
    drain = null
    drainOwner = null
    bindingId = null
    drainLifecycle++
    listeners.clear()
    retiredDrain?.dispose()
    for (const record of resendFlights.values()) record.retired = true
    resendFlights.clear()
    projection = { state: 'held', code: state.code || 'IMAGE_OWNER_CHANGED', entries: [], generation: null, destinationSessionId: null, readmissions: [] }
    publishRows()
    if (state.status === 'ready') queueMicrotask(() => { if (!disposed) void refresh() })
  }
  function ensureDrain(captured, conversationId) {
    if (drain && drainOwner === captured && bindingId === conversationId) return
    const retiredDrain = drain
    drain = null
    drainOwner = null
    bindingId = null
    drainLifecycle++
    listeners.clear()
    retiredDrain?.dispose()
    const lifecycle = drainLifecycle
    let currentDrain = null
    currentDrain = createImageQueueDrain({ bridge, owner, ownerContext: captured,
      conversationId, sessionId, isCurrent: current, mayDrain: () => !suspended && mayDrain(),
      readinessRevision,
      onState: state => {
        if (!current() || !owner.isCurrent(captured) || bindingId !== conversationId
          || drain !== currentDrain || drainLifecycle !== lifecycle) return
        const settled = projection.entries.find(row => row.envelopeId === state.envelopeId && terminal(row))
        if (settled) return
        try { listeners.get(state.envelopeId)?.(state) } finally {
          if (current() && owner.isCurrent(captured) && bindingId === conversationId
            && drain === currentDrain && drainLifecycle === lifecycle) {
            projection = { ...projection, entries: projection.entries.map(row => row.envelopeId === state.envelopeId
              ? {
                ...row,
                state: state.state,
                code: state.code,
                reconcile: state.reconcile,
                ...(Object.hasOwn(state, 'failure') ? { failure: state.failure } : {}),
                ...(Object.hasOwn(state, 'retryable') ? { retryable: state.retryable } : {}),
                ...(Object.hasOwn(state, 'retryAfterMs') ? { retryAfterMs: state.retryAfterMs } : {}),
                ...(Object.hasOwn(state, 'retryAt') ? { retryAt: state.retryAt } : {}),
                ...(Object.hasOwn(state, 'retryScheduled') ? { retryScheduled: state.retryScheduled } : {}),
                ...(Object.hasOwn(state, 'retryExhausted') ? { retryExhausted: state.retryExhausted } : {}),
                ...(Object.hasOwn(state, 'dispatchStarted') ? { dispatchStarted: state.dispatchStarted } : {}),
                ...(Object.hasOwn(state, 'changeToken') ? { changeToken: state.changeToken } : {}),
                ...(Object.hasOwn(state, 'readinessRevision') ? { readinessRevision: state.readinessRevision } : {}),
                attemptId: state.attemptId || row.attemptId,
              } : row) }
            publishRows()
          }
        }
      } })
    drain = currentDrain
    drainOwner = captured
    bindingId = conversationId
  }
  async function readRows() {
    await ready
    do {
      reread = false
      const seen = observation, captured = owner.capture()
      if (!current() || !captured) return projection
      try {
        const bound = await bridge.imageQueue({ operation: 'binding', ownerContext: captured, sessionId })
        if (!current() || !owner.isCurrent(captured) || seen !== observation) { reread = true; continue }
        const binding = bound?.result
        if (!bound?.ok || binding?.sessionId !== sessionId || typeof binding.conversationId !== 'string'
          || binding.ownerContext?.ownerId !== captured.ownerId || binding.ownerContext?.currentEpoch !== captured.currentEpoch) {
          throw Object.assign(new Error('Binding unavailable'), { code: bound?.code || 'IMAGE_QUEUE_BINDING_INVALID' })
        }
        const response = await bridge.imageQueue({ operation: 'read', ownerContext: captured, conversationId: binding.conversationId })
        if (!current() || !owner.isCurrent(captured) || seen !== observation) { reread = true; continue }
        const value = response?.result
        if (!response?.ok || value?.version !== 1 || !Array.isArray(value.entries) || value.automaticSend !== false) {
          throw Object.assign(new Error('Queue unavailable'), { code: response?.code || 'IMAGE_QUEUE_RECEIPT_INVALID' })
        }
        readAuthority++
        displayedOwner = captured
        ensureDrain(captured, binding.conversationId)
        const previous = projection.entries
        projection = { state: value.writeBlocked ? 'held' : 'ready', code: value.writeBlocked || null,
          generation: value.generation, destinationSessionId: value.destinationSessionId,
          readmissions: Array.isArray(value.readmissions) ? structuredClone(value.readmissions) : [],
          authority: { ownerId: captured.ownerId, currentEpoch: captured.currentEpoch, sessionId, conversationId: binding.conversationId, generation: value.generation },
          entries: value.entries.map(row => projectOutcome(row, drain.outcome(row.envelopeId))) }
        publishRows()
        for (const row of projection.entries) {
          if (!current() || !owner.isCurrent(captured) || seen !== observation) break
          if (!terminal(row) || previous.find(prior => prior.envelopeId === row.envelopeId)?.state === row.state) continue
          try { listeners.get(row.envelopeId)?.({ ...row, ownerContext: captured }) } catch { /* Display reconciliation is not delivery. */ }
        }
        await hydratePreviews(captured, binding.conversationId)
        if (!current() || !owner.isCurrent(captured) || seen !== observation) { reread = true; continue }
      } catch (error) {
        if (!current() || !owner.isCurrent(captured) || seen !== observation) continue
        if (error?.code === 'IMAGE_OWNER_CHANGED') owner.invalidate(error.code)
        else { projection = { ...projection, state: 'held', code: error?.code || 'IMAGE_QUEUE_READ_UNCONFIRMED' }; publishRows() }
      }
    } while (reread && current())
    return projection
  }
  function refresh() {
    if (readFlight) { reread = true; return readFlight }
    readFlight = Promise.resolve().then(readRows).finally(() => { readFlight = null })
    return readFlight
  }
  async function signalReady() {
    // This is a lifecycle authorization, separate from a read or reopen.
    await refresh()
    if (!suspended && current() && displayedOwner && owner.isCurrent(displayedOwner) && mayDrain() && drain) return drain.drain()
    return { state: 'held', code: 'IMAGE_QUEUE_NOT_READY' }
  }
  function matchesView(view, captured) {
    const a = view?.authority
    return a && captured && a.ownerId === captured.ownerId && a.currentEpoch === captured.currentEpoch
      && a.sessionId === sessionId && a.conversationId === bindingId && a.generation === projection.generation
  }
  async function cancel(envelopeId, view) {
    const captured = displayedOwner, generation = projection.generation, conversationId = bindingId
    const row = projection.entries.find(item => item.envelopeId === envelopeId)
    const repairHeld = projection.state === 'held' && projection.code === 'IMAGE_OUTBOX_CLEANUP_REQUIRED'
    if (mutation || suspended || !matchesView(view, captured) || !current() || !captured || !owner.isCurrent(captured)
      || (!repairHeld && projection.state !== 'ready')
      || !row || row.state !== 'not-sent') return { ok: false, code: 'IMAGE_QUEUE_CANCEL_UNAVAILABLE' }
    mutation = crypto.randomUUID()
    try {
      const response = await bridge.imageQueue({ operation: 'cancel', ownerContext: captured, conversationId,
        expectedGeneration: generation, operationId: mutation, envelopeIds: [envelopeId] })
      if (!current() || !owner.isCurrent(captured)) return { ...response, detached: true }
      if (response?.code === 'IMAGE_OWNER_CHANGED') { owner.invalidate(response.code); return { ...response, detached: true } }
      if (!response?.ok) { projection = { ...projection, state: 'held', code: response?.code || 'IMAGE_QUEUE_CANCEL_UNCONFIRMED' }; publishRows() }
      // Historical mutation replies never become the next CAS basis.
      await refresh()
      return response
    } catch (error) {
      if (current() && owner.isCurrent(captured)) {
        if (error?.code === 'IMAGE_OWNER_CHANGED') owner.invalidate(error.code)
        else { projection = { ...projection, state: 'held', code: error?.code || 'IMAGE_QUEUE_CANCEL_UNCONFIRMED' }; publishRows() }
      }
      return { ok: false, code: error?.code || 'IMAGE_QUEUE_CANCEL_UNCONFIRMED' }
    } finally { mutation = null }
  }

  async function retry(envelopeId, view) {
    const captured = displayedOwner
    const row = projection.entries.find(item => item.envelopeId === envelopeId)
    const repairHeld = projection.state === 'held' && projection.code === 'IMAGE_OUTBOX_CLEANUP_REQUIRED'
    if (!drain || mutation || suspended || !matchesView(view, captured) || !current()
      || !captured || !owner.isCurrent(captured) || (!repairHeld && projection.state !== 'ready')
      || !row || row.state !== 'not-sent') {
      return { state: 'held', code: 'IMAGE_QUEUE_RETRY_UNAVAILABLE', envelopeId }
    }
    // A retained row may still be bound to the retired predecessor. An
    // explicit person retry performs one owner/generation/destination CAS
    // transfer before dispatch; automatic recovery uses transferDestination
    // directly while the conversation is held.
    if (projection.destinationSessionId !== sessionId) {
      const transferred = await transferDestination({
        destinationSessionId: sessionId, view, operationId: crypto.randomUUID(), explicit: true,
      })
      if (!transferred?.ok || transferred.reconcile) {
        return { state: 'held', code: transferred?.code || 'IMAGE_QUEUE_TRANSFER_UNCONFIRMED',
          envelopeId, transfer: transferred }
      }
      if (!current() || !owner.isCurrent(captured)) return { state: 'held', detached: true, envelopeId }
      await refresh()
    }
    // This is the explicit preview retry door as well as the delivery retry
    // door. Unknown delivery rows never reach this branch because their state
    // is not not-sent and drain pins them against replay.
    forgetPreview(captured, row)
    const result = await drain.retry(envelopeId)
    if (!current() || !owner.isCurrent(captured)) return { ...result, detached: true }
    await refresh()
    return result
  }


  const resendCurrentEligible = row => row?.state === 'not-sent'
    && (row.failure?.code || row.code) === 'IMAGE_QUEUE_SELECTION_CHANGED'
  const resendCurrentUncertain = result => result?.ok === false
    && result?.committed === null && result?.reconcile === true
  const resendCurrentRefusal = (code, envelopeId, operationId = null) => ({
    ok: false, state: 'held', code, envelopeId, ...(operationId ? { operationId } : {}),
  })
  async function resendWithCurrentSettings(envelopeId, view) {
    const prior = resendFlights.get(envelopeId)
    const captured = displayedOwner
    const priorOwnerValid = Boolean(prior?.ownerContext && !prior.retired
      && current() && owner.isCurrent(prior.ownerContext))
    if (prior?.promise) {
      if (priorOwnerValid) return prior.promise
      prior.retired = true
      if (resendFlights.get(envelopeId) === prior) resendFlights.delete(envelopeId)
      return resendCurrentRefusal('IMAGE_QUEUE_RESEND_UNAVAILABLE', envelopeId)
    }
    if (prior && !priorOwnerValid) {
      prior.retired = true
      if (resendFlights.get(envelopeId) === prior) resendFlights.delete(envelopeId)
    }
    if (!priorOwnerValid && current() && captured && owner.isCurrent(captured)
      && projection.entries.some(row => row.envelopeId === envelopeId && row.state === 'cancelled')) {
      await refresh()
      if (!current() || !owner.isCurrent(captured)) {
        return { ...resendCurrentRefusal('IMAGE_QUEUE_RESEND_UNAVAILABLE', envelopeId), detached: true }
      }
    }
    const persistedReadmission = !priorOwnerValid
      ? projection.readmissions.find(item => item.sourceEnvelopeId === envelopeId
        && typeof item.operationId === 'string' && item.operationId
        && typeof item.sessionId === 'string' && item.sessionId
        && typeof item.expectedGeneration === 'string' && item.expectedGeneration)
      : null
    const persistedPrior = persistedReadmission
      ? { operationId: persistedReadmission.operationId, sourceEnvelopeId: envelopeId,
          sessionId: persistedReadmission.sessionId, expectedGeneration: persistedReadmission.expectedGeneration,
          promise: null, result: null, uncertain: true, ownerContext: captured }
      : null
    const usablePrior = priorOwnerValid ? prior : persistedPrior
    const operationId = usablePrior?.operationId || crypto.randomUUID()
    const record = usablePrior || { operationId, sourceEnvelopeId: envelopeId, sessionId, expectedGeneration: null, promise: null, result: null, uncertain: false, ownerContext: captured }
    const currentResendReconciliation = freshRead => {
      if (!freshRead) return null
      const observed = projection.readmissions.find(item => item.operationId === record.operationId
        && item.sourceEnvelopeId === record.sourceEnvelopeId && item.sessionId === record.sessionId
        && item.expectedGeneration === record.expectedGeneration && typeof item.envelopeId === 'string')
      const source = projection.entries.find(item => item.envelopeId === record.sourceEnvelopeId)
      const replacement = observed
        ? projection.entries.find(item => item.envelopeId === observed.envelopeId) : null
      if (!observed || source?.state !== 'cancelled' || !replacement
        || !['not-sent', 'accepted', 'unknown'].includes(replacement.state)) return null
      return { observed, source, replacement }
    }
    const reconciledOutcome = async ({ observed, replacement }) => {
      let dispatch = null
      if (replacement.state === 'not-sent') {
        if (projection.state !== 'ready') {
          dispatch = { state: 'held', code: projection.code || 'IMAGE_QUEUE_READ_UNCONFIRMED', envelopeId: replacement.envelopeId }
        } else if (projection.destinationSessionId !== sessionId) {
          dispatch = { state: 'held', code: 'IMAGE_OUTBOX_DESTINATION_STALE', envelopeId: replacement.envelopeId }
        } else if (suspended || !mayDrain()) {
          dispatch = { state: 'held', code: 'IMAGE_QUEUE_NOT_READY', envelopeId: replacement.envelopeId }
        } else {
          ensureDrain(captured, bindingId)
          dispatch = drain
            ? await drain.retry(replacement.envelopeId)
            : { state: 'held', code: 'IMAGE_QUEUE_RETRY_UNAVAILABLE', envelopeId: replacement.envelopeId }
          if (dispatch?.state !== 'accepted'
            && (!current() || !owner.isCurrent(captured))) return { ...dispatch, detached: true }
          if (dispatch?.state === 'accepted') await refresh()
        }
      }
      const dispatchRefused = dispatch && dispatch.state !== 'accepted'
      return {
        ok: !dispatchRefused, ...(dispatchRefused ? {
          state: dispatch.state || 'held',
          code: dispatch.code || 'IMAGE_QUEUE_DISPATCH_UNCONFIRMED',
          committed: null,
          reconcile: dispatch.state === 'unknown' || dispatch.reconcile === true,
        } : {}),
        operation: 'resend-current', operationId: record.operationId,
        result: { ...structuredClone(projection), readmission: observed },
        reconciled: true, ...(dispatch ? { dispatch } : {}),
        currentSnapshot: structuredClone(projection),
      }
    }
    if (!current() || !captured || !owner.isCurrent(captured) || mutation || suspended) {
      if (!usablePrior?.uncertain) {
        return resendCurrentRefusal('IMAGE_QUEUE_RESEND_UNAVAILABLE', envelopeId, operationId)
      }
      return {
        ok: false, code: usablePrior.result?.code || 'IMAGE_QUEUE_RESEND_UNCONFIRMED',
        committed: null, reconcile: true, envelopeId, operationId,
        ...(current() ? { currentSnapshot: structuredClone(projection) } : { detached: true }),
      }
    }
    const promise = (async () => {
      try {
        if (!usablePrior?.uncertain) {
          const cachedViewDestinationMatches = view?.destinationSessionId === projection.destinationSessionId
          if (!matchesView(view, captured) || !cachedViewDestinationMatches) {
            return resendCurrentRefusal('IMAGE_QUEUE_RESEND_UNAVAILABLE', envelopeId, operationId)
          }
          const authorityBefore = readAuthority
          await refresh()
          if (!current() || !owner.isCurrent(captured)) {
            return { ...resendCurrentRefusal('IMAGE_QUEUE_RESEND_UNAVAILABLE', envelopeId, operationId), detached: true }
          }
          if (readAuthority <= authorityBefore || projection.state !== 'ready') {
            return resendCurrentRefusal(projection.code || 'IMAGE_QUEUE_READ_UNCONFIRMED', envelopeId, operationId)
          }
          const refreshedRow = projection.entries.find(item => item.envelopeId === envelopeId)
          const refreshedViewDestinationMatches = view?.destinationSessionId === projection.destinationSessionId
          if (!matchesView(view, captured) || !refreshedViewDestinationMatches
            || !resendCurrentEligible(refreshedRow)) {
            return resendCurrentRefusal('IMAGE_QUEUE_RESEND_UNAVAILABLE', envelopeId, operationId)
          }
        }
        if (usablePrior?.uncertain) {
          const authorityBefore = readAuthority
          await refresh()
          if (!current() || !owner.isCurrent(captured)) {
            return { ...resendCurrentRefusal('IMAGE_QUEUE_RESEND_UNAVAILABLE', envelopeId, operationId), detached: true }
          }
          const reconciliation = currentResendReconciliation(readAuthority > authorityBefore)
          if (reconciliation) return reconciledOutcome(reconciliation)
          return {
            ok: false, code: usablePrior.result?.code || 'IMAGE_QUEUE_RESEND_UNCONFIRMED',
            committed: null, reconcile: true, envelopeId, operationId,
            currentSnapshot: structuredClone(projection),
          }
        }
        if (projection.destinationSessionId !== sessionId) {
          const transferred = await transferDestination({
            destinationSessionId: sessionId, view, operationId: crypto.randomUUID(), explicit: true,
          })
          if (!transferred?.ok || transferred.reconcile) {
            return { ...resendCurrentRefusal(transferred?.code || 'IMAGE_QUEUE_TRANSFER_UNCONFIRMED',
              envelopeId, operationId), transfer: transferred }
          }
          if (!current() || !owner.isCurrent(captured)) return { ...transferred, detached: true, envelopeId }
          const transferAuthorityBefore = readAuthority
          await refresh()
          if (!current() || !owner.isCurrent(captured)) {
            return { ...resendCurrentRefusal('IMAGE_QUEUE_RESEND_UNAVAILABLE', envelopeId, operationId), detached: true }
          }
          if (readAuthority <= transferAuthorityBefore || projection.state !== 'ready') {
            return resendCurrentRefusal(projection.code || 'IMAGE_QUEUE_READ_UNCONFIRMED', envelopeId, operationId)
          }
          if (projection.destinationSessionId !== sessionId) {
            return resendCurrentRefusal('IMAGE_OUTBOX_DESTINATION_STALE', envelopeId, operationId)
          }
        }
        if (!current() || !owner.isCurrent(captured)) return { ok: false, detached: true, envelopeId, operationId }
        const latest = projection.entries.find(item => item.envelopeId === envelopeId)
        if (!resendCurrentEligible(latest)) {
          return resendCurrentRefusal('IMAGE_QUEUE_RESEND_UNAVAILABLE', envelopeId, operationId)
        }
        const generation = projection.generation
        const conversationId = bindingId
        if (record.expectedGeneration !== null && record.expectedGeneration !== generation) {
          return resendCurrentRefusal('IMAGE_OUTBOX_STALE', envelopeId, operationId)
        }
        if (record.expectedGeneration === null) record.expectedGeneration = generation
        const response = await bridge.imageQueue({
          operation: 'resend-current', ownerContext: captured, conversationId, sessionId,
          envelopeId, expectedGeneration: record.expectedGeneration, operationId,
        })
        if (!current() || !owner.isCurrent(captured)) return { ...response, detached: true, envelopeId, operationId }
        let outcome = response
        const readmission = response?.result?.readmission
        const validReadmission = response?.ok === true && response.operation === 'resend-current'
          && response.operationId === operationId
          && response.result?.version === 1 && response.result.automaticSend === false
          && Array.isArray(response.result.entries)
          && readmission?.sourceEnvelopeId === envelopeId
          && readmission?.sessionId === record.sessionId
          && readmission?.expectedGeneration === record.expectedGeneration
          && typeof readmission.envelopeId === 'string' && readmission.envelopeId
          && readmission.envelopeId !== envelopeId
          && readmission.selection && typeof readmission.selection === 'object'
          && !Array.isArray(readmission.selection)
        if (response?.ok === true && !validReadmission) {
          outcome = { ...response, ok: false, code: 'IMAGE_QUEUE_RECEIPT_INVALID',
            committed: null, reconcile: true, envelopeId, operationId }
        }
        const authorityBefore = readAuthority
        await refresh()
        if (!current() || !owner.isCurrent(captured)) return { ...outcome, detached: true }
        const reconciliation = currentResendReconciliation(readAuthority > authorityBefore)
        if (reconciliation) return reconciledOutcome(reconciliation)
        if (resendCurrentUncertain(outcome)) {
          // Do not project the response snapshot over a newer durable row.
          // Keep this operation and source bound for the next person retry.
          return { ...outcome, operationId, currentSnapshot: structuredClone(projection) }
        }
        if (outcome?.ok !== true) return outcome
        // A successful bridge response without its exact durable mapping is
        // not a send authorization. The explicit operation remains uncertain.
        return { ...outcome, ok: false, code: 'IMAGE_QUEUE_READMISSION_UNCONFIRMED',
          committed: null, reconcile: true, operationId, currentSnapshot: structuredClone(projection) }
      } catch (error) {
        const outcome = { ok: false, code: error?.code || 'IMAGE_QUEUE_RESEND_UNCONFIRMED',
          committed: null, reconcile: true, envelopeId, operationId }
        if (current() && owner.isCurrent(captured)) {
          const authorityBefore = readAuthority
          await refresh()
          if (!current() || !owner.isCurrent(captured)) return { ...outcome, detached: true }
          const reconciliation = currentResendReconciliation(readAuthority > authorityBefore)
          if (reconciliation) return reconciledOutcome(reconciliation)
          return { ...outcome, currentSnapshot: structuredClone(projection) }
        }
        return { ...outcome, detached: true }
      }
    })()
    record.promise = promise
    resendFlights.set(envelopeId, record)
    const outcome = await promise
    const ownerStillCurrent = !record.retired && current() && record.ownerContext
      && owner.isCurrent(record.ownerContext)
    record.promise = null
    if (!ownerStillCurrent) return { ...outcome, detached: true }
    record.result = outcome
    record.uncertain = resendCurrentUncertain(outcome)
    if (!record.uncertain && resendFlights.get(envelopeId) === record) resendFlights.delete(envelopeId)
    return outcome
  }

  function transferDestination({ destinationSessionId, view, operationId, explicit = false }) {
    const captured = displayedOwner, conversationId = bindingId
    const intent = JSON.stringify([view?.authority, view?.destinationSessionId, destinationSessionId, explicit === true])
    const prior = transfers.get(operationId)
    if (prior) return prior.intent === intent ? prior.promise.then(result => current() && owner.isCurrent(prior.ownerContext) ? result : { ...result, detached: true }) : Promise.resolve({ ok: false, code: 'IMAGE_QUEUE_OPERATION_CONFLICT' })
    if ((!suspended && explicit !== true) || !current() || !owner.isCurrent(captured) || !matchesView(view, captured)
      || typeof operationId !== 'string' || !operationId || typeof destinationSessionId !== 'string' || !destinationSessionId) {
      return Promise.resolve({ ok: false, code: 'IMAGE_QUEUE_TRANSFER_UNAVAILABLE' })
    }
    const request = { operation: 'transfer', ownerContext: captured, conversationId,
      expectedGeneration: view.authority.generation, operationId,
      expectedDestinationSessionId: view.destinationSessionId, destinationSessionId }
    const promise = (async () => {
      try {
        const response = await bridge.imageQueue(request)
        if (!current() || !owner.isCurrent(captured)) return { ...response, detached: true }
        if (response?.code === 'IMAGE_OWNER_CHANGED') { owner.invalidate(response.code); return { ...response, detached: true } }
        // Commit may have retired the source session. The captured conversation
        // remains host-authenticated under this owner; do not bind that retired
        // session again merely to read its durable partition.
        const read = await bridge.imageQueue({ operation: 'read', ownerContext: captured, conversationId })
        if (!owner.isCurrent(captured) || !current()) return { ...response, detached: true }
        if (read?.code === 'IMAGE_OWNER_CHANGED') {
          owner.invalidate(read.code)
          return { ...response, ok: false, code: read.code, detached: true, reconcile: true }
        }
        const latest = read?.result
        // A historical successful mutation does not prove the current destination.
        if (response?.ok === true && read?.ok === true && latest?.version === 1
          && latest.automaticSend === false && !latest.writeBlocked
          && typeof latest.generation === 'string' && latest.generation.length > 0
          && Array.isArray(latest.entries) && latest.destinationSessionId === destinationSessionId) {
          return { ...response, reconciled: true, currentSnapshot: structuredClone(latest) }
        }
        const code = read?.code || latest?.writeBlocked || response?.code || 'IMAGE_OUTBOX_DESTINATION_STALE'
        projection = { ...projection, state: 'held', code }
        publishRows()
        return { ...response, ok: false, reconcile: true, code }
      } catch (error) {
        const code = error?.code || 'IMAGE_QUEUE_TRANSFER_UNCONFIRMED'
        const detached = !owner.isCurrent(captured) || !current()
        if (!detached) {
          if (code === 'IMAGE_OWNER_CHANGED') owner.invalidate(code)
          else { projection = { ...projection, state: 'held', code }; publishRows() }
        }
        return { ok: false, code, reconcile: true, detached: detached || !owner.isCurrent(captured) }
      }
    })()
    transfers.set(operationId, { intent, promise, ownerContext: captured })
    return promise
  }

  const owner = ownerClient || createImageOwnerClient({ bridge, onChange: ownerChanged })
  const removeOwner = ownerClient?.subscribe(ownerChanged)
  const ready = owner.capture() ? Promise.resolve(owner.snapshot()) : owner.start()
  const current = () => !disposed && isCurrent()
  const removeReady = subscribeReady?.(() => { if (current() && mayDrain()) void signalReady() })
  async function connectDestination(admitted) {
    if (!current() || !owner.isCurrent(admitted.ownerContext)) return false
    const common = { ownerContext: admitted.ownerContext, conversationId: admitted.conversationId }
    const read = await bridge.imageQueue({ ...common, operation: 'read' })
    if (!current() || !owner.isCurrent(admitted.ownerContext) || !read?.ok || read.result?.writeBlocked) return false
    const saved = read.result
    if (!saved.entries?.some(row => row.envelopeId === admitted.entry.envelopeId)) return false
    if (saved.destinationSessionId === sessionId) return true
    // Initial binding only. Replacing an existing destination belongs to the
    // recovery transaction, not an arbitrary mount of this conversation.
    if (saved.destinationSessionId !== null) return false
    const transferred = await bridge.imageQueue({ ...common, operation: 'transfer',
      expectedGeneration: saved.generation, operationId: crypto.randomUUID(),
      expectedDestinationSessionId: null, destinationSessionId: sessionId })
    return current() && owner.isCurrent(admitted.ownerContext) && transferred?.ok === true
      && transferred.result?.destinationSessionId === sessionId
  }
  return {
    refresh, cancel, retry, resendWithCurrentSettings, signalReady, transferDestination,
    isCurrentOwner(captured) {
      const live = owner.capture()
      return current() && live && captured && live.ownerId === captured.ownerId && live.currentEpoch === captured.currentEpoch
    },
    isAdmissionOwnerCurrent(captured) {
      // Admission is already durable. A caller's separately guarded authorized
      // session transition must not turn that fact into an unconfirmed send.
      const live = owner.capture()
      return !disposed && live && captured && live.ownerId === captured.ownerId && live.currentEpoch === captured.currentEpoch
    },
    observeEnvelope({ envelopeId, conversationId, ownerContext }, listener, canPublish = () => true) {
      const captured = owner.capture()
      if (!current() || !captured || !ownerContext || captured.ownerId !== ownerContext.ownerId
        || captured.currentEpoch !== ownerContext.currentEpoch || bindingId !== conversationId
        || !projection.entries.some(row => row.envelopeId === envelopeId) || typeof listener !== 'function') return null
      const guarded = state => {
        if (current() && owner.isCurrent(captured) && bindingId === conversationId && canPublish()) listener(state)
      }
      listeners.set(envelopeId, guarded)
      const row = projection.entries.find(entry => entry.envelopeId === envelopeId)
      // Display reconciliation only; registering a listener never dispatches.
      const visible = row && ['accepted', 'cancelled', 'unknown', 'not-sent'].includes(row.state)
        ? { ...row, ownerContext: captured } : null
      if (visible) { try { guarded(visible) } catch { /* Publication is independent of delivery. */ } }
      return () => { if (listeners.get(envelopeId) === guarded) listeners.delete(envelopeId) }
    },
    detachEnvelopeListener(envelopeId, listener) {
      if (listeners.get(envelopeId) === listener) listeners.delete(envelopeId)
    },
    async prepareRetainedImages(draft) {
      await ready
      if (!current()) return { ok: false, detached: true, code: 'IMAGE_CONVERSATION_CHANGED' }
      const captured = owner.capture()
      if (!captured) return { ok: false, code: owner.snapshot().code || 'IMAGE_OWNER_UNAVAILABLE' }
      // A replacement hold stops admission/drain, not source-side byte custody.
      if (!client || captured !== context) {
        client = createImageQueueClient({ bridge, owner, sessionId, isCurrent: current })
        context = captured
      }
      const result = await client.prepareRetainedImages(draft)
      if (!current() || !client.isCurrentResult(result)) return { ...result, detached: true }
      return result
    },
    hold() { suspended = true },
    releaseHold() { suspended = false },
    subscribe(listener) {
      if (disposed || typeof listener !== 'function') return () => {}
      rowListeners.add(listener)
      if (!disposed) {
        try { listener(structuredClone(projection)) } catch { /* Publication is not delivery. */ }
      }
      if (!disposed) void refresh()
      return () => rowListeners.delete(listener)
    },
    async submit(draft, onState) {
      await ready
      if (suspended) return { ok: false, code: 'IMAGE_QUEUE_TRANSFER_PENDING' }
      if (!current()) return { ok: false, detached: true, code: 'IMAGE_CONVERSATION_CHANGED' }
      const captured = owner.capture()
      if (!captured) return { ok: false, code: owner.snapshot().code || 'IMAGE_OWNER_UNAVAILABLE' }
      if (!client || captured !== context) {
        drain?.dispose(); context = captured
        client = createImageQueueClient({ bridge, owner, sessionId, isCurrent: current })
        drain = null
      }
      if (draft.retainedDraft) {
        // This path is entered only by the owner's actual Send, never by
        // hydration or replacement. Rebind edited text to the retained images
        // under the successor's authenticated partition without restoring old text.
        const prepared = await client.prepareRetainedImages(draft)
        if (!current() || !client.isCurrentResult(prepared)) return { ...prepared, detached: true }
        if (!prepared.ok) return { ...prepared, isCurrent: () => current() && owner.isCurrent(captured) }
        draft = { ...draft, retainedDraft: prepared.retainedDraft }
      }
      const admitted = await client.admit(draft)
      if (!client.isCurrentResult(admitted) || !current()) return { ...admitted, detached: true }
      if (!admitted.ok) return { ...admitted, isCurrent: () => current() && owner.isCurrent(captured) }
      listeners.set(admitted.entry.envelopeId, onState)
      let connected = false
      try { connected = await connectDestination(admitted) } catch { /* Durable intent remains held. */ }
      if (!current() || !owner.isCurrent(captured)) return { ...admitted, detached: true }
      if (!connected) return { ...admitted, state: 'held', code: 'IMAGE_OUTBOX_DESTINATION_STALE', isCurrent: () => current() && owner.isCurrent(captured) }
      ensureDrain(captured, admitted.conversationId)
      const known = drain.outcome(admitted.entry.envelopeId)
      if (known) { try { onState?.(known) } catch { /* The retained delivery fact is independent of UI callbacks. */ } }
      if (draft.sendNow && !mayDrain() && typeof interrupt === 'function') {
        try { await interrupt() } catch { /* Host dispatch still owns readiness. */ }
      }
      await refresh()
      if (current() && mayDrain()) void drain.drain()
      return { ...admitted, state: 'queued', isCurrent: () => current() && owner.isCurrent(captured) }
    },
    dispose() {
      disposed = true
      removeReady?.()
      const retiredDrain = drain
      drain = null
      drainOwner = null
      bindingId = null
      drainLifecycle++
      listeners.clear()
      retiredDrain?.dispose()
      removeOwner?.()
      if (!ownerClient) owner.dispose()
      previewCache.clear()
      resendFlights.clear()
      rowListeners.clear()
      observation++
    }
  }
}
