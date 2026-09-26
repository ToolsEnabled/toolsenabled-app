import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../lib/sterile-launch.cjs')
const data = fs.mkdtempSync(testScratchRoot('t1391-computers-geometry-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/t1391-computers-geometry-renderer.mjs')], bundle: true,
    format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'silent' })
  // Retain the actual committed shell markup/topbar/stage. Only scripts and
  // resource links are replaced: this fixture supplies inert bridges and its
  // bundled production CSS/view instead of booting the application's main.
  const shell = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace('</head>', '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:; img-src data:"><link rel="stylesheet" href="./fixture.css"></head>')
    .replace('</body>', '<script src="./fixture.js"></script></body>')
  fs.writeFileSync(path.join(data, 'index.html'), shell)

  const execution = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/t1391-computers-geometry-electron.cjs'), data],
    { cwd: root, env, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally {
  esbuild.stop()
  console.log('Retained Computers layout evidence: ' + data.replaceAll('\\', '/'))
}

const fits = (r, viewport) => r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1
  && r.right <= viewport.width + 1 && r.bottom <= viewport.height + 1

test('native mounted Edit hint stays outside agent circles and labels at narrow, wide and multiple-tree layouts', () => {
  assert.deepEqual(observed.edits.map(row => [row.viewport.width, row.trees]), [320, 768, 1440].flatMap(width => [1, 2].map(trees => [width, trees])))
  for (const row of observed.edits) {
    assert.equal(row.editing, true)
    assert.equal(row.note.visible, true)
    assert.ok(fits(row.note.rect, row.viewport), JSON.stringify(row))
    assert.ok(row.nodes.length >= row.trees * 2)
    assert.equal(row.nodes.some(node => node.coveredByNote), false, JSON.stringify(row))
    assert.equal(row.button.text, 'Done')
    assert.ok(fits(row.button.rect, row.viewport), JSON.stringify(row))
  }
})

test('native landscape Rows exposes two complete hit targets and each native press opens the matching agent', () => {
  const rows = observed.phones.filter(row => row.before.shape === 'landscape')
  assert.deepEqual(rows.map(row => [row.before.viewport.width, row.before.viewport.height]), [[750, 342], [863, 360]])
  for (const row of rows) {
    assert.equal(row.mode.phone, 'on')
    assert.equal(row.mode.rows, true)
    assert.ok(row.before.usable.length >= 2)
    assert.ok(row.before.ledger.height >= row.before.usable[0].rect.height + row.before.usable[1].rect.height)
    assert.equal(row.clicks.length, 2)
    for (const opened of row.clicks) {
      assert.equal(opened.visible, true)
      assert.equal(opened.subject, opened.expected)
      assert.ok(fits(opened.sheet, row.before.viewport), JSON.stringify(opened))
    }
    assert.equal(row.before.pageScrolls, false)
  }
})

test('native portrait Rows and landscape Graph retain their usable phone controls', () => {
  const portrait = observed.phones.find(row => row.before.shape === 'portrait')
  assert.deepEqual([portrait.before.viewport.width, portrait.before.viewport.height], [412, 839])
  assert.ok(portrait.before.usable.length >= 2)
  for (const opened of portrait.clicks) assert.equal(opened.subject, opened.expected)
  assert.equal(observed.graph.rows, false)
  assert.equal(observed.graph.shape, 'landscape')
  assert.ok(observed.graph.canvas.height >= 72)
  assert.ok(observed.graph.zoomControls.length >= 2)
})

test('native Computers additions fixture closes one isolated window and makes no provider or seat operation', () => {
  assert.deepEqual(observed.operations, [])
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  assert.equal(observed.visible, false)
  assert.equal(observed.destroyed, true)
})
