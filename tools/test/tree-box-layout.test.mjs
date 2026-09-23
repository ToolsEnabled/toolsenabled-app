import assert from 'node:assert/strict'
import test from 'node:test'
import { TREE_BOX, TREE_CONTEXT_SIZES, TREE_STYLE_KEY, boxPort, layoutBoxTree, readTreeStyle } from '../../src/tree-box-layout.js'
import { layoutTree, TREE_LABEL_STACK } from '../../src/tree-layout.js'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { TreeScope } from '../../src/tree-scope.js'
import { chooseTreeProjection } from '../../src/tree-readability.js'

const fleet = (count, fanout = count) => Array.from({ length: count }, (_, index) => ({
  id: `agent-${index}`, name: `Agent ${index}`,
  parentId: index ? `agent-${Math.floor((index - 1) / fanout)}` : null,
  state: ['running', 'finished', 'interrupted', 'draft'][index % 4],
}))

function freezeInput(nodes, edges = []) {
  nodes.forEach(Object.freeze)
  edges.forEach(Object.freeze)
  return { nodes: Object.freeze(nodes), edges: Object.freeze(edges) }
}

function assertSoundLayout(layout, nodes, { acyclic = true } = {}) {
  assert.deepEqual(new Set(layout.slots.keys()), new Set(nodes.map(node => node.id)), 'every agent gets one position')
  assert.equal(layout.culled.size, 0, 'layout must not silently discard agents')
  const positions = [...layout.slots.entries()]
  for (const [id, position] of positions) {
    assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y), `${id} has finite coordinates`)
    assert.ok(Number.isFinite(layout.radii.get(id)) && layout.radii.get(id) > 0)
  }
  for (let left = 0; left < positions.length; left++) {
    for (let right = left + 1; right < positions.length; right++) {
      const [leftId, a] = positions[left], [rightId, b] = positions[right]
      assert.ok(Math.abs(a.x - b.x) >= TREE_BOX.width || Math.abs(a.y - b.y) >= TREE_BOX.height,
        `${leftId} and ${rightId} must not overlap`)
    }
  }
  if (acyclic) {
    for (const [child, parent] of layout.parents) {
      assert.ok(layout.slots.get(child).y > layout.slots.get(parent).y, `${child} appears below ${parent}`)
    }
  }
}

for (const [W, H] of [[1600, 800], [680, 850], [360, 640]]) {
  test(`one through ten boxes remain complete and separated in a ${W}×${H} viewport`, () => {
    for (let count = 1; count <= 10; count++) {
      // Deep chains, wide siblings, and separate roots exercise distinct subtree shapes.
      for (const nodes of [fleet(count, 1), fleet(count, 3), fleet(count), fleet(count).map(node => ({ ...node, parentId: null }))]) {
        const original = structuredClone(nodes)
        const input = freezeInput(nodes)
        const first = layoutBoxTree({ ...input, W, H })
        assertSoundLayout(first, nodes)
        assert.deepEqual(layoutBoxTree({ ...input, W, H }), first, 'the same viewport and fleet give a stable arrangement')
        assert.deepEqual(nodes, original, 'automatic placement must not alter saved agents')
      }
    }
  })
}

test('empty fleets have a finite empty layout', () => {
  const layout = layoutBoxTree()
  assert.equal(layout.slots.size, 0)
  assert.equal(layout.rowYs.length, 0)
  assert.ok(Number.isFinite(layout.W) && Number.isFinite(layout.H))
})

