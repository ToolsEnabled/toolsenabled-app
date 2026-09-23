/* THE TWO BUTTONS EVERY ASSISTANT PROGRAM GETS, AND THE WAYS THEY COULD
 * QUIETLY STOP BEING SAFE OR STOP BEING ONE PATH.
 *
 * WHAT IS BEING GUARDED. shell/provider-login.cjs is the one place this product
 * installs an assistant program for somebody, and the one place it starts that
 * program's own sign-in. The friend who installed 1.0.20 got stuck exactly
 * where the owner predicted: the guide told them to run "codex login" in the
 * window the install had just finished in, and that window answered "'codex'
 * is not recognized" -- a PATH written by an installer is not re-read by a
 * shell that is already open.
 *
 * WHAT THE MODULE DOES NOW, and what changed. The install still runs hidden:
 * `npm install -g <package>` finishes on its own and needs nobody watching.
 * The SIGN-IN no longer runs hidden. It opens a fresh terminal window with the
 * program's own command already running in it, because
 *
 *   - a window opened AFTER an install reads the machine's PATH as it is now,
 *     which is the original defect closed at its root; and
 *   - two of the three flows can ask the person to paste something back, and a
 *     paste-back cannot pass through this product (rule 1) -- so a hidden
 *     sign-in could START a flow it was structurally unable to FINISH.
 *
 * FIVE PROPERTIES, EACH WITH A TEST THAT FAILS WITHOUT IT:
 *
 *   1. NO CREDENTIAL CAN TRANSIT THIS CODE, STRUCTURALLY. The installer's stdin
 *      is 'ignore', the module contains no call that returns file contents, and
 *      the terminal window is handed no pipe and read by nobody. All three are
 *      absences of code, so all three are asserted against the source text, the
 *      same way tools/test/provider-cli-presence.test.mjs asserts its probe.
 *   2. ALL THREE PROGRAMS, ONE SHAPE. Codex, Claude and Gemini each have an
 *      install package and a sign-in command, and nothing is invented: gemini
 *      has no sign-in subcommand at all, so running the program IS its
 *      sign-in.
 *   3. THE TERMINAL IS RESOLVED, NEVER ASSUMED. Windows Terminal when it is
 *      here, the Command Prompt when it is not, both by absolute path, with
 *      SystemRoot read rather than guessed.
 *   4. IT REFUSES WHAT IT CANNOT DO, IN SENTENCES. A program that is not here
 *      is a refusal naming the button that fixes it, not a window that opens
 *      and says "not recognized".
 *   5. WHAT THE INSTALL FORWARDS IS READABLE AND BOUNDED, and the sign-in
 *      forwards nothing at all, because there is nothing listening to it.
 *
 * Run: node --test tools/test/provider-login.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MODULE_FILE = path.join(REPO_ROOT, 'shell', 'provider-login.cjs')

const { createProviderLoginService, LOGIN_PROVIDER_IDS, LOGIN_PROVIDERS, signInLine, terminalInvocation } = require_(MODULE_FILE)

const norm = value => String(value).replace(/\\/g, '/').toLowerCase()
function enoent() {
  const error = new Error('ENOENT')
  error.code = 'ENOENT'
  throw error
}

/* A child the suite can drive: emits what a test tells it to, records kills. */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => { child.killed = true; child.emit('exit', null); return true }
  return child
}

const APPDATA = 'C:/u/AppData/Roaming'
const LOCALAPPDATA = 'C:/u/AppData/Local'
const CMD = 'c:/windows/system32/cmd.exe'
const WT = 'c:/u/appdata/local/microsoft/windowsapps/wt.exe'
const NPM_CODEX = 'C:/u/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js'
const NPM_CLAUDE = 'C:/u/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
const NPM_GEMINI = 'C:/u/AppData/Roaming/npm/node_modules/@google/gemini-cli/bundle/gemini.js'

/* The fixture filesystem is exhaustive. Completeness is supplied explicitly;
   a fabricated environment alone is not evidence about a real machine. */
function completeSearchPath({ env, platform }) {
  const fallback = platform === 'win32' ? 'C:/fixture/programs' : '/fixture/programs'
  return Object.freeze({
    directories: Object.freeze((env.PATH || fallback).split(platform === 'win32' ? ';' : ':').filter(Boolean)),
    complete: true,
  })
}
const incompleteSearchPath = options => Object.freeze({ ...completeSearchPath(options), complete: false })

/**
 * `files` are ordinary files statSync can answer for.
 *
 * `links` are the OTHER kind, and they are the reason lstatSync is injected at
 * all. MEASURED on a real machine, 2026-08-22: statSync on
 * %LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe throws EACCES, while lstatSync
 * answers with a link. An app execution alias is exactly this shape, so a
 * harness that only modelled plain files would let a broken Windows Terminal
 * check pass here and fail on every machine that has one.
 */
function harness({ files = [], links = [], env = {}, platform = 'win32', providerIsolation = null, spawnHiddenImpl = null, timers, readSearchPath = completeSearchPath, providerToolchain = null } = {}) {
  const plain = new Set(files.map(norm))
  const linked = new Set(links.map(norm))
  const spawns = []
  const terminals = []
  const child = fakeChild()
  const service = createProviderLoginService({
    timers,
    spawnHidden: (command, args, options) => { spawns.push({ command, args, options }); return spawnHiddenImpl ? spawnHiddenImpl(command, args, options) : child },
    openTerminal: (command, args, options) => { terminals.push({ command, args, options }) },
    providerSpawnRefused: () => false,
    providerIsolation,
    providerToolchain,
    readSearchPath,
    env: {
      APPDATA,
      LOCALAPPDATA,
      SystemRoot: 'C:/Windows',
      PATH: '',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      ...env,
    },
    platform,
    statSync: target => {
      const key = norm(target)
      if (plain.has(key)) return { isFile: () => true }
      if (linked.has(key)) { const error = new Error('EACCES'); error.code = 'EACCES'; throw error }
      return enoent()
    },
    lstatSync: target => {
      const key = norm(target)
      if (plain.has(key) || linked.has(key)) return { isFile: () => false }
      return enoent()
    },
  })
  return { service, spawns, terminals, child }
}

/* The ordinary machine: a Command Prompt where Windows keeps it, no Windows
   Terminal, and whichever programs a test names. */
const withCmd = extra => [`C:/Windows/System32/cmd.exe`, ...extra]

/* ------------------------------------------------------------------
   1. The absences, asserted against the source because they are absences.
   ------------------------------------------------------------------ */

test('no code path can read a file, wire stdin, or reach a spawn of its own', () => {
  const source = readFileSync(MODULE_FILE, 'utf8')
  for (const forbidden of [
    'readFile', 'readFileSync', 'createReadStream', 'openSync', 'readSync',
    'writeFile', 'writeFileSync', 'appendFile',
    "require('node:child_process')", 'require("node:child_process")',
    "require('child_process')", 'require("child_process")',
    'stdin.write', "stdio: ['pipe'", 'stdio: ["pipe"',
  ]) {
    assert.ok(!source.includes(forbidden), `the provider module contains ${forbidden}`)
  }
  /* The installer's stdin must be closed by construction, not by restraint. */
  assert.match(source, /'ignore'\s*,\s*'pipe'\s*,\s*'pipe'/, "the install's stdin is not 'ignore'")
  /* And the terminal is handed no pipe either: it is the person's window. */
  assert.match(source, /openTerminal\(/, 'the sign-in no longer goes through the terminal seam')
})

test('the sign-in keeps nothing back from the window it opened', () => {
  /* WHY THIS IS AN ABSENCE TEST. The hidden sign-in it replaced captured the
     https line the program printed and offered a second control that opened it
     -- a reasonable thing to do when the person had nowhere else to see it.
     They have a window now. A captured URL, and the channel that opened it,
     would be a second way to reach one page, which is the exact shape the
     owner ruled out. */
  const source = readFileSync(MODULE_FILE, 'utf8')
  for (const gone of ['lastUrl', 'HTTPS_PATTERN', 'openExternal']) {
    assert.ok(!source.includes(gone), `the sign-in still holds on to ${gone}`)
  }
  const { service } = harness()
  assert.equal(typeof service.lastUrl, 'undefined', 'the service still exposes a captured link')
})

/* ------------------------------------------------------------------
   2. All three programs, one shape, nothing invented.
   ------------------------------------------------------------------ */

test('all three assistant programs are in the table', () => {
  assert.deepEqual([...LOGIN_PROVIDER_IDS].sort(), ['claude', 'codex', 'gemini', 'grok'])
})

test('each program carries an install package and a sign-in command', () => {
  for (const id of LOGIN_PROVIDER_IDS) {
    const provider = LOGIN_PROVIDERS[id]
    assert.match(provider.npmPackage, /^@[\w-]+\/[\w-]+$/, `${id} has no official package to install`)
    assert.ok(provider.command.length > 0, `${id} has no command to run`)
    assert.ok(Array.isArray(provider.argv), `${id} has no sign-in words`)
    assert.ok(signInLine(id).startsWith(provider.command), `${id}'s sign-in line does not start with its own program`)
  }
  assert.equal(LOGIN_PROVIDERS.codex.npmPackage, '@openai/codex')
  assert.equal(LOGIN_PROVIDERS.claude.npmPackage, '@anthropic-ai/claude-code')
  assert.equal(LOGIN_PROVIDERS.gemini.npmPackage, '@google/gemini-cli')
})

test('Codex installation and displayed commands follow the stable channel', () => {
  const copySource = readFileSync(new URL('../../src/agent-availability-copy.js', import.meta.url), 'utf8')
  assert.equal(LOGIN_PROVIDERS.codex.npmInstallSpec, '@openai/codex')
  assert.deepEqual(LOGIN_PROVIDERS.codex.wingetInstall, { id: 'OpenAI.Codex' })
  assert.ok(copySource.includes("installWithNode: 'npm install -g @openai/codex'"))
  assert.ok(copySource.includes("install: 'winget install OpenAI.Codex'"))
  assert.equal(LOGIN_PROVIDERS.claude.npmInstallSpec, undefined)
  assert.equal(LOGIN_PROVIDERS.gemini.npmInstallSpec, undefined)
})

test('the sign-in lines are the ones each program really has', () => {
  /* Read off each program's own help on 2026-08-22, never remembered.
     `claude auth --help` lists login as "Sign in to your Anthropic account";
     `codex login --help` is its own subcommand; and gemini's --help lists mcp,
     extensions, skills, hooks, gemma and a query and NOTHING else -- so its
     sign-in is running the program, which asks how you want to sign in the
     first time it starts. An invented `gemini auth login` would be a command
     the window answers "unknown", which is the failure this module exists to
     end. */
  assert.equal(signInLine('codex'), 'codex login')
  assert.equal(signInLine('claude'), 'claude auth login')
  assert.equal(signInLine('gemini'), 'gemini')
  assert.equal(signInLine('nonsense'), null)
})

test('an unknown name is refused in a sentence, and opens nothing', () => {
  const { service, spawns, terminals } = harness({ files: withCmd([]) })
  for (const wrong of ['nonsense', '', null, undefined, 7]) {
    const answer = service.start(wrong)
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'PROVIDER_LOGIN_UNKNOWN')
    assert.ok(answer.reason.length > 0)
  }
  assert.equal(spawns.length, 0)
  assert.equal(terminals.length, 0)
})

