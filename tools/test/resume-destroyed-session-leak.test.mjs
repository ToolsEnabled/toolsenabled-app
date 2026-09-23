import { callerCircleRefusal } from '../../src/agent-removal-rule.js'
import { resumeNodeCommandResult } from '../../src/resume-node-command-result.js'
import { hostSessionAlive, settleNodeForCommand } from '../../src/tree-node-settle-wait.js'
import { slotAccountStartOptions } from '../../src/slot-account-choice.js'
import { computersViewAuthorityBindings } from './lib/computers-view-authority-bindings.mjs'
/* A mapped session with no bound node is still unreachable. The previous
   source-order tests explicitly accepted if(treeStore) becoming a no-op on
   navigation. Drive the actual resume, release, stores and Stop instead. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { createRequire } from 'node:module'
import { parseAst } from 'rollup/parseAst'
import { createFleetTreeStore, safeTreeStorage, NODE_STATUSES, NODE_REMOVE_REFUSALS, FLEET_TREE_LIMITS } from '../../src/fleet-trees.js'
import { createTranscriptStore, transcriptSeedText } from '../../src/session-transcript-store.js'
import { nodeIsBusy, sessionEndedWithApp } from '../../src/tree-session-liveness.js'
import { resumableThread } from '../../src/tree-resume-decision.js'
import { resumedTranscriptLines } from '../../src/tree-resume-transcript.js'
import { stopStillOwnsNode } from '../../src/stop-node-session.js'
import { stopNativePersonSession } from '../../src/native-person-stop.js'
import { ENDED_SESSION, RESUME_PANEL, PALETTE_PANEL, QUEUE_PANEL, RECOVERED_SESSION, START_REFUSAL, startRefusalSentence, turnCompletionWords } from '../../src/fleet-tree-copy.js'
import { refusalCodeOf } from '../../src/refusal-copy.js'
import { createAccountRecoveryCoordinator } from '../../src/account-recovery-coordinator.js'
import { createRecoveryHandoffStore } from '../../src/recovery-handoff-store.js'
import { savedSessionEffort, savedAccountResumeRefused } from '../../src/manual-account-continuation.js'
import { createSingleFlight } from '../../src/single-flight.js'
import { createTreeLaunchQueue, isResourceHold } from '../../src/tree-launch-queue.js'
import { createDocument } from './lib/dom-stand-in.mjs'
import { confirmDelivered as outboxConfirmDelivered, requeueFront as outboxRequeueFront } from '../../src/session-outbox.js'
import * as realOutbox from '../../src/session-outbox.js'
import { withResearchTreeBinding } from '../../src/research-tree-session.js'
import { canonicalRootForTests } from '../canonical-root.mjs'

function releasedStartRefusal(request, result) {
  return { ...result, startOutcome: { requestSessionId: request.sessionId,
    admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } }
}

const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const require = createRequire(import.meta.url)
const { createResourceAdmission } = require(path.join(canonicalRootForTests(), 'src/lib/agent-resource-admission.js'))
const functions = new Map()
const initializers = new Map()
const completionDrains = []
let treeCommandMethod = null
function collect(node) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'Property' && node.method && node.key?.name === 'runTreeNodeCommand') treeCommandMethod = source.slice(node.start, node.end)
  if (node.type === 'VariableDeclarator' && node.id?.name && node.init) initializers.set(node.id.name, source.slice(node.init.start, node.init.end))
  if (node.type === 'FunctionDeclaration') functions.set(node.id.name, source.slice(node.start, node.end))
  if (node.type === 'IfStatement' && source.slice(node.test.start, node.test.end).includes('userStopped') &&
      source.slice(node.consequent.start, node.consequent.end).includes('outboxTakeNext(sessionId)')) completionDrains.push(source.slice(node.start, node.end))
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') collect(value)
  }
}
collect(parseAst(source))

function fixture({ mode = 'native', leave = null, failure = null, startRefused = false, startEnded = false, seatGate = null, revokeAfterStart = false, onSeedOpen = null } = {}) {
  const values = new Map(), starts = [], closes = [], mounts = [], conversationRefreshes = []
  const consent = { allowed: true }
  let full = false, unreadable = false
  const backing = {
    getItem(key) { if (unreadable && key.startsWith('mc.fleet.trees')) throw Error('fixture read refused'); return values.get(key) ?? null },
    setItem(key, value) { if (full && key.startsWith('mc.fleet.trees')) throw Error('fixture quota'); values.set(key, value) },
  }
  const storage = safeTreeStorage(backing)
  const stored = createFleetTreeStore({ computerId: 'resume-fixture', storage })
  const node = stored.addNode({ role: 'worker', message: 'The opening words.', tier: 'luna' }).node
  stored.attachSession(node.id, 'old-session')
  stored.setNodeStatus(node.id, 'finished')
  const transcripts = createTranscriptStore({ computerId: 'resume-fixture', storage })
  if (mode !== 'plain') transcripts.save(node.id, {
    lines: [{ who: 'you', text: 'The kept question.', at: 1 }, { who: 'agent', text: 'The kept answer.', at: 2 }],
    threadId: mode === 'native' ? 'old-thread' : null, effort: 'max', provider: 'codex', account: null,
  })
  const owned = new Map([['old-session', node.id]])
  const status = { textContent: '', hidden: true, dataset: {} }
  const context = vm.createContext({
    slotAccountStartOptions, refreshSlotUsage: () => {},
    chatWorkspace: false, isHistoricalReplay: false, nativeReplayIdle: false,
    withResearchTreeBinding, pendingModelChoices: new Map(), pendingModelDrainHolds: new Set(),
    pendingModelDrainBlocked: () => false, applyPendingModelChoice: async () => false,
    refusalAttribution: () => 'provider', keepTryingOnLimitIsOn: async () => false, offerSwitchAndContinue: async () => null, RUN_SESSION_CLEANUP_OBLIGATIONS: new Map(),
    Map, Set, Object, Date, crypto: globalThis.crypto, NODE_STATUSES, NODE_REMOVE_REFUSALS, FLEET_TREE_LIMITS, nodeIsBusy,
    createFleetTreeStore, safeTreeStorage, createTranscriptStore, resumedTranscriptLines, resumableThread,
    transcriptSeedText, ENDED_SESSION, RESUME_PANEL, PALETTE_PANEL, stopStillOwnsNode, stopNativePersonSession, turnCompletionWords,
    savedSessionEffort, savedAccountResumeRefused, isResourceHold, nodeReplacementFlight: createSingleFlight(),
    orgReady: () => false, roleLabel: role => role, roleDisplayFor: role => role, drivenComputerCopy: local => local,
    markTreeStoreLive: () => () => {}, createChatDiffHistoryStore: () => null, syncTreeBranchAddresses: () => {}, /* T138 naming watch: stood in like syncTreeBranchAddresses beside it; naming is not this file's subject. */ syncRenamedCircles: () => {},
    RUN_TREE_RUNTIME_STORES: new Map(), RUN_SESSION_CLEANUPS: new Map(), TREE_RUNTIME_NOT_SAVED_TEXT: 'The latest session changes could not be saved. Keep this app window open to retain its conversation and session controls.',
    RUN_STARTING_TREE_STORES: new Map(), RUN_SESSION_NODES: owned, RUN_NODE_REPLACEMENTS: { busy: () => false },
    RUN_NODE_REMOVAL_CLOSE_RECEIPTS: new Map(), RUN_NATIVE_WORK_CLOSE_LISTENERS: new Set(),
    accountRecoveryCoordinator: null, createAccountRecoveryCoordinator, createRecoveryHandoffStore,
    RUN_RECOVERY_BRIDGE: null, RUN_RECOVERY_BOUND_BRIDGE: null,
    treeStore: stored, treeStoreId: 'resume-fixture', treeStoreProblem: '', transcriptStore: transcripts,
    // The real local view initializes these before opening its saved tree.
    ...computersViewAuthorityBindings(),
    treeStoreUnsub: null, treePersistenceUnsub: null, treeStoreLiveRelease: null, diffHistoryStore: null,
    /* The seat-evidence seam openTreeStore reads (T407 review): settled, because
       the sessions this fixture owns are this run's own. */
    seatSessionEvidence: () => owned,
    destroyed: false, sessionNodeIds: owned, window: { localStorage: backing },
    nodeBusy: node => nodeIsBusy(node, owned), nodeSessionEnded: node => sessionEndedWithApp(node, owned),
    isWriteEnabled: () => consent.allowed, startControlOffReason: () => 'Starting agents is switched off.', START_CONTROL_FLAG: 'start', START_NEEDS_APP_TEXT: () => 'App needed.',
    identityRoleForTreeNode: role => role, roleBindingForStart: () => ({ ok: true, binding: { agentId: 'fixture-agent' } }),
    startProfileId: value => value || null, tierEffortOf: () => 'max',
    resetSessionMetrics: () => {}, notifyNodeStatusListeners: () => {}, LAUNCH_TIERS: [{ id: 'luna', provider: 'codex' }],
    sessionOpenTurns: new Map(), railChat: null,
    recordTurnActions: () => {}, broadcastChatSpeech: () => {}, deliverTurnReply: () => {},
    transcriptAppend: (sessionId, line) => {
      const rows = context.sessionTranscripts.get(sessionId) || []
      rows.push(line); context.sessionTranscripts.set(sessionId, rows)
    },
    nodeRequestKeys: () => null, nodeTreeIdentity: () => null, treeNodeName: n => n.id,
    outboxMoveSession: () => 1, outboxTakeNext: () => { throw Error('destroyed view must not consume queued words') },
    outboxConfirmDelivered, outboxRequeueFront, currentDataSource: () => 'local',
    outboxClearSession: () => 0, rememberBoundSessionProfile: () => {}, statusNote: value => value,
    refreshTree: () => { assert.equal(context.destroyed, false, 'no destroyed-view repaint') },
    deferRailRebuildWhileTyping: fn => fn(), currentRailTreeNode: node,
    controlsPage: { classList: { contains: () => true }, querySelector: () => null },
    showTreeNodeControls: current => mounts.push(current.sessionId), rebindRailToSession: id => mounts.push(context.treeStore?.getNode(id)?.sessionId),
    graph: { refreshConversation(id) {
      assert.equal(context.destroyed, false, 'a retired graph must not refresh')
      conversationRefreshes.push({ nodeId: id, sessionId: context.treeStore?.getNode(id)?.sessionId,
        threadId: context.transcriptStore?.get(id)?.threadId || null })
    } },
    orgReady: () => false, roleLabel: role => role, roleDisplayFor: role => role,
    drivenComputerCopy: local => local, createChatDiffHistoryStore: () => null, markTreeStoreLive: () => () => {}, syncTreeBranchAddresses: () => {}, /* T138 naming watch: stood in like syncTreeBranchAddresses beside it; naming is not this file's subject. */ syncRenamedCircles: () => {},
    orgStatusElement: status, orgStatusTimer: 0, treePersistenceProblem: '', orgStatusPrimary: null,
    setTimeout: () => 1, clearTimeout: () => {}, markRefusalCode: () => {},
    sampleRun: null, sampleRunStore: null, sampleRunTimer: 0, sampleChipFrame: 0,
    sampleChips: new Set(), sampleChats: new Map(), sampleSessionText: new Map(), sessionTurnText: new Map(),
    clearInterval: () => {}, cancelAnimationFrame: () => {},
    retireTreeSessionRuntime: sid => owned.delete(sid), refusalCode: e => e?.code || null, TERMINAL_AGENT_SESSION_CODES: new Set(),
    readerRemedy: text => text, refusalCodeOf, startRefusalSentence,
    sendRefusalSentence: () => 'The fixture session ended.', currentDataSource: () => 'local',
  })
  context.RUN_SESSION_CLEANUPS = vm.runInContext('(' + initializers.get('RUN_SESSION_CLEANUPS') + ')', context)
  context.lastComposedNames = new Map()
  for (const name of ['sessionTranscripts', 'sessionTurnLog', 'sessionUsage', 'sessionModelOverride', 'sessionPendingImages',
    'sessionProfileIds', 'sessionEfforts', 'sessionThreadIds', 'sessionAccountNames', 'nodeActivity', 'nodeReplies', 'nodeDiffHistories']) context[name] = new Map()
  const actual = ['createTreeRuntimeView', 'freshStartExistingNode', 'resumeNodeSession', 'retainStartingTreeStore', 'resumeNodeSessionUnguarded', 'persistTranscript', 'releaseTreeStore', 'openTreeStore',
    'refreshTreeNames', 'reportTreePersistence', 'renderOrgStatus', 'setOrgStatus', 'runPaletteAction', 'closePersonNode', 'settleStoppedSession', 'endedAgentStartOutcome',
    'cancelPendingModelChoice', 'pendingModelChoice', 'savedResearchRestrictionRefusal', 'startOutcomeReleasesCustody', 'nodeCleanupPending', 'retainTreeSessionCleanup', 'withRetainedStartIdentity', 'startCleanupSentence', 'recoveryCoordinator', 'recoveryImageContext', 'stopSampleRun',
    'renamedCircles']
  vm.runInContext(actual.map(name => { assert.ok(functions.has(name), name); return functions.get(name) }).join('\n'), context)
  const view = context.createTreeRuntimeView(stored, owned)
  context.treeStore = view
  context.treePersistenceUnsub = view.subscribe(context.reportTreePersistence)
  function leaveNow() { context.destroyed = true; context.releaseTreeStore() }
  context.ensureSeatForNode = async () => { if (leave === 'identity') leaveNow(); if (seatGate) await seatGate; return { ok: true } }
  context.window.mcAgent = {
    close: async ({ sessionId }) => { closes.push(sessionId); return { ok: true, closed: true, sessionId } },
    start: async spec => {
      starts.push(spec)
      if (revokeAfterStart) consent.allowed = false
      if (failure === 'quota') full = true
      if (failure === 'read') unreadable = true
      if (failure === 'conflict') {
        const other = createFleetTreeStore({ computerId: 'resume-fixture', storage })
        other.addNode({ role: 'manager', message: 'Newer saved history.' })
      }
      if (leave === 'start') leaveNow()
      if (leave === 'reopen') {
        leaveNow()
        context.destroyed = false
        context.openTreeStore('resume-fixture')
        context.treeStore.addNode({ role: 'manager', message: 'Edit made on the reopened page.' })
      }
      if (leave === 'switch') context.openTreeStore('other-fixture')
      if (startRefused) return releasedStartRefusal(spec, { ok: false, message: 'Fixture start refused.' })
      return { ok: true, sessionId: 'new-session', threadId: 'new-thread', ...(startEnded ? { ended: true } : {}), ...(mode === 'native' ? { resumed: { turns: [] } } : {}) }
    },
  }
  context.startAgentForNode = async options => {
    const opened = await context.window.mcAgent.start({ surface: options.surface })
    if (!opened.ok) return opened
    options.onSessionOpen(opened)
    assert.equal(view.getNode(node.id).sessionId, 'new-session', 'seeded send must already have a reachable session')
    if (onSeedOpen) await onSeedOpen({ context, view, node, opened })
    return opened
  }
  const treeBytes = () => [...values].find(([key]) => key.startsWith('mc.fleet.trees'))?.[1]
  return { context, view, node, stored, transcripts, owned, starts, closes, mounts, conversationRefreshes, status, treeBytes, consent, leave: leaveNow,
    resume: (options = {}) => context.resumeNodeSession(view.getNode(node.id), { deliverQueued: false, ...options }),
  }
}

