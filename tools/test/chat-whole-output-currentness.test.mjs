// T736 synthetic whole-output reproduction through the maintained tree event consumer and buildChat.
// Harness adapted from tree-empty-turn-transcript; no provider, owner state or filesystem writes.
import { createConfirmedFileChangeBuffer } from '../../src/session-change-patches.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after } from 'node:test'
import { parseAst } from 'rollup/parseAst'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import * as sessionEvents from '../../src/agent-session-events.js'
import { createTurnInterrupts } from '../../src/turn-interrupts.js'
import { acceptRemoteSequence } from '../../src/remote-session-history.js'
import { turnCompletionWords, TURN_FAILED, ENDED_SESSION, PALETTE_PANEL, actionRowWords, activityLine, foldedActionsLine } from '../../src/fleet-tree-copy.js'
import { parseSlashCommand } from '../../src/slash-commands.js'
import { stopStillOwnsNode } from '../../src/stop-node-session.js'
import { stopNativePersonSession } from '../../src/native-person-stop.js'
import { withResearchTreeBinding } from '../../src/research-tree-session.js'

const world = installDomStandIn()
// Browser animation frames run after registration; synchronous callbacks leave
// the action painter's scheduled-frame flag stuck after its first update.
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
after(async () => { await new Promise(resolve => setTimeout(resolve, 60)); world.restore() })
const { buildChat } = await import('../../src/components.js')
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
let eventSource, eventDispatcher, actionRowSource
function visit(node) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'FunctionDeclaration' && node.id?.name === 'actionChatRow') {
    assert.equal(actionRowSource, undefined)
    actionRowSource = source.slice(node.start, node.end)
  }
  if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && node.left.name === 'handleAgentEvent') {
    assert.equal(eventDispatcher, undefined, 'the shared live/history dispatcher must be unique')
    eventDispatcher = source.slice(node.right.start, node.right.end)
  }
  if (node.type === 'CallExpression' && source.slice(node.callee.start, node.callee.end) === 'window.mcAgent.onEvent') {
    assert.equal(eventSource, undefined, 'the actual tree session event consumer must be unique')
    eventSource = source.slice(node.arguments[0].start, node.arguments[0].end)
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') visit(value)
  }
}
visit(parseAst(source))
assert.ok(eventSource && eventDispatcher)

