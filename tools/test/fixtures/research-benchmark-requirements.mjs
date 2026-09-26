// Explicit synthetic apparatus controls. These are hand-written expectations
// and registered wrong readings, not personal study reviews or model output.
import { operationalStarter, operationalStrategy } from '../../../src/benchmark/trading-catalog.mjs'
import { deriveTaskExpected } from '../../../src/benchmark/tasks.mjs'

export async function operationalRequirementFixture({ shrink = false } = {}) {
  const spec = await operationalStarter(), task = spec.tasks[0], time = task.input.bars[0].time
  task.id = 'four-roles'; task.root = operationalStrategy()
  task.root.slots.buy_reason.params = { threshold: 10000 }
  task.root.slots.buy_process.params = { cashCapCents: 50000 }
  task.input.bars = Array.from({ length: 10 }, (_, i) => ({ time: time + i * 60, prices: { SPY: i === 0 ? 10000 : 10001 } }))
  task.expected = await deriveTaskExpected(spec, task)
  const readings = [
    ['buy_reason', 'op-above', 'strict-entry-boundary', 'true', root => { root.slots.buy_reason.params.threshold = 9999 },
      [{ path: ['orders', 0, 'time'], equals: time + 60 }], 'Including equality admits the first bar instead of waiting for a strictly greater close.'],
    ['buy_process', 'op-shares', 'entry-quantity', 'actions', root => { root.slots.buy_process.params.quantity = 2 },
      [{ path: ['orders', 0, 'quantity'], equals: 4 }], 'Buying two shares violates the four-share process even when the entry predicate is correct.'],
    ['sell_reason', 'op-after', 'holding-age', 'true', root => { root.slots.sell_reason.params = { bars: 3 } },
      [{ path: ['orders', 1, 'time'], equals: time + 3 * 60 }], 'Waiting three later bars delays the exit after the actual entry fill.'],
    ['sell_process', 'op-sell-all', 'private-exit-quantity', 'actions', root => { root.slots.sell_process = { use: 'op-sell-fraction', params: { basisPoints: 5000 } } },
      [{ path: ['orders', 1, 'quantity'], equals: -4 }], 'Selling one half leaves private inventory and requires later exit orders.'],
  ]
  spec.requirementPlan = { version: 1, ...(shrink ? { shrink: { sequencePath: ['bars'], maxEvaluations: 48 } } : {}), targets: readings.map(([role, bundle, id, counter, mutate, assertions, explanation]) => {
    const root = structuredClone(task.root); mutate(root)
    return { id, taskId: task.id, requirementId: 'root/' + role + '#' + bundle, rationale: explanation,
      activation: [{ kind: 'counter', name: counter, minimum: 1 }],
      probes: [{ id: 'delayed-partial-roundtrip', input: structuredClone(task.input), assertions }],
      wrongReadings: [{ id: 'wrong-' + id, root, rationale: explanation }] }
  }) }
  const race = { ...structuredClone(task), id: 'race-policy', root: { use: 'op-race-accepted-2', slots: { child1: structuredClone(task.root), child2: structuredClone(task.root) } } }
  race.expected = await deriveTaskExpected(spec, race)
  const wrongRace = structuredClone(race.root); wrongRace.use = 'op-race-filled-2'
  spec.tasks = [task, race]
  spec.requirementPlan.targets.push({ id: 'race-acquisition', taskId: race.id, requirementId: 'root#op-race-accepted-2',
    rationale: 'The accepted-order draft suppresses the losing entry before it can fill; first-fill ownership permits two contenders.',
    activation: [{ kind: 'transition', name: 'race-acquired', minimum: 1 }],
    probes: [{ id: 'simultaneous-contenders', input: structuredClone(race.input), assertions: [{ path: ['orders', 'length'], equals: 2 }, { path: ['orders', 0, 'owner'], equals: 'root/child1' }] }],
    wrongReadings: [{ id: 'first-fill-instead-of-acceptance', root: wrongRace, rationale: 'Swap only this template acquisition policy; preserve both children and all four atomic roles.' }] })
  spec.conditions[0].adapter.responses = Object.fromEntries(spec.tasks.map(task => [task.id, task.expected]))
  return spec
}
