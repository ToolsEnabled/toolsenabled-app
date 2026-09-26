/**
 * Read-only metrics projection.  This intentionally uses the established
 * readers/CLI instead of opening live state, particularly any SQLite store.
 */
import { statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CANONICAL_ROOT,
  LIVE_ROOT,
  available,
  availableEnvelope,
  emitProjection,
  loadReader,
  plainObject,
  runJsonCli,
  source,
  unavailable,
  unavailableEnvelope,
} from './gen-projection-lib.mjs'

const PREFLIGHT_SCRIPT = 'tools/agent-preflight.js'
const LEDGER_READER = 'tools/ledger-query.js'
const LEDGER_FILE = 'reports/OWNER-REQUEST-LEDGER.json'
const QUEUE_CORPUS_READER = 'src/lib/build-queue-corpus.js'
const QUEUE_PROJECTION_READER = 'src/lib/build-queue-projection.js'
const QUEUE_ROOT = 'BUILD-QUEUE.md'
const USAGE_ATTRIBUTION_SCRIPT = 'tools/usage-attribution-query.js'
const USAGE_ATTRIBUTION_LIMIT = 100
const USAGE_ATTRIBUTION_TIMEOUT_MS = 15_000
const USAGE_ATTRIBUTION_MAX_BYTES = 256 * 1024

function isMetricInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function fileObservedAt(root, relativePath) {
  try {
    return new Date(statSync(join(root, relativePath)).mtimeMs).toISOString()
  } catch {
    return null
  }
}

function safeMetricMap(entries) {
  const output = {}
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key) || !isMetricInteger(value)) return null
    output[key] = value
  }
  return output
}

function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isUsageIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(value)
}

function isUsageInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function hasExactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key))
}

/**
 * Validate the reader's public v1 contract before it can become part of a
 * metrics projection.  This intentionally returns a small, reasoned result
 * rather than throwing: usage attribution is one observation, not a
 * prerequisite for the rest of the metrics envelope.
 */
