/*
 * Presentation-only inactivity state for T rows on the Ledger page.
 *
 * This module never writes a task, changes its status, or consults owner
 * liveness. It reads the timestamps already present in the canonical reply and
 * returns an informational marker only when the evidence is complete.
 */

export const TASK_STALENESS_HOURS_KEY = 'mc.ledger.task-staleness-hours'
export const DEFAULT_TASK_STALENESS_HOURS = 24
export const MIN_TASK_STALENESS_HOURS = 1
export const MAX_TASK_STALENESS_HOURS = 8760

const HOUR_MS = 60 * 60 * 1000
const ACTIVE_TASK_STATUSES = new Set(['open', 'in-progress', 'blocked-external', 'recurring'])
const TERMINAL_TASK_STATUSES = new Set([
  'done',
  'superseded',
  'removed',
  'declined',
  'not-possible-as-asked',
])

const validHours = value => typeof value === 'number'
  && Number.isSafeInteger(value)
  && value >= MIN_TASK_STALENESS_HOURS
  && value <= MAX_TASK_STALENESS_HOURS

const invalidPreference = reason => ({ ok: false, confirmed: false, hours: null, source: 'invalid', reason })
const unavailablePreference = reason => ({ ok: false, confirmed: false, hours: null, source: 'unavailable', reason })

function preferenceStorage(storage) {
  if (storage !== undefined) return storage
  try { return globalThis.localStorage } catch { return null }
}

function parseStoredHours(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const value = Number(raw)
  return validHours(value) ? value : null
}

export function readTaskStalenessHours(storage = undefined) {
  const target = preferenceStorage(storage)
  if (!target || typeof target.getItem !== 'function') {
    return unavailablePreference('The task inactivity preference could not be read.')
  }
  let raw
  try { raw = target.getItem(TASK_STALENESS_HOURS_KEY) } catch {
    return unavailablePreference('The task inactivity preference could not be read.')
  }
  if (raw === null || raw === undefined) {
    return { ok: true, confirmed: true, hours: DEFAULT_TASK_STALENESS_HOURS, source: 'default', reason: null }
  }
  const hours = parseStoredHours(raw)
  if (hours === null) {
    return invalidPreference('The task inactivity setting could not be confirmed: the saved period is not a whole number from 1 to 8760 hours.')
  }
  return { ok: true, confirmed: true, hours, source: 'saved', reason: null }
}

export function writeTaskStalenessHours(hours, storage = undefined) {
  if (!validHours(hours)) {
    return { ok: false, confirmed: false, hours: null, reason: 'Choose a whole number from 1 to 8760 hours.' }
  }
  const target = preferenceStorage(storage)
  if (!target || typeof target.setItem !== 'function' || typeof target.getItem !== 'function') {
    return { ok: false, confirmed: false, hours: null, reason: 'The task inactivity preference could not be saved or confirmed.' }
  }
  try { target.setItem(TASK_STALENESS_HOURS_KEY, String(hours)) } catch {
    return { ok: false, confirmed: false, hours: null, reason: 'The task inactivity preference could not be saved or confirmed.' }
  }
  const readback = readTaskStalenessHours(target)
  if (!readback.ok || readback.source !== 'saved' || readback.hours !== hours) {
    return { ok: false, confirmed: false, hours: null, reason: 'The task inactivity preference could not be saved or confirmed.' }
  }
  return { ok: true, confirmed: true, hours, reason: null }
}

function taskKind(record) {
  if (record && typeof record.kind === 'string') return record.kind === 'T' ? 'T' : ''
  const id = typeof record?.id === 'string' ? record.id : ''
  return id.startsWith('T') ? 'T' : ''
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 80) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? { ms, value } : null
}

/* Return null for an explicitly malformed timestamp. Silently skipping one
   would make a row appear old even though its activity history is incomplete. */