/* ------------------------------------------------------------------
   3. The terminal: resolved, never assumed, and never a bare name.
   ------------------------------------------------------------------ */

test('a sign-in opens a terminal running that program, and never spawns it here', () => {
  for (const id of LOGIN_PROVIDER_IDS) {
    const entry = { codex: NPM_CODEX, claude: NPM_CLAUDE, gemini: NPM_GEMINI, grok: 'C:/u/AppData/Roaming/npm/node_modules/@xai-official/grok/bin/grok' }[id]
    const { service, spawns, terminals } = harness({ files: withCmd([entry]) })
    const answer = service.start(id)
    assert.equal(answer.ok, true, `${id} could not be signed in`)
    assert.equal(terminals.length, 1, `${id} opened ${terminals.length} windows`)
    assert.equal(spawns.length, 0, `${id} started the sign-in here instead of in a window`)
    const words = signInLine(id).split(' ')
    const line = terminals[0].args.join(' ')
    /* The command is printed for the person and then run, which is the owner's
       instruction: the window arrives with the command already in it. */
    assert.ok(line.endsWith(`echo ${words.join(' ')} && ${words.join(' ')}`),
      `${id}'s window was told: ${line}`)
    /* AND THE WINDOW SAYS WHICH SIGN-IN IT IS, before the command. Without it
       every sign-in window for a given program prints the same words, which is
       what left the owner with two windows he could not tell apart. */
    assert.ok(line.startsWith(`/k echo ToolsEnabled sign-in: ${id} &&`),
      `${id}'s window did not name itself first: ${line}`)
  }
})

test('Windows Terminal is preferred when it is here, and it is found the way a real one appears', () => {
  /* THE MEASUREMENT THIS EXISTS FOR. On a real machine the entry every shell
     reaches Windows Terminal through is an app execution alias, and statSync
     on it throws EACCES -- so an isFile() check reports Windows Terminal
     ABSENT on a machine that has it, and everybody silently gets the fallback.
     `links` models exactly that. */
  const { service, terminals } = harness({ files: withCmd([NPM_CODEX]), links: [`${LOCALAPPDATA}/Microsoft/WindowsApps/wt.exe`] })
  const answer = service.start('codex')
  assert.equal(answer.ok, true)
  assert.equal(answer.terminal, 'windows-terminal')
  assert.equal(norm(terminals[0].command), WT)
  /* It runs the Command Prompt inside itself, named by absolute path, so wt
     does not have to resolve anything off PATH either. */
  assert.equal(norm(terminals[0].args[0]), CMD)
})

test('with no Windows Terminal the Command Prompt is opened directly', () => {
  const { service, terminals } = harness({ files: withCmd([NPM_CODEX]) })
  const answer = service.start('codex')
  assert.equal(answer.ok, true)
  assert.equal(answer.terminal, 'command-prompt')
  assert.equal(norm(terminals[0].command), CMD)
  assert.equal(terminals[0].args[0], '/k')
})

test('the window opener is told which terminal it was handed, because the two need different starts', () => {
  /* shell/main.cjs openTerminalWindow starts the Command Prompt through
     `start` -- a console program gets a window only if the process starting
     it gives it one, measured 2026-09-02 -- and hands Windows Terminal its
     arguments as they are. It can only tell the two apart if it is told. */
  const prompt = harness({ files: withCmd([NPM_CODEX]) })
  assert.equal(prompt.service.start('codex').terminal, 'command-prompt')
  assert.equal(prompt.terminals[0].options.kind, 'command-prompt')
  const windowsTerminal = harness({ files: withCmd([NPM_CODEX]), links: [`${LOCALAPPDATA}/Microsoft/WindowsApps/wt.exe`] })
  assert.equal(windowsTerminal.service.start('codex').terminal, 'windows-terminal')
  assert.equal(windowsTerminal.terminals[0].options.kind, 'windows-terminal')
})

test('the terminal is named by absolute path, and SystemRoot is read rather than guessed', () => {
  /* The rule this repo already made and proved in the engine's
     tests/system-binaries-resolve-under-system-root.test.js: a system binary is
     named by absolute path under %SystemRoot%\\System32, never by a name PATH
     resolves -- a PATH carrying Git for Windows, MSYS2 or WSL interop answers
     plain names with something else entirely. And Windows is not always at
     C:\\Windows: imaged machines and non-C: system drives move it. */
  const { service, terminals } = harness({
    files: ['D:/OtherWindows/System32/cmd.exe', NPM_CODEX],
    env: { SystemRoot: 'D:/OtherWindows' },
  })
  assert.equal(service.start('codex').ok, true)
    assert.ok(path.win32.isAbsolute(terminals[0].command), `the terminal was named ${terminals[0].command}`)
  assert.equal(norm(terminals[0].command), 'd:/otherwindows/system32/cmd.exe')
})

test('a machine with no command prompt where Windows keeps it is a refusal, not a guess', () => {
  const { service, terminals } = harness({ files: [NPM_CODEX] })
  const answer = service.start('codex')
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'PROVIDER_LOGIN_NO_TERMINAL')
  assert.equal(terminals.length, 0)
})

test('the window gets the person\'s own environment, never a redirected home', () => {
  const { service, terminals } = harness({ files: withCmd([NPM_CLAUDE]) })
  service.start('claude')
  const passed = terminals[0].options && terminals[0].options.env ? terminals[0].options.env : {}
  /* The program must write its sign-in where it always does. A CLAUDE_CONFIG_DIR
     or CODEX_HOME set here would move a person's credential without their say. */
  assert.ok(!('CLAUDE_CONFIG_DIR' in passed), 'the window was handed a redirected Claude home')
  assert.ok(!('CODEX_HOME' in passed), 'the window was handed a redirected Codex home')
  assert.equal(passed.APPDATA, APPDATA, 'the window was not handed the real environment')
})

/* ------------------------------------------------------------------
   4. Refusing what it cannot do, in sentences.
   ------------------------------------------------------------------ */

test('a program that is not here is a refusal naming the button that fixes it', () => {
  const { service, terminals } = harness({ files: withCmd([]) })
  for (const id of LOGIN_PROVIDER_IDS) {
    const answer = service.start(id)
    assert.equal(answer.ok, false, `${id} opened a window for a program that is not here`)
    assert.equal(answer.code, 'PROVIDER_LOGIN_NOT_INSTALLED')
    assert.match(answer.reason, /install/i, `${id}'s refusal does not name the fix: ${answer.reason}`)
    /* And it must not send anybody to a terminal to type something, because
       there is nothing to type any more. */
    assert.ok(!/\bcommand\b/i.test(answer.reason), `${id}'s refusal points back at a command line`)
  }
  assert.equal(terminals.length, 0)
})

test('a busy presence probe is not absence, is not cached, and ENOENT remains absence', () => {
  let mode = 'busy'
  let probes = 0
  const service = createProviderLoginService({
    spawnHidden: () => fakeChild(),
    openTerminal: () => {},
    providerSpawnRefused: () => false,
    env: { APPDATA, LOCALAPPDATA, SystemRoot: 'C:/Windows', PATH: '', PATHEXT: '.EXE' },
    platform: 'win32',
    readSearchPath: completeSearchPath,
    statSync: target => {
      probes += 1
      if (mode === 'busy') { const error = new Error('busy'); error.code = 'EMFILE'; throw error }
      if (mode === 'unknown') throw 'temporarily unavailable' // eslint-disable-line no-throw-literal
      return enoent()
    },
    lstatSync: () => enoent(),
  })

  for (const modeName of ['busy', 'unknown']) {
    mode = modeName
    const answer = service.start('codex')
    assert.equal(answer.code, 'PROVIDER_LOGIN_INSTALL_CHECK_FAILED')
    assert.match(answer.reason, /does not mean .*absent/i)
  }

  /* CONTROL: the one genuine absence error keeps the old definite answer. */
  mode = 'absent'
  assert.equal(service.start('codex').code, 'PROVIDER_LOGIN_NOT_INSTALLED')
  /* And neither failure nor absence is latched: recovery is observed on the
     next call, preserving this module's deliberate fresh-at-every-press cost. */
  const before = probes
  mode = 'busy'
  service.start('codex')
  assert.ok(probes > before, 'the earlier answer was cached instead of probing again')
})

test('an incomplete Windows search keeps sign-in and account-add presence unknown', () => {
  let complete = false
  const { service, spawns, terminals } = harness({
    readSearchPath: options => ({ ...completeSearchPath(options), complete }),
  })
  assert.equal(service.start('codex').code, 'PROVIDER_LOGIN_INSTALL_CHECK_FAILED')
  assert.throws(() => service.installed('codex'), { code: 'PROVIDER_LOGIN_INSTALL_CHECK_FAILED' })
  complete = true
  assert.equal(service.start('codex').code, 'PROVIDER_LOGIN_NOT_INSTALLED')
  assert.equal(service.installed('codex'), false)
  complete = false
  assert.equal(service.start('codex').code, 'PROVIDER_LOGIN_INSTALL_CHECK_FAILED')
  assert.equal(spawns.length, 0)
  assert.equal(terminals.length, 0)
})

