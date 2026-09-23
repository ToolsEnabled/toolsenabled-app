'use strict'

/* IS THE PROGRAM THAT RUNS AN AGENT ON THIS COMPUTER, AND IS IT SIGNED IN.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. The owner, on what a stranger has to be able
 * to do: "a user needs to be able to easily install, add Claude and Codex and
 * Gemini CLI subscriptions smoothly and easily, then use those CLI for their
 * agents". Measured on the packaged product before this file existed: there is
 * no screen anywhere that reports whether any of those three programs is on the
 * computer, whether any of them is signed in, or what to type if not. The one
 * place the subject comes up is Settings, which says the product "never asks for
 * them" -- true, and read by a person as "there is nothing for me to do here",
 * which is the opposite of the truth. A person whose agent will not start has
 * nowhere in this product to find out why.
 *
 * WHAT IT MAY NEVER DO, and the rule is structural rather than promised. This
 * module resolves PRESENCE and nothing else. It calls fs.statSync and
 * fs.existsSync; it does not call readFile, readFileSync, or anything else that
 * returns bytes, and it never spawns a child. So there is no code path here that
 * could read a credential, and therefore none that could store, log or forward
 * one. The sign-in answer is "a file is where that program keeps its sign-in",
 * never one byte of what is in it. tools/test/provider-cli-presence.test.mjs
 * asserts the absence of every reading call in this source, because a rule about
 * credentials that is only written in a comment is not a rule.
 *
 * THE RENDERER-FACING ANSWER RETURNS NO PATHS. Every field in
 * providerCliPresence() is a word from a closed set. This is the BLOCKER 2 rule
 * the rest of this shell already follows: an answer that crosses into the
 * renderer must not carry a filesystem path, because that is how a private
 * checkout name reached the DOM. Main-process launch code may separately ask
 * providerCliExecutable() for the exact file it already proved present; that
 * path is passed to the engine and never crosses IPC.
 *
 * WHY IT DOES NOT ASK THE PROGRAMS THEMSELVES, when asking would give a better
 * answer. Each of the three can be asked authoritatively -- `claude auth status`
 * prints JSON, `codex login status` prints a sentence -- and those are the
 * commands this product tells a person to run. But a probe a screen calls on
 * mount must not start three child processes, which is the same rule
 * codexCommandIsMissing() in shell/agent-host.cjs states for the same reason. So
 * this answers what can be answered from the filesystem, and the copy hands the
 * person the official command for the rest. The product asking on their behalf
 * would be a convenience; the product being wrong about their sign-in would be a
 * dead end, and the second costs more than the first is worth.
 *
 * WHERE IT LOOKS IS NOT A THING THIS FILE DECIDES, and that boundary is load
 * bearing. On Windows the PATH a process holds is the copy it was born with --
 * for an app launched from Explorer, the environment captured at login -- so
 * anything installed since is invisible in it. That is not a subtlety: it is the
 * whole of the defect the owner reported from his second machine, where Codex
 * and Claude were installed and this file said they were not.
 * shell/machine-search-path.cjs answers "what would a newly started process
 * search", with everything that has a child process, a timeout and a cache in it,
 * and hands the answer here as a VALUE. So the fence below is unchanged in
 * strength -- no call in THIS source returns the contents of a file or starts
 * anything -- while the answer stops being wrong.
 *
 * 'unknown' IS A REAL ANSWER AND IS USED, ON BOTH HALVES. Claude Code can
 * authenticate from the operating system keychain or from a key in the
 * environment, so the absence of its sign-in file does not prove a person is
 * signed out. Reporting 'no' there would be the product telling someone to fix
 * something that is not broken. The three states are therefore: proved present,
 * proved absent from the place that program keeps it, and not determinable from
 * here.
 *
 * THE INSTALLED HALF NOW OBEYS THE SAME RULE, AND DID NOT BEFORE. It answered
 * 'no' whenever it had walked a PATH and found nothing -- including on a machine
 * whose PATH it knew was stale, and on one that had told it nothing at all. 'no'
 * is the state that shows a person an install command, so saying it on a hunch
 * is how a product tells somebody to install what they have already installed.
 * It is now reserved for a search that genuinely finished: every layer of the
 * resolution ran, and the program was in none of the directories. Anything less
 * certain is 'unknown', and the screens treat 'unknown' as "we could not find
 * it", never as "you have not got it".
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* The one thing this file asks a machine for, and it is deliberately behind a
   module boundary: everything with a child process, a timeout and a cache in it
   lives there, so the judgement below stays a pure function of its inputs and
   the fence at the bottom of tools/test/provider-cli-presence.test.mjs -- no
   call in THIS source may return the contents of a file or start anything --
   remains exactly as strict as it was. */
