import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createCompositionFamilySourceDraft } from '../../src/research-composition-source-draft.mjs'
import { compositionFieldInventory, createCompositionFieldDraft, compileCompositionFamilyFields } from '../../src/benchmark/corpus.mjs'
import { materializeCorpus, validateStudy, freezeStudy, STUDY_VERSION } from '../../src/benchmark/study.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { evaluateReadiness, assertCollectionAdmission } from '../../src/benchmark/readiness.mjs'
import { observationPlanFromSpec } from '../../src/benchmark/observations.mjs'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { workflowFixture } from './fixtures/research-benchmark-workflow.mjs'

const clone = value => structuredClone(value)
const raw = workspace => '\n \t' + JSON.stringify(workspace, null, 3) + '\n  '
const retainedWorkspace = draft => JSON.parse(draft.editors['data-bench-composition-family-fields'])
async function workspaceFor(spec) {
  const workspace = { version: 1, rationale: 'Explicit synthetic source family construction.', seed: '7',
    selection: { kind: 'all', limit: '512' }, coverage: { kind: 'marginal', minimum: '1' }, families: [] }
  for (const [index, sourceTask] of spec.tasks.entries()) {
    const inventory = await compositionFieldInventory(spec, sourceTask.id), fields = createCompositionFieldDraft(inventory)
    fields.familyId = 'output-' + index
    fields.rationale = 'Keep the exact independently authored source ' + sourceTask.id + '.'
    fields.expectedPolicy = { kind: 'reuse-base', rationale: 'Retain the case key only for this construction control; no oracle proof is supplied.' }
    fields.occurrences[0].enabled = true
    fields.occurrences[0].choices = [1, 2].map(n => ({ id: 'value-' + n, bundleId: 'number', parameters: { n: { kind: 'number', text: String(n), present: true } } }))
    workspace.families.push({ sourceTask: clone(sourceTask), fields })
  }
  return workspace
}
async function fixture() {
  const spec = genericStarter()
  spec.catalog = [{ id: 'number', version: '1', kind: 'atom', role: 'node', parameters: { n: 1 }, text: 'Case requirement {{n}}.', semantics: { kind: 'case', n: '{{n}}' } }]
  spec.protocol.grading = { kind: 'json' }
  spec.tasks = [0, 1].map(index => ({ id: 'source-' + index, familyId: 'original-' + index, split: index ? 'held-out' : 'development',
    root: { use: 'number', params: { n: 1 } }, input: { index, enabled: false, label: '', unicode: 'é界' }, expected: { declared: index } }))
  const workspace = await workspaceFor(spec), built = await compileCompositionFamilyFields(spec, workspace)
  const generated = await materializeCorpus({ ...spec, corpusPlan: built.plan })
  return { spec, workspace, built, generated, current: { ...clone(spec), tasks: clone(generated.tasks), corpusPlan: clone(built.plan) } }
}

test('source derivative retains exact private capsules and both raw editor strings with only an ordinary pending draft envelope', async () => {
  const { workspace, current, built } = await fixture(), familyFields = raw(workspace), singleFields = '  { unfinished single-family text é\n'
  const history = { kind: 'detached-recipe', recipe: { version: 1, opaque: 'Previous authoring history retained exactly.' } }
  current.corpusHistory = [history]
  current.name = ''; current.decisions = 'Applied unfinished study decisions.'
  current.analysisPlan.primaryPopulation = { kind: 'task-set', taskIds: ['generated-task-still-declared'] }
  current.requirementPlan = { version: 1, targets: [], rationale: 'Prior controls remain unresolved after source restoration.' }
  current.workflowPlan = { version: 1, workflows: [], rationale: 'Applied workflow draft.' }
  current.observationPlan = { version: 1, rationale: 'Applied observation draft.' }
  current.reviews = [{ bundleId: 'number', reviewer: 'SYNTHETIC RETAINED RECORD; NOT PERSONAL APPROVAL', stale: true }]
  current.runtimeSources = { 'corpus.mjs': 'a'.repeat(64) }
  const attachments = { 'data/source.txt': '\uFEFFExact\r\nsource é\n', 'data/raw.bin': { encoding: 'base64', data: 'AP+A' } }
  const input = { spec: current, attachments, familyFields, singleFields, frozen: { falseAuthority: true }, evidence: { events: ['must not copy'] },
    pending: ['task', 'input'], taskIndex: 3, editors: { 'data-bench-task-json': 'must not copy' }, backup: { obsolete: true } }
  const before = clone(input), result = createCompositionFamilySourceDraft(input)
  assert.deepEqual(Object.keys(result).sort(), ['version', 'spec', 'attachments', 'pending', 'taskIndex', 'bundleIndex', 'editors'].sort())
  assert.equal(result.version, 1); assert.equal(result.taskIndex, 0); assert.equal(result.bundleIndex, 0)
  assert.deepEqual(result.pending, ['compositionFamilies'])
  assert.deepEqual(result.editors, { 'data-bench-composition-family-fields': familyFields, 'data-bench-composition-fields': singleFields })
  assert.deepEqual(result.spec.tasks, workspace.families.map(entry => entry.sourceTask))
  assert.deepEqual(result.spec.corpusHistory, [history, { kind: 'detached-recipe', recipe: built.plan }])
  assert.equal(result.spec.corpusPlan, undefined)
  for (const key of Object.keys(current).filter(key => !['tasks', 'conditions', 'corpusPlan', 'corpusHistory'].includes(key))) assert.deepEqual(result.spec[key], current[key], key)
  assert.deepEqual(result.attachments, attachments)
  assert.deepEqual(input, before)
  result.spec.tasks[0].input.index = 999; result.spec.corpusHistory[0].recipe.opaque = 'changed derivative'; result.attachments['data/raw.bin'].data = 'changed'
  assert.deepEqual(input, before, 'Mutating the returned derivative cannot alter applied source, capsules or attachments.')
  current.catalog[0].text = 'Changed caller after export.'
  assert.equal(result.spec.catalog[0].text, 'Case requirement {{n}}.')
})

