/* T162 RED/GREEN PROOF: A STATUS WORD THIS BUILD CANNOT READ.
 *
 * WHAT THIS ANSWERS THAT THE SUITE DOES NOT. tools/test/fleet-trees.test.mjs
 * asserts the behaviour. This script asserts that those assertions are LOAD
 * BEARING: it runs the same claims against a MUTATED copy of the module and
 * refuses to report GREEN unless every mutation turns them RED, naming which
 * claim caught which mutation. A green suite over code that cannot fail is the
 * failure mode this exists to rule out.
 *
 * It also answers, BY CALLING RATHER THAN BY READING, the question that decides
 * how bad the original defect was: does the emptied parse result ever reach
 * DISK? See claim F.
 *
 * Nothing here touches the working tree. Each mutation is applied to a COPY of
 * src/ in a temp folder and imported from there, so a crash mid-run cannot
 * leave a mutated source behind.
 *
 *   node tools/t162-status-round-trip-proof.mjs          # GREEN + mutations
 *   node tools/t162-status-round-trip-proof.mjs --green  # GREEN only
 */

import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.join(HERE, '..')
const COMPUTER = 'c1'

/* ── the record that was actually measured ────────────────────────────────
   Three trees; one node of one of them carrying a word this build does not
   know. Before T162 this record answered EMPTY_FLEET_TREES: all three trees
   and all four nodes gone over that one word. */
const threeTrees = badStatus => ({
  version: 1,
  computerId: COMPUTER,
  trees: ['tree-1', 'tree-2', 'tree-3'].map(id => ({ id, name: null, createdAt: 'a', updatedAt: 'a' })),
  nodes: [
    { id: 'node-1', treeId: 'tree-1', parentId: null, role: 'planner', message: 'plan it', status: 'running', statusNote: '', sessionId: 'session-1', createdAt: 'a', updatedAt: 'a' },
    { id: 'node-2', treeId: 'tree-2', parentId: null, role: 'planner', message: 'plan it', status: 'finished', statusNote: '', sessionId: 'session-2', createdAt: 'a', updatedAt: 'a' },
    { id: 'node-3', treeId: 'tree-3', parentId: null, role: 'planner', message: 'plan it', status: badStatus, statusNote: '', sessionId: 'session-3', createdAt: 'a', updatedAt: 'a' },
    { id: 'node-4', treeId: 'tree-3', parentId: 'node-3', role: 'worker', message: 'do it', status: 'draft', statusNote: '', sessionId: null, createdAt: 'a', updatedAt: 'a' },
  ],
})

/* A STRUCTURALLY broken record, for claim F. The parent of node-4 is not in
   the record at all -- a refusal T162 deliberately did not relax. */
const structurallyBroken = () => {
  const base = threeTrees('finished')
  base.nodes[3].parentId = 'no-such-node'
  return base
}

function memoryStorage(seed = new Map()) {
  const cells = new Map(seed)
  return {
    cells,
    read(key) { return cells.has(key) ? JSON.parse(cells.get(key)) : null },
    write(key, value) { cells.set(key, JSON.stringify(value)); return true },
  }
}

function stamps() {
  let tick = 0
  return () => `2026-08-12T00:00:${String((tick += 1)).padStart(2, '0')}.000Z`
}

function counterIds() {
  let count = 0
  return kind => `${kind}-${(count += 1)}`
}

/* ── the claims ───────────────────────────────────────────────────────────
   Each is one named, independently failing statement. `m` is the freshly
   imported module under test; `liveness` is tree-session-liveness from the
   same copy, so a mutation to either is seen. */
