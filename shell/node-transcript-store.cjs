'use strict'

// One file per spoken entry. Updates replace that entry atomically; an append
// never reads or rewrites the history of this or another node.
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const digest = value => createHash('sha256').update(value).digest('hex')
const identity = value => {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\0')) throw new Error('Invalid transcript identity.')
  return value
}
/* WHO THIS TRANSCRIPT BELONGS TO, OR A REFUSAL THAT SAYS WHICH HALF IS MISSING.
 *
 * T406 (measured 2026-09-18 on the earlier candidate): mcTranscripts.list()
 * reached this file with no request at all, and `async function list({
 * computerId })` answered with a TypeError -- "Cannot destructure property
 * 'computerId' of 'undefined'" -- which shell/main.cjs then dressed as
 * MC_TRANSCRIPT_STORAGE_FAILED. Storage had not failed. Nobody had said whose
 * transcript was wanted. Those are different answers, and a caller holding a
 * storage-failure code will go looking for a disk problem that is not there.
 *
 * Every operation's identity now comes through here. A request that cannot
 * name its computer (or, for a per-node operation, its node) is refused by
 * name, with the missing field in the sentence and MC_TRANSCRIPT_IDENTITY_
 * UNRESOLVED as the code, and the shell passes that code through untouched. */
const IDENTITY_UNRESOLVED = 'MC_TRANSCRIPT_IDENTITY_UNRESOLVED'
const identityOf = (request, field) => {
  const value = request && typeof request === 'object' ? request[field] : undefined
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\0')) {
    throw Object.assign(new Error(`The transcript identity could not be resolved: ${field} is ${value === undefined ? 'missing' : 'not a usable id'}.`),
      { code: IDENTITY_UNRESOLVED, field })
  }
  return value
}

