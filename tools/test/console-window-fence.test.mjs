/* NOTHING ON THE AGENT-START PATH MAY PUT A CONSOLE WINDOW ON THE DESKTOP.
 *
 * WHAT WENT WRONG, MEASURED. The installed build popped a black console window
 * every time an agent session started. The release requirement already forbade
 * console-window flashes, but nothing enforced it, so this test holds the
 * product to that requirement.
 *
 * WHAT DECIDES IT, RE-MEASURED 2026-08-18 AFTER THE FIRST TABLE HERE WAS FOUND
 * WRONG. The rows this file used to carry omitted the variable every one of them
 * depends on -- THE PARENT'S OWN CONSOLE STATE -- and with that omitted they read
 * as "stdio pipe never shows a window, only inherit does", which is false and is
 * the sentence that would talk the next author out of passing windowsHide.
 * Parent state set explicitly with libuv's two creation flags
 * (`detached: true` -> DETACHED_PROCESS, no console; `windowsHide: true` ->
 * CREATE_NO_WINDOW), child reporting its own GetConsoleWindow(),
 * IsWindowVisible() and GetConsoleCP():
 *
 *   PARENT HAS NO CONSOLE (an installed GUI app started from the Start menu):
 *     stdio pipe, no windowsHide .................. CONSOLE, WINDOW VISIBLE
 *     stdio pipe, windowsHide: true ............... console, NO WINDOW
 *     stdio inherit, no windowsHide ............... CONSOLE, WINDOW VISIBLE
 *     stdio inherit, windowsHide: true ............ window exists, HIDDEN
 *     shell: true, no windowsHide ................. CONSOLE, WINDOW VISIBLE
 *     shell: true, windowsHide: true .............. console, NO WINDOW
 *
 *   PARENT HAS A CONSOLE WITH NO WINDOW (every child this product starts):
 *     all six of the above ........................ the parent's windowless
 *                                                   console, inherited;
 *                                                   nothing on screen
 *
 * SO windowsHide IS WHAT DECIDES, AND stdio DOES NOT. Every shape shows a window
 * without it and none shows one with it. That is why the rules below are stated
 * per CALL and hang on windowsHide: an inherited-stdio spawn that also sets
 * windowsHide is measured safe, and a piped spawn that does not set it is
 * measured dangerous -- the exact opposite of what the old table implied.
 *
 * A grandchild remains the thing a flag cannot reach, and that is still the
 * reason for the seam. `codex` is installed by npm as a Node launcher,
 * bin/codex.js, whose last act is `spawn(nativeBinary, argv, { stdio: 'inherit' })`
 * with no windowsHide. What was observed on 2026-08-17 was a 895x518
 * ConsoleWindowClass window owned by codex.exe, once per session start, and zero
 * after the launcher was resolved away; DRIVEN AGAIN 2026-08-18 with a
 * pid-attributed desktop census, the product's own seam started codex.exe with
 * ZERO new windows, while the same binary started without windowsHide from a
 * console-less parent produced exactly one visible ConsoleWindowClass owned by
 * codex.exe -- the positive control that makes the zero mean something.
 *
 * THE FIX A FLAG COULD NOT MAKE. A flag we pass cannot reach a grandchild, so
 * the payload resolves the npm launcher to the native executable and starts
 * that directly, under its own windowsHide. That resolution lives in the
 * payload's single spawn seam, src/lib/proc/hidden-spawn.js.
 *
 * WHAT THIS FILE ASSERTS, and why it lives in THIS repo. The engine repo has
 * its own fence over its own sources (tests/agent-engine/hidden-spawn-fence.test.js).
 * This is the repo that CUTS THE INSTALLER, so this asserts the property of the
 * bytes that are about to ship: the staged payload, and shell/, which is the
 * half of the agent-start path the payload does not contain.
 *
 * IT IS CHEAP ON PURPOSE -- it reads files and starts nothing, so it belongs in
 * `npm test` rather than on the release gate.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const SHELL = path.join(REPO, 'shell')
const PAYLOAD = path.join(REPO, 'capability')

/* The payload's agent-start modules, named the same way shell/agent-host.cjs
   names them so the two cannot drift apart silently. */
const PAYLOAD_ENGINE_DIR = 'src/lib/agent-engine'
const PAYLOAD_SEAM = 'src/lib/proc/hidden-spawn.js'