test('declared hierarchy edges control depth while communication links leave independent roots intact', () => {
  const nodes = fleet(6).map(node => ({ ...node, parentId: null }))
  const edges = [
    { from: 'agent-0', to: 'agent-1', type: 'manages' },
    { from: 'agent-1', to: 'agent-2', type: 'delegates_to' },
    { from: 'agent-3', to: 'agent-4', type: 'hierarchy' },
    { from: 'agent-2', to: 'agent-5', type: 'communication' },
    { from: 'absent', to: 'agent-5', type: 'manages' },
  ]
  const original = structuredClone({ nodes, edges })
  const input = freezeInput(nodes, edges)
  const layout = layoutBoxTree({ ...input, W: 1200, H: 700 })
  assertSoundLayout(layout, nodes)
  assert.equal(layout.parents.get('agent-2'), 'agent-1')
  assert.equal(layout.parents.has('agent-5'), false)
  assert.equal(layout.slots.get('agent-0').y, layout.slots.get('agent-3').y)
  assert.equal(layout.slots.get('agent-3').y, layout.slots.get('agent-5').y)
  assert.deepEqual(layoutBoxTree({ nodes, edges: [...edges].reverse(), W: 1200, H: 700 }), layout,
    'edge arrival order does not change the hierarchy or positions')
  assert.deepEqual({ nodes, edges }, original)
})

test('cycles, self-parenting, and missing parents cannot strand boxes outside the layout', () => {
  const nodes = [
    { id: 'a', name: 'A', parentId: 'b' },
    { id: 'b', name: 'B', parentId: 'c' },
    { id: 'c', name: 'C', parentId: 'a' },
    { id: 'child', name: 'Child', parentId: 'b' },
    { id: 'missing', name: 'Missing parent', parentId: 'absent' },
    { id: 'self', name: 'Self parent', parentId: 'self' },
  ]
  const original = structuredClone(nodes)
  const layout = layoutBoxTree({ ...freezeInput(nodes), W: 900, H: 600 })
  assertSoundLayout(layout, nodes, { acyclic: false })
  assert.equal(layout.parents.has('missing'), false)
  assert.equal(layout.parents.has('self'), false)
  assert.deepEqual(nodes, original, 'repair belongs to the view, not the stored tree')
})

test('boxes delegate hierarchy, ordering, and subtree placement to the original spacious layout', () => {
  const nodes = fleet(7, 3)
  nodes[1].orderHint = 2
  nodes[2].orderHint = 1
  nodes[0].treeNode = { treeId: 'one' }
  const edges = [{ from: nodes[2].id, to: nodes[5].id, type: 'communication' }]
  for (const [W, H] of [[1600, 800], [680, 850]]) {
    const layout = layoutBoxTree({ nodes, edges, W, H })
    const footprint = Math.max(TREE_BOX.width, TREE_BOX.height)
    const original = layoutTree({
      nodes: nodes.map(node => ({ ...node, r: footprint / 2 })), edges, W,
      H: 320 + 2 * (footprint + TREE_LABEL_STACK + 7), spacious: true,
    })
    for (const field of ['parents', 'rowOf', 'culled', 'drillRequired', 'labels']) {
      assert.deepEqual(layout[field], original[field], `${field} preserves the original layout behavior`)
    }
    for (const [id, point] of original.slots) assert.equal(layout.slots.get(id).x, point.x,
      'horizontal subtree placement and sibling ordering are exactly the original layout')
    assert.ok([...original.radii.values()].every(radius => radius === footprint / 2), 'box footprints never shrink')
    assert.ok([...layout.radii.values()].every(radius => radius === TREE_BOX.height / 2), 'drawing metadata uses the box height')
  }
})

test('box ranks use their actual heights with consistent open lanes and matching drag/routing metadata', () => {
  for (const [contextSize, { box }] of Object.entries(TREE_CONTEXT_SIZES)) for (const ranks of [2, 3, 5, 10]) {
    const layout = layoutBoxTree({ nodes: fleet(ranks, 1), contextSize, W: 900, H: 700 })
    assert.equal(layout.rowYs.length, ranks)
    /* The lane is this size's OWN rowGap, read from the table, not the literal
       96 that used to be right by accident: rowGap was the same number on all
       four sizes until R1206 made spacing scale with the box. The property
       under test is unchanged -- every rank of a given size has the same clear
       lane -- and it is now checked against what that size actually declares. */
    for (let rank = 1; rank < ranks; rank++) assert.equal(layout.rowYs[rank] - layout.rowYs[rank - 1] - box.height, box.rowGap,
      `${contextSize} has the same clear connector lane on every rank`)
    for (const [id, point] of layout.slots) {
      assert.equal(point.y, layout.rowYs[layout.rowOf.get(id)], 'the slot and rank metadata cannot disagree')
      assert.equal(layout.radii.get(id), box.height / 2)
    }
    assert.equal(layout.minHeight, null, 'rectangle layout carries no stale circle-label height request')
  }
})

