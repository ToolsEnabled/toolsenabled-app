import { StaticTreeGraph } from '../../../src/tree-graph.js'
import { fleetTreesStorageKey } from '../../../src/fleet-trees.js'
import { setExampleMode } from '../../../src/data-source.js'
import { installWorld, mountView, settle, fleetFetch, COMPUTER_ID } from '../lib/tree-command-real-mount.mjs'

export { settle, COMPUTER_ID }
export async function mountComputers(t, { nodes = [], agents = [], tiers = [], presence = null, holdPresence = false } = {}) {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  const operations = [], readings = { presence: 0 }
  const priorOrg = Object.getOwnPropertyDescriptor(globalThis, 'mcOrg')
  const original = StaticTreeGraph.prototype._syncCardMetrics
  let graph, view, pending
  let answer = presence
  StaticTreeGraph.prototype._syncCardMetrics = function (...args) {
    graph ||= this
    return original.apply(this, args)
  }
  const forbidden = name => async request => { operations.push({ name, request }); return { ok: false, code: 'FIXTURE_OPERATION_REFUSED' } }
  Object.assign(world.bridge, { start: forbidden('start'), close: forbidden('close'), send: forbidden('send'),
    startableTiers: async () => ({ ok: true, tiers }) })
  const org = { read: async () => ({ ok: true, org: { revision: 1, agents, relationships: [] }, roles: [] }),
    releaseSeat: forbidden('releaseSeat') }
  globalThis.mcOrg = window.mcOrg = org
  window.mcProviders = { presence: async () => {
    readings.presence++
    if (holdPresence) { holdPresence = false; return new Promise(resolve => { pending = resolve }) }
    if (answer instanceof Error) throw answer
    return answer
  } }
  const stamp = '2026-09-22T00:00:00.000Z'
  world.storage.setItem(fleetTreesStorageKey(COMPUTER_ID), JSON.stringify({
    version: 1, computerId: COMPUTER_ID,
    trees: [...new Set(nodes.map(node => node.treeId || 'tree-1'))].map(id => ({ id, name: null, createdAt: stamp, updatedAt: stamp, profileId: null })),
    nodes: nodes.map(node => ({ treeId: 'tree-1', createdAt: stamp, updatedAt: stamp, role: 'worker',
      message: '', statusNote: '', sessionId: null, parentId: null, status: 'draft', ...node })),
  }))
  t.after(async () => {
    pending?.(null)
    try { await view?.destroy(); view?.el.remove() } finally {
      StaticTreeGraph.prototype._syncCardMetrics = original
      setExampleMode(false)
      if (priorOrg) Object.defineProperty(globalThis, 'mcOrg', priorOrg)
      else delete globalThis.mcOrg
      world.restore()
    }
  })
  setExampleMode(false)
  view = await mountView(world)
  await settle()
  return { world, view, operations, readings, get graph() { return graph },
    resolvePresence(value) { answer = value; const resolve = pending; pending = null; resolve?.(value) },
    async refreshPresence(value) { answer = value; graph.onEmptyPress({ parentId: null }); await settle() },
    async openNode(id) {
      const node = JSON.parse(world.storage.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(row => row.id === id)
      if (!node || !graph) throw new Error('Mounted node/graph missing: ' + id)
      graph.onOpenControls({ id, treeNode: node })
      await settle()
      view.el.querySelector('[data-rail-tab="details"]')?.click()
    },
  }
}
