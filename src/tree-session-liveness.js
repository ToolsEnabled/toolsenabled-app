/* IS THERE STILL AN AGENT BEHIND THIS CIRCLE.
 *
 * WHY THIS IS A MODULE AND NOT FOUR EXPRESSIONS INSIDE THE VIEW. A session is a
 * child process: it dies when the application closes, and the RECORD of it does
 * not. So every screen that draws a saved node has to answer one question --
 * does the thing this record describes still exist -- and src/views/computers.js
 * was answering it in six different places, in six different ways:
 *
 *   the chip's word      node.status === 'starting'          -> "starting", forever
 *   the graph's clock    bornAt set, stoppedAt only if final -> a clock ticking
 *                                                              over a dead child
 *   the rail's answer    same status test                    -> "no answer yet",
 *                                                              for a turn that
 *                                                              ended at shutdown
 *   the Resume verb      same status test                    -> "it is busy,
 *                                                              wait" -- the
 *                                                              refusal that left
 *                                                              no way out
 *   Stop / Interrupt     status only                         -> enabled over a
 *                                                              corpse
 *   the send path        nodeBusy (the one that was right)   -> queued a message
 *                                                              nothing drains,
 *                                                              because the maps
 *                                                              disagreed
 *
 * Measured on the packaged build 2026-08-16: close the app mid-turn, reopen the
 * same profile, and the circle is blue with a runtime climbing past four
 * minutes, the chip says "starting", the chat header says "live session", and a
 * typed message answers "Queued -- sends by itself when this turn finishes".
 * It never finishes. One rule with one name is the fix; six near-copies is how
 * the defect was assembled.
 *
 * `ownedSessions` IS THE ONLY EVIDENCE THERE IS. It is the caller's set of
 * sessions THIS APP RUN opened -- anything with `.has` -- and it cannot be
 * rebuilt from storage, because storage cannot tell a session that is running
 * from one that was running when it was written. A view that hands over a set
 * refilled from disk gets the defect back, which is exactly what happened.
 *
 * Nothing here touches a DOM, a store or a bridge, so the suite drives the real
 * rule rather than matching the source of it.
 */

const BUSY_STATUSES = new Set(['starting', 'running'])
/* 'turn-failed' is a turn that ended badly on a session that really ran --
   over, exactly as 'finished' is over, so the clock stops rather than ticking
   on the canvas above a failure. See NODE_STATUSES in src/fleet-trees.js. */
const TERMINAL_STATUSES = new Set(['finished', 'failed', 'turn-failed', 'interrupted', 'cancelled'])

const holdsSession = node => Boolean(node && typeof node.sessionId === 'string' && node.sessionId)

/* WHAT THE MEMBERSHIP TEST ABOVE CANNOT SEE, AND THE MEASUREMENT THAT SHOWS IT.
 *
 * `ownedSessions.has(id)` answers one question honestly -- did THIS app run
 * open that session -- and the header above is about the case it fixed: the
 * app closes, the set is empty on the next run, and a saved record stops
 * claiming to be live. That half still holds.
 *
 * IT CANNOT SEE A SESSION THAT DIES WHILE THE APP KEEPS RUNNING. The id is put
 * in the set at start and taken out when an end is confirmed. If the end never
 * arrives -- the child was killed, the host never wrote the outcome, the whole
 * machine stalled -- the id stays in the set for the rest of the run, so this
 * says "live" forever and every screen that asks says "busy" forever.
 *
 * MEASURED in agent-spawn-records.jsonl (tail 1500, records dated 2026-09-18
 * and 09-19): 456 lines, 185 `agent_session_start`, 185
 * `agent_session_outcome`, 86 `agent_session_end`. 162 started, 23 refused.
 * NINETY-NINE started sessions have no end record. Within one app run each of
 * those reads busy until the app is closed -- which is the complaint, and the
 * reason the only remedy anyone found was quitting.
 *
 * SO LIVENESS TAKES A SECOND SOURCE THAT EXPIRES. `seenAt` is the caller's
 * record of when this run last had EVIDENCE of that session: an event from it,
 * a status reply, a heartbeat. Membership says the session is ours; the stamp
 * says it was still answering recently. Both, or it is not live.
 *
 * ABSENT IS STILL "LIVE", DELIBERATELY. A caller that supplies no `seenAt`
 * lookup gets exactly the old answer, because for those callers membership is
 * genuinely all the evidence there is and inventing staleness would mark live
 * sessions dead. A caller that supplies the lookup but has no stamp for THIS
 * session is in the same position -- it has not started recording for it yet --
 * and is also answered "live". Only a stamp that EXISTS and is older than the
 * window makes this false. That is the narrowest rule that still expires. */
