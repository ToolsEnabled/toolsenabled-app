/* WHEN A SCREEN THAT NOBODY IS TOUCHING SHOULD ASK AGAIN.
 *
 * Two decisions live here, both pure functions of values, both about a window
 * that is sitting idle. They are in their own dependency-free module for the
 * same reason src/runtime-clock.js is: a cadence is arithmetic, and arithmetic
 * can be checked by calling it rather than by mounting a screen and waiting.
 *
 * MEASURED 2026-09-03, tools/renderer-idle-poll-inventory.mjs, ten virtual
 * minutes with nothing touched: the idle home window scheduled 124.30 wakes a
 * minute, and every one of the view's own 4.30 was a poll whose answer had not
 * moved since the window opened.
 *
 * ---------------------------------------------------------------------------
 * 1. THE BACK-OFF, AND WHAT IT DELIBERATELY DOES NOT TOUCH.
 *
 * A poll that has read the same answer three times running is not learning
 * anything, and each of these readings is not just a wake: it is a request to
 * the action bridge, which is a round trip to the engine on this machine. So
 * the wait doubles while the answer is still, and SNAPS BACK to the base the
 * instant the answer moves.
 *
 * The trade is stated rather than hidden: on a queue that has been provably
 * still for 140 seconds, the home screen's approvals ROW can be up to 80
 * seconds behind instead of 20. That row is a signpost. The screen that
 * actually shows and decides the queue -- src/ledger-prompt-queue.js -- polls at
 * two seconds and is NOT changed by any of this, and a decision made in this
 * window still reaches the row immediately through APPROVAL_OUTCOME_EVENT.
 * The back-off is on the signpost, never on the door.
 *
 * An UNREADABLE snapshot keeps its own, longer retry, unchanged: not knowing
 * is not the same as knowing nothing has changed, and a machine whose
 * capability layer is still starting should not be charged twenty seconds of
 * request forever.
 *
 * ---------------------------------------------------------------------------
 * 2. THE PHASE, SO THEY DO NOT ALL WAKE TOGETHER.
 *
 * A view starts its polls in one synchronous block, so every poll it owns is
 * born in phase. Two 45-second timers started three lines apart then fire in
 * the SAME task for the life of the view, and a 20 and a 45 collide every 180
 * seconds. Each collision is one longer stall rather than two short ones, on
 * the frame a person is most likely to be looking at.
 *
 * The offsets are FIXED PER POLL, not random. A random jitter would spread the
 * wakes too, but it would also make the measurement above unrepeatable, and an
 * idle-cost number that changes run to run cannot be defended. These are small
 * enough that no first reading moves by a noticeable amount, and they are not
 * multiples of the five-second common factor of the periods they separate, so
 * the separation holds for as long as the window is open rather than drifting
 * back into phase.
 */

/* ---- the approvals ladder ---- */

/** The base wait: what a queue that is moving gets. */
export const APPROVALS_POLL_MS = 20_000
/** The ceiling a still queue backs off to. */
export const APPROVALS_MAX_POLL_MS = 80_000
/** An unreadable snapshot: unchanged, and deliberately not part of the ladder. */
export const APPROVALS_RETRY_MS = 120_000

/**
 * How long to wait before reading the owner-prompt queue again.
 *
 * @param {object} reading
 * @param {boolean} reading.readable  did this read genuinely parse a queue
 * @param {boolean} reading.changed   is the parsed answer different from the last one
 * @param {number}  reading.waitMs    the wait this read was scheduled with
 * @returns {number} milliseconds until the next read
 */
export function nextApprovalsWaitMs({ readable, changed, waitMs = APPROVALS_POLL_MS } = {}) {
  if (!readable) return APPROVALS_RETRY_MS
  if (changed) return APPROVALS_POLL_MS
  /* A wait carried over from the unreadable branch -- or from anywhere else
     that is not a rung -- re-enters at the BASE rather than doubling 120s into
     four minutes. It is the conservative direction: the ladder is a claim
     about a run of identical readings, and a wait that was never on it is not
     evidence of one. */
  const onLadder = Number.isFinite(waitMs) && waitMs >= APPROVALS_POLL_MS && waitMs <= APPROVALS_MAX_POLL_MS
  if (!onLadder) return APPROVALS_POLL_MS
  return Math.min(waitMs * 2, APPROVALS_MAX_POLL_MS)
}

/** The two facts about a queue reading that the home row actually renders. */
export function approvalsReadingChanged(previous, next) {
  if (!previous || !next) return true
  return previous.readable !== next.readable
    || previous.count !== next.count
    || previous.undelivered !== next.undelivered
}

/* ---- the phase offsets ---- */

/* Named rather than derived, so the table in
   tools/renderer-idle-poll-inventory.mjs can be read against this list. Each is
   added ONCE, to the first wait after the view's own immediate first read, so
   nothing a person waits for at mount is delayed at all. */
const PHASE_MS = Object.freeze({
  'home:approvals': 0,
  'home:health': 7_000,
  'home:sample': 11_000,
})

/**
 * The one-off offset that keeps a poll out of phase with its neighbours.
 * An unknown name gets no offset: a caller that has not been thought about
 * here must not be silently delayed by an invented number.
 */
export function pollPhaseOffsetMs(name) {
  return Object.hasOwn(PHASE_MS, name) ? PHASE_MS[name] : 0
}

/** Every poll this module knows how to separate, for the tests to walk. */
export function phasedPollNames() {
  return Object.keys(PHASE_MS)
}
