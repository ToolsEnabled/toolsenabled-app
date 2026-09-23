// Authorable synthetic operational examples. These drafts are qualification
// apparatus, not the personally approved atom catalog for the actual study.
import { combinations } from './prompts.mjs'
// PROMPT B. The four parts come from the operational contract beside this
// catalog, not from the compiler, which carries no role names at all.
import { OPERATIONAL_STRATEGY_ROLES as ROLES } from './trading-ir.mjs'
import { genericStarter } from './starters.mjs'
import { deriveTaskExpected } from './tasks.mjs'

export const OPERATIONAL_CONTRACT = `Draft operational equity contract, version 1. Personal review is required before freezing a study.
Each Strategy combines exactly four independently bound roles: buy reason, buy process, sell reason and sell process. Each Template owns 2–4 recursively typed Node children in declared slot order, with its own gate and reset properties. A strategy owns its private lots and tickets even when another strategy trades the same asset. Portfolio-wide holdings cannot determine private ownership. Cash is shared; accepted local purchase proposals reserve their full stated cash cap before later siblings run. Only native fills spend cash or change inventory. A cancellation request releases nothing until its terminal acknowledgment. Liquidating a losing branch or reset subtree cannot sell another owner's lot.
Visit each completed input bar once. All orders and cancellation requests are issued during that bar callback. Reconcile native receipts without issuing new orders from a receipt callback. A strategy takes at most one order action per bar. Evaluate its sell rule before a new entry; there is no same-bar re-entry. A strategy completes after it has actually bought, then becomes flat with all tickets terminal. Completion stays set until an explicit reset. A failed entry proposal may retry on a later bar.
Price predicates use observed completed closes only. Strict above/below excludes equality. Cross-up requires the preceding observed close at or below the threshold and the current close above; cross-down reverses that relation. SMA predicates include the current close and require the entire stated observation window. A missing price never supplies an observation or permits that asset's order. Holding age begins at the first actual entry fill: after N bars becomes true after N later completed timestamps. Arithmetic uses exact integer cents and whole shares. Fractional cash sizing floors quantity using unreserved cash and the observed price after the stated fee allowance; fixed cash sizing uses its stated budget. Fractional sales floor their fraction of available private inventory, with a minimum of one whole share.
ALL visits every eligible child in slot order and completes when all children complete. SEQUENCE visits only its current child; after actual child completion, the next child is eligible on the following completed bar. RACE acquisition is an explicit template policy: broker-accepted claims the first native accepted order (or fill proving acceptance), while first-fill permits contenders until an actual fill claims ownership. Slot order breaks same-callback opportunities. Losing branches cancel outstanding tickets, wait for terminal acknowledgment, then liquidate any actual losing inventory. The winning branch continues its lifecycle. RACE releases only after all branches are flat and terminal and any drain is complete; release/reactivation crosses a completed-bar boundary. No choice of RACE policy in this draft is personal approval of that policy for the study.
A state gate evaluates its predicate on each ready bar. An event gate declares a level or rising-edge trigger, an optional lifetime in completed bars, and an explicit rearm rule. An unready gate blocks entries without inventing a new transition. A closed gate either blocks new entries while exits continue, or drains and resets descendants, as its close policy declares. Reset takes priority over ordinary actions: cancel pending tickets, await terminal receipts, liquidate owned inventory when prices are available, then clear subtree state only when flat and terminal. Reactivation waits until a later timestamp. Reset of a child invalidates ancestor completion and rewinds an affected sequence; clearing an entire winning child releases its RACE ownership after draining. Reset preserves the requesting controller's trigger history, preventing a held rising-edge condition from repeatedly resetting itself.
The input explicitly chooses whether exits wait for entry tickets to become terminal or may sell currently owned quantity, and whether reset retains observed history or restarts that subtree's history. Gate event lifetime, rearming, drain state, winner, sequence cursor and holding age belong to their own node instance. Resource limits bound bars, proposals and receipts. A violated invariant stops qualification or execution. No implicit end-of-data liquidation occurs. This draft does not specify options lifecycle, margin, shorts, nonzero fees or live brokerage behavior.`

