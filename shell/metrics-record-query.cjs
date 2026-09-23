'use strict'

// A Metrics request pages a fixed time window before the ordinary history tail
// is taken. The host supplies principal; the renderer may never choose it.
const DAY = 86400000
function validateMetricsQuery(query) {
  return query && typeof query === 'object' && !Array.isArray(query)
    && Object.keys(query).every(key => ['fromMs', 'toMs', 'before', 'head', 'scope'].includes(key))
    && (query.scope === undefined || ['account', 'computer'].includes(query.scope))
    && Number.isSafeInteger(query.fromMs) && Number.isSafeInteger(query.toMs)
    && query.fromMs >= 0 && query.toMs > query.fromMs && query.toMs - query.fromMs <= 32 * DAY
    && (query.before === undefined || (Number.isSafeInteger(query.before) && query.before > 0))
    && (query.head === undefined || (Number.isSafeInteger(query.head) && query.head >= 0))
}

function selectMetricsRecords(entries, { principal, ...query }, limit, usage = false) {
  if (!validateMetricsQuery(query) || !/^(account:[0-9a-f]{32}|unauthenticated)$/.test(principal)) {
    throw Object.assign(new Error('The metrics window could not be read.'), { code: 'METRICS_QUERY_INVALID' })
  }
  const head = query.head ?? entries.reduce((max, entry) => Math.max(max, entry.sequence), 0)
  const snapshot = entries.filter(entry => entry.sequence <= head)
  const owns = entry => query.scope === 'computer' || entry.principal === principal
    || (principal === 'unauthenticated' && entry.principal === null)
  const inPeriod = entry => { const at = Date.parse(entry.at); return at >= query.fromMs && at < query.toMs }
  const all = snapshot.filter(entry => owns(entry) && inPeriod(entry)
    && (usage ? entry.action === 'agent_turn_usage' && entry.usage !== null : entry.action === 'agent_session_start'))
    .sort((a, b) => b.sequence - a.sequence)
  const eligible = all.filter(entry => query.before === undefined || entry.sequence < query.before)
  const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 200
  const page = eligible.slice(0, size)
  const outcomes = new Map()
  if (!usage) {
    const starts = new Map(all.map(entry => [entry.sequence, entry]))
    // Outcomes belong to the start they resolve, even if sign-in changed while
    // the process was starting. A different session cannot resolve that start.
    for (const entry of snapshot) {
      const start = starts.get(entry.outcome?.resolves)
      if (entry.action === 'agent_session_outcome' && start && start.sessionId === entry.sessionId
          && Date.parse(entry.at) < query.toMs && !outcomes.has(start.sequence)) outcomes.set(start.sequence, entry)
    }
  }
  const selected = usage ? page : page.flatMap(entry => outcomes.has(entry.sequence) ? [entry, outcomes.get(entry.sequence)] : [entry])
  return {
    entries: selected.sort((a, b) => b.sequence - a.sequence),
    total: usage ? all.length : all.length + outcomes.size,
    outcomes: usage ? null : {
      starts: all.length,
      started: [...outcomes.values()].filter(entry => entry.outcome.result === 'started').length,
      refused: [...outcomes.values()].filter(entry => entry.outcome.result === 'refused').length,
    },
    metrics: { v: 1, ...query, head, principal, count: all.length,
      nextBefore: eligible.length > page.length ? page.at(-1).sequence : null },
  }
}

module.exports = { validateMetricsQuery, selectMetricsRecords }
