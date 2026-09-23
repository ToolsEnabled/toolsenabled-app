/* The live launch wrapper: log names, lifecycle record shape, exit-code
 * meaning, the port-holder decision and the orphan proof are pure and tested
 * by values. The Job Object holder is tested for real: a node -> node -> node
 * tree is started through launch-live-job.ps1, the ROOT is killed by pid, and
 * the grandchild must be gone within 5 s; then the same with the HOLDER killed
 * first, which must leave the root running (the app never depends on its
 * wrapper) and still end the grandchild when the root dies. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { identifyJobFixtureTree, sameJobFixtureGeneration } from './fixtures/job-process-identity.mjs'
import {
  logStamp, appLogName, chromiumLogName, watchCsvName, minidumpName, jobName, buildCommandLine, quoteArg, chromiumLogSwitches,
  exitMeaning, exitCodeHex, lifecycleRecord, serializeRecord, parseLifecycle, knownInstances,
  classifyPortHolder, orphanProof, parseNetstatListeners, watchDecision, HANG_SECONDS, PRIVATE_BYTES_LIMIT, DUMP_COOLDOWN_MS,
} from '../live-launch/launch-live-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOLDER = path.resolve(HERE, '..', 'live-launch', 'launch-live-job.ps1')
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const WINDOWS = process.platform === 'win32'

/* ----------------------------------------------------------------- names */

test('log stamp is yyyymmdd-hhmmss in local time', () => {
  assert.equal(logStamp(new Date(2026, 8, 3, 21, 5, 9)), '20260903-210509')
})

test('log file names carry the stamp and the pid, and refuse bad input', () => {
  assert.equal(appLogName('20260903-210509', 19904), 'app-20260903-210509-pid19904.log')
  assert.equal(appLogName('20260903-210509', null), 'app-20260903-210509-pending.log')
  assert.equal(chromiumLogName('20260903-210509'), 'chromium-20260903-210509.log')
  assert.equal(watchCsvName('20260903-210509'), 'watch-20260903-210509.csv')
  assert.equal(minidumpName('20260903-210509', 19904, 'hang-memory'), 'hang-20260903-210509-pid19904-hang-memory.dmp')
  assert.equal(jobName('20260903-210509'), 'Local\\ToolsEnabledLive-20260903-210509')
  assert.throws(() => appLogName('2026-09-03', 1), /yyyymmdd-hhmmss/)
  assert.throws(() => appLogName('20260903-210509', 0), /positive integer/)
})

/* ---------------------------------------------------------- command line */

test('the command line is the one the .cmd built: app dir first, quoted user-data-dir value', () => {
  const line = buildCommandLine({ electron: 'C:\\WF\\deps\\electron.exe', appDir: 'C:\\WF\\live', userDataDir: 'C:\\Users\\Me\\AppData\\Roaming\\ToolsEnabled-Live' })
  assert.equal(line, '"C:\\WF\\deps\\electron.exe" "C:\\WF\\live" --user-data-dir="C:\\Users\\Me\\AppData\\Roaming\\ToolsEnabled-Live"')
})

test('extra switches keep the switch bare and quote only a value with spaces', () => {
  // The wrapper quotes Windows command lines, while log paths are constructed
  // for the actual host. Keep the host path and argv-quoting checks separate.
  const dir = WINDOWS ? 'C:\\PrecutFixture\\app-logs' : '/precut-fixture/app-logs'
  const switches = chromiumLogSwitches(dir, '20260903-210509')
  assert.deepEqual([...switches], ['--enable-logging=file', `--log-file=${dir}${WINDOWS ? '\\' : '/'}chromium-20260903-210509.log`, '--log-level=0'])
  assert.equal(quoteArg('--log-file=C:\\a b\\c.log'), '--log-file="C:\\a b\\c.log"')
  assert.equal(quoteArg('--remote-debugging-port=9223'), '--remote-debugging-port=9223')
  const line = buildCommandLine({ electron: 'e.exe', appDir: 'd', userDataDir: 'u', extraArgs: ['--log-file=C:\\a b\\c.log'] })
  assert.equal(line, '"e.exe" "d" --user-data-dir="u" --log-file="C:\\a b\\c.log"')
  assert.throws(() => buildCommandLine({ electron: 'e"x', appDir: 'd', userDataDir: 'u' }), /double quote/)
})

