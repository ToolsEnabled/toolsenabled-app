import { computersViewAuthorityBindings } from './lib/computers-view-authority-bindings.mjs'
import { webcrypto } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createFleetTreeStore, FLEET_TREE_LIMITS } from '../../src/fleet-trees.js'
import { createTranscriptStore } from '../../src/session-transcript-store.js'
import { createTreeLaunchQueue, isResourceHold } from '../../src/tree-launch-queue.js'
import { createSingleFlight } from '../../src/single-flight.js'
import { executeCreateAndStartNode } from '../../src/create-and-start-node.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const require = createRequire(import.meta.url)
const { createTreeNodeCommandBroker, DEFAULT_TIMEOUT_MS } = require('../../shell/tree-node-command-broker.cjs')

const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const shellSource = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const resourceBridgeStart = shellSource.indexOf("ipcMain.handle('mc-resources:status',")
const resourceBridgeEnd = shellSource.indexOf("ipcMain.handle('mc-resources:configure',", resourceBridgeStart)
assert.ok(resourceBridgeStart >= 0 && resourceBridgeEnd > resourceBridgeStart)
const resourceBridgeSource = shellSource.slice(resourceBridgeStart, resourceBridgeEnd)
const functions = ['recoveryCoordinator', 'retainStartingTreeStore', 'openTreeStore', 'startDraftNodeUnguarded', 'transcriptAppend', 'persistTranscript']
  .map(name => declaredFunctionSource(source, name)).join('\n')
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  const cells = new Map()
  const storage = {
    read: key => cells.has(key) ? JSON.parse(cells.get(key)) : null,
    write: (key, value) => { cells.set(key, JSON.stringify(value)); return true },
  }
  const starts = []
  const pendingStores = new Map()
  const pendingNodes = new Set()
  const liveSessions = new Map()
  let id = 0
  const makeStore = () => createFleetTreeStore({ computerId: 'computer-a', storage,
    makeId: kind => `${kind}-${++id}` })
  const original = makeStore()
  const first = original.addNode({ role: 'worker', tier: 'luna', message: 'Preserve this exact brief.' }).node
  const makeTranscripts = () => createTranscriptStore({ computerId: 'computer-a', storage })

  function view(store = null) {
    const ui = []
    const transcripts = makeTranscripts()
    let transcriptSaves = 0
    let context
    const paint = (...args) => {
      assert.equal(context.destroyed, false, 'a completed start must not paint the destroyed view')
      ui.push(args)
    }
    context = vm.createContext({
      crypto: webcrypto,
      accountRecoveryCoordinator: null,
      treeStore: store, treeStoreId: store ? 'computer-a' : null, treeStoreProblem: '', destroyed: false,
      // The real local view initializes these before opening its saved tree.
      ...computersViewAuthorityBindings(),
      transcriptStore: { ...transcripts, save: (...args) => { transcriptSaves += 1; return transcripts.save(...args) } },
      sessionTranscripts: new Map(), standaloneSettledTurns: new Map(), TRANSCRIPT_MAX_ENTRIES: 60, LAUNCH_TIERS: [{ id: 'luna', provider: 'codex' }],
      RUN_STARTING_TREE_STORES: pendingStores, RUN_STARTING_NODE_IDS: pendingNodes,
      RUN_TREE_RUNTIME_STORES: new Map(), startingNodeIds: pendingNodes,
      /* openTreeStore reads the run's session evidence through this seam, which
           withholds the map until a saved-session sweep has asked the host (T407
           review). Supplied settled here: this fixture's sessions ARE this run's. */
      seatSessionEvidence: () => liveSessions,
      sessionNodeIds: liveSessions, sessionEfforts: new Map(), sessionThreadIds: new Map(), sessionAccountNames: new Map(),
      nodeReplies: new Map(), composePanel: null, window: {}, mockSource: () => false,
      isWriteEnabled: () => true, START_CONTROL_FLAG: 'start',
      draftStartEffort: () => 'medium', tierEffortOf: () => 'medium', identityRoleForTreeNode: value => value,
      ensureSeatForNode: async () => ({ ok: true }), roleBindingForStart: () => ({ ok: true, binding: { agentId: 'seat' } }),
      currentDataSource: () => 'local', treeNodeName: node => node.id, roleDisplayFor: value => value,
      startingLine: () => 'Starting', runningLine: () => 'Running', statusNote: value => value || '',
      startProfileId: value => value, briefContextFor: () => ({}), composeNodeBrief: ({ message }) => message,
      nodeManagerContext: () => 'Tree address', readEngineCatalog: () => {},
      rememberBoundSessionProfile: () => {},
      nodeRequestKeys: () => null, nodeTreeIdentity: () => null,
      startAgentForNode: options => { const pending = deferred(); starts.push({ options, pending }); return pending.promise },
      setOrgStatus: paint, refreshTree: paint, rebindRailToSession: paint, closeComposePanel: paint,
      setTimeout: () => 1, clearTimeout: () => {}, startStallMs: () => 10000,
      isResourceHold, ENDED_SESSION: { note: 'The session ended.' },
      retireTreeSessionRuntime: sessionId => liveSessions.delete(sessionId),
      START_REFUSAL: { assistantProgramNote: 'Install the assistant.' }, TREE_RUNTIME_NOT_SAVED_TEXT: 'Not saved.',
      safeTreeStorage: () => storage, createFleetTreeStore: makeStore, createTreeRuntimeView: value => value,
      releaseTreeStore: () => { context.treeStore = null; context.treeStoreId = null },
      orgReady: () => false, reportTreePersistence: () => {}, markTreeStoreLive: () => () => {},
      createTranscriptStore: makeTranscripts, createChatDiffHistoryStore: () => { throw new Error('not needed') },
      refreshTreeNames: () => {}, /* T138 naming watch: stood in like syncTreeBranchAddresses beside it; naming is not this file's subject. */ syncRenamedCircles: () => {}, drivenComputerCopy: value => value,
    })
    vm.runInContext(functions, context)
    return { context, ui,
      leave: () => { context.destroyed = true; context.treeStore = null; context.treeStoreId = null; context.transcriptStore = null },
      open: () => context.openTreeStore('computer-a'),
      start: node => context.startDraftNodeUnguarded(node),
      transcriptSaves: () => transcriptSaves,
    }
  }
  return { original, first, view, starts, pendingStores, pendingNodes, liveSessions, makeStore, makeTranscripts }
}

