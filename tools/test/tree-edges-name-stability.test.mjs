// Lane 1-3 (tree-edges), part (a): the drawn name (src/fleet-trees.js
// nodeDisplayName), the tree-address name (src/tree-node-brief.js
// composeNodeBrief / readTreeAddress) and the name a circle registers under
// (shell/agent-host.cjs reads this same address line -- see
// tree-address-contract.test.mjs for that half of the seam) must be the SAME
// string for a circle's whole life, including for the FIRST circle of a role
// after a SECOND one is created.
//
// THE DEFECT THIS GUARDS, measured by the second tree (m1-REPORT-ready.md 1a
// to 1c, 6c): Manager 1 was registered "Manager", its workers were bound to
// "Manager 1" (TREE_MANAGER_UNREGISTERED), and every send from it was refused
// TREE_RECIPIENT_NOT_CONNECTED. The cause was a display name recomputed from
// a same-role sibling COUNT at read time, so a circle's own name moved under
// it the moment a second circle of the same role was created. App commit
// bd80beb ("keep circle names stable for their lifetime") froze the ordinal
// at addNode() time instead (src/fleet-trees.js nameOrdinal); this test
// proves the fix holds all the way to the sentence a session is actually
// told, not only inside the store.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFleetTreeStore, nodeDisplayName } from '../../src/fleet-trees.js'
import { composeNodeBrief, readTreeAddress } from '../../src/tree-node-brief.js'

function memoryStorage() {
  const cells = new Map()
  return {
    read(key) { return cells.has(key) ? JSON.parse(cells.get(key)) : null },
    write(key, value) { cells.set(key, JSON.stringify(value)); return true },
  }
}

function counterIds() {
  let count = 0
  return kind => { count += 1; return `${kind}-${count}` }
}

function stamps() {
  let tick = 0
  return () => { tick += 1; return `2026-09-03T00:00:${String(tick).padStart(2, '0')}.000Z` }
}

function storeOf() {
  return createFleetTreeStore({
    computerId: 'c1',
    storage: memoryStorage(),
    now: stamps(),
    makeId: counterIds(),
  })
}

// What src/views/computers.js's briefContextFor() does for a real node: the
// drawn name for the node itself and, when it has one, for its parent, using
// the same peer list every read of the tree sees.
function addressFor(store, node, parent) {
  const peers = store.snapshot().nodes
  const selfName = nodeDisplayName(node, peers)
  const parentName = parent ? nodeDisplayName(parent, peers) : null
  const brief = composeNodeBrief({ message: 'Take the lane.', selfName, parentName })
  return { selfName, parentName, brief, addressRead: readTreeAddress(brief) }
}

test('the first Manager keeps one name across its whole life, including after a second Manager is created', () => {
  const store = storeOf()
  const controller = store.addNode({ role: 'Controller' }).node

  const managerA = store.addNode({ parentId: controller.id, role: 'Manager' }).node
  assert.equal(managerA.nameOrdinal, 1)

  // Manager A is addressed and briefed FIRST, while it is the only Manager.
  const beforeSecond = addressFor(store, managerA, controller)
  assert.equal(beforeSecond.selfName, 'Manager')
  assert.equal(beforeSecond.addressRead.selfName, 'Manager',
    'the tree-address line must name the circle exactly what the canvas draws')
  assert.equal(beforeSecond.addressRead.parentName, 'Controller')

  // A SECOND Manager joins the same tree under the same Controller.
  const managerB = store.addNode({ parentId: controller.id, role: 'Manager' }).node
  assert.equal(managerB.nameOrdinal, 2)
  assert.equal(nodeDisplayName(managerB, store.snapshot().nodes), 'Manager 2')

  // Manager A's drawn name and its tree-address line must be unchanged: it is
  // still the FIRST Manager and it is still just "Manager", not "Manager 1".
  const afterSecond = addressFor(store, managerA, controller)
  assert.equal(afterSecond.selfName, 'Manager',
    'the first Manager\'s drawn name moved when a second Manager was created')
  assert.equal(afterSecond.addressRead.selfName, 'Manager',
    'the first Manager\'s tree-address line moved when a second Manager was created')
  assert.equal(afterSecond.selfName, beforeSecond.selfName,
    'the drawn name is not one string for the circle\'s whole life')

  // Now start Manager A's own worker, AFTER the second Manager already exists.
  // The worker's brief must name its manager "Manager" -- the frozen name --
  // never "Manager 1" invented because a sibling now exists.
  const workerUnderA = store.addNode({ parentId: managerA.id, role: 'Worker' }).node
  const workerBrief = addressFor(store, workerUnderA, managerA)
  assert.equal(workerBrief.selfName, 'Worker')
  assert.equal(workerBrief.addressRead.parentName, 'Manager',
    'a worker started after a same-role sibling appeared was told the wrong manager name')
})

