import { genericStarter } from '../../../src/benchmark/starters.mjs'
import { corpusPlanFromTask } from '../../../src/benchmark/corpus.mjs'
import { materializeCorpus } from '../../../src/benchmark/study.mjs'
import { operationalStarter, operationalStrategy } from '../../../src/benchmark/trading-catalog.mjs'

// Three binary factors require four pair-covering cases. Merely covering both
// levels of each factor can select only two cases and miss half the pairs.
export async function coverageFixture() {
  const spec = genericStarter(), plan = corpusPlanFromTask(spec.tasks[0])
  spec.id = 'joint-coverage-controls'; spec.name = 'Joint corpus coverage controls'
  spec.catalog.push({ ...structuredClone(spec.catalog.find(row => row.id === 'context')), id: 'outer-context' })
  plan.families[0].id = 'arithmetic-family'
  plan.families[0].axes = [
    { id: 'number', choices: [2, 4].map(value => ({ id: 'n-' + value, edits: [{ kind: 'parameter', path: ['task'], name: 'a', value }, { kind: 'expected', value: String(value + 3) }] })) },
    { id: 'wording', choices: ['red', 'blue'].map(value => ({ id: value, edits: [{ kind: 'parameter', path: [], name: 'instruction', value: 'Synthetic ' + value + ' instruction.' }] })) },
    { id: 'depth', choices: [0, 2].map(repeat => ({ id: 'd-' + repeat, edits: [{ kind: 'wrap', path: [], bundleId: 'outer-context', slot: 'task', repeat }] })) },
  ]
  plan.features = [{ id: 'outer-wrapper', bundles: ['outer-context'], rationale: 'Synthetic wrapper presence, checked from compiled nodes.' },
    { id: 'arithmetic', bundles: ['task'], rationale: 'The arithmetic atom must occur in every selected composition.' }]
  plan.coverage = [
    { dimensions: ['axis:number', 'axis:wording'], minimum: 1 },
    { dimensions: ['axis:number', 'axis:depth'], minimum: 1 },
    { dimensions: ['axis:wording', 'axis:depth'], minimum: 1 },
    { dimensions: ['axis:number', 'composition-depth'], levels: { 'composition-depth': ['1', '3'] }, minimum: 1 },
    { dimension: 'feature:outer-wrapper', minimum: 1 },
    { dimension: 'feature:arithmetic', levels: { 'feature:arithmetic': ['present'] }, minimum: 4 },
  ]
  plan.selection = { kind: 'balanced', limit: 4 }
  plan.rationale = 'Synthetic pairwise apparatus control. Four tasks cover all pairs across three binary factors; actual compiled depth is cross-checked. This is no claim about treatment effects or branch activation.'
  spec.corpusPlan = plan; spec.tasks = (await materializeCorpus(spec)).tasks
  spec.conditions[0].adapter.responses = Object.fromEntries(spec.tasks.map(task => [task.id, task.expected]))
  return spec
}

export async function operationalCoverageFixture() {
  const spec = await operationalStarter(), task = spec.tasks[0]
  task.root = operationalStrategy()
  const plan = corpusPlanFromTask(task)
  plan.families[0].id = 'operational-pairs'
  plan.families[0].axes = [
    { id: 'entry', choices: ['above', 'below'].map(kind => ({ id: kind, edits: [{ kind: 'node', path: ['buy_reason'], value: { use: 'op-' + kind } }] })) },
    { id: 'quantity', choices: [2, 4].map(quantity => ({ id: 'q-' + quantity, edits: [{ kind: 'parameter', path: ['buy_process'], name: 'quantity', value: quantity }] })) },
    { id: 'operator', choices: ['all', 'sequence'].map(kind => ({ id: kind, edits: [{ kind: 'wrap', path: [], bundleId: 'op-' + kind + '-2', slot: 'child1', otherSlots: { child2: operationalStrategy() }, repeat: 1 }] })) },
  ]
  plan.features = [{ id: 'sequence', bundles: ['op-sequence-2'], rationale: 'A declared sequential controller occurs in the baseline AST.' },
    { id: 'holding-age', bundles: ['op-after'], rationale: 'These synthetic strategies contain an atom whose predicate uses age since actual entry fill; presence alone does not prove activation.' }]
  plan.coverage = [
    { dimensions: ['axis:entry', 'axis:quantity'], minimum: 1 }, { dimensions: ['axis:entry', 'axis:operator'], minimum: 1 },
    { dimensions: ['axis:quantity', 'axis:operator'], minimum: 1 }, { dimension: 'feature:sequence', minimum: 2 },
    { dimension: 'feature:holding-age', levels: { 'feature:holding-age': ['present'] }, minimum: 4 },
    { dimension: 'composition-depth', levels: { 'composition-depth': ['2'] }, minimum: 4 },
  ]
  plan.selection = { kind: 'balanced', limit: 4 }
  plan.rationale = 'Synthetic operational pairwise control over entry, quantity and ALL/SEQUENCE. Preserve exact generated input and observations for independent interpreter comparison. No personal semantics, model collection or native qualification is inferred.'
  spec.id = 'operational-corpus-pairs'; spec.name = 'Operational corpus pair controls'
  spec.corpusPlan = plan; spec.tasks = (await materializeCorpus(spec)).tasks
  spec.conditions[0].adapter.responses = Object.fromEntries(spec.tasks.map(task => [task.id, task.expected]))
  return spec
}
