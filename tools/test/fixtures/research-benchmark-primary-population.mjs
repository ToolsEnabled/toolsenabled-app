// Synthetic rank reversal: one condition succeeds only on development tasks,
// the other only on held-out tasks. This is an analysis apparatus control.
import { genericStarter } from '../../../src/benchmark/starters.mjs'

export function primaryPopulationFixture({ developmentTasks = 9, heldOutTasks = 1, replicates = 1 } = {}) {
  const spec = genericStarter()
  spec.id = 'primary-population-control'; spec.name = 'Synthetic primary-population rank reversal'
  spec.tasks = [
    ...Array.from({ length: developmentTasks }, (_, index) => ({ id: 'development-' + (index + 1), split: 'development' })),
    ...Array.from({ length: heldOutTasks }, (_, index) => ({ id: 'held-out-' + (index + 1), split: 'held-out' })),
  ].map((task, index) => ({ ...task, familyId: 'family-' + task.id,
    root: { use: 'task', params: { a: index + 1, b: 100 } }, input: null, expected: String(index + 101) }))
  spec.conditions = ['first', 'second'].map((id, index) => ({ ...structuredClone(spec.conditions[0]), id,
    label: index === 0 ? 'Development-only correct control' : 'Held-out-only correct control',
    adapter: { kind: 'replay', responses: Object.fromEntries(spec.tasks.map(task => [task.id,
      task.split === (index === 0 ? 'development' : 'held-out') ? task.expected : 'incorrect control'])) } }))
  spec.protocol.replicates = replicates; spec.protocol.maxTotalAttempts = 10000
  spec.analysisPlan.primaryPopulation = { kind: 'split', split: 'held-out' }
  spec.analysisPlan.contrasts = [{ id: 'first-minus-second', first: 'first', second: 'second' }]
  spec.analysisPlan.rationale = 'Synthetic frozen held-out endpoint; development outcomes remain visible and cannot change the primary comparison.'
  return spec
}
