// The computer's own window, when a signed-in browser sends to one of its
// sessions: the shell announces the accepted message as person_turn with
// via:'remote' before the turn's first reply packet. Both desktop chat owners,
// the tree rail and the single-agent page, show it as the person's line once,
// above its reply. The desktop window never renders via:'desktop' (its own
// words are already on screen), and the page is unchanged where the browser
// list does not exist.

import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, seedTreeNode, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')

const lines = (root, side) => root.querySelectorAll('.msg')
  .filter(message => message.classList.contains(side))
  .map(message => message.querySelector('.chat-msg-text')?.textContent ?? '')
const order = (root, text) => root.querySelectorAll('.msg').findIndex(message => (message.querySelector('.chat-msg-text')?.textContent ?? '') === text)

let serial = 0
async function treeWorld(t, { desktopList = null } = {}) {
  const computerId = `person-turn-computer-${++serial}`
  const world = await installWorld(fleetFetch({ computerId }))
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0)
  globalThis.cancelAnimationFrame = timer => clearTimeout(timer)
  document.createTextNode = text => {
    const node = document.createElement('span')
    node.textContent = text
    Object.defineProperty(node, 'data', { get: () => node.textContent, set: value => { node.textContent = value } })
    return node
  }
  const nodeId = `person-turn-node-${serial}`
  const sessionId = `person-turn-session-${serial}`
  const packets = new Set()
  const priorOrg = Object.getOwnPropertyDescriptor(globalThis, 'mcOrg')
  world.storage.setItem('mc.write.agent-session', 'enabled')
  world.storage.setItem('mc.set.tree_style', 'boxes')
  window.mcSetup = { workspaceState: async () => ({ ok: true, available: true, chosen: true, roots: ['/fixture/setup'] }) }
  world.bridge.profiles = async () => ({ ok: true, profiles: [] })
  world.bridge.confinement = async () => ({ ok: true, tier: 'guided', sandbox: 'read-only', approvalPolicy: 'never', isolated: true, recorded: true })
  world.bridge.start = async () => ({ ok: true, sessionId, threadId: 'fixture-thread' })
  world.bridge.send = async () => ({ turnId: 'fixture-turn' })
  world.bridge.onEvent = listener => { packets.add(listener); return () => packets.delete(listener) }
  if (desktopList) window.mcDesktopSessions = desktopList
  seedTreeNode(world.storage, { computerId, nodeId, sessionId: null, status: 'finished' })
  const org = { revision: 1, source: 'overlay', agents: [{ id: nodeId, role: 'builder', provider: 'codex', enabled: true }], edges: [] }
  globalThis.mcOrg = window.mcOrg = { read: async () => ({ ok: true, org, roles: [{ id: 'builder', name: 'Builder', revision: 1, capabilities: {} }] }) }
  const view = await mountView(world, { computerId })
  t.after(() => {
    view.destroy()
    delete window.mcDesktopSessions
    if (priorOrg) Object.defineProperty(globalThis, 'mcOrg', priorOrg); else delete globalThis.mcOrg
    world.restore()
  })
  return {
    view, world, computerId, nodeId, sessionId,
    emit: async event => { await Promise.all([...packets].map(listener => listener({ sessionId, event }))); await settle(3) },
    openRail: async () => {
      view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === nodeId).dispatch('keydown', { key: 'Enter', shiftKey: true })
      await settle(6)
      return view.el.querySelector('[data-rail-chat-host] .chat')
    },
  }
}

