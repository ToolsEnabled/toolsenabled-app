/* THE PURE HALF OF THE LIVE LAUNCH WRAPPER.
 *
 * Nothing in this file touches a process, a socket or a file. It names log
 * files, shapes lifecycle records, reads exit codes, and decides what a port
 * holder is from facts handed to it -- so every rule the wrapper applies can be
 * tested by values with `node --test tools/test/launch-live.test.mjs`.
 *
 * The process half lives next door: launch-live.mjs (the front the launcher
 * calls), launch-live-job.ps1 (the Job Object holder that starts Electron) and
 * watch-live.ps1 (the sampler). They import nothing from each other; the front
 * imports this.
 *
 * WHY THIS EXISTS (measured 2026-09-03, REPORT-crash-20260903/00-CONTROLLER-
 * FINDINGS.md): the owner's main process died ~38 times in one day and left no
 * trace. `start "" electron.exe` discards stdout and stderr, so a V8 "FATAL
 * ERROR: Reached heap limit" (stderr, exit 134/3) is indistinguishable from a
 * taskkill (exit 1) or a Stop-Process (exit -1). Its children outlive it and
 * keep the outside-control socket 9223 alive under a dead pid.
 */

import path from 'node:path'

export const DEFAULT_PORT = 9223
export const LOG_DIR_LEAF = path.join('live-control', 'app-logs')
export const LIFECYCLE_FILE = 'lifecycle.jsonl'

/* ------------------------------------------------------------------ names */

function two(n) { return String(n).padStart(2, '0') }

/* yyyymmdd-hhmmss in LOCAL time, because the owner reads these next to the
   Windows event log and power-log.csv, both local. Records inside the files
   carry ISO-8601 UTC as every other ToolsEnabled log does. */
export function logStamp(date = new Date()) {
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
}

export const STAMP_PATTERN = /^\d{8}-\d{6}$/

export function appLogName(stamp, pid) {
  assertStamp(stamp)
  if (pid === null || pid === undefined) return `app-${stamp}-pending.log`
  assertPid(pid)
  return `app-${stamp}-pid${pid}.log`
}

export function chromiumLogName(stamp) { assertStamp(stamp); return `chromium-${stamp}.log` }
export function watchCsvName(stamp) { assertStamp(stamp); return `watch-${stamp}.csv` }
export function holderLogName(stamp) { assertStamp(stamp); return `holder-${stamp}.log` }
export function minidumpName(stamp, pid, reason) {
  assertStamp(stamp); assertPid(pid)
  const why = String(reason || 'trigger').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'trigger'
  return `hang-${stamp}-pid${pid}-${why}.dmp`
}
export function jobName(stamp) { assertStamp(stamp); return `Local\\ToolsEnabledLive-${stamp}` }

function assertStamp(stamp) {
  if (typeof stamp !== 'string' || !STAMP_PATTERN.test(stamp)) throw new TypeError(`log stamp must be yyyymmdd-hhmmss, got ${JSON.stringify(stamp)}`)
}
function assertPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError(`pid must be a positive integer, got ${JSON.stringify(pid)}`)
}

/* -------------------------------------------------------- command line */

/* EXACTLY the command line Start-ToolsEnabled-Live.cmd built with
   `start "" "%ELECTRON%" "%APPDIR%" --user-data-dir="%USERDATA%"`: the app
   directory as the first argument, the user-data-dir switch with a quoted
   value, then anything extra. Chromium's switch parser accepts the quoted
   value form; the shell's electron-node-handoff looks only at whether the
   FIRST argument is a script under resourcesPath, which a directory is not. */
export function buildCommandLine({ electron, appDir, userDataDir, extraArgs = [] } = {}) {
  for (const [label, value] of [['electron', electron], ['appDir', appDir], ['userDataDir', userDataDir]]) {
    if (typeof value !== 'string' || value === '') throw new TypeError(`${label} is required`)
    if (value.includes('"')) throw new TypeError(`${label} must not contain a double quote`)
  }
  const parts = [`"${electron}"`, `"${appDir}"`, `--user-data-dir="${userDataDir}"`]
  for (const arg of extraArgs) {
    if (typeof arg !== 'string' || arg === '') throw new TypeError('extra arguments must be non-empty strings')
    parts.push(quoteArg(arg))
  }
  return parts.join(' ')
}

/* One argument for a Windows command line: quoted only when it has to be, and
   a `--switch=value with space` keeps the switch bare and quotes the value,
   which is the form Chromium reads. */