const DEFAULT_STALE_AFTER_MS = 90_000

/** Is the session on this record one this run can still reach?
 *
 *  @param evidence.seenAt   Map-like `get(sessionId) -> ms` of last evidence.
 *  @param evidence.now      ms, injected so the rule is executable in a test.
 *  @param evidence.staleAfterMs  how old a stamp may be and still count.
 */
export function sessionIsLive(node, ownedSessions, evidence = null) {
  if (!holdsSession(node)) return false
  if (!ownedSessions || typeof ownedSessions.has !== 'function') return false
  if (!ownedSessions.has(node.sessionId)) return false
  return !sessionEvidenceIsStale(node.sessionId, evidence)
}

/** Has the caller's own evidence for this session gone quiet past the window?
 *  Exported because the remedy path has to be able to say "this one, and it has
 *  been quiet for N seconds" rather than only "not live". */
export function sessionEvidenceIsStale(sessionId, evidence = null) {
  const seenAt = evidence && evidence.seenAt
  if (!seenAt || typeof seenAt.get !== 'function') return false
  const stamp = seenAt.get(sessionId)
  if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return false
  const now = typeof evidence.now === 'number' && Number.isFinite(evidence.now) ? evidence.now : Date.now()
  const window = typeof evidence.staleAfterMs === 'number' && Number.isFinite(evidence.staleAfterMs) && evidence.staleAfterMs > 0
    ? evidence.staleAfterMs
    : DEFAULT_STALE_AFTER_MS
  /* A stamp from the future is a clock that moved, not evidence of silence.
     Treat it as fresh rather than declaring a live session dead over it. */
  return now - stamp > window
}

/** Is this node mid-turn RIGHT NOW: a busy status over a session that exists
 *  AND has answered recently enough to still be believed. */
export function nodeIsBusy(node, ownedSessions, evidence = null) {
  return Boolean(node && BUSY_STATUSES.has(node.status) && sessionIsLive(node, ownedSessions, evidence))
}

/** The record says busy and there is nothing behind it: the app closed mid-turn,
 *  or the session went quiet past the window while the app kept running.
 *  Deliberately distinct from `finished`, which is a turn that really ended. */
export function sessionEndedWithApp(node, ownedSessions, evidence = null) {
  return Boolean(node && BUSY_STATUSES.has(node.status) && holdsSession(node)
    && !sessionIsLive(node, ownedSessions, evidence))
}

export { DEFAULT_STALE_AFTER_MS }

/**
 * The runtime face of one node: how long it has ACTUALLY run, whether that
 * figure is still moving, and the instant a `now - epoch` clock has to count
 * from for its digits to equal that figure.
 *
 * `runMs` is the store's measurement — the sum of the intervals this node was
 * running, and nothing else. See THE RUN CLOCK in src/fleet-trees.js for how
 * it is accrued and why `createdAt` was never an honest substitute for it.
 * `null` means the record predates that measurement, which is a different
 * answer from `0` and is rendered differently below.
 *
 * `runtimeEpoch` IS AN EPOCH, NOT A BIRTHDAY, and it is named that way because
 * for a node that has run more than once there is no single instant its clock
 * counts from: the figure to show is `runMs` plus whatever the open interval
 * has added since, so the epoch handed to fmtRuntime/bindRuntime is shifted
 * back by the runs that already ended. Only the DIFFERENCE it produces is a
 * fact about the agent.
 *
 * `stoppedAt` is set whenever the run is OVER, and "over" is three states, not
 * two: finished, failed, and the one that had no branch -- saved mid-turn, the
 * app closed, and the session gone with it. A null stoppedAt binds a live clock
 * in src/tree-graph.js, so that missing third state IS the ticking clock.
 *
 * A record that ever held a session keeps a clock either way, because a run
 * that happened must not render as one that never did (the 2026-08-13
 * finding).
 */
