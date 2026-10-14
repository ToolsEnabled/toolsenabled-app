// Per-view read-source flags. Phase 2 keeps every simulation intact as the
// immediate rollback path; a missing preference means LIVE once that view's
// wiring has passed its gate battery.

export const LIVE_FLAGS_EVENT = 'mc:live-flags-changed'

export const LIVE_VIEW_FLAGS = Object.freeze([
  Object.freeze({ id: 'home', label: 'Home page', domain: 'coordinator' }),
  /* Computers ran simulated-by-default for a few hours on 2026-08-06; the
     owner overruled it the same day: "changing source is the worst way to
     fix the problem." The graph reads live and the RENDER absorbs the data
     shape instead — a flat swarm of subagents draws as the uniform grey
     spawned tree, culled to the density budget (see computers.js/graph.js).
     defaultLive stays supported for any future view that needs it. */
  Object.freeze({ id: 'computers', label: 'Computers page', domain: 'fleet' }),
  Object.freeze({ id: 'agent', label: 'Agent pages', domain: 'agents' }),
  Object.freeze({ id: 'metrics', label: 'Metrics page', domain: 'metrics' }),
  Object.freeze({ id: 'comms', label: 'Comms page', domain: 'ops' }),
  Object.freeze({ id: 'ledger', label: 'Ledger page', domain: 'ledger' }),
  Object.freeze({ id: 'research', label: 'Research page', domain: 'research' }),
])

const IDS = new Set(LIVE_VIEW_FLAGS.map(flag => flag.id))
const storageKey = id => `mc.live.${id}`
const defaultLive = id => LIVE_VIEW_FLAGS.find(flag => flag.id === id)?.defaultLive !== false

function assertView(id) {
  if (!IDS.has(id)) throw new TypeError(`Unknown live-view flag: ${id}`)
}

export function isLiveView(id) {
  assertView(id)
  try {
    const stored = localStorage.getItem(storageKey(id))
    if (stored === 'simulated' || stored === 'false') return false
    if (stored === 'live' || stored === 'true') return true
  } catch {}
  return defaultLive(id)
}

export function setLiveView(id, live) {
  assertView(id)
  const enabled = Boolean(live)
  try {
    // store only a non-default choice, so a view's default can evolve
    // without stale keys pinning every existing browser to the past
    if (enabled === defaultLive(id)) localStorage.removeItem(storageKey(id))
    else localStorage.setItem(storageKey(id), enabled ? 'live' : 'simulated')
  } catch {}
  window.dispatchEvent(new CustomEvent(LIVE_FLAGS_EVENT, {
    detail: Object.freeze({ view: id, live: enabled }),
  }))
  return enabled
}

export function liveViewFlag(id) {
  const definition = LIVE_VIEW_FLAGS.find(flag => flag.id === id)
  assertView(id)
  return Object.freeze({ ...definition, live: isLiveView(id) })
}
