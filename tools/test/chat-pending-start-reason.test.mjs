import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { CHAT_NOT_RUNNING } from '../../src/fleet-tree-copy.js'

const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const helpers = source.slice(source.indexOf('  function nodeStartReason(node)'), source.indexOf('  /* ONE chat config for a tree node'))
const configStart = source.indexOf('  function treeChatConfigFor(node)')
// Run the actual no-session branch, retaining its public component config.
const config = source.slice(configStart, source.indexOf('    let history = sessionTranscripts.get(', configStart)) + '\n}\n'

test('a mounted pending-node chat follows admission and pause reasons without remounting or enabling Send', async () => {
  const dom = installDomStandIn()
  const { buildChat } = await import('../../src/components.js')
  const listeners = new Set()
  const node = { id: 'pending-one', treeId: 'tree-one', role: 'worker', message: 'Preserve my brief.', sessionId: null }
  let state = { phase: 'queued', reason: '' }
  const context = vm.createContext({
    nodeLaunchQueues: new Map([[node.id, { queue: { nodeState: id => id === node.id ? state : null } }]]),
    treeLaunchQueues: new Map(), startingNodeIds: new Set(), treeStore: { getNode: () => node },
    transcriptStore: { get: () => null },
    nodeReplies: new Map(), treeChatHeaderMetaFor: () => null, treeNodeName: () => 'Worker',
    restoreDiffHistory: (_id, rows) => rows, openChatDiff() {}, CHAT_NOT_RUNNING,
    mockSource: () => false, commonChatActionsFor: () => [],
    chatActionRowsFor: () => [], PALETTE_PANEL: { footer: '' },
    registerNodeStatusListener: (_id, listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  })
  vm.runInContext(helpers + config, context)
  let chat
  try {
    const options = context.treeChatConfigFor(node)
    assert.equal(options.onSend, undefined)
    chat = buildChat(options)
    dom.document.body.appendChild(chat)
    const notice = chat.querySelector('.chat-nosend')
    const input = chat.querySelector('.chat-input input')
    const log = chat.querySelector('.chat-log')
    assert.match(notice.textContent, /queued/)
    chat.openActions()
    const filter = chat.querySelector('.chat-actions-filter')
    assert.ok(filter)
    filter.value = 'my unfinished search'
    state = { phase: 'waiting', reason: 'CPU < 97%; waiting for fresh memory.' }
    for (const listener of listeners) listener()
    assert.equal(chat.querySelector('.chat-log'), log)
    assert.equal(chat.querySelector('.chat-actions-filter'), filter)
    assert.equal(filter.value, 'my unfinished search')
    assert.match(notice.textContent, /CPU < 97%.*retry automatically/)
    assert.equal(input.getAttribute('aria-label'), notice.textContent)
    assert.equal(input.disabled, true)
    assert.equal(chat.querySelector('.chat-send').disabled, true)
    state = { phase: 'paused', reason: '' }
    for (const listener of listeners) listener()
    assert.match(notice.textContent, /paused.*brief is kept on this page/)
    assert.doesNotMatch(notice.textContent, /brief is saved/, 'an accepted in-memory draft is not evidence of a durable save')
    assert.equal(node.message, 'Preserve my brief.')
    assert.equal(node.statusNote, undefined, 'queue progress must not be persisted as a restartable session')
    state = null
    for (const listener of listeners) listener()
    assert.equal(notice.textContent, CHAT_NOT_RUNNING.neverStarted)
    chat.dispose()
    assert.equal(listeners.size, 0)
  } finally {
    chat?.dispose()
    // Let component-import preference hydration and queued DOM callbacks
    // settle before removing the test's document, just as a page stays present
    // while a chat is disposed. Rejections still fail the test normally.
    await new Promise(resolve => setImmediate(resolve))
    dom.restore()
  }
})
