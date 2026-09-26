#!/usr/bin/env node

/* THE ACCEPTANCE TEST FOR "THE PRODUCT SHIPS AS ONE ARTIFACT".
 *
 * The claim under test is not "the code is wired up". It is: an installed
 * application, on a machine with no developer checkout, starts and reaches its
 * own capability layer. Every weaker check this project already had passed
 * while that claim was false, so this one is deliberately built to be hard to
 * pass by accident:
 *
 *   - It runs from a COPY of the built application placed outside any git
 *     checkout, and it verifies that claim by walking up from the copy looking
 *     for a .git. A test that runs inside the repo proves nothing about a
 *     customer, because the checkout is exactly what the customer does not
 *     have.
 *   - It strips ELECTRON_RUN_AS_NODE from the environment it launches into.
 *     That variable is set by this project's own agent harness, and inherited
 *     it turns the Electron binary into a headless Node that exits 0 with no
 *     output -- a false failure that consumed most of a day and produced two
 *     wrong root causes. A harness that leaves it to chance measures the
 *     harness, not the product.
 *   - It identifies the capability layer by the PATH IT WAS LAUNCHED FROM, not
 *     by "something is listening". This machine runs a developer bridge on the
 *     same discovery range, and a port answering is not evidence that the
 *     right listener answered -- this project has already shipped one incident
 *     built on exactly that mistake.
 *   - It completes the real bootstrap the renderer performs -- discovery, then
 *     the per-boot proof, then an authenticated call -- rather than asserting
 *     a process exists. Reaching the layer means getting an answer out of it.
 *
 * Exit 0 means all of that held. Nothing here prints a verdict it did not
 * measure.
 */

import { execFile as execFileCallback, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } from './lib/sterile-launch.cjs'

const execFile = promisify(execFileCallback)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_EXE = 'ToolsEnabled.exe'
const BRIDGE_PORTS = Array.from({ length: 10 }, (_, index) => 4610 + index)
const LIVENESS_SECONDS = Number(process.env.MC_ACCEPTANCE_LIVENESS_SECONDS || 60)

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const steps = []
let failed = false