export function validateUsageAttributionPayload(payload) {
  if (!hasExactKeys(payload, ['schemaVersion', 'observation', 'generatedAt', 'source', 'window', 'coverage', 'totals', 'rows'])
    || payload.schemaVersion !== 1
    || payload.observation !== 'agent-role-token-usage'
    || !isIsoDate(payload.generatedAt)
    || !hasExactKeys(payload.source, ['kind', 'provenance', 'requestedLimit'])
    || payload.source.kind !== 'signed-audit-tail'
    || payload.source.provenance !== 'MEASURED'
    || !isUsageInteger(payload.source.requestedLimit)
    || payload.source.requestedLimit < 1
    || payload.source.requestedLimit > 200
    || !hasExactKeys(payload.window, ['scope', 'earliestSequence', 'latestSequence', 'earliestTimestamp', 'latestTimestamp'])
    || payload.window.scope !== 'latest-signed-event-tail'
    || !(payload.window.earliestSequence === null || isUsageInteger(payload.window.earliestSequence))
    || !(payload.window.latestSequence === null || isUsageInteger(payload.window.latestSequence))
    || (payload.window.earliestTimestamp !== null && !isIsoDate(payload.window.earliestTimestamp))
    || (payload.window.latestTimestamp !== null && !isIsoDate(payload.window.latestTimestamp))
    || !hasExactKeys(payload.coverage, ['state', 'complete', 'scannedEvents', 'attributedUsageEvents', 'excludedEvents'])
    || !['complete', 'partial', 'empty'].includes(payload.coverage.state)
    || typeof payload.coverage.complete !== 'boolean'
    || !isUsageInteger(payload.coverage.scannedEvents)
    || !isUsageInteger(payload.coverage.attributedUsageEvents)
    || !hasExactKeys(payload.coverage.excludedEvents, ['nonUsage', 'overlapWrapper', 'missingAttribution', 'unknownAttribution', 'invalidTokenAccounting', 'invalidRouting'])
    || !['nonUsage', 'overlapWrapper', 'missingAttribution', 'unknownAttribution', 'invalidTokenAccounting', 'invalidRouting']
      .every(key => isUsageInteger(payload.coverage.excludedEvents[key]))
    || !hasExactKeys(payload.totals, ['tokens', 'measuredLowerBoundTokens', 'calls'])
    || !isUsageInteger(payload.totals.measuredLowerBoundTokens)
    || !isUsageInteger(payload.totals.calls)
    || !Array.isArray(payload.rows)
    || payload.rows.length > 200) {
    return { ok: false, reason: 'source-malformed' }
  }

  const complete = payload.coverage.state === 'complete'
  const empty = payload.coverage.state === 'empty'
  const excluded = payload.coverage.excludedEvents
  const excludedCount = Object.values(excluded).reduce((sum, value) => sum + value, 0)
  const incompleteCount = excluded.missingAttribution + excluded.unknownAttribution
    + excluded.invalidTokenAccounting + excluded.invalidRouting
  const expectedState = incompleteCount > 0
    ? 'partial'
    : payload.coverage.attributedUsageEvents > 0 ? 'complete' : 'empty'
  const sequencesEmpty = payload.window.earliestSequence === null && payload.window.latestSequence === null
  const sequencesOrdered = isUsageInteger(payload.window.earliestSequence)
    && isUsageInteger(payload.window.latestSequence)
    && payload.window.earliestSequence <= payload.window.latestSequence
  if (payload.coverage.state !== expectedState
    || payload.coverage.complete !== (incompleteCount === 0)
    || payload.coverage.scannedEvents !== payload.coverage.attributedUsageEvents + excludedCount
    || payload.coverage.scannedEvents > payload.source.requestedLimit
    || (!sequencesEmpty && !sequencesOrdered)
    || (complete && (!isUsageInteger(payload.totals.tokens) || payload.rows.length === 0))
    || (empty && (payload.totals.tokens !== 0 || payload.rows.length !== 0))
    || (payload.coverage.state === 'partial' && payload.totals.tokens !== null)) {
    return { ok: false, reason: 'source-malformed' }
  }

  let tokens = 0
  let calls = 0
  let previousKey = ''
  for (const row of payload.rows) {
    if (!hasExactKeys(row, ['pool', 'provider', 'role', 'tokens', 'calls', 'tokenProvenance', 'attributionProvenance'])
      || !isUsageIdentifier(row.pool)
      || !isUsageIdentifier(row.provider)
      || !isUsageIdentifier(row.role)
      || !isUsageInteger(row.tokens)
      || !isUsageInteger(row.calls)
      || row.calls === 0
      || row.tokenProvenance !== 'MEASURED'
      || !['MEASURED', 'DERIVED'].includes(row.attributionProvenance)) {
      return { ok: false, reason: 'source-malformed' }
    }
    const key = `${row.pool}\u0000${row.provider}\u0000${row.role}`
    if (key <= previousKey) return { ok: false, reason: 'source-malformed' }
    previousKey = key
    tokens += row.tokens
    calls += row.calls
    if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(calls)) return { ok: false, reason: 'source-malformed' }
  }

  if (tokens !== payload.totals.measuredLowerBoundTokens
    || calls !== payload.totals.calls
    || calls !== payload.coverage.attributedUsageEvents
    || (complete && tokens !== payload.totals.tokens)) {
    return { ok: false, reason: 'source-malformed' }
  }
  return { ok: true, value: payload }
}

function usageAttributionUnavailable(reason, observedAt = null) {
  return { ok: false, state: 'unavailable', reason, observedAt, value: null }
}

export function usageAttributionObservationFromResult(result) {
  if (!result?.ok) return usageAttributionUnavailable(result?.reason || 'source-unavailable', result?.observedAt || null)
  const checked = validateUsageAttributionPayload(result.value)
  if (!checked.ok) return usageAttributionUnavailable(checked.reason, result.observedAt || null)
  return {
    ok: true,
    state: checked.value.coverage.state,
    reason: null,
    observedAt: checked.value.generatedAt,
    value: checked.value,
  }
}

