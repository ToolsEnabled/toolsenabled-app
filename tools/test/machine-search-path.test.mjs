/* THE HALF THAT TOUCHES A MACHINE, DRIVEN WITHOUT ONE.
 *
 * WHAT IS BEING GUARDED. shell/machine-search-path.cjs answers "which
 * directories would a newly started process on this computer search". It exists
 * because the answer this product used -- `process.env.PATH` -- is on Windows
 * the copy the process was born holding, and every install performed after that
 * moment is invisible in it. The owner hit exactly that: Claude and Codex
 * installed and signed in, and the product told him to install Codex.
 *
 * THE READING AND THE PARSING ARE SEPARATE FROM THE SPAWNING, on purpose, and
 * that separation is what this suite exercises. `reg query` is a child process
 * with a timeout; turning its output into a list of directories is arithmetic.
 * So every case below hands in fake registry output and asserts the arithmetic:
 * a malformed value, an empty one, a value full of %references%, a key that
 * would not answer at all.
 *
 * THE THREE FAILURES WORTH NAMING, because each one has a plausible wrong
 * implementation that passes a happy-path test:
 *
 *   1. AN UNREADABLE KEY AND AN ABSENT VALUE ARE DIFFERENT FACTS. A profile
 *      with no user PATH of its own is ordinary; a key this account may not read
 *      is a hole in the answer. Collapsing them means either accusing a normal
 *      machine of being unreadable, or claiming a complete search on a machine
 *      that refused to answer -- and the second is what puts an install command
 *      in front of somebody who already installed the thing.
 *
 *   2. THE COMPOSED LIST MUST BE A SUPERSET OF WHAT THE PROCESS ALREADY HAD.
 *      A launcher script, a `conda activate` and a corporate wrapper all put
 *      directories on a process's PATH that are in no registry. Replacing rather
 *      than merging would make an answer that is right today wrong tomorrow.
 *
 *   3. AN UNKNOWN %REFERENCE% IS LEFT ALONE, not dropped. Dropping rewrites
 *      `%CUSTOM%\bin` into `\bin`, which is a real directory at the root of the
 *      current drive, and a stat against it is a WRONG answer rather than a
 *      missing one.
 *
 * Run: node --test tools/test/machine-search-path.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const childProcess = require_('node:child_process')
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MODULE_FILE = path.join(REPO_ROOT, 'shell', 'machine-search-path.cjs')

const {
  MACHINE_ENVIRONMENT_KEY,
  USER_ENVIRONMENT_KEY,
  composeSearchDirectories,
  expandEnvironmentReferences,
  machineSearchPath,
  registryValueFromQuery,
  resolveSearchPath,
} = require_(MODULE_FILE)

/* Real `reg query` output, copied from a run on the machine that measured the
   defect rather than invented. Note the two things a hand-written fixture gets
   wrong: the value runs to the end of the line and contains single spaces
   (`Program Files`), and it is separated from its type by whitespace that is
   not a single space. */
const MACHINE_QUERY = [
  '',
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  '    ComSpec    REG_EXPAND_SZ    %SystemRoot%\\system32\\cmd.exe',
  '    Path    REG_EXPAND_SZ    C:\\Program Files (x86)\\Common Files\\Oracle\\Java\\javapath;%SystemRoot%\\system32;%SystemRoot%',
  '    PATHEXT    REG_SZ    .COM;.EXE;.BAT;.CMD',
  '',
].join('\r\n')

const USER_QUERY = [
  '',
  'HKEY_CURRENT_USER\\Environment',
  '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming\\npm;C:\\Users\\him\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenAI.Codex_x\\bin',
  '    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp',
  '',
].join('\r\n')

const ENV = Object.freeze({
  SystemRoot: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\him',
  PATH: 'C:\\Windows\\system32;C:\\Windows',
})

function reader(answers) {
  return key => (key in answers ? answers[key] : null)
}

/* ------------------------------------------------------------------
   1. Pulling one value out of what reg.exe printed.
   ------------------------------------------------------------------ */

test('the Path row is read whole, spaces and all', () => {
  assert.equal(
    registryValueFromQuery(MACHINE_QUERY, 'Path'),
    'C:\\Program Files (x86)\\Common Files\\Oracle\\Java\\javapath;%SystemRoot%\\system32;%SystemRoot%',
  )
})

test('the value name is matched without regard to case, because Windows does not care', () => {
  assert.equal(registryValueFromQuery(USER_QUERY, 'PATH'), registryValueFromQuery(USER_QUERY, 'Path'))
})

test('a readable key with no Path row answers null, which is not the same as unreadable', () => {
  const noPath = ['', 'HKEY_CURRENT_USER\\Environment', '    TEMP    REG_EXPAND_SZ    C:\\Temp', ''].join('\r\n')
  assert.equal(registryValueFromQuery(noPath, 'Path'), null)
})

