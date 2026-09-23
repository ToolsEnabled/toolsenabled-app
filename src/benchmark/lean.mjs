import { combinations, invariant, object } from './prompts.mjs'

/* PROMPT B. The four parts THIS example's strategies are made of. They are the
   Lean catalog's own vocabulary, declared where that catalog is built rather
   than in the compiler, which now knows no role names at all. */
export const LEAN_STRATEGY_ROLES = Object.freeze(['buy_reason', 'buy_process', 'sell_reason', 'sell_process'])
const ROLES = LEAN_STRATEGY_ROLES
import { genericStarter } from './starters.mjs'
import { createExecutionLedger } from './execution.mjs'

export const LEAN_CONSTITUTION = `Draft deterministic equity constitution, version 1.
Evaluate each completed bar once in input order. Prices and cash are integer cents; quantities are whole shares. Orders fill fully at that bar's close with zero fees and slippage. Missing or nonpositive prices suppress that symbol's actions. Indicators require their full window of observed prices. Sells precede buys within a strategy; no same-bar re-entry. Each strategy owns private lots even when symbols overlap. Sibling order is the declared slot order; insufficient cash skips the entire purchase. Strategies complete after one full round trip. Partial exits sell at least one share. Parallel completes when all children complete. Sequence activates its next child on the following bar. Race assigns ownership to the first subtree that actually buys, with declared order breaking ties. A state gate blocks new entries while false but continues exits. An event gate opens once and remains open. Reset liquidates all owned lots when every held symbol has a price, clears subtree state, and permits reactivation on the next bar. Reset takes priority over ordinary actions. No implicit end-of-data liquidation. These rules must be reviewed before a counted study; they do not model partial fills, margin, shorts, options, fees, or live execution.`

