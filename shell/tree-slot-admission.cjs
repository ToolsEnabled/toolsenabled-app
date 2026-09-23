'use strict'

// Synchronous capacity authority used before native tree commands are queued and
// before the canonical forest cell is replaced. Permissions are checked by the
// existing command authority; a slot reservation grants no session authority.
function createTreeSlotAdmission({ readBounds, readForest, parseRecord, policy, makeId } = {}) {
  if ([readBounds, readForest, parseRecord, makeId].some(fn => typeof fn !== 'function')
      || typeof policy?.planTreeSlot !== 'function') throw new TypeError('Tree slot admission requires saved settings and the canonical forest parser.')
  const reservations = new Map()
  const fail = (code, reason) => Object.assign(new Error(reason), { code })
  function boundsFor(tree) {
    const result = readBounds()
    if (result?.ok !== true) throw fail('TREE_SLOT_SETTINGS_UNAVAILABLE', result?.reason || policy.TREE_SLOT_UNAVAILABLE)
    return policy.effectiveTreeSlotBounds(tree, result.bounds)
  }
  function forestOf(text, computerId) {
    if (text == null) return { computerId, nodes: [], trees: [] }
    const forest = parseRecord(text, { computerId })
    if (forest?.computerId !== computerId || !Array.isArray(forest.nodes) || !Array.isArray(forest.trees)) {
      throw fail('TREE_SLOT_RECORD_INVALID', 'The saved tree record could not be verified. No slots were changed.')
    }
    return forest
  }
  function withReservations(forest, computerId) {
    const nodes = [...forest.nodes], ids = new Set(nodes.map(node => node.id))
    for (const row of reservations.values()) {
      if (row.computerId === computerId && !ids.has(row.nodeId)) {
        nodes.push({ id: row.nodeId, parentId: row.parentId, treeId: row.treeId })
        ids.add(row.nodeId)
      }
    }
    return nodes
  }
  function reserve({ computerId, parentSessionId, nodeId = makeId() }) {
    const forest = readForest(computerId)
    const parents = forest.nodes.filter(node => node.sessionId === parentSessionId)
    if (parents.length !== 1) throw fail('TREE_SLOT_PARENT_UNAVAILABLE', 'The requesting session does not have one current saved tree slot.')
    const parent = parents[0], tree = forest.trees.find(row => row.id === parent.treeId)
    const nodes = withReservations(forest, computerId)
    if (!nodeId || nodes.some(node => node.id === nodeId)) throw fail('TREE_SLOT_ID_CONFLICT', 'The requested slot identity is already present or reserved.')
    const plan = policy.planTreeSlot(nodes.filter(node => node.treeId === parent.treeId), parent.id, boundsFor(tree))
    if (!plan.allowed) throw fail('TREE_SLOT_LIMIT', plan.reason)
    const token = makeId()
    reservations.set(token, { computerId, treeId: parent.treeId, parentId: parent.id, nodeId })
    let released = false
    return Object.freeze({ nodeId, parentId: parent.id, treeId: parent.treeId,
      release() { if (!released) { released = true; reservations.delete(token) } } })
  }
  function validateWrite({ computerId, previous, value }) {
    try {
      const before = forestOf(previous, computerId), after = forestOf(value, computerId)
      for (const reservation of reservations.values()) {
        if (reservation.computerId !== computerId) continue
        const node = after.nodes.find(row => row.id === reservation.nodeId)
        if (node && (node.parentId !== reservation.parentId || node.treeId !== reservation.treeId)) {
          throw fail('TREE_SLOT_ID_CONFLICT', 'The reserved child slot belongs to a different parent. No slots were changed.')
        }
      }
      const prior = new Map(before.nodes.map(node => [node.id, node]))
      const priorTrees = new Map(before.trees.map(tree => [tree.id, tree]))
      const changed = after.nodes.filter(node => {
        const old = prior.get(node.id)
        return !old || old.parentId !== node.parentId || old.treeId !== node.treeId
          || priorTrees.get(old.treeId)?.kind !== after.trees.find(tree => tree.id === node.treeId)?.kind
      })
      // Lifecycle updates and removals retain old over-limit history. A broken
      // settings read must not prevent stopping or recording an existing slot.
      if (!changed.length) return { ok: true }
      const nodes = withReservations(after, computerId)
      const bounds = new Map()
      for (const node of changed) {
        if (!bounds.has(node.treeId)) bounds.set(node.treeId, boundsFor(after.trees.find(tree => tree.id === node.treeId)))
        const limit = bounds.get(node.treeId)
        const peers = nodes.filter(row => row.treeId === node.treeId)
        if (node.parentId !== null && policy.treeSlotCount(peers, node.parentId) > limit.maxChildren) {
          throw fail('TREE_SLOT_LIMIT', policy.treeSlotFullReason(policy.treeSlotCount(peers, node.parentId), limit.maxChildren))
        }
        // Include every retained descendant when a branch moves.
        for (const candidate of after.nodes.filter(row => row.treeId === node.treeId)) {
          let current = candidate
          const seen = new Set()
          while (current && !seen.has(current.id)) {
            if (current.id === node.id) {
              if (policy.treeNodeDepth(peers, candidate.id) > limit.maxDepth) {
                throw fail('TREE_SLOT_LIMIT', 'That change exceeds the saved delegation depth of ' + limit.maxDepth + ' below the root. Existing slots were preserved.')
              }
              break
            }
            seen.add(current.id)
            current = after.nodes.find(row => row.id === current.parentId)
          }
        }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, code: error.code || 'TREE_SLOT_ADMISSION_UNAVAILABLE', reason: error.message || policy.TREE_SLOT_UNAVAILABLE }
    }
  }
  return Object.freeze({ reserve, validateWrite })
}
module.exports = { createTreeSlotAdmission }
