import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, seedTreeNode, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')

test('Computers remount restores multiple tabs, selected busy conversation and synthetic draft without replacing a session', async t => {
  const world = await installWorld(fleetFetch(), { asyncFrames: true }), events = new Set(), effects = { start: 0, close: 0, send: 0 }
  const ids = ['navigation-busy', 'navigation-stopped'], sessionId = 'navigation-session'
  window.MutationObserver = globalThis.MutationObserver
  world.storage.setItem('mc.write.agent-session', 'enabled')
  window.mcSetup = { workspaceState: async () => ({ ok: true, available: true, chosen: true, roots: ['/fixture/setup'] }) }
  world.bridge.profiles = async () => ({ ok: true, profiles: [] })
  world.bridge.confinement = async () => ({ ok: true, tier: 'guided', sandbox: 'read-only', approvalPolicy: 'never', isolated: true, recorded: true })
  world.bridge.start = async () => { effects.start++; return { ok: true, sessionId, threadId: 'navigation-thread' } }
  world.bridge.send = async () => { effects.send++; return { ok: true, turnId: 'navigation-turn' } }
  world.bridge.close = async () => { effects.close++; return { ok: true, closed: true } }
  world.bridge.onEvent = fn => { events.add(fn); return () => events.delete(fn) }
  seedTreeNode(world.storage, { nodeId: ids[0], status: 'finished' })
  const key = fleetTreesStorageKey('this-computer'), data = JSON.parse(world.storage.getItem(key))
  data.nodes.push({ ...data.nodes[0], id: ids[1], parentId: ids[0] })
  world.storage.setItem(key, JSON.stringify(data))
  const priorOrg = globalThis.mcOrg
  globalThis.mcOrg = window.mcOrg = { read: async () => ({ ok: true, org: { revision: 1, source: 'overlay', agents: ids.map(id => ({ id, role: 'builder', provider: 'codex', enabled: true })), edges: [] }, roles: [{ id: 'builder', name: 'Builder', revision: 1, capabilities: {} }] }) }
  let view
  t.after(() => { view?.destroy(); if (priorOrg === undefined) delete globalThis.mcOrg; else globalThis.mcOrg = priorOrg; world.restore() })
  view = await mountView(world)
  const result = await view.runTreeNodeCommand({ action: 'fresh-start-existing-node', computerId: 'this-computer', nodeId: ids[0] })
  assert.equal(result.ok, true, JSON.stringify(result))
  for (const fn of events) await fn({ sessionId, event: { type: 'person_turn', via: 'remote', text: 'Synthetic ongoing task', turnId: 'navigation-turn' } })
  await settle(4)
  assert.equal(JSON.parse(world.storage.getItem(key)).nodes.find(n => n.id === ids[0]).status, 'running')
  let graph = window.__mcGraph
  for (const id of [ids[1], ids[0]]) graph.openChat(graph.nodes.get(id))
  const draft = Array.from({ length: 509 }, (_, n) => String.fromCharCode(97 + n % 26)).join('')
  assert.equal(draft.length, 509)
  graph.nodes.get(ids[0]).chatRoot.importDraft({ text: draft, attachments: [], start: 20, end: 40 })
  const before = { ...effects }
  const computerTab = view.el.querySelector('.tabs').querySelector('.tab')
  computerTab.focus()
  view.el.querySelector('.tabs').dispatchEvent({ type: 'keydown', target: computerTab, key: 'ContextMenu', preventDefault() {}, stopPropagation() {} })
  let menu = document.body.querySelector('.node-menu')
  assert.ok(menu); assert.equal(menu.getAttribute('role'), 'menu')
  assert.equal(menu.querySelector('[data-menu-action="computer-details"]').getAttribute('aria-disabled'), 'false')
  menu.dispatchEvent({ type: 'keydown', key: 'Tab', preventDefault() {}, stopPropagation() {} })
  assert.equal(document.activeElement, computerTab)
  assert.deepEqual(effects, before)

  view.destroy(); view.el.remove(); view = null
  view = await mountView(world); graph = window.__mcGraph
  assert.deepEqual([...graph.chatTabs.querySelectorAll('.tree-chat-tab')].map(tab => tab.dataset.agentId).filter(Boolean).sort(), [...ids].sort())
  assert.equal(graph.activeChatId, ids[0]); assert.equal(graph.workspace.mode, 'chat')
  assert.equal(graph.nodes.get(ids[0]).chatRoot.exportDraft().text, draft)
  assert.equal(graph.nodes.get(ids[0]).agent.sessionId, sessionId)
  assert.deepEqual(effects, before, 'returning must not start, send or close')
  graph.workspace.close(graph.nodes.get(ids[1]), { focus: false })
  view.destroy(); view.el.remove(); view = null
  view = await mountView(world); graph = window.__mcGraph
  assert.deepEqual([...graph.chatTabs.querySelectorAll('.tree-chat-tab')].map(tab => tab.dataset.agentId).filter(Boolean), [ids[0]])
  assert.deepEqual(effects, before)
})
