'use strict'

// The paired browser reads the native computer's saved forest. This is a
// transport boundary, not a second store: no writes, restart reconciliation,
// session creation, or selection of a caller-provided preference key occurs.
// Keep this module inside shell/**: src/** is not in the installed package.
const COMPUTER_ID = 'this-computer'
const STORAGE_KEY = `mc.fleet.trees.v1:${COMPUTER_ID}`
const LIMITS = Object.freeze({ maxTrees: 64, maxNodes: 4096, maxNameChars: 80, maxRoleChars: 60,
  maxMessageChars: 12000, maxNoteChars: 240, maxReplyChars: 4000, maxChainSteps: 64 })
const STATUSES = new Set(['draft', 'starting', 'running', 'finished', 'failed', 'turn-failed', 'interrupted', 'cancelled'])
const fail = code => { throw Object.assign(new Error(code), { code }) }
const invalid = () => fail('MC_AGENT_DESKTOP_TREE_INVALID')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[a-z0-9][a-z0-9._:/-]*$/i.test(value)
const stamp = value => typeof value === 'string' && value.length > 0 && value.length <= 64
const line = (value, max, empty = false) => typeof value === 'string' && (empty || value.trim().length > 0)
  && value.trim().length <= max && !/[\u0000-\u001f\u007f]/.test(value.trim())
const brief = (value, max) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed) ? trimmed : null
}
const frozenList = values => Object.freeze(values.map(Object.freeze))

