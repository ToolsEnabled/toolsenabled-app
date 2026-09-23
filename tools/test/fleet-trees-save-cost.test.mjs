/* WHAT A SAVE COSTS, AND WHAT IT MUST STILL GUARANTEE.
 *
 * createFleetTreeStore serialises each tree and each agent ONCE and memoises
 * the text on the frozen record, so recording a status word no longer
 * re-escapes every agent's message and reply. That is a cache in the write
 * path of the only copy of a person's structure, and a cache in a write path
 * has exactly one way to be wrong: it can hand back text for a record that has
 * since changed. Every test here is aimed at that, from a different side.
 *
 * Nothing below asserts a millisecond. The number lives in the commit and in
 * scratch/bench-ab.mjs; a clock in a suite that runs beside nineteen other
 * lanes measures the machine, not the change. What is asserted is the pair of
 * facts the speed is only allowed to be bought with: every accepted change is
 * in storage when the call returns, and the bytes are the bytes the old whole
 * object path wrote.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createFleetTreeStore,
  fleetTreesStorageKey,
  parseFleetTrees,
  safeTreeStorage,
} from '../../src/fleet-trees.js'

const COMPUTER = 'computer-save-cost'

/* The seam the app hands in: safeTreeStorage over a localStorage-shaped
   backing, which is the one that offers the cheap door. Counts what reached
   the backing so a test can ask how many writes a call made. */
function appSeam() {
  const cells = new Map()
  const writes = []
  const backing = {
    getItem: key => (cells.has(key) ? cells.get(key) : null),
    setItem: (key, value) => { cells.set(key, value); writes.push(value) },
  }
  return { storage: safeTreeStorage(backing), cells, writes }
}

/* The seam every hand-rolled caller in the other suites hands in: read and
   write only, no writeText, so the store must fall back to the whole-object
   path and produce the same file. */
function plainSeam() {
  const cells = new Map()
  const writes = []
  return {
    storage: {
      read: key => (cells.has(key) ? JSON.parse(cells.get(key)) : null),
      write: (key, value) => { const text = JSON.stringify(value); cells.set(key, text); writes.push(text); return true },
    },
    cells,
    writes,
  }
}

const stamps = () => {
  let tick = 0
  return () => new Date(Date.UTC(2026, 8, 3) + (tick += 1000)).toISOString()
}

const counterIds = () => {
  let n = 0
  return kind => `${kind}-${(n += 1)}`
}

/* Eleven circles across three trees, each carrying a message the length of a
   real brief, because the cost this change is about is the length of the text
   that did NOT change. */
function forest(seam) {
  const store = createFleetTreeStore({
    computerId: COMPUTER,
    storage: seam.storage,
    now: stamps(),
    makeId: counterIds(),
  })
  const message = 'Work the branch under this circle and report what changed. '.repeat(12)
  const ids = []
  for (let t = 0; t < 3; t += 1) {
    const top = store.addNode({ role: 'manager', message }).node
    ids.push(top.id)
    let parent = top.id
    for (let n = 0; n < 3; n += 1) {
      const child = store.addNode({ parentId: parent, role: 'worker', message }).node
      ids.push(child.id)
      if (n === 1) parent = child.id
    }
  }
  for (const id of ids) store.attachSession(id, `session-${id}`)
  return { store, ids }
}

/** What a later launch would read out of this storage. */
const reloaded = seam => parseFleetTrees(
  JSON.parse(seam.cells.get(fleetTreesStorageKey(COMPUTER))),
  { computerId: COMPUTER },
)