test('the original shared-bus renderer stays between the real box borders after rank spacing changes', () => {
  const nodes = fleet(40, 3)
  for (const [contextSize, { box }] of Object.entries(TREE_CONTEXT_SIZES)) {
    const layout = layoutBoxTree({ nodes, contextSize, W: 1200, H: 800 })
    const records = new Map(nodes.map(agent => [agent.id, { agent, ...layout.slots.get(agent.id), r: box.height / 2 }]))
    const graph = Object.assign(Object.create(StaticTreeGraph.prototype), { nodeStyle: 'boxes', cardSize: contextSize })
    for (const [childId, parentId] of layout.parents) {
      const parent = records.get(parentId), child = records.get(childId)
      const busY = (parent.y + child.y) / 2
      const route = graph._elbowRoute(parent, child, busY)
      assert.equal(route.segments[0].y1, parent.y + box.height / 2)
      assert.equal(route.segments.at(-1).y2, child.y - box.height / 2)
      for (const segment of route.segments) for (const other of records.values()) {
        const left = other.x - box.width / 2, right = other.x + box.width / 2
        const top = other.y - box.height / 2, bottom = other.y + box.height / 2
        const hits = segment.x1 === segment.x2
          ? segment.x1 > left && segment.x1 < right && Math.min(segment.y1, segment.y2) < bottom && Math.max(segment.y1, segment.y2) > top
          : segment.y1 > top && segment.y1 < bottom && Math.min(segment.x1, segment.x2) < right && Math.max(segment.x1, segment.x2) > left
        assert.equal(hits, false, 'hierarchy strokes cannot pass through any box interior')
      }
    }
  }
})

test('a viewport resize cannot wrap, reorder, or distort existing box branches', () => {
  const nodes = fleet(5, 2)
  const baseline = layoutBoxTree({ nodes, W: 560, H: 340 })
  for (const [W, H] of [[560, 1200], [1400, 340], [2600, 1200]]) {
    const layout = layoutBoxTree({ nodes, W, H })
    const dx = layout.slots.get(nodes[0].id).x - baseline.slots.get(nodes[0].id).x
    const dy = layout.slots.get(nodes[0].id).y - baseline.slots.get(nodes[0].id).y
    assert.deepEqual(layout.rowOf, baseline.rowOf)
    for (const node of nodes) {
      assert.deepEqual(layout.slots.get(node.id), {
        x: baseline.slots.get(node.id).x + dx, y: baseline.slots.get(node.id).y + dy,
      }, 'only translation may change when the available viewport changes')
    }
  }
})

test('each parent is centered above its first and last direct children', () => {
  const nodes = fleet(25, 3)
  const layout = layoutBoxTree({ nodes, W: 760, H: 480 })
  assertSoundLayout(layout, nodes)
  for (const parent of nodes) {
    const kids = nodes.filter(node => node.parentId === parent.id)
      .map(node => layout.slots.get(node.id)).sort((a, b) => a.x - b.x)
    if (!kids.length) continue
    assert.equal(layout.slots.get(parent.id).x, (kids[0].x + kids.at(-1).x) / 2)
    assert.ok(kids.every(kid => kid.y > layout.slots.get(parent.id).y))
  }
})

function componentBounds(layout, nodes, box = TREE_BOX) {
  const positions = nodes.map(node => layout.slots.get(node.id))
  return {
    left: Math.min(...positions.map(position => position.x - box.width / 2)),
    right: Math.max(...positions.map(position => position.x + box.width / 2)),
    top: Math.min(...positions.map(position => position.y - box.height / 2)),
    bottom: Math.max(...positions.map(position => position.y + box.height / 2)),
  }
}

