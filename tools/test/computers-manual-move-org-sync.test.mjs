/* T908 — a focused mounted regression for T906's manual-move/org-sync repair
 * (src/views/computers.js: handleReparent's tree branch and the Details tab's
 * Reports-to Save both call the shared syncSavedTreeMove, now landed).
 *
 * handleReparent and onOpenControls are private closures of computersView, not
 * reachable through a public selector or runTreeNodeCommand. This file
 * captures the real references mountGraph() hands to `new StaticTreeGraph`
 * (via StaticTreeGraph.prototype._syncCardMetrics, called synchronously right
 * after the constructor assigns them) and calls them directly -- mounted-
 * callback evidence, not pointer/CDP drag simulation or a source-text pin.
 *
 * Every store here is the real one: fleet-trees.js's own tree store through
 * its real localStorage key, and a synthetic declared-organisation bridge
 * shaped exactly like shell/agent-org-record.cjs's own read()/reparent()
 * contract. This file owns no production source; it does not edit
 * src/views/computers.js or tools/test/lib/tree-command-real-mount.mjs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { readFileSync } from 'node:fs'
/* computers.js imports stylesheets; node has no CSS module format. Same
   stand-in loader tree-card-selected-chat-currentness-real-mount.test.mjs
   already registers. */
register('./helpers/css-stub-loader.mjs', import.meta.url)
import { createFleetTreeStore, fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { setExampleMode } from '../../src/data-source.js'
import { installWorld, mountView, settle, fleetFetch, COMPUTER_ID } from './lib/tree-command-real-mount.mjs'
const OBSERVED_AT = '2026-09-22T00:00:00.000Z'
const FLEET_SCHEMA = JSON.parse(readFileSync(new URL('../../public/data/schema/fleet.schema.json', import.meta.url), 'utf8'))

/* A synthetic declared-organisation store, shaped exactly like the real
 * shell/agent-org-record.cjs -> engine contract this page's org-controls.js
 * consumes (projectOrg's own fields; reparent's own ok/org/revision receipt
 * and AGENT_ORG_STORE_REVISION_CONFLICT refusal) — not a stand-in vocabulary
 * of its own. `roles` defaults empty; the root-seat-alias fixture is the only
 * one that needs a real role record (capabilities.orgRoot) to resolve through. */
function makeOrgWorld(agents, relationships, { revision = 1, roles = [], readResult = null } = {}) {
  const state = {
    revision,
    agents: agents.map(agent => ({ ...agent })),
    relationships: relationships.map(edge => ({ ...edge })),
  }
  const writes = []
  const snapshot = () => ({
    revision: state.revision,
    contentHash: 'fixture-' + state.revision,
    agents: state.agents.map(agent => ({ ...agent })),
    relationships: state.relationships.map(edge => ({ ...edge })),
  })
  const bridge = {
    async read() {
      if (readResult) return typeof readResult === 'function' ? readResult() : readResult
      return { ok: true, org: snapshot(), roles: roles.map(role => ({ ...role })) }
    },
    async reparent(request) {
      const { agentId, parentId, expectedRevision } = request
      writes.push({ ...request })
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        return { ok: false, code: 'AGENT_ORG_STORE_REVISION_CONFLICT',
          reason: 'The declared org changed since it was read (fixture).' }
      }
      const agent = state.agents.find(entry => entry.id === agentId)
      if (!agent) return { ok: false, code: 'AGENT_ORG_STORE_UNKNOWN_AGENT', reason: 'No such agent (fixture).' }
      state.relationships = state.relationships.filter(edge => !(edge.type === 'manages' && edge.to === agentId))
      if (parentId !== null && parentId !== undefined) {
        state.relationships.push({ from: parentId, to: agentId, type: 'manages' })
      }
      state.revision += 1
      return { ok: true, org: snapshot() }
    },
  }
  return { bridge, snapshot, writes, bumpRevisionBehindThePage: () => { state.revision += 1 } }
}

const managerOf = (org, agentId) =>
  org.relationships.find(edge => edge.type === 'manages' && edge.to === agentId)?.from ?? null

/* Multi-node seed, through the exact storage key createFleetTreeStore itself
 * reads/writes — generalized from tree-command-real-mount.mjs's own
 * seedTreeNode, which only ever writes one node per call and so cannot seed a
 * manager/child shape. Left local to this file rather than added to the
 * shared harness: this file owns no production or shared-harness source. */
function seedTree(storage, { computerId = COMPUTER_ID, treeId = 'tree-1', nodes }) {
  const seeded = nodes.map(node => ({
    treeId, createdAt: OBSERVED_AT, updatedAt: OBSERVED_AT, role: 'worker', message: '', statusNote: '',
    sessionId: null, parentId: null, ...node,
  }))
  /* One root per tree is a real store invariant (fleet-trees.js's moveNode:
     "This tree already has a top agent"); every distinct treeId actually used
     by a node gets its own declared tree, matching "every agent starts as its
     own single-node tree" (src/fleet-trees.js). */
  const treeIds = [...new Set(seeded.map(node => node.treeId))]
  storage.setItem(fleetTreesStorageKey(computerId), JSON.stringify({
    version: 1,
    computerId,
    trees: treeIds.map(id => ({ id, name: null, createdAt: OBSERVED_AT, updatedAt: OBSERVED_AT, profileId: null })),
    nodes: seeded,
  }))
}

/* Open the same persisted record through the real tree store API. This is
 * used only to perform the lifecycle transition that proves a retained declared
 * seat can become a draft without releasing its organisation identity. */
