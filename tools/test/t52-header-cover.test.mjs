/* T52(2). "THERE IS A SMALL GAP AT THE TOP SO AS YOU SCROLL YOU SEE TEXT ABOVE
 * THE HEADER." — the owner, 2026-09-15.
 *
 * WHAT WAS ACTUALLY WRONG, and it was not the first suspect. The D1/D2 change
 * (`7a9df357`) touched only `left` and `transform`. `top: 14px` has been on
 * `.topbar` since the rule was written (`1752bbc0`), and the strip declares
 * `background: none` with no backdrop-filter, while the page shells in
 * src/sidebar-pages.css are `padding-top: 0`. So a scrolled page ran straight
 * through the 14px band above the bar — and behind the controls as well.
 *
 * WHY THIS IS A PIXEL TEST. `elementFromPoint` cannot answer it: the cover
 * keeps `pointer-events: none` so it does not begin swallowing clicks that used
 * to reach the page, which means hit-testing looks straight through it and
 * reports the page text as the top element whether it is painted or not. Only
 * the painted result answers the owner's sentence, so this reads the window's
 * pixels.
 *
 * THE BAND IS THE 14px ABOVE THE CONTROLS, not the whole header. The 44px the
 * controls occupy legitimately carries the wordmark; a gate demanding a blank
 * header would fail on the product's own chrome and would be deleted by the
 * next person to see it.
 *
 *   node --test tools/test/t52-header-cover.test.mjs
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
const data = fs.mkdtempSync(testScratchRoot('t52-header-cover-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({
    entryPoints: [path.join(root, 'tools/test/helpers/t52-header-cover-renderer.mjs')],
    bundle: true, format: 'iife', outfile: path.join(data, 'fixture.js'),
    loader: { '.woff2': 'dataurl' }, logLevel: 'silent',
    /* esbuild's bundler resolves from the file's own directory and does NOT
       read NODE_PATH, so a worktree without its own node_modules fails here on
       the font packages while `node` itself resolves everything. Passing the
       variable through keeps this suite runnable from a tree that borrows the
       shared dependency store — which is the only way to run it without
       creating a node_modules junction, and junctions are what cost this
       machine 76 packages on 2026-09-15. Empty and inert when the tree has its
       own dependencies, so nothing changes for an ordinary checkout. */
    nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter).filter(Boolean) : [],
  })
  fs.writeFileSync(path.join(data, 'index.html'), `<!doctype html>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data:">
    <link rel="stylesheet" href="./fixture.css">
    <body><script src="./fixture.js"></script></body>`)
  const result = await promisify(execFile)(require('electron'), [
    path.join(root, 'tools/test/helpers/t52-header-cover-electron.cjs'), data,
  ], { cwd: root, env, windowsHide: true, timeout: 90000, maxBuffer: 4 * 1048576 })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(result, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally {
  esbuild.stop()
  console.log('T52 header cover evidence: ' + data.replaceAll('\\', '/'))
}

const rows = () => observed.rows

test('the hidden window painted every width and scroll offset it was asked for', () => {
  assert.equal(observed.failure, undefined, JSON.stringify(observed.failure))
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  assert.equal(observed.visible, false)
  assert.equal(observed.destroyed, true)
  assert.equal(rows().length, 15, `three widths by five scroll offsets: ${rows().length}`)
})

test('the page really does scroll, so the band being clean means something', () => {
  const scrolled = rows().filter(row => row.requestedScroll > 0)
  for (const row of scrolled) {
    assert.ok(row.scrollTop > 0,
      `the fixture did not scroll at ${row.requestedWidth}px / ${row.requestedScroll}: a page that never moved would pass the band check while proving nothing (${JSON.stringify(row.scrollTop)})`)
  }
})

test('the header keeps its position and its inset', () => {
  for (const row of rows()) {
    assert.equal(row.barPosition, 'fixed', `the strip stopped being fixed at ${row.requestedWidth}px`)
    assert.equal(row.barTop, 14, `the bar's inset moved at ${row.requestedWidth}px: ${row.barTop}`)
  }
})

test('a full-width cover reaches the very top of the window', () => {
  for (const row of rows()) {
    assert.equal(row.cover.position, 'fixed', `the cover is not fixed at ${row.requestedWidth}px: ${JSON.stringify(row.cover)}`)
    assert.equal(row.cover.top, '0px', `the cover does not start at the top at ${row.requestedWidth}px: ${JSON.stringify(row.cover)}`)
    assert.equal(row.cover.left, '0px', `the cover must span the window, not the centred bar: ${JSON.stringify(row.cover)}`)
    assert.equal(row.cover.height, '58px', `the cover must reach the bottom of the bar: ${JSON.stringify(row.cover)}`)
    assert.equal(row.cover.background, row.background,
      `the cover must paint the page's own background token so every theme follows it: ${JSON.stringify(row.cover)} vs ${row.background}`)
  }
})

/* THE OWNER'S SENTENCE, MEASURED. */
test('nothing from the page is ever painted above the header, at any width or scroll offset', () => {
  for (const row of rows()) {
    assert.ok(row.band.sampledRows > 0, `no pixels were sampled at ${row.requestedWidth}px`)
    assert.equal(row.band.distinct, 1,
      `TEXT ABOVE THE HEADER at ${row.requestedWidth}px scrolled to ${row.scrollTop}: the strip above the bar should be one flat colour and holds ${row.band.distinct}. `
      + `Colours found: ${JSON.stringify(row.band.colours)}`)
  }
})
