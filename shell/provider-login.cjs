'use strict'

/* GET EACH ASSISTANT PROGRAM ONTO THIS COMPUTER, AND START ITS OWN SIGN-IN.
 * Two presses per program, and nothing else.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. The first external user of 1.0.20 followed
 * the guide: `winget install OpenAI.Codex`, then `codex login` "in the same
 * window". The same window answered "'codex' is not recognized" -- winget
 * records the new program's location in the registry and a shell that is
 * already open never re-reads it -- and they were stuck at the exact step the
 * owner predicted would be the frustrating one. Reproduced 2026-08-19 against
 * a PATH snapshotted before the install.
 *
 * WHAT A PRESS DOES NOW, and it is the same shape for all three programs:
 *
 *   INSTALL   runs the official `npm install -g <package>`, out of sight.
 *             Codex can also use WinGet on Windows when npm is missing. Each
 *             one genuinely finishes on its own, so it needs no window and no
 *             attention: this computer fetches the program from its maker's
 *             own channel and the panel shows what the installer prints.
 *   SIGN IN   opens a FRESH terminal window with the program's own sign-in
 *             command already running in it. The window is the person's; we
 *             start it and let go.
 *
 * WHY A FRESH WINDOW IS THE POINT AND NOT A COMPROMISE. A window opened AFTER
 * an install reads the machine's current PATH, so it can always see the
 * program the install just put there. That is the defect above, closed at the
 * root. It is also the only honest way to finish these flows: two of the three
 * cannot be completed without a place for the person to answer.
 *
 * WHAT SIGNING IN ACTUALLY IS, measured on this machine and re-read from each
 * program's own help on 2026-08-22:
 *
 *   codex-cli 0.146.0    `codex login`       prints an https line and opens the
 *                                            browser; finishes by its own local
 *                                            callback.
 *   claude 2.1.186       `claude auth login` prints an https line, opens the
 *                                            browser, and offers a paste-back
 *                                            prompt. `claude auth --help` lists
 *                                            login as "Sign in to your
 *                                            Anthropic account".
 *   gemini 0.53.0        `gemini`            has no sign-in subcommand at all
 *                                            (its --help lists mcp, extensions,
 *                                            skills, hooks, gemma and a query).
 *                                            It asks how you want to sign in
 *                                            the first time it starts.
 *
 * TWO OF THOSE THREE WANT AN ANSWER TYPED BACK, and that is the whole reason
 * the sign-in is a terminal now rather than a hidden child. A paste-back
 * prompt cannot be answered through this product -- rule 1 below closes the
 * only pipe it could arrive on -- so a hidden sign-in could START a flow it
 * was structurally unable to FINISH. In the person's own window they finish it
 * themselves, and no credential, code or paste is ever anywhere near us.
 *
 * THE RULES, each held by tools/test/provider-login.test.mjs against this
 * source because most of them are absences of code:
 *
 *   1. STDIN IS 'ignore' ON EVERYTHING THIS PRODUCT SPAWNS. The login flows
 *      have a paste-a-code fallback; a code pasted into this product would be
 *      a credential-shaped secret passing through our hands. There is no pipe
 *      to write into, so it cannot.
 *   2. NOTHING HERE READS A FILE'S CONTENTS. Existence checks only -- statSync,
 *      and lstatSync for the one entry statSync cannot answer for (see
 *      entryExists below). The programs write their own sign-in stores; this
 *      module never learns where, let alone what.
 *   3. THE INSTALL GOES THROUGH THE HIDDEN SEAM; THE SIGN-IN OPENS A WINDOW ON
 *      PURPOSE. This rule used to read "every spawn goes through the hidden
 *      seam, so no console window can reach the desktop", and for the install
 *      that is still exactly right. It cannot be right for the sign-in: the
 *      terminal is the thing the person is meant to SEE and work in. So the
 *      two are separate injected seams with opposite jobs, the visible one is
 *      reached only from start(), and the window it opens is handed nothing to
 *      read and read by nobody.
 *   4. THE ENVIRONMENT IS THE PERSON'S OWN UNLESS THEY NAMED A SECOND ACCOUNT.
 *      With no account named -- which is every press of the Sign in button on
 *      the Settings section This computer -- nothing is added and nothing is redirected: the
 *      sign-in lands where the program always keeps it, the same as running
 *      the command by hand. That was the whole of this rule, and it made a
 *      SECOND account impossible: these programs select which sign-in they use
 *      with an environment variable and nothing else, so a window that could
 *      not carry one could only ever sign in the same single identity again.
 *      A caller that passes `home` -- the directory the product created for
 *      that account -- gets a window with that program's own home variable
 *      already set in it: CODEX_HOME for codex, CLAUDE_CONFIG_DIR for claude,
 *      GEMINI_CLI_HOME for gemini. The accounts menu's Sign in button is that
 *      caller (shell/main.cjs mc-accounts:sign-in, handing over the folder
 *      the account store recorded). See terminalInvocation() for how it is
 *      carried, and note what the person is told: the echoed lines are the
 *      account's name and the sign-in command, and never the variable, because
 *      the account is their business and the variable is ours.
 *   4b. EVERY SIGN-IN WINDOW SAYS WHICH ACCOUNT IT IS FOR. Two windows running
 *      `codex login` are identical, and until 2026-09-03 they were also both
 *      untitled, so a person signing two accounts in had no way to tell them
 *      apart. signInWindowTitle() below builds one name -- used for the title
 *      bar and printed as the window's first line -- and bounds the one part a
 *      person typed, because that name is written into a command line cmd.exe
 *      parses twice.
 *   5. WHAT CROSSES TO THE RENDERER IS BOUNDED PROSE. Colour codes stripped,
 *      lines capped. Exit is a number. No path, no environment, and nothing a
 *      terminal window prints -- because nothing reads it.
 */

// DEV sessions opt in through TOOLSENABLED_PROVIDER_ISOLATION_ROOT. Their
// engine policy owns every home/cache/install path; no named account or no
// paired policy means refusal. A standalone terminal keeps sign-in within the
// DEV process scope, and only private npm installs are supported there.

const path = require('node:path')
/* THE THIRD COPY OF ONE DEFECT. This decided whether a person is offered the
   Install and Sign in buttons at all, from the PATH this process inherited --
   which on Windows is whatever Explorer captured at login. Anything installed
   after that is invisible, so somebody who had just installed a program was
   told it was not there. The same mistake lived in provider-cli-presence.cjs
   and in agent-host.cjs's codexCommandIsMissing. One resolver answers all
   three now: it reads the live machine and user PATH rather than the stale
   inherited one, and it names no vendor and no install location. */
const { machineSearchPath, linuxLoginHome } = require('./machine-search-path.cjs')
const { providerCliResolution } = require('./provider-cli-presence.cjs')

/* `npmPackage` is the name the OFFICIAL install command takes. The programs
 * are never bundled into this product -- Claude Code's licence grants no
 * redistribution (measured: its LICENSE.md is all-rights-reserved), and the
 * legal record REQ-engine-bundle-provider-clis.md settles the question with
 * fetch-on-demand -- so the install button runs `npm install -g <package>` and
 * the person's own machine fetches the program from the provider's own
 * channel. Not a byte of any of them passes through or ships with us.
 *
 * `argv` IS WHAT THE PROGRAM ITSELF CALLS SIGNING IN, and gemini's is empty
 * because gemini has no sign-in subcommand: running it IS the sign-in. An
 * invented `gemini auth login` would be a command the window answers
 * "unknown", which is the failure this whole module exists to end.
 *
 * The npm layout entries below are USED ONLY TO ANSWER "is it on this
 * computer". Nothing here launches them: the terminal window resolves the
 * plain command name against the machine's own current PATH, which is the
 * property that makes a fresh window the fix. */
