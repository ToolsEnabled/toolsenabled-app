/* A DRAG MUST ALWAYS BE ABLE TO END.
 *
 * These tests drive the graph's event handlers rather than inspecting their
 * source. That distinction matters here: capture may be released by the
 * browser, and an implementation is free to spell its recovery any way it
 * likes so long as the observable drag state is repaired.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { StaticTreeGraph } from '../../src/tree-graph.js'

class FakeClassList {
  values = new Set()
  add(...names) { names.forEach(name => this.values.add(name)) }
  remove(...names) { names.forEach(name => this.values.delete(name)) }
  contains(name) { return this.values.has(name) }
}

class FakeTarget {
  constructor() {
    this.classList = new FakeClassList()
    this.listeners = new Map()
    this.released = []
    this.captured = []
    this.ownerDocument = { removeEventListener() {} }
  }
  addEventListener(type, handler) { this.listeners.set(type, handler) }
  removeEventListener(type, handler) {
    if (this.listeners.get(type) === handler) this.listeners.delete(type)
  }
  dispatch(type, values = {}) {
    const event = {
      type,
      pointerId: 7,
      button: 0,
      buttons: 1,
      clientX: 10,
      clientY: 20,
      target: { closest: () => null },
      preventDefault() {},
      stopPropagation() {},
      ...values,
    }
    this.listeners.get(type)?.(event)
    return event
  }
  setPointerCapture(id) { this.captured.push(id) }
  releasePointerCapture(id) { this.released.push(id) }
}

const makeGraph = () => {
  const graph = Object.create(StaticTreeGraph.prototype)
  graph.zoomHost = new FakeTarget()
  graph.editMode = false
  graph.panX = 0
  graph.panY = 0
  graph.zoom = 1
  graph.rootId = null
  graph.nodes = new Map()
  graph.previewFitter = { destroy() {} }
  graph._clampPan = () => {}
  graph._applyZoom = () => {}
  graph._nearestRecordTo = () => null
  graph._wireHostInteractions()
  return graph
}

for (const ending of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  test(`canvas panning ends on ${ending}`, () => {
    const graph = makeGraph()
    graph.zoomHost.dispatch('pointerdown')
    assert.equal(graph.zoomHost.classList.contains('panning'), true,
      'pointerdown should visibly begin canvas panning')

    graph.zoomHost.dispatch(ending)

    assert.equal(graph._panState, null, `${ending} must clear the active canvas pan`)
    assert.equal(graph.zoomHost.classList.contains('panning'), false,
      `${ending} must remove the canvas panning state`)
    assert.deepEqual(graph.zoomHost.released, [7], `${ending} must release pointer capture`)
  })
}

test('canvas panning self-heals on a move after the button is no longer held', () => {
  const graph = makeGraph()
  graph.zoomHost.dispatch('pointerdown')
  graph.zoomHost.dispatch('pointermove', { buttons: 0, clientX: 200, clientY: 300 })

  assert.equal(graph._panState, null,
    'a buttonless move must end the canvas pan even when its ending event was missed')
  assert.deepEqual([graph.panX, graph.panY], [0, 0],
    'a buttonless move must not move the canvas before ending the stale pan')
  assert.equal(graph.zoomHost.classList.contains('panning'), false,
    'a self-healed canvas pan must no longer look active')
})

const makeNodeDrag = () => {
  const graph = Object.create(StaticTreeGraph.prototype)
  const node = new FakeTarget()
  const record = { el: node, x: 40, y: 50, r: 10, dragMoved: false, agent: {} }
  graph.editMode = true
  graph._toGraph = event => ({ x: event.clientX, y: event.clientY })
  graph._wireNode(record)
  return { graph, node, record }
}

for (const ending of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  test(`node dragging ends on ${ending}`, () => {
    const { node } = makeNodeDrag()
    node.dispatch('pointerdown')
    assert.equal(node.classList.contains('dragging'), true,
      'pointerdown should visibly begin node dragging')

    node.dispatch(ending)

    assert.equal(node.classList.contains('dragging'), false,
      `${ending} must end the active node drag`)
    assert.deepEqual(node.released, [7], `${ending} must release node pointer capture`)
  })
}

test('node dragging self-heals on a move after the button is no longer held', () => {
  const { node, record } = makeNodeDrag()
  node.dispatch('pointerdown')
  node.dispatch('pointermove', { buttons: 0, clientX: 200, clientY: 300 })

  assert.equal(node.classList.contains('dragging'), false,
    'a buttonless move must end the node drag even when its ending event was missed')
  assert.deepEqual([record.x, record.y], [40, 50],
    'a buttonless move must not reposition the node before ending the stale drag')
})

test('destroy removes every host drag listener', () => {
  const graph = makeGraph()
  graph._destroyed = false
  graph.ro = { disconnect() {} }
  graph._animationRaf = 0
  graph._addRafs = new Set()
  graph._removeTimers = new Set()
  graph._chatTimers = new Set()
  graph.nodes = new Map()
  graph.emptySlots = new Map()
  graph.unsubs = []
  graph.container = {
    innerHTML: '',
    removeAttribute() {},
    classList: new FakeClassList(),
  }
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  globalThis.document = { removeEventListener() {} }
  globalThis.window = { removeEventListener() {} }
  graph.zoomHost.ownerDocument = globalThis.document
  try { graph.destroy() } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }

  for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    assert.equal(graph.zoomHost.listeners.has(event), false,
      `destroy must remove the ${event} listener`)
  }
})