test('a waiting Resume can pause and cancel without losing its saved words or admitting a session', async t => {
  const f = fixture(), outbox = installRealQueue(f, t), wait = installResumeResourceWait(f, t)
  realOutbox.enqueue('old-session', 'KEPT WHILE PAUSED')
  f.context.window.mcAgent.start = async spec => { f.starts.push(spec); return releasedStartRefusal(spec, { ok: false, code: 'AGENT_RESOURCE_PRESSURE' }) }
  const completion = f.resume({ deliverQueued: true })
  await new Promise(resolve => setImmediate(resolve)); await wait.next()
  wait.button('Pause queue').click()
  assert.equal(wait.scheduled.size, 0)
  assert.match(f.context.nodeStartReason(f.view.getNode(f.node.id)), /Resume is paused/)
  assert.equal(f.context.nodeReplacementFlight.busy(f.node.id), true)
  wait.button('Resume queue').click(); await wait.next()
  assert.equal(f.starts.length, 1, 'Resume queue must preserve the existing resource backoff')
  await wait.next()
  assert.equal(f.starts.length, 2)
  wait.button('Cancel queued').click()
  assert.equal(await completion, false)
  assert.deepEqual(outbox.waiting('old-session'), ['KEPT WHILE PAUSED'])
  assert.deepEqual(outbox.deliveries, [])
  assert.equal(f.transcripts.get(f.node.id).threadId, 'old-thread')
  assert.equal(f.context.nodeReplacementFlight.busy(f.node.id), false)
  assert.equal(wait.scheduled.size, 0)
})

test('navigation cancels a queued Resume without touching the saved conversation', async t => {
  const f = fixture(), outbox = installRealQueue(f, t), wait = installResumeResourceWait(f, t)
  realOutbox.enqueue('old-session', 'SURVIVES NAVIGATION')
  f.context.window.mcAgent.start = async spec => { f.starts.push(spec); return releasedStartRefusal(spec, { ok: false, code: 'AGENT_RESOURCE_PRESSURE' }) }
  const completion = f.resume({ deliverQueued: true })
  await new Promise(resolve => setImmediate(resolve)); await wait.next()
  const cleanupStart = source.indexOf('      for (const { queue } of nodeLaunchQueues.values()) queue.cancel()')
  const cleanupEnd = source.indexOf('\n', source.indexOf('      nodeLaunchQueues.clear()', cleanupStart))
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart, 'drive the actual route disposal queue cleanup')
  f.context.destroyed = true
  vm.runInContext(source.slice(cleanupStart, cleanupEnd), f.context)
  f.leave()
  assert.equal(await completion, false)
  assert.equal(f.starts.length, 1); assert.equal(wait.scheduled.size, 0)
  assert.deepEqual(outbox.waiting('old-session'), ['SURVIVES NAVIGATION'])
  assert.deepEqual(outbox.deliveries, [])
  assert.equal(f.context.nodeReplacementFlight.busy(f.node.id), false)
})

