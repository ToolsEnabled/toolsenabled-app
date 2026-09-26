/* THE SHARED SIBLING BUS MUST BE MEASURED AT THE RADII THAT ARE ACTUALLY DRAWN.
 *
 * _elbowRoute spans `from.y + this._nodeRadius(from)` to `to.y - this._nodeRadius(to)`, and
 * _nodeRadius is `record.r * _nodeScale()`. _nodeScale rises above 1 on purpose when the view
 * is zoomed out so circles stay legible; for a fleet past the collapse threshold it is capped
 * at `1.12 / zoom`, about 2.2x at 0.5x zoom, which is an ordinary overview of a big tree.
 *
 * _renderLinks placed the bus using the RAW `record.r`. The bus is therefore computed across
 * a different span than the one the route draws, so the horizontal bracket a tier shares does
 * not sit where the drawn circles put it. It is a few pixels at 2.2x on a 400px drop, and it
 * grows with the scale and the gap; in the tight case the bus can fall outside the drawn span
 * entirely and _elbowRoute's own guard then returns a straight diagonal on a canvas whose
 * point is that it has none.
 *
 * These tests drive _renderLinks and read the path element it appends, so they measure the
 * drawn result, not the source of the arithmetic. The stub carries every field _renderLinks
 * reads -- including communicationLinks, whose absence made an earlier draft of this file
 * throw before it asserted anything.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

installDomStandIn(globalThis)
if (typeof globalThis.document.createElementNS !== 'function') {
  globalThis.document.createElementNS = (_ns, tag) => globalThis.document.createElement(tag)
}

const RADIUS = 47
const PARENT_Y = 100
const CHILD_Y = 500
const BUS_FRACTION = 0.55

function drawAtScale(scale) {
  const svg = globalThis.document.createElement('svg')
  const record = (id, parentId, x, y) => ({
    id, x, y, r: RADIUS, el: globalThis.document.createElement('div'),
    agent: { id, parentId, role: 'builder', state: 'running' },
  })
  const subject = Object.assign(Object.create(StaticTreeGraph.prototype), {
    svg,
    nodes: new Map([
      ['parent', record('parent', null, 400, PARENT_Y)],
      ['child', record('child', 'parent', 620, CHILD_Y)],
    ]),
    emptySlots: new Map(),
    _culled: new Set(),
    _layoutVisibleIds: new Set(['parent', 'child']),
    declaredEdges: [],
    communicationLinks: [],
    linkMarks: new Map(),
    zoom: 1,
    _nodeScale: () => scale,
  })
  subject._renderLinks()
  // Per-edge geometry lives in defs; the merged visible strokes consume those
  // same routes without repeatedly painting shared trunks.
  const path = svg.querySelector('[data-to="child"]')
  assert.ok(path, 'the parent-to-child connector was not drawn at all')
  assert.equal(path.classList.contains('tree-link-route'), true)
  return path.getAttribute('d')
}

/* The elbow's first Q command turns at the bus: `Q startX busY ...`. */
function busYFrom(d) {
  const turn = d.match(/Q\s+(-?[\d.]+)\s+(-?[\d.]+)/)
  assert.ok(turn, 'the connector is not an elbow, so it has no bus: ' + d)
  return Number(turn[2])
}

const drawnBus = scale => {
  const top = PARENT_Y + RADIUS * scale
  const bottom = CHILD_Y - RADIUS * scale
  return top + (bottom - top) * BUS_FRACTION
}

test('at 1x the bus sits where the drawn radii put it', () => {
  const busY = busYFrom(drawAtScale(1))
  assert.ok(Math.abs(busY - drawnBus(1)) < 0.5,
    'bus at ' + busY + ', drawn radii put it at ' + drawnBus(1))
})

test('a zoomed-out overview measures its bus at the drawn radius, not the raw one', () => {
  const scale = 2.2
  const expected = drawnBus(scale)
  const rawRadiusBus = (PARENT_Y + RADIUS) + ((CHILD_Y - RADIUS) - (PARENT_Y + RADIUS)) * BUS_FRACTION
  /* The two answers must actually differ, or this test proves nothing. */
  assert.ok(Math.abs(expected - rawRadiusBus) > 2,
    'fixture does not separate the two measures: ' + expected + ' vs ' + rawRadiusBus)
  const busY = busYFrom(drawAtScale(scale))
  assert.ok(Math.abs(busY - expected) < 0.5,
    'bus drawn at ' + busY + ' but the drawn radii put it at ' + expected
    + '; the raw radius would put it at ' + rawRadiusBus)
})

test('the bus stays inside the span the route actually covers, at every scale it can reach', () => {
  for (const scale of [1, 1.4, 1.8, 2.2]) {
    const top = PARENT_Y + RADIUS * scale
    const bottom = CHILD_Y - RADIUS * scale
    if (bottom - top <= 4) continue
    const busY = busYFrom(drawAtScale(scale))
    assert.ok(busY > top && busY < bottom,
      'at scale ' + scale + ' the bus ' + busY + ' is outside the drawn span ' + top + '..' + bottom)
  }
})
