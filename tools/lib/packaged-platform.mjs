/* THE FOUR ANSWERS THE PACKAGED-QA DRIVERS NEED FROM THEIR HOST, IN ONE PLACE.
 *
 * WHAT WAS MEASURED BEFORE THIS FILE EXISTED. tools/packaged-qa-suite.mjs
 * refused to start at all off Windows -- "these drivers are a Windows-host
 * harness ... porting the suite to Linux is separate work" -- and the 1.0.44
 * Linux cut recorded that refusal as step 54, exit 2, disclosed and allowed
 * through. Reading the eighty-six drivers against that sentence, the
 * Windows-shaped part was smaller than the refusal claimed and it was FOUR
 * FACTS, not eighty-six files:
 *
 *   1. WHICH FILE IS THE APPLICATION.  `ToolsEnabled.exe` on Windows, the
 *      `toolsenabled` ELF on Linux (build.linux.executableName), and the
 *      unpacked directory electron-builder writes it into -- `win-unpacked`
 *      against `linux-unpacked`. Hard-coded in two places (the suite's
 *      DEFAULT_RELEASE and test-account-harness's releaseDirectory()), so a
 *      Linux host asked for a directory that a Linux build never produces.
 *   2. HOW IT IS LAUNCHED STERILE.  tools/lib/sterile-launch.cjs already
 *      answers this for both platforms. test-account-harness's own
 *      environmentFor() did NOT: it redirected LOCALAPPDATA/APPDATA/
 *      USERPROFILE/CODEX_HOME and stopped there, which is a complete fence on
 *      Windows and half a fence on Linux, where os.homedir() recovers the real
 *      account from passwd and XDG_* still name the builder's directories.
 *   3. HOW A PROCESS TREE IS REAPED.  `taskkill.exe`, called through
 *      spawnSync inside a try/catch. Off Windows that is not a reap that
 *      fails; it is a reap that SILENTLY DOES NOTHING -- ENOENT, swallowed --
 *      so every driver's teardown would leave its Electron tree running and
 *      the next driver would inherit a machine with the last one still on it.
 *   4. WHERE ITS STATE LIVES.  The QA profile layout is already explicit
 *      (--user-data-dir, LOCALAPPDATA) and the payload's own resolver reads
 *      LOCALAPPDATA first on every platform, so this one was already right --
 *      but only as long as XDG_DATA_HOME, once set (see 2), names the SAME
 *      directory. Two homes that disagree is a machine record written to one
 *      path and read from another.
 *
 * ONE DRIVER, TWO PLATFORM ANSWERS. Nothing here forks a driver. Every
 * function takes `platform` as an argument with process.platform as its
 * default, so the Windows answers are the same answers they were and a test
 * can ask for either one on either host.
 *
 * AND THE FIFTH FACT, WHICH IS NOT A NAME BUT A PRECONDITION: on Linux a
 * packaged Electron cannot start at all unless Chromium can build its sandbox.
 * See packagedLaunchReadiness() below. It is here rather than in a driver
 * because a precondition that each driver discovers for itself is eighty-six
 * timeouts, which is the exact failure this suite's own header calls "hours of
 * runs that say nothing about the artifact".
 */

import { spawnSync } from 'node:child_process'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  readSync,
  statSync,
} from 'node:fs'
import path from 'node:path'

/* THE ONE PLACE EITHER NAME IS WRITTEN.
 *
 * `launcher` is package.json build.linux.executableName / build.productName as
 * electron-builder spells them; `unpacked` is the directory it writes the
 * unpacked tree into for each target. A literal typed anywhere else drifts
 * from the builder config the day somebody renames the product. */
export const PACKAGED_PLATFORMS = Object.freeze({
  win32: Object.freeze({ launcher: 'ToolsEnabled.exe', unpacked: 'win-unpacked' }),
  linux: Object.freeze({ launcher: 'toolsenabled', unpacked: 'linux-unpacked' }),
})

