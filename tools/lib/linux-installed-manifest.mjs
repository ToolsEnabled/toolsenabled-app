import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { assertCapabilitySourceGitBinding } from './capability-source-git.mjs'

const require = createRequire(import.meta.url)
const { Parser } = require('tar')
export const INSTALL_ROOT = '/opt/ToolsEnabled'
const SHA = /^[a-f0-9]{64}$/
const REF = /^[a-f0-9]{40}$/
const MAX_ARCHIVE = 1024 * 1024 * 1024
const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (ok, code) => { if (!ok) fail(code) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const keys = (value, wanted) => check(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...wanted].sort().join(','), 'INSTALL_MANIFEST_SCHEMA')

export function relativeName(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\\0\r\n]/.test(value)
    && !value.startsWith('/') && (value === '.' || value.split('/').every(part => part && part !== '.' && part !== '..')), 'INSTALL_ARCHIVE_PATH')
  return value
}
function archiveName(value) {
  if (value.startsWith('./')) value = value.slice(2)
  if (value.endsWith('/')) value = value.slice(0, -1)
  return relativeName(value || '.')
}
function pinned(file, maxBytes) {
  check(path.isAbsolute(file) && fs.realpathSync(file) === file, 'INSTALL_EVIDENCE_PATH')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd, { bigint: true })
    check(stat.isFile() && stat.nlink === 1n && [0n, BigInt(process.getuid())].includes(stat.uid)
      && !(Number(stat.mode) & 0o022) && stat.size > 0n && stat.size <= BigInt(maxBytes), 'INSTALL_EVIDENCE_UNSAFE')
    const stable = () => check(same(stat, fs.fstatSync(fd, { bigint: true }))
      && same(stat, fs.lstatSync(file, { bigint: true })), 'INSTALL_EVIDENCE_CHANGED')
    return { fd, stat, stable, close: () => fs.closeSync(fd) }
  } catch (error) { fs.closeSync(fd); throw error }
}
async function hashFd(fd) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream('', { fd, autoClose: false, start: 0 })) hash.update(chunk)
  return hash.digest('hex')
}

export async function finishArchiveChild(child, terminal, isClosed, cleanupMs = 2000) {
  const wait = async () => {
    let timer
    try { await Promise.race([terminal, new Promise(resolve => { timer = setTimeout(resolve, cleanupMs) })]) }
    finally { clearTimeout(timer) }
  }
  if (!isClosed()) {
    child.kill('SIGTERM')
    await wait()
  }
  if (!isClosed()) {
    child.kill('SIGKILL')
    await wait()
  }
  if (!isClosed()) {
    child.unref(); child.stdout?.destroy()
    throw Object.assign(new Error('INSTALL_ARCHIVE_CLEANUP_UNKNOWN'), { code: 'INSTALL_ARCHIVE_CLEANUP_UNKNOWN', ownedPid: child.pid })
  }
}

