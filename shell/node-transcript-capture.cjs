'use strict'
const { createHash, randomUUID } = require('node:crypto')
const { limitReason } = require('./account-session-recovery.cjs')
const { thinkingTranscriptId, thinkingSummary } = require('./thinking-transcript.mjs')

/* A USAGE LIMIT SAYS WHEN IT ENDS (T1509). When thirty-seven Codex
   turns stopped on a weekly limit and every saved conversation said only "No
   safe failure detail was recorded": the engine had classified the ending,
   but only in a sentence this file does not read. The engine now also says it
   as data -- payload { limit: 'usage', resetsAt? } -- where resetsAt is an
   instant it checked, never provider prose. This reads the data, re-checks the
   instant's shape and range, and writes the time in this computer's clock. */
const RESET_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const RESET_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/
function usageLimitOf(event, now) {
  const payload = event.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.limit !== 'usage') return null
  const iso = payload.resetsAt
  const ms = typeof iso === 'string' && RESET_INSTANT.test(iso) ? Date.parse(iso) : NaN
  // A reset an hour gone or more than a year away is not one a person can wait for.
  return { resetsAt: Number.isFinite(ms) && ms >= now - 3_600_000 && ms <= now + 400 * 86_400_000 ? ms : null }
}
function resetWords(ms, now) {
  const at = new Date(ms)
  const year = at.getFullYear() === new Date(now).getFullYear() ? '' : ` ${at.getFullYear()}`
  return `${RESET_MONTHS[at.getMonth()]} ${at.getDate()}${year}, ${at.getHours() % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')} ${at.getHours() < 12 ? 'AM' : 'PM'}`
}

/* AND WHY THE PROVIDER FAILED, WHEN THE ENGINE WILL VOUCH FOR THE SENTENCE
   (T1552). MEASURED 2026-09-25 on 1.0.46: a Codex refresh token was revoked
   while the account was otherwise healthy, every Codex turn on the machine
   died, and every saved conversation said "Turn did not finish. No safe
   failure detail was recorded". The engine HAD a sentence for it -- for a
   revoked session it says "Codex could not authenticate this account. Check
   its sign-in." -- and this function dropped it, because the only provider
   endings it could read were the two limit classifications above. A person
   reading their own saved conversation could not tell a dead sign-in from a
   broken product.

   WHAT IT READS IS NOT `event.text`, DELIBERATELY. That field is whatever the
   adapter put there, and for a transport failure the Codex adapter puts its
   own developer-facing message there, which can quote the child's stderr.
   `payload.failure` is the narrower channel the engine writes only for a
   sentence the product itself authored -- the same shape of promise
   `payload.limit` already makes for a usage limit.

   AND IT IS STILL RE-CHECKED HERE, because "the engine promised" is not a
   property of the bytes that arrived. One line, printable, bounded to a length
   that fits the row this is drawn in, with no separator run that could be a
   path, no URL scheme, and no credential shape. Anything else is refused whole
   and falls through to the sentence below -- a failure to describe the failure
   is not a licence to print an unknown string into a durable record. */
const FAILURE_SUMMARY_LIMIT = 260
const FAILURE_SUMMARY_LINE = /^[\x20-\x7E -ɏ]+$/
const FAILURE_SUMMARY_PATH = /[\\/][^\s\\/]*[\\/]|[a-z][a-z0-9+.-]*:\/\//i
const FAILURE_SUMMARY_SECRET = /\bBearer\b|\bsk-[a-z0-9-]{4,}|\b(?:api[_-]?key|token|password|secret)\s*[=:]/i
function providerFailureSummary(event) {
  const payload = event.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const failure = payload.failure
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return null
  if (typeof failure.summary !== 'string') return null
  const summary = failure.summary.trim()
  if (!summary || summary.length > FAILURE_SUMMARY_LIMIT) return null
  if (!FAILURE_SUMMARY_LINE.test(summary)) return null
  if (FAILURE_SUMMARY_PATH.test(summary) || FAILURE_SUMMARY_SECRET.test(summary)) return null
  return summary
}