test('malformed output yields null rather than a guess', () => {
  for (const rubbish of ['', 'ERROR: The system was unable to find the specified registry key or value.', 'Path', '   Path REG_SZ', null, undefined, 42]) {
    assert.equal(registryValueFromQuery(rubbish, 'Path'), null, `parsed something out of ${JSON.stringify(rubbish)}`)
  }
})

test('a value that is present and empty is distinguishable from one that is absent', () => {
  /* reg.exe prints the row with nothing after the separator. That is a real
     answer -- this machine has a Path and it is empty -- and it must not read as
     a parse failure, because the two lead to different verdicts. */
  const empty = ['', 'HKEY_CURRENT_USER\\Environment', '    Path    REG_EXPAND_SZ    ', ''].join('\r\n')
  assert.equal(registryValueFromQuery(empty, 'Path'), '')
})

/* ------------------------------------------------------------------
   2. Expansion.
   ------------------------------------------------------------------ */

test('environment references are expanded, case-insensitively', () => {
  assert.equal(
    expandEnvironmentReferences('%SystemRoot%\\system32;%USERPROFILE%\\bin', ENV),
    'C:\\Windows\\system32;C:\\Users\\him\\bin',
  )
  assert.equal(expandEnvironmentReferences('%systemroot%\\x', ENV), 'C:\\Windows\\x')
})

test('an unknown reference is left exactly as it is, never dropped', () => {
  /* Dropping it produces `\bin`, a real directory at the root of the current
     drive. A wrong answer is worse than a missing one. */
  assert.equal(expandEnvironmentReferences('%NOT_SET_ANYWHERE%\\bin', ENV), '%NOT_SET_ANYWHERE%\\bin')
})

test('expansion happens once, the way Windows does it, so nothing can spin', () => {
  const env = { A: '%B%', B: 'done' }
  assert.equal(expandEnvironmentReferences('%A%', env), '%B%')
  assert.equal(expandEnvironmentReferences('%LOOP%', { LOOP: '%LOOP%' }), '%LOOP%')
})

/* ------------------------------------------------------------------
   3. Composition: the order, the union, the de-duplication.
   ------------------------------------------------------------------ */

test('machine first, then user, then anything only this process had', () => {
  const directories = composeSearchDirectories({
    machineValue: 'C:\\Windows\\system32',
    userValue: 'C:\\Users\\him\\bin',
    inheritedPath: 'C:\\Windows\\system32;D:\\set-by-a-launcher',
    env: ENV,
  })
  assert.deepEqual([...directories], ['C:\\Windows\\system32', 'C:\\Users\\him\\bin', 'D:\\set-by-a-launcher'])
})

test('every directory this process already had survives, because losing one is a new bug', () => {
  /* The live values are the fresher authority, not the only one. A toolchain a
     launcher put on this process's PATH is in no registry and is still real. */
  const inherited = 'C:\\conda\\envs\\work;C:\\Windows'
  const directories = composeSearchDirectories({
    machineValue: 'C:\\Windows',
    userValue: '',
    inheritedPath: inherited,
    env: ENV,
  })
  for (const entry of inherited.split(';')) assert.ok(directories.includes(entry), `${entry} was dropped`)
})

test('the same directory written two ways is listed once', () => {
  const directories = composeSearchDirectories({
    machineValue: 'C:\\Windows\\System32\\',
    userValue: '"c:\\windows\\system32"',
    inheritedPath: 'C:\\WINDOWS\\system32',
    env: ENV,
  })
  assert.equal(directories.length, 1)
})

test('and the one that survives is the USABLE spelling, not the quoted one', () => {
  /* THE TEST ABOVE COUNTED, AND COUNTING WAS NOT ENOUGH. It fed this function a
     quoted spelling and an unquoted one and asserted the result had length 1 --
     which it did, and which it also did while the surviving entry was
     `"c:\windows\system32"` WITH ITS QUOTE MARKS, because the dedup key was
     computed from the unquoted form and the raw string was what got stored.
     The quoted one arrived first, so the usable duplicate was dropped as
     already seen: the list kept the one spelling that cannot be stat'd.

     Every consumer joins these strings to a filename and stats the result, and
     path.join does not treat a quoted absolute path as absolute -- so the target
     became a RELATIVE path beginning with a quote mark, no stat ever hit, and a
     person with a space in their Windows user name was told the engine was not
     installed while it sat there installed.

     So this asserts the CONTENT, and deliberately puts the quoted spelling
     first, which is the order that produced the defect. */
  const directories = composeSearchDirectories({
    machineValue: '"C:\\Users\\Jo Smith\\bin"',
    userValue: null,
    inheritedPath: 'C:\\Users\\Jo Smith\\bin',
    env: ENV,
  })
  assert.equal(directories.length, 1, 'the two spellings are still one directory')
  assert.equal(directories[0], 'C:\\Users\\Jo Smith\\bin',
    'the stored directory still carries quote marks, so nothing under it can be found')
  for (const entry of directories) {
    assert.ok(!entry.includes('"'),
      `a quote mark survived into a directory that will be used as a stat target: ${entry}`)
  }
})