const { machineSearchPath } = require('./machine-search-path.cjs')

/* THE THREE PROGRAMS, AND WHERE EACH KEEPS ITS SIGN-IN.
 *
 * Every value below was MEASURED on a machine with all three installed and
 * signed in, not read off a document:
 *
 *   claude   %APPDATA%\npm\claude.cmd     ~/.claude/.credentials.json
 *   codex    %APPDATA%\npm\codex.cmd      ~/.codex/auth.json
 *   gemini   %APPDATA%\npm\gemini.cmd     ~/.gemini/oauth_creds.json
 *
 * `homeEnv` is the environment variable that RELOCATES that program's
 * configuration directory, and it is read first because a person who set one is
 * telling us where to look. Getting this wrong does not fail loudly -- it
 * reports a signed-in person as signed out, on their own machine, which is the
 * most annoying possible way to be wrong.
 *
 * `signInProves` is the honest half. 'absence' means a missing file is real
 * evidence of a signed-out state for that program; 'presence-only' means the
 * file proves a sign-in when it is there and proves nothing when it is not,
 * because that program has other ways to authenticate. Codex is the one this
 * shell already treats as decisive -- confinedSessionIsSignedOut() in
 * shell/agent-host.cjs refuses a start on exactly this missing file -- so
 * reporting 'no' for it here agrees with what the product already does rather
 * than inventing a second opinion.
 */
const PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'codex',
    command: 'codex',
    homeEnv: 'CODEX_HOME',
    homeDirectory: '.codex',
    signInFile: 'auth.json',
    signInProves: 'absence',
  }),
  Object.freeze({
    id: 'claude',
    command: 'claude',
    homeEnv: 'CLAUDE_CONFIG_DIR',
    homeDirectory: '.claude',
    signInFile: '.credentials.json',
    signInProves: 'presence-only',
  }),
  Object.freeze({
    id: 'gemini',
    command: 'gemini',
    homeEnv: 'GEMINI_CLI_HOME',
    homeDirectory: '.gemini',
    signInFile: 'oauth_creds.json',
    signInProves: 'presence-only',
  }),
  Object.freeze({ id: 'grok', command: 'grok', homeEnv: 'GROK_HOME', homeDirectory: '.grok',
    signInFile: 'auth.json', signInProves: 'presence-only' }),
])

/* THE SECOND AXIS, AND WHY ONE WORD COULD NOT CARRY IT.
 *
 * A Gemini agent runs under one of two CLIENTS on one computer, and each is a
 * different executable: the plain Gemini CLI is `gemini`, Antigravity is `agy`.
 * The account registry has always known the difference -- rotation.js filters
 * accountsFor(registry, provider) by (account.client || null) === client and
 * refuses rather than letting one client's account stand in for the other's.
 *
 * THIS FILE DID NOT KNOW IT. The Gemini row's `installed` was an OR across both
 * executables: agy present OR gemini present answered 'yes'. One word for two
 * programs, so each client's control could be offered with its own executable
 * absent -- the plain Gemini add button on a machine carrying only agy, and the
 * Antigravity button on a machine carrying only gemini.
 *
 * THE FIX IS A LIST, NOT A CONDITION. Each provider row now answers for its own
 * command and nothing else, and every declared provider-and-client pair gets
 * its own row resolved from its own executable. Adding a client is adding a
 * line here; it is not editing a branch somewhere that happens to mention a
 * provider by name.
 *
 * `command` is the only thing that varies, because it is the only thing that
 * differs: providerCliResolution() already accepts { client: 'antigravity' }
 * and swaps `agy` in, and these rows resolve through the same walk and the same
 * memo as every other command. A client row reports INSTALLATION ONLY. It
 * carries no sign-in word, because Antigravity authenticates from the operating
 * system sign-in rather than from a file this module could stat, and inventing
 * 'unknown' for a question this axis does not ask would be a field a screen
 * could branch on. */
