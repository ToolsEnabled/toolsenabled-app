/* EVERY TREE MUST CLEAR A FOCUSED BRANCH -- owner bug UI-1.
 *
 * Reproduced by the operator on dev app 6909208e: focus the controller of the
 * second tree, move its four Claude children onto the first tree with the
 * Reports-to picker, then press Every tree. The canvas kept showing only that
 * one controller while 22 nodes were saved, and the machine breadcrumb -- which
 * calls the same clearRoot() -- restored the forest.
 *
 * The data layer was measured innocent before anything was changed: TreeScope
 * .project(null) returns both forest roots, and StaticTreeGraph.visibleAgents()
 * returns the whole forest once rootId is null. Rooted at a controller whose
 * children have all moved away it returns exactly that one circle -- which is
 * the screen the operator described. So the root was never cleared, and the one
 * thing that puts a cleared root back is reprojectFromOrg's restore after a
 * save. drillRootAfterReprojection is that decision, pulled out where it can be
 * tested directly.
 *
 * Assertions here stay on strings and booleans. Comparing a DOM stand-in node
 * with assert.deepEqual makes the failure diff walk a circular proxy.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { fleetFetch, installWorld, settle, COMPUTER_ID } from './lib/tree-command-real-mount.mjs'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
register('./helpers/css-stub-loader.mjs', import.meta.url)

/* Loaded AFTER register(), because a static import is hoisted above it and the
   view imports stylesheets the stub loader is there to answer. */
const { computersView, drillRootAfterReprojection } = await import('../../src/views/computers.js')

const AT = '2026-09-06T04:51:00.000Z'
const node = (id, treeId, parentId, role) => ({
  id, treeId, status: 'starting', createdAt: AT, updatedAt: AT,
  role, message: '', statusNote: '', sessionId: null, parentId,
})

/* The operator's shape: tree-1 holds a controller and sixteen workers, tree-2
   holds a controller and the four Claude children that are about to move. */
function seedTwoTrees(storage) {
  const nodes = [node('c1', 'tree-1', null, 'controller')]
  for (let i = 1; i <= 16; i++) nodes.push(node('w' + i, 'tree-1', 'c1', 'builder'))
  nodes.push(node('c2', 'tree-2', null, 'controller'))
  for (let i = 1; i <= 4; i++) nodes.push(node('claude' + i, 'tree-2', 'c2', 'builder'))
  storage.setItem(fleetTreesStorageKey(COMPUTER_ID), JSON.stringify({
    version: 1, computerId: COMPUTER_ID,
    trees: [
      { id: 'tree-1', name: null, createdAt: AT, updatedAt: AT, profileId: null },
      { id: 'tree-2', name: null, createdAt: AT, updatedAt: AT, profileId: null },
    ],
    nodes,
  }))
}

test('a reprojection does not restore a drill-in root the save just emptied', () => {
  const before = [
    { id: 'c2', parentId: null }, { id: 'claude1', parentId: 'c2' }, { id: 'claude2', parentId: 'c2' },
    { id: 'c1', parentId: null },
  ]
  const after = [
    { id: 'c2', parentId: null }, { id: 'claude1', parentId: 'c1' }, { id: 'claude2', parentId: 'c1' },
    { id: 'c1', parentId: null },
  ]
  assert.equal(drillRootAfterReprojection('c2', before, after), null,
    'the focused controller lost every child to another tree, so restoring it would hide the forest')
  assert.equal(drillRootAfterReprojection('c1', before, after), 'c1',
    'a root that gained children is still worth restoring')
})

test('a reprojection keeps a drill-in root the person chose deliberately', () => {
  const leaf = [{ id: 'c1', parentId: null }, { id: 'w1', parentId: 'c1' }]
  assert.equal(drillRootAfterReprojection('w1', leaf, leaf), 'w1',
    'a leaf focused on purpose was never emptied and must survive a save')
  assert.equal(drillRootAfterReprojection('c1', leaf, leaf), 'c1',
    'an unchanged branch survives a save')
  assert.equal(drillRootAfterReprojection('gone', leaf, leaf), null,
    'a root no longer in the record is not restored')
  assert.equal(drillRootAfterReprojection(null, leaf, leaf), null,
    'no drill-in root means nothing to restore')
  assert.equal(drillRootAfterReprojection('c1', [], []), null,
    'a root absent from the new record is not restored even with no history')
})

test('the machine breadcrumb clears a focused branch and restores the forest, keeping the selection', async (t) => {
  const world = await installWorld(fleetFetch())
  /* The shared stand-in runs RAF synchronously; a real branch transition stores
     the frame id before its callback runs, as browsers do. */
  const frames = new Map()
  let nextFrame = 0
  globalThis.requestAnimationFrame = callback => {
    const id = ++nextFrame
    frames.set(id, setTimeout(() => { frames.delete(id); callback(performance.now()) }, 0))
    return id
  }
  globalThis.cancelAnimationFrame = id => { clearTimeout(frames.get(id)); frames.delete(id) }
  let view
  t.after(() => {
    try { view?.destroy() } finally {
      for (const timer of frames.values()) clearTimeout(timer)
      world.restore()
    }
  })
  seedTwoTrees(world.storage)
  view = computersView({ initialComputer: COMPUTER_ID, navigate() {} })
  globalThis.document.body.appendChild(view.el)
  await settle()

  const graph = globalThis.window.__mcGraph
  assert.ok(graph, 'the mounted view must expose its graph')
  const everyTree = view.el.querySelector('[data-fleet-show-all]')
  assert.ok(everyTree, 'the fleet overview must offer an Every tree control')
  // Readable projections may draw an explicit group for several siblings.
  // Expand only those groups; an ordinary parent must not stand in for
  // descendants that the current projection has actually lost.
  const visible = () => [...new Set(graph.visibleAgents().flatMap(agent =>
    agent.treeScope?.group ? graph._scopeModel().branch(agent.id) : [agent.id]))].sort()
  assert.ok(visible().includes('c1') && visible().includes('c2'),
    'both saved trees are drawn before anything is focused')

  graph.select('c2')
  graph.setRoot('c2')
  await settle()
  assert.equal(graph.rootId, 'c2', 'focusing the second controller sets the graph root')
  assert.deepEqual(visible(), ['c2', 'claude1', 'claude2', 'claude3', 'claude4'].sort(),
    'a focused branch draws only that branch')
  assert.equal(everyTree.getAttribute('aria-pressed'), 'false',
    'Every tree reads as not pressed while a branch is focused')

  // The shared workspace's former Every tree button now opens Choose trees.
  // The machine breadcrumb remains the direct action for clearing a branch.
  assert.equal(everyTree.textContent, 'Choose trees')
  const machine = view.el.querySelector('.graph-crumb button')
  assert.ok(machine, 'a focused branch must offer its machine breadcrumb')
  machine.dispatchEvent({ type: 'click', detail: 1 })
  await settle()

  assert.equal(graph.rootId, null, 'Every tree must clear the focused graph branch')
  const after = visible()
  assert.ok(after.includes('c1'), 'the other tree comes back')
  assert.ok(after.includes('c2'), 'the focused tree is still drawn')
  assert.equal(graph._scopeModel().summary('c1').total, 17, 'the first root still represents its complete branch')
  assert.equal(graph._scopeModel().summary('c2').total, 5, 'the second root still represents its complete branch')
  assert.equal(everyTree.getAttribute('aria-pressed'), 'true',
    'Every tree reads as pressed once no branch is focused')
  assert.equal(graph.selectedId, 'c2',
    'clearing the branch must not drop the selected agent or its conversation')
})
