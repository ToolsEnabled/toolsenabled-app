// Synthetic apparatus controls, never investigator-reviewed study content.
import { genericStarter } from '../../../src/benchmark/starters.mjs'
import { leanStarter } from '../../../src/benchmark/lean.mjs'

export function informationFixture() {
  const spec = genericStarter()
  spec.catalog = [
    { id: 'rule', version: '1', kind: 'atom', text: 'The required number is {{value}}.', parameters: { value: 2 }, semantics: { kind: 'constant', value: '{{value}}' } },
    { id: 'instruction', version: '1', kind: 'template', text: 'Produce the requested number.\n{{slot:rule}}', slots: { rule: 'node' }, semantics: { kind: 'task' } },
  ]
  const root = value => ({ use: 'instruction', slots: { rule: { use: 'rule', params: { value } } } })
  spec.tasks = [{ id: 'number-task', familyId: 'number-family', root: root(2), input: null, expected: 2, split: 'development', information: {
    version: 1, scope: 'declared-set', rationale: 'Synthetic control: the withheld number has two explicitly declared readings.', responseMode: 'raw', withheldPaths: ['root/rule'],
    readings: [1, 2].map(value => ({ id: `number-${value}`, rationale: `Synthetic reading ${value}.`, root: root(value), expected: value })),
  } }]
  spec.protocol.grading = { kind: 'json' }
  spec.conditions[0].adapter.responses = { 'number-task': 2 }
  return spec
}

export function leanInformationFixture() {
  const spec = leanStarter(), task = spec.tasks[0]
  task.familyId = 'lean-family'
  task.information = { version: 1, scope: 'declared-set', rationale: 'Synthetic quantity-omission control.', responseMode: 'raw', withheldPaths: ['root/strategy/buy_process'], readings: [1, 3].map(quantity => {
    const root = structuredClone(task.root); root.slots.strategy.slots.buy_process.params = { quantity }
    return { id: `shares-${quantity}`, root, rationale: `Synthetic ${quantity}-share reading.`, conventions: { shares: quantity } }
  }) }
  return spec
}