/* A platform this repository does not package is an ERROR, never a default.
 * Falling back to the Windows names on darwin would hand a macOS operator a
 * refusal naming a file that platform never builds, which reads as a broken
 * build rather than as an unported host. */
export function packagedPlatform(platform = process.platform) {
  const entry = PACKAGED_PLATFORMS[platform]
  if (!entry) {
    throw new Error(`packaged QA has no artifact names for ${platform}; this repository packages `
      + `${Object.keys(PACKAGED_PLATFORMS).join(' and ')} only`)
  }
  return entry
}

/** ---- 1. WHICH FILE IS THE APPLICATION ---------------------------------- */

export function packagedLauncherName(platform = process.platform) {
  return packagedPlatform(platform).launcher
}

/** The unpacked tree `electron-builder` writes for this platform's target. */
export function unpackedDirectoryName(platform = process.platform) {
  return packagedPlatform(platform).unpacked
}

/** Where a driver looks when nobody passed `--release`. */
export function defaultReleaseDirectory(repoRoot, platform = process.platform) {
  if (typeof repoRoot !== 'string' || !repoRoot) {
    throw new Error('defaultReleaseDirectory needs the repository root')
  }
  return path.join(repoRoot, 'release', unpackedDirectoryName(platform))
}

/* Presence only, and deliberately NOT the opener: test-account-harness's
   appExecutable() is what opens the file, and it checks far more than presence
   (an ELF header, O_NOFOLLOW, the same inode it stat'd). This answers the
   cheaper question the suite asks before it starts anything -- is there an
   application of this platform's shape in the tree at all. */
export function packagedLauncherPresent(releaseDirectory, platform = process.platform) {
  if (typeof releaseDirectory !== 'string' || !releaseDirectory) return false
  return existsSync(path.join(path.resolve(releaseDirectory), packagedLauncherName(platform)))
}

export function sameFileIdentity(left, right) {
  if (!left || !right || left.isFile() !== true || right.isFile() !== true) return false
  if (left.size !== right.size) return false
  /* dev/ino are zero on a few Windows filesystems. Where the OS supplies them,
     use them to catch a path swapped between lstat and open without following a
     replacement reparse point. */
  if (left.dev && right.dev && left.dev !== right.dev) return false
  if (left.ino && right.ino && left.ino !== right.ino) return false
  return true
}

export function appExecutable(appRoot) {
  if (process.platform === 'linux') {
    // This is the name declared by build.linux.executableName. Never rename or
    // substitute a Windows candidate to make a Linux QA launch appear to work.
    const executable = path.join(appRoot, 'toolsenabled')
    const before = lstatSync(executable)
    if (!before.isFile() || before.isSymbolicLink() || !(before.mode & 0o111)) {
      throw new Error('the Linux QA candidate needs an ordinary executable toolsenabled file')
    }
    const descriptor = openSync(executable, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const opened = fstatSync(descriptor)
      if (!sameFileIdentity(before, opened)) throw new Error('Linux QA launcher changed while being opened')
      const header = Buffer.alloc(4)
      if (readSync(descriptor, header, 0, 4, 0) !== 4 || !header.equals(Buffer.from([127, 69, 76, 70]))) {
        throw new Error('the Linux QA candidate launcher is not an ELF executable')
      }
    } finally { closeSync(descriptor) }
    return executable
  }
  const executables = readdirSync(appRoot).filter(entry => entry.toLowerCase().endsWith('.exe'))
  if (executables.length === 1) return path.join(appRoot, executables[0])
  const launcher = executables.find(entry => !/^(elevate|squirrel|crashpad)/i.test(entry))
  if (!launcher) throw new Error(`cannot tell which of these is the launcher: ${executables.join(', ')}`)
  return path.join(appRoot, launcher)
}

/** ---- 2 & 4. THE HOMES A LINUX CHILD MUST NOT FIND ---------------------- */

