/* CAN A DRAGGED NODE ACTUALLY REACH THE SLOT IT IS BEING DRAGGED ONTO?
 *
 * Owner, 2026-08-18: "edit had been working; drag a node to a new node slot;
 * on the same tree, on a new tree, or on a different tree. On pg2 you cant
 * drag and drop the nodes onto the new bubbles anymore."
 *
 * NOBODY EVER MEASURED THIS. tools/test/tree-drag-contract.test.mjs pins the
 * drag RULES at source level, and tools/page2-qa.cjs is the only driver that
 * drags -- it picks its pair by smallest on-screen distance, which in any real
 * tree is a SAME-ROW pair, the one case the corridor still allowed. Twelve
 * other harnesses touch `.tree-empty-node` and every one of them only presses
 * it. So the arithmetic below is the check this area never had, and it is
 * arithmetic on the real exported function rather than a reading of the source.
 *
 * WHY THESE NUMBERS. Radii and pitch are this product's own:
 *   node radius       ~35 (src/tree-layout.js TREE_ROLE_RADII)
 *   empty slot radius  34 (src/tree-graph.js EMPTY_SLOT_RADIUS)
 *   DROP_SLOP           8 (src/tree-graph.js)
 *   row pitch          (H - 104 - 116) / (rows - 1)  (layoutTree)
 * Contact is `hypot < candidate.r + record.r + DROP_SLOP`, about 77px between
 * centres. Half a pitch on a 620px two-row canvas is 200px. That gap is the
 * whole defect.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { dragBand } from '../../src/tree-layout.js'

const SLOP = 8
const NODE_R = 35
const SLOT_R = 34
const REACH = NODE_R + SLOT_R + SLOP

/* The rank corridor as _rankCorridor builds it: half the pitch to each
   neighbouring row, 40px where there is no neighbour, floored at r + 64. */
function corridorFor(rowYs, rowIndex, r) {
  const rowY = rowYs[rowIndex]
  const up = rowIndex > 0 ? (rowY - rowYs[rowIndex - 1]) / 2 : 40
  const down = rowIndex + 1 < rowYs.length ? (rowYs[rowIndex + 1] - rowY) / 2 : 40
  return [Math.max(r + 64, rowY - up), rowY + down]
}

function canTouch(band, target, record) {
  // Straight down or straight up the same column: contact needs the centre
  // within REACH, and the band decides how far the centre may go.
  const needed = target.y > record.y ? target.y - REACH : target.y + REACH
  return target.y > record.y ? band[1] >= needed : band[0] <= needed
}

test('the rank corridor alone cannot reach a slot one row away -- the defect, in numbers', () => {
  const H = 620
  const rowYs = [104, 504]                       // two rows, pitch 400
  const node = { x: 300, y: rowYs[0], r: NODE_R }
  const slot = { x: 300, y: rowYs[1], r: SLOT_R }
  const corridor = corridorFor(rowYs, 0, NODE_R)
  assert.equal(canTouch(corridor, slot, node), false, 'the corridor reached the slot; re-derive these numbers before trusting the fix')
})

test('the band widened by reach does get there -- same tree, child slot one row below', () => {
  const H = 620
  const rowYs = [104, 504]
  const node = { x: 300, y: rowYs[0], r: NODE_R }
  const slot = { x: 300, y: rowYs[1], r: SLOT_R }
  const band = dragBand({ corridor: corridorFor(rowYs, 0, NODE_R), record: node, candidates: [slot], slop: SLOP, height: H })
  assert.equal(canTouch(band, slot, node), true, 'a node still cannot be dragged onto the slot under another parent')
})

test('and upward -- the new-tree slot sits in row 0, above everything below it', () => {
  const H = 620
  const rowYs = [104, 504]
  const node = { x: 300, y: rowYs[1], r: NODE_R }
  const newTreeSlot = { x: 120, y: rowYs[0], r: SLOT_R }
  const band = dragBand({ corridor: corridorFor(rowYs, 1, NODE_R), record: node, candidates: [newTreeSlot], slop: SLOP, height: H })
  assert.equal(canTouch(band, newTreeSlot, node), true, 'a branch still cannot be dragged out to its own tree')
})

test('and across trees, where the depths differ', () => {
  const H = 720
  const rowYs = [104, 354, 604]                  // three rows, pitch 250
  const node = { x: 200, y: rowYs[2], r: NODE_R }        // deep in tree A
  const otherTreeRoot = { x: 560, y: rowYs[0], r: NODE_R } // tree B's top
  const band = dragBand({ corridor: corridorFor(rowYs, 2, NODE_R), record: node, candidates: [otherTreeRoot], slop: SLOP, height: H })
  assert.equal(canTouch(band, otherTreeRoot, node), true, 'a node still cannot be dragged onto a different tree')
})

test('a canvas with no targets on it is the corridor, unchanged', () => {
  const rowYs = [104, 504]
  const node = { x: 300, y: rowYs[0], r: NODE_R }
  const corridor = corridorFor(rowYs, 0, NODE_R)
  const band = dragBand({ corridor, record: node, candidates: [], slop: SLOP, height: 620 })
  assert.deepEqual(band, corridor, 'an empty canvas no longer leaves the nudge corridor exactly as it was')
})

test('the node itself never widens the band, and is never excluded from it', () => {
  const rowYs = [104, 504]
  const node = { x: 300, y: 260, r: NODE_R }     // already nudged off its row
  const corridor = [104, 200]                    // a band that would exclude it
  const band = dragBand({ corridor, record: node, candidates: [node], slop: SLOP, height: 620 })
  assert.ok(band[0] <= node.y && band[1] >= node.y, 'the band excludes where the node already is; it would jump on the first move')
})

test('the canvas is still the outer bound', () => {
  const H = 620
  const node = { x: 300, y: 300, r: NODE_R }
  const faraway = { x: 300, y: 5000, r: SLOT_R } // a target off the canvas
  const band = dragBand({ corridor: [200, 400], record: node, candidates: [faraway], slop: SLOP, height: H })
  assert.ok(band[1] <= H - NODE_R - 12, 'a node can now be dragged off the bottom of the canvas')
  assert.ok(band[0] >= NODE_R + 12, 'a node can now be dragged off the top of the canvas')
})