test('a burst of status changes ends with every change in storage', () => {
  const seam = appSeam()
  const { store, ids } = forest(seam)
  const statuses = ['running', 'finished', 'running', 'turn-failed', 'interrupted', 'running']

  /* Sixty changes rattling across twelve circles, the way eleven live trees
     report on one busy minute. The expected end state is built here rather
     than read off the store, so the assertion is about what was ASKED for. */
  const wanted = new Map()
  for (let i = 0; i < 60; i += 1) {
    const id = ids[i % ids.length]
    const status = statuses[i % statuses.length]
    const note = `beat ${i}`
    const out = store.setNodeStatus(id, status, { note })
    assert.equal(out.ok, true, `change ${i} was refused: ${out.problems?.join(' ')}`)
    wanted.set(id, { status, note })
  }

  /* No flush, no timer, no next frame: the last call has returned, so the file
     is already right. Read it the way a fresh launch would. */
  const saved = reloaded(seam)
  assert.equal(saved.nodes.length, ids.length, 'every circle survived the burst')
  for (const [id, expected] of wanted) {
    const node = saved.nodes.find(entry => entry.id === id)
    assert.ok(node, `circle ${id} is missing from the saved file`)
    /* A saved 'running' comes back as 'starting' on purpose — a session cannot
       outlive the window — so compare against what the reader promises. */
    assert.equal(node.status, expected.status === 'running' ? 'starting' : expected.status, `circle ${id} kept the wrong state`)
    assert.equal(node.statusNote, expected.note, `circle ${id} kept the wrong note`)
  }
})

test('every change is in storage on its own beat, not only at the end of the burst', () => {
  /* The burst above would still pass if a store wrote once at the end. This
     one fails for that store: the file is read after EACH change. */
  const seam = appSeam()
  const { store, ids } = forest(seam)
  for (let i = 0; i < 24; i += 1) {
    const id = ids[i % ids.length]
    const note = `beat ${i}`
    store.setNodeStatus(id, 'finished', { note })
    const node = reloaded(seam).nodes.find(entry => entry.id === id)
    assert.equal(node.statusNote, note, `the file did not hold change ${i} when the call returned`)
  }
})

test('the file a burst leaves behind is the file the whole-object path wrote', () => {
  /* Same calls, same stamps, same ids, one seam offering writeText and one
     offering only write. If the memoised join ever drifted from
     JSON.stringify of the record — a key in a different order, an element
     stringified in a different context, a stale fragment — these two cells
     would differ. */
  const fast = appSeam()
  const slow = plainSeam()
  const built = [forest(fast), forest(slow)]
  const statuses = ['running', 'finished', 'turn-failed', 'interrupted']
  for (const { store, ids } of built) {
    for (let i = 0; i < 40; i += 1) {
      store.setNodeStatus(ids[i % ids.length], statuses[i % statuses.length], { note: `beat ${i}` })
    }
    store.setNodeReply(ids[0], 'quoted "reply" with a backslash \\ and a newline\nin it')
    store.renameTree(store.listTrees()[0].id, 'Release — “final”')
    store.removeNode(ids[ids.length - 1])
  }
  const fastCell = fast.cells.get(fleetTreesStorageKey(COMPUTER))
  const slowCell = slow.cells.get(fleetTreesStorageKey(COMPUTER))
  assert.equal(typeof fastCell, 'string')
  assert.equal(fastCell, slowCell, 'the two seams wrote different bytes for the same forest')
})

test('a record that changed twice is written from its newest text, never the memo of the old one', () => {
  /* The straight line into a stale cache: touch A, touch B so the memo has
     served somebody else in between, then touch A again. */
  const seam = appSeam()
  const { store, ids } = forest(seam)
  const [a, b] = ids

  store.setNodeStatus(a, 'finished', { note: 'first' })
  store.setNodeStatus(b, 'failed', { note: 'other' })
  store.setNodeStatus(a, 'turn-failed', { note: 'second' })

  const saved = reloaded(seam)
  const savedA = saved.nodes.find(entry => entry.id === a)
  const savedB = saved.nodes.find(entry => entry.id === b)
  assert.equal(savedA.status, 'turn-failed')
  assert.equal(savedA.statusNote, 'second', 'the file kept the first note, so a stale fragment was written')
  assert.equal(savedB.statusNote, 'other')
})

