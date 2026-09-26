/* WHICH THREAD A RESUME MAY CONTINUE, decided in one place.
 *
 * MEASURED 2026-09-02: three tree nodes whose saved thread came from a Codex
 * session were resumed after their tier had been changed to a Claude tier. The
 * shell dutifully ran `claude --resume <codex thread id>`, the CLI answered
 * "No conversation found with session ID" and exited in about three seconds,
 * and the node showed "did not start" with nothing to say why. A thread
 * belongs to the provider that wrote it; a resume onto another provider is
 * refused by name; starting fresh remains an explicit choice.
 *
 * `savedProvider` is what the transcript record remembers from the session
 * that produced the thread. A record from before that field existed carries
 * null, and null is honoured as "unknown": the thread is offered exactly as it
 * always was, because refusing every old record would turn one measured
 * defect into a regression for everybody who never changed a tier. */
// Keep renderer refusal names and wording aligned with shell/agent-host.cjs.
const PROVIDER_NAMES = Object.freeze({ codex: 'Codex', claude: 'Claude', local: 'the local model' })
const providerName = value => Object.hasOwn(PROVIDER_NAMES, value) ? PROVIDER_NAMES[value] : value

export function resumableThread({ savedThreadId = null, savedProvider = null, provider = null } = {}) {
  const threadId = typeof savedThreadId === 'string' && savedThreadId.length > 0 ? savedThreadId : null
  if (!threadId) return Object.freeze({ threadId: null, reason: 'no-thread' })
  const before = typeof savedProvider === 'string' && savedProvider ? savedProvider : null
  const now = typeof provider === 'string' && provider ? provider : null
  if (before && now && before !== now) {
    const seat = providerName(now)
    return Object.freeze({
      threadId: null,
      reason: 'provider-changed',
      savedProvider: before,
      provider: now,
      message: `This conversation belongs to ${providerName(before)} and cannot be continued with ${seat}. Starting a new conversation with ${seat} will work.`,
    })
  }
  // Native Grok reloads repeatedly started a session that failed before its
  // first message was accepted (LIVE hand checks, 2026-09-12). The existing
  // transcript-seeded continuation succeeds with the current tool wiring.
  // Preserve that saved conversation and use the working tree resume path.
  if (now === 'grok') return Object.freeze({ threadId: null, reason: 'transcript-resume' })
  return Object.freeze({ threadId, reason: null })
}
