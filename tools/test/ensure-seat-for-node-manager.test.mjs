/* A TREE-SPAWNED CIRCLE'S SEAT NAMES NO MANAGER AT ALL, SO THE ORG STORE
 * SILENTLY DEFAULTS IT TO THE ROOT -- see an internal report.
 *
 * ensureSeatForNode (src/views/computers.js) is closure-private inside
 * computersView, same wall as every other test in this neighbourhood; it is
 * pinned here by extracting its own declared source (declaredFunctionSource)
 * and running it for real in an isolated sandbox, the same technique
 * tools/test/tree-command-projection-ready.test.mjs already uses for
 * runTreeNodeCommand -- not by reading the source as text.
 *
 *   node tools/test/ensure-seat-for-node-manager.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
// A namespace import, so this file still loads (and fails on behaviour) at a
// base that predates the helper.
import * as declaredFleet from '../../src/declared-fleet.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sourceText = readFileSync(path.join(repoRoot, 'src', 'views', 'computers.js'), 'utf8')
const rootSeatForSrc = declaredFunctionSource(sourceText, 'rootSeatFor')
const ensureSeatForNodeSrc = declaredFunctionSource(sourceText, 'ensureSeatForNode')

/* Every free variable ensureSeatForNode and rootSeatFor read from the real
 * closure, stubbed to the minimum that lets the two run for real. `io.calls`
 * records exactly what reached window.mcOrg.ensureSeat -- the seam this test
 * is about. */
function loadEnsureSeatForNode(io) {
  const factory = new Function('io', `
    'use strict'
    let orgAvailability = { org: { agents: io.agents, revision: 1 } }
    const orgReady = () => true
    const roleRecordFor = role => ({ id: role, capabilities: { orgRoot: role === 'controller' } })
    const window = { mcOrg: { ensureSeat: async args => {
      io.calls.push(args)
      if (io.error) throw io.error
      if (io.result) return io.result
      return { ok: true, org: { ...orgAvailability.org, agents: [...orgAvailability.org.agents, { id: args.id, role: args.role, displayName: args.displayName || args.id, enabled: true }] } }
    } } }
    const LAUNCH_TIERS = io.tiers || []
    const treeNodeName = node => io.displayName
    const isRevisionConflict = () => false
    const refreshOrg = async () => ({ state: 'ready' })
    ${rootSeatForSrc}
    ${ensureSeatForNodeSrc}
    return ensureSeatForNode
  `)
  return factory(io)
}

test('a tree-spawned circle asks for a seat named by the node id, with no manager named at all', async () => {
  const calls = []
  const agents = [{ id: 'alpha', role: 'manager', enabled: true }]
  const ensureSeatForNode = loadEnsureSeatForNode({ agents, calls, displayName: 'Worker 3' })
  const node = { id: 'node-1-00000001-0000-4000-8000-000000000001', parentId: 'alpha', tier: null }

  await ensureSeatForNode(node, 'worker')

  assert.equal(calls.length, 1, 'ensureSeatForNode never reached window.mcOrg.ensureSeat at all')
  assert.equal(calls[0].id, node.id,
    'the seat asked for a different id than the node\'s own -- this fixture no longer demonstrates the leak')
  assert.equal(calls[0].managerId, 'alpha',
    `bad value undefined: the real tree parent ("alpha", which already holds a seat) is known from node.parentId but ` +
    'was never sent as managerId, so the organisation store silently defaults this seat\'s manager to the root -- ' +
    'every leaked node-id seat reports to "controller" regardless of where it actually sits on the tree')
})

test('a tree-spawned circle\'s seat request names the tree node in its own nodeId field', async () => {
  const calls = []
  const agents = [{ id: 'alpha', role: 'manager', enabled: true }]
  const ensureSeatForNode = loadEnsureSeatForNode({ agents, calls, displayName: 'Worker 3' })
  const node = { id: 'node-1-00000001-0000-4000-8000-000000000001', parentId: 'alpha', tier: null }

  await ensureSeatForNode(node, 'worker')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].nodeId, node.id,
    'the seat request must carry the tree node id in its own nodeId field, additive to id, ' +
    'so agent-org-store.js can record it without changing what a seat is looked up by')
})

test('the root seat request names no nodeId, because a controller circle adopts the shipped root seat, not a per-node one', async () => {
  const calls = []
  const agents = [{ id: 'controller', role: 'controller', enabled: true }]
  const io = { agents, calls, displayName: 'Controller' }
  const ensureSeatForNode = loadEnsureSeatForNode(io)
  const node = { id: 'node-1-root-circle', parentId: null, tier: null }

  await ensureSeatForNode(node, 'controller')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].nodeId, undefined,
    'the root seat is not per-node -- sending nodeId for it would misrecord the shipped root seat as bound to this one tree node')
  assert.equal(calls[0].requestingNodeId, node.id, 'the requesting circle is named separately for live-provider admission, without rebinding the root seat')
  const refusal = { ok: false, code: 'MC_AGENT_SEAT_PROVIDER_IN_USE', reason: 'Use the active conversation provider or choose a different role.' }
  io.result = JSON.parse(JSON.stringify(refusal))
  assert.deepEqual(await ensureSeatForNode(node, 'controller'), refusal, 'returned IPC refusal remains exact')
  io.error = Object.assign(new Error(refusal.reason), { code: refusal.code })
  assert.deepEqual(await ensureSeatForNode(node, 'controller'), refusal, 'typed bridge failures preserve code and reason too')
  io.error = new Error('offline')
  assert.deepEqual(await ensureSeatForNode(node, 'controller'), { ok: false, code: 'ORG_ENSURE_SEAT_THREW',
    reason: 'The seat could not be sent to the organisation store: offline' }, 'untyped failures keep the existing fallback')
})

