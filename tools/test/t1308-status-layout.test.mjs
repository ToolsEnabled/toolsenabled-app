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
const data = fs.mkdtempSync(testScratchRoot('t1308-status-layout-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/t1308-status-layout-renderer.mjs')], bundle: true,
    format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'silent' })
  fs.writeFileSync(path.join(data, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:; img-src data:"><title>Isolated Computers layout</title><link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>\n')
  const execution = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/t1308-status-layout-electron.cjs'), data],
    { cwd: root, env, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally {
  esbuild.stop()
  console.log('Retained Computers layout evidence: ' + data.replaceAll('\\', '/'))
}
const intersects = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left)
  && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)
const fits = (r, viewport) => r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1
  && r.right <= viewport.width + 1 && r.bottom <= viewport.height + 1

test('native mounted Computers status remains readable without hint intersection at every declared viewport and pane count', () => {
  const rows = observed.rows.filter(row => !['empty', 'hidden'].includes(row.kind))
  assert.equal(rows.length, 24)
  for (const row of rows) {
    assert.equal(row.status.visible, true, JSON.stringify(row))
    assert.ok(fits(row.status.rect, row.viewport), JSON.stringify(row))
    assert.ok(row.status.scrollWidth <= row.status.clientWidth + 1, JSON.stringify(row))
    assert.ok(row.status.scrollHeight <= row.status.clientHeight + 1 || ['auto', 'scroll'].includes(row.status.overflowY), JSON.stringify(row))
    for (const hint of row.hints.filter(hint => hint.visible)) {
      assert.equal(intersects(row.status.rect, hint.rect), false, JSON.stringify(row))
    }
  }
})

test('native mounted Computers restores readable hints for empty and hidden status', () => {
  const rows = observed.rows.filter(row => ['empty', 'hidden'].includes(row.kind))
  assert.equal(rows.length, 18)
  for (const row of rows) {
    assert.equal(row.status.visible, false, JSON.stringify(row))
    const hints = row.hints.filter(hint => hint.visible)
    assert.equal(hints.length, row.panes, JSON.stringify(row))
    for (const hint of hints) { assert.ok(hint.text); assert.ok(fits(hint.rect, row.viewport), JSON.stringify(row)) }
  }
})

test('native Computers geometry covers the declared matrix and closes its isolated window without provider or seat operations', () => {
  const expected = [320, 768, 1440].flatMap(width => [1, 2].flatMap(panes =>
    ['empty', 'hidden', 'success', 'refusal', 'long-success', 'long-refusal', 'empty'].map(kind => [width, 900, panes, kind])))
  assert.deepEqual(observed.rows.map(row => [row.viewport.width, row.viewport.height, row.panes, row.kind]), expected)
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  assert.deepEqual(observed.operations, [])
  assert.equal(observed.visible, false)
  assert.equal(observed.destroyed, true)
})
