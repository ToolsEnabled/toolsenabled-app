/* THE HOST'S REFUSALS, REMEMBERED ACROSS MOUNTS.
 *
 * MEASURED on the 2026-09-21 LIVE generation (app d46c18f49): the saved-
 * session sweep asks the host about every saved circle whose session this
 * run of the window does not own, on every mount of the Agents page and of
 * the Home chat, and it remembered nothing between mounts. Seventy-six saved
 * sessions from earlier runs of the app, four mounts in twenty-seven minutes,
 * and the host logged 303 refused "mc-agent:models" reads, each one an
 * Electron handler stack (bursts of 77, 76, 75 and 75). The same class as the
 * goal box storm (app 6f79978fd), here for the reconnect probe and for the
 * model catalog.
 *
 * A session the host does not hold stays unheld until the circle it belongs
 * to changes: a new session is a new id, and a status change is the one other
 * thing that can mean the host was asked to do something with it. So the
 * refusal is remembered against the session, stamped with the circle's id and
 * status, and the host is asked again only when that stamp differs. A refusal
 * that is not terminal -- a transport failure, a host that is not ready yet --
 * is not remembered, so it is retried exactly as before.
 *
 * refusalCode() reads the code the host attached, or the code-shaped token in
 * the sentence Electron wraps a rejected invoke in ("Error invoking remote
 * method 'mc-agent:models': Error: MC_AGENT_UNKNOWN_SESSION"), which is how the
 * refusal actually arrives in the window: the code property does not survive
 * the IPC boundary. */
import { refusalCode } from './agent-availability-copy.js'

/* The two answers that mean the host will not hold this session again in this
   run: it never had it, or it has ended. shell/agent-command-surface.cjs
   raises exactly these from ownedAgentSession, and the view's own terminal
   set in src/views/computers.js names the same two. */
export const TERMINAL_SESSION_REFUSAL_CODES = Object.freeze(['MC_AGENT_UNKNOWN_SESSION', 'MC_AGENT_SESSION_ENDED'])

export function terminalSessionRefusal(value) {
  return TERMINAL_SESSION_REFUSAL_CODES.includes(refusalCode(value))
}

export function createSavedSessionRefusals({
  stamp = node => `${node?.id ?? ''}\n${node?.status ?? ''}`,
  terminal = terminalSessionRefusal,
} = {}) {
  const remembered = new Map()
  const sessionOf = node => (typeof node?.sessionId === 'string' && node.sessionId ? node.sessionId : null)
  return Object.freeze({
    /* True when the host already refused this circle's session and nothing
       about the circle has changed since: there is no reason to ask again. */
    skip(node) {
      const sessionId = sessionOf(node)
      return sessionId !== null && remembered.get(sessionId) === stamp(node)
    },
    /* Records a terminal refusal against the circle as it is now, and says
       whether it was one. Anything else is left to be retried. */
    remember(node, refusal) {
      const sessionId = sessionOf(node)
      if (sessionId === null || !terminal(refusal)) return false
      remembered.set(sessionId, stamp(node))
      return true
    },
    /* A session the host answered for is held after all. */
    forget(sessionId) { return remembered.delete(sessionId) },
    get size() { return remembered.size },
  })
}