function treeStoreFor(world) {
  return createFleetTreeStore({
    computerId: COMPUTER_ID,
    storage: {
      read: key => world.storage.getItem(key),
      writeText: (key, text) => {
        world.storage.setItem(key, text)
        return true
      },
      write: (key, value) => {
        world.storage.setItem(key, JSON.stringify(value))
        return true
      },
    },
  })
}

/* The shared harness's fleetFetch() always answers a single hardcoded
 * placeholder fleet node, which the view prefers over the declared-org
 * fixture whenever the fetch itself succeeds. That is invisible to every test
 * here that only exercises the TREE store, but handleReparent's fleet-agent
 * branch (computer.reparentAgent) projects off this fleet fetch, not the tree
 * store, so a fleet-agent fixture needs its own agents to actually appear in
 * it. Built locally (same schema file the harness itself reads) rather than
 * by editing the shared harness, which this file does not own. */
function fleetGateFor({ computerId = COMPUTER_ID, agents } = {}) {
  const nodes = agents.map(agent => ({
    id: agent.id, label: agent.displayName || agent.id, role: agent.role,
    provider: agent.provider || 'claude', enabled: agent.enabled !== false,
  }))
  const projection = {
    schemaVersion: 1, domain: 'fleet', generatedAt: OBSERVED_AT, ok: true, reason: null, sources: [],
    data: {
      computers: [{ id: computerId, label: 'This computer', sourceKind: 'observed', observedAt: OBSERVED_AT, activeSessions: 0, services: [] }],
      graph: { revision: 1, contentHash: '0'.repeat(64), nodes, edges: [] },
    },
  }
  const jsonResponse = value => ({ ok: true, status: 200, statusText: 'OK', json: async () => value })
  return {
    async fetch(url) {
      if (url === '/data/fleet.json') return jsonResponse(projection)
      if (url === '/data/schema/fleet.schema.json') return jsonResponse(FLEET_SCHEMA)
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
    },
  }
}

/* Capture the real handleReparent closure without editing production source:
 * see the file header. Returns a function that resolves to the captured
 * reference once the view has mounted and the graph's constructor has run at
 * least once. */
function captureOnReparent() {
  const original = StaticTreeGraph.prototype._syncCardMetrics
  let captured = null
  StaticTreeGraph.prototype._syncCardMetrics = function (...args) {
    if (captured === null) captured = this
    return original.apply(this, args)
  }
  return {
    restore() { StaticTreeGraph.prototype._syncCardMetrics = original },
    get instance() { return captured },
  }
}

/* There is no data-tree-node selector in src/views/computers.js (checked by
 * reading the source, not assumed). A node's Details rail opens through
 * mountGraph's own onOpenControls, the same captured constructor option
 * onReparent is; it is called with { treeNode }. This reads the node back out
 * of the SAME storage seedTree just wrote, so what showTreeNodeControls
 * receives is never a second, drifting description of the seeded node. */
function readTreeNode(storage, nodeId, computerId = COMPUTER_ID) {
  const stored = JSON.parse(storage.getItem(fleetTreesStorageKey(computerId)))
  const node = stored.nodes.find(entry => entry.id === nodeId)
  if (!node) throw new Error('readTreeNode: no seeded node ' + nodeId)
  return node
}

/* Mounts a real computersView over a fresh world, with a synthetic declared-
 * org bridge and a seeded tree. asyncFrames:true is required: without it
 * installWorld never stubs requestAnimationFrame/cancelAnimationFrame at all,
 * and the mounted graph/canvas view uses them -- confirmed by the
 * ReferenceError this fixture threw during cleanup before this flag was added.
 * fleetAgents, when given, replaces the harness's own placeholder fleet node
 * with fleet graph nodes built from the same records passed as orgAgents, so
 * the fleet-agent branch of handleReparent can resolve them; tree-only
 * fixtures never need it. Cleanup is registered before the mount so it still
 * runs if mountView itself rejects; view.destroy() (which cancels the view's
 * own timers and unsubscribes) runs before the DOM/global/prototype
 * restoration that follows it, not after. */
async function mountFixture(t, { orgAgents, orgRelationships, orgRevision = 1, orgRoles = [], orgRead = null, treeNodes, mock = false, fleetAgents = null, prepareTree = null } = {}) {
  const gate = fleetAgents ? fleetGateFor({ agents: fleetAgents }) : fleetFetch()
  const world = await installWorld(gate, { asyncFrames: true })
  const org = makeOrgWorld(orgAgents, orgRelationships, { revision: orgRevision, roles: orgRoles, readResult: orgRead })
  globalThis.mcOrg = org.bridge
  globalThis.window.mcOrg = org.bridge
  seedTree(world.storage, { nodes: treeNodes })
  /* The real, public toggle (src/data-source.js), not a URL guess: it writes
     through the SAME localStorage stand-in installWorld() just set up, and
     sets resolveDataSource()'s own cached answer directly. Declined again in
     cleanup so this module-level state never leaks into a later test in this
     same process. */
  if (mock) setExampleMode(true)
  const capture = captureOnReparent()
  let view = null
  const closeView = async () => {
    if (!view) return
    await view.destroy()
    view.el?.remove?.()
    view = null
  }
  t.after(async () => {
    capture.restore()
    setExampleMode(false)
    delete globalThis.mcOrg
    await closeView()
    world.restore()
  })
  prepareTree?.(world)
  view = await mountView(world)
  await settle()
  return {
    world, view, org, closeView,
    graphOnReparent: () => capture.instance?.onReparent ?? null,
    handleReparent: (...args) => capture.instance.onReparent(...args),
    openNodeControls: nodeId => capture.instance.onOpenControls({ id: nodeId, treeNode: readTreeNode(world.storage, nodeId) }),
  }
}

