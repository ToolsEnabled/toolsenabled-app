/* Join a task's saved tree/thread owner to the complete native forest.
 *
 * This is deliberately presentation-only.  The native reader is the source
 * of truth for the saved forest and its storage-presence bit; a missing or
 * incomplete answer is never treated as an empty forest. */

const SCOPES = new Set(['tree', 'thread'])
const STATUSES = new Set(['draft', 'starting', 'running', 'finished', 'failed', 'turn-failed', 'interrupted', 'cancelled'])
const KINDS = new Set(['R', 'T', 'A', 'P'])
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  && /^[a-z0-9][a-z0-9._:/-]*$/i.test(value)
const kindOf = record => {
  if (typeof record?.kind === 'string' && KINDS.has(record.kind)) return record.kind
  const letter = typeof record?.id === 'string' ? record.id.slice(0, 1).toUpperCase() : ''
  return KINDS.has(letter) ? letter : 'R'
}

function validForest(snapshot) {
  if (!plain(snapshot) || snapshot.version !== 1 || snapshot.source !== 'native-desktop-tree' || snapshot.storagePresent !== true
      || !identity(snapshot.computerId) || !Array.isArray(snapshot.trees) || !Array.isArray(snapshot.nodes)
      || !Array.isArray(snapshot.sessions) || snapshot.sessionsTruncated !== false) return false
  const treeIds = new Set()
  for (const tree of snapshot.trees) {
    if (!plain(tree) || !identity(tree.id) || treeIds.has(tree.id)) return false
    treeIds.add(tree.id)
  }
  const nodeIds = new Set()
  for (const node of snapshot.nodes) {
    if (!plain(node) || !identity(node.id) || nodeIds.has(node.id) || treeIds.has(node.id)
        || !identity(node.treeId) || !treeIds.has(node.treeId) || !STATUSES.has(node.status)
        || !Object.hasOwn(node, 'parentId') || !Object.hasOwn(node, 'sessionId')) return false
    if (node.parentId !== null && (!identity(node.parentId) || node.parentId === node.id)) return false
    if (node.sessionId !== null && !identity(node.sessionId)) return false
    if (node.status === 'draft' && node.sessionId !== null) return false
    if (node.status === 'running' && node.sessionId === null) return false
    nodeIds.add(node.id)
  }
  const nodesById = new Map(snapshot.nodes.map(node => [node.id, node]))
  const sessionIds = new Set()
  for (const session of snapshot.sessions) {
    if (!plain(session) || !identity(session.sessionId) || sessionIds.has(session.sessionId)) return false
    if (session.nodeId !== null && session.nodeId !== undefined
        && (!identity(session.nodeId) || !nodesById.has(session.nodeId))) return false
    sessionIds.add(session.sessionId)
  }
  for (const node of snapshot.nodes) {
    if (node.parentId !== null) {
      const parent = nodesById.get(node.parentId)
      if (!parent || parent.treeId !== node.treeId) return false
    }
    const seen = new Set([node.id])
    let current = node
    while (current.parentId !== null) {
      if (seen.has(current.parentId)) return false
      seen.add(current.parentId)
      current = nodesById.get(current.parentId)
      if (!current) return false
    }
  }
  return true
}

export function ownerAvailabilityOf(record, snapshot) {
  if (!plain(record) || kindOf(record) !== 'T' || !SCOPES.has(record.scope)
      || !identity(record.scopeKey)) return null
  if (!validForest(snapshot)) return 'unknown'
  return snapshot.nodes.some(node => node.id === record.scopeKey) ? 'available' : 'unavailable'
}
