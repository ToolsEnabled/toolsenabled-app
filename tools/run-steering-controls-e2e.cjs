'use strict'

/* Runner for tools/steering-controls-e2e.cjs -- same two jobs as
 * tools/run-agent-from-ui-smoke.cjs, and for the same reasons:
 *
 * 1. Strip ELECTRON_RUN_AS_NODE. An agent harness exports it, which turns the
 *    Electron binary into plain Node and makes the app fail in a way that
 *    reads as a product bug.
 * 2. Point the shell at an engine when the caller named one. Unlike the sibling
 *    smoke this does NOT require it: a checkout with a staged capability
 *    payload resolves its own engine, and demanding the variable would make the
 *    packaged case unrunnable.
 *
 * Exit code is the run's own.
 */

const path = require('node:path')
const { mkdirSync, mkdtempSync } = require('node:fs')
const os = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } = require('./lib/sterile-launch.cjs')

const WATCHDOG_MS = 660_000
const APP_ROOT = path.resolve(__dirname, '..')

/* THE SETUP WALL, AND WHY THIS PROFILE WAS NEVER STERILE ENOUGH TO PASS IT.
 *
 * src/setup-state.js's shouldOpenSetup() redirects every route (no exemption
 * for '#/agent/...') whenever firstRunPending() is true, which is
 * `available && !configured` -- and `configured` comes from the machine
 * record the shell reads out of LOCALAPPDATA\<product-directory>\machine.json
 * (capability/src/lib/durable-memory-file.js resolveServicesRoot; see
 * seedMachineRecordHere() below for what <product-directory> actually is for
 * THIS runner -- it is not the obvious answer). A genuinely fresh sterile
 * profile has no such file, so a truly clean run of this harness has ALWAYS
 * landed on /setup instead of the agent page it navigates to -- B2's citation
 * trail (grepped both files exhaustively: no setup-bypass anywhere in
 * steering-controls-e2e.cjs; prepareSterileProfile only mkdirs empty homes,
 * seeds nothing). Measured directly during this fix: a run before this change
 * loaded on "setup · ToolsEnabled" and never found a Start control.
 *
 * THE FIX REUSES tools/test-account-harness.mjs's seedMachineRecord()'s
 * SHAPE, NOT A SECOND IMPLEMENTATION OF IT -- but not literally that function
 * unmodified, and not with its qaProfileDirectories() layout either. Two
 * things were tried and measured wrong before this:
 *
 * 1. seedMachineRecord(profile, APP_ROOT, tier) itself throws "Cannot find
 *    module '<APP_ROOT>\resources\capability\...\machine-record.js'"
 *    (confirmed directly). It hardcodes path.join(appRoot, 'resources',
 *    'capability', ...), correct for its own callers -- they drive a
 *    PACKAGED build (release/win-unpacked), where resources/capability is
 *    real. This runner's default mode (plain `npm run qa:steering`, no
 *    MC_RESOURCES_PATH) drives the CHECKOUT directly, the same way
 *    steering-controls-e2e.cjs's header describes -- no resources/ wrapper,
 *    and this checkout genuinely has none (`ls resources` -> ENOENT).
 *
 * 2. Switching this runner's own profile layout from sterileProfileDirectories()
 *    to qaProfileDirectories() (to match seedMachineRecord's `local`/`home`
 *    folder names) broke Electron's OWN userData resolution: "Failed to get
 *    'userData' path", reproduced twice, then isolated with a throwaway probe
 *    against both layouts side by side. sterileProfileDirectories() nests
 *    appData INSIDE userProfile at literally `userProfile\AppData\Roaming`
 *    (mirroring the real Windows %USERPROFILE%\AppData\Roaming relationship);
 *    qaProfileDirectories() puts `appData` at a SIBLING path (`profile\roaming`)
 *    that shares no directory with `userProfile`. Something in this Electron
 *    version's Windows userData resolution derives the path from USERPROFILE
 *    directly rather than purely from the APPDATA env var, so the sibling
 *    layout points it at a directory (`USERPROFILE\AppData\Roaming`) that was
 *    never created. sterileProfileDirectories() is the one PROVEN to boot this
 *    exact checkout cleanly (this file already used it, successfully, before
 *    this fix); switching it was an unforced, unrelated regression, reverted.
 *
 * So this keeps sterileProfileDirectories() and calls the SAME primitives
 * seedMachineRecord calls -- buildMachineRecord/writeMachineRecord from the
 * exact same capability/src/lib/setup/machine-record.js -- but NOT
 * seedMachineRecord's hardcoded 'ToolsEnabled' product-directory literal
 * under servicesRoot. That literal is right for seedMachineRecord's own
 * callers, which drive a PACKAGED build (a real installer-built app whose
 * baked-in product name is "ToolsEnabled"). It is measurably wrong here.
 *
 * THE THIRD THING MEASURED WRONG, AND THE ONE THAT ACTUALLY MATTERED: seeding
 * to <LOCALAPPDATA>\ToolsEnabled first LOOKED right -- the file landed, was
 * valid, round-tripped correctly in an isolated read-back -- and the harness
 * STILL reported no Start control. Isolated shell/setup-record.cjs's
 * readTierState() next: it derives the product-directory name from
 * env.TOOLSENABLED_STATE_ROOT (durable-memory-file.js resolveProductDirectory,
 * the basename of that value's dirname), which shell/main.cjs sets to
 * path.join(app.getPath('userData'), 'capability') -- so the real question is
 * what app.getPath('userData') actually resolves to for THIS invocation.
 * Measured directly with a throwaway probe run the same way
 * steering-controls-e2e.cjs itself is launched (`electron.exe <bare script
 * path>`, from inside this checkout, package.json's "name": "toolsenabled"
 * sitting right beside it): app.getName() answers 'Electron' and
 * app.getPath('userData') resolves under it, not under any spelling of
 * "ToolsEnabled". Electron invoked against a bare script argument (rather
 * than an app directory) does not pick up a neighbouring package.json's name
 * at all, packaged productName or not -- it falls back to its own generic
 * default. So the product-directory literal this runner needs is 'Electron',
 * matching what this specific invocation shape actually produces, not what
 * the shipped product is called. */
