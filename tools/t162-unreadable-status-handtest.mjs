#!/usr/bin/env node

/* T162 BY HAND: OPEN A REAL WINDOW ON A FOREST CARRYING A WORD THIS BUILD
 * CANNOT READ, AND SEE WHETHER THE PERSON'S TREES ARE STILL THERE.
 *
 * THE DEFECT THIS EXISTS FOR, measured 2026-09-19 on the 1.0.45 line: a saved
 * forest of three trees, one node of one of them carrying the status word
 * 'paused', answered EMPTY_FLEET_TREES. Three trees and four nodes gone. The
 * person opens the Computers page and their whole canvas is blank, with
 * nothing on screen saying why, and the record still on disk.
 *
 * WHY A DRIVER AND NOT ONLY A SUITE. tools/test/fleet-trees.test.mjs proves the
 * parse and both save seams, and tools/t162-status-round-trip-proof.mjs proves
 * those assertions are load bearing. Neither opens a window. Three things only
 * the real product can answer, and every one of them is a thing the person
 * actually sees:
 *   1. the trees are DRAWN, not merely parsed;
 *   2. the chip beside the unreadable node says something honest and its own
 *      -- src/views/computers.js falls back to NODE_STATUS_WORDS.draft for any
 *      status it has no word for, so without the copy entry a node that may be
 *      mid-run reads "not started yet" to the person;
 *   3. the original word survives a ROUND TRIP THROUGH THE REAL MAIN PROCESS
 *      to renderer-fleet-documents.json and back -- shell/renderer-prefs.cjs,
 *      not a memory seam in a test.
 *
 * IT SPENDS NOTHING. No agent is started, no account is created and no provider
 * is called: the forest is seeded into the saved record the way a returning
 * person's really is, and everything under test is read, draw and save.
 *
 * ISOLATION. stage() + openWindow() give this run its own profile directory,
 * and --user-data-dir decides the state root AND the vault for the candidate,
 * so nothing here can reach the owner's live trees. assertIsolated() is called
 * before anything is seeded and the run stops if it does not hold. The seeded
 * computer id is deliberately NOT 'this-computer' for the same reason.
 *
 *   node tools/t162-unreadable-status-drive.mjs
 *   node tools/t162-unreadable-status-drive.mjs --visible --keep
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  argument,
  assertIsolated,
  closeWindow,
  delay,
  openWindow,
  releaseDirectory,
  seedMachineRecord,
  stage,
  userDataFor,
} from './test-account-harness.mjs'

const RELEASE = path.resolve(argument('--release', releaseDirectory()))
const KEEP = process.argv.includes('--keep')

/* Not 'this-computer': the owner's own record lives under that id, and a driver
   that seeds a deliberately damaged status must not be one typo away from it. */
const COMPUTER_ID = 't162-probe-computer'
const TREES_KEY = `mc.fleet.trees.v1:${COMPUTER_ID}`
const FLEET_FILE = 'renderer-fleet-documents.json'
const STAMP = '2026-09-19T12:00:00.000Z'

/* The word. Any status outside NODE_STATUSES does this; 'paused' is the one
   that was actually on the owner's disk. */
const UNKNOWN_WORD = 'paused'
const MARKER_CHIP = 'state unreadable by this build'
const DRAFT_CHIP = 'not started yet'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}

const node = (id, treeId, parentId, overrides = {}) => ({
  id, treeId, parentId, role: 'planner', message: 'plan it',
  status: 'finished', statusNote: '', reply: 'Done.', sessionId: null,
  createdAt: STAMP, updatedAt: STAMP, ...overrides,
})

/* THE MEASURED SHAPE. Three trees; the third holds the unreadable node, and a
   child hangs off it so a lost parent would take a visible subtree with it. */
const savedForest = () => ({
  version: 1,
  computerId: COMPUTER_ID,
  trees: ['tree-1', 'tree-2', 'tree-3'].map(id => ({ id, name: null, createdAt: STAMP, updatedAt: STAMP })),
  nodes: [
    node('node-1', 'tree-1', null),
    node('node-2', 'tree-2', null),
    node('node-3', 'tree-3', null, { status: UNKNOWN_WORD }),
    node('node-4', 'tree-3', 'node-3', { role: 'worker', message: 'do it', status: 'draft', reply: '' }),
  ],
})

async function seedAndOpen(window) {
  await window.evaluate(`localStorage.setItem(${JSON.stringify(TREES_KEY)}, ${JSON.stringify(JSON.stringify(savedForest()))})`)
  await window.evaluate(`location.hash = '#/computers'`)
  await delay(600)
  await window.evaluate(`location.reload()`)
  await delay(4200)
}

/* WHAT IS ON SCREEN. Read once, from the page, with no promise awaited inside
   it: a backgrounded window freezes page timers, so anything this driver waits
   on must be waited on from here. */
