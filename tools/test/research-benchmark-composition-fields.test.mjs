import assert from 'node:assert/strict'
import test from 'node:test'
import { canonical, compilePrompt } from '../../src/benchmark/prompts.mjs'
import { compositionFieldInventory, createCompositionFieldDraft, compileCompositionFields } from '../../src/benchmark/corpus.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { operationalStarter } from '../../src/benchmark/trading-catalog.mjs'
import { materializeCorpus, freezeStudy } from '../../src/benchmark/study.mjs'
import { requirementFieldInventory } from '../../src/benchmark/requirement-fields.mjs'
import { evaluateReadiness } from '../../src/benchmark/readiness.mjs'

function genericFixture() {
  const spec = genericStarter()
  spec.catalog = [
    { id: 'pair', version: '1', kind: 'template', role: 'node', slots: { left: 'node', right: 'node' }, slotOrder: ['left', 'right'],
      text: 'L[{{slot:left}}] R[{{slot:right}}]', semantics: { kind: 'pair' } },
    { id: 'box', version: '1', kind: 'template', role: 'node', slots: { item: 'node' }, text: '({{slot:item}})', semantics: { kind: 'box' } },
    { id: 'other-box', version: '1', kind: 'template', role: 'node', slots: { item: 'node' }, text: 'OTHER({{slot:item}})', semantics: { kind: 'other-box' } },
    ...['plus', 'minus'].map(operation => ({ id: operation, version: '1', kind: 'atom', role: 'node', parameters: { n: 1 },
      text: operation + ' {{n}}', semantics: { kind: 'number', operation, n: '{{n}}' } })),
  ]
  spec.protocol.grading = { kind: 'json' }
  spec.tasks = [{ id: 'nested-generic', split: 'development', input: null, expected: null,
    root: { use: 'pair', slots: {
      left: { use: 'box', slots: { item: { use: 'plus', params: { n: 1 } } } },
      right: { use: 'box', slots: { item: { use: 'plus', params: { n: 10 } } } },
    } } }]
  return spec
}
async function fields(spec) {
  const inventory = await compositionFieldInventory(spec, spec.tasks[0].id), draft = createCompositionFieldDraft(inventory)
  draft.rationale = 'Hand-counted synthetic construction controls; inspect every exact path and retained selection.'
  draft.expectedPolicy = { kind: spec.domain === 'lean-bench' ? 'derive-lean' : 'reuse-base',
    rationale: spec.domain === 'lean-bench' ? 'Use the existing operational semantic compiler; independent qualification remains required.'
      : 'Retain the declared placeholder solely for construction tests; no generic truth or collection admission is inferred.' }
  return { inventory, draft }
}
function occurrence(draft, path) {
  const row = draft.occurrences.find(row => canonical(row.path) === canonical(path)); assert.ok(row, 'Missing exact path ' + path.join('/')); return row
}
function choice(inventory, path, bundleId, id, parameters = {}) {
  const row = inventory.rows.find(row => canonical(row.path) === canonical(path)), option = row.compatible.find(row => row.bundleId === bundleId)
  assert.ok(option, 'Missing compatible choice ' + bundleId)
  const result = { id, bundleId, parameters: structuredClone(option.parameters) }
  for (const [name, value] of Object.entries(parameters)) result.parameters[name] = { kind: typeof value, text: String(value), present: true }
  return result
}
function enable(draft, path, axisId, choices) {
  Object.assign(occurrence(draft, path), { enabled: true, axisId, choices })
}
function numberAxis(inventory, draft, path, axisId, values, bundle = 'plus', parameter = 'n') {
  enable(draft, path, axisId, values.map(value => choice(inventory, path, bundle, 'n-' + value, { [parameter]: value })))
}
async function generated(spec, draft) {
  const built = await compileCompositionFields(spec, draft)
  const result = await materializeCorpus({ ...spec, corpusPlan: built.plan })
  return { ...built, ...result }
}

