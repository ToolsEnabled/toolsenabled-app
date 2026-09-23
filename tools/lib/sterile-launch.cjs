'use strict'

/* THE ONE ENVIRONMENT A HARNESS MAY LAUNCH THE APPLICATION WITH.
 *
 * THE DEFECT, MEASURED 2026-08-22, THREE TIMES. Launching ANY build of the
 * application with the builder's own environment -- however fresh its
 * --user-data-dir -- rewrote the builder's workspace `.mcp.json` so that its
 * three tool servers pointed at whatever build directory that instance ran from.
 * First the packaged smoke run; then, after that run was isolated, the very next
 * launcher in the same `npm run dist` chain (tools/check-install-dir-immutable.mjs,
 * phase B) did it again at 16:40:55. Every later agent session in that workspace
 * then started its servers from the build output, held the executable open, and
 * the next `npm run dist` refused to replace it.
 *
 * WHY A FRESH PROFILE IS NOT A FRESH INSTALL. The machine record the shell reads
 * does not live in the Electron profile. It lives in
 * %LOCALAPPDATA%\<productDirectory>, where productDirectory is derived from the
 * selected <userData>/capability state root. A child that inherits LOCALAPPDATA
 * can therefore read the builder's record for that selected product identity,
 * find the workspace it names, and on every launch shell/setup-record.cjs
 * refreshChosenAssistantConfig rewrites that workspace's `.mcp.json` from the
 * running build. USERPROFILE, APPDATA and CODEX_HOME carry the rest of a
 * person's state the same way.
 *
 * THE RULE, AND WHY IT IS ONE FILE. Seventeen launchers in tools/ each built
 * their own child environment, and they disagreed: some redirected LOCALAPPDATA
 * and USERPROFILE, some only deleted ELECTRON_RUN_AS_NODE, one ran against the
 * builder's real %APPDATA%. A rule that lives in seventeen places is seventeen
 * chances to be wrong, and the eighteenth launcher written next week inherits
 * none of them. So the environment is built HERE, every launcher calls this, and
 * tools/test/electron-run-as-node-harness-guard.test.mjs fails any tools/
 * launcher whose spawn does not pass through sterileLaunchEnvironment().
 *
 * WHAT "STERILE" MEANS HERE, EXACTLY:
 *   - LOCALAPPDATA, APPDATA, USERPROFILE, CODEX_HOME, TEMP and TMP name
 *     directories inside a per-run profile the caller owns;
 *   - HOME, HOMEDRIVE, HOMEPATH and CLAUDE_CONFIG_DIR are removed, so nothing
 *     can resolve the builder's home by another name -- matched without regard
 *     to case, because a spread of process.env keeps whatever casing Windows
 *     handed over and a second key differing only in case is a second answer;
 *   - on Linux, the child gets a fresh HOME and XDG config/data/cache/state
 *     directories after that scrub. Merely unsetting HOME would let Node
 *     recover the builder's real home from passwd. Desktop session connection
 *     variables stay available; a system-only PATH uses Linux system paths;
 *   - ELECTRON_RUN_AS_NODE and ELECTRON_NO_ATTACH_CONSOLE are deleted, in the
 *     idiom the harness guard recognises, so a GUI launch cannot silently become
 *     a headless Node process;
 *   - everything else is KEPT. A GUI Electron needs more of the environment
 *     than the Node-mode capability layer does (SystemRoot, PATH, the processor
 *     variables, PATHEXT). PATH keeps Windows, Program Files, external tool
 *     roots and this account's own entries, but entries that lexically name a
 *     different Windows profile are removed without probing them. A launcher
 *     that needs no tools at all can opt into the system-only PATH below.
 *
 * It does NOT decide whether a window is shown (MC_SMOKE_HEADLESS). The default
 * PATH remains useful but account-fenced; system-only mode is explicit.
 *
 * ONE NARROW REAL-PROVIDER VARIANT lives here too:
 * providerAuthenticatedLaunchEnvironment(). A provider-real proof cannot invent
 * USERPROFILE because the product must prove that the runtime and token belong
 * to the checkout owner, and it must be able to find that owner's existing
 * provider sign-in. That helper keeps USERPROFILE/CODEX_HOME on an explicitly
 * supplied account root, redirects APPDATA/LOCALAPPDATA/TEMP to a supplied
 * one-shot root inside that account, and still removes every inherited home.
 * The application itself must additionally receive a one-shot --user-data-dir.
 *
 * THE FENCE BESIDE IT is the proof the rule holds. createOutsideWriteFence()
 * snapshots the files a launch with the INHERITED environment would have
 * written -- the builder's machine record and every workspace `.mcp.json` it
 * names -- and refuses the run if any of them changed. A redirect can regress
 * silently; a fence cannot pass over a rewritten file.
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { isCapabilityPathOverrideEnvironmentName } = require('../../shell/capability-path-environment.cjs')
const packageIdentity = require('../../package.json')

const HOME_KEYS = Object.freeze(['localAppData', 'appData', 'userProfile', 'codexHome', 'temp'])
const HOME_VARIABLES = /^(localappdata|appdata|userprofile|home|homedrive|homepath|codex_home|claude_config_dir|temp|tmp)$/i
const LINUX_HOME_VARIABLES = /^(xdg_(config|cache|data|state)_home|xdg_(config|data)_dirs|tmpdir)$/i
const NODE_MODE_VARIABLES = /^(electron_run_as_node|electron_no_attach_console)$/i
const PATH_VARIABLE = /^path$/i
const CONFIGURED_PRODUCT_DIRECTORY = String(
  packageIdentity?.build?.productName || packageIdentity?.productName || '',
).trim()
const {
  insideWindowsPath,
  usesUnsupportedWindowsPathNamespace,
  windowsProfileReferences,
} = require('../../shell/install-profile-guard.cjs')

/* The default layout, under one root the caller owns: `localappdata`,
 * `userprofile` (with `AppData\Roaming` inside it, where Windows would put it),
 * `codexhome`, `temp`. tools/smoke-packaged.mjs and
 * tools/check-install-dir-immutable.mjs use this shape. */
