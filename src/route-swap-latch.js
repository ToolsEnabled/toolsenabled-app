/* A ROUTE SWAP ALREADY ON ITS WAY (B38, found by the 1.0.48 soak).
 *
 * src/main.js render() hands the swap of a page to the browser's view
 * transition, and the browser calls that swap back a frame later, once it has
 * captured the outgoing page. Until then `current` still names the old page.
 * Anything that asked for a render in that gap mounted the SAME route a second
 * time: the first transition is skipped, but its swap is still called, and
 * then the second one is called too.
 *
 * MEASURED by the soak (tree-child-codex, c4 2/154 runs, c5 1/189): an agent's
 * agent.spawn moved the window to Computers, drainTreeNodeCommands polled every
 * 120 ms while the first swap waited for its frame, saw the old page still
 * current and rendered again. Computers mounted twice within half a second;
 * the first copy took the request and drew the new circle, and the second
 * mount retired it mid-start. The circle stayed "not started yet" and the
 * agent read "The operation stopped safely because of an internal error."
 * Every failing run had that two-mount pattern; 957 single-mount calls had no
 * failures.
 *
 * So render() asks this latch before building anything: a swap to this exact
 * address is already on its way, and it builds its view when it runs -- from
 * the state at that moment, not the state when it was asked for -- so a second
 * render would only mount the same page twice.
 *
 * TRUSTED FOR A BOUNDED TIME. The browser calls a transition's swap even when
 * it skips the transition, so a pending swap always lands; the bound is only
 * there so a swap that somehow never comes cannot hold every later render of
 * that address hostage. Past it, render() behaves exactly as it did before. */

export const ROUTE_SWAP_TRUST_MS = 1_500

export function createRouteSwapLatch({ now = () => Date.now(), trustMs = ROUTE_SWAP_TRUST_MS } = {}) {
  let pending = null
  return Object.freeze({
    /** A swap to `hash` has been handed to the browser and has not run yet. */
    begin(hash) {
      const swap = Object.freeze({ hash: String(hash), at: now() })
      pending = swap
      return swap
    },
    /** That swap ran (or can no longer run). Only the latest one is cleared. */
    end(swap) {
      if (pending === swap) pending = null
    },
    /** Would a render of `hash` now only repeat a swap already on its way? */
    covers(hash) {
      return pending !== null && pending.hash === String(hash) && now() - pending.at < trustMs
    },
  })
}
