#!/usr/bin/env node

/* DRAW THE COMPUTERS PAGE WITH TWO TREES ON IT, AND LOOK AT WHAT IS THERE.
 *
 * THE DEFECT THIS EXISTS FOR. The owner reported that agents would not launch
 * and the chat bubbles beside tree nodes would not open. Both were one thing and
 * neither was in those features: refreshTreeSwitch() in src/views/computers.js
 * called `slot.prepend(host)` with `slot` undeclared -- the Split-pane removal
 * deleted the declaration and left the call site -- and that function runs at
 * mount. On any profile holding TWO OR MORE trees the ReferenceError aborted the
 * whole view before it drew anything: no tree, no nodes, no chips, no empty
 * slot, no zoom controls. Fixed in f20c39b.
 *
 * WHY EVERY GATE STAYED GREEN, which is the part this file is the answer to.
 * Multi-tree was covered by exactly one suite, tools/test/fleet-trees-multi.test.mjs,
 * whose own header reads "NO DOM, NO WINDOW, NO CONNECTION TO THE PROGRAM". The
 * view layer had never once been rendered with two trees. 2078 passing tests and
 * seven green packaged harnesses all agreed the product was fine while its main
 * page could not draw. The guard against that class cannot be another source
 * reader; it has to render the page.
 *
 * WHY THIS IS A PACKAGED DRIVER AND NOT A `node --test` FILE, measured rather
 * than assumed. src/views/computers.js imports three stylesheets (board.css,
 * tree-graph.css, agent-compose-panel.css), which a plain Node process cannot
 * load at all -- `Unknown file extension ".css"`. With a loader hook stubbing
 * those, the module graph imports in 912ms and then holds the process open on
 * six timers, because src/sim.js starts the demonstration simulator at import
 * and exposes no way to stop it. Past that, computersView() reaches echarts, a
 * canvas, a ResizeObserver and StaticTreeGraph's own layout. A hand-rolled DOM
 * large enough to satisfy all of that would be a second product, and a fake that
 * diverges from the real one passes while the real one crashes -- which is
 * exactly the failure mode being repaired. So this renders the real page in the
 * real Electron window, which is how the defect was found in the first place.
 *
 * WHAT MAKES IT DISCRIMINATE, MEASURED RATHER THAN ASSERTED. A guard nobody has
 * seen fail is a guard nobody has tested, so it was run against the defect. A
 * detached worktree at this commit with ONLY src/views/computers.js reverted to
 * f20c39b^ , built there, driven against the same packaged shell:
 *
 *   fixed      14/14 checks passed, exit 0
 *   pre-fix     6/14, exit 1 -- 0 nodes, 0 slots, no switcher, nothing pressable
 *
 * The six that still passed are the one-tree control, which is the point: the
 * harness, the profile and the staging were identical and the ONLY variable was
 * the second tree meeting that file.
 *
 * ONE CHECK BELOW IS WEAKER THAN ITS NAME WOULD SUGGEST, and it is said here
 * rather than left for the next reader to find out. "the page is not showing the
 * mount-crash sentence" PASSED on the pre-fix build: the view had died, drawn
 * nothing, and the sentence the owner saw on his own install was not in the text
 * this driver samples. So that check only reports the symptom when it is on
 * screen; what actually detects the death is the counts.
 *
 * THE POSITIVE CONTROL IS IN THE RUN. One tree is drawn first, from the same
 * profile, with only the saved record differing. Without it a page that draws
 * nothing for an unrelated reason -- a stale bundle, a profile stuck in setup --
 * would read as the two-tree defect, and this file would be reporting its own
 * harness fault as a product defect.
 *
 * ISOLATION. The shared harness stages a copy of the packaged build into a
 * temporary directory and runs it with --user-data-dir, LOCALAPPDATA, APPDATA
 * and USERPROFILE all pointed at a scratch profile. It never launches the
 * installed application: a harness pointed at the owner's live install desynced
 * his audit ledger. Nothing under release/ is written and the window is
 * headless.
 *
 *   node tools/two-tree-render-qa.mjs
 *   node tools/two-tree-render-qa.mjs --release <dir>
 *   node tools/two-tree-render-qa.mjs --visible --keep
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

/* The computer a customer machine always is. src/declared-fleet.js pins
   THIS_COMPUTER_ID = 'this-computer' precisely so a route to it survives a
   relaunch, and src/fleet-trees.js keys the saved forest by that id. Both are
   read from the source rather than typed from memory below. */
