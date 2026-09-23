'use strict'

const crypto = require('node:crypto')
const path = require('node:path')
const nodeFs = require('node:fs/promises')
const nodeFsSync = require('node:fs')
const TOKEN_TTL_MS = 10 * 60 * 1000
const FLEET_VALUE_PREFIX = 'mc.fleet.trees.v1:'
const nodeFsConstants = require('node:fs').constants

const REPAIR_SCHEMA_VERSION = 1
const REPAIR_ACTION = 'restore-status-from-saved-snapshot'
const ROLLBACK_ACTION = 'rollback-saved-node-status-repair'
const MAX_TARGETS = 32
const MAX_DOCUMENT_NODES = 8192
const MAX_IDENTIFIER_CHARS = 200
const MAX_APPROVAL_TOKEN_CHARS = 512
const MAX_PENDING_REPAIR_TOKENS = 64
const NODE_SEAT_ID = /^node-\d+-/

class RepairRefusal extends Error {
  constructor(code, reason, details = {}) {
    super(reason)
    this.name = 'RepairRefusal'
    this.code = code
    this.details = details
  }
}

function refuse(code, reason, details = {}) {
  throw new RepairRefusal(code, reason, details)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
  return value
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (isRecord(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function resultSuccess(payload) {
  return Object.freeze({ ok: true, ...payload })
}

function resultFailure(error) {
  if (error instanceof RepairRefusal) {
    return Object.freeze({ ok: false, code: error.code, reason: error.message, ...error.details })
  }
  throw error
}

function safeIdentifier(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_IDENTIFIER_CHARS
      || /[\u0000-\u001f\u007f]/.test(value)) {
    refuse('INPUT_INVALID', label + ' must be a bounded printable identifier.')
  }
  return value
}

function safeStorePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096
      || /[\u0000-\u001f\u007f]/.test(value) || !path.isAbsolute(value)) {
    refuse('INPUT_INVALID', 'The saved store path must be an absolute bounded printable path.')
  }
  return value
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) refuse('EVIDENCE_INVALID', label + ' must be an object.')
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    refuse('EVIDENCE_INVALID', label + ' has unexpected or missing fields.')
  }
}

function actionGuard({ action, trigger, explicitAction }) {
  if (trigger !== 'owner-action' || explicitAction !== true) {
    refuse('EXPLICIT_ACTION_REQUIRED', 'Saved-node repair is available only from an explicit owner action; startup and load paths are refused.')
  }
  if (action !== REPAIR_ACTION && action !== ROLLBACK_ACTION) {
    refuse('ACTION_INVALID', 'The saved-node repair action name is not recognised.')
  }
}

function isoTimestamp(value, label) {
  const text = value instanceof Date ? value.toISOString() : value
  if (typeof text !== 'string' || Number.isNaN(Date.parse(text))) {
    refuse('INPUT_INVALID', label + ' must be an ISO timestamp.')
  }
  return new Date(text).toISOString()
}

function timestampFrom(clock, label) {
  const value = typeof clock === 'function' ? clock() : clock
  return isoTimestamp(value === undefined ? new Date().toISOString() : value, label)
}

function compactTimestamp(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function fsApi(candidate) {
  const api = candidate || nodeFs
  for (const name of ['readFile', 'stat', 'mkdir', 'copyFile', 'writeFile', 'rename']) {
    if (typeof api[name] !== 'function') {
      refuse('FILESYSTEM_UNAVAILABLE', 'The saved-store filesystem operation ' + name + ' is unavailable.')
    }
  }
  return api
}

async function readText(api, filePath, code, reason) {
  let text
  try {
    text = await api.readFile(filePath, 'utf8')
  } catch {
    refuse(code || 'STORE_UNREADABLE', reason || 'The saved store could not be read; repair was refused.')
  }
  if (typeof text !== 'string' || text.trim() === '' || Buffer.byteLength(text, 'utf8') === 0) {
    refuse('STORE_EMPTY', 'The saved store is empty; repair was refused and no replacement was written.')
  }
  return text
}


function scanJsonTokens(text) {
  let at = 0
  const nodeTokens = new Map()
  const valueTokens = new Map()
  const skip = () => {
    while (at < text.length && /[\t\n\r ]/.test(text[at])) at += 1
  }
  const parseString = () => {
    const start = at
    if (text[at++] !== '"') throw new Error('string expected')
    let escaped = false
    while (at < text.length) {
      const character = text[at++]
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') {
        const raw = text.slice(start, at)
        return { raw, value: JSON.parse(raw), start, end: at }
      }
    }
    throw new Error('unterminated string')
  }
  const parseValue = (parts) => {
    skip()
    const start = at
    const character = text[at]
    if (character === '"') {
      const token = parseString()
      if (parts.length === 2 && parts[0] === 'values') valueTokens.set(parts[1], token)
      return token
    }
    if (character === '{') {
      at += 1
      const fields = []
      skip()
      if (text[at] !== '}') {
        while (true) {
          skip()
          const key = parseString()
          skip()
          if (text[at++] !== ':') throw new Error('object colon expected')
          const value = parseValue(parts.concat(key.value))
          fields.push({ key: key.value, value })
          skip()
          if (text[at] === '}') break
          if (text[at++] !== ',') throw new Error('object comma expected')
        }
      }
      at += 1
      const object = Object.fromEntries(fields.map((field) => [field.key, field.value.value]))
      if (parts.length === 2 && parts[0] === 'nodes' && /^\d+$/.test(parts[1])) {
        const idField = fields.find((field) => field.key === 'id')
        const statusField = fields.find((field) => field.key === 'status')
        if (idField && statusField && typeof idField.value.value === 'string'
            && typeof statusField.value.value === 'string') {
          nodeTokens.set(idField.value.value, {
            id: idField.value.value,
            status: statusField.value.value,
            statusRaw: statusField.value.raw,
            statusStart: statusField.value.start,
            statusEnd: statusField.value.end,
            objectRaw: text.slice(start, at),
            objectStart: start,
            objectEnd: at,
          })
        }
      }
      return { raw: text.slice(start, at), value: object, start, end: at }
    }
    if (character === '[') {
      at += 1
      const entries = []
      skip()
      if (text[at] !== ']') {
        let index = 0
        while (true) {
          entries.push(parseValue(parts.concat(String(index))))
          skip()
          if (text[at] === ']') break
          if (text[at++] !== ',') throw new Error('array comma expected')
          index += 1
        }
      }
      at += 1
      return { raw: text.slice(start, at), value: entries.map((entry) => entry.value), start, end: at }
    }
    while (at < text.length && !/[\s,\]}]/.test(text[at])) at += 1
    if (at === start) throw new Error('value expected')
    const raw = text.slice(start, at)
    return { raw, value: JSON.parse(raw), start, end: at }
  }
  try {
    skip()
    const root = parseValue([])
    skip()
    if (!isRecord(root.value) || at !== text.length) throw new Error('invalid root')
    return { root: root.value, nodeTokens, valueTokens }
  } catch (error) {
    if (error instanceof RepairRefusal) throw error
    refuse('STORE_INVALID', 'The saved store is not readable JSON; repair was refused.')
  }
}


function normalizeTargets(targetIds) {
  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    refuse('TARGET_INVALID', 'At least one affected node target is required.')
  }
  if (targetIds.length > MAX_TARGETS) {
    refuse('TARGET_BOUND_EXCEEDED', 'The affected node target count exceeds the bounded repair subset.')
  }
  const normalized = targetIds.map((nodeId) => safeIdentifier(nodeId, 'node id'))
  if (new Set(normalized).size !== normalized.length) {
    refuse('TARGET_INVALID', 'Affected node targets must be unique.')
  }
  return [...normalized].sort()
}