for (const boundary of ['identity', 'provider']) test(`Cancel during a retry retains only a session already admitted (${boundary})`, async t => {
    const f = fixture(), outbox = installRealQueue(f, t), wait = installResumeResourceWait(f, t)
    realOutbox.enqueue('old-session', 'KEEP THROUGH CANCEL')
    let release, reached
    const entered = new Promise(resolve => { reached = resolve })
    const pending = new Promise(resolve => { release = resolve })
    f.context.window.mcAgent.start = async spec => {
      f.starts.push(spec)
      if (f.starts.length === 1) return releasedStartRefusal(spec, { ok: false, code: 'AGENT_RESOURCE_PRESSURE' })
      reached(); await pending
      return { ok: true, sessionId: 'new-session', threadId: spec.resumeThreadId, resumed: { turns: [] } }
    }
    const completion = f.resume({ deliverQueued: true })
    await new Promise(resolve => setImmediate(resolve)); await wait.next()
    if (boundary === 'identity') f.context.ensureSeatForNode = async () => { reached(); await pending; return { ok: true } }
    await wait.next(); await entered
    wait.queue().cancel()
    assert.equal(f.context.nodeReplacementFlight.busy(f.node.id), true, 'in-flight work still owns the flight')
    if (boundary === 'provider') f.leave()
    release()
    assert.equal(await completion, boundary === 'provider' ? 'engine' : false)
    assert.equal(f.starts.length, boundary === 'provider' ? 2 : 1)
    assert.equal(f.context.nodeReplacementFlight.busy(f.node.id), false)
    assert.deepEqual(outbox.deliveries, [], 'navigation must not send a queued message from a retired view')
    if (boundary === 'provider') {
      assert.equal(f.view.getNode(f.node.id).sessionId, 'new-session')
      assert.equal(f.owned.get('new-session'), f.node.id)
      assert.deepEqual(outbox.waiting('new-session'), ['KEEP THROUGH CANCEL'])
    } else assert.deepEqual(outbox.waiting('old-session'), ['KEEP THROUGH CANCEL'])
})

for (const channel of ['returned', 'thrown']) test(`a session-bearing resource refusal is never queued or replayed (${channel})`, async t => {
  const f = fixture(), wait = installResumeResourceWait(f, t), refusals = []
  f.context.window.mcAgent.start = async spec => {
    f.starts.push(spec)
    const result = { ok: false, code: 'AGENT_RESOURCE_PRESSURE', sessionId: spec.sessionId }
    if (channel === 'thrown') throw Object.assign(new Error('Receipt uncertain'), result)
    return result
  }
  assert.equal(await f.resume({ onRefused: value => refusals.push(value) }), false)
  assert.equal(f.starts.length, 1); assert.equal(wait.queue(), undefined)
  assert.equal(refusals[0].sessionId, f.starts[0].sessionId); assert.equal(refusals[0].retryable, false)
})

test('an uncertain queued native Resume stops without a transcript-seeded replacement', async t => {
  const f = fixture(), wait = installResumeResourceWait(f, t), refusals = []
  f.context.window.mcAgent.start = async spec => {
    f.starts.push(spec)
    if (f.starts.length === 1) return releasedStartRefusal(spec, { ok: false, code: 'AGENT_RESOURCE_PRESSURE' })
    throw Object.assign(new Error('The reply was lost'), { code: 'FIXTURE_TRANSPORT_UNKNOWN' })
  }
  const completion = f.resume({ onRefused: result => refusals.push(result) })
  await new Promise(resolve => setImmediate(resolve)); await wait.next(); await wait.next()
  assert.equal(await completion, false)
  assert.equal(f.starts.length, 2)
  assert.ok(f.starts.every(spec => spec.resumeThreadId === 'old-thread'))
  assert.equal(refusals.length, 1, 'the caller receives one final refusal after the resource wait')
  assert.equal(refusals[0].code, 'FIXTURE_TRANSPORT_UNKNOWN')
  assert.equal(wait.scheduled.size, 0)
})

for (const field of ['threadId', 'account']) test(`a saved ${field} change stops a queued Resume before another admission`, async t => {
  const f = fixture(), wait = installResumeResourceWait(f, t)
  f.context.window.mcAgent.start = async spec => { f.starts.push(spec); return releasedStartRefusal(spec, { ok: false, code: 'AGENT_RESOURCE_PRESSURE' }) }
  const completion = f.resume()
  await new Promise(resolve => setImmediate(resolve)); await wait.next()
  f.transcripts.save(f.node.id, { ...f.transcripts.get(f.node.id), [field]: 'different-saved-target' })
  await wait.next()
  assert.equal(await completion, false)
  assert.equal(f.starts.length, 1)
  assert.match(f.status.textContent, /changed while Resume waited/)
})

for (const field of ['sessionId', 'tier', 'role']) test(`queued Resume snapshots ${field} even when a caller retains a mutable node`, async t => {
  const f = fixture(), wait = installResumeResourceWait(f, t)
  const mutable = { ...f.view.getNode(f.node.id) }
  f.context.treeStore = { ...f.view, getNode: id => id === mutable.id ? mutable : f.view.getNode(id) }
  f.context.window.mcAgent.start = async spec => { f.starts.push(spec); return releasedStartRefusal(spec, { ok: false, code: 'AGENT_RESOURCE_PRESSURE' }) }
  const completion = f.context.resumeNodeSession(mutable, { deliverQueued: false })
  await new Promise(resolve => setImmediate(resolve)); await wait.next()
  mutable[field] = 'changed-while-waiting'
  await wait.next()
  assert.equal(await completion, false)
  assert.equal(f.starts.length, 1)
  assert.match(f.status.textContent, /agent changed while Resume waited/)
})

test('a delegated resource hold does not replay its one-use authority through the Resume queue', async t => {
  const f = fixture(), wait = installResumeResourceWait(f, t)
  f.context.window.mcAgent.start = async spec => { f.starts.push(spec); return releasedStartRefusal(spec, { ok: false, code: 'AGENT_RESOURCE_PRESSURE' }) }
  assert.equal(await f.resume({ delegationToken: 'one-use-fixture-authority' }), false)
  assert.equal(f.starts.length, 1)
  assert.equal(f.starts[0].delegationToken, 'one-use-fixture-authority')
  assert.equal(wait.queue(), undefined)
  assert.equal(wait.scheduled.size, 0)
})

for (const [boundary, field] of [['identity', 'profile'], ['transcript', 'profile'], ['identity', 'role'], ['transcript', 'account']]) {
  test(`queued Resume rechecks ${field} changed during awaited ${boundary} before admission`, async t => {
    const f = fixture(), wait = installResumeResourceWait(f, t)
    const mutable = { ...f.view.getNode(f.node.id) }
    f.context.treeStore = { ...f.view, getNode: id => id === mutable.id ? mutable : f.view.getNode(id) }
    f.context.window.mcAgent.start = async spec => { f.starts.push(spec); return releasedStartRefusal(spec, { ok: false, code: 'AGENT_RESOURCE_PRESSURE' }) }
    const completion = f.context.resumeNodeSession(mutable, { deliverQueued: false })
    await new Promise(resolve => setImmediate(resolve)); await wait.next()
    let release, reached
    const entered = new Promise(resolve => { reached = resolve })
    const pending = new Promise(resolve => { release = resolve })
    const gate = async () => { reached(); await pending; return { ok: true } }
    if (boundary === 'identity') f.context.ensureSeatForNode = gate
    let releaseTranscript = null
    if (boundary === 'transcript') {
      const ready = new Promise(resolve => { releaseTranscript = resolve })
      f.context.transcriptStore = { ...f.transcripts, ready }
    }
    await wait.next()
    if (boundary === 'identity') await entered
    if (field === 'profile') assert.equal(f.view.setTreeProfile(mutable.treeId, 'changed-fixture-profile').ok, true)
    else if (field === 'role') mutable.role = 'changed-fixture-role'
    else f.transcripts.save(f.node.id, { ...f.transcripts.get(f.node.id), account: 'changed-fixture-account' })
    if (boundary === 'identity') release()
    else releaseTranscript()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.starts.length, 1, 'the changed target must be refused before a second native admission')
    assert.equal(wait.queue(), undefined)
    assert.equal(await completion, false)
    assert.match(f.status.textContent, /changed while Resume waited/)
  })
}

