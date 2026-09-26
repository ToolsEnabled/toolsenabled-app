import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createFleetTreeStore, NODE_REMOVE_REFUSALS } from '../../src/fleet-trees.js'
import { planNodeRemoval, runNodeRemoval } from '../../src/tree-node-removal.js'
import { nodeIsBusy, sessionIsLive } from '../../src/tree-session-liveness.js'
import { createSingleFlight } from '../../src/single-flight.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const sourceSha256 = createHash('sha256').update(source).digest('hex')
const removalSource = ['nodeRemovalBlock', 'performNodeRemoval', 'performConfirmedBranchRemoval']
  .map(name => declaredFunctionSource(source, name)).join('\n')
const agentRemovalSource = readFileSync(new URL('../../src/agent-removal-rule.js', import.meta.url), 'utf8')
const agentRemovalSourceSha256 = createHash('sha256').update(agentRemovalSource).digest('hex')
const agentRemovalSourceForExtraction = agentRemovalSource.replace(/^export\s+(?=(?:async\s+)?function\s)/gm, '')
const directRouteSource = ['circleIsBelow', 'executeRemoveNode']
  .map(name => declaredFunctionSource(agentRemovalSourceForExtraction, name)).join('\n')

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

// Execute the complete production removal callback and branch orchestration.
// Persistence is a Map; the bridge acknowledges phases without invoking main,
// a provider, or native resources. No fixture path or deletion is needed.
function fixture(t) {
  const cells = new Map()
  const events = { removed: [], archived: [], committed: [], cancelled: [], handoff: [], status: [] }
  let counter = 0, tick = 0
  const makeStore = (data, label) => {
    const store = createFleetTreeStore({ computerId: 'postimage-proof',
      storage: {
        read: key => data.has(key) ? structuredClone(data.get(key)) : null,
        write: (key, value) => { data.set(key, structuredClone(value)); return true },
      },
      makeId: kind => `${kind}-${++counter}`,
      now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, tick++)).toISOString(),
    })
    return Object.freeze({ ...store, removeNode(id) {
      const result = store.removeNode(id)
      if (result.ok) events.removed.push({ store: label, id })
      return result
    } })
  }
  let store = makeStore(cells, 'original')
  const add = (name, parentId, options = {}) => {
    const result = store.addNode({ name, role: name, ...options, ...(parentId ? { parentId } : {}) })
    assert.equal(result.ok, true, result.problems?.join(' '))
    return result.node
  }
  const root = add('Controller')
  const orphan = add('Orphan', root.id, { madeByAgent: true })
  const sibling = add('Sibling', root.id)
  assert.equal(store.attachSession(orphan.id, 'ended-with-app').ok, true)
  assert.equal(store.setNodeStatus(orphan.id, 'running').ok, true)
  // Reload the persisted record as the app does after its former session ends.
  // Both the initial and replacement stores then use the real reader's shape.
  store = makeStore(cells, 'original')
  assert.equal(store.getNode(orphan.id).status, 'starting')
  const ownedSessions = new Map()
  const archiveEntered = deferred(), archiveRelease = deferred()
  const startDraftFlight = createSingleFlight()
  const nodeReplacementFlight = createSingleFlight()
  const noop = () => {}
  let firstArchive = true
  const scope = {
    treeStore: store, treeStoreId: 'postimage-proof', destroyed: false,
    runNodeRemoval, NODE_REMOVE_REFUSALS, startDraftFlight, nodeReplacementFlight,
    REMOVAL_CHAIN_STEPS: 64,
    REMOVAL_REFUSALS: {
      callerUnknown: 'MC_TREE_COMMAND_REMOVE_CALLER_UNKNOWN',
      notBelowCaller: 'MC_TREE_COMMAND_REMOVE_NOT_BELOW_CALLER',
      personSpoke: 'MC_TREE_COMMAND_REMOVE_PERSON_SPOKE',
      notAgentMade: 'MC_TREE_COMMAND_REMOVE_NOT_AGENT_MADE',
      storeRefused: 'MC_TREE_COMMAND_REMOVE_REFUSED',
      unavailable: 'MC_TREE_COMMAND_REMOVE_UNAVAILABLE',
    },
    recoveryCoordinator: () => null, nodeCleanupPending: () => false,
    nodeBusy: node => nodeIsBusy(node, ownedSessions),
    nodeSessionLive: node => sessionIsLive(node, ownedSessions),
    treeNodeName: node => node.role, startCleanupSentence: () => 'Cleanup is pending.',
    RUN_NODE_REMOVAL_CLOSE_RECEIPTS: new Map(), RUN_SESSION_CLEANUPS: new Map(),
    setOrgStatus: (...args) => events.status.push(args),
    refusalCode: error => error?.code || null,
    window: {
      mcAgent: { close: () => assert.fail('an orphan has no native session to close') },
      mcFleetProfile: { async removeNodeHandoff(request) {
        events.handoff.push({ ...request })
        return { operationId: request.operationId,
          phase: { prepare: 'prepared', commit: 'committed', finalize: 'finalized' }[request.phase] }
      } },
      dispatchEvent: noop,
    },
    transcriptStore: {
      async archive(id) {
        events.archived.push(id)
        if (firstArchive) {
          firstArchive = false
          archiveEntered.resolve()
          await archiveRelease.promise
        }
        return { archiveId: `archive-${id}` }
      },
      async commitArchive(id) { events.committed.push(id) },
      async cancelArchive(id) { events.cancelled.push(id) },
      remove: () => assert.fail('archived conversations must use the archive path'),
    },
    treeChatDrafts: { forget: noop }, releaseSeatForNode: async () => false,
    diffHistoryStore: null, resetSessionMetrics: noop, outboxClearSession: noop,
    clearSessionApprovals: noop, turnInterrupts: { forget: noop },
    graph: null, currentRailTreeNode: null, refreshTree: noop,
    REMOVE_PANEL: { done: name => `Removed ${name}.`, notRemoved: 'The node was kept.' },
    TREE_NODE_REMOVED_EVENT: 'fixture-node-removed',
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } },
  }
  for (const name of ['nodeDiffHistories', 'nodeReplies', 'nodeActivity', 'nodeLastTool',
    'sessionTranscripts', 'sessionTurnLog', 'sessionTurnText', 'sessionUsage',
    'sessionModelOverride', 'sessionPendingImages', 'sessionNodeIds', 'sessionProfileIds',
    'sessionEfforts', 'sessionThreadIds', 'sessionAccountNames', 'sessionActions',
    'chatSurfaces', 'turnReplies']) scope[name] = new Map()
  const context = vm.createContext(scope)
  vm.runInContext(`${removalSource}\n${directRouteSource}`, context, { filename: 'actual-computers-removal.cjs' })
  const plan = planNodeRemoval(store, root.id, { blocked: context.nodeRemovalBlock })
  assert.equal(plan.ok, true, plan.problems.join(' '))
  assert.deepEqual(plan.order, [orphan.id, sibling.id, root.id])
  assert.equal(sessionIsLive(store.getNode(orphan.id), ownedSessions), false)
  t.after(() => archiveRelease.resolve())
  const run = () => context.performConfirmedBranchRemoval(plan, store, root.role)
  const directRun = (target = orphan) => context.executeRemoveNode({
    command: { action: 'remove-node', nodeId: target.id, parentSessionId: 'direct-parent-session' },
    node: store.getNode(target.id), treeStore: store,
    sessionNodeIds: new Map([['direct-parent-session', root.id]]),
    removeCircle: context.performNodeRemoval,
  })
  const atArchive = async (target = orphan, detached = true) => {
    await archiveEntered.promise
    const current = store.getNode(target.id)
    if (detached) {
      assert.equal(current.sessionId, null, 'the real callback must have detached the orphan')
      assert.equal(current.status, 'draft', 'the owned lifecycle postimage must precede archiving')
    }
    assert.deepEqual(events.removed, [], 'nothing may have been removed before archiving returns')
  }
  const diagnostic = (scenario, extra = {}) => t.diagnostic(JSON.stringify({ scenario, sourceSha256, agentRemovalSourceSha256,
    removed: events.removed, committedArchives: events.committed, cancelledArchives: events.cancelled,
    ...extra }))
  return { store, cells, root, orphan, sibling, context, events, run, directRun, atArchive,
    releaseArchive: archiveRelease.resolve, startDraftFlight, diagnostic,
    replaceStore() {
      const replacement = makeStore(new Map(structuredClone([...cells])), 'replacement')
      assert.equal(JSON.stringify(replacement.getNode(orphan.id)), JSON.stringify(store.getNode(orphan.id)),
        'the newly active store must expose the exact same serialized orphan postimage')
      context.treeStore = replacement
      return replacement
    } }
}

