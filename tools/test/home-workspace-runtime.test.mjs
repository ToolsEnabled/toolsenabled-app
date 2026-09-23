import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const world = installDomStandIn()
after(() => world.restore())
const { buildChat } = await import('../../src/components.js')
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const runtime = ['unregisterChatSurface', 'registerChatSurface', 'broadcastChatSpeech', 'scheduleChatSpeech', 'awaitTurnReply',
  'deliverTurnReply', 'imageConversationFor', 'treeChatConfigFor', 'broadcastWorkspaceOwnerMessage', 'workspaceStartReason']
  .map(name => declaredFunctionSource(source, name)).join('\n')

// Execute the shared observer and actual chat config against mounted buildChat
// roots. Transport and DOM are explicit fixtures; no provider or layout claim.
function fixture(t) {
  const frames = [], panes = [], nodes = new Map()
  const env = vm.createContext({
    destroyed: false, workspaceChats: new Set(), railChat: null,
    chatSurfaces: new Map(), chatSurfaceSessions: new WeakMap(), chatSpeech: new WeakMap(), chatSpeechMounts: new WeakMap(),
    chatSpeechPending: new Set(), chatSpeechFrame: 0, turnReplies: new Map(),
    sessionTurnText: new Map(), sessionOpenTurns: new Map(), sessionCompletedTurnIds: new Map(), sessionPendingApprovals: new Map(),
    standaloneSettledTurns: new Map(), nativeReconcileSessions: new Set(),
    sessionTranscripts: new Map(), nodeReplies: new Map(), nodeActivity: new Map(),
    sessionActions: new Map(), sessionModelOverride: new Map(),
    requestAnimationFrame: callback => { frames.push(callback); return frames.length },
    queueMicrotask,
    treeStore: { getNode: id => nodes.get(id) || { status: 'draft' } },
    nodeStartReason: () => '', composeUnavailableReason: () => '', composeStartUnavailableReason: () => '',
    treeChatHeaderMetaFor: () => null, treeNodeName: node => node.id,
    transcriptStore: null, restoreDiffHistory: (_id, lines) => lines.slice(),
    markTreeContext: lines => lines, mergeActionsIntoHistory: lines => lines,
    openChatDiff() {}, mockSource: () => false, nodeSessionLive: () => true, nodeBusy: () => false,
    ENDED_SESSION: { subtitle: 'Fixture ended session' }, PALETTE_PANEL: { footer: 'Fixture actions' },
    registerNodeStatusListener: () => () => {}, outboxList: () => [],
    chatActionRowsFor: () => [], commonChatActionsFor: () => [], currentConfinementLevel: null,
    SESSION_OUTBOX_EVENT: 'fixture-outbox', window: { addEventListener() {}, removeEventListener() {} },
    notePersonSpokeTo() {}, parseSlashCommand: () => null, outboxHoldForSend: () => ({ ok: true, direct: true }),
    treeCardSend(node, _text, handlers) {
      env.awaitTurnReply(node.sessionId, handlers.reply)
      handlers.accepted?.({ turnId: 'actual-turn' })
    },
  })
  vm.runInContext(runtime, env)
  function pane(sessionId) {
    const node = { id: `node-${panes.length}`, sessionId, status: 'finished' }
    nodes.set(node.id, node)
    const root = buildChat(env.treeChatConfigFor(node))
    document.body.appendChild(root)
    const surface = { sessionId, nodeId: node.id, root }
    env.workspaceChats.add(surface); panes.push(surface)
    t?.after(() => { root.dispose(); root.remove() })
    return { surface, root,
      replies: () => root.querySelectorAll('.them').map(row => row.querySelector('.chat-msg-text').textContent.trim()),
      owners: () => root.querySelectorAll('.me').map(row => row.querySelector('.chat-msg-text').textContent.trim()),
    }
  }
  return { env, pane, flush: () => { for (const frame of frames.splice(0)) frame() } }
}