function seedMachineRecordHere(env, appRoot, tier = 'standard') {
  const packagedResources = process.env.MC_RESOURCES_PATH && process.env.MC_RESOURCES_PATH.trim() !== ''
    ? path.resolve(process.env.MC_RESOURCES_PATH)
    : null
  const capabilityRoot = packagedResources ? path.join(packagedResources, 'capability') : path.join(appRoot, 'capability')
  const machineRecord = require(path.join(capabilityRoot, 'src', 'lib', 'setup', 'machine-record.js'))
  // 'Electron', not 'ToolsEnabled' -- see the comment above; measured, not assumed.
  const productDirectory = packagedResources ? 'ToolsEnabled' : 'Electron'
  const servicesRoot = path.join(env.LOCALAPPDATA, productDirectory)
  const workspace = path.join(env.USERPROFILE, 'ToolsEnabled')
  mkdirSync(servicesRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const record = machineRecord.buildMachineRecord({
    tier,
    servicesRoot,
    installRoot: capabilityRoot,
    nodePath: process.execPath,
    workspaceRoots: [workspace],
  })
  machineRecord.writeMachineRecord(record, { servicesRoot })
  return servicesRoot
}

/* The one shared launch environment (tools/lib/sterile-launch.cjs): every home
   inside a scratch profile -- the application this runner starts reads the
   machine record through LOCALAPPDATA, and inheriting the builder's rewrote the
   builder's workspace agent configuration on every run -- and
   ELECTRON_RUN_AS_NODE deleted. sterileProfileDirectories(), unchanged from
   before this fix -- see the comment above for why qaProfileDirectories()
   is not safe here. */
const profileRoot = mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-e2e-homes-'))
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(profileRoot)))
/* THE CALLER'S APP ROOT WINS, and this line used to overwrite it.
 *
 * `env.MC_APP_ROOT = APP_ROOT` was unconditional, so a run launched with
 * MC_APP_ROOT pointed at release/win-unpacked/resources/app.asar silently
 * measured the CHECKOUT instead -- and passed, which is the worst possible
 * outcome: a green result labelled "packaged" that never opened the package. I
 * did exactly that once during this lane and only caught it by comparing the
 * bundle hash inside the asar against the one on disk.
 *
 * An explicitly set value is a caller who has decided; an unset one is a caller
 * who has not, and only the second gets the default. */
