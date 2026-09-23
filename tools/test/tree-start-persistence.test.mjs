import { computersViewAuthorityBindings } from './lib/computers-view-authority-bindings.mjs'
import { createConfirmedFileChangeBuffer } from '../../src/session-change-patches.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parseAst } from 'rollup/parseAst'
import { createFleetTreeStore, safeTreeStorage, nodeDisplayName, draftStartEffort, FLEET_TREE_LIMITS, NODE_STATUSES, NODE_REMOVE_REFUSALS } from '../../src/fleet-trees.js'
import { nodeIsBusy, sessionIsLive } from '../../src/tree-session-liveness.js'
import { railRebindDecision } from '../../src/tree-rail-rebind.js'
import { stopStillOwnsNode } from '../../src/stop-node-session.js'
import { stopNativePersonSession } from '../../src/native-person-stop.js'
import { withResearchTreeBinding } from '../../src/research-tree-session.js'
import * as sessionEvents from '../../src/agent-session-events.js'
import { turnCompletionWords, TURN_FAILED, TURN_CANCELLED, ENDED_SESSION } from '../../src/fleet-tree-copy.js'
import { createPendingApprovals } from '../../src/approval-answer.js'
import { createAccountRecoveryCoordinator } from '../../src/account-recovery-coordinator.js'
import { acceptRemoteSequence } from '../../src/remote-session-history.js'
import { createTurnInterrupts } from '../../src/turn-interrupts.js'
import { createSingleFlight } from '../../src/single-flight.js'
import { slotAccountStartOptions } from '../../src/slot-account-choice.js'
import { failureSentence } from '../../src/org-controls.js'
import { refusalSentence } from '../../src/refusal-copy.js'

const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const functions = new Map()
let eventHandler = null
let eventDispatcher = null
let editMoveHandler = null
function collect(node) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'CallExpression' && source.slice(node.callee.start, node.callee.end) === 'moveSave.addEventListener') editMoveHandler = source.slice(node.arguments[1].start, node.arguments[1].end)
  if (node.type === 'FunctionDeclaration') functions.set(node.id.name, source.slice(node.start, node.end))
  if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && node.left.name === 'handleAgentEvent') {
    eventDispatcher = source.slice(node.right.start, node.right.end)
  }
  if (node.type === 'CallExpression' && source.slice(node.callee.start, node.callee.end) === 'window.mcAgent.onEvent') {
    eventHandler = source.slice(node.arguments[0].start, node.arguments[0].end)
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') collect(value)
  }
}
collect(parseAst(source))

