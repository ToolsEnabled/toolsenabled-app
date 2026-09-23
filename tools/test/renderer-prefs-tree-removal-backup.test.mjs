/* WHO CAN STILL DESTROY THE SAVED TREES, AFTER THE clear() GATE.
 *
 * The gate added with the dated rolling copies refuses clear() while trees
 * exist. It refuses the 2026-09-20 incident in the exact shape it happened --
 * one call -- and nothing else: remove() takes a fleet document out of the
 * partition with no gate, no record write and no copy, so the same caller
 * removes each tree first and then finds an empty fleet and a clear() that
 * says yes. These tests hold that door and the copies that make it survivable.
 *
 * Searched at app 67db8dfef: NO caller in src/ removes an `mc.fleet.trees.v1:`
 * key, and nothing in src/ calls localStorage.clear(). The product therefore
 * never reaches either line; both are reachable only through mc-prefs:remove /
 * mc-prefs:clear (shell/main.cjs:7756, shell/fleet-profile-preload.cjs:630),
 * which is a script or a console in the main frame.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { BACKUP_INFIX, createRendererPrefs } = require_('../../shell/renderer-prefs.cjs')

function freshStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-prefs-treebackup-'))
  return { directory, prefs: createRendererPrefs({ directory, fs, path, randomUUID }) }
}
const discard = dir => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch { /* best effort */ } }
const copies = (directory, base) =>
  fs.readdirSync(directory).filter(name => name.startsWith(`${base}${BACKUP_INFIX}`)).sort()
const treeKey = name => `mc.fleet.trees.v1:${name}`

function seed(prefs, trees) {
  prefs.set('mc.theme', 'black')
  prefs.set('mc.write.agent-session', 'enabled')
  for (const name of trees) prefs.set(treeKey(name), JSON.stringify({ nodes: [name] }))
  // The fleet partition is written on a debounce; the copies read the FILE.
  assert.equal(prefs.flushFleetDocumentsSync().ok, true)
}

test('removing saved trees one at a time still walks past the clear() gate', () => {
  const { directory, prefs } = freshStore()
  try {
    seed(prefs, ['home', 'lab', 'office'])
    assert.equal(prefs.clear().error?.code, 'MC_PREFS_TREES_PRESENT', 'the one-call form is refused')

    for (const name of ['home', 'lab', 'office']) assert.equal(prefs.remove(treeKey(name)).ok, true)

    // The gate is gone with the trees: this is the door the copy has to cover.
    assert.equal(prefs.clear().ok, true, 'the gate only ever saw the one-call form')
  } finally { discard(directory) }
})

test('the first tree removal takes the dated copy, and it holds every tree', () => {
  const { directory, prefs } = freshStore()
  try {
    seed(prefs, ['home', 'lab', 'office'])

    prefs.remove(treeKey('home'))

    const fleetCopies = copies(directory, 'renderer-fleet-documents')
    assert.equal(fleetCopies.length, 1, 'a copy was taken before the first tree went')
    const saved = JSON.parse(fs.readFileSync(path.join(directory, fleetCopies[0]), 'utf8'))
    const text = JSON.stringify(saved)
    for (const name of ['home', 'lab', 'office']) {
      assert.equal(text.includes(treeKey(name)), true, `${name} is in the copy`)
    }
    assert.equal(copies(directory, 'renderer-prefs').length, 1, 'the settings record is copied beside it')
  } finally { discard(directory) }
})

test('a loop over every tree does not push the only complete copy off the front', () => {
  const { directory, prefs } = freshStore()
  try {
    const trees = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    seed(prefs, trees)

    for (const name of trees) prefs.remove(treeKey(name))

    const fleetCopies = copies(directory, 'renderer-fleet-documents')
    assert.equal(fleetCopies.length, 1, 'one copy per burst, not one per tree')
    const text = fs.readFileSync(path.join(directory, fleetCopies[0]), 'utf8')
    for (const name of trees) assert.equal(text.includes(treeKey(name)), true, `${name} survived in the copy`)
  } finally { discard(directory) }
})

test('an ordinary preference removal copies nothing', () => {
  const { directory, prefs } = freshStore()
  try {
    seed(prefs, ['home'])

    assert.equal(prefs.remove('mc.theme').ok, true)

    assert.deepEqual(copies(directory, 'renderer-fleet-documents'), [])
    assert.deepEqual(copies(directory, 'renderer-prefs'), [])
  } finally { discard(directory) }
})

/* CHARACTERISATION, not a change: these two already hold with the clear() gate
   alone, and they are the answer to "is the rolling copy reachable at all?".
   It is -- from mc-prefs:clear, whenever the record has no trees left, which is
   the state the owner's own record is in right now. */
test('clear() on a record with no trees takes the dated copy before emptying it', () => {
  const { directory, prefs } = freshStore()
  try {
    prefs.set('mc.theme', 'black')
    prefs.set('mc.write.agent-session', 'enabled')

    const answer = prefs.clear()

    assert.equal(answer.ok, true)
    assert.equal(copies(directory, 'renderer-prefs').length, 1)
    const saved = JSON.parse(fs.readFileSync(path.join(directory, copies(directory, 'renderer-prefs')[0]), 'utf8'))
    assert.equal(saved.values['mc.write.agent-session'], 'enabled')
  } finally { discard(directory) }
})

test('clear() with trees present is refused and copies nothing', () => {
  const { directory, prefs } = freshStore()
  try {
    seed(prefs, ['home'])

    const answer = prefs.clear()

    assert.equal(answer.ok, false)
    assert.equal(answer.error.code, 'MC_PREFS_TREES_PRESENT')
    assert.deepEqual(copies(directory, 'renderer-prefs'), [], 'a refusal is better than a copy')
  } finally { discard(directory) }
})
