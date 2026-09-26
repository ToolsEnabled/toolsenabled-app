/* T1564: EVERY SIGN-IN AND CREATE-ACCOUNT FIELD IS VISIBLY A FIELD IN EVERY THEME.
 *
 * Measured in the Black and Ember themes: the only boundary of the Account
 * page's "Local account name", "Shown as" and "Password" fields was a 1px
 * underline at 1.61:1 and 1.31:1 against the page (the first-run Account step:
 * 1.87:1 and 1.31:1), so the fields read as decoration. WCAG 1.4.11 asks a
 * control's boundary for 3:1.
 *
 * The real markup and stylesheets are bundled and drawn in a hidden Electron
 * window, in the containers the two pages use, and each field's border is
 * measured against the colour actually behind it. Needs a display (Xvfb).
 */
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
const data = fs.mkdtempSync(testScratchRoot('account-field-contrast-')); const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild'); let observed
try {
  await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/account-field-contrast-renderer.mjs')], bundle: true, format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl', '.svg': 'dataurl' }, logLevel: 'silent' })
  fs.writeFileSync(path.join(data, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:"><link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>')
  const result = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/account-field-contrast-electron.cjs'), data], { cwd: root, env, windowsHide: true, timeout: 90000, maxBuffer: 1048576 })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(result, null, 2) + '\n'); observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally { esbuild.stop(); console.log('Account field contrast evidence: ' + data.replaceAll('\\', '/')) }

test('Account page and first-run Account step fields have a 3:1 boundary in every theme', () => {
  assert.equal(observed.failure, undefined, JSON.stringify(observed.failure))
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  assert.equal(observed.cases.length, 10)
  for (const { theme, surface, observed: view } of observed.cases) {
    assert.equal(view.theme, theme)
    assert.deepEqual(view.fields.map(field => field.name), ['username', 'displayName', 'password'], `${surface}/${theme} did not draw the create form`)
    for (const field of view.fields) {
      assert.ok(field.ratio >= 3, `${surface}/${theme} ${field.name}: its boundary is ${field.ratio.toFixed(2)}:1 against the page, under 3:1`)
      assert.deepEqual(field.edges, ['Top', 'Right', 'Bottom', 'Left'], `${surface}/${theme} ${field.name} is not a boxed field`)
    }
  }
  assert.equal(observed.visible, false); assert.equal(observed.destroyed, true)
})
