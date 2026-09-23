import { transcriptSeedText } from './session-transcript-store.js'

export const MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY = 'Open the ToolsEnabled app on that computer to continue on another account.'

/* THE SENTENCES A CONTINUATION HANDOFF OPENS WITH. A conversation continued on
   another account starts from a handoff of up to 48,000 characters, sent from the
   person's side, so every chat surface painted it as a wall of text in the
   person's colour. The chat folds it into one line instead
   (src/views/computers.js markTreeContext), recognised by these openings and
   never by guessing at prose: the manual continuation below, and the shell's
   automatic recovery (shell/account-session-recovery.cjs recoveryHandoff; a test
   holds the two copies of that sentence together). */
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

// This is a fresh conversation with a visible handoff, never the old provider's
// native thread opened under another credential. Prefer the full checkpoint
// only when it belongs to this exact session; otherwise use the saved excerpt.
function composeManualHandoff(node, transcript, checkpoint, { opening: first, extra = '' } = {}) {
  const checkpointText = checkpoint?.sessionId === node?.sessionId ? checkpoint?.handoff : null
  // A failed replacement already saved the composed manual handoff. Reusing
  // it keeps retries from nesting headers and trimming away more context --
  // when it is the same kind of continuation. An account handoff is not
  // reused as a model handoff, or the fold would name the wrong reason.
  if (checkpoint?.kind === 'manual' && typeof checkpointText === 'string' && checkpointText.trim()
      && checkpointText.trimStart().startsWith(first)) return checkpointText
  const context = typeof checkpointText === 'string' && checkpointText.trim()
    ? checkpointText : transcriptSeedText(transcript?.lines || [])
  const brief = typeof node?.message === 'string' ? node.message : ''
  const closing = 'Preserve completed work and continue the remaining task. The current tree address below supersedes earlier names and reporting relationships.'
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
  return `${opening}\n\n${context.slice(0, room)}\n\n${closing}`
}
export function manualAccountHandoff(node, transcript, checkpoint) {
  return composeManualHandoff(node, transcript, checkpoint, { opening: ACCOUNT_HANDOFF_OPENINGS[0] })
}

/* THE MODEL SWITCH AS A CONTINUATION (owner request T137). The Claude CLI binds
   --model once at spawn and no thread crosses providers, so "switch to X" for a
   model the running thread cannot take in place means: end this session, start
   a fresh one on tier X, and send it this handoff. Both models are named so the
   new session knows what changed and what did not. */
export function manualModelHandoff(node, transcript, checkpoint, { fromLabel = 'unrecorded', toLabel = 'unrecorded' } = {}) {
  return composeManualHandoff(node, transcript, checkpoint, { opening: MODEL_HANDOFF_OPENING,
    extra: `Previous model: ${fromLabel}. New model: ${toLabel}. The person chose the new model; the task, the place on the tree, the reports and the working rules are unchanged.` })
}

// Owner, 2026-09-10: a Codex astra/max node stands in on Claude Opus at the
// same depth, a Claude node exhausts its own accounts first, and Gemini/Grok
// ("the absolute easiest work") come last and only when allowed.
export function accountRetryCandidates(preferredTier, tiers, accounts) {
  const choices = [preferredTier, 'claude-opus', 'astra', 'claude-fable', 'agy-gemini-3-8-flash-high', 'gemini-3-1-pro', 'grok-4-6']
  const selected = new Set()
  return choices.filter(id => {
    const tier = (tiers || []).find(row => row.id === id)
    const compatible = tier && (accounts || []).some(account => account.provider === tier.provider
      && (account.client || null) === (tier.client || null))
    if (!compatible || selected.has(tier.provider)) return false
    selected.add(tier.provider)
    return true
  })
}

// Gemini and Grok are opt-in fallbacks except for an agent already on them.
export function defaultRetryProviders(provider) {
  return ['codex', 'claude', ...(['gemini', 'grok'].includes(provider) ? [provider] : [])]
}

export function accountRetryStatus(policy, { busy = false, stopped = false, warning = null, compact = false } = {}) {
  if (!policy?.enabled) return warning || ''
  const suffix = warning ? ` ${warning}` : ''
  if (policy.state === 'starting') return 'Trying another signed-in account or provider…' + suffix
  if (policy.state === 'working') {
    // The chat selector already shows the enabled policy. Keep persistence
    // warnings visible without repeating the normal policy explanation.
    if (compact) return stopped ? 'Stopped by you. Resume or send work to continue.' + suffix : warning || ''
    if (stopped) return 'Keep trying accounts is on, but you stopped this agent. Nothing starts until you resume it or send it work.' + suffix
    return (busy ? 'Keep trying accounts is on. The current agent is working.'
      : 'Keep trying accounts is on. This agent is idle; retries start only if its next turn hits an account limit or its program stops.') + suffix
  }
  if (policy.state === 'no-direction') return 'Automatic retries paused: no actionable open task is available.' + suffix
  if (policy.state === 'paused') {
    const again = Number.isFinite(policy.autoResumeAt) ? ` Checking again at ${new Date(policy.autoResumeAt).toLocaleString()}.` : ''
    return `Account retries paused: ${policy.reason || 'review this agent before continuing.'}${again}` + suffix
  }
  if (policy.nextAttemptAt) {
    const when = new Date(policy.nextAttemptAt).toLocaleString()
    return (policy.resetAt ? `Waiting for allowance to reset. Next attempt: ${when}.`
      : `Reset time is unknown. Next account check: ${when}.`) + suffix
  }
  return 'No eligible account is available now. Turn on waiting to check again after resets.' + suffix
}