const PROVIDER_CLIENTS = Object.freeze([
  Object.freeze({ provider: 'gemini', client: 'antigravity', command: 'agy' }),
])

const PROVIDER_IDS = Object.freeze(PROVIDERS.map(provider => provider.id))
const PRESENCE_STATES = Object.freeze(['yes', 'no', 'unknown'])

/* ONE CHOICE WITH THE ENGINE (rc-0922, the owner: "we should really be able to
 * handle these automatically so we dont need to try to parent the codex version
 * all the time").
 *
 * The engine's src/lib/providers/provider-toolchain.js is the one table of
 * agent programs: where each copy is, which copy and version, and the
 * ToolsEnabled-owned folder that installs go into. shell/main.cjs hands it here
 * with useProviderToolchain(), out of the same capability root every other host
 * module comes from. With it:
 *   - a copy ToolsEnabled installed into its own folder is chosen first, here
 *     and in the engine's executableFor(), so the app and the engine can no
 *     longer start two different copies;
 *   - providerToolchainStatus() says which copy is in use, who installed it,
 *     its version and how many copies exist -- words and a version string,
 *     never a path.
 * Without it (a payload that predates the module) everything below answers
 * exactly as before. The toolchain reads only fixed-name metadata files
 * (package.json, its own current.json); this file still reads nothing and
 * starts nothing, which the source fence in the suite keeps true. */
let providerToolchain = null

function toolchainUsable(candidate) {
  return Boolean(candidate && candidate.PROVIDER_TOOLCHAIN_VERSION === 1
    && ['ownedCopy', 'resolveProvider', 'publicCopySummary', 'personUpdateHint', 'recallProbe']
      .every(name => typeof candidate[name] === 'function'))
}

function useProviderToolchain(candidate) {
  providerToolchain = toolchainUsable(candidate) ? candidate : null
  return providerToolchain !== null
}

function toolchainFor(options) {
  if (Object.hasOwn(options, 'toolchain')) return toolchainUsable(options.toolchain) ? options.toolchain : null
  return providerToolchain
}

/* The owned copy, asked fresh on every call: it is one small file read inside
   the toolchain, and an install that just finished must be seen at once. */
function ownedProviderCopy(providerId, options, { env, platform }) {
  const toolchain = toolchainFor(options)
  if (!toolchain || options.client != null) return null
  try {
    const loginHome = platform === 'linux'
      ? (options.homedir || require('./machine-search-path.cjs').linuxLoginHome)()
      : undefined
    const copy = toolchain.ownedCopy(providerId, { env, platform, ...(loginHome ? { loginHome } : {}) })
    return copy && copy.launchable ? copy : null
  } catch {
    return null
  }
}

