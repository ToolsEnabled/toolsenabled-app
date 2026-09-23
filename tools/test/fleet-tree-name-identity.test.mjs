import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createFleetTreeStore, FLEET_TREE_LIMITS, nodeDisplayName, parseFleetTrees } from '../../src/fleet-trees.js'
import { roleLabel } from '../../src/fleet-tree-copy.js'

// These are ordinary Role library labels. In the engine, custom roles
// manager_5 and manager-5 both project to "Manager 5".
const labels = new Map([
  ['controller', 'Controller'], ['manager', 'Manager'], ['worker', 'Worker'],
  ['manager_5', 'Manager 5'], ['manager-5', 'Manager 5'],
  ['worker_2', 'Worker 2'], ['review-team', 'Review Team'],
])
const labelFor = role => roleLabel({ id: role, name: labels.get(role) || 'Agent' })
const nameOf = node => nodeDisplayName(node, [], { roleLabel: labelFor })

function fixture(saved = null, { roleLabel: namer = labelFor } = {}) {
  let record = saved
  let writes = 0
  let counter = 0
  const storage = {
    read: () => record,
    write: (_key, value) => { writes += 1; record = JSON.parse(JSON.stringify(value)); return true },
  }
  const store = createFleetTreeStore({
    computerId: 'test-computer', storage, roleLabel: namer,
    makeId: kind => `${kind}-${++counter}`,
    now: () => '2026-09-04T12:00:00.000Z',
  })
  return { store, saved: () => record, writes: () => writes }
}

function managers(store) {
  const root = store.addNode({ role: 'controller' }).node
  for (let index = 0; index < 5; index += 1) {
    assert.equal(store.addNode({ parentId: root.id, role: 'manager' }).ok, true)
  }
  return root
}

test('different role keys and ordinal-looking labels get different saved addresses', () => {
  const { store } = fixture()
  const root = managers(store)
  const firstCustom = store.addNode({ parentId: root.id, role: 'manager_5' }).node
  const secondCustom = store.addNode({ parentId: root.id, role: 'manager-5' }).node
  assert.equal(nameOf(firstCustom), 'Manager 5 2')
  assert.equal(nameOf(secondCustom), 'Manager 5 3')
  const names = store.snapshot().nodes.map(nameOf)
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length)
})

test('a saved custom role address remains readable when the Role library cannot be loaded', () => {
  const original = fixture()
  const node = original.store.addNode({ role: 'review-team' }).node
  const before = nameOf(node)
  const restarted = fixture(original.saved(), { roleLabel: () => null })
  assert.equal(nodeDisplayName(restarted.store.getNode(node.id), [], { roleLabel: () => 'Agent' }), before)
  assert.equal(restarted.writes(), 0, 'reading already-named nodes must not rewrite them')
})

test('legacy colliding labels migrate once without losing nodes or opening a run clock', () => {
  const legacy = fixture(null, { roleLabel: null })
  const root = managers(legacy.store)
  const custom = legacy.store.addNode({ parentId: root.id, role: 'manager_5' }).node
  legacy.store.attachSession(custom.id, 'previous-session')
  const saved = legacy.saved()
  for (const node of saved.nodes) delete node.nameBase
  const restarted = fixture(saved)
  const nodes = restarted.store.snapshot().nodes
  assert.equal(nodes.length, saved.nodes.length)
  assert.equal(new Set(nodes.map(nameOf)).size, nodes.length)
  assert.equal(restarted.store.getNode(custom.id).runStartedAt, null,
    'naming a saved node does not restart its stopped session clock')
  assert.equal(restarted.writes(), 1, 'the migration writes the forest once')
  const again = fixture(restarted.saved())
  assert.deepEqual(again.store.snapshot().nodes.map(nameOf), nodes.map(nameOf))
  assert.equal(again.writes(), 0)
})

test('removing a colliding role never renames a surviving node, including after restart', () => {
  const original = fixture()
  const root = managers(original.store)
  const custom = original.store.addNode({ parentId: root.id, role: 'manager_5' }).node
  const before = nameOf(custom)
  const ordinary = original.store.listNodes(root.treeId).find(node => node.role === 'manager' && node.nameOrdinal === 5)
  assert.equal(original.store.removeNode(ordinary.id).ok, true)
  assert.equal(nameOf(original.store.getNode(custom.id)), before)
  assert.equal(nameOf(fixture(original.saved()).store.getNode(custom.id)), before)
})