function runUsageAttributionQuery(root) {
  let result
  try {
    result = spawnSync(process.execPath, [USAGE_ATTRIBUTION_SCRIPT, '--limit', String(USAGE_ATTRIBUTION_LIMIT)], {
      cwd: root,
      encoding: 'utf8',
      timeout: USAGE_ATTRIBUTION_TIMEOUT_MS,
      maxBuffer: USAGE_ATTRIBUTION_MAX_BYTES,
      windowsHide: true,
    })
  } catch {
    return { ok: false, reason: 'source-unavailable', observedAt: null }
  }
  const observedAt = null
  if (result.error?.code === 'ETIMEDOUT') return { ok: false, reason: 'source-timeout', observedAt }
  if (result.error?.code === 'ENOBUFS') return { ok: false, reason: 'source-output-too-large', observedAt }
  if (result.error || result.status !== 0 || result.signal) return { ok: false, reason: 'source-unavailable', observedAt }
  if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout, 'utf8') > USAGE_ATTRIBUTION_MAX_BYTES) {
    return { ok: false, reason: 'source-output-too-large', observedAt }
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout), observedAt }
  } catch {
    return { ok: false, reason: 'source-malformed', observedAt }
  }
}

function sessionsObservation(preflight, observedAt) {
  if (!plainObject(preflight.otherAgents)) return unavailable('source-malformed', observedAt)
  const entries = []
  for (const key of ['codex', 'claude']) {
    if (Object.hasOwn(preflight.otherAgents, key)) {
      if (!Array.isArray(preflight.otherAgents[key])) return unavailable('source-malformed', observedAt)
      entries.push([key, preflight.otherAgents[key].length])
    }
  }
  const value = safeMetricMap(entries)
  return value === null ? unavailable('source-malformed', observedAt) : available(value, observedAt)
}

function fleetSupervisorObservation(preflight, observedAt) {
  const supervisor = preflight.inFlight?.fleetSupervisor
  if (!plainObject(supervisor)) return unavailable('source-malformed', observedAt)
  // A dead supervisor's last item counts are stale and must never be presented
  // as a current fleet observation.
  if (supervisor.alive !== true) return unavailable('source-unavailable', observedAt)
  if (!plainObject(supervisor.items) || !isMetricInteger(supervisor.running)) return unavailable('source-malformed', observedAt)
  const value = safeMetricMap([['running', supervisor.running], ...Object.entries(supervisor.items)])
  return value === null ? unavailable('source-malformed', observedAt) : available(value, observedAt)
}

function servicesObservation(preflight, observedAt) {
  if (!Array.isArray(preflight.localServices)) return unavailable('source-malformed', observedAt)
  const stale = preflight.localServices.filter(service => plainObject(service) && service.stale === true).length
  if (preflight.localServices.some(service => !plainObject(service))) return unavailable('source-malformed', observedAt)
  return available({ total: preflight.localServices.length, stale }, observedAt)
}

async function requestsObservation() {
  const reader = loadReader(CANONICAL_ROOT, LEDGER_READER, 'canonical-ledger')
  const observedAt = fileObservedAt(CANONICAL_ROOT, LEDGER_FILE)
  if (!reader.ok || typeof reader.value?.readLedger !== 'function' || typeof reader.value?.processOpen !== 'function') {
    return { observation: unavailable(reader.reason || 'source-reader-failed', observedAt), source: source({ id: 'canonical-ledger', kind: 'reader', path: LEDGER_READER, ok: false, observedAt, reason: reader.reason || 'source-reader-failed' }) }
  }
  try {
    const ledger = await reader.value.readLedger()
    const open = reader.value.processOpen(ledger)
    if (!Array.isArray(ledger) || !Array.isArray(open)) throw new TypeError('LEDGER_RESULT_INVALID')
    return { observation: available({ total: ledger.length, open: open.length }, observedAt), source: source({ id: 'canonical-ledger', kind: 'reader', path: LEDGER_READER, ok: true, observedAt }) }
  } catch {
    return { observation: unavailable('source-unreadable', observedAt), source: source({ id: 'canonical-ledger', kind: 'reader', path: LEDGER_READER, ok: false, observedAt, reason: 'source-unreadable' }) }
  }
}

function queueObservedAt(corpus) {
  const times = corpus.files.map(relativePath => fileObservedAt(CANONICAL_ROOT, relativePath)).filter(Boolean)
  return times.length ? times.sort().at(-1) : null
}

