#!/usr/bin/env node

// THE PACKAGED-WINDOW QA DRIVERS, RUN BY SOMETHING OTHER THAN A PERSON.
//
// WHAT WAS MEASURED BEFORE THIS FILE EXISTED. This tree carries thirteen
// harnesses that drive the real packaged application and read what is on the
// glass. Grepped against every automated entry point in package.json --
// `test`, `test:data`, `dist`, `release:cut`, `verify` -- NOT ONE of them was
// invoked. Seven had an `npm run qa:*` alias, which is a thing a person types,
// and six had not even that. The defects they were each written for --
// the operator's purchase list shipped to strangers, an agent page nothing
// routed to, a Recommended answer that led to an installation with no control
// that starts anything, dead steering controls, and a page that printed
// "nothing here is real" over an enabled button that spawned a real session --
// are exactly the class of defect that a source test cannot see and that these
// harnesses do see. They were all found by a person running one by hand.
//
// So this is the automated path. It is deliberately NOT a `node --test` suite:
// each driver owns a real Electron process, a staged copy of the packaged
// build, real wall-clock waits and its own teardown, and the test runner's
// concurrency and reporting would fight all four.
//
// FOUR RULES THIS FILE ENFORCES ON ITSELF.
//
// 1. DISCOVERY, NEVER A LIST. Membership is a glob over tools/ for the naming
//    conventions these files already follow. A hand-written list is the defect
//    this repo has already been bitten by (a list of 11 stood in for a glob
//    over 26), and self-selected coverage cannot fail. A driver added tomorrow
//    is picked up with no edit here.
//
//    A GLOB IS ALSO A LIST WHEN IT KNOWS ONE SPELLING (measured 2026-08-23).
//    The pattern read `-qa.(mjs|cjs)` and nothing else, so the twenty-eight
//    harnesses named `*-drive.mjs` were not excluded with a reason, not
//    reported, and not counted: they were never SEEN. 52 discovered, 28
//    invisible. Two of the invisible ones -- provider-login-drive and
//    provider-guide-drive -- are the only drivers that exercise getting an
//    assistant program and signing in to it, which is the first thing a
//    customer does, so no cut had ever checked it. The owner found out the way
//    customers do: a machine with Codex and Claude installed and signed in,
//    told by the product that they were not installed and to go and install
//    them. The pattern now reads both suffixes, and
//    tools/check-drivers-discovered.mjs is what stops a THIRD spelling being
//    invisible -- a file in tools/ that looks like a driver and is neither
//    discovered nor deliberately held out fails that guard by name.
//
// 2. NOTHING IS SKIPPED SILENTLY. Zero drivers discovered is an ERROR, not a
//    pass -- the same rule tools/check-suites-discovered.mjs applies to the
//    unit suites. A driver this file has no per-driver settings for still RUNS,
//    on defaults, and is reported as unregistered; it is never dropped.
//
//    2b. A DRIVER THAT CANNOT RUN UNATTENDED IS HELD OUT IN WRITING, NEVER
//    DROPPED. `excluded: '<reason>'` keeps the driver in the plan, prints it in
//    --list with its reason, prints it in the closing table, and refuses
//    --only for it with the same reason. Absence would be indistinguishable
//    from the defect above; a loud EXCLUDED line is not.
//
// 3. A TIMEOUT IS NOT A PASS AND NOT A SKIP. It is TIMEOUT, it is counted with
//    the failures, and the process tree is reaped before the next driver starts.
//
// 4. NO WINDOW, NO CONSOLE, NO STOLEN FOCUS. Every child is spawned with
//    windowsHide, and MC_SMOKE_HEADLESS=1 is put in the environment the drivers
//    inherit and pass to the packaged app, which is what actually keeps the
//    BrowserWindow off the owner's desktop (shell/window-options.cjs).
//    windowsHide alone would not: it only suppresses a console.
//
//    AND HIDING A WINDOW IS NOT THE SAME AS PROVING WHAT IT SHOWED (2026-08-23).
//    shell/window-options.cjs answers MC_SMOKE_HEADLESS=1 with `{ show: false }`
//    and nothing else, which is right for the packaged app -- the smoke gate
//    reads its ports and its DOM, not its pixels. It is NOT enough for a driver
//    that photographs the product: a hidden window can hand back the last frame
//    it painted, which is how a screenshot named theme-tan came to show the
//    white theme beside a correct assertion. The two drivers that read pixels --
//    preview-browser-drive and subscribe-page-drive -- therefore render
//    OFFSCREEN under the same variable and assert every capture against a
//    freshness probe (tools/lib/capture-evidence.mjs). A driver that captures
//    evidence may only run here if a lying capture would FAIL it; that is the
//    condition on which those two came out of the exclusion list below, and
//    tools/test/packaged-qa-suite.test.mjs holds the next one to it.
//
// USAGE
//   node tools/packaged-qa-suite.mjs                 every free driver
//   node tools/packaged-qa-suite.mjs --list          what would run, and why
//   node tools/packaged-qa-suite.mjs --only home-screen-qa,page2-qa
//   node tools/packaged-qa-suite.mjs --include-costly    also the ones that
//                                                       spend provider budget
//   node tools/packaged-qa-suite.mjs --visible      show the windows (debugging)
//   node tools/packaged-qa-suite.mjs --release <dir>     borrow another build
//   node tools/packaged-qa-suite.mjs --logs <dir>        keep the per-driver logs
//
// Exit code is 0 only when every driver that ran passed.

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { UNMEASURABLE_MARK } from './machine-steadiness.mjs'
import {
  defaultReleaseDirectory,
  packagedLauncherName,
  packagedLauncherPresent,
  packagedLaunchReadiness,
  unpackedDirectoryName,
} from './lib/packaged-platform.mjs'
import { runQaDriverProcess, mayRetryQaDriver } from './lib/qa-driver-process.mjs'
import { platformSkipReason } from './lib/test-suite-result.mjs'
import {
  assertSharedHostQualificationAllowed,
  filterForeignWindowsProfilePath,
  prepareSterileProfile,
  sterileLaunchEnvironment,
  sterileProfileDirectories,
} from './lib/sterile-launch.cjs'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')
/* The artifact THIS host's build produces. A literal `release/win-unpacked`
   stood here on every platform, which is why the Linux cutter's step 54 could
   only ever have refused. tools/lib/packaged-platform.mjs is the one place
   either platform's unpacked-directory name is spelled. */
const DEFAULT_RELEASE = defaultReleaseDirectory(REPO_ROOT)
const require_ = createRequire(import.meta.url)

/* The naming conventions, in one place. Both extensions, because several of
   these harnesses are Electron main-process scripts and must stay .cjs.

   BOTH SUFFIXES, because both are in use and only one was being read. `-qa` is
   the older family; `-drive` is what every harness written since has been
   called (28 of them on 2026-08-23). Renaming twenty-eight files to fit a
   pattern would break every reference to them in comments, reports and sibling
   drivers; the pattern is the thing that was wrong, so the pattern is what
   changed. */
export const DRIVER_PATTERN = /-(qa|drive)\.(mjs|cjs)$/

/* Node-mode drivers run code before they build a sterile GUI environment. A
 * stale PATH entry naming another Windows profile must therefore be removed at
 * the suite boundary, before provider discovery or any other driver setup can
 * inspect it. This keeps every legitimate external/owned tool location. */
export function accountFencedDriverEnvironment(base = process.env, pathOptions = {}) {
  const environment = { ...base }
  for (const name of Object.keys(environment)) {
    if (/^path$/i.test(name)) {
      environment[name] = filterForeignWindowsProfilePath(environment[name], pathOptions)
    }
  }
  return environment
}

export function assertQaSelectionHost(entries, environment = process.env) {
  if (entries.some(entry => entry.costly)) assertSharedHostQualificationAllowed(environment)
}

function argument(name, fallback = null) {
  const inline = process.argv.find(value => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback)
}

function requiredPathArgument(name) {
  const occurrences = process.argv
    .map((value, index) => value === name || value.startsWith(`${name}=`) ? index : -1)
    .filter(index => index >= 0)
  if (occurrences.length === 0) return null
  if (occurrences.length !== 1) throw new Error(`${name} accepts exactly one path`)
  const index = occurrences[0]
  const token = process.argv[index]
  const value = token === name ? process.argv[index + 1] : token.slice(name.length + 1)
  if (typeof value !== 'string' || value.length === 0 || (token === name && value.startsWith('--'))) {
    throw new Error(`${name} requires one path`)
  }
  return value
}

const LIST_ONLY = process.argv.includes('--list')
const INCLUDE_COSTLY = process.argv.includes('--include-costly')
const VISIBLE = process.argv.includes('--visible')
const ONLY = (argument('--only') || '').split(',').map(value => value.trim()).filter(Boolean)
const RELEASE = requiredPathArgument('--release')
/* LOGS GO OUTSIDE THE REPOSITORY BY DEFAULT, and that is not tidiness.
 *
 * `npm run dist` runs tools/require-clean-tree.mjs, which REFUSES to build from
 * a tree with uncommitted files -- an untracked byte was never a release
 * candidate. artifacts/ is ignored now, which means logs written there could
 * silently persist beside source while the clean-tree gate still passed. The
 * default is therefore a per-run directory under the OS temp dir, and
 * `--logs <dir>` puts them wherever an operator actually wants them. */
const LOG_DIR = path.resolve(argument('--logs') || path.join(tmpdir(), 'packaged-qa-logs'))