const LOGIN_PROVIDERS = Object.freeze({
  codex: Object.freeze({
    id: 'codex',
    command: 'codex',
    argv: Object.freeze(['login']),
    /* WHAT THAT PROGRAM CALLS ITS HOME, copied field for field from the
       engine's own table (capability/src/lib/multi-account/registry.js) rather
       than remembered, because this is the variable that decides WHICH sign-in
       a second account gets and a wrong one signs the wrong identity in. All
       three programs have one now (CODEX_HOME, CLAUDE_CONFIG_DIR,
       GEMINI_CLI_HOME). `null` would mean a program has no such variable, and
       start() still refuses a caller naming a home for such a program rather
       than quietly giving it an unscoped sign-in -- the branch is kept so a
       program added without a variable fails closed. */
    homeEnv: 'CODEX_HOME',
    npmPackage: '@openai/codex',
    // Install the stable channel; protocol compatibility is checked at runtime.
    npmInstallSpec: '@openai/codex',
    wingetInstall: Object.freeze({ id: 'OpenAI.Codex' }),
    npmEntry: Object.freeze(['npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js']),
  }),
  claude: Object.freeze({
    id: 'claude',
    command: 'claude',
    argv: Object.freeze(['auth', 'login']),
    homeEnv: 'CLAUDE_CONFIG_DIR',
    npmPackage: '@anthropic-ai/claude-code',
    /* The npm package's bin maps straight to a native exe, read from its own
       package.json (2.1.186) and confirmed present on 2026-08-22. */
    npmEntry: Object.freeze(['npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe']),
  }),
  gemini: Object.freeze({
    id: 'gemini',
    command: 'gemini',
    argv: Object.freeze([]),
    /* GEMINI_CLI_HOME is the variable gemini-cli reads for where its own
       directory lives (the one that would otherwise be ~/.gemini, holding
       oauth_creds.json once somebody has signed in). It is the same field the
       engine's account registry now carries for a gemini entry
       (capability/src/lib/multi-account/registry.js, `homeDir`), and the shell
       store's table in ./account-registry.cjs names the same variable;
       tools/test/account-registry.test.mjs holds the two equal. */
    homeEnv: 'GEMINI_CLI_HOME',
    npmPackage: '@google/gemini-cli',
    /* Read off the installed package's own bin field on 2026-08-22:
       { "gemini": "bundle/gemini.js" }. */
    npmEntry: Object.freeze(['npm', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js']),
  }),
  grok: Object.freeze({
    id: 'grok', command: 'grok', argv: Object.freeze(['login']), homeEnv: 'GROK_HOME',
    npmPackage: '@xai-official/grok',
    npmEntry: Object.freeze(['npm', 'node_modules', '@xai-official', 'grok', 'bin', 'grok']),
  }),
})

const LOGIN_PROVIDER_IDS = Object.freeze(Object.keys(LOGIN_PROVIDERS))

/* The names a person reads in an install sentence. */
const LOGIN_PROVIDER_LABELS = Object.freeze({ codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI', grok: 'Grok' })

/* THE LOCAL-RUNTIME HALF OF THIS SERVICE, ADDED ALONGSIDE THE THREE CLI
 * PROGRAMS ABOVE RATHER THAN AS A SECOND BRIDGE (owner ruling via fleet-B:
 * extend window.mcProviders with new verbs on the SAME object). A model on
 * the user's own GPU has none of what the three programs above need -- no
 * npm package, no sign-in, no terminal -- so it does not fit installStart()/
 * start() as they stand. It DOES fit fly()'s actual job (spawn one command
 * hidden, stream bounded lines, track one flight, answer stop/stopAll)
 * exactly as well as an npm install does, so the three methods below reuse
 * fly() and `flights` rather than reimplementing bounded, colour-stripped,
 * timed-out spawning a second time in a parallel module.
 *
 * WHY THE CURATED LIST AND THE RUNTIME TABLE ARE NEVER COPIED HERE. Both live
 * in the engine's src/lib/providers/local-node-runtime.js, staged as a
 * hostModule and required fresh by the caller in shell/main.cjs -- the exact
 * loadClaudeEngine() pattern this file's own sibling already uses for Claude.
 * This module receives that live module reference as `localNodeRuntime` (a
 * constructor option, defaulting to null so a payload without it still
 * carries every existing provider capability) and reads
 * RUNTIMES/CURATED_MODELS/detect() off it at call time. There is nothing to
 * keep in sync because nothing is duplicated -- zero drift by construction. */
const LOCAL_MODEL_UNAVAILABLE = Object.freeze({
  ok: false,
  code: 'LOCAL_MODEL_UNAVAILABLE',
  reason: 'This copy cannot read local model runtimes. Update ToolsEnabled on this computer, then try again.',
})

/* ONLY WINDOWS EXECUTES AN INSTALL DIRECTLY, AND THE REASON IS STRUCTURAL, NOT
 * A PREFERENCE. spawnHidden REFUSES a shell (HIDDEN_SPAWN_SHELL_REFUSED --
 * engine src/lib/proc/hidden-spawn.js): it takes one executable and an argv
 * array, never a pipeline. On win32 every RUNTIMES[x].installCommand is
 * exactly that shape -- 'winget install <id>' or 'pip install vllm', a single
 * program and its arguments, read off local-node-runtime.js's own table --
 * so it can be split on spaces. Only the winget ones are run, and only as
 * wingetInstallArgs() spells them; pip is shown, never run (see
 * localWingetPackage below). installCommandPosix is not
 * uniformly that shape: LM Studio's own entry is prose ("See lmstudio.ai (no
 * single-command installer on this platform)"), and Ollama's is a
 * curl-into-sh pipeline, which spawnHidden cannot run at all. So a POSIX
 * install command is always shown for the person to run themselves, never
 * executed here -- the same "commands are text, buttons are text plus a
 * spawn" split this file already draws for npm vs. Codex/Claude/Gemini's
 * sign-in. */
const LOCAL_INSTALL_EXECUTABLE_PLATFORMS = Object.freeze(['win32'])

/* winget prompts to accept the package's licence and the source's licence
 * unless told not to, and this spawn's stdin is closed (rule 1, this file's
 * own header) -- an unanswered prompt would sit until the watchdog kills it
 * 15 minutes later and read to a person as "nothing happened". These are
 * winget's own documented unattended flags (`winget install --help`), added
 * only when the resolved executable is winget itself, never appended to pip
 * or to anything this table did not name. NOT LIVE-TESTED against a real
 * winget install in this pass -- flagged in the execution report; the flags
 * are winget's documented ones, not guessed. */
const WINGET_UNATTENDED_ARGS = Object.freeze(['--silent', '--accept-package-agreements', '--accept-source-agreements'])

/* THE ONE WINGET LINE THIS FILE RUNS, for Codex and for the local runtimes
 * alike: the named package id only (`--exact`, never a fuzzy name search),
 * from the winget source only (never the Store), for this Windows user only
 * (`--scope user`: LM Studio's package also carries an all-users installer,
 * which winget could otherwise pick on a machine whose settings prefer it),
 * and with no prompt left open. */
function wingetInstallArgs(id) {
  return ['install', '--id', id, '--exact', '--source', 'winget',
    '--scope', 'user', '--disable-interactivity', ...WINGET_UNATTENDED_ARGS]
}

/* A winget package id as the runtime table writes it (Publisher.Package). */
const WINGET_PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/

/* WHAT A LOCAL-RUNTIME INSTALL MAY RUN FOR THE PERSON: winget, and nothing
 * else. winget installs the runtime's own package for this user and touches
 * nothing the person already has. `pip install vllm` is the opposite: it
 * would install into whichever Python happens to come first on PATH, changing
 * a Python the person may use for something else -- and vLLM has no native
 * Windows build in any case (its own install guide sends Windows users to
 * WSL). So pip, and any table command that is not exactly
 * `winget install <package id>`, is shown for the person to run where they
 * choose, never run here. */
function localWingetPackage(program, words) {
  if (program !== 'winget' || words.length !== 2 || words[0] !== 'install') return null
  return WINGET_PACKAGE_ID_RE.test(words[1]) ? words[1] : null
}

/* A FIXED TABLE STRING, NEVER PERSON-TYPED INPUT. Every string this splits is
 * one of RUNTIMES[x].installCommand -- four frozen literals in a file this
 * shell already trusts enough to require() -- so a plain whitespace split is
 * safe here in a way it would never be for anything a person could type; no
 * shell ever re-parses the result (spawnHidden refuses one). */
function splitCommandLine(line) {
  return String(line || '').trim().split(/\s+/).filter(Boolean)
}

/* A person-facing model name, bounded the same way local-node-runtime.js's
 * own MODEL_ID_RE bounds it (that pattern is not exported, so this is a
 * conservative twin: what it accepts is a subset of what the engine would,
 * never a superset). This becomes argv[2] to a spawnHidden call that refuses
 * a shell, so the risk this guards is a malformed or absurd argument reaching
 * a real child process, not shell injection -- spawnHidden has no shell to
 * inject into. */
const LOCAL_MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/

/** The exact words that will be running in the window. */
function signInLine(providerId) {
  const provider = LOGIN_PROVIDERS[providerId]
  if (!provider) return null
  return [provider.command, ...provider.argv].join(' ')
}

/* THE WINDOW'S NAME, AND WHY AN UNTITLED ONE IS A DEFECT.
 *
 * MEASURED 2026-09-03, read out of this file and shell/main.cjs: nothing on
 * either side put an account name anywhere a person could see it. The window
 * is opened through `start ""` (shell/main.cjs openTerminalWindow, whose own
 * measurement note ends "one thing the form costs: `start ""` gives the window
 * an empty title bar"), and the only line printed inside it was the sign-in
 * command -- which is the SAME three words for every Codex account on the
 * computer. Two accounts signed in at once are therefore two windows with
 * empty title bars and identical contents; six are six. The owner had two to
 * sign in and could not tell the windows apart.
 *
 * SO THE ACCOUNT IS NAMED TWICE, in the two places a person looks, and the two
 * are one string built once: the title bar (through `start`, which takes its
 * first quoted word as the title) and the first line printed in the window
 * (the echo below, which is also what a Windows Terminal tab shows before the
 * program prints anything). Windows Terminal's own TAB title is NOT set by
 * this change: `wt --title` is its documented flag, this machine has no wt.exe
 * to measure it on, and an unmeasured flag that makes wt refuse the whole
 * command line would cost a window rather than a title. "Not measured" is why
 * it is absent, not "does not work".
 *
 * WHAT IS ALLOWED IN A TITLE, AND WHY THE LIST IS SHORT. The account name is
 * the one string on this path a PERSON typed: shell/account-registry.cjs keeps
 * it exactly as typed, in any alphabet, and refuses only a name with no letter
 * or digit in it at all. This title is written into a command line that cmd.exe
 * parses twice -- once for the outer `cmd /c start`, once inside the window --
 * so a `&` or a `"` in a name would arrive there as an operator or as the end
 * of the quoted title, not as a character. Letters and digits IN ANY SCRIPT
 * survive, because the registry's rule is that the name is the person's in
 * whatever alphabet they write it, along with the space, dot, dash and
 * underscore that hold names together; every other character becomes a space.
 * This bounds what we WRITE INTO A COMMAND LINE. It judges nothing: the
 * registry still holds the name as typed and every screen still shows it whole.
 */
const TITLE_UNSAFE = /[^\p{L}\p{N} ._-]+/gu
const TITLE_LENGTH_LIMIT = 96
const SIGN_IN_TITLE_LEAD = 'ToolsEnabled sign-in'

function safeWindowTitle(text) {
  if (typeof text !== 'string') return ''
  return text.replace(TITLE_UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_LENGTH_LIMIT).trim()
}

/* THE CHECK AT THE SEAM THAT WRITES THE COMMAND LINE, so the guarantee is
 * structural rather than a promise about callers. safeWindowTitle() above is
 * the only producer and it bounds the person-typed half; the frame around it
 * (the colon and the dash) is ours and fixed, which is why this predicate
 * accepts a colon that the producer does not. shell/main.cjs consoleWindowArgs
 * asks this before putting a title into `start`, and falls back to the empty
 * title -- the behaviour before this change -- for anything else. */
const WINDOW_TITLE_ALLOWED = /^[\p{L}\p{N} ._:-]{0,120}$/u

function windowTitleIsSafe(text) {
  return typeof text === 'string' && WINDOW_TITLE_ALLOWED.test(text)
}

/** What one sign-in window is called: the program, and the account when named. */
function signInWindowTitle(providerId, label, client = null) {
  const provider = client === 'antigravity' && providerId === 'gemini'
    ? { command: 'agy' } : LOGIN_PROVIDERS[providerId]
  if (!provider) return ''
  const account = safeWindowTitle(label)
  /* THE PROGRAM IS IN IT EVEN WHEN THE ACCOUNT IS. Names are unique PER PROGRAM
     and not across them -- shell/account-registry.cjs states it: "school" may
     be both a Codex account and a Claude one -- so a title carrying only the
     name can still name two windows the same, which is the defect this is
     closing rather than a smaller version of it. */
  return account
    ? `${SIGN_IN_TITLE_LEAD}: ${account} - ${provider.command}`
    : `${SIGN_IN_TITLE_LEAD}: ${provider.command}`
}

/* Forwarding caps for the install stream. A long install prints a screenful;
   thousands of lines is a malfunction being relayed to a renderer, and the cap
   is the mercy. */
const LINE_LIMIT = 400
const LINE_LENGTH_LIMIT = 500
// One finite allowance for the complete install, including recovery stages.
// Large official downloads on a slow connection can exceed fifteen minutes.
const TIMEOUT_MS = 30 * 60 * 1000

/* Colour and cursor codes, stripped so the panel shows words. The first
   character of the pattern below is a real escape byte, which no editor and no
   diff will show you. Lose it in an edit and the pattern still compiles, still
   matches, and quietly stops stripping anything -- so if this ever looks like
   it is doing nothing, that byte is the first thing to check. */
const ANSI_PATTERN = /\[[0-9;?]*[ -/]*[@-~]/g

/* WHERE A WINDOWS PROGRAM WE DID NOT INSTALL IS ALLOWED TO COME FROM.
 *
 * The rule is the one this codebase already made and wrote down in the
 * engine's uac-delegation.js and proved in its
 * tests/system-binaries-resolve-under-system-root.test.js: a system binary is
 * named by ABSOLUTE PATH under %SystemRoot%\System32, never by a name PATH
 * resolves. A PATH carrying Git for Windows, MSYS2, Cygwin or WSL interop
 * answers plain names with something else entirely, and that is a hijack
 * vector as well as a bug. SystemRoot is READ, not assumed: imaged machines,
 * non-C: system drives and localized deployments all move Windows. */
const SYSTEM_SHELL = Object.freeze(['System32', 'cmd.exe'])

/* Windows Terminal is not a system binary and is not under System32. It is
   installed per-user from the Store, and the entry every shell reaches it
   through is the app execution alias in the person's own local data. */
const WINDOWS_TERMINAL = Object.freeze(['Microsoft', 'WindowsApps', 'wt.exe'])

function systemRoot(env) {
  const configured = env.SystemRoot || env.SYSTEMROOT || env.windir
  return typeof configured === 'string' && configured.trim() ? configured.trim() : 'C:\\Windows'
}

/* Only ENOENT answers the existence question. Resource pressure, an unreadable
 * device, and even a non-Error throw do not. Keep that distinction as an
 * exception inside the probe so every public operation can either translate it
 * into its own bounded refusal or let its caller do so without mistaking it for
 * absence. Nothing is cached here: a busy machine is asked again next press. */
function fileExists(statSync, target) {
  try {
    return statSync(target).isFile()
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

/* IS SOMETHING THERE AT ALL -- the question statSync alone cannot answer for
 * an app execution alias.
 *
 * MEASURED on this machine, 2026-08-22, node 22.19:
 *   statSync(%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe)  -> throws EACCES
 *   lstatSync(same)                                        -> ok, a link, 93 bytes
 *
 * So a plain isFile() check reports Windows Terminal ABSENT on a machine that
 * has it, and everybody on such a machine would silently get the fallback.
 * That is exactly the "resolve it, do not assume" trap. lstatSync answers the
 * existence question without following the link and without reading a byte, so
 * rule 2 above still holds. */
function entryExists(statSync, lstatSync, target) {
  try {
    if (fileExists(statSync, target)) return true
  } catch (error) {
    /* EACCES is the measured shape of a Windows app-execution alias: lstat is
       specifically the operation that can answer it. Other failures say
       nothing about existence and must not be converted into absence. */
    if (!error || error.code !== 'EACCES') throw error
  }
  try {
    lstatSync(target)
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

const INSTALL_CHECK_FAILED = Object.freeze({
  ok: false,
  code: 'PROVIDER_LOGIN_INSTALL_CHECK_FAILED',
  reason: 'This computer could not check whether the program is installed. This does not mean the program is absent; try again in a moment.',
})

/* The same fresh PATH walk the presence probe uses, and for the same reason it
 * must be fresh: this answer is taken at the moment of the press, so a person
 * who installed a minute ago is found a minute later. */
function commandOnPath(command, { env, platform, statSync, lstatSync, readSearchPath }) {
  const { directories, complete } = readSearchPath({ platform, env })
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const extensions = platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(value => value.trim()).filter(Boolean)
    : ['']
  for (const directory of directories) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${command}${extension}`)
      // WinGet may be a Windows app execution alias, like Windows Terminal.
      // Only callers that support aliases opt in to the lstat fallback.
      if (lstatSync ? entryExists(statSync, lstatSync, candidate) : fileExists(statSync, candidate)) return candidate
    }
  }
  // Known hits are usable while discovery settles; a miss is not yet absence.
  if (complete !== true) throw Object.assign(new Error(INSTALL_CHECK_FAILED.reason), { code: INSTALL_CHECK_FAILED.code })
  return null
}

/* IS THIS PROGRAM ON THIS COMPUTER? Decided fresh at every press, and used only
 * to decide whether opening a window would be a kindness or a dead end. What
 * the window RUNS is the plain command name, resolved by the new shell against
 * the machine's own PATH. */
function installedHere(provider, { env, platform, statSync, readSearchPath }) {
  const appData = env.APPDATA
  if (appData && provider.npmEntry && fileExists(statSync, path.join(appData, ...provider.npmEntry))) return true
  return Boolean(commandOnPath(provider.command, { env, platform, statSync, readSearchPath }))
}

/* THE TERMINAL THIS COMPUTER ACTUALLY HAS, preferred in the order a person
 * would want it: Windows Terminal when it is here, the Command Prompt when it
 * is not. Both are resolved to a real absolute path and neither is assumed. */
function resolveTerminal({ env, platform, statSync, lstatSync, accessSync, privateSession = false }) {
  if (platform === 'linux') {
    /* Fixed system programs, not a terminal name resolved by a stale PATH.
       LIVE keeps GNOME's acknowledgement. A private session uses standalone
       xterm so an existing GNOME server cannot outlive its process guardian. */
    for (const [program, kind] of [
      privateSession ? ['/usr/bin/xterm', 'linux-xterm'] : ['/usr/bin/gnome-terminal', 'linux-gnome-terminal'],
    ]) {
      if (!fileExists(statSync, program)) continue
      accessSync(program, require('node:fs').constants.X_OK)
      for (const helper of ['/usr/bin/env', '/bin/bash']) {
        if (!fileExists(statSync, helper)) return null
        accessSync(helper, require('node:fs').constants.X_OK)
      }
      return Object.freeze({ kind, program, lead: Object.freeze([]) })
    }
    return null
  }
  const commandPrompt = path.join(systemRoot(env), ...SYSTEM_SHELL)
  if (!fileExists(statSync, commandPrompt)) return null
  // A reused Windows Terminal server may replace the complete child env.
  // A new cmd console inherits this session's pinned profile directly.
  if (privateSession) return Object.freeze({ kind: 'command-prompt', program: commandPrompt, lead: Object.freeze(['/d']) })
  const localData = env.LOCALAPPDATA
  if (typeof localData === 'string' && localData.trim()) {
    const windowsTerminal = path.join(localData, ...WINDOWS_TERMINAL)
    if (entryExists(statSync, lstatSync, windowsTerminal)) {
      return Object.freeze({
        kind: 'windows-terminal',
        program: windowsTerminal,
        lead: Object.freeze([commandPrompt]),
      })
    }
  }
  return Object.freeze({ kind: 'command-prompt', program: commandPrompt, lead: Object.freeze([]) })
}

/* WHAT THE WINDOW IS TOLD TO DO, and why the command is echoed before it runs.
 *
 * The owner's instruction is that the window arrives with the command already
 * in it, printed for the person. `cmd /k` runs a command and then STAYS, which
 * is what lets somebody read what happened and try again in the same window --
 * but on its own it prints nothing, so the person never sees the line that is
 * running. Echoing it first is the difference between a window that is doing
 * something and a window that shows you what it is doing.
 *
 * MOST OF THIS NEEDS NO QUOTING AND THAT IS DELIBERATE. Every word of the
 * sign-in is a fixed identifier from the table above -- no path, no name, no
 * person's data -- so there is no argument that could be mis-parsed by the
 * shell that receives it. `/k` takes the rest of the line verbatim, so the `&&`
 * needs no escape.
 *
 * `assign` IS THE ONE WORD THAT CARRIES A PATH, and it is how a second account
 * signs in at all: these programs choose which sign-in they use from an
 * environment variable, so a window that cannot carry one can only ever sign in
 * the same identity again. It arrives as `set <NAME>=<directory> &&` in front
 * of the command, which is the form that works in the window this product
 * opens.
 *
 * WHY IT IS IN THE COMMAND LINE RATHER THAN ONLY IN THE CHILD'S ENVIRONMENT.
 * It is in BOTH -- see start() -- and the command line is the half that cannot
 * be lost. Windows Terminal can be configured to hand a new tab to an ALREADY
 * RUNNING wt process (its `windowingBehavior` setting), and that process has
 * its own environment, not the one we passed. The words survive that; an
 * inherited variable does not. Getting this wrong does not fail loudly: the
 * window opens, the sign-in works, and it signs in the DEFAULT account while
 * the person believes they have a second one -- which is exactly the silent
 * wrong-identity outcome the account registry exists to prevent.
 *
 * THE SEPARATOR IS GLUED TO THE ASSIGNMENT WHEN THE WORD NEEDS NO QUOTES, AND
 * THAT IS MEASURED, NOT STYLE. Three parsers sit between this array and the
 * person's screen: node/libuv assembles one Windows command line from it, and
 * cmd.exe re-parses that line. cmd's `set` takes the WHOLE REST OF THE TOKEN,
 * including the space that libuv put before the `&&`. Measured here on
 * 2026-08-23, with the directory read back out of the child's own environment:
 *
 *   set CODEX_HOME=C:\...\cloud-a && codex login     -> the value gains a
 *                                                       trailing space
 *   set CODEX_HOME=C:\...\cloud-a&& codex login      -> exact
 *   set "CODEX_HOME=C:\a b\cloud-a" && codex login   -> exact
 *   set "CODEX_HOME=C:\a b\cloud-a&&" codex login    -> nothing after the &&
 *                                                       ever runs
 *
 * libuv wraps an argument in quotes when, and only when, it contains a space, a
 * tab or a double quote (uv/src/win/process.c, quote_cmd_arg). When it does,
 * the closing quote ends the value and the separator must be OUTSIDE it; when
 * it does not, there is nothing to end the value but the separator itself, so
 * the separator must be glued on. The predicate below is libuv's own, which is
 * what keeps the two halves from disagreeing.
 *
 * A trailing space in the value is not cosmetic: it is a different directory
 * name, and the account signs in somewhere nobody chose. */
const LIBUV_WILL_QUOTE = /[ \t"]/

/* Data travels as argv, never substituted into shell source. Do not start an
   interactive login shell: its rc files can replace the selected account.
   The terminal, not this app, owns all provider input/output. */
const LINUX_SIGN_IN_SCRIPT = [
  'printf "%s\\n%s\\n\\n" "$1" "$2"',
  'shift 2',
  '"$@"',
  'login_result=$?',
  'if [ "$login_result" -eq 0 ]; then exit 0; fi',
  'printf "\\nSign-in command finished (exit %s). Press Enter to close.\\n" "$login_result"',
  'IFS= read -r login_done',
  'exit "$login_result"',
].join('\n')

/* A reused terminal server must not contribute its credentials, shell hooks,
   or provider selectors. Only desktop/browser plumbing crosses into the new
   terminal, plus the exact home chosen by the account contract. */
function linuxSignInEnvironment(env, ownerHome, provider, accountHome) {
  const selected = {}
  for (const key of [
    'PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'DISPLAY', 'WAYLAND_DISPLAY',
    'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
    'XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP', 'XDG_SESSION_TYPE', 'DESKTOP_SESSION',
    // Snap/Flatpak browser desktop files can live outside /usr/share. Without
    // these discovery roots, gio can send an HTTPS sign-in to a text editor.
    'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS',
  ]) {
    if (typeof env[key] === 'string' && !env[key].includes('\0')) selected[key] = env[key]
  }
  selected.PATH = selected.PATH || '/usr/local/bin:/usr/bin:/bin'
  selected.HOME = ownerHome
  selected[provider.homeEnv] = accountHome
  if (provider.client === 'antigravity') Object.assign(selected, { HOME: accountHome, USERPROFILE: accountHome,
    XDG_CONFIG_HOME: path.posix.join(accountHome, '.config'), XDG_CACHE_HOME: path.posix.join(accountHome, '.cache'),
    XDG_DATA_HOME: path.posix.join(accountHome, '.local', 'share') })
  return selected
}

function linuxTerminalInvocation(terminal, words, { title, line, env }) {
  const child = [
    '/usr/bin/env', '-i', ...Object.entries(env).map(([key, value]) => key + '=' + value),
    '/bin/bash', '--noprofile', '--norc', '-c', LINUX_SIGN_IN_SCRIPT,
    'toolsenabled-provider-sign-in', title, line, ...words,
  ]
  return Object.freeze({
    command: terminal.program,
    args: Object.freeze(terminal.kind === 'linux-xterm'
      ? ['-T', title, '-e', ...child]
      : ['--window', '--title', title, '--working-directory', env.HOME, '--', ...child]),
  })
}

function assignmentWords(assign) {
  if (!assign) return []
  const word = `${assign.name}=${assign.value}`
  return LIBUV_WILL_QUOTE.test(word) ? ['set', word, '&&'] : ['set', `${word}&&`]
}

function terminalInvocation(terminal, words, { assign = null, title = '', displayWords = words } = {}) {
  /* SPLIT ON THE SPACES, because libuv wraps an argument in quotes when and
     only when it holds a space (LIBUV_WILL_QUOTE above) and cmd's `echo` prints
     those quotes. One word per argument is the form that reaches the screen as
     the title and nothing else. Every word has already been through
     safeWindowTitle, so none of them is an operator. */
  const named = title && windowTitleIsSafe(title) ? String(title).split(' ').filter(Boolean) : []
  return Object.freeze({
    command: terminal.program,
    /* WHAT IS ECHOED, AND WHY IT IS TWO LINES RATHER THAN ONE. The first names
       the account this window is for -- without it, every sign-in window on the
       computer prints the same three words and a person with two open cannot
       tell which is which (see signInWindowTitle above for the measurement).
       The second is the sign-in command and nothing else: the person asked to
       sign an account in; they did not ask to learn the name of an environment
       variable, and a line that opened with one would read as an instruction
       they were expected to understand. The account name is theirs and is the
       whole point of the first line; the variable is ours and stays off both. */
    args: Object.freeze([
      ...terminal.lead, '/k',
      ...(named.length ? ['echo', ...named, '&&'] : []),
      'echo', ...displayWords, '&&', ...assignmentWords(assign), ...words,
    ]),
  })
}

/**
 * The service the shell owns. Everything a test needs to vary is injected;
 * production passes the capability payload's spawnHidden for the install and
 * the shell's own terminal opener for the sign-in.
 *
 * start(providerId) -> { ok: true, terminal } | { ok: false, code, reason }
 *   A window opens and this product lets go of it. There is no stream, no
 *   output and nothing to stop -- the person closes their own window.
 *
 * installStart(providerId, emit) -> { ok: true } | { ok: false, code, reason }
 *   emit receives, in order, any of:
 *     { kind: 'line', op, text }   one readable line the installer printed
 *     { kind: 'exit', op, code }   it finished; code is null on a kill
 * stop(providerId)  -> { ok: true, stopped }   stopped=false when idle
 * stopAll()         -> kills every install in flight; for the app quitting
 * running(providerId) -> boolean
 */
function createProviderLoginService(options = {}) {
  const {
    spawnHidden,
    openTerminal,
    // THE NO-PROVIDER SWITCH (R38-app). fly() below already runs every child
    // through spawnHidden, which honours this on its own. openTerminal() does
    // not -- shell/main.cjs's openTerminalWindow spawns a real terminal
    // emulator directly with the real provider binary on its command line
    // (see start() below), and neither it nor its raw child_process.spawn
    // consult any switch. Same seam as spawnHidden: both come from the
    // engine's src/lib/proc/hidden-spawn.js, required once in shell/main.cjs
    // and threaded through here, so the two checks can never name two
    // different environment variables.
    providerSpawnRefused,
    env = process.env,
    providerIsolation = null,
    platform = process.platform,
    statSync = require('node:fs').statSync,
    lstatSync = require('node:fs').lstatSync,
    accessSync = require('node:fs').accessSync,
    loginHome = linuxLoginHome,
    readSearchPath = machineSearchPath,
    timers = { setTimeout, clearTimeout },
    timeoutMs = TIMEOUT_MS,
    /* The engine's local-node-runtime.js, required fresh in shell/main.cjs and
       handed in here -- or null, on a payload that predates it (or one built
       without the hostModules entry staged). Every local-model method below
       answers LOCAL_MODEL_UNAVAILABLE rather than throwing when this is null,
       the same fail-open-to-a-named-refusal shape providerLoginService itself
       gets when spawnHidden/openTerminal cannot be resolved in main.cjs. */
    localNodeRuntime = null,
    /* The runtime detector can discover OpenAI-compatible servers that the
       interactive Local adapter cannot actually speak to. Keep the
       adapter's resolver beside the detector so readiness means a session
       could start, not merely that some port answered. */
    localNodeProcess = null,
    /* The engine's src/lib/providers/provider-toolchain.js, handed in by
       shell/main.cjs from the same capability root, or null on a payload that
       predates it. With it, an install goes into ToolsEnabled's own folder
       (never `npm -g` into the person's prefix), is checked against the
       options ToolsEnabled passes, and only then becomes the copy in use. */
    providerToolchain = null,
  } = options
  if (typeof spawnHidden !== 'function') {
    throw new TypeError('createProviderLoginService requires the hidden-spawn seam')
  }
  if (typeof openTerminal !== 'function') {
    throw new TypeError('createProviderLoginService requires the terminal-window seam')
  }
  if (typeof providerSpawnRefused !== 'function') {
    throw new TypeError('createProviderLoginService requires the providerSpawnRefused seam')
  }
  const isolated = [env, process.env].some(environment => Object.keys(environment).some(name => name.toUpperCase() === 'TOOLSENABLED_PROVIDER_ISOLATION_ROOT'))
  if (isolated && (!providerIsolation || providerIsolation.PROVIDER_SESSION_ISOLATION_VERSION !== 1 || ['providerSessionEnvironment', 'resolvePrivateProviderExecutable', 'codexFileCredentialArgs']
    .some(method => typeof providerIsolation[method] !== 'function'))) {
    throw Object.assign(new Error('This copy cannot enforce private provider sign-in and installation.'), { code: 'AGENT_PROVIDER_ISOLATION_UNAVAILABLE' })
  }
  function operationEnvironment(options = {}) {
    return isolated ? providerIsolation.providerSessionEnvironment(env, options) : env
  }
  function isolationRefusal(error) {
    return { ok: false, code: error?.code || 'AGENT_PROVIDER_ISOLATION_INVALID',
      reason: 'This operation could not stay within this session’s private provider profile. No program was started.' }
  }
  const dedicatedWorkerRequired = Object.freeze({ ok: false, code: 'PROVIDER_ISOLATION_DEDICATED_WORKER_REQUIRED',
    reason: 'This installer or model service changes shared computer state. Use a dedicated worker or OS account for this operation.' })

  /* providerId -> { child, timer, op, lines, remainder }. Installers share
     npm's global layout, so only one may write it at a time. */
  const flights = new Map()
  const lastOutcome = new Map()

  /* The listener ultimately writes to a renderer. A window can disappear
     between its isDestroyed() check and send(), and Electron throws in that
     race. Child-process events are delivered outside the IPC request that
     started the install, so letting that throw escape would become an
     uncaught exception in the main process. The install must still be cleaned
     up even when there is no longer a screen to receive its last event. */
  function emitSafely(emit, packet) {
    try { emit(packet) } catch { /* the receiving window is already gone */ }
  }

  function stopCause(flight) {
    return {
      ...(flight.stopReason ? { stopReason: flight.stopReason } : {}),
      ...(flight.stopReason === 'timeout' ? { timedOut: true } : {}),
    }
  }

  function finish(providerId, flight, code, emit) {
    if (flights.get(providerId) !== flight) return
    if (flight.timer) timers.clearTimeout(flight.timer)
    /* A last line with no newline on the end must not vanish with the child. */
    const rest = flight.remainder.replace(ANSI_PATTERN, '').trim()
    if (rest && flight.log.length < LINE_LIMIT) {
      const text = rest.slice(0, LINE_LENGTH_LIMIT)
      flight.log.push(text)
      emitSafely(emit, { kind: 'line', op: flight.op, text })
    }
    flight.remainder = ''
    if (!flight.stopping && flight.afterClose) {
      try {
        const next = flight.afterClose(code, flight)
        if (next?.command) {
          if (Date.now() >= flight.deadline) {
            flight.stopping = true
            flight.stopReason = 'timeout'
            code = null
          } else {
            const started = fly(providerId, flight.op, next.command, next.args, next.env, emit,
              { ...next.options, log: flight.log, deadline: flight.deadline })
            if (started.ok) return
            forward(flight, `${started.reason}\n`, emit)
            code = 1
          }
        } else if (next && Object.hasOwn(next, 'code')) code = next.code
      } catch {
        forward(flight, 'The unfinished install could not be recovered safely. The install has stopped.\n', emit)
        code = 1
      }
    }
    flights.delete(providerId)
    const exitCode = !flight.stopping && typeof code === 'number' ? code : null
    const stopped = ['user', 'shutdown'].includes(flight.stopReason)
    const cause = stopCause(flight)
    lastOutcome.set(providerId, { op: flight.op, code: exitCode, lines: flight.log.slice(), stopped, ...cause })
    emitSafely(emit, { kind: 'exit', op: flight.op, code: exitCode, ...(stopped ? { stopped: true } : {}), ...cause })
  }

  function forward(flight, chunk, emit) {
    if (flights.get(flight.providerId) !== flight) return
    const input = String(chunk)
    let offset = 0
    for (;;) {
      const cut = input.indexOf('\n', offset)
      const end = cut < 0 ? input.length : cut
      // Bound an unfinished line too; a silent newline must not allow the
      // installer to accumulate an unlimited string in the main process.
      const room = flight.log.length < LINE_LIMIT ? LINE_LENGTH_LIMIT - flight.remainder.length : 0
      if (room > 0) flight.remainder += input.slice(offset, Math.min(end, offset + room))
      if (cut < 0) return
      const text = flight.remainder.replace(ANSI_PATTERN, '').replace(/\r$/, '').trim()
      flight.remainder = ''
      offset = cut + 1
      if (!text) continue
      if (flight.log.length >= LINE_LIMIT) continue
      flight.log.push(text)
      emitSafely(emit, { kind: 'line', op: flight.op, text })
    }
  }

  function cleanupUnconfirmed(providerId, flight) {
    if (flights.get(providerId) !== flight) return
    flight.stopReason ||= 'error'
    flight.stopping = true
    flight.cleanupUnconfirmed = true
    emitSafely(flight.emit, { kind: 'state', op: flight.op })
  }

  function stopChild(providerId, flight, reason = 'user') {
    if (flights.get(providerId) !== flight) return
    // Custody may take time to settle. A late Stop/watchdog must not rewrite
    // the first reason this install was terminated.
    flight.stopReason ||= reason
    flight.stopping = true
    emitSafely(flight.emit, { kind: 'state', op: flight.op })
    try {
      const requested = typeof flight.child.terminateJob === 'function'
        ? flight.child.terminateJob() : flight.child.kill()
      // A rejected retained-handle request cannot become an unhandled main
      // process rejection or release this install's exclusive slot.
      Promise.resolve(requested).catch(() => cleanupUnconfirmed(providerId, flight))
    } catch { cleanupUnconfirmed(providerId, flight) }
  }

  /* The one place a child is attached to a flight, so the stdin rule, the
     watchdog and the caps cannot drift apart. */
  function fly(providerId, op, command, args, childEnv, emit, stage = {}) {
    let child
    try {
      child = spawnHidden(command, args, {
        env: childEnv,
        ...(isolated ? { cwd: childEnv.USERPROFILE } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        containProcessTree: true,
      })
    } catch {
      return {
        ok: false,
        code: 'PROVIDER_LOGIN_SPAWN_FAILED',
        reason: 'The installer could not be started. Press the button again in a moment.',
      }
    }
    lastOutcome.delete(providerId)
    const owned = typeof child.jobOutcome?.then === 'function' && typeof child.jobClosed?.then === 'function'
    const flight = { child, providerId, emit, timer: null, op, log: stage.log || [], remainder: '', stopping: false, cleanupUnconfirmed: false,
      afterClose: stage.afterClose, capturedStdout: '', captureOverflow: false, deadline: stage.deadline ?? Date.now() + timeoutMs }
    flights.set(providerId, flight)
    flight.timer = timers.setTimeout(() => {
      stopChild(providerId, flight, 'timeout')
    }, Math.max(0, flight.deadline - Date.now()))
    /* The watchdog must never be the thing keeping the process alive -- not
       the app at quit, and not a test runner whose fake child never exits. */
    if (flight.timer && typeof flight.timer.unref === 'function') flight.timer.unref()
    if (child.stdout) child.stdout.on('data', chunk => {
      if (!stage.captureStdout) return forward(flight, chunk, emit)
      if (flights.get(providerId) !== flight) return
      const text = String(chunk)
      // A program's own --help runs to tens of kilobytes; everything else
      // captured here is one short line.
      const room = (stage.captureLimit || 8192) - flight.capturedStdout.length
      if (text.length > room) flight.captureOverflow = true
      flight.capturedStdout += text.slice(0, room)
    })
    if (child.stderr) child.stderr.on('data', chunk => forward(flight, chunk, emit))
    child.on('error', () => owned ? stopChild(providerId, flight, 'error') : finish(providerId, flight, null, emit))
    child.on('exit', code => { if (!owned) finish(providerId, flight, code, emit) })
    if (owned) {
      // A Windows wrapper's exit can precede its authenticated empty-job
      // receipt and close. Linux can also report an unknown cleanup outcome.
      // Keep the retained child and block another install until BOTH facts
      // are confirmed. Never substitute a wrapper PID or exit code for them.
      Promise.all([child.jobOutcome, child.jobClosed]).then(([outcome, closed]) => {
        if (!outcome || !['exit', 'terminated', 'not-started'].includes(outcome.type)
            || outcome.activeProcesses !== 0 || outcome.failure || !closed || closed.failure) {
          cleanupUnconfirmed(providerId, flight)
          return
        }
        finish(providerId, flight, outcome.type === 'exit' ? outcome.exitCode : null, emit)
      }, () => cleanupUnconfirmed(providerId, flight))
    }
    return { ok: true }
  }

  /* IS THIS PROGRAM ALREADY ON THIS COMPUTER? One answer for installed() and
     for the install press. Throws when the machine could not be read, so a
     caller can tell "could not tell" from "no". */
  function installedNow(providerId) {
    const provider = LOGIN_PROVIDERS[providerId]
    if (!provider) return false
    if (isolated) {
      const installEnv = operationEnvironment()
      try {
        providerIsolation.resolvePrivateProviderExecutable(providerId, installEnv)
        return true
      } catch (error) {
        if (error.code === 'AGENT_PROVIDER_ISOLATION_EXECUTABLE_REQUIRED') return false
        throw error
      }
    }
    if (platform === 'linux') {
      const ownerHome = loginHome()
      if (!ownerHome) throw new Error('PROVIDER_LOGIN_INSTALL_CHECK_FAILED')
      const resolution = providerCliResolution(providerId, { env, platform, statSync, accessSync,
        ...(providerToolchain ? { toolchain: providerToolchain, homedir: () => ownerHome } : {}),
        searchPath: readSearchPath({ env, platform, loginHome: ownerHome }) })
      if (!resolution || resolution.installed === 'unknown') throw new Error('PROVIDER_LOGIN_INSTALL_CHECK_FAILED')
      return resolution.installed === 'yes'
    }
    return installedHere(provider, { env, platform, statSync, readSearchPath })
  }

  /* THE OWNED INSTALL, when this copy can do one for this program here. On
     Windows only a program whose owned copy is one native file qualifies
     (Claude Code); a node-script program there still uses its existing path. */
  function ownedInstallPlanFor(providerId) {
    const toolchain = providerToolchain
    if (isolated || !toolchain || typeof toolchain.ownedInstallPlan !== 'function' || typeof toolchain.rowFor !== 'function') return null
    const row = toolchain.rowFor(providerId)
    if (!row || !row.npmPackage) return null
    if (platform === 'win32' && row.windowsOwnedLaunch !== true) return null
    if (platform !== 'win32' && platform !== 'linux') return null
    const home = platform === 'linux' ? loginHome() : undefined
    return toolchain.ownedInstallPlan(providerId, { env, platform, ...(home ? { loginHome: home } : {}) })
  }

  /* HOW THE NEW COPY IS ASKED WHAT IT SUPPORTS, by the row's own probe kind.
     A kind this shell cannot run here (Codex's app-server schema) leaves the
     answer unknown, and the engine's own runtime fallbacks still apply. */
  const OWNED_PROBE_ARGS = Object.freeze({ help: ['--help'], 'agent-help': ['--no-auto-update', 'agent', '--help'] })

  /* npm into <owned>/<program>/.install-<n>, then the move to the version's
     own folder, then the new copy's feature check, then -- only if nothing
     required is missing -- the switch that makes it the copy in use. Each stage
     is part of one visible, stoppable install with one time allowance. */
  function flyOwnedInstall(providerId, npm, installEnv, plan, emit) {
    const toolchain = providerToolchain
    const label = LOGIN_PROVIDER_LABELS[providerId] || providerId
    const home = platform === 'linux' ? loginHome() : undefined
    const where = { env, platform, ...(home ? { loginHome: home } : {}) }
    return fly(providerId, 'install', npm, [...plan.args], { ...installEnv, ...plan.env }, emit, {
      afterClose(code, flight) {
        if (code !== 0) return { code }
        const done = toolchain.finishOwnedInstall(providerId, plan.staging, where)
        if (!done || done.ok !== true) {
          forward(flight, `The download finished, but ToolsEnabled could not find ${label} in it. Nothing was changed.\n`, emit)
          return { code: 1 }
        }
        const row = toolchain.rowFor(providerId)
        const probeArgs = OWNED_PROBE_ARGS[row?.features?.probe]
        const activate = (current, features) => {
          const switched = toolchain.activateOwnedCopy(providerId, done.version, where)
          if (!switched || switched.ok !== true) {
            forward(current, `${label} ${done.version} was downloaded, but ToolsEnabled could not switch to it. The copy it used before is unchanged.\n`, emit)
            return { code: 1 }
          }
          /* Remembered for the new copy only after the switch, which clears
             every earlier answer. */
          if (features) {
            const copy = toolchain.ownedCopy(providerId, where)
            if (copy) toolchain.rememberProbe(copy, features)
          }
          const limits = features && features.missingOptional && features.missingOptional.length
            ? ` It cannot use ${features.missingOptional.join(', ')}.` : ''
          forward(current, `ToolsEnabled now uses ${label} ${done.version} from its own folder.${limits} Nothing outside that folder was changed.\n`, emit)
          return { code: 0 }
        }
        if (!probeArgs || done.script) return activate(flight, null)
        const selfUpdateOff = toolchain.selfUpdateEnvironment(providerId, { owner: 'toolsenabled' }) || {}
        return { command: done.executable, args: probeArgs, env: { ...installEnv, ...selfUpdateOff }, options: {
          captureStdout: true,
          captureLimit: 65536,
          afterClose(probeCode, probe) {
            if (probeCode !== 0 || probe.captureOverflow) {
              forward(probe, `${label} ${done.version} was downloaded, but it did not answer its own help. ToolsEnabled keeps using the copy it used before.\n`, emit)
              return { code: 1 }
            }
            const features = toolchain.evaluateFeatures(providerId, toolchain.featuresFromHelp(providerId, probe.capturedStdout))
            if (features && features.state === 'update-needed') {
              forward(probe, `${label} ${done.version} lacks ${features.missingRequired.join(', ')}, which ToolsEnabled needs. ToolsEnabled keeps using the copy it used before.\n`, emit)
              return { code: 1 }
            }
            return activate(probe, features)
          },
        } }
      },
    })
  }

  return Object.freeze({
    /* THE SIGN-IN, WHICH IS A WINDOW AND NOTHING ELSE.
     *
     * `home` is optional and is the whole of the multi-account story on this
     * side: with none, the program signs in where it always does; with one, the
     * window carries that program's own home variable so the sign-in lands in
     * the directory the product created for that account. It is one call and
     * not two, because two ways to open a sign-in is the defect the owner has
     * ruled against twice -- and because the SECOND one would inevitably be the
     * one that forgot something this one already gets right (a resolved
     * terminal, a fresh PATH, a closed stdin, a refusal in a sentence). */
    start(providerId, { home = null, label = null, client = null } = {}) {
      if (client != null && !(providerId === 'gemini' && client === 'antigravity')) return { ok: false, code: 'ACCOUNT_CLIENT_INVALID', reason: 'That provider client is not supported.' }
      if (client === 'antigravity' && (platform !== 'linux' || isolated)) return { ok: false, code: 'PROVIDER_LOGIN_CLIENT_UNAVAILABLE', reason: 'This installation has no verified private Antigravity sign-in launcher.' }
      const provider = client === 'antigravity'
        ? { ...LOGIN_PROVIDERS.gemini, client, command: 'agy', homeEnv: 'HOME', argv: [] } : LOGIN_PROVIDERS[providerId]
      if (!provider) {
        return {
          ok: false,
          code: 'PROVIDER_LOGIN_UNKNOWN',
          reason: 'That program has no sign-in this product can start.',
        }
      }
      /* THE NO-PROVIDER SWITCH, HONOURED AT THE EARLIEST POINT THAT KNOWS THE
       * PROVIDER -- before any install probe, terminal resolution, or
       * environment assembly runs, same posture as
       * mission-bridge/actions.js's dispatch(). A sign-in opens a REAL
       * terminal running the real provider binary to do a real OAuth/device
       * flow; a packaged-QA run that sets this switch to fence provider spend
       * must stop that here, since openTerminal() itself never checks it
       * (see the seam note above). */
      if (providerSpawnRefused(env)) {
        return {
          ok: false,
          code: 'PROVIDER_LOGIN_PROVIDER_REFUSED',
          reason: 'This installation is configured to refuse starting a paid provider, so no sign-in window was opened.',
        }
      }
      const accountHome = typeof home === 'string' && home.trim() ? home.trim() : null
      if (isolated && (!accountHome || typeof label !== 'string' || !label.trim())) {
        return { ok: false, code: 'AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED',
          reason: 'Add a named account in this session, then use that account’s Sign in button.' }
      }
      if (accountHome && !provider.homeEnv) {
        /* Refused rather than ignored. Ignoring it would open a window that
           signs in the DEFAULT account while the caller believes it signed in a
           named one -- silently, and the person only finds out when their work
           bills the wrong subscription. */
        return {
          ok: false,
          code: 'PROVIDER_LOGIN_NO_ACCOUNT_HOME',
          reason: 'That program keeps one sign-in on this computer, so a second account cannot be added for it.',
        }
      }
      let isInstalled
      let executable = provider.command
      let launchPrefix = []
      let childEnv
      try {
        childEnv = operationEnvironment({ provider: providerId, home: accountHome, requireHome: isolated, create: isolated })
        if (isolated) {
          const resolution = providerIsolation.resolvePrivateProviderExecutable(providerId, childEnv)
          executable = resolution.command
          launchPrefix = resolution.prefixArgs
          childEnv = { ...childEnv, ...resolution.env }
          isInstalled = true
        } else if (platform === 'linux') {
          const ownerHome = loginHome()
          if (!ownerHome) return INSTALL_CHECK_FAILED
          const resolution = providerCliResolution(providerId, { env, platform, statSync, accessSync, client,
            ...(providerToolchain ? { toolchain: providerToolchain, homedir: () => ownerHome } : {}),
            searchPath: readSearchPath({ env, platform, loginHome: ownerHome }) })
          if (!resolution || resolution.installed === 'unknown') return INSTALL_CHECK_FAILED
          executable = resolution.executable
          isInstalled = resolution.installed === 'yes'
        } else {
          isInstalled = installedHere(provider, { env, platform, statSync, readSearchPath })
        }
      } catch (error) {
        return isolated ? isolationRefusal(error) : INSTALL_CHECK_FAILED
      }
      if (!isInstalled) {
        return {
          ok: false,
          code: 'PROVIDER_LOGIN_NOT_INSTALLED',
          reason: 'That program is not on this computer yet. Press Install first, and this button will work.',
        }
      }
      let terminal
      try {
        terminal = resolveTerminal({ env: childEnv, platform, statSync, lstatSync, accessSync, privateSession: isolated })
      } catch {
        return {
          ok: false,
          code: 'PROVIDER_LOGIN_TERMINAL_CHECK_FAILED',
          reason: 'This computer could not check for a terminal window. This does not mean a terminal is absent; try again in a moment.',
        }
      }
      if (!terminal) {
        if (isolated && platform === 'linux') {
          return { ok: false, code: 'PROVIDER_ISOLATION_TERMINAL_REQUIRED',
            reason: 'This DEV session needs xterm for its private sign-in window. Install xterm on this Linux worker, then try again.' }
        }
        return {
          ok: false,
          code: 'PROVIDER_LOGIN_NO_TERMINAL',
          reason: 'This computer has no terminal window this product can open.',
        }
      }
      /* THE NAME THIS WINDOW WILL CARRY, built once and used in both places a
         person looks: the title bar (through openTerminal's options, which
         shell/main.cjs hands to `start`) and the first line printed inside it.
         A caller that names no account still gets a titled window naming the
         program, which is what that section's three buttons open. */
      const title = signInWindowTitle(providerId, label, client)
      let terminalEnv = accountHome ? { ...childEnv, [provider.homeEnv]: accountHome } : childEnv
      let invocation
      if (platform === 'linux') {
        const ownerHome = isolated ? childEnv.USERPROFILE : loginHome()
        if (!ownerHome || !path.posix.isAbsolute(ownerHome)
          || (accountHome && (!path.posix.isAbsolute(accountHome) || accountHome.includes('\0')))) {
          return { ok: false, code: 'PROVIDER_LOGIN_HOME_UNAVAILABLE',
            reason: 'This computer could not resolve the account home. No sign-in window was opened.' }
        }
        const selectedHome = accountHome || (providerId === 'gemini' ? ownerHome : path.posix.join(ownerHome, '.' + providerId))
        terminalEnv = isolated ? childEnv : linuxSignInEnvironment(env, ownerHome, provider, selectedHome)
        /* The tree's existing admission consumes auth.json. Ask Codex itself
           to write that store; never extract or copy keyring credentials. */
        const providerArgs = providerId === 'gemini' && client !== 'antigravity'
          // Gemini has no login subcommand. Its interactive startup completes
          // authentication before handling this built-in command; no model
          // prompt is sent and a successful sign-in can close the terminal.
          ? ['--prompt-interactive', '/quit']
          : isolated && providerId === 'codex'
          ? providerIsolation.codexFileCredentialArgs([...provider.argv], terminalEnv)
          : [...(providerId === 'codex' ? ['-c', 'cli_auth_credentials_store="file"'] : []), ...provider.argv]
        const words = [executable, ...launchPrefix, ...providerArgs]
        invocation = linuxTerminalInvocation(terminal, words, {
          title, line: client === 'antigravity' ? 'Sign in to Antigravity for ' + (label || 'this account') : signInLine(providerId), env: terminalEnv,
        })
      } else {
        const providerArgs = isolated && providerId === 'codex'
          ? providerIsolation.codexFileCredentialArgs([...provider.argv], terminalEnv) : [...provider.argv]
        if (isolated && [executable, ...launchPrefix].some(word => /[\r\n%!*?&|<>^\u0022]/.test(word))) {
          return { ok: false, code: 'PROVIDER_ISOLATION_TERMINAL_PATH_UNSUPPORTED',
            reason: 'This session’s install path cannot be passed safely to a sign-in terminal.' }
        }
        invocation = terminalInvocation(terminal, [isolated ? executable : provider.command, ...launchPrefix, ...providerArgs], {
          title,
          ...(isolated ? { displayWords: [provider.command, ...provider.argv] }
            : accountHome ? { assign: { name: provider.homeEnv, value: accountHome } } : {}),
        })
      }
      try {
        /* THE ENVIRONMENT IS THE PERSON'S OWN, exactly as the install's is,
           with ONE addition and only when an account was named: that program's
           own home variable, pointing at the directory the product created for
           it. Nothing else is added and nothing is removed.

           IT IS SET HERE AS WELL AS IN THE COMMAND LINE ON PURPOSE, and this is
           belt and braces rather than two mechanisms: the command line survives
           a Windows Terminal configured to hand the tab to an already-running
           process, and the inherited variable survives anything the shell does
           to the line. Both carry the same value, so neither can win with a
           different answer. */
        const opened = openTerminal(invocation.command, [...invocation.args], {
          env: terminalEnv,
          /* WHICH TERMINAL THIS IS, because the two need different handling
             to get a window on screen: Windows Terminal makes its own, and
             the Command Prompt has to be started through `start`. The args
             above are the same either way; shell/main.cjs openTerminalWindow
             reads the kind and does the rest. */
          kind: terminal.kind,
          /* WHAT TO CALL THE WINDOW. It cannot be carried in the argument list
             above: `start` takes its title as its own first quoted word, before
             the program, and that word is written by the opener. */
          title,
        })
        if (opened && typeof opened.then === 'function') {
          return opened.then(() => ({ ok: true, terminal: terminal.kind, title }), () => ({
            ok: false, code: 'PROVIDER_LOGIN_SPAWN_FAILED',
            reason: 'The terminal did not confirm that it opened. Check for the sign-in window before trying again.',
          }))
        }
      } catch {
        return {
          ok: false,
          code: 'PROVIDER_LOGIN_SPAWN_FAILED',
          reason: 'The window could not be opened. Press the button again in a moment.',
        }
      }
      /* THE TITLE COMES BACK so the sentence a person reads can quote the words
         that are actually on the window, rather than a second copy of the same
         format written on the other side of the bridge. It is prose this
         product composed from a name that side already holds -- rule 5 above,
         unchanged: no path, no environment, nothing the window prints. */
      return { ok: true, terminal: terminal.kind, title }
    },

    /* THE INSTALL, hidden, because it finishes on its own. It runs the
       OFFICIAL package install -- `npm install -g <package>` -- so this machine
       fetches the program from the provider's own channel; nothing is bundled
       and nothing passes through this product. npm is resolved fresh from PATH
       at the press, and its absence is a refusal that names the real fix,
       because "npm failed" at a person who has never heard of npm is a dead
       end. Codex also supports its pinned WinGet package on Windows without
       making a fresh install require Node first. */
    installStart(providerId, emit, { privateCopy = false } = {}) {
      const provider = LOGIN_PROVIDERS[providerId]
      if (!provider) {
        return {
          ok: false,
          code: 'PROVIDER_LOGIN_UNKNOWN',
          reason: 'That program has no install this product can run.',
        }
      }
      if (typeof emit !== 'function') throw new TypeError('installStart() requires a listener')
      if (flights.size > 0) {
        return { ok: false, code: 'PROVIDER_LOGIN_RUNNING',
          reason: 'An installer is already running. Let it finish before starting another install.' }
      }
      if (flights.has(providerId)) {
        return {
          ok: false,
          code: 'PROVIDER_LOGIN_RUNNING',
          reason: 'Something is already running for this program. Let it finish, or press Stop.',
        }
      }
      /* NO SECOND COPY (rc-0922). The button used to install even when the
         program was already here -- by its maker's own installer, say -- which
         left two copies and let PATH order decide which one ran. A copy that is
         found is used; a second one is only ever the person's explicit choice,
         and then it goes into ToolsEnabled's own folder. A machine that could
         not be read keeps the install available, because "could not tell" is
         not "you have it". */
      const label = LOGIN_PROVIDER_LABELS[providerId] || providerId
      const ownedPlan = ownedInstallPlanFor(providerId)
      let programCheckIncomplete = false
      if (!isolated) {
        let present = false
        try { present = installedNow(providerId) } catch { present = false; programCheckIncomplete = true }
        if (present && privateCopy !== true) {
          return { ok: false, code: 'PROVIDER_LOGIN_ALREADY_INSTALLED',
            reason: `${label} is already on this computer, and ToolsEnabled uses that copy. Nothing was installed.` }
        }
      }
      if (privateCopy === true && !ownedPlan) {
        return { ok: false, code: 'PROVIDER_LOGIN_PRIVATE_COPY_UNAVAILABLE',
          reason: `This copy of ToolsEnabled cannot keep a private copy of ${label} on this computer. The copy you have is still used.` }
      }
      let npm
      let winget
      let installEnv
      let npmCheckIncomplete = false
      const canUseWinGet = !isolated && !ownedPlan && platform === 'win32' && provider.wingetInstall
      try {
        installEnv = operationEnvironment({ create: isolated })
        try {
          npm = commandOnPath('npm', { env: installEnv, platform, statSync, readSearchPath })
        } catch (error) {
          if (!canUseWinGet || error?.code !== INSTALL_CHECK_FAILED.code) throw error
          npmCheckIncomplete = true
        }
        if (!npm && canUseWinGet) {
          winget = commandOnPath('winget', { env, platform, statSync, lstatSync, readSearchPath })
        }
      } catch (error) {
        return isolated ? isolationRefusal(error) : INSTALL_CHECK_FAILED
      }
      if (winget) {
        // Fresh Windows installs need no Node prerequisite for Codex. Use the
        // same protocol pin as npm, an exact public-source match, and this
        // user's install scope. Keep the existing progress/Stop/error path.
        return fly(providerId, 'install', winget, wingetInstallArgs(provider.wingetInstall.id), env, emit)
      }
      if (!npm) {
        if (npmCheckIncomplete || programCheckIncomplete) return INSTALL_CHECK_FAILED
        if (isolated) return dedicatedWorkerRequired
        return {
          ok: false,
          code: 'PROVIDER_LOGIN_NPM_MISSING',
          reason: 'The installer needs npm, which is not on this computer. Install Node.js from nodejs.org first; npm comes with it.',
        }
      }
      if (ownedPlan) return flyOwnedInstall(providerId, npm, installEnv, ownedPlan, emit)
      // No provider CLI is tied to a desktop release number.
      const prefixArgs = isolated ? ['--prefix', installEnv.npm_config_prefix] : []
      const installArgs = [...prefixArgs, 'install', '-g', provider.npmInstallSpec || provider.npmPackage]
      return fly(providerId, 'install', npm, installArgs, installEnv, emit, {
        afterClose(code, failed) {
          if (code === 0 || typeof code !== 'number'
              || !failed.log.some(line => /^npm (?:error|ERR!) code ENOTEMPTY$/.test(line))) return null
          // Ask the same npm, with the same prefix/environment, for its actual
          // global layout. This remains one visible, stoppable install, and
          // every stage waits for its retained process tree to close.
          forward(failed, 'Recovering an unfinished install before retrying.\n', emit)
          return { command: npm, args: [...prefixArgs, 'root', '-g'], env: installEnv, options: {
            captureStdout: true,
            afterClose(queryCode, query) {
              if (queryCode !== 0 || query.captureOverflow) return { code }
              const { quarantineNpmRetirement } = require('./provider-npm-recovery.cjs')
              const backup = quarantineNpmRetirement(query.capturedStdout, provider.npmPackage)
              if (!backup) return { code }
              return { command: npm, args: installArgs, env: installEnv, options: {
                afterClose(retryCode) { if (retryCode === 0) backup.discard(); return null },
              } }
            },
          } }
        },
      })
    },

    stop(providerId) {
      const flight = flights.get(providerId)
      if (!flight) return { ok: true, stopped: false }
      stopChild(providerId, flight)
      const running = flights.has(providerId)
      return { ok: true, stopped: !running, stopping: running, running }
    },

    stopAll() {
      for (const [providerId, flight] of flights) {
        stopChild(providerId, flight, 'shutdown')
      }
    },

    snapshot(providerId) {
      if (!LOGIN_PROVIDERS[providerId] && !String(providerId).startsWith('local-')) {
        return { ok: false, known: false, code: 'PROVIDER_LOGIN_UNKNOWN', reason: 'That program has no install this product can run.' }
      }
      const flight = flights.get(providerId)
      if (flight) {
        return {
          ok: true, known: true, provider: providerId,
          state: flight.stopping ? 'stopping' : 'running',
          cleanupUnconfirmed: flight.cleanupUnconfirmed,
          ...stopCause(flight),
          op: flight.op,
          lines: flight.log.slice(),
          lastExit: null,
        }
      }
      const last = lastOutcome.get(providerId)
      if (last) {
        return {
          ok: true, known: true, provider: providerId,
          state: last.code === 0 ? 'completed' : 'failed',
          stopped: last.stopped,
          ...stopCause(last),
          op: last.op,
          lines: last.lines.slice(),
          lastExit: { code: last.code },
        }
      }
      return { ok: true, known: true, provider: providerId, state: 'idle', op: null, lines: [], lastExit: null }
    },

    running(providerId) {
      return flights.has(providerId)
    },

    /* IS THAT PROGRAM ON THIS COMPUTER, asked without opening anything.
     *
     * start() asks this already and refuses when the answer is no, which is
     * enough when a press does one thing. It is not enough for the caller that
     * ADDS AN ACCOUNT: that call creates a directory and writes a registry
     * entry before it opens a window, and finding out at the window that the
     * program was never installed would leave the person with a recorded
     * account they cannot sign in and cannot add again. So the same answer is
     * readable in advance, from the same resolver, at the same freshness -- one
     * implementation, asked twice, rather than a second probe that could drift
     * from the one that decides. */
    installed(providerId) {
      return installedNow(providerId)
    },

    /* WHAT A MODEL ON THIS COMPUTER'S OWN HARDWARE HAS. A live network probe,
       not a presence() twin -- there is no PATH or npm layout to check, only
       whether something is actually answering on loopback and holding
       weights, which is what local-node-runtime.js#detect() already measures.
       curatedModels rides along so a single call answers both "is anything
       ready" and "what could I download", read fresh off the same live
       module every time -- never cached across calls, the same freshness
       rule commandOnPath() already follows for the three CLI programs. */
    async detectLocal() {
      if (!localNodeRuntime || typeof localNodeRuntime.detect !== 'function') return LOCAL_MODEL_UNAVAILABLE
      let result
      try {
        result = await localNodeRuntime.detect()
      } catch {
        return {
          ok: false,
          code: 'LOCAL_MODEL_DETECT_FAILED',
          reason: 'This computer could not check for a local model runtime. Try again in a moment.',
        }
      }
      let ready = result.ready === true
      let readinessCode = null
      let readinessReason = result.reason
      if (ready) {
        if (!localNodeProcess || typeof localNodeProcess.resolveLocalTarget !== 'function') {
          ready = false
          readinessCode = 'LOCAL_MODEL_LAUNCHER_UNAVAILABLE'
          readinessReason = 'This copy found a local model service but cannot prove its interactive agent adapter. Update ToolsEnabled and try again.'
        } else {
          try {
            await localNodeProcess.resolveLocalTarget()
          } catch (error) {
            ready = false
            readinessCode = typeof error?.code === 'string' && /^LOCAL_NODE_[A-Z0-9_]+$/.test(error.code)
              ? error.code : 'LOCAL_MODEL_NOT_STARTABLE'
            readinessReason = 'The selected local model service cannot start an interactive agent here. Review its settings and try again.'
          }
        }
      }
      return {
        ok: true,
        ready,
        runtimes: result.runtimes,
        selected: result.selected,
        code: readinessCode,
        reason: readinessReason,
        nextCommand: result.nextCommand,
        curatedModels: Array.isArray(localNodeRuntime.CURATED_MODELS) ? localNodeRuntime.CURATED_MODELS : [],
      }
    },

    /* THE INSTALL, hidden, for the runtimes this computer's platform can run
       unattended -- see LOCAL_INSTALL_EXECUTABLE_PLATFORMS above for why that
       is win32 only. Every other case names the real command and asks the
       person to run it themselves, exactly like installStart() does when npm
       is missing: a refusal that names the actual fix, never a silent no-op. */
    installRuntime(runtimeId, emit) {
      if (isolated) return dedicatedWorkerRequired
      if (!localNodeRuntime || !localNodeRuntime.RUNTIMES) return LOCAL_MODEL_UNAVAILABLE
      const runtime = localNodeRuntime.RUNTIMES[runtimeId]
      if (!runtime) {
        return {
          ok: false,
          code: 'LOCAL_MODEL_RUNTIME_UNKNOWN',
          reason: `This copy does not know a local model runtime called ${runtimeId}. Choose one from the list.`,
        }
      }
      if (typeof emit !== 'function') throw new TypeError('installRuntime() requires a listener')
      const flightKey = `local-install:${runtimeId}`
      if (flights.has(flightKey)) {
        return {
          ok: false,
          code: 'LOCAL_MODEL_INSTALL_RUNNING',
          reason: 'Something is already running for this runtime. Let it finish, or press Stop.',
        }
      }
      if (!LOCAL_INSTALL_EXECUTABLE_PLATFORMS.includes(platform)) {
        return {
          ok: false,
          code: 'LOCAL_MODEL_INSTALL_UNSUPPORTED',
          reason: `This copy cannot run an install for you on this computer. Copy this command and run it yourself: ${runtime.installCommandPosix}`,
        }
      }
      const [program, ...words] = splitCommandLine(runtime.installCommand)
      if (!program) {
        return {
          ok: false,
          code: 'LOCAL_MODEL_INSTALL_UNSUPPORTED',
          reason: 'This runtime has no install command this copy can run.',
        }
      }
      const packageId = localWingetPackage(program, words)
      if (!packageId) {
        return {
          ok: false,
          code: 'LOCAL_MODEL_INSTALL_UNSUPPORTED',
          reason: program === 'pip'
            ? `ToolsEnabled does not run pip for you, because it would change whichever Python comes first on this computer. ${runtime.displayName} runs on Linux, or on Windows inside WSL. Run this yourself in the Python you choose: ${runtime.installCommand}`
            : `This copy runs only winget installs for you. Copy this command and run it yourself: ${runtime.installCommand}`,
        }
      }
      let resolved
      try {
        // winget is normally a Windows app execution alias: lstat finds it.
        resolved = commandOnPath('winget', { env, platform, statSync, lstatSync, readSearchPath })
      } catch {
        return INSTALL_CHECK_FAILED
      }
      if (!resolved) {
        return {
          ok: false,
          code: 'LOCAL_MODEL_INSTALLER_MISSING',
          reason: `The installer needs winget, which is not on this computer. Copy this command and run it yourself: ${runtime.installCommand}`,
        }
      }
      return fly(flightKey, 'install', resolved, wingetInstallArgs(packageId), env, emit)
    },

    /* DOWNLOAD ONE NAMED MODEL'S WEIGHTS. Scoped to Ollama only in this pass --
       see the comment on the runtime !== 'ollama' branch below for the reason
       the other three are not simply wired the same way; widening this is a
       follow-up once each one is actually measured running, not a default
       this file should assume. */
    pullModel({ runtime, model } = {}, emit) {
      // The Ollama CLI asks a daemon to mutate its store. Redirecting this
      // client's HOME cannot move a daemon that LIVE already owns.
      if (isolated) return dedicatedWorkerRequired
      if (!localNodeRuntime || !localNodeRuntime.RUNTIMES) return LOCAL_MODEL_UNAVAILABLE
      const entry = localNodeRuntime.RUNTIMES[runtime]
      if (!entry) {
        return {
          ok: false,
          code: 'LOCAL_MODEL_RUNTIME_UNKNOWN',
          reason: `This copy does not know a local model runtime called ${runtime}. Choose one from the list.`,
        }
      }
      if (typeof model !== 'string' || !LOCAL_MODEL_NAME_RE.test(model)) {
        return { ok: false, code: 'LOCAL_MODEL_INPUT_INVALID', reason: 'Name the model to pull.' }
      }
      if (typeof emit !== 'function') throw new TypeError('pullModel() requires a listener')
      /* ONLY OLLAMA'S pullCommand IS A DOWNLOAD-AND-EXIT STEP.
         RUNTIMES['llama-cpp'].pullCommand and RUNTIMES.vllm.pullCommand
         actually START A SERVER (`llama-server -hf <model>`, `vllm serve
         <model>`) -- they never exit on their own, so fly()'s 15-minute
         watchdog would eventually kill a server the person meant to keep
         running, and report that as a failed pull: the wrong outcome from
         the right mechanism. LM Studio's `lms get <model>` reads like a real
         download command by name, but was not measured against a real LM
         Studio install for this pass, so it is left as a copy-paste command
         beside the two servers rather than guessed at. */
      if (runtime !== 'ollama') {
        return {
          ok: false,
          code: 'LOCAL_MODEL_PULL_UNSUPPORTED',
          reason: `This copy cannot download a model for ${entry.displayName} yet. Copy this command and run it yourself: ${entry.pullCommand(model)}`,
        }
      }
      const flightKey = `local-pull:${runtime}:${model}`
      if (flights.has(flightKey)) {
        return { ok: false, code: 'LOCAL_MODEL_PULL_RUNNING', reason: 'That model is already downloading. Let it finish, or press Stop.' }
      }
      let resolved
      try {
        resolved = commandOnPath('ollama', { env, platform, statSync, readSearchPath })
      } catch {
        return INSTALL_CHECK_FAILED
      }
      if (!resolved) {
        return {
          ok: false,
          code: 'LOCAL_MODEL_RUNTIME_NOT_INSTALLED',
          reason: 'Ollama is not on this computer yet. Install it first, then pull a model.',
        }
      }
      return fly(flightKey, 'pull', resolved, ['pull', model], env, emit)
    },
  })
}

module.exports = {
  LOGIN_PROVIDER_IDS,
  LOGIN_PROVIDERS,
  signInLine,
  /* THE ONE PLACE A WINDOW TITLE IS BUILT, AND THE ONE CHECK THAT GUARDS IT.
     shell/main.cjs writes the title into a `start` command line and asks
     windowTitleIsSafe() first, so the bound is held where the command line is
     written rather than trusted from whoever called. Two functions, one rule;
     a second sanitiser on the other side of the seam is what would drift. */
  signInWindowTitle,
  safeWindowTitle,
  windowTitleIsSafe,
  /* EXPORTED SO THE COMMAND LINE CAN BE RUN THROUGH A REAL cmd.exe RATHER THAN
     RE-DERIVED. tools/test/provider-login.test.mjs measures what cmd actually
     ends up with; while it built the argv by copying the glue rule below, the
     rule could be broken in this file and the test stayed green -- it was
     agreeing with itself. Now it asks this function, so the thing that ships is
     the thing that is measured. */
  terminalInvocation,
  linuxTerminalInvocation,
  createProviderLoginService,
  /* Exported so the local-runtime install path can be unit-tested against
     real RUNTIMES[x].installCommand strings without constructing the whole
     service, the same reasoning terminalInvocation is exported for above. */
  splitCommandLine,
  LOCAL_MODEL_NAME_RE,
  WINGET_UNATTENDED_ARGS,
}
