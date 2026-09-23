'use strict'
// Native, person-only adapter for the saved-data maintenance routes:
//   agent:continuation-prune-preview / -confirm      removes orphaned continuation rows (engine src/lib/continuation-prune.js)
//   agent:node-status-repair-preview / -confirm      restores node status from a chosen snapshot (shell/saved-node-status-repair.cjs)
//   agent:node-status-rollback-preview / -confirm    puts a dated repair backup's node status back (the same service)
//
// The dangerous halves stay where they are. The prune service mints its own tokens, copies and verifies a dated SQLite
// backup and deletes by exact row predicate; the repair service copies the whole store, stages the replacement and
// hands the commit to rendererPrefs.commitFleetMaintenance. Neither is changed here. This module answers the one
// question both must have answered before they start, again once the engine has made its dated copy, and again on
// both sides of the native dialog:
//
//   does what the renderer-prefs cache holds equal what is durably on disk, byte for byte; is nothing waiting to be
//   written; and is it still the exact store the person reviewed?
//
// The answer is a sha256 of the COMPLETE durable fleet wrapper (renderer-fleet-documents.json, every key, not only the
// tree documents). The prune snapshot's `revision` is that hash, which the engine folds into its scope hash, and the
// adapter keeps its own record of the hash each preview and token was issued for, so a change refuses even if the
// engine were to stop looking. The renderer never supplies a path: the store is `fleetStorePath`, a repair snapshot
// comes only from `chooseSnapshotFile` and a rollback backup only from `chooseRollbackFile`, native pickers in main.
//
// STATUS ONLY. A repair and a rollback may change one thing: a node's `status` and `statusNote`, and only between
// `finished` and `turn-failed` (the guarded service's own scope; a node left untouched may hold any status). The
// bytes a repair is about to commit, and the whole of a rollback backup, are compared with the store as it is now,
// and refused unless nothing else differs: no other field, no tree, no added or removed node or document, no
// createdAt, sessionId or lastTurnId, and no changed node outside finished/turn-failed on either side of the change.
// A backup that carries older words than the store is therefore not a rollback this module will start.
//
// WHAT IS REPORTED. A repair or rollback is reported ok only as `{ ok: true, confirmed: true, changedKeys, ... }`, and
// only when the native dialog approved, the service reported postWriteVerified, and this module read the durable file
// back afterwards (settled, agreeing with the cache, the very bytes it handed the commit seam and the service reports
// having written) and found exactly the fleet-tree keys the plan named changed. Anything short of that is
// `{ ok: false }`. `changedKeys` is what the page refreshes.
//
// PERSON. Every route refuses, before it touches anything, unless the principal is the app window at the keyboard:
// `kind === 'window'`, `mayWrite === true`, and an `owner` window that is not destroyed. That is asked again after the
// picker, on both sides of each native dialog and before a repair or rollback stages or commits. A refusal is returned.
//
// Wiring (main.cjs owns it): createSavedDataMaintenanceAdapter({ resolveCapabilityRoot, requireModule, dialog,
// browserWindowForPrincipal, rendererPrefs, fleetStorePath: rendererPrefs.fleetFile, chooseSnapshotFile, chooseRollbackFile,
// stateFile: <the continuation database the engine host was started with, if not this process's default> }).
// After a repair or rollback that reports ok, the page still holds the launch cache of the old trees; refreshing
// `changedKeys` there is the caller's job.
const crypto = require('node:crypto')
const nodeFs = require('node:fs')
const path = require('node:path')
const { MAX_FLEET_RECORD_BYTES, RENDERER_FLEET_FILE, STORAGE_VERSION, isFleetDocumentKey, isFleetTreeKey } = require('./renderer-prefs.cjs')

const PAYLOAD_CONTINUATION_PRUNE_MODULE = 'src/lib/continuation-prune.js'
const PAYLOAD_STATE_STORE_MODULE = 'src/lib/state-store.js'
const REPAIR_SERVICE_MODULE = './saved-node-status-repair.cjs'
// The mark the repair service puts in every dated backup it writes, and requires of a rollback source.
const DATED_BACKUP_MARK = '.repair-backup-'
// What one saved computer's record may hold: src/fleet-trees.js FLEET_TREE_LIMITS and NODE_STATUSES.
const MAX_TREES_PER_DOCUMENT = 64
const MAX_NODES_PER_DOCUMENT = 4096
const NODE_STATUSES = new Set(['draft', 'starting', 'running', 'finished', 'failed', 'turn-failed', 'interrupted', 'cancelled'])
// The only node fields a status repair or rollback may change, and the ones that say which conversation a node is.
const STATUS_FIELDS = ['status', 'statusNote']
const IDENTITY_FIELDS = ['createdAt', 'sessionId', 'lastTurnId']
// The guarded service's own scope (shell/saved-node-status-repair.cjs) is a turn that failed to save its status
// moving to finished, in either direction; the live tree refresh this maintains does not know any other transition.
// A node whose status and statusNote are both unchanged is untouched by this bound, whatever value it holds.
const REPAIRABLE_STATUSES = new Set(['finished', 'turn-failed'])
const MAX_JSON_DEPTH = 64
// A review is good for as long as the prune token it leads to (continuation-prune.js: ten minutes).
const REVIEW_LIFETIME_MS = 10 * 60 * 1000
const MAX_REVIEWS = 8
const SHA256_HEX = /^[a-f0-9]{64}$/

