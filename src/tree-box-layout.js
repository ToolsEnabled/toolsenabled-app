import { layoutTree, TREE_LABEL_STACK } from './tree-layout.js'

// Keep the established spacing proportions as cards become more compact.
// Independent trees retain their existing horizontal separation.
const SEPARATE_TREE_GAP = 96
const GAP_PER_BOX_WIDTH = 36 / 320
const ROW_GAP_PER_BOX_HEIGHT = 96 / 224
const contextSize = (label, boxWidth, boxHeight, cardWidth, cardHeight) => Object.freeze({
  label,
  box: Object.freeze({
    width: boxWidth,
    height: boxHeight,
    gap: Math.round(boxWidth * GAP_PER_BOX_WIDTH),
    rowGap: Math.round(boxHeight * ROW_GAP_PER_BOX_HEIGHT),
  }),
  card: Object.freeze({ width: cardWidth, height: cardHeight }),
})

// One size register drives both card shapes and saved preferences.
export const TREE_CONTEXT_SIZES = Object.freeze({
  mini: contextSize('Mini', 244, 120, 224, 88),
  small: contextSize('Small', 288, 160, 260, 128),
  medium: contextSize('Medium', 320, 196, 280, 160),
  large: contextSize('Large', 420, 252, 380, 220),
})

/** Read a supported size without rewriting the owner's saved preference. */
export function liveContextSize(size) {
  return typeof size === 'string' && Object.hasOwn(TREE_CONTEXT_SIZES, size) ? size : null
}
export const TREE_BOX = TREE_CONTEXT_SIZES.medium.box
export const TREE_STYLE_KEY = 'mc.set.tree_style'
export const TREE_CARDS_KEY = 'mc.set.tree_cards'
export const TREE_CONTEXT_SIZE_KEY = 'mc.set.tree_context_size'

const validContextSize = size => liveContextSize(size) || 'medium'

export function treeBoxSize(size = 'medium') {
  return TREE_CONTEXT_SIZES[validContextSize(size)].box
}

export function treeCardSize(size = 'medium') {
  return TREE_CONTEXT_SIZES[validContextSize(size)].card
}

export function readTreeContextSize(storage = globalThis.localStorage) {
  try { return validContextSize(storage?.getItem(TREE_CONTEXT_SIZE_KEY)) }
  catch { return 'medium' }
}

export function readTreeCards(storage = globalThis.localStorage) {
  try { return storage?.getItem(TREE_CARDS_KEY) !== 'false' }
  catch { return true }
}

export function readTreeStyle(storage = globalThis.localStorage) {
  try { return storage?.getItem(TREE_STYLE_KEY) === 'circles' ? 'circles' : 'boxes' }
  catch { return 'boxes' }
}

