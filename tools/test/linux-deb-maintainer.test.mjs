import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const { admissionBytes } = createRequire(import.meta.url)('../../shell/linux-installed-admission.cjs')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const script = path.join(root, 'build/linux/deb-maintainer.sh')
const policy = fs.readFileSync(path.join(root, 'build/linux/toolsenabled-customer.apparmor'), 'utf8')
const skip = process.platform !== 'linux' || process.getuid() === 0
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-deb-test-'))
  fs.chmodSync(dir, 0o700)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const p of ['opt/ToolsEnabled/resources/capability', 'etc/apparmor.d/abi', 'var/lib', 'bin',
    'sys/module/apparmor/parameters', 'sys/kernel/security/apparmor', 'proc/sys/kernel']) fs.mkdirSync(path.join(dir, p), { recursive: true, mode: 0o755 })
  const put = (p, value, mode = 0o644) => { fs.writeFileSync(path.join(dir, p), value, { mode }); fs.chmodSync(path.join(dir, p), mode) }
  put('opt/ToolsEnabled/toolsenabled', 'fixture ELF marker only', 0o755)
  put('opt/ToolsEnabled/resources/app.asar', 'fixture ASAR marker only')
  put('opt/ToolsEnabled/resources/capability/PAYLOAD.json', '{}')
  put('opt/ToolsEnabled/resources/apparmor-profile', policy)
  put('sys/module/apparmor/parameters/enabled', 'Y\n')
  put('sys/kernel/security/apparmor/profiles', '')
  put('proc/sys/kernel/apparmor_restrict_unprivileged_userns', '1\n')
  put('etc/apparmor.d/abi/4.0', 'synthetic modern ABI marker; not real parser input')
  // A bounded shell fixture, never an installed AppArmor parser. Its legacy
  // compile failure models the independently inspected 3.0.8 grammar gap.
  put('bin/apparmor_parser', `#!/bin/bash
set -eu
printf '%s\\n' "$1" >> "$TOOLSENABLED_DEB_TEST_ROOT/parser.log"
if [ "$1" = --version ]; then
  if [ -e "$TOOLSENABLED_DEB_TEST_ROOT/version-hang" ]; then exec /bin/sleep 10; fi
  if [ -e "$TOOLSENABLED_DEB_TEST_ROOT/version-fail" ]; then exit 6; fi
  cat "$TOOLSENABLED_DEB_TEST_ROOT/parser-version"
  exit 0
fi
if [ -e "$TOOLSENABLED_DEB_TEST_ROOT/fail-parser" ]; then exit 4; fi
if [ "$1" = --skip-kernel-load ] && [ -e "$TOOLSENABLED_DEB_TEST_ROOT/legacy-compile" ]; then echo 'synthetic unsupported modern policy' >&2; exit 42; fi
if [ "$1" = --replace ] && [ -e "$TOOLSENABLED_DEB_TEST_ROOT/fail-load" ]; then exit 5; fi
case "$1" in --replace) printf 'toolsenabled-customer (unconfined)\\n' > "$TOOLSENABLED_DEB_TEST_ROOT/sys/kernel/security/apparmor/profiles" ;; --remove) : > "$TOOLSENABLED_DEB_TEST_ROOT/sys/kernel/security/apparmor/profiles" ;; esac
`, 0o755)
  const run = (action = 'postinst', args = ['configure']) => spawnSync('/bin/bash', [script, ...args], {
    env: { PATH: '/usr/bin:/bin', TOOLSENABLED_DEB_TEST_ROOT: dir, DPKG_MAINTSCRIPT_PACKAGE: 'toolsenabled', DPKG_MAINTSCRIPT_NAME: action },
    encoding: 'utf8', timeout: 10000,
  })
  const legacy = () => {
    fs.unlinkSync(path.join(dir, 'etc/apparmor.d/abi/4.0'))
    put('parser-version', 'AppArmor parser version 3.0.8\nCopyright (C) 1999-2008 Novell Inc.\nCopyright 2009-2018 Canonical Ltd.\n')
    put('legacy-compile', '')
  }
  return { dir, put, run, legacy, read: p => fs.readFileSync(path.join(dir, p), 'utf8'), exists: p => fs.existsSync(path.join(dir, p)) }
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
    synopsis: 'Desktop workspace for AI agents', vendor: 'ToolsEnabled, Inc.',
    syncDesktopName: true, target: [{ target: 'deb', arch: ['x64'] }],
  })
  /* The control file's one-line summary, Debian section and vendor
     (1.0.50 release review, release-ops F11): without them apt show and
     software centres printed a blank summary, "Section: default" and the
     maintainer's mail address as the vendor. */
  assert.equal(pkg.build.deb.packageCategory, 'devel')
  assert.ok(pkg.build.linux.synopsis.length < 80 && !/\.$/.test(pkg.build.linux.synopsis),
    'a Debian synopsis is one short line with no full stop')
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
  assert.equal(f.read('var/lib/toolsenabled-installer/admission.state'), admissionBytes('profile-prepared').toString())
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
  assert.equal(f.read('var/lib/toolsenabled-installer/admission.state'), admissionBytes('no-policy-required').toString())
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
test('unload failure still finishes removal, says it clears on reboot, and touches no customer data', { skip }, t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  f.put('customer-workspace', 'untouched')
  f.put('fail-parser', '')
  // A parser that cannot unload must not strand dpkg (T-DEB-REMOVE-2): the
  // managed file still goes and the person is told the kernel copy survives
  // until reboot. A refused postrm wedges every later apt operation.
  const result = f.run('postrm', ['remove'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /clears on reboot/)
  assert.equal(f.exists('etc/apparmor.d/toolsenabled-customer'), false)
  assert.equal(f.exists('var/lib/toolsenabled-installer'), false)
  assert.equal(f.read('customer-workspace'), 'untouched')
})
test('kernel activation failure is reported and leaves managed retryable receipt', { skip }, t => {
  const f = fixture(t)
  f.put('fail-load', '')
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /could not be activated/)
  assert.equal(f.read('etc/apparmor.d/toolsenabled-customer'), policy)
  assert.equal(f.exists('var/lib/toolsenabled-installer/profile.sha256'), true)
  fs.unlinkSync(path.join(f.dir, 'fail-load'))
  assert.equal(f.run().status, 0)
})
test('non-AppArmor system with absent profile directory is honestly not-needed', { skip }, t => {
  const f = fixture(t)
  f.put('sys/module/apparmor/parameters/enabled', 'N\n')
  f.put('proc/sys/kernel/apparmor_restrict_unprivileged_userns', '0\n')
  fs.rmSync(path.join(f.dir, 'etc/apparmor.d'), { recursive: true })
  assert.equal(f.run().status, 0)
  assert.equal(f.exists('etc/apparmor.d'), false)
  assert.equal(f.exists('parser.log'), false)
})

