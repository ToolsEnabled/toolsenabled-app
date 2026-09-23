import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { MANAGED_SLOT_ACTIONS } from '../../src/managed-slot-choice.js'

const sourceText = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const declarations = ['finishProjectionLoad', 'loadProjection', 'mountMockFleet', 'mountRealSource', 'bootFromSource', 'readAuthoritativeDesktopTree', 'requestAuthoritativeDesktopTree']
  .map(name => declaredFunctionSource(sourceText, name)).join('\n')
const commandMethod = declaredFunctionSource(
  sourceText.replace(/async runTreeNodeCommand\(/, 'async function runTreeNodeCommand('),
  'runTreeNodeCommand',
)
const destroyMethod = declaredFunctionSource(
  sourceText.replace(/^[\t ]+destroy\(/m, 'function destroy('),
  'destroy',
)

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const tick = () => new Promise(resolve => setImmediate(resolve))
const command = { action: 'create-and-start-node', computerId: 'computer-a', nodeId: null }
const fleet = (computerId = 'computer-a') => ({ ok: true, data: { data: { computerId } } })

// Execute the real boot, projection load and command handler. Only the network,
// DOM paint and final start are substitutes; this test launches no providers.
function view({ fetchFleet, readOrg = async () => ({}), initialSource = 'local', window = {}, allowExpectedStop = false }) {
  const starts = []
  const teardown = []
  const factory = new Function('io', 'starts', 'teardown', `
    'use strict'
    let destroyed = false, fetchVersion = 0, source = null
    let desktopTreeReadAt = -Infinity, desktopTreeTimer = null, desktopTreeFlight = null, desktopTreeStopRefresh = false
    const DESKTOP_TREE_INTERVAL_MS = ${/const DESKTOP_TREE_INTERVAL_MS = (\d+)/.exec(sourceText)[1]}
    // These cases use local or example data. Execute the real authority readers
    // while making any unexpected remote I/O fail at the network boundary.
    const desktopTreeBridge = () => null
    const readDesktopTreeSnapshot = () => { throw new Error('Local projection must not read a remote tree') }
    const refreshAuthoritativeDesktopTree = () => { throw new Error('Local projection must not refresh a remote tree') }
    const window = io.window || {}
    let projectionReady = Promise.resolve()
    let resolveProjectionReady = null
    let treeStore = null, treeStoreId = null, orgAvailability = null
    const nodes = new Map()
    const sessionNodeIds = new Map([['session-old', 'stop-node']])
    const transcriptStore = null
    const resolveDataSource = async () => io.initialSource
    const currentDataSource = () => source
    const fetchFleet = io.fetchFleet
    const readOrg = io.readOrg
    const orgReady = () => false
    const closeWorkspaceControls = () => {}
    const workspaceChats = new Set(), workspaceComposePanels = new Set()
    const readLiveSession = () => null
    const declaredFleetData = () => null
    const showProjectionUnavailable = () => { treeStore = null; treeStoreId = null }
    const mountProjection = data => {
      treeStoreId = data.computerId || data.computers?.[0]?.id
      nodes.set('stop-node', { id: 'stop-node', sessionId: 'session-old' })
      treeStore = { getNode: id => nodes.get(id), setNodeStatus() {} }
    }
    const sweepOrphanedNodeSeats = async () => {}
    const syncEditAvailability = () => {}
    const requestDesktopSessions = () => {}
    const startableTiersNow = async () => {}
    const loadRailRuns = () => {}
    const readResearchOnce = () => {}
    const loadMachineChoices = async () => {}
    const resolveLedgerAuth = async () => {}
    const START_CONTROL_FLAG = 'agent-session'
    const isWriteEnabled = () => true
    const createAndStartNode = async value => {
      starts.push({ computerId: treeStoreId, command: value })
      return { ok: true, nodeId: 'child', sessionId: 'session', threadId: null }
    }
    const ORG_ABSENT_REASON = 'not connected'
    const machineChoicesBelongHere = () => false
    const setMachineNote = () => {}
    const TIER_CHOICES = [], TREE_DEFAULT_STARTABLE_TIERS = []
    let machineChoices, railRuns, railRunsSupported, startableTierChoices, startableTierIdList
    /* mountMockFleet() clears this alongside the two tier lists above it, so the
       harness has to own it too. It arrived with the tier-probe retry (906ea9d0,
       computers.js:11509) and without it the real mountMockFleet() this test
       executes throws ReferenceError under 'use strict' before any assertion. */
    let tierAnswerMissing
    /* Same story, next arrival: mountMockFleet() also clears startableTierAnswered
       (computers.js, beside the tier lists), so the harness owns it for the same
       reason tierAnswerMissing is owned above. A let here rather than a scope
       parameter on purpose -- mountMockFleet() and readStartableTiers() ASSIGN it,
       and an assignment to a function parameter would be silently local, so the
       harness would diverge from the module it is executing. */
    let startableTierAnswered
    let signedOutProviders, noProgramProviders, composeFolders, composeDefaultFolder, composeConfinementLine
    const sampleFleetData = () => ({ computers: [{ id: 'sample-computer' }], graph: {} })
    const treeLaunchQueues = new Map(), nodeLaunchQueues = new Map()
    const sessionActions = new Map(), sessionOpenTurns = new Map(), sessionCompletedTurnIds = new Map(), chatSurfaces = new Map()
    const nativeReconcileSessions = new Set()
    const chatSpeechFrame = 0, chatSpeechPending = new Set(), turnInterrupts = { clear() {} }
    let treeStripObserver = null
    const notifyNodeStatusListeners = () => {}
    const compareFiles = { close() {} }
    const railDisposeTimer = 0, orgStatusTimer = 0, chipRefreshFrame = 0, revealChipFrame = 0
    const disposeRailSaid = () => {}, disposeRailChat = () => {}
    const clearBoard = () => {}, clearMountedGraph = () => {}, closeComposePanel = () => {}
    const releaseTreeStore = () => { treeStore = null; treeStoreId = null }
    const refreshTree = () => {}
    const outboxClearSession = () => {}
    const settleStoppedSession = sessionId => {
      if (!io.allowExpectedStop) throw new Error('Unexpected stop in projection fixture')
      teardown.push({ action: 'settled-stop', sessionId })
    }
    const resetSessionMetrics = () => {}
    const stopStillOwnsNode = (sessionId, current) => current?.sessionId === sessionId
    const RUN_SESSION_CLEANUPS = new Map()
    const RUN_STARTING_TREE_STORES = new Map()
    const RUN_TREE_RUNTIME_STORES = new Map()
    const TERMINAL_AGENT_SESSION_CODES = new Set()
    const nodeBusy = () => false
    const nodeCleanupPending = () => false
    const callerCircleRefusal = () => null
    const phoneCanvas = null, phoneLedger = null, unsubs = []
    const captureRoleLibrary = () => { teardown.push({ action: 'capture-roles', destroyed }) }
    const MANAGED_SLOT_ACTIONS = io.MANAGED_SLOT_ACTIONS
    ${declarations}
    const bootPromise = bootFromSource()
    ${commandMethod}
    ${destroyMethod}
    return {
      run: runTreeNodeCommand,
      refresh: mountRealSource,
      destroy,
      changeSource: value => { source = value; mountMockFleet() },
      starts,
      teardown,
      nodes,
    }
  `)
  return factory({ fetchFleet, readOrg, initialSource, window, allowExpectedStop, MANAGED_SLOT_ACTIONS }, starts, teardown)
}

test('a command arriving on route mount waits for the fleet before starting', async () => {
  const pendingFleet = deferred()
  let reads = 0
  const mounted = view({ fetchFleet: () => { reads += 1; return pendingFleet.promise } })
  let settled = false
  const result = mounted.run(command).then(value => { settled = true; return value })
  await tick()
  assert.equal(settled, false, 'a loading computer is not a missing computer')
  assert.equal(mounted.starts.length, 0)
  pendingFleet.resolve(fleet())
  assert.equal((await result).ok, true)
  assert.equal(mounted.starts.length, 1)
  assert.equal(mounted.starts[0].computerId, command.computerId)
  assert.equal(reads, 1, 'the command must share the route load, not start another read')
})

test('a ready view handles commands without waiting for another event-loop turn or reloading', async () => {
  let reads = 0
  const mounted = view({ fetchFleet: async () => { reads += 1; return fleet() } })
  await tick()
  const completed = await Promise.race([
    mounted.run(command).then(result => result.ok ? 'started' : result.code),
    tick().then(() => 'delayed'),
  ])
  assert.equal(completed, 'started', 'a loaded projection adds no timer delay')
  assert.equal(reads, 1)
  assert.equal(mounted.starts.length, 1)
})

test('a command also waits for the organization needed to open its tree', async () => {
  const pendingOrg = deferred()
  const mounted = view({ fetchFleet: async () => fleet(), readOrg: () => pendingOrg.promise })
  let settled = false
  const result = mounted.run(command).then(value => { settled = true; return value })
  await tick()
  assert.equal(settled, false)
  pendingOrg.resolve({})
  assert.equal((await result).ok, true)
  assert.equal(mounted.starts.length, 1)
})

test('commands during a later projection refresh wait for that refresh too', async () => {
  const pendingRefresh = deferred()
  let reads = 0
  const mounted = view({ fetchFleet: () => ++reads === 1 ? Promise.resolve(fleet()) : pendingRefresh.promise })
  await tick()
  mounted.refresh()
  let settled = false
  const result = mounted.run(command).then(value => { settled = true; return value })
  await tick()
  assert.equal(settled, false)
  pendingRefresh.resolve(fleet())
  assert.equal((await result).ok, true)
  assert.equal(mounted.starts.length, 1)
})

test('a newer refresh superseding the awaited load must finish before a start', async () => {
  const first = deferred()
  const second = deferred()
  const third = deferred()
  const loads = [first, second, third]
  const mounted = view({ fetchFleet: () => loads.shift().promise })
  first.resolve(fleet())
  await tick()
  mounted.refresh()
  let settled = false
  const result = mounted.run(command).then(value => { settled = true; return value })
  await tick()
  mounted.refresh()
  second.resolve(fleet('stale-computer'))
  await tick()
  assert.equal(settled, false)
  assert.equal(mounted.starts.length, 0)
  third.resolve(fleet())
  assert.equal((await result).ok, true)
  assert.equal(mounted.starts[0].computerId, command.computerId)
})

test('a settled fleet containing another computer still refuses the command', async () => {
  const mounted = view({ fetchFleet: async () => fleet('computer-b') })
  assert.equal((await mounted.run(command)).code, 'MC_TREE_COMMAND_COMPUTER_NOT_FOUND')
  assert.equal(mounted.starts.length, 0)
})

test('an unreadable fleet refuses without starting anything', async () => {
  const mounted = view({ fetchFleet: async () => { throw new Error('unavailable') } })
  assert.equal((await mounted.run(command)).code, 'MC_TREE_COMMAND_COMPUTER_NOT_FOUND')
  assert.equal(mounted.starts.length, 0)
})

test('the example reports its actual refusal before looking for a real store', async () => {
  const mounted = view({ initialSource: 'mock', fetchFleet: async () => { throw new Error('must not read') } })
  assert.equal((await mounted.run(command)).code, 'MC_TREE_COMMAND_REAL_SOURCE_REQUIRED')
  assert.equal(mounted.starts.length, 0)
})

test('destroying the view releases the command even if its network read never settles', async () => {
  const pending = deferred()
  const mounted = view({ fetchFleet: () => pending.promise })
  const result = mounted.run(command)
  await tick()
  mounted.destroy()
  const settled = await Promise.race([result, tick().then(() => ({ code: 'still-waiting-for-network' }))])
  assert.equal(settled.code, 'MC_TREE_COMMAND_VIEW_DESTROYED')
  assert.equal(settled.retryable, true)
  assert.equal(settled.retryAfterMs, 0)
  assert.equal(mounted.starts.length, 0)
  assert.deepEqual(mounted.teardown, [{ action: 'capture-roles', destroyed: false }],
    'the role snapshot must be requested before destroying the view')
})

test('switching to the example releases the command even if its old network read never settles', async () => {
  const pending = deferred()
  const mounted = view({ fetchFleet: () => pending.promise })
  const result = mounted.run(command)
  await tick()
  mounted.changeSource('mock')
  const settled = await Promise.race([result, tick().then(() => ({ code: 'still-waiting-for-network' }))])
  assert.equal(settled.code, 'MC_TREE_COMMAND_REAL_SOURCE_REQUIRED')
  assert.equal(mounted.starts.length, 0)
})

test('stop-node teardown after a confirmed close returns the completed result without retry advice', async () => {
  let mounted
  let closeCalls = 0
  const close = async () => {
    closeCalls += 1
    mounted.destroy()
    return { ok: true, closed: true, sessionId: 'session-old' }
  }
  mounted = view({ fetchFleet: async () => fleet(), allowExpectedStop: true, window: { mcAgent: { close } } })
  await tick()
  const result = await mounted.run({ ...command, action: 'stop-node', nodeId: 'stop-node' })
  assert.equal(result.ok, true)
  assert.equal(result.closed, true)
  assert.equal(result.projectionUnavailable, true)
  assert.equal(result.retryable, undefined)
  assert.equal(closeCalls, 1)
  assert.equal(mounted.starts.length, 0)
  assert.deepEqual(mounted.teardown, [
    { action: 'capture-roles', destroyed: false },
    { action: 'settled-stop', sessionId: 'session-old' },
  ])
})
