import { createAutomaticImageRecoveryHost } from './automatic-image-recovery-host.js'

/*
 * Coordinator-owned registry for automatic image recovery hosts.
 *
 * A registration is made from a retained coordinator context. It is never
 * created by openTreeStore and is never disposed by a Computers view. A new
 * registration for the same computer reuses the host when its retained store
 * is unchanged; coordinator.destroy/dispose(computerId) is the lifetime fence.
 */
export function createAutomaticImageRecoveryHostRegistry({
  hostFactory = createAutomaticImageRecoveryHost,
  onOwnerInvalidated = () => {},
} = {}) {
  const hosts = new Map()
  let disposed = false

  function register(computerId, context = {}) {
    if (disposed || typeof computerId !== 'string' || !computerId) return null
    const config = context.imageRecovery
    if (!config || !context.treeStore) return null
    const previous = hosts.get(computerId)
    if (previous?.treeStore === context.treeStore) return previous.host
    previous?.host.dispose?.()
    let record
    const host = hostFactory({
      ...config,
      treeStore: context.treeStore,
      onOwnerInvalidated: detail => {
        if (hosts.get(computerId) === record) hosts.delete(computerId)
        try { onOwnerInvalidated({ computerId, ...detail }) } catch { /* durable custody remains */ }
      },
    })
    record = { host, treeStore: context.treeStore }
    hosts.set(computerId, record)
    return host
  }

  function get(computerId) {
    return hosts.get(computerId)?.host || null
  }

  function dispose(computerId) {
    const record = hosts.get(computerId)
    if (!record) return
    hosts.delete(computerId)
    record.host.dispose?.()
  }

  function destroy() {
    if (disposed) return
    disposed = true
    for (const record of hosts.values()) record.host.dispose?.()
    hosts.clear()
  }

  async function invoke(computerId, operation, input) {
    if (disposed) return { ok: false, code: 'IMAGE_RECOVERY_DISPOSED', retained: true, reconcile: true }
    const host = get(computerId)
    if (!host || typeof host[operation] !== 'function') {
      return { ok: false, code: 'IMAGE_RECOVERY_HOST_UNAVAILABLE', retained: true, reconcile: true }
    }
    try {
      return await host[operation](input)
    } catch (error) {
      return {
        ok: false,
        code: error?.code || 'IMAGE_RECOVERY_HOST_FAILED',
        retained: true,
        reconcile: true,
      }
    }
  }
  const prepare = (computerId, input) => invoke(computerId, 'prepare', input)
  const recover = (computerId, input) => invoke(computerId, 'recover', input)
  const drain = (computerId, input) => invoke(computerId, 'drain', input)

  return Object.freeze({ register, get, prepare, recover, drain, dispose, destroy, size: () => hosts.size })
}
