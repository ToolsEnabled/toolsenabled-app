'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { supportFor, deliveryByteLimitFor } = require('./provider-image-support.cjs')

// Chosen storage budgets, independent of provider delivery budgets. No eviction:
// full, incomplete and expired reservations remain visible until owner cleanup.
const LIMITS = Object.freeze({ records: 12, images: 8, imageBytes: 8 * 1024 * 1024,
  recordBytes: 16 * 1024 * 1024, manifestBytes: 16384, ageMs: 24 * 60 * 60 * 1000 })
const EXT = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function refuse(code) { throw Object.assign(new Error(code), { code }) }
function string(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 }
function signature(mime, b) {
  if (mime === 'image/png') return b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  if (mime === 'image/jpeg') return b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255
  if (mime === 'image/gif') return b.length >= 13 && ['GIF87a','GIF89a'].includes(b.toString('ascii',0,6))
  return mime === 'image/webp' && b.length >= 12 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP'
}
// Root is a pre-created private directory selected by the account/profile fence.
// Every component is checked before access; symlinks/junctions are never authority.
function plain(target, directory) {
  const absolute = path.resolve(target)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) refuse('IMAGE_CUSTODY_PATH_REFUSED')
  }
  const stat = fs.lstatSync(absolute)
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) refuse('IMAGE_CUSTODY_PATH_REFUSED')
  return stat
}
function readBounded(file, max) {
  const stat = plain(file, false)
  if (stat.size > max) refuse('IMAGE_CUSTODY_SIZE')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const actual = fs.fstatSync(fd)
    if (actual.ino !== stat.ino || actual.dev !== stat.dev || actual.size !== stat.size) refuse('IMAGE_CUSTODY_CHANGED')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!n) refuse('IMAGE_CUSTODY_CORRUPT')
      offset += n
    }
    if (fs.fstatSync(fd).size !== stat.size) refuse('IMAGE_CUSTODY_CHANGED')
    return bytes
  } finally { fs.closeSync(fd) }
}
function write(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600)
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function createDurableImageCustody({ root, authenticate, authorizeCandidate, authorizeRelease, engineImageBytes, now = Date.now } = {}) {
  if (!path.isAbsolute(root || '') || typeof authenticate !== 'function' || typeof authorizeCandidate !== 'function') refuse('IMAGE_CUSTODY_CONFIGURATION')
  root = path.resolve(root)
  plain(root, true)
  function identity(context) {
    const auth = authenticate(context)
    if (!auth || auth.authenticated !== true || !string(auth.productOwnerId)) refuse('IMAGE_CUSTODY_AUTH_REQUIRED')
    return auth.productOwnerId
  }
  function scope(value) {
    if (!value || !['conversationId','accountId','provider'].every(k => string(value[k]))) refuse('IMAGE_CUSTODY_SCOPE')
    return { conversationId: value.conversationId, accountId: value.accountId, provider: value.provider }
  }
  function load(receipt, context, { allowExpired = false } = {}) {
    const owner = identity(context)
    if (!receipt || receipt.version !== 1 || !Number.isInteger(receipt.slot) || receipt.slot < 0 || receipt.slot >= LIMITS.records
      || !/^[a-f0-9-]{36}$/.test(receipt.id) || !/^[a-f0-9]{64}$/.test(receipt.manifestHash)) refuse('IMAGE_CUSTODY_RECEIPT')
    plain(root, true)
    const dir = path.join(root, String(receipt.slot))
    plain(dir, true)
    const raw = readBounded(path.join(dir, 'manifest.json'), LIMITS.manifestBytes)
    if (hash(raw) !== receipt.manifestHash) refuse('IMAGE_CUSTODY_CORRUPT')
    let record
    try { record = JSON.parse(raw) } catch { refuse('IMAGE_CUSTODY_CORRUPT') }
    if (!record || typeof record !== 'object') refuse('IMAGE_CUSTODY_CORRUPT')
    if (record.version !== 1 || record.id !== receipt.id || record.productOwnerId !== owner) refuse('IMAGE_CUSTODY_OWNER')
    scope(record)
    if (!Number.isSafeInteger(record.createdAt) || record.createdAt > now() || (!allowExpired && now() - record.createdAt > LIMITS.ageMs)) refuse('IMAGE_CUSTODY_EXPIRED')
    if (!Array.isArray(record.images) || !record.images.length || record.images.length > LIMITS.images) refuse('IMAGE_CUSTODY_CORRUPT')
    let total = 0
    const images = Array.from(record.images, (image, index) => {
      if (!image || !Object.hasOwn(EXT, image.mime) || image.index !== index || !Number.isSafeInteger(image.size)
        || image.size <= 0 || image.size > LIMITS.imageBytes || !/^[a-f0-9]{64}$/.test(image.sha256)) refuse('IMAGE_CUSTODY_CORRUPT')
      total += image.size
      if (total > LIMITS.recordBytes) refuse('IMAGE_CUSTODY_SIZE')
      const file = path.join(dir, record.id + '-' + index + '.' + EXT[image.mime])
      const bytes = readBounded(file, LIMITS.imageBytes)
      if (bytes.length !== image.size || hash(bytes) !== image.sha256 || !signature(image.mime, bytes)) refuse('IMAGE_CUSTODY_CORRUPT')
      return { path: file, mime: image.mime, size: image.size, sha256: image.sha256, index }
    })
    return { record, images }
  }
  function retain(request, context) {
    const productOwnerId = identity(context)
    const binding = scope(request)
    if (!/^[a-f0-9-]{36}$/.test(request.operationId)) refuse('IMAGE_CUSTODY_OPERATION')
    if (!Array.isArray(request.images) || !request.images.length || request.images.length > LIMITS.images) refuse('IMAGE_CUSTODY_COUNT')
    let total = 0
    const images = Array.from(request.images, image => {
      if (!image || !Object.hasOwn(EXT, image.mime) || !Buffer.isBuffer(image.bytes)) refuse('IMAGE_CUSTODY_FORMAT')
      const bytes = Buffer.from(image.bytes)
      total += bytes.length
      if (!bytes.length || bytes.length > LIMITS.imageBytes || total > LIMITS.recordBytes) refuse('IMAGE_CUSTODY_SIZE')
      if (!signature(image.mime, bytes)) refuse('IMAGE_CUSTODY_FORMAT')
      return { mime: image.mime, bytes }
    })
    plain(root, true)
    const descriptors = images.map((image, index) => ({ index, mime: image.mime, size: image.bytes.length, sha256: hash(image.bytes) }))
    const requestHash = hash(JSON.stringify({ productOwnerId, ...binding, images: descriptors }))
    for (let i = 0; i < LIMITS.records; i++) {
      const dir = path.join(root, String(i))
      try { plain(dir, true) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
      let raw
      try { raw = readBounded(path.join(dir, 'manifest.json'), LIMITS.manifestBytes) }
      catch (e) { if (e.code === 'ENOENT') refuse('IMAGE_CUSTODY_INCOMPLETE'); throw e }
      let existing
      try { existing = JSON.parse(raw) } catch { refuse('IMAGE_CUSTODY_CORRUPT') }
      if (!existing || typeof existing !== 'object') refuse('IMAGE_CUSTODY_CORRUPT')
      if (existing.productOwnerId === productOwnerId && existing.operationId === request.operationId) {
        if (existing.requestHash !== requestHash) refuse('IMAGE_CUSTODY_IDEMPOTENCY_CONFLICT')
        const receipt = { version: 1, id: existing.id, slot: i, manifestHash: hash(raw),
          images: existing.images, imageCount: existing.images.length, expiresAt: existing.createdAt + LIMITS.ageMs, state: 'retained' }
        load(receipt, context)
        return receipt
      }
    }
    let slot = -1
    for (let i = 0; i < LIMITS.records; i++) {
      try { try { fs.lstatSync(path.join(root, i + '.retiring')); continue } catch (error) { if (error.code !== 'ENOENT') throw error }; fs.mkdirSync(path.join(root, String(i)), { mode: 0o700 }); slot = i; break }
      catch (e) {
        if (e.code !== 'EEXIST') throw e
        let raw
        try { raw = readBounded(path.join(root, String(i), 'manifest.json'), LIMITS.manifestBytes) }
        catch (error) { if (error.code === 'ENOENT') refuse('IMAGE_CUSTODY_INCOMPLETE'); throw error }
        let existing
        try { existing = JSON.parse(raw) } catch { refuse('IMAGE_CUSTODY_CORRUPT') }
        if (existing?.productOwnerId === productOwnerId && existing.operationId === request.operationId) {
          if (existing.requestHash !== requestHash) refuse('IMAGE_CUSTODY_IDEMPOTENCY_CONFLICT')
          const receipt = { version: 1, id: existing.id, slot: i, manifestHash: hash(raw),
            images: existing.images, imageCount: existing.images.length, expiresAt: existing.createdAt + LIMITS.ageMs, state: 'retained' }
          load(receipt, context)
          return receipt
        }
      }
    }
    if (slot < 0) refuse('IMAGE_CUSTODY_FULL')
    const dir = path.join(root, String(slot))
    plain(dir, true)
    const record = { version: 1, id: randomUUID(), operationId: request.operationId, requestHash, productOwnerId, ...binding, createdAt: now(),
      images: descriptors }
    images.forEach((image, index) => write(path.join(dir, record.id + '-' + index + '.' + EXT[image.mime]), image.bytes))
    const raw = Buffer.from(JSON.stringify(record) + '\n')
    write(path.join(dir, 'manifest.pending'), raw)
    fs.renameSync(path.join(dir, 'manifest.pending'), path.join(dir, 'manifest.json'))
    // Sync directory entries where supported; Windows does not expose directory fsync.
    if (process.platform !== 'win32') {
      for (const directory of [dir, root]) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
    }
    return { version: 1, id: record.id, slot, manifestHash: hash(raw), images: record.images, imageCount: record.images.length, expiresAt: record.createdAt + LIMITS.ageMs, state: 'retained' }
  }
  function reopen(receipt, context) {
    const { record } = load(receipt, context)
    return { version: 1, id: record.id, ...scope(record), images: record.images, state: 'retained', automaticSend: false }
  }
  // Display is owner-bound read-only custody. Expiry still blocks delivery,
  // but must not hide an image the person deliberately retained.
  function preview(receipt, context) {
    const { record, images } = load(receipt, context, { allowExpired: true })
    const first = images[0]
    const bytes = readBounded(first.path, LIMITS.imageBytes)
    if (bytes.length !== first.size || hash(bytes) !== first.sha256) refuse('IMAGE_CUSTODY_CHANGED')
    identity(context)
    return { version: 1, id: record.id, ...scope(record),
      thumbnail: 'data:' + first.mime + ';base64,' + bytes.toString('base64'),
      imageCount: images.length, automaticSend: false }
  }
  function reissue(receipt, candidate, context) {
    const { record, images } = load(receipt, context)
    const target = scope(candidate)
    if (!string(candidate.sessionId) || candidate.productOwnerId !== record.productOwnerId
      || target.conversationId !== record.conversationId
      || authorizeCandidate({ source: scope(record), candidate: { ...candidate }, context }) !== true) refuse('IMAGE_CUSTODY_CANDIDATE_REFUSED')
    const support = supportFor(target.provider)
    if (!support.delivers) refuse('IMAGE_CUSTODY_PROVIDER_UNSUPPORTED')
    const limit = deliveryByteLimitFor(target.provider, engineImageBytes)
    if (support.readsTheFile && limit === null) refuse('IMAGE_CUSTODY_PROVIDER_LIMIT_UNKNOWN')
    if (limit !== null && images.some(image => image.size > limit)) refuse('IMAGE_CUSTODY_PROVIDER_SIZE')
    return { version: 1, id: record.id, sessionId: candidate.sessionId, images, automaticSend: false }
  }
  // Explicit accepted-only release. The host reference registry must account for
  // queued, transcript/history and live-session pins before authorizing reclamation.
  function releaseAccepted(receipt, context) {
    const productOwnerId = identity(context)
    if (!receipt || receipt.version !== 1 || !Number.isInteger(receipt.slot) || receipt.slot < 0 || receipt.slot >= LIMITS.records
      || !/^[a-f0-9-]{36}$/.test(receipt.id) || !/^[a-f0-9]{64}$/.test(receipt.manifestHash)) refuse('IMAGE_CUSTODY_RECEIPT')
    plain(root, true)
    const original = path.join(root, String(receipt.slot))
    const retiring = path.join(root, receipt.slot + '.retiring')
    let resumed = false
    try { plain(retiring, true); resumed = true } catch (e) { if (e.code !== 'ENOENT') throw e }
    const dir = resumed ? retiring : original
    plain(dir, true)
    const raw = readBounded(path.join(dir, 'manifest.json'), LIMITS.manifestBytes)
    if (hash(raw) !== receipt.manifestHash) refuse('IMAGE_CUSTODY_CORRUPT')
    let record
    try { record = JSON.parse(raw) } catch { refuse('IMAGE_CUSTODY_CORRUPT') }
    if (!record || record.productOwnerId !== productOwnerId || record.id !== receipt.id) refuse('IMAGE_CUSTODY_OWNER')
    const source = scope(record)
    const authority = typeof authorizeRelease === 'function' ? authorizeRelease({ receipt, source, context }) : null
    if (!authority || authority.state !== 'accepted' || !Array.isArray(authority.referenceOwners)
      || authority.referenceOwners.length !== 0) refuse('IMAGE_CUSTODY_RELEASE_REFUSED')
    if (!resumed) fs.renameSync(original, retiring)
    plain(retiring, true)
    if (hash(readBounded(path.join(retiring, 'manifest.json'), LIMITS.manifestBytes)) !== receipt.manifestHash) refuse('IMAGE_CUSTODY_CHANGED')
    const names = fs.readdirSync(retiring)
    const allowedNames = new Set(['manifest.json', ...Array.from(record.images || [], (image, index) => record.id + '-' + index + '.' + EXT[image?.mime])])
    if (names.some(name => !allowedNames.has(name))) refuse('IMAGE_CUSTODY_RELEASE_REFUSED')
    // Manifest is removed last so an interrupted explicit release can resume.
    for (const name of names.filter(name => name !== 'manifest.json')) {
      const file = path.join(retiring, name); plain(file, false); fs.unlinkSync(file)
    }
    fs.unlinkSync(path.join(retiring, 'manifest.json'))
    fs.rmdirSync(retiring)
    return { version: 1, id: receipt.id, state: 'released', automaticSend: false }
  }
  return Object.freeze({ retain, reopen, preview, reissue, releaseAccepted })
}
module.exports = { createDurableImageCustody, LIMITS }

module.exports.custodyFileIO = Object.freeze({ plain, readBounded, write })
