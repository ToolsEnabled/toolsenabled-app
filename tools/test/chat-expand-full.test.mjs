import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

/* The full-window chat expansion, the braces, and the top-row spacing.
 *
 * WHAT THE OWNER ASKED FOR, and the sentence that shaped the implementation:
 * "when the chat expands it just covers the tree fully -- the tree keeps
 * working behind it." The later shared-tab design keeps that invariant:
 * Trees and agent conversations share a workspace, while returning to Trees
 * retains the mounted chats and their drafts. Only explicit tab closure
 * disposes a chat. These lifecycle checks drive the real graph/workspace
 * methods and composers in a DOM stand-in; browser fixtures own painted
 * geometry and native keyboard/pointer behavior.
 */

const read = relative => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')

test('the expand control exists and is the close button\'s twin, not a new vocabulary', async t => {
  const { restore } = installDomStandIn()
  let chat
  t.after(() => { chat?.dispose(); restore() })
  const { buildChat } = await import('../../src/components.js')
  let expanded = 0
  chat = buildChat({ title: 'Agent', onExpand: () => { expanded += 1 }, onClose() {} })
  const expand = chat.querySelector('.chat-expand')
  assert.ok(expand, 'buildChat renders an expand control')
  assert.equal(expand.getAttribute('aria-label'), 'Expand to fill the tree',
    'it says what it does in words a screen reader can use, not only in an icon')
  assert.equal(expand.getAttribute('aria-pressed'), 'false',
    'it is a TOGGLE and announces its state -- a button that changes what it does on the second press must say so')
  let stopped = 0
  expand.dispatch('click', { stopPropagation() { stopped += 1 } })
  assert.equal(expanded, 1, 'pressing expand forwards the request to the card owner')
  assert.equal(stopped, 1, 'pressing expand does not also activate the card beneath it')

  const styles = read('src/styles.css')
  assert.match(styles, /\.chat-close, \.chat-expand \{/,
    'it shares the close button\'s footprint rather than declaring a second one')
  assert.match(styles, /\.chat-close:focus-visible, \.chat-expand:focus-visible/,
    'and its focus ring, so keyboard users get the same affordance on both header controls')
})

function tabbedChatFixture(t) {
  const { document, restore } = installDomStandIn()
  document.querySelector = selector => document.body.querySelector(selector)
  const host = document.createElement('div'), canvas = document.createElement('div')
  host.clientWidth = 1000; host.clientHeight = 650
  host.appendChild(canvas); document.body.appendChild(host)
  // The small shared stand-in has insertBefore but does not expose before().
  host.before = node => host.parentNode.insertBefore(node, host)
  const subject = Object.assign(Object.create(StaticTreeGraph.prototype), {
    tabbedWorkspace: true, computer: { id: 'chat-full-contract', agents: [] },
    nodes: new Map(), emptySlots: new Map(), _layoutVisibleIds: new Set(), zoomHost: host,
    zoom: 0.8, panX: 18, panY: 24, rootId: null, _treeWide: false,
    setWide(wide) { this._treeWide = wide }, resize() {}, _applyZoom() {}, _placeChips() {},
    treeChat: agent => ({ title: agent.name, seed: 0, onSend() {},
      status: { busy: () => false, subscribe: () => () => { subject.nodes.get(agent.id).disposals++ } } }),
  })
  subject._buildConversationShelf()
  const query = subject.chatTabs.querySelectorAll.bind(subject.chatTabs)
  // Support the attribute conjunction used to find pinned agent tabs. The
  // stand-in otherwise intentionally accepts only one attribute selector.
  subject.chatTabs.querySelectorAll = selector => {
    const attributes = selector.match(/\[[^\]]+\]/g)
    return attributes?.join('') === selector
      ? query(attributes[0]).filter(node => attributes.every(attribute => node.matches(attribute)))
      : query(selector)
  }
  const add = id => {
    const node = document.createElement('div'), chip = document.createElement('div')
    node.textContent = `${id}: waiting`; canvas.append(node, chip)
    const record = { id, agent: { id, name: id, role: 'default', treeNode: { id } }, el: node, chip, disposals: 0 }
    subject.nodes.set(id, record); subject.computer.agents.push(record.agent); subject._layoutVisibleIds.add(id)
    subject.openChat(record)
    return record
  }
  t.after(() => {
    for (const record of subject.nodes.values()) if (record.chatOpen) subject._disposeChat(record)
    subject.workspace.root.remove()
    restore()
  })
  const tabs = () => subject.chatTabs.querySelectorAll('[role="tab"][data-agent-id]')
  return { subject, workspace: subject.workspace, host, canvas, add, tabs, document }
}

