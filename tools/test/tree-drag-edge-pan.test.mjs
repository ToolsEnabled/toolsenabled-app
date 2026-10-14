/* THE VIEW COMES TO THE HAND. Owner, 2026-09-15: "sometime on the tree its
 * hard to pull a agent far enough right to drop it on another agents tree."
 *
 * A pointer cannot leave the pane, so a drop target past the pane's edge was
 * unreachable: the held node stopped at the glass, and the only way on was to
 * let go, pan by hand, and pick it up again. Now a node held inside the edge
 * band pans the view a little each frame (src/tree-graph.js _dragAutoPan),
 * faster the deeper into the band, re-placing the node under the pointer it
 * has not left; it stops the moment the pointer leaves the band, lets go, or
 * the pan reaches the same bound a hand pan reaches (_clampPan). The reach a
 * node may be dragged to also follows the drawn forest, so a tree past two
 * canvas widths is still a place a node can go. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { StaticTreeGraph } from '../../src/tree-graph.js'

const frames = []
globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length }
globalThis.cancelAnimationFrame = id => { frames[id - 1] = null }
const runFrame = () => { const next = frames.findIndex(Boolean); if (next < 0) return false; const callback = frames[next]; frames[next] = null; callback(); return true }

function graphWith({ panX = 0, clampAt = null, others = [] } = {}) {
  frames.length = 0 // each case starts with an empty frame queue
  const placed = []
  const record = { id: 'w1', agent: { id: 'w1', parentId: 'manager' }, x: 500, y: 300, r: 40, slot: { x: 300, y: 300 }, el: { classList: { add() {}, remove() {} } } }
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
    W: 1000, H: 600, zoom: 1, panX, panY: 0, nodes: new Map([[record.id, record], ...others.map(other => [other.id, other])]),
    zoomHost: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }), clientLeft: 0, clientTop: 0, ownerDocument: { body: { style: {} } } },
    _clampPan() { if (clampAt !== null) this.panX = Math.max(this.panX, clampAt) },
    _applyZoom() {},
    _placeDraggedRecord(target, point, offset) { placed.push({ x: point.clientX, panX: this.panX, offset }) },
  })
  return { graph, record, placed }
}

test('a node held away from every edge pans nothing and starts no frame loop', () => {
  const { graph, record } = graphWith()
  graph._dragAutoPan(record, { clientX: 400, clientY: 300 }, { x: 0, y: 0 })
  assert.equal(graph._dragPan, undefined)
  assert.equal(frames.filter(Boolean).length, 0)
})

test('held against the right edge, the view pans left under the pointer every frame and the node is re-placed each time', () => {
  const { graph, record, placed } = graphWith()
  graph._dragAutoPan(record, { clientX: 799, clientY: 300 }, { x: 5, y: 0 })
  assert.ok(graph._dragPan, 'a drag in the band starts the loop')
  assert.ok(graph._dragPan.vx < 0 && graph._dragPan.vy === 0, 'the right edge pans the content leftwards, horizontally only')
  assert.ok(runFrame())
  assert.ok(graph.panX < 0, 'the content moved left, bringing what lies to the right into view')
  assert.equal(placed.length, 1)
  assert.deepEqual(placed[0], { x: 799, panX: graph.panX, offset: { x: 5, y: 0 } }, 'the node was re-placed under the pointer that has not moved')
  assert.equal(graph._viewSteered, true, 'a pan by hand or by drag stops the automatic fit re-answering')
  const before = graph.panX
  assert.ok(runFrame())
  assert.ok(graph.panX < before, 'it keeps going while the pointer stays in the band')
  /* Deeper into the band is faster; the very edge is the fastest. */
  const shallow = graphWith(); shallow.graph._dragAutoPan(shallow.record, { clientX: 760, clientY: 300 }, { x: 0, y: 0 })
  assert.ok(Math.abs(shallow.graph._dragPan.vx) < Math.abs(graph._dragPan.vx))
})

test('leaving the band, letting go, or hitting the pan bound stops the loop', () => {
  const { graph, record } = graphWith()
  graph._dragAutoPan(record, { clientX: 799, clientY: 300 }, { x: 0, y: 0 })
  graph._dragAutoPan(record, { clientX: 400, clientY: 300 }, { x: 0, y: 0 })
  assert.equal(graph._dragPan, null, 'the pointer left the band')
  assert.equal(runFrame(), false, 'its frame was cancelled')
  graph._dragAutoPan(record, { clientX: 799, clientY: 300 }, { x: 0, y: 0 })
  graph._stopDragAutoPan()
  assert.equal(graph._dragPan, null, 'letting go stops it')
  const bounded = graphWith({ panX: -100, clampAt: -100 })
  bounded.graph._dragAutoPan(bounded.record, { clientX: 799, clientY: 300 }, { x: 0, y: 0 })
  assert.ok(runFrame())
  assert.equal(bounded.graph.panX, -100, 'the clamp held the view where a hand pan would stop')
  assert.equal(bounded.graph._dragPan, null, 'and the loop ended rather than spinning against the bound')
})

