'use strict'

/* Runner for tools/account-ledger-e2e.cjs.
 *
 * Same two jobs, and the same teardown discipline, as
 * tools/run-agent-from-ui-smoke.cjs -- read that file's comments for why the
 * reap is split between runner and harness, because the reasoning is identical
 * and is not repeated here.
 *
 * IT DOES NOT REQUIRE MISSION_CONTROL_ENGINE. The agent smoke needs a real
 * engine because it measures the spawn path. This one measures the ACCOUNT
 * path, which is entirely inside the shell and the ledger, so demanding an
 * engine would make the proof unrunnable on a machine that has none -- which is
 * precisely the customer machine whose ledger this is about.
 *
 * Exit code is the harness's own. Usage:
 *   node tools/run-account-ledger-e2e.cjs
 */

const path = require('node:path')
const { mkdtempSync } = require('node:fs')
const os = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } = require('./lib/sterile-launch.cjs')

const WATCHDOG_MS = 300_000
const APP_ROOT = path.resolve(__dirname, '..')

/* The one shared launch environment (tools/lib/sterile-launch.cjs): every home
   inside a scratch profile -- the application this runner starts reads the
   machine record through LOCALAPPDATA, and inheriting the builder's rewrote the
   builder's workspace agent configuration on every run -- and
   ELECTRON_RUN_AS_NODE deleted. */
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(
  mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-e2e-homes-')),
)))
env.MC_APP_ROOT = APP_ROOT

const electron = require('electron')
if (typeof electron !== 'string') {
  console.error('Expected the Electron binary path; got an Electron module instead.')
  process.exit(2)
}

const child = spawn(electron, [path.join(__dirname, 'account-ledger-e2e.cjs')], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (chunk) => process.stdout.write(chunk))
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

let finished = false
function finish(code, reason) {
  if (finished) return
  finished = true
  if (reason) console.error(`[ledger-e2e runner] ${reason}`)
  if (child.pid) {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch { /* already gone is the normal case, and is not a failure */ }
  }
  process.exit(code)
}

child.on('error', (error) => finish(1, `failed to launch: ${error.message}`))
child.on('exit', (code) => finish(code ?? 1))

const watchdog = setTimeout(
  () => finish(3, `no result after ${WATCHDOG_MS / 1000}s; killing the process tree`),
  WATCHDOG_MS,
)
watchdog.unref()
