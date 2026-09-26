/* WHEN THIS PAGE CAN DRAW, AND HOW TO SCHEDULE WORK THAT ASSUMED IT ALWAYS COULD.
 *
 * THE MEASUREMENT THIS FILE EXISTS FOR. A window the machine has covered --
 * minimised, behind another window, or spawned hidden -- gets NO rendering
 * frames from Chromium. `requestAnimationFrame` on such a page is not "later";
 * it is NEVER. The callback stays in the browser's ScriptedAnimationController,
 * and the callback's scope holds whatever it closed over -- typically the view
 * that scheduled it, which is why a retired page could not be collected.
 *
 * Read off a staged packaged build with heap-snapshot retainer paths and a
 * pending-frame census (tools/performance-budget-qa.mjs --snapshot / --census,
 * tools/heap-snapshot-retainers.mjs), three laps of the ring on a covered
 * window: pending frames 9 -> 18 -> 27, exactly +9 per lap, and the snapshot
 * walks a retained view back through
 *   ScriptedAnimationController -> HeapVector<FrameCallback> -> V8FrameCallback
 *   -> the callback's closure -> the view root
 * to the GC root. Five call sites accounted for all nine.
 *
 * WHAT THE WORK ACTUALLY IS, at every one of those sites: pin a scroll region
 * to its bottom, or draw once. It is the RESTING STATE of something that just
 * changed, deferred a frame only so it lands after layout and paint. On a page
 * that will not paint, the honest translation of "after the next paint" is
 * "now" -- nothing is being animated, so nothing is lost by doing it, and the
 * scroll position and the canvas are correct the instant the window comes back.
 *
 * SO THIS IS A GUARD ON WHEN MOTION STARTS, NEVER A REMOVAL OF IT. A page that
 * can draw goes through requestAnimationFrame exactly as before, handle and
 * all. Only the frameless page takes the immediate path.
 *
 * NOT FOR SELF-RE-ARMING LOOPS. A loop that re-arms itself from inside its own
 * callback must not be routed through here: the immediate path would recurse
 * without end. Loops are already correct on a frameless page -- they simply
 * stop -- and each one cancels its handle in its own teardown. Every site that
 * uses onNextFrame is a ONE-SHOT settle, and the pending-frame census is what
 * says which is which.
 */

/** True when the page is in a state where a frame will actually be serviced. */
export const pageCanDraw = () => document.visibilityState !== 'hidden'

/**
 * Run `work` after the next frame -- or immediately, if there will not be one.
 * Returns the frame handle when one was requested, and 0 when the work has
 * already been done, so a caller that cancels handles can keep doing so.
 */
export function onNextFrame(work) {
  if (!pageCanDraw()) {
    /* THE LAYOUT IS FLUSHED FIRST, so "immediately" means the same thing the
       frame meant: AFTER layout, not merely later. Every site here reads
       geometry that code in the same tick has just invalidated (a message was
       appended, a pane was resized), and pinning to a stale scrollHeight would
       leave a person returning to an uncovered window looking at a log that is
       NOT at the bottom -- a silent behaviour change dressed up as a leak fix.
       Reading a layout property would force this flush by itself; it is
       written out so the guarantee belongs to this function rather than to
       each caller happening to read the right property. */
    void document.documentElement.offsetHeight
    work()
    return 0
  }
  return requestAnimationFrame(work)
}