function queueObservation() {
  const corpusReader = loadReader(CANONICAL_ROOT, QUEUE_CORPUS_READER, 'canonical-queue')
  const projectionReader = loadReader(CANONICAL_ROOT, QUEUE_PROJECTION_READER, 'canonical-queue')
  if (!corpusReader.ok || !projectionReader.ok
    || typeof corpusReader.value?.readQueueCorpus !== 'function'
    || typeof projectionReader.value?.parseQueuePhases !== 'function') {
    const reason = corpusReader.reason || projectionReader.reason || 'source-reader-failed'
    return { observation: unavailable(reason), source: source({ id: 'canonical-queue', kind: 'reader', path: QUEUE_ROOT, ok: false, reason }) }
  }
  try {
    const corpus = corpusReader.value.readQueueCorpus(join(CANONICAL_ROOT, QUEUE_ROOT))
    const phases = projectionReader.value.parseQueuePhases(corpus.text)
    if (!plainObject(corpus) || !Array.isArray(corpus.files) || !Array.isArray(phases)) throw new TypeError('QUEUE_RESULT_INVALID')
    const counts = new Map()
    for (const phase of phases) {
      if (!plainObject(phase) || typeof phase.status !== 'string') throw new TypeError('QUEUE_PHASE_INVALID')
      const status = phase.status.toLowerCase().replaceAll('-', '_')
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(status)) throw new TypeError('QUEUE_STATUS_INVALID')
      counts.set(status, (counts.get(status) || 0) + 1)
    }
    const value = safeMetricMap([['total', phases.length], ...counts.entries()])
    const observedAt = queueObservedAt(corpus)
    if (value === null) throw new TypeError('QUEUE_METRICS_INVALID')
    return { observation: available(value, observedAt), source: source({ id: 'canonical-queue', kind: 'reader', path: QUEUE_ROOT, ok: true, observedAt }) }
  } catch {
    return { observation: unavailable('source-unreadable'), source: source({ id: 'canonical-queue', kind: 'reader', path: QUEUE_ROOT, ok: false, reason: 'source-unreadable' }) }
  }
}

export async function generateMetrics() {
  await emitProjection('metrics', async at => {
  const preflight = runJsonCli(LIVE_ROOT, PREFLIGHT_SCRIPT, ['--json'], 'live-preflight')
  const preflightSource = source({
    id: 'live-preflight', kind: 'cli', path: PREFLIGHT_SCRIPT,
    ok: preflight.ok, observedAt: preflight.observedAt, reason: preflight.reason,
  })
  if (!preflight.ok) {
    return unavailableEnvelope('metrics', preflight.reason, [preflightSource], at)
  }
  if (!plainObject(preflight.value) || !Number.isFinite(Date.parse(preflight.value.generatedAt))) {
    const malformedSource = source({
      id: 'live-preflight', kind: 'cli', path: PREFLIGHT_SCRIPT,
      ok: false, observedAt: preflight.observedAt, reason: 'source-malformed',
    })
    return unavailableEnvelope('metrics', 'source-malformed', [malformedSource], at)
  }

  const [requests, queue] = await Promise.all([requestsObservation(), queueObservation()])
  const usageAttribution = usageAttributionObservationFromResult(runUsageAttributionQuery(LIVE_ROOT))
  const usageAttributionSource = source({
    id: 'usage-attribution', kind: 'cli', path: USAGE_ATTRIBUTION_SCRIPT,
    ok: usageAttribution.ok, observedAt: usageAttribution.observedAt, reason: usageAttribution.reason,
  })
  const auditSource = source({ id: 'audit-sqlite', kind: 'sqlite', path: 'state/audit.sqlite3', ok: false, reason: 'source-unreadable-safely' })
  const memorySource = source({ id: 'memory-sqlite', kind: 'sqlite', path: 'state/toolsenabled.sqlite3', ok: false, reason: 'source-unreadable-safely' })
  const observedAt = preflight.observedAt
  return availableEnvelope('metrics', {
    sessions: sessionsObservation(preflight.value, observedAt),
    fleetSupervisor: fleetSupervisorObservation(preflight.value, observedAt),
    services: servicesObservation(preflight.value, observedAt),
    requests: requests.observation,
    queue: queue.observation,
    audit: unavailable('source-unreadable-safely'),
    memory: unavailable('source-unreadable-safely'),
    usageAttribution,
  }, [preflightSource, requests.source, queue.source, usageAttributionSource, auditSource, memorySource], at)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await generateMetrics()