// A blank role -- "no particular role chosen" -- is the ordinary case for a
// circle started on its own (src/tree-resume-decision.js's sibling module,
// DEFAULT_TREE_IDENTITY_ROLE's own header: "Leaving it blank must continue to
// mean 'no particular role' to the person"). nodeDisplayName's own header
// calls a circle's name "an identity, not its homework" and draws no
// exception for role === ''. THE DEFECT this test found: the reader refused
// to let a blank-role node carry a nameOrdinal at all
// (`role === '' && nameOrdinal !== null` in src/fleet-trees.js), so every
// blank-role circle was permanently stuck on nodeDisplayName's OTHER branch --
// a live count of same-tree, same-role peers, taken fresh on every call. That
// is exactly the pre-nameOrdinal defect this file's own test above (and app
// commit bd80beb) exists to have retired, left standing for the one role
// value ordinals were withheld from. A first blank-role circle registers and
// is briefed as "Agent"; a second one joining the SAME TREE (anywhere in it --
// this pool is not scoped to siblings under one parent) silently renames the
// first to "Agent 1" the moment anything re-asks its name, and any child
// whose OWN brief still says "Agent" answers TREE_MANAGER_UNREGISTERED to a
// manager that never stopped running.
test('a blank-role circle keeps one name across its whole life, including after a second blank-role circle joins the same tree', () => {
  const store = storeOf()
  const controller = store.addNode({ role: 'Controller' }).node
  // A generic, non-empty stand-in for the real product's roleLabel(''), so
  // the drawn name is not itself an empty string -- the point under test is
  // ordinal stability, not what word a blank role happens to draw as.
  const roleLabel = role => (role ? role : 'Agent')
  const nameOf = (node, peers) => nodeDisplayName(node, peers, { roleLabel })

  const first = store.addNode({ parentId: controller.id, role: '' }).node
  assert.equal(nameOf(first, store.snapshot().nodes), 'Agent',
    'the only blank-role circle on this tree should draw bare, like any other first-of-its-kind')

  // A SECOND blank-role circle joins the same tree -- nodeDisplayName's peer
  // pool is (treeId, role) alone, so this need not even be a sibling of the
  // first one under the same parent.
  const second = store.addNode({ parentId: controller.id, role: '' }).node
  assert.notEqual(first.id, second.id)

  const afterSecond = nameOf(first, store.snapshot().nodes)
  assert.equal(afterSecond, 'Agent',
    'the first blank-role circle\'s drawn name moved when a second one joined the tree')

  // Start a worker under the FIRST circle only after the second one already
  // exists. Its brief must name its manager the frozen name, never a name
  // invented because a same-tree blank-role peer now exists elsewhere.
  const workerUnderFirst = store.addNode({ parentId: first.id, role: 'Worker' }).node
  const peers = store.snapshot().nodes
  const brief = composeNodeBrief({
    message: 'Take the lane.',
    selfName: nameOf(workerUnderFirst, peers),
    parentName: nameOf(first, peers),
  })
  const addressRead = readTreeAddress(brief)
  assert.equal(addressRead.parentName, 'Agent',
    'a worker started after a same-tree blank-role sibling appeared was told the wrong manager name')
})
