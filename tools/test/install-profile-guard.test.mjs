import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const {
  ACCOUNT_ENVIRONMENT_CODE,
  CODE,
  DEV_RUNTIME_PROFILE_CODE,
  DEV_USER_DATA_CODE,
  ELEVATED_RUNTIME_CODE,
  INTEGRITY_UNAVAILABLE_CODE,
  canonicalWindowsPathThroughExistingAncestors,
  checkFencedDevUserDataDirectory,
  checkPackagedInstallProfile,
  checkRuntimeProfileOwner,
  checkWindowsRuntimeIntegrity,
  electronNodeHandoffEnvironment,
  ELEVATED_WARNING_KEY,
  elevatedRunWarning,
  fencedAccountEnvironment,
  profileRootFromEnvironment,
  profileRootFromInstallPath,
  profileRootFromWindowsUserPath,
  resolveWindowsShortPath,
  trustedProfileShortAliasRoot,
  windowsProfileReferences,
} = require_(path.join(ROOT, 'shell', 'install-profile-guard.cjs'))
const {
  prepareSterileProfile,
  qaProfileDirectories,
  sterileLaunchEnvironment,
} = require_(path.join(ROOT, 'tools', 'lib', 'sterile-launch.cjs'))

const HARNESS_PROFILE_ROOT = mkdtempSync(path.join(tmpdir(), 'install-profile-guard-'))
const HARNESS_PROFILE = prepareSterileProfile(qaProfileDirectories(HARNESS_PROFILE_ROOT))

after(() => {
  rmSync(HARNESS_PROFILE_ROOT, { recursive: true, force: true })
})

function sterileHarnessEnvironment(overrides = {}) {
  return sterileLaunchEnvironment(HARNESS_PROFILE, {
    ...process.env,
    ...overrides,
  })
}

const identityRealpath = value => value

function check(overrides = {}) {
  return checkPackagedInstallProfile({
    isPackaged: true,
    platform: 'win32',
    execPath: String.raw`${"\x43:\\Users\\fixture-profile\\AppData\\Local\\Programs\\toolsenabled\\ToolsEnabled.exe"}`,
    currentProfilePath: String.raw`${"\x43:\\Users\\fixture-profile"}`,
    env: {
      USERPROFILE: String.raw`${"\x43:\\Users\\fixture-profile"}`,
      LOCALAPPDATA: String.raw`${"\x43:\\Users\\fixture-profile\\AppData\\Local"}`,
    },
    homedir: () => String.raw`${"\x43:\\Users\\fixture-profile"}`,
    realpath: identityRealpath,
    ...overrides,
  })
}

test('a packaged per-user install starts under the profile that owns it', () => {
  const result = check()
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'same-profile')
})

test('Windows path case does not manufacture a cross-profile mismatch', () => {
  const result = check({
    execPath: String.raw`${"\x63:\\users\\fixture-profile\\appdata\\local\\programs\\ToolsEnabled\\ToolsEnabled.exe"}`,
  })
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'same-profile')
})

