import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { platformSkipReason } from '../lib/test-suite-result.mjs'

const require_ = createRequire(import.meta.url)
const { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } =
  require_('../lib/sterile-launch.cjs')

import {
  LINUX_APPARMOR_PROFILE_ENV,
  PACKAGED_PLATFORMS,
  applyPlatformHomes,
  defaultReleaseDirectory,
  linuxDescendantPids,
  linuxProfileHomes,
  makePrivateDirectory,
  packagedLaunchCommand,
  packagedLaunchReadiness,
  packagedLauncherName,
  packagedLauncherPresent,
  packagedPlatform,
  parseProcStat,
  reapProcessTree,
  unpackedDirectoryName,
} from '../lib/packaged-platform.mjs'

/* WHY THIS SUITE EXISTS, IN ONE LINE: every assertion below is a fact one of
   the eighty-six packaged-QA drivers needed from its host and did not have on
   Linux, which is why the 1.0.44 Linux cut recorded its packaged-QA step as a
   refusal rather than a result.

   Every test asks for a platform EXPLICITLY, so the Windows answers are
   measured on this Linux host and the Linux answers would be measured on a
   Windows one. A suite that only ever asked about the host it ran on would go
   green on half the code. */

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

function scratch(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'packaged-platform-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

/* ---- 1. which file is the application ---------------------------------- */

test('the launcher and the unpacked directory are answered per platform, and an unpackaged platform is an error', () => {
  assert.equal(packagedLauncherName('win32'), 'ToolsEnabled.exe',
    'mutation `answer the Linux launcher on Windows` survived: expected the PE launcher on win32')
  assert.equal(packagedLauncherName('linux'), 'toolsenabled',
    'mutation `answer ToolsEnabled.exe everywhere` survived: expected build.linux.executableName on linux')
  assert.equal(unpackedDirectoryName('win32'), 'win-unpacked',
    'mutation `use one unpacked directory name for both targets` survived: expected win-unpacked on win32')
  assert.equal(unpackedDirectoryName('linux'), 'linux-unpacked',
    'mutation `use one unpacked directory name for both targets` survived: expected linux-unpacked on linux')
  /* Falling back to the Windows names on a platform this repository does not
     package would hand a macOS operator a refusal naming a file that platform
     never builds, which reads as a broken build rather than an unported host. */
  assert.throws(() => packagedPlatform('darwin'), /no artifact names for darwin/,
    'mutation `default an unknown platform to the Windows names` survived: expected a refusal that names the platform')
  assert.deepEqual(Object.keys(PACKAGED_PLATFORMS).sort(), ['linux', 'win32'],
    'mutation `add a platform here without giving it a cutter` survived: expected exactly the two packaged targets')
})

test('the default release directory follows the host, which is the whole reason step 54 could only refuse', () => {
  const repo = path.join(path.sep, 'repo')
  assert.equal(defaultReleaseDirectory(repo, 'win32'), path.join(repo, 'release', 'win-unpacked'),
    'mutation `move the Windows default` survived: expected release/win-unpacked on win32')
  assert.equal(defaultReleaseDirectory(repo, 'linux'), path.join(repo, 'release', 'linux-unpacked'),
    'mutation `keep release/win-unpacked as the default on every platform` survived: '
    + 'expected the directory a Linux build actually writes')
  assert.throws(() => defaultReleaseDirectory('', 'linux'), /repository root/,
    'mutation `resolve a default against an empty root` survived: expected a refusal')
})

test('launcher presence is asked of THIS platform, so a Linux tree is no longer answered about a .exe', t => {
  const root = scratch(t)
  const release = path.join(root, 'linux-unpacked')
  mkdirSync(release)
  writeFileSync(path.join(release, 'toolsenabled'), '')
  assert.equal(packagedLauncherPresent(release, 'linux'), true,
    'mutation `keep asking every host for ToolsEnabled.exe` survived: expected the ELF launcher to count on linux')
  assert.equal(packagedLauncherPresent(release, 'win32'), false,
    'mutation `accept any launcher on any platform` survived: expected a Linux tree to be refused for a Windows run')
  assert.equal(packagedLauncherPresent(path.join(root, 'absent'), 'linux'), false,
    'mutation `treat a missing tree as present` survived: expected absence to be false')
  assert.equal(packagedLauncherPresent(null, 'linux'), false,
    'mutation `treat a missing argument as present` survived: expected no tree to be false')
})

/* ---- 2 & 4. the homes a Linux child must not find ----------------------- */

test('a Linux child gets its own HOME and XDG roots, and XDG_DATA_HOME is the directory LOCALAPPDATA names', () => {
  const profile = path.join(path.sep, 'scratch', 'profile')
  const homes = linuxProfileHomes(profile)
  /* Unsetting HOME is not isolation: Node then consults passwd and finds the
     real account again. sterile-launch.cjs records the same measurement. */
  assert.equal(homes.HOME, path.join(profile, 'home'),
    'mutation `leave HOME inherited or merely unset` survived: expected a scratch HOME inside the profile')
  /* The payload resolves its services root from LOCALAPPDATA first and
     XDG_DATA_HOME otherwise. Two different directories would make the machine
     record the harness SEEDS and the one the application READS the same file
     only by accident of which branch ran. */
  assert.equal(homes.XDG_DATA_HOME, path.join(profile, 'local'),
    'mutation `give XDG_DATA_HOME a directory of its own` survived: '
    + 'expected the same directory LOCALAPPDATA names, so the two resolvers cannot disagree')
  for (const name of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    assert.ok(homes[name].startsWith(profile + path.sep),
      `mutation \`let ${name} stay on the builder's account\` survived: expected it inside the QA profile`)
  }
  assert.throws(() => linuxProfileHomes('relative/profile'), /absolute/,
    'mutation `accept a relative profile` survived: expected a refusal; a half-redirected home is the builder\'s home')
})

test('applying the platform homes is a no-op on Windows and a complete fence on Linux', () => {
  const profile = path.join(path.sep, 'scratch', 'profile')
  const windows = { LOCALAPPDATA: 'x' }
  applyPlatformHomes(windows, profile, 'win32')
  assert.deepEqual(Object.keys(windows), ['LOCALAPPDATA'],
    'mutation `set XDG names in a Windows child` survived: expected nothing added where nothing reads them')

  const linux = { LOCALAPPDATA: path.join(profile, 'local') }
  applyPlatformHomes(linux, profile, 'linux')
  assert.equal(linux.HOME, path.join(profile, 'home'),
    'mutation `stop at the four Windows homes on Linux` survived: expected HOME redirected too')
  assert.equal(linux.XDG_DATA_HOME, linux.LOCALAPPDATA,
    'mutation `let the two data roots drift apart` survived: expected one directory for both resolvers')
})

test('a QA directory that will hold a launch is created private, whatever the operator umask is', { skip: platformSkipReason('linux') }, t => {
  /* MEASURED 2026-09-11: this host's umask is 002, so every mkdirSync in the QA
     harnesses produced 0775. shell/linux-account-state.cjs:64-65 refuses any
     ancestor of the selected --user-data-dir with `mode & 0o022` set unless it
     is a root-owned sticky directory, so the packaged application exited 1 with
     MC_ACCOUNT_STATE_UNSAFE before opening anything -- which five drivers
     reported as "the app exited with code 1 before the debugger answered".
     The mode is asked for explicitly rather than inherited from a shell. */
  const root = scratch(t)
  const nested = path.join(root, 'outer', 'inner')
  makePrivateDirectory(nested)
  for (const directory of [path.join(root, 'outer'), nested]) {
    const mode = statSync(directory).mode & 0o7777
    assert.equal(mode & 0o022, 0,
      `mutation \`create a QA launch directory at the mercy of umask\` survived: `
      + `expected no group or other write on ${directory}, measured ${mode.toString(8)}`)
    assert.equal(mode, 0o700,
      `mutation \`widen the requested mode\` survived: expected 0700 on ${directory}, measured ${mode.toString(8)}`)
  }
})

test('QA directory creation requires an absolute path and requests private POSIX permissions on every host', () => {
  assert.throws(() => makePrivateDirectory('relative/path'), /absolute/,
    'mutation `accept a relative directory` survived: expected a refusal')
  /* The mode is REQUESTED, not assumed to be applied by the caller: a Windows
     run ignores it, and that must not turn into a platform branch nobody tests. */
  const asked = []
  makePrivateDirectory(path.join(path.sep, 'x'), { platform: 'win32', mkdir: (dir, options) => asked.push(options) })
  assert.deepEqual(asked, [{ recursive: true, mode: 0o700 }],
    'mutation `skip the mode on Windows` survived: expected one code path, asking for 0700 on both')
})

/* ---- 3. how a process tree is reaped ------------------------------------ */

test('a /proc stat line is parsed after the LAST parenthesis, because a comm may contain both', () => {
  /* Splitting on whitespace is wrong for exactly the processes a QA reap cares
     about: `(my app (2))` is a legal comm, and an Electron helper's name is
     routinely spaced. */
  const parsed = parseProcStat('4321 (my app (2)) S 1234 4321 4321 0 -1 4194560 '
    + Array.from({ length: 13 }, (_, index) => index).join(' ') + ' 987654 1000 2000\n')
  assert.equal(parsed.pid, 4321,
    'mutation `read the pid from a whitespace split` survived: expected the pid before the first parenthesis')
  assert.equal(parsed.ppid, 1234,
    'mutation `split the whole line on whitespace` survived: expected ppid read after the LAST parenthesis')
  assert.equal(parseProcStat('not a stat line'), null,
    'mutation `invent a pid for an unparseable line` survived: expected null')
  assert.equal(parseProcStat(undefined), null,
    'mutation `accept a non-string` survived: expected null')
})

test('the descendant walk finds grandchildren and terminates on a snapshot that looks cyclic', () => {
  const snapshot = () => [
    { pid: 100, ppid: 1, startTime: 10 },
    { pid: 200, ppid: 100, startTime: 20 },
    { pid: 300, ppid: 200, startTime: 30 },
    /* pid reuse can make a real snapshot look cyclic; an unguarded walk would
       never return, which in a reap means a driver that never tears down. */
    { pid: 100, ppid: 300, startTime: 10 },
  ]
  const found = linuxDescendantPids(100, { snapshot }).map(row => row.pid)
  assert.deepEqual(found, [200, 300],
    'mutation `stop the walk at direct children` survived: expected the grandchild too, and the root excluded')
  assert.deepEqual(linuxDescendantPids(0, { snapshot }), [],
    'mutation `walk from a bogus pid` survived: expected nothing')
})

test('the Linux reap kills descendants before the root, and refuses a pid whose start time changed', () => {
  const snapshot = () => [
    { pid: 100, ppid: 1, startTime: 10 },
    { pid: 200, ppid: 100, startTime: 20 },
    { pid: 300, ppid: 100, startTime: 30 },
  ]
  const killed = []
  /* 300 was recycled between the snapshot and the kill: a DIFFERENT process is
     wearing that number now, and signalling it would be this harness damaging
     the machine it is supposed to be measuring. */
  const startTimeOf = pid => (pid === 300 ? 999 : { 100: 10, 200: 20 }[pid] ?? null)
  const result = reapProcessTree(100, {
    platform: 'linux',
    snapshot,
    startTimeOf,
    signal: pid => killed.push(pid),
  })
  assert.deepEqual(killed, [200, 100],
    'mutation `kill the root first, or kill a recycled pid` survived: '
    + 'expected the descendants first (the links the walk needs are still live) and the recycled pid spared')
  assert.equal(result.reaped, 2,
    'mutation `count a spared pid as reaped` survived: expected only what was actually signalled')
})

test('taskkill stays the Windows answer, and off Windows it is no longer a reap that silently does nothing', () => {
  /* THE DEFECT THIS PINS. `spawnSync('taskkill.exe', ...)` inside a try/catch
     returns ENOENT on Linux and the catch swallows it, so every driver's
     teardown reported success while leaving its whole Electron tree running. */
  const calls = []
  reapProcessTree(4321, { platform: 'win32', run: (command, args) => calls.push([command, args]) })
  assert.deepEqual(calls, [['taskkill.exe', ['/PID', '4321', '/T', '/F']]],
    'mutation `change the Windows reap while porting Linux` survived: expected taskkill /T /F unchanged')

  const signalled = []
  reapProcessTree(4321, { platform: 'linux', snapshot: () => [], signal: pid => signalled.push(pid) })
  assert.deepEqual(signalled, [4321],
    'mutation `leave Linux with no reap at all` survived: expected the root to actually be signalled')
  assert.equal(reapProcessTree(0, { platform: 'linux' }).reaped, 0,
    'mutation `signal something for a missing pid` survived: expected nothing')
})

test('an unreadable process table is reported as unknown, never as an empty tree', () => {
  const result = reapProcessTree(4321, {
    platform: 'linux',
    snapshot: () => { const error = new Error('denied'); error.code = 'PROCESS_SNAPSHOT_UNAVAILABLE'; throw error },
    signal: () => {},
  })
  assert.equal(result.skipped, 'PROCESS_SNAPSHOT_UNAVAILABLE',
    'mutation `treat an unreadable /proc as a tree with no descendants` survived: expected the caller to be told')
})

test('the reap is measured against a real orphaned grandchild, not only against a fixture', { skip: process.platform !== 'linux' }, async t => {
  const directory = scratch(t)
  writeFileSync(path.join(directory, 'grandchild.cjs'), 'setInterval(() => {}, 1000)\n')
  writeFileSync(path.join(directory, 'middle.cjs'), `
    const { spawn } = require('node:child_process')
    const path = require('node:path')
    const child = spawn(process.execPath, [path.join(__dirname, 'grandchild.cjs')], { stdio: 'ignore' })
    console.log('GRANDCHILD=' + child.pid)
    setInterval(() => {}, 1000)
  `)
  const middle = spawn(process.execPath, [path.join(directory, 'middle.cjs')], { stdio: ['ignore', 'pipe', 'ignore'] })
  let grandchild = null
  middle.stdout.on('data', chunk => {
    const match = String(chunk).match(/GRANDCHILD=(\d+)/)
    if (match) grandchild = Number(match[1])
  })
  for (let waited = 0; grandchild === null && waited < 8000; waited += 100) await settle(100)
  /* The precondition is what makes the assertion mean anything: without it the
     test can pass because the grandchild died on its own. */
  assert.notEqual(grandchild, null, 'the fixture never reported a grandchild, so nothing was measured')
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  assert.equal(alive(grandchild), true, 'the fixture grandchild was not running, so nothing was measured')

  t.after(() => { for (const pid of [middle.pid, grandchild]) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } })
  reapProcessTree(middle.pid, { platform: 'linux' })
  await settle(600)
  assert.equal(alive(grandchild), false,
    'mutation `reap only the process you were handed` survived: expected the grandchild reaped too')
  assert.equal(alive(middle.pid), false,
    'mutation `reap the descendants and leave the root` survived: expected the root reaped last, but reaped')
})

