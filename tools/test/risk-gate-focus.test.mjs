/* T1414: THE KEYBOARD IS NEVER LEFT ON THE PAGE BODY AT THE FULL-ACCESS QUESTION.
 *
 * Measured on a fresh profile with the keyboard only: in the first-run
 * walkthrough, "No, keep ..." and "Yes, give it full access" both left the
 * focus on BODY; in Settings > Setup the press on the widest level did too,
 * while the question was on screen, and so did "No, keep ...". The repaint
 * removes the pressed button and nothing received the focus.
 *
 * The real walkthrough and the real Settings row are bundled and mounted in a
 * hidden Electron window with a real document, pressed the way a keyboard does
 * (focus, then activate), and the focused element is read after each press.
 * Needs a display (run under Xvfb on Linux).
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
const data = fs.mkdtempSync(testScratchRoot('risk-gate-focus-')); const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild'); let observed
try {
  await esbuild.build({ entryPoints: { globals: path.join(root, 'tools/test/helpers/risk-gate-focus-globals.mjs'), fixture: path.join(root, 'tools/test/helpers/risk-gate-focus-renderer.mjs') }, bundle: true, format: 'iife', outdir: data, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'silent' })
  const styles = fs.existsSync(path.join(data, 'fixture.css')) ? '<link rel="stylesheet" href="./fixture.css">' : ''
  fs.writeFileSync(path.join(data, 'index.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data:">${styles}<body><script src="./globals.js"></script><script src="./fixture.js"></script></body>`)
  const result = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/risk-gate-focus-electron.cjs'), data], { cwd: root, env, windowsHide: true, timeout: 90000, maxBuffer: 1048576 })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(result, null, 2) + '\n'); observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally { esbuild.stop(); console.log('Risk gate focus evidence: ' + data.replaceAll('\\', '/')) }

const onQuestion = focus => focus?.tag === 'DIV' && Object.hasOwn(focus.data, 'data-unrestricted-risk')

test('the walkthrough puts the keyboard on the question, then on the lit level after either answer', () => {
  assert.equal(observed.failure, undefined, JSON.stringify(observed.failure))
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  const { walkthroughNo: no, walkthroughYes: yes } = observed.scenarios
  for (const run of [no, yes]) {
    assert.ok(onQuestion(run.opened), `opening the question left the keyboard on ${JSON.stringify(run.opened)}`)
  }
  assert.deepEqual(no.lit, ['guided'], 'declining changed the lit level')
  assert.equal(no.answered.tag, 'BUTTON', `after "No, keep ..." the keyboard was on ${JSON.stringify(no.answered)}`)
  assert.equal(no.answered.data['data-setup-tier'], 'guided')
  assert.equal(no.answered.data['aria-pressed'], 'true')
  assert.deepEqual(yes.lit, ['unrestricted'])
  assert.equal(yes.answered.tag, 'BUTTON', `after "Yes, give it full access" the keyboard was on ${JSON.stringify(yes.answered)}`)
  assert.equal(yes.answered.data['data-setup-tier'], 'unrestricted')
  assert.equal(yes.answered.data['aria-pressed'], 'true')
  assert.deepEqual([...no.writes, ...yes.writes], [], 'the walkthrough wrote a level before Continue')
})

test('the Settings permission row puts the keyboard on the question, then on the lit level after either answer', () => {
  const { settingsNo: no, settingsYes: yes } = observed.scenarios
  for (const run of [no, yes]) {
    assert.ok(onQuestion(run.opened), `pressing the widest level left the keyboard on ${JSON.stringify(run.opened)}`)
  }
  assert.deepEqual(no.writes, [], 'declining wrote a level')
  assert.deepEqual(no.lit, ['guided'])
  assert.equal(no.after.data['data-setup-profile-value'], 'guided', `after "No, keep ..." the keyboard was on ${JSON.stringify(no.after)}`)
  assert.equal(no.after.data['aria-pressed'], 'true')
  assert.deepEqual(yes.writes, ['unrestricted'], 'confirming did not write the widest level once')
  assert.deepEqual(yes.lit, ['unrestricted'])
  assert.equal(yes.after.data['data-setup-profile-value'], 'unrestricted', `after "Yes, give it full access" the keyboard was on ${JSON.stringify(yes.after)}`)
  assert.equal(yes.after.data['aria-pressed'], 'true')
  assert.equal(observed.visible, false); assert.equal(observed.destroyed, true)
})
