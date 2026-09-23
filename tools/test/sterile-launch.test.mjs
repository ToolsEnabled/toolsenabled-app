/* THE ONE LAUNCH ENVIRONMENT, AND THE FENCE THAT PROVES IT HELD.
 *
 * tools/lib/sterile-launch.cjs is what every launcher in tools/ now builds the
 * application's environment with (the harness guard,
 * tools/test/electron-run-as-node-harness-guard.test.mjs, fails any that does
 * not). Measured 2026-08-22, three times in a day: a launch that inherited the
 * builder's LOCALAPPDATA read the builder's machine record and rewrote the
 * builder's workspace `.mcp.json` to point at the build under test -- the
 * packaged smoke run, then the next launcher in the same dist chain.
 *
 * Pinned here: what "sterile" means (every home inside the profile, the HOME
 * variables gone regardless of casing, ELECTRON_RUN_AS_NODE deleted, the rest
 * kept), that a half-described profile is refused rather than half-applied, and
 * the fence's behaviour against a temporary tree shaped like a builder's
 * machine -- never against this computer's real files.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require_ = createRequire(import.meta.url)
const {
  HOME_KEYS,
  assistantConfigTargets,
  canonicalizeCreatedQaProfile,
  changedFiles,
  createOutsideWriteFence,
  filterForeignWindowsProfilePath,
  prepareSterileProfile,
  qaProfileDirectories,
  readWorkspaceRootsFromRecord,
  selectedProductDirectory,
  servicesRootForSelectedIdentity,
  shortLinuxTmpdir,
  snapshotFiles,
  systemLaunchPath,
  sterileLaunchEnvironment,
  sterileProfileDirectories,
} = require_('../lib/sterile-launch.cjs')
const { CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES } = require_('../../shell/capability-path-environment.cjs')

async function temporaryTree(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'sterile-launch-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10 }))
  return root
}

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

const escapeForRegExp = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('Linux sterile launch redirects native homes and keeps only the desktop session connection', async t => {
  const profile = prepareSterileProfile(sterileProfileDirectories(await temporaryTree(t)))
  const base = {
    HOME: '/builder', CODEX_HOME: '/builder/.codex', CLAUDE_CONFIG_DIR: '/builder/.claude',
    XDG_CONFIG_HOME: '/builder/config', XDG_DATA_HOME: '/builder/data',
    XDG_CACHE_HOME: '/builder/cache', XDG_STATE_HOME: '/builder/state',
    XDG_CONFIG_DIRS: '/builder/extra-config', XDG_DATA_DIRS: '/builder/extra-data',
    TMPDIR: '/builder/tmp', ELECTRON_RUN_AS_NODE: '1',
    PATH: '/builder/bin:/usr/bin', DISPLAY: ':0', XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  }
  const environment = sterileLaunchEnvironment(profile, base, { platform: 'linux' })
  assert.equal(environment.HOME, profile.userProfile)
  assert.equal(environment.XDG_CONFIG_HOME, profile.appData)
  assert.equal(environment.XDG_DATA_HOME, profile.localAppData)
  assert.equal(environment.XDG_CACHE_HOME, path.join(profile.localAppData, 'cache'))
  assert.equal(environment.XDG_STATE_HOME, path.join(profile.localAppData, 'state'))
  // TMPDIR alone is no longer profile.temp: Chrome's process-singleton socket
  // binds under TMPDIR (not --user-data-dir), so it needs a short, separately
  // verified directory regardless of how deep the scratch profile is -- see
  // shortLinuxTmpdir()'s own comment in sterile-launch.cjs for the traced
  // proof. Asserting equality with a fresh call, not a hardcoded path, so
  // this does not pin which of shortLinuxTmpdir's branches fires.
  assert.equal(environment.TMPDIR, shortLinuxTmpdir())
  assert.notEqual(environment.TMPDIR, profile.temp, 'TMPDIR must not silently regress to the deep scratch profile')
  assert.equal(environment.CODEX_HOME, profile.codexHome)
  assert.equal(environment.CLAUDE_CONFIG_DIR, undefined)
  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(environment.XDG_CONFIG_DIRS, '/etc/xdg')
  assert.equal(environment.XDG_DATA_DIRS, '/usr/local/share:/usr/share')
  assert.equal(environment.DISPLAY, base.DISPLAY)
  assert.equal(environment.XDG_RUNTIME_DIR, base.XDG_RUNTIME_DIR)
  assert.equal(environment.DBUS_SESSION_BUS_ADDRESS, base.DBUS_SESSION_BUS_ADDRESS)
  assert.equal(base.HOME, '/builder', 'the parent environment is not changed')
  const systemOnly = sterileLaunchEnvironment(profile, base, { platform: 'linux', systemPathOnly: true })
  assert.equal(systemOnly.PATH, '/usr/bin:/bin')
  assert.equal(systemOnly.Path, undefined)
})

/* A builder's machine in miniature: a LOCALAPPDATA holding a machine record
   that names two workspace roots, the first of which holds the builder's own
   agent configuration -- the exact shape the defect was measured in. */
