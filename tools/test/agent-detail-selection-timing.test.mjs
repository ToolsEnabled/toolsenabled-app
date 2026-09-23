import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { fleetFetch, installWorld, seedTreeNode, settle, COMPUTER_ID } from './lib/tree-command-real-mount.mjs'
import { createFleetTreeStore, safeTreeStorage } from '../../src/fleet-trees.js'
register('./helpers/css-stub-loader.mjs', import.meta.url)

const NODE_ID = 'detail-selection-own-node'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fixture(t, { child = false } = {}) {
  const world = await installWorld(fleetFetch(), { asyncFrames: true }), calls = [], navigations = [], opened = []
  let view, destroyed = false
  const destroy = () => { if (!destroyed) { destroyed = true; view?.destroy() } }
  t.after(() => {
    try { destroy(); assert.deepEqual(calls, []) } finally {
      world.restore()
    }
  })
  for (const verb of ['start', 'send', 'close']) world.bridge[verb] = async () => { calls.push(verb); return { ok: false } }
  seedTreeNode(world.storage, { nodeId: NODE_ID, sessionId: 'detail-selection-session', status: 'finished' })
  const childNode = child ? createFleetTreeStore({ computerId: COMPUTER_ID, storage: safeTreeStorage(world.storage) })
    .addNode({ parentId: NODE_ID, role: 'worker', message: 'The isolated child circle.' }).node : null
  const { computersView } = await import('../../src/views/computers.js')
  view = computersView({ initialComputer: COMPUTER_ID, navigate: route => navigations.push(route) })
  document.body.appendChild(view.el)
  await settle()
  const graph = window.__mcGraph, circle = graph.nodes.get(NODE_ID)?.el, button = view.el.querySelector('.graph-open-btn')
  assert.ok(circle?.isConnected && !circle.hidden && button && !button.hidden)
  assert.equal(graph.nodeStyle, 'boxes', 'exercise the current default, not a hidden legacy rendering')
  assert.notEqual(button.getAttribute('aria-disabled'), 'true', 'Fleet overview is always available')
  const onOpen = graph.onOpenControls
  graph.onOpenControls = agent => { opened.push(agent.id); return onOpen(agent) }
  const openChat = graph.openChat.bind(graph)
  graph.openChat = (record, options) => {
    const prior = opened.length, wasOpen = record.chatOpen
    const result = openChat(record, options)
    if (opened.length === prior && !wasOpen && record.chatOpen && record.chatRoot?.isConnected) opened.push(record.id)
    return result
  }
  const click = (target = circle) => target.dispatchEvent({ type: 'click', detail: 1 })
  const selected = (id = NODE_ID) => {
    assert.equal(graph.selectedId, id)
    assert.notEqual(button.getAttribute('aria-disabled'), 'true')
    assert.equal(button.textContent, 'Fleet overview')
    assert.deepEqual(navigations, [])
  }
  const fullChat = (id = NODE_ID) => {
    assert.equal(graph.activeChatId, id)
    assert.equal(graph._chatFull, true)
    assert.equal(graph.chatShelf.hidden, false)
    assert.equal(graph.workspace.chatView.hidden, false)
    assert.equal(graph.workspace.mode, 'chat')
    assert.equal(graph.nodes.get(id).chatRoot.isConnected, true)
    assert.equal(graph.zoomHost.inert, true, 'the covered canvas cannot receive input')
    assert.deepEqual(navigations, [])
  }
  return { view, graph, initialRoot: graph.rootId, circle, button, opened, navigations, selected, fullChat, destroy, childNode, click }
}

// Actual computersView and StaticTreeGraph over the provided DOM stand-in.
// Historical native input exposed stale selection at 0/80ms. The current
// Page 2 contract (owner, 2026-09-10): pressing a card -- a box, or a circle's
// context card -- opens side controls; double-clicking an agent opens its
// conversation tab; Fleet overview returns to the trees. Drive those doors.
for (const delay of [0, 80]) test(`the card Chat button after a mouse press at ${delay}ms uses the selected target`, async t => {
  const f = await fixture(t)
  f.click()
  if (delay) await wait(delay)
  f.selected()
  f.circle.querySelector('.tree-box-chat').click()
  f.fullChat()
  await wait(320)
  assert.deepEqual(f.opened, [NODE_ID], 'the pending card press cannot open side controls over the chosen chat')
  assert.equal(f.graph.workspace.mode, 'chat')
})

test('the settled press on a box card opens its side controls', async t => {
  const f = await fixture(t)
  f.click()
  await wait(320)
  f.selected()
  assert.deepEqual(f.opened, [NODE_ID])
  assert.equal(f.graph.workspace.mode, 'trees')
  assert.ok(f.view.el.querySelector('[data-rail-chat-host] .chat'))
})

