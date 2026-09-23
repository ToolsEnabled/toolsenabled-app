/* The sign-in probe, and the three ways it could quietly become a liar.
 *
 * WHAT IS BEING GUARDED. shell/provider-cli-presence.cjs is the only thing in
 * this product that answers "is the program that runs an agent on this computer,
 * and is it signed in". Three properties make it safe to put in front of a
 * person, and all three are invisible in ordinary use:
 *
 *   1. IT NEVER READS A CREDENTIAL. The fence is that the module contains no
 *      call that returns file contents. A comment claiming that is worth
 *      nothing, so this suite reads the source and fails on any such call. This
 *      is the one assertion here that is about text, and it is about text
 *      because the property is the ABSENCE of code, which no behavioural test
 *      can observe.
 *   2. ITS RENDERER ANSWER NEVER RETURNS A PATH. An answer crossing into the
 *      renderer that carries a filesystem path is how a private checkout name
 *      reached the DOM once already. So providerCliPresence() is asserted
 *      exhaustively rather than sampled. The main-only executable resolver is
 *      tested separately because launch needs the exact file this probe found.
 *   3. IT NEVER TURNS "I COULD NOT TELL" INTO "YOU HAVE NOT DONE IT". Reporting
 *      a signed-in person as signed out sends them to run a command they have
 *      already run, and they conclude the product is broken. Every uncertain
 *      branch must answer 'unknown'.
 *
 * THE POSITIVE CONTROL IS THE FIRST TEST AND IT IS NOT OPTIONAL. A suite made
 * only of injected fakes passes just as well against a function that returns a
 * hardcoded object. The machine this runs on has all three programs installed
 * and signed in, measured directly before this file was written:
 *
 *   claude 2.1.186   %APPDATA%\npm\claude.cmd    claude auth status -> loggedIn true
 *   codex            %APPDATA%\npm\codex.cmd     codex login status -> Logged in
 *   gemini 0.53.0    %APPDATA%\npm\gemini.cmd    ~/.gemini/oauth_creds.json present
 *
 * So a real run must report all three installed. It is written to SKIP rather
 * than fail where that is not true, because a build machine with no CLI on it is
 * not a defect in this module -- but the skip says so out loud, so a green run
 * on a bare machine cannot be mistaken for the control having passed.
 *
 * Run: node --test tools/test/provider-cli-presence.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MODULE_FILE = path.join(REPO_ROOT, 'shell', 'provider-cli-presence.cjs')

const { PROVIDER_IDS, PRESENCE_STATES, providerCliExecutable, providerCliPresence } = require_(MODULE_FILE)

test('Gemini resolves its own .gemini directory beneath GEMINI_CLI_HOME', () => {
  const asked = []
  const answer = providerCliPresence({
    platform: 'win32',
    env: { PATH: '/programs', GEMINI_CLI_HOME: '/profiles/selected', GEMINI_DIR: '/profiles/obsolete' },
    homedir: () => '/profiles/default',
    statSync: () => ({ isFile: () => true }),
    existsSync: file => { asked.push(file); return file === path.join('/profiles/selected', '.gemini', 'oauth_creds.json') },
  })
  assert.equal(answer.providers.find(provider => provider.id === 'gemini').signedIn, 'yes')
  assert.ok(asked.includes(path.join('/profiles/selected', '.gemini', 'oauth_creds.json')))
  assert.equal(asked.some(file => file.includes('/profiles/obsolete')), false)
})

/* ------------------------------------------------------------------
   1. The positive control: this machine, with nothing injected.
   ------------------------------------------------------------------ */

test('on a real machine it reports the programs that are really there', (t) => {
  const answer = providerCliPresence()
  assert.equal(answer.ok, true)
  assert.equal(answer.providers.length, 4)

  const installed = answer.providers.filter(provider => provider.installed === 'yes')
  if (installed.length === 0) {
    t.skip('no agent CLI is installed on this machine, so the control cannot run here')
    return
  }
  /* Whatever it found, it must have found it by the same rule a command line
     uses. A provider reported installed with no sign-in answer at all would mean
     the two halves disagree about which machine they are on. */
  for (const provider of installed) {
    assert.ok(
      PRESENCE_STATES.includes(provider.signedIn),
      `${provider.id} is installed but its sign-in answer is not one of the three states`,
    )
  }
})

/* ------------------------------------------------------------------
   2. The shape. No paths, no extra fields, no open vocabulary.
   ------------------------------------------------------------------ */

