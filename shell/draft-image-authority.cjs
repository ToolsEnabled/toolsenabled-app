'use strict'

// Private in-memory authority only. Callbacks must read MAIN-owned records,
// authenticate/readDraft/readDestination must be synchronous, side-effect-free
// authoritative reads. invalidateAll is host lifecycle authority, never an IPC API.
// Never interpret a renderer echo as an authoritative draft or destination.
const REPICK = 'IMAGE_CUSTODY_REPICK_REQUIRED'
const fail = () => { throw Object.assign(new Error('Image provenance changed; keep the draft and pick the images again.'), { code: REPICK }) }
const text = value => typeof value === 'string' && value.length > 0
const identity = value => text(value) || (value !== null && typeof value === 'object')

function createDraftImageAuthority({ authenticate, readDraft, readDestination, mintId, maxGrants = 256, maxPaths = 8 } = {}) {
  if ([authenticate, readDraft, readDestination, mintId].some(value => typeof value !== 'function')) {
    throw new TypeError('Draft image authority requires authoritative callbacks and mintId')
  }
  if (!Number.isSafeInteger(maxGrants) || maxGrants < 1 || maxGrants > 4096
    || !Number.isSafeInteger(maxPaths) || maxPaths < 1 || maxPaths > 8) throw new TypeError('Invalid draft authority bounds')
  const grants = new WeakMap()
  let grantCount = 0
  let generation = Symbol('draft image authority generation')
  function auth(context) {
    let value
    try { value = authenticate(context) } catch { fail() }
    if (!value || !text(value.productOwnerId) || value.currentEpoch == null || !identity(value.window)) fail()
    return { productOwnerId: value.productOwnerId, currentEpoch: value.currentEpoch, window: value.window }
  }
  function sameOwner(a, b) {
    return a.productOwnerId === b.productOwnerId && a.currentEpoch === b.currentEpoch && a.window === b.window
  }
  function draft(draftIdentity, owner) {
    let value
    try { value = readDraft(draftIdentity, Object.freeze({ ...owner })) } catch { fail() }
    if (!value || value.live !== true || !sameOwner(value, owner)
      || value.identity !== draftIdentity || !identity(value.incarnation)) fail()
    if (value.kind === 'tree') {
      if (![value.computerId, value.treeId, value.nodeId].every(text)) fail()
      return { kind: value.kind, identity: value.identity, incarnation: value.incarnation,
        computerId: value.computerId, treeId: value.treeId, nodeId: value.nodeId }
    }
    if (value.kind === 'standalone' && text(value.expectedSessionId)
      && text(value.expectedTranscript?.computerId) && text(value.expectedTranscript?.nodeId)) {
      // readDraft must recognize a private host-issued identity. No tree node
      // is fabricated for a standalone session.
      return { kind: value.kind, identity: value.identity, incarnation: value.incarnation,
        expectedSessionId: value.expectedSessionId,
        computerId: value.expectedTranscript.computerId, nodeId: value.expectedTranscript.nodeId }
    }
    fail()
  }
  function sameDraft(a, b) {
    return a.kind === b.kind && a.identity === b.identity && a.incarnation === b.incarnation
      && a.computerId === b.computerId && a.treeId === b.treeId && a.nodeId === b.nodeId
      && a.expectedSessionId === b.expectedSessionId
  }
  function checked(grant, context) {
    const saved = identity(grant) ? grants.get(grant) : null
    if (!saved || saved.generation !== generation || saved.revoked || !sameOwner(saved.owner, auth(context))) fail()
    if (!sameDraft(saved.scope, draft(saved.scope.identity, saved.owner))) fail()
    if (saved.generation !== generation || saved.revoked) fail()
    return saved
  }
  function capture(draftIdentity, context) {
    if (!identity(draftIdentity) || grantCount >= maxGrants) fail()
    const capturedGeneration = generation
    const owner = auth(context), scope = draft(draftIdentity, owner)
    const id = mintId()
    if (!text(id) || !sameOwner(owner, auth(context)) || !sameDraft(scope, draft(draftIdentity, owner))) fail()
    if (capturedGeneration !== generation || grantCount >= maxGrants) fail()
    const grant = Object.freeze({ id })
    grantCount += 1
    grants.set(grant, { generation: capturedGeneration, owner, scope: Object.freeze(scope), paths: new Set(), bound: null, revoked: false })
    return grant
  }
  function assert(grant, context) {
    return checked(grant, context).scope
  }
  function addSaved(grant, savedPath, context) {
    const saved = checked(grant, context)
    if (saved.bound || !text(savedPath) || savedPath.includes('\0') || saved.paths.has(savedPath) || saved.paths.size >= maxPaths) fail()
    // Main supplies the exact successful save path after awaiting the save.
    saved.paths.add(savedPath)
    return Object.freeze({ grantId: grant.id, path: savedPath })
  }
  function destination(sessionId, saved) {
    let value
    try { value = readDestination(sessionId, Object.freeze({ ...saved.owner })) } catch { fail() }
    if (!value || value.live !== true || value.retired === true || value.switchPending === true
      || !identity(value.session) || value.sessionId !== sessionId || !sameOwner(value, saved.owner)
      || !text(value.provider) || !text(value.accountId) || !(value.issued instanceof Set)
      || value.draftIdentity !== saved.scope.identity || value.draftIncarnation !== saved.scope.incarnation) fail()
    const binding = value.transcript
    if (saved.scope.kind === 'tree') {
      if (!binding || binding.computerId !== saved.scope.computerId || value.treeId !== saved.scope.treeId
        || binding.nodeId !== saved.scope.nodeId) fail()
    } else if (sessionId !== saved.scope.expectedSessionId || binding?.computerId !== saved.scope.computerId
      || binding?.nodeId !== saved.scope.nodeId) fail()
    return { session: value.session, sessionId, issued: value.issued, provider: value.provider, accountId: value.accountId }
  }
  function adopt(grant, request, context) {
    const saved = checked(grant, context)
    if (!request || !text(request.sessionId) || !Array.isArray(request.paths) || !request.paths.length || request.paths.length > maxPaths) fail()
    const paths = Array.from(request.paths)
    if (new Set(paths).size !== paths.length || paths.some(file => !text(file) || !saved.paths.has(file))) fail()
    const candidate = destination(request.sessionId, saved)
    if (saved.bound && (saved.bound.session !== candidate.session || saved.bound.sessionId !== candidate.sessionId
      || saved.bound.issued !== candidate.issued || saved.bound.provider !== candidate.provider
      || saved.bound.accountId !== candidate.accountId)) fail()
    checked(grant, context)
    const current = destination(request.sessionId, saved)
    checked(grant, context)
    if (current.session !== candidate.session || current.sessionId !== candidate.sessionId
      || current.issued !== candidate.issued || current.provider !== candidate.provider || current.accountId !== candidate.accountId) fail()
    if (!sameOwner(saved.owner, auth(context)) || saved.revoked || saved.generation !== generation) fail()
    // All authority and every path are validated before the first capability
    // mutation. Use the Set intrinsic so a collaborator cannot run user code
    // midway through the batch by overriding .add().
    for (const file of paths) Set.prototype.add.call(candidate.issued, file)
    saved.bound = candidate
    return Object.freeze({ sessionId: candidate.sessionId, provider: candidate.provider, accountId: candidate.accountId,
      paths: Object.freeze(paths), automaticSend: false })
  }
  function revoke(grant, context) {
    const saved = identity(grant) ? grants.get(grant) : null
    if (!saved || saved.generation !== generation || !sameOwner(saved.owner, auth(context))) fail()
    if (saved.generation !== generation) fail()
    if (!saved.revoked) {
      saved.revoked = true
      grantCount -= 1
      saved.paths.clear()
    }
    return Object.freeze({ revoked: true })
  }
  function invalidateAll() {
    // Never revokes already issued session capabilities or touches saved bytes.
    // A new unforgeable generation invalidates even handles still held by an
    // asynchronous save callback, while permitting fresh lifecycle captures.
    generation = Symbol('draft image authority generation')
    grantCount = 0
  }
  return Object.freeze({ capture, assert, addSaved, adopt, revoke, invalidateAll })
}
module.exports = { createDraftImageAuthority }