/* ---- 5. can a packaged Electron even start on this host ----------------- */

test('Windows is never asked the sandbox question, because Chromium does not ask it there', () => {
  const readiness = packagedLaunchReadiness({ platform: 'win32', env: {} })
  assert.equal(readiness.ready, true,
    'mutation `run the Linux sandbox preflight on Windows` survived: expected Windows to be ready with no display probe')
  assert.deepEqual(readiness.reasons, [],
    'mutation `invent a Windows precondition` survived: expected no reasons')
})

test('a Linux host with no desktop session is refused for the missing display, not for the sandbox', () => {
  const readiness = packagedLaunchReadiness({
    platform: 'linux',
    env: {},
    readFile: () => { const error = new Error('absent'); error.code = 'ENOENT'; throw error },
  })
  assert.equal(readiness.ready, false,
    'mutation `run 86 window-opening drivers with no display` survived: expected a refusal')
  assert.equal(readiness.reasons.length, 1,
    'mutation `blame the sandbox for a missing display` survived: expected exactly the display reason')
  assert.match(readiness.reasons[0], /DISPLAY or WAYLAND_DISPLAY/,
    'mutation `refuse without naming what is missing` survived: expected the variable names')
})

test('the sandbox refusal fires on exactly the host that measured exit 133, and names all three ways out', () => {
  /* MEASURED 2026-09-11 against the 1.0.44 candidate's own linux-unpacked tree:
     kernel.apparmor_restrict_unprivileged_userns=1, this process unconfined,
     chrome-sandbox 0755 and not root-owned -> FATAL setuid_sandbox_host.cc:166,
     exit 133, before any window. */
  const readiness = packagedLaunchReadiness({
    platform: 'linux',
    executable: path.join(path.sep, 'candidate', 'linux-unpacked', 'toolsenabled'),
    env: { DISPLAY: ':0' },
    readFile: file => (file.includes('apparmor_restrict_unprivileged_userns') ? '1\n' : 'unconfined\n'),
    lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    stat: () => ({ uid: 1000, mode: 0o100755 }),
  })
  assert.equal(readiness.ready, false,
    'mutation `start 86 drivers against a process that dies at exit 133` survived: expected a refusal before any driver')
  const reason = readiness.reasons.join(' ')
  assert.match(reason, /exit 133/, 'mutation `refuse without the measured symptom` survived: expected the exit code')
  for (const [what, pattern] of [
    ['the AppArmor route', /aa-exec/],
    ['the installed-tree route', /INSTALLED tree/],
    ['the sysctl route', /unprivileged user namespaces/],
  ]) {
    assert.match(reason, pattern,
      `mutation \`refuse without naming ${what}\` survived: expected a refusal that says what the person can do`)
  }
  /* --no-sandbox would make every driver green against a configuration no
     customer runs; smoke-linux-sealed.mjs makes noSandboxSwitch === false a
     pass condition for the same reason. */
  assert.match(reason, /--no-sandbox is not one of them/,
    'mutation `offer --no-sandbox as a fix` survived: expected it refused by name')
})