test('every answer is a word from a closed set and never a path', () => {
  /* Driven against a fabricated machine so the assertion does not depend on
     what happens to be installed where this runs. */
  const answer = providerCliPresence({
    platform: 'win32',
    env: { PATH: 'C:\\tools;C:\\Users\\somebody\\AppData\\Roaming\\npm', PATHEXT: '.CMD;.EXE' },
    homedir: () => 'C:\\Users\\somebody',
    statSync: () => ({ isFile: () => true }),
    existsSync: () => true,
  })

  assert.deepEqual(answer.providers.map(provider => provider.id), [...PROVIDER_IDS])

  for (const provider of answer.providers) {
    assert.deepEqual(
      Object.keys(provider).sort(),
      ['id', 'installed', 'signedIn'],
      `${provider.id} carries a field beyond the three this may report`,
    )
    assert.ok(PRESENCE_STATES.includes(provider.installed))
    assert.ok(PRESENCE_STATES.includes(provider.signedIn))
  }

  /* The blunt version of the same rule: no VALUE in the answer may look like a
     directory, a drive letter or a home.

     It walks the values rather than JSON.stringify(answer), and the first
     version of this test got that wrong: a serialised object contains ':' as
     its own syntax, so scanning the envelope reported a path in an answer that
     had none. That was the harness being wrong about the product, which is the
     one failure mode a fence test must not have. */
  const values = answer.providers.flatMap(provider => Object.values(provider))
  for (const value of values) {
    for (const fragment of ['\\', '/', ':', 'Users', 'AppData', 'npm', 'somebody']) {
      assert.ok(
        !String(value).includes(fragment),
        `the answer carries "${fragment}" in a value, which means a path can reach the renderer`,
      )
    }
  }
})

/* ------------------------------------------------------------------
   3. Uncertainty is never reported as absence.
   ------------------------------------------------------------------ */

test('a machine with no readable PATH is unknown, never not-installed', () => {
  const answer = providerCliPresence({
    platform: 'win32',
    env: {},
    homedir: () => 'C:\\Users\\somebody',
    existsSync: () => false,
  })
  for (const provider of answer.providers) {
    assert.equal(provider.installed, 'unknown', `${provider.id} claimed an answer it could not have`)
  }
})

test('a machine with no home directory is unknown, never signed out', () => {
  const answer = providerCliPresence({
    platform: 'win32',
    env: { PATH: 'C:\\tools', PATHEXT: '.CMD' },
    homedir: () => { throw new Error('no home on this account') },
    statSync: () => { throw new Error('nothing here') },
  })
  for (const provider of answer.providers) {
    assert.equal(provider.signedIn, 'unknown', `${provider.id} claimed a sign-in answer it could not have`)
  }
})

test('a missing Claude or Gemini sign-in file is unknown, because both have other ways in', () => {
  const answer = providerCliPresence({
    platform: 'win32',
    env: { PATH: 'C:\\tools', PATHEXT: '.CMD' },
    homedir: () => 'C:\\Users\\somebody',
    statSync: () => ({ isFile: () => true }),
    existsSync: () => false,
  })
  const state = id => answer.providers.find(provider => provider.id === id).signedIn

  /* Claude Code authenticates from the operating system keychain or from a key
     in the environment as well as from its own file, so an absent file proves
     nothing. Telling that person to sign in again would be the product being
     confidently wrong about their own machine. */
  assert.equal(state('claude'), 'unknown')
  assert.equal(state('gemini'), 'unknown')

  /* Codex is the exception and it is not an inconsistency: this shell already
     REFUSES to start a confined session on exactly this missing file
     (confinedSessionIsSignedOut in shell/agent-host.cjs). Answering 'unknown'
     here would have the setup screen disagree with the refusal a person is
     about to hit. */
  assert.equal(state('codex'), 'no')
})

test('a sign-in file that is present is reported for every provider', () => {
  const answer = providerCliPresence({
    platform: 'win32',
    env: { PATH: 'C:\\tools', PATHEXT: '.CMD' },
    homedir: () => 'C:\\Users\\somebody',
    statSync: () => ({ isFile: () => true }),
    existsSync: () => true,
  })
  for (const provider of answer.providers) {
    assert.equal(provider.signedIn, 'yes', `${provider.id} did not report a sign-in that is there`)
  }
})

test('the variable that relocates a configuration directory is honoured', () => {
  const looked = []
  const answer = providerCliPresence({
    platform: 'win32',
    env: { PATH: 'C:\\tools', PATHEXT: '.CMD', CODEX_HOME: 'D:\\elsewhere\\codex' },
    homedir: () => 'C:\\Users\\somebody',
    statSync: () => { throw new Error('nothing here') },
    existsSync: (candidate) => { looked.push(candidate); return false },
  })
  assert.ok(
    looked.some(candidate => candidate.startsWith('D:\\elsewhere\\codex')),
    'a person who moved their Codex home was still reported against the default one',
  )
  assert.equal(answer.providers.find(provider => provider.id === 'codex').signedIn, 'no')
})