// Parse binary tar streams without extracting anything or interpreting human
// listings. dpkg-deb reads only the retained package descriptor inherited as3.
async function inspectArchive(fd, option, captureNames = new Set()) {
  const entries = [], captured = new Map(), names = new Set()
  let total = 0, failure
  const child = spawn('/usr/bin/dpkg-deb', [option, '/proc/self/fd/3'], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'pipe', 'ignore', fd],
  })
  let closed = false
  const terminal = new Promise(resolve => child.once('close', () => { closed = true; resolve() }))
  const parser = new Parser({ strict: true, onReadEntry(entry) {
    try {
      const name = archiveName(entry.path)
      check(!names.has(name) && names.size < 10000, 'INSTALL_ARCHIVE_DUPLICATE_OR_LIMIT')
      names.add(name)
      check(['File', 'Directory'].includes(entry.type), 'INSTALL_ARCHIVE_NONREGULAR')
      check(entry.uid === 0 && entry.gid === 0 && Number.isSafeInteger(entry.mode)
        && !(entry.mode & 0o6022), 'INSTALL_ARCHIVE_OWNERSHIP')
      check(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 512 * 1024 * 1024, 'INSTALL_ARCHIVE_LIMIT')
      const item = { path: name, kind: entry.type === 'File' ? 'file' : 'directory', uid: 0, gid: 0, mode: entry.mode & 0o7777 }
      const hash = createHash('sha256'), chunks = []; let size = 0
      const capture = captureNames.has(name)
      if (capture) check(entry.size <= 32 * 1024 * 1024, 'INSTALL_METADATA_LIMIT')
      entry.on('data', chunk => { size += chunk.length; hash.update(chunk); if (capture) chunks.push(chunk) })
      entry.on('end', () => {
        if (size !== entry.size) { failure ||= Object.assign(new Error('INSTALL_ARCHIVE_SIZE'), { code: 'INSTALL_ARCHIVE_SIZE' }); return }
        if (item.kind === 'file') Object.assign(item, { bytes: size, sha256: hash.digest('hex') })
        entries.push(item)
        if (capture) captured.set(name, Buffer.concat(chunks))
      })
      entry.resume()
    } catch (error) { failure ||= error; parser.abort(error); child.kill('SIGTERM') }
  } })
  const timer = setTimeout(() => { failure ||= Object.assign(new Error('INSTALL_ARCHIVE_TIMEOUT'), { code: 'INSTALL_ARCHIVE_TIMEOUT' }); child.kill('SIGTERM') }, 120000)
  const hardTimer = setTimeout(() => child.kill('SIGKILL'), 122000)
  try {
    const completed = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => code === 0 && !signal ? resolve() : reject(failure || Object.assign(new Error('INSTALL_DPKG_ARCHIVE_FAILED'), { code: 'INSTALL_DPKG_ARCHIVE_FAILED' })))
    })
    const parsed = new Promise((resolve, reject) => { parser.once('end', resolve); parser.once('error', reject) })
    child.stdout.on('data', chunk => { total += chunk.length; if (total > MAX_ARCHIVE) { failure ||= Object.assign(new Error('INSTALL_ARCHIVE_LIMIT'), { code: 'INSTALL_ARCHIVE_LIMIT' }); child.kill('SIGTERM'); parser.abort(failure) } })
    child.stdout.pipe(parser)
    await Promise.all([completed, parsed])
    if (failure) throw failure
    return { entries: entries.sort((a, b) => a.path.localeCompare(b.path)), captured }
  } finally { clearTimeout(timer); clearTimeout(hardTimer); await finishArchiveChild(child, terminal, () => closed) }
}
function asarJson(buffer, name) {
  check(buffer && buffer.length >= 16, 'INSTALL_ASAR_METADATA')
  const headerBytes = buffer.readUInt32LE(4), jsonBytes = buffer.readUInt32LE(12)
  check(jsonBytes > 0 && jsonBytes < headerBytes && 8 + headerBytes <= buffer.length, 'INSTALL_ASAR_METADATA')
  let node = JSON.parse(buffer.subarray(16, 16 + jsonBytes).toString('utf8'))
  for (const part of name.split('/')) node = node?.files?.[part]
  check(node && !node.unpacked && !node.link && Number.isSafeInteger(node.size) && node.size <= 1024 * 1024
    && /^\d+$/.test(node.offset), 'INSTALL_ASAR_METADATA')
  const start = 8 + headerBytes + Number(node.offset)
  check(Number.isSafeInteger(start) && start >= 8 + headerBytes && start + node.size <= buffer.length, 'INSTALL_ASAR_METADATA')
  return JSON.parse(buffer.subarray(start, start + node.size).toString('utf8'))
}
function parseControl(text) {
  const result = {}
  for (const line of text.split('\n')) {
    if (!line || /^[ \t]/.test(line)) continue
    const match = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line)
    check(match && !Object.hasOwn(result, match[1]), 'INSTALL_CONTROL_FORMAT')
    result[match[1]] = match[2]
  }
  return result
}
function allowedData(item) {
  if (item.path === '.' || item.path === 'opt' || item.path === 'opt/ToolsEnabled' || item.path.startsWith('opt/ToolsEnabled/')) return true
  if (item.kind === 'directory') return ['usr', 'usr/share', 'usr/share/applications', 'usr/share/icons', 'usr/share/icons/hicolor', 'usr/share/doc', 'usr/share/doc/toolsenabled'].includes(item.path)
    || /^usr\/share\/icons\/hicolor\/(?:\d+x\d+|scalable)(?:\/apps)?$/.test(item.path)
  return item.path === 'usr/share/applications/toolsenabled.desktop'
    || (item.path === 'usr/share/doc/toolsenabled/changelog.gz' && item.bytes <= 65536)
    || /^usr\/share\/icons\/hicolor\/(?:\d+x\d+|scalable)\/apps\/toolsenabled\.(?:png|svg)$/.test(item.path)
}

