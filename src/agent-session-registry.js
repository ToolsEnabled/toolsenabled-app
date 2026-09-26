/* WHOSE SESSION IS RUNNING, ANSWERED IN ONE PLACE.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. The agent page could start a real session
 * and watch it work, and could not steer it: Pause, Respawn and Terminate all
 * reported "no observed control target is mapped to this declared agent" while
 * a session was genuinely running six inches above them on the same screen. For
 * a product whose whole claim is orchestrating fleets, controls that cannot
 * steer a live session are a core feature failing.
 *
 * THE ROOT WAS NOT IN THE CONTROLS. It was that the session had no agent
 * identity to be mapped to. src/agent-session.js took `agentId` as a parameter
 * and never read it -- its own header says so -- so the session it started was
 * an anonymous child process that happened to be spawned from a page about an
 * agent. Meanwhile the Controls panel asked the mission-bridge projection for a
 * `controlTarget`, which is a record of a REMOTE observed run and is null on
 * every local install. Both halves were behaving correctly; there was simply
 * nothing joining them, and the honest refusal the controls printed was the
 * only true thing that could be said about a mapping that did not exist.
 *
 * So this module IS the mapping, and it is deliberately the smallest thing that
 * can be one: the id of the agent whose page started the session, the id of the
 * session, and what it is doing. Nothing derives an agent from a session id --
 * session ids remain opaque, exactly as the projection contract requires. The
 * association is recorded at the only moment it is known for certain, which is
 * the moment a person presses Start on a particular agent's page.
 *
 * WHY A MODULE-LEVEL SINGLE RECORD RATHER THAN A LIST. The shell permits one
 * app-owned session per window at a time -- src/agent-session.js refuses to
 * start a second while `sessionId` is set, and mounting is per-navigation --
 * so a list would be a shape that cannot occur pretending to be one that can.
 * If the shell ever hosts several, this becomes a Map and every caller keeps
 * asking the same question: `liveSessionFor(agentId)`.
 *
 * NOTHING HERE TOUCHES STORAGE. A live session cannot outlive the window that
 * owns it -- the main process closes every session owned by a destroyed
 * WebContents -- so persisting this would be persisting a claim that is false
 * on the next launch, which is the absence-read-as-consent shape this project
 * keeps finding. Reload the window and there is no session, which is the truth.
 *
 * THE RECORD CARRIES ITS ACTIONS, and that is a deliberate coupling rather than
 * a leak. The alternative was a plain data record with the Controls panel
 * calling mcAgent itself, and it fails on Respawn: a new session started behind
 * the session surface's back leaves that surface holding a null session id, its
 * Stop disabled, and its transcript detached from a child process that is
 * running -- a fresh instance of the exact defect this module exists to close.
 * One owner of the session lifecycle, and the controls ask it. `publishLiveSession`
 * therefore REQUIRES the three functions and treats a record without them as
 * malformed, because a control mapped to a session it cannot act on is worse
 * than no mapping at all: it is the mapping this repair was written to remove.
 */

export const LIVE_SESSION_EVENT = 'mc:agent-live-session'

/* The phases a caller may be told about, ordered by how much is happening.
 *
 * `starting` and `stopping` exist as their own phases rather than being folded
 * into their neighbours because a control that acts during either would be
 * acting on a session that does not exist yet or no longer does. They are the
 * states in which the honest answer to "can I terminate this?" is "not yet" and
 * "already", and neither of those is "no session is running". */
export const LIVE_SESSION_PHASES = Object.freeze(['starting', 'open', 'working', 'stopping'])

const isText = value => typeof value === 'string' && value.trim() !== ''

let current = null
let currentOwner = null

/* A listener that throws must not stop the others from being told, and must not
   take down the caller that published. Each is called in its own try. */
const listeners = new Set()

function announce() {
  for (const listener of [...listeners]) {
    try { listener(current) } catch { /* one bad subscriber is not everyone's problem */ }
  }
  /* The DOM event is a convenience for surfaces that already listen on window
     (the write flags use the same idiom); it carries no payload a subscriber
     could not get from readLiveSession(), so a page cannot be told about a
     session by a forged event. */
  try {
    globalThis.dispatchEvent?.(new CustomEvent(LIVE_SESSION_EVENT))
  } catch { /* no DOM: node --test reads the record directly */ }
}

/**
 * Record the app-owned session, or clear it with `null`.
 *
 * VALIDATED, and a malformed record CLEARS rather than being stored. A partial
 * record is the dangerous shape here: an agentId with no sessionId would map a
 * control to a session it cannot name, and this is the module three destructive
 * controls read to decide whether they may act.
 */
export function publishLiveSession(record) {
  currentOwner = null
  return updateLiveSession(record)
}

/* A route can be retiring while its successor already owns a session. Late
   close replies and turn events from that route may update its own surface,
   but cannot reclaim or clear the successor's steering controls. */
export function createLiveSessionPublisher() {
  const owner = {}
  let claimed = false
  return record => {
    if (!claimed) {
      if (record == null) return current
      currentOwner = owner
      claimed = true
    }
    if (currentOwner !== owner) return current
    return updateLiveSession(record)
  }
}

function updateLiveSession(record) {
  if (record === null || record === undefined) {
    if (current === null) return null
    current = null
    announce()
    return null
  }
  const agentId = isText(record.agentId) ? record.agentId : null
  const sessionId = isText(record.sessionId) ? record.sessionId : null
  const phase = LIVE_SESSION_PHASES.includes(record.phase) ? record.phase : null
  const source = record.control
  const control = source
    && typeof source.pause === 'function'
    && typeof source.respawn === 'function'
    && typeof source.terminate === 'function'
    ? Object.freeze({ pause: source.pause, respawn: source.respawn, terminate: source.terminate })
    : null
  if (!agentId || !sessionId || !phase || !control) {
    if (current === null) return null
    current = null
    announce()
    return null
  }
  const next = Object.freeze({ agentId, sessionId, phase, control })
  if (current
    && current.agentId === next.agentId
    && current.sessionId === next.sessionId
    && current.phase === next.phase
    && current.control.pause === next.control.pause
    && current.control.respawn === next.control.respawn
    && current.control.terminate === next.control.terminate) return current
  current = next
  announce()
  return current
}

/** The app-owned session, whoever it belongs to, or null. */
export function readLiveSession() {
  return current
}

/**
 * The app-owned session for THIS agent, or null.
 *
 * The identity comparison is exact and both ids must be non-empty. A session
 * belonging to another agent is not this agent's session, and answering that
 * question with `null` is what keeps the Controls panel on one agent's page
 * from terminating a session started on another's.
 */
export function liveSessionFor(agentId) {
  if (!isText(agentId) || !current) return null
  return current.agentId === agentId ? current : null
}

/** Subscribe; returns its own unsubscribe. */
export function onLiveSession(listener) {
  if (typeof listener !== 'function') throw new TypeError('onLiveSession requires a listener function')
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/* Test-only reset. The module is a singleton by design, and a suite that has to
   reload the module graph to get a clean one ends up asserting against a
   different module object than the one under test. */
export function resetLiveSessionForTest() {
  current = null
  currentOwner = null
  listeners.clear()
}
