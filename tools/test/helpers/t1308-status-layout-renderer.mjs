import '../../../src/styles.css'
import '../../../src/tree-graph.css'
import '../../../src/tree-workspace.css'
import '../../../src/board.css'
import { computersView } from '../../../src/views/computers.js'
import { StaticTreeGraph } from '../../../src/tree-graph.js'
import { fleetTreesStorageKey } from '../../../src/fleet-trees.js'
import { setExampleMode } from '../../../src/data-source.js'
import fleetSchema from '../../../public/data/schema/fleet.schema.json'

const computerId = 'layout-fixture'
const stamp = '2026-09-22T00:00:00.000Z'
const operations = []
let view, graph
const refuse = name => async request => { operations.push({ name, request }); return { ok: false, code: 'FIXTURE_OPERATION_REFUSED' } }
window.mcShell = { getBridgeProof: async () => ({ ok: true, proof: 'fixture' }), getBridgeTransport: async () => null }
window.mcAgent = { start: refuse('start'), close: refuse('close'), send: refuse('send'), startableTiers: async () => ({ ok: true, tiers: [] }) }
window.mcProviders = { presence: async () => ({ ok: true, providers: [] }) }
window.mcOrg = { read: async () => ({ ok: true, org: { revision: 1, agents: [], relationships: [] }, roles: [] }), releaseSeat: refuse('releaseSeat') }
const projection = { schemaVersion: 1, domain: 'fleet', generatedAt: stamp, ok: true, reason: null, sources: [],
  data: { computers: [{ id: computerId, label: 'Layout fixture', sourceKind: 'observed', observedAt: stamp, activeSessions: 0, services: [] }],
    graph: { revision: 1, contentHash: '0'.repeat(64), nodes: [{ id: 'seat-one', label: 'Seat', role: 'builder', provider: 'claude', enabled: true }], edges: [] } } }
window.fetch = async url => {
  const value = String(url) === '/data/fleet.json' ? projection : String(url) === '/data/schema/fleet.schema.json' ? fleetSchema : null
  return { ok: !!value, status: value ? 200 : 404, statusText: value ? 'OK' : 'Not Found', json: async () => value || {} }
}
const settle = async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await document.fonts.ready
  await new Promise(resolve => requestAnimationFrame(resolve))
}
const rect = element => {
  const r = element.getBoundingClientRect()
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
}
const visible = element => getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden'
  && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0
window.computersLayout = {
  operations,
  async mount(split) {
    await this.dispose()
    setExampleMode(false)
    localStorage.setItem(fleetTreesStorageKey(computerId), JSON.stringify({ version: 1, computerId,
      trees: [{ id: 'layout-tree', createdAt: stamp, updatedAt: stamp, profileId: null }],
      nodes: [{ id: 'node-layout', treeId: 'layout-tree', createdAt: stamp, updatedAt: stamp, role: 'worker',
        message: 'Layout fixture', status: 'draft', statusNote: '', sessionId: null, parentId: null }],
    }))
    localStorage.setItem('mc.tree.canvas.v2:' + computerId, JSON.stringify({ views: [{ rootIds: ['node-layout'] }] }))
    const original = StaticTreeGraph.prototype._syncCardMetrics
    StaticTreeGraph.prototype._syncCardMetrics = function (...args) { graph ||= this; return original.apply(this, args) }
    try {
      view = computersView({ initialComputer: computerId, navigate() {} })
      document.body.append(view.el)
      view.el.style.height = '100vh'
      view.el.style.minHeight = '0'
      view.el.style.width = '100%'
      for (let i = 0; i < 100 && !graph?.treeWindows; i++) await settle()
      if (!graph?.treeWindows) throw new Error('Actual Computers tree windows did not mount')
    } finally { StaticTreeGraph.prototype._syncCardMetrics = original }
    graph.setWide(true)
    if (split) graph.treeWindows.add([...graph.windowRootIds])
    await settle()
    if (graph.treeWindows.windows.length !== (split ? 2 : 1)) throw new Error('Wrong mounted pane count')
    return { panes: graph.treeWindows.windows.length }
  },
  async measure(kind) {
    const status = view.el.querySelector('.org-status')
    const long = 'Your tree change is saved. Review the details before the next action. '.repeat(6)
    const states = {
      empty: ['', false, 'idle'], hidden: ['Retained but hidden status', true, 'ok'],
      success: ['Agent set. Start the tree when you are ready.', false, 'ok'],
      refusal: ['The saved tree could not be read. No seats were released.', false, 'refuse'],
      'long-success': [long, false, 'ok'],
      'long-refusal': ['No seats were released. ' + long + 'x'.repeat(160), false, 'refuse'],
    }
    const state = states[kind]
    if (!state) throw new Error('Unknown layout fixture state')
    // Isolate CSS presentation on the actual mounted status element. These
    // injected messages are geometry inputs, not claims that a save occurred.
    status.textContent = state[0]; status.hidden = state[1]; status.dataset.state = state[2]
    await settle()
    return { kind, viewport: { width: innerWidth, height: innerHeight }, panes: graph.treeWindows.windows.length,
      status: { text: status.textContent, visible: visible(status), rect: rect(status),
        clientWidth: status.clientWidth, scrollWidth: status.scrollWidth, clientHeight: status.clientHeight, scrollHeight: status.scrollHeight,
        overflowY: getComputedStyle(status).overflowY },
      hints: [...view.el.querySelectorAll('.tree-pan-hint')].map(hint => ({ text: hint.textContent, visible: visible(hint), rect: rect(hint) })),
      canvas: rect(view.el.querySelector('.tree-window-grid')) }
  },
  async dispose() { if (view) { await view.destroy(); view.el.remove() } view = null; graph = null },
}
