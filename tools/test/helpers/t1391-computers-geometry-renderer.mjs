import '../../../src/glow.css'
import '../../../src/styles.css'
import '../../../src/theme-refinements.css'
import '../../../src/common-commands.css'
import '../../../src/hand-controls.css'
import '../../../src/guided-step.css'
import '../../../src/phone-canvas.css'
import '../../../src/phone-ledger.css'
import '../../../src/accessibility-controls.css'
import '../../../src/morphs.css'
import '../../../src/chat-content.css'
import '../../../src/chat-session-changes.css'
import '../../../src/chat-presentation.css'
import '../../../src/chat-response.css'
import '../../../src/chat-activity.css'
import '../../../src/diff-editor.css'
import '../../../src/app-navigation.css'
import '../../../src/sidebar-pages.css'
import '../../../src/first-use-guidance.css'
import '../../../src/readability.css'
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

import { startPhoneCanvas } from '../../../src/phone-canvas.js'
import { mountAppNavigation } from '../../../src/app-navigation.js'
let navigation, wrapper
const intersects = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left)
  && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)
const inViewport = r => r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
window.computersGeometry = {
  operations,
  async mount({ phone = false, rows = true, trees = 1 } = {}) {
    localStorage.setItem('mc.phoneCanvas', phone ? 'on' : 'off')
    localStorage.setItem('mc.phoneLedger', rows ? 'on' : 'off')
    startPhoneCanvas()
    navigation = mountAppNavigation()
    setExampleMode(phone)
    if (!phone) {
      const roots = Array.from({ length: trees }, (_, i) => 'root-' + i)
      localStorage.setItem(fleetTreesStorageKey(computerId), JSON.stringify({ version: 1, computerId,
        trees: roots.map((_, i) => ({ id: 'tree-' + i, createdAt: stamp, updatedAt: stamp, profileId: null })),
        nodes: roots.flatMap((id, i) => [
          { id, treeId: 'tree-' + i, role: 'controller', parentId: null },
          { id: 'child-' + i, treeId: 'tree-' + i, role: 'worker', parentId: id },
        ]).map(node => ({ createdAt: stamp, updatedAt: stamp, message: 'Geometry fixture', status: 'draft', statusNote: '', sessionId: null, ...node })),
      }))
      localStorage.setItem('mc.tree.canvas.v2:' + computerId, JSON.stringify({ views: [{ rootIds: roots }] }))
    }
    const original = StaticTreeGraph.prototype._syncCardMetrics
    StaticTreeGraph.prototype._syncCardMetrics = function (...args) { graph ||= this; return original.apply(this, args) }
    try {
      view = computersView({ initialComputer: phone ? null : computerId, navigate() {} })
      wrapper = document.createElement('div'); wrapper.className = 'view'
      wrapper.append(view.el); document.getElementById('stage').append(wrapper)
      for (let i = 0; i < 120 && !graph?.treeWindows; i++) await settle()
      if (!graph?.treeWindows) throw new Error('Actual Computers tree windows did not mount')
      await settle()
    } finally { StaticTreeGraph.prototype._syncCardMetrics = original }
    return { phone: document.documentElement.dataset.phoneCanvas || 'off',
      shape: document.documentElement.dataset.phoneShape || null, rows: view.el.classList.contains('phone-ledger-mode') }
  },
  async edit(trees) {
    view.el.querySelector('.graph-edit-btn').click()
    const selectAll = document.querySelector('.tree-edit-picker-select-all')
    const confirm = document.querySelector('.tree-edit-picker-confirm')
    if (!selectAll || !confirm) throw new Error('Edit tree picker did not mount')
    selectAll.click(); confirm.click()
    await settle()
    if (!graph.editMode) throw new Error('Production Edit handler refused fixture')
    // Place an actual circle in the reported top-right corridor through the
    // graph's retained manual-nudge path. Natural layout alone could miss the
    // overlap and let the baseline pass by chance.
    graph.resetZoom()
    // Two seeded trees are both in the Edit selection; the second tree's
    // child is the circle nudged into the corner when there are two.
    const corner = graph.nodes.get(trees > 1 ? 'child-1' : 'root-0')
    if (!corner) throw new Error('Corner fixture node is missing')
    const start = { recordX: corner.x, recordY: corner.y }
    corner.x = graph.zoomHost.clientWidth - corner.r - 24
    corner.y = corner.r + 16
    graph._dropRec = graph._dropRaw = null
    graph._positionRecord(corner)
    graph._finishEditDrag(corner, start)
    await settle()
    const note = view.el.querySelector('.graph-edit-note')
    const noteRect = rect(note)
    const nodes = [...view.el.querySelectorAll('.static-tree-node')].filter(visible)
      .map(node => ({ id: node.dataset.agentId, rect: rect(node), labels: [...node.querySelectorAll('.node-labels')].map(rect),
        coveredByNote: [node, ...node.querySelectorAll('.node-labels')].some(element => intersects(rect(element), noteRect)) }))
    return { viewport: { width: innerWidth, height: innerHeight }, trees, editing: graph.editMode,
      note: { text: note.textContent, visible: visible(note), rect: noteRect },
      nodes, button: { text: view.el.querySelector('.graph-edit-btn').textContent, rect: rect(view.el.querySelector('.graph-edit-btn')) } }
  },
  async prepareRows() {
    const ledger = view.el.querySelector('.phone-ledger')
    const body = view.el.querySelector('.comp-body')
    const first = ledger?.querySelector('.phone-ledger-press')
    if (!first) throw new Error('Actual phone rows are unavailable')
    // Scroll existing containers as a person can. No geometry/style overrides:
    // the source CSS must provide both scroll range and a usable viewport.
    ledger.scrollTop += rect(first).top - rect(ledger).top
    await settle()
    body.scrollTop += rect(ledger).top - rect(body).top
    await settle()
    return this.rows()
  },
  async rows() {
    await settle()
    const ledger = view.el.querySelector('.phone-ledger'), body = view.el.querySelector('.comp-body')
    const bounds = [rect(ledger), rect(body), rect(view.el)]
    const rows = [...ledger.querySelectorAll('.phone-ledger-press')].map(button => {
      const box = rect(button), x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2
      const hit = document.elementFromPoint(x, y)
      const complete = inViewport(box) && bounds.every(r => box.top >= r.top && box.bottom <= r.bottom && box.left >= r.left && box.right <= r.right)
      return { id: button.closest('[data-agent-id]')?.dataset.agentId || button.closest('[data-id]')?.dataset.id || '',
        name: button.querySelector('.phone-ledger-name')?.textContent, rect: box, center: { x, y },
        complete, hit: hit === button || button.contains(hit) }
    })
    return { viewport: { width: innerWidth, height: innerHeight }, ledger: rect(ledger), body: rect(body),
      shape: document.documentElement.dataset.phoneShape, rows, usable: rows.filter(row => row.complete && row.hit),
      pageScrolls: document.documentElement.scrollHeight > innerHeight + 1 || document.body.scrollHeight > innerHeight + 1 }
  },
  async openedRow() {
    await settle()
    const sheet = view.el.querySelector('.phone-sheet')
    const card = sheet?.querySelector('.phone-sheet-card')
    await Promise.all((card?.getAnimations() || []).filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})))
    await settle()
    const close = sheet?.querySelector('.phone-sheet-close')
    return { visible: !!sheet && !sheet.hidden && sheet.classList.contains('is-up'),
      subject: sheet?.querySelector('.phone-sheet-name')?.textContent || '',
      sheet: sheet ? rect(sheet) : null, close: close ? rect(close) : null }
  },
  async graphMode() {
    await settle()
    const slot = view.el.querySelector('.graph-canvas-slot')
    return { viewport: { width: innerWidth, height: innerHeight }, rows: view.el.classList.contains('phone-ledger-mode'),
      canvas: rect(slot), zoomControls: [...view.el.querySelectorAll('.graph-zoomer button')].filter(visible).map(button => rect(button)),
      shape: document.documentElement.dataset.phoneShape }
  },
  async dispose() {
    if (view) await view.destroy()
    wrapper?.remove(); navigation?.destroy()
    view = null; graph = null; wrapper = null; navigation = null
  },
}
