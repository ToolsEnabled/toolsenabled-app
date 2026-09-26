import { createImageOwnerClient } from './image-owner-client.js'
import { createAutomaticImageRecoveryTransfer } from './automatic-image-recovery-transfer.js'
import { createAutomaticImageRecoveryBinder } from './automatic-image-recovery-binder.js'

const TERMINAL = new Set(['finished', 'turn-failed', 'cancelled', 'interrupted'])
const safe = fn => {
  try { return fn() === true } catch { return false }
}
const nodeBusyDefault = node => ['starting', 'running'].includes(node?.status)

function revisionFor(node, busy) {
  if (!node) return null
  return JSON.stringify({
    sessionId: node.sessionId || null,
    lastTurnId: node.lastTurnId || null,
    status: node.status || null,
    busy: safe(() => busy(node)),
  })
}

/*
 * T839 host-lifetime owner for automatic image recovery.
 *
 * This module deliberately accepts a retained coordinator context, not a
 * Computers view. The tree store belongs to the coordinator registration and
 * survives route/view destruction; no callback below captures a view, DOM node,
 * or imageConversationFor closure. The owner client is also host-scoped, so an
 * owner epoch change fences the pending queue rather than replaying it.
 */
export function createAutomaticImageRecoveryHost({
  bridge,
  treeStore,
  canContinue = () => true,
  nodeBusy = nodeBusyDefault,
  readiness = null,
  ownerClient = null,
  subscribeAgentEvents = listener => typeof bridge?.onEvent === 'function' ? bridge.onEvent(listener) : () => {},
  onOwnerInvalidated = () => {},
} = {}) {
  if (!bridge || typeof bridge.imageQueue !== 'function') {
    throw new TypeError('Automatic image recovery needs the native imageQueue bridge.')
  }
  if (!treeStore || typeof treeStore.getNode !== 'function') {
    throw new TypeError('Automatic image recovery needs the retained coordinator tree store.')
  }

  let disposed = false
  let ownerReadySeen = false
  let ownerInvalidated = false
  let ownerStart = null
  const owner = ownerClient || createImageOwnerClient({ bridge })

  const hostCurrent = () => !disposed && !ownerInvalidated && safe(canContinue)
  const sameOwner = (left, right) => Boolean(left && right)
    && left.version === right.version
    && left.ownerId === right.ownerId
    && left.currentEpoch === right.currentEpoch
    && left.kind === right.kind
  const ownerCurrent = captured => {
    const live = owner.capture()
    return Boolean(captured && live && sameOwner(live, captured))
      && hostCurrent() && owner.isCurrent(live)
  }
  const ensureOwner = async () => {
    if (disposed) return null
    if (!ownerStart) ownerStart = Promise.resolve(owner.start()).catch(() => owner.snapshot())
    await ownerStart
    const captured = owner.capture()
    return captured && hostCurrent() ? captured : null
  }
  const currentNode = nodeId => {
    try { return treeStore.getNode(nodeId) || null } catch { return null }
  }
  const readinessRevision = (nodeId, _sessionId, providedNode) => revisionFor(
    providedNode || currentNode(nodeId), nodeBusy,
  )
  const subscribeNodeStatus = (nodeId, listener) => {
    if (typeof treeStore.subscribe !== 'function') return () => {}
    let prior = readinessRevision(nodeId, null, currentNode(nodeId))
    return treeStore.subscribe(snapshot => {
      if (disposed) return
      const node = snapshot?.nodes?.find(item => item?.id === nodeId) || currentNode(nodeId)
      const next = readinessRevision(nodeId, null, node)
      if (next !== null && next !== prior) {
        prior = next
        try { listener() } catch { /* status observers cannot alter custody */ }
      }
    })
  }

  const nativeReadiness = async ({ input }) => {
    const sessionId = input?.destinationSessionId || input?.expectedSessionId || input?.sourceSessionId
    if (typeof readiness === 'function') {
      try {
        const result = await readiness({ input, sessionId })
        return result ?? { known: true, busy: true }
      } catch {
        return { known: true, busy: true }
      }
    }
    if (!sessionId || typeof bridge?.sessionActivity !== 'function') return null
    try {
      const activity = await bridge.sessionActivity({ sessionId })
      if (!activity || activity.ok !== true || activity.closing === true) {
        return { known: true, busy: true }
      }
      return { known: true, busy: activity.busy !== false }
    } catch {
      return { known: true, busy: true }
    }
  }

  const transfer = createAutomaticImageRecoveryTransfer({
    bridge,
    captureOwnerContext: async () => ensureOwner(),
  })
  const binder = createAutomaticImageRecoveryBinder({
    transfer,
    bridge,
    getNode: currentNode,
    nodeBusy,
    readinessRevision,
    readiness: nativeReadiness,
    ownerIsCurrent: (_nodeId, captured) => ownerCurrent(captured),
    canContinue: hostCurrent,
    subscribeNodeStatus,
    subscribeAgentEvents,
  })

  const removeOwner = owner.subscribe(state => {
    if (state?.status === 'ready') {
      ownerReadySeen = true
      return
    }
    if (!ownerReadySeen || disposed || ownerInvalidated) return
    ownerInvalidated = true
    // The registry retires this host on invalidation, so no later registry
    // teardown can release its owner subscription. End the entire lifetime
    // here; dispose() preserves a caller-owned owner client.
    dispose()
    try { onOwnerInvalidated({ code: state?.code || 'IMAGE_OWNER_CHANGED' }) } catch { /* custody remains retained */ }
  })

  const withOwner = async input => {
    const captured = await ensureOwner()
    if (!captured) return { ok: false, code: 'IMAGE_OWNER_UNAVAILABLE', retained: true, reconcile: true }
    return { ...input, ownerContext: captured }
  }

  async function prepare(input = {}) {
    const owned = await withOwner(input)
    if (owned.ok === false) return owned
    return binder.prepare(owned)
  }
  async function recover(input = {}) {
    const owned = await withOwner(input)
    if (owned.ok === false) return owned
    return binder.recover(owned)
  }
  async function drain(input = {}) {
    const owned = await withOwner(input)
    if (owned.ok === false) return owned
    return binder.drain(owned)
  }
  function dispose() {
    if (disposed) return
    disposed = true
    removeOwner?.()
    binder.dispose()
    if (!ownerClient) owner.dispose()
  }

  return Object.freeze({
    prepare,
    recover,
    drain,
    signal: binder.signal,
    pending: binder.pending,
    ownerSnapshot: () => owner.snapshot(),
    dispose,
  })
}
