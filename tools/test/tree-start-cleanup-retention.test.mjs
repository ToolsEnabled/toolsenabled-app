import { createImageConversation } from '../../src/image-conversation.js'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createAgentHost } from '../../shell/agent-host.cjs'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'
import { realOutbox } from './fixtures/recovery-outbox.mjs'
import { createSessionTextReader } from '../../src/agent-session-events.js'
import { slotAccountStartOptions } from '../../src/slot-account-choice.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test, { beforeEach } from 'node:test'
import { useStartConsent } from './lib/start-consent-fixture.mjs'
import { savedSessionEffort, savedAccountResumeRefused } from '../../src/manual-account-continuation.js'
import { createTurnInterrupts } from '../../src/turn-interrupts.js'
import { createSingleFlight } from '../../src/single-flight.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { createPendingApprovals } from '../../src/approval-answer.js'
import { isResourceHold } from '../../src/tree-launch-queue.js'
import { stopNativePersonSession } from '../../src/native-person-stop.js'
import { withResearchTreeBinding } from '../../src/research-tree-session.js'

beforeEach(t => { useStartConsent(t) })
import { parseAst } from 'rollup/parseAst'

register('./css-loader.mjs', import.meta.url)

const {
  startAgentForNode, withRetainedStartIdentity, retainTreeSessionCleanup, nodeCleanupPending,
} = await import('../../src/views/computers.js')
const { createFleetTreeStore, NODE_REMOVE_REFUSALS } = await import('../../src/fleet-trees.js')
const { executeFreshStartExistingNode } = await import('../../src/fresh-start-existing-node.js')
const { nodeIsBusy, sessionIsLive } = await import('../../src/tree-session-liveness.js')
const { stopStillOwnsNode } = await import('../../src/stop-node-session.js')
const { resumableThread } = await import('../../src/tree-resume-decision.js')
const { transcriptSeedText } = await import('../../src/session-transcript-store.js')
const { refusalCode } = await import('../../src/agent-availability-copy.js')
const { refusalCodeOf, readerRemedy } = await import('../../src/refusal-copy.js')
const { RESUME_PANEL, PALETTE_PANEL, startRefusalSentence, restartRefusalSentence, turnCompletionWords } = await import('../../src/fleet-tree-copy.js')

const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const retentionFunction = parseAst(source).body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'retainStartingTreeStore')
assert.ok(retentionFunction, 'the actual starting-store retention function must exist')

// Run the complete closure-private functions, with their real start and store
// implementations. Only browser presentation and the IPC endpoint are supplied
// by the fixture; no copied branch or source-pattern assertion proves behavior.
function viewFunction(name, scope) {
  // Include exactly the declaration, not intervening closure initializers
  // between this function and whichever function happens to follow it.
  const readFunction = target => declaredFunctionSource(source, target)
  // Stop now settles the visible turn before it retires routing. Execute both
  // real callees in this same scope so navigation and replacement guards see
  // the same store, not a no-op standing in for the new behavior.
  const dependencies = ['clearSessionApprovals', 'savedResearchRestrictionRefusal', ...(name === 'runPaletteAction' ? ['cancelPendingModelChoice', 'retireTreeSessionRuntime', 'settleStoppedSession', 'closePersonNode'] : [])]
  return new Function(...Object.keys(scope), `
    ${[...dependencies, name].map(readFunction).join('\n')}
    return { run: ${name}, destroy() { destroyed = true; treeStore = null } }
  `)(...Object.values(scope))
}