// Exercise the real IPC handler's scoped/unscoped response shape. Measurements
// and authority are fictional; no native session or resource probe is opened.
function resourceBridge(view, admission = { ok: true }) {
  let handler
  const requests = [], inspections = []
  vm.runInNewContext(resourceBridgeSource, {
    ipcMain: { handle(name, callback) { assert.equal(name, 'mc-resources:status'); handler = callback } },
    assertTrustedAgentSender() {},
    requireAgentResourceHost: () => ({
      status: () => ({ ok: true, admission: { codex: { ok: true } } }),
      inspect(request) { inspections.push(request); return admission },
    }),
    agentOrgRecord: { resolveRoleBinding: () => ({ ok: true, authority: { agentId: 'seat' } }) },
  })
  view.context.window.mcResources = { status: async request => { requests.push(request); return handler({}, request) } }
  view.context.TREE_DEFAULT_STARTABLE_TIERS = ['luna']
  return { requests, inspections }
}

// Join the actual renderer drain and resource queue, while retaining only a
// fictional deferred native boundary. No real clock delay or provider runs.
function queuedCommandFixture(t, { pressure = true, brokerCommand = true } = {}) {
  const f = fixture(), v = f.view(f.original)
  assert.equal(f.original.attachSession(f.first.id, 'parent-session').ok, true)
  assert.equal(f.original.setNodeStatus(f.first.id, 'running').ok, true)
  f.liveSessions.set('parent-session', f.first.id)
  const admission = pressure ? { ok: false, code: 'AGENT_RESOURCE_PRESSURE', reason: 'Fictional CPU pressure.', retryAfterMs: 1000 } : { ok: true }
  resourceBridge(v, admission)
  let clock = 1_000_000, nextTimer = 0, receive, operation, broker
  const timers = new Map(), deadlines = new Map(), publications = [], completions = []
  const flush = async () => { for (let n = 0; n < 8; n++) await tick() }
  Object.assign(v.context, {
    Date: class extends Date { static now() { return clock } },
    nodeLaunchQueues: new Map(), startDraftFlight: createSingleFlight(),
    refreshLaunchStatus() {}, refreshTreeStartControls() {},
    createTreeLaunchQueue: options => createTreeLaunchQueue({ ...options, now: () => clock,
      schedule(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
      unschedule(id) { timers.delete(id) },
    }),
  })
  vm.runInContext(['startDraftNodeQueued', 'startDraftNode'].map(name => declaredFunctionSource(source, name)).join('\n'), v.context)
  const request = { protocol: 'toolsenabled.tree-node-command', schemaVersion: 1,
    requestId: 'tnc-11111111-1111-4111-8111-111111111111', action: 'create-and-start-node',
    computerId: 'computer-a', treeId: null, nodeId: null, expectedSessionId: null,
    parentSessionId: 'parent-session', role: 'worker', tier: 'luna', brief: 'Keep this child and this exact brief.',
    createdAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 330_000).toISOString(), containsSecretMaterial: false }
  const mainSource = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
  const drainSource = readFileSync(new URL('./tree-node-command-drain.test.mjs', import.meta.url), 'utf8')
  const setup = { assert, FLEET_TREE_LIMITS, mainSource, Date, setTimeout, clearTimeout,
    QUEUE_START: 'const pendingTreeNodeCommands = new Map()', QUEUE_END: '\nconst RING = [' }
  vm.runInNewContext(declaredFunctionSource(drainSource, 'loadQueue'), setup)
  setup.loadQueue({ route: { name: 'computers', comp: 'computer-a' }, now: () => clock,
    view: { runTreeNodeCommand(command) {
      operation = executeCreateAndStartNode({ command, treeStore: f.original,
        sessionNodeIds: f.liveSessions, sessionThreadIds: v.context.sessionThreadIds,
        roleRecordFor: role => ({ id: role }), launchTiers: [{ id: 'luna' }],
        startDraftNode: (node, options) => v.context.startDraftNode(node, options) })
      return operation
    } },
    mcTreeCommand: { onRequest(fn) { receive = fn }, async complete(result) {
      const receipt = await broker.complete(result); completions.push({ result, receipt }); return receipt
    } },
  })
  broker = createTreeNodeCommandBroker({ now: () => clock,
    loadAndClaim: () => ({ request }),
    publishResult: async (_envelope, result) => { publications.push(result); return { ok: true } },
    sendToRenderer(command) { receive(command) },
    setTimer(callback, delay) { const id = ++nextTimer; deadlines.set(id, { callback, delay }); return id },
    clearTimer(id) { deadlines.delete(id) }, wait: async () => {},
  })
  t.after(() => { broker.dispose(); for (const { queue } of v.context.nodeLaunchQueues.values()) queue.cancel(); timers.clear(); deadlines.clear() })
  async function wake() {
    const [id, timer] = timers.entries().next().value || []
    assert.ok(timer, 'the real queue owns a wake')
    timers.delete(id); clock += timer.delay; timer.callback(); await flush()
  }
  async function begin() {
    if (brokerCommand) { broker.setRendererReady(true); broker.queueRequest(request.requestId); await flush() }
    else {
      const node = f.original.addNode({ parentId: f.first.id, role: 'worker', tier: 'luna', message: request.brief }).node
      operation = v.context.startDraftNode(node)
    }
    await wake()
  }
  async function expire() {
    if (brokerCommand) {
      const [id, deadline] = deadlines.entries().next().value
      assert.equal(deadline.delay, DEFAULT_TIMEOUT_MS)
      assert.equal(DEFAULT_TIMEOUT_MS, 300_000)
      deadlines.delete(id); clock += deadline.delay; deadline.callback(); await flush()
      assert.equal(publications[0].code, 'MC_TREE_COMMAND_COMPLETION_TIMEOUT')
    } else clock += DEFAULT_TIMEOUT_MS
  }
  async function finishDispatched() {
    for (const call of f.starts) {
      call.options.onSessionOpen({ sessionId: 'fictional-child-session', threadId: 'fictional-child-thread', account: 'fictional' })
      call.pending.resolve({ ok: true, sessionId: 'fictional-child-session', threadId: 'fictional-child-thread' })
    }
    const result = await operation; await flush(); return result
  }
  return { f, v, publications, completions, begin, expire, wake, finishDispatched,
    cool() { for (const key of Object.keys(admission)) delete admission[key]; admission.ok = true } }
}

