/*
 * Presentation-only projection for the canonical Ledger handoff object.
 *
 * The native reader is responsible for selecting one authoritative handoff
 * operation. This helper deliberately consumes that already-selected object;
 * it never searches a journal, changes a task, or infers a status from one.
 * Missing or contradictory evidence is visible as unknown rather than being
 * promoted to owner-gone or successfully published.
 */

export const HANDOFF_VISIBILITY_TEXT = Object.freeze({
  ownerGone: 'This task has no available owner.',
  unconfirmed: 'Removal is not yet confirmed.',
  unknown: 'The handoff state could not be confirmed.',
})

const MAX_ID_LENGTH = 256
const MAX_REASON_LENGTH = 2048
const MAX_JOURNAL_STRING = 512
const PUBLICATION_UNCONFIRMED = new Set(['pending', 'uncertain'])
const SOURCE_BARRIER_RETAINED = new Set(['pending', 'retained'])
const DESTINATION_KINDS = new Set(['verified-parent', 'verified-no-parent'])

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const text = (value, limit = MAX_ID_LENGTH) => typeof value === 'string' && value.length > 0
  ? value.slice(0, limit)
  : null

function copyJournal(value) {
  if (value === null || value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.freeze({
    sequence: Number.isSafeInteger(value.sequence) ? value.sequence : null,
    ledgerRevision: Number.isSafeInteger(value.ledgerRevision) ? value.ledgerRevision : null,
    eventSha256: typeof value.eventSha256 === 'string' ? value.eventSha256.slice(0, MAX_JOURNAL_STRING) : null,
    operationSha256: typeof value.operationSha256 === 'string' ? value.operationSha256.slice(0, MAX_JOURNAL_STRING) : null,
  })
}

function copyDestination(value) {
  if (value === null || value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.freeze({
    kind: text(value.kind),
    parentNodeId: value.parentNodeId === null || value.parentNodeId === undefined ? null : text(value.parentNodeId),
    parentTreeId: value.parentTreeId === null || value.parentTreeId === undefined ? null : text(value.parentTreeId),
    parentLabel: value.parentLabel === null || value.parentLabel === undefined ? null : text(value.parentLabel, MAX_REASON_LENGTH),
  })
}

function normalizeHandoff(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const normalized = {
    operationId: text(value.operationId),
    phase: text(value.phase),
    sourceBarrier: text(value.sourceBarrier),
    sourceTombstone: typeof value.sourceTombstone === 'boolean' ? value.sourceTombstone : null,
    sourcePreimageRetained: typeof value.sourcePreimageRetained === 'boolean' ? value.sourcePreimageRetained : null,
    publicationState: text(value.publicationState),
    publicationReasonCode: text(value.publicationReasonCode),
    sourceNodeId: text(value.sourceNodeId),
    ownerState: value.ownerState === null || value.ownerState === undefined ? null : text(value.ownerState),
    ownerNodeId: value.ownerNodeId === null || value.ownerNodeId === undefined ? null : text(value.ownerNodeId),
    destination: copyDestination(value.destination),
    reason: text(value.reason, MAX_REASON_LENGTH),
    journal: copyJournal(value.journal),
  }
  return Object.freeze(normalized)
}

function hasRequiredShape(source, normalized) {
  /* These fields are the producer's authority-bearing envelope. A partial
     object must not become a person-facing owner or publication assertion. */
  return normalized.operationId !== null
    && normalized.phase !== null
    && normalized.sourceTombstone !== null
    && normalized.sourcePreimageRetained !== null
    && normalized.sourceBarrier !== null
    && normalized.publicationState !== null
    && normalized.sourceNodeId !== null
    && hasOwn(source, 'ownerState')
    && hasOwn(source, 'ownerNodeId')
    && (source.ownerState === null || source.ownerState === undefined || normalized.ownerState !== null)
    && (source.ownerNodeId === null || source.ownerNodeId === undefined || normalized.ownerNodeId !== null)
    && validDestination(normalized.destination)
    && validJournal(normalized.journal)
}

function displayReason(normalized) {
  const reason = normalized.reason
  /* A machine code is retained structurally, never repeated as human copy. */
  if (!reason || /^[A-Z][A-Z0-9_:.-]{2,127}$/.test(reason)) return null
  return reason
}

function validDestination(destination) {
  if (!destination || !DESTINATION_KINDS.has(destination.kind)) return false
  if (destination.kind === 'verified-parent') {
    return typeof destination.parentNodeId === 'string' && destination.parentNodeId !== ''
      && typeof destination.parentTreeId === 'string' && destination.parentTreeId !== ''
  }
  return destination.parentNodeId === null
}

function noParentDestination(destination) {
  return destination?.kind === 'verified-no-parent' && destination.parentNodeId === null
}

function validJournal(journal) {
  return journal
    && Number.isSafeInteger(journal.sequence) && journal.sequence > 0
    && Number.isSafeInteger(journal.ledgerRevision) && journal.ledgerRevision > 0
    && /^[a-f0-9]{64}$/.test(journal.eventSha256 || '')
    && /^[a-f0-9]{64}$/.test(journal.operationSha256 || '')
}

function validPhaseState(handoff) {
  if (handoff.phase === 'prepared') {
    return handoff.sourceBarrier === 'pending'
      && handoff.publicationState === 'pending'
      && handoff.sourcePreimageRetained === true
      && handoff.sourceTombstone === false
  }
  if (handoff.phase === 'committed') {
    return handoff.sourceBarrier === 'retained'
      && handoff.publicationState === 'uncertain'
      && handoff.sourcePreimageRetained === true
      && handoff.sourceTombstone === false
  }
  if (handoff.phase === 'finalized') {
    return handoff.sourceBarrier === 'released'
      && handoff.publicationState === 'confirmed'
      && handoff.sourcePreimageRetained === false
      && handoff.sourceTombstone === true
  }
  return false
}

function validOwnerState(handoff) {
  if (handoff.phase === 'prepared') {
    if (handoff.ownerState === null && handoff.ownerNodeId === null) return true
    return handoff.ownerState === 'reassigned' && handoff.ownerNodeId === handoff.sourceNodeId
  }

  if (handoff.destination.kind === 'verified-parent') {
    return handoff.ownerState === 'reassigned'
      && handoff.ownerNodeId === handoff.destination.parentNodeId
  }

  if (handoff.destination.kind === 'verified-no-parent') {
    return handoff.ownerState === 'owner-gone' && handoff.ownerNodeId === null
  }

  return false
}

function result(state, handoff, reason = null, secondaryState = null) {
  const base = {
    state,
    visible: state === 'owner-gone' || state === 'unconfirmed' || state === 'unknown',
    text: state === 'owner-gone'
      ? HANDOFF_VISIBILITY_TEXT.ownerGone
      : state === 'unconfirmed'
        ? HANDOFF_VISIBILITY_TEXT.unconfirmed
        : state === 'unknown'
          ? HANDOFF_VISIBILITY_TEXT.unknown
          : null,
    reason,
    handoff,
    ...(secondaryState ? { secondaryState } : {}),
  }
  return Object.freeze(base)
}

/**
 * Project one authoritative handoff object to safe display state.
 *
 * `value` is intentionally the selected handoff itself, not an array of
 * operations. `handoffVisibility(record)` below is the row-shaped adapter.
 */
export function projectHandoffVisibility(value) {
  if (value === null || value === undefined) return result('none', null)
  const normalized = normalizeHandoff(value)
  if (!normalized || !hasRequiredShape(value, normalized)) return result('unknown', normalized)
  if (!validPhaseState(normalized)) return result('unknown', normalized)
  if (!validOwnerState(normalized)) return result('unknown', normalized)

  const ownerGone = normalized.ownerState === 'owner-gone'
    && normalized.ownerNodeId === null
    && noParentDestination(normalized.destination)
    && (normalized.sourceTombstone === true || normalized.sourcePreimageRetained === true)
  if (ownerGone) {
    const uncertain = PUBLICATION_UNCONFIRMED.has(normalized.publicationState)
    return result('owner-gone', normalized, displayReason(normalized), uncertain ? 'unconfirmed' : null)
  }

  const retainedUnconfirmed = normalized.sourcePreimageRetained === true
    && SOURCE_BARRIER_RETAINED.has(normalized.sourceBarrier)
    && PUBLICATION_UNCONFIRMED.has(normalized.publicationState)
    && normalized.ownerState !== 'owner-gone'
    && validDestination(normalized.destination)
  if (retainedUnconfirmed) return result('unconfirmed', normalized, displayReason(normalized))

  const confirmed = normalized.phase === 'finalized'
    && normalized.sourceBarrier === 'released'
    && normalized.sourceTombstone === true
    && normalized.sourcePreimageRetained === false
    && normalized.publicationState === 'confirmed'
  if (confirmed) return result('confirmed', normalized)

  return result('unknown', normalized)
}

/** Adapt a canonical ledger row without reading its task status. */
export function handoffVisibility(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return projectHandoffVisibility(null)
  return projectHandoffVisibility(record.handoff)
}
