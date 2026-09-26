// Candidate observations come only from retained native orders and events.
// Tags declare attribution; private inventory is reconstructed from fills.
// Controller snapshots, printed traces and internal reservations are not inputs.
import { canonical, invariant, object } from './prompts.mjs'
import { executionCents } from './execution-lean.mjs'

export const TRADING_TAG_VERSION = 'LB-OP-1'
const terminal = status => ['filled', 'cancelled', 'rejected'].includes(status)
const integer = value => Number.isSafeInteger(value) && value >= 0
const label = value => typeof value === 'string' && value.trim() && value.length <= 240
const exact = value => { invariant(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), 'Native observation arithmetic exceeds the exact nonnegative range.'); return Number(value) }
const statusName = value => ({ 0: 'new', 1: 'accepted', 2: 'partial', 3: 'filled', 5: 'cancelled', 6: 'none', 7: 'rejected', 8: 'cancel-pending',
  submitted: 'accepted', partiallyfilled: 'partial', canceled: 'cancelled', cancelled: 'cancelled', invalid: 'rejected', cancelpending: 'cancel-pending',
  accepted: 'accepted', partial: 'partial', filled: 'filled', rejected: 'rejected', new: 'new', none: 'none' })[String(value).toLowerCase().replace(/[_ -]/g, '')]
const seconds = value => typeof value === 'number' ? value : Date.parse(value) / 1000

export function tradingObservationContract(ir, input) {
  return { version: 1, currency: ir.execution.currency, cashCents: ir.execution.cashCents,
    assets: ir.execution.assets, limits: ir.execution.limits,
    owners: ir.nodes.filter(node => node.kind === 'strategy').map(node => ({ path: node.path, asset: node.asset })),
    bars: input.bars, market: input.market }
}

