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
/* The graph says so on the page whenever Boxes/Circles or edit mode changes.
   The Video section (1.0.49) listens, to say why no panel shows. */
export const TREE_VIEW_CHANGE_EVENT = 'mc-tree-view-change'
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

/* THE VIDEO UNDER A BOX (1.0.49). A 16:9 panel as wide as the box hangs 8px
   under it, so a rank that holds a video needs that much more room below it
   before the next rank starts. Only such ranks pay: a uniform lane would leave
   a blank band under every box when one leaf has video, and fold a deep tree
   far sooner. Mini 137, Small 162, Medium 180, Large 236. */
export const BOX_VIDEO_GAP = 8
export function boxVideoExtent(width) {
  return Object.freeze({ gap: BOX_VIDEO_GAP, height: Math.round(width * 9 / 16) })
}
/** The extra room a box with a video takes below itself: gap plus panel. */
export function boxVideoLane(box) {
  const extent = boxVideoExtent(box.width)
  return extent.gap + extent.height
}
function videoIdSet(videoIds) {
  if (!videoIds) return null
  const ids = new Set(videoIds)
  return ids.size ? ids : null
}
// The ranks (in rowOf's numbering) that hold a drawn box with a video.
function videoRanksOf(videoIds, rowOf, culled) {
  const ranks = new Set()
  if (!videoIds) return ranks
  for (const id of videoIds) {
    const rank = rowOf.get(id)
    if (Number.isInteger(rank) && !culled?.has(id)) ranks.add(rank)
  }
  return ranks
}
/* Rank centres, each one pitch below the last plus a video lane under every
   rank above it that holds a video. With no video this is exactly the old
   `first + rank * pitch`: nothing is added, not even a zero. */
function rankYs(first, count, pitch, lane, videoRanks) {
  let lanes = 0
  return Array.from({ length: count }, (_, rank) => {
    const y = lanes ? first + rank * pitch + lanes * lane : first + rank * pitch
    if (videoRanks.has(rank)) lanes++
    return y
  })
}

// Separate trees may use separate canvas rows. Each tree moves as a whole:
// its subtree placement and connectors keep the original layout's geometry.
function packBoxForest(result, box, W, H, videoIds = null) {
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
  /* Each rank that holds a video is one video lane taller, the last rank
     included: its panel still hangs below the forest. */
  const lane = videoIds ? boxVideoLane(box) : 0
  const videoRanks = videoRanksOf(videoIds, result.rowOf, result.culled)
  const withLanes = (height, count) => count ? height + count * lane : height
  let bestFit = fit(width, withLanes(box.height + (lastRank - firstRank) * pitch, videoRanks.size)), best = null
  // A view that already fits at natural size needs no packing change. Trying
  // wider rows first also keeps ties stable and avoids needless extra rows.
  if (bestFit >= 1) return result
  for (let columns = trees.length; columns >= 1; columns--) {
    const rows = [], packedVideoRanks = new Set()
    let packedWidth = 0, rankCount = 0
    for (let start = 0; start < trees.length; start += columns) {
      const rowTrees = trees.slice(start, start + columns)
      const rowWidth = rowTrees.reduce((sum, tree) => sum + tree.right - tree.left, 0) + (rowTrees.length - 1) * gap
      const ranks = Math.max(...rowTrees.map(tree => tree.lastRank - tree.firstRank + 1))
      rows.push({ trees: rowTrees, width: rowWidth, rank: rankCount })
      for (const tree of rowTrees) for (const rank of videoRanks) {
        if (rank >= tree.firstRank && rank <= tree.lastRank
          && tree.ids.some(id => videoIds.has(id) && result.rowOf.get(id) === rank && !result.culled?.has(id))) {
          packedVideoRanks.add(rankCount + rank - tree.firstRank)
        }
      }
      packedWidth = Math.max(packedWidth, rowWidth)
      rankCount += ranks
    }
    const score = fit(packedWidth, withLanes(box.height + (rankCount - 1) * pitch, packedVideoRanks.size))
    if (score > bestFit + 1e-9) { bestFit = score; best = { rows, rankCount, videoRanks: packedVideoRanks } }
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
  const rowYs = rankYs(result.rowYs[0], best.rankCount, pitch, lane, best.videoRanks)
  const rowOf = new Map([...result.rowOf].map(([id, rank]) => [id, rank + offsets.get(id).rank]))
  const slots = new Map([...result.slots].map(([id, point]) => [id, { x: point.x + offsets.get(id).dx, y: rowYs[rowOf.get(id)] }]))
  return { ...result, slots, rowYs, rowOf }
}

// Keep the original spacious subtree placement, reserving a box's full width
// wherever that algorithm measures a circle. Intrinsic height keeps the circle
// fitter from shrinking this footprint or reflowing branches on a window resize.
// The box already contains its labels, so its vertical pitch uses its actual
// height with a clear connector lane between ranks.
//
// videoIds: the agents whose box shows a video panel. Only the ranks that hold
// one get the extra lane; with none, the result is exactly the old layout.
export function layoutBoxTree({ nodes = [], edges = [], W = 800, H = 600, contextSize = 'medium', videoIds = null } = {}) {
  const box = treeBoxSize(contextSize)
  const footprint = Math.max(box.width, box.height)
  const layoutNodes = (Array.isArray(nodes) ? nodes : []).map(node => ({ ...node, r: footprint / 2 }))
  const options = { nodes: layoutNodes, edges, W, H: 320, spacious: true }
  let result = layoutTree(options)
  if (result.rowYs.length > 1) {
    const worldHeight = 320 + (result.rowYs.length - 1) * (footprint + TREE_LABEL_STACK + 7)
    result = layoutTree({ ...options, H: worldHeight })
  }
  const video = videoIdSet(videoIds)
  const rowYs = rankYs(result.rowYs[0], result.rowYs.length, box.height + box.rowGap,
    video ? boxVideoLane(box) : 0, videoRanksOf(video, result.rowOf, result.culled))
  const slots = new Map([...result.slots].map(([id, point]) => [id,
    { x: point.x, y: rowYs[result.rowOf.get(id)] ?? point.y }]))
  return packBoxForest({
    ...result, slots, rowYs, W, H,
    radii: new Map([...result.radii.keys()].map(id => [id, box.height / 2])),
  }, box, W, H, video)
}

// below: extra height under the box (its video panel), so a direct link meets
// the outline of the box and panel together rather than cutting across the video.
export function boxPort(from, to, scale = 1, contextSize = 'medium', below = 0) {
  const box = treeBoxSize(contextSize)
  if (below > 0) from = { x: from.x, y: from.y + below / 2 }
  const height = below > 0 ? box.height * scale + below : box.height * scale
  const dx = to.x - from.x, dy = to.y - from.y
  const factor = Math.min(dx ? box.width * scale / 2 / Math.abs(dx) : Infinity,
    dy ? height / 2 / Math.abs(dy) : Infinity)
  return Number.isFinite(factor) ? { x: from.x + dx * factor, y: from.y + dy * factor } : { x: from.x, y: from.y }
}
