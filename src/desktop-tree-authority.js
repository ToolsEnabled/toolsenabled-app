/* Read-only adapter for the computer's native saved tree workspace.
 *
 * This module deliberately does not use the browser tree store.  The native
 * endpoint is the authority for tree ids, node ids, empty trees and parent
 * links; desktop session activity is a separate, lossy view joined by session
 * id.  A missing or invalid snapshot is a refusal, never an empty fallback.
 */

export const DESKTOP_TREE_LIMITS = Object.freeze({
  chunkBytes: 64 * 1024,
  maxBytes: 65 * 1024 * 1024,
  maxPages: 1040,
  maxTrees: 64,
  maxNodes: 4096,
})

const RESEARCH_PROJECT_ID = /^rp-[0-9a-f]{4,36}$/
const isResearchProjectId = value => typeof value === 'string' && RESEARCH_PROJECT_ID.test(value)
const STATUSES = new Set(['draft', 'starting', 'running', 'finished', 'failed', 'turn-failed', 'interrupted', 'cancelled'])
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  && /^[a-z0-9][a-z0-9._:/-]*$/i.test(value)
const text = (value, max, empty = false) => typeof value === 'string'
  && (empty || value.trim().length > 0) && value.trim().length <= max
  && !/[\u0000-\u001f\u007f]/.test(value.trim())
/* Prompts and replies are ordinary user-authored text.  Native tree records
 * preserve their line breaks and tabs; reject only non-printing controls that
 * can alter a DOM/control boundary. */
const messageText = (value, max, empty = false) => typeof value === 'string'
  && (empty || value.trim().length > 0) && value.trim().length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.trim())
const refusal = code => Object.assign(new Error(code), { code })
const fail = code => { throw refusal(code) }

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze))
  if (!isRecord(value)) return value
  for (const [key, item] of Object.entries(value)) value[key] = freeze(item)
  return Object.freeze(value)
}

/** Validate and freeze one complete native response. */
export function readDesktopTreeAnswer(answer) {
  if (!isRecord(answer)) fail('MC_AGENT_DESKTOP_TREE_UNAVAILABLE')
  if (answer.ok !== true) fail(answer.code || answer.error?.code || 'MC_AGENT_DESKTOP_TREE_UNAVAILABLE')
  const tree = answer.desktopTree
  if (!isRecord(tree) || tree.version !== 1 || !id(tree.computerId)
      || !Array.isArray(tree.trees) || !Array.isArray(tree.nodes)
      || tree.trees.length > DESKTOP_TREE_LIMITS.maxTrees || tree.nodes.length > DESKTOP_TREE_LIMITS.maxNodes) {
    fail('MC_AGENT_DESKTOP_TREE_INVALID')
  }
  const treeIds = new Set()
  const trees = []
  for (const raw of tree.trees) {
    if (!isRecord(raw) || !id(raw.id) || treeIds.has(raw.id)
        || (raw.name != null && !text(raw.name, 80))
        || (raw.kind != null && !text(raw.kind, 60))
        || (raw.researchProjectId != null && !isResearchProjectId(raw.researchProjectId))
        || (raw.researchProjectName != null && !text(raw.researchProjectName, 120, true))
        || (raw.createdAt != null && !text(raw.createdAt, 64))
        || (raw.updatedAt != null && !text(raw.updatedAt, 64))) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    treeIds.add(raw.id)
    trees.push({ ...raw, name: raw.name == null ? null : raw.name.trim(), kind: raw.kind == null ? null : raw.kind.trim() })
  }
  const nodeIds = new Set(treeIds)
  const sessionIds = new Set()
  const nodes = []
  for (const raw of tree.nodes) {
    if (!isRecord(raw) || !id(raw.id) || nodeIds.has(raw.id) || !treeIds.has(raw.treeId)
        || !STATUSES.has(raw.status)) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    const parentId = raw.parentId == null ? null : raw.parentId
    if (parentId !== null && !id(parentId)) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    const sessionId = raw.sessionId == null ? null : raw.sessionId
    if (sessionId !== null && (!id(sessionId) || sessionIds.has(sessionId))) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    if (raw.status === 'draft' && sessionId !== null) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    if (raw.status === 'running' && sessionId === null) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    for (const key of ['role', 'message', 'statusNote']) {
      const limit = key === 'message' ? 12000 : key === 'statusNote' ? 240 : 60
      const validator = key === 'message' ? messageText : text
      if (raw[key] != null && !validator(raw[key], limit, true)) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    }
    if (raw.createdAt != null && !text(raw.createdAt, 64)) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    if (raw.updatedAt != null && !text(raw.updatedAt, 64)) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    nodeIds.add(raw.id)
    if (sessionId) sessionIds.add(sessionId)
    nodes.push({ ...raw, parentId, sessionId })
  }
  const byId = new Map(nodes.map(node => [node.id, node]))
  for (const node of nodes) {
    if (node.parentId != null) {
      const parent = byId.get(node.parentId)
      if (!parent || parent.treeId !== node.treeId || parent.id === node.id) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    }
    const seen = new Set([node.id])
    let current = node
    while (current.parentId != null) {
      if (seen.has(current.parentId)) fail('MC_AGENT_DESKTOP_TREE_INVALID')
      seen.add(current.parentId)
      current = byId.get(current.parentId)
      if (!current) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    }
  }
  const sessions = Array.isArray(answer.sessions) ? answer.sessions.map(raw => ({ ...raw })) : []
  const seenSessionRows = new Set()
  for (const row of sessions) {
    if (!isRecord(row) || !id(row.sessionId) || seenSessionRows.has(row.sessionId)) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    if (row.nodeId != null && (!id(row.nodeId) || !byId.has(row.nodeId))) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    seenSessionRows.add(row.sessionId)
  }
  if (answer.sessions != null && !Array.isArray(answer.sessions)) fail('MC_AGENT_DESKTOP_TREE_INVALID')
  if (answer.sessionsTruncated != null && typeof answer.sessionsTruncated !== 'boolean') fail('MC_AGENT_DESKTOP_TREE_INVALID')
  return freeze({
    version: 1,
    computerId: tree.computerId,
    trees,
    nodes,
    sessions,
    sessionsTruncated: answer.sessionsTruncated === true,
    source: 'native-desktop-tree',
  })
}