function readDesktopTreeSnapshot(preferences) {
  if (!object(preferences) || preferences.ok !== true || !object(preferences.values)) fail('MC_AGENT_DESKTOP_TREE_UNAVAILABLE')
  if (preferences.damaged === true) fail('MC_AGENT_DESKTOP_TREE_DAMAGED')
  if (!Object.hasOwn(preferences.values, STORAGE_KEY)) {
    return Object.freeze({ version: 1, computerId: COMPUTER_ID, trees: Object.freeze([]), nodes: Object.freeze([]) })
  }
  const text = preferences.values[STORAGE_KEY]
  // These are the native prefs cell/record envelopes, not a smaller response
  // budget. The facade pages the full result and never clips its hierarchy.
  if (typeof text !== 'string' || text.length > 32 * 1024 * 1024 || Buffer.byteLength(text, 'utf8') > 64 * 1024 * 1024) invalid()
  let raw
  try { raw = JSON.parse(text) } catch { invalid() }
  if (!object(raw) || raw.version !== 1 || raw.computerId !== COMPUTER_ID || !Array.isArray(raw.trees)
      || !Array.isArray(raw.nodes) || raw.trees.length > LIMITS.maxTrees || raw.nodes.length > LIMITS.maxNodes) invalid()

  // Structural invariants match the persisted fleet tree reader. Unlike that
  // restart reader, this export keeps saved live statuses and open clocks.
  const ids = new Set(), treeIds = new Set(), trees = []
  for (const entry of raw.trees) {
    if (!object(entry) || !identifier(entry.id) || ids.has(entry.id)
        || (entry.name != null && !line(entry.name, LIMITS.maxNameChars)) || !stamp(entry.createdAt) || !stamp(entry.updatedAt)) invalid()
    ids.add(entry.id); treeIds.add(entry.id)
    trees.push({ id: entry.id, name: entry.name == null ? null : entry.name.trim(), createdAt: entry.createdAt, updatedAt: entry.updatedAt,
      ...(entry.kind === 'experiment' ? { kind: 'experiment' } : {}) })
  }
  const nodes = [], byId = new Map(), roots = new Set(), sessions = new Set(), ordinals = new Map()
  for (const entry of raw.nodes) {
    if (!object(entry) || !identifier(entry.id) || ids.has(entry.id) || !treeIds.has(entry.treeId)
        || !STATUSES.has(entry.status) || !stamp(entry.createdAt) || !stamp(entry.updatedAt)) invalid()
    const role = entry.role ?? '', message = brief(entry.message ?? '', LIMITS.maxMessageChars), statusNote = brief(entry.statusNote ?? '', LIMITS.maxNoteChars)
    if (!line(role, LIMITS.maxRoleChars, true) || message === null || statusNote === null) invalid()
    const sessionId = entry.sessionId ?? null, parentId = entry.parentId ?? null
    if ((sessionId !== null && (!identifier(sessionId) || sessions.has(sessionId)))
        || (entry.status === 'draft' && sessionId !== null) || (entry.status === 'running' && sessionId === null)
        || (parentId !== null && !identifier(parentId))) invalid()
    if (parentId === null) { if (roots.has(entry.treeId)) invalid(); roots.add(entry.treeId) }
    const nameOrdinal = entry.nameOrdinal ?? null
    if (nameOrdinal !== null && (!Number.isInteger(nameOrdinal) || nameOrdinal < 1 || nameOrdinal > LIMITS.maxNodes * 2)) invalid()
    // Match the existing desktop's forgiving display normalization. Old
    // display fields must not make an otherwise sound native forest disappear.
    const reply = typeof entry.reply === 'string' ? entry.reply.slice(0, LIMITS.maxReplyChars) : ''
    const tier = typeof entry.tier === 'string' ? entry.tier.slice(0, 64) : ''
    const effort = typeof entry.effort === 'string' ? entry.effort.slice(0, 64) : ''
    const runStartedAt = stamp(entry.runStartedAt) && Number.isFinite(Date.parse(entry.runStartedAt)) ? entry.runStartedAt : null
    const measured = Number.isFinite(entry.runMs) && entry.runMs >= 0 ? Math.floor(entry.runMs) : null
    // A valid open interval retains its start instead of being folded closed
    // as on restart. Its unknown base is zero, as in loadedRunClock; null here
    // would incorrectly select the legacy createdAt clock in the renderer.
    const runMs = measured ?? (runStartedAt === null ? null : 0)
    const node = {
      id: entry.id, treeId: entry.treeId, parentId, role: role.trim(), nameOrdinal,
      ...(line(entry.nameBase, LIMITS.maxNameChars) ? { nameBase: entry.nameBase.trim() } : {}),
      message, status: entry.status, statusNote, reply, tier, effort, runMs, runStartedAt, sessionId,
      ...(typeof entry.lastTurnId === 'string' && entry.lastTurnId.length > 0 && entry.lastTurnId.length <= 512
        && !/[\u0000-\u001f\u007f]/.test(entry.lastTurnId) ? { lastTurnId: entry.lastTurnId } : {}),
      createdByAgent: entry.createdByAgent === true, promptedByPerson: entry.promptedByPerson === true,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt,
    }
    ids.add(node.id); if (sessionId !== null) sessions.add(sessionId)
    nodes.push(node); byId.set(node.id, node)
    const group = `${node.treeId}\u0000${node.role}`
    if (!ordinals.has(group)) ordinals.set(group, new Set())
    if (nameOrdinal !== null) {
      if (ordinals.get(group).has(nameOrdinal)) invalid()
      ordinals.get(group).add(nameOrdinal)
    }
  }
  for (const node of nodes) {
    // Preserve the desktop's deterministic naming of pre-ordinal records.
    if (node.nameOrdinal === null) {
      const used = ordinals.get(`${node.treeId}\u0000${node.role}`)
      let ordinal = 1
      while (used.has(ordinal)) ordinal++
      node.nameOrdinal = ordinal; used.add(ordinal)
    }
    const seen = new Set([node.id])
    let current = node, sound = false
    for (let step = 0; step < LIMITS.maxChainSteps; step++) {
      if (current.parentId === null) { sound = true; break }
      const parent = byId.get(current.parentId)
      if (!parent || parent.treeId !== node.treeId || seen.has(parent.id)) invalid()
      seen.add(parent.id); current = parent
    }
    if (!sound) invalid()
  }
  return Object.freeze({ version: 1, computerId: COMPUTER_ID, trees: frozenList(trees), nodes: frozenList(nodes) })
}

module.exports = { readDesktopTreeSnapshot, LIMITS }