test('two exact generic leaf fields produce all sixteen independent nested constructions', async () => {
  const spec = genericFixture(), { inventory, draft } = await fields(spec), before = canonical(spec)
  assert.equal(inventory.rows.length, 5)
  assert.deepEqual(inventory.rows.map(row => row.pathLabel), ['root', 'root/left', 'root/left/item', 'root/right', 'root/right/item'])
  assert.ok(draft.occurrences.every(row => !row.enabled))
  for (const [side, values] of [['left', [1, 2]], ['right', [10, 20]]]) {
    const path = [side, 'item']
    enable(draft, path, side, ['plus', 'minus'].flatMap(bundle => values.map(value => choice(inventory, path, bundle, bundle + '-' + value, { n: value }))))
  }
  draft.coverage.kind = 'pairwise'
  const result = await generated(spec, draft)
  assert.equal(result.construction.requestedAssignments, 16)
  assert.equal(result.manifest.candidateCount, 16); assert.equal(result.tasks.length, 16); assert.equal(result.manifest.status, 'ready')
  const joint = result.manifest.coverage.filter(cell => cell.dimension.includes(' × '))
  assert.equal(joint.length, 16); assert.ok(joint.every(cell => cell.available === 1 && cell.selected === 1))
  const actual = new Set()
  for (const task of result.tasks) {
    const compiled = await compilePrompt(spec.catalog, task.root), left = task.root.slots.left.slots.item, right = task.root.slots.right.slots.item
    assert.equal(compiled.nodeCount, 5); assert.equal(compiled.depth, 2); assert.equal(compiled.checklist.length, 5)
    actual.add([left.use, left.params.n, right.use, right.params.n].join('/'))
    assert.equal(task.expected, null)
  }
  const expected = new Set(['plus/1', 'plus/2', 'minus/1', 'minus/2'].flatMap(left => ['plus/10', 'plus/20', 'minus/10', 'minus/20'].map(right => left + '/' + right)))
  assert.deepEqual(actual, expected); assert.equal(canonical(spec), before)
})

test('independent operational paths retain four complete trees and all 68 requirement targets', async () => {
  const spec = await operationalStarter(), { inventory, draft } = await fields(spec)
  assert.equal(inventory.rows.length, 17); assert.equal(draft.expectedPolicy.kind, 'derive-lean')
  numberAxis(inventory, draft, ['child1', 'buy_process'], 'left-quantity', [1, 2], 'op-shares', 'quantity')
  numberAxis(inventory, draft, ['child2', 'child1', 'buy_process'], 'nested-first-quantity', [3, 4], 'op-shares', 'quantity')
  draft.coverage.kind = 'pairwise'
  const result = await generated(spec, draft)
  assert.equal(result.construction.requestedAssignments, 4); assert.equal(result.tasks.length, 4)
  assert.deepEqual(result.tasks.map(task => task.expected.orders.map(order => order.quantity)), [
    [1, 3, -1, -3, 4, -4], [1, 4, -1, -4, 4, -4], [2, 3, -2, -3, 4, -4], [2, 4, -2, -4, 4, -4],
  ])
  for (const task of result.tasks) {
    const compiled = await compilePrompt(spec.catalog, task.root)
    assert.equal(compiled.nodeCount, 17); assert.equal(compiled.depth, 3)
    assert.deepEqual(task.expected.orders.map(order => order.owner), [
      'root/child1', 'root/child2/child1', 'root/child1', 'root/child2/child1', 'root/child2/child2', 'root/child2/child2',
    ])
    assert.deepEqual(task.expected.positionsFromFills, [{ asset: 'SPY', quantity: 0 }]); assert.equal(task.expected.equityCents.end, 150000)
  }
  const complete = { ...spec, tasks: result.tasks, corpusPlan: result.plan }, requirements = await requirementFieldInventory(complete)
  assert.equal(requirements.rows.length, 68); assert.equal(requirements.rows.length * 4, 272)
  assert.equal(requirements.appendices.length, 4); assert.deepEqual(requirements.blocking, [])
  assert.equal(result.manifest.oracle.independentQualificationRequired, true)
  assert.match(result.construction.scope, /no independent oracle, activation, native validation or study approval is inferred/)
  await assert.rejects(freezeStudy(complete), /needs review/)
})

test('eight operational cases expose the 136-target and 544-case qualification blocker without truncation', async () => {
  const spec = await operationalStarter(), { inventory, draft } = await fields(spec)
  for (const [path, axis, values] of [
    [['child1', 'buy_process'], 'left', [1, 2]],
    [['child2', 'child1', 'buy_process'], 'nested-first', [3, 4]],
    [['child2', 'child2', 'buy_process'], 'nested-second', [1, 2]],
  ]) numberAxis(inventory, draft, path, axis, values, 'op-shares', 'quantity')
  const result = await generated(spec, draft), requirements = await requirementFieldInventory({ ...spec, tasks: result.tasks, corpusPlan: result.plan })
  assert.equal(result.tasks.length, 8); assert.equal(result.manifest.status, 'ready')
  assert.equal(requirements.rows.length, 136); assert.equal(requirements.rows.length * 4, 544)
  assert.equal(requirements.limits.targets, 128); assert.equal(requirements.limits.cases, 512)
  assert.ok(requirements.blocking.some(row => /136.*544.*128.*512/.test(row.reason)))
})

