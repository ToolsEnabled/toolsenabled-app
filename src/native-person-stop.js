/* One confirmed native close shared by the person's palette and the hosted
   person's admitted request. Cleanup is never inferred from an RPC timeout. */
export async function stopNativePersonSession(node, deps) {
  if (!node?.sessionId || deps.current?.() === false) return { outcome: 'not-sent', closed: false }
  let answer
  try { answer = await deps.close({ sessionId: node.sessionId }) }
  catch { return { closed: false, savedState: 'pending' } }
  if (answer?.closed !== true || answer?.ok === false
      || (answer.sessionId !== undefined && answer.sessionId !== node.sessionId)) return { closed: false, savedState: 'pending' }
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