for (const [W, H] of [[1600, 800], [680, 850], [360, 640]]) {
  test(`separate trees own disjoint complete regions in a ${W}×${H} viewport`, () => {
    const components = [[7, 1], [15, 15], [5, 2], [1, 1]].map(([count, fanout], index) =>
      fleet(count, fanout).map(node => ({
        ...node, id: `tree-${index}:${node.id}`, parentId: node.parentId ? `tree-${index}:${node.parentId}` : null,
        treeNode: { treeId: `tree-${index}` },
      })))
    // Input arrival order must not mix one tree's descendants into another tree.
    const nodes = Array.from({ length: 15 }, (_, index) => components.flatMap(component => component[index] || [])).flat()
    const edges = [{ from: components[0][2].id, to: components[1][4].id, type: 'communication' }]
    const original = structuredClone({ nodes, edges })
    const layout = layoutBoxTree({ ...freezeInput(nodes, edges), W, H })
    assertSoundLayout(layout, nodes)
    const bounds = components.map(component => componentBounds(layout, component))
    for (const [index, a] of bounds.entries()) for (const b of bounds.slice(index + 1)) {
      assert.ok(b.left - a.right >= TREE_BOX.gap || a.left - b.right >= TREE_BOX.gap
        || b.top - a.bottom >= TREE_BOX.rowGap || a.top - b.bottom >= TREE_BOX.rowGap,
      'each complete tree region has visible space from every other tree, on either axis')
    }
    assert.deepEqual(layoutBoxTree({ nodes, edges, W, H }), layout)
    assert.deepEqual(layoutBoxTree({ nodes: [...nodes].reverse(), edges, W, H }), layout,
      'the original hierarchy ordering stays stable when records arrive in a different order')
    assert.deepEqual({ nodes, edges }, original)
  })
}

test('four Large heads use two rows in a laptop split without reducing their footprints', () => {
  const nodes = Array.from({ length: 4 }, (_, index) => ({ id: `root-${index}`, name: `Tree ${index}`,
    parentId: null, treeNode: { treeId: `tree-${index}` } }))
  const W = 875, H = 856, box = TREE_CONTEXT_SIZES.large.box
  const layout = layoutBoxTree({ nodes, W, H, contextSize: 'large' })
  assert.equal(layout.slots.size, 4)
  assert.equal(new Set([...layout.slots.values()].map(point => point.x)).size, 2)
  assert.equal(layout.rowYs.length, 2)
  assert.deepEqual([...layout.rowOf.values()], [0, 0, 1, 1])
  const bounds = componentBounds(layout, nodes, box)
  assert.ok(Math.min((W - 20) / (bounds.right - bounds.left), (H - 20) / (bounds.bottom - bounds.top)) >= 0.9,
    'all four full-size heads fit above the text-readability floor')
  assert.ok([...layout.radii.values()].every(radius => radius === box.height / 2))
  assert.deepEqual(layoutBoxTree({ nodes: [...nodes].reverse(), W, H, contextSize: 'large' }), layout)
  const wide = layoutBoxTree({ nodes, W: 3000, H, contextSize: 'large' })
  assert.equal(wide.rowYs.length, 1, 'a naturally readable forest does not gain unnecessary rows')
})

