'use strict'

// Recovery checkpoints have their own files so preference writes do not rewrite
// every agent's handoff or consume the ordinary settings record's size budget.

const fsPromises = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { MAX_KEYS } = require('./renderer-prefs.cjs')

/* The settings keys this replaces. Exported because the migration and its suite
   must agree with the renderer on one spelling of it. */
const RECOVERY_KEY_PREFIX = 'mc.agent-recovery.v1:'

/* The bound travels with the DATA, not with whichever store it happens to live
   in: src/recovery-handoff-store.js refused a handoff over 48,000 characters
   while these lived in settings, and moving them to disk is not a reason to stop
   bounding them. */
const MAX_HANDOFF_CHARS = 48_000

// Match renderer-prefs' previous bound on the entire serialized value (UTF-16
// code units). UTF-8 may use up to three bytes per code unit; do not reject a
// previously valid non-ASCII handoff by confusing characters with bytes.
const MAX_RECORD_CHARS = 64 * 1024
const MAX_RECORD_BYTES = MAX_RECORD_CHARS * 3
// Two identities of at most 512 code units, worst-case JSON escaping, plus
// fixed envelope fields. Read at most this budget and one overflow byte.
const MAX_FILE_BYTES = MAX_RECORD_BYTES + 2 * 512 * 6 + 256

const refusal = code => ({ ok: false, error: { code } })
const validRecord = record => record && !Array.isArray(record) && record.v === 1
  && typeof record.handoff === 'string' && Boolean(record.handoff.trim())

const serialisedTooLarge = text => text.length > MAX_RECORD_CHARS || Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES

function recordProblem(record, serialised = JSON.stringify(record)) {
  if (typeof serialised !== 'string' || !validRecord(record)) return 'RECOVERY_RECORD_INVALID'
  if (record.handoff.length > MAX_HANDOFF_CHARS || serialisedTooLarge(serialised)) return 'RECOVERY_RECORD_TOO_LARGE'
  return null
}

const digest = value => createHash('sha256').update(value).digest('hex')

function identity(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\0')) {
    throw new Error('Invalid recovery identity.')
  }
  return value
}

function captureRequest(request) {
  const computerId = identity(request?.computerId)
  const nodeId = identity(request?.nodeId)
  const serialised = JSON.stringify(request?.record)
  const problem = recordProblem(request?.record, serialised)
  if (problem) throw Object.assign(new Error(problem), { code: problem })
  return { computerId, nodeId, record: JSON.parse(serialised) }
}

function migrationConflict() {
  return { ok: false, error: { code: 'RECOVERY_MIGRATION_CONFLICT',
    message: 'Saved recovery checkpoints conflict and their order is unknown. Both copies were preserved.' } }
}