test('four simultaneous conversations keep words and turn identity in their own mounted pane', async t => {
  const f = fixture(t), panes = Array.from({ length: 4 }, (_, index) => f.pane(`session-${index}`))
  await Promise.resolve() // the actual onReady-to-connected mount boundary
  for (let index = 0; index < 4; index++) {
    f.env.sessionOpenTurns.set(`session-${index}`, `turn-${index}`)
    f.env.sessionTurnText.set(`session-${index}`, `Words belonging to conversation ${index}`)
    f.env.scheduleChatSpeech(`session-${index}`)
  }
  f.flush()
  for (let index = 0; index < 4; index++) {
    assert.deepEqual(panes[index].replies(), [`Words belonging to conversation ${index}`])
    assert.equal(panes[index].root.querySelector('.them').querySelector('.turn-stamp').textContent, `turn-${index}`)
  }
  f.env.deliverTurnReply('session-1', 'Final answer for conversation 1', 'turn-1')
  assert.deepEqual(panes[1].replies(), ['Final answer for conversation 1'])
  assert.equal(panes[1].root.querySelectorAll('[aria-busy="true"]').length, 0)
  for (const index of [0, 2, 3]) assert.equal(panes[index].root.querySelector('.them').getAttribute('aria-busy'), 'true')
  panes[2].root.remove()
  f.env.sessionTurnText.set('session-2', 'Detached text must not be painted')
  f.env.sessionTurnText.set('session-3', 'Still streaming after a sibling closes')
  f.env.scheduleChatSpeech('session-2'); f.env.scheduleChatSpeech('session-3'); f.flush()
  assert.deepEqual(panes[2].replies(), ['Words belonging to conversation 2'])
  assert.deepEqual(panes[3].replies(), ['Still streaming after a sibling closes'])
  assert.equal(f.env.chatSurfaces.has('session-2'), false)
})

test('no-delta completion reaches both views once and suppresses the sender callback duplicate', async t => {
  const f = fixture(t), passive = f.pane('s'), sender = f.pane('s')
  const input = sender.root.querySelector('.chat-input input')
  input.value = 'Owner question'
  input.dispatch('input')
  sender.root.querySelector('.chat-send').click()
  for (let index = 0; index < 10; index++) await Promise.resolve()
  assert.equal(f.env.turnReplies.get('s')?.size, 1, 'the actual config registers the sending composer callback')
  f.env.deliverTurnReply('s', 'Completed without streaming', 'actual-turn')
  for (const pane of [passive, sender]) {
    assert.deepEqual(pane.replies(), ['Completed without streaming'])
    assert.equal(pane.root.querySelector('.them').querySelector('.turn-stamp').textContent, 'actual-turn')
    assert.equal(pane.root.querySelectorAll('[aria-busy="true"]').length, 0)
  }
  assert.equal(input.value, '', 'acceptance consumes the sending draft')
  assert.equal(f.env.turnReplies.has('s'), false)
  f.env.deliverTurnReply('s', 'Completed without streaming', 'actual-turn')
  f.env.deliverTurnReply('s', null)
  for (const pane of [passive, sender]) assert.deepEqual(pane.replies(), ['Completed without streaming'])
})

test('a re-registered pane leaves its previous session and receives only its current turn', async t => {
  const f = fixture(t), pane = f.pane('old-session')
  await Promise.resolve()
  f.env.broadcastChatSpeech('old-session', 'Previous partial', { turnId: 'old-turn' })
  f.env.registerChatSurface('new-session', pane.root)
  f.env.broadcastChatSpeech('old-session', 'Wrong late words', { turnId: 'old-turn' })
  f.env.deliverTurnReply('new-session', 'Current answer', 'new-turn')
  await Promise.resolve() // replay the completion retained during re-registration
  assert.deepEqual(pane.replies(), ['Previous partial', 'Current answer'])
  assert.equal(f.env.chatSurfaceSessions.get(pane.root), 'new-session')
  assert.equal(f.env.chatSurfaces.get('old-session')?.has(pane.root) || false, false)
})

test('accepted owner text reaches only another connected view of that same session', t => {
  const f = fixture(t), sender = f.pane('one'), sibling = f.pane('one'), unrelated = f.pane('two'), closed = f.pane('one')
  closed.root.remove()
  f.env.broadcastWorkspaceOwnerMessage('one', sender.surface, 'Follow up', { at: 42, turnStamp: 'next-turn' })
  assert.deepEqual(sender.owners(), [])
  assert.deepEqual(unrelated.owners(), [])
  assert.deepEqual(closed.owners(), [])
  assert.deepEqual(sibling.owners(), ['Follow up'])
  assert.equal(sibling.root.querySelector('.me').querySelector('.turn-stamp').textContent, 'next-turn')
})

test('direct Start is available only for an existing draft with the same launch gates as Computers', () => {
  const f = fixture()
  assert.equal(f.env.workspaceStartReason('node'), '')
  f.env.composeStartUnavailableReason = () => 'Starting agents is switched off.'
  assert.equal(f.env.workspaceStartReason('node'), 'Starting agents is switched off.')
  f.env.nodeStartReason = () => 'This agent is already starting.'
  assert.equal(f.env.workspaceStartReason('node'), 'This agent is already starting.')
  f.env.treeStore.getNode = () => ({ status: 'running' })
  assert.match(f.env.workspaceStartReason('node'), /already started/)
  f.env.treeStore.getNode = () => null
  assert.match(f.env.workspaceStartReason('node'), /no longer available/)
})