test('an incomplete Windows search does not claim that npm is missing', () => {
  const { service, spawns, terminals } = harness({ readSearchPath: incompleteSearchPath })
  for (const provider of LOGIN_PROVIDER_IDS) {
    assert.equal(service.installStart(provider, () => {}).code, 'PROVIDER_LOGIN_INSTALL_CHECK_FAILED')
  }
  assert.equal(spawns.length, 0)
  assert.equal(terminals.length, 0)
  let reads = 0
  const settling = harness({ readSearchPath: options => ({ ...completeSearchPath(options), complete: ++reads > 1 }) })
  assert.equal(settling.service.installStart('codex', () => {}).code, 'PROVIDER_LOGIN_INSTALL_CHECK_FAILED',
    'a completed absent fallback does not settle the earlier incomplete npm search')
  assert.equal(settling.spawns.length, 0)
})

test('an incomplete Windows search still accepts a proven WinGet alternative to npm', () => {
  const alias = 'C:/fixture/programs/winget.exe'
  const { service, spawns, child } = harness({ links: [alias],
    env: { PATH: 'C:/fixture/programs' }, readSearchPath: incompleteSearchPath })
  assert.equal(service.installStart('codex', () => {}).ok, true)
  assert.equal(spawns.length, 1)
  assert.equal(norm(spawns[0].command), norm(alias))
  child.emit('exit', 0)
})

test('an incomplete Windows search still accepts a known program and npm', () => {
  for (const program of ['C:/fixture/programs/codex.exe', NPM_CODEX]) {
    const { service, spawns, terminals, child } = harness({
      files: withCmd([program, 'C:/fixture/programs/npm.cmd']),
      env: { PATH: 'C:/fixture/programs' }, readSearchPath: incompleteSearchPath,
    })
    assert.equal(service.installed('codex'), true)
    assert.equal(service.start('codex').ok, true)
    assert.equal(terminals.length, 1)
    /* The known program is used, not installed a second time (rc-0922). */
    assert.equal(service.installStart('codex', () => {}).code, 'PROVIDER_LOGIN_ALREADY_INSTALLED')
    assert.equal(spawns.length, 0)
    child.emit('exit', 0)
  }
})

test('a completed Windows search still reports a genuinely absent program and npm', () => {
  const { service, spawns, terminals } = harness({ readSearchPath: completeSearchPath })
  assert.equal(service.start('codex').code, 'PROVIDER_LOGIN_NOT_INSTALLED')
  assert.equal(service.installed('codex'), false)
  assert.equal(service.installStart('gemini', () => {}).code, 'PROVIDER_LOGIN_NPM_MISSING')
  assert.equal(spawns.length, 0)
  assert.equal(terminals.length, 0)
})

test('installed() answers in advance what start() decides, and a probe that fails throws so the caller can tell unknown from no', () => {
  /* The accounts menu's add asks this before it makes a folder, and refuses
     only on a definite no; a thrown probe is "unknown" and the add goes
     ahead. So the boolean must be the same answer start() would give, and
     a probe failure must not be flattened into false. */
  const here = harness({ files: withCmd([NPM_CLAUDE]) })
  assert.equal(here.service.installed('claude'), true)
  assert.equal(here.service.installed('codex'), false)
  assert.equal(here.service.installed('gpt'), false)
  assert.equal(here.service.start('claude').ok, true)
  assert.equal(here.service.start('codex').code, 'PROVIDER_LOGIN_NOT_INSTALLED')
  const busy = createProviderLoginService({
    spawnHidden: () => fakeChild(),
    openTerminal: () => {},
    providerSpawnRefused: () => false,
    env: { APPDATA, LOCALAPPDATA, SystemRoot: 'C:/Windows', PATH: '', PATHEXT: '.EXE' },
    platform: 'win32',
    statSync: () => { const error = new Error('busy'); error.code = 'EMFILE'; throw error },
    lstatSync: () => enoent(),
  })
  assert.throws(() => busy.installed('codex'), /busy/)
  assert.equal(busy.start('codex').code, 'PROVIDER_LOGIN_INSTALL_CHECK_FAILED')
})

test('a program found only on PATH counts as here', () => {
  const { service, terminals } = harness({
    files: withCmd(['C:/somewhere/bin/codex.exe']),
    env: { PATH: 'C:/other;C:/somewhere/bin' },
  })
  assert.equal(service.start('codex').ok, true)
  assert.equal(terminals.length, 1)
})

test('a terminal that will not open is a sentence, not a thrown error', () => {
  const { service } = harness({ files: withCmd([NPM_CODEX]) })
  const angry = createProviderLoginService({
    spawnHidden: () => { throw new Error('no') },
    openTerminal: () => { throw new Error('no') },
    providerSpawnRefused: () => false,
    env: { APPDATA, LOCALAPPDATA, SystemRoot: 'C:/Windows', PATH: '', PATHEXT: '.EXE' },
    platform: 'win32',
    statSync: target => (norm(target) === CMD || norm(target) === norm(NPM_CODEX) ? { isFile: () => true } : enoent()),
    lstatSync: () => enoent(),
  })
  const answer = angry.start('codex')
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'PROVIDER_LOGIN_SPAWN_FAILED')
  assert.ok(answer.reason.length > 0)
  /* And the healthy service is unaffected, which is what makes the failure the
     window's rather than the module's. */
  assert.equal(service.start('codex').ok, true)
})

test('the service refuses to exist without all three seams', () => {
  assert.throws(() => createProviderLoginService({ openTerminal: () => {}, providerSpawnRefused: () => false }), /hidden-spawn seam/)
  assert.throws(() => createProviderLoginService({ spawnHidden: () => {}, providerSpawnRefused: () => false }), /terminal-window seam/)
  assert.throws(() => createProviderLoginService({ spawnHidden: () => {}, openTerminal: () => {} }), /providerSpawnRefused seam/)
})

// R38-app: the no-provider switch must stop a sign-in from opening a real
// terminal running the real provider binary, the one spawn in this module
// that never goes through spawnHidden (openTerminal is a different program
// -- a terminal emulator -- carrying the provider as an argument on ITS
// command line, not something spawnHidden ever sees).
test('providerSpawnRefused stops a sign-in before any terminal window opens', () => {
  const { service, terminals, spawns } = harness({
    files: withCmd([NPM_CODEX]),
    env: {},
  })
  assert.equal(service.start('codex').ok, true, 'control: sign-in opens normally when the switch reports not-refused')
  assert.equal(terminals.length, 1)

  let refused = false
  const guarded = createProviderLoginService({
    spawnHidden: (command, args, options) => { spawns.push({ command, args, options }); return fakeChild() },
    openTerminal: (...args) => { terminals.push(args) },
    providerSpawnRefused: () => refused,
    env: { APPDATA, LOCALAPPDATA, SystemRoot: 'C:/Windows', PATH: '', PATHEXT: '.EXE' },
    platform: 'win32',
    statSync: target => (norm(target) === CMD || norm(target) === norm(NPM_CODEX) ? { isFile: () => true } : enoent()),
    lstatSync: () => enoent(),
  })
  const terminalsBefore = terminals.length
  refused = true
  const answer = guarded.start('codex')
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'PROVIDER_LOGIN_PROVIDER_REFUSED')
  assert.equal(terminals.length, terminalsBefore, 'no terminal opened while the switch reports refused')

  refused = false
  const control = guarded.start('codex')
  assert.equal(control.ok, true, 'the same service opens a sign-in once the switch reports not-refused')
  assert.equal(terminals.length, terminalsBefore + 1)
})

/* ------------------------------------------------------------------
   5. The install, hidden, for all three, under the old rules exactly.
   ------------------------------------------------------------------ */

const NPM_CMD = 'c:/nodejs/npm.cmd'

test('install runs the official package command through npm found fresh on PATH', () => {
  for (const id of LOGIN_PROVIDER_IDS) {
    const { service, spawns, terminals } = harness({
      files: withCmd(['C:/nodejs/npm.cmd']),
      env: { PATH: 'C:/nodejs' },
    })
    const answer = service.installStart(id, () => {})
    assert.equal(answer.ok, true, `${id} could not be installed`)
    assert.equal(norm(spawns[0].command), NPM_CMD)
    /* Where a pinned spec exists (codex), the button installs THE PIN, never
       "latest" -- see the pinned-command test above for why. */
    assert.deepEqual(spawns[0].args,
      ['install', '-g', LOGIN_PROVIDERS[id].npmInstallSpec || LOGIN_PROVIDERS[id].npmPackage])
    assert.deepEqual(spawns[0].options.stdio, ['ignore', 'pipe', 'pipe'])
    /* The install is the half that needs no window, and must not open one. */
    assert.equal(terminals.length, 0, `${id}'s install opened a terminal`)
  }
})

test('a machine without npm gets the real fix named, not an npm error', () => {
  const { service, spawns } = harness({ files: withCmd([]) })
  const answer = service.installStart('gemini', () => {})
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'PROVIDER_LOGIN_NPM_MISSING')
  assert.match(answer.reason, /Node\.js/, 'the refusal does not say where npm comes from')
  assert.equal(spawns.length, 0)
})

