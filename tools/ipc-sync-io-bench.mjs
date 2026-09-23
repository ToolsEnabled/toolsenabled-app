#!/usr/bin/env node

/* WHAT THE MAIN THREAD USED TO PAY FOR ONE HANDLER'S FILESYSTEM WORK.
 *
 * Every mc-* ipcMain.handle body in shell/main.cjs runs on Electron's main
 * thread, and so does the shell's own HTTP server. This measures the two
 * numbers that decide whether a per-call read belongs there:
 *
 *   block/call  the time the thread spent inside the call. For a synchronous
 *               call that is the whole call; for an awaited one it is only the
 *               JavaScript either side of the syscall, which is the part that
 *               still stops everybody else.
 *   beat p99    the worst late arrival of a 1 ms heartbeat standing in for
 *               everything else the thread owes -- window paints, IPC replies,
 *               the tree's timers.
 *
 * The BEFORE column is the shipped synchronous shape, copied verbatim from the
 * revision this replaced. The AFTER column calls shell/durable-file.cjs for
 * real, so the number cannot drift away from the code it describes.
 *
 * Each iteration is dispatched from its own setImmediate so the loop really
 * turns between calls. A tight await-loop over synchronous work hides the
 * whole batch inside one macrotask and reports a flat zero, which is how a
 * measurement of this can look like a fix that already happened.
 *
 *   node tools/ipc-sync-io-bench.mjs
 *   BENCH_N=600 BENCH_WRITE_N=200 node tools/ipc-sync-io-bench.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const require_ = createRequire(import.meta.url)
const durableFile = require_('../shell/durable-file.cjs')

const ROOT = fs.mkdtempSync(path.join(process.env.BENCH_ROOT || os.tmpdir(), 'ipc-sync-io-bench-'))
const FLEET_FILE = path.join(ROOT, 'fleet-profile.json')
const USAGE_FILE = path.join(ROOT, 'accounts-usage-cache.json')
const PURCHASE_FILE = path.join(ROOT, 'purchase-catalog.json')
const MAX_RECORD = 2 * 1024 * 1024 + 4096

/* Sized to what this machine's install actually keeps rather than to a guess:
   AppData/Roaming/ToolsEnabled-Live/accounts-usage-cache.json was 9,088 bytes
   when this was written. */
function usageText() {
  const account = {
    name: 'account-0',
    provider: 'claude',
    directory: path.join(ROOT, 'accounts', 'account-0'),
    status: 'ok',
    percentLeft: 61,
    resetsAt: new Date().toISOString(),
    windows: [{ kind: 'weekly', percentLeft: 61, resetsAt: new Date().toISOString() }],
  }
  const payload = { ok: true, readAt: new Date().toISOString(), accounts: [account], orders: [], policy: { mode: 'expiring-first' } }
  let text = `${JSON.stringify(payload, null, 2)}\n`
  while (Buffer.byteLength(text) < 9088) {
    payload.accounts.push({ ...account, name: `account-${payload.accounts.length}` })
    text = `${JSON.stringify(payload, null, 2)}\n`
  }
  return text
}

function fleetText() {
  const machines = []
  for (let index = 0; index < 24; index += 1) {
    machines.push({ id: `machine-${index}`, name: `Render station ${index}`, address: `render-${index}.local` })
  }
  return `${JSON.stringify({
    storageVersion: 1,
    state: 'configured',
    profile: {
      schemaVersion: 1,
      id: 'studio-fleet',
      label: 'Studio fleet',
      machines,
      transports: [{ id: 'relay', label: 'Relay', endpoint: 'relay.local:7443', port: 7443 }],
      dataSource: { kind: 'directory', path: path.join(ROOT, 'projection') },
    },
  })}\n`
}

const USAGE_TEXT = usageText()
const FLEET_TEXT = fleetText()
fs.writeFileSync(USAGE_FILE, USAGE_TEXT)
fs.writeFileSync(FLEET_FILE, FLEET_TEXT)
fs.writeFileSync(PURCHASE_FILE, JSON.stringify({ ok: true, items: [] }))

/* ---------- BEFORE: the shipped synchronous shapes, verbatim ---------- */

function readBoundedSync(file, maxBytes) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return { state: 'not-file' }
    if (typeof maxBytes === 'number' && stat.size > maxBytes) return { state: 'too-large' }
    return { state: 'present', text: fs.readFileSync(file, 'utf8') }
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'absent' : 'read-failed' }
  }
}

function replaceDurablySync(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = path.join(path.dirname(file), `.fleet-profile-${process.pid}-${randomUUID()}.tmp`)
  let descriptor
  try {
    descriptor = fs.openSync(temp, 'wx')
    fs.writeFileSync(descriptor, text, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temp, file)
  } finally {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor) } catch {} }
    try { fs.unlinkSync(temp) } catch {}
  }
}

