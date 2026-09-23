'use strict'

/* WHERE A PERSON'S SETTINGS ACTUALLY LIVE.
 *
 * Everything the renderer persisted -- theme, text size, mc.live.*, mc.write.*,
 * the first-run profile, the chatbox settings -- was browser storage, and
 * browser storage is partitioned by ORIGIN. The origin of this application is
 * http://127.0.0.1:<port>, and shell/port-scan.cjs chooses <port> by scanning
 * 4601-4609 at launch. So the settings were, without anyone deciding this,
 * keyed to whichever port happened to be free the first time somebody opened
 * the app. Relaunch with that port held -- a lingering process, a QA build, a
 * second install, a fast restart -- and the app comes up one port along, which
 * is a different origin, which is an empty partition. Every choice the person
 * made is gone, there is no error, and the only available conclusion is that
 * the software is broken. Measured on the packaged build: a run that chose
 * black theme on 4603 painted white on 4604 with all six probe keys reading
 * null.
 *
 * This file is the fix: the settings live in ONE file in userData, which no
 * port can partition. The renderer keeps calling localStorage; what changed is
 * what localStorage IS (see public/durable-storage.js and the mcPrefs bridge in
 * shell/fleet-profile-preload.cjs).
 *
 * ONE STORE, NOT TWO. The repeated defect in this codebase is a second copy
 * that drifts from the first, so this file is deliberately the only writer of
 * its record, and the browser copy it migrates from is drained exactly once per
 * origin and then never consulted again. `drainedOrigins` is what makes that
 * true, and it is why a key the person DELETED after migrating cannot come back
 * from the stale browser copy on the next launch.
 *
 * IT IS NOT A SECURITY BOUNDARY, AND IT DOES NOT WEAKEN ONE. The origin
 * partition was never doing security work for these keys: src/checkout-principal.js
 * states plainly that anything with devtools could write a different name into
 * localStorage, which is why identity is NOT taken from it. Nothing secret is
 * stored here -- no password, no token, no account principal -- and the IPC in
 * front of it is gated on the application's own main frame at its own origin,
 * the same check the fleet profile uses. Moving preferences out of the browser
 * partition and into a per-user file under userData does not widen who can read
 * them: a process that can read this file could already read the LevelDB the
 * browser partition was kept in.
 */

const STORAGE_VERSION = 1
const RECORD_FILE = 'renderer-prefs.json'

/* Bounds exist so a page cannot turn a preferences file into unbounded disk.
   They are generous against real settings -- the whole shipped set is a few
   hundred bytes. Fleet documents use the separate bounded envelope below. */
const MAX_KEYS = 512
const MAX_KEY_LENGTH = 256
const MAX_VALUE_LENGTH = 64 * 1024
const MAX_RECORD_BYTES = 1024 * 1024
// Trees and retained chat diffs are documents containing multiple nodes, not
// ordinary preferences. Chat history retains up to 1 Mi characters of patches
// per node, so a 64 Ki preference cell cannot hold even one retained node.
// Both exact namespaces share this existing document/aggregate envelope. No
// history is trimmed to fit it: an oversized write refuses as a whole, keeping
// the previous record. Ordinary-cell and ordinary-record budgets stay intact.
const MAX_FLEET_VALUE_LENGTH = 32 * 1024 * 1024
const MAX_FLEET_RECORD_BYTES = 64 * 1024 * 1024
const isFleetTreeKey = key => /^mc\.fleet\.trees\.v1:[^\u0000-\u001f\u007f]{1,180}$/.test(key)
const isChatDiffHistoryKey = key => /^mc\.fleet\.chat-diffs\.v1:[^\u0000-\u001f\u007f]{1,180}$/.test(key)
const isFleetDocumentKey = key => isFleetTreeKey(key) || isChatDiffHistoryKey(key)
const MAX_DRAINED_ORIGINS = 32

/* THE FLEET DOCUMENTS LIVE IN THEIR OWN FILE, AND THAT FILE IS WRITTEN OFF THE
 * MAIN THREAD.
 *
 * T369, measured on the owner's installation 2026-09-18: renderer-prefs.json
 * was 5.2 MB, 3.6 MB of it mc.fleet.chat-diffs.v1 and 1.5 MB mc.fleet.trees.v1,
 * and persist() below serialised, wrote, fsync'd and renamed the WHOLE record
 * synchronously on the main thread on every settings change while the renderer
 * waited on sendSync. main-lag.log recorded a 12,767 ms stall (mainThread
 * "waited", ~10 s of it in the fsync) topped by mc-prefs:write. Measured at
 * this commit on an idle SSD with a synthetic record of that shape: 49 ms per
 * write, and a THEME TOGGLE cost 53 ms because it rewrote the 5 MB corpus.
 *
 * So the two partitions the bounds above already recognise now live apart:
 *   - ordinary keys stay in renderer-prefs.json, written exactly as before
 *     (temp, write, fsync, rename, synchronously) -- it is a few kilobytes
 *     again, so that durability costs a millisecond, not a corpus;
 *   - fleet document keys live in RENDERER_FLEET_FILE, kept in memory, answered
 *     to the renderer immediately, and written by a DEBOUNCED ASYNCHRONOUS
 *     temp-write-rename (fs.promises, so the write, its fsync and the rename all
 *     happen on the libuv pool, never on the loop the window is waiting on).
 *     A burst of chat-diff writes becomes one write; nothing waits more than
 *     FLEET_FLUSH_MAX_WAIT_MS to reach disk while writes keep arriving.
 *
 * The fsync IS kept for the fleet file -- it costs nothing on the main thread
 * once it is asynchronous, and the proof for the ordinary partition (force-kill
 * between launches) is the one this store already promises. What is traded is
 * the LAST debounce window: a fleet document written in the ~250 ms before a
 * crash can be lost. That document is retained chat history or a tree layout,
 * re-derived from the conversation it mirrors; a setting is never in it. On a
 * graceful quit flushFleetDocumentsSync() drains the window (shell/main.cjs).
 *
 * The renderer sees ONE store: snapshot() merges both files, and a legacy
 * record that still carries fleet keys is migrated on first load -- in memory
 * at once, on disk off the boot path (T380: see migrateLegacyFleetKeys) -- so
 * an installation upgraded in place loses nothing, never pays the corpus on a
 * settings change again, and does not pay the split in front of first paint
 * either. */
const RENDERER_FLEET_FILE = 'renderer-fleet-documents.json'
const FLEET_FLUSH_DEBOUNCE_MS = 250
const FLEET_FLUSH_MAX_WAIT_MS = 2000
const FLEET_QUARANTINE_PREFIX = 'renderer-fleet-documents.damaged'

/* See the note in persist(): a Windows replace can fail transiently because
   another process is briefly holding the file. Four short waits totalling 15ms
   in the worst case, which is under a rendered frame. */
const PERSIST_ATTEMPTS = 5
const PERSIST_BACKOFF_MS = Object.freeze([1, 2, 4, 8])
const RETRYABLE_WRITE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST'])

/* THE READ GETS THE RETRY THE WRITE ALREADY HAD.
 *
 * This file documented the Windows transient-handle problem and defended
 * against it in one direction only. That asymmetry mattered far more than it
 * looks: a dropped write loses ONE setting, while a dropped read at startup
 * makes the whole record read as empty, which is the silent factory reset this
 * store exists to end -- and it then let the next write flatten a file that was
 * never actually damaged. Measured: one EBUSY on the startup read was enough,
 * with a single attempt made before this.
 *
 * EEXIST is deliberately not in this set. It belongs to the write path's
 * `openSync(temporary, 'wx')` and means nothing for a read; carrying it over
 * would be widening a rule by copy-paste. ENOENT is not retried either -- a
 * file that is genuinely absent is a first launch, not a transient. */
