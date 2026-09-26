import '../../../src/styles.css'
import '../../../src/tree-graph.css'
import '../../../src/tree-workspace.css'
import { StaticTreeGraph } from '../../../src/tree-graph.js'
import { TreeWindows } from '../../../src/tree-windows.js'
import { TREE_CONTEXT_CARDS_KEY } from '../../../src/tree-context-cards.js'

let graph
const events = []
const task = 'Original request: examine all implementation details and retain this brief only until real progress is available.'
const chat = '# Earlier response\n\n' + '- **Earlier** public context.\n'.repeat(160) + '\nThe latest verification is complete. Newest result.'
const action = 'Read the shared account module and verified its state transitions.'
const thinking = 'INTERNAL_REASONING_SENTINEL'
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom, right:r.right } }
const tail = content => {
  const text = content.firstChild
  const range = document.createRange()
  range.setStart(text, Math.max(0, text.length - 1)); range.setEnd(text, text.length)
  const end = rect(range), viewport = rect(content)
  return { end, viewport, scrollTop: content.scrollTop,
    scrollBottomGap: content.scrollHeight - content.clientHeight - content.scrollTop,
    endVisible: end.bottom <= viewport.bottom + 1 && end.y >= viewport.y - 1 }
}

window.cardLayout = {
  async measure(size, style, camera = 1) {
    graph?.destroy()
    document.body.innerHTML = `<main class="computers" style="height:100vh;max-width:none;width:100%;padding:12px;box-sizing:border-box"><div class="comp-body"><section class="graph-wrap" style="height:100%;border:1px solid var(--line-2)"><div class="graph-bar"><b>Isolated card layout</b><div class="graph-tools"></div></div><div class="graph-canvas-slot"><div id="graph"></div></div></section><aside class="rail"><p>Isolated side panel</p></aside></div></main>`
    document.documentElement.dataset.theme = 'white'
    const saved = JSON.stringify({ version: 1, defaultSize: size, trees: {} })
    localStorage.setItem(TREE_CONTEXT_CARDS_KEY, saved)
    let response = chat, fallback = null
    const agents = ['Manager', 'Researcher'].map((name, i) => ({ id: `fixture-${i}`, name, role: name.toLowerCase(), declaredRole: name.toLowerCase(), state: 'running', treeNode: { id: `fixture-${i}`, treeId: `tree-${i}`, message: task } }))
    graph = new StaticTreeGraph(document.querySelector('#graph'), {
      computer: { id: 'isolated-cards', agents }, nodeStyle: style, screenChips: true, tabbedWorkspace: true, emptySlots: false,
      contextFeed: agent => ({ current: 'Working', task: fallback || task, previous: fallback ? 'asked: ' + fallback : null, chat: response, tool: action, thinking: agent.id === 'fixture-1' ? thinking : '' }),
      treeChat: agent => ({ title: agent.name, history: [], onSend: async (_text, handlers) => handlers.reply('Synthetic reply.') }),
      onOpenControls: agent => events.push({ kind: 'open', id: agent.id }), onEmptyPress: event => events.push({kind:'add',id:event.parentId})
    })
    graph.setWide(true)
    await document.fonts.ready
    await settle(); graph.fitToHost(); await settle()
    graph._cancelZoomMotion(); graph.zoom = camera; graph._applyZoom(); await settle()
    const cards = [...graph.nodes.values()].filter(record => graph._layoutVisibleIds.has(record.id)).map(record => {
      const node = style === 'boxes' ? record.el : record.chip
      const body = node.querySelector(style === 'boxes' ? '.tree-box-context' : '.chip-preview-activity')
      const content = body.querySelector(style === 'boxes' ? 'p' : '.cl-chat .chip-context-text')
      // Circles caption the working note with .cl-thinking; Boxes now have
      // their own captioned row at Large. Both are "the thinking region", and
      // the probe has to see both or the suite reads a real captioned row as a
      // stray label with no region behind it.
      const thinkingNode = body.querySelector('.cl-thinking, .tree-box-thinking')
      const thinkingVisible = thinkingNode?.checkVisibility({ checkVisibilityCSS: true }) || false
      const actionNode = node.querySelector(style === 'boxes' ? '.tree-box-latest-action' : '.chip-preview-header .chip-latest-action')
      const contentStyle = getComputedStyle(content)
      return { id: record.id, node:rect(node), body:rect(body), content:rect(content), action:rect(actionNode),
        text:content.textContent, tail:tail(content), internalReasoningVisible:body.textContent.includes(thinking), actionText:actionNode.textContent, contentFont:parseFloat(contentStyle.fontSize),
        line:parseFloat(contentStyle.lineHeight), clamp:Number(contentStyle.webkitLineClamp),
        labels:[...node.querySelectorAll('.chip-context-caption,.tree-box-context-label,.tree-box-open-hint,.cl-open')].filter(el => el.checkVisibility({checkVisibilityCSS:true})).map(el=>el.textContent),
        contentOnlyOnce:node.textContent.split(content.textContent).length === 2,
        thinking: thinkingVisible ? rect(thinkingNode) : null,
        containsOriginalTask:body.textContent.includes('Original request'),
        accessible:!!node.getAttribute('aria-label') && node.tabIndex >= 0,
        headerAction:actionNode.getBoundingClientRect().bottom <= body.getBoundingClientRect().y + 1 }
    })
    const streamed = []
    for (const ending of ['Newest streamed commentary.', 'Final public response.']) {
      response += '\n\n' + ending
      for (const record of graph.nodes.values()) graph.refreshChip(record.id)
      await settle()
      for (const record of graph.nodes.values()) {
        if (!graph._layoutVisibleIds.has(record.id)) continue
        const node = style === 'boxes' ? record.el : record.chip
        const content = node.querySelector(style === 'boxes' ? '.tree-box-context > p' : '.cl-chat .chip-context-text')
        streamed.push({ id: record.id, ending, text: content.textContent, tail: tail(content) })
      }
    }
    const equalTransitions = []
    if (style === 'boxes') {
      const originalResponse = response
      fallback = 'Earlier public context. '.repeat(160) + 'LATEST EQUAL RESPONSE.'
      response = ''
      for (const record of graph.nodes.values()) graph.refreshChip(record.id)
      await settle()
      const sample = () => [...graph.nodes.values()].filter(record => graph._layoutVisibleIds.has(record.id)).map(record => {
        const content = record.el.querySelector('.tree-box-context > p')
        return { id: record.id, text: content.textContent, tail: tail(content) }
      })
      const before = sample()
      response = fallback
      for (const record of graph.nodes.values()) graph.refreshChip(record.id)
      await settle()
      const publicResponse = sample()
      for (const record of graph.nodes.values()) graph.refreshChip(record.id)
      await settle()
      const unchanged = sample()
      for (let i = 0; i < before.length; i++) equalTransitions.push({
        before: before[i], publicResponse: publicResponse[i], unchanged: unchanged[i],
      })
      fallback = null; response = originalResponse
      for (const record of graph.nodes.values()) graph.refreshChip(record.id)
      await settle()
    }
    return {size,style,camera,cards, streamed, equalTransitions, savedUnchanged:localStorage.getItem(TREE_CONTEXT_CARDS_KEY)===saved, actualSize:graph.cardSize}
  },
  focusCard() { const record=[...graph.nodes.values()].find(record=>graph._layoutVisibleIds.has(record.id)); (graph.nodeStyle==='boxes'?record.el:record.chip).focus(); return events.length },
  chatIsOpen() { return [...graph.nodes.values()].some(record => record.chatOpen) },
  keyboardEvents() { return events.slice() },
  async toolbarMini() {
    await this.measure('medium', 'boxes')
    graph.treeWindows = new TreeWindows(graph, { getTrees: () => graph.computer.agents.map(agent => ({ rootId: agent.id, name: agent.name, rootName: agent.name, description: '', count: 1 })) })
    await settle()
    const selector = document.querySelector('.tree-card-size-select')
    const options = [...selector.options].map(option => option.value)
    selector.value = 'mini'
    selector.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    const selected = { value: selector.value, actualSize: graph.cardSize, policy: JSON.parse(localStorage.getItem(TREE_CONTEXT_CARDS_KEY)) }
    const action = document.querySelector('.tree-box-latest-action')
    const context = document.querySelector('.tree-box-context > p')
    return { options, selected, latestAction: action?.textContent, context: context?.textContent }
  },
  dispose() { graph?.destroy(); graph=null }
}
