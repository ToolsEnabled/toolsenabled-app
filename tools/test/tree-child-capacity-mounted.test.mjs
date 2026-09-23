// UI-2, at the MOUNTED view: the "+" the person can actually see must not be
// offered under a parent that is already at its live-child cap.
//
// The store-seam half of this bug lives in tree-child-capacity-affordance.test.mjs
// (a queue of drafts started past the cap and the roster held 11 live children
// against a cap of 8). This file is the other half the operator asked for: the
// affordance as it is really drawn, through the real view, the real tree store
// and the real graph, with only DOM and engine bridges substituted.
//
// The seam under test is computers.js extensionPoints(), which asks
// treeStore.extensionPoints() rather than keeping its own copy of the rule, and
// tree-graph.js, which draws one `.tree-empty-node[data-empty-kind="child"]`
// per offered position carrying the parent it belongs to.

import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { fleetTreesStorageKey, TREE_BOUNDS } from '../../src/fleet-trees.js'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, mountView, settle, COMPUTER_ID } = await import('./lib/tree-command-real-mount.mjs')

const STAMP = '2026-09-09T00:00:00.000Z'
const PARENT = 'mounted-capacity-parent'

/* One tree: a parent with `liveChildren` children already occupying seats. */
function seedFullParent(storage, liveChildren) {
  const nodes = [{
    id: PARENT, treeId: 'tree-1', status: 'running', createdAt: STAMP, updatedAt: STAMP,
    role: 'manager', message: '', statusNote: '', sessionId: 'session-parent', parentId: null,
  }]
  for (let index = 0; index < liveChildren; index += 1) {
    nodes.push({
      id: `mounted-capacity-child-${index}`, treeId: 'tree-1', status: 'starting',
      createdAt: STAMP, updatedAt: STAMP, role: 'builder', message: '', statusNote: '',
      sessionId: null, parentId: PARENT,
    })
  }
  storage.setItem(fleetTreesStorageKey(COMPUTER_ID), JSON.stringify({
    version: 1, computerId: COMPUTER_ID,
    trees: [{ id: 'tree-1', name: null, createdAt: STAMP, updatedAt: STAMP, profileId: null }],
    nodes,
  }))
}

/* Count only slots offered UNDER this parent. Never assert on a DOM node
   itself: a failing deepEqual against the stand-in walks a circular proxy. */
const childSlotsUnderParent = view => view.el.querySelectorAll('.tree-empty-node')
  .filter(button => button.dataset.emptyKind === 'child' && button.dataset.parentId === PARENT)
  .length

async function mountedCircles(t, liveChildren, settings = null, prepare = null) {
  const world = await installWorld(fleetFetch())
  const priorComputedStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, writable: true,
    value: globalThis.window.getComputedStyle })
  const frames = new Map()
  let sequence = 0, view
  globalThis.requestAnimationFrame = callback => {
    const id = ++sequence
    frames.set(id, setTimeout(() => { frames.delete(id); callback(performance.now()) }, 0))
    return id
  }
  globalThis.cancelAnimationFrame = id => { clearTimeout(frames.get(id)); frames.delete(id) }
  t.after(() => {
    try { view?.destroy() } finally {
      for (const timer of frames.values()) clearTimeout(timer)
      world.restore()
      if (priorComputedStyle) Object.defineProperty(globalThis, 'getComputedStyle', priorComputedStyle)
      else delete globalThis.getComputedStyle
    }
  })
  if (settings) globalThis.window.mcSettings = settings
  seedFullParent(world.storage, liveChildren)
  prepare?.(world)
  view = await mountView(world)
  const graph = globalThis.window.__mcGraph
  assert.ok(graph, 'The mounted fleet must load: ' + view.el.querySelector('.graph-empty-reason')?.textContent)
  // Box viewing mode keeps child creation in its action menu. Exercise the
  // visible circle placeholders this regression was written for explicitly.
  graph.setNodeStyle('circles')
  return view
}

