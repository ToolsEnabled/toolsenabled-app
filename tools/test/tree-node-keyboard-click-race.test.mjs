import assert from 'node:assert/strict'
import test from 'node:test'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

// Native Windows: click to focus -> Shift+Enter -> Details -> the pending
// 260ms single click reopens Chat. Exercise the real pointer/key wiring and
// handleClick/select methods with a controllable clock, without a provider.
function fixture(t) {
  const { document, restore } = installDomStandIn()
  t.after(restore)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const node = document.createElement('div')
  document.body.appendChild(node)
  const record = { id: 'manager', agent: { id: 'manager', name: 'Manager' }, el: node, clickTimer: 0 }
  const opened = [], selected = [], roots = []
  const panel = { tab: null }
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
    editMode: false, nodes: new Map([[record.id, record]]),
    onOpenControls(agent) { opened.push(agent.id); panel.tab = 'chat' },
    onSelect(agent) { selected.push(agent.id) },
    setRoot(id) { roots.push(id) },
  })
  graph._wireNode(record)
  return { graph, node, record, opened, selected, roots, panel }
}

function pointerClick(f) {
  f.node.dispatch('click', { detail: 1 })
  assert.ok(f.record.clickTimer, 'a real pointer click must schedule the delayed activation')
  assert.deepEqual(f.opened, [], 'the pending pointer click has not activated yet')
  assert.deepEqual(f.selected, ['manager'], 'the pointer gesture selects immediately, before opening chat')
}

test('Shift+Enter cancels the pending focus click so Details stays selected after 260ms', t => {
  const f = fixture(t)
  pointerClick(f)
  t.mock.timers.tick(40)
  const key = f.node.dispatch('keydown', { key: 'Enter', shiftKey: true })
  assert.equal(key.defaultPrevented, true)
  assert.deepEqual(f.opened, ['manager'])
  assert.deepEqual(f.selected, ['manager', 'manager'], 'Shift+Enter settles the selected target synchronously')
  f.panel.tab = 'details'
  t.mock.timers.tick(260)
  assert.equal(f.panel.tab, 'details', 'The earlier click must not reopen Chat after the person chooses Details')
  assert.deepEqual(f.opened, ['manager'])
})

for (const key of ['Enter', ' ']) test(`${key === ' ' ? 'Space' : key} after a pointer click selects and opens the node once`, t => {
  const f = fixture(t)
  pointerClick(f)
  const event = f.node.dispatch('keydown', { key })
  assert.equal(event.defaultPrevented, true)
  assert.equal(f.graph.selectedId, 'manager')
  assert.equal(f.node.classList.contains('selected'), true)
  assert.deepEqual(f.selected, ['manager', 'manager'])
  assert.deepEqual(f.opened, ['manager'])
  t.mock.timers.tick(300)
  assert.deepEqual(f.selected, ['manager', 'manager'])
  assert.deepEqual(f.opened, ['manager'], 'The pending click must not activate a second time')
})

test('ordinary pointer click still waits for the double-click window and opens once', t => {
  const f = fixture(t)
  pointerClick(f)
  t.mock.timers.tick(259)
  assert.deepEqual(f.opened, [])
  t.mock.timers.tick(1)
  assert.deepEqual(f.opened, ['manager'])
  assert.deepEqual(f.selected, ['manager', 'manager'])
})

test('unrelated keys preserve the pending pointer click', t => {
  const f = fixture(t)
  pointerClick(f)
  const event = f.node.dispatch('keydown', { key: 'Tab' })
  assert.equal(Boolean(event.defaultPrevented), false)
  t.mock.timers.tick(260)
  assert.deepEqual(f.opened, ['manager'])
})

test('double click focuses the branch and consumes the pending chat activation', t => {
  const f = fixture(t)
  pointerClick(f)
  f.node.dispatch('dblclick', { detail: 2 })
  assert.deepEqual(f.roots, ['manager'])
  assert.deepEqual(f.opened, [])
  t.mock.timers.tick(260)
  assert.deepEqual(f.roots, ['manager'])
  assert.deepEqual(f.opened, [])
  assert.deepEqual(f.selected, ['manager', 'manager'])
})

/* THE WORKSPACE GESTURES, owner 2026-09-10: "double clicking the circle should
   bring up a window and clicking on the card should bring up the sidebar".
   Page 2 and its tree windows always have a workspace (or a chat owner). */