export async function produceManifest({ deb, packageSha256, appSource, engineSource, appRef, engineRef }) {
  check(SHA.test(packageSha256), 'INSTALL_PACKAGE_DIGEST_REQUIRED')
  const env = { PATH: '/usr/bin:/bin', LANG: 'C' }
  const bind = () => { assertCapabilitySourceGitBinding({ source: appSource, expectedRef: appRef, environment: env }); assertCapabilitySourceGitBinding({ source: engineSource, expectedRef: engineRef, environment: env }) }
  bind()
  const pin = pinned(deb, MAX_ARCHIVE)
  try {
    check(await hashFd(pin.fd) === packageSha256, 'INSTALL_PACKAGE_DIGEST_MISMATCH')
    const data = await inspectArchive(pin.fd, '--fsys-tarfile', new Set(['opt/ToolsEnabled/resources/app.asar', 'opt/ToolsEnabled/resources/capability/PAYLOAD.json', 'opt/ToolsEnabled/resources/apparmor-profile']))
    const control = await inspectArchive(pin.fd, '--ctrl-tarfile', new Set(['control']))
    check(data.entries.every(allowedData), 'INSTALL_UNREVIEWED_PACKAGE_PATH')
    check(control.entries.every(item => ['.', 'control', 'md5sums', 'postinst', 'postrm'].includes(item.path)), 'INSTALL_UNREVIEWED_CONTROL')
    check(control.entries.some(item => item.path === 'postinst') && control.entries.some(item => item.path === 'postrm'), 'INSTALL_MAINTAINER_HOOKS_REQUIRED')
    const metadata = parseControl(control.captured.get('control')?.toString('utf8') || '')
    check(metadata.Package === 'toolsenabled' && metadata.Architecture === 'amd64' && typeof metadata.Version === 'string', 'INSTALL_PACKAGE_IDENTITY')
    const asar = data.captured.get('opt/ToolsEnabled/resources/app.asar')
    const build = asarJson(asar, 'dist/build-info.json'), pkg = asarJson(asar, 'package.json')
    const payload = JSON.parse(data.captured.get('opt/ToolsEnabled/resources/capability/PAYLOAD.json')?.toString('utf8') || 'null')
    check(build?.schemaVersion === 2 && build.ref === appRef && build.app?.ref === appRef && build.app?.dirty === false
      && build.dirty === false && build.overridden === false && Array.isArray(build.dirtyFiles) && build.dirtyFiles.length === 0
      && build.payload?.resolved === true && build.payload?.dirty === false && build.payload?.ref === engineRef
      && payload?.sourceRef === engineRef && pkg.version === metadata.Version, 'INSTALL_SOURCE_METADATA_MISMATCH')
    const profile = data.captured.get('opt/ToolsEnabled/resources/apparmor-profile')
    check(profile && profile.equals(fs.readFileSync(path.join(appSource, 'build/linux/toolsenabled-customer.apparmor'))), 'INSTALL_PROFILE_MISMATCH')
    const entries = data.entries.filter(item => item.path === 'opt/ToolsEnabled' || item.path.startsWith('opt/ToolsEnabled/'))
      .map(item => ({ ...item, path: item.path === 'opt/ToolsEnabled' ? '.' : item.path.slice('opt/ToolsEnabled/'.length) }))
    const manifest = { schemaVersion: 1, kind: 'toolsenabled-deb-install-manifest', package: { sha256: packageSha256, bytes: Number(pin.stat.size), name: metadata.Package, version: metadata.Version, architecture: metadata.Architecture },
      source: { appRef, engineRef, dirty: false, overridden: false }, installRoot: INSTALL_ROOT, entries,
      controlFiles: control.entries.filter(item => item.kind === 'file'),
      managedProfile: { path: '/etc/apparmor.d/toolsenabled-customer', name: 'toolsenabled-customer', uid: 0, gid: 0, mode: 0o644, sha256: digest(profile) } }
    validateManifest(manifest, { packageSha256, appRef, engineRef })
    bind(); pin.stable(); check(await hashFd(pin.fd) === packageSha256, 'INSTALL_PACKAGE_CHANGED'); pin.stable()
    return manifest
  } finally { pin.close() }
}

