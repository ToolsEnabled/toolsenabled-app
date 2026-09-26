/* One confirmed native close shared by the person's palette and the hosted
   person's admitted request. Cleanup is never inferred from an RPC timeout. */

/* THE ONE THING A REFUSED STOP KNOWS, AND IT USED TO BE DROPPED HERE.
 *
 * The close below rejects with an Error that carries nothing but a bounded
 * code: shell/main.cjs rendererSafeAgentError rebuilds every agent rejection as
 * `new Error(code)` with `safe.code = code`, deliberately, so no path, stack or
 * internal prose crosses to a window. The code IS the whole message, and the
 * bare `catch` that used to stand here threw it away before any caller could
 * read it -- so src/views/computers.js printed PALETTE_PANEL.stopFailed, "press
 * Stop again", for every cause alike.
 *
 * At least three of those causes cannot be cured by pressing Stop again:
 * MC_AGENT_UNKNOWN_SESSION and MC_AGENT_SESSION_ENDED (shell/agent-command-
 * surface.cjs ownedAgentSession) and AGENT_SESSION_UNKNOWN (shell/agent-host.cjs
 * closeSession) all mean this run is not holding that session, so the same press
 * refuses identically for ever; AGENT_TREE_RECOVERY_UNAVAILABLE is an engine
 * that cannot hold queued messages across a close and says so in a sentence
 * rendererSafeAgentError then drops. Carrying the code is what lets the copy
 * say which of those it is.
 *
 * NOTHING ELSE CHANGES. The result keeps `closed:false` and `savedState:
 * 'pending'` exactly as before -- a rejected close is still admission-uncertain
 * and still performs no cleanup -- and the code is an extra machine field, never
 * shown as itself (src/fleet-tree-copy.js stopRefusalSentence translates it;
 * the view also puts it on data-refusal-code for support). A rejection with no
 * code-shaped identifier carries `code: null`, which is the absence this
 * codebase keeps mistaking for a value, so the copy falls back to the sentence
 * it has always printed rather than to a blank.
 */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,127}$/
export function closeRefusalCode(error) {
  const named = typeof error?.code === 'string' ? error.code.trim() : ''
  if (CODE_SHAPE.test(named)) return named
  const message = typeof error?.message === 'string' ? error.message.trim() : ''
  return CODE_SHAPE.test(message) ? message : null
}

export async function stopNativePersonSession(node, deps) {
  if (!node?.sessionId || deps.current?.() === false) return { outcome: 'not-sent', closed: false }
  let answer
  try { answer = await deps.close({ sessionId: node.sessionId }) }
  catch (error) { return { closed: false, savedState: 'pending', code: closeRefusalCode(error) } }
  /* A close that RESOLVES unconfirmed may also name itself -- agent:close
     answers a consumed recovery ticket as `{ ok:false, closed:false, code }`
     rather than throwing -- so the same field is filled from the answer. */
  if (answer?.closed !== true || answer?.ok === false
      || (answer.sessionId !== undefined && answer.sessionId !== node.sessionId)) {
    return { closed: false, savedState: 'pending', code: closeRefusalCode(answer) }
  }
  deps.forgetCleanup(node.sessionId)
  const dropped = deps.clearOutbox(node.sessionId)
  // An admitted close outlives navigation. The detached view may retire its
  // exact old runtime but must not write into a replacement store or node.
  const active = deps.current?.() !== false
  if (active) deps.settle(node.sessionId)
  else deps.retire(node.sessionId)
  deps.resetMetrics(node.sessionId)
  let savedState = 'unconfirmed'
  if (active && deps.ownsNode(node)) {
    const result = deps.saveStopped(node)
    if (result?.ok !== false && result?.snapshot?.persistenceFailed !== true && deps.recorded(node)) savedState = 'recorded'
  }
  return { closed: true, savedState, dropped }
}