function installRealQueue(f, t) {
  realOutbox.clearSession('old-session')
  realOutbox.clearSession('new-session')
  t.after(() => { realOutbox.clearSession('old-session'); realOutbox.clearSession('new-session') })
  const deliveries = [], deliveredIds = []
  Object.assign(f.context, {
    outboxMoveSession: realOutbox.moveSession, outboxTakeNext: realOutbox.takeNext, outboxEnqueue: realOutbox.enqueue,
    QUEUE_PANEL: { cardQueued: 'queued', cardQueuedIdle: 'sent now' },
    drainOutboxMessage(sessionId, nodeId, entry) {
      deliveredIds.push(entry.id)
      deliveries.push({ sessionId, nodeId, text: entry.text, replacementPending: f.context.nodeReplacementFlight.busy(nodeId) })
      realOutbox.confirmDelivered(sessionId, entry)
      f.view.setNodeStatus(nodeId, 'running')
    },
  })
  vm.runInContext(functions.get('queueForSession'), f.context)
  assert.equal(completionDrains.length, 1, 'exercise the actual single completion drain, not a copied predicate')
  vm.runInContext(`function completionDrain(sessionId, nodeId, userStopped, isHistoricalReplay = false) { ${completionDrains[0]} }`, f.context)
  return { deliveries, deliveredIds, waiting: sessionId => realOutbox.list(sessionId).map(entry => entry.text) }
}