test('a move reserves retained branch names before reassigning a different-role collision', () => {
  const { store } = fixture()
  const destination = store.addNode({ role: 'controller' }).node
  store.addNode({ parentId: destination.id, role: 'worker_2' })
  const source = store.addNode({ role: 'manager' }).node
  const first = store.addNode({ parentId: source.id, role: 'worker' }).node
  const second = store.addNode({ parentId: first.id, role: 'worker' }).node
  const third = store.addNode({ parentId: first.id, role: 'worker' }).node
  assert.equal(nameOf(second), 'Worker 2')
  assert.equal(nameOf(third), 'Worker 3')
  assert.equal(store.moveNode(first.id, destination.id).ok, true)
  assert.equal(nameOf(store.getNode(third.id)), 'Worker 3')
  assert.equal(nameOf(store.getNode(second.id)), 'Worker 4')
  const names = store.listNodes(destination.treeId).map(nameOf)
  assert.equal(new Set(names).size, names.length)
})

test('draft role edits allocate against rendered names, including case-insensitive aliases', () => {
  const { store } = fixture(null, { roleLabel: role => role === 'manager_alias' ? 'MANAGER' : labelFor(role) })
  const root = store.addNode({ role: 'controller' }).node
  store.addNode({ parentId: root.id, role: 'manager' })
  const draft = store.addNode({ parentId: root.id, role: 'worker' }).node
  const edited = store.updateNode(draft.id, { role: 'manager_alias' })
  assert.equal(edited.ok, true)
  assert.equal(nameOf(edited.node), 'MANAGER 2')
})

test('a numeric old role label cannot make the next ordinal invalidate the whole saved forest', () => {
  const stamp = '2026-09-04T12:00:00.000Z'
  const record = {
    version: 1, computerId: 'test-computer',
    trees: [{ id: 'tree', name: null, createdAt: stamp, updatedAt: stamp }],
    nodes: Array.from({ length: FLEET_TREE_LIMITS.maxNodes - 1 }, (_, index) => ({
      id: `old-${index}`, treeId: 'tree', parentId: index === 0 ? null : 'old-0',
      role: 'manager', nameBase: index === 0 ? `Manager ${FLEET_TREE_LIMITS.maxNodes}` : 'Manager',
      nameOrdinal: index + 1, message: '', status: 'draft', sessionId: null,
      createdAt: stamp, updatedAt: stamp,
    })),
  }
  let written
  const store = createFleetTreeStore({
    computerId: record.computerId, roleLabel: labelFor, makeId: () => 'added-node',
    storage: { read: () => record, write: (_key, value) => { written = value; return true } },
  })
  const added = store.addNode({ parentId: 'old-1', role: 'manager' })
  assert.equal(added.ok, true)
  assert.equal(added.node.nameOrdinal, FLEET_TREE_LIMITS.maxNodes + 1)
  assert.equal(parseFleetTrees(written, { computerId: record.computerId }).nodes.length, FLEET_TREE_LIMITS.maxNodes)
})

