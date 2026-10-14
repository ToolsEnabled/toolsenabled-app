/* THE PREVIEW CANNOT RENDER A LIE. THIS FILE IS WHY.
 *
 * The website preview shows a SIMULATION of ToolsEnabled. Machine B raised the
 * exact defect this module exists to make impossible: a green "live" indicator
 * painted over seeded data, which makes fabricated activity look like a real
 * fleet doing real work. A comment saying "this is simulated" does not stop
 * that. A label somebody remembers to add does not stop it either — the whole
 * point of the defect is that somebody forgot.
 *
 * So the honesty marking here is a RENDERING-LEVEL PROPERTY, in four parts,
 * each of which fails the SURFACE rather than logging a warning:
 *
 *   1. THERE IS NO LIVE VOCABULARY TO DRAW FROM.
 *      `stateChip()` is the only way to paint an agent/host state, and it
 *      accepts ids from `SIMULATED_STATES` only — every id in that frozen set
 *      begins `simulated-`. There is no `active`, no `online`, no `live`. A
 *      renderer cannot paint a live state because the function that paints
 *      states has no such state. `stateChip('live')` throws.
 *
 *   2. UNMARKED DATA CANNOT APPEAR.
 *      `simValue()` is the only way to write a datum into the surface, and it
 *      stamps `data-sim="1"`. `auditSurface()` walks the data region and any
 *      text that is not inside a `data-sim="1"` element is a VIOLATION. Hand
 *      -writing a number into the markup breaks the page instead of shipping.
 *
 *   3. A LIVENESS CLAIM ANYWHERE IN THE SURFACE REFUSES THE SURFACE.
 *      Text matching `LIVENESS_CLAIM`, or any element carrying a liveness
 *      class/attribute from `LIVENESS_MARKERS`, replaces the whole preview
 *      with a named refusal. The single exception is the disclosure banner,
 *      whose text is asserted to be EXACTLY `DISCLOSURE` — so the one node
 *      allowed to say the word is the one that says nothing is live.
 *
 *   4. THE MARKING CANNOT BE REMOVED AT RUNTIME.
 *      A MutationObserver re-audits the surface on every change. Deleting the
 *      banner, or injecting a badge after mount, produces the same refusal as
 *      authoring one. This is what makes it a control rather than a checklist.
 *
 * AND ONE MORE, WHICH IS THE OWNER'S SHAPE FOR THIS PREVIEW:
 *
 *   5. THE PREVIEW MAY NOT PREVIEW A PAID CAPABILITY.
 *      "no need for preview of paid services" (owner, 2026-08-11). `PAID_GATED`
 *      mirrors the engine's closed set (src/lib/entitlement.js GATED_CAPABILITIES
 *      — today exactly one member, `hosted-relay`). `assertUnpaid()` refuses any
 *      capability whose id is in it, and refuses an id it does not recognise at
 *      all, because an unknown capability is an absence and absence fails closed.
 *
 * NOTHING HERE TOUCHES A NETWORK, A CREDENTIAL, OR A FILE. The preview has no
 * backend by construction: every datum is generated in `sim-data.js` from a
 * fixed seed.
 */

/** The exact sentence the disclosure banner must carry. Asserted, not
 *  suggested. Three elements, each required by the legal lane's clearance of
 *  this simulation (legal/reports/R-009-simulation-disclosure.md §2, via
 *  reports/lanes/preview-disclosure-two-missing-elements.md):
 *    (a) simulated, generated in the browser — no real activity anywhere;
 *    (b) WHAT it simulates: the free local product — the sentence that stops
 *        a visitor reading the simulation's fluency as a property of the
 *        hosted service;
 *    (c) the clock: ~7 wall seconds render a simulated minute, so the
 *        timeline-compression note applies and is said. */
export const DISCLOSURE =
  'Simulated preview of the free local product, with the timeline compressed. '
  + 'Nothing on this page is live, nothing is running on any computer, '
  + 'and every value below was generated in your browser from a fixed seed.'

/** The complete state vocabulary the preview is able to paint. Frozen, and every
 *  id is prefixed `simulated-` so that no caller can accidentally spell a real one. */
export const SIMULATED_STATES = Object.freeze({
  'simulated-spawning': Object.freeze({ id: 'simulated-spawning', label: 'simulated · spawning' }),
  'simulated-working': Object.freeze({ id: 'simulated-working', label: 'simulated · working' }),
  'simulated-waiting': Object.freeze({ id: 'simulated-waiting', label: 'simulated · waiting' }),
  'simulated-blocked': Object.freeze({ id: 'simulated-blocked', label: 'simulated · blocked' }),
  'simulated-finished': Object.freeze({ id: 'simulated-finished', label: 'simulated · finished' }),
})

/** Capability ids a licence may gate, mirrored from the engine's closed set.
 *  KEEP IN SYNC with src/lib/entitlement.js GATED_CAPABILITIES in the engine
 *  tree; tools/test/preview-honesty.test.mjs fails if this list is empty. */
