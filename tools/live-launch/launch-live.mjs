#!/usr/bin/env node
/* THE FRONT OF THE LIVE LAUNCH: what Start-ToolsEnabled-Live.cmd calls instead
 * of `start "" electron.exe`.
 *
 *   node launch-live.mjs --electron <exe> --app-dir <dir> --user-data-dir <dir>
 *                        [--port 9223] [--log-dir <dir>] [--chromium-log]
 *                        [--extra <arg> ...] [--wait-seconds 45]
 *                        [--no-watchdog] [--no-reclaim] [--show [n]]
 *
 * It does four things and gets out of the way (it is NOT a process the app
 * depends on; it exits as soon as the start is recorded):
 *
 *   1. PORT CHECK. Is 127.0.0.1:<port> (outside control) already held? If the
 *      holder pid is dead, the listening socket was inherited by a child that
 *      outlived a dead instance, and the app about to start will silently lose
 *      outside control. That is reported to the console and lifecycle.jsonl.
 *      A child is killed only on the full proof (pid + creation time +
 *      command line, see launch-live-lib.mjs orphanProof), written to the
 *      record BEFORE the kill; nothing is ever killed by image name.
 *   2. LAUNCHING record, then the Job Object holder (launch-live-job.ps1) is
 *      started detached and hidden. The holder starts Electron suspended
 *      inside a KILL_ON_JOB_CLOSE job, duplicates the job handle into Electron
 *      (so this front and the holder can both die without taking the app),
 *      resumes it, and captures stdout+stderr to app-<stamp>-pid<pid>.log.
 *   3. Waits (polling lifecycle.jsonl) for the holder's `start` record and
 *      prints the pid and log paths; exit 0. A `launch-failed` record exits 2,
 *      and the .cmd falls back to the plain `start ""` it used before. A
 *      timeout exits 3 and does NOT fall back (the app may be starting).
 *   4. --show prints the last records with exit codes explained.
 *
 * The command line handed to Electron is the one the .cmd built before:
 *   "<electron>" "<appDir>" --user-data-dir="<userData>"
 * plus, only with --chromium-log, the three Chromium logging switches that
 * were verified on an isolated instance not to change behaviour
 * (REPORT-crash-20260903/A-REPORT.md).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PORT, LIFECYCLE_FILE, logStamp, appLogName, chromiumLogName, watchCsvName, holderLogName, jobName,
  buildCommandLine, chromiumLogSwitches, lifecycleRecord, serializeRecord, parseLifecycle, knownInstances,
  classifyPortHolder, parseNetstatListeners, exitMeaning, exitCodeHex,
} from './launch-live-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOLDER = path.join(HERE, 'launch-live-job.ps1')
const WATCHDOG = path.join(HERE, 'watch-live.ps1')
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const say = (line) => process.stdout.write(`launch-live: ${line}\n`)

function parseArgs(argv) {
  const out = { extra: [], port: DEFAULT_PORT, waitSeconds: 45, chromiumLog: false, watchdog: true, reclaim: true, show: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => { i += 1; if (i >= argv.length) throw new Error(`${a} needs a value`); return argv[i] }
    switch (a) {
      case '--electron': out.electron = next(); break
      case '--app-dir': out.appDir = next(); break
      case '--user-data-dir': out.userDataDir = next(); break
      case '--port': out.port = Number(next()); break
      case '--log-dir': out.logDir = next(); break
      case '--chromium-log': out.chromiumLog = true; break
      case '--no-watchdog': out.watchdog = false; break
      case '--no-reclaim': out.reclaim = false; break
      case '--wait-seconds': out.waitSeconds = Number(next()); break
      case '--job-name': out.jobName = next(); break
      case '--extra': out.extra.push(next()); break
      case '--show': out.show = /^\d+$/.test(argv[i + 1] || '') ? Number(next()) : 20; break
      default: throw new Error(`unknown argument ${a}`)
    }
  }
  return out
}

/* ------------------------------------------------------------ powershell */

function powershell(script, { timeoutMs = 60_000 } = {}) {
  return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true,
  })
}

/* LISTEN rows for the port and the processes that matter: the holders, the
   holders' parents and every live child of a dead holder, with the fields the
   proof needs. One PowerShell round trip, JSON out. */