function fixture(t, { saved = null, bridge = {} } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else delete globalThis.window
  })
  const cells = new Map()
  const storage = {
    read: key => cells.has(key) ? JSON.parse(cells.get(key)) : null,
    write: (key, value) => { cells.set(key, JSON.stringify(value)); return true },
  }
  let nextId = 0
  const store = createFleetTreeStore({ computerId: 'cleanup-proof', storage, makeId: kind => `${kind}-${++nextId}` })
  const created = store.addNode({ role: 'coordinator', message: 'Safe isolated proof.' })
  assert.equal(created.ok, true)
  const node = created.node
  const cleanups = new Map()
  const routes = new Map()
  const calls = { start: [], close: [], send: [], status: [], rebind: [], transcript: [], replies: [], approval: [], actions: [] }
  let rejectStart
  const pendingStart = new Promise((resolve, reject) => { rejectStart = reject })
  let startEntered
  const entered = new Promise(resolve => { startEntered = resolve })
  const endpoint = {
    async start(request) { calls.start.push(request); startEntered(); return pendingStart },
    async send(request) { calls.send.push(request); return { ok: true } },
    async sendAutomatic(request) { calls.send.push({ ...request, origin: 'automatic' }); return { ok: true, deliveryDisposition: 'accepted', result: { ok: true, turnId: 'automatic-first' } } },
    async close(request) { calls.close.push(request); return { closed: true } },
    ...bridge,
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { mcAgent: endpoint } })
  const noop = () => {}
  const retainStartingTreeStore = new Function('RUN_STARTING_TREE_STORES', `
    ${source.slice(retentionFunction.start, retentionFunction.end)}
    return retainStartingTreeStore
  `)(new Map())
  const scope = {
    slotAccountStartOptions, pendingModelChoices: new Map(), sessionTextReader: createSessionTextReader(),
    stopNativePersonSession,
    destroyed: false, treeStore: store, transcriptStore: { get: () => saved, has: () => Boolean(saved), remove: () => true },
    diffHistoryStore: null, composePanel: null, railChat: null, treeStoreProblem: '',
    chatWorkspace: null,
    currentRailTreeNode: null, confirmedRefusals: new Map(),
    RUN_SESSION_CLEANUPS: cleanups, RUN_NODE_REMOVAL_CLOSE_RECEIPTS: new Map(), sessionNodeIds: routes, startingNodeIds: new Set(),
    RUN_NATIVE_WORK_CLOSE_LISTENERS: new Set(), nativeReconcileSessions: new Set(), sessionCompletedTurnIds: new Map(),
    nodeReplacementFlight: createSingleFlight(), startDraftFlight: createSingleFlight(),
    // Stop consults the account recovery coordinator (d839fa41); this fixture runs with none.
    recoveryCoordinator: () => null,
    nodeCleanupPending: candidate => nodeCleanupPending(candidate, cleanups),
    retainTreeSessionCleanup: (target, nodeId, sessionId, options) => retainTreeSessionCleanup(target, nodeId, sessionId, { ...options, cleanups }),
    withRetainedStartIdentity, withResearchTreeBinding, startAgentForNode, executeFreshStartExistingNode, retainStartingTreeStore,
    startCleanupSentence: () => 'Cleanup has not finished. Try Stop again.',
    currentDataSource: () => 'local', mockSource: () => false, isWriteEnabled: () => true,
    START_CONTROL_FLAG: 'agent-session', START_NEEDS_APP_TEXT: () => 'Needs the app.',
    startControlOffReason: () => 'Starting is off.',
    identityRoleForTreeNode: role => role, ensureSeatForNode: async () => ({ ok: true }),
    roleBindingForStart: () => ({ ok: true, binding: { agentId: 'proof-agent' } }),
    startProfileId: () => null, tierEffortOf: () => 'high', draftStartEffort: () => 'high',
    nodeRequestKeys: candidate => ({ nodeId: candidate.id }), nodeTreeIdentity: () => null,
    nodeBusy: candidate => nodeIsBusy(candidate, routes),
    nodeSessionLive: candidate => sessionIsLive(candidate, routes),
    briefContextFor: () => ({}), composeNodeBrief: ({ message }) => message,
    roleDisplayFor: role => role, treeNodeName: candidate => candidate.role,
    startingLine: () => 'Starting.', startStalledLine: () => 'Still starting.', startStallMs: () => 60_000,
    statusNote: sentence => sentence, setOrgStatus: (...args) => calls.status.push(args),
    refreshTree: noop, rebindRailToSession: nodeId => calls.rebind.push(nodeId),
    rememberBoundSessionProfile: noop, resetSessionMetrics: noop, notifyNodeStatusListeners: noop,
    turnInterrupts: createTurnInterrupts(), turnCompletionWords,
    recordTurnActions: sessionId => calls.actions.push(sessionId),
    transcriptAppend: (sessionId, entry) => calls.transcript.push({ sessionId, entry }),
    deliverTurnReply: (sessionId, text, turnId) => calls.replies.push({ sessionId, text, turnId }),
    clearInlineApproval: (sessionId, approvalId) => calls.approval.push({ sessionId, approvalId }),
    outboxClearSession: () => 0, stopStillOwnsNode, resumableThread, transcriptSeedText, savedSessionEffort, savedAccountResumeRefused, isResourceHold,
    refusalCode, refusalCodeOf, readerRemedy, startRefusalSentence, restartRefusalSentence, RESUME_PANEL, PALETTE_PANEL, NODE_REMOVE_REFUSALS,
    LAUNCH_TIERS: [{ id: node.tier, provider: 'codex' }],
    TERMINAL_AGENT_SESSION_CODES: new Set(['MC_AGENT_UNKNOWN_SESSION', 'MC_AGENT_SESSION_ENDED']),
  }
  for (const key of [
    'remoteAppliedSequences', 'sessionTranscripts', 'sessionTurnLog', 'sessionUsage', 'sessionModelOverride', 'sessionPendingImages',
    'sessionProfileIds', 'sessionEfforts', 'sessionThreadIds', 'sessionAccountNames',
    'nodeDiffHistories', 'nodeReplies', 'nodeActivity', 'nodeLastTool',
    'sessionTurnText', 'sessionOpenTurns', 'sessionPendingApprovals', 'sessionActions', 'sessionRuleCalls', 'turnReplies', 'standaloneSettledTurns',
  ]) scope[key] = new Map()
  scope.sessionPendingApprovals = createPendingApprovals()
  return {
    store, node, cleanups, routes, calls, endpoint, scope, entered,
    rejectStart: (code = 'AGENT_SESSION_CLEANUP_FAILED') => rejectStart(new Error(`Error invoking remote method: ${code}`)),
    function: name => viewFunction(name, scope),
    reload: () => createFleetTreeStore({ computerId: 'cleanup-proof', storage }),
  }
}

function assertRetained(f) {
  const target = f.calls.start.at(-1).sessionId
  assert.equal(typeof target, 'string')
  assert.ok(target.length > 0)
  const node = f.store.getNode(f.node.id)
  assert.equal(node.sessionId, target)
  assert.equal(node.status, 'failed')
  assert.equal(nodeCleanupPending(node, f.cleanups), true)
  assert.equal(sessionIsLive(node, f.routes), false)
  assert.equal(nodeIsBusy(node, f.routes), false)
  assert.deepEqual(f.calls.send, [])
  return target
}

for (const phase of ['seat', 'close']) {
  test(`actual fresh-start mount reads live consent after ${phase} await`, async t => {
    const saved = { lines: [{ who: 'you', text: 'Keep this conversation.' }] }
    const f = fixture(t, { saved })
    f.endpoint.start = async request => { f.calls.start.push(request); return { ok: true, sessionId: 'unexpected-start' } }
    f.store.attachSession(f.node.id, 'old-session')
    f.routes.set('old-session', f.node.id)
    let allowed = true, release
    const gate = new Promise(resolve => { release = resolve })
    f.scope.isWriteEnabled = () => allowed
    if (phase === 'seat') f.scope.ensureSeatForNode = async () => { await gate; return { ok: true } }
    else f.endpoint.close = async request => { f.calls.close.push(request); await gate; return { ok: true } }
    const pending = f.function('freshStartExistingNodeUnguarded').run(f.store.getNode(f.node.id))
    await new Promise(resolve => setImmediate(resolve))
    allowed = false
    release()
    const result = await pending
    assert.equal(result.code, 'MC_TREE_COMMAND_START_DISABLED')
    assert.equal(f.calls.start.length, 0)
    assert.equal(f.calls.close.length, phase === 'close' ? 1 : 0)
    assert.equal(f.store.getNode(f.node.id).sessionId, 'old-session')
    assert.equal(f.routes.get('old-session'), f.node.id)
    assert.deepEqual(f.scope.transcriptStore.get(f.node.id), saved)
  })
}

test('draft start cleanup retains its exact ID even after the owning view was destroyed', async t => {
  const f = fixture(t)
  const start = f.function('startDraftNodeUnguarded')
  const pending = start.run(f.node)
  await f.entered
  start.destroy()
  f.rejectStart()
  assert.equal((await pending).ok, false)
  const target = assertRetained(f)
  assert.equal(f.reload().getNode(f.node.id).sessionId, target, 'view navigation must keep the failed cleanup reachable')
  assert.equal(nodeCleanupPending(f.reload().getNode(f.node.id), new Map()), false,
    'a persisted ID alone does not imply retained cleanup after a whole app restart')
})

for (const mode of ['native', 'seed', 'empty']) {
  test(`${mode} resume retains startup cleanup and never tries a second start`, async t => {
    const saved = mode === 'empty' ? null : {
      ...(mode === 'native' ? { threadId: 'saved-thread', provider: 'codex' } : {}),
      lines: [{ who: 'you', text: 'Remembered request.', at: 1 }],
    }
    const f = fixture(t, { saved })
    const resume = f.function('resumeNodeSessionUnguarded')
    const pending = resume.run(f.node, { out: {} })
    await f.entered
    f.rejectStart()
    assert.equal(await pending, false)
    assertRetained(f)
    assert.equal(f.calls.start.length, 1, 'cleanup failure must suppress native-resume fallback')
    assert.deepEqual(f.calls.rebind, [f.node.id])
    assert.equal(await resume.run(f.store.getNode(f.node.id), { out: {} }), false)
    assert.equal(f.calls.start.length, 1, 'another Resume must not overwrite the cleanup ID')
  })
}

