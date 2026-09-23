/* THE GUARD THAT KEEPS THE PACKAGED-WINDOW DRIVERS WIRED.
 *
 * WHAT THIS IS FOR. Thirteen harnesses that drive the real packaged window sat
 * in tools/ invoked by NO automated path -- not `npm test`, not `dist`, not
 * `release:cut`. They are the instruments that saw the checkout privacy leak,
 * the unreachable agent page, the Recommended dead end, the dead steering
 * controls and the demonstration page that spawned a real session. Every one of
 * those was found by a person running one by hand.
 *
 * tools/packaged-qa-suite.mjs is now the automated path. This suite is what
 * stops it rotting, and it is deliberately CHEAP: it launches no window and
 * starts no Electron process, so it can live in `npm test` alongside everything
 * else. The expensive part is the suite itself, which belongs on the release
 * gate.
 *
 * WHAT IT ASSERTS, and why each one is a way this has already gone wrong here:
 *
 *   1. Discovery finds something. A glob that matches nothing exits 0 and
 *      reports success -- the exact defect tools/check-suites-discovered.mjs
 *      exists for on the unit suites. Zero drivers is an ERROR.
 *   2. Every driver on disk is in the plan. Not a list -- the plan is derived
 *      from the same glob, so this asserts the derivation, and it catches a
 *      driver that was renamed out of the convention.
 *   3. Settings never name a file that is gone (stale entry) and never decide
 *      membership (an unregistered driver still gets a runnable plan).
 *   4. Every driver the suite RUNS spawns the packaged app with windowsHide,
 *      and none of them re-introduces `windowsHide: false`. A driver that opens
 *      a VISIBLE window is held out with a written reason rather than dropped.
 *   5. The runner puts the exact string '1' in MC_SMOKE_HEADLESS -- the only
 *      value shell/window-options.cjs hides the window for. ABSENCE CASE: an
 *      unset or empty value SHOWS the window, so inheriting it is not enough.
 *   6. The runner never treats a timeout as a pass.
 *   11-14. NO DRIVER MAY EVER BE SILENTLY UNSEEN. Added 2026-08-23, after the
 *      pattern was measured to know one of the two naming families in use and
 *      twenty-eight harnesses turned out to be invisible rather than skipped.
 *      Every test 1-10 was green throughout, including the "second opinion" in
 *      test 2, which spelled the pattern the same wrong way. These pin the
 *      widened rule, the exclusion mechanism, and the discovery guard
 *      (tools/check-drivers-discovered.mjs) -- including a MUTATION that plants
 *      two plausible unreachable drivers in a scratch directory and requires
 *      the guard to name both.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DRIVER_PATTERN,
  HELD_OUT_OF_DISCOVERY,
  accountFencedDriverEnvironment,
  discoverDrivers,
  planFor,
  releaseArgumentsFor,
  usesSharedReleaseStage,
  registeredNames,
  runnerForSource,
  staleHoldOuts,
  staleSettings,
  verdictFor,
} from '../packaged-qa-suite.mjs'
import { platformHoldOut } from '../packaged-qa-suite.mjs'
import { packagedLauncherName, unpackedDirectoryName } from '../lib/packaged-platform.mjs'
import { auditDrivers, looksLikeADriver } from '../check-drivers-discovered.mjs'
import { PROVIDER_FREE_SCENARIO, selectedScenarios } from '../recommended-path-packaged-qa.mjs'
import { sweepWorkItems, verdictOf as sweepVerdictOf } from '../agent-tool-sweep-qa.mjs'
import { enumerateTools, playwrightAttemptLevel } from '../agent-tools-matrix-qa.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TOOLS = path.join(REPO_ROOT, 'tools')
const RUNNER = path.join(TOOLS, 'packaged-qa-suite.mjs')
const runnerSource = readFileSync(RUNNER, 'utf8')
const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
const releaseCutterSource = readFileSync(
  path.join(TOOLS, 'release-packager', 'cut-release-candidate.mjs'),
  'utf8',
)

/* Read independently of the runner's own glob, so this is a second opinion
   rather than a restatement of the thing under test.

   BOTH SUFFIXES, updated 2026-08-23 with the defect that made it necessary.
   This expression used to read `-qa` alone, exactly like the runner's, so it
   agreed with the runner about a set that was missing twenty-eight files and
   stayed green throughout. A second opinion that copies the first is not a
   second opinion; the only reason it is written out again here rather than
   imported is so that a change to the runner's pattern has to be made twice
   and noticed once. */
function driversOnDisk() {
  return readdirSync(TOOLS, { withFileTypes: true })
    .filter(entry => entry.isFile() && /-(qa|drive)\.(mjs|cjs)$/.test(entry.name))
    .map(entry => entry.name)
    .sort()
}

function planned() {
  return planFor(discoverDrivers())
}

test('1. discovery finds drivers at all -- zero is an error, never a pass', () => {
  const discovered = discoverDrivers()
  assert.ok(discovered.length > 0,
    'no packaged-window QA driver was discovered under tools/. A gate that finds nothing reports success; ' +
    'either the harnesses moved or the -qa.{mjs,cjs} convention changed.')
  assert.ok(runnerSource.includes('discovered NO drivers'),
    'the runner must fail loudly on an empty discovery rather than exiting 0')
})

test('2. every driver on disk is in the plan the runner would execute', () => {
  const onDisk = driversOnDisk()
  const planned = new Set(planFor(discoverDrivers()).map(entry => entry.name))
  const missing = onDisk.filter(name => !planned.has(name))
  assert.deepEqual(missing, [],
    `these packaged-window QA drivers exist and would not run: ${missing.join(', ')}`)
})

test('3a. settings never name a driver that is not on disk', () => {
  const stale = staleSettings(discoverDrivers())
  assert.deepEqual(stale, [],
    `tools/packaged-qa-suite.mjs carries settings for files that no longer exist: ${stale.join(', ')}`)
})

test('3aa. the live keyboard Start proof is discovered, registered, and costly while the free audit stays free', () => {
  const plan = planned()
  const free = plan.find(entry => entry.name === 'a11y-keyboard-qa.mjs')
  const live = plan.find(entry => entry.name === 'a11y-keyboard-live-start-qa.mjs')

  assert.ok(free, 'the deterministic keyboard audit is missing from discovery')
  assert.equal(free.registered, true, 'the provider-free lane must have an explicit disposition')
  assert.equal(free.costly, false, 'keyboard reachability and disabled-state copy belong in every free release run')
  assert.deepEqual(free.needs, [], 'the free lane must never receive a real assistant-home pointer')
  assert.equal(free.artifactProof, 'instrumented-copy', 'the audit repacks app.asar with checkout files')
  assert.ok(live, 'the real Start/Stop keyboard proof is missing from discovery')
  assert.equal(live.registered, true, 'a provider-spending driver must never run on unreviewed defaults')
  assert.equal(live.costly, true, 'a real Codex Start must require --include-costly')
  assert.equal(live.runner, 'node')
  assert.equal(live.artifactProof, 'instrumented-copy', 'the live wrapper invokes the same repacking audit')
})

test('3aaa. agent subpage is reported as an instrumented copy, never exact-candidate proof', () => {
  const subpage = planned().find(entry => entry.name === 'agent-subpage-qa.mjs')
  assert.ok(subpage, 'the agent subpage driver is missing from discovery')
  assert.equal(subpage.artifactProof, 'instrumented-copy',
    'the driver overlays candidate files from the checkout and must not count as exact-candidate proof')
})

test('3ab. the costly keyboard wrapper forwards the release and cannot substitute another Codex home', () => {
  const source = readFileSync(path.join(TOOLS, 'a11y-keyboard-live-start-qa.mjs'), 'utf8')

  assert.match(source, /process\.argv\.slice\(2\)/,
    'the wrapper must forward the suite arguments, including --release, rather than reconstructing them')
  assert.match(source, /\[AUDIT, \.\.\.forwarded, '--press-start', '--codex-home', codexHome\]/,
    'the costly opt-in and current-account pointer must be added without changing forwarded release arguments')
  assert.match(source, /path\.join\(os\.homedir\(\), '\.codex'\)/,
    'the pointer must derive from the user running the lane, not a named profile')
  assert.match(source, /--codex-home.*owned by this costly wrapper/s,
    'a caller must not be able to replace the current-account pointer')
  assert.match(source, /stdio: 'inherit'/,
    'the underlying audit output must reach verdictFor unchanged')
  assert.match(source, /process\.exit\(Number\.isInteger\(result\.status\) \? result\.status : 2\)/,
    'the wrapper must preserve the audit exit status and fail closed without one')
})

test('3b. an UNREGISTERED driver still gets a runnable plan -- settings are not membership', () => {
  const plan = planFor([...discoverDrivers(), 'invented-never-registered-qa.mjs'])
  const invented = plan.find(entry => entry.name === 'invented-never-registered-qa.mjs')
  assert.ok(invented, 'a driver with no settings entry was dropped from the plan')
  assert.equal(invented.registered, false, 'it must be reported as unregistered')
  assert.equal(invented.runner, 'node', 'it must still get a default runner')
  assert.ok(invented.timeoutMs > 0, 'it must still get a default timeout')
})

/* 3c. THE DEFAULT RUNNER IS NOT ALWAYS `node`, AND WHY THIS TEST EXISTS.
 *
 * MEASURED 2026-08-18, on a 40-driver run of the real suite:
 *   approvals-decision-outcome-qa   FAIL after 1.7s
 *   write-outcome-restate-qa        FAIL after 0.3s
 * Both are Electron main-process scripts. Both were UNREGISTERED, so both took
 * the `node` default, so both threw
 * `TypeError: Cannot read properties of undefined (reading 'setPath')` at
 * module load -- before one check had run. In the table that is indistinguishable
 * from a product defect, which is the most expensive way for a gate to be wrong:
 * it sends somebody to read the product for a fault that is in this file.
 *
 * So the question "which binary does this driver need" is now asked of the
 * driver, and the two shapes below are the ones that decide it. The third case
 * is the one a naive `includes('electron')` gets wrong -- tools/ring-fidelity-qa.mjs
 * SPAWNS the Electron binary from a node process and must stay on `node`. */
