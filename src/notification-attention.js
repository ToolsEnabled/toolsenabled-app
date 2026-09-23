/* WHAT THIS WINDOW IS SHOWING, TOLD TO THE PART THAT DECIDES TO INTERRUPT YOU.
 *
 * THE PROBLEM THIS SOLVES, in one sentence: a notification must not fire while
 * the person is already looking at the thing it would tell them about, and
 * neither side of this program can answer that alone.
 *
 * The main process knows whether this application has FOCUS -- it is the only
 * thing that can, since a page cannot see the window manager. It does not know
 * which of twelve screens is in front of the person, or which agent session
 * that screen is watching. Only the page knows that. So the page says it, here,
 * and shell/agent-notifications.cjs puts the two halves together: it stays
 * silent only when this window has focus AND the session on screen is the
 * session the event came from. The full reasoning, including why neither half
 * is enough on its own, is written where the decision is made.
 *
 * IT REPORTS THE LIVE-SESSION RECORD AND NOTHING ELSE, because that record is
 * already exactly "the session this window has on screen". src/agent-session.js
 * publishes it on every change of state and clears it in its teardown -- "the
 * record goes with the surface", in its own words -- and a view is torn down
 * when the person navigates away. So leaving the agent page clears this by
 * construction, with no second idea of what is on screen to drift from the
 * first. There is deliberately no route name in the report: a second signal
 * would be a second answer to one question.
 *
 * SILENCE IS NEVER BOUGHT BY ACCIDENT. Every failure here -- no bridge, a
 * rejected call, a listener that throws -- leaves the main process with either
 * the previous report or none, and none means it notifies. An extra
 * notification is a nuisance; a missing one is the whole defect this feature
 * exists to remove.
 */

import { onLiveSession, readLiveSession } from './agent-session-registry.js'

function bridgeOf(bridge) {
  if (bridge !== undefined) return bridge
  return typeof window === 'undefined' ? null : window.mcNotify
}

function pageOf(page) {
  if (page !== undefined) return page
  return typeof window === 'undefined' ? null : window
}

/**
 * Start reporting, and return the function that stops.
 *
 * @param options.bridge     the exposed `window.mcNotify`, or null. Passed by
 *                           the tests; omitted in the product.
 * @param options.subscribe  the live-session subscription. Defaults to the real
 *                           registry.
 * @param options.read       the live-session reader. Defaults to the real one.
 * @param options.page       the object that says when this page is going away.
 *                           The window, in the product.
 *
 * Reports IMMEDIATELY as well as on every change, because a window that is
 * reloaded while a session is running would otherwise report nothing until the
 * session next changed state -- and "nothing on screen" is the answer that
 * delivers, so that window would interrupt somebody watching a transcript.
 *
 * IT STOPS ITSELF WHEN THE PAGE GOES, and that is why the returned function has
 * a caller in the product rather than only in a suite. src/main.js mounts this
 * once for the life of the window and never stops it -- correctly, because it
 * is a fact about the window and not about a route -- so if the teardown were
 * only a returned value, the branch that says "nothing is on screen any more"
 * would be reachable from nowhere a person could get to. `pagehide` is the
 * event a reload and a close both raise, and it is raised before the new page
 * exists, so the gap in which the main process still believes a transcript is
 * in front of somebody is closed from this side too.
 */
export function startAttentionReports({ bridge, page, subscribe = onLiveSession, read = readLiveSession } = {}) {
  const found = bridgeOf(bridge)
  if (!found || typeof found.watching !== 'function') return () => {}

  /* The last thing actually SENT, so a run of reports that say the same thing
     costs one call. onLiveSession fires on every phase change -- starting,
     open, working, stopping -- and all four are the same answer to the only
     question being asked here, which is which session is on screen. */
  let reported
  const send = () => {
    let record
    try { record = read() } catch { record = null }
    const sessionId = record && typeof record.sessionId === 'string' && record.sessionId ? record.sessionId : null
    if (sessionId === reported) return
    reported = sessionId
    try {
      /* Nothing waits on this: the page is telling, not asking. A rejection
         means the main process kept its previous answer, and its previous
         answer errs towards notifying. */
      Promise.resolve(found.watching({ sessionId })).catch(() => {})
    } catch { /* a bridge that throws on call is a bridge that heard nothing */ }
  }

  send()
  const unsubscribe = subscribe(send)

  const host = pageOf(page)
  /* IDEMPOTENT, because it now has two callers: the page going away, and
     whoever held the returned function. Two null reports would be harmless and
     one of them would be a lie about having just changed. */
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    if (typeof unsubscribe === 'function') unsubscribe()
    try { host?.removeEventListener?.('pagehide', stop) } catch { /* the page is already gone */ }
    /* THE WINDOW IS GOING, so nothing is on screen any more. Said out loud
       rather than left implied: a report left standing would keep the main
       process believing a transcript is in front of somebody who has closed
       it. The main process clears it too, when the window is destroyed; that
       one cannot be missed, and this one is earlier. */
    reported = undefined
    try { Promise.resolve(found.watching({ sessionId: null })).catch(() => {}) } catch { /* already gone */ }
  }

  try { host?.addEventListener?.('pagehide', stop) } catch { /* a page that takes no listeners still reports */ }
  return stop
}
