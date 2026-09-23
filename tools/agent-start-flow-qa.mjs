#!/usr/bin/env node

// DOES THE PROVIDERLESS FLEET PANEL TELL THE TRUTH BEFORE START?
//
// THE DEFECT THIS EXISTS TO CATCH, AND WHY NO SOURCE TEST COULD.
//
// The owner asked "how do I start an agent?" and the honest answer was that he
// could not. The chat box on the agent page answered ITSELF with canned replies
// -- its own note admitted "typing in it still reaches nothing" -- and the only
// control in the product wired to mcAgent.start() was RESPAWN, which by
// definition can only restart a session that already exists. First-start had no
// home anywhere in the window. Meanwhile the fleet page opened on eight agents
// nobody had created, drawn from demonstration data, so the screen that should
// have said "you have nothing yet, press here to begin" instead said "here is
// your fleet".
//
// EVERY UNIT SUITE PASSED THROUGHOUT AND WOULD HAVE GONE ON PASSING. There was
// no broken function to catch. mcAgent.start() worked; the bridge dispatch
// worked; the roster builder built rosters. The defect was in what the product
// OFFERED -- which affordances a person could see and press -- and an offer is
// not a return value. tools/agent-subpage-qa.mjs wrote the measurement down for
// its own page: planting `return ''` at the top of the roster builder renders
// the page with NO AGENTS while every source assertion stays true, because dead
// code matches a text search exactly as well as live code does. The same is
// true here in the other direction: a page can import a start function, export
// it, and reference it, and still put nothing on the glass that reaches it.
//
// So this file renders the packaged window on a FRESH PROFILE and presses what
// a person would press.
//
// WHAT IT MEASURES, IN THE ORDER A PERSON MEETS IT.
//
//   1. EMPTY FIRST RUN. A profile with no trees shows an empty state that says
//      so in words, and it does NOT present demonstration agents as the
//      person's own. Measured as: zero nodes carrying a real agent identity.
//   2. AN AFFORDANCE THAT CAN ACTUALLY BE PRESSED. At least one EMPTY node,
//      visible, enabled, and HIT-TESTABLE -- document.elementFromPoint at its
//      own centre resolves to it, so nothing is sitting on top of it. "In the
//      DOM" is not "on the glass" and "on the glass" is not "pressable".
//   3. THE PANEL. Pressing it opens the right-side panel, and that panel offers
//      a role, a message, the declared Start control, and every engine row.
//   4. PROVIDERLESS READINESS. After the shell's tier and provider probes settle,
//      the selected row is disabled with a concrete sentence and Start is
//      disabled. The harness fills the brief but never presses Start.
//   5. NO INTENT. The product's signed start history and canonical launch record
//      do not move, no node looks running, and no new product window appears.
//   6. A REASON IS A SENTENCE. Not a bare refusal identifier anywhere a person
//      can read it. Judged with src/refusal-copy.js's own IDENTIFIER_RE.
//
// IT SPENDS NO PROVIDER BUDGET, AND THAT IS ENFORCED RATHER THAN INTENDED.
//
// The app is given an environment in which neither provider CLI can be found:
// PATH is cut back to the Windows system directories, and APPDATA, LOCALAPPDATA,
// USERPROFILE and CODEX_HOME point at empty directories inside this run's
// scratch. The UI must learn that state from the real built-in availability
// APIs and stop at its own disabled Start control. A signed start intent, an
// agent-host launch, a mission-bridge launch, or a started outcome is therefore
// a harness failure, never evidence that this check proved a start.
//
// The Windows system directories STAY on PATH, and that is not laziness: the
// bridge refuses to start if it cannot lock its own token file down, and a bare
// PATH produced UAC_TOKEN_UNAVAILABLE and no bridge at all (measured by the
// sibling driver). Nothing here elevates, and nothing here writes outside the
// scratch directory or `release/`-adjacent staging -- the real user profile is
// never read and never written.
//
// A START THAT NEVERTHELESS OCCURS IS A HARNESS FAILURE, NOT A PASS. It is
// reported as one and the app's whole process tree is reaped immediately.
//
// WHERE THE POSITIVE START PROOF LIVES.
//
// tools/agent-dispatch-packaged-qa.mjs is the required provider-free positive
// gate. It starts the staged capability payload, sends real built-in mission-
// bridge API dispatches to a deterministic loopback worker, and requires signed
// launch records plus completed responses. This UI driver does not duplicate
// that proof and cannot turn an honest refusal into a green "started" verdict.
//
// THE INSTRUMENT PROVES ITSELF BEFORE IT REPORTS, THREE TIMES.
//
// A green run that could not have gone red is worth nothing, and this repository
// has shipped exactly that before. So the run ends by rebuilding the defect and
// REQUIRING THE OLD FAILURE BACK, in three separate shapes:
//
//   CONTROL A  NO AFFORDANCE. The empty nodes are removed from the document
//              before any of the page's own script runs -- the shipped page,
//              which had no pressable start affordance at all. The affordance
//              checks MUST go red.
//   CONTROL B  LOOKS PRESSABLE, IS NOT. Nothing is removed: every class, every
//              attribute, every accessible name stays exactly where it is, and
//              a transparent sheet is laid over the page. This is the control
//              that matters most, because it is the one a markup-reading check
//              passes. The pressability check MUST go red.
//   CONTROL C  A BARE CODE ON THE GLASS. The refusal sink's text is rewritten
//              to the identifier, which is what this product used to print. The
//              plain-sentence check MUST go red.
//
// If a control cannot be reproduced, this file cannot claim to detect what it
// is about, and the run fails.
//
// WHAT THIS DRIVER DOES NOT MEASURE, STATED AS A COVERAGE GAP RATHER THAN AS A
// FOOTNOTE ON A PASS.
//
// It does not prove a successful interactive provider session or attach a
// returned session id to a tree node. That requires a real supported provider,
// credentials, network and budget; the product intentionally ships no local
// interactive ACP launcher. No page-side replacement of the frozen mcAgent
// contextBridge object is attempted.
//
// It stages the packaged build at release/win-unpacked when there is one. When
// there is not -- and on the day this was written there was not: that directory
// holds ToolsEnabled.exe and resources/app.asar with no icudtl.dat, no
// resources.pak, no v8 snapshots and no locales/, and dies in 310ms with
// "Invalid file descriptor to ICU data received" under a completely untouched
// environment -- it falls back to the installed Electron runtime carrying this
// tree's dist/, shell/ and a freshly staged capability payload. That is the same
// code the product ships (package.json's build.files is dist/** and shell/**,
// and every non-relative require in shell/ is a node builtin or 'electron'), so
// every assertion below is about the shipped renderer, the shipped preload and
// the shipped main process.
//
// IT IS NOT THE SAME ARTIFACT. asar packing, the renamed launcher, the
// installer and the signature are NOT MEASURED on a fallback run, and the
// header line of every such run says so. Those belong to
// tools/check-asar-manifest.mjs and tools/smoke-packaged.mjs. A fallback run is
// a run with a gap in it, not a run with an asterisk.
//
// EXIT CODES
//   0  every assertion exercised and passed
//   1  an assertion failed -- including "the page offers no way to start an
//      agent", which is the defect itself
//   2  the harness could not run at all (no packaged build, the app never
//      painted, staging failed). Not a verdict about the product.
//   3  nothing failed, but assertions could not be EXERCISED because the
//      surface they are about is not on the glass yet. Never a pass.
//
// USAGE
//   node tools/agent-start-flow-qa.mjs
//   node tools/agent-start-flow-qa.mjs --release <dir>   borrow another build
//   node tools/agent-start-flow-qa.mjs --visible         show the window
//   node tools/agent-start-flow-qa.mjs --keep            keep the scratch tree

import { spawn, spawnSync, execFile as execFileCallback } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  /* readdirSync is the fallback half of `filesystem.readdirSync || readdirSync`
     in launchLinesByOrigin, and it was never imported -- so whenever the
     injected filesystem did not supply it, that line threw ReferenceError
     instead of reading a directory. It is the last step of the walk, which
     means the walk could not reach its own end on the default path. */
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/* THE ONE PLACE THAT DEFINES WHAT A BARE CODE LOOKS LIKE. Imported rather than
   re-typed: a second regex here would be a second vocabulary, and the whole
   point of the plain-language check is that the product and the instrument agree about what a
   person must never be shown. src/refusal-copy.js imports nothing, so this
   costs no module graph (tools/check-plain-language.mjs borrows it the same
   way). */
import { IDENTIFIER_RE } from '../src/refusal-copy.js'
/* THE PRODUCT'S OWN WORDS, for the same reason. Every string this driver
   expects to find on the glass is READ from the module that declares it, so a
   lane that rewords the empty node or the panel does not turn this driver red,
   and a lane that hand-rolls a sentence beside the declared one does. Retyping
   any of these here would create a second vocabulary that goes stale silently
   -- which is the exact failure this file exists to catch, one layer up. */
import { EMPTY_NODE, EMPTY_TREE, ROLE_CHOICES, SECOND_TREE, START_PANEL } from '../src/fleet-tree-copy.js'
/* THE SHARED STAGING GUARD, extracted from this file so the other twenty-five
   dist/-staging harnesses cannot drift from it. */
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { activeRouteDescendantExpression, activeRouteExpression } from './lib/active-route-navigation.mjs'
import { createCompositedPageMeasure } from './lib/composited-page-measure.mjs'
import { canonicalizeCreatedQaProfile, prepareSterileProfile, qaProfileDirectories, sterileLaunchEnvironment } from './lib/sterile-launch.cjs'
import { machineRecordProductDirectory, userDataFor } from './test-account-harness.mjs'
import { appExecutable as packagedAppExecutable, defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const execFile = promisify(execFileCallback)
const require_ = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')
const { trustedProfileShortAliasRoot } = require_(path.join(REPO_ROOT, 'shell', 'install-profile-guard.cjs'))

function argument(name, fallback = null) {
  const inline = process.argv.find(value => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback)
}

const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const KEEP = process.argv.includes('--keep')
const VISIBLE = process.argv.includes('--visible')

const OPEN_BUDGET_MS = 90_000
/* From "the debugger answered" to "the router mounted a view". Generous because
   the renderer bundle is 1.5 MB and this is a cold start on a machine that is
   also running everything else. */
const BOOT_BUDGET_MS = 90_000
/* From "the hash changed" to "that route's view is on the glass". */
const VIEW_BUDGET_MS = 30_000
const PANEL_BUDGET_MS = 6_000
/* startableTiers() and provider presence settle independently and each repaints
   the open panel. This budget waits for their final, providerless answer rather
   than sampling the optimistic fallback rows between those two replies. */
const PROVIDER_SETTLE_BUDGET_MS = 15_000
/* Long enough to catch a helper window accidentally opened by a disabled Start
   path; nothing in this providerless preflight should launch one at all. */
const WINDOW_WATCH_MS = 10_000

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ============================ THE CONTRACT ============================
 *
 * The fleet page's start flow is being built by several lanes at once, so what
 * this driver looks for is written down HERE, once, in the terms those lanes
 * agreed: press an EMPTY node, get a panel offering a role and a message, then
 * let the real tier/provider probes decide whether Start is available. This
 * providerless run must settle unavailable and must not send a start intent.
 *
 * TWO WAYS OF FINDING EACH THING, AND BOTH ARE DELIBERATE.
 *
 *   DECLARED   the selectors below. Exact, cheap, and the thing to update when
 *              a lane names something differently.
 *   BEHAVIOURAL a fallback that asks what a PERSON would ask: is there a
 *              pressable thing inside the fleet page whose accessible name
 *              offers to start something, and is the node it belongs to holding
 *              no agent?
 *
 * A driver that only knew the declared selectors would report "the product
 * cannot start an agent" the first time somebody renamed a class, which trains
 * everyone to ignore it. A driver that only guessed behaviourally would drift
 * until it was measuring the wrong control. Which one matched is printed, so a
 * run that passed on the fallback is visibly a run that passed on the fallback.
 */
const CONTRACT = Object.freeze({
  route: '#/computers',
  root: '.computers',
  /* Settled on disk today: src/views/computers.js:1886 and
     src/first-run-needs.js's hostAbsentMarkup(). */
  emptyState: '.graph-empty, [data-host-absent="true"], .projection-unavailable',
  /* Settled: src/tree-graph.js:366. Every node, filled or not. */
  node: '.static-tree-node, .node[data-agent-id], [data-tree-node]',
  /* THE EMPTY SLOT, and note what it is NOT: it deliberately carries no
     `.static-tree-node`, no `.node` and no role class, because that class means
     "a running agent" to nine harnesses on this tree and one of them asserts
     every such node has a role hue. So `node` above and `emptyNode` here are
     genuinely different things, not two spellings of one. */
  emptyNode: [
    'button.tree-chat-add',
    'button.tree-empty-node',
    '[data-empty-slot]',
    '[data-empty-kind]',
    '[data-node-kind="empty"]',
    '[data-empty-node]',
    '.tree-empty-node',
    '.tree-node-empty',
  ].join(', '),
  /* The right-side panel. src/agent-compose-panel.js is the real one and its
     first two selectors are declared; OPEN IS EXPRESSED BY PRESENCE there --
     there is no closed-but-mounted state, cancel removes the element -- so
     "present and visible" is the whole of the open test. `.rail` is included
     last because the fleet page's existing right-hand column is one, and a
     panel that lands inside it must still be found. */
  /* AN ORDERED LIST, NOT A SET, AND THAT IS LOAD-BEARING.
     The compose panel mounts INSIDE the fleet page's existing right-hand rail.
     A single comma-joined selector returns document order, so the rail -- an
     ancestor, and always present -- won every match, and the driver went on to
     read the rail's own chat textarea as "the message field". It reported a
     panel that opens on a press for a panel that was already open, and a
     message field belonging to something else entirely. Measured: it passed
     "pressing an empty node opens a panel" while the press did nothing.
     So the list is tried in order and the first selector with a visible match
     wins, most specific first, and the always-present rail is not on it. */
  panel: Object.freeze([
    '[data-agent-compose="open"]',
    'section.agent-compose',
    '[data-compose-panel]',
    '.agent-compose-panel',
    '.compose-panel',
    '[data-start-panel]',
    '.start-panel',
  ]),
  role: [
    '[data-compose-field="role"]',
    '[data-compose="role"]',
    '[data-role-choice]',
    'select[name="role"]',
    '[role="radiogroup"]',
    'input[name="role"]',
    'select[data-launch="tier"]',
    'select[name="tier"]',
  ].join(', '),
  tier: '[data-compose-field="tier"]',
  message: [
    '[data-compose-field="message"]',
    '[data-compose="message"]',
    'textarea[name="message"]',
    'textarea[name="text"]',
    'textarea[name="brief"]',
    '[data-compose-message]',
    'textarea',
  ].join(', '),
  submit: [
    '[data-compose-action="start"]',
    '[data-compose="submit"]',
    '[data-start-submit]',
    'button[type="submit"]',
    'button[data-launch="dispatch"]',
  ].join(', '),
  /* Where a refusal sentence lands. `[data-compose-notice="panel"]` is the
     compose panel's own sink for a start the CALLER reported as failed; the
     rest are real sinks elsewhere in this tree (src/write-surfaces.js,
     src/agent-session.js, src/views/computers.js), so a wiring lane that
     reuses any of them is found rather than missed. */
  output: [
    '[data-compose-notice="panel"]',
    /* The fleet page's own result line, set through setOrgStatus(). It is the
       element that carries `data-refusal-code` for this flow -- the panel
       deliberately names no refusal, because a component that performs no
       action has none to name. */
    '.computers .org-status',
    '[data-compose-problem]',
    '[data-compose-status="panel"]',
    '[data-compose="out"]',
    '[data-start-output]',
    '[data-action-output]',
    '[data-session-status]',
    'output[role="status"]',
    '[data-launch="out"]',
  ].join(', '),
  /* How a node says which session it became. */
  sessionAttributes: ['data-session-id', 'data-session', 'data-agent-session'],
  /* How a node says it is running (src/tree-graph.js:408-419 already writes the
     first one). */
  runningMarkers: ['data-runtime-state="running"', '[data-state="running"]', '.is-running', '.spawning'],
  /* An accessible name that offers to begin something. Used ONLY by the
     behavioural fallback. */
  startWording: /\b(empty|start|begin|add|new|create|hire|spawn)\b/i,
})

const FLEET_ROUTE = Object.freeze({ hash: CONTRACT.route, route: 'computers', pageSelector: CONTRACT.root })
const HOME_ROUTE = Object.freeze({ hash: '#/', route: 'home', pageSelector: '.home' })
const FLEET_ACTIVE_EXPRESSION = activeRouteExpression(FLEET_ROUTE)
const HOME_ACTIVE_EXPRESSION = activeRouteExpression(HOME_ROUTE)
const fleetPanelExpression = ({ switchedOn = false } = {}) => activeRouteDescendantExpression({
  ...FLEET_ROUTE,
  descendantSelectors: CONTRACT.panel,
  /* The panel always owns this button, but hides it once the switch's write has
     taken. Waiting for the visible pre-switch control to disappear proves the
     remounted panel reached its new semantic state rather than merely existing. */
  forbiddenVisibleSelector: switchedOn ? '[data-compose-unavailable-action="panel"]' : '',
})

/* ---------- verdicts ----------
 *
 * THREE OUTCOMES, NOT TWO, AND `pending` IS NOT A SKIP. An assertion that could
 * not be exercised is reported by name and forces a non-zero exit. The one
 * thing this file must never do is let an unexercised assertion read like a
 * satisfied one -- that is the failure mode the whole packaged-QA effort exists
 * to stop. */
const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), state: ok ? 'ok' : 'fail', detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  return Boolean(ok)
}
function pending(name, why) {
  checks.push({ name, ok: false, state: 'pending', detail: why })
  console.log(`  ....  ${name}  -- NOT EXERCISED: ${why}`)
  return false
}

