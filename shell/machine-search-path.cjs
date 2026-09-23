'use strict'

/* WHERE THIS COMPUTER WOULD LOOK FOR A PROGRAM IF IT WERE ASKED RIGHT NOW.
 *
 * THE DEFECT THIS EXISTS TO CLOSE, reported by the owner from his own second
 * machine: "i have claude and codex downloaded and installed and signed it but
 * when i try to launch agents it says nothing was started and to run winget
 * install openAI". He had done exactly what the product's guide told him to do,
 * and the product told him to do it again.
 *
 * WHY THE PRODUCT COULD NOT SEE HIS INSTALL. On Windows a process inherits its
 * environment from whatever started it, and for an application launched from
 * Explorer that is the environment captured at login. Installing a program
 * afterwards writes the new directory into the REGISTRY copy of PATH and
 * broadcasts a change; already-running processes keep the copy they were born
 * with. So every install performed after the app started -- and, because the
 * shell that owns the desktop is itself long-lived, most installs performed
 * before it too -- is invisible to a probe that reads process.env.PATH.
 *
 * MEASURED on the machine that found this, 2026-08-23, comparing the registry's
 * user and machine PATH against the running process's:
 *
 *     live entries 37, inherited 36
 *     the one entry missing from the process:
 *       ...\AppData\Local\Microsoft\WinGet\Packages\<package>\bin
 *
 * A winget-installed program was invisible on a machine where npm-installed
 * ones were fine -- because the old probe hardcoded npm's directory and had no
 * general answer. The product's guide recommends winget. That is the loop.
 *
 * WHAT THIS ANSWERS, AND WHAT IT DELIBERATELY DOES NOT. It answers "which
 * directories would a newly started process search", as a list of strings, and
 * nothing else. It does not know what a provider is, does not look for any
 * particular program, and never decides whether anything is installed. That
 * decision stays in shell/provider-cli-presence.cjs, which takes this list as a
 * VALUE and remains a pure function of its inputs -- so the judgement can be
 * driven in a test with no machine behind it, and the machinery below can be
 * replaced without touching the judgement.
 *
 * IT NAMES NO VENDOR. Not npm, not winget, not scoop, not chocolatey, not an
 * installer's default folder. It asks the operating system the same question
 * the operating system would ask itself, which is what makes it work for the
 * package manager nobody here has heard of and for the corporate image that
 * ships its own directory.
 *
 * `complete` IS AS IMPORTANT AS `directories`, and it is the half the reported
 * defect is really about. It says whether every layer below actually ran. A
 * caller may report "not installed" only on a complete search; on an incomplete
 * one the honest answer is "we could not find it", because "we could not find
 * it" is not "you have not installed it" -- and confusing the two is what put an
 * install command in front of a person who had already installed the thing.
 *
 * COST. One read per process, cached, with exactly one way to invalidate it
 * (invalidateMachineSearchPath) for the moment that matters: an install
 * finishing. Registry and package-manager reads are bounded asynchronous child
 * processes. A synchronous caller receives the current snapshot while they run.
 *
 * NO SYSTEM BINARY IS INVOKED BY NAME. reg.exe and cmd.exe are named by
 * absolute path under %SystemRoot%, the rule this codebase already states in
 * shell/provider-login.cjs and pins in the engine's
 * tests/system-binaries-resolve-under-system-root.test.js. Resolving a bare name
 * from PATH in order to repair a PATH defect would be circular as well as a
 * hijack vector.
 *
 * NOTHING HERE READS A CREDENTIAL. It reads two registry values, both named
 * Path, and one line of output from a package manager. It opens no file.
 */

const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/* LIVE redirects HOME for its own state. Executables installed by this OS
   account still live in its login home. Consult the OS identity, never a
   sibling profile, a shell startup file, or any provider credential. */
function linuxLoginHome() {
  try {
    const home = os.userInfo().homedir
    return typeof home === 'string' && path.posix.isAbsolute(home) ? home : null
  } catch { return null }
}