function revisionOf(stat, label) {
  if (!stat || !Number.isFinite(Number(stat.size)) || !Number.isFinite(Number(stat.mtimeMs))) {
    refuse('STORE_REVISION_UNAVAILABLE', label + ' has no durable size/mtime revision.')
  }
  const revision = { size: Number(stat.size), mtimeMs: Number(stat.mtimeMs) }
  if (stat.ino !== undefined) revision.ino = String(stat.ino)
  return revision
}

async function readSource(api, storePath) {
  const text = await readText(api, storePath)
  let stat
  try {
    stat = await api.stat(storePath)
  } catch {
    refuse('STORE_UNREADABLE', 'The saved store revision could not be read; repair was refused.')
  }
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: sha256(text),
    revision: revisionOf(stat, 'saved store'),
  }
}

function backupPathFor(storePath, createdAt, sourceSha256) {
  return path.join(
    path.dirname(storePath),
    path.basename(storePath) + '.repair-backup-' + compactTimestamp(createdAt) + '-' + sourceSha256.slice(0, 16) + '.json',
  )
}

async function createBackup(api, storePath, source, createdAt) {
  const backupPath = backupPathFor(storePath, createdAt, source.sha256)
  if (backupPath === storePath) refuse('BACKUP_FAILED', 'The dated backup path must differ from the saved store path.')
  try {
    await api.mkdir(path.dirname(backupPath), { recursive: true })
    await api.copyFile(storePath, backupPath, nodeFsConstants.COPYFILE_EXCL)
  } catch (error) {
    if (error instanceof RepairRefusal) throw error
    refuse('BACKUP_FAILED', 'The dated full-store backup could not be created; repair was refused.')
  }
  let backupText
  try {
    backupText = await api.readFile(backupPath, 'utf8')
  } catch {
    refuse('BACKUP_VERIFY_FAILED', 'The dated full-store backup could not be read back; repair was refused.')
  }
  if (backupText !== source.text || sha256(backupText) !== source.sha256) {
    refuse('BACKUP_VERIFY_FAILED', 'The dated full-store backup does not exactly match the source bytes.')
  }
  let backupStat
  try {
    backupStat = await api.stat(backupPath)
  } catch {
    refuse('BACKUP_VERIFY_FAILED', 'The dated full-store backup has no readable revision.')
  }
  return {
    backupPath,
    backupSha256: sha256(backupText),
    backupBytes: Buffer.byteLength(backupText, 'utf8'),
    backupRevision: revisionOf(backupStat, 'dated full-store backup'),
  }
}

async function verifyBackup(api, plan, sourceText) {
  let backupText
  try {
    backupText = await api.readFile(plan.backupPath, 'utf8')
  } catch {
    refuse('BACKUP_MISSING', 'The completed dated full-store backup is missing; repair was refused.')
  }
  if (backupText !== sourceText || sha256(backupText) !== plan.backupSha256
      || Buffer.byteLength(backupText, 'utf8') !== plan.backupBytes) {
    refuse('BACKUP_SCOPE_MISMATCH', 'The completed dated backup no longer matches the planned whole-store source.')
  }
  let backupStat
  try {
    backupStat = await api.stat(plan.backupPath)
  } catch {
    refuse('BACKUP_MISSING', 'The completed dated full-store backup revision is unreadable.')
  }
  if (canonical(revisionOf(backupStat, 'dated full-store backup')) !== canonical(plan.backupRevision)) {
    refuse('BACKUP_SCOPE_MISMATCH', 'The completed dated backup revision changed after preview.')
  }
  return backupText
}


const pendingRepairTokens = new Map()

function repairToken() {
  return crypto.randomBytes(32).toString('hex')
}

function tokenEntry(previewToken) {
  if (typeof previewToken !== 'string' || previewToken.length < 1 || previewToken.length > MAX_APPROVAL_TOKEN_CHARS) {
    refuse('PREVIEW_MISSING', 'The owner-action repair preview token is missing or malformed.')
  }
  const entry = pendingRepairTokens.get(previewToken)
  if (!entry) refuse('PREVIEW_MISSING', 'The owner-action repair preview token is missing or unknown.')
  if (entry.state !== 'pending') {
    refuse('PREVIEW_CONSUMED', 'The owner-action repair preview token was already consumed.')
  }
  entry.state = 'consumed-before-dialog'
  return entry
}

async function stageAndCommit(api, storePath, replacement, previewToken) {
  const tempPath = storePath + '.repair-stage-' + previewToken + '.tmp'
  try {
    await api.writeFile(tempPath, replacement, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error instanceof RepairRefusal) throw error
    refuse('WRITE_FAILED', 'The repaired store could not be staged; the original store was not replaced.')
  }
  let staged
  try {
    staged = await api.readFile(tempPath, 'utf8')
  } catch {
    refuse('POST_WRITE_VERIFY_FAILED', 'The staged repair could not be read back; the original store was not replaced.')
  }
  if (staged !== replacement || sha256(staged) !== sha256(replacement)) {
    refuse('POST_WRITE_VERIFY_FAILED', 'The staged repair failed byte verification; the original store was not replaced.')
  }
  try {
    await api.rename(tempPath, storePath)
  } catch {
    refuse('WRITE_FAILED', 'The repaired store could not be committed; the staged copy was retained.')
  }
}

function validateExactFileMeta(meta, label) {
  if (!isRecord(meta) || typeof meta.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(meta.sha256)
      || !Number.isSafeInteger(meta.bytes) || meta.bytes <= 0 || !isRecord(meta.revision)) {
    refuse('ROLLBACK_PLAN_INVALID', label + ' metadata is incomplete.')
  }
}

async function fileMeta(api, filePath, label) {
  const text = await readText(api, filePath, 'ROLLBACK_SOURCE_UNREADABLE', label + ' could not be read.')
  let stat
  try {
    stat = await api.stat(filePath)
  } catch {
    refuse('ROLLBACK_SOURCE_UNREADABLE', label + ' revision could not be read.')
  }
  const metadata = {
    text,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    revision: revisionOf(stat, label),
  }
  return metadata
}

async function verifyExactFile(api, filePath, expected, label) {
  let text
  try {
    text = await api.readFile(filePath, 'utf8')
  } catch {
    refuse('ROLLBACK_BACKUP_MISSING', label + ' is missing; rollback was refused.')
  }
  if (text !== expected.text || sha256(text) !== expected.sha256
      || Buffer.byteLength(text, 'utf8') !== expected.bytes) {
    refuse('ROLLBACK_SCOPE_MISMATCH', label + ' no longer matches its planned whole-file bytes.')
  }
  let stat
  try {
    stat = await api.stat(filePath)
  } catch {
    refuse('ROLLBACK_BACKUP_MISSING', label + ' revision is unreadable; rollback was refused.')
  }
  if (canonical(revisionOf(stat, label)) !== canonical(expected.revision)) {
    refuse('ROLLBACK_SCOPE_MISMATCH', label + ' revision changed after preview.')
  }
  return text
}

function rollbackPlanHash(plan) {
  const payload = { ...plan }
  delete payload.planHash
  return sha256(canonical(payload))
}