function fixture({ before = null, after = null, result = { ok: true }, leaveDuringStart = false, cleanupRequired = false } = {}) {
  let raw = null, unreadable = false, full = false, handoffs = 0
  const writes = [], statuses = [], stops = [], shown = [], sent = []
  const backing = {
    getItem() { if (unreadable) throw new Error('fixture read refused'); return raw },
    setItem(_key, value) { if (full) throw new Error('fixture write refused'); raw = value; writes.push(value) },
  }
  const stored = createFleetTreeStore({ computerId: 'start-fixture', storage: safeTreeStorage(backing) })
  const node = stored.addNode({ role: 'worker', message: 'Keep my exact opening brief.', tier: 'luna' }).node
  const sessionNodeIds = new Map()
  const replacementFlight = createSingleFlight()
  const status = { textContent: '', hidden: true, dataset: {} }
  const context = vm.createContext({
    /* T138: the cursor renamedCircles() compares names against between calls. */
    lastComposedNames: new Map(),
    Date, Map, Set, Object, Promise, String, Number, Math, FLEET_TREE_LIMITS, NODE_STATUSES, NODE_REMOVE_REFUSALS, nodeIsBusy,
    ...sessionEvents, turnCompletionWords, TURN_FAILED, TURN_CANCELLED, createFleetTreeStore, safeTreeStorage,
    RUN_TREE_RUNTIME_STORES: new Map(), RUN_SESSION_NODES: sessionNodeIds, RUN_SESSION_CLEANUPS: new Map(),
    RUN_STARTING_TREE_STORES: new Map(), RUN_NODE_REPLACEMENTS: replacementFlight, nodeReplacementFlight: replacementFlight,
    RUN_NODE_REMOVAL_CLOSE_RECEIPTS: new Map(), RUN_NATIVE_WORK_CLOSE_LISTENERS: new Set(),
    accountRecoveryCoordinator: null, RUN_RECOVERY_BRIDGE: null, RUN_RECOVERY_BOUND_BRIDGE: null,
    RUN_KEEP_TRYING_CONSENT: async () => false, createAccountRecoveryCoordinator, withResearchTreeBinding,
    slotAccountStartOptions, pendingModelChoices: new Map(), pendingModelDrainHolds: new Set(),
    sessionTextReader: sessionEvents.createSessionTextReader(),
    refreshSlotUsage() {}, // Usage display refresh is independent of session persistence.
    TREE_RUNTIME_NOT_SAVED_TEXT: 'The latest session changes could not be saved. Keep this app window open to retain its conversation and session controls.',
    confirmedFileChanges: createConfirmedFileChangeBuffer(),
    chatWorkspace: false, workspaceChats: new Set(), refreshWorkspaceChats: () => {}, source: 'local',
    requestAuthoritativeDesktopTree() { assert.fail('A local start fixture must not request a relay tree') }, stopNativePersonSession,
    treeStore: stored, treeStoreId: 'start-fixture', treeStoreProblem: '', destroyed: false, composePanel: null,
    // The real local view initializes these before opening its saved tree.
    ...computersViewAuthorityBindings(),
    treeStoreUnsub: null, treePersistenceUnsub: null, treeStoreLiveRelease: null, diffHistoryStore: null,
    nodeDiffHistories: new Map(), orgReady: () => false, roleLabel: role => role, drivenComputerCopy: local => local,
    imageConversationFor: () => null, /* the image outbox the tree's image work reads per node; not under test here */
    publishProviderModeEvent: () => {}, // Provider menus are independent of persistence in this fixture.
    createTranscriptStore: () => null, createChatDiffHistoryStore: () => null, markTreeStoreLive: () => () => {}, syncTreeBranchAddresses: () => {}, /* T138 publish watch. Stubbed like syncTreeBranchAddresses beside it: this fixture keeps its naming layer deliberately shallow (treeNodeName is current => current.id), so running the real scan would compose nothing and guarantee nothing. refreshTreeNames above IS lifted real, which is why renamedCircles is bound for it. The real watch is covered in fleet-tree-persistence-view. */ syncRenamedCircles: () => {},
    startingNodeIds: new Set(), sessionNodeIds, sessionEfforts: new Map(), sessionThreadIds: new Map(), sessionAccountNames: new Map(),
    sessionTranscripts: new Map(), sessionTurnLog: new Map(), sessionCompletedTurnIds: new Map(), nodeReplies: new Map(), transcriptStore: null,
    chatSurfaces: new Map(), chatSpeech: new WeakMap(),
    mockSource: () => false, isWriteEnabled: () => true, START_CONTROL_FLAG: 'start', START_REFUSAL: {},
    START_NEEDS_APP_TEXT: () => 'App needed.', ENDED_SESSION,
    PALETTE_PANEL: { stopped: 'Stopped.', stopFailed: 'Stop failed.', footer: '' },
    CHAT_NOT_RUNNING: { neverStarted: 'Not started.', refused: text => text },
    draftStartEffort, tierEffortOf: () => 'max', identityRoleForTreeNode: role => role,
    roleBindingForStart: () => ({ ok: true, binding: { agentId: 'fixture-agent' } }),
    currentDataSource: () => 'local', LAUNCH_TIERS: [{ id: 'luna', provider: 'codex' }], TREE_DEFAULT_STARTABLE_TIERS: ['luna'],
    window: { localStorage: backing, mcResources: { status: async () => ({ admission: { ok: true } }) }, mcAgent: { close: async value => { stops.push(value.sessionId); return { ok: true, closed: true, sessionId: value.sessionId } } } },
    isResourceHold: code => code === 'AGENT_RESOURCE_PRESSURE', treeNodeName: current => current.id,
    roleDisplayFor: role => role, startingLine: () => 'Starting.', runningLine: () => 'Started.',
    startStalledLine: () => 'Waiting.', startStallMs: () => 10000,
    startCleanupSentence: () => 'Cleanup has not finished. Try Stop again.',
    setTimeout: () => 1, clearTimeout: () => {}, setOrgStatus: (text, state) => { statuses.push({ text, state }) },
    sampleRun: null, sampleRunStore: null, sampleRunTimer: 0, sampleChipFrame: 0,
    sampleChips: new Set(), sampleChats: new Map(), sampleSessionText: new Map(),
    clearInterval: () => {}, cancelAnimationFrame: () => {},
    briefContextFor: () => ({}), composeNodeBrief: ({ message }) => message, nodeManagerContext: () => 'Manager context.',
    startProfileId: value => value, nodeRequestKeys: () => null, nodeTreeIdentity: () => null,
    transcriptAppend: (sessionId, line) => {
      const rows = context.sessionTranscripts.get(sessionId) || []
      rows.push(line); context.sessionTranscripts.set(sessionId, rows)
    },
    readEngineCatalog: () => {}, rememberBoundSessionProfile: () => {}, statusNote: text => text,
    closeComposePanel: () => {}, refreshTree: () => { shown.push(context.treeStore.snapshot()) },
    retireTreeSessionRuntime: id => sessionNodeIds.delete(id),
    controlsPage: { classList: { contains: () => true }, querySelector: () => null }, currentRailTreeNode: node, railChat: { sessionId: null }, railSaid: null,
    railRebindDecision, deferRailRebuildWhileTyping: callback => callback(),
    showTreeNodeControls: current => { context.railChat = { sessionId: current.sessionId }; context.currentRailTreeNode = current },
    repaintRailStatus: () => {},
    nodeBusy: current => nodeIsBusy(current, sessionNodeIds), nodeSessionLive: current => sessionIsLive(current, sessionNodeIds),
    treeChatHeaderMetaFor: () => ({}), restoreDiffHistory: (_id, history) => history,
    markTreeContext: history => history, mergeActionsIntoHistory: history => history,
    openChatDiff: () => {}, engineEffortsFor: () => [], chatActionRowsFor: () => [],
    registerChatSurface: () => {}, treeCardSend: (current, text) => { sent.push({ sessionId: current.sessionId, text }) },
    outboxClearSession: () => 0, outboxMoveSession: () => 0, resetSessionMetrics: () => {}, stopStillOwnsNode,
    orgStatusElement: status, orgStatusTimer: 0, treePersistenceProblem: '', orgStatusPrimary: null,
    markRefusalCode: () => {},
    sessionTurnText: new Map(), sessionOpenTurns: new Map(), sessionActions: new Map(), sessionPendingApprovals: createPendingApprovals(),
    confirmedRefusals: new Map(),
    standaloneSettledTurns: new Map(), chatSpeechMounts: new Map(),
    sessionBreakPending: new Set(), turnInterrupts: createTurnInterrupts(), nodeActivity: new Map(),
    recordTurnActions: () => {}, deliverTurnReply: () => {}, clearInlineApproval: () => {},
    notifyNodeStatusListeners: () => {}, outboxTakeNext: () => null,
    outboxConfirmDelivered: () => true, outboxRequeueFront: () => {},
    remotePendingPackets: new Map(), remoteAppliedSequences: new Map(), acceptRemoteSequence,
    // The native reconnect's probe buffer and the sessions whose rejoined turn
    // its capture reconciles: read by the same subscription and dispatcher.
    nativePendingPackets: new Map(), nativeReconcileSessions: new Set(),
    reconcileRecoveredTurn: async () => {},
    replayingRemoteHistory: false,
  })
  const change = kind => {
    if (kind === 'conflict') {
      const other = createFleetTreeStore({ computerId: 'start-fixture', storage: safeTreeStorage(backing) })
      other.addNode({ role: 'manager', message: 'Newer saved history.' })
    } else if (kind === 'read') unreadable = true
    else if (kind === 'write') full = true
  }
  context.ensureSeatForNode = async () => { change(before); before = null; return { ok: true } }
  context.startAgentForNode = async options => {
    handoffs++
    change(after)
    if (leaveDuringStart) context.destroyed = true
    if (cleanupRequired) {
      options.onCleanupRequired({ sessionId: 'fixture-session', code: 'AGENT_SESSION_CLEANUP_FAILED' })
      return { ok: false, sessionId: 'fixture-session', cleanupPending: true, sentence: 'Cleanup has not finished. Try Stop again.' }
    }
    options.onSessionOpen({ sessionId: 'fixture-session', threadId: 'fixture-thread' })
    return { sessionId: 'fixture-session', ...result }
  }
  const names = ['createTreeRuntimeView', 'startDraftNodeUnguarded', 'rebindRailToSession', 'treeChatConfigFor', 'runPaletteAction', 'closePersonNode', 'markTurnRunning', 'nodeStartReason',
    'releaseTreeStore', 'stopSampleRun', 'openTreeStore', 'refreshTreeNames', 'renamedCircles', 'reportTreePersistence', 'setOrgStatus', 'renderOrgStatus',
    'nodeCleanupPending', 'retainTreeSessionCleanup', 'recoveryImageContext', 'recoveryCoordinator', 'retainStartingTreeStore', 'persistTranscript', 'settleStoppedSession', 'broadcastChatSpeech', 'clearSessionApprovals',
    'cancelPendingModelChoice', 'pendingModelChoice', 'applyPendingModelChoice', 'pendingModelDrainBlocked']
  for (const name of names) assert.ok(functions.has(name), `actual production helper ${name} must exist`)
  vm.runInContext(names.map(name => functions.get(name)).join('\n'), context)
  assert.ok(eventHandler, 'the actual production session listener must exist')
  assert.ok(eventDispatcher, 'the actual production event dispatcher must exist')
  context.handleAgentEvent = vm.runInContext(`(${eventDispatcher})`, context)
  context.onPacket = vm.runInContext(`(${eventHandler})`, context)
  // Baseline deliberately runs the same start against the actual guarded store.
  // The fixture must expose the behavioral failure, not fail on a missing helper.
  if (context.createTreeRuntimeView) context.treeStore = context.createTreeRuntimeView(stored, sessionNodeIds)
  context.treePersistenceUnsub = context.treeStore.subscribe(context.reportTreePersistence)
  return { context, node, stored, status, statuses, stops, shown, sent, sessionNodeIds, writes,
    start: () => context.startDraftNodeUnguarded(node), raw: () => raw, handoffs: () => handoffs,
    recover: () => { unreadable = false; full = false }, change,
  }
}