const base64 = value => typeof value === 'string'
  && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) fail('MC_AGENT_DESKTOP_TREE_INVALID')
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Read an ordinary response, or assemble the native lossless paged snapshot. */
export async function readDesktopTreeSnapshot(bridge) {
  if (!bridge || typeof bridge.read !== 'function') fail('MC_AGENT_DESKTOP_TREE_UNAVAILABLE')
  let answer
  try { answer = await bridge.read() } catch (error) {
    if (error?.code !== 'AGENT_FACADE_RESPONSE_TOO_LARGE') throw error?.code ? error : refusal('MC_AGENT_DESKTOP_TREE_UNAVAILABLE')
    try { answer = await bridge.read({ page: 0 }) } catch (pageError) { throw pageError?.code ? pageError : refusal('MC_AGENT_DESKTOP_TREE_UNAVAILABLE') }
  }
  if (answer?.ok === false) fail(answer.code || answer.error?.code || 'MC_AGENT_DESKTOP_TREE_UNAVAILABLE')
  if (answer?.desktopTree) return readDesktopTreeAnswer(answer)
  const first = answer?.desktopTreeSnapshot
  if (!isRecord(first)) fail('MC_AGENT_DESKTOP_TREE_INVALID')
  const { chunkBytes, maxBytes, maxPages } = DESKTOP_TREE_LIMITS
  let meta = null
  const chunks = []
  for (let page = 0; page < maxPages; page += 1) {
    const part = page === 0 ? first : await bridge.read({ page, snapshot: meta.sha256 })
    const snapshot = page === 0 ? part : part?.desktopTreeSnapshot
    if (!isRecord(snapshot) || snapshot.version !== 1 || snapshot.page !== page
        || !/^[a-f0-9]{64}$/.test(snapshot.sha256)
        || !Number.isSafeInteger(snapshot.bytes) || snapshot.bytes < 1 || snapshot.bytes > maxBytes
        || !Number.isSafeInteger(snapshot.pages) || snapshot.pages < 1 || snapshot.pages > maxPages
        || snapshot.pages !== Math.ceil(snapshot.bytes / chunkBytes) || !base64(snapshot.data)) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    if (!meta) meta = { sha256: snapshot.sha256, bytes: snapshot.bytes, pages: snapshot.pages }
    if (snapshot.sha256 !== meta.sha256 || snapshot.bytes !== meta.bytes || snapshot.pages !== meta.pages) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    let binary
    try { binary = atob(snapshot.data) } catch { fail('MC_AGENT_DESKTOP_TREE_INVALID') }
    const expected = Math.min(chunkBytes, meta.bytes - page * chunkBytes)
    if (binary.length !== expected || btoa(binary) !== snapshot.data) fail('MC_AGENT_DESKTOP_TREE_INVALID')
    chunks.push(Uint8Array.from(binary, char => char.charCodeAt(0)))
    if (page + 1 === meta.pages) break
  }
  if (!meta || chunks.length !== meta.pages) fail('MC_AGENT_DESKTOP_TREE_INVALID')
  const bytes = new Uint8Array(meta.bytes)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  if (await sha256(bytes) !== meta.sha256) fail('MC_AGENT_DESKTOP_TREE_INVALID')
  let parsed
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail('MC_AGENT_DESKTOP_TREE_INVALID') }
  return readDesktopTreeAnswer(parsed)
}