const RETRYABLE_READ_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])

/* ROLLING COPIES, TAKEN BEFORE A BULK REMOVAL DESTROYS WHAT IS ON DISK.
 *
 * Everything else in this file defends the record against being WRITTEN badly:
 * an unreadable file is set aside rather than flattened, a failed rename is
 * retried, a fleet document is never absent from every file at once. None of
 * that defends it against being EMPTIED correctly. On 2026-09-20 a single
 * clear() on the owner's installation removed six trees, 82 agent nodes and
 * every renderer preference, and there was nothing on disk to go back to --
 * recovery took 45 minutes and the preferences are gone for good.
 *
 * So a bulk removal copies both files first, dated, newest MAX_ROLLING_BACKUPS
 * kept. Deliberately NOT the damaged path: quarantineDamaged() already
 * preserves those bytes and a second copy of the same file would only spend a
 * slot. Deliberately NOT prepareNodePrivacyCleanup(): a person removing their
 * saved nodes is not asking for a copy of them to be left behind.
 *
 * The copies live in userData beside the record, so the product's own removal
 * paths -- shell/local-data-reset.cjs sweeps that directory whole, and
 * shell/uninstall-retention.cjs inventories it -- carry them off without
 * having to learn a new name. Their prefix is distinct from the quarantine
 * prefix so they do not spend that budget either. */
const MAX_ROLLING_BACKUPS = 5
const BACKUP_INFIX = '.backup-'
const BACKUP_BASES = Object.freeze([
  ['renderer-prefs', RECORD_FILE],
  ['renderer-fleet-documents', RENDERER_FLEET_FILE],
])

/* Colons and dots are illegal in a Windows filename, as quarantineFileName()
   already records, so the ISO stamp is written with dashes throughout. It sorts
   lexicographically in date order, which is what the prune below relies on. */
function backupFileName(base, stamp) {
  return `${base}${BACKUP_INFIX}${stamp.toISOString().replace(/[:.]/g, '-')}.json`
}

function isBackupFile(name, base) {
  return name.startsWith(`${base}${BACKUP_INFIX}`)
}

/* How many damaged records may be set aside before this store stops trying.
   Bounded so a file that is damaged on every launch cannot fill a disk with
   copies of itself; reaching the bound refuses the write, which still does not
   destroy anything. */
const MAX_QUARANTINE_FILES = 8
const QUARANTINE_PREFIX = 'renderer-prefs.damaged'

/* The word a caller inside this process says to clear() when it is the
   product's own data removal talking. It is not reachable from the renderer:
   mc-prefs:clear in shell/main.cjs forwards no options. */
const RESET_INTENT = 'local-data-reset'

/* THE SET-ASIDE COPY IS DATED, because the person is going to be told about it
   and "renderer-prefs.damaged-3.json" does not answer the question they will
   actually have, which is WHICH ONE IS MINE. An index only orders the copies
   against each other; a date says whether this is the settings they lost this
   morning or a file from a fault three months ago they already gave up on.
   Colons and dots are illegal in a Windows filename, so the ISO timestamp is
   written with dashes throughout. */
function quarantineFileName(stamp) {
  return `${QUARANTINE_PREFIX}-${stamp.toISOString().replace(/[:.]/g, '-')}.json`
}

function isQuarantineFile(name) {
  /* The dotted form is what builds before the dated name wrote. It is counted
     against the bound so an upgrade cannot restart the budget from zero. */
  return name === `${QUARANTINE_PREFIX}.json` || name.startsWith(`${QUARANTINE_PREFIX}-`)
}

/* A synchronous pause. The whole store is synchronous on purpose -- it stands
   in for localStorage, which is durable when the setter returns -- so the retry
   cannot hand control back to the event loop and let a second write interleave
   with this one. */
function pauseSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function failure(code, message) {
  return { ok: false, error: { code, message } }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function setOwn(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true })
}

function emptyRecord() {
  return { storageVersion: STORAGE_VERSION, values: {}, drainedOrigins: [] }
}

/* A malformed or future-versioned record is NOT treated as "no settings and
   carry on quietly". It starts empty so the app still opens, but it does not
   mark anything drained, so a browser copy that is still reachable on this
   origin can be adopted on this very launch and the person gets their settings
   back instead of a silent reset -- which is the entire failure this file
   exists to end. */
function parseRecord(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch {
    return { record: emptyRecord(), damaged: 'the settings file contains malformed JSON' }
  }
  if (!isPlainObject(parsed)) {
    return { record: emptyRecord(), damaged: 'the settings file does not contain a JSON object' }
  }
  if (parsed.storageVersion !== STORAGE_VERSION) {
    return { record: emptyRecord(), damaged: `the settings file has storage version ${JSON.stringify(parsed.storageVersion)}, which this build does not understand` }
  }
  const values = {}
  if (isPlainObject(parsed.values)) {
    for (const [key, value] of Object.entries(parsed.values)) {
      if (typeof key === 'string' && typeof value === 'string') setOwn(values, key, value)
    }
  }
  const drainedOrigins = Array.isArray(parsed.drainedOrigins)
    ? parsed.drainedOrigins.filter((origin) => typeof origin === 'string').slice(0, MAX_DRAINED_ORIGINS)
    : []
  return { record: { storageVersion: STORAGE_VERSION, values, drainedOrigins }, damaged: null }
}

function validateEntry(key, value) {
  if (typeof key !== 'string' || key.length === 0) return 'a settings key must be a non-empty string'
  if (key.length > MAX_KEY_LENGTH) return `a settings key may not exceed ${MAX_KEY_LENGTH} characters`
  if (typeof value !== 'string') return 'a settings value must be a string'
  const limit = isFleetDocumentKey(key) ? MAX_FLEET_VALUE_LENGTH : MAX_VALUE_LENGTH
  if (value.length > limit) return `a settings value may not exceed ${limit} characters`
  return null
}

