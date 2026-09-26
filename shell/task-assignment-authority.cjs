'use strict'

const crypto = require('node:crypto')

/* Native admission for the saved-node removal boundary.
 *
 * This module is deliberately a small coordinator, not a second Ledger
 * writer. The authenticated main process supplies the private task-writer
 * capability, the complete saved-forest reader, and the durable fleet
 * read-back seam. Renderer bytes, actor labels and target settings never
 * become authority here. A prepared or uncertain operation holds a barrier;
 * only a committed operation whose exact source disappearance is observed may
 * pass the topology write gate, and finalization still requires durable
 * read-back. */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const PHASES = new Set(['prepared', 'committed', 'finalized'])
const ACTIVE_BARRIER_STATES = new Set(['preparing', 'prepared', 'committing', 'committed', 'unknown'])
const OWNER_GONE_MODES = Object.freeze({
  'privacy-exit': 'privacy cleanup on exit',
  'full-reset': 'full reset',
})

const CODES = Object.freeze({
  UNAVAILABLE: 'TASK_TOPOLOGY_ADMISSION_UNAVAILABLE',
  UNKNOWN: 'TASK_TOPOLOGY_AUTHORITY_UNKNOWN',
  INVALID: 'TASK_TOPOLOGY_REQUEST_INVALID',
  CONFLICT: 'TASK_TOPOLOGY_OPERATION_CONFLICT',
  SOURCE_HELD: 'TASK_TOPOLOGY_SOURCE_HELD',
  WRITE_REFUSED: 'TASK_TOPOLOGY_WRITE_REFUSED',
  READBACK_UNCONFIRMED: 'TASK_TOPOLOGY_READBACK_UNCONFIRMED',
})