/* THE QA PROFILE LAYOUT, RESTATED FOR LINUX ONLY.
 *
 * test-account-harness has always given a child `<profile>/local`,
 * `<profile>/roaming`, `<profile>/home` and `<profile>/home/.codex`. Those four
 * are a complete fence on Windows. On Linux they are not read at all by
 * anything except this product's own LOCALAPPDATA-first resolver, and the real
 * account is still reachable three other ways: HOME, the passwd entry that
 * os.homedir() falls back to when HOME is unset, and XDG_CONFIG/DATA/CACHE/
 * STATE_HOME.
 *
 * WHY XDG_DATA_HOME IS THE SAME DIRECTORY AS LOCALAPPDATA rather than a fifth
 * one. The payload resolves its services root from LOCALAPPDATA when that is
 * absolute and from XDG_DATA_HOME otherwise (the rule copied into
 * sterile-launch.cjs servicesRootForSelectedIdentity). Pointing them at
 * different directories would make the machine record this harness SEEDS and
 * the machine record the application READS the same file only by accident of
 * which branch ran. They are one directory here so that they cannot disagree.
 *
 * HOME IS SET, NOT DELETED, for the reason sterile-launch.cjs already records:
 * unsetting it is not isolation, because Node then consults passwd and finds
 * the real account again. */
export function linuxProfileHomes(profile) {
  if (typeof profile !== 'string' || !path.isAbsolute(profile)) {
    throw new Error('linuxProfileHomes needs an absolute QA profile directory')
  }
  const local = path.join(profile, 'local')
  return {
    HOME: path.join(profile, 'home'),
    XDG_DATA_HOME: local,
    XDG_CONFIG_HOME: path.join(profile, 'roaming'),
    XDG_CACHE_HOME: path.join(local, 'cache'),
    XDG_STATE_HOME: path.join(local, 'state'),
    XDG_CONFIG_DIRS: '/etc/xdg',
    XDG_DATA_DIRS: '/usr/local/share:/usr/share',
  }
}

/* Applied to an environment object rather than returned on its own, so a caller
 * cannot set half of it. On Windows it is the identity function: the four
 * Windows homes are the fence there and adding XDG names would be noise in a
 * child that never reads them. */
export function applyPlatformHomes(environment, profile, platform = process.platform) {
  if (!environment || typeof environment !== 'object') {
    throw new Error('applyPlatformHomes needs the environment it is fencing')
  }
  if (platform !== 'linux') return environment
  Object.assign(environment, linuxProfileHomes(profile))
  return environment
}

/* THE LINUX LAUNCH REFUSES A USER-DATA DIRECTORY ANYONE ELSE COULD WRITE, AND
 * A DEFAULT umask IS ENOUGH TO TRIP IT.
 *
 * shell/linux-account-state.cjs walks the whole named chain of the selected
 * --user-data-dir before the first window. For every ancestor it requires
 * `info.uid` to be this user or root AND `(info.mode & 0o022) === 0` unless the
 * directory is a root-owned sticky one (:64-65), and for the userData itself and
 * its capability/vault it requires exact 0700 ownership. That is the right rule:
 * a group-writable ancestor means another account can substitute the vault.
 *
 * MEASURED 2026-09-11, and this is the whole of it: this host's umask is 002, so
 * every `mkdirSync` in the QA harnesses produced mode 0775. `0o775 & 0o022` is
 * group-write, /tmp's sticky-root exemption does not extend to a child, and the
 * packaged application therefore exited 1 with
 *   MC_ACCOUNT_STATE_UNSAFE: The application could not prepare private account
 *   storage. Choose an owned, private user-data directory without symbolic links.
 * before opening anything. Five drivers reported that as "the app exited with
 * code 1 before the debugger answered". Isolated by experiment: the identical
 * launch under a 0700 chain reaches DevToolsActivePort and answers CDP.
 *
 * So a QA directory that will hold, or be an ancestor of, a launch's userData is
 * created 0700 rather than at the mercy of whatever umask the operator's shell
 * carries. On Windows the mode argument is ignored and nothing changes. */