// Terminal diagnostics are not assistant speech. Persist only product-owned
// outcome sentences, never provider messages, stacks, codes, or credentials.
function terminalOutcomeText(event, now = Date.now()) {
  // Codex preserves completed; Claude CLI/local use success; the ACP Claude
  // adapter preserves end_turn. Unknown future statuses are not proof of success.
  if (event.type === 'turn_completed' && ['completed', 'success', 'end_turn'].includes(event.status)) return null
  if (['interrupted', 'cancelled', 'canceled'].includes(event.status)) return 'Turn stopped before completion.'
  if (event.type !== 'turn_failed' && !['failed', 'error'].includes(event.status)) return 'Turn ended without a confirmed successful outcome.'
  const usage = usageLimitOf(event, now)
  if (usage) {
    /* The facts first: the chat draws this line as one row under "Turn · did
       not finish", cut to the rail's width, and a prefix that repeats the row's
       own words left only "Turn did not finish: the provid…" in view. */
    return usage.resetsAt === null
      ? 'Account usage limit reached. Wait for it to reset or choose another account in the Accounts menu.'
      : `Account usage limit reached. It resets ${resetWords(usage.resetsAt, now)}. Until then, choose another account in the Accounts menu.`
  }
  const reason = limitReason({
    type: 'turn_completed', status: 'failed',
    code: typeof event.code === 'string' ? event.code.slice(0, 128) : '',
    text: typeof event.text === 'string' ? event.text.slice(0, 4096) : '',
  })
  if (reason === 'context-limit') return 'Turn did not finish: the provider reported a context limit.'
  if (reason === 'account-limit') return 'Turn did not finish: the provider reported an account usage limit.'
  const failure = providerFailureSummary(event)
  if (failure) return failure
  return 'Turn did not finish. No safe failure detail was recorded.'
}