test('Codex installs without Node through a Windows app execution alias', () => {
  const alias = 'C:/u/AppData/Local/Microsoft/WindowsApps/winget.exe'
  const { service, spawns, terminals, child } = harness({
    links: [alias], env: { PATH: 'C:/u/AppData/Local/Microsoft/WindowsApps' },
  })
  const events = []
  assert.equal(service.installStart('codex', event => events.push(event)).ok, true)
  assert.equal(norm(spawns[0].command), norm(alias))
  assert.deepEqual(spawns[0].args, [
    'install', '--id', 'OpenAI.Codex', '--exact',
    '--source', 'winget', '--scope', 'user', '--disable-interactivity',
    '--silent', '--accept-package-agreements', '--accept-source-agreements',
  ])
  assert.deepEqual(spawns[0].options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(terminals.length, 0)
  child.stdout.emit('data', Buffer.from('Downloading Codex\n'))
  child.emit('exit', 0)
  assert.deepEqual(events, [
    { kind: 'line', op: 'install', text: 'Downloading Codex' },
    { kind: 'exit', op: 'install', code: 0 },
  ])
  assert.equal(service.running('codex'), false)
})

test('an existing npm install path takes precedence over WinGet', () => {
  const { service, spawns } = harness({
    files: ['C:/nodejs/npm.cmd', 'C:/apps/winget.exe'], env: { PATH: 'C:/nodejs;C:/apps' },
  })
  assert.equal(service.installStart('codex', () => {}).ok, true)
  assert.equal(norm(spawns[0].command), NPM_CMD)
})

test('WinGet is not offered for another provider or a Linux installation', () => {
  for (const id of ['claude', 'gemini']) {
    const { service, spawns } = harness({ files: ['C:/apps/winget.exe'], env: { PATH: 'C:/apps' } })
    assert.equal(service.installStart(id, () => {}).code, 'PROVIDER_LOGIN_NPM_MISSING')
    assert.equal(spawns.length, 0)
  }
  const { service, spawns } = harness({ platform: 'linux', files: ['/apps/winget'], env: { PATH: '/apps' } })
  assert.equal(service.installStart('codex', () => {}).code, 'PROVIDER_LOGIN_NPM_MISSING')
  assert.equal(spawns.length, 0)
})

test('WinGet failure and Stop keep the install retryable', () => {
  const { service, child, spawns } = harness({ files: ['C:/apps/winget.exe'], env: { PATH: 'C:/apps' } })
  const events = []
  assert.equal(service.installStart('codex', event => events.push(event)).ok, true)
  assert.equal(service.installStart('codex', () => {}).code, 'PROVIDER_LOGIN_RUNNING')
  child.emit('exit', 1)
  assert.equal(events.at(-1).code, 1)
  assert.equal(service.running('codex'), false)
  assert.equal(service.installStart('codex', () => {}).ok, true)
  assert.equal(service.stop('codex').stopped, true)
  assert.equal(child.killed, true)
  assert.equal(service.running('codex'), false)
  assert.equal(spawns.length, 2)
})

test('a second install while the first still runs is refused, not doubled', () => {
  const { service, spawns } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' } })
  assert.equal(service.installStart('codex', () => {}).ok, true)
  const again = service.installStart('codex', () => {})
  assert.equal(again.ok, false)
  assert.equal(again.code, 'PROVIDER_LOGIN_RUNNING')
  assert.equal(spawns.length, 1)
})

test('a sign-in never has to wait for an install, because it holds nothing', () => {
  /* The old module put both through one flight per program, so pressing Sign
     in during an install was refused. A window is not a flight: it belongs to
     the person and this product holds no handle on it. */
  /* A program that is already here is installed again only as an explicit
     private copy (rc-0922), so that is the install this runs beside. */
  const { service, terminals } = harness({
    files: withCmd(['C:/nodejs/npm.cmd', NPM_CLAUDE]),
    env: { PATH: 'C:/nodejs' },
    providerToolchain: pairedToolchain(),
  })
  assert.equal(service.installStart('claude', () => {}, { privateCopy: true }).ok, true)
  assert.equal(service.start('claude').ok, true)
  assert.equal(terminals.length, 1)
  assert.equal(service.running('claude'), true)
})

test('stop kills the installer and the next install is allowed', () => {
  const { service, child } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' } })
  service.installStart('codex', () => {})
  assert.equal(service.stop('codex').stopped, true)
  assert.equal(child.killed, true)
  assert.equal(service.installStart('codex', () => {}).ok, true)
})

test('an exit frees the flight and reaches the listener with its code', () => {
  const { service, child } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' } })
  const events = []
  service.installStart('codex', event => events.push(event))
  child.emit('exit', 0)
  assert.deepEqual(events.at(-1), { kind: 'exit', op: 'install', code: 0 })
  assert.equal(service.installStart('codex', () => {}).ok, true)
})

test('a listener lost with its window cannot crash child output or strand the install', () => {
  const { service, child } = harness({ files: ['/node/npm'], env: { PATH: '/node' }, platform: 'linux' })
  service.installStart('codex', () => { throw new Error('renderer was destroyed') })

  assert.doesNotThrow(() => child.stdout.emit('data', Buffer.from('one line\n')))
  assert.doesNotThrow(() => child.emit('exit', 0))
  assert.equal(service.running('codex'), false)
  assert.equal(service.installStart('codex', () => {}).ok, true)
})

/* ------------------------------------------------------------------
   6. What a person sees while an install runs: readable lines, and a cap.
   ------------------------------------------------------------------ */

test('output arrives as colour-stripped lines', () => {
  const { service, child } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' } })
  const events = []
  service.installStart('claude', event => events.push(event))
  child.stdout.emit('data', Buffer.from('\u001b[94madded 1 package\u001b[0m\nplain words\n'))
  const lines = events.filter(event => event.kind === 'line').map(event => event.text)
  assert.deepEqual(lines, ['added 1 package', 'plain words'])
  assert.equal(events.filter(event => event.kind === 'url').length, 0, 'a link became an event of its own again')
})

test('a last line with no newline still reaches the person', () => {
  const { service, child } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' } })
  const events = []
  service.installStart('gemini', event => events.push(event))
  child.stdout.emit('data', Buffer.from('npm warn deprecated something'))
  child.emit('exit', 1)
  const lines = events.filter(event => event.kind === 'line').map(event => event.text)
  assert.ok(lines.includes('npm warn deprecated something'), `flushed on exit, got ${JSON.stringify(lines)}`)
})

test('a flood is capped instead of forwarded forever', () => {
  const { service, child } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' } })
  const events = []
  service.installStart('codex', event => events.push(event))
  for (let index = 0; index < 4000; index += 1) {
    child.stdout.emit('data', Buffer.from(`line number ${index} of a very long stream\n`))
  }
  const lines = events.filter(event => event.kind === 'line')
  assert.ok(lines.length < 3000, `forwarded ${lines.length} lines`)
})

/* ------------------------------------------------------------------
   7. The listener never receives what a renderer must not hold.
   ------------------------------------------------------------------ */

test('no event carries a filesystem path field or an environment', () => {
  const { service, child } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' } })
  const events = []
  service.installStart('codex', event => events.push(event))
  child.stdout.emit('data', Buffer.from('hello\n'))
  child.emit('exit', 0)
  assert.ok(events.length > 0)
  for (const event of events) {
    assert.deepEqual(
      Object.keys(event).sort(),
      event.kind === 'exit' ? ['code', 'kind', 'op'] : ['kind', 'op', 'text'],
    )
  }
})

test('a sign-in sends the renderer nothing the window produced', () => {
  /* There is no stream and nothing to stop: the window is the person's from the
     moment it opens. What crosses back is whether one opened, which kind, and
     what THIS SIDE decided to call it -- three facts composed here, and not one
     byte the window printed, holds a path, or names an environment variable. */
  const { service } = harness({ files: withCmd([NPM_GEMINI]) })
  const answer = service.start('gemini', { home: HOME_A, label: 'work' })
  assert.deepEqual(Object.keys(answer).sort(), ['ok', 'terminal', 'title'])
  assert.equal(answer.title, 'ToolsEnabled sign-in: work - gemini',
    'the title is no longer the one this side composed')
  assert.ok(!answer.title.includes(HOME_A) && !answer.title.includes('GEMINI_CLI_HOME'),
    `the account's folder or its variable crossed back inside the title: ${answer.title}`)
  assert.equal(service.running('gemini'), false)
  assert.deepEqual(service.stop('gemini'), { ok: true, stopped: false })
})

/* THE COMMAND SHAPE IS NOT ONLY WELL-FORMED, IT ACTUALLY RUNS.
 *
 * Every other test in this file checks the argv we BUILD. None of them proves
 * Windows does the thing we meant with it, and that gap is where this class of
 * bug lives: `['/k', 'echo', ...words, '&&', ...words]` is handed to spawn() as
 * separate argv elements, node assembles a single Windows command line from
 * them, and cmd.exe re-parses that line by its own rules. Three parsers between
 * our intent and the person's screen.
 *
 * Measured while checking this by hand: a nearby form -- one argument holding a
 * quoted redirect -- silently did nothing at all. Exit code 0, no error, no
 * file. So "it looks right" is not evidence about this, and the owner's rule is
 * that the installer paths get checked before every publication rather than
 * once by somebody who happened to wonder.
 *
 * This runs the real shape with a harmless command in place of a sign-in: /c so
 * the window closes itself, and a mkdir whose directory existing afterwards is
 * the proof that the half AFTER the && executed -- which is the half that is
 * actually the sign-in. It signs nothing in and leaves nothing behind. */
test('the echo-then-run shape survives node and cmd.exe and really executes', async () => {
  if (process.platform !== 'win32') return

  const { spawn } = await import('node:child_process')
  const os = await import('node:os')
  const fs = await import('node:fs')
  const nodePath = await import('node:path')

  const terminal = nodePath.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'cmd.exe')
  const proof = nodePath.join(os.tmpdir(), `provider-login-shape-${process.pid}-${Date.now()}`)

  /* The same construction terminalInvocation makes, with '/c' for '/k' and a
     two-word harmless command standing in for a two-word sign-in. */
  const words = ['mkdir', proof]
  const args = ['/c', 'echo', ...words, '&&', ...words]

  const code = await new Promise((resolve, reject) => {
    const child = spawn(terminal, args, {
      env: process.env, stdio: 'ignore', shell: false, windowsHide: true,
    })
    child.on('error', reject)
    child.on('exit', resolve)
  })

  assert.equal(code, 0, 'cmd.exe refused the command line we build for the sign-in')
  assert.ok(fs.existsSync(proof),
    'the half after the && never ran -- on a real sign-in that is the sign-in itself, '
    + 'and the person would see the command echoed and then nothing happen')

  try { fs.rmdirSync(proof) } catch { /* the assertion above is the result; cleanup is courtesy */ }
})

