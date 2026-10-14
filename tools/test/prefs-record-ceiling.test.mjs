// THE ORDINARY-RECORD CEILING, AND THE WORK IT USED TO DO ON EVERY WRITE.
//
// LIMITATIONS-AND-HANDOFF-1.0.42.md section 4.28: settings writes are refused
// once the non-fleet partition reaches 1 MiB, and mc-prefs:write stalls the
// main thread. persist() in shell/renderer-prefs.cjs serialised the record
// TWICE per write -- once whole, once for the ordinary subset -- and the
// renderer blocks on that through ipcRenderer.sendSync
// (shell/fleet-profile-preload.cjs) and ipcMain.on('mc-prefs:write')
// (shell/main.cjs).
//
// Measured at 6909208e on a synthetic record shaped like the one 4.28 found
// (whole 1,290,653 bytes, ordinary 1,000,616 of 1,048,576): whole serialisation
// 9.15 ms, ordinary rebuild-and-serialise 8.71 ms, full synchronous set()
// 25.79 ms. Half the serialising in a write was the second pass.
//
// `ordinary` is the same record with keys REMOVED, so it can never serialise
// longer than the whole. When the whole text already fits, the ordinary check
// cannot fail and need not run.
//
// MOST OF THIS SUITE IS ABOUT WHAT MUST NOT CHANGE. A faster guard that refuses
// a different set of records is not an optimisation, it is a defect, so the
// boundary cases are asserted on both sides and they pass before and after.
// Only the last test is about the skip itself.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const require_ = createRequire(import.meta.url)
const here = fileURLToPath(import.meta.url)
const ROOT = dirname(dirname(dirname(here)))
const MODULE = join(ROOT, 'shell', 'renderer-prefs.cjs')
const { createRendererPrefs, MAX_RECORD_BYTES } = require_(MODULE)
const source = readFileSync(MODULE, 'utf8')

/* The predicate is taken from the module, never retyped: section 4.28 records
   two published figures that were wrong because someone retyped it. */
const predicateLine = /const isFleetTreeKey = (.+)/.exec(source)
const isFleetTreeKey = eval(predicateLine[1].replace(/\s*$/, ''))

test('the fleet-key predicate still behaves as the guard assumes', () => {
  assert.equal(isFleetTreeKey('mc.fleet.trees.v1:computer-abc'), true)
  assert.equal(isFleetTreeKey('mc.theme'), false)
})

function store() {
  const directory = mkdtempSync(join(tmpdir(), 'b13-ceiling-'))
  return { prefs: createRendererPrefs({ directory, fs, path, randomUUID }), directory }
}

test('an ordinary partition that crosses the ceiling is still refused', () => {
  const { prefs, directory } = store()
  const CHUNK = 'x'.repeat(40_000)
  let refusal = null
  for (let i = 0; i < 200; i += 1) {
    const answer = prefs.set(`mc.b13.filler.${i}`, CHUNK)
    if (answer && answer.ok === false) { refusal = answer; break }
  }
  assert.ok(refusal, 'the ordinary partition never refused, so the ceiling is gone')
  assert.equal(refusal.error.code, 'MC_PREFS_TOO_LARGE')
  rmSync(directory, { recursive: true, force: true })
})

test('a fleet key is still weighed on its own axis, not the ordinary one', () => {
  /* Section 4.28's central claim. If the skip ever measured the wrong corpus
     this is the test that would notice: a fleet value far past 1 MiB must
     still be accepted, because it is checked against 64 MiB. */
  const { prefs, directory } = store()
  const answer = prefs.set('mc.fleet.trees.v1:computer-abc', 'f'.repeat(2_000_000))
  assert.notEqual(answer && answer.ok, false, 'a fleet key was refused on the ordinary ceiling')
  rmSync(directory, { recursive: true, force: true })
})

test('a small ordinary setting still saves while the record sits near the ceiling', () => {
  /* The correction this suite records: 4.28 is titled "settings stop saving",
     and that is not what happens. The guard weighs the RESULTING record, so a
     value small enough to fit still goes through. What fails is a write large
     enough to cross. */
  const { prefs, directory } = store()
  const CHUNK = 'x'.repeat(40_000)
  for (let i = 0; i < 200; i += 1) {
    if ((prefs.set(`mc.b13.filler.${i}`, CHUNK) || {}).ok === false) break
  }
  const theme = prefs.set('mc.theme', 'dark')
  assert.notEqual(theme && theme.ok, false,
    'a small setting was refused, which would make "settings stop saving" literally true')
  rmSync(directory, { recursive: true, force: true })
})