export function makePrivateDirectory(directory, { platform = process.platform, mkdir = mkdirSync } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new Error('makePrivateDirectory needs an absolute directory')
  }
  /* 0700 on both platforms: harmless where it is ignored, and asking for it
     unconditionally keeps one code path rather than a platform branch whose
     Windows half nobody ever exercises. */
  mkdir(directory, { recursive: true, mode: 0o700 })
  return directory
}

/** ---- 3. HOW A PROCESS TREE IS REAPED ----------------------------------- */

/* Field 4 of /proc/<pid>/stat is the parent pid and field 22 is the start time,
 * but the SECOND field is the executable name in parentheses and it may contain
 * both spaces and parentheses -- `(my app (2))` is a legal comm. Splitting the
 * line on whitespace is therefore wrong for exactly the processes a QA reap
 * cares about. Everything after the LAST ')' is fixed-width, so that is where
 * the parse starts. */
export function parseProcStat(text) {
  if (typeof text !== 'string') return null
  const close = text.lastIndexOf(')')
  if (close === -1) return null
  const open = text.indexOf('(')
  if (open === -1 || open > close) return null
  const pid = Number(text.slice(0, open).trim())
  const fields = text.slice(close + 1).trim().split(/\s+/)
  /* After comm the fields are state(3) ppid(4) ... starttime(22); this slice
     starts at state, so ppid is [1] and starttime is [19]. */
  const ppid = Number(fields[1])
  const startTime = Number(fields[19])
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isFinite(startTime)) return null
  return { pid, ppid, startTime }
}

/* ONE SNAPSHOT, AND IT CARRIES START TIMES.
 *
 * process-tree.cjs records why the snapshot must happen while the links are
 * still intact: an Electron app exits and its crashpad handler is reparented,
 * so a walk started afterwards ends at the dead parent. The same is true on
 * Linux, and Linux adds a second hazard Windows mostly does not -- pid reuse
 * inside a 32768-wide default range, which a QA host churns through fast. So
 * every entry carries the start time it was seen with, and reapProcessTree()
 * refuses to signal a pid whose start time has changed. Without that, a reap
 * can kill a stranger's process that merely inherited the number. */
export function linuxProcessSnapshot({ procfs = '/proc', readdir = readdirSync, readFile = readFileSync } = {}) {
  const rows = []
  let names
  try { names = readdir(procfs) } catch (cause) { throw processSnapshotUnavailable(cause) }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    let text
    try { text = readFile(path.join(procfs, name, 'stat'), 'utf8') }
    catch { continue /* it exited between the readdir and the read; that is the normal case */ }
    const row = parseProcStat(text)
    if (row) rows.push(row)
  }
  return rows
}

function processSnapshotUnavailable(cause) {
  const error = new Error(
    'Process snapshot unavailable; this does not claim that the process tree is empty.',
    { cause },
  )
  error.code = 'PROCESS_SNAPSHOT_UNAVAILABLE'
  return error
}

/** Every descendant of rootPid, breadth-first, rootPid itself excluded. */
export function linuxDescendantPids(rootPid, options = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return []
  const rows = options.snapshot ? options.snapshot() : linuxProcessSnapshot(options)
  const children = new Map()
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, [])
    children.get(row.ppid).push(row)
  }
  const found = []
  const seen = new Set([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    for (const row of children.get(queue.shift()) || []) {
      /* pid reuse can make a snapshot look cyclic even though a real process
         table never is; an unguarded walk would not terminate. */
      if (seen.has(row.pid)) continue
      seen.add(row.pid)
      found.push(row)
      queue.push(row.pid)
    }
  }
  return found
}