export function validateManifest(value, expected) {
  keys(value, ['schemaVersion', 'kind', 'package', 'source', 'installRoot', 'entries', 'controlFiles', 'managedProfile'])
  check(value.schemaVersion === 1 && value.kind === 'toolsenabled-deb-install-manifest' && value.installRoot === INSTALL_ROOT, 'INSTALL_MANIFEST_IDENTITY')
  keys(value.package, ['sha256', 'bytes', 'name', 'version', 'architecture'])
  check(SHA.test(value.package.sha256) && value.package.sha256 === expected.packageSha256 && value.package.name === 'toolsenabled'
    && value.package.architecture === 'amd64' && typeof value.package.version === 'string' && /^[0-9][A-Za-z0-9.+:~_-]{0,100}$/.test(value.package.version)
    && Number.isSafeInteger(value.package.bytes) && value.package.bytes > 0 && value.package.bytes <= MAX_ARCHIVE, 'INSTALL_PACKAGE_IDENTITY')
  keys(value.source, ['appRef', 'engineRef', 'dirty', 'overridden'])
  check(REF.test(value.source.appRef) && REF.test(value.source.engineRef) && value.source.appRef === expected.appRef
    && value.source.engineRef === expected.engineRef && value.source.dirty === false && value.source.overridden === false, 'INSTALL_SOURCE_METADATA_MISMATCH')
  for (const collection of [value.entries, value.controlFiles]) {
    check(Array.isArray(collection) && collection.length > 0 && collection.length <= 10000, 'INSTALL_MANIFEST_ENTRIES')
    const seen = new Set()
    for (const item of collection) {
      keys(item, item.kind === 'file' ? ['path', 'kind', 'uid', 'gid', 'mode', 'bytes', 'sha256'] : ['path', 'kind', 'uid', 'gid', 'mode'])
      relativeName(item.path); check(!seen.has(item.path), 'INSTALL_MANIFEST_DUPLICATE'); seen.add(item.path)
      check(['file', 'directory'].includes(item.kind) && item.uid === 0 && item.gid === 0 && Number.isInteger(item.mode)
        && item.mode >= 0 && item.mode <= 0o7777 && !(item.mode & 0o6022), 'INSTALL_MANIFEST_MODE')
      if (item.kind === 'file') check(SHA.test(item.sha256) && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= 512 * 1024 * 1024, 'INSTALL_MANIFEST_FILE')
    }
  }
  const table = new Map(value.entries.map(item => [item.path, item]))
  check(table.get('.')?.kind === 'directory', 'INSTALL_MANIFEST_ROOT')
  for (const item of value.entries) {
    if (item.path !== '.') check(table.get(path.posix.dirname(item.path))?.kind === 'directory', 'INSTALL_MANIFEST_PARENT')
  }
  for (const name of ['toolsenabled', 'resources/app.asar', 'resources/capability/PAYLOAD.json', 'resources/apparmor-profile']) check(table.get(name)?.kind === 'file', 'INSTALL_MANIFEST_MARKER')
  check(value.controlFiles.every(item => item.kind === 'file' && ['control', 'md5sums', 'postinst', 'postrm'].includes(item.path))
    && ['control', 'postinst', 'postrm'].every(name => value.controlFiles.some(item => item.path === name)), 'INSTALL_UNREVIEWED_CONTROL')
  keys(value.managedProfile, ['path', 'name', 'uid', 'gid', 'mode', 'sha256'])
  check(value.managedProfile.path === '/etc/apparmor.d/toolsenabled-customer' && value.managedProfile.name === 'toolsenabled-customer'
    && value.managedProfile.uid === 0 && value.managedProfile.gid === 0 && value.managedProfile.mode === 0o644
    && value.managedProfile.sha256 === table.get('resources/apparmor-profile').sha256, 'INSTALL_PROFILE_MISMATCH')
  return value
}

