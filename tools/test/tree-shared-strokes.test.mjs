import assert from 'node:assert/strict'
import test from 'node:test'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { mergeTreeStrokeRoutes } from '../../src/tree-stroke-paths.js'
import { Element, installDomStandIn } from './lib/dom-stand-in.mjs'

test('shared hierarchy strokes paint once while preserving every rounded route and edge identity', () => {
  const { document, restore } = installDomStandIn()
  document.createElementNS = (_namespace, tag) => document.createElement(tag)
  try {
    const root = { id: 'root', x: 300, y: 50, r: 20, agent: { id: 'root' } }
    const children = [100, 200, 300, 400, 500].map((x, index) => ({ id: `child-${index}`, x, y: 300, r: 20,
      agent: { id: `child-${index}`, parentId: 'root' } }))
    const nodes = new Map([root, ...children].map(record => [record.id, record]))
    const subject = Object.assign(Object.create(StaticTreeGraph.prototype), {
      svg: new Element('svg'), nodes, _culled: new Set(), _layoutVisibleIds: new Set(nodes.keys()),
      spacious: false, declaredEdges: [{ from: 'child-0', to: 'child-4', type: 'reviews' }],
      emptySlots: new Map([['empty', { id: 'empty', parentId: 'root', x: 600, y: 300, r: 34 }]]),
      _renderCommunicationLinks(paintable) { assert.equal(paintable(root), true) },
    })
    subject._renderLinks()
    const painted = subject.svg.querySelectorAll('.tree-link')
    assert.deepEqual(painted.map(element => element.getAttribute('data-edge-style')), ['hierarchy', 'soft', 'empty'])
    assert.equal(painted[0].getAttribute('data-edge-count'), '5')
    assert.equal((painted[0].getAttribute('d').match(/M 300 70 L/g) || []).length, 1, 'the shared parent trunk is painted only once')
    assert.match(painted[0].getAttribute('d'), /\bQ /, 'rounded elbows are retained')
    for (const element of painted) assert.equal(element.getAttribute('vector-effect'), 'non-scaling-stroke')
    const routes = subject.svg.querySelector('.tree-link-routes')
    assert.equal(routes.tagName, 'DEFS', 'individual routes are diagnostics, not additional painted strokes')
    assert.equal(routes.children.length, 7)
    assert.deepEqual(routes.children.map(route => [route.getAttribute('data-from'), route.getAttribute('data-to'), route.getAttribute('data-edge-type')]), [
      ...children.map(child => ['root', child.id, 'hierarchy']), ['child-0', 'child-4', 'reviews'], ['root', 'empty', 'empty'],
    ])
    assert.equal(subject._linkSegments.length, 16, 'hierarchy and empty routes still supply the same collision obstacles')
    assert.equal(painted[1].classList.contains('link-soft'), true)
    assert.equal(painted[2].classList.contains('link-empty'), true)
  } finally { restore() }
})

test('stroke union merges partial and reversed intervals without bridging gaps or changing curves', () => {
  const result = mergeTreeStrokeRoutes([
    'M 10 0 L 10 40 Q 10 50 20 50 L 80 50',
    'M 10 20 L 10 40 Q 10 50 20 50 L 100 50',
    'M 10 60 L 10 30',
    'M 10 90 L 10 80',
    'M 20 50 Q 10 50 10 40',
  ])
  assert.match(result, /M 10 0 L 10 60/)
  assert.match(result, /M 10 80 L 10 90/)
  assert.match(result, /M 20 50 L 100 50/)
  assert.equal((result.match(/\bQ /g) || []).length, 1)
  assert.doesNotMatch(result, /M 10 0 L 10 90/)
})