// The live native failure stopped named provider turns before a delta/tool
// event existed. Execute the maintained event consumer, broadcaster, transcript
// append and actual buildChat stream together. Only DOM, store/IPC boundaries
// and input events are fixtures; this does not claim native/provider coverage.
function fixture(t) {
  const sessionId = 'selected-session'
  const node = { id: 'selected-child', sessionId, status: 'running', reply: '' }
  const chat = buildChat({ title: 'Selected child', history: [], seed: 0, composerReason: 'Controlled event fixture.' })
  const unrelated = buildChat({ title: 'Unrelated child', history: [], seed: 0, composerReason: 'Controlled event fixture.' })
  document.body.appendChild(chat); document.body.appendChild(unrelated)
  t.after(() => { chat.dispose(); unrelated.dispose(); chat.remove(); unrelated.remove() })
  const statusChanges = [], captures = [], frames = [], sends = [], closes = []
  let drains = 0
  const scope = {
    source: 'local', stopNativePersonSession, withResearchTreeBinding,
    actionRowWords, activityLine, foldedActionsLine,
    pendingModelChoice: () => null, applyPendingModelChoice: async () => false,
    nodeThinking: new Map(), nodeLastTool: new Map(),
    publishProviderModeEvent() {}, // Provider-menu refresh is outside this transcript fixture.
    requestAuthoritativeDesktopTree() { assert.fail('A local event fixture must not request a relay tree') },
    sessionTextReader: sessionEvents.createSessionTextReader(),
    ...sessionEvents, createTurnInterrupts, turnCompletionWords, TURN_FAILED, ENDED_SESSION, PALETTE_PANEL,
    parseSlashCommand, stopStillOwnsNode, acceptRemoteSequence,
    remotePendingPackets: new Map(), remoteAppliedSequences: new Map(), replayingRemoteHistory: false,
    // The native reconnect's probe buffer and the sessions whose rejoined turn
    // its capture reconciles: read by the same subscription and dispatcher.
    nativePendingPackets: new Map(), nativeReconcileSessions: new Set(),
    reconcileRecoveredTurn: async () => {},
    confirmedFileChanges: createConfirmedFileChangeBuffer(),
    chatWorkspace: false, workspaceChats: new Set(),
    destroyed: false, sessionNodeIds: new Map([[sessionId, node.id]]), sessionTurnText: new Map(),
    sessionOpenTurns: new Map(), sessionActions: new Map(), sessionPendingApprovals: new Map(),
    sessionBreakPending: new Set(), sessionTranscripts: new Map(), sessionUsage: new Map(),
    confirmedRefusals: new Map(),
    sessionProfileIds: new Map(), sessionEfforts: new Map(), sessionThreadIds: new Map(), sessionAccountNames: new Map(),
    sessionPendingImages: new Map(), sessionModelOverride: new Map(), sessionRuleCalls: new Map(), sessionTurnLog: new Map(),
    RUN_SESSION_CLEANUPS: new Map(), RUN_NODE_REMOVAL_CLOSE_RECEIPTS: new Map(), RUN_NATIVE_WORK_CLOSE_LISTENERS: new Set(),
    /* The turn id each session last settled. The completion handler records it
       and treeCardSend reads it, so a send receipt that resolves after its own
       turn ended does not mark the node running again. */
    sessionCompletedTurnIds: new Map(),
    standaloneSettledTurns: new Map(), turnInterrupts: createTurnInterrupts(), turnReplies: new Map(), nodeActivity: new Map(),
    nodeReplies: new Map(), chatSurfaces: new Map([[sessionId, new Set([chat])], ['unrelated-session', new Set([unrelated])]]),
    chatSurfaceSessions: new WeakMap(), chatSpeech: new WeakMap(), chatSpeechMounts: new WeakMap(), chatSpeechPending: new Set(), chatSpeechFrame: 0,
    TRANSCRIPT_MAX_ENTRIES: 60, transcriptStore: { get: () => null, capture: (id, row) => { captures.push({ nodeId: id, ...row }) } },
    persistTranscript: () => {},
    treeStore: {
      snapshot: () => ({ nodes: [{ ...node }] }),
      getNode: id => id === node.id ? node : null,
      setNodeReply: (id, reply) => { assert.equal(id, node.id); node.reply = reply },
      setNodeStatus: (id, status, options = {}) => {
        assert.equal(id, node.id); node.status = status; node.statusNote = options.note
        statusChanges.push({ status, reply: node.reply, visible: chat.querySelectorAll('.them').map(row => row.querySelector('.chat-msg-text').textContent.trim()) })
      },
    },
    currentRailTreeNode: null, railSaid: null, railChat: null,
    clearInlineApproval: () => {}, recordTurnActions: () => {}, refreshTree: () => {},
    clearSessionApprovals: () => {},
    statusNote: text => text, notifyNodeStatusListeners: () => {},
    nodeReplacementFlight: { busy: () => false },
    // Stop consults the account recovery coordinator (d839fa41); this fixture runs with none.
    recoveryCoordinator: () => null,
    outboxTakeNext: () => { drains++; return null },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length },
    scheduleChipRefresh: () => {},
    nodeBusy: value => value.status === 'running', notePersonSpokeTo: () => {},
    outboxClearSession: () => 0,
    controlsPage: { classList: { contains: () => false } },
    window: { mcAgent: {
      send: async request => { sends.push(request); return { sessionId, turnId: 'accepted-before-text' } },
      close: async request => { closes.push(request); return { sessionId, closed: true } },
    } },
  }
  const names = ['actionBufferFor', 'sameMetricSnapshot', 'actionChatRow', 'actionTimingFields', 'broadcastAction', 'unregisterChatSurface', 'broadcastChatSpeech', 'scheduleChatSpeech', 'deliverTurnReply', 'awaitTurnReply', 'dropTurnReply',
    'transcriptAppend', 'settleTurnBoundary', 'markTurnRunning', 'turnLogAppend', 'treeCardSend',
    'settleStoppedSession', 'retireTreeSessionRuntime', 'resetSessionMetrics', 'runPaletteAction', 'closePersonNode']
  const functions = names.map(name => name === 'actionChatRow' ? actionRowSource : declaredFunctionSource(source, name)).join('\n')
  const api = new Function(...Object.keys(scope), `${functions}; const handleAgentEvent = ${eventDispatcher}; return {
    packet: ${eventSource}, broadcast: broadcastChatSpeech, awaitReply: awaitTurnReply,
    send: treeCardSend, action: runPaletteAction, settleStopped: settleStoppedSession,
  }`)(...Object.values(scope))
  const packet = async event => {
    await api.packet({ sessionId, event })
    while (frames.length) frames.shift()()
  }
  // The documented stand-in supports a single class per selector. Read the
  // actual agent row first, then its real body; do not invent selector support.
  const replies = () => chat.querySelectorAll('.them').map(row => row.querySelector('.chat-msg-text').textContent.trim())
  const lines = () => scope.sessionTranscripts.get(sessionId) || []
  const stopped = async (turnId, event = {}) => {
    await scope.turnInterrupts.request(sessionId, scope.sessionOpenTurns.get(sessionId), async () => ({ ok: true, turnId }))
    await packet({ type: 'turn_completed', status: 'interrupted', ...(turnId ? { turnId } : {}), ...event })
  }
  const send = () => new Promise((resolve, reject) => api.send(node, 'Stop this accepted turn before it says anything.', {
    accepted: resolve, reply: () => {}, fail: sentence => reject(new Error(sentence)),
  }))
  return { api, packet, stopped, send, replies, lines, chat, unrelated, node, scope, captures, statusChanges, sends, closes, drains: () => drains };
}