function installResumeResourceWait(f, t) {
  let at = 100000, sequence = 0
  const scheduled = new Map()
  const document = createDocument()
  const statsPage = document.createElement('main')
  statsPage.innerHTML = `<div data-tree-start-controls="${f.node.treeId}"></div>`
  Object.assign(f.context, { document, root: statsPage, statsPage, nodeLaunchQueues: new Map(), treeLaunchQueues: new Map(),
    startingTreeIds: new Set(), startingNodeIds: new Set(), startDraftFlight: createSingleFlight(),
    composeUnavailableReason: () => null, composeStartUnavailableReason: () => null,
    startSetTree() { throw Error('Resume must not start a new tree') }, repaintRailStatus() {},
    createTreeLaunchQueue: options => createTreeLaunchQueue({ ...options, now: () => at,
      schedule(fn, delay) { const id = ++sequence; scheduled.set(id, { fn, at: at + delay }); return id },
      unschedule: id => scheduled.delete(id),
    }),
  })
  const names = ['launchQueuesForTree', 'refreshTreeStartControls', 'nodeStartReason', 'refreshLaunchStatus']
  if (functions.has('resumeNodeSessionQueued')) names.push('resumeNodeSessionQueued')
  vm.runInContext(names.map(name => functions.get(name)).join('\n'), f.context)
  t.after(() => { for (const { queue } of f.context.nodeLaunchQueues.values()) queue.cancel() })
  return { scheduled, now: () => at, advance: ms => { at += ms },
    queue: () => f.context.nodeLaunchQueues.get(f.node.id)?.queue,
    button: text => [...statsPage.querySelectorAll('button')].find(entry => entry.textContent === text),
    async next() {
      const entry = [...scheduled.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      assert.ok(entry, 'the existing queue must own a scheduled retry')
      scheduled.delete(entry[0]); at = Math.max(at, entry[1].at); entry[1].fn()
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}

for (const channel of ['returned', 'thrown']) test(`Resume waits through actual governor CPU pressure and three cool samples (${channel})`, async t => {
  const f = fixture()
  f.view.setNodeStatus(f.node.id, 'interrupted', { note: 'The owner stopped this turn.' })
  f.transcripts.save(f.node.id, { ...f.transcripts.get(f.node.id), account: 'fixture-owner' })
  const outbox = installRealQueue(f, t), wait = installResumeResourceWait(f, t)
  const pending = realOutbox.enqueue('old-session', 'ONE PENDING MESSAGE')
  assert.equal(pending.ok, true)
  const original = f.transcripts.get(f.node.id)
  const governor = createResourceAdmission({ now: wait.now, settings: () => ({ mode: 'mechanical', cpuCeilingPercent: 90, cpuBusyPercent: 85, reserveBytes: 4 * 1024 ** 3 }) })
  const sample = cpuPercent => {
    wait.advance(1000)
    governor.recordSample({ atMs: wait.now(), cpuPercent, freeBytes: 18 * 1024 ** 3, totalBytes: 32 * 1024 ** 3, logicalProcessors: 8, loopLagMs: 0 })
  }
  sample(30); sample(30); sample(30); sample(99)
  assert.equal(governor.inspect({ provider: 'codex' }).code, 'AGENT_RESOURCE_PRESSURE')
  let nativeStarts = 0
  f.context.window.mcAgent.start = async spec => {
    f.starts.push(spec)
    const admission = governor.reserve({ provider: 'codex' })
    if (!admission.ok) {
      const refusal = releasedStartRefusal(spec, admission)
      if (channel === 'thrown') throw Object.assign(new Error(admission.reason || admission.code), refusal)
      return refusal
    }
    nativeStarts++
    governor.ready(admission.token)
    return { ok: true, sessionId: 'new-session', threadId: spec.resumeThreadId, account: spec.resumeAccount, resumed: { turns: [] } }
  }
  const completion = f.resume({ deliverQueued: true, out: { textContent: '' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(wait.queue(), 'a proved resource hold must retain one visible Resume queue')
  assert.equal(f.context.nodeReplacementFlight.busy(f.node.id), true)
  assert.equal(await f.resume(), false, 'a second click must not create another flight')
  await wait.next()
  assert.ok(wait.button('Pause queue')); assert.ok(wait.button('Cancel queued'))
  assert.match(f.context.nodeStartReason(f.view.getNode(f.node.id)), /queued|waiting/i)
  for (let i = 0; i < 2; i++) {
    sample(30); await wait.next()
    assert.equal(nativeStarts, 0, 'two cool samples cannot bypass the real governor')
    assert.deepEqual(outbox.waiting('old-session'), ['ONE PENDING MESSAGE'])
    assert.equal(realOutbox.list('old-session')[0].id, pending.entry.id)
    assert.deepEqual(f.transcripts.get(f.node.id), original)
  }
  sample(30); await wait.next()
  assert.equal(await completion, 'engine')
  assert.equal(nativeStarts, 1)
  assert.ok(f.starts.every(spec => spec.resumeThreadId === 'old-thread' && spec.resumeAccount === 'fixture-owner'))
  assert.equal(f.transcripts.get(f.node.id).threadId, 'old-thread')
  assert.deepEqual(outbox.deliveries.map(row => row.text), ['ONE PENDING MESSAGE'])
  assert.deepEqual(outbox.deliveredIds, [pending.entry.id], 'the original queued entry is delivered exactly once')
  assert.deepEqual(outbox.waiting('old-session'), []); assert.deepEqual(outbox.waiting('new-session'), [])
  assert.equal(f.context.nodeReplacementFlight.busy(f.node.id), false)
  assert.equal(wait.queue(), undefined); assert.equal(wait.scheduled.size, 0)
})

test('a seeded resume moves earlier queued words before publishing the replacement session', async t => {
  let queue
  const f = fixture({ mode: 'seed', onSeedOpen({ context, view, node }) {
    assert.deepEqual(queue.waiting('old-session'), [])
    assert.deepEqual(queue.waiting('new-session'), ['FIRST'], 'the new address must already own the earlier queue')
    const second = context.queueForSession(view.getNode(node.id), 'SECOND')
    assert.equal(second.ok, true)
  } })
  queue = installRealQueue(f, t)
  assert.equal(realOutbox.enqueue('old-session', 'FIRST').ok, true)
  assert.equal(await f.resume(), true)
  assert.deepEqual(queue.waiting('new-session'), ['FIRST', 'SECOND'])
  assert.deepEqual(queue.deliveries, [], 'the seed still owns the turn')
})

for (const outcome of ['finished', 'turn-failed', 'interrupted']) {
  test(`a seed settling ${outcome} before resume acknowledgement preserves the FIFO and the person's Halt`, async t => {
    let queue
    const f = fixture({ mode: 'seed', onSeedOpen({ context, view, node }) {
      view.setNodeStatus(node.id, outcome, { note: `The seed settled ${outcome}.` })
      assert.equal(context.nodeReplacementFlight.busy(node.id), true)
      // The provider event has already written its real terminal status; run
      // the exact completion drain while the start/send promise is pending.
      context.completionDrain('new-session', node.id, outcome === 'interrupted')
      assert.deepEqual(queue.deliveries, [], 'completion cannot consume words before the replacement settles')
      const second = context.queueForSession(view.getNode(node.id), 'SECOND')
      assert.equal(second.ok, true)
      assert.deepEqual(queue.deliveries, [], 'an idle enqueue cannot bypass the same replacement flight')
      assert.deepEqual(queue.waiting('new-session'), ['FIRST', 'SECOND'])
    } })
    queue = installRealQueue(f, t)
    assert.equal(realOutbox.enqueue('old-session', 'FIRST').ok, true)
    assert.equal(await f.resume({ deliverQueued: true }), true)
    assert.equal(f.context.nodeReplacementFlight.busy(f.node.id), false)
    if (outcome === 'interrupted') {
      assert.equal(f.view.getNode(f.node.id).status, 'interrupted')
      assert.equal(f.view.getNode(f.node.id).statusNote, 'The seed settled interrupted.')
      assert.deepEqual(queue.deliveries, [], 'Halt must not silently release the next turn after resume settles')
      assert.deepEqual(queue.waiting('new-session'), ['FIRST', 'SECOND'])
      return
    }
    assert.deepEqual(queue.deliveries, [{ sessionId: 'new-session', nodeId: f.node.id, text: 'FIRST', replacementPending: false }])
    assert.deepEqual(queue.waiting('new-session'), ['SECOND'])
    f.view.setNodeStatus(f.node.id, 'finished')
    f.context.completionDrain('new-session', f.node.id, false)
    assert.deepEqual(queue.deliveries.map(row => row.text), ['FIRST', 'SECOND'])
    assert.deepEqual(queue.waiting('new-session'), [])
  })
}

test('a historical completion preserves queued words until a new live completion', async t => {
  const f = fixture()
  const queue = installRealQueue(f, t)
  assert.equal(realOutbox.enqueue('old-session', 'KEPT DURING REPLAY').ok, true)
  f.context.completionDrain('old-session', f.node.id, false, true)
  assert.deepEqual(queue.deliveries, [], 'recovered history must not release a new turn')
  assert.deepEqual(queue.waiting('old-session'), ['KEPT DURING REPLAY'])
  f.context.completionDrain('old-session', f.node.id, false, false)
  assert.deepEqual(queue.deliveries.map(row => row.text), ['KEPT DURING REPLAY'])
  assert.deepEqual(queue.waiting('old-session'), [])
})

test('delegated native resume carries its grant and never falls back to an ungranted seeded start', async () => {
  const f = fixture({ startRefused: true })
  assert.equal(await f.resume({ delegationToken: 'opaque-lifecycle-grant' }), false)
  assert.equal(f.starts.length, 1)
  assert.equal(f.starts[0].delegationToken, 'opaque-lifecycle-grant')
  assert.equal(f.starts[0].resumeThreadId, 'old-thread')
})

test('renderer Resume leaves the predecessor and maps intact on host account refusal, then admits one replacement', async () => {
  const f = fixture({ startRefused: true })
  const beforeNode = f.view.getNode(f.node.id)
  f.context.window.mcAgent.start = async spec => {
    f.starts.push(spec)
    return releasedStartRefusal(spec, { ok: false, code: 'AGENT_RESUME_ACCOUNT_LIMIT', message: 'saved account is exhausted' })
  }
  assert.equal(await f.resume(), false)
  assert.equal(f.closes.length, 0, 'renderer must not close before host account admission')
  assert.equal(f.owned.get('old-session'), f.node.id, 'old session map survives host refusal')
  assert.equal(f.view.getNode(f.node.id).sessionId, beforeNode.sessionId)
  f.context.window.mcAgent.start = async spec => {
    f.starts.push(spec)
    return { ok: true, sessionId: 'new-session', threadId: 'new-thread', resumed: { turns: [] } }
  }
  assert.equal(await f.resume(), 'engine')
  assert.equal(f.closes.length, 0, 'renderer still delegates predecessor close to the host')
  assert.equal(f.starts.length, 2, 'one refused attempt and one admitted replacement')
  assert.equal(f.starts.at(-1).replacesSessionId, 'old-session')
  assert.equal(f.owned.has('old-session'), false)
  assert.equal(f.owned.get('new-session'), f.node.id)
})

test('delegated resume with no native thread refuses without any start or transcript-seed fallback', async () => {
  const f = fixture({ mode: 'seed' })
  assert.equal(await f.resume({ delegationToken: 'opaque-lifecycle-grant' }), false)
  assert.equal(f.starts.length, 0)
})

for (const channel of ['returned', 'thrown']) test(`a native Resume attempt ${channel} resource hold keeps the stopped conversation without a seeded start`, async t => {
  const f = fixture()
  if (channel === 'returned') f.view.setNodeStatus(f.node.id, 'interrupted', { note: 'The owner stopped this turn.' })
  const queue = installRealQueue(f, t)
  realOutbox.enqueue('old-session', 'KEEP THESE WORDS')
  const beforeNode = f.view.getNode(f.node.id)
  const beforeTranscript = f.transcripts.get(f.node.id)
  const refusals = []
  const out = { textContent: '' }
  f.context.window.mcAgent.start = async spec => {
    f.starts.push(spec)
    const refusal = releasedStartRefusal(spec, { ok: false, code: 'AGENT_RESOURCE_WARMING', message: 'The current CPU window is still fluctuating.' })
    if (channel === 'thrown' && spec.resumeThreadId) throw Object.assign(new Error(refusal.message), refusal)
    return refusal
  }
  assert.equal(await f.context.resumeNodeSessionUnguarded(f.view.getNode(f.node.id), { deliverQueued: false, out, onRefused: value => refusals.push(value) }), false)
  assert.equal(f.starts.length, 1, 'a pre-spawn resource hold is not evidence that the native thread is missing')
  assert.equal(f.starts[0].resumeThreadId, 'old-thread')
  assert.deepEqual(f.view.getNode(f.node.id), beforeNode, 'no new session or turn failed; preserve the stopped node outcome')
  assert.deepEqual(f.transcripts.get(f.node.id), beforeTranscript)
  assert.deepEqual(queue.waiting('old-session'), ['KEEP THESE WORDS'])
  assert.deepEqual(queue.waiting('new-session'), [])
  assert.deepEqual(queue.deliveries, [])
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].code, 'AGENT_RESOURCE_WARMING')
  assert.equal(refusals[0].retryable, true)
  assert.equal(refusals[0].sessionId, null)
  assert.equal(refusals[0].message, out.textContent)
  assert.match(out.textContent, /resource|CPU|stable/i)
  assert.equal(f.status.textContent, out.textContent, 'the refusal remains visible outside the remounted rail')
})

test('a cold-session Send keeps its message behind the existing FIFO when actual Resume waits for resources', async t => {
  const f = fixture()
  const queue = installRealQueue(f, t)
  const wait = installResumeResourceWait(f, t)
  f.owned.delete('old-session')
  f.view.setNodeStatus(f.node.id, 'interrupted', { note: 'The owner stopped this turn.' })
  const first = realOutbox.enqueue('old-session', 'EARLIER QUEUED WORDS')
  assert.equal(first.ok, true)
  const beforeNode = f.view.getNode(f.node.id)
  const beforeTranscript = f.transcripts.get(f.node.id)
  const notes = [], queued = [], refusals = [], replies = []
  let accepted = 0
  Object.assign(f.context, {
    QUEUE_PANEL, RECOVERED_SESSION, START_REFUSAL,
    recoveringNodes: new Set(), outboxCancel: realOutbox.cancel,
  })
  vm.runInContext(functions.get('recoverDeadSessionSend'), f.context)
  f.context.window.mcAgent.close = async ({ sessionId }) => {
    f.closes.push(sessionId)
    throw Object.assign(new Error('This saved session belongs to an earlier app run.'), { code: 'AGENT_SESSION_NOT_FOUND' })
  }
  f.context.window.mcAgent.start = async spec => {
    f.starts.push(spec)
    return releasedStartRefusal(spec, { ok: false, code: 'AGENT_RESOURCE_WARMING' })
  }

  const completion = f.context.recoverDeadSessionSend(beforeNode, 'NEW UNSENT WORDS', {
    note: (sentence, details) => notes.push({ sentence, details }),
    queued: sentence => queued.push(sentence),
    fail: (sentence, details) => refusals.push({ sentence, details }),
    reply: sentence => replies.push(sentence),
    accepted: () => { accepted++ },
  })
  await new Promise(resolve => setImmediate(resolve)); await wait.next()
  assert.deepEqual(queue.waiting('old-session'), ['EARLIER QUEUED WORDS', 'NEW UNSENT WORDS'])
  assert.equal(realOutbox.list('old-session')[0].id, first.entry.id)
  assert.equal(accepted, 0, 'recovery retains the pending admission until Resume settles')
  wait.queue().cancel()
  await completion

  assert.equal(f.starts.length, 1, 'the real recovery-to-Resume path must not try a seeded replacement')
  assert.equal(f.starts[0].resumeThreadId, 'old-thread')
  assert.deepEqual(f.closes, [], 'replacement close is host-owned')
  assert.deepEqual(f.view.getNode(f.node.id), beforeNode)
  assert.deepEqual(f.transcripts.get(f.node.id), beforeTranscript)
  assert.deepEqual(queue.waiting('old-session'), ['EARLIER QUEUED WORDS', 'NEW UNSENT WORDS'])
  assert.equal(realOutbox.list('old-session')[0].id, first.entry.id)
  assert.deepEqual(queue.waiting('new-session'), [])
  assert.deepEqual(queue.deliveries, [])
  assert.equal(accepted, 1, 'the new words are accepted into the outbox, not delivered')
  assert.equal(notes.length, 1)
  assert.equal(notes[0].sentence, RECOVERED_SESSION.reconnecting)
  assert.equal(notes[0].details.retract, true)
  assert.equal(queued.length, 1)
  assert.ok(queued[0].includes(QUEUE_PANEL.waitingForResume), 'settled refusal must explain the required manual retry')
  assert.doesNotMatch(queued[0], /when (?:this|the current) turn finishes/i)
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].details.code, null)
  assert.equal(refusals[0].details.unconfirmed, false)
  assert.equal(refusals[0].details.restoreDraft, undefined, 'queued text must not also be restored as an unaccepted draft')
  assert.equal(refusals[0].sentence, f.status.textContent, 'the actual Resume reason crosses the callback unchanged')
  assert.deepEqual(replies, [], 'product queue and refusal notes are not assistant answers')
  assert.equal(f.context.recoveringNodes.size, 0)
  assert.equal(f.context.nodeReplacementFlight.busy(f.node.id), false)
})

test('a native Resume attempt does not use returning capacity for a transcript-seeded conversation', async () => {
  const f = fixture()
  f.context.window.mcAgent.start = async spec => {
    f.starts.push(spec)
    return f.starts.length === 1
      ? releasedStartRefusal(spec, { ok: false, code: 'AGENT_MEMORY_LOW' })
      : { ok: true, sessionId: 'new-session', threadId: 'different-provider-thread' }
  }
  assert.equal(await f.context.resumeNodeSessionUnguarded(f.view.getNode(f.node.id), { deliverQueued: false }), false)
  assert.equal(f.starts.length, 1)
  assert.equal(f.view.getNode(f.node.id).sessionId, 'old-session')
  assert.equal(f.transcripts.get(f.node.id).threadId, 'old-thread')
})

for (const mode of ['seed', 'plain']) test(`${mode} Resume with no provider thread preserves the stopped node on a resource hold`, async () => {
  const f = fixture({ mode })
  const beforeNode = f.view.getNode(f.node.id)
  const out = { textContent: '' }, refusals = []
  f.context.window.mcAgent.start = async spec => {
    f.starts.push(spec)
    return releasedStartRefusal(spec, { ok: false, code: 'AGENT_MEMORY_LOW', sentence: startRefusalSentence({ ok: false, code: 'AGENT_MEMORY_LOW' }) })
  }
  assert.equal(await f.resume({ out, onRefused: value => refusals.push(value) }), false)
  assert.equal(f.starts.length, 1)
  assert.deepEqual(f.view.getNode(f.node.id), beforeNode)
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].code, 'AGENT_MEMORY_LOW')
  assert.equal(refusals[0].retryable, true)
  assert.match(out.textContent, /memory/i)
})

