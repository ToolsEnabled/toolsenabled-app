/* T52(3). "THE METRICS PAGE STILL DOESNT SEEM TO HAVE ITS FORMATTING LANDED OR
 * NEEDS ITS FORMATTING REWORKED BECAUSE THERES HUGE SIDE GAPS AT TIMES."
 * — the owner, 2026-09-15.
 *
 * WHAT IT WAS. Under the side navigation, Home and Settings were given
 * `max-width: none` on 2026-09-10 for the owner's earlier sentence, "use up the
 * side white space since we changed to a sidebar". Metrics was left out, so
 * styles.css's `.metrics { max-width: var(--page-max) }` kept meeting this
 * route's `--page-max: 1440px`. Measured before the fix, rendered, at a 1920px
 * window: Ledger 1920 and Settings 1920, both flush; Computers 1888 with its
 * own 16px gutter; **Metrics 1440, a 480px gap split 240 a side**. The gap
 * exists only above 1440 and grows with the window, which is exactly the
 * owner's "at times".
 *
 * THE COMPARISON IS THE OTHER PAGES, NOT A NUMBER I PICKED. A gate that pinned
 * Metrics to some chosen width would pass while Metrics still looked wrong
 * beside Ledger, and would have to be edited every time the page column
 * changes. So this asserts that Metrics matches its sidebar siblings, whatever
 * they are.
 *
 * COMPUTERS IS DELIBERATELY NOT A SIBLING HERE: it keeps a 16px gutter by its
 * own rule at every width, which is a different and intentional layout. It is
 * still measured, and its constancy is asserted, so a change that dragged it
 * along with Metrics fails here.
 *
 *   node --test tools/test/t52-metrics-width.test.mjs
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
const data = fs.mkdtempSync(testScratchRoot('t52-metrics-width-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({
    entryPoints: [path.join(root, 'tools/test/helpers/t52-metrics-width-renderer.mjs')],
    bundle: true, format: 'iife', outfile: path.join(data, 'fixture.js'),
    loader: { '.woff2': 'dataurl' }, logLevel: 'silent',
    /* See the same line in topbar-pixel-snap: esbuild does not read NODE_PATH,
       so without this the suite cannot BUILD in a worktree that borrows the
       shared dependency store instead of junctioning to it. Inert when the tree
       has its own dependencies. */
    nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter).filter(Boolean) : [],
  })
  fs.writeFileSync(path.join(data, 'index.html'), `<!doctype html>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data:">
    <link rel="stylesheet" href="./fixture.css">
    <body><script src="./fixture.js"></script></body>`)
  const result = await promisify(execFile)(require('electron'), [
    path.join(root, 'tools/test/helpers/t52-metrics-width-electron.cjs'), data,
  ], { cwd: root, env, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1048576 })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(result, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally {
  esbuild.stop()
  console.log('T52 metrics width evidence: ' + data.replaceAll('\\', '/'))
}

const WIDTHS = [1920, 1668, 1666, 1440, 960, 834, 832, 560]
const row = (width, page) => {
  const found = observed.rows.find(item => item.requestedWidth === width && item.page === page)
  assert.ok(found, `no measurement for ${page} at ${width}`)
  return found
}

test('the hidden window painted every page at every width it was asked for', () => {
  assert.equal(observed.failure, undefined, JSON.stringify(observed.failure))
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  assert.equal(observed.visible, false)
  assert.equal(observed.destroyed, true)
  assert.equal(observed.rows.length, WIDTHS.length * 4)
})

test('the fixture really resized, so comparing widths means something', () => {
  const ledger = WIDTHS.map(width => row(width, 'ledger').width)
  assert.deepEqual([...new Set(ledger)].length, WIDTHS.length,
    `the reference page must report a different width at each window size, or the window never resized: ${JSON.stringify(ledger)}`)
})

/* THE OWNER'S SENTENCE. */
test('Metrics leaves no more side gap than the other sidebar pages, at any width', () => {
  for (const width of WIDTHS) {
    const metrics = row(width, 'metrics')
    const settings = row(width, 'settings')
    const ledger = row(width, 'ledger')
    assert.equal(metrics.sideGap, settings.sideGap,
      `HUGE SIDE GAPS: at a ${width}px window Metrics leaves ${metrics.sideGap}px and Settings leaves ${settings.sideGap}px. `
      + `Metrics is ${metrics.width}px wide against Settings' ${settings.width}px. ${JSON.stringify(metrics)}`)
    assert.equal(metrics.sideGap, ledger.sideGap,
      `at a ${width}px window Metrics leaves ${metrics.sideGap}px and Ledger leaves ${ledger.sideGap}px`)
    assert.equal(metrics.width, settings.width,
      `at a ${width}px window Metrics is ${metrics.width}px and Settings is ${settings.width}px`)
  }
})

test('the gap is symmetric, so a fix cannot pass by pushing the page to one side', () => {
  for (const width of WIDTHS) {
    const metrics = row(width, 'metrics')
    assert.equal(metrics.left, metrics.right,
      `at a ${width}px window Metrics sits ${metrics.left}px from the left and ${metrics.right}px from the right`)
  }
})

test('no horizontal jump across the breakpoints', () => {
  /* --page-gutter is clamp(20px, 2.4vw, 40px), so it stops growing at 1667px
     and bottoms out at 833px. The sample straddles both on purpose: an evenly
     spaced one would step over a jump that lives exactly there. */
  for (const [wide, narrow] of [[1668, 1666], [834, 832]]) {
    const a = row(wide, 'metrics')
    const b = row(narrow, 'metrics')
    const lost = a.width - b.width
    assert.ok(lost >= 0 && lost <= (wide - narrow) + 1,
      `Metrics jumps across the ${wide}/${narrow} breakpoint: ${a.width}px to ${b.width}px, `
      + `a change of ${lost}px for a ${wide - narrow}px window change`)
  }
  const widths = WIDTHS.map(width => row(width, 'metrics').width)
  for (let i = 1; i < widths.length; i += 1) {
    assert.ok(widths[i] <= widths[i - 1],
      `Metrics got WIDER as the window narrowed, at ${WIDTHS[i]}px: ${JSON.stringify(widths)}`)
  }
})

test('Computers keeps its own gutter and is not dragged along', () => {
  for (const width of WIDTHS) {
    const computers = row(width, 'computers')
    assert.equal(computers.sideGap, 32,
      `Computers' own 16px-a-side gutter changed at ${width}px: ${JSON.stringify(computers)}. `
      + 'That gutter is deliberate and this change must not touch it.')
  }
})
