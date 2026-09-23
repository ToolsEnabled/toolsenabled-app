import { readLocalRuns, readLocalUsage } from './local-metrics.js'

// Bound each read, including source discovery. A late answer must not revive a
// timed-out or superseded view; the underlying IPC remains owned by the host.
export function withMetricsDeadline(read, { signal, timeoutMs = 15000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new TypeError('Choose a Metrics read deadline between 1 and 60000 milliseconds.')
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (complete, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      complete(value)
    }
    const refuse = code => finish(reject, Object.assign(new Error(code), { code }))
    const abort = () => refuse('METRICS_READ_CANCELLED')
    const timer = setTimeout(() => refuse('METRICS_READ_TIMEOUT'), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    Promise.resolve().then(() => settled ? undefined : read()).then(value => finish(resolve, value), error => finish(reject, error))
  })
}

/* AUDIT_NOT_ENABLED is the host's word for an audit that is switched off
   (owner direction 2026-09-20, T782 / BUG08): a normal state, kept as its own
   code so the projection can say so instead of "unavailable". */
const readFailureCode = result => {
  if (result?.ok === true) return null
  return ['METRICS_READ_TIMEOUT', 'METRICS_READ_CANCELLED', 'METRICS_ACCOUNT_CHANGED', 'AUDIT_NOT_ENABLED'].includes(result?.code)
    ? result.code : 'METRICS_READ_UNAVAILABLE'
}

// Read every page in one fixed 30-day snapshot. A legacy tail is insufficient:
// it cannot establish either account ownership or coverage of the date range.
export async function readMetricsRecords({ agent = globalThis.mcAgent, window, scope = 'account', cancelled = () => false, signal, requestTimeoutMs = 15000 } = {}) {
  const validScope = ['account', 'computer'].includes(scope)
  async function read(channel) {
    if (!validScope || typeof agent?.[channel] !== 'function') return { ok: false }
    let before, head, principal, count, verified = true, result
    const entries = []
    const sequences = new Set()
    let collected = 0
    do {
      if (cancelled() || signal?.aborted) return { ok: false, code: 'METRICS_READ_CANCELLED' }
      try {
        result = await withMetricsDeadline(() => agent[channel]({ limit: 200, metrics: {
          fromMs: window.startMs, toMs: window.endMs,
          ...(scope === 'computer' ? { scope } : {}),
          ...(before === undefined ? {} : { before, head }),
        } }), { signal, timeoutMs: requestTimeoutMs })
      } catch (error) { return { ok: false, code: error?.code, needsUpdate: /Unexpected agent IPC field: metrics/.test(error?.message || '') } }
      /* Auditing off is answered before any page is validated: there is no
         page, and the answer's own words travel to the readers below. */
      if (result?.ok === false && result.code === 'AUDIT_NOT_ENABLED') return { ok: false, code: 'AUDIT_NOT_ENABLED', reason: result.reason }
      const meta = result?.metrics
      if (scope === 'computer' && (result?.code === 'METRICS_QUERY_INVALID' || (result?.ok === true && meta?.scope === undefined))) return { ok: false, needsUpdate: true }
      if (result?.ok === true && meta?.v !== 1) return { ok: false, needsUpdate: true }
      if (result?.ok !== true || meta?.v !== 1 || !Array.isArray(result.entries)
          || meta.fromMs !== window.startMs || meta.toMs !== window.endMs
          || (meta.scope ?? 'account') !== scope
          || !/^(account:[0-9a-f]{32}|unauthenticated)$/.test(meta.principal)
          || !Number.isSafeInteger(meta.head) || meta.head < 0 || !Number.isSafeInteger(meta.count) || meta.count < 0
          || (principal !== undefined && (meta.principal !== principal || meta.head !== head || meta.count !== count))) return { ok: false }
      principal = meta.principal
      head = meta.head
      count = meta.count
      const primary = channel === 'history' ? 'agent_session_start' : 'agent_turn_usage'
      const pageRows = result.entries.filter(entry => entry?.action === primary)
      if (pageRows.length > 200 || result.entries.length > (channel === 'history' ? 400 : 200)) return { ok: false }
      for (const entry of result.entries) {
        const at = Date.parse(entry?.at)
        if (!Number.isSafeInteger(entry?.sequence) || entry.sequence <= 0 || entry.sequence > head
            || sequences.has(entry.sequence) || !Number.isFinite(at) || at >= window.endMs
            || typeof entry.sessionId !== 'string' || !entry.sessionId) return { ok: false }
        if (entry.action === primary) {
          if (at < window.startMs || (before !== undefined && entry.sequence >= before)) return { ok: false }
          if (channel === 'usage' && (!entry.usage || typeof entry.usage !== 'object' || Array.isArray(entry.usage))) return { ok: false }
        } else if (channel !== 'history' || entry.action !== 'agent_session_outcome'
            || !Number.isSafeInteger(entry.outcome?.resolves) || !['started', 'refused'].includes(entry.outcome?.result)) return { ok: false }
        sequences.add(entry.sequence)
      }
      collected += pageRows.length
      if (collected > count) return { ok: false }
      if (result.verified === false) verified = false
      else if (result.verified !== true && verified !== false) verified = null
      entries.push(...result.entries)
      const next = meta.nextBefore
      if (next !== null && (!Number.isSafeInteger(next) || next <= 0 || (before !== undefined && next >= before))) return { ok: false }
      if (next !== null && (!pageRows.length || next !== Math.min(...pageRows.map(entry => entry.sequence)))) return { ok: false }
      before = next
    } while (before !== null)
    const counted = channel === 'history' ? entries.filter(entry => entry.action === 'agent_session_start').length : entries.length
    if (counted !== count || new Set(entries.map(entry => entry.sequence)).size !== entries.length) return { ok: false }
    if (channel === 'history') {
      const starts = new Map(entries.filter(entry => entry.action === 'agent_session_start').map(entry => [entry.sequence, entry]))
      const resolved = new Set()
      for (const entry of entries.filter(entry => entry.action === 'agent_session_outcome')) {
        if (starts.get(entry.outcome.resolves)?.sessionId !== entry.sessionId || resolved.has(entry.outcome.resolves)) return { ok: false }
        resolved.add(entry.outcome.resolves)
      }
    }
    return { ...result, entries, verified, metrics: { ...result.metrics, principal } }
  }
  const [history, usage] = await Promise.all([read('history'), read('usage')])
  // A sign-in between the two reads must not assemble two people's records.
  if (history.ok && usage.ok && history.metrics.principal !== usage.metrics.principal) {
    return readMetricsRecords({ agent: null, window, scope })
  }
  const reader = { history: async () => history, usage: async () => usage }
  const [sessions, turns] = await Promise.all([readLocalRuns({ agent: reader }), readLocalUsage({ agent: reader })])
  return { sessions, usage: turns, principal: history.metrics?.principal || usage.metrics?.principal || null, scope,
    needsUpdate: history.needsUpdate === true || usage.needsUpdate === true,
    readErrors: { history: readFailureCode(history), usage: readFailureCode(usage) } }
}
