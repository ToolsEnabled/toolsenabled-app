/**
 * Status snapshot generator — run with `node tools/gen-status.mjs`.
 *
 * Reads a small, fixed set of READ-ONLY state files from the live
 * ToolsEnabled repo (never writes there) plus this machine's own OS uptime,
 * and writes one JSON snapshot consumed by src/live-status.js on the Home
 * page. This is a one-shot generator, not a server: nothing here starts,
 * stops, or restarts any process, and it never touches ports
 * 8787/8788/8790/8795. Re-run it by hand (or from a scheduler you control)
 * to refresh the numbers; the dashboard itself never invents data between
 * runs — it shows the age of what it has instead.
 *
 * Output is written to BOTH public/data/status.json (so a real `npm run
 * build` picks it up) and dist/data/status.json (so the already-running
 * `vite preview` on :4600 — a static file server — serves the refreshed
 * data on its very next request, with no rebuild and no restart).
 *
 * No credential, token, or secret VALUE is ever read or written by this
 * script. Every source file below is itself documented as containing none
 * (see e.g. ToolsEnabled/tools/bridge-status.js's own header).
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(here) // mission-control/

const liveRoot = process.env.MC_LIVE_ROOT?.trim()
if (!liveRoot) {
  console.error('MC_LIVE_ROOT is required; set it to the absolute path of the live ToolsEnabled checkout.')
  process.exit(1)
}

const TE_ROOT = resolve(liveRoot)
const HOST_LABEL = process.env.MC_HOST_LABEL?.trim() || os.hostname()

function readJson(relPath) {
  const abs = join(TE_ROOT, relPath)
  try {
    const raw = readFileSync(abs, 'utf8')
    const stat = statSync(abs)
    return { ok: true, data: JSON.parse(raw), mtimeMs: stat.mtimeMs, path: relPath }
  } catch (err) {
    return { ok: false, error: `${err.code || err.name || 'ERROR'}: could not read ${relPath}`, path: relPath }
  }
}

function readLines(relPath) {
  const abs = join(TE_ROOT, relPath)
  try {
    const raw = readFileSync(abs, 'utf8')
    const stat = statSync(abs)
    const lines = raw.split(/\r?\n/).filter(Boolean)
    return { ok: true, lines, mtimeMs: stat.mtimeMs, path: relPath }
  } catch (err) {
    return { ok: false, error: `${err.code || err.name || 'ERROR'}: could not read ${relPath}`, path: relPath }
  }
}

/* ---------------- health snapshot: state/health-snapshot.json ---------------- */
function buildHealth() {
  const r = readJson('state/health-snapshot.json')
  if (!r.ok) return { available: false, error: r.error, path: r.path }
  const j = r.data
  const subsystems = Object.entries(j.subsystems || {}).map(([id, v]) => ({
    id,
    state: v.state || 'UNKNOWN',
    reason: typeof v.reason === 'string' ? v.reason : null,
  }))
  const counts = { OK: 0, DOWN: 0, STOPPED: 0, UNKNOWN: 0, OTHER: 0 }
  for (const s of subsystems) {
    if (counts[s.state] !== undefined) counts[s.state] += 1
    else counts.OTHER += 1
  }
  return {
    available: true,
    path: r.path,
    observedAtMs: j.observedAtMs ?? null,
    observedAt: j.observedAtMs ? new Date(j.observedAtMs).toISOString() : null,
    subsystems,
    counts,
    total: subsystems.length,
  }
}

/* ---------------- cross-machine link: peer + inbound liveness receipts ---------------- */
function buildPeerLink() {
  const out = readJson('state/full-remote-access-peer-liveness.json')
  const inb = readJson('state/full-remote-access-inbound-liveness.json')
  const shape = (r) => {
    if (!r.ok) return { available: false, error: r.error, path: r.path }
    const j = r.data
    return {
      available: true,
      path: r.path,
      authenticatedAt: j.authenticatedAt ?? null,
      authenticatedAtMs: j.authenticatedAt ? Date.parse(j.authenticatedAt) : null,
      localHost: j.localHost ?? null,
      peerHost: j.peerHost ?? null,
    }
  }
  return { outbound: shape(out), inbound: shape(inb) }
}

/* ---------------- recent lane activity: state/agent-churn-ledger.jsonl ---------------- */
function buildRecentLanes(limit = 12) {
  const r = readLines('state/agent-churn-ledger.jsonl')
  if (!r.ok) return { available: false, error: r.error, path: r.path, items: [] }
  const tail = r.lines.slice(-limit).reverse() // newest first
  const items = []
  for (const line of tail) {
    try {
      const e = JSON.parse(line)
      const atIso = e.event === 'lane-end' ? e.endedAt : e.startedAt
      items.push({
        event: e.event ?? 'unknown',
        laneId: e.laneId ?? null,
        model: e.model ?? null,
        outcome: e.outcome ?? null,
        exitCode: typeof e.exitCode === 'number' ? e.exitCode : null,
        durationMs: typeof e.durationMs === 'number' ? e.durationMs : null,
        at: atIso ?? null,
        atMs: atIso ? Date.parse(atIso) : null,
      })
    } catch {
      // skip an unparsable line rather than fail the whole snapshot
    }
  }
  return { available: true, path: r.path, items }
}

/* ---------------- this host's own OS uptime (no ToolsEnabled dependency) ---------------- */
function buildHostUptime() {
  return { available: true, seconds: os.uptime(), hostLabel: HOST_LABEL }
}

const snapshot = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  generatedByHost: HOST_LABEL,
  sourceRepo: TE_ROOT,
  health: buildHealth(),
  peerLink: buildPeerLink(),
  recentLanes: buildRecentLanes(),
  hostUptime: buildHostUptime(),
}

const json = JSON.stringify(snapshot, null, 2)

for (const outDir of [join(ROOT, 'public', 'data'), join(ROOT, 'dist', 'data')]) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'status.json'), json, 'utf8')
}

console.log(`wrote status.json (generatedAt ${snapshot.generatedAt})`)
console.log(`  health: ${snapshot.health.available ? `${snapshot.health.total} subsystems, observed ${snapshot.health.observedAt}` : `UNAVAILABLE (${snapshot.health.error})`}`)
console.log(`  recentLanes: ${snapshot.recentLanes.available ? `${snapshot.recentLanes.items.length} items` : `UNAVAILABLE (${snapshot.recentLanes.error})`}`)