test('the view synchronizes migrated names and their child addresses once the Role library recovers', () => {
  let available = false
  const { store } = fixture(null, { roleLabel: role => available ? labelFor(role) : null })
  const root = managers(store)
  const custom = store.addNode({ parentId: root.id, role: 'manager_5' }).node
  const child = store.addNode({ parentId: custom.id, role: 'worker' }).node
  const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  const body = /function refreshTreeNames\(syncExisting = false\) \{([\s\S]*?)\n  \}/.exec(source)
  assert.ok(body)
  /* `lastComposedNames` lives in the view's own closure and is CARRIED BETWEEN
     CALLS -- refreshTreeNames compares the names it sees now against the ones
     it saw last time, which is how a computed rename with nothing stored moving
     is noticed at all. So it is held here in the constructed function's scope,
     not passed as an argument that would be fresh on every call and would make
     "unchanged labels do not churn" below pass for the wrong reason. */
  const make = new Function('treeStore', 'orgReady', 'syncTreeBranchAddresses', 'treeNodeName', 'renamedCircles',
    'authoritativeTreeSnapshot = null',
    `let lastComposedNames = new Map()\nreturn function refreshTreeNames(syncExisting = false) {${body[1]}\n  }`)
  const updates = []
  const sync = rootId => updates.push({
    rootId, selfName: nameOf(store.getNode(custom.id)),
    managerName: nameOf(store.getNode(store.getNode(child.id).parentId)),
  })
  /* Taken out of the same source, for the same reason the body above is: this
     file deliberately never imports the view (it owns stylesheets Node cannot
     load), so the helper it calls is read from the file under test rather than
     re-implemented here, where a second copy could drift from it silently. */
  const helper = /export function renamedCircles\(previous, nodes, nameOf\) \{[^]*?\n\}/.exec(source)
  assert.ok(helper, 'renamedCircles must still be exported from the view')
  const renamedCircles = new Function(`${helper[0].replace('export function', 'function')}\nreturn renamedCircles`)()

  available = true
  const refresh = make(store, () => available, sync, nameOf, renamedCircles)
  refresh(false)
  assert.deepEqual(updates, [{ rootId: root.id, selfName: 'Manager 5 2', managerName: 'Manager 5 2' }])
  refresh(false)
  assert.equal(updates.length, 1, 'unchanged labels do not churn the live directory')
  refresh(true)
  assert.equal(updates.length, 2, 'a route reopen synchronizes still-owned sessions after constructor migration')
})


test('a moved branch carries every owned session name, manager and saved ancestry to the host', async () => {
  const { store } = fixture(null, { roleLabel: labelFor })
  const oldRoot = store.addNode({ role: 'manager' }).node
  const branch = store.addNode({ parentId: oldRoot.id, role: 'worker' }).node
  const child = store.addNode({ parentId: branch.id, role: 'worker' }).node
  const newRoot = store.addNode({ role: 'manager' }).node
  store.attachSession(branch.id, 'branch-session')
  store.attachSession(child.id, 'child-session')
  assert.equal(store.moveNode(branch.id, newRoot.id).ok, true)
  const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  const names = ['treeAnchorsFor', 'nodeRequestKeys', 'nodeTreeIdentity', 'treeBranchNodeIds', 'syncTreeBranchAddresses']
  const functions = names.map(name => {
    const match = new RegExp('  (?:async )?function ' + name + '\\([^]*?\\n  \\}').exec(source)
    assert.ok(match, name)
    return match[0]
  }).join('\n')
  const calls = []
  const run = new Function('treeStore', 'treeNodeName', 'sessionNodeIds', 'treeAddressSyncs', 'window', 'setOrgStatus', 'MOVE_PANEL',
    functions + '\nreturn syncTreeBranchAddresses')
  const sync = run(store, nameOf, new Map([['branch-session', branch.id], ['child-session', child.id]]), new Map(),
    { mcAgent: { updateTreeAddress: request => { calls.push(request); return { ok: true } } } }, () => {}, {})
  assert.deepEqual(await sync(branch.id), { ok: true, updated: 2 })
  assert.deepEqual(calls, [
    { sessionId: 'branch-session', selfName: nameOf(store.getNode(branch.id)), managerName: nameOf(newRoot), treeKey: newRoot.id,
      requestKeys: { treeAnchors: [newRoot.id, branch.id], threadId: branch.id } },
    { sessionId: 'child-session', selfName: nameOf(store.getNode(child.id)), managerName: nameOf(store.getNode(branch.id)), treeKey: newRoot.id,
      requestKeys: { treeAnchors: [newRoot.id, branch.id, child.id], threadId: child.id } },
  ])
})

