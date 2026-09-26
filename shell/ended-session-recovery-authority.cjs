'use strict'
const path = require('node:path')
const { randomUUID } = require('node:crypto')

// MAIN-only authority. All readers are synchronous, side-effect-free reads of
// native ownership/session/transcript state. No renderer field becomes source
// authority. This module does not start, send, transfer custody, or issue paths.
// All results (paths, cwd, native pointers, reservations) remain MAIN-only.
// Renderer responses contain only minimal identifiers/ACKs, never snapshots.
function createEndedSessionRecoveryAuthority({
  authenticate, readSource, readDestination, mintId, mintSessionId,
  validateCustodyReceipt, verifyNotStarted, maxRecords = 128, maxPaths = 8, maxReceipts = 8,
} = {}) {
  if ([authenticate, readSource, readDestination, mintId, mintSessionId].some(fn => typeof fn !== 'function')) {
    throw new TypeError('Recovery authority requires authoritative callbacks')
  }
  for (const limit of [maxRecords, maxPaths, maxReceipts]) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096) throw new TypeError('Invalid recovery authority bound')
  }
  const records = new Map()
  let generation = Symbol('recovery generation')
  let serial = 0n
  let sessionSerial = 0n
  const sessionNamespace = randomUUID()
  const fail = code => { throw Object.assign(new Error(code), { code }) }
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
  const object = value => value !== null && typeof value === 'object'
  function uniqueId() {
    const base = mintId()
    if (!text(base)) fail('RECOVERY_STALE')
    serial += 1n
    return base + ':' + serial
  }
  function uniqueSessionId() {
    const base = mintSessionId()
    if (!text(base) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(base)) fail('RECOVERY_DESTINATION_REFUSED')
    sessionSerial += 1n
    const sessionId = base + '-' + sessionNamespace + '-' + sessionSerial
    if (sessionId.length > 128) fail('RECOVERY_DESTINATION_REFUSED')
    return sessionId
  }
  function auth(context) {
    let value
    try { value = authenticate(context) } catch { fail('RECOVERY_OWNER_CHANGED') }
    if (!value || !object(value.window) || !text(value.productOwnerId) || !text(value.productPrincipal) || value.currentEpoch == null) fail('RECOVERY_OWNER_CHANGED')
    return Object.freeze({ window: value.window, productOwnerId: value.productOwnerId, productPrincipal: value.productPrincipal, currentEpoch: value.currentEpoch })
  }
  const sameOwner = (a, b) => a.window === b.window && a.productOwnerId === b.productOwnerId && a.productPrincipal === b.productPrincipal && a.currentEpoch === b.currentEpoch
  function sourceSnapshot(sessionId, owner) {
    let value
    try { value = readSource(sessionId, owner) } catch { fail('RECOVERY_SOURCE_REQUIRED') }
    if (!value || !object(value.session) || value.sessionId !== sessionId || value.live !== true
      || value.retired === true || value.switchPending === true || !sameOwner(value, owner)
      || !text(value.transcript?.computerId) || !text(value.transcript?.nodeId)
      || !text(value.provider) || !text(value.accountId) || !text(value.threadId)
      || !text(value.cwd) || !path.isAbsolute(value.cwd) || path.normalize(value.cwd) !== value.cwd || !(value.issued instanceof Set)) fail('RECOVERY_SOURCE_REQUIRED')
    const paths = Array.from(value.issued)
    if (paths.length > maxPaths) fail('RECOVERY_LIMIT')
    if (paths.some(file => !text(file))) fail('RECOVERY_SOURCE_REQUIRED')
    return Object.freeze({ session: value.session, sessionId,
      transcript: Object.freeze({ computerId: value.transcript.computerId, nodeId: value.transcript.nodeId }),
      provider: value.provider, accountId: value.accountId, threadId: value.threadId, cwd: value.cwd, issuedPaths: Object.freeze(paths) })
  }
  const sameSource = (a, b) => a.session === b.session && a.sessionId === b.sessionId
    && a.transcript.computerId === b.transcript.computerId && a.transcript.nodeId === b.transcript.nodeId
    && a.provider === b.provider && a.accountId === b.accountId && a.threadId === b.threadId && a.cwd === b.cwd
    && a.issuedPaths.length === b.issuedPaths.length && a.issuedPaths.every(file => b.issuedPaths.includes(file))
  function checked(receipt, context) {
    const owner = auth(context)
    const saved = receipt && text(receipt.recoveryId) ? records.get(receipt.recoveryId) : null
    if (!saved || saved.generation !== generation || saved.revoked) fail('RECOVERY_STALE')
    if (!sameOwner(saved.owner, owner)) fail('RECOVERY_OWNER_CHANGED')
    return saved
  }
  function recoverySnapshot(saved) {
    return Object.freeze({ sourceSessionId: saved.source.sessionId,
      transcript: saved.source.transcript, sourceProvider: saved.source.provider, sourceAccountId: saved.source.accountId,
      productPrincipal: saved.owner.productPrincipal, sourceThreadId: saved.source.threadId, cwd: saved.source.cwd,
      issuedPaths: saved.source.issuedPaths, retainedReceipts: saved.retainedReceipts, automaticSend: false })
  }
  function capture(sessionId, { retainedReceipts = [] } = {}, context) {
    if (!text(sessionId)) fail('RECOVERY_SOURCE_REQUIRED')
    const owner = auth(context), initialGeneration = generation
    if (records.size >= maxRecords) fail('RECOVERY_LIMIT')
    const source = sourceSnapshot(sessionId, owner)
    if (!Array.isArray(retainedReceipts) || retainedReceipts.length > maxReceipts) fail('RECOVERY_LIMIT')
    const receipts = Array.from(retainedReceipts, receipt => {
      if (!receipt || typeof validateCustodyReceipt !== 'function') fail('RECOVERY_RECEIPT_REFUSED')
      let validated
      try { validated = validateCustodyReceipt(receipt, { source, context }) } catch { fail('RECOVERY_RECEIPT_REFUSED') }
      if (validated !== true || receipt.version !== 1 || !text(receipt.id)
        || !Number.isSafeInteger(receipt.slot) || receipt.slot < 0 || !/^[a-f0-9]{64}$/.test(receipt.manifestHash)
        || !Number.isSafeInteger(receipt.imageCount) || receipt.imageCount < 1 || receipt.imageCount > 8) fail('RECOVERY_RECEIPT_REFUSED')
      return Object.freeze({ version: 1, id: receipt.id, slot: receipt.slot,
        manifestHash: receipt.manifestHash, imageCount: receipt.imageCount })
    })
    if (new Set(receipts.map(receipt => receipt.id)).size !== receipts.length) fail('RECOVERY_RECEIPT_REFUSED')
    const id = uniqueId()
    if (!text(id) || records.has(id)) fail('RECOVERY_STALE')
    if (!sameOwner(owner, auth(context)) || initialGeneration !== generation) fail('RECOVERY_OWNER_CHANGED')
    if (!sameSource(source, sourceSnapshot(sessionId, owner))) fail('RECOVERY_SOURCE_REQUIRED')
    if (initialGeneration !== generation || !sameOwner(owner, auth(context))) fail('RECOVERY_OWNER_CHANGED')
    if (records.size >= maxRecords) fail('RECOVERY_LIMIT')
    const saved = { generation, owner, source, retainedReceipts: Object.freeze(receipts), sessionId: null, reservation: null, bound: null, revoked: false }
    records.set(id, saved)
    return Object.freeze({ recoveryId: id })
  }
  function inspect(receipt, context) { return recoverySnapshot(checked(receipt, context)) }
  function reserve(receipt, context) {
    const saved = checked(receipt, context)
    if (saved.reservation) return saved.reservation
    const sessionId = saved.sessionId || uniqueSessionId()
    if (!text(sessionId) || sessionId === saved.source.sessionId) fail('RECOVERY_DESTINATION_REFUSED')
    let existing
    try { existing = readDestination(sessionId, saved.owner) } catch { fail('RECOVERY_DESTINATION_REFUSED') }
    if (existing != null || Array.from(records.values()).some(record => record !== saved && record.sessionId === sessionId)) fail('RECOVERY_DESTINATION_REFUSED')
    const id = uniqueId()
    if (!text(id)) fail('RECOVERY_STALE')
    checked(receipt, context)
    const reservation = Object.freeze({ id, sessionId })
    saved.sessionId = sessionId
    saved.reservation = reservation
    return reservation
  }
  function destination(saved, reservation, requireBinding = true) {
    let value
    try { value = readDestination(reservation.sessionId, saved.owner) } catch { fail('RECOVERY_DESTINATION_REFUSED') }
    if (!value || !object(value.session) || value.session === saved.source.session
      || value.sessionId !== reservation.sessionId || value.recoveryReservation !== reservation
      || value.live !== true || value.retired === true || value.switchPending === true
      || !sameOwner(value, saved.owner) || !text(value.provider) || !text(value.accountId) || !text(value.threadId)
      || (requireBinding && (value.transcript?.computerId !== saved.source.transcript.computerId
        || value.transcript?.nodeId !== saved.source.transcript.nodeId))) fail('RECOVERY_DESTINATION_REFUSED')
    return Object.freeze({ session: value.session, sessionId: value.sessionId,
      provider: value.provider, accountId: value.accountId, threadId: value.threadId, transcript: saved.source.transcript })
  }
  const sameDestination = (a, b) => a.session === b.session && a.sessionId === b.sessionId
    && a.provider === b.provider && a.accountId === b.accountId && a.threadId === b.threadId
  function authorizeBinding(receipt, reservation, context) {
    const saved = checked(receipt, context)
    if (!saved.reservation || saved.reservation !== reservation) fail('RECOVERY_DESTINATION_REFUSED')
    const candidate = destination(saved, reservation, false)
    checked(receipt, context)
    const current = destination(saved, reservation, false)
    if (!sameDestination(candidate, current)) fail('RECOVERY_DESTINATION_REFUSED')
    checked(receipt, context)
    if (saved.bound && !sameDestination(saved.bound, candidate)) fail('RECOVERY_DESTINATION_REFUSED')
    saved.bound = candidate
    return candidate
  }
  function claim(receipt, reservation, context) {
    const saved = checked(receipt, context)
    if (!saved.reservation || saved.reservation !== reservation) fail('RECOVERY_DESTINATION_REFUSED')
    const candidate = destination(saved, reservation)
    if (saved.bound && !sameDestination(saved.bound, candidate)) fail('RECOVERY_DESTINATION_REFUSED')
    checked(receipt, context)
    const current = destination(saved, reservation)
    if (!sameDestination(candidate, current)) fail('RECOVERY_DESTINATION_REFUSED')
    checked(receipt, context)
    saved.bound = candidate
    return Object.freeze({ ...recoverySnapshot(saved), destination: candidate, automaticSend: false })
  }
  function releaseNotStarted(receipt, reservation, context) {
    const saved = checked(receipt, context)
    if (saved.bound || !saved.reservation || saved.reservation !== reservation || typeof verifyNotStarted !== 'function') fail('RECOVERY_RETRY_REFUSED')
    let proof, current
    try {
      proof = verifyNotStarted({ reservation, sessionId: reservation.sessionId }, context)
      current = readDestination(reservation.sessionId, saved.owner)
    } catch { fail('RECOVERY_RETRY_REFUSED') }
    if (proof !== true || current != null) fail('RECOVERY_RETRY_REFUSED')
    checked(receipt, context)
    saved.reservation = null
    return Object.freeze({ sessionId: saved.sessionId, retryAllowed: true, automaticSend: false })
  }
  function revoke(receipt, context) {
    const saved = checked(receipt, context)
    saved.revoked = true
    records.delete(receipt.recoveryId)
    return Object.freeze({ revoked: true })
  }
  function invalidateAll() {
    generation = Symbol('recovery generation')
    records.clear()
  }
  return Object.freeze({ capture, inspect, reserve, authorizeBinding, claim, releaseNotStarted, revoke, invalidateAll })
}
module.exports = { createEndedSessionRecoveryAuthority }