test('declared replay response maps clear while absent workflow maps, mode and other declarations remain exact', async () => {
  const { current, workspace } = await fixture()
  current.conditions = [
    { id: 'saved', label: 'Saved workflow', workflowId: 'existing-flow', model: { provider: 'fixture', id: 'saved', settings: {} },
      adapter: { kind: 'replay', mode: 'envelope', responses: { old: { output: false, usage: { outputTokens: 0 } } },
        workflowResponses: { old: { draft: { output: true } } }, note: 'Retain applied adapter metadata.' } },
    { id: 'missing-maps', adapter: { kind: 'replay', mode: 'raw' } },
    { id: 'module', adapter: { kind: 'module', file: 'adapters/blind.mjs', configuration: { useInput: true } } },
  ]
  const before = clone(current.conditions), result = createCompositionFamilySourceDraft({ spec: current, familyFields: raw(workspace) })
  assert.deepEqual(result.spec.conditions[0], { ...before[0], adapter: { ...before[0].adapter, responses: {}, workflowResponses: {} } })
  assert.deepEqual(result.spec.conditions[1].adapter, { kind: 'replay', mode: 'raw', responses: {} })
  assert.equal(Object.hasOwn(result.spec.conditions[1].adapter, 'workflowResponses'), false)
  assert.deepEqual(result.spec.conditions[2], before[2])
  assert.deepEqual(current.conditions, before)
})

async function assertUnqualifiedExperiment(spec) {
  assert.doesNotThrow(() => validateStudy(spec))
  const project = await freezeStudy(spec), readiness = evaluateReadiness(project)
  assert.equal(project.spec.schemaVersion, STUDY_VERSION)
  assert.equal(readiness.purpose, 'experiment')
  assert.equal(readiness.eligible, false)
  assert.ok(readiness.blockers.some(row => row.code === 'independent-oracle-required'))
  assert.throws(() => assertCollectionAdmission(project), /independent-oracle-required/)
  return project
}