test('the right reach follows the drawn forest, so a tree past two canvas widths is still reachable', () => {
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), { W: 1000, nodes: new Map(), _contentBox: () => ({ x: 0, y: 0, w: 3400, h: 500 }) })
  assert.equal(graph._rightReach({ r: 40 }, 700), 3400 + 1000 - 40 - 12, 'one canvas width past the last drawn thing')
  const narrow = Object.assign(Object.create(StaticTreeGraph.prototype), { W: 1000, nodes: new Map(), _contentBox: () => ({ x: 0, y: 0, w: 600, h: 500 }) })
  assert.equal(narrow._rightReach({ r: 40 }, 700), 1948, 'a small forest keeps the two-widths reach')
})

/* AND IT STOPS WHILE THERE IS STILL SOMEWHERE TO DROP.
 *
 * Measured in the real app on 2026-09-15, holding a node still at the right
 * edge for 1.6s: the view panned 1210px, every other node in a three-node
 * tree left the screen, and the hand was left holding a node over empty
 * canvas with nothing to drop on. The pan bound alone (_clampPan, PAN_KEEP)
 * permits that -- it only keeps a strip of CONTENT on screen, and the held
 * node is content. Auto-pan exists to bring a target to the hand, so the
 * frame that would empty the view of targets is undone and the pan stops
 * with the furthest target still on screen. */
test('auto-pan stops while the last drop target is still on screen, not after it has gone', () => {
  // The other node spans graph x 660..740; at zoom 1 with panX 0 that is on
  // screen in an 800px pane, and it leaves only once panX passes -740.
  const other = { id: 'w2', agent: { id: 'w2', parentId: 'manager' }, x: 700, y: 300, r: 40, el: { classList: { add() {}, remove() {} } } }
  const { graph, record } = graphWith({ others: [other] })
  graph._dragAutoPan(record, { clientX: 799, clientY: 300 }, { x: 0, y: 0 })
  let frames = 0
  while (runFrame() && frames < 500) frames += 1
  assert.equal(graph._dragPan, null, 'the loop ended rather than panning for ever')
  assert.ok(graph.panX < 0, 'it still panned towards the target')
  assert.ok(graph.panX + 740 > 0,
    `the target's right edge is still on screen (panX ${graph.panX}, target right ${graph.panX + 740})`)
  assert.equal(graph._dropTargetInView(record), true, 'a target remains droppable where the pan stopped')
})

test('a lone node with nothing to drop on keeps the ordinary pan bound', () => {
  // Nothing to preserve, so the guard does not restrict: this is the case the
  // earlier tests exercise, asserted here as the deliberate exception.
  const { graph, record } = graphWith({ clampAt: -400 })
  assert.equal(graph._dropTargetInView(record), true, 'no candidate at all is not a reason to stop')
  graph._dragAutoPan(record, { clientX: 799, clientY: 300 }, { x: 0, y: 0 })
  let frames = 0
  while (runFrame() && frames < 500) frames += 1
  assert.equal(graph.panX, -400, 'it panned all the way to the hand-pan bound')
})

test('an offered slot counts as somewhere to drop, so the pan keeps going for it', () => {
  const slot = { id: 'slot-1', kind: 'child', x: 700, y: 300, r: 40, hidden: false }
  const { graph, record } = graphWith()
  graph.emptySlots = new Map([[slot.id, slot]])
  assert.equal(graph._dropTargetInView(record), true, 'the slot is on screen')
  graph.panX = -900
  assert.equal(graph._dropTargetInView(record), false, 'panned past it, nothing is left to drop on')
  slot.hidden = true
  graph.panX = 0
  assert.equal(graph._dropTargetInView(record), true, 'a hidden slot is no candidate, so nothing is restricted')
})

/* AND A TARGET THAT HAS NOT ARRIVED YET IS THE REASON TO KEEP GOING.
 *
 * The first version of the guard above read the view AFTER the step, so a
 * drag whose only target was still off screen -- the owner's case exactly,
 * "pull an agent far enough right to drop it on another agents tree" --
 * stopped on its first frame with nothing in view and never fetched anything.
 * Caught by hand in the real app, not by the suite, which is why it is here.
 * The rule is: do not pan PAST the last target, not: do not pan while none
 * is showing. */
test('a target still off screen does not stop the pan, it is what the pan is for', () => {
  // Spans graph x 1860..1940: far to the right of an 800px pane, invisible at
  // panX 0, and reachable only by panning.
  const far = { id: 'w3', agent: { id: 'w3', parentId: 'manager' }, x: 1900, y: 300, r: 40, el: { classList: { add() {}, remove() {} } } }
  const { graph, record } = graphWith({ others: [far] })
  assert.equal(graph._dropTargetInView(record), false, 'nothing is in view when the drag starts')
  graph._dragAutoPan(record, { clientX: 799, clientY: 300 }, { x: 0, y: 0 })
  assert.ok(runFrame(), 'the loop runs rather than stopping on the first frame')
  assert.ok(graph.panX < 0, 'and the view moved towards the target')
  let frames = 0
  while (runFrame() && frames < 500) frames += 1
  assert.equal(graph._dropTargetInView(record), true, 'the target was fetched into view and stayed there')
  assert.ok(graph.panX + 1940 > 0 && graph.panX + 1860 < 800, 'it is on screen, not panned past')
})
