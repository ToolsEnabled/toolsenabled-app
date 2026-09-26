// Unsent drafts belong to a computer/node and surface for this renderer's lifetime.
// The composer owns their shape (including attachments and selection); this
// handoff only carries its export across a route or rail remount.
export function createTreeChatDraftStore() {
  const drafts = new Map()
  const owners = new Map()
  const keyFor = (computerId, nodeId) => typeof computerId === 'string' && computerId
    && typeof nodeId === 'string' && nodeId ? JSON.stringify([computerId, nodeId]) : null
  return {
    mount(computerId, nodeId, root, { scope = 'rail' } = {}) {
      const nodeKey = keyFor(computerId, nodeId)
      if (!nodeKey) return () => {}
      const key = `${nodeKey}:${typeof scope === 'string' && scope ? scope : 'rail'}`
      const owner = {}
      owners.set(key, owner)
      const draft = drafts.get(key)
      // Consume the handoff. A later successful send, empty box, or queue
      // recall must never uncover an older saved copy of these words.
      drafts.delete(key)
      if (draft) root.importDraft?.(draft)
      return () => {
        if (owners.get(key) !== owner) return
        owners.delete(key)
        const current = root.exportDraft?.()
        drafts.delete(key)
        // exportDraft returns null during a queue edit: those words already
        // belong to the outbox, and must not become a second unsent message.
        if (current && (current.text || current.attachments?.length)) {
          drafts.set(key, { ...current, attachments: current.attachments?.slice() || [] })
        }
      }
    },
    forget(computerId, nodeId) {
      const nodeKey = keyFor(computerId, nodeId)
      if (!nodeKey) return
      // Removing the node invalidates every surface's release closure too.
      // A later teardown must not recreate the removed conversation's draft.
      const prefix = `${nodeKey}:`
      for (const key of new Set([...drafts.keys(), ...owners.keys()])) {
        if (!key.startsWith(prefix)) continue
        drafts.delete(key)
        owners.delete(key)
      }
    },
  }
}

export const treeChatDrafts = createTreeChatDraftStore()
