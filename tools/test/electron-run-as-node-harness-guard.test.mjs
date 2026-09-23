
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { sterileLaunchEnvironment } = require('../lib/sterile-launch.cjs')

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCAN_ROOTS = ['shell', 'tools', 'src']
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'release', 'artifacts'])
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs'])

// The two strips the shipped launch path depends on. Anchoring on them is what
// stops this guard from going green after a rename by scanning nothing useful.
// If either file is legitimately renamed, update this list in the same commit;
// that edit is the point, because it forces the rename to be seen.
const REQUIRED_LAUNCHERS = ['shell/launch.cjs', 'tools/smoke-packaged.mjs']

// Real launchers in this tree that a PRECISE detector can lose without anyone
// noticing, because none of them is on the ship path and all of them currently
// strip the variable correctly -- so losing them costs no red test today and
// all of the guard's value tomorrow. Each was measured, and each was in fact
// dropped by the first precise rewrite:
//   check-install-dir-immutable.mjs  launches at :324/:384 via `spawn as nodeSpawn`
//   agent-subpage-qa.mjs             :773 `const executable = await stage(scratch)`
//   setup-walkthrough-qa.mjs         :331 the same shape
// stage() returns appExecutable(app): the packaged executable, not a stand-in.
const LAUNCHERS_A_PRECISE_DETECTOR_CAN_LOSE = [
  'tools/agent-subpage-qa.mjs',
  'tools/check-install-dir-immutable.mjs',
  'tools/home-screen-qa.cjs',
  'tools/setup-walkthrough-qa.mjs',
]

// A FOURTH WAY TO BE SAFE, which the three idioms above cannot express.
//
// The idioms all describe REMOVING the variable from an inherited environment.
// A harness that never inherits one is immune by construction: it passes `env:`
// an explicit object literal with a fixed key set, so nothing from process.env
// -- including ELECTRON_RUN_AS_NODE -- can reach the child at all. That is
// strictly stronger than a delete, and no textual pattern for "this object was
// built by allowlist rather than by spread" is worth trusting, so the two files
// that do it are named here with the measurement that justifies each.
//
// Both were measured, not read: their env builders were invoked with a base
// containing ELECTRON_RUN_AS_NODE=1 and the returned object inspected.
//   org-window-proof.mjs   windowEnvironment()  -> key absent  (wants a window, gets one)
//   org-persistence-proof.mjs sterileEnvironment() -> '1' HARDCODED, identical
//                          under a clean base; it runs `exe -e <script>` on
//                          purpose, so it is the capability-layer pattern the
//                          header already blesses, not the bug this guard hunts.
//
// This is an exemption from the PATTERN, never from the rule. Each entry is
// asserted below to still be a detected launcher, so deleting or renaming one
// fails this test rather than silently shrinking the guard's reach.
const ALLOWLIST_ENVIRONMENT_HARNESSES = new Map([
  ['tools/org-window-proof.mjs',
    'windowEnvironment() returns a fixed-key literal; ELECTRON_RUN_AS_NODE is absent from it.'],
  ['tools/org-persistence-proof.mjs',
    'sterileEnvironment() returns a fixed-key literal and sets ELECTRON_RUN_AS_NODE=1 deliberately, to run the binary as node with an explicit -e script.'],
])

// THE SAME TWO FILES, EXEMPT FROM THE HOMES RULE FOR THE SAME REASON. A fixed-
// key literal inherits nothing, so it cannot inherit LOCALAPPDATA; and both
// literals were read, not assumed: each names LOCALAPPDATA, APPDATA, USERPROFILE
// and TEMP from a profile created under tmpdir() by the same file, and neither
// names CODEX_HOME or HOME at all. That is strictly stronger than the helper.
// Each entry is asserted below to still be a detected launcher.
const ALLOWLIST_STERILE_BY_LITERAL = new Map([
  ['tools/org-window-proof.mjs',
    'windowEnvironment() is a fixed-key literal whose LOCALAPPDATA/APPDATA/USERPROFILE/TEMP come from an isolated profile under tmpdir(); nothing is inherited.'],
  ['tools/org-persistence-proof.mjs',
    'sterileEnvironment() is a fixed-key literal whose LOCALAPPDATA/APPDATA/USERPROFILE/TEMP come from an isolated profile under tmpdir(); nothing is inherited.'],
])