test('an unchanged branch completes through the actual orphan lifecycle postimage', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const pending = f.run()
  await f.atArchive()
  f.releaseArchive()
  const result = await pending
  f.diagnostic('unchanged-control', { result })
  assert.equal(result, true)
  assert.deepEqual(f.events.removed.map(row => row.id), [f.orphan.id, f.sibling.id, f.root.id])
  assert.deepEqual(f.events.committed, [f.orphan.id, f.sibling.id, f.root.id])
  assert.deepEqual(f.events.cancelled, [])
})

test('a sibling start flight during archive keeps the orphan leaf despite its lifecycle postimage', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const pending = f.run()
  await f.atArchive()
  const savedAtArchive = JSON.stringify([...f.cells])
  const siblingStart = deferred()
  const flight = f.startDraftFlight.run(f.sibling.id, () => siblingStart.promise)
  t.after(async () => { siblingStart.resolve(); await flight })
  assert.equal(f.startDraftFlight.busy(f.sibling.id), true)
  assert.match(f.context.nodeRemovalBlock(f.store.getNode(f.sibling.id)), /finish starting or restarting/)
  assert.equal(JSON.stringify([...f.cells]), savedAtArchive, 'the sibling flight changes no durable forest bytes')
  f.releaseArchive()
  const result = await pending
  f.diagnostic('sibling-flight-during-archive', { result, siblingFlightBusy: f.startDraftFlight.busy(f.sibling.id),
    orphanRetained: Boolean(f.store.getNode(f.orphan.id)) })
  assert.equal(result, false)
  assert.deepEqual(f.events.removed, [], 'branch invalidation must prevent even the in-flight orphan leaf deletion')
  assert.ok(f.store.getNode(f.orphan.id))
  assert.deepEqual(f.events.cancelled, [f.orphan.id])
  assert.deepEqual(f.events.committed, [])
})