test('empty segments from a trailing or doubled separator are dropped', () => {
  const directories = composeSearchDirectories({
    machineValue: 'C:\\a;;C:\\b;',
    userValue: null,
    inheritedPath: '',
    env: ENV,
  })
  assert.deepEqual([...directories], ['C:\\a', 'C:\\b'])
})

/* ------------------------------------------------------------------
   4. The verdict: directories, and whether the search finished.
   ------------------------------------------------------------------ */

test('a Windows machine that answers both keys resolves the live PATH and is complete', () => {
  const resolved = resolveSearchPath({
    platform: 'win32',
    env: ENV,
    readRegistryKey: reader({ [MACHINE_ENVIRONMENT_KEY]: MACHINE_QUERY, [USER_ENVIRONMENT_KEY]: USER_QUERY }),
    packageManager: { settled: true, directories: [] },
  })
  assert.equal(resolved.complete, true)
  assert.ok(
    resolved.directories.includes('C:\\Users\\him\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenAI.Codex_x\\bin'),
    'the winget directory that is in the live PATH and not in the inherited one was not resolved',
  )
  assert.ok(
    resolved.directories.includes('C:\\Users\\him\\AppData\\Roaming\\npm'),
    'the npm directory was not resolved from the live PATH, which is what replaced the hardcoded one',
  )
})

test('a key that would not answer leaves the search incomplete', () => {
  for (const answers of [
    { [MACHINE_ENVIRONMENT_KEY]: null, [USER_ENVIRONMENT_KEY]: USER_QUERY },
    { [MACHINE_ENVIRONMENT_KEY]: MACHINE_QUERY, [USER_ENVIRONMENT_KEY]: null },
    {},
  ]) {
    const resolved = resolveSearchPath({
      platform: 'win32',
      env: ENV,
      readRegistryKey: reader(answers),
      packageManager: { settled: true, directories: [] },
    })
    assert.equal(resolved.complete, false, 'a hole in the reading was reported as a finished search')
    /* And it still falls back to what this process holds, which is today's
       behaviour. A machine that will not answer must land on the old answer,
       never on a worse one. */
    assert.ok(resolved.directories.includes('C:\\Windows\\system32'))
  }
})

test('an account with no user PATH of its own is a complete search, not a hole', () => {
  const noPath = ['', 'HKEY_CURRENT_USER\\Environment', '    TEMP    REG_EXPAND_SZ    C:\\Temp', ''].join('\r\n')
  const resolved = resolveSearchPath({
    platform: 'win32',
    env: ENV,
    readRegistryKey: reader({ [MACHINE_ENVIRONMENT_KEY]: MACHINE_QUERY, [USER_ENVIRONMENT_KEY]: noPath }),
    packageManager: { settled: true, directories: [] },
  })
  assert.equal(resolved.complete, true)
})

test('a package-manager question still open leaves the search incomplete', () => {
  /* Until that layer settles we have not looked everywhere, and a search that
     has not looked everywhere may not say "you have not installed it". */
  const resolved = resolveSearchPath({
    platform: 'win32',
    env: ENV,
    readRegistryKey: reader({ [MACHINE_ENVIRONMENT_KEY]: MACHINE_QUERY, [USER_ENVIRONMENT_KEY]: USER_QUERY }),
    packageManager: { settled: false, directories: [] },
  })
  assert.equal(resolved.complete, false)
})

test('what a package manager said about its own directory is searched', () => {
  const resolved = resolveSearchPath({
    platform: 'win32',
    env: ENV,
    readRegistryKey: reader({ [MACHINE_ENVIRONMENT_KEY]: MACHINE_QUERY, [USER_ENVIRONMENT_KEY]: USER_QUERY }),
    packageManager: { settled: true, directories: ['D:\\somewhere\\the\\person\\moved\\it'] },
  })
  assert.ok(resolved.directories.includes('D:\\somewhere\\the\\person\\moved\\it'))
})

test('nothing to search is never a finished search', () => {
  const resolved = resolveSearchPath({
    platform: 'win32',
    env: {},
    readRegistryKey: reader({ [MACHINE_ENVIRONMENT_KEY]: 'HKEY_LOCAL_MACHINE\\x\r\n', [USER_ENVIRONMENT_KEY]: 'HKEY_CURRENT_USER\\x\r\n' }),
    packageManager: { settled: true, directories: [] },
  })
  assert.deepEqual([...resolved.directories], [])
  assert.equal(resolved.complete, false, 'a machine that named no directories was called a finished search')
})