/* THE REAP, AND WHY THE ROOT IS KILLED LAST.
 *
 * Killing the Electron root first severs the parent/child links the descendant
 * walk needs -- process-tree.cjs measured exactly that on Windows and the
 * mechanism is the same here. The snapshot is taken first, then the
 * descendants, then the root, so a crashpad handler or capability child cannot
 * be stranded by the order.
 *
 * SIGKILL, not SIGTERM. closeWindow() has already asked the application to
 * close the way a person closes it and waited for it; this function is the
 * backstop for a build that ignored that, and a backstop that can also be
 * ignored is not one. */
export function reapProcessTree(pid, {
  platform = process.platform,
  run = spawnSync,
  signal = (target, name) => process.kill(target, name),
  snapshot = null,
  startTimeOf = null,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { reaped: 0, platform, skipped: 'no pid' }
  if (platform !== 'linux') {
    try {
      run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 30_000 })
    } catch { /* the tree is already gone */ }
    return { reaped: null, platform, skipped: null }
  }
  let descendants = []
  let snapshotFailed = null
  try { descendants = linuxDescendantPids(pid, snapshot ? { snapshot } : {}) }
  catch (error) {
    /* An unreadable /proc is not an empty tree. Say so and still kill the root:
       a partial reap beats a silent one, and the caller is told it was partial. */
    descendants = []
    snapshotFailed = error.code || 'PROCESS_SNAPSHOT_UNAVAILABLE'
  }
  const currentStartTime = startTimeOf || (target => {
    try { return parseProcStat(readFileSync(path.join('/proc', String(target), 'stat'), 'utf8'))?.startTime ?? null }
    catch { return null }
  })
  let reaped = 0
  for (const row of descendants) {
    /* The pid may have been recycled between the snapshot and now. A start time
       that no longer matches is a DIFFERENT process wearing the same number,
       and killing it would be this harness damaging the machine it is meant to
       be measuring. */
    if (currentStartTime(row.pid) !== row.startTime) continue
    try { signal(row.pid, 'SIGKILL'); reaped += 1 } catch { /* it exited on its own */ }
  }
  try { signal(pid, 'SIGKILL'); reaped += 1 } catch { /* already gone */ }
  return { reaped, platform, skipped: snapshotFailed }
}

/** ---- 5. CAN A PACKAGED ELECTRON EVEN START ON THIS HOST ---------------- */

/* MEASURED 2026-09-11 on this laptop, against the 1.0.44 candidate's own
 * release/cut-1.0.44/linux-unpacked tree:
 *
 *   launched directly                 exit 133, before any window
 *     FATAL sandbox/linux/suid/client/setuid_sandbox_host.cc:166
 *     "The SUID sandbox helper binary was found, but is not configured
 *      correctly ... needs to be owned by root and have mode 4755"
 *   launched under an AppArmor profile in unconfined mode granting `userns`
 *                                     DevToolsActivePort written in ~12s,
 *                                     CDP answered, renderer reachable
 *
 * WHY BOTH SPELLINGS ARE THE SAME FACT. Chromium builds its sandbox from
 * unprivileged user namespaces when it may have them and falls back to the
 * setuid helper when it may not. Ubuntu's
 * kernel.apparmor_restrict_unprivileged_userns=1 denies namespaces to any
 * process that carries no AppArmor profile, and an unpacked electron-builder
 * tree ships chrome-sandbox 0755 and unowned, because only the installer can
 * make it root:4755. So an unpacked candidate on a stock Ubuntu desktop has
 * NEITHER path, and every driver that launches it would burn its whole timeout
 * against a process that died in under a second.
 *
 * THIS IS NOT A QA WORKAROUND; IT IS THE PRODUCT'S OWN LINUX CONTRACT. The
 * shipped .deb installs exactly such a profile --
 * `profile toolsenabled-customer "/opt/ToolsEnabled/toolsenabled"
 * flags=(unconfined) { userns, }` (resources/apparmor-profile, written by the
 * postinst) -- and tools/smoke-linux-sealed.mjs asserts the installed product
 * runs labelled by it. Running an UNPACKED candidate the same way reproduces
 * the installed launch rather than departing from it.
 *
 * `--no-sandbox` IS NOT ONE OF THE ANSWERS, and is deliberately not offered
 * here. smoke-linux-sealed.mjs makes `noSandboxSwitch === false` a pass
 * condition: a candidate measured with its sandbox switched off is a
 * measurement of a configuration no customer runs.
 */
