// Real graph/workspace/chat components with explicit local fixture callbacks.
// No native bridge, provider session, or user's saved fleet is accessed.
import '../../../src/styles.css'
import '../../../src/tree-graph.css'
import '../../../src/tree-workspace.css'
import '../../../src/agent-screen-voice-controls.css'
import { StaticTreeGraph } from '../../../src/tree-graph.js'
import { TreeWindows } from '../../../src/tree-windows.js'
import { readTreeCards, readTreeContextSize } from '../../../src/tree-box-layout.js'

const params = new URLSearchParams(location.search)
const nodeStyle = params.get('style') === 'boxes' ? 'boxes' : 'circles'
const progressive = params.get('fleet') === 'progressive'
const nodes = (progressive ? [
  { id: 'alpha', parentId: null, name: 'Controller', role: 'controller' },
  ...Array.from({ length: 5 }, (_, i) => ({ id: `alpha-builder-${i}`, parentId: 'alpha', name: `Builder ${i + 1}`, role: 'builder' })),
  { id: 'alpha-manager', parentId: 'alpha', name: 'Manager', role: 'manager' },
  ...Array.from({ length: 11 }, (_, i) => ({ id: `alpha-worker-${i}`, parentId: 'alpha-manager', name: `Worker ${i + 1}`, role: 'worker' })),
  { id: 'beta', parentId: null, name: 'Reviewer', role: 'reviewer' },
  { id: 'beta-worker', parentId: 'beta', name: 'Review builder', role: 'builder' },
] : ['alpha', 'beta', 'gamma'].flatMap(tree => [
  { id: tree, parentId: null, name: `${tree} head`, role: 'controller' },
  { id: `${tree}-worker`, parentId: tree, name: `${tree} worker`, role: 'builder' },
  { id: `${tree}-leaf`, parentId: `${tree}-worker`, name: `${tree} leaf`, role: 'worker' },
])).map(agent => ({ ...agent, declaredRole: agent.role, state: 'idle', treeNode: { id: agent.id, treeId: agent.id.split('-')[0] } }))
const computer = { id: `tree-interactions-${nodeStyle}`, agents: nodes }
const fixture = window.fixture = { nodes, computer, controls: [], contacts: [], linkRequests: [], links: [], sends: [], subscribers: new Set(),
  adds: [], bridgeCalls: [], bridgeListeners: new Set() }