function bundle(value) {
  return { version: '1', role: 'node', dependencies: ['operational-contract-v1'], review: null,
    state: 'Private per-instance lifecycle, tickets and actual filled lots; see the bound operational contract.',
    hooks: { interpreter: 'trading-runtime.mjs', independentInterpreter: 'trading_reference.py', market: 'trading-market.mjs', nativeObservation: 'trading-observations.mjs' },
    tests: ['Qualify this exact composition using hand-authored observations, independent Python, fresh native runs and activated wrong readings.'], ...value }
}
const atom = (id, role, text, semantics, parameters = {}) => bundle({ id, kind: 'atom', role, text, semantics, parameters })
export function operationalCatalog() {
  const catalog = [
    { id: 'operational-contract-v1', version: '1', kind: 'atom', role: 'contract', text: OPERATIONAL_CONTRACT, semantics: { kind: 'operational-contract', version: 1 }, dependencies: [], review: null,
      state: 'The explicit operational lifecycle and broker observation contract.', hooks: {}, tests: ['Review source pins, policy choices and every qualification receipt before counted use.'] },
    atom('op-above', 'buy_reason', 'Enter when the observed close is strictly above {{threshold}} cents.', { kind: 'above', value: '{{threshold}}' }, { threshold: 5000 }),
    atom('op-below', 'buy_reason', 'Enter when the observed close is strictly below {{threshold}} cents.', { kind: 'below', value: '{{threshold}}' }, { threshold: 11000 }),
    atom('op-cross-up', 'buy_reason', 'Enter when consecutive observed closes cross from at or below to above {{threshold}} cents.', { kind: 'cross_up', value: '{{threshold}}' }, { threshold: 9900 }),
    atom('op-above-sma', 'buy_reason', 'Enter when the observed close exceeds its complete {{period}}-observation SMA, including the current close.', { kind: 'above_sma', period: '{{period}}' }, { period: 3 }),
    atom('op-shares', 'buy_process', 'Propose {{quantity}} whole shares, reserving the complete {{cashCapCents}}-cent purchase cap. Reject this proposal if that cap exceeds unreserved cash.', { kind: 'shares', quantity: '{{quantity}}', cashCapCents: '{{cashCapCents}}' }, { quantity: 4, cashCapCents: 40000 }),
    atom('op-cash-fraction', 'buy_process', 'Allocate {{basisPoints}}/10000 of unreserved cash, reserving {{feeAllowanceCents}} cents within that budget for fees; floor the whole-share quantity at the observed close.', { kind: 'cash_fraction', basisPoints: '{{basisPoints}}', feeAllowanceCents: '{{feeAllowanceCents}}' }, { basisPoints: 2500, feeAllowanceCents: 0 }),
    atom('op-fixed-cash', 'buy_process', 'Use a {{cashCents}}-cent budget with {{feeAllowanceCents}} cents reserved within it for fees; floor whole-share quantity at the observed close.', { kind: 'fixed_cash', cashCents: '{{cashCents}}', feeAllowanceCents: '{{feeAllowanceCents}}' }, { cashCents: 40000, feeAllowanceCents: 0 }),
    atom('op-after', 'sell_reason', 'Exit after {{bars}} later completed bars since the first actual entry fill.', { kind: 'after', bars: '{{bars}}' }, { bars: 1 }),
    atom('op-exit-above', 'sell_reason', 'Exit when the observed close is strictly above {{threshold}} cents.', { kind: 'above', value: '{{threshold}}' }, { threshold: 10500 }),
    atom('op-sell-all', 'sell_process', 'Sell all unreserved quantity in this strategy\'s private lot.', { kind: 'all' }),
    atom('op-sell-fraction', 'sell_process', 'Sell {{basisPoints}}/10000 of unreserved private quantity, floored to whole shares with a minimum of one.', { kind: 'fraction', basisPoints: '{{basisPoints}}' }, { basisPoints: 5000 }),
    bundle({ id: 'op-strategy', kind: 'template', parameters: { asset: 'SPY' }, slots: Object.fromEntries(ROLES.map(role => [role, role])), slotOrder: ROLES,
      text: 'Strategy for {{asset}}, owning its private lot and tickets:\nBuy reason: {{slot:buy_reason}}\nBuy process: {{slot:buy_process}}\nSell reason: {{slot:sell_reason}}\nSell process: {{slot:sell_process}}', semantics: { kind: 'strategy', asset: '{{asset}}' } }),
  ]
  for (const arity of [2, 3, 4]) for (const name of ['all', 'sequence', 'race-accepted', 'race-filled', 'state-all', 'event-all', 'reset-all']) {
    const operator = name.includes('all') ? 'all' : name.startsWith('race') ? 'race' : name
    const slots = Object.fromEntries(Array.from({ length: arity }, (_, i) => ['child' + (i + 1), 'node']))
    const policy = operator === 'all' ? {} : operator === 'sequence' ? { handoff: 'next-bar' }
      : { claim: name === 'race-accepted' ? 'broker-accepted' : 'first-fill', release: 'empty-or-complete-next-bar', losers: 'cancel-then-liquidate' }
    const gated = ['state-all', 'event-all', 'reset-all'].includes(name)
    const predicate = { kind: 'above', asset: '{{gateAsset}}', value: '{{threshold}}' }
    const gate = name === 'state-all' ? { kind: 'state', predicate, close: 'block-entries' } : name === 'event-all'
      ? { kind: 'event', predicate, close: 'drain-and-reset', trigger: 'rising-edge', ttlBars: 3, rearm: 'after-false-while-closed' } : { kind: 'none' }
    const reset = name === 'reset-all' ? { predicate, trigger: 'rising-edge' } : null
    const wording = name === 'state-all' ? ' Its state gate permits entries only while {{gateAsset}} exceeds {{threshold}} cents; exits continue when closed.'
      : name === 'event-all' ? ' Its rising-edge event gate opens when {{gateAsset}} exceeds {{threshold}} cents, lasts 3 completed bars, drains and resets on closure, and rearms after false while closed.'
      : name === 'reset-all' ? ' Reset this subtree on a rising edge of {{gateAsset}} exceeding {{threshold}} cents.'
      : operator === 'race' ? ' Claim ownership on ' + policy.claim + '; cancel then liquidate losing branches, releasing only when empty or complete on a later bar.' : ''
    catalog.push(bundle({ id: 'op-' + name + '-' + arity, kind: 'template', slots, slotOrder: Object.keys(slots),
      parameters: gated ? { gateAsset: 'SPY', threshold: 11000 } : {}, text: operator.toUpperCase() + ' with ' + arity + ' Node children in the following order.' + wording + '\n'
        + Object.keys(slots).map(slot => slot + ': {{slot:' + slot + '}}').join('\n'), semantics: { kind: 'template', operator, policy, gate, reset } }))
  }
  return catalog
}