test('packed forest rows preserve every internal subtree delta and synchronize all rank metadata', () => {
  const components = [[5, 1], [7, 3], [3, 2], [4, 1]].map(([count, fanout], index) =>
    fleet(count, fanout).map(node => ({ ...node, id: `${index}:${node.id}`,
      parentId: node.parentId ? `${index}:${node.parentId}` : null, treeNode: { treeId: `tree-${index}` } })))
  const nodes = components.flat()
  for (const [contextSize, { box }] of Object.entries(TREE_CONTEXT_SIZES)) {
    const layout = layoutBoxTree({ nodes, W: 875, H: 1400, contextSize })
    const footprint = Math.max(box.width, box.height)
    const options = { nodes: nodes.map(node => ({ ...node, r: footprint / 2 })), W: 875, spacious: true }
    const rows = layoutTree({ ...options, H: 320 }).rowYs.length
    const original = layoutTree({ ...options, H: 320 + (rows - 1) * (footprint + TREE_LABEL_STACK + 7) })
    for (const component of components) {
      const anchor = component[0].id
      const dx = layout.slots.get(anchor).x - original.slots.get(anchor).x
      const rankDelta = layout.rowOf.get(anchor) - original.rowOf.get(anchor)
      for (const node of component) {
        assert.ok(Math.abs(layout.slots.get(node.id).x - original.slots.get(node.id).x - dx) < 1e-9,
          'packing translates the whole tree without changing parent centering or sibling order')
        assert.equal(layout.rowOf.get(node.id) - original.rowOf.get(node.id), rankDelta)
        assert.equal(layout.slots.get(node.id).y, layout.rowYs[layout.rowOf.get(node.id)])
      }
    }
    assert.deepEqual(layout.parents, original.parents)
    assert.deepEqual(layout.labels, original.labels)
    const records = new Map(nodes.map(agent => [agent.id, { agent, ...layout.slots.get(agent.id), r: box.height / 2 }]))
    const graph = Object.assign(Object.create(StaticTreeGraph.prototype), { nodeStyle: 'boxes', cardSize: contextSize })
    for (const [childId, parentId] of layout.parents) {
      const parent = records.get(parentId), child = records.get(childId)
      const route = graph._elbowRoute(parent, child, (parent.y + child.y) / 2)
      for (const segment of route.segments) for (const other of records.values()) {
        const left = other.x - box.width / 2, right = other.x + box.width / 2
        const top = other.y - box.height / 2, bottom = other.y + box.height / 2
        const hits = segment.x1 === segment.x2
          ? segment.x1 > left && segment.x1 < right && Math.min(segment.y1, segment.y2) < bottom && Math.max(segment.y1, segment.y2) > top
          : segment.y1 > top && segment.y1 < bottom && Math.min(segment.x1, segment.x2) < right && Math.max(segment.x1, segment.x2) > left
        assert.equal(hits, false, 'translated shared-bus strokes never cross a box in either forest row')
      }
    }
  }
})

test('adaptive projection keeps four named dense-tree heads when a split has room for them', () => {
  const nodes = Array.from({ length: 4 }, (_, tree) => fleet(15, 3).map(node => ({
    ...node, id: `${tree}:${node.id}`, parentId: node.parentId ? `${tree}:${node.parentId}` : null,
    treeNode: { treeId: `tree-${tree}` },
  }))).flat()
  const projection = chooseTreeProjection({ scope: new TreeScope(nodes), W: 875, H: 856,
    nodeStyle: 'boxes', contextSize: 'large' })
  for (const root of nodes.filter(node => !node.parentId)) {
    const shown = projection.agents.find(agent => agent.id === root.id)
    assert.ok(shown, 'space for a named head must not become an anonymous whole-tree group')
    assert.equal(shown.treeScope.summary.total, 15)
    assert.equal(shown.treeScope.group, false)
  }
})

test('connection ports meet the rectangle perimeter in every direction and at each scale', () => {
  const from = Object.freeze({ x: 73, y: -41 })
  for (const scale of [0.5, 1, 1.75]) {
    const halfWidth = TREE_BOX.width * scale / 2, halfHeight = TREE_BOX.height * scale / 2
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-2, 3], [4, -1], [-1, -4]]) {
      const port = boxPort(from, { x: from.x + dx, y: from.y + dy }, scale)
      const x = port.x - from.x, y = port.y - from.y
      assert.ok(Number.isFinite(x) && Number.isFinite(y))
      assert.ok(Math.abs(x) <= halfWidth + 1e-9 && Math.abs(y) <= halfHeight + 1e-9)
      assert.ok(Math.abs(Math.abs(x) - halfWidth) < 1e-9 || Math.abs(Math.abs(y) - halfHeight) < 1e-9,
        'port lies on an edge of the box')
      assert.ok(Math.abs(x * dy - y * dx) < 1e-9, 'port follows the target direction')
      assert.ok(x * dx + y * dy > 0, 'port points toward the target')
    }
  }
  assert.deepEqual(boxPort(from, from), from, 'coincident points produce finite coordinates')
})

