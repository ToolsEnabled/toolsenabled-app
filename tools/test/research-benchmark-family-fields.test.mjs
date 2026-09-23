import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { compositionFieldInventory, createCompositionFieldDraft, compileCompositionFamilyFields, validateCorpusPlan, corpusProjectFiles } from '../../src/benchmark/corpus.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { materializeCorpus, freezeStudy } from '../../src/benchmark/study.mjs'
import { requirementFieldInventory } from '../../src/benchmark/requirement-fields.mjs'
import { analyze, resolveAnalysisPopulation } from '../../src/benchmark/analysis.mjs'
import { evaluateReadiness } from '../../src/benchmark/readiness.mjs'

function fixture(count = 2, paired = false) {
  const spec = genericStarter()
  spec.catalog = [
    { id: 'number', version: '1', kind: 'atom', role: 'node', parameters: { n: 0 },
      parameterSchema: { n: { type: 'integer', minimum: 0 } }, text: 'Variant {{n}}. Use the case input.', semantics: { kind: 'number', n: '{{n}}' } },
    { id: 'pair', version: '1', kind: 'template', role: 'node', slots: { left: 'node', right: 'node' },
      slotOrder: ['left', 'right'], text: '{{slot:left}} / {{slot:right}}', semantics: { kind: 'pair' } },
  ]
  spec.protocol.grading = { kind: 'json' }
  spec.tasks = Array.from({ length: count }, (_, index) => ({ id: 'source-' + (index + 1), familyId: 'original-' + (index + 1),
    split: index === 0 ? 'development' : 'held-out', input: { case: index + 1, constant: 10 * (index + 1) },
    expected: { declared: index + 1 }, root: paired ? { use: 'pair', slots: {
      left: { use: 'number', params: { n: 1 } }, right: { use: 'number', params: { n: 10 } },
    } } : { use: 'number', params: { n: 1 } } }))
  return spec
}
function rowAt(fields, path) {
  const row = fields.occurrences.find(row => canonical(row.path) === canonical(path))
  assert.ok(row, 'Missing exact source path ' + canonical(path)); return row
}
function choices(entry, path, axisId, values) {
  const row = rowAt(entry.fields, path), current = row.choices[0]
  Object.assign(row, { enabled: true, axisId, choices: values.map(n => ({ id: 'n-' + n, bundleId: current.bundleId,
    parameters: { ...structuredClone(current.parameters), n: { kind: 'number', text: String(n), present: true } } })) })
}
async function workspaceFor(spec) {
  const workspace = { version: 1, rationale: 'Global rationale: retain every declared source family and its own construction controls.', seed: '42',
    selection: { kind: 'all', limit: '512' }, coverage: { kind: 'marginal', minimum: '1' }, families: [] }
  for (const [index, sourceTask] of spec.tasks.entries()) {
    const inventory = await compositionFieldInventory(spec, sourceTask.id), fields = createCompositionFieldDraft(inventory)
    fields.familyId = 'generated-' + (index + 1)
    fields.rationale = 'Construction rationale for original source ' + sourceTask.id + '.'
    fields.expectedPolicy = { kind: 'reuse-base', rationale: 'Expected policy for ' + sourceTask.id + ': retain only its own declared answer as a construction placeholder.' }
    workspace.families.push({ sourceTask: structuredClone(sourceTask), fields })
  }
  return workspace
}
async function generated(spec, workspace) {
  const built = await compileCompositionFamilyFields(spec, workspace)
  return { ...built, ...await materializeCorpus({ ...spec, corpusPlan: built.plan }) }
}
const generatedAxisId = (familyId, axisId) => 'cf-' + createHash('sha256').update(canonical({
  format: 'composition-family-axis', version: 1, familyId, axisId,
})).digest('hex').slice(0, 32)

