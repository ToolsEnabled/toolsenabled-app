#!/usr/bin/env node

/* WHAT ONE STATUS CHANGE ON THE TREE COSTS TO SAVE.
 *
 * src/fleet-trees.js persists the WHOLE forest on every mutation, because a
 * structure the person builds by pressing placeholders has no save button and
 * a tree that is on screen and not in storage is a lie the next launch tells.
 * That is not the part being measured. What is measured is how much of that
 * whole-forest save is work about the field that changed.
 *
 * BOTH COLUMNS ARE LIVE CODE, so the number cannot drift away from what it
 * describes:
 *
 *   whole-object seam   a { read, write } seam, which is what every
 *                       hand-rolled caller hands in and what safeTreeStorage
 *                       was before writeText existed. The store falls back to
 *                       handing it the record OBJECT, so the seam's own
 *                       JSON.stringify walks every tree and every agent —
 *                       including 4000-character messages and replies — to
 *                       record one status word.
 *   text seam           safeTreeStorage, which offers writeText. The store
 *                       serialises each record once, memoises the text on the
 *                       frozen record, and joins the document from pieces, so
 *                       the only record re-serialised is the one that changed.
 *
 * Both write the same bytes to the same key; the bench asserts that rather
 * than trusting it, and tools/test/fleet-trees-save-cost.test.mjs asserts it
 * again over a longer burst with quotes, backslashes and removals in it.
 *
 *   node tools/fleet-tree-save-cost-bench.mjs
 *   BENCH_TREES=24 BENCH_PER_TREE=8 node tools/fleet-tree-save-cost-bench.mjs
 */

import assert from 'node:assert/strict'

import { createFleetTreeStore, fleetTreesStorageKey, safeTreeStorage } from '../src/fleet-trees.js'

const TREES = Number(process.env.BENCH_TREES || 11)
const PER_TREE = Number(process.env.BENCH_PER_TREE || 6)
const BURST = Number(process.env.BENCH_BURST || 200)
const ROUNDS = Number(process.env.BENCH_ROUNDS || 9)
const COMPUTER = 'computer-bench'

/* Real lengths, because the cost is the length of the text that did NOT
   change. A brief and an agent's answer are both capped at 4000 characters. */
const message = 'Take the branch under this circle and report what changed. '.repeat(14)
const reply = 'I read the file, found the write path, and measured it end to end. '.repeat(18)

function cells() {
  const store = new Map()
  return {
    map: store,
    backing: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, value) },
    },
  }
}

/** The seam the app hands in: it offers writeText, so the store takes it. */
const textSeam = () => {
  const held = cells()
  return { storage: safeTreeStorage(held.backing), map: held.map }
}

/** The seam every hand-rolled caller hands in: the store must fall back. */
const wholeObjectSeam = () => {
  const held = cells()
  return {
    storage: {
      read: key => (held.map.has(key) ? JSON.parse(held.map.get(key)) : null),
      write: (key, value) => { held.map.set(key, JSON.stringify(value)); return true },
    },
    map: held.map,
  }
}

function build(seam) {
  let counter = 0
  let tick = 0
  const store = createFleetTreeStore({
    computerId: COMPUTER,
    storage: seam.storage,
    makeId: kind => `${kind}-${(counter += 1)}`,
    /* Deterministic, so the two seams' stored cells are comparable byte for
       byte. A wall clock would make them differ for a reason that is not the
       thing being compared. */
    now: () => new Date(Date.UTC(2026, 8, 3) + (tick += 1000)).toISOString(),
  })
  const ids = []
  for (let t = 0; t < TREES; t += 1) {
    const tree = store.createTree({ name: `Tree ${t + 1}` })
    const top = store.addNode({ treeId: tree.tree.id, role: 'manager', message }).node
    ids.push(top.id)
    let parent = top.id
    for (let n = 1; n < PER_TREE; n += 1) {
      const child = store.addNode({ parentId: parent, role: 'worker', message }).node
      ids.push(child.id)
      if (n % 3 === 0) parent = child.id
    }
  }
  for (const id of ids) {
    store.attachSession(id, `session-${id}`)
    store.setNodeReply(id, reply)
  }
  return { store, ids, map: seam.map }
}

const STATUSES = ['running', 'finished', 'running', 'turn-failed']

function burst(makeSeam) {
  const { store, ids, map } = build(makeSeam())
  const started = process.hrtime.bigint()
  for (let i = 0; i < BURST; i += 1) {
    const out = store.setNodeStatus(ids[i % ids.length], STATUSES[i % STATUSES.length], { note: '' })
    if (!out.ok) throw new Error(`refused: ${out.problems.join(' ')}`)
  }
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, cell: map.get(fleetTreesStorageKey(COMPUTER)) }
}

// Warm both sides, then interleave the rounds so a machine that drifts under
// load — which is the machine this runs on — cannot favour whichever went first.
burst(wholeObjectSeam)
burst(textSeam)
const whole = []
const text = []
let lastCells = null
for (let round = 0; round < ROUNDS; round += 1) {
  const w = burst(wholeObjectSeam)
  const t = burst(textSeam)
  whole.push(w.ms)
  text.push(t.ms)
  lastCells = { whole: w.cell, text: t.cell }
}

const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]
const mWhole = median(whole)
const mText = median(text)

assert.equal(lastCells.text, lastCells.whole, 'the two seams wrote different bytes for the same forest')

console.log(`${TREES} trees, ${TREES * PER_TREE} agents, ${(lastCells.text.length / 1024).toFixed(1)} KiB record, ${BURST} status changes, median of ${ROUNDS} interleaved rounds`)
console.log(`  whole-object seam  ${mWhole.toFixed(2)} ms  = ${(mWhole / BURST).toFixed(4)} ms/change`)
console.log(`  text seam          ${mText.toFixed(2)} ms  = ${(mText / BURST).toFixed(4)} ms/change`)
console.log(`  ${(mWhole / mText).toFixed(2)}x cheaper, same bytes`)