async function builderMachine(root, { productDirectory = 'ToolsEnabled' } = {}) {
  const localAppData = path.join(root, 'local')
  const userProfile = path.join(root, 'home')
  const userData = path.join(root, 'roaming', productDirectory)
  const stateRoot = path.join(userData, 'capability')
  const desktop = path.join(root, 'Desktop')
  const other = path.join(root, 'Other')
  await mkdir(path.join(localAppData, productDirectory), { recursive: true })
  await mkdir(desktop, { recursive: true })
  await mkdir(other, { recursive: true })
  await mkdir(userProfile, { recursive: true })
  await writeFile(
    path.join(localAppData, productDirectory, 'machine.json'),
    JSON.stringify({ schemaVersion: 1, workspaceRoots: [desktop, other, 'relative-is-ignored', 42] }),
  )
  const mine = '{"mcpServers":{"mine":{"command":"node","args":["mine.js"]}}}\n'
  await writeFile(path.join(desktop, '.mcp.json'), mine)
  return {
    env: {
      LOCALAPPDATA: localAppData,
      USERPROFILE: userProfile,
      TOOLSENABLED_STATE_ROOT: stateRoot,
      Path: 'C:\\Windows',
      APPVEYOR: 'yes',
    },
    localAppData,
    userData,
    stateRoot,
    productDirectory,
    userProfile,
    desktop,
    other,
    mine,
    record: path.join(localAppData, productDirectory, 'machine.json'),
  }
}

const sameSet = (actual, expected) => assert.deepEqual(
  [...actual].map(entry => entry.toLowerCase()).sort(),
  [...expected].map(entry => entry.toLowerCase()).sort(),
)

/* ------------------------------------------------------- the environment -- */

test('S1 - every home is redirected, the HOME variables are gone regardless of casing, and the rest is kept', () => {
  const profile = sterileProfileDirectories(path.resolve('sterile-fixture-profile'))
  const plantedPathOverrides = Object.fromEntries(
    CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES.map((name, index) => [name, `C:\\foreign\\path-${index}`]),
  )
  const environment = sterileLaunchEnvironment(profile, {
    LocalAppData: 'C:\\Users\\builder\\AppData\\Local',
    AppData: 'C:\\Users\\builder\\AppData\\Roaming',
    UserProfile: 'C:\\Users\\builder',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\builder',
    HOME: 'C:\\Users\\builder',
    CODEX_HOME: 'C:\\Users\\builder\\.codex',
    CLAUDE_CONFIG_DIR: 'C:\\Users\\builder\\.claude',
    Temp: 'C:\\Users\\builder\\AppData\\Local\\Temp',
    tmp: 'C:\\Users\\builder\\AppData\\Local\\Temp',
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    ELECTRON_RUN_AS_NODE: '1',
    electron_no_attach_console: '1',
    ...plantedPathOverrides,
    MC_SMOKE_HEADLESS: '1',
    APPVEYOR: 'yes',
  }, { platform: 'win32' })
  for (const leaked of ['LocalAppData', 'AppData', 'UserProfile', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'Temp', 'tmp', 'ELECTRON_RUN_AS_NODE', 'electron_no_attach_console',
    ...CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES]) {
    assert.equal(leaked in environment, false, `${leaked} leaked through`)
  }
  assert.equal(environment.LOCALAPPDATA, profile.localAppData)
  assert.equal(environment.APPDATA, profile.appData)
  assert.equal(environment.USERPROFILE, profile.userProfile)
  assert.equal(environment.CODEX_HOME, profile.codexHome)
  assert.equal(environment.TEMP, profile.temp)
  assert.equal(environment.TMP, profile.temp)
  /* Kept: a GUI Electron needs these, and the launcher decides the window. */
  assert.equal(environment.Path, 'C:\\Windows\\System32')
  assert.equal(environment.SystemRoot, 'C:\\Windows')
  assert.equal(environment.APPVEYOR, 'yes')
  assert.equal(environment.MC_SMOKE_HEADLESS, '1', 'the helper does not decide window visibility; what the caller set stays')
  /* Nothing from this process leaks when a base is given. */
  assert.equal(Object.keys(environment).length, 10)
})