/* ---------- controls move-save: the Details tab's Reports-to -> Save ---------- */

test('move-save updates the declared organisation to match the accepted tree move', async t => {
  const { view, org, openNodeControls } = await mountFixture(t, {
    orgAgents: [
      { id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null },
      { id: 'manager-a', displayName: 'Manager A', role: 'manager', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'manager-a' },
      { id: 'manager-b', displayName: 'Manager B', role: 'manager', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'manager-b' },
      { id: 'target', displayName: 'Target', role: 'worker', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'target' },
    ],
    orgRelationships: [
      { from: 'controller', to: 'manager-a', type: 'manages' },
      { from: 'controller', to: 'manager-b', type: 'manages' },
      { from: 'manager-a', to: 'target', type: 'manages' },
    ],
    treeNodes: [
      { id: 'manager-a', status: 'finished' },
      { id: 'manager-b', status: 'finished', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'finished' },
    ],
  })
  assert.equal(managerOf(org.snapshot(), 'target'), 'manager-a', 'fixture must start with the org agreeing with the tree')

  openNodeControls('target')
  await settle()
  const moveSelect = view.el.querySelector('[data-tree-move-select]')
  assert.ok(moveSelect, 'the Reports-to move control did not mount for a movable node')
  moveSelect.value = 'manager-b'
  moveSelect.dispatchEvent(new Event('change'))
  view.el.querySelector('[data-tree-move-save]').click()
  await settle()

  const stored = view.el.ownerDocument.defaultView.localStorage
  const treeNode = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(n => n.id === 'target')
  assert.equal(treeNode.parentId, 'manager-b', 'the tree move itself must still be accepted and saved')
  assert.equal(managerOf(org.snapshot(), 'target'), 'manager-b',
    'T906: the declared organisation must follow an accepted manual move')
})

test('move-save preserves session identity across the move', async t => {
  const { view, openNodeControls } = await mountFixture(t, {
    orgAgents: [{ id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null }],
    orgRelationships: [],
    treeNodes: [
      { id: 'manager-a', status: 'finished' },
      { id: 'manager-b', status: 'finished', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'running', sessionId: 'live-session-1' },
    ],
  })
  openNodeControls('target')
  await settle()
  const moveSelect = view.el.querySelector('[data-tree-move-select]')
  moveSelect.value = 'manager-b'
  moveSelect.dispatchEvent(new Event('change'))
  view.el.querySelector('[data-tree-move-save]').click()
  await settle()
  const stored = view.el.ownerDocument.defaultView.localStorage
  const nodes = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes
  const moved = nodes.find(n => n.id === 'target')
  assert.equal(moved.parentId, 'manager-b')
  assert.equal(moved.sessionId, 'live-session-1', 'a move must not detach or change the session identity of a live circle')
  assert.equal(nodes.filter(n => n.sessionId === 'live-session-1').length, 1, 'no other node may pick up the moved session id')
})

test('move-save preserves a stopped child of the moved node', async t => {
  const { view, openNodeControls } = await mountFixture(t, {
    orgAgents: [{ id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null }],
    orgRelationships: [],
    treeNodes: [
      { id: 'manager-a', status: 'finished' },
      { id: 'manager-b', status: 'finished', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'finished' },
      { id: 'stopped-child', parentId: 'target', status: 'finished', sessionId: 'ended-session-1' },
    ],
  })
  openNodeControls('target')
  await settle()
  const moveSelect = view.el.querySelector('[data-tree-move-select]')
  moveSelect.value = 'manager-b'
  moveSelect.dispatchEvent(new Event('change'))
  view.el.querySelector('[data-tree-move-save]').click()
  await settle()
  const stored = view.el.ownerDocument.defaultView.localStorage
  const nodes = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes
  const child = nodes.find(n => n.id === 'stopped-child')
  assert.ok(child, 'the stopped child must still exist after moving its parent')
  assert.equal(child.status, 'finished', 'a stopped child must not be revived or otherwise altered by its parent moving')
  assert.equal(child.parentId, 'target', 'the child stays under the moved node; the subtree moves as a unit')
  assert.equal(nodes.find(n => n.id === 'target').parentId, 'manager-b')
})

test('move-save keeps an unseated draft move saved without an organisation warning or write', async t => {
  const { view, org, openNodeControls } = await mountFixture(t, {
    orgAgents: [{ id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null }],
    orgRelationships: [],
    treeNodes: [
      { id: 'manager-a', status: 'draft' },
      { id: 'manager-b', status: 'draft', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'draft' },
    ],
  })
  openNodeControls('target')
  await settle()
  const moveSelect = view.el.querySelector('[data-tree-move-select]')
  assert.ok(moveSelect, 'the Reports-to move control must remain available for a draft node')
  moveSelect.value = 'manager-b'
  moveSelect.dispatchEvent(new Event('change'))
  view.el.querySelector('[data-tree-move-save]').click()
  await settle()

  const stored = view.el.ownerDocument.defaultView.localStorage
  const treeNode = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(n => n.id === 'target')
  assert.equal(treeNode.parentId, 'manager-b', 'the saved tree move must remain durable')
  assert.equal(org.writes.length, 0, 'an unseated draft must not write to the declared organisation')
  assert.match(view.el.querySelector('[data-tree-move-out]').textContent, /^Saved\./)
  const status = view.el.querySelector('.org-status')
  assert.ok(status)
  assert.notEqual(status.dataset.state, 'warn', 'a move with no organisation projection must not warn')
  assert.doesNotMatch(status.textContent, /Nothing was changed/)
})