/** Convert an authoritative snapshot to the graph's read-only presentation shape. */
export function desktopTreeComputer(snapshot, label = 'The computer you are driving') {
  if (!snapshot || snapshot.source !== 'native-desktop-tree') fail('MC_AGENT_DESKTOP_TREE_UNAVAILABLE')
  const activity = new Map(snapshot.sessions.map(row => [row.sessionId, row]))
  const treesById = new Map(snapshot.trees.map(tree => [tree.id, tree]))
  const nodes = snapshot.nodes.map(node => {
    const tree = treesById.get(node.treeId)
    const session = node.sessionId ? activity.get(node.sessionId) : null
    const display = typeof node.name === 'string' && node.name.trim() ? node.name.trim()
      : `${node.role || 'Agent'}${node.nameOrdinal ? ` ${node.nameOrdinal}` : ''}`
    return {
      id: node.id,
      name: display,
      role: node.role || 'default',
      declaredRole: node.role || 'default',
      parentId: node.parentId,
      treeId: node.treeId,
      sessionId: node.sessionId,
      state: session?.busy === true ? 'enabled' : node.status === 'failed' || node.status === 'turn-failed' ? 'failed' : node.status,
      busy: typeof session?.busy === 'boolean' ? session.busy : null,
      sourceKind: 'observed',
      treeNode: node,
      ...(isResearchProjectId(tree?.researchProjectId) ? {
        researchProjectId: tree.researchProjectId,
        researchProjectName: text(tree.researchProjectName, 120, true) ? tree.researchProjectName.trim() : '',
      } : {}),
    }
  })
  const ids = new Set(nodes.map(node => node.id))
  const edges = nodes.filter(node => node.parentId && ids.has(node.parentId))
    .map(node => ({ from: node.parentId, to: node.id, type: 'manages', sourceKind: 'observed' }))
  return Object.freeze({
    id: snapshot.computerId,
    name: label,
    ip: `${snapshot.trees.length} saved trees`,
    note: 'native-desktop-tree',
    sourceKind: 'observed',
    authoritative: true,
    spawnedTotal: nodes.length,
    agents: Object.freeze(nodes),
    trees: Object.freeze(snapshot.trees.map(tree => Object.freeze({
      ...tree,
      rootId: nodes.find(node => node.treeId === tree.id && node.parentId == null)?.id || null,
      count: nodes.filter(node => node.treeId === tree.id).length,
    }))),
    services: Object.freeze([]),
    graphEdges: Object.freeze(edges),
    graphRevision: snapshot.revision ?? null,
  })
}

/* A narrow store facade for the existing canvas.  It exposes the read methods
 * the presentation uses, while every mutator refuses; the browser never
 * becomes a second authority and a tree selection cannot write through this
 * snapshot. */
export function createDesktopTreeViewStore(snapshot) {
  if (!snapshot || snapshot.source !== 'native-desktop-tree') fail('MC_AGENT_DESKTOP_TREE_UNAVAILABLE')
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]))
  const trees = new Map(snapshot.trees.map(tree => [tree.id, tree]))
  const freezeArray = values => Object.freeze(values.slice())
  const rejectWrite = () => ({ ok: false, code: 'MC_AGENT_DESKTOP_TREE_READ_ONLY', reason: 'The computer’s saved trees are read-only in this view.' })
  const view = {
    snapshot: () => Object.freeze({ trees: freezeArray([...trees.values()]), nodes: freezeArray([...nodes.values()]), source: snapshot.source, computerId: snapshot.computerId }),
    getNode: nodeId => nodes.get(nodeId) || null,
    getTree: treeId => trees.get(treeId) || null,
    listNodes: treeId => freezeArray([...nodes.values()].filter(node => treeId == null || node.treeId === treeId)),
    listTrees: () => freezeArray([...trees.values()]),
    rootOf: treeId => [...nodes.values()].find(node => node.treeId === treeId && node.parentId == null) || null,
    treeLabel: treeId => trees.get(treeId)?.name || treeId,
    childrenOf: nodeId => freezeArray([...nodes.values()].filter(node => node.parentId === nodeId)),
    extensionPoints: () => freezeArray([]),
    subscribe: () => () => {},
    refreshNodeNames: () => ({ changed: 0 }),
    treeProfile: () => null,
    // Explicitly refuse all writes, including session attachment and status.
    attachSession: rejectWrite,
    detachSession: rejectWrite,
    detachToNewTree: rejectWrite,
    moveNode: rejectWrite,
    movePoints: rejectWrite,
    removeNode: rejectWrite,
    setNodeLaunchPreferences: rejectWrite,
    setNodeReply: rejectWrite,
    setNodeStatus: rejectWrite,
    setTreeProfile: rejectWrite,
    setTreeResearchProject: rejectWrite,
  }
  return Object.freeze(view)
}

export function desktopTreeBridge(win = globalThis.window) {
  const bridge = win?.mcDesktopTree
  if (bridge && typeof bridge.read === 'function') return bridge
  const sessions = win?.mcDesktopSessions
  if (sessions && typeof sessions.tree === 'function') return { read: request => sessions.tree(request) }
  return null
}
