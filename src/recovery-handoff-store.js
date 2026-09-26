// Recovery payloads need their full bounded text. Chat display lines deliberately
// retain short excerpts and cannot serve as a durable continuation checkpoint.
/* The bound travels with the DATA, not with whichever store it happens to live in.
   Moving these records to disk is not a reason to stop bounding them. */
const MAX_HANDOFF_CHARS = 48000

function usable(nodeId, value) {
  return Boolean(nodeId)
    && typeof value?.handoff === 'string'
    && Boolean(value.handoff.trim())
    && value.handoff.length <= MAX_HANDOFF_CHARS
}

/* T366 -- THE DOUBLING IS FROZEN IN RECORDS ALREADY ON DISK, AND IT IS STILL
 * SENT TO THE MODEL.
 *
 * shell/account-session-recovery.cjs `rememberRecoveryText` used to put every
 * person message in BOTH `state.first` ("Original task / brief") and
 * `state.segments` ("Recent conversation"), so `recoveryHandoff` wrote each
 * early person message into one handoff TWICE. T377 item 8 stopped the
 * producer doing it. It did not, and could not, heal the records already
 * written: a stored handoff is read back by this store and handed to the
 * replacement session (src/account-recovery-coordinator.js `readHandoff` ->
 * `manualAccountHandoff` / `manualModelHandoff` -> `bridge.send`), so after a
 * switch the model is still fed the owner's own words twice.
 *
 * REPAIRED AT READ TIME, ON THE READ PATH THAT ALREADY EXISTS. Both `get` and
 * `readRecord` below are the only ways a stored handoff reaches a caller, so
 * repairing there heals every record without a migration, without writing to
 * the owner's data, and without a second recovery path to keep in step.
 *
 * WHAT IS REMOVED, and only this: a run of characters in "Recent conversation"
 * that is (a) immediately preceded by the producer's own person marker and
 * (b) byte-identical to a whole message that is STILL PRESENT in "Original
 * task / brief". Nothing that is not an exact surviving duplicate can be
 * removed, so the repair cannot truncate; and because the removal deletes the
 * marker with the copy, a second pass has nothing left to match, so it is
 * idempotent. A handoff written by the fixed producer has no such block at
 * all and comes back unchanged.
 *
 * The three literals below are the producer's, in shell/account-session-recovery.cjs
 * (`recoveryHandoff` and `rememberRecoveryText`). They are matched, never
 * written, so this reader cannot change what a handoff says. */
const HANDOFF_BRIEF_HEADER = '\n\nOriginal task / brief:\n'
const HANDOFF_TAIL_HEADER = '\n\nRecent conversation:\n'
const HANDOFF_PERSON_MARK = '\n[message]\n'

/* THE ONE CASE WHERE "Original task / brief" DOES NOT HOLD A MESSAGE WHOLE.
 * The producer stops filling the brief at its own ceiling and slices the
 * message that reaches it (`state.first.slice(0, FIRST_LIMIT)` in
 * shell/account-session-recovery.cjs), so when the brief is AT that ceiling its
 * last message may be a prefix of the one in the tail -- and the tail copy is
 * then not a duplicate, it is the only complete copy. The value below mirrors
 * that producer's FIRST_LIMIT; a brief shorter than it cannot have been cut, so
 * every message it holds is whole. At the ceiling the final position stops
 * counting as a message end, which is exactly the prefix case and nothing else.
 * MEASURED: without this, a mutation that accepted any common prefix passed the
 * whole repro, because the repro had no capped brief in it. It has one now. */
const PRODUCER_BRIEF_LIMIT = 16000

// Where a whole message can start and end inside "Original task / brief".
// The producer joins person messages with a blank line, and a message may
// itself contain blank lines, so every blank line is BOTH a possible end and
// a possible start and the longest match wins.
function messageBounds(first) {
  const starts = [0], ends = first.length < PRODUCER_BRIEF_LIMIT ? [first.length] : []
  const separator = /\n\n/g
  for (let match = separator.exec(first); match; match = separator.exec(first)) {
    ends.push(match.index)
    starts.push(match.index + match[0].length)
  }
  return { starts, ends: new Set(ends) }
}

/* The longest prefix of `rest` that is a whole message of `first`. Returns 0
   when `rest` does not begin with one, which is the ordinary answer for a
   handoff that was never doubled and for an assistant reply. */
function survivingCopyLength(first, bounds, rest) {
  let longest = 0
  for (const start of bounds.starts) {
    let span = 0
    const room = Math.min(first.length - start, rest.length)
    while (span < room && first[start + span] === rest[span]) span += 1
    // Walk back to the nearest place a message is allowed to end, so a
    // coincidental shared opening can never be mistaken for a whole message.
    while (span > longest && !bounds.ends.has(start + span)) span -= 1
    if (span > longest && bounds.ends.has(start + span)) longest = span
  }
  return longest
}

function dropTailCopies(first, tail) {
  const bounds = messageBounds(first)
  let out = '', from = 0
  for (;;) {
    const mark = tail.indexOf(HANDOFF_PERSON_MARK, from)
    if (mark < 0) break
    const after = mark + HANDOFF_PERSON_MARK.length
    const copied = survivingCopyLength(first, bounds, tail.slice(after))
    if (copied === 0) { out += tail.slice(from, after); from = after; continue }
    out += tail.slice(from, mark)
    from = after + copied
  }
  return out + tail.slice(from)
}