// Separate trees may use separate canvas rows. Each tree moves as a whole:
// its subtree placement and connectors keep the original layout's geometry.
function packBoxForest(result, box, W, H) {
  if (result.slots.size < 2) return result
  const heads = new Map([...result.slots.keys()].map(id => [id, id]))
  const find = id => {
    let head = id
    while (heads.get(head) !== head) head = heads.get(head)
    while (heads.get(id) !== id) { const parent = heads.get(id); heads.set(id, head); id = parent }
    return head
  }
  for (const [child, parent] of result.parents) {
    if (heads.has(child) && heads.has(parent)) heads.set(find(child), find(parent))
  }
  const groups = new Map()
  for (const [id, point] of result.slots) {
    const head = find(id)
    if (!groups.has(head)) groups.set(head, { head, ids: [], left: Infinity, right: -Infinity, firstRank: Infinity, lastRank: -Infinity })
    const tree = groups.get(head), rank = result.rowOf.get(id)
    tree.ids.push(id)
    tree.left = Math.min(tree.left, point.x - box.width / 2)
    tree.right = Math.max(tree.right, point.x + box.width / 2)
    tree.firstRank = Math.min(tree.firstRank, rank)
    tree.lastRank = Math.max(tree.lastRank, rank)
  }
  if (groups.size < 2) return result
  const trees = [...groups.values()].sort((a, b) => a.left - b.left || a.head.localeCompare(b.head))
  /* SEPARATE TREES GET A HORIZONTAL BERTH, AND IT IS A HORIZONTAL NUMBER.
     This was `Math.max(box.gap, box.rowGap)`, which read a VERTICAL row
     spacing as a horizontal distance. That was harmless only while gap and
     rowGap were the same literals on every size: max(36, 96) was 96 for all
     four, so this line has always meant "96px between separate trees". Once
     rowGap started scaling with box HEIGHT (R1206), the same expression made
     a taller card push its neighbours sideways -- at Large it widened a
     packed row to 977px in an 875px split and dropped four heads below the
     0.9 readability floor tools/test/tree-box-layout.test.mjs guards.
     SEPARATE_TREE_GAP states the number that already shipped, so horizontal
     geometry is unchanged at every size while rowGap is free to scale. */
  const pitch = box.height + box.rowGap, gap = Math.max(box.gap, SEPARATE_TREE_GAP)
  const availableW = Math.max(1, W - 20), availableH = Math.max(1, H - 20)
  const fit = (width, height) => Math.min(1, availableW / width, availableH / height)
  const width = Math.max(...trees.map(tree => tree.right)) - Math.min(...trees.map(tree => tree.left))
  const firstRank = Math.min(...trees.map(tree => tree.firstRank)), lastRank = Math.max(...trees.map(tree => tree.lastRank))
  let bestFit = fit(width, box.height + (lastRank - firstRank) * pitch), best = null
  // A view that already fits at natural size needs no packing change. Trying
  // wider rows first also keeps ties stable and avoids needless extra rows.
  if (bestFit >= 1) return result
  for (let columns = trees.length; columns >= 1; columns--) {
    const rows = []
    let packedWidth = 0, rankCount = 0
    for (let start = 0; start < trees.length; start += columns) {
      const rowTrees = trees.slice(start, start + columns)
      const rowWidth = rowTrees.reduce((sum, tree) => sum + tree.right - tree.left, 0) + (rowTrees.length - 1) * gap
      const ranks = Math.max(...rowTrees.map(tree => tree.lastRank - tree.firstRank + 1))
      rows.push({ trees: rowTrees, width: rowWidth, rank: rankCount })
      packedWidth = Math.max(packedWidth, rowWidth)
      rankCount += ranks
    }
    const score = fit(packedWidth, box.height + (rankCount - 1) * pitch)
    if (score > bestFit + 1e-9) { bestFit = score; best = { rows, rankCount } }
  }
  if (!best) return result
  const offsets = new Map()
  for (const row of best.rows) {
    let left = (W - row.width) / 2
    for (const tree of row.trees) {
      for (const id of tree.ids) offsets.set(id, { dx: left - tree.left, rank: row.rank - tree.firstRank })
      left += tree.right - tree.left + gap
    }
  }
  const rowYs = Array.from({ length: best.rankCount }, (_, rank) => result.rowYs[0] + rank * pitch)
  const rowOf = new Map([...result.rowOf].map(([id, rank]) => [id, rank + offsets.get(id).rank]))
  const slots = new Map([...result.slots].map(([id, point]) => [id, { x: point.x + offsets.get(id).dx, y: rowYs[rowOf.get(id)] }]))
  return { ...result, slots, rowYs, rowOf }
}

// Keep the original spacious subtree placement, reserving a box's full width
// wherever that algorithm measures a circle. Intrinsic height keeps the circle
// fitter from shrinking this footprint or reflowing branches on a window resize.
// The box already contains its labels, so its vertical pitch uses its actual
// height with a clear connector lane between ranks.
export function layoutBoxTree({ nodes = [], edges = [], W = 800, H = 600, contextSize = 'medium' } = {}) {
  const box = treeBoxSize(contextSize)
  const footprint = Math.max(box.width, box.height)
  const layoutNodes = (Array.isArray(nodes) ? nodes : []).map(node => ({ ...node, r: footprint / 2 }))
  const options = { nodes: layoutNodes, edges, W, H: 320, spacious: true }
  let result = layoutTree(options)
  if (result.rowYs.length > 1) {
    const worldHeight = 320 + (result.rowYs.length - 1) * (footprint + TREE_LABEL_STACK + 7)
    result = layoutTree({ ...options, H: worldHeight })
  }
  const rowYs = result.rowYs.map((y, index) => result.rowYs[0] + index * (box.height + box.rowGap))
  const slots = new Map([...result.slots].map(([id, point]) => [id,
    { x: point.x, y: rowYs[result.rowOf.get(id)] ?? point.y }]))
  return packBoxForest({
    ...result, slots, rowYs, W, H,
    radii: new Map([...result.radii.keys()].map(id => [id, box.height / 2])),
  }, box, W, H)
}

export function boxPort(from, to, scale = 1, contextSize = 'medium') {
  const box = treeBoxSize(contextSize)
  const dx = to.x - from.x, dy = to.y - from.y
  const factor = Math.min(dx ? box.width * scale / 2 / Math.abs(dx) : Infinity,
    dy ? box.height * scale / 2 / Math.abs(dy) : Infinity)
  return Number.isFinite(factor) ? { x: from.x + dx * factor, y: from.y + dy * factor } : { x: from.x, y: from.y }
}
