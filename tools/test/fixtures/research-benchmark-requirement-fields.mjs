// Explicit synthetic investigator field records. Assertions and alternatives
// are hand supplied here; the field generator does not choose their truth.
import { operationalStarter } from '../../../src/benchmark/trading-catalog.mjs'
import { deriveTaskExpected } from '../../../src/benchmark/tasks.mjs'
import { requirementFieldInventory, createRequirementFieldDraft, requirementValueField } from '../../../src/benchmark/requirement-fields.mjs'

export async function nestedRequirementFieldFixture() {
  const spec = await operationalStarter(), task = spec.tasks[0], start = task.input.bars[0].time
  task.input.execution.assets.push({ id: 'QQQ', multiplier: 1, quantityStep: 1 })
  task.input.bars = Array.from({ length: 20 }, (_, index) => ({ time: start + 60 * index, prices: { SPY: 10000, QQQ: 10000 } }))
  task.expected = await deriveTaskExpected(spec, task)
  const inventory = await requirementFieldInventory(spec), draft = createRequirementFieldDraft(inventory)
  draft.rationale = 'Synthetic investigator control fixture: every nested occurrence has a separately declared local alternative, with its actual selected input tested as well as its witness.'
  draft.targets.forEach((target, index) => {
    const row = inventory.rows[index]
    target.rationale = 'The intended local meaning at ' + row.path + ' must differ observably from the stated alternative while this occurrence is active.'
    const metric = row.activationOptions.find(option => option.name === (row.role.endsWith('_process') ? 'actions' : row.role.endsWith('_reason') ? 'true' : 'roundtrip-completed'))
    target.activation = [{ kind: metric.kind, name: metric.name, minimum: '1' }]
    // With the supplied four-share entry rule, the first admitted purchase
    // order requests four shares. This is a literal investigator assertion.
    target.probes[0].assertions = [{ path: ['orders', 0, 'quantity'], value: requirementValueField(4) }]
    const alternatives = {
      'op-strategy': { kind: 'parameter', parameter: 'asset', value: requirementValueField('QQQ') },
      'op-above': { kind: 'parameter', parameter: 'threshold', value: requirementValueField(11000) },
      'op-shares': { kind: 'parameter', parameter: 'quantity', value: requirementValueField(2) },
      'op-after': { kind: 'parameter', parameter: 'bars', value: requirementValueField(3) },
      'op-sell-all': { kind: 'replacement', bundleId: 'op-sell-fraction', parameters: { basisPoints: requirementValueField(5000) } },
      'op-all-2': { kind: 'replacement', bundleId: 'op-sequence-2', parameters: {} },
      'op-sequence-2': { kind: 'replacement', bundleId: 'op-all-2', parameters: {} },
    }
    target.wrongReadings = [{ id: 'local-alternative', rationale: 'A reader could substitute this local asset, threshold, size, waiting time, exit fraction or scheduling operator while preserving every other occurrence.', ...alternatives[row.bundleId] }]
  })
  return { spec, inventory, draft }
}