test('a packaged per-user install refuses a different current profile with actionable copy', () => {
  const result = check({
    currentProfilePath: String.raw`${"\x43:\\Users\\OtherAccount"}`,
    env: {
      USERPROFILE: String.raw`${"\x43:\\Users\\OtherAccount"}`,
      LOCALAPPDATA: String.raw`${"\x43:\\Users\\OtherAccount\\AppData\\Local"}`,
    },
    homedir: () => String.raw`${"\x43:\\Users\\OtherAccount"}`,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, CODE)
  assert.equal(result.installProfile, String.raw`${"\x43:\\Users\\fixture-profile"}`)
  assert.equal(result.currentProfile, String.raw`${"\x43:\\Users\\OtherAccount"}`)
  assert.match(result.message, /installed for the Windows account "fixture-profile"/)
  assert.match(result.message, /running as "OtherAccount"/)
  assert.match(result.message, /launch ToolsEnabled normally while signed in as "fixture-profile"/)
  assert.match(result.message, /Do not run the whole ToolsEnabled app as Administrator/)
  assert.match(result.message, /approve only that specific helper prompt/)
})

test('the current-user known folder outranks an inherited environment block', () => {
  const result = check({
    currentProfilePath: String.raw`${"\x43:\\Users\\OtherAccount"}`,
    // An alternate-account elevation may retain the launching account's
    // variables. They are not proof of the token that now owns the process.
    env: {
      USERPROFILE: String.raw`${"\x43:\\Users\\fixture-profile"}`,
      LOCALAPPDATA: String.raw`${"\x43:\\Users\\fixture-profile\\AppData\\Local"}`,
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.installProfile, String.raw`${"\x43:\\Users\\fixture-profile"}`)
  assert.equal(result.currentProfile, String.raw`${"\x43:\\Users\\OtherAccount"}`)
})

test('a foreign current profile is refused lexically without a filesystem probe', () => {
  const probed = []
  const result = check({
    currentProfilePath: String.raw`${"\x43:\\Users\\OtherAccount"}`,
    realpath(value) {
      probed.push(value)
      assert.equal(value, String.raw`${"\x43:\\Users\\fixture-profile\\AppData\\Local\\Programs\\toolsenabled\\ToolsEnabled.exe"}`)
      return value
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.currentProfile, String.raw`${"\x43:\\Users\\OtherAccount"}`)
  assert.deepEqual(probed, [])
})

test('environment and homedir profile fallbacks stay lexical', () => {
  let homedirCalls = 0
  const fromEnvironment = profileRootFromEnvironment({
    USERPROFILE: String.raw`${"\x43:\\Users\\OtherAccount"}`,
  }, () => {
    homedirCalls += 1
    return String.raw`${"\x43:\\Users\\FallbackAccount"}`
  })
  assert.equal(fromEnvironment, String.raw`${"\x43:\\Users\\OtherAccount"}`)
  assert.equal(homedirCalls, 0)
})

test('development and fixture launches remain allowed regardless of executable path', () => {
  const result = check({
    isPackaged: false,
    env: { USERPROFILE: String.raw`${"\x43:\\Users\\OtherAccount"}` },
  })
  assert.deepEqual(result, { ok: true, reason: 'development-or-test' })
})

test('non-Windows and non-per-user packaged layouts are outside this guard', () => {
  assert.deepEqual(check({ platform: 'linux' }), { ok: true, reason: 'non-windows' })
  assert.deepEqual(check({ execPath: String.raw`${"\x43:\\Program Files\\ToolsEnabled\\ToolsEnabled.exe"}` }), {
    ok: true,
    reason: 'not-a-per-user-install',
  })
})

test('LOCALAPPDATA and homedir provide bounded fallbacks when USERPROFILE is absent', () => {
  assert.equal(profileRootFromEnvironment({
    LOCALAPPDATA: String.raw`${"\x44:\\Profiles\\Worker\\AppData\\Local"}`,
  }, () => String.raw`${"\x44:\\fallback"}`, identityRealpath), String.raw`${"\x44:\\Profiles\\Worker"}`)

  assert.equal(profileRootFromEnvironment({}, () => String.raw`${"\x45:\\Accounts\\Worker"}`, identityRealpath), String.raw`${"\x45:\\Accounts\\Worker"}`)
})

test('the install owner is derived only from the complete per-user Programs boundary', () => {
  assert.equal(profileRootFromInstallPath(
    String.raw`${"\x44:\\Profiles\\Worker\\AppData\\Local\\Programs\\ToolsEnabled\\ToolsEnabled.exe"}`,
    identityRealpath,
  ), String.raw`${"\x44:\\Profiles\\Worker"}`)
  assert.equal(profileRootFromInstallPath(
    String.raw`${"\x44:\\Profiles\\Worker\\AppData\\Local\\ProgramsElsewhere\\ToolsEnabled.exe"}`,
    identityRealpath,
  ), null)
})

test('a staged/runtime path derives its Windows profile without a shipped account literal', () => {
  assert.equal(profileRootFromWindowsUserPath(
    String.raw`${"\x58:\\Users\\ReleaseWorker\\Desktop\\work\\app\\shell\\main.cjs"}`,
  ), String.raw`${"\x58:\\Users\\ReleaseWorker"}`)
  assert.equal(profileRootFromWindowsUserPath(String.raw`${"\x58:\\Program Files\\ToolsEnabled\\ToolsEnabled.exe"}`), null)
})

test('a profile-owned development runtime refuses a different Windows identity without filesystem discovery', () => {
  const result = checkRuntimeProfileOwner({
    platform: 'win32',
    runtimePaths: [
      String.raw`${"\x43:\\Users\\fixture-profile\\Desktop\\WorkingFolder\\app\\shell"}`,
      String.raw`${"\x43:\\Users\\fixture-profile\\Desktop\\WorkingFolder\\app\\node_modules\\electron\\electron.exe"}`,
    ],
    currentProfilePath: String.raw`${"\x43:\\Users\\AnotherAccount"}`,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DEV_RUNTIME_PROFILE_MISMATCH')
  assert.equal(result.runtimeProfile, String.raw`${"\x43:\\Users\\fixture-profile"}`)
  assert.doesNotMatch(result.message, /WorkingFolder|node_modules|electron\.exe/i)
})

test('a mixed runtime refuses when its source and executable belong to different Windows profiles', () => {
  const result = checkRuntimeProfileOwner({
    platform: 'win32',
    runtimePaths: [
      String.raw`${"\x43:\\Users\\fixture-profile\\Desktop\\WorkingFolder\\app\\shell"}`,
      String.raw`${"\x43:\\Users\\Synthetic-Foreign\\Desktop\\runtime\\electron.exe"}`,
    ],
    currentProfilePath: String.raw`${"\x43:\\Users\\fixture-profile"}`,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, DEV_RUNTIME_PROFILE_CODE)
  assert.equal(result.runtimeProfile, String.raw`${"\x43:\\Users\\fixture-profile"}`)
  assert.doesNotMatch(result.message, /Synthetic-Foreign|WorkingFolder|electron\.exe/i)
})

test('a profile-owned development runtime accepts its owner and portable system bytes remain account-neutral', () => {
  const owned = checkRuntimeProfileOwner({
    platform: 'win32',
    runtimePaths: [String.raw`${"\x43:\\Users\\fixture-profile\\Desktop\\WorkingFolder\\app\\shell"}`],
    currentProfilePath: String.raw`${"\x63:\\users\\fixture-profile"}`,
  })
  assert.equal(owned.ok, true)
  assert.equal(owned.runtimeProfile, String.raw`${"\x43:\\Users\\fixture-profile"}`)

  const portable = checkRuntimeProfileOwner({
    platform: 'win32',
    runtimePaths: [String.raw`${"\x44:\\Programs\\ToolsEnabled\\ToolsEnabled.exe"}`],
    currentProfilePath: String.raw`${"\x43:\\Users\\AnyAccount"}`,
  })
  assert.equal(portable.ok, true)
  assert.equal(portable.reason, 'runtime-outside-profile')
  assert.equal(portable.runtimeProfile, null)
})

test('a redirected Windows profile owns staged bytes without assuming the Users directory or drive casing', () => {
  for (const [currentProfilePath, runtimePaths] of [
    [
      String.raw`${"\x44:\\Profiles\\Alice"}`,
      [
        String.raw`${"\x44:\\Profiles\\Alice\\Desktop\\ToolsEnabled\\resources\\app.asar\\shell"}`,
        String.raw`${"\x64:\\profiles\\ALICE\\Desktop\\ToolsEnabled\\ToolsEnabled.exe"}`,
      ],
    ],
    [
      String.raw`${"\x63:\\profiles\\ALICE"}`,
      [String.raw`${"\x43:\\Profiles\\Alice\\Desktop\\ToolsEnabled\\ToolsEnabled.exe"}`],
    ],
  ]) {
    const result = checkRuntimeProfileOwner({
      platform: 'win32',
      runtimePaths,
      currentProfilePath,
      requireBoundProfile: true,
    })
    assert.equal(result.ok, true, `${currentProfilePath}: ${result.message || result.reason}`)
    assert.ok(result.runtimeProfile)
    assert.equal(result.runtimeProfile.toLowerCase(), currentProfilePath.toLowerCase())
  }
})

test('a redirected profile anchor still refuses sibling-profile and mixed runtime bytes', () => {
  for (const runtimePaths of [
    [String.raw`${"\x44:\\Profiles\\Bob\\Desktop\\ToolsEnabled\\ToolsEnabled.exe"}`],
    [
      String.raw`${"\x44:\\Profiles\\Alice\\Desktop\\ToolsEnabled\\resources\\app.asar\\shell"}`,
      String.raw`${"\x44:\\Profiles\\Bob\\Desktop\\ToolsEnabled\\ToolsEnabled.exe"}`,
    ],
  ]) {
    const result = checkRuntimeProfileOwner({
      platform: 'win32',
      runtimePaths,
      currentProfilePath: String.raw`${"\x44:\\Profiles\\Alice"}`,
      requireBoundProfile: true,
    })
    assert.equal(result.ok, false, runtimePaths.join(';'))
    assert.equal(result.code, DEV_RUNTIME_PROFILE_CODE)
  }
})

test('a shipped or staged runtime can require an owner and then refuses portable account adoption', () => {
  const result = checkRuntimeProfileOwner({
    platform: 'win32',
    runtimePaths: [String.raw`${"\x44:\\Portable\\ToolsEnabled\\resources\\app.asar\\shell"}`, String.raw`${"\x44:\\Portable\\ToolsEnabled\\ToolsEnabled.exe"}`],
    currentProfilePath: String.raw`${"\x43:\\Users\\ReleaseWorker"}`,
    requireBoundProfile: true,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, DEV_RUNTIME_PROFILE_CODE)
  assert.equal(result.runtimeProfile, null)
  assert.match(result.message, /copied portable runtime is not an installed ToolsEnabled identity/i)
})

test('Windows runtime integrity distinguishes an ordinary token from same-account elevation', () => {
  const calls = []
  const run = (executable, args, options) => {
    calls.push({ executable, args, options })
    return { status: 0, stdout: '"Mandatory Label\\Medium Mandatory Level","S-1-16-8192","Mandatory group"\r\n' }
  }
  assert.deepEqual(checkWindowsRuntimeIntegrity({ platform: 'win32', spawnSync: run }), {
    ok: true,
    elevated: false,
    reason: 'ordinary-windows-token',
  })
  assert.equal(elevatedRunWarning({ ok: true, elevated: false, reason: 'ordinary-windows-token' }), null, 'an ordinary token gets no warning')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].executable, String.raw`\\.\GLOBALROOT\SystemRoot\System32\whoami.exe`)
  assert.deepEqual(calls[0].args, ['/groups', '/fo', 'csv', '/nh'])
  assert.equal(calls[0].options.windowsHide, true)
})

test('high and system integrity tokens are measured and warned about, never refused', () => {
  /* Owner, 2026-09-02: "the whole point of this software is the user decides
     and we give them the choice ... we can warn them, and a check box not to
     warn again". The launch goes on; the words are the warning's. */
  for (const sid of ['S-1-16-12288', 'S-1-16-16384']) {
    const result = checkWindowsRuntimeIntegrity({
      platform: 'win32',
      spawnSync: () => ({ status: 0, stdout: `"label","${sid}","group"` }),
    })
    assert.equal(result.ok, true, sid)
    assert.equal(result.elevated, true, sid)
    assert.equal(result.code, ELEVATED_RUNTIME_CODE, sid)
    assert.match(result.message, /administrator rights/i)
    const words = elevatedRunWarning(result)
    assert.equal(words.title, 'Running as administrator')
    assert.equal(words.message, result.message)
    assert.match(words.detail, /close it and open it normally/i)
    assert.equal(words.checkboxLabel, 'Do not warn me again')
    for (const sentence of [words.message, ...words.detail.split(/(?<=\.)\s+/)]) {
      assert.ok(sentence.split(/\s+/).length < 25, `plain sentence: ${sentence}`)
    }
  }
  assert.equal(ELEVATED_WARNING_KEY, 'mc.warn.elevated-run')
})

test('an unavailable or unparseable integrity probe says nothing either way and never stops the launch', () => {
  for (const run of [
    () => { throw new Error('probe unavailable') },
    () => ({ status: 1, stdout: '' }),
    () => ({ status: 0, stdout: 'no mandatory integrity SID here' }),
  ]) {
    const result = checkWindowsRuntimeIntegrity({ platform: 'win32', spawnSync: run })
    assert.equal(result.ok, true)
    assert.equal(result.elevated, null)
    assert.equal(result.code, INTEGRITY_UNAVAILABLE_CODE)
    assert.equal(elevatedRunWarning(result), null, 'nothing measured, nothing said')
  }
  assert.deepEqual(checkWindowsRuntimeIntegrity({ platform: 'linux' }), { ok: true, reason: 'non-windows' })
  assert.equal(elevatedRunWarning(null), null)
})

test('runtime identity rejects namespace aliases before attempting to discover an owner', () => {
  for (const runtimePath of [
    String.raw`\\server\share\ToolsEnabled\shell`,
    String.raw`${"\\\\?\\\x43:\\Users\\fixture-profile\\Desktop\\app\\shell"}`,
    String.raw`\Device\HarddiskVolume4\Users\fixture-profile\Desktop\app\shell`,
  ]) {
    const result = checkRuntimeProfileOwner({
      platform: 'win32',
      runtimePaths: [runtimePath],
      currentProfilePath: String.raw`${"\x43:\\Users\\fixture-profile"}`,
    })
    assert.equal(result.ok, false, runtimePath)
    assert.equal(result.code, 'DEV_RUNTIME_PROFILE_MISMATCH', runtimePath)
  }
})

test('the trusted alias resolver receives only the authorized long profile and accepts its exact alias root', () => {
  const fence = String.raw`${"\x58:\\Users\\ReleaseWorker"}`
  const calls = []
  const alias = trustedProfileShortAliasRoot(fence, {
    platform: 'win32',
    resolveShortPath(value) {
      calls.push(value)
      return String.raw`${"\x58:\\Users\\RELEAS~1"}`
    },
  })
  assert.equal(alias, String.raw`${"\x58:\\Users\\RELEAS~1"}`)
  assert.deepEqual(calls, [fence], 'alias discovery examined something other than the trusted long profile')
})

test('trusted alias discovery fails closed on unchanged, malformed, or wrong-parent answers', () => {
  const fence = String.raw`${"\x58:\\Users\\ReleaseWorker"}`
  for (const answer of [
    fence,
    String.raw`${"\x58:\\Users\\Another"}`,
    String.raw`${"\x58:\\Profiles\\RELEAS~1"}`,
    String.raw`${"\x58:\\Users\\OTHER~1\\child"}`,
    String.raw`${"\x58:\\Users\\RELEA~100"}`,
    null,
  ]) {
    assert.equal(trustedProfileShortAliasRoot(fence, {
      platform: 'win32',
      resolveShortPath: () => answer,
    }), null, `trusted an invalid resolver answer: ${answer}`)
  }
})

test('a portable runtime volume cannot launch a planted command or authorize its forged alias', () => {
  const fence = String.raw`${"\x43:\\Users\\ReleaseWorker"}`
  const hostileAlias = String.raw`${"\x43:\\Users\\OTHER~1"}`
  const trustedAlias = String.raw`${"\x43:\\Users\\RELEAS~1"}`
  const calls = []
  const alias = trustedProfileShortAliasRoot(fence, {
    platform: 'win32',
    resolveShortPath(value) {
      return resolveWindowsShortPath(value, {
        platform: 'win32',
        runtimeExecutablePath: String.raw`${"\x58:\\Portable\\ToolsEnabled.exe"}`,
        environment: sterileHarnessEnvironment({
          SystemRoot: String.raw`${"\x58:\\AttackerControlled"}`,
          ComSpec: String.raw`${"\x58:\\AttackerControlled\\cmd.exe"}`,
          PATH: String.raw`${"\x58:\\AttackerControlled"}`,
        }),
        spawnSync(command, argv, options) {
          calls.push({ command, argv, options })
          return command.toLowerCase() === String.raw`${"\x58:\\Windows\\System32\\cmd.exe"}`.toLowerCase()
            ? { status: 0, stdout: `${hostileAlias}\r\n` }
            : { status: 0, stdout: `${trustedAlias}\r\n` }
        },
      })
    },
  })
  assert.equal(alias, trustedAlias)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, String.raw`\\.\GLOBALROOT\SystemRoot\System32\cmd.exe`)
  assert.notEqual(calls[0].command.toLowerCase(), String.raw`${"\x58:\\Windows\\System32\\cmd.exe"}`.toLowerCase())
  assert.deepEqual(calls[0].options.env, { TOOLSENABLED_TRUSTED_LONG_PROFILE: fence })
  assert.equal(calls[0].options.windowsVerbatimArguments, true)
  assert.deepEqual(calls[0].argv, [
    '/d', '/s', '/v:off', '/e:on', '/c', 'for %I in ("%TOOLSENABLED_TRUSTED_LONG_PROFILE%") do @echo("%~sI"',
  ])

  const hostileUserData = `${hostileAlias}\\AppData\\Local\\Temp\\qa\\userdata`
  const touched = []
  const result = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: ['ToolsEnabled.exe', `--user-data-dir=${hostileUserData}`],
    commandLineUserDataPath: hostileUserData,
    cwd: String.raw`${"\x58:\\Portable"}`,
    userDataPath: hostileUserData,
    runtimePaths: [String.raw`${"\x58:\\Portable\\ToolsEnabled.exe"}`],
    fencedProfile: fence,
    trustedProfileAliasRoot: alias,
    filesystem: {
      lstatSync(candidate) { touched.push(candidate); throw new Error('must not probe') },
      readlinkSync(candidate) { touched.push(candidate); throw new Error('must not probe') },
    },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(touched, [])
})

test('cmd metacharacters in a custom profile parent remain quoted data during alias discovery', () => {
  const fence = String.raw`${"\x44:\\Profiles & echo SHOULD_NOT_RUN!^%\\ReleaseWorker"}`
  const alias = String.raw`${"\x44:\\Profiles & echo SHOULD_NOT_RUN!^%\\RELEAS~1"}`
  let calls = 0
  const resolved = trustedProfileShortAliasRoot(fence, {
    platform: 'win32',
    resolveShortPath(value) {
      return resolveWindowsShortPath(value, {
        platform: 'win32',
        environment: sterileHarnessEnvironment(),
        spawnSync(command, argv, options) {
          calls += 1
          assert.equal(command, String.raw`\\.\GLOBALROOT\SystemRoot\System32\cmd.exe`)
          assert.deepEqual(argv.slice(0, -1), ['/d', '/s', '/v:off', '/e:on', '/c'])
          assert.equal(argv.at(-1), 'for %I in ("%TOOLSENABLED_TRUSTED_LONG_PROFILE%") do @echo("%~sI"')
          const expansionAt = argv.at(-1).indexOf('%~sI')
          assert.equal(argv.at(-1)[expansionAt - 1], '"')
          assert.equal(argv.at(-1)[expansionAt + '%~sI'.length], '"')
          assert.deepEqual(options.env, { TOOLSENABLED_TRUSTED_LONG_PROFILE: fence })
          assert.equal(options.windowsVerbatimArguments, true)
          return { status: 0, stdout: `"${alias}"\r\n` }
        },
      })
    },
  })
  assert.equal(resolved, alias)
  assert.equal(calls, 1)
})

test('unsupported Windows device namespaces refuse through the full guard chain without probes or spawns', () => {
  const fence = String.raw`${"\x43:\\Users\\ReleaseWorker"}`
  const namespaces = [
    String.raw`\\.\GLOBALROOT\Device\HarddiskVolume9\Users\Another\state`,
    String.raw`\\?\GLOBALROOT\Device\HarddiskVolume9\Users\Another\state`,
    String.raw`\Device\HarddiskVolume9\Users\Another\state`,
    String.raw`${"\\??\\\x43:\\Users\\Another\\state"}`,
  ]

  for (const candidate of namespaces) {
    let spawns = 0
    assert.equal(resolveWindowsShortPath(candidate, {
      platform: 'win32',
      environment: sterileHarnessEnvironment(),
      spawnSync() { spawns += 1; return { status: 0, stdout: '' } },
    }), null)
    assert.equal(spawns, 0, `the alias resolver spawned for ${candidate}`)

    let lstats = 0
    let readlinks = 0
    const filesystem = {
      lstatSync() { lstats += 1; return { isSymbolicLink: () => false } },
      readlinkSync() { readlinks += 1; return String.raw`${"\x43:\\Users\\Another"}` },
    }
    assert.equal(canonicalWindowsPathThroughExistingAncestors(candidate, filesystem), null)
    for (const name of ['USERPROFILE', 'TEMP', 'PATH']) {
      const environment = fencedAccountEnvironment({
        platform: 'win32',
        fencedProfile: fence,
        cwd: String.raw`${"\x44:\\Portable"}`,
        environment: { [name]: candidate },
        filesystem,
      })
      assert.equal(environment.ok, false)
      assert.ok(environment.variables.includes(name))
    }
    const unfencedEnvironment = fencedAccountEnvironment({
      platform: 'win32',
      fencedProfile: null,
      environment: { PATH: candidate },
      filesystem,
    })
    assert.equal(unfencedEnvironment.ok, false)
    assert.ok(unfencedEnvironment.variables.includes('PATH'))

    const userData = checkFencedDevUserDataDirectory({
      platform: 'win32',
      argv: ['ToolsEnabled.exe', `--user-data-dir=${candidate}`],
      commandLineUserDataPath: candidate,
      cwd: String.raw`${"\x44:\\Portable"}`,
      userDataPath: candidate,
      runtimePaths: [String.raw`${"\x44:\\Portable\\ToolsEnabled.exe"}`],
      fencedProfile: fence,
      filesystem,
    })
    assert.equal(userData.ok, false)
    assert.equal(userData.code, DEV_USER_DATA_CODE)
    assert.equal(lstats, 0, `the guards probed ${candidate}`)
    assert.equal(readlinks, 0, `the guards followed ${candidate}`)
  }
})

test('generic UNC inputs refuse through every path-bearing guard before probes or spawns', () => {
  const fence = String.raw`${"\x43:\\Users\\ReleaseWorker"}`
  const safeCwd = `${fence}\\project`
  const safeUserData = `${fence}\\AppData\\Roaming\\ToolsEnabled`
  const safeRuntime = `${fence}\\AppData\\Local\\Programs\\toolsenabled\\ToolsEnabled.exe`
  const candidates = [
    String.raw`\\localhost\OtherProfileShare\bin`,
    String.raw`//localhost/OtherProfileShare/bin`,
    String.raw`"\\localhost\Other Profile Share\bin"`,
  ]

  for (const candidate of candidates) {
    let spawns = 0
    let lstats = 0
    let readlinks = 0
    const filesystem = {
      lstatSync() { lstats += 1; return { isSymbolicLink: () => false } },
      readlinkSync() { readlinks += 1; return String.raw`${"\x43:\\Users\\Another"}` },
    }

    assert.equal(resolveWindowsShortPath(candidate, {
      platform: 'win32',
      environment: sterileHarnessEnvironment(),
      spawnSync() { spawns += 1; return { status: 0, stdout: '' } },
    }), null)
    assert.equal(canonicalWindowsPathThroughExistingAncestors(candidate, filesystem), null)

    const baseEnvironment = {
      USERPROFILE: fence,
      HOME: fence,
      APPDATA: `${fence}\\AppData\\Roaming`,
      LOCALAPPDATA: `${fence}\\AppData\\Local`,
      HOMEDRIVE: 'C:',
      HOMEPATH: String.raw`\Users\ReleaseWorker`,
      TEMP: `${fence}\\AppData\\Local\\Temp`,
      TMP: `${fence}\\AppData\\Local\\Temp`,
      PATH: String.raw`${"\x43:\\Windows\\System32"}`,
    }

    for (const name of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
      const result = fencedAccountEnvironment({
        platform: 'win32',
        fencedProfile: fence,
        cwd: safeCwd,
        environment: { ...baseEnvironment, [name]: candidate },
        filesystem,
      })
      assert.equal(result.ok, false, `${name} accepted ${candidate}`)
      assert.ok(result.variables.includes(name), `${name} did not name its UNC refusal`)
    }

    const pathResult = fencedAccountEnvironment({
      platform: 'win32',
      fencedProfile: fence,
      cwd: safeCwd,
      environment: { ...baseEnvironment, PATH: `${baseEnvironment.PATH};${candidate}` },
      filesystem,
    })
    assert.equal(pathResult.ok, false)
    assert.ok(pathResult.variables.includes('PATH'))

    for (const homeOverride of [
      { HOMEDRIVE: candidate },
      { HOMEPATH: candidate },
    ]) {
      const result = fencedAccountEnvironment({
        platform: 'win32',
        fencedProfile: fence,
        cwd: safeCwd,
        environment: { ...baseEnvironment, ...homeOverride },
        filesystem,
      })
      assert.equal(result.ok, false)
      assert.ok(result.variables.includes('HOMEDRIVE/HOMEPATH'))
    }

    for (const guardOverride of [
      { fencedProfile: candidate },
      { trustedProfileAliasRoot: candidate },
      { cwd: candidate },
    ]) {
      const result = fencedAccountEnvironment({
        platform: 'win32',
        fencedProfile: fence,
        cwd: safeCwd,
        environment: baseEnvironment,
        filesystem,
        ...guardOverride,
      })
      assert.equal(result.ok, false)
      assert.equal(result.code, ACCOUNT_ENVIRONMENT_CODE)
    }

    const unfenced = fencedAccountEnvironment({
      platform: 'win32',
      fencedProfile: null,
      environment: { PATH: candidate },
      filesystem,
    })
    assert.equal(unfenced.ok, false)
    assert.ok(unfenced.variables.includes('PATH'))

    const userDataCases = [
      { argv: ['ToolsEnabled.exe', '--user-data-dir', candidate] },
      { commandLineUserDataPath: candidate },
      { cwd: candidate },
      { userDataPath: candidate },
      { runtimePaths: [candidate] },
      { fencedProfile: candidate },
      { trustedProfileAliasRoot: candidate },
    ]
    for (const overrides of userDataCases) {
      const result = checkFencedDevUserDataDirectory({
        platform: 'win32',
        argv: ['ToolsEnabled.exe'],
        commandLineUserDataPath: null,
        cwd: safeCwd,
        userDataPath: safeUserData,
        runtimePaths: [safeRuntime],
        fencedProfile: fence,
        trustedProfileAliasRoot: null,
        filesystem,
        ...overrides,
      })
      assert.equal(result.ok, false, `the userData guard accepted ${candidate}`)
      assert.equal(result.code, DEV_USER_DATA_CODE)
    }

    const packaged = check({ execPath: candidate })
    assert.equal(packaged.ok, false)
    assert.equal(packaged.code, CODE)
    assert.equal(spawns, 0, `the alias resolver spawned for ${candidate}`)
    assert.equal(lstats, 0, `a guard probed ${candidate}`)
    assert.equal(readlinks, 0, `a guard followed ${candidate}`)
  }
})

test('local admin-share profile spelling remains recognizable while generic UNC still refuses before access', () => {
  const fence = String.raw`${"\x43:\\Users\\fixture-profile"}`
  const other = String.raw`${"\x43:\\Users\\OtherAccount"}`
  const adminShare = String.raw`\\localhost\C$\Users\OtherAccount\AppData\Local`
  assert.deepEqual(windowsProfileReferences(adminShare, fence), [other])

  let probes = 0
  const result = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: fence,
    environment: { PATH: adminShare },
    filesystem: {
      lstatSync() { probes += 1; return { isSymbolicLink: () => false } },
      readlinkSync() { probes += 1; return other },
    },
  })
  assert.equal(result.ok, false)
  assert.ok(result.variables.includes('PATH'))
  assert.equal(probes, 0)
})

test('quoted device namespaces and namespace runtime paths fail closed before filesystem access', () => {
  const fence = String.raw`${"\x43:\\Users\\ReleaseWorker"}`
  const devicePath = String.raw`${"\"\\\\?\\\x43:\\Users\\Another\\state\""}`
  let probes = 0
  const result = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: ['ToolsEnabled.exe', '--user-data-dir=\x44:\\PortableData'],
    userDataPath: String.raw`${"\x44:\\PortableData"}`,
    runtimePaths: [devicePath],
    fencedProfile: fence,
    filesystem: {
      lstatSync() { probes += 1; return { isSymbolicLink: () => false } },
      readlinkSync() { probes += 1; return String.raw`${"\x43:\\Users\\Another"}` },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, DEV_USER_DATA_CODE)
  assert.equal(probes, 0)
})

test('packaged installs refuse unknown identity and never trust inherited profile fallbacks', () => {
  const unknown = check({
    currentProfilePath: null,
    env: {
      USERPROFILE: String.raw`${"\x43:\\Users\\fixture-profile"}`,
      LOCALAPPDATA: String.raw`${"\x43:\\Users\\fixture-profile\\AppData\\Local"}`,
    },
    homedir: () => String.raw`${"\x43:\\Users\\fixture-profile"}`,
  })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, CODE)
  assert.equal(unknown.currentProfile, null)
  assert.match(unknown.message, /Windows did not identify the account running it/)

  const customRoot = check({
    execPath: String.raw`${"\x44:\\Profiles\\Worker\\AppData\\Local\\Programs\\toolsenabled\\ToolsEnabled.exe"}`,
    currentProfilePath: null,
    env: { USERPROFILE: String.raw`${"\x44:\\Profiles\\Worker"}` },
  })
  assert.equal(customRoot.ok, false)
  assert.equal(customRoot.installProfile, String.raw`${"\x44:\\Profiles\\Worker"}`)
})

test('apostrophes remain part of a Windows profile component and are refused before probing', () => {
  const fence = String.raw`${"\x43:\\Users\\O"}`
  const foreign = String.raw`${"\x43:\\Users\\O'Brien"}`
  assert.deepEqual(windowsProfileReferences(`${foreign}\\AppData\\Local`, fence), [foreign])

  const touched = []
  const result = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: ['ToolsEnabled.exe', '--user-data-dir', `${foreign}\\AppData\\Local\\Temp\\qa`],
    cwd: String.raw`${"\x43:\\Program Files\\ToolsEnabled"}`,
    userDataPath: `${foreign}\\AppData\\Local\\Temp\\qa`,
    runtimePaths: [String.raw`${"\x43:\\Program Files\\ToolsEnabled\\ToolsEnabled.exe"}`],
    fencedProfile: fence,
    filesystem: {
      lstatSync(candidate) { touched.push(candidate); throw new Error('must not probe') },
      readlinkSync(candidate) { touched.push(candidate); throw new Error('must not probe') },
    },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(touched, [])
})

test('the fenced Dev runtime accepts explicit scratch userData only inside fixture-profile', () => {
  const result = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: ['ToolsEnabled.exe', '--user-data-dir', String.raw`${"\x43:\\Users\\fixture-profile\\AppData\\Local\\Temp\\qa-profile\\userdata"}`],
    cwd: String.raw`${"\x43:\\Users\\fixture-profile\\Desktop\\WorkingFolder\\app-reconciled"}`,
    userDataPath: String.raw`${"\x43:\\Users\\fixture-profile\\AppData\\Local\\Temp\\qa-profile\\userdata"}`,
    runtimePaths: [String.raw`${"\x43:\\Users\\fixture-profile\\Desktop\\WorkingFolder\\app-reconciled\\node_modules\\electron\\electron.exe"}`],
  })
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'inside-fenced-dev-profile')
})

