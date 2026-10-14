#!/usr/bin/env node

/* DRAG A NODE ONTO AN EMPTY SLOT, WITH A REAL MOUSE, AND SEE WHETHER IT LANDS.
 *
 * THE DEFECT THIS EXISTS FOR, in the owner's words: "edit had been working;
 * drag a node to a new node slot; on the same tree, on a new tree, or on a
 * different tree. On pg2 you cant drag and drop the nodes onto the new bubbles
 * anymore."
 *
 * WHY IT HAD TO BE WRITTEN. This gesture had NO harness. tools/page2-qa.cjs is
 * the only driver in the repository that drags at all, and it chooses its
 * reparent pair by smallest on-screen distance -- which in any real tree is a
 * SAME-ROW pair, the one case that never broke. Twelve other harnesses
 * reference `.tree-empty-node` and every one of them only presses it to open
 * the compose panel. So the product shipped a broken drop with every gate
 * green, twice.
 *
 * WHAT BROKE IT. c06c44c clamped the LIVE drag into the node's rank corridor --
 * half the pitch to the neighbouring row. Every empty slot is in a different
 * row from the node you would drag onto it (the new-tree slot is in row 0, a
 * child slot is one row below its parent), contact needs about 77px between
 * centres, and half a pitch is 200px on a 620px two-row canvas. The node
 * stopped half-way and the ring never lit. src/tree-layout.js dragBand() is the
 * fix: the corridor, widened by the reach of the targets on screen.
 *
 * REAL INPUT ONLY, AND THE DRAG IS A DRAG. Press, then MANY moves, then
 * release -- not a teleport from A to B, because the drop target is chosen
 * during pointermove and a single jump would not exercise the clamp that was
 * the defect. Every coordinate comes from the element's own box with
 * document.elementFromPoint checked first, so a press that landed on something
 * else says so by name.
 *
 * WHAT IT MEASURES, and it is the STORE, not the picture: after each drop the
 * saved forest is read back and the node's parentId and treeId are compared.
 * A ring that lights and a move that is not recorded is the failure this whole
 * area keeps producing.
 *
 * IT SPENDS NOTHING. No agent is started: the forest is seeded into the saved
 * record the way a returning person's tree really is, and the gesture under
 * test is pure geometry.
 *
 *   node tools/tree-drag-drop-drive.mjs
 *   node tools/tree-drag-drop-drive.mjs --visible --keep
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  argument,
  closeWindow,
  delay,
  openWindow,
  reap,
  releaseDirectory,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'

const RELEASE = path.resolve(argument('--release', releaseDirectory()))
const KEEP = process.argv.includes('--keep')

const COMPUTER_ID = 'this-computer'
const TREES_KEY = `mc.fleet.trees.v1:${COMPUTER_ID}`
const STAMP = '2026-08-17T12:00:00.000Z'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}

function node(id, treeId, parentId, role, message) {
  return {
    id, treeId, parentId, role, message,
    status: 'finished', statusNote: '', reply: 'Done.', tier: 'luna',
    sessionId: null, createdAt: STAMP, updatedAt: STAMP,
  }
}

/* TWO TREES, AND A PARENT WITH A CHILD IN THE FIRST.
   That shape is the smallest one that offers all three of the owner's cases at
   once: a child slot under `boss` in tree 1 (same tree), the new-tree slot
   (new tree), and a child slot under `other` in tree 2 (different tree). */
function savedForest() {
  return {
    version: 1,
    computerId: COMPUTER_ID,
    trees: [
      { id: 'tree-1', name: null, createdAt: STAMP, updatedAt: STAMP },
      { id: 'tree-2', name: null, createdAt: STAMP, updatedAt: STAMP },
    ],
    nodes: [
      node('boss', 'tree-1', null, 'manager', 'Watch the release branch'),
      node('worker', 'tree-1', 'boss', 'default', 'Count the failing checks'),
      node('other', 'tree-2', null, 'coordinator', 'Keep the second job apart'),
    ],
  }
}

/* Where an element really is, and whether the point belongs to it. Same shape
   as tools/lib/fleet-node.mjs's gate: an ancestor hit is refused by name,
   because a gesture the control never felt reported as a drag is a false
   green. */
const SPOT_FN = `(selector) => {
  const el = document.querySelector(selector)
  if (!el) return { state: 'absent' }
  const box = el.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return { state: 'zero-size' }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { state: 'offscreen', box: { x: box.x, y: box.y, w: box.width, h: box.height } }
  const hit = document.elementFromPoint(x, y)
  if (!hit) return { state: 'covered', by: 'nothing' }
  const receives = hit === el || el.contains(hit)
  if (!receives) {
    const name = hit.tagName + (hit.className ? '.' + String(hit.className).split(' ')[0] : '')
    return { state: 'covered', by: hit.contains(el) ? ('own-ancestor-' + name) : name }
  }
  return { state: 'visible', x, y }
}`