function createNodeRecoveryStore({ directory, io = fsPromises } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('createNodeRecoveryStore requires a directory')
  const root = path.resolve(directory, 'node-recovery')
  const fileFor = ({ computerId, nodeId }) =>
    path.join(root, `${digest(identity(computerId))}-${digest(identity(nodeId))}.json`)

  // Every operation returns its complete write chain. The lifecycle coordinator
  // awaits it before admitting another operation or completing stop/reset.
  // This also orders standalone migration callers against redirected writes.
  const pending = new Map()
  async function ordered(request, action) {
    const file = fileFor(request)
    const previous = pending.get(file) || Promise.resolve()
    const current = previous.then(action, action)
    pending.set(file, current)
    try { return await current } finally {
      if (pending.get(file) === current) pending.delete(file)
    }
  }

  function save(request) {
    let captured
    try { captured = captureRequest(request) }
    catch (error) { return Promise.resolve(refusal(error?.code || 'RECOVERY_RECORD_INVALID')) }
    return ordered(captured, () => writeRecord(captured, false))
  }

  function importLegacy(request, { replaceImported = true } = {}) {
    let captured
    try { captured = captureRequest(request) }
    catch (error) { return Promise.resolve(refusal(error?.code || 'RECOVERY_RECORD_INVALID')) }
    return ordered(captured, async () => {
      const existing = await get(captured)
      if (!existing.ok) return existing
      // An acknowledged redirected checkpoint must survive retained old source
      // entries, including a restart after source-removal refusal.
      if (existing.record && existing.legacy === false) return { ok: true }
      if (existing.record && !(existing.legacy === true && replaceImported)) {
        if (JSON.stringify(existing.record) === JSON.stringify(captured.record)) return { ok: true }
        return migrationConflict()
      }
      return writeRecord(captured, true)
    })
  }

  /* Write-temp, fsync, rename — the same durability sequence renderer-prefs.cjs
     uses, for the same reason: a record that is only durable at a graceful exit
     is not durable, and this record exists to survive exactly the ungraceful
     case. */
  async function atomic(file, text) {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await io.writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
      const handle = await io.open(temporary, 'r+')
      try { await handle.sync() } finally { await handle.close() }
      await io.rename(temporary, file)
    } catch (error) {
      await io.unlink(temporary).catch(() => {})
      throw error
    }
  }

  async function writeRecord({ computerId, nodeId, record } = {}, legacy = false) {
    let file, text
    try {
      file = fileFor({ computerId, nodeId })
      // Serialize once, before any await. The checked snapshot is what is saved,
      // even if the caller mutates its object while the filesystem is busy.
      const serialised = JSON.stringify(record)
      if (typeof serialised !== 'string') return refusal('RECOVERY_RECORD_INVALID')
      if (serialisedTooLarge(serialised)) return refusal('RECOVERY_RECORD_TOO_LARGE')
      const snapshot = JSON.parse(serialised)
      const problem = recordProblem(snapshot, serialised)
      if (problem) return refusal(problem)
      text = JSON.stringify({ computerId, nodeId, savedAt: Date.now(), record: snapshot, legacy })
    } catch { return refusal('RECOVERY_RECORD_INVALID') }
    try {
      await io.mkdir(root, { recursive: true })
      await atomic(file, text)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: { code: 'RECOVERY_WRITE_FAILED', message: error && error.message } }
    }
  }

  async function readEnvelope(file) {
    const handle = await io.open(file, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw Object.assign(new Error('Recovery record is not a file.'), { code: 'RECOVERY_RECORD_UNREADABLE' })
      const tooLarge = () => Object.assign(new Error('Recovery file exceeds its size limit.'), { code: 'RECOVERY_RECORD_TOO_LARGE' })
      if (stat.size > MAX_FILE_BYTES) throw tooLarge()
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      // The sentinel also catches a file growing after stat. A partial read is
      // not EOF; continue until EOF or the fixed budget has been consumed.
      if (offset > MAX_FILE_BYTES) throw tooLarge()
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)))
    } finally { await handle.close() }
  }

  async function get({ computerId, nodeId } = {}) {
    try {
      const parsed = await readEnvelope(fileFor({ computerId, nodeId }))
      /* ABSENT AND UNREADABLE ARE DIFFERENT ANSWERS. A file that will not parse
         is reported as unreadable rather than as "no record", so a caller cannot
         mistake damage for a node that never had one. */
      if (!parsed || parsed.computerId !== computerId || parsed.nodeId !== nodeId || !validRecord(parsed.record)) {
        return { ok: false, error: { code: 'RECOVERY_RECORD_UNREADABLE' } }
      }
      const problem = recordProblem(parsed.record)
      if (problem) return refusal(problem === 'RECOVERY_RECORD_INVALID' ? 'RECOVERY_RECORD_UNREADABLE' : problem)
      return { ok: true, record: parsed.record,
        ...(typeof parsed.legacy === 'boolean' ? { legacy: parsed.legacy } : {}) }
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, record: null }
      if (['RECOVERY_RECORD_TOO_LARGE', 'RECOVERY_RECORD_UNREADABLE'].includes(error?.code)) return refusal(error.code)
      if (error instanceof SyntaxError || error instanceof TypeError) return refusal('RECOVERY_RECORD_UNREADABLE')
      return { ok: false, error: { code: 'RECOVERY_READ_FAILED', message: error && error.message } }
    }
  }

  // Internal store operation; migration preserves orphan records as well.
  async function remove({ computerId, nodeId } = {}) {
    try {
      await io.unlink(fileFor({ computerId, nodeId }))
      return { ok: true }
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true }
      return { ok: false, error: { code: 'RECOVERY_REMOVE_FAILED', message: error && error.message } }
    }
  }

  async function list({ computerId } = {}) {
    let names = []
    try { names = await io.readdir(root) } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, nodeIds: [] }
      return { ok: false, error: { code: 'RECOVERY_LIST_FAILED', message: error && error.message } }
    }
    const nodeIds = []
    for (const name of names) {
      if (!/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name)) continue
      try {
        const parsed = await readEnvelope(path.join(root, name))
        if (parsed && parsed.computerId === computerId && typeof parsed.nodeId === 'string'
          && !recordProblem(parsed.record)) nodeIds.push(parsed.nodeId)
      } catch { /* one unreadable record does not empty the list */ }
    }
    return { ok: true, nodeIds }
  }

  return { save, get, remove, list, importLegacy, directory: root }
}