if (!env.MC_APP_ROOT || env.MC_APP_ROOT.trim() === '') env.MC_APP_ROOT = APP_ROOT
console.log(`[runner] app root: ${env.MC_APP_ROOT}`)

if (process.env.MC_SKIP_SEED_FOR_REFUTATION_TEST !== '1') {
  const servicesRoot = seedMachineRecordHere(env, env.MC_APP_ROOT)
  console.log(`[runner] seeded a machine record so the setup gate is already satisfied: ${path.join(servicesRoot, 'machine.json')}`)
} else {
  console.log('[runner] MC_SKIP_SEED_FOR_REFUTATION_TEST=1: seeding deliberately skipped')
}

const electron = require('electron')
if (typeof electron !== 'string') {
  console.error('Expected the Electron binary path; got an Electron module instead.')
  process.exit(2)
}

const child = spawn(electron, [path.join(__dirname, 'steering-controls-e2e.cjs')], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

/* A CORRECT PRESS MAY NOT LOG AN ERROR, and only the runner can see this.
 *
 * The renderer swallows a rejected mc-agent call, so nothing user-visible goes
 * wrong -- but Electron prints `Error occurred in handler for '<channel>'` with
 * a full stack from the MAIN process, which is a stream the driver inside that
 * process cannot read about itself. Every Respawn and Terminate over an idle
 * session used to emit one. A product whose ordinary success path writes a
 * stack trace into its own log trains whoever reads that log to skip it, and
 * the next genuine fault goes with it.
 *
 * Scan incrementally, including across stream chunk boundaries. Do not stop
 * after an arbitrary number of bytes: a noisy run must not hide a later
 * handler failure. */
const HANDLER_ERROR = /Error occurred in handler for '([^']+)'/g
const HANDLER_ERROR_PREFIX = 'Error occurred in handler for \''
const seen = new Set()
let handlerErrorSeen = false
function makeScanner() {
  let tail = ''
  return text => {
    const input = tail + text
    if (input.includes(HANDLER_ERROR_PREFIX)) handlerErrorSeen = true
    for (const match of input.matchAll(HANDLER_ERROR)) seen.add(match[1])
    tail = input.slice(-(HANDLER_ERROR_PREFIX.length - 1))
  }
}
const scanStdout = makeScanner()
const scanStderr = makeScanner()
child.stdout.on('data', chunk => { scanStdout(String(chunk)); process.stdout.write(chunk) })
child.stderr.on('data', chunk => { scanStderr(String(chunk)); process.stderr.write(chunk) })

/* The run reaps its own descendants before exiting; this is the case where it
   could not, because it was wedged and never reached that code. */
const watchdog = setTimeout(() => {
  console.error(`[runner] no result after ${WATCHDOG_MS}ms; killing the tree`)
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
  process.exit(3)
}, WATCHDOG_MS)

/* Wait for close, not exit: exit can fire before the final stdout/stderr data
   has been delivered, which would let a last-moment handler error pass. */
child.on('close', (code, signal) => {
  clearTimeout(watchdog)
  const channels = [...seen].sort()
  if (handlerErrorSeen) {
    console.log(`FAIL  steering a session logged an error from the main process  :: channels=${JSON.stringify(channels)}`)
  } else {
    console.log('PASS  no main-process handler error was logged during the run')
  }
  const own = signal ? 4 : (code === null ? 5 : code)
  process.exit(own !== 0 ? own : (handlerErrorSeen ? 6 : 0))
})
child.on('error', (error) => {
  clearTimeout(watchdog)
  console.error('[runner] failed to launch Electron:', error.message)
  process.exit(2)
})