test('a circle whose own parent has no seat yet still falls back to the store\'s own default', async () => {
  const calls = []
  const agents = []
  const ensureSeatForNode = loadEnsureSeatForNode({ agents, calls, displayName: 'Worker 1' })
  const node = { id: 'node-1-first-child', parentId: 'node-1-unseeded-parent', tier: null }

  await ensureSeatForNode(node, 'worker')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].managerId, undefined,
    'a parent with no seat of its own must not be named as managerId -- the store would refuse AGENT_ORG_STORE_UNKNOWN_AGENT, ' +
    'so this case must keep going through the store\'s own default (the root) exactly as before this change')
})

/* EVERY CONTROLLER CIRCLE, IN EVERY TREE, BINDS TO THE ONE ORGANISATION ROOT,
 * and the root now carries each provider one of them started on (a Codex
 * Controller and a Claude Controller at once). Two things on this page read
 * the root seat's provider and must read the whole set. */
const pendingModelDrainBlockedSrc = declaredFunctionSource(sourceText, 'pendingModelDrainBlocked')
const TIERS = [{ id: 'claude-opus', provider: 'claude' }, { id: 'sol', provider: 'codex' }]

function loadPendingModelDrainBlocked(io) {
  const factory = new Function('io', 'seatCarriesProvider', `
    'use strict'
    const destroyed = false
    const orgAvailability = { org: { agents: io.agents, revision: 1 } }
    const roleRecordFor = role => ({ id: role, capabilities: { orgRoot: role === 'controller' } })
    const identityRoleForTreeNode = role => role
    const LAUNCH_TIERS = io.tiers
    const treeStore = { getNode: id => io.nodes.get(id) || null, setNodeStatus: (id, status, note) => io.notes.push({ id, status, ...note }) }
    const nodeBusy = () => false
    const outboxList = () => ['a queued message']
    const pendingModelDrainHolds = io.holds
    ${rootSeatForSrc}
    ${pendingModelDrainBlockedSrc}
    return pendingModelDrainBlocked
  `)
  return factory(io, declaredFleet.seatCarriesProvider)
}

test('a Claude Controller\'s queued messages drain once the root seat carries Claude beside Codex', () => {
  const node = { id: 'node-2-controller', role: 'controller', tier: 'claude-opus', sessionId: 'session-claude', status: 'running' }
  for (const [providers, blocked, why] of [
    [['codex', 'claude'], false, 'the root seat carries the circle\'s provider, so its model change is reconciled'],
    [undefined, true, 'a root seat that carries only Codex still holds a Claude circle\'s queue'],
  ]) {
    const io = { agents: [{ id: 'controller', role: 'controller', provider: 'codex', ...(providers ? { providers } : {}), enabled: true }],
      tiers: TIERS, nodes: new Map([[node.id, node]]), notes: [], holds: new Set() }
    const pendingModelDrainBlocked = loadPendingModelDrainBlocked(io)
    assert.equal(pendingModelDrainBlocked(node.id, node.sessionId, true), blocked, why)
    assert.equal(io.holds.has(node.sessionId), blocked)
  }
})

test('a circle\'s own seat on Codex still holds a Claude model change', () => {
  const node = { id: 'node-3-worker', role: 'worker', tier: 'claude-opus', sessionId: 'session-worker', status: 'running' }
  const io = { agents: [{ id: 'controller', role: 'controller', provider: 'codex', providers: ['codex', 'claude'], enabled: true },
    { id: node.id, role: 'worker', provider: 'codex', enabled: true }], tiers: TIERS, nodes: new Map([[node.id, node]]), notes: [], holds: new Set() }
  assert.equal(loadPendingModelDrainBlocked(io)(node.id, node.sessionId, true), true,
    'only the organisation root carries more than one provider; a node seat is not widened by the root\'s')
})

test('a Claude Controller circle asks the root seat to adopt Claude while it carries Codex', async () => {
  const calls = []
  const agents = [{ id: 'controller', role: 'controller', provider: 'codex', enabled: true }]
  const ensureSeatForNode = loadEnsureSeatForNode({ agents, calls, displayName: 'Controller', tiers: TIERS })
  const node = { id: 'node-2-00000202', parentId: null, tier: 'claude-opus' }
  await ensureSeatForNode(node, 'controller')
  assert.equal(calls.length, 1, 'a root circle always asks, so the store can add its provider')
  assert.equal(calls[0].id, 'controller')
  assert.equal(calls[0].provider, 'claude', 'the provider this circle runs on')
  assert.equal(calls[0].adoptProvider, true, 'the root seat is asked to adopt, which now adds rather than replaces')
  assert.equal(calls[0].requestingNodeId, node.id)
  assert.equal(calls[0].nodeId, undefined)
})