test('two source families retain four scoped choice cells so balanced limit two cannot report full coverage', async () => {
  const spec = fixture(), workspace = await workspaceFor(spec), before = canonical(spec)
  for (const entry of workspace.families) choices(entry, [], 'same-local-axis', [1, 2])
  workspace.selection = { kind: 'balanced', limit: '2' }
  const limited = await generated(spec, workspace)
  assert.equal(limited.construction.requestedAssignments, 4)
  assert.equal(limited.manifest.candidateCount, 4); assert.equal(limited.tasks.length, 2)
  assert.equal(limited.manifest.status, 'coverage-unmet')
  const cells = limited.manifest.coverage.filter(row => row.dimension.startsWith('axis:'))
  assert.equal(cells.length, 4); assert.ok(cells.every(row => row.available === 1))
  assert.equal(cells.filter(row => row.selected === 0).length, 2)
  assert.equal(limited.manifest.unmetCoverage.length, 2)
  assert.deepEqual([...new Set(limited.tasks.map(task => task.familyId))].sort(), ['generated-1', 'generated-2'])
  assert.ok(limited.manifest.coverage.filter(row => row.dimension === 'family').every(row => row.minimum === 1 && row.selected === 1))

  workspace.selection.limit = '4'
  const full = await generated(spec, workspace)
  assert.equal(full.manifest.status, 'ready'); assert.equal(full.tasks.length, 4)
  assert.equal(full.manifest.coverage.filter(row => row.dimension.startsWith('axis:')).length, 4)
  assert.deepEqual(full.manifest.unmetCoverage, [])
  for (const [index, entry] of workspace.families.entries()) {
    const tasks = full.tasks.filter(task => task.familyId === entry.fields.familyId)
    assert.equal(tasks.length, 2)
    assert.deepEqual(tasks.map(task => task.root.params.n).sort((a, b) => a - b), [1, 2])
    for (const task of tasks) {
      assert.deepEqual(task.input, { case: index + 1, constant: 10 * (index + 1) })
      assert.deepEqual(task.expected, { declared: index + 1 }); assert.equal(task.split, entry.sourceTask.split)
    }
    assert.ok(full.plan.rationale.includes(entry.fields.rationale))
    assert.ok(full.plan.rationale.includes(entry.fields.expectedPolicy.rationale))
  }
  assert.ok(full.plan.rationale.includes(workspace.rationale))
  const controls = await requirementFieldInventory({ ...spec, tasks: full.tasks, corpusPlan: full.plan })
  assert.equal(controls.rows.length, 4); assert.equal(controls.rows.length * 4, 16)
  assert.equal(canonical(spec), before)
})

test('lowered axes identify their source family and canonical family order does not depend on editor navigation', async () => {
  const spec = fixture(2, true), workspace = await workspaceFor(spec)
  for (const entry of workspace.families) {
    choices(entry, ['left'], 'left', [1, 2]); choices(entry, ['right'], 'right', [10, 20])
  }
  const result = await generated(spec, workspace), reverse = structuredClone(workspace)
  reverse.families.reverse(); for (const entry of reverse.families) entry.fields.occurrences.reverse()
  const reordered = await generated(spec, reverse)
  assert.deepEqual(reordered.plan, result.plan); assert.deepEqual(reordered.construction, result.construction)
  assert.deepEqual(reordered.inventories, result.inventories); assert.deepEqual(reordered.tasks, result.tasks)
  assert.deepEqual(result.plan.families.map(family => family.id), ['generated-1', 'generated-2'])
  assert.equal(result.construction.axisMappings.length, 4)
  assert.equal(new Set(result.construction.axisMappings.map(row => row.recipeAxisId)).size, 4)
  for (const mapping of result.construction.axisMappings) {
    assert.equal(mapping.recipeAxisId, generatedAxisId(mapping.familyId, mapping.axisId))
    assert.match(mapping.recipeAxisId, /^cf-[a-f0-9]{32}$/)
    const family = result.plan.families.find(row => row.id === mapping.familyId)
    assert.ok(family.axes.some(axis => axis.id === mapping.recipeAxisId))
    assert.deepEqual(mapping.path, [mapping.axisId])
    assert.deepEqual(mapping.choices, mapping.axisId === 'left' ? ['n-1', 'n-2'] : ['n-10', 'n-20'])
  }
  assert.deepEqual(result.construction.families.map(row => [row.sourceTaskId, row.sourceFamilyId, row.familyId, row.requestedAssignments]),
    [['source-1', 'original-1', 'generated-1', 4], ['source-2', 'original-2', 'generated-2', 4]])
})