test('a staged short-alias runtime maps argv, command-line and resolved userData descendants to the long fence', () => {
  const fence = String.raw`${"\x43:\\Users\\fixture-profile"}`
  const aliasTemp = String.raw`${"\x43:\\Users\\TOOLSE~1\\AppData\\Local\\Temp"}`
  const longTemp = `${fence}\\AppData\\Local\\Temp`
  const staged = `${aliasTemp}\\agent-start-flow\\source-overlay`
  const expectedUserData = `${longTemp}\\agent-start-flow\\userdata-resolved`
  const touched = []
  const result = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: [
      `${staged}\\node_modules\\electron\\dist\\electron.exe`,
      `--user-data-dir=${aliasTemp}\\agent-start-flow\\userdata-argv`,
      '--user-data-dir',
      String.raw`..\userdata-relative`,
    ],
    commandLineUserDataPath: `${aliasTemp}\\agent-start-flow\\userdata-command-line`,
    cwd: `${staged}\\app`,
    userDataPath: `${aliasTemp}\\agent-start-flow\\userdata-resolved`,
    runtimePaths: [
      `${staged}\\node_modules\\electron\\dist\\electron.exe`,
      `${staged}\\shell`,
    ],
    fencedProfile: fence,
    trustedProfileAliasRoot: String.raw`${"\x43:\\Users\\TOOLSE~1"}`,
    filesystem: {
      lstatSync(candidate) {
        touched.push(candidate)
        assert.doesNotMatch(candidate, /~/, `the userData guard probed the short alias: ${candidate}`)
        const error = new Error('missing synthetic long-path leaf'); error.code = 'ENOENT'; throw error
      },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'inside-fenced-dev-profile')
  assert.equal(result.userDataPath, expectedUserData)
  assert.doesNotMatch(JSON.stringify(result), /TOOLSE~1/i)
  assert.ok(touched.length > 0)
})