/* WHICH NODE A SETTINGS KEY BELONGS TO. The renderer minted these as
   `mc.agent-recovery.v1:<encoded computerId>:<encoded nodeId>`, so both halves
   are percent-encoded and neither can contain a raw colon. */
function parseRecoveryKey(key) {
  if (typeof key !== 'string' || !key.startsWith(RECOVERY_KEY_PREFIX)) return null
  const rest = key.slice(RECOVERY_KEY_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator <= 0 || separator === rest.length - 1) return null
  try {
    return {
      computerId: decodeURIComponent(rest.slice(0, separator)),
      nodeId: decodeURIComponent(rest.slice(separator + 1)),
    }
  } catch { return null }
}

/**
 * Move every recovery record out of the settings record, once.
 *
 * THE ORDER IS THE SAFETY PROPERTY, and it is asserted by the suite: write the
 * file, confirm the write succeeded, and only then drop the settings key. A
 * record that could not be written stays exactly where it was. A record whose
 * bytes will not parse is KEPT — unreadable data is still the person's data, and
 * the settings store's own quarantine path exists on the same principle.
 *
 * The keys are dropped in one call: every settings write re-serializes and
 * fsyncs the whole record, so bulk removal avoids repeating that work per key.
 *
 * Idempotent by construction — after a successful run there are no matching keys
 * left to find, so a second run does nothing.
 */
