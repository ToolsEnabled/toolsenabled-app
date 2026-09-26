import assert from 'node:assert/strict'
import test from 'node:test'
import { canonical, compilePrompt } from '../../src/benchmark/prompts.mjs'
import { compositionFieldInventory, createCompositionFieldDraft, compileCompositionFields } from '../../src/benchmark/corpus.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { operationalStarter } from '../../src/benchmark/trading-catalog.mjs'
import { materializeCorpus, freezeStudy } from '../../src/benchmark/study.mjs'
import { requirementFieldInventory } from '../../src/benchmark/requirement-fields.mjs'
import { evaluateReadiness } from '../../src/benchmark/readiness.mjs'

const copy = path => ({ kind: 'copy', path })
const structural = (id, subtree) => ({ id, subtree })
function rowAt(rows, path) {
  const row = rows.find(row => canonical(row.path) === canonical(path))
  assert.ok(row, 'Missing source occurrence ' + canonical(path)); return row
}
function enable(draft, path, axisId, choices) {
  Object.assign(rowAt(draft.occurrences, path), { enabled: true, axisId, choices })
}
function codecs(parameters, values) {
  const result = structuredClone(parameters)
  for (const [name, value] of Object.entries(values)) result[name] = { kind: typeof value, text: String(value), present: true }
  return result
}
function build(inventory, bundleId, slots = {}, values = {}) {
  const option = inventory.bundles.find(bundle => bundle.bundleId === bundleId)
  assert.ok(option, 'Missing buildable bundle ' + bundleId)
  return { kind: 'bundle', bundleId, parameters: codecs(option.parameters, values), slots }
}
function local(inventory, path, id, values = {}) {
  const row = rowAt(inventory.rows, path)
  return { id, bundleId: row.current.bundleId, parameters: codecs(row.current.parameters, values) }
}
async function fields(spec) {
  const inventory = await compositionFieldInventory(spec, spec.tasks[0].id), draft = createCompositionFieldDraft(inventory)
  draft.rationale = 'Hand-counted topology controls with every branch and factor explicitly declared.'
  draft.expectedPolicy = { kind: spec.domain === 'lean-bench' ? 'derive-lean' : 'reuse-base',
    rationale: 'Construction control only; independent source-bound qualification and applicable reviews remain required.' }
  return { inventory, draft }
}
async function generated(spec, draft) {
  const built = await compileCompositionFields(spec, draft)
  return { ...built, ...await materializeCorpus({ ...spec, corpusPlan: built.plan }) }
}
function pairFixture() {
  const spec = genericStarter()
  spec.catalog = [
    { id: 'pair', version: '1', kind: 'template', role: 'node', slots: { left: 'node', right: 'node' },
      slotOrder: ['left', 'right'], text: '[{{slot:left}},{{slot:right}}]', semantics: { kind: 'pair' } },
    { id: 'box', version: '1', kind: 'template', role: 'node', slots: { item: 'node' },
      text: '({{slot:item}})', semantics: { kind: 'box' } },
    { id: 'number', version: '1', kind: 'atom', role: 'node', parameters: { n: 0 },
      parameterSchema: { n: { type: 'integer', minimum: 0 } }, text: '{{n}}', semantics: { kind: 'number', n: '{{n}}' } },
  ]
  spec.protocol.grading = { kind: 'json' }
  spec.tasks = [{ id: 'topology-pair', split: 'development', input: null, expected: null,
    root: { use: 'pair', slots: { left: { use: 'number', params: { n: 1 } }, right: { use: 'number', params: { n: 10 } } } } }]
  return spec
}
function typedFixture() {
  const spec = genericStarter()
  spec.catalog = [
    { id: 'program', version: '1', kind: 'template', role: 'node', slots: { condition: 'boolean', body: 'number', audit: '*' },
      slotOrder: ['condition', 'body', 'audit'], text: 'if {{slot:condition}} then {{slot:body}} audit {{slot:audit}}', semantics: { kind: 'program' } },
    { id: 'sum', version: '1', kind: 'template', role: 'number', slots: { left: 'number', right: 'number' },
      text: '({{slot:left}}+{{slot:right}})', semantics: { kind: 'sum' } },
    { id: 'not', version: '1', kind: 'template', role: 'boolean', slots: { value: 'boolean' },
      text: 'not {{slot:value}}', semantics: { kind: 'not' } },
    { id: 'number', version: '1', kind: 'atom', role: 'number', parameters: { n: 5, label: 'base' },
      parameterSchema: { n: { type: 'integer', minimum: 0, maximum: 10 }, label: { type: 'string' } },
      text: '{{label}}:{{n}}', semantics: { kind: 'number', n: '{{n}}', label: '{{label}}' } },
    { id: 'boolean', version: '1', kind: 'atom', role: 'boolean', parameters: { value: true },
      parameterSchema: { value: { type: 'boolean' } }, text: '{{value}}', semantics: { kind: 'boolean', value: '{{value}}' } },
    { id: 'required-number', version: '1', kind: 'atom', role: 'number', parameters: {},
      parameterSchema: { n: { type: 'integer', minimum: 0 }, note: { type: 'string', required: false } },
      text: '{{n}}', semantics: { kind: 'number', n: '{{n}}' } },
  ]
  spec.protocol.grading = { kind: 'json' }
  spec.tasks = [{ id: 'typed-topology', split: 'held-out', input: null, expected: null,
    root: { use: 'program', slots: { condition: { use: 'boolean' }, body: { use: 'number' }, audit: { use: 'boolean', params: { value: false } } } } }]
  return spec
}

