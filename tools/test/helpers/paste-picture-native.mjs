import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { testScratchRoot } from '../../lib/test-scratch-root.mjs'

/* The fixture picture is GENERATED, not checked in, so the Node half and the
   renderer half are provably holding the same bytes: the Node half writes the
   file, the renderer builds its File from the base64 of that same file, and the
   assertion compares what came back to what was written. A checked-in fixture
   would let the two drift. */
function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = c ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
export function solidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2
  const raw = []
  for (let y = 0; y < size; y++) { raw.push(Buffer.from([0])); for (let x = 0; x < size; x++) raw.push(Buffer.from([r, g, b])) }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(raw))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* Real native queue; only the selected provider transport is a fixture. */
export async function pastePictureInRealWindow({ provider = 'claude', revokeAttachment = false } = {}) {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const engineRoot = process.env.MC_T18_ENGINE_ROOT || process.env.MC_CANONICAL_ROOT
  if (!engineRoot) throw Error('The paired engine root is required')
  if (!['claude', 'local'].includes(provider)) throw Error('Unexpected fixture provider')
  const require = createRequire(import.meta.url)
  const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../../lib/sterile-launch.cjs')
  const data = fs.mkdtempSync(testScratchRoot('paste-picture-'))
  const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'environment'))))
  for (const key of Object.keys(env)) if (/^NODE_OPTIONS$/i.test(key)) delete env[key]
  const esbuild = require('esbuild')
  const png = solidPng(8, [255, 0, 0])
  try {
    fs.writeFileSync(path.join(data, 'preload.cjs'), `
const { contextBridge, ipcRenderer } = require('electron')
async function invoke(name, value) {
  const result = await ipcRenderer.invoke('paste-fixture:' + name, value)
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code })
  return result.value
}
contextBridge.exposeInMainWorld('pasteFixture', {
  ownerContext: () => invoke('owner-context'),
  pasteAttachment: value => invoke('paste', value),
  imageQueue: value => invoke('queue', value),
  observations: () => invoke('observations'),
})
`)
    fs.writeFileSync(path.join(data, 'fixture.png'), png)
    fs.writeFileSync(path.join(data, 'scenario.json'), JSON.stringify({ provider, revokeAttachment }))
    await esbuild.build({
      entryPoints: [path.join(root, 'tools/test/helpers/paste-picture-renderer.mjs')], bundle: true,
      format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl' }, logLevel: 'silent'
    })
    fs.writeFileSync(path.join(data, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:; img-src data:"><title>T18 paste fixture</title><link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>\n')
    const execution = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/paste-picture-electron.cjs'), data, engineRoot], {
      cwd: root, env, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
    })
    fs.writeFileSync(path.join(data, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
    return { png, evidence: data, observations: JSON.parse(fs.readFileSync(path.join(data, 'observations.json'), 'utf8')) }
  } finally {
    esbuild.stop()
    console.log('T18 native paste evidence: ' + data.replaceAll('\\', '/'))
  }
}
