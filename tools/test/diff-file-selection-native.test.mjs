import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

test('actual hidden renderer opens the selected file through IPC and the native workspace fence', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const require = createRequire(import.meta.url)
  const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../lib/sterile-launch.cjs')
  const data = fs.mkdtempSync(testScratchRoot('diff-selection-native-'))
  const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
  for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
  const esbuild = require('esbuild')
  try {
    await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/diff-selection-renderer.mjs')],
      bundle: true, format: 'iife', outfile: path.join(data, 'fixture.js'), logLevel: 'silent' })
    fs.writeFileSync(path.join(data, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'unsafe-inline\'"><body><script src="./fixture.js"></script></body>')
    const result = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/diff-selection-electron.cjs'), data],
      { cwd: root, env, windowsHide: true, timeout: 45000, maxBuffer: 1048576 })
    fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(result, null, 2) + '\n')
    const observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
    assert.deepEqual(observed.selection.fresh, { original: 'before\n', proposed: 'after\n', title: 'selected.txt' })
    assert.equal(observed.selection.reused, 'after\n')
    assert.equal(observed.selection.retargeted, 'other file\n')
    assert.equal(observed.selection.unchanged, true)
    assert.equal(observed.selection.oneModal, true)
    assert.equal(observed.selection.removed, true)
    assert.deepEqual(observed.readRequests, ['selected.txt', 'selected.txt', 'first.txt'])
    assert.equal(observed.pickCount, 0)
    assert.equal(observed.visible, false)
    assert.equal(observed.destroyed, true)
    assert.deepEqual(observed.pageErrors, [])
    assert.deepEqual(observed.deniedRequests, [])
  } finally {
    esbuild.stop()
    console.log('Synthetic diff selection evidence: ' + data.replaceAll('\\', '/'))
  }
})
