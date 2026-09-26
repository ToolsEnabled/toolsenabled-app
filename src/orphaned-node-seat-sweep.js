/* LO-5 sweep admission is deliberately separate from the seat-release loop.
 *
 * fleet-trees.js has a failure-first persistence contract:
 * - an absent record is a valid empty store;
 * - unreadable/invalid saved bytes refuse store creation;
 * - a failed write remains visible as snapshot.persistenceFailed.
 *
 * A seat sweep cannot safely interpret an empty or unavailable tree snapshot as
 * proof that every node seat is orphaned. This module only evaluates that
 * health boundary; it performs no organisation write and releases no seat.
 */

const refusal = (code, reason) => Object.freeze({ ok: false, code, reason })

const SAFE_NODE_ID = /^[a-z0-9][a-z0-9._:/-]*$/i
const hasSoundNodeIds = nodes => {
  const ids = new Set()
  for (const node of nodes) {
    const id = node?.id
    if (typeof id !== 'string' || id.length === 0 || id.length > 128 || !SAFE_NODE_ID.test(id) || ids.has(id)) {
      return false
    }
    ids.add(id)
  }
  return true
}

const unreadableReason = supplied => typeof supplied === 'string' && supplied.trim()
  ? supplied
  : 'The saved trees could not be read. Orphaned node seats were not released.'

/**
 * Decide whether a caller may compare saved tree node ids with organisation
 * node-seat ids.
 *
 * The caller must stop before any release when ok is false. A successful
 * result carries the exact snapshot that was checked so the caller does not
 * read a second, potentially different snapshot before releasing anything.
 */
export function orphanedNodeSeatSweepReadiness({ store = null, storeProblem = '' } = {}) {
  if (!store || typeof store.snapshot !== 'function') {
    return refusal('TREE_STORE_UNREADABLE', unreadableReason(storeProblem))
  }

  let snapshot
  try {
    snapshot = store.snapshot()
  } catch {
    return refusal('TREE_STORE_UNREADABLE', unreadableReason(storeProblem))
  }

  if (!snapshot || !Array.isArray(snapshot.nodes)) {
    return refusal('TREE_STORE_UNREADABLE', unreadableReason(storeProblem))
  }

  if (!hasSoundNodeIds(snapshot.nodes)) {
    return refusal('TREE_STORE_UNREADABLE', unreadableReason(storeProblem))
  }

  if (snapshot.persistenceFailed === true) {
    const problem = typeof snapshot.persistenceProblem === 'string' && snapshot.persistenceProblem.trim()
      ? snapshot.persistenceProblem
      : 'the latest tree changes could not be saved'
    return refusal('TREE_STORE_PERSISTENCE_FAILED', `The saved trees are not durable (${problem}). Orphaned node seats were not released.`)
  }

  if (snapshot.nodes.length === 0) {
    return refusal('TREE_STORE_EMPTY', 'The saved trees are empty, so orphaned node seats were not released.')
  }

  return Object.freeze({ ok: true, snapshot })
}


/* A healthy snapshot is necessary but not sufficient for a repair proposal.
 * A partially restored tree can be healthy while still missing many nodes;
 * bounding one sweep keeps this repair a proposal-sized action. These are
 * deliberately small, declared limits: more than two candidate releases, or
 * more than one quarter of the node seats, is refused for a person to review.
 * A proposal with zero eligible candidates remains a successful no-op. */
export const ORPHANED_NODE_SEAT_SWEEP_LIMITS = Object.freeze({
  maxReleases: 2,
  maxFraction: 0.25,
})

const proposalRefusal = (code, reason) => refusal(code, `${reason} No seats were released.`)

/**
 * Validate the candidate list before admitting any release through the
 * persistence-health gate. An empty list requires no tree snapshot.
 * `candidateIds` is the caller's current node-seat list; `nodeSeatCount` is
 * the total count of node-shaped organisation seats used as the denominator.
 * This function performs no organisation write and releases no seat.
 */
