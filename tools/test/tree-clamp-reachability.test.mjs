/* CAN THE CLAMP STRAND A NODE? T42 item 32, the owner's question behind it:
 * "the canvas will not pan". Builder (4a1a39df) showed the reported symptom is
 * the pan clamp sitting at its bound, not a dead canvas — but a bound is only
 * innocent if everything drawn stays reachable from inside it. Controller,
 * 2026-09-15: on the owner's REAL saved forest, can any node be off screen and
 * unreachable by pan, in either mode?
 *
 * So this asks the real _clampPan (not a stub — the sibling
 * tree-drag-edge-pan.test.mjs stubs it deliberately, this one must not) for the
 * panX/panY range it actually permits, and checks every node of the persisted
 * 46-node / four-tree forest against it. RED here means the clamp strands a
 * node and the clamp is the defect.
 *
 * Fixture: Manager 2's read-only export of the owner's persisted saved forest,
 * sha256 93268367939159d65dafa6bdc42c81206d3f595a11950c20bc86661f1f5b0010,
 * receipt Temp\te-m2-t72-evidence-20260915\LIVE-SAVED-FOREST-RECEIPT.md. It is
 * a structural copy: ids, parents, roles and tree groups only. No LIVE window
 * was opened to produce or to use it. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { layoutTree } from '../../src/tree-layout.js'

const forest = JSON.parse(readFileSync(new URL('./fixtures/live-saved-forest-structure.json', import.meta.url), 'utf8'))

/* The pane the candidate actually reports for this view: .graph-canvas-slot
 * (the zoomHost, which is what _clampPan measures against) spanned
 * 217..1423 x 254..879 on a 1440x900 window. */
const HOST_W = 1206
const HOST_H = 625

const agents = forest.nodes.map(node => ({
  id: node.id,
  parentId: node.parentId ?? null,
  role: node.role,
  name: node.nameBase ? `${node.nameBase}${node.nameOrdinal ? ` ${node.nameOrdinal}` : ''}` : node.id,
}))

/* editMode is the only thing that differs between the two modes here: with
 * smartScope on (this view has it — the nodes are draggable and the edit-mode
 * pan guard never engages) layoutTree is handed the same `spacious` either
 * way, but _nodeScale returns 1 in edit mode and may inflate the drawn radius
 * outside it, which moves the content box and therefore the bound. */
function graphFor({ editMode, zoom }) {
  const layout = layoutTree({ nodes: agents, edges: [], W: HOST_W, H: HOST_H, spacious: true })
  const nodes = new Map()
  for (const agent of agents) {
    const slot = layout.slots.get(agent.id)
    if (!slot || layout.culled.has(agent.id)) continue
    nodes.set(agent.id, { id: agent.id, agent, x: slot.x, y: slot.y, r: layout.radii.get(agent.id), slot })
  }
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
    W: HOST_W, H: HOST_H, zoom, panX: 0, panY: 0,
    nodes, emptySlots: new Map(), nodeStyle: 'circles',
    spacious: true, smartScope: true, editMode,
    computer: { agents },
    _culled: layout.culled,
    _layoutVisibleIds: new Set(nodes.keys()),
    _fitFloor: null, _fittingView: false,
    zoomHost: { clientWidth: HOST_W, clientHeight: HOST_H, clientLeft: 0, clientTop: 0 },
  })
  return { graph, layout, nodes }
}

/* The permitted range, asked of the real clamp rather than recomputed here:
 * drive the pan far past either end and record where it is put back. */
function panRange(graph) {
  const keep = { x: graph.panX, y: graph.panY }
  graph.panX = -1e9; graph.panY = -1e9; graph._clampPan()
  const min = { x: graph.panX, y: graph.panY }
  graph.panX = 1e9; graph.panY = 1e9; graph._clampPan()
  const max = { x: graph.panX, y: graph.panY }
  Object.assign(graph, { panX: keep.x, panY: keep.y })
  return { min, max }
}

/* A node centre is reachable when some permitted pan puts it inside the pane.
 * centre = pan + coordinate * zoom is monotonic in pan, so the centre sweeps
 * [min + c*zoom, max + c*zoom]; it is reachable exactly when that interval
 * meets the pane. */
const reaches = (min, max, coordinate, zoom, viewport) =>
  min + coordinate * zoom < viewport && max + coordinate * zoom > 0

