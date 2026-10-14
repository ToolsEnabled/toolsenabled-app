/**
 * Produce the ops-channel projection from the canonical service registry and
 * the live tree's bounded agent-preflight CLI.  It deliberately does not read
 * state files, SQLite, durable memory, or a network message channel itself.
 */
import { join } from 'node:path'
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
  sourceFromResult,
  timestampFromAge,
  unavailable,
  unavailableEnvelope,
  terseDetail,
} from './gen-projection-lib.mjs'

const DOMAIN = 'ops'
const REGISTRY_READER_PATH = 'src/lib/service-registry.js'
const REGISTRY_PATH = 'config/service-registry.json'
const PREFLIGHT_PATH = 'tools/agent-preflight.js'

function registryFailureReason(error) {
  if (error?.code === 'SERVICE_REGISTRY_INVALID') return 'source-malformed'
  if (error?.code === 'SERVICE_REGISTRY_UNAVAILABLE' && /\bENOENT\b/.test(String(error.message))) return 'source-missing'
  return 'source-unreadable'
}

function cleanText(value, maximum) {
  if (typeof value !== 'string') return null
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return text.length > 0 && text.length <= maximum ? text : null
}

function declaredServices(registry) {
  if (!plainObject(registry) || !plainObject(registry.services)) return null
  const services = []
  for (const id of Object.keys(registry.services).sort()) {
    const service = registry.services[id]
    const displayName = cleanText(service?.displayName, 120)
    const transport = cleanText(service?.transport, 64)
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(id)
      || displayName === null
      || transport === null
      || !Number.isSafeInteger(service?.port)
      || service.port < 1
      || service.port > 65535
      || !['fixed', 'peer', 'self', 'loopback'].includes(service?.resolution)) return null
    // This is purposefully a five-field projection: no endpoint, vault-key,
    // machine, health, or descriptive metadata leaks into the public snapshot.
    services.push({ id, displayName, transport, port: service.port, resolution: service.resolution })
  }
  return services
}

function channelId(name, index, used) {
  const base = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 68)
  const stem = base ? `channel-${base}` : `channel-${index + 1}`
  let id = stem.slice(0, 79)
  let suffix = 2
  while (used.has(id)) id = `${stem.slice(0, 75)}-${suffix++}`
  used.add(id)
  return id
}

function channelState(entry) {
  if (entry.stale === true) return 'stale'
  const detail = entry.detail.toLowerCase()
  if (/\bconflict\b/.test(detail)) return 'conflict'
  if (/\bhealthy\b/.test(detail)) return 'healthy'
  return 'unknown'
}

function channelsObservation(preflight) {
  if (!Array.isArray(preflight.localServices)) return unavailable('source-malformed', preflight.generatedAt)
  const used = new Set()
  const channels = []
  for (const [index, entry] of preflight.localServices.entries()) {
    const name = cleanText(entry?.name, 120)
    const detail = cleanText(entry?.detail, 240)
    if (!plainObject(entry) || name === null || detail === null
      || typeof entry.stale !== 'boolean'
      || !Number.isFinite(entry.ageSec) || entry.ageSec < 0) {
      return unavailable('source-malformed', preflight.generatedAt)
    }
    channels.push({
      id: channelId(name, index, used),
      name,
      state: channelState(entry),
      observedAt: timestampFromAge(preflight.generatedAt, entry.ageSec * 1000),
      detail: terseDetail(detail),
    })
  }
  return available(channels, preflight.generatedAt)
}

function mcpObservation(preflight) {
  if (!plainObject(preflight.mcp) || !Array.isArray(preflight.mcp.live) || !Array.isArray(preflight.mcp.dead)) {
    return unavailable('source-malformed', preflight.generatedAt)
  }
  const live = preflight.mcp.live
  const dead = preflight.mcp.dead.map(entry => entry?.server)
  if (![...live, ...dead].every(name => cleanText(name, 80) !== null)) {
    return unavailable('source-malformed', preflight.generatedAt)
  }
  return available({ live: [...live], dead }, preflight.generatedAt)
}

function validPreflight(value) {
  return plainObject(value)
    && Number.isFinite(Date.parse(value.generatedAt))
    && Array.isArray(value.localServices)
    && plainObject(value.mcp)
}