const CODES = Object.freeze({
  UNCONFIGURED: 'MC_SAVED_DATA_FLEET_READER_UNCONFIGURED',
  SNAPSHOT_UNREADABLE: 'MC_SAVED_DATA_FLEET_SNAPSHOT_UNREADABLE',
  FLEET_DAMAGED: 'MC_SAVED_DATA_FLEET_FILE_DAMAGED',
  PREFS_DAMAGED: 'MC_SAVED_DATA_PREFS_DAMAGED',
  WRITE_ERROR: 'MC_SAVED_DATA_FLEET_WRITE_ERROR',
  PENDING: 'MC_SAVED_DATA_FLEET_PENDING',
  FILE_UNREADABLE: 'MC_SAVED_DATA_FLEET_FILE_UNREADABLE',
  TOO_LARGE: 'MC_SAVED_DATA_FLEET_TOO_LARGE',
  DISAGREES: 'MC_SAVED_DATA_FLEET_CACHE_DISAGREES',
  EMPTY: 'MC_SAVED_DATA_FLEET_EMPTY',
  CHANGED: 'MC_SAVED_DATA_FLEET_CHANGED',
  PERSON_REQUIRED: 'MC_SAVED_DATA_PERSON_REQUIRED',
  BACKUP_UNREADABLE: 'MC_SAVED_DATA_BACKUP_UNREADABLE',
  BACKUP_NOT_DATED: 'MC_SAVED_DATA_BACKUP_NOT_A_DATED_BACKUP',
  BACKUP_NOT_CHOSEN: 'MC_SAVED_DATA_BACKUP_NOT_CHOSEN',
  SNAPSHOT_NOT_CHOSEN: 'MC_SAVED_DATA_SNAPSHOT_NOT_CHOSEN',
  ROLLBACK_NOT_STATUS_ONLY: 'MC_SAVED_DATA_ROLLBACK_NOT_STATUS_ONLY',
  ROLLBACK_IDENTITY_DIFFERS: 'MC_SAVED_DATA_ROLLBACK_IDENTITY_DIFFERS',
  ROLLBACK_NOTHING_TO_RESTORE: 'MC_SAVED_DATA_ROLLBACK_NOTHING_TO_RESTORE',
  REPLACEMENT_NOT_STATUS_ONLY: 'MC_SAVED_DATA_REPLACEMENT_NOT_STATUS_ONLY',
  UNVERIFIED: 'MC_SAVED_DATA_UNVERIFIED',
})
const REASONS = Object.freeze({
  [CODES.UNCONFIGURED]: 'The saved trees could not be checked for maintenance. Nothing was changed.',
  [CODES.SNAPSHOT_UNREADABLE]: 'The saved trees could not be read from the app. Nothing was changed.',
  [CODES.FLEET_DAMAGED]: 'The saved trees file is damaged. Nothing was changed.',
  [CODES.PREFS_DAMAGED]: 'The saved settings file is damaged. Nothing was changed.',
  [CODES.WRITE_ERROR]: 'Saving the trees failed the last time it was tried. Nothing was changed; fix saving first.',
  [CODES.PENDING]: 'Saved trees have changes that are still being written. Nothing was changed; let saving finish and review again.',
  [CODES.FILE_UNREADABLE]: 'The saved trees file could not be read. Nothing was changed.',
  [CODES.TOO_LARGE]: 'The saved trees file is larger than maintenance will read. Nothing was changed.',
  [CODES.DISAGREES]: 'What the app holds for saved trees is not what is saved on disk. Nothing was changed; restart ToolsEnabled and review again.',
  [CODES.EMPTY]: 'There are no saved trees to work on. Nothing was changed.',
  [CODES.CHANGED]: 'Saved trees changed after the review. Nothing was changed; review again.',
  [CODES.PERSON_REQUIRED]: 'Saved-data maintenance requires the person using this app window. Nothing was changed.',
  [CODES.BACKUP_UNREADABLE]: 'The chosen backup is not a saved-trees file this version can read. Nothing was changed.',
  [CODES.BACKUP_NOT_DATED]: 'Only a dated backup written by a saved-tree repair can be put back. Nothing was changed.',
  [CODES.BACKUP_NOT_CHOSEN]: 'No saved-tree backup was chosen. Nothing was changed.',
  [CODES.SNAPSHOT_NOT_CHOSEN]: 'No saved snapshot was chosen. Nothing was changed.',
  [CODES.ROLLBACK_NOT_STATUS_ONLY]: 'That backup differs from the saved trees in more than agent status, so putting it back would undo newer changes. Nothing was changed.',
  [CODES.ROLLBACK_IDENTITY_DIFFERS]: 'That backup belongs to a different conversation, session or turn than the saved trees now hold. Nothing was changed.',
  [CODES.ROLLBACK_NOTHING_TO_RESTORE]: 'That backup already matches the saved trees; there is no status to put back. Nothing was changed.',
  [CODES.REPLACEMENT_NOT_STATUS_ONLY]: 'The saved trees about to be written differ from the current ones in more than agent status. Nothing was changed.',
  [CODES.UNVERIFIED]: 'The saved trees were rewritten but could not be verified afterwards. Restart ToolsEnabled and check them before changing anything else.',
})

function ipcError(code, message) { return Object.assign(new Error(message), { code }) }

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isIdentifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[a-z0-9][a-z0-9._:/-]*$/i.test(value)
const sha256Of = data => crypto.createHash('sha256').update(data).digest('hex')
const refusal = (code, persistenceFailed = true) => Object.freeze({ ok: false, code, reason: REASONS[code], persistenceFailed })
const failure = ({ code, reason }) => ({ ok: false, code, reason })

// The person is the app window at the keyboard: a window principal that may write and whose window is still there.
const ownerAlive = owner => { try { return isRecord(owner) && typeof owner.isDestroyed === 'function' && owner.isDestroyed() === false } catch { return false } }
const isPerson = principal => isRecord(principal) && principal.kind === 'window' && principal.mayWrite === true && ownerAlive(principal.owner)

function asBytes(raw) {
  if (typeof raw === 'string') return Buffer.from(raw, 'utf8')
  if (Buffer.isBuffer(raw)) return raw
  return raw instanceof Uint8Array ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : null
}

/* The wrapper rendererPrefs writes: { storageVersion, values: { <fleet document key>: <string> } }. An entry the cache
 * would have dropped (not a string, not a fleet document key) is not something the cache can agree with, so it is not
 * read past. */
function parseWrapper(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  if (!isRecord(parsed) || parsed.storageVersion !== STORAGE_VERSION || !isRecord(parsed.values)) return null
  const values = new Map()
  for (const [key, value] of Object.entries(parsed.values)) {
    if (typeof value !== 'string' || !isFleetDocumentKey(key)) return null
    values.set(key, value)
  }
  return values
}

// Bytes to { ok, bytes, text, values } for a saved-trees wrapper, or the code that says why they are not one.
function decodeWrapper(raw) {
  const bytes = asBytes(raw)
  if (!bytes) return { ok: false, code: CODES.FILE_UNREADABLE }
  if (bytes.length > MAX_FLEET_RECORD_BYTES) return { ok: false, code: CODES.TOO_LARGE }
  // Bytes that are not valid UTF-8 do not survive a decode and re-encode; the cache read them lossily, so they cannot agree with it.
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) return { ok: false, code: CODES.FLEET_DAMAGED }
  const values = parseWrapper(text)
  if (!values) return { ok: false, code: CODES.FLEET_DAMAGED }
  return { ok: true, bytes, text, values }
}