test('an expired broker resource wait keeps its draft and cannot dispatch when the computer cools', async t => {
  const q = queuedCommandFixture(t)
  await q.begin()
  assert.equal(q.f.starts.length, 0)
  await q.expire()
  q.cool(); await q.wake()
  await q.finishDispatched() // Also settles an unexpected pre-fix dispatch before asserting.
  assert.equal(q.f.starts.length, 0, 'broker timeout must prevent a later native attempt')
  const child = q.f.makeStore().snapshot().nodes.find(node => node.parentId === q.f.first.id)
  assert.equal(child.status, 'draft')
  assert.equal(child.sessionId, null)
  assert.equal(child.message, 'Keep this child and this exact brief.')
  assert.equal(q.v.context.nodeLaunchQueues.size, 0)
})

test('an owner-click start keeps ordinary resource queuing without a broker deadline', async t => {
  const q = queuedCommandFixture(t, { brokerCommand: false })
  await q.begin(); await q.expire()
  assert.equal(q.f.starts.length, 0)
  q.cool(); await q.wake()
  const result = await q.finishDispatched()
  assert.equal(q.f.starts.length, 1)
  assert.equal(result.ok, true)
  assert.equal(q.v.context.nodeLaunchQueues.size, 0)
})

test('a native attempt dispatched before broker expiry still attaches its eventual receipt once', async t => {
  const q = queuedCommandFixture(t, { pressure: false })
  await q.begin()
  assert.equal(q.f.starts.length, 1)
  await q.expire()
  const result = await q.finishDispatched()
  assert.equal(result.ok, true)
  assert.equal(q.f.starts.length, 1)
  assert.equal(q.f.makeStore().getNode(result.nodeId).sessionId, 'fictional-child-session')
  assert.equal(q.publications.length, 1, 'an uncertain timeout is not replaced with a false not-started claim')
  assert.equal(q.completions[0].receipt.code, 'MC_TREE_COMMAND_NO_ACTIVE_REQUEST')
})