test('tree style defaults safely and preserves the explicit classic-circle preference', () => {
  const seen = []
  for (const [value, expected] of [[null, 'boxes'], ['boxes', 'boxes'], ['circles', 'circles'], ['obsolete', 'boxes']]) {
    assert.equal(readTreeStyle({ getItem(key) { seen.push(key); return value } }), expected)
  }
  assert.deepEqual(seen, Array(4).fill(TREE_STYLE_KEY))
  assert.equal(readTreeStyle(null), 'boxes')
  assert.equal(readTreeStyle({ getItem() { throw new Error('storage unavailable') } }), 'boxes')
})

/* R1206: SPACING SCALES WITH THE BOX, INSTEAD OF BEING ONE LITERAL FOR ALL.
 * `contextSize(...)` built every profile with `gap: 36, rowGap: 96`, so the
 * space between cards never moved while the cards ranged 244->420 wide and
 * 120->320 tall. Large was the proportionally TIGHTEST of the four, which is
 * where "the bubbles bunch up too much" lands. These check the property, not
 * the four numbers: pinning 27/32/36/47 here would fail against a better
 * scale and the quickest way green would be to put the literals back. */
test('every size declares its own spacing, not one literal shared by all', () => {
  const boxes = Object.values(TREE_CONTEXT_SIZES).map(profile => profile.box)
  assert.ok(new Set(boxes.map(box => box.gap)).size > 1,
    'every size shares one `gap` again. That is the defect R1206 names: absolute spacing that never '
    + 'changes with card size, so the largest card is the most crowded.')
  assert.ok(new Set(boxes.map(box => box.rowGap)).size > 1,
    'every size shares one `rowGap` again')
})

test('a bigger box always gets more room around it, never less', () => {
  const byWidth = Object.values(TREE_CONTEXT_SIZES).map(p => p.box).sort((a, b) => a.width - b.width)
  for (let i = 1; i < byWidth.length; i++) {
    assert.ok(byWidth[i].gap > byWidth[i - 1].gap,
      `a ${byWidth[i].width}px box gets ${byWidth[i].gap}px of gap where a narrower ${byWidth[i - 1].width}px box gets `
      + `${byWidth[i - 1].gap}px. Spacing must not go backwards as cards grow.`)
  }
  const byHeight = Object.values(TREE_CONTEXT_SIZES).map(p => p.box).sort((a, b) => a.height - b.height)
  for (let i = 1; i < byHeight.length; i++) {
    assert.ok(byHeight[i].rowGap > byHeight[i - 1].rowGap,
      `a ${byHeight[i].height}px-tall box gets ${byHeight[i].rowGap}px between rows where a shorter `
      + `${byHeight[i - 1].height}px one gets ${byHeight[i - 1].rowGap}px`)
  }
})

test('compact sizes retain the established horizontal and vertical spacing proportions', () => {
  const medium = TREE_CONTEXT_SIZES.medium.box
  assert.equal(medium.gap, 36, 'Medium is the anchor the other three are derived from; its shipped gap moved')
  assert.equal(medium.rowGap, Math.round(medium.height * 96 / 224), 'vertical spacing follows the compact height')
  for (const [name, { box }] of Object.entries(TREE_CONTEXT_SIZES)) {
    /* Within 1px: these are whole pixels, so rounding is the only slack allowed. */
    assert.ok(Math.abs(box.gap - box.width * (medium.gap / medium.width)) <= 1,
      `${name}'s gap (${box.gap}) is not Medium's proportion of its own ${box.width}px box `
      + `(${(box.width * (medium.gap / medium.width)).toFixed(1)}). A size spaced to taste is the thing this replaced.`)
    assert.ok(Math.abs(box.rowGap - box.height * (medium.rowGap / medium.height)) <= 1,
      `${name}'s rowGap (${box.rowGap}) is not Medium's proportion of its own ${box.height}px box `
      + `(${(box.height * (medium.rowGap / medium.height)).toFixed(1)})`)
  }
})