test('schema-2 ordinary replay source exports validate, freeze and rebuild without inventing a workflow or granting admission', async () => {
  const { spec: seed } = await fixture()
  for (const mode of [undefined, 'output', 'envelope']) {
    const spec = newExperimentDraft(seed, { initializePopulation: true })
    spec.conditions[0].adapter = { kind: 'replay', ...(mode === undefined ? {} : { mode }), responses: Object.fromEntries(spec.tasks.map(task =>
      [task.id, mode === 'envelope' ? { output: task.expected } : task.expected])) }
    if (mode === 'envelope') spec.observationPlan = observationPlanFromSpec()
    const sourceBefore = canonical(spec)
    await assertUnqualifiedExperiment(spec)
    const workspace = await workspaceFor(spec), built = await compileCompositionFamilyFields(spec, workspace)
    const generated = await materializeCorpus({ ...spec, corpusPlan: built.plan })
    const current = { ...clone(spec), tasks: generated.tasks, corpusPlan: built.plan }
    await assertUnqualifiedExperiment(current)
    const familyFields = raw(workspace), exported = createCompositionFamilySourceDraft({ spec: current, familyFields })
    // Exercise the actual strict schema before checking shape: adding an empty
    // workflow map to an ordinary replay adapter used to fail this validation.
    await assertUnqualifiedExperiment(exported.spec)
    assert.deepEqual(exported.spec.conditions[0].adapter, { kind: 'replay', ...(mode === undefined ? {} : { mode }), responses: {} })
    assert.equal(Object.hasOwn(exported.spec.conditions[0].adapter, 'workflowResponses'), false)
    assert.equal(Object.hasOwn(exported.spec, 'workflowPlan'), false)
    assert.deepEqual(exported.spec.tasks, spec.tasks)
    assert.deepEqual(exported.spec.executionPlan, spec.executionPlan)
    assert.deepEqual(exported.spec.analysisPlan, spec.analysisPlan)
    assert.deepEqual(exported.pending, ['compositionFamilies'])
    assert.equal(exported.editors['data-bench-composition-family-fields'], familyFields)
    const rebuilt = await compileCompositionFamilyFields(exported.spec, retainedWorkspace(exported))
    assert.deepEqual(rebuilt.plan, built.plan)
    assert.deepEqual(rebuilt.construction, built.construction)
    const regenerated = await materializeCorpus({ ...exported.spec, corpusPlan: rebuilt.plan })
    assert.deepEqual(regenerated.tasks, generated.tasks)
    assert.deepEqual(regenerated.manifest, generated.manifest)
    await assertUnqualifiedExperiment({ ...exported.spec, tasks: regenerated.tasks, corpusPlan: rebuilt.plan })
    const inventedWorkflow = clone(exported.spec)
    inventedWorkflow.conditions[0].adapter.workflowResponses = {}
    assert.throws(() => validateStudy(inventedWorkflow), /Recorded workflow responses require this condition to select a frozen workflow/)
    assert.equal(canonical(spec), sourceBefore)
  }
})

test('schema-2 declared replay workflows retain their exact plan and mode while both saved response maps clear', async () => {
  const { spec: seed } = await fixture(), workflow = workflowFixture()
  const spec = newExperimentDraft({ ...seed, conditions: workflow.conditions, workflowPlan: workflow.workflowPlan,
    observationPlan: workflow.observationPlan }, { initializePopulation: true })
  await assertUnqualifiedExperiment(spec)
  const workspace = await workspaceFor(spec), before = canonical(spec)
  assert.ok(Object.keys(spec.conditions[0].adapter.responses).length > 0)
  assert.ok(Object.keys(spec.conditions[0].adapter.workflowResponses).length > 0)
  const exported = createCompositionFamilySourceDraft({ spec, familyFields: raw(workspace) })
  assert.deepEqual(exported.spec.workflowPlan, spec.workflowPlan)
  assert.deepEqual(exported.spec.conditions[0], { ...spec.conditions[0], adapter: { ...spec.conditions[0].adapter, responses: {}, workflowResponses: {} } })
  assert.equal(exported.spec.conditions[0].adapter.mode, 'envelope')
  await assertUnqualifiedExperiment(exported.spec)
  assert.equal(canonical(spec), before)
})

test('a valid source derivative rebuilds the same family recipe and generated tasks after the live source roster disappeared', async () => {
  const { workspace, current, built, generated } = await fixture()
  await assert.rejects(compileCompositionFamilyFields(current, workspace), /source|Undo/i)
  const result = createCompositionFamilySourceDraft({ spec: current, familyFields: raw(workspace) })
  const rebuilt = await compileCompositionFamilyFields(result.spec, retainedWorkspace(result))
  assert.deepEqual(rebuilt.plan, built.plan); assert.deepEqual(rebuilt.construction, built.construction)
  const regenerated = await materializeCorpus({ ...result.spec, corpusPlan: rebuilt.plan })
  assert.deepEqual(regenerated.tasks, generated.tasks); assert.deepEqual(regenerated.manifest, generated.manifest)
  assert.ok(result.spec.conditions.every(condition => condition.adapter.kind !== 'replay' || Object.keys(condition.adapter.responses).length === 0))
  assert.equal(result.spec.requirementPlan, undefined)
})