/* ------------------------------------------------------------------
   4. The credential fence, asserted against the source.
   ------------------------------------------------------------------ */

test('the module contains no call that could return the contents of a file', () => {
  const source = readFileSync(MODULE_FILE, 'utf8')
  /* Strip comments first. This file's own prose explains WHY it does not read
     credentials, and a raw scan would read that explanation as the violation. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

  const READERS = [
    'readFile', 'readFileSync', 'createReadStream', 'openSync', 'readSync',
    'readdir', 'readdirSync', 'realpathSync', 'readlinkSync',
  ]
  for (const reader of READERS) {
    assert.ok(
      !code.includes(reader),
      `${reader} appears in the probe: a screen that reports a sign-in must never read one`,
    )
  }

  /* And it must not start anything. `claude auth status` is the right answer to
     give a PERSON and the wrong thing for a screen to run on mount. */
  for (const spawner of ['child_process', 'spawn', 'execFile', 'execSync']) {
    assert.ok(
      !code.includes(spawner),
      `${spawner} appears in the probe: a mount-time read must not start a child process`,
    )
  }
})

/* ------------------------------------------------------------------
   5. HIS SECOND MACHINE. The regression this file was reopened for.

   REPORTED, verbatim: "on my other computer - i have claude and codex
   downloaded and installed and signed it but when i try to launch agents it
   says nothing was started and to run winget install openAI".

   MEASURED 2026-08-23, comparing the Windows PATH the REGISTRY holds against
   the one this process inherited: 37 entries live, 36 inherited, and the
   single entry missing from the process is a winget package directory. A
   program installed by winget writes its directory into the registry PATH; a
   process started before that write -- which on Windows is every process
   launched from Explorer since login -- never sees it. So this probe walked a
   PATH that predated the install and reported a program the person had just
   installed as absent. The product's own guide tells people to install Codex
   with winget, which is what closes the loop: install exactly as instructed,
   then be told to install.

   THE RESOLVED PATH ARRIVES AS AN INJECTED VALUE, deliberately. Reading the
   registry is a machine act with a child process and a timeout in it; deciding
   what is installed is a pure function over a list of directories. They are
   separate so this suite can drive the second one with no machine behind it at
   all -- the same reason `env`, `platform` and `statSync` are already injected
   here. shell/machine-search-path.cjs owns the first half and is tested alone
   in tools/test/machine-search-path.test.mjs.

   `complete` IS THE HALF THAT STOPS THE ACCUSATION. It says whether every
   layer of the resolution actually ran. A search that did not finish may report
   'unknown' and may never report 'no', because 'no' is what puts an install
   command in front of somebody who has already installed the thing.
   ------------------------------------------------------------------ */

/* A winget package directory, shaped like a real one from the machine that
   measured the defect rather than invented. */
const WINGET_CODEX = 'C:\\Users\\him\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe'
/* What the app process inherited at login: Windows, and nothing installed
   since. Note what is NOT here -- %APPDATA%\npm. This person did not install
   with npm, so the one location the old probe hardcoded is empty on their
   computer and the hardcode bought them nothing. */
const INHERITED = 'C:\\Windows\\system32;C:\\Windows'

/* A machine where exactly two files exist, both in the winget directory.
   Every other stat throws, including every path under %APPDATA%\npm. */
function hisMachine(searchPath) {
  const present = new Set([
    path.join(WINGET_CODEX, 'codex.EXE'),
    path.join(WINGET_CODEX, 'claude.EXE'),
  ])
  return {
    platform: 'win32',
    env: {
      PATH: INHERITED,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      APPDATA: 'C:\\Users\\him\\AppData\\Roaming',
    },
    homedir: () => 'C:\\Users\\him',
    statSync: (candidate) => {
      if (present.has(candidate)) return { isFile: () => true }
      throw new Error('ENOENT')
    },
    existsSync: () => true,
    searchPath,
  }
}

test('a program only in the live PATH, not in the inherited one, is reported installed', () => {
  const livePath = {
    /* What a newly started process would see: the machine and user PATH as the
       registry holds them right now, with the winget directory in it. */
    directories: Object.freeze([...INHERITED.split(';'), WINGET_CODEX]),
    complete: true,
  }
  const machine = hisMachine(livePath)
  const answer = providerCliPresence(machine)
  const state = id => answer.providers.find(provider => provider.id === id).installed

  assert.equal(state('codex'), 'yes', 'his installed Codex was reported absent, which is the defect')
  assert.equal(state('claude'), 'yes', 'his installed Claude was reported absent, which is the defect')
  assert.equal(
    providerCliExecutable('claude', machine),
    path.join(WINGET_CODEX, 'claude.EXE'),
    'launch did not receive the native executable that made presence answer yes',
  )
})