/* ------------------------------------------------------------ exit codes */

test('exit codes are explained, including the negative and NTSTATUS forms', () => {
  assert.match(exitMeaning(0), /clean/)
  assert.match(exitMeaning(1), /taskkill/)
  assert.match(exitMeaning(134), /heap limit/)
  assert.match(exitMeaning(3), /FATAL ERROR/)
  assert.match(exitMeaning(-1), /Stop-Process/)
  assert.match(exitMeaning(-1073741819), /ACCESS_VIOLATION/)
  assert.match(exitMeaning(0x80000003), /DebugBreak/)
  assert.match(exitMeaning(0xC0000409), /fail-fast/)
  assert.match(exitMeaning(0xC00000FD), /NTSTATUS error 0xC00000FD/)
  assert.equal(exitCodeHex(-1), '0xFFFFFFFF')
  assert.equal(exitCodeHex(-1073741819), '0xC0000005')
  assert.equal(exitMeaning(null), 'no exit code was read')
})

/* --------------------------------------------------------------- records */

test('lifecycle records have the shape the holder and the front agree on', () => {
  const start = lifecycleRecord('start', { launchId: 'L1', pid: 42, startedAt: '2026-09-04T04:00:00Z', commandLine: 'x', appLog: 'a.log', job: { name: 'j', assigned: true } })
  assert.deepEqual(Object.keys(start).slice(0, 3), ['event', 'at', 'launchId'])
  assert.equal(start.pid, 42)
  const exit = lifecycleRecord('exit', { launchId: 'L1', pid: 42, exitCode: -1, exitedAt: '2026-09-04T04:10:00Z', at: '2026-09-04T04:10:00Z' })
  assert.equal(exit.exitCodeHex, '0xFFFFFFFF')
  assert.match(exit.exitMeaning, /Stop-Process/)
  assert.equal(exit.at, '2026-09-04T04:10:00Z')
  assert.throws(() => lifecycleRecord('exit', { launchId: 'L1', pid: 42 }), /needs exitCode/)
  assert.throws(() => lifecycleRecord('bogus', { launchId: 'L1' }), /unknown lifecycle event/)
  assert.throws(() => lifecycleRecord('start', { pid: 1 }), /launchId/)
  const text = serializeRecord(start) + serializeRecord(exit) + 'not json\n'
  assert.ok(text.endsWith('\n') && !text.includes('\r'))
  const parsed = parseLifecycle(text)
  assert.equal(parsed.length, 3)
  assert.equal(parsed[2].event, 'unparseable')
})

test('knownInstances pairs starts with exits by launch id', () => {
  const records = parseLifecycle([
    serializeRecord(lifecycleRecord('start', { launchId: 'A', pid: 10, startedAt: '2026-09-04T04:00:00Z', commandLine: 'x', appLog: 'a', job: {}, userDataDir: 'C:\\ud' })),
    serializeRecord(lifecycleRecord('exit', { launchId: 'A', pid: 10, exitCode: 1, exitedAt: '2026-09-04T04:20:00Z' })),
    serializeRecord(lifecycleRecord('start', { launchId: 'B', pid: 11, startedAt: '2026-09-04T04:21:00Z', commandLine: 'x', appLog: 'a', job: {} })),
  ].join(''))
  const known = knownInstances(records)
  assert.deepEqual(known.map(k => [k.pid, k.exitCode, k.exitedAt]), [[10, 1, '2026-09-04T04:20:00Z'], [11, null, null]])
})

/* ----------------------------------------------------------- port holder */

const expected = { electron: 'C:\\WF\\deps\\electron.exe', appDir: 'C:\\WF\\live', userDataDir: 'C:\\Users\\Me\\AppData\\Roaming\\ToolsEnabled-Live' }