test('the drawn plus is withheld under a parent already at its live-child cap', async t => {
  const view = await mountedCircles(t, TREE_BOUNDS.maxChildren)

  const offered = childSlotsUnderParent(view)
  assert.equal(offered, 0,
    `the view drew ${offered} child placeholder(s) under a parent that already holds ${TREE_BOUNDS.maxChildren} live children; `
    + 'pressing one costs the person a role and a written brief before anything tells them no')
})

test('and it is still drawn while that parent has room, so the guard is not vacuous', async t => {
  const view = await mountedCircles(t, TREE_BOUNDS.maxChildren - 1)

  const offered = childSlotsUnderParent(view)
  assert.ok(offered > 0,
    `one seat below the cap the view offered ${offered} child placeholders; if this is 0 the test above passes for the wrong reason `
    + '(no slot is ever drawn) and neither assertion is measuring the cap')
})

/* THE OTHER SIDE OF THE 2026-09-11 WIDTH DECISION. The cap fell from eight to
   four, and the owner's saved trees have parents with eight to fourteen live
   children. Such a tree is not broken: the real view must still load it and
   account for every child it holds, and simply offer no "+" under that parent.
   A narrow canvas folds a wide rank into group circles ("3 agents") -- the
   readability rule in src/tree-scope.js, unchanged by the cap -- so a child
   counts as drawn when it has its own circle OR sits inside a drawn group. */
test('a parent saved with more live children than the cap still draws every one, and offers no plus', async t => {
  const overCap = 14
  assert.ok(overCap > TREE_BOUNDS.maxChildren, 'the fixture must be over the cap to measure anything')
  const view = await mountedCircles(t, overCap)
  const graph = globalThis.window.__mcGraph
  const shown = new Set()
  for (const id of graph.nodes.keys()) {
    const group = graph._treeScope?.groups.get(id)
    for (const member of group ? group.memberIds : [id]) shown.add(member)
  }
  const childIds = Array.from({ length: overCap }, (_x, index) => `mounted-capacity-child-${index}`)
  const missing = childIds.filter(id => !shown.has(id))
  assert.deepEqual(missing, [], `the view lost ${missing.length} of the ${overCap} saved children on load`)
  assert.ok(graph.nodes.has(PARENT), 'the over-cap parent itself is not drawn')
  const offered = childSlotsUnderParent(view)
  assert.equal(offered, 0, `the view offered ${offered} child placeholder(s) under a parent already past the cap`)
})


// The DOM stand-in lacks unanchored child combinators. Resolve precisely the
// real renderer's direct child here; all view/store/render methods stay real.
function supportBoxBody(graph) {
  for (const record of graph.nodes.values()) {
    const query = record.el.querySelector.bind(record.el)
    record.el.querySelector = selector => selector === '.tree-box-context > p'
      ? query('.tree-box-context')?.children.find(child => child.tagName === 'P') || null
      : query(selector)
  }
}

test('82-node forest streamed and unchanged box refreshes do not read slot settings or rebuild forest offers', async t => {
  let reads = 0
  await mountedCircles(t, 81, { treeSlots() { reads++; return { ok: true, bounds: { maxChildren: 4, maxDepth: 3 } } } })
  const graph = window.__mcGraph
  graph.setNodeStyle('boxes')
  supportBoxBody(graph)
  const records = [...graph.nodes.values()].filter(row => row.agent.treeNode)
  assert.equal(graph.computer.agents.filter(row => row.treeNode).length, 82, 'the mounted view must hold the measured-size saved forest')
  assert.ok(records.length > 0, 'normal collapsed viewing must still render an actual agent box')
  let response = 'Initial public reply'
  graph.contextFeed = () => ({ chat: response, current: 'Working' })
  graph._reconcile()
  const keys = records.map(row => row.boxPreviewKey)
  const readOffers = graph.extensionPoints
  let offerReads = 0
  graph.extensionPoints = () => { offerReads++; return readOffers() }
  reads = 0
  for (const row of records) graph.refreshChip(row.id)
  assert.equal(reads, 0, 'unchanged stream refresh must not re-read synchronous slot settings')
  assert.deepEqual(records.map(row => row.boxPreviewKey), keys)
  response = 'Latest public reply'
  for (const row of records) graph.refreshChip(row.id)
  assert.equal(reads, 0, 'changed public text must not re-read synchronous slot settings')
  assert.equal(offerReads, 0, 'streaming must not recalculate the forest offer set')
  graph._reconcile()
  assert.equal(offerReads, 1, 'the next full render recalculates the actual forest exactly once')
  assert.equal(reads, 1)
  for (const row of records) {
    assert.equal(row.el.querySelector('.tree-box-context > p').textContent, response)
    assert.notEqual(row.boxPreviewKey, keys[records.indexOf(row)])
  }
})