function atom(id, role, text, semantics, parameters = {}) {
  return { id, version: '1', kind: 'atom', role, text, parameters, semantics, state: 'Private strategy state; no portfolio-wide ownership inference.',
    dependencies: ['constitution-v1'], hooks: { evaluate: 'See lean-reference.py and lean.mjs in the review packet.' },
    tests: ['Compare the included synthetic bars against independently recorded expected traces.'], review: null }
}
export function leanCatalog() {
  return [
    atom('below-price', 'buy_reason', 'Buy when the close is below {{threshold}} cents.', { kind: 'below', value: '{{threshold}}' }, { threshold: 10100 }),
    atom('above-price', 'buy_reason', 'Buy when the close is above {{threshold}} cents.', { kind: 'above', value: '{{threshold}}' }, { threshold: 9900 }),
    atom('cross-up', 'buy_reason', 'Buy when the close crosses from at or below to above {{threshold}} cents; require two observed prices.', { kind: 'cross_up', value: '{{threshold}}' }, { threshold: 10000 }),
    atom('above-average', 'buy_reason', 'Buy when the close exceeds its {{period}}-observation simple moving average, after a complete window.', { kind: 'above_sma', period: '{{period}}' }, { period: 3 }),
    atom('fixed-shares', 'buy_process', 'Buy {{quantity}} whole shares if the shared cash covers the entire order; otherwise skip it.', { kind: 'shares', quantity: '{{quantity}}' }, { quantity: 2 }),
    atom('cash-fraction', 'buy_process', 'Buy floor({{basisPoints}} / 10000 of currently available cash divided by the close), in whole shares.', { kind: 'cash_fraction', basisPoints: '{{basisPoints}}' }, { basisPoints: 2500 }),
    atom('exit-above', 'sell_reason', 'Sell when the close exceeds {{threshold}} cents.', { kind: 'above', value: '{{threshold}}' }, { threshold: 10500 }),
    atom('exit-below', 'sell_reason', 'Sell when the close falls below {{threshold}} cents.', { kind: 'below', value: '{{threshold}}' }, { threshold: 9500 }),
    atom('holding-period', 'sell_reason', 'Sell after at least {{bars}} input bars have elapsed since this strategy bought.', { kind: 'after', bars: '{{bars}}' }, { bars: 2 }),
    atom('sell-all', 'sell_process', 'Sell all shares privately owned by this strategy.', { kind: 'all' }),
    atom('sell-fraction', 'sell_process', 'Sell floor({{basisPoints}} / 10000 of this strategy’s own shares), with a minimum of one share, on each qualifying bar.', { kind: 'fraction', basisPoints: '{{basisPoints}}' }, { basisPoints: 5000 }),
    { id: 'strategy', version: '1', kind: 'template', role: 'node', parameters: { symbol: 'SPY' }, slots: Object.fromEntries(ROLES.map(role => [role, role])),
      text: 'Strategy for {{symbol}} (private lots, one round trip):\nBuy reason: {{slot:buy_reason}}\nBuy process: {{slot:buy_process}}\nSell reason: {{slot:sell_reason}}\nSell process: {{slot:sell_process}}', semantics: { kind: 'strategy', symbol: '{{symbol}}' } },
    ...['parallel', 'sequence', 'race'].map(kind => ({ id: kind, version: '1', kind: 'template', role: 'node', slots: { first: 'node', second: 'node' },
      text: `${kind.toUpperCase()} according to the constitution. First child:\n{{slot:first}}\nSecond child:\n{{slot:second}}`, semantics: { kind } })),
    ...['state_gate', 'event_gate'].map(kind => ({ id: kind.replace('_', '-'), version: '1', kind: 'template', role: 'node', parameters: { symbol: 'SPY', threshold: 9900 }, slots: { child: 'node' },
      text: `${kind === 'state_gate' ? 'State gate' : 'Latched event gate'}: {{symbol}} close must exceed {{threshold}} cents to permit new entries. Continue managing exits.\n{{slot:child}}`, semantics: { kind, symbol: '{{symbol}}', predicate: { kind: 'above', value: '{{threshold}}' } } })),
    { id: 'reset', version: '1', kind: 'template', role: 'node', parameters: { symbol: 'SPY', threshold: 9000 }, slots: { child: 'node' },
      text: 'Reset: when {{symbol}} closes below {{threshold}} cents, liquidate the subtree’s private lots together if all their prices are available; clear all state and wait until the next bar before entries.\n{{slot:child}}', semantics: { kind: 'reset', symbol: '{{symbol}}', predicate: { kind: 'below', value: '{{threshold}}' } } },
    { id: 'constitution-v1', version: '1', kind: 'template', role: 'node', slots: { strategy: 'node' },
      text: LEAN_CONSTITUTION + '\n\nImplement the following strategy tree as class FrozenBenchmark(QCAlgorithm) in QuantConnect LEAN Python. Follow the response format in the execution appendix. Submit native market orders with each order tag exactly <compiled strategy path>|buy, |sell or |reset. The execution appendix supplies compiled paths, UTC bar-close timestamps and integer-cent inputs. Grading reads actual engine OrderEvents and order tags; printed or logged traces do not count as fills.\n\n{{slot:strategy}}', semantics: { kind: 'constitution' },
      state: 'Integer-cents shared cash and per-node private whole-share lots.', dependencies: [], hooks: { runtime: 'lean-reference.py', independentInterpreter: 'lean.mjs' }, tests: ['Flat, shared-symbol, nested sequence/race, gates, reset, cash-contention, missing-price and mutation controls.'] },
  ]
}
export function strategyRef(roles = {}, symbol = 'SPY') {
  const defaults = { buy_reason: 'below-price', buy_process: 'fixed-shares', sell_reason: 'exit-above', sell_process: 'sell-all' }
  return { use: 'strategy', params: { symbol }, slots: Object.fromEntries(ROLES.map(role => [role, { use: roles[role] || defaults[role] }])) }
}
export function generateLeanTasks(choices, { wrapper = null, symbol = 'SPY', input, split = 'development' } = {}) {
  return combinations(Object.fromEntries(ROLES.map(role => [role, choices[role]]))).map((roles, index) => {
    const leaf = strategyRef(roles, symbol)
    const root = { use: 'constitution-v1', slots: { strategy: wrapper ? { use: wrapper, slots: { first: leaf, second: strategyRef(roles, symbol) } } : leaf } }
    return { id: `strategy-${index + 1}`, root, input: structuredClone(input), expected: null, split }
  })
}
export function leanStarter() {
  const base = genericStarter()
  const bars = [10000, 9800, 10700, 9900, 10800].map((price, index) => ({ time: `2024-01-02T14:${String(31 + index).padStart(2, '0')}:00Z`, prices: { SPY: price } }))
  const expected = [
    { bar: 0, path: 'root/strategy', symbol: 'SPY', quantity: 2, priceCents: 10000, reason: 'buy' },
    { bar: 2, path: 'root/strategy', symbol: 'SPY', quantity: -2, priceCents: 10700, reason: 'sell' },
  ]
  return { ...base, id: 'lean-bench-study', name: 'Lean Bench', domain: 'lean-bench', requireReview: true, catalog: leanCatalog(),
    tasks: [{ id: 'flat-canary', root: { use: 'constitution-v1', slots: { strategy: strategyRef() } }, input: { cashCents: 1000000, bars }, expected, split: 'development' }],
    conditions: [{ id: 'recorded', label: 'Known trace canary', model: { provider: 'fixture', id: 'flat-canary-v1', settings: {} }, adapter: { kind: 'replay', responses: { 'flat-canary': expected } } }],
    protocol: { ...base.protocol, grading: { kind: 'json' } },
    environment: { node: '>=22', python: '>=3.10', dependencies: [], leanImage: '', instructions: 'Pin the LEAN image digest and data manifest for real engine execution. The recorded-response canary checks deterministic grading; it does not execute an LLM or the LEAN engine.' },
    decisions: 'Draft semantic constitution and starter atoms await personal review. Establish the input data, execution environment, activation and mutation controls, study split, and scoring before counted research.' }
}