function createRendererPrefs({ directory, fs, path, randomUUID, pid = process.pid, now = () => new Date(), validateTreeChange = null }) {
  if (!directory) throw new TypeError('createRendererPrefs requires a directory')
  const file = path.join(directory, RECORD_FILE)

  let record = null
  let damaged = null
  let sealedForErase = false
  const erasedRefusal = () => failure('MC_PREFS_ERASED', 'Settings writes are stopped for data removal. Restart ToolsEnabled before saving settings again.')
  /* WHERE THE UNREADABLE FILE WENT, kept so the product can say it out loud.
     Preserving the bytes and not telling anybody is only half a fix: the person
     still sees every setting they chose replaced by defaults, and a silent
     recovery is indistinguishable from the silent factory reset it replaced.
     This is the fact src/settings-recovery-notice.js turns into a sentence. */
  let preservedAt = null

  function readFileWithRetry() {
    let lastError = null
    for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
      try {
        return { text: fs.readFileSync(file, 'utf8'), error: null }
      } catch (error) {
        lastError = error
        if (!RETRYABLE_READ_ERRORS.has(error && error.code)) break
        if (attempt < PERSIST_ATTEMPTS - 1) pauseSync(PERSIST_BACKOFF_MS[attempt])
      }
    }
    return { text: null, error: lastError }
  }

  /* ---- the fleet-document partition (T369) ---- */
  const fleetFile = path.join(directory, RENDERER_FLEET_FILE)
  let fleet = null            // { [key]: value } for fleet document keys only
  let fleetBytes = new Map()  // key -> UTF-8 byte length of its value, for the record bound
  let fleetDamaged = null     // why the fleet file could not be read, or null
  let fleetRevision = 0       // bumped on every in-memory fleet change
  let fleetFlushedRevision = 0
  let fleetTimer = null
  let fleetFirstDirtyAt = null
  let fleetFlushing = null    // the in-flight async flush, or null
  let fleetLastError = null   // the last async flush failure, reported by snapshot()
  /* T380: true between the in-memory legacy split and the settings-record
     rewrite that completes it. While it is true the SETTINGS FILE ON DISK is
     still the only copy of the migrated documents, and nothing may rewrite it
     without putting the fleet file down first. */
  let legacyRecordCarriesFleetKeys = false

  function fleetTotalBytes() {
    let total = 0
    for (const bytes of fleetBytes.values()) total += bytes
    return total
  }

  function readFleetFile() {
    let lastError = null
    for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
      try {
        return { text: fs.readFileSync(fleetFile, 'utf8'), error: null }
      } catch (error) {
        lastError = error
        if (!RETRYABLE_READ_ERRORS.has(error && error.code)) break
        if (attempt < PERSIST_ATTEMPTS - 1) pauseSync(PERSIST_BACKOFF_MS[attempt])
      }
    }
    return { text: null, error: lastError }
  }

  function parseFleetRecord(text) {
    let parsed
    try { parsed = JSON.parse(text) } catch {
      return { values: {}, damaged: 'the fleet document file contains malformed JSON' }
    }
    if (!isPlainObject(parsed) || parsed.storageVersion !== STORAGE_VERSION || !isPlainObject(parsed.values)) {
      return { values: {}, damaged: 'the fleet document file is not a record this build understands' }
    }
    const values = {}
    for (const [key, value] of Object.entries(parsed.values)) {
      if (typeof key === 'string' && typeof value === 'string' && isFleetDocumentKey(key)) setOwn(values, key, value)
    }
    return { values, damaged: null }
  }

  function adoptFleet(values) {
    fleet = values
    fleetBytes = new Map(Object.entries(values).map(([key, value]) => [key, Buffer.byteLength(value, 'utf8')]))
  }

  function loadFleet() {
    if (fleet) return fleet
    const read = readFleetFile()
    if (read.error) {
      if (read.error.code !== 'ENOENT') {
        fleetDamaged = `the fleet document file could not be read (${read.error.code || 'unknown error'})`
      }
      adoptFleet({})
      return fleet
    }
    const parsed = parseFleetRecord(read.text)
    fleetDamaged = parsed.damaged
    adoptFleet(parsed.values)
    return fleet
  }

  function serializeFleet() {
    return `${JSON.stringify({ storageVersion: STORAGE_VERSION, values: fleet })}\n`
  }

  /* The damaged fleet file is set aside, dated, before it is replaced -- the
     same rule quarantineDamaged() applies to the ordinary record, bounded by
     the same count across both prefixes. Best effort: a copy that cannot be
     set aside leaves the file in place and the flush fails by name rather than
     destroying what could not be read. */
  function quarantineDamagedFleet() {
    let existing
    try {
      existing = fs.readdirSync(directory).filter(name => isQuarantineFile(name) || name.startsWith(FLEET_QUARANTINE_PREFIX)).length
    } catch (error) {
      return error
    }
    if (existing >= MAX_QUARANTINE_FILES) return Object.assign(new Error('damaged copies are at their limit'), { code: 'MC_PREFS_DAMAGED' })
    const target = path.join(directory, quarantineFileName(now()).replace(QUARANTINE_PREFIX, FLEET_QUARANTINE_PREFIX))
    try {
      fs.renameSync(fleetFile, target)
      fleetDamaged = null
      return null
    } catch (error) {
      if (error && error.code === 'ENOENT') { fleetDamaged = null; return null }
      return error
    }
  }

  /* Synchronous temp-write-fsync-rename of the fleet file. Used for the quit
     drain, for the privacy cleanup, and to close the one-time legacy split
     before an ordinary settings write would drop the last copy of the migrated
     documents -- never on an ordinary settings write in the steady state. */
  function flushFleetSync() {
    if (!fleet) return { ok: true, unchanged: true }
    if (fleetDamaged) {
      const problem = quarantineDamagedFleet()
      if (problem) return failure('MC_PREFS_DAMAGED', `Refusing to overwrite fleet documents that could not be read (${fleetDamaged}): ${problem.code || problem.message}.`)
    }
    const revision = fleetRevision
    let lastError = null
    for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
      lastError = attemptPersistTo(fleetFile, serializeFleet())
      if (lastError === null) {
        fleetFlushedRevision = Math.max(fleetFlushedRevision, revision)
        fleetLastError = null
        return { ok: true }
      }
      if (!RETRYABLE_WRITE_ERRORS.has(lastError && lastError.code)) break
      if (attempt < PERSIST_ATTEMPTS - 1) pauseSync(PERSIST_BACKOFF_MS[attempt])
    }
    fleetLastError = lastError
    return failure('MC_PREFS_WRITE_FAILED', `Fleet documents could not be saved (${lastError && lastError.code ? lastError.code : 'unknown error'}).`)
  }

  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

  /* The asynchronous flush: every disk operation goes through fs.promises so
     the main thread never waits on the write, the fsync or the rename. Falls
     back to the synchronous sequence inside the timer when the injected fs has
     no promises API (a test double), which is still off the IPC critical path. */
  async function writeFleetAsync(text) {
    if (!fs.promises || typeof fs.promises.open !== 'function') {
      const error = attemptPersistTo(fleetFile, text)
      if (error) throw error
      return
    }
    const temporary = path.join(directory, `.renderer-fleet-documents-${pid}-${randomUUID()}.tmp`)
    let handle
    try {
      await fs.promises.mkdir(directory, { recursive: true })
      handle = await fs.promises.open(temporary, 'wx')
      await handle.writeFile(text, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      let lastError = null
      for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
        try { await fs.promises.rename(temporary, fleetFile); return } catch (error) {
          lastError = error
          if (!RETRYABLE_WRITE_ERRORS.has(error && error.code)) throw error
          if (attempt < PERSIST_ATTEMPTS - 1) await sleep(PERSIST_BACKOFF_MS[attempt])
        }
      }
      throw lastError
    } finally {
      if (handle !== undefined) { try { await handle.close() } catch { /* closing a failed handle */ } }
      try { await fs.promises.unlink(temporary) } catch { /* already renamed away */ }
    }
  }

  function runFleetFlush() {
    fleetTimer = null
    fleetFirstDirtyAt = null
    if (fleetFlushing) return fleetFlushing
    if (sealedForErase || !fleet) return Promise.resolve()
    const revision = fleetRevision
    fleetFlushing = (async () => {
      if (fleetDamaged) {
        const problem = quarantineDamagedFleet()
        if (problem) throw problem
      }
      await writeFleetAsync(serializeFleet())
      fleetFlushedRevision = Math.max(fleetFlushedRevision, revision)
      fleetLastError = null
      /* The fleet file is on disk now, so a pending legacy split may finish. */
      completeLegacySplit()
    })().catch((error) => {
      fleetLastError = error
    }).finally(() => {
      fleetFlushing = null
      /* Writes that landed while this one was on the pool get their own flush. */
      if (fleetRevision !== fleetFlushedRevision && !sealedForErase) scheduleFleetFlush()
    })
    return fleetFlushing
  }

  function scheduleFleetFlush() {
    if (sealedForErase) return
    const at = Date.now()
    if (fleetFirstDirtyAt === null) fleetFirstDirtyAt = at
    if (fleetTimer) clearTimeout(fleetTimer)
    const waited = at - fleetFirstDirtyAt
    const wait = Math.max(0, Math.min(FLEET_FLUSH_DEBOUNCE_MS, FLEET_FLUSH_MAX_WAIT_MS - waited))
    fleetTimer = setTimeout(() => { void runFleetFlush() }, wait)
    if (typeof fleetTimer.unref === 'function') fleetTimer.unref()
  }

  function setFleetValue(key, value) {
    const current = loadFleet()
    const next = { ...current }
    setOwn(next, key, value)
    fleet = next
    fleetBytes.set(key, Buffer.byteLength(value, 'utf8'))
    fleetRevision += 1
    scheduleFleetFlush()
  }

  function deleteFleetValues(keys) {
    const current = loadFleet()
    const next = { ...current }
    let removed = 0
    for (const key of keys) {
      if (!hasOwn(next, key)) continue
      delete next[key]
      fleetBytes.delete(key)
      removed += 1
    }
    if (removed === 0) return 0
    fleet = next
    fleetRevision += 1
    scheduleFleetFlush()
    return removed
  }

  function load() {
    if (record) return record
    const read = readFileWithRetry()
    if (read.error) {
      const error = read.error
      if (error && error.code === 'ENOENT') {
        record = emptyRecord()
        return record
      }
      /* An unreadable file is NOT an empty one. Returning empty here would
         hand the renderer a blank slate and let the next write flatten
         settings that are still on disk -- a fix that wipes settings is the
         same defect wearing a different hat. The in-memory record stays empty
         for this launch, but `damaged` is reported and nothing is drained. */
      record = emptyRecord()
      damaged = `the settings file could not be read (${error && error.code ? error.code : 'unknown error'})`
      return record
    }
    const parsed = parseRecord(read.text)
    record = parsed.record
    damaged = parsed.damaged
    migrateLegacyFleetKeys()
    return record
  }

  /* ONE-TIME MIGRATION of fleet document keys out of a legacy record.
   *
   * T380, measured on a candidate: this ran on the BOOT path -- load() is
   * called by the first rendererPrefs.snapshot() in shell/main.cjs, before the
   * window exists -- and it paid two synchronous temp-write-fsync-rename
   * sequences there, one of them the whole 5 MB corpus. That is the one-time
   * ~2 s cold-boot stall a person upgrading to 1.0.45 feels once, and it lands
   * squarely in front of first paint.
   *
   * So the MOVE is immediate and the WRITES are deferred. In memory the split
   * is complete before load() returns -- the fleet partition holds the
   * documents and the record no longer carries them, which is what snapshot(),
   * set() and persist() all have to see, because persist() refuses a record
   * carrying fleet keys and snapshot()'s merge lets an ordinary key win a
   * collision. On disk nothing has moved yet: the fleet file goes out on the
   * ordinary debounced asynchronous flush (off the loop, on the libuv pool),
   * and only once that has LANDED is the settings record rewritten without the
   * documents.
   *
   * The ordering rule the synchronous version bought is kept exactly: the
   * documents are never absent from every file at once. Before the flush the
   * legacy record still holds them; after it both files do; only then does the
   * record give them up. A process that dies anywhere in that window leaves the
   * legacy record intact and migrates again on the next launch, and a key
   * present in both files keeps the fleet file's copy, which is the newer
   * writer by construction. An ordinary settings write that arrives inside the
   * window closes the split synchronously first (see persist()), so it cannot
   * be the write that drops the last copy. */
  function migrateLegacyFleetKeys() {
    if (!record || damaged) return
    const legacy = Object.entries(record.values).filter(([key]) => isFleetDocumentKey(key))
    if (legacy.length === 0) return
    const current = loadFleet()
    if (fleetDamaged) return
    const merged = { ...Object.fromEntries(legacy), ...current }
    adoptFleet(merged)
    fleetRevision += 1
    const values = Object.fromEntries(Object.entries(record.values).filter(([key]) => !isFleetDocumentKey(key)))
    record = { ...record, values }
    legacyRecordCarriesFleetKeys = true
    scheduleFleetFlush()
  }

  /* The second half of the deferred split. Called only where the fleet file is
     known to be on disk, so the legacy copies leave the settings record after
     their replacement exists and never before. The record here is already the
     split one, so this write is the few kilobytes an ordinary record costs. */
  function completeLegacySplit() {
    if (!legacyRecordCarriesFleetKeys || sealedForErase || !record) return
    /* Cleared before the call so persist()'s own guard below does not see a
       pending split and flush the fleet file a second time. */
    legacyRecordCarriesFleetKeys = false
    const written = persist(record)
    if (!written.ok) legacyRecordCarriesFleetKeys = true
  }

  function attemptPersist(text) {
    return attemptPersistTo(file, text)
  }

  function attemptPersistTo(target, text) {
    const temporary = path.join(directory, `.${path.basename(target, '.json')}-${pid}-${randomUUID()}.tmp`)
    let descriptor
    try {
      fs.mkdirSync(directory, { recursive: true })
      descriptor = fs.openSync(temporary, 'wx')
      fs.writeFileSync(descriptor, text, 'utf8')
      /* fsync before rename: the proof for this fix force-kills the process
         between launches precisely so that a store which is only durable at a
         graceful exit cannot pass. */
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      fs.renameSync(temporary, target)
      return null
    } catch (error) {
      return error
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* closing a failed handle */ }
      }
      try { fs.unlinkSync(temporary) } catch { /* already renamed away */ }
    }
  }

  /* A NAME NOTHING IS ALREADY USING, RESERVED BEFORE THE MOVE.
     `wx` fails rather than clobbering, so a previous quarantine cannot be
     overwritten by the next one. The reservation is then replaced by the
     rename, which is why creating the empty file first is not a wasted step.

     THE BOUND IS COUNTED, NOT WALKED. While the names were an index sequence,
     trying them in order both found a free name and enforced the limit. A dated
     name has no order to walk, so the copies already on disk are counted
     directly -- and a directory that cannot be listed REFUSES rather than
     counting zero, because "I could not check the limit" must not read as
     "the limit is clear". */
  function reserveQuarantineName() {
    let existing
    try {
      existing = fs.readdirSync(directory).filter(isQuarantineFile).length
    } catch (error) {
      return { path: null, error, atLimit: false }
    }
    if (existing >= MAX_QUARANTINE_FILES) return { path: null, error: null, atLimit: true }

    /* Two damaged records inside one millisecond would collide on the dated
       name. `wx` catches that instead of one silently replacing the other, and
       the suffix disambiguates them without losing the date. */
    const stamp = now()
    for (let attempt = 0; attempt < MAX_QUARANTINE_FILES; attempt += 1) {
      const name = quarantineFileName(stamp)
      const candidate = path.join(directory, attempt === 0 ? name : name.replace(/\.json$/, `-${attempt}.json`))
      try {
        fs.closeSync(fs.openSync(candidate, 'wx'))
        return { path: candidate, error: null, atLimit: false }
      } catch (error) {
        if (error && error.code === 'EEXIST') continue
        return { path: null, error, atLimit: false }
      }
    }
    return { path: null, error: null, atLimit: true }
  }

  /* WHAT A WRITE MUST NOT DO TO A RECORD IT COULD NOT READ.
   *
   * The comment in load() states that an unreadable file is not an empty one
   * and that the next write must not flatten it. That was the stated
   * invariant; it was not implemented, and the two sibling stores in this same
   * repository DO implement it -- durable-memory-file.js refuses with
   * DURABLE_MEMORY_DAMAGED at two sites and agent-org-store.js refuses with
   * AGENT_ORG_STORE_DAMAGED. This store was copied from the first of those and
   * the check did not come with the comment.
   *
   * MEASURED, on this file before this function existed: a settings file
   * holding mc.theme/mc.text/mc.live.fleet plus a drained-origin history, made
   * unparseable, was reported as `damaged`, read as zero values, and the very
   * next set() returned {ok:true} having replaced the whole file with the one
   * key just written. Nothing was recoverable anywhere on disk. That is the
   * same silent factory reset the port-origin fix exists to end, one layer
   * down, and it survived that fix.
   *
   * IT SETS ASIDE RATHER THAN REFUSING OUTRIGHT, which is the one place this
   * deliberately differs from its two siblings, and the reason is a rescue path
   * that already exists here and does not exist there: a damaged record leaves
   * every origin undrained ON PURPOSE, so that the browser copy of a pre-fix
   * install can still be adopted on this very launch. A flat refusal would
   * close that rescue and would also leave a person permanently unable to
   * change a setting. Moving the unreadable bytes aside keeps both properties:
   * nothing is destroyed, and the application still works.
   *
   * A quarantine that cannot be taken REFUSES. That is the case where the file
   * is held by something else, and it is exactly when destroying it would be
   * worst -- the next launch, whose read now retries, is very likely to recover
   * the record intact. */
  function quarantineDamaged() {
    const reserved = reserveQuarantineName()
    if (!reserved.path) {
      const detail = reserved.atLimit
        ? `${MAX_QUARANTINE_FILES} damaged copies have already been set aside`
        : `a copy could not be set aside (${reserved.error && reserved.error.code ? reserved.error.code : 'unknown error'})`
      return failure('MC_PREFS_DAMAGED', `Refusing to overwrite settings that could not be read (${damaged}): ${detail}.`)
    }
    let lastError = null
    for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
      try {
        fs.renameSync(file, reserved.path)
        preservedAt = reserved.path
        return { ok: true, preservedAt: reserved.path }
      } catch (error) {
        lastError = error
        /* The record was damaged because the read failed, and the file has
           since gone. There is nothing left to preserve and nothing to
           destroy, so the write may proceed -- but the name reserved for it
           does not get to stay. An empty file left here would spend one of the
           eight slots and, now that the product POINTS A PERSON AT THESE
           FILES, would offer them a zero-byte "recovered copy" of settings
           that were never in it. */
        if (error && error.code === 'ENOENT') {
          try { fs.unlinkSync(reserved.path) } catch { /* nothing was promised by the reservation */ }
          return { ok: true, preservedAt: null }
        }
        if (!RETRYABLE_WRITE_ERRORS.has(error && error.code)) break
        if (attempt < PERSIST_ATTEMPTS - 1) pauseSync(PERSIST_BACKOFF_MS[attempt])
      }
    }
    try { fs.unlinkSync(reserved.path) } catch { /* the reservation is not worth a second failure */ }
    return failure('MC_PREFS_DAMAGED', `Refusing to overwrite settings that could not be read (${damaged}): a copy could not be set aside (${lastError && lastError.code ? lastError.code : 'unknown error'}).`)
  }

  /* Best effort, and deliberately so: a copy that cannot be taken must not stop
     a removal the person asked for. What it must never do is report success it
     did not have, so the taken paths are returned and clear() names them. */
  let treeCopyTaken = false
  function backupBeforeBulkRemoval() {
    const stamp = now()
    const taken = []
    for (const [base, name] of BACKUP_BASES) {
      const source = path.join(directory, name)
      let text
      try { text = fs.readFileSync(source, 'utf8') } catch { continue } // nothing on disk to copy
      const target = path.join(directory, backupFileName(base, stamp))
      if (attemptPersistTo(target, text) === null) taken.push(target)
    }
    pruneRollingBackups()
    return taken
  }

  /* Bounded, so a store that is cleared every launch cannot fill a disk with
     copies of itself. The dated names sort in date order, so the oldest are the
     first ones off the front. */
  function pruneRollingBackups() {
    let names
    try { names = fs.readdirSync(directory) } catch { return }
    for (const [base] of BACKUP_BASES) {
      const mine = names.filter(name => isBackupFile(name, base)).sort()
      for (const name of mine.slice(0, Math.max(0, mine.length - MAX_ROLLING_BACKUPS))) {
        try { fs.unlinkSync(path.join(directory, name)) } catch { /* a copy that will not go is left */ }
      }
    }
  }

  function persist(next) {
    if (sealedForErase) return erasedRefusal()
    const text = `${JSON.stringify(next)}\n`
    const textBytes = Buffer.byteLength(text, 'utf8')
    /* THE ORDINARY PARTITION IS A SUBSET, SO MOST WRITES NEED NOT MEASURE IT.
     *
     * `ordinary` is this same record with a few keys REMOVED, so its
     * serialisation can never be longer than the whole one. When the whole text
     * already fits inside MAX_RECORD_BYTES the ordinary check therefore cannot
     * fail, and computing it is work whose answer is known before it starts.
     * This skips it in exactly that case and in no other, so no record that used
     * to be refused is now accepted, and none that used to be accepted is now
     * refused. The comparison is on `text`, which is one byte longer than the
     * serialisation it measures, so the skip is if anything conservative.
     *
     * WHY IT IS WORTH A BRANCH. Measured at this commit on a synthetic record
     * shaped like the one LIMITATIONS-AND-HANDOFF-1.0.42.md section 4.28 found
     * (whole 1,290,653 bytes, ordinary 1,000,616): one whole serialisation cost
     * 9.15 ms and the ordinary rebuild-and-serialise another 8.71 ms -- 49% of
     * the serialising a write does. persist() runs on EVERY settings change,
     * the renderer blocks on it through ipcRenderer.sendSync
     * (shell/fleet-profile-preload.cjs) and ipcMain.on('mc-prefs:write')
     * (shell/main.cjs), and a full synchronous set() measured 25.79 ms. That is
     * the stall section 4.28 names, and half of the serialising in it is this.
     *
     * IT DOES NOT HELP THE RECORD 4.28 MEASURED, and pretending otherwise would
     * be the wrong lesson to leave here: that record's whole text is past 1 MiB,
     * so this branch does not fire for it. It fires for every install whose
     * settings still fit, which is the ordinary case, and it removes half the
     * per-write serialising there. The oversized record needs the corpus bounded
     * instead -- see the handoff. */
    /* T369: fleet document keys no longer pass through here (see the fleet
       partition above), so the ordinary record is measured against its own
       bound directly. A caller that hands this function a fleet key is a
       programming error, not a size question, and is refused as such rather
       than written into the wrong file. */
    if (Object.keys(next.values).some(isFleetDocumentKey)) {
      return failure('MC_PREFS_INVALID_ENTRY', 'fleet documents are stored in their own file and cannot be written into the settings record')
    }
    const ordinaryTooLarge = () => textBytes > MAX_RECORD_BYTES
    if (ordinaryTooLarge()) {
      return failure('MC_PREFS_TOO_LARGE', 'The settings file would exceed its size limit.')
    }

    /* T380: a legacy split whose fleet file has not reached disk yet leaves the
       SETTINGS FILE holding the only copy of those documents. This write is
       about to replace that file with one that does not carry them, so the
       fleet file is put down first -- synchronously, because by the time this
       returns the caller is owed durability, and there is no loop to wait on
       inside a sendSync. This is the only path that can still pay the old
       one-time cost, it needs a settings write inside the debounce window on
       the very first upgraded launch, and it is off the boot path either way.
       A fleet write that fails refuses this write rather than dropping data. */
    if (legacyRecordCarriesFleetKeys) {
      const flushed = flushFleetSync()
      if (!flushed.ok) return flushed
      legacyRecordCarriesFleetKeys = false
    }

    /* Every mutator funnels through here, so the damaged-record rule is
       enforced once rather than at four call sites that can drift apart. */
    let setAside = null
    if (damaged) {
      const preserved = quarantineDamaged()
      if (!preserved.ok) return preserved
      setAside = preserved.preservedAt
    }

    /* WINDOWS WILL REFUSE THIS RENAME AT RANDOM, and it is not a disk problem.
       Measured here rather than reasoned about: writing 512 settings in a row
       through this function failed twice with EPERM. Something else on the
       machine -- Defender and the search indexer are the usual pair -- holds a
       transient handle on a file that was created a millisecond ago, and the
       replace fails while everything about the request is valid.

       Left alone, that is a quiet version of the defect this whole file exists
       to end: the write fails, every call site in src/ already wraps storage in
       try/catch and ignores it, and the person's setting is simply not there
       next time. Retrying a handful of times with a short backoff is the
       standard mitigation for this class, and the total wait is bounded well
       under a frame so a settings click still feels instant.

       Persistent failures still fail. A full disk or a read-only profile must
       be reported, not retried into looking like success. */
    let lastError = null
    for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
      lastError = attemptPersist(text)
      if (lastError === null) {
        record = next
        damaged = null
        /* `preservedAt` deliberately survives `damaged` being cleared. The
           record is healthy again from this line on, but the person's OLD
           settings are still sitting in that dated file and they have not been
           told yet -- the write that clears the damage is the very call that
           carries the news back to the renderer. */
        return setAside ? { ok: true, preservedAt: setAside } : { ok: true }
      }
      if (!RETRYABLE_WRITE_ERRORS.has(lastError && lastError.code)) break
      if (attempt < PERSIST_ATTEMPTS - 1) pauseSync(PERSIST_BACKOFF_MS[attempt])
    }
    return failure('MC_PREFS_WRITE_FAILED', `Settings could not be saved (${lastError && lastError.code ? lastError.code : 'unknown error'}).`)
  }

  return {
    file,
    fleetFile,

    // Reset awaits Chromium after draining recovery. Callbacks in main still
    // hold this store, so an IPC fence alone cannot stop a late settings write.
    // Sealing is terminal for this instance and does not read or create a file.
    // A fleet flush still pending is dropped: the person asked for the data to
    // go, and a write that lands after the sweep is the survivor the erase
    // screen would then have to explain.
    sealForErase() {
      sealedForErase = true
      if (fleetTimer) { clearTimeout(fleetTimer); fleetTimer = null }
      return { ok: true, sealed: true }
    },

    /* The fleet documents that have changed in memory and not yet reached disk.
       Awaited by tests and by the quit path; a settings write never awaits it. */
    flushFleetDocuments() {
      if (fleetTimer) { clearTimeout(fleetTimer); fleetTimer = null }
      if (!fleet || fleetRevision === fleetFlushedRevision) return fleetFlushing || Promise.resolve({ ok: true, unchanged: true })
      return runFleetFlush().then(() => (fleetLastError
        ? failure('MC_PREFS_WRITE_FAILED', `Fleet documents could not be saved (${fleetLastError.code || 'unknown error'}).`)
        : { ok: true }))
    },

    /* The same drain, synchronously, for will-quit: the process is about to
       end and there is no loop left to wait on. */
    flushFleetDocumentsSync() {
      if (fleetTimer) { clearTimeout(fleetTimer); fleetTimer = null }
      if (!fleet || fleetRevision === fleetFlushedRevision) return { ok: true, unchanged: true }
      const flushed = flushFleetSync()
      /* A quit inside the migration window still finishes the split, so the
         next launch does not repeat it. The record write is a few kilobytes. */
      if (flushed.ok) completeLegacySplit()
      return flushed
    },

    /* Main-side repair/rollback only, after its native confirmation and verified
       dated copy. Commit and cache adoption share one synchronous turn so an
       IPC writer cannot enter between them. Existing expectedValue checks then
       reject stale renderer saves. Failed staging is retained, never cleaned. */
    commitFleetMaintenance({ expectedText, replacementText } = {}) {
      if (sealedForErase) return erasedRefusal()
      load()
      const current = loadFleet()
      const unavailable = () => failure('MC_FLEET_MAINTENANCE_UNAVAILABLE', 'Saved trees have pending or failed persistence. Nothing was repaired; let saving finish and review again.')
      if (damaged || fleetDamaged || fleetLastError || fleetFlushing
          || legacyRecordCarriesFleetKeys || fleetRevision !== fleetFlushedRevision) return unavailable()
      if (typeof expectedText !== 'string' || typeof replacementText !== 'string'
          || !expectedText || !replacementText
          || Buffer.byteLength(expectedText, 'utf8') > MAX_FLEET_RECORD_BYTES
          || Buffer.byteLength(replacementText, 'utf8') > MAX_FLEET_RECORD_BYTES) {
        return failure('MC_FLEET_MAINTENANCE_INVALID', 'Repair requires bounded, complete fleet records.')
      }
      const before = parseFleetRecord(expectedText)
      const after = parseFleetRecord(replacementText)
      const sameValues = (left, right) => Object.keys(left).length === Object.keys(right).length
        && Object.keys(left).every(key => hasOwn(right, key) && left[key] === right[key])
      if (before.damaged || after.damaged || !Object.keys(before.values).some(isFleetTreeKey)
          || !Object.keys(after.values).some(isFleetTreeKey)) {
        return failure('MC_FLEET_MAINTENANCE_INVALID', 'Repair requires readable, nonempty fleet records.')
      }
      if (!sameValues(current, before.values)) {
        return failure('MC_TREE_STORAGE_CHANGED', 'Saved trees changed after the repair preview. Nothing was repaired; review again.')
      }
      const disk = readFleetFile()
      if (disk.error || disk.text !== expectedText) {
        return failure('MC_TREE_STORAGE_CHANGED', 'The durable fleet file changed or could not be read. Nothing was repaired; review again.')
      }
      const stagedPath = path.join(directory, `.renderer-fleet-maintenance-${pid}-${randomUUID()}.tmp`)
      let descriptor
      try {
        descriptor = fs.openSync(stagedPath, 'wx', 0o600)
        fs.writeFileSync(descriptor, replacementText, 'utf8')
        fs.fsyncSync(descriptor)
        fs.closeSync(descriptor)
        descriptor = undefined
        if (fs.readFileSync(stagedPath, 'utf8') !== replacementText) {
          return failure('MC_FLEET_MAINTENANCE_VERIFY_FAILED', 'The staged repair did not verify. The original and staged files were retained.')
        }
        const fresh = readFleetFile()
        if (fresh.error || fresh.text !== expectedText) {
          return failure('MC_TREE_STORAGE_CHANGED', 'The durable fleet file changed during repair staging. Both files were retained.')
        }
        fs.renameSync(stagedPath, fleetFile)
        adoptFleet(after.values)
        fleetRevision += 1
        fleetFlushedRevision = fleetRevision
        return { ok: true }
      } catch (error) {
        return failure('MC_FLEET_MAINTENANCE_WRITE_FAILED', `The saved trees could not be repaired (${error?.code || 'write failed'}). Existing files were retained.`)
      } finally {
        if (descriptor !== undefined) { try { fs.closeSync(descriptor) } catch { /* retain the staged file */ } }
      }
    },

    snapshot() {
      const current = load()
      const documents = loadFleet()
      return {
        ok: true,
        /* ONE store as far as the renderer is concerned: both partitions, and
           an ordinary key wins a name collision it can never actually have. */
        values: { ...documents, ...current.values },
        drainedOrigins: [...current.drainedOrigins],
        damaged,
        fleetDamaged,
        fleetPending: fleetRevision !== fleetFlushedRevision,
        fleetWriteError: fleetLastError ? (fleetLastError.code || String(fleetLastError.message || fleetLastError)) : null,
        /* Null until a write has actually moved the file. Saying where a copy
           WILL go is a promise; this field is only ever a report of something
           that has happened. */
        preservedAt,
      }
    },

    isDrained(origin) {
      return load().drainedOrigins.includes(origin)
    },

    /* THE `unchanged` SHORTCUTS BELOW ARE GUARDED ON `damaged`, ALL THREE.
       "Nothing to do" is a claim about the file, and while the record is
       damaged this store does not know what the file says -- values reads
       empty, so `clear()` reported that it had emptied a record that was in
       fact full, and `remove()` reported that a key was already gone while it
       sat on disk. Reporting success from an absence we could not read is the
       same mistake as flattening it, minus the data loss. */
    set(key, value, options = {}) {
      if (sealedForErase) return erasedRefusal()
      const invalid = validateEntry(key, value)
      if (invalid) return failure('MC_PREFS_INVALID_ENTRY', invalid)
      const current = load()
      if (isFleetDocumentKey(key)) {
        /* THE FLEET PATH: bounded, in memory, answered now, written soon.
           The key count is shared with the ordinary partition so the store's
           total stays what it always was; the byte bound is the fleet
           envelope, measured incrementally rather than by serialising 5 MB
           to find out. */
        const documents = loadFleet()
        if (isFleetTreeKey(key)) {
          const previous = hasOwn(documents, key) ? documents[key] : null
          if (Object.hasOwn(options, 'expectedValue') && options.expectedValue !== previous) {
            return failure('MC_TREE_STORAGE_CHANGED', 'The saved trees changed after this page read them. No tree change was saved. Reopen the Trees page to read the current history.')
          }
          if (typeof validateTreeChange === 'function') {
            let result
            try { result = validateTreeChange({ computerId: key.slice('mc.fleet.trees.v1:'.length), previous, value }) }
            catch (error) { result = { ok: false, code: error.code, reason: error.message } }
            if (result?.ok !== true) return failure(result?.code || 'TREE_SLOT_ADMISSION_UNAVAILABLE', result?.reason || 'Tree slot admission could not be verified. No tree change was saved.')
          }
        }
        if (hasOwn(documents, key) && documents[key] === value) return { ok: true, unchanged: true }
        if (!hasOwn(documents, key) && Object.keys(current.values).length + Object.keys(documents).length >= MAX_KEYS) {
          return failure('MC_PREFS_TOO_MANY_KEYS', `The settings file already holds its limit of ${MAX_KEYS} keys.`)
        }
        const nextBytes = fleetTotalBytes() - (fleetBytes.get(key) || 0) + Buffer.byteLength(value, 'utf8')
        if (nextBytes > MAX_FLEET_RECORD_BYTES) {
          return failure('MC_PREFS_TOO_LARGE', 'The fleet document file would exceed its size limit.')
        }
        setFleetValue(key, value)
        return { ok: true }
      }
      if (!damaged && hasOwn(current.values, key) && current.values[key] === value) return { ok: true, unchanged: true }
      if (!hasOwn(current.values, key) && Object.keys(current.values).length + Object.keys(loadFleet()).length >= MAX_KEYS) {
        return failure('MC_PREFS_TOO_MANY_KEYS', `The settings file already holds its limit of ${MAX_KEYS} keys.`)
      }
      return persist({ ...current, values: { ...current.values, [key]: value } })
    },

    remove(key) {
      if (sealedForErase) return erasedRefusal()
      if (typeof key !== 'string') return failure('MC_PREFS_INVALID_ENTRY', 'a settings key must be a string')
      const current = load()
      if (isFleetDocumentKey(key)) {
        /* THE ONE-AT-A-TIME FORM OF THE SAME DESTRUCTION. clear() refuses while
           trees exist -- and then a caller that removes each tree first walks
           in through here, where nothing looks: this branch has no gate, no
           record write and, until now, no copy. Searched 2026-09-21: NO caller
           in src/ removes a tree key at all, so a product session never reaches
           this line and the copy costs a person nothing. It exists for the
           caller that should not be here.

           ONCE PER PROCESS, because a rolling prune keeps the NEWEST copies and
           a loop over six trees would push the only copy that still held all
           six off the front. The first one is the one worth keeping; a later
           launch gets a fresh one. */
        if (!damaged && !treeCopyTaken && isFleetTreeKey(key) && hasOwn(loadFleet(), key)) {
          treeCopyTaken = true
          backupBeforeBulkRemoval()
        }
        return deleteFleetValues([key]) === 0 ? { ok: true, unchanged: true } : { ok: true }
      }
      if (!damaged && !hasOwn(current.values, key)) return { ok: true, unchanged: true }
      const values = { ...current.values }
      delete values[key]
      return persist({ ...current, values })
    },

    // Remove all migrated keys with one durable write. The normal size and
    // damaged-record checks still apply; refusal leaves the prior record intact.
    // Fleet document keys in the list leave the fleet partition the same way.
    //
    // THE RECORD WRITE GOES FIRST. The fleet deletion used to run before it,
    // so a persist() that REFUSED -- a full disk, a read-only profile, a record
    // over its bound -- returned a failure to the caller having already dropped
    // the documents from memory, and the debounced flush then put the emptied
    // file on disk. The comment above promised the opposite. Measured against
    // this file before this change: a removeMany whose record write failed with
    // ENOSPC still destroyed six saved trees.
    removeMany(keys) {
      if (sealedForErase) return erasedRefusal()
      if (!Array.isArray(keys)) return failure('MC_PREFS_INVALID_ENTRY', 'a bulk removal needs a list of settings keys')
      const current = load()
      const documents = loadFleet()
      const fleetKeys = keys.filter(key => typeof key === 'string' && isFleetDocumentKey(key) && hasOwn(documents, key))
      const present = keys.filter(key => typeof key === 'string' && hasOwn(current.values, key))
      if (!damaged && present.length === 0 && fleetKeys.length === 0) return { ok: true, unchanged: true }
      if (!damaged && fleetKeys.some(isFleetTreeKey)) backupBeforeBulkRemoval()
      if (!damaged && present.length === 0) {
        return deleteFleetValues(fleetKeys) ? { ok: true } : { ok: true, unchanged: true }
      }
      const values = { ...current.values }
      for (const key of present) delete values[key]
      const written = persist({ ...current, values })
      if (!written.ok) return written
      deleteFleetValues(fleetKeys)
      return written
    },

    /* A CLEAR THAT WOULD DESTROY SAVED TREES IS REFUSED.
     *
     * Nothing in src/ calls localStorage.clear(). The product's own data
     * removal is shell/local-data-reset.cjs, which seals this store and sweeps
     * the directory, and the uninstaller is shell/uninstall-retention.cjs.
     * So every caller that reaches this through mc-prefs:clear is a script or a
     * console running in the main frame -- which, with `app.outside_control`
     * on, includes anything on the loopback debugging port. On 2026-09-20 one
     * of those removed six trees and 82 agent nodes in a single call and the
     * person could not start an agent afterwards.
     *
     * A caller that really means it says so with `intent`, and that caller is
     * in this process, not on the other side of an IPC channel: mc-prefs:clear
     * passes no options, so the page cannot ask for the destructive form. The
     * refusal names the count, and the trees stay exactly where they were. */
    clear(options = {}) {
      if (sealedForErase) return erasedRefusal()
      const current = load()
      const documents = loadFleet()
      const trees = Object.keys(documents).filter(isFleetTreeKey)
      if (trees.length > 0 && options.intent !== RESET_INTENT) {
        return failure('MC_PREFS_TREES_PRESENT',
          `Refusing to clear settings: ${trees.length} saved ${trees.length === 1 ? 'tree' : 'trees'} would be destroyed. Use ToolsEnabled's own data removal.`)
      }
      const emptying = Boolean(damaged) || Object.keys(current.values).length > 0 || Object.keys(documents).length > 0
      const preserved = !damaged && emptying ? backupBeforeBulkRemoval() : []
      if (!damaged && Object.keys(current.values).length === 0) {
        const removed = deleteFleetValues(Object.keys(documents))
        return removed ? { ok: true, backedUpTo: preserved } : { ok: true, unchanged: true }
      }
      const written = persist({ ...current, values: {} })
      if (!written.ok) return written
      deleteFleetValues(Object.keys(loadFleet()))
      return preserved.length ? { ...written, backedUpTo: preserved } : written
    },

    // One durable change removes every forest and its legacy history and
    // records the remaining cleanup. A failed write retains all node state.
    // The forests are fleet documents now, so their removal is flushed
    // SYNCHRONOUSLY here: a privacy cleanup is a promise about the disk, not
    // about memory, and it must not be the one write a debounce could lose.
    prepareNodePrivacyCleanup() {
      if (sealedForErase) return erasedRefusal()
      const current = load()
      if (damaged) return failure('MC_PREFS_DAMAGED', 'Saved nodes could not be read for privacy cleanup.')
      const documents = loadFleet()
      if (fleetDamaged) return failure('MC_PREFS_DAMAGED', 'Saved nodes could not be read for privacy cleanup.')
      const forests = Object.keys(documents).filter(key => /^mc\.fleet\.(trees|transcripts)\.v1:/.test(key))
      const values = { ...current.values }
      for (const key of Object.keys(values)) if (/^mc\.fleet\.(trees|transcripts)\.v1:/.test(key)) delete values[key]
      values['mc.node-privacy.pending.v1'] = '1'
      /* THE RECORD WRITE GOES FIRST, so that "A failed write retains all node
         state" above is true. It was not: the forests were deleted and flushed
         before this call, so a persist() that refused returned a failure with
         the documents already gone from the disk. The pending marker is
         durable before anything is destroyed, which is also the order the
         remaining cleanup wants -- a crash between the two leaves the marker
         set and the forests present, and the sweep runs again. */
      const written = persist({ ...current, values })
      if (!written.ok) return written
      if (forests.length) {
        deleteFleetValues(forests)
        const flushed = flushFleetSync()
        if (!flushed.ok) return flushed
      }
      return written
    },

    /* MIGRATION, ONCE PER ORIGIN.
     *
     * `entries` is whatever the browser partition for `origin` still holds.
     * A key already in the durable record WINS -- the durable record is the
     * newer decision by construction, because every write since the fix went
     * there. Only keys the durable record has never heard of are adopted.
     *
     * Marking the origin drained is the half that stops a resurrection bug:
     * without it, a key the person deleted after migrating would be re-adopted
     * from the untouched browser copy on the very next launch, and a setting
     * that comes back from the dead is a worse bug than one that resets.
     *
     * The browser copy is deliberately NOT deleted. If this fix is wrong, the
     * old data is still there to recover; and once the origin is marked, it is
     * provably never read again, so it cannot disagree with anything. */
    drain(origin, entries, options = {}) {
      if (sealedForErase) return erasedRefusal()
      const { strict = false } = options
      if (typeof origin !== 'string' || origin.length === 0) {
        return failure('MC_PREFS_INVALID_ORIGIN', 'a drain requires the origin it is draining')
      }
      const current = load()
      if (current.drainedOrigins.includes(origin)) {
        return { ok: true, migrated: 0, alreadyDrained: true }
      }
      const values = { ...current.values }
      const adoptedFleet = []
      let migrated = 0
      let skipped = 0
      if (strict && !Array.isArray(entries)) return failure('MC_PREFS_INVALID_ENTRY', 'a drain requires an entry list')
      const seen = new Map()
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!Array.isArray(entry) || entry.length !== 2) {
          if (strict) return failure('MC_PREFS_INVALID_ENTRY', 'a drain entry requires a key and value')
          skipped += 1; continue
        }
        const [key, value] = entry
        const invalid = validateEntry(key, value)
        if (invalid) {
          if (strict) return failure('MC_PREFS_INVALID_ENTRY', invalid)
          skipped += 1; continue
        }
        if (strict && seen.has(key) && seen.get(key) !== value) return failure('MC_PREFS_INVALID_ENTRY', 'conflicting copies of a drain entry')
        seen.set(key, value)
        if (hasOwn(values, key)) continue
        if (isFleetDocumentKey(key) && hasOwn(loadFleet(), key)) continue
        if (Object.keys(values).length + Object.keys(loadFleet()).length + adoptedFleet.length >= MAX_KEYS) {
          if (strict) return failure('MC_PREFS_TOO_MANY_KEYS', 'the settings file cannot hold every imported setting')
          skipped += 1; continue
        }
        /* A browser copy of a fleet document goes to the fleet partition, the
           same place a fresh write of it would go; it is adopted only once
           the ordinary record below has been written, so a refused drain
           adopts nothing. */
        if (isFleetDocumentKey(key)) { adoptedFleet.push([key, value]); migrated += 1; continue }
        setOwn(values, key, value)
        migrated += 1
      }
      const drainedOrigins = [...current.drainedOrigins, origin].slice(-MAX_DRAINED_ORIGINS)
      const written = persist({ storageVersion: STORAGE_VERSION, values, drainedOrigins })
      if (!written.ok) return written
      for (const [key, value] of adoptedFleet) setFleetValue(key, value)
      /* The drain is usually the FIRST write of a launch, so it is usually the
         call that sets a damaged record aside. Dropping `preservedAt` here
         would lose the news on the one path most likely to carry it. */
      return written.preservedAt
        ? { ok: true, migrated, skipped, preservedAt: written.preservedAt }
        : { ok: true, migrated, skipped }
    },
  }
}

module.exports = {
  BACKUP_INFIX,
  MAX_ROLLING_BACKUPS,
  RESET_INTENT,
  MAX_DRAINED_ORIGINS,
  MAX_KEYS,
  MAX_KEY_LENGTH,
  MAX_QUARANTINE_FILES,
  MAX_RECORD_BYTES,
  MAX_VALUE_LENGTH,
  QUARANTINE_PREFIX,
  RECORD_FILE,
  RENDERER_FLEET_FILE,
  FLEET_FLUSH_DEBOUNCE_MS,
  FLEET_FLUSH_MAX_WAIT_MS,
  MAX_FLEET_RECORD_BYTES,
  MAX_FLEET_VALUE_LENGTH,
  STORAGE_VERSION,
  createRendererPrefs,
  isBackupFile,
  isFleetTreeKey,
  isFleetDocumentKey,
  isQuarantineFile,
}