test('a resolution that did not finish is unknown, never not-installed', () => {
  /* The same machine with the live read UNAVAILABLE -- reg.exe missing, blocked
     by policy, timed out. We are then looking at a PATH we know may be stale,
     so the honest answer is that we could not tell. */
  const answer = providerCliPresence(hisMachine({
    directories: Object.freeze(INHERITED.split(';')),
    complete: false,
  }))
  for (const provider of answer.providers) {
    assert.equal(provider.installed, 'unknown', `${provider.id} claimed an answer a stale PATH cannot support`)
  }
})

test('a program installed where nothing on any path can see it is never reported not-installed', () => {
  /* Installed under Program Files by an installer that puts nothing on PATH,
     on a machine that could not be asked where its package manager keeps
     things. One layer could not run, so the search did not finish -- and an
     unfinished search may not accuse anybody of not having installed
     something. */
  const answer = providerCliPresence(hisMachine({
    directories: Object.freeze(INHERITED.split(';')),
    complete: false,
  }))
  for (const provider of answer.providers) {
    assert.notEqual(provider.installed, 'no', `${provider.id} was called absent on a search that never finished`)
  }
})

test('a search that genuinely finished and found nothing is still no', () => {
  /* The stranger with a bare computer. Every layer ran, nothing is there, and
     this person DOES need the install command -- so 'no' has to stay reachable
     or the product stops helping the people it was written for. */
  const answer = providerCliPresence(hisMachine({
    directories: Object.freeze(INHERITED.split(';')),
    complete: true,
  }))
  assert.equal(answer.providers.find(provider => provider.id === 'gemini').installed, 'no')
})

test('neither PATH available is unknown, never no', () => {
  const answer = providerCliPresence(hisMachine({ directories: Object.freeze([]), complete: false }))
  for (const provider of answer.providers) {
    assert.equal(provider.installed, 'unknown', `${provider.id} answered from a machine that told it nothing`)
  }
})

test('no vendor directory is read behind the resolution back', () => {
  /* %APPDATA%\npm was hardcoded in this probe, and this is the assertion that
     the literal is gone. The machine below has a real npm global directory
     holding a real codex.CMD, and that directory is NOT in the resolved path.
     If the probe still reaches into that one vendor location behind the
     resolution's back, this answers 'yes' and fails.

     Nothing is lost by removing it: npm's own installer puts that directory on
     the PATH, so the live read finds it, and shell/machine-search-path.cjs asks
     npm itself where it puts things for the person who moved it. */
  const npmGlobal = 'C:\\Users\\him\\AppData\\Roaming\\npm'
  const answer = providerCliPresence({
    platform: 'win32',
    env: { PATH: INHERITED, PATHEXT: '.CMD', APPDATA: 'C:\\Users\\him\\AppData\\Roaming' },
    homedir: () => 'C:\\Users\\him',
    statSync: (candidate) => {
      if (candidate === path.join(npmGlobal, 'codex.CMD')) return { isFile: () => true }
      throw new Error('ENOENT')
    },
    existsSync: () => false,
    searchPath: { directories: Object.freeze(INHERITED.split(';')), complete: true },
  })
  assert.equal(
    answer.providers.find(provider => provider.id === 'codex').installed,
    'no',
    'the probe still reads a hardcoded vendor directory the resolved path never named',
  )
})