test('healthy actual draft start saves and rebinds its real session once', async () => {
  const f = fixture()
  assert.equal((await f.start()).ok, true)
  assert.equal(f.handoffs(), 1)
  assert.equal(f.stored.getNode(f.node.id).sessionId, 'fixture-session')
  assert.equal(f.stored.getNode(f.node.id).status, 'running')
  assert.equal(f.context.railChat.sessionId, 'fixture-session')
  assert.equal(f.context.treeStore.snapshot().persistenceFailed, false)
})

test('an absent, refused or mismatched close receipt keeps the actual running node reachable', async () => {
  for (const receipt of [undefined, { ok: false, closed: true }, { ok: true, closed: false }, { ok: true, closed: true, sessionId: 'another-session' }]) {
    const f = fixture()
    await f.start()
    f.context.window.mcAgent.close = async () => receipt
    const out = { textContent: '' }
    await f.context.runPaletteAction('stop', f.context.treeStore.getNode(f.node.id), out)
    assert.equal(out.textContent, 'Stop failed.')
    assert.equal(f.context.treeStore.getNode(f.node.id).status, 'running')
    assert.equal(f.sessionNodeIds.get('fixture-session'), f.node.id)
    assert.equal(f.context.RUN_NODE_REMOVAL_CLOSE_RECEIPTS.has('fixture-session'), false)
  }
})

