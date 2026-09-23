#!/usr/bin/env node
/* T380 - THE ONE-TIME LEGACY-PROFILE SPLIT IS PAID ON THE BOOT PATH.
 *
 * T369 moved fleet documents (mc.fleet.trees.v1:*, mc.fleet.chat-diffs.v1:*)
 * out of renderer-prefs.json into renderer-fleet-documents.json. An
 * installation upgraded in place still has one ~5 MB legacy record, so the
 * FIRST 1.0.45 launch splits it. At 9413ef30 that split runs inside load(),
 * which is reached by the first rendererPrefs.snapshot() in shell/main.cjs -
 * before the window exists - and it pays TWO synchronous
 * temp-write-fsync-rename sequences there, one of them the whole corpus. T380
 * measured that as a one-time ~2 s cold-boot stall in front of first paint.
 *
 * WHAT THIS SCRIPT GATES, and why it is not a wall-clock gate. Wall clock on
 * this box is worthless as a pass/fail line: it was measured at 100% CPU with a
 * processor queue of 271, and the same code swings by an order of magnitude
 * between runs. So the gate is on WHAT THE BOOT PATH DOES TO THE DISK, which
 * is load-independent: how many bytes the store writes SYNCHRONOUSLY, and how
 * many fsyncs it forces, during construction and the first snapshot(). The
 * wall clock is measured and printed beside it as evidence, never as the gate.
 *
 * It also holds the rule the synchronous version bought, at both commits: at
 * every point after boot, every migrated document is readable from at least
 * one file on disk. A faster boot that can lose a document is not a fix.
 *
 * Usage:  node REPRO-LANEC-T380-COLDBOOT-SPLIT.mjs --app <path to app repo>
 * Exit 0 = GREEN, exit 1 = RED. Cross-platform: no shell, no platform paths.
 */

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import realFs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import process from 'node:process'

const argv = process.argv.slice(2)
const appIndex = argv.indexOf('--app')
if (appIndex === -1 || !argv[appIndex + 1]) {
  console.error('REFUSAL T380_REPRO_NO_APP_ROOT: this script measures one named module and will not guess where it is.')
  console.error('  node REPRO-LANEC-T380-COLDBOOT-SPLIT.mjs --app <path to the app repo or worktree>')
  process.exit(1)
}
const APP = path.resolve(argv[appIndex + 1])
const MODULE = path.join(APP, 'shell', 'renderer-prefs.cjs')
if (!existsSync(MODULE)) {
  console.error(`REFUSAL T380_REPRO_MODULE_ABSENT: ${MODULE} does not exist.`)
  process.exit(1)
}

const require_ = createRequire(import.meta.url)
const { createRendererPrefs } = require_(MODULE)

/* The boot-path budget. An ordinary settings record is a few kilobytes and the
   store is entitled to write one synchronously; the corpus is not. 64 KiB is
   an ordinary record with room to spare and is two orders of magnitude under
   the 5 MB this is about, so the line does not depend on being tuned. */
const SYNC_BOOT_BYTE_BUDGET = 64 * 1024

/* A record shaped like the owner's installation: T369 measured 3.6 MB of chat
   diffs and 1.5 MB of trees in a 5.2 MB renderer-prefs.json. */
const DIFF_NODES = 12
const DIFF_BYTES = 300_000
const TREE_COMPUTERS = 6
const TREE_BYTES = 250_000

function seedLegacyRecord(directory) {
  const legacy = {
    storageVersion: 1,
    values: { 'mc.theme': 'dark', 'mc.text-size': 'large' },
    drainedOrigins: ['http://127.0.0.1:4601'],
  }
  const documents = []
  for (let i = 0; i < DIFF_NODES; i += 1) {
    const key = `mc.fleet.chat-diffs.v1:node-${i}`
    legacy.values[key] = `d${i}`.padEnd(DIFF_BYTES, 'd')
    documents.push(key)
  }
  for (let i = 0; i < TREE_COMPUTERS; i += 1) {
    const key = `mc.fleet.trees.v1:computer-${i}`
    legacy.values[key] = `t${i}`.padEnd(TREE_BYTES, 't')
    documents.push(key)
  }
  const file = path.join(directory, 'renderer-prefs.json')
  writeFileSync(file, `${JSON.stringify(legacy)}\n`)
  return { file, documents, values: legacy.values }
}

