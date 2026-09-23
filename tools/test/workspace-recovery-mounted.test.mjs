import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, seedTreeNode, mountView, settle, COMPUTER_ID } = await import('./lib/tree-command-real-mount.mjs')

// Real view, tree store, chat Actions and draft launcher; substitute only DOM
// and engine bridges. No provider process or user tree is involved.
test('workspace refusal preserves the task and offers a working-folder remedy before retry', async t => {
  const world = await installWorld(fleetFetch())
  const priorOrg = Object.getOwnPropertyDescriptor(globalThis, 'mcOrg')
  const nodeId = 'mounted-workspace-recovery-retry'
  const started = [], sent = []
  let chosen = false
  world.storage.setItem('mc.write.agent-session', 'enabled')
  window.mcSetup = { workspaceState: async () => ({ ok: true, available: true, configured: true, chosen, roots: ['/fixture/setup'] }) }
  world.bridge.start = async request => {
    started.push(request)
    if (!chosen) {
      // Electron preserves the safe message, but not error.code.
      throw new Error('Error invoking remote method mc-agent:start: AGENT_START_WORKSPACE_UNCONFIRMED')
    }
    return { ok: true, sessionId: 'retried-fixture-session' }
  }
  world.bridge.send = async request => { sent.push(request); return { turnId: 'fixture-turn' } }
  const org = { revision: 1, source: 'overlay', agents: [{ id: nodeId, role: 'builder', provider: 'codex', enabled: true }], edges: [] }
  const roles = [{ id: 'builder', name: 'Builder', revision: 1, capabilities: {} }]
  globalThis.mcOrg = window.mcOrg = { read: async () => ({ ok: true, org, roles }) }
  seedTreeNode(world.storage, { nodeId, status: 'failed' })
  const key = fleetTreesStorageKey(COMPUTER_ID)
  const saved = JSON.parse(world.storage.getItem(key))
  saved.nodes[0].message = 'Keep my original task.'
  world.storage.setItem(key, JSON.stringify(saved))
  const view = await mountView(world)
  t.after(() => { view.destroy(); if (priorOrg) Object.defineProperty(globalThis, 'mcOrg', priorOrg); else delete globalThis.mcOrg; world.restore() })
  view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === nodeId).dispatch('keydown', { key: 'Enter', shiftKey: true })
  await settle(5)
  const chat = view.el.querySelector('[data-rail-chat-host] .chat')
  chat.openActions()
  const retry = chat.querySelectorAll('.chat-actions-list button').find(button => button.textContent.startsWith('Retry starting this agent'))
  assert.ok(retry)
  assert.notEqual(retry.getAttribute('aria-disabled'), 'true')
  retry.dispatch('click')
  await settle(12)
  assert.equal(started.length, 1)
  assert.equal(sent.length, 0, 'a refused start sends no task')
  const refused = JSON.parse(world.storage.getItem(key))
  assert.equal(refused.nodes.length, 1)
  assert.equal(refused.nodes[0].message, 'Keep my original task.')
  assert.match(view.el.textContent, /No working folder has been confirmed/)
  assert.match(view.el.textContent, /Settings → Setup → Working folders/)
  assert.doesNotMatch(view.el.textContent, /close ToolsEnabled, open it/)
  const currentChat = view.el.querySelector('[data-rail-chat-host] .chat')
  currentChat.openActions()
  const retryAgain = currentChat.querySelectorAll('.chat-actions-list button')
    .find(button => button.textContent.startsWith('Retry starting this agent'))
  assert.ok(retryAgain)
  // The ordinary Settings picker/save path is exercised separately; model its
  // accepted result here before retrying the same preserved tree node.
  chosen = true
  retryAgain.dispatch('click')
  await settle(12)
  assert.equal(started.length, 2)
  assert.equal(sent.length, 1)
  assert.match(JSON.stringify(sent[0]), /Keep my original task\./)
  const after = JSON.parse(world.storage.getItem(key))
  assert.equal(after.nodes.length, 1)
  assert.equal(after.nodes[0].id, nodeId)
  assert.equal(after.nodes[0].treeId, saved.nodes[0].treeId)
  assert.equal(after.nodes[0].sessionId, 'retried-fixture-session')
})