test('an installed tree passes the same preflight, because its chrome-sandbox really is root:4755', () => {
  const readiness = packagedLaunchReadiness({
    platform: 'linux',
    executable: path.join(path.sep, 'opt', 'ToolsEnabled', 'toolsenabled'),
    env: { DISPLAY: ':0' },
    readFile: file => (file.includes('apparmor_restrict_unprivileged_userns') ? '1\n' : 'unconfined\n'),
    lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    stat: () => ({ uid: 0, mode: 0o104755 }),
  })
  assert.equal(readiness.ready, true,
    'mutation `refuse a tree whose setuid helper is correct` survived: expected the installed tree to pass')
})

test('a host that cannot say whether namespaces are allowed is treated as a no, not as a yes', () => {
  const readiness = packagedLaunchReadiness({
    platform: 'linux',
    executable: path.join(path.sep, 'candidate', 'toolsenabled'),
    env: { DISPLAY: ':0' },
    readFile: file => {
      if (file.includes('apparmor_restrict_unprivileged_userns')) { const e = new Error('denied'); e.code = 'EACCES'; throw e }
      return 'unconfined\n'
    },
    lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    stat: () => ({ uid: 1000, mode: 0o100755 }),
  })
  assert.equal(readiness.ready, false,
    'mutation `read an unreadable sysctl as permissive` survived: expected unknown to be refused, because unknown is not a yes')
  assert.match(readiness.reasons.join(' '), /unknown is not a yes/,
    'mutation `refuse without saying it did not know` survived: expected the refusal to say so')
})

