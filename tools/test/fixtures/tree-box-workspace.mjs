// Real graph, workspace, window and chat components; every transport is an
// explicit fixture. This page never opens a native profile or provider session.
import '../../../src/styles.css'
import '../../../src/tree-graph.css'
import '../../../src/tree-workspace.css'
import { StaticTreeGraph } from '../../../src/tree-graph.js'
import { TreeWindows } from '../../../src/tree-windows.js'
import { readTreeStyle, TREE_STYLE_KEY } from '../../../src/tree-box-layout.js'
import { showTreeEditPicker } from '../../../src/tree-edit-picker.js'

const params = new URLSearchParams(location.search)
const reference = params.get('reference') === '1'
const styleSetting = new Map([[TREE_STYLE_KEY, params.get('style')]])
const nodeStyle = readTreeStyle({ getItem: key => styleSetting.get(key) })

const nodes = [
  ['controller', null, 'controller', 'Controller', 'build-tree'],
  ...Array.from({ length: reference ? 5 : 6 }, (_, i) => [`builder-${i}`, 'controller', 'builder', `Builder ${i + 1}`, 'build-tree']),
  ['manager', 'controller', 'manager', 'Manager', 'build-tree'],
  ...Array.from({ length: reference ? 11 : 12 }, (_, i) => [`worker-${i}`, 'manager', 'worker', `Worker ${i + 1}`, 'build-tree']),
  ['reviewer', null, 'reviewer', 'Reviewer', 'review-tree'],
  ['review-child', 'reviewer', reference ? 'builder' : 'worker', reference ? 'Builder' : 'Review assistant', 'review-tree'],
  ...(reference ? [] : [['researcher', null, 'researcher', 'Researcher', 'research-tree'],
  ['research-one', 'researcher', 'worker', 'Source reader', 'research-tree'],
  ['research-two', 'researcher', 'worker', 'Evidence checker', 'research-tree']]),
].map(([id, parentId, role, name, treeId]) => ({ id, parentId, role, declaredRole: role, name,
  treeNode: { id, treeId }, state: 'idle' }))
const computer = { id: reference ? `tree-reference-${nodeStyle}` : 'tree-box-fixture', agents: nodes }
const subscribers = new Map(), queues = new Map(nodes.map(node => [node.id, []])), busy = new Set()
const notify = id => subscribers.get(id)?.forEach(listener => listener())
const subscribe = (id, listener) => {
  const set = subscribers.get(id) || new Set()
  set.add(listener); subscribers.set(id, set)
  return () => set.delete(listener)
}
const fixture = window.fixture = { nodes, computer, sends: [], stops: [], adds: [], controls: [],
  links: reference ? [{ from: 'controller', to: 'reviewer' }] : [],
  linkRequests: [], subscribers, queues, busy, notify, ready: new Map() }
