/* HOW LONG A PRESS ON THE APPROVAL CARD IS ALLOWED TO SAY NOTHING.
 *
 * THE DEFECT, measured 2026-09-03 by reading the whole reply path. Both doors
 * into the answer -- renderApprovalCard()'s click handler and settleApproval()
 * in src/views/computers.js -- did `await bridge.answerApproval(...)` bare.
 * That call is `ipcRenderer.invoke('mc-agent:approval-answer', …)`
 * (shell/fleet-profile-preload.cjs), and invoke() has NO timeout: it settles
 * when the main process answers, and never if it does not. The main process
 * hands the request to the engine adapter over a pipe.
 *
 * So a press that got no answer back produced exactly nothing: no sentence, no
 * hint to press again, the buttons still enabled and the card still headed "It
 * is asking permission". The person had answered and had no way to know the
 * answer had gone nowhere, while the agent stayed stopped on the question.
 * Silence is the one thing an approval surface must never do.
 *
 * THE BOUND IS A REPORTING BOUND, NOT A DECISION. Nothing here approves,
 * declines, or cancels anything, and a bound that elapses leaves the request
 * exactly as pending as it was -- the card stays open, its choices stay
 * pressable, and the sentence says the answer did not land. The engine remains
 * the only thing that can settle an approval.
 *
 * FIFTEEN SECONDS because the answer is a single pipe write to a live child --
 * src/lib/agent-engine/codex-adapter.js answerApproval() writes the JSON-RPC
 * result synchronously -- so a healthy round trip is milliseconds. Long enough
 * that a busy main process is never called a failure; short enough that a
 * person is not left watching a dead button.
 */

export const APPROVAL_ANSWER_TIMEOUT_MS = 15_000

/* A private marker, so a bridge that answers with a string, a number, or any
   other legitimate value can never be mistaken for the bound elapsing. */
const TIMED_OUT = Symbol('approval answer timed out')

// A provider can ask about several tools in one turn. Retain each request;
// answering one must not erase another, including while a reply is in flight.
export function createPendingApprovals() {
  const sessions = new Map()
  return {
    get(sessionId) { return sessions.get(sessionId)?.values().next().value?.approval },
    all(sessionId) { return [...(sessions.get(sessionId)?.values() || [])].map(entry => entry.approval) },
    set(sessionId, approval) {
      if (!approval?.approvalId) return
      let pending = sessions.get(sessionId)
      if (!pending) { pending = new Map(); sessions.set(sessionId, pending) }
      const entry = pending.get(approval.approvalId)
      if (entry && entry.approval.turnId === approval.turnId) entry.approval = approval
      else pending.set(approval.approvalId, { approval, answer: null })
    },
    beginAnswer(sessionId, approvalId) {
      const entry = sessions.get(sessionId)?.get(approvalId)
      if (!entry || entry.answer) return null
      return (entry.answer = {})
    },
    endAnswer(sessionId, approvalId, answer) {
      const entry = sessions.get(sessionId)?.get(approvalId)
      if (!answer || entry?.answer !== answer) return false
      entry.answer = null
      return true
    },
    answering(sessionId, approvalId) { return Boolean(sessions.get(sessionId)?.get(approvalId)?.answer) },
    settle(sessionId, approvalId, expected = null) {
      const pending = sessions.get(sessionId)
      if (expected && pending?.get(approvalId)?.approval !== expected) return false
      if (!pending?.delete(approvalId)) return false
      if (!pending.size) sessions.delete(sessionId)
      return true
    },
    delete(sessionId) { return sessions.delete(sessionId) },
  }
}

/* Wait for one answer, bounded, and say WHICH of the three things happened.
 *
 * `timedOut` is kept separate from a plain absent answer on purpose: "the
 * engine refused this" and "nothing came back at all" are different facts about
 * the same press, and a caller that wants to distinguish them must be able to.
 *
 * The timer is injectable so the bound itself is testable by calling with
 * values rather than by waiting fifteen real seconds. It is always cleared --
 * on the answer path too -- so a resolved press cannot leave a timer running
 * behind a card that is already gone. */
export async function answerWithinBound(answering, {
  timeoutMs = APPROVAL_ANSWER_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  /* A door that throws BEFORE it returns a promise -- an absent bridge, a
     preload that was torn down -- is an answer that did not land, exactly like
     a rejection. Calling the factory outside this guard would have thrown past
     both call sites, which the bare `catch { answered = null }` they replaced
     never did. */
  let pending = null
  try { pending = typeof answering === 'function' ? answering() : answering }
  catch { return Object.freeze({ answered: null, timedOut: false }) }
  let handle = null
  const bound = new Promise(resolve => {
    handle = setTimer(() => resolve(TIMED_OUT), timeoutMs)
  })
  try {
    /* A thrown answer is an answer that did not land, which is what the bare
       `catch { answered = null }` at both call sites already meant. Kept here so
       the two doors cannot drift on what a rejection means. */
    const settled = await Promise.race([
      Promise.resolve(pending).then(value => value, () => null),
      bound,
    ])
    if (settled === TIMED_OUT) return Object.freeze({ answered: null, timedOut: true })
    return Object.freeze({ answered: settled?.ok === false ? null : settled || null, timedOut: false })
  } finally {
    clearTimer(handle)
  }
}
