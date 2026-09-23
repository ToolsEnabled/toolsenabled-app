import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url)); const require = createRequire(import.meta.url)
const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../lib/sterile-launch.cjs')
const data = fs.mkdtempSync(testScratchRoot('setup-account-fields-')); const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild'); let observed
try {
  await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/setup-account-fields-renderer.mjs')], bundle: true, format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl', '.svg': 'dataurl' }, logLevel: 'silent' })
  fs.writeFileSync(path.join(data, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:"><link rel="stylesheet" href="./fixture.css"><style>html,body{margin:0;width:100%;min-height:100%;overflow:hidden}body{display:block}</style><body><script src="./fixture.js"></script></body>')
  const result = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/setup-account-fields-electron.cjs'), data], { cwd: root, env, windowsHide: true, timeout: 90000, maxBuffer: 1048576 })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(result, null, 2) + '\n'); observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally { esbuild.stop(); console.log('Setup account field layout evidence: ' + data.replaceAll('\\', '/')) }

test('mounted first-run fields remain visible and bounded at every admitted theme/mode/viewport', () => {
  const expectedCases = new Set()
  for (const theme of ['white', 'black']) for (const mode of ['create', 'sign-in']) for (const [width, height] of [[1400, 832], [320, 832], [390, 832]]) expectedCases.add(`${theme}/${mode}/${width}x${height}`)
  assert.equal(observed.cases.length, expectedCases.size)
  assert.deepEqual(new Set(observed.cases.map(row => `${row.theme}/${row.mode}/${row.viewport.join('x')}`)), expectedCases)
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  for (const row of observed.cases) {
    const view = row.observed
    const expectedIds = row.mode === 'create' ? ['username', 'displayName', 'password'] : ['username', 'password']
    assert.equal(view.theme, row.theme)
    assert.deepEqual(view.ids, expectedIds)
    assert.equal(view.fields.length, expectedIds.length)
    assert.deepEqual(view.initialFocus, expectedIds.map(() => false))
    assert.ok(view.fields.every(field => !field.disabled && field.opacity > 0))
    assert.equal(view.width, row.viewport[0]); assert.equal(view.height, row.viewport[1])
    assert.deepEqual(view.fields.map(field => field.value), expectedIds.map(() => ''))
    assert.ok(view.fields.every(field => field.width > 0 && field.height >= 36 && field.left >= -1 && field.right <= view.width + 1))
    assert.ok(view.pageWidth <= view.clientWidth + 1, `${row.theme}/${row.mode}/${row.viewport[0]} overflow`)
    assert.ok(view.fields.every(field => field.borderWidth > 0 && field.borderStyle !== 'none' && !/rgba?\([^)]*,\s*0\)/.test(field.borderColor) && field.background !== 'rgba(0, 0, 0, 0)'))
    assert.notEqual(view.focus.outline, 'none'); assert.ok(view.focus.outlineWidth > 0)
    assert.deepEqual(row.busy.ids, expectedIds)
    assert.ok(row.busy.fields.every(field => field.disabled && field.opacity < 1))
  }
  assert.equal(observed.visible, false); assert.equal(observed.destroyed, true)
})