test('returning from a chat uncovers the live tree without tearing down its canvas or composer', t => {
  const graph = read('src/tree-graph.js')
  for (const forbidden of [/pauseTick|_paused\b/, /this\.tree\.hidden\s*=/, /cancelAnimationFrame\(\s*this\._full/]) {
    assert.doesNotMatch(graph, forbidden,
      `expansion must not pause or tear down the tree: found ${forbidden}`)
  }
  const { subject, workspace, host, canvas, add, tabs } = tabbedChatFixture(t)
  const record = add('Controller'), chat = record.chatRoot, panel = record.chatPanel
  const input = chat.querySelector('.chat-input input')
  input.value = 'Keep the current review draft'
  assert.equal(workspace.mode, 'chat')
  assert.equal(panel.hidden, false)
  assert.equal(host.inert, true, 'the covered canvas cannot receive accidental input')
  assert.equal(host.hidden, false)
  assert.equal(canvas.isConnected, true)
  record.el.textContent = 'Controller: review complete'
  subject.toggleChatFull(record)
  assert.equal(workspace.mode, 'trees')
  assert.equal(host.inert, false)
  assert.equal(host.firstElementChild, canvas)
  assert.deepEqual([host.clientWidth, host.clientHeight], [1000, 650])
  assert.equal(canvas.isConnected, true)
  assert.equal(record.el.textContent, 'Controller: review complete')
  assert.equal(record.chatRoot, chat)
  assert.equal(record.chatPanel, panel)
  assert.equal(panel.isConnected, true)
  assert.equal(panel.hidden, true)
  assert.equal(input.value, 'Keep the current review draft')
  assert.equal(record.disposals, 0)
  tabs()[0].click()
  assert.equal(workspace.mode, 'chat')
  assert.equal(record.chatRoot, chat)
  assert.equal(panel.hidden, false)
})

test('one shared chat tab is visible and explicit closure disposes only that chat while saving its draft', t => {
  const { subject, workspace, add, tabs } = tabbedChatFixture(t)
  const first = add('Controller'), second = add('Reviewer')
  const firstRoot = first.chatRoot, firstPanel = first.chatPanel, secondRoot = second.chatRoot
  firstRoot.querySelector('.chat-input input').value = 'Unsent controller notes'
  const draft = firstRoot.exportDraft()
  assert.equal(firstPanel.hidden, true)
  assert.equal(second.chatPanel.hidden, false)
  tabs().find(tab => tab.dataset.agentId === first.id).click()
  assert.equal(firstPanel.hidden, false)
  assert.equal(second.chatPanel.hidden, true)
  assert.equal(first.chatFull, true)
  assert.equal(second.chatFull, false)
  assert.equal(first.chatRoot, firstRoot)
  assert.equal(second.chatRoot, secondRoot)
  subject.closeChat(first)
  assert.equal(firstPanel.isConnected, false)
  assert.equal(first.chatRoot, null)
  assert.equal(first.chatPanel, null)
  assert.equal(first.chatOpen, false)
  assert.equal(first.chatPinned, false)
  assert.equal(first.chatFull, false)
  assert.equal(first.disposals, 1)
  assert.deepEqual(subject.chatDrafts.get(first.id), draft)
  assert.equal(subject.nodes.get(first.id), first, 'closing a conversation cannot delete its tree agent')
  assert.equal(second.chatRoot, secondRoot)
  assert.equal(second.disposals, 0)
  assert.equal(second.chatPanel.hidden, false)
  assert.equal(subject.activeChatId, second.id)
  assert.equal(workspace.mode, 'chat')
  assert.deepEqual(tabs().map(tab => tab.dataset.agentId), [second.id])
})

test('Escape returns to Trees and repeated Escape preserves every chat tab and draft', t => {
  const { subject, workspace, add, tabs, document } = tabbedChatFixture(t)
  const first = add('Controller'), second = add('Reviewer')
  const roots = [first.chatRoot, second.chatRoot]
  roots[1].querySelector('.chat-input input').value = 'Review still being written'
  const event = target => ({ key: 'Escape', target, preventDefault() { this.defaultPrevented = true } })
  const firstEscape = event(second.chatPanel)
  workspace.keydown(firstEscape)
  assert.equal(firstEscape.defaultPrevented, true)
  assert.equal(workspace.mode, 'trees')
  assert.equal(document.activeElement, workspace.home)
  workspace.keydown(event(workspace.home))
  assert.equal(workspace.mode, 'trees')
  assert.equal(tabs().length, 2)
  for (const [index, record] of [first, second].entries()) {
    assert.equal(record.chatRoot, roots[index])
    assert.equal(record.chatPanel.isConnected, true)
    assert.equal(record.chatPanel.hidden, true)
    assert.equal(record.chatOpen, true)
    assert.equal(record.disposals, 0)
  }
  tabs().find(tab => tab.dataset.agentId === second.id).click()
  assert.equal(workspace.mode, 'chat')
  assert.equal(second.chatRoot.querySelector('.chat-input input').value, 'Review still being written')
  subject.closeChat(second)
  subject.closeChat(first)
  assert.equal(tabs().length, 0)
  assert.equal(workspace.mode, 'trees')
})

test('the braces are the standard chip\'s costume only', () => {
  const css = read('src/tree-graph.css')
  assert.match(css, /\.static-tree-chip\.as-chat \.monitor-brace \{ display: none; \}/,
    'braces are hidden the moment the chip becomes a conversation')
  /* as-chat-full always co-exists with as-chat, so one rule covers both views.
     Asserted so a future author does not add a second, divergent rule. */
  assert.doesNotMatch(css, /as-chat-full[^\n]*monitor-brace/,
    'and no separate rule for the full view -- as-chat-full always carries as-chat, so one rule covers both')
  assert.match(css, /monitorBrace\(\)|monitor-brace/, 'the collapsed chip still has them')

  const graph = read('src/tree-graph.js')
  assert.match(graph, /\$\{monitorBrace\(\)\}<div class="chip-preview"><\/div>\$\{monitorBrace\(true\)\}/,
    'the standard chip still renders both braces -- image 1 is unchanged')
})

test('the top row cannot rise into the band the graph header owns', async () => {
  /* THE ONE CLAIM HERE THAT IS DRIVEN WITH VALUES rather than read.
     padTop could give 40px (104 -> 64) while tree-graph reserves the top 72px
     as SCREEN_TOP for the title, crumb and tools. So on a short canvas the
     FIRST row's centre rose above the header while every row below kept an
     even pitch -- one row crowding the title and the rest evenly spaced, which
     is the inconsistency, not a spacing preference. */
  const { layoutTree } = await import('../../src/tree-layout.js')
  const nodes = [
    { id: 'a', role: 'coordinator', name: 'A', bornAt: 1, tierRank: 0 },
    { id: 'b', role: 'manager', name: 'B', bornAt: 1, tierRank: 1 },
    { id: 'c', role: 'helper', name: 'C', bornAt: 1, tierRank: 2 },
    { id: 'd', role: 'helper', name: 'D', bornAt: 1, tierRank: 3 },
  ]
  /* Several heights, because the defect only appears under a DEFICIT: on a
     roomy canvas padTop never gives anything and the bug is invisible. 420 is
     the short case that produced it; the taller ones prove the floor did not
     break the ordinary path. */
  for (const H of [400, 420, 520, 700]) {
    const result = layoutTree({ nodes, W: 1024, H })
    const rowYs = [...(result?.rowYs || [])]
    assert.ok(rowYs.length > 0, `layout produced rows at H=${H}`)
    const highest = Math.min(...rowYs)
    assert.ok(highest >= 72,
      `at H=${H} the topmost row centre is ${highest}, inside the 72px header band the graph always draws over`)
  }
})

test('the header band and SCREEN_TOP are the same number, and cannot drift apart', () => {
  /* Two files hold this number and neither imports the other: tree-layout takes
     no dependency on the graph module. So the guard is here. Without it the two
     drift silently and the top row starts crowding the title again months
     later, with nothing to point at. */
  const layout = read('src/tree-layout.js')
  const graph = read('src/tree-graph.js')
  const band = /const HEADER_BAND = (\d+)/.exec(layout)
  const screenTop = /const SCREEN_TOP = (\d+)/.exec(graph)
  assert.ok(band && screenTop, 'both constants are declared and findable')
  assert.equal(band[1], screenTop[1],
    `tree-layout's HEADER_BAND (${band?.[1]}) must equal tree-graph's SCREEN_TOP (${screenTop?.[1]}) -- they describe the same band of pixels from two files that cannot import each other`)
})