function validateRollbackPlan(plan) {
  if (!isRecord(plan) || plan.schemaVersion !== REPAIR_SCHEMA_VERSION
      || plan.action !== ROLLBACK_ACTION || plan.trigger !== 'owner-action'
      || plan.storeFormat !== 'renderer-fleet-documents.values-json-string') {
    refuse('ROLLBACK_PLAN_INVALID', 'The rollback preview plan is not an owner-action plan.')
  }
  safeStorePath(plan.storePath)
  safeStorePath(plan.restorePath)
  safeStorePath(plan.safetyBackupPath)
  if (plan.restorePath === plan.storePath || !plan.restorePath.includes('.repair-backup-')) {
    refuse('ROLLBACK_PLAN_INVALID', 'Rollback requires a dated repair backup as the restore source.')
  }
  validateExactFileMeta(plan.restore, 'restore source')
  validateExactFileMeta(plan.source, 'rollback source')
  validateExactFileMeta(plan.safetyBackup, 'rollback safety backup')
  isoTimestamp(plan.createdAt, 'rollback plan timestamp')
  if (typeof plan.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(plan.planHash)
      || rollbackPlanHash(plan) !== plan.planHash) {
    refuse('ROLLBACK_PLAN_INVALID', 'The rollback plan hash is missing or stale.')
  }
  return plan
}

async function prepareRollback({
  storePath,
  restorePath,
  fs,
  now,
  action = ROLLBACK_ACTION,
  trigger = 'owner-action',
  explicitAction = true,
} = {}) {
  try {
    actionGuard({ action, trigger, explicitAction })
    if (pendingRepairTokens.size >= MAX_PENDING_REPAIR_TOKENS) {
      refuse('PREVIEW_BOUND_EXCEEDED', 'The pending owner-action preview bound has been reached.')
    }
    const api = fsApi(fs)
    const resolvedStorePath = safeStorePath(storePath)
    const resolvedRestorePath = safeStorePath(restorePath)
    const source = await readSource(api, resolvedStorePath)
    const restore = await fileMeta(api, resolvedRestorePath, 'restore source')
    const createdAt = timestampFrom(now, 'rollback preview timestamp')
    const safety = await createBackup(api, resolvedStorePath, source, createdAt)
    const base = {
      schemaVersion: REPAIR_SCHEMA_VERSION,
      action: ROLLBACK_ACTION,
      trigger: 'owner-action',
      storeFormat: 'renderer-fleet-documents.values-json-string',
      storePath: resolvedStorePath,
      restorePath: resolvedRestorePath,
      restore: {
        sha256: restore.sha256,
        bytes: restore.bytes,
        revision: restore.revision,
      },
      source: {
        sha256: source.sha256,
        bytes: source.bytes,
        revision: source.revision,
      },
      safetyBackupPath: safety.backupPath,
      safetyBackup: {
        sha256: safety.backupSha256,
        bytes: safety.backupBytes,
        revision: safety.backupRevision,
      },
      createdAt,
    }
    const plan = { ...base, planHash: rollbackPlanHash(base) }
    validateRollbackPlan(plan)
    const previewToken = repairToken()
    pendingRepairTokens.set(previewToken, {
      state: 'pending',
      plan: clone(plan),
      sourceText: source.text,
      restoreText: restore.text,
    })
    return resultSuccess({
      previewToken,
      plan: clone(plan),
      preview: {
        sourceSha256: source.sha256,
        sourceRevision: clone(source.revision),
        restorePath: resolvedRestorePath,
        safetyBackupPath: safety.backupPath,
      },
    })
  } catch (error) {
    return resultFailure(error)
  }
}


async function confirmRollback({
  previewToken,
  confirmNative,
  fs,
  action = ROLLBACK_ACTION,
  trigger = 'owner-action',
  explicitAction = true,
} = {}) {
  try {
    actionGuard({ action, trigger, explicitAction })
    if (typeof confirmNative !== 'function') {
      refuse('NATIVE_CONFIRM_UNAVAILABLE', 'Rollback requires the trusted main-side native confirmation callback.')
    }
    const api = fsApi(fs)
    const entry = tokenEntry(previewToken)
    const plan = entry.plan
    if (plan.action !== ROLLBACK_ACTION) {
      refuse('PREVIEW_KIND_MISMATCH', 'The repair preview token is not a rollback token.')
    }
    validateRollbackPlan(plan)
    const sourceBefore = await readSource(api, plan.storePath)
    if (sourceBefore.sha256 !== plan.source.sha256
        || sourceBefore.bytes !== plan.source.bytes
        || canonical(sourceBefore.revision) !== canonical(plan.source.revision)) {
      refuse('PREVIEW_STALE', 'The saved store hash or revision changed after the rollback preview.')
    }
    const restoreExpected = { ...plan.restore, text: entry.restoreText }
    await verifyExactFile(api, plan.restorePath, restoreExpected, 'restore source')
    await verifyExactFile(api, plan.safetyBackupPath, {
      ...plan.safetyBackup,
      text: entry.sourceText,
    }, 'rollback safety backup')
    let approval
    try {
      approval = await confirmNative({
        action: ROLLBACK_ACTION,
        planHash: plan.planHash,
        storePath: plan.storePath,
        restorePath: plan.restorePath,
        restoreSha256: plan.restore.sha256,
        safetyBackupPath: plan.safetyBackupPath,
      })
    } catch {
      refuse('NATIVE_CONFIRM_FAILED', 'The trusted native rollback confirmation callback failed; rollback was refused.')
    }
    if (!nativeApproved(approval)) {
      refuse('NATIVE_CONFIRM_REFUSED', 'The trusted native owner dialog did not approve the rollback.')
    }
    const sourceAfter = await readSource(api, plan.storePath)
    if (sourceAfter.sha256 !== plan.source.sha256
        || sourceAfter.bytes !== plan.source.bytes
        || canonical(sourceAfter.revision) !== canonical(plan.source.revision)) {
      refuse('PREVIEW_STALE', 'The saved store hash or revision changed while the rollback dialog was open.')
    }
    await verifyExactFile(api, plan.restorePath, restoreExpected, 'restore source')
    await verifyExactFile(api, plan.safetyBackupPath, {
      ...plan.safetyBackup,
      text: entry.sourceText,
    }, 'rollback safety backup')
    await stageAndCommit(api, plan.storePath, entry.restoreText, previewToken)
    const post = await readSource(api, plan.storePath)
    if (post.text !== entry.restoreText || post.sha256 !== plan.restore.sha256
        || post.bytes !== plan.restore.bytes) {
      refuse('POST_WRITE_VERIFY_FAILED', 'The rollback failed whole-file byte verification.')
    }
    entry.state = 'completed'
    entry.postWriteSha256 = post.sha256
    return resultSuccess({
      planHash: plan.planHash,
      restorePath: plan.restorePath,
      safetyBackupPath: plan.safetyBackupPath,
      postWriteSha256: post.sha256,
      postWriteVerified: true,
    })
  } catch (error) {
    return resultFailure(error)
  }
}

