// Pure source extraction and native observation normalization shared by execution and audit.
import { invariant, object } from './prompts.mjs'
import { declareExtractionPolicy, extractSource } from './extraction.mjs'
import { nativeTradingObservation } from './trading-observations.mjs'

// Recognize the normalized observation profile only. Raw native evidence is
// still reconstructed by nativeObservation; this is not execution proof.
export function matchesNativeObservationProfile(trace, operational) {
  return operational ? object(trace) && trace.format === 'lean-operational-observation' && trace.version === 1 : Array.isArray(trace)
}

// Lean Bench's extraction rule, declared rather than hardcoded. It is the
// reference plugin's answer to the core extraction contract: one Python program,
// either bare or as the reply's single fenced block, and nothing else. A third
// party declares its own policy instead of inheriting this one.
export const LEAN_EXTRACTION_POLICY = declareExtractionPolicy({
  mode: 'fenced', language: 'python', label: 'Python', pick: 'only', prose: 'refuse',
  maxBytes: 1024 * 1024, sizeLabel: '1 MiB',
  note: 'Lean Bench requires the whole reply to be one Python program.'
})

// The failure taxonomy is core vocabulary now; re-exported so existing callers
// and the exported runtime keep their import sites.
export { SOURCE_FORMAT_VIOLATION, SOURCE_NO_PROGRAM, sourceFailureClassification } from './extraction.mjs'

export function pythonSource(output) {
  return extractSource(output, LEAN_EXTRACTION_POLICY)
}

export function normalizeOrderEvents(events, orders, task) {
  invariant(Array.isArray(events) && orders && typeof orders === 'object', 'LEAN did not retain native order events and orders.')
  const timestamps = new Map(task.input.bars.map((bar, index) => [Date.parse(bar.time) / 1000, index]))
  const paths = new Map(), stack = [task.compiled.semantic]
  while (stack.length) { const node = stack.pop(); if (node.kind === 'strategy') paths.set(node.path, node.symbol); else stack.push(...node.childOrder.map(key => node.children[key])) }
  const trace = []
  for (const event of events) {
    const status = String(event.status ?? event.Status).toLowerCase().replace(/[_ ]/g, '')
    if (status === 'partiallyfilled' || status === '2') throw new Error('Partial fills are outside the frozen constitution.')
    if (status !== 'filled' && status !== '3') continue
    const id = event.orderId ?? event.OrderId, order = orders[id] || Object.values(orders).find(row => (row.id ?? row.Id) === id)
    invariant(order, 'A native fill has no matching order.')
    const tag = order.tag ?? order.Tag, match = typeof tag === 'string' && /^(root(?:\/[a-z][a-z0-9_-]*)*)\|(buy|sell|reset)$/.exec(tag)
    invariant(match && paths.has(match[1]), 'A filled order has no valid private strategy tag.')
    const symbol = event.symbolValue ?? event.SymbolValue ?? event.symbol?.value ?? event.symbol?.Value ?? event.symbol ?? event.Symbol?.Value ?? event.Symbol
    invariant(symbol === paths.get(match[1]), 'A filled order used the wrong strategy symbol.')
    const quantity = Number(event.fillQuantity ?? event.FillQuantity), priceCents = exactCents(event.fillPrice ?? event.FillPrice)
    invariant(Number.isSafeInteger(quantity) && quantity !== 0, 'A fill has unsupported fractional shares.')
    invariant(Number(order.quantity ?? order.Quantity) === quantity, 'A native fill does not fill its whole order.')
    invariant(Number(order.type ?? order.Type) === 0, 'The frozen constitution requires native market orders.')
    invariant(Number(event.orderFeeAmount ?? event.OrderFeeAmount ?? 0) === 0, 'The frozen constitution requires zero order fees.')
    invariant((event.fillPriceCurrency ?? event.FillPriceCurrency ?? 'USD') === 'USD', 'The frozen constitution requires USD prices.')
    const timestamp = event.utcTime ?? event.UtcTime ?? event.time ?? event.Time
    const seconds = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp) / 1000
    invariant(timestamps.has(seconds), 'A fill occurred outside the frozen completed-bar timestamps.')
    trace.push({ bar: timestamps.get(seconds), path: match[1], symbol, quantity, priceCents, reason: match[2] })
  }
  return trace
}
function exactCents(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(value))
  invariant(match, 'A fill has unsupported sub-cent pricing.')
  const exponent = Number(match[3] || 0) + 2 - (match[2] || '').length
  invariant(Number.isSafeInteger(exponent) && Math.abs(exponent) <= 100, 'A fill price exceeds the exact integer range.')
  const digits = BigInt(match[1] + (match[2] || '')), scale = 10n ** BigInt(Math.abs(exponent))
  invariant(exponent >= 0 || digits % scale === 0n, 'A fill has unsupported sub-cent pricing.')
  const cents = exponent >= 0 ? digits * scale : digits / scale
  invariant(cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER), 'A fill price exceeds the exact integer range.')
  return Number(cents)
}
export function nativeObservation(result, events, task) {
  if (task.compiled.operational) return nativeTradingObservation(result, events, task)
  const orders = result.Orders || result.orders, state = result.state || result.State
  invariant(state && !state.RuntimeError && !state.runtimeError && !result.RuntimeError && !result.runtimeError, 'LEAN reported an algorithm runtime error or omitted its final state.')
  invariant((state.Status ?? state.status) === 'Completed', 'LEAN did not complete the declared backtest.')
  invariant(events !== null || (orders && Object.keys(orders).length === 0), 'LEAN did not produce native order-event artifacts for its orders.')
  return normalizeOrderEvents(events || [], orders, task)
}

