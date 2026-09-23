import assert from 'node:assert/strict'
import test from 'node:test'
import { informationFieldInventory, createInformationFieldDraft, addInformationFieldReading, compileInformationFields } from '../../src/research-information-fields.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { operationalStarter } from '../../src/benchmark/trading-catalog.mjs'
import { informationFixture, leanInformationFixture } from './fixtures/research-benchmark-information.mjs'
import { canonical, compilePrompt } from '../../src/benchmark/prompts.mjs'

const clone = value => structuredClone(value)
const modern = spec => newExperimentDraft(spec, { initializePopulation: true })
const owned = value => {
  const seen = new Set(), pending = [value]
  while (pending.length) {
    const next = pending.pop()
    if (!next || typeof next !== 'object' || seen.has(next)) continue
    seen.add(next); pending.push(...Object.values(next))
  }
  return seen
}
function assertPrivate(result, ...sources) {
  const inputs = new Set(sources.flatMap(value => [...owned(value)]))
  for (const value of owned(result)) assert.equal(inputs.has(value), false)
}
async function prepare(spec) {
  const inventory = await informationFieldInventory(spec, spec.tasks[0].id)
  return { inventory, draft: createInformationFieldDraft(inventory) }
}
const edit = (path, parameter, kind, text) => ({ path, parameter, kind, text })

test('real nested operational alternatives are built from explicit occurrence values while all 17 nodes and siblings remain exact', async () => {
  const spec = modern(await operationalStarter()), original = clone(spec), { inventory } = await prepare(spec)
  assert.equal(inventory.atoms.length, 12)
  assert.equal(inventory.sources.length, 1)
  assert.ok(inventory.atoms.some(atom => atom.path === 'root/child1/buy_process'))
  let draft = createInformationFieldDraft(inventory)
  assert.deepEqual(draft.readings, []); assert.deepEqual(draft.withheldPaths, []); assert.equal(draft.rationale, '')
  draft.rationale = 'Explicit synthetic local quantity alternatives; no completeness or approval claim.'
  draft.withheldPaths = ['root/child1/buy_process']
  for (const quantity of [2, 4]) {
    draft = addInformationFieldReading(inventory, draft, 'baseline')
    const row = draft.readings.at(-1)
    assert.equal(row.id, ''); assert.equal(row.rationale, '')
    row.id = 'quantity-' + quantity; row.rationale = 'Explicit quantity ' + quantity
    row.edits = [edit(['child1', 'buy_process'], 'quantity', 'number', String(quantity))]
    row.expected = { mode: 'derive-lean', text: '' }
  }
  const raw = clone(draft), result = await compileInformationFields(spec, draft)
  assert.deepEqual(result.task.root, original.tasks[0].root)
  assert.deepEqual(result.task.input, original.tasks[0].input)
  assert.deepEqual(result.task.expected, original.tasks[0].expected)
  assert.equal(result.task.information.version, 1); assert.equal(result.compiled.informationPacket.version, 2)
  assert.equal(result.compiled.interpretations.length, 2)
  for (const [index, reading] of result.compiled.interpretations.entries()) {
    assert.equal(reading.compiled.composition.nodes.length, 17)
    assert.equal(reading.compiled.text, result.compiled.compiled.text)
    assert.deepEqual(reading.root.slots.child2, original.tasks[0].root.slots.child2)
    assert.equal(reading.expected.lots.filter(lot => lot.owner === 'root/child1').reduce((sum, lot) => sum + lot.boughtQuantity, 0), [2, 4][index])
    assert.deepEqual(result.task.information.readings[index].expected, reading.expected)
  }
  assert.deepEqual(spec, original); assert.deepEqual(draft, raw)
  assertPrivate(result, spec, draft, inventory)
  assert.equal(Object.hasOwn(result.task, 'taskReviews'), false)
})

