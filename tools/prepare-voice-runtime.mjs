#!/usr/bin/env node
// Build-only packaging of the already provisioned, pinned speech stack. No
// network, pip, venv relocation, owner caches, or machine Python at runtime.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PYTHON_VERSION = '3.13.3'
const MANIFEST = 'bundle-manifest.json'
const PYTHON_PATHS = '.\nLib\nDLLs\nLib\\site-packages\n..\\..\nimport site\n'
const normalize = value => value.toLowerCase().replace(/[-_.]+/g, '-')
const relativeFile = value => typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes(':') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..')
const lockedPackages = sourceRoot => new Map(fs.readFileSync(path.join(sourceRoot, 'requirements.lock.txt'), 'utf8').split(/\r?\n/).filter(line => /^[\w.-]+==/.test(line)).map(line => { const [name, version] = line.split('=='); return [normalize(name), version.trim()] }))

export function checkedPath(root, candidate, { missing = false } = {}) {
  if (typeof root !== 'string' || typeof candidate !== 'string' || !path.isAbsolute(root) || !path.isAbsolute(candidate)) throw new Error('Speech paths must be explicit absolute paths')
  const absolute = path.resolve(candidate), fence = path.resolve(root)
  const relative = path.relative(fence, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Speech path leaves its declared root')
  let current = path.parse(fence).root
  for (const segment of path.relative(current, absolute).split(path.sep)) {
    current = path.join(current, segment)
    let entry
    try { entry = fs.lstatSync(current) } catch (error) { if (missing && error.code === 'ENOENT') continue; throw error }
    if (entry.isSymbolicLink()) throw new Error('Speech assets must not contain links')
  }
  return absolute
}

async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
function filesIn(directory, prefix = '', include = () => true) {
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (!include(name, entry.isDirectory())) continue
    if (entry.isSymbolicLink()) throw new Error('Speech assets must not contain links')
    if (entry.isDirectory()) result.push(...filesIn(path.join(directory, entry.name), name + '/', include))
    else if (entry.isFile()) result.push(name)
    else throw new Error('Speech payload contains a non-file asset')
  }
  return result.sort()
}
function csvRow(line) {
  const result = []; let value = '', quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '"' && line[index + 1] === '"' && quoted) { value += '"'; index++ }
    else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) { result.push(value); value = '' }
    else value += char
  }
  result.push(value)
  return result
}
function sourceFiles(sourceRoot) {
  return filesIn(sourceRoot, '', name => name !== 'bundle' && name !== 'tests' && !name.split('/').includes('__pycache__') && !/\.py[co]$/.test(name) && name !== 'smoke_test.py')
}

export async function verifyVoiceBundle(bundleRoot, sourceRoot) {
  checkedPath(bundleRoot, bundleRoot)
  const manifest = JSON.parse(fs.readFileSync(checkedPath(bundleRoot, path.join(bundleRoot, MANIFEST)), 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.pythonVersion !== PYTHON_VERSION || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid Windows speech bundle manifest')
  const listed = new Set()
  for (const item of manifest.files) {
    if (!relativeFile(item.path) || listed.has(item.path) || !Number.isSafeInteger(item.bytes) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid speech bundle file entry')
    listed.add(item.path)
    const file = checkedPath(bundleRoot, path.join(bundleRoot, item.path))
    if (fs.statSync(file).size !== item.bytes || await digest(file) !== item.sha256) throw new Error(`Speech bundle integrity failed: ${item.path}`)
  }
  const actual = filesIn(bundleRoot).filter(name => name !== MANIFEST)
  if (actual.length !== listed.size || actual.some(name => !listed.has(name))) throw new Error('Speech bundle contains unlisted files')
  for (const name of ['runtime.json', 'python/python.exe', 'python/python313.dll', 'python/python313._pth', 'python/LICENSE.txt', 'python/Lib/encodings/__init__.py']) {
    if (!listed.has(name)) throw new Error(`Speech bundle is incomplete: ${name}`)
  }
  if (fs.readFileSync(path.join(bundleRoot, 'python/python313._pth'), 'utf8') !== PYTHON_PATHS) throw new Error('Speech Python search paths are not portable and isolated')
  const marker = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'runtime.json'), 'utf8'))
  if (marker.schemaVersion !== 1 || marker.platform !== 'win32' || marker.arch !== 'x64' || marker.pythonVersion !== PYTHON_VERSION) throw new Error('Invalid speech readiness marker')
  const models = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'model-assets.json'), 'utf8'))
  for (const asset of models.files) {
    const entry = manifest.files.find(item => item.path === `models/${asset.path}`)
    if (!entry || entry.bytes !== asset.bytes || entry.sha256 !== asset.sha256) throw new Error(`Speech bundle lacks the pinned model: ${asset.path}`)
  }
  const lock = await digest(path.join(sourceRoot, 'requirements.lock.txt'))
  const notices = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'redistribution-assets.json'), 'utf8'))
  for (const asset of notices.files) {
    const entry = manifest.files.find(item => item.path === `notices/${asset.path}`)
    if (!entry || entry.bytes !== asset.bytes || entry.sha256 !== asset.sha256) throw new Error(`Speech bundle lacks its pinned notice/source: ${asset.path}`)
  }
  const pins = lockedPackages(sourceRoot), packages = new Map()
  for (const entry of manifest.files.filter(item => /^python\/Lib\/site-packages\/[^/]+\.dist-info\/METADATA$/.test(item.path))) {
    const metadata = fs.readFileSync(path.join(bundleRoot, entry.path), 'utf8')
    const name = normalize(/^Name: (.+)$/m.exec(metadata)?.[1].trim() || ''), version = /^Version: (.+)$/m.exec(metadata)?.[1].trim()
    if (!pins.has(name) || pins.get(name) !== version || packages.has(name)) throw new Error('Speech bundle contains an unlocked or duplicate distribution')
    packages.set(name, version)
  }
  if (packages.size !== pins.size) throw new Error('Speech bundle is missing locked distributions')
  if (manifest.requirementsSha256 !== lock) throw new Error('Speech bundle dependencies are stale')
  for (const file of sourceFiles(sourceRoot)) {
    if (manifest.workerSource?.[file] !== await digest(path.join(sourceRoot, file))) throw new Error(`Speech bundle source changed: ${file}`)
  }
  return manifest
}

