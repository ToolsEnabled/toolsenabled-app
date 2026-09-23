'use strict'

/* Runner for tools/agent-from-ui-smoke.cjs.
 *
 * Two jobs, both of which the smoke cannot do for itself:
 *
 * 1. Strip ELECTRON_RUN_AS_NODE. Agent harnesses and VS Code extension hosts
 *    export it, which turns the Electron binary into plain Node and makes the
 *    app fail in a way that looks like a product bug. shell/launch.cjs strips
 *    it for `npm run app`; this is the same guard for the smoke.
 * 2. Point the shell at an engine. Without MISSION_CONTROL_ENGINE the app is
 *    working correctly when it reports no engine -- the smoke would then be
 *    measuring a fail-closed path, not the spawn path.
 *
 * Exit code is the smoke's own. Usage:
 *   MISSION_CONTROL_ENGINE=<path to the engine module directory> \
 *   node tools/run-agent-from-ui-smoke.cjs
 */

const path = require('node:path')
const { mkdirSync, mkdtempSync } = require('node:fs')
const os = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const { providerAuthenticatedLaunchEnvironment, assertSharedHostQualificationAllowed } = require('./lib/sterile-launch.cjs')
const {
  insideWindowsPath,
  profileRootFromWindowsUserPath,
  usesUnsupportedWindowsPathNamespace,
} = require('../shell/install-profile-guard.cjs')

/* If the smoke has not finished this long after launch, something is wedged.
   Kill the tree rather than sit on the app-wide lock -- see finish(). */
const WATCHDOG_MS = 240_000

const APP_ROOT = path.resolve(__dirname, '..')

// Refuse before resolving the OS owner, creating scratch data or loading a
// provider runtime. A private application profile does not isolate its auth.
try { assertSharedHostQualificationAllowed() } catch (error) {
  console.error(`${error.code}: ${error.message}`)
  process.exit(2)
}

if (!process.env.MISSION_CONTROL_ENGINE) {
  console.error(
    'MISSION_CONTROL_ENGINE is not set.\n' +
    'This smoke measures the spawn path end to end and needs a real engine to spawn.\n' +
    'Set it to the directory containing the engine module and run again.',
  )
  process.exit(2)
}

/* A real-provider proof is different from providerless packaged QA: it must run
   as the Windows account that owns this checkout and use that account's real
   provider sign-in. Giving the process invented USERPROFILE/APPDATA values made
   the product's account guard correctly refuse it, so the old harness never
   reached the API it claimed to test.

   Keep account identity real and isolate the APPLICATION through an explicit
   --user-data-dir instead. shell/main.cjs derives the capability state root
   from that directory, so machine/setup/session state stays one-shot while the
   engine can authenticate through the owner's CODEX_HOME. The owner is derived
   from APP_ROOT, never from ambient HOME/TEMP variables, and the one-shot data
   directory must remain below that owner's literal Temp directory. */
const runtimeOwner = process.platform === 'win32'
  ? profileRootFromWindowsUserPath(APP_ROOT)
  : os.homedir()
if (!runtimeOwner) {
  console.error('Could not derive the account that owns this ToolsEnabled checkout.')
  process.exit(2)
}

const ownerTemp = process.platform === 'win32'
  ? path.join(runtimeOwner, 'AppData', 'Local', 'Temp')
  : os.tmpdir()
const requestedUserData = String(process.env.MC_SMOKE_PROFILE_DIR || '').trim()
if (requestedUserData && (!path.isAbsolute(requestedUserData)
    || (process.platform === 'win32' && usesUnsupportedWindowsPathNamespace(requestedUserData)))) {
  console.error('MC_SMOKE_PROFILE_DIR must be an ordinary absolute path.')
  process.exit(2)
}
const userData = requestedUserData
  ? path.resolve(requestedUserData)
  : mkdtempSync(path.join(ownerTemp, 'toolsenabled-agent-api-'))
if (process.platform === 'win32' && !insideWindowsPath(userData, ownerTemp)) {
  console.error(`MC_SMOKE_PROFILE_DIR must stay inside ${ownerTemp}.`)
  process.exit(2)
}
mkdirSync(userData, { recursive: true })

const env = providerAuthenticatedLaunchEnvironment({
  accountHome: runtimeOwner,
  scratchRoot: path.join(userData, 'launch-environment'),
}, process.env, {
  cwd: APP_ROOT,
})
env.MC_APP_ROOT = APP_ROOT

const electron = require('electron')
if (typeof electron !== 'string') {
  console.error('Expected the Electron binary path; got an Electron module instead.')
  process.exit(2)
}

/* Piped, not inherited. Electron starts GPU and crashpad helpers that inherit
   an inherited stdout handle and outlive the main process, so `npm run` sat
   waiting on a pipe that never closed even after the smoke had finished and
   exited 0. Forwarding the streams ourselves and exiting on the main child's
   code keeps the reported exit honest and prompt. */
const child = spawn(electron, [
  path.join(__dirname, 'agent-from-ui-smoke.cjs'),
  `--user-data-dir=${userData}`,
], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
child.stdout.on('data', (chunk) => process.stdout.write(chunk))
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

/* Booting the real app boots the real app: Electron starts a crashpad handler
   AND the shell spawns the capability bridge as a grandchild. Those inherit
   our pipes, so the main process can exit 0 while the pipes stay open, and the
   runner sits there having already succeeded. Measured intermittent -- it hung
   on some runs and exited on others, which is worse than always hanging.
   Nobody could tell "still working" from "finished 90 seconds ago".

   That mattered off this machine: a hung run holds the app-wide
   single-instance lock for its whole duration, and a peer's release harness
   read the installed app quitting on that held lock as a crash. It measured a
   launch regression that did not exist and nearly filed it against another
   lane's commits.

   Teardown is split, because the two failure modes need different mechanisms
   and only one of them can be handled from here:

   - The smoke exited but its descendants outlived it. This runner CANNOT fix
     that. Its only handle is the Electron pid, and by the time it acts that
     pid is gone -- `taskkill /PID <dead> /T /F` fails outright with "process
     not found" and reaps nothing, because /T walks LIVE parent->child links
     and a dead middle ends the walk. Measured; see
     tools/test/process-tree.test.mjs, which pins that behaviour. The reap
     therefore happens inside the smoke, before it exits, while the links are
     intact.
   - The smoke wedged and Electron is still ALIVE. Then the middle exists, /T
     does walk, and the kill below is what frees the lock.

   An earlier version of this comment claimed /T "reaches the grandchildren
   that child.kill() does not". That was verified against a tree whose middle
   was still alive, which cannot distinguish the two cases. It is false for
   the orphan case and is corrected here rather than left to mislead. */
let finished = false
function finish(code, reason) {
  if (finished) return
  finished = true
  if (reason) console.error(`[smoke runner] ${reason}`)
  if (child.pid) {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch { /* already gone is the normal case, and is not a failure */ }
  }
  process.exit(code)
}

child.on('error', (error) => finish(1, `failed to launch: ${error.message}`))
child.on('exit', (code) => finish(code ?? 1))

/* Distinct exit code on purpose. A watchdog kill must never be mistaken for
   the smoke passing or failing -- it means the smoke did not report at all. */
const watchdog = setTimeout(
  () => finish(3, `no result after ${WATCHDOG_MS / 1000}s; killing the process tree`),
  WATCHDOG_MS,
)
watchdog.unref()