// Request-bound native receipts, exercised through the actual resume closure.
for (const mode of ['pending', 'unknown', 'missing', 'malformed', 'mismatched', 'admitted', 'thrown']) {
  test(`F1 native ${mode} outcome retains exact custody without fallback`, async t => {
    const saved = { threadId: 'saved-thread', provider: 'codex',
      lines: [{ who: 'you', text: 'Remembered request.', at: 1 }] }
    const f = fixture(t, { saved })
    f.endpoint.start = async request => {
      f.calls.start.push(request)
      const released = { requestSessionId: request.sessionId, admission: 'not-admitted',
        cleanup: 'not-required', custody: 'none' }
      const outcomes = {
        pending: { ...released, admission: 'unknown', cleanup: 'pending', custody: 'cleanup-pending' },
        unknown: { ...released, admission: 'unknown' },
        malformed: { ...released, cleanup: 'pending' },
        mismatched: { ...released, requestSessionId: 'another-request' },
        admitted: { ...released, admission: 'admitted', custody: 'session' },
      }
      const result = { ok: false, code: 'AGENT_ENGINE_INVALID_SESSION', sessionId: 'untrusted-reply-id',
        ...(outcomes[mode] ? { startOutcome: outcomes[mode] } : {}) }
      if (mode === 'thrown') throw Object.assign(new Error(result.code), result)
      return result
    }
    const resume = f.function('resumeNodeSessionUnguarded')
    assert.equal(await resume.run(f.node, { out: {} }), false)
    assert.equal(f.calls.start.length, 1, 'an uncertain native attempt must not start a fallback')
    assertRetained(f)
    assert.equal(await resume.run(f.store.getNode(f.node.id), { out: {} }), false)
    assert.equal(f.calls.start.length, 1)
  })
}

for (const cleanup of ['not-required', 'confirmed']) {
  test(`F1 released ${cleanup} native outcome permits the existing fallback`, async t => {
    const f = fixture(t, { saved: { threadId: 'saved-thread', provider: 'codex',
      lines: [{ who: 'you', text: 'Remembered request.', at: 1 }] } })
    f.endpoint.start = async request => {
      f.calls.start.push(request)
      return { ok: false, code: 'AGENT_ENGINE_INVALID_SESSION', startOutcome: {
        requestSessionId: request.sessionId, admission: cleanup === 'confirmed' ? 'unknown' : 'not-admitted',
        cleanup, custody: 'none',
      } }
    }
    assert.equal(await f.function('resumeNodeSessionUnguarded').run(f.node, { out: {} }), false)
    assert.equal(f.calls.start.length, 2, 'released native attempt must preserve transcript fallback')
    assert.equal(f.calls.start[0].resumeThreadId, 'saved-thread')
    assert.equal(f.calls.start[1].resumeThreadId, undefined)
    assert.equal(f.cleanups.size, 0)
    assert.equal(f.calls.send.length, 0)
  })
}

test('fresh replacement retains its failed-start cleanup and refuses another replacement', async t => {
  const f = fixture(t)
  const restart = f.function('freshStartExistingNodeUnguarded')
  const pending = restart.run(f.node)
  await f.entered
  f.rejectStart()
  const result = await pending
  const target = assertRetained(f)
  assert.equal(result.sessionId, target)
  assert.equal(result.ok, false)
  const retry = await restart.run(f.store.getNode(f.node.id))
  assert.equal(retry.code, 'AGENT_SESSION_CLEANUP_FAILED')
  assert.equal(retry.sessionId, target)
  assert.equal(f.calls.start.length, 1)
})

test('Stop keeps retained cleanup after rejection or a refused receipt, then removes it on confirmed close', async t => {
  const f = fixture(t)
  retainTreeSessionCleanup(f.store, f.node.id, 'cleanup-target', { cleanups: f.cleanups })
  const stop = f.function('runPaletteAction')
  const node = f.store.getNode(f.node.id)
  const out = {}
  f.endpoint.close = async ({ sessionId }) => { f.calls.close.push(sessionId); throw new Error('AGENT_SESSION_CLEANUP_FAILED') }
  await stop.run('stop', node, out)
  assert.equal(nodeCleanupPending(f.store.getNode(node.id), f.cleanups), true)
  assert.equal(f.store.getNode(node.id).status, 'failed')
  f.endpoint.close = async ({ sessionId }) => { f.calls.close.push(sessionId); return { ok: false } }
  await stop.run('stop', node, out)
  assert.equal(nodeCleanupPending(f.store.getNode(node.id), f.cleanups), true)
  f.endpoint.close = async ({ sessionId }) => { f.calls.close.push(sessionId); return { closed: true } }
  await stop.run('stop', node, out)
  assert.equal(nodeCleanupPending(f.store.getNode(node.id), f.cleanups), false)
  assert.equal(f.store.getNode(node.id).status, 'finished')
  assert.deepEqual(f.calls.close, ['cleanup-target', 'cleanup-target', 'cleanup-target'])
})

test('a late Stop completion cannot discard a replacement cleanup target', async t => {
  const f = fixture(t)
  retainTreeSessionCleanup(f.store, f.node.id, 'older-cleanup', { cleanups: f.cleanups })
  const oldNode = f.store.getNode(f.node.id)
  let finishClose, closeEntered
  const closing = new Promise(resolve => { closeEntered = resolve })
  f.endpoint.close = () => new Promise(resolve => { finishClose = resolve; closeEntered() })
  const pending = f.function('runPaletteAction').run('stop', oldNode, {})
  // Stop awaits the saved-continuation stop before it calls close, so the
  // replacement must be retained while that close is actually in flight.
  await closing
  retainTreeSessionCleanup(f.store, f.node.id, 'newer-cleanup', { cleanups: f.cleanups })
  finishClose({ closed: true })
  await pending
  assert.equal(f.cleanups.has('older-cleanup'), false)
  assert.equal(nodeCleanupPending(f.store.getNode(f.node.id), f.cleanups), true)
  assert.equal(f.store.getNode(f.node.id).status, 'failed')
})