/* Pure, and exported so a caller that already holds handoff text (a report, a
   test, a future migration) repairs it the same way this store does. */
export function repairDoubledHandoff(value) {
  if (typeof value !== 'string' || !value) return value
  const header = value.indexOf(HANDOFF_BRIEF_HEADER)
  if (header < 0) return value
  const firstStart = header + HANDOFF_BRIEF_HEADER.length
  const tailHeader = value.indexOf(HANDOFF_TAIL_HEADER, firstStart)
  if (tailHeader < 0) return value
  const first = value.slice(firstStart, tailHeader)
  if (!first.trim()) return value
  const tailStart = tailHeader + HANDOFF_TAIL_HEADER.length
  const tail = value.slice(tailStart)
  const repaired = dropTailCopies(first, tail)
  return repaired === tail ? value : value.slice(0, tailStart) + repaired
}

// Every record leaving this store goes through here, so no caller has to know
// the repair exists and no caller can forget it.
function repairedRecord(record) {
  if (!record || typeof record.handoff !== 'string') return record
  const handoff = repairDoubledHandoff(record.handoff)
  return handoff === record.handoff ? record : { ...record, handoff }
}

export function createRecoveryHandoffStore({ computerId, storage, bridge = null, onWriteResult = () => {} } = {}) {
  const key = nodeId => `mc.agent-recovery.v1:${encodeURIComponent(computerId)}:${encodeURIComponent(nodeId)}`

  const store = {
    save(nodeId, value) {
      if (!usable(nodeId, value)) return false
      try { return storage.write(key(nodeId), { v: 1, ...value }) === true } catch { return false }
    },
    get(nodeId) {
      try {
        const raw = storage.read(key(nodeId))
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw
        return value?.v === 1 && typeof value.handoff === 'string' && value.handoff.length <= MAX_HANDOFF_CHARS ? repairedRecord(value) : null
      } catch { return null }
    },
  }

  if (!bridge || typeof bridge.save !== 'function' || typeof bridge.get !== 'function') return store

  /* A FAILED BRIDGE WRITE IS NOT RETRIED INTO THE SETTINGS RECORD. Falling back
     would put the bytes in the one place this redirect exists to keep them out of,
     and would do it exactly when the disk is already unhappy. The caller treats
     false as fatal and raises "Could not save the full recovery handoff.", which
     is the honest outcome. */
  store.saveRecord = async (nodeId, value) => {
    let answer
    if (!usable(nodeId, value)) {
      answer = { ok: false, error: { code: value?.handoff?.length > MAX_HANDOFF_CHARS ? 'RECOVERY_RECORD_TOO_LARGE' : 'RECOVERY_RECORD_INVALID' } }
    } else {
      try { answer = await bridge.save({ computerId, nodeId, record: { v: 1, ...value } }) }
      catch { answer = { ok: false, error: { code: 'RECOVERY_WRITE_FAILED' } } }
    }
    try { onWriteResult(nodeId, answer) } catch { /* a notice must not change durability */ }
    return answer?.ok === true
  }

  store.readRecord = async (nodeId) => {
    try {
      const answer = await bridge.get({ computerId, nodeId })
      if (answer?.ok !== true) {
        const error = new Error(answer?.error?.message || 'Could not read the saved recovery handoff.')
        error.code = answer?.error?.code || 'RECOVERY_READ_FAILED'
        throw error
      }
      /* Repaired ONCE, before anything compares two copies. `store.get` above
         repairs what it returns, so comparing a repaired retained copy against
         a raw bridge copy would report two identical checkpoints as a
         RECOVERY_MIGRATION_CONFLICT purely because one side had been healed. */
      const bridgeRecord = repairedRecord(answer.record)
      // Older direct-store bridges expose provenance. The current shell's
      // coordinator owns source selection and explicitly forbids cache fallback.
      if (answer.authoritative !== true) {
        if (bridgeRecord && answer.legacy == null) {
          const retained = store.get(nodeId)
          if (retained && JSON.stringify(retained) !== JSON.stringify(bridgeRecord)) {
            const error = new Error('Saved recovery checkpoints conflict and their order is unknown. Both copies were preserved.')
            error.code = 'RECOVERY_MIGRATION_CONFLICT'
            throw error
          }
        }
        if (bridgeRecord == null || answer.legacy === true) {
          const retained = store.get(nodeId)
          if (retained) return retained
        }
      }
      const value = bridgeRecord
      if (value === null) return null
      if (value?.v !== 1 || !usable(nodeId, value)) {
        const error = new Error('The saved recovery handoff is unreadable.')
        error.code = 'RECOVERY_RECORD_UNREADABLE'
        throw error
      }
      return value
    } catch (cause) {
      if (cause?.code) throw cause
      const error = new Error('Could not read the saved recovery handoff.')
      error.code = 'RECOVERY_READ_FAILED'
      throw error
    }
  }

  return store
}