/* Bounded, both of them, because a machine that will not answer must cost a
   moment and then be forgotten rather than hold anything up. reg.exe answers in
   tens of milliseconds on a healthy machine; the allowance is for the one that
   is not healthy. */
const REGISTRY_TIMEOUT_MS = 2500
const PACKAGE_MANAGER_TIMEOUT_MS = 10000

/* Output caps. A PATH is long; it is not megabytes, and a child that decides to
   stream forever must not be able to grow this process's memory. */
const REGISTRY_OUTPUT_LIMIT = 512 * 1024
const PACKAGE_MANAGER_OUTPUT_LIMIT = 64 * 1024

/* The two places Windows itself keeps PATH, and the order it combines them in:
   the machine's value first, then the user's appended after it. Both are
   REG_EXPAND_SZ in practice and both routinely contain %USERPROFILE% and
   %SystemRoot% references, which is why expansion below is not optional. */
const MACHINE_ENVIRONMENT_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const USER_ENVIRONMENT_KEY = 'HKCU\\Environment'

const REGISTRY_TOOL = Object.freeze(['System32', 'reg.exe'])
const SYSTEM_SHELL = Object.freeze(['System32', 'cmd.exe'])
const COULD_NOT_READ_REGISTRY = 'MACHINE_SEARCH_PATH_COULD_NOT_READ_REGISTRY'
const COULD_NOT_ASK_PACKAGE_MANAGER = 'MACHINE_SEARCH_PATH_COULD_NOT_ASK_PACKAGE_MANAGER'

/* Read, never assumed. Imaged machines, non-C: system drives and localized
   deployments all move Windows; the same three variables and the same fallback
   shell/provider-login.cjs uses, so there is one answer to this in the shell. */
function systemRoot(env) {
  const configured = env.SystemRoot || env.SYSTEMROOT || env.windir
  return typeof configured === 'string' && configured.trim() ? configured.trim() : 'C:\\Windows'
}

/* %NAME% -> the value, the way Windows expands a REG_EXPAND_SZ.
 *
 * AN UNKNOWN NAME IS LEFT EXACTLY AS IT IS, which is what Windows does too. The
 * alternative -- dropping it -- silently rewrites `%CUSTOM%\bin` into `\bin`,
 * a real directory at the root of the current drive, and a stat against it is a
 * wrong answer rather than a missing one.
 *
 * Lookup is case-insensitive because Windows environment names are, and a
 * registry value written by an installer as %PROGRAMFILES% must find the
 * variable the process holds as `ProgramFiles`.
 *
 * IT DOES NOT RECURSE. Windows expands a value once; a value that expands to
 * something containing another reference keeps that reference. Matching that
 * exactly also means a self-referential value cannot spin here. */
function expandEnvironmentReferences(value, env) {
  if (typeof value !== 'string' || value.length === 0) return ''
  const lookup = new Map()
  for (const name of Object.keys(env || {})) {
    const held = env[name]
    if (typeof held === 'string') lookup.set(name.toLowerCase(), held)
  }
  return value.replace(/%([^%\r\n]+)%/g, (whole, name) => {
    const found = lookup.get(String(name).toLowerCase())
    return typeof found === 'string' ? found : whole
  })
}

/* ONE VALUE OUT OF `reg query <key>` OUTPUT.
 *
 * The key is queried WHOLE rather than with /v, and that is the difference
 * between "this machine has no user PATH" and "this machine would not tell us".
 * `reg query <key> /v Path` exits non-zero for BOTH, and the only thing
 * separating them is an English sentence on stderr that a localized Windows does
 * not print. Querying the key succeeds whenever the key is readable, and the
 * absence of a Path row inside a readable key is then a real, quiet fact: a
 * fresh profile with no user PATH is normal and is not a failure.
 *
 * The row shape is `    <name>    <TYPE>    <value>`, indented, with the value
 * running to the end of the line and free to contain single spaces -- which
 * every `Program Files` entry does. So the split is on the TYPE token, not on
 * whitespace.
 *
 * Returns the raw, unexpanded value, because expansion is a separate decision
 * with its own test. */
