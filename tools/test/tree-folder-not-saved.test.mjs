// A FOLDER THE DISK REFUSED, REPORTED AS ASSIGNED.
//
// The "Works in" menu on a tree node writes the tree's folder with
// setTreeProfile() and then tells the person what happened. Its only guard was
// `if (!saved.ok)`. That guard cannot see a refused WRITE, because the store
// deliberately does not throw or fail the call for one: the assignment really
// did happen in memory, and the storage outcome rides in the snapshot instead.
//
// WHAT WAS MEASURED, against the real store in src/fleet-trees.js with a seam
// whose setItem throws QuotaExceededError -- which is what a browser does once
// the saved transcripts have filled localStorage, the same origin the forest
// lives in:
//
//   healthy write   ok=true   persistenceFailed=false  treeProfile=profile-alpha
//   quota   write   ok=true   persistenceFailed=true   treeProfile=profile-beta
//   `!saved.ok` fires?  false
//   re-parsed from what is actually stored:  profile-alpha
//
// So the panel printed "Agents in this tree now start in <name>", offered to
// restart the running agent into that folder, and the next launch put every
// agent in the tree back in the previous one. A person who chose a folder to
// keep two kinds of work apart was told it had been done.
//
// TWO KINDS OF TEST, ON PURPOSE. The first two drive the store for real and
// hold the PREMISE the view now depends on -- if the persistence signal ever
// moves off the returned snapshot, those are the tests that say so, and the
// view's new branch would otherwise go quietly dead. The rest are pinned
// against the view source in the idiom of tools/test/rail-panel-order.test.mjs,
// because the view is an Electron-mounted closure this suite cannot build.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createFleetTreeStore,
  fleetTreesStorageKey,
  parseFleetTrees,
  safeTreeStorage,
} from '../../src/fleet-trees.js'

const here = fileURLToPath(import.meta.url)
const SRC = join(dirname(dirname(dirname(here))), 'src')
const view = readFileSync(join(SRC, 'views', 'computers.js'), 'utf8')
const copy = readFileSync(join(SRC, 'fleet-tree-copy.js'), 'utf8')

const COMPUTER = 'computer-folder-persist'

/* A localStorage-shaped backing that starts healthy and can be filled, so one
   store can be watched across the moment the quota runs out -- which is how it
   reaches a person, mid-session, rather than as a store that never worked. */
function quotaBacking() {
  const map = new Map()
  let full = false
  return {
    fill() { full = true },
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem(key, value) {
      if (full) {
        const error = new Error('QuotaExceededError')
        error.name = 'QuotaExceededError'
        throw error
      }
      map.set(key, String(value))
    },
    removeItem(key) { map.delete(key) },
  }
}

test('a refused save leaves setTreeProfile ok, and says so in the snapshot', () => {
  const backing = quotaBacking()
  const store = createFleetTreeStore({ computerId: COMPUTER, storage: safeTreeStorage(backing) })
  const treeId = store.createTree({ name: 'Lane' }).tree.id

  const healthy = store.setTreeProfile(treeId, 'profile-alpha')
  assert.equal(healthy.ok, true)
  assert.equal(healthy.snapshot.persistenceFailed, false, 'a good write must not report a failure')

  backing.fill()
  const refused = store.setTreeProfile(treeId, 'profile-beta')

  /* THE WHOLE POINT: `ok` stays true, so a caller reading only `ok` is told
     this worked. The truth is one field further in. */
  assert.equal(refused.ok, true, 'the in-memory assignment really does succeed')
  assert.equal(refused.snapshot.persistenceFailed, true, 'the refused write must be reported')
  assert.equal(store.treeProfile(treeId), 'profile-beta', 'this window holds the new folder')
})

test('after a refused save the tree really does reload with the OLD folder', () => {
  const backing = quotaBacking()
  const store = createFleetTreeStore({ computerId: COMPUTER, storage: safeTreeStorage(backing) })
  const treeId = store.createTree({ name: 'Lane' }).tree.id
  store.setTreeProfile(treeId, 'profile-alpha')

  backing.fill()
  store.setTreeProfile(treeId, 'profile-beta')

  /* Read what is ACTUALLY stored, through the same parser the next launch
     uses. Asking the live store would only repeat what memory believes. */
  const reloaded = parseFleetTrees(backing.getItem(fleetTreesStorageKey(COMPUTER)), { computerId: COMPUTER })
  assert.equal(
    reloaded.trees.find(tree => tree.id === treeId)?.profileId,
    'profile-alpha',
    'the folder the person picked is not on disk, so agents come back in the old one',
  )
})

/* ---------------------------------------------------------------------------
 * The menu itself, pinned against the view source.
 * ------------------------------------------------------------------------- */

function profileMenuSource() {
  const start = view.indexOf("profileSelect.addEventListener('change'")
  assert.notEqual(start, -1, 'the "Works in" change handler is gone')
  const end = view.indexOf('data-tree-profile-restart]', start)
  assert.ok(end > start, 'the "Works in" handler no longer reaches the restart control')
  return view.slice(start, end)
}

test('the "Works in" menu reads the persistence outcome, not just ok', () => {
  const body = profileMenuSource()
  assert.ok(
    body.includes('saved.snapshot?.persistenceFailed'),
    'the menu must read the refused-write signal the store returns to it',
  )
  assert.ok(
    body.includes('PROFILE_PANEL.notSaved'),
    'a refused save needs its own sentence, not the assignment one',
  )
})

test('a refused save is reported instead of the assignment, never after it', () => {
  const body = profileMenuSource()
  const refusal = body.indexOf('persistenceFailed')
  const assigned = body.indexOf('PROFILE_PANEL.assigned(')
  assert.ok(refusal > -1 && assigned > -1, 'both branches must still exist')
  assert.ok(
    refusal < assigned,
    'the check has to come first, or the panel claims the assignment before correcting itself',
  )
  /* The early return is what keeps the two sentences from both landing, and
     what withholds the restart offer below. Without it a person is told the
     save failed and then invited to spend tokens acting on it. */
  assert.match(
    body,
    /if \(saved\.snapshot\?\.persistenceFailed\) \{[\s\S]*?return\s*\r?\n\s*\}/,
    'the refused-save branch must return before the assignment and the restart offer',
  )
})

test('the restart offer sits after the refusal branch, so it cannot be reached by it', () => {
  const body = profileMenuSource()
  const refusal = body.indexOf('persistenceFailed')
  const offer = body.indexOf('PROFILE_PANEL.switchOffer')
  assert.ok(offer > -1, 'the restart offer is gone')
  assert.ok(refusal > -1, 'there is no refusal branch to order against')
  assert.ok(
    refusal < offer,
    'restarting an agent into a folder the next launch will not remember costs tokens for nothing',
  )
})

test('the refusal copy states both halves and names the reload', () => {
  assert.match(copy, /notSaved: \(name\) =>/, 'the refusal sentence must name the folder chosen')
  assert.ok(copy.includes('notSavedCleared'), 'clearing to the product workspace needs its own sentence')
  const clearedAt = copy.indexOf('notSavedCleared')
  const sentences = [
    ['notSaved', copy.slice(copy.indexOf('notSaved: (name) =>'), clearedAt)],
    ['notSavedCleared', copy.slice(clearedAt, clearedAt + 280)],
  ]
  for (const [label, sentence] of sentences) {
    assert.ok(/reload/i.test(sentence), `${label} must say what happens on reload`)
    assert.ok(
      /Agents you start now/.test(sentence),
      `${label} must also say the choice is live right now, or it reads as "your press did nothing"`,
    )
  }
})