/* Is a program of this name runnable from a command line on this computer?
 *
 * THE DEFECT THIS WAS REOPENED FOR, reported by the owner from his own second
 * machine: "i have claude and codex downloaded and installed and signed it but
 * when i try to launch agents it says nothing was started and to run winget
 * install openAI". Both programs were installed. This function said they were
 * not, and the product handed him an install command for software he already
 * had.
 *
 * WHY. It walked `env.PATH`, which on Windows is the copy this process was born
 * holding -- for an app launched from Explorer, the environment captured at
 * login. An install performed afterwards writes its directory into the REGISTRY
 * copy of PATH; a running process never sees it. Measured 2026-08-23 on the
 * machine that found this: 37 live entries against 36 inherited, and the one
 * missing from the process was a winget package directory. The product's own
 * guide recommends winget. So: install exactly as instructed, then be told to
 * install.
 *
 * THE HARDCODED VENDOR DIRECTORY IS GONE. This used to stat `%APPDATA%\npm`
 * before it looked at PATH -- one installer's default location, written into
 * our source. It was there for a real reason and it solved that reason for
 * exactly one installer, which is why a winget install was invisible on a
 * machine where npm installs were fine. shell/machine-search-path.cjs answers
 * the same question generally, by asking the operating system what a newly
 * started process would search, and by asking a package manager where IT puts
 * things rather than assuming. Nothing about npm, winget, scoop, chocolatey or
 * anyone else appears below.
 *
 * THE RESOLVED PATH ARRIVES AS A VALUE, and this function stays pure. Reading
 * the registry is a machine act with a child process and a timeout in it;
 * deciding what is installed is arithmetic over a list of directories. Keeping
 * them apart is what lets the whole judgement be driven from a test with no
 * machine behind it, and lets the machinery be replaced without touching the
 * judgement.
 *
 * THE EXTENSION LIST IS THE RESOLUTION ON WINDOWS, and that part is unchanged.
 * An npm global directory ships THREE files per program -- `codex`, `codex.cmd`
 * and `codex.ps1` -- and only the second is a thing cmd.exe can run. A check for
 * a bare `codex` passes on the extensionless shim, which is a bash script, and
 * reports a program the shell cannot start.
 *
 * IT PROVES PRESENCE, OR ABSENCE, OR NEITHER, AND THE THIRD IS NOT A FAILURE.
 * 'no' is now reserved for a search that genuinely finished: every layer of the
 * resolution ran and the program was in none of the directories. A search that
 * could not finish -- no PATH at all, a registry this account may not read, a
 * layer that timed out, a package manager that has not answered yet -- returns
 * 'unknown'. That distinction is the whole repair: 'no' is what shows somebody
 * an install command, and it may only be said when it is true.
 */
function commandResolution(command, { env, platform, statSync, accessSync, searchPath }) {
  let uncertain = false
  // A supplied Linux machine uses POSIX paths even on a Windows test host.
  const paths = platform === 'linux' ? path.posix : path
  const extensions = platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(value => value.trim()).filter(Boolean)
    : ['']
  for (const directory of searchPath.directories) {
    if (!directory) continue
    for (const extension of extensions) {
      try {
        const candidate = paths.join(directory, `${command}${extension}`)
        if (!statSync(candidate).isFile()) continue
        /* A file on a POSIX PATH is not necessarily a command. Without an
           execute bit, attempting to launch it fails with EACCES, so reporting
           it as installed would enable controls that cannot succeed. Windows
           decides executability from PATHEXT instead. */
        if (platform !== 'win32') accessSync(candidate, fs.constants.X_OK)
        return Object.freeze({ installed: 'yes', executable: candidate })
      } catch (error) {
        /* One unreadable directory is not an answer about the others. */
        if (platform === 'linux' && !['ENOENT', 'ENOTDIR'].includes(error?.code)) uncertain = true
      }
    }
  }
  return Object.freeze({
    installed: searchPath.complete && !uncertain ? 'no' : 'unknown',
    executable: null,
  })
}

/* The resolution, as this function will use it, whoever supplied it.
 *
 * A caller may inject `{ directories, complete }` -- which is what the suite
 * does, and what makes every branch above drivable. Anything malformed is read
 * as "we were told nothing", never as an empty machine: a caller that passed
 * rubbish has not proved that nothing is installed.
 *
 * With nothing injected this asks shell/machine-search-path.cjs, which reads
 * once per process and caches. That module owns everything with a child process
 * in it; this file still contains no call that starts one and none that returns
 * the contents of a file, which is the fence
 * tools/test/provider-cli-presence.test.mjs asserts against this source. */
