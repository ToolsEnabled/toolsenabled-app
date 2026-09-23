import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'

/* THE NAME A CIRCLE IS REGISTERED UNDER IS THE NAME IT CAN BE MESSAGED BY.
 *
 * THE DEFECT, measured 2026-09-16 03:47Z-05:05Z and filed as T138: circles
 * started through `agent.spawn` with surface "tree" all took the bare role word
 * -- four "Manager" and sixteen "Worker" on one computer. Every one of those
 * strings travels straight into the message directory: src/views/computers.js
 * nodeTreeIdentity() composes { selfName, managerName } from treeNodeName(),
 * shell/agent-host.cjs registerNode()s exactly those, and
 * agent_comms.local_roster then had nothing but a heartbeat to tell the rows
 * apart. send_local to "Manager" answered TREE_RECIPIENT_AMBIGUOUS. No manager
 * could address its own workers and the Controller could not address its
 * managers.
 *
 * THE CAUSE WAS A SECOND COPY OF THE NAMING RULE. treeNodeName() answered
 * `node.nameBase` -- the role label WITHOUT its ordinal -- before ever reaching
 * nodeDisplayName(), whenever the store had a base recorded, which is whenever
 * the role library had resolved at the moment the circle was added. Both halves
 * of the shipped rule were discarded: the per-tree ordinal ("Manager 2") and
 * the cross-tree id suffix ("Manager (5ef0084f)").
 *
 * THESE TESTS CALL THE REAL RULE WITH REAL STORE RECORDS. They assert that
 * names are DISTINCT and that each one resolves back to the circle it belongs
 * to -- never that a particular string is produced. A spelling pin here would
 * go red against a better naming scheme, and the quickest way back to green
 * would be to reinstate the collision this file exists to stop.
 */

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`), import.meta.url)

const { circleName, renamedCircles, namingSignature } = await import('../../src/views/computers.js')
const { createFleetTreeStore } = await import('../../src/fleet-trees.js')

const LABELS = new Map([['controller', 'Controller'], ['manager', 'Manager'], ['worker', 'Worker']])
const labelFor = role => LABELS.get(role) || 'Agent'

/* A REAL STORE, WITH roleLabel WIRED. That is the condition the defect needed:
   the store records `nameBase` only when the role library answers, and it is
   the recorded `nameBase` that the removed short-circuit used to return. A
   fixture without roleLabel would have been green throughout. */
function storeFixture() {
  let record = null
  let counter = 0
  const storage = { read: () => record, write: (_key, value) => { record = JSON.parse(JSON.stringify(value)); return true } }
  return createFleetTreeStore({
    computerId: 't138-circle-name',
    storage,
    roleLabel: labelFor,
    makeId: kind => `${kind}-${++counter}-${String(counter).padStart(8, 'a')}`,
    now: () => '2026-09-16T05:06:00.000Z',
  })
}

const nameOf = (store, node) => circleName(store.getNode(node.id), store.snapshot().nodes, labelFor)

test('the store really does record a name base, so the fixture exercises the defect', () => {
  const store = storeFixture()
  const root = store.addNode({ role: 'controller' }).node
  assert.equal(store.getNode(root.id).nameBase, 'Controller',
    'without a recorded base the short-circuit this file guards would never have fired')
})

test('four managers spawned under one controller are four different names', () => {
  const store = storeFixture()
  const root = store.addNode({ role: 'controller' }).node
  const managers = [0, 1, 2, 3].map(() => store.addNode({ parentId: root.id, role: 'manager' }).node)

  const names = managers.map(node => nameOf(store, node))

  assert.equal(new Set(names).size, managers.length,
    `every circle a manager has to address needs its own name: ${JSON.stringify(names)}`)
  for (const name of names) assert.ok(name.trim(), 'a circle must not register under an empty name')
})

test('sixteen workers under one manager are sixteen different names', () => {
  const store = storeFixture()
  const root = store.addNode({ role: 'controller' }).node
  const manager = store.addNode({ parentId: root.id, role: 'manager' }).node
  const workers = Array.from({ length: 16 }, () => store.addNode({ parentId: manager.id, role: 'worker' }).node)

  const names = workers.map(node => nameOf(store, node))

  assert.equal(new Set(names).size, 16, `sixteen workers must not share names: ${JSON.stringify(names)}`)
})

test('the first circles of two separate trees do not answer to the same name', () => {
  const store = storeFixture()
  const rootA = store.addNode({ role: 'controller' }).node
  const firstA = store.addNode({ parentId: rootA.id, role: 'manager' }).node
  const rootB = store.addNode({ role: 'controller' }).node
  const firstB = store.addNode({ parentId: rootB.id, role: 'manager' }).node

  assert.notEqual(rootA.treeId, rootB.treeId, 'the fixture must really hold two trees')
  assert.notEqual(nameOf(store, firstA), nameOf(store, firstB),
    'per-tree ordinals both start at one, so the surface has to separate them')
  assert.notEqual(nameOf(store, rootA), nameOf(store, rootB),
    'two trees each with a top circle must not both register as "Controller"')
})

test('every circle on the computer carries a name that identifies only itself', () => {
  const store = storeFixture()
  const rootA = store.addNode({ role: 'controller' }).node
  const managerA = store.addNode({ parentId: rootA.id, role: 'manager' }).node
  const rootB = store.addNode({ role: 'controller' }).node
  const managerB = store.addNode({ parentId: rootB.id, role: 'manager' }).node
  for (const parent of [managerA, managerB]) {
    for (let index = 0; index < 3; index += 1) store.addNode({ parentId: parent.id, role: 'worker' })
  }

  const all = store.snapshot().nodes
  const byName = new Map()
  for (const node of all) {
    const name = circleName(node, all, labelFor)
    byName.set(name, [...(byName.get(name) || []), node.id])
  }

  const collisions = [...byName].filter(([, ids]) => ids.length > 1)
  assert.deepEqual(collisions, [], `a name that fits two circles cannot be delivered to: ${JSON.stringify(collisions)}`)
  assert.equal(byName.size, all.length, 'each circle must be identified by exactly one name')
})

test('a name survives a sibling being added after it', () => {
  const store = storeFixture()
  const root = store.addNode({ role: 'controller' }).node
  const first = store.addNode({ parentId: root.id, role: 'manager' }).node
  const before = nameOf(store, first)

  store.addNode({ parentId: root.id, role: 'manager' })

  assert.equal(nameOf(store, first), before,
    'a circle already registered under a name must not be renamed by a later spawn, or its registered row goes stale')
})

test('the read-only desktop-tree view keeps the name that snapshot already composed', () => {
  /* desktopTreeComputer() puts a composed `name` on every row it projects, and
     that projection is the authority for that surface. It is the branch the
     native-tree adapter needs and it stays. */
  assert.equal(circleName({ id: 'node-1', name: 'Manager 7', role: 'manager', nameBase: 'Manager', nameOrdinal: 1 }, [], labelFor), 'Manager 7')
  assert.equal(circleName({ id: 'node-1', name: '   ', role: 'manager', nameBase: 'Manager', nameOrdinal: 2 }, [], labelFor), 'Manager 2',
    'a blank projected name is not a name and must fall through to the rule')
})

test('a missing pool and a missing node are answered without throwing', () => {
  assert.equal(circleName({ id: 'node-1', role: 'manager', nameOrdinal: 1 }, undefined, labelFor), 'Manager')
  assert.equal(typeof circleName(null, [], labelFor), 'string')
})

/* ---------------------------------------------------------------------------
 * AND THE NAME A RUNNING CIRCLE IS REGISTERED UNDER HAS TO FOLLOW IT.
 *
 * Half the rule is stored (nameBase, the per-tree ordinal) and the store
 * reports when it changes them. The cross-tree half is computed and reports
 * nothing: a second tree renames the first tree's top circle with no stored
 * record moving at all. A circle already registered in the message directory
 * would keep the old name while everything briefed afterwards is told the new
 * one -- so the view has to notice the computed move itself. renamedCircles()
 * is that decision, and these drive it with real store records.
 */

test('a second tree renames the first tree\'s circles, and that is reported', () => {
  const store = storeFixture()
  const rootA = store.addNode({ role: 'controller' }).node
  const managerA = store.addNode({ parentId: rootA.id, role: 'manager' }).node
  const nameOf = node => circleName(node, store.snapshot().nodes, labelFor)

  const first = renamedCircles(new Map(), store.snapshot().nodes, nameOf)
  assert.deepEqual(first.moved, [], 'a first sighting is not a rename')

  const rootB = store.addNode({ role: 'controller' }).node

  const second = renamedCircles(first.names, store.snapshot().nodes, nameOf)
  assert.ok(second.moved.includes(rootA.id),
    `the first tree's top circle answers to a new name and nobody was told: ${JSON.stringify([...second.names])}`)
  assert.notEqual(second.names.get(rootA.id), first.names.get(rootA.id))
  /* Only the circle whose label actually collided moved. The manager below it
     did not -- nothing in the new tree is called "Manager" yet -- and that is
     the right answer: what went stale for the manager is its MANAGER's name,
     and the sync this drives re-registers whole branches from every root for
     exactly that reason. */
  assert.deepEqual(second.moved, [rootA.id])

  const managerB = store.addNode({ parentId: rootB.id, role: 'manager' }).node
  const third = renamedCircles(second.names, store.snapshot().nodes, nameOf)
  assert.ok(third.moved.includes(managerA.id),
    `now a second "Manager" exists, the first one answers to a new name too: ${JSON.stringify([...third.names])}`)
  assert.notEqual(third.names.get(managerA.id), third.names.get(managerB.id))
})

