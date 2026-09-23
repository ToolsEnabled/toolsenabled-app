// A small live viewport over the complete disk history. All writes are async;
// the synchronous get/has face exists only for the existing menu predicates.
export function createNodeTranscriptClient({ computerId, bridge, legacy, nodeIds = [], onError = () => {}, onReady = () => {} }) {
  const cache = new Map()
  const writes = new Map()
  const fingerprints = new Map()
  const readVersions = new Map()
  const bindVersions = new Map()
  const invalidateRead = nodeId => readVersions.set(nodeId, {})
  let disposed = false
  const report = error => { if (!disposed) onError(`Conversation could not be saved: ${error.message || error}`) }
  const unsubscribe = bridge.onError?.(report)
  const checked = answer => {
    if (!answer?.ok) throw new Error(answer?.error?.message || 'Conversation storage did not answer.')
    return answer
  }
  const idFor = line => {
    if (line.id) return line.id
    let hash = 2166136261
    for (const character of line.text || '') hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
    return `legacy:${line.who}:${line.at || 0}:${line.text?.length || 0}:${hash}`
  }
  const queue = (nodeId, operation) => {
    const pending = (writes.get(nodeId) || Promise.resolve()).catch(() => {}).then(async () => { await ready; return operation() })
    writes.set(nodeId, pending)
    pending.catch(report).finally(() => { if (writes.get(nodeId) === pending) writes.delete(nodeId) })
    return pending
  }
  async function persist(nodeId, lines, metadata = {}) {
    for (let offset = 0; offset < lines.length; offset += 128) checked(await bridge.append({ computerId, nodeId, entries: lines.slice(offset, offset + 128), metadata }))
    if (!lines.length) checked(await bridge.append({ computerId, nodeId, entries: [], metadata }))
    return true
  }
  function save(nodeId, record = {}) {
    invalidateRead(nodeId)
    const prior = cache.get(nodeId) || legacy?.get(nodeId)
    const metadata = Object.fromEntries(['threadId', 'effort', 'provider', 'account']
      .filter(key => !(record.keepUnknown && (record[key] === undefined || (key !== 'account' && record[key] === null))))
      .map(key => [key, record[key] ?? null]))
    const lines = (record.lines || []).map(line => ({ ...line, id: idFor(line) }))
    cache.set(nodeId, { ...prior, ...metadata, lines: lines.slice(-60), savedAt: Date.now(), trimmed: prior?.trimmed || 0 })
    const seen = fingerprints.get(nodeId) || new Map()
    fingerprints.set(nodeId, seen)
    const changed = lines.filter(line => (!bridge.bind || (line.who === 'action'
      && !(line.kind === 'thinking' && line.id.startsWith('thinking:')))) && seen.get(line.id) !== JSON.stringify(line))
    // Keep only the viewport's fingerprints. The backend's stable IDs make
    // retrying an entry idempotent after a reload or after this cache expires.
    for (const line of lines) seen.set(line.id, JSON.stringify(line))
    if (seen.size > 256) for (const id of [...seen.keys()].slice(0, seen.size - 128)) seen.delete(id)
    const pending = queue(nodeId, () => persist(nodeId, changed, metadata))
    pending.catch(() => {
      for (const line of changed) seen.delete(line.id)
    })
    return pending
  }
  const ready = (async () => {
    const answer = checked(await bridge.list({ computerId }))
    for (const nodeId of nodeIds) {
      const record = legacy?.get(nodeId)
      if (!record) continue
      const { lines, ...metadata } = record
      if (bridge.migrate) checked(await bridge.migrate({ computerId, nodeId, entries: lines.map(line => ({ ...line, id: idFor(line) })), metadata }))
      else if (!answer.records.some(record => record.nodeId === nodeId)) await persist(nodeId, lines.map(line => ({ ...line, id: idFor(line) })), metadata)
      if (!answer.records.some(record => record.nodeId === nodeId)) answer.records.push({ ...metadata, nodeId })
    }
    for (const metadata of answer.records) {
      const page = checked(await bridge.read({ computerId, nodeId: metadata.nodeId, limit: 60 }))
      cache.set(metadata.nodeId, { ...metadata, ...page.metadata, lines: page.entries, before: page.before, ...cache.get(metadata.nodeId) })
    }
    if (!disposed) onReady()
  })()
  ready.catch(report)
  return {
    ready,
    save,
    async readLatest(nodeId) {
      invalidateRead(nodeId)
      const version = readVersions.get(nodeId)
      await ready
      await writes.get(nodeId)
      const page = checked(await bridge.read({ computerId, nodeId, limit: 60, includeRecoveryFiles: true }))
      if (!page.metadata) return legacy?.get(nodeId) || null
      const record = { ...page.metadata, lines: page.entries, before: page.before, recoveryDirectory: page.recoveryDirectory }
      if (!disposed && readVersions.get(nodeId) === version) cache.set(nodeId, record)
      return record
    },
    bind(sessionId, nodeId) {
      // Appending a line and saving its metadata can request the same binding
      // together. Both callers must await the one host ACK instead of making
      // the first caller stale while it is still confirming that same node.
      const current = bindVersions.get(sessionId)
      if (!disposed && current?.nodeId === nodeId && current.pending) return current.pending
      const generation = { nodeId, pending: null }
      bindVersions.set(sessionId, generation)
      const stillCurrent = () => !disposed && bindVersions.get(sessionId) === generation
      const stale = () => Object.assign(new Error('Conversation binding changed while waiting.'), { code: 'TRANSCRIPT_BIND_STALE' })
      const pending = Promise.resolve().then(async () => {
        if (!stillCurrent()) throw stale()
        if (typeof bridge.bind !== 'function') {
          throw Object.assign(new Error('Conversation binding is unavailable.'), { code: 'TRANSCRIPT_BIND_UNAVAILABLE' })
        }
        const answer = await bridge.bind({ sessionId, computerId, nodeId })
        if (!stillCurrent()) throw stale()
        // The actual host ACK has no identity echo. Correlation belongs to this
        // captured request and its pending generation, not invented reply fields.
        if (answer?.ok !== true) {
          const error = new Error(answer?.error?.message || 'Conversation binding did not confirm readiness.')
          if (typeof answer?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(answer.error.code)) error.code = answer.error.code
          throw error
        }
        return answer
      })
      generation.pending = pending
      pending.then(() => { generation.pending = null }, error => {
        generation.pending = null
        report(error)
      })
      return pending
    },
    /* Lets go of whatever node this session was writing to, having flushed it.
       The one caller is the handover: a + agent bound to its own seat being
       placed on a tree, where the tree's bind would otherwise be refused
       because a live binding is never silently repointed. An older shell with
       no release verb answers the same shape as no bridge at all, so a caller
       cannot mistake "this copy cannot release" for "the release happened". */
    release(sessionId) {
      bindVersions.delete(sessionId)
      if (!bridge.release) return Promise.resolve({ ok: false, released: false })
      const pending = bridge.release({ sessionId }).then(checked)
      pending.catch(report)
      return pending
    },
    capture(nodeId, entry) {
      // Called BEFORE the viewport trims. Metadata follows through save().
      if (bridge.bind && (entry.who !== 'action' || (entry.kind === 'thinking' && entry.id?.startsWith('thinking:')))) return Promise.resolve()
      return queue(nodeId, () => persist(nodeId, [{ ...entry, id: idFor(entry) }]))
    },
    get: nodeId => cache.get(nodeId) || legacy?.get(nodeId) || null,
    has: nodeId => Boolean(cache.get(nodeId)?.lines?.length || legacy?.has(nodeId)),
    async migrate(nodeIds) {
      await ready
      for (const nodeId of nodeIds) {
        if (cache.has(nodeId)) continue
        const record = legacy?.get(nodeId)
        if (record) await save(nodeId, record)
      }
    },
    readPage: async (nodeId, before, limit = 60) => checked(await bridge.read({ computerId, nodeId, before, limit })),
    archive(nodeId) {
      return queue(nodeId, async () => checked(await bridge.archive({ computerId, nodeId, stageOnly: true })))
    },
    commitArchive(nodeId, archiveId) {
      return queue(nodeId, async () => {
        if (archiveId) checked(await bridge.commitArchive({ computerId, nodeId, archiveId }))
        invalidateRead(nodeId)
        cache.delete(nodeId); legacy?.remove(nodeId)
      })
    },
    cancelArchive(nodeId, archiveId) {
      if (!archiveId) return Promise.resolve()
      return queue(nodeId, async () => checked(await bridge.cancelArchive({ computerId, nodeId, archiveId })))
    },
    rollback(nodeId, entryId) {
      return queue(nodeId, async () => {
        checked(await bridge.rollback({ computerId, nodeId, entryId }))
        invalidateRead(nodeId)
        const held = cache.get(nodeId)
        if (held) held.lines = held.lines.filter(line => line.id !== entryId)
      })
    },
    /* A FULL CLEAR, NOT THE SINGLE-LINE ROLLBACK THIS USED TO BE.
     *
     * MEASURED, Controller 2026-09-06: agent.restart refused four different
     * circles with MC_TREE_COMMAND_TRANSCRIPT_RESET_FAILED, both before and
     * after an app restart. fresh-start-existing-node.js checks
     * `transcriptStore.remove(node.id) !== true` -- a contract this client
     * never met even before this fix, since it returned a Promise (never the
     * literal `true`) and only rolled back the single cached last line, never
     * the rest of the node's file-backed history. Node's chromium `Local
     * Storage` leveldb staying near-empty on that machine is consistent with
     * this, not against it: this client's writes never touch
     * window.localStorage at all -- they go through window.mcTranscripts to
     * shell/node-transcript-store.cjs's own JSON files under userData, which
     * is a different store than the one session-transcript-store.js's
     * synchronous `remove()` (and the caller's contract) was written against.
     *
     * The two other production call sites of `.remove()` (src/views/computers.js,
     * node removal and the failed-send rollback) both branch to `.archive()` /
     * `.rollback()` before ever reaching this method whenever `.archive` and
     * `.rollback` exist -- which this client always provides -- so redefining
     * this method's meaning changes no other call site's behaviour.
     *
     * Drains the backing store page by page rather than trusting `cache`
     * (bounded to the last 60 lines): a restart or resume must never resurface
     * an older line the live viewport never paged in. */
    async remove(nodeId) {
      for (;;) {
        const page = await this.readPage(nodeId, undefined, 100)
        if (!page.entries.length) break
        for (const entry of page.entries) await this.rollback(nodeId, entry.id)
      }
      invalidateRead(nodeId)
      cache.delete(nodeId)
      return true
    },
    dispose() { disposed = true; unsubscribe?.() },
  }
}