export function quoteArg(arg) {
  if (!/[\s"]/.test(arg)) return arg
  const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
  if (eq > 0) return `${arg.slice(0, eq + 1)}"${arg.slice(eq + 1).replace(/"/g, '\\"')}"`
  return `"${arg.replace(/"/g, '\\"')}"`
}

/* The Chromium logging switches, kept in one place so the front and the
   verification use the same three. --log-level=0 is INFO. They are added only
   when the front is told the flags were verified not to change behaviour
   (--chromium-log); see launch-live.mjs. */
export function chromiumLogSwitches(logDir, stamp) {
  return Object.freeze([
    '--enable-logging=file',
    `--log-file=${path.join(logDir, chromiumLogName(stamp))}`,
    '--log-level=0',
  ])
}

/* ----------------------------------------------------- exit code meaning */

const EXIT_MEANINGS = new Map([
  [0, 'clean exit (app.quit / window closed)'],
  [1, 'exit 1: taskkill /F, an explicit process.exit(1), or a startup refusal'],
  [3, 'abort(): CRT abort -- V8 FATAL ERROR (heap limit / allocation failure) when crashpad did not catch it'],
  [134, 'SIGABRT-style abort (128+6): V8 FATAL ERROR "Reached heap limit" on Node exit semantics'],
  [0xFFFFFFFF, 'exit -1: Stop-Process / TerminateProcess(handle, -1) / Task Manager "End task"'],
  [0x80000003, 'STATUS_BREAKPOINT: V8 OS::Abort() -> DebugBreak() (out of memory) surfaced as the exit status; crashpad usually wrote a dump'],
  [0xC0000005, 'STATUS_ACCESS_VIOLATION: native crash'],
  [0xC0000409, 'STATUS_STACK_BUFFER_OVERRUN / __fastfail: native fail-fast (also Chromium IMMEDIATE_CRASH)'],
  [0xC000013A, 'STATUS_CONTROL_C_EXIT: console closed or Ctrl+C'],
  [0xC0000142, 'STATUS_DLL_INIT_FAILED'],
  [0xC0000374, 'STATUS_HEAP_CORRUPTION'],
  [0x40010004, 'DBG_TERMINATE_PROCESS: ended by a debugger'],
  [0xC0000017, 'STATUS_NO_MEMORY: the system could not commit memory'],
])

export function exitMeaning(code) {
  if (code === null || code === undefined) return 'no exit code was read'
  const n = Number(code)
  if (!Number.isFinite(n)) return `unrecognised exit code ${JSON.stringify(code)}`
  const unsigned = n < 0 ? (n >>> 0) : n
  if (EXIT_MEANINGS.has(unsigned)) return EXIT_MEANINGS.get(unsigned)
  if (unsigned >= 0xC0000000) return `NTSTATUS error 0x${unsigned.toString(16).toUpperCase()} (native crash or forced termination)`
  return `exit ${n}: no known meaning`
}

export function exitCodeHex(code) {
  const n = Number(code)
  if (!Number.isFinite(n)) return null
  return `0x${(n < 0 ? (n >>> 0) : n).toString(16).toUpperCase().padStart(8, '0')}`
}

/* ---------------------------------------------------- lifecycle records */

export const EVENTS = Object.freeze(['port-check', 'launching', 'start', 'exit', 'launch-failed', 'watch-trigger', 'orphan-kill'])

const REQUIRED = Object.freeze({
  'port-check': ['port', 'state'],
  launching: ['commandLine', 'appLog'],
  start: ['pid', 'startedAt', 'commandLine', 'appLog', 'job'],
  exit: ['pid', 'exitCode', 'exitedAt'],
  'launch-failed': ['reason'],
  'watch-trigger': ['pid', 'reason'],
  'orphan-kill': ['pid', 'proof'],
})

/* One record per line of lifecycle.jsonl. Every record carries event, at,
   launchId; the rest is per event. `exit` records get the human meaning and
   the hex form of the code added here so nobody reads -1 as "minus one". */
export function lifecycleRecord(event, fields = {}) {
  if (!EVENTS.includes(event)) throw new TypeError(`unknown lifecycle event ${JSON.stringify(event)}`)
  if (typeof fields.launchId !== 'string' || fields.launchId === '') throw new TypeError('launchId is required')
  for (const key of REQUIRED[event]) {
    if (!(key in fields) || fields[key] === undefined) throw new TypeError(`${event} record needs ${key}`)
  }
  const record = { event, at: fields.at || new Date().toISOString(), launchId: fields.launchId }
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'at' || key === 'launchId' || value === undefined) continue
    record[key] = value
  }
  if (event === 'exit') {
    record.exitCodeHex = exitCodeHex(record.exitCode)
    record.exitMeaning = exitMeaning(record.exitCode)
  }
  return record
}

export function serializeRecord(record) { return `${JSON.stringify(record)}\n` }