// Execute the actual module/view queue declarations and address functions.
// Two separately constructed views must share the same run-scoped custody.
function addressViews() {
  const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  const moduleDeclarations = ['RUN_SESSION_NODES', 'RUN_TREE_ADDRESS_SYNCS'].flatMap(name => {
    const match = new RegExp(`^const ${name} = .*`, 'm').exec(source)
    return match ? [match[0]] : []
  })
  const names = moduleDeclarations.map(line => /^const (\w+)/.exec(line)[1])
  const shared = new Function(moduleDeclarations.join('\n') + `\nreturn {${names.join(',')}}`)()
  const queue = /  const treeAddressSyncs = [^\n]+/.exec(source)
  assert.ok(queue)
  const functions = ['treeAnchorsFor', 'nodeRequestKeys', 'nodeTreeIdentity', 'treeBranchNodeIds', 'syncTreeBranchAddresses']
    .map(name => {
      const found = new RegExp('  (?:async )?function ' + name + '\\([^]*?\\n  \\}').exec(source)
      assert.ok(found, name)
      return found[0]
    }).join('\n')
  const create = new Function(...names, 'treeStore', 'treeNodeName', 'window', 'setOrgStatus', 'MOVE_PANEL',
    'const sessionNodeIds = RUN_SESSION_NODES;\n' + queue[0] + '\n' + functions
      + '\nreturn {sync:syncTreeBranchAddresses, queue:treeAddressSyncs}')
  return { sessions: shared.RUN_SESSION_NODES,
    create: (store, bridge) => create(...names.map(name => shared[name]), store, nameOf,
      { mcAgent: bridge }, () => {}, { addressNotUpdated: count => `${count} updates failed` }) }
}

for (const firstFails of [false, true]) {
  test(`address updates remain ordered after navigation when the old acknowledgement ${firstFails ? 'fails' : 'succeeds'}`, async () => {
    const original = fixture()
    const parents = Array.from({ length: 4 }, () => original.store.addNode({ role: 'manager' }).node)
    const child = original.store.addNode({ parentId: parents[0].id, role: 'worker' }).node
    original.store.attachSession(child.id, 'retained-session')
    const views = addressViews()
    views.sessions.set('retained-session', child.id)
    const calls = []
    let release, reject
    const acknowledgement = new Promise((yes, no) => { release = yes; reject = no })
    const bridge = { updateTreeAddress: request => {
      calls.push(request)
      return calls.length === 1 ? acknowledgement : Promise.resolve({ ok: true })
    } }
    const oldView = views.create(original.store, bridge)
    original.store.moveNode(child.id, parents[1].id)
    const moveB = oldView.sync(child.id)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls.length, 1)
    original.store.moveNode(child.id, parents[2].id)
    const moveC = oldView.sync(child.id)
    // The old view is gone, but its already accepted directory writes remain.
    const reopened = fixture(original.saved())
    const newView = views.create(reopened.store, bridge)
    reopened.store.moveNode(child.id, parents[3].id)
    const moveD = newView.sync(child.id)
    await new Promise(resolve => setImmediate(resolve))
    if (firstFails) reject(new Error('The first acknowledgement failed'))
    else release({ ok: true })
    const outcomes = await Promise.all([moveB, moveC, moveD])
    assert.deepEqual(outcomes.map(value => value.ok), [!firstFails, true, true])
    assert.equal(calls.at(-1).treeKey, parents[3].id,
      'a destroyed view overwrote the newer saved parent with its old queued move')
    assert.deepEqual(calls.map(value => value.treeKey), parents.slice(1).map(node => node.id))
    assert.equal(reopened.store.getNode(child.id).parentId, parents[3].id)
    assert.equal(oldView.queue.size, 0)
    assert.equal(newView.queue.size, 0)
  })
}

/* T211: THE MANAGER POINTER A RELOAD FROZE AT ITS SPAWN VALUE.
 *
 * syncTreeBranchAddresses can only correct a session THIS RUN OWNS -- it skips
 * any node whose sessionNodeIds entry is missing. A renderer reload empties that
 * map while the host keeps those sessions running, and it is refilled only after
 * an awaited per-session round trip. A drag onto a new manager inside that
 * window therefore saved the canvas, found nothing to tell, and returned
 * `{ ok: true, updated: 0 }`: no directory write, and no warning either, because
 * "no session to update" and "nothing needed updating" are the same answer.
 * The directory row kept the manager the circle registered with at spawn.
 *
 * finishedSavedSessionSweep re-asserts the saved tree from every root once the
 * sweep has filled the map, which is the only moment the correction can be made.
 * Both halves are driven here from the real view source. */
