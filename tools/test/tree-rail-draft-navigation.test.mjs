import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createDrafts, createRailView, functionSource } from './helpers/tree-rail-chat-harness.mjs'

const dom = installDomStandIn()
const { buildChat } = await import('../../src/components.js')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const nodeA = { id: 'fixture-node-a', sessionId: 'fixture-session-a' }
const nodeB = { id: 'fixture-node-b', sessionId: 'fixture-session-b' }
const inputOf = root => root.querySelector('.chat-input input')
const views = new Set()
function fixture(options = {}) {
  const view = createRailView({ buildChat, ...options })
  views.add(view)
  return view
}
test.afterEach(() => { for (const view of views) view.destroy(); views.clear() })
test.after(() => dom.restore())

test('the actual rail handoff restores an exact unsent draft, attachments and selection after route remount', async () => {
  const drafts = createDrafts()
  const pick = { ok: true, path: 'C:/Users/ToolsEnabled-Dev/fixture-only/chat-image.png', size: 42 }
  const first = fixture({ drafts, configFor: () => ({ onAttach: async () => pick }) })
  const chat = first.mount(nodeA)
  const input = inputOf(chat)
  input.value = '  Keep this unsent draft.  '
  input.setSelectionRange(3, 11)
  chat.querySelector('[data-chat-attach]').click(); await tick()
  const expected = chat.exportDraft()
  first.destroy()
  const second = fixture({ drafts })
  const restored = second.mount(nodeA)
  assert.deepEqual(restored.exportDraft(), expected)
  assert.equal(restored.querySelectorAll('.chat-attachment-chip').length, 1)
})

test('node switches and computer switches restore only their own draft', () => {
  const drafts = createDrafts()
  const view = fixture({ drafts })
  inputOf(view.mount(nodeA)).value = 'Node A only'
  const b = view.mount(nodeB)
  assert.equal(inputOf(b).value, '')
  inputOf(b).value = 'Node B only'
  assert.equal(inputOf(view.mount(nodeA)).value, 'Node A only')
  view.destroy()
  const otherComputer = fixture({ drafts, computerId: 'fixture-computer-b' })
  assert.equal(inputOf(otherComputer.mount(nodeA)).value, '')
  inputOf(otherComputer.rail().root).value = 'Other computer only'
  otherComputer.destroy()
  const returned = fixture({ drafts })
  assert.equal(inputOf(returned.mount(nodeA)).value, 'Node A only')
  assert.equal(inputOf(returned.mount(nodeB)).value, 'Node B only')
})

test('queue refusal retains its editable draft across remount, with no send', () => {
  const drafts = createDrafts()
  const calls = []
  const configFor = () => ({
    status: { busy: () => true, subscribe: () => () => {} },
    queue: { list: () => [], subscribe: () => () => {}, add: text => { calls.push(text); return { ok: false, sentence: 'Fixture queue refused.' } } },
    onSend: () => assert.fail('a refused queue must not send'),
  })
  const first = fixture({ drafts, configFor })
  const chat = first.mount(nodeA)
  inputOf(chat).value = 'Keep after queue refusal'
  chat.querySelector('.chat-send').click()
  assert.equal(inputOf(chat).value, 'Keep after queue refusal')
  assert.deepEqual(calls, ['Keep after queue refusal'])
  first.destroy()
  assert.equal(inputOf(fixture({ drafts, configFor }).mount(nodeA)).value, 'Keep after queue refusal')
})

test('successful send consumes the restored draft and attachments; remount never revives it', async () => {
  const drafts = createDrafts()
  const sent = []
  const first = fixture({ drafts })
  first.mount(nodeA).importDraft({ text: 'Send once', attachments: [{ path: 'C:/Users/ToolsEnabled-Dev/fixture-only/once.png' }], start: 0, end: 9 })
  first.destroy()
  const second = fixture({ drafts, configFor: () => ({ onSend: (text, handlers) => { sent.push({ text, attachments: handlers.attachments }); handlers.reply('Accepted') } }) })
  const chat = second.mount(nodeA)
  assert.equal(inputOf(chat).value, 'Send once')
  chat.querySelector('.chat-send').click(); await tick()
  assert.deepEqual(sent.map(row => row.text), ['Send once'])
  assert.equal(sent[0].attachments.length, 1)
  second.destroy()
  const returned = fixture({ drafts }).mount(nodeA)
  assert.equal(inputOf(returned).value, '')
  assert.deepEqual(returned.exportDraft().attachments, [])
})