test('S1b - a system-only launch path drops every inherited PATH spelling without widening its allowlist', () => {
  const profile = sterileProfileDirectories(path.resolve('sterile-fixture-profile'))
  const environment = sterileLaunchEnvironment(profile, {
    PATH: 'C:\\agent-apps\\node-v22.19.0;C:\\Users\\ForeignAccount\\bin',
    Path: 'C:\\another-build-tool',
    SystemRoot: 'C:\\Windows',
    PATHEXT: '.COM;.EXE',
  }, { systemPathOnly: true, platform: 'win32' })

  assert.equal(environment.Path, systemLaunchPath({ SystemRoot: 'C:\\Windows' }))
  assert.equal('PATH' in environment, false, 'the inherited uppercase spelling must not survive beside Path')
  assert.equal(environment.Path.includes('agent-apps'), false)
  assert.equal(environment.Path.includes('ForeignAccount'), false)
  assert.equal(environment.PATHEXT, '.COM;.EXE', 'the GUI still receives required executable-extension behavior')
})

test('S1c - the default PATH drops only foreign Windows profile entries without probing them', () => {
  const accountHome = 'C:\\Users\\ToolsEnabled-Dev'
  const trustedProfileAliasRoot = 'C:\\Users\\TOOLSE~2'
  const kept = [
    'C:\\Windows\\System32',
    'C:\\Program Files\\Git\\cmd',
    'C:\\agent-apps\\node-v22.19.0',
    `${accountHome}\\AppData\\Roaming\\npm`,
    `${trustedProfileAliasRoot}\\AppData\\Local\\Temp\\qa-bin`,
  ]
  const foreign = 'C:\\Users\\Foreign-QA-Path\\bin'
  const relativeOwned = '.\\owned-bin'
  const rejectedWithoutAccess = [
    foreign,
    '..\\Foreign-QA-Path\\bin',
    '\\\\server\\share',
    '\\\\?\\C:\\Users\\Foreign-QA-Path\\bin',
    '\\\\.\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1',
    '\\??\\C:\\Users\\Foreign-QA-Path\\bin',
    '\\Device\\HarddiskVolume1',
    '\\GLOBALROOT\\Device\\HarddiskVolume1',
    '\\Global??\\C:',
    '\\DosDevices\\C:',
    '\\SystemRoot\\System32',
  ]
  const filtered = filterForeignWindowsProfilePath([...kept, relativeOwned, ...rejectedWithoutAccess].join(';'), {
    platform: 'win32',
    accountHome,
    trustedProfileAliasRoot,
    cwd: accountHome,
  })

  assert.deepEqual(filtered.split(';'), [...kept, relativeOwned])
  assert.equal(filtered.includes('Foreign-QA-Path'), false)
  for (const rejected of rejectedWithoutAccess.slice(2)) {
    assert.equal(filtered.includes(rejected), false, `${rejected} reached the driver PATH`)
  }
})

