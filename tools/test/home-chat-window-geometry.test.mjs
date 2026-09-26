import test from 'node:test'
import assert from 'node:assert/strict'
import { fitChatWindow, initialChatWindow, chatPanelRects, moveChatWindow, resizeChatWindow } from '../../src/home-chat-window-geometry.js'

const area = { width: 1200, height: 800 }
const rect = { x: 100, y: 80, width: 650, height: 480 }
test('dragging cannot strand a title or resize edge outside the workspace', () => {
  assert.deepEqual(moveChatWindow(rect, -10000, -10000, area), { ...rect, x: 0, y: 0 })
  assert.deepEqual(moveChatWindow(rect, 10000, 10000, area), { ...rect, x: 550, y: 320 })
})
test('all eight resize directions preserve minimum size and remain reachable', () => {
  for (const edge of ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']) {
    for (const delta of [-2000, 2000]) {
      const next = resizeChatWindow(rect, edge, delta, delta, area)
      assert.ok(next.width >= 360 && next.height >= 300, edge)
      assert.ok(next.x >= 0 && next.y >= 0 && next.x + next.width <= area.width && next.y + next.height <= area.height, edge)
      if (edge.includes('w')) assert.equal(next.x + next.width, rect.x + rect.width)
      if (edge.includes('n')) assert.equal(next.y + next.height, rect.y + rect.height)
    }
  }
})
test('a narrow or short viewport fits the window without imposing a larger minimum', () => {
  assert.deepEqual(fitChatWindow(rect, { width: 280, height: 220 }), { x: 0, y: 0, width: 280, height: 220 })
})
test('new windows cascade indefinitely without falling outside the workspace', () => {
  for (let index = 0; index < 100; index++) {
    const next = initialChatWindow(area, index)
    assert.deepEqual(fitChatWindow(next, area), next)
    assert.ok(next.width >= 360 && next.height >= 300)
  }
})
test('Single, Double and Four panels fill the workspace without overlaps', () => {
  for (const count of [1, 2, 4]) {
    const rects = chatPanelRects(area, count)
    assert.equal(rects.length, count)
    for (const [index, box] of rects.entries()) {
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= area.width && box.y + box.height <= area.height)
      for (const other of rects.slice(index + 1)) {
        assert.ok(box.x + box.width <= other.x || other.x + other.width <= box.x || box.y + box.height <= other.y || other.y + other.height <= box.y)
      }
    }
    assert.equal(rects.at(-1).x + rects.at(-1).width, area.width)
    assert.equal(rects.at(-1).y + rects.at(-1).height, area.height)
  }
})