// Canonical output capture lives beside the host, so changing renderer pages
// cannot lose a turn. Only the current batch is retained in memory.
function createNodeTranscriptCapture({ store, sessionMetadata = () => null, onError = () => {}, schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
  const bindings = new Map()
  const endedBindings = new Map()
  const batches = new Map()
  const writes = new Map()
  // A recorded failure also wakes a flush waiting on queued packets: a refused
  // write holds the queue until retry, so waiting longer would never end.
  const failureWaiters = new Set()
  const failures = new (class extends Map {
    set(key, value) {
      super.set(key, value)
      for (const wake of failureWaiters) wake()
      failureWaiters.clear()
      return this
    }
  })()
  const metadataWritten = new Map()
  let closing = false
  let discarded = false
  let activeAdmissions = 0
  const admissionWaiters = new Set()
  const writeBarriers = new Map()
  let sealPromise = null
  let retryFlight = null
  const CAPTURE_UNSAVED = 'MC_TRANSCRIPT_CAPTURE_UNSAVED'
  const CAPTURE_CLOSING = 'MC_TRANSCRIPT_CAPTURE_CLOSING'
  const failureMessage = 'Accepted transcript input is not saved. Retry saving before closing ToolsEnabled.'
  const closingMessage = 'Transcript capture is closing; the accepted input was not admitted.'
  function unsavedError() { return Object.assign(new Error(failureMessage), { code: CAPTURE_UNSAVED }) }
  function emitUnsavedNotice() {
    try { onError(unsavedError()) } catch {}
  }
  function closingError() { return Object.assign(new Error(closingMessage), { code: CAPTURE_CLOSING }) }
  function failureResult() {
    return { ok: false, code: CAPTURE_UNSAVED, message: failureMessage,
      error: { code: CAPTURE_UNSAVED, message: failureMessage } }
  }
  function backingStorageStatus() {
    try { return typeof store.getStorageStatus === 'function' ? (store.getStorageStatus() || {}) : {} } catch { return {} }
  }
  function storageIsRefused() { return backingStorageStatus().durable === false }
  function getStorageStatus() {
    const backing = backingStorageStatus()
    const failure = failures.values().next().value
    const unsaved = failures.size > 0 || backing.durable === false
    return { ...backing, durable: !unsaved, unsaved,
      pendingWrites: (Number.isInteger(backing.pendingWrites) ? backing.pendingWrites : 0) + writes.size + activeAdmissions,
      closing,
      error: failure ? { code: CAPTURE_UNSAVED, message: failureMessage } : (backing.storageError || null) }
  }
  function admit() {
    if (closing) return null
    activeAdmissions += 1
    return () => {
      activeAdmissions = Math.max(0, activeAdmissions - 1)
      if (!activeAdmissions) for (const resolve of admissionWaiters) resolve(!storageIsRefused())
      if (!activeAdmissions) admissionWaiters.clear()
    }
  }
  function drainAdmissions() {
    if (!activeAdmissions) return Promise.resolve(!storageIsRefused())
    if (storageIsRefused()) return Promise.resolve(false)
    return new Promise(resolve => admissionWaiters.add(resolve))
  }
  function settleFailure(key, answer) {
    const failure = failures.get(key)
    if (!failure) return
    failures.delete(key)
    for (const resolve of failure.waiters || []) resolve(answer)
    if (failure.barrierResolve) failure.barrierResolve(answer)
  }
  function waitForFailure(key) {
    const failure = failures.get(key)
    if (!failure) return Promise.resolve(failureResult())
    return new Promise(resolve => {
      failure.waiters ||= []
      failure.waiters.push(resolve)
    })
  }
  function trackWrite(pending, key, binding, retry) {
    let resolveBarrier
    const barrier = new Promise(resolve => { resolveBarrier = resolve })
    const barrierRecord = { promise: barrier, resolve: resolveBarrier }
    writeBarriers.set(pending, barrierRecord)
    barrier.finally(() => {
      if (writeBarriers.get(pending) === barrierRecord) writeBarriers.delete(pending)
    }).catch(() => {})
    writes.set(pending, binding)
    const observed = Promise.resolve(pending).then(answer => {
      const failure = failures.get(key)
      if (!failure || failure.pending !== pending) resolveBarrier(answer)
      else if (answer?.durable === false) failures.set(key, { ...failure, pending: null })
      else settleFailure(key, answer)
      return answer
    }, error => {
      if (discarded) { resolveBarrier(failureResult()); return undefined }
      failures.set(key, { error, binding, retry, pending, barrierResolve: resolveBarrier })
      onError(error)
      return undefined
    }).finally(() => {
      writes.delete(pending)
      const failure = failures.get(key)
      if (!failure || failure.pending !== pending) return
      failure.barrierResolve ||= resolveBarrier
    })
    observed.catch(() => {})
    return pending
  }
  function trackRetry(pending, key, failure) {
    writes.set(pending, failure.binding)
    Promise.resolve(pending).then(answer => {
      const current = failures.get(key)
      if (current?.pending !== pending) return
      if (answer?.ok !== true || answer?.durable === false) {
        const error = Object.assign(new Error(answer?.message || failureMessage), { code: answer?.code || CAPTURE_UNSAVED })
        failures.set(key, { ...current, error, pending: null })
      } else settleFailure(key, answer)
    }, error => {
      if (discarded) return
      const current = failures.get(key)
      if (current?.pending === pending) failures.set(key, { ...current, error, pending })
      onError(error)
    }).finally(() => writes.delete(pending)).catch(() => {})
  }
  function flush(key) {
    const batch = batches.get(key)
    if (!batch) return
    if (batch.timer) cancel(batch.timer)
    batch.timer = null
    const entries = [...batch.thoughts.values()].filter(entry => entry.dirty).map(entry => {
      entry.dirty = false
      const { dirty, ...saved } = entry
      return saved
    })
    if (entries.length) {
      const request = { ...batch.binding, entries }
      trackWrite(store.append(request, { accepted: true }), key + ':entries', batch.binding,
        () => store.append(structuredClone(request), { accepted: true }))
    }
    if (!batch.chunks.length) return
    const text = batch.chunks.join('')
    batch.chunks = []
    const request = { ...batch.binding, entryId: key, text, at: batch.at, turnStamp: batch.turnId }
    const pending = store.appendText(request, { accepted: true })
    trackWrite(pending, key + ':text', batch.binding,
      () => store.appendText(structuredClone(request), { accepted: true }))
  }
  function updateMetadata(sessionId, binding, replace = false) {
    const metadata = sessionMetadata(sessionId)
    if (!metadata?.threadId || !store.bindSessionMetadata) return
    let state = metadataWritten.get(sessionId)
    if (!state) { state = { binding, fingerprint: null, pending: null, authoritative: false }; metadataWritten.set(sessionId, state) }
    if (replace) {
      // A failed initial host write may retry until a newer host session owns this node.
      for (const other of metadataWritten.values()) if (other.binding.computerId === binding.computerId && other.binding.nodeId === binding.nodeId) other.authoritative = false
      state.authoritative = true
    }
    const fingerprint = JSON.stringify(metadata)
    if (state.pending || state.fingerprint === fingerprint) return
    const key = 'metadata:' + sessionId
    const existingFailure = failures.get(key)
    if (existingFailure) {
      existingFailure.retry ||= () => writeMetadata(sessionId, state)
      return
    }
    trackWrite(writeMetadata(sessionId, state), key, binding,
      () => writeMetadata(sessionId, state))
  }
  function writeMetadata(sessionId, state) {
    const currentBinding = bindings.get(sessionId) || endedBindings.get(sessionId) || state.binding
    const metadata = sessionMetadata(sessionId)
    if (!currentBinding || !metadata?.threadId || !store.bindSessionMetadata) {
      return Promise.reject(Object.assign(new Error('The transcript metadata identity could not be resolved.'), { code: 'MC_TRANSCRIPT_IDENTITY_UNRESOLVED' }))
    }
    const fingerprint = JSON.stringify(metadata)
    // Resolve the binding and fingerprint when the retry runs, not when the
    // failed closure was created. A newer authoritative session therefore
    // cannot be overwritten by a stale replace:true retry.
    const request = { ...currentBinding, sessionId, metadata,
      replace: state.authoritative === true }
    const pending = Promise.resolve().then(() => store.bindSessionMetadata(request))
    let settling
    settling = pending.then(answer => {
      if (metadataWritten.get(sessionId) !== state) return answer
      if (state.pending === settling) {
        state.pending = null
        if (!answer?.unchanged) state.fingerprint = fingerprint
      }
      if (answer?.ok !== true || answer?.durable === false) {
        throw Object.assign(new Error(answer?.message || 'Transcript metadata was not saved.'),
          { code: answer?.code || 'MC_TRANSCRIPT_STORAGE_FAILED' })
      }
      return answer
    }, error => {
      if (metadataWritten.get(sessionId) === state && state.pending === settling) state.pending = null
      throw error
    })
    state.pending = settling
    return settling
  }
  function bind({ sessionId, computerId, nodeId, authoritative = false } = {}) {
    if (closing) throw new Error('Invalid transcript session binding.')
    /* The same named refusal the store gives (T406): a binding that cannot say
       whose session, whose computer or whose node it is has not failed to
       bind -- it has not said what to bind. */
    for (const [field, value] of [['sessionId', sessionId], ['computerId', computerId], ['nodeId', nodeId]]) {
      if (typeof value !== 'string' || !value) {
        throw Object.assign(new Error(`The transcript identity could not be resolved: ${field} is missing.`), { code: 'MC_TRANSCRIPT_IDENTITY_UNRESOLVED', field })
      }
    }
    const prior = bindings.get(sessionId) || endedBindings.get(sessionId)
    if (prior && (prior.computerId !== computerId || prior.nodeId !== nodeId)) throw new Error('Session already belongs to another transcript node.')
    endedBindings.delete(sessionId)
    bindings.set(sessionId, { computerId, nodeId })
    if (authoritative) updateMetadata(sessionId, { computerId, nodeId }, true)
    return { ok: true }
  }
  /* HANDING A RUNNING SESSION TO A DIFFERENT NODE, WHICH IS ONE REAL EVENT.
   *
   * A + (standalone) agent is bound to its own seat while it is nobody's: that
   * is what makes its turns durable instead of dying with the tab (T300).
   * Placing it on a tree then gives the SAME session a tree node, and bind()
   * above refuses that outright -- rightly, because silently repointing a live
   * binding is how a conversation gets split without anyone deciding to.
   *
   * So the handover is said out loud instead. The caller releases the seat,
   * which flushes everything written so far to the seat's own folder and stops
   * this session writing there; the tree then binds as any tree node does.
   * What was said before the move stays readable where it happened, and what is
   * said after lands on the node. Nothing is moved behind a reader's back and
   * nothing is dropped.
   *
   * Releasing a session that holds no binding is not an error and not a
   * silence: it answers { ok: true, released: false } so a caller can tell
   * "there was nothing to release" from "the release happened".
   */
  async function release({ sessionId } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid transcript session binding.')
    const held = bindings.get(sessionId)
    if (!held) return { ok: true, released: false }
    for (const [key, batch] of batches) if (key.startsWith(`agent:${sessionId}:`)) { flush(key); batches.delete(key) }
    bindings.delete(sessionId)
    endedBindings.delete(sessionId)
    metadataWritten.delete(sessionId)
    await flushNode(held)
    return { ok: true, released: true }
  }
  let packetFlight = null
  // Settles once the newest queued item has been taken into its batch (or was
  // refused), which is what flushNode must wait for before it flushes.
  let admissionTail = null
  function storageBoundary(operation, waitForSave, returnClosingResult = false) {
    const releaseAdmission = admit()
    if (!releaseAdmission) return returnClosingResult ? Promise.resolve({ ok: false, code: CAPTURE_CLOSING, message: closingMessage }) : Promise.reject(closingError())
    // Every captured provider event and accepted prompt shares this pause.
    // After a refused write the next already-accepted item stays with its
    // producer instead of growing the store's retained entry set.
    let taken
    const tail = new Promise(resolve => { taken = resolve })
    admissionTail = tail
    tail.then(() => { if (admissionTail === tail) admissionTail = null })
    const run = () => { try { return operation() } finally { taken() } }
    let admitted
    try { admitted = packetFlight ? packetFlight.then(run, error => { taken(); throw error }) : run() } catch (error) {
      releaseAdmission()
      return Promise.reject(error)
    }
    const result = Promise.resolve(admitted).finally(releaseAdmission)
    const flight = result.then(() => store.waitForStorage?.()).finally(() => {
      if (packetFlight === flight) packetFlight = null
    })
    packetFlight = flight
    flight.catch(() => {})
    return waitForSave ? flight : result
  }
  function packet(request = {}) {
    return storageBoundary(() => acceptPacket(request), true)
  }
  function acceptPacket(request) {
    const binding = bindings.get(request.sessionId) || endedBindings.get(request.sessionId)
    capturePacket(request)
    if (!binding) return
    // The engine awaits this boundary before parsing another event. Flush the
    // accepted event now; a storage hold pauses input until explicit retry.
    for (const [key, batch] of batches) if (batch.binding.computerId === binding.computerId && batch.binding.nodeId === binding.nodeId) flush(key)
    const pending = Promise.all([...writes].filter(([, owner]) =>
      owner.computerId === binding.computerId && owner.nodeId === binding.nodeId).map(([write]) => writeBarriers.get(write)?.promise || write))
      .then(() => store.waitForStorage?.())
    // Legacy synchronous observers may ignore the result. The native producer
    // still receives the original rejecting promise and cannot run past it.
    pending.catch(() => {})
    return pending
  }
  function capturePacket({ sessionId, event } = {}) {
    if (bindings.has(sessionId)) updateMetadata(sessionId, bindings.get(sessionId))
    if (event?.type === 'session_ended') {
      for (const [key, batch] of batches) if (key.startsWith(`agent:${sessionId}:`)) {
        for (const entry of batch.thoughts.values()) if (entry.state === 'working') { entry.state = 'unknown'; entry.dirty = true }
        flush(key); batches.delete(key)
      }
      // A transport acknowledgement can arrive after session end. Retain
      // only bounded attribution for accepted input; late output stays ignored.
      if (bindings.has(sessionId)) endedBindings.set(sessionId, bindings.get(sessionId))
      while (endedBindings.size > 256) endedBindings.delete(endedBindings.keys().next().value)
      bindings.delete(sessionId)
      metadataWritten.delete(sessionId)
      return
    }
    if (event?.treeDelivery === true) return
    if (!event?.turnId || !['assistant_text_delta', 'assistant_text', 'thinking', 'tool_call', 'tool_result', 'approval_request', 'turn_completed', 'turn_failed'].includes(event.type)) return
    const binding = bindings.get(sessionId)
    if (!binding) return
    const key = `agent:${sessionId}:${event.turnId}`
    let batch = batches.get(key)
    if (!batch) { batch = { binding, turnId: event.turnId, chunks: [], thoughts: new Map(), deltas: false, unkeyedDeltas: false, streamedItems: new Set(), hasText: false, breakPending: false, timer: null, at: Date.now() }; batches.set(key, batch) }
    if (event.type === 'thinking') {
      const id = thinkingTranscriptId(sessionId, event.turnId, event.itemId)
      const summary = thinkingSummary(event.text, event.payload?.truncated)
      if (!id || !summary.body.trim()) return
      const prior = batch.thoughts.get(id)
      if (!prior && batch.thoughts.size >= 128) {
        // Flush before releasing bounded capture memory. Entry identity on disk
        // still makes a replay replace its original entry rather than duplicate.
        const oldest = batch.thoughts.values().next().value
        if (oldest.state === 'working') { oldest.state = 'unknown'; oldest.dirty = true }
        flush(key)
        batch.thoughts.delete(batch.thoughts.keys().next().value)
      }
      batch.thoughts.set(id, { id, who: 'action', kind: 'thinking', tool: 'Thinking', text: 'Thinking',
        body: summary.body, truncated: summary.truncated, state: event.status === 'inProgress' ? 'working' : 'done',
        at: prior?.at ?? Date.now(), turnStamp: event.turnId, dirty: true })
      if (!batch.timer) batch.timer = schedule(() => flush(key), 50)
      if (event.status !== 'inProgress') flush(key)
      return
    }
    const appendWords = text => {
      if (!text) return
      if (batch.hasText && batch.breakPending) batch.chunks.push('\n\n')
      batch.breakPending = false
      batch.hasText = true
      batch.chunks.push(text)
    }
    if (['tool_call', 'tool_result', 'approval_request'].includes(event.type)) {
      batch.deltas = false
      batch.breakPending = true
      return
    }
    if (event.type === 'assistant_text_delta' && typeof event.text === 'string') {
      batch.deltas = true
      if (typeof event.itemId === 'string' && event.itemId) batch.streamedItems.add(event.itemId)
      /* A DELTA THAT NAMES NO ITEM CANNOT BE MATCHED BY ONE LATER. Remembered
         for the whole turn, not the current segment, because the final
         aggregate this guards against may arrive after a tool boundary. */
      else batch.unkeyedDeltas = true
      appendWords(event.text)
    } else if (event.type === 'assistant_text' && typeof event.text === 'string') {
      // A named final item can summarize chunks from before a tool or its
      // permission prompt. Tool boundaries separate paragraphs, not message
      // identity. ACP's final aggregate otherwise duplicated interrupted
      // replies on disk even though the still-open chat looked correct.
      /* AN ID THE DELTAS NEVER CARRIED IS NOT EVIDENCE OF NEW SPEECH. Claude
         streams its deltas unnamed and then names the final aggregate, so the
         lookup below missed, the whole turn was appended a second time, and
         every reply was stored twice -- 51 read back as 5151. The chat looked
         right because the live view replaces rather than appends, so only a
         reopened conversation showed it. Measured on j 2026-09-18. When the
         deltas were unnamed there is nothing to match, and the aggregate is
         their summary; when they were named, an unknown id is still a genuinely
         new item and is kept. */
      const streamed = typeof event.itemId === 'string' && event.itemId
        ? (batch.streamedItems.delete(event.itemId) || batch.unkeyedDeltas) : batch.deltas
      if (!streamed) appendWords(event.text)
      batch.deltas = false
      batch.breakPending = true
    } else if (event.type === 'turn_completed' || event.type === 'turn_failed') {
      // Queue after the final text flush so an incomplete answer stays before
      // its outcome. A stable independent ID makes terminal replay idempotent
      // without replacing any streamed speech or retaining past turns in RAM.
      for (const entry of batch.thoughts.values()) if (entry.state === 'working') { entry.state = 'unknown'; entry.dirty = true }
      flush(key)
      batches.delete(key)
      const text = terminalOutcomeText(event, now())
      if (text) {
        const id = 'terminal:' + createHash('sha256').update(JSON.stringify([sessionId, event.turnId])).digest('hex')
        const request = { ...binding, entries: [{ id, who: 'action', kind: 'turn', tool: 'Turn', state: 'undone', text, at: Date.now(), turnStamp: event.turnId }] }
        const pending = store.append(request, { accepted: true })
        trackWrite(pending, id, binding, () => store.append(structuredClone(request), { accepted: true }))
      }
      return
    } else return
    if (!batch.timer) batch.timer = schedule(() => flush(key), 50)
    if (batch.chunks.length >= 256) flush(key)
  }
  /* Bounded and shaped here rather than trusted from the caller: a transcript
     row is written to disk and read by other surfaces, so what goes into it is
     decided in one place. Name and byte count only, at most eight -- the same
     bound a turn already puts on pictures. */
  function summariseAttachments(rows) {
    if (!Array.isArray(rows)) return []
    const out = []
    for (const row of rows.slice(0, 8)) {
      if (!row || typeof row.name !== 'string' || !row.name) continue
      out.push(Number.isInteger(row.bytes) && row.bytes >= 0
        ? { name: row.name.slice(0, 260), bytes: row.bytes }
        : { name: row.name.slice(0, 260) })
    }
    return out
  }

  function prepareAcceptedTranscriptWrite({ request, binding, sessionId, stamp, at, transcriptOrigin, personOrigin }) {
    const { text, turnId, transcriptPrompt, attachments, pictureNotSent } = request || {}
    // The command surface supplies only the successful host result. Keep
    // accepted input verbatim; its compound tree brief is split for display.
    const accepted = transcriptPrompt?.text === text && Array.isArray(transcriptPrompt.additions)
      ? transcriptPrompt : null
    const carried = summariseAttachments(attachments)
    const entries = [{ id: `${transcriptOrigin}:${sessionId}:${stamp}`, who: personOrigin ? 'you' : 'action', text, at,
      ...(!personOrigin ? { kind: 'automatic', origin: transcriptOrigin } : {}),
      ...(carried.length ? { attachments: carried } : {}),
      ...(turnId ? { turnStamp: turnId } : {}) }]
    if (pictureNotSent && typeof pictureNotSent.sentence === 'string' && pictureNotSent.sentence) {
      const refused = summariseAttachments(pictureNotSent.attachments)
      entries.push({ id: `note:${sessionId}:${stamp}:picture-not-sent`, who: 'action', kind: 'note',
        tool: 'Attachment', state: 'refused', text: pictureNotSent.sentence, at,
        ...(refused.length ? { attachments: refused } : {}),
        ...(typeof pictureNotSent.provider === 'string' && pictureNotSent.provider ? { provider: pictureNotSent.provider } : {}),
        ...(turnId ? { turnStamp: turnId } : {}) })
    }
    for (const [index, part] of (accepted?.additions || []).slice(0, 7).entries()) {
      if (!['tree', 'requests', 'tasks', 'history', 'role', 'tools', 'capabilities'].includes(part?.kind) || typeof part.text !== 'string' || !part.text) continue
      entries.push({ id: `context:${sessionId}:${stamp}:${index}`, who: 'you', text: part.text, at,
        promptKind: part.kind, promptSource: 'toolsenabled', ...(turnId ? { turnStamp: turnId } : {}) })
    }
    return { entries, writeRequest: { ...binding, entries } }
  }

  function recordAcceptedTranscriptSend(request) {
    // The provider may acknowledge a turn before its asynchronous transcript
    // callback arrives. Once sealed, that callback is still an already-
    // accepted input: retain it as a retryable unsaved record rather than
    // answering the engine with a bare closing refusal.
    if (closing) return acceptPrompt(request, { holdOnly: true })
    return storageBoundary(() => acceptPrompt(request), false, true)
  }
  async function acceptPrompt(request = {}, { holdOnly = false } = {}) {
    const { sessionId, text, turnId, transcriptPrompt, attachments, pictureNotSent, transcriptReservation, origin = 'person' } = request || {}
    const binding = bindings.get(sessionId) || endedBindings.get(sessionId)
    const personOrigin = origin === 'person' || origin === 'person-queued'
    const transcriptOrigin = personOrigin ? 'person' : 'automatic'
    const stamp = turnId || randomUUID()
    const at = Date.now()
    const key = `you:${sessionId}:${stamp}`
    const retryPreparedWrite = (currentBinding = bindings.get(sessionId) || endedBindings.get(sessionId) || binding) => {
      if (!currentBinding) return Promise.resolve({ ok: false, code: 'MC_TRANSCRIPT_IDENTITY_UNRESOLVED' })
      if (typeof text !== 'string') return Promise.resolve({ ok: false, code: 'MC_TRANSCRIPT_INPUT_INVALID' })
      const prepared = prepareAcceptedTranscriptWrite({ request, binding: currentBinding, sessionId, stamp, at, transcriptOrigin, personOrigin })
      return store.append(structuredClone(prepared.writeRequest), acceptedOptions)
    }
    const acceptedOptions = { accepted: true, ...(transcriptReservation || {}) }
    const failureKey = key
    try {
      const { entries, writeRequest } = prepareAcceptedTranscriptWrite({ request, binding, sessionId, stamp, at, transcriptOrigin, personOrigin })
      const retryWrite = () => store.append(structuredClone(writeRequest), acceptedOptions)
      if (!binding || typeof text !== 'string') {
        const unresolved = Object.assign(new Error(!binding
          ? 'Accepted transcript input has no authoritative session binding yet.'
          : 'Accepted transcript input is not valid text.'),
        { code: !binding ? 'MC_TRANSCRIPT_IDENTITY_UNRESOLVED' : 'MC_TRANSCRIPT_INPUT_INVALID' })
        const deferredRetry = () => {
          const current = bindings.get(sessionId) || endedBindings.get(sessionId)
          if (!current) return Promise.resolve({ ok: false, code: 'MC_TRANSCRIPT_IDENTITY_UNRESOLVED' })
          if (typeof text !== 'string') return Promise.resolve({ ok: false, code: 'MC_TRANSCRIPT_INPUT_INVALID' })
          return store.append({ ...current, entries: structuredClone(entries) }, acceptedOptions)
        }
        failures.set(key, { error: unresolved, binding: binding || null, retry: deferredRetry, pending: null,
          acceptedInput: text, waiters: [] })
        emitUnsavedNotice()
        return await waitForFailure(key)
      }
      if (holdOnly) {
        failures.set(key, { error: Object.assign(new Error(failureMessage), { code: CAPTURE_UNSAVED }), binding,
          retry: retryWrite, pending: null, waiters: [] })
        emitUnsavedNotice()
        return await waitForFailure(key)
      }
      const pending = Promise.resolve().then(() => store.append(writeRequest, acceptedOptions))
      trackWrite(pending, key, binding, retryWrite)
      const answer = await pending
      if (answer?.durable === false || answer?.ok === false) {
        if (answer?.ok === false && !failures.has(key)) {
          const error = Object.assign(new Error(answer.message || failureMessage), { code: answer.code || CAPTURE_UNSAVED })
          failures.set(key, { error, binding, retry: retryWrite, pending: null, waiters: [] })
          onError(error)
        }
        if (answer?.durable === false && !failures.has(key)) {
          failures.set(key, { error: unsavedError(), binding, retry: null, pending: null, durableWait: true, waiters: [] })
        }
        return await waitForFailure(key)
      }
      return answer
    } catch {
      if (failureKey && failures.has(failureKey)) return await waitForFailure(failureKey)
      const error = unsavedError()
      failures.set(failureKey, { error, binding: binding || null, retry: retryPreparedWrite, pending: null,
        acceptedInput: text, acceptedRequest: request, waiters: [] })
      try { onError(error) } catch {}
      return await waitForFailure(failureKey)
    }
  }
  function retry({ durable = false } = {}) {
    if (retryFlight) return retryFlight
    retryFlight = (async () => {
      for (const [key, failure] of [...failures]) {
        if (typeof failure.retry !== 'function') continue
        const pending = Promise.resolve().then(failure.retry)
        failures.set(key, { ...failure, pending })
        trackRetry(pending, key, failure)
        try { await pending } catch {}
      }
      if (durable && !storageIsRefused()) {
        for (const [key, failure] of [...failures]) if (failure.durableWait) settleFailure(key, { ok: true, durable: true })
      }
      const status = getStorageStatus()
      return { ok: !status.unsaved, durable: status.durable, ...status, requestedDurability: durable }
    })().finally(() => { retryFlight = null })
    retryFlight.catch(() => {})
    return retryFlight
  }
  /* ERASE: THE WORDS STILL HELD HERE GO WITH THE DATA (c4 second review). The
     erase closes the agent host and then seals the store, and the sweep removes
     every conversation. Words this capture still held -- a turn in progress, or
     a write the store refused -- would be flushed again at quit into a sealed
     store, refused, and kept as "unsaved": the quit after the erase stopped on
     "Conversation has not been saved", and Retry could not help. They belong to
     the data being removed, so they are dropped here and nothing is written.
     Lasts for the rest of the run, like the store's seal. */
  function discardForErase() {
    closing = true
    discarded = true
    for (const batch of batches.values()) if (batch.timer) cancel(batch.timer)
    batches.clear()
    for (const failure of failures.values()) {
      for (const resolve of failure.waiters || []) resolve(failureResult())
      failure.barrierResolve?.(failureResult())
    }
    failures.clear()
    for (const wake of failureWaiters) wake()
    failureWaiters.clear()
    return { ok: true, discarded: true }
  }
  function sealForShutdown() {
    closing = true
    if (!sealPromise) sealPromise = drainAdmissions()
    return sealPromise
  }
  async function shutdown() {
    const drained = sealForShutdown()
    for (const [key, batch] of batches) {
      for (const entry of batch.thoughts.values()) if (entry.state === 'working') { entry.state = 'unknown'; entry.dirty = true }
      flush(key)
    }
    // A refused boundary deliberately remains pending until retry. Surface
    // the refusal now so the quit coordinator can keep the application open;
    // awaiting the barrier here would deadlock the quit path.
    if (failures.size || storageIsRefused()) throw unsavedError()
    if (!await drained || storageIsRefused()) throw unsavedError()
    await Promise.allSettled([...writes.keys()])
    if (failures.size || storageIsRefused()) throw unsavedError()
    if (packetFlight) {
      try { await packetFlight } catch { throw unsavedError() }
    }
    if (failures.size || storageIsRefused()) throw unsavedError()
    batches.clear(); bindings.clear(); endedBindings.clear(); metadataWritten.clear()
  }
  /* A PACKET STILL QUEUED IS PART OF THIS FLUSH. Packets wait in turn behind
     the previous item's write, so a caller that flushes and then reads -- the
     account-switch history, a remote transcript read, an archive -- would
     otherwise read before the newest words were even taken in. A refused write
     stops the queue until retry; the flush then answers from what it has. */
  async function queuedPacketsTaken() {
    const tail = admissionTail
    if (!tail || failures.size || storageIsRefused()) return
    let wake
    const refused = new Promise(resolve => { wake = resolve; failureWaiters.add(resolve) })
    try { await Promise.race([tail, refused]) } finally { failureWaiters.delete(wake) }
  }
  async function flushNode({ computerId, nodeId } = {}) {
    await queuedPacketsTaken()
    for (const [key, batch] of batches) if (batch.binding.computerId === computerId && batch.binding.nodeId === nodeId) flush(key)
    await Promise.all([...writes].filter(([, binding]) => binding.computerId === computerId && binding.nodeId === nodeId).map(([pending]) => pending))
    for (const failure of failures.values()) if (failure.binding?.computerId === computerId && failure.binding?.nodeId === nodeId) throw failure.error
  }
  return { bind, release, packet, recordAcceptedTranscriptSend, retry, getStorageStatus, sealForShutdown, discardForErase, flushNode, shutdown,
    hasPendingWrites: () => packetFlight !== null || activeAdmissions > 0 || writes.size > 0 || failures.size > 0 || [...batches.values()].some(batch => batch.chunks.length || [...batch.thoughts.values()].some(entry => entry.dirty)),
    bindingFor: sessionId => bindings.has(sessionId) ? { ...bindings.get(sessionId) } : null }
}

module.exports = { createNodeTranscriptCapture }