test('a page reopened during resume shares the pending store and preserves its edits with the replacement', async () => {
  const f = fixture({ leave: 'reopen' })
  assert.ok(await f.resume())
  assert.equal(f.context.treeStore, f.view)
  assert.equal(f.view.snapshot().persistenceFailed, false)
  const saved = JSON.parse(f.treeBytes())
  assert.equal(saved.nodes.find(node => node.id === f.node.id).sessionId, 'new-session')
  assert.ok(saved.nodes.some(node => node.message === 'Edit made on the reopened page.'))
  assert.equal(f.context.RUN_STARTING_TREE_STORES.size, 0)
})

test('a restart retains its store through binding and handoff, then releases it even if the handoff throws', async () => {
  const f = fixture()
  f.context.freshStartExistingNodeUnguarded = async () => {
    f.context.releaseTreeStore()
    assert.equal(f.context.openTreeStore('resume-fixture'), f.view)
    return { ok: true, sessionId: 'replacement' }
  }
  await assert.rejects(f.context.freshStartExistingNode(f.node, { afterBind: async () => {
    assert.equal(f.context.RUN_STARTING_TREE_STORES.get('resume-fixture').store, f.view)
    throw new Error('Handoff refused')
  } }), /Handoff refused/)
  assert.equal(f.context.RUN_STARTING_TREE_STORES.size, 0)
  assert.equal(f.context.nodeReplacementFlight.busy(f.node.id), false)
})

for (const mode of ['native', 'seed', 'plain']) {
  for (const phase of ['seat', 'transcript']) test(`${mode} resume refuses consent revoked during ${phase} without losing the saved conversation`, async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const f = fixture({ mode, ...(phase === 'seat' ? { seatGate: gate } : {}) })
    if (phase === 'transcript') f.context.transcriptStore = { ...f.transcripts, ready: gate }
    const before = f.transcripts.get(f.node.id)
    const pending = f.resume()
    await new Promise(resolve => setImmediate(resolve))
    f.consent.allowed = false
    release()
    assert.equal(await pending, false)
    assert.deepEqual(f.starts, [])
    assert.deepEqual(f.closes, [], 'resume predecessor close is host-owned')
    assert.deepEqual(f.transcripts.get(f.node.id), before)
    assert.equal(f.view.getNode(f.node.id).sessionId, 'old-session')
    assert.equal(f.owned.has('new-session'), false)
  })
  test(`${mode} resume already handed to the host remains owned when consent later turns off`, async () => {
    const f = fixture({ mode, revokeAfterStart: true })
    assert.equal(await f.resume(), mode === 'native' ? 'engine' : true)
    assert.equal(f.view.getNode(f.node.id).sessionId, 'new-session')
    assert.equal(f.owned.get('new-session'), f.node.id)
    assert.deepEqual(f.closes, [], 'resume predecessor close is host-owned')
  })
}

for (const fallback of ['seed', 'plain']) test(`failed native resume rechecks consent before ${fallback} fallback`, async () => {
  const f = fixture({ mode: 'native' })
  if (fallback === 'plain') f.transcripts.save(f.node.id, { ...f.transcripts.get(f.node.id), lines: [] })
  const before = f.transcripts.get(f.node.id)
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.context.window.mcAgent.start = async spec => {
    f.starts.push(spec)
    if (!spec.resumeThreadId) assert.fail('revoked consent allowed a fallback start')
    await gate
    return releasedStartRefusal(spec, { ok: false, message: 'The provider no longer has this thread.' })
  }
  const pending = f.resume()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.starts.length, 1)
  f.consent.allowed = false
  release()
  assert.equal(await pending, false)
  assert.equal(f.starts.length, 1)
  assert.deepEqual(f.transcripts.get(f.node.id), before)
  assert.equal(f.view.getNode(f.node.id).sessionId, 'old-session')
})

for (const mode of ['native', 'seed', 'plain']) {
  test(`${mode} resume healthy control saves and mounts its exact returned session`, async () => {
    const f = fixture({ mode })
    assert.ok(await f.resume())
    assert.equal(f.starts.length, 1)
    assert.equal(f.view.getNode(f.node.id).sessionId, 'new-session')
    assert.equal(JSON.parse(f.treeBytes()).nodes[0].sessionId, 'new-session')
    assert.equal(f.mounts.at(-1), 'new-session')
    assert.equal(f.context.sessionThreadIds.get('new-session'), 'new-thread')
    assert.deepEqual(f.conversationRefreshes, [{ nodeId: f.node.id, sessionId: 'new-session', threadId: mode === 'plain' ? null : 'new-thread' }],
      'the open conversation refreshes only after the new binding and saved history are installed')
  })

  test(`${mode} resume landing after actual release binds its captured store without reviving the old view`, async () => {
    const f = fixture({ mode, leave: 'start' })
    assert.ok(await f.resume())
    assert.equal(f.context.treeStore, null)
    assert.equal(f.context.transcriptStore, null)
    assert.equal(f.owned.get('new-session'), f.node.id)
    assert.equal(f.view.getNode(f.node.id).sessionId, 'new-session')
    assert.equal(JSON.parse(f.treeBytes()).nodes[0].sessionId, 'new-session')
    assert.deepEqual(f.mounts, [])
    assert.deepEqual(f.conversationRefreshes, [])
    if (mode !== 'plain') {
      assert.equal(f.transcripts.get(f.node.id).threadId, 'new-thread')
      assert.equal(f.transcripts.get(f.node.id).provider, 'codex')
      assert.equal(f.transcripts.get(f.node.id).lines[0].text, 'The kept question.')
    }
    f.context.destroyed = false
    f.context.openTreeStore('resume-fixture')
    const current = f.context.treeStore.getNode(f.node.id)
    assert.equal(current.sessionId, 'new-session')
    const stopped = { textContent: '' }
    await f.context.runPaletteAction('stop', current, stopped)
    assert.deepEqual(f.closes, ['new-session'])
    assert.equal(stopped.textContent, PALETTE_PANEL.stopped)
    assert.equal(f.owned.has('new-session'), false)
  })
}