test('an untrusted short-alias runtime is refused without probing or rewriting it', () => {
  const fence = String.raw`${"\x43:\\Users\\fixture-profile"}`
  const hostileTemp = String.raw`${"\x43:\\Users\\OTHER~1\\AppData\\Local\\Temp"}`
  const touched = []
  const result = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: ['electron.exe', `--user-data-dir=${hostileTemp}\\qa\\userdata`],
    commandLineUserDataPath: `${hostileTemp}\\qa\\userdata`,
    cwd: `${hostileTemp}\\qa`,
    userDataPath: `${hostileTemp}\\qa\\userdata`,
    runtimePaths: [`${hostileTemp}\\qa\\electron.exe`],
    fencedProfile: fence,
    filesystem: {
      lstatSync(candidate) {
        touched.push(candidate)
        throw new Error(`the guard probed untrusted alias text: ${candidate}`)
      },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, DEV_USER_DATA_CODE)
  assert.equal(result.userDataPath, `${hostileTemp}\\qa\\userdata`)
  assert.deepEqual(touched, [])
})

test('a portable wrong-suffix short alias remains refused without probing', () => {
  const fence = String.raw`${"\x43:\\Users\\fixture-profile"}`
  const wrong = String.raw`${"\x43:\\Users\\OTHER~1\\AppData\\Local\\Elsewhere\\userdata"}`
  const result = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: ['ToolsEnabled.exe', `--user-data-dir=${wrong}`],
    commandLineUserDataPath: wrong,
    userDataPath: wrong,
    runtimePaths: [String.raw`${"\x43:\\Program Files\\ToolsEnabled\\ToolsEnabled.exe"}`],
    fencedProfile: fence,
    filesystem: {
      lstatSync(candidate) { throw new Error(`the portable guard probed a wrong-suffix alias: ${candidate}`) },
      readlinkSync(candidate) { throw new Error(`the portable guard read a wrong-suffix alias: ${candidate}`) },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, DEV_USER_DATA_CODE)
  assert.equal(result.userDataPath, wrong)
})

test('the fenced Dev runtime resolves a reparse ancestor before accepting a missing userData leaf', () => {
  const fence = String.raw`${"\x43:\\Users\\fixture-profile"}`
  const junction = String.raw`${"\x43:\\Users\\fixture-profile\\scratch-link"}`
  const outside = String.raw`${"\x43:\\Windows\\Temp\\outside-profile"}`
  const touched = []
  const filesystem = {
    lstatSync(candidate) {
      touched.push(candidate)
      const folded = candidate.toLowerCase()
      const foldedFence = fence.toLowerCase()
      assert.ok(folded.startsWith(foldedFence) || foldedFence.startsWith(folded),
        `the resolver followed the junction outside the permitted profile: ${candidate}`)
      if (candidate.toLowerCase() === junction.toLowerCase()) return { isSymbolicLink: () => true }
      return { isSymbolicLink: () => false }
    },
    readlinkSync(candidate) {
      assert.equal(candidate.toLowerCase(), junction.toLowerCase())
      return outside
    },
  }
  const requested = `${junction}\\not-created-yet`
  assert.equal(canonicalWindowsPathThroughExistingAncestors(requested, {
    ...filesystem,
    stopOutsideRoot: fence,
  }), `${outside}\\not-created-yet`)
  const result = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: ['ToolsEnabled.exe', '--user-data-dir', requested],
    cwd: String.raw`${"\x43:\\Users\\fixture-profile\\Desktop\\WorkingFolder\\app-reconciled"}`,
    userDataPath: requested,
    runtimePaths: [String.raw`${"\x43:\\Users\\fixture-profile\\Desktop\\WorkingFolder\\app-reconciled\\node_modules\\electron\\electron.exe"}`],
    filesystem,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, DEV_USER_DATA_CODE)
  assert.equal(result.userDataPath, `${outside}\\not-created-yet`)
  assert.ok(touched.length > 0, 'the pure reparse seam was not exercised')
})

test('the fenced Dev runtime refuses a resolved default userData outside the fence without a switch', () => {
  const result = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: ['electron.exe', '.'],
    userDataPath: String.raw`${"\x43:\\Windows\\Temp\\ToolsEnabled"}`,
    runtimePaths: [String.raw`${"\x43:\\Users\\fixture-profile\\Desktop\\WorkingFolder\\app-reconciled\\node_modules\\electron\\electron.exe"}`],
    filesystem: {
      lstatSync() { throw new Error('an already-outside path must be refused without probing it') },
      readlinkSync() { throw new Error('an already-outside path must be refused without probing it') },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, DEV_USER_DATA_CODE)
  assert.match(result.message, /resolved userData directory outside/)
})

test('the fenced Dev runtime refuses both forms of explicit userData outside its account', () => {
  for (const argv of [
    ['ToolsEnabled.exe', String.raw`${"--user-data-dir=\x43:\\Users\\OtherAccount\\AppData\\Roaming\\ToolsEnabled"}`],
    ['ToolsEnabled.exe', '--user-data-dir', String.raw`${"\x43:\\Users\\fixture-profile-Escape\\userdata"}`],
  ]) {
    const result = checkFencedDevUserDataDirectory({
      platform: 'win32', argv,
      cwd: String.raw`${"\x43:\\Users\\fixture-profile\\Desktop\\WorkingFolder\\app-reconciled"}`,
      userDataPath: argv.at(-1).replace(/^--user-data-dir=/, ''),
      runtimePaths: [String.raw`${"\x43:\\Users\\fixture-profile\\AppData\\Local\\Programs\\toolsenabled\\ToolsEnabled.exe"}`],
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, DEV_USER_DATA_CODE)
    assert.match(result.message, /refused --user-data-dir outside \x43:\\Users\\fixture-profile/)
  }
})

test('the fenced Dev runtime refuses an explicit userData switch with no path', () => {
  const result = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: ['ToolsEnabled.exe', '--user-data-dir', '--remote-debugging-port=0'],
    userDataPath: String.raw`${"\x43:\\Users\\fixture-profile\\AppData\\Roaming\\ToolsEnabled"}`,
    runtimePaths: [String.raw`${"\x43:\\Users\\fixture-profile\\AppData\\Local\\Programs\\toolsenabled\\ToolsEnabled.exe"}`],
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, DEV_USER_DATA_CODE)
})

test('the Electron command-line reading cannot hide an escaped userData argument from the fence', () => {
  const result = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: ['ToolsEnabled.exe'],
    commandLineUserDataPath: String.raw`${"\x43:\\Users\\OtherAccount\\AppData\\Roaming\\ToolsEnabled"}`,
    userDataPath: String.raw`${"\x43:\\Users\\OtherAccount\\AppData\\Roaming\\ToolsEnabled"}`,
    runtimePaths: [String.raw`${"\x43:\\Users\\fixture-profile\\Desktop\\WorkingFolder\\app-reconciled\\node_modules\\electron\\electron.exe"}`],
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, DEV_USER_DATA_CODE)
})