test('clearing a restored draft replaces the saved value with empty', () => {
  const drafts = createDrafts()
  const first = fixture({ drafts })
  inputOf(first.mount(nodeA)).value = 'Erase intentionally'
  first.destroy()
  const second = fixture({ drafts })
  const chat = second.mount(nodeA)
  assert.equal(inputOf(chat).value, 'Erase intentionally')
  inputOf(chat).value = ''
  second.destroy()
  assert.equal(inputOf(fixture({ drafts }).mount(nodeA)).value, '')
})

test('an already queued edit is never restored as a new unsent message', async () => {
  const drafts = createDrafts()
  const first = fixture({ drafts })
  inputOf(first.mount(nodeA)).value = 'Original draft'
  first.destroy()
  const queued = [{ id: 'fixture-queued-a', text: 'Already waiting' }]
  let busy = false
  const second = fixture({ drafts, configFor: () => ({
    status: { busy: () => busy, subscribe: () => () => {} },
    queue: { list: () => queued, subscribe: () => () => {}, replace: () => ({ ok: true }) },
  }) })
  const chat = second.mount(nodeA)
  assert.equal(inputOf(chat).value, 'Original draft')
  chat.querySelector('.chat-send').click(); await tick()
  busy = true
  inputOf(chat).dispatch('keydown', { key: 'ArrowUp' })
  assert.equal(inputOf(chat).value, 'Already waiting')
  assert.equal(chat.exportDraft(), null, 'queue recall is deliberately not an unsent draft')
  second.destroy()
  assert.equal(inputOf(fixture({ drafts }).mount(nodeA)).value, '')
  assert.equal(queued[0].text, 'Already waiting')
})

test('a late old-view teardown cannot overwrite the newer owner of the same draft', () => {
  const drafts = createDrafts()
  const older = fixture({ drafts })
  inputOf(older.mount(nodeA)).value = 'Stale old rail'
  const newer = fixture({ drafts })
  inputOf(newer.mount(nodeA)).value = 'Newer typing'
  newer.destroy()
  older.destroy()
  assert.equal(inputOf(fixture({ drafts }).mount(nodeA)).value, 'Newer typing')
})

test('late reply, queued and refusal callbacks cannot overwrite another rail or newer typing', async () => {
  const drafts = createDrafts()
  let handlers
  const view = fixture({ drafts, configFor: () => ({ onSend: (_text, supplied) => { handlers = supplied } }) })
  const old = view.mount(nodeA)
  inputOf(old).value = 'Attempt from A'
  old.querySelector('.chat-send').click(); await tick()
  inputOf(old).value = 'Newer A draft'
  const other = view.mount(nodeB)
  inputOf(other).value = 'B draft stays here'
  const before = other.querySelector('.chat-log').textContent
  handlers.fail('Late refusal', { retract: true })
  handlers.reply('Late answer')
  handlers.queued('Late queue notice')
  assert.equal(inputOf(other).value, 'B draft stays here')
  assert.equal(other.querySelector('.chat-log').textContent, before)
  assert.equal(inputOf(view.mount(nodeA)).value, 'Newer A draft', 'do not revive the attempted message over later edits')
})

test('the actual removal boundary forgets a removed node draft and preserves it on refusal', async () => {
  for (const accepted of [false, true]) {
    const drafts = createDrafts()
    const view = fixture({ drafts })
    const node = { id: nodeA.id, status: 'finished' }
    inputOf(view.mount(node)).value = 'Draft on removable node'
    const context = view.context
    Object.assign(context, {
      treeStore: { getNode: () => node, childrenOf: () => [], removeNode: () => ({ ok: accepted, problems: ['Fixture refusal'] }) },
      destroyed: false, nodeCleanupPending: () => false, nodeBusy: () => false,
      startDraftFlight: { busy: () => false }, nodeReplacementFlight: { busy: () => false }, treeNodeName: () => 'Fixture node',
      RUN_NODE_REMOVAL_CLOSE_RECEIPTS: new Map(), setOrgStatus() {}, releaseSeatForNode: async () => false,
      diffHistoryStore: null, nodeDiffHistories: new Map(), nodeReplies: new Map(), nodeActivity: new Map(), nodeLastTool: new Map(),
      graph: null, currentRailTreeNode: null, refreshTree() {}, REMOVE_PANEL: { done: () => 'Removed' },
    })
    vm.runInContext(functionSource('performNodeRemoval'), context)
    assert.equal(await context.performNodeRemoval(node), accepted)
    view.destroy()
    const returned = fixture({ drafts }).mount(node)
    assert.equal(inputOf(returned).value, accepted ? '' : 'Draft on removable node')
  }
})
