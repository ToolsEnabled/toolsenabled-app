/* DOES THE AUTO-PAN ACTUALLY FETCH? T15, Controller 2026-09-15 22:14Z.
 *
 * The edge auto-pan exists to bring an off-screen drop target to the hand. Its
 * stop rule (_dropTargetInView, src/tree-graph.js) is right in intent — do not
 * pan PAST the last target and leave the hand holding a node with nothing to
 * drop on — but it is asked as "is any target in view after this step". That is
 * a weaker question than the intent, and the difference is a real drag:
 *
 * measured on the candidate at 2026-09-15T21:5xZ, holding 25px inside the 56px
 * band at the right edge for 3.6s moved panX not at all (pinned at -21) while
 * the intended target sat 205px past the pane's right edge. The only other
 * target was near the LEFT edge and left the view on the first frame, so the
 * guard reverted that frame and stopped — before the target it exists to fetch
 * could arrive. The gap between "the last near target left" and "the far target
 * arrived" is a window in which the feature switches itself off.
 *
 * This is NOT the pan clamp: tree-clamp-reachability.test.mjs is green on the
 * owner's real 46-node forest, so every node is reachable by hand pan. It is
 * this guard.
 *
 * The real _dragAutoPan and the real _dropTargetInView run here. _clampPan is
 * deliberately permissive so that nothing but the guard can stop the loop. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { StaticTreeGraph } from '../../src/tree-graph.js'

const frames = []
globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length }
globalThis.cancelAnimationFrame = id => { frames[id - 1] = null }
const runFrame = () => {
  const next = frames.findIndex(Boolean)
  if (next < 0) return false
  const callback = frames[next]
  frames[next] = null
  callback()
  return true
}
/* Drain the loop the way holding still at the edge drains it. The cap is a
 * runaway guard, not an expectation. */
const settle = (limit = 400) => { let n = 0; while (n < limit && runFrame()) n++; return n }

const PANE = { left: 0, top: 0, right: 800, bottom: 600 }

/* x is a graph coordinate; at zoom 1 with panX 0 it is also the screen
 * coordinate, so `x: 900` on an 800-wide pane means "100px past the right
 * edge". r is the circle radius the guard measures with. */
function graphWith({ others, panBound = -4000 } = {}) {
  frames.length = 0
  const held = { id: 'held', agent: { id: 'held', parentId: 'root' }, x: 780, y: 300, r: 20, slot: { x: 780, y: 300 }, el: { classList: { add() {}, remove() {} } } }
  const nodes = new Map([[held.id, held], ...others.map(o => [o.id, o])])
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
    W: 800, H: 600, zoom: 1, panX: 0, panY: 0, nodes, emptySlots: new Map(),
    zoomHost: {
      getBoundingClientRect: () => ({ ...PANE }),
      clientLeft: 0, clientTop: 0, ownerDocument: { body: { style: {} } },
    },
    _clampPan() { this.panX = Math.max(this.panX, panBound); this.panY = Math.max(this.panY, panBound) },
    _applyZoom() {}, _placeDraggedRecord() {},
  })
  return { graph, held }
}

const inView = (graph, node) => {
  const low = graph.panX + (node.x - node.r) * graph.zoom
  const high = graph.panX + (node.x + node.r) * graph.zoom
  return high > PANE.left && low < PANE.right
}

/* The anchor sits just inside the LEFT edge, so panning left drops it out of
 * view almost immediately. The target sits past the RIGHT edge, which is the
 * whole reason the view is moving. */
const anchorNearLeftEdge = { id: 'anchor', agent: { id: 'anchor', parentId: 'root' }, x: 5, y: 300, r: 10, el: { classList: { add() {}, remove() {} } } }
const targetPastRightEdge = { id: 'target', agent: { id: 'target', parentId: 'root' }, x: 900, y: 300, r: 20, el: { classList: { add() {}, remove() {} } } }

test('holding at the edge keeps fetching until the off-screen target is droppable', () => {
  const { graph, held } = graphWith({ others: [anchorNearLeftEdge, targetPastRightEdge] })
  assert.equal(inView(graph, targetPastRightEdge), false, 'the target starts off screen right')
  assert.equal(inView(graph, anchorNearLeftEdge), true, 'and the only other target starts in view, near the far edge')

  graph._dragAutoPan(held, { clientX: 799, clientY: 300 }, { x: 0, y: 0 })
  assert.ok(graph._dragPan, 'a hold inside the band starts the loop')
  assert.ok(graph._dragPan.vx < 0, 'the right edge pans content left, to reveal what is right of it')
  settle()

  assert.ok(inView(graph, targetPastRightEdge),
    `the view must keep coming until the target it is fetching is droppable; it stopped at panX ${graph.panX}, with the target still ${Math.round(graph.panX + targetPastRightEdge.x - targetPastRightEdge.r - PANE.right)}px past the edge`)
})

