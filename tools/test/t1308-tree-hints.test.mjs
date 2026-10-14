import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { installWorld, fleetFetch, settle } from './lib/tree-command-real-mount.mjs'

async function mountedGraph(t, count, options = {}) {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  const wrap = document.createElement('div')
  wrap.className = 'graph-canvas-slot'
  const canvas = document.createElement('div')
  canvas.className = 'computer-tree-canvas'
  wrap.appendChild(canvas); document.body.appendChild(wrap)
  let graph
  t.after(() => { try { graph?.destroy(); wrap.remove() } finally { world.restore() } })
  graph = new StaticTreeGraph(canvas, {
    computer: { id: 'hint-fixture', name: 'Hint fixture', agents: Array.from({ length: count }, (_, i) => ({
      id: 'agent-' + i, name: 'Agent ' + i, role: i ? 'worker' : 'controller', parentId: i ? 'agent-0' : null, state: 'draft',
    })) }, emptySlots: false, ...options,
  })
  await settle()
  return graph
}

for (const count of [0, 1, 2]) {
  test('mounted normal and hidden-card hints use the correct noun for ' + count + ' agents', async t => {
    const graph = await mountedGraph(t, count, { nodeStyle: 'boxes' })
    graph._placeChips()
    assert.ok(graph.panHint)
    assert.match(graph.panHint.textContent, new RegExp('^' + count + ' ' + (count === 1 ? 'agent' : 'agents') + '(?: ·|$)'))
    graph.setNodeStyle('circles')
    graph.setCircleCards(false)
    graph._placeChips()
    assert.match(graph.panHint.textContent, new RegExp('^' + count + ' ' + (count === 1 ? 'agent' : 'agents') + ' · Cards hidden'))
  })
}
for (const count of [1, 2]) {
  test('mounted Edit and view-count hints use the correct noun for ' + count + ' agents', async t => {
    const graph = await mountedGraph(t, count, { nodeStyle: 'circles', screenChips: true })
    graph.setEditMode(true)
    graph._placeChips()
    assert.match(graph.panHint.textContent, new RegExp('^' + count + ' ' + (count === 1 ? 'agent' : 'agents') + ' · Complete structure'))
    graph.setEditMode(false)
    graph.setCircleCards(true)
    graph.fitCurrentTree()
    graph._placeChips()
    assert.match(graph.panHint.textContent, new RegExp('^[0-9]+ of ' + count + ' ' + (count === 1 ? 'agent' : 'agents') + ' in view'))
  })
}

test('FIX-C 11: the pan hint steps aside while a node card sits under it, and returns when the card moves off', async t => {
  const graph = await mountedGraph(t, 2, { nodeStyle: 'boxes' })
  const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top })
  graph.panHint.getBoundingClientRect = () => rect(12, 700, 320, 20)
  const [controller, worker] = [...graph.nodes.values()]
  controller.el.getBoundingClientRect = () => rect(0, 0, 200, 100)
  worker.el.getBoundingClientRect = () => rect(100, 650, 260, 120)
  graph._syncPanHintCover()
  assert.equal(graph.panHint.hasAttribute('data-covered'), true, 'a card under the hint did not send it aside: its status row is hidden')
  worker.el.getBoundingClientRect = () => rect(100, 400, 260, 120)
  graph._syncPanHintCover()
  assert.equal(graph.panHint.hasAttribute('data-covered'), false, 'the hint stayed hidden after the card moved off it')
  graph.panHint.getBoundingClientRect = () => rect(0, 0, 0, 0)
  worker.el.getBoundingClientRect = () => rect(0, 0, 260, 120)
  graph._syncPanHintCover()
  assert.equal(graph.panHint.hasAttribute('data-covered'), false, 'an unmeasurable hint is never treated as covered')
  const css = (await import('node:fs')).readFileSync(new URL('../../src/tree-graph.css', import.meta.url), 'utf8')
  assert.match(css, /\.tree-pan-hint\[data-covered\]\s*\{[^}]*visibility:\s*hidden/, 'the covered state has no style, so the attribute hides nothing')
})
