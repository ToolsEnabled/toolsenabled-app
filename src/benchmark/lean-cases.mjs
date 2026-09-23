import { leanStarter, strategyRef } from './lean.mjs'
const wrap = strategy => ({ use: 'constitution-v1', slots: { strategy } })
const bars = prices => prices.map((price, index) => ({ time: new Date(Date.UTC(2024, 0, 2, 14, 31 + index)).toISOString(), prices: { SPY: price } }))

export function qualificationFixtures() {
  const starter = leanStarter().tasks[0], base = starter.input
  const parallel = { use: 'parallel', slots: { first: strategyRef(), second: strategyRef() } }
  const sequence = { use: 'sequence', slots: { first: strategyRef(), second: strategyRef() } }
  let deep = strategyRef()
  for (let depth = 0; depth < 7; depth++) deep = { use: ['parallel', 'sequence', 'race'][depth % 3], slots: { first: deep, second: strategyRef() } }
  const reset = { use: 'reset', slots: { child: strategyRef() } }
  const partial = strategyRef({ buy_process: 'cash-fraction', sell_process: 'sell-fraction' })
  const exitWhileClosed = strategyRef({ sell_reason: 'exit-below' })
  exitWhileClosed.slots.sell_reason.params = { threshold: 9000 }
  const fixtures = [
    { ...starter, handTrace: starter.expected },
    { id: 'parallel-private-lots', root: wrap(parallel), input: base, bars: [0, 0, 2, 2], quantities: [2, 2, -2, -2] },
    { id: 'cash-contention', root: wrap(parallel), input: { ...base, cashCents: 20000 }, bars: [0, 2, 3, 4], quantities: [2, -2, 2, -2] },
    { id: 'sequence-handoff', root: wrap(sequence), input: base, bars: [0, 2, 3, 4], quantities: [2, -2, 2, -2] },
    { id: 'race-nested-owner', root: wrap({ use: 'race', slots: { first: sequence, second: strategyRef() } }), input: base, bars: [0, 2, 3, 4], quantities: [2, -2, 2, -2] },
    { id: 'depth-seven', root: wrap(deep), input: base },
    { id: 'reset-reactivation', root: wrap(reset), input: { cashCents: 100000, bars: bars([10000, 8500, 10000, 10800]) }, bars: [0, 1, 2, 3], quantities: [2, -2, 2, -2], reasons: ['buy', 'reset', 'buy', 'sell'] },
    { id: 'state-gate-exits', root: wrap({ use: 'state-gate', slots: { child: exitWhileClosed } }), input: { cashCents: 100000, bars: bars([10000, 8500]) }, bars: [0, 1], quantities: [2, -2] },
    { id: 'cash-partial-missing-price', root: wrap(partial), input: { cashCents: 100000, bars: bars([10000, 9900, null, 10100, 10700, 10800, 10900]) }, bars: [0, 4, 5], quantities: [2, -1, -1] },
    { id: 'reverse-race-order', root: wrap({ use: 'race', slots: { first: strategyRef(), second: sequence } }), input: base, reverseOrder: true, bars: [0, 2, 3, 4], quantities: [2, -2, 2, -2] },
  ]
  return structuredClone(fixtures)
}