/* ---------- per-driver settings ----------
 *
 * These are SETTINGS, not membership. A driver absent from this map still runs;
 * it just runs on the defaults and is flagged so somebody records what it needs.
 * An entry here naming a file that no longer exists is a stale setting and is
 * reported as such -- both directions are checked, because a registry that can
 * only be wrong in one direction rots in the other.
 *
 *   runner       'node' (default) | 'electron' -- Electron main-process scripts
 *                cannot run under node, they need the Electron binary.
 *   timeoutMs    hard ceiling for one driver. Generous: several of these stage a
 *                full copy of a 225 MB packaged build before they start.
 *   costly       true = spends real provider budget or needs the public network.
 *                Held back unless --include-costly. Loud in --list either way.
 *                It is a statement about MONEY, never a place to put a driver
 *                nobody wanted to think about.
 *   excluded     a sentence saying why this driver cannot run unattended at
 *                all. It is never run, not even under --include-costly, and it
 *                is printed with its reason in --list and in the closing table
 *                so that holding it out costs a paragraph rather than a
 *                silence.
 *   requiredPlatform  'win32' -- the only conditional hold-out, for a driver
 *                whose SUBJECT is a Windows-only OS construct: an NSIS
 *                installer behaviour, a registry key, a Windows ACL, a
 *                PowerShell-only measurement. It runs normally on that
 *                platform and is a NAMED SKIP everywhere else, with
 *                platformReason saying what the Windows-only subject is. The
 *                convention is the one RELEASE_SKIP_REGISTER already uses for
 *                the ~82 `requiredPlatform: "win32"` unit tests, down to
 *                borrowing its platformSkipReason() sentence, so a reader of
 *                either gate reads the same words.
 *                IT IS NOT A PLACE TO PUT A DRIVER THAT IS MERELY UNPORTED. A
 *                driver that could measure the product on Linux and does not
 *                yet is a FAILURE and must read as one; a named skip is for a
 *                check that has no subject here at all.
 *   platformReason  the sentence that justifies requiredPlatform. Required
 *                with it: check-drivers-discovered and the suite's own guard
 *                refuse one without the other.
 *   needs        extra argv the driver requires to be runnable at all.
 *   artifactProof 'unclassified' (default) | 'exact-candidate' |
 *                'instrumented-copy'. Only an explicitly reviewed exact scope
 *                can count as untouched-artifact proof. Functional QA success
 *                is not a final release-readiness qualification.
 */