test('S2 - the two layouts name the same five homes, and a half-described profile is refused, not half-applied', () => {
  assert.deepEqual(Object.keys(sterileProfileDirectories('x')).sort(), [...HOME_KEYS].sort())
  assert.deepEqual(Object.keys(qaProfileDirectories('x')).sort(), [...HOME_KEYS].sort())
  const root = path.resolve('sterile-fixture-profile')
  const qa = qaProfileDirectories(root)
  assert.equal(qa.localAppData, path.join(root, 'local'))
  assert.equal(qa.appData, path.join(root, 'roaming'))
  assert.equal(qa.userProfile, path.join(root, 'home'))
  assert.equal(qa.codexHome, path.join(root, 'home', '.codex'))
  const standard = sterileProfileDirectories(root)
  assert.equal(standard.appData, path.join(root, 'userprofile', 'AppData', 'Roaming'))

  for (const broken of [
    undefined,
    {},
    { ...standard, codexHome: undefined },
    { ...standard, temp: '' },
    { ...standard, appData: 'relative\\roaming' },
    { ...standard, localAppData: 42 },
  ]) {
    assert.throws(() => sterileLaunchEnvironment(broken, {}), /absolute path|profile object/,
      `a profile missing a home must be refused: ${JSON.stringify(broken)}`)
    assert.throws(() => prepareSterileProfile(broken), /absolute path|profile object/)
  }
  assert.throws(() => sterileProfileDirectories(''), /profile root/)
  assert.throws(() => qaProfileDirectories(), /profile directory/)
})

test('S3 - prepareSterileProfile creates every home and hands the same object back', async (t) => {
  const root = await temporaryTree(t)
  const profile = sterileProfileDirectories(path.join(root, 'p'))
  for (const key of HOME_KEYS) assert.equal(existsSync(profile[key]), false)
  const prepared = prepareSterileProfile(profile)
  assert.equal(prepared, profile)
  for (const key of HOME_KEYS) assert.ok(await exists(profile[key]), `${key} was not created`)
  if (process.platform === 'linux') {
    for (const key of HOME_KEYS) assert.equal(fs.statSync(profile[key]).mode & 0o777, 0o700,
      `${key} must be private even when the caller has a group-writable umask`)
    assert.equal(fs.statSync(path.join(profile.userProfile, 'AppData')).mode & 0o777, 0o700,
      'new intermediate home directories must also preserve vault custody')
  }
  /* Idempotent: a second call over existing directories is fine. */
  prepareSterileProfile(profile)
})

test('S4 - the idiom the harness guard reads is performed in the helper itself, not only implied by a pattern', async () => {
  const source = await readFile(new URL('../lib/sterile-launch.cjs', import.meta.url), 'utf8')
  const code = source.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
  assert.match(code, /delete\s+environment\.ELECTRON_RUN_AS_NODE/)
  assert.match(code, /delete\s+environment\.ELECTRON_NO_ATTACH_CONSOLE/)
})

test('S5 - an independently trusted Dev profile alias is canonicalized before QA paths are recorded', () => {
  const accountHome = 'C:\\Users\\ToolsEnabled-Dev'
  const trustedProfileAliasRoot = 'C:\\Users\\TOOLSE~2'
  const selected = `${trustedProfileAliasRoot}\\AppData\\Local\\Temp\\qa-owned\\profile`
  const canonical = `${accountHome}\\AppData\\Local\\Temp\\qa-owned\\profile`
  const visited = []

  assert.equal(canonicalizeCreatedQaProfile(selected, {
    platform: 'win32',
    accountHome,
    trustedProfileAliasRoot,
    realpath(value) {
      visited.push(value)
      return value === accountHome ? accountHome : canonical
    },
  }), canonical)
  assert.deepEqual(visited, [selected, accountHome], 'only the admitted profile and owned account root may be resolved')
})