test('existing advanced reading roots, labels, variables, conventions and expected values round-trip without hidden hydration loss', async () => {
  const spec = modern(informationFixture()), task = spec.tasks[0]
  task.information.readings[0].label = ''
  task.information.readings[0].variables = { advancedFlag: false, numericText: '7', zero: 0 }
  task.information.readings[0].conventions = { quantity: 1, declared: false, label: '' }
  task.information.readings[1].conventions = {}
  const before = clone(spec), { inventory, draft } = await prepare(spec)
  assert.equal(draft.readings[0].label, ''); assert.equal(draft.readings[1].label, null)
  assert.equal(draft.readings[1].conventionsText, '{}')
  assert.equal(inventory.sources[1].reading.variables.advancedFlag, false)
  const result = await compileInformationFields(spec, draft)
  assert.deepEqual(result.task, task)
  assert.deepEqual(result.task.information.readings.map(row => row.id), ['number-1', 'number-2'])
  assert.equal(Object.hasOwn(result.task.information.readings[1], 'variables'), false)
  assert.equal(Object.hasOwn(result.task.information.readings[1], 'label'), false)
  assert.deepEqual(spec, before); assertPrivate(result, spec, inventory, draft)
})

test('unchanged LEAN readings retain absent expected values while the existing interpreter still derives their distinct observations', async () => {
  const spec = modern(leanInformationFixture()), before = clone(spec), { draft } = await prepare(spec)
  assert.equal(draft.readings.every(row => row.expected.mode === 'retained'), true)
  const result = await compileInformationFields(spec, draft)
  assert.deepEqual(result.task, before.tasks[0])
  assert.equal(result.task.information.readings.every(row => !Object.hasOwn(row, 'expected')), true)
  assert.notEqual(canonical(result.compiled.interpretations[0].expected), canonical(result.compiled.interpretations[1].expected))
  assert.deepEqual(spec, before)
})

test('edited generic readings require a fresh explicit expected observation and never silently reuse or derive a source answer', async () => {
  const spec = modern(informationFixture()), { draft } = await prepare(spec)
  draft.readings[0].edits = [edit(['rule'], 'value', 'number', '3')]
  const retained = clone(draft)
  await assert.rejects(compileInformationFields(spec, draft), /fresh expected observation/)
  assert.deepEqual(draft, retained)
  draft.readings[0].expected = { mode: 'derive-lean', text: '' }
  await assert.rejects(compileInformationFields(spec, draft), /generic readings require an explicit declaration/)
  draft.readings[0].expected = { mode: 'declare', text: '3' }
  const result = await compileInformationFields(spec, draft)
  assert.equal(result.task.information.readings[0].expected, 3)
  assert.equal(result.task.information.readings[0].root.slots.rule.params.value, 3)
  assert.equal(result.task.expected, 2); assert.equal(spec.tasks[0].information.readings[0].expected, 1)
  draft.readings[0].expected.text = '1e'
  await assert.rejects(compileInformationFields(spec, draft), /valid JSON expected observation/)
  assert.equal(draft.readings[0].expected.text, '1e')
})

function scalarFixture() {
  const spec = modern(genericStarter())
  spec.catalog = [{ id: 'scalar', version: '1', kind: 'atom', text: 'Use {{n}} {{flag}} {{word}}.',
    parameters: { n: 1, flag: true, word: 'source' }, parameterSchema: { n: { type: 'integer', minimum: 0, maximum: 4 }, flag: { type: 'boolean' }, word: { type: 'string' }, optional: { type: 'boolean', required: false } },
    semantics: { kind: 'scalar-values', number: '{{n}}', boolean: '{{flag}}', text: '{{word}}' } }]
  spec.tasks = [{ id: 'scalar-task', root: { use: 'scalar' }, input: null, expected: { number: 1, boolean: true, text: 'source' }, split: 'development' }]
  spec.protocol.grading = { kind: 'json' }
  return spec
}

