/* WHEN A TURN ENDS, WHO GETS THE NEXT ONE: THE PERSON, OR THE TREE.
 *
 * THE DEFECT THIS EXISTS TO REMOVE, MEASURED 2026-09-03. Four messages the
 * owner typed at 03:53:21, 03:57:17, 03:58:34 and 04:08:35 never reached the
 * Controller's engine transcript and never reached the owner-capture spool.
 * Nothing refused them and nothing dropped them: they were OUTRANKED, over and
 * over, by the computer's own chatter.
 *
 * HOW A PERSON LOSES A RACE THEY WERE NEVER TOLD THEY WERE IN. Two senders want
 * the same session, and each is correct on its own:
 *
 *   the renderer   holds the person's queued words (src/session-outbox.js) and
 *                  sends exactly one when it hears turn_completed -- an event,
 *                  then an IPC round trip, then sendTurn().
 *   the tree pump  holds agent_comms traffic and offers it on a timer, every
 *                  TREE_POLL_MS, taking the session the instant it reads idle.
 *
 * sendTurn() allows one turn at a time and refuses the loser by name
 * (AGENT_TURN_ACTIVE). That refusal is right and stays. What was wrong is that
 * the loser was always the same one: this tree exchanged about 95 messages, so
 * every boundary the person's drain arrived at had already been taken, its send
 * was refused, its words went back to the front of the queue, and the next
 * boundary went the same way. Machine chatter starved a person indefinitely.
 *
 * THE RULE. A person waiting behind machine chatter is the defect, so the
 * person's message wins the boundary and the tree waits. This module is that
 * one decision, alone and pure, so it can be tested by calling it with values
 * rather than by reading the pump.
 *
 * WHAT IT DOES NOT DO. It never lets a turn overlap another (turnActive still
 * refuses first), never lets anything skip a queue, never sends anything and
 * never widens what a caller may reach. Its whole power is to make the tree
 * pump WAIT. The person's own send goes through the identical sendTurn() path
 * with the identical checks it always did.
 *
 * THE THIRD LOST RACE, FOUND 2026-09-04. `boundaryAt` is stamped on EVERY
 * turn_completed, including the tree's own agent-originated turns. A circle
 * that starts its next turn less than personYieldMs after finishing the last
 * one therefore never presents a boundary on which turnActive is false AND
 * the window opened by the LATEST boundary has expired -- each restamp opens
 * a fresh window before the previous one could close. Measured against the
 * shipped 1200 ms poll and 20 s turns: at gaps of 1300 ms and below, a
 * delivered message was never taken inside a ten-minute horizon; the decision
 * alternated TREE_TURN_ACTIVE and PERSON_FIRST forever. The per-boundary
 * window is correct and stays -- it is what lets a person's drain win a
 * boundary it has not yet reached sendTurn() for. What was missing is a
 * SEPARATE clock that does not reset on every restamp: `queuedSince`, stamped
 * once when the tree's queue goes from empty to non-empty and cleared once it
 * drains, names how long THIS batch of tree traffic has been waiting,
 * independent of how many fresh boundaries the person's window has opened and
 * closed in the meantime. Past MAX_YIELD_BOUNDARIES boundaries' worth of that
 * clock, the tree takes its turn regardless -- never overlapping a turn
 * (turnActive still refuses first, unconditionally), but no longer yielding
 * forever to a person who was never actually there. The bound is a multiple
 * of personYieldMs, not an invented number, for the same reason personYieldMs
 * itself is: a real drain resolves in about one interval (see above), and the
 * ordinary race already grants a genuine person at most two machine messages
 * of head start (see the 95-message test). Three boundaries' worth of margin
 * covers a slow IPC round trip without giving the restamping defect anywhere
 * to hide.
 *
 * WHY THE RESERVATION IS TRUSTWORTHY. `personWaitingSince` is set from exactly
 * one event inside the host: a turn whose origin is 'person' was refused with
 * AGENT_TURN_ACTIVE. `origin: 'person'` is said in exactly one place in this
 * product -- the agent:send command in shell/agent-command-surface.cjs, whose
 * two principals ARE the person (the window at the keyboard, the signed-in
 * relay). An agent cannot say it; the tree pump tags its own turns 'agent'. So
 * no agent can create a reservation, and the worst a stale one can do is make
 * the tree pump wait one poll interval.
 *
 * THE SECOND LOST RACE, FOUND 2026-09-04. The reservation above is recorded
 * only when a person's send REACHES sendTurn() and is refused. Most queued
 * words never do: the renderer asks nodeBusy() first and, at a busy circle,
 * puts them straight into src/session-outbox.js without touching the host
 * (src/views/computers.js: treeCardSend's busy branch, and the busy composer's
 * queue.add -> queueForSession). So at the first boundary after the person
 * typed there is no reservation, the pump takes it, the drain is refused, and
 * only then is one recorded -- one whole machine turn late, which on a Claude
 * worker is minutes. The rule "the person's message wins the boundary" was
 * therefore only true from the SECOND boundary on. So the boundary itself now
 * opens the window: after any turn_completed the tree stands aside for one
 * poll interval whether or not anybody was refused, which is exactly the span
 * the renderer's drain needs and no more. A reservation still opens a window
 * of its own, for the one shape the stamp cannot cover (a session that has
 * never completed a turn).
 *
 * THE YIELD IS BOUNDED, AND THE BOUND IS NOT AN INVENTED NUMBER. The pump hands
 * `personYieldMs` in as its own TREE_POLL_MS -- the delay the tree courier
 * already imposes on itself between offers. A renderer that is alive answers a
 * turn_completed in the time an IPC round trip takes, far inside one interval;
 * a renderer that has gone away cannot hold the tree past one interval per
 * boundary. NOT MEASURED IN THIS LANE: the renderer's turn_completed -> IPC ->
 * sendTurn round trip. It was not measured because measuring it means driving
 * the running app, and this lane must not disturb it. The yield is therefore a
 * bound with a stated reason, not a measurement.
 */