test('explicit operational 2/3/4-child branches retain 17/22/27 nodes and all 66 qualification targets', async () => {
  const spec = await operationalStarter(), { inventory, draft } = await fields(spec), before = canonical(spec)
  assert.equal(inventory.version, 2); assert.equal(draft.version, 2)
  assert.equal(rowAt(inventory.rows, []).subtreeNodes, 17)
  assert.equal(rowAt(inventory.rows, ['child1']).subtreeNodes, 5)
  assert.equal(rowAt(inventory.rows, ['child2']).subtreeNodes, 11)
  enable(draft, [], 'root-arity', [2, 3, 4].map(arity => {
    const slots = { child1: copy(['child1']), child2: copy(['child2']) }
    if (arity >= 3) slots.child3 = copy(['child1'])
    if (arity >= 4) slots.child4 = copy(['child2', 'child1'])
    return structural('arity-' + arity, build(inventory, 'op-all-' + arity, slots))
  }))
  const result = await generated(spec, draft)
  assert.equal(result.tasks.length, 3); assert.equal(result.manifest.candidateCount, 3)
  assert.equal(result.manifest.status, 'ready'); assert.equal(result.construction.requestedAssignments, 3)
  assert.deepEqual(result.construction.structuralAxisPaths.map(row => row.path), [[]])
  const nodeCounts = [], ownershipSets = []
  for (const task of result.tasks) {
    const compiled = await compilePrompt(spec.catalog, task.root)
    nodeCounts.push(compiled.nodeCount)
    assert.equal(compiled.checklist.length, compiled.nodeCount)
    assert.equal(new Set(compiled.composition.nodes.map(node => node.path)).size, compiled.nodeCount)
    assert.deepEqual(task.root.slots.child1, spec.tasks[0].root.slots.child1)
    assert.deepEqual(task.root.slots.child2, spec.tasks[0].root.slots.child2)
    const owners = [...new Set(task.expected.orders.map(order => order.owner))].sort()
    ownershipSets.push(owners)
    for (const owner of owners) {
      const quantities = task.expected.orders.filter(order => order.owner === owner).map(order => order.quantity)
      assert.ok(quantities.some(quantity => quantity > 0), owner + ' retains its own entry intent.')
      assert.ok(quantities.some(quantity => quantity < 0), owner + ' retains its own exit intent.')
    }
    assert.deepEqual(task.expected.positionsFromFills, [{ asset: 'SPY', quantity: 0 }])
    assert.equal(task.expected.equityCents.end, 150000)
  }
  assert.deepEqual(nodeCounts, [17, 22, 27])
  assert.deepEqual(ownershipSets, [
    ['root/child1', 'root/child2/child1', 'root/child2/child2'],
    ['root/child1', 'root/child2/child1', 'root/child2/child2', 'root/child3'],
    ['root/child1', 'root/child2/child1', 'root/child2/child2', 'root/child3', 'root/child4'],
  ])
  const complete = { ...spec, tasks: result.tasks, corpusPlan: result.plan }, requirements = await requirementFieldInventory(complete)
  assert.equal(requirements.rows.length, 66); assert.equal(requirements.rows.length * 4, 264)
  assert.equal(requirements.appendices.length, 3); assert.deepEqual(requirements.blocking, [])
  assert.equal(result.manifest.oracle.independentQualificationRequired, true)
  assert.match(result.construction.scope, /no independent oracle, activation, native validation or study approval is inferred/)
  await assert.rejects(freezeStudy(complete), /needs review/)
  assert.equal(canonical(spec), before)
})

