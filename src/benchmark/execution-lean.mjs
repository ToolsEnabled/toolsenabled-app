// Native artifact normalization for the private execution contract. Candidate
// logs cannot supply fill evidence; every reconciled receipt must match LEAN's
// own retained orders and OrderEvents. The caller supplies the reviewed intents.
import { canonical, invariant, object } from './prompts.mjs'
import { replayExecutionLedger } from './execution.mjs'

export const EXECUTION_TAG_VERSION = 'LB-EXEC-1'
const statusName = value => ({ 0: 'new', 1: 'submitted', 2: 'partiallyfilled', 3: 'filled', 5: 'canceled', 6: 'none', 7: 'invalid', 8: 'cancelpending', 9: 'updatesubmitted' }[value] || String(value).toLowerCase().replace(/[_ ]/g, ''))
const integer = value => Number.isSafeInteger(value) && value >= 0
export function executionCents(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(value))
  invariant(match, 'Native execution amount is not nonnegative decimal cents.')
  const exponent = Number(match[3] || 0) + 2 - (match[2] || '').length
  invariant(Number.isSafeInteger(exponent) && Math.abs(exponent) <= 100, 'Native execution amount exceeds the exact range.')
  const digits = BigInt(match[1] + (match[2] || '')), scale = 10n ** BigInt(Math.abs(exponent))
  invariant(exponent >= 0 || digits % scale === 0n, 'Native execution amount has sub-cent precision.')
  const cents = exponent >= 0 ? digits * scale : digits / scale
  invariant(cents <= BigInt(Number.MAX_SAFE_INTEGER), 'Native execution amount exceeds the exact range.')
  return Number(cents)
}

export function normalizeExecutionOrders(orders, intents) {
  invariant(object(orders) && Array.isArray(intents), 'Retain native orders and declared intents.')
  const declared = new Map(intents.map(intent => [intent.id, intent])), seen = new Set(), result = new Map()
  invariant(declared.size === intents.length, 'Declared intent identifiers repeat.')
  for (const order of Object.values(orders)) {
    const tag = JSON.parse(order.tag ?? order.Tag ?? 'null')
    invariant(Array.isArray(tag) && tag.length === 2 && tag[0] === EXECUTION_TAG_VERSION, 'A native order has no execution tag.')
    const intent = declared.get(tag[1]), id = order.id ?? order.Id
    invariant(intent && !seen.has(intent.id) && integer(id) && !result.has(String(id)), 'Native orders do not bind one-to-one to declared intents.')
    const symbol = order.symbol?.value ?? order.Symbol?.Value
    const signed = intent.quantity * (intent.side === 'buy' ? 1 : -1)
    invariant(symbol === intent.asset && Number(order.quantity ?? order.Quantity) === signed, 'A native order changed its declared asset or quantity.')
    invariant(Number(order.type ?? order.Type) === 0, 'The execution adapter requires native market orders.')
    const time = Date.parse(order.time ?? order.Time) / 1000
    invariant(integer(time) && time === intent.time, 'Native order creation differs from the intent time.')
    result.set(String(id), { intent, status: statusName(order.status ?? order.Status) }); seen.add(intent.id)
  }
  return result
}

