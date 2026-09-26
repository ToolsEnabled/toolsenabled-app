/* DOES A REAL TURN'S TOKENS REACH THE METRICS PAGE?
 *
 * Green unit tests over shell/usage-record.cjs and src/local-metrics.js say the
 * writer and the readings are correct. They cannot say the engine reports what
 * this code expects, and that is the one thing this whole feature rests on: the
 * shape of a codex `usage` event was READ off a capture, and a capture is a
 * claim until a live turn agrees with it. So this drives one real Codex `luna`
 * session, on the owner's own sign-in, through the packaged shell, and then asks
 * the page itself what it shows.
 *
 * WHAT IS STAGED AND WHAT IS NOT, said out loud rather than implied. The app
 * under the window is the BUILT renderer (dist/) and the shipped shell (shell/)
 * copied into a scratch root, run by the Electron binary this build pins, with a
 * fresh user-data directory. That is the same staging shape
 * tools/agent-start-flow-qa.mjs documents for its fallback, and it measures the
 * code that ships. It does NOT measure asar packing, the renamed launcher, the
 * installer or the signature -- those belong to tools/check-asar-manifest.mjs
 * and tools/smoke-packaged.mjs, and this run says so instead of quietly implying
 * otherwise. Nothing is written to any installed copy.
 *
 * Usage:
 *   node tools/metrics-usage-live-qa.mjs --engine <path to the engine checkout>
 *   node tools/metrics-usage-live-qa.mjs --release <unpacked candidate>
 *
 * The release route copies the exact selected candidate into private scratch
 * and runs its packed shell/renderer with its own bundled engine in host
 * Electron. It does not accept an external engine or copy owner credentials.
 * A real provider turn remains required; this route does not establish an
 * installed launcher, installer or signature result.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* THE SHARED STALENESS GUARD, and it is not optional for a driver that stages
   dist/. A harness that copies a dist/ older than the source measures a bundle
   from before the change it is reporting on, and then reports PASS about code
   that was never in the window. tools/test/staged-renderer-guard.test.mjs sweeps
   every harness for these two calls precisely so a new driver cannot arrive
   without them -- which is how this one was caught. */
import { stage } from './test-account-harness.mjs'
import rendererSubject from './lib/qa-renderer-dist.cjs'
import { runQaDriverProcess } from './lib/qa-driver-process.mjs'
import { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } from './lib/sterile-launch.cjs'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'

const require_ = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const { releaseArgument, selectRendererDist } = rendererSubject
const selectedRelease = releaseArgument(process.argv)
const renderer = selectedRelease ? selectRendererDist({ argv: process.argv, repoRoot: REPO_ROOT }) : null
const argv = process.argv.slice(2)
const engineFlag = argv.indexOf('--engine')
const ENGINE = engineFlag > -1 ? argv[engineFlag + 1] : process.env.MISSION_CONTROL_ENGINE
if (selectedRelease && (ENGINE || engineFlag > -1)) throw new Error('--engine and MISSION_CONTROL_ENGINE cannot override the engine in an explicit --release')
if (!selectedRelease && !ENGINE) {
  console.error('This driver measures a REAL agent turn and needs a real engine to run one.')
  console.error('Pass --engine <path to the engine checkout or its codex-process.js>.')
  process.exit(2)
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'metrics-usage-live-'))
let staged, measuredEngine
if (selectedRelease) {
  const candidate = await stage(scratch)
  staged = candidate.archive
  measuredEngine = path.join(candidate.appRoot, 'resources', 'capability')
  console.log(`renderer subject: ${JSON.stringify(renderer.provenance)}`)
  console.log('scope: selected shell, renderer and bundled engine in host Electron; real provider turn required; no installer proof')
} else {
  if (!existsSync(path.join(REPO_ROOT, 'shell'))) throw new Error('shell/ is missing from this checkout')
  assertRendererMeasurable({ repoRoot: REPO_ROOT })
  staged = path.join(scratch, 'app')
  mkdirSync(staged, { recursive: true })
  for (const directory of ['dist', 'shell']) {
    cpSync(path.join(REPO_ROOT, directory), path.join(staged, directory), { recursive: true })
  }
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(staged, 'package.json'))
  assertStagedRendererConsistent({ stagedDist: path.join(staged, 'dist'), sourceDist: path.join(REPO_ROOT, 'dist') })
  measuredEngine = ENGINE
}

const userData = path.join(scratch, 'userdata')
mkdirSync(userData, { recursive: true })

const electron = require_('electron')
if (typeof electron !== 'string') {
  console.error('Expected the Electron binary path; got an Electron module instead.')
  process.exit(2)
}

const environment = selectedRelease
  ? sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(scratch, 'profile'))))
  : { ...process.env }
/* Both are exported by agent harnesses and both turn the Electron binary into
   plain Node, which fails in a way that reads as a product bug. */
delete environment.ELECTRON_RUN_AS_NODE
delete environment.ELECTRON_NO_ATTACH_CONSOLE
environment.MC_APP_ROOT = staged
environment.MISSION_CONTROL_ENGINE = measuredEngine

let cleanupConfirmed = false
try {
  const result = await runQaDriverProcess(electron, [
    path.join(REPO_ROOT, 'tools', 'metrics-usage-live-probe.cjs'),
    `--user-data-dir=${userData}`,
  ], { cwd: REPO_ROOT, env: environment, timeoutMs: 360_000, cleanupMs: 15_000 })
  cleanupConfirmed = result.cleanupConfirmed === true
  process.stdout.write(result.output || '')
  if (!result.cleanupConfirmed || result.failureReason) {
    console.error(`CANNOT MEASURE ON THIS COMPUTER: ${result.failureReason || 'probe descendant cleanup was not confirmed'}`)
    process.exitCode = 3
  } else process.exitCode = result.code ?? 3
} finally {
  renderer?.assertUnchanged()
  console.log(`staged app root: ${staged}`)
  if (cleanupConfirmed && process.env.MC_KEEP_SCRATCH !== '1') rmSync(scratch, { recursive: true, force: true })
}