const graph = window.graph = new StaticTreeGraph(document.querySelector('#graph'), {
  computer, nodeStyle, tabbedWorkspace: true,
  communicationLinks: fixture.links,
  contextFeed: agent => reference ? { current: 'not started yet', previous: agent.id === 'controller'
    ? 'asked: Development example: coordinate the workspace review. These are draft agents; no sessions are running.'
    : agent.id === 'reviewer' ? 'asked: Development example: this agent belongs to a separate tree. Use Link agents to connect it to the workspace.'
      : 'asked: Development example: inspect this part of the work and report to the parent agent.' }
    : ({ current: `Review the ${agent.name} task and coordinate the next step.`,
    chat: `${agent.name}: Verification passed; the evidence is attached to the task.`, tool: 'Read the source and inspect the current changes.' }),
  treeChat: agent => ({
    title: agent.name, roleKey: agent.role, seed: 0,
    history: [{ who: 'them', text: `${agent.name} conversation history`, at: new Date().toISOString() }],
    onReady: root => fixture.ready.set(agent.id, root),
    onSend: async (text, handlers) => {
      if (busy.has(agent.id)) {
        queues.get(agent.id).push({ id: crypto.randomUUID(), text })
        handlers.queued('Waiting for this agent.'); notify(agent.id); return
      }
      fixture.sends.push({ id: agent.id, text }); handlers.reply(`${agent.name} received: ${text}`)
    },
    onAttach: async () => ({ ok: true, path: `/fixture/${agent.id}.png`, name: `${agent.id}.png` }),
    onStop: () => fixture.stops.push(agent.id),
    status: { busy: () => busy.has(agent.id), subscribe: listener => subscribe(agent.id, listener) },
    queue: { list: () => queues.get(agent.id), subscribe: listener => subscribe(agent.id, listener),
      add: text => { queues.get(agent.id).push({ id: crypto.randomUUID(), text }); notify(agent.id); return { ok: true } },
      cancel: id => { queues.set(agent.id, queues.get(agent.id).filter(entry => entry.id !== id)); notify(agent.id) } },
  }),
  onOpenControls: agent => { fixture.controls.push(agent.id); document.querySelector('.fixture-side-agent').textContent = agent.name },
  onEmptyPress: event => fixture.adds.push(event),
  onLinkChange: async request => {
    fixture.linkRequests.push(request)
    fixture.links = fixture.links.filter(link => !((link.from === request.from && link.to === request.to) || (link.to === request.from && link.from === request.to)))
    if (request.connected) fixture.links.push({ from: request.from, to: request.to })
    return { ok: true, links: fixture.links }
  },
})
fixture.trees = () => computer.agents.filter(agent => !agent.parentId).map(root => ({ rootId: root.id, name: `${root.name} tree`,
  count: computer.agents.filter(agent => agent.treeNode.treeId === root.treeNode.treeId).length }))
graph.treeWindows = new TreeWindows(graph, { getTrees: fixture.trees })
graph.setWide(true)
if (reference) {
  // Keep the reference canvas at the original screenshot's 752 CSS pixels,
  // independent of the host browser width and surrounding workspace tabs.
  graph.treeWindows.grid.style.gridTemplateColumns = '754px'
  graph.treeWindows.windows[0].pane.style.width = '754px'
  graph.resize()
}
document.querySelector('.graph-open-btn').addEventListener('click', () => {
  graph.workspace.showTrees({ focus: false }); graph.setWide(!graph._treeWide)
  document.querySelector('.fixture-side-agent').textContent = 'Fleet overview'
})
document.querySelector('.fixture-close-rail').addEventListener('click', () => graph.setWide(true))
document.querySelector('.graph-edit-btn').addEventListener('click', event => {
  const button = event.currentTarget
  if (graph.editMode) {
    graph.setEditMode(false)
    button.textContent = 'Edit'
  } else showTreeEditPicker({ host: graph.workspace.root, trees: fixture.trees(), selectedRootIds: graph.windowRootIds,
    onConfirm: rootIds => { graph.setEditMode(true, { rootIds }); button.textContent = 'Done' } })
})
fixture.metrics = () => ({
  mode: graph.workspace.mode, activeWorkspace: graph.treeWindows.activeId,
  workspaces: graph.treeWindows.workspaces.map(entry => ({ id: entry.id, name: entry.name })),
  windows: graph.treeWindows.windows.map(({ graph: view }) => ({
    roots: view.windowRootIds || [view.windowRootId], focus: view.rootId,
    visible: [...view.nodes.values()].filter(record => !record.el.hidden && view._layoutVisibleIds.has(record.id)).map(record => record.id),
    zoom: view.zoom, panX: view.panX, panY: view.panY,
    host: { width: view.zoomHost.clientWidth, height: view.zoomHost.clientHeight },
  })),
  chats: [...graph.nodes.values()].filter(record => record.chatOpen).map(record => record.id),
  subscriptions: [...subscribers.values()].reduce((sum, set) => sum + set.size, 0),
})