export function treeNodeClock(node, ownedSessions, evidence = null) {
  const held = holdsSession(node)
  const terminal = Boolean(node && TERMINAL_STATUSES.has(node.status))
  /* The SAME evidence the other three rules use. A clock that kept ticking
     over a session the rest of the screen had already given up on is the
     six-near-copies defect in this file's header, reassembled one rule at a
     time. */
  const endedWithApp = sessionEndedWithApp(node, ownedSessions, evidence)
  const ended = terminal || endedWithApp
  const running = nodeIsBusy(node, ownedSessions, evidence)
  const lastWrite = Date.parse(node?.updatedAt)
  const runMs = Number.isFinite(node?.runMs) && node.runMs >= 0 ? Math.floor(node.runMs) : null

  /* THE PRE-MEASUREMENT RECORD KEEPS THE OLD, OVER-COUNTING ANSWER. It is the
     wrong number -- it is the number this whole change exists to replace --
     but it is the only one that record can support, and replacing a finished
     agent's runtime with "no runtime" or with 0s to avoid showing a wrong
     figure would delete history the person can still read. Nothing written by
     this version takes this branch: addNode stamps runMs 0 at birth. */
  if (runMs === null) {
    const legacyEpoch = held ? Date.parse(node.createdAt) : NaN
    const legacyStop = held && ended ? lastWrite : NaN
    return {
      runtimeEpoch: Number.isFinite(legacyEpoch) ? legacyEpoch : null,
      stoppedAt: Number.isFinite(legacyStop) ? legacyStop : null,
      runMs: null,
      running,
      terminal,
      endedWithApp,
    }
  }

  /* AN AGENT THAT IS RUNNING GETS A CLOCK THAT MOVES. `running` is the shared
     rule -- a live status over a session THIS run owns -- and the store folds
     any open interval shut at load, so a record orphaned by shutdown never
     reaches here.
     The open interval is normally the one to count from. When the record says
     running and carries none, the interval began at some unmeasured moment
     before the last write; counting from the last write is the floor, exactly
     as loadedRunClock does. Freezing instead would put a still, dead-looking
     number over a working agent, which is the 2026-08-16 defect pointing the
     other way. */
  const openedAt = Date.parse(node?.runStartedAt)
  if (running) {
    const from = Number.isFinite(openedAt) ? openedAt : lastWrite
    if (Number.isFinite(from)) {
      return { runtimeEpoch: from - runMs, stoppedAt: null, runMs, running, terminal, endedWithApp }
    }
  }

  /* Closed. An interval still open on a node that is NOT running belongs to a
     run that ended without a write to close it -- the store folds those shut
     at load, and this folds the same way for anything that reaches here by
     another road. Same floor, same reason: the last thing measured about the
     run is the last write, and counting past it invents the gap.
     `stoppedAt - runtimeEpoch` is the banked total whatever `updatedAt` is, so
     a later write with nothing to do with running -- a move, a reply, a
     rename -- shifts both and changes no digit. */
  const unclosed = Number.isFinite(openedAt) && Number.isFinite(lastWrite) ? Math.max(0, lastWrite - openedAt) : 0
  const banked = runMs + unclosed
  const ranAtAll = banked > 0 || held
  const stoppedAt = ranAtAll && Number.isFinite(lastWrite) ? lastWrite : null
  return {
    runtimeEpoch: stoppedAt === null ? null : stoppedAt - banked,
    stoppedAt,
    runMs: banked,
    running,
    terminal,
    endedWithApp,
  }
}