function planSeatRepair({ nodeIds, seats, maxTargets = MAX_TARGETS } = {}) {
  try {
    if (!Array.isArray(nodeIds) || nodeIds.length > maxTargets) {
      refuse('SEAT_SCOPE_BOUND_EXCEEDED', 'Seat repair node scope exceeds the declared bound.')
    }
    if (!Array.isArray(seats) || seats.length > maxTargets) {
      refuse('SEAT_SCOPE_BOUND_EXCEEDED', 'Seat repair seat scope exceeds the declared bound.')
    }
    const normalizedNodes = normalizeTargets(nodeIds || [])
    const nodeSet = new Set(normalizedNodes)
    const normalizedSeats = (seats || []).map((seat) => {
      exactKeys(seat, ['seatId', 'nodeId'], 'seat record')
      return {
        seatId: safeIdentifier(seat.seatId, 'seat id'),
        nodeId: safeIdentifier(seat.nodeId, 'seat node id'),
      }
    })
    const releaseCandidates = normalizedSeats
      .filter((seat) => NODE_SEAT_ID.test(seat.seatId) && !nodeSet.has(seat.nodeId))
      .map((seat) => seat.seatId)
    const assignedNodes = new Set(normalizedSeats.map((seat) => seat.nodeId))
    const missingSeatNodeIds = normalizedNodes.filter((nodeId) => !assignedNodes.has(nodeId))
    return resultSuccess({
      releaseCandidates,
      missingSeatNodeIds,
      grants: [],
      authorityChanges: [],
      requiresOwnerAssignment: missingSeatNodeIds.length > 0,
      refusal: missingSeatNodeIds.length > 0
        ? 'MISSING_RELEASED_SEAT_OWNER_ASSIGNMENT_REQUIRED'
        : null,
    })
  } catch (error) {
    return resultFailure(error)
  }
}



function nativeApproved(result) { return result === true }

function fleetTrees(text, valueKey) {
  const outer = scanJsonTokens(text)
  if (!isRecord(outer.root.values)) refuse('STORE_FORMAT_UNSUPPORTED', 'The fleet documents store has no values envelope.')
  const keys = Object.keys(outer.root.values)
    .filter((key) => key.startsWith(FLEET_VALUE_PREFIX))
    .filter((key) => valueKey === undefined || key === valueKey)
    .sort()
  if (valueKey !== undefined && !keys.includes(valueKey)) refuse('VALUE_NOT_FOUND', 'The selected fleet tree value is not present.')
  if (keys.length === 0) refuse('STORE_FORMAT_UNSUPPORTED', 'The store has no encoded fleet tree values.')
  const trees = new Map()
  for (const key of keys) {
    const encoded = outer.root.values[key]
    if (typeof encoded !== 'string' || encoded.length === 0) refuse('STORE_FORMAT_UNSUPPORTED', 'A fleet tree value is not an encoded JSON string.')
    const inner = scanJsonTokens(encoded)
    if (!isRecord(inner.root) || !Array.isArray(inner.root.nodes)) refuse('STORE_FORMAT_UNSUPPORTED', 'A fleet tree value has no nodes collection.')
    if (inner.root.nodes.length > MAX_DOCUMENT_NODES) refuse('STORE_BOUND_EXCEEDED', 'A fleet tree value exceeds the bounded node scan.')
    const valueToken = outer.valueTokens.get(key)
    if (!valueToken || valueToken.value !== encoded) refuse('STORE_INVALID', 'A fleet value token could not be located exactly.')
    trees.set(key, { key, encoded, inner, valueToken })
  }
  return { root: outer.root, trees }
}

function objectField(encoded, node, fieldName) {
  const raw = encoded.slice(node.objectStart, node.objectEnd)
  let at = 1
  const skip = () => { while (at < raw.length && /[\t\n\r ]/.test(raw[at])) at += 1 }
  const stringEnd = (start) => {
    let cursor = start + 1
    let escaped = false
    while (cursor < raw.length) {
      const character = raw[cursor++]
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') return cursor
    }
    throw new Error('unterminated field key')
  }
  const valueEnd = (start) => {
    const opening = raw[start]
    if (opening !== '"' && opening !== '{' && opening !== '[') {
      let cursor = start
      while (cursor < raw.length && !/[\s,}]/.test(raw[cursor])) cursor += 1
      return cursor
    }
    if (opening === '"') return stringEnd(start)
    const pair = opening === '{' ? ['{', '}'] : ['[', ']']
    let depth = 0
    let cursor = start
    let escaped = false
    let inString = false
    while (cursor < raw.length) {
      const character = raw[cursor++]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
      } else if (character === '"') inString = true
      else if (character === pair[0]) depth += 1
      else if (character === pair[1] && --depth === 0) return cursor
    }
    throw new Error('unterminated field value')
  }
  try {
    while (at < raw.length - 1) {
      skip()
      if (raw[at] === '}') break
      const keyStart = at
      const keyEnd = stringEnd(keyStart)
      const key = JSON.parse(raw.slice(keyStart, keyEnd))
      at = keyEnd
      skip()
      if (raw[at++] !== ':') throw new Error('field colon expected')
      skip()
      const valueStart = at
      const valueEndAt = valueEnd(valueStart)
      if (key === fieldName) {
        const start = node.objectStart + valueStart
        return {
          key,
          keyStart: node.objectStart + keyStart,
          value: JSON.parse(raw.slice(valueStart, valueEndAt)),
          raw: raw.slice(valueStart, valueEndAt),
          start,
          end: node.objectStart + valueEndAt,
        }
      }
      at = valueEndAt
      skip()
      if (raw[at] === ',') at += 1
    }
  } catch {
    refuse('STORE_INVALID', 'A node field could not be located without changing unrelated bytes.')
  }
  return null
}

function treeField(tree, node, name) {
  return objectField(tree.encoded, node, name)
}
function fieldState(field) {
  return field ? { present: true, value: clone(field.value) } : { present: false, value: null }
}
function sameField(left, right) {
  return left.present === right.present && (!left.present || canonical(left.value) === canonical(right.value))
}
function identityOf(tree, node) {
  const session = treeField(tree, node, 'sessionId')
  const turn = treeField(tree, node, 'lastTurnId')
  if (!session || !turn || typeof session.value !== 'string' || typeof turn.value !== 'string') return null
  return { sessionId: session.value, lastTurnId: turn.value }
}
function normalizeSnapshotTargets(targetIds) {
  if (targetIds === undefined) return null
  if (!Array.isArray(targetIds) || targetIds.length === 0) refuse('TARGET_INVALID', 'Affected node targets must be a nonempty array when supplied.')
  if (targetIds.length > MAX_TARGETS) refuse('TARGET_BOUND_EXCEEDED', 'The affected node target count exceeds the bounded repair subset.')
  const normalized = targetIds.map((nodeId) => safeIdentifier(nodeId, 'node id'))
  if (new Set(normalized).size !== normalized.length) refuse('TARGET_INVALID', 'Affected node targets must be unique.')
  return [...normalized].sort()
}
function skipSnapshot(valueKey, nodeId, reason) { return { valueKey, nodeId, reason } }