/* With the organisation unreadable, mountGraph passes no onReparent (the Edit
 * drag is locked), so the only manual move left is Details > Reports to > Save.
 * These cases drive that real control. */
async function saveReportsTo(view, openNodeControls, nodeId, parentId) {
  openNodeControls(nodeId)
  await settle()
  const moveSelect = view.el.querySelector('[data-tree-move-select]')
  assert.ok(moveSelect, 'the Reports-to move control must remain available while the organisation is unreadable')
  moveSelect.value = parentId
  moveSelect.dispatchEvent(new Event('change'))
  view.el.querySelector('[data-tree-move-save]').click()
  await settle()
}

test('an unseated draft move stays saved and non-warn when the organisation is not ready', async t => {
  const { view, org, openNodeControls, graphOnReparent } = await mountFixture(t, {
    orgAgents: [],
    orgRelationships: [],
    orgRead: { ok: false, code: 'ORG_READ_FAILED', reason: 'fixture organisation unavailable' },
    treeNodes: [
      { id: 'manager-a', status: 'draft' },
      { id: 'manager-b', status: 'draft', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'draft' },
    ],
  })
  assert.equal(graphOnReparent(), null, 'fixture premise: an unreadable organisation locks the drag door')
  await saveReportsTo(view, openNodeControls, 'target', 'manager-b')
  const stored = view.el.ownerDocument.defaultView.localStorage
  const treeNode = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(n => n.id === 'target')
  assert.equal(treeNode.parentId, 'manager-b', 'the accepted tree move must remain saved')
  assert.equal(org.writes.length, 0, 'an unavailable organisation must not receive a draft move')
  assert.match(view.el.querySelector('[data-tree-move-out]').textContent, /^Saved\./)
  const status = view.el.querySelector('.org-status')
  assert.ok(status)
  assert.notEqual(status.dataset.state, 'warn')
  assert.doesNotMatch(status.textContent, /declared organisation was not updated|Nothing was changed/)
})

test('a retained seated draft defers organisation sync when its reader is unavailable', async t => {
  const { openNodeControls, org, view } = await mountFixture(t, {
    orgAgents: [
      { id: 'manager-a', role: 'manager', enabled: true, nodeId: 'manager-a' },
      { id: 'manager-b', role: 'manager', enabled: true, nodeId: 'manager-b' },
      { id: 'target', role: 'worker', enabled: true, nodeId: 'target' },
    ],
    orgRelationships: [{ from: 'manager-a', to: 'target', type: 'manages' }],
    orgRead: { ok: false, code: 'ORG_READ_FAILED', reason: 'fixture organisation unavailable' },
    treeNodes: [
      { id: 'manager-a', status: 'finished' },
      { id: 'manager-b', status: 'finished', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'running', sessionId: 'retained-session' },
    ],
    prepareTree: world => {
      const tree = treeStoreFor(world)
      const detached = tree.detachSession('target')
      assert.equal(detached.ok, true, 'the real detachSession transition must succeed')
      assert.equal(detached.node.status, 'draft')
      assert.equal(detached.node.sessionId, null)
    },
  })
  await saveReportsTo(view, openNodeControls, 'target', 'manager-b')
  const stored = view.el.ownerDocument.defaultView.localStorage
  const treeNode = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(n => n.id === 'target')
  assert.equal(treeNode.parentId, 'manager-b', 'the accepted tree move must remain saved')
  assert.equal(org.writes.length, 0, 'an unreadable organisation must not receive a guessed draft move')
  assert.match(view.el.querySelector('[data-tree-move-out]').textContent, /^Saved\./)
  const status = view.el.querySelector('.org-status')
  assert.ok(status)
  assert.notEqual(status.dataset.state, 'warn')
  assert.doesNotMatch(status.textContent, /declared organisation was not updated|Nothing was changed/)
})

test('a retained seated draft still warns when a ready organisation has no writer', async t => {
  const { handleReparent, org, view } = await mountFixture(t, {
    orgAgents: [
      { id: 'manager-a', role: 'manager', enabled: true, nodeId: 'manager-a' },
      { id: 'manager-b', role: 'manager', enabled: true, nodeId: 'manager-b' },
      { id: 'target', role: 'worker', enabled: true, nodeId: 'target' },
    ],
    orgRelationships: [{ from: 'manager-a', to: 'target', type: 'manages' }],
    treeNodes: [
      { id: 'manager-a', status: 'finished' },
      { id: 'manager-b', status: 'finished', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'running', sessionId: 'retained-session' },
    ],
    prepareTree: world => {
      const tree = treeStoreFor(world)
      const detached = tree.detachSession('target')
      assert.equal(detached.ok, true, 'the real detachSession transition must succeed')
      assert.equal(detached.node.status, 'draft')
      assert.equal(detached.node.sessionId, null)
    },
  })
  org.bridge.reparent = undefined
  assert.equal(handleReparent('target', 'manager-b'), true)
  await settle()
  const stored = view.el.ownerDocument.defaultView.localStorage
  const treeNode = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(n => n.id === 'target')
  assert.equal(treeNode.parentId, 'manager-b', 'the accepted tree move must remain saved')
  assert.equal(org.writes.length, 0, 'a missing writer must not create an organisation write')
  const status = view.el.querySelector('.org-status')
  assert.ok(status)
  assert.equal(status.dataset.state, 'warn',
    'a known seated draft must not be treated as an unseated no-op')
  assert.match(status.textContent, /The tree move was saved, but the declared organisation was not updated\./)
  assert.match(status.textContent, /The saved manager could not be sent to the organisation store\./)
  assert.match(status.textContent, /The tree move is saved; review the current organisation before trying again\./)
  assert.doesNotMatch(status.textContent, /Nothing was changed/)
})