export function operationalStrategy(roles = {}, asset = 'SPY') {
  const defaults = { buy_reason: 'op-above', buy_process: 'op-shares', sell_reason: 'op-after', sell_process: 'op-sell-all' }
  return { use: 'op-strategy', params: { asset }, slots: Object.fromEntries(ROLES.map(role => [role, { use: roles[role] || defaults[role] }])) }
}
export function generateOperationalTasks(choices, { wrapper = null, input, asset = 'SPY', split = 'development' } = {}) {
  return combinations(Object.fromEntries(ROLES.map(role => [role, choices[role]]))).map((roles, index) => ({ id: 'strategy-' + (index + 1),
    root: wrapper ? { use: wrapper, slots: { child1: operationalStrategy(roles, asset), child2: operationalStrategy(roles, asset) } } : operationalStrategy(roles, asset),
    input: structuredClone(input), expected: null, split }))
}

export async function operationalStarter() {
  const base = genericStarter(), input = { execution: { version: 1, cashCents: 150000, currency: 'USD', assets: [{ id: 'SPY', multiplier: 1, quantityStep: 1 }],
    limits: { intents: 10000, events: 100000, bars: 100000 }, exitWhileEntryPending: 'wait-terminal', resetHistory: 'retain-observations' },
    market: { version: 1, kind: 'delayed-capped-equity', delayBars: 1, maxFillQuantity: 2 },
    bars: Array.from({ length: 10 }, (_, i) => ({ time: 1704205860 + 60 * i, prices: { SPY: 10000 } })) }
  const spec = { ...base, id: 'lean-operational-study', name: 'Operational Lean Bench', domain: 'lean-bench', leanProfile: 'operational-v1', requireReview: true,
    catalog: operationalCatalog(), tasks: [{ id: 'operational-canary', root: { use: 'op-all-2', slots: {
      child1: operationalStrategy(), child2: { use: 'op-sequence-2', slots: { child1: operationalStrategy(), child2: operationalStrategy() } },
    } }, input, expected: null, split: 'development' }],
    protocol: { ...base.protocol, grading: { kind: 'json' } },
    environment: { node: '>=22', python: '>=3.10', dependencies: [], leanImage: '', instructions: 'The recorded observation checks the apparatus. Pin the native image before LEAN Python grading; independently qualify the exact tasks before collection.' },
    decisions: 'Synthetic draft operational examples. Review the lifecycle choices, all used atoms, market fixture, qualification controls and study design before counted research. No personal approval, options coverage or model collection is implied.' }
  const expected = await deriveTaskExpected(spec, spec.tasks[0]); spec.tasks[0].expected = expected
  spec.conditions = [{ id: 'recorded', label: 'Recorded operational observation', model: { provider: 'fixture', id: 'operational-canary-v1', settings: {} },
    adapter: { kind: 'replay', responses: { 'operational-canary': expected } } }]
  return spec
}