for (const failure of ['conflict', 'read', 'write']) {
  test(`startup cleanup plus ${failure} remains reachable after navigation without becoming sendable`, async () => {
    const f = fixture({ after: failure, cleanupRequired: true, leaveDuringStart: true })
    const result = await f.start()
    const retained = f.context.treeStore
    const current = retained.getNode(f.node.id)
    assert.equal(result.ok, false)
    assert.equal(current.sessionId, 'fixture-session', 'failed persistence must not hide the exact cleanup target')
    assert.equal(current.status, 'failed')
    assert.equal(f.context.nodeCleanupPending(current), true)
    assert.equal(f.context.nodeSessionLive(current), false, 'cleanup is not a sendable conversation')
    assert.equal(f.context.nodeBusy(current), false)
    assert.equal(retained.snapshot().persistenceFailed, true)
    assert.match(retained.snapshot().persistenceProblem, /incomplete start.*cleanup/i)
    assert.doesNotMatch(retained.snapshot().persistenceProblem, /session started/i)
    const saved = f.raw()
    assert.equal(retained.removeNode(f.node.id).ok, false, 'the runtime view cannot discard unproven cleanup')
    f.context.releaseTreeStore()
    f.context.destroyed = false
    assert.equal(f.context.openTreeStore('start-fixture'), retained)
    assert.equal(f.context.nodeCleanupPending(retained.getNode(f.node.id)), true)
    assert.equal((await f.start()).ok, false, 'a cleanup target must not invite a duplicate draft start')
    assert.equal(f.handoffs(), 1)
    const out = { textContent: '' }
    await f.context.runPaletteAction('stop', retained.getNode(f.node.id), out)
    assert.deepEqual(f.stops, ['fixture-session'])
    assert.equal(out.textContent, 'Stopped.')
    assert.equal(f.context.nodeCleanupPending(retained.getNode(f.node.id)), false)
    assert.equal(retained.getNode(f.node.id).status, 'finished')
    assert.equal(f.raw(), saved, 'observed cleanup must never overwrite the refused durable history')
    assert.equal(f.handoffs(), 1)
    assert.deepEqual(f.sent, [])
  })
}

for (const failure of ['conflict', 'read', 'write']) {
  test(`actual Start refuses ${failure} before the provider handoff and keeps the brief`, async () => {
    const f = fixture({ before: failure })
    const result = await f.start()
    assert.equal(f.handoffs(), 0, 'no real session may be requested before the starting state is saved')
    assert.equal(result.ok, false)
    assert.equal(result.notStarted, true)
    assert.equal(f.context.startingNodeIds.size, 0)
    assert.equal(f.context.treeStore.getNode(f.node.id).message, f.node.message)
    assert.equal(f.context.treeStore.getNode(f.node.id).sessionId, null)
    assert.match(result.message, /not started/i)
    if (failure === 'conflict') assert.equal(JSON.parse(f.raw()).nodes.length, 2)
    if (failure === 'write') {
      f.recover()
      assert.equal(f.context.treeStore.getNode(f.node.id).status, 'draft', 'a quota failure does not strand an unstarted node as busy')
      assert.equal((await f.start()).ok, true)
      assert.equal(f.handoffs(), 1)
    }
  })
}

for (const failure of ['conflict', 'read', 'write']) {
  test(`after-handoff ${failure} preserves a controllable session without promising reload recovery`, async () => {
    const f = fixture({ after: failure })
    const result = await f.start()
    const retained = f.context.treeStore.getNode(f.node.id)
    assert.equal(f.handoffs(), 1)
    assert.equal(retained.sessionId, 'fixture-session')
    assert.equal(retained.status, 'running')
    assert.equal(f.context.railChat.sessionId, 'fixture-session')
    assert.equal(f.context.nodeBusy(retained), true)
    assert.equal(result.persistenceFailed, true)
    assert.equal(result.ok, true, 'the real start is successful; the save warning is a separate fact')
    assert.match(result.message, /keep this app window open/i)
    assert.doesNotMatch(result.message, /reload.*pick|did not start/i)
    const savedBeforeControls = f.raw()
    assert.equal((await f.start()).ok, false)
    assert.equal(f.handoffs(), 1, 'a refused attachment must not invite a second provider')
    const chat = f.context.treeChatConfigFor(retained)
    assert.equal(typeof chat.onSend, 'function')
    chat.onSend('A follow-up.', {})
    assert.deepEqual(f.sent, [{ sessionId: 'fixture-session', text: 'A follow-up.' }])
    const out = { textContent: '' }
    await f.context.runPaletteAction('stop', retained, out)
    assert.deepEqual(f.stops, ['fixture-session'])
    assert.equal(out.textContent, 'Stopped.')
    assert.equal(f.context.treeStore.getNode(f.node.id).status, 'finished')
    assert.equal(f.context.treeStore.snapshot().persistenceFailed, true)
    assert.equal(f.raw(), savedBeforeControls, 'runtime observations never replace the refused durable record')
  })
}