await emitProjection(DOMAIN, async at => {
  const reader = loadReader(CANONICAL_ROOT, REGISTRY_READER_PATH, 'service-registry-reader')
  const registrySource = source({
    id: 'service-registry',
    kind: 'canonical-config',
    path: REGISTRY_PATH,
    ok: reader.ok,
    reason: reader.ok ? null : reader.reason,
  })
  const preflight = runJsonCli(LIVE_ROOT, PREFLIGHT_PATH, ['--json'], 'live-agent-preflight')
  const preflightSource = sourceFromResult(preflight, 'live-cli')
  /* THE MESSAGE PANE IS NOT THIS FILE'S TO FILL, AND SAYING SO IS THE FIX.
   *
   * THE OWNER'S FINDING: "i couldnt verify if the comms page is wired because i
   * couldnt get the agents to communicate." Both halves of that were true, and
   * this file is the second half. It runs at BUILD time, on the machine that
   * cuts the release, and everything it emits is frozen into
   * public/data/ops.json inside the application archive. A customer's agent
   * messages do not exist when this runs and the file cannot be rewritten
   * afterwards -- it is inside the asar. So no edit here could ever have made
   * that pane live, and `source-unreadable-safely` invited exactly the wrong
   * conclusion: it reads as "there is live data and we chose not to read it",
   * which sent the next reader looking for a reader to fix.
   *
   * The reason now names the real one. The live channel is read at RUNTIME by
   * the page itself (src/views/comms.js), from the engine's own durable message
   * fabric, and this projection deliberately stays a projection of the things
   * that ARE build-time facts: the declared services and the channels the
   * preflight CLI observed. The static path is untouched for everything that
   * legitimately still uses it. */
  const messagesSource = source({
    id: 'live-message-reader',
    kind: 'live-reader',
    path: 'state/',
    ok: false,
    reason: 'source-not-build-time',
  })
  const sources = [sourceFromResult(reader, 'canonical-reader'), registrySource, preflightSource, messagesSource]

  // The live CLI is the only allowed live-state reader.  If it is unreachable,
  // no partial declared-registry payload may be presented as current ops state.
  if (!preflight.ok) return unavailableEnvelope(DOMAIN, preflight.reason || 'source-unreachable', sources, at)
  if (!validPreflight(preflight.value)) {
    sources[2] = source({
      id: preflight.sourceId, kind: 'live-cli', path: preflight.path,
      ok: false, observedAt: preflight.observedAt, reason: 'source-malformed',
    })
    return unavailableEnvelope(DOMAIN, 'source-malformed', sources, at)
  }
  if (!reader.ok || typeof reader.value?.loadRegistry !== 'function') {
    return unavailableEnvelope(DOMAIN, reader.reason || 'source-reader-failed', sources, at)
  }

  let registry
  try {
    registry = reader.value.loadRegistry({
      registryPath: join(CANONICAL_ROOT, REGISTRY_PATH),
      noCache: true,
    })
  } catch (error) {
    const reason = registryFailureReason(error)
    sources[1] = source({
      id: 'service-registry', kind: 'canonical-config', path: REGISTRY_PATH,
      ok: false, reason,
    })
    return unavailableEnvelope(DOMAIN, reason, sources, at)
  }

  const services = declaredServices(registry)
  if (services === null) {
    sources[1] = source({
      id: 'service-registry', kind: 'canonical-config', path: REGISTRY_PATH,
      ok: false, reason: 'source-malformed',
    })
    return unavailableEnvelope(DOMAIN, 'source-malformed', sources, at)
  }

  return availableEnvelope(DOMAIN, {
    declaredServices: services,
    channels: channelsObservation(preflight.value),
    mcp: mcpObservation(preflight.value),
    /* Unavailable HERE because this is a build-time projection and a customer's
       messages do not exist yet; the page reads the live channel itself at run
       time. See the messagesSource note above -- the reason is the change, and
       it is the difference between "we declined to read it" and "this file is
       structurally the wrong place to read it from". */
    messages: unavailable('source-not-build-time'),
  }, sources, at)
})