localStorage.setItem('mc.write.agent-session', 'enabled')
const standaloneOwner = { version: 1, ownerId: 'tree-interaction-fixture', currentEpoch: 'fixture-epoch', kind: 'local' }
const standaloneSessions = new Set(), standaloneBindings = new Map()
fixture.ownerListeners = new Set()
fixture.bindingRequests = []
const standaloneTranscript = {
  async bind(sessionId, seatId) {
    if (!standaloneSessions.has(sessionId)) throw new Error('Transcript binding before native start')
    fixture.bindingRequests.push({ sessionId, seatId })
    if (fixture.bindingWait) await fixture.bindingWait
    standaloneBindings.set(sessionId, seatId)
    return { ok: true }
  },
  async release(sessionId) { return { ok: true, released: standaloneBindings.delete(sessionId) } },
}
const standaloneBridge = {
  availability: async () => ({ ok: true }),
  confinement: async () => ({ ok: true, tier: 'standard' }),
  onEvent: listener => { fixture.bridgeListeners.add(listener); return () => fixture.bridgeListeners.delete(listener) },
  ownerContext: async () => standaloneOwner,
  onOwnerContextChanged: listener => { fixture.ownerListeners.add(listener); return () => fixture.ownerListeners.delete(listener) },
  start: async request => { fixture.bridgeCalls.push({ method: 'start', request }); standaloneSessions.add(request.sessionId); return { sessionId: request.sessionId } },
  send: async request => {
    fixture.bridgeCalls.push({ method: 'send', request })
    if (!standaloneSessions.has(request.sessionId) || !standaloneBindings.has(request.sessionId)) {
      throw new Error('Send requires a live session with acknowledged transcript binding')
    }
    return { turnId: 'fixture-turn' }
  },
  interrupt: async request => { fixture.bridgeCalls.push({ method: 'interrupt', request }); return { ok: true } },
  close: async request => { fixture.bridgeCalls.push({ method: 'close', request }); standaloneSessions.delete(request.sessionId); return { closed: true } },
}
let graph
function mountGraph() {
graph = window.graph = new StaticTreeGraph(document.querySelector('#graph'), {
  computer, nodeStyle, circleCards: readTreeCards(), cardSize: readTreeContextSize(), tabbedWorkspace: true,
  onContact: params.has('contacts') ? agent => fixture.contacts.push(agent.id) : null,
  standaloneAgent: { live: true, bridge: standaloneBridge, transcript: standaloneTranscript, persistenceKey: computer.id },
  contextFeed: agent => ({ current: 'Ready for review', previous: `${agent.name}: inspect the source and report the result.` }),
  treeChat: agent => ({
    title: agent.name, roleKey: agent.role, seed: 0,
    history: [{ who: 'them', text: `${agent.name} fixture conversation`, at: new Date().toISOString() }],
    onSend: (text, handlers) => { fixture.sends.push({ id: agent.id, text }); handlers.reply('Fixture reply') },
    status: { busy: () => false, subscribe: listener => { fixture.subscribers.add(listener); return () => fixture.subscribers.delete(listener) } },
  }),
  onOpenControls: agent => { fixture.controls.push(agent.id); document.querySelector('.fixture-side-agent').textContent = agent.name },
  onEmptyPress: request => fixture.adds.push(request),
  onLinkChange: async request => {
    fixture.linkRequests.push(request)
    fixture.links = fixture.links.filter(link => !((link.from === request.from && link.to === request.to) || (link.to === request.from && link.from === request.to)))
    if (request.connected) fixture.links.push({ from: request.from, to: request.to })
    return { ok: true, links: fixture.links }
  },
})
graph.treeWindows = new TreeWindows(graph, {
  getTrees: () => nodes.filter(agent => !agent.parentId).map(agent => ({ rootId: agent.id, name: `${agent.id} tree`, count: nodes.filter(node => node.treeNode.treeId === agent.treeNode.treeId).length })),
})
graph.setWide(true)
}
mountGraph()
fixture.remount = () => { graph.destroy(); mountGraph() }
fixture.dispose = () => {
  for (const record of [...graph.workspace.standalone.values()]) graph.workspace.close(record, { focus: false })
  graph.destroy()
}
document.querySelector('.fixture-close-rail').addEventListener('click', () => graph.setWide(true))
document.querySelector('.graph-open-btn').addEventListener('click', () => {
  graph.workspace.showTrees({ focus: false }); graph.setWide(!graph._treeWide)
})
fixture.metrics = () => ({
  mode: graph.workspace.mode, activeChat: graph.activeChatId, controls: [...fixture.controls],
  chats: [...graph.nodes.values()].filter(record => record.chatOpen).map(record => record.id),
  standalone: [...graph.workspace.standalone.values()].map(record => ({ id: record.id, name: record.agent.name })),
  bridgeCalls: [...fixture.bridgeCalls], bridgeSubscriptions: fixture.bridgeListeners.size,
  links: [...fixture.linkRequests],
  windows: graph.treeWindows.windows.map(({ graph: view }) => ({
    roots: [...view.windowRootIds], focus: view.rootId, selected: view.selectedId,
    linking: !!view._linkMode, cards: view.circleCards, cardSize: view.cardSize, style: view.nodeStyle,
    visible: [...view._layoutVisibleIds],
    visibleCards: view.screenOverlay.hidden ? [] : [...view.screenOverlay.querySelectorAll('.screen-chip-visible')].filter(chip => !chip.hidden).map(chip => chip.dataset.agentId),
  })),
})
