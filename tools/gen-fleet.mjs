/**
 * Produce the fleet/computers snapshot from two read-only sources:
 *
 * - the canonical, owner-authored declared agent organisation; and
 * - the live tree's existing agent-preflight JSON CLI.
 *
 * The sources answer different questions.  The org supplies only the declared
 * graph; the preflight supplies only observed machine/service/session facts.
 * Do not merge those meanings or replace an unavailable observation with a
 * plausible zero.
 */
import {
  CANONICAL_ROOT,
  LIVE_ROOT,
  agentProjectionFields,
  availableEnvelope,
  emitProjection,
  loadAgentProjectionTelemetry,
  loadReader,
  plainObject,
  projectAgentRelationships,
  readJsonFile,
  runJsonCli,
  sourceFromResult,
  timestampFromAge,
  unavailableEnvelope,
  terseDetail,
} from './gen-projection-lib.mjs'

const ORG_READER_PATH = 'src/lib/agent-org.js'
const ORG_PATH = 'config/agent-org.json'
const PREFLIGHT_PATH = 'tools/agent-preflight.js'

function unavailableFrom(domain, reason, results, at) {
  return unavailableEnvelope(domain, reason, results.map(result => sourceFromResult(result, result.kind)), at)
}

function asSourceResult(result, kind) {
  return { ...result, kind }
}

function cleanText(value, maximum) {
  if (typeof value !== 'string') return null
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return text.length > 0 && text.length <= maximum ? text : null
}

function serviceId(name, index) {
  const stem = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 68)
  return stem ? `service-${stem}`.slice(0, 79) : `service-${index + 1}`
}

function serviceState(entry) {
  if (entry.stale) return 'stale'
  const detail = entry.detail.toLowerCase()
  if (/\bconflict\b/.test(detail)) return 'conflict'
  if (/\bhealthy\b/.test(detail)) return 'healthy'
  return 'unknown'
}

function normalizePreflight(preflight) {
  if (!plainObject(preflight) || !Number.isFinite(Date.parse(preflight.generatedAt))) return null
  if (!plainObject(preflight.machine) || !/^[A-Za-z]$/.test(String(preflight.machine.letter || ''))) return null
  if (!Array.isArray(preflight.localServices) || !plainObject(preflight.otherAgents)) return null
  if (!Array.isArray(preflight.otherAgents.codex) || !Array.isArray(preflight.otherAgents.claude)) return null
  if (!Number.isFinite(preflight.otherAgents.activeWindowMinutes) || preflight.otherAgents.activeWindowMinutes < 0) return null

  const services = []
  const ids = new Set()
  for (const [index, entry] of preflight.localServices.entries()) {
    if (!plainObject(entry)
      || cleanText(entry.name, 120) === null
      || cleanText(entry.detail, 240) === null
      || typeof entry.stale !== 'boolean'
      || !Number.isFinite(entry.ageSec)
      || entry.ageSec < 0) return null
    let id = serviceId(entry.name, index)
    let suffix = 2
    while (ids.has(id)) id = `${serviceId(entry.name, index).slice(0, 75)}-${suffix++}`
    ids.add(id)
    services.push({
      id,
      name: cleanText(entry.name, 120),
      state: serviceState(entry),
      observedAt: timestampFromAge(preflight.generatedAt, entry.ageSec * 1000),
      detail: terseDetail(cleanText(entry.detail, 240)),
    })
  }

  const maximumAgeMs = preflight.otherAgents.activeWindowMinutes * 60_000
  const activeSessions = [...preflight.otherAgents.codex, ...preflight.otherAgents.claude]
    .filter(session => plainObject(session) && Number.isFinite(session.ageMs) && session.ageMs >= 0 && session.ageMs <= maximumAgeMs)
    .length
  const letter = String(preflight.machine.letter).toUpperCase()
  return {
    computer: {
      id: `machine-${letter.toLowerCase()}`,
      label: `Machine ${letter}`,
      sourceKind: 'observed',
      observedAt: new Date(preflight.generatedAt).toISOString(),
      activeSessions,
      services,
    },
  }
}

function normalizeGraph(org, telemetry) {
  const agentIds = new Set(org.agents.map(agent => agent.id))
  return {
    revision: org.revision,
    contentHash: org.contentHash,
    nodes: org.agents.map(agent => ({
      id: agent.id,
      label: agent.displayName,
      role: agent.role,
      provider: agent.provider,
      enabled: agent.enabled,
      ...agentProjectionFields(agent.id, telemetry.registry, telemetry.tasks),
    })),
    edges: projectAgentRelationships(org.relationships, telemetry.registry, agentIds),
  }
}

await emitProjection('fleet', async at => {
  const reader = asSourceResult(loadReader(CANONICAL_ROOT, ORG_READER_PATH, 'agent-org-reader'), 'reader')
  const declared = asSourceResult(readJsonFile(CANONICAL_ROOT, ORG_PATH, 'agent-org'), 'declared')
  const preflight = asSourceResult(runJsonCli(LIVE_ROOT, PREFLIGHT_PATH, ['--json'], 'agent-preflight'), 'observed')
  const sources = [reader, declared, preflight]

  if (!reader.ok) return unavailableFrom('fleet', reader.reason, sources, at)
  if (!declared.ok) return unavailableFrom('fleet', declared.reason, sources, at)
  if (!preflight.ok) return unavailableFrom('fleet', preflight.reason, sources, at)
  if (typeof reader.value.normalizeOrg !== 'function') {
    return unavailableFrom('fleet', 'source-reader-failed', [{ ...reader, ok: false, reason: 'source-reader-failed' }, declared, preflight], at)
  }

  let org
  try {
    org = reader.value.normalizeOrg(declared.value)
  } catch {
    return unavailableFrom('fleet', 'source-malformed', [reader, { ...declared, ok: false, reason: 'source-malformed' }, preflight], at)
  }
  const observed = normalizePreflight(preflight.value)
  if (!observed) return unavailableFrom('fleet', 'source-malformed', [reader, declared, { ...preflight, ok: false, reason: 'source-malformed' }], at)

  const telemetry = loadAgentProjectionTelemetry(CANONICAL_ROOT)
  sources.push(...telemetry.results)

  return availableEnvelope('fleet', {
    computers: [observed.computer],
    graph: normalizeGraph(org, telemetry),
  }, sources.map(result => sourceFromResult(result, result.kind)), at)
})
