// One marker for the actual route of each mounted view. No URL parameters,
// node identity, prompts or DOM text enter the diagnostic channel.
export function createPageDiagnostics({ send = event => globalThis.window?.mcSettings?.diagnosticsPage?.(event) } = {}) {
  const mounted = new Map()
  let nextId = 0, closed = false
  const emit = value => { try { send(value) } catch { /* diagnostics cannot block navigation */ } }
  function mount(view, route) {
    if (closed || !view || mounted.has(view)) return false
    const marker = { route, mountId: ++nextId }
    mounted.set(view, marker)
    emit({ route: marker.route, phase: 'mount', mountId: marker.mountId })
    return true
  }
  function unmount(view) {
    const marker = mounted.get(view)
    if (!marker) return false
    mounted.delete(view)
    emit({ route: marker.route, phase: 'unmount', mountId: marker.mountId })
    return true
  }
  function close() {
    if (closed) return
    closed = true
    for (const view of mounted.keys()) unmount(view)
  }
  return Object.freeze({ mount, unmount, close })
}