test('non-Windows is answered from the inherited PATH exactly as it always was', () => {
  /* The platform branch is not touched by any of this. A resolved path is a
     Windows repair for a Windows defect: every other platform's processes see
     PATH changes the ordinary way, and inventing a second source there would be
     a change with no defect behind it. */
  const answer = providerCliPresence({
    platform: 'linux',
    /* This is a Linux machine even when the test runner is Windows. */
    env: { PATH: '/usr/local/bin:/usr/bin' },
    homedir: () => '/home/him',
    /* The supplied machine is Linux, so its fixture uses POSIX paths even
       when the test host is Windows. Host path.join would model another OS. */
    statSync: (candidate) => {
      if (candidate === '/usr/local/bin/claude') return { isFile: () => true }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    accessSync: () => {},
    existsSync: () => false,
  })
  const state = id => answer.providers.find(provider => provider.id === id).installed
  assert.equal(state('claude'), 'yes')
  assert.equal(state('codex'), 'no')

  const blind = providerCliPresence({
    platform: 'linux',
    env: {},
    homedir: () => '/home/him',
    statSync: () => { throw new Error('ENOENT') },
    existsSync: () => false,
  })
  for (const provider of blind.providers) assert.equal(provider.installed, 'unknown')
})

test('a non-executable file on a POSIX PATH is not reported as an installed command', () => {
  const blocked = '/usr/local/bin/codex'
  const executableChecks = []
  const answer = providerCliPresence({
    platform: 'linux',
    env: { PATH: '/usr/local/bin' },
    homedir: () => '/home/him',
    statSync: candidate => {
      if (candidate === blocked) return { isFile: () => true }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    accessSync: candidate => {
      executableChecks.push(candidate)
      if (candidate === blocked) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    },
    existsSync: () => false,
    searchPath: { directories: ['/usr/local/bin'], complete: true },
  })

  /* EACCES is a real file we cannot execute, not proof that reinstalling is
     appropriate. It must remain unavailable without claiming absence. */
  assert.equal(answer.providers.find(provider => provider.id === 'codex').installed, 'unknown')
  assert.deepEqual(executableChecks, [blocked], 'the unavailable answer must follow a real execute-permission check')
})

/* ------------------------------------------------------------------
   6. The memo on the installed half, and the two things it may not touch.
   ------------------------------------------------------------------ */

/* WHY THERE IS A MEMO AT ALL. Caching the search PATH removed the two child
   processes and left the expensive half untouched: commandPresence() walks
   every directory on that path and, on Windows, every PATHEXT extension inside
   each one -- about 1,600 stat calls, measured 2026-09-02 at 78-97 ms on the
   Electron main thread, paid on every compose-panel open, every board mount,
   every home mount, every setup mount, and twice inside one agent:availability.

   THE TWO THINGS IT MAY NOT TOUCH are what these tests are. A memo that served
   an injected reader would let one test's machine answer another's, and a memo
   that swallowed the sign-in half would report a person who has just signed in
   as signed out -- the exact failure mode this whole file exists to prevent.
   Neither is visible in ordinary use, so neither may be left to inspection. */

test('an injected reader is never served a remembered answer, and never leaves one', () => {
  let walks = 0
  const counting = () => {
    walks += 1
    throw new Error('ENOENT')
  }
  /* THE SEARCH PATH OBJECT IS HOISTED, and that is the point of this test
     rather than an incidental tidy. The memo's key is that object's identity,
     so handing a FRESH one to each call would make the memo miss on identity
     alone and the ambient guard would never be exercised. The first draft did
     exactly that, and a mutation that memoised injected calls too passed it.
     Sharing one object means only the guard can produce the doubling below. */
  const searchPath = { directories: ['C:\\one', 'C:\\two'], complete: true }
  const machine = () => ({
    platform: 'win32',
    env: { PATH: 'C:\\one;C:\\two', PATHEXT: '.EXE;.CMD', APPDATA: 'C:\\Users\\him\\AppData\\Roaming' },
    homedir: () => 'C:\\Users\\him',
    statSync: counting,
    accessSync: () => {},
    existsSync: () => false,
    searchPath,
  })

  providerCliPresence(machine())
  const afterFirst = walks
  assert.ok(afterFirst > 0, 'the first injected call did not walk the path at all')

  providerCliPresence(machine())
  assert.equal(walks, afterFirst * 2,
    'the second injected call was served a remembered answer -- an injected reader must '
    + 'always be asked, or one test\'s machine can answer another\'s')
})

/* THE CASE THE GUARD ACTUALLY EXISTS FOR, and it is not the obvious one.
 *
 * An injected `searchPath` can never be served from the memo whatever the guard
 * does, because usableSearchPath() rebuilds a fresh frozen object on every call
 * (shell/provider-cli-presence.cjs:225-234) and the memo key is object
 * identity. So a test that injects a searchPath proves nothing about the guard
 * -- the first draft of this file did that, and a mutation removing the guard
 * passed it.
 *
 * The real hazard is an injected READER over the AMBIENT path: inject statSync
 * but not env, platform or searchPath, and machineSearchPath() returns its
 * long-lived cached object. Now the key MATCHES, and without the guard the fake
 * reader's answer is both served from and stored into the ambient memo -- one
 * test's machine answering another's, and the owner's real answer replaced by a
 * fixture's for the rest of the process. */
test('an injected reader sharing the ambient path is still asked, and cannot poison it', () => {
  const before = providerCliPresence()

  let walks = 0
  const nothingAnywhere = () => {
    walks += 1
    throw new Error('ENOENT')
  }
  const injected = providerCliPresence({
    statSync: nothingAnywhere,
    accessSync: () => {},
    existsSync: () => false,
    homedir: () => 'C:\\Users\\him',
  })

  assert.ok(walks > 0,
    'the injected reader was never called -- it was served the ambient memo, so a fixture '
    + 'would be answered with the real machine')
  for (const provider of injected.providers) {
    assert.notEqual(provider.installed, 'yes',
      `${provider.id} was reported installed by a reader that found nothing -- the ambient `
      + 'answer was served to an injected call')
  }

  const after = providerCliPresence()
  for (const id of PROVIDER_IDS) {
    const one = before.providers.find(provider => provider.id === id).installed
    const two = after.providers.find(provider => provider.id === id).installed
    assert.equal(two, one,
      `${id} changed across an injected call -- the fixture's answer was stored under the `
      + 'ambient key and now replaces the real machine for the rest of the process')
    assert.ok(PRESENCE_STATES.includes(two), `${id} left the closed set`)
  }
})

test('the sign-in half is read again on every call, memo or not', () => {
  /* existsSync and homedir are deliberately NOT part of the ambient test in the
     module: they decide only the sign-in half, which is never remembered. So
     these two calls share the memoised installed half AND must still both go to
     the filesystem for sign-in. Counting is the assertion rather than the
     verdict, because the verdict depends on which providers have other ways in
     -- see "a missing Claude or Gemini sign-in file is unknown" above. */
  let looks = 0
  const watching = () => {
    looks += 1
    return false
  }

  providerCliPresence({ homedir: () => 'C:\\Users\\him', existsSync: watching })
  const afterFirst = looks
  assert.ok(afterFirst > 0, 'the sign-in half did not read anything on the first call')

  providerCliPresence({ homedir: () => 'C:\\Users\\him', existsSync: watching })
  assert.ok(looks > afterFirst,
    'the second call read no sign-in file -- somebody who signed in between the two '
    + 'would still be told they had not')
})

/* AND THE MEMO MUST ACTUALLY MEMOISE, which the three tests above cannot see:
   a memo that never stored anything would pass every one of them. This is the
   positive half, and it also proves the invalidation seam, because the two are
   the same mechanism -- the memo key IS the search-path object, and
   invalidateMachineSearchPath() is what replaces it.

   It counts REAL stat calls by patching fs.statSync, which the module reads at
   call time. That keeps `options.statSync` unset, so the call stays ambient and
   the memo is in play -- an injected statSync would take the bypass tested
   above and prove nothing about this. */
test('the ambient walk happens once per search path, and again after an install', (t) => {
  if (process.platform !== 'win32') {
    t.skip('the cached search path, and so the memo key, is a Windows branch')
    return
  }
  const { invalidateMachineSearchPath } = require_(path.join(REPO_ROOT, 'shell', 'machine-search-path.cjs'))
  const fs = require_('node:fs')
  const real = fs.statSync
  let stats = 0
  fs.statSync = (...args) => {
    stats += 1
    return real(...args)
  }
  try {
    /* Start from a known miss rather than from whatever earlier tests left. */
    invalidateMachineSearchPath()
    providerCliPresence()
    const cold = stats
    assert.ok(cold > 0, 'the first call after an invalidation did not walk the path')

    stats = 0
    providerCliPresence()
    assert.equal(stats, 0,
      `the second call walked the path again (${stats} stat calls) -- the memo is not holding, `
      + 'and every panel open still costs the full sweep')

    /* An install finishing is the one event that can change the answer, and
       shell/main.cjs calls exactly this. The next call must pay again. */
    invalidateMachineSearchPath()
    stats = 0
    providerCliPresence()
    assert.ok(stats > 0,
      'the walk did NOT run after invalidateMachineSearchPath() -- a program installed while '
      + 'the app was open would go on being reported absent')
  } finally {
    fs.statSync = real
  }
})

/* ------------------------------------------------------------------
   7. The launch half reads the SAME memo, instead of walking again.
   ------------------------------------------------------------------ */

/* WHAT THIS GUARDS, AND WHAT IT COST. commandResolution() is one walk that
   produces both halves of the answer -- the word providerCliPresence() reports
   and the file path providerCliExecutable() hands the engine. The memo held
   only the word, so the launch path re-walked the whole search path for a
   resolution already sitting in the cache. MEASURED 2026-09-03 on this machine,
   40 ambient calls each: providerCliPresence() 0.36 ms median from the memo,
   providerCliExecutable('claude') 24.85 ms median (p90 30.11) -- paid on the
   Electron MAIN thread once per Claude session start, in front of every press
   of Start.

   IT COUNTS REAL stat CALLS for the same reason the test above does: an
   injected statSync takes the ambient bypass and would prove nothing.

   MUTATION AUDIT 2026-09-03: restoring the private walk in
   providerCliExecutable() (`return commandResolution(provider.command, {...})
   .executable`, as it stood at d1da28e) makes this fail with "the launch path
   walked the search path again (N stat calls)" (20 pass, 1 fail); it passes
   again once the shared memo is restored. */
test('the launch path is served the resolution the presence probe already walked', (t) => {
  if (process.platform !== 'win32') {
    t.skip('the cached search path, and so the memo key, is a Windows branch')
    return
  }
  const { invalidateMachineSearchPath } = require_(path.join(REPO_ROOT, 'shell', 'machine-search-path.cjs'))
  const fs = require_('node:fs')
  const real = fs.statSync
  let stats = 0
  fs.statSync = (...args) => {
    stats += 1
    return real(...args)
  }
  try {
    invalidateMachineSearchPath()
    /* The presence probe runs first, exactly as it does in the product: every
       screen mount calls it, and shell/agent-host.cjs's no-tier start resolves
       the provider through it before it ever asks for a path. */
    const before = providerCliPresence()
    assert.ok(stats > 0, 'the first call after an invalidation did not walk the path')

    stats = 0
    const executable = providerCliExecutable('claude')
    assert.equal(stats, 0,
      `the launch path walked the search path again (${stats} stat calls) for a resolution the `
      + 'presence probe had already produced -- every Claude session start pays it')

    /* The answer must still be the same answer, not merely a cheap one. */
    const installed = before.providers.find(provider => provider.id === 'claude').installed
    if (installed === 'yes') {
      assert.equal(typeof executable, 'string',
        'presence said the program is there and the launch path could not name the file')
      assert.equal(path.basename(executable).toLowerCase().startsWith('claude'), true,
        `the memo answered with a file that is not the claude program: ${executable}`)
    } else {
      assert.equal(executable, null,
        'the launch path named a file for a program presence could not prove is there')
    }

    /* An install finishing replaces the search-path object, and both halves
       must pay again -- there is still exactly one invalidation seam. */
    invalidateMachineSearchPath()
    stats = 0
    providerCliExecutable('claude')
    assert.ok(stats > 0,
      'the launch path did NOT re-resolve after invalidateMachineSearchPath() -- a program '
      + 'installed while the app was open would go on being launched from the old path')
  } finally {
    fs.statSync = real
  }
})

/* AND THE LAUNCH HALF OBEYS THE SAME INJECTED-READER RULE AS THE PRESENCE HALF.
   A memo that served, or stored, an injected reader's answer would let one
   test's machine answer another's -- and here it would additionally hand the
   ENGINE a path a fixture invented. */
test('an injected reader asking for the executable is still asked, and cannot poison the memo', () => {
  const before = providerCliExecutable('claude')

  let walks = 0
  const nothingAnywhere = () => {
    walks += 1
    throw new Error('ENOENT')
  }
  const injected = providerCliExecutable('claude', {
    statSync: nothingAnywhere,
    accessSync: () => {},
  })

  assert.ok(walks > 0,
    'the injected reader was never called -- it was served the ambient memo, so a fixture '
    + 'would be answered with the real machine')
  assert.equal(injected, null,
    'a reader that found nothing anywhere still produced an executable -- the ambient answer '
    + 'was served to an injected call')

  assert.equal(providerCliExecutable('claude'), before,
    'the ambient answer changed across an injected call -- the fixture result was stored '
    + 'under the ambient key and now decides what the engine is launched from')
})

/* ------------------------------------------------------------------
   ONE CHOICE WITH THE ENGINE (rc-0922, providers lane).

   The owner: "we should really be able to handle these automatically so we
   dont need to try to parent the codex version all the time". Before this,
   the app walked the search path here and the engine walked its own in
   cli-provider-gateway.js executableFor(), so the two could start different
   copies, and nothing could name a copy ToolsEnabled installed itself. The
   engine's provider-toolchain.js is now the one table: a copy in the
   ToolsEnabled-owned folder is chosen first by BOTH, and the Settings answer
   says which copy, whose and which version, with no path.

   These run against the paired engine (MC_CANONICAL_ROOT), the same module
   the packed app loads as a host module.
   ------------------------------------------------------------------ */

const fsReal = require_('node:fs')
const osReal = require_('node:os')
const { providerToolchainStatus } = require_(MODULE_FILE)

function pairedEngine() {
  const root = process.env.MC_CANONICAL_ROOT
  assert.ok(root && path.isAbsolute(root), 'MC_CANONICAL_ROOT must name the paired engine for the toolchain checks')
  return {
    toolchain: require_(path.join(root, 'src', 'lib', 'providers', 'provider-toolchain.js')),
    gateway: require_(path.join(root, 'src', 'lib', 'providers', 'cli-provider-gateway.js')),
  }
}

function toolchainMachine(t) {
  const root = fsReal.realpathSync(fsReal.mkdtempSync(path.join(osReal.tmpdir(), 'presence-toolchain-')))
  t.after(() => fsReal.rmSync(root, { recursive: true, force: true }))
  const write = (file, text, mode = 0o755) => {
    fsReal.mkdirSync(path.dirname(file), { recursive: true })
    fsReal.writeFileSync(file, text, { mode })
    fsReal.chmodSync(file, mode)
    return file
  }
  const home = path.join(root, 'home')
  // The person's own native install, as Claude's installer lays it out.
  const version = write(path.join(home, '.local', 'share', 'claude', 'versions', '2.1.280'), 'native')
  fsReal.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true })
  fsReal.symlinkSync(version, path.join(home, '.local', 'bin', 'claude'))
  // A second, older npm copy earlier on the search path.
  const usrLocalBin = path.join(root, 'usr-local', 'bin')
  const npmPackage = path.join(root, 'usr-local', 'lib', 'node_modules', '@anthropic-ai', 'claude-code')
  write(path.join(npmPackage, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.270', bin: { claude: 'bin/claude.exe' } }), 0o644)
  const npmExe = write(path.join(npmPackage, 'bin', 'claude.exe'), 'npm')
  fsReal.mkdirSync(usrLocalBin, { recursive: true })
  fsReal.symlinkSync(npmExe, path.join(usrLocalBin, 'claude'))
  const owned = path.join(root, 'owned')
  const ownClaude = versionName => {
    const pkg = path.join(owned, 'claude', versionName, 'node_modules', '@anthropic-ai', 'claude-code')
    write(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: versionName, bin: { claude: 'bin/claude.exe' } }), 0o644)
    return write(path.join(pkg, 'bin', 'claude.exe'), 'owned')
  }
  const env = { PATH: usrLocalBin, TOOLSENABLED_PROVIDERS_ROOT: owned }
  const searchPath = { directories: [usrLocalBin, path.join(home, '.local', 'bin'), path.join(home, 'bin')], complete: true }
  return { root, home, env, owned, ownClaude, searchPath, npmClaude: path.join(usrLocalBin, 'claude') }
}