test('a quiet redraw reports nothing, so an unchanged tree is never re-registered', () => {
  const store = storeFixture()
  const root = store.addNode({ role: 'controller' }).node
  store.addNode({ parentId: root.id, role: 'manager' })
  const nameOf = node => circleName(node, store.snapshot().nodes, labelFor)

  const first = renamedCircles(new Map(), store.snapshot().nodes, nameOf)
  const again = renamedCircles(first.names, store.snapshot().nodes, nameOf)

  assert.deepEqual(again.moved, [], 'nothing changed, so nothing may be re-registered')
  assert.deepEqual([...again.names], [...first.names], 'and the record it keeps is the same one')
})

test('adding a sibling does not rename the circles already running beside it', () => {
  const store = storeFixture()
  const root = store.addNode({ role: 'controller' }).node
  const first = store.addNode({ parentId: root.id, role: 'manager' }).node
  const nameOf = node => circleName(node, store.snapshot().nodes, labelFor)
  const before = renamedCircles(new Map(), store.snapshot().nodes, nameOf)

  const sibling = store.addNode({ parentId: root.id, role: 'manager' }).node

  const after = renamedCircles(before.names, store.snapshot().nodes, nameOf)
  assert.deepEqual(after.moved, [],
    'the per-tree ordinal is assigned to the NEW circle, so its elders keep the names their directory rows hold')
  assert.notEqual(after.names.get(first.id), after.names.get(sibling.id))
})