test('the example fleet never writes this fixture\'s own seeded tree or the declared org', async t => {
  const { view, org, graphOnReparent } = await mountFixture(t, {
    mock: true,
    orgAgents: [{ id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null }],
    orgRelationships: [],
    treeNodes: [
      { id: 'manager-a', status: 'finished' },
      { id: 'manager-b', status: 'finished', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'finished' },
    ],
  })
  const revisionBefore = org.snapshot().revision
  /* openTreeStore's own mockSource() branch returns openSampleTreeStore()
   * (read directly in src/views/computers.js, not assumed): under mock the
   * Details rail's move row is built against THAT in-memory sample tree --
   * whose node ids createSampleTreeStore mints itself through its own
   * createTree/addNode calls, not chosen by any caller -- never against this
   * fixture's own seeded store. A click aimed at a node id this fixture
   * seeded (e.g. 'target') therefore cannot land on the sample row's real
   * button handler; the example's own node ids are not this file's to pin,
   * and doing so would coincidentally couple this file to sample-trees.js and
   * sample-simulation.js, neither of which this file owns. What IS provable
   * without that coupling, and is proved here: the mounted graph's own
   * onReparent stays null (the same evidence test8 captures, on a second,
   * independently seeded fixture), and this fixture's own seeded tree record
   * and the declared org both stay exactly as seeded, regardless of what the
   * example toggle does internally. */
  assert.equal(graphOnReparent(), null, 'mountGraph must still pass a null onReparent for the example fleet')
  const stored = view.el.ownerDocument.defaultView.localStorage
  const treeNode = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(n => n.id === 'target')
  assert.equal(treeNode.parentId, 'manager-a', 'the example toggle must never write into this fixture\'s own seeded tree record')
  assert.equal(org.snapshot().revision, revisionBefore, 'the example toggle must never write to the declared organisation either')
})

/* ---------- handleReparent, the drag's own callback (captured, see header) ---------- */

test('handleReparent keeps an unseated draft move saved without an organisation warning or write', async t => {
  const { handleReparent, org, view } = await mountFixture(t, {
    orgAgents: [{ id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null }],
    orgRelationships: [],
    treeNodes: [
      { id: 'manager-a', status: 'draft' },
      { id: 'manager-b', status: 'draft', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'draft' },
    ],
  })
  assert.equal(handleReparent('target', 'manager-b'), true)
  await settle()
  const stored = view.el.ownerDocument.defaultView.localStorage
  const treeNode = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(n => n.id === 'target')
  assert.equal(treeNode.parentId, 'manager-b', 'the accepted tree move must remain saved')
  assert.equal(org.writes.length, 0, 'an unseated draft must not write to the declared organisation')
  const status = view.el.querySelector('.org-status')
  assert.ok(status)
  assert.match(status.textContent, /^Saved\./)
  assert.equal(status.dataset.state, 'ok')
})

test('handleReparent warns honestly when a seated child moves under an unseated manager', async t => {
  const { handleReparent, org, view } = await mountFixture(t, {
    orgAgents: [{ id: 'target', displayName: 'Target', role: 'worker', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'target' }],
    orgRelationships: [],
    treeNodes: [
      { id: 'manager-a', status: 'finished' },
      { id: 'manager-b', status: 'finished', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'finished' },
    ],
  })
  assert.equal(handleReparent('target', 'manager-b'), true)
  await settle()
  const stored = view.el.ownerDocument.defaultView.localStorage
  const treeNode = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(n => n.id === 'target')
  assert.equal(treeNode.parentId, 'manager-b', 'the accepted tree move must remain saved')
  assert.equal(org.writes.length, 0, 'an unseated manager must not receive a guessed organisation write')
  const status = view.el.querySelector('.org-status')
  assert.ok(status)
  assert.equal(status.dataset.state, 'warn')
  assert.match(status.textContent, /The tree move was saved, but the declared organisation was not updated\./)
  assert.match(status.textContent, /The saved manager has no declared seat\./)
  assert.doesNotMatch(status.textContent, /Nothing was changed/)
})

test('handleReparent (tree branch) updates the declared organisation to match the accepted move', async t => {
  const { handleReparent, org } = await mountFixture(t, {
    orgAgents: [
      { id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null },
      { id: 'manager-a', displayName: 'Manager A', role: 'manager', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'manager-a' },
      { id: 'manager-b', displayName: 'Manager B', role: 'manager', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'manager-b' },
      { id: 'target', displayName: 'Target', role: 'worker', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'target' },
    ],
    orgRelationships: [
      { from: 'controller', to: 'manager-a', type: 'manages' },
      { from: 'controller', to: 'manager-b', type: 'manages' },
      { from: 'manager-a', to: 'target', type: 'manages' },
    ],
    treeNodes: [
      { id: 'manager-a', status: 'finished' },
      { id: 'manager-b', status: 'finished', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'finished' },
    ],
  })
  assert.equal(typeof handleReparent, 'function', 'the real handleReparent closure was not captured off the mounted graph')
  const moved = handleReparent('target', 'manager-b')
  await settle()
  assert.equal(moved, true, 'a legal tree-to-tree drag must still be accepted')
  assert.equal(managerOf(org.snapshot(), 'target'), 'manager-b',
    'T906: a real drag-accepted move must also update the declared organisation')
})

