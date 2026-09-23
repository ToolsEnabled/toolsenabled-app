#!/usr/bin/env node

// THE MAIN THREAD MUST NOT STALL ON A SETTINGS WRITE OR A SCREEN-CONTROL POLL.
//
// WHY THIS EXISTS (T369). The owner's app froze for 12,767 ms on 2026-09-18
// (main-lag.log, mainThread "waited", blocker mc-prefs:write): renderer-prefs.json
// had grown to 5.2 MB of fleet documents and every settings change serialised,
// wrote, fsync'd and renamed the WHOLE record synchronously on the main thread
// while the renderer waited on sendSync. The same log showed 77 rows topped by
// mc-screen-control:status at 240-306 ms while computer control was OFF, because
// the status poll read the org record from disk once per window session every
// 10 s. Neither had a cut gate, so a synchronous 5 MB fsync on every click
// shipped. This is that gate: it drives the two channels against a packaged
// candidate and reads the candidate's OWN managed main-lag segments to prove the loop did
// not stall.
//
// THE THRESHOLDS, AND WHY. main-lag.cjs records a row only when the loop
// returned later than its threshold (500 ms by default). A single fix-path
// write is ~0.5 ms and a fix-path status call ~15 ms, so on the fixed build
// neither channel can top a recorded row. To make the tip fail on a fast CI
// SSD too -- where one synchronous 5 MB write is ~49 ms, under 500 ms -- the
// gate lowers the candidate's recording threshold to 50 ms for its own run
// (MC_MAIN_LAG_THRESHOLD_MS, honoured only under MC_SMOKE_HEADLESS). It then
// FAILS if any recorded row is attributed to mc-prefs:write or
// mc-screen-control:status, whether as the single worst blocker or in the
// per-label blockers map with maxMs over the threshold. 50 ms is ten times a
// healthy write and three times a healthy status call, so the fixed build has
// headroom and the tip -- one 49 ms write is already at the line, and a burst
// of twenty compounds -- does not.
//
// ISOLATION and OFF-SCREEN: MC_SMOKE_HEADLESS=1 keeps the BrowserWindow
// show:false (shell/window-options.cjs), so nothing appears on the owner's
// desktop (BRIEF-M13-COMMON off-screen rule). --user-data-dir points userData
// at a scratch directory, and sterileLaunchEnvironment redirects service roots
// as well. The profile is seeded with a LIVE-shaped record made
// of synthetic bytes, never the owner's. It kills only the process tree it
// started, matched by the scratch executable path.
//
// RUN: node tools/main-thread-stall-packaged-qa.mjs [--release <win-unpacked>]

import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSterileProfile, qaProfileDirectories, sterileLaunchEnvironment, servicesRootForSelectedIdentity } from './lib/sterile-launch.cjs'
import { defaultReleaseDirectory, reapProcessTree } from './lib/packaged-platform.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)
const argument = (name, fallback = null) => { const at = process.argv.indexOf(name); return at === -1 ? fallback : process.argv[at + 1] }
const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const KEEP = process.argv.includes('--keep')
const THRESHOLD_MS = 50
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* The two channels this gate exists to keep off the main thread. */
const GUARDED_CHANNELS = new Set(['mc-prefs:write', 'mc-screen-control:status'])

function stage(scratch) {
  const asar = require_(path.join(REPO_ROOT, 'node_modules', '@electron', 'asar'))
  const app = path.join(scratch, 'app')
  const unpacked = path.join(scratch, 'asar-stage')
  if (!existsSync(path.join(RELEASE, 'resources', 'app.asar'))) {
    throw new Error(`no packaged build at ${RELEASE}. Run \`npm run dist\` first, or pass --release <dir>.`)
  }
  cpSync(RELEASE, app, { recursive: true, dereference: true })
  asar.extractAll(path.join(app, 'resources', 'app.asar'), unpacked)
  for (const directory of ['dist', 'shell', 'public']) {
    const from = path.join(REPO_ROOT, directory)
    if (!existsSync(from)) throw new Error(`${directory}/ is missing; run \`npm run build\` first`)
    rmSync(path.join(unpacked, directory), { recursive: true, force: true })
    cpSync(from, path.join(unpacked, directory), { recursive: true })
  }
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(unpacked, 'package.json'))
  const executable = path.join(app, process.platform === 'win32' ? 'ToolsEnabled.exe' : 'toolsenabled')
  return asar.createPackage(unpacked, path.join(app, 'resources', 'app.asar')).then(() => executable)
}

