// Host-issued pre-session image authority. This client never starts or sends.
export function createImageDraftClient({ bridge, owner, kind, computerId, nodeId, isCurrent = () => true }) {
  let disposed = false, registration = null, registerFlight = null
  const imageIds = new Set()
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
  const sameOwner = (a, b) => a?.ownerId === b?.ownerId && a?.currentEpoch === b?.currentEpoch
  const current = captured => !disposed && isCurrent() && owner.isCurrent(captured)
  const refuse = (code, captured) => ({ ok: false, code, detached: captured ? !current(captured) : false })
  async function request(operation, captured, fields) {
    if (!current(captured)) return refuse('IMAGE_OWNER_CHANGED', captured)
    try {
      const response = await bridge.imageQueue({ operation, ownerContext: captured, ...fields })
      if (!current(captured)) return refuse('IMAGE_OWNER_CHANGED', captured)
      if (response?.ok !== true) {
        if (response?.code === 'IMAGE_OWNER_CHANGED' && current(captured)) owner.invalidate(response.code)
        return { ...response, ok: false, code: response?.code || 'IMAGE_DRAFT_UNCONFIRMED', detached: !current(captured) }
      }
      if (response.operation !== operation || !response.result) return refuse('IMAGE_QUEUE_RECEIPT_INVALID', captured)
      return response
    } catch (error) {
      if (error?.code === 'IMAGE_OWNER_CHANGED' && current(captured)) owner.invalidate(error.code)
      return refuse(error?.code || 'IMAGE_DRAFT_UNCONFIRMED', captured)
    }
  }
  async function register() {
    if (disposed || !isCurrent()) return refuse('IMAGE_CONVERSATION_CHANGED')
    if (registration) return current(registration.captured)
      ? { ok: true, result: registration.grant } : refuse('IMAGE_OWNER_CHANGED', registration.captured)
    if (registerFlight) return registerFlight
    registerFlight = owner.prepareImages(async ({ ownerContext: captured }) => {
      const response = await request('draft-register', captured, { kind, computerId, nodeId })
      if (!response.ok) return response
      const grant = response.result
      if (typeof grant.draftId !== 'string' || !grant.draftId || typeof grant.sessionId !== 'string' || !grant.sessionId
        || grant.computerId !== computerId || grant.conversationId !== nodeId || !sameOwner(grant.ownerContext, captured)) {
        return refuse('IMAGE_QUEUE_RECEIPT_INVALID', captured)
      }
      if (!current(captured)) return refuse('IMAGE_OWNER_CHANGED', captured)
      registration = { captured, grant: freeze(structuredClone(grant)) }
      return { ok: true, result: registration.grant }
    }).then(result => result.ok ? result.value : result)
    // Preserve the same grant/uncertain registration; no implicit new reservation.
    return registerFlight
  }
  return {
    register,
    async paste({ mime, data }) {
      const registered = await register()
      if (!registered.ok) return registered
      const captured = registration.captured
      const response = await request('draft-paste', captured, { draftId: registration.grant.draftId, mime, data })
      if (!response.ok) return response
      if (response.result.draftId !== registration.grant.draftId || typeof response.result.imageId !== 'string' || !response.result.imageId) {
        return refuse('IMAGE_QUEUE_RECEIPT_INVALID', captured)
      }
      imageIds.add(response.result.imageId)
      return response
    },
    startIdentity() {
      if (!registration || !current(registration.captured)) return null
      const { sessionId, draftId, ownerContext } = registration.grant
      return freeze(structuredClone({ sessionId, draftId, ownerContext }))
    },
    capture(imageOrder) {
      if (!registration || !current(registration.captured) || !Array.isArray(imageOrder)
        || !imageOrder.length || imageOrder.length > 8 || new Set(imageOrder).size !== imageOrder.length
        || imageOrder.some(id => !imageIds.has(id))) return null
      return freeze(structuredClone({ ...registration.grant, imageIds: imageOrder }))
    },
    isCurrent: () => Boolean(registration && current(registration.captured)),
    dispose() { disposed = true },
  }
}
