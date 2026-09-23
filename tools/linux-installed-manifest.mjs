#!/usr/bin/env node
// Offline only. This CLI never installs a package or launches an application.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { produceManifest, verifyExternalManifest } from './lib/linux-installed-manifest.mjs'

const mode = process.argv[2], options = {}
const names = new Map([['--deb', 'deb'], ['--package-sha256', 'packageSha256'], ['--app-source', 'appSource'],
  ['--engine-source', 'engineSource'], ['--app-ref', 'appRef'], ['--engine-ref', 'engineRef'],
  ['--manifest', 'manifestFile'], ['--manifest-sha256', 'manifestSha256'], ['--output', 'output']])
try {
  if (!['produce', 'verify-binding'].includes(mode)) throw new Error('Use produce or verify-binding; no installed/GUI proof is implemented by this CLI.')
  for (let i = 3; i < process.argv.length; i += 2) {
    const key = names.get(process.argv[i]), value = process.argv[i + 1]
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error('Invalid manifest options')
    options[key] = ['deb', 'appSource', 'engineSource', 'manifestFile', 'output'].includes(key) ? path.resolve(value) : value
  }
  for (const key of ['deb', 'packageSha256', 'appRef', 'engineRef', ...(mode === 'produce' ? ['appSource', 'engineSource', 'output'] : ['manifestFile', 'manifestSha256'])]) {
    if (!options[key]) throw new Error('Missing required option: ' + key)
  }
  if (mode === 'produce') {
    if (options.output === options.deb || options.output.startsWith('/opt/')) throw new Error('Manifest output must be new external evidence')
    const value = await produceManifest(options), bytes = JSON.stringify(value, null, 2) + '\n'
    fs.writeFileSync(options.output, bytes, { flag: 'wx', mode: 0o444 })
    console.log(JSON.stringify({ ok: true, scope: 'offline-package-manifest-not-installed-proof', manifestSha256: createHash('sha256').update(bytes).digest('hex'), packageSha256: value.package.sha256, entries: value.entries.length }))
  } else {
    const value = await verifyExternalManifest(options)
    console.log(JSON.stringify({ ok: true, scope: 'external-package-binding-not-installed-proof', packageSha256: value.package.sha256, entries: value.entries.length }))
  }
} catch (error) { console.error(error.code || error.message); process.exitCode = 1 }