test('an owned copy is chosen first, and the app and the engine start the same copy', { skip: process.platform !== 'linux' && 'needs POSIX links and execute bits' }, t => {
  const { toolchain, gateway } = pairedEngine()
  const machine = toolchainMachine(t)
  const options = { platform: 'linux', env: machine.env, searchPath: machine.searchPath, homedir: () => machine.home, toolchain }
  const engineChoice = () => gateway.executableFor('claude', { platform: 'linux', environment: machine.env, loginHome: machine.home }).command

  assert.equal(providerCliExecutable('claude', options), machine.npmClaude, 'with no owned copy the first copy on the search path is used, as before')
  assert.equal(engineChoice(), machine.npmClaude, 'the engine chose a different copy than the app')

  const ownedFile = machine.ownClaude('2.1.281')
  assert.equal(toolchain.activateOwnedCopy('claude', '2.1.281', { root: machine.owned, platform: 'linux' }).ok, true)
  assert.equal(providerCliExecutable('claude', options), ownedFile, 'the app did not choose the copy ToolsEnabled installed')
  assert.equal(engineChoice(), ownedFile, 'the engine did not choose the copy the app chose')
  assert.equal(providerCliExecutable('claude', { ...options, toolchain: null }), machine.npmClaude,
    'a payload without the toolchain answers exactly as before')

  const empty = { ...options, searchPath: { directories: [], complete: true }, homedir: () => path.join(machine.root, 'nobody') }
  const presence = providerCliPresence(empty)
  assert.equal(presence.providers.find(row => row.id === 'claude').installed, 'yes', 'an owned copy alone is installed')
  assert.equal(presence.providers.find(row => row.id === 'codex').installed, 'no')
})