test('a record under the ceiling saves, and reads back', () => {
  const { prefs, directory } = store()
  assert.notEqual((prefs.set('mc.theme', 'dark') || {}).ok, false)
  assert.equal(prefs.snapshot().values['mc.theme'], 'dark')
  rmSync(directory, { recursive: true, force: true })
})

test('a fleet document write never rewrites the settings record, and the settings record never carries the corpus (T369)', async () => {
  /* T369 replaces the skip this test used to pin: the two partitions are now
     two FILES, so the saving is no longer an absence that only time could
     observe. It is observable directly: after a burst of fleet writes the
     settings file has the same bytes it had before, the fleet file holds the
     documents once the debounced flush has run, and a relaunch reads both
     back through the one snapshot the renderer sees. A record shaped like the
     owner's (3.6 MB of chat diffs, 1.5 MB of trees) is what made a THEME
     TOGGLE cost 53 ms on an idle SSD and 12.7 s on the owner's disk. */
  const { prefs, directory } = store()
  assert.notEqual((prefs.set('mc.theme', 'dark') || {}).ok, false)
  const settingsBefore = fs.readFileSync(prefs.file, 'utf8')
  for (let i = 0; i < 12; i += 1) assert.notEqual((prefs.set(`mc.fleet.chat-diffs.v1:node-${i}`, 'd'.repeat(300_000)) || {}).ok, false)
  for (let i = 0; i < 6; i += 1) assert.notEqual((prefs.set(`mc.fleet.trees.v1:computer-${i}`, 't'.repeat(250_000)) || {}).ok, false)
  assert.equal(fs.readFileSync(prefs.file, 'utf8'), settingsBefore,
    'a fleet document write rewrote the settings record; the corpus is back on the settings path')
  assert.ok(fs.statSync(prefs.file).size < 4096, `the settings record is ${fs.statSync(prefs.file).size} bytes; it must stay small`)
  const flushed = await prefs.flushFleetDocuments()
  assert.equal(flushed.ok, true, JSON.stringify(flushed))
  assert.ok(fs.statSync(prefs.fleetFile).size > 5_000_000, 'the fleet file does not hold the documents that were written')
  const relaunched = createRendererPrefs({ directory, fs, path, randomUUID }).snapshot()
  assert.equal(relaunched.values['mc.theme'], 'dark')
  assert.equal(relaunched.values['mc.fleet.chat-diffs.v1:node-3'].length, 300_000)
  assert.equal(relaunched.values['mc.fleet.trees.v1:computer-5'].length, 250_000)
  rmSync(directory, { recursive: true, force: true })
})

/* The owner's installation is exactly this: one 5 MB renderer-prefs.json. */
function seedLegacyCorpus(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  const legacy = { storageVersion: 1, values: { 'mc.theme': 'dark' }, drainedOrigins: ['http://127.0.0.1:4601'] }
  const documents = []
  for (let i = 0; i < 12; i += 1) {
    const key = `mc.fleet.chat-diffs.v1:node-${i}`
    legacy.values[key] = 'd'.repeat(300_000)
    documents.push(key)
  }
  for (let i = 0; i < 6; i += 1) {
    const key = `mc.fleet.trees.v1:computer-${i}`
    legacy.values[key] = 't'.repeat(250_000)
    documents.push(key)
  }
  const file = join(directory, 'renderer-prefs.json')
  fs.writeFileSync(file, `${JSON.stringify(legacy)}\n`)
  return { directory, file, documents }
}

/* Which files on disk can still answer for each document. The rule the split
   must keep is that this is never empty for any of them. */
function documentsReadableOnDisk(directory, documents) {
  const read = (name) => {
    const target = join(directory, name)
    if (!fs.existsSync(target)) return {}
    try { return JSON.parse(fs.readFileSync(target, 'utf8')).values || {} } catch { return {} }
  }
  const record = read('renderer-prefs.json')
  const fleetDocuments = read('renderer-fleet-documents.json')
  return documents.filter(key => typeof record[key] === 'string' || typeof fleetDocuments[key] === 'string')
}

