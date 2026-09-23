import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import os from 'node:os'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = name => fs.readFileSync(path.join(root, name), 'utf8')
const require = createRequire(import.meta.url)
const { dependencyPin, verifyArchiveRuntime, verifyNativeTestDependencies, resolveNativeDriverDependencies,
  playwrightPackage, nativeElectronInstallEnvironment } = require('../lib/native-driver-dependencies.cjs')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-dependencies-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
function write(root, name, value) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
  fs.writeFileSync(path.join(root, name), typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value)
}
// Small stored ZIP fixtures; only the production reader interprets archives.
function zip(members) {
  const locals = [], records = []; let offset = 0
  for (const { name, text = 'fixture', mode = 0o100644, localName = name } of members) {
    const data = Buffer.from(text), encoded = Buffer.from(name), localEncoded = Buffer.from(localName)
    const local = Buffer.alloc(30), central = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(localEncoded.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(encoded.length, 28)
    central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42)
    locals.push(local, localEncoded, data); records.push(central, encoded)
    offset += local.length + localEncoded.length + data.length
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
function archiveFixture(t, members = [{ name: 'electron', text: 'upstream fixture' }]) {
  const directory = scratch(t), archive = path.join(directory, 'archive.zip'), runtime = path.join(directory, 'dist')
  const bytes = zip(members); fs.writeFileSync(archive, bytes); fs.mkdirSync(runtime)
  for (const entry of members) if (!entry.name.includes('..') && !entry.name.startsWith('/') && entry.name !== 'electron.d.ts') {
    write(runtime, entry.name, entry.text || 'fixture')
    fs.chmodSync(path.join(runtime, entry.name), 0o644)
  }
  return { archive, runtime, hash: sha(bytes), bytes }
}

test('native component packages are direct locked development prerequisites', () => {
  const pkg = JSON.parse(read('package.json')), lock = JSON.parse(read('package-lock.json'))
  for (const [name, version] of Object.entries({ playwright: '1.63.0', esbuild: '0.25.12', unzipper: '0.12.5' })) {
    assert.equal(pkg.devDependencies[name], version, `${name} must be a direct exact dependency`)
    assert.equal(lock.packages[''].devDependencies[name], version)
    assert.equal(lock.packages[`node_modules/${name}`].version, version)
    assert.match(lock.packages[`node_modules/${name}`].integrity, /^sha512-/)
  }
  assert.equal(lock.packages['node_modules/playwright'].dependencies['playwright-core'], '1.63.0')
  assert.equal(lock.packages['node_modules/playwright-core'].version, '1.63.0')
})

test('both native drivers use prepared dependencies without importing the lazy Electron entry', () => {
  for (const name of ['tools/qa/page2-role-studio-interaction.cjs', 'tools/page2-native-audit.cjs']) {
    const source = read(name)
    assert.match(source, /resolveNativeDriverDependencies/)
    assert.doesNotMatch(source, /(?:requireApp|loader)\('electron'\)/)
  }
  const audit = read('tools/page2-native-audit.cjs')
  const resolution = audit.indexOf('await resolveNativeDriverDependencies(appDirectory, options)')
  assert.ok(resolution >= 0 && audit.indexOf('await stageApplication(appDirectory, qaRoot, modulesDirectory') > resolution)
  const component = read('tools/qa/page2-role-studio-interaction.cjs')
  assert.match(component, /resolveNativeDriverDependencies\(options\.app, options\)/)
  assert.match(component, /nodePaths: \[dependencies\.modulesDirectory\]/)
})

test('both fresh cut paths prepare the native archive before tests', () => {
  const materializer = read('tools/release-packager/lib/node-modules-reuse.mjs')
  assert.match(materializer, /prepareNativeTestDependencies/)
  assert.match(materializer, /const assets = path\.join\(targetNodeModules, '\.native-test-assets'\)/)
  assert.match(materializer, /env: nativeElectronInstallEnvironment\(env,/)
  const linux = read('tools/release-packager/cut-linux-release-candidate.mjs')
  assert.ok(linux.indexOf("'native-test-dependencies'") > linux.indexOf("'node-modules-npm-ci'"))
  assert.ok(linux.indexOf("'native-test-dependencies'") < linux.indexOf("'check-drivers-discovered'", linux.indexOf("'node-modules-npm-ci'")))
  const windows = read('tools/release-packager/cut-release-candidate.mjs')
  assert.ok(windows.indexOf('await prepareNativeTestDependencies(worktreePath)') > windows.indexOf('await provisionNodeModules(repo, worktreePath'))
  assert.ok(windows.indexOf('await prepareNativeTestDependencies(worktreePath)') < windows.indexOf("await waitForReleaseSealPhase(sealControl, 'dependencies-materialized')"))
})

test('both native installer environments replace case variants of cache, temp, mirrors and platform overrides', () => {
  const inherited = { PATH: '/approved', ELECTRON_CONFIG_CACHE: '/outside', electron_config_cache: '/outside2',
    ELECTRON_MIRROR: 'https://unapproved.invalid/', npm_config_electron_mirror: 'https://unapproved.invalid/',
    NPM_PACKAGE_CONFIG_ELECTRON_CUSTOMDIR: 'other', npm_config_platform: 'wrong',
    TMPDIR: '/outside', TmpDir: '/outside2', temp: '/outside3', TMP: '/outside4' }
  for (const platform of ['linux', 'win32']) {
    assert.deepEqual(nativeElectronInstallEnvironment(inherited, { platform, arch: 'x64', cache: '/private/cache', temporary: '/private/temp' }),
      { PATH: '/approved', ELECTRON_INSTALL_PLATFORM: platform, ELECTRON_INSTALL_ARCH: 'x64',
        electron_config_cache: '/private/cache', TMPDIR: '/private/temp', TEMP: '/private/temp', TMP: '/private/temp' })
  }
  assert.equal(inherited.ELECTRON_CONFIG_CACHE, '/outside')
})

test('upstream archives are bound to the exact existing Electron build and npm lock pin on both platforms', t => {
  const linux = dependencyPin(root, 'linux', 'x64'), windows = dependencyPin(root, 'win32', 'x64')
  assert.equal(linux.sha256, 'f4987e9f045e46b117f0805d6ba4dc524e2abb2c2e33660f175bb39564bd3dae')
  assert.equal(windows.sha256, '18528bedc6a9b04bdc5efb7b803cbc3cb0e5ea6415d54046e23d464d89a00da9')
  assert.match(linux.url, /^https:\/\/github\.com\/electron\/electron\/releases\/download\/v43\.3\.0\//)
  assert.throws(() => dependencyPin(root, 'linux', 'arm64'), /unsupported/)
  const copy = scratch(t)
  write(copy, 'package.json', read('package.json')); write(copy, 'package-lock.json', read('package-lock.json'))
  const lock = JSON.parse(read('package-lock.json')); lock.packages['node_modules/electron'].integrity = 'sha512-forged'
  write(copy, 'package-lock.json', lock)
  assert.throws(() => dependencyPin(copy), /lock pins differ/)
})

test('runtime verification derives bytes from the archive without writing the runtime or a receipt', async t => {
  const fixture = archiveFixture(t)
  const before = fs.statSync(path.join(fixture.runtime, 'electron')).mtimeMs
  const result = await verifyArchiveRuntime(fixture.archive, fixture.hash, fixture.runtime)
  assert.deepEqual(result, { archiveSha256: fixture.hash, files: 1 })
  assert.equal(fs.statSync(path.join(fixture.runtime, 'electron')).mtimeMs, before)
  assert.deepEqual(fs.readdirSync(fixture.runtime), ['electron'])
})

test('an unchanged archive refuses altered runtime bytes, missing files, and extra files', async t => {
  const fixture = archiveFixture(t)
  write(fixture.runtime, 'electron', 'modified fixture')
  await assert.rejects(verifyArchiveRuntime(fixture.archive, fixture.hash, fixture.runtime), /runtime member bytes differ/)
  fs.unlinkSync(path.join(fixture.runtime, 'electron'))
  await assert.rejects(verifyArchiveRuntime(fixture.archive, fixture.hash, fixture.runtime), /ENOENT/)
  write(fixture.runtime, 'electron', 'upstream fixture'); write(fixture.runtime, 'extra', 'unexpected')
  await assert.rejects(verifyArchiveRuntime(fixture.archive, fixture.hash, fixture.runtime), /membership differs/)
})

test('changing archive and runtime together cannot replace the pinned hash', async t => {
  const fixture = archiveFixture(t)
  const changed = zip([{ name: 'electron', text: 'modified fixture' }])
  fs.writeFileSync(fixture.archive, changed); write(fixture.runtime, 'electron', 'modified fixture')
  await assert.rejects(verifyArchiveRuntime(fixture.archive, fixture.hash, fixture.runtime), /pinned upstream SHA-256/)
})

test('archive replacement between the initial hash and ZIP reader is refused', async t => {
  const fixture = archiveFixture(t), reader = require('unzipper')
  const original = { file: reader.Open.file, custom: reader.Open.custom }
  let switched = false
  for (const method of Object.keys(original)) reader.Open[method] = function(...args) {
    switched = true
    const before = fs.statSync(fixture.archive)
    fs.renameSync(fixture.archive, fixture.archive + '.original')
    fs.writeFileSync(fixture.archive, zip([{ name: 'electron', text: 'modified fixture' }]))
    fs.utimesSync(fixture.archive, before.atime, before.mtime)
    return original[method].apply(this, args)
  }
  try {
    await assert.rejects(verifyArchiveRuntime(fixture.archive, fixture.hash, fixture.runtime), /archive changed/)
    assert.equal(switched, true, 'the real ZIP reader boundary must be exercised')
  } finally { Object.assign(reader.Open, original) }
})

test('restoring archive bytes and mtime after an in-place write does not restore verification identity', async t => {
  const fixture = archiveFixture(t), reader = require('unzipper')
  const original = { file: reader.Open.file, custom: reader.Open.custom }
  const createReadStream = fs.createReadStream, runtimeStreams = []
  fs.createReadStream = function(file, ...args) {
    const stream = createReadStream.call(this, file, ...args)
    if (file === path.join(fixture.runtime, 'electron')) runtimeStreams.push(stream)
    return stream
  }
  let changed = false
  fs.utimesSync(fixture.archive, 1600000000, 1600000000)
  for (const method of Object.keys(original)) reader.Open[method] = async function(...args) {
    const directory = await original[method].apply(this, args)
    const entry = directory.files[0], stream = entry.stream
    entry.stream = function(...streamArgs) {
      const result = stream.apply(this, streamArgs)
      fs.writeFileSync(fixture.archive, zip([{ name: 'electron', text: 'modified fixture' }]))
      fs.writeFileSync(fixture.archive, fixture.bytes)
      fs.utimesSync(fixture.archive, 1600000000, 1600000000)
      changed = true
      return result
    }
    return directory
  }
  try {
    await assert.rejects(verifyArchiveRuntime(fixture.archive, fixture.hash, fixture.runtime), /archive changed/)
    assert.equal(changed, true, 'the actual member stream must be exercised')
    assert.equal(runtimeStreams.length, 1)
    assert.equal(runtimeStreams[0].closed, true, 'runtime reads must close before archive refusal returns')
    assert.equal(sha(fs.readFileSync(fixture.archive)), fixture.hash)
    assert.equal(fs.statSync(fixture.archive).mtimeMs, 1600000000000)
  } finally { Object.assign(reader.Open, original); fs.createReadStream = createReadStream }
})

for (const [label, members, expected] of [
  ['duplicate', [{ name: 'electron' }, { name: 'electron' }], /duplicate/],
  ['case collision', [{ name: 'electron' }, { name: 'Electron' }], /duplicate/],
  ['traversal', [{ name: '../escape' }], /unsafe/],
  ['absolute', [{ name: '/escape' }], /unsafe/],
  ['alternate separator', [{ name: 'folder\\escape' }], /unsafe/],
  ['link', [{ name: 'electron', mode: 0o120777 }], /link or special/],
  ['local header mismatch', [{ name: 'electron', localName: '../other' }], /local path differs/],
]) test(`archive verification refuses ${label} members before comparison`, async t => {
  const fixture = archiveFixture(t, members)
  await assert.rejects(verifyArchiveRuntime(fixture.archive, fixture.hash, fixture.runtime), expected)
})

test('archive central-directory limits apply before the ZIP reader opens it', async t => {
  const fixture = archiveFixture(t), changed = Buffer.from(fixture.bytes)
  changed.writeUInt16LE(65535, changed.length - 12)
  fs.writeFileSync(fixture.archive, changed)
  await assert.rejects(verifyArchiveRuntime(fixture.archive, sha(changed), fixture.runtime), /directory exceeds/)
})

test('archive expanded-member limits and actual streamed-byte limits are both enforced', async t => {
  const fixture = archiveFixture(t), changed = Buffer.from(fixture.bytes)
  const directory = changed.readUInt32LE(changed.length - 6)
  changed.writeUInt32LE(0x7fffffff, directory + 24)
  fs.writeFileSync(fixture.archive, changed)
  await assert.rejects(verifyArchiveRuntime(fixture.archive, sha(changed), fixture.runtime), /oversized archive member/)
  changed.writeUInt32LE(1, directory + 24)
  fs.writeFileSync(fixture.archive, changed); write(fixture.runtime, 'electron', 'x')
  await assert.rejects(verifyArchiveRuntime(fixture.archive, sha(changed), fixture.runtime), /streamed bytes exceed/)
})

test('runtime symlinks and changed executable bits cannot pass archive comparison', async t => {
  const fixture = archiveFixture(t)
  const moved = fixture.runtime + '-ordinary'
  fs.renameSync(fixture.runtime, moved)
  fs.symlinkSync(moved, fixture.runtime, 'junction')
  await assert.rejects(verifyArchiveRuntime(fixture.archive, fixture.hash, fixture.runtime), /linked/)
  if (process.platform === 'win32') fs.rmdirSync(fixture.runtime)
  else fs.unlinkSync(fixture.runtime)
  fs.renameSync(moved, fixture.runtime)
  // Change the archive's expected execute bit, so this contract also runs on
  // Windows without pretending chmod supplies POSIX permission semantics.
  const mode = (fs.statSync(path.join(fixture.runtime, 'electron')).mode & 0o777) ^ 0o100
  const changed = zip([{ name: 'electron', text: 'upstream fixture', mode: 0o100000 | mode }])
  fs.writeFileSync(fixture.archive, changed)
  await assert.rejects(verifyArchiveRuntime(fixture.archive, sha(changed), fixture.runtime, 'linux'), /executable mode differs/)
})

function playwrightFixture(directory, version = '1.63.0') {
  const selected = path.join(directory, 'node_modules/playwright')
  write(selected, 'package.json', { name: 'playwright', version, dependencies: { 'playwright-core': version }, main: 'index.js' })
  write(selected, 'index.js', 'throw new Error("must not execute during resolution")')
  write(directory, 'node_modules/playwright-core/package.json', { name: 'playwright-core', version })
  write(directory, 'node_modules/playwright-core/index.js', 'throw new Error("must not execute during resolution")')
  return selected
}
test('local Playwright wins over an explicit kit and malformed local packages never fall back', t => {
  const local = scratch(t), external = scratch(t), localPath = playwrightFixture(local), externalPath = playwrightFixture(external)
  assert.equal(playwrightPackage(local, externalPath).module, localPath)
  fs.unlinkSync(path.join(localPath, 'index.js'))
  assert.throws(() => playwrightPackage(local, externalPath), error =>
    ['ENOENT', 'MODULE_NOT_FOUND'].includes(error.code) && error.message.includes('playwright'))
  playwrightFixture(local, '1.62.0')
  assert.throws(() => playwrightPackage(local, externalPath), /locked version/)
  fs.rmSync(path.join(local, 'node_modules'), { recursive: true })
  assert.equal(playwrightPackage(local, externalPath).module, externalPath)
  assert.throws(() => playwrightPackage(local), /Playwright is absent/)
  fs.mkdirSync(path.join(local, 'node_modules'))
  fs.mkdirSync(path.join(local, 'missing'))
  fs.symlinkSync(path.join(local, 'missing'), localPath, 'junction')
  fs.rmdirSync(path.join(local, 'missing'))
  assert.throws(() => playwrightPackage(local, externalPath), /linked/)
})

function nativeFixture(t) {
  const copy = scratch(t)
  write(copy, 'package.json', read('package.json')); write(copy, 'package-lock.json', read('package-lock.json'))
  const pin = dependencyPin(copy)
  write(copy, 'node_modules/electron/package.json', { version: pin.version, main: 'index.js' })
  write(copy, 'node_modules/electron/checksums.json', { [pin.name]: pin.sha256 })
  write(copy, 'node_modules/electron/index.js', 'throw new Error("lazy Electron entry executed")')
  playwrightFixture(copy)
  write(copy, 'node_modules/esbuild/package.json', { version: '0.25.12' })
  write(copy, 'node_modules/unzipper/package.json', { version: '0.12.5' })
  for (const name of ['esbuild', 'unzipper']) write(copy, `node_modules/${name}/index.js`, 'throw new Error("must not execute during verification")')
  const native = `node_modules/@esbuild/${process.platform}-${process.arch}`
  write(copy, `${native}/package.json`, { version: '0.25.12' })
  write(copy, `${native}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`, 'fixture')
  return { copy, native }
}

test('read-only native verification refuses an unprepared tree without importing Electron or downloading', async t => {
  const { copy, native } = nativeFixture(t)
  await assert.rejects(verifyNativeTestDependencies(copy), /ENOENT/)
  assert.equal(fs.existsSync(path.join(copy, 'node_modules/.native-test-assets')), false)
  // Real esbuild postinstall may produce precisely this private hardlink pair.
  const executable = path.join(copy, native, process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild')
  const shim = path.join(copy, 'node_modules/esbuild/bin/esbuild')
  fs.mkdirSync(path.dirname(shim), { recursive: true }); fs.linkSync(executable, shim)
  await assert.rejects(verifyNativeTestDependencies(copy), /ENOENT/)
  fs.linkSync(executable, path.join(copy, 'external-hardlink'))
  await assert.rejects(verifyNativeTestDependencies(copy), /shared/)
})

function engineeringFixture(t) {
  const { copy: kit } = nativeFixture(t), app = scratch(t)
  write(app, 'package.json', read('package.json')); write(app, 'package-lock.json', read('package-lock.json'))
  const modules = path.join(kit, 'node_modules'), playwright = path.join(modules, 'playwright')
  write(playwright, 'index.js', 'module.exports = { marker: "loaded without native launch" }')
  const electron = path.join(modules, 'electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  write(path.dirname(electron), path.basename(electron), 'ordinary engineering executable fixture')
  return { app, kit, options: { modules, electron, playwright } }
}

test('explicit engineering dependencies support a matching checkout link and cannot claim pinned qualification', async t => {
  const { app, options } = engineeringFixture(t)
  fs.symlinkSync(options.modules, path.join(app, 'node_modules'), 'junction')
  const result = await resolveNativeDriverDependencies(app, options)
  assert.equal(result.playwright.marker, 'loaded without native launch')
  assert.equal(result.executablePath, options.electron)
  assert.equal(result.modulesDirectory, options.modules)
  assert.equal(result.receipt.scope, 'engineering-kit')
  assert.equal(result.receipt.qualificationEligible, false)
  assert.equal(Object.hasOwn(result.receipt, 'archiveSha256'), false)
  assert.equal(fs.existsSync(path.join(options.modules, '.native-test-assets')), false)
  const legacy = await resolveNativeDriverDependencies(app, { playwright: options.playwright })
  assert.deepEqual(legacy.receipt, result.receipt, 'the original explicit Playwright plus checkout-link invocation stays engineering-only')
  const forged = await resolveNativeDriverDependencies(app, { ...options, qualificationEligible: true })
  assert.equal(forged.receipt.qualificationEligible, false)
  await assert.rejects(verifyNativeTestDependencies(app), /linked dependency path/)
  for (const overrides of [options, { executable: options.electron }, { playwright: options.playwright }, { qualificationEligible: true }]) {
    await assert.rejects(verifyNativeTestDependencies(app, overrides), /does not accept engineering-kit overrides/)
  }
})

test('an ordinary local installation cannot fall back to an explicit engineering kit when unprepared', async t => {
  const { copy: local } = nativeFixture(t), { options } = engineeringFixture(t)
  await assert.rejects(resolveNativeDriverDependencies(local, options), /ENOENT/)
  assert.equal(fs.existsSync(path.join(local, 'node_modules/.native-test-assets')), false)
  const malformed = scratch(t)
  write(malformed, 'package.json', read('package.json')); write(malformed, 'package-lock.json', read('package-lock.json'))
  write(malformed, 'node_modules', 'not a directory')
  await assert.rejects(resolveNativeDriverDependencies(malformed, options), /local dependency directory is not ordinary/)
})

test('engineering selection requires the complete tuple, matching module link and locked package versions', async t => {
  const { app, options } = engineeringFixture(t)
  for (const field of Object.keys(options)) {
    const partial = { ...options }; delete partial[field]
    await assert.rejects(resolveNativeDriverDependencies(app, partial), /requires explicit modules, Electron and Playwright/)
  }
  const wrong = scratch(t)
  fs.symlinkSync(wrong, path.join(app, 'node_modules'), 'junction')
  await assert.rejects(resolveNativeDriverDependencies(app, options), /must match the checkout dependency link/)
  if (process.platform === 'win32') fs.rmdirSync(path.join(app, 'node_modules'))
  else fs.unlinkSync(path.join(app, 'node_modules'))
  write(app, 'other-electron', 'ordinary but not the selected kit')
  await assert.rejects(resolveNativeDriverDependencies(app, { ...options, electron: path.join(app, 'other-electron') }), /must belong to the selected modules/)
  write(path.join(options.modules, 'electron'), 'package.json', { version: '43.2.0' })
  await assert.rejects(resolveNativeDriverDependencies(app, options), /engineering Electron differs/)
  write(path.join(options.modules, 'electron'), 'package.json', { version: '43.3.0' })
  write(options.playwright, 'package.json', { name: 'playwright', version: '1.62.0' })
  await assert.rejects(resolveNativeDriverDependencies(app, options), /Playwright differs from its locked version/)
})