function usableSearchPath(supplied) {
  if (supplied && Array.isArray(supplied.directories)) {
    return Object.freeze({
      directories: supplied.directories,
      complete: supplied.complete === true,
    })
  }
  if (Array.isArray(supplied)) return Object.freeze({ directories: supplied, complete: false })
  return null
}

/* Where a program keeps its configuration, honouring the variable that moves it.
 * Returns null when there is no home directory to build a path from, which is
 * the case a container or a service account actually hits. */
function configurationDirectory(provider, { env, homedir, platform }) {
  const relocated = env[provider.homeEnv]
  if (typeof relocated === 'string' && relocated.trim().length > 0) {
    return provider.id === 'gemini'
      ? (platform === 'linux' ? path.posix : path).join(relocated.trim(), '.gemini')
      : relocated.trim()
  }
  let home
  try {
    home = homedir()
  } catch {
    return null
  }
  if (typeof home !== 'string' || home.length === 0) return null
  return (platform === 'linux' ? path.posix : path).join(home, provider.homeDirectory)
}

function signInPresence(provider, { env, homedir, existsSync, platform }) {
  const directory = configurationDirectory(provider, { env, homedir, platform })
  if (!directory) return 'unknown'
  let present
  try {
    present = existsSync((platform === 'linux' ? path.posix : path).join(directory, provider.signInFile))
  } catch {
    return 'unknown'
  }
  if (present) return 'yes'
  /* The honest half. Only Codex treats a missing file as proof, because this
     shell already refuses a start on exactly that basis. */
  return provider.signInProves === 'absence' ? 'no' : 'unknown'
}

/**
 * What each of the three programs looks like on this computer.
 *
 * Returns `{ ok: true, providers: [{ id, installed, signedIn }] }`. Every value
 * is a word from a closed set; there is no path, no version, no account and no
 * credential anywhere in the answer. `ok` is always true because there is no
 * failure this can suffer that is not already expressed as 'unknown' on one
 * provider -- a caller branching on `ok` would be branching on nothing.
 *
 * The injected `fs`, `os`, `platform` and `searchPath` are how the suite drives
 * a machine it is not running on.
 *
 * THE SIGN-IN HALF STILL CACHES NOTHING: a person who signs in and comes back to
 * this screen must see the new answer, and a cache is how they would not. Every
 * call re-stats the sign-in files.
 *
 * WHAT THE MACHINE'S SEARCH PATH DOES CACHE, and why the two differ. Resolving
 * that path costs two child processes, and this probe runs on every mount of
 * three screens; doing it per call would spend a tenth of a second of the main
 * process each time somebody navigated. It is read once per process and held.
 * The one thing that changes it is an install finishing, and that is the one
 * explicit invalidation: shell/main.cjs calls invalidateMachineSearchPath()
 * when a provider install exits. A sign-in changes a file this function reads
 * fresh anyway, so nothing about a sign-in is stale.
 *
 * AND NEITHER DID THE WALK ACROSS IT, WHICH IS WHERE THE TIME ACTUALLY WENT.
 * Caching the search PATH removed the two child processes and left the
 * expensive half untouched: commandResolution() walks every directory on that
 * path and, on Windows, every PATHEXT extension inside each one -- three
 * providers x |PATH| x |PATHEXT| stat calls, about 1,600 on a normal machine.
 * Measured 2026-09-02, two independent runs: 78-84 ms and 84-97 ms per call,
 * on the Electron MAIN thread. It is paid on every compose-panel open, every
 * board mount, every home mount, every setup mount, and twice inside a single
 * agent:availability. src/views/computers.js still describes it as "a handful
 * of fs.statSync calls" and authorises a re-ask on every panel open on that
 * basis; that sentence was the premise, and it was wrong by two orders.
 *
 * THE MEMO KEY IS THE SEARCH PATH OBJECT ITSELF, so invalidation cannot be
 * forgotten. machineSearchPath() hands back one frozen object for the life of
 * the process and sets its cache to null on invalidateMachineSearchPath(), so
 * the next call after an install returns a DIFFERENT object, the identity test
 * below misses, and the walk runs again. There is no second invalidation seam
 * to keep in step with the first -- the one that exists is the one that works.
 * The same is true of the unsettled-registry case: while that is still moving,
 * a fresh object comes back each time and nothing is held.
 *
 * ONLY THE AMBIENT CALL IS MEMOISED. Any injected env, platform, statSync,
 * accessSync or searchPath skips the memo entirely, both ways: an injected
 * reader is never served a remembered answer and never contributes one. That
 * is the same rule 883d589 wrote for the ACL inspector, and for the same
 * reason -- the suite drives a machine it is not running on, and a memo that
 * crossed that boundary would let one test's machine answer another's.
 *
 * THE SIGN-IN HALF IS OUTSIDE ALL OF THIS and is still computed on every call.
 *
 * WHAT IS REMEMBERED IS THE WHOLE RESOLUTION, NOT JUST THE VERDICT, and that is
 * a repair rather than a generalisation. commandResolution() produces BOTH
 * halves of the answer in one walk -- the word this function reports and the
 * file path providerCliExecutable() below hands the engine. Remembering only
 * the word meant the walk was memoised for the screens and then paid in full,
 * again, by the one caller on the agent start path: MEASURED 2026-09-03 on this
 * machine, 40 ambient calls each, providerCliPresence() 0.36 ms from the memo
 * while providerCliExecutable('claude') cost 24.85 ms (p90 30.11) -- 420 stat
 * calls on the Electron MAIN thread, once per Claude session start. Holding the
 * resolution lets both halves read one answer.
 *
 * IT IS FILLED PER PROGRAM, so no caller ever pays for a walk it did not ask
 * for. providerCliPresence() needs all three and fills all three;
 * providerCliExecutable() needs one and fills one. A start that runs before any
 * screen has mounted therefore still walks exactly the one path it walks today.
 */