function registryValueFromQuery(text, name) {
  if (typeof text !== 'string' || text.length === 0) return null
  const wanted = String(name).toLowerCase()
  for (const line of text.split(/\r?\n/)) {
    const row = /^\s+(\S+)\s{2,}(REG_[A-Z_]+)\s{2,}([\s\S]*)$/.exec(line)
    if (!row) continue
    if (row[1].toLowerCase() !== wanted) continue
    return row[3]
  }
  return null
}

/* Split a PATH string the way the OS that supplied it does, dropping the empty
   segments a trailing or doubled separator leaves behind. The caller chooses
   the delimiter because fabricated Windows environments are deliberately
   supported even when this process is running on another platform. */
function splitPath(raw, delimiter = path.delimiter) {
  if (typeof raw !== 'string' || raw.length === 0) return []
  return raw.split(delimiter).map(entry => entry.trim()).filter(Boolean)
}

/* A hand-edited PATH entry is often quoted, and the quotes are not part of the
   name. Windows strips them when it searches; anything that keeps them is
   asking the filesystem for a directory whose first character is a quote mark.
   Stripped here, once, so the value that gets STORED is the usable spelling --
   see the note in composeSearchDirectories for what happened when it was not. */
function unquoteDirectory(directory) {
  return directory.replace(/^"+|"+$/g, '')
}

/* A key that says "these two strings name the same directory" without touching
   the disk: case-folded, with a trailing separator and surrounding quotes
   removed. Quotes appear in hand-edited PATH entries more often than anyone
   would like. */