/* THE ACCOUNT'S NAME REALLY REACHES THE SCREEN, MEASURED THROUGH A REAL cmd.exe.
 *
 * WHY THE ARGV ASSERTIONS ABOVE ARE NOT THIS. They check the array we BUILD.
 * This checks what cmd.exe PRINTS, and the two are different questions: node
 * and libuv assemble one command line out of the array and cmd re-parses it, so
 * a name that arrives quoted, split, or eaten by the `&&` would pass every
 * assertion above and still leave the person looking at a window that does not
 * say whose sign-in it is -- which is the entire defect.
 *
 * It signs nothing in and opens no window: '/k' becomes '/c' so the shell exits,
 * the sign-in words are replaced by a harmless echo, and nothing reaches the
 * desktop. The `start` half -- which is what puts the same words on the TITLE
 * BAR -- is deliberately not exercised here, because `start` puts a real window
 * on the owner's desktop and this machine is in use. */
test('the account name survives node and cmd.exe and is printed in the window', async () => {
  if (process.platform !== 'win32') return

  const { spawn } = await import('node:child_process')
  const nodePath = await import('node:path')

  const terminal = nodePath.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'cmd.exe')
  const title = 'ToolsEnabled sign-in: work laptop - codex'
  const invocation = terminalInvocation({ program: terminal, lead: [] }, ['echo', 'the-sign-in-would-run-here'], { title })
  const args = invocation.args.map(word => (word === '/k' ? '/c' : word))

  const printed = await new Promise((resolve, reject) => {
    let out = ''
    const child = spawn(terminal, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true })
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.on('error', reject)
    child.on('exit', code => resolve({ code, out }))
  })

  assert.equal(printed.code, 0, 'cmd.exe refused the command line the titled sign-in builds')
  /* TRIMMED, AND THE TRAILING SPACE IS MEASURED RATHER THAN ASSUMED AWAY. Run
     here 2026-09-03, cmd.exe printed "ToolsEnabled sign-in: work laptop -
     codex \r\n": `echo` takes the whole rest of its token, including the space
     libuv put before the `&&`, which is the same parser rule the home
     assignment above glues its separator to avoid. It is glued THERE because a
     trailing space makes a different directory and the account would sign in
     somewhere nobody chose; it is left alone HERE because a trailing space in a
     printed line has no such consequence, and one form of one rule is worth
     more than a second escape hatch beside it. */
  assert.ok(printed.out.split(/\r?\n/).map(line => line.trimEnd()).includes(title),
    `the window never printed the account it is for. It printed: ${JSON.stringify(printed.out)}`)
  /* And the sign-in command is still printed after it, unchanged: the name is
     an addition to what the person is told, never a replacement for it. */
  assert.ok(printed.out.includes('echo the-sign-in-would-run-here'),
    `the sign-in command is no longer echoed: ${JSON.stringify(printed.out)}`)
})

/* ------------------------------------------------------------------
   8. A SECOND ACCOUNT: the window that carries a home.

   THE DEFECT THESE PIN. These programs choose which sign-in they use from one
   environment variable and from nothing else, so a sign-in window that could
   not carry one could only ever sign in the same identity again -- and the
   product's own answer to "how do I add a second account" was a PowerShell line
   for a person to paste. The owner was handed that line, was in cmd.exe, and it
   failed four times in a row with "The filename, directory name, or volume
   label syntax is incorrect." A customer has nobody to correct them.
   ------------------------------------------------------------------ */

const HOME_A = 'C:/u/AppData/Roaming/ToolsEnabled/capability/codex-homes/cloud-a'

test('a sign-in for a named account carries that program\'s own home variable', () => {
  const { service, terminals } = harness({ files: withCmd([NPM_CODEX]) })
  const answer = service.start('codex', { home: HOME_A })
  assert.equal(answer.ok, true)
  const line = terminals[0].args.join(' ')
  /* The command line, because that is the half that survives a Windows
     Terminal configured to hand the tab to an already-running process. */
  assert.ok(line.includes('set CODEX_HOME='), `the window was told: ${line}`)
  assert.ok(line.includes(HOME_A), `the window was not given the account's home: ${line}`)
  /* And the child's environment, because that is the half that survives
     anything the shell does to the line. Same value in both. */
  assert.equal(terminals[0].options.env.CODEX_HOME, HOME_A)
  /* The person is shown which account this window is for and then the sign-in
     command, and never the variable: the account is theirs, the variable is
     ours. */
  assert.ok(line.includes('echo codex login &&'), `the echoed line named more than the command: ${line}`)
  assert.equal(line.indexOf('CODEX_HOME'), line.lastIndexOf('CODEX_HOME'),
    `the variable was echoed at the person as well as set: ${line}`)
})

test('a sign-in opened for a named account says whose it is, on the window and in the answer', () => {
  /* THE DEFECT. MEASURED 2026-09-03 by reading this module and shell/main.cjs:
     the account name reached neither the title (openTerminalWindow passed
     `start ""`, whose own note calls the empty title bar the cost of the form)
     nor the window (the only line echoed was the sign-in command, which is the
     same three words for every Codex account on the computer). Two accounts to
     sign in were therefore two identical, untitled windows. */
  const { service, terminals } = harness({ files: withCmd([NPM_CODEX]) })
  const answer = service.start('codex', { home: HOME_A, label: 'work laptop' })
  assert.equal(answer.ok, true)
  assert.equal(answer.title, 'ToolsEnabled sign-in: work laptop - codex',
    'the answer does not carry the words that are on the window, so the menu would have to invent them')
  /* The opener is told the title separately, because `start` takes its title as
     its own first quoted word, ahead of the program. */
  assert.equal(terminals[0].options.title, answer.title)
  /* And it is printed inside the window, which is the half a Windows Terminal
     tab shows and the half that survives a terminal that ignores the title. */
  assert.ok(terminals[0].args.join(' ').startsWith('/k echo ToolsEnabled sign-in: work laptop - codex && echo codex login &&'),
    `the window did not name the account first: ${terminals[0].args.join(' ')}`)
})

test('the program is in the title even when the account is, because two programs may hold the same name', () => {
  /* shell/account-registry.cjs: names are unique PER PROVIDER -- "school" may
     be both a Codex account and a Claude one -- so a title carrying only the
     name would still put two identical names on the taskbar, which is a
     smaller version of the defect rather than a fix for it. */
  const codex = harness({ files: withCmd([NPM_CODEX]) })
  const claude = harness({ files: withCmd([NPM_CLAUDE]) })
  assert.equal(codex.service.start('codex', { label: 'school' }).title, 'ToolsEnabled sign-in: school - codex')
  assert.equal(claude.service.start('claude', { label: 'school' }).title, 'ToolsEnabled sign-in: school - claude')
})