test('the Dev-only userData fence does not change customer runtimes outside the fenced profile', () => {
  const result = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: ['ToolsEnabled.exe', String.raw`${"--user-data-dir=\x43:\\Users\\Customer\\AppData\\Roaming\\ToolsEnabled"}`],
    userDataPath: String.raw`${"\x43:\\Users\\Customer\\AppData\\Roaming\\ToolsEnabled"}`,
    runtimePaths: [String.raw`${"\x43:\\Users\\Customer\\AppData\\Local\\Programs\\toolsenabled\\ToolsEnabled.exe"}`],
  })
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'inside-fenced-dev-profile')
  assert.equal(result.fencedProfile, String.raw`${"\x43:\\Users\\Customer"}`)
})

test('an explicit selected profile fences portable runtime userData too', () => {
  const result = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: ['ToolsEnabled.exe', String.raw`${"--user-data-dir=\x58:\\Users\\Another\\userdata"}`],
    userDataPath: String.raw`${"\x58:\\Users\\Another\\userdata"}`,
    runtimePaths: [String.raw`${"\x58:\\Program Files\\ToolsEnabled\\ToolsEnabled.exe"}`],
    fencedProfile: String.raw`${"\x58:\\Users\\ReleaseWorker"}`,
    filesystem: {
      lstatSync() { throw new Error('an already-outside path must be refused without probing it') },
      readlinkSync() { throw new Error('an already-outside path must be refused without probing it') },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, DEV_USER_DATA_CODE)
})

test('the startup environment removes other provider homes and loaders case-insensitively', () => {
  const result = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: String.raw`${"\x58:\\Users\\ReleaseWorker"}`,
    environment: {
      USERPROFILE: String.raw`${"\x58:\\Users\\ReleaseWorker"}`,
      APPDATA: String.raw`${"\x58:\\Users\\ReleaseWorker\\AppData\\Roaming"}`,
      LOCALAPPDATA: String.raw`${"\x58:\\Users\\ReleaseWorker\\AppData\\Local"}`,
      CodeX_Home: String.raw`${"\x58:\\Users\\Another\\codex"}`,
      gemini_dir: String.raw`${"\x58:\\Users\\Another\\gemini"}`,
      Node_Options: '--require=\x58:\\Users\\Another\\ambient-loader.cjs',
      node_path: String.raw`${"\x58:\\Users\\Another\\node_modules"}`,
      SystemRoot: String.raw`${"\x58:\\Windows"}`,
    },
    filesystem: {
      lstatSync() { const error = new Error('missing synthetic path'); error.code = 'ENOENT'; throw error },
    },
  })
  assert.equal(result.ok, true)
  for (const name of Object.keys(result.environment)) {
    assert.ok(!['CODEX_HOME', 'GEMINI_DIR', 'NODE_OPTIONS', 'NODE_PATH'].includes(name.toUpperCase()))
  }
  assert.equal(result.environment.SystemRoot, String.raw`${"\x58:\\Windows"}`)
})

test('a same-profile compatibility handoff keeps the fenced account and removes Node loaders', () => {
  const environment = electronNodeHandoffEnvironment({
    USERPROFILE: String.raw`${"\x58:\\Users\\ReleaseWorker"}`,
    APPDATA: String.raw`${"\x58:\\Users\\ReleaseWorker\\AppData\\Roaming"}`,
    LOCALAPPDATA: String.raw`${"\x58:\\Users\\ReleaseWorker\\AppData\\Local"}`,
    NODE_OPTIONS: '--require=ambient-loader.cjs',
    node_path: String.raw`${"\x58:\\ambient-modules"}`,
    TOOLSENABLED_STATE_ROOT: String.raw`${"\x58:\\Users\\ReleaseWorker\\state"}`,
  })
  assert.equal(environment.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(environment.USERPROFILE, String.raw`${"\x58:\\Users\\ReleaseWorker"}`)
  assert.equal(environment.APPDATA, String.raw`${"\x58:\\Users\\ReleaseWorker\\AppData\\Roaming"}`)
  assert.equal(environment.TOOLSENABLED_STATE_ROOT, String.raw`${"\x58:\\Users\\ReleaseWorker\\state"}`)
  assert.equal(Object.keys(environment).some(name => name.toUpperCase() === 'NODE_OPTIONS'), false)
  assert.equal(Object.keys(environment).some(name => name.toUpperCase() === 'NODE_PATH'), false)
})

test('an inside userData cannot conceal an outside account root and no outside path is probed', () => {
  const touched = []
  const result = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: String.raw`${"\x58:\\Users\\ReleaseWorker"}`,
    environment: {
      USERPROFILE: String.raw`${"\x58:\\Users\\ReleaseWorker"}`,
      APPDATA: String.raw`${"\x58:\\Users\\Another\\AppData\\Roaming"}`,
      LOCALAPPDATA: String.raw`${"\x58:\\Users\\ReleaseWorker\\AppData\\Local"}`,
    },
    filesystem: {
      lstatSync(candidate) { touched.push(candidate); return { isSymbolicLink: () => false } },
      readlinkSync() { throw new Error('no links in this fixture') },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, ACCOUNT_ENVIRONMENT_CODE)
  assert.deepEqual(result.variables, ['APPDATA'])
  assert.ok(touched.every(candidate => !candidate.toLowerCase().startsWith(String.raw`${"\x78:\\users\\another"}`)),
    `the guard probed a synthetic outside profile: ${JSON.stringify(touched)}`)
})

test('system PATH and TEMP locations remain valid while a sibling PATH entry is refused', () => {
  const base = {
    USERPROFILE: String.raw`${"\x58:\\Users\\ReleaseWorker"}`,
    APPDATA: String.raw`${"\x58:\\Users\\ReleaseWorker\\AppData\\Roaming"}`,
    LOCALAPPDATA: String.raw`${"\x58:\\Users\\ReleaseWorker\\AppData\\Local"}`,
    TEMP: String.raw`${"\x58:\\Windows\\Temp"}`,
    TMP: String.raw`${"\x58:\\Windows\\Temp"}`,
    PATH: [String.raw`${"\x58:\\Windows\\System32"}`, String.raw`${"\x58:\\Users\\ReleaseWorker\\bin"}`].join(';'),
  }
  const filesystem = {
    lstatSync() { const error = new Error('missing synthetic path'); error.code = 'ENOENT'; throw error },
  }
  assert.equal(fencedAccountEnvironment({
    platform: 'win32', fencedProfile: String.raw`${"\x58:\\Users\\ReleaseWorker"}`, environment: base, filesystem,
  }).ok, true)

  const refused = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: String.raw`${"\x58:\\Users\\ReleaseWorker"}`,
    environment: { ...base, PATH: `${base.PATH};${String.raw`${"\x58:\\Users\\Another\\bin"}`}` },
    filesystem,
  })
  assert.equal(refused.ok, false)
  assert.ok(refused.variables.includes('PATH'))
})

test('custom profile parents detect siblings and profile names with spaces remain valid', () => {
  const missing = {
    lstatSync() { const error = new Error('missing synthetic path'); error.code = 'ENOENT'; throw error },
  }
  const spacedFence = String.raw`${"\x58:\\Users\\Release Worker"}`
  const spaced = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: spacedFence,
    cwd: `${spacedFence}\\project`,
    environment: {
      USERPROFILE: spacedFence,
      APPDATA: `${spacedFence}\\AppData\\Roaming`,
      LOCALAPPDATA: `${spacedFence}\\AppData\\Local`,
      PATH: [String.raw`${"\x58:\\Windows\\System32"}`, `${spacedFence}\\bin`].join(';'),
    },
    filesystem: missing,
  })
  assert.equal(spaced.ok, true)

  const customFence = String.raw`${"\x44:\\Profiles\\Worker"}`
  const custom = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: customFence,
    cwd: `${customFence}\\project`,
    environment: {
      USERPROFILE: customFence,
      APPDATA: `${customFence}\\AppData\\Roaming`,
      LOCALAPPDATA: `${customFence}\\AppData\\Local`,
      PATH: [String.raw`${"\x44:\\Windows\\System32"}`, String.raw`${"\x44:\\Profiles\\Another\\bin"}`].join(';'),
      OPAQUE_LAUNCH_FACT: String.raw`${"selected=\x44:\\Profiles\\Another\\state"}`,
    },
    filesystem: missing,
  })
  assert.equal(custom.ok, false)
  assert.ok(custom.variables.includes('PATH'))
  assert.ok(custom.variables.includes('OPAQUE_LAUNCH_FACT'))
})

test('a domain or local home drive outside the profile opens; another account in HOMEDRIVE/HOMEPATH is still refused (platform S1)', () => {
  const fence = String.raw`${"\x43:\\Users\\Example"}`
  const touched = []
  const filesystem = {
    lstatSync(candidate) { touched.push(candidate); const error = new Error('missing synthetic path'); error.code = 'ENOENT'; throw error },
  }
  const base = {
    USERPROFILE: fence,
    APPDATA: `${fence}\\AppData\\Roaming`,
    LOCALAPPDATA: `${fence}\\AppData\\Local`,
    PATH: String.raw`${"\x43:\\Windows\\System32"}`,
  }
  for (const [drive, home] of [['H:', '\\'], ['H:', String.raw`\Example`], ['D:', String.raw`\Home\Example`], ['C:', String.raw`\Users\Example`]]) {
    touched.length = 0
    const result = fencedAccountEnvironment({
      platform: 'win32', fencedProfile: fence, cwd: `${fence}\\project`,
      environment: { ...base, HOMEDRIVE: drive, HOMEPATH: home }, filesystem,
    })
    assert.equal(result.ok, true, `HOMEDRIVE=${drive} HOMEPATH=${home} was refused: ${JSON.stringify(result.variables)}`)
    /* A home outside the profile is judged lexically and never touched. A home
       inside the profile (<profile-root>/Example) takes the same in-profile walk as
       USERPROFILE, which stats only the profile's own ancestors on C:. */
    assert.ok(touched.every(candidate => !/^[hd]:/i.test(candidate)),
      `the home drive check touched a drive: ${JSON.stringify(touched)}`)
  }
  /* A reparse point inside the profile that leads to another account is
     refused here as it is in HOME and PATH, and the walk stops at the link's
     target text: the other account is never opened (review of fixes 3.8). */
  const link = `${fence}\\link`
  touched.length = 0
  const linked = fencedAccountEnvironment({
    platform: 'win32', fencedProfile: fence, cwd: `${fence}\\project`,
    environment: { ...base, HOMEDRIVE: 'C:', HOMEPATH: String.raw`\Users\Example\link` },
    filesystem: {
      lstatSync(candidate) {
        touched.push(candidate)
        return { isSymbolicLink: () => candidate.toLowerCase() === link.toLowerCase() }
      },
      readlinkSync(candidate) {
        assert.equal(candidate.toLowerCase(), link.toLowerCase())
        return String.raw`${"\x43:\\Users\\Bob"}`
      },
    },
  })
  assert.equal(linked.ok, false, 'a junction in the profile to another account opened')
  assert.deepEqual([...linked.variables], ['HOMEDRIVE/HOMEPATH'])
  assert.ok(touched.every(candidate => !/^\x63:\\users\\bob/i.test(candidate)),
    `the home drive check opened the other account: ${JSON.stringify(touched)}`)
  /* Any <drive>:\Users\<name> folder other than the signed-in profile is
     another account, even with the same name: <profile-root>/Example is what a second
     Windows install's or a relocated ProfilesDirectory's profile for a
     different SID looks like, and a name match alone must not open it
     (review of fixes 3.6, owner decision). The refusal stays lexical. */
  for (const [drive, home] of [['C:', String.raw`\Users\Bob`], ['D:', String.raw`\Users\Example`]]) {
    touched.length = 0
    const foreign = fencedAccountEnvironment({
      platform: 'win32', fencedProfile: fence, cwd: `${fence}\\project`,
      environment: { ...base, HOMEDRIVE: drive, HOMEPATH: home }, filesystem,
    })
    assert.equal(foreign.ok, false, `HOMEDRIVE=${drive} HOMEPATH=${home} opened`)
    assert.ok(foreign.variables.includes('HOMEDRIVE/HOMEPATH'))
    assert.ok(touched.every(candidate => !/^\x64:/i.test(candidate)),
      `the home drive check touched a drive: ${JSON.stringify(touched)}`)
  }
})

