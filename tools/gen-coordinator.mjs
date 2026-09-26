/** Generate the coordinator/home-thread projection from read-only sources. */
import {
  CANONICAL_ROOT,
  LIVE_ROOT,
  available,
  availableEnvelope,
  emitProjection,
  loadReader,
  readJsonFile,
  runJsonCli,
  source,
  sourceFromResult,
  timestampFromAge,
  unavailable,
  unavailableEnvelope,
} from './gen-projection-lib.mjs'

const DOMAIN = 'coordinator'

await emitProjection(DOMAIN, async at => {
  const reader = loadReader(CANONICAL_ROOT, 'src/lib/agent-org.js', 'canonical-agent-org-reader')
  const config = readJsonFile(CANONICAL_ROOT, 'config/agent-org.json', 'canonical-agent-org')
  const sources = [sourceFromResult(reader, 'canonical-reader'), sourceFromResult(config, 'canonical-config')]

  if (!reader.ok || !config.ok || typeof reader.value?.normalizeOrg !== 'function') {
    return unavailableEnvelope(DOMAIN, !config.ok ? config.reason : 'source-reader-failed', sources, at)
  }

  let org
  try {
    org = reader.value.normalizeOrg(config.value)
  } catch {
    sources[1] = source({
      id: config.sourceId,
      kind: 'canonical-config',
      path: config.path,
      ok: false,
      reason: 'source-malformed',
    })
    return unavailableEnvelope(DOMAIN, 'source-malformed', sources, at)
  }

  const controller = org.agents.find(agent => agent.role === 'controller')
  if (!controller) return unavailableEnvelope(DOMAIN, 'source-malformed', sources, at)

  const preflight = runJsonCli(LIVE_ROOT, 'tools/agent-preflight.js', ['--json'], 'live-agent-preflight')
  let preflightSource = sourceFromResult(preflight, 'live-cli')
  sources.push(source({
    id: 'live-coordinator-memory',
    kind: 'live-reader',
    path: 'state/toolsenabled.sqlite3',
    ok: false,
    reason: 'source-unreadable-safely',
  }))

  let sessions = unavailable(preflight.reason || 'source-unreachable')
  if (preflight.ok) {
    const reference = preflight.value?.generatedAt
    const rows = preflight.value?.otherAgents?.claude
    if (!Number.isFinite(Date.parse(reference)) || !Array.isArray(rows)) {
      sessions = unavailable('source-malformed', preflight.observedAt)
      preflightSource = source({
        id: preflight.sourceId, kind: 'live-cli', path: preflight.path,
        ok: false, observedAt: preflight.observedAt, reason: 'source-malformed',
      })
    } else {
      sessions = available(rows.map(row => ({
        sessionId: String(row.id || ''),
        updatedAt: timestampFromAge(reference, Number(row.ageMs)),
      })).filter(row => /^[A-Za-z0-9-]{8,80}$/.test(row.sessionId)), preflight.observedAt)
    }
  }
  sources.push(preflightSource)

  return availableEnvelope(DOMAIN, {
    identity: {
      id: controller.id,
      displayName: controller.displayName,
      provider: controller.provider,
      enabled: controller.enabled,
    },
    sessions,
    thread: unavailable('source-unreadable-safely'),
  }, sources, at)
})