test('Settings learns which copy is used, whose it is, its version and how many there are, and never a path', { skip: process.platform !== 'linux' && 'needs POSIX links and execute bits' }, t => {
  const { toolchain } = pairedEngine()
  const machine = toolchainMachine(t)
  const status = providerToolchainStatus({ platform: 'linux', env: machine.env, searchPath: machine.searchPath, homedir: () => machine.home, toolchain })
  assert.equal(status.available, true)
  const claude = status.providers.find(row => row.id === 'claude' && row.client === null)
  assert.deepEqual({ ...claude, others: [...claude.others] }, {
    id: 'claude', client: null, installed: 'yes', channel: 'npm-global', owner: 'person', version: '2.1.270',
    copies: 2, others: [{ channel: 'native', owner: 'person', version: '2.1.280' }], features: 'unknown',
    updateCommand: 'npm install -g @anthropic-ai/claude-code@latest',
  })
  const text = JSON.stringify(status)
  assert.ok(!text.includes(machine.root) && !/[\\/](?:home|usr|tmp)[\\/]/.test(text), 'a path reached the Settings answer')
  assert.deepEqual(new Set(status.providers.map(row => row.installed)), new Set(['yes', 'no']))
  assert.deepEqual(providerToolchainStatus({ toolchain: null }), { ok: true, available: false, providers: [] })
})