for (const cleanupRequired of [false, true]) {
  for (const [failure, close] of [
    ['throws', () => { throw new Error('fixture close refused') }],
    ['refuses', () => ({ ok: false, closed: true, sessionId: 'fixture-session' })],
    ['does not prove closure', () => ({ closed: false, sessionId: 'fixture-session' })],
    ['returns no receipt', () => undefined],
    ['names another session', () => ({ closed: true, sessionId: 'another-session' })],
  ]) {
    test(`Stop that ${failure} retains the unsaved ${cleanupRequired ? 'cleanup target' : 'live session'}`, async () => {
      const f = fixture({ after: 'conflict', cleanupRequired })
      await f.start()
      const before = f.context.treeStore.getNode(f.node.id)
      const saved = f.raw()
      f.context.window.mcAgent.close = async request => {
        f.stops.push(request.sessionId)
        return close()
      }
      const out = { textContent: '' }
      await f.context.runPaletteAction('stop', before, out)
      assert.deepEqual(f.stops, ['fixture-session'])
      assert.equal(out.textContent, 'Stop failed.')
      assert.deepEqual(f.context.treeStore.getNode(f.node.id), before)
      assert.equal(f.context.nodeCleanupPending(before), cleanupRequired)
      assert.equal(f.context.nodeBusy(before), !cleanupRequired)
      assert.equal(f.context.RUN_NODE_REMOVAL_CLOSE_RECEIPTS.size, 0)
      assert.equal(f.context.treeStore.removeNode(f.node.id).ok, false)
      assert.equal(f.raw(), saved, 'a refused close must not overwrite the refused durable history')
      assert.equal(f.handoffs(), 1)
    })
  }
}

test('a recovery coordinator failure refuses reopening without losing the retained session or overwriting storage', async () => {
  const f = fixture({ after: 'conflict' })
  await f.start()
  const retained = f.context.treeStore
  const saved = f.raw()
  const createCoordinator = f.context.createAccountRecoveryCoordinator
  f.context.createAccountRecoveryCoordinator = () => { throw new Error('fixture recovery coordinator refused') }
  f.context.releaseTreeStore()
  assert.equal(f.context.openTreeStore('start-fixture'), null)
  assert.match(f.context.treeStoreProblem, /saved trees could not be opened/)
  assert.equal(f.context.RUN_TREE_RUNTIME_STORES.get('start-fixture'), retained)
  assert.equal(retained.getNode(f.node.id).sessionId, 'fixture-session')
  assert.equal(f.context.nodeBusy(retained.getNode(f.node.id)), true)
  assert.equal(f.raw(), saved)
  f.context.createAccountRecoveryCoordinator = createCoordinator
  assert.equal(f.context.openTreeStore('start-fixture'), retained)
  assert.equal(f.context.treeStoreProblem, '')
  assert.equal(f.raw(), saved)
  assert.equal(f.handoffs(), 1)
})

test('completion observations stay visible after a conflict and a later turn becomes busy again', async () => {
  const f = fixture({ after: 'conflict' })
  await f.start()
  const before = f.raw()
  f.context.sessionTurnText.set('fixture-session', 'An actual fixture reply.')
  f.context.sessionOpenTurns.set('fixture-session', 'fixture-turn')
  await f.context.onPacket({ sessionId: 'fixture-session', event: { type: 'turn_completed', status: 'completed', turnId: 'fixture-turn' } })
  assert.equal(f.context.treeStore.getNode(f.node.id).reply, 'An actual fixture reply.')
  assert.equal(f.context.nodeBusy(f.context.treeStore.getNode(f.node.id)), false)
  f.context.markTurnRunning('fixture-session')
  assert.equal(f.context.nodeBusy(f.context.treeStore.getNode(f.node.id)), true)
  assert.equal(f.raw(), before)
  assert.equal(f.context.RUN_TREE_RUNTIME_STORES.get('start-fixture'), f.context.treeStore,
    'a route revisit must retain the same unsaved session view instead of reopening its unbound disk record')
  const retained = f.context.treeStore
  f.context.releaseTreeStore()
  assert.equal(f.context.treeStore, null)
  assert.equal(f.context.openTreeStore('start-fixture'), retained, 'the actual route reopen uses the retained guarded model')
  assert.equal(f.context.treeStore.getNode(f.node.id).sessionId, 'fixture-session')
  assert.equal(f.context.treeStore.getNode(f.node.id).reply, 'An actual fixture reply.')
  assert.equal(f.context.nodeBusy(f.context.treeStore.getNode(f.node.id)), true)
  assert.equal(f.raw(), before)
})

test('the actual Stop handler holds an early completion until acceptance and preserves the queue', async () => {
  const f = fixture()
  await f.start()
  let accept
  const queued = ['Do this after I release it.']
  f.context.window.mcAgent.interrupt = () => new Promise(resolve => { accept = resolve })
  f.context.sessionOpenTurns.set('fixture-session', 'stopped-turn')
  f.context.outboxTakeNext = () => queued.shift()
  const stop = f.context.runPaletteAction('interrupt', f.context.treeStore.getNode(f.node.id), { textContent: '' })
  await Promise.resolve()
  const completing = f.context.onPacket({ sessionId: 'fixture-session', event: { type: 'turn_completed', status: 'interrupted', turnId: 'stopped-turn' } })
  assert.equal(f.context.treeStore.getNode(f.node.id).status, 'running')
  accept({ ok: true })
  await Promise.all([stop, completing])
  assert.equal(f.context.treeStore.getNode(f.node.id).status, 'interrupted')
  assert.equal(f.context.treeStore.getNode(f.node.id).reply, 'Interrupted.')
  assert.deepEqual(queued, ['Do this after I release it.'])
})