test('parent replacements precede descendant choices regardless of submitted occurrence row order', async () => {
  const spec = genericFixture(), { inventory, draft } = await fields(spec)
  enable(draft, ['left'], 'parent', ['box', 'other-box'].map(bundle => choice(inventory, ['left'], bundle, bundle)))
  numberAxis(inventory, draft, ['left', 'item'], 'leaf', [1, 2])
  const first = await generated(spec, draft), reversed = structuredClone(draft); reversed.occurrences.reverse()
  const second = await generated(spec, reversed)
  assert.deepEqual(second.plan, first.plan); assert.deepEqual(second.tasks, first.tasks)
  assert.equal(first.tasks.length, 4)
  assert.deepEqual(first.tasks.map(task => [task.root.slots.left.use, task.root.slots.left.slots.item.params.n]),
    [['box', 1], ['box', 2], ['other-box', 1], ['other-box', 2]])
  for (const task of first.tasks) assert.deepEqual(task.root.slots.right, spec.tasks[0].root.slots.right)
  assert.deepEqual(first.construction.axisPaths.map(row => row.path), [['left'], ['left', 'item']])
})

test('typed fields preserve zero, false, empty strings and numeric-looking strings through generation', async () => {
  const spec = genericFixture()
  spec.catalog = [{ id: 'scalars', version: '1', kind: 'atom', role: 'node',
    parameters: { amount: 1, enabled: true, label: 'base', code: 'base' },
    parameterSchema: { amount: { type: 'integer', minimum: 0, maximum: 10 }, enabled: { type: 'boolean' }, label: { type: 'string' }, code: { type: 'string' } },
    text: 'Amount={{amount}} Enabled={{enabled}} Label=[{{label}}] Code={{code}}',
    semantics: { kind: 'scalars', amount: '{{amount}}', enabled: '{{enabled}}', label: '{{label}}', code: '{{code}}' } }]
  spec.tasks[0].root = { use: 'scalars' }
  const { inventory, draft } = await fields(spec)
  enable(draft, [], 'scalars', [choice(inventory, [], 'scalars', 'zero', { amount: 0, enabled: false, label: '', code: '0' })])
  const result = await generated(spec, draft), compiled = await compilePrompt(spec.catalog, result.tasks[0].root)
  assert.deepEqual(result.tasks[0].root.params, { amount: 0, code: '0', enabled: false, label: '' })
  assert.equal(compiled.text, 'Amount=0 Enabled=false Label=[] Code=0')
  assert.equal(compiled.semantic.amount, 0); assert.equal(compiled.semantic.enabled, false)
  assert.equal(compiled.semantic.label, ''); assert.equal(compiled.semantic.code, '0')
})

test('compatible replacement schemas expose missing values and refuse absent required or malformed numeric fields', async () => {
  const spec = genericFixture()
  spec.catalog.push({ id: 'schema-number', version: '1', kind: 'atom', role: 'node', parameters: {},
    parameterSchema: { n: { type: 'integer', minimum: 0, maximum: 2 }, note: { type: 'string', required: false } },
    text: 'Schema number {{n}}', semantics: { kind: 'number', n: '{{n}}' } })
  const { inventory, draft } = await fields(spec), path = ['left', 'item']
  const selected = choice(inventory, path, 'schema-number', 'schema')
  assert.deepEqual(selected.parameters.n, { kind: 'number', text: '', present: false })
  assert.deepEqual(selected.parameters.note, { kind: 'string', text: '', present: false })
  enable(draft, path, 'schema', [selected])
  await assert.rejects(compileCompositionFields(spec, draft), /required parameter n/)
  selected.parameters.n.present = true
  for (const text of ['', ' ', '-', '1.5', '-1', '3']) {
    selected.parameters.n.text = text
    await assert.rejects(compileCompositionFields(spec, draft), /numeric|parameter type|minimum|maximum/)
  }
  selected.parameters.n.text = '0'
  const result = await generated(spec, draft)
  assert.deepEqual(result.tasks[0].root.slots.left.slots.item.params, { n: 0 })
  const missingField = structuredClone(draft); delete occurrence(missingField, path).choices[0].parameters.note
  await assert.rejects(compileCompositionFields(spec, missingField), /every declared local parameter field/)
  const extraField = structuredClone(draft); occurrence(extraField, path).choices[0].parameters.invented = { kind: 'number', text: '1', present: true }
  await assert.rejects(compileCompositionFields(spec, extraField), /unsupported field/)
})

test('same task ID and paths cannot reuse fields after input, local semantics, catalog or runtime source changes', async () => {
  const spec = genericFixture(), { inventory, draft } = await fields(spec)
  numberAxis(inventory, draft, ['left', 'item'], 'left', [1, 2])
  for (const change of [
    source => { source.tasks[0].input = { offset: 7 } },
    source => { source.tasks[0].root.slots.left.slots.item.params.n = 9 },
    source => { source.catalog.find(bundle => bundle.id === 'plus').text += ' Changed wording.' },
    source => { source.catalog.find(bundle => bundle.id === 'plus').semantics.operation = 'changed' },
    source => { source.runtimeSources = { 'runner.mjs': '0'.repeat(64) } },
  ]) {
    const changed = structuredClone(spec); change(changed)
    assert.equal(changed.tasks[0].id, spec.tasks[0].id)
    await assert.rejects(compileCompositionFields(changed, draft), /stale|source task.*changed/)
  }
})

