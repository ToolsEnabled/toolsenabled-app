import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { testScratchRoot } from '../../lib/test-scratch-root.mjs'

export async function observeComputersComposer() {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const require = createRequire(import.meta.url)
  const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../../lib/sterile-launch.cjs')
  const data = fs.mkdtempSync(testScratchRoot('computers-composer-'))
  const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
  for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
  const esbuild = require('esbuild')
  try {
    await esbuild.build({ entryPoints: [path.join(root, 'tools/test/helpers/computers-composer-renderer.mjs')], bundle: true,
      format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl' }, logLevel: 'silent' })
    fs.writeFileSync(path.join(data, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:; img-src data:"><title>Synthetic Computers composer</title><link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>\n')
    const execution = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/computers-composer-electron.cjs'), data], {
      cwd: root, env, windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024,
    })
    fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
    return JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
  } finally {
    esbuild.stop()
    console.log('Computers composer native evidence: ' + data.replaceAll('\\', '/'))
  }
}