test('handleReparent (tree branch) preserves session identity and a stopped child', async t => {
  const { handleReparent, view } = await mountFixture(t, {
    orgAgents: [{ id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null }],
    orgRelationships: [],
    treeNodes: [
      { id: 'manager-a', status: 'finished' },
      { id: 'manager-b', status: 'finished', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'running', sessionId: 'live-session-2' },
      { id: 'stopped-child', parentId: 'target', status: 'finished', sessionId: 'ended-session-2' },
    ],
  })
  const moved = handleReparent('target', 'manager-b')
  await settle()
  assert.equal(moved, true)
  const stored = view.el.ownerDocument.defaultView.localStorage
  const nodes = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes
  const target = nodes.find(n => n.id === 'target')
  const child = nodes.find(n => n.id === 'stopped-child')
  assert.equal(target.parentId, 'manager-b')
  assert.equal(target.sessionId, 'live-session-2', 'the drag must not disturb the moved circle\'s own session identity')
  assert.ok(child, 'the stopped child must survive a real drag of its parent')
  assert.equal(child.status, 'finished')
  assert.equal(child.parentId, 'target')
})

test('handleReparent refuses a mixed tree/fleet-agent drag without writing to either store', async t => {
  const { handleReparent, org, view } = await mountFixture(t, {
    orgAgents: [
      { id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null },
      { id: 'standalone-agent', displayName: 'Standalone', role: 'worker', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null },
    ],
    orgRelationships: [{ from: 'controller', to: 'standalone-agent', type: 'manages' }],
    treeNodes: [{ id: 'target', status: 'finished' }],
  })
  const revisionBefore = org.snapshot().revision
  const moved = handleReparent('target', 'standalone-agent')
  await settle()
  assert.equal(moved, false, 'a tree node dragged onto a non-tree fleet agent must refuse, not silently pick a side')
  const stored = view.el.ownerDocument.defaultView.localStorage
  const treeNode = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(n => n.id === 'target')
  assert.equal(treeNode.parentId, null, 'the refused mixed drag must not have moved the tree node')
  assert.equal(org.snapshot().revision, revisionBefore, 'the refused mixed drag must not have written to the declared organisation')
})

test('the example fleet never wires handleReparent as the graph\'s drop callback', async t => {
  const { graphOnReparent } = await mountFixture(t, {
    mock: true,
    orgAgents: [{ id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null }],
    orgRelationships: [],
    treeNodes: [{ id: 'target', status: 'finished' }],
  })
  // syncEditAvailability and moveSave both state the same rule in words
  // (EXAMPLE_REARRANGE_TEXT); this proves the graph's OWN constructor
  // argument, from the real mount, carries the same refusal — not a fourth,
  // undocumented door into the example tree.
  assert.equal(graphOnReparent(), null, 'mountGraph must still pass a null onReparent for the example fleet')
})

/* ---------- an existing, already-working guard: fleet-agent revision-conflict refusal ---------- */

test('handleReparent (fleet-agent branch) still refuses on a stale organisation revision and re-syncs', async t => {
  const orgAgents = [
    { id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null },
    { id: 'manager-a', displayName: 'Manager A', role: 'manager', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null },
    { id: 'standalone-agent', displayName: 'Standalone', role: 'worker', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null },
  ]
  const { handleReparent, org, view } = await mountFixture(t, {
    orgAgents,
    orgRelationships: [
      { from: 'controller', to: 'manager-a', type: 'manages' },
      { from: 'controller', to: 'standalone-agent', type: 'manages' },
    ],
    treeNodes: [],
    fleetAgents: orgAgents,
  })
  void view
  const revisionBefore = org.snapshot().revision
  // Move the org out from under the page's own read, the way a second window
  // would, before the page's own reparent write lands.
  org.bumpRevisionBehindThePage()
  const moved = handleReparent('standalone-agent', 'manager-a')
  assert.equal(moved, true, 'the fleet-agent branch answers synchronously and optimistically; the store is asked afterward')
  await settle()
  assert.equal(managerOf(org.snapshot(), 'standalone-agent'), 'controller',
    'a stale-revision write must be refused, not silently applied over a change this page never read')
  assert.equal(org.snapshot().revision, revisionBefore + 1,
    'only the concurrent bump may have advanced the revision; the refused write must not have advanced it again')
})

/* ---------- T906's own new guards inside syncSavedTreeMove (tree branch) ---------- */

