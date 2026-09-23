import test from 'node:test'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const { resolveVoiceRuntime } = createRequire(import.meta.url)('../../shell/voice-runtime-paths.cjs')

const temp = ownedFixtureTempRoot()
const tempPrefix = path.join(temp, 'toolsenabled-voice-paths-')
function fixture(t) {
  const root = fs.mkdtempSync(tempPrefix)
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(tempPrefix))); fs.rmSync(root, { recursive: true, force: true }) })
  const appRoot = path.join(root, 'installed/resources/app.asar')
  const resourcesPath = path.join(root, 'installed/resources')
  const runtimeDataRoot = path.join(root, 'state/voice-runtime')
  const settings = { appRoot, resourcesPath, profileRoot: root, runtimeDataRoot, platform: 'win32' }
  const write = (relative, text = '') => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file }
  return { root, settings, write }
}

test('packaged voice selects its own Python and models with a separate writable cache', t => {
  const f = fixture(t)
  const worker = f.write('installed/resources/voice-runtime/worker.py')
  const python = f.write('installed/resources/voice-runtime/bundle/python/python.exe')
  f.write('installed/resources/voice-runtime/bundle/runtime.json', JSON.stringify({ schemaVersion: 1, platform: 'win32', arch: 'x64', pythonVersion: '3.13.3' }))
  // Deliberately unreadable as JSON: the startup path must not read the large
  // manifest or enumerate/read model data to decide where the worker lives.
  f.write('installed/resources/voice-runtime/bundle/bundle-manifest.json', 'not startup data')
  const result = resolveVoiceRuntime(f.settings)
  assert.equal(result.python, python)
  assert.equal(result.worker, worker)
  assert.equal(result.dataRoot, f.settings.runtimeDataRoot)
  assert.equal(result.modelRoot, path.join(f.settings.resourcesPath, 'voice-runtime/bundle/models'))
  assert.equal(fs.existsSync(result.dataRoot), false, 'discovery does not create or populate writable storage')
})

test('immutable LIVE generations reuse an existing owner-data speech installation', t => {
  const f = fixture(t)
  f.settings.appRoot = path.join(f.root, 'workspace/live-control/runtime-generations/gen-fixture/app')
  const worker = f.write('workspace/live-control/runtime-generations/gen-fixture/app/voice-runtime/worker.py')
  const python = f.write('state/voice-runtime/venv/Scripts/python.exe')
  assert.deepEqual(resolveVoiceRuntime(f.settings), { worker, python, dataRoot: f.settings.runtimeDataRoot })
})

test('a legacy system installation keeps its worker in resources and its venv in owner data', t => {
  const f = fixture(t)
  // A Linux package puts resources outside its owning home directory. The
  // Windows-only bundled interpreter does not replace that existing path.
  f.settings.platform = 'linux'
  f.settings.profileRoot = path.join(f.root, 'state')
  const worker = f.write('installed/resources/voice-runtime/worker.py')
  const python = f.write('state/voice-runtime/venv/bin/python')
  assert.deepEqual(resolveVoiceRuntime(f.settings), { worker, python, dataRoot: f.settings.runtimeDataRoot })
})

test('a corrupt packaged marker is an actionable repair error, not a machine Python fallback', t => {
  const f = fixture(t)
  f.write('installed/resources/voice-runtime/worker.py')
  f.write('installed/resources/voice-runtime/bundle/runtime.json', '{broken')
  f.write('state/voice-runtime/venv/Scripts/python.exe')
  assert.throws(() => resolveVoiceRuntime(f.settings), { code: 'VOICE_RUNTIME_BUNDLE_INVALID' })
})

test('links cannot redirect packaged speech assets outside their owner', t => {
  const f = fixture(t)
  f.write('installed/resources/voice-runtime/worker.py')
  f.write('outside/runtime.json', '{}')
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.root, 'installed/resources/voice-runtime/bundle'), 'junction')
  assert.throws(() => resolveVoiceRuntime(f.settings), { code: 'VOICE_RUNTIME_UNSAFE_PATH' })
})

test('missing speech reports missing instead of executing an ambient Python', t => {
  const f = fixture(t)
  f.write('installed/resources/voice-runtime/worker.py')
  assert.throws(() => resolveVoiceRuntime(f.settings), { code: 'VOICE_RUNTIME_NOT_INSTALLED' })
})
