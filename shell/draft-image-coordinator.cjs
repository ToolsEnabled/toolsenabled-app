'use strict'

const { randomUUID: nodeRandomUUID } = require('node:crypto')
const { createDraftImageAuthority } = require('./draft-image-authority.cjs')
const REPICK = 'IMAGE_CUSTODY_REPICK_REQUIRED'
function refuse(code = REPICK) {
  throw Object.assign(new Error('The image draft cannot be verified. Keep the message and pick its images again.'), { code })
}
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const providers = new Set(['codex', 'claude', 'gemini', 'grok', 'local'])
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) refuse()
  return value
}
function sync(value) {
  if (value && typeof value.then === 'function') refuse()
  return value
}

function read(callback, ...args) {
  try { return sync(callback(...args)) } catch { refuse() }
}

// All injected readers are synchronous MAIN-owned authority, never renderer
// lookups. readSavedGraph returns the validated saved fleet envelope.
// readComputerId must return the canonical declared-local identity or an
// independently authoritative source mapping, never treeCommandComputerId or
// a renderer/fetched-id hint. Ids are compared exactly, never translated.
// readOrgSeat returns {seat, revision} from the same fresh canonical org
// snapshot. revision must be its monotonic nonnegative safe integer; reading
// only the seat or relying on local mutation notifications cannot detect ABA.
// readOwner(principal, context) authenticates a native main-frame/window and
// returns {productOwnerId,currentEpoch,window,principal:<product principal>}.
// readSession returns null, or {session:<canonical object>,sessionId,window,
// productPrincipal,live,retired,switchPending,issued:<canonical attachments Set>}.
// sessionMetadata is real host metadata {threadId,provider,account}; an own
// account:null explicitly represents the host's default account. Missing account
// is not default. bindTranscript must synchronously acknowledge {ok:true}.
//
// register/capture/adopt accept renderer receipts, never paths. capture and
// authorizeStart return private object tickets: do not serialize them.
// assert/addSaved/assertStart/bindStarted/releaseStart/revoke/invalidateAll/resolveIssued are MAIN-only.
// No method deletes files or clears an already-issued session attachments Set.
function createDraftImageCoordinator({
  readOwner, readComputerId, readSavedGraph, readOrgSeat, readSession,
  sessionMetadata, transcriptBinding, bindTranscript,
  randomUUID = nodeRandomUUID, maxDrafts = 256, maxImages = 8,
} = {}) {
  if ([readOwner, readComputerId, readSavedGraph, readOrgSeat, readSession,
    sessionMetadata, transcriptBinding, bindTranscript, randomUUID].some(fn => typeof fn !== 'function')) {
    throw new TypeError('Draft image coordinator requires authoritative callbacks')
  }
  if (!Number.isSafeInteger(maxDrafts) || maxDrafts < 1 || maxDrafts > 4096
    || !Number.isSafeInteger(maxImages) || maxImages < 1 || maxImages > 8) {
    throw new TypeError('Invalid draft coordinator bounds')
  }
  const namespace = randomUUID()
  if (typeof namespace !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(namespace)) throw new TypeError('Invalid draft namespace')
  let sequence = 0
  let generation = Symbol('draft coordinator')
  const records = new Map()
  const pasteTickets = new WeakMap()
  const startTickets = new WeakMap()
  const next = prefix => {
    if (sequence >= Number.MAX_SAFE_INTEGER) refuse('IMAGE_DRAFT_ID_EXHAUSTED')
    return prefix + '-' + namespace + '-' + (++sequence)
  }
  function owner(principal, context) {
    if (!object(principal) || principal.kind !== 'window' || principal.mayWrite !== true || !object(principal.owner)) refuse()
    if (typeof principal.owner.isDestroyed === 'function' && principal.owner.isDestroyed()) refuse()
    const value = read(readOwner, principal, context)
    if (!object(value) || !text(value.productOwnerId) || !text(value.principal)
      || value.currentEpoch == null || value.window !== principal.owner) refuse()
    return Object.freeze({ productOwnerId: value.productOwnerId, currentEpoch: value.currentEpoch,
      window: value.window, principal: value.principal })
  }
  const sameOwner = (a, b) => a.productOwnerId === b.productOwnerId && a.currentEpoch === b.currentEpoch
    && a.window === b.window && a.principal === b.principal
  function current(record, principal, context) {
    if (!record || !record.live || record.generation !== generation || records.get(record.draftId) !== record
      || !sameOwner(record.owner, owner(principal, context))) refuse()
    if (read(readComputerId, principal) !== record.computerId) refuse()
    if (record.session) {
      const active = read(readSession, record.expectedSessionId)
      if (!active || active.session !== record.session || active.issued !== record.issued
        || active.sessionId !== record.expectedSessionId || active.live !== true || active.retired === true
        || active.switchPending === true || active.window !== record.owner.window
        || active.productPrincipal !== record.owner.principal) refuse()
    }
    const fingerprint = savedIdentity(record, false)
    if (fingerprint !== record.fingerprint) refuse()
    return record
  }
  function savedIdentity(record, registering) {
    if (record.kind === 'tree') {
      const graph = read(readSavedGraph, record.computerId)
      if (!object(graph) || graph.computerId !== record.computerId || !Array.isArray(graph.nodes) || !Array.isArray(graph.trees)) refuse()
      const matching = graph.nodes.filter(node => node?.id === record.nodeId)
      if (matching.length !== 1) refuse()
      const node = matching[0]
      const trees = graph.trees.filter(tree => tree?.id === node.treeId)
      if (trees.length !== 1 || !text(node.createdAt) || !text(trees[0].createdAt)) refuse()
      if (registering && (node.status !== 'draft' || node.sessionId != null)) refuse()
      if (!registering && node.sessionId != null && node.sessionId !== record.expectedSessionId) refuse()
      if (!text(node.treeId)) refuse()
      if (record.treeId && record.treeId !== node.treeId) refuse()
      if (registering) record.treeId = node.treeId
      return JSON.stringify([record.computerId, node.id, node.createdAt, node.treeId,
        trees[0].createdAt, node.parentId ?? null, node.role ?? null])
    }
    if (record.kind !== 'standalone') refuse()
    const snapshot = read(readOrgSeat, record.nodeId)
    if (!object(snapshot) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) refuse()
    const seat = snapshot.seat
    if (!object(seat) || seat.id !== record.nodeId || seat.nodeId !== record.nodeId || seat.enabled !== true
      || !text(seat.role)) refuse()
    // Conservatively reject every canonical org revision change, including an
    // identical seat removed/recreated by a writer outside this main process.
    return JSON.stringify([record.computerId, seat.id, seat.nodeId, seat.role, snapshot.revision])
  }
  function receipt(record) {
    return Object.freeze({ draftId: record.draftId, sessionId: record.expectedSessionId,
      computerId: record.computerId, conversationId: record.nodeId,
      ownerContext: Object.freeze({ ...record.context }) })
  }
  function fromRequest(request, principal) {
    if (!text(request.draftId)) refuse()
    return current(records.get(request.draftId), principal, request.ownerContext)
  }
  function destination(record, mustBeBound) {
    current(record, record.principal, record.context)
    const value = read(readSession, record.expectedSessionId)
    if (!object(value) || !object(value.session) || value.sessionId !== record.expectedSessionId
      || value.window !== record.owner.window || value.productPrincipal !== record.owner.principal
      || value.live !== true || value.retired === true || value.switchPending === true
      || !(value.issued instanceof Set)) refuse('IMAGE_CUSTODY_CANDIDATE_REFUSED')
    if (mustBeBound && (record.session !== value.session || record.issued !== value.issued)) refuse()
    const metadata = read(sessionMetadata, record.expectedSessionId)
    if (!object(metadata) || !text(metadata.threadId) || !providers.has(metadata.provider)
      || !own(metadata, 'account') || !(metadata.account === null || text(metadata.account))) {
      refuse('IMAGE_DRAFT_ACCOUNT_UNRESOLVED')
    }
    const accountId = metadata.account === null ? 'default' : metadata.account
    return { ...value, provider: metadata.provider, accountId, threadId: metadata.threadId }
  }
  const sameDestination = (a, b) => a.session === b.session && a.issued === b.issued
    && a.sessionId === b.sessionId && a.provider === b.provider
    && a.accountId === b.accountId && a.threadId === b.threadId
  function bindPair(record) {
    const prior = read(transcriptBinding, record.expectedSessionId)
    if (prior && (prior.computerId !== record.computerId || prior.nodeId !== record.nodeId)) refuse()
    const result = read(bindTranscript, { sessionId: record.expectedSessionId,
      computerId: record.computerId, nodeId: record.nodeId, authoritative: true })
    if (result?.ok !== true) refuse()
    const actual = read(transcriptBinding, record.expectedSessionId)
    if (!actual || actual.computerId !== record.computerId || actual.nodeId !== record.nodeId) refuse()
  }
  function retire(record) {
    if (!record || !record.live) return
    record.live = false
    record.authority?.invalidateAll()
    records.delete(record.draftId)
    record.images.clear()
  }
  function register(request, principal) {
    fields(request, ['kind', 'computerId', 'nodeId', 'ownerContext'])
    if (!['tree', 'standalone'].includes(request.kind) || !text(request.computerId) || !text(request.nodeId)) refuse()
    if (records.size >= maxDrafts) refuse('IMAGE_DRAFT_LIMIT')
    const capturedOwner = owner(principal, request.ownerContext)
    if (read(readComputerId, principal) !== request.computerId) refuse()
    // Counter never resets, even on epoch invalidation. No retired-ID table is
    // needed and a renderer cannot nominate an old or live session id.
    const expectedSessionId = next('draft-session')
    if (read(readSession, expectedSessionId) != null) refuse()
    const record = {
      kind: request.kind, computerId: request.computerId, nodeId: request.nodeId,
      expectedSessionId, draftId: next('draft'), identity: Object.freeze({}), incarnation: Object.freeze({}),
      owner: capturedOwner, principal, context: request.ownerContext, generation, live: true,
      images: new Map(), session: null, issued: null, startClaimed: false, adopted: false,
    }
    record.fingerprint = savedIdentity(record, true)
    const authContext = { principal, ownerContext: request.ownerContext }
    record.authority = createDraftImageAuthority({
      maxGrants: 1, maxPaths: maxImages, mintId: () => next('grant'),
      authenticate: supplied => owner(supplied.principal, supplied.ownerContext),
      readDraft: identity => {
        if (identity !== record.identity) refuse()
        current(record, principal, request.ownerContext)
        return { live: true, ...record.owner, kind: record.kind,
          identity: record.identity, incarnation: record.incarnation, computerId: record.computerId,
          treeId: record.treeId, nodeId: record.nodeId, expectedSessionId,
          expectedTranscript: { computerId: record.computerId, nodeId: record.nodeId } }
      },
      readDestination: sessionId => {
        if (sessionId !== expectedSessionId || !record.session) refuse()
        const value = destination(record, true)
        return { ...value, ...record.owner, draftIdentity: record.identity, draftIncarnation: record.incarnation,
          transcript: read(transcriptBinding, sessionId), treeId: record.treeId }
      },
    })
    records.set(record.draftId, record)
    try {
      record.grant = record.authority.capture(record.identity, authContext)
      current(record, principal, request.ownerContext)
      return receipt(record)
    } catch (error) { retire(record); throw error }
  }
  function capture(request, principal) {
    fields(request, ['draftId', 'ownerContext'])
    const record = fromRequest(request, principal)
    if (record.adopted || record.images.size >= maxImages) refuse()
    const context = { principal, ownerContext: request.ownerContext }
    record.authority.assert(record.grant, context)
    const ticket = Object.freeze({})
    pasteTickets.set(ticket, { record, principal, context })
    return ticket
  }
  function checkedPaste(ticket) {
    const held = object(ticket) ? pasteTickets.get(ticket) : null
    if (!held) refuse()
    current(held.record, held.principal, held.context.ownerContext)
    held.record.authority.assert(held.record.grant, held.context)
    return held
  }
  function assert(ticket) { checkedPaste(ticket); return true }
  function addSaved(ticket, savedPath) {
    const held = checkedPaste(ticket)
    held.record.authority.addSaved(held.record.grant, savedPath, held.context)
    const imageId = next('image')
    held.record.images.set(imageId, savedPath)
    pasteTickets.delete(ticket)
    return Object.freeze({ draftId: held.record.draftId, imageId })
  }
  function authorizeStart(request, principal) {
    fields(request, ['draftId', 'sessionId', 'ownerContext'])
    const record = fromRequest(request, principal)
    if (request.sessionId !== record.expectedSessionId || record.startClaimed
      || read(readSession, record.expectedSessionId) != null) refuse()
    record.startClaimed = true
    const ticket = Object.freeze({})
    startTickets.set(ticket, record)
    return ticket
  }
  function assertStart(ticket) {
    const record = object(ticket) ? startTickets.get(ticket) : null
    if (!record || !record.startClaimed || record.session) refuse()
    current(record, record.principal, record.context)
    // The surface may already have allocated its temporary starting record.
    // It is not a ready/native successor and cannot authorize another owner.
    const outer = read(readSession, record.expectedSessionId)
    if (outer && (outer.sessionId !== record.expectedSessionId || outer.live === true
      || outer.retired === true || outer.switchPending === true
      || outer.window !== record.owner.window || outer.productPrincipal !== record.owner.principal)) refuse()
    return true
  }
  function releaseStart(ticket, outcome) {
    const record = object(ticket) ? startTickets.get(ticket) : null
    if (!record || record.session || !record.startClaimed) refuse()
    // MAIN supplies trusted positive nonlaunch evidence. candidateCreated means
    // a NATIVE/PROVIDER candidate, not the temporary outer surface session record.
    // dispatchStarted covers invocation of host.startSession: a generic catch
    // may delete the outer record even though native launch has already begun.
    // The caller must latch that invocation and classify not-started only before
    // it, or from an explicit host-verified nonlaunch outcome. Neither a generic
    // error code nor readSession returning null proves nonlaunch. Null below is
    // only an additional guard. Timeout/unknown outcomes never release a claim.
    fields(outcome, ['disposition', 'candidateCreated', 'dispatchStarted'])
    if (outcome.disposition !== 'not-started' || outcome.candidateCreated !== false
      || outcome.dispatchStarted !== false) refuse('IMAGE_DRAFT_START_UNCERTAIN')
    current(record, record.principal, record.context)
    if (read(readSession, record.expectedSessionId) != null) refuse('IMAGE_DRAFT_START_UNCERTAIN')
    startTickets.delete(ticket)
    record.startClaimed = false
    return receipt(record)
  }
  function bindStarted(ticket) {
    const record = object(ticket) ? startTickets.get(ticket) : null
    if (!record || record.session) refuse()
    const candidate = destination(record, false)
    // Read twice before storing object identity. No guessed session id or later
    // replacement object can inherit a start ticket or its issued Set.
    const latest = destination(record, false)
    if (!sameDestination(candidate, latest)) refuse()
    record.session = candidate.session
    record.issued = candidate.issued
    startTickets.delete(ticket)
    return receipt(record)
  }
  function pathsFor(record, imageIds) {
    if (!Array.isArray(imageIds) || !imageIds.length || imageIds.length > maxImages
      || new Set(imageIds).size !== imageIds.length) refuse()
    return imageIds.map(id => { if (!text(id) || !record.images.has(id)) refuse(); return record.images.get(id) })
  }
  function adopt(request, principal) {
    fields(request, ['draftId', 'sessionId', 'imageIds', 'ownerContext'])
    const record = fromRequest(request, principal)
    if (request.sessionId !== record.expectedSessionId || !record.session) refuse()
    const paths = pathsFor(record, request.imageIds)
    const candidate = destination(record, true)
    bindPair(record)
    const latest = destination(record, true)
    if (!sameDestination(candidate, latest)) refuse()
    record.authority.adopt(record.grant, { sessionId: record.expectedSessionId, paths },
      { principal, ownerContext: request.ownerContext })
    record.adopted = true
    record.adoptedDestination = latest
    return Object.freeze({ ...receipt(record), imageIds: Object.freeze([...request.imageIds]), automaticSend: false })
  }
  function resolveIssued(request, principal) {
    fields(request, ['draftId', 'sessionId', 'imageIds', 'ownerContext'])
    const record = fromRequest(request, principal)
    if (!record.adopted || request.sessionId !== record.expectedSessionId) refuse()
    const value = destination(record, true)
    if (!sameDestination(record.adoptedDestination, value)) refuse()
    const binding = read(transcriptBinding, record.expectedSessionId)
    if (binding?.computerId !== record.computerId || binding?.nodeId !== record.nodeId) refuse()
    const paths = pathsFor(record, request.imageIds)
    if (paths.some(file => !Set.prototype.has.call(value.issued, file))) refuse()
    return Object.freeze(paths)
  }
  function revoke(draftId) {
    const record = records.get(draftId)
    retire(record)
    return Object.freeze({ revoked: true })
  }
  function invalidateAll() {
    generation = Symbol('draft coordinator')
    for (const record of records.values()) retire(record)
  }
  return Object.freeze({ register, capture, assert, addSaved, authorizeStart, bindStarted,
    adopt, resolveIssued, assertStart, releaseStart, revoke, invalidateAll })
}
module.exports = { createDraftImageCoordinator }