test('S6 - foreign and untrusted Windows profile roots refuse before any filesystem access', () => {
  const accountHome = 'C:\\Users\\ToolsEnabled-Dev'
  const trustedProfileAliasRoot = 'C:\\Users\\TOOLSE~2'
  for (const selected of [
    'C:\\Users\\ForeignAccount\\AppData\\Local\\Temp\\qa-owned\\profile',
    'C:\\Users\\UNTRUS~1\\AppData\\Local\\Temp\\qa-owned\\profile',
    'D:\\qa-owned\\profile',
  ]) {
    let filesystemCalls = 0
    assert.throws(() => canonicalizeCreatedQaProfile(selected, {
      platform: 'win32',
      accountHome,
      trustedProfileAliasRoot,
      realpath() {
        filesystemCalls += 1
        throw new Error('a refused path was probed')
      },
    }), /outside the authorized Windows account/)
    assert.equal(filesystemCalls, 0, `${selected} reached realpath before the account fence refused it`)
  }
})

test('S7 - canonicalization cannot redirect an accepted alias into another profile', () => {
  assert.throws(() => canonicalizeCreatedQaProfile(
    'C:\\Users\\TOOLSE~2\\AppData\\Local\\Temp\\qa-owned\\profile',
    {
      platform: 'win32',
      accountHome: 'C:\\Users\\ToolsEnabled-Dev',
      trustedProfileAliasRoot: 'C:\\Users\\TOOLSE~2',
      realpath: value => value === 'C:\\Users\\ToolsEnabled-Dev'
        ? value
        : 'C:\\Users\\ForeignAccount\\AppData\\Local\\Temp\\qa-owned\\profile',
    },
  ), /did not resolve inside the authorized Windows account/)
})

/* ------------------------------------------------------------- the fence -- */

test('F1 - the targets are the files a launch with the inherited environment would write', async (t) => {
  const root = await temporaryTree(t)
  const m = await builderMachine(root)
  const cwd = path.join(root, 'cwd')
  const appDirectory = path.join(root, 'release', 'win-unpacked')

  const targets = assistantConfigTargets({ env: m.env, cwd, appDirectory })
  sameSet(targets, [
    m.record,
    path.join(m.desktop, '.mcp.json'),
    path.join(m.other, '.mcp.json'),
    path.join(m.userProfile, 'Documents', 'AI Workspace', '.mcp.json'),
    path.join(m.userProfile, 'OneDrive', 'Documents', 'AI Workspace', '.mcp.json'),
    path.join(cwd, '.mcp.json'),
    path.join(appDirectory, '.mcp.json'),
  ])
  for (const target of targets) assert.ok(path.isAbsolute(target), `${target} is not absolute`)
})

test('F1b - a renamed product fences its derived service root and ignores the shipping-name decoy', async (t) => {
  const root = await temporaryTree(t)
  const m = await builderMachine(root, { productDirectory: 'Renamed Preview Build' })
  const decoyWorkspace = path.join(root, 'decoy-workspace')
  const decoyRecord = path.join(m.localAppData, 'ToolsEnabled', 'machine.json')
  await mkdir(path.dirname(decoyRecord), { recursive: true })
  await mkdir(decoyWorkspace, { recursive: true })
  await writeFile(decoyRecord, JSON.stringify({ schemaVersion: 1, workspaceRoots: [decoyWorkspace] }))

  const targets = assistantConfigTargets({ env: m.env, cwd: null, appDirectory: null })
  const lowered = targets.map(target => target.toLowerCase())
  assert.ok(lowered.includes(m.record.toLowerCase()), 'the selected renamed-product record was not fenced')
  assert.ok(lowered.includes(path.join(m.desktop, '.mcp.json').toLowerCase()), 'the selected record was not read')
  assert.ok(!lowered.includes(decoyRecord.toLowerCase()), 'the hardcoded shipping-name record was still fenced')
  assert.ok(!lowered.includes(path.join(decoyWorkspace, '.mcp.json').toLowerCase()), 'the hardcoded shipping-name record was still read')
})