test('known legacy parser configures an explicit deferred hold without compiling or loading policy', { skip }, t => {
  const f = fixture(t); f.legacy()
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /launch.*blocked/i)
  assert.equal(f.read('parser.log'), '--version\n')
  assert.match(f.read('var/lib/toolsenabled-installer/admission.state'), /state=deferred-legacy-policy\n/)
  assert.equal(f.exists('etc/apparmor.d/toolsenabled-customer'), false)
  assert.equal(f.exists('var/lib/toolsenabled-installer/profile.sha256'), false)
})

test('deferred configure re-enters after interruption, survives unrestricted observations and removes cleanly', { skip }, t => {
  const f = fixture(t); f.legacy(); f.put('offline', '')
  f.put('version-fail', '')
  assert.notEqual(f.run().status, 0)
  assert.equal(f.read('var/lib/toolsenabled-installer/admission.state'), admissionBytes('configuring').toString())
  fs.unlinkSync(path.join(f.dir, 'version-fail'))
  assert.equal(f.run().status, 0)
  const deferred = f.read('var/lib/toolsenabled-installer/admission.state')
  assert.equal(deferred, admissionBytes('deferred-legacy-policy').toString())
  assert.equal(f.run('postrm', ['upgrade', '1.0.49']).status, 0)
  assert.equal(f.read('var/lib/toolsenabled-installer/admission.state'), deferred)
  fs.unlinkSync(path.join(f.dir, 'offline'))
  f.put('proc/sys/kernel/apparmor_restrict_unprivileged_userns', '0\n')
  assert.equal(f.run().status, 0)
  assert.equal(f.read('var/lib/toolsenabled-installer/admission.state'), deferred)
  assert.equal(f.run('postrm', ['remove']).status, 0)
  assert.equal(f.exists('var/lib/toolsenabled-installer'), false)
  assert.equal(f.run('postrm', ['purge']).status, 0)
})

