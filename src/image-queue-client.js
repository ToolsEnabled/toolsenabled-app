// Async durable admission. Dispatch, replay and queue hydration are separate.
// A refused operation retains its immutable intent and receipt for reconciliation.
export function createImageQueueClient({ bridge, owner, sessionId, isCurrent = () => true, newOperationId = () => crypto.randomUUID() }) {
  const operations = new Map()
  const preparations = new Map()
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
  let active = null
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const current = captured => isCurrent() && owner.isCurrent(captured)
  const refusal = (code, extra = {}) => ({ ok: false, code, retained: true, ...extra })
  const refOf = receipt => ({ version: receipt?.version, id: receipt?.id, slot: receipt?.slot,
    manifestHash: receipt?.manifestHash, imageCount: receipt?.imageCount })
  const validRef = ref => ref?.version === 1 && typeof ref.id === 'string'
    && Number.isInteger(ref.slot) && ref.slot >= 0
    && typeof ref.manifestHash === 'string' && /^[a-f0-9]{64}$/.test(ref.manifestHash)
    && Number.isInteger(ref.imageCount) && ref.imageCount > 0 && ref.imageCount <= 8
  const snapshot = value => value?.version === 1 && (value.generation === null || typeof value.generation === 'string')
    && Array.isArray(value.entries) && value.automaticSend === false
    && (value.destinationSessionId === null || typeof value.destinationSessionId === 'string')
  async function call(record, operation, fields = {}) {
    if (!current(record.ownerContext)) return refusal('IMAGE_OWNER_CHANGED', { detached: true })
    try {
      const result = await bridge.imageQueue({ operation, ownerContext: record.ownerContext,
        ...(record.conversationId ? { conversationId: record.conversationId } : {}), ...fields })
      if (result?.ok === false) {
        if (result.code === 'IMAGE_OWNER_CHANGED' && current(record.ownerContext)) owner.invalidate(result.code)
        return refusal(result.code || 'IMAGE_QUEUE_REFUSED', {
          detached: !current(record.ownerContext), committed: result.committed,
          operationId: result.operationId, generation: result.generation, reconcile: result.reconcile,
        })
      }
      if (!current(record.ownerContext)) return refusal('IMAGE_OWNER_CHANGED', { detached: true, reconcile: true })
      if (result?.ok !== true || !result.result) return refusal('IMAGE_QUEUE_RECEIPT_INVALID', { reconcile: true })
      const replyOperation = operation === 'draft-retain' ? 'retain' : operation
      if (operation !== 'binding' && (result.operation !== replyOperation
        || (operation !== 'draft-adopt' && result.operationId !== (fields.operationId || null)))) {
        return refusal('IMAGE_QUEUE_RECEIPT_INVALID', { reconcile: true })
      }
      return result
    } catch (error) {
      if (error?.code === 'IMAGE_OWNER_CHANGED' && current(record.ownerContext)) owner.invalidate(error.code)
      return refusal(error?.code || 'IMAGE_QUEUE_REQUEST_UNCONFIRMED', { reconcile: true, detached: !current(record.ownerContext) })
    }
  }
  async function admit(record) {
    if (record.intent.hostDraft) {
      const grant = record.intent.hostDraft
      if (grant.sessionId !== sessionId || !grant.conversationId
        || !same(grant.ownerContext, record.ownerContext)) return refusal('IMAGE_CUSTODY_SCOPE')
      const response = await call(record, 'draft-adopt', { draftId: grant.draftId, sessionId, imageIds: grant.imageIds })
      if (!response.ok) return response
      const adopted = response.result
      if (adopted.draftId !== grant.draftId || adopted.sessionId !== sessionId
        || adopted.computerId !== grant.computerId || adopted.conversationId !== grant.conversationId
        || !same(adopted.ownerContext, record.ownerContext) || !same(adopted.imageIds, grant.imageIds)
        || adopted.automaticSend !== false) return refusal('IMAGE_QUEUE_RECEIPT_INVALID', { reconcile: true })
    }
    let response = await call(record, 'binding', { sessionId })
    if (!response.ok) return response
    const binding = response.result
    if (binding.sessionId !== sessionId || typeof binding.conversationId !== 'string' || !binding.conversationId
      || !same(binding.ownerContext, record.ownerContext)) return refusal('IMAGE_QUEUE_BINDING_INVALID')
    if (record.intent.hostDraft && binding.conversationId !== record.intent.hostDraft.conversationId) return refusal('IMAGE_CUSTODY_SCOPE')
    record.conversationId = binding.conversationId
    response = await call(record, 'read')
    if (!response.ok) return response
    if (!snapshot(response.result)) return refusal('IMAGE_QUEUE_RECEIPT_INVALID')
    if (response.result.writeBlocked) return refusal(response.result.writeBlocked)
    record.expectedGeneration = response.result.generation
    record.priorIds = new Set(response.result.entries.map(entry => entry.envelopeId))
    if (record.intent.hostDraft) {
      const grant = record.intent.hostDraft
      response = await call(record, 'draft-retain', { draftId: grant.draftId, sessionId,
        imageIds: grant.imageIds, operationId: record.retainOperationId })
      if (!response.ok) return response
      const ref = refOf(response.result)
      if (!validRef(ref) || ref.imageCount !== grant.imageIds.length || response.result.state !== 'retained') {
        return refusal('IMAGE_QUEUE_RECEIPT_INVALID', { reconcile: true })
      }
      record.imageReceipts = [ref]
    } else if (record.intent.retainedDraft) {
      const kept = record.intent.retainedDraft
      if (!same(kept.ownerContext, record.ownerContext) || kept.conversationId !== record.conversationId) return refusal('IMAGE_CUSTODY_SCOPE')
      for (const ref of kept.imageReceipts) {
        response = await call(record, 'reopen', { receipt: ref })
        if (!response.ok) return response
        const value = response.result
        if (value.version !== 1 || value.id !== ref.id || value.conversationId !== record.conversationId
          || value.state !== 'retained' || value.automaticSend !== false
          || !Array.isArray(value.images) || value.images.length !== ref.imageCount) return refusal('IMAGE_QUEUE_RECEIPT_INVALID')
      }
      record.imageReceipts = structuredClone(kept.imageReceipts)
    } else if (record.intent.images.length) {
      response = await call(record, 'retain', { sessionId, operationId: record.retainOperationId, images: record.intent.images })
      if (!response.ok) return response
      const ref = refOf(response.result)
      if (!validRef(ref) || ref.imageCount !== record.intent.images.length || response.result.state !== 'retained') {
        return refusal('IMAGE_QUEUE_RECEIPT_INVALID', { reconcile: true })
      }
      record.imageReceipts = [ref]
    }
    response = await call(record, 'admit', { expectedGeneration: record.expectedGeneration, operationId: record.operationId,
      sessionId, text: record.intent.text, imageReceipts: record.imageReceipts,
      ...(record.intent.model !== null || record.intent.effort !== undefined
        ? { selection: { model: record.intent.model, ...(record.intent.effort !== undefined ? { effort: record.intent.effort } : {}) } } : {}) })
    if (!response.ok) return response
    const saved = response.result
    if (!snapshot(saved) || !saved.generation || saved.writeBlocked) return refusal('IMAGE_QUEUE_RECEIPT_INVALID', { reconcile: true })
    // This ID is minted by admit, never selected from a same-text existing row.
    const oldIds = record.priorIds
    const rows = saved.entries.filter(entry => !oldIds.has(entry.envelopeId)
      && entry.text === record.intent.text && same(entry.imageReceipts, record.imageReceipts) && entry.state === 'not-sent'
      && entry.selection && ['model', 'effort'].every(key => entry.selection[key] === null || typeof entry.selection[key] === 'string')
      && (record.intent.model === null || entry.selection.model === record.intent.model)
      && (record.intent.effort === undefined || entry.selection.effort === record.intent.effort))
    if (rows.length !== 1) return refusal('IMAGE_QUEUE_RECEIPT_INVALID', { reconcile: true })
    record.receipt = structuredClone(rows[0])
    return { ok: true, operationId: record.operationId, ownerContext: record.ownerContext,
      conversationId: record.conversationId, generation: saved.generation, entry: structuredClone(record.receipt),
      automaticSend: false }
  }
  return {
    // Retaining bytes preserves a draft; it never admits a row or authorizes delivery.
    prepareRetainedImages({ operationId = newOperationId(), text, images, revision, draftId, retainedDraft = null }) {
      const captured = owner.capture()
      if (!captured || !current(captured)) return Promise.resolve(refusal('IMAGE_OWNER_UNAVAILABLE'))
      if (typeof draftId !== 'string' || !draftId || typeof text !== 'string' || !Number.isSafeInteger(revision) || revision < 0
        || !Array.isArray(images) || !images.length || images.length > 8
        || images.some(image => typeof image?.path !== 'string' || !image.path)) return Promise.resolve(refusal('IMAGE_QUEUE_INTENT_INVALID'))
      const intent = { text, images: images.map(image => ({ path: image.path })), revision, draftId }
      const previous = preparations.get(operationId)
      if (previous) return same(previous.intent, intent) && same(previous.retainedDraft, retainedDraft) && same(previous.ownerContext, captured)
        ? previous.promise.then(result => current(captured) ? result : refusal('IMAGE_OWNER_CHANGED', { detached: true }))
        : Promise.resolve(refusal('IMAGE_QUEUE_OPERATION_CONFLICT'))
      const record = { operationId, intent: structuredClone(intent), retainedDraft: structuredClone(retainedDraft), ownerContext: captured }
      record.promise = (async () => {
        let response = await call(record, 'binding', { sessionId })
        if (!response.ok) return response
        const binding = response.result
        if (binding.sessionId !== sessionId || !binding.conversationId || !same(binding.ownerContext, captured)) return refusal('IMAGE_QUEUE_BINDING_INVALID')
        record.conversationId = binding.conversationId
        let refs
        if (retainedDraft) {
          // Receipt reuse changes only the unsent draft intent. Actual host
          // reopen revalidates custody; the renderer token is not authority.
          if (!same(retainedDraft.ownerContext, captured) || retainedDraft.conversationId !== binding.conversationId
            || !same(retainedDraft.images, intent.images) || !Array.isArray(retainedDraft.imageReceipts)
            || !retainedDraft.imageReceipts.length || retainedDraft.imageReceipts.some(ref => !validRef(ref))
            || retainedDraft.imageReceipts.reduce((n, ref) => n + ref.imageCount, 0) !== intent.images.length) return refusal('IMAGE_CUSTODY_SCOPE')
          refs = structuredClone(retainedDraft.imageReceipts)
        } else {
          response = await call(record, 'retain', { sessionId, operationId, images: intent.images })
          if (!response.ok) return response
          const ref = refOf(response.result)
          if (!validRef(ref) || ref.imageCount !== intent.images.length || response.result.state !== 'retained') return refusal('IMAGE_QUEUE_RECEIPT_INVALID')
          refs = [ref]
        }
        for (const ref of refs) {
          response = await call(record, 'reopen', { receipt: ref })
          if (!response.ok) return response
          const value = response.result
          if (value.version !== 1 || value.id !== ref.id || value.conversationId !== binding.conversationId
            || value.state !== 'retained' || value.automaticSend !== false
            || !Array.isArray(value.images) || value.images.length !== ref.imageCount) return refusal('IMAGE_CUSTODY_SCOPE')
        }
        return { ok: true, ownerContext: captured, automaticSend: false,
          retainedDraft: freeze(structuredClone({ version: 1, ...intent, ownerContext: captured,
            conversationId: binding.conversationId, imageReceipts: refs })) }
      })().then(result => ({ ...result, ownerContext: captured }))
      preparations.set(operationId, record)
      return record.promise
    },
    // A second click for the same operation returns its retained outcome; even a
    // conflict does not refresh generation and retry a stale operation.
    admit(intentInput) {
      const { operationId = newOperationId(), text, images = [], model = null, effort = undefined } = intentInput
      const refuseHere = code => Promise.resolve({ ...refusal(code), ownerContext: owner.capture() })
      if ((Object.hasOwn(intentInput, 'effort') && effort === undefined) || (effort !== undefined && effort !== null && typeof effort !== 'string')) return refuseHere('IMAGE_QUEUE_INTENT_INVALID')
      const hostDraft = intentInput.hostDraft
      if (hostDraft && (typeof hostDraft.draftId !== 'string' || !hostDraft.draftId
        || hostDraft.sessionId !== sessionId || typeof hostDraft.computerId !== 'string' || !hostDraft.computerId
        || typeof hostDraft.conversationId !== 'string' || !hostDraft.conversationId
        || !Array.isArray(hostDraft.imageIds) || !hostDraft.imageIds.length || hostDraft.imageIds.length > 8
        || new Set(hostDraft.imageIds).size !== hostDraft.imageIds.length
        || hostDraft.imageIds.some(id => typeof id !== 'string' || !id)
        || intentInput.retainedDraft || !Array.isArray(images) || images.length)) return refuseHere('IMAGE_QUEUE_INTENT_INVALID')
      if (typeof text !== 'string' || !Array.isArray(images) || images.length > 8
        || Array.from(images).some(image => !image || typeof image.path !== 'string' || !image.path)
        || (!text.trim() && images.length === 0 && !hostDraft)) return refuseHere('IMAGE_QUEUE_INTENT_INVALID')
      const kept = intentInput.retainedDraft
      const imagePaths = images.map(image => ({ path: image.path }))
      if (kept && (kept.version !== 1 || !kept.draftId || kept.draftId !== intentInput.draftId || kept.revision !== intentInput.revision || !Number.isSafeInteger(kept.revision)
        || kept.text !== text || !same(kept.images, imagePaths) || !Array.isArray(kept.imageReceipts)
        || !kept.imageReceipts.length || kept.imageReceipts.some(ref => !validRef(ref))
        || kept.imageReceipts.reduce((n, ref) => n + ref.imageCount, 0) !== images.length)) return refuseHere('IMAGE_QUEUE_DRAFT_CHANGED')
      const intent = { text, images: imagePaths, model, effort,
        ...(hostDraft ? { hostDraft: structuredClone(hostDraft) } : {}),
        ...(kept ? { retainedDraft: structuredClone(kept), revision: intentInput.revision, draftId: intentInput.draftId } : {}) }
      const old = operations.get(operationId)
      if (old) return same(old.intent, intent) ? old.promise : Promise.resolve({ ...refusal('IMAGE_QUEUE_OPERATION_CONFLICT'), ownerContext: old.ownerContext })
      if (active) return refuseHere('IMAGE_QUEUE_BUSY')
      const captured = owner.capture()
      if (!captured || !current(captured)) return refuseHere('IMAGE_OWNER_UNAVAILABLE')
      if (typeof bridge?.imageQueue !== 'function') return refuseHere('IMAGE_QUEUE_BRIDGE_UNAVAILABLE')
      const record = { operationId, retainOperationId: newOperationId(), ownerContext: captured,
        intent: structuredClone(intent), imageReceipts: [], priorIds: new Set() }
      // Capture prior row identities from the read receipt in this operation.
      operations.set(operationId, record)
      active = record
      record.promise = Promise.resolve().then(() => admit(record)).then(result => {
        record.outcome = { ...result, ownerContext: record.ownerContext }
        return record.outcome
      }).finally(() => { if (active === record) active = null })
      return record.promise
    },
    isCurrentResult: result => Boolean(result?.ownerContext) && current(result.ownerContext),
    pending: operationId => {
      const record = operations.get(operationId)
      return record ? { operationId, intent: structuredClone(record.intent), imageReceipts: structuredClone(record.imageReceipts),
        outcome: record.outcome ? structuredClone(record.outcome) : null } : null
    },
  }
}

export async function admitImageComposerIntent({ client, draft, revision, clearIfRevision, onQueued, onRefused }) {
  const captured = structuredClone(draft)
  const result = await client.admit(captured)
  if (!client.isCurrentResult(result)) return { ...result, detached: true }
  if (!result.ok) { onRefused?.(result, captured); return result }
  try { onQueued?.(result, captured) } catch { return { ...result, publicationError: 'IMAGE_QUEUE_PUBLICATION_FAILED' } }
  if (client.isCurrentResult(result)) clearIfRevision?.(revision)
  return result
}
