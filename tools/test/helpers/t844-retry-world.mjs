import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { register } from 'node:module'
register('./css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, seedTreeNode, settle } = await import('../lib/tree-command-real-mount.mjs')
const { fleetTreesStorageKey } = await import('../../../src/fleet-trees.js')
const { setExampleMode, resolveDataSource } = await import('../../../src/data-source.js')

// Real computersView, tree store, recovery coordinator and chat component.
// DOM and host bridges are fixtures; no browser keys or provider are driven.
export async function retryWorld(t, { recoveryBridge = null } = {}) {
  // Fleet schema computer IDs must begin with a letter; raw UUIDs need not.
  const computerId = 'fixture-' + randomUUID(), nodeId = randomUUID(), sessionId = randomUUID()
  const world = await installWorld(fleetFetch({ computerId }), { asyncFrames: true })
  const records = new Map(), calls = { starts: [], closes: [], saves: [], reads: [] }
  world.storage.setItem('mc.write.agent-session', 'enabled')
  world.storage.setItem('mc.set.tree_style', 'boxes')
  seedTreeNode(world.storage, { computerId, nodeId, sessionId, status: 'finished' })
  const key = fleetTreesStorageKey(computerId)
  const seeded = JSON.parse(world.storage.getItem(key))
  Object.assign(seeded.nodes[0], { tier: 'luna', role: 'worker', statusNote: 'Stopped by you.', message: 'Retained retry fixture' })
  world.storage.setItem(key, JSON.stringify(seeded))
  const org = { revision: 1, contentHash: 'fixture', agents: [{ id: nodeId, role: 'worker', provider: 'codex', enabled: true }], relationships: [] }
  window.mcOrg = {
    read: async () => ({ ok: true, org, roles: [{ id: 'worker', name: 'Worker', revision: 1 }] }),
    ensureSeat: async () => ({ ok: true, org }),
  }
  const previousOrg = globalThis.mcOrg
  globalThis.mcOrg = window.mcOrg
  window.mcRecovery = {
    get: async request => {
      calls.reads.push(request)
      if (recoveryBridge) return { ...(await recoveryBridge.get(request)), authoritative: true }
      return { ok: true, authoritative: true, record: structuredClone(records.get(request.nodeId) || null) }
    },
    save: async request => {
      calls.saves.push(structuredClone(request))
      if (recoveryBridge) return recoveryBridge.save(request)
      records.set(request.nodeId, structuredClone(request.record))
      return { ok: true }
    },
  }
  world.bridge.models = async () => ({ provider: 'codex', catalogSupported: true, models: [] })
  world.bridge.sessionActivity = async () => ({ ok: true, busy: false, closing: false, lastTurnStatus: 'completed', turnsCompleted: 1 })
  world.bridge.start = async request => { calls.starts.push(request); return { ok: false, code: 'FIXTURE_START_REFUSED' } }
  world.bridge.close = async request => { calls.closes.push(request); return { ok: false, code: 'FIXTURE_CLOSE_REFUSED' } }
  const views = []
  const sourceUrl = new URL('../../../src/views/computers.js', import.meta.url)
  let factory = (await import(sourceUrl.href + '?t844=' + randomUUID())).computersView
  let current
  async function mount({ fresh = false, example = false } = {}) {
    if (current) { current.destroy(); current.el.remove() }
    setExampleMode(example)
    await resolveDataSource({ reask: true })
    if (fresh) factory = (await import(sourceUrl.href + '?t844=' + randomUUID())).computersView
    current = factory({ initialComputer: computerId, navigate() {} })
    views.push(current)
    document.body.appendChild(current.el)
    await settle()
    return current
  }
  async function openChat(id = nodeId) {
    const card = [...current.el.querySelectorAll('.static-tree-node')].find(row => row.dataset.agentId === id)
    assert.ok(card, 'fixture node is mounted on the actual tree')
    card.dispatch('keydown', { key: 'Enter', shiftKey: true })
    await settle(15)
    const chat = current.el.querySelector('[data-rail-chat-host] .chat')
    assert.ok(chat, 'the actual selected chat is mounted')
    return chat
  }
  t.after(() => {
    for (const view of views) { view.destroy(); view.el.remove() }
    setExampleMode(false)
    if (previousOrg === undefined) delete globalThis.mcOrg
    else globalThis.mcOrg = previousOrg
    world.restore()
  })
  await mount()
  return {
    world, computerId, nodeId, sessionId, calls, records, mount, openChat,
    get view() { return current },
    async record() { return (await window.mcRecovery.get({ computerId, nodeId })).record },
    async choose(chat, value) {
      const select = chat.querySelector('[data-chat-chip="account-retry"]')
      assert.ok(select, 'retry policy control is present')
      assert.equal(select.disabled, false, 'fixture has ordinary start-control authority')
      select.value = value
      select.dispatchEvent({ type: 'change' })
      await settle(30)
    },
  }
}
export { settle }
