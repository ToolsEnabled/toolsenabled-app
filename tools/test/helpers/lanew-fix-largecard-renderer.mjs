// Lane W fix (C): the actual StaticTreeGraph in Boxes, at Large, Medium and
// Mini, with a supplied thinking note. Only the DOM host is a substitute.
// Derived from the reviewed lanew-w3-cards-renderer.mjs.
import '../../../src/styles.css'
import '../../../src/tree-graph.css'
import '../../../src/tree-workspace.css'
import '../../../src/tree-card-density.css'
import { StaticTreeGraph } from '../../../src/tree-graph.js'
import { TREE_CONTEXT_CARDS_KEY } from '../../../src/tree-context-cards.js'

let graph
const task = 'Original request: examine all implementation details and retain this brief only until real progress is available.'
const chat = 'The latest verification is complete. The shared implementation preserves both operating systems and their saved preferences.'
const action = 'Read the shared account module and verified its state transitions.'
const thinking = 'Checking the remaining cases before reporting the final result.'
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
window.cards = {
  async mount(size, style) {
    graph?.destroy()
    document.body.innerHTML = '<main class="computers" style="height:100vh;max-width:none;width:100%;padding:12px;box-sizing:border-box"><div class="comp-body"><section class="graph-wrap" style="height:100%"><div class="graph-bar"><b>Lane W fix large cards</b><div class="graph-tools"></div></div><div class="graph-canvas-slot"><div id="graph"></div></div></section></div></main>'
    document.documentElement.dataset.theme = 'white'
    localStorage.setItem(TREE_CONTEXT_CARDS_KEY, JSON.stringify({ version: 1, defaultSize: size, trees: {} }))
    // Exactly one agent carries thinking, so "unchanged" can be told apart
    // from "nothing was rendered at all".
    const agents = ['Manager', 'Researcher'].map((name, i) => ({ id: `fixture-${i}`, name, role: name.toLowerCase(), declaredRole: name.toLowerCase(), state: 'running', treeNode: { id: `fixture-${i}`, treeId: `tree-${i}`, message: task } }))
    graph = new StaticTreeGraph(document.querySelector('#graph'), {
      computer: { id: 'isolated-cards', agents }, nodeStyle: style, screenChips: true, tabbedWorkspace: false, emptySlots: false,
      contextFeed: agent => ({ current: 'Working', task, chat, tool: action, thinking: agent.id === 'fixture-1' ? thinking : '' }),
      treeChat: agent => ({ title: agent.name, history: [], onSend: async () => {} }),
      onOpenControls: () => {}, onEmptyPress: () => {},
    })
    graph.setWide(true)
    await document.fonts.ready
    await settle(); graph.fitToHost(); await settle()
    return this.read()
  },
  async read() {
    await settle()
    const cards = [...graph.nodes.values()].filter(record => graph._layoutVisibleIds.has(record.id)).map(record => {
      const node = record.el
      const context = node.querySelector('.tree-box-context')
      const thinkingRow = context?.querySelector('.tree-box-thinking')
      const caption = thinkingRow?.querySelector('.tree-box-context-label')
      const thinkingText = thinkingRow?.querySelector('.tree-box-thinking-text')
      const body = context?.querySelector('p')
      const vis = n => Boolean(n && n.checkVisibility({ checkVisibilityCSS: true }))
      return {
        id: record.id,
        conversationLine: body?.textContent || '',
        conversationVisible: vis(body),
        thinkingRowPresent: Boolean(thinkingRow),
        thinkingVisible: vis(thinkingRow),
        captionText: vis(caption) ? (caption?.textContent || '') : '',
        thinkingText: thinkingText?.textContent || '',
        // Anything in the card that reads as the thinking note, wherever it sits.
        thinkingTextAnywhere: (context?.textContent || '').includes(thinking),
      }
    })
    return { actualSize: graph.cardSize, style: graph.nodeStyle, expectedThinking: thinking, expectedChat: chat, cards }
  },
  dispose() { graph?.destroy(); graph = null },
}