export function orphanedNodeSeatSweepProposal({
  store = null,
  storeProblem = '',
  candidateIds = [],
  nodeSeatCount = 0,
} = {}) {
  if (!Array.isArray(candidateIds)) {
    return proposalRefusal(
      'TREE_SEAT_SWEEP_CANDIDATES_UNREADABLE',
      'The organisation node-seat candidates could not be read.',
    )
  }

  // An authoritative empty candidate list cannot release anything. Keep it
  // silent without treating an unreadable tree store as a healthy snapshot.
  if (candidateIds.length === 0) {
    return Object.freeze({ ok: true, snapshot: null, candidateIds: [], nodeSeatCount: 0, fraction: 0 })
  }
  const readiness = orphanedNodeSeatSweepReadiness({ store, storeProblem })
  if (!readiness.ok) return readiness

  const liveIds = new Set(readiness.snapshot.nodes.map(node => node.id))
  const seen = new Set()
  const eligibleIds = []
  for (const id of candidateIds) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128 || !SAFE_NODE_ID.test(id)) {
      return proposalRefusal(
        'TREE_SEAT_SWEEP_CANDIDATES_UNREADABLE',
        'An unused agent slot has an invalid identifier. Reopen Computers to read the organisation again.',
      )
    }
    if (seen.has(id)) continue
    seen.add(id)
    if (!liveIds.has(id)) eligibleIds.push(id)
  }

  /* Empty is a valid, successful sweep outcome. Do not require a denominator
     or turn an already-repaired org into an error. */
  if (eligibleIds.length === 0) {
    return Object.freeze({ ok: true, snapshot: readiness.snapshot, candidateIds: [], nodeSeatCount: 0, fraction: 0 })
  }

  if (!Number.isSafeInteger(nodeSeatCount) || nodeSeatCount <= 0) {
    return proposalRefusal(
      'TREE_SEAT_SWEEP_COUNT_UNREADABLE',
      'The total node-seat count could not be read for this proposal.',
    )
  }
  if (eligibleIds.length > ORPHANED_NODE_SEAT_SWEEP_LIMITS.maxReleases) {
    return proposalRefusal(
      'TREE_SEAT_SWEEP_COUNT_BOUND',
      `The proposal names ${eligibleIds.length} candidate releases; the safety bound is ${ORPHANED_NODE_SEAT_SWEEP_LIMITS.maxReleases}.`,
    )
  }

  const fraction = eligibleIds.length / nodeSeatCount
  if (fraction > ORPHANED_NODE_SEAT_SWEEP_LIMITS.maxFraction) {
    return proposalRefusal(
      'TREE_SEAT_SWEEP_FRACTION_BOUND',
      `The proposal names ${eligibleIds.length} of ${nodeSeatCount} node seats (${Math.round(fraction * 100)}%); the safety bound is 25%.`,
    )
  }

  return Object.freeze({
    ok: true,
    snapshot: readiness.snapshot,
    candidateIds: Object.freeze(eligibleIds),
    nodeSeatCount,
    fraction,
  })
}

/* THE STANDALONE FORM (T1365). A + agent tab declares a `standalone-<uuid>`
 * seat before its chat exists (tree-workspace.js openStandalone). Closing a
 * never-sent tab releases it, but a tab lost to a restart or a crash never
 * closes, and the node sweep above only looks at `node-<n>-` seats, so those
 * seats stayed enabled forever and counted toward the organisation's bound.
 *
 * A standalone seat is a release candidate only when this window holds no tab
 * or pending declaration for it (`heldIds`) and no saved tree node names it;
 * the caller also proves, seat by seat, that it has no saved conversation.
 *
 * LO-5 holds here exactly as for node seats (T832, T1232): with nothing to
 * release the sweep is a silent no-op and reads no tree; with anything to
 * release, an empty, unreadable or non-durable tree store refuses and releases
 * nothing, because a wiped or half-restored profile is exactly when "no tab,
 * no conversation" cannot be trusted. At most `maxReleases` seats are proposed
 * per load; the rest wait for the next one, each checked again then. */
export const STANDALONE_SEAT_ID = /^standalone-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/* The same health gate as node seats, worded for + agent seats. */
export function orphanedStandaloneSeatSweepReadiness({ store = null, storeProblem = '' } = {}) {
  const readiness = orphanedNodeSeatSweepReadiness({ store, storeProblem })
  if (readiness.ok) return readiness
  return refusal(readiness.code, readiness.code === 'TREE_STORE_EMPTY'
    ? 'The saved trees are empty, so unused agent-tab seats were not released. They are checked again the next time Computers opens.'
    : readiness.reason.replace('Orphaned node seats were not released.', 'Unused agent-tab seats were not released.'))
}

export function orphanedStandaloneSeatSweepProposal({
  store = null,
  storeProblem = '',
  candidateIds = [],
  heldIds = null,
} = {}) {
  if (!Array.isArray(candidateIds)) {
    return proposalRefusal(
      'TREE_SEAT_SWEEP_CANDIDATES_UNREADABLE',
      'The organisation agent-tab seats could not be read.',
    )
  }
  if (!(heldIds instanceof Set)) {
    return proposalRefusal(
      'TREE_SEAT_SWEEP_HELD_UNREADABLE',
      'The open agent tabs could not be read.',
    )
  }
  const seen = new Set()
  const unheld = []
  for (const id of candidateIds) {
    if (typeof id !== 'string' || !STANDALONE_SEAT_ID.test(id)) {
      return proposalRefusal(
        'TREE_SEAT_SWEEP_CANDIDATES_UNREADABLE',
        'An agent-tab seat has an invalid identifier. Reopen Computers to read the organisation again.',
      )
    }
    if (seen.has(id)) continue
    seen.add(id)
    if (!heldIds.has(id)) unheld.push(id)
  }
  // Nothing this window does not hold: nothing to release, no tree read.
  if (unheld.length === 0) return Object.freeze({ ok: true, snapshot: null, candidateIds: Object.freeze([]) })

  const readiness = orphanedStandaloneSeatSweepReadiness({ store, storeProblem })
  if (!readiness.ok) return readiness
  const named = new Set(readiness.snapshot.nodes.map(node => node.id))
  const eligibleIds = unheld.filter(id => !named.has(id))
  return Object.freeze({
    ok: true,
    snapshot: readiness.snapshot,
    candidateIds: Object.freeze(eligibleIds.slice(0, ORPHANED_NODE_SEAT_SWEEP_LIMITS.maxReleases)),
  })
}