/* shell/launch.cjs is the `npm run app` development launcher, not a shipped
   start path: it deliberately inherits stdio so a developer sees the app's
   output in the terminal they started it from, and in that situation the parent
   already owns the console the child attaches to, so nothing new appears. It is
   named here rather than silently skipped -- an exemption that is not written
   down is an exemption nobody can argue with later. */
const SHELL_EXEMPT = new Set(['launch.cjs'])

/* Blank comments so the rules match CODE, not the prose explaining them.
 *
 * LINE COMMENTS COME OFF FIRST, AND THE ORDER IS LOAD-BEARING. The shape used
 * elsewhere in this directory strips block comments with one whole-file regex
 * before touching line comments. That reads the slash-star inside a glob written
 * in a LINE comment -- `tests/agent-comms/*.js`, and this tree is full of them --
 * as opening a block, finds no close, and blanks everything up to the next one.
 * Measured in the engine repo's sibling fence: it swallowed a plain
 * `require('node:child_process')` fifty lines down and reported zero violations.
 *
 * Removing the line comment first deletes that text before it can be mistaken
 * for anything, and walking line by line means the stripper can never cross a
 * newline it did not intend to. It may under-strip; it must never over-strip. */
function codeOnly(source) {
  const lines = []
  let inBlock = false
  for (const original of source.split('\n')) {
    let text = original
    if (inBlock) {
      const close = text.indexOf('*/')
      if (close === -1) { lines.push(''); continue }
      text = text.slice(close + 2)
      inBlock = false
    }
    text = text.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')
    for (let guard = 0; guard < 100; guard += 1) {
      const open = text.indexOf('/*')
      if (open === -1) break
      const close = text.indexOf('*/', open + 2)
      if (close === -1) { text = text.slice(0, open); inBlock = true; break }
      text = `${text.slice(0, open)} ${text.slice(close + 2)}`
    }
    lines.push(text)
  }
  return lines.join('\n')
}

/* THE NAMES child_process.spawn IS ACTUALLY CALLED IN THIS SOURCE.
 *
 * THE BLIND SPOT THIS CLOSES, found 2026-08-22 while adding the one call that
 * is MEANT to show a window. shell/main.cjs does not call `spawn(...)`. It
 * binds `const { spawn: spawnChildProcess } = require('node:child_process')`
 * and calls THAT -- and the opener below, which matched only the literal names
 * `spawn` and `spawnSync`, walked straight past every one of them. A rule that
 * reads the raw import cannot be evaded by renaming it, so the aliases are
 * read out of the source rather than listed here.
 *
 * The seam names (spawnHidden and friends) are deliberately NOT swept in: they
 * are the wrappers that SET the flag, and a caller forwarding to one is the
 * shape this fence wants. Only a direct binding of child_process.spawn counts. */
function spawnNamesIn(source) {
  const names = new Set(['spawn', 'spawnSync'])
  const binding = /\{\s*spawn(?:Sync)?\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/g
  let found
  while ((found = binding.exec(source))) names.add(found[1])
  return [...names]
}

/* Every spawn/spawnSync call in `source`, each read to its balanced closing
   paren so the options object is complete. Strings are tracked so a paren
   inside a literal cannot end the call early. */
function spawnCallsIn(source) {
  const calls = []
  const opener = new RegExp(`\\b(?:${spawnNamesIn(source).join('|')})\\s*\\(`, 'g')
  let match
  while ((match = opener.exec(source))) {
    let depth = 0
    let quote = null
    let escaped = false
    for (let i = match.index + match[0].length - 1; i < source.length && i - match.index < 4000; i += 1) {
      const character = source[i]
      if (quote) {
        if (escaped) { escaped = false; continue }
        if (character === '\\') { escaped = true; continue }
        if (character === quote) quote = null
        continue
      }
      if (character === '"' || character === "'" || character === '`') { quote = character; continue }
      if (character === '(') depth += 1
      else if (character === ')') {
        depth -= 1
        if (depth === 0) { calls.push(source.slice(match.index, i + 1)); break }
      }
    }
  }
  return calls
}

function jsFilesIn(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:c?js|mjs)$/.test(entry.name))
    .map(entry => entry.name)
}