test('source derivatives preserve stale binding bytes and ordinary Build still refuses changed catalog, runtime or counterfeit capsule inputs', async () => {
  const { workspace, current } = await fixture()
  const changes = [
    (spec, fields) => { spec.catalog[0].text += ' Revised current wording.' },
    (spec, fields) => { spec.runtimeSources = { 'corpus.mjs': 'f'.repeat(64) } },
    (spec, fields) => { fields.families[0].sourceTask.input.index = 99 },
  ]
  for (const change of changes) {
    const spec = clone(current), fields = clone(workspace); change(spec, fields)
    const familyFields = raw(fields), result = createCompositionFamilySourceDraft({ spec, familyFields })
    assert.equal(result.editors['data-bench-composition-family-fields'], familyFields)
    assert.deepEqual(retainedWorkspace(result).families.map(entry => entry.fields.bindingSha256), workspace.families.map(entry => entry.fields.bindingSha256))
    await assert.rejects(compileCompositionFamilyFields(result.spec, retainedWorkspace(result)), /stale|source.*changed/i)
  }
})

test('prior source generation metadata and provenance remain exact while an explicit rebuild derives new generated tasks', async () => {
  const { spec, generated, built } = await fixture()
  const priorSources = { ...clone(spec), corpusPlan: clone(built.plan), tasks: [generated.tasks[0], generated.tasks[2]].map(clone) }
  const workspace = await workspaceFor(priorSources)
  for (const [index, entry] of workspace.families.entries()) entry.fields.familyId = 'second-generation-' + index
  const next = await compileCompositionFamilyFields(priorSources, workspace)
  const materialized = await materializeCorpus({ ...priorSources, corpusPlan: next.plan })
  const current = { ...priorSources, tasks: materialized.tasks, corpusPlan: next.plan,
    corpusHistory: [{ kind: 'detached-recipe', recipe: built.plan }] }
  const result = createCompositionFamilySourceDraft({ spec: current, familyFields: raw(workspace) })
  assert.deepEqual(result.spec.tasks, priorSources.tasks)
  assert.ok(result.spec.tasks.every(task => task.generation?.recipeSha256 === generated.manifest.recipeSha256))
  assert.deepEqual(retainedWorkspace(result).families.map(entry => entry.sourceTask.generation), priorSources.tasks.map(task => task.generation))
  assert.deepEqual(result.spec.corpusHistory, [...current.corpusHistory, { kind: 'detached-recipe', recipe: next.plan }])
  const rebuilt = await compileCompositionFamilyFields(result.spec, retainedWorkspace(result))
  assert.deepEqual(rebuilt.plan, next.plan)
  const regenerated = await materializeCorpus({ ...result.spec, corpusPlan: rebuilt.plan })
  assert.deepEqual(regenerated.tasks, materialized.tasks)
  assert.ok(regenerated.tasks.every(task => task.generation.recipeSha256 === regenerated.manifest.recipeSha256))
})

test('incomplete authoring values and an invalid current catalog remain exportable without rebasing or claiming validation', async () => {
  const { current, workspace } = await fixture()
  workspace.rationale = ''; workspace.seed = '1e'; workspace.selection.limit = 'not chosen'
  workspace.families[0].fields.rationale = ''
  workspace.families[0].fields.expectedPolicy = { kind: '', rationale: '' }
  workspace.families[0].fields.occurrences[0].choices = [{ id: 'unfinished', subtree: { kind: 'unfilled' } }]
  current.catalog[0].text = ''; current.name = ''; current.analysisPlan.rationale = ''
  const familyFields = raw(workspace), result = createCompositionFamilySourceDraft({ spec: current, familyFields, singleFields: 'unfinished local field text' })
  assert.equal(result.spec.catalog[0].text, ''); assert.equal(result.spec.name, '')
  assert.equal(result.editors['data-bench-composition-family-fields'], familyFields)
  assert.deepEqual(result.pending, ['compositionFamilies'])
  assert.equal(result.readiness, undefined); assert.equal(result.evidence, undefined); assert.equal(result.frozen, undefined)
  await assert.rejects(compileCompositionFamilyFields(result.spec, retainedWorkspace(result)))
})