function deriveSnapshotChanges(current, snapshot, targetIds) {
  const changes = []
  const skipped = []
  const wanted = targetIds === null ? null : new Set(targetIds)
  const keys = [...current.trees.keys()].filter((key) => snapshot.trees.has(key)).sort()
  for (const valueKey of keys) {
    const currentTree = current.trees.get(valueKey)
    const snapshotTree = snapshot.trees.get(valueKey)
    const nodeIds = [...currentTree.inner.nodeTokens.keys()]
      .filter((nodeId) => wanted === null || wanted.has(nodeId))
      .sort()
    for (const nodeId of nodeIds) {
      const currentNode = currentTree.inner.nodeTokens.get(nodeId)
      const snapshotNode = snapshotTree.inner.nodeTokens.get(nodeId)
      if (!snapshotNode) {
        skipped.push(skipSnapshot(valueKey, nodeId, 'SNAPSHOT_NODE_MISSING'))
        continue
      }
      const currentIdentity = identityOf(currentTree, currentNode)
      const snapshotIdentity = identityOf(snapshotTree, snapshotNode)
      if (!currentIdentity || !snapshotIdentity) {
        skipped.push(skipSnapshot(valueKey, nodeId, 'SESSION_OR_TURN_ID_MISSING'))
        continue
      }
      if (canonical(currentIdentity) !== canonical(snapshotIdentity)) {
        skipped.push(skipSnapshot(valueKey, nodeId, 'SESSION_OR_TURN_ID_MISMATCH'))
        continue
      }
      const currentStatus = fieldState(treeField(currentTree, currentNode, 'status'))
      const snapshotStatus = fieldState(treeField(snapshotTree, snapshotNode, 'status'))
      if (!currentStatus.present || typeof currentStatus.value !== 'string'
          || !snapshotStatus.present || typeof snapshotStatus.value !== 'string'
          || currentStatus.value !== 'turn-failed' || snapshotStatus.value !== 'finished') {
        skipped.push(skipSnapshot(valueKey, nodeId, 'STATUS_NOT_RESTORABLE'))
        continue
      }
      const currentNote = fieldState(treeField(currentTree, currentNode, 'statusNote'))
      const snapshotNote = fieldState(treeField(snapshotTree, snapshotNode, 'statusNote'))
      if (sameField(currentStatus, snapshotStatus) && sameField(currentNote, snapshotNote)) {
        skipped.push(skipSnapshot(valueKey, nodeId, 'NO_STATUS_DIFF'))
        continue
      }
      changes.push({
        valueKey,
        nodeId,
        identity: currentIdentity,
        status: { from: currentStatus.value, to: snapshotStatus.value },
        statusNote: { from: currentNote, to: snapshotNote },
      })
    }
  }
  if (changes.length > MAX_TARGETS) refuse('TARGET_BOUND_EXCEEDED', 'The snapshot contains more than the bounded 32 restorable status changes.', { changeCount: changes.length, maxTargets: MAX_TARGETS })
  const seatChanges = []
  const notRestorableSeats = []
  for (const change of changes) {
    const currentTree = current.trees.get(change.valueKey)
    const snapshotTree = snapshot.trees.get(change.valueKey)
    const currentNode = currentTree.inner.nodeTokens.get(change.nodeId)
    const snapshotNode = snapshotTree.inner.nodeTokens.get(change.nodeId)
    const snapshotSeat = treeField(snapshotTree, snapshotNode, 'seatId')
    if (!snapshotSeat || typeof snapshotSeat.value !== 'string') continue
    const currentSeat = treeField(currentTree, currentNode, 'seatId')
    if (currentSeat && currentSeat.value === snapshotSeat.value) continue
    notRestorableSeats.push({
      valueKey: change.valueKey,
      nodeId: change.nodeId,
      seatId: snapshotSeat.value,
      reason: currentSeat ? 'SEAT_OCCUPIED' : 'SEAT_FREE_UNPROVEN',
    })
  }
  return { changes, skipped, seatChanges, notRestorableSeats }
}

function snapshotPlanHash(plan) {
  const payload = { ...plan }
  delete payload.planHash
  return sha256(canonical(payload))
}
function snapshotPlanPayload({ storePath, snapshotPath, source, snapshot, valueKeys, targetIds, analysis, createdAt, backup }) {
  return {
    schemaVersion: 1,
    action: REPAIR_ACTION,
    trigger: 'owner-action',
    storeFormat: 'renderer-fleet-documents.values-json-string',
    storePath,
    snapshotPath,
    sourceSha256: source.sha256,
    sourceBytes: source.bytes,
    sourceRevision: source.revision,
    snapshotSha256: snapshot.sha256,
    snapshotBytes: snapshot.bytes,
    snapshotRevision: snapshot.revision,
    valueKeys,
    targetIds,
    changes: analysis.changes,
    skipped: analysis.skipped,
    restorableNodeIds: analysis.changes.map(({ valueKey, nodeId }) => ({ valueKey, nodeId })),
    seatChanges: analysis.seatChanges,
    notRestorableSeats: analysis.notRestorableSeats,
    createdAt,
    backupPath: backup.backupPath,
    backupSha256: backup.backupSha256,
    backupBytes: backup.backupBytes,
    backupRevision: backup.backupRevision,
    maxTargets: MAX_TARGETS,
  }
}
function validateSnapshotPlan(plan) {
  if (!isRecord(plan) || plan.schemaVersion !== 1 || plan.action !== REPAIR_ACTION
      || plan.trigger !== 'owner-action' || plan.storeFormat !== 'renderer-fleet-documents.values-json-string') {
    refuse('PLAN_INVALID', 'The repair preview plan is not a snapshot owner-action plan for the encoded fleet store.')
  }
  safeStorePath(plan.storePath)
  safeStorePath(plan.snapshotPath, 'snapshot path')
  if (plan.storePath === plan.snapshotPath) refuse('PLAN_INVALID', 'The selected snapshot must differ from the current saved store.')
  for (const name of ['sourceSha256', 'snapshotSha256', 'backupSha256']) {
    if (typeof plan[name] !== 'string' || !/^[a-f0-9]{64}$/.test(plan[name])) refuse('PLAN_INVALID', 'The plan has no exact ' + name + '.')
  }
  for (const name of ['sourceBytes', 'snapshotBytes', 'backupBytes']) {
    if (!Number.isSafeInteger(plan[name]) || plan[name] <= 0) refuse('PLAN_INVALID', 'The plan has no bounded ' + name + '.')
  }
  for (const name of ['sourceRevision', 'snapshotRevision', 'backupRevision']) {
    if (!isRecord(plan[name])) refuse('PLAN_INVALID', 'The plan has no exact ' + name + '.')
  }
  if (!Array.isArray(plan.valueKeys) || plan.valueKeys.length === 0
      || plan.valueKeys.some((key) => typeof key !== 'string' || !key.startsWith(FLEET_VALUE_PREFIX))) {
    refuse('PLAN_INVALID', 'The plan has no matching fleet value keys.')
  }
  if (plan.targetIds !== null && !Array.isArray(plan.targetIds)) refuse('PLAN_INVALID', 'The plan target scope is invalid.')
  if (!Array.isArray(plan.changes) || plan.changes.length < 1 || plan.changes.length > MAX_TARGETS) refuse('PLAN_INVALID', 'The plan has no bounded restorable status changes.')
  if (!Array.isArray(plan.skipped) || !Array.isArray(plan.seatChanges) || !Array.isArray(plan.notRestorableSeats)) refuse('PLAN_INVALID', 'The plan skip and seat accounting is incomplete.')
  isoTimestamp(plan.createdAt, 'repair plan timestamp')
  if (typeof plan.backupPath !== 'string' || !path.isAbsolute(plan.backupPath) || !plan.backupPath.includes('.repair-backup-')) refuse('PLAN_INVALID', 'The plan has no dated whole-store backup path.')
  if (typeof plan.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(plan.planHash) || snapshotPlanHash(plan) !== plan.planHash) refuse('PLAN_INVALID', 'The plan hash is missing or stale.')
  return plan
}

function nativeSnapshotPayload(plan) {
  return {
    action: REPAIR_ACTION,
    planHash: plan.planHash,
    storePath: plan.storePath,
    snapshotPath: plan.snapshotPath,
    valueKeys: [...plan.valueKeys],
    changes: clone(plan.changes),
    skipped: clone(plan.skipped),
    backupPath: plan.backupPath,
    backupSha256: plan.backupSha256,
    seatChanges: clone(plan.seatChanges),
    notRestorableSeats: clone(plan.notRestorableSeats),
  }
}
function snapshotAnalysisMatches(current, snapshot, plan) {
  const analysis = deriveSnapshotChanges(current, snapshot, plan.targetIds)
  if (canonical(analysis.changes) !== canonical(plan.changes)
      || canonical(analysis.skipped) !== canonical(plan.skipped)
      || canonical(analysis.seatChanges) !== canonical(plan.seatChanges)
      || canonical(analysis.notRestorableSeats) !== canonical(plan.notRestorableSeats)) {
    refuse('PLAN_SCOPE_CHANGED', 'The selected snapshot no longer yields the exact planned status/statusNote diff and skip set.')
  }
  return analysis
}

