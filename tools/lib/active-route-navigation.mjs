/* Forward-ring navigation for packaged UI drives.
 *
 * location.hash is the immediate navigation fact. The renderer stamps
 * body.dataset.route later, after the target view has mounted. A driver that
 * keeps pressing while it waits for the body stamp can pass the target and
 * report the following page instead. Stop pressing as soon as the target hash
 * arrives, then wait for both the route stamp and an active target page. */

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const activeCandidateBody = `node => Boolean(
      node?.isConnected
      && node.hidden !== true
      && !node.closest('[inert], [aria-hidden="true"]')
    )`

export function activeRouteStateExpression({ pageSelector }) {
  if (!pageSelector) throw new TypeError('pageSelector is required')
  return `(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(pageSelector)})]
    const active = (${activeCandidateBody})
    const activeCount = candidates.filter(active).length
    return {
      hash: location.hash,
      route: document.body.dataset.route || '',
      pageActive: activeCount > 0,
      inert: candidates.length > 0 && activeCount === 0,
      matchCount: candidates.length,
      activeCount,
    }
  })()`
}

export function activeRouteExpression({ hash, route, pageSelector }) {
  if (!hash || !route || !pageSelector) throw new TypeError('hash, route and pageSelector are required')
  return `(() => { try {
    if (location.hash !== ${JSON.stringify(hash)} || document.body.dataset.route !== ${JSON.stringify(route)}) return false
    const active = (${activeCandidateBody})
    return [...document.querySelectorAll(${JSON.stringify(pageSelector)})].some(active)
  } catch { return false } })()`
}

/* A panel is ready only when it belongs to the active copy of the requested
 * route. `descendantSelectors` is ordered: the first selector with an active
 * match wins, preserving callers' most-specific-first contracts. A forbidden
 * selector describes semantic state that must have disappeared, such as the
 * still-visible switch from the pre-remount compose panel. */
export function activeRouteDescendantExpression({
  hash,
  route,
  pageSelector,
  descendantSelectors,
  forbiddenVisibleSelector = '',
}) {
  if (!hash || !route || !pageSelector || !Array.isArray(descendantSelectors) || descendantSelectors.length === 0) {
    throw new TypeError('hash, route, pageSelector and descendantSelectors are required')
  }
  return `(() => { try {
    if (location.hash !== ${JSON.stringify(hash)} || document.body.dataset.route !== ${JSON.stringify(route)}) return false
    const active = (${activeCandidateBody})
    const page = [...document.querySelectorAll(${JSON.stringify(pageSelector)})].find(active)
    if (!page) return false
    let candidates = []
    for (const selector of ${JSON.stringify(descendantSelectors)}) {
      candidates = [...page.querySelectorAll(selector)].filter(active)
      if (candidates.length > 0) break
    }
    return candidates.some(candidate => {
      if (!${JSON.stringify(forbiddenVisibleSelector)}) return true
      return ![...candidate.querySelectorAll(${JSON.stringify(forbiddenVisibleSelector)})]
        .some(node => active(node) && !node.hidden)
    })
  } catch { return false } })()`
}

const ready = (state, { hash, route }) => state?.hash === hash
  && state?.route === route
  && state?.pageActive === true
  && state?.inert === false

export async function pressForwardToActiveRoute(window, {
  hash,
  route,
  pageSelector,
  maxSteps = 12,
  syncAttempts = 40,
  pollMs = 250,
  pause = delay,
} = {}) {
  if (!hash || !route || !pageSelector) throw new TypeError('hash, route and pageSelector are required')

  const expression = activeRouteStateExpression({ pageSelector })
  const seen = []
  let state = await window.evaluate(expression)

  for (let step = 0; step <= maxSteps; step += 1) {
    seen.push({ ...state })
    if (state?.hash === hash) {
      for (let attempt = 0; attempt < syncAttempts; attempt += 1) {
        if (ready(state, { hash, route })) return { ok: true, state, seen }
        await pause(pollMs)
        state = await window.evaluate(expression)
      }
      return { ok: false, reason: 'target-hash-never-became-active', state, seen }
    }

    if (step === maxSteps) break
    const clicked = await window.clickVisible('#nav-next')
    if (clicked !== 'clicked') {
      return { ok: false, reason: `forward-control-${clicked}`, state, seen }
    }
    await pause(pollMs)
    state = await window.evaluate(expression)
  }

  return { ok: false, reason: 'target-hash-never-reached', state, seen }
}

export const describeActiveRouteResult = result => JSON.stringify({
  ok: result?.ok === true,
  reason: result?.reason || null,
  hash: result?.state?.hash || '',
  route: result?.state?.route || '',
  pageActive: result?.state?.pageActive === true,
  inert: result?.state?.inert === true,
  seen: (result?.seen || []).map(state => `${state.hash || '(no hash)'}|${state.route || '(no route)'}|${state.pageActive ? 'active' : 'inactive'}`),
})