const complete = (f, turnId = 'turn-current') => f.packet({ type: 'turn_completed', turnId, status: 'completed' })
const whole = (f, text, { turnId = 'turn-current', itemId = 'message-current' } = {}) =>
  f.packet({ type: 'assistant_text', turnId, itemId, text })
const delta = (f, text, { turnId = 'turn-current', itemId = 'message-current' } = {}) =>
  f.packet({ type: 'assistant_text_delta', turnId, itemId, text })
function restoredChat(t, history) {
  const chat = buildChat({ title: 'Restored synthetic conversation', history, seed: 0, composerReason: 'Read-only fixture.' })
  document.body.appendChild(chat)
  t.after(() => { chat.dispose(); chat.remove() })
  return chat
}

test('whole-only provider output reaches the selected chat before completion and survives history reload', async t => {
  const f = fixture(t)
  const text = '## Current answer\n\n- First result\n- Second result\n\n```js\nconst sample = 1\n```'
  await whole(f, text)
  assert.match(f.chat.textContent, /Current answer/, 'whole-only output must paint before the turn ends')
  await complete(f)
  assert.equal(f.node.reply, text)
  assert.equal(f.lines().at(-1).text, text)
  const reloaded = restoredChat(t, f.lines())
  for (const chat of [f.chat, reloaded]) {
    assert.equal(chat.querySelectorAll('.them').length, 1)
    assert.equal(chat.querySelector('.md-h').textContent, 'Current answer')
    assert.equal(chat.querySelectorAll('li').length, 2)
    // The small DOM parser drops whitespace-only text nodes; exact source is asserted in history above.
    assert.equal(chat.querySelector('pre').textContent.replace(/\s+/g, ''), 'constsample=1')
  }
  assert.equal(f.unrelated.querySelectorAll('.them').length, 0)
})

test('a whole message extending its streamed prefix retains only the missing suffix', async t => {
  const f = fixture(t)
  await delta(f, 'A partial')
  await whole(f, 'A partial answer.')
  await complete(f)
  assert.deepEqual(f.replies(), ['A partial answer.'])
  assert.equal(f.lines().at(-1).text, 'A partial answer.')
})

test('an exact whole echo does not duplicate streamed text or suppress the next legitimate message', async t => {
  const f = fixture(t)
  await delta(f, 'Repeated sentence.')
  await whole(f, 'Repeated sentence.')
  await delta(f, 'Repeated sentence.', { itemId: 'message-next' })
  await whole(f, 'Repeated sentence.', { itemId: 'message-next' })
  await complete(f)
  assert.equal(f.lines().at(-1).text, 'Repeated sentence.\n\nRepeated sentence.')
})

test('two identified whole messages can legitimately contain exactly the same words', async t => {
  const f = fixture(t)
  await whole(f, 'Same words.', { itemId: 'message-first' })
  await whole(f, 'Same words.', { itemId: 'message-second' })
  await complete(f)
  assert.equal(f.lines().at(-1).text, 'Same words.\n\nSame words.')
})

test('a repeated identified whole packet cannot add a second message', async t => {
  const f = fixture(t)
  await whole(f, 'One message.')
  await whole(f, 'One message.')
  await complete(f)
  assert.equal(f.lines().at(-1).text, 'One message.')
  assert.deepEqual(f.replies(), ['One message.'])
})