test('F1c - state-root identity survives a different machine root and conflicting product identities fail before reads', { skip: process.platform !== 'win32' }, () => {
  const environment = {
    LOCALAPPDATA: String.raw`X:\Profiles\Owner\AppData\Local`,
    USERPROFILE: String.raw`X:\Profiles\Owner`,
    TOOLSENABLED_STATE_ROOT: String.raw`D:\Portable State\Acme Preview\capability`,
  }
  const expected = String.raw`X:\Profiles\Owner\AppData\Local\Acme Preview`
  assert.equal(selectedProductDirectory({ env: environment }), 'Acme Preview')
  assert.equal(servicesRootForSelectedIdentity({ env: environment }), expected)

  let inspected = null
  assistantConfigTargets({
    env: environment,
    selectedUserData: String.raw`E:\Another Machine\Acme Preview`,
    cwd: null,
    appDirectory: null,
    readRecord: file => { inspected = file; return [] },
  })
  assert.equal(inspected, path.join(expected, 'machine.json'),
    'the LOCALAPPDATA root may move, but the selected product directory must not')

  inspected = null
  assert.throws(() => assistantConfigTargets({
    env: environment,
    selectedUserData: String.raw`E:\Another Machine\Different Product`,
    cwd: null,
    appDirectory: null,
    readRecord: file => { inspected = file; return [] },
  }), error => error?.code === 'STERILE_LAUNCH_IDENTITY_UNAVAILABLE'
      && /different products/.test(error.message))
  assert.equal(inspected, null, 'a product-identity conflict reached the filesystem reader')
})

test('F2 - missing identity/local state and could-not-read remain explicit, while true absence stays absent', async (t) => {
  const root = await temporaryTree(t)
  const home = path.join(root, 'home')
  let reads = 0

  assert.throws(
    () => assistantConfigTargets({
      env: { USERPROFILE: home },
      configuredProductDirectory: '',
      cwd: null,
      appDirectory: null,
      readRecord: () => { reads += 1; return [] },
    }),
    (error) => {
      assert.equal(error.code, 'STERILE_LAUNCH_IDENTITY_UNAVAILABLE')
      assert.match(error.message, /no selected state root\/userData/)
      return true
    },
  )
  assert.equal(reads, 0, 'missing identity reached the filesystem reader')

  const selectedStateRoot = path.join(root, 'roaming', 'Named Product', 'capability')
  assert.throws(
    () => assistantConfigTargets({
      env: { USERPROFILE: home, TOOLSENABLED_STATE_ROOT: selectedStateRoot },
      platform: 'win32',
      cwd: null,
      appDirectory: null,
      readRecord: () => { reads += 1; return [] },
    }),
    error => error?.code === 'STERILE_LAUNCH_IDENTITY_UNAVAILABLE' && /LOCALAPPDATA/.test(error.message),
  )
  assert.equal(reads, 0, 'missing LOCALAPPDATA reached the filesystem reader')

  /* CONTROL: ENOENT is the one result that really does establish absence. It
     still produces the original three targets, and calls are not latched. */
  const absentEnvironment = {
    USERPROFILE: path.join(root, 'nobody'),
    LOCALAPPDATA: path.join(root, 'local'),
    TOOLSENABLED_STATE_ROOT: selectedStateRoot,
  }
  const absent = assistantConfigTargets({ env: absentEnvironment, cwd: null, appDirectory: null })
  assert.equal(absent.length, 3)
  assert.equal(assistantConfigTargets({ env: absentEnvironment, cwd: null, appDirectory: null }).length, 3)

  const malformedRecord = path.join(absentEnvironment.LOCALAPPDATA, 'Named Product', 'machine.json')
  await mkdir(path.dirname(malformedRecord), { recursive: true })
  await writeFile(malformedRecord, 'this is not a record')
  assert.throws(
    () => assistantConfigTargets({ env: absentEnvironment, cwd: null, appDirectory: null }),
    error => error?.code === 'STERILE_LAUNCH_RECORD_UNKNOWN'
      && /NOT claiming the record is absent/.test(error.message)
      && error.cause instanceof SyntaxError,
  )

  /* The operating-system could-not-look case has the same explicit outcome;
     in particular EMFILE must never become the empty workspace-root list. */
  const busy = new Error('file table busy')
  busy.code = 'EMFILE'
  const originalReadFileSync = fs.readFileSync
  fs.readFileSync = () => { throw busy }
  try {
    assert.throws(() => readWorkspaceRootsFromRecord(path.join(root, 'busy-machine.json')), (error) => {
      assert.equal(error.code, 'STERILE_LAUNCH_RECORD_UNKNOWN')
      assert.equal(error.cause, busy)
      assert.match(error.message, /NOT claiming the record is absent/)
      return true
    })
  } finally {
    fs.readFileSync = originalReadFileSync
  }
})