test('recursive generic builds preserve typed roles, numeric zero, false and numeric-looking strings', async () => {
  const spec = typedFixture(), { inventory, draft } = await fields(spec)
  assert.equal(rowAt(inventory.rows, ['audit']).requiredRole, '*')
  assert.equal(rowAt(inventory.rows, ['audit']).role, 'boolean')
  assert.deepEqual(rowAt(inventory.rows, []).slots, { audit: '*', body: 'number', condition: 'boolean' })
  enable(draft, [], 'expression', [structural('nested', build(inventory, 'program', {
    condition: build(inventory, 'not', { value: build(inventory, 'boolean', {}, { value: false }) }),
    body: build(inventory, 'sum', { left: build(inventory, 'number', {}, { n: 0, label: '0' }), right: copy(['body']) }),
    audit: copy(['audit']),
  }))])
  const result = await generated(spec, draft), task = result.tasks[0], compiled = await compilePrompt(spec.catalog, task.root)
  assert.equal(result.tasks.length, 1); assert.equal(compiled.nodeCount, 7); assert.equal(compiled.depth, 2)
  assert.equal(compiled.text, 'if not false then (0:0+base:5) audit false')
  const nodes = new Map(compiled.composition.nodes.map(node => [node.path, node]))
  assert.deepEqual(nodes.get('root/body/left').parameters, { label: '0', n: 0 })
  assert.equal(nodes.get('root/body/left').semantic.n, 0)
  assert.equal(nodes.get('root/body/left').semantic.label, '0')
  assert.equal(nodes.get('root/condition/value').semantic.value, false)
  assert.deepEqual(nodes.get('root/body').ports.map(port => port.role), ['number', 'number'])
  assert.equal(task.split, 'held-out'); assert.equal(task.expected, null)
})

test('a copied source sibling stays independent of the sibling factor and every generated occurrence owns its data', async () => {
  const spec = pairFixture(), { inventory, draft } = await fields(spec), before = canonical(spec)
  enable(draft, ['left'], 'left-value', [local(inventory, ['left'], 'one', { n: 1 }), local(inventory, ['left'], 'two', { n: 2 })])
  enable(draft, ['right'], 'right-branch', [structural('copy-original-left', copy(['left'])),
    structural('twenty', build(inventory, 'number', {}, { n: 20 }))])
  draft.coverage.kind = 'pairwise'
  const result = await generated(spec, draft), reverse = structuredClone(draft); reverse.occurrences.reverse()
  assert.deepEqual((await generated(spec, reverse)).tasks, result.tasks)
  assert.deepEqual(result.tasks.map(task => [task.root.slots.left.params.n, task.root.slots.right.params.n]), [[1, 1], [1, 20], [2, 1], [2, 20]])
  assert.equal(result.manifest.candidateCount, 4); assert.equal(result.manifest.status, 'ready')
  result.tasks[0].root.slots.left.params.n = 999
  assert.equal(result.tasks[0].root.slots.right.params.n, 1)
  assert.equal(result.tasks[2].root.slots.right.params.n, 1)
  assert.equal(canonical(spec), before)
})