for (const receipt of [undefined, {}, { closed: true, sessionId: 'wrong-session' }]) {
  test(`Stop preserves cleanup when receipt is ${JSON.stringify(receipt)}`, async t => {
    const f = fixture(t)
    retainTreeSessionCleanup(f.store, f.node.id, 'cleanup-target', { cleanups: f.cleanups })
    const before = f.store.getNode(f.node.id)
    f.endpoint.close = async () => receipt
    await f.function('runPaletteAction').run('stop', before, {})
    assert.deepEqual(f.store.getNode(f.node.id), before)
    assert.equal(f.cleanups.get('cleanup-target'), f.node.id)
    assert.equal(f.scope.RUN_NODE_REMOVAL_CLOSE_RECEIPTS.has('cleanup-target'), false)
  })
}

test('Remove cannot detach retained cleanup or a replacement whose start has not settled', async t => {
  const f = fixture(t)
  retainTreeSessionCleanup(f.store, f.node.id, 'cleanup-target', { cleanups: f.cleanups })
  assert.equal(await f.function('performNodeRemoval').run(f.node), false)
  assert.ok(f.store.getNode(f.node.id))
  assert.equal(f.calls.close.length, 0)
  f.cleanups.clear()
  f.scope.nodeReplacementFlight = { busy: () => true }
  assert.equal(await f.function('performNodeRemoval').run(f.node), false)
  assert.ok(f.store.getNode(f.node.id))
})

function removalFixture(t) {
  const f = fixture(t)
  f.store.attachSession(f.node.id, 'remove-session')
  f.store.setNodeStatus(f.node.id, 'finished')
  f.routes.set('remove-session', f.node.id)
  const effects = { archive: 0, commit: 0, cancel: 0, remove: 0, metrics: 0, outbox: 0, seat: 0 }
  f.scope.transcriptStore = {
    archive: async () => { effects.archive++; return { archiveId: 'archive-proof' } },
    commitArchive: async () => { effects.commit++ },
    cancelArchive: async () => { effects.cancel++ },
    remove: () => { effects.remove++ },
  }
  f.scope.resetSessionMetrics = () => { effects.metrics++ }
  f.scope.outboxClearSession = () => { effects.outbox++; return 0 }
  f.scope.releaseSeatForNode = async () => { effects.seat++; return false }
  f.scope.REMOVE_PANEL = { done: () => 'Removed.', notRemoved: 'Kept.' }
  f.scope.treeChatDrafts = { forget(computerId, nodeId) { assert.equal(computerId, 'cleanup-fixture-computer'); assert.equal(nodeId, f.node.id) } }
  f.scope.treeStoreId = 'cleanup-fixture-computer'
  f.scope.graph = null
  f.scope.currentRailTreeNode = null
  for (const key of ['sessionTurnText', 'sessionActions', 'chatSurfaces', 'turnReplies']) f.scope[key] = new Map()
  for (const value of Object.values(f.scope)) if (value instanceof Map) value.set('sentinel', 'preserve')
  f.scope.sessionUsage.set('remove-session', { inputTokens: 17 })
  f.scope.nodeReplies.set(f.node.id, 'preserve reply')
  return { ...f, effects, remove: () => f.function('performNodeRemoval').run(f.store.getNode(f.node.id)) }
}

for (const failure of ['reject', 'ended', 'unknown', 'negative', 'undefined', 'empty', 'wrong-session', 'missing-bridge']) {
  test(`Remove keeps graph, transcript, caches and retry target when close is ${failure}`, async t => {
    const f = removalFixture(t)
    const before = f.store.getNode(f.node.id)
    f.endpoint.close = async () => {
      if (failure === 'reject') throw new Error('AGENT_SESSION_CLEANUP_FAILED')
      if (failure === 'ended') throw new Error('MC_AGENT_SESSION_ENDED')
      if (failure === 'unknown') throw new Error('MC_AGENT_UNKNOWN_SESSION')
      if (failure === 'negative') return { closed: true, ok: false }
      if (failure === 'empty') return {}
      if (failure === 'wrong-session') return { closed: true, sessionId: 'different' }
    }
    if (failure === 'missing-bridge') f.endpoint.close = undefined
    assert.equal(await f.remove(), false)
    assert.deepEqual(f.store.getNode(f.node.id), before)
    assert.deepEqual(f.effects, { archive: 0, commit: 0, cancel: 0, remove: 0, metrics: 0, outbox: 0, seat: 0 })
    assert.equal(f.cleanups.get('remove-session'), f.node.id)
    assert.deepEqual(f.scope.sessionUsage.get('remove-session'), { inputTokens: 17 })
    assert.equal(f.scope.nodeReplies.get(f.node.id), 'preserve reply')
  })
}

test('Remove proceeds only after positive close and clears normal caches', async t => {
  const f = removalFixture(t)
  assert.equal(await f.remove(), true)
  assert.equal(f.store.getNode(f.node.id), null)
  assert.equal(f.effects.archive, 1)
  assert.equal(f.effects.commit, 1)
  assert.equal(f.effects.metrics, 1)
  assert.equal(f.scope.sessionUsage.has('remove-session'), false)
  assert.equal(f.scope.nodeReplies.has(f.node.id), false)
  assert.equal(f.scope.RUN_NODE_REMOVAL_CLOSE_RECEIPTS.has('remove-session'), false)
  assert.equal(f.routes.has('remove-session'), false)
})

test('archive failure retries with the exact positive close receipt, not an UNKNOWN-session assumption', async t => {
  const f = removalFixture(t)
  const before = f.store.getNode(f.node.id)
  f.scope.transcriptStore.archive = async () => { throw new Error('archive unavailable') }
  assert.equal(await f.remove(), false)
  assert.deepEqual(f.store.getNode(f.node.id), before)
  assert.equal(f.effects.metrics, 0)
  assert.equal(f.calls.close.length, 1)
  f.endpoint.close = async () => { throw new Error('must not close twice') }
  f.scope.transcriptStore.archive = async () => ({ archiveId: 'retry-archive' })
  assert.equal(await f.remove(), true)
  assert.equal(f.effects.commit, 1)
})

for (const phase of ['close', 'archive']) {
  test(`Remove preserves replacement binding after awaited ${phase}`, async t => {
    const f = removalFixture(t)
    const replace = () => {
      f.store.attachSession(f.node.id, 'new-session')
      f.store.setNodeStatus(f.node.id, 'finished')
      f.routes.set('new-session', f.node.id)
    }
    if (phase === 'close') f.endpoint.close = async () => { replace(); return { closed: true } }
    else f.scope.transcriptStore.archive = async () => { f.effects.archive++; replace(); return { archiveId: 'stale' } }
    assert.equal(await f.remove(), false)
    assert.equal(f.store.getNode(f.node.id).sessionId, 'new-session')
    assert.equal(f.effects.commit, 0)
    assert.equal(f.effects.metrics, 0)
    assert.equal(f.effects.cancel, phase === 'archive' ? 1 : 0)
    assert.equal(f.scope.nodeReplies.get(f.node.id), 'preserve reply')
    assert.deepEqual(f.scope.sessionUsage.get('remove-session'), { inputTokens: 17 })
  })
}

