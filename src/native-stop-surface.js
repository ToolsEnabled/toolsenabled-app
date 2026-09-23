/* Native preload only. Readiness follows the actual mounted controller;
   a hosted Stop never changes the person's route to obtain one. */
export function createNativeStopSurface(bridge) {
  if (!bridge || !['onRequest', 'ready', 'close', 'complete'].every(key => typeof bridge[key] === 'function')) return null
  let generation = 0
  let controller = null
  const safely = promise => Promise.resolve(promise).catch(() => {})
  const unsubscribe = bridge.onRequest(async request => {
    const mine = controller
    const key = { requestId: request?.requestId, token: request?.token }
    let result = { outcome: 'not-sent' }
    try {
      if (mine) result = await mine.run(request?.target, () => bridge.close(key))
    } catch { result = { outcome: 'not-sent' } }
    await safely(bridge.complete({ ...key, ...(result?.outcome === 'not-sent' ? { outcome: 'not-sent' } : {}),
      savedState: result?.savedState === 'recorded' ? 'recorded' : 'unconfirmed' }))
  })
  function clear() { generation += 1; controller = null; void safely(bridge.ready(false)) }
  return {
    clear,
    mount(next) {
      clear()
      const mine = generation
      if (!next || typeof next.run !== 'function') return
      Promise.resolve(next.ready).then(available => {
        if (available === false || generation !== mine) return
        controller = next
        void safely(bridge.ready(true))
      }).catch(() => {})
    },
    dispose() { clear(); unsubscribe() },
  }
}
