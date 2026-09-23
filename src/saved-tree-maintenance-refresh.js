const readers = new Map()
const failure = () => ({ ok: false, code: 'MC_SAVED_TREE_REFRESH_REFUSED',
  reason: 'The saved repair completed, but an open tree changed before it could refresh. Its current session and unsaved work were preserved.' })
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

// Only live stores retain these callbacks. Closing a view cannot leave a strong
// reference to its entire forest in this registry.
export function registerSavedTreeMaintenance(key, refresh) {
  const entries = readers.get(key) || new Set()
  entries.add(new WeakRef(refresh))
  readers.set(key, entries)
}

export function refreshSavedTreeMaintenance(changes) {
  if (!Array.isArray(changes) || changes.length > 64) return failure()
  let refreshed = 0
  const refusals = []
  for (const change of changes) {
    const entries = readers.get(change?.key)
    if (!entries) continue
    for (const ref of entries) {
      const refresh = ref.deref()
      if (!refresh) { entries.delete(ref); continue }
      let answer
      try { answer = refresh(change) } catch { answer = failure() }
      if (answer?.ok !== true) refusals.push(answer?.code || 'MC_SAVED_TREE_REFRESH_REFUSED')
      else refreshed++
    }
    if (!entries.size) readers.delete(change.key)
  }
  return refusals.length ? { ...failure(), refreshed, refusals } : { ok: true, refreshed }
}

// Native snapshot repair changes only status and statusNote. Refresh accepts
// that exact saved difference while preserving every live node object field.
export function planSavedTreeMaintenance(before, after, currentNodes) {
  try {
    const old = JSON.parse(before), next = JSON.parse(after)
    if (old.version !== 1 || next.version !== 1 || !Array.isArray(old.nodes) || !Array.isArray(next.nodes)
      || old.nodes.length !== next.nodes.length) return null
    const withoutStatus = value => { const copy = { ...value }; delete copy.status; delete copy.statusNote; return copy }
    if (!same({ ...old, nodes: old.nodes.map(withoutStatus) }, { ...next, nodes: next.nodes.map(withoutStatus) })) return null
    const changes = []
    for (let i = 0; i < old.nodes.length; i++) {
      const previous = old.nodes[i], value = next.nodes[i]
      if (same(previous, value)) continue
      if (!['finished', 'turn-failed'].includes(previous.status) || !['finished', 'turn-failed'].includes(value.status)) return null
      const live = currentNodes.get(previous.id)
      if (!live || live.createdAt !== previous.createdAt || live.sessionId !== previous.sessionId
        || live.lastTurnId !== previous.lastTurnId || live.status !== previous.status
        || (live.statusNote || '') !== (previous.statusNote || '')) return null
      const replacement = { ...live, status: value.status }
      if (Object.hasOwn(value, 'statusNote')) replacement.statusNote = value.statusNote
      else delete replacement.statusNote
      changes.push([previous.id, Object.freeze(replacement)])
    }
    return changes
  } catch { return null }
}