const sameEntries = (left, right) => left.size === right.size && [...left].every(([key, value]) => right.get(key) === value)

/* Layer one, for prune, repair and rollback: the durable file and the cache agree exactly and nothing is unsettled.
 * The cache is read first and the file straight after, in the same synchronous turn, so no renderer save can land
 * between them. Returns { ok: true, text, sha256, bytes, values } or a refusal { ok: false, code, reason,
 * persistenceFailed }. `persistenceFailed` is false only where the store is merely not settled or not there. */
function readFleetStore({ rendererPrefs, storePath, fs = nodeFs } = {}) {
  if (typeof rendererPrefs?.snapshot !== 'function' || typeof storePath !== 'string' || !path.isAbsolute(storePath)
      || typeof fs?.readFileSync !== 'function') return refusal(CODES.UNCONFIGURED)
  let snap
  try { snap = rendererPrefs.snapshot() } catch { return refusal(CODES.SNAPSHOT_UNREADABLE) }
  if (!isRecord(snap) || snap.ok !== true || !isRecord(snap.values) || typeof snap.fleetPending !== 'boolean'
      || !('fleetDamaged' in snap) || !('damaged' in snap) || !('fleetWriteError' in snap)) return refusal(CODES.SNAPSHOT_UNREADABLE)
  if (snap.fleetDamaged) return refusal(CODES.FLEET_DAMAGED)
  if (snap.damaged) return refusal(CODES.PREFS_DAMAGED)
  if (snap.fleetWriteError) return refusal(CODES.WRITE_ERROR)
  if (snap.fleetPending) return refusal(CODES.PENDING, false)

  const cached = new Map(Object.entries(snap.values).filter(([key]) => isFleetDocumentKey(key)))
  let raw
  try { raw = fs.readFileSync(storePath) } catch (error) {
    if (error?.code !== 'ENOENT') return refusal(CODES.FILE_UNREADABLE)
    return cached.size === 0 ? refusal(CODES.EMPTY, false) : refusal(CODES.DISAGREES)
  }
  const decoded = decodeWrapper(raw)
  if (!decoded.ok) return refusal(decoded.code)
  if (!sameEntries(cached, decoded.values)) return refusal(CODES.DISAGREES)
  return Object.freeze({ ok: true, text: decoded.text, sha256: sha256Of(decoded.bytes), bytes: decoded.bytes.length, values: decoded.values })
}

// Layer two, prune only: every saved tree and node id, each document validated as src/fleet-trees.js reads it.
function readTrees(values) {
  const trees = [], nodes = [], ids = new Set()
  for (const [key, raw] of values) {
    if (!isFleetTreeKey(key)) continue
    let document
    try { document = JSON.parse(raw) } catch { return null }
    if (!isRecord(document) || document.version !== 1 || !Array.isArray(document.trees) || !Array.isArray(document.nodes)
        || document.trees.length > MAX_TREES_PER_DOCUMENT || document.nodes.length > MAX_NODES_PER_DOCUMENT) return null
    const own = new Set()
    for (const entry of document.trees) {
      if (!isRecord(entry) || !isIdentifier(entry.id) || ids.has(entry.id)) return null
      ids.add(entry.id); own.add(entry.id); trees.push(Object.freeze({ id: entry.id }))
    }
    for (const entry of document.nodes) {
      if (!isRecord(entry) || !isIdentifier(entry.id) || ids.has(entry.id) || !own.has(entry.treeId) || !NODE_STATUSES.has(entry.status)) return null
      ids.add(entry.id); nodes.push(Object.freeze({ id: entry.id, treeId: entry.treeId }))
    }
  }
  return { trees, nodes }
}

/* What continuation-prune.js asks its host for. `revision` is the sha256 of the complete durable wrapper, so the
 * engine's scope hash moves with any byte of it. Anything short of a settled, agreeing, readable, nonempty store is
 * `complete: false`, which the engine refuses by name. */
function readTreeSnapshot(deps = {}) {
  const none = { trees: Object.freeze([]), nodes: Object.freeze([]) }
  const store = readFleetStore(deps)
  if (!store.ok) return Object.freeze({ complete: false, persistenceFailed: store.persistenceFailed, revision: null, ...none, reason: store.code })
  const read = readTrees(store.values)
  if (!read) return Object.freeze({ complete: false, persistenceFailed: true, revision: store.sha256, ...none, reason: CODES.FLEET_DAMAGED })
  if (!read.trees.length || !read.nodes.length) {
    return Object.freeze({ complete: false, persistenceFailed: false, revision: store.sha256, ...none, reason: CODES.EMPTY })
  }
  return Object.freeze({ complete: true, persistenceFailed: false, revision: store.sha256, trees: Object.freeze(read.trees), nodes: Object.freeze(read.nodes) })
}

// JSON equality, key order ignored, array order kept, depth bounded.
function sameJson(left, right, depth = 0) {
  if (depth > MAX_JSON_DEPTH) return false
  if (left === right) return true
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => sameJson(item, right[index], depth + 1))
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key], depth + 1))
  }
  return false
}

const withoutStatus = node => { const rest = { ...node }; for (const field of STATUS_FIELDS) delete rest[field]; return rest }
const sameField = (left, right, field) => Object.hasOwn(left, field) === Object.hasOwn(right, field) && sameJson(left[field], right[field])

/* One saved computer's document against another: 'same' when the same nodes of the same trees differ in nothing but
 * status and statusNote, 'identity' when a node's createdAt, sessionId or lastTurnId differ, 'other' for anything else. */
