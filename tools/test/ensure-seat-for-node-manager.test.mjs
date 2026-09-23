/* A TREE-SPAWNED CIRCLE'S SEAT NAMES NO MANAGER AT ALL, SO THE ORG STORE
 * SILENTLY DEFAULTS IT TO THE ROOT -- see REPORT-org-vocabulary-leak-20260907.md.
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
      return { ok: true, org: { ...orgAvailability.org, agents: [...orgAvailability.org.agents, { id: args.id, role: args.role, displayName: args.displayName || args.id, enabled: true }] } }
    } } }
    const LAUNCH_TIERS = []
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
  const node = { id: 'node-1-11bbb999-2218-44a6-893a-9a7a3e8e6716', parentId: 'alpha', tier: null }

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
  const node = { id: 'node-1-11bbb999-2218-44a6-893a-9a7a3e8e6716', parentId: 'alpha', tier: null }

  await ensureSeatForNode(node, 'worker')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].nodeId, node.id,
    'the seat request must carry the tree node id in its own nodeId field, additive to id, ' +
    'so agent-org-store.js can record it without changing what a seat is looked up by')
})

test('the root seat request names no nodeId, because a controller circle adopts the shipped root seat, not a per-node one', async () => {
  const calls = []
  const agents = [{ id: 'controller', role: 'controller', enabled: true }]
  const ensureSeatForNode = loadEnsureSeatForNode({ agents, calls, displayName: 'Controller' })
  const node = { id: 'node-1-root-circle', parentId: null, tier: null }

  await ensureSeatForNode(node, 'controller')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].nodeId, undefined,
    'the root seat is not per-node -- sending nodeId for it would misrecord the shipped root seat as bound to this one tree node')
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