test('a legacy settings record that still carries the corpus is split on first load and loses nothing (T369)', async () => {
  /* The split is complete IN MEMORY before the first snapshot answers, and the
     documents are never absent from every file at once. The durable half is
     deferred (T380, below); what this test holds is that nothing is lost and
     the record ends up small once the split has settled. */
  const { directory, file, documents } = seedLegacyCorpus('b13-ceiling-legacy-')
  const legacyBytes = fs.statSync(file).size
  assert.ok(legacyBytes > 5_000_000)
  const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
  const snapshot = prefs.snapshot()
  assert.equal(snapshot.values['mc.theme'], 'dark')
  assert.equal(snapshot.values['mc.fleet.chat-diffs.v1:node-11'].length, 300_000)
  assert.deepEqual(snapshot.drainedOrigins, ['http://127.0.0.1:4601'])
  assert.equal(documentsReadableOnDisk(directory, documents).length, documents.length,
    'a document was absent from every file on disk during the split')
  const flushed = await prefs.flushFleetDocuments()
  assert.notEqual((flushed || {}).ok, false, JSON.stringify(flushed))
  assert.ok(fs.statSync(file).size < 4096, `the settings record is still ${fs.statSync(file).size} bytes after migration`)
  assert.ok(fs.statSync(prefs.fleetFile).size > 5_000_000, 'the fleet file did not receive the migrated documents')
  const again = createRendererPrefs({ directory, fs, path, randomUUID }).snapshot()
  assert.equal(Object.keys(again.values).length, 19)
  rmSync(directory, { recursive: true, force: true })
})

/* ---- T380: the split must not be paid in front of first paint ---- */

/* Counts the SYNCHRONOUS write work a store does, which is the work that holds
   the loop shell/main.cjs is on while the window does not exist yet. Delegates
   everything to the real module so nothing else about the store changes. */
