import { operationalRequirementFixture } from './research-benchmark-requirements.mjs'
import { deriveTaskExpected } from '../../../src/benchmark/tasks.mjs'

export async function activationFixture({ inactive = false, policy = 'require-composition' } = {}) {
  const spec = await operationalRequirementFixture(), task = spec.tasks[0]
  spec.id = 'selected-input-controls'; spec.name = 'Selected-input activation controls'
  spec.tasks = [task]; spec.requirementPlan.targets = spec.requirementPlan.targets.slice(0, 4)
  task.input.execution.assets.push({ id: 'QQQ', multiplier: 1, quantityStep: 1 })
  for (const bar of task.input.bars) bar.prices.QQQ = bar.prices.SPY
  for (const target of spec.requirementPlan.targets) target.probes[0].input = structuredClone(task.input)
  const wrongRoot = structuredClone(task.root); wrongRoot.params.asset = 'QQQ'
  spec.requirementPlan.targets.push({ id: 'private-strategy-asset', taskId: task.id, requirementId: 'root#op-strategy',
    rationale: 'Synthetic Strategy control: the declared asset belongs to the owning instance, even when another asset has the same prices.',
    activation: [{ kind: 'transition', name: 'roundtrip-completed', minimum: 1 }],
    probes: [{ id: 'asset-roundtrip', input: structuredClone(task.input), assertions: [{ path: ['orders', 0, 'asset'], equals: 'SPY' }] }],
    wrongReadings: [{ id: 'other-asset', root: wrongRoot, rationale: 'Change only the Strategy asset while preserving its four atomic roles.' }] })
  spec.requirementPlan.selectedInput = { policy, rationale: 'Synthetic precollection gate control; no personal semantic approval or model study is implied.', timeoutMs: 30000 }
  if (inactive) for (const bar of task.input.bars) bar.prices.SPY = 10000
  task.expected = await deriveTaskExpected(spec, task)
  spec.conditions[0].adapter.responses = { [task.id]: task.expected }
  return spec
}