/* Counts what the store does SYNCHRONOUSLY. Everything the module reaches for
   is forwarded to the real node:fs; only the synchronous write primitives are
   weighed, which is the work that holds the loop the window is waiting on. */
function countingFs(counter) {
  return new Proxy(realFs, {
    get(target, property) {
      const value = target[property]
      if (property === 'writeFileSync') {
        return (target_, data, options) => {
          if (counter.on) {
            counter.bytes += Buffer.byteLength(typeof data === 'string' ? data : (data || ''), 'utf8')
            counter.writes += 1
          }
          return realFs.writeFileSync(target_, data, options)
        }
      }
      if (property === 'fsyncSync') {
        return (descriptor) => {
          if (counter.on) counter.fsyncs += 1
          return realFs.fsyncSync(descriptor)
        }
      }
      if (typeof value === 'function') return value.bind(target)
      return value
    },
  })
}

/* Every migrated document must be readable from at least one file on disk. */
function documentsOnDisk(directory, documents) {
  const read = (name) => {
    const file = path.join(directory, name)
    if (!existsSync(file)) return {}
    try { return JSON.parse(readFileSync(file, 'utf8')).values || {} } catch { return {} }
  }
  const record = read('renderer-prefs.json')
  const fleet = read('renderer-fleet-documents.json')
  return documents.filter(key => typeof record[key] === 'string' || typeof fleet[key] === 'string')
}

const failures = []
function check(ok, line) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`)
  if (!ok) failures.push(line)
}

/* --repeat N: THE COLD-BOOT COST, MEASURED OFF THE MAIN-THREAD PATH DIRECTLY.
 *
 * The candidate A/B could not resolve this: cold boot on a loaded box is tens of
 * seconds with a ±20 s spread, so a one-time ~2 s split disappears into it. What
 * CAN be measured without a candidate is the thing itself -- the synchronous work
 * the store does between construction and the first snapshot() answering, which is
 * exactly what shell/main.cjs blocks on before createWindow(). Each repetition gets
 * its own freshly seeded directory, because the split is one-time by definition and
 * a second run over the same directory would measure nothing.
 *
 * This is a MEASUREMENT, not a gate: it prints a distribution and changes no exit
 * code. Wall clock here is still this machine's wall clock, so the caller is
 * expected to record the host load beside it. */
function measureBootPath(runs) {
  const samples = []
  for (let run = 0; run < runs; run += 1) {
    const directory = mkdtempSync(path.join(tmpdir(), 'lanec-t380-cost-'))
    try {
      seedLegacyRecord(directory)
      const counter = { on: true, bytes: 0, writes: 0, fsyncs: 0 }
      const fs = countingFs(counter)
      const started = process.hrtime.bigint()
      const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
      prefs.snapshot()
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      counter.on = false
      /* Cancels the pending debounced flush so the next repetition is not timed
         against this one's disk traffic. */
      try { prefs.sealForErase() } catch { /* an older build without the seal */ }
      samples.push({ ms, bytes: counter.bytes, fsyncs: counter.fsyncs })
    } finally {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { rmSync(directory, { recursive: true, force: true }); break } catch { /* retry */ }
      }
    }
  }
  const sorted = samples.map(s => s.ms).sort((a, b) => a - b)
  const at = q => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 100) / 100
  console.log(`# boot-path cost over ${runs} freshly seeded directories:`)
  console.log(`#   synchronous ms  p50 ${at(0.5)}  p95 ${at(0.95)}  min ${Math.round(sorted[0] * 100) / 100}  max ${Math.round(sorted[sorted.length - 1] * 100) / 100}`)
  console.log(`#   every run: ${samples.map(s => Math.round(s.ms * 10) / 10).join(', ')} ms`)
  console.log(`#   synchronous bytes ${[...new Set(samples.map(s => s.bytes))].join('/')}, fsyncs ${[...new Set(samples.map(s => s.fsyncs))].join('/')}`)
}

const repeatIndex = argv.indexOf('--repeat')
if (repeatIndex !== -1) {
  const runs = Number(argv[repeatIndex + 1])
  if (!Number.isInteger(runs) || runs < 1 || runs > 200) {
    console.error('REFUSAL T380_REPRO_BAD_REPEAT: --repeat takes a whole number of runs from 1 to 200.')
    process.exit(1)
  }
  measureBootPath(runs)
  process.exit(0)
}