function weighingFs(counter) {
  return new Proxy(fs, {
    get(target, property) {
      if (property === 'writeFileSync') {
        return (target_, data, options) => {
          if (counter.on) {
            counter.bytes += Buffer.byteLength(typeof data === 'string' ? data : (data || ''), 'utf8')
          }
          return fs.writeFileSync(target_, data, options)
        }
      }
      if (property === 'fsyncSync') {
        return (descriptor) => {
          if (counter.on) counter.fsyncs += 1
          return fs.fsyncSync(descriptor)
        }
      }
      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('the one-time legacy split is not paid on the boot path (T380)', async () => {
  /* T380: load() is reached by the first rendererPrefs.snapshot() in
     shell/main.cjs, before the window exists, so anything synchronous here is
     in front of first paint. Splitting the corpus synchronously there cost a
     one-time ~2 s stall on the first 1.0.45 launch of an upgraded install.
     Measured as bytes and fsyncs rather than milliseconds on purpose: the
     machine this runs on is shared and a wall-clock line would be a coin
     toss, while what the boot path asks of the disk is the same everywhere. */
  const { directory, documents } = seedLegacyCorpus('b13-t380-boot-')
  const counter = { on: true, bytes: 0, fsyncs: 0 }
  const prefs = createRendererPrefs({ directory, fs: weighingFs(counter), path, randomUUID })
  const snapshot = prefs.snapshot()
  counter.on = false
  assert.ok(counter.bytes <= 64 * 1024,
    `the boot path wrote ${counter.bytes} bytes synchronously; the corpus is back in front of first paint`)
  assert.ok(counter.fsyncs <= 1, `the boot path forced ${counter.fsyncs} fsyncs`)
  // The move itself still happened, in memory, before that snapshot answered.
  assert.equal(snapshot.values['mc.fleet.chat-diffs.v1:node-0'].length, 300_000)
  assert.equal(snapshot.values['mc.theme'], 'dark')
  assert.equal(documentsReadableOnDisk(directory, documents).length, documents.length)
  const flushed = await prefs.flushFleetDocuments()
  assert.notEqual((flushed || {}).ok, false, JSON.stringify(flushed))
  const relaunched = createRendererPrefs({ directory, fs, path, randomUUID }).snapshot()
  for (const key of documents) assert.ok(typeof relaunched.values[key] === 'string', `${key} did not survive the deferred split`)
  prefs.sealForErase()
  rmSync(directory, { recursive: true, force: true })
})

test('a settings write inside the deferred-split window never drops the last copy of a document (T380)', () => {
  /* The window is the only place the deferred split can go wrong: until the
     fleet file reaches disk, the settings file holds the only copy, and an
     ordinary write rewrites the settings file. */
  const { directory, file, documents } = seedLegacyCorpus('b13-t380-window-')
  const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
  assert.equal(prefs.snapshot().values['mc.theme'], 'dark')
  const wrote = prefs.set('mc.theme', 'light')
  assert.notEqual((wrote || {}).ok, false, JSON.stringify(wrote))
  assert.equal(documentsReadableOnDisk(directory, documents).length, documents.length,
    'an ordinary settings write inside the window dropped the last copy of a document')
  assert.ok(fs.statSync(file).size < 4096, `the settings record is ${fs.statSync(file).size} bytes after the window closed`)
  const relaunched = createRendererPrefs({ directory, fs, path, randomUUID }).snapshot()
  assert.equal(relaunched.values['mc.theme'], 'light')
  for (const key of documents) assert.ok(typeof relaunched.values[key] === 'string', `${key} did not survive a write inside the window`)
  prefs.sealForErase()
  rmSync(directory, { recursive: true, force: true })
})

test('a quit inside the deferred-split window finishes the split rather than repeating it (T380)', () => {
  const { directory, file, documents } = seedLegacyCorpus('b13-t380-quit-')
  const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
  assert.equal(prefs.snapshot().values['mc.theme'], 'dark')
  const drained = prefs.flushFleetDocumentsSync()
  assert.notEqual((drained || {}).ok, false, JSON.stringify(drained))
  assert.ok(fs.statSync(file).size < 4096, `the settings record is ${fs.statSync(file).size} bytes after the quit drain`)
  assert.ok(fs.statSync(prefs.fleetFile).size > 5_000_000, 'the quit drain did not write the fleet file')
  const relaunched = createRendererPrefs({ directory, fs, path, randomUUID }).snapshot()
  for (const key of documents) assert.ok(typeof relaunched.values[key] === 'string', `${key} did not survive the quit drain`)
  prefs.sealForErase()
  rmSync(directory, { recursive: true, force: true })
})

test('a deferred split whose fleet write keeps failing keeps the legacy record intact for the next launch (T380)', () => {
  /* A fix that trades a stall for a data loss is not a fix. When the fleet file
     cannot be written at all, the settings record must still carry the
     documents, so the next launch migrates them again. */
  const { directory, file, documents } = seedLegacyCorpus('b13-t380-refuse-')
  const refusing = new Proxy(fs, {
    get(target, property) {
      if (property === 'promises') return undefined
      if (property === 'openSync') {
        return (target_, flags) => {
          if (String(target_).includes('renderer-fleet-documents')) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
          return fs.openSync(target_, flags)
        }
      }
      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const prefs = createRendererPrefs({ directory, fs: refusing, path, randomUUID })
  assert.equal(prefs.snapshot().values['mc.fleet.trees.v1:computer-0'].length, 250_000)
  const wrote = prefs.set('mc.theme', 'light')
  assert.equal((wrote || {}).ok, false, 'a settings write proceeded while the documents had nowhere else to live')
  assert.equal(wrote.error.code, 'MC_PREFS_WRITE_FAILED')
  assert.ok(fs.statSync(file).size > 5_000_000,
    `the settings record is ${fs.statSync(file).size} bytes; the documents were dropped with nowhere to go`)
  const relaunched = createRendererPrefs({ directory, fs, path, randomUUID }).snapshot()
  for (const key of documents) assert.ok(typeof relaunched.values[key] === 'string', `${key} was lost when the fleet write failed`)
  prefs.sealForErase()
  rmSync(directory, { recursive: true, force: true })
})

test('the fleet file is bounded: a document that would push it past its envelope is refused by name', () => {
  const { prefs, directory } = store()
  const big = 'b'.repeat(30 * 1024 * 1024)
  assert.notEqual((prefs.set('mc.fleet.chat-diffs.v1:one', big) || {}).ok, false)
  assert.notEqual((prefs.set('mc.fleet.chat-diffs.v1:two', big) || {}).ok, false)
  const third = prefs.set('mc.fleet.chat-diffs.v1:three', big)
  assert.equal(third.ok, false)
  assert.equal(third.error.code, 'MC_PREFS_TOO_LARGE')
  assert.equal(prefs.snapshot().values['mc.fleet.chat-diffs.v1:three'], undefined, 'a refused document must not be kept in memory either')
  rmSync(directory, { recursive: true, force: true })
})