function sterileProfileDirectories(root) {
  if (typeof root !== 'string' || !root) throw new Error('sterileProfileDirectories: a profile root is required')
  return {
    localAppData: path.join(root, 'localappdata'),
    userProfile: path.join(root, 'userprofile'),
    codexHome: path.join(root, 'codexhome'),
    temp: path.join(root, 'temp'),
    appData: path.join(root, 'userprofile', 'AppData', 'Roaming'),
  }
}

/* The layout the QA harnesses already use -- `local`, `roaming`, `home`,
 * `home\.codex` -- kept as a second named shape rather than migrated, because
 * those harnesses seed a machine record into
 * `<profile>\local\<selected-product-directory>` and read their workspace out
 * of `<profile>\home` by these names. Only `temp` is new to them. */
function qaProfileDirectories(profile) {
  if (typeof profile !== 'string' || !profile) throw new Error('qaProfileDirectories: a profile directory is required')
  return {
    localAppData: path.join(profile, 'local'),
    appData: path.join(profile, 'roaming'),
    userProfile: path.join(profile, 'home'),
    codexHome: path.join(profile, 'home', '.codex'),
    temp: path.join(profile, 'temp'),
  }
}

function windowsProfileRoot(value) {
  const selected = path.win32.normalize(String(value || ''))
  const match = /^([a-z]:\\users\\[^\\]+)(?:\\|$)/i.exec(selected)
  return match ? match[1] : null
}

/* Canonicalize only a QA directory the caller just created. Windows may hand a
 * Dev-token process its own Temp through an 8.3 profile spelling; recording
 * that spelling in machine.json makes the product's later long-profile fence
 * correctly mistake it for another account. The alias is accepted only when a
 * separate account guard has already proved it is the authorized profile's
 * exact short root. A foreign long root or any other alias is refused before
 * realpath is called, so this helper never probes a rejected profile. */