test('a free port is free', () => {
  assert.equal(classifyPortHolder({ port: 9223, listeners: [], expected }).state, 'free')
})

test('a live holder that is this app is held-live; another program is held-other', () => {
  const processes = new Map([[500, { alive: true, name: 'electron.exe', commandLine: '"C:\\WF\\deps\\electron.exe" "C:\\WF\\live" --user-data-dir="C:\\Users\\Me\\AppData\\Roaming\\ToolsEnabled-Live"', parentPid: 1, createdAt: '2026-09-04T04:00:00Z' }]])
  const live = classifyPortHolder({ port: 9223, listeners: [{ pid: 500 }], processes, expected })
  assert.equal(live.state, 'held-live')
  assert.equal(live.holder.name, 'electron.exe')
  const other = classifyPortHolder({ port: 9223, listeners: [{ pid: 500 }], processes: new Map([[500, { alive: true, name: 'chrome.exe', commandLine: 'chrome --remote-debugging-port=9223' }]]), expected })
  assert.equal(other.state, 'held-other')
})

test('a dead holder pid is held-dead-pid and every live child is reported with its proof', () => {
  const instances = [{ launchId: 'A', pid: 19904, startedAt: '2026-09-04T04:14:00Z', exitedAt: null }]
  const processes = new Map([
    [19904, { alive: false }],
    [4840, { alive: true, name: 'claude.exe', commandLine: 'claude.exe --print --input-format stream-json --mcp-config C:\\Users\\Me\\AppData\\Roaming\\ToolsEnabled-Live\\workspace\\.mcp.json', parentPid: 19904, createdAt: '2026-09-04T04:23:48Z', parentAlive: false }],
    [4900, { alive: true, name: 'notepad.exe', commandLine: 'notepad.exe', parentPid: 19904, createdAt: '2026-09-04T04:23:48Z', parentAlive: false }],
    [4950, { alive: true, name: 'electron.exe', commandLine: 'electron.exe C:\\WF\\live\\capability\\tools\\mission-bridge.js --user-data-dir="C:\\Users\\Me\\AppData\\Roaming\\ToolsEnabled-Live"', parentPid: 19904, createdAt: '2026-09-04T04:10:00Z', parentAlive: false }],
  ])
  const verdict = classifyPortHolder({ port: 9223, listeners: [{ pid: 19904 }], processes, expected, instances })
  assert.equal(verdict.state, 'held-dead-pid')
  assert.equal(verdict.holderAlive, false)
  const byPid = new Map(verdict.orphans.map(o => [o.pid, o]))
  assert.equal(byPid.size, 3)
  assert.equal(byPid.get(4840).proof.proven, true, 'circle: pid + time + cmdline all proven')
  assert.equal(byPid.get(4900).proof.proven, false, 'notepad: command line does not name the app')
  assert.equal(byPid.get(4900).proof.cmdline_ok, false)
  assert.equal(byPid.get(4950).proof.proven, false, 'bridge created BEFORE the recorded instance start: pid reuse, not proven')
  assert.equal(byPid.get(4950).proof.time_ok, false)
  assert.equal(byPid.get(4950).proof.cmdline_ok, true)
  assert.ok(byPid.get(4840).proof.reasons.length === 3)
})

test('without a lifecycle record for the dead parent nothing is proven, however good the command line', () => {
  const proof = orphanProof({ pid: 4840, deadPid: 19904, expected, instances: [], proc: { commandLine: 'claude.exe --print --mcp-config x\\.mcp.json', createdAt: '2026-09-04T04:23:48Z', parentAlive: false } })
  assert.equal(proof.proven, false)
  assert.equal(proof.pid_ok, false)
  assert.equal(proof.cmdline_ok, true)
  assert.match(proof.reasons[0], /no lifecycle record/)
})

/* Real `netstat -ano` output shape (captured on this machine), with the dead
   pid the controller measured on 2026-09-03: 9223 LISTENING under 19904 after
   19904 had died. */