const STARTED_AT = Date.now()

function report() {
  const failed = checks.filter(entry => entry.state === 'fail')
  const notRun = checks.filter(entry => entry.state === 'pending')
  const passed = checks.length - failed.length - notRun.length
  /* THE DURATION IS EVIDENCE, not decoration: a run that got faster by a factor
     of ten is a run that stopped doing something. */
  console.log(`\n${passed}/${checks.length} checks passed in ${((Date.now() - STARTED_AT) / 1000).toFixed(1)}s`)
  for (const entry of failed) console.log(`  FAILED:        ${entry.name}${entry.detail ? `  -- ${entry.detail}` : ''}`)
  for (const entry of notRun) console.log(`  NOT EXERCISED: ${entry.name}  -- ${entry.detail}`)
  if (failed.length > 0) return 1
  if (notRun.length > 0) return 3
  return 0
}

/* A failure of the probe is not a finding about the product. */
class HarnessError extends Error {}

/* ---------- stage a real packaged copy ----------
 *
 * Borrows the built binary and swaps in the CURRENT dist/ and shell/, so this
 * measures the working tree inside a real packaged artifact rather than whenever
 * release/ was last built. Writes nothing under release/. Deliberately NOT
 * electron-builder: three lanes had node_modules damaged by it writing through
 * a worktree junction in one day. */
async function stage(scratch) {
  const complete = buildCompleteness(RELEASE)
  const app = complete.ok
    ? await stageFromBuild(scratch)
    : stageFromElectron(scratch, complete)
  const payload = await stagePayload(scratch, app.root)
  return { executable: appExecutable(app.root), app: app.root, origin: app.origin, payload }
}

/* IS THIS A BUILD, OR THE WRECKAGE OF ONE?
 *
 * MEASURED, not assumed, because assuming cost this driver its first run. The
 * app.asar at release/win-unpacked was present and correct and the launcher
 * still died in 310ms with "Invalid file descriptor to ICU data received",
 * because icudtl.dat, resources.pak, the v8 snapshots and locales/ were not in
 * the directory at all. An electron-builder output missing its runtime data is
 * not a slow app or a bad environment; it is not an application. The
 * distinction matters here specifically: without this check the symptom is a
 * startup crash, and a startup crash reads exactly like the product being
 * broken by whatever the driver just did to its environment. */
function buildCompleteness(release) {
  const missing = ['resources/app.asar', 'icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin', 'locales']
    .filter(leaf => !existsSync(path.join(release, ...leaf.split('/'))))
  return { ok: missing.length === 0, missing, release }
}

async function stageFromBuild(scratch) {
  const asar = require_(path.join(REPO_ROOT, 'node_modules', '@electron', 'asar'))
  const root = path.join(scratch, 'app')
  const unpacked = path.join(scratch, 'asar-stage')
  cpSync(RELEASE, root, { recursive: true, dereference: true })
  asar.extractAll(path.join(root, 'resources', 'app.asar'), unpacked)
  for (const directory of ['dist', 'shell']) {
    const from = path.join(REPO_ROOT, directory)
    if (!existsSync(from)) throw new HarnessError(`${directory}/ is missing; run \`npm run build\` first`)
    rmSync(path.join(unpacked, directory), { recursive: true, force: true })
    cpSync(from, path.join(unpacked, directory), { recursive: true })
  }
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(unpacked, 'package.json'))
  assertStagedRendererConsistent({ stagedDist: path.join(unpacked, 'dist'), sourceDist: path.join(REPO_ROOT, 'dist') })
  await asar.createPackage(unpacked, path.join(root, 'resources', 'app.asar'))
  return { root, origin: `the packaged build at ${RELEASE}, with this tree's dist/ and shell/ swapped in` }
}

/* THE FALLBACK, AND WHAT IT DOES AND DOES NOT MEASURE.
 *
 * The same Electron runtime the build pins, running the same three things the
 * build ships and nothing else: `build.files` in package.json is
 * ['dist/**','shell/**','!tools/**','!node_modules/**'], and every non-relative
 * require in shell/ resolves to a node builtin or to 'electron'. So the code
 * under the window here is the code that ships, byte for byte, and the
 * capability payload beside it is staged by the build's own staging step.
 *
 * WHAT IS NOT MEASURED: asar packing, the renamed launcher, the installer, the
 * signature, and anything electron-builder does on the way past. Those belong to
 * tools/check-asar-manifest.mjs and tools/smoke-packaged.mjs, and this driver
 * says out loud that it did not measure them rather than quietly implying it
 * did. Refusing to run at all was the other option and it is the worse one: the
 * question "can a person start an agent" then goes unanswered for as long as
 * somebody else's build is broken. */
function stageFromElectron(scratch, complete) {
  const electronDist = path.dirname(require_('electron'))
  if (!existsSync(path.join(electronDist, 'icudtl.dat'))) {
    throw new HarnessError(
      `${complete.release} is missing ${complete.missing.join(', ')} and the installed electron at ${electronDist} is not complete either`,
    )
  }
  const root = path.join(scratch, 'app')
  cpSync(electronDist, root, { recursive: true, dereference: true })
  const appDirectory = path.join(root, 'resources', 'app')
  mkdirSync(appDirectory, { recursive: true })
  for (const directory of ['dist', 'shell']) {
    const from = path.join(REPO_ROOT, directory)
    if (!existsSync(from)) throw new HarnessError(`${directory}/ is missing; run \`npm run build\` first`)
    cpSync(from, path.join(appDirectory, directory), { recursive: true })
  }
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(appDirectory, 'package.json'))
  assertStagedRendererConsistent({ stagedDist: path.join(appDirectory, 'dist'), sourceDist: path.join(REPO_ROOT, 'dist') })
  return {
    root,
    origin: `THE INSTALLED ELECTRON RUNTIME, because ${complete.release} is not a runnable build`
      + ` (missing ${complete.missing.join(', ')}). Renderer, shell and payload are the shipped ones;`
      + ' asar packing, the launcher and the installer are NOT measured by this run.',
  }
}

/* THE CAPABILITY PAYLOAD THE START PATH ACTUALLY LOADS.
 *
 * shell/agent-host.cjs resolves the engine out of `resources/capability`, so a
 * stale payload means this driver measures an old engine and reports about a
 * build nobody is going to ship. Staging a fresh one with the build's own
 * staging step is what makes this a statement about the NEXT build.
 *
 * Falling back rather than refusing, and SAYING SO: a checkout that cannot run
 * the staging step can still measure the payload the build already carries, as
 * long as the report names which one it measured. A silent substitution would
 * be the defect this whole file is about, one layer up. */
async function stagePayload(scratch, app) {
  const target = path.join(app, 'resources', 'capability')
  const fresh = path.join(scratch, 'capability')
  try {
    await execFile(
      process.execPath,
      [path.join(REPO_ROOT, 'tools', 'pack-capability-layer.mjs'), '--out', fresh, '--quiet'],
      { cwd: REPO_ROOT, timeout: 240_000, windowsHide: true },
    )
    rmSync(target, { recursive: true, force: true })
    cpSync(fresh, target, { recursive: true })
    return { origin: 'staged now by the build\'s own staging step', root: target }
  } catch (error) {
    if (!existsSync(path.join(target, 'PAYLOAD.json'))) {
      throw new HarnessError(
        `staging the capability payload failed (${String(error.message).split('\n')[0]}) and ${RELEASE} carries none either`,
      )
    }
    return {
      origin: 'the payload already inside the build (staging failed; this may be older than the source)',
      root: target,
    }
  }
}

/* THE TWO GUARDS THAT USED TO LIVE HERE NOW LIVE IN tools/lib/staged-renderer.mjs.
 *
 * They were written here first -- "is the bundle newer than the source it is
 * built from" and "did the copy of it arrive in one piece" -- and then TWENTY-FIVE
 * other harnesses in this directory turned out to stage dist/ exactly the same
 * way and to be exposed to exactly the same two failures. Copying the pair into
 * each of them would have produced twenty-six guards that drift apart, so they
 * were extracted verbatim and every stager now calls the same module. Read that
 * file's header for the two measured incidents behind them.
 *
 * The behaviour a reader of this file needs to know: both refuse with exit 2 and
 * print under HARNESS REFUSAL, which is the same class this driver's own
 * HarnessError maps to. Neither can ever produce a verdict about the product. */
/* FIND THE BINARY, DO NOT NAME IT. The product has been renamed once already
   and a hardcoded name is guaranteed to be wrong for somebody. The launcher is
   the only executable directly in the app root. */
/* THE RULE IS THE SHARED ONE; ONLY THE ERROR CLASS IS THIS DRIVER'S. Its own
   copy read `.exe` out of the app root, so on Linux it refused with "no .exe in
   the staged app" before it had measured anything (observed 2026-09-11 in the
   first Linux packaged-QA run). The answer now comes from
   tools/lib/packaged-platform.mjs, which knows both shapes. The re-throw is not
   decoration: a plain Error out of this function prints as an ordinary failure
   and would read as a verdict about the product, while HarnessError prints
   under HARNESS REFUSAL, which is what a harness that could not stage is. */
function appExecutable(appRoot) {
  try { return packagedAppExecutable(appRoot) }
  catch (error) { throw new HarnessError(error.message) }
}

/* ---------- the environment that makes a resolved start harmless ----------
 * Everything the provider gateway uses to find a CLI is removed; everything
 * Windows itself needs is kept. See the header for why system32 stays. */