let ambientResolutions = null

/* The memo, under the two rules the tests below hold it to: keyed on the search
 * path OBJECT so the one existing invalidation seam is the only one there is,
 * and skipped entirely -- both ways -- for any injected reader, so a fixture's
 * machine can neither be served the real answer nor replace it. */
function resolutionsFor(commands, { env, platform, statSync, accessSync, searchPath, ambient }) {
  const held = ambient && ambientResolutions && ambientResolutions.searchPath === searchPath
    ? ambientResolutions.byCommand
    : null
  const answers = new Map()
  for (const command of commands) {
    if (held && held.has(command)) {
      answers.set(command, held.get(command))
      continue
    }
    answers.set(command, commandResolution(command, { env, platform, statSync, accessSync, searchPath }))
  }
  if (ambient) {
    const byCommand = held || new Map()
    for (const [command, resolution] of answers) byCommand.set(command, resolution)
    ambientResolutions = { searchPath, byCommand }
  }
  return answers
}

function providerCliPresence(options = {}) {
  const env = options.env || process.env
  if ([env, process.env].some(environment => Object.keys(environment).some(name => name.toUpperCase() === 'TOOLSENABLED_PROVIDER_ISOLATION_ROOT'))) {
    // Isolated sessions have named accounts. A setup-page probe must never
    // look in the OS owner's default home to answer for those accounts.
    return Object.freeze({
      ok: true,
      providers: Object.freeze(PROVIDERS.map(provider => Object.freeze({
        id: provider.id, installed: providerCliResolution(provider.id, options).installed, signedIn: 'unknown',
      }))),
      /* The same two axes here as below: an isolated session's screens gate the
         same controls, and a reply that carried the client axis on one path and
         not the other would make the gate depend on which path answered. */
      clients: Object.freeze(PROVIDER_CLIENTS.map(entry => Object.freeze({
        provider: entry.provider,
        client: entry.client,
        installed: providerCliResolution(entry.provider, { ...options, client: entry.client })?.installed || 'unknown',
      }))),
    })
  }
  const platform = options.platform || process.platform
  const statSync = options.statSync || fs.statSync
  const accessSync = options.accessSync || fs.accessSync
  const existsSync = options.existsSync || fs.existsSync
  const homedir = options.homedir || (platform === 'linux'
    ? require('./machine-search-path.cjs').linuxLoginHome : os.homedir)
  /* The Linux tree uses the OS owner's default provider home, not LIVE's
     synthetic HOME or inherited account selectors. Named accounts have their
     own registry probe. Make the setup page answer about that same default. */
  const signInEnv = platform === 'linux' ? {} : env
  const searchPath = usableSearchPath(options.searchPath)
    || machineSearchPath({ platform, env })

  const ambient = !options.env && !options.platform && !options.statSync
    && !options.accessSync && !options.searchPath

  const resolutions = resolutionsFor(
    [...PROVIDERS.map(provider => provider.command), ...PROVIDER_CLIENTS.map(entry => entry.command)],
    { env, platform, statSync, accessSync, searchPath, ambient },
  )

  return Object.freeze({
    ok: true,
    /* EACH ROW ANSWERS FOR ITS OWN COMMAND. This line used to read
       `provider.id === 'gemini' && resolutions.get('agy').installed === 'yes'`,
       an OR across two different executables, so one word decided the fate of
       two different clients' controls. See PROVIDER_CLIENTS above. */
    providers: Object.freeze(PROVIDERS.map(provider => Object.freeze({
      id: provider.id,
      installed: ownedProviderCopy(provider.id, options, { env, platform })
        ? 'yes' : resolutions.get(provider.command).installed,
      signedIn: signInPresence(provider, { env: signInEnv, homedir, existsSync, platform }),
    }))),
    clients: Object.freeze(PROVIDER_CLIENTS.map(entry => Object.freeze({
      provider: entry.provider,
      client: entry.client,
      installed: resolutions.get(entry.command).installed,
    }))),
  })
}