function workspaceFixture(t, nodeStyle) {
  const f = fixture(t), chats = []
  Object.assign(f.graph, { workspace: {}, nodeStyle, openChat(record) { chats.push(record.id) } })
  return { ...f, chats }
}

test('workspace circle: a click only selects, and a double click opens the conversation, never side chat', t => {
  const f = workspaceFixture(t, 'circles')
  f.node.dispatch('click', { detail: 1 })
  t.mock.timers.tick(300)
  assert.deepEqual([f.opened, f.chats, f.roots], [[], [], []], 'a single circle click only selects')
  f.node.dispatch('click', { detail: 1 })
  f.node.dispatch('click', { detail: 2 })
  f.node.dispatch('dblclick', { detail: 2 })
  assert.deepEqual(f.chats, ['manager'])
  t.mock.timers.tick(300)
  assert.deepEqual([f.opened, f.chats, f.roots], [[], ['manager'], []], 'no side chat and no drill afterwards')
})

test('workspace box: a click opens side chat after the double-click window; a double click opens the conversation instead', t => {
  const f = workspaceFixture(t, 'boxes')
  f.node.dispatch('click', { detail: 1 })
  t.mock.timers.tick(259)
  assert.deepEqual(f.opened, [])
  t.mock.timers.tick(1)
  assert.deepEqual([f.opened, f.chats], [['manager'], []], 'the box is its own card')
  f.node.dispatch('click', { detail: 1 })
  f.node.dispatch('dblclick', { detail: 2 })
  t.mock.timers.tick(300)
  assert.deepEqual([f.opened, f.chats, f.roots], [['manager'], ['manager'], []], 'the double click consumed the pending side chat')
})

for (const nodeStyle of ['circles', 'boxes']) test(`workspace ${nodeStyle}: Enter opens the conversation and Shift+Enter opens side chat`, t => {
  const f = workspaceFixture(t, nodeStyle)
  f.node.dispatch('keydown', { key: 'Enter' })
  assert.deepEqual([f.chats, f.opened], [['manager'], []])
  f.node.dispatch('keydown', { key: 'Enter', shiftKey: true })
  assert.deepEqual([f.chats, f.opened], [['manager'], ['manager']])
})

test('workspace context card: a press opens side chat, Enter too, Shift+Enter the conversation; a double click is one request', t => {
  // The real _makeChip and its handlers; only drawing seams are stubbed. Circles style: a box is its own card.
  const { document, restore } = installDomStandIn()
  t.after(restore)
  document.createElementNS = (_namespace, tag) => document.createElement(tag)
  const record = { id: 'manager', agent: { id: 'manager', name: 'Manager', role: 'manager' }, el: document.createElement('div'), clickTimer: 0 }
  const opened = [], chats = [], roots = []
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
    nodeStyle: 'circles', workspace: {}, editMode: false, nodes: new Map([[record.id, record]]),
    screenOverlay: document.createElement('div'), screenLeaderSvg: document.createElement('svg'), _renderChipPreview() {},
    onOpenControls(agent) { opened.push(agent.id) }, openChat(target) { chats.push(target.id) }, setRoot(id) { roots.push(id) },
  })
  graph._makeChip(record)
  const chip = record.chip
  assert.match(chip.getAttribute('aria-label'), /open side chat\. Shift\+Enter opens the conversation$/)
  chip.dispatch('click', { detail: 1 })
  assert.deepEqual([opened, chats], [['manager'], []])
  assert.equal(graph.selectedId, 'manager', 'the card selects its agent')
  chip.dispatch('click', { detail: 2 })
  assert.deepEqual([opened, chats], [['manager'], []], 'the second press of a double click is not a second request')
  chip.dispatch('keydown', { key: 'Enter' })
  assert.deepEqual([opened, chats], [['manager', 'manager'], []])
  chip.dispatch('keydown', { key: 'Enter', shiftKey: true })
  assert.deepEqual([opened, chats], [['manager', 'manager'], ['manager']])
  record.agent.treeScope = { group: true }
  chip.dispatch('click', { detail: 1 })
  assert.deepEqual([opened, chats, roots], [['manager', 'manager'], ['manager'], ['manager']], 'a group card still explores its branch')
})