function replaceAtomicallySync(file, text) {
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, text)
  fs.renameSync(temp, file)
}

function statBoundedSync(file, maxBytes) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return { state: 'not-file' }
    if (stat.size > maxBytes) return { state: 'too-large' }
    return { state: 'present' }
  } catch { return { state: 'absent' } }
}

/* ---------- the instrument ---------- */

const turn = () => new Promise(resolve => setImmediate(resolve))
const quantile = (list, at) => {
  if (!list.length) return 0
  const sorted = [...list].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(at * sorted.length))]
}
const mean = list => (list.length ? list.reduce((total, value) => total + value, 0) / list.length : 0)

async function measure(label, run, iterations, kind) {
  const gaps = []
  let last = performance.now()
  const heartbeat = setInterval(() => {
    const now = performance.now()
    gaps.push(now - last)
    last = now
  }, 1)
  await new Promise(resolve => setTimeout(resolve, 60))
  gaps.length = 0
  last = performance.now()

  const blocks = []
  const walls = []
  for (let index = 0; index < iterations; index += 1) {
    await turn()
    const started = performance.now()
    if (kind === 'sync') {
      run(index)
      const finished = performance.now()
      blocks.push(finished - started)
      walls.push(finished - started)
    } else {
      /* Only the synchronous head of an awaited call holds the thread; the
         rest is the syscall on libuv's pool with the loop free to turn. */
      const pending = run(index)
      blocks.push(performance.now() - started)
      await pending
      walls.push(performance.now() - started)
    }
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  clearInterval(heartbeat)

  return {
    label,
    iterations,
    blockMean: mean(blocks),
    blockP99: quantile(blocks, 0.99),
    blockMax: Math.max(...blocks),
    wallMean: mean(walls),
    beatP99: quantile(gaps, 0.99),
    beatMax: gaps.length ? Math.max(...gaps) : 0,
  }
}

const readCount = Number(process.env.BENCH_N || 300)
const writeCount = Number(process.env.BENCH_WRITE_N || 80)

const rows = []
rows.push(await measure('mc-fleet-profile:save  durable write BEFORE', () => replaceDurablySync(FLEET_FILE, FLEET_TEXT), writeCount, 'sync'))
rows.push(await measure('mc-fleet-profile:save  durable write AFTER', () => durableFile.replaceFileDurably(FLEET_FILE, FLEET_TEXT, { tempPrefix: '.fleet-profile' }), writeCount, 'async'))
rows.push(await measure('mc-accounts:list       cache read   BEFORE', () => readBoundedSync(USAGE_FILE), readCount, 'sync'))
rows.push(await measure('mc-accounts:list       cache read   AFTER', () => durableFile.readBoundedFile(USAGE_FILE), readCount, 'async'))
rows.push(await measure('mc-accounts:usage      cache write  BEFORE', () => replaceAtomicallySync(USAGE_FILE, USAGE_TEXT), readCount, 'sync'))
rows.push(await measure('mc-accounts:usage      cache write  AFTER', () => durableFile.replaceFileAtomically(USAGE_FILE, USAGE_TEXT), readCount, 'async'))
rows.push(await measure('/data/*.json           fleet read   BEFORE', () => readBoundedSync(FLEET_FILE, MAX_RECORD), readCount, 'sync'))
rows.push(await measure('/data/*.json           fleet read   AFTER', () => durableFile.readBoundedFile(FLEET_FILE, MAX_RECORD), readCount, 'async'))
rows.push(await measure('mc-checkout:surface    stat         BEFORE', () => statBoundedSync(PURCHASE_FILE, MAX_RECORD), readCount, 'sync'))
rows.push(await measure('mc-checkout:surface    stat         AFTER', () => durableFile.statBoundedFile(PURCHASE_FILE, MAX_RECORD), readCount, 'async'))

const pad = (value, width) => String(value).padEnd(width)
const num = value => value.toFixed(3).padStart(9)
console.log(`node ${process.version}  cpus ${os.cpus().length}  fleet record ${Buffer.byteLength(FLEET_TEXT)}B  usage cache ${Buffer.byteLength(USAGE_TEXT)}B`)
console.log(`${pad('path', 42)} ${pad('n', 4)} ${'block avg'.padStart(9)} ${'block p99'.padStart(9)} ${'block max'.padStart(9)} ${'wall avg'.padStart(9)} ${'beat p99'.padStart(9)} ${'beat max'.padStart(9)}`)
for (const row of rows) {
  console.log(`${pad(row.label, 42)} ${pad(row.iterations, 4)} ${num(row.blockMean)} ${num(row.blockP99)} ${num(row.blockMax)} ${num(row.wallMean)} ${num(row.beatP99)} ${num(row.beatMax)}`)
}
console.log('\nblock is what every other session pays. wall is what the one caller pays.')
fs.rmSync(ROOT, { recursive: true, force: true })