async function prepareSnapshotRepairCore({ storePath, snapshotPath, valueKey, targetIds, fs, now, action = REPAIR_ACTION, trigger = 'owner-action', explicitAction = true } = {}) {
  try {
    actionGuard({ action, trigger, explicitAction })
    const api = fsApi(fs)
    const resolvedStorePath = safeStorePath(storePath)
    const resolvedSnapshotPath = safeStorePath(snapshotPath, 'snapshot path')
    if (resolvedStorePath === resolvedSnapshotPath) refuse('INPUT_INVALID', 'The selected snapshot must differ from the current saved store.')
    const normalizedTargets = normalizeSnapshotTargets(targetIds)
    if (valueKey !== undefined) safeIdentifier(valueKey, 'fleet value key')
    const source = await readSource(api, resolvedStorePath)
    const snapshotSource = await readSource(api, resolvedSnapshotPath)
    const current = fleetTrees(source.text, valueKey)
    const snapshot = fleetTrees(snapshotSource.text, valueKey)
    const analysis = deriveSnapshotChanges(current, snapshot, normalizedTargets)
    if (analysis.changes.length === 0) refuse('NO_RESTORABLE_CHANGES', 'No node met the snapshot identity and finished-status guards; every candidate was skipped.', { skipped: analysis.skipped, seatChanges: analysis.seatChanges, notRestorableSeats: analysis.notRestorableSeats })
    const createdAt = timestampFrom(now, 'repair preview timestamp')
    const backup = await createBackup(api, resolvedStorePath, source, createdAt)
    const base = snapshotPlanPayload({
      storePath: resolvedStorePath,
      snapshotPath: resolvedSnapshotPath,
      source,
      snapshot: snapshotSource,
      valueKeys: [...current.trees.keys()].filter((key) => snapshot.trees.has(key)).sort(),
      targetIds: normalizedTargets,
      analysis,
      createdAt,
      backup,
    })
    const plan = { ...base, planHash: snapshotPlanHash(base) }
    validateSnapshotPlan(plan)
    const previewToken = repairToken()
    pendingRepairTokens.set(previewToken, { state: 'pending', plan: clone(plan), sourceText: source.text, snapshotText: snapshotSource.text })
    return resultSuccess({
      previewToken,
      plan: clone(plan),
      preview: {
        changes: clone(plan.changes),
        skipped: clone(plan.skipped),
        backupPath: plan.backupPath,
        backupSha256: plan.backupSha256,
        seatChanges: clone(plan.seatChanges),
        notRestorableSeats: clone(plan.notRestorableSeats),
      },
    })
  } catch (error) {
    return resultFailure(error)
  }
}