const BOARD_FN = `() => ({
  nodes: [...document.querySelectorAll('.static-tree-node')].map(el => el.dataset.agentId || null),
  statuses: [...document.querySelectorAll('[data-tree-status]')].map(el => (el.textContent || '').trim()),
  emptyCanvas: document.querySelectorAll('.static-tree-node').length === 0,
  /* The refusal banner the unavailable-store state paints, if it is up. */
  refusal: document.querySelector('[data-store-refusal], .tree-store-refusal')?.textContent?.trim()?.slice(0, 200) || null,
  bodyText: (document.body.innerText || '').slice(0, 4000),
})`

const board = window => window.evaluate(`(${BOARD_FN})()`)

/* The chip for one node, read the way the rail reads it. */
const chipFor = (window, nodeId) => window.evaluate(`(() => {
  const host = document.querySelector('.static-tree-node[data-agent-id=' + JSON.stringify(${JSON.stringify(nodeId)}) + ']')
  const rail = document.querySelector('[data-tree-status]')
  const own = host?.querySelector('[data-tree-status]')
  return ((own || rail)?.textContent || '').trim()
})()`)

/* THE RECORD, NOT THE PICTURE -- from the page. */
const savedInPage = window => window.evaluate(`localStorage.getItem(${JSON.stringify(TREES_KEY)})`)

/* THE RECORD ON DISK, after the window is gone: this is the only reading that
   proves the word went through shell/renderer-prefs.cjs and came back. */
function savedOnDisk(profile) {
  const file = path.join(userDataFor(profile), FLEET_FILE)
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const cell = parsed?.values?.[TREES_KEY]
  return { file, cell, forest: typeof cell === 'string' ? JSON.parse(cell) : null }
}

const scratch = mkdtempSync(path.join(tmpdir(), 't162-unreadable-'))
let window = null
let failed = 0
try {
  console.log('staging the packaged build...')
  const staged = await stage(scratch, RELEASE)
  assertIsolated(scratch)
  seedMachineRecord(scratch, staged.appRoot, 'standard')
  window = await openWindow(staged.executable, scratch)

  if (await window.evaluate(`location.hash.includes('setup')`) === true) {
    await window.evaluate(`location.hash = '#/computers'`)
    await delay(1500)
  }

  console.log('\nthe canvas, on a forest carrying a word this build cannot read')
  await seedAndOpen(window)
  const drawn = await board(window)

  /* 1. THE DEFECT ITSELF. Before T162 this was an empty canvas. */
  check('the canvas is not empty', !drawn.emptyCanvas, `${drawn.nodes.length} nodes drawn`)
  check('all four nodes are drawn, the unreadable one among them',
    drawn.nodes.length === 4 && drawn.nodes.includes('node-3'),
    drawn.nodes.join(', ') || 'none')
  check('the child of the unreadable node is drawn too, so no subtree went with it',
    drawn.nodes.includes('node-4'))
  check('the store did not refuse to open', drawn.refusal === null, drawn.refusal || '')

  /* 2. THE WORD THE PERSON READS. */
  const chip = await chipFor(window, 'node-3')
  check('the unreadable node has its own chip word', chip === MARKER_CHIP, `chip says "${chip}"`)
  check('it does NOT read as a node nobody has started', chip !== DRAFT_CHIP, `chip says "${chip}"`)

  /* 3. THE ROUND TRIP, through a real user action that rewrites the record and
        does not touch the marker node: open another node's rail. Any write
        re-serialises the whole forest, which is where the word would be lost. */
  await window.evaluate(`document.querySelector('.static-tree-node[data-agent-id="node-1"]')?.click()`)
  await delay(1200)
  const afterEdit = JSON.parse(await savedInPage(window) || '{}')
  const markerInPage = (afterEdit.nodes || []).find(entry => entry.id === 'node-3')
  check('the page still holds all three trees after a write', (afterEdit.trees || []).length === 3,
    `${(afterEdit.trees || []).length} trees`)
  check('the ORIGINAL word is what the page saved back', markerInPage?.status === UNKNOWN_WORD,
    `saved status ${JSON.stringify(markerInPage?.status)}`)
  check('the marker never leaks into the saved record',
    !JSON.stringify(afterEdit).includes('"unreadable"'))
} catch (error) {
  check('the driver ran to the end', false, error?.message || String(error))
} finally {
  if (window) await closeWindow(window)
}

/* 4. AND ON DISK, with the window closed and the main process gone. */
try {
  const disk = savedOnDisk(scratch)
  const markerOnDisk = (disk.forest?.nodes || []).find(entry => entry.id === 'node-3')
  console.log(`\nthe record on disk: ${disk.file}`)
  check('the fleet document file holds the seeded forest', (disk.forest?.trees || []).length === 3,
    `${(disk.forest?.trees || []).length} trees`)
  check('the ORIGINAL word reached the disk unchanged', markerOnDisk?.status === UNKNOWN_WORD,
    `on disk: ${JSON.stringify(markerOnDisk?.status)}`)
  check('nothing this build invented reached the disk', !String(disk.cell).includes('"unreadable"'))
} catch (error) {
  check('the record on disk could be read', false, error?.message || String(error))
}

if (!KEEP) rmSync(scratch, { recursive: true, force: true })

failed = checks.filter(entry => !entry.ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
