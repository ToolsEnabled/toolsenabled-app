/* THE FIX FOR THE REAL CRASH: Chrome's process-singleton socket needs a
 * short TMPDIR regardless of how deep the sterile scratch profile is.
 *
 * WHAT WAS WRONG, measured with strace against the real Electron/Chromium
 * binary, app.requestSingleInstanceLock() genuinely called (a synthetic
 * net.listen() on a constructed path proves only Node's own path handling,
 * not Chrome's -- the first two ad-hoc attempts that led to this fix never
 * called requestSingleInstanceLock at all, so no bind() ever happened and
 * their "successes" were meaningless). Chrome's ProcessSingleton::Create does
 * NOT bind its AF_UNIX socket under --user-data-dir: it creates a SHORT
 * scoped_dir under TMPDIR, binds the real socket there
 * (bind(sun_path="$TMPDIR/scoped_dirXXXXXX/SingletonSocket")), and only
 * symlinks <profile>/SingletonSocket to that short real path. Profile depth
 * was never the constraint; TMPDIR depth is. A deep TMPDIR with a SHORT
 * profile still crashed loud at
 * chrome/browser/process_singleton_posix.cc:315 ("Socket path too long"),
 * naming exactly $TMPDIR/scoped_dirXXXXXX/SingletonSocket; the same deep
 * profile with TMPDIR pointed at a verified /run/user/<uid> instead acquired
 * the singleton lock and bound the socket successfully.
 *
 * sterileLaunchEnvironment's own scratchRoot isolation (TEMP, TMP,
 * LOCALAPPDATA, APPDATA, USERPROFILE, CODEX_HOME) is unchanged by this fix
 * and stays under the caller's private per-run root -- this file's own
 * S-TMPDIR-1 test below asserts that alongside the short TMPDIR to prove
 * neither broke the other. Only TMPDIR gets a short, separately verified
 * directory: shortLinuxTmpdir() applies the exact ownership/mode/
 * not-a-symlink trust check owner-host-linux.js (engine repo) already
 * requires of its own socket directory before it will trust /run/user/<uid>,
 * and refuses outright -- STERILE_LAUNCH_NO_SHORT_TMPDIR -- only when
 * neither that nor a short ambient os.tmpdir() is available.
 *
 * Run: node --test tools/test/sterile-launch-short-tmpdir.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require_ = createRequire(import.meta.url)
const {
  prepareSterileProfile,
  providerAuthenticatedLaunchEnvironment,
  shortLinuxTmpdir,
  sterileLaunchEnvironment,
  sterileProfileDirectories,
} = require_('../lib/sterile-launch.cjs')

async function temporaryTree(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'sterile-tmpdir-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10 }))
  return root
}

// --- shortLinuxTmpdir's own branches, fully dependency-injected -----------

test('shortLinuxTmpdir trusts a verified /run/user/<uid>: private to this exact account, mode 0700, not a symlink', () => {
  const result = shortLinuxTmpdir({
    getuid: () => 424242,
    statSync: target => {
      if (target === '/run/user/424242') {
        return { isDirectory: () => true, isSymbolicLink: () => false, uid: 424242, mode: 0o40700 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  })
  assert.equal(result, '/run/user/424242')
})

test('shortLinuxTmpdir rejects a wrong-owner /run/user/<uid> and falls through to a short ambient tmpdir', () => {
  const result = shortLinuxTmpdir({
    getuid: () => 424243,
    statSync: target => {
      if (target === '/run/user/424243') {
        return { isDirectory: () => true, isSymbolicLink: () => false, uid: 1, mode: 0o40700 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    tmpdir: () => '/tmp',
  })
  assert.equal(result, '/tmp')
})

test('shortLinuxTmpdir rejects a world/group-writable /run/user/<uid> even when the owner matches', () => {
  const result = shortLinuxTmpdir({
    getuid: () => 424244,
    statSync: target => {
      if (target === '/run/user/424244') {
        return { isDirectory: () => true, isSymbolicLink: () => false, uid: 424244, mode: 0o40755 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    tmpdir: () => '/tmp',
  })
  assert.equal(result, '/tmp')
})

test('shortLinuxTmpdir rejects a /run/user/<uid> that is itself a symlink', () => {
  const result = shortLinuxTmpdir({
    getuid: () => 424245,
    statSync: target => {
      if (target === '/run/user/424245') {
        return { isDirectory: () => true, isSymbolicLink: () => true, uid: 424245, mode: 0o40700 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    tmpdir: () => '/tmp',
  })
  assert.equal(result, '/tmp')
})

test('shortLinuxTmpdir refuses, by name, when neither /run/user/<uid> nor the ambient tmpdir is short enough', () => {
  assert.throws(() => shortLinuxTmpdir({
    getuid: () => 424246,
    statSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    tmpdir: () => `/very/deep/ambient/scratch/root/${'x'.repeat(60)}`,
  }), error => error.code === 'STERILE_LAUNCH_NO_SHORT_TMPDIR')
})

test('shortLinuxTmpdir accepts a short ambient tmpdir with no uid available at all', () => {
  const result = shortLinuxTmpdir({ getuid: null, tmpdir: () => '/tmp' })
  assert.equal(result, '/tmp')
})

// --- integration: a deep scratch profile still gets a short TMPDIR --------

test('S-TMPDIR-1: sterileLaunchEnvironment gives Linux a short TMPDIR under a deliberately deep scratch profile, while every other home stays on it', async t => {
  const shallow = await temporaryTree(t)
  const deepRoot = path.join(shallow, 'toolsenabled-agent-api-deepscratch', 'launch-environment',
    'localappdata', 'ToolsEnabled-Live', 'a-realistically-long-generation-id-segment')
  const profile = prepareSterileProfile(sterileProfileDirectories(deepRoot))
  assert.ok(Buffer.byteLength(path.join(profile.temp, 'SingletonSocket'), 'utf8') >= 108,
    'the fixture must actually be deep enough to have crashed Chrome before this fix, or it proves nothing')

  const environment = sterileLaunchEnvironment(profile, { PATH: '/usr/bin:/bin' }, { platform: 'linux' })

  assert.equal(environment.TMPDIR, shortLinuxTmpdir())
  assert.ok(Buffer.byteLength(path.join(environment.TMPDIR, 'SingletonSocket'), 'utf8') < 108,
    'TMPDIR plus a SingletonSocket leaf must fit under sockaddr_un.sun_path')

  assert.equal(environment.TEMP, profile.temp)
  assert.equal(environment.TMP, profile.temp)
  assert.equal(environment.LOCALAPPDATA, profile.localAppData)
  assert.equal(environment.APPDATA, profile.appData)
  assert.equal(environment.USERPROFILE, profile.userProfile)
  assert.equal(environment.CODEX_HOME, profile.codexHome)
  assert.equal(environment.HOME, profile.userProfile)
  assert.equal(environment.XDG_DATA_HOME, profile.localAppData)
  assert.ok(profile.temp.startsWith(deepRoot), 'the deep scratch profile itself is unchanged by this fix')
})

test('S-TMPDIR-2: providerAuthenticatedLaunchEnvironment (the real caller run-agent-from-ui-smoke.cjs and page2-native-audit.cjs use) gives the same short TMPDIR under a deep scratchRoot', async t => {
  const shallow = await temporaryTree(t)
  const accountHome = path.join(shallow, 'account')
  const deepScratchRoot = path.join(shallow, 'toolsenabled-agent-api-abc123', 'launch-environment')
  const environment = providerAuthenticatedLaunchEnvironment(
    { accountHome, scratchRoot: deepScratchRoot },
    { PATH: '/usr/bin:/bin' },
    { platform: 'linux' },
  )
  assert.equal(environment.TMPDIR, shortLinuxTmpdir())
  assert.equal(environment.USERPROFILE, accountHome, 'the real account identity is still preserved, unrelated to this fix')
  assert.ok(environment.APPDATA.startsWith(deepScratchRoot), 'APPDATA stays on the deep per-run scratch root')
})