test('an inherited HOME outside the profile (MSYS2, Cygwin, \x44:\\home) opens; one naming another account is refused (platform S2)', () => {
  const fence = String.raw`${"\x43:\\Users\\Example"}`
  const base = {
    USERPROFILE: fence,
    APPDATA: `${fence}\\AppData\\Roaming`,
    LOCALAPPDATA: `${fence}\\AppData\\Local`,
    PATH: String.raw`${"\x43:\\Windows\\System32"}`,
  }
  const touched = []
  const filesystem = (links = {}) => ({
    lstatSync(candidate) {
      touched.push(candidate)
      if (Object.hasOwn(links, candidate.toLowerCase())) return { isSymbolicLink: () => true }
      const error = new Error('missing synthetic path'); error.code = 'ENOENT'; throw error
    },
    readlinkSync(candidate) { return links[candidate.toLowerCase()] },
  })
  for (const home of [String.raw`${"\x44:\\home"}`, String.raw`${"\x43:\\msys64\\home\\Example"}`, `${fence}\\home`]) {
    const result = fencedAccountEnvironment({
      platform: 'win32', fencedProfile: fence, cwd: `${fence}\\project`,
      environment: { ...base, HOME: home }, filesystem: filesystem(),
    })
    assert.equal(result.ok, true, `HOME=${home} was refused: ${JSON.stringify(result.variables)}`)
    assert.equal(result.environment.HOME, home)
  }
  const foreign = fencedAccountEnvironment({
    platform: 'win32', fencedProfile: fence, cwd: `${fence}\\project`,
    environment: { ...base, HOME: String.raw`${"\x43:\\Users\\Bob"}` }, filesystem: filesystem(),
  })
  assert.equal(foreign.ok, false)
  assert.deepEqual(foreign.variables, ['HOME'])

  touched.length = 0
  const linked = fencedAccountEnvironment({
    platform: 'win32', fencedProfile: fence, cwd: `${fence}\\project`,
    environment: { ...base, HOME: String.raw`${"\x44:\\home\\Example"}` },
    filesystem: filesystem({ [String.raw`${"\x64:\\home"}`]: String.raw`${"\x43:\\Users\\Bob"}` }),
  })
  assert.equal(linked.ok, false, 'a HOME link into another account was accepted')
  assert.deepEqual(linked.variables, ['HOME'])
  assert.ok(touched.every(candidate => !candidate.toLowerCase().startsWith(String.raw`${"\x63:\\users\\bob"}`)),
    `the guard opened the other account: ${JSON.stringify(touched)}`)

  // USERPROFILE, APPDATA and LOCALAPPDATA keep the strict inside-the-profile rule.
  for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    const strict = fencedAccountEnvironment({
      platform: 'win32', fencedProfile: fence, cwd: `${fence}\\project`,
      environment: { ...base, [name]: String.raw`${"\x44:\\home"}` }, filesystem: filesystem(),
    })
    assert.equal(strict.ok, false, `${name} outside the profile was accepted`)
    assert.ok(strict.variables.includes(name))
  }
})

test('a JVM option naming the person\'s own profile is not read as another account; other accounts still are (platform S3)', () => {
  const fence = String.raw`${"\x43:\\Users\\Example"}`
  assert.deepEqual(windowsProfileReferences(String.raw`${"-Duser.home=\x43:\\Users\\Example -Xmx2g"}`, fence), [fence])
  assert.deepEqual(windowsProfileReferences(String.raw`${"-Duser.home=\x43:\\Users\\Example -Dfile.encoding=UTF-8"}`, fence), [fence])
  assert.deepEqual(windowsProfileReferences(String.raw`${"-Duser.home=\x43:\\Users\\Example,-Xmx2g"}`, fence), [fence])
  assert.deepEqual(windowsProfileReferences(String.raw`${"-Duser.home=\x63:/users/Example -Djava.io.tmpdir=\x43:\\Temp"}`, fence), [String.raw`${"\x63:\\users\\Example"}`])
  // A file name cannot contain ':', so a component never runs into the next drive.
  assert.deepEqual(windowsProfileReferences(String.raw`${"-Da=\x43:\\Users\\Bob -Db=\x43:\\Temp"}`), [String.raw`${"\x43:\\Users\\Bob"}`])
  // The rest of the value is still read: a second account after the person's own is found.
  assert.deepEqual(windowsProfileReferences(String.raw`${"-Duser.home=\x43:\\Users\\Example -Dother=\x43:\\Users\\Bob\\x"}`, fence),
    [fence, String.raw`${"\x43:\\Users\\Bob"}`])
  // A longer account name that continues into a path is another account.
  assert.deepEqual(windowsProfileReferences(String.raw`${"\x43:\\Users\\Example Smith\\bin"}`, fence), [String.raw`${"\x43:\\Users\\Example Smith"}`])
  assert.deepEqual(windowsProfileReferences(String.raw`${"\x43:\\Users\\Example Smith"}`, fence), [String.raw`${"\x43:\\Users\\Example Smith"}`])
  // Profile names with spaces and apostrophes stay one component.
  assert.deepEqual(windowsProfileReferences(String.raw`${"\x43:\\Users\\Release Worker"}`, String.raw`${"\x43:\\Users\\Release Worker"}`),
    [String.raw`${"\x43:\\Users\\Release Worker"}`])
  assert.deepEqual(windowsProfileReferences(String.raw`${"\x43:\\Users\\O'Brien Jr"}`), [String.raw`${"\x43:\\Users\\O'Brien Jr"}`])

  const missing = {
    lstatSync() { const error = new Error('missing synthetic path'); error.code = 'ENOENT'; throw error },
  }
  const base = {
    USERPROFILE: fence,
    APPDATA: `${fence}\\AppData\\Roaming`,
    LOCALAPPDATA: `${fence}\\AppData\\Local`,
    PATH: String.raw`${"\x43:\\Windows\\System32"}`,
  }
  const own = fencedAccountEnvironment({
    platform: 'win32', fencedProfile: fence, cwd: `${fence}\\project`, filesystem: missing,
    environment: {
      ...base,
      JAVA_TOOL_OPTIONS: String.raw`${"-Duser.home=\x43:\\Users\\Example -Dfile.encoding=UTF-8"}`,
      _JAVA_OPTIONS: String.raw`${"-Duser.home=\x43:\\Users\\Example -Djava.io.tmpdir=\x43:\\Temp"}`,
      GRADLE_OPTS: String.raw`${"\"-Duser.home=\x43:\\Users\\Example\" -Xmx2g"}`,
    },
  })
  assert.equal(own.ok, true, JSON.stringify(own.variables))
  const other = fencedAccountEnvironment({
    platform: 'win32', fencedProfile: fence, cwd: `${fence}\\project`, filesystem: missing,
    environment: { ...base, JAVA_TOOL_OPTIONS: String.raw`${"-Duser.home=\x43:\\Users\\Bob -Xmx2g"}` },
  })
  assert.equal(other.ok, false)
  assert.deepEqual(other.variables, ['JAVA_TOOL_OPTIONS'])

  const customFence = String.raw`${"\x44:\\Profiles\\Example"}`
  const custom = fencedAccountEnvironment({
    platform: 'win32', fencedProfile: customFence, cwd: `${customFence}\\project`, filesystem: missing,
    environment: {
      USERPROFILE: customFence,
      APPDATA: `${customFence}\\AppData\\Roaming`,
      LOCALAPPDATA: `${customFence}\\AppData\\Local`,
      GRADLE_OPTS: String.raw`${"-Duser.home=\x44:\\Profiles\\Example -Xmx2g"}`,
    },
  })
  assert.equal(custom.ok, true, JSON.stringify(custom.variables))
  assert.deepEqual(windowsProfileReferences(String.raw`${"-Da=\x44:\\Profiles\\Bob -Db=\x44:\\Temp"}`, customFence), [String.raw`${"\x44:\\Profiles\\Bob"}`])
})

test('the exact trusted profile alias is replaced without probing alias text', () => {
  const fence = String.raw`${"\x43:\\Users\\fixture-profile"}`
  const localAppData = `${fence}\\AppData\\Local`
  const safeTemp = `${localAppData}\\Temp`
  const touched = []
  const result = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: fence,
    trustedProfileAliasRoot: String.raw`${"\x43:\\Users\\TOOLSE~1"}`,
    cwd: `${fence}\\project`,
    environment: {
      USERPROFILE: fence,
      APPDATA: `${fence}\\AppData\\Roaming`,
      LOCALAPPDATA: localAppData,
      TEMP: String.raw`${"\x43:\\Users\\TOOLSE~1\\AppData\\Local\\Temp"}`,
      TMP: String.raw`${"\x43:\\Users\\TOOLSE~1\\AppData\\Local\\Temp"}`,
      PATH: String.raw`${"\x43:\\Windows\\System32"}`,
    },
    filesystem: {
      lstatSync(candidate) {
        touched.push(candidate)
        assert.doesNotMatch(candidate, /~/, `the guard probed disposable alias text: ${candidate}`)
        return { isSymbolicLink: () => false }
      },
      readlinkSync() { throw new Error('the synthetic paths contain no links') },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.environment.TEMP, safeTemp)
  assert.equal(result.environment.TMP, safeTemp)
  assert.doesNotMatch(JSON.stringify(result.environment), /TOOLSE~1/i)
  assert.ok(touched.length > 0)
})