export const LINUX_USERNS_SYSCTL = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'

export function packagedLaunchReadiness({
  executable,
  platform = process.platform,
  env = process.env,
  readFile = readFileSync,
  stat = statSync,
  lstat = lstatSync,
} = {}) {
  if (platform !== 'linux') return { ready: true, platform, reasons: [] }
  const reasons = []

  /* A GUI launch with no display is not a sandbox problem and must not be
     reported as one; it is its own missing precondition. */
  const display = ['DISPLAY', 'WAYLAND_DISPLAY'].filter(name => typeof env?.[name] === 'string' && env[name] !== '')
  if (display.length === 0) {
    reasons.push('no DISPLAY or WAYLAND_DISPLAY: these drivers open real windows (offscreen or hidden, but real) '
      + 'and there is no desktop session here to open them on')
  }

  let restricted = false
  try { restricted = readFile(LINUX_USERNS_SYSCTL, 'utf8').trim() === '1' }
  catch (error) {
    /* No such file means this kernel has no such restriction, which is the
       permissive answer. Any other error means we do not know, and not knowing
       is not permission. */
    if (error?.code !== 'ENOENT') {
      reasons.push(`${LINUX_USERNS_SYSCTL} could not be read, so whether this host allows unprivileged `
        + 'user namespaces is unknown; unknown is not a yes')
      restricted = true
    }
  }

  let confined = false
  try { confined = !/^unconfined\b/.test(readFile('/proc/self/attr/current', 'utf8').trim()) }
  catch { confined = false }

  let sandboxHelper = null
  if (typeof executable === 'string' && executable) {
    const helper = path.join(path.dirname(path.resolve(executable)), 'chrome-sandbox')
    try {
      const seen = lstat(helper)
      const opened = stat(helper)
      sandboxHelper = { present: seen.isFile() && !seen.isSymbolicLink(), uid: opened.uid, mode: opened.mode & 0o7777 }
    } catch { sandboxHelper = { present: false, uid: null, mode: null } }
  }
  const setuidHelperUsable = sandboxHelper?.present === true
    && sandboxHelper.uid === 0 && (sandboxHelper.mode & 0o4000) !== 0

  /* THE OPT-IN COUNTS AS AN ANSWER, because it is the one this harness can act
     on: packagedLaunchCommand() below transitions every packaged launch into
     the named profile, so a run that has it is not the run this refusal is
     about. The name is only trusted as far as aa-exec being present to apply
     it; whether the profile is actually loaded is answered by the kernel at
     the first launch, loudly, and not guessed at here. */
  const namedProfile = typeof env?.[LINUX_APPARMOR_PROFILE_ENV] === 'string'
    && env[LINUX_APPARMOR_PROFILE_ENV].trim() !== ''
    && (existsSync('/usr/sbin/aa-exec') || existsSync('/usr/bin/aa-exec'))

  if (restricted && !confined && !namedProfile && !setuidHelperUsable) {
    reasons.push('Chromium cannot build a sandbox here: this host sets '
      + 'kernel.apparmor_restrict_unprivileged_userns=1, this process carries no AppArmor profile, and the '
      + 'candidate\'s chrome-sandbox is not root-owned with the setuid bit. The packaged application aborts '
      + 'with exit 133 before it opens anything. Three ways forward, in the order a person should try them: '
      + '(1) run this suite under an AppArmor profile that grants `userns`, the way the shipped .deb runs the '
      + 'installed product -- `aa-exec -p <profile> -- node tools/packaged-qa-suite.mjs ...`, or name the '
      + 'profile in TOOLSENABLED_QA_LINUX_APPARMOR_PROFILE and this harness will apply it to each launch; '
      + '(2) point --release at an INSTALLED tree, whose chrome-sandbox the package manager has already made '
      + 'root:4755; (3) allow unprivileged user namespaces on this host. Running with --no-sandbox is not one '
      + 'of them: it measures a configuration no customer runs.')
  }

  return {
    ready: reasons.length === 0,
    platform,
    reasons,
    detail: { usernsRestricted: restricted, profileAttached: confined, namedProfile, sandboxHelper, display },
  }
}