test('replacing the active store during archive keeps both stores after the orphan lifecycle postimage', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const pending = f.run()
  await f.atArchive()
  const replacement = f.replaceStore()
  f.releaseArchive()
  const result = await pending
  f.diagnostic('active-store-replaced-during-archive', { result,
    originalRetained: Boolean(f.store.getNode(f.orphan.id)), replacementRetained: Boolean(replacement.getNode(f.orphan.id)) })
  assert.equal(result, false)
  assert.deepEqual(f.events.removed, [], 'the callback must not delete from a newly active store with identical leaf bytes')
  assert.ok(f.store.getNode(f.orphan.id))
  assert.ok(replacement.getNode(f.orphan.id))
  assert.deepEqual(f.events.cancelled, [f.orphan.id])
  assert.deepEqual(f.events.committed, [])
})

test('the direct agent-removal command completes an orphan through its captured store', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const pending = f.directRun()
  await f.atArchive()
  f.releaseArchive()
  const answer = await pending
  f.diagnostic('direct-route-unchanged-control', { answer })
  assert.equal(answer.ok, true)
  assert.equal(answer.code, null)
  assert.deepEqual(f.events.removed, [{ store: 'original', id: f.orphan.id }])
  assert.deepEqual(f.events.committed, [f.orphan.id])
  assert.ok(f.store.getNode(f.sibling.id))
  assert.ok(f.store.getNode(f.root.id))
})

test('the direct agent-removal command refuses an active-store replacement after orphan detach', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const pending = f.directRun()
  await f.atArchive()
  const replacement = f.replaceStore()
  f.releaseArchive()
  const answer = await pending
  f.diagnostic('direct-route-active-store-replaced', { answer,
    originalRetained: Boolean(f.store.getNode(f.orphan.id)), replacementRetained: Boolean(replacement.getNode(f.orphan.id)) })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'MC_TREE_COMMAND_REMOVE_REFUSED')
  assert.deepEqual(f.events.removed, [])
  assert.ok(f.store.getNode(f.orphan.id))
  assert.ok(replacement.getNode(f.orphan.id))
  assert.deepEqual(f.events.cancelled, [f.orphan.id])
  assert.deepEqual(f.events.committed, [])
})

test('the direct agent-removal command completes a finished leaf without a lifecycle detach', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const added = f.store.addNode({ name: 'Finished direct', role: 'Finished direct', parentId: f.root.id, madeByAgent: true })
  assert.equal(added.ok, true)
  assert.equal(f.store.setNodeStatus(added.node.id, 'finished').ok, true)
  const idle = f.store.getNode(added.node.id)
  assert.equal(idle.status, 'finished')
  const pending = f.directRun(idle)
  await f.atArchive(idle, false)
  f.releaseArchive()
  const answer = await pending
  f.diagnostic('direct-route-finished-control', { answer, idleStatus: idle.status })
  assert.equal(answer.ok, true)
  assert.deepEqual(f.events.removed, [{ store: 'original', id: idle.id }])
  assert.deepEqual(f.events.committed, [idle.id])
})

test('the direct agent-removal command refuses a store replacement for a finished leaf', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const added = f.store.addNode({ name: 'Finished direct', role: 'Finished direct', parentId: f.root.id, madeByAgent: true })
  assert.equal(added.ok, true)
  assert.equal(f.store.setNodeStatus(added.node.id, 'finished').ok, true)
  const idle = f.store.getNode(added.node.id)
  assert.equal(idle.status, 'finished')
  const pending = f.directRun(idle)
  await f.atArchive(idle, false)
  const replacement = f.replaceStore()
  f.releaseArchive()
  const answer = await pending
  f.diagnostic('direct-route-finished-active-store-replaced', { answer,
    originalRetained: Boolean(f.store.getNode(idle.id)), replacementRetained: Boolean(replacement.getNode(idle.id)) })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'MC_TREE_COMMAND_REMOVE_REFUSED')
  assert.deepEqual(f.events.removed, [])
  assert.ok(f.store.getNode(idle.id))
  assert.ok(replacement.getNode(idle.id))
  assert.deepEqual(f.events.cancelled, [idle.id])
  assert.deepEqual(f.events.committed, [])
})
