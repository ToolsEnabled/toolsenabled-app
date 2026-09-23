/* The preview's controller: mount the one simulated surface, run the clock,
 * keep the exits honest.
 *
 * WEAK MACHINES ARE THE TARGET, NOT THE EDGE CASE. There is no framework, no
 * bundler, no canvas and no chart library on this page — six ES modules and one
 * stylesheet, all same-origin, all static. The clock ticks once every 2.4s and
 * rebuilds only the surface that is on screen. `prefers-reduced-motion` stops
 * the clock entirely rather than merely shortening the transitions, because on
 * a slow machine the expensive part of a "subtle animation" is the rebuild
 * behind it, not the easing.
 */

import { mountSimulatedSurface, refusalElement } from './honesty.js'
import { buildWorld, advance } from './sim-data.js'
import { SURFACES } from './surfaces.js'
import { DECLARED, resolveExits, exitControl } from './exits.js'

const TICK_MS = 2400
const host = document.getElementById('preview-root')

const state = {
  tab: 'overview',
  selected: null,
  tick: 0,
  world: buildWorld(),
}
state.selected = state.world.agents[0].id

let surface = null
let timer = null

const ui = {
  get selected() { return state.selected },
  select(agentId) {
    state.selected = agentId
    state.tab = 'agent'
    render()
  },
  decide(requestId, decision) {
    const world = state.world
    const request = world.requests.find(r => r.id === requestId)
    if (!request || request.decision) return
    request.decision = decision
    world.ledger = [
      {
        id: `L-${String(world.ledger.length + 1).padStart(3, '0')}`,
        kind: 'decision',
        text: decision === 'approved'
          ? `Approved: ${request.what}`
          : `Refused: ${request.what}`,
        chain: chainFingerprint(world.ledger.length, request.id, decision),
      },
      ...world.ledger,
    ]
    render()
  },
}

/** A stand-in fingerprint, computed the same way every time from the entry's
 *  own contents. It is NOT a cryptographic chain and does not pretend to be —
 *  the product's ledger is; this is the shape of one, in a page with no crypto
 *  dependency to load on a slow connection. */
function chainFingerprint(index, requestId, decision) {
  let hash = 2166136261
  for (const ch of `${index}:${requestId}:${decision}`) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).slice(0, 4)
}

function renderBody(body) {
  const nav = document.createElement('nav')
  nav.className = 'pv-tabs'
  nav.setAttribute('aria-label', 'Preview surfaces')
  for (const entry of SURFACES) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'pv-tab'
    button.dataset.tab = entry.id
    button.textContent = entry.label
    if (entry.id === state.tab) {
      button.dataset.current = 'true'
      button.setAttribute('aria-current', 'page')
    }
    button.addEventListener('click', () => { state.tab = entry.id; render() })
    nav.appendChild(button)
  }
  body.appendChild(nav)

  const stage = document.createElement('div')
  stage.className = 'pv-stage'
  const entry = SURFACES.find(s => s.id === state.tab) || SURFACES[0]
  stage.appendChild(entry.build(state.world, ui))
  body.appendChild(stage)
}

let refused = false

function stopEverything() {
  refused = true
  if (timer) { clearInterval(timer); timer = null }
}

function render() {
  if (refused) return
  if (surface && typeof surface.stop === 'function') surface.stop()
  surface = mountSimulatedSurface(host, renderBody, { onRefuse: stopEverything })
  if (!surface.ok) stopEverything()
}

function startClock() {
  const reduced = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced) return
  timer = setInterval(() => {
    if (document.hidden) return
    state.tick += 1
    const next = advance(state.world, state.tick)
    // decisions and the record are the visitor's, not the clock's
    next.requests = state.world.requests
    next.ledger = state.world.ledger
    state.world = next
    render()
  }, TICK_MS)
}

async function mountExits() {
  const target = document.getElementById('preview-exits')
  if (!target) return
  let exits
  try {
    exits = await resolveExits(DECLARED)
  } catch (error) {
    target.appendChild(refusalElement([{ kind: 'exit-error', detail: String(error && error.message || error) }]))
    return
  }
  target.textContent = ''
  target.appendChild(exitControl({ ...exits.download, kind: 'download' }))
  target.appendChild(exitControl({ ...exits.subscribe, kind: 'subscribe' }))
}

/* A theme switch, because the product has one and a preview that cannot show
 * the black theme is not showing the product. Stored nowhere: this page writes
 * no storage of any kind, so a visitor leaves no trace on their own machine. */
function wireTheme() {
  const group = document.getElementById('preview-theme')
  if (!group) return
  for (const button of group.querySelectorAll('button[data-theme]')) {
    button.addEventListener('click', () => {
      document.documentElement.dataset.theme = button.dataset.theme
      for (const other of group.querySelectorAll('button[data-theme]')) delete other.dataset.current
      button.dataset.current = 'true'
    })
  }
}

render()
startClock()
wireTheme()
mountExits()

/* The browser driver in tools/preview-browser-drive.mjs reads these. They exist
 * so the lane's proof drives the page a visitor sees rather than a test double.
 *
 * READ-ONLY ON PURPOSE. There is no hook here for planting a liveness badge or
 * deleting the disclosure: the driver injects those from OUTSIDE the page, with
 * plain DOM calls, which is both a truer imitation of a careless future edit and
 * one less mutation surface in a file that ships to strangers. */
window.__preview = {
  audit: () => (surface && surface.refresh ? surface.refresh() : { ok: false, violations: [{ kind: 'no-surface', detail: 'not mounted' }] }),
  state: () => ({ tab: state.tab, tick: state.tick, selected: state.selected, refused }),
  goTo: id => { state.tab = id; render() },
}
