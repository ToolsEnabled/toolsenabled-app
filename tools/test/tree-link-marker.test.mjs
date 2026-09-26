import assert from 'node:assert/strict'
import test from 'node:test'
import { clearLinkMarkerPoint } from '../../src/tree-link-marker.js'

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is near ${expected}`)
const clear = (point, boxes, pad) => {
  for (const box of boxes) assert.ok(point.x < box.left - pad || point.x > box.right + pad
    || point.y < box.top - pad || point.y > box.bottom + pad, 'marker clears every padded rectangle')
}

test('an unobstructed midpoint stays exactly where it was', () => {
  const boxes = [{ left: 40, right: 60, top: 30, bottom: 50 }]
  assert.deepEqual(clearLinkMarkerPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, boxes), { x: 50, y: 0 })
  assert.deepEqual(clearLinkMarkerPoint({ x: 0, y: 0 }, { x: 100, y: 100 }), { x: 50, y: 50 })
})

test('horizontal blockage chooses the nearest free position, with ties toward the start', () => {
  const boxes = [{ left: 40, right: 60, top: -5, bottom: 5 }]
  const point = clearLinkMarkerPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, boxes, 10)
  near(point.x, 30); assert.equal(point.y, 0); clear(point, boxes, 10)
  const reverse = clearLinkMarkerPoint({ x: 100, y: 0 }, { x: 0, y: 0 }, boxes, 10)
  near(reverse.x, 70); clear(reverse, boxes, 10)
})

test('vertical links use the same clearance and start-side tie rule', () => {
  const boxes = [{ left: -5, right: 5, top: 40, bottom: 60 }]
  const point = clearLinkMarkerPoint({ x: 0, y: 100 }, { x: 0, y: 0 }, boxes, 8)
  assert.equal(point.x, 0); near(point.y, 68); clear(point, boxes, 8)
})

test('diagonal slab intersections keep the marker on the original straight segment', () => {
  const boxes = [{ left: 40, right: 60, top: 40, bottom: 60 },
    { left: 20, right: 30, top: 80, bottom: 90 }]
  const point = clearLinkMarkerPoint({ x: 0, y: 0 }, { x: 100, y: 100 }, boxes, 5)
  near(point.x, 35); assert.equal(point.x, point.y); clear(point, boxes, 5)
})

test('a diagonal bounding-box overlap without a segment intersection stays clear', () => {
  const boxes = [{ left: 20, right: 30, top: 60, bottom: 70 }]
  assert.deepEqual(clearLinkMarkerPoint({ x: 0, y: 0 }, { x: 100, y: 100 }, boxes, 0), { x: 50, y: 50 })
})

test('overlapping intervals merge before choosing a genuinely free point', () => {
  const boxes = [{ left: 30, right: 55, top: -5, bottom: 5 },
    { left: 45, right: 80, top: -5, bottom: 5 }, { left: 48, right: 52, top: -2, bottom: 2 }]
  const original = structuredClone(boxes)
  const point = clearLinkMarkerPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, boxes, 0)
  near(point.x, 30); clear(point, boxes, 0)
  assert.deepEqual(clearLinkMarkerPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, [...boxes].reverse(), 0), point)
  assert.deepEqual(boxes, original)
})

test('endpoint boxes block their own intervals, leaving the central opening', () => {
  const boxes = [{ left: -5, right: 15, top: -10, bottom: 10 },
    { left: 75, right: 105, top: -10, bottom: 10 }, { left: 40, right: 55, top: -5, bottom: 5 }]
  const point = clearLinkMarkerPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, boxes, 5)
  near(point.x, 60); clear(point, boxes, 5)
})

test('touching padded obstacles cannot leave a false free point between them', () => {
  const boxes = [{ left: 30, right: 50, top: -5, bottom: 5 }, { left: 50, right: 70, top: -5, bottom: 5 }]
  const point = clearLinkMarkerPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, boxes, 0)
  near(point.x, 30); clear(point, boxes, 0)
})

test('world-space clearance can compensate for a fixed screen marker at different zooms', () => {
  const boxes = [{ left: 44, right: 56, top: -5, bottom: 5 }]
  for (const [zoom, expected] of [[1, 31], [0.5, 18], [2, 37.5]]) {
    const pad = 13 / zoom
    const point = clearLinkMarkerPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, boxes, pad)
    near(point.x, expected); clear(point, boxes, pad)
    assert.ok((boxes[0].left - point.x) * zoom >= 13, 'the screen-space edge clearance stays at least 13px')
  }
})

test('complete coverage and a zero-length segment preserve a finite midpoint fallback', () => {
  const box = { left: -100, right: 200, top: -100, bottom: 200 }
  assert.deepEqual(clearLinkMarkerPoint({ x: 0, y: 0 }, { x: 100, y: 100 }, [box]), { x: 50, y: 50 })
  assert.deepEqual(clearLinkMarkerPoint({ x: 20, y: 30 }, { x: 20, y: 30 }, [box]), { x: 20, y: 30 })
  assert.deepEqual(clearLinkMarkerPoint({ x: -1e308, y: 0 }, { x: 1e308, y: 0 }, [box]), { x: 0, y: 0 })
})

test('a tiny but real free interval remains usable', () => {
  const boxes = [{ left: -10, right: 50, top: -5, bottom: 5 }, { left: 50.00001, right: 110, top: -5, bottom: 5 }]
  const point = clearLinkMarkerPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, boxes, 0)
  clear(point, boxes, 0)
  assert.ok(point.x > 50 && point.x < 50.00001)
})