test('unfilled, missing and extra children refuse compilation instead of inheriting or duplicating source children', async () => {
  const spec = pairFixture(), { inventory, draft } = await fields(spec)
  const invalid = [
    { subtree: { kind: 'unfilled' }, pattern: /fill|unfilled/i },
    { subtree: build(inventory, 'pair', { left: copy(['left']) }), pattern: /slot|child|fill/i },
    { subtree: build(inventory, 'pair', { left: copy(['left']), right: { kind: 'unfilled' } }), pattern: /fill|unfilled/i },
    { subtree: build(inventory, 'pair', { left: copy(['left']), right: copy(['right']), extra: copy(['left']) }), pattern: /slot|child|unsupported/i },
    { subtree: build(inventory, 'number', { invented: copy(['left']) }), pattern: /slot|child|unsupported/i },
  ]
  for (const { subtree, pattern } of invalid) {
    enable(draft, [], 'invalid', [structural('unfinished', subtree)])
    const retained = canonical(draft)
    await assert.rejects(compileCompositionFields(spec, draft), pattern)
    assert.equal(canonical(draft), retained, 'Rejected fields retain the authored incomplete state.')
  }
})

test('copy validation uses actual roles even under a wildcard source port and refuses unknown source paths', async () => {
  const spec = typedFixture(), { inventory, draft } = await fields(spec)
  for (const subtree of [copy(['condition']), copy(['audit']), build(inventory, 'boolean')]) {
    enable(draft, ['body'], 'wrong-role', [structural('wrong', subtree)])
    await assert.rejects(compileCompositionFields(spec, draft), /role|number/i)
  }
  for (const path of [['missing'], ['body', 'missing'], ['../condition']]) {
    enable(draft, ['body'], 'wrong-path', [structural('missing', copy(path))])
    await assert.rejects(compileCompositionFields(spec, draft), /path|source|occurrence|slot/i)
  }
  rowAt(draft.occurrences, ['body']).enabled = false
  enable(draft, [], 'wrong-root-role', [structural('atom', copy(['audit']))])
  await assert.rejects(compileCompositionFields(spec, draft), /role|node/i)
})

test('whole-branch factors refuse overlapping descendants even when a copied choice retains their old paths', async () => {
  const spec = pairFixture(), { inventory, draft } = await fields(spec)
  enable(draft, [], 'entire-root', [structural('original', copy([]))])
  enable(draft, ['left'], 'descendant', [local(inventory, ['left'], 'two', { n: 2 })])
  await assert.rejects(compileCompositionFields(spec, draft), /descendant|overlap/i)
  draft.occurrences.reverse()
  await assert.rejects(compileCompositionFields(spec, draft), /descendant|overlap/i)
  rowAt(draft.occurrences, ['left']).enabled = false
  assert.equal((await generated(spec, draft)).tasks.length, 1)
})