const directory = mkdtempSync(path.join(tmpdir(), 'lanec-t380-'))
try {
  const seeded = seedLegacyRecord(directory)
  const legacyBytes = statSync(seeded.file).size
  console.log(`# legacy renderer-prefs.json seeded: ${legacyBytes} bytes, ${seeded.documents.length} fleet documents`)

  const counter = { on: true, bytes: 0, writes: 0, fsyncs: 0 }
  const fs = countingFs(counter)

  /* THE BOOT PATH. shell/main.cjs constructs the store and takes a snapshot
     before the window exists; everything inside this bracket is main-thread
     work a person waits through before first paint. */
  const started = process.hrtime.bigint()
  const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
  const snapshot = prefs.snapshot()
  const bootMs = Number(process.hrtime.bigint() - started) / 1e6
  counter.on = false

  console.log(`# boot path: ${counter.bytes} synchronous bytes written, ${counter.writes} synchronous writes, ${counter.fsyncs} fsyncs, ${bootMs.toFixed(1)} ms wall`)

  check(counter.bytes <= SYNC_BOOT_BYTE_BUDGET,
    `the boot path writes at most ${SYNC_BOOT_BYTE_BUDGET} bytes synchronously (wrote ${counter.bytes})`)
  check(counter.fsyncs <= 1,
    `the boot path forces at most one fsync (forced ${counter.fsyncs})`)

  /* The split is complete IN MEMORY before the first snapshot answers, which
     is what the renderer and every later settings write see. */
  check(snapshot.values['mc.theme'] === 'dark', 'the first snapshot still answers an ordinary setting')
  check(snapshot.values['mc.text-size'] === 'large', 'the first snapshot still answers the second ordinary setting')
  check(snapshot.values[seeded.documents[0]] === seeded.values[seeded.documents[0]],
    'the first snapshot answers a migrated chat-diff document unchanged')
  check(snapshot.values[seeded.documents.at(-1)] === seeded.values[seeded.documents.at(-1)],
    'the first snapshot answers a migrated tree document unchanged')
  check(JSON.stringify(snapshot.drainedOrigins) === JSON.stringify(['http://127.0.0.1:4601']),
    'the drain history survives the split')

  const covered = documentsOnDisk(directory, seeded.documents)
  check(covered.length === seeded.documents.length,
    `every document is on disk in some file immediately after boot (${covered.length}/${seeded.documents.length})`)

  /* An ordinary settings write inside the window must not be the write that
     drops the last copy. */
  const wrote = prefs.set('mc.theme', 'light')
  check(wrote && wrote.ok !== false, `an ordinary settings write inside the window succeeds (${JSON.stringify(wrote)})`)
  const coveredAfterWrite = documentsOnDisk(directory, seeded.documents)
  check(coveredAfterWrite.length === seeded.documents.length,
    `every document is still on disk after an ordinary settings write (${coveredAfterWrite.length}/${seeded.documents.length})`)

  const flushed = await prefs.flushFleetDocuments()
  check(flushed && flushed.ok !== false, `the deferred flush lands (${JSON.stringify(flushed)})`)

  const settledRecordBytes = statSync(seeded.file).size
  check(settledRecordBytes < 4096,
    `the settings record ends up small once the split has settled (${settledRecordBytes} bytes)`)

  const relaunched = createRendererPrefs({ directory, fs: realFs, path, randomUUID }).snapshot()
  let intact = 0
  for (const key of seeded.documents) if (relaunched.values[key] === seeded.values[key]) intact += 1
  check(intact === seeded.documents.length,
    `a relaunch reads every document back unchanged (${intact}/${seeded.documents.length})`)
  check(relaunched.values['mc.theme'] === 'light', 'a relaunch reads the setting written inside the window')
  check(relaunched.values['mc.text-size'] === 'large', 'a relaunch reads the untouched setting')
} finally {
  rmSync(directory, { recursive: true, force: true })
}

if (failures.length) {
  console.log(`\nRED: ${failures.length} check(s) failed`)
  for (const line of failures) console.log(`  - ${line}`)
  process.exit(1)
}
console.log('\nGREEN: the legacy split is off the boot path and no document is at risk')