test('a positive close receipt cannot be reused for a changed record', async t => {
  const f = removalFixture(t)
  f.scope.transcriptStore.archive = async () => { throw new Error('archive unavailable') }
  assert.equal(await f.remove(), false)
  f.store.setNodeStatus(f.node.id, 'failed', { note: 'Changed since the receipt.' })
  f.endpoint.close = async () => { throw new Error('MC_AGENT_UNKNOWN_SESSION') }
  assert.equal(await f.remove(), false)
  assert.equal(f.scope.RUN_NODE_REMOVAL_CLOSE_RECEIPTS.has('remove-session'), false)
  assert.ok(f.store.getNode(f.node.id))
})

test('failed Remove can retry Stop and then Remove using the actual successful close receipt', async t => {
  const f = removalFixture(t)
  f.endpoint.close = async () => { throw new Error('AGENT_SESSION_CLEANUP_FAILED') }
  assert.equal(await f.remove(), false)
  f.endpoint.close = async () => ({ closed: true, sessionId: 'remove-session' })
  await f.function('runPaletteAction').run('stop', f.store.getNode(f.node.id), {})
  assert.equal(f.cleanups.has('remove-session'), false)
  f.endpoint.close = async () => { throw new Error('MC_AGENT_UNKNOWN_SESSION') }
  assert.equal(await f.remove(), true)
})

test('session metric reset used by replacement/restart clears removal receipts', async t => {
  const f = removalFixture(t)
  f.scope.sessionOpenTurns = new Map()
  f.scope.RUN_NODE_REMOVAL_CLOSE_RECEIPTS.set('remove-session', 'old snapshot')
  f.function('resetSessionMetrics').run('remove-session')
  assert.equal(f.scope.RUN_NODE_REMOVAL_CLOSE_RECEIPTS.has('remove-session'), false)
})

for (const change of ['busy', 'child', 'cleanup']) {
  test(`Remove rechecks ${change} after archive await and cancels only its tentative archive`, async t => {
    const f = removalFixture(t)
    f.scope.transcriptStore.archive = async () => {
      if (change === 'busy') f.store.setNodeStatus(f.node.id, 'running')
      if (change === 'child') assert.equal(f.store.addNode({ role: 'worker', parentId: f.node.id, message: 'New work.' }).ok, true)
      if (change === 'cleanup') f.cleanups.set('remove-session', f.node.id)
      return { archiveId: 'tentative' }
    }
    assert.equal(await f.remove(), false)
    assert.ok(f.store.getNode(f.node.id))
    assert.equal(f.effects.commit, 0)
    assert.equal(f.effects.cancel, 1)
    assert.equal(f.effects.metrics, 0)
    assert.equal(f.scope.RUN_NODE_REMOVAL_CLOSE_RECEIPTS.has('remove-session'), false)
  })
}

test('confirmed Stop settles its partial reply and interrupt intent while preserving another session', async t => {
  const f = fixture(t)
  f.store.attachSession(f.node.id, 'active-stop')
  f.store.setNodeStatus(f.node.id, 'running')
  f.routes.set('active-stop', f.node.id)
  f.scope.sessionTurnText.set('active-stop', 'Words observed before Stop.')
  f.scope.sessionOpenTurns.set('active-stop', 'active-turn')
  f.scope.sessionPendingApprovals.set('active-stop', { approvalId: 'active-approval' })
  await f.scope.turnInterrupts.request('active-stop', 'active-turn', async () => ({ turnId: 'active-turn' }))
  await f.scope.turnInterrupts.request('other-session', 'other-turn', async () => ({ turnId: 'other-turn' }))
  const stop = f.function('runPaletteAction')
  f.endpoint.close = async () => { throw new Error('AGENT_SESSION_CLEANUP_FAILED') }
  await stop.run('stop', f.store.getNode(f.node.id), {})
  assert.equal(f.routes.get('active-stop'), f.node.id)
  assert.equal(f.calls.transcript.length, 0, 'refused Stop must not settle a turn')
  f.endpoint.close = async () => ({ closed: true, sessionId: 'active-stop' })
  await stop.run('stop', f.store.getNode(f.node.id), {})
  assert.equal(f.store.getNode(f.node.id).reply, 'Words observed before Stop.')
  assert.equal(f.calls.transcript.length, 1)
  assert.equal(f.calls.transcript[0].sessionId, 'active-stop')
  assert.equal(f.calls.transcript[0].entry.turnStamp, 'active-turn')
  assert.equal(f.calls.transcript[0].entry.text, 'Words observed before Stop.')
  assert.deepEqual(f.calls.replies, [{ sessionId: 'active-stop', text: 'Words observed before Stop.', turnId: 'active-turn' }])
  assert.deepEqual(f.calls.approval, [{ sessionId: 'active-stop', approvalId: 'active-approval' }])
  assert.equal(f.routes.has('active-stop'), false)
  assert.equal(f.scope.turnInterrupts.consume('active-stop', 'active-turn'), false)
  assert.equal(f.scope.turnInterrupts.consume('other-session', 'other-turn'), true)
})

test('removing a closed node forgets its pending Stop intent before a late acknowledgement', async t => {
  const f = removalFixture(t)
  let acknowledge
  const pending = f.scope.turnInterrupts.request('remove-session', 'removed-turn', () => new Promise(resolve => { acknowledge = resolve }))
  await Promise.resolve()
  await f.scope.turnInterrupts.request('other-session', 'other-turn', async () => ({ turnId: 'other-turn' }))
  assert.equal(await f.remove(), true)
  acknowledge({ sessionId: 'remove-session', turnId: 'removed-turn' })
  await pending
  assert.equal(f.scope.turnInterrupts.consume('remove-session', 'removed-turn'), false)
  assert.equal(f.scope.turnInterrupts.consume('other-session', 'other-turn'), true)
  assert.equal(f.store.getNode(f.node.id), null)
})


test('recovery opens a fallback idle with retained history so the submitted person message is its first turn', async t => {
  const saved = { lines: [{ who: 'you', text: 'Earlier assignment.', at: 1 }, { who: 'agent', text: 'Earlier result.', at: 2 }] }
  const f = fixture(t, { saved })
  Object.assign(f.scope, {
    outboxMoveSession() {}, resumedTranscriptLines: ({ savedLines }) => savedLines,
    persistTranscript() {}, graph: null, deferRailRebuildWhileTyping() {},
  })
  f.endpoint.start = async request => {
    f.calls.start.push(request)
    return { ok: true, sessionId: request.sessionId || 'ready-fallback', threadId: 'fresh-thread' }
  }
  const result = await f.function('resumeNodeSessionUnguarded').run(f.node, { deferSeed: true })
  assert.equal(f.calls.send.length, 0, 'history must not occupy an autonomous provider turn ahead of the submitted message')
  assert.equal(result, 'ready')
  assert.match(f.calls.start[0].historyHandoff, /Earlier assignment/)
  assert.match(f.calls.start[0].historyHandoff, /Earlier result/)
  assert.equal(f.store.getNode(f.node.id).status, 'finished', 'the bound successor must be immediately eligible for the submitted queue')
})