test('F3 - duplicates collapse, so one file is snapshotted once', async (t) => {
  const root = await temporaryTree(t)
  const m = await builderMachine(root)
  const targets = assistantConfigTargets({ env: m.env, cwd: m.desktop, appDirectory: m.desktop })
  const lowered = targets.map(entry => entry.toLowerCase())
  assert.equal(new Set(lowered).size, lowered.length, 'a target was listed twice')
  assert.ok(lowered.includes(path.join(m.desktop, '.mcp.json').toLowerCase()))
})

test('F4 - the fence passes when nothing changed, including files absent before and after', async (t) => {
  const root = await temporaryTree(t)
  const m = await builderMachine(root)
  const fence = createOutsideWriteFence({ env: m.env, cwd: path.join(root, 'cwd'), appDirectory: path.join(root, 'app') })
  await fence.arm()
  assert.deepEqual(await fence.check(), { changed: [] })
  const snapshot = await snapshotFiles([path.join(m.other, '.mcp.json'), path.join(m.desktop, '.mcp.json')])
  assert.equal(snapshot.get(path.join(m.other, '.mcp.json')), null)
  assert.equal(snapshot.get(path.join(m.desktop, '.mcp.json')).toString('utf8'), m.mine)
})

test('F5 - a changed, a created and a deleted file each refuse, naming the file and the label', async (t) => {
  const root = await temporaryTree(t)
  const m = await builderMachine(root)
  const desktopConfig = path.join(m.desktop, '.mcp.json')
  const otherConfig = path.join(m.other, '.mcp.json')

  await t.test('changed: the measured defect, a workspace .mcp.json repointed at a build', async () => {
    const fence = createOutsideWriteFence({ env: m.env, cwd: null, appDirectory: null, label: 'phase B' })
    await fence.arm()
    await writeFile(desktopConfig, '{"mcpServers":{"toolsenabled":{"command":"C:\\\\release-cut\\\\win-unpacked\\\\ToolsEnabled.exe"}}}\n')
    await assert.rejects(fence.check(), (error) => {
      assert.match(error.message, /phase B changed 1 file\(s\) OUTSIDE its sterile profile/)
      assert.ok(error.message.toLowerCase().includes(desktopConfig.toLowerCase()), `the refusal must name ${desktopConfig}`)
      assert.ok(!error.message.toLowerCase().includes(otherConfig.toLowerCase()), 'an untouched file was named as changed')
      assert.match(error.message, /sterileLaunchEnvironment\(\)/, 'the refusal must say what fixes it')
      return true
    })
    await writeFile(desktopConfig, m.mine)
  })

  await t.test('created: a default folder provisioned during the run', async () => {
    const provisioned = path.join(m.userProfile, 'Documents', 'AI Workspace', '.mcp.json')
    const fence = createOutsideWriteFence({ env: m.env, cwd: null, appDirectory: null })
    await fence.arm()
    await mkdir(path.dirname(provisioned), { recursive: true })
    await writeFile(provisioned, '{"mcpServers":{}}\n')
    await assert.rejects(fence.check(), new RegExp(escapeForRegExp(provisioned), 'i'))
    await rm(path.dirname(provisioned), { recursive: true, force: true })
  })

  await t.test('deleted: a record that disappears is as much a change as one that is rewritten', async () => {
    const fence = createOutsideWriteFence({ env: m.env, cwd: null, appDirectory: null })
    await fence.arm()
    const record = await readFile(m.record)
    await rm(m.record)
    await assert.rejects(fence.check(), new RegExp(escapeForRegExp(m.record), 'i'))
    await writeFile(m.record, record)
  })

  await t.test('the comparison helper is the same one the fence uses', () => {
    const before = new Map([['a', Buffer.from('x')], ['b', null], ['c', Buffer.from('same')]])
    const after = new Map([['a', Buffer.from('y')], ['b', Buffer.from('now')], ['c', Buffer.from('same')]])
    assert.deepEqual(changedFiles(before, after), ['a', 'b'])
    assert.deepEqual(changedFiles(before, before), [])
  })
})