test('dedicated template scopes, duplicate family shapes and malformed source capsules refuse without mutating inputs', async () => {
  const { current, workspace } = await fixture()
  const mutations = [
    spec => { spec.auditPlan = { version: 1 } },
    spec => { spec.experimentTemplate = { version: 1 } },
    (spec, fields) => { fields.families[0].sourceTask.information = { version: 1 } },
    (spec, fields) => { fields.families[0].sourceTask.audit = { caseId: 'retained' } },
    (spec, fields) => { fields.families[0].sourceTask.resource = { caseId: 'retained' } },
    (spec, fields) => { fields.families[1].sourceTask.id = fields.families[0].sourceTask.id; fields.families[1].fields.taskId = fields.families[0].fields.taskId },
    (spec, fields) => { fields.families[1].sourceTask.familyId = fields.families[0].sourceTask.familyId },
    (spec, fields) => { fields.families[1].fields.familyId = fields.families[0].fields.familyId },
    (spec, fields) => { fields.families[0].fields.taskId = 'different-task' },
    (spec, fields) => { fields.families[0].sourceTask.root = [] },
    (spec, fields) => { fields.families[0].sourceTask.id = '../invalid-id' },
    (spec, fields) => { fields.families = [] },
    (spec, fields) => { fields.families = Array.from({ length: 513 }, () => clone(fields.families[0])) },
    (spec, fields) => { fields.version = 2 },
  ]
  for (const mutate of mutations) {
    const spec = clone(current), fields = clone(workspace); mutate(spec, fields)
    const before = canonical({ spec, fields })
    assert.throws(() => createCompositionFamilySourceDraft({ spec, familyFields: raw(fields) }))
    assert.equal(canonical({ spec, fields }), before)
  }
  assert.throws(() => createCompositionFamilySourceDraft({ spec: current, familyFields: '{unfinished' }), /valid JSON/)
  assert.throws(() => createCompositionFamilySourceDraft({ spec: current, familyFields: workspace }), /original text/)
  assert.throws(() => createCompositionFamilySourceDraft({ spec: current, familyFields: raw(workspace), singleFields: {} }), /original text/)
  const sourceWithoutFamily = clone(workspace); for (const entry of sourceWithoutFamily.families) delete entry.sourceTask.familyId
  assert.deepEqual(createCompositionFamilySourceDraft({ spec: current, familyFields: raw(sourceWithoutFamily) }).spec.tasks, sourceWithoutFamily.families.map(entry => entry.sourceTask))
})

test('the serialized UTF-8 derivative cap accounts for both capsule and raw workspace copies', async t => {
  const helperUrl = new URL('../../src/research-composition-source-draft.mjs', import.meta.url).href
  const script = `import assert from 'node:assert/strict';
    import {createCompositionFamilySourceDraft} from ${JSON.stringify(helperUrl)};
    const chars=25*1024*1024, payload='界'.repeat(chars);
    const sourceTask={id:'source',root:{use:'number'},input:{payload}};
    const workspace={version:1,families:[{sourceTask,fields:{taskId:'source',familyId:'family'}}]};
    const familyFields=JSON.stringify(workspace), limit=128*1024*1024;
    const inputBytes=Buffer.byteLength(familyFields,'utf8');
    assert.ok(inputBytes<limit);assert.ok(chars*3*2>limit);
    assert.throws(()=>createCompositionFamilySourceDraft({spec:{tasks:[],conditions:[]},familyFields}),/128 MiB import limit/);
    console.log(JSON.stringify({inputBytes,limit,minimumOutputUtf8Bytes:chars*3*2,refused:true}));`
  const result = spawnSync(process.execPath, ['--max-old-space-size=768', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })
  const evidence = await mkdtemp(resolve(process.env.BENCHMARK_SOURCE_DRAFT_EVIDENCE_ROOT || tmpdir(), 'research-source-draft-size-'))
  await Promise.all([writeFile(resolve(evidence, 'size-cap.stdout'), result.stdout || ''), writeFile(resolve(evidence, 'size-cap.stderr'), result.stderr || ''),
    writeFile(resolve(evidence, 'size-cap-result.json'), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message || null }, null, 2))])
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr)
  const observation = JSON.parse(result.stdout)
  assert.equal(observation.refused, true); assert.ok(observation.inputBytes < observation.limit); assert.ok(observation.minimumOutputUtf8Bytes > observation.limit)
  t.diagnostic('Retained isolated size-boundary stdout/stderr/result: ' + evidence)
})

test('non-finite applied values or archived JSON exponents refuse instead of silently becoming null', async () => {
  const { current, workspace } = await fixture()
  const familyFields = raw(workspace), before = clone(current)
  for (const value of [Infinity, -Infinity, NaN]) {
    const applied = clone(current); applied.conditions[0].model.settings.temperature = value
    assert.throws(() => createCompositionFamilySourceDraft({ spec: applied, familyFields }), /finite JSON numbers.*no value was replaced with null/)
    assert.ok(Object.is(applied.conditions[0].model.settings.temperature, value))
  }
  const overflow = familyFields.replace('"index": 0', '"index": 1e999')
  assert.notEqual(overflow, familyFields)
  assert.throws(() => createCompositionFamilySourceDraft({ spec: current, familyFields: overflow }), /finite JSON numbers/)
  assert.deepEqual(current, before)
})