test('legacy deferral never follows modern compile failure or replaces a managed profile', { skip }, t => {
  const modern = fixture(t); modern.put('fail-parser', '')
  assert.notEqual(modern.run().status, 0)
  assert.equal(modern.read('var/lib/toolsenabled-installer/admission.state'), admissionBytes('configuring').toString())
  assert.equal(modern.read('parser.log'), '--skip-kernel-load\n')
  const prior = fixture(t); assert.equal(prior.run().status, 0); prior.legacy()
  const before = prior.read('parser.log')
  assert.notEqual(prior.run().status, 0)
  assert.equal(prior.read('etc/apparmor.d/toolsenabled-customer'), policy)
  assert.equal(prior.read('parser.log').slice(before.length), '--skip-kernel-load\n')
  const withAbi = fixture(t); withAbi.legacy(); withAbi.put('etc/apparmor.d/abi/4.0', 'present')
  assert.notEqual(withAbi.run().status, 0)
  assert.equal(withAbi.read('parser.log'), '--skip-kernel-load\n')
})

test('parser version eligibility refuses unknown, malformed, excessive and timed-out fixture output', { skip }, t => {
  for (const value of ['AppArmor parser version 4.0.1\n', 'AppArmor parser version 3.0.8\n',
    'AppArmor parser version 3.0.8\0\n', 'x'.repeat(3500)]) {
    const f = fixture(t); f.legacy(); f.put('parser-version', value)
    assert.notEqual(f.run().status, 0)
    assert.equal(f.read('var/lib/toolsenabled-installer/admission.state'), admissionBytes('configuring').toString())
    assert.equal(f.exists('etc/apparmor.d/toolsenabled-customer'), false)
  }
  const hanging = fixture(t); hanging.legacy(); hanging.put('version-hang', '')
  const started = Date.now(), result = hanging.run()
  assert.notEqual(result.status, 0)
  assert.equal(result.error, undefined, 'maintainer deadline, not outer fixture timeout')
  assert.ok(Date.now() - started < 6000)
  assert.match(result.stderr, /bounded AppArmor parser version/)
  assert.equal(hanging.read('parser.log'), '--version\n')
})

test('admission records reject unsafe or noncanonical data before changing managed policy', { skip }, t => {
  const changes = [
    f => f.put('var/lib/toolsenabled-installer/admission.state', admissionBytes('profile-prepared').toString() + 'state=profile-prepared\n'),
    f => f.put('var/lib/toolsenabled-installer/admission.state', 'x'.repeat(513)),
    f => fs.chmodSync(path.join(f.dir, 'var/lib/toolsenabled-installer/admission.state'), 0o666),
    f => fs.chmodSync(path.join(f.dir, 'var/lib/toolsenabled-installer/admission.state'), 0o600),
    f => {
      fs.renameSync(path.join(f.dir, 'var/lib/toolsenabled-installer/admission.state'), path.join(f.dir, 'outside-admission'))
      fs.symlinkSync(path.join(f.dir, 'outside-admission'), path.join(f.dir, 'var/lib/toolsenabled-installer/admission.state'))
    },
  ]
  for (const mutate of changes) {
    const f = fixture(t); assert.equal(f.run().status, 0); mutate(f)
    const before = f.read('parser.log')
    assert.notEqual(f.run().status, 0)
    assert.equal(f.read('parser.log'), before)
    assert.equal(f.read('etc/apparmor.d/toolsenabled-customer'), policy)
  }
})

