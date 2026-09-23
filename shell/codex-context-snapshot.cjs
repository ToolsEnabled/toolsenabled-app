'use strict'

const fs = require('node:fs')

const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
// Scan incrementally; this is not an allocation or an expanded import limit.
const MAX_SOURCE_BYTES = 128 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024

function refuse(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

// A paginated rollout names a separate database lineage. Moving that file
// alone does not move the lineage. A standalone legacy rollout is the native
// disk import contract: keep the original metadata, the last complete native
// replacement_history, and every subsequent record. No model-visible item is
// summarized or rewritten. Older display history remains in the source editor.
function readCodexContextSnapshot(fd, size, sessionId) {
  if (size > MAX_SOURCE_BYTES) refuse('EDITOR_FORK_TOO_LARGE', 'The saved conversation exceeds the bounded context scan limit.')
  const chunk = Buffer.alloc(CHUNK_BYTES)
  let carry = [], carryBytes = 0, position = 0, metadata = null, metadataRecord = null
  let retained = [], retainedBytes = 0, overflow = false, compacted = false
  let lastTurnContext = null, lastWorldState = null, ordinal = 0

  function keep(bytes) {
    if (overflow) return
    retainedBytes += bytes.length
    if (retainedBytes > MAX_SNAPSHOT_BYTES) { retained = []; overflow = true; return }
    retained.push(bytes)
  }
  function recordLine(bytes) {
    ordinal += 1
    const line = bytes.toString('utf8').trim()
    if (!line) { keep(bytes); return }
    let record
    try { record = JSON.parse(line) }
    catch { refuse('EDITOR_SOURCE_BUSY', 'The saved conversation contains an unfinished record. Try again after its current turn.') }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      refuse('EDITOR_SOURCE_BUSY', 'The saved conversation contains an unsupported record.')
    }
    if (record.type === 'session_meta') {
      const identity = record.payload?.id || record.payload?.session_id
      if (identity !== sessionId || metadata) refuse('EDITOR_SOURCE_CHANGED', 'The saved record contains another conversation identity. Check for sessions again.')
      metadata = bytes; metadataRecord = record
    }
    if (record.type === 'compacted' && Array.isArray(record.payload?.replacement_history)) {
      if (!metadata) refuse('EDITOR_SOURCE_IDENTITY_UNAVAILABLE', 'The saved context does not identify its conversation before compaction.')
      retained = []; retainedBytes = 0; overflow = false; compacted = true
      keep(metadata)
      for (const previous of [lastTurnContext, lastWorldState].filter(Boolean).sort((a, b) => a.ordinal - b.ordinal)) keep(previous.bytes)
    }
    keep(bytes)
    if (record.type === 'turn_context') lastTurnContext = { bytes, ordinal }
    if (record.type === 'world_state') lastWorldState = { bytes, ordinal }
  }

  while (position < size) {
    const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position)
    if (!count) refuse('EDITOR_SOURCE_BUSY', 'The editor record changed while its context was read. Try again after the current turn.')
    position += count
    let start = 0, end
    while ((end = chunk.indexOf(10, start)) >= 0 && end < count) {
      const next = Buffer.from(chunk.subarray(start, end + 1))
      carry.push(next); carryBytes += next.length
      if (carryBytes > MAX_SNAPSHOT_BYTES) refuse('EDITOR_FORK_TOO_LARGE', 'One saved context record exceeds the 32 MiB copy limit.')
      recordLine(Buffer.concat(carry, carryBytes))
      carry = []; carryBytes = 0
      start = end + 1
    }
    if (start < count) { carry.push(Buffer.from(chunk.subarray(start, count))); carryBytes += count - start }
    if (carryBytes > MAX_SNAPSHOT_BYTES) refuse('EDITOR_FORK_TOO_LARGE', 'One saved context record exceeds the 32 MiB copy limit.')
  }
  if (!compacted && size > MAX_SNAPSHOT_BYTES) refuse('EDITOR_FORK_TOO_LARGE', 'The current conversation context exceeds the 32 MiB copy limit.')
  if (carryBytes) refuse('EDITOR_SOURCE_BUSY', 'The editor is still saving this conversation. Try again after its current turn.')
  if (!metadata) refuse('EDITOR_SOURCE_IDENTITY_UNAVAILABLE', 'The complete source copy does not identify the selected conversation. Check for sessions again.')
  if (overflow) refuse('EDITOR_FORK_TOO_LARGE', 'The current conversation context exceeds the 32 MiB copy limit.')
  const sourceHistoryMode = metadataRecord.payload.history_mode || 'legacy'
  if (!['legacy', 'paginated'].includes(sourceHistoryMode)) refuse('EDITOR_FORK_UNSUPPORTED', 'This saved conversation uses an unsupported history format.')
  if (sourceHistoryMode === 'paginated' && !compacted) {
    refuse('EDITOR_FORK_UNSUPPORTED', 'This paginated conversation needs a complete native context checkpoint before a separate copy can be made.')
  }
  if (sourceHistoryMode === 'paginated') {
    // The source metadata is untouched. Only this separate temporary import
    // changes its storage contract so Codex does not seek the source database.
    const standalone = { ...metadataRecord, payload: { ...metadataRecord.payload, history_mode: 'legacy' } }
    const converted = Buffer.from(JSON.stringify(standalone) + '\n')
    const index = retained.indexOf(metadata)
    retained[index] = converted
    retainedBytes += converted.length - metadata.length
  }
  if (retainedBytes > MAX_SNAPSHOT_BYTES) refuse('EDITOR_FORK_TOO_LARGE', 'The current conversation context exceeds the 32 MiB copy limit.')
  return { bytes: Buffer.concat(retained, retainedBytes), sourceHistoryMode,
    historyScope: compacted ? 'current-model-context' : 'saved-conversation',
    sourceBytes: size, copiedBytes: retainedBytes }
}

module.exports = { readCodexContextSnapshot, MAX_SNAPSHOT_BYTES, MAX_SOURCE_BYTES }