function canonicalizeCreatedQaProfile(profile, {
  platform = process.platform,
  accountHome = os.homedir(),
  trustedProfileAliasRoot = null,
  realpath = fs.realpathSync.native,
} = {}) {
  const profilePath = platform === 'win32' ? path.win32 : path.posix
  if (typeof profile !== 'string' || !profile || !profilePath.isAbsolute(profile)) {
    throw new Error('canonicalizeCreatedQaProfile: profile must be an absolute path')
  }
  if (platform !== 'win32') return realpath(profile)
  const ownedRoot = windowsProfileRoot(accountHome)
  const selectedRoot = windowsProfileRoot(profile)
  const trustedAlias = windowsProfileRoot(trustedProfileAliasRoot)
  const same = (left, right) => Boolean(left && right
    && path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase())
  if (!ownedRoot || !selectedRoot || (!same(selectedRoot, ownedRoot) && !same(selectedRoot, trustedAlias))) {
    throw new Error('canonicalizeCreatedQaProfile: the created profile is outside the authorized Windows account')
  }
  const canonical = realpath(profile)
  const canonicalOwnedRoot = windowsProfileRoot(realpath(accountHome))
  if (!same(windowsProfileRoot(canonical), canonicalOwnedRoot)) {
    throw new Error('canonicalizeCreatedQaProfile: the created profile did not resolve inside the authorized Windows account')
  }
  return canonical
}

function assertProfile(profile, caller) {
  if (!profile || typeof profile !== 'object') {
    throw new Error(`${caller}: a profile object naming ${HOME_KEYS.join(', ')} is required`)
  }
  for (const key of HOME_KEYS) {
    const value = profile[key]
    if (typeof value !== 'string' || !value || !path.isAbsolute(value)) {
      throw new Error(`${caller}: profile.${key} must be an absolute path; a half-redirected home is the builder's home`)
    }
  }
}

/* Create every home before the spawn -- a home that does not exist reads to
 * the shell as "nothing here", which is the right answer, but Chromium wants a
 * TEMP it can write -- and hand the same object back for the environment. */
function prepareSterileProfile(profile) {
  assertProfile(profile, 'prepareSterileProfile')
  // Linux vault custody rejects writable ancestors even beneath a private
  // outer scratch. A developer's group-writable umask must not make the
  // fresh harness profile unusable before the native test can start.
  for (const key of HOME_KEYS) fs.mkdirSync(profile[key], { recursive: true, mode: 0o700 })
  return profile
}

function systemLaunchPath(base = process.env) {
  const systemRoot = typeof base.SystemRoot === 'string' && path.win32.isAbsolute(base.SystemRoot)
    ? base.SystemRoot
    : 'C:\\Windows'
  return [
    path.win32.join(systemRoot, 'System32'),
    systemRoot,
    path.win32.join(systemRoot, 'System32', 'Wbem'),
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  ].join(path.win32.delimiter)
}

/* Remove only PATH entries that name another Windows profile. This is lexical:
 * a rejected entry is never statted, resolved, enumerated or followed. External
 * tools under Windows, Program Files or a product-owned root stay available. */
function filterForeignWindowsProfilePath(value, {
  platform = process.platform,
  accountHome = os.homedir(),
  trustedProfileAliasRoot = null,
  cwd = process.cwd(),
} = {}) {
  if (typeof value !== 'string' || platform !== 'win32') return value
  const normalizeRoot = candidate => {
    if (typeof candidate !== 'string' || !path.win32.isAbsolute(candidate)) return null
    return path.win32.normalize(candidate).replace(/[\\/]+$/, '').toLowerCase()
  }
  const allowedRoots = [accountHome, trustedProfileAliasRoot].map(normalizeRoot).filter(Boolean)
  const trustedCwd = typeof cwd === 'string' && path.win32.isAbsolute(cwd)
      && !usesUnsupportedWindowsPathNamespace(cwd)
    ? path.win32.normalize(cwd)
    : null
  return value.split(path.win32.delimiter).filter(entry => {
    const trimmed = entry.trim()
    if (usesUnsupportedWindowsPathNamespace(trimmed)) return false
    let selected = trimmed
    if (selected.length >= 2 && selected.startsWith('"') && selected.endsWith('"')) {
      selected = selected.slice(1, -1).trim()
    }
    if (!path.win32.isAbsolute(selected)) {
      if (!trustedCwd) return false
      selected = path.win32.resolve(trustedCwd, selected || '.')
    }
    if (usesUnsupportedWindowsPathNamespace(selected)) return false
    const references = windowsProfileReferences(selected, accountHome)
    if (references.length === 0) return true
    if (allowedRoots.length === 0) return false
    return references.every(reference => allowedRoots.includes(normalizeRoot(reference)))
  }).join(path.win32.delimiter)
}