test('local fields preserve zero, false, empty/numeric strings and absent optional parameters; invalid text remains raw', async () => {
  const spec = scalarFixture(), { inventory } = await prepare(spec)
  const optional = inventory.sources[0].parameters.find(row => row.name === 'optional')
  assert.deepEqual({ kind: optional.kind, text: optional.text, present: optional.present }, { kind: 'boolean', text: '', present: false })
  let draft = createInformationFieldDraft(inventory)
  draft.rationale = 'Explicit scalar control'; draft.withheldPaths = ['root']
  draft = addInformationFieldReading(inventory, draft, 'baseline')
  const row = draft.readings[0]; row.id = 'literal-scalars'; row.rationale = 'Literal, independently supplied expected values.'
  row.edits = [edit([], 'n', 'number', '0'), edit([], 'flag', 'boolean', 'false'), edit([], 'word', 'string', ''), edit([], 'optional', 'boolean', 'false')]
  row.expected = { mode: 'declare', text: '{"number":0,"boolean":false,"text":""}' }
  const result = await compileInformationFields(spec, draft)
  assert.deepEqual(result.task.information.readings[0].root.params, { n: 0, flag: false, word: '', optional: false })
  row.edits[2].text = '7'; row.expected.text = '{"number":0,"boolean":false,"text":"7"}'
  assert.equal((await compileInformationFields(spec, draft)).compiled.interpretations[0].compiled.semantic.text, '7')
  for (const [index, next, pattern] of [[0, '1e', /finite numeric/], [0, '', /finite numeric/], [0, '5', /above its maximum/], [1, '0', /true or false/]]) {
    const invalid = clone(draft); invalid.readings[0].edits[index].text = next
    await assert.rejects(compileInformationFields(spec, invalid), pattern)
    assert.equal(invalid.readings[0].edits[index].text, next)
  }
  const wrongType = clone(draft); wrongType.readings[0].edits[2].kind = 'number'
  await assert.rejects(compileInformationFields(spec, wrongType), /source scalar type/)
})

test('the complete applied task, context, catalog and runtime binding refuses stale drafts without rebasing their text', async () => {
  const spec = modern(informationFixture()), { draft } = await prepare(spec), raw = clone(draft)
  const changes = [
    next => { next.tasks[0].input = { changed: true } },
    next => { next.tasks[0].information.rationale += ' changed' },
    next => { next.conditions[0].model.settings.temperature = 0.6 },
    next => { next.conditions[0].collection = { instructions: { system: 'Changed visible context', developer: null } } },
    next => { next.workflowPlan = { version: 1, workflows: [] } },
    next => { next.catalog[0].text += ' Changed wording.' },
    next => { next.runtimeSources = { 'tasks.mjs': '0'.repeat(64) } },
  ]
  for (const change of changes) {
    const next = clone(spec); change(next)
    await assert.rejects(compileInformationFields(next, draft), /Information fields are stale/)
    assert.deepEqual(draft, raw)
  }
})

test('inventory and compilation privately capture spec and draft before asynchronous work', async () => {
  const spec = modern(informationFixture()), original = clone(spec)
  const pendingInventory = informationFieldInventory(spec, spec.tasks[0].id)
  spec.conditions[0].model.id = 'changed-during-inventory'
  const inventory = await pendingInventory, baseline = await informationFieldInventory(original, original.tasks[0].id)
  assert.equal(inventory.bindingSha256, baseline.bindingSha256)
  const draft = createInformationFieldDraft(inventory), before = clone(draft), pendingCompile = compileInformationFields(original, draft)
  original.conditions[0].model.id = 'changed-during-compilation'; draft.rationale = 'changed-during-compilation'
  const result = await pendingCompile
  assert.equal(result.task.information.rationale, before.rationale)
  assert.equal(result.compiled.informationPacket.collectionContext.conditions[0].model.id, informationFixture().conditions[0].model.id)
  assertPrivate(result, original, draft, inventory)
})