test('a rejected Stop preserves the actual failed completion and ordinary queue delivery', async () => {
  const f = fixture()
  await f.start()
  let refuse
  const sent = []
  f.context.window.mcAgent.interrupt = () => new Promise((_resolve, reject) => { refuse = reject })
  f.context.refusalCode = error => error.message
  f.context.PALETTE_PANEL.interruptFailed = code => code
  f.context.sessionOpenTurns.set('fixture-session', 'failed-turn')
  f.context.outboxTakeNext = () => 'Waiting message'
  f.context.drainOutboxMessage = (_session, _node, message) => { sent.push(message) }
  const stop = f.context.runPaletteAction('interrupt', f.context.treeStore.getNode(f.node.id), { textContent: '' })
  await Promise.resolve()
  const completing = f.context.onPacket({ sessionId: 'fixture-session', event: { type: 'turn_completed', status: 'failed', text: 'Provider failed', turnId: 'failed-turn' } })
  refuse(new Error('AGENT_PROVIDER_REFUSED'))
  await Promise.all([stop, completing])
  assert.equal(f.context.treeStore.getNode(f.node.id).status, 'turn-failed')
  assert.match(f.context.treeStore.getNode(f.node.id).reply, /Provider failed/)
  assert.deepEqual(sent, ['Waiting message'])
})

test('only an exact observed session may gain an unsaved runtime binding', () => {
  const f = fixture()
  f.change('conflict')
  const prior = f.raw()
  assert.equal(f.context.treeStore.attachSession(f.node.id, 'unobserved-session').ok, false)
  assert.equal(f.context.treeStore.getNode(f.node.id).sessionId, null)
  f.sessionNodeIds.set('other-node-session', 'another-node')
  assert.equal(f.context.treeStore.attachSession(f.node.id, 'other-node-session').ok, false)
  assert.equal(f.context.treeStore.getNode(f.node.id).sessionId, null)
  f.context.RUN_SESSION_CLEANUPS.set('other-node-cleanup', 'another-node')
  assert.equal(f.context.treeStore.attachSession(f.node.id, 'other-node-cleanup').ok, false)
  assert.equal(f.context.treeStore.getNode(f.node.id).sessionId, null)
  assert.equal(f.raw(), prior)
})

test('session end evidence retires liveness but preserves an unsaved run and its conversation', async () => {
  const f = fixture({ after: 'conflict' })
  await f.start()
  const before = f.raw()
  f.context.onPacket({ sessionId: 'fixture-session', event: { type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null } } })
  assert.equal(f.context.nodeSessionLive(f.context.treeStore.getNode(f.node.id)), false)
  assert.equal(f.context.nodeBusy(f.context.treeStore.getNode(f.node.id)), false)
  assert.equal(f.context.treeStore.getNode(f.node.id).sessionId, 'fixture-session')
  assert.equal(f.raw(), before)
})

test('quota recovery may save the same retained session, without restarting it or overwriting a changed record', async () => {
  const f = fixture({ after: 'write' })
  await f.start()
  f.recover()
  f.context.treeStore.setNodeReply(f.node.id, 'Saved once space is available.')
  f.context.treeStore.setNodeStatus(f.node.id, 'finished')
  assert.equal(f.context.treeStore.snapshot().persistenceFailed, false)
  const saved = JSON.parse(f.raw()).nodes[0]
  assert.equal(saved.sessionId, 'fixture-session')
  assert.equal(saved.reply, 'Saved once space is available.')
  assert.equal(f.handoffs(), 1)
})

test('an ordinary edit that durably saves retained runtime facts clears only their warning', async () => {
  const f = fixture({ after: 'write' })
  await f.start()
  assert.match(f.status.textContent, /could not be saved/)
  f.recover()
  f.context.treeStore.renameTree(f.node.treeId, 'Saving is available again')
  assert.equal(f.context.treeStore.snapshot().persistenceFailed, false)
  assert.equal(f.context.RUN_TREE_RUNTIME_STORES.size, 0)
  assert.equal(JSON.parse(f.raw()).nodes[0].sessionId, 'fixture-session')
  assert.equal(f.status.textContent, 'Started.', 'the recovered warning is not retained as a primary refusal')
})

test('a durably attached proven replacement is not hidden by an earlier unsaved binding', async () => {
  const f = fixture({ after: 'write' })
  await f.start()
  f.recover()
  f.sessionNodeIds.delete('fixture-session')
  f.sessionNodeIds.set('replacement-session', f.node.id)
  assert.equal(f.context.treeStore.attachSession(f.node.id, 'replacement-session').ok, true)
  assert.equal(f.context.treeStore.getNode(f.node.id).sessionId, 'replacement-session')
  assert.equal(f.context.treeStore.snapshot().persistenceFailed, false)
  assert.equal(f.context.RUN_TREE_RUNTIME_STORES.size, 0)
})

test('a route change during handoff retains the real start result and its unsaved session', async () => {
  const f = fixture({ after: 'conflict', leaveDuringStart: true })
  const result = await f.start()
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'fixture-session')
  assert.equal(result.persistenceFailed, true)
  const retained = f.context.treeStore
  f.context.releaseTreeStore()
  f.context.destroyed = false
  assert.equal(f.context.openTreeStore('start-fixture'), retained)
  assert.equal(f.context.treeStore.getNode(f.node.id).sessionId, 'fixture-session')
  assert.equal(f.context.nodeBusy(f.context.treeStore.getNode(f.node.id)), true)
})