/* THE OPT-IN, AND WHY IT IS A NAME RATHER THAN A PATH.
 *
 * An AppArmor profile is loaded by root and referred to by name; the harness
 * cannot load one and must not try. So the operator (or the Linux cutter) names
 * a profile that is already loaded on the host, and every packaged launch this
 * harness makes is transitioned into it. An absent variable changes nothing,
 * which keeps the default behaviour of every existing driver exactly as it was
 * on both platforms.
 *
 * THE VALUE IS VALIDATED BEFORE IT REACHES A COMMAND LINE. It is an
 * AppArmor profile name, which is a restricted alphabet; anything else is
 * refused by name rather than passed through to aa-exec.
 *
 * AND IT IS READ FROM THE HARNESS'S OWN ENVIRONMENT, NOT THE CHILD'S. Measured
 * 2026-09-11: home-screen-qa passes its child an ALLOWLIST environment
 * (SystemRoot, DISPLAY, XAUTHORITY, LANG, MC_SMOKE_HEADLESS and nothing else),
 * so handing that object to this function meant the opt-in was invisible, the
 * launch was never confined, and the driver reported "The owned application
 * exited before Home inspection completed" -- a product-shaped sentence about a
 * sandbox the harness had failed to ask for. The profile is an instruction to
 * the HARNESS about how to start the application; it is not a variable the
 * application reads, and it has no business in the child's environment. So the
 * default is process.env and a caller that means something else has to say so. */
export const LINUX_APPARMOR_PROFILE_ENV = 'TOOLSENABLED_QA_LINUX_APPARMOR_PROFILE'
const APPARMOR_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

export function packagedLaunchCommand(executable, args = [], {
  platform = process.platform,
  env = process.env,
  exists = existsSync,
} = {}) {
  if (typeof executable !== 'string' || !executable) throw new Error('packagedLaunchCommand needs the application to launch')
  const list = [...args]
  if (platform !== 'linux') return { command: executable, args: list, confinement: null }
  const profile = typeof env?.[LINUX_APPARMOR_PROFILE_ENV] === 'string' ? env[LINUX_APPARMOR_PROFILE_ENV].trim() : ''
  if (profile === '') return { command: executable, args: list, confinement: null }
  if (!APPARMOR_PROFILE_NAME.test(profile)) {
    throw new Error(`${LINUX_APPARMOR_PROFILE_ENV} is not an AppArmor profile name. Set it to a profile that is `
      + 'already loaded on this host (for example the one the shipped .deb installs), or unset it.')
  }
  /* THE ABSOLUTE PATH, NOT THE NAME, and it is not tidiness. Measured
     2026-09-11: home-screen-qa hands its launch to shell/owned-claim-process,
     which refuses with "An owned claim requires explicit absolute launch roots"
     -- correctly, because a bare command name is resolved by a PATH this
     harness has deliberately cut down. Resolving it here also means the helper
     that changes a process's confinement is never found by search. */
  const helper = ['/usr/sbin/aa-exec', '/usr/bin/aa-exec'].find(candidate => exists(candidate))
  if (!helper) {
    throw new Error(`${LINUX_APPARMOR_PROFILE_ENV} names ${profile}, but aa-exec is not installed, so this harness `
      + 'cannot enter that profile. Install apparmor-utils, or unset the variable and use an installed tree instead.')
  }
  return { command: helper, args: ['-p', profile, '--', executable, ...list], confinement: profile }
}
