export const METRICS_VIEW_KEY = 'mc.metrics.view'
export const METRICS_SCOPE_KEY = 'mc.metrics.scope'

export function readMetricsScope(storage = globalThis.localStorage) {
  try { return storage?.getItem(METRICS_SCOPE_KEY) === 'computer' ? 'computer' : 'account' }
  catch { return 'account' }
}

export function saveMetricsScope(scope, storage = globalThis.localStorage) {
  if (!['account', 'computer'].includes(scope)) return false
  try { storage?.setItem(METRICS_SCOPE_KEY, scope); return true }
  catch { return false }
}

export function readMetricsPreferences(storage = globalThis.localStorage) {
  let raw
  try { raw = JSON.parse(storage?.getItem(METRICS_VIEW_KEY)) } catch { /* Defaults remain usable. */ }
  return {
    range: ['24h', '7d', '30d'].includes(raw?.range) ? raw.range : '24h',
    outcome: ['all', 'started', 'refused', 'unrecorded'].includes(raw?.outcome) ? raw.outcome : 'all',
    order: raw?.order === 'oldest' ? 'oldest' : 'newest',
  }
}

export function saveMetricsPreferences(value, storage = globalThis.localStorage) {
  try {
    storage?.setItem(METRICS_VIEW_KEY, JSON.stringify({ v: 1, range: value.range, outcome: value.outcome, order: value.order }))
    return true
  } catch { return false }
}