test('a durably accepted local removal retires an ended run observation and its warning', async () => {
  const f = fixture({ after: 'write' })
  await f.start()
  f.context.treeStore.setNodeStatus(f.node.id, 'finished')
  f.sessionNodeIds.delete('fixture-session')
  f.recover()
  const removed = f.context.treeStore.removeNode(f.node.id)
  assert.equal(removed.ok, true)
  assert.equal(removed.snapshot.persistenceFailed, false)
  assert.equal(JSON.parse(f.raw()).nodes.length, 0)
  assert.equal(f.context.treeStore.snapshot().persistenceFailed, false)
  assert.equal(f.context.RUN_TREE_RUNTIME_STORES.size, 0)
  assert.doesNotMatch(f.status.textContent, /could not be saved/)
})

test('an unsaved local removal stays warned until a later ordinary edit saves its deletion', async () => {
  const f = fixture({ after: 'write' })
  await f.start()
  f.context.treeStore.setNodeStatus(f.node.id, 'finished')
  f.sessionNodeIds.delete('fixture-session')
  const removed = f.context.treeStore.removeNode(f.node.id)
  assert.equal(removed.ok, true)
  assert.equal(removed.snapshot.persistenceFailed, true)
  assert.equal(f.context.RUN_TREE_RUNTIME_STORES.size, 1)
  assert.equal(JSON.parse(f.raw()).nodes.length, 1)
  f.recover()
  f.context.treeStore.addNode({ role: 'worker', message: 'A different, saved brief.' })
  assert.equal(f.context.treeStore.snapshot().persistenceFailed, false)
  assert.equal(f.context.RUN_TREE_RUNTIME_STORES.size, 0)
  assert.equal(JSON.parse(f.raw()).nodes.some(node => node.id === f.node.id), false)
})

test('another saved writer removing the disk node never retires the controllable unsaved run', async () => {
  const f = fixture({ after: 'write' })
  await f.start()
  f.recover()
  const other = createFleetTreeStore({ computerId: 'start-fixture', storage: safeTreeStorage(f.context.window.localStorage) })
  assert.equal(other.setNodeStatus(f.node.id, 'draft').ok, true)
  assert.equal(other.removeNode(f.node.id).ok, true)
  const newer = f.raw()
  assert.equal(JSON.parse(newer).nodes.length, 0)
  assert.equal(f.context.treeStore.removeNode(f.node.id).ok, false, 'the guarded local removal must refuse its stale backing')
  assert.equal(f.context.RUN_TREE_RUNTIME_STORES.size, 1)
  const retained = f.context.treeStore.getNode(f.node.id)
  assert.equal(retained.sessionId, 'fixture-session')
  assert.equal(f.context.nodeBusy(retained), true)
  await f.context.runPaletteAction('stop', retained, { textContent: '' })
  assert.deepEqual(f.stops, ['fixture-session'])
  assert.equal(f.context.treeStore.getNode(f.node.id).sessionId, 'fixture-session')
  assert.equal(f.raw(), newer)
})

test('a delayed Stop closes only its captured session and never marks an unsaved replacement stopped', async () => {
  const f = fixture({ after: 'conflict' })
  await f.start()
  const saved = f.raw()
  let releaseStop, closeEntered
  const closing = new Promise(resolve => { closeEntered = resolve })
  f.context.window.mcAgent.close = ({ sessionId }) => {
    f.stops.push(sessionId)
    return new Promise(resolve => { releaseStop = resolve; closeEntered() })
  }
  const out = { textContent: '' }
  const stopping = f.context.runPaletteAction('stop', f.context.treeStore.getNode(f.node.id), out)
  // Stop awaits the saved-continuation stop before it calls close, so the
  // replacement must arrive while that close is actually in flight.
  await closing
  f.sessionNodeIds.delete('fixture-session')
  f.sessionNodeIds.set('replacement-session', f.node.id)
  f.context.treeStore.attachSession(f.node.id, 'replacement-session')
  f.context.treeStore.setNodeStatus(f.node.id, 'running')
  releaseStop({ ok: true, closed: true, sessionId: 'fixture-session' })
  await stopping
  assert.equal(out.textContent, 'Stopped.', 'the replacement guard must be exercised after a confirmed close, not after a refused Stop')
  assert.deepEqual(f.stops, ['fixture-session'])
  assert.equal(out.textContent, 'Stopped.', 'this must exercise an accepted close racing a replacement')
  const replacement = f.context.treeStore.getNode(f.node.id)
  assert.equal(replacement.sessionId, 'replacement-session')
  assert.equal(replacement.status, 'running')
  assert.equal(f.context.nodeBusy(replacement), true)
  assert.equal(f.raw(), saved)
})