export const PAID_GATED = Object.freeze(['hosted-relay'])

/** Words that assert the data is real. Word-boundaried on purpose: "alive",
 *  "delivered" and "clive" must not trip it, "live" and "LIVE" must. */
export const LIVENESS_CLAIM =
  /\b(live|real[\s-]?time|realtime|connected|online|streaming now|actually running|right now)\b/i

/** Classes and attributes that MEAN liveness even with no text at all — this is
 *  the green dot Machine B found. A dot has no words; it still makes a claim. */
export const LIVENESS_MARKERS = Object.freeze([
  '.live', '.is-live', '.live-dot', '.dot-live', '.online', '.is-online',
  '.realtime', '.status-live', '.badge-live', '.pulse-live',
  '[data-live]', '[data-status="live"]', '[data-status="online"]',
  '[data-state="live"]', '[data-realtime]', '[aria-live="live"]',
])

const DISCLOSURE_ATTR = 'data-sim-disclosure'
const DATA_ATTR = 'data-sim'
const REGION_CLASS = 'sim-data-region'

/* ------------------------------------------------------------------ *
 * 1. STATE — the only vocabulary that exists
 * ------------------------------------------------------------------ */

/**
 * Paint a state chip. Throws on any id outside SIMULATED_STATES, which is what
 * makes "paint a live badge" unreachable rather than discouraged.
 */
export function stateChip(stateId) {
  const state = Object.hasOwn(SIMULATED_STATES, stateId) ? SIMULATED_STATES[stateId] : null
  if (!state) {
    throw new TypeError(
      `preview: "${stateId}" is not a simulated state. The preview can only paint `
      + `simulated states (${Object.keys(SIMULATED_STATES).join(', ')}); there is no `
      + 'vocabulary here for a real one.',
    )
  }
  const el = document.createElement('span')
  el.className = 'sim-state'
  el.dataset.simState = state.id
  el.setAttribute(DATA_ATTR, '1')
  el.textContent = state.label
  return el
}

/* ------------------------------------------------------------------ *
 * 2. DATA — unmarked data cannot appear
 * ------------------------------------------------------------------ */

/**
 * The only way to write a datum into the preview. Everything a visitor could
 * mistake for a reading — a count, a name, a duration, a line of transcript —
 * goes through here and comes back stamped.
 */
export function simValue(text, { tag = 'span', className = '' } = {}) {
  const el = document.createElement(tag)
  if (className) el.className = className
  el.setAttribute(DATA_ATTR, '1')
  el.textContent = String(text)
  return el
}

/** A container whose contents are audited as data. Chrome (headings, buttons,
 *  captions) lives outside it; anything a visitor reads as a reading lives in. */
export function dataRegion({ tag = 'div', className = '' } = {}) {
  const el = document.createElement(tag)
  el.className = `${REGION_CLASS} ${className}`.trim()
  return el
}

/* ------------------------------------------------------------------ *
 * 5. PAID CAPABILITIES — absence fails closed
 * ------------------------------------------------------------------ */

/**
 * Refuse to preview a paid capability, and refuse an unrecognised one.
 * `known` is the preview's own closed list of capability ids it is allowed to
 * show. An id in neither list is an ABSENCE, and absence is withheld and named
 * rather than shown.
 */
export function assertUnpaid(capabilityId, known) {
  if (PAID_GATED.includes(capabilityId)) {
    return {
      ok: false,
      reason: `"${capabilityId}" is a planned hosted capability. Subscriptions are not open yet, and the product is free meanwhile.`,
    }
  }
  if (!Array.isArray(known) || !known.includes(capabilityId)) {
    return {
      ok: false,
      reason: `"${capabilityId}" is not a declared preview capability, so it is withheld. `
        + 'An undeclared capability is an absence, and this preview does not read absence as permission.',
    }
  }
  return { ok: true, reason: null }
}

/* ------------------------------------------------------------------ *
 * 3 + 4. THE AUDIT AND THE SURFACE THAT ENFORCES IT
 * ------------------------------------------------------------------ */