function portFacts(port) {
  const script = `
$ErrorActionPreference = 'Continue'
$rows = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)
$pids = @($rows | Sort-Object -Unique)
$procs = @{}
function Describe($p) {
  $w = Get-CimInstance Win32_Process -Filter "ProcessId = $p" -ErrorAction SilentlyContinue
  if ($null -eq $w) { return @{ alive = $false } }
  $created = $null
  try { $created = $w.CreationDate.ToUniversalTime().ToString('o') } catch {}
  return @{ alive = $true; name = $w.Name; commandLine = $w.CommandLine; parentPid = [int]$w.ParentProcessId; createdAt = $created }
}
foreach ($p in $pids) {
  $procs["$p"] = Describe $p
  if (-not $procs["$p"].alive) {
    foreach ($c in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $p" -ErrorAction SilentlyContinue)) {
      $created = $null
      try { $created = $c.CreationDate.ToUniversalTime().ToString('o') } catch {}
      $procs["$($c.ProcessId)"] = @{ alive = $true; name = $c.Name; commandLine = $c.CommandLine; parentPid = [int]$c.ParentProcessId; createdAt = $created; parentAlive = $false }
    }
  }
}
@{ listeners = @($pids | ForEach-Object { @{ pid = [int]$_ } }); processes = $procs } | ConvertTo-Json -Compress -Depth 5
`
  let text
  try {
    text = powershell(script).trim()
  } catch (error) {
    /* Get-NetTCPConnection needs the NetTCPIP module; netstat is always there. */
    const netstat = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'netstat.exe'), ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    const listeners = parseNetstatListeners(netstat, port)
    return { listeners, processes: new Map(listeners.map(row => [row.pid, { alive: isAlive(row.pid) }])), via: `netstat (Get-NetTCPConnection failed: ${error.message.split('\n')[0]})` }
  }
  const parsed = JSON.parse(text || '{}')
  const processes = new Map()
  for (const [pid, proc] of Object.entries(parsed.processes || {})) processes.set(Number(pid), proc)
  return { listeners: parsed.listeners || [], processes }
}

function psQuote(text) { return `'${String(text).replace(/'/g, "''")}'` }

function isAlive(pid) { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }

/* ------------------------------------------------------------- lifecycle */

function appendRecord(file, record) {
  fs.appendFileSync(file, serializeRecord(record), 'utf8')
}

function readRecords(file) {
  try { return parseLifecycle(fs.readFileSync(file, 'utf8')) } catch { return [] }
}

function showRecords(file, count) {
  const records = readRecords(file).slice(-count)
  if (records.length === 0) { say(`no records in ${file}`); return }
  for (const r of records) {
    const parts = [r.at, r.event, r.launchId]
    if (r.pid) parts.push(`pid ${r.pid}`)
    if (r.event === 'exit') parts.push(`exit ${r.exitCode} (${exitCodeHex(r.exitCode)}) ${exitMeaning(r.exitCode)}; up ${r.uptimeSeconds}s; ${Array.isArray(r.descendantsAtExit) ? r.descendantsAtExit.length : '?'} descendants ended`)
    if (r.event === 'port-check') parts.push(`${r.port} ${r.state}${r.holderPid ? ` held by ${r.holderPid}` : ''}${r.orphans && r.orphans.length ? ` orphans ${r.orphans.map(o => o.pid).join(',')}` : ''}`)
    if (r.event === 'launch-failed') parts.push(r.reason)
    if (r.event === 'watch-trigger') parts.push(`${r.reason} -> ${r.dump} (${r.result})`)
    if (r.event === 'start') parts.push(`job ${r.job && r.job.assigned ? 'assigned' : 'NOT assigned'}, handle ${r.job && r.job.handleDuplicatedIntoApp ? 'duplicated into app' : 'NOT duplicated'}; log ${r.appLog}`)
    process.stdout.write(`${parts.join(' | ')}\n`)
  }
}

/* ------------------------------------------------------------------ main */