test('pair quotas are formed within each family and never demand impossible cross-family combinations', async () => {
  const spec = fixture(2, true), workspace = await workspaceFor(spec)
  for (const entry of workspace.families) {
    choices(entry, ['left'], 'left', [1, 2]); choices(entry, ['right'], 'right', [10, 20])
  }
  workspace.coverage.kind = 'pairwise'
  const result = await generated(spec, workspace), pairs = result.plan.coverage.filter(rule => rule.dimensions)
  assert.equal(result.tasks.length, 8); assert.equal(result.manifest.status, 'ready')
  assert.equal(result.plan.coverage.length, 7); assert.equal(pairs.length, 2)
  for (const pair of pairs) {
    const axes = pair.dimensions.map(value => value.slice('axis:'.length))
    const families = result.construction.axisMappings.filter(row => axes.includes(row.recipeAxisId)).map(row => row.familyId)
    assert.equal(families.length, 2); assert.equal(new Set(families).size, 1)
  }
  assert.equal(result.manifest.coverage.filter(row => row.dimension.includes(' × ')).length, 8)
  assert.ok(result.manifest.coverage.every(row => row.selected >= row.minimum))
})

test('the global workspace policy overrides retained hidden local policy without discarding local rationale or pending values', async () => {
  const spec = fixture(), workspace = await workspaceFor(spec)
  for (const entry of workspace.families) {
    choices(entry, [], 'same', [1, 2])
    entry.fields.seed = 'unfinished seed'; entry.fields.selection = { kind: 'unfinished', limit: '-' }
    entry.fields.coverage = { kind: 'unfinished', minimum: '-' }
  }
  workspace.seed = '77'; workspace.selection = { kind: 'balanced', limit: '2' }
  const before = canonical(workspace), result = await generated(spec, workspace)
  assert.equal(result.plan.seed, 77); assert.deepEqual(result.plan.selection, { kind: 'balanced', limit: 2 })
  assert.equal(result.manifest.status, 'coverage-unmet'); assert.equal(canonical(workspace), before)
  const noGlobalRationale = structuredClone(workspace); noGlobalRationale.rationale = ' '
  await assert.rejects(compileCompositionFamilyFields(spec, noGlobalRationale), /rationale/i)
  const missingExpectedPolicy = structuredClone(workspace); missingExpectedPolicy.families[1].fields.expectedPolicy.rationale = ''
  await assert.rejects(compileCompositionFamilyFields(spec, missingExpectedPolicy), /expected.*rationale/i)
  const unfinishedLocal = structuredClone(workspace)
  rowAt(unfinishedLocal.families[1].fields, []).choices[0].parameters.n.text = '-'
  await assert.rejects(compileCompositionFamilyFields(spec, unfinishedLocal), /numeric/i)
  assert.equal(rowAt(unfinishedLocal.families[1].fields, []).choices[0].parameters.n.text, '-')
})

test('changed, removed or counterfeit source capsules cannot replace current live source authority', async () => {
  const spec = fixture(), workspace = await workspaceFor(spec)
  for (const entry of workspace.families) choices(entry, [], 'same', [1, 2])
  const retained = canonical(workspace)
  for (const change of [
    source => { source.tasks[1].input.constant = 999 },
    source => { source.tasks[1].expected.declared = 999 },
    source => { source.tasks[1].root.params.n = 999 },
    source => { source.tasks.splice(1, 1) },
  ]) {
    const changed = structuredClone(spec); change(changed)
    await assert.rejects(compileCompositionFamilyFields(changed, workspace), /source|stale|changed|Undo/i)
    assert.equal(canonical(workspace), retained)
  }
  const forged = structuredClone(workspace); forged.families[1].sourceTask.input.constant = 999
  await assert.rejects(compileCompositionFamilyFields(spec, forged), /source|capsule|changed/i)
  const forgedBinding = structuredClone(workspace); forgedBinding.families[1].fields.bindingSha256 = '0'.repeat(64)
  await assert.rejects(compileCompositionFamilyFields(spec, forgedBinding), /stale|source.*changed/i)
  const mismatch = structuredClone(workspace); mismatch.families[1].fields.taskId = spec.tasks[0].id
  await assert.rejects(compileCompositionFamilyFields(spec, mismatch), /source|task/i)
  const updatedSource = structuredClone(spec); updatedSource.tasks[1].input.constant = 999
  const updatedCapsuleOnly = structuredClone(workspace); updatedCapsuleOnly.families[1].sourceTask = structuredClone(updatedSource.tasks[1])
  await assert.rejects(compileCompositionFamilyFields(updatedSource, updatedCapsuleOnly), /stale|source.*changed/i)
  const result = await generated(spec, workspace)
  await assert.rejects(compileCompositionFamilyFields({ ...spec, tasks: result.tasks, corpusPlan: result.plan }, workspace), /source|Undo/i)
})