test('F6 - a fence checked before it is armed refuses rather than comparing against nothing', async () => {
  const fence = createOutsideWriteFence({ targets: [] })
  await assert.rejects(fence.check(), /before it was armed/)
})

test('F7 - deleting a watched path that could not be read is detected, not collapsed into continued absence', async (t) => {
  const root = await temporaryTree(t)
  const unreadable = path.join(root, '.mcp.json')
  await mkdir(unreadable)
  const fence = createOutsideWriteFence({ targets: [unreadable] })
  await fence.arm()
  await rm(unreadable, { recursive: true })
  await assert.rejects(fence.check(), new RegExp(escapeForRegExp(unreadable)))
})

test('the inside-agent probe asks the measured payload where its service record belongs', async () => {
  const source = await readFile(new URL('../agent-inside-probe.mjs', import.meta.url), 'utf8')
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.match(code, /const USER_DATA = path\.join\(SCRATCH, 'probe-userdata'\)/)
  assert.match(code, /process\.env\.TOOLSENABLED_STATE_ROOT = path\.join\(USER_DATA, 'capability'\)/)
  assert.match(code, /const servicesRoot = machineRecord\.resolveServicesRoot\(\{\}\)/)
  assert.doesNotMatch(code, /path\.join\(process\.env\.LOCALAPPDATA, ['"]ToolsEnabled['"]\)/,
    'the probe restored the literal shipping service root')
})


test('R126 - canonical account-root comparison handles both alias directions and equal roots', () => {
  const longRoot = 'C:\\Users\\ToolsEnabled-Dev'
  const shortRoot = 'C:\\Users\\TOOLSE~1'
  for (const [accountHome, canonicalRoot] of [[shortRoot, longRoot], [longRoot, shortRoot], [longRoot, longRoot]]) {
    const selected = `${accountHome}\\AppData\\Local\\Temp\\qa-owned\\profile`
    const canonical = `${canonicalRoot}\\AppData\\Local\\Temp\\qa-owned\\profile`
    const visited = []
    assert.equal(canonicalizeCreatedQaProfile(selected, {
      platform: 'win32', accountHome,
      realpath: value => { visited.push(value); return value === accountHome ? canonicalRoot : canonical },
    }), canonical)
    assert.deepEqual(visited, [selected, accountHome])
  }
})

test('R126d - Linux rejects Windows-shaped paths before resolving them', () => {
  let calls = 0
  assert.throws(() => canonicalizeCreatedQaProfile(
    'C:\\Users\\ToolsEnabled-Dev\\AppData\\Local\\Temp\\qa-synthetic',
    { platform: 'linux', realpath: () => { calls++; return '/synthetic-return' } },
  ), /profile must be an absolute path/)
  assert.equal(calls, 0)
})

test('R126e - Linux resolves an admitted absolute POSIX profile exactly once', () => {
  const visited = []
  assert.equal(canonicalizeCreatedQaProfile('/tmp/qa-synthetic', {
    platform: 'linux',
    realpath: value => { visited.push(value); return '/tmp/qa-canonical' },
  }), '/tmp/qa-canonical')
  assert.deepEqual(visited, ['/tmp/qa-synthetic'])
})