async function migrateRecoveryRecords({ prefs, store, isStopped = () => false } = {}) {
  const values = (prefs.snapshot() || {}).values || {}
  /* key -> the exact bytes migrated, so the removal can prove it is deleting the
     same thing it copied. See the compare-and-delete note below. */
  const migrated = new Map()
  const refusals = []
  let kept = 0

  for (const [key, raw] of Object.entries(values)) {
    if (isStopped()) return { moved: 0, kept, error: { code: 'RECOVERY_STORAGE_STOPPED' } }
    const owner = parseRecoveryKey(key)
    if (!owner) continue

    let record = null
    try { record = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { record = null }
    if (!record || typeof record !== 'object') {
      kept += 1
      refusals.push({ key, code: 'RECOVERY_RECORD_INVALID' })
      continue
    }

    const request = { computerId: owner.computerId, nodeId: owner.nodeId, record }
    const written = await (store.importLegacy ? store.importLegacy(request) : store.save(request))
    if (written && written.ok === true) migrated.set(key, raw)
    else {
      kept += 1
      refusals.push({ key, code: written?.error?.code || 'RECOVERY_MIGRATION_WRITE_FAILED' })
    }
  }

  // A legacy writer can change a checkpoint while its copy is in flight. Only
  // delete the exact source copied; retained source wins on subsequent reads.
  const removable = []
  let deferred = 0
  if (migrated.size > 0) {
    if (isStopped()) return { moved: 0, kept, error: { code: 'RECOVERY_STORAGE_STOPPED' } }
    const current = (prefs.snapshot() || {}).values || {}
    for (const [key, raw] of migrated) {
      if (current[key] === raw) removable.push(key)
      else deferred += 1
    }
    if (removable.length > 0) {
      let removed
      try { removed = prefs.removeMany(removable) } catch { removed = null }
      if (removed?.ok !== true) return { moved: 0, kept: kept + removable.length, deferred, refusals,
        error: { code: 'RECOVERY_MIGRATION_REMOVE_FAILED', cause: removed?.error?.code,
          message: 'Recovery files were preserved, but their settings entries could not be removed. The source entries were retained.' } }
    }
  }

  return { moved: removable.length, kept, deferred, ...(refusals.length ? { refusals } : {}) }
}

// Keep migration and renderer operations in one queue. Failed migrations retain
// their source; reads continue to use that source and a replacement is refused
// until it can be migrated, so a stale source cannot overwrite a newer save on
// the next launch. This also covers records adopted by the legacy origin drain.
function createRecoveryPersistence({ prefs, store } = {}) {
  let tail = Promise.resolve()
  let stopped = false
  // A failed browser import is not an absent checkpoint. Its original bytes
  // remain in Chromium; refuse recovery until that origin can be retried.
  const incompleteOrigins = new Set()
  const enqueue = action => {
    const result = tail.then(() => stopped ? refusal('RECOVERY_STORAGE_STOPPED') : action())
    tail = result.catch(() => {})
    return result
  }
  const legacy = ({ computerId, nodeId }) => {
    identity(computerId)
    identity(nodeId)
    const key = `${RECOVERY_KEY_PREFIX}${encodeURIComponent(computerId)}:${encodeURIComponent(nodeId)}`
    const snapshot = prefs.snapshot()
    if (snapshot.ok === false || snapshot.damaged) throw new Error('Saved recovery settings could not be read.')
    return snapshot.values?.[key]
  }

  async function drainLegacyOrigin(origin, entries) {
    if (typeof origin !== 'string' || !origin) return refusal('MC_PREFS_INVALID_ORIGIN')
    if (prefs.isDrained(origin)) return { ok: true, alreadyDrained: true, migrated: 0 }
    incompleteOrigins.add(origin)
    // This is a transport count bound, not the ordinary settings byte budget.
    // Every recovery value still carries its own unchanged record size limits.
    if (!Array.isArray(entries) || entries.length > MAX_KEYS) return refusal('RECOVERY_DRAIN_INVALID_BATCH')
    const ordinary = [], checkpoints = new Map()
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
        return refusal('RECOVERY_DRAIN_INVALID_BATCH')
      }
      const [key, raw] = entry
      if (!key.startsWith(RECOVERY_KEY_PREFIX)) { ordinary.push([key, raw]); continue }
      const owner = parseRecoveryKey(key)
      let record
      try {
        if (!owner) return refusal('RECOVERY_RECORD_INVALID')
        identity(owner.computerId); identity(owner.nodeId)
        if (serialisedTooLarge(raw)) return refusal('RECOVERY_RECORD_TOO_LARGE')
        record = JSON.parse(raw)
        const problem = recordProblem(record, raw)
        if (problem) return refusal(problem)
      } catch { return refusal('RECOVERY_RECORD_INVALID') }
      const canonical = JSON.stringify([owner.computerId, owner.nodeId])
      if (checkpoints.has(canonical) && checkpoints.get(canonical).raw !== raw) return refusal('RECOVERY_DRAIN_CONFLICT')
      checkpoints.set(canonical, { ...owner, record, raw })
    }

    let imported = 0
    for (const checkpoint of checkpoints.values()) {
      if (stopped) return refusal('RECOVERY_STORAGE_STOPPED')
      let migratedPrefs = false
      // Retained prefs keep their existing precedence. Migration compare-deletes
      // only a source it actually copied; failure must not admit a replacement.
      if (legacy(checkpoint) !== undefined) {
        await migrateRecoveryRecords({ prefs, store, isStopped: () => stopped })
        if (stopped) return refusal('RECOVERY_STORAGE_STOPPED')
        if (legacy(checkpoint) !== undefined) return refusal('RECOVERY_MIGRATION_INCOMPLETE')
        migratedPrefs = true
      }
      const existing = await store.get(checkpoint)
      if (stopped) return refusal('RECOVERY_STORAGE_STOPPED')
      if (!existing?.ok) return existing || refusal('RECOVERY_READ_FAILED')
      // Only a marked redirected write has known precedence over browser
      // copies. Differing unmarked/imported copies retain both sources.
      if (existing.record !== null) {
        if (migratedPrefs || existing.legacy === false || JSON.stringify(existing.record) === JSON.stringify(checkpoint.record)) continue
        return migrationConflict()
      }
      const written = await (store.importLegacy
        ? store.importLegacy(checkpoint, { replaceImported: false }) : store.save(checkpoint))
      if (stopped) return refusal('RECOVERY_STORAGE_STOPPED')
      if (!written?.ok) return written || refusal('RECOVERY_WRITE_FAILED')
      imported += 1
    }
    if (stopped) return refusal('RECOVERY_STORAGE_STOPPED')
    // No recovery payload ever enters the ordinary record. Commit its entries
    // and origin marker only after every checkpoint has a durable destination.
    // A refusal leaves partial files and the untouched browser source for retry.
    const drained = prefs.drain(origin, ordinary, { strict: true })
    if (!drained?.ok) return drained || refusal('MC_PREFS_WRITE_FAILED')
    incompleteOrigins.delete(origin)
    return { ...drained, recoveryImported: imported, recoveryRetained: checkpoints.size - imported }
  }
  return {
    // Stop admitting work synchronously; let already active filesystem IO finish
    // before reset sweeps the directory or quit terminates the process.
    stop() { stopped = true; return tail },
    initialize: () => enqueue(() => migrateRecoveryRecords({ prefs, store, isStopped: () => stopped })),
    drainLegacyOrigin: (origin, entries) => {
      // Snapshot before admission/await: only the checked input may be copied.
      const snapshot = Array.isArray(entries) && entries.length <= MAX_KEYS
        ? entries.map(entry => Array.isArray(entry) ? [...entry] : entry) : null
      return enqueue(async () => {
        try { return await drainLegacyOrigin(origin, snapshot) }
        catch { return refusal('RECOVERY_MIGRATION_INCOMPLETE') }
      })
    },
    save: request => {
      let captured
      try { captured = captureRequest(request) }
      catch (error) { return Promise.resolve(refusal(error?.code || 'RECOVERY_RECORD_INVALID')) }
      return enqueue(async () => {
        if (incompleteOrigins.size) return refusal('RECOVERY_MIGRATION_INCOMPLETE')
        if (legacy(captured) !== undefined) {
          await migrateRecoveryRecords({ prefs, store, isStopped: () => stopped })
          if (stopped) return refusal('RECOVERY_STORAGE_STOPPED')
          if (legacy(captured) !== undefined) return refusal('RECOVERY_MIGRATION_INCOMPLETE')
        }
        return store.save(captured)
      })
    },
    get: request => enqueue(async () => {
      if (incompleteOrigins.size) return refusal('RECOVERY_MIGRATION_INCOMPLETE')
      const raw = legacy(request)
      if (raw !== undefined) {
        try {
          const record = typeof raw === 'string' ? JSON.parse(raw) : raw
          const problem = recordProblem(record, typeof raw === 'string' ? raw : JSON.stringify(raw))
          if (problem) return refusal(problem === 'RECOVERY_RECORD_INVALID' ? 'RECOVERY_RECORD_UNREADABLE' : problem)
          const existing = await store.get(request)
          if (!existing?.ok) return existing || refusal('RECOVERY_READ_FAILED')
          if (existing.record && existing.legacy === false) return { ok: true, record: existing.record }
          if (existing.record && existing.legacy !== true && JSON.stringify(existing.record) !== JSON.stringify(record)) {
            return migrationConflict()
          }
          return { ok: true, record }
        } catch { return refusal('RECOVERY_RECORD_UNREADABLE') }
      }
      const answer = await store.get(request)
      return answer?.ok === true ? { ok: true, record: answer.record } : answer
    }),
    remove: request => enqueue(async () => {
      if (incompleteOrigins.size) return refusal('RECOVERY_MIGRATION_INCOMPLETE')
      if (legacy(request) !== undefined) {
        await migrateRecoveryRecords({ prefs, store, isStopped: () => stopped })
        if (stopped) return refusal('RECOVERY_STORAGE_STOPPED')
        if (legacy(request) !== undefined) return refusal('RECOVERY_MIGRATION_INCOMPLETE')
      }
      return store.remove(request)
    }),
    list: request => enqueue(async () => {
      if (incompleteOrigins.size) return refusal('RECOVERY_MIGRATION_INCOMPLETE')
      const migrated = await migrateRecoveryRecords({ prefs, store, isStopped: () => stopped })
      if (stopped) return refusal('RECOVERY_STORAGE_STOPPED')
      if (migrated.error || migrated.kept || migrated.deferred) return refusal('RECOVERY_MIGRATION_INCOMPLETE')
      return store.list(request)
    }),
  }
}

module.exports = {
  MAX_HANDOFF_CHARS,
  MAX_RECORD_CHARS,
  MAX_RECORD_BYTES,
  MAX_FILE_BYTES,
  createRecoveryPersistence,
  RECOVERY_KEY_PREFIX,
  createNodeRecoveryStore,
  migrateRecoveryRecords,
  parseRecoveryKey,
}