test('a removed circle leaves the file with it, and its tree leaves when it was the last', () => {
  /* The other half of a per-record memo: text that is kept for a record must
     not outlive the record. */
  const seam = appSeam()
  const { store, ids } = forest(seam)
  const doomed = ids[3]
  const doomedTree = store.getNode(doomed).treeId
  store.detachSession(doomed)
  assert.equal(store.removeNode(doomed).ok, true)

  const saved = reloaded(seam)
  assert.equal(saved.nodes.some(entry => entry.id === doomed), false, 'the removed circle is still in the file')
  assert.equal(saved.nodes.length, ids.length - 1)
  assert.ok(saved.trees.some(tree => tree.id === doomedTree), 'its tree still holds the circles above it')

  /* Now take a whole tree out and check its agents went with it. */
  const tree = store.listTrees()[0]
  const inTree = store.listNodes(tree.id).map(node => node.id)
  assert.ok(inTree.length > 0)
  assert.equal(store.removeTree(tree.id).ok, true)
  const after = reloaded(seam)
  assert.equal(after.trees.some(entry => entry.id === tree.id), false)
  for (const id of inTree) {
    assert.equal(after.nodes.some(entry => entry.id === id), false, `circle ${id} outlived the tree it was in`)
  }
})

test('a refused change writes nothing, and saying a fact twice writes nothing', () => {
  const seam = appSeam()
  const { store, ids } = forest(seam)
  const node = ids[0]

  const settled = seam.writes.length
  assert.equal(store.setNodeStatus(node, 'nonsense-status').ok, false)
  assert.equal(store.setNodeStatus('node-nobody', 'finished').ok, false)
  assert.equal(seam.writes.length, settled, 'a refusal saved a file nobody changed')

  assert.equal(store.markPromptedByPerson(node).ok, true)
  assert.equal(seam.writes.length, settled + 1, 'the first time the person speaks to a circle is a change')
  const afterFirst = seam.writes.length

  const again = store.markPromptedByPerson(node)
  assert.equal(again.ok, true, 'saying it twice is the same fact, not an error')
  assert.equal(again.snapshot.nodes.find(entry => entry.id === node).promptedByPerson, true)
  assert.equal(seam.writes.length, afterFirst, 'saying it twice wrote the whole forest again for nothing')
  assert.equal(reloaded(seam).nodes.find(entry => entry.id === node).promptedByPerson, true)
})

test('a save that will not land is still reported, through either door', () => {
  /* The cheap door must not swallow a quota failure the old one reported. */
  const refusing = {
    read: () => null,
    write: () => false,
    writeText: () => false,
  }
  const store = createFleetTreeStore({ computerId: COMPUTER, storage: refusing, now: stamps(), makeId: counterIds() })
  const added = store.addNode({ role: 'worker' })
  assert.equal(added.ok, true, 'the work is still on screen')
  assert.equal(added.snapshot.persistenceFailed, true)
  assert.equal(store.snapshot().persistenceFailed, true)

  const throwing = {
    read: () => null,
    write: () => { throw new Error('quota') },
    writeText: () => { throw new Error('quota') },
  }
  const second = createFleetTreeStore({ computerId: COMPUTER, storage: throwing, now: stamps(), makeId: counterIds() })
  assert.equal(second.addNode({ role: 'worker' }).snapshot.persistenceFailed, true)
})

test('safeTreeStorage writes the same bytes through write and through writeText', () => {
  const cells = new Map()
  const seam = safeTreeStorage({
    getItem: key => (cells.has(key) ? cells.get(key) : null),
    setItem: (key, value) => cells.set(key, value),
  })
  const value = { version: 1, computerId: COMPUTER, trees: [{ id: 't', name: 'a “quoted” \\ name' }], nodes: [] }
  assert.equal(seam.write('k', value), true)
  const viaWrite = cells.get('k')
  assert.equal(seam.writeText('k2', JSON.stringify(value)), true)
  assert.equal(cells.get('k2'), viaWrite)
  assert.deepEqual(seam.read('k2'), value)

  /* It cannot throw, for the same reason write() cannot: the seam is what a
     private-mode or full-quota browser fails inside of. */
  const dead = safeTreeStorage({ setItem: () => { throw new Error('quota') } })
  assert.equal(dead.writeText('k', '{}'), false)
})