for (const editMode of [false, true]) {
  const mode = editMode ? 'edit mode' : 'plain mode'

  test(`${mode}: the clamp strands no node of the owner's saved 46-node forest at the default zoom`, () => {
    const { graph, nodes } = graphFor({ editMode, zoom: 1 })
    assert.equal(nodes.size, 46, 'every node of the persisted forest is laid out and drawn')
    const { min, max } = panRange(graph)
    const stranded = []
    for (const record of nodes.values()) {
      const onX = reaches(min.x, max.x, record.x, graph.zoom, HOST_W)
      const onY = reaches(min.y, max.y, record.y, graph.zoom, HOST_H)
      if (!onX || !onY) stranded.push(`${record.agent.name} (${record.id.slice(0, 12)}) at ${Math.round(record.x)},${Math.round(record.y)}${onX ? '' : ' X'}${onY ? '' : ' Y'}`)
    }
    assert.deepEqual(stranded, [], `panX permitted [${Math.round(min.x)}, ${Math.round(max.x)}], panY [${Math.round(min.y)}, ${Math.round(max.y)}]; stranded: ${stranded.join(' | ')}`)
  })

  /* The same question at the two ends of the zoom range, because the bound is
   * computed from content measured AT the zoom: 2.4 is the measured cap
   * (_controlZoom saturates there) and 0.25 is the far end. */
  for (const zoom of [0.25, 2.4]) {
    test(`${mode}: the clamp strands no node at zoom ${zoom}`, () => {
      const { graph, nodes } = graphFor({ editMode, zoom })
      const { min, max } = panRange(graph)
      const stranded = []
      for (const record of nodes.values()) {
        if (!reaches(min.x, max.x, record.x, zoom, HOST_W) || !reaches(min.y, max.y, record.y, zoom, HOST_H)) {
          stranded.push(`${record.id.slice(0, 12)} at ${Math.round(record.x)},${Math.round(record.y)}`)
        }
      }
      assert.deepEqual(stranded, [], `zoom ${zoom}: panX [${Math.round(min.x)}, ${Math.round(max.x)}]; stranded: ${stranded.join(' | ')}`)
    })
  }
}

/* THE INVARIANT THAT MAKES THE BOUND SAFE. _clampPan derives its range from
 * _contentBox, and _contentBox skips any record that is hidden, culled, or
 * absent from _layoutVisibleIds. So reachability rests entirely on one thing:
 * anything DRAWN is inside that box. If a record can be on the canvas while
 * the box ignores it, the bound will happily stop short of it — which is the
 * one mechanism that would look to a person exactly like a canvas that will
 * not pan. This pins that invariant rather than the arithmetic above. */
test('every drawn node is inside the content box the clamp derives its bound from', () => {
  const { graph, nodes } = graphFor({ editMode: false, zoom: 1 })
  const box = graph._contentBox()
  const outside = []
  for (const record of nodes.values()) {
    if (record.x < box.x || record.x > box.x + box.w || record.y < box.y || record.y > box.y + box.h) {
      outside.push(`${record.id.slice(0, 12)} at ${Math.round(record.x)},${Math.round(record.y)}`)
    }
  }
  assert.deepEqual(outside, [], `content box x ${Math.round(box.x)} w ${Math.round(box.w)}, y ${Math.round(box.y)} h ${Math.round(box.h)}; outside: ${outside.join(' | ')}`)
})

/* And the converse, stated as the risk it is: a record the layout no longer
 * lists as visible is excluded from the box, so the clamp stops short of it.
 * That is correct only because such a record is also not drawn. This test
 * exists so that if the two ever come apart — drawn but not in
 * _layoutVisibleIds — the failure is named here instead of reaching a person
 * as "the canvas will not pan". */
test('a record excluded from the visible set is excluded from the bound, so it must never be drawn', () => {
  const { graph, nodes } = graphFor({ editMode: false, zoom: 1 })
  const rightmost = [...nodes.values()].sort((a, b) => b.x - a.x)[0]
  const withAll = graph._contentBox()
  graph._layoutVisibleIds = new Set([...nodes.keys()].filter(id => id !== rightmost.id))
  const without = graph._contentBox()
  assert.ok(without.x + without.w < withAll.x + withAll.w,
    'dropping the rightmost node from the visible set shrinks the box the bound is built from')
  const { min, max } = panRange(graph)
  assert.equal(reaches(min.x, max.x, rightmost.x, graph.zoom, HOST_W), false,
    'and with the box shrunk, no permitted pan reaches it — hence the invariant above')
})

/* A NUDGED NODE IS STILL REACHABLE. The tests above lay every node on its
 * layout slot, but the case that produced the original doubt was a node the
 * owner had DRAGGED: _rightReach lets a nudge travel a further canvas width,
 * and its comment promises "the pan bounds follow the drawn content
 * (_contentBox), so a node out there stays reachable". That promise is what is
 * checked here, because it is the one that keeps a dragged-away node from
 * becoming a node nobody can pan back to. */
for (const editMode of [false, true]) {
  test(`${editMode ? 'edit mode' : 'plain mode'}: a node nudged a full canvas width past the forest stays reachable`, () => {
    const { graph, nodes } = graphFor({ editMode, zoom: 1 })
    const rightmost = [...nodes.values()].sort((a, b) => b.x - a.x)[0]
    const lowest = [...nodes.values()].sort((a, b) => b.y - a.y)[0]
    rightmost.x = graph._rightReach(rightmost, rightmost.slot.x)
    lowest.y += HOST_H
    const { min, max } = panRange(graph)
    assert.ok(reaches(min.x, max.x, rightmost.x, graph.zoom, HOST_W),
      `a node nudged to its full right reach (x ${Math.round(rightmost.x)}) is still reachable; panX [${Math.round(min.x)}, ${Math.round(max.x)}]`)
    assert.ok(reaches(min.y, max.y, lowest.y, graph.zoom, HOST_H),
      `a node nudged a canvas height down (y ${Math.round(lowest.y)}) is still reachable; panY [${Math.round(min.y)}, ${Math.round(max.y)}]`)
  })
}