// A pathname unix socket's sockaddr_un.sun_path is a fixed 108-byte field
// INCLUDING its NUL terminator (unix(7)). Chrome's ProcessSingleton does NOT
// bind that socket under --user-data-dir: it creates a SHORT scoped_dir
// under TMPDIR, binds the real socket there, and only symlinks
// <profile>/SingletonSocket to it. Profile depth is therefore not the
// constraint; TMPDIR depth is.
//
// Measured directly with strace, app.requestSingleInstanceLock() genuinely
// called (a synthetic net.listen() on a constructed path proves only Node's
// own path handling, not Chrome's): a deep TMPDIR with a SHORT profile still
// crashed loud at chrome/browser/process_singleton_posix.cc:315 ("Socket
// path too long"), naming exactly $TMPDIR/scoped_dirXXXXXX/SingletonSocket;
// the same deep profile with TMPDIR pointed at a verified /run/user/<uid>
// instead acquired the singleton lock and bound the socket successfully
// (bind(sun_path="/run/user/<uid>/scoped_dirXXXXXX/SingletonSocket")=0).
//
// This is why sterileLaunchEnvironment's own scratch isolation is preserved
// unchanged (TEMP/TMP/LOCALAPPDATA/APPDATA/USERPROFILE/CODEX_HOME all still
// live under the caller's private, per-run scratchRoot) while only TMPDIR
// gets a short, separately-verified, still-private directory: /run/user/
// <uid> is systemd-logind-managed tmpfs, private to this exact account
// (owner-host-linux.js in the engine repo already requires the identical
// ownership/mode/not-a-symlink trust shape for its own socket directory),
// short by construction, and unrelated to how deep the caller's scratch root
// is. A refusal fires only when neither that nor a short ambient os.tmpdir()
// is available -- the operation genuinely cannot be made to work, not the
// default answer.
function shortLinuxTmpdir({
  getuid = (typeof process.getuid === 'function' ? process.getuid.bind(process) : null),
  statSync = fs.lstatSync,
  tmpdir = os.tmpdir,
} = {}) {
  const uid = getuid ? getuid() : null
  if (uid !== null) {
    const runUserDir = `/run/user/${uid}`
    try {
      const stat = statSync(runUserDir)
      if (stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o777) === 0o700) {
        return runUserDir
      }
    } catch { /* not present on this host; fall through to the ambient check */ }
  }
  const ambient = tmpdir()
  if (Buffer.byteLength(ambient, 'utf8') <= 60) return ambient
  const error = new Error(
    `Neither /run/user/${uid ?? '<uid>'} nor the system temp directory (${ambient}, ` +
    `${Buffer.byteLength(ambient, 'utf8')} bytes) is short enough for Chrome's process-singleton socket ` +
    "(sockaddr_un.sun_path allows 107 usable bytes, and Chrome's own scoped directory and socket name need " +
    'about 33 of them). No sterile Linux launch environment could be constructed.'
  )
  error.code = 'STERILE_LAUNCH_NO_SHORT_TMPDIR'
  throw error
}