function removeSnapshotField(encoded, node, fieldName) {
  const field = objectField(encoded, node, fieldName)
  if (!field) return null
  let start = field.keyStart
  let end = field.end
  const after = encoded.slice(end, node.objectEnd)
  const nextComma = after.match(/^([\s]*),/)
  if (nextComma) return { start, end: end + nextComma[0].length, replacement: '' }
  const before = encoded.slice(node.objectStart, start)
  const previousComma = before.lastIndexOf(',')
  if (previousComma >= 0) start = node.objectStart + previousComma
  return { start, end, replacement: '' }
}
function addSnapshotField(node, fieldName, rawValue) {
  const insertion = node.objectEnd - 1
  const prefix = Object.keys(node.fields).length === 0 ? '' : ','
  return { start: insertion, end: insertion, replacement: prefix + JSON.stringify(fieldName) + ':' + rawValue }
}
function buildSnapshotReplacement(sourceText, snapshotText, plan) {
  const current = fleetTrees(sourceText)
  const snapshot = fleetTrees(snapshotText)
  const grouped = new Map()
  for (const change of plan.changes) {
    if (!grouped.has(change.valueKey)) grouped.set(change.valueKey, [])
    grouped.get(change.valueKey).push(change)
  }
  const outerPatches = []
  for (const [valueKey, changes] of grouped.entries()) {
    const currentTree = current.trees.get(valueKey)
    const snapshotTree = snapshot.trees.get(valueKey)
    if (!currentTree || !snapshotTree) refuse('PLAN_SCOPE_CHANGED', 'A planned fleet value is missing at commit.')
    const patches = []
    for (const change of changes) {
      const currentNode = currentTree.inner.nodeTokens.get(change.nodeId)
      const snapshotNode = snapshotTree.inner.nodeTokens.get(change.nodeId)
      if (!currentNode || !snapshotNode) refuse('PLAN_SCOPE_CHANGED', 'A planned snapshot node is missing at commit.')
      const currentIdentity = identityOf(currentTree, currentNode)
      const snapshotIdentity = identityOf(snapshotTree, snapshotNode)
      if (!currentIdentity || !snapshotIdentity || canonical(currentIdentity) !== canonical(change.identity) || canonical(currentIdentity) !== canonical(snapshotIdentity)) refuse('SESSION_OR_TURN_ID_MISMATCH', 'A planned node sessionId or lastTurnId changed; its status was not restored.')
      const currentStatus = fieldState(treeField(currentTree, currentNode, 'status'))
      const snapshotStatus = fieldState(treeField(snapshotTree, snapshotNode, 'status'))
      const currentNote = fieldState(treeField(currentTree, currentNode, 'statusNote'))
      const snapshotNote = fieldState(treeField(snapshotTree, snapshotNode, 'statusNote'))
      if (currentStatus.value !== change.status.from || snapshotStatus.value !== change.status.to || !sameField(currentNote, change.statusNote.from) || !sameField(snapshotNote, change.statusNote.to)) refuse('PLAN_SCOPE_CHANGED', 'A planned status/statusNote value changed before commit.')
      const statusField = objectField(currentTree.encoded, currentNode, 'status')
      const snapshotStatusField = objectField(snapshotTree.encoded, snapshotNode, 'status')
      if (!statusField || !snapshotStatusField) refuse('PLAN_SCOPE_CHANGED', 'A planned status field is missing at commit.')
      patches.push({ start: statusField.start, end: statusField.end, replacement: snapshotStatusField.raw })
      const notePatch = (() => {
        const currentNoteField = objectField(currentTree.encoded, currentNode, 'statusNote')
        const snapshotNoteField = objectField(snapshotTree.encoded, snapshotNode, 'statusNote')
        if (currentNoteField && snapshotNoteField) return { start: currentNoteField.start, end: currentNoteField.end, replacement: snapshotNoteField.raw }
        if (currentNoteField && !snapshotNoteField) return removeSnapshotField(currentTree.encoded, currentNode, 'statusNote')
        if (!currentNoteField && snapshotNoteField) return addSnapshotField(currentNode, 'statusNote', snapshotNoteField.raw)
        return null
      })()
      if (notePatch) patches.push(notePatch)
    }
    patches.sort((left, right) => right.start - left.start)
    let encoded = currentTree.encoded
    for (const patch of patches) encoded = encoded.slice(0, patch.start) + patch.replacement + encoded.slice(patch.end)
    outerPatches.push({ start: currentTree.valueToken.start, end: currentTree.valueToken.end, replacement: JSON.stringify(encoded) })
  }
  outerPatches.sort((left, right) => right.start - left.start)
  let replacement = sourceText
  for (const patch of outerPatches) replacement = replacement.slice(0, patch.start) + patch.replacement + replacement.slice(patch.end)
  return replacement
}
function verifySnapshotPost(sourceText, expectedText, plan) {
  if (sourceText !== expectedText || sha256(sourceText) !== sha256(expectedText) || Buffer.byteLength(sourceText, 'utf8') !== Buffer.byteLength(expectedText, 'utf8')) refuse('POST_WRITE_VERIFY_FAILED', 'The committed repair failed whole-file byte verification.')
  const current = fleetTrees(sourceText)
  for (const change of plan.changes) {
    const node = current.trees.get(change.valueKey).inner.nodeTokens.get(change.nodeId)
    if (!node || fieldState(treeField(current.trees.get(change.valueKey), node, 'status')).value !== change.status.to || !sameField(fieldState(treeField(current.trees.get(change.valueKey), node, 'statusNote')), change.statusNote.to) || canonical(identityOf(current.trees.get(change.valueKey), node)) !== canonical(change.identity)) refuse('POST_WRITE_VERIFY_FAILED', 'A restored node status/statusNote or identity did not verify after commit.')
  }
}
async function syncFile(api, filePath, label) {
  let handle
  try {
    if (!api || typeof api.open !== 'function') throw new Error('open unavailable')
    handle = await api.open(filePath, 'r')
    if (!handle || typeof handle.sync !== 'function') throw new Error('sync unavailable')
    await handle.sync()
  } catch {
    refuse('DURABILITY_FAILED', label + ' could not be fsynced before the repair proceeded.')
  } finally {
    if (handle && typeof handle.close === 'function') {
      try { await handle.close() } catch {}
    }
  }
}
function sourceMatches(expected, source) {
  return source.sha256 === expected.sha256
    && source.bytes === expected.bytes
    && canonical(source.revision) === canonical(expected.revision)
}
function syncFileSnapshot(api, filePath, label) {
  return syncFile(api, filePath, label)
}
function durableSnapshotFs(candidate) {
  const base = fsApi(candidate)
  return {
    ...base,
    async copyFile(...args) { await base.copyFile(...args); await syncFileSnapshot(base, args[1], 'dated full-store backup') },
    async writeFile(...args) { await base.writeFile(...args); await syncFileSnapshot(base, args[0], 'staged repair') },
  }
}
function snapshotPlanSource(plan) {
  return plan.sourceSha256
    ? { sha256: plan.sourceSha256, bytes: plan.sourceBytes, revision: plan.sourceRevision }
    : plan.source
}
function syncSnapshotGate(callback, payload, code, reason) {
  if (typeof callback !== 'function') refuse(code + '_UNAVAILABLE', reason)
  const input = code.startsWith('SYNCHRONOUS_COMMIT') ? { expectedText: payload.expectedText, replacementText: payload.replacementText } : payload
  let result
  try { result = callback(input) } catch { refuse(code + '_FAILED', reason) }
  if (result && typeof result.then === 'function') refuse(code + '_ASYNC', reason + ' The trusted main-side callback must be synchronous.')
  if (code.startsWith('SYNCHRONOUS_COMMIT')) {
    if (result === true || (isRecord(result) && result.ok === true)) return true
    if (isRecord(result) && result.ok === false && isRecord(result.error)) refuse(typeof result.error.code === 'string' ? result.error.code : code, typeof result.error.message === 'string' ? result.error.message : reason)
    refuse(code, reason)
  }
  if (result !== true) refuse(code, reason)
  return true
}
function readCurrentSnapshotSync(storePath, label) {
  try {
    const text = nodeFsSync.readFileSync(storePath, 'utf8')
    const stat = nodeFsSync.statSync(storePath)
    return { text, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text), revision: revisionOf(stat, label) }
  } catch { return null }
}
function confirmSnapshotFs(candidate, plan, sourceRef, failureRef, callbacks) {
  const base = fsApi(candidate)
  const wrapped = durableSnapshotFs(base)
  let stagedText = null
  const originalReadFile = wrapped.readFile
  wrapped.readFile = async (...args) => {
    const text = await originalReadFile(...args)
    if (args[0] === plan.storePath) sourceRef.text = text
    return text
  }
  const originalWriteFile = wrapped.writeFile
  wrapped.writeFile = async (...args) => {
    if (args[0] === plan.storePath + '.repair-stage-' + callbacks.previewToken + '.tmp') {
      stagedText = args[1]
      try { syncSnapshotGate(callbacks.freshnessCheck, { ...plan, phase: 'stage', expectedText: sourceRef.text, replacementText: stagedText }, 'FRESHNESS_REFUSED', 'The renderer-prefs fleet cache was pending, damaged, or changed; staged repair was refused.') } catch (error) { failureRef.error = error; return }
    }
    return originalWriteFile(...args)
  }
  const originalRename = wrapped.rename
  wrapped.rename = async (...args) => {
    if (args[1] !== plan.storePath) return originalRename(...args)
    const current = readCurrentSnapshotSync(plan.storePath, 'saved store at commit')
    if (!current || !sourceMatches(snapshotPlanSource(plan), current)) { failureRef.error = new RepairRefusal('PREVIEW_STALE', 'The saved store hash or revision changed at the synchronous commit boundary.'); return }
    if (typeof stagedText !== 'string') { failureRef.error = new RepairRefusal('POST_WRITE_VERIFY_FAILED', 'The staged replacement was unavailable at the commit boundary.'); return }
    const payload = { ...plan, phase: 'commit', expectedText: current.text, replacementText: stagedText }
    try {
      syncSnapshotGate(callbacks.freshnessCheck, payload, 'FRESHNESS_REFUSED', 'The renderer-prefs fleet cache was pending, damaged, or changed; commit was refused.')
      syncSnapshotGate(callbacks.commitReplacement, payload, 'SYNCHRONOUS_COMMIT_REFUSED', 'The trusted main-side synchronous commitReplacement callback did not commit the exact planned bytes.')
    } catch (error) { failureRef.error = error }
  }
  return wrapped
}