test('mounted capacity redraw invalidates on changed and unreadable settings without changing preview text', async t => {
  let reads = 0, bounds = { maxChildren: 4, maxDepth: 3 }
  const view = await mountedCircles(t, 1, { treeSlots() { reads++; return bounds ? { ok: true, bounds } : { ok: false } } })
  const graph = window.__mcGraph
  assert.ok(childSlotsUnderParent(view) > 0)
  bounds = { maxChildren: 1, maxDepth: 3 }
  reads = 0
  graph._reconcile()
  assert.equal(reads, 1, 'a complete reconcile uses one fresh bounds read, independent of node count')
  assert.equal(childSlotsUnderParent(view), 0, 'settings changes redraw circle offers even with unchanged tree geometry')
  graph.setNodeStyle('boxes'); supportBoxBody(graph)
  graph.contextFeed = () => ({ chat: 'Preserve this reply' })
  bounds = { maxChildren: 2, maxDepth: 3 }
  graph._reconcile()
  const row = graph.nodes.get(PARENT), button = row.el.querySelector('.tree-box-add-agent')
  assert.equal(button.hidden, false)
  bounds = null
  graph._reconcile()
  assert.equal(button.hidden, true, 'unreadable settings cannot retain the prior rendered allowance')
  assert.equal(row.el.querySelector('.tree-box-context > p').textContent, 'Preserve this reply')
  bounds = { maxChildren: 2, maxDepth: 0 }
  graph._reconcile()
  assert.equal(button.hidden, true, 'depth zero refuses child offers')
  bounds = { maxChildren: 2, maxDepth: 1 }
  graph._reconcile()
  assert.equal(button.hidden, false, 'recovered settings restore the actual available offer')
})


test('mounted structural publication and tree switching replace captured capacity in both panes', async t => {
  let bounds = { maxChildren: 2, maxDepth: 3 }
  await mountedCircles(t, 2, { treeSlots: () => ({ ok: true, bounds }) })
  const graph = window.__mcGraph, childId = 'mounted-capacity-child-0'
  assert.equal(graph._canExtend({ id: PARENT }), false)
  assert.equal(graph.onDetachToNewTree(childId), true, 'actual view/store move must publish the new forest')
  assert.equal(graph._canExtend({ id: PARENT }), true, 'publication refreshes the parent that lost a child')
  assert.equal(graph.computer.agents.find(row => row.id === childId).parentId, null)
  const board = graph.treeWindows
  bounds = { maxChildren: 2, maxDepth: 0 }
  board.choose(board.windows[0], childId)
  assert.equal(graph._canExtend({ id: childId }), false, 'tree switch captures current settings')
  board.add(PARENT)
  const second = board.windows[1].graph
  assert.equal(second.extensionPoints, graph.extensionPoints, 'secondary canvas forwards the actual store reader')
  assert.equal(second._canExtend({ id: PARENT }), false)
  bounds = { maxChildren: 2, maxDepth: 3 }
  graph.refresh()
  assert.equal(second._canExtend({ id: PARENT }), true, 'normal board refresh invalidates both panes')
})