test('a queued draft with an unknown saved model is refused instead of waiting indefinitely for resources', async () => {
  const f = fixture()
  const node = f.original.addNode({ role: 'worker', tier: 'retired-model', message: 'Keep the saved model and brief.' }).node
  const v = f.view(f.original)
  const resources = resourceBridge(v)
  let queue
  queue = createTreeLaunchQueue({ nodes: [node], concurrency: 1,
    schedule: callback => setImmediate(callback), unschedule: clearImmediate,
    start: pending => v.start(pending),
    // Bound the known pre-fix endless wait so its failure remains an assertion.
    onChange: state => { if (state.waiting && !state.cancelled) queue.cancel() },
  })
  const report = await queue.done
  assert.equal(report.cancelled, false, 'an invalid model must settle without cancelling a resource wait')
  assert.equal(report.refused, 1)
  assert.equal(report.results[0].code, 'AGENT_TIER_UNKNOWN')
  assert.equal(report.results[0].notStarted, true)
  assert.notEqual(report.results[0].retryable, true)
  assert.equal(resources.requests.length, 0, 'a missing provider must not request the unscoped status map')
  assert.equal(f.starts.length, 0)
  const saved = f.makeStore().getNode(node.id)
  assert.equal(saved.status, 'draft')
  assert.equal(saved.sessionId, null)
  assert.equal(saved.tier, node.tier)
  assert.equal(saved.message, node.message)
})