/* ------------------------------------------------------------------
   5. Every other platform, untouched.
   ------------------------------------------------------------------ */

test('non-Windows reads PATH and nothing else, and never asks a registry', () => {
  let asked = 0
  const resolved = resolveSearchPath({
    platform: 'darwin',
    env: { PATH: ['/usr/local/bin', '/usr/bin'].join(path.delimiter) },
    readRegistryKey: () => { asked += 1; return null },
    packageManager: { settled: false, directories: [] },
  })
  assert.equal(asked, 0, 'a registry was consulted on a system that has none')
  assert.deepEqual([...resolved.directories], ['/usr/local/bin', '/usr/bin'])
  /* Complete on the same terms as before: a PATH that exists is the whole of
     the question there, so 'no' stays reachable exactly as it was. */
  assert.equal(resolved.complete, true)
})

test('non-Windows with no PATH at all is incomplete, never an empty machine', () => {
  const resolved = resolveSearchPath({ platform: 'linux', env: {}, readRegistryKey: () => null })
  assert.equal(resolved.complete, false)
  assert.deepEqual([...resolved.directories], [])
})

test('a fabricated machine is never resolved against the one the suite is running on', () => {
  /* machineSearchPath() is the ambient entry point. Handed an env that is not
     this process's, it must not go and read THIS computer's registry: that
     would mix two machines into one answer and make a verdict depend on the
     developer's own PATH. */
  const resolved = machineSearchPath({ platform: 'win32', env: { PATH: 'Z:\\only-here' } })
  assert.deepEqual([...resolved.directories], ['Z:\\only-here'])
  assert.equal(resolved.complete, false)
})

/* ------------------------------------------------------------------
   6. The rules this module is held to, asserted against its source.
   ------------------------------------------------------------------ */

test('no system binary is invoked by a name PATH would resolve', () => {
  /* The rule the engine's tests/system-binaries-resolve-under-system-root.test.js
     names. Reaching for a bare `reg` or `cmd` from PATH, inside the repair for
     a PATH defect, would be circular as well as a hijack vector: a PATH
     carrying MSYS2 or Cygwin answers those names with something else. */
  const source = readFileSync(MODULE_FILE, 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  for (const bare of ["'reg.exe'", "'cmd.exe'", "'reg'", "'npm'"]) {
    const literal = code.includes(bare)
    if (!literal) continue
    assert.ok(
      /systemRoot\(/.test(code),
      `${bare} appears without a system-root join anywhere in the file`,
    )
  }

  // The real asynchronous invocation and its exact SystemRoot-derived path are
  // exercised by machine-search-path-async-startup.test.mjs. This composition
  // entry must remain pure even when no explicit reading is supplied.
  const invocations = []
  const originalExecFileSync = childProcess.execFileSync
  const originalExecFile = childProcess.execFile
  childProcess.execFileSync = (file, args, options) => {
    invocations.push({ file, args, options })
    return 'HKEY\\Environment\r\n'
  }
  childProcess.execFile = (file, args, options) => {
    invocations.push({ file, args, options })
    throw new Error('Pure composition must not start a child')
  }
  try {
    resolveSearchPath({
      platform: 'win32',
      env: { SystemRoot: 'Q:\\Windows', PATH: 'C:\\inherited' },
      packageManager: { settled: true, directories: [] },
    })
  } finally {
    childProcess.execFileSync = originalExecFileSync
    childProcess.execFile = originalExecFile
  }

  assert.equal(invocations.length, 0, 'pure composition performed machine discovery')
})

test('every wait is bounded and no window is opened', () => {
  const source = readFileSync(MODULE_FILE, 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  const calls = code.split(/childProcess\.exec/).slice(1)
  assert.ok(calls.length >= 2, 'the child-process calls this asserts about are no longer here')
  for (const call of calls) {
    const head = call.slice(0, 600)
    assert.ok(/timeout:/.test(head), 'a child process is started with no timeout')
    assert.ok(/windowsHide: true/.test(head), 'a child process may flash a console window at somebody')
    assert.ok(/maxBuffer:/.test(head), 'a child process may grow this process without limit')
  }
})

test('it opens no file and reads no credential', () => {
  const source = readFileSync(MODULE_FILE, 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  for (const reader_ of ['readFile', 'readFileSync', 'createReadStream', 'openSync', 'readSync']) {
    assert.ok(!code.includes(reader_), `${reader_} appears in a module that only needs to know a directory exists`)
  }
})