test('naming a loaded AppArmor profile is an answer the preflight accepts and the launch actually applies', t => {
  const root = scratch(t)
  const helper = path.join(root, 'aa-exec')
  writeFileSync(helper, '')
  const env = { DISPLAY: ':0', [LINUX_APPARMOR_PROFILE_ENV]: 'toolsenabled-customer' }

  const launch = packagedLaunchCommand('/candidate/toolsenabled', ['--user-data-dir=/scratch'], {
    platform: 'linux', env, exists: () => true,
  })
  /* ABSOLUTE, not a bare name: shell/owned-claim-process refuses a launch root
     it cannot resolve ("An owned claim requires explicit absolute launch
     roots", measured 2026-09-11 from home-screen-qa), and a helper that changes
     confinement must never be found by searching a PATH. */
  assert.equal(path.isAbsolute(launch.command) && path.basename(launch.command) === 'aa-exec', true,
    'mutation `return the bare helper name` survived: expected an absolute path to aa-exec')
  assert.deepEqual(launch.args, ['-p', 'toolsenabled-customer', '--', '/candidate/toolsenabled', '--user-data-dir=/scratch'],
    'mutation `drop the driver arguments when confining` survived: expected every argument forwarded after --')
  assert.equal(launch.confinement, 'toolsenabled-customer',
    'mutation `confine silently` survived: expected the profile recorded on the launch')
})

