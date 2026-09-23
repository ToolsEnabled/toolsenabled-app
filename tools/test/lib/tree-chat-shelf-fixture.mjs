import { StaticTreeGraph } from '../../../src/tree-graph.js'
import { installDomStandIn } from './dom-stand-in.mjs'

// Mount the real shelf, chat, and tab controls. Only the DOM and tree layout
// context are reduced; opening, switching, hiding, and disposal use the graph.
export function treeChatShelfFixture(t, chatOptions = () => ({})) {
  const { document, restore } = installDomStandIn()
  document.querySelector = selector => document.body.querySelector(selector)
  const host = document.createElement('div')
  host.clientWidth = 1000
  host.clientHeight = 650
  document.body.appendChild(host)
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
    screenChips: true, W: 1000, H: 650, zoom: 1, panX: 0, panY: 0,
    computer: { id: 'shelf-fixture', agents: [] }, nodes: new Map(), emptySlots: new Map(),
    _culled: new Set(), _layoutVisibleIds: new Set(), zoomHost: host,
    treeChat: agent => ({ title: agent.name, seed: 0, onSend() {}, ...chatOptions(agent) }),
  })
  graph.chatToggle = document.createElement('button')
  host.appendChild(graph.chatToggle)
  graph._buildConversationShelf()
  graph.chatShelf.clientWidth = 1000
  // The full constructor registers this on document. The stand-in bubbles
  // through mounted elements, so keep the same handler at the shelf boundary.
  graph.chatShelf.addEventListener('keydown', event => graph._escapeTopChat(event))
  t.after(() => {
    graph._shelfResizeDispose?.()
    document.removeEventListener('pointerdown', graph._onChatPickerOutside)
    for (const record of graph.nodes.values()) graph._disposeChat(record)
    graph.chatShelf.remove()
    host.remove()
    restore()
  })
  const addCard = (id = 'controller') => {
    const chip = document.createElement('div')
    host.appendChild(chip)
    const record = { id, agent: { id, name: id, role: 'controller', treeNode: true }, chip, chatWidth: 0 }
    graph.nodes.set(id, record)
    graph.computer.agents.push(record.agent)
    graph._layoutVisibleIds.add(id)
    graph.openChat(record)
    return record
  }
  return { graph, document, host, addCard }
}
