'use strict'

// Preparation owns downloads. Drivers only read an already prepared, pinned
// archive and compare the runtime with its members; an installed-tree manifest
// cannot turn arbitrary existing executable bytes into upstream provenance.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')
const { pipeline } = require('node:stream/promises')
const { Readable, Writable } = require('node:stream')
const profileGuard = require('../../shell/install-profile-guard.cjs')

const PACKAGES = Object.freeze({ playwright: '1.63.0', esbuild: '0.25.12', unzipper: '0.12.5' })
// Derived from checksums.json in the Electron npm archive with this exact SRI.
// A version change must review both its lock input and upstream archive pins.
const ELECTRON = Object.freeze({ version: '43.3.0',
  integrity: 'sha512-nLlvu0WFjftWsSaTkV2B/c4NDuJBspTyXu8vKSQ6vLvFt8uG3NgN49LLKcXddwX0GqVvAQDhciWp+4xOdTdhew==',
  archives: Object.freeze({
    'linux-x64': 'f4987e9f045e46b117f0805d6ba4dc524e2abb2c2e33660f175bb39564bd3dae',
    'win32-x64': '18528bedc6a9b04bdc5efb7b803cbc3cb0e5ea6415d54046e23d464d89a00da9',
  }),
})
const LIMITS = Object.freeze({ archive: 512 * 1024 * 1024, directory: 8 * 1024 * 1024,
  entries: 4096, member: 512 * 1024 * 1024, expanded: 2 * 1024 * 1024 * 1024 })
