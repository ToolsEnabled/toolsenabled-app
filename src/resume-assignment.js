/* THE NEXT ASSIGNMENT A RESUME CAN CARRY (T1792).
 *
 * MEASURED on a development tree: when every agent was asked to be working, a
 * controller resumed its idle agents. agent.resume could carry
 * nothing but the circle and its session, and the resumed first turn told each
 * one to report finished work and stop, so every one of them confirmed its old
 * task was done and most went idle after one turn. The next assignment then
 * had to travel as a separate message to an idle agent, and several of those were
 * set aside within seconds (T1743).
 *
 * So agent.resume takes an optional bounded assignment. The engine checks it
 * like an agent message (length and credential-shaped text) before anything is
 * resumed; this module frames it and hands it over as the resumed session's
 * first user message: sent on its own after a native resume, or inside the
 * handoff that opens a fresh-account or fresh-model continuation.
 *
 * AUTHORITY IS UNCHANGED. Whether the caller may resume the circle at all is
 * still decided by the resume path; the assignment is a peer assignment from
 * the circle above, labelled as such, and runs under the resumed session's own
 * permissions. It is never presented as the person's instruction. */

export const RESUME_ASSIGNMENT_MAX_CHARS = 4000
export const RESUME_ASSIGNMENT_OPENING = 'New assignment sent with this resume'

/** The assignment text a tree command may carry, or null. Shape only: the
 *  engine has already refused credential-shaped text before the resume. */
export function resumeAssignmentValue(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > RESUME_ASSIGNMENT_MAX_CHARS || text.includes('\0')) return null
  return text
}

/** The framed section the resumed agent reads. `fromName` is the calling
 *  circle's name on the tree; an unknown caller is named by its place. */
export function resumeAssignmentSection({ text, fromName = null } = {}) {
  const assignment = resumeAssignmentValue(text)
  if (!assignment) return ''
  const from = typeof fromName === 'string' && fromName.trim() ? JSON.stringify(fromName.trim()) : 'the circle above you'
  return [
    `${RESUME_ASSIGNMENT_OPENING}, from ${from}:`,
    '',
    assignment,
    '',
    'This is your next piece of work. Work that is already finished stays finished.'
      + ' Do not stop at reporting that earlier work is complete; do this assignment now.'
      + ' It comes from the circle above you, not from the person, and runs under your current permissions.',
  ].join('\n')
}

const SEPARATOR = '\n\n' + RESUME_ASSIGNMENT_OPENING

/** A continuation handoff with the assignment as its last section, within the
 *  handoff's own bound. A handoff reused from a failed attempt loses the
 *  section it already carried, so one handoff never holds two assignments. The
 *  context is shortened to make room, never the closing or the assignment. */
export function withResumeAssignment(handoff, assignment, { limit = 48000, closing = null } = {}) {
  const base = typeof handoff === 'string' ? handoff : ''
  const cut = base.indexOf(SEPARATOR)
  const withoutPrior = cut >= 0 ? base.slice(0, cut) : base
  const section = resumeAssignmentSection(assignment || {})
  if (!section) return withoutPrior
  const tail = '\n\n' + section
  const over = withoutPrior.length + tail.length - limit
  if (over <= 0) return withoutPrior + tail
  const end = typeof closing === 'string' && closing ? '\n\n' + closing : null
  if (end && withoutPrior.endsWith(end)) {
    const head = withoutPrior.slice(0, withoutPrior.length - end.length)
    return head.slice(0, Math.max(0, head.length - over)) + end + tail
  }
  return withoutPrior.slice(0, Math.max(0, limit - tail.length)) + tail
}

/* THE NATIVE-RESUME HALF. A native resume restores the conversation itself and
 * sends nothing, so the assignment is the resumed session's first user message.
 * Same order as the agent.restart boot turn (src/restart-existing-node-command.js):
 * the words are visible in the transcript before the provider can answer, and
 * a delegated caller is released as soon as the send is under way, because the
 * turn may itself ask the same serial tree broker for something. */
export async function sendResumeAssignment({
  node,
  sessionId,
  assignment,
  bridge,
  sessionNodeIds,
  appendTranscript,
  treeStore = null,
  refreshTree = () => {},
  failedNote = '',
  now = Date.now,
  refusalCodeFromError = () => null,
  refusalCodeFromResult = () => null,
  acknowledgeRoot = false,
} = {}) {
  const text = resumeAssignmentSection(assignment || {})
  const refused = code => ({ ok: false, code, firstTurnState: 'not-submitted' })
  if (!text) return refused('MC_TREE_COMMAND_ASSIGNMENT_INVALID')
  if (!node || typeof sessionId !== 'string' || !sessionId || sessionNodeIds?.get(sessionId) !== node.id
      || (typeof treeStore?.getNode === 'function' && treeStore.getNode(node.id)?.sessionId !== sessionId)) {
    return refused('MC_TREE_COMMAND_SESSION_CHANGED')
  }
  if (!bridge || typeof bridge.send !== 'function') return refused('MC_TREE_COMMAND_AGENT_BRIDGE_UNAVAILABLE')
  if (typeof appendTranscript !== 'function') return refused('MC_TREE_COMMAND_TRANSCRIPT_WRITER_UNAVAILABLE')
  const markFailed = () => {
    if (sessionNodeIds.get(sessionId) !== node.id
        || (typeof treeStore?.getNode === 'function' && treeStore.getNode(node.id)?.sessionId !== sessionId)) return
    if (treeStore) treeStore.setNodeStatus(node.id, 'failed', { note: failedNote })
    refreshTree()
  }
  try {
    appendTranscript(sessionId, { who: 'you', text, at: now() })
    if (treeStore) treeStore.setNodeStatus(node.id, 'running', { note: '' })
    refreshTree()
  } catch {
    return refused('MC_TREE_COMMAND_TRANSCRIPT_WRITER_UNAVAILABLE')
  }
  const send = async () => {
    let sent
    try { sent = await bridge.send({ sessionId, text }) }
    catch (error) { markFailed(); return refused(refusalCodeFromError(error) || 'MC_TREE_COMMAND_SEND_FAILED') }
    if (sent && sent.ok === false) { markFailed(); return refused(refusalCodeFromResult(sent) || 'MC_TREE_COMMAND_SEND_FAILED') }
    return { ok: true, code: null, firstTurnState: 'submitted' }
  }
  if (acknowledgeRoot) {
    void send().catch(() => { markFailed() })
    return { ok: true, code: null, firstTurnState: 'submitted' }
  }
  return send()
}