test('a circle that has gone drops out of the record instead of being remembered forever', () => {
  const store = storeFixture()
  const root = store.addNode({ role: 'controller' }).node
  const doomed = store.addNode({ parentId: root.id, role: 'manager' }).node
  const nameOf = node => circleName(node, store.snapshot().nodes, labelFor)
  const before = renamedCircles(new Map(), store.snapshot().nodes, nameOf)
  assert.ok(before.names.has(doomed.id))

  const remaining = store.snapshot().nodes.filter(node => node.id !== doomed.id)
  const after = renamedCircles(before.names, remaining, nameOf)

  assert.equal(after.names.has(doomed.id), false)
  assert.deepEqual(after.moved, [])
})

/* ---------------------------------------------------------------------------
 * AND THE WATCH IS ON THE STORE, NOT ON THE PRESSES.
 *
 * A computed rename can be caused by ANY accepted change that adds a root, and
 * this page has more than one door to that: the compose panel, an editor copy
 * (src/editor-attachment-drafts.js install() adds with no parent), and adopting
 * a standalone agent as a new root (src/tree-standalone-placement.js
 * placeStandaloneAgent, whose parentId defaults to null). Hooking the doors one
 * at a time is how the next door gets missed -- a reviewer found two that had
 * been. Every accepted mutation publishes (accept() -> commit() -> publish() in
 * src/fleet-trees.js), so the subscriber is the one place that cannot be walked
 * around, and this drives the real function out of the real file.
 */

