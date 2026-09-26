'use strict'

const crypto = require('node:crypto')
const { validateMetricsQuery, prepareMetricsRecords, selectMetricsPage } = require('./metrics-record-query.cjs')

// Continuations read the exact sanitized window that supplied their first page.
// A fresh request always reads disk. Cache loss is a visible retry, never a
// partial month or an implicit switch to another snapshot.
const MAX_SNAPSHOTS = 2
const MAX_SNAPSHOT_ROWS = 50000
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
const SNAPSHOT_TTL_MS = 60000
const expired = () => Object.assign(new Error('Read Metrics again to refresh the saved records.'), { code: 'METRICS_SNAPSHOT_EXPIRED' })

function createMetricsSnapshots({ now = Date.now } = {}) {
  const snapshots = new Map()
  function prune() {
    const at = now()
    for (const [id, item] of snapshots) if (at >= item.expiresAt) snapshots.delete(id)
  }
  function read(query, limit) {
    if (query?.snapshot === undefined) return null
    prune()
    const item = snapshots.get(query.snapshot)
    const { principal, ...request } = query
    if (!validateMetricsQuery(request) || !item || query.before === undefined
        || query.principal !== item.principal || query.head !== item.prepared.head
        || query.fromMs !== item.fromMs || query.toMs !== item.toMs
        || (query.scope ?? 'account') !== item.scope) throw expired()
    return Object.freeze({ ok: true, verified: item.verified,
      ...structuredClone(selectMetricsPage(item.prepared, query, limit)) })
  }
  function first(entries, query, limit, usage, verified, byteLength) {
    const prepared = prepareMetricsRecords(entries, query, usage)
    // Larger histories keep the complete legacy paging path; this is a cache
    // bound, never a row truncation or a claim of complete limited coverage.
    if (query.before !== undefined || byteLength > MAX_SNAPSHOT_BYTES || entries.length > MAX_SNAPSHOT_ROWS) {
      return Object.freeze({ ok: true, verified, ...selectMetricsPage(prepared, query, limit) })
    }
    prune()
    const snapshot = crypto.randomBytes(16).toString('hex')
    const item = { prepared, verified, principal: query.principal,
      fromMs: query.fromMs, toMs: query.toMs, scope: query.scope ?? 'account',
      expiresAt: now() + SNAPSHOT_TTL_MS }
    while (snapshots.size >= MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value)
    snapshots.set(snapshot, item)
    return Object.freeze({ ok: true, verified,
      ...structuredClone(selectMetricsPage(prepared, { ...query, snapshot }, limit)) })
  }
  return { read, first, size: () => { prune(); return snapshots.size },
    clear: () => { const count = snapshots.size; snapshots.clear(); return count } }
}

module.exports = { createMetricsSnapshots, MAX_SNAPSHOTS, MAX_SNAPSHOT_ROWS, MAX_SNAPSHOT_BYTES, SNAPSHOT_TTL_MS }
