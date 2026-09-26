import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TREE_BOX, TREE_CONTEXT_SIZES, TREE_CONTEXT_SIZE_KEY,
  treeBoxSize, treeCardSize, readTreeContextSize, layoutBoxTree, boxPort, liveContextSize,
} from '../../src/tree-box-layout.js'
import { TreeScope } from '../../src/tree-scope.js'
import { chooseTreeProjection } from '../../src/tree-readability.js'

const fleet = count => Array.from({ length: count }, (_, index) => ({
  id: `agent-${index}`, name: `Agent ${index}`, parentId: index ? 'agent-0' : null,
}))

test('context sizes provide consistent immutable geometry for boxes and detached circle cards', () => {
  assert.deepEqual(Object.keys(TREE_CONTEXT_SIZES), ['mini', 'small', 'medium', 'large'])
  assert.equal(treeBoxSize(), TREE_BOX, 'unspecified size retains the existing medium box')
  let lastBox = { width: 0, height: 0 }, lastCard = { width: 0, height: 0 }
  for (const size of Object.keys(TREE_CONTEXT_SIZES)) {
    const box = treeBoxSize(size), card = treeCardSize(size)
    assert.ok(box.width > lastBox.width && box.height > lastBox.height)
    assert.ok(card.width > lastCard.width && card.height > lastCard.height)
    assert.ok(Object.isFrozen(box) && Object.isFrozen(card) && Object.isFrozen(TREE_CONTEXT_SIZES[size]))
    lastBox = box
    lastCard = card
  }
  assert.ok(Object.isFrozen(TREE_CONTEXT_SIZES))
  assert.deepEqual(treeCardSize(), { width: 280, height: 160 })
})

test('one saved context-size preference supports every size, preserves Mini, and fails safely to medium', () => {
  for (const value of ['mini', 'small', 'medium', 'large', 'invalid', 'constructor', null]) {
    const storage = { getItem(key) { assert.equal(key, TREE_CONTEXT_SIZE_KEY); return value } }
    assert.equal(readTreeContextSize(storage), ['mini', 'small', 'medium', 'large'].includes(value) ? value : 'medium')
  }
  assert.equal(liveContextSize('mini'), 'mini', 'a saved Mini choice must remain Mini')
  assert.equal(liveContextSize('invalid'), null)
  assert.equal(readTreeContextSize({ getItem() { return 'mini' } }), 'mini')
  assert.equal(readTreeContextSize(null), 'medium')
  assert.equal(readTreeContextSize({ getItem() { throw new Error('storage unavailable') } }), 'medium')
  assert.equal(treeBoxSize('missing'), TREE_BOX)
  assert.equal(treeCardSize({}), treeCardSize('medium'))
})

for (const contextSize of Object.keys(TREE_CONTEXT_SIZES)) {
  test(`${contextSize} boxes reserve their full footprint and supply the correct drawing radius`, () => {
    const nodes = fleet(14).map((agent, index) => ({ ...agent, parentId: index ? `agent-${Math.floor((index - 1) / 3)}` : null }))
    const original = structuredClone(nodes), box = treeBoxSize(contextSize)
    const layout = layoutBoxTree({ nodes, contextSize, W: 752, H: 600 })
    assert.equal(layout.slots.size, nodes.length)
    assert.equal(layout.culled.size, 0)
    const points = [...layout.slots.values()]
    for (const radius of layout.radii.values()) assert.equal(radius, box.height / 2)
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      assert.ok(Math.abs(points[i].x - points[j].x) >= box.width || Math.abs(points[i].y - points[j].y) >= box.height,
        'changing context density cannot make agent boxes overlap')
    }
    for (const [child, parent] of layout.parents) assert.ok(layout.slots.get(child).y > layout.slots.get(parent).y)
    assert.deepEqual(nodes, original)
  })

  test(`${contextSize} direct-link ports stay on the visible rectangle at each zoom scale`, () => {
    const box = treeBoxSize(contextSize), from = { x: 90, y: 170 }
    for (const scale of [0.5, 1, 1.8]) for (const [dx, dy] of [[1, 0], [0, -1], [2, 3], [-5, 1], [-3, -4]]) {
      const point = boxPort(from, { x: from.x + dx, y: from.y + dy }, scale, contextSize)
      const x = point.x - from.x, y = point.y - from.y
      assert.ok(Math.abs(x) <= box.width * scale / 2 + 1e-9)
      assert.ok(Math.abs(y) <= box.height * scale / 2 + 1e-9)
      assert.ok(Math.abs(Math.abs(x) - box.width * scale / 2) < 1e-9 || Math.abs(Math.abs(y) - box.height * scale / 2) < 1e-9)
      assert.ok(Math.abs(x * dy - y * dx) < 1e-9)
    }
  })
}

test('adaptive embedding accounts for the chosen box size instead of a fixed medium footprint', () => {
  const scope = new TreeScope(fleet(4))
  const mini = chooseTreeProjection({ scope, nodeStyle: 'boxes', contextSize: 'mini', W: 1000, H: 900 })
  const large = chooseTreeProjection({ scope, nodeStyle: 'boxes', contextSize: 'large', W: 1000, H: 900 })
  assert.equal(mini.folded, false)
  assert.equal(mini.agents.length, 4)
  assert.equal(large.folded, true)
  assert.ok(mini.fitScale > large.fitScale)
  assert.equal(mini.minScale, large.minScale, 'larger cards add context without relaxing text readability')
})

test('detached card size does not distort the circle hierarchy or its node readability', () => {
  const scope = new TreeScope(fleet(20))
  const result = chooseTreeProjection({ scope, nodeStyle: 'circles', contextSize: 'mini', W: 752, H: 800 })
  for (const contextSize of ['small', 'medium', 'large']) {
    assert.deepEqual(chooseTreeProjection({ scope, nodeStyle: 'circles', contextSize, W: 752, H: 800 }), result,
      'screen-space context cards are placed independently from circle geometry')
  }
})

test('smaller boxes spend their extra room on real agents across a mixed forest', () => {
  const work = fleet(18).map((agent, index) => ({ ...agent,
    parentId: index > 6 ? 'agent-6' : agent.parentId, treeNode: { treeId: 'work' } }))
  const agents = [...work, { id: 'review', name: 'Review', parentId: null, treeNode: { treeId: 'review' } },
    { id: 'review-child', name: 'Review child', parentId: 'review', treeNode: { treeId: 'review' } }]
  const counts = ['mini', 'small', 'medium', 'large'].map(contextSize => {
    const result = chooseTreeProjection({ scope: new TreeScope(agents), contextSize, W: 1796, H: 948 })
    assert.ok(result.agents.some(agent => agent.id === 'review-child'), 'the small tree remains directly visible')
    return result.agents.filter(agent => !agent.treeScope.group).length
  })
  assert.ok(counts[0] > counts.at(-1), 'Mini shows more actual names than Large')
  for (let index = 1; index < counts.length; index++) assert.ok(counts[index] <= counts[index - 1])
})