/* The path is intentionally available only to main-process launch code. The
 * renderer-facing providerCliPresence() above keeps returning closed-set words
 * and no path. Launching from this exact resolution closes the split where the
 * setup screen found a native claude.exe on the live machine PATH but the
 * engine independently guessed claude.cmd, which does not exist for Claude's
 * native Windows install.
 *
 * THE SAME WALK, THE SAME MEMO, THE SAME INVALIDATION. This used to run its own
 * copy of the resolution the presence probe had already remembered -- 24.85 ms
 * of Electron main thread per Claude session start, measured 2026-09-03, for an
 * answer sitting in a cache one function above. It now reads that cache under
 * the identical rules: keyed on the search path object, so an install finishing
 * still clears it through the one seam that exists (shell/main.cjs calls
 * invalidateMachineSearchPath()), and skipped for any injected reader.
 *
 * AN INSTALL COMPLETED WHILE THE APP IS OPEN IS AS VISIBLE AS IT WAS. The
 * presence probe -- which is what decides whether a Claude session is offered at
 * all -- has been served from this same memo since it was added; a program that
 * appeared without the search path changing was already invisible to it, and
 * this reads exactly what that answered. What is gone is the second walk, not a
 * second chance to notice. */
function providerCliResolution(providerId, options = {}) {
  const base = PROVIDERS.find(candidate => candidate.id === providerId)
  if (!base || (options.client != null && !(providerId === 'gemini' && options.client === 'antigravity'))) return null
  const provider = options.client === 'antigravity' ? { ...base, command: 'agy' } : base

  const env = options.env || process.env
  if ([env, process.env].some(environment => Object.keys(environment).some(name => name.toUpperCase() === 'TOOLSENABLED_PROVIDER_ISOLATION_ROOT'))) {
    try {
      const policy = options.providerIsolation
      if (!policy || typeof policy.resolvePrivateProviderExecutable !== 'function') throw new Error('Private policy unavailable')
      const resolved = policy.resolvePrivateProviderExecutable(providerId, env, { client: options.client || null })
      if (options.client === 'antigravity' && resolved?.client !== 'antigravity') throw new Error('Private Antigravity executable unavailable')
      if (!resolved) throw new Error('Private executable unavailable')
      return Object.freeze({ installed: 'yes', executable: resolved.executablePath })
    } catch (error) {
      return Object.freeze({ installed: error?.code === 'AGENT_PROVIDER_ISOLATION_EXECUTABLE_REQUIRED' ? 'no' : 'unknown', executable: null })
    }
  }
  const platform = options.platform || process.platform
  const owned = ownedProviderCopy(providerId, options, { env, platform })
  if (owned) return Object.freeze({ installed: 'yes', executable: owned.path })
  const statSync = options.statSync || fs.statSync
  const accessSync = options.accessSync || fs.accessSync
  const searchPath = usableSearchPath(options.searchPath)
    || machineSearchPath({ platform, env })

  const ambient = !options.env && !options.platform && !options.statSync
    && !options.accessSync && !options.searchPath

  return resolutionsFor([provider.command], {
    env, platform, statSync, accessSync, searchPath, ambient,
  }).get(provider.command)
}

