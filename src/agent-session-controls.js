/* PAUSE, RESPAWN AND TERMINATE FOR A SESSION THIS APP OWNS.
 *
 * A pure decision module in the idiom of terminateTargetAvailability() in
 * src/mission-bridge.js: what each of the three controls may do, given a live
 * session record, decided without a DOM so it can be exercised in `node --test`
 * rather than only by looking at a window.
 *
 * EVERY CONTROL HERE IS BACKED BY A CALL THAT EXISTS, and that is the whole
 * standard this file is held to. src/orchestration-controls.js states the house
 * rule in the owner's words -- "dont lie like we cant control temperature" --
 * and the failure it names is a control that looks wired, reports success, and
 * changes nothing. So each of the three is defined as exactly what the bridge
 * call it makes actually does, and is named for that rather than for the fleet
 * verb it resembles:
 *
 *   PAUSE      mcAgent.interrupt(). Stops the turn that is running. The session
 *              stays open and the next prompt continues the same conversation.
 *              It is NOT a freeze-and-resume, so the note says "stops the work"
 *              and not "resumes where it left off", and it is offered only while
 *              a turn is actually running -- offering it over an idle session
 *              would be a button whose success message describes nothing.
 *
 *   RESPAWN    mcAgent.close() then mcAgent.start() with a fresh session id for
 *              the same agent. That is a genuinely new child process, which is
 *              what respawn means; it is also irreversible, because the previous
 *              session's transcript and context go with it. Confirmed once.
 *
 *   TERMINATE  mcAgent.interrupt() then mcAgent.close(). Ends the session and
 *              the child process. Confirmed once.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not reach the mission bridge, and
 * it does not touch a declared agent that has no app-owned session. The bridge's
 * own terminate -- a remote observed run with a PID -- remains exactly as it
 * was, including its refusals; this is the other case, not a replacement for it.
 * src/views/agent.js picks between them and never runs both.
 */

export const SESSION_CONTROL_IDS = Object.freeze(['pause', 'respawn', 'terminate'])

/* The destructive pair confirm; pause does not.
 *
 * Not decoration, and not symmetry for its own sake: interrupt is recoverable
 * -- the session is still there and the next prompt continues it -- while close
 * and respawn destroy a running child and everything it was holding. This is
 * the same two-step the bridge terminate already uses, so the one gesture that
 * ends a real process behaves the same way everywhere in the product. */
export const CONFIRMED_CONTROLS = Object.freeze(['respawn', 'terminate'])

const UNAVAILABLE = Object.freeze({
  enabled: false,
  note: 'Unavailable',
})

function unavailable(reason) {
  return Object.freeze({ ...UNAVAILABLE, reason })
}

function available(note, reason) {
  return Object.freeze({ enabled: true, note, reason })
}

/**
 * What the three controls may do right now.
 *
 * @param live     whether the page is the live drill-in. A demonstration page
 *                 gets nothing, for the same reason the Start control does:
 *                 `live` defaults to false so a caller that never considered
 *                 the question cannot accidentally answer yes.
 * @param agentId  the declared agent whose page this is.
 * @param session  the record from src/agent-session-registry.js, or null.
 * @param busy     the control currently mid-flight, or null. One at a time:
 *                 respawn is a close and a start, and a terminate racing it
 *                 would be closing a session id that no longer exists.
 */
export function sessionControlAvailability({ live = false, agentId = null, session = null, busy = null } = {}) {
  const off = (reason) => Object.freeze({
    pause: unavailable(reason),
    respawn: unavailable(reason),
    terminate: unavailable(reason),
    mapped: false,
    reason,
  })

  if (live !== true) {
    return off('These are example agents. No control on this page reaches a real session.')
  }
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    return off('This page does not name an agent, so no session can be mapped to it.')
  }
  if (!session) {
    /* THE SENTENCE A PERSON CAN ACT ON. The old refusal named an internal
       concept -- "no observed control target is mapped to this declared agent"
       -- which is accurate and tells a first-time reader nothing about what to
       do. What they can do is start a session from this page, so that is what
       it says. */
    return off('No session started from this app is running for this agent. Start one above and these will steer it.')
  }
  if (session.agentId !== agentId) {
    return off(`The session running in this app belongs to ${session.agentId}, not this agent.`)
  }
  if (session.phase === 'starting') {
    return off('The session is still starting. These will steer it once it is open.')
  }
  if (session.phase === 'stopping') {
    return off('The session is closing.')
  }
  if (busy && SESSION_CONTROL_IDS.includes(busy)) {
    return off(`${busy[0].toUpperCase()}${busy.slice(1)} is still running. One control at a time.`)
  }

  const working = session.phase === 'working'
  return Object.freeze({
    pause: working
      ? available('Stop the work', 'Stops the turn that is running. The session stays open and your next message continues it.')
      : unavailable('Nothing is running to stop. Pause stops a turn while it works.'),
    respawn: available('New session', 'Ends this session and starts a fresh one for this agent. The current transcript and everything it remembers are lost.'),
    terminate: available('End session', 'Stops the work and closes the session. The child process on the computer you are driving is ended.'),
    mapped: true,
    reason: working
      ? `Steering the session this app started for ${agentId}, which is working now.`
      : `Steering the session this app started for ${agentId}, which is open and idle.`,
  })
}

/**
 * The label and note a control shows, given its availability and its step.
 *
 * Kept beside the availability rather than in the view because the confirm step
 * is the part most likely to be got wrong: a control that says "Confirm" while
 * its availability has gone false would post an action against a session that
 * has ended. CONFIRM is therefore always subordinate to the availability.
 *
 * PENDING IS NOT, AND FOR ONE RELEASE THAT ORDERING MADE IT UNREACHABLE.
 * `pending` was checked after `enabled`, and the only caller passes it for
 * exactly the control named by `busy` -- which is the one control
 * sessionControlAvailability() answers `off()` for. So every press of Terminate
 * repainted the button "Unavailable" for the whole of the kill it had just
 * started, and the one branch that says otherwise could not run. MEASURED on
 * the real window (tools/steering-controls-e2e.cjs, first run): pressing Pause
 * over a working session left all three controls reading "Unavailable" while
 * the interrupt was in flight. A green unit test asserted "Working…" the whole
 * time, because it called this function directly with a state the product could
 * never hand it -- this project's own recurring defect, a passing test over a
 * branch nothing reaches.
 *
 * The two steps are genuinely different acts and the ordering now says so:
 * CONFIRM invites a press, so it must never appear over a control that may not
 * be pressed. PENDING reports an action ALREADY SENT, which is a fact about
 * what this app is doing and stays true however the availability answers.
 * Nothing becomes clickable: the view disables from `state.enabled`, not from
 * the phase, so a pending control is a disabled control that says what it is
 * doing instead of implying the session went away.
 */
export function sessionControlFace(id, state, { step = 'idle' } = {}) {
  const label = { pause: 'Pause', respawn: 'Respawn', terminate: 'Terminate' }[id] || id
  if (step === 'pending') return Object.freeze({ label, note: 'Working…', phase: 'pending', message: `${label} is running. Nothing else is sent until it answers.` })
  if (!state?.enabled) return Object.freeze({ label, note: 'Unavailable', phase: 'unavailable', message: state?.reason || '' })
  if (step === 'confirm' && CONFIRMED_CONTROLS.includes(id)) {
    return Object.freeze({
      label,
      note: 'Select again',
      phase: 'confirm',
      message: `${state.reason} Select ${label} again to do it.`,
    })
  }
  return Object.freeze({ label, note: state.note, phase: 'ready', message: state.reason })
}
