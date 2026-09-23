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
const data = fs.mkdtempSync(testScratchRoot('diff-content-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')
let observed
try {
  await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/diff-content-renderer.mjs')],
    bundle: true, format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl' }, logLevel: 'silent' })
  fs.writeFileSync(path.join(data, 'index.html'), `<!doctype html><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data:">
    <link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>`)
  const result = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/diff-content-electron.cjs'), data, '--user-data-dir='+path.join(data,'userData')],
    { cwd: root, env, windowsHide: true, timeout: 45000, maxBuffer: 1048576 })
  fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(result, null, 2) + '\n')
  observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
} finally { esbuild.stop(); console.log('Diff content layout evidence: ' + data.replaceAll('\\', '/')) }

for (const width of [1120, 600]) test(`${width}px actual diff shows recorded hunk context and both complete supplied versions`, () => {
  const row = observed.rows.find(row => row.width === width)
  assert.equal(row.outerOverflow, false)
  assert.equal(row.rangeClipped, false)
  assert.equal(row.headerClipped, false, 'Before/After labels must not overlap')
  assert.equal(row.guttersAligned, true, 'column labels and source line numbers must use the same tracks')
  assert.deepEqual(row.ranges, ['Before lines 3–7 → After lines 3–8', 'Before line 10 → After line 11'])
  assert.deepEqual(row.contexts, ['export function eligible(account) {', 'clearCachedReading()'])
  assert.deepEqual(row.numbers, ['Before', 'After'])
  assert.match(row.before, /const reserve = 0\.05;/)
  assert.match(row.after, /const reserve = 0\.15;/)
  assert.match(row.basis, /each recorded edit, not the current file/)
  assert.equal(row.retainedCode.length, 10)
  assert.deepEqual([row.reads, row.writes, row.picks], [1, 0, 0])
})

test('long supplied hunk context wraps completely inside the actual narrow diff surface', () => {
  assert.equal(observed.longContext.complete, true)
  assert.equal(observed.longContext.wraps, true)
  assert.equal(observed.longContext.clipped, false)
})

test('an unreadable current file keeps the recorded preview but never promises full versions', () => {
  assert.equal(observed.unavailable.beforeDisabled, true)
  assert.equal(observed.unavailable.afterDisabled, true)
  assert.equal(observed.unavailable.rows, 1999)
  assert.match(observed.unavailable.notice, /Remaining patch lines are not shown/)
  assert.doesNotMatch(observed.unavailable.notice, /full file|remain available/)
})

test('the isolated diff window closes invisibly without external requests or page errors', () => {
  assert.equal(observed.visible, false)
  assert.equal(observed.destroyed, true)
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
})