test('returning to the mounted tree after a settings change reads fresh bounds', async t => {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  globalThis.getComputedStyle = window.getComputedStyle
  let view, bounds = { maxChildren: 4, maxDepth: 3 }
  window.mcSettings = { treeSlots: () => ({ ok: true, bounds }) }
  t.after(() => {
    try { view?.destroy() } finally {
      world.restore()
      if (previous) Object.defineProperty(globalThis, 'getComputedStyle', previous)
      else delete globalThis.getComputedStyle
    }
  })
  seedFullParent(world.storage, 1)
  view = await mountView(world)
  const oldGraph = window.__mcGraph
  assert.equal(oldGraph._canExtend({ id: PARENT }), true)
  // Navigation out to Settings destroys this view; returning/reloading mounts
  // it again. Substitute only the native bridge's newly saved answer.
  view.destroy(); view.el.remove()
  bounds = { maxChildren: 1, maxDepth: 3 }
  view = await mountView(world)
  const next = window.__mcGraph
  assert.notEqual(next, oldGraph)
  assert.equal(oldGraph._destroyed, true)
  assert.equal(next._canExtend({ id: PARENT }), false)
  assert.equal(next.computer.agents.filter(row => row.treeNode).length, 2, 'settings preserve the existing forest')
})

/* T837. The same 82-node forest, driven through the view's own event door
   (window.mcAgent.onEvent) the way the native app drives it: a reply streams in
   and the turn finishes. Every one of those events refreshes the tree, and the
   view looked each agent's name up through a store snapshot -- one SYNCHRONOUS
   settings read per agent per event. On the 2026-09-21 LIVE generation (app
   d46c18f49) that was 232 to 357 reads per five seconds. A read belongs to a
   full render asking the store for its offers, once; it does not belong to an
   agent. */
function eventDoor(world) {
  const listeners = new Set()
  world.bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  world.bridge.models = async () => ({ provider: 'codex', catalogSupported: true, models: [] })
  world.bridge.sessionActivity = async () => ({ ok: true, busy: false, closing: false, lastTurnStatus: 'completed', turnsCompleted: 1 })
  return async (sessionId, event) => {
    await Promise.all([...listeners].map(listener => listener({ sessionId, event })))
    await settle(3)
  }
}

test('T837: streamed replies and a finished turn on an 82-node forest read slot settings once per full render, never once per agent', async t => {
  let reads = 0, emit, world
  await mountedCircles(t, 81, { treeSlots() { reads++; return { ok: true, bounds: { maxChildren: 4, maxDepth: 3 } } } },
    prepared => { world = prepared; emit = eventDoor(prepared) })
  const graph = window.__mcGraph
  assert.equal(graph.computer.agents.filter(row => row.treeNode).length, 82, 'the mounted view must hold the measured-size saved forest')
  await settle(20)
  const readOffers = graph.extensionPoints
  let offerReads = 0
  graph.extensionPoints = () => { offerReads++; return readOffers() }
  reads = 0
  for (let index = 0; index < 20; index += 1) await emit('session-parent', { type: 'assistant_text_delta', turnId: 'turn-t837', text: `word ${index} ` })
  await emit('session-parent', { type: 'turn_completed', turnId: 'turn-t837', status: 'completed' })
  await settle(20)
  const saved = JSON.parse(world.storage.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(node => node.id === PARENT)
  assert.ok(String(saved.reply).includes('word 19'), 'the events must reach the agent, or the count below measures nothing: ' + JSON.stringify(saved.reply))
  assert.ok(reads <= offerReads,
    `the tree read the saved slot settings ${reads} times for 21 events across 82 agents, but only ${offerReads} full render(s) asked for offers; `
    + 'each read is a synchronous call into the main process, so a read per agent per event freezes this window whenever that process is busy')
})

test('T837: mounting an 82-node forest reads slot settings fewer times than there are agents', async t => {
  let reads = 0
  await mountedCircles(t, 81, { treeSlots() { reads++; return { ok: true, bounds: { maxChildren: 4, maxDepth: 3 } } } })
  await settle(20)
  const agents = window.__mcGraph.computer.agents.filter(row => row.treeNode).length
  assert.equal(agents, 82, 'the mounted view must hold the measured-size saved forest')
  assert.ok(reads < agents, `mounting read the saved slot settings ${reads} times for ${agents} agents; a read per agent is the storm this guards`)
})
