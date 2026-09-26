// Shared by the renderer and the native admission host. No runtime or filesystem state.
export const DEFAULT_TREE_SLOT_BOUNDS = Object.freeze({ maxChildren: 4, maxDepth: 3 })
export const TREE_SLOT_SETTING_IDS = Object.freeze({ width: 'fleet.tree_width', depth: 'fleet.tree_depth' })
// Defensive UI/record bounds, not provider capacity promises. Depth counts edges from the root.
export const TREE_SLOT_SETTING_LIMITS = Object.freeze({ maxChildren: 64, maxDepth: 16 })
export const TREE_SLOT_CHANGE_WARNING = 'Changing these limits affects new slots and moves. Existing agents and conversations stay in place, including trees above a lowered limit. Every active, idle or stopped child occupies one slot. Reuse its context or restart that same slot. Wider or deeper trees can use more memory and provider time.'
export const TREE_SLOT_UNAVAILABLE = 'The saved tree width and depth could not be read. Open Settings and read the saved values before adding or moving an agent.'
export function normalizeTreeSlotBounds(value) {
  if (!value || !Number.isSafeInteger(value.maxChildren) || value.maxChildren < 1
      || value.maxChildren > TREE_SLOT_SETTING_LIMITS.maxChildren
      || !Number.isSafeInteger(value.maxDepth) || value.maxDepth < 0
      || value.maxDepth > TREE_SLOT_SETTING_LIMITS.maxDepth) {
    throw Object.assign(new Error(TREE_SLOT_UNAVAILABLE), { code: 'TREE_SLOT_SETTINGS_UNAVAILABLE' })
  }
  return Object.freeze({ maxChildren: value.maxChildren, maxDepth: value.maxDepth })
}
export function readCurrentTreeSlotBounds() {
  const settings = globalThis.window?.mcSettings
  if (!settings) return DEFAULT_TREE_SLOT_BOUNDS // Pure store/demo callers; native has the settings bridge.
  if (typeof settings.treeSlots !== 'function') throw new Error(TREE_SLOT_UNAVAILABLE)
  const result = settings.treeSlots()
  if (result?.ok !== true) throw new Error(result?.reason || TREE_SLOT_UNAVAILABLE)
  return normalizeTreeSlotBounds(result.bounds)
}
export function effectiveTreeSlotBounds(tree, value) {
  const bounds = normalizeTreeSlotBounds(value)
  // A research experiment is a separate grid operation with its existing cell bound.
  return tree?.kind === 'experiment' ? Object.freeze({ maxChildren: 8, maxDepth: 3 }) : bounds
}
export function treeSlotCount(nodes, parentId) {
  return nodes.filter(node => node.parentId === parentId).length
}
export function treeSlotFullReason(count, limit) {
  return 'This agent has ' + count + ' of ' + limit + ' direct child slots. Reuse or restart an existing child, or delegate through one of its children within the saved depth limit.'
}
export function treeNodeDepth(nodes, nodeId) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  let node = byId.get(nodeId), depth = 0
  const seen = new Set()
  while (node?.parentId != null) {
    if (seen.has(node.id) || !byId.has(node.parentId)) throw new Error('The saved parent chain is invalid.')
    seen.add(node.id); node = byId.get(node.parentId); depth++
  }
  return depth
}
export function planTreeSlot(nodes, parentId, bounds) {
  try {
    bounds = normalizeTreeSlotBounds(bounds)
    if (parentId == null) return { allowed: true, reason: 'You can start a tree here.' }
    if (!nodes.some(node => node.id === parentId)) return { allowed: false, reason: 'That parent is not in this tree.' }
    const count = treeSlotCount(nodes, parentId)
    if (count >= bounds.maxChildren) return { allowed: false, reason: treeSlotFullReason(count, bounds.maxChildren) }
    if (treeNodeDepth(nodes, parentId) + 1 > bounds.maxDepth) {
      return { allowed: false, reason: 'The saved delegation depth is ' + bounds.maxDepth + ' below the root. Reuse an existing slot or choose a parent higher in the tree.' }
    }
    return { allowed: true, reason: 'You can add a child slot here.' }
  } catch (error) { return { allowed: false, reason: error.message || TREE_SLOT_UNAVAILABLE } }
}