test('3c. an unregistered Electron main-process driver is not handed to node', () => {
  assert.equal(runnerForSource("const { app } = require('electron')"), 'electron',
    'a CommonJS driver that binds the electron module runs IN Electron, not under node')
  assert.equal(runnerForSource("import { app, BrowserWindow } from 'electron'"), 'electron',
    'the ESM spelling of the same fact')
  assert.equal(runnerForSource("await run(require('electron'), [path.join(ROOT, 'x.cjs')])"), 'node',
    'naming the electron BINARY to spawn is not the same as importing the module; ' +
    'ring-fidelity-qa does exactly this and must keep running under node')
  assert.equal(runnerForSource('const x = 1'), 'node', 'the floor is still node')
  assert.equal(runnerForSource(null), 'node', 'an unreadable driver falls back rather than throwing')
})

test('3d. every Electron main-process driver on disk gets the Electron binary', () => {
  const wrong = planFor(discoverDrivers()).filter(entry => {
    let source
    try { source = readFileSync(entry.file, 'utf8') } catch { return false }
    return runnerForSource(source) === 'electron' && entry.runner !== 'electron'
  })
  assert.deepEqual(wrong.map(entry => entry.key), [],
    'these drivers import the electron module and would be spawned under node, ' +
    'which throws at module load before any check runs')
})