export function validateLean(root, input) {
  invariant(object(input) && Number.isSafeInteger(input.cashCents) && input.cashCents > 0, 'Lean input needs a positive integer cashCents balance.')
  invariant(Array.isArray(input.bars) && input.bars.length && input.bars.length <= 100000, 'Lean input needs 1–100,000 ordered bars.')
  let previous = -Infinity
  for (const bar of input.bars) {
    const at = Date.parse(bar.time)
    invariant(Number.isFinite(at) && at > previous && object(bar.prices), 'Lean bars need strictly increasing timestamps and a prices object.')
    invariant(Object.keys(bar.prices).every(validSymbol), 'Lean price keys must be ticker symbols.')
    invariant(Object.values(bar.prices).every(price => price === null || (Number.isSafeInteger(price) && price > 0)), 'Prices must be positive integer cents or null for missing data.')
    previous = at
  }
  const nodes = [root]
  while (nodes.length) {
    const node = nodes.pop(), children = (node.childOrder || Object.keys(node.children || {})).map(key => node.children[key])
    invariant(['constitution', 'strategy', 'parallel', 'sequence', 'race', 'state_gate', 'event_gate', 'reset'].includes(node.kind), `Unsupported Lean operator ${node.kind}.`)
    if (node.kind === 'strategy') {
      invariant(validSymbol(node.symbol), 'A strategy needs a ticker symbol.')
      invariant(ROLES.every(role => node.children?.[role]), 'A Lean strategy needs all four semantic roles.')
      for (const role of ['buy_reason', 'sell_reason']) validatePredicate(node.children[role])
      const buy = node.children.buy_process, sell = node.children.sell_process
      invariant((buy.kind === 'shares' && Number.isSafeInteger(buy.quantity) && buy.quantity > 0 && buy.quantity <= 1000000)
        || (buy.kind === 'cash_fraction' && validBps(buy.basisPoints)), 'Buy process must specify positive whole shares or 1–10,000 cash basis points.')
      invariant(sell.kind === 'all' || (sell.kind === 'fraction' && validBps(sell.basisPoints)), 'Sell process must specify all shares or 1–10,000 basis points.')
    } else {
      invariant(children.length >= 1 && children.length <= 4, 'A Lean template needs 1–4 children.')
      if (['state_gate', 'event_gate', 'reset'].includes(node.kind)) { invariant(validSymbol(node.symbol), 'A gate needs a ticker symbol.'); validatePredicate(node.predicate) }
      nodes.push(...children)
    }
  }
}
function validSymbol(value) { return typeof value === 'string' && /^[A-Z][A-Z0-9.]{0,19}$/.test(value) }
function validBps(value) { return Number.isSafeInteger(value) && value >= 1 && value <= 10000 }
function validatePredicate(predicate) {
  invariant(predicate && ['above', 'below', 'cross_up', 'above_sma', 'after'].includes(predicate.kind), 'Unknown Lean predicate.')
  if (['above', 'below', 'cross_up'].includes(predicate.kind)) invariant(Number.isSafeInteger(predicate.value) && predicate.value > 0, 'Price predicates need a positive integer-cent threshold.')
  if (predicate.kind === 'above_sma') invariant(Number.isSafeInteger(predicate.period) && predicate.period >= 2 && predicate.period <= 10000, 'SMA needs a period of 2–10,000.')
  if (predicate.kind === 'after') invariant(Number.isSafeInteger(predicate.bars) && predicate.bars >= 1, 'Holding time must be a positive number of bars.')
}