test('atom-only paths, source identities, exact edit shapes and duplicate rows fail closed', async () => {
  const spec = modern(informationFixture()), { inventory, draft } = await prepare(spec)
  const cases = [
    next => { next.withheldPaths = ['root'] },
    next => { next.withheldPaths = ['root/missing'] },
    next => { next.withheldPaths.push('root/rule') },
    next => { next.readings[0].sourceKey = 'reading:missing' },
    next => { next.readings[0].id = next.readings[1].id },
    next => { next.readings[0].key = next.readings[1].key },
    next => { next.readings[0].root = { use: 'rule' } },
    next => { next.readings[0].edits = [edit(['missing'], 'value', 'number', '3')] },
    next => { next.readings[0].edits = [edit(['rule'], 'absent', 'number', '3')] },
    next => { next.readings[0].edits = [edit(['rule'], 'value', 'number', '3'), edit(['rule'], 'value', 'number', '4')]; next.readings[0].expected.mode = 'declare'; next.readings[0].expected.text = '4' },
    next => { next.readings[0].conventionsText = '{"invalid":null}' },
    next => { next.version = 2 },
  ]
  for (const mutate of cases) {
    const invalid = clone(draft); mutate(invalid); const raw = clone(invalid)
    await assert.rejects(compileInformationFields(spec, invalid)); assert.deepEqual(invalid, raw)
  }
  assert.throws(() => addInformationFieldReading(inventory, draft, 'missing'), /Explicitly choose/)
  const empty = clone(draft); empty.readings = []
  await assert.rejects(compileInformationFields(spec, empty), /Explicitly add at least one/)
  const full = clone(draft); full.readings = Array.from({ length: 64 }, (_, index) => ({ ...clone(draft.readings[0]), key: 'row-' + index }))
  assert.throws(() => addInformationFieldReading(inventory, full, 'baseline'), /at most 64/)
})

test('pool exclusions and explicit-reading refusals are produced by the existing compiled-fragment comparison', async () => {
  const spec = modern(informationFixture()), { draft } = await prepare(spec)
  draft.withheldPaths = []; draft.selection = 'readingPool'
  const result = await compileInformationFields(spec, draft)
  assert.deepEqual(result.compiled.informationSelection.candidates.map(row => [row.id, row.disposition]), [['number-1', 'disclosed-conflict'], ['number-2', 'retained']])
  assert.deepEqual(result.task.information.readingPool.map(row => row.id), ['number-1', 'number-2'])
  assert.deepEqual(result.compiled.interpretations.map(row => row.id), ['number-2'])
  draft.selection = 'readings'
  await assert.rejects(compileInformationFields(spec, draft), /changes disclosed prompt content/)
})

test('dedicated corpus, audit and resource sources cannot be detached by the reading fields', async () => {
  const spec = modern(informationFixture())
  for (const [mutation, pattern] of [
    [next => { next.corpusPlan = {} }, /Detach the generated task recipe/],
    [next => { next.auditPlan = {} }, /audit recipe/],
    [next => { next.tasks[0].audit = {} }, /audit recipe/],
    [next => { next.experimentTemplate = {} }, /resource template/],
    [next => { next.tasks[0].resource = {} }, /resource template/],
  ]) {
    const next = clone(spec); mutation(next); const before = clone(next)
    await assert.rejects(informationFieldInventory(next, next.tasks[0].id), pattern)
    assert.deepEqual(next, before)
  }
})

test('non-scalar effective variables remain rejected by the unchanged canonical compiler rather than silently omitted', async () => {
  for (const invalid of [{ object: true }, [1, 2], null]) {
    const spec = modern(informationFixture())
    spec.tasks[0].information.readings[0].variables = { advanced: invalid }
    const reading = spec.tasks[0].information.readings[0], before = clone(spec)
    await assert.rejects(compilePrompt(spec.catalog, reading.root, { variables: reading.variables }), /parameters must be finite scalar values/)
    await assert.rejects(informationFieldInventory(spec, spec.tasks[0].id), /parameters must be finite scalar values/)
    assert.deepEqual(spec, before)
  }
})

test('a supported JSON parameter key becomes an own local override without a prototype setter swallowing the edit', async () => {
  const spec = modern(informationFixture())
  spec.tasks[0].information.readings[0].variables = JSON.parse('{"__proto__":0}')
  const { draft } = await prepare(spec)
  draft.readings[0].edits = [edit([], '__proto__', 'number', '7')]
  draft.readings[0].expected = { mode: 'declare', text: '1' }
  const result = await compileInformationFields(spec, draft), params = result.task.information.readings[0].root.params
  assert.equal(Object.hasOwn(params, '__proto__'), true)
  assert.equal(params.__proto__, 7)
  assert.equal(Object.getPrototypeOf(params), Object.prototype)
  assert.equal(result.compiled.interpretations[0].compiled.composition.nodes[0].parameters.__proto__, 7)
  assert.equal(Object.hasOwn(spec.tasks[0].information.readings[0].root, 'params'), false)
})