test('3e. exact-default release routing never substitutes a different artifact or an unsupported flag', () => {
  const defaultRelease = path.join(REPO_ROOT, 'release', 'win-unpacked')
  const borrowedRelease = path.join(REPO_ROOT, 'release', 'borrowed-win-unpacked')
  const positionalDriver = "const unpacked = path.resolve(process.argv[2] || path.join(repo, 'release', 'win-unpacked'))"
  const homeDriver = readFileSync(path.join(TOOLS, 'home-screen-qa.cjs'), 'utf8')

  assert.deepEqual(
    releaseArgumentsFor("const release = argument('--release')", borrowedRelease, defaultRelease),
    ['--release', borrowedRelease],
    'a driver that reads --release must receive the exact requested directory',
  )
  assert.deepEqual(
    releaseArgumentsFor(positionalDriver, defaultRelease, defaultRelease),
    [],
    'a legacy driver may use its implicit default only when that directory is the exact requested artifact',
  )
  assert.equal(
    releaseArgumentsFor(positionalDriver, borrowedRelease, defaultRelease),
    null,
    'a legacy driver must refuse a borrowed artifact it cannot select',
  )
  assert.deepEqual(releaseArgumentsFor(positionalDriver, null, defaultRelease), [])
  assert.deepEqual(releaseArgumentsFor(homeDriver, borrowedRelease, defaultRelease), ['--release', borrowedRelease],
    'Home now selects an exact candidate explicitly; it is no longer a legacy-only driver')

  /* Exercise the command boundary without launching a window. Every current
     driver now consumes a selected release or explicitly reports its missing
     scenario. Listing routing is not proof that any scenario passed. The
     positional-only refusal above remains required for future legacy drivers. */
  const exact = spawnSync(process.execPath, [RUNNER, '--release', defaultRelease, '--list'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(exact.status, 0, `the isolated cutter's own default artifact was refused: ${exact.stderr}`)

  const borrowed = spawnSync(process.execPath, [RUNNER, '--release', borrowedRelease, '--list'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(borrowed.status, 0, borrowed.stderr)
  assert.doesNotMatch(borrowed.stdout, /checks passed/)
  assert.match(borrowed.stdout, /metrics-usage-live-qa/)

  const home = spawnSync(process.execPath, [RUNNER, '--release', borrowedRelease, '--only', 'home-screen-qa', '--list'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(home.status, 0, home.stderr)
  assert.match(home.stdout, /home-screen-qa/)
  assert.doesNotMatch(home.stdout, /checks passed/)
})

test('3f. the packaged suite refuses an explicit --release with no artifact', () => {
  for (const argv of [
    ['--list', '--release'],
    ['--list', '--release='],
    ['--list', '--release', '--only', 'home-screen-qa'],
  ]) {
    const result = spawnSync(process.execPath, [RUNNER, ...argv], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.notEqual(result.status, 0, `${argv.join(' ')} silently fell back to the default artifact`)
    assert.match(`${result.stdout}\n${result.stderr}`, /--release requires one path/)
  }
})

/* REPLACES the 1.0.44 test of the same number, and the replacement is the
   point of the change rather than a weakening of it.
   THE OLD TEST PINNED: "off Windows, the suite refuses a --release tree with no
   ToolsEnabled.exe", asserting the words `holds no ToolsEnabled.exe` and
   `Windows-host harness` on a tree that held a `toolsenabled` ELF. That is the
   exact sentence the 1.0.44 Linux cut recorded as step 54, exit 2, disclosed.
   It was right while the drivers had no Linux answers; it is wrong now, because
   the tree it refused is the tree this platform builds and the suite can read
   it. The refusal itself is KEPT and made stricter: it now asks for the
   launcher of the RUNNING host, so a Windows tree handed to a Linux run and a
   Linux tree handed to a Windows run are both still refused before any driver
   starts, and it still never names the tree. */
test('3g. a --release tree with no launcher of THIS platform is refused before any driver starts', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'pqa-no-exe-'))
  try {
    const release = path.join(scratch, 'unpacked-for-the-other-platform')
    mkdirSync(release)
    /* Deliberately the OTHER platform's launcher: the tree is a real build, of
       the wrong operating system. Naming it `.exe` on Linux and `toolsenabled`
       on Windows is the same test written once. */
    writeFileSync(path.join(release, process.platform === 'win32' ? 'toolsenabled' : 'ToolsEnabled.exe'), '')
    const logs = path.join(scratch, 'logs')
    const result = spawnSync(process.execPath, [RUNNER, '--release', release, '--logs', logs], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    })
    const output = `${result.stdout}\n${result.stderr}`
    assert.equal(result.status, 2, output)
    assert.match(output, new RegExp(`holds no ${packagedLauncherName().replace('.', '\\.')}`),
      'mutation `refuse without naming the launcher this host needs` survived: expected the running platform\'s launcher')
    assert.match(output, new RegExp(unpackedDirectoryName()),
      'mutation `refuse without saying which tree would work` survived: expected this platform\'s unpacked directory named')
    assert.equal(output.includes(release), false, 'the refusal must not name the tree: it is copied into declaration facts')
    let written = []
    try { written = readdirSync(logs) } catch { written = [] }
    assert.deepEqual(written, [], 'no driver may run, so no driver log may be written')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('3h. a Linux tree holding this platform\'s own launcher is no longer refused for being Linux', { skip: process.platform !== 'linux' }, () => {
  /* THE 1.0.44 BLOCKER, PINNED FROM THE OTHER SIDE. Until 1.0.45 this exact
     tree produced exit 2 and "porting the suite to Linux is separate work".
     It must now get past the launcher question -- what it may still stop on is
     the host's own ability to launch a sandboxed Chromium, which is a fact
     about THIS machine and is named as one. */
  const scratch = mkdtempSync(path.join(tmpdir(), 'pqa-linux-tree-'))
  try {
    const release = path.join(scratch, 'linux-unpacked')
    mkdirSync(release)
    writeFileSync(path.join(release, 'toolsenabled'), '')
    const result = spawnSync(process.execPath, [RUNNER, '--release', release, '--list'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000,
    })
    const output = `${result.stdout}\n${result.stderr}`
    assert.equal(result.status, 0, output)
    assert.equal(/holds no toolsenabled\b/.test(output), false,
      'mutation `keep refusing a Linux tree on a Linux host` survived: expected the platform port to hold')
    assert.equal(/Windows-host harness/.test(output), false,
      'mutation `restore the 1.0.44 refusal sentence` survived: expected it gone, because it is no longer true')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('3i. a driver whose subject is a Windows-only OS construct is a NAMED skip, never a silent pass', () => {
  /* The convention is RELEASE_SKIP_REGISTER's, down to the sentence: a skip is
     admitted only off the platform it requires, and it is never evidence of
     execution. Asked of BOTH platforms from here, so the Windows disposition is
     measured on this host too. */
  const onLinux = planFor(discoverDrivers(), 'linux').filter(entry => entry.platformHeldOut)
  const onWindows = planFor(discoverDrivers(), 'win32').filter(entry => entry.platformHeldOut)
  assert.deepEqual(onWindows, [],
    'mutation `hold a driver out on the platform it requires` survived: expected requiredPlatform win32 to RUN on win32')
  assert.ok(onLinux.some(entry => entry.key === 'nsis-upgrade-roundtrip-qa'),
    'mutation `let the NSIS round trip go red on Linux for a question Linux cannot be asked` survived: '
    + 'expected it skipped by name')
  for (const entry of onLinux) {
    assert.match(entry.platformHeldOut, /requires win32; this host is linux/,
      `mutation \`invent a second sentence for a platform skip\` survived: expected ${entry.key} to carry the register's own words`)
    assert.ok(entry.platformReason.length > 80,
      `mutation \`skip ${entry.key} without saying what the Windows-only subject is\` survived: expected a real reason`)
    assert.equal(entry.excluded, null,
      `mutation \`skip ${entry.key} unconditionally as well\` survived: expected a platform hold-out to be conditional`)
  }
  /* A requiredPlatform nobody explained is the silence rule 2b of the suite's
     header already forbids, wearing a new field name. */
  assert.throws(() => platformHoldOut({ key: 'invented-qa', requiredPlatform: 'win32' }, 'linux'),
    /no platformReason/,
    'mutation `accept requiredPlatform with no reason` survived: expected a refusal')
  assert.equal(platformHoldOut({ key: 'invented-qa', requiredPlatform: 'win32' }, 'win32'), null,
    'mutation `hold a driver out on its own platform` survived: expected null where the subject exists')
})

test('3j. --only on a driver whose subject is not on this platform answers with the reason, never with a 0/0 pass', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync(process.execPath, [RUNNER, '--only', 'nsis-upgrade-roundtrip-qa'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000,
  })
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(result.status, 2, output)
  assert.match(output, /is not run on linux/,
    'mutation `run a Windows-only driver anyway, or print 0\/0 over an empty set` survived: expected the reason')
  assert.match(output, /NSIS installer upgrade round trip/,
    'mutation `refuse without saying what the Windows-only subject is` survived: expected the subject named')
})

test('shared stage callers receive the exact artifact through their real imported default', () => {
  const requested = path.join(REPO_ROOT, 'release', 'selected-linux-candidate')
  for (const source of [
    "import { stage } from './test-account-harness.mjs'; await stage(scratch)",
    "import { stage as prepare } from './test-account-harness.mjs'; await prepare(scratch)",
    readFileSync(path.join(TOOLS, 'settings-ia-drive.mjs'), 'utf8'),
  ]) {
    assert.equal(usesSharedReleaseStage(source), true)
    assert.deepEqual(releaseArgumentsFor(source, requested), ['--release', requested])
  }
})

test('shared stage routing refuses non-default, shadowed, escaped and documentary lookalikes', () => {
  const prefix = "import { stage } from './test-account-harness.mjs'; "
  for (const source of [
    prefix,
    prefix + "await stage(scratch, otherArtifact)",
    prefix + "await stage(...args)",
    prefix + "const callback = stage; callback(scratch)",
    prefix + "function run(stage) { return stage(scratch) }",
    prefix + "/* stage(scratch) */",
    "// import { stage } from './test-account-harness.mjs';\nfunction stage(){}; stage(scratch)",
    "import { stage } from './different-harness.mjs'; stage(scratch)",
    "not valid JavaScript {{{",
  ]) {
    assert.equal(usesSharedReleaseStage(source), false, source)
    assert.equal(releaseArgumentsFor(source, path.join(REPO_ROOT, 'borrowed-candidate')), null, source)
  }
})

/* Strip comments before scanning.
 *
 * Measured, not assumed: the first version of the check below read the WORD
 * `show: true` out of a comment that explained why the code no longer does it,
 * and reported the file as an offender. An instrument that cannot tell code
 * from prose manufactures both false reds and, in the other direction, green
 * over a rule restated in a comment and dropped from the code. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(line => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n')
}

/* 4. THE RULE IS ABOUT WHAT RUNS, AND IT IS NOW STATED IN BOTH DIRECTIONS.
 *
 * Widening discovery to `-drive` brought in two Electron main-process drivers,
 * preview-browser-drive and subscribe-page-drive, that create their window with
 * `show: true` ON PURPOSE: both pixel-check their captures against the DOM, and
 * preview-browser-drive's header records a run where a hidden window produced
 * green assertions beside lying screenshots. Their evidence is right and rule 4
 * is right, and the two cannot both hold in an unattended cut.
 *
 * So the assertion is not "no driver anywhere has show: true" -- that would be
 * a demand to weaken their evidence. It is: a driver that opens a visible
 * window is HELD OUT, in writing, with a reason. Silence is what is forbidden,
 * in either direction: a visible-window driver that runs fails here, and a
 * visible-window driver that was quietly dropped fails the discovery guard.
 */
function visibleWindowDriver(source) {
  return /new BrowserWindow\(/.test(source) && /\bshow:\s*true\b/.test(source)
}

test('4. every driver the suite RUNS spawns the packaged application with windowsHide, and none opts out', () => {
  const offenders = []
  const excludedFor = new Map(planned().filter(entry => entry.excluded).map(entry => [entry.name, entry.excluded]))
  for (const name of driversOnDisk()) {
    const source = codeOnly(readFileSync(path.join(TOOLS, name), 'utf8'))
    if (/windowsHide\s*:\s*false/.test(source)) offenders.push(`${name}: windowsHide: false`)
    /* Electron main-process harnesses own their BrowserWindow instead of
       spawning the packaged exe; for those the equivalent rule is that the
       window must not be created shown, because show:true steals focus. */
    const spawnsExecutable = /spawn\(\s*execut/.test(source) || /spawn\(exe\b/.test(source)
    if (spawnsExecutable && !/windowsHide\s*:\s*true/.test(source)) {
      offenders.push(`${name}: spawns the packaged app without windowsHide`)
    }
    if (visibleWindowDriver(source) && !excludedFor.has(name)) {
      offenders.push(`${name}: creates its window with show: true, which steals focus, and the suite would RUN it`)
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

/* 4b. THE RULE THAT REPLACED "held out with a reason", 2026-08-23.
 *
 * The test that stood here required every driver creating its window with
 * `show: true` to be EXCLUDED with a written reason, and it asserted that at
 * least one such driver existed -- with a note saying that if the day came when
 * none did, delete it and restore the flat rule in 4. That day came: the two
 * drivers it was written for (preview-browser-drive and subscribe-page-drive,
 * the website and the ONLY behavioural check of the purchase surface) now gate
 * their window on MC_SMOKE_HEADLESS and render offscreen for a cut, so they run
 * before every publication instead of never.
 *
 * The rule that replaces it is the one that made un-excluding them safe, and it
 * is NOT "the window is hidden". Hiding a window is what produced the lying
 * screenshot in the first place. It is: A DRIVER THAT PHOTOGRAPHS THE PRODUCT
 * MUST BE ABLE TO FAIL ON ITS OWN EVIDENCE. Captures go through
 * tools/lib/capture-evidence.mjs, which refuses a blank frame and a frame from
 * the previous instant.
 *
 * FIVE DRIVERS THAT ALREADY RUN DO NOT MEET IT, and that was measured while
 * writing this, not assumed. Each creates a BrowserWindow with `show: false`
 * and calls capturePage() with nothing checking what came back -- the exact
 * configuration that wrote preview-1024-theme-tan.png showing the white theme.
 * They are listed rather than quietly exempted, for the same reason this suite
 * writes its exclusions down: a debt nobody can see is indistinguishable from
 * no debt. The list is checked for staleness in 4c, so fixing one of them
 * requires deleting its line here.
 */
const CAPTURE_EVIDENCE_DEBT = new Map([
  ['approvals-decision-outcome-qa.cjs',
    'creates its window with show: false and calls capturePage() with no freshness check'],
  ['owner-popup-qa.cjs',
    'same shape: a hidden window, capturePage(), and screenshots nothing verifies'],
  ['page2-qa.cjs',
    'same shape; it measures layout from the DOM, so its captures are records rather than assertions -- but they are still filed as evidence'],
  ['purchase-cart-readable-qa.cjs',
    'same shape, and it photographs the purchase list, where a stale frame would be a picture of the wrong cart'],
])

const ownsAWindow = source => /new BrowserWindow\(/.test(source)
const capturesPixels = source => /capturePage|captureTruthfully/.test(source)
const provesItsCaptures = source => /capture-evidence/.test(source)

test('4b. a driver that RUNS and photographs the product must be able to fail on its own evidence', () => {
  const plan = new Map(planned().map(entry => [entry.name, entry]))
  const unproven = []
  for (const name of driversOnDisk()) {
    const entry = plan.get(name)
    if (!entry || entry.excluded) continue          // an excluded driver photographs nothing here
    const source = codeOnly(readFileSync(path.join(TOOLS, name), 'utf8'))
    if (!ownsAWindow(source) || !capturesPixels(source)) continue
    if (provesItsCaptures(source)) continue
    if (CAPTURE_EVIDENCE_DEBT.has(name)) continue
    unproven.push(`${name}: it captures pixels in an unattended run and nothing would notice a blank or stale frame`)
  }
  assert.deepEqual(unproven, [],
    `${unproven.join('\n')}\n\nRoute its captures through tools/lib/capture-evidence.mjs, or add it to `
    + 'CAPTURE_EVIDENCE_DEBT with the sentence that says why it may file unchecked pictures.')
})

test('4c. the capture-evidence debt list is real, and a fixed driver must be taken off it', () => {
  assert.ok(CAPTURE_EVIDENCE_DEBT.size > 0,
    'if this list ever empties, delete it and the branch that reads it -- an allowance nobody needs is a hole nobody is watching')
  const onDisk = new Set(driversOnDisk())
  for (const [name, reason] of CAPTURE_EVIDENCE_DEBT) {
    assert.ok(onDisk.has(name), `${name} is on the debt list and is not on disk -- a stale allowance`)
    assert.ok(reason.length > 20, `${name}'s allowance must be a reason, not a shrug`)
    const source = codeOnly(readFileSync(path.join(TOOLS, name), 'utf8'))
    assert.ok(capturesPixels(source), `${name} no longer captures pixels; take it off the debt list`)
    assert.ok(!provesItsCaptures(source),
      `${name} now proves its captures -- take it off the debt list so the rule in 4b starts holding it`)
  }
})

test('4d. the website and purchase drivers RUN, and run the way they were allowed to', () => {
  /* The condition on which the two came out of the exclusion list. If a future
     edit takes the offscreen path or the evidence check out of either one, this
     goes red rather than a cut quietly photographing nothing. */
  const plan = new Map(planned().map(entry => [entry.name, entry]))
  for (const name of ['preview-browser-drive.mjs', 'subscribe-page-drive.mjs']) {
    const entry = plan.get(name)
    assert.ok(entry, `${name} is not in the plan at all`)
    assert.equal(entry.excluded, null,
      `${name} is the only pre-publication check of the surface it drives; it must not be held out again `
      + 'without replacing the coverage')
    const source = codeOnly(readFileSync(path.join(TOOLS, name), 'utf8'))
    assert.match(source, /MC_SMOKE_HEADLESS/,
      `${name} must decide its window from MC_SMOKE_HEADLESS, the same value the runner sets`)
    assert.match(source, /offscreen/,
      `${name} must render OFFSCREEN unattended -- show:false alone is what produced the lying screenshots`)
    assert.ok(provesItsCaptures(source),
      `${name} must assert every capture through tools/lib/capture-evidence.mjs`)
    assert.ok(!/\bshow:\s*true\b/.test(source),
      `${name} must not create its window unconditionally shown`)
    /* show() is the other way a window reaches the desktop, and it is not a
       hypothetical: subscribe-page-drive called view.show() to take keyboard
       focus for its Tab traversal, which is the single line that would have
       stolen focus from whoever is at the machine during a cut. Every call has
       to sit behind the headless flag. */
    for (const line of source.split('\n')) {
      if (!/\.show\(\)/.test(line)) continue
      assert.match(line, /HEADLESS/,
        `${name} calls .show() outside a MC_SMOKE_HEADLESS guard: ${line.trim()}`)
    }
  }
})

test("5. the runner sets MC_SMOKE_HEADLESS to the exact string '1' -- absence shows the window", () => {
  assert.match(runnerSource, /MC_SMOKE_HEADLESS\s*=\s*'1'/,
    "the runner must set MC_SMOKE_HEADLESS='1'; shell/window-options.cjs hides the window for that value and no other")
  /* The absence case, asserted against the product rule rather than restated:
     anything other than the exact string leaves the window visible. */
  const { headlessWindowOptions } = require_('../../shell/window-options.cjs')
  assert.deepEqual(headlessWindowOptions({ MC_SMOKE_HEADLESS: '1' }), { show: false })
  for (const value of [undefined, '', '0', 'true', 'yes', 1]) {
    assert.deepEqual(headlessWindowOptions({ MC_SMOKE_HEADLESS: value }), {},
      `MC_SMOKE_HEADLESS=${JSON.stringify(value)} must NOT be read as consent to hide the window`)
  }
})

test('5b. the suite removes only foreign-profile PATH entries before any driver code runs', () => {
  const accountHome = 'C:\\Users\\ToolsEnabled-Dev'
  const cwd = `${accountHome}\\Desktop\\WorkingFolder\\app-reconciled`
  const retained = [
    'C:\\Windows\\System32',
    'C:\\Program Files\\Git\\cmd',
    'C:\\agent-apps\\node-v22.19.0',
    `${accountHome}\\AppData\\Roaming\\npm`,
  ]
  const environment = accountFencedDriverEnvironment({
    Path: [
      ...retained,
      '.\\tools',
      '..\\..\\..\\..\\Foreign-QA-Path\\bin',
      '\\\\server\\share',
      '\\\\?\\C:\\Users\\Foreign-QA-Path\\bin',
      '\\\\.\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1',
      '\\??\\C:\\Users\\Foreign-QA-Path\\bin',
    ].join(';'),
    PATHEXT: '.COM;.EXE',
  }, {
    platform: 'win32',
    accountHome,
    cwd,
  })

  assert.deepEqual(environment.Path.split(';'), [...retained, '.\\tools'])
  assert.equal(environment.Path.includes('Foreign-QA-Path'), false)
  assert.equal(environment.PATHEXT, '.COM;.EXE')
  const child = spawnSync(process.execPath, [
    '-e',
    'process.stdout.write(process.env.Path || process.env.PATH || "")',
  ], {
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
  assert.equal(child.status, 0, String(child.stderr))
  assert.deepEqual(String(child.stdout).split(';'), [...retained, '.\\tools'],
    'the real Node driver process must receive the filtered PATH')
})

test('7. the runner does not write into the repository, which would fail require-clean-tree', () => {
  /* tools/require-clean-tree.mjs refuses to build from a tree with uncommitted
     files. artifacts/ is ignored, so logs written there could persist beside
     source without the clean-tree gate noticing them. */
  assert.match(runnerSource, /tmpdir\(\)/,
    'the default log directory must be outside the repository')
  assert.ok(!/argument\('--logs',\s*path\.join\(REPO_ROOT/.test(runnerSource),
    'the default log directory must not be under REPO_ROOT')
})

test('6. a timeout is reported as TIMEOUT and is never folded into a pass', () => {
  /* The decision is exercised, not grepped. A reaped process reports an exit
     code, and 0 is among the codes it can report -- so the case that matters is
     timedOut with a SUCCESSFUL-looking code. */
  assert.equal(verdictFor({ timedOut: true, code: 0 }), 'TIMEOUT',
    'a driver killed at its ceiling must never be reported as a pass, whatever code the corpse reports')
  assert.equal(verdictFor({ timedOut: true, code: 1 }), 'TIMEOUT')
  assert.equal(verdictFor({ timedOut: true, code: null }), 'TIMEOUT')
  assert.equal(verdictFor({ timedOut: false, code: 0 }), 'INCONCLUSIVE',
    'exit zero with no recognised result did no checking and must not pass')
  assert.equal(verdictFor({ timedOut: false, code: 1 }), 'FAIL')
  /* ABSENCE CASE: a driver that never produced an exit code at all -- the shape
     `close` delivers when the process was signalled -- is not a pass. */
  assert.equal(verdictFor({ timedOut: false, code: null }), 'FAIL')
  assert.equal(verdictFor({ timedOut: false, code: undefined }), 'FAIL')
  /* And the runner must actually use it rather than deciding inline. */
  assert.match(runnerSource, /const verdict = verdictFor\(/,
    'the runner must route its verdict through verdictFor so this test measures what runs')
})

/* The failure this suite was blind to until 2026-08-16: test-account-journey-qa
   reported PASS with eleven FAIL lines in its own log. The driver stopped
   part-way, createLedger's finish() never ran, nothing set process.exitCode,
   and a corpse reporting 0 was read as a green release gate. */
test('7. an exit code of 0 is a CLAIM, and the driver\'s own output is cross-examined against it', () => {
  /* (a) It counted its own failures and exited 0 anyway. */
  assert.equal(verdictFor({ timedOut: false, code: 0, output: '  ok  one\n  FAIL two  detail\n\n1/2 checks passed (journey)\n' }), 'FAIL',
    'a driver that summarised fewer passes than checks must fail however it exited')

  /* (b) The measured shape: checks ran, some failed, and the summary never
     printed because the driver stopped before finish(). Unmeasured is not
     passed, so this is INCONCLUSIVE rather than a quiet green. */
  assert.equal(verdictFor({ timedOut: false, code: 0, output: '  ok  one\n  FAIL two  detail\n' }), 'INCONCLUSIVE',
    'a ledger that started and never summarised leaves its remaining checks unmeasured')

  /* (c) All green and summarised is still a pass -- the fix must not invent
     failures, or it will be turned off. */
  assert.equal(verdictFor({ timedOut: false, code: 0, output: '  ok  one\n  ok  two\n\n2/2 checks passed (journey)\n' }), 'PASS')

  /* (d) The LAST summary decides. A driver may summarise a sub-phase green and
     then summarise itself red; believing the first is the same bug again. */
  assert.equal(verdictFor({ timedOut: false, code: 0, output: '2/2 checks passed (setup)\n  FAIL later\n3/4 checks passed (all)\n' }), 'FAIL')

  /* (e) Prose containing the word FAIL is not a failing check. The two leading
     spaces are the discriminator, but narration without a recognised closing
     result is not proof that the expected checks completed. */
  assert.equal(verdictFor({ timedOut: false, code: 0, output: 'the submit is refused, and a FAIL here would mean the gate is open\n' }), 'INCONCLUSIVE')

  /* (e2) THE OTHER TWO CONVENTIONS, taken from real logs. A rule that knew only
     createLedger's wording would have marked these red for ending differently,
     and a gate that cries wolf gets switched off. */
  assert.equal(verdictFor({ timedOut: false, code: 0, output: '  ok  a\n\nresearch walkthrough: 23/23 checks\n\nresearch walkthrough: PASS\n' }), 'PASS',
    'the walkthrough drivers close with "N/N checks" and must not be read as summary-less')
  assert.equal(verdictFor({ timedOut: false, code: 0, output: '  ok  a\n\nskip: 18/18 checks\n\nsetup walkthrough: PASS\n' }), 'PASS')
  assert.equal(verdictFor({ timedOut: false, code: 0, output: '  ok  a\n\n4 of 85 CHECK(S) FAILED\n' }), 'FAIL',
    'first-run-contract-qa counts its own failures in words; exiting 0 afterwards does not withdraw the count')
  assert.equal(verdictFor({ timedOut: false, code: 0, output: '  ok  a\n\n0 of 85 CHECK(S) FAILED\n' }), 'PASS')

  /* (e3) The fourth and fifth conventions, from real logs on 2026-08-18 — all
     three were fully green runs read as INCONCLUSIVE for closing differently. */
  assert.equal(verdictFor({ timedOut: false, code: 0, output: '  ok  a\n\nALL 82 CHECKS PASSED\n' }), 'PASS',
    'first-run-contract-qa closes its all-green run with ALL N CHECKS PASSED')
  assert.equal(verdictFor({ timedOut: false, code: 0, output: '  ok  a\n\n15 observation(s), 0 failing\n' }), 'PASS',
    'the observation drivers close with "N observation(s), M failing"')
  assert.equal(verdictFor({ timedOut: false, code: 0, output: '  ok  a\n\n15 observation(s), 2 failing\n' }), 'FAIL',
    'and a nonzero failing count is a failure whatever the exit code says')

  /* The approvals outcome drive writes a detailed JSON evidence object. JSON
     alone stays inconclusive; its explicit counted close is the verdict. */
  const approvalsEvidence = '{\n  "failures": [],\n  "ok": true\n}\n1/1 checks passed (approvals decision outcome)\n'
  assert.equal(verdictFor({ timedOut: false, code: 0, output: approvalsEvidence }), 'PASS')
  const approvalsDriver = readFileSync(path.join(TOOLS, 'approvals-decision-outcome-qa.cjs'), 'utf8')
  assert.match(approvalsDriver, /emitObserved\(observed\)/,
    'the approvals outcome drive must close its JSON evidence with a result the release gate can read')

  /* (f) A non-zero exit is still a failure whatever the log says, and a timeout
     is still decided first -- neither is reachable through the new branches. */
  assert.equal(verdictFor({ timedOut: false, code: 1, output: '4/4 checks passed\n' }), 'FAIL')
  assert.equal(verdictFor({ timedOut: true, code: 0, output: '4/4 checks passed\n' }), 'TIMEOUT')

  /* (g) Silence and unrecognised narration are not a result. A process can exit
     zero before running a single check, so neither path may satisfy the gate. */
  assert.equal(verdictFor({ timedOut: false, code: 0, output: 'built 42 things\n' }), 'INCONCLUSIVE')
  assert.equal(verdictFor({ timedOut: false, code: 0 }), 'INCONCLUSIVE')

  /* And the runner must hand it the output, or every branch above is dead code
     in the only place that matters. */
  assert.match(runnerSource, /verdictFor\(\{[^}]*output:/,
    'the runner must pass the driver output to verdictFor, or the cross-examination never runs')
})

test('7a. tool sweep distinguishes safety holds from release-blocking harness and refusal gaps', () => {
  const source = readFileSync(path.join(TOOLS, 'agent-tool-sweep-qa.mjs'), 'utf8')
  assert.deepEqual(
    sweepWorkItems([
      { name: 'quiet', verdict: 'SAFETY-HOLD' },
      { name: 'recipe', verdict: 'HARNESS-GAP' },
      { name: 'bad', verdict: 'FAILED' },
      { name: 'slow', verdict: 'HUNG' },
    ]).map(row => row.name),
    ['recipe', 'bad', 'slow'],
    'explicit safety holds may be non-product, but every harness gap must block release',
  )
  assert.equal(sweepVerdictOf({ error: { code: -32602, message: 'wrong arguments' } }).verdict, 'HARNESS-GAP',
    'an invalid-arguments response proves the recipe failed, not that the tool works')
  assert.equal(sweepVerdictOf({ result: { structuredContent: { error: {
    code: 'CREDENTIAL_REQUIRED', message: 'Sign in first', taxonomy: { code: 'AUTH_EXPIRED' },
  } } } }).verdict, 'GATED-OK', 'a named refusal with a recognized gate taxonomy is acceptable')
  assert.equal(sweepVerdictOf({ result: { structuredContent: { error: {
    code: 'PRECONDITION', message: 'Could not continue', taxonomy: { code: 'INTERNAL_ERROR' },
  } } } }).verdict, 'FAILED', 'INTERNAL_ERROR must never be relabeled as a working gate')
  assert.equal(sweepVerdictOf({ result: { structuredContent: { error: {
    code: 'PRECONDITION', message: 'Could not continue',
  } } } }).verdict, 'FAILED', 'a named sentence without a recognized taxonomy is not gate proof')
  assert.equal(sweepVerdictOf({ result: { isError: true, content: [{ type: 'text', text: 'try later' }] } }).verdict, 'FAILED',
    'an uncoded isError response must block release')
  assert.equal((source.match(/validateInitializeResponse\(await server\.call\('initialize'[\s\S]*?\), '2025-06-18'\)/g) ?? []).length, 2,
    'both initial startup and post-hang restart must require the exact requested initialize protocol')
  assert.match(source, /validateToolsListResponse\(listed, \{ requireNonEmpty: false \}\)/,
    'tools/list errors and malformed results must be rejected before catalog scoring')
  assert.doesNotMatch(source, /misleadingSummary|codeMissing|gates whose agent-visible text says|refusals with a sentence but no machine code/,
    'internal and uncoded failures must not be followed by obsolete zero-count claims')
  assert.match(source,
    /if \(advertised\.length === 0\)[\s\S]*?tools\/list advertised zero tools/,
    'an empty tools/list response must be an explicit failing observation')
  assert.match(source,
    /rows\.length !== advertised\.length \|\| missingNames\.length > 0 \|\| unexpectedNames\.length > 0/,
    'every advertised tool must produce exactly one scored row')
  assert.match(source,
    /`\\n\$\{observationCount\} observation\(s\), \$\{workItems\.length\} failing`/,
    'the sweep must emit the counted terminal convention the release runner recognizes')
  assert.match(source, /process\.exitCode = workItems\.length \? 1 : 0/,
    'a sweep with failed, hung, or harness-gap work items must not exit successfully')
  assert.equal(verdictFor({
    timedOut: false,
    code: 0,
    output: 'FAILED, HUNG, and HARNESS-GAP (work items):\n\n268 observation(s), 0 failing\n',
  }), 'PASS', 'an empty work-item heading is narration; the counted close is the verdict')
  assert.equal(verdictFor({
    timedOut: false,
    code: 1,
    output: 'FAILED catalog inventory: tools/list advertised zero tools\n\n1 observation(s), 1 failing\n',
  }), 'FAIL', 'a zero-tool inventory must never certify a release')
})

test('7ab. enumeration fails closed on protocol errors and warns only for the exact owner refusal', async () => {
  const initializeResult = {
    jsonrpc: '2.0',
    result: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      serverInfo: { name: 'test-server', version: '1.0.0' },
    },
  }
  const listedResult = { jsonrpc: '2.0', result: { tools: [{ name: 'probe' }] } }
  async function attemptFor(responses, stopOutcome = undefined) {
    let responseIndex = 0
    const server = {
      call: async () => responses[responseIndex++],
      stop: async () => stopOutcome,
    }
    return enumerateTools({}, {
      baseEnv: {}, label: 'test enumeration', timeoutMs: 50,
      startServerImpl: () => server,
    })
  }

  const valid = await attemptFor([initializeResult, listedResult])
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.tools, ['probe'])
  assert.equal(playwrightAttemptLevel(valid), 'ok')

  for (const [label, responses] of [
    ['initialize JSON-RPC error', [{ jsonrpc: '2.0', error: { code: -32603, message: 'initialize failed' } }]],
    ['initialize malformed envelope', [{ jsonrpc: '2.0', error: 'bad error', result: initializeResult.result }]],
    ['initialize malformed result', [{ jsonrpc: '2.0', result: {} }]],
    ['initialize protocol mismatch', [{ jsonrpc: '2.0', result: {
      ...initializeResult.result,
      protocolVersion: 'garbage',
    } }]],
    ['tools/list JSON-RPC error', [initializeResult, { jsonrpc: '2.0', error: { code: -32603, message: 'list failed' } }]],
    ['tools/list malformed result', [initializeResult, { jsonrpc: '2.0', result: {} }]],
    ['tools/list empty result', [initializeResult, { jsonrpc: '2.0', result: { tools: [] } }]],
  ]) {
    const attempt = await attemptFor(responses)
    assert.equal(attempt.ok, false, `${label} was accepted as a successful enumeration`)
    assert.equal(playwrightAttemptLevel(attempt), 'FAIL', `${label} did not block release`)
  }

  const exactOwnerRefusal = await attemptFor(
    [{ __transportError: 'server closed before initialize' }],
    { expectedPreSpawnRefusal: true },
  )
  assert.equal(exactOwnerRefusal.ok, false)
  assert.equal(playwrightAttemptLevel(exactOwnerRefusal), 'warn',
    'the exact response-free pre-spawn owner refusal is the sole non-product failure')
  assert.equal(playwrightAttemptLevel({ ok: false }), 'FAIL', 'an unclassified failure must fail closed')
})

test('7aa. tool inventory drivers consume the exact requested candidate payload', () => {
  const requested = path.join('C:', 'candidate', 'win-unpacked')
  const ownedParent = mkdtempSync(path.join(tmpdir(), 'toolsenabled-explicit-release-test-'))
  const missing = path.join(ownedParent, 'missing-release')
  try {
    for (const name of ['agent-tool-sweep-qa.mjs', 'agent-tools-matrix-qa.mjs']) {
      const source = readFileSync(path.join(TOOLS, name), 'utf8')
      assert.deepEqual(releaseArgumentsFor(source, requested), ['--release', requested],
        `${name} must receive the exact candidate selected by the release suite`)
      assert.match(source, /path\.join\(RELEASE, 'resources', 'capability'\)/,
        `${name} must derive its measured payload from that requested candidate`)
      assert.match(source, /if \(EXPLICIT_RELEASE && !existsSync\(STAGED_SERVER\)\)/,
        `${name} must fail closed instead of substituting source for a broken candidate`)
      const refused = spawnSync(process.execPath, [path.join(TOOLS, name), '--release', missing], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30_000,
      })
      assert.notEqual(refused.status, 0, `${name} accepted a candidate with no capability payload`)
      assert.match(`${refused.stdout}\n${refused.stderr}`, /requested release is missing its staged capability server/)

      for (const missingValue of [['--release'], ['--release='], ['--release', '--json', 'unused.json']]) {
        const missingResult = spawnSync(process.execPath, [path.join(TOOLS, name), ...missingValue], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 30_000,
        })
        assert.notEqual(missingResult.status, 0, `${name} silently ignored ${missingValue.join(' ')}`)
        assert.match(`${missingResult.stdout}\n${missingResult.stderr}`, /--release requires one path/)
      }
    }
  } finally {
    rmSync(ownedParent, { recursive: true, force: true })
  }
})

test('7ab. tool inventory drivers remove owned scratch when staged initialization fails', () => {
  const ownedParent = mkdtempSync(path.join(tmpdir(), 'toolsenabled-malformed-release-test-'))
  const candidate = path.join(ownedParent, 'candidate', 'win-unpacked')
  const stagedSource = path.join(candidate, 'resources', 'capability', 'src')
  mkdirSync(stagedSource, { recursive: true })
  writeFileSync(path.join(stagedSource, 'mcp-server.js'), '// deliberately incomplete staged payload\n')
  try {
    for (const [name, prefix] of [
      ['agent-tool-sweep-qa.mjs', 'tool-sweep-'],
      ['agent-tools-matrix-qa.mjs', 'tool-matrix-'],
    ]) {
      const isolatedTemp = path.join(ownedParent, `temp-${prefix}`)
      mkdirSync(isolatedTemp, { recursive: true })
      const extra = name === 'agent-tool-sweep-qa.mjs'
        ? ['--out', path.join(ownedParent, 'sweep-output')]
        : []
      const refused = spawnSync(process.execPath, [path.join(TOOLS, name), '--release', candidate, ...extra], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, TEMP: isolatedTemp, TMP: isolatedTemp },
        timeout: 30_000,
      })
      assert.notEqual(refused.status, 0, `${name} accepted a malformed staged payload`)
      assert.match(`${refused.stdout}\n${refused.stderr}`, /machine-record\.js/)
      assert.deepEqual(readdirSync(isolatedTemp), [],
        `${name} leaked its ${prefix} profile after initialization failed`)
    }
  } finally {
    rmSync(ownedParent, { recursive: true, force: true })
  }
})

test('7b. account-cart is registered, routes exact releases, and closes each measured state honestly', async () => {
  const { UNMEASURABLE_MARK } = await import('../machine-steadiness.mjs')
  const { engineQueueCount } = await import('../account-cart-row-qa.mjs')
  const diagnostic = {
    readable: false,
    reason: 'TOOLSENABLED_ENGINE_ROOT is not set, so the engine queue was not read. This is not a count of zero.',
  }
  const output = [
    'WHICH STATE ROOT ANSWERED',
    '  this sterile profile\'s layer: {"prompts":0}',
    `  the engine's own store:       ${JSON.stringify(diagnostic)}`,
    '',
    'PASS  the row resolved to "empty" after 731ms, inside the 6000ms budget.',
    '1/1 checks passed (account cart row)',
    '',
  ].join('\n')

  assert.equal(verdictFor({ timedOut: false, code: 0, output }), 'PASS',
    'the explicit 1/1 product assertion must pass even though the separate engine-root diagnostic is unavailable')

  const driver = readFileSync(path.join(TOOLS, 'account-cart-row-qa.mjs'), 'utf8')
  const entry = planned().find(item => item.name === 'account-cart-row-qa.mjs')
  assert.ok(entry, 'the account-cart row driver vanished from discovery')
  assert.equal(entry.registered, true, 'the exact packaged row driver must not run on unreviewed defaults')
  assert.equal(entry.costly, false)
  assert.equal(entry.artifactProof, 'exact-candidate')
  assert.deepEqual(releaseArgumentsFor(driver, path.join('C:', 'borrowed', 'win-unpacked')), [
    '--release', path.join('C:', 'borrowed', 'win-unpacked'),
  ], 'an explicit suite release must reach the exact executable the row driver measures')

  const noVerdict = `NO VERDICT  the harness never attached\n${UNMEASURABLE_MARK} the account-cart harness did not reach its timed row assertion.\n`
  assert.equal(verdictFor({ timedOut: false, code: 2, output: noVerdict }), 'INCONCLUSIVE',
    'probe failure must still stop the cut without being mislabeled as a product failure')

  const countStart = driver.indexOf('export function engineQueueCount(')
  const countEnd = driver.indexOf('async function main()', countStart)
  assert.ok(countStart >= 0 && countEnd > countStart, 'the engine queue diagnostic is missing')
  const countSource = driver.slice(countStart, countEnd)
  assert.match(countSource, /if \(!configured\) \{[\s\S]*?readable:\s*false/,
    'an absent engine root is unknown/unreadable, never an empty queue')
  assert.match(countSource, /This is not a count of zero\./)
  assert.doesNotMatch(countSource, /readable:\s*true,\s*prompts:\s*0/,
    'the diagnostic must not manufacture a zero when no engine root was read')

  let reads = 0
  const foreignRoot = 'C:\\Users\\ForeignAccount\\private-engine'
  const refused = engineQueueCount({
    environment: { TOOLSENABLED_ENGINE_ROOT: foreignRoot },
    platform: 'win32',
    currentUserHome: 'C:\\Users\\ToolsEnabled-Dev',
    readStore() { reads += 1; throw new Error('must never read a foreign profile') },
  })
  assert.equal(refused.readable, false)
  assert.equal(reads, 0, 'a stale sibling-profile engine root must be refused before filesystem access')
  assert.equal(refused.reason.includes(foreignRoot), false, 'the diagnostic must not publish a private profile path')

  const escaped = engineQueueCount({
    environment: { TOOLSENABLED_ENGINE_ROOT: 'C:\\Users\\ToolsEnabled-Dev\\..\\ForeignAccount\\private-engine' },
    platform: 'win32',
    currentUserHome: 'C:\\Users\\ToolsEnabled-Dev',
    readStore() { reads += 1; throw new Error('must never read a normalized foreign profile') },
  })
  assert.equal(escaped.readable, false)
  assert.equal(reads, 0, 'dot-segment normalization must happen before the foreign-profile decision')

  const linkedRoot = 'C:\\agent-apps\\engine-link'
  const linkProbes = []
  const linkTarget = 'C:\\Users\\ForeignAccount\\private-engine'
  const linked = engineQueueCount({
    environment: { TOOLSENABLED_ENGINE_ROOT: linkedRoot },
    platform: 'win32',
    currentUserHome: 'C:\\Users\\ToolsEnabled-Dev',
    filesystem: {
      lstatSync(candidate) {
        linkProbes.push(String(candidate))
        if (String(candidate).toLowerCase() === linkedRoot.toLowerCase()) {
          return { isSymbolicLink: () => true }
        }
        return { isSymbolicLink: () => false }
      },
      readlinkSync(candidate) {
        assert.equal(String(candidate).toLowerCase(), linkedRoot.toLowerCase())
        return linkTarget
      },
    },
    readStore() { reads += 1; throw new Error('must never follow a foreign-profile junction') },
  })
  assert.equal(linked.readable, false)
  assert.equal(reads, 0)
  assert.equal(linkProbes.some(candidate => candidate.toLowerCase().startsWith(linkTarget.toLowerCase())), false,
    'the resolver must stop on a junction target string before probing the foreign profile')

  const aliasRoot = 'C:\\Users\\TOOLSE~9'
  const aliasEngine = `${aliasRoot}\\engine`
  const aliasResult = engineQueueCount({
    environment: { TOOLSENABLED_ENGINE_ROOT: aliasEngine },
    platform: 'win32',
    currentUserHome: 'C:\\Users\\ToolsEnabled-Dev',
    resolveTrustedAlias: () => aliasRoot,
    filesystem: {
      lstatSync: () => ({ isSymbolicLink: () => false }),
      readlinkSync: () => { throw new Error('an ordinary short path is not a link') },
    },
    readStore(store) {
      assert.equal(store, path.join(aliasEngine, 'state', 'owner-public-prompts.json'))
      return JSON.stringify({ prompts: [] })
    },
  })
  assert.deepEqual(aliasResult, { readable: true, prompts: 0, purchaseBatches: 0 },
    'the same trusted current-profile alias must survive lexical, link-target, and canonical checks')

  const externalRoot = 'C:\\agent-apps\\engine'
  const external = engineQueueCount({
    environment: { TOOLSENABLED_ENGINE_ROOT: externalRoot },
    platform: 'win32',
    currentUserHome: 'C:\\Users\\ToolsEnabled-Dev',
    readStore(store) {
      reads += 1
      assert.equal(store, path.join(externalRoot, 'state', 'owner-public-prompts.json'))
      return JSON.stringify({ prompts: [{ kind: 'purchase_batch' }, { kind: 'question' }] })
    },
  })
  assert.deepEqual(external, { readable: true, prompts: 2, purchaseBatches: 1 },
    'legitimate non-profile engine roots remain available as diagnostics')

  const unreadable = engineQueueCount({
    environment: { TOOLSENABLED_ENGINE_ROOT: externalRoot },
    platform: 'win32',
    currentUserHome: 'C:\\Users\\ToolsEnabled-Dev',
    readStore() { throw new Error(`native failure leaked ${foreignRoot}`) },
  })
  assert.equal(unreadable.readable, false)
  assert.equal(unreadable.reason.includes(foreignRoot), false)
  assert.equal(unreadable.reason.includes('native failure'), false,
    'filesystem and JSON failures must return path-free diagnostic copy')
})

test('7b. a driver that could not measure is neither a pass nor a product failure', async () => {
  const { UNMEASURABLE_MARK } = await import('../machine-steadiness.mjs')
  const declared = `${UNMEASURABLE_MARK} This computer's speed changed by about 8.3 times while the test ran.\n`

  /* It outranks the exit code in BOTH directions. Blaming the product for the
     machine's weather is how the account failure spent three days attributed to
     DPAPI; calling it green hides that nothing was measured. */
  assert.equal(verdictFor({ timedOut: false, code: 1, output: `${declared}4 of 9 checks failed\n` }), 'INCONCLUSIVE',
    'a budget missed on an unmeasurable machine must not be reported as a product failure')
  assert.equal(verdictFor({ timedOut: false, code: 0, output: `${declared}9/9 checks passed\n` }), 'INCONCLUSIVE',
    'and a green on an unmeasurable machine must not be believed either')

  /* A timeout is still decided first: a driver killed at its ceiling produced
     no result at all, whatever it managed to print before it died. */
  assert.equal(verdictFor({ timedOut: true, code: 0, output: declared }), 'TIMEOUT')

  /* And the mark must be the module's, not a copy that can drift out of step. */
  assert.match(runnerSource, /import \{ UNMEASURABLE_MARK \} from '\.\/machine-steadiness\.mjs'/,
    'the suite must import the mark rather than restate it')
})

test('8. a non-PASS verdict of any kind fails the suite, so INCONCLUSIVE cannot be a quiet green', () => {
  assert.match(runnerSource, /results\.filter\(result => result\.verdict !== 'PASS'\)/,
    'the suite must count anything that is not a PASS as a failure; an allowlist of tolerated verdicts is how ' +
    'INCONCLUSIVE would become the new exit-0')
})

/* require() for the CommonJS product module, from an ESM suite. */
import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)

/* Exit 3 is a driver's explicit "not exercised" verdict. The summary must name
   it accurately rather than relabel it as a product assertion failure, while
   test 8 still requires every non-PASS verdict to fail the release suite. */
test('9. a driver that names the checks it could not exercise is not a product failure', () => {
  const honest = [
    '  ok    the page offers a way to start',
    '  ....  the node becomes THAT session  -- NOT EXERCISED: window.mcAgent is a non-configurable contextBridge property',
    '  ....  a node that started looks like it is running  -- NOT EXERCISED: window.mcAgent is a non-configurable contextBridge property',
    '',
    '32/34 checks passed in 42.2s',
    '  NOT EXERCISED: the node becomes THAT session  -- window.mcAgent is a non-configurable contextBridge property',
    '  NOT EXERCISED: a node that started looks like it is running  -- window.mcAgent is a non-configurable contextBridge property',
    '',
  ].join('\n')
  assert.equal(verdictFor({ timedOut: false, code: 3, output: honest }), 'INCONCLUSIVE',
    'checks the driver honestly declared it could not exercise must not read as a product failure')

  /* THE RULE MUST NOT BECOME A LAUNDRY. A real failure alongside a
     not-exercised check is still a failure, and the arithmetic has to close:
     passed + not-exercised must account for the whole roster, or something
     unexplained is missing and the honest answer is not "fine". */
  const withRealFailure = [
    '  ok    one',
    '  FAIL  two  -- it really broke',
    '  ....  three  -- NOT EXERCISED: cannot be substituted from the page',
    '',
    '1/3 checks passed in 1.0s',
    '  NOT EXERCISED: three  -- cannot be substituted from the page',
  ].join('\n')
  assert.equal(verdictFor({ timedOut: false, code: 3, output: withRealFailure }), 'FAIL',
    'a genuine failure beside a not-exercised check must still fail')

  const arithmeticDoesNotClose = [
    '  ok    one',
    '  ....  two  -- NOT EXERCISED: cannot be substituted from the page',
    '',
    '1/4 checks passed in 1.0s',
    '  NOT EXERCISED: two  -- cannot be substituted from the page',
  ].join('\n')
  assert.equal(verdictFor({ timedOut: false, code: 3, output: arithmeticDoesNotClose }), 'FAIL',
    'two checks are unaccounted for, so the not-exercised story does not explain the gap')

  /* And a nonzero exit with no such declaration is untouched. */
  assert.equal(verdictFor({ timedOut: false, code: 3, output: '  ok  one\n1/1 checks passed\n' }), 'FAIL',
    'exit 3 without a declared not-exercised check is still a failure')
})

/* A timeout is the only verdict here derived from SILENCE rather than from
   something the driver said, and "it did not finish" has two causes the gate
   cannot separate from one observation. Measured 2026-08-18:
   example-page-write-fence-qa timed out at 600.5s at its live-mode launch and
   then passed 24/24 in 217s on an immediate re-run, with another driver still
   running. This pins the retry, and pins that it can never manufacture a pass. */
test('10. a timeout is re-run only after proved cleanup, and a second-ask result is never called green', () => {
  assert.match(runnerSource, /if \(mayRetryQaDriver\(result\)\)[\s\S]{0,400}?await runDriver\(entry, environment, \{ attempt: 2 \}\)/,
    'only a timeout with confirmed descendant cleanup may be re-run')
  assert.match(runnerSource, /if \(result\.cleanupUnconfirmed\) \{[\s\S]{0,400}?break/,
    'unconfirmed cleanup must stop subsequent drivers as well as retries')
  /* The retry's own verdict is what survives when it times out again... */
  assert.match(runnerSource, /if \(retry\.verdict === 'TIMEOUT'\)/,
    'the second timeout must be reported as a timeout')
  /* ...and a retry that finished is recorded as INCONCLUSIVE, never PASS. The
     assertion is on the literal, because this is the line that would quietly
     turn a flake green if someone "simplified" it. */
  assert.match(runnerSource, /verdict: 'INCONCLUSIVE',[\s\S]{0,200}?timed out at/,
    'a driver that passed only on re-run must be INCONCLUSIVE with both facts, never PASS')
  assert.ok(!/verdict: 'PASS'/.test(runnerSource),
    'nothing in the runner may assign PASS directly; it comes from verdictFor reading the driver\'s own words')
})

/* ============================================================================
 * 11-14. NO DRIVER MAY EVER BE SILENTLY UNSEEN AGAIN.
 *
 * WHAT WENT WRONG, MEASURED 2026-08-23. DRIVER_PATTERN read `-qa.(mjs|cjs)` and
 * nothing else. Twenty-eight harnesses in tools/ are named `*-drive.mjs`, so
 * they were not excluded with a reason, not reported, and not counted as
 * skipped -- they were never SEEN. 52 discovered, 28 invisible, every gate
 * green. Two of the invisible ones are the only drivers that exercise getting
 * an assistant program and signing in to it, which is the first thing a
 * customer does; the owner found the hole by being told by his own product that
 * the two programs he had installed and signed into were not installed.
 *
 * Every test above this line stayed green throughout, INCLUDING test 2, because
 * its independent second opinion happened to spell the pattern the same wrong
 * way. So the tests below are not about the fix. They are about the class: a
 * naming family the runner has never heard of must fail something.
 * ==========================================================================*/

test('11. discovery reads both naming families, and the plan covers every driver on disk', () => {
  assert.match('example-drive.mjs', DRIVER_PATTERN, 'the `-drive` family must be discovered')
  assert.match('example-qa.mjs', DRIVER_PATTERN, 'the `-qa` family must still be discovered')
  assert.match('example-drive.cjs', DRIVER_PATTERN, 'both extensions, in both families')
  assert.match('example-qa.cjs', DRIVER_PATTERN)
  assert.ok(!DRIVER_PATTERN.test('example-drive.js'), 'the extension is still part of the convention')
  assert.ok(!DRIVER_PATTERN.test('packaged-qa-suite.mjs'), 'the suite itself is not one of its own drivers')

  /* And it is not a claim about the expression -- it is a claim about the
     directory. The `-drive` family must actually be in the plan. */
  const plan = planned()
  const byFamily = suffix => plan.filter(entry => entry.name.endsWith(suffix)).length
  assert.ok(byFamily('-drive.mjs') > 0, 'not one `-drive` harness reached the plan')
  assert.ok(byFamily('-qa.mjs') > 0, 'not one `-qa` harness reached the plan')
  assert.equal(plan.length, driversOnDisk().length,
    'the plan and the directory must agree; they disagreed silently for as long as the pattern knew one suffix')
})

test('12. every driver-shaped file under tools/ is discovered or held out in writing', () => {
  const audit = auditDrivers()
  assert.deepEqual(audit.unseen, [],
    'these files look like QA drivers and are reached by nothing:\n' +
    audit.unseen.map(entry => `  ${entry.file} -- ${entry.why}`).join('\n'))
  assert.deepEqual(audit.contradictions, [],
    'held out of discovery AND discovered by the pattern; a reader cannot tell which claim is wrong')
  assert.deepEqual(audit.staleSettings, [], 'settings name a driver that is not on disk')
  assert.deepEqual(audit.staleHoldOuts, [], 'a hold-out names a file that is not on disk')
  assert.ok(audit.shaped.length > audit.discovered.length,
    'the guard must look at a WIDER set than the pattern does, or it is a restatement of the thing it checks')
})

/* 12b. THE MUTATION, RUN RATHER THAN DESCRIBED. A guard is only worth its line
   count if it can be shown going red, so this builds a directory holding two
   plausible new drivers whose names the pattern does not reach -- one caught by
   its suffix, one caught only by what it imports -- and requires both to be
   named. Then the same directory with only a properly-named driver in it must
   come back clean, because a guard that fails on everything is not a guard. */
test('12b. a plausible new driver the pattern cannot see makes the guard go red, by name', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'driver-discovery-mutation-'))
  try {
    writeFileSync(path.join(scratch, 'installer-flow-driver.mjs'), 'console.log(1)\n')
    writeFileSync(path.join(scratch, 'first-run-exercise.mjs'),
      "import { openWindow } from './test-account-harness.mjs'\nconsole.log(openWindow)\n")
    writeFileSync(path.join(scratch, 'already-fine-qa.mjs'), 'console.log(3)\n')

    const red = auditDrivers(scratch)
    const named = red.unseen.map(entry => entry.name).sort()
    assert.deepEqual(named, ['first-run-exercise.mjs', 'installer-flow-driver.mjs'],
      'both shapes must be caught: a driver suffix the pattern does not know, and a name that says nothing at all')
    assert.match(red.unseen.find(entry => entry.name === 'first-run-exercise.mjs').why, /test-account-harness/,
      'the content signal must say what it saw, or nobody can act on it')

    rmSync(path.join(scratch, 'installer-flow-driver.mjs'))
    rmSync(path.join(scratch, 'first-run-exercise.mjs'))
    assert.deepEqual(auditDrivers(scratch).unseen, [],
      'a directory whose drivers all match the convention must come back clean; a guard that never goes green gets deleted')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('12c. the two questions the guard asks are both live', () => {
  assert.ok(looksLikeADriver('some-new-driver.mjs', 'console.log(1)'), 'the name family must be wider than DRIVER_PATTERN')
  assert.ok(looksLikeADriver('anything-at-all.mjs', "import { stage } from './test-account-harness.mjs'"),
    'a file that stages the packaged build is a driver whatever it is called')
  assert.equal(looksLikeADriver('gen-fleet.mjs', 'console.log(1)'), null, 'an ordinary generator is not a driver')
  /* THE FALSE RED THIS RULE WOULD OTHERWISE MANUFACTURE: several files in
     tools/, including the suite's own header, discuss the harness in prose. An
     instrument that cannot tell code from prose gets switched off. */
  assert.equal(looksLikeADriver('notes.mjs', '/* see tools/test-account-harness.mjs for the rig */\nconsole.log(1)'), null,
    'a comment mentioning the harness is not an import of it')
  assert.equal(looksLikeADriver('notes.mjs', "// './test-account-harness.mjs' owns staging\nconsole.log(1)"), null)
})

test('13. an excluded driver is never run, and it is never merely absent either', () => {
  const excluded = planned().filter(entry => entry.excluded)
  assert.ok(excluded.length > 0, 'this test measures nothing if nothing is excluded')
  for (const entry of excluded) {
    assert.equal(typeof entry.excluded, 'string')
    assert.ok(entry.excluded.length > 20, `${entry.key}'s exclusion must be a reason, not a shrug`)
    assert.ok(entry.registered, `${entry.key} can only be excluded by a SETTINGS entry somebody wrote`)
  }
  /* Ask the command itself rather than requiring one spelling of its filters
     and reporting loops. --only is also the safe, observable proof that an
     excluded entry cannot leak through --include-costly into execution. */
  const excludedEntry = excluded[0]
  const result = spawnSync(process.execPath, [RUNNER, '--only', excludedEntry.name, '--include-costly'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.status, 2,
    `an explicitly requested excluded driver must be refused before execution; stderr: ${result.stderr}`)
  assert.match(result.stderr, new RegExp(excludedEntry.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the refusal must name the excluded driver')
  assert.match(result.stderr, new RegExp(excludedEntry.excluded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the refusal must print the written reason, not make the driver merely absent')
})

test('14. the hold-out map is a set of reasons, and it does not overlap the plan', () => {
  assert.ok(HELD_OUT_OF_DISCOVERY.size > 0, 'the map is the written record of what discovery deliberately misses')
  for (const [name, why] of HELD_OUT_OF_DISCOVERY) {
    assert.match(name, /\.(mjs|cjs|ps1)$/, `${name} must be a script path`)
    assert.equal(path.isAbsolute(name), false, `${name} must be tools-relative`)
    assert.equal(name.includes('\\'), false, `${name} must use forward slashes`)
    assert.ok(name.split('/').every(part => part && part !== '.' && part !== '..'),
      `${name} must name one exact normalized path`)
    assert.ok(typeof why === 'string' && why.length > 20, `${name} must carry a reason a person can act on`)
    assert.ok(!DRIVER_PATTERN.test(name),
      `${name} is held out of discovery, yet the pattern reaches it -- the suite would run it anyway`)
  }
  assert.deepEqual(staleHoldOuts(), [], 'a hold-out naming a file that is gone is a reason nobody can act on')
  /* Registration is a separate question from discovery, and this pins that the
     suite still answers it the old way: settings are settings, never
     membership. See 3b -- an unregistered driver still runs. */
  assert.ok(registeredNames().length > 0)
  for (const name of registeredNames()) {
    assert.ok(!HELD_OUT_OF_DISCOVERY.has(name), `${name} cannot be both configured to run and held out of reach`)
  }
})

test('15. synthetic NSIS upgrade coverage stays discovered without claiming exact-candidate installation', () => {
  const driverName = 'nsis-upgrade-roundtrip-qa.mjs'
  const powershellName = 'nsis-upgrade-roundtrip.ps1'
  const entry = planned().find(candidate => candidate.name === driverName)

  assert.ok(entry, 'the packaged QA plan does not reach the NSIS upgrade roundtrip')
  assert.equal(entry.registered, true)
  assert.equal(entry.runner, 'node')
  assert.equal(entry.excluded, null)
  assert.equal(entry.costly, false, 'the isolated installer gate spends no provider budget and must run on every cut')
  assert.equal(entry.artifactProof, 'instrumented-copy',
    'the roundtrip builds isolated product identities instead of installing the candidate')

  const audit = auditDrivers()
  const powershell = audit.shaped.find(candidate => candidate.name === powershellName)
  assert.ok(powershell, 'the discovery guard filtered PowerShell before asking whether it is reachable')
  assert.deepEqual(powershell.delegatedBy, [driverName])
  assert.equal(audit.unseen.some(candidate => candidate.name === powershellName), false)

  assert.equal(packageJson.scripts?.['qa:nsis-upgrade'], `node tools/${driverName}`)
  assert.match(
    packageJson.scripts?.['release:cut'] || '',
    /node tools\/release-packager\/cut-release-candidate\.mjs/,
    'release:cut must invoke the isolated cutter that owns the exact-candidate gate',
  )

  // Cutter qualification/tag ordering has its own behavioral tests. A source
  // spelling or the name of this synthetic driver cannot prove installation.
})

test('the unattended packaged gate runs only the provider-free half of home activity', () => {
  const entry = planFor(discoverDrivers()).find(item => item.name === 'home-activity-substance-qa.mjs')
  assert.ok(entry, 'home activity vanished from packaged-driver discovery')
  assert.equal(entry.costly, false, 'the signed recorded flow should remain in every cut')
  assert.deepEqual(entry.needs, ['--recorded-only'],
    'an unattended cut can copy a real Claude sign-in and spend provider budget')
})

test('the unattended packaged gate runs only the provider-free half of the palette drive', () => {
  const entry = planFor(discoverDrivers()).find(item => item.name === 'palette-keyboard-qa.mjs')
  assert.ok(entry, 'palette keyboard QA vanished from packaged-driver discovery')
  assert.equal(entry.costly, false, 'the seeded keyboard flow should remain in every cut')
  assert.deepEqual(entry.needs, ['--seeded-only'],
    'an unattended cut can copy a real Claude sign-in and start a paid palette session')
})

test('the unattended recommended-path gate selects both provider-free scenarios and never steering', () => {
  const entry = planFor(discoverDrivers()).find(item => item.name === 'recommended-path-packaged-qa.mjs')
  assert.ok(entry, 'recommended-path QA vanished from packaged-driver discovery')
  assert.equal(entry.registered, true)
  assert.equal(entry.costly, false, 'both non-steering paths belong in every release cut')
  assert.deepEqual(entry.needs, ['--scenario', PROVIDER_FREE_SCENARIO])
  assert.deepEqual(selectedScenarios(), ['recommended', 'observe'],
    'running the driver without arguments must also be provider-free')
  assert.deepEqual(selectedScenarios(PROVIDER_FREE_SCENARIO), ['recommended', 'observe'])
  assert.equal(selectedScenarios(PROVIDER_FREE_SCENARIO).includes('steering'), false,
    'the release registry must not make a signed-in provider turn')
  assert.deepEqual(selectedScenarios('steering'), ['steering'],
    'steering remains available only when a person explicitly names it')
})

test('provider-free UI refusal and positive API Start proof have explicit, honest dispositions', () => {
  const entries = new Map(planFor(discoverDrivers()).map(entry => [entry.name, entry]))
  const ui = entries.get('agent-start-flow-qa.mjs')
  const local = entries.get('agent-really-starts-qa.mjs')
  const dispatch = entries.get('agent-dispatch-packaged-qa.mjs')
  const refusal = entries.get('refusal-copy-qa.mjs')

  for (const [name, entry] of Object.entries({
    'agent-start-flow-qa.mjs': ui,
    'agent-really-starts-qa.mjs': local,
    'agent-dispatch-packaged-qa.mjs': dispatch,
    'refusal-copy-qa.mjs': refusal,
  })) {
    assert.ok(entry, `${name} vanished from packaged-driver discovery`)
    assert.equal(entry.registered, true, `${name} has no explicit provider-free disposition`)
    assert.deepEqual(entry.needs, [])
  }

  assert.equal(ui.excluded, null, 'the providerless UI readiness/refusal gate must run on every cut')
  assert.equal(ui.costly, false)
  assert.equal(ui.artifactProof, 'instrumented-copy', 'the UI refusal lane overlays source files')
  assert.equal(local.excluded, null, 'the maintained Local native launcher has a positive journey')
  assert.equal(local.costly, true, 'real Local inference must retain explicit native/model budget opt-in')
  assert.equal(local.artifactProof, 'exact-candidate', 'Local success cannot be claimed from source overlays')
  const localSource = readFileSync(local.file, 'utf8')
  assert.match(localSource, /--run-local-inference/)
  assert.match(localSource, /--local-model/)
  assert.match(localSource, /installerQualification: false/)
  assert.equal(dispatch.excluded, null, 'the positive built-in API launch proof must remain required')
  assert.equal(dispatch.costly, false, 'the deterministic mission-bridge API gate spends no provider budget')
  assert.equal(dispatch.artifactProof, 'instrumented-copy',
    'the API gate rewrites loopback runtime ports and must not be counted as exact-artifact proof')
  assert.equal(refusal.excluded, null)
  assert.equal(refusal.costly, false)
  assert.equal(entries.get('refusal-copy-qa.mjs')?.artifactProof, 'instrumented-copy',
    'the refusal driver replaces the packaged renderer and shell with source files')
  assert.match(runnerSource, /TOOLSENABLED_QA_STAGE_MODE = 'exact-release'/,
    'an explicit suite release must select exact staging even for implicit-default shared callers')
})