function compareDocuments(currentText, otherText) {
  let current, other
  try { current = JSON.parse(currentText); other = JSON.parse(otherText) } catch { return { kind: 'other' } }
  if (!isRecord(current) || !isRecord(other) || !Array.isArray(current.nodes) || !Array.isArray(other.nodes) || current.nodes.length !== other.nodes.length) return { kind: 'other' }
  const { nodes: currentNodes, ...currentRest } = current
  const { nodes: otherNodes, ...otherRest } = other
  if (!sameJson(currentRest, otherRest)) return { kind: 'other' }
  let changedNodes = 0
  for (let index = 0; index < currentNodes.length; index += 1) {
    const now = currentNodes[index], then = otherNodes[index]
    if (!isRecord(now) || !isRecord(then) || now.id !== then.id) return { kind: 'other' }
    if (!IDENTITY_FIELDS.every(field => sameField(now, then, field))) return { kind: 'identity' }
    if (!sameJson(withoutStatus(now), withoutStatus(then))) return { kind: 'other' }
    if (!STATUS_FIELDS.every(field => sameField(now, then, field))) {
      if (!REPAIRABLE_STATUSES.has(now.status) || !REPAIRABLE_STATUSES.has(then.status)) return { kind: 'other' }
      changedNodes += 1
    }
  }
  return { kind: 'same', changedNodes }
}

/* Two stores (Map of fleet document key to text) against each other. { ok: true, changedKeys, changedNodes } when they
 * differ only in nodes' status and statusNote (changedKeys are the tree keys that differ, sorted), else
 * { ok: false, kind: 'identity' | 'other' }. No difference at all is ok with nothing changed. */
function statusOnlyDiff(current, other) {
  if (!(current instanceof Map) || !(other instanceof Map) || current.size !== other.size) return { ok: false, kind: 'other' }
  const changedKeys = []
  let changedNodes = 0
  for (const [key, text] of current) {
    if (!other.has(key)) return { ok: false, kind: 'other' }
    if (other.get(key) === text) continue
    if (!isFleetTreeKey(key)) return { ok: false, kind: 'other' }
    const verdict = compareDocuments(text, other.get(key))
    if (verdict.kind !== 'same') return { ok: false, kind: verdict.kind }
    changedKeys.push(key)
    changedNodes += verdict.changedNodes
  }
  return { ok: true, changedKeys: changedKeys.sort(), changedNodes }
}

/* dialog.showMessageBox is the seam the Controller specified: a real OS-native modal from the main process, with no DOM
 * for any automation to reach. MC_SMOKE_HEADLESS mirrors shell/main.cjs (showElevatedRunWarning): under smoke it
 * answers false, never true, rather than skipping the seam. Only the second button approves; a missing answer, a
 * closed window and Cancel all decline. */
function createNativeConfirmOwner({ dialog, parentWindow = null } = {}) {
  return async function confirmOwner(plan) {
    if (process.env.MC_SMOKE_HEADLESS === '1') return false
    if (!dialog || typeof dialog.showMessageBox !== 'function') return false
    const detail = `A dated, verified backup was written first: ${plan.backup}\nSelected ${plan.selected} row${plan.selected === 1 ? '' : 's'} for removal (up to ${plan.limit} per action); ${plan.remaining} more remain eligible for a future action.\nTo undo, restore the database from the backup path above.`
    const answer = await dialog.showMessageBox(parentWindow || undefined, {
      type: 'warning',
      buttons: ['Cancel', `Remove ${plan.selected} rows`],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Remove orphaned continuation rows?',
      message: `Remove ${plan.selected} saved continuation ${plan.selected === 1 ? 'row' : 'rows'} whose agent no longer exists in any saved tree?`,
      detail,
    })
    return answer?.response === 1
  }
}

function createNativeRepairConfirmOwner({ dialog, parentWindow = null } = {}) {
  return async function confirmOwner(payload) {
    if (process.env.MC_SMOKE_HEADLESS === '1') return false
    if (!dialog || typeof dialog.showMessageBox !== 'function') return false
    const restored = Array.isArray(payload?.changes) ? payload.changes.length : 0
    const skipped = Array.isArray(payload?.skipped) ? payload.skipped.length : 0
    if (restored < 1 || typeof payload?.backupPath !== 'string') return false
    const answer = await dialog.showMessageBox(parentWindow || undefined, {
      type: 'warning',
      buttons: ['Cancel', `Restore ${restored} ${restored === 1 ? 'agent' : 'agents'}`],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Restore saved agent status?',
      message: `Restore the saved status of ${restored} ${restored === 1 ? 'agent' : 'agents'} from the snapshot you chose?`,
      detail: `A dated copy of all saved trees was written first: ${payload.backupPath}\n${skipped ? `${skipped} more ${skipped === 1 ? 'agent was' : 'agents were'} left unchanged.\n` : ''}To undo, restore the saved trees from the copy above.`,
    })
    return answer?.response === 1
  }
}

// `nodes` is how many agents' status the backup would put back; the service's payload names the files, not the agents.
function createNativeRollbackConfirmOwner({ dialog, parentWindow = null, nodes = 0 } = {}) {
  return async function confirmOwner(payload) {
    if (process.env.MC_SMOKE_HEADLESS === '1') return false
    if (!dialog || typeof dialog.showMessageBox !== 'function') return false
    if (!(nodes >= 1) || typeof payload?.safetyBackupPath !== 'string') return false
    const answer = await dialog.showMessageBox(parentWindow || undefined, {
      type: 'warning',
      buttons: ['Cancel', `Put back ${nodes} ${nodes === 1 ? 'agent' : 'agents'}`],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Put back saved agent status?',
      message: `Put back the status of ${nodes} ${nodes === 1 ? 'agent' : 'agents'} from the backup you chose?`,
      detail: `A dated copy of the saved trees as they are now was written first: ${payload.safetyBackupPath}\nNothing but agent status is put back.\nTo undo, restore the saved trees from the copy above.`,
    })
    return answer?.response === 1
  }
}

function pick(source, keys) {
  const picked = {}
  for (const key of keys) if (isRecord(source) && Object.hasOwn(source, key)) picked[key] = source[key]
  return picked
}

const sameList = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index])

