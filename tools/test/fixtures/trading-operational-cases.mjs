// Hand-authored lifecycle controls. These synthetic rules and named policy
// alternatives are test contracts, not owner-approved study atoms.
import { compilePrompt } from '../../../src/benchmark/prompts.mjs'
// PROMPT B: the operational roles are declared beside their own contract now.
import { OPERATIONAL_STRATEGY_ROLES as ROLES } from '../../../src/benchmark/trading-ir.mjs'
import { lowerTradingIR } from '../../../src/benchmark/trading-ir.mjs'
import { createTradingRuntime } from '../../../src/benchmark/trading-runtime.mjs'

export const tradingConfig = overrides => ({ version: 1, cashCents: 1000, currency: 'USD',
  assets: [{ id: 'SPY', multiplier: 1, quantityStep: 1 }, { id: 'GATE', multiplier: 1, quantityStep: 1 }],
  limits: { intents: 10000, events: 100000, bars: 100000 }, exitWhileEntryPending: 'wait-terminal', resetHistory: 'retain-observations', ...overrides })
export const strategy = overrides => ({ type: 'strategy', asset: 'SPY',
  buy_reason: { kind: 'above', value: 5 }, buy_process: { kind: 'shares', quantity: 4, cashCapCents: 40 },
  sell_reason: { kind: 'after', bars: 1 }, sell_process: { kind: 'all' }, ...overrides })
export const template = (operator, children, overrides = {}) => ({ type: 'template', operator, children,
  policy: operator === 'all' ? {} : operator === 'sequence' ? { handoff: 'next-bar' }
    : { claim: 'broker-accepted', release: 'empty-or-complete-next-bar', losers: 'cancel-then-liquidate' },
  gate: { kind: 'none' }, reset: null, ...overrides })

export async function tradingCase(root = strategy(), overrides = {}) {
  let bundleSerial = 0
  const catalog = [], add = definition => {
    const id = 'fixture-' + ++bundleSerial
    if (definition.type === 'strategy') {
      const slots = {}
      for (const role of ROLES) {
        const atom = id + '-' + role
        catalog.push({ id: atom, version: '1', kind: 'atom', role, text: JSON.stringify(definition[role]), semantics: definition[role] })
        slots[role] = { use: atom }
      }
      catalog.push({ id, version: '1', kind: 'template', slots: Object.fromEntries(ROLES.map(role => [role, role])), slotOrder: ROLES,
        text: ROLES.map(role => role + ': {{slot:' + role + '}}').join('\n'), semantics: { kind: 'strategy', asset: definition.asset } })
      return { use: id, slots }
    }
    const names = definition.children.map((_, index) => 'child' + index)
    catalog.push({ id, version: '1', kind: 'template', slots: Object.fromEntries(names.map(name => [name, 'node'])), slotOrder: names,
      text: definition.operator + ' ' + names.map(name => '{{slot:' + name + '}}').join('\n'),
      semantics: { kind: 'template', operator: definition.operator, policy: definition.policy, gate: definition.gate, reset: definition.reset } })
    return { use: id, slots: Object.fromEntries(names.map((name, index) => [name, add(definition.children[index])])) }
  }
  const ast = add(root), compiled = await compilePrompt(catalog, ast), config = tradingConfig(overrides)
  return { catalog, ast, compiled, config, ir: await lowerTradingIR(compiled.composition, config) }
}

export async function tradingHarness(root, overrides = {}, callbacks = {}) {
  const source = await tradingCase(root, overrides), sent = [], cancelled = [], actions = []
  let runtime, eventSerial = 0, activeBar = null, activeCall = null
  const receipt = (intent, kind, time, extra = {}) => {
    const intentId = typeof intent === 'string' ? intent : intent.id
    const event = { id: 'e' + ++eventSerial, intentId, brokerOrderId: 'broker-' + intentId, kind, time, ...extra }
    if (activeCall) activeCall.events.push(event)
    else actions.push({ kind: 'receipt', event })
    runtime.reconcile(event); return event
  }
  const callback = (kind, intentId, call) => {
    const record = { kind, intentId, events: [] }, previous = activeCall
    if (!activeBar) throw new Error('A fixture dispatch escaped its completed-bar scope.')
    activeBar.callbacks.push(record); activeCall = record
    try { call() } finally { activeCall = previous }
  }
  runtime = createTradingRuntime(source.ir, {
    dispatch(intent) { sent.push(intent); callback('dispatch', intent.id, () => callbacks.dispatch?.(intent, receipt, runtime)) },
    cancel(id) { cancelled.push(id); callback('cancel', id, () => callbacks.cancel?.(id, receipt, runtime)) },
  })
  return { ...source, runtime, sent, cancelled, actions, receipt,
    bar(time, prices = { SPY: 10 }) {
      const action = { kind: 'bar', bar: { time, prices }, callbacks: [] }
      actions.push(action); activeBar = action
      try { return runtime.step(action.bar) } finally { activeBar = null }
    },
    reset(path, time) { actions.push({ kind: 'reset', path, time }); runtime.requestReset(path, time) },
    fill(intent, quantity, time, priceCents = 10, feeCents = 0) { return receipt(intent, 'fill', time, { quantity, priceCents, feeCents }) },
    state(path = 'root') { return runtime.snapshot().states.find(row => row.path === path) },
  }
}