const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1180',
  '  TCP    127.0.0.1:4602         0.0.0.0:0              LISTENING       19904',
  '  TCP    127.0.0.1:9223         0.0.0.0:0              LISTENING       19904',
  '  TCP    127.0.0.1:9223         127.0.0.1:52011        ESTABLISHED     19904',
  '  TCP    127.0.0.1:52011        127.0.0.1:9223         ESTABLISHED     4840',
  '  TCP    [::1]:9223             [::]:0                 LISTENING       19904',
  '  UDP    0.0.0.0:5353           *:*                                    2216',
  '',
].join('\r\n')

test('netstat -ano LISTEN rows for the port parse to pids; a dead owner classifies as held-dead-pid', () => {
  const rows = parseNetstatListeners(NETSTAT, 9223)
  assert.deepEqual(rows.map(r => [r.pid, r.local, r.proto]), [[19904, '127.0.0.1:9223', 'TCP'], [19904, '[::1]:9223', 'TCP']])
  assert.deepEqual(parseNetstatListeners(NETSTAT, 4602).map(r => r.pid), [19904])
  assert.deepEqual(parseNetstatListeners(NETSTAT, 52011), [], 'ESTABLISHED rows are not listeners')
  assert.deepEqual(parseNetstatListeners('', 9223), [])
  const processes = new Map([[19904, { alive: false }]])
  const verdict = classifyPortHolder({ port: 9223, listeners: rows, processes, expected })
  assert.equal(verdict.state, 'held-dead-pid')
  assert.equal(verdict.holderPid, 19904)
  assert.equal(verdict.holderAlive, false)
  assert.deepEqual(verdict.orphans, [], 'no live child of the dead pid was handed in, so nothing is a kill candidate')
})

test('a candidate whose parent is alive is never an orphan', () => {
  const proof = orphanProof({ pid: 4840, deadPid: 19904, expected, instances: [{ pid: 19904, launchId: 'A', startedAt: '2026-09-04T04:00:00Z' }], proc: { commandLine: 'claude.exe --print --mcp-config x\\.mcp.json', createdAt: '2026-09-04T04:23:48Z', parentAlive: true } })
  assert.equal(proof.proven, false)
  assert.equal(proof.pid_ok, false)
})

/* -------------------------------------------------------------- watchdog */

test('the sampler dumps once after 9 s not responding or over 3 GB, then not again for 10 minutes', () => {
  let state = {}
  let t = 1_000_000
  let d = watchDecision({ responding: false, privateBytes: 1e9, nowMs: t, state }); state = d.state
  assert.equal(d.dump, false)
  d = watchDecision({ responding: false, privateBytes: 1e9, nowMs: t + 3000, state }); state = d.state
  assert.equal(d.dump, false)
  d = watchDecision({ responding: false, privateBytes: 1e9, nowMs: t + HANG_SECONDS * 1000, state }); state = d.state
  assert.equal(d.dump, true); assert.equal(d.reason, 'hang')
  d = watchDecision({ responding: false, privateBytes: 1e9, nowMs: t + 12_000, state }); state = d.state
  assert.equal(d.dump, false, 'within cooldown'); assert.equal(d.reason, 'hang')
  d = watchDecision({ responding: true, privateBytes: PRIVATE_BYTES_LIMIT + 1, nowMs: t + 12_000 + DUMP_COOLDOWN_MS, state }); state = d.state
  assert.equal(d.dump, true); assert.equal(d.reason, 'memory')
  d = watchDecision({ responding: true, privateBytes: 1e9, nowMs: t + 13_000 + DUMP_COOLDOWN_MS, state })
  assert.equal(d.dump, false); assert.equal(d.reason, null)
})

/* ------------------------------------------------- the job object, live */

function identityFixture() {
  const executable = 'C:\\fixture\\node.exe'
  const treePath = 'C:\\fixture\\unique-run\\tree.js'
  const ready = [
    { depth: 2, pid: 100, ppid: 50 },
    { depth: 1, pid: 200, ppid: 100 },
    { depth: 0, pid: 300, ppid: 200 },
  ].map(record => ({ ...record, executable, readyAtMs: 4000 }))
  const processes = ready.map(record => ({
    pid: record.pid, ppid: record.ppid, name: 'node.exe', executable,
    commandLine: `"${executable}" "${treePath}" ${record.depth}`,
    createdAt: new Date(1000 + record.pid).toISOString(),
  }))
  return { ready, processes, options: { executable, treePath, startedAtMs: 1000 } }
}