test('a name a person typed cannot become an operator in the command line the window is opened with', () => {
  /* THE ONE PERSON-TYPED STRING ON THIS PATH. The registry keeps a name exactly
     as typed, in any alphabet, and refuses only a name with no letter or digit
     in it at all -- so `work && del x` and `a"b` are names it will hold. They
     are written into a line cmd.exe parses twice (once for the outer
     `cmd /c start`, once inside the window), where `&` is an operator and `"`
     ends the quoted title. Letters and digits in any script survive; nothing
     that could be read as syntax does. */
  const { service, terminals } = harness({ files: withCmd([NPM_CODEX]) })
  const answer = service.start('codex', { label: 'work && del x | more > out ^ "q"' })
  assert.equal(answer.ok, true)
  assert.equal(answer.title, 'ToolsEnabled sign-in: work del x more out q - codex')
  for (const word of terminals[0].args) {
    assert.ok(!/[&|<>^"]/.test(word) || word === '&&',
      `a person's name put ${JSON.stringify(word)} into the window's command line`)
  }

  /* A NAME IN ANOTHER ALPHABET IS A NAME. The registry's own rule, held here so
     nobody narrows the title to ASCII and quietly retitles somebody's account
     "ToolsEnabled sign-in: codex". */
  const cyrillic = harness({ files: withCmd([NPM_CODEX]) })
  assert.equal(cyrillic.service.start('codex', { label: 'рабочий' }).title,
    'ToolsEnabled sign-in: рабочий - codex')

  /* AND A NAME THAT SURVIVES AS NOTHING IS NOT INVENTED INTO ONE: the window is
     titled for its program, which is what an unnamed sign-in already gets. */
  const punctuation = harness({ files: withCmd([NPM_CODEX]) })
  assert.equal(punctuation.service.start('codex', { label: '!!!' }).title, 'ToolsEnabled sign-in: codex')
})

test('each program is given its own home variable', () => {
  const claude = harness({ files: withCmd([NPM_CLAUDE]) })
  assert.equal(claude.service.start('claude', { home: HOME_A }).ok, true)
  assert.ok(claude.terminals[0].args.join(' ').includes('set CLAUDE_CONFIG_DIR='),
    'the Claude sign-in was given the Codex variable, or none')
  assert.equal(claude.terminals[0].options.env.CLAUDE_CONFIG_DIR, HOME_A)

  /* gemini has a home in the engine's account registry now (homeDir, selected
     with GEMINI_CLI_HOME), so a named home is CARRIED, the same way as the
     other two, and the window runs the program itself because that is
     gemini's sign-in. */
  const gemini = harness({ files: withCmd([NPM_GEMINI]) })
  const answer = gemini.service.start('gemini', { home: HOME_A })
  assert.equal(answer.ok, true)
  const line = gemini.terminals[0].args.join(' ')
  assert.ok(line.includes('set GEMINI_CLI_HOME='), `the gemini window was not given its home variable: ${line}`)
  assert.ok(line.includes(HOME_A), `the gemini window was not given the account's home: ${line}`)
  assert.equal(gemini.terminals[0].options.env.GEMINI_CLI_HOME, HOME_A)
  assert.ok(line.includes('echo gemini &&'), `the echoed line named more than the command: ${line}`)
})

test('a program with no home variable refuses a named home rather than ignoring it', () => {
  /* The branch is kept even though every program in the table has a variable
     now: a program added without one must fail closed, because ignoring the
     home opens a window that signs in the default account while the caller
     believes it signed in a named one. Held here by asking the module's own
     table to say what each program carries. */
  for (const id of LOGIN_PROVIDER_IDS) {
    assert.equal(typeof LOGIN_PROVIDERS[id].homeEnv, 'string', `${id} lost its home variable`)
    assert.ok(LOGIN_PROVIDERS[id].homeEnv.length > 0, `${id} has an empty home variable`)
  }
  assert.deepEqual(
    Object.fromEntries(LOGIN_PROVIDER_IDS.map(id => [id, LOGIN_PROVIDERS[id].homeEnv])),
    { codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR', gemini: 'GEMINI_CLI_HOME', grok: 'GROK_HOME' },
  )
  const source = readFileSync(MODULE_FILE, 'utf8')
  assert.match(source, /if \(accountHome && !provider\.homeEnv\)/,
    'the refusal for a program with no home variable is gone')
  assert.match(source, /PROVIDER_LOGIN_NO_ACCOUNT_HOME/, 'the no-home refusal code is gone')
})

test('with no account named, nothing at all is added -- the old rule, unchanged', () => {
  /* The Sign in button in Settings passes no home, and must keep landing where
     the program always keeps it. This is the same assertion as the test above
     in section 3, restated here because it is now a BRANCH rather than the
     whole behaviour. */
  for (const call of [() => {}, () => ({}), () => ({ home: null }), () => ({ home: '   ' })]) {
    const { service, terminals } = harness({ files: withCmd([NPM_CODEX]) })
    assert.equal(service.start('codex', call()).ok, true)
    const passed = terminals[0].options.env
    assert.ok(!('CODEX_HOME' in passed), 'the window was handed a redirected Codex home')
    assert.ok(!terminals[0].args.join(' ').includes('set '), 'the window was told to set something')
  }
})

/* THE ASSIGNMENT REALLY SETS THE DIRECTORY WE MEANT, MEASURED THROUGH cmd.exe.
 *
 * WHY THIS IS NOT COVERED BY THE ASSERTION ABOVE. That one checks the argv we
 * BUILD. This one checks what cmd.exe ends up with, and the two are not the
 * same question: cmd's `set` takes the whole rest of the token, so the space
 * libuv puts before the `&&` lands INSIDE the value -- a path with a trailing
 * space is a different directory, and the account would sign in somewhere
 * nobody chose. Both branches are exercised, because libuv quotes an argument
 * only when it contains a space and the quoting is what decides which form is
 * correct. A machine whose user folder has a space in it takes the other
 * branch, and that is most machines with two words in the owner's name.
 *
 * It signs nothing in: the sign-in words are replaced with a node one-liner
 * that writes the value it was actually given, and the directory is a temporary
 * one this test makes and removes. */
test('the home assignment survives node and cmd.exe with the exact directory', async () => {
  if (process.platform !== 'win32') return

  const { spawn } = await import('node:child_process')
  const os = await import('node:os')
  const fs = await import('node:fs')
  const nodePath = await import('node:path')

  const terminal = nodePath.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'cmd.exe')
  const readBack = 'require("fs").writeFileSync(process.argv[1], String(process.env.CODEX_HOME))'

  for (const leaf of ['plain-home', 'home with spaces']) {
    const home = nodePath.join(os.tmpdir(), `provider-login-home-${process.pid}`, leaf)
    const proof = `${home}.txt`
    fs.mkdirSync(nodePath.dirname(home), { recursive: true })

    /* THE MODULE'S OWN CONSTRUCTION, ASKED FOR RATHER THAN COPIED. This test
       first built the argv here by repeating the glue rule, and a mutation that
       broke the rule in the module left it GREEN: it was measuring its own copy
       agreeing with itself. terminalInvocation() is exported for exactly this,
       so what ships is what runs. '/k' becomes '/c' so the window closes
       itself, and a harmless read-back stands in for the sign-in. */
    const words = ['node', '-e', readBack, proof]
    const invocation = terminalInvocation({ program: terminal, lead: [] }, words,
      { assign: { name: 'CODEX_HOME', value: home } })
    const args = invocation.args.map(word => (word === '/k' ? '/c' : word))

    const code = await new Promise((resolve, reject) => {
      const child = spawn(terminal, args, { env: process.env, stdio: 'ignore', shell: false, windowsHide: true })
      child.on('error', reject)
      child.on('exit', resolve)
    })
    assert.equal(code, 0, `cmd.exe refused the command line we build for ${leaf}`)
    assert.ok(fs.existsSync(proof),
      `the half after the && never ran for "${leaf}" -- on a real sign-in that is the sign-in itself`)
    assert.equal(fs.readFileSync(proof, 'utf8'), home,
      `cmd.exe set a different directory than we meant for "${leaf}"`)
    try { fs.rmSync(proof, { force: true }) } catch { /* cleanup is courtesy */ }
  }
  try { fs.rmSync(nodePath.join(os.tmpdir(), `provider-login-home-${process.pid}`), { recursive: true, force: true }) } catch { /* courtesy */ }
})

test('snapshot reports a silent running install and bounded log', () => {
  const { service, child } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' } })
  service.installStart('codex', () => {})
  child.stdout.emit('data', Buffer.from('downloading official 0.154.0\n'))
  const snap = service.snapshot('codex')
  assert.equal(snap.ok, true)
  assert.equal(snap.known, true)
  assert.equal(snap.state, 'running')
  assert.deepEqual(snap.lines, ['downloading official 0.154.0'])
  assert.equal(service.snapshot('unknown-bot').known, false)
  assert.equal(service.snapshot('claude').state, 'idle')
})

test('Stop during a still-running installer is stopping, not complete, and blocks a second install', () => {
  const { service, child, spawns } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' } })
  service.installStart('codex', () => {})
  child.kill = () => { child.killed = true; return true }
  const stop = service.stop('codex')
  assert.equal(child.killed, true)
  assert.equal(stop.stopped, false)
  assert.equal(stop.stopping, true)
  assert.equal(stop.running, true)
  assert.equal(service.snapshot('codex').state, 'stopping')
  assert.equal(service.installStart('codex', () => {}).code, 'PROVIDER_LOGIN_RUNNING')
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].options.containProcessTree, true)
  child.emit('exit', null)
  assert.equal(service.running('codex'), false)
  assert.equal(service.snapshot('codex').state, 'failed')
  assert.equal(service.snapshot('codex').lastExit.code, null)
  assert.equal(service.installStart('codex', () => {}).ok, true)
})

test('completed and failed installs keep an honest last snapshot', () => {
  const { service, child } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' } })
  service.installStart('gemini', () => {})
  child.stdout.emit('data', Buffer.from('added 1 package\n'))
  child.emit('exit', 0)
  const done = service.snapshot('gemini')
  assert.equal(done.state, 'completed')
  assert.deepEqual(done.lines, ['added 1 package'])
  assert.equal(done.lastExit.code, 0)
  service.installStart('claude', () => {})
  child.emit('exit', 1)
  assert.equal(service.snapshot('claude').state, 'failed')
  assert.equal(service.snapshot('claude').lastExit.code, 1)
})

test('owned installer remains busy until both zero-process outcome and wrapper close arrive', async () => {
  const { service, child } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' } })
  let finishOutcome, finishClosed
  child.jobOutcome = new Promise(resolve => { finishOutcome = resolve })
  child.jobClosed = new Promise(resolve => { finishClosed = resolve })
  child.terminateJob = () => child.jobOutcome
  const events = []
  service.installStart('codex', event => events.push(event))
  child.emit('exit', 0)
  assert.equal(service.running('codex'), true, 'wrapper exit alone is not an empty process tree')
  finishOutcome({ type: 'exit', activeProcesses: 0, exitCode: 0 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.running('codex'), true, 'the retained wrapper must release its resources too')
  finishClosed({ failure: null })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.running('codex'), false)
  assert.equal(events.filter(event => event.kind === 'exit').length, 1)
  assert.equal(service.snapshot('codex').state, 'completed')
})

for (const first of ['timeout', 'user', 'error', 'shutdown']) {
  test(`installer preserves ${first} as the first termination cause through retained cleanup`, async () => {
    let watchdog, finishOutcome, finishClosed
    const { service, child } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' },
      timers: { setTimeout(fn) { watchdog = fn; return { unref() {} } }, clearTimeout() {} } })
    child.jobOutcome = new Promise(resolve => { finishOutcome = resolve })
    child.jobClosed = new Promise(resolve => { finishClosed = resolve })
    child.terminateJob = () => child.jobOutcome
    const events = []
    assert.equal(service.installStart('codex', event => events.push(event)).ok, true)
    if (first === 'timeout') watchdog()
    else if (first === 'user') service.stop('codex')
    else if (first === 'shutdown') service.stopAll()
    else child.emit('error', new Error('fixture containment error'))
    // A queued timer or later Stop must not claim somebody else caused this.
    watchdog(); service.stop('codex')
    assert.equal(service.snapshot('codex').stopReason, first)
    assert.equal(service.snapshot('codex').timedOut === true, first === 'timeout')
    assert.equal(service.installStart('claude', () => {}).code, 'PROVIDER_LOGIN_RUNNING')
    finishOutcome({ type: 'terminated', activeProcesses: 0, exitCode: null })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(service.running('codex'), true)
    assert.equal(events.some(event => event.kind === 'exit'), false)
    finishClosed({ failure: null })
    await new Promise(resolve => setImmediate(resolve))
    const snapshot = service.snapshot('codex'), exited = events.find(event => event.kind === 'exit')
    assert.equal(snapshot.stopReason, first)
    assert.equal(snapshot.stopped, ['user', 'shutdown'].includes(first))
    assert.equal(exited.timedOut === true, first === 'timeout')
    assert.equal(exited.stopReason, first)
    assert.equal(exited.stopped === true, ['user', 'shutdown'].includes(first))
    assert.equal(events.filter(event => event.kind === 'exit').length, 1)
    assert.equal(snapshot.lastExit.code, null)
  })
}

test('provider installs have one bounded thirty-minute default allowance', () => {
  let delay
  const { service, child } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' },
    timers: { setTimeout(_fn, ms) { delay = ms; return { unref() {} } }, clearTimeout() {} } })
  assert.equal(service.installStart('codex', () => {}).ok, true)
  assert.ok(delay > 29 * 60 * 1000 && delay <= 30 * 60 * 1000)
  child.emit('exit', 0)
  assert.equal(service.running('codex'), false)
})

