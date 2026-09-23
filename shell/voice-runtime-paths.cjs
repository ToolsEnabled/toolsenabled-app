'use strict'

const path = require('node:path')
const fs = require('node:fs')
const fail = code => { throw Object.assign(new Error(code), { code }) }

function checked(root, candidate, exists = false) {
  if (!path.isAbsolute(root || '') || !path.isAbsolute(candidate || '')) return false
  const relative = path.relative(root, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  let current = path.parse(candidate).root
  for (const part of path.relative(current, candidate).split(path.sep)) {
    current = path.join(current, part)
    try { if (fs.lstatSync(current).isSymbolicLink()) fail('VOICE_RUNTIME_UNSAFE_PATH') }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return !exists; throw error }
  }
  return true
}

// Called only on explicit voice start. This reads one bounded marker and a
// fixed number of path entries, never model bytes or a recursive inventory.
function resolveVoiceRuntime({ appRoot, resourcesPath, profileRoot, runtimeDataRoot, platform = process.platform }) {
  if (!path.isAbsolute(profileRoot || '')) fail('VOICE_RUNTIME_UNSAFE_PATH')
  // The host supplies these read-only code roots. A per-machine installation
  // may be outside the profile; interpreter/cache storage must still be owned.
  for (const root of [appRoot, resourcesPath].filter(Boolean)) {
    if (!path.isAbsolute(root) || (platform === 'win32' && /^[a-z]:[\\/]users[\\/]/i.test(root) && !checked(profileRoot, root))) fail('VOICE_RUNTIME_UNSAFE_PATH')
  }
  if (platform === 'win32' && resourcesPath) {
    const assetRoot = path.join(resourcesPath, 'voice-runtime')
    if (/^[a-z]:[\\/]users[\\/]/i.test(assetRoot) && !checked(profileRoot, assetRoot)) fail('VOICE_RUNTIME_UNSAFE_PATH')
    if (checked(assetRoot, assetRoot, true)) {
      const bundle = path.join(assetRoot, 'bundle'), marker = path.join(bundle, 'runtime.json')
      if (checked(assetRoot, marker, true)) {
        if (fs.statSync(marker).size > 4096) fail('VOICE_RUNTIME_BUNDLE_INVALID')
        let value
        try { value = JSON.parse(fs.readFileSync(marker, 'utf8')) } catch { fail('VOICE_RUNTIME_BUNDLE_INVALID') }
        if (value.schemaVersion !== 1 || value.platform !== 'win32' || value.arch !== 'x64' || value.pythonVersion !== '3.13.3') fail('VOICE_RUNTIME_BUNDLE_INVALID')
        const python = path.join(bundle, 'python/python.exe'), worker = path.join(assetRoot, 'worker.py')
        if (!checked(assetRoot, python, true) || !checked(assetRoot, worker, true)) fail('VOICE_RUNTIME_BUNDLE_INVALID')
        if (!checked(profileRoot, runtimeDataRoot)) fail('VOICE_RUNTIME_UNSAFE_PATH')
        return { python, worker, dataRoot: runtimeDataRoot, assetRoot, modelRoot: path.join(bundle, 'models') }
      }
    }
  }
  const workers = [appRoot, resourcesPath].filter(Boolean).map(root => ({ root, worker: path.join(root, 'voice-runtime/worker.py') }))
  const dataRoots = [path.resolve(appRoot, '../deps/voice-runtime'), runtimeDataRoot].filter(Boolean)
  for (const { root, worker } of workers) for (const dataRoot of dataRoots) {
    const python = path.join(dataRoot, 'venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    if (checked(root, worker, true) && checked(profileRoot, python, true)) return { worker, python, dataRoot }
  }
  fail('VOICE_RUNTIME_NOT_INSTALLED')
}

module.exports = { resolveVoiceRuntime }