test('handleReparent (tree branch) refuses on a stale organisation revision without rolling back the accepted tree move', async t => {
  const { handleReparent, org, view } = await mountFixture(t, {
    orgAgents: [
      { id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null },
      { id: 'manager-a', displayName: 'Manager A', role: 'manager', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'manager-a' },
      { id: 'manager-b', displayName: 'Manager B', role: 'manager', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'manager-b' },
      { id: 'target', displayName: 'Target', role: 'worker', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'target' },
    ],
    orgRelationships: [
      { from: 'controller', to: 'manager-a', type: 'manages' },
      { from: 'controller', to: 'manager-b', type: 'manages' },
      { from: 'manager-a', to: 'target', type: 'manages' },
    ],
    treeNodes: [
      { id: 'manager-a', status: 'finished' },
      { id: 'manager-b', status: 'finished', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'running', sessionId: 'live-session-3' },
      { id: 'stopped-child', parentId: 'target', status: 'finished', sessionId: 'ended-session-3' },
    ],
  })
  const revisionBefore = org.snapshot().revision
  org.bumpRevisionBehindThePage()
  const moved = handleReparent('target', 'manager-b')
  assert.equal(moved, true, 'the tree branch answers synchronously and optimistically; the org write is asked afterward')
  await settle()
  const stored = view.el.ownerDocument.defaultView.localStorage
  const nodes = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes
  const target = nodes.find(n => n.id === 'target')
  const child = nodes.find(n => n.id === 'stopped-child')
  assert.equal(target.parentId, 'manager-b', 'the accepted tree move must never be rolled back by a refused declared-organisation write')
  assert.equal(target.sessionId, 'live-session-3', 'the moved circle keeps its own session identity regardless of the org refusal')
  assert.ok(child, 'a stopped child must survive even when the org write for its parent is refused')
  assert.equal(child.parentId, 'target')
  assert.equal(managerOf(org.snapshot(), 'target'), 'manager-a', 'a stale-revision write must be refused, not silently applied over a change this page never read')
  assert.equal(org.snapshot().revision, revisionBefore + 1, 'only the concurrent bump may have advanced the revision; the refused write must not have advanced it again')
  const status = view.el.querySelector('.org-status')
  assert.ok(status.textContent.includes('The tree move was saved, but the declared organisation was not updated.'),
    'a refused declared-organisation write must leave a visible saved-but-not-updated warning, never a silent failure')
  assert.ok(status.textContent.includes('Another window changed the organisation first.'),
    'a stale-revision refusal specifically must carry REVISION_CONFLICT_ADVICE, not a generic or fixture-internal reason')
  assert.equal(status.dataset.state, 'warn')
})

test('handleReparent (tree branch) refuses the declared-organisation write when the read revision is not a safe integer', async t => {
  /* The moved circle and both managers hold declared seats, so this move
     really needs an organisation write; only the unusable revision stops it.
     (A circle with no seat at all needs no write: that case is the
     unseated-draft test above.) */
  const { handleReparent, org, view } = await mountFixture(t, {
    orgAgents: [
      { id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null },
      { id: 'manager-a', displayName: 'Manager A', role: 'manager', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'manager-a' },
      { id: 'manager-b', displayName: 'Manager B', role: 'manager', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'manager-b' },
      { id: 'target', displayName: 'Target', role: 'worker', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'target' },
    ],
    orgRelationships: [{ from: 'manager-a', to: 'target', type: 'manages' }],
    orgRevision: null,
    treeNodes: [
      { id: 'manager-a', status: 'finished' },
      { id: 'manager-b', status: 'finished', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'finished' },
    ],
  })
  const moved = handleReparent('target', 'manager-b')
  assert.equal(moved, true)
  await settle()
  const stored = view.el.ownerDocument.defaultView.localStorage
  const treeNode = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(n => n.id === 'target')
  assert.equal(treeNode.parentId, 'manager-b', 'the tree move must still be accepted and saved')
  assert.equal(org.snapshot().revision, null, 'an org store with no usable revision must never be written to')
  assert.equal(org.writes.length, 0, 'no reparent may be attempted without a usable revision')
  const status = view.el.querySelector('.org-status')
  assert.ok(status.textContent.includes('The saved manager could not be sent to the organisation store.'),
    'a missing/invalid org revision must produce the ORG_TREE_MOVE_UNAVAILABLE sentence, not a silent no-op')
  assert.equal(status.dataset.state, 'warn')
})

test('handleReparent (tree branch) refuses the declared-organisation write when the moved node maps to more than one enabled seat', async t => {
  const { handleReparent, org, view } = await mountFixture(t, {
    orgAgents: [
      { id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null },
      { id: 'manager-a', displayName: 'Manager A', role: 'manager', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'manager-a' },
      { id: 'manager-b', displayName: 'Manager B', role: 'manager', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'manager-b' },
      { id: 'target', displayName: 'Target', role: 'worker', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null },
      { id: 'target-shadow', displayName: 'Target shadow', role: 'worker', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'target' },
    ],
    orgRelationships: [
      { from: 'controller', to: 'manager-a', type: 'manages' },
      { from: 'controller', to: 'manager-b', type: 'manages' },
    ],
    treeNodes: [
      { id: 'manager-a', status: 'finished' },
      { id: 'manager-b', status: 'finished', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'finished' },
    ],
  })
  const revisionBefore = org.snapshot().revision
  const moved = handleReparent('target', 'manager-b')
  assert.equal(moved, true)
  await settle()
  const stored = view.el.ownerDocument.defaultView.localStorage
  const treeNode = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(n => n.id === 'target')
  assert.equal(treeNode.parentId, 'manager-b', 'the tree move must still be accepted and saved')
  assert.equal(org.snapshot().revision, revisionBefore, 'an ambiguous seat must never be guessed at and written to')
  assert.equal(managerOf(org.snapshot(), 'target'), null)
  assert.equal(managerOf(org.snapshot(), 'target-shadow'), null)
  const status = view.el.querySelector('.org-status')
  assert.ok(status.textContent.includes('no unambiguous declared seat'),
    'an ambiguous seat must produce the ORG_TREE_MOVE_IDENTITY_UNAVAILABLE sentence, not a guess')
  assert.match(status.textContent, /more than one enabled declared seat/,
    'the refusal must distinguish ambiguity from a zero-seat draft')
  assert.equal(status.dataset.state, 'warn')
})