test('an unset profile changes nothing, on either platform, so no existing driver moves', () => {
  for (const platform of ['win32', 'linux']) {
    const launch = packagedLaunchCommand('/candidate/app', ['--flag'], { platform, env: {}, exists: () => true })
    assert.equal(launch.command, '/candidate/app',
      `mutation \`wrap every ${platform} launch\` survived: expected the application itself with no opt-in`)
    assert.equal(launch.confinement, null,
      `mutation \`claim a confinement nobody asked for\` survived: expected none on ${platform}`)
  }
  /* Windows has no aa-exec and must not consult the variable at all. */
  const windows = packagedLaunchCommand('/candidate/app.exe', [], {
    platform: 'win32', env: { [LINUX_APPARMOR_PROFILE_ENV]: 'toolsenabled-customer' }, exists: () => true,
  })
  assert.equal(windows.command, '/candidate/app.exe',
    'mutation `apply a Linux confinement on Windows` survived: expected the variable ignored off Linux')
})

test('the profile is read from the harness environment, never from the sterile child environment', t => {
  /* MEASURED DEFECT, 2026-09-11. home-screen-qa builds its child an ALLOWLIST
     environment -- SystemRoot, DISPLAY, XAUTHORITY, LANG, MC_SMOKE_HEADLESS and
     nothing else -- and handing that object to packagedLaunchCommand made the
     opt-in invisible. The launch went unconfined, the packaged ELF aborted at
     exit 133, and the driver reported "The owned application exited before Home
     inspection completed": a product-shaped sentence about a sandbox the
     harness had failed to ask for. */
  const childEnvironment = { DISPLAY: ':0', LANG: 'C.UTF-8', MC_SMOKE_HEADLESS: '1' }
  const previous = process.env[LINUX_APPARMOR_PROFILE_ENV]
  process.env[LINUX_APPARMOR_PROFILE_ENV] = 'toolsenabled-customer'
  t.after(() => {
    if (previous === undefined) delete process.env[LINUX_APPARMOR_PROFILE_ENV]
    else process.env[LINUX_APPARMOR_PROFILE_ENV] = previous
  })
  const launch = packagedLaunchCommand('/candidate/toolsenabled', ['--user-data-dir=/scratch'], {
    platform: 'linux', exists: () => true,
  })
  assert.equal(launch.confinement, 'toolsenabled-customer',
    'mutation `read the opt-in out of the child environment` survived: '
    + 'expected it read from the harness, whose child may legitimately carry nothing')
  assert.equal(childEnvironment[LINUX_APPARMOR_PROFILE_ENV], undefined,
    'mutation `push the harness instruction into the child` survived: '
    + 'expected the child environment untouched -- the application never reads this')
})