test('recursive parameter codecs require complete schemas and retain optional absence without scalar coercion', async () => {
  const spec = typedFixture(), { inventory, draft } = await fields(spec)
  const subtree = build(inventory, 'sum', { left: build(inventory, 'required-number'), right: copy(['body']) })
  enable(draft, ['body'], 'schema', [structural('required', subtree)])
  assert.deepEqual(subtree.slots.left.parameters.n, { kind: 'number', text: '', present: false })
  await assert.rejects(compileCompositionFields(spec, draft), /required parameter n/)
  Object.assign(subtree.slots.left.parameters.n, { present: true, text: '0' })
  const result = await generated(spec, draft)
  assert.deepEqual(result.tasks[0].root.slots.body.slots.left.params, { n: 0 })
  for (const field of [ { kind: 'number', text: '', present: true }, { kind: 'number', text: '1.5', present: true },
    { kind: 'string', text: '0', present: true }, { kind: 'number', text: '-1', present: true } ]) {
    subtree.slots.left.parameters.n = field
    await assert.rejects(compileCompositionFields(spec, draft), /numeric|parameter type|minimum/)
  }
  subtree.slots.left.parameters.n = { kind: 'number', text: '0', present: true }
  delete subtree.slots.left.parameters.note
  await assert.rejects(compileCompositionFields(spec, draft), /every declared local parameter field/)
})

test('structural drafts require version two while current-bound legacy local drafts remain equivalent', async () => {
  const spec = pairFixture(), { inventory, draft } = await fields(spec)
  enable(draft, ['left'], 'left-value', [local(inventory, ['left'], 'two', { n: 2 })])
  const modern = await generated(spec, draft), legacy = structuredClone(draft); legacy.version = 1
  const prior = await generated(spec, legacy)
  assert.deepEqual(prior.plan, modern.plan); assert.deepEqual(prior.tasks, modern.tasks)
  enable(legacy, ['left'], 'left-value', [structural('copy', copy(['right']))])
  await assert.rejects(compileCompositionFields(spec, legacy), /version.*2|version two/i)
})

test('structural copying binds source input and semantics and snapshots both source and nested draft before yielding', async () => {
  const spec = pairFixture(), { inventory, draft } = await fields(spec)
  enable(draft, ['right'], 'copy', [structural('original-left', copy(['left']))])
  const expected = await compileCompositionFields(spec, draft)
  for (const change of [
    source => { source.tasks[0].input = { offset: 1 } },
    source => { source.tasks[0].root.slots.left.params.n = 9 },
    source => { source.catalog.find(bundle => bundle.id === 'number').semantics.kind = 'different' },
  ]) {
    const changed = structuredClone(spec); change(changed)
    await assert.rejects(compileCompositionFields(changed, draft), /stale|source task.*changed/)
  }
  const callerSource = structuredClone(spec), callerDraft = structuredClone(draft)
  const pending = compileCompositionFields(callerSource, callerDraft)
  callerSource.tasks[0].root.slots.left.params.n = 999
  rowAt(callerDraft.occurrences, ['right']).choices[0].subtree.path[0] = 'right'
  assert.deepEqual(await pending, expected)
  const project = await freezeStudy(newExperimentDraft({ ...spec, tasks: (await generated(spec, draft)).tasks, corpusPlan: expected.plan }, { initializePopulation: true }))
  assert.equal(evaluateReadiness(project).eligible, false)
  assert.ok(evaluateReadiness(project).blockers.some(row => row.code === 'independent-oracle-required'))
  assert.equal(inventory.bindingSha256, expected.construction.sourceBindingSha256)
})

