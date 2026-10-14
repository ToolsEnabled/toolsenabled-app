// Navigation remembers only which conversations are open. Drafts and native
// sessions keep their existing owners; this store cannot send, start or stop.
export function createConversationNavigationStore() {
  const scopes = new Map()
  return {
    save(scope, { tabs = [], activeId = null, mode = 'trees' } = {}) {
      if (typeof scope !== 'string' || !scope) return
      scopes.set(scope, { tabs: tabs.map(tab => ({ id: tab.id, createdAt: tab.createdAt ?? null, standalone: tab.standalone === true })),
        activeId, mode: mode === 'chat' ? 'chat' : 'trees' })
    },
    take(scope, resolve) {
      const saved = scopes.get(scope)
      scopes.delete(scope)
      if (!saved) return null
      const tabs = saved.tabs.filter(tab => {
        const current = resolve(tab.id, tab.standalone)
        return current && (tab.standalone || (current.createdAt ?? null) === tab.createdAt)
      })
      const activeId = tabs.some(tab => tab.id === saved.activeId) ? saved.activeId : null
      return { tabs, activeId, mode: saved.mode === 'chat' && activeId ? 'chat' : 'trees' }
    },
  }
}
const stores = new WeakMap()
export function conversationNavigationFor(document) {
  if (!stores.has(document)) stores.set(document, createConversationNavigationStore())
  return stores.get(document)
}