// Expressions that denote the packaged GUI executable.
const NAMES_THE_GUI_EXE = [
  /(['"`])ToolsEnabled\.exe\1/,
  /\bAPP_EXE\b/,
  /require\(\s*['"]electron['"]\s*\)/,
  /from\s+['"]electron['"]/,
]
const NEUTRALISES_THE_VARIABLE = [
  /delete\s+[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.ELECTRON_RUN_AS_NODE/,
  /guiEnvironment\s*\(/,
  /startsWith\(\s*['"]ELECTRON_/,
  // 4. the shared sterile-launch helper, which performs idiom 1 inside
  //    tools/lib/sterile-launch.cjs and is the one environment a tools/
  //    launcher may use (see the second rule below).
  /sterileLaunchEnvironment\s*\(/,
  /providerAuthenticatedLaunchEnvironment\s*\(/,
]

// THE HOMES RULE: the launcher imports the one helper module AND calls the one
// function. Both, so a file that defines its own function of that name without
// importing the module is not mistaken for compliant, and a file that imports
// the module for its fence alone is not either.
const STERILISES_THE_HOMES = [
  /sterile-launch\.cjs['"]/,
  /(?:sterileLaunchEnvironment|providerAuthenticatedLaunchEnvironment)\s*\(/,
]

// A Playwright launch of the Electron binary. It is not a child_process call,
// so the spawn extractor never sees it; it is the second measured vector.
const PLAYWRIGHT_LAUNCH = /_electron\s*\.\s*launch\s*\(/

// Any call to one of the process-spawning functions, including the
// `dependencies.spawn(...)` member form used by tools/smoke-packaged.mjs.
const SPAWN_FUNCTIONS = ['spawn', 'spawnSync', 'execFile', 'execFileSync']

// ...and any LOCAL ALIAS of one (DEFECT 3, measured after the rewrite above).
// `\bspawn\s*\(` cannot match `nodeSpawn(`, and two files here import the
// function under exactly that name: tools/smoke-packaged.mjs:1 and
// tools/check-install-dir-immutable.mjs:65 both do
// `import { spawn as nodeSpawn } from 'node:child_process'`.
// check-install-dir-immutable.mjs launches the packaged app at :324 and :384
// through that alias, and was detected ONLY by the accident of an unrelated
// execFile('taskkill.exe') at :305 cleaning up the child it had already
// spawned invisibly. Delete that cleanup line and a real GUI launch becomes
// undetectable -- which is the "a harness written next week does not inherit
// the rule" failure this whole guard exists to prevent.
const CHILD_PROCESS_IMPORT =
  /(?:import\s*\{([^}]*)\}\s*from\s*|\{([^}]*)\}\s*=\s*require\(\s*)['"](?:node:)?child_process['"]/g

function spawnCallPattern(source) {
  const names = new Set(SPAWN_FUNCTIONS)
  for (const match of source.matchAll(CHILD_PROCESS_IMPORT)) {
    for (const part of (match[1] ?? match[2] ?? '').split(',')) {
      const aliased = /^\s*([A-Za-z_$][\w$]*)\s*(?:as|:)\s*([A-Za-z_$][\w$]*)\s*$/.exec(part)
      if (aliased && SPAWN_FUNCTIONS.includes(aliased[1])) names.add(aliased[2])
    }
  }
  return new RegExp(String.raw`\b(${[...names].join('|')})\s*\(`, 'g')
}

// A command the detector can positively ACCOUNT FOR: a quoted literal that is
// not the application ('powershell.exe', 'taskkill'), or the Node binary.
const QUOTED_LITERAL_COMMAND = /^(['"])(?:(?!\1)[^\\]|\\.)*\1$/
const NODE_BINARY_COMMAND = /^process\s*\.\s*(?:execPath|argv\s*\[\s*0\s*\])$/

// `const x = <expr>` / `let` / `var`, including an `export const` prefix. The
// initializer is taken to the end of the logical line, which is enough for the
// single-line binding forms every launcher in this repo uses.
const LOCAL_BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]*)/g

// `import electron from 'electron'`, `import { app } from 'electron'` -- the
// bound names all denote the Electron module, which in a plain-Node context is
// the binary path.
const ELECTRON_IMPORT = /import\s+([^;\n]*?)\s+from\s+['"]electron['"]/g

function escapeForRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

// Comment lines are removed before the neutralisation patterns run (DEFECT 2).
// Whole-line stripping only: it covers the documentation-header shape that
// caused the problem without the risk of mangling a regex literal or a URL
// inside a string, which a naive inline comment stripper does.
function withoutCommentLines(source) {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
    })
    .join('\n')
}

// KNOWN LIMITATION, measured and left in place deliberately.
//
// This file is itself scanned, and its inline fixtures are source text. The
// detector reads them as code, so the guard reports ITSELF as a launcher. It
// stays green because a fixture below also contains the `delete
// env.ELECTRON_RUN_AS_NODE` idiom, which reads as the file neutralising the
// variable. Both halves are wrong about this file and they cancel.
//
// Blanking literal bodies before scanning was tried and REVERTED: doing it by
// pairing backticks desynchronises on the backticks that appear inside
// ordinary quoted strings here (the offender message below) and inside the
// regex literal in NAMES_THE_GUI_EXE, which contains a quote, a double quote
// and a backtick in one character class. Telling a literal from code in this
// file needs a real tokeniser, including regex-literal handling; that is a
// bigger change than the hazard justifies, and a half-correct one measured
// WORSE than none -- it turned this file into a false offender.
//
// The live consequence, so the next person is not surprised by it: if the
// fixtures below are edited such that none of them contains an accepted strip
// idiom, this guard goes RED against a file that launches nothing. If that
// happens, the fix is a tokeniser, not an exemption.

// The text of a call's FIRST argument, given the index of its `(`.
// Returns null when the call is unbalanced within the file, which the caller
// reports rather than swallows -- an unreadable call site is an unchecked one.
function firstArgumentText(source, openParenIndex) {
  let depth = 0
  let quote = null
  for (let index = openParenIndex; index < source.length; index += 1) {
    const character = source[index]
    if (quote !== null) {
      if (character === '\\') { index += 1; continue }
      if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue }
    if (character === '(' || character === '[' || character === '{') { depth += 1; continue }
    if (character === ')' || character === ']' || character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openParenIndex + 1, index)
      continue
    }
    if (character === ',' && depth === 1) return source.slice(openParenIndex + 1, index)
  }
  return null
}

function referencesIdentifier(expression, name) {
  // Excluding a preceding `.` keeps `process.execPath` from matching a binding
  // called `exec`, and keeps a property named `exe` from matching a local `exe`.
  return new RegExp(`(?:^|[^\\w$.])${escapeForRegExp(name)}(?:$|[^\\w$])`).test(expression)
}

function denotesTheGuiExe(expression, taintedNames) {
  if (NAMES_THE_GUI_EXE.some((pattern) => pattern.test(expression))) return true
  for (const name of taintedNames) {
    if (referencesIdentifier(expression, name)) return true
  }
  return false
}

// Local names that carry the GUI executable, to a fixpoint, so a chain such as
//   const APP_EXE = 'ToolsEnabled.exe'
//   const executable = path.join(appDirectory, APP_EXE)
// taints `executable` as well.
function guiExeIdentifiers(source) {
  const tainted = new Set()

  for (const match of source.matchAll(ELECTRON_IMPORT)) {
    for (const name of match[1].matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (name[0] !== 'as' && name[0] !== 'from') tainted.add(name[0])
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const match of source.matchAll(LOCAL_BINDING)) {
      const [, name, initializer] = match
      if (tainted.has(name)) continue
      if (denotesTheGuiExe(initializer, tainted)) {
        tainted.add(name)
        changed = true
      }
    }
  }
  return tainted
}

// name -> every initializer bound to it, so a command that is a bare
// identifier can be followed rather than guessed at.
function localBindings(code) {
  const map = new Map()
  for (const match of code.matchAll(LOCAL_BINDING)) {
    if (!map.has(match[1])) map.set(match[1], [])
    map.get(match[1]).push(match[2])
  }
  return map
}

// Can this command be accounted for as something that is NOT the application?
// Only a literal, the Node binary, or an identifier whose binding chain ends in
// one of those. `await stage(scratch)` cannot: it is a helper's return value.
function commandIsAccountedFor(expression, bindings, depth = 0) {
  const trimmed = expression.trim()
  if (QUOTED_LITERAL_COMMAND.test(trimmed)) return true
  if (NODE_BINARY_COMMAND.test(trimmed)) return true
  if (depth >= 4) return false
  if (!/^[A-Za-z_$][\w$]*$/.test(trimmed)) return false
  const initializers = bindings.get(trimmed)
  if (!initializers || initializers.length === 0) return false
  return initializers.every((initializer) => commandIsAccountedFor(initializer, bindings, depth + 1))
}

/**
 * The core judgement, exported from the module scope so the tests below can run
 * it against inline fixtures as well as against real files.
 */
export function classifySource(source) {
  const tainted = guiExeIdentifiers(source)
  const code = withoutCommentLines(source)
  const bindings = localBindings(code)

  let provenSpawnTarget = false
  let unparseableSpawnCall = false
  let unresolvedCommand = false
  for (const match of code.matchAll(spawnCallPattern(code))) {
    const openParenIndex = match.index + match[0].length - 1
    const command = firstArgumentText(code, openParenIndex)
    if (command === null) { unparseableSpawnCall = true; continue }
    if (denotesTheGuiExe(command, tainted)) { provenSpawnTarget = true; continue }
    if (!commandIsAccountedFor(command, bindings)) unresolvedCommand = true
  }

  // DEFECT 4, measured: precision may only be spent where the target is
  // positively accounted for. An UNRESOLVED command used to answer "not a
  // launcher", which fails OPEN -- and two real harnesses take exactly that
  // shape, `const executable = await stage(scratch)` where stage() returns the
  // packaged executable (tools/agent-subpage-qa.mjs:773,
  // tools/setup-walkthrough-qa.mjs:331). Proved by deleting the real strip at
  // agent-subpage-qa.mjs:485: the file then genuinely launched the app with the
  // variable inherited and this guard stayed green. So an unreadable target in
  // a file that NAMES the application falls back to the old co-occurrence
  // answer: blunt, occasionally over-eager, but never silently blind.
  const namesTheGuiExe = NAMES_THE_GUI_EXE.some((pattern) => pattern.test(source))
  const playwrightLaunch = PLAYWRIGHT_LAUNCH.test(code)

  return {
    spawnsTheGuiExe: provenSpawnTarget || playwrightLaunch || (unresolvedCommand && namesTheGuiExe),
    provenSpawnTarget,
    playwrightLaunch,
    unresolvedCommand,
    unparseableSpawnCall,
    neutralised: NEUTRALISES_THE_VARIABLE.some((pattern) => pattern.test(code)),
    sterilised: STERILISES_THE_HOMES.every((pattern) => pattern.test(code)),
  }
}

function toPosix(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/')
}

async function walk(directory, found = []) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) await walk(absolute, found)
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(absolute)
    }
  }
  return found
}

async function scan() {
  const files = []
  for (const root of SCAN_ROOTS) files.push(...(await walk(path.join(REPO_ROOT, root))))

  const launchers = []
  const unparseable = []
  for (const absolute of files.sort()) {
    const source = await readFile(absolute, 'utf8')
    const verdict = classifySource(source)
    if (verdict.unparseableSpawnCall) unparseable.push(toPosix(absolute))
    if (!verdict.spawnsTheGuiExe) continue
    launchers.push({ file: toPosix(absolute), neutralised: verdict.neutralised, sterilised: verdict.sterilised })
  }
  return { scannedCount: files.length, launchers, unparseable }
}

test('the scan actually reads this repo (a vacuous pass is not a pass)', async () => {
  const { scannedCount, launchers } = await scan()
  assert.ok(
    scannedCount > 0,
    `scanned 0 files under ${SCAN_ROOTS.join(', ')} -- this guard would pass while checking nothing`,
  )
  assert.ok(
    launchers.length > 0,
    'found no file that launches the packaged GUI app. Either the harnesses moved out of ' +
      `${SCAN_ROOTS.join('/, ')}/ or the detection patterns drifted; both make this guard silently useless.`,
  )
})

test('every spawn call site in the tree could actually be parsed', async () => {
  // Fail-closed for the extractor. A call whose argument list this cannot read
  // is a call whose command is unknown, and an unknown command must never be
  // silently assumed harmless -- that is precisely how a launcher would slip
  // past the precise detector that replaced the old co-occurrence one.
  const { unparseable } = await scan()
  assert.deepEqual(
    unparseable,
    [],
    `the first argument of a spawn call could not be extracted in: ${unparseable.join(', ')}. ` +
      'Those call sites are NOT being checked. Either simplify the call or extend firstArgumentText().',
  )
})

test('every harness that launches the packaged app is still detected', async () => {
  const { launchers } = await scan()
  const detected = new Set(launchers.map((entry) => entry.file))
  const missing = REQUIRED_LAUNCHERS.filter((file) => !detected.has(file))
  assert.deepEqual(
    missing,
    [],
    `these launch the packaged app and the guard no longer sees them: ${missing.join(', ')}. ` +
      'If a file was renamed, update REQUIRED_LAUNCHERS in this test in the same commit.',
  )
})

test('the launchers that are easiest to lose are still detected', async () => {
  // Fixtures prove the detector CAN see a shape. This proves it still sees the
  // real files, which is a different claim: a fixture cannot notice that a real
  // harness was refactored into a shape the detector stopped following.
  const { launchers } = await scan()
  const detected = new Set(launchers.map((entry) => entry.file))
  const missing = LAUNCHERS_A_PRECISE_DETECTOR_CAN_LOSE.filter((file) => !detected.has(file))
  assert.deepEqual(
    missing,
    [],
    `these really do launch the packaged app and the guard no longer sees them: ${missing.join(', ')}.\n` +
      'They all strip the variable today, so nothing else in this suite would go red -- which is ' +
      'exactly why they are pinned here. Verified by deleting the strip at ' +
      'tools/agent-subpage-qa.mjs:485: a guard that has lost that file stays green while a real ' +
      'harness launches the app with ELECTRON_RUN_AS_NODE inherited.',
  )
})

test('every exempt harness is still present and still detected', async () => {
  // Fail-closed for the exemption list itself. An exemption for a file the scan
  // no longer sees is dead text that makes the guard look narrower than it is.
  const { launchers } = await scan()
  const detected = new Set(launchers.map((entry) => entry.file))
  const stale = [...ALLOWLIST_ENVIRONMENT_HARNESSES.keys()].filter((file) => !detected.has(file))
  assert.deepEqual(
    stale,
    [],
    `these files are exempted from the strip patterns but the scan no longer finds them: ${stale.join(', ')}. ` +
      'If one was renamed or deleted, update ALLOWLIST_ENVIRONMENT_HARNESSES in the same commit -- ' +
      're-measure the replacement before re-exempting it.',
  )
})

test('every harness that launches the packaged app strips ELECTRON_RUN_AS_NODE', async () => {
  const { launchers } = await scan()
  const offenders = launchers
    .filter((entry) => !entry.neutralised && !ALLOWLIST_ENVIRONMENT_HARNESSES.has(entry.file))
    .map((entry) => entry.file)
  assert.deepEqual(
    offenders,
    [],
    'These files spawn the packaged ToolsEnabled executable without removing ' +
      `ELECTRON_RUN_AS_NODE from the child environment: ${offenders.join(', ')}.\n` +
      'Under an agent harness that variable is exported as 1, and the app will then start as ' +
      'plain Node, read stdin, hit EOF and exit 0 with no window -- which reads as a product ' +
      'crash and has already cost this team a full afternoon of wrong diagnosis.\n' +
      'Fix it with one of: `const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE`, ' +
      "or `env: guiEnvironment(process.env)` from shell/capability-layer.cjs (preferred -- do not " +
      'reimplement it from memory).',
  )
})

test('every exempt-by-literal harness is still present and still detected', async () => {
  const { launchers } = await scan()
  const detected = new Set(launchers.map((entry) => entry.file))
  const stale = [...ALLOWLIST_STERILE_BY_LITERAL.keys()].filter((file) => !detected.has(file))
  assert.deepEqual(
    stale,
    [],
    `these files are exempted from the homes rule but the scan no longer finds them: ${stale.join(', ')}. ` +
      'If one was renamed or deleted, update ALLOWLIST_STERILE_BY_LITERAL in the same commit -- ' +
      're-measure the replacement before re-exempting it.',
  )
})

test('every tools/ harness that launches the application does so through the shared sterile environment', async () => {
  const { launchers } = await scan()
  const offenders = launchers
    .filter((entry) => entry.file.startsWith('tools/'))
    .filter((entry) => !entry.sterilised && !ALLOWLIST_STERILE_BY_LITERAL.has(entry.file))
    .map((entry) => entry.file)
  assert.deepEqual(
    offenders,
    [],
    'These files under tools/ launch the application without building its environment through ' +
      `tools/lib/sterile-launch.cjs sterileLaunchEnvironment(): ${offenders.join(', ')}.\n` +
      'A launch that inherits LOCALAPPDATA reads this machine\'s setup record, and on every start the shell ' +
      'rewrites the workspace .mcp.json that record names to point at the build being launched -- measured ' +
      '2026-08-22, three times, the last from a launcher one step after the one that had just been fixed.\n' +
      'Fix it with: import { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } ' +
      "from './lib/sterile-launch.cjs' (or qaProfileDirectories for the local/home layout), then " +
      'env: sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(<scratch dir>))) -- ' +
      'and add MC_SMOKE_HEADLESS or a PATH of your own after it if the harness needs one.',
  )
})

/* ---------- the classifier is proven against its own failure modes ---------- */
//
// Everything above measures the repo as it is today, so it goes green the
// moment the tree happens to be clean -- including if the detector silently
// stopped detecting. These fixtures pin the DISCRIMINATION itself: the shape
// that must be caught, and the shape that must not be flagged.

test('a harness that spawns the GUI exe without stripping the variable is caught', () => {
  const verdict = classifySource(`
    import { spawn } from 'node:child_process'
    const APP_EXE = 'ToolsEnabled.exe'
    const exe = path.join(directory, APP_EXE)
    spawn(exe, ['--smoke'], { env: { ...process.env } })
  `)
  assert.equal(verdict.spawnsTheGuiExe, true,
    'the detector no longer recognises a spawn whose command is bound from APP_EXE -- the guard is blind to the exact harness it exists to police')
  assert.equal(verdict.neutralised, false,
    'a harness that never mentions ELECTRON_RUN_AS_NODE was reported as neutralising it')
})

test('a harness that strips the variable is recognised as protected', () => {
  const verdict = classifySource(`
    const { spawn } = require('child_process')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const exe = require('electron')
    spawn(exe, [script], { env })
  `)
  assert.equal(verdict.spawnsTheGuiExe, true, 'require("electron") as a spawn command is a GUI launch and must still be detected')
  assert.equal(verdict.neutralised, true, 'the accepted `delete env.ELECTRON_RUN_AS_NODE` idiom was not recognised, which would report a correct harness as an offender')
})

test('a harness that launches through a shared reviewed environment is recognised under both rules', () => {
  const verdict = classifySource(`
    import { spawn } from 'node:child_process'
    import { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } from './lib/sterile-launch.cjs'
    const APP_EXE = 'ToolsEnabled.exe'
    const exe = path.join(directory, APP_EXE)
    const homes = prepareSterileProfile(sterileProfileDirectories(scratch))
    spawn(exe, ['--user-data-dir=' + userData], { env: sterileLaunchEnvironment(homes) })
  `)
  assert.equal(verdict.spawnsTheGuiExe, true)
  assert.equal(verdict.neutralised, true,
    'the shared helper deletes ELECTRON_RUN_AS_NODE inside tools/lib/sterile-launch.cjs; a launcher that calls it must count as protected')
  assert.equal(verdict.sterilised, true,
    'the helper was imported and called, which is exactly the shape the homes rule asks for')

  const realProvider = classifySource(`
    import { spawn } from 'node:child_process'
    import { providerAuthenticatedLaunchEnvironment } from './lib/sterile-launch.cjs'
    const APP_EXE = 'ToolsEnabled.exe'
    const env = providerAuthenticatedLaunchEnvironment({ accountHome, scratchRoot })
    spawn(APP_EXE, ['--user-data-dir=' + userData], { env })
  `)
  assert.equal(realProvider.spawnsTheGuiExe, true)
  assert.equal(realProvider.neutralised, true)
  assert.equal(realProvider.sterilised, true,
    'the narrow real-provider helper is the reviewed account-preserving sibling of the fully sterile helper')
})

test('the shared sterile environment actually removes Node-mode variables regardless of key casing', () => {
  const root = path.join(REPO_ROOT, '.test-profile')
  const profile = {
    localAppData: path.join(root, 'local'),
    appData: path.join(root, 'roaming'),
    userProfile: path.join(root, 'home'),
    codexHome: path.join(root, 'codex'),
    temp: path.join(root, 'temp'),
  }
  const environment = sterileLaunchEnvironment(profile, {
    Electron_Run_As_Node: '1',
    electron_no_attach_console: '1',
    PATH: 'preserved',
  })

  assert.deepEqual(
    Object.keys(environment).filter((key) => /^electron_(?:run_as_node|no_attach_console)$/i.test(key)),
    [],
    'Windows environment keys are case-insensitive, so mixed-case Node-mode variables must not survive',
  )
  assert.equal(environment.PATH, 'preserved', 'unrelated environment variables must remain available to Electron')
})

test('a harness that redirects its homes by hand, or only imports the helper, is NOT sterilised', () => {
  // The hand-rolled shape every launcher had on 2026-08-22: LOCALAPPDATA and
  // USERPROFILE pointed into scratch, APPDATA and CODEX_HOME inherited. It is
  // exactly what the one-file rule replaces, and it must read as an offender.
  const byHand = classifySource(`
    import { spawn } from 'node:child_process'
    const APP_EXE = 'ToolsEnabled.exe'
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    environment.LOCALAPPDATA = path.join(profile, 'local')
    environment.USERPROFILE = path.join(profile, 'home')
    spawn(APP_EXE, [], { env: environment })
  `)
  assert.equal(byHand.spawnsTheGuiExe, true)
  assert.equal(byHand.neutralised, true, 'it does strip the variable; that rule is satisfied')
  assert.equal(byHand.sterilised, false, 'a hand-rolled redirect was accepted as the shared helper')

  // Importing the module for its fence while launching with process.env.
  const fenceOnly = classifySource(`
    import { spawn } from 'node:child_process'
    import { createOutsideWriteFence } from './lib/sterile-launch.cjs'
    const APP_EXE = 'ToolsEnabled.exe'
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    spawn(APP_EXE, [], { env })
  `)
  assert.equal(fenceOnly.sterilised, false, 'importing the module is not calling the helper')

  // Defining a function of the same name locally, without the module.
  const homonym = classifySource(`
    import { spawn } from 'node:child_process'
    const APP_EXE = 'ToolsEnabled.exe'
    function sterileLaunchEnvironment() { return { ...process.env } }
    spawn(APP_EXE, [], { env: sterileLaunchEnvironment() })
  `)
  assert.equal(homonym.sterilised, false, 'a local homonym is not the shared helper')
})

test('a Playwright _electron.launch is a launch of the application', () => {
  // The second measured vector: `_electron.launch({ env })` starts the same
  // binary and inherits the same environment, and no child_process call is
  // involved for the spawn extractor to see.
  const inherited = classifySource(`
    const { _electron } = require_('playwright')
    const app = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + userData], env: process.env })
  `)
  assert.equal(inherited.spawnsTheGuiExe, true, 'a Playwright launch must be detected as a launch')
  assert.equal(inherited.playwrightLaunch, true)
  assert.equal(inherited.neutralised, false)
  assert.equal(inherited.sterilised, false)

  const sterile = classifySource(`
    import { prepareSterileProfile, qaProfileDirectories, sterileLaunchEnvironment } from './lib/sterile-launch.cjs'
    const { _electron } = require_('playwright')
    const environment = sterileLaunchEnvironment(prepareSterileProfile(qaProfileDirectories(profile)))
    const app = await _electron.launch({ executablePath: executable, env: environment })
  `)
  assert.equal(sterile.spawnsTheGuiExe, true)
  assert.equal(sterile.sterilised, true)
  assert.equal(sterile.neutralised, true)
})

test('spawning plain Node in a file that merely writes a file named like the exe is NOT a launcher', () => {
  // The measured false positive, kept as a fixture. tools/test/artifact-seal.test.mjs
  // was reported as an unprotected launcher on the strength of these two lines
  // co-occurring anywhere in the same file.
  const verdict = classifySource(`
    import { spawnSync } from 'node:child_process'
    spawnSync(process.execPath, [TOOL, mode, directory], { encoding: 'utf8' })
    writeFileSync(path.join(artifact, 'ToolsEnabled.exe'), 'binary\\n')
  `)
  assert.equal(verdict.spawnsTheGuiExe, false,
    'a file that spawns process.execPath and only WRITES a file named ToolsEnabled.exe was classified as a GUI launcher again -- this is the co-occurrence bug returning, and it makes the guard red about a file with no hazard')
})

test('a comment describing the strip does not count as performing it', () => {
  // The measured false negative. The patterns used to run against the whole
  // file text, and this guard's own header documents the idiom in prose.
  const verdict = classifySource(`
    import { spawn } from 'node:child_process'
    const APP_EXE = 'ToolsEnabled.exe'
    // We delete env.ELECTRON_RUN_AS_NODE before launching, see the design note.
    spawn(APP_EXE, ['--smoke'], { env: process.env })
  `)
  assert.equal(verdict.spawnsTheGuiExe, true, 'the fixture must be a launcher for this test to be about anything')
  assert.equal(verdict.neutralised, false,
    'a harness that only DESCRIBES the strip in a comment was accepted as protected -- prose about a protection is what a half-finished harness carries')
})

test('a spawn imported under an alias is still a spawn', () => {
  // DEFECT 3 as a fixture. `\bspawn\s*\(` cannot match `nodeSpawn(`, so this
  // whole shape used to be invisible. tools/check-install-dir-immutable.mjs is
  // written exactly like this and was detected only through an unrelated
  // execFile('taskkill.exe') elsewhere in the file.
  const verdict = classifySource(`
    import { spawn as nodeSpawn } from 'node:child_process'
    const APP_EXE = 'ToolsEnabled.exe'
    const executable = path.join(unpacked, APP_EXE)
    const child = nodeSpawn(executable, ['--user-data-dir=' + dir], { env: { ...process.env } })
  `)
  assert.equal(verdict.spawnsTheGuiExe, true,
    'a harness that imports spawn under another name still launches the app; if this is false the alias is a hole in the rule')
  assert.equal(verdict.provenSpawnTarget, true,
    'it must be caught by RESOLVING the target, not by the co-occurrence fallback')
  assert.equal(verdict.neutralised, false)
})

test('a spawn target the detector cannot resolve fails CLOSED', () => {
  // DEFECT 4 as a fixture, and the load-bearing one. Precision may only be
  // spent where the target is positively accounted for. This is the shape of
  // tools/agent-subpage-qa.mjs:773 and tools/setup-walkthrough-qa.mjs:331,
  // where stage() returns the packaged executable.
  const verdict = classifySource(`
    import { spawn } from 'node:child_process'
    const APP_EXE = 'ToolsEnabled.exe'
    // stage() unpacks the build into scratch and returns appExecutable(app)
    const executable = await stage(scratch)
    const child = spawn(executable, ['--smoke'], { env: { ...process.env } })
  `)
  assert.equal(verdict.provenSpawnTarget, false, 'nothing here proves the target IS the app')
  assert.equal(verdict.unresolvedCommand, true, 'the target came from a helper and cannot be followed')
  assert.equal(verdict.spawnsTheGuiExe, true,
    'an unresolvable spawn target in a file that names the app must still be flagged. Answering ' +
      '"not a launcher" here is how a real harness goes unchecked: it is the silent-miss half of ' +
      'the same bug the co-occurrence rule caused loudly.')
})

test('the fail-closed fallback does not flag every file that spawns something', () => {
  // The bound on the rule above, and the reason it is gated on the file naming
  // the application at all. Without this, every file in the tree that shells
  // out to anything would be reported as an unprotected GUI launcher and the
  // guard would be useless in the other direction.
  const verdict = classifySource(`
    import { spawn } from 'node:child_process'
    const child = spawn(await resolveFormatter(), ['--write'], { env: process.env })
  `)
  assert.equal(verdict.unresolvedCommand, true, 'the target is genuinely unresolvable')
  assert.equal(verdict.spawnsTheGuiExe, false,
    'a file that never names the application must not be dragged in by the fallback')
})

test('an unbalanced spawn call is reported rather than assumed harmless', () => {
  // No top-level comma and no closing paren, so the command expression never
  // terminates. `spawn(exe, [` would NOT qualify -- the comma ends the first
  // argument and `exe` is read out fine, which is the extractor working.
  const verdict = classifySource('const child = spawn(resolveExe(root, name)')
  assert.equal(verdict.unparseableSpawnCall, true,
    'a spawn call the extractor cannot read was silently skipped, so its command is unchecked and a launcher could hide there')
  assert.equal(verdict.spawnsTheGuiExe, false,
    'an unreadable call must not be GUESSED to be a launch either; it is reported by its own test, not folded into the offender list')
})