function sweepHarness() {
  const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  const names = ['treeAnchorsFor', 'nodeRequestKeys', 'nodeTreeIdentity', 'treeBranchNodeIds',
    'syncTreeBranchAddresses', 'finishedSavedSessionSweep']
  const functions = names.map(name => {
    const match = new RegExp('  (?:async )?function ' + name + '\\([^]*?\\n  \\}').exec(source)
    assert.ok(match, name)
    return match[0]
  }).join('\n')
  /* `destroyed` and `refreshTree` are the view's own repaint guard: freeing a
     seat that the canvas is never told about leaves the "+" withdrawn on
     screen, which is the defect measured on a private candidate. The repaint
     is counted here so removing it fails this suite. */
  return new Function('treeStore', 'treeNodeName', 'sessionNodeIds', 'treeAddressSyncs', 'window',
    'setOrgStatus', 'MOVE_PANEL', 'reconnectingStores', 'repaints',
    'let runSessionSweepDone = false;\n'
      + 'const destroyed = false;\n'
      + 'const refreshTree = () => { repaints.push(1) };\n' + functions
      + '\nreturn { sync: syncTreeBranchAddresses, swept: finishedSavedSessionSweep,'
      + ' evidenceReady: () => runSessionSweepDone }')
}

test('a move made before the saved-session sweep lands still reaches the directory', async () => {
  const { store } = fixture()
  const oldManager = store.addNode({ role: 'manager' }).node
  const newManager = store.addNode({ role: 'manager' }).node
  const child = store.addNode({ parentId: oldManager.id, role: 'worker' }).node
  store.attachSession(child.id, 'child-session')

  const calls = []
  const warnings = []
  // The reload state: the session is alive on the host, and this run owns
  // nothing yet because the sweep has not answered.
  const owned = new Map()
  const repaints = []
  const view = sweepHarness()(store, nameOf, owned, new Map(),
    { mcAgent: { updateTreeAddress: request => { calls.push(request); return { ok: true } } } },
    (...args) => warnings.push(args), { addressNotUpdated: count => `${count} updates failed` },
    new WeakSet(), repaints)

  assert.equal(store.moveNode(child.id, newManager.id).ok, true)
  assert.deepEqual(await view.sync(child.id), { ok: true, updated: 0 },
    'with no owned session there is nothing the move can correct')
  assert.deepEqual(calls, [], 'and nothing was written to the directory')
  assert.deepEqual(warnings, [], 'and the person was told nothing, which is why this must not be the end of it')
  assert.equal(view.evidenceReady(), false)

  // The sweep answers: the host still owns this session, so the map fills.
  owned.set('child-session', child.id)
  view.swept(store)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(view.evidenceReady(), true)
  assert.deepEqual(calls.map(call => ({ sessionId: call.sessionId, managerName: call.managerName })),
    [{ sessionId: 'child-session', managerName: nameOf(newManager) }],
    'the circle must end up under the manager the person dragged it to, not the one it spawned under')
  /* The seat the sweep just freed has to reach the canvas. Without this the
     "+" under a parent whose children died with the app stays withdrawn until
     something else repaints, which is what the candidate showed. */
  assert.deepEqual(repaints, [1], 'a settled sweep must repaint the tree exactly once')
})

test('a sweep over a forest that did not move writes no new address', async () => {
  const { store } = fixture()
  const manager = store.addNode({ role: 'manager' }).node
  const child = store.addNode({ parentId: manager.id, role: 'worker' }).node
  store.attachSession(child.id, 'settled-session')

  const calls = []
  const repaints = []
  const view = sweepHarness()(store, nameOf, new Map([['settled-session', child.id]]), new Map(),
    { mcAgent: { updateTreeAddress: request => { calls.push(request); return { ok: true } } } },
    () => {}, { addressNotUpdated: count => `${count} updates failed` }, new WeakSet(), repaints)

  view.swept(store)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.map(call => ({ sessionId: call.sessionId, managerName: call.managerName })),
    [{ sessionId: 'settled-session', managerName: nameOf(manager) }],
    'the sweep re-asserts the saved tree; the host coalesces an address that has not moved')
})