const fail = message => { throw new Error(`Native test dependencies: ${message}`) }
function ordinary(input, { directory = false, missing = false, twoLinks = false } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || /[\x00-\x1f]/.test(input)) fail('an ordinary absolute path is required')
  const resolved = path.resolve(input)
  if (process.platform === 'win32' && (!profileGuard.insideWindowsPath(resolved, os.userInfo().homedir)
      || profileGuard.usesUnsupportedWindowsPathNamespace(input))) fail('path leaves the current Windows account')
  let cursor = path.parse(resolved).root
  const parts = path.relative(cursor, resolved).split(path.sep).filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i])
    let stat
    try { stat = fs.lstatSync(cursor) } catch (error) {
      if (missing && i === parts.length - 1 && error.code === 'ENOENT') return null
      throw error
    }
    if (stat.isSymbolicLink()) fail('linked dependency path')
    if (i < parts.length - 1 || directory) { if (!stat.isDirectory()) fail('dependency directory is not ordinary') }
    else if (!stat.isFile() || (stat.nlink !== 1 && !(twoLinks && stat.nlink === 2))) fail('dependency file is not ordinary or is shared')
  }
  return resolved
}
function json(file) {
  ordinary(file)
  if (fs.statSync(file).size > 8 * 1024 * 1024) fail('dependency JSON exceeds its bound')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function dependencyPin(root, platform = process.platform, arch = process.arch) {
  root = ordinary(root, { directory: true })
  const pkg = json(path.join(root, 'package.json')), lock = json(path.join(root, 'package-lock.json'))
  const pinned = lock.packages?.['node_modules/electron']
  if (pkg.build?.electronVersion !== ELECTRON.version || pinned?.version !== ELECTRON.version
      || pkg.devDependencies?.electron !== lock.packages?.['']?.devDependencies?.electron
      || pinned.integrity !== ELECTRON.integrity
      || pinned.resolved !== `https://registry.npmjs.org/electron/-/electron-${ELECTRON.version}.tgz`) fail('Electron build and lock pins differ from the reviewed archive contract')
  for (const [name, version] of Object.entries(PACKAGES)) {
    if (pkg.devDependencies?.[name] !== version || lock.packages?.['']?.devDependencies?.[name] !== version
        || lock.packages?.[`node_modules/${name}`]?.version !== version) fail(`${name} is not a direct locked prerequisite`)
  }
  const sha256 = ELECTRON.archives[`${platform}-${arch}`]
  if (!sha256) fail('unsupported native test platform or architecture')
  const name = `electron-v${ELECTRON.version}-${platform}-${arch}.zip`
  return { version: ELECTRON.version, platform, arch, name, sha256,
    url: `https://github.com/electron/electron/releases/download/v${ELECTRON.version}/${name}` }
}
async function digest(stream, limit, signal) {
  const hash = crypto.createHash('sha256'); let bytes = 0
  await pipeline(stream, new Writable({ write(chunk, _encoding, callback) {
    bytes += chunk.length
    if (bytes > limit) return callback(new Error('Native test dependencies: streamed bytes exceed their bound'))
    hash.update(chunk); callback()
  } }), { signal })
  return { bytes, sha256: hash.digest('hex') }
}
function zipEnvelope(fd, size) {
  if (size < 22 || size > LIMITS.archive) fail('archive size exceeds its bound')
  const tail = Buffer.alloc(Math.min(size, 65557))
  fs.readSync(fd, tail, 0, tail.length, size - tail.length)
  let at = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { at = i; break }
  }
  if (at < 0) fail('archive has no bounded terminal directory')
  const count = tail.readUInt16LE(at + 10), bytes = tail.readUInt32LE(at + 12), offset = tail.readUInt32LE(at + 16)
  if (tail.readUInt16LE(at + 4) !== 0 || tail.readUInt16LE(at + 6) !== 0
      || count === 0 || count > LIMITS.entries || tail.readUInt16LE(at + 8) !== count
      || bytes > LIMITS.directory || offset + bytes !== size - tail.length + at) fail('archive directory exceeds its closed single-volume bounds')
  return { count, bytes, offset, tailSize: tail.length }
}
function memberName(value) {
  const name = value.endsWith('/') ? value.slice(0, -1) : value
  if (!name || /[\\:\x00-\x1f]/.test(name) || path.posix.isAbsolute(name)
      || name.split('/').some(part => !part || ['.', '..'].includes(part) || /[. ]$/.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('unsafe archive member path')
  return name
}
async function openPinnedArchive(archive, expectedSha256, dependencyRoot) {
  archive = ordinary(archive)
  const fd = fs.openSync(archive, 'r'), before = fs.fstatSync(fd, { bigint: true })
  const streams = new Set(); let closed = false, rejectStream
  const streamFailure = new Promise((_resolve, reject) => { rejectStream = reject })
  streamFailure.catch(() => {})
  const guard = promise => Promise.race([promise, streamFailure])
  function assertStable() {
    const same = stat => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === stat[key])
    if (closed || !same(fs.fstatSync(fd, { bigint: true }))
        || !same(fs.statSync(ordinary(archive), { bigint: true }))) fail('archive changed during verification')
  }
  function close() {
    if (closed) return
    closed = true
    // These are bounded reader adapters, not fs streams that can close the
    // shared descriptor when unzipper finishes an individual member.
    for (const stream of streams) stream.destroy()
    fs.closeSync(fd)
  }
  const source = {
    size: async () => { assertStable(); return Number(before.size) },
    stream(start = 0, length) {
      assertStable()
      if (!Number.isSafeInteger(start) || start < 0 || start > Number(before.size)
          || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) fail('archive read exceeds its bound')
      const end = Math.min(Number(before.size), length === undefined ? Number(before.size) : start + length)
      const stream = Readable.from((function * () {
        for (let position = start; position < end;) {
          assertStable()
          const bytes = Buffer.alloc(Math.min(64 * 1024, end - position))
          const count = fs.readSync(fd, bytes, 0, bytes.length, position)
          if (!count) fail('archive read ended before its bound')
          position += count
          yield bytes.subarray(0, count)
        }
      })())
      streams.add(stream)
      stream.once('close', () => streams.delete(stream))
      stream.on('error', rejectStream)
      return stream
    },
  }
  try {
    assertStable()
    const envelope = zipEnvelope(fd, Number(before.size))
    if ((await digest(source.stream(), LIMITS.archive)).sha256 !== expectedSha256) fail('archive differs from its pinned upstream SHA-256')
    const reader = createRequire(path.join(dependencyRoot, 'package.json'))('unzipper')
    const directory = await guard(reader.Open.custom(source, { tailSize: envelope.tailSize }))
    if (directory.files.length !== envelope.count) fail('archive directory count changed')
    const names = new Set(); let expanded = 0
    for (const entry of directory.files) {
      const name = memberName(entry.path), key = name.toLowerCase()
      if (names.has(key)) fail('duplicate archive member path')
      names.add(key)
      const mode = entry.externalFileAttributes >>> 16, type = mode & 0o170000
      if ((type && type !== 0o100000 && type !== 0o040000) || (entry.externalFileAttributes & 0x400)) fail('archive contains a link or special member')
      if ((entry.type === 'Directory') !== (entry.path.endsWith('/')) || (type === 0o040000 && entry.type !== 'Directory')) fail('archive member type differs from its path')
      if (![0, 8].includes(entry.compressionMethod) || (entry.flags & 1)
          || entry.uncompressedSize > LIMITS.member || entry.compressedSize > LIMITS.archive
          || entry.offsetToLocalFileHeader >= envelope.offset) fail('unsupported or oversized archive member')
      expanded += entry.uncompressedSize
      if (expanded > LIMITS.expanded) fail('archive expanded bytes exceed their bound')
      // The installer reads local headers. Prove they name the same members as
      // the bounded central directory used by the comparison reader.
      const header = Buffer.alloc(30)
      if (fs.readSync(fd, header, 0, 30, entry.offsetToLocalFileHeader) !== 30
          || header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== entry.flags
          || header.readUInt16LE(8) !== entry.compressionMethod) fail('archive local header differs from its directory')
      const length = header.readUInt16LE(26), extra = header.readUInt16LE(28)
      if (length > 4096 || entry.offsetToLocalFileHeader + 30 + length + extra + entry.compressedSize > envelope.offset) fail('archive local member exceeds its bound')
      const bytes = Buffer.alloc(length)
      if (fs.readSync(fd, bytes, 0, length, entry.offsetToLocalFileHeader + 30) !== length
          || !bytes.equals(entry.pathBuffer)) fail('archive local path differs from its directory')
    }
    assertStable()
    return { entries: directory.files, source, guard, assertStable, close }
  } catch (error) { close(); throw error }
}
function runtimeFiles(root) {
  const names = []; let count = 0
  function visit(directory, prefix = '') {
    for (const name of fs.readdirSync(ordinary(directory, { directory: true }))) {
      if (++count > LIMITS.entries) fail('runtime entry count exceeds its bound')
      const file = path.join(directory, name), relative = prefix + name, stat = fs.lstatSync(file)
      if (stat.isDirectory()) visit(file, relative + '/')
      else { ordinary(file); names.push(relative); if (names.length > LIMITS.entries) fail('runtime file count exceeds its bound') }
    }
  }
  visit(root); return names.sort()
}
async function verifyArchiveRuntime(archive, expectedSha256, runtime, platform = process.platform, dependencyRoot = path.resolve(__dirname, '../..')) {
  const opened = await openPinnedArchive(archive, expectedSha256, dependencyRoot), expected = []
  try {
    runtime = ordinary(runtime, { directory: true })
    for (const entry of opened.entries) {
      // The official installer moves the type declaration above dist; it is not
      // a runtime input. Every other file must remain present and byte-identical.
      if (entry.type === 'Directory' || entry.path === 'electron.d.ts') continue
      expected.push(entry.path)
      const file = ordinary(path.join(runtime, entry.path)), stat = fs.statSync(file)
      if (stat.size !== entry.uncompressedSize) fail(`runtime member size differs: ${entry.path}`)
      const cancellation = new AbortController(), comparisons = []
      let reference, installed
      try {
        comparisons.push(digest(entry.stream(), entry.uncompressedSize, cancellation.signal))
        comparisons.push(digest(fs.createReadStream(file), entry.uncompressedSize, cancellation.signal))
        ;[reference, installed] = await opened.guard(Promise.all(comparisons))
      } finally {
        // unzipper does not forward every source error to its member stream.
        // Settle both pipelines, including the ordinary runtime fd, on refusal.
        cancellation.abort()
        await Promise.allSettled(comparisons)
      }
      opened.assertStable()
      if (reference.bytes !== entry.uncompressedSize || reference.sha256 !== installed.sha256) fail(`runtime member bytes differ: ${entry.path}`)
      const after = fs.statSync(ordinary(file))
      if (['ino', 'dev', 'size', 'mtimeMs', 'ctimeMs', 'mode'].some(key => stat[key] !== after[key])) fail(`runtime member changed during verification: ${entry.path}`)
      if (platform === 'linux' && ((entry.externalFileAttributes >>> 16) & 0o111) !== (stat.mode & 0o111)) fail(`runtime executable mode differs: ${entry.path}`)
    }
    if (!expected.length || JSON.stringify(expected.sort()) !== JSON.stringify(runtimeFiles(runtime))) fail('runtime file membership differs from its pinned archive')
    // Every read uses the descriptor hashed above; ctime also detects an in-place
    // write whose bytes and mtime were restored before this final hash.
    if ((await digest(opened.source.stream(), LIMITS.archive)).sha256 !== expectedSha256) fail('archive changed during runtime verification')
    opened.assertStable()
    return { archiveSha256: expectedSha256, files: expected.length }
  } finally { opened.close() }
}
function preparedPaths(root, pin) {
  const modules = ordinary(path.join(root, 'node_modules'), { directory: true })
  const electron = ordinary(path.join(modules, 'electron'), { directory: true })
  const installed = json(path.join(electron, 'package.json'))
  if (installed.version !== pin.version || json(path.join(electron, 'checksums.json'))[pin.name] !== pin.sha256) fail('installed Electron package differs from the reviewed pin')
  const assets = path.join(modules, '.native-test-assets')
  return { modules, electron, assets, archive: path.join(assets, pin.name), runtime: path.join(electron, 'dist') }
}
function installedPackages(root, externalPlaywright, modules = path.join(root, 'node_modules')) {
  const playwright = playwrightPackage(root, externalPlaywright, modules)
  const appRequire = createRequire(path.join(root, 'package.json'))
  for (const name of ['esbuild', 'unzipper']) {
    if (json(path.join(modules, name, 'package.json')).version !== PACKAGES[name]) fail(`${name} differs from its locked version`)
    ordinary(appRequire.resolve(path.join(modules, name)))
  }
  if (process.env.ESBUILD_BINARY_PATH) fail('ESBUILD_BINARY_PATH cannot replace the prepared binary')
  const binary = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'
  const loader = createRequire(path.join(modules, 'esbuild', 'package.json'))
  const native = `@esbuild/${process.platform}-${process.arch}`
  if (json(loader.resolve(`${native}/package.json`)).version !== PACKAGES.esbuild) fail('esbuild native package differs from its locked version')
  const executable = ordinary(loader.resolve(`${native}/${binary}`), { twoLinks: true })
  const stat = fs.statSync(executable)
  if (stat.nlink === 2) {
    // esbuild's own postinstall may hardlink these two private names. Refuse
    // every other link count or peer instead of rejecting a normal npm ci.
    const shim = ordinary(path.join(modules, 'esbuild/bin/esbuild'), { twoLinks: true })
    const peer = fs.statSync(shim)
    if (peer.nlink !== 2 || peer.dev !== stat.dev || peer.ino !== stat.ino) fail('esbuild binary has a hardlink outside its installed pair')
  }
  return playwright
}
async function verifyNativeTestDependencies(root, options) {
  if (options !== undefined) fail('local preparation verification does not accept engineering-kit overrides')
  const pin = dependencyPin(root), paths = preparedPaths(root, pin)
  installedPackages(root)
  const leaf = pin.platform === 'win32' ? 'electron.exe' : 'electron'
  const receipt = await verifyArchiveRuntime(paths.archive, pin.sha256, paths.runtime, pin.platform, root)
  return { ...receipt, scope: 'prepared-local', qualificationEligible: true,
    version: pin.version, platform: pin.platform, arch: pin.arch, executable: ordinary(path.join(paths.runtime, leaf)) }
}
function playwrightPackage(root, external, modules = path.join(root, 'node_modules')) {
  const local = path.join(modules, 'playwright')
  // A broken local package is a preparation failure, never a fallback trigger.
  let present = false
  try { fs.lstatSync(local); present = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  const selected = present ? local : external
  if (!selected) fail('Playwright is absent; prepare this checkout with its committed npm lock')
  ordinary(selected, { directory: true })
  const pkg = json(path.join(selected, 'package.json'))
  if (pkg.name !== 'playwright' || pkg.version !== PACKAGES.playwright) fail('Playwright differs from its locked version')
  const loader = createRequire(path.join(selected, 'package.json'))
  ordinary(loader.resolve(selected))
  const core = json(loader.resolve('playwright-core/package.json'))
  if (core.version !== PACKAGES.playwright || pkg.dependencies?.['playwright-core'] !== PACKAGES.playwright) fail('Playwright core differs from its locked version')
  ordinary(loader.resolve('playwright-core'))
  return { module: selected, load: () => loader(selected) }
}
async function resolveNativeDriverDependencies(root, { modules, playwright: external, electron } = {}) {
  root = ordinary(root, { directory: true })
  const local = path.join(root, 'node_modules')
  let localStat
  try { localStat = fs.lstatSync(local) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (localStat && !localStat.isDirectory() && !localStat.isSymbolicLink()) fail('local dependency directory is not ordinary')
  let runtime, playwright
  // A present ordinary local installation always wins. Corrupt or unprepared
  // local dependencies cannot silently become an engineering-kit fallback.
  if (localStat?.isDirectory() || (!modules && !external && !electron)) {
    runtime = await verifyNativeTestDependencies(root)
    modules = ordinary(local, { directory: true })
    playwright = playwrightPackage(root)
  } else {
    const pin = dependencyPin(root)
    const leaf = pin.platform === 'win32' ? 'electron.exe' : 'electron'
    // Preserve the component driver's original explicit --playwright plus
    // checkout-link invocation. Reading the link itself does not follow it;
    // ordinary() fences its selected target before any target filesystem probe.
    if (localStat?.isSymbolicLink() && external && !modules && !electron) {
      modules = ordinary(path.resolve(root, fs.readlinkSync(local)), { directory: true })
      electron = path.join(modules, 'electron', 'dist', leaf)
    }
    if (!modules || !electron || !external) fail('an engineering kit requires explicit modules, Electron and Playwright paths')
    modules = ordinary(modules, { directory: true })
    if (localStat?.isSymbolicLink() && path.relative(modules, path.resolve(root, fs.readlinkSync(local)))) fail('engineering modules must match the checkout dependency link')
    const executable = ordinary(electron)
    if (path.relative(path.join(modules, 'electron', 'dist', leaf), executable)) fail('engineering Electron must belong to the selected modules directory')
    if (json(path.join(modules, 'electron', 'package.json')).version !== pin.version) fail('engineering Electron differs from its locked version')
    playwright = installedPackages(root, external, modules)
    runtimeFiles(path.dirname(executable))
    // The historical explicit kit carries no pinned upstream archive. Its
    // ordinary path/version checks cannot satisfy cut or source qualification.
    runtime = { scope: 'engineering-kit', qualificationEligible: false,
      version: pin.version, platform: pin.platform, arch: pin.arch, executable }
  }
  return { playwright: playwright.load(), executablePath: runtime.executable,
    modulesDirectory: modules,
    receipt: { ...runtime, modulesDirectory: modules, playwrightVersion: PACKAGES.playwright, playwrightModule: playwright.module } }
}
function nativeElectronInstallEnvironment(base, { platform, arch, cache, temporary }) {
  const env = { ...base }
  for (const key of Object.keys(env)) {
    if (/^(electron_|npm_config_electron_|npm_package_config_electron_)/i.test(key)
        || /^(npm_config_(arch|platform)|tmpdir|temp|tmp)$/i.test(key)) delete env[key]
  }
  return { ...env, ELECTRON_INSTALL_PLATFORM: platform, ELECTRON_INSTALL_ARCH: arch,
    electron_config_cache: cache, TMPDIR: temporary, TEMP: temporary, TMP: temporary }
}
async function prepareNativeTestDependencies(root) {
  const pin = dependencyPin(root), paths = preparedPaths(root, pin)
  installedPackages(root)
  // Refuse an unsafe existing target before any preparation writes/downloads.
  const existingRuntime = ordinary(paths.runtime, { directory: true, missing: true })
  ordinary(paths.assets, { directory: true, missing: true })
  fs.mkdirSync(paths.assets, { recursive: true, mode: 0o700 })
  const cache = path.join(paths.assets, 'cache'), temporary = path.join(paths.assets, 'temporary')
  for (const directory of [cache, temporary]) {
    ordinary(directory, { directory: true, missing: true })
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    runtimeFiles(directory) // Refuse nested links before the downloader writes.
  }
  const electronRequire = createRequire(path.join(paths.electron, 'package.json'))
  if (!fs.existsSync(paths.archive)) {
    // Fixed official URL and packaged checksum; no caller URL, downloader or
    // mirror callback is accepted. The library handles the official cache.
    const { downloadArtifact } = electronRequire('@electron/get')
    const downloaded = await downloadArtifact({ version: pin.version, platform: pin.platform, arch: pin.arch,
      artifactName: 'electron', cacheRoot: cache, tempDirectory: temporary,
      checksums: { [pin.name]: pin.sha256 }, mirrorOptions: { resolveAssetURL: () => pin.url },
      downloadOptions: { signal: AbortSignal.timeout(180000), getProgressCallback({ transferred, total }) {
        if (transferred > LIMITS.archive || (total !== null && total > LIMITS.archive)) fail('download exceeds the archive byte bound')
      } } })
    ordinary(downloaded)
    const downloadedArchive = await openPinnedArchive(downloaded, pin.sha256, root)
    downloadedArchive.close()
    fs.copyFileSync(downloaded, paths.archive, fs.constants.COPYFILE_EXCL)
  }
  const preparedArchive = await openPinnedArchive(paths.archive, pin.sha256, root)
  preparedArchive.close()
  if (!existingRuntime) {
    const env = nativeElectronInstallEnvironment(process.env, { platform: pin.platform, arch: pin.arch, cache, temporary })
    const result = spawnSync(process.execPath, [ordinary(path.join(paths.electron, 'install.js'))], {
      cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 180000,
    })
    if (result.error || result.status !== 0) fail('the explicit pinned Electron installer did not complete')
  }
  const receipt = await verifyNativeTestDependencies(root)
  playwrightPackage(root)
  return receipt
}
module.exports = { dependencyPin, verifyArchiveRuntime, verifyNativeTestDependencies,
  prepareNativeTestDependencies, resolveNativeDriverDependencies, playwrightPackage, nativeElectronInstallEnvironment, LIMITS }
