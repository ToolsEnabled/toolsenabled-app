import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'
import { FONT_CHOICES } from '../../src/font-choice.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../lib/sterile-launch.cjs')
const data = fs.mkdtempSync(testScratchRoot('role-studio-layout-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/role-studio-layout-renderer.mjs')], bundle: true,
    format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl' }, logLevel: 'silent' })
  fs.writeFileSync(path.join(data, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:; img-src data:"><title>Isolated role layout</title><link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>\n')
  const execution = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/role-studio-layout-electron.cjs'), data], {
    cwd: root, env, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally {
  esbuild.stop()
  console.log('Role layout evidence: ' + data.replaceAll('\\', '/'))
}
const fits = (rect, viewport) => rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.top >= -1
  && rect.right <= viewport.width + 1 && rect.bottom <= viewport.height + 1
for (const family of ['canvas', 'editor']) {
  test(`native role ${family} and its primary controls remain reachable at every text size`, () => {
    const failures = []
    for (const row of observed.rows) for (const view of row.views.filter(view => (view.view === 'canvas') === (family === 'canvas'))) {
      const controls = view.controls.filter(control => !fits(control.rect, row.viewport) || !control.hittable || !control.enabled || !control.focused)
      if (!view.nativeModal || !fits(view.dialog, row.viewport) || controls.length || view.horizontalOverflow > 1) {
        failures.push({ font: row.font, size: row.size, viewport: row.viewport, view: view.view, dialog: view.dialog, controls,
          horizontalOverflow: view.horizontalOverflow })
      }
    }
    assert.deepEqual(failures, [], 'A role control is clipped, obscured, or unreachable; inspect retained native geometry')
  })
}
test('native Close input closes the role workspace at Small, Normal, and Large', () => {
  assert.deepEqual(observed.rows.filter(row => !row.closedByInput).map(({ font, size, viewport, closePoint }) => ({ font, size, viewport, closePoint })), [])
})
test('layout proof covers each viewport/font/text choice without role writes or visible owner windows', () => {
  const expected = [[1280, 900], [1024, 768], [600, 800]].flatMap(([width, height]) =>
    ['plex', 'system', 'mono'].flatMap(font => [0.9, 1, 1.12].map(size => `${width}x${height}/${font}/${size}`)))
  assert.deepEqual(observed.rows.map(row => `${row.viewport.width}x${row.viewport.height}/${row.font}/${row.size}`), expected)
  for (const row of observed.rows) {
    assert.deepEqual(row.views.map(view => view.view), ['canvas', 'directions', 'functions', 'preview', 'reset', 'new'])
    assert.equal(Number(row.bodyZoom), row.size, 'The requested body zoom must actually be applied')
    assert.equal(row.fontFamily, FONT_CHOICES.find(choice => choice.id === row.font).stack)
    assert.equal(row.fontStatus, 'loaded')
  }
  assert.deepEqual(observed.operations, [])
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  assert.equal(observed.visible, false)
  assert.equal(observed.destroyed, true)
})

test('Roles opens from the hidden tree sidebar and closing restores its hidden state', () => {
  assert.ok(observed.rows.length > 0)
  for (const row of observed.rows) {
    assert.equal(row.sidebarInitiallyHidden, true)
    assert.equal(row.sidebarHiddenAfterClose, true)
  }
})