test('a known model under resource pressure still returns the real retryable hold', async () => {
  const f = fixture(), v = f.view(f.original)
  const resources = resourceBridge(v, { ok: false, code: 'AGENT_RESOURCE_PRESSURE', reason: 'Waiting for CPU.', retryAfterMs: 1000 })
  const result = await v.start(f.first)
  assert.equal(result.code, 'AGENT_RESOURCE_PRESSURE')
  assert.equal(result.retryable, true)
  assert.equal(result.retryAfterMs, 1000)
  assert.equal(resources.inspections[0].provider, 'codex')
  assert.equal(f.starts.length, 0)
  assert.equal(f.makeStore().getNode(f.first.id).status, 'draft')
})

test('an unset model retains the existing default provider admission and saved choice', async () => {
  const f = fixture(), v = f.view(f.original)
  const node = f.original.addNode({ role: 'worker', tier: '', message: 'Use the existing default.' }).node
  const resources = resourceBridge(v)
  const pending = v.start(node)
  await tick()
  assert.equal(resources.inspections[0].provider, 'codex')
  assert.equal(f.starts.length, 1)
  assert.equal(f.starts[0].options.tier, '')
  f.starts[0].pending.resolve({ ok: false, sentence: 'Fictional start stopped.' })
  await pending
  assert.equal(f.makeStore().getNode(node.id).tier, '')
})

for (const phase of ['seat', 'resource']) {
  test(`draft start rechecks consent after ${phase} await without changing the saved draft`, async () => {
    const f = fixture()
    const v = f.view(f.original)
    const gate = deferred()
    let allowed = true
    v.context.isWriteEnabled = () => allowed
    v.context.startControlOffReason = () => 'Starting agents is switched off.'
    if (phase === 'seat') v.context.ensureSeatForNode = async () => { await gate.promise; return { ok: true } }
    else v.context.window.mcResources = { status: async () => { await gate.promise; return { admission: { ok: true } } } }
    const pending = v.start(f.first)
    await tick()
    allowed = false
    gate.resolve()
    await tick()
    // Finish any unexpected old-runtime dispatch so a regression produces a
    // failed assertion instead of leaving an unresolved fixture promise.
    for (const started of f.starts) started.pending.resolve({ ok: false, sentence: 'Unexpected start.' })
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.code, 'MC_TREE_COMMAND_START_DISABLED')
    assert.equal(f.starts.length, 0)
    const saved = f.makeStore().getNode(f.first.id)
    assert.equal(saved.status, 'draft')
    assert.equal(saved.sessionId, null)
    assert.equal(saved.message, f.first.message)
    assert.equal(f.pendingStores.size, 0)
    assert.equal(f.pendingNodes.size, 0)
  })
}

test('a resource refusal after navigation returns the saved node to a retryable draft', async () => {
  const f = fixture()
  const oldView = f.view(f.original)
  const result = oldView.start(f.first)
  await tick()
  assert.equal(f.original.getNode(f.first.id).status, 'starting')
  oldView.leave()
  f.starts[0].pending.resolve({ ok: false, code: 'AGENT_RESOURCE_PRESSURE', sentence: 'This computer is under heavy load.' })
  const outcome = await result
  assert.equal(outcome.retryable, true)
  const saved = f.makeStore().getNode(f.first.id)
  assert.equal(saved.status, 'draft')
  assert.equal(saved.sessionId, null)
  assert.equal(saved.message, f.first.message)
  assert.equal(saved.statusNote, 'This computer is under heavy load.')
  assert.equal(f.starts.length, 1, 'recording a refusal must never retry it')
  assert.equal(f.pendingStores.size, 0)
  assert.equal(f.pendingNodes.size, 0)
})

test('a reopened view shares a still-pending store and sees its actual late failure', async () => {
  const f = fixture()
  const oldView = f.view(f.original)
  const result = oldView.start(f.first)
  await tick()
  oldView.leave()
  const reopened = f.view()
  const store = reopened.open()
  assert.equal(store, f.original, 'the pending handoff must retain its exact mutation target')
  assert.equal(store.getNode(f.first.id).status, 'starting', 'a real pending handoff must remain pending')
  assert.equal(f.pendingNodes.has(f.first.id), true)
  let changes = 0
  store.subscribe(() => { changes += 1 })
  f.starts[0].pending.resolve({ ok: false, code: 'ASSISTANT_NOT_INSTALLED', sentence: 'The assistant is not installed.' })
  await result
  assert.equal(store.getNode(f.first.id).status, 'failed')
  assert.equal(store.getNode(f.first.id).statusNote, 'The assistant is not installed.')
  assert.ok(changes > 0, 'the reopened view must be notified by the store it subscribed to')
  assert.equal(f.pendingStores.size, 0)
})