const COMPUTER_ID = 'this-computer'
const TREES_KEY = `mc.fleet.trees.v1:${COMPUTER_ID}`
const RECORD_VERSION = 1

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}

const STAMP = '2026-08-17T12:00:00.000Z'

/** A saved forest of `count` trees, each holding one finished top-level agent. */
function savedForest(count) {
  const trees = []
  const nodes = []
  for (let index = 1; index <= count; index += 1) {
    trees.push({ id: `tree-${index}`, name: null, createdAt: STAMP, updatedAt: STAMP })
    nodes.push({
      id: `node-${index}`,
      treeId: `tree-${index}`,
      parentId: null,
      role: 'manager',
      /* The first words typed into a tree are what names it in the switcher, so
         these are what the two buttons must end up saying. */
      message: `Watch release branch ${index}`,
      /* `finished`, never `running`: a saved record that claims a live session
         comes back as `starting` and would have this page waiting on a program.
         The question here is whether the page DRAWS, not what it is doing. */
      status: 'finished',
      statusNote: '',
      reply: `Done, branch ${index}.`,
      tier: 'luna',
      sessionId: null,
      createdAt: STAMP,
      updatedAt: STAMP,
    })
  }
  return { version: RECORD_VERSION, computerId: COMPUTER_ID, trees, nodes }
}

/* Move, down, up at coordinates taken from the element's own box, with
   document.elementFromPoint checked first by the shared harness's
   waitForVisible -- so a press refused because something is on top says so by
   name instead of landing on the wrong thing. */
async function press(window, selector, timeoutMs = 9000) {
  const spot = await window.waitForVisible(selector, timeoutMs)
  if (spot?.state !== 'visible') {
    return { pressed: false, why: spot?.state === 'covered' ? `covered by ${spot.by}` : (spot?.state || 'unknown') }
  }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', {
      type, x: spot.x, y: spot.y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
    await delay(45)
  }
  await delay(450)
  return { pressed: true, at: { x: Math.round(spot.x), y: Math.round(spot.y) } }
}

/* WHAT "THE BOARD DREW" MEANS, counted rather than eyeballed. Every one of these
   was zero on the broken build and non-zero on the fixed one, on the same
   profile with only the tree count varying. `pageError` is the sentence the view
   puts on screen when its own mount throws, and it is read here because a run
   that reports "0 nodes" without it sends the next reader looking in the wrong
   place. */
const BOARD_FN = `() => {
  const board = document.querySelector('.computers')
  const error = document.querySelector('.computers .error, .computers .empty-note, .board-error')
  return {
    board: Boolean(board),
    slots: document.querySelectorAll('.tree-empty-node').length,
    nodes: document.querySelectorAll('.static-tree-node').length,
    chips: document.querySelectorAll('[data-chat-chip], .node-chat-chip').length,
    switcher: Boolean(document.querySelector('.graph-bar-trees .graph-tree-switch')),
    switcherButtons: [...document.querySelectorAll('.graph-bar-trees .graph-tree-switch button')].map(b => b.textContent.trim()),
    switcherOn: [...document.querySelectorAll('.graph-bar-trees .graph-tree-switch button.on')].map(b => b.textContent.trim()),
    pageText: (document.querySelector('.computers')?.textContent || document.body.textContent || '').slice(0, 400),
    error: error ? error.textContent.trim().slice(0, 200) : null,
  }
}`

async function readBoard(window) {
  return window.evaluate(`(${BOARD_FN})()`)
}

/** Put a saved forest in front of the page and reload into it, as a relaunch would. */
async function loadWithTrees(window, count) {
  await window.evaluate(`localStorage.setItem(${JSON.stringify(TREES_KEY)}, ${JSON.stringify(JSON.stringify(savedForest(count)))})`)
  await window.evaluate(`location.hash = '#/computers'`)
  await delay(600)
  await window.evaluate(`location.reload()`)
  await delay(4200)
  return readBoard(window)
}

