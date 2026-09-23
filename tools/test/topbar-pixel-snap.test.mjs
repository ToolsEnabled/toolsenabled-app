/* D1/D2, TEXT SHARPNESS -- the rendered proof.
 *
 * D2. The top strip was centred with `left: 50%; transform: translateX(-50%)`.
 * On every page that loads src/sidebar-pages.css the gutter is
 * clamp(20px, 2.4vw, 40px), so the bar's width is fractional and the pair put
 * its left edge on a fraction of a pixel; the whole strip is then composited
 * at that offset and its glyphs are resampled. This suite reads the real
 * sheets in a real (hidden, offscreen) window at three window widths and
 * holds the left edge on a whole pixel -- while still holding the bar
 * CENTRED, so a dropped or mistyped declaration cannot pass as sharp.
 *
 * D1. The same window reports the resting `will-change` of the three text
 * families that carried a permanent compositing hint: a graph node, a context
 * chip and a metrics data row. At rest none of them may promote a layer; the
 * node's hint is allowed back for the duration of a drag.
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
const data = fs.mkdtempSync(testScratchRoot('topbar-pixel-snap-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({
    entryPoints: [path.join(root, 'tools/test/helpers/topbar-pixel-snap-renderer.mjs')],
    bundle: true, format: 'iife', outfile: path.join(data, 'fixture.js'),
    loader: { '.woff2': 'dataurl' }, logLevel: 'silent',
    /* esbuild resolves from the file's own directory and does not read
       NODE_PATH, so this suite could not BUILD in a worktree that borrows
       the shared dependency store -- the only way to run it without a
       node_modules junction, and junctions cost this machine 76 packages on
       2026-09-15. Assertion-neutral: empty and inert when the tree has its
       own dependencies. */
    nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter).filter(Boolean) : [],
  })
  fs.writeFileSync(path.join(data, 'index.html'), `<!doctype html>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data:">
    <link rel="stylesheet" href="./fixture.css">
    <body><script src="./fixture.js"></script></body>`)
  const result = await promisify(execFile)(require('electron'), [
    path.join(root, 'tools/test/helpers/topbar-pixel-snap-electron.cjs'), data,
  ], { cwd: root, env, windowsHide: true, timeout: 45000, maxBuffer: 1048576 })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(result, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally {
  esbuild.stop()
  console.log('Top bar sharpness evidence: ' + data)
}

test('the hidden window painted every width and route it was asked for', () => {
  assert.equal(observed.failure, undefined, JSON.stringify(observed.failure))
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  assert.deepEqual(
    observed.rows.map(row => [row.requestedWidth, row.route]),
    [[1440, 'default'], [1440, 'sidebar'], [1441, 'default'], [1441, 'sidebar'],
      [1120, 'default'], [1120, 'sidebar'], [1121, 'default'], [1121, 'sidebar'],
      [2560, 'default'], [2560, 'sidebar'], [2561, 'default'], [2561, 'sidebar']],
  )
})

const centred = () => observed.rows.filter(row => row.route === 'default')

test('the centred top bar lands on a whole pixel at every measured width and keeps no centring transform', () => {
  for (const row of centred()) {
    assert.equal(row.position, 'fixed', `the strip stopped being fixed at ${row.viewportWidth}px`)
    assert.equal(row.leftIsWhole, true, `left edge ${row.left} at ${row.viewportWidth}px`)
    assert.equal(row.centred, true, `bar off centre at ${row.viewportWidth}px: ${JSON.stringify(row)}`)
    assert.equal(row.transform, 'none', `a centring transform is back at ${row.viewportWidth}px: ${row.transform}`)
  }
})

test('the sample still contains the fractional centre the old spelling could not round', () => {
  /* Not decoration. `left: 50%` + `translateX(-50%)` produces a whole left
     edge whenever the true centre is already whole, so a sample of only those
     widths would pass with the defect still in place. At least one measured
     width must put the true centre on a half pixel, or this guard is dead. */
  const fractional = centred().filter(row => !Number.isInteger(row.exactCentre))
  assert.ok(fractional.length > 0,
    `every measured width centres on a whole pixel already: ${JSON.stringify(centred().map(row => [row.viewportWidth, row.exactCentre]))}`)
  for (const row of fractional) {
    assert.equal(Number.isInteger(row.left), true,
      `the bar kept a fractional left edge where it matters most (${row.viewportWidth}px): ${row.left}`)
  }
})

test('side navigation still replaces the bar with its full-height rail, untouched by the centring', () => {
  /* The scope of the fix, stated as a fact rather than assumed: on these
     routes src/app-navigation.css overrides the strip into a left rail
     (`inset: 0 auto 0 0`), so neither the old transform nor the new rounding
     reaches them. */
  for (const row of observed.rows.filter(row => row.route === 'sidebar')) {
    assert.equal(row.left, 0, `the rail moved off the left edge at ${row.viewportWidth}px`)
    assert.equal(row.width, 200, `the rail is no longer --navigation-width at ${row.viewportWidth}px`)
    assert.equal(row.transform, 'none')
  }
})

test('no text layer is composited at rest; a dragged node may still be promoted', () => {
  const { node, nodeDragging, nodeAfterDrag, chip, metricsRow } = observed.resting
  assert.equal(node, 'auto', `a resting graph node promotes a layer: will-change ${node}`)
  assert.equal(chip, 'auto', `a resting context chip promotes a layer: will-change ${chip}`)
  assert.equal(metricsRow, 'auto', `a resting metrics row promotes a layer: will-change ${metricsRow}`)
  assert.equal(nodeDragging, 'transform', `a dragged node lost its hint: will-change ${nodeDragging}`)
  assert.equal(nodeAfterDrag, 'auto', `the drag hint outlived the drag: will-change ${nodeAfterDrag}`)
})