test('Fleet overview returns to the trees without losing the selected agent conversation', async t => {
  const f = await fixture(t)
  f.click()
  f.circle.dispatchEvent({ type: 'dblclick' })
  await wait(320)
  f.selected()
  f.fullChat()
  const chatRoot = f.graph.nodes.get(NODE_ID).chatRoot
  f.button.click()
  assert.equal(f.graph.workspace.mode, 'trees')
  assert.equal(f.graph.workspace.chatView.hidden, true)
  assert.equal(f.graph.zoomHost.inert, false)
  assert.equal(f.graph._treeWide, false, 'Fleet overview reveals the side panel')
  assert.equal(chatRoot.isConnected, true, 'the conversation remains mounted in its tab')
  f.view.el.querySelector('.tree-chat-tab-wrap .tree-chat-tab').click()
  f.fullChat()
  assert.equal(f.graph.nodes.get(NODE_ID).chatRoot, chatRoot)
  assert.deepEqual(f.navigations, [])
})

for (const key of ['Enter', ' ']) test(`keyboard ${JSON.stringify(key)} opens the targeted conversation immediately`, async t => {
  const f = await fixture(t)
  f.circle.dispatchEvent({ type: 'keydown', key })
  f.fullChat()
  assert.deepEqual(f.opened, [NODE_ID])
})

test('Shift+Enter selects the agent and opens side controls immediately', async t => {
  const f = await fixture(t)
  f.circle.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: true })
  f.selected()
  assert.deepEqual(f.opened, [NODE_ID])
  assert.equal(f.graph.workspace.mode, 'trees')
  assert.ok(f.view.el.querySelector('[data-rail-chat-host] .chat'))
})

test('a double click opens the conversation tab and cancels its delayed side controls', async t => {
  const f = await fixture(t, { child: true })
  f.click()
  f.circle.dispatchEvent({ type: 'dblclick' })
  f.selected()
  f.fullChat()
  await wait(320)
  assert.deepEqual(f.opened, [NODE_ID], 'the pending card press cannot also open side controls')
  assert.equal(f.graph.rootId, f.initialRoot)
  f.fullChat()
})

test('a single box click selects immediately and opens side controls after the gesture without drilling', async t => {
  const f = await fixture(t, { child: true })
  f.click()
  assert.equal(f.graph.selectedId, NODE_ID)
  f.selected()
  assert.equal(f.graph.rootId, f.initialRoot)
  assert.deepEqual(f.opened, [])
  await wait(80)
  assert.equal(f.graph.rootId, f.initialRoot)
  assert.deepEqual(f.opened, [])
  await wait(240)
  assert.equal(f.graph.rootId, f.initialRoot)
  assert.deepEqual(f.opened, [NODE_ID])
  assert.equal(f.graph.workspace.mode, 'trees')
})

test('a newer keyboard selection cancels the older pending mouse target', async t => {
  const f = await fixture(t, { child: true })
  f.click()
  f.graph.nodes.get(f.childNode.id).el.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: true })
  await wait(320)
  f.selected(f.childNode.id)
  assert.equal(f.graph.selectedId, f.childNode.id)
  assert.equal(f.graph.rootId, f.initialRoot)
  assert.deepEqual(f.opened, [f.childNode.id])
})

test('a newer mouse selection owns the delay instead of letting an older node reopen', async t => {
  const f = await fixture(t, { child: true })
  f.click()
  await wait(80)
  f.click(f.graph.nodes.get(f.childNode.id).el)
  await wait(220)
  assert.deepEqual(f.opened, [], 'the older node must not open during the newer node double-click window')
  assert.equal(f.graph.selectedId, f.childNode.id)
  await wait(120)
  f.selected(f.childNode.id)
  assert.deepEqual(f.opened, [f.childNode.id])
  assert.equal(f.graph.rootId, f.initialRoot)
})

test('clearing selection cancels a pending node open', async t => {
  const f = await fixture(t)
  f.click()
  f.graph.select(null)
  await wait(320)
  assert.equal(f.graph.selectedId, null)
  assert.deepEqual(f.opened, [])
  assert.deepEqual(f.navigations, [])
})

test('destroying the view cancels a pending node open', async t => {
  const f = await fixture(t)
  f.click()
  f.destroy()
  await wait(320)
  assert.deepEqual(f.opened, [])
  assert.deepEqual(f.navigations, [])
})

for (const ignored of ['edit', 'drag']) test(`an ignored ${ignored} click does not select or open a node`, async t => {
  const f = await fixture(t)
  if (ignored === 'edit') f.graph.setEditMode(true)
  else f.graph.nodes.get(NODE_ID).dragMoved = true
  f.click()
  await wait(320)
  assert.equal(f.graph.selectedId, null)
  assert.notEqual(f.button.getAttribute('aria-disabled'), 'true')
  assert.deepEqual(f.opened, [])
  assert.deepEqual(f.navigations, [])
})