test('the tree rail shows a browser-sent message once, above its reply, and ignores its own side', async t => {
  const f = await treeWorld(t)
  const started = await f.view.runTreeNodeCommand({ action: 'fresh-start-existing-node', computerId: f.computerId, nodeId: f.nodeId })
  assert.equal(started.ok, true, JSON.stringify(started))
  const rail = await f.openRail()
  assert.ok(rail, 'the rail chat is mounted')
  await f.emit({ type: 'person_turn', via: 'remote', text: 'NONCE_A', turnId: 'remote-turn-1', at: Date.now() })
  await f.emit({ type: 'person_turn', via: 'remote', text: 'NONCE_A', turnId: 'remote-turn-1', at: Date.now() })
  await f.emit({ type: 'person_turn', via: 'desktop', text: 'TYPED_HERE', turnId: 'local-turn-2', at: Date.now() })
  await f.emit({ type: 'assistant_text_delta', turnId: 'remote-turn-1', text: 'NONCE_B' })
  await f.emit({ type: 'turn_completed', turnId: 'remote-turn-1', status: 'completed' })
  await settle(10)
  const chat = f.view.el.querySelector('[data-rail-chat-host] .chat')
  assert.equal(lines(chat, 'me').filter(text => text === 'NONCE_A').length, 1)
  assert.equal(lines(chat, 'me').includes('TYPED_HERE'), false)
  assert.equal(lines(chat, 'them').filter(text => text === 'NONCE_B').length, 1)
  assert.ok(order(chat, 'NONCE_A') < order(chat, 'NONCE_B'), 'the message sits above the reply that answers it')
})

test('without the browser list, the desktop page asks for nothing and draws no extra section', async t => {
  const calls = []
  const spy = {
    list: async () => { calls.push('list'); return { ok: true, mayWrite: true, sessions: [], truncated: false } },
    transcript: async () => { calls.push('transcript'); return { ok: true, entries: [] } },
    send: async () => { calls.push('send'); return { ok: true } },
  }
  const f = await treeWorld(t, { desktopList: spy })
  await settle(20)
  assert.deepEqual(calls, [], 'on the desktop source the list is never read, even if a global is present')
  assert.equal(f.view.el.querySelector('[data-desktop-sessions]'), null)
})

test('the single-agent page shows a browser-sent message once and streams its reply below it', async t => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const { document: doc, restore } = installDomStandIn(globalThis)
  const store = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, String(value)) }, removeItem: key => { store.delete(key) } }
  let listener = null
  let controller = null
  const bridge = {
    availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }),
    onEvent: value => { listener = value; return () => { listener = null } },
    start: async value => ({ sessionId: value.sessionId || 'page-session' }),
    send: async value => ({ sessionId: value.sessionId, turnId: 'page-turn-1' }),
    close: async () => ({ closed: true }),
    interrupt: async () => ({ ok: true }),
  }
  const root = doc.createElement('div')
  doc.body.appendChild(root)
  const { resetLiveSessionForTest } = await import('../../src/agent-session-registry.js')
  resetLiveSessionForTest()
  const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
  const dispose = mountAgentSessionSurface(root, { live: true, agentId: 'agent-1', bridge, onController: value => { controller = value } })
  t.after(() => { dispose(); resetLiveSessionForTest(); restore() })
  await settle(4)
  const first = await controller.send('PAGE_FIRST')
  assert.equal(first.ok, true, JSON.stringify(first))
  const sessionId = first.sessionId
  listener({ sessionId, event: { type: 'turn_completed', turnId: 'page-turn-1', status: 'completed' } })
  await settle(4)
  const emit = event => listener({ sessionId, event })
  emit({ type: 'person_turn', via: 'remote', text: 'NONCE_A', turnId: 'remote-turn-9', at: Date.now() })
  emit({ type: 'person_turn', via: 'remote', text: 'NONCE_A', turnId: 'remote-turn-9', at: Date.now() })
  emit({ type: 'person_turn', via: 'desktop', text: 'TYPED_HERE', turnId: 'local-turn-10', at: Date.now() })
  emit({ type: 'assistant_text_delta', turnId: 'remote-turn-9', text: 'NONCE_B' })
  emit({ type: 'turn_completed', turnId: 'remote-turn-9', status: 'completed' })
  await settle(10)
  assert.equal(lines(root, 'me').filter(text => text === 'NONCE_A').length, 1)
  assert.equal(lines(root, 'me').includes('TYPED_HERE'), false)
  assert.equal(lines(root, 'them').filter(text => text === 'NONCE_B').length, 1)
  assert.ok(order(root, 'NONCE_A') < order(root, 'NONCE_B'))
})