export function leanConfig(id) {
  return {
    environment: 'backtesting', 'algorithm-type-name': 'FrozenBenchmark', 'algorithm-language': 'Python',
    'algorithm-location': '/Algorithm/main.py', 'algorithm-id': id, 'data-folder': '/Data',
    'results-destination-folder': '/Results', 'log-file-name': '/Results/engine.log',
    debugging: false, 'debug-mode': false, 'close-automatically': true,
    'log-handler': 'QuantConnect.Logging.CompositeLogHandler', 'messaging-handler': 'QuantConnect.Messaging.Messaging',
    'job-queue-handler': 'QuantConnect.Queues.JobQueue', 'api-handler': 'QuantConnect.Api.Api',
    'map-file-provider': 'QuantConnect.Data.Auxiliary.LocalDiskMapFileProvider',
    'factor-file-provider': 'QuantConnect.Data.Auxiliary.LocalDiskFactorFileProvider',
    'data-provider': 'QuantConnect.Lean.Engine.DataFeeds.DefaultDataProvider', 'data-channel-provider': 'DataChannelProvider',
    'object-store': 'QuantConnect.Lean.Engine.Storage.LocalObjectStore', 'object-store-root': '/Results/storage',
    'data-aggregator': 'QuantConnect.Lean.Engine.DataFeeds.AggregationManager', 'job-user-id': '0', 'api-access-token': '', 'job-organization-id': '',
    'python-additional-paths': ['/Algorithm'], 'show-missing-data-logs': true,
    environments: { backtesting: { 'live-mode': false, 'setup-handler': 'QuantConnect.Lean.Engine.Setup.BacktestingSetupHandler',
      'result-handler': 'QuantConnect.Lean.Engine.Results.BacktestingResultHandler', 'data-feed-handler': 'QuantConnect.Lean.Engine.DataFeeds.FileSystemDataFeed',
      'real-time-handler': 'QuantConnect.Lean.Engine.RealTime.BacktestingRealTimeHandler',
      'history-provider': ['QuantConnect.Lean.Engine.HistoricalData.SubscriptionDataReaderHistoryProvider'],
      'transaction-handler': 'QuantConnect.Lean.Engine.TransactionHandlers.BacktestingTransactionHandler' } },
  }
}

// The docker arguments of one native execution. Host paths and the container name
// are parameters; their defaults are the placeholders a grade record keeps, so a
// recorded argument list carries no host path and verify-native rebuilds it exactly.
export function leanContainerArguments({ projectSha256, image, name = '<container>', algorithm = '<algorithm>', data = '<data>', results = '<results>', config = '<config>' }) {
  return ['run', '--pull', 'never', '--rm', '--name', name, '--label', `research-benchmark.project=${projectSha256}`, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '2g', '--cpus', '2', '--read-only', '--tmpfs', '/tmp:rw,size=256m', '-e', 'PYTHONDONTWRITEBYTECODE=1',
    '--mount', `type=bind,source=${algorithm},target=/Algorithm,readonly`, '--mount', `type=bind,source=${data},target=/Data,readonly`,
    '--mount', `type=bind,source=${results},target=/Results`, '--mount', `type=bind,source=${config},target=/Config/config.json,readonly`, image, '--config', '/Config/config.json']
}
export function leanContainerRecord({ projectSha256, image }) {
  return { engine: 'docker', arguments: leanContainerArguments({ projectSha256, image }) }
}
