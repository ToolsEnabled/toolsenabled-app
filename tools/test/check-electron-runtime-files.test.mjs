/* The runtime-file gate must fail because it looked and found a defect, never
 * pass because its entry path or source enumeration made it look at nothing.
 *
 * Run: node --test tools/test/check-electron-runtime-files.test.mjs
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { checkElectronRuntimeFiles } from '../check-electron-runtime-files.mjs'

const require = createRequire(import.meta.url)
const { FuseV1Options, FuseVersion } = require('@electron/fuses')

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE = path.join(REPO_ROOT, 'tools', 'check-electron-runtime-files.mjs')

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'check-electron-runtime-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function run(gate, output, dist) {
  return spawnSync(process.execPath, [gate, output, dist], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  })
}

function write(root, relative) {
  const target = path.join(root, ...relative.split('/'))
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, 'x')
}

function completeOutput(root) {
  for (const relative of [
    'ToolsEnabled.exe',
    'resources/app.asar',
    'icudtl.dat',
    'resources.pak',
    'chrome_100_percent.pak',
    'chrome_200_percent.pak',
    'v8_context_snapshot.bin',
    'snapshot_blob.bin',
    'ffmpeg.dll',
    'libEGL.dll',
    'libGLESv2.dll',
    'd3dcompiler_47.dll',
    'vk_swiftshader.dll',
    'vk_swiftshader_icd.json',
    'vulkan-1.dll',
    'dxcompiler.dll',
    'dxil.dll',
  ]) write(root, relative)
  write(root, 'locales/en-US.pak')
  for (let index = 1; index < 40; index += 1) write(root, `locales/locale-${index}.pak`)
}

test('check-electron-runtime-files runs and refuses through a junction or symlink path', (t) => {
  const root = fixture(t)
  const toolsLink = path.join(root, 'TOOLS-LANE')
  symlinkSync(path.dirname(GATE), toolsLink, process.platform === 'win32' ? 'junction' : 'dir')
  const result = run(path.join(toolsLink, path.basename(GATE)), path.join(root, 'missing-output'), path.join(root, 'missing-dist'))

  assert.equal(result.status, 1, `the aliased invocation passed without looking:\n${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /packaged output directory does not exist/)
})

test('an empty Electron distribution is a refusal, not vacuous parity', (t) => {
  const root = fixture(t)
  const output = path.join(root, 'output')
  const dist = path.join(root, 'dist')
  completeOutput(output)
  mkdirSync(dist)

  const result = run(GATE, output, dist)
  assert.equal(result.status, 1, `an empty parity enumeration passed:\n${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /pinned Electron distribution contains no files/)
})

test('a complete output still passes against a populated distribution and an independently read fuse policy', async (t) => {
  const root = fixture(t)
  const output = path.join(root, 'output')
  const dist = path.join(root, 'dist')
  completeOutput(output)
  write(dist, 'electron.exe')

  const result = await checkElectronRuntimeFiles(output, dist, {
    platform: 'win32',
    readFuseWire: async () => ({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: '1'.charCodeAt(0),
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: '0'.charCodeAt(0),
      [FuseV1Options.EnableNodeCliInspectArguments]: '0'.charCodeAt(0),
      [FuseV1Options.OnlyLoadAppFromAsar]: '1'.charCodeAt(0),
    }),
    probeExecutablePolicy: async () => ({ ok: true, reason: 'fixture' }),
  })
  assert.equal(result.ok, true, result.failures.join('\n'))
  assert.ok(result.checked.includes('ToolsEnabled.exe:fuse-policy'))
  assert.ok(result.checked.includes('ToolsEnabled.exe:pre-main-behavior'))
})

test('a complete-looking runtime is refused when its executable still permits pre-main injection', async (t) => {
  const root = fixture(t)
  const output = path.join(root, 'output')
  const dist = path.join(root, 'dist')
  completeOutput(output)
  write(dist, 'electron.exe')

  const result = await checkElectronRuntimeFiles(output, dist, {
    platform: 'win32',
    readFuseWire: async () => ({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: '1'.charCodeAt(0),
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: '1'.charCodeAt(0),
      [FuseV1Options.EnableNodeCliInspectArguments]: '0'.charCodeAt(0),
      [FuseV1Options.OnlyLoadAppFromAsar]: '1'.charCodeAt(0),
    }),
    probeExecutablePolicy: async () => ({ ok: true, reason: 'fixture' }),
  })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some(failure => /NODE_OPTIONS/.test(failure)))
})

test('a correct-looking fuse wire does not hide a failed executable behavior probe', async (t) => {
  const root = fixture(t)
  const output = path.join(root, 'output')
  const dist = path.join(root, 'dist')
  completeOutput(output)
  write(dist, 'electron.exe')

  const result = await checkElectronRuntimeFiles(output, dist, {
    platform: 'win32',
    readFuseWire: async () => ({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: '1'.charCodeAt(0),
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: '0'.charCodeAt(0),
      [FuseV1Options.EnableNodeCliInspectArguments]: '0'.charCodeAt(0),
      [FuseV1Options.OnlyLoadAppFromAsar]: '1'.charCodeAt(0),
    }),
    probeExecutablePolicy: async () => ({ ok: false, reason: 'loader marker appeared' }),
  })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some(failure => /EXECUTABLE POLICY.*loader marker appeared/.test(failure)))
})

test('Linux floor, ELF identity and renamed-distribution parity are independent of Windows DLLs', { skip: process.platform === 'win32' ? 'Linux executable-mode proof requires a POSIX filesystem' : false }, async t => {
  const root = fixture(t), output = path.join(root, 'output'), dist = path.join(root, 'dist')
  for (const file of ['resources/app.asar', 'icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
    'v8_context_snapshot.bin', 'snapshot_blob.bin', 'vk_swiftshader_icd.json', 'chrome-sandbox', 'chrome_crashpad_handler',
    'libffmpeg.so', 'libEGL.so', 'libGLESv2.so', 'libvk_swiftshader.so', 'libvulkan.so.1']) write(output, file)
  write(output, 'locales/en-US.pak')
  for (let i = 1; i < 40; i++) write(output, `locales/${i}.pak`)
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1])
  write(output, 'toolsenabled'); write(dist, 'electron')
  writeFileSync(path.join(output, 'toolsenabled'), elf); chmodSync(path.join(output, 'toolsenabled'), 0o755)
  writeFileSync(path.join(dist, 'electron'), elf)
  const dependencies = { platform: 'linux', readFuseWire: async executable => {
    assert.equal(path.basename(executable), 'toolsenabled')
    return { version: FuseVersion.V1, [FuseV1Options.RunAsNode]: 49, [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: 48,
      [FuseV1Options.EnableNodeCliInspectArguments]: 48, [FuseV1Options.OnlyLoadAppFromAsar]: 49 }
  }, probeExecutablePolicy: async () => ({ ok: true }) }
  let result = await checkElectronRuntimeFiles(output, dist, dependencies)
  assert.equal(result.ok, true, result.failures.join('\n'))
  assert.ok(result.checked.includes('toolsenabled:linux-elf'))
  rmSync(path.join(output, 'libffmpeg.so'))
  result = await checkElectronRuntimeFiles(output, dist, dependencies)
  assert.ok(result.failures.some(f => f.startsWith('MISSING libffmpeg.so')))
  write(output, 'libffmpeg.so')
  writeFileSync(path.join(output, 'toolsenabled'), 'not-ELF')
  result = await checkElectronRuntimeFiles(output, dist, dependencies)
  assert.ok(result.failures.some(f => f.startsWith('NATIVE FORMAT')))
  assert.ok(result.failures.some(f => f.startsWith('TRUNCATED toolsenabled')))
})
