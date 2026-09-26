'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const { custodyFileIO } = require('./durable-image-custody.cjs')
const { plain, readBounded, write: writeFile } = custodyFileIO
const LIMITS = Object.freeze({ entries: 12, images: 8, snapshotBytes: 60000, revisions: 256, readmissions: 256, readmissionBytes: 262144 })
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const binding = entry => JSON.stringify({ text: entry.text, imageReceipts: entry.imageReceipts, selection: entry.selection ?? null })
// One fenced private root per stable product owner + conversation. Parent supplies
// authenticated epoch checks and receipt validation; neither comes from renderer claims.
function createImageOutbox({ root, conversationId, authenticate, validateReceipt, destinationSessionId = null, authorizeTransfer, authorizeCompaction, authorizeNoDispatch, authorizeReadmission, retainHistory = false } = {}) {
  if (!path.isAbsolute(root || '') || typeof conversationId !== 'string' || !conversationId || conversationId.length > 256
    || typeof authenticate !== 'function' || typeof validateReceipt !== 'function') fail('IMAGE_OUTBOX_CONFIGURATION')
  if (!(destinationSessionId === null || (typeof destinationSessionId === 'string' && destinationSessionId && destinationSessionId.length <= 256))) fail('IMAGE_OUTBOX_DESTINATION')
  root = path.resolve(root)
  plain(root, true)
  function owner(context) {
    const auth = authenticate(context)
    if (!auth || auth.authenticated !== true || typeof auth.productOwnerId !== 'string' || !auth.productOwnerId
      || auth.productOwnerId.length > 256) fail('IMAGE_OUTBOX_AUTH_REQUIRED')
    return auth.productOwnerId
  }
  function entries(value, context, verifyAssets) {
    if (!Array.isArray(value) || value.length > LIMITS.entries) fail('IMAGE_OUTBOX_COUNT')
    const seen = new Set()
    const normalized = Array.from(value, entry => {
      if (!entry || !id(entry.envelopeId) || seen.has(entry.envelopeId) || typeof entry.text !== 'string'
        || !['not-sent','unknown','accepted','cancelled'].includes(entry.state) || !Array.isArray(entry.imageReceipts)
        || entry.imageReceipts.length > LIMITS.images) fail('IMAGE_OUTBOX_ENTRY')
      seen.add(entry.envelopeId)
      let imageCount = 0
      const imageReceipts = Array.from(entry.imageReceipts, receipt => {
        if (!receipt || receipt.version !== 1 || !id(receipt.id) || !Number.isInteger(receipt.slot) || receipt.slot < 0
          || receipt.slot >= 12 || !/^[a-f0-9]{64}$/.test(receipt.manifestHash)
          || !Number.isInteger(receipt.imageCount) || receipt.imageCount < 1 || receipt.imageCount > LIMITS.images) fail('IMAGE_OUTBOX_RECEIPT')
        const ref = { version: 1, id: receipt.id, slot: receipt.slot, manifestHash: receipt.manifestHash, imageCount: receipt.imageCount }
        imageCount += ref.imageCount
        if (verifyAssets && validateReceipt(ref, { context, conversationId }) !== ref.imageCount) fail('IMAGE_OUTBOX_ASSET_REFUSED')
        return ref
      })
      if (imageCount > LIMITS.images || (!entry.text.trim() && !imageCount)) fail('IMAGE_OUTBOX_ENTRY')
      let selection
      if (entry.selection !== undefined) {
        if (!entry.selection || typeof entry.selection !== 'object'
          || !['model','effort'].every(key => entry.selection[key] === null
            || (typeof entry.selection[key] === 'string' && entry.selection[key].length > 0 && entry.selection[key].length <= 256))) fail('IMAGE_OUTBOX_SELECTION')
        selection = { model: entry.selection.model, effort: entry.selection.effort }
      }
      if (entry.attemptId !== undefined && !id(entry.attemptId)) fail('IMAGE_OUTBOX_ENTRY')
      let failure
      if (entry.failure !== undefined) {
        if (!entry.failure || typeof entry.failure.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(entry.failure.code)
          || typeof entry.failure.retryable !== 'boolean') fail('IMAGE_OUTBOX_ENTRY')
        if (entry.state === 'not-sent') failure = { code: entry.failure.code, retryable: entry.failure.retryable }
      }
      return { envelopeId: entry.envelopeId, text: entry.text, imageReceipts, state: entry.state, ...(failure ? { failure } : {}), ...(selection ? { selection } : {}), ...(entry.attemptId ? { attemptId: entry.attemptId } : {}) }
    })
    if (Buffer.byteLength(JSON.stringify(normalized)) > LIMITS.snapshotBytes) fail('IMAGE_OUTBOX_SIZE')
    return normalized
  }
  // Recovery receipts survive retirement and compaction. A full receipt ledger
  // refuses new recovery; it never forgets an operation and risks a duplicate.
  function readmissions(value = []) {
    if (!Array.isArray(value) || value.length > LIMITS.readmissions
      || Buffer.byteLength(JSON.stringify(value)) > LIMITS.readmissionBytes) fail('IMAGE_OUTBOX_READMISSION_FULL')
    const operations = new Set(), sources = new Set(), replacements = new Set()
    for (const item of value) {
      if (!item || !id(item.operationId) || !id(item.sourceEnvelopeId) || !id(item.envelopeId)
        || item.sourceEnvelopeId === item.envelopeId || !/^[a-f0-9]{64}$/.test(item.requestHash)
        || !(item.expectedGeneration === null || id(item.expectedGeneration))
        || typeof item.sessionId !== 'string' || !item.sessionId || item.sessionId.length > 256
        || !item.selection || !['model','effort'].every(key => item.selection[key] === null
          || (typeof item.selection[key] === 'string' && item.selection[key].length > 0 && item.selection[key].length <= 256))
        || operations.has(item.operationId) || sources.has(item.sourceEnvelopeId) || replacements.has(item.envelopeId)) fail('IMAGE_OUTBOX_CORRUPT')
      operations.add(item.operationId); sources.add(item.sourceEnvelopeId); replacements.add(item.envelopeId)
    }
    return value
  }
  function recoveryResult(record, receipt) {
    return { ...result(record), readmission: { sourceEnvelopeId: receipt.sourceEnvelopeId,
      expectedGeneration: receipt.expectedGeneration, sessionId: receipt.sessionId,
      envelopeId: receipt.envelopeId, selection: { ...receipt.selection } } }
  }
  function history(context) {
    const productOwnerId = owner(context)
    plain(root, true)
    const records = []
    let checkpoint = null
    try {
      const saved = JSON.parse(readBounded(path.join(root, 'checkpoint.json'), LIMITS.snapshotBytes + LIMITS.readmissionBytes + 16384))
      const { checksum, ...record } = saved || {}
      if (checksum !== hash(JSON.stringify(record)) || record.version !== 1 || !id(record.generation)
        || !Number.isSafeInteger(record.nextIndex) || record.nextIndex < 1
        || !Array.isArray(record.cleanupSlots) || record.cleanupSlots.length > LIMITS.revisions + 1
        || record.cleanupSlots.some(i => !Number.isSafeInteger(i) || i < 0 || i >= record.nextIndex)) fail('IMAGE_OUTBOX_CORRUPT')
      if (record.productOwnerId !== productOwnerId || record.conversationId !== conversationId) fail('IMAGE_OUTBOX_OWNER')
      entries(record.entries, context, false)
      readmissions(record.readmissions)
      checkpoint = record
      records.push(record)
    } catch (e) { if (e.code !== 'ENOENT') { if (e instanceof SyntaxError) fail('IMAGE_OUTBOX_CORRUPT'); throw e } }
    let pending = false
    let cleanupPending = false
    if (checkpoint) for (const index of checkpoint.cleanupSlots) {
      try { plain(path.join(root, String(index)), true); cleanupPending = true }
      catch (e) { if (e.code !== 'ENOENT') throw e }
    }
    const startIndex = checkpoint?.nextIndex ?? 0
    let nextIndex = startIndex
    for (let offset = 0; offset < LIMITS.revisions; offset++) {
      const index = startIndex + offset
      const dir = path.join(root, String(index))
      try { plain(dir, true) } catch (e) { if (e.code === 'ENOENT') break; throw e }
      let raw
      try { raw = readBounded(path.join(dir, 'snapshot.json'), LIMITS.snapshotBytes + LIMITS.readmissionBytes + 4096) }
      catch (e) { if (e.code === 'ENOENT') { pending = true; break }; throw e }
      let saved
      try { saved = JSON.parse(raw) } catch { fail('IMAGE_OUTBOX_CORRUPT') }
      if (!saved || typeof saved !== 'object') fail('IMAGE_OUTBOX_CORRUPT')
      const { checksum, ...record } = saved
      if (checksum !== hash(JSON.stringify(record)) || record.index !== index || record.version !== 1
        || !id(record.generation) || !id(record.operationId)
        || record.previous !== (records.at(-1)?.generation ?? null)) fail('IMAGE_OUTBOX_CORRUPT')
      if (record.productOwnerId !== productOwnerId || record.conversationId !== conversationId) fail('IMAGE_OUTBOX_OWNER')
      entries(record.entries, context, false)
      readmissions(record.readmissions)
      records.push(record)
      nextIndex = index + 1
    }
    return { records, pending, productOwnerId, checkpoint, cleanupPending, nextIndex, revisionCount: nextIndex - startIndex }
  }
  function result(record, pending = false) {
    return { version: 1, generation: record?.generation ?? null, entries: record?.entries ?? [],
      destinationSessionId: record?.destinationSessionId ?? destinationSessionId,
      ...(record?.readmissions?.length ? { readmissions: record.readmissions.map(receipt => ({
        operationId: receipt.operationId, sourceEnvelopeId: receipt.sourceEnvelopeId,
        expectedGeneration: receipt.expectedGeneration, sessionId: receipt.sessionId,
        envelopeId: receipt.envelopeId, selection: { ...receipt.selection },
      })) } : {}),
      automaticSend: false, ...(pending ? { writeBlocked: 'IMAGE_OUTBOX_INCOMPLETE' } : {}) }
  }
  function read(context) {
    const state = history(context)
    return { ...result(state.records.at(-1), state.pending), ...(state.cleanupPending ? { writeBlocked: 'IMAGE_OUTBOX_CLEANUP_REQUIRED' } : {}) }
  }
  function transact(request, context, kind, expectedGeneration = request?.expectedGeneration) {
    if (!request || !id(request.operationId) || !(request.expectedGeneration === null || id(request.expectedGeneration))) fail('IMAGE_OUTBOX_REQUEST')
    const state = history(context)
    let normalized
    const intent = { kind, expectedGeneration: request.expectedGeneration }
    if (kind === 'begin' || kind === 'no-dispatch') {
      if (!id(request.envelopeId) || (kind === 'no-dispatch' && !id(request.attemptId))) fail('IMAGE_OUTBOX_REQUEST')
      intent.envelopeId = request.envelopeId
      if (kind === 'no-dispatch') {
        intent.attemptId = request.attemptId
        if (request.failure !== undefined) {
          if (!request.failure || typeof request.failure.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(request.failure.code)
            || typeof request.failure.retryable !== 'boolean') fail('IMAGE_OUTBOX_REQUEST')
          intent.failure = { code: request.failure.code, retryable: request.failure.retryable }
        }
      }
    } else if (kind === 'resend-current') {
      if (!id(request.envelopeId) || typeof request.sessionId !== 'string' || !request.sessionId
        || request.sessionId.length > 256 || !request.selection
        || typeof request.selection.model !== 'string' || !request.selection.model
        || request.selection.model.length > 256
        || !(request.selection.effort === null || (typeof request.selection.effort === 'string'
          && request.selection.effort.length > 0 && request.selection.effort.length <= 256))) fail('IMAGE_OUTBOX_REQUEST')
      intent.envelopeId = request.envelopeId
      intent.sessionId = request.sessionId
      intent.selection = { model: request.selection.model, effort: request.selection.effort }
    } else if (kind === 'admit') {
      const draft = entries([{ envelopeId: randomUUID(), text: request.text, imageReceipts: request.imageReceipts, selection: request.selection, state: 'not-sent' }], context, false)[0]
      intent.text = draft.text; intent.imageReceipts = draft.imageReceipts; intent.selection = draft.selection ?? null
      normalized = [draft]
    } else if (kind === 'write') {
      normalized = entries(request.entries, context, false)
      intent.entries = normalized
    } else if (kind === 'transfer') {
      if (!(request.expectedDestinationSessionId === null || (typeof request.expectedDestinationSessionId === 'string'
        && request.expectedDestinationSessionId && request.expectedDestinationSessionId.length <= 256))
        || typeof request.destinationSessionId !== 'string' || !request.destinationSessionId || request.destinationSessionId.length > 256) fail('IMAGE_OUTBOX_DESTINATION')
      intent.expectedDestinationSessionId = request.expectedDestinationSessionId
      intent.destinationSessionId = request.destinationSessionId
    } else {
      if (!Array.isArray(request.envelopeIds) || !request.envelopeIds.length || request.envelopeIds.length > LIMITS.entries
        || Array.from(request.envelopeIds).some(value => !id(value))
        || new Set(request.envelopeIds).size !== request.envelopeIds.length) fail('IMAGE_OUTBOX_REQUEST')
      intent.envelopeIds = [...request.envelopeIds]
    }
    const requestHash = hash(JSON.stringify(intent))
    const latest = state.records.at(-1)
    const recoveryReceipts = readmissions(latest?.readmissions)
    const recovered = recoveryReceipts.find(item => item.operationId === request.operationId)
    if (kind === 'resend-current') {
      if (state.pending) fail('IMAGE_OUTBOX_INCOMPLETE')
      if (state.cleanupPending) fail('IMAGE_OUTBOX_CLEANUP_REQUIRED')
      if ((latest?.destinationSessionId ?? destinationSessionId) !== request.sessionId) fail('IMAGE_OUTBOX_DESTINATION_STALE')
    }
    if (recovered) {
      if (recovered.requestHash !== requestHash) fail('IMAGE_OUTBOX_IDEMPOTENCY_CONFLICT')
      if (typeof authorizeReadmission !== 'function' || authorizeReadmission({ context }) !== true) fail('IMAGE_CUSTODY_CANDIDATE_REFUSED')
      return recoveryResult(latest, recovered)
    }
    const prior = state.records.find(record => record.operationId === request.operationId)
    if (prior) {
      if (prior.requestHash !== requestHash) fail('IMAGE_OUTBOX_IDEMPOTENCY_CONFLICT')
      return { ...result(prior), ...(kind === 'begin' ? { delivery: { envelopeId: request.envelopeId, attemptId: prior.entries.find(e => e.envelopeId === request.envelopeId)?.attemptId, dispatchAllowed: false } } : {}) }
    }
    if (state.pending) fail('IMAGE_OUTBOX_INCOMPLETE')
    if (state.cleanupPending) fail('IMAGE_OUTBOX_CLEANUP_REQUIRED')
    if (expectedGeneration !== (latest?.generation ?? null)) fail('IMAGE_OUTBOX_STALE')
    if (state.revisionCount >= LIMITS.revisions) fail('IMAGE_OUTBOX_FULL')
    const previousEntries = latest?.entries ?? []
    let destination = latest?.destinationSessionId ?? destinationSessionId
    let readmission
    if (kind === 'begin' || kind === 'no-dispatch') {
      const selected = previousEntries.find(entry => entry.envelopeId === request.envelopeId)
      if (!selected || (kind === 'begin' ? selected.state !== 'not-sent' : selected.state !== 'unknown' || selected.attemptId !== request.attemptId)) fail('IMAGE_OUTBOX_DELIVERY_REFUSED')
      if (kind === 'no-dispatch' && (typeof authorizeNoDispatch !== 'function' || authorizeNoDispatch({
        envelopeId: request.envelopeId, attemptId: request.attemptId, destinationSessionId: destination, conversationId, context,
      }) !== true)) fail('IMAGE_OUTBOX_NO_DISPATCH_REFUSED')
      normalized = previousEntries.map(entry => entry === selected
        ? { ...entry, failure: kind === 'no-dispatch' ? intent.failure : undefined, state: kind === 'begin' ? 'unknown' : 'not-sent', attemptId: kind === 'begin' ? randomUUID() : entry.attemptId }
        : entry)
    } else if (kind === 'resend-current') {
      const source = previousEntries.find(entry => entry.envelopeId === request.envelopeId)
      if (!source || source.state !== 'not-sent' || source.failure?.code !== 'IMAGE_QUEUE_SELECTION_CHANGED'
        || recoveryReceipts.some(item => item.sourceEnvelopeId === request.envelopeId)) fail('IMAGE_OUTBOX_READMISSION_REFUSED')
      const replacement = { envelopeId: randomUUID(), text: source.text, imageReceipts: source.imageReceipts,
        selection: intent.selection, state: 'not-sent' }
      normalized = entries([...previousEntries.map(entry => entry === source ? { ...entry, state: 'cancelled' } : entry), replacement], context, false)
      readmission = { operationId: request.operationId, requestHash, sourceEnvelopeId: source.envelopeId,
        expectedGeneration: request.expectedGeneration, sessionId: request.sessionId,
        envelopeId: replacement.envelopeId, selection: intent.selection }
      readmissions([...recoveryReceipts, readmission])
    } else if (kind === 'admit') {
      normalized = entries([...previousEntries, ...normalized], context, false)
    } else if (kind === 'transfer') {
      if (request.expectedDestinationSessionId !== destination) fail('IMAGE_OUTBOX_DESTINATION_STALE')
      if (typeof authorizeTransfer !== 'function' || authorizeTransfer({
        sourceSessionId: destination, destinationSessionId: request.destinationSessionId, conversationId, context,
      }) !== true) fail('IMAGE_OUTBOX_TRANSFER_REFUSED')
      destination = request.destinationSessionId
      normalized = previousEntries
    } else if (kind !== 'write') {
      const selected = new Set(request.envelopeIds)
      for (const envelopeId of selected) {
        const entry = previousEntries.find(entry => entry.envelopeId === envelopeId)
        if (!entry || (kind === 'cancel' ? entry.state !== 'not-sent' : !['accepted','cancelled'].includes(entry.state))) fail('IMAGE_OUTBOX_RETIRE_REFUSED')
      }
      normalized = kind === 'cancel'
        ? previousEntries.map(entry => selected.has(entry.envelopeId) ? { ...entry, state: 'cancelled' } : entry)
        : previousEntries.filter(entry => !selected.has(entry.envelopeId))
    }
    if (kind === 'write' && previousEntries.some(old => !normalized.some(entry => entry.envelopeId === old.envelopeId))) fail('IMAGE_OUTBOX_OMISSION_REFUSED')
    const known = new Map()
    for (const record of state.records) for (const entry of record.entries) known.set(entry.envelopeId, entry)
    for (const entry of normalized) {
      const old = known.get(entry.envelopeId)
      if (old && (binding(old) !== binding(entry)
        || (['accepted','cancelled'].includes(old.state) && entry.state !== old.state)
        || (old.state === 'unknown' && entry.state !== 'unknown' && entry.state !== 'accepted' && kind !== 'no-dispatch')
        || (old.attemptId !== entry.attemptId && kind !== 'begin'))) fail('IMAGE_OUTBOX_ENVELOPE_CONFLICT')
      if (entry.state === 'cancelled' && old?.state !== 'cancelled' && kind !== 'cancel' && !(kind === 'resend-current' && entry.envelopeId === request.envelopeId)) fail('IMAGE_OUTBOX_RETIRE_REFUSED')
      // Completion/cancellation must remain possible after an asset expires.
      // New references alone need a fresh custody check.
      if (!old && state.checkpoint && kind !== 'admit' && kind !== 'resend-current') fail('IMAGE_OUTBOX_ADMISSION_REQUIRED')
      if (!old) entries([entry], context, true)
    }
    if (owner(context) !== state.productOwnerId) fail('IMAGE_OUTBOX_AUTH_REQUIRED')
    if (kind === 'resend-current' && (typeof authorizeReadmission !== 'function'
      || authorizeReadmission({ context }) !== true)) fail('IMAGE_CUSTODY_CANDIDATE_REFUSED')
    const index = state.nextIndex
    const dir = path.join(root, String(index))
    try { fs.mkdirSync(dir, { mode: 0o700 }) }
    catch (e) { if (e.code === 'EEXIST') fail('IMAGE_OUTBOX_STALE'); throw e }
    plain(dir, true)
    const record = { version: 1, index, productOwnerId: state.productOwnerId, conversationId,
      generation: randomUUID(), previous: expectedGeneration, operationId: request.operationId, requestHash,
      destinationSessionId: destination, entries: normalized,
      readmissions: readmission ? [...recoveryReceipts, readmission] : recoveryReceipts }
    writeFile(path.join(dir, 'snapshot.pending'), Buffer.from(JSON.stringify({ ...record, checksum: hash(JSON.stringify(record)) }) + '\n'))
    fs.renameSync(path.join(dir, 'snapshot.pending'), path.join(dir, 'snapshot.json'))
    if (process.platform !== 'win32') {
      for (const directory of [dir, root]) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
    }
    if (readmission) return recoveryResult(record, readmission)
    return { ...result(record), ...(kind === 'begin' ? { delivery: { envelopeId: request.envelopeId, attemptId: normalized.find(e => e.envelopeId === request.envelopeId).attemptId, dispatchAllowed: true } } : {}) }
  }
  function mutateWithCapacity(request, context, operation) {
    const kind = { admit: 'admit', write: 'write', cancel: 'cancel', retireAccepted: 'retire', transfer: 'transfer', 'resend-current': 'resend-current' }[operation]
    if (!kind) fail('IMAGE_OUTBOX_REQUEST')
    // Recovery is one atomic publication. Refuse a full journal without doing
    // maintenance before its source, receipt and candidate checks succeed.
    if (kind === 'resend-current') return transact(request, context, kind)
    const capacity = reserveCapacity(request, context)
    // Keep the original intent hash for an identical retry after maintenance.
    return transact(request, context, kind, capacity.compacted ? capacity.generation : request.expectedGeneration)
  }
  function archiveDirectory(generation) {
    const parent = path.join(root, 'archive')
    for (const directory of [parent, path.join(parent, generation)]) {
      try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      plain(directory, true)
    }
    return path.join(parent, generation)
  }
  // The native service reserves both begin and completion before dispatch.
  // A read never performs maintenance. The authenticated mutation owns the
  // current generation; compaction preserves every envelope and archives bytes.
  function reserveCapacity(request, context, slots = 1) {
    if (![1, 2].includes(slots)) fail('IMAGE_OUTBOX_REQUEST')
    let state = history(context)
    if (state.pending) fail('IMAGE_OUTBOX_INCOMPLETE')
    if (state.records.some(record => record.operationId === request.operationId)) return { ...result(state.records.at(-1)), compacted: false }
    if (state.cleanupPending && retainHistory && state.checkpoint?.expectedGeneration !== undefined) {
      compact({ operationId: state.checkpoint.operationId, expectedGeneration: state.checkpoint.expectedGeneration }, context)
      state = history(context)
    }
    if (state.cleanupPending) fail('IMAGE_OUTBOX_CLEANUP_REQUIRED')
    if (LIMITS.revisions - state.revisionCount >= slots) return { ...result(state.records.at(-1)), compacted: false }
    if (request.expectedGeneration !== (state.records.at(-1)?.generation ?? null)) fail('IMAGE_OUTBOX_STALE')
    return { ...compact({ operationId: randomUUID(), expectedGeneration: request.expectedGeneration }, context), compacted: true }
  }
  // Explicit maintenance only. It never sends and never reclaims image bytes.
  // The atomic checkpoint is the retirement fence: post-checkpoint new work
  // must enter through admit(), which mints an ID; forgotten IDs cannot replay.
  function compact(request, context) {
    if (!request || !id(request.operationId) || !(request.expectedGeneration === null || id(request.expectedGeneration))) fail('IMAGE_OUTBOX_REQUEST')
    const state = history(context)
    if (typeof authorizeCompaction !== 'function' || authorizeCompaction({ conversationId, context }) !== true) fail('IMAGE_OUTBOX_COMPACTION_REFUSED')
    const requestHash = hash(JSON.stringify({ kind: 'compact', expectedGeneration: request.expectedGeneration }))
    let checkpoint = state.checkpoint
    if (checkpoint?.operationId === request.operationId) {
      if (checkpoint.requestHash !== requestHash) fail('IMAGE_OUTBOX_IDEMPOTENCY_CONFLICT')
    } else {
      if (state.pending) fail('IMAGE_OUTBOX_INCOMPLETE')
      if (state.cleanupPending) fail('IMAGE_OUTBOX_CLEANUP_REQUIRED')
      const latest = state.records.at(-1)
      if (request.expectedGeneration !== (latest?.generation ?? null)) fail('IMAGE_OUTBOX_STALE')
      if (!latest) fail('IMAGE_OUTBOX_COMPACTION_REFUSED')
      const index = state.nextIndex
      if (!Number.isSafeInteger(index + 1)) fail('IMAGE_OUTBOX_FULL')
      const reservation = path.join(root, String(index))
      try { fs.mkdirSync(reservation, { mode: 0o700 }) }
      catch (e) { if (e.code === 'EEXIST') fail('IMAGE_OUTBOX_STALE'); throw e }
      plain(reservation, true)
      const start = state.checkpoint?.nextIndex ?? 0
      checkpoint = { version: 1, productOwnerId: state.productOwnerId, conversationId,
        generation: randomUUID(), operationId: request.operationId, requestHash,
        expectedGeneration: request.expectedGeneration, nextIndex: index + 1, cleanupSlots: Array.from({ length: index - start + 1 }, (_, i) => start + i),
        destinationSessionId: latest.destinationSessionId ?? destinationSessionId,
        entries: latest.entries, readmissions: readmissions(latest.readmissions) }
      writeFile(path.join(root, 'checkpoint.pending'), Buffer.from(JSON.stringify({
        ...checkpoint, checksum: hash(JSON.stringify(checkpoint)),
      }) + '\n'))
      if (retainHistory && state.checkpoint) {
        const archive = archiveDirectory(state.checkpoint.generation)
        fs.copyFileSync(path.join(root, 'checkpoint.json'), path.join(archive, randomUUID() + '.checkpoint.json'), fs.constants.COPYFILE_EXCL)
      }
      fs.renameSync(path.join(root, 'checkpoint.pending'), path.join(root, 'checkpoint.json'))
      if (process.platform !== 'win32') {
        const fd = fs.openSync(root, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      }
    }
    // Missing files from a previously interrupted explicit cleanup are already
    // reclaimed. An unknown file or link stops cleanup; no recursive removal.
    for (const index of checkpoint.cleanupSlots) {
      const dir = path.join(root, String(index))
      try { plain(dir, true) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
      const names = fs.readdirSync(dir)
      if (names.some(name => !['snapshot.json','snapshot.pending'].includes(name))) fail('IMAGE_OUTBOX_CLEANUP_REFUSED')
      if (retainHistory) {
        for (const name of names) plain(path.join(dir, name), false)
        fs.renameSync(dir, path.join(archiveDirectory(checkpoint.generation), String(index)))
        continue
      }
      for (const name of names) {
        const file = path.join(dir, name)
        plain(file, false)
        fs.unlinkSync(file)
      }
      fs.rmdirSync(dir)
    }
    return result(checkpoint)
  }
  return Object.freeze({
    read,
    admit: (request, context) => transact(request, context, 'admit'),
    resendCurrent: (request, context) => transact(request, context, 'resend-current'),
    compact,
    reserveCapacity,
    mutateWithCapacity,
    beginDelivery: (request, context) => transact(request, context, 'begin'),
    resolveNoDispatch: (request, context) => transact(request, context, 'no-dispatch'),
    write: (request, context) => transact(request, context, 'write'),
    cancel: (request, context) => transact(request, context, 'cancel'),
    retireAccepted: (request, context) => transact(request, context, 'retire'),
    transfer: (request, context) => transact(request, context, 'transfer'),
  })
}
module.exports = { createImageOutbox, LIMITS }