test('unconfirmed installer cleanup retains custody and consumes termination rejection', async () => {
  const { service, child } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' } })
  child.jobOutcome = Promise.resolve({ type: 'unknown', activeProcesses: null, exitCode: null })
  child.jobClosed = Promise.resolve({ failure: 'fixture cleanup failure' })
  child.terminateJob = () => Promise.reject(new Error('fixture termination unavailable'))
  const events = []
  service.installStart('codex', event => events.push(event))
  child.emit('error', new Error('fixture containment failure'))
  child.emit('exit', 0)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.running('codex'), true)
  assert.equal(service.snapshot('codex').cleanupUnconfirmed, true)
  assert.equal(events.some(event => event.kind === 'exit'), false)
  assert.equal(service.installStart('codex', () => {}).code, 'PROVIDER_LOGIN_RUNNING')
  assert.equal(service.stop('codex').stopping, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.running('codex'), true)
})

test('an isolated session refuses a second provider install while one is in flight', () => {
  const isolation = {
    PROVIDER_SESSION_ISOLATION_VERSION: 1,
    providerSessionEnvironment: environment => ({ ...environment, USERPROFILE: 'C:/iso', npm_config_prefix: 'C:/iso/npm' }),
    resolvePrivateProviderExecutable: () => 'C:/iso/npm/codex.cmd',
    codexFileCredentialArgs: () => [],
  }
  const { service, spawns } = harness({
    files: withCmd(['C:/nodejs/npm.cmd']),
    env: { PATH: 'C:/nodejs', TOOLSENABLED_PROVIDER_ISOLATION_ROOT: 'C:/iso' },
    providerIsolation: isolation,
  })
  assert.equal(service.installStart('codex', () => {}).ok, true)
  const again = service.installStart('claude', () => {})
  assert.equal(again.ok, false)
  assert.equal(again.code, 'PROVIDER_LOGIN_RUNNING')
  assert.equal(spawns.length, 1)
})

test('retry recovers only the interrupted npm package after confirmed process cleanup', async t => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const { createHash } = await import('node:crypto')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-npm-retry-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'node_modules')
  const scope = path.join(root, '@xai-official')
  const installed = path.join(scope, 'grok')
  const hash = createHash('sha1').update(installed).digest('base64').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8)
  const retired = path.join(scope, `.grok-${hash}`)
  fs.mkdirSync(installed, { recursive: true })
  fs.mkdirSync(retired)
  fs.writeFileSync(path.join(installed, 'keep'), 'installed program')
  fs.writeFileSync(path.join(retired, 'stale'), 'interrupted npm staging')
  const unrelated = path.join(scope, '.grok-unrelated')
  fs.mkdirSync(unrelated)
  const children = []
  let outcome, closed
  const { service, spawns } = harness({ platform: 'linux', files: ['/node/npm'], env: { PATH: '/node' },
    spawnHiddenImpl: () => {
      const child = fakeChild()
      if (!children.length) {
        child.jobOutcome = new Promise(resolve => { outcome = resolve })
        child.jobClosed = new Promise(resolve => { closed = resolve })
      }
      children.push(child)
      return child
    },
  })
  const events = []
  service.installStart('grok', event => events.push(event))
  children[0].stderr.emit('data', Buffer.from('npm error code ENOTEMPTY\nnpm error dest /untrusted/output/path\n'))
  children[0].emit('exit', 217)
  outcome({ type: 'exit', activeProcesses: 0, exitCode: 217 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(children.length, 1, 'recovery must wait for the owned wrapper to close')
  closed({ failure: null })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(children.length, 2, 'npm must be asked for its configured global root')
  assert.deepEqual(spawns[1].args, ['root', '-g'])
  assert.equal(service.running('grok'), true)
  assert.equal(events.some(event => event.kind === 'exit'), false)
  children[1].stdout.emit('data', Buffer.from(`${root}\n`))
  children[1].emit('exit', 0)
  assert.equal(children.length, 3, 'the requested official install must retry once')
  assert.deepEqual(spawns[2].args, ['install', '-g', '@xai-official/grok'])
  assert.equal(fs.existsSync(retired), false, 'only the exact npm retirement collision is moved aside')
  assert.equal(fs.readFileSync(path.join(installed, 'keep'), 'utf8'), 'installed program')
  assert.equal(fs.existsSync(unrelated), true)
  assert.equal(events.some(event => event.text === root), false, 'the private root query is not a display log')
  children[2].stdout.emit('data', Buffer.from('changed 1 package\n'))
  children[2].emit('exit', 0)
  assert.equal(service.snapshot('grok').state, 'completed')
  assert.equal(fs.readdirSync(scope).some(name => name.startsWith('.toolsenabled-npm-recovery-')), false)
  assert.deepEqual(events.filter(event => event.kind === 'exit'), [{ kind: 'exit', op: 'install', code: 0 }])
})

test('Stop during npm recovery cancels the whole install and never starts its retry', () => {
  const children = []
  const { service } = harness({ platform: 'linux', files: ['/node/npm'], env: { PATH: '/node' },
    spawnHiddenImpl: () => { const child = fakeChild(); children.push(child); return child },
  })
  service.installStart('grok', () => {})
  children[0].stderr.emit('data', Buffer.from('npm error code ENOTEMPTY\n'))
  children[0].emit('exit', 217)
  assert.equal(children.length, 2)
  assert.equal(service.stop('grok').stopped, true)
  children[1].emit('exit', 0)
  assert.equal(children.length, 2)
  assert.equal(service.snapshot('grok').stopped, true)
})

test('npm recovery refuses malformed roots, linked packages and another package’s residue', async t => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const { createHash } = await import('node:crypto')
  const { quarantineNpmRetirement } = require_('../../shell/provider-npm-recovery.cjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-npm-boundary-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'node_modules'), scope = path.join(root, '@xai-official')
  fs.mkdirSync(scope, { recursive: true })
  const other = path.join(scope, '.other-12345678')
  fs.mkdirSync(other)
  assert.equal(quarantineNpmRetirement(`${root}\n`, '@xai-official/grok'), null)
  assert.equal(fs.existsSync(other), true)
  for (const output of ['relative/node_modules\n', `${root}\n${dir}\n`, `${root}/..\n`, `${dir}\n`]) {
    assert.throws(() => quarantineNpmRetirement(output, '@xai-official/grok'), /ROOT_INVALID/)
  }
  assert.throws(() => quarantineNpmRetirement(`${root}\n`, '@xai-official/../../elsewhere'), /PACKAGE_INVALID/)
  const installed = path.join(scope, 'grok')
  const hash = createHash('sha1').update(installed).digest('base64').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8)
  const retired = path.join(scope, `.grok-${hash}`)
  const outside = path.join(dir, 'unrelated-data')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep'), 'untouched')
  fs.symlinkSync(outside, retired, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => quarantineNpmRetirement(`${root}\n`, '@xai-official/grok'), /PATH_UNSAFE/)
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'untouched')
  assert.equal(fs.lstatSync(retired).isSymbolicLink(), true)
})

test('npm recovery never reports a failed root query as a successful install', () => {
  for (const output of ['', '/missing/node_modules\n', 'x'.repeat(9000)]) {
    const children = []
    const { service } = harness({ platform: 'linux', files: ['/node/npm'], env: { PATH: '/node' },
      spawnHiddenImpl: () => { const child = fakeChild(); children.push(child); return child },
    })
    service.installStart('grok', () => {})
    children[0].stderr.emit('data', Buffer.from('npm error code ENOTEMPTY\n'))
    children[0].emit('exit', 217)
    children[1].stdout.emit('data', Buffer.from(output))
    children[1].emit('exit', 0)
    assert.equal(children.length, 2)
    assert.equal(service.snapshot('grok').state, 'failed')
  }
})

test('different providers cannot race npm over the shared global prefix', () => {
  const { service, spawns } = harness({ platform: 'linux', files: ['/node/npm'], env: { PATH: '/node' } })
  service.installStart('grok', () => {})
  assert.equal(service.installStart('claude', () => {}).code, 'PROVIDER_LOGIN_RUNNING')
  assert.equal(spawns.length, 1)
})