export async function prepareVoiceBundle({ profileRoot, runtimeRoot, python, noticesRoot, appRoot = ROOT, output = path.join(appRoot, 'voice-runtime/bundle'), log = console.log }) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The current speech payload requires a native Windows x64 builder')
  checkedPath(profileRoot, runtimeRoot)
  checkedPath(profileRoot, noticesRoot)
  checkedPath(profileRoot, output, { missing: true })
  if (fs.existsSync(output)) throw new Error('Speech bundle output already exists; verify it or choose a new staging directory')
  if (!path.isAbsolute(python)) throw new Error('Choose an explicit base Python executable')
  // A system interpreter is a required build input; another profile never is.
  if (/^[a-z]:[\\/]users[\\/]/i.test(python)) checkedPath(profileRoot, python)
  else checkedPath(path.dirname(python), python)
  const identity = JSON.parse(execFileSync(python, ['-I', '-B', '-c', 'import json,sys,struct;print(json.dumps({"version":".".join(map(str,sys.version_info[:3])),"base":sys.base_prefix,"bits":struct.calcsize("P")*8}))'], { windowsHide: true, encoding: 'utf8' }))
  if (identity.version !== PYTHON_VERSION || identity.bits !== 64 || path.resolve(identity.base) !== path.dirname(path.resolve(python))) throw new Error('Use the tested standalone CPython 3.13.3 x64 base interpreter')
  const source = path.join(appRoot, 'voice-runtime')
  const pins = lockedPackages(source)
  log(`Speech: checking the installed files for ${pins.size} locked dependencies`)
  const packages = [], fileHashes = new Map()
  const site = checkedPath(profileRoot, path.join(runtimeRoot, 'venv/Lib/site-packages'))
  for (const entry of fs.readdirSync(site, { withFileTypes: true })) {
    if (!entry.name.endsWith('.dist-info')) continue
    const metadata = checkedPath(profileRoot, path.join(site, entry.name, 'METADATA'))
    const body = fs.readFileSync(metadata, 'utf8')
    const name = /^Name: (.+)$/m.exec(body)?.[1].trim(), version = /^Version: (.+)$/m.exec(body)?.[1].trim()
    if (!pins.has(normalize(name || ''))) continue // Do not ship pip or unrelated builder packages.
    if (pins.get(normalize(name)) !== version) throw new Error(`Installed speech dependency differs from its lock: ${name}`)
    packages.push({ name, version })
    for (const line of fs.readFileSync(checkedPath(profileRoot, path.join(site, entry.name, 'RECORD')), 'utf8').split(/\r?\n/)) {
      if (!line) continue
      const [relative, hash] = csvRow(line)
      // Console launchers embed the builder Python path. Only importable wheel
      // contents and their notices/metadata belong in the application payload.
      if (!relativeFile(relative) || /(^|\/)__pycache__\//.test(relative) || /\.py[co]$/.test(relative) || relative.endsWith('/direct_url.json')) continue
      if (!fileHashes.has(relative)) fileHashes.set(relative, new Set())
      if (hash) fileHashes.get(relative).add(hash)
    }
  }
  if (packages.length !== pins.size || new Set(packages.map(item => normalize(item.name))).size !== pins.size) throw new Error('The installed speech environment does not contain every locked dependency exactly once')
  const pending = []
  for (const name of ['python.exe', 'python3.dll', 'python313.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'LICENSE.txt']) pending.push([checkedPath(identity.base, path.join(identity.base, name)), `python/${name}`, null])
  for (const baseDir of ['Lib', 'DLLs']) {
    for (const relative of filesIn(checkedPath(identity.base, path.join(identity.base, baseDir)), '', name => name !== 'site-packages' && name !== 'test' && !name.split('/').includes('__pycache__') && !/\.py[co]$/.test(name))) {
      pending.push([checkedPath(identity.base, path.join(identity.base, baseDir, relative)), `python/${baseDir}/${relative}`, null])
    }
  }
  for (const [relative, hashes] of fileHashes) {
    const file = checkedPath(profileRoot, path.join(site, relative))
    if (hashes.size) {
      const encoded = 'sha256=' + Buffer.from(await digest(file), 'hex').toString('base64url')
      if (!hashes.has(encoded)) throw new Error(`Installed wheel file differs from its RECORD: ${relative}`)
    }
    pending.push([file, `python/Lib/site-packages/${relative}`, null])
  }
  log('Speech: checking the pinned local models and redistribution notices')
  for (const asset of JSON.parse(fs.readFileSync(path.join(source, 'model-assets.json'), 'utf8')).files) {
    if (!relativeFile(asset.path)) throw new Error('Invalid model asset path')
    const file = checkedPath(profileRoot, path.join(runtimeRoot, 'models', asset.path))
    if (fs.statSync(file).size !== asset.bytes || await digest(file) !== asset.sha256) throw new Error(`Installed model differs from its published pin: ${asset.path}`)
    pending.push([file, `models/${asset.path}`, asset.sha256])
  }
  for (const asset of JSON.parse(fs.readFileSync(path.join(source, 'redistribution-assets.json'), 'utf8')).files) {
    if (!relativeFile(asset.path)) throw new Error('Invalid redistribution asset path')
    const file = checkedPath(profileRoot, path.join(noticesRoot, asset.path))
    if (fs.statSync(file).size !== asset.bytes || await digest(file) !== asset.sha256) throw new Error(`Speech notice/source differs from its pin: ${asset.path}`)
    pending.push([file, `notices/${asset.path}`, asset.sha256])
  }
  fs.mkdirSync(output, { recursive: true })
  log(`Speech: packaging ${packages.length} locked dependencies, Python and seven verified local model files`)
  const files = []
  for (const [input, relative, knownHash] of pending) {
    const destination = checkedPath(profileRoot, path.join(output, relative), { missing: true })
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(input, destination, fs.constants.COPYFILE_EXCL)
    files.push({ path: relative, bytes: fs.statSync(destination).size, sha256: knownHash || await digest(destination) })
  }
  const pth = 'python/python313._pth'
  fs.writeFileSync(path.join(output, pth), PYTHON_PATHS, { flag: 'wx' })
  files.push({ path: pth, bytes: fs.statSync(path.join(output, pth)).size, sha256: await digest(path.join(output, pth)) })
  fs.writeFileSync(path.join(output, 'runtime.json'), JSON.stringify({ schemaVersion: 1, platform: 'win32', arch: 'x64', pythonVersion: PYTHON_VERSION }) + '\n', { flag: 'wx' })
  files.push({ path: 'runtime.json', bytes: fs.statSync(path.join(output, 'runtime.json')).size, sha256: await digest(path.join(output, 'runtime.json')) })
  const workerSource = {}
  for (const name of sourceFiles(source)) workerSource[name] = await digest(path.join(source, name))
  const manifest = { schemaVersion: 1, platform: 'win32', arch: 'x64', pythonVersion: PYTHON_VERSION,
    requirementsSha256: await digest(path.join(source, 'requirements.lock.txt')), packages, workerSource,
    files: files.sort((a, b) => a.path.localeCompare(b.path)), bytes: files.reduce((sum, item) => sum + item.bytes, 0) }
  fs.writeFileSync(path.join(output, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  log('Speech: verifying the complete staged payload before packaging')
  await verifyVoiceBundle(output, source)
  log(`Speech: verified ${manifest.files.length} bundled files (${manifest.bytes} bytes); no machine Python is required`)
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL)
    const args = process.argv.slice(2)
    const value = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1] }
    const output = value('--output') || path.join(ROOT, 'voice-runtime/bundle')
    if (args.includes('--verify') || (!args.length && fs.existsSync(output))) await verifyVoiceBundle(output, path.join(ROOT, 'voice-runtime'))
    else {
      let config
      if (!args.length) {
        const file = path.join(ROOT, 'private/voice-runtime-source.owner.json')
        if (!fs.existsSync(file)) throw new Error('Speech packaging inputs are missing. Configure private/voice-runtime-source.owner.json with explicit profileRoot, runtimeRoot, noticesRoot and python paths; the installer cannot omit local speech.')
        config = JSON.parse(fs.readFileSync(file, 'utf8'))
      } else config = { profileRoot: value('--profile-root'), runtimeRoot: value('--runtime-root'), python: value('--python'), noticesRoot: value('--notices-root') }
      await prepareVoiceBundle({ ...config, appRoot: ROOT, output })
    }
  } catch (error) { console.error(`Speech packaging failed: ${error.message}`); process.exitCode = 1 }
}