test('the providerless staged-account environment maps every known path variable and PATH entry to long Temp', () => {
  const fence = String.raw`${"\x43:\\Users\\fixture-profile"}`
  const aliasTemp = String.raw`${"\x43:\\Users\\TOOLSE~1\\AppData\\Local\\Temp"}`
  const longTemp = `${fence}\\AppData\\Local\\Temp`
  const aliasProfile = `${aliasTemp}\\mc-start-flow-qa-123\\profile`
  const longProfile = `${longTemp}\\mc-start-flow-qa-123\\profile`
  const result = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: fence,
    trustedProfileAliasRoot: String.raw`${"\x43:\\Users\\TOOLSE~1"}`,
    cwd: `${aliasTemp}\\mc-start-flow-qa-123\\app`,
    environment: {
      USERPROFILE: `${aliasProfile}\\home`,
      HOME: `${aliasProfile}\\home`,
      APPDATA: `${aliasProfile}\\roaming`,
      LOCALAPPDATA: `${aliasProfile}\\local`,
      TEMP: `${aliasProfile}\\temp`,
      TMP: `${aliasProfile}\\temp`,
      PATH: [String.raw`${"\x43:\\Windows\\System32"}`, `${aliasProfile}\\tools`].join(';'),
    },
    filesystem: {
      lstatSync(candidate) {
        assert.doesNotMatch(candidate, /~/, `the environment guard probed a short alias: ${candidate}`)
        const error = new Error('missing synthetic long-path leaf'); error.code = 'ENOENT'; throw error
      },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.environment.USERPROFILE, `${longProfile}\\home`)
  assert.equal(result.environment.HOME, `${longProfile}\\home`)
  assert.equal(result.environment.APPDATA, `${longProfile}\\roaming`)
  assert.equal(result.environment.LOCALAPPDATA, `${longProfile}\\local`)
  assert.equal(result.environment.TEMP, `${longProfile}\\temp`)
  assert.equal(result.environment.TMP, `${longProfile}\\temp`)
  assert.equal(result.environment.PATH, [String.raw`${"\x43:\\Windows\\System32"}`, `${longProfile}\\tools`].join(';'))
  assert.doesNotMatch(JSON.stringify(result.environment), /TOOLSE~1/i)
})

test('untrusted aliases in known environment paths are refused without probing', () => {
  const fence = String.raw`${"\x43:\\Users\\fixture-profile"}`
  const hostileTemp = String.raw`${"\x43:\\Users\\OTHER~1\\AppData\\Local\\Temp"}`
  const touched = []
  const refused = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: fence,
    environment: {
      USERPROFILE: `${hostileTemp}\\qa\\home`,
      APPDATA: `${hostileTemp}\\qa\\roaming`,
      LOCALAPPDATA: `${hostileTemp}\\qa\\local`,
      TEMP: `${hostileTemp}\\qa\\temp`,
      TMP: `${hostileTemp}\\qa\\temp`,
      PATH: `${hostileTemp}\\qa\\tools`,
    },
    filesystem: {
      lstatSync(candidate) {
        touched.push(candidate)
        assert.doesNotMatch(candidate, /OTHER~1/i, `the guard probed hostile alias text: ${candidate}`)
        const error = new Error('missing trusted long-path leaf'); error.code = 'ENOENT'; throw error
      },
    },
  })
  assert.equal(refused.ok, false)
  for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATH']) {
    assert.ok(refused.variables.includes(name), `${name} did not refuse the untrusted alias`)
  }
  assert.deepEqual(touched, [], 'the environment guard must refuse before any filesystem probe')

  const compound = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: fence,
    environment: {
      USERPROFILE: fence,
      APPDATA: `${fence}\\AppData\\Roaming`,
      LOCALAPPDATA: `${fence}\\AppData\\Local`,
      OPAQUE_LAUNCH_FACT: `selected=${hostileTemp}\\qa\\state`,
    },
    filesystem: {
      lstatSync() { const error = new Error('missing synthetic long path'); error.code = 'ENOENT'; throw error },
    },
  })
  assert.equal(compound.ok, false)
  assert.ok(compound.variables.includes('OPAQUE_LAUNCH_FACT'))
})

test('TEMP short aliases with any other suffix and unrelated foreign long paths remain refused', () => {
  const fence = String.raw`${"\x43:\\Users\\fixture-profile"}`
  const base = {
    USERPROFILE: fence,
    APPDATA: `${fence}\\AppData\\Roaming`,
    LOCALAPPDATA: `${fence}\\AppData\\Local`,
  }
  const filesystem = {
    lstatSync(candidate) {
      assert.doesNotMatch(candidate, /OTHER~1|Another/i, `the guard probed a foreign profile path: ${candidate}`)
      return { isSymbolicLink: () => false }
    },
    readlinkSync() { throw new Error('the synthetic paths contain no links') },
  }
  const wrongSuffix = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: fence,
    environment: { ...base, TEMP: String.raw`${"\x43:\\Users\\OTHER~1\\AppData\\Local\\Elsewhere"}` },
    filesystem,
  })
  assert.equal(wrongSuffix.ok, false)
  assert.ok(wrongSuffix.variables.includes('TEMP'))

  const foreignLong = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: fence,
    environment: { ...base, TMP: String.raw`${"\x43:\\Users\\Another\\AppData\\Local\\Temp"}` },
    filesystem,
  })
  assert.equal(foreignLong.ok, false)
  assert.ok(foreignLong.variables.includes('TMP'))

  const wrongKnownPaths = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: fence,
    environment: {
      ...base,
      LOCALAPPDATA: String.raw`${"\x43:\\Users\\OTHER~1\\AppData\\Local\\Elsewhere\\local"}`,
      PATH: String.raw`${"\x43:\\Users\\OTHER~1\\AppData\\Local\\Elsewhere\\tools"}`,
    },
    filesystem,
  })
  assert.equal(wrongKnownPaths.ok, false)
  assert.ok(wrongKnownPaths.variables.includes('LOCALAPPDATA'))
  assert.ok(wrongKnownPaths.variables.includes('PATH'))
})

test('long in-profile TEMP and an ordinary external TMP are preserved', () => {
  const fence = String.raw`${"\x43:\\Users\\fixture-profile"}`
  const longTemp = `${fence}\\AppData\\Local\\Temp`
  const externalTemp = String.raw`${"\x44:\\PortableScratch\\Temp"}`
  const result = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: fence,
    environment: {
      USERPROFILE: fence,
      APPDATA: `${fence}\\AppData\\Roaming`,
      LOCALAPPDATA: `${fence}\\AppData\\Local`,
      TEMP: longTemp,
      TMP: externalTemp,
    },
    filesystem: {
      lstatSync() { const error = new Error('missing synthetic path'); error.code = 'ENOENT'; throw error },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.environment.TEMP, longTemp)
  assert.equal(result.environment.TMP, externalTemp)
})

test('system PATH reparses are followed but a foreign-profile target is refused before probing it', () => {
  const fence = String.raw`${"\x58:\\Users\\ReleaseWorker"}`
  const link = String.raw`${"\x58:\\System\\tool-link"}`
  const foreign = String.raw`${"\x58:\\Users\\Another\\bin"}`
  const touched = []
  const result = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: fence,
    cwd: `${fence}\\project`,
    environment: {
      USERPROFILE: fence,
      APPDATA: `${fence}\\AppData\\Roaming`,
      LOCALAPPDATA: `${fence}\\AppData\\Local`,
      PATH: link,
    },
    filesystem: {
      lstatSync(candidate) {
        touched.push(candidate)
        assert.equal(candidate.toLowerCase().startsWith(foreign.toLowerCase()), false,
          `the guard probed the foreign target: ${candidate}`)
        return { isSymbolicLink: () => candidate.toLowerCase() === link.toLowerCase() }
      },
      readlinkSync(candidate) {
        assert.equal(candidate.toLowerCase(), link.toLowerCase())
        return foreign
      },
    },
  })
  assert.equal(result.ok, false)
  assert.ok(result.variables.includes('PATH'))
  assert.ok(touched.some(candidate => candidate.toLowerCase() === link.toLowerCase()))
})

test('ordinary external system reparses and quoted or relative PATH entries remain valid', () => {
  const fence = String.raw`${"\x58:\\Users\\ReleaseWorker"}`
  const link = String.raw`${"\x58:\\System\\tool-link"}`
  const external = String.raw`${"\x59:\\Shared\\Tools"}`
  const result = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: fence,
    cwd: `${fence}\\project`,
    environment: {
      USERPROFILE: fence,
      APPDATA: `${fence}\\AppData\\Roaming`,
      LOCALAPPDATA: `${fence}\\AppData\\Local`,
      TEMP: link,
      PATH: [String.raw`${"\"\x58:\\Windows\\System32\""}`, String.raw`tools\bin`].join(';'),
    },
    filesystem: {
      lstatSync(candidate) {
        if (candidate.toLowerCase() === link.toLowerCase()) return { isSymbolicLink: () => true }
        if (candidate.toLowerCase().startsWith(external.toLowerCase())) {
          const error = new Error('missing synthetic external leaf'); error.code = 'ENOENT'; throw error
        }
        const error = new Error('missing synthetic path'); error.code = 'ENOENT'; throw error
      },
      readlinkSync(candidate) {
        assert.equal(candidate.toLowerCase(), link.toLowerCase())
        return external
      },
    },
  })
  assert.equal(result.ok, true)
})

test('portable and system runtimes accept external userData but refuse a foreign-profile reparse', () => {
  const fence = String.raw`${"\x58:\\Users\\ReleaseWorker"}`
  const runtime = String.raw`${"\x58:\\Program Files\\ToolsEnabled\\ToolsEnabled.exe"}`
  const portableData = String.raw`${"\x44:\\PortableData\\ToolsEnabled"}`
  const missing = {
    lstatSync() { const error = new Error('missing synthetic path'); error.code = 'ENOENT'; throw error },
  }
  const accepted = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: ['ToolsEnabled.exe', `--user-data-dir=${portableData}`],
    userDataPath: portableData,
    runtimePaths: [runtime],
    fencedProfile: fence,
    filesystem: missing,
  })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.reason, 'portable-or-system-user-data')

  const link = String.raw`${"\x44:\\PortableDataLink"}`
  const foreign = String.raw`${"\x58:\\Users\\Another\\userdata"}`
  const touched = []
  const refused = checkFencedDevUserDataDirectory({
    platform: 'win32',
    argv: ['ToolsEnabled.exe', `--user-data-dir=${link}`],
    userDataPath: link,
    runtimePaths: [runtime],
    fencedProfile: fence,
    filesystem: {
      lstatSync(candidate) {
        touched.push(candidate)
        assert.equal(candidate.toLowerCase().startsWith(foreign.toLowerCase()), false,
          `the portable guard probed the foreign target: ${candidate}`)
        return { isSymbolicLink: () => candidate.toLowerCase() === link.toLowerCase() }
      },
      readlinkSync(candidate) {
        assert.equal(candidate.toLowerCase(), link.toLowerCase())
        return foreign
      },
    },
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, DEV_USER_DATA_CODE)
  assert.ok(touched.some(candidate => candidate.toLowerCase() === link.toLowerCase()))
})

test('a reparse ancestor cannot move an account root outside its selected profile', () => {
  const fence = String.raw`${"\x58:\\Users\\ReleaseWorker"}`
  const link = `${fence}\\roaming-link`
  const result = fencedAccountEnvironment({
    platform: 'win32',
    fencedProfile: fence,
    environment: {
      USERPROFILE: fence,
      APPDATA: `${link}\\app`,
      LOCALAPPDATA: `${fence}\\local`,
    },
    filesystem: {
      lstatSync(candidate) {
        if (candidate.toLowerCase() === link.toLowerCase()) return { isSymbolicLink: () => true }
        return { isSymbolicLink: () => false }
      },
      readlinkSync(candidate) {
        assert.equal(candidate.toLowerCase(), link.toLowerCase())
        return String.raw`${"\x58:\\Windows\\Temp\\outside"}`
      },
    },
  })
  assert.equal(result.ok, false)
  assert.ok(result.variables.includes('APPDATA'))
})