test('handleReparent (tree branch) refuses to treat an unconfirmed declared-organisation response as success', async t => {
  const { handleReparent, org, view } = await mountFixture(t, {
    orgAgents: [
      { id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null },
      { id: 'manager-a', displayName: 'Manager A', role: 'manager', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'manager-a' },
      { id: 'manager-b', displayName: 'Manager B', role: 'manager', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'manager-b' },
      { id: 'target', displayName: 'Target', role: 'worker', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'target' },
    ],
    orgRelationships: [
      { from: 'controller', to: 'manager-a', type: 'manages' },
      { from: 'controller', to: 'manager-b', type: 'manages' },
      { from: 'manager-a', to: 'target', type: 'manages' },
    ],
    treeNodes: [
      { id: 'manager-a', status: 'finished' },
      { id: 'manager-b', status: 'finished', treeId: 'tree-2' },
      { id: 'target', parentId: 'manager-a', status: 'finished' },
    ],
  })
  const revisionBefore = org.snapshot().revision
  // A bridge that answers truthy-but-incomplete -- no org, no confirmed
  // revision -- is not a confirmed success; syncSavedTreeMove must not
  // assume the write landed just because ok was not explicitly false.
  org.bridge.reparent = async () => ({ ok: true })
  const moved = handleReparent('target', 'manager-b')
  assert.equal(moved, true)
  await settle()
  const stored = view.el.ownerDocument.defaultView.localStorage
  const treeNode = JSON.parse(stored.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(n => n.id === 'target')
  assert.equal(treeNode.parentId, 'manager-b', 'the tree move must still be accepted and saved')
  assert.equal(org.snapshot().revision, revisionBefore, 'an unconfirmed response must never be treated as an applied write')
  assert.equal(managerOf(org.snapshot(), 'target'), 'manager-a', 'the declared organisation keeps its last confirmed state, not a guessed new one')
  const status = view.el.querySelector('.org-status')
  assert.ok(status.textContent.includes('The organisation store did not confirm the saved manager.'),
    'an unconfirmed response must produce the ORG_TREE_MOVE_UNCONFIRMED sentence, not a silently assumed success')
  assert.equal(status.dataset.state, 'warn')
})

test('handleReparent (tree branch) resolves a parent through its declared root-role seat when the saved node id has no direct match', async t => {
  const { handleReparent, org } = await mountFixture(t, {
    orgAgents: [
      { id: 'seat-controller-9', displayName: 'Controller seat', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [], nodeId: null },
      { id: 'target', displayName: 'Target', role: 'worker', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [], nodeId: 'target' },
    ],
    orgRelationships: [],
    orgRoles: [{ id: 'controller', name: 'Controller', capabilities: { orgRoot: true } }],
    treeNodes: [
      { id: 'legacy-root', role: 'controller', status: 'finished' },
      { id: 'other-branch', status: 'finished', treeId: 'tree-2' },
      { id: 'target', parentId: 'other-branch', status: 'finished', treeId: 'tree-2' },
    ],
  })
  assert.equal(managerOf(org.snapshot(), 'target'), null, 'fixture must start with target unmanaged in the declared org')
  const moved = handleReparent('target', 'legacy-root')
  assert.equal(moved, true, 'a legal cross-tree move onto the saved root node must still be accepted')
  await settle()
  assert.equal(managerOf(org.snapshot(), 'target'), 'seat-controller-9',
    'a saved parent whose node id has no direct declared seat, but whose role is the declared org-root role with exactly one enabled seat, must resolve to that seat')
})

for (const closeBeforeWrite of [false, true]) test(`queued manual moves use the preceding organisation revision${closeBeforeWrite ? ' after the view closes' : ''}`, async t => {
  const fixture = await mountFixture(t, {
    orgAgents: [
      { id: 'manager-a', role: 'manager', enabled: true, nodeId: 'manager-a' },
      { id: 'manager-b', role: 'manager', enabled: true, nodeId: 'manager-b' },
      { id: 'manager-c', role: 'manager', enabled: true, nodeId: 'manager-c' },
      { id: 'target', role: 'worker', enabled: true, nodeId: 'target' },
    ],
    orgRelationships: [{ from: 'manager-a', to: 'target', type: 'manages' }],
    treeNodes: [
      { id: 'manager-a', status: 'finished' },
      { id: 'manager-b', status: 'finished', treeId: 'tree-2' },
      { id: 'manager-c', status: 'finished', treeId: 'tree-3' },
      { id: 'target', parentId: 'manager-a', status: 'finished', sessionId: 'retained-session' },
    ],
  })
  const { org, handleReparent, closeView, world } = fixture
  const reparent = org.bridge.reparent
  const writes = []
  let release
  const held = new Promise(resolve => { release = resolve })
  t.after(() => release())
  org.bridge.reparent = async request => {
    writes.push({ ...request })
    if (writes.length === 1) await held
    return reparent(request)
  }
  assert.equal(handleReparent('target', 'manager-b'), true)
  await settle()
  assert.equal(writes.length, 1)
  assert.equal(handleReparent('target', 'manager-c'), true)
  await settle()
  assert.equal(writes.length, 1, 'the second organisation write waits for the first receipt')
  assert.equal(readTreeNode(world.storage, 'target').parentId, 'manager-c', 'both local saves already completed')
  if (closeBeforeWrite) await closeView()
  release()
  await settle()
  assert.deepEqual(writes, [
    { agentId: 'target', parentId: 'manager-b', expectedRevision: 1 },
    { agentId: 'target', parentId: 'manager-c', expectedRevision: 2 },
  ])
  assert.equal(managerOf(org.snapshot(), 'target'), 'manager-c')
  assert.equal(org.snapshot().revision, 3)
  assert.equal(readTreeNode(world.storage, 'target').sessionId, 'retained-session')
})