test('copy expansion consumes the actual 4096-node budget and recursive builds have no invented depth-64 limit', async () => {
  const spec = pairFixture()
  let source = { use: 'number', params: { n: 1 } }
  for (let level = 0; level < 10; level++) source = { use: 'pair', slots: { left: source, right: source } }
  spec.tasks[0].root = source // 2^11 - 1 = 2047 occurrences, despite shared JavaScript references.
  const { inventory, draft } = await fields(spec)
  assert.equal(inventory.rows.length, 2047); assert.equal(rowAt(inventory.rows, []).subtreeNodes, 2047)
  const twoCopies = build(inventory, 'pair', { left: copy([]), right: copy([]) }) // 4095 nodes.
  enable(draft, [], 'bounded', [structural('exact-bound', build(inventory, 'box', { item: twoCopies }))])
  const atLimit = await generated(spec, draft)
  assert.equal(atLimit.tasks.length, 1)
  assert.equal((await compilePrompt(spec.catalog, atLimit.tasks[0].root)).nodeCount, 4096)
  rowAt(draft.occurrences, []).choices[0].subtree = build(inventory, 'box', { item: build(inventory, 'box', { item: twoCopies }) })
  await assert.rejects(compileCompositionFields(spec, draft), /4096.*node|node.*4096/i)

  // A three-node replacement is locally legal, but 4095 - 1 + 3 = 4097 at its destination.
  const nearLimit = pairFixture()
  nearLimit.tasks[0].root = { use: 'pair', slots: { left: source, right: source } }
  const near = await fields(nearLimit), leftLeaf = Array(11).fill('left'), rightLeaf = Array(11).fill('right')
  assert.equal(near.inventory.rows.length, 4095)
  enable(near.draft, leftLeaf, 'small-replacement', [structural('three-nodes', build(near.inventory, 'pair', {
    left: copy(leftLeaf), right: copy(rightLeaf),
  }))])
  const combined = await generated(nearLimit, near.draft)
  assert.equal(combined.tasks.length, 0); assert.equal(combined.manifest.status, 'empty')
  assert.equal(combined.manifest.candidateCount, 1)
  assert.equal(combined.manifest.candidates[0].disposition, 'construction-excluded')
  assert.equal(combined.manifest.candidates[0].reasons[0].reason, 'Generated task exceeds the 4,096-component budget.')
  assert.ok(combined.manifest.unmetCoverage.length > 0)

  const small = pairFixture(), prepared = await fields(small)
  let deep = copy(['left'])
  for (let level = 0; level < 70; level++) deep = build(prepared.inventory, 'box', { item: deep })
  enable(prepared.draft, [], 'depth', [structural('seventy', deep)])
  const result = await generated(small, prepared.draft), compiled = await compilePrompt(small.catalog, result.tasks[0].root)
  assert.equal(compiled.nodeCount, 71); assert.equal(compiled.depth, 70)
})

test('structural choice matrices preserve sampling gaps and refuse candidate or selection overflow', async () => {
  const spec = pairFixture(), { inventory, draft } = await fields(spec)
  for (const [side, values] of [['left', [1, 2]], ['right', [10, 20]]])
    enable(draft, [side], side, values.map(n => structural('n-' + n, build(inventory, 'number', {}, { n }))))
  const forward = await compileCompositionFields(spec, draft), reversed = structuredClone(draft); reversed.occurrences.reverse()
  const backward = await compileCompositionFields(spec, reversed)
  assert.deepEqual(backward.plan, forward.plan)
  assert.deepEqual(backward.construction, forward.construction)
  draft.coverage.kind = 'pairwise'; draft.selection = { kind: 'balanced', limit: '2' }
  const sampled = await generated(spec, draft)
  assert.equal(sampled.tasks.length, 2); assert.equal(sampled.manifest.candidateCount, 4)
  assert.equal(sampled.manifest.status, 'coverage-unmet'); assert.equal(sampled.manifest.unmetCoverage.length, 2)
  assert.equal(sampled.manifest.candidates.filter(row => row.disposition === 'sample-excluded').length, 2)
  draft.selection = { kind: 'all', limit: '3' }
  await assert.rejects(generated(spec, draft), /All eligible candidates exceed/)
  for (const side of ['left', 'right']) enable(draft, [side], side,
    Array.from({ length: 65 }, (_, n) => structural('n-' + n, build(inventory, 'number', {}, { n }))))
  await assert.rejects(compileCompositionFields(spec, draft), /4096-candidate budget.*no factor levels were truncated/)
  assert.equal(rowAt(draft.occurrences, ['left']).choices.length, 65)
  assert.equal(rowAt(draft.occurrences, ['right']).choices.length, 65)
})