function fail(code, reason) {
  const error = new Error(reason)
  error.code = code
  return error
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonical(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(String(value))
}

function forestToken(forest) {
  return crypto.createHash('sha256').update(canonical({
    computerId: forest.computerId,
    nodes: forest.nodes,
    trees: forest.trees,
  })).digest('hex')
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function cleanupForestToken(forests) {
  return crypto.createHash('sha256').update(canonical((Array.isArray(forests) ? forests : [])
    .map(forest => ({ computerId: forest.computerId, nodes: forest.nodes, trees: forest.trees }))
    .sort((left, right) => left.computerId.localeCompare(right.computerId)))).digest('hex')
}

function sortedNodes(nodes) {
  return [...nodes].sort((left, right) => String(left?.id || '').localeCompare(String(right?.id || '')))
}

function sortedTrees(trees) {
  return [...trees].sort((left, right) => canonical(left).localeCompare(canonical(right)))
}

function removalPostimageCanonical(forest, sourceNodeId) {
  const nodes = forest.nodes.filter(node => node?.id !== sourceNodeId)
  const source = forest.nodes.find(node => node?.id === sourceNodeId)
  const trees = source && nodes.some(node => node?.treeId === source.treeId)
    ? forest.trees
    : (source ? forest.trees.filter(tree => tree?.id !== source.treeId) : forest.trees)
  return canonical({ nodes: sortedNodes(nodes), trees: sortedTrees(trees) })
}

function boundedId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw fail(CODES.INVALID, `A removal ${label} is not a valid saved identity.`)
  return value
}

function boundedReason(value) {
  if (typeof value !== 'string') throw fail(CODES.INVALID, 'A removal needs a durable reason.')
  const reason = value.trim()
  if (!reason || reason.length > 512 || /[\u0000-\u001f\u007f]/.test(reason)) throw fail(CODES.INVALID, 'A removal reason is empty or invalid.')
  return reason
}

function promiseLike(value) {
  return value && typeof value.then === 'function'
}

function frozenCopy(value) {
  return plain(value) ? Object.freeze({ ...value }) : value
}

function coordinatorIdentityOf(value) {
  if (!plain(value)) throw fail(CODES.UNKNOWN, 'The host coordinator identity is unavailable. The saved node was kept.')
  const actor = value.actor === undefined
    ? (value.nodeId === undefined || value.nodeId === null ? 'human' : 'agent')
    : value.actor
  const nodeId = value.nodeId === undefined ? null : value.nodeId
  const hostSessionId = value.hostSessionId === undefined ? value.sessionId : value.hostSessionId
  if (!['human', 'agent'].includes(actor)
      || (nodeId !== null && (typeof nodeId !== 'string' || !SAFE_ID.test(nodeId)))
      || typeof hostSessionId !== 'string' || !SAFE_ID.test(hostSessionId)
      || !Number.isSafeInteger(value.orgRevision) || value.orgRevision < 0
      || (actor === 'human' && nodeId !== null)) {
    throw fail(CODES.UNKNOWN, 'The host coordinator identity is incomplete or ambiguous. The saved node was kept.')
  }
  return Object.freeze({ actor, nodeId, hostSessionId, orgRevision: value.orgRevision })
}

function taskLedgerOptionsFor(input, authority, readCoordinatorIdentity) {
  if (typeof readCoordinatorIdentity !== 'function') return undefined
  let identity
  try {
    identity = coordinatorIdentityOf(readCoordinatorIdentity(Object.freeze({
      operationId: input.operationId,
      sourceNodeId: input.sourceNodeId,
      ...(authority?.parentNodeId ? { parentNodeId: authority.parentNodeId } : {}),
    })))
  } catch (error) {
    throw fail(error?.code || CODES.UNKNOWN, error?.message || 'The host coordinator identity is unavailable. The saved node was kept.')
  }
  const sourcePreimageSha256 = authority?.sourcePreimage
    ? sha256(canonical(authority.sourcePreimage)) : null
  const reservation = Object.freeze({
    token: `task-ledger-${crypto.randomUUID()}`,
    operationId: input.operationId,
    sourceNodeId: authority?.sourceNodeId ?? null,
    parentNodeId: authority?.parentNodeId ?? null,
    parentTreeId: authority?.parentTreeId ?? null,
    sourcePreimageSha256,
    ...(authority?.topologyToken ? { topologyToken: authority.topologyToken } : {}),
    orgRevision: identity.orgRevision,
  })
  return Object.freeze({ reservation, coordinatorIdentity: identity })
}

function cleanupTaskLedgerOptionsFor(input, readCoordinatorIdentity) {
  if (typeof readCoordinatorIdentity !== 'function') return undefined
  return taskLedgerOptionsFor(input, {
    sourceNodeId: null,
    parentNodeId: null,
    topologyToken: input.topologyToken,
  }, readCoordinatorIdentity)
}

function receiptFieldsMatchPhase(receipt, phase) {
  if (phase === 'prepared') {
    return receipt.sourceBarrier === 'pending'
      && receipt.sourcePreimageRetained === true
      && receipt.sourceTombstone === false
  }
  if (phase === 'committed') {
    return receipt.sourceBarrier === 'retained'
      && receipt.sourcePreimageRetained === true
      && receipt.sourceTombstone === false
  }
  return phase === 'finalized'
    && receipt.sourceBarrier === 'released'
    && receipt.sourcePreimageRetained === false
    && receipt.sourceTombstone === true
}

function durableReceipt(receipt, operationId, allowedPhases, label) {
  if (promiseLike(receipt) || !plain(receipt) || receipt.durable !== true
      || receipt.operationId !== operationId || !PHASES.has(receipt.phase)
      || !allowedPhases.has(receipt.phase) || !receiptFieldsMatchPhase(receipt, receipt.phase)) {
    throw fail(CODES.UNKNOWN, `The task Ledger did not return a durable ${label} receipt with a valid current phase. The source barrier remains active.`)
  }
  return Object.freeze({ ...receipt })
}

function cleanupReceipt(receipt, operationId, mode, allowedPhases, label) {
  if (promiseLike(receipt) || !plain(receipt) || receipt.durable !== true
      || receipt.operationId !== operationId || receipt.cleanupKind !== 'owner-gone-all'
      || receipt.mode !== mode || OWNER_GONE_MODES[mode] !== receipt.reason
      || !PHASES.has(receipt.phase) || !allowedPhases.has(receipt.phase)
      || !receiptFieldsMatchPhase(receipt, receipt.phase)
      || !Array.isArray(receipt.sourceNodeIds) || !Array.isArray(receipt.taskIds)
      || !Number.isSafeInteger(receipt.taskCount) || receipt.taskCount !== receipt.taskIds.length) {
    throw fail(CODES.UNKNOWN, `The task Ledger did not return a durable ${label} all-node cleanup receipt. Existing sources remain protected.`)
  }
  return Object.freeze({ ...receipt, sourceNodeIds: Object.freeze([...receipt.sourceNodeIds]), taskIds: Object.freeze([...receipt.taskIds]) })
}

function authorityMatchesReceipt(receipt, authority) {
  const destination = receipt?.destination
  return receipt?.sourceNodeId === authority?.sourceNodeId
    && destination?.kind === authority?.kind
    && (destination?.parentNodeId || null) === (authority?.parentNodeId || null)
    && (destination?.parentTreeId || null) === (authority?.parentTreeId || null)
    && canonical(receipt?.sourcePreimage || null) === canonical(authority?.sourcePreimage || null)
    && (receipt?.topologyToken || null) === (authority?.topologyToken || null)
}

function createTaskTopologyAdmission({
  getTaskWriter,
  readForest,
  readAllForests,
  parseForest,
  quiesceFleet,
  confirmFleetTree,
  principal,
  makeOperationId,
  readCoordinatorIdentity,
} = {}) {
  if (typeof getTaskWriter !== 'function' || typeof readForest !== 'function'
      || typeof parseForest !== 'function' || typeof principal !== 'string' || !principal.trim()) {
    throw new TypeError('Task topology admission needs a private writer, complete forest reader, parser and native principal.')
  }
  const reservations = new Map()
  const sourceOperations = new Map()
  const cleanupReservations = new Map()

  function writerOrThrow(input) {
    const writer = getTaskWriter(input)
    if (!writer || typeof writer.prepareTaskHandoff !== 'function'
        || typeof writer.commitTaskHandoff !== 'function'
        || typeof writer.finalizeTaskHandoff !== 'function') {
      throw fail(CODES.UNAVAILABLE, 'The authenticated task Ledger writer is not installed. The saved node was kept.')
    }
    return writer
  }

  function completeForest(computerId, supplied) {
    let response
    try { response = supplied === undefined ? readForest(computerId) : supplied } catch (error) {
      throw fail(error?.code || CODES.UNKNOWN, error?.message || 'The complete saved fleet could not be read. The saved node was kept.')
    }
    if (promiseLike(response) || !plain(response)) throw fail(CODES.UNKNOWN, 'The complete saved fleet could not be read synchronously. The saved node was kept.')
    const forest = response.forest && plain(response.forest) ? response.forest : response
    const complete = response.complete === true || response.authority?.complete === true || forest.complete === true
    if (response.ok === false || complete !== true || forest.computerId !== computerId
        || !Array.isArray(forest.nodes) || !Array.isArray(forest.trees)) {
      throw fail(response.code || CODES.UNKNOWN, response.reason || 'The saved fleet is absent, incomplete or unreadable. The saved node was kept.')
    }
    const ids = new Set()
    for (const node of forest.nodes) {
      if (!plain(node) || typeof node.id !== 'string' || !node.id || ids.has(node.id)) {
        throw fail(CODES.UNKNOWN, 'The complete saved fleet contains a missing or duplicate node identity. No removal was admitted.')
      }
      ids.add(node.id)
    }
    const nodes = Object.freeze([...forest.nodes])
    const trees = Object.freeze([...forest.trees])
    const normalized = { ...forest, nodes, trees }
    return Object.freeze({ ...normalized, topologyToken: forestToken(normalized) })
  }

  function completeCleanupForest() {
    let response
    try { response = typeof readAllForests === 'function' ? readAllForests() : readForest() } catch (error) {
      throw fail(error?.code || CODES.UNKNOWN, error?.message || 'The complete saved fleet could not be read. Saved sources were kept.')
    }
    if (promiseLike(response) || !plain(response)) throw fail(CODES.UNKNOWN, 'The complete saved fleet could not be read synchronously. Saved sources were kept.')
    const rawForests = Array.isArray(response.forests) ? response.forests : [response.forest && plain(response.forest) ? response.forest : response]
    if (response.ok === false || response.complete !== true || rawForests.some(forest => !plain(forest)
        || typeof forest.computerId !== 'string' || !Array.isArray(forest.nodes) || !Array.isArray(forest.trees))) {
      throw fail(response.code || CODES.UNKNOWN, response.reason || 'The complete saved fleet is absent, incomplete or unreadable. Saved sources were kept.')
    }
    const computerIds = new Set()
    const nodeIds = new Set()
    const forests = rawForests.map(forest => {
      const computerId = boundedId(forest.computerId, 'computer id')
      if (computerIds.has(computerId)) throw fail(CODES.UNKNOWN, 'The complete saved fleet contains a duplicate computer identity. Saved sources were kept.')
      computerIds.add(computerId)
      const complete = completeForest(computerId, { ok: true, complete: true, forest })
      for (const node of complete.nodes) {
        if (nodeIds.has(node.id)) throw fail(CODES.UNKNOWN, 'The complete saved fleet contains an ambiguous node identity. Saved sources were kept.')
        nodeIds.add(node.id)
      }
      return complete
    })
    return Object.freeze({ complete: true, forests: Object.freeze(forests), topologyToken: cleanupForestToken(forests) })
  }

  function sourceAuthority(computerId, sourceNodeId, reason, forest) {
    const sourceMatches = forest.nodes.filter(node => plain(node) && node.id === sourceNodeId)
    if (sourceMatches.length !== 1) throw fail(CODES.UNKNOWN, 'The saved owner is absent or ambiguous in the complete fleet snapshot. No removal was admitted.')
    const source = sourceMatches[0]
    const parentId = source.parentId === undefined ? null : source.parentId
    if (parentId === null) {
      return Object.freeze({
        kind: 'verified-no-parent', computerId, sourceNodeId,
        parentNodeId: null, reason,
        sourcePreimage: frozenCopy(source),
        topologyToken: forest.topologyToken,
      })
    }
    const parentMatches = forest.nodes.filter(node => plain(node) && node.id === parentId)
    if (parentMatches.length !== 1) throw fail(CODES.UNKNOWN, 'The saved parent is missing or ambiguous. No removal was admitted.')
    const parent = parentMatches[0]
    if (parent.treeId !== source.treeId) throw fail(CODES.UNKNOWN, 'The saved parent belongs to another tree. No removal was admitted.')
    return Object.freeze({
      kind: 'verified-parent', computerId, sourceNodeId,
      parentNodeId: parent.id, parentTreeId: parent.treeId,
      parentLabel: typeof parent.label === 'string' ? parent.label : undefined,
      topologyToken: forest.topologyToken,
      reason, sourcePreimage: frozenCopy(source),
    })
  }

  function readAuthority(request = {}) {
    const computerId = request.computerId === undefined ? undefined : boundedId(request.computerId, 'computer id')
    const sourceNodeId = boundedId(request.sourceNodeId, 'source node id')
    const reason = boundedReason(request.reason)
    return sourceAuthority(computerId, sourceNodeId, reason, completeForest(computerId))
  }

  function inputOf(request) {
    if (!plain(request)) throw fail(CODES.INVALID, 'A saved-node removal request is not an object.')
    const computerId = boundedId(request.computerId, 'computer id')
    const sourceNodeId = boundedId(request.sourceNodeId, 'source node id')
    const operationId = boundedId(request.operationId || (typeof makeOperationId === 'function' ? makeOperationId() : ''), 'operation id')
    const reason = boundedReason(request.reason)
    return Object.freeze({ computerId, sourceNodeId, operationId, reason })
  }

  function cleanupInputOf(request) {
    if (!plain(request)) throw fail(CODES.INVALID, 'An all-node cleanup request is not an object.')
    const computerId = request.computerId === undefined ? undefined : boundedId(request.computerId, 'computer id')
    const operationId = boundedId(request.operationId || (typeof makeOperationId === 'function' ? makeOperationId() : ''), 'operation id')
    const mode = request.mode
    if (!Object.prototype.hasOwnProperty.call(OWNER_GONE_MODES, mode)) throw fail(CODES.INVALID, 'The all-node cleanup mode is not recognized.')
    const reason = boundedReason(request.reason)
    if (reason !== OWNER_GONE_MODES[mode]) throw fail(CODES.INVALID, 'The all-node cleanup reason does not match its native mode.')
    return Object.freeze({ ...(computerId === undefined ? {} : { computerId }), operationId, mode, reason })
  }

  function cleanupWriterOrThrow(input) {
    const writer = getTaskWriter(input)
    if (!writer || typeof writer.prepareTaskOwnerGoneCleanup !== 'function'
        || typeof writer.commitTaskOwnerGoneCleanup !== 'function'
        || typeof writer.finalizeTaskOwnerGoneCleanup !== 'function') {
      throw fail(CODES.UNAVAILABLE, 'The authenticated task Ledger owner-gone cleanup writer is not installed. Saved sources were kept.')
    }
    return writer
  }

  function stateForPhase(phase) {
    return phase === 'prepared' ? 'prepared' : (phase === 'committed' ? 'committed' : 'finalized')
  }

  function authorityFromReceipt(input, receipt) {
    const destination = receipt?.destination
    if (!plain(destination) || !['verified-parent', 'verified-no-parent'].includes(destination.kind)
        || receipt.sourceNodeId !== input.sourceNodeId || !plain(receipt.sourcePreimage)
        || typeof receipt.topologyToken !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.topologyToken)) {
      throw fail(CODES.UNKNOWN, 'The persisted removal authority is incomplete. The saved node was kept.')
    }
    if (destination.kind === 'verified-parent'
        && (typeof destination.parentNodeId !== 'string' || typeof destination.parentTreeId !== 'string'
          || !destination.parentNodeId || !destination.parentTreeId)) {
      throw fail(CODES.UNKNOWN, 'The persisted parent authority is incomplete. The saved node was kept.')
    }
    if (destination.kind === 'verified-no-parent'
        && destination.parentNodeId !== undefined && destination.parentNodeId !== null) {
      throw fail(CODES.UNKNOWN, 'The persisted no-parent authority carried a destination. The saved node was kept.')
    }
    return Object.freeze({
      kind: destination.kind,
      computerId: input.computerId,
      sourceNodeId: input.sourceNodeId,
      parentNodeId: destination.kind === 'verified-parent' ? destination.parentNodeId : null,
      ...(destination.kind === 'verified-parent' ? { parentTreeId: destination.parentTreeId } : {}),
      ...(typeof destination.parentLabel === 'string' ? { parentLabel: destination.parentLabel } : {}),
      ...(plain(destination.targetConfiguration) ? { targetConfiguration: frozenCopy(destination.targetConfiguration) } : {}),
      topologyToken: receipt.topologyToken,
      reason: input.reason,
      sourcePreimage: frozenCopy(receipt.sourcePreimage),
    })
  }

  function assertCurrentPersistedAuthority(input, authority) {
    const forest = completeForest(input.computerId)
    const sourceMatches = forest.nodes.filter(node => plain(node) && node.id === input.sourceNodeId)
    if (sourceMatches.length !== 1 || canonical(sourceMatches[0]) !== canonical(authority.sourcePreimage)
        || forest.topologyToken !== authority.topologyToken) {
      throw fail(CODES.UNKNOWN, 'The saved fleet no longer matches the persisted removal authority. The source was kept.')
    }
    if (authority.kind === 'verified-parent') {
      const parentMatches = forest.nodes.filter(node => plain(node) && node.id === authority.parentNodeId)
      if (parentMatches.length !== 1 || parentMatches[0].treeId !== authority.parentTreeId
          || parentMatches[0].treeId !== sourceMatches[0].treeId) {
        throw fail(CODES.UNKNOWN, 'The saved parent no longer matches the persisted removal authority. The source was kept.')
      }
    } else if (sourceMatches[0].parentId !== null && sourceMatches[0].parentId !== undefined) {
      throw fail(CODES.UNKNOWN, 'The saved owner gained a parent after the persisted no-parent authority. The source was kept.')
    }
  }

  function restoreReservation(input) {
    const writer = writerOrThrow(input)
    if (typeof writer.readTaskHandoff !== 'function') return null
    let receipt
    try { receipt = writer.readTaskHandoff(input.operationId) } catch (error) {
      throw fail(error?.code || CODES.UNKNOWN, error?.message || 'The saved Ledger handoff phase could not be read. The source was kept.')
    }
    if (receipt === null || receipt === undefined) return null
    const restored = durableReceipt(receipt, input.operationId, PHASES, 'persisted')
    if (restored.sourceNodeId !== input.sourceNodeId) {
      throw fail(CODES.CONFLICT, 'The persisted removal operation names a different saved owner. The source was kept.')
    }
    if (restored.reason !== undefined && restored.reason !== input.reason) {
      throw fail(CODES.CONFLICT, 'The persisted removal reason changed. The source was kept.')
    }
    let authority = null
    if (restored.phase !== 'finalized') {
      authority = authorityFromReceipt(input, restored)
      const forest = completeForest(input.computerId)
      const sourcePresent = forest.nodes.some(node => plain(node) && node.id === input.sourceNodeId)
      if (sourcePresent) {
        assertCurrentPersistedAuthority(input, authority)
      } else if (typeof restored.postimageSha256 !== 'string'
          || sha256(removalPostimageCanonical(forest, input.sourceNodeId)) !== restored.postimageSha256) {
        throw fail(CODES.READBACK_UNCONFIRMED, 'The saved owner is absent but the durable tree does not match the authenticated postimage. The source barrier remains active.')
      }
    }
    const reservation = {
      ...input,
      state: stateForPhase(restored.phase),
      authority,
      taskLedgerOptions: authority ? taskLedgerOptionsFor(input, authority, readCoordinatorIdentity) : undefined,
      receipt: restored,
      writeObserved: typeof restored.postimageSha256 === 'string'
        ? Object.freeze({ postimageSha256: restored.postimageSha256 })
        : null,
      restored: true,
    }
    reservations.set(input.operationId, reservation)
    sourceOperations.set(`${input.computerId}:${input.sourceNodeId}`, input.operationId)
    return reservation
  }

  function reservationFor(input) {
    let current = reservations.get(input.operationId)
    if (!current || current.state === 'unknown') current = restoreReservation(input)
    if (!current) throw fail(CODES.UNKNOWN, `Removal operation ${input.operationId} is not present in this process. The saved node was kept.`)
    if (current.computerId !== input.computerId || current.sourceNodeId !== input.sourceNodeId) {
      throw fail(CODES.CONFLICT, 'The removal operation identity changed. The saved node was kept.')
    }
    return current
  }

  function ensureSourceUniqueness(input) {
    const priorId = sourceOperations.get(`${input.computerId}:${input.sourceNodeId}`)
    if (priorId && priorId !== input.operationId) {
      const prior = reservations.get(priorId)
      if (!prior || prior.state !== 'finalized') throw fail(CODES.SOURCE_HELD, 'Another removal operation already holds this saved owner. Reconcile it before retrying.')
      throw fail(CODES.CONFLICT, 'This saved owner already has a completed removal operation. A new operation id cannot reuse it.')
    }
  }

  async function prepare(request) {
    const input = inputOf(request)
    let existing = reservations.get(input.operationId)
    if (!existing || existing.state === 'unknown') existing = restoreReservation(input)
    if (existing) {
      if (existing.computerId !== input.computerId || existing.sourceNodeId !== input.sourceNodeId || existing.reason !== input.reason) {
        throw fail(CODES.CONFLICT, 'The removal operation identity or reason changed. The saved node was kept.')
      }
      if (existing.receipt) {
        if (existing.restored && existing.state === 'prepared') {
          const replay = writerOrThrow(input).prepareTaskHandoff({
            operationId: input.operationId, sourceNodeId: input.sourceNodeId,
            actor: principal.trim(), reason: input.reason,
          }, existing.taskLedgerOptions)
          const checked = durableReceipt(replay, input.operationId, PHASES, 'replayed')
          if (!authorityMatchesReceipt(checked, existing.authority)) {
            throw fail(CODES.CONFLICT, 'The replayed removal authority changed. The source was kept.')
          }
          existing.state = stateForPhase(checked.phase)
          existing.receipt = checked
          existing.restored = false
        }
        return existing.receipt
      }
      throw fail(CODES.UNKNOWN, 'The removal operation is unresolved. Reconcile its saved Ledger phase before retrying.')
    }
    ensureSourceUniqueness(input)
    const reservation = { ...input, state: 'preparing', authority: null, taskLedgerOptions: undefined,
      receipt: null, writeObserved: null, restored: false }
    reservations.set(input.operationId, reservation)
    sourceOperations.set(`${input.computerId}:${input.sourceNodeId}`, input.operationId)
    try {
      if (typeof quiesceFleet === 'function') {
        const drained = await quiesceFleet(input.computerId)
        if (drained?.ok !== true) throw fail(drained?.code || CODES.UNKNOWN, drained?.reason || 'A previous saved-tree flush is unresolved. The node was kept.')
      }
      const forest = completeForest(input.computerId)
      reservation.authority = sourceAuthority(input.computerId, input.sourceNodeId, input.reason, forest)
      reservation.taskLedgerOptions = taskLedgerOptionsFor(input, reservation.authority, readCoordinatorIdentity)
      const receipt = writerOrThrow(input).prepareTaskHandoff({
        operationId: input.operationId, sourceNodeId: input.sourceNodeId,
        actor: principal.trim(), reason: input.reason,
      }, reservation.taskLedgerOptions)
      const checked = durableReceipt(receipt, input.operationId, PHASES, 'prepared')
      reservation.state = stateForPhase(checked.phase)
      reservation.receipt = checked
      return reservation.receipt
    } catch (error) {
      reservation.state = 'unknown'
      throw error
    }
  }

  function commit(request) {
    const input = inputOf(request)
    const reservation = reservationFor(input)
    if (reservation.state === 'finalized') return reservation.receipt
    if (reservation.state === 'committed') {
      if (reservation.restored && reservation.receipt?.phase === 'prepared') {
        const replay = writerOrThrow(input).prepareTaskHandoff({
          operationId: input.operationId, sourceNodeId: input.sourceNodeId,
          actor: principal.trim(), reason: input.reason,
        }, reservation.taskLedgerOptions)
        const checked = durableReceipt(replay, input.operationId, PHASES, 'replayed')
        if (!authorityMatchesReceipt(checked, reservation.authority)) {
          throw fail(CODES.CONFLICT, 'The replayed removal authority changed. The source was kept.')
        }
        reservation.receipt = checked
        reservation.restored = false
      }
      return reservation.receipt
    }
    if (reservation.state !== 'prepared') throw fail(CODES.UNKNOWN, 'The prepared removal phase is unresolved. The saved node was kept.')
    reservation.state = 'committing'
    try {
      const forest = completeForest(input.computerId)
      const source = forest.nodes.find(node => node?.id === input.sourceNodeId)
      if (!source || !reservation.authority?.sourcePreimage
          || canonical(source) !== canonical(reservation.authority.sourcePreimage)
          || forest.topologyToken !== reservation.authority.topologyToken) {
        throw fail(CODES.UNKNOWN, 'The saved owner changed after enumeration. The source was kept.')
      }
      const postimageNodes = forest.nodes.filter(node => node?.id !== input.sourceNodeId)
      const sourceTreeRetained = postimageNodes.some(node => node?.treeId === source.treeId)
      const postimageTrees = sourceTreeRetained
        ? forest.trees
        : forest.trees.filter(tree => tree?.id !== source.treeId)
      const postimageCanonical = canonical({
        nodes: sortedNodes(postimageNodes),
        trees: sortedTrees(postimageTrees),
      })
      const receipt = writerOrThrow(input).commitTaskHandoff({
        operationId: input.operationId, sourceNodeId: input.sourceNodeId,
        actor: principal.trim(), reason: input.reason,
        postimageSha256: sha256(postimageCanonical),
      }, reservation.taskLedgerOptions)
      const checked = durableReceipt(receipt, input.operationId, new Set(['committed', 'finalized']), 'commit')
      if (typeof checked.postimageSha256 !== 'string'
          || checked.postimageSha256 !== sha256(postimageCanonical)) {
        throw fail(CODES.UNKNOWN, 'The task Ledger did not retain the exact admitted tree postimage. The source was kept.')
      }
      reservation.state = stateForPhase(checked.phase)
      reservation.receipt = checked
      reservation.writeObserved = Object.freeze({
        before: frozenCopy(source),
        topologyToken: forest.topologyToken,
        postimageCanonical,
        postimageSha256: checked.postimageSha256,
      })
      return reservation.receipt
    } catch (error) {
      reservation.state = 'unknown'
      throw error
    }
  }

  async function finalize(request) {
    const input = inputOf(request)
    const reservation = reservationFor(input)
    if (reservation.state === 'finalized') return reservation.receipt
    if (reservation.state !== 'committed') throw fail(CODES.UNKNOWN, 'The committed removal phase is unresolved. The source barrier remains active.')
    if (typeof confirmFleetTree !== 'function') {
      throw fail(CODES.READBACK_UNCONFIRMED, 'The saved-tree durable read-back seam is unavailable. The source barrier remains active.')
    }
    let finalizeAttempted = false
    try {
      const readback = await confirmFleetTree(Object.freeze({
        computerId: input.computerId, sourceNodeId: input.sourceNodeId,
        operationId: input.operationId, authority: reservation.authority,
      }))
      if (readback?.ok !== true || readback.durable !== true || promiseLike(readback)
          || !plain(readback.value)) throw fail(readback?.code || CODES.READBACK_UNCONFIRMED, readback?.reason || 'The saved-tree removal could not be durably read back. The source barrier remains active.')
      const forest = completeForest(input.computerId, readback.value)
      if (!reservation.writeObserved
          || (typeof reservation.writeObserved.postimageSha256 !== 'string'
            && typeof reservation.writeObserved.postimageCanonical !== 'string')) {
        throw fail(CODES.READBACK_UNCONFIRMED, 'The admitted saved-tree postimage was not retained for exact durable read-back. The source barrier remains active.')
      }
      const actualPostimage = canonical({
        nodes: sortedNodes(forest.nodes),
        trees: sortedTrees(forest.trees),
      })
      const actualPostimageSha256 = sha256(actualPostimage)
      if ((typeof reservation.writeObserved.postimageSha256 === 'string'
        && actualPostimageSha256 !== reservation.writeObserved.postimageSha256)
        || (typeof reservation.writeObserved.postimageSha256 !== 'string'
          && actualPostimage !== reservation.writeObserved.postimageCanonical)) {
        throw fail(CODES.READBACK_UNCONFIRMED, 'The saved-tree durable read-back differs from the admitted postimage. The source barrier remains active.')
      }
      if (forest.nodes.some(node => plain(node) && node.id === input.sourceNodeId)) {
        throw fail(CODES.READBACK_UNCONFIRMED, 'The saved owner is still present after the removal write. The source barrier remains active.')
      }
      const topologyReceipt = Object.freeze({
        durable: true, operationId: input.operationId, sourceNodeId: input.sourceNodeId,
        ...(readback.topologyRevision === undefined ? {} : { topologyRevision: String(readback.topologyRevision) }),
      })
      finalizeAttempted = true
      const receipt = writerOrThrow(input).finalizeTaskHandoff({
        operationId: input.operationId, sourceNodeId: input.sourceNodeId,
        actor: principal.trim(), reason: input.reason, topologyReceipt,
      }, reservation.taskLedgerOptions)
      const checked = durableReceipt(receipt, input.operationId, new Set(['finalized']), 'finalization')
      reservation.state = 'finalized'
      reservation.receipt = checked
      return reservation.receipt
    } catch (error) {
      if (finalizeAttempted) reservation.state = 'unknown'
      throw error
    }
  }

  function prepareAllNodeOwnerGone(request) {
    const input = cleanupInputOf(request)
    const existing = cleanupReservations.get(input.operationId)
    if (existing) {
      if (existing.computerId !== input.computerId || existing.mode !== input.mode || existing.reason !== input.reason) {
        throw fail(CODES.CONFLICT, 'The all-node cleanup identity or reason changed. Saved sources were kept.')
      }
      return existing.receipt
    }
    const writer = cleanupWriterOrThrow(input)
    let persisted = null
    if (typeof writer.readTaskOwnerGoneCleanup === 'function') {
      try { persisted = writer.readTaskOwnerGoneCleanup(input.operationId) } catch (error) {
        throw fail(error?.code || CODES.UNKNOWN, error?.message || 'The persisted all-node cleanup phase could not be read. Saved sources were kept.')
      }
    }
    if (persisted !== null && persisted !== undefined) {
      const checked = cleanupReceipt(persisted, input.operationId, input.mode, new Set(['prepared', 'committed', 'finalized']), 'persisted')
      if (checked.phase === 'prepared') {
        const forest = completeCleanupForest()
        if (checked.topologyToken !== undefined && checked.topologyToken !== forest.topologyToken) {
          throw fail(CODES.UNKNOWN, 'The saved fleet no longer matches the persisted all-node cleanup barrier. Saved sources were kept.')
        }
        cleanupReservations.set(input.operationId, { ...input, forestToken: forest.topologyToken,
          taskLedgerOptions: cleanupTaskLedgerOptionsFor(input, readCoordinatorIdentity), receipt: checked })
      } else {
        cleanupReservations.set(input.operationId, { ...input, forestToken: checked.topologyToken || null,
          taskLedgerOptions: cleanupTaskLedgerOptionsFor(input, readCoordinatorIdentity), receipt: checked })
      }
      return checked
    }
    const forest = completeCleanupForest()
    const taskLedgerOptions = cleanupTaskLedgerOptionsFor({ ...input, topologyToken: forest.topologyToken }, readCoordinatorIdentity)
    const receipt = writer.prepareTaskOwnerGoneCleanup({
      operationId: input.operationId, mode: input.mode, reason: input.reason,
      actor: principal.trim(), topologyToken: forest.topologyToken,
    }, taskLedgerOptions)
    const checked = cleanupReceipt(receipt, input.operationId, input.mode, new Set(['prepared', 'committed', 'finalized']), 'prepared')
    if (checked.topologyToken !== undefined && checked.topologyToken !== forest.topologyToken) {
      throw fail(CODES.CONFLICT, 'The all-node cleanup topology changed before its durable barrier was recorded. Saved sources were kept.')
    }
    cleanupReservations.set(input.operationId, { ...input, forestToken: forest.topologyToken,
      taskLedgerOptions, receipt: checked })
    return checked
  }

  function commitAllNodeOwnerGone(request) {
    const input = cleanupInputOf(request)
    const reservation = cleanupReservations.get(input.operationId)
    if (!reservation || reservation.computerId !== input.computerId || reservation.mode !== input.mode || reservation.reason !== input.reason) {
      throw fail(CODES.UNKNOWN, 'The all-node cleanup barrier is not present in this process. Saved sources were kept.')
    }
    let forest = null
    if (reservation.receipt.phase === 'prepared') {
      forest = completeCleanupForest()
      if (forest.topologyToken !== reservation.forestToken || reservation.receipt.topologyToken !== forest.topologyToken) {
        throw fail(CODES.UNKNOWN, 'The saved fleet changed after all-node enumeration. No task was changed and saved sources were kept.')
      }
    }
    const receipt = cleanupWriterOrThrow(input).commitTaskOwnerGoneCleanup({
      operationId: input.operationId, mode: input.mode, reason: input.reason,
      actor: principal.trim(), ...(forest ? { topologyToken: forest.topologyToken } : {}),
      taskSetDigest: reservation.receipt.taskSetDigest, taskCount: reservation.receipt.taskCount,
    }, reservation.taskLedgerOptions)
    const checked = cleanupReceipt(receipt, input.operationId, input.mode, new Set(['committed', 'finalized']), 'committed')
    cleanupReservations.set(input.operationId, { ...reservation, receipt: checked })
    return checked
  }

  function finalizeAllNodeOwnerGone(request) {
    const input = cleanupInputOf(request)
    const reservation = cleanupReservations.get(input.operationId)
    if (!reservation || reservation.computerId !== input.computerId || reservation.mode !== input.mode || reservation.reason !== input.reason) {
      throw fail(CODES.UNKNOWN, 'The all-node cleanup operation is not present in this process. The owner-gone barrier remains active.')
    }
    const cleanupReadback = request.cleanupReceipt
    const receipt = cleanupWriterOrThrow(input).finalizeTaskOwnerGoneCleanup({
      operationId: input.operationId, mode: input.mode, reason: input.reason,
      actor: principal.trim(), cleanupReceipt: cleanupReadback,
    }, reservation.taskLedgerOptions)
    const checked = cleanupReceipt(receipt, input.operationId, input.mode, new Set(['finalized']), 'finalized')
    cleanupReservations.set(input.operationId, { ...reservation, receipt: checked })
    return checked
  }

  function validateWrite({ computerId, previous, value, taskLedgerOptions } = {}) {
    const id = boundedId(computerId, 'computer id')
    let before, after
    try {
      /* NO SAVED RECORD YET IS AN EMPTY FOREST, NOT AN UNREADABLE ONE. A fresh
         installation has no fleet cell for this computer until its first tree
         is saved; the prefs store hands that absence over as null. Parsing null
         gives the parser's EMPTY record with no computer id, which the check
         below reads as "absent, incomplete or unreadable", so every first
         "Set this agent" or Start on a new computer was refused. With no saved
         owner there is nothing a write could remove; the slot admission and
         main's removal classifiers already read null this way. A record that
         exists but does not parse is still refused. */
      before = previous == null
        ? completeForest(id, { ok: true, complete: true, forest: { computerId: id, nodes: [], trees: [] } })
        : completeForest(id, { ok: true, complete: true, forest: parseForest(previous, { computerId: id }) })
      after = completeForest(id, { ok: true, complete: true, forest: parseForest(value, { computerId: id }) })
    } catch (error) {
      return { ok: false, code: error.code || CODES.UNKNOWN, reason: error.message || 'The saved forest could not be verified. No tree change was saved.' }
    }
    const beforeIds = new Set(before.nodes.map(node => node?.id).filter(Boolean))
    const afterIds = new Set(after.nodes.map(node => node?.id).filter(Boolean))
    const removed = [...beforeIds].filter(nodeId => !afterIds.has(nodeId))
    const barriers = [...reservations.values()].filter(row => row.computerId === id && ACTIVE_BARRIER_STATES.has(row.state))
    if (!removed.length) {
      if (barriers.length && JSON.stringify(previous) !== JSON.stringify(value)) {
        return { ok: false, code: CODES.WRITE_REFUSED, reason: 'A saved-node handoff is being reconciled. Parent and topology changes are held until its durable receipt is known.' }
      }
      return { ok: true }
    }
    if (removed.length !== 1) return { ok: false, code: CODES.WRITE_REFUSED, reason: 'Several saved owners disappeared in one unreserved write. Existing nodes were retained.' }
    const sourceNodeId = removed[0]
    const operationId = sourceOperations.get(`${id}:${sourceNodeId}`)
    const reservation = operationId ? reservations.get(operationId) : null
    if (!reservation || reservation.state !== 'committed') {
      return { ok: false, code: CODES.WRITE_REFUSED, reason: 'This saved owner has no committed authenticated task handoff. The node and its tasks were retained.' }
    }
    if (barriers.some(row => row.operationId !== reservation.operationId)) {
      return { ok: false, code: CODES.WRITE_REFUSED, reason: 'Another saved-node handoff is being reconciled. Existing nodes were retained.' }
    }
    const beforeNode = before.nodes.find(node => node?.id === sourceNodeId)
    if (!beforeNode || reservation.authority?.sourceNodeId !== sourceNodeId
        || !reservation.authority.sourcePreimage
        || canonical(beforeNode) !== canonical(reservation.authority.sourcePreimage)
        || before.topologyToken !== reservation.authority.topologyToken) {
      return { ok: false, code: CODES.UNKNOWN, reason: 'The removed owner preimage no longer matches the authenticated reservation. Existing nodes were retained.' }
    }
    const expectedNodes = sortedNodes(before.nodes.filter(node => node?.id !== sourceNodeId))
    const sourceTreeId = beforeNode.treeId
    const expectedTrees = expectedNodes.some(node => node?.treeId === sourceTreeId)
      ? sortedTrees(before.trees)
      : sortedTrees(before.trees.filter(tree => tree?.id !== sourceTreeId))
    const actualNodes = sortedNodes(after.nodes)
    if (canonical(expectedNodes) !== canonical(actualNodes)
        || canonical(expectedTrees) !== canonical(sortedTrees(after.trees))) {
      return { ok: false, code: CODES.WRITE_REFUSED, reason: 'The removal write changed a parent, configuration or another saved owner. Existing nodes were retained.' }
    }
    const postimageCanonical = canonical({
      nodes: actualNodes,
      trees: sortedTrees(after.trees),
    })
    const postimageSha256 = sha256(postimageCanonical)
    if (typeof reservation.receipt?.postimageSha256 !== 'string'
        || reservation.receipt.postimageSha256 !== postimageSha256) {
      return { ok: false, code: CODES.UNKNOWN, reason: 'The removal write does not match the exact authenticated postimage. Existing nodes were retained.' }
    }
    if (!plain(taskLedgerOptions)
        || !plain(taskLedgerOptions.reservation)
        || taskLedgerOptions.reservation.operationId !== reservation.operationId
        || taskLedgerOptions.reservation.token !== reservation.taskLedgerOptions?.reservation?.token
        || taskLedgerOptions.reservation.consumed === true
        || taskLedgerOptions.consumed === true) {
      return { ok: false, code: CODES.UNKNOWN,
        reason: 'The topology write carried a different or missing authenticated reservation. Existing nodes were retained.' }
    }
    let consumed
    try {
      const writer = writerOrThrow({
        computerId: id,
        sourceNodeId,
        operationId: reservation.operationId,
      })
      if (typeof writer.consumeTaskLedgerReservation !== 'function') {
        return { ok: false, code: CODES.UNAVAILABLE,
          reason: 'The authenticated task Ledger writer cannot consume a topology reservation. Existing nodes were retained.' }
      }
      consumed = writer.consumeTaskLedgerReservation({
        operationId: reservation.operationId,
        sourceNodeId,
        actor: principal.trim(),
        reason: reservation.reason,
        postimageSha256,
      }, taskLedgerOptions)
    } catch (error) {
      return { ok: false, code: error?.code || CODES.UNKNOWN,
        reason: error?.message || 'The topology reservation could not be consumed. Existing nodes were retained.' }
    }
    if (!consumed || consumed.consumed !== true || consumed.replayed === true
        || consumed.operationId !== reservation.operationId
        || consumed.postimageSha256 !== postimageSha256) {
      return { ok: false, code: CODES.UNKNOWN,
        reason: 'The topology reservation was not consumed for the exact admitted postimage. Existing nodes were retained.' }
    }
    reservation.writeObserved = Object.freeze({
      sourceNodeId,
      before: frozenCopy(beforeNode),
      topologyToken: before.topologyToken,
      postimageCanonical,
      postimageSha256,
      value,
    })
    return Object.freeze({ ok: true, operationId: reservation.operationId, sourceNodeId, durable: false })
  }

  function validateRemoval({ keys } = {}) {
    const treeKeys = Array.isArray(keys) ? keys.filter(key => typeof key === 'string' && key.startsWith('mc.fleet.trees.v1:')) : []
    if (!treeKeys.length) return Object.freeze({ ok: true })
    return Object.freeze({ ok: false, code: CODES.WRITE_REFUSED,
      reason: 'Direct saved-tree deletion is not an authenticated node handoff. The saved trees and their tasks were retained.' })
  }

  function state(operationId) {
    const row = reservations.get(operationId)
    return row ? Object.freeze({ operationId: row.operationId, computerId: row.computerId, sourceNodeId: row.sourceNodeId,
      state: row.state, receipt: row.receipt, writeObserved: Boolean(row.writeObserved) }) : null
  }

  // The opaque reservation is a private main/native handoff to the durable
  // prefs admission. It is never placed in a renderer receipt or derived from
  // renderer bytes; callers must pass it back for exactly one committed write.
  function taskLedgerOptionsForWrite(operation) {
    let row = typeof operation === 'string' ? reservations.get(operation) : null
    if (!row && plain(operation)) {
      const candidates = [...reservations.values()].filter(candidate => candidate.state === 'committed'
        && candidate.computerId === operation.computerId
        && candidate.sourceNodeId === operation.sourceNodeId)
      if (candidates.length !== 1) {
        throw fail(CODES.UNKNOWN, 'The committed topology reservation is absent or ambiguous. The saved node was kept.')
      }
      row = candidates[0]
    }
    if (!row || row.state !== 'committed' || !plain(row.taskLedgerOptions)) {
      throw fail(CODES.UNKNOWN, 'The committed topology reservation is unavailable. The saved node was kept.')
    }
    return row.taskLedgerOptions
  }

  return Object.freeze({ prepare, commit, finalize, prepareAllNodeOwnerGone, commitAllNodeOwnerGone,
    finalizeAllNodeOwnerGone, validateWrite, validateRemoval, readAuthority, state,
    taskLedgerOptionsForWrite, codes: CODES })
}

module.exports = { createTaskTopologyAdmission, CODES }
