// One explicit draft broker fixture, independent of hidden strategy rules.
// Existing tickets fill before the completed-bar callback. A new submission
// processes prior cancellation requests; otherwise they settle after the bar.
// A new order cannot fill on its submission bar.
import { canonical, invariant, object } from './prompts.mjs'
import { createTradingRuntime } from './trading-runtime.mjs'
import { validateTradingIR } from './trading-ir.mjs'
import { observeTradingArtifacts, tradingObservationContract, TRADING_TAG_VERSION } from './trading-observations.mjs'

export function validateTradingMarket(ir, input) {
  validateTradingIR(ir)
  invariant(object(input) && Object.keys(input).every(key => ['execution', 'market', 'bars'].includes(key)), 'Declare operational execution, market and completed bars.')
  const market = input.market
  invariant(object(market) && Object.keys(market).every(key => ['version', 'kind', 'delayBars', 'maxFillQuantity'].includes(key))
    && market.version === 1 && market.kind === 'delayed-capped-equity'
    && Number.isSafeInteger(market.delayBars) && market.delayBars >= 1 && market.delayBars <= 10000
    && Number.isSafeInteger(market.maxFillQuantity) && market.maxFillQuantity >= 1 && market.maxFillQuantity <= 1000000, 'Declare the bounded delayed/capped equity fill fixture.')
  invariant(ir.execution.currency === 'USD' && ir.execution.cashCents > 0 && ir.execution.assets.every(asset => /^[A-Z][A-Z0-9.]{0,15}$/.test(asset.id) && asset.multiplier === 1 && asset.quantityStep === 1), 'This profile requires positive USD cash and unit whole-share equity assets.')
  invariant(Array.isArray(input.bars) && input.bars.length > 0 && input.bars.length <= Math.min(100000, ir.contract.barBudget), 'Declare the complete bounded market bar input.')
  const assets = new Set(ir.execution.assets.map(asset => asset.id))
  let previous = -1
  for (const bar of input.bars) {
    invariant(object(bar) && Object.keys(bar).every(key => ['time', 'prices'].includes(key)) && Number.isSafeInteger(bar.time) && bar.time >= 0 && bar.time <= 4102444800 && bar.time % 60 === 0 && bar.time > previous && object(bar.prices), 'Operational bars require ordered minute-aligned UTC seconds.')
    invariant(Object.entries(bar.prices).every(([asset, price]) => assets.has(asset) && (price === null || Number.isSafeInteger(price) && price > 0)) && Object.values(bar.prices).some(price => price !== null), 'An operational bar needs observed declared equity prices.')
    previous = bar.time
  }
  return input
}

export function simulateTradingMarket(ir, input) {
  validateTradingMarket(ir, input)
  const orders = {}, events = [], pending = new Map(), cancellations = [], paths = new Map(ir.nodes.map(node => [node.namespace, node.path]))
  let index = -1, serial = 0, runtime
  const emit = (ticket, status, quantity = 0, price = 0) => {
    const row = { orderId: ticket.native, orderEventId: ++ticket.serial, time: input.bars[index].time, status, symbolValue: ticket.intent.asset,
      quantity: ticket.order.quantity, fillQuantity: quantity, fillPrice: price / 100, fillPriceCurrency: 'USD', orderFeeAmount: 0, orderFeeCurrency: 'USD' }
    events.push(row); ticket.order.status = status
    if (status === 'cancelPending') return
    runtime.reconcile({ id: ticket.native + ':' + ticket.serial, intentId: ticket.intent.id, brokerOrderId: String(ticket.native), time: row.time,
      kind: ({ submitted: 'accepted', filled: 'fill', partiallyFilled: 'fill', canceled: 'cancelled' })[status],
      ...(quantity ? { quantity: Math.abs(quantity), priceCents: price, feeCents: 0 } : {}) })
  }
  const settleCancellations = () => {
    for (const id of cancellations.splice(0)) {
      const ticket = pending.get(id)
      invariant(ticket, 'A cancellation lost its native ticket before acknowledgment.')
      emit(ticket, 'canceled'); pending.delete(id)
    }
  }
  runtime = createTradingRuntime(ir, {
    dispatch(intent) {
      settleCancellations()
      const native = ++serial, order = { id: native, type: 0, securityType: 1, symbol: { value: intent.asset }, priceCurrency: 'USD',
        time: intent.time, quantity: intent.quantity * (intent.side === 'buy' ? 1 : -1), status: 'new',
        tag: canonical([TRADING_TAG_VERSION, paths.get(intent.owner), intent.lotId, intent.reason, intent.id]) }
      const ticket = { native, order, intent, created: index, serial: 0, filled: 0 }
      orders[native] = order; pending.set(intent.id, ticket); emit(ticket, 'submitted')
    },
    cancel(id) {
      invariant(pending.has(id), 'Simulation cancellation has no pending native order.')
      emit(pending.get(id), 'cancelPending'); cancellations.push(id)
    },
  })
  for (const bar of input.bars) {
    index++
    for (const [id, ticket] of pending) {
      const price = bar.prices[ticket.intent.asset]
      if (index - ticket.created < input.market.delayBars || price === null || price === undefined) continue
      const quantity = Math.min(input.market.maxFillQuantity, ticket.intent.quantity - ticket.filled)
      ticket.filled += quantity
      emit(ticket, ticket.filled === ticket.intent.quantity ? 'filled' : 'partiallyFilled', quantity * (ticket.intent.side === 'buy' ? 1 : -1), price)
      if (ticket.filled === ticket.intent.quantity) pending.delete(id)
    }
    runtime.step(bar)
    settleCancellations()
  }
  return { observation: observeTradingArtifacts(tradingObservationContract(ir, input), orders, events), snapshot: runtime.snapshot() }
}