function providerlessEnvironment(profile) {
  /* The homes come from the one shared helper (tools/lib/sterile-launch.cjs):
     APPDATA, LOCALAPPDATA, USERPROFILE, CODEX_HOME and TEMP inside the scratch
     profile, HOME/HOMEDRIVE/HOMEPATH gone, and ELECTRON_RUN_AS_NODE deleted --
     set, the Electron binary runs headless as Node, exits 0, and is
     indistinguishable from a crash. What this harness adds on top is the
     PROVIDERLESS part: no PATH but the system's, and no engine variable. */
  const environment = sterileLaunchEnvironment(prepareSterileProfile(qaProfileDirectories(profile)))
  mkdirSync(userDataFor(profile), { recursive: true })
  for (const key of Object.keys(environment)) {
    if (/^(path|mission_control_engine)$/i.test(key)) delete environment[key]
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  environment.PATH = [
    path.join(systemRoot, 'system32'),
    systemRoot,
    path.join(systemRoot, 'System32', 'Wbem'),
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  ].join(';')
  /* THE WINDOW STAYS OFF THE OWNER'S DESKTOP unless he asked for it.
     windowsHide suppresses a console and nothing else; the BrowserWindow is
     hidden by this exact string and nothing else (shell/window-options.cjs), so
     it is set here rather than assumed to be inherited from a suite runner. */
  if (VISIBLE) delete environment.MC_SMOKE_HEADLESS
  else environment.MC_SMOKE_HEADLESS = '1'
  return environment
}

/* THE RECORDED PERMISSION LEVEL, so the launch opens on the fleet instead of
   parking on the first-run question. This is what a person has the moment after
   first run, which is the state the fleet page's empty state is ABOUT. The
   fleet profile is left untouched: that is the "no trees" half. */
function seedMachineRecord(profile, appRoot, payloadRoot, tier = 'guided') {
  const productDirectory = machineRecordProductDirectory(profile)
  const servicesRoot = path.join(profile, 'local', productDirectory)
  const workspace = path.join(profile, 'home', productDirectory)
  mkdirSync(servicesRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  /* From the PAYLOAD the app will load, not from the repository: a record built
     by one copy of the module and read by another is two products pretending to
     be one. Falls back to the checkout's staged payload if the app's cannot be
     required. */
  const candidates = [
    path.join(payloadRoot, 'src', 'lib', 'setup', 'machine-record.js'),
    path.join(REPO_ROOT, 'capability', 'src', 'lib', 'setup', 'machine-record.js'),
  ].filter(existsSync)
  if (candidates.length === 0) throw new HarnessError('no machine-record.js in the payload or the checkout')
  const machineRecord = require_(candidates[0])
  /* THE RUNTIME IS SEEDED WRONG ON PURPOSE, AND THAT IS THE WHOLE POINT.
   *
   * This used to seed `process.execPath` -- the NODE running this harness --
   * which is a runtime that executes a script argument, so every generated
   * document worked here and the defect a real installation had was invisible to
   * every driven run in this directory. A real setup runs INSIDE the app, so
   * resolveNodePath() records the application's own Electron binary; and it
   * records it ONCE, so a person who has ever updated or reinstalled is left
   * with a document naming an executable that is not the one now running.
   *
   * So the seed is a real file, named the way this product's binary is named,
   * belonging to no build. It must exist, because generateMcpConfig refuses a
   * runtime that is not on the computer -- which is exactly the check that was
   * mistaken for "the recorded runtime is still right". What the run then
   * asserts is that the document names the STAGED executable anyway, and that
   * the servers it configures actually answer. */
  const olderInstall = path.join(profile, 'an-older-install')
  mkdirSync(olderInstall, { recursive: true })
  const stranded = path.join(olderInstall, 'ToolsEnabled.exe')
  writeFileSync(stranded, 'a previous installation of this product; only its name and existence matter')
  const record = machineRecord.buildMachineRecord({
    tier,
    servicesRoot,
    installRoot: path.join(appRoot, 'resources', 'capability'),
    nodePath: stranded,
    workspaceRoots: [workspace],
  })
  machineRecord.writeMachineRecord(record, { servicesRoot })
  return servicesRoot
}

/* ---------- WHAT APPEARED ON THE SCREEN, AND WHO PUT IT THERE ----------
 *
 * THE COMPLAINT THIS INSTRUMENT EXISTS FOR: "every time I launch an agent a cmd
 * window and another ToolsEnabled instance pops up that looks outdated."
 *
 * WHY IT IS A CENSUS AND NOT A FLAG CHANGE. Two candidate causes were on the
 * table and NEITHER was proved: the product's own spawn seam already refuses
 * `shell: true`, forces `windowsHide` and resolves the npm launcher to the
 * native binary, so "add a flag" would have been a guess dressed as a fix. A
 * window has an owning process, that process has a command line, and a command
 * line is an answer. So this enumerates top-level windows before the start and
 * again after it, and reports every NEW one with its class, its owning pid, that
 * process's executable and FULL command line, and its parent's -- because a
 * console window on Windows 10+ is owned by conhost.exe and the parent is the
 * program that actually asked for it.
 *
 * INVISIBLE WINDOWS ARE COUNTED TOO, and that is not thoroughness for its own
 * sake: this harness sets MC_SMOKE_HEADLESS=1 so nothing lands on the owner's
 * desktop, which hides exactly the window under investigation. `visible` is
 * reported as a field rather than used as a filter.
 *
 * IT REPORTS EVERY NEW WINDOW, never stopping at the first: the two candidates
 * are not mutually exclusive, and a census that stops at one of them cannot say
 * so. */
const WINDOW_CENSUS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class StartFlowWindows {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  public class W { public long Hwnd; public string Class; public string Title; public uint Pid; public bool Visible; }
  public static List<W> All() {
    var found = new List<W>();
    EnumWindows((h, p) => {
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      var txt = new StringBuilder(512); GetWindowTextW(h, txt, 512);
      uint pid = 0; GetWindowThreadProcessId(h, out pid);
      found.Add(new W { Hwnd = h.ToInt64(), Class = cls.ToString(), Title = txt.ToString(), Pid = pid, Visible = IsWindowVisible(h) });
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$processes = @{}
foreach ($process in Get-CimInstance Win32_Process) { $processes[[uint32]$process.ProcessId] = $process }
$census = foreach ($window in [StartFlowWindows]::All()) {
  $owner = $null
  if ($processes.ContainsKey($window.Pid)) { $owner = $processes[$window.Pid] }
  $parent = $null
  if ($owner -ne $null -and $processes.ContainsKey([uint32]$owner.ParentProcessId)) { $parent = $processes[[uint32]$owner.ParentProcessId] }
  [pscustomobject]@{
    hwnd = $window.Hwnd
    class = $window.Class
    title = $window.Title
    visible = [bool]$window.Visible
    pid = [int]$window.Pid
    name = if ($owner) { $owner.Name } else { $null }
    exe = if ($owner) { $owner.ExecutablePath } else { $null }
    commandLine = if ($owner) { $owner.CommandLine } else { $null }
    parentPid = if ($owner) { [int]$owner.ParentProcessId } else { 0 }
    parentName = if ($parent) { $parent.Name } else { $null }
    parentCommandLine = if ($parent) { $parent.CommandLine } else { $null }
  }
}
if ($census -eq $null) { '[]' } else { $census | ConvertTo-Json -Depth 4 -Compress }
`

function windowCensus() {
  const answered = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOW_CENSUS_SCRIPT],
    { windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })
  if (answered.error || typeof answered.stdout !== 'string') return null
  try {
    const parsed = JSON.parse(answered.stdout.trim() || '[]')
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return null
  }
}

/* Poll rather than sample once. A window that a session opens arrives whenever
   the process that opens it gets there, and a single snapshot at an arbitrary
   moment answers "no window" for anything slower than the harness. Every census
   is unioned, so a window that opens AND CLOSES inside the budget is still
   reported -- a flash is the complaint, not a steady-state. */
async function watchForNewWindows(before, budgetMs) {
  const known = new Set((before || []).map(window => window.hwnd))
  const found = new Map()
  const started = Date.now()
  let censusFailed = before === null
  do {
    const now = windowCensus()
    if (now === null) censusFailed = true
    else for (const window of now) if (!known.has(window.hwnd) && !found.has(window.hwnd)) found.set(window.hwnd, window)
    if (Date.now() - started >= budgetMs) break
    await delay(1_000)
  } while (Date.now() - started < budgetMs)
  return { windows: [...found.values()], censusFailed, watchedMs: Date.now() - started }
}

/* WHOSE WINDOW IS IT? A whole-desktop census is the right instrument -- the
 * window under investigation may be owned by conhost.exe, which is nobody's
 * descendant -- but it also sees every other program on the machine. MEASURED
 * 2026-08-18: a run of this file reported one new visible Chrome_WidgetWin_1,
 * and its command line named another lane's browser profile and a page it had
 * been told to open. Reporting that as "starting an agent opened a window" would
 * be a false finding of exactly the kind this file exists to prevent.
 *
 * So a new window is THIS RUN'S if its owning process is inside the app's own
 * process tree, or if anything about that process names this run's scratch
 * directory -- which covers a grandchild started outside the tree. Everything
 * else is still PRINTED, in full, and simply does not decide the check. */
function windowIsFromThisRun(window, pids, scratch) {
  if (pids.has(window.pid)) return true
  const haystack = `${window.exe || ''} ${window.commandLine || ''} ${window.parentCommandLine || ''}`.toLowerCase()
  return haystack.includes(scratch.toLowerCase())
}

function descendantPids(root) {
  const answered = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Depth 2 -Compress'],
    { windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })
  let all = []
  try { all = JSON.parse(answered.stdout) } catch { return new Set(root ? [root] : []) }
  const children = new Map()
  for (const entry of all) {
    if (!children.has(entry.ParentProcessId)) children.set(entry.ParentProcessId, [])
    children.get(entry.ParentProcessId).push(entry.ProcessId)
  }
  const seen = new Set(root ? [root] : [])
  const stack = [...seen]
  while (stack.length > 0) {
    for (const child of children.get(stack.pop()) || []) {
      if (seen.has(child)) continue
      seen.add(child)
      stack.push(child)
    }
  }
  return seen
}

function describeWindow(window) {
  const lines = [
    `class=${window.class} visible=${window.visible} title=${JSON.stringify(window.title || '')}`,
    `      owner pid ${window.pid} ${window.name || '(unknown)'} -- ${window.exe || '(no image path)'}`,
    `      command line: ${window.commandLine || '(unreadable)'}`,
  ]
  if (window.parentName) lines.push(`      started by pid ${window.parentPid} ${window.parentName}: ${window.parentCommandLine || '(unreadable)'}`)
  return lines.join('\n')
}

/* ---------- CONFIGURED IS NOT CONNECTED ----------
 *
 * THE DEFECT THIS EXISTS TO CATCH, WHICH EVERY EXISTING CHECK PASSED THROUGH.
 * The generated `.mcp.json` named this application's own Electron binary as the
 * program that runs each MCP server. An Electron binary handed a .js argument
 * without ELECTRON_RUN_AS_NODE ignores the argument and boots the whole
 * application, so all three servers were second copies of the app: they never
 * spoke a byte of stdio JSON-RPC and every app-started agent session ran with
 * NONE of this product's own tools. Nothing anywhere went red. The document
 * existed, named real files, and was correct in every property anyone had
 * thought to assert -- because "configured" had never been distinguished from
 * "connected".
 *
 * So this starts each server EXACTLY as the document says to (command, args,
 * cwd, and the env the document carries, layered over the app's own launch
 * environment so the fence this harness puts around providers is not stepped
 * around) and speaks the protocol an agent CLI would: `initialize`, then
 * `tools/list`. The evidence is the advertised tool names. */
async function serverAnswers(entry, environment, budgetMs = 20_000) {
  const child = spawn(entry.command, entry.args || [], {
    cwd: entry.cwd,
    env: { ...environment, ...(entry.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const outcome = { pid: child.pid, tools: [], initialized: false, said: '', failed: null }
  child.on('error', error => { outcome.failed = error.message })
  let buffered = ''
  const seen = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffered += chunk
    const lines = buffered.split('\n')
    buffered = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try { seen.push(JSON.parse(line)) } catch { /* a server may log; only JSON-RPC counts */ }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { outcome.said = (outcome.said + chunk).slice(-800) })

  const say = message => { try { child.stdin.write(`${JSON.stringify(message)}\n`) } catch { /* dead */ } }
  const waitFor = async (id, ms) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const answer = seen.find(message => message.id === id)
      if (answer) return answer
      if (child.exitCode !== null) return null
      await delay(200)
    }
    return null
  }

  try {
    say({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-start-flow-qa', version: '1' } } })
    const ready = await waitFor(1, budgetMs / 2)
    outcome.initialized = Boolean(ready && ready.result)
    if (outcome.initialized) {
      say({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
      say({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      const listed = await waitFor(2, budgetMs / 2)
      const tools = listed?.result?.tools
      if (Array.isArray(tools)) outcome.tools = tools.map(tool => tool.name).filter(name => typeof name === 'string')
    }
  } finally {
    try { child.kill() } catch { /* already gone */ }
    reap(child.pid)
  }
  return outcome
}

/* ---------- the debugger ---------- */
const ACTIVE_PORT_FILE = 'DevToolsActivePort'

async function publishedDebuggerPort(userDataDir, child, budgetMs) {
  const file = path.join(userDataDir, ACTIVE_PORT_FILE)
  const started = Date.now()
  while (Date.now() - started < budgetMs) {
    if (child.exitCode !== null) {
      throw new HarnessError(`the app exited with code ${child.exitCode} before it published a debugger port; a startup failure, not a slow paint`)
    }
    try {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0].trim())
      if (Number.isInteger(port) && port > 0) return port
    } catch { /* not written yet */ }
    await delay(200)
  }
  throw new HarnessError(`the app never wrote ${ACTIVE_PORT_FILE} within ${Math.round(budgetMs / 1000)}s, so its debugger never started`)
}

function createSession(child, userDataDir, say) {
  let socket = null
  let nextId = 1
  const pending_ = new Map()
  const events = []
  return {
    events,
    async open(budgetMs) {
      const started = Date.now()
      const port = await publishedDebuggerPort(userDataDir, child, budgetMs)
      say(`debugger published on 127.0.0.1:${port} after ${Date.now() - started}ms`)
      let lastSeen = 'the debugger endpoint never answered at all'
      while (Date.now() - started < budgetMs) {
        if (child.exitCode !== null) {
          throw new HarnessError(`the app exited with code ${child.exitCode} before the debugger answered; a startup failure, not a slow paint`)
        }
        try {
          const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
          const page = targets.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
          if (page) {
            socket = new WebSocket(page.webSocketDebuggerUrl)
            await new Promise((resolve, reject) => {
              socket.addEventListener('open', resolve, { once: true })
              socket.addEventListener('error', reject, { once: true })
            })
            socket.addEventListener('message', event => {
              const packet = JSON.parse(event.data)
              if (packet.id === undefined) { events.push(packet); return }
              const handler = pending_.get(packet.id)
              if (handler) { pending_.delete(packet.id); handler(packet) }
            })
            say(`attached to the window after ${Date.now() - started}ms`)
            return
          }
          lastSeen = targets.length
            ? `the endpoint answered with ${targets.length} target(s), none a debuggable page`
            : 'the endpoint answered with an EMPTY target list -- the process is up but no window opened'
        } catch (error) {
          lastSeen = `the endpoint refused the connection (${error?.cause?.code || error?.message || error})`
        }
        await delay(500)
      }
      throw new HarnessError(`no debuggable page within ${Math.round(budgetMs / 1000)}s and the app is still running -- ${lastSeen}`)
    },
    /* EVERY CALL HAS A CEILING, and that is not belt-and-braces.
       A Runtime.evaluate issued while the page is between documents is answered
       by nobody: the old execution context is gone and the new one has not been
       created, and the promise this returns simply never settles. Measured here
       -- the run hung silently and was killed by the suite's own timeout ten
       minutes later, which reports TIMEOUT and says nothing about which call
       stopped. A ceiling turns that into one sentence naming the method. */
    send(method, params = {}, budgetMs = 45_000) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending_.delete(id)
          reject(new HarnessError(`the window never answered ${method} within ${Math.round(budgetMs / 1000)}s`))
        }, budgetMs)
        pending_.set(id, packet => { clearTimeout(timer); resolve(packet) })
      })
    },
    /* An event that has arrived since `from`, waited for by polling the same
       buffer every other reader uses. */
    async waitForEvent(method, budgetMs, from = 0) {
      const started = Date.now()
      while (Date.now() - started < budgetMs) {
        for (let index = from; index < events.length; index += 1) {
          if (events[index]?.method === method) return true
        }
        await delay(100)
      }
      return false
    },
    close() { try { socket?.close() } catch { /* already gone */ } },
  }
}

/* QUIESCENCE IS MEASURED, NOT SLEPT THROUGH. A fixed sleep is too short under
   load and too long to live with; this waits for a window with no DOM mutations
   and reports whether it got one. Borrowed from tools/first-run-contract-qa.mjs,
   which learned it from a click that landed while the view was still building. */
const SETTLE = `((quietMs, budgetMs) => new Promise(resolve => {
  const started = Date.now()
  let lastMutation = Date.now()
  const observer = new MutationObserver(() => { lastMutation = Date.now() })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
  const tick = () => {
    if (Date.now() - lastMutation >= quietMs) { observer.disconnect(); resolve({ settled: true, waitedMs: Date.now() - started }); return }
    if (Date.now() - started >= budgetMs) { observer.disconnect(); resolve({ settled: false, waitedMs: Date.now() - started }); return }
    setTimeout(tick, 50)
  }
  setTimeout(tick, 50)
}))`

function reap(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 30_000 })
  } catch { /* the tree is already gone */ }
}

/* THE TWO ANSWERS AN UNATTENDED RUN CANNOT GIVE BY HAND.
 *
 * Both of these are DIALOGS WITH A BUTTON, not refusals, and a driver has no
 * hand to press them:
 *
 *   mc.warn.elevated-run  -- the elevated-run warning. MEASURED: with this
 *     unseeded the chain reaches showElevatedRunWarning() and stops there, so
 *     createWindow() is never called and NO BrowserWindow EVER APPEARS. It reads
 *     exactly like the app hanging at startup; it is a modal nobody clicked.
 *   mc.update.policy      -- the "Check for updates?" launch question
 *     (shell/update-check.cjs, values ask/always/never, default ask). Unseeded,
 *     an unattended launch waits behind it indefinitely.
 *
 * Seeded here rather than in a wrapper because they belong to the PROFILE this
 * driver creates, and a driver that cannot start the app it is testing measures
 * nothing. Neither value changes any behaviour under test: one suppresses a
 * warning about how the process was launched, the other declines an update
 * check. */
function seedUnattendedPrefs(profile) {
  const userData = userDataFor(profile)
  mkdirSync(userData, { recursive: true })
  writeFileSync(path.join(userData, 'renderer-prefs.json'), JSON.stringify({
    storageVersion: 1,
    values: { 'mc.warn.elevated-run': 'off', 'mc.update.policy': 'never' },
    drainedOrigins: [],
  }))
}

async function openApp(executable, profile, say) {
  const environment = providerlessEnvironment(profile)
  const userData = userDataFor(profile)
  /* THE TWO OCCLUSION FLAGS ARE CORRECTNESS HERE, NOT TIDINESS.
   *
   * Chromium throttles a window it believes is hidden or covered, and on this
   * machine that means page timers stop: a 200 ms setTimeout measured as not
   * having fired after 75 seconds. This driver launches with the console hidden
   * and the window unattended, which is exactly that state.
   *
   * WHAT IT COSTS TO OMIT THEM, measured today by another lane: the held-start
   * retry schedule IS page setTimeouts, it stalled at attempt 2 of 6 after 265
   * seconds, the bound was never reached, and a defect was filed saying the
   * product never says it gave up. It does say it -- the timers were frozen.
   * That defect was withdrawn.
   *
   * So a driver that exercises anything timed must disable the throttling, or it
   * reports product behaviour wrongly and always in the same direction: "it
   * never happened". An account retry is timed, which is why this matters to the
   * start flow specifically. */
  const child = spawn(executable, [
    `--user-data-dir=${userData}`,
    '--remote-debugging-port=0',
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
  ], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

  const noise = []
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', chunk => { noise.push(chunk); while (noise.length > 400) noise.shift() })
  }
  child.on('error', error => noise.push(`[spawn error] ${error.message}\n`))

  const session = createSession(child, userData, say)
  const teardown = async () => {
    session.close()
    try { child.kill() } catch { /* already gone */ }
    reap(child.pid)
    await delay(300)
  }

  try {
    await session.open(OPEN_BUDGET_MS)
  } catch (error) {
    if (error instanceof HarnessError) {
      const said = noise.join('').trim()
      error.message += said
        ? `\n  the app said:\n${said.split('\n').map(line => `    | ${line}`).join('\n')}`
        : '\n  the app said nothing on stdout or stderr'
    }
    await teardown()
    throw error
  }

  await session.send('Runtime.enable')
  await session.send('Page.enable')

  /* A ROUTE THAT THROWS OFTEN STILL "RENDERS": an empty wrapper, no error on
     the screen, nothing a DOM assertion can see. The page's own exceptions are
     the only witness, and without them "the fleet page never rendered" is the
     same sentence for a crashed view, an unanswered first-run question and a
     route this build does not offer. */
  const thrown = []
  const originalPush = session.events.push.bind(session.events)
  session.events.push = packet => {
    if (packet?.method === 'Runtime.exceptionThrown') {
      const detail = packet.params?.exceptionDetails
      thrown.push(String(detail?.exception?.description || detail?.text || 'unknown exception').split('\n').slice(0, 4).join(' | '))
    }
    return originalPush(packet)
  }

  const evaluate = async expression => {
    const packet = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (packet.result?.exceptionDetails) {
      throw new HarnessError(packet.result.exceptionDetails.exception?.description || 'evaluate failed')
    }
    return packet.result?.result?.value
  }
  const settle = (quietMs = 450, budgetMs = 12_000) => evaluate(`${SETTLE}(${quietMs}, ${budgetMs})`)
  const until = async (expression, budgetMs) => {
    const started = Date.now()
    while (Date.now() - started < budgetMs) {
      if (await evaluate(expression)) return true
      await delay(200)
    }
    return false
  }

  /* REBUILDING THE VIEW WITHOUT RELOADING THE DOCUMENT.
   *
   * The obvious way to rebuild a defect is Page.addScriptToEvaluateOnNewDocument
   * plus Page.reload, and it is the way the first version of this file did it.
   * MEASURED, three runs: Page.reload is never answered by this window, and
   * every Runtime.evaluate after it is never answered either -- the run hangs
   * until something kills it. So the document is left alone and the VIEW is
   * rebuilt instead, which is all that is needed: src/main.js's swapView()
   * constructs a fresh view on every route change and retires the old one, so
   * navigating away and back builds the fleet page again from nothing, with
   * whatever mutation the control installed already watching.
   *
   * This is not a weaker control. What is being rebuilt is a page that offers
   * no pressable start affordance, and a page built that way from scratch is
   * exactly what the mutation produces. */
  /* Go to a route and WAIT FOR ITS VIEW, not for a number of milliseconds. The
     router mounts asynchronously through a view transition, so "the hash is set"
     and "the page is there" are different moments; measuring between them is
     how a harness reports a route that does not exist. */
  const goToFleet = async () => {
    await evaluate(`location.hash = ${JSON.stringify(FLEET_ROUTE.hash)}`)
    const arrived = await until(FLEET_ACTIVE_EXPRESSION, VIEW_BUDGET_MS)
    if (!arrived) return false
    await settle()
    return Boolean(await evaluate(FLEET_ACTIVE_EXPRESSION))
  }
  const renavigateFleet = async () => {
    await evaluate(`location.hash = ${JSON.stringify(HOME_ROUTE.hash)}`)
    const leftFleet = await until(HOME_ACTIVE_EXPRESSION, VIEW_BUDGET_MS)
    if (!leftFleet) return false
    await settle()
    if (!await evaluate(HOME_ACTIVE_EXPRESSION)) return false
    return goToFleet()
  }

  const measure = createCompositedPageMeasure({ session, evaluate })
  return { child, evaluate, measure, settle, until, goToFleet, renavigateFleet, teardown, noise, session, thrown }
}

/* ================= WHAT IS ON THE GLASS =================
 *
 * `visible` is MEASURED and `pressable` is HIT-TESTED. Text in the DOM is not
 * text on the screen -- a stylesheet that hides a row leaves every string
 * exactly where a textContent read finds it -- and an element on the screen is
 * not an element a person can press: something can be sitting on top of it.
 * document.elementFromPoint at the element's own centre is the question a mouse
 * asks, so it is the question this asks.
 */
const PAGE_HELPERS = `
  const norm = value => String(value || '').replace(/\\s+/g, ' ').trim()
  const clippedAway = node => {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      if (!/(auto|scroll|hidden)/.test(style.overflowY + style.overflowX)) continue
      const clip = parent.getBoundingClientRect()
      const box = node.getBoundingClientRect()
      if (Math.min(box.right, clip.right) - Math.max(box.left, clip.left) <= 1) return true
      if (Math.min(box.bottom, clip.bottom) - Math.max(box.top, clip.top) <= 1) return true
    }
    return false
  }
  const shown = node => {
    if (!node) return false
    /* The router keeps the retiring view connected for 420ms and marks its
       wrapper inert immediately. querySelector still finds that old copy
       first, but Chromium correctly removes its whole subtree from hit testing
       (elementFromPoint reaches the page root). It is not on the glass. */
    if (node.closest('[inert], [aria-hidden="true"]')) return false
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    if (!(box.width > 0 && box.height > 0)) return false
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (Number(style.opacity) === 0) return false
    return !clippedAway(node)
  }
  const enabled = node => !(node.disabled === true || node.getAttribute('aria-disabled') === 'true')
  /* PRESSABLE MEANS A MOUSE WOULD REACH IT. Nine points, not one: a circular
     node with a square box has corners that belong to whatever is behind it,
     and a single centre sample would be defeated by a badge sitting there. */
  const hitTest = node => {
    const box = node.getBoundingClientRect()
    const xs = [0.5, 0.35, 0.65]
    const ys = [0.5, 0.35, 0.65]
    let hits = 0
    let sample = ''
    for (const fx of xs) for (const fy of ys) {
      const x = box.left + box.width * fx
      const y = box.top + box.height * fy
      const at = document.elementFromPoint(x, y)
      if (!at) continue
      if (at === node || node.contains(at)) hits += 1
      else if (!sample) sample = (at.tagName || '?').toLowerCase() + (at.className && typeof at.className === 'string' ? '.' + at.className.split(/\\s+/).filter(Boolean).slice(0, 2).join('.') : '')
    }
    return { hits, total: xs.length * ys.length, blockedBy: sample }
  }
  const nameOf = node => norm(node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || node.textContent)
  const pressableFacts = node => {
    const hit = hitTest(node)
    return {
      visible: shown(node),
      enabled: enabled(node),
      hitHits: hit.hits,
      hitTotal: hit.total,
      blockedBy: hit.blockedBy,
      focusable: node.tagName === 'BUTTON' || node.tabIndex >= 0,
      role: node.getAttribute('role') || node.tagName.toLowerCase(),
      name: nameOf(node).slice(0, 120),
    }
  }
  const first = (scope, selector) => { try { return scope.querySelector(selector) } catch { return null } }
  const all = (scope, selector) => { try { return [...scope.querySelectorAll(selector)] } catch { return [] } }
`

/* The declared words, handed to the page so the probe can say whether what a
   person is reading is the product's own copy or something somebody typed
   twice. Read from src/fleet-tree-copy.js at import; never spelled out here. */
const DECLARED_COPY = Object.freeze({
  emptyTree: [EMPTY_TREE.title, EMPTY_TREE.body, EMPTY_TREE.hint],
  /* THE ACCESSIBLE NAME, AND ONLY THE TWO STRINGS THAT ARE ONE.
     EMPTY_NODE.hint and SECOND_TREE.help are TITLES, paired with these two, and
     are never accessible names -- a slot whose NAME came back as the hint would
     be a real defect, and a set that included the hint would wave it through.
     That is the difference between a check that is safe and one that is exact.
     The title pairing is asserted by the graph lane's own suite, so it is not
     asserted a second time here. */
  emptyNodeNames: [EMPTY_NODE.ariaLabel, SECOND_TREE.action, 'New tree or agent'],
  /* THE ROLES THIS PRODUCT ACTUALLY OFFERS. Used to tell the compose panel's
     role menu apart from the launch box's TIER menu, which the fallback
     selectors would otherwise accept as "a role to choose" -- an assistant tier
     and a role in a tree are different questions, and a driver that could not
     tell them apart would report the wrong control as satisfying the
     requirement. */
  roleKeys: ROLE_CHOICES.map(choice => choice.role),
  /* THE WORDS ON THE TWO BUTTONS. Worth asserting on the glass and not only in
     the panel's own unit suite: that suite proves the panel renders these, and
     this proves the thing a person actually presses IS that panel rather than
     something that resembles it. Read from the module, so a reworded button is
     a copy change and not a red run. */
  submitLabel: START_PANEL.submit,
  cancelLabel: START_PANEL.cancel,
})

function discoverScript() {
  return `(() => {
  ${PAGE_HELPERS}
  const C = ${JSON.stringify(CONTRACT)}
  const COPY = ${JSON.stringify(DECLARED_COPY)}
  const startWording = new RegExp(${JSON.stringify(CONTRACT.startWording.source)}, 'i')
  const root = all(document, C.root).find(shown) || null
  if (!root) {
    return { rootPresent: false, hash: location.hash, route: document.body.dataset.route || '', text: norm(document.body.innerText).slice(0, 4000) }
  }

  const emptyStateNode = first(root, C.emptyState)
  const nodes = all(root, C.node)
  const declaredEmpty = all(root, C.emptyNode)

  /* A NODE IS EMPTY WHEN IT HOLDS NO AGENT. Declared first; behaviourally
     second -- a node carrying no agent id, or one whose accessible name offers
     to begin something rather than naming somebody who already exists. */
  const declared = new Set(declaredEmpty)
  const behavioural = nodes.filter(node => {
    if (declared.has(node)) return false
    const id = node.getAttribute('data-agent-id')
    if (id !== null && id.trim() === '') return true
    return startWording.test(nameOf(node)) && !id
  })
  /* A pressable start affordance that is NOT a tree node at all -- an "add an
     agent" button somewhere on the page. Counted separately so the report can
     say which shape the product actually offers. */
  const looseAffordances = all(root, 'button, [role="button"], a[href]')
    .filter(node => !declared.has(node) && !behavioural.includes(node))
    .filter(node => startWording.test(nameOf(node)))
    .filter(node => shown(node) && enabled(node))
    .map(node => ({ ...pressableFacts(node), how: 'loose' }))
    .slice(0, 8)

  const describe = (node, how) => ({
    how,
    ...pressableFacts(node),
    agentId: node.getAttribute('data-agent-id'),
    className: typeof node.className === 'string' ? node.className.slice(0, 160) : '',
    sessionId: C.sessionAttributes.map(a => node.getAttribute(a)).find(v => v) || null,
    looksRunning: C.runningMarkers.some(marker => {
      try { return marker.startsWith('data-') ? node.matches('[' + marker + ']') : node.matches(marker) } catch { return false }
    }),
  })

  const filled = nodes.filter(node => {
    const id = node.getAttribute('data-agent-id')
    return typeof id === 'string' && id.trim().length > 0
  })

  const pageText = norm(root.innerText)
  return {
    rootPresent: true,
    rootVisible: shown(root),
    hash: location.hash,
    route: document.body.dataset.route || '',
    projectionState: root.dataset.projectionState || '',
    emptyState: emptyStateNode
      ? { present: true, visible: shown(emptyStateNode), text: norm(emptyStateNode.innerText).slice(0, 1200) }
      : { present: false, visible: false, text: '' },
    /* THE PRODUCT'S OWN EMPTY-STATE WORDS, ON THE GLASS OR NOT. A page whose
       empty state is the tree canvas itself rather than a panel still has to
       SAY that empty is normal, and this is how that is measured without this
       file owning a copy of the sentence. */
    declaredEmptyCopyShown: COPY.emptyTree.filter(line => line && pageText.includes(line)),
    /* Whether the affordance is the DECLARED one. An accessible name that is
       none of the product's own is a second start control nobody declared,
       which is how two lanes end up offering different doors to one action. */
    emptyNodeNamesDeclared: [...declaredEmpty, ...behavioural]
      .map(node => nameOf(node))
      .map(name => ({ name: name.slice(0, 120), declared: COPY.emptyNodeNames.some(known => known && name === known) })),
    nodeCount: nodes.length,
    filledCount: filled.length,
    filledNames: filled.slice(0, 12).map(node => nameOf(node).slice(0, 40)),
    emptyNodes: [
      ...declaredEmpty.map(node => describe(node, 'declared')),
      ...behavioural.map(node => describe(node, 'behavioural')),
    ],
    looseAffordances,
    /* Every visible sentence on the page, for the bare-code check and for a
       report that can say what a person was actually shown. */
    text: norm(root.innerText).slice(0, 8000),
    viewportWidth: window.innerWidth,
  }
})()`
}

/* PRESS IT. Resolved and pressed in ONE evaluation so nothing can replace the
   element between the look and the press -- the race that produced a "failure"
   nobody could reproduce in an earlier harness here. A real PointerEvent
   sequence, not a bare .click(), because a control bound to pointerdown is a
   control .click() would silently miss. */
function pressEmptyNodeScript() {
  return `(() => {
  ${PAGE_HELPERS}
  const C = ${JSON.stringify(CONTRACT)}
  const startWording = new RegExp(${JSON.stringify(CONTRACT.startWording.source)}, 'i')
  const root = all(document, C.root).find(shown) || null
  if (!root) return { pressed: false, why: 'the fleet page root is not on the glass' }
  const nodes = all(root, C.node)
  const declared = all(root, C.emptyNode)
  const behavioural = nodes.filter(node => {
    if (declared.includes(node)) return false
    const id = node.getAttribute('data-agent-id')
    if (id !== null && id.trim() === '') return true
    return startWording.test(nameOf(node)) && !id
  })
  const candidates = [...declared, ...behavioural].filter(node => shown(node) && enabled(node))
  if (candidates.length === 0) return { pressed: false, why: 'no visible, enabled empty node to press' }
  const node = candidates[0]
  const hit = hitTest(node)
  if (hit.hits === 0) {
    return { pressed: false, why: 'the empty node is on the glass but nothing reaches it; ' + (hit.blockedBy ? hit.blockedBy + ' is on top of it' : 'elementFromPoint found nothing') }
  }
  const box = node.getBoundingClientRect()
  const x = box.left + box.width / 2
  const y = box.top + box.height / 2
  const options = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  node.dispatchEvent(new PointerEvent('pointerdown', options))
  node.dispatchEvent(new MouseEvent('mousedown', options))
  node.dispatchEvent(new PointerEvent('pointerup', { ...options, buttons: 0 }))
  node.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons: 0 }))
  node.click()
  if (node.matches('.tree-chat-add')) {
    const choice = root.querySelector('.tree-new-tree')
    if (!choice || !shown(choice) || !enabled(choice) || hitTest(choice).hits === 0) {
      return { pressed: false, why: 'the header menu did not offer a reachable New tree action' }
    }
    choice.click()
  }
  return { pressed: true, name: nameOf(node).slice(0, 120), agentId: node.getAttribute('data-agent-id') }
})()`
}

/* THE SWITCH THE PANEL ITSELF NOW CARRIES.
 *
 * WHY THIS STEP EXISTS, with the commit that made it necessary. Starting an
 * assistant ships switched OFF (`mc.write.agent-session`), and until 0e43eb3
 * the compose panel said so and sent the person to Settings to find the remedy.
 * That commit moved the remedy INTO the panel: the person presses "Turn on
 * running agents" where they are standing, the flag is written by the click
 * handler and by nothing else, and the panel reopens over the same slot with
 * Start live.
 *
 * So on a fresh profile the panel's first frame legitimately has a disabled
 * Start and a message box nobody may type into. This driver read that frame and
 * reported "the panel offers no MESSAGE to write" and "no way to SEND it" --
 * three reds about a panel that was working exactly as designed, and a fourth
 * (the spawn ledger never recorded a start) that followed from never sending.
 * The question this file asks is unchanged and is now asked of the state a
 * person reaches: press the switch the product offers, then judge the panel.
 *
 * It is a NO-OP when the switch is absent, which is the case on any profile
 * where starting is already on -- and absence is reported rather than assumed,
 * so a build that loses the switch cannot pass this by silently skipping it. */
function pressComposeSwitchScript() {
  return `(() => {
  ${PAGE_HELPERS}
  const C = ${JSON.stringify(CONTRACT)}
  const root = all(document, C.root).find(shown) || null
  if (!root) return { pressed: false, why: 'the active fleet page is not on the glass' }
  const node = all(root, '[data-compose-unavailable-action="panel"]').find(shown) || null
  if (!node) return { pressed: false, why: 'the panel offers no switch (starting may already be on)' }
  if (!enabled(node)) return { pressed: false, why: 'the switch is on the glass but disabled' }
  const hit = hitTest(node)
  if (hit.hits === 0) {
    return { pressed: false, why: 'nothing reaches the switch; ' + (hit.blockedBy ? hit.blockedBy + ' is on top of it' : 'elementFromPoint found nothing') }
  }
  const box = node.getBoundingClientRect()
  const x = box.left + box.width / 2
  const y = box.top + box.height / 2
  const options = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  node.dispatchEvent(new PointerEvent('pointerdown', options))
  node.dispatchEvent(new MouseEvent('mousedown', options))
  node.dispatchEvent(new PointerEvent('pointerup', { ...options, buttons: 0 }))
  node.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons: 0 }))
  node.click()
  return { pressed: true, label: nameOf(node).slice(0, 60) }
})()`
}

/* THE PANEL, AND WHETHER IT OFFERS THE TWO THINGS A PERSON MUST SUPPLY. */
function readPanelScript() {
  return `(() => {
  ${PAGE_HELPERS}
  const C = ${JSON.stringify(CONTRACT)}
  const root = all(document, C.root).find(shown) || null
  if (!root) return { present: false }
  /* MOST SPECIFIC FIRST. See the note on CONTRACT.panel: a comma-joined
     selector hands back document order, which is ancestor-first, which is how
     a driver ends up reporting on the container instead of the panel. */
  const candidates = (() => {
    for (const selector of C.panel) {
      const found = all(root, selector).filter(shown)
      if (found.length > 0) return found
    }
    return []
  })()
  if (candidates.length === 0) return { present: false }
  const scored = candidates.map(panel => ({
    panel,
    role: first(panel, C.role),
    tier: first(panel, C.tier),
    message: first(panel, C.message),
    submit: all(panel, C.submit).filter(node => shown(node))[0] || null,
  }))
  const chosen = scored.find(entry => entry.message && entry.submit) || scored.find(entry => entry.submit) || scored[0]
  const panel = chosen.panel
  const box = panel.getBoundingClientRect()
  const describeControl = node => node ? {
    present: true, ...pressableFacts(node),
    tag: node.tagName.toLowerCase(),
    kind: node.tagName === 'SELECT' ? 'select' : (node.type || node.tagName.toLowerCase()),
    optionCount: node.tagName === 'SELECT' ? node.options.length : all(node, 'input[type="radio"], [role="radio"], option, [role="option"]').length,
    /* The real answers on offer, placeholder excluded. */
    values: node.tagName === 'SELECT'
      ? [...node.options].map(option => option.value).filter(value => value)
      : all(node, 'input[type="radio"], [role="radio"]').map(one => one.value || one.getAttribute('data-value') || '').filter(Boolean),
  } : { present: false, values: [] }
  const describeTier = node => {
    if (!node) return { present: false, options: [], selected: null }
    const options = [...node.options].map(option => ({
      value: option.value,
      label: norm(option.textContent),
      disabled: option.disabled === true,
    }))
    const selected = node.selectedIndex >= 0 ? options[node.selectedIndex] : null
    return {
      present: true,
      ...pressableFacts(node),
      value: node.value,
      allDisabled: options.length > 0 && options.every(option => option.disabled),
      selected,
      options,
    }
  }
  return {
    present: true,
    visible: shown(panel),
    /* "RIGHT-SIDE" IS GEOMETRY, not a class name. */
    onTheRight: (box.left + box.right) / 2 > window.innerWidth / 2,
    left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width),
    className: typeof panel.className === 'string' ? panel.className.slice(0, 160) : '',
    role: describeControl(chosen.role),
    tier: describeTier(chosen.tier),
    message: describeControl(chosen.message),
    submit: describeControl(chosen.submit),
    cancel: describeControl(first(panel, '[data-compose-action="cancel"]')),
    text: norm(panel.innerText).slice(0, 2000),
  }
})()`
}

/* Fill the editable fields, then report the semantic Start state. This helper
   intentionally contains no click on the Start control: providerless UI QA is
   a readiness/refusal check, while the positive launch proof belongs to the
   mission-bridge API gate. */
function fillProviderlessPanelScript(nonce) {
  return `(() => {
  ${PAGE_HELPERS}
  const C = ${JSON.stringify(CONTRACT)}
  const nonce = ${JSON.stringify(nonce)}
  const root = all(document, C.root).find(shown) || null
  if (!root) return { submitted: false, why: 'the active fleet page is not on the glass' }
  const candidates = (() => {
    for (const selector of C.panel) {
      const found = all(root, selector).filter(shown)
      if (found.length > 0) return found
    }
    return []
  })()
  const scored = candidates.map(panel => ({
    panel, role: first(panel, C.role), message: first(panel, C.message),
    submit: all(panel, C.submit).filter(shown)[0] || null,
  }))
  const chosen = scored.find(entry => entry.message && entry.submit) || scored.find(entry => entry.submit)
  if (!chosen) return { submitted: false, why: 'no panel with a way to send anything' }

  let roleChosen = null
  const role = chosen.role
  if (role) {
    if (role.tagName === 'SELECT') {
      const option = [...role.options].find(o => o.value) || role.options[0]
      if (option) { role.value = option.value; roleChosen = option.value }
    } else {
      const pick = all(role, 'input[type="radio"], [role="radio"], button, [role="option"]').filter(shown)[0] || role
      if (pick.tagName === 'INPUT') { pick.checked = true; roleChosen = pick.value }
      else { pick.click(); roleChosen = nameOf(pick).slice(0, 60) }
    }
    role.dispatchEvent(new Event('input', { bubbles: true }))
    role.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const message = chosen.message
  if (!message) return { submitted: false, why: 'the panel offers no message field', roleChosen }
  message.focus()
  /* The native setter, so a framework that watches the property sees the write
     the same way it sees a keystroke. */
  const proto = message.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(message, nonce); else message.value = nonce
  message.dispatchEvent(new InputEvent('input', { bubbles: true, data: nonce, inputType: 'insertText' }))
  message.dispatchEvent(new Event('change', { bubbles: true }))
  if (message.value !== nonce) return { submitted: false, why: 'the message field would not take the text', roleChosen }

  const submit = chosen.submit
  const onGlass = shown(submit)
  const live = onGlass && enabled(submit)
  const hit = onGlass ? hitTest(submit) : { hits: 0, blockedBy: null }
  return {
    submitted: false,
    why: 'providerless QA does not press Start',
    roleChosen,
    messageAccepted: true,
    submitName: nameOf(submit).slice(0, 80),
    submitVisible: onGlass,
    submitEnabled: live,
    submitHitHits: hit.hits,
    submitBlockedBy: hit.blockedBy,
  }
})()`
}

const PROVIDERLESS_TIER_REASON = /\b(?:not installed|nobody is signed in|cannot start)\b/i

function providerlessPanelSettled(panel) {
  const selected = panel?.tier?.selected
  return panel?.present === true
    && panel?.submit?.present === true
    && panel.submit.enabled === false
    && panel?.tier?.allDisabled === true
    && selected?.disabled === true
    && PROVIDERLESS_TIER_REASON.test(selected?.label || '')
}

async function waitForProviderlessPanel(app) {
  const until = Date.now() + PROVIDER_SETTLE_BUDGET_MS
  let panel = { present: false }
  do {
    panel = await app.evaluate(readPanelScript())
    if (providerlessPanelSettled(panel)) return panel
    await delay(250)
  } while (Date.now() < until)
  return panel
}

/* WHAT THE PAGE SAID AFTERWARDS, and what the nodes look like now. */
function readOutcomeScript(nonce) {
  return `(() => {
  ${PAGE_HELPERS}
  const C = ${JSON.stringify(CONTRACT)}
  const nonce = ${JSON.stringify(nonce)}
  const root = all(document, C.root).find(shown) || document.body
  const sinks = all(document, C.output).filter(shown)
  const sink = sinks.map(node => ({
    text: norm(node.innerText || node.textContent),
    state: node.getAttribute('data-state') || '',
    refusalCode: node.getAttribute('data-refusal-code') || '',
  })).filter(entry => entry.text.length > 0)
  const nodes = all(root, C.node)
  const describe = node => ({
    name: nameOf(node).slice(0, 80),
    agentId: node.getAttribute('data-agent-id'),
    sessionId: C.sessionAttributes.map(a => node.getAttribute(a)).find(v => v) || null,
    runtimeState: node.getAttribute('data-runtime-state') || '',
    looksRunning: C.runningMarkers.some(marker => {
      try { return marker.startsWith('data-') ? node.matches('[' + marker + ']') : node.matches(marker) } catch { return false }
    }),
    carriesNonce: (node.innerText || '').includes(nonce) || (node.getAttribute('title') || '').includes(nonce),
  })
  return {
    sinks: sink,
    /* THE IDENTIFIER, ON THIS PAGE, AND THE SCOPE IS THE POINT.
       Not asked of one named element: which node carries it is the wiring
       lane's decision (the compose panel deliberately names no refusal, being a
       component that performs no action), and demanding a particular node would
       assert a layout rather than the promise -- that the code survives for a
       support conversation without ever being shown to a person.
       But not asked of the whole DOCUMENT either. A document-wide sweep passes
       on a code left behind by any other control on screen, including one that
       has nothing to do with the start that just refused, so it would go green
       on a page where this flow dropped the identifier entirely. Scoping it to
       the fleet page's own root is the difference between "a code exists
       somewhere" and "this refusal was recorded". */
    refusalCodesOnPage: [...root.querySelectorAll('[data-refusal-code]')]
      .map(node => node.getAttribute('data-refusal-code'))
      .filter(Boolean),
    nodes: nodes.map(describe),
    /* Everything a person can read on this page right now. The bare-code check
       reads this, not just the sink: a code printed anywhere is a code shown. */
    visibleText: norm(root.innerText).slice(0, 8000),
    nonceOnGlass: norm(root.innerText).includes(nonce),
  }
})()`
}

/* WHY THERE IS NO FLEET PAGE. Read only when the page did not render, because
   every one of these is a different person's problem: a window still on the
   first-run question, a build that does not offer the stop, a renderer that
   never got its bridges, or a payload the shell could not load. */
const WHY_NOT = `(async () => ({
  module: await (async () => {
    const tag = document.querySelector('script[type="module"]')
    if (!tag) return 'no module script in the document'
    try {
      const response = await fetch(tag.src, { cache: 'no-store' })
      const body = await response.text()
      return tag.src + ' -> ' + response.status + ' ' + (response.headers.get('content-type') || 'no type') + ' ' + body.length + ' bytes'
    } catch (error) { return tag.src + ' -> ' + String(error && error.message || error) }
  })(),
  href: location.href,
  readyState: document.readyState,
  title: document.title,
  bodyClass: (document.body && document.body.className || '').slice(0, 200),
  bodyRoute: document.body ? (document.body.dataset.route || '') : '(no body)',
  stageChildren: document.getElementById('stage') ? document.getElementById('stage').childElementCount : -1,
  bridges: ['mcShell', 'mcSetup', 'mcAgent', 'mcOrg', 'mcFleetProfile', 'mcPrefs'].filter(name => Boolean(window[name])),
  setup: window.mcSetup ? { available: window.mcSetup.bootstrap && window.mcSetup.bootstrap.available, tier: window.mcSetup.bootstrap && window.mcSetup.bootstrap.tier, code: window.mcSetup.bootstrap && window.mcSetup.bootstrap.code } : null,
  navStops: [...document.querySelectorAll('[data-route]')].map(node => node.dataset.route).slice(0, 20),
}))()`

const HISTORY_SCRIPT = `(async () => {
  if (!window.mcAgent || typeof window.mcAgent.history !== 'function') return { ok: false, code: 'NO_MCAGENT' }
  try {
    const reply = await window.mcAgent.history({ limit: 200 })
    if (!reply || reply.ok !== true || !Array.isArray(reply.entries)) return { ok: false, code: (reply && reply.code) || 'NO_ENTRIES' }
    return {
      ok: true,
      total: reply.entries.length,
      starts: reply.entries.filter(e => e.action === 'agent_session_start').length,
      outcomes: reply.entries.filter(e => e.action === 'agent_session_outcome').map(e => ({
        result: e.outcome && e.outcome.result, reason: e.outcome && e.outcome.reason,
      })),
    }
  } catch (error) { return { ok: false, code: String(error && error.message || error).slice(0, 200) } }
})()`

/* ---------- the three rebuilt defects ---------- */

/* Every control registers its own undo, so the next one starts from the real
   product rather than from the previous control's leftovers. */
const CONTROL_PREAMBLE = `
  window.__qaControls = window.__qaControls || []
  const keep = (undo) => { window.__qaControls.push(undo) }
`
const CONTROLS_OFF = `(() => {
  for (const undo of (window.__qaControls || [])) { try { undo() } catch {} }
  window.__qaControls = []
  return true
})()`

/* CONTROL A: the page as it shipped -- no pressable start affordance anywhere.
   The observer is installed first and the VIEW is rebuilt afterwards (see
   renavigate), so the fleet page is constructed from nothing with this in
   force: it never has an affordance, rather than having one taken away. */
const CONTROL_NO_AFFORDANCE = `(() => {
  ${CONTROL_PREAMBLE}
  const SELECTOR = ${JSON.stringify(CONTRACT.emptyNode)}
  const strip = () => {
    try { for (const one of document.querySelectorAll(SELECTOR)) one.remove() } catch {}
    for (const one of document.querySelectorAll('.static-tree-node, .node[data-agent-id]')) {
      const id = one.getAttribute('data-agent-id')
      if (id === null || id.trim() === '') one.remove()
    }
  }
  strip()
  const observer = new MutationObserver(strip)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  keep(() => observer.disconnect())
  return true
})()`

/* CONTROL B: THE ONE THAT MATTERS MOST. Nothing is removed and nothing is
   renamed -- every class, attribute and accessible name a source-reading or
   markup-reading check looks for is exactly where it was. A transparent sheet
   is laid over the page, so the affordance is there and no press can reach it.
   A check that stays green here is a check that reads markup and calls it a
   product. */
const CONTROL_UNREACHABLE = `(() => {
  ${CONTROL_PREAMBLE}
  const sheet = document.createElement('div')
  sheet.id = 'qa-control-sheet'
  sheet.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent;'
  document.body.appendChild(sheet)
  const observer = new MutationObserver(() => { if (!sheet.isConnected) document.body.appendChild(sheet) })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  keep(() => { observer.disconnect(); sheet.remove() })
  return true
})()`

/* CONTROL C: what this product used to print. A refusal sink carrying the bare
   identifier instead of a sentence -- `refused · CODEX_CLI_NOT_FOUND` -- which
   is the shape src/refusal-copy.js exists to have ended. An existing sink is
   rewritten where there is one; where there is none, one is created inside the
   fleet page, because the defect being rebuilt is "a code is on the glass" and
   a page with no sink at all cannot demonstrate that either way. */
const CONTROL_BARE_CODE = `(() => {
  ${CONTROL_PREAMBLE}
  const SELECTOR = ${JSON.stringify(CONTRACT.output)}
  const ROOT = ${JSON.stringify(CONTRACT.root)}
  const CODE = 'CODEX_CLI_NOT_FOUND'
  let planted = null
  const rewrite = () => {
    let sinks = []
    try { sinks = [...document.querySelectorAll(SELECTOR)].filter(node => (node.textContent || '').trim().length > 0) } catch {}
    if (sinks.length === 0) {
      const root = document.querySelector(ROOT)
      if (!root) return
      if (!planted || !planted.isConnected) {
        planted = document.createElement('output')
        planted.setAttribute('role', 'status')
        planted.setAttribute('data-action-output', '')
        root.appendChild(planted)
      }
      planted.textContent = CODE
      return
    }
    for (const sink of sinks) { if ((sink.textContent || '').trim() !== CODE) sink.textContent = CODE }
  }
  rewrite()
  const observer = new MutationObserver(rewrite)
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
  keep(() => { observer.disconnect(); if (planted) planted.remove() })
  return true
})()`

/* ================= the assertions, as functions =================
 *
 * WRITTEN ONCE AND RUN TWICE. The self-audit is only worth something if the
 * control is judged by the SAME code as the product; a control judged by a
 * second, simpler check proves that the second check can fail and says nothing
 * about the first. So each of these is a predicate over a discovery, and the
 * control passes require the predicate to come back false.
 */
const affordance = Object.freeze({
  /* EITHER SHAPE COUNTS, and that is not a loosened check. The empty state may
     be a panel with the host-absent copy in it, or it may be the tree canvas
     itself carrying the product's own EMPTY_TREE lines; a person cannot tell
     which module rendered the sentence they are reading, and neither should
     this. What is NOT accepted is a blank screen, or a label so short it says
     nothing -- the whole requirement is that a new customer is told that empty
     is normal rather than left to conclude they broke it. */
  emptyStateShown: found => found.rootPresent && (
    found.declaredEmptyCopyShown.length > 0
    || (found.emptyState.present && found.emptyState.visible && found.emptyState.text.split(/\s+/).length >= 8)
  ),
  noStrangersFleet: found => found.rootPresent && found.filledCount === 0,
  hasEmptyNode: found => found.rootPresent && found.emptyNodes.length > 0,
  emptyNodeVisible: found => found.emptyNodes.some(node => node.visible),
  emptyNodePressable: found => found.emptyNodes.some(node => node.visible && node.enabled && node.hitHits > 0),
})

function bareCodesIn(text) {
  return [...new Set(String(text || '')
    .split(/[^A-Za-z0-9_]+/)
    .filter(word => IDENTIFIER_RE.test(word)))]
}

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'mc-start-flow-qa-'))
  console.log(`scratch: ${scratch}`)
  let app = null
  try {
    /* ---------- 0. the artifact under test ---------- */
    const current = assertRendererMeasurable({ repoRoot: REPO_ROOT, sourceDist: path.join(REPO_ROOT, 'dist') })
    const staged = await stage(scratch)
    console.log(`built:   dist/ at ${current.builtAt} (newest source: ${current.newestSource})`)
    console.log(`app:     ${staged.executable}`)
    console.log(`         ${staged.origin}`)
    console.log(`payload: ${staged.payload.origin}`)
    console.log('renderer and shell: this working tree')

    const profileEntry = path.join(scratch, 'profile')
    mkdirSync(profileEntry, { recursive: true })
    const accountHome = homedir()
    const profile = canonicalizeCreatedQaProfile(profileEntry, {
      accountHome,
      trustedProfileAliasRoot: trustedProfileShortAliasRoot(accountHome),
    })
    /* Written BEFORE the first launch, and it is the whole of the seeding: a
       recorded permission level, and nothing else. No fleet profile, no
       organisation, no trees. */
    seedMachineRecord(profile, staged.app, staged.payload.root)
    seedUnattendedPrefs(profile)

    app = await openApp(staged.executable, profile, message => console.log(`  ..    ${message}`))
    /* WAIT FOR THE APP TO EXIST BEFORE ASKING IT ANYTHING.
     *
     * MEASURED, and it cost two runs. The debugger attaches in about three
     * seconds; the renderer's module bundle is 1.5 MB and is still EVALUATING
     * then -- document.readyState reads "interactive", <main id="stage"> is
     * empty, and nothing has thrown. THE TRAP IS THAT QUIESCENCE CANNOT SAVE
     * YOU HERE: a page that has not started building is perfectly quiet, so a
     * MutationObserver settles instantly and hands back a window in which every
     * assertion is false. Two runs of this file reported "the fleet page never
     * rendered" about an app that rendered it a few seconds later.
     *
     * So the wait is on a POSITIVE fact -- the router has mounted a view -- and
     * a window that never mounts one is reported as a startup failure rather
     * than as a page full of false findings. */
    const booted = await app.until(
      '(() => document.readyState === "complete" && Boolean(document.getElementById("stage")) && document.getElementById("stage").childElementCount > 0)()',
      BOOT_BUDGET_MS,
    )
    if (!booted) {
      const why = await app.evaluate(WHY_NOT)
      throw new HarnessError(
        `the window never mounted a view within ${Math.round(BOOT_BUDGET_MS / 1000)}s, so there was nothing to measure.`
        + `\n  page state: ${JSON.stringify(why)}`
        + (app.thrown.length > 0 ? `\n  the page threw: ${app.thrown.slice(0, 3).join(' /// ')}` : '\n  the page threw nothing'),
      )
    }
    console.log('  ..    the app mounted its first view; measuring from here')
    console.log('')

    /* ---------- 1. A FRESH PROFILE, ON THE FLEET PAGE ---------- */
    if (!await app.goToFleet()) {
      throw new HarnessError(`the router did not reach an active ${CONTRACT.root} at ${CONTRACT.route}`)
    }
    const found = await app.measure(discoverScript())

    if (!found.rootPresent) {
      /* WHAT THE PERSON WAS LOOKING AT INSTEAD. Without this the failure reads
         "the page never rendered", which is the same sentence for a crashed
         renderer, a first-run question that was never answered, and a route
         this build does not offer -- three different problems and three
         different people to hand it to. */
      check(`the fleet page (${CONTRACT.route}) rendered`, false,
        `hash=${found.hash} route=${found.route || 'none'}; the page never reached ${CONTRACT.root}`)
      console.log(`\n  the window was showing instead:\n${(found.text || '(nothing at all)').split('\n').map(line => `    | ${line}`).join('\n').slice(0, 2500)}`)
      console.log(`  page state: ${JSON.stringify(await app.evaluate(WHY_NOT))}`)
      if (app.thrown.length > 0) {
        console.log(`  the page threw ${app.thrown.length} time(s):`)
        for (const line of app.thrown.slice(0, 6)) console.log(`    ! ${line}`)
      } else {
        console.log('  the page threw nothing, so the view did not crash; it was never asked for, or this build does not offer the stop.')
      }
      return report()
    }
    check(`the fleet page (${CONTRACT.route}) rendered`, found.rootVisible,
      `projection state: ${found.projectionState || 'unstated'}`)

    check('a fresh profile shows an empty state, in words rather than a blank screen',
      affordance.emptyStateShown(found),
      found.declaredEmptyCopyShown.length > 0
        ? `${found.declaredEmptyCopyShown.length} of the product's own empty-tree lines are on the glass`
        : (found.emptyState.present
          ? `"${found.emptyState.text.slice(0, 120)}${found.emptyState.text.length > 120 ? '…' : ''}"`
          : 'no empty state on the glass, and none of src/fleet-tree-copy.js\'s EMPTY_TREE lines either'))

    /* THE "EIGHT AGENTS NOBODY CREATED" HALF. */
    check('no agents the person never created are presented as theirs',
      affordance.noStrangersFleet(found),
      found.filledCount === 0
        ? `${found.nodeCount} node(s), none carrying an agent identity`
        : `${found.filledCount} node(s) carry an agent identity: ${found.filledNames.join(', ')}`)

    const haveNode = check('the fleet page offers at least one EMPTY node',
      affordance.hasEmptyNode(found),
      found.emptyNodes.length > 0
        ? `${found.emptyNodes.length} found (${[...new Set(found.emptyNodes.map(n => n.how))].join('+')})`
        : `none; ${found.nodeCount} node(s) on the page and ${found.looseAffordances.length} loose start-ish control(s)`)

    if (haveNode) {
      check('an empty node is on the glass, not merely in the DOM',
        affordance.emptyNodeVisible(found),
        found.emptyNodes.map(n => `${n.name || n.role}:${n.visible ? 'visible' : 'hidden'}`).join(', ').slice(0, 160))
      check('an empty node can actually be PRESSED (hit-tested, not inferred)',
        affordance.emptyNodePressable(found),
        found.emptyNodes.map(n => `${n.hitHits}/${n.hitTotal} points reach it${n.blockedBy ? ` (${n.blockedBy} on top)` : ''}`).join('; ').slice(0, 200))
      /* WHOSE CONTROL IS THIS? An accessible name none of the product's own
         tables declares is a second start door somebody added beside the
         declared one, and two doors to one action is how a screen ends up
         offering a person the wrong one. */
      check('the empty node is named by the product\'s own copy, not by a look-alike',
        found.emptyNodeNamesDeclared.length > 0 && found.emptyNodeNamesDeclared.every(entry => entry.declared),
        found.emptyNodeNamesDeclared.filter(entry => !entry.declared).map(entry => `"${entry.name}"`).join(', ')
          || `all ${found.emptyNodeNamesDeclared.length} named from src/fleet-tree-copy.js`)
    } else {
      pending('an empty node is on the glass, not merely in the DOM', 'there is no empty node to look at')
      pending('an empty node can actually be PRESSED (hit-tested, not inferred)', 'there is no empty node to press')
    }

    /* ---------- 2. THE PANEL ---------- */
    let panel = { present: false }
    let pressed = { pressed: false, why: 'not attempted' }
    if (affordance.emptyNodePressable(found)) {
      /* WHAT WAS ALREADY OPEN, READ BEFORE THE PRESS. Without this, "pressing
         it opens a panel" is satisfied by a panel that was open the whole time
         -- and it WAS: an earlier version of this driver matched the fleet
         page's permanent right-hand rail and reported a green press that did
         nothing at all. The panel has to APPEAR. */
      const panelBefore = await app.measure(readPanelScript())
      pressed = await app.measure(pressEmptyNodeScript())
      if (pressed.pressed) {
        const panelReady = fleetPanelExpression()
        const panelArrived = await app.until(panelReady, PANEL_BUDGET_MS)
        if (panelArrived) {
          await app.settle()
          if (await app.evaluate(panelReady)) panel = await app.measure(readPanelScript())
        }
      }
      check('pressing an empty node opens a panel that was not open before',
        pressed.pressed && panel.present && panel.visible && panelBefore.present !== true,
        pressed.pressed
          ? (panelBefore.present
            ? `a panel was ALREADY open before the press (${panelBefore.className || 'unnamed'}), so this proves nothing`
            : (panel.present ? `${panel.className || 'unnamed panel'} at x=${panel.left}..${panel.right}` : 'nothing opened'))
          : pressed.why)
      if (panel.present) {
        check('the panel is on the RIGHT of the window', panel.onTheRight,
          `panel spans x=${panel.left}..${panel.right} of ${found.viewportWidth}`)
        /* A fresh profile has starting switched off, and since 0e43eb3 the way
           back on is a control in this panel rather than a trip to Settings.
           Press it before judging what the panel offers -- see
           pressComposeSwitchScript() for the three reds this step retires. */
        const composeSwitch = await app.measure(pressComposeSwitchScript())
        let composeTransitioned = composeSwitch.pressed !== true
        check('a panel that says starting is switched off carries the switch, and it can be pressed',
          composeSwitch.pressed === true || /already be on/.test(composeSwitch.why || ''),
          composeSwitch.pressed ? `pressed ${JSON.stringify(composeSwitch.label)}` : composeSwitch.why)
        if (composeSwitch.pressed) {
          const switchedPanelReady = fleetPanelExpression({ switchedOn: true })
          const switchedPanelArrived = await app.until(switchedPanelReady, PANEL_BUDGET_MS)
          await app.settle()
          composeTransitioned = switchedPanelArrived && Boolean(await app.evaluate(switchedPanelReady))
          panel = composeTransitioned
            ? await waitForProviderlessPanel(app)
            : { present: false, transitionFailed: 'the active panel never cleared its visible starting switch' }
          check('the running-agents switch returns to the active panel in its new state',
            composeTransitioned,
            composeTransitioned ? 'the active panel no longer offers the switch' : panel.transitionFailed)
        }
        /* The panel can be painted once with optimistic fallback rows and then
           repainted twice as the shell's tier and provider probes answer. Wait
           for the providerless terminal state before judging Start. */
        if (composeTransitioned && panel.present && !providerlessPanelSettled(panel)) {
          panel = await waitForProviderlessPanel(app)
        }
        /* A ROLE, AND SPECIFICALLY A ROLE. The fallback selectors would accept
           the launch box's assistant-TIER menu here, and being asked which
           assistant to spend is not being asked what the agent is; the values
           are therefore checked against the roles the product declares. */
        const offeredRoles = panel.role.values || []
        const declaredRoles = new Set(DECLARED_COPY.roleKeys)
        check('the panel offers a ROLE to choose, and the choices are roles this product declares',
          panel.role.present && panel.role.visible && panel.role.enabled
            && offeredRoles.length > 0 && offeredRoles.every(value => declaredRoles.has(value)),
          panel.role.present
            ? `${panel.role.kind}, ${panel.role.optionCount} option(s): ${offeredRoles.join(', ') || 'none with a value'}`
            : 'no role control in the panel')
        check('the panel offers a MESSAGE to write',
          panel.message.present && panel.message.visible && panel.message.enabled,
          panel.message.present ? `${panel.message.tag} "${panel.message.name || ''}"`.slice(0, 90) : 'no message field in the panel')
        const selectedTier = panel.tier?.selected || null
        const selectedTierReason = selectedTier?.label || ''
        check('the providerless engine rows all settle unavailable and the selected row says why',
          panel.tier?.present === true && panel.tier.allDisabled === true
            && selectedTier?.disabled === true
            && PROVIDERLESS_TIER_REASON.test(selectedTierReason)
            && bareCodesIn(selectedTierReason).length === 0,
          panel.tier?.present
            ? `${panel.tier.options.filter(option => option.disabled).length}/${panel.tier.options.length} disabled; selected "${selectedTierReason}"`
            : 'no engine menu in the panel')
        check('the providerless panel keeps Start visible but disabled before any intent',
          panel.submit.present && panel.submit.visible && panel.submit.enabled === false,
          panel.submit.present ? `"${panel.submit.name}" disabled=${!panel.submit.enabled}` : 'no Start control in the panel')
        /* AND IT IS THE DECLARED ONE. Separate from the check above on purpose:
           "there is something to press" and "the thing you press is the
           product's own start control" are two facts, and folding them into one
           check would report a look-alike as a missing button. */
        check('the send and cancel controls carry the words this product declares',
          panel.submit.name === DECLARED_COPY.submitLabel
            && (!panel.cancel.present || panel.cancel.name === DECLARED_COPY.cancelLabel),
          `send "${panel.submit.name}" (declared "${DECLARED_COPY.submitLabel}")`
            + (panel.cancel.present ? `; cancel "${panel.cancel.name}" (declared "${DECLARED_COPY.cancelLabel}")` : '; no cancel control'))
      } else {
        for (const name of ['the panel is on the RIGHT of the window',
          'a panel that says starting is switched off carries the switch, and it can be pressed',
          'the panel offers a ROLE to choose, and the choices are roles this product declares',
          'the panel offers a MESSAGE to write',
          'the providerless engine rows all settle unavailable and the selected row says why',
          'the providerless panel keeps Start visible but disabled before any intent',
          'the send and cancel controls carry the words this product declares']) {
          pending(name, 'no panel opened')
        }
      }
    } else {
      pending('pressing an empty node opens a panel that was not open before', 'nothing pressable to press')
      for (const name of ['the panel is on the RIGHT of the window',
        'a panel that says starting is switched off carries the switch, and it can be pressed',
        'the panel offers a ROLE to choose, and the choices are roles this product declares',
        'the panel offers a MESSAGE to write',
        'the providerless engine rows all settle unavailable and the selected row says why',
        'the providerless panel keeps Start visible but disabled before any intent',
          'the send and cancel controls carry the words this product declares']) {
        pending(name, 'no panel could be opened')
      }
    }

    /* ---------- 3. PROVIDERLESS PREFLIGHT STOPS BEFORE START ---------- */
    const nonce = `qa-start-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const readyForProviderlessPreflight = providerlessPanelSettled(panel)
      && panel.message.present && panel.message.enabled
    /* Taken before filling the form. There is deliberately no Start press in
       this driver, so any new record or window is itself a regression. */
    const windowsBefore = readyForProviderlessPreflight ? windowCensus() : null
    if (readyForProviderlessPreflight) {
      const before = await app.evaluate(HISTORY_SCRIPT)
      const filled = await app.measure(fillProviderlessPanelScript(nonce))
      check('the providerless brief can be filled without pressing Start',
        filled.messageAccepted === true && filled.submitted === false
          && filled.submitVisible === true && filled.submitEnabled === false,
        `role=${filled.roleChosen || 'none offered'}; Start visible=${filled.submitVisible} enabled=${filled.submitEnabled}; ${filled.why}`)

      await delay(1_000)
      const after = await app.evaluate(HISTORY_SCRIPT)
      const outcome = await app.evaluate(readOutcomeScript(nonce))
      if (!before.ok || !after.ok) {
        check('the disabled providerless Start records no start intent or outcome', false,
          `mcAgent.history() answered ${after.code || before.code}`)
      } else {
        const sameOutcomes = after.outcomes.length === before.outcomes.length
        const noIntent = after.starts === before.starts && sameOutcomes
        check('the disabled providerless Start records no start intent or outcome',
          noIntent,
          `agent_session_start ${before.starts} -> ${after.starts}; outcomes ${before.outcomes.length} -> ${after.outcomes.length}`)
        if (!noIntent || after.outcomes.some(entry => entry.result === 'started')) reap(app.child?.pid)
      }

      const shownCodes = bareCodesIn(outcome.visibleText)
      check('the providerless reason is plain language, with no bare code on the fleet page',
        shownCodes.length === 0 && PROVIDERLESS_TIER_REASON.test(panel.tier.selected.label),
        shownCodes.length > 0
          ? `on the glass: ${shownCodes.slice(0, 4).join(', ')}`
          : `selected row: "${panel.tier.selected.label}"`)

      const pretending = outcome.nodes.filter(node => node.looksRunning || node.sessionId)
      check('an unavailable Start leaves no node looking like it is running',
        pretending.length === 0,
        pretending.length === 0
          ? `${outcome.nodes.length} node(s), none running`
          : pretending.map(n => `${n.name}:${n.runtimeState || 'running-marker'}${n.sessionId ? ` session=${n.sessionId}` : ''}`).join(', ').slice(0, 200))
    } else {
      for (const name of [
        'the providerless brief can be filled without pressing Start',
        'the disabled providerless Start records no start intent or outcome',
        'the providerless reason is plain language, with no bare code on the fleet page',
        'an unavailable Start leaves no node looking like it is running',
      ]) pending(name, 'the panel never settled to a fillable message with an unavailable Start')
    }

    /* ---------- 3b. NOTHING LAUNCHED, INCLUDING A WINDOW ---------- */
    if (readyForProviderlessPreflight) {
      const watched = await watchForNewWindows(windowsBefore, WINDOW_WATCH_MS)
      if (watched.censusFailed) {
        pending('the providerless preflight opens no new window',
          'the window census could not be taken, so this run says nothing about windows either way')
      } else {
        const pids = descendantPids(app.child?.pid)
        const mine = watched.windows.filter(window => windowIsFromThisRun(window, pids, scratch))
        const visible = mine.filter(window => window.visible)
        check('the providerless preflight opens no new window',
          visible.length === 0,
          visible.length === 0
            ? `${Math.round(watched.watchedMs / 1000)}s watched, no new VISIBLE top-level window from this run`
              + `; ${mine.length} invisible from this run, ${watched.windows.length - mine.length} from other programs`
            : `${visible.length} new visible window(s) from this run in ${Math.round(watched.watchedMs / 1000)}s`)
        /* EVERY new window is printed, whether or not it decided the check: the
           two candidate causes are not exclusive, and a report that stops at the
           first cannot say so. */
        for (const window of watched.windows) {
          const whose = windowIsFromThisRun(window, pids, scratch) ? 'THIS RUN' : 'another program on this machine'
          console.log(`  --    NEW WINDOW (${whose}) ${describeWindow(window)}`)
        }
      }
    } else {
      pending('the providerless preflight opens no new window', 'the providerless panel never settled')
    }

    /* ---------- 3c. CONFIGURED IS NOT CONNECTED ----------
       See serverAnswers() for the defect this exists to catch: a document that
       named this application's own binary as the runtime, so every server was a
       second copy of the app and every session had none of the product's tools
       while every check in this file stayed green. */
    const dispatchConfig = path.join(profile, 'userdata', 'workspace', '.mcp.json')
    let configured = null
    try { configured = JSON.parse(readFileSync(dispatchConfig, 'utf8')) } catch { /* reported below */ }
    const configuredServers = Object.entries(configured?.mcpServers || {})
    if (configuredServers.length === 0) {
      check('the session is configured with at least one of this product\'s own servers', false,
        `no server in ${dispatchConfig}`)
      pending('every configured server actually starts and speaks the protocol', 'nothing was configured to start')
      pending('the session can actually reach a toolsenabled tool', 'nothing was configured to start')
    } else {
      check('the session is configured with at least one of this product\'s own servers', true,
        configuredServers.map(([name]) => name).join(', '))
      /* THE DOCUMENT NAMES THE BUILD THAT IS RUNNING. The record was seeded with
         an executable belonging to no build (see seedMachineRecord); if that
         value reaches the document, an agent session starts the OTHER
         installation -- which is what "another ToolsEnabled that looks
         outdated" was. */
      const commands = [...new Set(configuredServers.map(([, entry]) => entry.command))]
      check('every server is started by the copy of the product that is running',
        commands.length === 1 && path.resolve(commands[0]) === path.resolve(staged.executable),
        commands.join(' / '))

      const environment = providerlessEnvironment(profile)
      const answers = []
      for (const [name, entry] of configuredServers) {
        answers.push([name, await serverAnswers(entry, environment)])
      }
      /* SCOPED TO THE SERVERS THIS PRODUCT IMPLEMENTS. The `playwright` entry is
         a GATEWAY to a third-party server and refuses until a ToolsEnabled-owned
         browser is running -- its own designed precondition, measured 2026-08-18
         as "No ToolsEnabled-owned browser is running. Run browser.start through
         ToolsEnabled first". Requiring it to answer would make this check red
         about something working as designed, which is how a real check gets
         deleted. It is still held to the thing this defect was about, one line
         below: it must have RUN AS NODE, and a refusal on stderr is a program
         that read its arguments -- which the GUI boot never did. */
      const own = answers.filter(([name]) => name.toLowerCase().startsWith('toolsenabled'))
      for (const [name, answer] of answers.filter(([name]) => !name.toLowerCase().startsWith('toolsenabled'))) {
        check(`the ${name} gateway ran as Node rather than booting the application`,
          answer.initialized || answer.said.length > 0,
          answer.initialized
            ? `${answer.tools.length} tool(s)`
            : `refused for its own reason: "${answer.said.split('\n')[0].slice(0, 90)}"`)
      }
      const silent = own.filter(([, answer]) => !answer.initialized)
      check('every server this product implements actually starts and speaks the protocol',
        own.length > 0 && silent.length === 0,
        silent.length === 0
          ? own.map(([name, answer]) => `${name}:${answer.tools.length} tools`).join(', ')
          : silent.map(([name, answer]) => `${name} never answered initialize${answer.said ? ` (${answer.said.split('\n')[0].slice(0, 80)})` : ''}`).join('; '))

      /* ATTRIBUTED BY SERVER, NOT BY TOOL NAME. This product's tools are called
         `system.status`, `workspace.list`, `memory.get` -- names a third-party
         server could also use -- so "is this one of ours" is answered by WHICH
         SERVER ADVERTISED IT, which is a fact about the connection rather than a
         guess about a string. */
      const advertised = answers.flatMap(([, answer]) => answer.tools)
      const ours = answers
        .filter(([name]) => name.toLowerCase().startsWith('toolsenabled'))
        .flatMap(([, answer]) => answer.tools)
      check('the session can actually reach a toolsenabled tool',
        ours.length > 0,
        ours.length > 0
          ? `${advertised.length} tool(s) advertised in all, ${ours.length} of them from this product's own server (${ours.slice(0, 4).join(', ')})`
          : `${advertised.length} tool(s) advertised and none from this product's own server -- "configured" without "connected"`)

      /* CONTROL 1: THE INSTRUMENT CAN GO RED. Without this, "every server
         answered" is satisfied just as well by a probe that never really asked.
         The command and the runtime mode are the ones that WORK; only the script
         is not a server. */
      const [, sample] = configuredServers[0]
      const notAServer = await serverAnswers({
        command: sample.command,
        args: [path.join(staged.payload.root, 'src', 'this-is-not-a-server.js')],
        cwd: sample.cwd,
        env: { ...(sample.env || {}), ELECTRON_RUN_AS_NODE: '1' },
      }, environment, 8_000)
      check('CONTROL: a command that is not a server is reported as not answering',
        notAServer.initialized === false && notAServer.tools.length === 0,
        notAServer.initialized ? 'the probe reported an answer from a program that cannot give one' : 'no answer, as it must be')

      /* CONTROL 2: A DOCUMENT ALREADY ON DISK, WRITTEN BY AN OLDER BUILD, IS
         STILL REPAIRED. Regeneration fixes the files this application writes; it
         cannot reach a `.mcp.json` in a folder it has never been told about,
         which is what somebody's agent client will read tomorrow morning. So the
         same entry is started with ELECTRON_RUN_AS_NODE stripped -- byte for
         byte what the old generator wrote -- and must STILL answer, because
         shell/main.cjs re-enters as Node when argv names a program we ship. */
      /* `answers` carries what each server SAID; the entry that started it lives
         in the document. Taking the entry from the answer is how the first draft
         of this control spawned `undefined`. */
      const [ownName] = own.length > 0 ? own[0] : configuredServers[0]
      const ownEntry = configured.mcpServers[ownName]
      const { ELECTRON_RUN_AS_NODE: _dropped, ...withoutNodeMode } = ownEntry.env || {}
      const staleWindowsBefore = windowCensus()
      const stale = await serverAnswers({ ...ownEntry, env: withoutNodeMode }, environment)
      const staleWindows = await watchForNewWindows(staleWindowsBefore, 3_000)
      /* VISIBLE is the property, and the distinction is measured rather than
         convenient. This repair path costs something the regeneration path does
         not: the binary really does start as Electron before the guard fires, so
         Chromium's own helper windows exist for as long as the compatibility
         proxy runs. Measured 2026-08-18: 0 visible, 2 invisible
         (Base_PowerMessageWindow, IME). Nothing reaches the screen, which is
         what the person reported -- but a live Electron process per stale entry
         is the price, and it is why regeneration is the fix and this is the net
         under it rather than the other way round. */
      const staleVisible = staleWindows.windows.filter(window => window.visible)
      check('a configuration written by an OLDER build still reaches a server, not a second application',
        stale.initialized && stale.tools.length > 0 && staleVisible.length === 0,
        `${ownName}: `
          + (stale.initialized
            ? `${stale.tools.length} tool(s)`
            : `no answer${stale.said ? ` (${stale.said.split('\n')[0].slice(0, 80)})` : ''}`)
          + `, ${staleVisible.length} visible / ${staleWindows.windows.length} total new window(s)`)
      for (const window of staleWindows.windows) console.log(`  --    NEW WINDOW (older-build-document control) ${describeWindow(window)}`)
    }

    const launches = launchLinesByOrigin(profile)
    if (!launches.ok) {
      pending('the providerless UI preflight records no agent-host or mission-bridge launch',
        `${launches.code}: ${launches.message}`)
    } else {
      check('the providerless UI preflight records no agent-host or mission-bridge launch',
        launches.bridge === 0 && launches.agentHost === 0,
        `${launches.agentHost} agent-host (surface=app.ipc) and ${launches.bridge} bridge-shaped `
          + `controller.agent.launch line(s) under this profile`)
    }

    /* ---------- 4. THE INSTRUMENT PROVES IT CAN STILL GO RED ---------- */
    console.log('\n  -- self-audit: rebuilding the defect and requiring the old failure back --')

    const controlA = await runControl(app, CONTROL_NO_AFFORDANCE)
    check('CONTROL A: with the empty nodes gone, this QA reports the page cannot start an agent',
      controlA.rootPresent === true && affordance.hasEmptyNode(controlA) === false,
      controlA.rootPresent
        ? `${controlA.emptyNodes.length} empty node(s) survived; ${controlA.nodeCount} node(s) on the page`
        : `the control page did not render, so it proves nothing${controlA.controlFailed ? ` (${controlA.controlFailed})` : ''}`)

    const controlB = await runControl(app, CONTROL_UNREACHABLE)
    /* THE TWO HALVES TOGETHER ARE THE POINT: the markup is still there and the
       press is still impossible. Either half alone would be satisfied by a
       control that simply broke the page. */
    check('CONTROL B: an affordance that LOOKS right but cannot be pressed is caught',
      controlB.rootPresent === true
        && affordance.hasEmptyNode(controlB) === affordance.hasEmptyNode(found)
        && affordance.emptyNodePressable(controlB) === false,
      controlB.rootPresent
        ? `nodes still present: ${controlB.emptyNodes.length}; pressable: ${affordance.emptyNodePressable(controlB)}; blocked by ${controlB.emptyNodes.map(n => n.blockedBy).find(Boolean) || 'nothing measured'}`
        : `the control page did not render, so it proves nothing${controlB.controlFailed ? ` (${controlB.controlFailed})` : ''}`)

    const controlC = await runControl(app, CONTROL_BARE_CODE)
    check('CONTROL C: a bare code on the glass is caught',
      bareCodesIn(controlC.text || '').length > 0,
      bareCodesIn(controlC.text || '').slice(0, 4).join(', ') || 'the rewritten page showed no identifier, so the check was never tested')

    return report()
  } catch (error) {
    if (error instanceof HarnessError) {
      console.error(`\nagent-start-flow-qa: the harness could not run -- ${error.message}`)
      return 2
    }
    throw error
  } finally {
    if (app) await app.teardown()
    if (KEEP) console.log(`scratch kept: ${scratch}`)
    else { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* cleanup may never fail the run */ } }
  }
}