/** Collect every violation in a mounted surface. Pure; no DOM mutation. */
export function auditSurface(root) {
  const violations = []
  if (!root || root.nodeType !== 1) {
    return [{ kind: 'no-surface', detail: 'there is no surface to audit' }]
  }
  if (root.getAttribute('data-simulated') !== 'true') {
    violations.push({ kind: 'unmarked-surface', detail: 'the surface lost its data-simulated="true" mark' })
  }

  const banner = root.querySelector(`[${DISCLOSURE_ATTR}="1"]`)
  if (!banner) {
    violations.push({ kind: 'no-disclosure', detail: 'the simulated-preview disclosure is missing' })
  } else if (normalise(banner.textContent) !== normalise(DISCLOSURE)) {
    violations.push({ kind: 'altered-disclosure', detail: 'the disclosure text was altered' })
  }

  for (const selector of LIVENESS_MARKERS) {
    let hits = []
    try { hits = Array.from(root.querySelectorAll(selector)) } catch { /* selector unsupported here */ }
    for (const hit of hits) {
      if (banner && banner.contains(hit)) continue
      violations.push({ kind: 'liveness-marker', detail: `an element matching ${selector} claims the data is live` })
    }
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue || ''
    if (!text.trim()) continue
    if (banner && banner.contains(node)) continue
    const claim = LIVENESS_CLAIM.exec(text)
    if (claim) {
      violations.push({ kind: 'liveness-text', detail: `the word "${claim[1]}" asserts this simulated data is real` })
      continue
    }
    const region = closestRegion(node.parentElement)
    if (region && !markedAncestor(node.parentElement, region)) {
      violations.push({
        kind: 'unmarked-data',
        detail: `"${text.trim().slice(0, 40)}" is inside a data region but was not written through simValue()`,
      })
    }
  }
  return violations
}

/**
 * Mount the preview's ONLY surface. `render(body)` fills it. If the surface
 * does not pass `auditSurface`, it is not shown at all: the host is replaced
 * with a refusal that names what was wrong. There is no partial state where a
 * visitor sees fabricated activity plus a warning — the fabricated activity is
 * what gets withheld.
 *
 * Returns { ok, root, violations, refresh, stop }.
 */
export function mountSimulatedSurface(host, render, { observe = true, onRefuse = null } = {}) {
  if (!host || host.nodeType !== 1) throw new TypeError('preview: mount host is required')
  host.textContent = ''

  const root = document.createElement('div')
  root.className = 'sim-surface'
  root.setAttribute('data-simulated', 'true')

  const banner = document.createElement('p')
  banner.className = 'sim-banner'
  banner.setAttribute(DISCLOSURE_ATTR, '1')
  banner.textContent = DISCLOSURE
  root.appendChild(banner)

  const body = document.createElement('div')
  body.className = 'sim-body'
  root.appendChild(body)
  host.appendChild(root)

  let observer = null
  let stopped = false
  let queued = false

  const enforce = () => {
    const violations = auditSurface(root)
    if (violations.length === 0) return { ok: true, violations }
    if (observer) { observer.disconnect(); observer = null }
    stopped = true
    host.textContent = ''
    host.appendChild(refusalElement(violations))
    // The refusal is TERMINAL, and the caller is told so it can stop its clock.
    // Without this the next scheduled repaint would rebuild the surface and the
    // refusal would flicker past — a control that undoes itself is not a control.
    if (typeof onRefuse === 'function') { try { onRefuse(violations) } catch { /* caller's problem, not the guard's */ } }
    return { ok: false, violations }
  }

  try {
    render(body)
  } catch (error) {
    host.textContent = ''
    host.appendChild(refusalElement([{ kind: 'render-error', detail: String(error && error.message || error) }]))
    return { ok: false, root: null, violations: [{ kind: 'render-error', detail: String(error) }], refresh: () => {}, stop: () => {} }
  }

  const first = enforce()
  if (!first.ok) {
    return { ok: false, root: null, violations: first.violations, refresh: () => first, stop: () => {} }
  }

  if (observe && typeof MutationObserver === 'function') {
    observer = new MutationObserver(() => {
      if (stopped || queued) return
      queued = true
      // one microtask of coalescing: a surface update touches many nodes and
      // auditing each mutation record separately is the weak-PC cost this
      // preview is not allowed to spend.
      Promise.resolve().then(() => { queued = false; if (!stopped) enforce() })
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true })
  }

  return {
    ok: true,
    root,
    violations: [],
    refresh: enforce,
    stop: () => { stopped = true; if (observer) { observer.disconnect(); observer = null } },
  }
}

/** The refusal a visitor sees instead of the simulation. Names the defect. */
export function refusalElement(violations) {
  const box = document.createElement('div')
  box.className = 'sim-refusal'
  box.setAttribute('role', 'alert')
  const head = document.createElement('h2')
  head.textContent = 'The preview refused to render.'
  const why = document.createElement('p')
  why.textContent =
    'Something in this preview asserted that simulated data is real. Rather than show you '
    + 'invented activity dressed as a working fleet, the preview withheld all of it.'
  const list = document.createElement('ul')
  for (const violation of violations.slice(0, 8)) {
    const li = document.createElement('li')
    li.textContent = `${violation.kind}: ${violation.detail}`
    list.appendChild(li)
  }
  box.append(head, why, list)
  return box
}

function normalise(text) { return String(text || '').replace(/\s+/g, ' ').trim() }

function closestRegion(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node.classList && node.classList.contains(REGION_CLASS)) return node
  }
  return null
}

function markedAncestor(el, stopAt) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node.getAttribute && node.getAttribute(DATA_ATTR) === '1') return true
    if (node === stopAt) return false
  }
  return false
}