export async function verifyExternalManifest({ manifestFile, manifestSha256, deb, ...expected }) {
  check(SHA.test(manifestSha256), 'INSTALL_MANIFEST_DIGEST_REQUIRED')
  const pin = pinned(manifestFile, 8 * 1024 * 1024)
  try {
    const packagePin = pinned(deb, MAX_ARCHIVE)
    try {
      const bytes = fs.readFileSync(pin.fd)
      check(digest(bytes) === manifestSha256, 'INSTALL_MANIFEST_DIGEST_MISMATCH')
      const value = validateManifest(JSON.parse(bytes.toString('utf8')), expected)
      check(Number(packagePin.stat.size) === value.package.bytes && await hashFd(packagePin.fd) === value.package.sha256, 'INSTALL_PACKAGE_DIGEST_MISMATCH')
      pin.stable(); packagePin.stable()
      return value
    } finally { packagePin.close() }
  } finally { pin.close() }
}

export function assertReadDenial(operation) {
  try { const fd = operation(); if (Number.isInteger(fd)) fs.closeSync(fd) }
  catch (error) { if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) return; throw error }
  fail('INSTALL_WRITE_ACCESS_GRANTED')
}
export function assertAcl(text) {
  check(typeof text === 'string' && text.length <= 65536, 'INSTALL_ACL_UNKNOWN')
  const lines = text.split('\n').filter(Boolean)
  check(lines.length >= 3, 'INSTALL_ACL_UNKNOWN')
  const seen = new Set()
  for (const line of lines) {
    const match = /^(default:)?(user|group|mask|other):([0-9]*):([r-][w-][x-])(?:\t+#effective:([r-][w-][x-]))?$/.exec(line)
    check(match, 'INSTALL_ACL_UNKNOWN')
    const [, defaults, kind, id, perms, effective] = match
    const key = (defaults || '') + kind + ':' + id
    check(!seen.has(key), 'INSTALL_ACL_UNKNOWN'); seen.add(key)
    // Only the root owner/named root may receive write. A writable mask is
    // conservatively refused even when current named entries appear read-only.
    if ((effective || perms).includes('w')) check(!defaults && kind === 'user' && (id === '' || id === '0'), 'INSTALL_ACL_WRITABLE')
  }
  check(['user:', 'group:', 'other:'].every(key => seen.has(key)), 'INSTALL_ACL_UNKNOWN')
}

// Deliberately no caller-selected root/test-root option. Fixture tests exercise
// pure validators; only actual /opt is eligible for installed proof.
export async function verifyInstalledTree(manifest) {
  validateManifest(manifest, { packageSha256: manifest?.package?.sha256, appRef: manifest?.source?.appRef, engineRef: manifest?.source?.engineRef })
  check(process.platform === 'linux' && process.getuid() !== 0 && process.geteuid() !== 0, 'INSTALL_ORDINARY_USER_REQUIRED')
  check(/^CapEff:\s+0+$/m.test(fs.readFileSync('/proc/self/status', 'utf8')), 'INSTALL_PRIVILEGED_VERIFIER')
  const table = new Map(manifest.entries.map(item => [item.path, item])), observed = new Set()
  const rootDevice = fs.lstatSync(INSTALL_ROOT).dev
  function checkPath(file, item) {
    const stat = fs.lstatSync(file)
    check(!stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0 && !(stat.mode & 0o6022)
      && (stat.isDirectory() || stat.isFile()) && (!stat.isFile() || stat.nlink === 1), 'INSTALL_PATH_UNSAFE')
    if (item) check((item.kind === 'file' ? stat.isFile() : stat.isDirectory()) && (stat.mode & 0o7777) === item.mode, 'INSTALL_MODE_MISMATCH')
    const acl = spawnSync('/usr/bin/getfacl', ['--absolute-names', '--numeric', '--omit-header', '--', file], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
    check(!acl.error && acl.status === 0, 'INSTALL_ACL_UNKNOWN'); assertAcl(acl.stdout)
    assertReadDenial(() => fs.accessSync(file, fs.constants.W_OK))
    if (stat.isFile()) assertReadDenial(() => fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW))
    return stat
  }
  const parents = new Map(['/', '/opt'].map(parent => [parent, checkPath(parent)]))
  check(fs.realpathSync(INSTALL_ROOT) === INSTALL_ROOT, 'INSTALL_ROOT_CHANGED')
  const rootFd = fs.openSync(INSTALL_ROOT, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const rootIdentity = fs.fstatSync(rootFd)
  const checkRoot = (descriptor = true) => {
    const named = fs.lstatSync(INSTALL_ROOT)
    check((!descriptor || fs.readlinkSync(`/proc/self/fd/${rootFd}`) === INSTALL_ROOT) && rootIdentity.dev === named.dev
      && rootIdentity.ino === named.ino && rootIdentity.ctimeMs === named.ctimeMs && rootIdentity.mode === named.mode, 'INSTALL_ROOT_CHANGED')
    for (const [parent, before] of parents) {
      const now = fs.lstatSync(parent)
      check(before.dev === now.dev && before.ino === now.ino && before.mode === now.mode && before.uid === now.uid
        && before.gid === now.gid && before.ctimeMs === now.ctimeMs, 'INSTALL_PARENT_CHANGED')
    }
  }
  async function walk(relative, file) {
    checkRoot()
    const item = table.get(relative); check(item, 'INSTALL_EXTRA_ENTRY'); observed.add(relative)
    const before = checkPath(file, item)
    check(before.dev === rootDevice, 'INSTALL_MOUNT_CROSSING')
    if (item.kind === 'directory') {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
      try {
        const held = fs.fstatSync(fd)
        check(before.dev === held.dev && before.ino === held.ino, 'INSTALL_PATH_CHANGED')
        for (const name of fs.readdirSync(`/proc/self/fd/${fd}`)) await walk(relative === '.' ? name : relative + '/' + name, `/proc/${process.pid}/fd/${fd}/${name}`)
      } finally { fs.closeSync(fd) }
    } else {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        const held = fs.fstatSync(fd)
        check(before.dev === held.dev && before.ino === held.ino, 'INSTALL_PATH_CHANGED')
        check(before.size === item.bytes && await hashFd(fd) === item.sha256, 'INSTALL_BYTES_MISMATCH')
      }
      finally { fs.closeSync(fd) }
    }
    const after = fs.lstatSync(file)
    check(before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'INSTALL_PATH_CHANGED')
    checkRoot()
  }
  try { await walk('.', `/proc/${process.pid}/fd/${rootFd}/.`) } finally { fs.closeSync(rootFd) }
  check(observed.size === table.size, 'INSTALL_MISSING_ENTRY')
  for (const parent of ['/etc', '/etc/apparmor.d']) parents.set(parent, checkPath(parent))
  const profile = manifest.managedProfile
  const beforeProfile = checkPath(profile.path, { kind: 'file', mode: profile.mode })
  const profilePin = pinned(profile.path, 1024 * 1024)
  try {
    check(BigInt(beforeProfile.dev) === profilePin.stat.dev && BigInt(beforeProfile.ino) === profilePin.stat.ino, 'INSTALL_PROFILE_CHANGED')
    check(await hashFd(profilePin.fd) === profile.sha256, 'INSTALL_PROFILE_MISMATCH')
    profilePin.stable()
  } finally { profilePin.close() }
  checkRoot(false)
  return { installedTreeMatches: true, readonlyObserved: true, entries: observed.size, profileMatches: true }
}