test('a live observed replacement refuses removal before a terminal underlying node can be deleted', async () => {
  const f = fixture()
  f.stored.attachSession(f.node.id, 'old-fixture-session')
  f.stored.setNodeStatus(f.node.id, 'finished')
  f.sessionNodeIds.set('replacement-session', f.node.id)
  f.change('read')
  f.context.treeStore.attachSession(f.node.id, 'replacement-session')
  f.context.treeStore.setNodeStatus(f.node.id, 'running')
  f.recover()
  const saved = f.raw()
  assert.equal(f.stored.getNode(f.node.id).status, 'finished')
  assert.equal(f.context.nodeBusy(f.context.treeStore.getNode(f.node.id)), true)
  const refused = f.context.treeStore.removeNode(f.node.id)
  assert.equal(refused.ok, false)
  assert.equal(refused.problems[0], NODE_REMOVE_REFUSALS.running)
  assert.equal(f.context.treeStore.getNode(f.node.id).sessionId, 'replacement-session')
  assert.equal(f.raw(), saved, 'the live guard must run before the underlying destructive mutation')
  await f.context.runPaletteAction('stop', f.context.treeStore.getNode(f.node.id), { textContent: '' })
  assert.deepEqual(f.stops, ['replacement-session'])
  f.sessionNodeIds.delete('replacement-session')
  assert.equal(f.context.treeStore.removeNode(f.node.id).ok, true, 'the existing safe terminal removal remains available')
  assert.equal(f.context.RUN_TREE_RUNTIME_STORES.size, 0)
})


for (const leaveBeforeBinding of [false, true]) {
test(`Edit MOVE during a real draft launch reconciles the saved manager${leaveBeforeBinding ? ' after navigation' : ''}`, async () => {
  const f = fixture()
  const context = f.context
  const manager = f.stored.addNode({ role: 'manager' }).node
  f.stored.addNode({ role: 'worker', parentId: manager.id })
  context.treeNodeName = node => nodeDisplayName(node, [], { roleLabel: role => role })
  const requests = []
  context.treeAddressSyncs = new Map()
  context.treeOrgMoveSync = Promise.resolve()
  context.orgAvailability = { state: 'absent' }
  context.orgBridge = () => null
  context.failureSentence = failureSentence
  context.refusalSentence = refusalSentence
  context.sessionProfileIds = new Map()
  context.MOVE_PANEL = { saved: () => 'Saved.', addressNotUpdated: () => 'Address failed.' }
  context.moveSelect = { value: manager.id }
  context.moveOut = { textContent: '' }
  context.node = f.node
  for (const name of ['treeAnchorsFor', 'nodeRequestKeys', 'nodeTreeIdentity', 'treeBranchNodeIds', 'syncTreeBranchAddresses', 'syncSavedTreeMove', 'rememberBoundSessionProfile']) {
    vm.runInContext(functions.get(name), context)
  }
  const move = vm.runInContext('(' + editMoveHandler + ')', context)
  context.window.mcAgent.updateTreeAddress = async request => { requests.push(request); return { ok: true } }
  context.startAgentForNode = async options => {
    assert.equal(options.treeIdentity.managerName, null)
    move()
    assert.equal(f.stored.getNode(f.node.id).parentId, manager.id)
    if (leaveBeforeBinding) { context.releaseTreeStore(); context.destroyed = true }
    options.onSessionOpen({ sessionId: 'fixture-session', threadId: 'fixture-thread' })
    return { ok: true, sessionId: 'fixture-session' }
  }
  assert.equal((await f.start()).ok, true)
  await Promise.all(context.treeAddressSyncs.values())
  await context.treeOrgMoveSync
  assert.equal(requests.at(-1)?.managerName, context.treeNodeName(manager))
  assert.equal(requests.at(-1)?.selfName, context.treeNodeName(f.stored.getNode(f.node.id)))
  assert.equal(requests.at(-1)?.requestKeys.threadId, f.node.id)
  assert.deepEqual(Array.from(requests.at(-1).requestKeys.treeAnchors), [manager.id, f.node.id])
  assert.equal(f.stored.getNode(f.node.id).sessionId, 'fixture-session')
  assert.equal(f.stored.getNode(f.node.id).nameOrdinal, 2, 'only the colliding moved address is renumbered')
  const persisted = JSON.parse(f.raw()).nodes.find(node => node.id === f.node.id)
  assert.equal(persisted.parentId, manager.id)
  assert.equal(persisted.sessionId, 'fixture-session')
  assert.equal(persisted.nameOrdinal, 2)
})
}

for (const accepted of [false, true]) {
  test(`historical completion stays out of the queue after a ${accepted ? 'accepted' : 'refused'} pending interrupt yields`, async () => {
    const f = fixture()
    await f.start()
    const sessionId = 'fixture-session', turnId = 'historical-turn'
    let accept, refuse, drains = 0
    const result = new Promise((resolve, reject) => { accept = resolve; refuse = reject })
    const interrupt = f.context.turnInterrupts.request(sessionId, turnId, () => result)
    f.context.sessionOpenTurns.set(sessionId, turnId)
    f.context.outboxTakeNext = () => { drains++; return null }
    f.context.replayingRemoteHistory = true
    const completion = f.context.handleAgentEvent({ sessionId,
      event: { type: 'turn_completed', status: 'completed', turnId } })
    f.context.replayingRemoteHistory = false
    if (accepted) accept({ ok: true, turnId })
    else refuse(new Error('AGENT_PROVIDER_REFUSED'))
    await Promise.all([interrupt.catch(() => {}), completion])
    assert.equal(drains, 0, 'a historical completion must retain its replay provenance across the acknowledgement')
    f.context.sessionOpenTurns.set(sessionId, 'next-live-turn')
    await f.context.handleAgentEvent({ sessionId,
      event: { type: 'turn_completed', status: 'completed', turnId: 'next-live-turn' } })
    assert.equal(drains, 1, 'a subsequent real completion keeps the normal queue boundary')
  })
}