const VIEW_SOURCE = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')

function syncRenamedCirclesFrom(store, onSyncRoot) {
  const body = /function syncRenamedCircles\(snapshot\) \{([\s\S]*?)\n  \}/.exec(VIEW_SOURCE)
  assert.ok(body, 'syncRenamedCircles must still be in the view')
  const make = new Function('treeStore', 'treeNodeName', 'renamedCircles', 'namingSignature', 'syncTreeBranchAddresses',
    'authoritativeTreeSnapshot = null',
    `let lastComposedNames = new Map()\nlet lastNamingSignature = null\nreturn function syncRenamedCircles(snapshot) {${body[1]}\n  }`)
  return make(store, node => circleName(node, store.snapshot().nodes, labelFor), renamedCircles, namingSignature, onSyncRoot)
}

test('a change that renames an already-registered circle asks for a re-registration', () => {
  const store = storeFixture()
  const rootA = store.addNode({ role: 'controller' }).node
  store.addNode({ parentId: rootA.id, role: 'manager' })
  const synced = []
  const watch = syncRenamedCirclesFrom(store, rootId => synced.push(rootId))

  watch(store.snapshot())
  assert.deepEqual(synced, [], 'a first sighting renames nobody, so nothing is re-registered')

  /* The door the compose panel uses, and the two it does not. */
  const rootB = store.addNode({ role: 'controller' }).node
  watch(store.snapshot())
  assert.deepEqual(synced, [rootA.id, rootB.id],
    'the first tree top circle now reads differently, so every root branch is re-registered')
})

test('an ordinary change that renames nobody never touches the directory', () => {
  const store = storeFixture()
  const root = store.addNode({ role: 'controller' }).node
  const manager = store.addNode({ parentId: root.id, role: 'manager' }).node
  const synced = []
  const watch = syncRenamedCirclesFrom(store, rootId => synced.push(rootId))
  watch(store.snapshot())

  store.addNode({ parentId: manager.id, role: 'worker' })
  watch(store.snapshot())
  store.setNodeStatus(manager.id, 'running')
  watch(store.snapshot())

  assert.deepEqual(synced, [],
    'a new child and a status change rename nobody, and a directory write on every publish would be a repair loop')
})

test('the store watch does not repair stored names, because a write inside a publish is a loop', () => {
  /* refreshNodeNames() REPAIRS records and is a write. syncRenamedCircles runs
     from inside the store's own publish, so it must only read. */
  const body = /function syncRenamedCircles\(snapshot\) \{([\s\S]*?)\n  \}/.exec(VIEW_SOURCE)
  assert.ok(body)
  let repaired = 0
  const store = storeFixture()
  const root = store.addNode({ role: 'controller' }).node
  store.addNode({ parentId: root.id, role: 'manager' })
  const watched = {
    snapshot: () => store.snapshot(),
    refreshNodeNames: () => { repaired += 1; return store.refreshNodeNames() },
  }
  const make = new Function('treeStore', 'treeNodeName', 'renamedCircles', 'namingSignature', 'syncTreeBranchAddresses',
    'authoritativeTreeSnapshot = null',
    `let lastComposedNames = new Map()\nlet lastNamingSignature = null\nreturn function syncRenamedCircles(snapshot) {${body[1]}\n  }`)
  const watch = make(watched, node => circleName(node, store.snapshot().nodes, labelFor), renamedCircles, namingSignature, () => {})
  watch(store.snapshot())
  store.addNode({ role: 'controller' })
  watch(store.snapshot())
  assert.equal(repaired, 0, 'the store watch must not call the repair, which writes')
})

/* ---------------------------------------------------------------------------
 * AND THE WATCH IS CHEAP ON THE CHANGES THAT CANNOT RENAME ANYTHING.
 *
 * Composing one circle's name is itself a scan of the pool -- nodeDisplayName()
 * has to look at every peer to know whether the label collides -- so naming the
 * whole pool is quadratic. Measured on this store: 50 circles 2.5 ms, 200
 * circles 2.3 ms, 800 circles 14.7 ms per accepted change, against a
 * FLEET_TREE_LIMITS.maxNodes of 4096. The store publishes on EVERY accepted
 * change, most of which -- a status, a reply, a run-clock tick -- cannot rename
 * anybody. namingSignature() is what lets those changes cost one pass.
 */

