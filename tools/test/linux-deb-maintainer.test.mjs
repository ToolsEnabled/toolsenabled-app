import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const script = path.join(root, 'build/linux/deb-maintainer.sh')
const policy = fs.readFileSync(path.join(root, 'build/linux/toolsenabled-customer.apparmor'), 'utf8')
const skip = process.platform !== 'linux' || process.getuid() === 0
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-deb-test-'))
  fs.chmodSync(dir, 0o700)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const p of ['opt/ToolsEnabled/resources/capability', 'etc/apparmor.d', 'var/lib', 'bin',
    'sys/module/apparmor/parameters', 'sys/kernel/security/apparmor', 'proc/sys/kernel']) fs.mkdirSync(path.join(dir, p), { recursive: true, mode: 0o755 })
  const put = (p, value, mode = 0o644) => { fs.writeFileSync(path.join(dir, p), value, { mode }); fs.chmodSync(path.join(dir, p), mode) }
  put('opt/ToolsEnabled/toolsenabled', 'fixture ELF marker only', 0o755)
  put('opt/ToolsEnabled/resources/app.asar', 'fixture ASAR marker only')
  put('opt/ToolsEnabled/resources/capability/PAYLOAD.json', '{}')
  put('opt/ToolsEnabled/resources/apparmor-profile', policy)
  put('sys/module/apparmor/parameters/enabled', 'Y\n')
  put('sys/kernel/security/apparmor/profiles', '')
  put('proc/sys/kernel/apparmor_restrict_unprivileged_userns', '1\n')
  put('bin/apparmor_parser', '#!/bin/bash\nset -eu\nprintf "%s\\n" "$1" >> "$TOOLSENABLED_DEB_TEST_ROOT/parser.log"\nif [ -e "$TOOLSENABLED_DEB_TEST_ROOT/fail-parser" ]; then exit 4; fi\nif [ "$1" = --replace ] && [ -e "$TOOLSENABLED_DEB_TEST_ROOT/fail-load" ]; then exit 5; fi\ncase "$1" in --replace) printf "toolsenabled-customer (unconfined)\\n" > "$TOOLSENABLED_DEB_TEST_ROOT/sys/kernel/security/apparmor/profiles" ;; --remove) : > "$TOOLSENABLED_DEB_TEST_ROOT/sys/kernel/security/apparmor/profiles" ;; esac\n', 0o755)
  const run = (action = 'postinst', args = ['configure']) => spawnSync('/bin/bash', [script, ...args], {
    env: { PATH: '/usr/bin:/bin', TOOLSENABLED_DEB_TEST_ROOT: dir, DPKG_MAINTSCRIPT_PACKAGE: 'toolsenabled', DPKG_MAINTSCRIPT_NAME: action },
    encoding: 'utf8', timeout: 10000,
  })
  return { dir, put, run, read: p => fs.readFileSync(path.join(dir, p), 'utf8'), exists: p => fs.existsSync(path.join(dir, p)) }
}
test('maintainer bash syntax and fixed exact policy are valid', { skip: process.platform !== 'linux' ? 'Linux maintainer-script proof requires Linux bash' : false }, () => {
  assert.equal(spawnSync('/bin/bash', ['-n', script]).status, 0)
  assert.match(policy, /profile toolsenabled-customer "\/opt\/ToolsEnabled\/toolsenabled" flags=\(unconfined\)/)
  assert.equal(policy.includes('*'), false)
  const source = fs.readFileSync(script, 'utf8')
  assert.doesNotMatch(source, /chmod\s+4755|--no-sandbox|sysctl\s+-w/)
  // Installed builder only interpolates alphabetic ${macro}; no shell variable
  // accidentally becomes a build-time macro or shell code from product metadata.
  assert.deepEqual(source.match(/\$\{[a-zA-Z]+\}/g), null)
})
test('normal Linux packaging selects the exact executable and custom hooks, not builder fallback policy', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.productName, 'ToolsEnabled')
  assert.equal(pkg.homepage, 'https://toolsenabled.ai')
  assert.deepEqual(pkg.build.linux, {
    executableName: 'toolsenabled', icon: 'shell/icon.png', category: 'Development',
    syncDesktopName: true, target: [{ target: 'deb', arch: ['x64'] }],
  })
  assert.equal(pkg.desktopName, 'toolsenabled.desktop')
  assert.equal(pkg.build.deb.packageName, 'toolsenabled')
  assert.equal(pkg.build.deb.appArmorProfile, 'build/linux/toolsenabled-customer.apparmor')
  assert.equal(pkg.build.deb.afterInstall, 'build/linux/deb-maintainer.sh')
  assert.equal(pkg.build.deb.afterRemove, 'build/linux/deb-maintainer.sh')
  assert.equal(pkg.build.win.target[0].target, 'nsis')
})
test('Debian dependencies provide native input and encrypted-vault runtime prerequisites', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  // libsecret's shared library does not supply its GI typelib, Python binding,
  // encryption implementation or the persistent daemon that custody pins.
  // Declare hard dependencies: a configured developer desktop is not proof a
  // fresh customer installation can import or launch those native components.
  for (const dependency of ['python3', 'python3-gi', 'python3-cryptography',
    'gir1.2-secret-1', 'gnome-keyring', 'libsecret-1-0', 'libgtk-3-0']) {
    assert.ok(pkg.build.deb.depends.includes(dependency), `Missing native runtime dependency: ${dependency}`)
  }
})
test('actual configure, repeat configure, upgrade postrm and remove preserve safe ownership lifecycle', { skip }, t => {
  const f = fixture(t)
  let result = f.run(); assert.equal(result.status, 0, result.stderr)
  assert.equal(f.read('etc/apparmor.d/toolsenabled-customer'), policy)
  assert.equal(fs.statSync(path.join(f.dir, 'etc/apparmor.d/toolsenabled-customer')).mode & 0o777, 0o644)
  result = f.run(); assert.equal(result.status, 0, result.stderr)
  const before = f.read('parser.log')
  assert.equal(f.run('postrm', ['upgrade', '1.0.39']).status, 0)
  assert.equal(f.read('parser.log'), before)
  assert.equal(f.run('postrm', ['remove']).status, 0)
  assert.equal(f.exists('etc/apparmor.d/toolsenabled-customer'), false)
  assert.equal(f.exists('var/lib/toolsenabled-installer'), false)
  assert.match(f.read('parser.log'), /--remove/)
  assert.equal(f.run('postrm', ['purge']).status, 0)
})
test('administrator changes and foreign existing policy are preserved on configure/remove', { skip }, t => {
  const f = fixture(t)
  f.put('etc/apparmor.d/toolsenabled-customer', 'administrator policy')
  assert.notEqual(f.run().status, 0)
  assert.equal(f.read('etc/apparmor.d/toolsenabled-customer'), 'administrator policy')
  fs.unlinkSync(path.join(f.dir, 'etc/apparmor.d/toolsenabled-customer'))
  assert.equal(f.run().status, 0)
  f.put('etc/apparmor.d/toolsenabled-customer', 'administrator edit')
  assert.notEqual(f.run().status, 0)
  assert.notEqual(f.run('postrm', ['remove']).status, 0)
  assert.equal(f.read('etc/apparmor.d/toolsenabled-customer'), 'administrator edit')
})
test('missing/parser-failing restricted kernel is a hard failure with no SUID fallback', { skip }, t => {
  const f = fixture(t)
  f.put('fail-parser', '')
  assert.notEqual(f.run().status, 0)
  assert.equal(f.exists('etc/apparmor.d/toolsenabled-customer'), false)
  fs.unlinkSync(path.join(f.dir, 'bin/apparmor_parser'))
  assert.notEqual(f.run().status, 0)
  assert.equal(fs.statSync(path.join(f.dir, 'opt/ToolsEnabled/toolsenabled')).mode & 0o7777, 0o755)
})
test('unrestricted kernel reports not needed; offline profile activation is honestly deferred', { skip }, t => {
  const f = fixture(t)
  f.put('proc/sys/kernel/apparmor_restrict_unprivileged_userns', '0\n')
  let result = f.run(); assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /not required/)
  assert.equal(f.exists('parser.log'), false)
  f.put('offline', '')
  result = f.run(); assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /deferred/)
  assert.equal(f.read('parser.log'), '--skip-kernel-load\n')
})
test('symlink targets, hardlinks, writable resources and unexpected policy bytes refuse', { skip }, t => {
  const f = fixture(t)
  f.put('outside', 'must remain untouched')
  fs.symlinkSync(path.join(f.dir, 'outside'), path.join(f.dir, 'etc/apparmor.d/toolsenabled-customer'))
  assert.notEqual(f.run().status, 0)
  assert.equal(f.read('outside'), 'must remain untouched')
  fs.unlinkSync(path.join(f.dir, 'etc/apparmor.d/toolsenabled-customer'))
  fs.linkSync(path.join(f.dir, 'outside'), path.join(f.dir, 'opt/ToolsEnabled/link'))
  assert.notEqual(f.run().status, 0)
  fs.unlinkSync(path.join(f.dir, 'opt/ToolsEnabled/link'))
  fs.chmodSync(path.join(f.dir, 'opt/ToolsEnabled/resources/app.asar'), 0o664)
  assert.notEqual(f.run().status, 0)
  fs.chmodSync(path.join(f.dir, 'opt/ToolsEnabled/resources/app.asar'), 0o644)
  f.put('opt/ToolsEnabled/resources/apparmor-profile', 'unexpected policy')
  assert.notEqual(f.run().status, 0)
})
test('unload failure preserves policy and receipt; no profile/userData deletion beyond own paths', { skip }, t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  f.put('customer-workspace', 'untouched')
  f.put('fail-parser', '')
  assert.notEqual(f.run('postrm', ['remove']).status, 0)
  assert.equal(f.read('etc/apparmor.d/toolsenabled-customer'), policy)
  assert.equal(f.exists('var/lib/toolsenabled-installer/profile.sha256'), true)
  assert.equal(f.read('customer-workspace'), 'untouched')
})
test('kernel activation failure is reported and leaves managed retryable receipt', { skip }, t => {
  const f = fixture(t)
  f.put('fail-load', '')
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /activation failed/)
  assert.equal(f.read('etc/apparmor.d/toolsenabled-customer'), policy)
  assert.equal(f.exists('var/lib/toolsenabled-installer/profile.sha256'), true)
  fs.unlinkSync(path.join(f.dir, 'fail-load'))
  assert.equal(f.run().status, 0)
})
test('non-AppArmor system with absent profile directory is honestly not-needed', { skip }, t => {
  const f = fixture(t)
  f.put('sys/module/apparmor/parameters/enabled', 'N\n')
  f.put('proc/sys/kernel/apparmor_restrict_unprivileged_userns', '0\n')
  fs.rmdirSync(path.join(f.dir, 'etc/apparmor.d'))
  assert.equal(f.run().status, 0)
  assert.equal(f.exists('etc/apparmor.d'), false)
  assert.equal(f.exists('parser.log'), false)
})
test('uninstall observes absent loaded name after activation failure; unknown state remains failure', { skip }, t => {
  const f = fixture(t)
  f.put('fail-load', '')
  assert.notEqual(f.run().status, 0)
  fs.unlinkSync(path.join(f.dir, 'sys/kernel/security/apparmor/profiles'))
  assert.notEqual(f.run('postrm', ['remove']).status, 0)
  assert.equal(f.exists('etc/apparmor.d/toolsenabled-customer'), true)
  f.put('sys/kernel/security/apparmor/profiles', 'other-application (enforce)\n')
  const prior = f.read('parser.log')
  assert.equal(f.run('postrm', ['remove']).status, 0)
  assert.equal(f.read('parser.log'), prior)
  assert.equal(f.exists('etc/apparmor.d/toolsenabled-customer'), false)
})