function sterileLaunchEnvironment(profile, base = process.env, {
  systemPathOnly = false,
  platform = process.platform,
  accountHome = os.homedir(),
  trustedProfileAliasRoot = null,
  cwd = process.cwd(),
} = {}) {
  assertProfile(profile, 'sterileLaunchEnvironment')
  const environment = {}
  for (const [key, value] of Object.entries(base)) {
    if (HOME_VARIABLES.test(key) || NODE_MODE_VARIABLES.test(key) || PATH_VARIABLE.test(key)
        || (platform === 'linux' && LINUX_HOME_VARIABLES.test(key))
        || isCapabilityPathOverrideEnvironmentName(key)) continue
    environment[key] = value
  }
  if (!systemPathOnly) {
    for (const [key, value] of Object.entries(base)) {
      if (PATH_VARIABLE.test(key)) {
        environment[key] = filterForeignWindowsProfilePath(value, {
          platform,
          accountHome,
          trustedProfileAliasRoot,
          cwd,
        })
      }
    }
  } else {
    if (platform === 'linux') environment.PATH = '/usr/bin:/bin'
    else environment.Path = systemLaunchPath(base)
  }
  environment.LOCALAPPDATA = profile.localAppData
  environment.APPDATA = profile.appData
  environment.USERPROFILE = profile.userProfile
  environment.CODEX_HOME = profile.codexHome
  environment.TEMP = profile.temp
  environment.TMP = profile.temp
  if (platform === 'linux') {
    // Removing HOME is not isolation on Linux: os.homedir() then consults
    // passwd and finds the real account again. These are child-only homes;
    // the invoking shell and the person's existing configuration are untouched.
    environment.HOME = profile.userProfile
    environment.XDG_CONFIG_HOME = profile.appData
    environment.XDG_DATA_HOME = profile.localAppData
    environment.XDG_CACHE_HOME = path.join(profile.localAppData, 'cache')
    environment.XDG_STATE_HOME = path.join(profile.localAppData, 'state')
    environment.XDG_CONFIG_DIRS = '/etc/xdg'
    environment.XDG_DATA_DIRS = '/usr/local/share:/usr/share'
    // TMPDIR alone -- not TEMP/TMP above, which stay on profile.temp and keep
    // isolating exactly as before. Node's os.tmpdir() on POSIX reads only
    // TMPDIR, and this is specifically Chrome's process-singleton constraint:
    // see shortLinuxTmpdir()'s own comment for the traced proof that a deep
    // TMPDIR -- not a deep --user-data-dir -- is what breaks the bind.
    environment.TMPDIR = shortLinuxTmpdir()
  }
  /* Already absent by the loop above; stated again in the exact idiom
     tools/test/electron-run-as-node-harness-guard.test.mjs recognises, so the
     strip is visible where the guard looks for it rather than implied by a
     regular expression three lines up. */
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_NO_ATTACH_CONSOLE
  return environment
}

// A local DEV/CUT snapshot can isolate build files without owning the OS
// account's authentication or installed-product lifecycle. This marker only
// restricts a shared session; no environment value can attest to a disposable
// worker or replace the release registry's missing qualification adapters.
function assertSharedHostQualificationAllowed(base = process.env) {
  const restricted = [base, process.env].some(environment => Object.keys(environment || {}).some(name =>
    /^(TOOLSENABLED_SHARED_HOST_SESSION|TOOLSENABLED_PROVIDER_ISOLATION_ROOT)$/i.test(name)))
  if (restricted) {
    const error = new Error('Real provider and installed-product qualification cannot run inside a shared DEV/CUT session. Use a dedicated disposable worker with its own sign-in and the required qualification adapters. No owner provider home was used.')
    error.code = 'QA_DISPOSABLE_WORKER_REQUIRED'
    throw error
  }
}

/* The only supported mixed identity/isolation launch: retain the exact account
 * identity needed by a real provider while redirecting every unrelated account
 * store to one-shot directories. This is intentionally a separate function so
 * an ordinary QA harness cannot accidentally weaken "sterile" by passing the
 * builder's real homes into sterileLaunchEnvironment() directly. */