const CLAIMS = [
  {
    id: 'A',
    name: 'the record survives: three trees, four nodes, over five unknown words',
    run({ m }) {
      for (const unknown of ['paused', 'running-v2', '', 'RUNNING', 'unreadable']) {
        const read = m.parseFleetTrees(threeTrees(unknown), { computerId: COMPUTER })
        assert.notEqual(read, m.EMPTY_FLEET_TREES, `status ${JSON.stringify(unknown)} emptied the store`)
        assert.equal(read.trees.length, 3, `status ${JSON.stringify(unknown)} lost a tree`)
        assert.equal(read.nodes.length, 4, `status ${JSON.stringify(unknown)} lost a node`)
        const marked = read.nodes.find(node => node.id === 'node-3')
        assert.equal(marked.status, m.NODE_STATUS_UNREADABLE, 'the node reads as the one named marker')
        assert.equal(m.savedNodeStatus(marked), unknown, 'the word it was saved with is kept beside the marker')
        assert.equal(marked.sessionId, 'session-3', 'the session handle is kept')
        assert.equal(read.nodes.find(node => node.id === 'node-4').parentId, 'node-3', 'the child still hangs off it')
      }
    },
  },
  {
    id: 'B',
    name: 'ROUND TRIP: the original word reaches the disk unchanged, through the whole-object seam',
    run({ m }) {
      const key = m.fleetTreesStorageKey(COMPUTER)
      const saved = JSON.stringify(threeTrees('paused'))
      const whole = memoryStorage(new Map([[key, saved]]))
      const store = m.createFleetTreeStore({ computerId: COMPUTER, storage: whole, now: stamps(), makeId: counterIds() })
      assert.equal(store.getNode('node-3').status, m.NODE_STATUS_UNREADABLE, 'it reads as the marker in memory')
      /* A write that does not touch the marker node still rewrites the whole
         record, so this is where the word would be lost. */
      assert.equal(store.setNodeReply('node-2', 'done').ok, true)
      const written = JSON.parse(whole.cells.get(key)).nodes.find(node => node.id === 'node-3')
      assert.equal(written.status, 'paused', 'the ORIGINAL word is what reached the disk')
      assert.equal(JSON.stringify(written).includes(m.NODE_STATUS_UNREADABLE), false,
        'the marker never leaks into the record under any key')
      /* Stable, not one-shot: it reads back as the marker again. */
      const reopened = m.createFleetTreeStore({ computerId: COMPUTER, storage: whole, now: stamps(), makeId: counterIds() })
      assert.equal(reopened.getNode('node-3').status, m.NODE_STATUS_UNREADABLE)
      assert.equal(m.savedNodeStatus(reopened.getNode('node-3')), 'paused')
    },
  },
  {
    id: 'C',
    name: 'ROUND TRIP: the text seam writes the same bytes, and a known status replaces the word',
    run({ m }) {
      const key = m.fleetTreesStorageKey(COMPUTER)
      const saved = JSON.stringify(threeTrees('paused'))
      const whole = memoryStorage(new Map([[key, saved]]))
      const wholeStore = m.createFleetTreeStore({ computerId: COMPUTER, storage: whole, now: stamps(), makeId: counterIds() })
      wholeStore.setNodeReply('node-2', 'done')
      wholeStore.markPromptedByPerson('node-3')

      const cells = new Map([[key, saved]])
      const text = m.safeTreeStorage({ getItem: k => (cells.has(k) ? cells.get(k) : null), setItem: (k, v) => cells.set(k, v) })
      const textStore = m.createFleetTreeStore({ computerId: COMPUTER, storage: text, now: stamps(), makeId: counterIds() })
      assert.equal(textStore.setNodeReply('node-2', 'done').ok, true)
      assert.equal(textStore.markPromptedByPerson('node-3').ok, true)
      assert.equal(cells.get(key), whole.cells.get(key), 'both seams wrote the same bytes')
      assert.equal(JSON.parse(cells.get(key)).nodes.find(node => node.id === 'node-3').status, 'paused')

      assert.equal(textStore.setNodeStatus('node-3', 'finished').ok, true)
      const settled = textStore.getNode('node-3')
      assert.equal(settled.status, 'finished')
      assert.equal(Object.hasOwn(settled, m.SAVED_STATUS), false, 'the saved word is dropped with the marker')
      assert.equal(JSON.parse(cells.get(key)).nodes.find(node => node.id === 'node-3').status, 'finished')
    },
  },
  {
    id: 'D',
    name: 'NO SEAT: the marker is not live, not draft, not terminal, and not a run to stop first',
    run({ m, liveness }) {
      assert.equal(m.NODE_STATUSES.includes(m.NODE_STATUS_UNREADABLE), false,
        'the marker is not a word a writer may set')
      const read = m.parseFleetTrees(threeTrees('paused'), { computerId: COMPUTER })
      const marked = read.nodes.find(node => node.id === 'node-3')
      assert.equal(liveness.nodeIsBusy(marked, new Set(['session-3'])), false,
        'it holds no seat even with its session alive on the host')
      const clock = liveness.treeNodeClock(marked)
      assert.equal(clock.running, false, 'nothing counts a clock for it')
      assert.equal(clock.terminal, false, 'and it is not finished either: the build does not know')

      /* Through the store: the marker may be removed without being stopped. */
      const key = m.fleetTreesStorageKey(COMPUTER)
      const whole = memoryStorage(new Map([[key, JSON.stringify(threeTrees('paused'))]]))
      const store = m.createFleetTreeStore({ computerId: COMPUTER, storage: whole, now: stamps(), makeId: counterIds() })
      assert.equal(store.snapshot().nodes.length, 4, 'the store opened the whole forest')
      assert.equal(store.removeNode('node-4').ok, true)
      assert.equal(store.removeNode('node-3').ok, true, 'an unreadable node is not a run to be stopped first')
    },
  },
  {
    id: 'E',
    name: 'the marker cannot be WRITTEN, only read: setNodeStatus still refuses it',
    run({ m }) {
      const store = m.createFleetTreeStore({ computerId: COMPUTER, storage: memoryStorage(), now: stamps(), makeId: counterIds() })
      const node = store.addNode({ role: 'reviewer', message: 'review it' }).node
      assert.equal(store.setNodeStatus(node.id, m.NODE_STATUS_UNREADABLE).ok, false,
        'nothing in this build may decide an agent state is unreadable')
      assert.equal(store.getNode(node.id).status, 'draft', 'and the refusal changed nothing')
    },
  },
  {
    id: 'F',
    name: 'WRITE-BACK: an emptied parse result never reaches the disk -- the original bytes survive',
    run({ m }) {
      const key = m.fleetTreesStorageKey(COMPUTER)
      const original = JSON.stringify(structurallyBroken())
      const whole = memoryStorage(new Map([[key, original]]))
      /* The store REFUSES TO OPEN rather than opening empty over the record. */
      assert.throws(
        () => m.createFleetTreeStore({ computerId: COMPUTER, storage: whole, now: stamps(), makeId: counterIds() }),
        error => {
          assert.equal(error.code, 'MC_TREE_STORAGE_INVALID', `the refusal names itself: ${error.message}`)
          return true
        },
        'a record this build cannot parse must refuse to open, not open empty',
      )
      assert.equal(whole.cells.get(key), original,
        'THE ORIGINAL BYTES ARE UNTOUCHED: nothing was replaced, so this is one bad read and not destruction')
      /* And the structural refusal itself is still in force -- T162 relaxed the
         status check only. */
      assert.equal(m.parseFleetTrees(structurallyBroken(), { computerId: COMPUTER }), m.EMPTY_FLEET_TREES)
    },
  },
]

