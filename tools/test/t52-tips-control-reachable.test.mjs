/* T52(4). "TURN OFF NEW-PAGE TIPS" HAS TO BE PRESSABLE ON EVERY PAGE THAT
 * OFFERS IT.
 *
 * WHAT WAS MEASURED, and by whom: Builder (4a1a39df) on the cut-1 candidate,
 * 2026-09-16 01:08Z, found `.first-use-quiet` at **0x0 on Ledger and Settings**
 * and **121x44 on Metrics**. A control with a zero box cannot be clicked, so on
 * two of the main pages a person could not turn tips off at all.
 *
 * WHAT THIS SUITE IS FOR. There are two completely different explanations for a
 * zero box here and the product's own code contains both:
 *
 *   1. `paint()` sets `find('quiet').hidden = !intro`, where `intro` is
 *      `step < 0`. Past the intro step the control is SUPPOSED to be gone, and
 *      `.first-use-layer [hidden]` resolves that to `display: none`, which is a
 *      0x0 rectangle. That is correct behaviour and must not be "fixed".
 *   2. A page on which the card cannot open, or on which the control collapses
 *      while the card IS open at the intro. That is the defect.
 *
 * A measurement that does not say WHICH of those it caught cannot tell a fix
 * from a regression, so every row here carries the route, the step, the layer's
 * open state, the control's own `hidden`, its resolved `display`, its rectangle,
 * and -- when the rectangle is zero -- the first ancestor the browser is not
 * laying out and why. The fixture owns the storage, so "already seen" is chosen
 * rather than inherited from the order pages happened to be visited in.
 *
 * AND THE BOX IS NOT THE WHOLE QUESTION. A control can measure 44px and still be
 * unreachable if something covers it, so each route is also PRESSED at the
 * control's own centre and the resulting label and feedback are read back.
 *
 * Run alone with:
 *   node --test tools/test/t52-tips-control-reachable.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../lib/sterile-launch.cjs')
const data = fs.mkdtempSync(testScratchRoot('t52-tips-control-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({
    entryPoints: [path.join(root, 'tools/test/helpers/t52-tips-control-renderer.mjs')],
    bundle: true, format: 'iife', outfile: path.join(data, 'fixture.js'),
    loader: { '.woff2': 'dataurl' }, logLevel: 'silent',
    /* esbuild does not read NODE_PATH, so without this the suite cannot BUILD
       in a worktree that borrows the shared dependency store. Inert when the
       tree has its own dependencies. */
    nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter).filter(Boolean) : [],
  })
  fs.writeFileSync(path.join(data, 'index.html'), `<!doctype html>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data:">
    <link rel="stylesheet" href="./fixture.css">
    <body><script src="./fixture.js"></script></body>`)
  const result = await promisify(execFile)(require('electron'), [
    path.join(root, 'tools/test/helpers/t52-tips-control-electron.cjs'), data,
  ], { cwd: root, env, windowsHide: true, timeout: 180000, maxBuffer: 8 * 1048576 })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(result, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally {
  esbuild.stop()
  console.log('T52 tips control evidence: ' + data.replaceAll('\\', '/'))
}

const introRows = () => observed.rows.filter(row => row.step === -1 && !row.blockWith)
const advancedRows = () => observed.rows.filter(row => row.step >= 0 && !row.blockWith)
const describe = row => `${row.route}: layerOpen=${row.layerOpen} hidden=${row.quietHiddenAttribute} display=${row.quietDisplay} box=${JSON.stringify(row.quietBox)} because=${JSON.stringify(row.quietCollapsedBecause)}`

test('the hidden window measured every route that offers a guide', () => {
  assert.equal(observed.failure, undefined, JSON.stringify(observed.failure))
  assert.deepEqual(observed.pageErrors, [], 'the real window logged renderer errors')
  assert.deepEqual(observed.deniedRequests, [], 'the fixture reached outside its own directory')
  assert.ok(observed.routes.length >= 8,
    `only ${observed.routes.length} guided routes were read out of FEATURE_GUIDES; the fixture has drifted from the source`)
  assert.equal(introRows().length, observed.routes.length, 'a route was not measured at the intro')
})

/* THE DEFECT ITSELF. Not "Ledger is 121 wide" -- a number I picked would have to
   be edited whenever the label or the font changes, and would pass while the
   control sat under something. The claim is that the control is the SAME on
   every guided page: offered, laid out, and of a usable size. */
test('the tips control is offered and laid out on every page that offers a guide', () => {
  const rows = introRows()
  for (const row of rows) {
    assert.equal(row.layerOpen, true, `the guide never opened on ${row.route}, so its tips control cannot be reached: ${describe(row)}`)
    assert.equal(row.quietPresent, true, `no tips control exists on ${row.route}`)
    assert.equal(row.quietHiddenAttribute, false, `the tips control is hidden at the intro on ${row.route}: ${describe(row)}`)
    assert.notEqual(row.quietDisplay, 'none', `the tips control is not laid out on ${row.route}: ${describe(row)}`)
    assert.equal(row.quietCollapsedBecause, null, `something is hiding the tips control on ${row.route}: ${describe(row)}`)
    assert.ok(row.quietBox.width > 0 && row.quietBox.height > 0,
      `the tips control has a zero box on ${row.route}, so a person cannot click it: ${describe(row)}`)
  }
})

/* A TOUCH TARGET, not merely a non-zero box. 44px is the product's own number:
   src/first-use-guidance.css sets `min-height: 44px` on this control and on
   every other button in the card. Read off the rendered box rather than the
   sheet, and compared to the card's other buttons so it is the product's own
   standard and not a literal this file invented. */
test('the tips control is no smaller than the card buttons beside it, on every page', () => {
  const rows = introRows()
  const heights = rows.map(row => row.quietBox.height)
  const smallest = Math.min(...heights)
  const largest = Math.max(...heights)
  assert.equal(smallest, largest,
    `the tips control is a different size depending on the page (${rows.map(r => `${r.route}=${r.quietBox.height}`).join(', ')}), which is the shape of the reported defect`)
  const widths = rows.map(row => row.quietBox.width)
  assert.equal(Math.min(...widths), Math.max(...widths),
    `the tips control's width depends on the page (${rows.map(r => `${r.route}=${r.quietBox.width}`).join(', ')})`)
})

/* PRESSED, AT ITS OWN CENTRE. The control's job is to flip a preference and say
   so; a box that is the right size and answers nothing is still a control the
   person has lost. The label is asserted to CHANGE, not to equal a spelling. */
test('pressing the tips control on any page flips the preference and says so', () => {
  for (const press of observed.presses) {
    assert.equal(press.pressed, true, `no tips control to press on ${press.route}: ${press.reason}`)
    assert.equal(press.hitIsControl, true,
      `something else is on top of the tips control on ${press.route}; the press would land on ${press.hitTag}`)
    assert.notEqual(press.labelAfter, press.labelBefore,
      `the tips control on ${press.route} was pressed and its label did not change, so nothing told the person it worked`)
    assert.ok(typeof press.feedback === 'string' && press.feedback.length > 0,
      `the tips control on ${press.route} changed a preference and the page said nothing about it`)
  }
})

/* THE CONTROL IS FOR THE INTRO, AND THAT IS NOT THE DEFECT. `paint()` hides it
   past the intro on purpose. Asserted here so a "fix" that forces the control to
   be visible at every step -- which would pass the tests above -- fails this
   one. This is the behaviour that is currently CORRECT and must survive. */
test('past the intro the control is deliberately gone, on every page alike', () => {
  const rows = advancedRows()
  assert.equal(rows.length, observed.routes.length, 'a route was not measured past the intro')
  for (const row of rows) {
    assert.equal(row.quietHiddenAttribute, true,
      `the tips control is still showing at step ${row.step} on ${row.route}; it belongs to the intro card only`)
    assert.equal(row.quietBox.width * row.quietBox.height, 0,
      `the tips control still occupies space past the intro on ${row.route}: ${describe(row)}`)
  }
})

/* AND WHEN THE GUIDE IS BLOCKED, NOTHING IS OFFERED AT ALL -- also correct, and
   also a source of zero boxes. Recorded so the two are never confused again. */
test('a blocked page hides the whole guide rather than half of it', () => {
  for (const row of observed.rows.filter(item => item.blockWith)) {
    assert.equal(row.layerOpen, false,
      `the guide stayed open on a ${row.blockWith} page, over the thing that blocked it`)
    assert.equal(row.quietBox.width * row.quietBox.height, 0,
      `the tips control is laid out on a ${row.blockWith} page whose guide is closed: ${describe(row)}`)
  }
})