test('a failure carrying a real session keeps that session after navigation', async () => {
  const f = fixture()
  const oldView = f.view(f.original)
  const result = oldView.start(f.first)
  await tick()
  oldView.leave()
  f.starts[0].pending.resolve({ ok: false, code: 'SEND_REFUSED', sessionId: 'real-session', sentence: 'The first message was refused.' })
  await result
  const saved = f.original.getNode(f.first.id)
  assert.equal(saved.sessionId, 'real-session')
  assert.equal(saved.status, 'failed')
  assert.equal(f.starts.length, 1)
})

test('a session proved ended after navigation retains its run identity and end note', async () => {
  const f = fixture()
  const oldView = f.view(f.original)
  const result = oldView.start(f.first)
  await tick()
  f.liveSessions.set('ended-session', f.first.id)
  oldView.leave()
  f.starts[0].pending.resolve({ ok: false, sessionEnded: true, sessionId: 'ended-session', sentence: 'It ended.' })
  await result
  const saved = f.original.getNode(f.first.id)
  assert.equal(saved.sessionId, 'ended-session')
  assert.equal(saved.statusNote, 'The session ended.')
  assert.equal(f.liveSessions.has('ended-session'), false)
})

test('one finished handoff does not release a store another handoff still owns', async () => {
  const f = fixture()
  const second = f.original.addNode({ parentId: f.first.id, role: 'worker', tier: 'luna', message: 'Second brief.' }).node
  const originalView = f.view(f.original)
  const firstResult = originalView.start(f.first)
  const secondResult = originalView.start(second)
  await tick()
  assert.equal(f.pendingStores.get('computer-a').count, 2)
  originalView.leave()
  f.starts[0].pending.resolve({ ok: false, code: 'AGENT_RESOURCE_PRESSURE', sentence: 'Busy.' })
  await firstResult
  assert.equal(f.pendingStores.get('computer-a').count, 1)
  assert.equal(f.view().open(), f.original)
  assert.equal(f.original.getNode(second.id).status, 'starting')
  f.starts[1].pending.resolve({ ok: false, code: 'AGENT_RESOURCE_PRESSURE', sentence: 'Busy.' })
  await secondResult
  assert.equal(f.pendingStores.size, 0)
})

test('absence of renderer ownership does not rewrite a stored unresolved start', () => {
  const f = fixture()
  f.original.setNodeStatus(f.first.id, 'starting')
  const reopened = f.view().open()
  assert.equal(reopened.getNode(f.first.id).status, 'starting')
  assert.equal(f.starts.length, 0)
})

test('a successful handoff keeps its live session when its final receipt lands after navigation', async () => {
  const f = fixture()
  const oldView = f.view(f.original)
  const result = oldView.start(f.first)
  await tick()
  f.starts[0].options.onSessionOpen({ sessionId: 'started-session' })
  oldView.leave()
  f.starts[0].pending.resolve({ ok: true, sessionId: 'started-session' })
  assert.equal((await result).sessionId, 'started-session')
  assert.equal(f.original.getNode(f.first.id).status, 'running')
  assert.equal(f.liveSessions.get('started-session'), f.first.id)
  assert.equal(f.pendingStores.size, 0)
})

test('a transport rejection releases pending references without inventing a terminal outcome or retrying', async () => {
  const f = fixture()
  const oldView = f.view(f.original)
  const result = oldView.start(f.first)
  await tick()
  oldView.leave()
  f.starts[0].pending.reject(new Error('outcome unknown'))
  await assert.rejects(result, /outcome unknown/)
  assert.equal(f.pendingStores.size, 0)
  assert.equal(f.pendingNodes.size, 0)
  assert.equal(f.original.getNode(f.first.id).status, 'starting')
  assert.equal(f.starts.length, 1)
})