export function observeTradingArtifacts(contract, orders, events) {
  invariant(object(orders) && Array.isArray(events), 'Retain native operational orders and events.')
  invariant(Object.keys(orders).length <= contract.limits.intents && events.length <= contract.limits.events, 'Native orders or events exceed the frozen resource budget.')
  const times = new Set(contract.bars.map(bar => bar.time)), owners = new Map(contract.owners.map(owner => [owner.path, owner.asset]))
  const bound = new Map(), identifiers = new Set(), lotsByOwner = new Map(), lots = [], normalized = []
  const source = Object.values(orders).sort((a, b) => Number(a.id ?? a.Id) - Number(b.id ?? b.Id))
  let previous = -1
  for (const order of source) {
    const id = order.id ?? order.Id, time = seconds(order.createdTime ?? order.CreatedTime ?? order.time ?? order.Time)
    invariant(integer(id) && id > 0 && !bound.has(id) && times.has(time) && time >= previous, 'Native order identity or creation chronology is invalid.'); previous = time
    const tag = JSON.parse(order.tag ?? order.Tag ?? 'null')
    invariant(Array.isArray(tag) && tag.length === 5 && tag[0] === TRADING_TAG_VERSION && owners.has(tag[1]) && label(tag[2]) && label(tag[4]) && !identifiers.has(tag[4]), 'A native order needs a unique operational attribution tag.')
    identifiers.add(tag[4])
    const [, owner, lotLabel, reason] = tag, asset = order.symbol?.value ?? order.Symbol?.Value, quantity = Number(order.quantity ?? order.Quantity)
    invariant(asset === owners.get(owner) && Number.isSafeInteger(quantity) && quantity !== 0 && Number(order.type ?? order.Type) === 0
      && Number(order.securityType ?? order.SecurityType) === 1 && (order.priceCurrency ?? order.PriceCurrency) === contract.currency, 'A native operational order changed its equity asset, quantity, type or currency.')
    invariant(quantity > 0 ? reason === 'entry' : ['exit', 'reset', 'gate-close', 'race-release'].includes(reason), 'A native order has an invalid side/reason attribution.')
    if (!lotsByOwner.has(owner)) lotsByOwner.set(owner, new Map())
    const local = lotsByOwner.get(owner)
    if (quantity > 0) {
      invariant(!local.has(lotLabel), 'Each native entry must open a new private lot label.')
      const lot = { owner, lot: local.size + 1, asset, boughtQuantity: 0, soldQuantity: 0, quantity: 0, firstFillTime: null, lastFillTime: null }
      local.set(lotLabel, lot); lots.push(lot)
    }
    const lot = local.get(lotLabel), status = statusName(order.status ?? order.Status)
    invariant(lot && status, 'A native exit has no earlier private entry, or an unsupported final status.')
    const row = { order: normalized.length + 1, owner, lot: lot.lot, asset, time, quantity, reason, status, filledQuantity: 0, feesCents: 0, unfilledQuantity: Math.abs(quantity), pending: !terminal(status) }
    bound.set(id, { row, lot, status: 'new', seen: false, lastEventId: -1 }); normalized.push(row)
  }
  let cash = BigInt(contract.cashCents), fees = 0n
  const receipts = [], identities = new Set(), positions = new Map(contract.assets.map(asset => [asset.id, 0n]))
  previous = -1
  for (const event of events) {
    const id = event.orderId ?? event.OrderId, serial = event.orderEventId ?? event.OrderEventId, binding = bound.get(id)
    invariant(binding && integer(serial) && serial > binding.lastEventId && !identities.has(id + ':' + serial), 'A native event has no order or repeats/reorders an event identity.')
    identities.add(id + ':' + serial); binding.lastEventId = serial
    const { row, lot } = binding, time = seconds(event.time ?? event.Time ?? event.utcTime ?? event.UtcTime), status = statusName(event.status ?? event.Status)
    invariant(times.has(time) && time >= previous && time >= row.time && status, 'Native event time or status is outside the frozen contract.'); previous = time
    invariant((event.symbolValue ?? event.SymbolValue) === row.asset && !event.isAssignment && !event.IsAssignment, 'Native event asset or assignment differs from the equity contract.')
    invariant(event.quantity === undefined || Number(event.quantity) === row.quantity, 'A native order was updated after submission.')
    const quantity = Number(event.fillQuantity ?? event.FillQuantity), rawFee = event.orderFeeAmount ?? event.OrderFeeAmount
    const receipt = { order: row.order, time, status, quantity: 0, priceCents: 0, feeCents: 0 }
    invariant(!terminal(binding.status) || status === 'accepted', 'A terminal native order received another state transition.')
    if (status === 'partial' || status === 'filled') {
      invariant(Number.isSafeInteger(quantity) && quantity !== 0 && (quantity > 0) === (row.quantity > 0), 'A native fill has an invalid quantity or side.')
      invariant((event.fillPriceCurrency ?? event.FillPriceCurrency) === contract.currency && rawFee !== undefined && (event.orderFeeCurrency ?? event.OrderFeeCurrency) === contract.currency, 'A native fill omitted or changed its explicit price/fee currency.')
      const priceCents = executionCents(event.fillPrice ?? event.FillPrice), feeCents = executionCents(rawFee), gross = BigInt(Math.abs(quantity)) * BigInt(priceCents)
      invariant(priceCents > 0, 'A native fill requires a positive price.')
      row.filledQuantity = exact(BigInt(row.filledQuantity) + BigInt(Math.abs(quantity)))
      invariant(status === 'filled' ? row.filledQuantity === Math.abs(row.quantity) : row.filledQuantity < Math.abs(row.quantity), 'A native fill status differs from its accumulated quantity.')
      if (quantity > 0) { lot.boughtQuantity = exact(BigInt(lot.boughtQuantity) + BigInt(quantity)); lot.firstFillTime ??= time; cash -= gross + BigInt(feeCents) }
      else { lot.soldQuantity = exact(BigInt(lot.soldQuantity) - BigInt(quantity)); cash += gross - BigInt(feeCents) }
      lot.quantity = exact(BigInt(lot.quantity) + BigInt(quantity)); lot.lastFillTime = time
      positions.set(row.asset, positions.get(row.asset) + BigInt(quantity))
      row.feesCents = exact(BigInt(row.feesCents) + BigInt(feeCents)); fees += BigInt(feeCents); exact(cash)
      Object.assign(receipt, { quantity, priceCents, feeCents }); binding.status = status
    } else {
      invariant(quantity === 0 && (rawFee === undefined || executionCents(rawFee) === 0), 'A non-fill event carries inventory or fees.')
      if (status !== 'accepted' || binding.status === 'new') binding.status = status
    }
    binding.seen = true; receipts.push(receipt)
  }
  for (const { row, status, seen } of bound.values()) {
    invariant(seen && row.status === status, 'Final native order status disagrees with its retained event history.')
    row.unfilledQuantity -= row.filledQuantity
  }
  const prices = new Map()
  for (const bar of contract.bars) for (const [asset, price] of Object.entries(bar.prices)) if (price !== null) prices.set(asset, price)
  const finalPositions = contract.assets.map(({ id: asset }) => ({ asset, quantity: exact(positions.get(asset)) }))
  const endEquity = finalPositions.reduce((equity, position) => {
    invariant(!position.quantity || prices.has(position.asset), 'Native inventory has no frozen final valuation.')
    return equity + BigInt(position.quantity) * BigInt(prices.get(position.asset) || 0)
  }, cash)
  return JSON.parse(canonical({ format: 'lean-operational-observation', version: 1, orders: normalized, events: receipts, lots,
    cashFromFillsCents: exact(cash), positionsFromFills: finalPositions, feesCents: exact(fees), equityCents: { start: contract.cashCents, end: exact(endEquity) } }))
}

export function nativeTradingObservation(result, events, task) {
  const state = result.state ?? result.State, orders = result.orders ?? result.Orders
  invariant(state && (state.Status ?? state.status) === 'Completed' && !(state.RuntimeError || state.runtimeError || result.RuntimeError || result.runtimeError), 'LEAN did not complete the operational backtest without a runtime error.')
  invariant(events !== null || object(orders) && Object.keys(orders).length === 0, 'Native operational events are missing.')
  const observation = observeTradingArtifacts(tradingObservationContract(task.compiled.operational, task.input), orders, events || [])
  const portfolio = result.totalPerformance?.portfolioStatistics
  invariant(result.algorithmConfiguration?.accountCurrency === 'USD' && portfolio
    && executionCents(portfolio.startEquity) === observation.equityCents.start && executionCents(portfolio.endEquity) === observation.equityCents.end,
  'Native starting or ending equity differs from the frozen cash and actual fills.')
  return observation
}