/* THE INTENT THE GUARD EXISTS FOR, pinned so the fix above cannot trade one
 * defect for the other. Once nothing is left ahead in the direction of travel,
 * the pan must stop rather than carry the forest away and leave the hand over
 * empty canvas. */
test('with nothing left ahead, the pan still stops instead of carrying the forest off screen', () => {
  const behind = { id: 'behind', agent: { id: 'behind', parentId: 'root' }, x: 300, y: 300, r: 20, el: { classList: { add() {}, remove() {} } } }
  const { graph, held } = graphWith({ others: [behind] })
  graph._dragAutoPan(held, { clientX: 799, clientY: 300 }, { x: 0, y: 0 })
  settle()
  assert.ok(graph.panX > -4000, 'it did not run to the permissive bound')
  assert.ok(inView(graph, behind),
    `the last target is still on screen and droppable at panX ${graph.panX}`)
})

test('a lone held node with nothing to drop on still pans freely to the bound', () => {
  const { graph, held } = graphWith({ others: [] })
  graph._dragAutoPan(held, { clientX: 799, clientY: 300 }, { x: 0, y: 0 })
  settle()
  assert.equal(graph.panX, -4000, 'no candidates means nothing to keep in view, so the ordinary pan bound governs')
})

test('the left edge fetches a target off screen left, the same way', () => {
  const anchorNearRight = { id: 'anchor', agent: { id: 'anchor', parentId: 'root' }, x: 795, y: 300, r: 10, el: { classList: { add() {}, remove() {} } } }
  const targetPastLeft = { id: 'target', agent: { id: 'target', parentId: 'root' }, x: -100, y: 300, r: 20, el: { classList: { add() {}, remove() {} } } }
  const { graph, held } = graphWith({ others: [anchorNearRight, targetPastLeft] })
  graph._clampPan = function () { this.panX = Math.min(this.panX, 4000) }
  assert.equal(inView(graph, targetPastLeft), false, 'the target starts off screen left')
  graph._dragAutoPan(held, { clientX: 1, clientY: 300 }, { x: 0, y: 0 })
  assert.ok(graph._dragPan.vx > 0, 'the left edge pans content right')
  settle()
  assert.ok(inView(graph, targetPastLeft),
    `the leftward fetch must also complete; it stopped at panX ${graph.panX}`)
})

/* DIAGONAL DRAGS need both axes to agree about WHEN, not just whether. Holding
 * a corner pans both ways at once, so a target is only really ahead if the
 * frames in which it crosses into the pane horizontally overlap the frames in
 * which it crosses in vertically. These two cases differ only in the target's
 * y, which is the whole point. */
const corner = { clientX: 799, clientY: 599 }

test('a corner hold fetches a target whose two arrival windows overlap', () => {
  const reachable = { id: 'target', agent: { id: 'target', parentId: 'root' }, x: 900, y: 700, r: 20, el: { classList: { add() {}, remove() {} } } }
  const { graph, held } = graphWith({ others: [anchorNearLeftEdge, reachable] })
  graph._dragAutoPan(held, corner, { x: 0, y: 0 })
  assert.ok(graph._dragPan.vx < 0 && graph._dragPan.vy < 0, 'a corner pans on both axes')
  settle()
  assert.ok(inView(graph, reachable), `the diagonally reachable target must arrive; panX ${graph.panX}, panY ${graph.panY}`)
})

test('a corner hold does not chase a target whose arrival windows never coincide', () => {
  /* Off to the right, but so far below that by the time it rises into the
   * band it has already passed out of the left side. It can never be on
   * screen, so it must not justify carrying the near target away. */
  const unreachable = { id: 'target', agent: { id: 'target', parentId: 'root' }, x: 900, y: 2000, r: 20, el: { classList: { add() {}, remove() {} } } }
  const { graph, held } = graphWith({ others: [anchorNearLeftEdge, unreachable] })
  graph._dragAutoPan(held, corner, { x: 0, y: 0 })
  settle()
  assert.ok(graph.panX > -4000, `it must not run to the bound chasing an unreachable target; panX ${graph.panX}`)
  assert.ok(inView(graph, anchorNearLeftEdge), 'and the one real target is still on screen')
})
