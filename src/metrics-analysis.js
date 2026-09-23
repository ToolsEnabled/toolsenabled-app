import { LAUNCH_TIERS } from './orchestration-controls.js'
import { sessionTurnSucceeded } from './agent-session-events.js'
import { csvCell } from './metrics-history.js'

const known = value => Number.isSafeInteger(value) && value >= 0
/* A QUIET PANEL'S ONE LINE WHEN ITS RECORD DID NOT OPEN. Activity auditing
   being off is the person's own setting and the Basic default, so a reading
   that says `disabled` is never worded as a read fault ("could not be read").
   Every other unreadable reading keeps the sentence its panel already had. */
export const AUDIT_OFF_PANEL_NOTE = 'Activity auditing is off, so nothing is recorded here. Nothing is broken and saved history is preserved.'
export function quietRecordNote(reading, unreadableText) {
  return reading?.disabled === true ? AUDIT_OFF_PANEL_NOTE : unreadableText
}

export function metricShare(value) {
  if (!Number.isFinite(value)) return '—'
  if (value > 0 && value < .001) return '<0.1%'
  if (value > .999 && value < 1) return '>99.9%'
  return `${(value * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
}
export const TURN_SIZE_BINS = Object.freeze([
  { id: 'small', label: '<1k', min: 0, max: 1000 },
  { id: 'medium', label: '1–5k', min: 1000, max: 5000 },
  { id: 'large', label: '5–20k', min: 5000, max: 20000 },
  { id: 'larger', label: '20–50k', min: 20000, max: 50000 },
  { id: 'huge', label: '50–100k', min: 50000, max: 100000 },
  { id: 'largest', label: '100k+', min: 100000, max: Infinity },
].map(Object.freeze))

export function turnResult(status) {
  if (sessionTurnSucceeded(status)) return { key: 'success', label: 'Successful' }
  if (['error', 'failed', 'failure', 'cancelled', 'canceled', 'interrupted', 'aborted'].includes(status)) {
    return { key: 'problem', label: 'Reported a problem' }
  }
  return { key: 'unknown', label: 'Not recorded' }
}

// A composition must add back to the recorded total. Cache already inside
// input is subtracted before drawing the other-input segment. Reasoning is
// inside output and never added. Unreconciled totals remain a visible segment.
export function tokenComposition(turn) {
  if (!known(turn.totalTokens) || !known(turn.input) || !known(turn.output)) return null
  const read = known(turn.cachedInput) ? turn.cachedInput : 0
  const write = known(turn.cacheCreation) ? turn.cacheCreation : 0
  const inclusive = turn.input + turn.output === turn.totalTokens && read + write <= turn.input
  const exclusive = turn.input + read + write + turn.output === turn.totalTokens
  const basis = turn.inputBasis || (inclusive ? 'includes-cache' : exclusive ? 'excludes-cache' : null)
  if (basis === 'includes-cache' && inclusive) return { input: turn.input - read - write, read, write, output: turn.output }
  if (basis === 'excludes-cache' && exclusive) return { input: turn.input, read, write, output: turn.output }
  return null
}

export function usageAnalysis(turns = [], conversations = null) {
  const rows = turns.filter(turn => turn.basis !== 'session-total').map(turn => {
    const tier = LAUNCH_TIERS.find(row => row.id === turn.tier)
    return { ...turn, model: tier?.label || turn.tier || 'Not recorded', provider: tier?.provider || 'unrecorded',
      agent: conversations?.get(turn.sessionId)?.role || 'Not recorded',
      result: turnResult(turn.status),
      totalSource: known(turn.totalTokens) ? turn.reportedTotal ? 'Reported' : 'Derived' : 'Unknown' }
  })
  const values = rows.filter(row => known(row.totalTokens)).map(row => row.totalTokens).sort((a, b) => a - b)
  const bins = TURN_SIZE_BINS.map(bin => ({ ...bin, count: values.filter(value => value >= bin.min && value < bin.max).length }))
  // Median averages the middle pair. P90 uses the nearest-rank convention:
  // the smallest observed value covering at least 90% of measured turns.
  const middle = Math.floor(values.length / 2)
  const median = values.length ? values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2 : null
  const p90 = values.length ? values[Math.ceil(values.length * .9) - 1] : null
  const parts = { input: 0, read: 0, write: 0, output: 0, unclassified: 0 }
  let composed = 0, cacheTurns = 0, cached = 0, cacheInput = 0
  for (const row of rows) {
    if (!known(row.totalTokens)) continue
    const split = tokenComposition(row)
    if (!split) { parts.unclassified += row.totalTokens; continue }
    composed += 1
    for (const key of Object.keys(split)) parts[key] += split[key]
    if (known(row.cachedInput)) {
      cacheTurns += 1
      cached += split.read
      cacheInput += split.input + split.read + split.write
    }
  }
  return { rows, bins, median, p90, max: values.at(-1) ?? null, known: values.length, unknown: rows.length - values.length,
    reported: rows.filter(row => row.totalSource === 'Reported').length,
    derived: rows.filter(row => row.totalSource === 'Derived').length,
    parts, composed, total: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
    cache: { turns: cacheTurns, cached, input: cacheInput, share: cacheInput > 0 ? cached / cacheInput : null } }
}

export function selectUsageRows(rows, { query = '', size = 'all', result = 'all', order = 'largest' } = {}) {
  const needle = query.trim().toLocaleLowerCase()
  const bin = TURN_SIZE_BINS.find(bin => bin.id === size)
  return rows.filter(row => {
    if (result !== 'all' && row.result.key !== result) return false
    if (size === 'unknown' && known(row.totalTokens)) return false
    if (bin && !(known(row.totalTokens) && row.totalTokens >= bin.min && row.totalTokens < bin.max)) return false
    return !needle || [row.agent, row.model, row.account, row.turnId, row.sessionId, row.failure]
      .some(value => String(value ?? '').toLocaleLowerCase().includes(needle))
  }).sort((a, b) => {
    if (order === 'largest') {
      const amount = (known(b.totalTokens) ? b.totalTokens : -1) - (known(a.totalTokens) ? a.totalTokens : -1)
      if (amount) return amount
    }
    return (b.atMs ?? 0) - (a.atMs ?? 0) || (b.sequence ?? 0) - (a.sequence ?? 0)
  })
}

export function usageRowsCsv(rows, { example = false } = {}) {
  const data = [['Record', 'Turn', 'Session', 'Completed at (UTC)', 'Agent', 'Model', 'Sign-in', 'Result',
    'Total tokens', 'Total source', 'Input tokens (as recorded)', 'Input basis', 'Cached input', 'Cache creation', 'Output', 'Reasoning (within output)', 'Details', 'Source'],
  ...rows.map(row => [row.sequence, row.turnId, row.sessionId,
    Number.isFinite(row.atMs) ? new Date(row.atMs).toISOString() : '', row.agent, row.model, row.account, row.result.label,
    row.totalTokens, row.totalSource, row.input, row.inputBasis, row.cachedInput, row.cacheCreation, row.output, row.reasoning,
    row.failure, example ? 'Example data' : 'Recorded activity'])]
  return '\uFEFF' + data.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