test('legacy admission clears only through successful modern policy reconfiguration', { skip }, t => {
  const f = fixture(t); f.legacy(); assert.equal(f.run().status, 0)
  f.put('etc/apparmor.d/abi/4.0', 'synthetic modern ABI')
  fs.unlinkSync(path.join(f.dir, 'legacy-compile'))
  f.put('fail-load', '')
  assert.notEqual(f.run('postinst', ['configure', '1.0.49']).status, 0)
  assert.equal(f.read('var/lib/toolsenabled-installer/admission.state'), admissionBytes('configuring').toString())
  fs.unlinkSync(path.join(f.dir, 'fail-load'))
  assert.equal(f.run('postinst', ['configure', '1.0.49']).status, 0)
  assert.equal(f.read('var/lib/toolsenabled-installer/admission.state'), admissionBytes('profile-prepared').toString())
  assert.equal(f.read('etc/apparmor.d/toolsenabled-customer'), policy)
})
test('uninstall finishes when the kernel profile list cannot be read, and never guesses the profile away', { skip }, t => {
  const f = fixture(t)
  f.put('fail-load', '')
  assert.notEqual(f.run().status, 0)
  fs.unlinkSync(path.join(f.dir, 'sys/kernel/security/apparmor/profiles'))
  // An unreadable list is not evidence of absence, so the unload is skipped
  // rather than guessed -- but removal still completes and says what it left.
  const blind = f.run('postrm', ['remove'])
  assert.equal(blind.status, 0, blind.stderr)
  assert.match(blind.stderr, /could not be read/)
  assert.equal(f.exists('etc/apparmor.d/toolsenabled-customer'), false)
  // A readable list naming only other applications means nothing of ours is
  // loaded, so no unload is attempted and the managed file still goes.
  f.put('sys/kernel/security/apparmor/profiles', 'other-application (enforce)\n')
  assert.notEqual(f.run().status, 0)
  assert.equal(f.exists('etc/apparmor.d/toolsenabled-customer'), true)
  const prior = f.read('parser.log')
  assert.equal(f.run('postrm', ['remove']).status, 0)
  assert.equal(f.read('parser.log'), prior)
  assert.equal(f.exists('etc/apparmor.d/toolsenabled-customer'), false)
})

test('removal finishes after dpkg has already deleted /opt, the directory this package owns', { skip }, t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  // dpkg unpacks ./opt/ from this package, so on a machine whose only /opt
  // application is this one dpkg DELETES /opt while removing the payload --
  // before postrm runs. postrm only touches /etc/apparmor.d and
  // /var/lib/toolsenabled-installer, so demanding /opt made `apt remove` and
  // `apt purge` fail forever and wedged every later apt operation on that
  // machine. MEASURED 2026-09-24 in a clean ubuntu:24.04 container.
  fs.rmSync(path.join(f.dir, 'opt'), { recursive: true })
  const removal = f.run('postrm', ['remove'])
  assert.equal(removal.status, 0, removal.stderr)
  assert.equal(f.exists('etc/apparmor.d/toolsenabled-customer'), false)
  assert.equal(f.exists('var/lib/toolsenabled-installer'), false)
  assert.equal(f.run('postrm', ['purge']).status, 0)
  // Configuration still refuses without a safe /opt: only removal stopped
  // depending on a path it never reads.
  assert.notEqual(f.run().status, 0)
})
/* Platform review L2: Debian Policy 6.5 has dpkg call the installed postinst with
   abort-upgrade, abort-remove or abort-deconfigure while it unwinds a failed
   upgrade or removal. postrm upgrade changes nothing, so there is nothing to
   restore: these succeed without touching policy or admission. Refusing them
   left the package unpacked but not configured until dpkg --configure -a. */
test('postinst accepts the error-unwind actions dpkg sends after a failed upgrade or removal', { skip }, t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  const policyBefore = f.read('etc/apparmor.d/toolsenabled-customer')
  const admissionBefore = f.read('var/lib/toolsenabled-installer/admission.state')
  const parserBefore = f.read('parser.log')
  assert.equal(f.run('postrm', ['upgrade', '1.0.51']).status, 0)
  for (const args of [['abort-upgrade', '1.0.51'], ['abort-remove'], ['abort-remove', 'in-favour', 'other', '2.0'],
    ['abort-deconfigure', 'in-favour', 'other', '2.0']]) {
    const result = f.run('postinst', args)
    assert.equal(result.status, 0, `postinst ${args.join(' ')}: ${result.stderr}`)
  }
  assert.equal(f.read('etc/apparmor.d/toolsenabled-customer'), policyBefore)
  assert.equal(f.read('var/lib/toolsenabled-installer/admission.state'), admissionBefore)
  assert.equal(f.read('parser.log'), parserBefore)
  for (const args of [['triggered', 'x'], ['abort-install'], ['upgrade', '1.0.51'], ['abort-upgradex', '1']]) {
    const refused = f.run('postinst', args)
    assert.notEqual(refused.status, 0, `postinst ${args.join(' ')} was accepted`)
    assert.match(refused.stderr, /unsupported maintainer action/)
  }
})