for (const failure of ['conflict', 'read', 'quota']) {
  test(`navigation plus ${failure} retains the resumed session with truthful save failure and unchanged disk`, async () => {
    const f = fixture({ leave: 'start', failure })
    assert.ok(await f.resume())
    const beforeReopen = f.treeBytes()
    assert.equal(f.view.snapshot().persistenceFailed, true)
    assert.equal(f.view.getNode(f.node.id).sessionId, 'new-session')
    assert.equal(f.context.RUN_TREE_RUNTIME_STORES.get('resume-fixture'), f.view)
    f.context.destroyed = false
    assert.equal(f.context.openTreeStore('resume-fixture'), f.view)
    assert.match(f.status.textContent, /Keep this app window open/)
    await f.context.runPaletteAction('stop', f.view.getNode(f.node.id), { textContent: '' })
    assert.deepEqual(f.closes, ['new-session'])
    assert.equal(f.treeBytes(), beforeReopen)
  })
}

for (const leave of ['identity']) {
  test(`leaving during ${leave} before handoff never starts a new provider`, async () => {
    const f = fixture({ leave })
    assert.equal(await f.resume(), false)
    assert.equal(f.starts.length, 0)
    assert.deepEqual(f.mounts, [])
    assert.deepEqual(f.closes, [])
  })
}

test('a refused start after navigation never fabricates a new session binding', async () => {
  const f = fixture({ mode: 'plain', leave: 'start', startRefused: true })
  assert.equal(await f.resume(), false)
  assert.equal(f.view.getNode(f.node.id).sessionId, 'old-session')
  assert.equal(f.owned.has('new-session'), false)
  assert.deepEqual(f.mounts, [])
})

test('switching the visible computer during handoff never attaches or paints into that other store', async () => {
  const f = fixture({ leave: 'switch' })
  assert.ok(await f.resume())
  assert.equal(f.context.destroyed, false)
  assert.equal(f.context.treeStore.snapshot().computerId, 'other-fixture')
  assert.equal(f.context.treeStore.snapshot().nodes.length, 0)
  assert.equal(f.view.getNode(f.node.id).sessionId, 'new-session')
  assert.equal(JSON.parse(f.treeBytes()).nodes[0].sessionId, 'new-session')
  assert.equal(f.transcripts.get(f.node.id).threadId, 'new-thread')
  assert.deepEqual(f.mounts, [])
})

test('a host-proved ended resume is recorded after navigation but is never revived as live', async () => {
  const f = fixture({ leave: 'start', startEnded: true })
  const observedLive = []
  f.stored.subscribe(() => observedLive.push(f.owned.has('new-session')))
  assert.equal(await f.resume(), false)
  assert.equal(f.view.getNode(f.node.id).sessionId, 'new-session')
  assert.equal(JSON.parse(f.treeBytes()).nodes[0].sessionId, 'new-session')
  assert.equal(f.owned.has('new-session'), false)
  assert.equal(observedLive.some(Boolean), false)
  assert.deepEqual(f.mounts, [])
})


test('Resume waits for canonical transcript hydration before closing or choosing a provider thread', async () => {
  const f = fixture()
  let release, hydrated = false
  const ready = new Promise(resolve => { release = resolve })
  f.context.transcriptStore = { ...f.transcripts, ready, get: id => hydrated ? f.transcripts.get(id) : null }
  const pending = f.resume()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.closes.length, 0, 'loading history must not close the current session')
  assert.equal(f.starts.length, 0, 'a missing in-memory cache is not evidence of a missing native thread')
  hydrated = true
  release()
  assert.ok(await pending)
  assert.equal(f.starts[0].resumeThreadId, 'old-thread')
})

test('Resume rereads the current disk thread instead of resuming the stale viewport thread', async () => {
  const f = fixture()
  f.context.transcriptStore = { ...f.transcripts,
    readLatest: async id => ({ ...f.transcripts.get(id), threadId: 'current-disk-thread' }) }
  assert.ok(await f.resume())
  assert.equal(f.starts[0].resumeThreadId, 'current-disk-thread')
})

test('a failed current history read preserves the existing session', async () => {
  const f = fixture()
  f.context.transcriptStore = { ...f.transcripts,
    readLatest: async () => { throw Error('disk unavailable') } }
  assert.equal(await f.resume(), false)
  assert.equal(f.closes.length, 0)
  assert.equal(f.starts.length, 0)
})

for (const code of ['CLAUDE_CLI_EXITED', 'CLAUDE_CLI_INITIALIZE_TIMEOUT', 'CLAUDE_CLI_INITIALIZE_REFUSED']) {
  test(`native resume failing with ${code} opens a fresh agent and carries the conversation and waiting message`, async t => {
    const f = fixture({ mode: 'native' })
    const queue = installRealQueue(f, t)
    assert.equal(realOutbox.enqueue('old-session', 'Continue the saved task.').ok, true)
    const start = f.context.window.mcAgent.start
    const requests = [], seeds = []
    f.context.window.mcAgent.start = async spec => {
      requests.push(spec)
      if (spec.resumeThreadId) throw Object.assign(new Error(code), releasedStartRefusal(spec, { code }))
      return start(spec)
    }
    const seed = f.context.startAgentForNode
    f.context.startAgentForNode = options => { seeds.push(options.historyHandoff); assert.equal(options.automatic, true); return seed(options) }
    assert.equal(await f.resume(), true)
    assert.equal(requests.length, 2)
    assert.equal(requests[0].resumeThreadId, 'old-thread')
    assert.equal(requests[1].resumeThreadId, undefined)
    assert.equal(seeds.length, 1)
    assert.match(seeds[0], /The kept question/)
    assert.match(seeds[0], /The kept answer/)
    assert.deepEqual(queue.waiting('old-session'), [])
    assert.deepEqual(queue.waiting('new-session'), ['Continue the saved task.'])
    assert.equal(f.view.getNode(f.node.id).sessionId, 'new-session')
    assert.equal(f.owned.has('new-session'), true)
  })
}


// T731 / T681: the pre-open guard must never close another node's session.
// These are conditional adversarial host replies, not claims of real UUID collisions.
for (const deferSeed of [false, true]) for (const ownership of ['cleanup owner', 'runtime owner', 'recreated node']) {
  test(`T731 cancelled ${deferSeed ? 'deferred' : 'seed'} fallback preserves ` + ownership + ' before any close or first send', async t => {
    const f = fixture({ mode: 'seed' })
    vm.runInContext(functions.get('startAgentForNode'), f.context)
    const other = f.view.addNode({ role: 'worker', message: 'Independent work.', tier: 'luna' }).node
    f.view.attachSession(other.id, 'other-session')
    f.view.setNodeStatus(other.id, 'running')
    const successor = 'conflicting-successor'
    let entered, release
    const ready = new Promise(resolve => { entered = resolve })
    const held = new Promise(resolve => { release = resolve })
    t.after(() => release())
    let cancelled = false, sends = 0, recreated = false
    const runtime = ownership === 'recreated node' ? { ...f.view,
      getNode: id => recreated && id === f.node.id
        ? { ...f.view.getNode(id), createdAt: 'another-incarnation', sessionId: successor } : f.view.getNode(id),
    } : f.view
    f.context.treeStore = runtime
    f.context.window.mcAgent.send = async () => { sends++; return { ok: true } }
    f.context.window.mcAgent.sendAutomatic = async () => { sends++; return { ok: true, deliveryDisposition: 'accepted', result: { ok: true } } }
    f.context.window.mcAgent.start = async request => {
      f.starts.push(request); entered(); await held
      return { ok: true, sessionId: successor, threadId: 'returned-thread' }
    }
    const pending = f.resume({ isCancelled: () => cancelled, cleanupCancelledStart: true, deferSeed })
    await ready
    cancelled = true
    if (ownership === 'cleanup owner') f.context.RUN_SESSION_CLEANUPS.set(successor, other.id)
    if (ownership === 'runtime owner') f.owned.set(successor, other.id)
    if (ownership === 'recreated node') {
      recreated = true
      f.owned.set(successor, f.node.id)
    }
    const before = [runtime.getNode(f.node.id), runtime.getNode(other.id)]
    const cleanupBefore = [...f.context.RUN_SESSION_CLEANUPS]
    const tokenBefore = [...f.context.RUN_SESSION_CLEANUP_OBLIGATIONS]
    const runtimeBefore = [...f.owned]
    release()
    assert.equal(await pending, false)
    assert.equal(sends, 0, 'no opening message reaches a conflicting successor')
    assert.deepEqual(f.closes, [], 'the cancelled request has no authority to close the other owner')
    assert.deepEqual([...f.context.RUN_SESSION_CLEANUPS], cleanupBefore)
    assert.deepEqual([...f.context.RUN_SESSION_CLEANUP_OBLIGATIONS], tokenBefore)
    assert.deepEqual([...f.owned], runtimeBefore)
    assert.deepEqual([runtime.getNode(f.node.id), runtime.getNode(other.id)], before)
    assert.equal(f.starts.length, 1)
  })
}