/* ── the mutations ────────────────────────────────────────────────────────
   Each removes exactly one piece of T162 and names the claim that must catch
   it. `file` is relative to src/. A mutation whose `from` is not found is a
   HARD FAILURE: an unapplied mutation would pass vacuously. */
const MUTATIONS = [
  {
    id: 'M1',
    name: 'the quarantine is removed: an unknown status empties the record again (the pre-T162 defect)',
    file: 'fleet-trees.js',
    from: '    const statusReadable = NODE_STATUSES.includes(entry.status)',
    to: '    const statusReadable = NODE_STATUSES.includes(entry.status)\n    if (!statusReadable) return EMPTY_FLEET_TREES',
    caughtBy: 'A',
  },
  {
    id: 'M2',
    name: 'nodeSavedForm stops restoring the word: the marker itself would reach the disk',
    file: 'fleet-trees.js',
    from: "  if (!node || node.status !== NODE_STATUS_UNREADABLE) return node",
    to: "  if (!node || node.status !== NODE_STATUS_UNREADABLE) return node\n  return node",
    caughtBy: 'B',
  },
  {
    id: 'M3',
    name: 'the saved word is never carried out of the parse: the status would go back undefined',
    file: 'fleet-trees.js',
    from: '      ...(statusReadable ? {} : { [SAVED_STATUS]: entry.status }),',
    to: '',
    caughtBy: 'A',
  },
  {
    id: 'M4',
    name: 'the marker takes a seat: it is added to LIVE_STATUSES',
    file: 'fleet-trees.js',
    from: "const LIVE_STATUSES = Object.freeze(new Set(['starting', 'running']))",
    to: "const LIVE_STATUSES = Object.freeze(new Set(['starting', 'running', 'unreadable']))",
    caughtBy: 'D',
  },
  {
    id: 'M5',
    name: 'the memoised text seam is left unfixed: the two save seams disagree',
    file: 'fleet-trees.js',
    from: '    const made = JSON.stringify(nodeSavedForm(entry))',
    to: '    const made = JSON.stringify(entry)',
    caughtBy: 'C',
  },
  {
    id: 'M6',
    name: 'the marker becomes a writable status: this build could declare a state unreadable',
    file: 'fleet-trees.js',
    from: "export const NODE_STATUSES = Object.freeze(['draft', 'starting', 'running', 'finished', 'failed', 'turn-failed', 'interrupted', 'cancelled'])",
    to: "export const NODE_STATUSES = Object.freeze(['draft', 'starting', 'running', 'finished', 'failed', 'turn-failed', 'interrupted', 'cancelled', 'unreadable'])",
    caughtBy: 'E',
  },
]