function directoryKey(directory) {
  return unquoteDirectory(directory).replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * The directories a newly started process would search, in its order.
 *
 * IT IS A UNION, NOT A REPLACEMENT, and that is a deliberate safety property.
 * The live values go first because they are the fresher authority, and anything
 * this process inherited that they do not name is kept after them. A launcher
 * script, a `conda activate`, a portable toolchain and a corporate wrapper all
 * put directories on a process's PATH that are in no registry, and dropping
 * those would make an answer that is right today wrong tomorrow. Every
 * directory this ever searched, it still searches.
 *
 * @param machineValue raw HKLM Path, or null when it could not be read
 * @param userValue    raw HKCU Path, or null when it could not be read
 * @param inheritedPath what this process holds in PATH
 * @param env          for expanding %references%
 * @param extra        directories a package manager named (see below)
 */
function composeSearchDirectories({ machineValue = null, userValue = null, inheritedPath = '', env = {}, extra = [] } = {}) {
  const ordered = []
  const seen = new Set()
  /* A QUOTED PATH ENTRY USED TO HIDE AN INSTALLED PROGRAM, AND THIS IS WHERE.
   *
   * The key was computed from the UNQUOTED spelling and the RAW one was stored,
   * so `"D:\Program Files\Jo Smith\bin"` went into the list with its quotes intact
   * -- and the unquoted duplicate that followed it was then dropped as already
   * seen. Both halves of the bug in one line: the usable spelling discarded, the
   * unusable one kept.
   *
   * Every consumer uses these strings as stat targets (provider-cli-presence,
   * provider-login, agent-host). path.join does not treat a quoted absolute
   * path as absolute, so the target became a RELATIVE path beginning with a
   * quote mark, the stat could never hit, and commandPresence answered 'no'.
   * The visible effect was the worst kind: a person with a space in their
   * Windows user name -- who therefore quoted their PATH entry -- was told the
   * engine was not installed while it sat there installed, and was sent round
   * the install instructions again. Store the cleaned value. */
  const add = (directory) => {
    const cleaned = unquoteDirectory(directory)
    const key = directoryKey(cleaned)
    if (!key || seen.has(key)) return
    seen.add(key)
    ordered.push(cleaned)
  }
  for (const raw of [machineValue, userValue]) {
    if (typeof raw !== 'string') continue
    for (const entry of splitPath(expandEnvironmentReferences(raw, env), path.win32.delimiter)) add(entry)
  }
  for (const entry of splitPath(inheritedPath, path.win32.delimiter)) add(entry)
  for (const entry of Array.isArray(extra) ? extra : []) {
    if (typeof entry === 'string' && entry.trim()) add(entry.trim())
  }
  return Object.freeze(ordered)
}

/* THE MACHINE HALF: run reg.exe and hand back what it said.
 *
 * Injectable so the parsing and composition above can be driven against a
 * fake -- a malformed value, an empty one, one full of %references% -- with no
 * registry anywhere near the test. */
function defaultRegistryReader({ env }) {
  const tool = path.join(systemRoot(env), ...REGISTRY_TOOL)
  return (key) => new Promise(resolve => {
    const unavailable = error => Object.freeze({
      code: COULD_NOT_READ_REGISTRY,
      causeCode: error && typeof error.code === 'string' ? error.code : null,
      message: 'The machine could not read the registry PATH; this is not claiming that PATH is absent.',
    })
    try {
      childProcess.execFile(tool, ['query', key], {
        encoding: 'utf8',
        timeout: REGISTRY_TIMEOUT_MS,
        maxBuffer: REGISTRY_OUTPUT_LIMIT,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }, (error, stdout) => {
        resolve(!error && typeof stdout === 'string' ? stdout : unavailable(error))
      })
    } catch (error) {
      /* Missing, blocked by policy, timed out, or a key this account may not
         read. All of them mean the same thing to the caller: we did not get to
         look, so nothing may be concluded from not finding something. */
      resolve(unavailable(error))
    }
  })
}

/**
 * Resolve the search path for one machine.
 *
 * `complete` is true only when every layer that could contribute actually ran:
 * on Windows, both registry keys answered AND the package-manager question has
 * settled one way or the other. A caller may say "not installed" on a complete
 * search and must say "could not tell" on any other.
 */
function resolveSearchPath({
  platform,
  env,
  readRegistryKey = null,
  packageManager = { settled: false, directories: [] },
  loginHome = null,
} = {}) {
  const inheritedPath = (env && (env.PATH || env.Path)) || ''

  /* Linux desktop launchers need not inherit the login shell's PATH. In
     particular LIVE intentionally supplies a minimal PATH and synthetic HOME.
     Add only this OS account's conventional executable directories. Keep
     executable discovery separate from credential/configuration discovery. */
  if (platform === 'linux') {
    const inherited = splitPath(inheritedPath, ':')
    const directories = inherited.filter(entry => path.posix.isAbsolute(entry))
    if (typeof loginHome === 'string' && path.posix.isAbsolute(loginHome)) {
      directories.push(path.posix.join(loginHome, '.local', 'bin'), path.posix.join(loginHome, 'bin'))
    }
    return Object.freeze({
      directories: Object.freeze([...new Set(directories)]),
      complete: directories.length > 0 && inherited.every(entry => path.posix.isAbsolute(entry)),
    })
  }
  if (platform !== 'win32') {
    const directories = Object.freeze(splitPath(inheritedPath))
    return Object.freeze({ directories, complete: directories.length > 0 })
  }

  // Composition never asks the operating system. Only the ambient discovery
  // attempt below reads it; an omitted reading is explicitly incomplete.
  const read = typeof readRegistryKey === 'function' ? readRegistryKey : () => null
  const machineText = read(MACHINE_ENVIRONMENT_KEY)
  const userText = read(USER_ENVIRONMENT_KEY)
  /* A readable key with no Path row is a real answer -- an account with no user
     PATH of its own is ordinary -- so it counts as read, with an empty value.
     An unreadable key is not an answer at all. */
  const machineRead = typeof machineText === 'string'
  const userRead = typeof userText === 'string'
  const machineValue = machineRead ? (registryValueFromQuery(machineText, 'Path') || '') : null
  const userValue = userRead ? (registryValueFromQuery(userText, 'Path') || '') : null

  const directories = composeSearchDirectories({
    machineValue,
    userValue,
    inheritedPath,
    env: env || {},
    extra: (packageManager && packageManager.directories) || [],
  })

  /* Nothing to search is never a finished search, however cleanly every layer
     reported. A machine that told us about no directories at all has taught us
     nothing about what is on it. */
  const complete = machineRead
    && userRead
    && Boolean(packageManager && packageManager.settled)
    && directories.length > 0

  return Object.freeze({ directories, complete })
}

/* ------------------------------------------------------------------
   THE CACHE, AND THE ONE WAY TO CLEAR IT.
   ------------------------------------------------------------------ */

let cachedSearchPath = null
let packageManagerState = { settled: false, directories: [] }
let cachedRegistryText = null
let discoveryInFlight = null
let searchGeneration = 0

/* ASK THE INSTALLER WHERE IT PUT THINGS, WHICH IS NOT THE SAME AS GUESSING.
 *
 * WHAT THIS REPLACES. The presence probe used to stat `%APPDATA%\npm\<name>`
 * before it looked at PATH -- one vendor's default directory, written into our
 * source. It was there for a good reason (a program installed a minute ago is
 * real before a stale PATH can see it) and it solved that problem for exactly
 * one installer. The live PATH above solves it for all of them, so the literal
 * is gone.
 *
 * WHAT IS LEFT OVER, and why this layer exists at all: a person who ran
 * `npm config set prefix` has a global directory that npm knows about and that
 * may be on no PATH anywhere. Asking npm where it puts things is general --
 * it works for whatever answer that person configured -- where writing npm's
 * default into our source is not. That is the whole of the difference.
 *
 * ASYNCHRONOUS, AND NOTHING WAITS FOR IT. Starting a package manager costs the
 * better part of a second on Windows, and a probe a screen calls on mount may
 * not spend that. It is warmed once at startup; until it settles, a search that
 * finds nothing reports `complete: false`, which reads as "we could not tell"
 * rather than "you have not installed it". Erring toward the honest answer for
 * the first second of a launch is the safe direction to err in.
 *
 * OPTIONAL, BOUNDED, SILENT. No npm on the machine is the ordinary case and is
 * not a failure: it settles with nothing to add. An error, timeout, or
 * unparseable answer is different: it remains unsettled and is retried later,
 * because none proves that the package manager has no directories.
 *
 * IT RESOLVES npm BY ABSOLUTE PATH, from the directories layer one already
 * found, and runs it through cmd.exe named under %SystemRoot%. A .cmd cannot be
 * started without a command interpreter, and reaching for a bare `npm` from
 * PATH -- inside the repair for a PATH defect -- would be circular and a hijack
 * vector besides. */
async function packageManagerProgram(directories) {
  for (const directory of directories) {
    for (const extension of ['.CMD', '.EXE', '.BAT']) {
      const candidate = path.join(directory, `npm${extension}`)
      try {
        if ((await fs.promises.stat(candidate)).isFile()) return candidate
      } catch (error) {
        // A missing candidate permits the next directory. An unreadable one
        // is not proof that npm is absent, so the overall reading stays open.
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      }
    }
  }
  return null
}

async function askPackageManagerForItsDirectories({ env, directories }) {
  const program = await packageManagerProgram(directories)
  if (!program) return []
  return new Promise((resolve, reject) => {
    const shell = path.join(systemRoot(env), ...SYSTEM_SHELL)
    const child = childProcess.execFile(
      shell,
      ['/d', '/s', '/c', `""${program}" prefix -g"`],
      {
        encoding: 'utf8',
        timeout: PACKAGE_MANAGER_TIMEOUT_MS,
        maxBuffer: PACKAGE_MANAGER_OUTPUT_LIMIT,
        windowsHide: true,
        /* MEASURED, because the escaped form silently does something else.
           Node quotes each argument when it builds a Windows command line, and
           `cmd /s /c` then sees its already-quoted argument quoted again: the
           run reports "The network path was not found" in 37ms and looks like
           a machine without npm. Verbatim, the same call answers the real
           prefix in 388ms. A quote cannot appear in a Windows directory name,
           so the string below cannot be broken out of by a path. */
        windowsVerbatimArguments: true,
        env,
      },
      (error, stdout) => {
        if (error || typeof stdout !== 'string') {
          const unavailable = new Error('The machine could not ask the package manager; this is not claiming that it has no directories.')
          unavailable.code = COULD_NOT_ASK_PACKAGE_MANAGER
          unavailable.causeCode = error && typeof error.code === 'string' ? error.code : null
          reject(unavailable)
          return
        }
        const prefix = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop()
        if (!prefix || !path.isAbsolute(prefix)) {
          const unavailable = new Error('The machine could not parse the package-manager answer; this is not claiming that it has no directories.')
          unavailable.code = COULD_NOT_ASK_PACKAGE_MANAGER
          reject(unavailable)
          return
        }
        /* The prefix itself on Windows, and prefix/bin for the layout every
           other platform uses -- both, because neither costs anything and a
           directory that does not exist simply never matches a stat. */
        resolve([prefix, path.join(prefix, 'bin')])
      },
    )
    /* UNREFERENCED, so this can never be the reason a process stays alive.
       Nothing waits on this answer -- it improves a later call and is allowed
       to be missed entirely -- and a short-lived program that happens to ask
       the presence probe one question must not then sit for the length of a
       package manager's startup before it can exit. */
    if (child && typeof child.unref === 'function') child.unref()
  })
}

/**
 * Start the machine reads, without waiting for them.
 *
 * Called once from shell/main.cjs at startup so the answer is ready before any
 * screen asks, and again after an install finishes. Safe to call more than
 * once: the asynchronous half joins the question already in flight rather than
 * starting a second one.
 *
 * IT IS AN OPTIMISATION, NOT A PRECONDITION. machineSearchPath() starts the same
 * question itself the first time it is asked, so a caller that never warms still
 * converges -- it just spends the first second or so of its life answering
 * "we could not tell" instead of "not installed". Making it a precondition would
 * mean one forgotten call site could put the product back to reporting an
 * absence it never proved, which is the whole of the defect being repaired.
 */
function warmMachineSearchPath() {
  const generation = searchGeneration
  machineSearchPath()
  const pending = discoveryInFlight
  if (!pending) return Promise.resolve()
  return pending.promise.then(() => {
    // An invalidation does not multiply outstanding OS reads. A warm-up for
    // the new generation waits for the old bounded attempt, then starts one
    // current attempt. The obsolete caller itself schedules no retry.
    if (generation === searchGeneration && pending.generation !== generation) {
      machineSearchPath()
      return discoveryInFlight?.promise
    }
  })
}

/* The registry text, read once and kept, so rebuilding the composed list after
   the package manager answers does not cost a second child process. */

/* A READING THAT COULD NOT LOOK IS NOT A SETTLED READING. EMFILE, EAGAIN, EIO,
 * EBUSY, a timeout and even a non-Error throw all receive the explicit
 * COULD_NOT_READ_REGISTRY result above. None is retained here. The one genuine
 * absence is different: a successful query containing no Path row becomes the
 * empty string in resolveSearchPath. Successful text, including that empty-row
 * answer, is retained so the expensive read still happens only once. */

function registryReadingSettled() {
  return cachedRegistryText !== null
    && cachedRegistryText[MACHINE_ENVIRONMENT_KEY] !== null
    && cachedRegistryText[USER_ENVIRONMENT_KEY] !== null
}

function currentSnapshot() {
  if (!cachedSearchPath) cachedSearchPath = resolveSearchPath({
    platform: process.platform,
    env: process.env,
    readRegistryKey: key => cachedRegistryText?.[key] ?? null,
    packageManager: packageManagerState,
  })
  return cachedSearchPath
}

function startDiscoveryQuestion() {
  if (discoveryInFlight || (registryReadingSettled() && packageManagerState.settled)) return
  const pending = { generation: searchGeneration, promise: null }
  discoveryInFlight = pending
  const current = () => pending.generation === searchGeneration && discoveryInFlight === pending
  pending.promise = (async () => {
    const keys = [MACHINE_ENVIRONMENT_KEY, USER_ENVIRONMENT_KEY]
    const prior = cachedRegistryText || {}
    const read = defaultRegistryReader({ env: process.env })
    const answers = await Promise.all(keys.map(key => typeof prior[key] === 'string' ? prior[key] : read(key)))
    if (!current()) return
    const next = Object.fromEntries(keys.map((key, index) => [key, typeof answers[index] === 'string' ? answers[index] : null]))
    // A newly readable registry key may reveal npm ahead of the old search
    // path. Its old prefix (including a previous no-npm answer) must be checked
    // again using the newly composed directories.
    if (keys.some(key => prior[key] !== next[key])) packageManagerState = { settled: false, directories: [] }
    cachedRegistryText = next
    cachedSearchPath = null
    if (packageManagerState.settled) return
    const answered = await askPackageManagerForItsDirectories({ env: process.env, directories: currentSnapshot().directories })
    if (!current()) return
    packageManagerState = { settled: true, directories: answered }
    cachedSearchPath = null
  })().catch(() => {
    if (!current()) return
    // Failed discovery is never a complete absence. A later lookup can start
    // another bounded attempt; this completion schedules no retry loop.
    packageManagerState = { settled: false, directories: [] }
    cachedSearchPath = null
  }).finally(() => {
    if (discoveryInFlight === pending) discoveryInFlight = null
  })
}

/**
 * This machine's search path: `{ directories, complete }`.
 *
 * Read once per process and cached, with ONE exception: a registry read that
 * never got to look is not cached or latched and is retried on the next call.
 * Caching 'we could not tell' is what made a timed-out reg.exe silently govern
 * the rest of the run. A successful answer stands, and the only way to look again is
 * invalidateMachineSearchPath(), whose moment is an install finishing -- which is
 * exactly when the answer changes and the person is standing in front of the
 * screen that reports it.
 *
 * A FABRICATED MACHINE IS NEVER RESOLVED AGAINST THIS ONE. Callers may hand in
 * an `env` and a `platform` describing a computer that is not this computer --
 * that is how the suites drive Windows shapes from wherever they run. Reading
 * THIS machine's registry to answer a question about THAT machine would mix two
 * computers into one answer and make a test's verdict depend on the developer's
 * PATH. So a supplied environment gets the inherited list and nothing else, and
 * is marked incomplete: we were told about a machine we cannot go and look at.
 * A caller that wants a resolved path for a fabricated machine passes one in.
 */
function machineSearchPath({ platform = process.platform, env = process.env, loginHome } = {}) {
  const ambient = env === process.env && platform === process.platform
  if (!ambient || platform !== 'win32') {
    return resolveSearchPath({ platform, env, readRegistryKey: () => null, packageManager: packageManagerState,
      loginHome: loginHome === undefined && ambient && platform === 'linux' ? linuxLoginHome() : loginHome })
  }
  const snapshot = currentSnapshot()
  startDiscoveryQuestion()
  return snapshot
}

/**
 * Forget everything and look again. The one explicit invalidation.
 */
function invalidateMachineSearchPath() {
  searchGeneration += 1
  cachedSearchPath = null
  cachedRegistryText = null
  packageManagerState = { settled: false, directories: [] }
}

module.exports = {
  COULD_NOT_ASK_PACKAGE_MANAGER,
  COULD_NOT_READ_REGISTRY,
  MACHINE_ENVIRONMENT_KEY,
  USER_ENVIRONMENT_KEY,
  composeSearchDirectories,
  expandEnvironmentReferences,
  invalidateMachineSearchPath,
  machineSearchPath,
  linuxLoginHome,
  registryValueFromQuery,
  resolveSearchPath,
  warmMachineSearchPath,
}