function createSavedDataMaintenanceAdapter({ resolveCapabilityRoot, requireModule, dialog, browserWindowForPrincipal = () => null,
  rendererPrefs, fleetStorePath, stateFile, fs = nodeFs, repairService, chooseSnapshotFile, chooseRollbackFile, now = () => new Date() } = {}) {
  if (typeof resolveCapabilityRoot !== 'function' || typeof requireModule !== 'function'
      || typeof rendererPrefs?.snapshot !== 'function' || typeof rendererPrefs?.commitFleetMaintenance !== 'function'
      || typeof fleetStorePath !== 'string' || !path.isAbsolute(fleetStorePath) || path.basename(fleetStorePath) !== RENDERER_FLEET_FILE
      || (stateFile !== undefined && (typeof stateFile !== 'string' || !path.isAbsolute(stateFile)))) {
    throw ipcError('MC_SAVED_DATA_MAINTENANCE_CONFIGURATION',
      `The saved-data maintenance adapter needs its engine resolver, the renderer-prefs store, the absolute path of ${RENDERER_FLEET_FILE} and, if given, an absolute state file.`)
  }
  const readStore = () => readFleetStore({ rendererPrefs, storePath: fleetStorePath, fs })
  const clock = () => { const value = Number(now()); return Number.isFinite(value) ? value : Date.now() }
  const invalid = reason => ({ ok: false, code: 'MC_AGENT_INVALID_PAYLOAD', reason })
  const changed = () => ({ ok: false, code: CODES.CHANGED, reason: REASONS[CODES.CHANGED] })
  const personRefusal = () => ({ ok: false, code: CODES.PERSON_REQUIRED, reason: REASONS[CODES.PERSON_REQUIRED] })
  const requirePerson = principal => { if (!isPerson(principal)) throw ipcError(CODES.PERSON_REQUIRED, REASONS[CODES.PERSON_REQUIRED]) }

  // What each preview, prune token, repair token and rollback token was issued for: the fleet hash it was reviewed against.
  const previews = new Map(), tokens = new Map(), repairs = new Map(), rollbacks = new Map()
  function remember(book, key, fleetSha256, extra = {}) {
    for (const [name, entry] of book) if (clock() - entry.at >= REVIEW_LIFETIME_MS) book.delete(name)
    book.set(key, { ...extra, fleetSha256, at: clock() })
    while (book.size > MAX_REVIEWS) book.delete(book.keys().next().value)
  }
  function reviewed(book, key) {
    const entry = typeof key === 'string' ? book.get(key) : undefined
    if (entry && clock() - entry.at >= REVIEW_LIFETIME_MS) { book.delete(key); return null }
    return entry || null
  }
  // Throws a named refusal unless the store is still settled, agreeing, and exactly the one that was reviewed.
  function requireSame(fleetSha256) {
    const store = readStore()
    if (!store.ok) throw ipcError(store.code, store.reason)
    if (store.sha256 !== fleetSha256) throw ipcError(CODES.CHANGED, REASONS[CODES.CHANGED])
    return store
  }

  /* ---- continuation prune ---- */
  let pruner = null
  const pruneUnavailable = () => ({ ok: false, code: 'AGENT_CONTINUATION_PRUNE_UNAVAILABLE', reason: 'Continuation cleanup is unavailable. Update ToolsEnabled and try again.' })
  const pruneReviewMissing = () => ({ ok: false, code: 'CONTINUATION_PRUNE_PREVIEW_REQUIRED', reason: 'The preview is missing, used or expired. Nothing was removed.' })
  const limitOf = value => (Number.isSafeInteger(value?.limit) ? value.limit : undefined)

  // The database the engine's own StateStore would open: the one the caller says the engine host was started with, else
  // TOOLSENABLED_STATE_PATH, else the engine's default. An engine host started with another path than this process's is
  // the caller's to name.
  function stateFileFor(stateStoreModule) {
    if (stateFile !== undefined) return stateFile
    const fromEnvironment = typeof process.env.TOOLSENABLED_STATE_PATH === 'string' ? process.env.TOOLSENABLED_STATE_PATH.trim() : ''
    return fromEnvironment ? path.resolve(fromEnvironment) : stateStoreModule.DEFAULT_STATE_PATH
  }

  function loadContinuationPruner() {
    const engineRoot = resolveCapabilityRoot()
    if (!engineRoot) return null
    let pruneModule, stateStoreModule
    try {
      pruneModule = requireModule(path.join(engineRoot, PAYLOAD_CONTINUATION_PRUNE_MODULE))
      stateStoreModule = requireModule(path.join(engineRoot, PAYLOAD_STATE_STORE_MODULE))
    } catch { return null }
    if (typeof pruneModule?.createContinuationPruner !== 'function' || typeof stateStoreModule?.DEFAULT_STATE_PATH !== 'string') return null
    try {
      return pruneModule.createContinuationPruner({
        file: stateFileFor(stateStoreModule),
        readTreeSnapshot: () => readTreeSnapshot({ rendererPrefs, storePath: fleetStorePath, fs }),
      })
    } catch { return null }
  }

  // Only the engine's own refusals and this module's are worded for the person; anything else is not shown.
  function pruneFailure(error) {
    const code = typeof error?.code === 'string' ? error.code : ''
    if (/^(CONTINUATION_PRUNE_|MC_SAVED_DATA_)[A-Z0-9_]+$/.test(code) && typeof error.message === 'string') return { ok: false, code, reason: error.message }
    return { ok: false, code: 'AGENT_CONTINUATION_PRUNE_FAILED', reason: 'Continuation cleanup could not finish. Review the saved data before trying again.' }
  }

  async function continuationPrunePreview(value, principal) {
    if (!isPerson(principal)) return personRefusal()
    pruner = pruner || loadContinuationPruner()
    if (!pruner) return pruneUnavailable()
    const before = readStore()
    if (!before.ok) return failure(before)
    try {
      const plan = await pruner.preview({ limit: limitOf(value) })
      if (typeof plan?.scopeHash !== 'string' || !SHA256_HEX.test(plan.scopeHash)) return pruneFailure(null)
      requireSame(before.sha256)
      remember(previews, plan.scopeHash, before.sha256)
      return { ok: true, ...pick(plan, ['scopeHash', 'scanned', 'eligible', 'selected', 'remaining', 'limit']), fleetSha256: before.sha256 }
    } catch (error) { return pruneFailure(error) }
  }

  async function continuationPruneConfirm(value, principal) {
    if (!isPerson(principal)) return personRefusal()
    pruner = pruner || loadContinuationPruner()
    if (!pruner) return pruneUnavailable()
    if (typeof value?.stage !== 'string' || !['prepare', 'confirm'].includes(value.stage)) {
      return invalid('This request names no valid continuation-prune stage.')
    }
    try {
      if (value.stage === 'prepare') {
        if (typeof value.scopeHash !== 'string' || !SHA256_HEX.test(value.scopeHash)) return invalid('Review the current warning before continuing.')
        const review = reviewed(previews, value.scopeHash)
        if (!review) return pruneReviewMissing()
        requireSame(review.fleetSha256)
        const prepared = await pruner.prepare({ limit: limitOf(value), scopeHash: value.scopeHash })
        if (prepared?.ok !== true) return pruneFailure(null)
        requirePerson(principal)
        requireSame(review.fleetSha256)
        if (typeof prepared.token === 'string' && prepared.token) remember(tokens, prepared.token, review.fleetSha256)
        return { ok: true, ...pick(prepared, ['token', 'scopeHash', 'backup', 'selected', 'remaining', 'scanned', 'limit', 'reason']), fleetSha256: review.fleetSha256 }
      }
      if (typeof value.token !== 'string' || !value.token || value.token.length > 256) return invalid('Review the current warning before confirming.')
      const review = reviewed(tokens, value.token)
      if (!review) return pruneReviewMissing()
      tokens.delete(value.token)
      requireSame(review.fleetSha256)
      const ask = createNativeConfirmOwner({ dialog, parentWindow: browserWindowForPrincipal(principal) })
      const confirmOwner = async plan => {
        requirePerson(principal)
        requireSame(review.fleetSha256)
        const approved = await ask(plan)
        if (approved === true) requirePerson(principal)
        if (approved === true) requireSame(review.fleetSha256)
        return approved
      }
      const removed = await pruner.confirm({ token: value.token }, confirmOwner)
      if (removed?.ok !== true) return pruneFailure(null)
      return { ok: true, ...pick(removed, ['removed', 'remaining', 'backup']), fleetSha256: review.fleetSha256 }
    } catch (error) { return pruneFailure(error) }
  }

  /* ---- saved node status repair and rollback, on the guarded snapshot service ---- */
  let service = repairService || null
  function loadService() {
    if (!service) { try { service = require(REPAIR_SERVICE_MODULE) } catch { service = null } }
    return service
  }
  function repairServiceOrNull() {
    const found = loadService()
    const usable = found && typeof found.prepareRepair === 'function' && typeof found.confirmRepair === 'function'
      && typeof found.REPAIR_ACTION === 'string' && Number.isSafeInteger(found.MAX_TARGETS)
    return usable ? found : null
  }
  function rollbackServiceOrNull() {
    const found = loadService()
    const usable = found && typeof found.prepareRollback === 'function' && typeof found.confirmRollback === 'function' && typeof found.ROLLBACK_ACTION === 'string'
    return usable ? found : null
  }
  const repairUnavailable = () => ({ ok: false, code: 'AGENT_NODE_STATUS_REPAIR_UNAVAILABLE', reason: 'Saved-status repair is unavailable. Update ToolsEnabled and try again.' })
  const rollbackUnavailable = () => ({ ok: false, code: 'AGENT_NODE_STATUS_ROLLBACK_UNAVAILABLE', reason: 'Saved-status rollback is unavailable. Update ToolsEnabled and try again.' })

  // The scope the page may name: node ids and one fleet tree key. Paths are never taken from it.
  function repairScopeOf(value, limits) {
    const targetIds = value?.targetIds
    if (targetIds !== undefined && (!Array.isArray(targetIds) || targetIds.length < 1 || targetIds.length > limits.MAX_TARGETS
        || targetIds.some(id => typeof id !== 'string' || !id || id.length > 200))) return null
    const valueKey = value?.valueKey
    if (valueKey !== undefined && (typeof valueKey !== 'string' || !isFleetTreeKey(valueKey))) return null
    return { targetIds: targetIds === undefined ? undefined : [...targetIds], valueKey }
  }

  /* The service's synchronous freshnessCheck. It must answer exactly `true`. It is asked before the dated copy, when the
   * replacement is staged and at the commit boundary, and refuses unless the person is still there, the store is settled,
   * agreeing with the cache, the file the service is working on, the bytes it planned from, and (once reviewed) the hash
   * the person reviewed. For a rollback it also holds the service to the backup that was reviewed. And whatever it is
   * about to commit may differ from the store in nothing but nodes' status and statusNote. */
  function createFreshnessCheck({ principal, fleetSha256 = null, restore = null } = {}) {
    let lastRefusal = null
    const refuse = (code, reason = REASONS[code]) => { lastRefusal = { code, reason }; return false }
    const check = (payload = {}) => {
      if (!isPerson(principal)) return refuse(CODES.PERSON_REQUIRED)
      const store = readStore()
      if (!store.ok) return refuse(store.code, store.reason)
      if (payload.storePath !== undefined && payload.storePath !== fleetStorePath) return refuse(CODES.CHANGED)
      if (typeof payload.expectedText === 'string' && payload.expectedText !== store.text) return refuse(CODES.CHANGED)
      if (typeof payload.sourceSha256 === 'string' && payload.sourceSha256 !== store.sha256) return refuse(CODES.CHANGED)
      if (isRecord(payload.source) && payload.source.sha256 !== store.sha256) return refuse(CODES.CHANGED)
      if (fleetSha256 !== null && store.sha256 !== fleetSha256) return refuse(CODES.CHANGED)
      if (restore !== null && typeof payload.replacementText === 'string' && payload.replacementText !== restore.text) return refuse(CODES.CHANGED)
      if (restore !== null && isRecord(payload.restore) && payload.restore.sha256 !== restore.sha256) return refuse(CODES.CHANGED)
      if (typeof payload.replacementText === 'string') {
        const replacement = parseWrapper(payload.replacementText)
        const diff = replacement && statusOnlyDiff(store.values, replacement)
        if (!diff?.ok || diff.changedNodes === 0) return refuse(CODES.REPLACEMENT_NOT_STATUS_ONLY)
      }
      return true
    }
    return Object.assign(check, { lastRefusal: () => lastRefusal })
  }

  /* The commit seam: repaired bytes and the cache change together in one main-process turn, or nothing changes. Each
   * operation gets its own. The service asked the freshness check about the bytes in its own stage and commit payloads;
   * the bytes it finally hands over here are asked of the same check, so a service that vouched for one thing and commits
   * another is refused. Afterwards it can say which bytes it handed over and had accepted. */
  function createCommit(check) {
    let committed = null
    const commit = ({ expectedText, replacementText } = {}) => {
      if (check({ storePath: fleetStorePath, expectedText, replacementText }) !== true) {
        const gate = check.lastRefusal()
        return { ok: false, error: { code: gate.code, message: gate.reason } }
      }
      const result = rendererPrefs.commitFleetMaintenance({ expectedText, replacementText })
      if (result?.ok === true && typeof replacementText === 'string') committed = sha256Of(replacementText)
      return result
    }
    return Object.assign(commit, { committedSha256: () => committed })
  }

  // A repair or rollback failure is worded as the service worded it (its code and reason, nothing else of it) and gains, at
  // most, the gate of this adapter that refused. A service that says nothing usable is a failure of its own kind.
  const SERVICE_FAILED = Object.freeze({
    repair: Object.freeze({ code: 'AGENT_NODE_STATUS_REPAIR_FAILED', reason: 'The saved-status repair could not finish. Nothing is reported as repaired.' }),
    rollback: Object.freeze({ code: 'AGENT_NODE_STATUS_ROLLBACK_FAILED', reason: 'The saved-status rollback could not finish. Nothing is reported as put back.' }),
  })
  function serviceFailure(result, check, kind) {
    const gate = check.lastRefusal()
    const base = isRecord(result) && result.ok === false && typeof result.code === 'string'
      ? { ok: false, code: result.code, reason: typeof result.reason === 'string' ? result.reason : SERVICE_FAILED[kind].reason }
      : { ok: false, ...SERVICE_FAILED[kind] }
    return gate ? { ...base, fleetGate: { code: gate.code, reason: gate.reason } } : base
  }

  // Ok means: the person approved, the service verified what it wrote, and the durable file, read back here, is exactly the
  // bytes this adapter handed the commit seam and the seam accepted, and differs from the reviewed store in exactly the
  // fleet-tree keys the plan named. Nothing less is a success.
  function verifiedSuccess(result, { before, approved, committedSha256, expectedKeys, expectedSha256 = null, fields }) {
    const after = readStore()
    const diff = after.ok ? statusOnlyDiff(before.values, after.values) : null
    const verified = approved === true && result.postWriteVerified === true && after.ok && after.sha256 === result.postWriteSha256
      && committedSha256 !== null && after.sha256 === committedSha256
      && (expectedSha256 === null || after.sha256 === expectedSha256) && diff.ok && sameList(diff.changedKeys, expectedKeys)
    if (!verified) return { ok: false, code: CODES.UNVERIFIED, reason: REASONS[CODES.UNVERIFIED] }
    return { ok: true, confirmed: true, changedKeys: diff.changedKeys, ...pick(result, fields) }
  }

  async function nodeStatusRepairPreview(value, principal) {
    if (!isPerson(principal)) return personRefusal()
    const repair = repairServiceOrNull()
    if (!repair || typeof chooseSnapshotFile !== 'function') return repairUnavailable()
    const scope = repairScopeOf(value, repair)
    if (!scope) return invalid('This request does not name a valid repair scope.')
    const store = readStore()
    if (!store.ok) return failure(store)
    let snapshotPath
    try { snapshotPath = await chooseSnapshotFile({ parentWindow: browserWindowForPrincipal(principal) }) } catch { snapshotPath = null }
    if (!isPerson(principal)) return personRefusal()
    if (typeof snapshotPath !== 'string' || !path.isAbsolute(snapshotPath)) {
      return { ok: false, code: CODES.SNAPSHOT_NOT_CHOSEN, reason: REASONS[CODES.SNAPSHOT_NOT_CHOSEN] }
    }
    const check = createFreshnessCheck({ principal })
    try {
      const result = await repair.prepareRepair({ action: repair.REPAIR_ACTION, trigger: 'owner-action', explicitAction: true,
        storePath: fleetStorePath, snapshotPath, targetIds: scope.targetIds, valueKey: scope.valueKey, now: now(), freshnessCheck: check })
      if (result?.ok !== true) return serviceFailure(result, check, 'repair')
      if (typeof result.previewToken !== 'string' || !result.previewToken) return serviceFailure(null, check, 'repair')
      const settled = readStore()
      if (!settled.ok || settled.sha256 !== result.plan?.sourceSha256) return changed()
      remember(repairs, result.previewToken, settled.sha256)
      return result
    } catch { return serviceFailure(null, check, 'repair') }
  }

  async function nodeStatusRepairConfirm(value, principal) {
    if (!isPerson(principal)) return personRefusal()
    const repair = repairServiceOrNull()
    if (!repair) return repairUnavailable()
    const previewToken = value?.previewToken
    const review = typeof previewToken === 'string' && previewToken.length <= 512 ? reviewed(repairs, previewToken) : null
    if (!review) return { ok: false, code: 'PREVIEW_MISSING', reason: 'The repair preview is missing, used or expired. Nothing was changed.' }
    const store = readStore()
    if (!store.ok) return failure(store)
    if (store.sha256 !== review.fleetSha256) return changed()
    repairs.delete(previewToken)
    const check = createFreshnessCheck({ principal, fleetSha256: review.fleetSha256 })
    const commit = createCommit(check)
    const ask = createNativeRepairConfirmOwner({ dialog, parentWindow: browserWindowForPrincipal(principal) })
    let approved = false
    const confirmNative = async payload => {
      if (check({ storePath: fleetStorePath }) !== true) return false
      const answer = await ask(payload)
      approved = answer === true && check({ storePath: fleetStorePath }) === true
      return approved
    }
    try {
      const result = await repair.confirmRepair({ previewToken, now: now(), confirmNative, freshnessCheck: check, commitReplacement: commit })
      if (result?.ok !== true) return serviceFailure(result, check, 'repair')
      const planned = Array.isArray(result.changes) ? [...new Set(result.changes.map(change => change?.valueKey))].sort() : null
      return verifiedSuccess(result, { before: store, approved, committedSha256: commit.committedSha256(), expectedKeys: planned,
        fields: ['postWriteVerified', 'planHash', 'backupPath', 'restoredNodeIds', 'changes', 'skipped', 'seatChanges', 'notRestorableSeats', 'postWriteSha256'] })
    } catch { return serviceFailure(null, check, 'repair') }
  }

  // A backup file as bytes and values, or why it is not one. Read here so what is compared is what the service will restore.
  function readBackup(restorePath) {
    let raw
    try { raw = fs.readFileSync(restorePath) } catch { return refusal(CODES.BACKUP_UNREADABLE) }
    const decoded = decodeWrapper(raw)
    if (!decoded.ok) return refusal(CODES.BACKUP_UNREADABLE)
    return Object.freeze({ ok: true, text: decoded.text, sha256: sha256Of(decoded.bytes), values: decoded.values })
  }
  // The store against a backup: refused unless the backup differs from it in nodes' status and statusNote alone, and in something.
  function rollbackVerdict(storeValues, backupValues) {
    const diff = statusOnlyDiff(storeValues, backupValues)
    if (!diff.ok) return { ok: false, code: diff.kind === 'identity' ? CODES.ROLLBACK_IDENTITY_DIFFERS : CODES.ROLLBACK_NOT_STATUS_ONLY }
    if (diff.changedNodes === 0) return { ok: false, code: CODES.ROLLBACK_NOTHING_TO_RESTORE }
    return diff
  }

  async function nodeStatusRollbackPreview(value, principal) {
    if (!isPerson(principal)) return personRefusal()
    const rollback = rollbackServiceOrNull()
    if (!rollback || typeof chooseRollbackFile !== 'function') return rollbackUnavailable()
    const store = readStore()
    if (!store.ok) return failure(store)
    let restorePath
    try { restorePath = await chooseRollbackFile({ parentWindow: browserWindowForPrincipal(principal) }) } catch { restorePath = null }
    if (!isPerson(principal)) return personRefusal()
    if (typeof restorePath !== 'string' || !path.isAbsolute(restorePath)) return { ok: false, code: CODES.BACKUP_NOT_CHOSEN, reason: REASONS[CODES.BACKUP_NOT_CHOSEN] }
    if (restorePath === fleetStorePath || !path.basename(restorePath).includes(DATED_BACKUP_MARK)) return { ok: false, code: CODES.BACKUP_NOT_DATED, reason: REASONS[CODES.BACKUP_NOT_DATED] }
    const backup = readBackup(restorePath)
    if (!backup.ok) return failure(backup)
    const verdict = rollbackVerdict(store.values, backup.values)
    if (!verdict.ok) return { ok: false, code: verdict.code, reason: REASONS[verdict.code] }
    const check = createFreshnessCheck({ principal })
    try {
      const result = await rollback.prepareRollback({ action: rollback.ROLLBACK_ACTION, trigger: 'owner-action', explicitAction: true,
        storePath: fleetStorePath, restorePath, now: now(), freshnessCheck: check })
      if (result?.ok !== true) return serviceFailure(result, check, 'rollback')
      const plan = result.plan
      if (typeof result.previewToken !== 'string' || !result.previewToken) return serviceFailure(null, check, 'rollback')
      const settled = readStore()
      if (!settled.ok || settled.sha256 !== store.sha256 || plan?.source?.sha256 !== store.sha256 || plan?.restore?.sha256 !== backup.sha256
          || plan?.storePath !== fleetStorePath || plan?.restorePath !== restorePath) return changed()
      remember(rollbacks, result.previewToken, settled.sha256, { restorePath, restoreText: backup.text, restoreSha256: backup.sha256 })
      return { ...result, changedKeys: verdict.changedKeys }
    } catch { return serviceFailure(null, check, 'rollback') }
  }

  async function nodeStatusRollbackConfirm(value, principal) {
    if (!isPerson(principal)) return personRefusal()
    const rollback = rollbackServiceOrNull()
    if (!rollback) return rollbackUnavailable()
    const previewToken = value?.previewToken
    const review = typeof previewToken === 'string' && previewToken.length <= 512 ? reviewed(rollbacks, previewToken) : null
    if (!review) return { ok: false, code: 'PREVIEW_MISSING', reason: 'The rollback preview is missing, used or expired. Nothing was changed.' }
    const store = readStore()
    if (!store.ok) return failure(store)
    if (store.sha256 !== review.fleetSha256) return changed()
    // The backup is read again: it must still be the bytes that were reviewed, and still a status-only step from the store as it is now.
    const backup = readBackup(review.restorePath)
    if (!backup.ok) return failure(backup)
    if (backup.sha256 !== review.restoreSha256) return changed()
    const verdict = rollbackVerdict(store.values, backup.values)
    if (!verdict.ok) return { ok: false, code: verdict.code, reason: REASONS[verdict.code] }
    rollbacks.delete(previewToken)
    const check = createFreshnessCheck({ principal, fleetSha256: review.fleetSha256, restore: { text: review.restoreText, sha256: review.restoreSha256 } })
    const commit = createCommit(check)
    const ask = createNativeRollbackConfirmOwner({ dialog, parentWindow: browserWindowForPrincipal(principal), nodes: verdict.changedNodes })
    let approved = false
    const confirmNative = async payload => {
      if (check({ storePath: fleetStorePath }) !== true) return false
      const answer = await ask(payload)
      approved = answer === true && check({ storePath: fleetStorePath }) === true
      return approved
    }
    try {
      const result = await rollback.confirmRollback({ action: rollback.ROLLBACK_ACTION, trigger: 'owner-action', explicitAction: true,
        previewToken, now: now(), confirmNative, freshnessCheck: check, commitReplacement: commit })
      if (result?.ok !== true) return serviceFailure(result, check, 'rollback')
      return verifiedSuccess(result, { before: store, approved, committedSha256: commit.committedSha256(), expectedKeys: verdict.changedKeys, expectedSha256: review.restoreSha256,
        fields: ['postWriteVerified', 'planHash', 'restorePath', 'safetyBackupPath', 'postWriteSha256'] })
    } catch { return serviceFailure(null, check, 'rollback') }
  }

  return Object.freeze({ continuationPrunePreview, continuationPruneConfirm, nodeStatusRepairPreview, nodeStatusRepairConfirm,
    nodeStatusRollbackPreview, nodeStatusRollbackConfirm })
}

module.exports = {
  createSavedDataMaintenanceAdapter, readFleetStore, readTreeSnapshot, statusOnlyDiff, isPerson,
  createNativeConfirmOwner, createNativeRepairConfirmOwner, createNativeRollbackConfirmOwner, CODES, REASONS,
}