async function prepareSnapshotRepair(args = {}) {
  try {
    const storePath = safeStorePath(args.storePath)
    pruneRepairTokens(args.now)
    syncSnapshotGate(args.freshnessCheck, { action: REPAIR_ACTION, phase: 'backup', storePath, snapshotPath: args.snapshotPath, valueKey: args.valueKey }, 'FRESHNESS_REFUSED', 'The renderer-prefs fleet cache was pending, damaged, or changed; dated backup was refused.')
    return await prepareSnapshotRepairCore({ ...args, fs: durableSnapshotFs(args.fs) })
  } catch (error) { return resultFailure(error) }
}
async function confirmSnapshotRepair(args = {}) {
  let failureRef = null
  try {
    if (typeof args.confirmNative !== 'function') refuse('NATIVE_CONFIRM_UNAVAILABLE', 'Repair requires the trusted main-side native confirmation callback.')
    if (typeof args.freshnessCheck !== 'function') refuse('FRESHNESS_REFUSED_UNAVAILABLE', 'Repair requires a main-side renderer-prefs freshness callback.')
    if (typeof args.commitReplacement !== 'function') refuse('SYNCHRONOUS_COMMIT_REFUSED_UNAVAILABLE', 'Repair requires a synchronous main-side commitReplacement callback.')
    ensureTokenFresh(args.previewToken, args.now)
    const entry = pendingRepairTokens.get(args.previewToken)
    if (!entry) refuse('PREVIEW_MISSING', 'The owner-action repair preview token is missing or unknown.')
    failureRef = { error: null }
    const sourceRef = { text: null }
    const wrappedFs = confirmSnapshotFs(args.fs, entry.plan, sourceRef, failureRef, { previewToken: args.previewToken, freshnessCheck: args.freshnessCheck, commitReplacement: args.commitReplacement })
    const result = await (async () => {
      const api = fsApi(wrappedFs)
      const tokenEntryValue = tokenEntry(args.previewToken)
      const plan = validateSnapshotPlan(tokenEntryValue.plan)
      const sourceBefore = await readSource(api, plan.storePath)
      const snapshotBefore = await readSource(api, plan.snapshotPath)
      if (!sourceMatches(snapshotPlanSource(plan), sourceBefore) || !sourceMatches({ sha256: plan.snapshotSha256, bytes: plan.snapshotBytes, revision: plan.snapshotRevision }, snapshotBefore)) refuse('PREVIEW_STALE', 'The current store or selected snapshot hash/revision changed after the owner preview.')
      snapshotAnalysisMatches(fleetTrees(sourceBefore.text), fleetTrees(snapshotBefore.text), plan)
      await verifyBackup(api, plan, tokenEntryValue.sourceText)
      let approval
      try { approval = await args.confirmNative(nativeSnapshotPayload(plan)) } catch { refuse('NATIVE_CONFIRM_FAILED', 'The trusted native owner confirmation callback failed; repair was refused.') }
      if (approval !== true) refuse('NATIVE_CONFIRM_REFUSED', 'The trusted native owner dialog did not approve the saved-node repair.')
      const sourceAfter = await readSource(api, plan.storePath)
      const snapshotAfter = await readSource(api, plan.snapshotPath)
      if (!sourceMatches(snapshotPlanSource(plan), sourceAfter) || !sourceMatches({ sha256: plan.snapshotSha256, bytes: plan.snapshotBytes, revision: plan.snapshotRevision }, snapshotAfter)) refuse('PREVIEW_STALE', 'The current store or selected snapshot hash/revision changed while the owner dialog was open.')
      snapshotAnalysisMatches(fleetTrees(sourceAfter.text), fleetTrees(snapshotAfter.text), plan)
      await verifyBackup(api, plan, tokenEntryValue.sourceText)
      const replacement = buildSnapshotReplacement(sourceAfter.text, snapshotAfter.text, plan)
      await stageAndCommit(api, plan.storePath, replacement, args.previewToken)
      verifySnapshotPost(await readText(api, plan.storePath), replacement, plan)
      tokenEntryValue.state = 'completed'
      tokenEntryValue.postWriteSha256 = sha256(replacement)
      return resultSuccess({ planHash: plan.planHash, backupPath: plan.backupPath, restoredNodeIds: clone(plan.restorableNodeIds), changes: clone(plan.changes), skipped: clone(plan.skipped), seatChanges: clone(plan.seatChanges), notRestorableSeats: clone(plan.notRestorableSeats), postWriteSha256: tokenEntryValue.postWriteSha256, postWriteVerified: true })
    })()
    const currentEntry = pendingRepairTokens.get(args.previewToken)
    if (currentEntry && currentEntry.state !== 'pending') currentEntry.consumedAt = tokenNow(args.now)
    if (failureRef.error) return resultFailure(failureRef.error)
    return result
  } catch (error) { return resultFailure(failureRef && failureRef.error ? failureRef.error : error) }
}

async function prepareRollbackGuarded(args = {}) {
  try {
    const storePath = safeStorePath(args.storePath)
    pruneRepairTokens(args.now)
    syncSnapshotGate(args.freshnessCheck, { action: ROLLBACK_ACTION, phase: 'safety-backup', storePath, restorePath: args.restorePath }, 'FRESHNESS_REFUSED', 'The renderer-prefs fleet cache was pending, damaged, or changed; rollback safety backup was refused.')
    return await prepareRollback({ ...args, fs: durableSnapshotFs(args.fs) })
  } catch (error) { return resultFailure(error) }
}
async function confirmRollbackGuarded(args = {}) {
  let failureRef = null
  try {
    if (typeof args.confirmNative !== 'function') refuse('NATIVE_CONFIRM_UNAVAILABLE', 'Rollback requires the trusted main-side native confirmation callback.')
    if (typeof args.freshnessCheck !== 'function') refuse('FRESHNESS_REFUSED_UNAVAILABLE', 'Rollback requires a main-side renderer-prefs freshness callback.')
    if (typeof args.commitReplacement !== 'function') refuse('SYNCHRONOUS_COMMIT_REFUSED_UNAVAILABLE', 'Rollback requires a synchronous main-side commitReplacement callback.')
    ensureTokenFresh(args.previewToken, args.now)
    const entry = pendingRepairTokens.get(args.previewToken)
    if (!entry) refuse('PREVIEW_MISSING', 'The rollback preview token is missing or unknown.')
    failureRef = { error: null }
    const sourceRef = { text: null }
    const wrappedFs = confirmSnapshotFs(args.fs, entry.plan, sourceRef, failureRef, { previewToken: args.previewToken, freshnessCheck: args.freshnessCheck, commitReplacement: args.commitReplacement })
    const result = await confirmRollback({ ...args, fs: wrappedFs, confirmNative: async (payload) => (await args.confirmNative(payload)) === true })
    const currentEntry = pendingRepairTokens.get(args.previewToken)
    if (currentEntry && currentEntry.state !== 'pending') currentEntry.consumedAt = tokenNow(args.now)
    if (failureRef.error) return resultFailure(failureRef.error)
    return result
  } catch (error) { return resultFailure(error) }
}


function tokenNow(value) {
  if (value === undefined) return Date.now()
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(parsed)) refuse('INPUT_INVALID', 'The token clock must be an ISO timestamp.')
  return parsed
}
function pruneRepairTokens(nowValue) {
  const now = tokenNow(nowValue)
  for (const [token, entry] of pendingRepairTokens.entries()) {
    const created = Date.parse(entry.plan && entry.plan.createdAt)
    if (entry.state === 'pending' && Number.isFinite(created) && now - created >= TOKEN_TTL_MS) {
      entry.state = 'expired'
      entry.expiredAt = now
      continue
    }
    const anchor = entry.consumedAt === undefined ? created : entry.consumedAt
    if (entry.state !== 'pending' && Number.isFinite(anchor) && now - anchor >= TOKEN_TTL_MS) pendingRepairTokens.delete(token)
  }
}
function ensureTokenFresh(previewToken, nowValue) {
  pruneRepairTokens(nowValue)
  const entry = pendingRepairTokens.get(previewToken)
  if (!entry) return
  if (entry.state === 'expired') refuse('PREVIEW_EXPIRED', 'The owner-action repair preview token expired; prepare a new snapshot preview.')
  const created = Date.parse(entry.plan && entry.plan.createdAt)
  if (!Number.isFinite(created) || tokenNow(nowValue) - created >= TOKEN_TTL_MS) {
    entry.state = 'expired'
    entry.expiredAt = tokenNow(nowValue)
    refuse('PREVIEW_EXPIRED', 'The owner-action repair preview token expired; prepare a new snapshot preview.')
  }
}

module.exports = Object.freeze({
  REPAIR_ACTION,
  ROLLBACK_ACTION,
  TOKEN_TTL_MS,
  MAX_TARGETS,
  prepareRepair: prepareSnapshotRepair,
  confirmRepair: confirmSnapshotRepair,
  prepareRollback: prepareRollbackGuarded,
  confirmRollback: confirmRollbackGuarded,
  planRepair: prepareSnapshotRepair,
  applyRepair: confirmSnapshotRepair,
  planSeatRepair,
})