async function spot(window, selector, timeoutMs = 9000) {
  const until = Date.now() + timeoutMs
  let last = { state: 'absent' }
  for (;;) {
    last = await window.evaluate(`(${SPOT_FN})(${JSON.stringify(selector)})`)
    if (last?.state === 'visible' || Date.now() >= until) return last
    await delay(220)
  }
}

async function press(window, selector) {
  const at = await spot(window, selector)
  if (at?.state !== 'visible') return { pressed: false, why: at?.state === 'covered' ? `covered by ${at.by}` : (at?.state || 'unknown') }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', {
      type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
    await delay(45)
  }
  await delay(400)
  return { pressed: true }
}

/* THE GESTURE. Press on the node, walk to the target in `steps` moves, release.
   The walk is what makes this a drag: _updateDropTarget runs on pointermove and
   the clamp that was the defect applies there, so a two-point jump would prove
   nothing about it. */
async function dragOnto(window, fromSelector, toSelector, { steps = 18 } = {}) {
  const from = await spot(window, fromSelector)
  if (from?.state !== 'visible') return { ok: false, why: `source ${from?.state === 'covered' ? `covered by ${from.by}` : from?.state}` }
  const to = await spot(window, toSelector)
  if (to?.state !== 'visible') return { ok: false, why: `target ${to?.state === 'covered' ? `covered by ${to.by}` : to?.state}` }

  const send = (type, x, y, extra = {}) => window.session.send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' && !extra.dragging ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1,
  })

  await send('mouseMoved', from.x, from.y)
  await delay(60)
  await send('mousePressed', from.x, from.y)
  await delay(90)
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps
    await window.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      button: 'left',
      buttons: 1,
      clickCount: 0,
    })
    await delay(28)
  }
  await delay(140)
  await send('mouseReleased', to.x, to.y)
  await delay(700)
  return { ok: true, from: { x: Math.round(from.x), y: Math.round(from.y) }, to: { x: Math.round(to.x), y: Math.round(to.y) } }
}

/* THE RECORD, NOT THE PICTURE. */
async function readForest(window) {
  const raw = await window.evaluate(`localStorage.getItem(${JSON.stringify(TREES_KEY)})`)
  try {
    const parsed = JSON.parse(raw)
    const nodes = {}
    for (const entry of parsed.nodes || []) nodes[entry.id] = { parentId: entry.parentId ?? null, treeId: entry.treeId }
    return { nodes, trees: (parsed.trees || []).map(tree => tree.id) }
  } catch {
    return { nodes: {}, trees: [] }
  }
}

async function board(window) {
  return window.evaluate(`(() => ({
    nodes: document.querySelectorAll('.static-tree-node').length,
    slots: [...document.querySelectorAll('.tree-empty-node')].map(s => s.dataset.emptySlot),
    editing: document.querySelector('.graph-edit-btn')?.textContent?.trim() || null,
    /* aria-disabled, not disabled: the blocked Edit stays pressable so a
       press can be answered in words (see syncEditAvailability). */
    editDisabled: document.querySelector('.graph-edit-btn')?.getAttribute('aria-disabled') === 'true',
    status: document.querySelector('[data-org-status], .graph-status')?.textContent?.trim()?.slice(0, 160) || null,
  }))()`)
}

async function reload(window) {
  await window.evaluate(`localStorage.setItem(${JSON.stringify(TREES_KEY)}, ${JSON.stringify(JSON.stringify(savedForest()))})`)
  await window.evaluate(`location.hash = '#/computers'`)
  await delay(500)
  await window.evaluate(`location.reload()`)
  await delay(4200)
}

