// The outcome of a decision the owner ALREADY MADE, held somewhere a view
// cannot lose it.
//
// WHY THIS FILE EXISTS.
//
// Pressing "Submit decisions" on #/approvals starts an audited bridge call with
// a 30-second budget. The screen it was started from does not have to survive
// that call: src/main.js retires the outgoing view the moment a view transition
// swaps it, so one press of the forward arrow destroys the instance whose
// `await` is still in flight. That instance used to return before reading the
// answer -- `if (destroyed) return` sat above the `result.ok !== true` branch --
// and a REFUSAL was therefore dropped in silence. The refusal is the entire
// point: it says nothing was recorded, nothing was approved, and you can try
// again. Dropped, it is byte-for-byte identical to a success, on the one surface
// in this product where the difference between "approved" and "not approved" IS
// the product.
//
// So the outcome is written HERE first and painted second. This store outlives
// any single view instance, which is the whole point of it being a module rather
// than a local: the approvals screen restates it the next time it is on the
// glass, and home -- the screen the owner lands on every launch, and the screen
// the approvals design already nominated as its one signal channel -- counts it
// in the meantime.
//
// WHAT IT DELIBERATELY IS NOT.
//
// It is not durable across a restart. It is renderer memory, cleared when the
// window closes. That is a real limit and it is stated rather than hidden: what
// makes the record safe to *state* is that it is only ever shown against a
// prompt the queue still reports as pending, so the claim "nothing was approved"
// is corroborated by the engine every time it is displayed. A record that
// outlived its prompt would be a claim nobody re-checked, which is a worse
// failure than forgetting. Restart-durability would mean writing owner-decision
// state into renderer preference storage, which is not this file's to own.
//
// ABSENCE IS NEVER REASSURANCE HERE. A bridge that answered with no `reason`
// still produces a full sentence; a reconcile called with no live set prunes
// NOTHING, because "I was not told what is pending" must never be read as
// "nothing is pending" and quietly erase the fact that a decision was refused.

/** Fired on `window` whenever the undelivered set changes, so a screen that is
 *  already mounted (home) does not have to wait out its own poll interval to
 *  learn that a decision the owner made a second ago did not land. */
export const APPROVAL_OUTCOME_EVENT = 'mc:approval-outcome'

// promptId -> { promptId, reason, atMs }
const undelivered = new Map()
// Only in-flight decisions need a fence. A complete queue observation can
// retire one without losing unrelated outcomes or retaining historical IDs.
const pendingDecisions = new Map()

/** Track a decision before its bridge request. This handle outlives its view. */
export function beginDecisionOutcome(promptId) {
  const handle = Object.freeze({})
  pendingDecisions.set(handle, { promptId, retired: false })
  return handle
}

function finishDecisionOutcome(promptId, handle) {
  // Synchronous callers have no in-flight observation to fence.
  if (handle === undefined) return true
  const pending = pendingDecisions.get(handle)
  pendingDecisions.delete(handle)
  return Boolean(pending && pending.promptId === promptId && !pending.retired)
}

/* Used when the bridge refused without saying why, and when it said why in a
   way this screen will not repeat (empty string, not a string at all). The
   sentence still has to be true and still has to be a sentence. */
const UNSTATED_REASON = 'The audited bridge did not confirm it.'
const MAX_REASON = 300

function usableId(promptId) {
  return typeof promptId === 'string' && promptId.trim().length > 0 ? promptId : null
}

function usableReason(reason) {
  if (typeof reason !== 'string') return UNSTATED_REASON
  const trimmed = reason.trim()
  if (trimmed.length === 0) return UNSTATED_REASON
  return trimmed.length > MAX_REASON ? `${trimmed.slice(0, MAX_REASON - 1)}…` : trimmed
}

function announce() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  try { window.dispatchEvent(new CustomEvent(APPROVAL_OUTCOME_EVENT, { detail: { count: undelivered.size } })) }
  catch { /* a window that cannot take an event still has the store; the poll picks it up */ }
}

/**
 * Record that a decision the owner submitted was NOT confirmed as recorded.
 * Called before anything is painted and before the caller asks whether its own
 * view still exists, which is the fix this module was written for.
 *
 * Pass the handle from beginDecisionOutcome for an asynchronous decision.
 * A subsequent complete queue reading can retire it before its reply arrives.
 * @returns the stored entry, or null for an unusable id or retired handle.
 */
export function recordUndeliveredDecision(promptId, reason, atMs = Date.now(), handle) {
  const relevant = finishDecisionOutcome(promptId, handle)
  const id = usableId(promptId)
  if (!id || !relevant) return null
  const entry = Object.freeze({
    promptId: id,
    reason: usableReason(reason),
    atMs: Number.isFinite(atMs) ? atMs : Date.now(),
  })
  undelivered.set(id, entry)
  announce()
  return entry
}

/** A confirmed decision clears its own earlier failure. */
export function clearUndeliveredDecision(promptId, handle) {
  finishDecisionOutcome(promptId, handle)
  const id = usableId(promptId)
  if (!id || !undelivered.has(id)) return false
  undelivered.delete(id)
  announce()
  return true
}

/** @returns the frozen entry for this prompt, or null. Never a truthy default. */
export function undeliveredDecision(promptId) {
  const id = usableId(promptId)
  return id ? undelivered.get(id) || null : null
}

/** How many decisions the owner made are known not to have landed. */
export function undeliveredDecisionCount() {
  return undelivered.size
}

/** Every entry, newest first. Copies, so no caller can mutate the store. */
export function undeliveredDecisions() {
  return [...undelivered.values()].sort((a, b) => b.atMs - a.atMs)
}

/**
 * Drop records whose prompt is no longer pending, and return what is left.
 *
 * A prompt that has left the queue was decided, expired or withdrawn, and a
 * "your decision did not land" notice about it would be a claim nobody can
 * check any more. Keeping only the intersection is what lets every surface say
 * "nothing was approved" honestly: the notice is only ever shown while the
 * engine still reports the request as waiting.
 *
 * `liveIds` MUST be a genuine reading of the queue. Anything else -- null,
 * undefined, a non-array -- prunes NOTHING and returns the current count. Not
 * having read the queue is not the same as having read an empty one, and
 * treating it as one would erase exactly the record this module exists to keep.
 */
export function reconcileUndeliveredDecisions(liveIds) {
  if (!Array.isArray(liveIds)) return undelivered.size
  const live = new Set(liveIds.filter(id => usableId(id)))
  for (const pending of pendingDecisions.values()) {
    // Once a newer reading removes this attempt's prompt, an older snapshot
    // arriving afterwards must not make its delayed refusal relevant again.
    if (!live.has(pending.promptId)) pending.retired = true
  }
  let removed = 0
  for (const id of [...undelivered.keys()]) {
    if (!live.has(id)) { undelivered.delete(id); removed += 1 }
  }
  if (removed > 0) announce()
  return undelivered.size
}

/** Test seam. Not used by any view; the product never wipes this wholesale. */
export function resetUndeliveredDecisions() {
  const had = undelivered.size > 0
  undelivered.clear()
  pendingDecisions.clear()
  if (had) announce()
}