/* ── running ──────────────────────────────────────────────────────────── */

let serial = 0
async function loadModules(srcDir) {
  /* A distinct query per load: node caches a module URL forever, and every
     mutation needs its own module graph. */
  const tag = `?t162=${(serial += 1)}`
  const m = await import(pathToFileURL(path.join(srcDir, 'fleet-trees.js')).href + tag)
  const liveness = await import(pathToFileURL(path.join(srcDir, 'tree-session-liveness.js')).href + tag)
  return { m, liveness }
}

function runClaims(modules) {
  const failures = []
  for (const claim of CLAIMS) {
    try {
      claim.run(modules)
    } catch (error) {
      failures.push({ id: claim.id, name: claim.name, message: error?.message || String(error) })
    }
  }
  return failures
}

async function main() {
  const greenOnly = process.argv.includes('--green')
  const root = mkdtempSync(path.join(tmpdir(), 't162-proof-'))
  let bad = 0
  try {
    /* GREEN: the unmutated source, copied, so the green and red runs differ in
       nothing but the mutation. */
    const cleanSrc = path.join(root, 'clean', 'src')
    cpSync(path.join(APP, 'src'), cleanSrc, { recursive: true })
    const greenFailures = runClaims(await loadModules(cleanSrc))
    console.log('GREEN — the committed source')
    for (const claim of CLAIMS) {
      const failed = greenFailures.find(f => f.id === claim.id)
      console.log(`  ${failed ? 'FAIL' : 'ok  '} ${claim.id}. ${claim.name}`)
      if (failed) console.log(`        ${failed.message.split('\n')[0]}`)
    }
    bad += greenFailures.length
    if (greenFailures.length > 0) {
      console.log('\nThe committed source does not satisfy its own claims. Mutations not run.')
      return bad
    }
    if (greenOnly) return bad

    console.log('\nRED — each mutation must break the claim that owns it')
    for (const mutation of MUTATIONS) {
      const dir = path.join(root, mutation.id, 'src')
      cpSync(path.join(APP, 'src'), dir, { recursive: true })
      const target = path.join(dir, mutation.file)
      const before = readFileSync(target, 'utf8')
      const occurrences = before.split(mutation.from).length - 1
      if (occurrences !== 1) {
        console.log(`  FAIL ${mutation.id}. ${mutation.name}`)
        console.log(`        the mutation did not apply: found ${occurrences} occurrences, needed exactly 1`)
        bad += 1
        continue
      }
      writeFileSync(target, before.replace(mutation.from, mutation.to))

      let failures
      try {
        failures = runClaims(await loadModules(dir))
      } catch (error) {
        /* A mutation that will not even load is still a detected mutation. */
        failures = [{ id: mutation.caughtBy, name: '(module failed to load)', message: error?.message || String(error) }]
      }
      const caught = failures.find(f => f.id === mutation.caughtBy)
      if (caught) {
        console.log(`  ok   ${mutation.id}. ${mutation.name}`)
        console.log(`        caught by ${caught.id}: ${caught.message.split('\n')[0]}`)
      } else {
        console.log(`  FAIL ${mutation.id}. ${mutation.name}`)
        console.log(`        claim ${mutation.caughtBy} did NOT catch it${failures.length ? ` (other claims failed: ${failures.map(f => f.id).join(', ')})` : ' — nothing failed at all'}`)
        bad += 1
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return bad
}

const failed = await main()
console.log(failed === 0
  ? `\nGREEN, and all ${MUTATIONS.length} mutations were caught by the claim that owns them.`
  : `\n${failed} problem(s). This proof does not hold.`)
process.exit(failed === 0 ? 0 : 1)