/* WHICH COPY, WHOSE, WHICH VERSION, AND HOW MANY -- for the Settings screen.
 *
 * Every copy the toolchain finds on the same search path the presence probe
 * walks, plus the owned folder and the fixed login-home folders. The answer is
 * words from closed sets (installed, channel, owner, feature state), a version
 * string, a count, and for a copy the person owns the program's own update
 * command as text. No path. `available: false` means this copy of the app has
 * no toolchain and the screen says nothing more than it did before. */
function providerToolchainStatus(options = {}) {
  const toolchain = toolchainFor(options)
  if (!toolchain) return Object.freeze({ ok: true, available: false, providers: Object.freeze([]) })
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const loginHome = platform === 'linux'
    ? (options.homedir || require('./machine-search-path.cjs').linuxLoginHome)()
    : undefined
  const searchPath = usableSearchPath(options.searchPath)
    || machineSearchPath({ platform, env, ...(loginHome ? { loginHome } : {}) })
  const rows = [...PROVIDERS.map(provider => ({ id: provider.id, client: null })),
    ...PROVIDER_CLIENTS.map(entry => ({ id: entry.provider, client: entry.client }))]
  return Object.freeze({
    ok: true,
    available: true,
    providers: Object.freeze(rows.map(({ id, client }) => {
      try {
        const resolution = toolchain.resolveProvider(id, { client, env, platform,
          ...(loginHome ? { loginHome } : {}),
          searchDirectories: searchPath.directories, searchComplete: searchPath.complete })
        const summary = toolchain.publicCopySummary(resolution)
        const probe = resolution.chosen ? toolchain.recallProbe(resolution.chosen) : null
        return Object.freeze({
          id, client,
          installed: summary.installed,
          channel: summary.channel,
          owner: summary.owner,
          version: summary.version,
          copies: summary.copies,
          others: summary.others,
          features: probe && typeof probe.state === 'string' ? probe.state : 'unknown',
          updateCommand: resolution.chosen ? toolchain.personUpdateHint(id, resolution.chosen, { client }) : null,
        })
      } catch {
        return Object.freeze({ id, client, installed: 'unknown', channel: null, owner: null, version: null,
          copies: 0, others: Object.freeze([]), features: 'unknown', updateCommand: null })
      }
    })),
  })
}

function providerCliExecutable(providerId, options = {}) {
  return providerCliResolution(providerId, options)?.executable || null
}

module.exports = {
  PROVIDER_IDS,
  PROVIDER_CLIENTS,
  PRESENCE_STATES,
  providerCliExecutable,
  providerCliResolution,
  providerCliPresence,
  providerToolchainStatus,
  useProviderToolchain,
}