test('Resume of an empty saved conversation keeps its exact per-slot account selector', async () => {
  const f = fixture({ mode: 'plain' })
  assert.equal(f.stored.setNodeLaunchPreferences(f.node.id, { accountChoice: { provider: 'codex', name: 'backup' } }).ok, true)
  // The native transcript reader may return binding metadata without speech.
  // The legacy excerpt store requires a line, so supply this reader response
  // at its protocol boundary instead of claiming that legacy save accepted it.
  const empty = { lines: [], provider: 'codex', account: 'backup', threadId: null }
  f.context.transcriptStore = { ...f.transcripts, get: () => empty, readLatest: async () => empty }
  assert.equal(await f.resume(), true)
  assert.equal(f.starts.length, 1)
  assert.equal(f.starts[0].treeAccount, 'backup')
  assert.equal(f.view.getNode(f.node.id).id, f.node.id)
})


// T774: execute the shipping broker handler, Resume and picker producer together.
// Only host admission, account/catalog I/O and the final DOM mount are injected.
function machineResumePopupFixture({ refusal = 'AGENT_RESUME_ACCOUNT_LIMIT', keepTrying = false, unknown = false } = {}) {
  const f = fixture()
  const parent = f.view.addNode({ role: 'manager', message: 'Manage the child.', tier: 'luna' }).node
  assert.equal(f.view.moveNode(f.node.id, parent.id).ok, true)
  f.owned.set('parent-session', parent.id)
  const popups = [], continuations = [], sends = [], queued = []
  f.context.nodeLaunchQueues = new Map()
  f.context.refreshTreeStartControls = () => {}
  f.context.refreshLaunchStatus = () => {}
  // The queued scheduler boundary records admission without a real delay.
  f.context.createTreeLaunchQueue = spec => { queued.push(spec); return { done: Promise.resolve({ results: [{ ok: false, code: refusal }], cancelled: false }) } }
  vm.runInContext(functions.get('resumeNodeSessionQueued'), f.context)
  f.context.bootPromise = Promise.resolve()
  f.context.projectionReady = Promise.resolve()
  f.context.MANAGED_SLOT_ACTIONS = {}
  f.context.callerCircleRefusal = callerCircleRefusal
  f.context.resumeNodeCommandResult = resumeNodeCommandResult
  // T839 (218bbe5c): supply the real recovery-wait dependencies of the extracted command.
  f.context.hostSessionAlive = hostSessionAlive
  f.context.settleNodeForCommand = settleNodeForCommand
  f.context.document = { body: {} }
  f.context.switchDialogs = new Map()
  f.context.mockSource = () => false
  f.context.loadAccounts = async () => ({ accounts: [] })
  f.context.readStartableTiers = async () => ({ answered: true, tiers: ['luna'] })
  f.context.EFFORT_CHOICES = []
  f.context.switchChoices = () => []
  f.context.mountSwitchAndContinueDialog = options => { popups.push(options); return { shown: true, markStale: () => false } }
  /* T775: the picker watches its circle through the status choke point and
     releases that watch with the dialog; the seam is a no-op here, the popup
     record above is what these cases read. */
  f.context.registerNodeStatusListener = () => () => {}
  f.context.keepTryingOnLimitIsOn = async () => keepTrying
  f.context.continueNodeOnAnotherAccount = async () => { continuations.push('account'); return false }
  f.context.startAgentForNode = async () => { sends.push('seed'); return { ok: false } }
  f.context.window.mcAgent.start = async request => {
    f.starts.push(request)
    if (unknown === 'missing') return undefined
    if (unknown === 'malformed') return { ok: true }
    return unknown ? { ok: false, code: 'START_UNKNOWN' }
      : refusal ? releasedStartRefusal(request, { ok: false, code: refusal })
        : { ok: true, sessionId: 'new-session', threadId: 'old-thread', resumed: { turns: [] } }
  }
  vm.runInContext(functions.get('offerSwitchAndContinue') + '\nthis.commandHandler = ({' + treeCommandMethod + '}).runTreeNodeCommand', f.context)
  const command = { action: 'resume-node', computerId: 'resume-fixture', nodeId: f.node.id,
    parentSessionId: 'parent-session', expectedSessionId: 'old-session' }
  return { ...f, popups, continuations, sends, queued, command, run: overrides => f.context.commandHandler({ ...command, ...overrides }) }
}

for (const delegated of [false, true]) for (const keepTrying of [false, true]) {
  test(`T774 ${delegated ? 'delegated' : 'unrestricted'} machine Resume account refusal stays with requester, retry setting ${keepTrying}`, async () => {
    const f = machineResumePopupFixture({ keepTrying })
    const before = f.transcripts.get(f.node.id)
    const result = await f.run(delegated ? { delegationToken: 'trusted-delegation' } : {})
    assert.equal(f.popups.length, 0, 'machine refusal must not open the owner account picker')
    assert.equal(f.continuations.length, 0, 'machine refusal must not silently switch accounts')
    assert.equal(f.sends.length, 0, 'machine refusal must not seed or replay a turn')
    assert.equal(f.starts.length, 1)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'AGENT_RESUME_ACCOUNT_LIMIT', 'the requester receives the actual account refusal')
    assert.match(result.reason, /account|allowance/i)
    assert.equal(f.view.getNode(f.node.id).sessionId, 'old-session')
    assert.equal(f.owned.get('old-session'), f.node.id)
    assert.deepEqual(f.transcripts.get(f.node.id), before)
  })
}

test('T774 manual Resume keeps its account picker after a confirmed refusal', async () => {
  const f = machineResumePopupFixture()
  assert.equal(await f.resume(), false)
  // offerSwitchAndContinue deliberately settles independently of Resume.
  await Promise.resolve()
  assert.equal(f.popups.length, 1)
  assert.equal(f.popups[0].host, f.context.document.body)
  assert.match(f.popups[0].refusalSentence, /account|allowance/i)
  assert.equal(f.starts.length, 1)
})

for (const unknown of [true, 'missing', 'malformed']) test(`T774 machine ${unknown} admission keeps cleanup custody and never opens a picker or replays`, async () => {
  const f = machineResumePopupFixture({ unknown })
  const result = await f.run()
  assert.equal(result.ok, false)
  assert.equal(f.starts.length, 1)
  assert.equal(f.sends.length, 0)
  assert.equal(f.popups.length, 0)
  assert.equal(f.continuations.length, 0)
  assert.equal(f.context.RUN_SESSION_CLEANUPS.size, 1)
  assert.equal(result.code, unknown === true ? 'START_UNKNOWN' : 'AGENT_SESSION_CLEANUP_FAILED')
  assert.match(result.reason, /cleanup|close|stopp/i)
})

test('T774 machine resource refusal is returned without a hidden queued retry', async () => {
  const f = machineResumePopupFixture({ refusal: 'AGENT_MEMORY_LOW' })
  const result = await f.run()
  assert.equal(result.ok, false)
  assert.equal(f.queued.length, 0, 'machine refusal must not enter the launch retry queue')
  assert.equal(result.code, 'AGENT_MEMORY_LOW')
  assert.equal(f.starts.length, 1)
  assert.equal(f.popups.length, 0)
  assert.equal(f.sends.length, 0)
})

test('T774 machine successful Resume binds once without owner interruption', async () => {
  const f = machineResumePopupFixture({ refusal: null })
  f.context.outboxTakeNext = () => null
  const result = await f.run()
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'new-session')
  assert.equal(f.starts.length, 1)
  assert.equal(f.popups.length, 0)
  assert.equal(f.sends.length, 0)
})

for (const changed of [{ parentSessionId: 'unknown-parent' }, { expectedSessionId: 'other-session' }]) {
  test(`T774 machine binding refusal preserves ownership: ${Object.keys(changed)[0]}`, async () => {
    const f = machineResumePopupFixture()
    const result = await f.run(changed)
    assert.equal(result.ok, false)
    assert.equal(f.starts.length, 0)
    assert.equal(f.popups.length, 0)
    assert.equal(f.view.getNode(f.node.id).sessionId, 'old-session')
  })
}

for (const delegated of [false, true]) test(`T774 machine released missing-thread refusal cannot seed a new turn, delegated ${delegated}`, async () => {
  const f = machineResumePopupFixture({ refusal: 'CLAUDE_CLI_INITIALIZE_REFUSED' })
  const before = f.transcripts.get(f.node.id)
  const result = await f.run(delegated ? { delegationToken: 'trusted-delegation' } : {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CLAUDE_CLI_INITIALIZE_REFUSED')
  assert.equal(f.starts.length, 1)
  assert.equal(f.sends.length, 0, 'a machine refusal must not start a transcript-seeded turn')
  assert.equal(f.queued.length, 0)
  assert.equal(f.popups.length, 0)
  assert.deepEqual(f.transcripts.get(f.node.id), before)
})