function providerAuthenticatedLaunchEnvironment(identity, base = process.env, options = {}) {
  assertSharedHostQualificationAllowed(base)
  const { accountHome, scratchRoot } = identity || {}
  const { platform = process.platform, cwd = process.cwd(), trustedProfileAliasRoot = null } = options
  if (typeof accountHome !== 'string' || !accountHome || !path.isAbsolute(accountHome)) {
    throw new Error('providerAuthenticatedLaunchEnvironment: accountHome must be an absolute path')
  }
  if (typeof scratchRoot !== 'string' || !scratchRoot || !path.isAbsolute(scratchRoot)) {
    throw new Error('providerAuthenticatedLaunchEnvironment: scratchRoot must be an absolute path')
  }
  if (platform === 'win32') {
    const owner = windowsProfileRoot(accountHome)
    const exactOwner = owner && path.win32.normalize(owner).toLowerCase() === path.win32.normalize(accountHome).toLowerCase()
    const scratchIsOwner = path.win32.normalize(scratchRoot).toLowerCase() === path.win32.normalize(accountHome).toLowerCase()
    if (!exactOwner || usesUnsupportedWindowsPathNamespace(accountHome)
        || usesUnsupportedWindowsPathNamespace(scratchRoot)
        || scratchIsOwner || !insideWindowsPath(scratchRoot, accountHome)) {
      throw new Error('providerAuthenticatedLaunchEnvironment: scratchRoot must remain inside the exact Windows account root')
    }
  }
  const profile = {
    localAppData: path.join(scratchRoot, 'localappdata'),
    appData: path.join(scratchRoot, 'appdata'),
    userProfile: accountHome,
    codexHome: path.join(accountHome, '.codex'),
    temp: path.join(scratchRoot, 'temp'),
  }
  for (const key of ['localAppData', 'appData', 'temp']) fs.mkdirSync(profile[key], { recursive: true })
  return sterileLaunchEnvironment(profile, base, {
    platform,
    accountHome,
    trustedProfileAliasRoot,
    cwd,
  })
}

/* ---------- the fence: nothing outside the profile may change ----------
 *
 * WHAT IT WATCHES. The files a launch with the INHERITED environment would have
 * written -- which is to say, the files the defect above actually rewrote:
 *   - the machine record the shell would read:
 *     %LOCALAPPDATA%\<selected-product-directory>\machine.json. The product
 *     directory comes from the selected state root/userData identity, with the
 *     build's configured productName used only for the ordinary default
 *     userData case. Resolved here by the rule the engine's
 *     src/lib/setup/machine-record.js resolveServicesRoot() applies, COPIED
 *     rather than loaded: this fence must not run the payload under test to
 *     decide what the payload under test may not touch;
 *   - the `.mcp.json` in every workspace root that record names, which is the
 *     file the builder's own agent client reads;
 *   - the `.mcp.json` in the folder setup suggests by default, in both shapes
 *     that default has taken (`Documents\AI Workspace` under the profile and
 *     under OneDrive), which is what an unanswered install would provision;
 *   - the `.mcp.json` beside the caller (cwd) and beside the artifact.
 * An absent record contributes no roots. An unreadable or malformed record
 * refuses construction of the fence: omitting its roots would claim they do
 * not need watching when the machine was merely unable to tell us their names.
 *
 * WHAT IT ASSERTS. Byte identity, including absence. A file that appears, a file
 * that disappears and a file that changes are the same finding, and the finding
 * refuses the run AFTER it -- so a window that bound and a round-trip that
 * signed are still not a pass when the build reconfigured the machine it ran on.
 */
function identityUnavailable(message) {
  const error = new Error(`[sterile-launch] ${message}`)
  error.code = 'STERILE_LAUNCH_IDENTITY_UNAVAILABLE'
  return error
}

function productDirectoryFromUserData(userData, { platform = process.platform, source = 'selected userData' } = {}) {
  if (typeof userData !== 'string' || !userData.trim() || !path.isAbsolute(userData.trim())) {
    throw identityUnavailable(`${source} must be an absolute path before the outside-write fence can inspect anything.`)
  }
  const resolved = path.resolve(userData.trim())
  const productDirectory = path.basename(resolved)
  if (!productDirectory || resolved === path.parse(resolved).root) {
    throw identityUnavailable(`${source} does not name a product directory.`)
  }
  if (platform === 'win32' && usesUnsupportedWindowsPathNamespace(resolved)) {
    throw identityUnavailable(`${source} uses an unsupported Windows path namespace.`)
  }
  return productDirectory
}

