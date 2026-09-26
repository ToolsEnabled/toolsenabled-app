#!/usr/bin/env node
/* Diagnosis before assertion: print the page column of four routes at eight
   window widths, so the fix is chosen from what the browser does rather than
   from what the stylesheet appears to say. */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { testScratchRoot } from './lib/test-scratch-root.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('./lib/sterile-launch.cjs')
const data = fs.mkdtempSync(testScratchRoot('t52-metrics-measure-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
const esbuild = require('esbuild')

await esbuild.build({
  entryPoints: [path.join(root, 'tools/test/helpers/t52-metrics-width-renderer.mjs')],
  bundle: true, format: 'iife', outfile: path.join(data, 'fixture.js'),
  loader: { '.woff2': 'dataurl' }, logLevel: 'silent',
  nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter).filter(Boolean) : [],
})
fs.writeFileSync(path.join(data, 'index.html'), `<!doctype html>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data:">
  <link rel="stylesheet" href="./fixture.css">
  <body><script src="./fixture.js"></script></body>`)
await promisify(execFile)(require('electron'), [
  path.join(root, 'tools/test/helpers/t52-metrics-width-electron.cjs'), data,
], { cwd: root, env, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1048576 })
esbuild.stop()

const observed = JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8'))
if (observed.failure) { console.error(observed.failure); process.exit(1) }

const widths = [...new Set(observed.rows.map(r => r.requestedWidth))]
console.log('window |      page | width   left  right  sideGap | declared width')
for (const w of widths) {
  for (const row of observed.rows.filter(r => r.requestedWidth === w)) {
    console.log(`${String(w).padStart(6)} | ${row.page.padStart(9)} | ${String(row.width).padStart(7)} ${String(row.left).padStart(6)} ${String(row.right).padStart(6)} ${String(row.sideGap).padStart(8)} | ${row.declaredWidth}`)
  }
  console.log('')
}
const first = observed.rows[0]
console.log(`--page-max ${first.pageMax}   --page-gutter ${first.pageGutter}`)
console.log('evidence: ' + data.replaceAll('\\', '/'))