test('a status change cannot rename anybody, so the naming signature does not move', () => {
  const store = storeFixture()
  const root = store.addNode({ role: 'controller' }).node
  const manager = store.addNode({ parentId: root.id, role: 'manager' }).node
  const before = namingSignature(store.snapshot().nodes)

  store.setNodeStatus(manager.id, 'running')

  assert.equal(namingSignature(store.snapshot().nodes), before,
    'a status is not part of a name, and paying the whole naming scan for one would be the cost this guard exists to avoid')
})

test('adding a circle moves the signature, because adding a circle is what renames people', () => {
  const store = storeFixture()
  const root = store.addNode({ role: 'controller' }).node
  const before = namingSignature(store.snapshot().nodes)

  store.addNode({ parentId: root.id, role: 'manager' })

  assert.notEqual(namingSignature(store.snapshot().nodes), before)
})

test('a second tree moves the signature, which is the case the watch exists for', () => {
  const store = storeFixture()
  store.addNode({ role: 'controller' })
  const before = namingSignature(store.snapshot().nodes)

  store.addNode({ role: 'controller' })

  assert.notEqual(namingSignature(store.snapshot().nodes), before)
})

test('the signature reads every field a name is composed from, and separates circles', () => {
  /* If this list ever falls behind the naming rule the symptom is a missed
     re-registration, so it is checked by value rather than by reading it. */
  const one = { id: 'node-1', treeId: 'tree-1', role: 'manager', nameBase: 'Manager', nameOrdinal: 1 }
  for (const [field, value] of [['treeId', 'tree-2'], ['role', 'worker'], ['nameBase', 'Lead'], ['nameOrdinal', 2], ['id', 'node-2']]) {
    assert.notEqual(namingSignature([{ ...one, [field]: value }]), namingSignature([one]),
      `${field} changes a composed name, so it must change the signature`)
  }
  for (const [field, value] of [['status', 'running'], ['message', 'do the thing'], ['sessionId', 's-1'], ['runMs', 900]]) {
    assert.equal(namingSignature([{ ...one, [field]: value }]), namingSignature([one]),
      `${field} cannot change a composed name, so it must not force the scan`)
  }
  assert.notEqual(namingSignature([one, { ...one, id: 'node-2' }]), namingSignature([one]),
    'two circles are not one circle')
})

test('the store watch skips the scan when nothing a name is made of has moved', () => {
  const store = storeFixture()
  const root = store.addNode({ role: 'controller' }).node
  const manager = store.addNode({ parentId: root.id, role: 'manager' }).node
  let composed = 0
  const body = /function syncRenamedCircles\(snapshot\) \{([\s\S]*?)\n  \}/.exec(VIEW_SOURCE)
  const make = new Function('treeStore', 'treeNodeName', 'renamedCircles', 'namingSignature', 'syncTreeBranchAddresses',
    'authoritativeTreeSnapshot = null',
    `let lastComposedNames = new Map()\nlet lastNamingSignature = null\nreturn function syncRenamedCircles(snapshot) {${body[1]}\n  }`)
  const watch = make(store, node => { composed += 1; return circleName(node, store.snapshot().nodes, labelFor) },
    renamedCircles, namingSignature, () => {})

  watch(store.snapshot())
  const afterFirst = composed
  assert.ok(afterFirst > 0, 'the first sighting must compose the names it is going to compare against')

  store.setNodeStatus(manager.id, 'running')
  watch(store.snapshot())
  store.setNodeStatus(manager.id, 'finished')
  watch(store.snapshot())

  assert.equal(composed, afterFirst,
    'two status changes composed no names at all, or every accepted change on a large tree pays a quadratic scan')

  store.addNode({ role: 'controller' })
  watch(store.snapshot())
  assert.ok(composed > afterFirst, 'and a change that CAN rename somebody still pays for the answer')
})