test('provider install Stop owns a real private fixture process tree through confirmed cleanup', { timeout: 15000 }, async (t) => {
  if (process.platform !== 'linux') {
    t.skip('fixture tree uses Linux process containment')
    return
  }
  let spawnHidden
  try {
    ({ spawnHidden } = require_(path.join(REPO_ROOT, '..', 'engine', 'src', 'lib', 'proc', 'hidden-spawn.js')))
  } catch {
    t.skip('hidden-spawn seam is not beside this app tree')
    return
  }
  const fs = await import('node:fs')
  const os = await import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-install-tree-'))
  const marker = path.join(dir, 'grandchild.pid')
  const script = path.join(dir, 'fixture-install.mjs')
  fs.writeFileSync(script, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(process.argv[2], String(child.pid))
setInterval(() => {}, 1000)
`)
  let child
  const { service } = harness({ files: withCmd(['C:/nodejs/npm.cmd']), env: { PATH: 'C:/nodejs' },
    spawnHiddenImpl: (_command, _args, options) => {
      assert.equal(options.containProcessTree, true)
      child = spawnHidden(process.execPath, [script, marker], { ...options, cwd: dir, env: { PATH: process.env.PATH, HOME: dir } })
      return child
    },
  })
  t.after(async () => {
    service.stopAll()
    if (child) {
      assert.equal((await child.jobOutcome).activeProcesses, 0)
      assert.equal((await child.jobClosed).failure, null)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const events = []
  assert.equal(service.installStart('codex', event => events.push(event)).ok, true)
  const started = Date.now()
  while (!fs.existsSync(marker) && Date.now() - started < 3000) await new Promise(r => setTimeout(r, 50))
  const grandchild = Number(fs.readFileSync(marker, 'utf8'))
  assert.ok(grandchild > 1)
  try { process.kill(grandchild, 0) } catch { assert.fail('grandchild was not running') }
  assert.equal(service.stop('codex').stopping, true)
  const receipt = await child.jobOutcome
  assert.equal(receipt.activeProcesses, 0)
  assert.ok(receipt.observedChildren >= 2)
  assert.equal(receipt.observedChildren, receipt.reapedChildren)
  assert.equal((await child.jobClosed).failure, null)
  await new Promise(resolve => setImmediate(resolve))
  assert.throws(() => process.kill(grandchild, 0), { code: 'ESRCH' })
  assert.equal(service.running('codex'), false)
  assert.equal(service.snapshot('codex').stopped, true)
  assert.equal(events.filter(event => event.kind === 'exit').length, 1)
})

/* ------------------------------------------------------------------
   NO SECOND COPY, AND INSTALLS INTO TOOLSENABLED'S OWN FOLDER (rc-0922).

   The owner: "right now do we aggressively try to write over a users paths or
   such? Can we do a better job at install time?" The Install button ran
   `npm install -g` in the person's own npm folder even when the program was
   already on the computer -- by its maker's own installer, say -- which left a
   second copy and let PATH order decide which one ran. Now a copy that is
   found is used; an install goes into ToolsEnabled's own folder with
   `npm install --prefix`, is asked what it supports, and only then becomes the
   copy in use. The engine's provider-toolchain.js (the paired engine,
   MC_CANONICAL_ROOT) is the one table both sides read.
   ------------------------------------------------------------------ */

function pairedToolchain() {
  const root = process.env.MC_CANONICAL_ROOT
  assert.ok(root && path.isAbsolute(root), 'MC_CANONICAL_ROOT must name the paired engine')
  return require_(path.join(root, 'src', 'lib', 'providers', 'provider-toolchain.js'))
}

/* Every option claude-cli-adapter.js passes, the way `claude --help` lists them. */
const CLAUDE_HELP = [
  '  -p, --print', '  --input-format <format>', '  --output-format <format>', '  --verbose', '  --include-partial-messages',
  '  --permission-mode <mode>', '  --model <model>', '  --mcp-config <configs...>', '  --strict-mcp-config', '  --settings <file>',
  '  --tools <tools...>', '  --setting-sources <sources>', '  --disable-slash-commands', '  --session-id <uuid>', '  -r, --resume [value]',
  '  --fork-session', '  --effort <level>',
].join('\n') + '\n'

function ownedMachine(t) {
  const fsReal = require_('node:fs')
  const osReal = require_('node:os')
  const root = fsReal.realpathSync(fsReal.mkdtempSync(path.join(osReal.tmpdir(), 'owned-install-')))
  t.after(() => fsReal.rmSync(root, { recursive: true, force: true }))
  const owned = path.join(root, 'providers')
  const children = []
  const npmCalls = []
  /* What `npm install --prefix <staging> <package>` leaves behind, written when
     npm is "run", so the rest of the flow meets real files. */
  const spawnHiddenImpl = (command, args, options) => {
    if (norm(command).endsWith('/npm')) {
      npmCalls.push({ args: [...args], env: options.env })
      const staging = args[args.indexOf('--prefix') + 1]
      const version = options.npmFixtureVersion || ownedMachine.version
      const pkg = path.join(staging, 'node_modules', '@anthropic-ai', 'claude-code')
      fsReal.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
      fsReal.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version, bin: { claude: 'bin/claude.exe' } }))
      fsReal.writeFileSync(path.join(pkg, 'bin', 'claude.exe'), 'fixture', { mode: 0o755 })
    }
    const child = fakeChild()
    children.push({ command, args: [...args], env: options.env, child })
    return child
  }
  return { root, owned, children, npmCalls, spawnHiddenImpl, fsReal }
}
ownedMachine.version = '2.1.281'

test('a program already on this computer is used, never installed a second time', () => {
  for (const [id, present] of [['codex', NPM_CODEX], ['claude', NPM_CLAUDE], ['gemini', NPM_GEMINI]]) {
    const { service, spawns } = harness({ files: withCmd(['C:/nodejs/npm.cmd', present]), env: { PATH: 'C:/nodejs' } })
    const answer = service.installStart(id, () => {})
    assert.equal(answer.ok, false, `${id} was installed a second time`)
    assert.equal(answer.code, 'PROVIDER_LOGIN_ALREADY_INSTALLED')
    assert.match(answer.reason, /already on this computer, and ToolsEnabled uses that copy\. Nothing was installed\./)
    assert.equal(spawns.length, 0, `${id} started an installer for a program that is already here`)
  }
  const { service } = harness({ files: withCmd(['C:/nodejs/npm.cmd', NPM_CLAUDE]), env: { PATH: 'C:/nodejs' } })
  assert.equal(service.installStart('claude', () => {}, { privateCopy: true }).code, 'PROVIDER_LOGIN_PRIVATE_COPY_UNAVAILABLE',
    'a private copy is refused, not turned into a global install, when this copy has no folder of its own to put it in')
})

test('an install goes into ToolsEnabled\'s own folder, is checked, then used, and nothing else is written', { skip: process.platform !== 'linux' && 'needs a POSIX filesystem' }, t => {
  const toolchain = pairedToolchain()
  const machine = ownedMachine(t)
  const { service } = harness({ platform: 'linux', files: ['/node/npm'], env: { PATH: '/node', TOOLSENABLED_PROVIDERS_ROOT: machine.owned },
    providerToolchain: toolchain, spawnHiddenImpl: machine.spawnHiddenImpl })
  const events = []
  assert.equal(service.installStart('claude', event => events.push(event)).ok, true)
  const npm = machine.npmCalls[0]
  const staging = npm.args[2]
  assert.deepEqual(npm.args, ['install', '--prefix', staging, '--no-audit', '--no-fund', '--no-update-notifier', '@anthropic-ai/claude-code@latest'])
  assert.ok(!npm.args.includes('-g') && !npm.args.includes('--global'), 'the install still writes the person\'s global npm folder')
  assert.ok(staging.startsWith(path.join(machine.owned, 'claude') + path.sep), 'the install went outside ToolsEnabled\'s own folder')
  assert.equal(npm.env.npm_config_prefix, undefined, 'the install redirected npm\'s own global prefix')

  machine.children[0].child.emit('exit', 0)
  const probe = machine.children[1]
  assert.equal(probe.command, path.join(machine.owned, 'claude', '2.1.281', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))
  assert.deepEqual(probe.args, ['--help'])
  assert.equal(probe.env.DISABLE_AUTOUPDATER, '1', 'the new owned copy updated itself while it was being checked')
  assert.equal(toolchain.ownedCopy('claude', { env: { TOOLSENABLED_PROVIDERS_ROOT: machine.owned }, platform: 'linux' }), null,
    'a copy became the one in use before it was checked')
  probe.child.stdout.emit('data', Buffer.from(CLAUDE_HELP))
  probe.child.emit('exit', 0)

  assert.deepEqual(events.at(-1), { kind: 'exit', op: 'install', code: 0 })
  assert.ok(events.some(event => event.kind === 'line' && event.text === 'ToolsEnabled now uses Claude Code 2.1.281 from its own folder. Nothing outside that folder was changed.'))
  const inUse = toolchain.ownedCopy('claude', { env: { TOOLSENABLED_PROVIDERS_ROOT: machine.owned }, platform: 'linux' })
  assert.equal(inUse.version, '2.1.281')
  assert.equal(inUse.owner, 'toolsenabled')
  assert.equal(toolchain.recallProbe(inUse).state, 'ready')
  assert.deepEqual(machine.fsReal.readdirSync(machine.root), ['providers'], 'something was written outside ToolsEnabled\'s own folder')
  assert.deepEqual(machine.fsReal.readdirSync(path.join(machine.owned, 'claude')).sort(), ['2.1.281', 'current.json'])
})

test('a new copy that lacks an option ToolsEnabled needs is kept aside and never used', { skip: process.platform !== 'linux' && 'needs a POSIX filesystem' }, t => {
  const toolchain = pairedToolchain()
  const machine = ownedMachine(t)
  const { service } = harness({ platform: 'linux', files: ['/node/npm'], env: { PATH: '/node', TOOLSENABLED_PROVIDERS_ROOT: machine.owned },
    providerToolchain: toolchain, spawnHiddenImpl: machine.spawnHiddenImpl })
  const events = []
  assert.equal(service.installStart('claude', event => events.push(event)).ok, true)
  machine.children[0].child.emit('exit', 0)
  const probe = machine.children[1]
  probe.child.stdout.emit('data', Buffer.from(CLAUDE_HELP.replace('  --tools <tools...>\n', '')))
  probe.child.emit('exit', 0)
  assert.deepEqual(events.at(-1), { kind: 'exit', op: 'install', code: 1 })
  assert.ok(events.some(event => event.kind === 'line' && /lacks --tools, which ToolsEnabled needs\. ToolsEnabled keeps using the copy it used before\./.test(event.text)))
  assert.equal(toolchain.ownedCopy('claude', { env: { TOOLSENABLED_PROVIDERS_ROOT: machine.owned }, platform: 'linux' }), null)
})

test('a private copy of a program that is already here is the person\'s explicit choice, in ToolsEnabled\'s own folder', () => {
  const { service, spawns } = harness({ files: withCmd(['C:/nodejs/npm.cmd', NPM_CLAUDE]), env: { PATH: 'C:/nodejs' },
    providerToolchain: pairedToolchain() })
  assert.equal(service.installStart('claude', () => {}).code, 'PROVIDER_LOGIN_ALREADY_INSTALLED')
  assert.equal(service.installStart('claude', () => {}, { privateCopy: true }).ok, true)
  assert.equal(spawns.length, 1)
  assert.equal(norm(spawns[0].command), NPM_CMD)
  const staging = spawns[0].args[2]
  assert.deepEqual(spawns[0].args, ['install', '--prefix', staging, '--no-audit', '--no-fund', '--no-update-notifier', '@anthropic-ai/claude-code@latest'])
  assert.ok(norm(staging).startsWith(norm(`${LOCALAPPDATA}/ToolsEnabled/providers/claude/.install-`)), 'a Windows private copy left %LOCALAPPDATA%\\ToolsEnabled\\providers')
  /* A program whose owned copy would be a node script on Windows keeps its
     existing install path there until its launch carries node. */
  const codex = harness({ files: withCmd(['C:/nodejs/npm.cmd', NPM_CODEX]), env: { PATH: 'C:/nodejs' }, providerToolchain: pairedToolchain() })
  assert.equal(codex.service.installStart('codex', () => {}, { privateCopy: true }).code, 'PROVIDER_LOGIN_PRIVATE_COPY_UNAVAILABLE')
})