/* A LIVE-shaped settings record: 3.6 MB of chat diffs + 1.5 MB of trees, all
   synthetic. Seeded as a legacy renderer-prefs.json so the tip pays the corpus
   on every write and the fix migrates it out on first load. */
function seedProfile(userData) {
  mkdirSync(userData, { recursive: true })
  const values = { 'mc.theme': 'black', 'mc.update.policy': 'never', 'mc.warn.elevated-run': 'off' }
  for (let i = 0; i < 12; i += 1) values[`mc.fleet.chat-diffs.v1:seed-${i}`] = 'd'.repeat(300 * 1024)
  for (let i = 0; i < 6; i += 1) values[`mc.fleet.trees.v1:seed-${i}`] = 't'.repeat(250 * 1024)
  writeFileSync(path.join(userData, 'renderer-prefs.json'), `${JSON.stringify({ storageVersion: 1, values, drainedOrigins: [] })}\n`)
}

async function freePort() {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

function createSession(port, child) {
  let socket = null, nextId = 1
  const pending = new Map()
  return {
    async open() {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`the app exited with code ${child.exitCode} before the debugger answered`)
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`)
          const page = (await response.json()).find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
          if (page) {
            socket = new WebSocket(page.webSocketDebuggerUrl)
            await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
            socket.addEventListener('message', event => { const packet = JSON.parse(event.data); const handler = pending.get(packet.id); if (handler) { pending.delete(packet.id); handler(packet) } })
            return
          }
        } catch { /* not listening yet */ }
        await delay(500)
      }
      throw new Error('no debuggable page appeared within 40s')
    },
    send(method, params = {}) { const id = nextId++; socket.send(JSON.stringify({ id, method, params })); return new Promise(resolve => pending.set(id, resolve)) },
    close() { try { socket?.close() } catch { /* already gone */ } },
  }
}

export function lagObservationBinding({ profile, userData, environment, pid, startedAt }) {
  const inside = value => {
    const relative = path.relative(path.resolve(profile), path.resolve(value))
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  }
  if (![userData, environment.LOCALAPPDATA, environment.APPDATA, environment.USERPROFILE].every(value =>
    typeof value === 'string' && path.isAbsolute(value) && inside(value))) throw new Error('The diagnostic profile is not isolated')
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(startedAt)) throw new Error('The candidate process identity is unavailable')
  const servicesRoot = servicesRootForSelectedIdentity({ env: environment, selectedUserData: userData })
  if (!inside(servicesRoot)) throw new Error('The diagnostic services root escaped the profile')
  return { directory: path.join(servicesRoot, 'diagnostics-v1'), pid, startedAt }
}

/* Read-only inspection of this process's managed sink. An absent log is not
   evidence that a running monitor observed no stalls. No maintenance API runs. */
export async function readLagObservation({ inspect, binding, fileSystem = fs, now = Date.now }) {
  const unavailable = reason => ({ ok: false, reason, rows: [], files: [] })
  const idPattern = /^diag-[0-9]{1,16}-[a-f0-9-]{36}\.jsonl$/
  try {
    if (!binding || !path.isAbsolute(binding.directory) || !Number.isSafeInteger(binding.pid)
      || binding.pid <= 0 || !Number.isSafeInteger(binding.startedAt)) return unavailable('candidate-binding-unavailable')
    const files = [], seen = new Set()
    let final
    for (let page = 0; page < 8; page += 1) {
      const value = await inspect({ next: page !== 0 })
      if (!value || value.ok !== true || value.unknownCount !== 0 || !Array.isArray(value.files)
        || typeof value.scanComplete !== 'boolean' || value.directory !== binding.directory) return unavailable('diagnostic-inventory-unavailable')
      for (const file of value.files) {
        if (!idPattern.test(file.id) || seen.has(file.id)) return unavailable('diagnostic-inventory-identity')
        seen.add(file.id)
        if (file.kind === 'main-lag') {
          if (file.pid !== binding.pid || file.createdAt < binding.startedAt) return unavailable('diagnostic-process-mismatch')
          files.push(file)
        }
      }
      if (value.scanComplete) { final = value; break }
    }
    if (!final || final.complete !== true) return unavailable('diagnostic-inventory-incomplete')
    const writers = final.writers?.filter(writer => writer.kind === 'main-lag')
    if (writers?.length !== 1) return unavailable('diagnostic-writer-unavailable')
    const writer = writers[0]
    if (writer.pid !== binding.pid || writer.closed !== false || writer.failure !== null || writer.dropped !== 0
      || !idPattern.test(writer.id) || !Number.isSafeInteger(writer.totalBytes) || writer.totalBytes <= 0
      || !files.some(file => file.id === writer.id)) return unavailable('diagnostic-writer-unconfirmed')
    const root = fileSystem.lstatSync(binding.directory)
    if (!root.isDirectory() || root.isSymbolicLink() || fileSystem.realpathSync(binding.directory) !== binding.directory) return unavailable('diagnostic-root-unavailable')
    const read = (file, limit) => {
      const before = fileSystem.lstatSync(file)
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error('diagnostic-file-unavailable')
      const bytes = fileSystem.readFileSync(file)
      const after = fileSystem.lstatSync(file)
      if (bytes.length !== before.size || !['dev', 'ino', 'size', 'mtimeMs'].every(key => before[key] === after[key])) throw new Error('diagnostic-file-changed')
      return bytes
    }
    const rows = [], markers = [], observedAt = now()
    let totalBytes = 0
    for (const file of files) {
      const dataPath = path.join(binding.directory, file.id)
      const meta = JSON.parse(read(dataPath + '.meta.json', 4096).toString('utf8'))
      if (meta.version !== 1 || meta.id !== file.id || meta.kind !== 'main-lag' || meta.pid !== binding.pid
        || !Number.isSafeInteger(meta.createdAt) || meta.createdAt !== file.createdAt || meta.createdAt < binding.startedAt
        || meta.createdAt > observedAt || typeof meta.closed !== 'boolean' || typeof meta.keep !== 'boolean'
        || typeof meta.archive !== 'boolean' || meta.outputSuppressed || file.outputSuppressed) return unavailable('diagnostic-metadata-unconfirmed')
      const data = read(dataPath, 1024 * 1024)
      if (data.length !== file.bytes || !data.length || data.at(-1) !== 10) return unavailable('diagnostic-data-incomplete')
      totalBytes += data.length
      for (const line of data.toString('utf8').trimEnd().split('\n')) {
        const row = JSON.parse(line)
        if (!row || typeof row !== 'object' || Array.isArray(row)) return unavailable('diagnostic-row-invalid')
        const stamp = typeof row.at === 'string' ? Date.parse(row.at) : NaN
        if (!Number.isFinite(stamp) || stamp < binding.startedAt || stamp > observedAt || row.pid !== binding.pid) return unavailable('diagnostic-row-identity')
        if (row.event === 'diagnostic-sink-ready') {
          if (row.producer !== 'main-lag' || Object.keys(row).sort().join(',') !== 'at,event,pid,producer') return unavailable('diagnostic-marker-invalid')
          markers.push(row)
        } else {
          if (!Number.isFinite(row.lagMs) || row.lagMs < 0 || typeof row.blocker !== 'string'
            || !row.blockers || typeof row.blockers !== 'object' || Array.isArray(row.blockers)
            || Object.values(row.blockers).some(entry => !entry || !Number.isFinite(entry.maxMs) || entry.maxMs < 0)) return unavailable('diagnostic-row-invalid')
          rows.push(row)
        }
      }
    }
    if (markers.length !== 1) return unavailable('diagnostic-sink-attachment-unobserved')
    if (totalBytes !== writer.totalBytes) return unavailable('diagnostic-byte-accounting-mismatch')
    return { ok: true, rows, marker: markers[0], files: files.map(file => file.id), directory: binding.directory, pid: binding.pid, totalBytes }
  } catch (error) { return unavailable(error.code || error.message || 'diagnostic-observation-unavailable') }
}

/* A row offends when either the single worst blocker is a guarded channel, or a
   guarded channel's own longest span in the per-label map is over the
   threshold. Both are main-thread time held by that channel. */
export function offendingRows(rows) {
  return rows.filter(row => {
    if (GUARDED_CHANNELS.has(row.blocker) && row.lagMs >= THRESHOLD_MS) return true
    for (const label of GUARDED_CHANNELS) {
      const entry = row.blockers && row.blockers[label]
      if (entry && entry.maxMs >= THRESHOLD_MS) return true
    }
    return false
  })
}

export function assessLagObservation(observation) {
  const offenders = offendingRows(observation.rows || [])
  return { ok: observation.ok === true && offenders.length === 0, offenders }
}

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'main-thread-stall-qa-'))
  const checks = []
  const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok) }); console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`) }
  let child = null
  const executable = await stage(scratch)
  const profile = path.join(scratch, 'profile')
  const userData = path.join(profile, 'userdata')
  seedProfile(userData)
  const port = await freePort()
  const environment = sterileLaunchEnvironment(prepareSterileProfile(qaProfileDirectories(profile)))
  environment.MC_SMOKE_HEADLESS = '1'
  environment.MC_MAIN_LAG_THRESHOLD_MS = String(THRESHOLD_MS)
  const startedAt = Date.now()
  try {
    child = spawn(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { env: environment, stdio: 'ignore', windowsHide: true })
    const binding = lagObservationBinding({ profile, userData, environment, pid: child.pid, startedAt })
    const session = createSession(port, child)
    await session.open()
    await session.send('Runtime.enable')
    const evaluate = async expression => {
      const packet = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (packet.result?.exceptionDetails) throw new Error(packet.result.exceptionDetails.exception?.description || 'evaluate failed')
      return packet.result?.result?.value
    }
    const until = async (label, expression, attempts = 80) => { for (let i = 0; i < attempts; i += 1) { if (await evaluate(expression)) return; await delay(250) } throw new Error(`timed out waiting for ${label}`) }

    await until('the prefs bridge', 'Boolean(window.mcPrefs && window.mcScreenControl && window.mcSettings?.diagnosticsInspect)')
    check('the packaged candidate booted and exposed the prefs and screen-control bridges', true)

    // (a) 20 fleet-key writes in a burst, through the real mc-prefs:write IPC.
    const wrote = await evaluate(`(async () => {
      const out = [];
      for (let i = 0; i < 20; i += 1) {
        const r = window.mcPrefs.write('mc.fleet.chat-diffs.v1:seed-' + (i % 12), 'd'.repeat(300 * 1024 + i));
        out.push(r && r.ok === false ? ('refused:' + (r.error && r.error.code)) : 'ok');
      }
      return out.join(',');
    })()`)
    check('20 fleet-key writes were accepted', !wrote.includes('refused'), wrote.includes('refused') ? wrote : '20/20 ok')

    // (b) 20 screen.status calls with control off, through mc-screen-control:status.
    await evaluate(`(async () => { for (let i = 0; i < 20; i += 1) { await window.mcScreenControl.status(); } return true; })()`)
    check('20 screen.status calls completed with control off', true)

    // Let the lag sampler (250 ms) tick a few times so any stall is recorded.
    await delay(1500)

    const observation = await readLagObservation({ binding,
      inspect: request => evaluate('window.mcSettings.diagnosticsInspect(' + JSON.stringify(request) + ')') })
    check('the owned managed main-lag sink is complete and readable', observation.ok, observation.reason || observation.directory)
    const rows = observation.rows
    const verdict = assessLagObservation(observation)
    const offenders = verdict.offenders
    console.log(`  managed main-lag rows: ${rows.length}; offending (>= ${THRESHOLD_MS} ms from a guarded channel): ${offenders.length}`)
    for (const row of offenders.slice(0, 6)) {
      const worst = GUARDED_CHANNELS.has(row.blocker) ? `${row.blocker} lagMs=${row.lagMs}` : ''
      const perLabel = Object.entries(row.blockers || {}).filter(([label]) => GUARDED_CHANNELS.has(label)).map(([label, e]) => `${label} maxMs=${e.maxMs} total=${e.totalMs}`).join('; ')
      console.log(`    at ${row.at}: ${[worst, perLabel].filter(Boolean).join(' | ')}`)
    }
    check('no main-thread stall is attributable to mc-prefs:write or mc-screen-control:status', verdict.ok,
      !observation.ok ? 'diagnostic observation unavailable: ' + observation.reason : offenders.length ? `${offenders.length} offending row(s)` : `${rows.length} row(s) scanned, none from the two channels`)

    // The fleet documents left the settings record (the fix's shape), read back after the fact.
    const settingsSize = await evaluate(`(async () => { const s = await window.mcPrefs.read('mc.theme'); return typeof s; })()`)
    check('the theme still reads back', settingsSize === 'string' || settingsSize === 'object')

    session.close()
  } finally {
    if (child && child.pid) { try { reapProcessTree(child.pid) } catch { /* best effort */ } }
    if (!KEEP) { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* Windows may hold a handle briefly */ } }
  }

  const failed = checks.filter(c => !c.ok)
  console.log(`\nmain-thread-stall-packaged-qa: ${checks.length - failed.length}/${checks.length} checks passed.`)
  if (failed.length) { console.error(`FAILED: ${failed.map(c => c.name).join('; ')}`); process.exit(1) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`main-thread-stall-packaged-qa: ${error.message}`); process.exit(1) })
}
