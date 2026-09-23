'use strict'
const { createHash, randomUUID } = require('node:crypto')
const { limitReason } = require('./account-session-recovery.cjs')
const { thinkingTranscriptId, thinkingSummary } = require('./thinking-transcript.mjs')

/* A USAGE LIMIT SAYS WHEN IT ENDS (T1509). On 2026-09-22 thirty-seven Codex
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
  return 'Turn did not finish. No safe failure detail was recorded.'
}

// Canonical output capture lives beside the host, so changing renderer pages
// cannot lose a turn. Only the current batch is retained in memory.
function createNodeTranscriptCapture({ store, sessionMetadata = () => null, onError = () => {}, schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
  const bindings = new Map()
  const endedBindings = new Map()
  const batches = new Map()
  const writes = new Map()
  const failures = new Map()
  const metadataWritten = new Map()
  let closing = false
  function trackWrite(pending, key, binding) {
    writes.set(pending, binding)
    pending.catch(error => { failures.set(key, { error, binding }); onError(error) }).finally(() => writes.delete(pending))
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
    if (entries.length) trackWrite(store.append({ ...batch.binding, entries }), key, batch.binding)
    if (!batch.chunks.length) return
    const text = batch.chunks.join('')
    batch.chunks = []
    const pending = store.appendText({ ...batch.binding, entryId: key, text, at: batch.at, turnStamp: batch.turnId })
    trackWrite(pending, key, batch.binding)
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
    // Clear only this recovered attempt; unrelated or newer write failures remain visible.
    const priorFailure = failures.get(key)
    const pending = store.bindSessionMetadata({ ...binding, sessionId, metadata, replace: state.authoritative })
    state.pending = pending
    const settling = pending.then(answer => {
      if (state.pending !== pending) return
      state.pending = null
      if (!answer?.unchanged) state.fingerprint = fingerprint
      if (failures.get(key) === priorFailure) failures.delete(key)
    }, error => {
      if (state.pending === pending) state.pending = null
      throw error
    })
    trackWrite(settling, key, binding)
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
  function packet({ sessionId, event } = {}) {
    if (closing) return
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
        const pending = store.append({ ...binding, entries: [{ id, who: 'action', kind: 'turn', tool: 'Turn', state: 'undone', text, at: Date.now(), turnStamp: event.turnId }] })
        trackWrite(pending, id, binding)
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

  async function recordAcceptedTranscriptSend({ sessionId, text, turnId, transcriptPrompt, attachments, pictureNotSent, origin = 'person' }) {
    const binding = bindings.get(sessionId) || endedBindings.get(sessionId)
    if (!binding || typeof text !== 'string') return { ok: false }
    try {
      const personOrigin = origin === 'person' || origin === 'person-queued'
      const transcriptOrigin = personOrigin ? 'person' : 'automatic'
      const stamp = turnId || randomUUID()
      const at = Date.now()
      // The command surface supplies only the successful host result. Keep
      // accepted input verbatim; its compound tree brief is split for display.
      const accepted = transcriptPrompt?.text === text && Array.isArray(transcriptPrompt.additions)
        ? transcriptPrompt : null
      /* T18. A picture that rode this turn is recorded ON the person's row, by
         name and size -- never by path, and never its bytes. Before this, a
         turn that carried a picture and a turn that did not were the same row,
         so nothing downstream could tell them apart, and a picture that was
         refused was not recorded anywhere at all. */
      const carried = summariseAttachments(attachments)
      const entries = [{ id: `${transcriptOrigin}:${sessionId}:${stamp}`, who: personOrigin ? 'you' : 'action', text, at,
        ...(!personOrigin ? { kind: 'automatic', origin: transcriptOrigin } : {}),
        ...(carried.length ? { attachments: carried } : {}),
        ...(turnId ? { turnStamp: turnId } : {}) }]
      /* A REFUSED PICTURE IS ITS OWN ROW, in the words the person was shown.
         The message went; the picture did not; both belong in the record, and
         a reader six months from now should not have to infer the second from
         the absence of the first. */
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
      const pending = store.append({ ...binding, entries })
      trackWrite(pending, `you:${sessionId}:${stamp}`, binding)
      return await pending
    } catch (error) { onError(error); return { ok: false } }
  }
  async function shutdown() {
    closing = true
    for (const [key, batch] of batches) {
      for (const entry of batch.thoughts.values()) if (entry.state === 'working') { entry.state = 'unknown'; entry.dirty = true }
      flush(key)
    }
    await Promise.all([...writes.keys()])
    if (failures.size) throw [...failures.values()][0].error
    batches.clear(); bindings.clear(); endedBindings.clear(); metadataWritten.clear()
  }
  async function flushNode({ computerId, nodeId } = {}) {
    for (const [key, batch] of batches) if (batch.binding.computerId === computerId && batch.binding.nodeId === nodeId) flush(key)
    await Promise.all([...writes].filter(([, binding]) => binding.computerId === computerId && binding.nodeId === nodeId).map(([pending]) => pending))
    for (const failure of failures.values()) if (failure.binding.computerId === computerId && failure.binding.nodeId === nodeId) throw failure.error
  }
  return { bind, release, packet, recordAcceptedTranscriptSend, flushNode, shutdown,
    bindingFor: sessionId => bindings.has(sessionId) ? { ...bindings.get(sessionId) } : null }
}

module.exports = { createNodeTranscriptCapture }