/* Mirror the payload's identity rule without loading the payload under test.
 * State-root and userData declarations may live on different machines/drives;
 * their directory names must still identify the same product. A disagreement
 * refuses before readRecord() can touch either candidate. */
function selectedProductDirectory({
  env = process.env,
  selectedStateRoot = null,
  selectedUserData = null,
  configuredProductDirectory = CONFIGURED_PRODUCT_DIRECTORY,
  platform = process.platform,
} = {}) {
  const declaredStateRoot = selectedStateRoot == null
    ? (typeof env?.TOOLSENABLED_STATE_ROOT === 'string' ? env.TOOLSENABLED_STATE_ROOT.trim() : '')
    : selectedStateRoot
  const candidates = []
  if (declaredStateRoot !== '') {
    if (typeof declaredStateRoot !== 'string' || !path.isAbsolute(declaredStateRoot.trim())) {
      throw identityUnavailable('the selected state root must be an absolute path before the outside-write fence can inspect anything.')
    }
    const stateRoot = path.resolve(declaredStateRoot.trim())
    candidates.push(productDirectoryFromUserData(path.dirname(stateRoot), {
      platform,
      source: 'the userData parent of the selected state root',
    }))
  }
  if (selectedUserData != null) {
    candidates.push(productDirectoryFromUserData(selectedUserData, { platform }))
  }
  if (candidates.length === 0) {
    const configured = typeof configuredProductDirectory === 'string' ? configuredProductDirectory.trim() : ''
    if (!configured || path.basename(configured) !== configured || configured === '.' || configured === '..') {
      throw identityUnavailable('no selected state root/userData or valid configured productName identifies the product.')
    }
    candidates.push(configured)
  }
  const first = candidates[0]
  const same = (left, right) => platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
  if (candidates.some(candidate => !same(candidate, first))) {
    throw identityUnavailable('the selected state root and userData identify different products; no machine record was inspected.')
  }
  return first
}

function servicesRootForSelectedIdentity({
  env = process.env,
  selectedStateRoot = null,
  selectedUserData = null,
  configuredProductDirectory = CONFIGURED_PRODUCT_DIRECTORY,
  platform = process.platform,
  homedir = os.homedir,
} = {}) {
  const productDirectory = selectedProductDirectory({
    env,
    selectedStateRoot,
    selectedUserData,
    configuredProductDirectory,
    platform,
  })
  const localAppData = typeof env?.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : ''
  if (localAppData && path.isAbsolute(localAppData)) return path.join(localAppData, productDirectory)
  if (platform === 'win32') {
    throw identityUnavailable('LOCALAPPDATA must be an absolute path before the outside-write fence can inspect the selected product machine record.')
  }
  const xdgDataHome = typeof env?.XDG_DATA_HOME === 'string' ? env.XDG_DATA_HOME.trim() : ''
  const dataHome = xdgDataHome && path.isAbsolute(xdgDataHome)
    ? xdgDataHome
    : path.join(homedir(), '.local', 'share')
  return path.join(dataHome, productDirectory)
}

function assistantConfigTargets({
  env = process.env,
  cwd = process.cwd(),
  appDirectory = null,
  readRecord = readWorkspaceRootsFromRecord,
  selectedStateRoot = null,
  selectedUserData = null,
  configuredProductDirectory = CONFIGURED_PRODUCT_DIRECTORY,
  platform = process.platform,
  homedir = os.homedir,
} = {}) {
  const home = typeof env.USERPROFILE === 'string' && env.USERPROFILE ? env.USERPROFILE : homedir()
  const servicesRoot = servicesRootForSelectedIdentity({
    env,
    selectedStateRoot,
    selectedUserData,
    configuredProductDirectory,
    platform,
    homedir,
  })
  const record = path.join(servicesRoot, 'machine.json')
  const targets = [record]
  for (const root of readRecord(record)) targets.push(path.join(root, '.mcp.json'))
  targets.push(path.join(home, 'Documents', 'AI Workspace', '.mcp.json'))
  targets.push(path.join(home, 'OneDrive', 'Documents', 'AI Workspace', '.mcp.json'))
  if (typeof cwd === 'string' && cwd) targets.push(path.join(cwd, '.mcp.json'))
  if (typeof appDirectory === 'string' && appDirectory) targets.push(path.join(appDirectory, '.mcp.json'))
  const unique = new Map()
  for (const target of targets) {
    const resolved = path.resolve(target)
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved
    if (!unique.has(key)) unique.set(key, resolved)
  }
  return [...unique.values()]
}