export function normalizeExecutionEvents(events, orders, intents, currency) {
  invariant(Array.isArray(events), 'Retain native execution events.')
  const native = normalizeExecutionOrders(orders, intents), result = [], seen = new Set()
  let previous = -1
  for (const event of events) {
    const orderId = event.orderId ?? event.OrderId, eventId = event.orderEventId ?? event.OrderEventId
    const binding = native.get(String(orderId))
    invariant(binding && integer(orderId) && integer(eventId), 'A native event has no bound order or event identity.')
    const { intent } = binding, key = String(orderId) + ':' + eventId
    invariant(!seen.has(key), 'Native event identities repeat.'); seen.add(key)
    const timeValue = event.time ?? event.Time ?? event.utcTime ?? event.UtcTime
    const time = typeof timeValue === 'number' ? timeValue : Date.parse(timeValue) / 1000
    invariant(integer(time) && time >= previous && time >= intent.time, 'Native execution chronology is invalid.'); previous = time
    invariant((event.symbolValue ?? event.SymbolValue) === intent.asset && !event.isAssignment && !event.IsAssignment, 'Native fill asset or assignment differs from this contract.')
    const status = statusName(event.status ?? event.Status)
    const kind = ({ submitted: 'accepted', partiallyfilled: 'fill', filled: 'fill', canceled: 'cancelled', cancelled: 'cancelled', invalid: 'rejected' })[status]
    const quantity = Number(event.fillQuantity ?? event.FillQuantity), fee = event.orderFeeAmount ?? event.OrderFeeAmount
    if (kind !== 'fill') {
      invariant(quantity === 0 && (fee === undefined || executionCents(fee) === 0), 'A non-fill event carries unaccounted inventory or fees.')
      invariant(kind || ['new', 'none', 'cancelpending'].includes(status), 'Unsupported native execution status.')
      if (!kind) continue
    }
    const row = { id: key, intentId: intent.id, brokerOrderId: String(orderId), kind, time }
    if (kind === 'fill') {
      invariant(Number.isSafeInteger(quantity) && quantity !== 0 && (quantity > 0) === (intent.side === 'buy'), 'A native fill has an invalid quantity or side.')
      invariant((event.fillPriceCurrency ?? event.FillPriceCurrency) === currency && (event.orderFeeCurrency ?? event.OrderFeeCurrency) === currency, 'Native execution currency differs.')
      invariant(fee !== undefined, 'A native fill omitted its fee receipt.')
      Object.assign(row, { quantity: Math.abs(quantity), priceCents: executionCents(event.fillPrice ?? event.FillPrice), feeCents: executionCents(fee) })
    }
    result.push(row)
  }
  return result
}

export function verifyNativeExecution({ config, result, events, journal, actions }) {
  const state = result.state ?? result.State, orders = result.orders ?? result.Orders
  invariant(state && (state.Status ?? state.status) === 'Completed' && !(state.RuntimeError || state.runtimeError || result.RuntimeError || result.runtimeError), 'Native execution did not complete without a runtime error.')
  const declared = actions.filter(action => action.kind === 'intent').map(action => action.intent)
  const normalized = normalizeExecutionEvents(events, orders, declared, config.currency)
  const retained = journal.filter(row => row.kind === 'broker-event').map(row => { const { sequence, ...event } = row.event; return event })
  invariant(canonical(retained) === canonical(normalized), 'The execution journal does not match the complete native receipt history.')
  const decisions = journal.filter(row => row.kind !== 'broker-event').map(row => row.kind === 'intent'
    ? { kind: 'intent', intent: row.decision.intent } : { kind: 'cancel', intentId: row.event.intentId, time: row.event.time })
  invariant(canonical(decisions) === canonical(actions), 'The execution journal changed the declared action history.')
  const snapshot = replayExecutionLedger(config, journal).snapshot(), native = normalizeExecutionOrders(orders, declared)
  invariant(native.size === snapshot.tickets.length, 'Native orders and admitted private tickets differ.')
  const final = { submitted: 'accepted', partiallyfilled: 'partially-filled', filled: 'filled', canceled: 'cancelled', cancelled: 'cancelled', invalid: 'rejected' }
  for (const ticket of snapshot.tickets) {
    const binding = native.get(ticket.brokerOrderId)
    invariant(binding?.intent.id === ticket.id && (final[binding.status] === ticket.status || binding.status === 'cancelpending' && ticket.cancellationRequested && ['accepted', 'partially-filled'].includes(ticket.status)), 'A private ticket differs from the terminal native order state.')
  }
  // Check every partial/full status, including intermediate events.
  const filled = new Map()
  for (const event of events) {
    const status = statusName(event.status ?? event.Status)
    if (!['filled', 'partiallyfilled'].includes(status)) continue
    const id = String(event.orderId ?? event.OrderId), binding = native.get(id)
    const total = (filled.get(id) || 0) + Math.abs(Number(event.fillQuantity ?? event.FillQuantity)); filled.set(id, total)
    invariant(status === 'filled' ? total === binding.intent.quantity : total < binding.intent.quantity, 'Native fill status disagrees with its accumulated quantity.')
  }
  return snapshot
}