test('production recovery queue, resume handler and host deliver intent first without a history-only provider turn', async t => {
  const saved = { lines: [{ who: 'you', text: 'Saved earlier request.' }, { who: 'agent', text: 'Saved earlier result.' }] }
  const f = fixture(t, { saved }), outbox = realOutbox()
  f.store.attachSession(f.node.id, 'ended-session')
  f.store.setNodeStatus(f.node.id, 'finished')
  const stages = [], stamp = stage => stages.push({ stage, ms: performance.now() })
  const gate = Promise.withResolvers(), opening = Promise.withResolvers(), providerAccepted = Promise.withResolvers()
  const scratch = testScratchRoot('.toolsenabled-startup-join')
  mkdirSync(scratch, { recursive: true })
  const cwd = mkdtempSync(path.join(scratch, 'run-'))
  const enginePath = path.resolve(import.meta.dirname, 'fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
  const engine = createRequire(import.meta.url)(enginePath), sent = []
  let emit
  t.mock.method(engine, 'startCodexSession', async options => {
    emit = options.onEvent; stamp('provider-start')
    return { threadId: 'recovered-thread', close() {}, adapter: {
      transport: { child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) },
      sendTurn(request) {
        stamp('provider-payload'); sent.push(request)
        return Promise.resolve({ turnId: `turn-${sent.length}` })
      }, interrupt() {}, answerApproval() {},
    } }
  })
  const host = createAgentHost({ enginePath, defaultCwd: cwd, profileRoot: path.parse(cwd).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    ownerRequestStoreLoader: () => ({ readAll: () => ({ revision: 91, records: [{ id: 'T767', kind: 'T', scope: 'thread', scopeKey: f.node.id, status: 'in-progress', verbatim: 'Exact current task request.', decisions: [{ reason: 'LATEST_DECISION' }] }] }) }),
  })
  t.after(async () => { await host.closeAll(); console.log('RETAINED_STARTUP_JOIN ' + cwd) })
  const accepted = []
  host.onAcceptedPrompt(value => { stamp('host-accepted'); accepted.push(value); providerAccepted.resolve() })
  host.onEvent(packet => { if (packet.event?.type === 'assistant_text_delta') stamp('host-visible-output') })
  f.endpoint.start = async request => {
    stamp('start-request'); opening.resolve(); await gate.promise
    f.calls.start.push(request)
    return host.startSession({ ...request, sessionId: request.sessionId || 'recovered-session' })
  }
  f.endpoint.send = request => host.sendTurn({ ...request, origin: 'person-queued' })
  Object.assign(f.scope, {
    recoveringNodes: new Set(), outboxMoveSession: outbox.moveSession,
    outboxEnqueue: outbox.enqueue, outboxTakeNext: outbox.takeNext, outboxCancel: outbox.cancel,
    outboxConfirmDelivered: outbox.confirmDelivered, outboxRequeueFront: outbox.requeueFront,
    resumedTranscriptLines: ({ savedLines }) => savedLines, persistTranscript() {}, graph: null,
    deferRailRebuildWhileTyping() {}, broadcastOwnerMessage() {}, turnLogAppend() {},
    nodeSessionEnded: () => false, START_REFUSAL: { sessionGone: 'gone' },
    RECOVERED_SESSION: { reconnecting: 'reconnecting', bare: 'bare', summarised: 'summary' },
    QUEUE_PANEL: { cardQueued: 'queued', sentNext: 'sent', busyAttachment: 'keep image' },
    nodeRequestKeys: () => ({ threadId: f.node.id, treeAnchors: [f.node.id] }),
    nodeTreeIdentity: () => ({ selfName: 'Startup proof', managerName: null }),
  })
  const drain = f.function('drainOutboxMessage').run
  const drains = []
  f.scope.drainOutboxMessage = (...args) => { const pending = drain(...args); drains.push(pending); return pending }
  f.scope.resumeNodeSessionUnguarded = f.function('resumeNodeSessionUnguarded').run
  f.scope.resumeNodeSession = f.function('resumeNodeSession').run
  const recover = f.function('recoverDeadSessionSend').run
  const failures = [], admissions = []
  const send = text => recover(f.store.getNode(f.node.id), text, {
    reply() {}, note() {}, accepted: () => admissions.push(text), fail: sentence => failures.push(sentence),
  })
  stamp('recovery-admission')
  const first = send('EXACT_FIRST_INTENT T767')
  await opening.promise
  await send('SECOND_INTENT')
  assert.deepEqual(Array.from(outbox.list('ended-session'), row => row.text), ['EXACT_FIRST_INTENT T767', 'SECOND_INTENT'])
  assert.equal(sent.length, 0)
  gate.resolve(); await first
  await providerAccepted.promise; await Promise.all(drains)
  assert.deepEqual(failures, [])
  assert.equal(sent.length, 1)
  assert.ok(sent[0].text.startsWith('EXACT_FIRST_INTENT T767\n\n'))
  assert.match(sent[0].text, /Exact current task request/); assert.match(sent[0].text, /LATEST_DECISION/)
  assert.match(sent[0].text, /Saved earlier request/); assert.match(sent[0].text, /Saved earlier result/)
  assert.equal(accepted[0].text, 'EXACT_FIRST_INTENT T767')
  const recoveredSessionId = f.store.getNode(f.node.id).sessionId
  assert.deepEqual(Array.from(outbox.list(recoveredSessionId), row => row.text), ['SECOND_INTENT'])
  emit({ type: 'assistant_text_delta', turnId: 'turn-1', text: 'FIRST_ACTUAL_OUTPUT' })
  emit({ type: 'turn_completed', turnId: 'turn-1', status: 'completed' })
  f.store.setNodeStatus(f.node.id, 'finished')
  await drain(recoveredSessionId, f.node.id, outbox.takeNext(recoveredSessionId))
  assert.equal(sent.length, 2)
  assert.ok(sent[1].text.startsWith('SECOND_INTENT'))
  assert.doesNotMatch(sent[1].text, /EXACT_FIRST_INTENT|Saved earlier/)
  assert.deepEqual(Array.from(outbox.list(recoveredSessionId)), [])
  assert.deepEqual(admissions.sort(), ['EXACT_FIRST_INTENT T767', 'SECOND_INTENT'])
  const order = stages.map(row => row.stage)
  assert.ok(order.indexOf('provider-payload') < order.indexOf('host-accepted'))
  assert.ok(order.indexOf('host-accepted') < order.indexOf('host-visible-output'))
  console.log('CONTROLLED_STARTUP_STAGES ' + JSON.stringify(stages.map(row => ({ stage: row.stage, elapsedMs: row.ms - stages[0].ms }))))
})