test('main enforces the guard before userData adoption and exits synchronously on refusal', () => {
  const source = readFileSync(path.join(ROOT, 'shell', 'main.cjs'), 'utf8')
  const currentHomeDeclaration = source.indexOf('const CURRENT_PROFILE_PATH =')
  const currentHome = source.indexOf("app.getPath('home')", currentHomeDeclaration)
  const guard = source.indexOf('const installProfileCheck = checkPackagedInstallProfile({')
  const exit = source.indexOf('process.exit(1)', guard)
  const userData = source.indexOf("const SHELL_USER_DATA_PATH = app.getPath('userData')")
  const adoption = source.indexOf('adoptLegacyUserData({')
  assert.ok(guard !== -1, 'main no longer runs the packaged install-profile guard')
  assert.ok(currentHomeDeclaration >= 0 && currentHome > currentHomeDeclaration && currentHome < guard,
    'main no longer resolves Electron\'s current-user home for the packaged guard')
  assert.ok(exit > guard, 'a mismatch no longer exits synchronously')
  assert.ok(userData > exit, 'main resolves userData before refusing the wrong profile')
  assert.ok(adoption > exit, 'main adopts legacy data before refusing the wrong profile')
})

test('main compares a checkout owner with the process identity before alias resolution or userData', () => {
  const source = readFileSync(path.join(ROOT, 'shell', 'main.cjs'), 'utf8')
  const runtimeGuard = source.indexOf('const runtimeProfileCheck = checkRuntimeProfileOwner({')
  const runtimePaths = source.indexOf('runtimePaths: [__dirname, process.execPath]', runtimeGuard)
  const runtimeExit = source.indexOf('process.exit(1)', runtimeGuard)
  const fence = source.indexOf('const SHELL_PROFILE_FENCE =', runtimeExit)
  const runtimeFence = source.indexOf('runtimeProfileCheck.runtimeProfile', fence)
  const alias = source.indexOf('trustedProfileShortAliasRoot(SHELL_PROFILE_FENCE)', fence)
  const userData = source.indexOf("app.getPath('userData')", alias)
  assert.ok(runtimeGuard >= 0 && runtimePaths > runtimeGuard,
    'main no longer derives the development owner from its actual runtime paths')
  assert.ok(runtimeExit > runtimeGuard && runtimeExit < alias,
    'main can query an alias or userData before refusing a mixed development identity')
  assert.ok(runtimeFence > fence && runtimeFence < alias,
    'the validated runtime owner no longer becomes the development fence')
  assert.ok(userData > alias, 'main reads userData before the runtime-owner fence is established')
})

test('main measures an elevated token early, warns once with a checkbox, and never refuses it', async () => {
  const source = readFileSync(path.join(ROOT, 'shell', 'main.cjs'), 'utf8')
  const integrityGuard = source.indexOf('const runtimeIntegrityCheck = checkWindowsRuntimeIntegrity()')
  const scrub = source.indexOf('scrubCapabilityPathOverrides(process.env)', integrityGuard)
  assert.ok(integrityGuard >= 0 && scrub > integrityGuard, 'main still measures the token before loading any capability code')
  const between = source.slice(integrityGuard, scrub)
  assert.ok(!between.includes('process.exit('), 'an elevated token must never end the launch: the person decides, the app warns')
  assert.ok(!between.includes('reportStartupRefusal('), 'an elevated token is not a startup refusal')
  // The chain opens the saved-draft reader first: the full-reset owner-gone
  // recovery that follows parses saved trees with it (getTaskTopologyAdmission).
  const startup = source.match(/^\s*return (initializeSavedDraftGraphReader\(\)(?:\n\s*\.then\([^\n]+\))+)/m)?.[1]
  assert.ok(startup, 'the startup recovery promise chain must be available for measurement')
  // Execute the actual startup chain with deferred boundaries: an added
  // recovery step must remain awaited before the warning and first window.
  const drafts = Promise.withResolvers(), ownerGone = Promise.withResolvers(), cleanup = Promise.withResolvers(), recovery = Promise.withResolvers(), warning = Promise.withResolvers()
  const calls = []
  const runStartup = new Function('nodePrivacyCleanup', 'initializeNodeRecovery', 'initializeSavedDraftGraphReader', 'recoverFullResetOwnerGone', 'showElevatedRunWarning', 'createWindow', `return ${startup}`)
  const pending = runStartup(
    { recover: () => { calls.push('privacy'); return cleanup.promise } },
    () => { calls.push('recovery'); return recovery.promise },
    () => { calls.push('drafts'); return drafts.promise },
    () => { calls.push('owner-gone'); return ownerGone.promise },
    () => { calls.push('warning'); return warning.promise },
    () => { calls.push('window'); return 'opened' },
  )
  const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
  await settle()
  assert.deepEqual(calls, ['drafts'], 'saved draft recovery blocks owner-gone recovery, privacy cleanup, recovery, warning and window')
  drafts.resolve(); await settle()
  assert.deepEqual(calls, ['drafts', 'owner-gone'], 'pending owner-gone recovery blocks privacy cleanup, recovery, warning and window')
  ownerGone.resolve(); await settle()
  assert.deepEqual(calls, ['drafts', 'owner-gone', 'privacy'], 'pending privacy cleanup blocks recovery, warning and window')
  cleanup.resolve(); await settle()
  assert.deepEqual(calls, ['drafts', 'owner-gone', 'privacy', 'recovery'], 'pending node recovery blocks the warning and window')
  recovery.resolve(); await settle()
  assert.deepEqual(calls, ['drafts', 'owner-gone', 'privacy', 'recovery', 'warning'], 'the window waits for the elevation warning')
  warning.resolve()
  assert.equal(await pending, 'opened')
  assert.deepEqual(calls, ['drafts', 'owner-gone', 'privacy', 'recovery', 'warning', 'window'])
  assert.ok(source.includes('checkboxLabel: words.checkboxLabel'), 'the warning carries the do-not-warn-again checkbox')
  assert.ok(source.includes("rendererPrefs.set(ELEVATED_WARNING_KEY, 'off')"), 'the checkbox is remembered in the durable prefs')
  assert.ok(source.includes("if (process.env.MC_SMOKE_HEADLESS === '1') return"), 'no dialog under the smoke harness')
})

test('main binds the capability ledger and vault to the same Electron userData identity', () => {
  const source = readFileSync(path.join(ROOT, 'shell', 'main.cjs'), 'utf8')
  const userData = source.indexOf("const SHELL_USER_DATA_PATH = app.getPath('userData')")
  const stateRoot = source.indexOf("const CAPABILITY_STATE_ROOT = nodePath.join(SHELL_USER_DATA_PATH, 'capability')", userData)
  const scrub = source.indexOf('scrubCapabilityPathOverrides(process.env)')
  const publishState = source.indexOf('process.env.TOOLSENABLED_STATE_ROOT = CAPABILITY_STATE_ROOT', stateRoot)
  const publishVault = source.indexOf("process.env.TOOLSENABLED_VAULT_PATH = nodePath.join(CAPABILITY_STATE_ROOT, 'vault', 'secrets.json')", stateRoot)
  const adoption = source.indexOf('adoptLegacyUserData({', stateRoot)

  assert.ok(userData >= 0 && stateRoot > userData, 'main must derive capability state from Electron userData')
  assert.ok(scrub >= 0 && scrub < userData, 'ambient capability path redirects must be removed before userData is resolved')
  assert.ok(publishState > userData && publishVault > publishState,
    'the ledger and protected head must be published as one userData-bound pair')
  assert.ok(publishVault < adoption, 'no startup storage work may run before the state/vault pair is confined')
})

test('main refuses an escaped explicit userData before capability state or adoption', () => {
  const source = readFileSync(path.join(ROOT, 'shell', 'main.cjs'), 'utf8')
  const userData = source.indexOf("const SHELL_USER_DATA_PATH = app.getPath('userData')")
  const alias = source.indexOf('const TRUSTED_PROFILE_SHORT_ALIAS_ROOT = trustedProfileShortAliasRoot(SHELL_PROFILE_FENCE)')
  const guard = source.indexOf('const devUserDataCheck = checkFencedDevUserDataDirectory({', userData)
  const exit = source.indexOf('process.exit(1)', guard)
  const stateRoot = source.indexOf('const CAPABILITY_STATE_ROOT =', userData)
  const adoption = source.indexOf('adoptLegacyUserData({', userData)
  assert.ok(alias >= 0 && alias < userData, 'main must derive an alias only from the trusted profile before reading userData')
  assert.ok(userData >= 0 && guard > userData && exit > guard)
  assert.match(source.slice(guard, exit), /trustedProfileAliasRoot: TRUSTED_PROFILE_SHORT_ALIAS_ROOT/,
    'the userData fence does not receive the exact trusted alias')
  const environmentGuard = source.indexOf('const accountEnvironmentCheck = fencedAccountEnvironment({', exit)
  const environmentExit = source.indexOf('process.exit(1)', environmentGuard)
  assert.match(source.slice(environmentGuard, environmentExit), /trustedProfileAliasRoot: TRUSTED_PROFILE_SHORT_ALIAS_ROOT/,
    'the environment fence does not receive the exact trusted alias')
  assert.ok(exit < stateRoot && exit < adoption,
    'an escaped explicit userData can reach capability state or adoption before refusal')
})

test('the compatibility Node handoff occurs only after every startup identity fence', () => {
  const source = readFileSync(path.join(ROOT, 'shell', 'main.cjs'), 'utf8')
  const detected = source.indexOf('const ELECTRON_NODE_HANDOFF =')
  const packagedGuard = source.indexOf('const installProfileCheck = checkPackagedInstallProfile({')
  const userDataGuard = source.indexOf('const devUserDataCheck = checkFencedDevUserDataDirectory({')
  const environmentGuard = source.indexOf('const accountEnvironmentCheck = fencedAccountEnvironment({')
  const stateRoot = source.indexOf('process.env.TOOLSENABLED_STATE_ROOT = CAPABILITY_STATE_ROOT')
  const spawn = source.indexOf('const result = spawnSync(process.execPath, ELECTRON_NODE_HANDOFF.forwarded')
  assert.ok(detected >= 0 && detected < packagedGuard, 'the harmless argv detection should remain first')
  assert.ok(packagedGuard < userDataGuard && userDataGuard < environmentGuard,
    'the installed profile, userData and account environment must be checked in that order')
  assert.ok(environmentGuard < stateRoot && stateRoot < spawn,
    'the Node handoff can run before the fenced state identity is published')
  const handoff = source.slice(source.lastIndexOf('if (ELECTRON_NODE_HANDOFF?.ok === true)', spawn), spawn + 500)
  assert.match(handoff, /electronNodeHandoffEnvironment\(process\.env\)/)
  assert.match(handoff, /stdio: 'inherit'/)
  assert.match(handoff, /windowsHide: true/)
})