function record(ok, title, detail) {
  steps.push({ ok, title, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${title}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failed = true
  return ok
}

async function powershell(command) {
  const { stdout } = await execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout.trim()
}

function containsGitCheckout(directory) {
  let current = path.resolve(directory)
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function processesNamed(name) {
  const output = await powershell(
    `@(Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','`,
  )
  return output ? output.split(',').map(Number).filter(Number.isInteger) : []
}

async function windowTitlesUnder(installRoot) {
  const needle = installRoot.replace(/'/g, "''")
  const output = await powershell(
    `@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${needle}*' -and $_.MainWindowTitle } | ` +
      'ForEach-Object { $_.MainWindowTitle }) -join "|"',
  )
  return output ? output.split('|').filter(Boolean) : []
}

/* The capability layer launched by THIS installation, identified by the
 * absolute path it was started from. */
async function capabilityProcessesUnder(installRoot) {
  /* Inside a PowerShell single-quoted string a backslash is an ordinary
     character and only ' needs doubling; -like treats * ? [ ] as wildcards and
     backslash as literal. Escaping backslashes here -- the reflex from every
     regex-shaped API -- would make this match nothing, and matching nothing
     would read as "the app started no capability layer", which is precisely
     the false negative this check exists to rule out. */
  const needle = path.join(installRoot, 'resources', 'capability').replace(/'/g, "''")
  /* THE NAME FILTER IS NOT AN OPTIMISATION -- IT EXCLUDES THIS QUERY ITSELF.
   * Searching Win32_Process for a command line containing this path means the
   * powershell.exe running the search has that same path inside its OWN
   * command line, so it matches itself, every time, forever. That produced a
   * standing "orphaned capability-layer process" failure whose pid was the
   * probe, and a 30-second wait for a count to reach zero that never could.
   * Restricting to the app binary excludes the observer from the observation.
   * The capability layer runs as ToolsEnabled.exe under
   * ELECTRON_RUN_AS_NODE, so this is also exactly what it is. */
  const output = await powershell(
    "Get-CimInstance Win32_Process -Filter \"Name='ToolsEnabled.exe'\" | Where-Object { $_.CommandLine -like " +
      `'*${needle}*' } | Select-Object -ExpandProperty ProcessId`,
  )
  return output ? output.split(/\s+/).map(Number).filter(Number.isInteger) : []
}

async function launchApp(installRoot) {
  /* Launched with NO --user-data-dir, so Electron's own profile is
     <APPDATA>\ToolsEnabled -- which, before this, was the builder's REAL one,
     and the machine record under the builder's LOCALAPPDATA with it. The one
     shared helper (tools/lib/sterile-launch.cjs) points every home into a
     profile beside the staged install, which the staging parent's cleanup
     removes; ELECTRON_RUN_AS_NODE is deleted by the same call. */
  const profile = prepareSterileProfile(sterileProfileDirectories(path.join(path.dirname(installRoot), 'profile')))
  const child = spawn(path.join(installRoot, APP_EXE), [], {
    env: sterileLaunchEnvironment(profile),
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return { child, readStderr: () => stderr }
}

async function killTree(pid) {
  try { await execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20_000 }) } catch {}
}

/* Close the app the way a person closes it -- a real close request to the
 * window -- so the shutdown path under test is the one a customer takes.
 * The first version of this harness tore the app down with `taskkill /T /F`,
 * which never delivers a close event at all, so the graceful shutdown that
 * stops the capability layer was skipped and the harness then reported the
 * resulting orphan as a product defect. Killing something is not a test of
 * whether it shuts down cleanly. */
async function closeGracefully(installRoot) {
  const needle = installRoot.replace(/'/g, "''")
  /* Wait for a window to exist before asking it to close. CloseMainWindow on a
     process whose MainWindowHandle is still 0 posts nothing and reports
     nothing, so an early close request is silently a no-op -- the app stays
     up, and everything measured afterwards describes a running application
     that was never asked to stop. */
  const closable = await waitFor(async () => {
    const output = await powershell(
      `@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${needle}*' -and $_.MainWindowHandle -ne 0 }).Count`,
    )
    return Number(output) > 0 ? true : null
  }, { timeoutMs: 30_000 })
  if (!closable) return false

  await powershell(
    `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${needle}*' -and $_.MainWindowHandle -ne 0 } | ` +
      'ForEach-Object { $null = $_.CloseMainWindow() }',
  )
  return true
}

/* Discovery -> per-boot proof -> authenticated call. Exactly the sequence the
 * renderer performs, against exactly the bridge this install started. */
async function reachCapabilityLayer(installRoot, shellOriginPort) {
  const proofFile = path.join(installRoot, 'resources', 'capability', 'state', 'mission-bridge-bootstrap-proof.json')
  for (const port of BRIDGE_PORTS) {
    const baseUrl = `http://127.0.0.1:${port}`
    let runtime
    try {
      const response = await fetch(`${baseUrl}/v1/runtime`, { signal: AbortSignal.timeout(2000) })
      runtime = await response.json()
    } catch { continue }
    if (runtime?.ok !== true) continue

    const owned = await capabilityProcessesUnder(installRoot)
    if (!owned.includes(runtime.pid)) continue

    if (!existsSync(proofFile)) return { ok: false, reason: `the bridge answered on ${port} but wrote no bootstrap proof at ${proofFile}` }
    const proof = JSON.parse(readFileSync(proofFile, 'utf8'))
    const origin = `http://127.0.0.1:${shellOriginPort}`

    const bootstrap = await fetch(`${baseUrl}/v1/bootstrap?proof=${proof.token}`, {
      headers: { origin },
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.json())
    if (bootstrap?.ok !== true) {
      return { ok: false, reason: `bootstrap refused: ${bootstrap?.error?.code || 'unknown'} ${bootstrap?.error?.message || ''}` }
    }

    const status = await fetch(`${baseUrl}/v1/status`, {
      headers: { origin, authorization: `Bearer ${bootstrap.token}` },
      signal: AbortSignal.timeout(20_000),
    }).then((response) => response.json())
    if (status?.ok !== true) {
      return { ok: false, reason: `authenticated /v1/status refused: ${status?.error?.code || 'unknown'} ${status?.error?.message || ''}` }
    }
    return { ok: true, baseUrl, pid: runtime.pid, actions: status.actions || [] }
  }
  return { ok: false, reason: `no bridge belonging to ${installRoot} answered on ${BRIDGE_PORTS[0]}-${BRIDGE_PORTS[BRIDGE_PORTS.length - 1]}` }
}

/* The shell serves the renderer on 4601-4609 and the bridge authorizes that
 * exact origin, so the acceptance run has to learn which one this launch took
 * rather than assume the first.
 *
 * AND IT MUST CONFIRM THE SERVER IS OURS. The first version of this function
 * accepted any port answering with the ToolsEnabled title, and on the first
 * real run it bound to a DIFFERENT ToolsEnabled -- an older build installed
 * under Programs -- and would have reported that this install's capability
 * layer was unreachable. That is the same mistake this file's own header warns
 * about for the bridge ("a port answering is not evidence that the right
 * listener answered") applied one level up, which is exactly how that class of
 * bug survives: the lesson gets written down for the case that produced it and
 * not for its neighbour. The projection-capability header the shell injects is
 * per-process and unguessable, so instead of trying to match on it we tie the
 * port to a process whose executable lives inside THIS install. */
async function findShellPort(installRoot) {
  const owned = new Set(await processIdsUnder(installRoot))
  if (owned.size === 0) return null
  for (let port = 4601; port <= 4609; port += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
      const body = await response.text()
      if (!body.includes('<title>ToolsEnabled</title>')) continue
      const listener = await listenerPidFor(port)
      if (listener !== null && owned.has(listener)) return port
    } catch {}
  }
  return null
}

async function listenerPidFor(port) {
  const output = await powershell(
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
      'Select-Object -First 1 -ExpandProperty OwningProcess)',
  )
  const pid = Number(output)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/* Every process running from inside this install, by executable path. */
async function processIdsUnder(installRoot) {
  const needle = installRoot.replace(/'/g, "''")
  const output = await powershell(
    `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${needle}*' } | ` +
      'Select-Object -ExpandProperty Id',
  )
  return output ? output.split(/\s+/).map(Number).filter(Number.isInteger) : []
}

async function waitFor(predicate, { timeoutMs, intervalMs = 1000 }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) return null
    await delay(intervalMs)
  }
}

async function runLaunch(installRoot, label) {
  const { child, readStderr } = await launchApp(installRoot)
  const shellPort = await waitFor(() => findShellPort(installRoot), { timeoutMs: 60_000 })
  if (!shellPort) {
    const titles = await windowTitlesUnder(installRoot)
    await killTree(child.pid)
    return { ok: false, reason: `the application never served its renderer on 4601-4609 (${label}). stderr: ${readStderr().slice(0, 400) || '(empty)'} titles: ${titles.join('|') || '(none)'}` }
  }
  return { ok: true, child, shellPort, readStderr }
}

async function main() {
  const source = path.resolve(process.argv[2] || path.join(REPO_ROOT, 'release', 'win-unpacked'))
  if (!existsSync(path.join(source, APP_EXE))) {
    console.error(`capability-acceptance: no built application at ${source}. Build it first.`)
    process.exitCode = 1
    return
  }

  const blocking = await processesNamed('ToolsEnabled')
  if (blocking.length) {
    console.error(
      `capability-acceptance: REFUSING TO RUN. ${blocking.length} ToolsEnabled process(es) are already running ` +
        `(pids ${blocking.join(', ')}). Electron's single-instance lock would make the copy under test quit ` +
        'immediately, and this harness would report that as a product failure. Close them and re-run.',
    )
    process.exitCode = 2
    return
  }

  const stagingParent = mkdtempSync(path.join(tmpdir(), 'mc-install-'))
  const installRoot = path.join(stagingParent, 'ToolsEnabled')
  let appChild = null

  try {
    cpSync(source, installRoot, { recursive: true })
    record(true, 'installed the built application to a directory outside the build tree', installRoot)

    const checkout = containsGitCheckout(installRoot)
    record(checkout === null, 'the install directory contains no git checkout', checkout ? `found a checkout at ${checkout}` : 'walked to the filesystem root, found no .git')

    record(
      existsSync(path.join(installRoot, 'resources', 'capability', 'PAYLOAD.json')),
      'the installed application carries a capability payload',
      path.join(installRoot, 'resources', 'capability'),
    )

    if (failed) return

    // --- launch 1 ---------------------------------------------------------
    const first = await runLaunch(installRoot, 'first launch')
    if (!record(first.ok, 'the installed application starts and serves its renderer', first.ok ? `shell origin http://127.0.0.1:${first.shellPort}` : first.reason)) return
    appChild = first.child

    const reached = await waitFor(async () => {
      const attempt = await reachCapabilityLayer(installRoot, first.shellPort)
      return attempt.ok ? attempt : null
    }, { timeoutMs: 60_000, intervalMs: 2000 })
    record(
      Boolean(reached),
      'the installed application reaches its own capability layer (discovery, bootstrap proof, authenticated /v1/status)',
      reached ? `${reached.baseUrl}, bridge pid ${reached.pid}, ${reached.actions.length} actions available` : (await reachCapabilityLayer(installRoot, first.shellPort)).reason,
    )

    /* Sit and wait. The reported failure was an exit within ~5s, so the only
       thing that answers it is elapsed time with nothing else happening. */
    await delay(LIVENESS_SECONDS * 1000)
    const aliveProcesses = await processIdsUnder(installRoot)
    const titles = await windowTitlesUnder(installRoot)
    record(
      aliveProcesses.length > 0 && titles.length > 0,
      `the application still has a live process and a window after ${LIVENESS_SECONDS}s`,
      `${aliveProcesses.length} process(es), titles: ${titles.join('|') || '(none)'}`,
    )

    await closeGracefully(installRoot)
    const closed = await waitFor(async () => (await processIdsUnder(installRoot)).length === 0, { timeoutMs: 30_000 })
    record(Boolean(closed), 'the application shuts down when its window is closed', closed ? 'all processes exited' : 'processes were still running 30s after the close request')
    if (!closed) await killTree(appChild.pid)
    appChild = null

    // --- launch 2: the relaunch Machine B reported as the original blocker -
    const second = await runLaunch(installRoot, 'relaunch')
    if (!record(second.ok, 'the application starts again after being closed', second.ok ? `shell origin http://127.0.0.1:${second.shellPort}` : second.reason)) return
    appChild = second.child

    const reachedAgain = await waitFor(async () => {
      const attempt = await reachCapabilityLayer(installRoot, second.shellPort)
      return attempt.ok ? attempt : null
    }, { timeoutMs: 60_000, intervalMs: 2000 })
    record(
      Boolean(reachedAgain),
      'the relaunched application reaches its capability layer again',
      reachedAgain ? `${reachedAgain.baseUrl}, bridge pid ${reachedAgain.pid}` : (await reachCapabilityLayer(installRoot, second.shellPort)).reason,
    )

    await closeGracefully(installRoot)
    await waitFor(async () => (await capabilityProcessesUnder(installRoot)).length === 0, { timeoutMs: 30_000 })
    const orphans = await capabilityProcessesUnder(installRoot)
    /* An orphaned bridge holds a port in the 4610-4619 discovery range, so the
       next launch would discover a listener belonging to a dead app. */
    record(orphans.length === 0, 'closing the application leaves no orphaned capability-layer process', orphans.length ? `orphaned pids ${orphans.join(', ')}` : 'none')
    if (orphans.length) for (const pid of orphans) await killTree(pid)
    appChild = null
  } finally {
    if (appChild?.pid) await killTree(appChild.pid)
    for (const pid of await capabilityProcessesUnder(installRoot)) await killTree(pid)
    await delay(1500)
    try { rmSync(stagingParent, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }) } catch {}
  }

  console.log('')
  console.log(`${steps.filter((step) => step.ok).length}/${steps.length} checks passed`)
  if (failed) {
    console.error('capability-acceptance: FAILED -- the product does not ship as one working artifact')
    process.exitCode = 1
    return
  }
  console.log('capability-acceptance: OK -- an installed application with no developer checkout present started and reached its own capability layer')
}

main().catch((error) => {
  console.error(`capability-acceptance: ${error?.stack || error}`)
  process.exitCode = 1
})