test('duplicate source tasks, duplicate generated families and multiple seeds from the same original family refuse', async () => {
  const spec = fixture(), workspace = await workspaceFor(spec)
  for (const entry of workspace.families) choices(entry, [], 'same', [1, 2])
  const duplicatedTask = structuredClone(workspace); duplicatedTask.families[1] = structuredClone(duplicatedTask.families[0])
  duplicatedTask.families[1].fields.familyId = 'renamed-copy'
  await assert.rejects(compileCompositionFamilyFields(spec, duplicatedTask), /duplicate|distinct|repeated|same source|only once/i)
  const duplicatedGenerated = structuredClone(workspace); duplicatedGenerated.families[1].fields.familyId = duplicatedGenerated.families[0].fields.familyId
  await assert.rejects(compileCompositionFamilyFields(spec, duplicatedGenerated), /duplicate|distinct|repeated|generated family/i)
  const duplicatedLive = structuredClone(spec); duplicatedLive.tasks.push(structuredClone(duplicatedLive.tasks[0]))
  await assert.rejects(compileCompositionFamilyFields(duplicatedLive, workspace), /duplicate|distinct|repeated|source/i)
  const sameUnit = fixture(); sameUnit.tasks[1].familyId = sameUnit.tasks[0].familyId
  const sameWorkspace = await workspaceFor(sameUnit)
  assert.notEqual(sameWorkspace.families[0].fields.familyId, sameWorkspace.families[1].fields.familyId)
  await assert.rejects(compileCompositionFamilyFields(sameUnit, sameWorkspace), /original family|source family|same.*family|distinct.*famil/i)
  const noIds = fixture(); for (const task of noIds.tasks) delete task.familyId
  const absent = await compileCompositionFamilyFields(noIds, await workspaceFor(noIds))
  assert.deepEqual(absent.construction.families.map(row => row.sourceFamilyId), ['source-1', 'source-2'])
})

test('family construction snapshots every live source and capsule before its first asynchronous inventory', async () => {
  const spec = fixture(), workspace = await workspaceFor(spec)
  for (const entry of workspace.families) choices(entry, [], 'same', [1, 2])
  const expected = await compileCompositionFamilyFields(spec, workspace)
  const callerSource = structuredClone(spec), callerWorkspace = structuredClone(workspace)
  const pending = compileCompositionFamilyFields(callerSource, callerWorkspace)
  callerSource.tasks[1].input.constant = 999
  callerWorkspace.families[1].sourceTask.expected.declared = 999
  rowAt(callerWorkspace.families[1].fields, []).choices[0].parameters.n.text = '999'
  callerWorkspace.families.reverse(); callerWorkspace.selection.limit = '1'
  assert.deepEqual(await pending, expected)
  assert.equal(callerSource.tasks[1].input.constant, 999, 'The caller keeps its own mutable source.')
})