const SETTINGS = new Map([
  /* The provider-free keyboard lane keeps every assistant home sterile and
     never presses Start. The companion live-start driver below explicitly owns
     the real current-account sign-in, prompt, Start and Stop. Both repack a
     scratch app.asar with this checkout's dist/shell, so neither is proof that
     the candidate's untouched bytes ran. */
  ['a11y-keyboard-qa.mjs', {
    runner: 'node',
    timeoutMs: 900_000,
    artifactProof: 'instrumented-copy',
  }],
  ['account-cart-row-qa.mjs', {
    runner: 'node',
    timeoutMs: 600_000,
    artifactProof: 'exact-candidate',
  }],
  /* THE INSTALLER AND SIGN-IN FLOWS, RUN AT EVERY CUT.
   *
   * These two drivers existed and were in no chain, so the surface a person
   * meets FIRST -- get the assistant program, sign in to it -- was the one
   * surface no cut ever exercised. The owner found out the way customers do:
   * a machine with Codex and Claude installed and signed in, told by the
   * product that they were not installed and to go and install them.
   *
   * provider-login-drive stages the packaged build in three states a real
   * machine can be in -- program absent, present-and-signed-out, signed in --
   * and reads what the panel offers in each. It does NOT press Sign in: that
   * now opens a real terminal running a real sign-in, which is not a thing a
   * driver may start on somebody's machine.
   * provider-guide-drive checks the other half of the same promise: that each
   * program offers a button rather than a command to copy. */
  ['provider-login-drive.mjs', { runner: 'node', timeoutMs: 900_000 }],
  ['provider-guide-drive.mjs', { runner: 'node', timeoutMs: 600_000 }],

  /* ---- THE REST OF THE `-drive` FAMILY, CLASSIFIED ONE AT A TIME 2026-08-23.
   *
   * Widening DRIVER_PATTERN made twenty-eight files visible at once. Visible is
   * not the same as classified: an unregistered driver runs on the 900s default
   * with a derived runner, so widening alone would have put twenty-eight
   * unread harnesses into the next cut. Each was opened and read instead. Every
   * disposition below is the file's own header, quoted or paraphrased, and
   * tools/check-drivers-discovered.mjs is what stops the twenty-ninth being
   * added without one. */

  /* Free, measures the product, runs at every cut. */
  ['appearance-persistence-drive.mjs', { runner: 'node', timeoutMs: 600_000 }],
  /* Six scenarios of conversation survival against tools/test/fixtures/
     narrating-engine -- a real turn through the real host, no provider. */
  ['chat-history-drive.mjs', { runner: 'node', timeoutMs: 1_200_000, artifactProof: 'instrumented-copy' }],
  /* Three window widths, real windows, screenshots. `--real` would put a paid
     engine behind it and is NOT passed here; the default is the narrating
     fixture. `--out` is redirected out of the repository because its default,
     reports/context-window, holds TRACKED screenshots, and a gate that rewrote
     them would leave a dirty tree for the clean-tree check release:cut runs
     immediately after this suite. */
  ['context-window-drive.mjs', {
    runner: 'node',
    timeoutMs: 1_200_000,
    artifactProof: 'instrumented-copy',
    needs: ['--out', path.join(tmpdir(), 'packaged-qa-shots', 'context-window')],
  }],
  /* Its header says it is not a member of this suite because the glob could not
     see it. The glob can see it now, it costs nothing but time, and the four
     defects it drives (a dead permission control, a zombie session, a false
     sentence about Codex, a promise the start path did not keep) are all on the
     first surfaces a person meets. The unit suites that also cover them are
     source tests; this one presses the glass. */
  ['four-defects-drive.mjs', { runner: 'node', timeoutMs: 900_000 }],
  /* The recorded half is fixture-free but spends nothing: it writes signed
     run and turn ledgers with the product's own recorders, then reads them
     through the packaged window. The second half deliberately copies a real
     Claude sign-in and starts a paid turn. Keep that operator-only half out of
     an unattended cut by passing the driver's own --recorded-only fence. A
     person can still run the full file directly when provider spend is the
     thing they intend to measure. */
  ['home-activity-substance-qa.mjs', {
    runner: 'node',
    timeoutMs: 600_000,
    needs: ['--recorded-only'],
  }],
  /* Removal, driven against the fixture engine, including a restart. Its
     screenshots land in reports/node-remove-drive, which .gitignore already
     holds open for exactly this reason. */
  ['node-remove-drive.mjs', { runner: 'node', timeoutMs: 900_000, artifactProof: 'instrumented-copy' }],
  /* The order-dependent-visibility census: fleet, settings and walkthrough
     phases, with resizes. `--shots` is optional and is not passed, so it writes
     nothing into the tree. */
  ['order-variation-drive.mjs', { runner: 'node', timeoutMs: 1_200_000 }],
  /* Runs A and B only. Run C starts two real Codex sessions and spends real
     quota, and it is opt-in behind `--live-agent`, which this suite does not
     pass -- so the default run is providerless by construction (PATH cut to the
     Windows system directories, every home in scratch). The longest ceiling
     here: it opens windows at two sizes across three environments. */
  ['owner-walkthrough-drive.mjs', { runner: 'node', timeoutMs: 1_500_000 }],
  /* Like home activity, this driver has one provider-free half and one live
     half. Its default second profile copies a real Claude sign-in and starts a
     paid session. The unattended gate exercises the complete seeded keyboard
     contract and leaves the live-running palette check to an explicit manual
     invocation. */
  ['palette-keyboard-qa.mjs', {
    runner: 'node',
    timeoutMs: 900_000,
    needs: ['--seeded-only'],
  }],
  /* An inventory of both rail states at three widths. Its default output
     directory, reports/rail-inventory, holds TRACKED evidence, and
     cut-release-candidate requires `git status --porcelain` to be empty
     immediately after this suite runs -- so a gate re-running there would fail
     the cut on files the gate itself had just modified. `--out` was added to
     the driver for this and points at scratch here. Same for tree-panel-audit
     and context-window below. */
  ['rail-inventory-drive.mjs', {
    runner: 'node',
    timeoutMs: 900_000,
    needs: ['--out', path.join(tmpdir(), 'packaged-qa-shots', 'rail-inventory')],
  }],
  ['rail-lifecycle-drive.mjs', { runner: 'node', timeoutMs: 900_000, artifactProof: 'instrumented-copy' }],
  /* Four ways a session can end, including one that kills the app hard, read
     back out of the signed ledger. Fixture engine, real child process. */
  ['session-end-record-drive.mjs', { runner: 'node', timeoutMs: 900_000, artifactProof: 'instrumented-copy' }],
  ['settings-ia-drive.mjs', { runner: 'node', timeoutMs: 900_000 }],
  ['settings-truth-drive.mjs', { runner: 'node', timeoutMs: 600_000 }],
  /* Pure geometry: "IT SPENDS NOTHING. No agent is started." */
  ['tree-drag-drop-drive.mjs', { runner: 'node', timeoutMs: 600_000 }],
  /* Seven panel states plus two widths, against the narrating fixture. `--out`
     for the same tracked-evidence reason as rail-inventory above. */
  ['tree-panel-audit-drive.mjs', {
    runner: 'node',
    timeoutMs: 900_000,
    artifactProof: 'instrumented-copy',
    needs: ['--out', path.join(tmpdir(), 'packaged-qa-shots', 'tree-panel-audit')],
  }],

  /* ---- COSTLY: EACH ONE SAYS SO IN ITS OWN HEADER.
   *
   * Not one of these is marked costly to avoid reading it. Every entry below
   * either starts a real provider session or copies/junctions a real sign-in
   * and then asks a paid model a question. The quotes are the files' own. */
  /* "IT SPENDS REAL MONEY on the person's own Codex subscription." */
  ['agent-to-agent-tree-drive.mjs', { runner: 'node', timeoutMs: 1_200_000, costly: true }],
  /* The free a11y-keyboard-qa lane proves keyboard reachability and the
     disabled-state explanation without pressing Start. This companion first
     proves the empty-form refusal, then presses Start with a real prompt and
     stops the resulting real Codex session, using only the current account's
     Codex-home pointer. */
  ['a11y-keyboard-live-start-qa.mjs', {
    runner: 'node',
    timeoutMs: 900_000,
    costly: true,
    artifactProof: 'instrumented-copy',
  }],
  /* "IT MAY SPEND A LITTLE on the person's own subscription if the start is
     accepted" -- and the accepted start is the thing under test, so the spend
     is the pass condition rather than a risk. */
  ['compose-turn-it-on-drive.mjs', { runner: 'node', timeoutMs: 900_000, costly: true }],
  /* "IT SPENDS REAL MONEY on the person's own subscriptions." The last check
     before an installer is cut, and the one an operator should run by hand with
     --include-costly rather than have a gate spend for them. */
  ['cut-check-drive.mjs', { runner: 'node', timeoutMs: 1_500_000, costly: true }],
  /* Starts a real Claude session from inside the product and gives it real
     work -- the pass condition is a file the model had to compute and write. */
  ['inside-agents-drive.mjs', { runner: 'node', timeoutMs: 1_500_000, costly: true }],
  /* Copies this machine's real Codex sign-in into its scratch home and runs a
     real `luna` turn so the charts have something true to draw. */
  ['metrics-charts-live-drive.mjs', { runner: 'node', timeoutMs: 1_200_000, costly: true }],
  /* "a REAL Codex agent started from the tree ... and the metrics page read
     again. The numbers have to move." */
  ['metrics-live-record-drive.mjs', { runner: 'node', timeoutMs: 1_200_000, costly: true }],
  /* "IT SPENDS REAL MONEY on this computer's own Codex subscription." */
  ['request-contract-drive.mjs', { runner: 'node', timeoutMs: 1_200_000, costly: true }],
  /* "IT SPENDS REAL MONEY on the person's own subscription." */
  ['tree-manager-brief-drive.mjs', { runner: 'node', timeoutMs: 900_000, costly: true }],

  /* ---- THE WEBSITE AND THE PURCHASE SURFACE, RUN AT EVERY CUT SINCE
   * 2026-08-23. The fix the exclusion below them named was done rather than
   * deferred again.
   *
   * WHAT WAS TRUE UNTIL TODAY. These two were held out because they create
   * their BrowserWindow shown, on purpose: preview-browser-drive's header
   * records a run where a HIDDEN window produced green assertions beside lying
   * screenshots (capturePage returned the last painted frame; a file called
   * preview-1024-theme-tan.png showed the WHITE theme). Rule 4 of this file and
   * that measurement are both right, and the price of holding them apart was
   * that THE MONEY PATH HAD NO PRE-PUBLICATION CHECK AT ALL --
   * subscribe-page-drive is the only behavioural check of the purchase surface
   * in this repository.
   *
   * WHAT CHANGED, AND IT IS NOT "the window is hidden now". Hiding it is what
   * produced the lie. Under MC_SMOKE_HEADLESS=1 both drivers now render
   * OFFSCREEN (webPreferences.offscreen) -- a mode with its own frame sink that
   * paints on demand, already used by tools/ring-capture-main.cjs and
   * tools/home-visual-check.cjs to photograph this product with nothing on the
   * desktop -- and, far more importantly, NEITHER IS TRUSTED TO HAVE PAINTED.
   * Every capture carries a per-shot freshness probe from
   * tools/lib/capture-evidence.mjs and is compared against a point the page
   * itself nominates: a stale frame is named 'stale', an empty one 'blank', and
   * both are FAILED assertions written to disk under an UNTRUSTED name. A
   * capture that would have been a lie now fails the run.
   * tools/test/capture-evidence.test.mjs holds that rule from the other side --
   * it was written before the code and it fails against a deliberately blank
   * frame, a fresh probe over an empty frame, and a full frame from the
   * previous instant.
   *
   * Measured 2026-08-23 on Electron 43.3.0 before either was un-excluded:
   * offscreen captures stayed fresh through navigation, an in-place theme
   * change, a resize and a scroll; a deliberately blank page came back with ONE
   * distinct colour and was refused; real mouse input, elementFromPoint, Tab
   * traversal, typed characters, Space activation and the DevTools protocol all
   * work offscreen; one capture costs 231ms. The one thing that does NOT hold
   * offscreen is document.hasFocus(), which subscribe-page-drive asserted as a
   * proxy for "Tab presses can be believed" -- it now asserts the fact itself
   * from its own first Tab press. */
  ['preview-browser-drive.mjs', { runner: 'electron', timeoutMs: 900_000, artifactProof: 'instrumented-copy' }],
  ['subscribe-page-drive.mjs', { runner: 'electron', timeoutMs: 900_000, artifactProof: 'instrumented-copy' }],

  /* ---- EXCLUDED, EACH WITH THE SENTENCE THAT JUSTIFIES IT.
   *
   * Two files, two reasons, neither of them "it looked hard". Both print in
   * --list and in the closing table with the reason attached, because an
   * excluded driver that is merely absent is the defect at the top of this file
   * wearing a different hat. */
  /* It drives a website that something else has to be SERVING: STRANGER_BASE_URL
     defaults to http://localhost:4699 and this file starts no server of its
     own. Unattended it would navigate to a closed port and report findings
     about nothing -- and its own contract says a route finding is data rather
     than an exit code, so that run would be a quiet green. */
  ['website-stranger-drive.mjs', {
    runner: 'electron',
    timeoutMs: 600_000,
    excluded: 'it needs the built website already being served at STRANGER_BASE_URL (default '
      + 'http://localhost:4699) and starts no server itself; against a closed port it measures nothing and says so quietly',
  }],
  /* It installs release/ToolsEnabled Setup 1.0.20.exe -- a pinned installer
     filename, and release/ holds 1.0.27. It also says "IT SPENDS REAL MONEY on
     the person's own subscription" and kills a claude child mid-turn. Marking
     it costly would put a guaranteed red in the operator's --include-costly run
     for a harness reason rather than a product one, which is the shape this
     file already refuses elsewhere. */
  ['spine-defects-drive.mjs', {
    runner: 'node',
    timeoutMs: 1_500_000,
    excluded: 'it installs a pinned release/ToolsEnabled Setup 1.0.20.exe that is not on disk (release/ has 1.0.27), '
      + 'and it spends real provider budget; point it at the current installer and it can come back as costly',
  }],

  ['home-screen-qa.cjs', { runner: 'node', timeoutMs: 240_000 }],
  ['phone-sheet-geometry-qa.mjs', { runner: 'node', timeoutMs: 300_000, artifactProof: 'instrumented-copy' }],
  ['page2-qa.cjs', { runner: 'electron', timeoutMs: 300_000, artifactProof: 'instrumented-copy' }],
  /* Electron, because it measures LAYOUT: whether the panel's Start button and
     brief box are on screen when it opens. node --test cannot answer that -- a
     fake DOM has no layout, which is how 'there is no way to start an agent'
     survived two fixes and shipped twice. Even with --release, only the CSS
     comes from the candidate: it runs in handmade PANEL_HTML with fixture
     rail styles, not the packaged renderer. Without --release the CSS comes
     from checkout dist. Neither mode proves untouched-candidate UI behavior. */
  ['compose-start-layout-qa.cjs', { runner: 'electron', timeoutMs: 300_000, artifactProof: 'instrumented-copy' }],
  ['owner-popup-qa.cjs', { runner: 'electron', timeoutMs: 300_000, artifactProof: 'instrumented-copy' }],
  /* Electron, not node: it draws the purchase list in a real renderer under the
     real stylesheets, because the deadline's BOX is the thing under test and a
     fake DOM has no layout. It carries its own fixture cart, so it measures
     something whether or not the owner is deciding a purchase this hour. */
  ['purchase-cart-readable-qa.cjs', { runner: 'electron', timeoutMs: 300_000 }],
  ['checkout-privacy-packaged-qa.mjs', { runner: 'node', timeoutMs: 600_000, artifactProof: 'instrumented-copy' }],
  ['owner-account-packaged-qa.mjs', { runner: 'node', timeoutMs: 600_000, artifactProof: 'instrumented-copy' }],
  ['test-account-journey-qa.mjs', { runner: 'node', timeoutMs: 600_000 }],
  ['account-isolation-leak-qa.mjs', { runner: 'node', timeoutMs: 900_000 }],
  ['account-isolation-session-qa.mjs', { runner: 'node', timeoutMs: 900_000 }],
  ['team-panel-packaged-qa.mjs', { runner: 'node', timeoutMs: 600_000, artifactProof: 'instrumented-copy' }],
  ['loop-packaged-qa.mjs', { runner: 'node', timeoutMs: 900_000, artifactProof: 'instrumented-copy' }],
  ['example-page-write-fence-qa.mjs', { runner: 'node', timeoutMs: 600_000 }],
  /* Provider-free by construction: it cuts PATH to system directories before
     driving the refusal surfaces, so no installed agent CLI can be reached. */
  ['refusal-copy-qa.mjs', { runner: 'node', timeoutMs: 900_000, artifactProof: 'instrumented-copy' }],
  ['chatbox-settings-qa.mjs', { runner: 'node', timeoutMs: 900_000 }],
  ['agent-subpage-qa.mjs', { runner: 'node', timeoutMs: 1_200_000, artifactProof: 'instrumented-copy' }],
  ['setup-walkthrough-qa.mjs', { runner: 'node', timeoutMs: 900_000 }],
  /* The unattended release gate exercises both provider-free setup paths.
     Steering remains an explicit manual scenario because it starts a signed-in
     provider session. */
  ['recommended-path-packaged-qa.mjs', {
    runner: 'node',
    timeoutMs: 900_000,
    needs: ['--scenario', 'provider-free'],
  }],
  ['stranger-onboarding-qa.mjs', { runner: 'node', timeoutMs: 1_200_000 }],
  ['first-run-contract-qa.mjs', { runner: 'node', timeoutMs: 1_200_000 }],
  /* CAN A PERSON SEE WHY START IS UNAVAILABLE? Drives the fleet page on a fresh
     providerless profile, waits for the real tier/provider probes to settle,
     and requires disabled engine rows plus a disabled Start with plain-language
     reasons. It fills the brief but never presses Start, then proves the signed
     history and both launch-record shapes stayed unchanged. Its three controls
     still require the instrument to catch a missing, blocked, or code-only UI. */
  ['agent-start-flow-qa.mjs', { runner: 'node', timeoutMs: 300_000, artifactProof: 'instrumented-copy' }],
  /* A real Local model now has a shared native launcher. This positive
     journey requires a separately selected installed model and explicit local
     inference opt-in, in addition to the native/costly cohort opt-in. Missing
     prerequisites fail visibly; no fake loopback model or download is used. */
  ['agent-really-starts-qa.mjs', {
    runner: 'node', timeoutMs: 1_200_000, costly: true,
    artifactProof: 'exact-candidate',
  }],
  /* The research workbench, walked live on a fresh universe: supervised
     capability layer (with the CURRENT capability/ payload staged in), live
     page mount, account creation and sign-in, a project and a grid experiment
     through the page's own controls, and the research.pipeline settings gate
     refusing the submit AND the worker start by name. Spends nothing by
     construction: the gate holds every run in the isolated universe, which is
     precisely what it asserts. */
  ['research-walkthrough-qa.mjs', { runner: 'node', timeoutMs: 900_000 }],
  /* Google sign-in against a LOOPBACK test provider (never Google): stages the
     packaged window, plants a userData test-provider config, and drives the
     button through PKCE, id-token verification, account mint, and restart
     survival, plus the refusal lanes and cancelled-sign-in cleanliness. It
     spends nothing and touches no network by construction. This was the one
     flow a release could break with no gate noticing -- the shipped config
     carrier (config/google-signin.json) is enforced by check-asar-manifest,
     and THIS enforces that the machinery behind it still signs somebody in. */
  ['google-signin-packaged-qa.mjs', { runner: 'node', timeoutMs: 900_000 }],
  /* THE REQUIRED POSITIVE PROVIDER-FREE START GATE, and the only driver here
     that opens no window: it starts the shipped payload's own capability layer
     and POSTs real built-in mission-bridge dispatches to it. Measured at ~102s
     (twelve audited dispatches plus a second bridge for the negative control),
     so the ceiling is deliberately close rather than the 900s default -- this
     one hanging means a bridge did not come up, and waiting a quarter of an hour
     to be told that helps nobody. It spends no provider budget by construction;
     see the environment fence in its header. */
  ['agent-dispatch-packaged-qa.mjs', { runner: 'node', timeoutMs: 300_000, artifactProof: 'instrumented-copy' }],
  /* This discoverable wrapper delegates to the real PowerShell NSIS upgrade
     round trip. It builds and installs two isolated product identities, seeds
     the old layout, performs a genuine upgrade, and verifies the vault, signed
     ledger, and nested state survive byte-for-byte. It spends no provider
     budget. Those synthetic product identities are useful installer regression
     fixtures, not evidence that this exact candidate was installed. */
  /* THE ONE DRIVER IN THIS SUITE WHOSE SUBJECT DOES NOT EXIST ON LINUX, and it
     is registered as a named skip rather than left to go red for a reason that
     is not the product's. Its single check is an NSIS installer round trip --
     `powershell.exe -File tools/nsis-upgrade-roundtrip.ps1`, two synthetic
     Windows product identities, an upgrade over an existing install, and the
     registry key it must not leave behind (:32, :51, :100). There is no Linux
     NSIS. Off Windows the driver already refuses honestly, printing
     UNMEASURABLE_MARK, which this file's own verdictFor() correctly reads as
     INCONCLUSIVE -- and INCONCLUSIVE is a non-PASS, so on Linux this one file
     would turn every otherwise-green run red for a question Linux cannot be
     asked. The Linux answer to the same question is a different mechanism with
     its own proof and it is already in the Linux cut: dpkg identity, the
     installed-manifest produce/verify-binding pair, and the installed sealed
     smoke (LINUX-STEP-MAPPING.md D46, D51-D52, D56).
     This is the ONLY requiredPlatform entry, and adding a second one should be
     argued as hard as this one: a driver that could measure the product on
     Linux and does not yet is a FAILURE, not a skip. */
  ['nsis-upgrade-roundtrip-qa.mjs', {
    runner: 'node',
    timeoutMs: 600_000,
    artifactProof: 'instrumented-copy',
    requiredPlatform: 'win32',
    platformReason: 'its one check is the NSIS installer upgrade round trip, driven by '
      + 'powershell.exe -File tools/nsis-upgrade-roundtrip.ps1 over two synthetic Windows product identities, '
      + 'and asserts the registry key it must not leave behind. Linux ships a .deb, whose upgrade is proved by '
      + 'dpkg identity plus the installed-manifest binding and the installed sealed smoke in the Linux cutter.',
  }],
  /* TWO MORE ELECTRON MAIN-PROCESS SCRIPTS, registered 2026-08-18 with the
     crash that found them. Both are `.cjs` that `require('electron')` and call
     `app.setPath` / `app.whenReady()` at module scope. Unregistered, they took
     the `node` default and died in 0.3s and 1.7s with
     `TypeError: Cannot read properties of undefined (reading 'setPath')` --
     before either had run a single check. That reads in the table exactly like
     a product failure, which is the worst way for a gate to be wrong. See
     runnerForSource() below for why an explicit entry is no longer the only
     thing standing between the next one and the same 0.3s lie. */
  ['approvals-decision-outcome-qa.cjs', { runner: 'electron', timeoutMs: 300_000, artifactProof: 'instrumented-copy' }],
  ['write-outcome-restate-qa.cjs', { runner: 'electron', timeoutMs: 300_000 }],
  /* NEEDS A REAL GOOGLE DESKTOP-APP CLIENT ID AND THE PUBLIC NETWORK, by name:
     it refuses with "TOOLSENABLED_GOOGLE_CLIENT_ID is not set; this run needs a
     real Desktop-app client id" and measures nothing without one. That is the
     definition this file already has for `costly` -- a driver that cannot run
     on its own -- and google-signin-packaged-qa covers the same machinery
     against a loopback provider in the default set, so the free path is not
     lost by holding this one back. */
  ['google-signin-live-qa.mjs', { runner: 'node', timeoutMs: 900_000, costly: true }],
  /* Launches a real Codex Cloud task and follows it to a terminal state. Real
     provider budget, real network. Never in the default set. */
  ['cloud-launch-packaged-qa.mjs', { runner: 'node', timeoutMs: 1_500_000, costly: true }],
  /* DRIVES ONE REAL CODEX `luna` TURN THROUGH THE PACKAGED SHELL and then asks
     the metrics page what it shows. It spends the owner's own quota, and it
     REFUSES without an engine path: "This driver measures a REAL agent turn and
     needs a real engine to run one. Pass --engine <path…>" -- exit 2, nothing
     measured.
     Unregistered, it took the defaults, was run with no argument, and sat in the
     FAIL column of a 43-driver run having measured nothing (2026-08-18). That is
     the same shape google-signin-live-qa is held back for, stated four entries
     up: a driver that cannot run on its own is costly, not failing. It is
     `costly` for BOTH reasons here -- the budget and the argument -- and the
     free path is not lost, because tools/test/*.test.mjs cover the writer and
     the readings, and a live reconciliation against the engine's own rollout
     files is an operator run. */
  ['metrics-usage-live-qa.mjs', { runner: 'node', timeoutMs: 900_000, costly: true, artifactProof: 'instrumented-copy' }],
  // These replace the engine/confinement seam with deterministic fixtures.
  ['send-actually-sends-qa.mjs', { artifactProof: 'instrumented-copy' }],
  /* T369: the main-thread-stall gate drives a burst of fleet writes and screen
     status calls against the candidate and reads its own main-lag.log; it
     repacks a scratch app.asar with this checkout's dist/shell/public, so it is
     an instrumented copy, not a claim about the candidate's untouched bytes. */
  ['main-thread-stall-packaged-qa.mjs', { runner: 'node', timeoutMs: 900_000, artifactProof: 'instrumented-copy' }],
])