test('job fixture identity ignores stale Windows parent PIDs and accepts only the actual ready process generations', () => {
  const { ready, processes, options } = identityFixture()
  // The real failure: a dead earlier process used PID 100; its surviving
  // Chrome descendants still name that PID after our new root inherits it.
  const stale = [
    { pid: 400, ppid: 100, name: 'chrome.exe', executable: 'C:\\fixture\\chrome.exe', createdAt: new Date(0).toISOString() },
    { pid: 500, ppid: 400, name: 'chrome.exe', executable: 'C:\\fixture\\chrome.exe', createdAt: new Date(1).toISOString() },
  ]
  assert.deepEqual(identifyJobFixtureTree(100, ready, [...stale, ...processes], options), processes)
  assert.equal(identifyJobFixtureTree(100, ready, stale, options), null, 'stale ancestors cannot stand in for missing readiness')
})

test('job fixture identity refuses missing readiness, wrong script/executable, and reused creation generations', () => {
  const { ready, processes, options } = identityFixture()
  assert.equal(identifyJobFixtureTree(100, ready.slice(0, 2), processes, options), null)
  for (const replacement of [
    { executable: 'C:\\fixture\\chrome.exe' },
    { commandLine: 'node.exe C:\\fixture\\another-run\\tree.js 0' },
    { createdAt: new Date(500).toISOString() },
    { createdAt: new Date(5000).toISOString() },
    { ppid: 999 },
  ]) {
    const changed = processes.map((row, index) => index === 2 ? { ...row, ...replacement } : row)
    assert.equal(identifyJobFixtureTree(100, ready, changed, options), null, JSON.stringify(replacement))
  }
  assert.equal(sameJobFixtureGeneration(processes[2], { ...processes[2] }), true)
  assert.equal(sameJobFixtureGeneration(processes[2], { ...processes[2], createdAt: new Date(5000).toISOString() }), false,
    'cleanup must refuse a newer process even when PID and executable were reused')
  assert.equal(sameJobFixtureGeneration(processes[2], { ...processes[2], executable: 'C:\\fixture\\chrome.exe' }), false)
  assert.equal(sameJobFixtureGeneration({ ...processes[2], createdAt: undefined }, { ...processes[2], createdAt: undefined }), false)
})

function processRecords(pids) {
  assert.ok(pids.every(pid => Number.isInteger(pid) && pid > 0))
  const filter = pids.map(pid => `ProcessId = ${pid}`).join(' OR ')
  const text = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object {
      $fixtureProcess = $null
      try {
        $fixtureProcess = [Diagnostics.Process]::GetProcessById($_.ProcessId)
        $fixtureHandle = $fixtureProcess.Handle
        [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name;
          executable = $_.ExecutablePath; commandLine = $_.CommandLine;
          createdAt = $fixtureProcess.StartTime.ToUniversalTime().ToString('o') }
      } catch {} finally { if ($fixtureProcess) { $fixtureProcess.Dispose() } }
    } | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  const rows = text.trim() ? JSON.parse(text) : []
  return Array.isArray(rows) ? rows : [rows]
}

function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

/* A node.exe tree standing in for Electron: root -> child -> grandchild, each
   a node.exe that lives 90 s. The root prints one line so stdout capture is
   proven on the same run.

   `detached: true` MATTERS: libuv puts a node parent's non-detached children
   into a kill-on-close job of its own, so they would die with the root
   whatever this wrapper did. Detached children are outside that job -- the
   control test below shows they outlive a killed root -- so only the
   wrapper's Job Object can end them. */