/* capability/ is a gitignored BUILD OUTPUT: a fresh clone has none, and
   `npm run pack:capability` is what produces it. So its absence cannot be a
   test failure in `npm test` without making a clean checkout permanently red.
   The skip carries its reason into the TAP output rather than passing silently
   -- a fence that says nothing when it checked nothing is how "all green" stops
   meaning anything. Absence is
   fatal on the path where it must be: tools/check-asar-manifest.mjs gates every
   declared payload module against the built payload before a cut. */
/* PAYLOAD.json is what the packer writes LAST, so it is the honest "a payload
   is staged" signal. An earlier version of this asked whether capability/src
   existed, which is true of the empty directory a half-finished pack leaves
   behind -- and that reported a missing seam as a product defect.
 *
 * WHY THE CHECK FOLLOWS THE PAYLOAD'S OWN DECLARATION RATHER THAN JUST LOOKING.
 *
 * The payload is packed from a PINNED engine worktree, and this repo cannot
 * advance that pin. A pin older than the console-window fix produces a payload
 * with no seam in it, and a fence that failed on that would paint this repo red
 * over a change nobody working here can make -- which is how a real guard gets
 * deleted for being noisy.
 *
 * So the payload assertions go live exactly when the payload SAYS it carries
 * the seam (tools/capability-manifest.json -> hostModules, copied into
 * PAYLOAD.json by the packer). Until the pin advances and the manifest lists it,
 * they skip and say why. From the moment it is declared, tools/check-asar-manifest.mjs
 * already fails any build that declares a hostModule it does not ship, so the
 * declaration is load-bearing rather than decorative -- and these checks then
 * assert the property of the bytes behind it. */
function payloadRecord() {
  try { return JSON.parse(readFileSync(path.join(PAYLOAD, 'PAYLOAD.json'), 'utf8')) } catch { return null }
}
const declaredModules = payloadRecord()?.hostModules ?? []
const payloadStaged = declaredModules.includes(PAYLOAD_SEAM)
const SKIP_REASON = 'the staged payload does not declare ' + PAYLOAD_SEAM
  + ' -- the engine pin it was packed from predates the console-window fix,'
  + ' so these checks would be measuring a payload that cannot pass them.'
  + ' Advance the pin, add the seam to tools/capability-manifest.json hostModules, and repack.'

test('1. the packed payload carries the single spawn seam', { skip: !payloadStaged && SKIP_REASON }, () => {
  /* ABSENCE OF THE SEAM INSIDE A STAGED PAYLOAD IS THE FAILURE MODE THAT
     MATTERS. If the payload were packed from an engine pin that predates the
     seam, test 2 would pass over a set of files that never reach it and report
     success about a build that still pops a window on every session start. */
  const seam = path.join(PAYLOAD, PAYLOAD_SEAM)
  assert.ok(
    existsSync(seam),
    `the staged payload has no ${PAYLOAD_SEAM}. The engine pin this payload was packed from predates the `
    + 'console-window fix, so the shipped agent path can still pop a console window per session start.',
  )
  const source = codeOnly(readFileSync(seam, 'utf8'))
  assert.match(source, /windowsHide:\s*true/, 'the spawn seam must always set windowsHide')
  assert.match(source, /shell:\s*false/, 'the spawn seam must never use a shell')
  assert.match(
    source,
    /codex\.exe/,
    'the seam must resolve the Codex npm launcher to its native executable; without that resolution the '
    + "launcher's own stdio:'inherit' spawn allocates a VISIBLE console window on every session start",
  )
})

