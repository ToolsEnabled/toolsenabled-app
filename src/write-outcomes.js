// The answer to a WRITE that was already sent, held somewhere a torn-down view
// cannot lose it.
//
// WHY THIS FILE EXISTS.
//
// src/approval-outcomes.js was written for one surface after one measurement:
// #/approvals sent a real decision, the owner pressed an arrow, the router
// retired the view instance, and `if (destroyed) return` — sitting ABOVE the
// branch that reads `result.ok` — threw the answer away. A refusal became
// byte-for-byte identical to a success.
//
// That shape is not unique to approvals. Sweeping every `if (destroyed)` site in
// src/ found the same defect on seven more paths, and each of them had already
// SPENT something before the guard ran:
//
//   * a Codex Cloud launch — real, billable, remote work the product's own copy
//     says "cannot be cancelled once it is accepted". The dropped value is the
//     task id: the only handle the person has on work they are paying for.
//   * a ledger archive with dryRun:false — an owner request's disposition
//     appended to the durable overlay.
//   * a loop stop — a terminate sent against a real PID, whose receipt is the
//     only thing that distinguishes "the run is gone" from "it was NOT confirmed
//     stopped and may still be running".
//   * a team dispatch — real agent lanes started, each answering with a launch
//     id nothing else on the machine will tell you.
//   * the audited ledger's decision and strict queue-transition forms — a
//     durable decision record, and a BUILD-QUEUE phase claimed or closed.
//
// In every one of them the write had already happened when the guard fired.
// `destroyed` says this view instance has no DOM left to write to. It says
// nothing whatever about whether the thing the person asked for happened, and
// reading it first is what turns "it failed" and "it worked" into the same
// silence.
//
// So the outcome is filed HERE first and painted second. This store outlives any
// single view or controller instance — that is the whole point of it being a
// module rather than a local — and the surface that sent the write restates it
// the next time it is on the glass.
//
// WHAT IT DELIBERATELY IS NOT.
//
// It is not durable across a restart. It is renderer memory, cleared when the
// window closes, and that is stated rather than hidden. It is also not a second
// source of truth: every restated sentence is the sentence the surface would
// have shown at the time, carried forward and labelled as having been missed —
// never a new claim about what is true NOW. A surface that can re-read the
// authoritative fact (the cloud task list, the ledger) is expected to do so; the
// restatement exists so the person knows there is something to go and look at.
//
// ABSENCE IS NEVER REASSURANCE HERE. A record with no usable surface key, or no
// usable sentence, is NOT filed — an entry nothing can attribute and nothing can
// clear would sit on a screen forever. And nothing is ever pruned on the
// strength of a reading that did not happen: only a DELIVERED later outcome on
// the same surface supersedes an earlier missed one.

/** Fired on `window` whenever the missed set changes, so a surface that is
 *  already mounted does not have to wait out its own poll to learn there is
 *  something to restate. */
export const WRITE_OUTCOME_EVENT = 'mc:write-outcome'

/* Every surface key the product actually uses, in one place, so a stranger can
   see the whole set without grepping. The store itself takes any non-empty
   string; this is documentation with a runtime check behind it (below). */
export const WRITE_OUTCOME_KEYS = Object.freeze({
  CLOUD_LAUNCH: 'cloud-launch',
  LEDGER_ARCHIVE: 'ledger-archive',
  LOOP_STOP: 'loop-stop',
  TEAM_DISPATCH: 'team-dispatch',
  BRIDGE_DISPATCH: 'bridge-dispatch',
  BRIDGE_DECISION: 'bridge-decision',
  BRIDGE_QUEUE: 'bridge-queue',
  SESSION_OUTBOX: 'session-outbox',
})

// surfaceKey -> { key, tone, message, atMs }
const missed = new Map()

const MAX_MESSAGE = 600
const TONES = new Set(['confirmed', 'refused', 'note'])

function usableKey(key) {
  return typeof key === 'string' && key.trim().length > 0 ? key.trim() : null
}

function usableMessage(message) {
  if (typeof message !== 'string') return null
  const trimmed = message.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > MAX_MESSAGE ? `${trimmed.slice(0, MAX_MESSAGE - 1)}…` : trimmed
}

/* An unrecognised tone is read as `refused`, NOT as `confirmed`. A caller that
   forgot to say how its outcome went has not said it went well, and the one
   direction this store must never invent is reassurance. */
function usableTone(tone) {
  return TONES.has(tone) ? tone : 'refused'
}

function announce() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  try { window.dispatchEvent(new CustomEvent(WRITE_OUTCOME_EVENT, { detail: { count: missed.size } })) }
  catch { /* a window that cannot take an event still has the store */ }
}

/**
 * File the outcome of a write whose surface was gone before it could be shown.
 *
 * Call this BEFORE asking whether the view still exists — that ordering is the
 * entire fix. One entry per surface: the newest missed outcome for a surface
 * replaces an older missed one, because the surface has only one place to say it
 * and the newer sentence describes the newer write.
 *
 * @returns the stored entry, or null when there is nothing usable to file.
 */
export function recordUndeliveredWrite(key, { tone, message, atMs = Date.now() } = {}) {
  const surface = usableKey(key)
  const text = usableMessage(message)
  if (!surface || !text) return null
  const entry = Object.freeze({
    key: surface,
    tone: usableTone(tone),
    message: text,
    atMs: Number.isFinite(atMs) ? atMs : Date.now(),
  })
  missed.set(surface, entry)
  announce()
  return entry
}

/**
 * A later outcome that DID reach a screen supersedes an earlier missed one.
 * Called only on the delivered path (`destroyed === false`), because "the
 * surface was rebuilt" is not the same as "the person was told".
 */
export function clearUndeliveredWrite(key) {
  const surface = usableKey(key)
  if (!surface || !missed.has(surface)) return false
  missed.delete(surface)
  announce()
  return true
}

/** @returns the frozen entry for this surface, or null. Never a truthy default. */
export function undeliveredWrite(key) {
  const surface = usableKey(key)
  return surface ? missed.get(surface) || null : null
}

/** How many surfaces are holding an outcome nobody has been shown. */
export function undeliveredWriteCount() {
  return missed.size
}

/** Every entry, newest first. Copies, so no caller can mutate the store. */
export function undeliveredWrites() {
  return [...missed.values()].sort((a, b) => b.atMs - a.atMs)
}

/**
 * The sentence a surface prints when it comes back and finds one of these.
 *
 * It says WHEN, so the person can tell it apart from something that just
 * happened, and it never restates the outcome as if it were news from now.
 */
export function restatedMessage(entry) {
  if (!entry || typeof entry.message !== 'string' || entry.message.length === 0) return ''
  return `While you were on another screen: ${entry.message}`
}

/** Test seam. Not used by any surface; the product never wipes this wholesale. */
export function resetUndeliveredWrites() {
  const had = missed.size > 0
  missed.clear()
  if (had) announce()
}