const TREE_JS = [
  "const { spawn } = require('node:child_process')",
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  'const depth = Number(process.argv[2])',
  "if (depth === 2) console.log('root-says-hello')",
  "fs.writeFileSync(path.join(__dirname, `ready-${depth}.json`), JSON.stringify({ depth, pid: process.pid, ppid: process.ppid, executable: process.execPath, readyAtMs: Date.now() }))",
  "if (depth > 0) spawn(process.execPath, [__filename, String(depth - 1)], { stdio: 'inherit', detached: true, windowsHide: true }).unref()",
  'setTimeout(() => {}, 90_000)',
  '',
].join('\n')

test('control: without the wrapper, a detached grandchild OUTLIVES its killed root (so the tests below measure the job, not libuv)', { skip: !WINDOWS && 'Windows only' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laneA-control-'))
  const treeJs = path.join(dir, 'tree.js')
  fs.writeFileSync(treeJs, TREE_JS)
  const startedAtMs = Date.now()
  const root = spawn(process.execPath, [treeJs, '2'], { stdio: 'ignore', windowsHide: true })
  let tree = []
  try {
    tree = await waitForFixtureTree(root.pid, dir, startedAtMs)
    const grandchild = tree[2]
    root.kill()
    await sleep(2000)
    assert.equal(alive(root.pid), false)
    assert.equal(alive(grandchild.pid), true, 'the detached grandchild survived the root: nothing but a job would end it')
  } finally {
    try { stopFixtureTree(tree) } finally { try { root.kill() } catch {} }
  }
})

function startTree(dir, launchId) {
  const lifecycle = path.join(dir, 'lifecycle.jsonl')
  const treeJs = path.join(dir, 'tree.js')
  fs.writeFileSync(treeJs, TREE_JS)
  const commandLine = `"${process.execPath}" "${treeJs}" 2`
  const startedAtMs = Date.now()
  const holder = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOLDER,
    '-CommandLine', commandLine, '-WorkingDirectory', dir, '-LogDir', dir, '-Stamp', '20260903-000000', '-LaunchId', launchId,
    '-Lifecycle', lifecycle, '-JobName', `Local\\LaneATest-${launchId}`], { stdio: 'ignore', windowsHide: true })
  return { holder, lifecycle, startedAtMs }
}

async function waitForStart(lifecycle, launchId, ms = 30_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    let records = []
    try { records = parseLifecycle(fs.readFileSync(lifecycle, 'utf8')) } catch {}
    const start = records.find(r => r.event === 'start' && r.launchId === launchId)
    if (start) return start
    const failed = records.find(r => r.event === 'launch-failed' && r.launchId === launchId)
    if (failed) throw new Error(`holder failed: ${failed.reason}`)
    await sleep(200)
  }
  throw new Error('no start record')
}

async function waitForFixtureTree(root, dir, startedAtMs, ms = 20_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    let ready = []
    try { ready = [2, 1, 0].map(depth => JSON.parse(fs.readFileSync(path.join(dir, `ready-${depth}.json`), 'utf8'))) } catch {}
    if (ready.length === 3 && ready.every(record => Number.isInteger(record.pid) && record.pid > 0)) {
      const tree = identifyJobFixtureTree(root, ready, processRecords(ready.map(record => record.pid)), {
        treePath: path.join(dir, 'tree.js'), executable: process.execPath, startedAtMs,
      })
      if (tree && tree.every(row => alive(row.pid))) return tree
    }
    await sleep(300)
  }
  throw new Error(`authenticated fixture grandchild never appeared in ${dir}`)
}

function stopFixtureTree(tree) {
  if (!tree.length) return
  const current = processRecords(tree.map(row => row.pid))
  const verified = tree.filter(row => sameJobFixtureGeneration(row, current.find(candidate => candidate.pid === row.pid)))
  if (!verified.length) return
  const encoded = Buffer.from(JSON.stringify(verified)).toString('base64')
  // Recheck the creation generation while retaining the process handle used
  // for termination. A stale PID must never target a later unrelated process.
  execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `
    $expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
    foreach ($record in @($expected)) {
      $fixtureProcess = $null
      try {
        $fixtureProcess = [Diagnostics.Process]::GetProcessById($record.pid)
        $fixtureHandle = $fixtureProcess.Handle
        if ($fixtureProcess.StartTime.ToUniversalTime().ToString('o') -ceq $record.createdAt) { $fixtureProcess.Kill() }
      } catch {} finally { if ($fixtureProcess) { $fixtureProcess.Dispose() } }
    }
  `], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
}

