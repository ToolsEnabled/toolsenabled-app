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
import { turnCompletionWords, TURN_FAILED, ENDED_SESSION, PALETTE_PANEL } from '../../src/fleet-tree-copy.js'
import { parseSlashCommand } from '../../src/slash-commands.js'
import { stopStillOwnsNode } from '../../src/stop-node-session.js'
import { stopNativePersonSession } from '../../src/native-person-stop.js'
import { withResearchTreeBinding } from '../../src/research-tree-session.js'

const world = installDomStandIn()
after(() => world.restore())
const { buildChat } = await import('../../src/components.js')
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
let eventSource, eventDispatcher
function visit(node) {
  if (!node || typeof node !== 'object') return
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
    sessionTextReader: sessionEvents.createSessionTextReader(),
    pendingModelChoice: () => null, applyPendingModelChoice: async () => false,
    cancelPendingModelChoice() {}, // this fixture has no queued model choice
    publishProviderModeEvent() {}, // Provider-menu refresh is outside this transcript fixture.
    requestAuthoritativeDesktopTree() { assert.fail('A local event fixture must not request a relay tree') },
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
  const names = ['unregisterChatSurface', 'broadcastChatSpeech', 'scheduleChatSpeech', 'deliverTurnReply', 'awaitTurnReply', 'dropTurnReply',
    'transcriptAppend', 'settleTurnBoundary', 'markTurnRunning', 'turnLogAppend', 'treeCardSend',
    'settleStoppedSession', 'retireTreeSessionRuntime', 'resetSessionMetrics', 'runPaletteAction', 'closePersonNode']
  const functions = names.map(name => declaredFunctionSource(source, name)).join('\n')
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

async function priorReply(f) {
  await f.packet({ type: 'assistant_text_delta', turnId: 'previous-turn', text: 'Previous reply.' })
  await f.packet({ type: 'turn_completed', turnId: 'previous-turn', status: 'completed' })
  assert.deepEqual(f.replies(), ['Previous reply.'])
}

test('a named interrupted turn with no text adds its own completed reply after an earlier turn', async t => {
  const f = fixture(t)
  await priorReply(f)
  const drained = f.drains()
  await f.stopped('stopped-before-text')
  assert.deepEqual(f.replies(), ['Previous reply.', 'Interrupted.'])
  assert.equal(f.lines().at(-1).turnStamp, 'stopped-before-text')
  assert.equal(f.captures.at(-1).turnStamp, 'stopped-before-text')
  assert.equal(f.node.status, 'interrupted')
  assert.equal(f.node.sessionId, 'selected-session')
  assert.equal(f.node.reply, 'Interrupted.')
  assert.deepEqual(f.statusChanges.at(-1).visible, ['Previous reply.', 'Interrupted.'], 'the completed reply precedes the visible terminal status')
  assert.equal(f.drains(), drained, 'a confirmed user interruption cannot release the next queued message')
  assert.equal(f.unrelated.querySelectorAll('.them').length, 0)
});

test('two different zero-text interrupted turns remain two separate completed entries', async t => {
  const f = fixture(t)
  await f.stopped('first-empty-turn')
  await f.stopped('second-empty-turn')
  assert.deepEqual(f.replies(), ['Interrupted.', 'Interrupted.'])
  assert.deepEqual(f.lines().map(row => row.turnStamp), ['first-empty-turn', 'second-empty-turn'])
  assert.equal(f.drains(), 0)
});

test('an interrupted partial reply retains all observed text without duplicating its bubble', async t => {
  const f = fixture(t)
  await priorReply(f)
  await f.packet({ type: 'assistant_text_delta', turnId: 'partial-turn', text: 'Observed partial reply.' })
  const before = f.replies()
  assert.deepEqual(before, ['Previous reply.', 'Observed partial reply.'])
  await f.stopped('partial-turn')
  const said = turnCompletionWords({ spoken: 'Observed partial reply.', userStopped: true })
  assert.deepEqual(f.replies(), ['Previous reply.', said])
  assert.equal(f.lines().at(-1).text, said)
  assert.equal(f.lines().at(-1).turnStamp, 'partial-turn')
  assert.equal(f.chat.querySelectorAll('[aria-busy="true"]').length, 0)
});

test('a nameless completion preserves the known open turn identity and its observed words', async t => {
  const f = fixture(t)
  await f.packet({ type: 'assistant_text_delta', turnId: 'known-open-turn', text: 'Actual words.' })
  await f.stopped(null)
  assert.equal(f.lines().at(-1).turnStamp, 'known-open-turn')
  assert.deepEqual(f.replies(), [turnCompletionWords({ spoken: 'Actual words.', userStopped: true })])
});

for (const [status, expectedStatus] of [['completed', 'finished'], ['failed', 'turn-failed']]) {
  test(`a named zero-text ${status} completion also receives one correctly identified outcome`, async t => {
    const f = fixture(t)
    await priorReply(f)
    await f.packet({ type: 'turn_completed', turnId: 'empty-outcome', status })
    assert.equal(f.replies().length, 2)
    assert.equal(f.lines().at(-1).turnStamp, 'empty-outcome')
    assert.equal(f.replies().at(-1), f.lines().at(-1).text)
    assert.equal(f.node.status, expectedStatus)
  });
}

test('foreign or stale completions cannot take the active turn or paint another conversation', async t => {
  const f = fixture(t)
  await f.packet({ type: 'assistant_text_delta', turnId: 'active-turn', text: 'Keep the active partial.' })
  await f.api.packet({ sessionId: 'foreign-session', event: { type: 'turn_completed', turnId: 'active-turn', status: 'interrupted' } })
  await f.packet({ type: 'turn_completed', turnId: 'older-turn', status: 'interrupted' })
  assert.deepEqual(f.replies(), ['Keep the active partial.'])
  assert.equal(f.scope.sessionTurnText.get('selected-session'), 'Keep the active partial.')
  assert.equal(f.scope.sessionOpenTurns.get('selected-session'), 'active-turn')
  assert.equal(f.lines().length, 0)
  assert.equal(f.drains(), 0)
  assert.equal(f.node.status, 'running')
  assert.equal(f.unrelated.querySelectorAll('.them').length, 0)
});

test('completion waits for the actual interrupt acknowledgement before recording its own empty turn', async t => {
  const f = fixture(t)
  await priorReply(f)
  let acknowledge
  const request = f.scope.turnInterrupts.request('selected-session', null, () => new Promise(resolve => { acknowledge = resolve }))
  await Promise.resolve()
  const completion = f.packet({ type: 'turn_completed', turnId: 'crossed-ipc-turn', status: 'interrupted' })
  await Promise.resolve()
  assert.deepEqual(f.replies(), ['Previous reply.'])
  acknowledge({ ok: true, turnId: 'crossed-ipc-turn' })
  await request; await completion
  assert.deepEqual(f.replies(), ['Previous reply.', 'Interrupted.'])
  assert.equal(f.node.status, 'interrupted')
  assert.equal(f.lines().at(-1).turnStamp, 'crossed-ipc-turn')
});

test('the same named completed broadcast is idempotent for its actual chat stream', t => {
  const f = fixture(t)
  f.api.broadcast('selected-session', 'Completed reply.', { turnId: 'one-turn', complete: true })
  f.api.broadcast('selected-session', 'Completed reply.', { turnId: 'one-turn', complete: true })
  assert.deepEqual(f.replies(), ['Completed reply.'])
});

for (const acceptedEvent of [false, true]) {
  test(`confirmed manual Stop keeps the accepted zero-text turn after an earlier reply (${acceptedEvent ? 'turn_accepted event' : 'send receipt'})`, async t => {
    const f = fixture(t)
    await priorReply(f)
    const accepted = await f.send()
    assert.equal(accepted.turnId, 'accepted-before-text')
    assert.equal(f.node.status, 'running', 'the actual accepted send marks this new turn busy')
    if (acceptedEvent) await f.packet({ type: 'turn_accepted', turnId: accepted.turnId })
    const out = { textContent: '' }
    await f.api.action('stop', f.node, out)
    assert.deepEqual(f.closes, [{ sessionId: 'selected-session' }])
    assert.equal(out.textContent, PALETTE_PANEL.stopped)
    assert.deepEqual(f.replies(), ['Previous reply.', 'Interrupted.'])
    assert.equal(f.lines().at(-1).turnStamp, accepted.turnId)
    assert.equal(f.chat.querySelectorAll('.them').at(-1).querySelector('.turn-stamp').textContent, accepted.turnId)
    assert.equal(f.scope.sessionNodeIds.has('selected-session'), false)
    const stoppedRows = f.lines().length
    f.api.settleStopped('selected-session')
    await f.packet({ type: 'turn_completed', turnId: accepted.turnId, status: 'interrupted' })
    assert.equal(f.lines().length, stoppedRows, 'a repeated settlement or late provider completion cannot append another outcome')
    assert.deepEqual(f.replies(), ['Previous reply.', 'Interrupted.'])
  });
}

test('manual Stop retains a real partial turn and its identity ahead of an older accepted receipt', async t => {
  const f = fixture(t)
  await priorReply(f)
  await f.send()
  await f.packet({ type: 'assistant_text_delta', turnId: 'current-observed-turn', text: 'Keep these exact partial words.' })
  const drained = f.drains()
  await f.api.action('stop', f.node, { textContent: '' })
  assert.deepEqual(f.replies(), ['Previous reply.', turnCompletionWords({ spoken: 'Keep these exact partial words.', userStopped: true })])
  assert.equal(f.lines().at(-1).turnStamp, 'current-observed-turn')
  assert.equal(f.drains(), drained)
  assert.equal(f.unrelated.querySelectorAll('.them').length, 0)
});

test('manual Stop without an accepted turn identity records one honest unstamped outcome', async t => {
  const f = fixture(t)
  await priorReply(f)
  f.scope.window.mcAgent.send = async () => ({ sessionId: 'selected-session' })
  await f.send()
  await f.api.action('stop', f.node, { textContent: '' })
  assert.deepEqual(f.replies(), ['Previous reply.', 'Interrupted.'])
  assert.equal(f.lines().at(-1).turnStamp, null)
  assert.equal(f.chat.querySelectorAll('.them').at(-1).querySelector('.turn-stamp'), null)
  f.api.settleStopped('selected-session')
  assert.deepEqual(f.replies(), ['Previous reply.', 'Interrupted.'])
});

for (const stale of ['copied-history', 'completed-reply', 'later-unaccepted-question']) {
  test(`manual Stop cannot take its identity from ${stale}`, async t => {
    const f = fixture(t)
    await priorReply(f)
    await f.send()
    if (stale === 'copied-history') {
      // A resumed transcript can carry a real old stamp; only the old session
      // accepted it. Restoring those entries is not a receipt for this run.
      f.scope.sessionTurnLog.set('other-session', f.scope.sessionTurnLog.get('selected-session'))
      f.scope.sessionTurnLog.delete('selected-session')
    } else if (stale === 'completed-reply') {
      // Keep the stale accepted log while supplying the terminal transcript
      // boundary. It cannot name an otherwise unnamed current busy turn.
      f.lines().push({ who: 'agent', text: 'That accepted question already ended.', turnStamp: 'accepted-before-text' })
    } else {
      // An earlier accepted receipt is not permission to stamp a newer
      // optimistic question which has not received its own acceptance yet.
      f.lines().push({ who: 'you', text: 'This later question has no acceptance receipt yet.' })
    }
    await f.api.action('stop', f.node, { textContent: '' })
    assert.deepEqual(f.replies(), ['Previous reply.', 'Interrupted.'])
    assert.equal(f.lines().at(-1).turnStamp, null)
    assert.equal(f.chat.querySelectorAll('.them').at(-1).querySelector('.turn-stamp'), null)
  });
}

for (const receipt of [undefined, { closed: false }, { sessionId: 'other-session', closed: true }]) {
  test(`an unconfirmed manual close cannot paint an interrupted reply (${JSON.stringify(receipt)})`, async t => {
    const f = fixture(t)
    await priorReply(f)
    await f.send()
    f.scope.window.mcAgent.close = async () => receipt
    const out = { textContent: '' }
    const before = f.lines().length, drained = f.drains()
    await f.api.action('stop', f.node, out)
    assert.equal(out.textContent, PALETTE_PANEL.stopFailed)
    assert.deepEqual(f.replies(), ['Previous reply.'])
    assert.equal(f.lines().length, before)
    assert.equal(f.node.status, 'running')
    assert.equal(f.scope.sessionNodeIds.get('selected-session'), f.node.id)
    assert.equal(f.drains(), drained)
    assert.equal(f.unrelated.querySelectorAll('.them').length, 0)
  });
}

test('a send receipt that resolves after its own turn ended leaves the terminal status alone', async t => {
  const f = fixture(t)
  await priorReply(f)
  let acknowledge
  f.scope.window.mcAgent.send = () => new Promise(resolve => { acknowledge = resolve })
  const sending = new Promise((resolve, reject) => f.api.send(f.node, 'A question whose receipt crosses IPC late.', {
    accepted: resolve, reply: () => {}, fail: sentence => reject(new Error(sentence)),
  }))
  await Promise.resolve()
  // The provider finishes the turn before its own acknowledgement comes back.
  await f.packet({ type: 'turn_completed', turnId: 'late-receipt-turn', status: 'completed' })
  assert.equal(f.node.status, 'finished')
  assert.equal(f.scope.sessionCompletedTurnIds.get('selected-session'), 'late-receipt-turn',
    'the completion must name the turn it settled, or the receipt below cannot recognise it')
  acknowledge({ sessionId: 'selected-session', turnId: 'late-receipt-turn' })
  await sending
  await Promise.resolve()
  assert.equal(f.node.status, 'finished', 'the late receipt marked an ended turn running again')
  assert.deepEqual(f.replies(), ['Previous reply.', f.lines().at(-1).text])
});