test('the global candidate budget is the sum of family products, not their cross product or a per-family cap', async () => {
  const spec = fixture(3, true), workspace = await workspaceFor(spec)
  for (const entry of workspace.families) {
    choices(entry, ['left'], 'left', Array.from({ length: 64 }, (_, n) => n))
    choices(entry, ['right'], 'right', Array.from({ length: 32 }, (_, n) => n))
  }
  const two = structuredClone(workspace); two.families.pop()
  const result = await compileCompositionFamilyFields(spec, two)
  assert.equal(result.construction.requestedAssignments, 4096)
  assert.deepEqual(result.construction.families.map(row => row.requestedAssignments), [2048, 2048])
  assert.equal(result.plan.families.length, 2)
  await assert.rejects(compileCompositionFamilyFields(spec, workspace), /4096.*candidate|candidate.*4096/i)
  assert.equal(workspace.families.length, 3)
  for (const entry of workspace.families) assert.equal(rowAt(entry.fields, ['left']).choices.length, 64)
  const overSelection = structuredClone(two); overSelection.selection.limit = '513'
  await assert.rejects(compileCompositionFamilyFields(spec, overSelection), /bounds|512|limit/i)
  const empty = structuredClone(two); empty.families = []
  await assert.rejects(compileCompositionFamilyFields(spec, empty), /famil/i)
  const tooMany = structuredClone(two); tooMany.families = Array.from({ length: 513 }, () => structuredClone(two.families[0]))
  await assert.rejects(compileCompositionFamilyFields(spec, tooMany), /512/i)
})

test('coverage limits apply after merging all families and namespaced axes cannot overwrite existing task factors', async () => {
  const spec = fixture(4)
  let tree = { use: 'number', params: { n: 1 } }
  for (let level = 0; level < 3; level++) tree = { use: 'pair', slots: { left: tree, right: tree } }
  for (const task of spec.tasks) task.root = structuredClone(tree)
  const workspace = await workspaceFor(spec); workspace.coverage.kind = 'pairwise'
  for (const entry of workspace.families) for (const [index, row] of entry.fields.occurrences.filter(row => row.path.length === 3).entries())
    choices(entry, row.path, 'leaf-' + index, [1])
  const one = structuredClone(workspace); one.families.length = 1
  assert.equal((await compileCompositionFamilyFields(spec, one)).plan.coverage.length, 37)
  await assert.rejects(compileCompositionFamilyFields(spec, workspace), /128.*coverage|coverage.*128/i)

  const collisionSource = fixture(1), key = generatedAxisId('generated-1', 'same')
  collisionSource.tasks[0].factors = { [key]: 'already-declared' }
  const collision = await workspaceFor(collisionSource); choices(collision.families[0], [], 'same', [1, 2])
  await assert.rejects(compileCompositionFamilyFields(collisionSource, collision), /factor|collision|overwrite/i)
  const crossFamilySource = fixture(), otherAxis = generatedAxisId('generated-2', 'same')
  crossFamilySource.tasks[0].factors = { [otherAxis]: 'n-1' }
  const crossFamily = await workspaceFor(crossFamilySource)
  for (const entry of crossFamily.families) choices(entry, [], 'same', [1, 2])
  await assert.rejects(compileCompositionFamilyFields(crossFamilySource, crossFamily), /factor|collision|overwrite/i)
  const authority = await workspaceFor(fixture(1)); authority.families[0].qualified = true
  await assert.rejects(compileCompositionFamilyFields(fixture(1), authority), /unsupported|field/i)
})

test('global semantic aliases remain excluded instead of manufacturing independently covered family units', async () => {
  const spec = fixture(); spec.tasks[1].input = structuredClone(spec.tasks[0].input)
  spec.tasks[1].expected = structuredClone(spec.tasks[0].expected)
  const workspace = await workspaceFor(spec)
  for (const entry of workspace.families) choices(entry, [], 'same', [1, 2])
  const result = await generated(spec, workspace)
  assert.equal(result.manifest.candidateCount, 4); assert.equal(result.tasks.length, 2)
  assert.equal(result.manifest.status, 'coverage-unmet')
  assert.equal(result.manifest.candidates.filter(row => row.disposition === 'duplicate-excluded').length, 2)
  assert.deepEqual([...new Set(result.tasks.map(task => task.familyId))], ['generated-1'])
  assert.ok(result.manifest.unmetCoverage.some(row => row.dimension === 'family' && row.value === 'generated-2'))
})