function activitySnapshot(record) {
  const candidates = []
  let malformed = false
  const add = (value, optional = false) => {
    if (optional && (value === null || value === undefined || value === '')) return
    const parsed = parseTimestamp(value)
    if (!parsed) malformed = true
    else candidates.push(parsed)
  }

  add(record?.filedAt, true)
  if (record && Object.hasOwn(record, 'decisionHistory')
      && record.decisionHistory !== null && record.decisionHistory !== undefined
      && !Array.isArray(record.decisionHistory)) malformed = true
  /* A live projection supplies decisionHistory while preserving decisions as
     a numeric count. Direct callers may instead supply raw decisions[]. A
     non-empty projected list wins; an explicitly empty projection falls back
     to raw entries so a mixed fixture cannot hide newer activity. */
  const projectedDecisions = Array.isArray(record?.decisionHistory) ? record.decisionHistory : null
  const projectedDecisionCount = Number.isSafeInteger(record?.decisions) && record.decisions >= 0
    ? record.decisions
    : null
  const decisions = projectedDecisions && projectedDecisions.length > 0
    ? projectedDecisions
    : (Array.isArray(record?.decisions) ? record.decisions : (projectedDecisions || []))
  if (projectedDecisionCount !== null && projectedDecisions && projectedDecisions.length > 0
      && projectedDecisions.length !== projectedDecisionCount) malformed = true
  /* canonical-ledger-read emits a numeric decisions count and one
     latestDecision, not the full journal. Without that authoritative latest
     timestamp the old filedAt would make a row look stale, so fail closed.
     A complete projected decisionHistory is sufficient evidence on its own. */
  if (projectedDecisionCount !== null && projectedDecisionCount > 0
      && (!projectedDecisions || projectedDecisions.length === 0)) {
    const latest = record?.latestDecision
    if (!latest || typeof latest !== 'object' || !Object.hasOwn(latest, 'at')) malformed = true
  }
  for (const decision of decisions) {
    if (!decision || typeof decision !== 'object' || !Object.hasOwn(decision, 'at')) {
      malformed = true
      continue
    }
    add(decision.at)
  }
  if (record?.latestDecision && typeof record.latestDecision === 'object'
      && Object.hasOwn(record.latestDecision, 'at')) add(record.latestDecision.at)
  if (record && Object.hasOwn(record, 'history')
      && record.history !== null && record.history !== undefined
      && !Array.isArray(record.history)) malformed = true
  if (Array.isArray(record?.history)) {
    for (const entry of record.history) {
      if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, 'at')) {
        malformed = true
        continue
      }
      add(entry.at)
    }
  }
  if (malformed || candidates.length === 0) return null
  return candidates.reduce((latest, candidate) => candidate.ms > latest.ms ? candidate : latest)
}

export function taskActivityAt(record) {
  return activitySnapshot(record)?.value || null
}

export function deriveTaskStaleness(record, { hours, now = Date.now() } = {}) {
  const base = { stale: null, lastActivityAt: null, ageMs: null, thresholdMs: null }
  if (taskKind(record) !== 'T') return { ...base, reason: 'not-task' }
  if (record?.removed === true || record?.removedAt || TERMINAL_TASK_STATUSES.has(record?.status)) {
    return { ...base, reason: 'terminal' }
  }
  if (!ACTIVE_TASK_STATUSES.has(record?.status)) return { ...base, reason: 'unknown-status' }
  if (!validHours(hours)) return { ...base, reason: 'unknown-threshold' }
  if (!Number.isFinite(now)) return { ...base, reason: 'unknown-time' }
  const activity = activitySnapshot(record)
  if (!activity) return { ...base, reason: 'unknown-time' }
  const thresholdMs = hours * HOUR_MS
  const ageMs = Math.max(0, now - activity.ms)
  const stale = ageMs >= thresholdMs
  return {
    stale,
    reason: stale ? 'inactive' : 'recent',
    lastActivityAt: activity.value,
    ageMs,
    thresholdMs,
  }
}