function readWorkspaceRootsFromRecord(file) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (cause) {
    if (cause?.code === 'ENOENT') return []
    const error = new Error(
      `[sterile-launch] could not read the machine record at ${file}; this is NOT claiming the record is absent.`,
      { cause },
    )
    error.code = 'STERILE_LAUNCH_RECORD_UNKNOWN'
    throw error
  }
  const roots = Array.isArray(parsed?.workspaceRoots) ? parsed.workspaceRoots : []
  return roots.filter((entry) => typeof entry === 'string' && path.isAbsolute(entry))
}

/* Bytes, null for a file that is not there, or an error marker when a path
 * exists but cannot be read. Keeping the latter distinct from absence ensures
 * that deleting an unreadable path is still detected as a change. */
async function snapshotFiles(paths) {
  const snapshot = new Map()
  for (const file of paths) {
    try {
      snapshot.set(file, await fsp.readFile(file))
    } catch (error) {
      snapshot.set(file, error?.code === 'ENOENT' ? null : { readError: error?.code || 'UNKNOWN' })
    }
  }
  return snapshot
}

function changedFiles(before, after) {
  const changed = []
  for (const [file, previous] of before) {
    const current = after.has(file) ? after.get(file) : null
    if (previous === null && current === null) continue
    if (Buffer.isBuffer(previous) && Buffer.isBuffer(current) && previous.equals(current)) continue
    if (previous?.readError && previous.readError === current?.readError) continue
    changed.push(file)
  }
  return changed
}

function createOutsideWriteFence({
  env = process.env,
  cwd = process.cwd(),
  appDirectory = null,
  targets = null,
  label = 'the run',
  selectedStateRoot = null,
  selectedUserData = null,
  configuredProductDirectory = CONFIGURED_PRODUCT_DIRECTORY,
  platform = process.platform,
  homedir = os.homedir,
} = {}) {
  const watched = targets || assistantConfigTargets({
    env,
    cwd,
    appDirectory,
    selectedStateRoot,
    selectedUserData,
    configuredProductDirectory,
    platform,
    homedir,
  })
  let before = null
  return {
    targets: watched,
    async arm() { before = await snapshotFiles(watched) },
    async check() {
      if (!before) throw new Error(`[sterile-launch] the outside-write fence around ${label} was checked before it was armed`)
      const changed = changedFiles(before, await snapshotFiles(watched))
      if (changed.length === 0) return { changed }
      throw new Error(
        `[sterile-launch] ${label} changed ${changed.length} file(s) OUTSIDE its sterile profile:\n` +
        changed.map((file) => `  ${file}`).join('\n') + '\n' +
        'A build that reaches the builder\'s own machine record rewrites the workspace .mcp.json that record ' +
        'names so it points at the build under test. The run is refused rather than the release cut over a ' +
        'reconfigured machine; restore the file(s) above before re-running, and launch through ' +
        'sterileLaunchEnvironment() in tools/lib/sterile-launch.cjs.',
      )
    },
  }
}

module.exports = {
  HOME_KEYS,
  sterileProfileDirectories,
  qaProfileDirectories,
  canonicalizeCreatedQaProfile,
  prepareSterileProfile,
  systemLaunchPath,
  filterForeignWindowsProfilePath,
  shortLinuxTmpdir,
  sterileLaunchEnvironment,
  providerAuthenticatedLaunchEnvironment,
  assertSharedHostQualificationAllowed,
  selectedProductDirectory,
  servicesRootForSelectedIdentity,
  assistantConfigTargets,
  readWorkspaceRootsFromRecord,
  snapshotFiles,
  changedFiles,
  createOutsideWriteFence,
}