test('whole output preserves separate turn identity even when the words and item ID repeat', async t => {
  const f = fixture(t)
  for (const turnId of ['turn-first', 'turn-second']) {
    await whole(f, 'Same turn result.', { turnId })
    await complete(f, turnId)
  }
  assert.deepEqual(f.replies(), ['Same turn result.', 'Same turn result.'])
  assert.deepEqual(f.lines().map(row => row.turnStamp), ['turn-first', 'turn-second'])
})

test('commentary, actual tool events and whole final output keep their text and action boundary', async t => {
  const f = fixture(t)
  await delta(f, 'Checking the sample.', { itemId: 'commentary' })
  await whole(f, 'Checking the sample.', { itemId: 'commentary' })
  await f.packet({ type: 'tool_call', turnId: 'turn-current', toolCallId: 'call-fixture', tool: 'fixture.read', input: { name: 'sample' } })
  await f.packet({ type: 'tool_result', turnId: 'turn-current', toolCallId: 'call-fixture', tool: 'fixture.read', status: 'ok', text: 'Synthetic result.' })
  await whole(f, '## Final result\n\nThe sample is ready.', { itemId: 'final' })
  await complete(f)
  assert.equal(f.lines().at(-1).text, 'Checking the sample.\n\n## Final result\n\nThe sample is ready.')
  assert.equal(f.chat.querySelector('.md-h').textContent, 'Final result')
  assert.equal(f.scope.sessionActions.get('selected-session').list()[0].output, 'Synthetic result.')
  await new Promise(resolve => setTimeout(resolve, 60)) // production action paints on its own animation frame
  assert.match(f.chat.textContent, /Synthetic result/)
})

test('retained predecessor routing cannot paint into a node now owned by another session', async t => {
  const f = fixture(t)
  f.node.sessionId = 'replacement-session'
  await whole(f, 'Stale predecessor words.')
  await complete(f)
  assert.deepEqual(f.lines(), [])
  assert.deepEqual(f.replies(), [])
})

test('retiring a session releases the reader and late packets cannot reopen its chat', async t => {
  const f = fixture(t)
  await whole(f, 'Final retained words.')
  await complete(f)
  await f.api.settleStopped('selected-session')
  const before = f.replies()
  await whole(f, 'Late retired words.', { turnId: 'turn-late' })
  assert.deepEqual(f.replies(), before)
  assert.equal(f.scope.sessionNodeIds.has('selected-session'), false)
})

test('foreign-session output and agent-to-agent deliveries remain outside the user chat', async t => {
  const f = fixture(t)
  for (const type of ['assistant_text', 'assistant_text_delta']) {
    await f.api.packet({ sessionId: 'foreign-session', event: { type, turnId: 'foreign-turn', itemId: 'foreign-message', text: 'Foreign words.' } })
    await f.packet({ type, turnId: 'delivery-turn', itemId: 'delivery-message', text: 'Agent delivery.', treeDelivery: true })
  }
  assert.deepEqual(f.replies(), [])
  assert.deepEqual(f.lines(), [])
  await delta(f, 'Own streamed answer.')
  await complete(f)
  assert.deepEqual(f.replies(), ['Own streamed answer.'])
})

import { claudeTextEvents, acpTextEvents } from './lib/session-text-producers.mjs'

test('actual Claude equal blocks reach selected chat and history without final packet replay', async t => {
  const f = fixture(t)
  for (const event of claudeTextEvents({ streamed: true })) await f.packet(event)
  await complete(f, 'fixture-turn')
  assert.equal(f.node.reply, 'Same.\n\nSame.')
  assert.equal(f.lines().at(-1).text, 'Same.\n\nSame.')
  assert.deepEqual(f.replies(), ['Same.Same.']) // DOM stand-in discards whitespace-only paragraph separators.
  const restored = restoredChat(t, f.lines())
  assert.equal(restored.querySelectorAll('p').filter(p => p.textContent === 'Same.').length, 2)
})

test('actual ACP tool seam reaches selected chat and history without aggregate replay', async t => {
  const f = fixture(t)
  const events = await acpTextEvents()
  for (const event of events) await f.packet(event)
  assert.equal(f.node.reply, 'Before.\n\nAfter.')
  assert.equal(f.lines().at(-1).text, 'Before.\n\nAfter.')
  const restored = restoredChat(t, f.lines())
  assert.equal(restored.querySelectorAll('p').some(p => p.textContent === 'Before.'), true)
  assert.equal(restored.querySelectorAll('p').some(p => p.textContent === 'After.'), true)
})
