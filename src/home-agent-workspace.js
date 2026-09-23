// A Home workspace holds one session/event/outbox owner per computer. Panes
// mount chat surfaces from that owner; hiding a pane never creates a sender.
export function createHomeAgentWorkspacePool({
  loadView = () => import('./views/computers.js'),
  documentRef = globalThis.document,
} = {}) {
  const owners = new Map()
  let destroyed = false
  const retire = owner => {
    if (owner.retired) return
    owner.retired = true
    owner.view?.destroy()
    owner.holder?.remove()
    if (owners.get(owner.computerId) === owner) owners.delete(owner.computerId)
  }
  function acquire(computerId) {
    let owner = owners.get(computerId)
    if (!owner) {
      owner = { computerId, references: 0, view: null, holder: null }
      owners.set(computerId, owner)
      owner.ready = Promise.resolve().then(loadView).then(async ({ computersView }) => {
        if (destroyed || owner.references === 0) return null
        owner.view = computersView({ initialComputer: computerId, chatWorkspace: true,
          navigate: href => { window.location.hash = href } })
        owner.holder = documentRef.createElement('div')
        owner.holder.className = 'home-agent-runtime-owner'
        owner.holder.hidden = true
        if (owner.holder.style) owner.holder.style.display = 'none'
        owner.holder.appendChild(owner.view.el)
        documentRef.body?.appendChild(owner.holder)
        const controller = owner.view.chatWorkspace
        if (!controller) throw new Error('The shared conversation runtime is unavailable.')
        await controller.ready
        return destroyed || owner.references === 0 ? null : controller
      })
    }
    owner.references++
    return owner
  }
  function mountSurface(host, computerId, mount) {
    let disposed = false, surface = null, owner = null
    const loading = documentRef.createElement('p')
    loading.className = 'home-scope-empty'
    loading.setAttribute('role', 'status')
    loading.textContent = 'Opening conversation…'
    host.appendChild(loading)
    const release = () => {
      if (disposed) return
      disposed = true
      surface?.dispose?.()
      loading.remove()
      if (!owner) return
      owner.references--
      // New-chat → saved-chat replacement happens in one render. Let that
      // render acquire its next surface before retiring the session owner.
      queueMicrotask(() => { if (owner.references === 0) retire(owner) })
    }
    release.ready = (async () => {
      if (destroyed || typeof computerId !== 'string' || !computerId.trim()) {
        loading.textContent = 'Choose a computer before opening a conversation.'
        return null
      }
      owner = acquire(computerId)
      const controller = await owner.ready
      if (disposed || destroyed || !controller) return null
      loading.remove()
      surface = await mount(controller, () => !disposed && !destroyed)
      if (disposed || destroyed) { surface?.dispose?.(); return null }
      return surface
    })().catch(() => {
      if (disposed || destroyed) return null
      surface?.dispose?.()
      surface = null
      host.replaceChildren(loading)
      loading.textContent = 'This conversation could not be opened. Choose another view and try again, or open it from Computers.'
      return null
    })
    return release
  }
  return {
    mount(host, subject, drafts, { onReady = null, onSubjectChange = null } = {}) {
      return mountSurface(host, subject.computerId, async (controller, active) => {
        // A Home conversation reads its kept draft only once Home knows whose
        // drafts they are (home-chat-composer-draft.js forConversation, T1497).
        await Promise.resolve(drafts?.ready).catch(() => null)
        if (!active()) return null
        return controller.mount(host, {
          nodeId: subject.agentId,
          draft: { read: () => drafts.readDraft(subject.id), write: value => drafts.writeDraft(subject.id, value) },
          onReady: surface => onReady?.(surface), onSubjectChange,
        })
      })
    },
    newChat(host, computerId, { onSubjectChange = null, onSubjectCreated = null, onCancel = null, onEscape = null, draft = null, onReady = null } = {}) {
      return mountSurface(host, computerId, async (controller, active) => {
        const surface = await controller.newChat(host, { onSubjectCreated: onSubjectChange || onSubjectCreated, onCancel, onEscape, draft, active })
        if (active()) onReady?.(surface)
        return surface
      })
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const owner of [...owners.values()]) retire(owner)
      owners.clear()
    },
  }
}

// Existing callers can share a drafts store without knowing about the pool.
// The full-view pane manager may instead own and destroy an explicit pool.
const sharedPools = new WeakMap()
export function mountHomeAgentWorkspace(host, subject, drafts, options = {}) {
  let pool = sharedPools.get(drafts)
  if (!pool) { pool = createHomeAgentWorkspacePool(options); sharedPools.set(drafts, pool) }
  if (subject.newChat) return pool.newChat(host, subject.computerId, options)
  return pool.mount(host, subject, drafts, options)
}