async function waitForFixtureExit(tree, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline && tree.some(row => alive(row.pid))) await sleep(100)
  for (const row of tree) assert.equal(alive(row.pid), false, `${row.name} ${row.pid} still alive ${ms} ms after the root died`)
}

test('real fixture cleanup leaves a mismatched creation generation alive and stops only the authenticated generation', {
  skip: !WINDOWS && 'Windows only',
}, async () => {
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 90000)'], { stdio: 'ignore', windowsHide: true })
  try {
    const actual = processRecords([decoy.pid])[0]
    assert.ok(actual && actual.pid === decoy.pid, 'the disposable process is observed directly')
    stopFixtureTree([{ ...actual, createdAt: new Date(0).toISOString() }])
    assert.equal(alive(decoy.pid), true, 'a reused PID is not permission to kill the newer generation')
    stopFixtureTree([actual])
    await waitForFixtureExit([actual])
  } finally { try { decoy.kill() } catch {} }
})

test('job object: killing the ROOT by pid ends the grandchild within 5 s and records the exit', { skip: !WINDOWS && 'Windows only' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laneA-job-'))
  const launchId = `root-${Date.now()}`
  const { holder, lifecycle, startedAtMs } = startTree(dir, launchId)
  let tree = []
  try {
    const start = await waitForStart(lifecycle, launchId)
    assert.equal(start.job.assigned, true, `assigned: ${start.job.assignError}`)
    assert.equal(start.job.handleDuplicatedIntoApp, true, `duplicated: ${start.job.duplicateError}`)
    tree = await waitForFixtureTree(start.pid, dir, startedAtMs)
    const before = tree.slice(1)
    const grandchild = tree[2]
    assert.ok(alive(grandchild.pid))
    assert.match(grandchild.name, /node/i)
    assert.equal(before.length, 2, `root has exactly child + grandchild before the kill: ${JSON.stringify(before)}`)
    process.kill(start.pid)
    await waitForFixtureExit(before)
    const exit = await (async () => { for (let i = 0; i < 50; i++) { const r = parseLifecycle(fs.readFileSync(lifecycle, 'utf8')).find(x => x.event === 'exit' && x.launchId === launchId); if (r) return r; await sleep(200) } return null })()
    assert.ok(exit, 'exit record written')
    assert.equal(exit.pid, start.pid)
    assert.equal(typeof exit.exitCode, 'number')
    assert.equal(exit.exitCode, 1, 'process.kill on Windows is TerminateProcess(1)')
    assert.ok(Array.isArray(exit.descendantsAtExit))
    const log = fs.readFileSync(start.appLog, 'utf8')
    assert.match(log, /root-says-hello/, 'stdout of the root was captured to the app log')
  } finally {
    try { stopFixtureTree(tree) } finally { try { holder.kill() } catch {} }
    await sleep(300)
  }
})

test('job object: killing the HOLDER first leaves the root running; the root dying still ends the grandchild', { skip: !WINDOWS && 'Windows only' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laneA-job-'))
  const launchId = `holder-${Date.now()}`
  const { holder, lifecycle, startedAtMs } = startTree(dir, launchId)
  let tree = []
  try {
    const start = await waitForStart(lifecycle, launchId)
    const rootPid = start.pid
    tree = await waitForFixtureTree(start.pid, dir, startedAtMs)
    const grandchildPid = tree[2].pid
    holder.kill()
    await sleep(1500)
    assert.equal(alive(start.holderPid), false, 'holder is dead')
    assert.equal(alive(rootPid), true, 'root survived the holder: the app does not depend on its wrapper')
    assert.equal(alive(grandchildPid), true, 'grandchild survived the holder too')
    process.kill(rootPid)
    await waitForFixtureExit(tree.slice(1))
  } finally {
    try { stopFixtureTree(tree) } finally { try { holder.kill() } catch {} }
  }
})