test('exported family provenance retains exact source policies and complete factor mappings and refuses inconsistent rewrites', async () => {
  const spec = fixture(2, true), workspace = await workspaceFor(spec)
  for (const entry of workspace.families) {
    choices(entry, ['left'], 'left', [1, 2]); choices(entry, ['right'], 'right', [10, 20])
  }
  const result = await generated(spec, workspace)
  const files = corpusProjectFiles({ spec: { corpusPlan: result.plan }, corpus: result.manifest })
  assert.deepEqual(JSON.parse(files['corpus/field-authoring.json']), result.plan.fieldAuthoring)
  assert.deepEqual(JSON.parse(files['corpus/recipe.json']).fieldAuthoring, result.plan.fieldAuthoring)
  assert.deepEqual(result.plan.fieldAuthoring.axisMappings, result.construction.axisMappings)
  assert.deepEqual(result.plan.fieldAuthoring.families.map(row => row.expectedPolicy), workspace.families.map(row => row.fields.expectedPolicy))
  assert.deepEqual(result.plan.fieldAuthoring.families.map(row => row.sourceBindingSha256), result.construction.families.map(row => row.sourceBindingSha256))
  for (const alter of [
    plan => { plan.fieldAuthoring.families.pop() },
    plan => { plan.fieldAuthoring.families[1] = structuredClone(plan.fieldAuthoring.families[0]) },
    plan => { plan.fieldAuthoring.axisMappings.pop() },
    plan => { plan.fieldAuthoring.axisMappings[1] = structuredClone(plan.fieldAuthoring.axisMappings[0]) },
    plan => { plan.fieldAuthoring.axisMappings[0].familyId = 'generated-2' },
    plan => { plan.fieldAuthoring.axisMappings[0].sourceTaskId = 'source-2' },
    plan => { plan.fieldAuthoring.axisMappings[0].path = ['right'] },
    plan => { plan.fieldAuthoring.axisMappings[0].choices.push('invented') },
    plan => { plan.fieldAuthoring.families[0].qualified = true },
  ]) {
    const forged = structuredClone(result.plan); alter(forged)
    assert.throws(() => validateCorpusPlan(forged), /family|families|factor|mapping|provenance|unsupported/i)
  }
  const legacy = structuredClone(result.plan); delete legacy.fieldAuthoring
  validateCorpusPlan(legacy)
  assert.equal(corpusProjectFiles({ spec: { corpusPlan: legacy }, corpus: result.manifest })['corpus/field-authoring.json'], undefined)
})

test('two global families do not satisfy family uncertainty when the primary population selects only one', async () => {
  const spec = fixture(), workspace = await workspaceFor(spec)
  for (const entry of workspace.families) choices(entry, [], 'same', [1, 2])
  const result = await generated(spec, workspace)
  spec.tasks = result.tasks; spec.corpusPlan = result.plan
  spec.conditions = ['first', 'second'].map(id => ({ id, label: id, model: { provider: 'fixture', id, settings: {} }, adapter: { kind: 'replay', responses: {} } }))
  spec.analysisPlan.primaryPopulation = { kind: 'split', split: 'held-out' }
  spec.analysisPlan.uncertainty = { kind: 'family-bootstrap', seed: 7, iterations: 100, confidence: 0.95 }
  spec.analysisPlan.contrasts = [{ id: 'first-second', first: 'first', second: 'second' }]
  const project = await freezeStudy(newExperimentDraft(spec)), summary = analyze(project, [])
  assert.equal(new Set(project.tasks.map(task => task.familyId)).size, 2)
  assert.equal(resolveAnalysisPopulation(project.spec).taskIds.length, 2)
  assert.equal(summary.contrasts[0].families, 1); assert.equal(summary.contrasts[0].interval, null)
  assert.match(summary.contrasts[0].intervalReason, /two task families/i)
  assert.ok(evaluateReadiness(project).blockers.some(row => row.code === 'family-units-required'))
  assert.ok(evaluateReadiness(project).blockers.some(row => row.code === 'independent-oracle-required'))
  const all = structuredClone(spec); all.analysisPlan.primaryPopulation = 'all'
  const twoFamilies = await freezeStudy(newExperimentDraft(all))
  assert.ok(!evaluateReadiness(twoFamilies).blockers.some(row => row.code === 'family-units-required'))
  assert.equal(evaluateReadiness(twoFamilies).eligible, false)
})