const DEFAULT_SETTINGS = Object.freeze({
  runner: 'node',
  timeoutMs: 900_000,
  costly: false,
  excluded: null,
  requiredPlatform: null,
  platformReason: null,
  needs: [],
  artifactProof: 'unclassified',
})

/* ---------- DRIVER-SHAPED FILES THIS SUITE DELIBERATELY DOES NOT REACH ----
 *
 * DRIVER_PATTERN decides membership, and a file it does not match is invisible
 * to this suite by construction -- which is exactly how twenty-eight harnesses
 * went unseen. So the OTHER direction is written down too: every file in tools/
 * that looks like a driver and is NOT matched by the pattern is named here with
 * the reason, and tools/check-drivers-discovered.mjs fails on any that is not.
 *
 * "Looks like a driver" is asked two ways by that guard, and both are needed:
 * by NAME (the suffixes this repo gives its harnesses) and by CONTENT (a file
 * that imports tools/test-account-harness.mjs is staging the packaged build,
 * opening its window and asserting isolation -- that import is what makes a
 * file a driver of the packaged product, whatever it is called).
 *
 * Keys are exact tools-relative paths, using forward slashes; a root-level
 * filename never exempts a nested copy. NOTHING HERE IS A JUDGEMENT THAT THE
 * FILE IS WORTHLESS. Most entries are one-off investigations or two-part
 * smoke/e2e pairs. Qualification transport/measurement helpers instead belong
 * to the separate mandatory full-qualification service: their presence or
 * hold-out is not execution evidence and cannot satisfy release readiness.
 * Moving a packaged-window driver INTO this suite is a rename to its convention
 * plus a SETTINGS entry, and it should be argued for on its merits.
 */
export const HELD_OUT_OF_DISCOVERY = new Map([
  ['t162-unreadable-status-handtest.mjs', 'T162 unknown-status hand test, WRITTEN AND NEVER ONCE EXECUTED: it stages a packaged build through tools/test-account-harness.mjs and opens a real window, so it cannot run in a source worktree and dies ENOENT on release/win-unpacked. It shipped as -drive.mjs, which IS the discovery pattern, so release:cut would have run a script no one has ever completed -- a driver that exists and is never run is indistinguishable from one that passes. Held out under the -handtest name until someone runs it by hand against a live candidate and confirms it passes; arming it then means renaming it back to -drive.mjs and giving it a SETTINGS entry. This declaration supplies no execution proof and no release-readiness proof'],
  ['page2-native-audit.cjs', 'maintained Page 2 source regression runner: npm run qa:page2-native -- --real-provider; requires the owning interactive desktop and explicit provider-budget opt-in, verifies an immutable app/engine snapshot, and records native case verdicts. It does not inspect an untouched installed release and supplies no installer-qualification proof'],
  ['lib/guest/Read-InstalledState.ps1', 'fixed read-only installed-state measurement helper owned by lib/guest/installed-state.mjs in the separately mandatory full-qualification service; it is not a packaged-window QA driver, and this declaration supplies no execution or release-readiness proof'],
  ['lib/transport/Probe-QualificationHost.ps1', 'fixed host-prerequisite diagnostic owned by the qualification transport and its QualificationVm.psm1 module; full qualification remains separately mandatory, and running or declaring this probe proves no installed-product journey or release readiness'],

  /* The smoke/e2e pairs. In each pair the first file is an Electron
     main-process harness that boots the real shell/main.cjs, and the second is
     the only correct way to start it -- it strips ELECTRON_RUN_AS_NODE (which
     an agent harness exports, turning the Electron binary into plain Node and
     making the app fail in a way that reads as a product bug) and points the
     shell at an engine. This suite spawns drivers itself and does neither, so
     it would measure a fail-closed path and call it a result. */
  ['agent-from-ui-smoke.cjs', 'an Electron main-process harness; run it through tools/run-agent-from-ui-smoke.cjs (npm run smoke:agent-ui), which strips ELECTRON_RUN_AS_NODE and supplies MISSION_CONTROL_ENGINE'],
  ['run-agent-from-ui-smoke.cjs', 'the runner for agent-from-ui-smoke.cjs, not a driver of its own'],
  ['account-ledger-e2e.cjs', 'an Electron main-process harness; run it through tools/run-account-ledger-e2e.cjs'],
  ['run-account-ledger-e2e.cjs', 'the runner for account-ledger-e2e.cjs, not a driver of its own'],
  ['steering-controls-e2e.cjs', 'an Electron main-process harness; run it through tools/run-steering-controls-e2e.cjs (npm run qa:steering)'],
  ['run-steering-controls-e2e.cjs', 'the runner for steering-controls-e2e.cjs, not a driver of its own'],
  ['steering-controls-reachability-e2e.cjs', 'an Electron main-process harness (require("electron") returns the binary path under plain node, so app/BrowserWindow destructure to undefined and it throws on app.whenReady()); run it with the electron binary directly, e.g. ./node_modules/electron/dist/electron.exe tools/steering-controls-reachability-e2e.cjs -- unlike steering-controls-e2e.cjs it needs no dedicated runner, because it never touches credentials or agent config: it boots the real app shell and injects synthetic [data-control] rigs to prove the press mechanism itself (elementFromPoint reachability + real dispatched input) discriminates a person-pressable control from each of the six shapes 02-DRIVING-LIKE-A-PERSON.md names, in seconds and at no token cost'],

  /* One-off investigations that use the packaged-driver harness. Each answers a
     single question that has already been answered; each would spend money,
     need an overlaid payload, or produce a report rather than a verdict. */
  ['claude-mcp-isolation-proof.mjs', 'a before/after proof of two Claude-session leaks against an OVERLAID engine payload; it starts real Claude sessions and spends real budget'],
  ['claude-tree-start-proof.mjs', 'it presses Start on a Claude tier and requires a real answer from a paid model, against an overlaid engine payload'],
  ['decision-record-crossaccount-probe.mjs', 'a one-off cross-account visibility investigation whose finding is recorded in reports/lanes/test-account.md'],
  ['dom-retention-probe.mjs', 'a diagnostic that names WHICH retainers hold detached nodes; the pass/fail budget is tools/performance-budget-qa.mjs, which is in the cut'],
  ['signin-reach-probe.mjs', 'a one-off measurement of why one control read zero-size; it reports four possible causes rather than a verdict'],
  ['standing-request-probe.mjs', 'a 103-line probe that prints what one bridge call actually says; it asserts nothing'],
  ['walk-and-look.mjs', 'explicitly "NOT A GATE" in its own first line -- it walks the product and writes down what it sees for a person to read'],
])

