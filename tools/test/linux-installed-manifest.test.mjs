import test from 'node:test'
import vm from 'node:vm'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { produceManifest, verifyExternalManifest, validateManifest, relativeName, assertReadDenial, assertAcl, finishArchiveChild } from '../lib/linux-installed-manifest.mjs'

const require = createRequire(import.meta.url)
const { createPackage } = require('@electron/asar')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const command = (exe, args, cwd) => {
  const result = spawnSync(exe, args, { cwd, encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return result.stdout.trim()
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-manifest-test-'))
  fs.chmodSync(root, 0o700)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const put = (name, bytes, mode = 0o644) => {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
    fs.writeFileSync(file, bytes, { mode }); fs.chmodSync(file, mode)
    return file
  }
  const profile = fs.readFileSync(path.join(ROOT, 'build/linux/toolsenabled-customer.apparmor'))
  put('app/build/linux/toolsenabled-customer.apparmor', profile)
  put('engine/tools/mission-bridge.js', '// fixture\n')
  const refs = {}
  for (const kind of ['app', 'engine']) {
    const dir = path.join(root, kind)
    command('/usr/bin/git', ['init', '--quiet'], dir)
    command('/usr/bin/git', ['add', '.'], dir)
    command('/usr/bin/git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture'], dir)
    refs[kind + 'Ref'] = command('/usr/bin/git', ['rev-parse', 'HEAD'], dir)
  }
  const build = { schemaVersion: 2, ref: refs.appRef, dirty: false, overridden: false, dirtyFiles: [], app: { ref: refs.appRef, dirty: false }, payload: { ref: refs.engineRef, dirty: false, resolved: true } }
  put('asar/dist/build-info.json', JSON.stringify(build))
  put('asar/package.json', JSON.stringify({ name: 'toolsenabled', version: '1.0.42' }))
  put('package/opt/ToolsEnabled/toolsenabled', Buffer.from([127, 69, 76, 70]), 0o755)
  put('package/opt/ToolsEnabled/resources/capability/PAYLOAD.json', JSON.stringify({ sourceRef: refs.engineRef }))
  put('package/opt/ToolsEnabled/resources/apparmor-profile', profile)
  await createPackage(path.join(root, 'asar'), path.join(root, 'package/opt/ToolsEnabled/resources/app.asar'))
  fs.chmodSync(path.join(root, 'package/opt/ToolsEnabled/resources/app.asar'), 0o644)
  put('package/DEBIAN/control', 'Package: toolsenabled\nVersion: 1.0.42\nArchitecture: amd64\nMaintainer: Fixture <fixture@example.invalid>\nDescription: test fixture only\n')
  put('package/DEBIAN/postinst', '#!/bin/sh\nexit 0\n', 0o755)
  put('package/DEBIAN/postrm', '#!/bin/sh\nexit 0\n', 0o755)
  // dpkg requires a traversable control directory even when the test runner
  // deliberately uses a private umask. The enclosing fixture stays 0700.
  fs.chmodSync(path.join(root, 'package/DEBIAN'), 0o755)
  let sequence = 0
  const pack = () => {
    const deb = path.join(root, 'fixture-' + sequence++ + '.deb')
    command('/usr/bin/dpkg-deb', ['--root-owner-group', '--build', path.join(root, 'package'), deb], root)
    fs.chmodSync(deb, 0o644)
    return { deb, packageSha256: hash(fs.readFileSync(deb)), appSource: path.join(root, 'app'), engineSource: path.join(root, 'engine'), ...refs }
  }
  return { root, put, pack }
}
const linux = { skip: process.platform !== 'linux' }
test('real binary deb archives produce exact ref-bound manifest and externally pinned binding', linux, async t => {
  const f = await fixture(t), options = f.pack()
  const value = await produceManifest(options)
  assert.equal(value.package.sha256, options.packageSha256)
  assert.equal(value.source.appRef, options.appRef)
  assert.equal(value.entries.find(item => item.path === 'toolsenabled').mode, 0o755)
  assert.equal(value.controlFiles.length, 3)
  const bytes = Buffer.from(JSON.stringify(value)), manifestFile = f.put('manifest.json', bytes, 0o444)
  const binding = { ...options, manifestFile, manifestSha256: hash(bytes) }
  assert.deepEqual(await verifyExternalManifest(binding), value)
  await assert.rejects(verifyExternalManifest({ ...binding, manifestSha256: '0'.repeat(64) }), /DIGEST_MISMATCH/)
  await assert.rejects(verifyExternalManifest({ ...binding, engineRef: 'a'.repeat(40) }), /METADATA_MISMATCH/)
  await assert.rejects(verifyExternalManifest({ ...binding, packageSha256: '0'.repeat(64) }), /PACKAGE_IDENTITY/)
  fs.chmodSync(manifestFile, 0o644); fs.writeFileSync(manifestFile, '{}')
  await assert.rejects(verifyExternalManifest(binding), /DIGEST_MISMATCH/)
})
test('producer refuses wrong digest, source ref/dirty state and unreviewed control or data paths', linux, async t => {
  const f = await fixture(t), options = f.pack()
  await assert.rejects(produceManifest({ ...options, packageSha256: '0'.repeat(64) }), /DIGEST_MISMATCH/)
  await assert.rejects(produceManifest({ ...options, engineRef: '0'.repeat(40) }), /differs from declared ref/)
  f.put('engine/untracked', 'x')
  await assert.rejects(produceManifest(options), /dirty or has untracked/)
  fs.unlinkSync(path.join(f.root, 'engine/untracked'))
  f.put('package/DEBIAN/preinst', '#!/bin/sh\nexit 0\n', 0o755)
  await assert.rejects(produceManifest(f.pack()), /UNREVIEWED_CONTROL/)
  fs.unlinkSync(path.join(f.root, 'package/DEBIAN/preinst'))
  f.put('package/etc/unrelated', 'x')
  await assert.rejects(produceManifest(f.pack()), /UNREVIEWED_PACKAGE_PATH/)
})
test('producer refuses symlink and writable archive entries before any extraction', linux, async t => {
  const f = await fixture(t)
  fs.symlinkSync('/etc/passwd', path.join(f.root, 'package/opt/ToolsEnabled/escape'))
  await assert.rejects(produceManifest(f.pack()), /NONREGULAR|DPKG_ARCHIVE_FAILED/)
  fs.unlinkSync(path.join(f.root, 'package/opt/ToolsEnabled/escape'))
  fs.chmodSync(path.join(f.root, 'package/opt/ToolsEnabled/resources/app.asar'), 0o666)
  await assert.rejects(produceManifest(f.pack()), /OWNERSHIP|DPKG_ARCHIVE_FAILED/)
})
test('FPM changelog is a bounded exact documentation path, not arbitrary documentation admission', linux, async t => {
  const f = await fixture(t)
  f.put('package/usr/share/doc/toolsenabled/changelog.gz', Buffer.from([31, 139, 8]))
  await produceManifest(f.pack())
  f.put('package/usr/share/doc/toolsenabled/unreviewed', 'unreviewed')
  await assert.rejects(produceManifest(f.pack()), /UNREVIEWED_PACKAGE_PATH/)
  fs.unlinkSync(path.join(f.root, 'package/usr/share/doc/toolsenabled/unreviewed'))
  f.put('package/usr/share/doc/toolsenabled/changelog.gz', Buffer.alloc(65537))
  await assert.rejects(produceManifest(f.pack()), /UNREVIEWED_PACKAGE_PATH/)
})
test('strict schema refuses unknown fields, duplicates, path escapes, wrong owners/modes and marker omissions', linux, async t => {
  const f = await fixture(t), options = f.pack(), value = await produceManifest(options)
  const mutate = action => { const copy = structuredClone(value); action(copy); assert.throws(() => validateManifest(copy, options)) }
  mutate(v => { v.unreviewed = true })
  mutate(v => { v.installRoot = '/tmp/other' })
  mutate(v => { v.entries.push(v.entries[0]) })
  mutate(v => { v.entries[0].path = '../escape' })
  mutate(v => { v.entries[0].uid = 1000 })
  mutate(v => { v.entries[0].mode = 0o777 })
  mutate(v => { v.entries = v.entries.filter(e => e.path !== 'resources') })
  mutate(v => { v.managedProfile.path = '/etc/other' })
  mutate(v => { v.source.overridden = true })
})
test('path, ACL and non-mutating denial semantics fail closed rather than accepting incidental errors', () => {
  for (const name of ['/abs', '../escape', 'a/../b', 'a//b', 'a\\b', 'a\0b', 'a/']) assert.throws(() => relativeName(name))
  assert.equal(relativeName('resources/app.asar'), 'resources/app.asar')
  assertAcl('user::rw-\ngroup::r--\nother::r--\n')
  assertAcl('user::rwx\nuser:123:r-x\ngroup::r-x\nmask::r-x\nother::r-x\n')
  for (const acl of ['', 'user::rw-\ngroup::rw-\nother::r--\n', 'user::rw-\nuser:123:rw-\ngroup::r--\nmask::rw-\nother::r--\n', 'user::rw-\ngroup::r--\nother::r--\ndefault:user::rwx\n']) assert.throws(() => assertAcl(acl))
  for (const code of ['EACCES', 'EPERM', 'EROFS']) assertReadDenial(() => { throw Object.assign(new Error(code), { code }) })
  for (const code of ['ENOENT', 'ETXTBSY', 'EIO']) assert.throws(() => assertReadDenial(() => { throw Object.assign(new Error(code), { code }) }))
  assert.throws(() => assertReadDenial(() => undefined), /WRITE_ACCESS_GRANTED/)
})
test('archive parser refusal cleanup observes terminal close and reports unknown owned child honestly', async () => {
  let closed = false, resolve
  const terminal = new Promise(done => { resolve = done }), signals = []
  const child = { pid: 123, kill: signal => { signals.push(signal); if (signal === 'SIGKILL') { closed = true; resolve() } }, unref() {}, stdout: { destroy() {} } }
  await finishArchiveChild(child, terminal, () => closed, 2)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  let unref = false
  await assert.rejects(finishArchiveChild({ pid: 456, kill() {}, unref() { unref = true }, stdout: { destroy() {} } }, new Promise(() => {}), () => false, 2), error => error.code === 'INSTALL_ARCHIVE_CLEANUP_UNKNOWN' && error.ownedPid === 456)
  assert.equal(unref, true)
})


// Run the actual external-binding caller, pinning and descriptor hashing code
// against memory files. No package tooling, fixture directory or install occurs.
function externalBindingFiles({ missingPackage = false, unsafePackage = false } = {}) {
  const deb = path.resolve('manifest-binding-values/package.deb')
  const manifestFile = path.resolve('manifest-binding-values/manifest.json')
  const packageBytes = Buffer.from('retained package bytes')
  const packageSha256 = hash(packageBytes), appRef = 'a'.repeat(40), engineRef = 'b'.repeat(40)
  const item = (name, kind = 'file') => ({ path: name, kind, uid: 0, gid: 0,
    mode: kind === 'directory' ? 0o755 : 0o644,
    ...(kind === 'file' ? { bytes: 1, sha256: 'c'.repeat(64) } : {}) })
  const manifest = { schemaVersion: 1, kind: 'toolsenabled-deb-install-manifest',
    package: { sha256: packageSha256, bytes: packageBytes.length, name: 'toolsenabled', version: '1.0.45', architecture: 'amd64' },
    source: { appRef, engineRef, dirty: false, overridden: false }, installRoot: '/opt/ToolsEnabled',
    entries: [item('.', 'directory'), item('resources', 'directory'), item('resources/capability', 'directory'),
      item('toolsenabled'), item('resources/app.asar'), item('resources/capability/PAYLOAD.json'), item('resources/apparmor-profile')],
    controlFiles: ['control', 'postinst', 'postrm'].map(name => item(name)),
    managedProfile: { path: '/etc/apparmor.d/toolsenabled-customer', name: 'toolsenabled-customer',
      uid: 0, gid: 0, mode: 0o644, sha256: 'c'.repeat(64) } }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const contents = new Map([[manifestFile, manifestBytes], [deb, packageBytes]])
  const opened = [], closed = [], handles = new Map()
  const stats = new Map([...contents].map(([file, bytes], index) => [file, {
    isFile: () => true, nlink: 1n, uid: 1000n, mode: unsafePackage && file === deb ? 0o100666n : 0o100644n,
    size: BigInt(bytes.length), dev: 1n, ino: BigInt(index + 1), mtimeNs: 1n, ctimeNs: 1n }]))
  const memory = {
    constants: fs.constants,
    realpathSync(file) {
      if (!contents.has(file) || missingPackage && file === deb) throw Object.assign(Error('package missing'), { code: 'ENOENT' })
      return file
    },
    openSync(file) { const fd = opened.length + 10; opened.push(file); handles.set(fd, file); return fd },
    closeSync(fd) { assert.ok(handles.has(fd), 'descriptor closed twice'); closed.push(handles.get(fd)); handles.delete(fd) },
    fstatSync: fd => stats.get(handles.get(fd)), lstatSync: file => stats.get(file),
    readFileSync: fd => contents.get(handles.get(fd)),
    async * createReadStream(_file, { fd }) { yield contents.get(handles.get(fd)) },
  }
  const source = fs.readFileSync(new URL('../lib/linux-installed-manifest.mjs', import.meta.url), 'utf8')
  const context = { fs: memory, path, createHash, process: { getuid: () => 1000 },
    SHA: /^[a-f0-9]{64}$/, MAX_ARCHIVE: 1024 * 1024 * 1024, digest: hash, validateManifest,
    check(ok, code) { if (!ok) throw Object.assign(Error(code), { code }) } }
  const same = source.split('\n').find(line => line.startsWith('const same = '))
  assert.ok(same)
  vm.runInNewContext(same + '\n' + ['pinned', 'hashFd', 'verifyExternalManifest']
    .map(name => declaredFunctionSource(source.replace(/^export /gm, ''), name)).join('\n'), context)
  const options = { manifestFile, manifestSha256: hash(manifestBytes), deb, packageSha256, appRef, engineRef }
  return { run: (changes = {}) => context.verifyExternalManifest({ ...options, ...changes }),
    manifest, manifestFile, deb, opened, closed, handles }
}

test('external binding closes both retained descriptors after exact package and manifest validation', async () => {
  const f = externalBindingFiles()
  assert.deepEqual(structuredClone(await f.run()), f.manifest)
  assert.equal(f.handles.size, 0)
  assert.deepEqual([...f.closed].sort(), [f.manifestFile, f.deb].sort())
})

test('external binding closes the manifest descriptor when the selected package is missing', async () => {
  const f = externalBindingFiles({ missingPackage: true })
  await assert.rejects(f.run(), { code: 'ENOENT' })
  assert.deepEqual(f.opened, [f.manifestFile])
  assert.equal(f.handles.size, 0, 'missing package leaked the already pinned manifest')
  assert.deepEqual(f.closed, [f.manifestFile])
})

test('external binding closes the manifest and refused package descriptors on unsafe package admission', async () => {
  const f = externalBindingFiles({ unsafePackage: true })
  await assert.rejects(f.run(), { code: 'INSTALL_EVIDENCE_UNSAFE' })
  assert.equal(f.handles.size, 0, 'unsafe package leaked the already pinned manifest')
  assert.deepEqual([...f.closed].sort(), [f.manifestFile, f.deb].sort())
})

test('external binding still closes both descriptors when manifest digest validation refuses', async () => {
  const f = externalBindingFiles()
  await assert.rejects(f.run({ manifestSha256: '0'.repeat(64) }), { code: 'INSTALL_MANIFEST_DIGEST_MISMATCH' })
  assert.equal(f.handles.size, 0)
  assert.deepEqual([...f.closed].sort(), [f.manifestFile, f.deb].sort())
})