const scratch = mkdtempSync(path.join(tmpdir(), 'two-tree-render-'))
let window = null
try {
  console.log('staging the packaged build...')
  const staged = await stage(scratch, RELEASE)
  seedMachineRecord(scratch, staged.appRoot, 'standard')
  window = await openWindow(staged.executable, scratch)

  const inSetup = await window.evaluate(`location.hash.includes('setup')`)
  if (inSetup === true) {
    check('the build reached the product rather than stopping in setup', false,
      'nothing below would be about the computers page')
  }

  console.log('\nONE TREE -- the positive control, so a blank page cannot pass as the defect')
  const one = await loadWithTrees(window, 1)
  check('the computers board is on screen', one?.board === true, `error=${JSON.stringify(one?.error)}`)
  check('one tree draws its agent', one?.nodes >= 1, `${one?.nodes} node(s)`)
  check('one tree draws a pressable empty slot', one?.slots >= 1, `${one?.slots} slot(s)`)
  /* A switcher over one tree is chrome with no decision in it, and the view
     removes it on purpose. Asserting its ABSENCE here is what makes its presence
     below a measurement rather than a coincidence. */
  check('one tree draws no tree switcher', one?.switcher === false)

  console.log('\nTWO TREES -- the state that killed the page')
  const two = await loadWithTrees(window, 2)
  check('the computers board is STILL on screen with a second tree',
    two?.board === true, `error=${JSON.stringify(two?.error)}`)
  /* THE EXACT SYMPTOM THE OWNER READ, so a future failure is recognised instead
     of diagnosed from a count of zero. It is NOT the detector: measured on the
     pre-fix build, this passed while the board was empty, because the sentence
     did not reach the text sampled here. The counts are what catch the death. */
  check('the page is not showing the mount-crash sentence',
    !/is not defined|could not be fetched/i.test(String(two?.pageText || '')),
    String(two?.pageText || '').replace(/\s+/g, ' ').trim().slice(0, 160))
  check('both trees draw their agents', two?.nodes >= 2, `${two?.nodes} node(s)`)
  check('the board still draws pressable empty slots', two?.slots >= 2, `${two?.slots} slot(s)`)
  check('the tree switcher is drawn', two?.switcher === true)
  check('the switcher offers every tree plus Every tree',
    Array.isArray(two?.switcherButtons) && two.switcherButtons.length >= 3,
    JSON.stringify(two?.switcherButtons))
  check('the switcher is in the styled slot, not beside the zoom tools',
    two?.switcher === true,
    'read through .graph-bar-trees .graph-tree-switch, which is what board.css styles')

  console.log('\nA REAL PRESS on the second tree, because a drawn control that does nothing is not drawn')
  const pressed = await press(window, '.graph-bar-trees .graph-tree-switch button:nth-child(3)')
  check('the second tree button can actually be pressed',
    pressed.pressed === true, pressed.pressed ? `at (${pressed.at.x}, ${pressed.at.y})` : pressed.why)
  const after = await readBoard(window)
  check('pressing it selects that tree', Array.isArray(after?.switcherOn) && after.switcherOn.length === 1
    && after.switcherOn[0] !== 'Every tree', JSON.stringify(after?.switcherOn))
  check('and the board is still drawn after the press',
    after?.board === true && after?.nodes >= 1, `${after?.nodes} node(s)`)
} finally {
  if (window) {
    /* BOUNDED, BECAUSE A GRACEFUL CLOSE CAN HANG THE RUN. closeWindow() awaits
       a window.close() sent over the debugger, and a page that has already gone
       never answers -- measured here as node exiting 13 on an unsettled
       top-level await, with all fourteen checks green. A teardown that can turn
       a passing run into a failing exit code is a harness fault that would be
       read as a product defect. */
    await Promise.race([closeWindow(window), delay(8000)]).catch(() => {})
    reap(window.child?.pid)
  }
  if (!KEEP) { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }) } catch { /* held by a dying child */ } }
}

const failed = checks.filter(entry => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.error(`${failed.length} of ${checks.length} CHECK(S) FAILED: ${failed.map(entry => entry.name).join('; ')}`)
  process.exit(1)
}