/* POWERSHELL UNDER tools/ THAT IS NOT A QA HARNESS, held out in writing.
 *
 * check-drivers-discovered.mjs treats every .ps1 under tools/ as
 * driver-shaped, because DRIVER_PATTERN cannot see that language. A .ps1 is
 * normally accounted for by the discovered driver that delegates to it. The
 * explicit exceptions are launch helpers and manual geometry instruments:
 * the latter print observations from Vite rather than judging the packaged
 * artifact, and have no layout pass/fail assertions to run as a cut gate.
 * Keys are tools-relative paths; the guard checks each one is on disk. */
export const HELD_OUT_POWERSHELL = new Map([
  ['lib/page2-native-picker.ps1', 'PID-bound native picker/clipboard/close support for page2-native-audit.cjs on the owning interactive Windows desktop; boundary tests are tools/test/page2-native-picker.test.mjs. Native scenario receipts remain separate from untouched installer qualification'],
  ['ledger-page-measure.ps1', 'Developer dev-server geometry recorder: prints ledger boxes at requested widths but defines no pass/fail layout assertions. It is not a packaged-product acceptance test; retained as a manual measurement utility.'],
  ['page-width-measure.ps1', 'Developer dev-server geometry recorder: prints home/computers widths without a product pass/fail verdict and has no isolated packaged-app input. It is not run as a release gate or credited as passing coverage.'],
  ['live-launch/launch-live-job.ps1', 'the Job Object holder that STARTS the owner\'s app for tooling/live/Start-ToolsEnabled-Live.cmd and records its exit; a launcher, not a QA driver; its logic is tested by tools/test/launch-live.test.mjs'],
  ['live-launch/watch-live.ps1', 'the 3-second sampler the launcher starts beside the app (CSV + one minidump on hang/3 GB); it asserts nothing and never ends the app'],
  ['page-width-measure.ps1', 'manual Windows Vite/Chrome geometry instrument for home and computers; prints box widths without asserting a layout verdict and does not inspect the packaged candidate; retained as measurement provenance, not a cut gate'],
  ['ledger-page-measure.ps1', 'manual Windows Vite/Chrome geometry instrument for the ledger; prints row dimensions without asserting a layout verdict and does not inspect the packaged candidate; retained as measurement provenance, not a cut gate'],
])

/* WHICH BINARY AN UNREGISTERED DRIVER NEEDS, ASKED OF THE FILE.
 *
 * Rule 2 above says an unregistered driver still RUNS, on defaults. That was
 * true and it was not enough: the default runner is `node`, and an Electron
 * main-process script under `node` has no `app` at all, so it throws on its
 * first line. Measured 2026-08-18 -- approvals-decision-outcome-qa and
 * write-outcome-restate-qa were both in the FAIL column of a 40-driver run
 * having never executed one check, with a module-load stack for a log. The
 * registry entries above fix those two; this function is why the next one
 * added is not a third.
 *
 * IT IS ONE FACT, ASKED THE WAY acceptsRelease() ALREADY ASKS ITS ONE FACT: an
 * Electron main script is exactly a file that pulls the `electron` module into
 * its own process. A driver that merely SPAWNS the Electron binary (which is
 * what most of these do, through the shared harness) never does that -- it
 * passes a path to a child. The one file that both spawns and names the module
 * is tools/ring-fidelity-qa.mjs, and it names it INSIDE a call
 * (`run(require('electron'), ...)`) rather than binding it at module scope,
 * which is the distinction this pattern is written around.
 *
 * A REGISTERED ENTRY STILL WINS, and unreadable is still `node`: derivation is
 * the floor under the registry, never a second opinion that can overrule it. */
/* `.` never crosses a line break without the `s` flag, which is what keeps
   both halves anchored to ONE statement rather than wandering down the file. */
const ELECTRON_MAIN = /^\s*(?:const|let|var)\s.*=\s*require\(['"]electron['"]\)|^\s*import\s.*from\s*['"]electron['"]/m

export function runnerForSource(source) {
  return typeof source === 'string' && ELECTRON_MAIN.test(source) ? 'electron' : 'node'
}

function derivedRunner(file) {
  try { return runnerForSource(readFileSync(file, 'utf8')) } catch { return DEFAULT_SETTINGS.runner }
}

/* Which drivers accept `--release <dir>`. Passing it to one that does not would
   be read as an unknown positional, so it is asked of the file rather than
   assumed. */
function acceptsRelease(source) {
  return /--release/.test(source) || usesSharedReleaseStage(source)
}

/* stage(scratch) already reads the shared harness's exact --release argument.
   Requiring every caller to repeat that flag in its own source misclassified
   those drivers as deaf. Follow only the actual imported binding: a comment,
   an unused import, shadowed function, explicit second argument or escaped
   reference cannot authorize forwarding an artifact selection. */
export function usesSharedReleaseStage(source) {
  let tree
  // Rollup probes the Windows runtime with a child process when loaded.
  // Defer that probe until the selected QA work has passed its host boundary.
  try { tree = require_('rollup/parseAst').parseAst(source) } catch { return false }
  const imports = tree.body.filter(node => node.type === 'ImportDeclaration'
    && node.source.value === './test-account-harness.mjs')
  const bindings = imports.flatMap(node => node.specifiers.filter(specifier =>
    specifier.type === 'ImportSpecifier' && specifier.imported.name === 'stage'))
  if (bindings.length !== 1) return false
  const binding = bindings[0]
  let calls = 0, safe = true
  const visit = (node, parent) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Identifier' && node.name === binding.local.name && parent !== binding) {
      if (parent?.type !== 'CallExpression' || parent.callee !== node || parent.arguments.length !== 1
        || parent.arguments[0].type === 'SpreadElement') safe = false
      else calls++
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, node))
      else if (value && typeof value === 'object') visit(value, node)
    }
  }
  visit(tree, null)
  return safe && calls > 0
}

/* Route the artifact without turning an explicit exact-candidate request into
   an unsupported positional argument.

   Older drivers predate `--release`; they deliberately read this checkout's
   own release/win-unpacked. That is still the exact artifact requested by the
   isolated cutter, because the cutter invokes this suite from the candidate's
   worktree and names that same directory. In that one case, forwarding
   `--release` is both unnecessary and wrong for a legacy positional-only
   driver: it would read argv[2] as a bare directory and try to open a directory
   literally named `--release`. Home now explicitly supports both forms.

   A different requested directory is not equivalent. A driver that cannot
   read the override would silently inspect this checkout's default build, so
   it remains a hard refusal. `null` is the fail-closed answer; an empty array
   means the requested artifact is already the driver's exact implicit default. */
export function releaseArgumentsFor(source, requestedRelease, defaultRelease = DEFAULT_RELEASE) {
  if (!requestedRelease) return []
  if (acceptsRelease(source)) return ['--release', requestedRelease]

  const requested = path.resolve(requestedRelease)
  const implicit = path.resolve(defaultRelease)
  const same = process.platform === 'win32'
    ? requested.toLowerCase() === implicit.toLowerCase()
    : requested === implicit
  return same ? [] : null
}

