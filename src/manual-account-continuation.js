import { transcriptSeedText } from './session-transcript-store.js'
import { withResumeAssignment } from './resume-assignment.js'

export const MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY = 'Open the ToolsEnabled app on that computer to continue on another account.'


/* OWNER REQUEST T137 (2026-09-16 02:58Z): "switch models still doesnt work. and
   it should work for even different providers because we can just hand the
   context to the next agent." A model switch a running thread cannot make in
   place is this same continuation, opened with its own sentence so the fold
   can say which kind it was. It is recognised as a handoff exactly like the
   account ones. */
export const MODEL_HANDOFF_OPENING = 'The person chose to continue this same agent on another model in a fresh session.'
export const ACCOUNT_HANDOFF_OPENINGS = Object.freeze([
  'The person chose to continue this same agent on another account in a fresh session.',
  'Continue the same assigned task in a new session. The previous session reached a provider limit.',
  MODEL_HANDOFF_OPENING,
])
export function isAccountHandoff(text) {
  const start = typeof text === 'string' ? text.trimStart() : ''
  return ACCOUNT_HANDOFF_OPENINGS.some(opening => start.startsWith(opening))
}
export function isModelHandoff(text) {
  const start = typeof text === 'string' ? text.trimStart() : ''
  return start.startsWith(MODEL_HANDOFF_OPENING)
}

export function savedSessionEffort({ sessionEffort, savedEffort, nodeEffort, tierEffort } = {}) {
  return sessionEffort || savedEffort || nodeEffort || tierEffort || null
}

export function saveStoppedSessionEffort({ nodeId, effort, transcriptStore, treeStore }) {
  const saved = transcriptStore?.get(nodeId)
  // The transcript records the last actual or explicitly selected session
  // settings. The node's initial launch settings are only a fallback.
  if (saved) return transcriptStore.save(nodeId, { ...saved, effort })
  const changed = treeStore.setNodeLaunchPreferences(nodeId, { effort })
  return changed?.ok === true && changed.snapshot?.persistenceFailed !== true
}

export function savedAccountResumeRefused(code) {
  return ['AGENT_RESUME_ACCOUNT_UNAVAILABLE', 'AGENT_RESUME_ACCOUNT_LIMIT', 'AGENT_RESUME_ACCOUNT_SIGNED_OUT',
    'AGENT_RESUME_SOURCE_UNAVAILABLE', 'CODEX_RESUME_SOURCE_INVALID', 'CODEX_RESUME_IDENTITY_MISMATCH',
    'CLAUDE_RESUME_IDENTITY_MISMATCH'].includes(code)
}

/* The native resume was refused because the EARLIER SESSION has not finished
   closing, not because of its account or its saved conversation (T1790). That
   ends this Resume: a transcript-seeded fresh start would need the same close
   and would also give up the native conversation, and moving to another account
   does not close anything either. */
export function predecessorCloseRefused(code) {
  return ['AGENT_PREDECESSOR_STOP_IN_PROGRESS', 'AGENT_PREDECESSOR_CLOSE_REQUIRED'].includes(code)
}

// This is a fresh conversation with a visible handoff, never the old provider's
// native thread opened under another credential. Prefer the full checkpoint
// only when it belongs to this exact session; otherwise use the saved excerpt.
const MANUAL_HANDOFF_CLOSING = 'Preserve completed work and continue the remaining task. The current tree address below supersedes earlier names and reporting relationships.'

function composeManualHandoff(node, transcript, checkpoint, { opening: first, extra = '', assignment = null } = {}) {
  const checkpointText = checkpoint?.sessionId === node?.sessionId ? checkpoint?.handoff : null
  // A failed replacement already saved the composed manual handoff. Reusing
  // it keeps retries from nesting headers and trimming away more context --
  // when it is the same kind of continuation. An account handoff is not
  // reused as a model handoff, or the fold would name the wrong reason.
  // T1792: the assignment a resume carries is the handoff's last section; a
  // reused handoff drops the one it carried and takes this request's.
  if (checkpoint?.kind === 'manual' && typeof checkpointText === 'string' && checkpointText.trim()
      && checkpointText.trimStart().startsWith(first)) {
    return withResumeAssignment(checkpointText, assignment, { closing: MANUAL_HANDOFF_CLOSING })
  }
  const context = typeof checkpointText === 'string' && checkpointText.trim()
    ? withResumeAssignment(checkpointText, null) : transcriptSeedText(transcript?.lines || [])
  const brief = typeof node?.message === 'string' ? node.message : ''
  const closing = MANUAL_HANDOFF_CLOSING
  const opening = [
    first,
    'This is a fresh conversation with a handoff, not a native resume of the previous provider thread.',
    extra,
    transcript?.recoveryDirectory
      ? `Complete saved conversation: ${transcript.recoveryDirectory}. Read the retained entries and full text files there when the checkpoint omits needed context. The original records remain available; this bounded checkpoint does not replace them.` : '',
    transcript?.threadId ? `Previous native thread: ${transcript.threadId}. Previous provider: ${transcript.provider || 'unrecorded'}.` : '',
    brief ? `Original task: ${brief}` : '',
  ].filter(Boolean).join('\n\n')
  const room = Math.max(0, 48000 - opening.length - closing.length - 4)
  return withResumeAssignment(`${opening}\n\n${context.slice(0, room)}\n\n${closing}`, assignment, { closing })
}
/* `assignment` ({ text, fromName }) is the next assignment an agent.resume
   carried (T1792); without one the handoff is unchanged. */
export function manualAccountHandoff(node, transcript, checkpoint, { assignment = null } = {}) {
  return composeManualHandoff(node, transcript, checkpoint, { opening: ACCOUNT_HANDOFF_OPENINGS[0], assignment })
}

/* THE MODEL SWITCH AS A CONTINUATION (owner request T137). The Claude CLI binds
   --model once at spawn and no thread crosses providers, so "switch to X" for a
   model the running thread cannot take in place means: end this session, start
   a fresh one on tier X, and send it this handoff. Both models are named so the
   new session knows what changed and what did not. */
export function manualModelHandoff(node, transcript, checkpoint, { fromLabel = 'unrecorded', toLabel = 'unrecorded', assignment = null } = {}) {
  return composeManualHandoff(node, transcript, checkpoint, { opening: MODEL_HANDOFF_OPENING, assignment,
    extra: `Previous model: ${fromLabel}. New model: ${toLabel}. The person chose the new model; the task, the place on the tree, the reports and the working rules are unchanged.` })
}
