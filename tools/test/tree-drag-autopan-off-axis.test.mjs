import test from 'node:test'
import assert from 'node:assert/strict'
import { StaticTreeGraph } from '../../src/tree-graph.js'

test('an off-axis circle must not let horizontal auto-pan carry away the last reachable target', () => {
  const frames = new Map()
  let nextId = 0
  const priorFrame = globalThis.requestAnimationFrame
  const priorCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = callback => { frames.set(++nextId, callback); return nextId }
  globalThis.cancelAnimationFrame = id => frames.delete(id)
  try {
    const held = { id: 'held', x: 780, y: 300, r: 20 }
    const near = { id: 'near', x: 5, y: 300, r: 10 }
    // It is right of the viewport, but also above it. A horizontal pan can
    // never bring it into view; it cannot justify discarding the near target.
    const unreachable = { id: 'off-axis', x: 900, y: -500, r: 20 }
    const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
      zoom: 1, panX: 0, panY: 0,
      nodes: new Map([held, near, unreachable].map(node => [node.id, node])), emptySlots: new Map(),
      zoomHost: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
        ownerDocument: { body: { style: {} } }, clientLeft: 0, clientTop: 0 },
      _clampPan() { this.panX = Math.max(this.panX, -4000) },
      _applyZoom() {}, _placeDraggedRecord() {},
    })
    graph._dragAutoPan(held, { clientX: 799, clientY: 300 }, { x: 0, y: 0 })
    for (let count = 0; count < 400 && frames.size; count++) {
      const [id, frame] = frames.entries().next().value
      frames.delete(id)
      frame()
    }
    assert.ok(graph.panX + near.x + near.r > 0,
      `the last reachable target left the pane; panX=${graph.panX}, panY=${graph.panY}`)
    assert.equal(graph._dragPan, null, 'the last-target guard must stop the loop')
  } finally {
    globalThis.requestAnimationFrame = priorFrame
    globalThis.cancelAnimationFrame = priorCancel
  }
})