export function discoverDrivers(toolsDirectory = path.join(REPO_ROOT, 'tools')) {
  const names = readdirSync(toolsDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && DRIVER_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort()
  return names
}

/* A driver held out because its subject does not exist here, stated the way
 * RELEASE_SKIP_REGISTER states the same thing for the unit suites: what the
 * subject is, and then the register's own sentence about the platform. Returns
 * null when the driver applies to this host, so it can be used directly as the
 * decision AND the explanation rather than as a condition in one place and a
 * sentence somewhere else that drifts from it.
 *
 * A requiredPlatform with no platformReason is refused rather than skipped:
 * "it is Windows-only" with nobody saying WHAT is Windows-only is the silence
 * rule 2b of this file's header already forbids, wearing a new field name. */
export function platformHoldOut(entry, platform = process.platform) {
  if (!entry?.requiredPlatform) return null
  const reason = platformSkipReason(entry.requiredPlatform, platform)
  if (reason === false) return null
  if (typeof entry.platformReason !== 'string' || entry.platformReason.trim() === '') {
    throw new Error(`${entry.key ?? entry.name} declares requiredPlatform ${entry.requiredPlatform} with no `
      + 'platformReason. A skip nobody explained is the silence this suite refuses everywhere else.')
  }
  return `${entry.platformReason} ${reason}`
}

export function planFor(names, platform = process.platform) {
  return names.map(name => {
    const registered = SETTINGS.has(name)
    const file = path.join(REPO_ROOT, 'tools', name)
    const settings = { ...DEFAULT_SETTINGS, ...(SETTINGS.get(name) || {}) }
    /* Only for a driver nobody has recorded settings for; see runnerForSource. */
    if (!registered) settings.runner = derivedRunner(file)
    const entry = {
      name,
      key: name.replace(/\.(mjs|cjs)$/, ''),
      file,
      registered,
      ...settings,
    }
    entry.platformHeldOut = platformHoldOut(entry, platform)
    return entry
  })
}

/* Stale settings: an entry whose file is gone. Exported so the guard suite can
   assert it without launching anything. */
export function staleSettings(names) {
  const present = new Set(names)
  return [...SETTINGS.keys()].filter(name => !present.has(name))
}

/* The same rot, in the other map. HELD_OUT_OF_DISCOVERY names tools-relative paths this suite
   never discovers, so staleSettings() above cannot see them at all -- its
   `names` are the discovered ones by definition. A hold-out whose file was
   deleted or renamed is a reason nobody can act on and a hole in the guard, so
   it is checked against the directory itself. */
export function staleHoldOuts(toolsDirectory = path.join(REPO_ROOT, 'tools')) {
  return [...HELD_OUT_OF_DISCOVERY.keys()].filter(name => !existsSync(path.join(toolsDirectory, name)))
}

/* The registered names, exported so the guard can ask which discovered drivers
   still have no recorded disposition without importing the map's shape. */
export function registeredNames() {
  return [...SETTINGS.keys()].sort()
}

export function artifactProofCounts(results) {
  const counts = { exact: 0, instrumented: 0, unclassified: 0 }
  for (const result of results) {
    if (result.verdict !== 'PASS') continue
    if (result.artifactProof === 'exact-candidate') counts.exact += 1
    else if (result.artifactProof === 'instrumented-copy') counts.instrumented += 1
    else counts.unclassified += 1
  }
  return counts
}

/* THE VERDICT, AS A FUNCTION RATHER THAN AN EXPRESSION BURIED IN THE RUNNER.
 *
 * A timeout is a CONTINUATION, never a result, and it is decided BEFORE the
 * exit code is looked at: a reaped process reports a code that reads exactly
 * like an ordinary failure -- and on some shapes like a success. Exported so
 * the guard suite can exercise the decision instead of grepping this file for
 * the shape of it, which is the kind of instrument that goes green on prose.
 *
 * AN EXIT CODE IS A CLAIM, NOT A RESULT (2026-08-16).
 * Measured: test-account-journey-qa reported PASS while its own log carried
 * eleven FAIL lines -- the driver stopped part-way, so createLedger's finish()
 * never ran, so nothing ever set process.exitCode, so the corpse said 0 and
 * this suite believed it. A gate that believes a half-finished driver is worse
 * than no gate, because every other green in the release is measured by it.
 *
 * So exit 0 is now cross-examined against what the driver actually said:
 *   - it summarised, and the summary is short of total  -> FAIL, whatever the
 *     code says. The driver counted its own failures and exited 0 anyway.
 *   - it started a check ledger and never summarised    -> INCONCLUSIVE. It
 *     stopped somewhere in the middle; the checks it never reached are
 *     unmeasured, and unmeasured is not passed.
 *   - it said nothing this function recognises          -> INCONCLUSIVE. Exit
 *     zero proves only that the process ended; it does not prove that a check
 *     ran or reached its closing assertion.
 *
 * The shapes below are the closing conventions emitted by the drivers in this
 * suite. Unknown or silent output fails closed as INCONCLUSIVE so a launch that
 * exits before doing any checking cannot become the release gate's green.
 */

/* THE SUMMARY VOCABULARY IS MEASURED, NOT DECREED. Replaying 37 real driver
   logs found three closing conventions in use, and a rule that knew only the
   first would have marked research-walkthrough-qa and setup-walkthrough-qa red
   for the crime of ending differently. A gate that cries wolf gets switched
   off, so the vocabulary matches what the drivers already write:
     `1/2 checks passed`        createLedger's finish()
     `research walkthrough: 23/23 checks`  the walkthrough drivers
     `4 of 85 CHECK(S) FAILED`  first-run-contract-qa
   Adding a fourth convention means adding it here, with a log that shows it. */
const RATIO_SUMMARY = /^[^\n]*?(\d+)\s*\/\s*(\d+)\s+checks?\b[^\n]*$/gm
const FAILED_COUNT = /^[^\n]*?(\d+) of (\d+) CHECK\(S\) FAILED/gim
/* Fourth and fifth conventions, added 2026-08-18 with the logs that show them --
   both were read as INCONCLUSIVE over fully green runs:
     first-run-contract-qa.log      -> "ALL 82 CHECKS PASSED"
     home-activity-substance-qa.log -> "15 observation(s), 0 failing"
     tree-chatbox-open-qa.log       -> "48 observation(s), 0 failing" */
const ALL_PASSED = /^[^\n]*?ALL (\d+) CHECKS PASSED/gim
const OBSERVATIONS = /^[^\n]*?(\d+) observation\(s\), (\d+) failing/gim
/* `  ok  <name>` / `  FAIL <name>`, as createLedger's check() writes it. The
   two leading spaces are load-bearing: they keep prose that merely contains the
   word FAIL from being read as a failing check. */
const CHECK_LINE = /^ {2}(?:ok {2}|FAIL )/m

/* The closing roll-call a driver prints for what it could not exercise, one
   line per check. Anchored to the two leading spaces and the colon so the
   phrase appearing inside a reason or a comment cannot inflate the count. */
const NOT_EXERCISED_LINE = /^ {2}NOT EXERCISED: /gm

/* The last match, not the first: a driver may summarise a sub-phase before it
   summarises itself, and the closing count is the one that speaks. */
function lastMatch(text, pattern) {
  const all = [...text.matchAll(pattern)]
  return all.length ? all[all.length - 1] : null
}

export function verdictFor({ timedOut, code, output = '' }) {
  if (timedOut) return 'TIMEOUT'

  const text = typeof output === 'string' ? output : ''

  /* A DRIVER THAT COULD NOT MEASURE IS NOT A PRODUCT FAILURE, and it outranks
     the exit code in both directions. Identical fixed work on this machine
     varied from 356ms to 5408ms on 2026-08-16, which is enough to fail a fixed
     budget on its own; reporting that as FAIL blames the product for the
     weather, and reporting it as PASS hides that nothing was measured. Neither
     is true, so it is neither. See tools/machine-steadiness.mjs. */
  if (text.includes(UNMEASURABLE_MARK)) return 'INCONCLUSIVE'

  /* THE SECOND WAY A DRIVER CAN HONESTLY FAIL TO MEASURE, and it is the
     driver's own declaration rather than the machine's. agent-start-flow-qa
     was born naming the checks it cannot exercise (0c049ac, "including what it
     cannot prove"): two of them need window.mcAgent's start reply substituted
     from the page, and that object is a non-configurable contextBridge
     property -- a deliberate guarantee of the shell. It refuses to fake them,
     prints NOT EXERCISED with the reason, and exits 3.

     Read as FAIL, that is this file's own UNMEASURABLE comment violated one
     paragraph below where it is written: the product is blamed for a security
     guarantee working. The only ways to make it green would be to weaken the
     bridge or to let the driver lie, and both are worse than the report.

     THE RULE IS NARROW ON PURPOSE, because a verdict that launders failures is
     worse than one that over-blames. All three must hold: the driver named at
     least one check it could not exercise; no check FAILED; and the arithmetic
     closes -- passed plus not-exercised accounts for the whole roster, so a
     check that vanished for some other reason is still a failure. */
  const notExercised = [...text.matchAll(NOT_EXERCISED_LINE)].length
  if (notExercised > 0 && !/^ {2}FAIL /m.test(text)) {
    const ratio = lastMatch(text, RATIO_SUMMARY)
    if (ratio && Number(ratio[1]) + notExercised === Number(ratio[2])) return 'INCONCLUSIVE'
  }

  /* EXIT 3 IS THE DRIVER'S OWN COULD-NOT-MEASURE, AND IT WAS COLLAPSED INTO
   * FAIL BY THE LINE BELOW.
   *
   * The block above recovers the same answer from the driver's TEXT -- the
   * NOT EXERCISED lines plus arithmetic that closes -- and that is the right
   * fallback for a driver that never declared anything. But a driver that
   * exits 3 has ALREADY answered: tools/cut-check-drive.mjs documents 3 as
   * "nothing failed but something could not be exercised", and reading its
   * declaration out of a ratio line means one reworded summary turns a
   * could-not-measure into a product failure.
   *
   * MEASURED TODAY on this file's own subject: cut-check-drive.mjs was changed
   * so a provider CLI that never answers is NOT EXERCISED rather than a failed
   * check, and this runner -- its only non-test caller -- turned that straight
   * back into FAIL. The discrimination existed in the script and nothing
   * downstream consulted it.
   *
   * THIS IS NARROWER THAN "exit 3 means could-not-measure", and deliberately so.
   * Two rules above stay exactly as they were, because both are right:
   *   - a FAIL line outranks everything: a driver that failed a check and could
   *     not exercise another has failed;
   *   - a ratio whose arithmetic does NOT close is still a failure, because
   *     checks went missing for a reason the declaration does not explain.
   * So this applies only when the driver declared what it could not exercise
   * and printed NO totalled summary at all -- a run that stopped before it could
   * close its ledger. There is nothing there to contradict the declaration, and
   * the old behaviour was to fall through to FAIL and blame the product.
   *
   * INCONCLUSIVE is NOT a pass: it is counted with the non-passes below and the
   * suite still exits non-zero, so this names the answer without softening it. */
  if (code === 3 && notExercised > 0 && !/^ {2}FAIL /m.test(text) && !lastMatch(text, RATIO_SUMMARY)) {
    return 'INCONCLUSIVE'
  }

  if (code !== 0) return 'FAIL'

  /* A driver that counted its own failures has already answered, and exiting 0
     afterwards does not withdraw the count. */
  const failedCount = lastMatch(text, FAILED_COUNT)
  if (failedCount) return Number(failedCount[1]) > 0 ? 'FAIL' : 'PASS'

  const observations = lastMatch(text, OBSERVATIONS)
  if (observations) return Number(observations[2]) > 0 ? 'FAIL' : 'PASS'

  if (lastMatch(text, ALL_PASSED)) return 'PASS'

  const ratio = lastMatch(text, RATIO_SUMMARY)
  if (ratio) return ratio[1] === ratio[2] ? 'PASS' : 'FAIL'

  /* Checks ran and nothing closed them out: the driver stopped somewhere in the
     middle. What it never reached is unmeasured, and unmeasured is not passed. */
  if (CHECK_LINE.test(text)) return 'INCONCLUSIVE'

  /* Exit zero without a recognised closing result used to fall through to
     PASS. An empty driver, an early `return`, or a launch that did no checking
     therefore satisfied the suite. Silence is absence of a verdict, not a
     successful verdict. */
  return 'INCONCLUSIVE'
}

function electronBinary() {
  /* Derived from the installed package, never a path typed into this file --
     this is a product repository and a named path would be wrong on any other
     machine. */
  const resolved = require_('electron')
  if (typeof resolved !== 'string' || resolved.length === 0) {
    throw new Error('the electron package did not resolve to an executable path')
  }
  if (!existsSync(resolved)) throw new Error(`electron resolved to ${resolved}, which is not on disk`)
  return resolved
}

// Only the Local native journey consumes these operator-selected inputs.
// Other drivers cannot inherit an accidental local-model/inference permission.
export function localInferenceDriverArguments(key, argv = process.argv.slice(2)) {
  if (key !== 'agent-really-starts-qa') return []
  const result = [], seen = new Set()
  const names = new Set(['--local-model', '--local-endpoint', '--local-gpu-policy'])
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index], name = token.split('=')[0]
    if (name === '--run-local-inference' || name === '--visible') {
      if (token !== name || seen.has(name)) throw new Error(`Invalid or repeated Local QA option: ${name}`)
      seen.add(name); result.push(name)
    } else if (names.has(name)) {
      if (seen.has(name)) throw new Error(`Repeated Local QA option: ${name}`)
      seen.add(name)
      const value = token.includes('=') ? token.slice(name.length + 1) : argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${name} requires an explicit value`)
      result.push(name, value)
    }
  }
  return result
}

export async function runDriver(entry, environment, { runProcess = runQaDriverProcess, logDirectory = LOG_DIR, attempt = 1 } = {}) {
  if (![1, 2].includes(attempt)) throw new Error('QA driver accepts only the initial attempt and one qualified retry')
  const command = entry.runner === 'electron' ? electronBinary() : process.execPath
  const argv = [entry.file, ...entry.needs, ...localInferenceDriverArguments(entry.key)]
  const releaseArguments = releaseArgumentsFor(entry.source, RELEASE)
  if (releaseArguments === null) {
    throw new Error(`${entry.key} cannot read --release ${RELEASE}`)
  }
  argv.push(...releaseArguments)

  const startedAt = Date.now()
  /* A driver run under the Electron binary IS a launch of the application, and
     gets the one shared launch environment (tools/lib/sterile-launch.cjs) with
     every home in a scratch profile of its own -- MC_SMOKE_HEADLESS rides
     through from `environment`, since the helper keeps everything that is not a
     home. A driver run under node is a harness that launches the application
     itself, and is held to the same helper by the harness guard. */
  /* An older shared-harness driver may consume only the implicit default
     release, so releaseArgumentsFor() cannot safely add a positional flag.
     Carry exact mode only to shared-stage Node harnesses; the harness removes
     this QA marker before it launches the packaged application. */
  const sharedStageEnvironment = { ...environment }
  if (RELEASE && /from\s+['"]\.\/test-account-harness\.mjs['"]/.test(entry.source)) {
    sharedStageEnvironment.TOOLSENABLED_QA_STAGE_MODE = 'exact-release'
  } else {
    delete sharedStageEnvironment.TOOLSENABLED_QA_STAGE_MODE
  }
  const scratchHomes = entry.runner === 'electron' ? mkdtempSync(path.join(tmpdir(), 'packaged-qa-homes-')) : null
  const driverEnvironment = scratchHomes
    ? sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(scratchHomes)), sharedStageEnvironment)
    : sharedStageEnvironment
  const execution = await runProcess(command, argv, {
    cwd: REPO_ROOT,
    env: driverEnvironment,
    timeoutMs: entry.timeoutMs,
  })
  if (scratchHomes && !execution.cleanupUnconfirmed) { try { rmSync(scratchHomes, { recursive: true, force: true, maxRetries: 10 }) } catch { /* a leftover scratch home is not a verdict */ } }

  const durationMs = Date.now() - startedAt
  const text = execution.output + (execution.failureReason ? `\n[QA process] ${execution.failureReason}\n` : '')
    + `\n[QA cleanup] ${execution.cleanupScope}; confirmed=${execution.cleanupConfirmed}; unconfirmed=${execution.cleanupUnconfirmed}\n`
  mkdirSync(logDirectory, { recursive: true })
  const logPath = path.join(logDirectory, `${entry.key}${attempt === 2 ? '.attempt-2' : ''}.log`)
  writeFileSync(logPath, text, 'utf8')

  const code = execution.failureReason || execution.cleanupUnconfirmed ? null : execution.code
  const verdict = verdictFor({ timedOut: execution.timedOut, code, output: text })
  return { ...entry, verdict, exitCode: code, durationMs, logPath, attempt,
    cleanupConfirmed: execution.cleanupConfirmed, cleanupUnconfirmed: execution.cleanupUnconfirmed,
    cleanupScope: execution.cleanupScope, tail: text.trim().split('\n').slice(-4).join(' | ') }
}

async function main() {
  const names = discoverDrivers()
  if (names.length === 0) {
    console.error('packaged-qa-suite: discovered NO drivers under tools/. That is an error, not a pass:')
    console.error(`  nothing in ${path.join(REPO_ROOT, 'tools')} matches ${DRIVER_PATTERN}.`)
    console.error('  Either the harnesses moved or the convention changed. A gate that found nothing reports success; this one does not.')
    process.exit(2)
  }

  const stale = staleSettings(names)
  if (stale.length > 0) {
    console.error(`packaged-qa-suite: settings name ${stale.length} driver(s) that are not on disk: ${stale.join(', ')}`)
    process.exit(2)
  }

  const staleHolds = staleHoldOuts()
  if (staleHolds.length > 0) {
    console.error(`packaged-qa-suite: ${staleHolds.length} file(s) are held out of discovery but are not on disk: ${staleHolds.join(', ')}`)
    console.error('  A hold-out for a file nobody can find is a reason nobody can act on. Delete the entry or restore the file.')
    process.exit(2)
  }

  const plan = planFor(names).map(entry => ({ ...entry, source: '' }))
  /* Read each driver once, for the --release question. Cheap, and it keeps the
     answer a property of the file rather than of this file's memory of it. */
  const { readFileSync } = await import('node:fs')
  for (const entry of plan) entry.source = readFileSync(entry.file, 'utf8')

  const selected = plan.filter(entry => {
    if (ONLY.length > 0) return ONLY.includes(entry.key) || ONLY.includes(entry.name)
    return true
  })
  if (ONLY.length > 0 && selected.length === 0) {
    console.error(`packaged-qa-suite: --only ${ONLY.join(',')} matched no driver. Known: ${plan.map(e => e.key).join(', ')}`)
    process.exit(2)
  }

  /* --only on an excluded driver is answered with the reason rather than with a
     run or with silence. Running it would ignore a recorded decision; doing
     nothing quietly would look like a pass over an empty set. */
  const askedForExcluded = selected.filter(entry => entry.excluded)
  if (ONLY.length > 0 && askedForExcluded.length > 0) {
    for (const entry of askedForExcluded) {
      console.error(`packaged-qa-suite: ${entry.key} is held out of this suite: ${entry.excluded}`)
    }
    console.error('  Run it directly if you mean to, with whatever it needs. This suite will not start it.')
    process.exit(2)
  }

  /* --only on a driver whose subject is not on this platform is answered with
     the reason, exactly as --only on an excluded driver is. Running it anyway
     would measure a Windows construct that is not here; running nothing and
     printing 0/0 would be a pass over an empty set. */
  const askedForElsewhere = selected.filter(entry => entry.platformHeldOut)
  if (ONLY.length > 0 && askedForElsewhere.length > 0) {
    for (const entry of askedForElsewhere) {
      console.error(`packaged-qa-suite: ${entry.key} is not run on ${process.platform}: ${entry.platformHeldOut}`)
    }
    console.error(`  Run it on ${askedForElsewhere[0].requiredPlatform}. This suite will not start it here.`)
    process.exit(2)
  }

  const excluded = selected.filter(entry => entry.excluded)
  const platformHeld = selected.filter(entry => !entry.excluded && entry.platformHeldOut)
  const runnable = selected.filter(entry => !entry.excluded && !entry.platformHeldOut)
  const costlyHeld = runnable.filter(entry => entry.costly && !INCLUDE_COSTLY)
  const toRun = runnable.filter(entry => !entry.costly || INCLUDE_COSTLY)

  // Authorization precedes artifact parsing: even loading the parser can
  // execute a native runtime probe on Windows. Listing does not run drivers.
  if (!LIST_ONLY) assertQaSelectionHost(toRun)

  /* --release must reach EVERY driver unless it names this checkout's exact
     default artifact. An excluded driver will not measure any artifact. */
  if (RELEASE) {
    const deaf = plan.filter(entry => !entry.excluded && releaseArgumentsFor(entry.source, RELEASE) === null)
    if (deaf.length > 0) {
      console.error(`packaged-qa-suite: --release was given, but these drivers do not read it and would silently measure their default build: ${deaf.map(e => e.key).join(', ')}`)
      console.error('  Run them individually, or teach them --release. A partial answer about the wrong artifact is not an answer.')
      process.exit(2)
    }
  }

  console.log(`packaged QA drivers discovered: ${names.length}`)
  for (const entry of plan) {
    const marks = [
      entry.registered ? null : 'UNREGISTERED (running on defaults)',
      entry.costly ? 'COSTLY (spends provider budget)' : null,
      entry.artifactProof === 'instrumented-copy' ? 'INSTRUMENTED COPY (not exact-artifact proof)' : null,
      entry.artifactProof === 'unclassified' ? 'UNCLASSIFIED PROOF (not exact-artifact proof)' : null,
      entry.excluded ? `EXCLUDED -- ${entry.excluded}` : null,
      entry.platformHeldOut ? `SKIPPED on ${process.platform} -- ${entry.platformHeldOut}` : null,
    ].filter(Boolean)
    console.log(`  ${entry.key.padEnd(36)} ${entry.runner.padEnd(8)} ${String(Math.round(entry.timeoutMs / 1000)).padStart(4)}s  ${marks.join(' ')}`)
  }
  if (costlyHeld.length > 0) {
    console.log(`\nheld back (pass --include-costly to run): ${costlyHeld.map(e => e.key).join(', ')}`)
  }
  if (excluded.length > 0) {
    console.log(`\nEXCLUDED -- never run by this suite, not even with --include-costly:`)
    for (const entry of excluded) console.log(`  ${entry.key.padEnd(36)} ${entry.excluded}`)
  }
  if (platformHeld.length > 0) {
    console.log(`\nSKIPPED on ${process.platform} -- the subject of each of these is a Windows-only OS construct, `
      + 'and each says which one. A named skip is not a pass and is not counted as one:')
    for (const entry of platformHeld) console.log(`  ${entry.key.padEnd(36)} ${entry.platformHeldOut}`)
  }
  if (HELD_OUT_OF_DISCOVERY.size > 0) {
    console.log(`\nheld out of discovery -- driver-shaped files this suite deliberately does not reach (${HELD_OUT_OF_DISCOVERY.size}):`)
    for (const [name, why] of HELD_OUT_OF_DISCOVERY) console.log(`  ${name.padEnd(36)} ${why}`)
  }
  if (HELD_OUT_POWERSHELL.size > 0) {
    console.log(`\nPowerShell helpers held out of discovery (${HELD_OUT_POWERSHELL.size}):`)
    for (const [name, why] of HELD_OUT_POWERSHELL) console.log(`  ${name.padEnd(36)} ${why}`)
  }
  if (LIST_ONLY) return 0

  /* AUTHORIZATION BEFORE CAPABILITY, AND THE ORDER IS THE RULE.
     Whether this selection MAY run on this host is a different question from
     whether this host CAN launch the artifact, and the first one has to be
     answered first: a shared DEV/CUT session must be refused with
     QA_DISPOSABLE_WORKER_REQUIRED whatever else is wrong with the machine.
     Measured while porting the suite to Linux -- the host-capability preflight
     below was added ahead of this line and a shared-host run started reporting
     a sandbox problem instead of a boundary refusal, which is a security rule
     answered with a hardware complaint.
     tools/test/shared-host-qa-boundary.test.mjs is what holds this order. */
  // assertQaSelectionHost(toRun) already ran before artifact parsing above.

  /* THE TWO THINGS A RUN NEEDS BEFORE ANY DRIVER STARTS, AND WHY BOTH ARE
     ASKED HERE RATHER THAN EIGHTY-SIX TIMES.

     UNTIL 1.0.45 THIS WAS ONE REFUSAL WITH THE WRONG SUBJECT. It asked whether
     the tree held `ToolsEnabled.exe` on any non-Windows host and said "these
     drivers are a Windows-host harness ... porting the suite to Linux is
     separate work". The 1.0.44 Linux cut recorded that as step 54, exit 2, and
     disclosed it. The port is done: the four facts the drivers actually needed
     from their host now live in tools/lib/packaged-platform.mjs, so the
     question is no longer "is this Windows" but "is the application of THIS
     platform's shape in the tree", which is a question a Linux tree can pass.

     THE SECOND CHECK IS NEW AND IS THE ONE THAT SAVES THE HOURS. Measured
     2026-09-11 against the 1.0.44 candidate's own linux-unpacked tree: on a
     stock Ubuntu desktop the packaged ELF aborts at exit 133 in well under a
     second, before any window, because Chromium can build neither sandbox --
     kernel.apparmor_restrict_unprivileged_userns=1 denies the namespace one to
     an unconfined process, and an unpacked tree's chrome-sandbox is not
     root:4755 because only an installer can make it so. Left to discover that
     for themselves, the drivers would each spend their full ceiling waiting for
     a window from a process that died at once. packagedLaunchReadiness() names
     the cause and the three things a person can actually do about it. */
  if (RELEASE && !packagedLauncherPresent(RELEASE)) {
    // The tree is not named: this sentence is recorded in release declaration facts, and an absolute
    // builder path there is exactly what the owner-data scan refuses to publish.
    console.error(`packaged-qa-suite: the --release tree holds no ${packagedLauncherName()}, and this host is ${process.platform}.`)
    console.error(`  Every driver launches the packaged application from the staged tree, and on ${process.platform} that file is`)
    console.error(`  ${packagedLauncherName()}. Point --release at this platform's unpacked build `
      + `(${unpackedDirectoryName()}), or run the suite on the platform the tree was built for.`)
    process.exit(2)
  }

  const readiness = packagedLaunchReadiness({
    executable: RELEASE ? path.join(path.resolve(RELEASE), packagedLauncherName()) : null,
  })
  if (!readiness.ready) {
    console.error(`packaged-qa-suite: this ${process.platform} host cannot launch the packaged application, so no `
      + 'driver would measure the artifact:')
    for (const reason of readiness.reasons) console.error(`  - ${reason}`)
    console.error('  Nothing was run. A suite that spent 86 timeouts discovering this would report the same nothing '
      + 'with a day of heat behind it.')
    process.exit(2)
  }

  // The selected run was refused above, before any driver starts and before any
  // question about this machine. Never turn a requested real-provider matrix
  // into a passing subset on the shared build host.
  const environment = accountFencedDriverEnvironment(process.env, { cwd: REPO_ROOT })
  /* The exact string '1'. shell/window-options.cjs matches nothing else, and
     an empty or absent value SHOWS the window -- absence is not consent here
     either, so it is set explicitly rather than assumed to be inherited. */
  if (VISIBLE) delete environment.MC_SMOKE_HEADLESS
  else environment.MC_SMOKE_HEADLESS = '1'
  delete environment.ELECTRON_RUN_AS_NODE

  const results = []
  for (const entry of toRun) {
    process.stdout.write(`\n---- ${entry.key} ----\n`)
    let result = await runDriver(entry, environment)

    /* A TIMEOUT IS THE ONE VERDICT THAT NAMES NO EVIDENCE. Every other verdict
       here is derived from what the driver itself said; a timeout is derived
       from what it did not say, and "it did not finish" has two completely
       different causes -- the product hung, or this machine did not give the
       driver what it needed in time. The gate cannot tell them apart from one
       observation, and reporting the first when it was the second blames the
       product for the weather.

       Measured 2026-08-18: example-page-write-fence-qa timed out at 600.5s at
       its live-mode launch inside this suite, then passed 24/24 in 217s on an
       immediate re-run -- with another driver still running. One observation
       said "hung"; two said "did not reproduce".

       So a timeout is re-run ONCE, and the pair is reported. It NEVER becomes
       PASS: a driver that finished only on the second ask has told us something
       about its cost or its stability, and calling that green would hide the
       one fact worth keeping. INCONCLUSIVE is what it is -- nothing was proven
       about the product either way. */
    // Root exit is not permission to overlap an unconfirmed descendant tree.
    if (mayRetryQaDriver(result)) {
      console.log(`TIMEOUT  ${entry.key}  exit=${result.exitCode}  ${(result.durationMs / 1000).toFixed(1)}s  -- re-running once before this stands`)
      const retry = await runDriver(entry, environment, { attempt: 2 })
      if (retry.verdict === 'TIMEOUT') {
        result = { ...retry, tail: `timed out twice (${(result.durationMs / 1000).toFixed(0)}s, ${(retry.durationMs / 1000).toFixed(0)}s) | ${retry.tail}` }
      } else {
        result = {
          ...retry,
          verdict: 'INCONCLUSIVE',
          tail: `timed out at ${(result.durationMs / 1000).toFixed(0)}s, then ${retry.verdict} in ${(retry.durationMs / 1000).toFixed(0)}s on an isolated re-run `
            + '-- nothing was proven about the product; this driver is close to its ceiling or something intermittent starves it',
        }
      }
    }
    results.push(result)
    console.log(`${result.verdict}  ${entry.key}  exit=${result.exitCode}  ${(result.durationMs / 1000).toFixed(1)}s  log=${result.logPath}`)
    if (result.verdict !== 'PASS') console.log(`      ${result.tail}`)
    if (result.cleanupUnconfirmed) {
      console.error('QA STOPPED: descendant cleanup is unconfirmed; no retry or subsequent driver is authorized.')
      for (const pending of toRun.slice(results.length)) console.error(`NOT RUN: ${pending.key} (prior cleanup unconfirmed)`)
      break
    }
  }

  console.log('\n================ packaged QA drivers ================')
  for (const result of results) {
    console.log(`${result.verdict.padEnd(8)} ${result.key.padEnd(36)} ${(result.durationMs / 1000).toFixed(1)}s`)
  }
  for (const entry of costlyHeld) console.log(`${'HELD'.padEnd(8)} ${entry.key.padEnd(36)} costly, not run`)
  for (const entry of excluded) console.log(`${'EXCLUDED'.padEnd(8)} ${entry.key.padEnd(36)} ${entry.excluded}`)
  /* A named skip prints in the closing table beside the verdicts, never only in
     --list: the table is what a cut reads, and a skip a cut cannot see is the
     silent skip this file's header refuses. */
  for (const entry of platformHeld) console.log(`${'SKIPPED'.padEnd(8)} ${entry.key.padEnd(36)} ${entry.platformHeldOut}`)

  const failed = results.filter(result => result.verdict !== 'PASS')
  /* THREE OUTCOMES, NOT TWO, IN WHAT THIS RUN LEAVES BEHIND. A driver that
     measured nothing is neither a pass nor a product failure, and a cut reading
     only "N/M drivers passed" cannot tell which of the misses were verdicts.
     Named here, with the driver's own last lines, so an operator reading the
     cut log knows whether the product was judged or merely not reached. */
  const unmeasured = failed.filter(result => result.verdict === 'INCONCLUSIVE' || result.verdict === 'TIMEOUT')
  if (unmeasured.length > 0) {
    console.log(`\nNOT MEASURED (${unmeasured.length}): neither a pass nor a product failure -- nothing was proven about the product:`)
    for (const result of unmeasured) console.log(`  ${result.verdict.padEnd(12)} ${result.key.padEnd(36)} ${result.tail}`)
    console.log('A cut does not proceed on a check that was never exercised (R1228). This run exits non-zero and names them;')
    console.log('the decision to cut anyway is an operator\'s to make out loud, not this suite\'s to make by absorbing them.')
  }
  const proof = artifactProofCounts(results)
  console.log(`\n${results.length - failed.length}/${results.length} drivers passed` +
    (costlyHeld.length ? `, ${costlyHeld.length} held back` : '') +
    (excluded.length ? `, ${excluded.length} excluded` : '') +
    (platformHeld.length ? `, ${platformHeld.length} skipped by name on ${process.platform}` : ''))
  console.log(`${proof.exact} exact-artifact passes; ${proof.instrumented} instrumented-copy passes; ${proof.unclassified} unclassified passes`)
  console.log('Scope: functional packaged QA only; this result does not qualify release readiness.')
  return failed.length === 0 ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF)) {
  main().then(
    code => { process.exit(code) },
    error => { console.error(error?.stack || String(error)); process.exit(2) },
  )
}