test('generic generation requires an explicit declared-answer policy and cannot qualify that answer', async () => {
  const spec = genericFixture(); spec.tasks[0].expected = 'DECLARED PLACEHOLDER'
  const inventory = await compositionFieldInventory(spec, spec.tasks[0].id), draft = createCompositionFieldDraft(inventory)
  draft.rationale = 'This is a construction control, not a scientific result.'
  assert.equal(draft.expectedPolicy.kind, '')
  numberAxis(inventory, draft, ['left', 'item'], 'left', [1, 2])
  await assert.rejects(compileCompositionFields(spec, draft), /Explicitly decide/)
  draft.expectedPolicy.kind = 'reuse-base'
  await assert.rejects(compileCompositionFields(spec, draft), /expected-answer policy rationale/)
  draft.expectedPolicy.rationale = 'Carry the original placeholder solely for inspecting construction.'
  const result = await generated(spec, draft)
  assert.deepEqual(result.tasks.map(task => task.expected), ['DECLARED PLACEHOLDER', 'DECLARED PLACEHOLDER'])
  const project = await freezeStudy(newExperimentDraft({ ...spec, tasks: result.tasks, corpusPlan: result.plan }, { initializePopulation: true }))
  const readiness = evaluateReadiness(project)
  assert.equal(readiness.eligible, false)
  assert.ok(readiness.blockers.some(row => row.code === 'independent-oracle-required'))
})

test('sampling preserves actual joint gaps, and requested matrices and all-selection limits are never truncated', async () => {
  const spec = genericFixture(), { inventory, draft } = await fields(spec)
  numberAxis(inventory, draft, ['left', 'item'], 'left', [1, 2])
  numberAxis(inventory, draft, ['right', 'item'], 'right', [10, 20])
  draft.selection = { kind: 'balanced', limit: '2' }; draft.coverage.kind = 'marginal'
  const marginal = await generated(spec, draft)
  assert.equal(marginal.tasks.length, 2); assert.equal(marginal.manifest.candidateCount, 4); assert.equal(marginal.manifest.status, 'ready')
  assert.equal(marginal.manifest.candidates.filter(row => row.disposition === 'sample-excluded').length, 2)
  draft.coverage.kind = 'pairwise'
  const joint = await generated(spec, draft)
  assert.equal(joint.manifest.status, 'coverage-unmet'); assert.equal(joint.manifest.unmetCoverage.length, 2)
  draft.selection = { kind: 'all', limit: '3' }
  await assert.rejects(generated(spec, draft), /All eligible candidates exceed/)
  for (const side of ['left', 'right']) numberAxis(inventory, draft, [side, 'item'], side, Array.from({ length: 65 }, (_, index) => index))
  await assert.rejects(compileCompositionFields(spec, draft), /4096-candidate budget.*no factor levels were truncated/)
  assert.equal(occurrence(draft, ['left', 'item']).choices.length, 65)
  assert.equal(occurrence(draft, ['right', 'item']).choices.length, 65)
})

test('inventory and field compilation snapshot private source and draft before yielding', async () => {
  const spec = genericFixture(), { inventory, draft } = await fields(spec)
  numberAxis(inventory, draft, ['left', 'item'], 'left', [1, 2])
  const expected = await compileCompositionFields(spec, draft)
  const forInventory = structuredClone(spec), pendingInventory = compositionFieldInventory(forInventory, forInventory.tasks[0].id)
  forInventory.tasks[0].root.slots.left.slots.item.params.n = 999
  forInventory.catalog.find(bundle => bundle.id === 'plus').text = 'Changed after invocation.'
  assert.deepEqual(await pendingInventory, inventory)
  const forCompilation = structuredClone(spec), fieldsForCompilation = structuredClone(draft)
  const pendingCompilation = compileCompositionFields(forCompilation, fieldsForCompilation)
  forCompilation.tasks[0].root.slots.left.slots.item.params.n = 999
  occurrence(fieldsForCompilation, ['left', 'item']).choices[0].parameters.n.text = '777'
  fieldsForCompilation.occurrences.reverse()
  assert.deepEqual(await pendingCompilation, expected)
  assert.equal(forCompilation.tasks[0].root.slots.left.slots.item.params.n, 999, 'The caller retains its separate mutable source.')
})