// Independent JavaScript interpretation. The Python runtime uses its own node
// objects and traversal; neither imports or executes the other implementation.
export function interpretLean(root, input) {
  validateLean(root, input)
  const states = new Map(), history = new Map(), trace = [], coverage = new Set()
  const all = [], pending = [root]
  while (pending.length) { const node = pending.pop(); if (node.kind === 'strategy') all.push(node); else pending.push(...(node.childOrder || Object.keys(node.children)).map(key => node.children[key]).reverse()) }
  const ledger = createExecutionLedger({ version: 1, cashCents: input.cashCents, currency: 'USD',
    assets: [...new Set(all.map(node => node.symbol))].sort().map(id => ({ id, multiplier: 1, quantityStep: 1 })),
    owners: all.map(node => node.path), limits: { intents: 100000, events: 1000000 } })
  let cash = input.cashCents, index = 0, prices, serial = 0
  const state = node => { if (!states.has(node.path)) states.set(node.path, { qty: 0, entry: null, done: false, cursor: 0, winner: null, opened: false }); return states.get(node.path) }
  const predicate = (rule, symbol, s) => {
    const values = history.get(symbol) || [], price = prices[symbol]
    if (!price) return false
    if (rule.kind === 'above') return price > rule.value
    if (rule.kind === 'below') return price < rule.value
    if (rule.kind === 'cross_up') return values.length >= 2 && values.at(-2) <= rule.value && price > rule.value
    if (rule.kind === 'above_sma') return values.length >= rule.period && BigInt(price) * BigInt(rule.period) > values.slice(-rule.period).reduce((sum, value) => sum + BigInt(value), 0n)
    return s.entry !== null && index - s.entry >= rule.bars
  }
  const order = (node, s, quantity, reason) => {
    const price = prices[node.symbol]
    if (!quantity || !price) return false
    invariant(Number.isSafeInteger(quantity), 'Trade arithmetic exceeds the exact integer range.')
    const cost = BigInt(quantity) * BigInt(price), available = BigInt(cash)
    if (quantity > 0 && available < cost) return false
    const id = 'intent-' + ++serial, lotId = quantity > 0 ? id + ':lot' : s.lotId
    const intent = { id, owner: node.path, lotId, asset: node.symbol, side: quantity > 0 ? 'buy' : 'sell',
      quantity: Math.abs(quantity), cashCapCents: quantity > 0 ? Number(cost) : 0, reason, time: index }
    if (!ledger.admit(intent).admitted) return false
    // Explicit v1 interpretation model; native Python uses broker callbacks.
    const receipt = { id: id + ':fill', intentId: id, brokerOrderId: id, kind: 'fill', time: index,
      quantity: Math.abs(quantity), priceCents: price, feeCents: 0 }
    ledger.reconcile(receipt)
    s.lotId = lotId; s.qty = ledger.lot(lotId).quantity; cash = ledger.resources().cashCents
    trace.push({ bar: index, path: node.path, symbol: node.symbol, quantity, priceCents: receipt.priceCents, reason })
    coverage.add(`${node.path}:${reason}`)
    return true
  }
  const descendants = node => {
    const all = [], pending = [node]
    while (pending.length) { const current = pending.pop(); all.push(current); if (current.kind !== 'strategy') pending.push(...(current.childOrder || Object.keys(current.children)).map(key => current.children[key]).reverse()) }
    return all
  }
  const visit = (node, allowBuy) => {
    const s = state(node), children = (node.childOrder || Object.keys(node.children)).map(key => node.children[key])
    if (node.kind === 'strategy') {
      if (s.done || !prices[node.symbol]) return
      if (s.qty > 0) {
        if (predicate(node.children.sell_reason, node.symbol, s)) {
          const sell = node.children.sell_process
          const quantity = sell.kind === 'all' ? s.qty : Math.max(1, Number(BigInt(s.qty) * BigInt(sell.basisPoints) / 10000n))
          order(node, s, -quantity, 'sell'); if (!s.qty) s.done = true
        }
      } else if (allowBuy && predicate(node.children.buy_reason, node.symbol, s)) {
        const buy = node.children.buy_process
        const quantity = buy.kind === 'shares' ? buy.quantity : Number(BigInt(cash) * BigInt(buy.basisPoints) / (10000n * BigInt(prices[node.symbol])))
        if (order(node, s, quantity, 'buy')) s.entry = index
      }
      return
    }
    if (node.kind === 'reset' && predicate(node.predicate, node.symbol, s)) {
      const all = descendants(node), held = all.filter(child => child.kind === 'strategy' && state(child).qty)
      if (held.every(child => prices[child.symbol])) {
        for (const child of held) order(child, state(child), -state(child).qty, 'reset')
        invariant(ledger.status(all.filter(child => child.kind === 'strategy').map(child => child.path)).resettable, 'A subtree with private inventory or pending tickets cannot clear.')
        for (const child of all) states.delete(child.path)
        coverage.add(`${node.path}:reset`)
      }
      return
    }
    if (s.done) return
    if (node.kind === 'state_gate' || node.kind === 'event_gate') {
      const open = predicate(node.predicate, node.symbol, s)
      s.opened ||= open
      if (open) coverage.add(`${node.path}:open`)
      allowBuy &&= node.kind === 'event_gate' ? s.opened : open
    }
    if (node.kind === 'sequence') {
      if (s.cursor < children.length) { visit(children[s.cursor], allowBuy); if (state(children[s.cursor]).done) { s.cursor++; coverage.add(`${node.path}:advance`) } }
      s.done = s.cursor === children.length
    } else if (node.kind === 'race') {
      if (s.winner !== null) visit(children[s.winner], allowBuy)
      else for (let i = 0; i < children.length; i++) {
        const before = trace.length; visit(children[i], allowBuy)
        if (trace.slice(before).some(order => order.quantity > 0)) { s.winner = i; coverage.add(`${node.path}:winner`); break }
      }
      s.done = s.winner !== null && state(children[s.winner]).done
    } else { for (const child of children) visit(child, allowBuy); s.done = children.every(child => state(child).done) }
  }
  for (index = 0; index < input.bars.length; index++) {
    prices = input.bars[index].prices
    for (const [symbol, price] of Object.entries(prices)) if (price) { if (!history.has(symbol)) history.set(symbol, []); history.get(symbol).push(price) }
    visit(root, true)
  }
  return { trace, cashCents: cash, lots: Object.fromEntries([...states].filter(([, s]) => s.qty).map(([path, s]) => [path, s.qty])), coverage: [...coverage].sort() }
}