/* One control pass: install the mutation for the next document, reload, come
   back to the fleet page, and discover with the SAME probe the real pass used. */
async function runControl(app, source) {
  try {
    await app.evaluate(CONTROLS_OFF)
    await app.evaluate(source)
    if (!await app.renavigateFleet()) {
      throw new HarnessError('the control could not leave and rebuild the active fleet view')
    }
    return await app.measure(discoverScript())
  } catch (error) {
    /* A CONTROL THAT COULD NOT BE BUILT IS NOT A CONTROL THAT PASSED, and it is
       also not a reason to abandon the run: the findings above it are still
       findings. It comes back as a page with nothing on it, which every
       predicate reads as false, and the check that judges it says why. */
    return { rootPresent: false, controlFailed: error.message, emptyNodes: [], nodeCount: 0, text: '' }
  }
}

/* THE CANONICAL AUDIT CHAIN THIS PROFILE PRODUCED, split by WHO WROTE EACH
   LAUNCH. Searched rather than computed from a path this file would have to keep
   in agreement with shell/capability-layer.cjs -- a second copy of "where state
   lives" is a second thing to be wrong about. Bounded to a shallow walk of the
   scratch profile, which is the only place this run writes.

   Both writers use the action name `controller.agent.launch`; they are told
   apart by the details they stamp, and a line that is neither shape is counted
   as the BRIDGE's. An unrecognised launch is the case a reader has to look at,
   and defaulting it to the benign side is how a real regression gets a green
   tick. Parsed as JSON rather than string-matched, because the field that
   decides this is a value and not a substring. */