function main() {
  const args = parseArgs(process.argv.slice(2))
  /* The launcher passes --log-dir (WF\live-control\app-logs). Without it, the
     nearest ancestor that holds a live-control directory is the WorkingFolder:
     from WF\<app worktree>\tools\live-launch that is three levels up. */
  const logDir = args.logDir || findLogDir()
  fs.mkdirSync(logDir, { recursive: true })
  const lifecycle = path.join(logDir, LIFECYCLE_FILE)

  if (args.show !== null) { showRecords(lifecycle, args.show); return 0 }
  for (const key of ['electron', 'appDir', 'userDataDir']) {
    if (!args[key]) throw new Error(`--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} is required`)
  }
  if (!fs.existsSync(HOLDER)) throw new Error(`the job holder is missing: ${HOLDER}`)

  const stamp = logStamp()
  const launchId = `${stamp}-${Math.random().toString(36).slice(2, 6)}`
  const name = args.jobName || jobName(stamp)
  const expected = { electron: args.electron, appDir: args.appDir, userDataDir: args.userDataDir }

  /* 1. port check */
  let verdict = null
  try {
    const facts = portFacts(args.port)
    const instances = knownInstances(readRecords(lifecycle))
    verdict = classifyPortHolder({ port: args.port, ...facts, expected, instances })
    appendRecord(lifecycle, lifecycleRecord('port-check', { launchId, port: args.port, state: verdict.state, holderPid: verdict.holderPid, holderAlive: verdict.holderAlive, holder: verdict.holder, orphans: verdict.orphans }))
    if (verdict.state === 'free') say(`port ${args.port} is free.`)
    else if (verdict.state === 'held-live') say(`port ${args.port} is held by a running copy of this app (pid ${verdict.holderPid}); Electron's single-instance lock will hand this start to it.`)
    else if (verdict.state === 'held-other') say(`port ${args.port} is held by another program (pid ${verdict.holderPid}, ${verdict.holder && verdict.holder.name}); outside control will not open on this start.`)
    else if (verdict.state === 'held-dead-pid') {
      say(`WARNING: port ${args.port} is still LISTENING under DEAD pid ${verdict.holderPid}: a child of a dead instance inherited the socket. Outside control will silently stay shut on this start unless that child ends.`)
      for (const orphan of verdict.orphans) {
        say(`  child pid ${orphan.pid} (${orphan.name}, created ${orphan.createdAt}) parent ${orphan.parentPid}: ${orphan.proof.proven ? 'PROVEN orphan of a recorded instance' : 'NOT proven'} -- ${orphan.proof.reasons.join('; ')}`)
        if (orphan.proof.proven && args.reclaim) {
          appendRecord(lifecycle, lifecycleRecord('orphan-kill', { launchId, pid: orphan.pid, name: orphan.name, createdAt: orphan.createdAt, commandLine: orphan.commandLine, parentPid: orphan.parentPid, proof: orphan.proof }))
          try { process.kill(orphan.pid); say(`  ended pid ${orphan.pid} by pid, proof recorded first.`) } catch (error) { say(`  could not end pid ${orphan.pid}: ${error.message}`) }
        }
      }
      if (verdict.orphans.length === 0) say('  no live child of that pid was found; the socket is held by a process further down the tree. Nothing was ended.')
    }
  } catch (error) {
    appendRecord(lifecycle, lifecycleRecord('port-check', { launchId, port: args.port, state: 'unknown', error: error.message }))
    say(`port check could not run (${error.message.split('\n')[0]}); launching anyway.`)
  }

  /* 2. launching */
  const extra = [...args.extra]
  const chromiumLog = args.chromiumLog ? path.join(logDir, chromiumLogName(stamp)) : ''
  if (args.chromiumLog) extra.push(...chromiumLogSwitches(logDir, stamp))
  const commandLine = buildCommandLine({ electron: args.electron, appDir: args.appDir, userDataDir: args.userDataDir, extraArgs: extra })
  const appLog = path.join(logDir, appLogName(stamp, null))
  appendRecord(lifecycle, lifecycleRecord('launching', { launchId, commandLine, appLog, logDir, port: args.port, wrapperPid: process.pid, holder: HOLDER }))

  const holderArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOLDER,
    '-CommandLine', commandLine, '-WorkingDirectory', args.appDir, '-LogDir', logDir, '-Stamp', stamp, '-LaunchId', launchId,
    '-Lifecycle', lifecycle, '-JobName', name, '-AppDir', args.appDir, '-UserDataDir', args.userDataDir, '-Electron', args.electron,
    '-ChromiumLog', chromiumLog, '-Port', String(args.port)]
  if (args.watchdog) holderArgs.push('-Watchdog', WATCHDOG)
  /* HOW THE HOLDER IS STARTED, and why (all MEASURED 2026-09-03/04 on this
     machine, evidence/A/harness-spawn-survival-matrix.txt and the
     console-close proof):
     - a powershell.exe that node starts directly -- detached, hidden
       (CREATE_NO_WINDOW), or with a log-file stdio -- was reaped after this
       front exited: the app kept running (the job handle lives in the app)
       and every descendant still died with it, but the holder's EXIT record
       was lost. A DETACHED_PROCESS powershell additionally dies at once,
       having no console to initialise.
     - the one process that outlived every one of those runs was the
       watchdog, which the holder starts with Start-Process -WindowStyle
       Hidden: a console of its own, hidden, attached to nothing that
       closes. So the holder is started the same way, through one short
       PowerShell that reads the exact argument vector from a file (no
       second round of command-line quoting) and prints the holder's pid.
       Windows has no parent-death kill; that PowerShell exits at once. */
  const argsFile = path.join(logDir, `holder-${stamp}.args.json`)
  fs.writeFileSync(argsFile, `${JSON.stringify(holderArgs, null, 2)}\n`)
  const starter = `
$ErrorActionPreference = 'Stop'
$list = Get-Content -LiteralPath ${psQuote(argsFile)} -Raw | ConvertFrom-Json
$quoted = @($list | ForEach-Object { if ($_ -match '[\\s"]' -or $_ -eq '') { '"' + ($_ -replace '"', '\\"') + '"' } else { $_ } })
$p = Start-Process -FilePath ${psQuote(POWERSHELL)} -ArgumentList $quoted -WorkingDirectory ${psQuote(args.appDir)} -WindowStyle Hidden -PassThru
Write-Output $p.Id
`
  let holderPid = null
  try {
    holderPid = Number(powershell(starter, { timeoutMs: 120_000 }).trim().split(/\r?\n/).pop())
  } catch (error) {
    const reason = `could not start the holder (${String(error.stderr || error.message).split('\n')[0]}); nothing was launched`
    appendRecord(lifecycle, lifecycleRecord('launch-failed', { launchId, reason, stage: 'spawn-holder', commandLine }))
    say(reason)
    return 2
  }
  const holder = { pid: holderPid, exitCode: null }
  say(`holder pid ${holder.pid} is starting: ${commandLine}`)

  /* 3. wait for the start record */
  const deadline = Date.now() + args.waitSeconds * 1000
  while (Date.now() < deadline) {
    const mine = readRecords(lifecycle).filter(r => r.launchId === launchId)
    const started = mine.find(r => r.event === 'start')
    if (started) {
      say(`app pid ${started.pid} started ${started.startedAt}; job ${started.job.assigned ? 'assigned' : 'NOT assigned (' + started.job.assignError + ')'}, handle ${started.job.handleDuplicatedIntoApp ? 'duplicated into the app' : 'NOT duplicated (' + started.job.duplicateError + ')'}.`)
      say(`stdout+stderr -> ${started.appLog}`)
      if (chromiumLog) say(`chromium log -> ${chromiumLog}`)
      say(`watchdog pid ${started.watchdogPid || 'none'} -> ${path.join(logDir, watchCsvName(stamp))}`)
      say(`lifecycle -> ${lifecycle}`)
      return 0
    }
    const failed = mine.find(r => r.event === 'launch-failed')
    if (failed) { say(`the holder could not start the app: ${failed.reason} (stage ${failed.stage})`); return 2 }
    if (!isAlive(holder.pid)) { say(`the holder (pid ${holder.pid}) exited before recording a start; see ${path.join(logDir, holderLogName(stamp))}`); return 2 }
    sleepMs(250)
  }
  say(`no start record after ${args.waitSeconds}s; the holder (pid ${holder.pid}) may still be starting the app. See ${path.join(logDir, holderLogName(stamp))}.`)
  return 3
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function findLogDir() {
  let dir = HERE
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'live-control')
    if (fs.existsSync(candidate)) return path.join(candidate, 'app-logs')
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(HERE, '..', '..', '..', 'live-control', 'app-logs')
}

try {
  process.exitCode = main()
} catch (error) {
  say(`failed before launching anything: ${error.message}`)
  process.exitCode = 2
}