test('2. every agent-engine module in the payload launches through the seam', { skip: !payloadStaged && SKIP_REASON }, () => {
  const directory = path.join(PAYLOAD, PAYLOAD_ENGINE_DIR)
  const files = jsFilesIn(directory)
  assert.ok(files.length > 0, `the staged payload carries no ${PAYLOAD_ENGINE_DIR}; the agent path is not in this build`)

  const offenders = []
  for (const name of files) {
    const source = codeOnly(readFileSync(path.join(directory, name), 'utf8'))
    if (/require\(\s*['"](?:node:)?child_process['"]\s*\)/.test(source)) {
      offenders.push(`${PAYLOAD_ENGINE_DIR}/${name}: requires child_process directly instead of the ${PAYLOAD_SEAM} seam`)
    }
    if (/\bshell\s*:\s*true\b/.test(source)) {
      offenders.push(`${PAYLOAD_ENGINE_DIR}/${name}: passes shell: true`)
    }
    if (/\bwindowsHide\s*:\s*false\b/.test(source)) {
      offenders.push(`${PAYLOAD_ENGINE_DIR}/${name}: passes windowsHide: false`)
    }
    if (/\bstdio\s*:\s*['"]inherit['"]/.test(source)) {
      offenders.push(`${PAYLOAD_ENGINE_DIR}/${name}: inherits stdio, the one combination measured to show a console`)
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

/* THE RULES, APPLIED PER CALL, over one source. Extracted so the red-proof
   below can run the SAME code against sources it writes itself: a detector that
   is only ever pointed at files that pass cannot be shown to catch anything, and
   this one was rewritten on 2026-08-18 -- a rewritten guard that has never been
   seen to go red is a guard nobody should trust.

   WHY THE stdio RULE MOVED FROM THE FILE TO THE CALL, AND ONTO windowsHide.
   The old rule forbade an inherited-stdio spawn anywhere in a shell module.
   Re-measurement (see the table at the top) shows stdio does not decide whether
   a window appears -- windowsHide does, in every shape -- so the old rule
   forbade something measured safe while allowing something measured dangerous:
   a file could pass by putting the inherit in one call and the flag in another.
   Per call, hanging on the flag that actually decides, is both stricter and
   true. */
/* THE ONE WINDOW SOMEBODY MEANT, AND HOW THE RULE TELLS IT FROM ONE SOMEBODY
 * FORGOT.
 *
 * The owner's instruction, 2026-08-22: the Sign in button must "launch their
 * cmd with the command printed for them". A terminal the person is meant to
 * SEE and type in is the deliberate opposite of everything this file exists to
 * prevent, and it cannot be written as `windowsHide: true` -- that flag is
 * precisely what would hide it.
 *
 * So the exception is named rather than silent, and it is narrow in three ways
 * at once: a call is excused only if its options carry this constant, the
 * constant may appear in exactly ONE shell file, and it must be defined there
 * as false. A plain `windowsHide: false`, a missing flag, and an inherited
 * stdio are all still caught -- the red proof below runs the real rule over
 * each of those shapes. Widening this means editing this line, which is a
 * thing a reviewer can see. */
const DELIBERATE_WINDOW = 'TERMINAL_WINDOW_IS_THE_POINT'

function consoleOffendersIn(label, rawSource) {
  const source = codeOnly(rawSource)
  const offenders = []
  if (/\bshell\s*:\s*true\b/.test(source)) offenders.push(`${label}: passes shell: true`)
  if (/\bwindowsHide\s*:\s*false\b/.test(source)) offenders.push(`${label}: passes windowsHide: false`)
  /* Matched on the call rather than the file so a module that merely mentions
     spawn in a comment is not accused, and read to its BALANCED closing paren --
     a lazy `.{0,600}?\)` stops at the first `)` inside the options object and
     reported capability-layer.cjs, which sets the flag two lines later. */
  for (const call of spawnCallsIn(source)) {
    /* A call that forwards an options object it was handed cannot state the
       flag itself; the seam it forwards to is what must set it. */
    if (/\.\.\.\s*options/.test(call)) continue
    if (/windowsHide\s*:\s*true/.test(call)) continue
    if (new RegExp(`windowsHide\\s*:\\s*${DELIBERATE_WINDOW}\\b`).test(call)) continue
    offenders.push(/\bstdio\s*:\s*['"]inherit['"]/.test(call)
      ? `${label}: inherits stdio with no windowsHide -- measured to put a VISIBLE console on the desktop -> ${call.replace(/\s+/g, ' ').slice(0, 90)}`
      : `${label}: spawns without windowsHide -> ${call.replace(/\s+/g, ' ').slice(0, 90)}`)
  }
  return offenders
}

test('3. no shipped shell module spawns a child that can show a console', () => {
  const offenders = []
  for (const name of jsFilesIn(SHELL)) {
    if (SHELL_EXEMPT.has(name)) continue
    offenders.push(...consoleOffendersIn(`shell/${name}`, readFileSync(path.join(SHELL, name), 'utf8')))
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

test('3b. RED PROOF: the rule above catches the shapes it exists to catch', () => {
  /* Each source below is the dangerous thing written as plainly as somebody
     would write it by accident. If any of these stops being flagged, rule 3 has
     become decoration -- which is the only way a guard like this ever fails. */
  const dangerous = {
    'inherited stdio with no flag': "spawn(exe, args, { stdio: 'inherit' })",
    'no options at all': 'spawn(exe, args)',
    'piped stdio with no flag': "spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] })",
    'the flag turned off': "spawn(exe, args, { stdio: 'pipe', windowsHide: false })",
    'a shell': 'spawn(command, { shell: true, windowsHide: true })',
    'the flag in a DIFFERENT call': "spawn(a, b, { windowsHide: true }); spawn(c, d, { stdio: 'inherit' })",
  }
  for (const [what, source] of Object.entries(dangerous)) {
    assert.ok(consoleOffendersIn('probe', source).length > 0, `${what} was not caught: ${source}`)
  }

  /* THE ALIAS, which walked past this rule until 2026-08-22. shell/main.cjs
     binds child_process.spawn to a name of its own and calls that; a rule that
     matched only the literal word `spawn` saw none of it. */
  const aliased = "const { spawn: spawnChildProcess } = require('node:child_process')\n"
    + "spawnChildProcess(exe, args, { stdio: 'ignore' })"
  assert.ok(consoleOffendersIn('probe', aliased).length > 0,
    'a renamed child_process.spawn is invisible to this rule')

  /* And the shapes measured SAFE must not be flagged, or the rule gets switched
     off for being noisy, which is how the real one dies. */
  const safe = {
    'piped stdio, flag set': "spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })",
    'inherited stdio, flag set': "spawn(exe, args, { stdio: 'inherit', windowsHide: true })",
    'a forwarded options object': 'spawn(command, args, { ...options })',
    'a mention in a comment': '// spawn(exe, args) is what this used to do',
    'the named deliberate window': `spawn(exe, args, { stdio: 'ignore', windowsHide: ${DELIBERATE_WINDOW} })`,
  }
  for (const [what, source] of Object.entries(safe)) {
    assert.deepEqual(consoleOffendersIn('probe', source), [], `${what} was wrongly flagged`)
  }
})

test('3c. the deliberate window is one call, in one file, and it really is a window', () => {
  /* MUTATION-SAMPLED 2026-08-28. Inverting the production constant in
     shell/main.cjs from false to true makes the assertion below fail. The
     green/red/restored-green transcript is REPORT-C1-console-window-fence.md. */
  /* THE EXCEPTION IS ONLY SAFE WHILE IT IS SMALL. A named opt-out that spreads
     is an opt-out that has quietly become the rule, so this counts it: one
     shell file may carry the constant, it must be defined false there (a `true`
     would hide the very window the person pressed a button to get), and exactly
     one spawn may use it. */
  const carriers = []
  let uses = 0
  for (const name of jsFilesIn(SHELL)) {
    const source = codeOnly(readFileSync(path.join(SHELL, name), 'utf8'))
    if (!source.includes(DELIBERATE_WINDOW)) continue
    carriers.push(`shell/${name}`)
    assert.match(
      source,
      new RegExp(`const\\s+${DELIBERATE_WINDOW}\\s*=\\s*false\\b`),
      `shell/${name} names the deliberate-window constant without defining it as false; a true there hides the terminal the person asked for`,
    )
    for (const call of spawnCallsIn(source)) {
      if (new RegExp(`windowsHide\\s*:\\s*${DELIBERATE_WINDOW}\\b`).test(call)) uses += 1
    }
  }
  assert.deepEqual(carriers, ['shell/main.cjs'],
    `the deliberate-window exception has spread beyond the one file that opens the sign-in terminal: ${carriers.join(', ')}`)
  assert.equal(uses, 1, `${uses} spawns claim the deliberate-window exception; there is one terminal to open`)
})

test('4. the exemption list names only files that exist', () => {
  /* A stale exemption is an exemption for a file nobody can find, which is how
     a real offender gets quietly forgiven under an old name. */
  const present = new Set(jsFilesIn(SHELL))
  const stale = [...SHELL_EXEMPT].filter(name => !present.has(name))
  assert.deepEqual(stale, [], `exempted shell files that no longer exist: ${stale.join(', ')}`)
})