export function parseLifecycle(text) {
  const records = []
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { records.push(JSON.parse(trimmed)) } catch { records.push({ event: 'unparseable', line: trimmed }) }
  }
  return records
}

/* The main pids this wrapper has ever started, with their start times, and
   whether an exit was recorded for each. This is the evidence the orphan
   proof needs: "pid P was OUR main process, started at S". */
export function knownInstances(records) {
  const byLaunch = new Map()
  for (const record of records) {
    if (record.event === 'start' && Number.isInteger(record.pid)) {
      byLaunch.set(record.launchId, { launchId: record.launchId, pid: record.pid, startedAt: record.startedAt, userDataDir: record.userDataDir || null, appDir: record.appDir || null, exitedAt: null, exitCode: null })
    } else if (record.event === 'exit' && byLaunch.has(record.launchId)) {
      const entry = byLaunch.get(record.launchId)
      entry.exitedAt = record.exitedAt || record.at
      entry.exitCode = record.exitCode
    }
  }
  return [...byLaunch.values()]
}

/* ------------------------------------------------- port holder decision */

/**
 * LISTEN rows for one port from real `netstat -ano` output, the fallback when
 * Get-NetTCPConnection is unavailable. The format (Windows 10):
 *
 *   Proto  Local Address          Foreign Address        State           PID
 *   TCP    127.0.0.1:9223         0.0.0.0:0              LISTENING       19904
 *   TCP    [::1]:9223             [::]:0                 LISTENING       19904
 *
 * netstat attributes an inherited listening socket to the pid that CREATED
 * it even after that pid is dead (the controller measured 9223 "owned" by
 * dead 19904, shown as [System] in the owner column), which is exactly the
 * held-dead-pid case classifyPortHolder names.
 */
export function parseNetstatListeners(text, port = DEFAULT_PORT) {
  const rows = []
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(TCP|UDP)\s+(\S+)\s+(\S+)\s+(LISTENING)\s+(\d+)\s*$/i.exec(line)
    if (!m) continue
    const local = m[2]
    const localPort = Number(local.slice(local.lastIndexOf(':') + 1))
    if (localPort !== Number(port)) continue
    rows.push({ pid: Number(m[5]), local, proto: m[1].toUpperCase() })
  }
  return rows
}

/**
 * What holds the outside-control port, from facts:
 *   listeners  [{ pid }]                      LISTEN rows for the port
 *   processes  Map pid -> { alive, name, commandLine, parentPid, createdAt }
 *   expected   { electron, appDir, userDataDir }   the instance about to start
 *   instances  knownInstances(records)
 *
 * States:
 *   free          nothing listens
 *   held-live     a live process listens and its command line is this app
 *                 (a second start against the same userData; Electron's
 *                 single-instance lock will hand off and this start exits)
 *   held-dead-pid the owning pid no longer exists: the listening socket was
 *                 inherited by a child that outlived a dead main process.
 *                 Chromium in the NEXT instance cannot bind, so outside
 *                 control silently stays shut.
 *   held-other    a live process that is not this app listens
 */
export function classifyPortHolder({ port = DEFAULT_PORT, listeners = [], processes = new Map(), expected = {}, instances = [] } = {}) {
  const holders = listeners.filter(row => Number.isInteger(row.pid)).map(row => row.pid)
  if (holders.length === 0) return Object.freeze({ port, state: 'free', holderPid: null, holderAlive: null, holder: null, orphans: [] })
  const holderPid = holders[0]
  const holder = processes.get(holderPid) || null
  const alive = Boolean(holder && holder.alive)
  if (!alive) {
    const orphans = orphanCandidates({ deadPid: holderPid, processes, expected, instances })
    return Object.freeze({ port, state: 'held-dead-pid', holderPid, holderAlive: false, holder: null, orphans })
  }
  const ours = isThisApp(holder, expected)
  return Object.freeze({ port, state: ours ? 'held-live' : 'held-other', holderPid, holderAlive: true, holder: describe(holderPid, holder), orphans: [] })
}

function isThisApp(proc, expected) {
  const cl = String(proc.commandLine || '').toLowerCase()
  const ud = expected.userDataDir ? String(expected.userDataDir).toLowerCase() : null
  const app = expected.appDir ? String(expected.appDir).toLowerCase() : null
  return Boolean((ud && cl.includes(ud)) || (app && cl.includes(app)))
}

function describe(pid, proc) {
  return { pid, name: proc.name || null, parentPid: proc.parentPid ?? null, createdAt: proc.createdAt || null, commandLine: proc.commandLine || null }
}

/* Every live process whose parent is the dead pid, each with the proof it
   does or does not carry. Reported always; killed only on full proof. */
