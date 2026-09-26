// Real tree/chat components with an explicit synthetic transport. No LIVE API,
// profile, provider, or network session is touched by this browser fixture.
import '../../../src/styles.css'
import '../../../src/tree-graph.css'
import { StaticTreeGraph } from '../../../src/tree-graph.js'

const nodes = [
  ['controller', null, 'controller', 'Controller'],
  ...Array.from({ length: 6 }, (_, i) => [`builder-${i}`, 'controller', 'builder', `Builder ${i + 1}`]),
  ['manager', 'controller', 'manager', 'Manager'],
  ...Array.from({ length: 12 }, (_, i) => [`worker-${i}`, 'manager', 'worker', `Worker ${i + 1}`]),
].map(([id, parentId, role, name]) => ({ id, parentId, role, declaredRole: role, name, treeNode: { id, treeId: 'fixture-tree' }, state: 'idle' }))
const subscribers = new Map()
const queues = new Map(nodes.map(node => [node.id, []]))
const busy = new Set()
const notify = id => subscribers.get(id)?.forEach(listener => listener())
window.fixture = { nodes, sends: [], stops: [], adds: [], subscribers, queues, busy, notify, ready: new Map() }
window.graph = new StaticTreeGraph(document.querySelector('#graph'), {
  computer: { id: 'tree-chat-fixture', agents: nodes },
  contextFeed: agent => ({ current: `Review the ${agent.name} task and coordinate the next step.`, chat: `${agent.name}: The change is ready for review. Verification passed; the evidence is attached to the task.`, tool: 'Read source and inspect the current changes.' }),
  treeChat: agent => ({
    title: agent.name, roleKey: agent.role, seed: 0,
    history: [{ who: 'them', text: `${agent.name} conversation history`, at: new Date().toISOString() }],
    onReady: root => window.fixture.ready.set(agent.id, root),
    onSend: async (text, handlers) => {
      if (busy.has(agent.id)) {
        queues.get(agent.id).push({ id: crypto.randomUUID(), text })
        handlers.queued('Waiting for this agent.'); notify(agent.id); return
      }
      window.fixture.sends.push({ id: agent.id, text }); handlers.reply(`${agent.name} received: ${text}`)
    },
    onAttach: async () => ({ ok: true, path: `/fixture/${agent.id}.png`, name: `${agent.id}.png` }),
    onStop: () => window.fixture.stops.push(agent.id),
    status: { busy: () => busy.has(agent.id), subscribe: listener => {
      const set = subscribers.get(agent.id) || new Set(); set.add(listener); subscribers.set(agent.id, set)
      return () => set.delete(listener)
    } },
    queue: { list: () => queues.get(agent.id), subscribe: listener => {
      const set = subscribers.get(agent.id) || new Set(); set.add(listener); subscribers.set(agent.id, set)
      return () => set.delete(listener)
    }, add: text => { queues.get(agent.id).push({ id: crypto.randomUUID(), text }); notify(agent.id); return { ok: true } },
    cancel: id => { queues.set(agent.id, queues.get(agent.id).filter(entry => entry.id !== id)); notify(agent.id) } },
  }),
  onEmptyPress: event => window.fixture.adds.push(event),
})
window.fixture.metrics = () => ({
  nodes: [...graph.nodes.values()].filter(rec => !rec.el.hidden).length,
  previews: document.querySelectorAll('.static-tree-chip.screen-chip-visible:not(.as-chat)').length,
  chats: [...graph.nodes.values()].filter(rec => rec.chatOpen).length,
  zoom: graph.zoom,
  positions: [...graph.nodes.values()].map(rec => ({ id: rec.id, x: rec.x, y: rec.y, r: rec.r })),
})