const scratch = mkdtempSync(path.join(tmpdir(), 'tree-drag-drop-'))
let window = null
try {
  console.log('staging the packaged build...')
  const staged = await stage(scratch, RELEASE)
  seedMachineRecord(scratch, staged.appRoot, 'standard')
  window = await openWindow(staged.executable, scratch)

  const inSetup = await window.evaluate(`location.hash.includes('setup')`)
  if (inSetup === true) {
    await window.evaluate(`location.hash = '#/computers'`)
    await delay(1500)
  }

  /* ---- case 1: same tree, onto the child slot under another parent ---- */
  await reload(window)
  let drawn = await board(window)
  check('the board draws the seeded forest', drawn.nodes >= 3, `${drawn.nodes} nodes`)
  const edit = await press(window, '.graph-edit-btn')
  check('the Edit control can be pressed', edit.pressed, edit.why || '')
  drawn = await board(window)
  check('edit mode is on', drawn.editing === 'Done', `button says "${drawn.editing}"${drawn.editDisabled ? ' (disabled)' : ''}`)
  check('empty slots are offered in edit mode', drawn.slots.length > 0, drawn.slots.join(', '))

  const sameTree = await dragOnto(window, '[data-agent-id="other"]', '[data-empty-slot="empty:child:boss"]')
  check('a drag onto the child slot under another parent completes', sameTree.ok, sameTree.why || `${JSON.stringify(sameTree.from)} -> ${JSON.stringify(sameTree.to)}`)
  let forest = await readForest(window)
  check(
    'the store records the move: the node now reports to that parent',
    forest.nodes.other?.parentId === 'boss' && forest.nodes.other?.treeId === 'tree-1',
    `other -> parent ${forest.nodes.other?.parentId}, tree ${forest.nodes.other?.treeId}`,
  )

  /* ---- case 2: out to a new tree ---- */
  await reload(window)
  await press(window, '.graph-edit-btn')
  let slots = (await board(window)).slots
  const newTreeSlot = slots.find(id => id === 'empty:new-tree')
  if (!newTreeSlot) {
    check('the new-tree slot is on the canvas', false, `slots: ${slots.join(', ') || 'none'}`)
  } else {
    const outward = await dragOnto(window, '[data-agent-id="worker"]', '[data-empty-slot="empty:new-tree"]')
    check('a drag onto the new-tree slot completes', outward.ok, outward.why || '')
    forest = await readForest(window)
    check(
      'the store records a NEW tree holding that node',
      forest.nodes.worker?.parentId === null && forest.nodes.worker?.treeId !== 'tree-1',
      `worker -> parent ${forest.nodes.worker?.parentId}, tree ${forest.nodes.worker?.treeId}; trees ${forest.trees.join(', ')}`,
    )
  }

  /* ---- case 3: onto a slot in a DIFFERENT tree, TWO ROWS DOWN ----
     The depths have to differ, and this is the case that says so. Measured
     2026-08-18 against the pre-fix build: `worker` (row 1) onto
     `empty:child:other` (also row 1) PASSED even with the corridor in place,
     because a same-row drop never needed to leave the band. Only a drop that
     changes row was broken. A harness whose cross-tree case happened to be
     same-row would have reported this defect fixed while two thirds of it
     stood, so the cross-tree case is the one with the row change in it. */
  await reload(window)
  await press(window, '.graph-edit-btn')
  slots = (await board(window)).slots
  const deepSlot = slots.find(id => id === 'empty:child:worker')
  if (!deepSlot) {
    check('the first tree offers a slot two rows down', false, `slots: ${slots.join(', ') || 'none'}`)
  } else {
    /* `other` is the top of tree 2 (row 0); `empty:child:worker` hangs under a
       child of tree 1's top (row 2). Two rows and two trees in one gesture. */
    const across = await dragOnto(window, '[data-agent-id="other"]', '[data-empty-slot="empty:child:worker"]')
    check('a drag onto a slot two rows down in a different tree completes', across.ok, across.why || '')
    forest = await readForest(window)
    check(
      'the store records the cross-tree move: node and tree both change',
      forest.nodes.other?.parentId === 'worker' && forest.nodes.other?.treeId === 'tree-1',
      `other -> parent ${forest.nodes.other?.parentId}, tree ${forest.nodes.other?.treeId}`,
    )
  }

  /* ---- case 4: the same-row cross-tree drop, which never broke ----
     Kept as the POSITIVE CONTROL. If this one ever goes red the fault is in
     the harness or the store, not in the band -- and a run where every case
     fails together is a run that measured nothing. */
  await reload(window)
  await press(window, '.graph-edit-btn')
  const sameRow = await dragOnto(window, '[data-agent-id="worker"]', '[data-empty-slot="empty:child:other"]')
  check('control: the same-row cross-tree drop still completes', sameRow.ok, sameRow.why || '')
  forest = await readForest(window)
  check(
    'control: the store records it',
    forest.nodes.worker?.parentId === 'other' && forest.nodes.worker?.treeId === 'tree-2',
    `worker -> parent ${forest.nodes.worker?.parentId}, tree ${forest.nodes.worker?.treeId}`,
  )
} finally {
  if (window) {
    await closeWindow(window)
    reap(window.timeline.pid)
  }
  if (!KEEP) {
    try { rmSync(scratch, { recursive: true, force: true }) } catch { /* the OS will */ }
  } else {
    console.log(`kept: ${scratch}`)
  }
}

const failed = checks.filter(entry => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`failing: ${failed.map(entry => entry.name).join(' | ')}`)
  process.exitCode = 1
}