'use strict'

/* Every answer this module can give, so a caller logs a reason rather than a
   boolean and a test asserts the reason it meant. */
const TREE_TURN_REASONS = Object.freeze({
  QUEUE_EMPTY: 'TREE_QUEUE_EMPTY',
  TURN_ACTIVE: 'TREE_TURN_ACTIVE',
  PERSON_FIRST: 'PERSON_FIRST',
  TAKE: 'TREE_TURN',
  CLOCK_UNUSABLE: 'TREE_PRIORITY_CLOCK_UNUSABLE',
  YIELD_BOUND: 'TREE_YIELD_BOUND_REACHED',
})

/* How many boundaries' worth of personYieldMs a single batch of queued tree
   traffic may be made to wait, at most. See THE THIRD LOST RACE above. */
const MAX_YIELD_BOUNDARIES = 3

const NO_TAKE = (reason) => Object.freeze({ take: false, reason })

/* A timestamp this module can reason about, or null. A field that is absent,
   NaN, negative or not a number is "no reservation was recorded" -- which is
   different from "a reservation was recorded at time zero", and merging those
   two is the answer-merging this codebase keeps re-finding. Absence reads as
   absence and lets the tree through; it never invents a reservation. */
function instantOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Should the tree pump take this boundary for its own queued agent traffic?
 *
 * @param {object} state
 * @param {number} state.now                 Date.now() at the moment of asking.
 * @param {number} state.queuedTreeTurns     how many agent_comms turns wait.
 * @param {boolean} state.turnActive         a turn is already under way.
 * @param {number|null} state.personWaitingSince  when a person's send was last
 *        refused with AGENT_TURN_ACTIVE on this session; null once one lands.
 * @param {number|null} state.boundaryAt     when the last turn completed; on
 *        its own it opens the drain's window for personYieldMs.
 * @param {number} state.personYieldMs       how long the renderer's drain is
 *        given a fresh boundary uncontested.
 * @param {number|null} [state.queuedSince]  when the CURRENT batch of tree
 *        traffic went from an empty queue to a non-empty one; unlike
 *        boundaryAt this does not reset on every turn_completed, so it bounds
 *        the total wait even when the person's per-boundary window keeps
 *        reopening. Absent reads as no bound to apply, same as the other
 *        clocks.
 * @returns {{take: boolean, reason: string}} frozen.
 */