/* A LIVE VIEW CAN REPLACE ITS OWN STORE, AND `destroyed` DOES NOT SEE IT.
 *
 * Every other navigation case in this file is the DESTROY transition: `leave()`
 * sets `destroyed = true` and nulls the store together, and the start's own
 * `destroyed` guards catch it. That is the only transition the suite modelled, so
 * `destroyed` looked like a sufficient guard everywhere.
 *
 * It is not. `switchComputer` (a bare tab click) and the example-fleet toggle
 * (`onDataSourceChange`, which returns early ONLY if destroyed) both reassign
 * `treeStore` for the same computer while the view stays alive. During
 * `startDraftNodeUnguarded`'s two awaits -- `ensureSeatForNode` and
 * `window.mcResources.status` -- `RUN_STARTING_TREE_STORES` is still empty,
 * because this caller retains AFTER its awaits rather than before, so
 * `openTreeStore`'s resolution chain finds nothing to reuse and mints a second
 * store over the same storage. `createFleetTreeStore` reads storage once at
 * construction, so the two are genuinely forked from that moment.
 *
 * The function then finishes against the store it captured before the await and
 * writes the node's status and session onto it. Both post-await guards
 * interrogate that CAPTURED store, so they cannot detect this even in principle.
 * `resumeNodeSessionUnguarded`, in the same file, re-checks `treeStore !== store`;
 * this function does not. */
test('a start whose live view replaced its store mid-flight must not write to the store it replaced', async () => {
  const f = fixture()
  const v = f.view(f.original)
  const gate = deferred()
  v.context.ensureSeatForNode = async () => { await gate.promise; return { ok: true } }

  const pending = v.start(f.first)
  await tick()

  // The swap, through the view's own seams -- NOT `leave()`. `destroyed` stays
  // false throughout, which is the whole point of this case.
  v.context.releaseTreeStore()
  const live = v.open()
  assert.equal(v.context.destroyed, false, 'this case is about a LIVE view; a destroyed one is already guarded')
  assert.notEqual(live, f.original, 'precondition: the reopen must mint a second store or this test proves nothing')

  gate.resolve()
  await tick()
  // Settle any dispatched start before asserting, so a regression fails on the
  // assertion rather than leaving an unresolved fixture promise. This refusal
  // deliberately leaves a recorded status behind (unlike a resource refusal,
  // which returns the node to draft and would mask the write under test).
  for (const started of f.starts) started.pending.resolve({ ok: false, code: 'ASSISTANT_NOT_INSTALLED', sentence: 'The assistant is not installed.' })
  const result = await pending

  assert.equal(f.original.getNode(f.first.id).status, live.getNode(f.first.id).status,
    'the replaced store and the live store must not disagree about whether this node started')
  assert.equal(live.getNode(f.first.id).status, 'draft',
    'the node the person can actually see must still be a startable draft')
  assert.equal(f.starts.length, 0,
    'a start whose store was replaced mid-flight must not bind a session against the replaced store')
  assert.equal(result.notStarted, true, 'the refusal must be stated on the result, not silent')
})

test('a session opening after navigation preserves its exact brief and thread without painting the old view', async () => {
  const f = fixture()
  const oldView = f.view(f.original)
  const result = oldView.start(f.first)
  await tick()
  oldView.leave()
  const reopenedStore = f.view().open()
  f.starts[0].options.onSessionOpen({ sessionId: 'late-session', threadId: 'late-thread', roleIntroduction: 'Role directions.' })
  f.starts[0].pending.resolve({ ok: true, sessionId: 'late-session', threadId: 'late-thread' })
  assert.equal((await result).sessionId, 'late-session')
  assert.equal(reopenedStore.getNode(f.first.id).sessionId, 'late-session')
  assert.equal(reopenedStore.getNode(f.first.id).status, 'running')
  const saved = f.makeTranscripts().get(f.first.id)
  assert.deepEqual(saved.lines.map(line => line.text), [f.first.message, 'Tree address', 'Role directions.'])
  assert.equal(saved.threadId, 'late-thread')
  assert.equal(saved.provider, 'codex')
  assert.equal(oldView.transcriptSaves(), 1, 'opening lines should use one existing-store save')
  assert.equal(f.starts.length, 1)
})