export function launchLinesByOrigin(profile, depth = 6, filesystem = {}) {
  const readDirectory = filesystem.readdirSync || readdirSync
  const fileStat = filesystem.statSync || statSync
  const readFile = filesystem.readFileSync || readFileSync
  const tally = { agentHost: 0, bridge: 0 }
  let unavailable = null
  const couldNotRead = (operation, target, error) => {
    if (error?.code === 'ENOENT') return false
    unavailable = {
      ok: false,
      code: 'LAUNCH_AUDIT_UNAVAILABLE',
      message: `could not read the launch audit (${operation} ${target}: ${error?.code || 'an unclassified error'}); this is NOT claiming that no launch exists`,
    }
    return true
  }
  const walk = (directory, level) => {
    if (level > depth || unavailable) return
    let entries
    try { entries = readDirectory(directory, { withFileTypes: true }) } catch (error) {
      couldNotRead('directory', directory, error)
      return
    }
    for (const entry of entries) {
      if (unavailable) return
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) { walk(full, level + 1); continue }
      if (entry.name !== 'actions.jsonl') continue
      try {
        if (fileStat(full).size > 8_000_000) continue
        for (const line of readFile(full, 'utf8').split('\n')) {
          if (!line.includes('"controller.agent.launch"')) continue
          let event = null
          try { event = JSON.parse(line) } catch { /* an unparseable line is not a shape */ }
          if (!event || event.action !== 'controller.agent.launch') continue
          if (event.details && event.details.surface === 'app.ipc' && event.details.record === undefined) tally.agentHost += 1
          else tally.bridge += 1
        }
      } catch (error) {
        /* ENOENT means the file genuinely vanished between enumeration and
           read. EMFILE/EAGAIN/EIO/EBUSY and unclassified throws mean the
           machine could not answer; they must not become a zero tally. */
        couldNotRead('file', full, error)
      }
    }
  }
  walk(profile, 0)
  return unavailable || { ok: true, ...tally }
}

if (path.resolve(process.argv[1] || '') === SELF) {
  main().then(
    code => { process.exit(code) },
    error => { console.error(error?.stack || String(error)); process.exit(2) },
  )
}