async function hostedContinuation(t, { unknownImages = false } = {}) {
  const f = fixture(t, { saved: { lines: [
    { who: 'you', text: 'GENUINE_EARLIER_PERSON' }, { who: 'agent', text: 'GENUINE_EARLIER_RESULT' },
  ] } })
  f.store.attachSession(f.node.id, 'ended-source'); f.store.setNodeStatus(f.node.id, 'finished')
  const root = testScratchRoot('.toolsenabled-continuation-joins')
  mkdirSync(root, { recursive: true }); const cwd = mkdtempSync(path.join(root, 'run-'))
  const require = createRequire(import.meta.url)
  const enginePath = path.resolve(import.meta.dirname, 'fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
  const sent = [], rows = [], captured = [], unsubs = [], listeners = new Set()
  let emit
  t.mock.method(require(enginePath), 'startCodexSession', async options => {
    emit = options.onEvent
    return { threadId: 'successor-thread', close() {}, adapter: {
      transport: { child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) },
      sendTurn: async request => {
        sent.push(request)
        if (unknownImages && request.images?.length) throw Object.assign(new Error('Unknown provider delivery'), { code: 'PROVIDER_CONNECTION_LOST' })
        return { turnId: `joined-${sent.length}` }
      },
      interrupt() {}, answerApproval() {},
    } }
  })
  const host = createAgentHost({ enginePath, defaultCwd: cwd, profileRoot: path.parse(cwd).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    ownerRequestStoreLoader: () => ({ readAll: () => ({ revision: 12, records: [
      { id: 'T767', kind: 'T', scope: 'thread', scopeKey: f.node.id, status: 'in-progress', verbatim: 'CURRENT_STARTUP_TASK' },
    ] }) }),
  })
  const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
  const capture = createNodeTranscriptCapture({ store: { append: async ({ entries }) => {
    for (const entry of entries) { const at = rows.findIndex(row => row.id === entry.id); if (at < 0) rows.push(entry); else rows[at] = entry }
    return { ok: true }
  } } })
  host.onAcceptedPrompt(value => captured.push(capture.recordAcceptedTranscriptSend(value)))
  const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')
  const owner = {}, agentSessions = new Map(), principal = { kind: 'window', owner, mayWrite: true, label: 'fixture' }
  const mainSource = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const parserSource = ['agentIpcError', 'agentPayload', 'boundedAgentString', 'parseAgentSend'].map(name => declaredFunctionSource(mainSource, name)).join('\n')
  const parseAgentSend = new Function('MAX_SESSION_ID_LENGTH', 'MAX_TURN_TEXT_LENGTH', parserSource + '; return parseAgentSend')(128, 200000)
  const dependencies = Object.fromEntries(Object.entries(REQUIRED_DEPS).map(([key, type]) => [key,
    type === 'function' ? () => null : type === 'number' ? 128 : type === 'string' ? cwd : {}]))
  Object.assign(dependencies, { agentSessions, currentAgentHost: () => host, parseAgentSend,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    agentIpcError: (code, text) => { throw Object.assign(new Error(text), { code }) }, rendererSafeAgentError: error => error,
    recordAcceptedTranscriptSend: value => capture.recordAcceptedTranscriptSend(value), AGENT_EFFORT_VALUES: [],
  })
  const surface = createAgentCommandSurface(dependencies)
  f.endpoint.start = async request => {
    f.calls.start.push(request)
    const result = await host.startSession({ ...request, sessionId: request.sessionId || 'successor' })
    agentSessions.set(result.sessionId, { owner, ownerKind: 'window', state: 'ready', attachments: new Set() })
    capture.bind({ sessionId: result.sessionId, computerId: 'proof', nodeId: f.node.id })
    return result
  }
  f.endpoint.send = request => surface.run('agent:send', request, principal)
  f.endpoint.sendAutomatic = request => surface.run('agent:send-automatic', request, principal)
  Object.assign(f.scope, {
    outboxMoveSession() {}, resumedTranscriptLines: ({ savedLines }) => savedLines,
    persistTranscript() {}, graph: null, deferRailRebuildWhileTyping() {},
    nodeRequestKeys: () => ({ threadId: f.node.id, treeAnchors: [f.node.id] }),
    nodeTreeIdentity: () => ({ selfName: 'Continuation proof', managerName: null }),
    nodeSessionEnded: node => node.sessionId === 'ended-source',
    registerNodeStatusListener: (_node, listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    pendingModelChoice: () => false, pendingModelDrainHolds: new Set(),
    createImageConversation, imageConversations: new Map(), submittedImageRecoveries: new Map(),
  })
  f.scope.resumeNodeSessionUnguarded = f.function('resumeNodeSessionUnguarded').run
  f.scope.resumeNodeSession = f.function('resumeNodeSession').run
  f.scope.imageConversationFor = f.function('imageConversationFor').run
  f.scope.continueSubmittedImages = f.function('continueSubmittedImages').run
  const sendImageIntent = f.function('sendImageIntent').run
  t.after(async () => {
    for (const entry of f.scope.imageConversations.values()) entry.dispose()
    for (const recovery of f.scope.submittedImageRecoveries.values()) { recovery.unsubscribe?.(); recovery.deliveryUnsubscribe?.() }
    await Promise.all(captured); await capture.shutdown(); await host.closeAll()
    console.log('RETAINED_CONTINUATION_JOIN ' + cwd)
  })
  return { ...f, host, sent, rows, captured, sendImageIntent,
    resume: options => f.scope.resumeNodeSession(f.store.getNode(f.node.id), { deliverQueued: false, ...options }),
    complete: () => emit({ type: 'turn_completed', turnId: `joined-${sent.length}`, status: 'completed' }),
  }
}

test('manual Resume preserves generated history provenance through host capture and later seed', async t => {
  const f = await hostedContinuation(t)
  assert.ok(await f.resume())
  await Promise.all(f.captured)
  assert.equal(f.sent.length, 1, 'manual Resume must still start its continuation')
  assert.match(f.sent[0].text, /GENUINE_EARLIER_PERSON/)
  const productHistory = f.rows.find(row => row.promptKind === 'history')
  assert.ok(productHistory, 'generated history must be a labeled product addition, not person speech')
  assert.equal(productHistory.promptSource, 'toolsenabled')
  assert.match(productHistory.text, /GENUINE_EARLIER_RESULT/)
  assert.ok(f.rows.some(row => row.who === 'action' && row.origin === 'automatic'))
  assert.ok(f.rows.some(row => row.promptKind === 'tasks' && row.text.includes('CURRENT_STARTUP_TASK')))
  const next = transcriptSeedText([...f.rows, { who: 'you', text: 'NEW_ACTUAL_PERSON' }])
  assert.match(next, /The person said: NEW_ACTUAL_PERSON/)
  assert.doesNotMatch(next, /The person said: You are taking over|GENUINE_EARLIER_PERSON|The person said: Continue unfinished/)
})


for (const mode of ['text-and-images', 'image-only', 'unknown']) test(`durable image intent is the first fallback provider turn: ${mode}`, async t => {
  const f = await hostedContinuation(t, { unknownImages: mode === 'unknown' })
  const ownerContext = { version: 1, ownerId: 'fixture-owner', currentEpoch: crypto.randomUUID(), kind: 'local' }
  const images = [{ path: 'ordered-first.png' }, { path: 'ordered-second.png' }]
  const text = mode === 'image-only' ? '' : '  EXACT_IMAGE_INTENT T767\n  '
  const receipt = { version: 1, id: crypto.randomUUID(), slot: 0, manifestHash: 'a'.repeat(64), imageCount: images.length }
  const envelopeId = crypto.randomUUID(), operations = [], states = []
  let snapshot = { version: 1, generation: null, entries: [], destinationSessionId: null, automaticSend: false }
  f.endpoint.ownerContext = async () => ownerContext
  f.endpoint.onOwnerContextChanged = () => () => {}
  // Native persistence/issued paths are the supplied boundary. Admission,
  // owner binding, transfer, drain, resume and provider dispatch are real modules.
  f.endpoint.imageQueue = async request => {
    operations.push(request)
    const answer = result => ({ ok: true, operation: request.operation, operationId: request.operationId || null, result })
    if (request.operation === 'binding') return answer({ sessionId: request.sessionId, conversationId: 'kept-conversation', ownerContext })
    if (request.operation === 'read') return answer(structuredClone(snapshot))
    if (request.operation === 'retain') { assert.deepEqual(request.images, images); return answer({ ...receipt, state: 'retained' }) }
    if (request.operation === 'admit') {
      assert.equal(request.expectedGeneration, snapshot.generation)
      snapshot = { ...snapshot, generation: crypto.randomUUID(), entries: [{ envelopeId, text: request.text,
        imageReceipts: request.imageReceipts, selection: { model: null, effort: null, ...request.selection }, state: 'not-sent' }] }
      return answer(structuredClone(snapshot))
    }
    if (request.operation === 'transfer') {
      assert.equal(request.expectedGeneration, snapshot.generation)
      assert.equal(request.expectedDestinationSessionId, snapshot.destinationSessionId)
      snapshot = { ...snapshot, generation: crypto.randomUUID(), destinationSessionId: request.destinationSessionId }
      return answer(structuredClone(snapshot))
    }
    if (request.operation === 'dispatch') {
      const row = snapshot.entries[0]
      assert.equal(request.sessionId, f.store.getNode(f.node.id).sessionId)
      assert.equal(request.expectedGeneration, snapshot.generation)
      assert.equal(row.text, text); assert.deepEqual(row.imageReceipts, [receipt])
      const delivered = await f.host.sendTurnTracked({ sessionId: request.sessionId, text: row.text, images, origin: 'person' })
      const disposition = delivered.deliveryDisposition
      snapshot = { ...snapshot, generation: crypto.randomUUID(), entries: [{ ...row, state: disposition }] }
      return { ...answer(structuredClone(snapshot)), conversationId: request.conversationId, sessionId: request.sessionId,
        envelopeId, ownerContext, deliveryDisposition: disposition, attemptId: crypto.randomUUID(), reconcile: disposition === 'unknown' }
    }
    assert.fail('Unexpected queue operation: ' + request.operation)
  }
  const result = await f.sendImageIntent(f.node.id, { operationId: crypto.randomUUID(), text, images }, state => states.push(state))
  assert.equal(result.ok, true, JSON.stringify({ result, operations }))
  assert.equal(f.sent.length, 1)
  assert.equal(operations.filter(row => row.operation === 'dispatch').length, 1, 'admitted intent must not wait behind a history-only turn')
  assert.deepEqual(f.sent[0].images, images)
  assert.ok(f.sent[0].text.startsWith(text + '\n\n'))
  assert.match(f.sent[0].text, /CURRENT_STARTUP_TASK/)
  assert.match(f.sent[0].text, /GENUINE_EARLIER_PERSON/)
  assert.equal(snapshot.entries[0].state, mode === 'unknown' ? 'unknown' : 'accepted')
  if (mode !== 'unknown') f.complete()
  f.store.setNodeStatus(f.node.id, 'finished')
  await f.scope.imageConversationFor(f.node.id).signalReady()
  await f.scope.continueSubmittedImages(f.node.id)
  assert.equal(f.sent.length, 1, 'accepted and unknown envelopes cannot replay')
  assert.equal(operations.filter(row => row.operation === 'admit').length, 1)
})


for (const mode of ['missing', 'not-sent', 'unknown', 'thrown', 'malformed-accepted']) {
  test('manual automatic continuation preserves custody without person fallback: ' + mode, async t => {
    const f = fixture(t)
    let automaticCalls = 0
    f.endpoint.start = async request => { f.calls.start.push(request); return { ok: true, sessionId: 'held-session' } }
    if (mode === 'missing') delete f.endpoint.sendAutomatic
    else f.endpoint.sendAutomatic = async () => {
      automaticCalls++
      if (mode === 'thrown') throw Error('transport reply lost')
      if (mode === 'malformed-accepted') return { ok: true, deliveryDisposition: 'accepted', result: null }
      return { ok: false, deliveryDisposition: mode, code: 'CONTINUATION_UNCONFIRMED' }
    }
    const outcome = await startAgentForNode({ text: 'Continue current work.', historyHandoff: 'Generated history.', automatic: true, surface: 'tree' })
    assert.equal(outcome.ok, false)
    assert.equal(f.calls.send.length, 0, 'an automatic continuation cannot fall back to a person send')
    assert.equal(f.calls.close.length, 0, 'unconfirmed delivery cannot discard the retained session')
    assert.equal(automaticCalls, mode === 'missing' ? 0 : 1)
    assert.equal(f.calls.start.length, mode === 'missing' ? 0 : 1)
    if (mode !== 'missing') {
      assert.equal(outcome.sessionId, 'held-session')
      assert.equal(outcome.deliveryDisposition, mode === 'not-sent' ? 'not-sent' : mode === 'malformed-accepted' ? 'accepted' : 'unknown')
      assert.equal(f.calls.start[0].historyHandoff, 'Generated history.')
    }
  })
}