function treeTurnDecision({
  now,
  queuedTreeTurns,
  turnActive,
  personWaitingSince,
  boundaryAt,
  personYieldMs,
  queuedSince,
} = {}) {
  /* Cheapest first, and it is also the common case: no tree traffic waiting
     means there is no question to answer and no person to hold anything for. */
  if (!Number.isFinite(queuedTreeTurns) || queuedTreeTurns <= 0) return NO_TAKE(TREE_TURN_REASONS.QUEUE_EMPTY)
  /* THE OVERLAP RULE IS STILL FIRST AMONG THE REAL CHECKS. One turn at a time
     is the engine's contract, not a preference this module may trade away. */
  if (turnActive === true) return NO_TAKE(TREE_TURN_REASONS.TURN_ACTIVE)

  const waitingSince = instantOrNull(personWaitingSince)
  const boundary = instantOrNull(boundaryAt)
  /* Nothing on either clock: no turn has ever ended on this session and nobody
     was ever refused on it, so there is no window to hold and the tree goes. */
  if (waitingSince === null && boundary === null) return Object.freeze({ take: true, reason: TREE_TURN_REASONS.TAKE })

  /* A clock the caller could not supply is not permission to ignore the person
     who is waiting. Refuse by name and let the next tick ask again -- the pump
     reads Date.now() and a module constant, so this is a programming error
     being reported, never a state a running product sits in. */
  if (!Number.isFinite(now) || !Number.isFinite(personYieldMs) || personYieldMs < 0) {
    return NO_TAKE(TREE_TURN_REASONS.CLOCK_UNUSABLE)
  }

  /* THE WINDOW OPENS AT THE BOUNDARY, WHETHER OR NOT A REFUSAL WAS RECORDED.
     Two openers, and whichever is later starts the clock:

       the boundary   every turn_completed. The renderer's drain starts the
                      instant it hears this and needs one IPC round trip to
                      reach sendTurn(); the tree waits that long. See THE
                      SECOND LOST RACE above for why this cannot be left to
                      the refusal alone.
       the refusal    a person's send refused mid-turn, possibly minutes
                      before the boundary. Timing the yield from the refusal
                      would have expired before the drain ever ran, which is
                      the starvation again with extra steps; it matters on its
                      own only for a session that has never completed a turn. */
  const openedAt = Math.max(waitingSince ?? -Infinity, boundary ?? -Infinity)
  if (now - openedAt < personYieldMs) {
    /* THE BOUND. A restamped boundaryAt can keep this branch true forever
       (THE THIRD LOST RACE, above); queuedSince cannot, because nothing
       resets it while the same batch is still waiting. Past the bound the
       tree goes even though a window is nominally still open -- turnActive
       already refused above if a turn is actually running, so this can only
       fire in a free instant between turns, and it is that free instant the
       restamping defect was stealing forever. */
    const queued = instantOrNull(queuedSince)
    if (queued !== null && now - queued >= personYieldMs * MAX_YIELD_BOUNDARIES) {
      return Object.freeze({ take: true, reason: TREE_TURN_REASONS.YIELD_BOUND })
    }
    return NO_TAKE(TREE_TURN_REASONS.PERSON_FIRST)
  }
  return Object.freeze({ take: true, reason: TREE_TURN_REASONS.TAKE })
}

module.exports = { TREE_TURN_REASONS, treeTurnDecision }