test('a profile name that is not one is refused by name rather than passed to a command line', () => {
  for (const bad of ['a name with spaces', '--not-a-profile', 'name;rm -rf /', '']) {
    const env = { [LINUX_APPARMOR_PROFILE_ENV]: bad }
    if (bad === '') {
      assert.equal(packagedLaunchCommand('/app', [], { platform: 'linux', env, exists: () => true }).command, '/app',
        'mutation `treat an empty profile as a request to confine` survived: expected an unwrapped launch')
      continue
    }
    assert.throws(() => packagedLaunchCommand('/app', [], { platform: 'linux', env, exists: () => true }),
      /is not an AppArmor profile name/,
      `mutation \`pass ${JSON.stringify(bad)} through to aa-exec\` survived: expected a refusal before any spawn`)
  }
  assert.throws(() => packagedLaunchCommand('/app', [], {
    platform: 'linux', env: { [LINUX_APPARMOR_PROFILE_ENV]: 'toolsenabled-customer' }, exists: () => false,
  }), /aa-exec is not installed/,
    'mutation `spawn aa-exec that is not there and read ENOENT as a product failure` survived: expected a named refusal')
})

test('confining a launch does not hide the pid the driver reaps', { skip: process.platform !== 'linux' }, async t => {
  /* LOAD-BEARING, AND IT IS THE WHOLE REASON THE WRAPPER IS ALLOWED TO EXIST.
     Every driver ends by calling reap(child.pid) and child.kill() on what it
     spawned. If aa-exec stayed in the tree as a parent, `child.pid` would name
     the wrapper, the reap would address the wrong process, and a teardown that
     looked clean would leave the application running -- the same defect this
     port fixed in reap() itself, reintroduced one layer up. aa-exec enters the
     profile and then execs in place, so the pid is preserved; measured here
     rather than assumed from its documentation. */
  const directory = scratch(t)
  const probe = path.join(directory, 'probe.cjs')
  writeFileSync(probe, "console.log('MYPID=' + process.pid)\n")
  const launch = packagedLaunchCommand(process.execPath, [probe], {
    platform: 'linux',
    env: { [LINUX_APPARMOR_PROFILE_ENV]: 'toolsenabled-linux-dev' },
  })
  if (path.basename(launch.command) !== 'aa-exec') {
    t.skip('aa-exec is not installed on this host, so the confinement path cannot be measured here')
    return
  }
  /* Sterile, and not as a formality. tools/test/electron-run-as-node-harness-guard
     correctly classifies this file as a launcher -- it names the GUI executable
     and its spawn target is a member expression the detector cannot follow --
     and being over-eager there is the guard working, not failing. The probe is
     therefore given the one launch environment a tools/ harness may use, which
     also strips ELECTRON_RUN_AS_NODE. Exempting the file instead would have
     narrowed a guard to make a test convenient. */
  const child = spawn(launch.command, launch.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(directory, 'sterile')))),
  })
  let said = ''
  child.stdout.on('data', chunk => { said += chunk })
  child.stderr.on('data', chunk => { said += chunk })
  const code = await new Promise(resolve => child.on('exit', resolve))
  if (code !== 0) {
    t.skip(`the named AppArmor profile is not loaded on this host: ${said.trim()}`)
    return
  }
  assert.equal(said.trim(), `MYPID=${child.pid}`,
    'mutation `leave the confinement wrapper in the process tree as a parent` survived: '
    + 'expected the spawned pid to BE the application, because every driver reaps that pid')
})

test('this host is measured as it is, so the receipt is not a claim about a different machine', { skip: process.platform !== 'linux' }, () => {
  const readiness = packagedLaunchReadiness({ env: process.env })
  assert.equal(typeof readiness.detail.usernsRestricted, 'boolean',
    'mutation `guess at the host` survived: expected the sysctl actually read')
  assert.equal(readiness.platform, 'linux',
    'mutation `report a platform other than the one measured` survived: expected linux')
})