function createNodeTranscriptStore({ directory, io = fs, settings = {}, saveSettings = async () => {}, validateDirectory = () => {}, onStorageError = () => {}, recoveryJournal = null }) {
  const root = path.resolve(directory, 'node-transcripts')
  const active = path.join(root, 'active')
  let configuration = { archiveDirectory: path.join(directory, 'transcript-graveyard'), archiveMaxBytes: 256 * 1024 * 1024, deleteNodesOnExit: false, ...settings }
  const queues = new Map()
  const states = new Map()
  // An ENOSPC write may be partial. Keep the intended entry, not a promise
  // that already rejected or a blind retry of an append. Only an explicit
  // retry writes again; reads continue to expose the held conversation.
  const retainedNodes = new Map()
  let diskFailure = null
  let retrying = null
  let journal = null
  let recoveryPreparation = null
  let recoveryInitError = null
  let noticeSent = false
  let turnAdmission = null
  let admissionError = null
  /* B31: A SECOND NODE'S TURN CAN WAIT FOR THE ADMISSION INSTEAD OF BEING TURNED AWAY.
   *
   * reserveTurn below still admits exactly one turn per store and still refuses
   * a second one (MC_TRANSCRIPT_ADMISSION_PENDING) before it claims anything.
   * The host holds an admission until the provider accepts the turn and its
   * words are saved -- on Claude, the CLI's system init, seconds after the first
   * message to a new process -- so a Team member's brief sent while its lead's
   * brief was held was refused, and so was any message to a second agent in that
   * window. This only lets a caller sleep until the held admission is released
   * (or storage fails, or `timeoutMs` passes) and then ask reserveTurn again. It
   * never claims, holds or releases anything itself. */
  let admissionReleased = null
  let wakeAdmissionWaiters = () => {}
  function wakeTurnAdmissionWaiters() {
    const wake = wakeAdmissionWaiters
    admissionReleased = null
    wakeAdmissionWaiters = () => {}
    wake()
  }
  function waitForTurnAdmission(timeoutMs = 0) {
    if (!turnAdmission) return Promise.resolve()
    if (!admissionReleased) admissionReleased = new Promise(resolve => { wakeAdmissionWaiters = resolve })
    const bound = Math.min(Math.max(Number(timeoutMs) || 0, 0), 60_000)
    let timer = null
    return Promise.race([admissionReleased, new Promise(resolve => { timer = setTimeout(resolve, bound) })])
      .finally(() => clearTimeout(timer))
  }
  const diskFull = error => ['ENOSPC', 'EDQUOT'].includes(error?.code) || (error?.cause && diskFull(error.cause))
  let storageWait = null
  const storageWaiters = new Set()
  const diskMessage = 'The disk is full. The last message is unsaved. Conversation changes are kept in memory, not saved to disk. Free disk space, then retry saving. Keep ToolsEnabled open.'
  const isRecoverable = () => !turnAdmission?.uncertainPending && retainedNodes.size > 0 && [...retainedNodes.values()]
    .every(held => held.recoveryRevision === held.revision)
  const storageRefusal = () => ({
    code: diskFull(diskFailure) ? 'MC_TRANSCRIPT_DISK_FULL' : 'MC_TRANSCRIPT_STORAGE_FAILED',
    message: isRecoverable()
      ? (diskFull(diskFailure) ? 'The disk is full. ' : 'Conversation storage could not be written. ')
        + 'Conversation changes are held in recovery storage. Keep ToolsEnabled open, check the disk, then retry saving.'
      : diskFull(diskFailure) ? diskMessage
        : 'Conversation storage could not be written. The last message is unsaved. Changes are kept in memory. Check the disk and its permissions, then retry saving. Keep ToolsEnabled open.',
  })
  const diskRefusal = () => Object.assign(new Error(storageRefusal().message), { code: storageRefusal().code })
  const retainedByteCount = () => [...retainedNodes.values()].reduce((bytes, held) =>
    bytes + Buffer.byteLength(JSON.stringify([...held.retained])) + Buffer.byteLength(JSON.stringify(held.metadata)), 0)
    + (turnAdmission?.uncertainPending ? Buffer.byteLength(JSON.stringify(turnAdmission.uncertainRequest)) : 0)
  const storageStatus = () => diskFailure
    ? { durable: false, recoverable: isRecoverable(), retainedBytes: retainedByteCount(), pendingWrites: queues.size + (turnAdmission ? 1 : 0), pendingTurns: turnAdmission ? 1 : 0, storageError: storageRefusal() }
    : { durable: true, retainedBytes: 0, pendingWrites: queues.size + (turnAdmission ? 1 : 0), pendingTurns: turnAdmission ? 1 : 0,
      ...(admissionError ? { storageError: { code: admissionError.code, message: admissionError.message } } : {}) }
  function waitForStorage() {
    if (!diskFailure) return undefined
    if (!storageWait) storageWait = new Promise(resolve => storageWaiters.add(resolve))
    return storageWait
  }
  function savedAgain() {
    if (diskFailure) return
    noticeSent = false
    admissionError = null
    for (const resolve of storageWaiters) resolve()
    storageWaiters.clear()
    storageWait = null
  }
  function notifyStorageFailure() {
    // A waiting turn re-checks storage at once rather than at its deadline.
    wakeTurnAdmissionWaiters()
    if (noticeSent) return
    noticeSent = true
    // A failed notification sink cannot discard the held conversation.
    try { onStorageError(diskRefusal()) } catch {}
  }
  async function hold(held, error) {
    // Value validation happens before persistence. A writer can reject with
    // a non-OS error too; accepted data must remain held in that case.
    error ||= new Error('Conversation storage write failed.')
    retainedNodes.set(held.key, held)
    if (!diskFailure) diskFailure = error
    if (journal && !recoveryInitError) {
      try {
        await journal.put(held.key, {
          version: 1, metadata: held.metadata, revision: held.revision,
          sequence: held.sequence, retained: [...held.retained],
          errorCode: diskFull(diskFailure) ? 'ENOSPC' : 'EIO',
        }, held.recoveryReservation || undefined)
        held.recoveryReservation = null
        held.recoveryRevision = held.revision
      } catch (error) {
        // Accepted bytes remain in memory if the reserved device also refuses
        // a write. Never label them recoverable or advance the producer.
        held.recoveryError = error
      }
    }
    notifyStorageFailure()
    return { ok: true, ...storageStatus() }
  }
  function validateRecoveryRecord(key, record) {
    const invalid = () => { throw Object.assign(new Error('Transcript recovery identity or entry is invalid.'), { code: 'EIO' }) }
    if (!record || record.version !== 1 || key !== keyOf(record.metadata)
      || !Number.isSafeInteger(record.revision) || record.revision < 0
      || !Number.isSafeInteger(record.sequence) || record.sequence < 0
      || !Array.isArray(record.retained)) invalid()
    const seen = new Set()
    for (const row of record.retained) {
      if (!Array.isArray(row) || row.length !== 2) invalid()
      const [name, entry] = row
      if (!/^\d{16}-[a-f0-9]{64}\.json$/.test(name) || seen.has(name)
        || !entry || !['you', 'agent', 'action'].includes(entry.who)
        || typeof entry.text !== 'string' || digest(identity(entry.id)) !== name.slice(17, 81)
        || Number(name.slice(0, 16)) > record.sequence) invalid()
      seen.add(name)
      if (entry.retainedAppend) {
        const plan = entry.retainedAppend
        if (typeof plan.text !== 'string' || !/^[a-f0-9-]{36}$/.test(plan.stamp)
          || !Number.isSafeInteger(plan.baseCharacters) || plan.baseCharacters < 0
          || !(plan.spillBytes === null || (Number.isSafeInteger(plan.spillBytes) && plan.spillBytes >= 0))
          || typeof plan.whole !== 'boolean' || typeof plan.inline !== 'boolean') invalid()
      }
    }
  }
  function prepareRecovery() {
    if (!recoveryJournal) return Promise.resolve()
    if (!recoveryPreparation) recoveryPreparation = (async () => {
      try {
        journal = typeof recoveryJournal === 'function' ? recoveryJournal() : recoveryJournal
        await journal.ready
        const records = await journal.load()
        // Validate every record before installing any retained state.
        for (const [key, record] of records) validateRecoveryRecord(key, record)
        for (const [key, record] of records) {
          const held = await state(record.metadata)
          held.metadata = record.metadata
          held.revision = record.revision
          held.sequence = Math.max(held.sequence, record.sequence)
          held.retained = new Map(record.retained)
          held.recoveryRevision = record.revision
          for (const name of held.retained.keys()) held.files.set(name.slice(17, 81), name)
          retainedNodes.set(key, held)
          diskFailure ||= Object.assign(new Error('Recovered pending transcript save.'), { code: record.errorCode === 'ENOSPC' ? 'ENOSPC' : 'EIO' })
        }
        recoveryInitError = null
      } catch (error) {
        recoveryInitError = error
        diskFailure ||= error
      }
      if (diskFailure) notifyStorageFailure()
    })()
    return recoveryPreparation
  }
  async function assertWritable() {
    await prepareRecovery()
    requireDurable()
  }
  function requireDurable() { if (diskFailure) throw diskRefusal() }
  function retainUnconfirmedTurn(claim) {
    if (claim.uncertainWrite) return claim.uncertainWrite
    claim.uncertainPending = true
    claim.uncertainWrite = append(claim.uncertainRequest, {
      accepted: true, reservationId: claim.id, reservedBytes: claim.reservedBytes,
    }).then(answer => {
      if (answer?.ok !== true) throw new Error('Unconfirmed message storage refused.')
      claim.uncertainPending = false
      return answer
    }).catch(error => {
      // A dispatched request is still at risk even when no provider
      // acknowledgement arrived. Keep its prepared value and exact claim.
      diskFailure ||= error || new Error('Unconfirmed message storage failed.')
      notifyStorageFailure()
      return { ok: false, ...storageStatus() }
    }).finally(() => { claim.uncertainWrite = null })
    return claim.uncertainWrite
  }
  async function releaseTurn(claim, { accepted = true, dispatched = false } = {}) {
    if (turnAdmission !== claim) return { ok: true }
    if (!accepted && dispatched) {
      claim.dispatched = true
      claim.releasePending = true
      const answer = await retainUnconfirmedTurn(claim)
      if (answer.ok !== true || answer.durable === false) return answer
    }
    if (accepted && diskFailure) return { ok: false, ...storageStatus() }
    // A definite refusal never accepted this input. Its unused capacity may
    // be released even while another writer still has retained data.
    if (accepted) claim.accepted = true
    if (!accepted && !claim.accepted && !claim.dispatched) claim.cancelled = true
    claim.releasePending = true
    try {
      if (claim.reserved) await journal.releaseReservation(claim.id)
    } catch (cause) {
      admissionError = Object.assign(new Error(claim.dispatched
        ? 'Delivery is unconfirmed. The message was saved, but recovery storage cleanup is still pending. Retry saving; do not resend the message.'
        : !claim.accepted
        ? 'Your last message was not sent. Recovery storage cleanup is still pending. Keep the draft and retry saving.'
        : 'The message was saved, but recovery storage cleanup is still pending. Keep ToolsEnabled open and retry saving.'),
      { code: !claim.accepted && !claim.dispatched ? 'MC_TRANSCRIPT_RECOVERY_RESERVE_UNAVAILABLE' : 'MC_TRANSCRIPT_STORAGE_FAILED', cause })
      if (!noticeSent) { noticeSent = true; try { onStorageError(admissionError) } catch {} }
      throw admissionError
    }
    claim.reserved = false
    if (turnAdmission === claim) {
      turnAdmission = null
      wakeTurnAdmissionWaiters()
    }
    admissionError = null
    return { ok: true, ...storageStatus() }
  }
  async function reserveTurn(request) {
    if (closing) throw new Error('Transcript storage is closing.')
    if (turnAdmission) throw Object.assign(
      new Error('Another message is still awaiting a saved acceptance. Your message was not sent; keep it and retry after saving.'),
      { code: 'MC_TRANSCRIPT_ADMISSION_PENDING' })
    const claim = { id: randomUUID(), key: keyOf(request), reservedBytes: 0, reserved: false }
    // Publish admission before even recovery preparation awaits. Quit and a
    // second node must see it throughout the complete pre-dispatch boundary.
    turnAdmission = claim
    try {
      await assertWritable()
      if (!journal || typeof journal.reserve !== 'function') throw Object.assign(
        new Error('Recovery storage cannot reserve space. Your message was not sent.'),
        { code: 'MC_TRANSCRIPT_RECOVERY_RESERVE_UNAVAILABLE' })
      const held = await state(request)
      if (held.metadata?.closed) throw Object.assign(new Error('This conversation was closed. Your message was not sent.'),
        { code: IDENTITY_UNRESOLVED })
      // Text is bounded by the host send cap; additions/descriptors are the
      // actual host-composed values. Two encodings plus 64KiB cover the entry
      // identities, seven context rows, metadata and journal envelope.
      const payloadBytes = Buffer.byteLength(JSON.stringify({
        sessionId: request.sessionId, text: request.text,
        transcriptPrompt: request.transcriptPrompt, attachments: request.attachments,
        metadata: held.metadata,
      }))
      const uncertainSend = structuredClone({
        sessionId: request.sessionId, text: request.text,
        transcriptPrompt: request.transcriptPrompt, attachments: request.attachments,
      })
      const uncertainSentence = 'This message may have reached the provider. Delivery is unconfirmed; check the conversation before sending it again.'
      claim.uncertainRequest = { computerId: request.computerId, nodeId: request.nodeId, entries: [{
        id: 'uncertain:' + claim.id, who: 'action', kind: 'note', tool: 'Delivery unconfirmed',
        state: 'unknown', text: uncertainSentence, detail: uncertainSentence, body: uncertainSend.text,
        at: Date.now(), deliveryDisposition: 'unknown', uncertainSend,
        ...(uncertainSend.attachments?.length ? { attachments: uncertainSend.attachments } : {}),
      }] }
      claim.reservedBytes = 2 * payloadBytes + 64 * 1024
      await journal.reserve(claim.id, claim.reservedBytes)
      claim.reserved = true
      requireDurable()
      admissionError = null
      return Object.freeze({
        reservationId: claim.id, reservedBytes: claim.reservedBytes,
        release: options => releaseTurn(claim, options),
      })
    } catch (error) {
      // Keep a failed cleanup visible; explicit retry owns that exact claim.
      // If reserve never succeeded, there is no journal claim to release.
      try { await releaseTurn(claim, { accepted: false }) }
      catch (releaseError) { claim.releaseError = releaseError }
      admissionError = error.code === IDENTITY_UNRESOLVED ? error : Object.assign(new Error(
        (diskFull(error) ? 'The disk is full. ' : 'Recovery storage has insufficient available space. ')
        + 'Your last message was not sent. Keep it in the composer, resolve the storage problem, then retry saving.'),
      { code: diskFull(error) ? 'MC_TRANSCRIPT_DISK_FULL' : 'MC_TRANSCRIPT_RECOVERY_RESERVE_UNAVAILABLE', cause: error })
      if (!noticeSent) { noticeSent = true; try { onStorageError(admissionError) } catch {} }
      throw admissionError
    }
  }
  let closing = false
  const keyOf = request => digest(identityOf(request, 'computerId')) + '-' + digest(identityOf(request, 'nodeId'))
  const enqueue = (key, task) => {
    if (closing) return Promise.reject(new Error('Transcript storage is closing.'))
    const pending = (queues.get(key) || Promise.resolve()).catch(() => {}).then(async () => { await prepareRecovery(); return task() })
    queues.set(key, pending)
    pending.finally(() => { if (queues.get(key) === pending) queues.delete(key) }).catch(() => {})
    return pending
  }
  async function names(directoryPath) {
    try { return await io.readdir(directoryPath) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  async function atomic(file, value) {
    const temporary = file + '.' + randomUUID() + '.tmp'
    try {
      await io.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
      const handle = await io.open(temporary, 'r+')
      try { await handle.sync() } finally { await handle.close() }
      await io.rename(temporary, file)
    } catch (error) { await io.unlink(temporary).catch(() => {}); throw error }
  }
  /* REPAIR FOR TURNS ALREADY ON DISK TWICE.
 *
 * Until shell/node-transcript-capture.cjs stopped appending a provider's final
 * aggregate on top of its own unnamed deltas, a spill file held the turn's text
 * concatenated with itself, so "51" read back as "5151". Preventing new ones
 * does nothing for the records already written: the person keeps seeing every
 * old reply twice whenever a conversation is reopened or resumed, which is the
 * only place this was ever visible.
 *
 * Records written by the fixed path carry `textWhole` and are never examined.
 * An older record is repaired ON READ and its bytes are left where they are: no
 * reader can be certain a repeated string is not what the agent actually said,
 * so the original stays on disk and only what is handed out is repaired.
 *
 * T366: THE REPAIR ONLY REACHED THE CASE WHERE THE DELTA RUN HAPPENED TO FINISH.
 *
 * The bug appended the provider's whole aggregate AFTER the deltas captured so
 * far, so a spill holds `D + A` where D is however much of the reply the delta
 * run had written and A is the complete reply -- and A therefore begins with D.
 * Halving only repairs the case where the deltas had reached the end (D === A).
 * When the aggregate landed mid-run, D is a shorter prefix, the file is not its
 * own double, and the person still reads the opening of every old reply twice.
 *
 * MEASURED over a local node-transcript store (legacy spill files, counts
 * only -- no text was copied out): some are whole doubles and were repaired;
 * many more are prefix doubles and were not, carrying duplicated characters
 * that are re-read on every reopen or resume.
 *
 * THE SPLIT IS NOT A JUDGEMENT CALL. Of the doubled files, nearly all admit
 * EXACTLY ONE n with text[0..n) === text[n..2n), and after removing the leading
 * copy have no doubling left at all. The largest such n is taken, which is
 * precisely what halving already did for a whole double (n = length / 2), so
 * this generalises the shipped rule rather than adding a second one.
 *
 * WHAT IS STILL REFUSED. Text with no repeated leading run is returned
 * untouched, and the repair is applied ONCE per read, so a reply that genuinely
 * opens by repeating itself loses at most that one run and never unwinds
 * further. As before, the bytes on disk are not rewritten: no reader can be
 * certain a halved string is not what the agent actually said, so only what is
 * handed out is repaired.
 */
function singleSpill(text) {
  const value = String(text || '')
  if (value.length < 2) return value
  for (let head = Math.floor(value.length / 2); head >= 1; head -= 1) {
    if (value.slice(0, head) === value.slice(head, 2 * head)) return value.slice(head)
  }
  return value
}

async function state(request) {
    const key = keyOf(request)
    if (states.has(key)) return states.get(key)
    // Reads and writes may arrive together during hydration. Publish the load
    // promise before yielding so they share one index rather than allowing a
    // later empty read to replace an index the first append already populated.
    const pending = (async () => {
      const folder = path.join(active, key)
      const files = (await names(folder)).filter(name => /^\d{16}-[a-f0-9]{64}\.json$/.test(name)).sort()
      let metadata = null
      try { metadata = JSON.parse(await io.readFile(path.join(folder, 'node.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      return { key, folder, metadata, retained: new Map(), revision: metadata?.revision || 0, files: new Map(files.map(name => [name.slice(17, 81), name])), sequence: files.length ? Number(files.at(-1).slice(0, 16)) : 0 }
    })()
    states.set(key, pending)
    pending.catch(() => { if (states.get(key) === pending) states.delete(key) })
    return pending
  }
  function entryFilename(held, entryId) {
    const id = digest(identity(entryId))
    const filename = held.files.get(id) || String(++held.sequence).padStart(16, '0') + '-' + id + '.json'
    return { id, filename }
  }
  async function append(request, { accepted = false, reservationId, reservedBytes } = {}) {
    // Only the host capture may preserve an event accepted before another
    // write failed. Ordinary callers keep their unsent values and retry.
    if (!accepted) requireDurable()
    const key = keyOf(request)
    if (!Array.isArray(request.entries) || request.entries.length > 128) throw new Error('Transcript writes must be batched into at most 128 entries.')
    const entries = structuredClone(request.entries)
    for (const entry of entries) {
      identity(entry.id)
      if (!['you', 'agent', 'action'].includes(entry.who) || typeof entry.text !== 'string') throw new Error('Invalid transcript entry.')
    }
    return enqueue(key, async () => {
      if (!accepted) requireDurable()
      const held = await state(request)
      if (held.metadata?.closed) throw new Error('This node is closed; its transcript cannot be reopened by a late write.')
      held.revision += 1
      const initial = held.metadata || { computerId: request.computerId, nodeId: request.nodeId, savedAt: Date.now() }
      const supplied = { ...request.metadata }
      delete supplied.nativeSessionId
      if (initial.nativeSessionId) for (const field of ['threadId', 'provider', 'account']) delete supplied[field]
      const metadata = { ...initial, ...supplied, computerId: request.computerId, nodeId: request.nodeId, savedAt: Date.now(), revision: held.revision }
      if (reservationId !== undefined) {
        if (!accepted || turnAdmission?.id !== reservationId || turnAdmission.key !== key
            || turnAdmission.reservedBytes !== reservedBytes) throw new Error('Transcript reservation identity is invalid.')
        held.recoveryReservation = { reservationId, reservedBytes }
      }
      const reservations = new Map()
      const planned = entries.map(entry => {
        if (!reservations.has(entry.id)) reservations.set(entry.id, entryFilename(held, entry.id))
        return { entry, ...reservations.get(entry.id) }
      })
      try {
        if (diskFailure) throw diskFailure
        await io.mkdir(held.folder, { recursive: true })
        if (!held.metadata) { await atomic(path.join(held.folder, 'node.json'), initial); held.metadata = initial }
        for (const { entry, id, filename } of planned) {
          await atomic(path.join(held.folder, filename), entry)
          await io.unlink(path.join(held.folder, filename + '.text')).catch(error => { if (error.code !== 'ENOENT') throw error })
          held.files.set(id, filename)
        }
        await atomic(path.join(held.folder, 'node.json'), metadata)
        held.metadata = metadata
        held.recoveryReservation = null
        return { ok: true, count: held.files.size, ...storageStatus() }
      } catch (error) {
        for (const { entry, id, filename } of planned) {
          held.files.set(id, filename)
          held.retained.set(filename, { ...entry, textInline: true })
        }
        held.metadata = metadata
        return { ...await hold(held, error), count: held.files.size }
      }
    })
  }
  async function bindSessionMetadata(request) {
    requireDurable()
    const key = keyOf(request)
    identity(request.sessionId)
    identity(request.metadata?.threadId)
    if (!['codex', 'claude', 'gemini', 'grok', 'local'].includes(request.metadata.provider)
        || !(request.metadata.account === null || typeof request.metadata.account === 'string')) throw new Error('Invalid native transcript binding.')
    return enqueue(key, async () => {
      requireDurable()
      const held = await state(request)
      if (held.metadata?.closed) throw new Error('Closed transcript cannot receive a session binding.')
      if (request.replace !== true && held.metadata?.nativeSessionId !== request.sessionId) return { ok: true, unchanged: true }
      const metadata = { ...held.metadata, computerId: request.computerId, nodeId: request.nodeId,
        nativeSessionId: request.sessionId, threadId: request.metadata.threadId,
        provider: request.metadata.provider, account: request.metadata.account, savedAt: Date.now(), revision: ++held.revision }
      try {
        if (diskFailure) throw diskFailure
        await io.mkdir(held.folder, { recursive: true })
        await atomic(path.join(held.folder, 'node.json'), metadata)
        held.metadata = metadata
        return { ok: true, ...storageStatus() }
      } catch (error) {
        held.metadata = metadata
        return hold(held, error)
      }
    })
  }
  async function materializeRetained(held, filename, retained) {
    if (!retained?.retainedAppend) return retained
    const plan = retained.retainedAppend
    const source = await io.readFile(path.join(held.folder, filename), 'utf8')
      .then(JSON.parse, error => { if (error.code === 'ENOENT') return { text: '' }; throw error })
    if (source.recoveryStamp === plan.stamp) return source
    const spill = plan.inline ? Buffer.alloc(0)
      : await io.readFile(path.join(held.folder, filename + '.text')).catch(error => {
        if (error.code === 'ENOENT') return Buffer.alloc(0)
        throw error
      })
    const prefix = (plan.spillBytes === null ? spill : spill.subarray(0, plan.spillBytes)).toString('utf8')
    const { retainedAppend, ...entry } = retained
    return { ...entry, text: source.text.slice(0, plan.baseCharacters)
      + (plan.whole ? prefix : singleSpill(prefix)) + plan.text,
      textInline: true, recoveryStamp: plan.stamp }
  }
  async function read(request) {
    await prepareRecovery()
    const key = keyOf(request)
    await queues.get(key)?.catch(() => {})
    const held = await state(request)
    const limit = Math.max(1, Math.min(100, Number(request.limit) || 60))
    const availableFiles = new Set(held.files.values())
    const legacyFiles = (held.metadata?.legacyFiles || []).filter(name => availableFiles.has(name))
    const legacySet = new Set(legacyFiles)
    const ordered = [...legacyFiles, ...[...held.files.values()].filter(name => !legacySet.has(name)).sort()]
    const cursor = request.before ? ordered.indexOf(request.before) : -1
    if (request.strictBefore === true && request.before && cursor < 0) {
      const error = new Error('The transcript cursor is not in this conversation.')
      error.code = 'MC_AGENT_TRANSCRIPT_CURSOR_INVALID'; throw error
    }
    const files = cursor >= 0 ? ordered.slice(0, cursor) : ordered
    const page = files.slice(-limit)
    const entries = await Promise.all(page.map(async name => {
      // Resume may need more than its bounded prompt can carry. These are
      // locators for this node's existing files, not copied history or a new
      // permission grant. Derive them here; never trust an entry's fields.
      const retained = held.retained.get(name)
      const saved = retained ? await materializeRetained(held, name, retained) : JSON.parse(await io.readFile(path.join(held.folder, name), 'utf8'))
      const { recoveryFiles: _untrustedRecoveryFiles, recoveryStamp: _recoveryStamp, retainedAppend: _retainedAppend, textWhole: spillIsWhole, textInline, ...entry } = saved
      // Older native capture wrote the turn only into its stable entry ID.
      // Recover that display metadata for known UUID host sessions on read;
      // retain original bytes and any explicit stamp already present.
      if (entry.who === 'agent' && entry.turnStamp === undefined && typeof entry.id === 'string') {
        const captured = /^agent:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:([^\0\r\n]{1,512})$/i.exec(entry.id)
        if (captured) entry.turnStamp = captured[1]
      }
      const extra = textInline === true ? '' : await io.readFile(path.join(held.folder, name + '.text'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
      return { ...entry, text: entry.text + (spillIsWhole === true ? extra : singleSpill(extra)),
        ...(request.includeRecoveryFiles === true && !retained ? { recoveryFiles: [path.join(held.folder, name), ...(extra ? [path.join(held.folder, name + '.text')] : [])] } : {}) }
    }))
    return { ok: true, ...storageStatus(), metadata: held.metadata, entries, before: files.length > page.length ? page[0] : null, count: held.files.size,
      ...(request.includeRecoveryFiles === true ? { recoveryDirectory: held.folder } : {}) }
  }
  async function list(request) {
    await prepareRecovery()
    const prefix = digest(identityOf(request, 'computerId')) + '-'
    const records = []
    for (const name of await names(active)) {
      if (!name.startsWith(prefix) || !/^[a-f0-9]{64}-[a-f0-9]{64}$/.test(name)) continue
      const metadata = retainedNodes.get(name)?.metadata || JSON.parse(await io.readFile(path.join(active, name, 'node.json'), 'utf8'))
      if (!metadata.closed) records.push(metadata)
    }
    for (const held of retainedNodes.values()) if (held.metadata?.computerId === request.computerId && !held.metadata.closed) {
      const index = records.findIndex(row => row.nodeId === held.metadata.nodeId)
      if (index < 0) records.push(held.metadata)
      else records[index] = held.metadata
    }
    return { ok: true, records, ...storageStatus() }
  }
  async function rollback(request) {
    await prepareRecovery()
    requireDurable()
    return enqueue(keyOf(request), async () => {
      const held = await state(request)
      const id = digest(identity(request.entryId))
      const filename = held.files.get(id)
      if (filename) {
        // Invalidate staged archive receipts durably before deleting bytes.
        // A restart must not restore the pre-rollback revision and admit an
        // archive containing the message the caller just removed.
        const metadata = { ...held.metadata, revision: held.revision + 1 }
        await atomic(path.join(held.folder, 'node.json'), metadata)
        held.revision = metadata.revision
        held.metadata = metadata
        await io.unlink(path.join(held.folder, filename + '.text')).catch(error => { if (error.code !== 'ENOENT') throw error })
        await io.unlink(path.join(held.folder, filename)); held.files.delete(id)
      }
      return { ok: true }
    })
  }
  async function appendText(request, { accepted = false } = {}) {
    if (!accepted) requireDurable()
    const turnStamp = request.turnStamp === undefined ? undefined : identity(request.turnStamp)
    if (typeof request.text !== 'string') throw new Error('Invalid transcript text.')
    return enqueue(keyOf(request), async () => {
      if (!accepted) requireDurable()
      const held = await state(request)
      if (held.metadata?.closed) throw new Error('This node is closed.')
      held.revision += 1
      const { id, filename } = entryFilename(held, request.entryId)
      const wasKnown = held.files.has(id)
      let entry = held.retained.get(filename)
      if (!entry && wasKnown) entry = JSON.parse(await io.readFile(path.join(held.folder, filename), 'utf8'))
      if (!entry) entry = { id: request.entryId, who: 'agent', text: '', textWhole: true, at: request.at || Date.now(), ...(turnStamp === undefined ? {} : { turnStamp }) }
      if (turnStamp !== undefined && entry.turnStamp !== undefined && entry.turnStamp !== turnStamp) throw new Error('Transcript turn identity cannot change.')
      const needsEntryWrite = !wasKnown || (turnStamp !== undefined && entry.turnStamp === undefined)
      if (turnStamp !== undefined) entry = { ...entry, turnStamp }
      const initial = held.metadata || { computerId: request.computerId, nodeId: request.nodeId, savedAt: Date.now() }
      let beforeBytes = null
      if (entry.retainedAppend) {
        entry.retainedAppend.text += request.text
        held.metadata = { ...initial, revision: held.revision }
        return hold(held, diskFailure)
      }
      try {
        if (diskFailure) throw diskFailure
        await io.mkdir(held.folder, { recursive: true })
        if (!held.metadata) { await atomic(path.join(held.folder, 'node.json'), initial); held.metadata = initial }
        if (needsEntryWrite) {
          await atomic(path.join(held.folder, filename), entry)
          held.files.set(id, filename)
        }
        if (entry.textInline === true) {
          await atomic(path.join(held.folder, filename), { ...entry, text: entry.text + request.text })
        } else {
          const spill = path.join(held.folder, filename + '.text')
          beforeBytes = await io.stat(spill).then(info => info.size, error => { if (error.code === 'ENOENT') return 0; throw error })
          const handle = await io.open(spill, 'a', 0o600)
          try { await handle.writeFile(request.text); await handle.sync() } finally { await handle.close() }
        }
        const metadata = { ...initial, revision: held.revision }
        await atomic(path.join(held.folder, 'node.json'), metadata)
        held.metadata = metadata
        return { ok: true, ...storageStatus() }
      } catch (error) {
        // Keep only the new event in memory. Durable history remains a
        // referenced prefix, clipped before any partial failing append.
        held.files.set(id, filename)
        held.retained.set(filename, { ...entry, text: '', retainedAppend: {
          stamp: randomUUID(), baseCharacters: entry.text.length,
          spillBytes: beforeBytes, whole: entry.textWhole === true,
          inline: entry.textInline === true, text: request.text,
        } })
        held.metadata = { ...initial, revision: held.revision }
        return hold(held, error)
      }
    })
  }
  function retry() {
    if (retrying) return retrying
    retrying = (async () => {
      if (recoveryInitError && typeof recoveryJournal === 'function') recoveryPreparation = null
      await prepareRecovery()
      if (recoveryInitError) return { ok: false, ...storageStatus(), error: storageRefusal() }
      const uncertain = turnAdmission
      if (uncertain?.dispatched) {
        if (uncertain.uncertainWrite) await uncertain.uncertainWrite
        if (uncertain.uncertainPending) await retainUnconfirmedTurn(uncertain)
        if (uncertain.uncertainPending) return { ok: false, ...storageStatus(), error: storageRefusal() }
      }
      for (const [key, held] of [...retainedNodes]) {
        await enqueue(key, async () => {
          await io.mkdir(held.folder, { recursive: true })
          // Publish ownership before entries so an interrupted first save can
          // still be discovered by list(). Memory is released only after all writes.
          await atomic(path.join(held.folder, 'node.json'), held.metadata)
          for (const [filename, entry] of held.retained) {
            await atomic(path.join(held.folder, filename), await materializeRetained(held, filename, entry))
            await io.unlink(path.join(held.folder, filename + '.text')).catch(error => { if (error.code !== 'ENOENT') throw error })
          }
          if (journal) await journal.remove(key)
          held.retained.clear()
          held.recoveryReservation = null
          retainedNodes.delete(key)
        })
      }
      if (turnAdmission?.cancelled || turnAdmission?.releasePending) await releaseTurn(turnAdmission, { accepted: false })
      if (!retainedNodes.size) { diskFailure = null; savedAgain() }
      return { ok: true, ...storageStatus() }
    })().catch(error => {
      diskFailure ||= error || new Error('Conversation storage retry failed.')
      return { ok: false, ...storageStatus(), error: storageRefusal() }
    }).finally(() => { retrying = null })
    return retrying
  }
  async function archiveFolder() {
    // User selection may be outside userData, but a reparse point must never
    // turn a quota cleanup into traversal of some other directory.
    const folder = path.resolve(configuration.archiveDirectory)
    validateDirectory(folder)
    if (folder === root || folder.startsWith(root + path.sep) || root.startsWith(folder + path.sep)) throw new Error('Archive folder must be separate from active transcript storage.')
    let ancestor = folder
    while (true) {
      try {
        if ((await io.realpath(ancestor)).toLowerCase() !== ancestor.toLowerCase()) throw new Error('Archive folder must not traverse a symbolic link.')
        break
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        const parent = path.dirname(ancestor)
        if (parent === ancestor) throw error
        ancestor = parent
      }
    }
    await io.mkdir(folder, { recursive: true })
    if ((await io.realpath(folder)).toLowerCase() !== folder.toLowerCase()) throw new Error('Archive folder must not be a symbolic link.')
    return folder
  }
  async function enforceQuota(folder) {
    const archives = []
    for (const name of await names(folder)) {
      if (!/^transcript-\d{13}-[a-f0-9-]{36}$/.test(name)) continue
      const target = path.join(folder, name)
      const info = await io.lstat(target)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      let bytes = 0
      for (const file of await names(target)) {
        const item = await io.lstat(path.join(target, file))
        if (item.isSymbolicLink() || !item.isFile()) throw new Error('Archive contains an unexpected filesystem entry.')
        bytes += item.size
      }
      archives.push({ target, name, bytes })
    }
    let total = archives.reduce((sum, item) => sum + item.bytes, 0)
    for (const item of archives.sort((a, b) => a.name.localeCompare(b.name))) {
      if (total <= configuration.archiveMaxBytes) break
      await io.rm(item.target, { recursive: true }); total -= item.bytes
    }
  }
  async function archive(request) {
    await prepareRecovery()
    requireDurable()
    return enqueue(keyOf(request), async () => {
      const held = await state(request)
      if (!held.metadata) return { ok: true }
      const folder = await archiveFolder()
      const target = path.join(folder, (request.stageOnly ? 'transcript-pending-' : 'transcript-') + Date.now() + '-' + randomUUID())
      // Copy first, mark closed only after every entry is durable at destination.
      // Failure leaves the active source and its metadata intact.
      await io.cp(held.folder, target, { recursive: true, errorOnExist: true, force: false })
      await atomic(path.join(target, 'node.json'), { ...held.metadata, closedAt: Date.now(), sourceRevision: held.revision })
      if (request.stageOnly) return { ok: true, archiveId: path.basename(target) }
      return finishArchive(held, folder)
    })
  }
  async function finishArchive(held, folder) {
      await atomic(path.join(held.folder, 'node.json'), { ...held.metadata, closed: true })
      held.metadata = { ...held.metadata, closed: true }
      for (const file of held.files.values()) {
        await io.unlink(path.join(held.folder, file + '.text')).catch(error => { if (error.code !== 'ENOENT') throw error })
        await io.unlink(path.join(held.folder, file))
      }
      held.files.clear()
      await enforceQuota(folder)
      return { ok: true }
  }
  async function commitArchive(request) {
    await prepareRecovery()
    requireDurable()
    return enqueue(keyOf(request), async () => {
      if (!/^transcript-pending-\d{13}-[a-f0-9-]{36}$/.test(request.archiveId || '')) throw new Error('Invalid archive receipt.')
      const folder = await archiveFolder()
      const archived = JSON.parse(await io.readFile(path.join(folder, request.archiveId, 'node.json'), 'utf8'))
      if (archived.nodeId !== request.nodeId || archived.computerId !== request.computerId) throw new Error('Archive receipt belongs to another node.')
      const held = await state(request)
      if (held.revision !== archived.sourceRevision) throw new Error('Conversation changed after the archive was prepared. Active history was retained.')
      await io.rename(path.join(folder, request.archiveId), path.join(folder, request.archiveId.replace('transcript-pending-', 'transcript-')))
      return finishArchive(held, folder)
    })
  }
  async function cancelArchive(request) {
    await prepareRecovery()
    requireDurable()
    return enqueue(keyOf(request), async () => {
      if (!/^transcript-pending-\d{13}-[a-f0-9-]{36}$/.test(request.archiveId || '')) throw new Error('Invalid archive receipt.')
      const folder = await archiveFolder()
      const target = path.join(folder, request.archiveId)
      if ((await io.lstat(target)).isSymbolicLink()) throw new Error('Archive receipt must not be a symbolic link.')
      const archived = JSON.parse(await io.readFile(path.join(target, 'node.json'), 'utf8'))
      if (archived.nodeId !== request.nodeId || archived.computerId !== request.computerId) throw new Error('Archive receipt belongs to another node.')
      await io.rm(target, { recursive: true })
      return { ok: true }
    })
  }
  /* A NEW ARCHIVE FOLDER IS CHECKED BEFORE IT IS SAVED (T1488). On Linux any
     absolute path passed: a file, a folder that could not be created, and '/'
     were all 'Settings saved.', and closed conversations would have gone there.
     The folder is created if it is missing, and one small probe file is written
     and removed to prove it can hold archives. */
  async function usableArchiveFolder(folder) {
    if (path.dirname(folder) === folder) throw new Error('Choose a folder for closed conversations, not the top of the drive.')
    if (folder === root || folder.startsWith(root + path.sep) || root.startsWith(folder + path.sep)) throw new Error('Archive folder must be separate from active transcript storage.')
    const unwritable = 'The archive folder cannot be created or written. Choose a folder you can write to.'
    let info = null
    try { info = await io.stat(folder) } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(unwritable)
    }
    if (info && !info.isDirectory()) throw new Error('The archive folder is a file, not a folder. Choose a folder.')
    try {
      await io.mkdir(folder, { recursive: true })
      const probe = path.join(folder, `.archive-check-${randomUUID()}`)
      await io.writeFile(probe, '')
      await io.unlink(probe)
    } catch {
      throw new Error(unwritable)
    }
  }
  async function configure(next) {
    if (closing) throw new Error('Transcript storage is closing.')
    await prepareRecovery()
    requireDurable()
    if (closing) throw new Error('Transcript storage is closing.')
    const merged = { ...configuration, ...next }
    if (typeof merged.archiveDirectory !== 'string' || !path.isAbsolute(merged.archiveDirectory)
      || !Number.isSafeInteger(merged.archiveMaxBytes) || merged.archiveMaxBytes < 0
      || typeof merged.deleteNodesOnExit !== 'boolean') throw new Error('Invalid transcript settings.')
    validateDirectory(path.resolve(merged.archiveDirectory))
    if (path.resolve(merged.archiveDirectory) !== path.resolve(configuration.archiveDirectory)) await usableArchiveFolder(path.resolve(merged.archiveDirectory))
    await saveSettings(merged)
    configuration = merged
    return { ok: true, transcript: { ...configuration } }
  }
  async function migrate(request) {
    requireDurable()
    const key = keyOf(request)
    if (!Array.isArray(request.entries) || request.entries.length > 128) throw new Error('Invalid legacy transcript batch.')
    const entries = structuredClone(request.entries)
    for (const entry of entries) {
      identity(entry.id)
      if (!['you', 'agent', 'action'].includes(entry.who) || typeof entry.text !== 'string') throw new Error('Invalid transcript entry.')
    }
    return enqueue(key, async () => {
      requireDurable()
      const held = await state(request)
      if (held.metadata?.legacyMigrated) return { ok: true, unchanged: true, ...storageStatus() }
      if (held.metadata?.closed) throw new Error('Closed transcripts cannot be migrated back into active storage.')
      held.revision += 1
      const initial = held.metadata || { computerId: request.computerId, nodeId: request.nodeId, savedAt: Date.now() }
      const reservations = new Map()
      const planned = entries.map(entry => {
        if (!reservations.has(entry.id)) reservations.set(entry.id, entryFilename(held, entry.id))
        return { entry, ...reservations.get(entry.id) }
      })
      const supplied = { ...request.metadata }
      delete supplied.nativeSessionId
      const metadata = { ...supplied, ...initial, computerId: request.computerId, nodeId: request.nodeId,
        legacyMigrated: true, legacyFiles: planned.map(row => row.filename), revision: held.revision }
      try {
        if (diskFailure) throw diskFailure
        await io.mkdir(held.folder, { recursive: true })
        if (!held.metadata) { await atomic(path.join(held.folder, 'node.json'), initial); held.metadata = initial }
        for (const { entry, id, filename } of planned) {
          if (!held.files.has(id)) await atomic(path.join(held.folder, filename), entry)
          held.files.set(id, filename)
        }
        await atomic(path.join(held.folder, 'node.json'), metadata)
        held.metadata = metadata
        return { ok: true, ...storageStatus() }
      } catch (error) {
        for (const { entry, id, filename } of planned) if (!held.files.has(id)) {
          held.files.set(id, filename)
          held.retained.set(filename, { ...entry, textInline: true })
        }
        held.metadata = metadata
        return hold(held, error)
      }
    })
  }
  async function shutdown({ deleteNodes = async () => {} } = {}) {
    await prepareRecovery()
    await Promise.all([...queues.values()])
    requireDurable()
    if (turnAdmission) throw new Error('The last message is awaiting saved acceptance; transcript storage cannot close yet.')
    closing = true
    if (configuration.deleteNodesOnExit) {
      // Node deletion must succeed before history is discarded.
      await deleteNodes()
      await clearForPrivacy()
    }
    if (journal) await journal.close()
    return { ok: true, deleted: configuration.deleteNodesOnExit }
  }
  /* ERASE: NOTHING IS WRITTEN AFTER THIS RETURNS (c4 second review). An erase
     sweeps the folder this store writes into while the result page stays open.
     Every later write is refused here (enqueue, reserveTurn and configure check
     `closing`), and the writes already queued finish before the sweep, never
     under it or after it; append's mkdir is recursive and would bring the
     conversation folder back. Unlike shutdown() this never refuses: an erase
     must go ahead over a storage failure. It lasts for the rest of the run. */
  async function sealForErase() {
    closing = true
    await Promise.allSettled([...queues.values()])
    if (retrying) await retrying.catch(() => {})
    return { ok: true, sealed: true }
  }
  async function clearForPrivacy() {
    await prepareRecovery()
    requireDurable()
    await Promise.all([...queues.values()])
    if ((await io.realpath(active).catch(error => error.code === 'ENOENT' ? active : Promise.reject(error))).toLowerCase() !== active.toLowerCase()) throw new Error('Transcript folder must not be a symbolic link.')
    await io.rm(active, { recursive: true, force: true })
    states.clear()
  }
  return { append, appendText, bindSessionMetadata, retry, getStorageStatus: storageStatus, waitForStorage, assertWritable, reserveTurn, waitForTurnAdmission, migrate, read, list, archive, commitArchive, cancelArchive, rollback, configure, shutdown, sealForErase, clearForPrivacy, getSettings: async () => ({ ok: true, transcript: { ...configuration } }) }
}

module.exports = { createNodeTranscriptStore }