export function orphanCandidates({ deadPid, processes, expected = {}, instances = [] }) {
  const out = []
  for (const [pid, proc] of processes) {
    if (!proc || !proc.alive || proc.parentPid !== deadPid) continue
    out.push({ ...describe(pid, proc), proof: orphanProof({ pid, proc, deadPid, expected, instances }) })
  }
  return out
}

/**
 * THE PROOF A KILL NEEDS, in three parts, each recorded so the log can show
 * it before anything is signalled:
 *   pid       the parent pid is dead AND is a main pid THIS wrapper recorded
 *   time      the candidate was created after that instance started
 *   cmdline   the candidate's command line names this app's user-data-dir or
 *             app dir (an electron-as-node MCP server, the mission bridge) or
 *             is a claude.exe / codex circle carrying the workspace .mcp.json
 * `proven` is true only with all three. A parent that is dead but was never
 * recorded by this wrapper (today's pre-wrapper instances) is reported, never
 * killed: pids are reused, and a wrong kill is worse than a shut port.
 */
export function orphanProof({ pid, proc, deadPid, expected = {}, instances = [] }) {
  const reasons = []
  const instance = instances.find(row => row.pid === deadPid) || null
  /* The caller only asks about children of a pid it found dead; a candidate
     that says its parent is alive (parentAlive: true) is never an orphan. */
  const parentDead = !(proc && proc.parentAlive === true)
  const pidProof = Boolean(instance) && parentDead
  reasons.push(pidProof
    ? `parent pid ${deadPid} is dead and was recorded by this wrapper as a ToolsEnabled main process (launch ${instance.launchId}, started ${instance.startedAt})`
    : `parent pid ${deadPid} is dead but no lifecycle record proves it was a ToolsEnabled main process`)
  let timeProof = false
  if (instance && proc.createdAt && instance.startedAt) {
    const created = Date.parse(proc.createdAt)
    const started = Date.parse(instance.startedAt)
    timeProof = Number.isFinite(created) && Number.isFinite(started) && created >= started - 1000
    reasons.push(timeProof
      ? `created ${proc.createdAt}, after that instance started ${instance.startedAt}`
      : `created ${proc.createdAt}, which is NOT after the instance start ${instance.startedAt}`)
  } else {
    reasons.push('no creation time or no instance start time to compare')
  }
  const cl = String(proc.commandLine || '').toLowerCase()
  const markers = [expected.userDataDir, expected.appDir].filter(Boolean).map(value => String(value).toLowerCase())
  const circle = /(^|[\\/\s"])(claude|codex|node)\.exe/.test(cl) && /--mcp-config|\.mcp\.json|--print/.test(cl)
  const cmdProof = markers.some(marker => cl.includes(marker)) || circle
  reasons.push(cmdProof
    ? `command line names this app (${circle ? 'an agent circle carrying the workspace MCP config' : 'the user-data-dir or app dir'})`
    : 'command line does not name this app')
  return Object.freeze({ pid, proven: pidProof && timeProof && cmdProof, pid_ok: pidProof, time_ok: timeProof, cmdline_ok: cmdProof, reasons })
}

/* -------------------------------------------------------- watchdog rules */

/* Pure so the sampler's two triggers are testable: not responding for >= 9 s
   (three 3 s samples in a row) or private bytes over 3 GB, at most one dump
   per ten minutes. `state` is carried between samples by the caller. */
export const WATCH_INTERVAL_MS = 3000
export const HANG_SECONDS = 9
export const PRIVATE_BYTES_LIMIT = 3 * 1024 * 1024 * 1024
export const DUMP_COOLDOWN_MS = 10 * 60 * 1000

export function watchDecision({ responding, privateBytes, nowMs, state = {} } = {}) {
  const next = { notRespondingSinceMs: state.notRespondingSinceMs ?? null, lastDumpMs: state.lastDumpMs ?? null }
  if (responding === false) {
    if (next.notRespondingSinceMs === null) next.notRespondingSinceMs = nowMs
  } else {
    next.notRespondingSinceMs = null
  }
  let reason = null
  if (next.notRespondingSinceMs !== null && nowMs - next.notRespondingSinceMs >= HANG_SECONDS * 1000) reason = 'hang'
  if (Number.isFinite(privateBytes) && privateBytes > PRIVATE_BYTES_LIMIT) reason = reason ? `${reason}-memory` : 'memory'
  const cooled = next.lastDumpMs === null || nowMs - next.lastDumpMs >= DUMP_COOLDOWN_MS
  const dump = Boolean(reason) && cooled
  if (dump) next.lastDumpMs = nowMs
  return Object.freeze({ dump, reason, cooled, state: next })
}
