import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { DESIGN_PLAN_VERSION } from '../../src/benchmark/analysis.mjs'
import { bindRuntimeSources, freezeStudy, verifyProject, materializeCorpus, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { genericStarter as legacyStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { evaluateReadiness, assertCollectionAdmission } from '../../src/benchmark/readiness.mjs'
import { collectionRequest, workflowDraft, newWorkflowState, workflowRequest } from '../../src/benchmark/workflow.mjs'
import { observationPlanFromSpec } from '../../src/benchmark/observations.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'
import { operationalStarter } from '../../src/benchmark/trading-catalog.mjs'
import { corpusPlanFromTask } from '../../src/benchmark/corpus.mjs'
import { genericActivationFixture } from './fixtures/research-benchmark-generic-activation.mjs'
import { workflowFixture } from './fixtures/research-benchmark-workflow.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
async function experiment() {
  const { spec } = await genericActivationFixture()
  return bindRuntimeSources(newExperimentDraft(spec, { purpose: 'experiment', initializePopulation: true }), sources)
}

test('unknown version-2 design fields cannot freeze as ignored scientific declarations', async t => {
  assert.equal(evaluateReadiness(await freezeStudy(await experiment())).eligible, true,
    'the unmodified study must be collectable before unsupported declarations are added')
  for (const [name, mutate] of [
    ['parallel trial count', spec => { spec.protocol.concurrency = 4 }],
    ['adaptive stopping', spec => { spec.protocol.stoppingRule = { kind: 'stop-after-three-successes' } }],
    ['alternate primary metric', spec => { spec.protocol.grading.primaryMetric = 'collateral-cost' }],
    ['authored execution capability', spec => { spec.executionCapabilities = { independentObserver: true } }],
    ['condition best-of selection', spec => { spec.conditions[0].bestOf = 10 }],
    ['shared adapter session', spec => { spec.conditions[0].adapter.sessionMode = 'shared' }],
    ['unimplemented model field', spec => { spec.conditions[0].model.hiddenStateReset = true }],
    ['task reset declaration', spec => { spec.tasks[0].resetBeforeTrial = true }],
    ['analysis stopping rule', spec => { spec.analysisPlan.stoppingRule = { successes: 3 } }],
    ['analysis escalation budget', spec => { spec.analysisPlan.escalationBudget = 4 }],
    ['reference execution hook', spec => { spec.tasks[0].root.beforeRun = 'reset' }],
  ]) await t.test(name, async () => {
    const spec = await experiment(); mutate(spec)
    await assert.rejects(freezeStudy(spec), /unsupported|unknown/i)
  })
})

test('a valid design plan cannot silently acquire an unenforced wall-clock limit', async () => {
  const spec = await experiment()
  spec.designPlan = { version: DESIGN_PLAN_VERSION, rationale: 'Each condition is its own comparison arm.' }
  assert.equal(evaluateReadiness(await freezeStudy(spec)).eligible, true)
  spec.designPlan.wallClockLimitMs = 30000
  await assert.rejects(freezeStudy(spec), /Design plan has unsupported fields: wallClockLimitMs/)
})

test('opaque requested model settings remain explicit forwarded JSON without invented setting semantics', async () => {
  const spec = await experiment()
  spec.conditions[0].model.settings = { temperature: 0.25, vendorSetting: { mode: 'named-by-provider', values: [0, false, null] } }
  const project = await freezeStudy(spec), trial = project.schedule[0], task = project.tasks.find(row => row.id === trial.taskId), condition = project.spec.conditions[0]
  assert.equal(evaluateReadiness(project).eligible, true)
  const request = collectionRequest(project, condition, task, trial, 1)
  assert.deepEqual(request.model.settings, spec.conditions[0].model.settings)
  assert.equal(Object.hasOwn(request, 'expected'), false)
  assert.match(project.readiness.capabilities.identity, /adapter-reported/)
})

test('legacy policy descriptions cannot promise unimplemented execution or analysis in version 2', async t => {
  for (const [key, values] of [
    ['selection', [{ kind: 'best-of', k: 10 }, 'Select the best of ten successful answers.']],
    ['stopping', [{ kind: 'stop-after', successes: 3 }, 'Stop after three successful answers.']],
    ['analysis', [{ primaryMetric: 'cost-adjusted-utility' }, 'Report cost-adjusted utility as the primary result.']],
  ]) for (const value of values) await t.test(key + ': ' + (typeof value === 'string' ? 'narrative' : 'structured'), async () => {
    const spec = await experiment(); spec.protocol[key] = value
    await assert.rejects(freezeStudy(spec), /Protocol .* unsupported policy/)
  })
  const described = await freezeStudy(await experiment()), omittedSpec = await experiment()
  for (const key of ['selection', 'stopping', 'analysis']) delete omittedSpec.protocol[key]
  const omitted = await freezeStudy(omittedSpec)
  assert.equal(evaluateReadiness(described).eligible, true)
  assert.equal(evaluateReadiness(omitted).eligible, true)
  assert.deepEqual(omitted.schedule, described.schedule)
  assert.deepEqual(omitted.readiness.design, described.readiness.design)
  assert.deepEqual(omitted.readiness.population, described.readiness.population)
  assert.deepEqual(omitted.spec.analysisPlan, described.spec.analysisPlan)
})

test('historical metadata keeps exact version-1 reconstruction but cannot grant modern experimental admission', async () => {
  const spec = legacyStarter()
  spec.protocol.concurrency = 4; spec.protocol.stoppingRule = { kind: 'stop-after-three-successes' }
  spec.protocol.selection = { kind: 'best-of', k: 10 }; spec.protocol.stopping = 'Stop after three successful answers.'
  spec.conditions[0].adapter.sessionMode = 'shared'; spec.tasks[0].resetBeforeTrial = true
  const project = await freezeStudy(spec), original = canonical(project)
  assert.equal(project.version, 1); assert.equal(Object.hasOwn(project, 'readiness'), false)
  assert.equal(canonical(await verifyProject(JSON.parse(original))), original)
  assert.deepEqual(project.spec.protocol.stoppingRule, spec.protocol.stoppingRule)
  assert.equal(project.spec.conditions[0].adapter.sessionMode, 'shared')
  assert.equal(evaluateReadiness(project).eligible, false)
  const migrated = newExperimentDraft(spec, { purpose: 'experiment', initializePopulation: true })
  await assert.rejects(freezeStudy(migrated), /unsupported|unknown/i)
})

test('operational semantic answers expose the broker chronology and normalized vocabulary without changing historical native instructions', async () => {
  const legacy = await operationalStarter()
  const compile = spec => compileTask(spec, spec.tasks[0], { requireReview: false, requireTaskReview: false })
  const historical = await compile(legacy)
  assert.equal(historical.compiled.promptSha256, 'f81656eb8ff3c3d5b91c84cd238c92150cc5a89b952895e93494969dfe1342a4')
  const current = await compile(newExperimentDraft(legacy, { purpose: 'experiment', initializePopulation: true }))
  const prompt = current.compiled.text
  assert.match(prompt, /Public broker chronology:/)
  assert.match(prompt, /fill-eligible after delayBars completed input bars/)
  assert.match(prompt, /at most maxFillQuantity whole shares at that completed bar close, once per timestamp, with zero fees and slippage/)
  assert.match(prompt, /Existing fills arrive before on_data/)
  assert.match(prompt, /Cancellation-pending notices occur with the request/)
  assert.match(prompt, /submission processes queued cancellation acknowledgments before its own Submitted event; otherwise those acknowledgments arrive after on_data/)
  for (const status of ['new', 'accepted', 'partial', 'filled', 'cancelled', 'rejected', 'cancel-pending', 'none']) assert.ok(prompt.includes(status))
  for (const reason of ['entry', 'exit', 'reset', 'gate-close', 'race-release']) assert.ok(prompt.includes(reason))
  assert.ok(!prompt.includes(canonical(current.expected)), 'The public chronology must not disclose the private answer.')
  assert.doesNotMatch(prompt, /Implement class FrozenBenchmark|Return only Python source/)
})

async function externalExperiment() {
  const spec = await experiment()
  spec.conditions[0].adapter = { kind: 'http', url: 'https://invalid.example/never-called' }
  spec.conditions[0].collection = { comparisonUnit: 'model', instructions: { system: null, developer: null }, tools: [],
    contextConstruction: 'frozen-public-request', sessionIsolation: 'fresh-request' }
  spec.observationPlan = observationPlanFromSpec()
  spec.observationPlan.identity.policy = 'require-match'; spec.observationPlan.completion.policy = 'require-complete'
  return spec
}

test('experimental context admission follows each actual condition workflow and the exact generated public request', async () => {
  const spec = await externalExperiment(), direct = spec.conditions[0], flow = structuredClone(direct)
  direct.id = 'direct'; flow.id = 'projected'; spec.conditions.push(flow)
  spec.workflowPlan = workflowDraft(spec).plan; flow.workflowId = spec.workflowPlan.workflows[0].id
  flow.collection.contextConstruction = 'frozen-workflow-projection'; flow.collection.sessionIsolation = 'fresh-call-requested'
  const project = await freezeStudy(spec)
  assert.equal(assertCollectionAdmission(project).eligible, true)
  const directTrial = project.schedule.find(row => row.conditionId === direct.id), flowTrial = project.schedule.find(row => row.conditionId === flow.id)
  const directRequest = collectionRequest(project, project.spec.conditions[0], project.tasks[0], directTrial, 1)
  const projectedRequest = workflowRequest(newWorkflowState(project, flowTrial, 1))
  assert.equal(directRequest.collection.contextConstruction, 'frozen-public-request')
  assert.equal(directRequest.collection.sessionIsolation, 'fresh-request')
  assert.equal(projectedRequest.collection.contextConstruction, 'frozen-workflow-projection')
  assert.equal(projectedRequest.collection.sessionIsolation, 'fresh-call-requested')
  assert.equal(Object.hasOwn(directRequest, 'expected'), false)
  assert.equal(Object.hasOwn(projectedRequest, 'expected'), false)
  assert.deepEqual(JSON.parse(projectedRequest.prompt).parents, [])
  assert.deepEqual(project.readiness.capabilities.requestedContext.conditions, [
    { conditionId: 'direct', workflowId: null, contextConstruction: 'frozen-public-request', sessionIsolation: 'fresh-request' },
    { conditionId: 'projected', workflowId: flow.workflowId, contextConstruction: 'frozen-workflow-projection', sessionIsolation: 'fresh-call-requested' },
  ])
  assert.match(project.readiness.capabilities.requestedContext.scope, /Sent-request context only/)
  assert.match(project.readiness.capabilities.requestedContext.scope, /actual session isolation remain unobserved/)
  for (const index of [0, 1]) {
    const changed = structuredClone(spec), wrong = changed.conditions[index]
    wrong.collection.contextConstruction = index === 0 ? 'frozen-workflow-projection' : 'frozen-public-request'
    wrong.collection.sessionIsolation = index === 0 ? 'fresh-call-requested' : 'fresh-request'
    const rejected = await freezeStudy(changed)
    assert.ok(evaluateReadiness(rejected).blockers.some(row => row.code === 'requested-context-unsupported' && row.path === 'conditions.' + wrong.id + '.collection'))
    assert.throws(() => assertCollectionAdmission(rejected), /requested-context-unsupported/)
  }
})

test('shared-history narratives cannot admit an experiment and remain unqualified development or legacy declarations', async () => {
  const spec = await externalExperiment()
  spec.conditions[0].collection.contextConstruction = 'Reuse all previous condition outputs and hidden conversation history.'
  spec.conditions[0].collection.sessionIsolation = 'Persistent shared global conversation across conditions and trials.'
  const project = await freezeStudy(spec)
  assert.throws(() => assertCollectionAdmission(project), /requested-context-unsupported/)
  const declared = structuredClone(spec.conditions[0].collection)
  const development = await freezeStudy(newExperimentDraft(spec, { purpose: 'apparatus-development' }))
  assert.equal(assertCollectionAdmission(development, { operation: 'apparatus-development' }).eligible, true)
  assert.throws(() => assertCollectionAdmission(development), /experiment-purpose-required/)
  assert.deepEqual(development.spec.conditions[0].collection, declared)
  assert.match(development.readiness.scope, /no scientific inference/)
  const legacy = structuredClone(spec); legacy.schemaVersion = 1; delete legacy.executionPlan
  const historical = await freezeStudy(legacy), retained = canonical(historical)
  assert.equal(canonical(await verifyProject(JSON.parse(retained))), retained)
  assert.deepEqual(historical.spec.conditions[0].collection, declared)
  assert.equal(Object.hasOwn(historical, 'readiness'), false)
  assert.throws(() => assertCollectionAdmission(historical), /experiment-purpose-required/)
})

test('version-2 generated corpora freeze with exact generation bindings and detach into editable provenance without scientific admission', async () => {
  const spec = await bindRuntimeSources(newExperimentDraft(legacyStarter(), { initializePopulation: true }), sources)
  spec.corpusPlan = corpusPlanFromTask(spec.tasks[0])
  spec.corpusPlan.families[0].axes = [{ id: 'operand', choices: [2, 7].map(value => ({ id: 'value-' + value,
    edits: [{ kind: 'parameter', path: ['task'], name: 'a', value }, { kind: 'expected', value: String(value + 3) }] })) }]
  const generated = await materializeCorpus(spec); spec.tasks = generated.tasks
  spec.conditions[0].adapter.responses = Object.fromEntries(spec.tasks.map(task => [task.id, task.expected]))
  const project = await freezeStudy(spec)
  assert.equal(project.corpus.sha256, generated.manifestSha256)
  assert.deepEqual(project.tasks.map(task => task.generation), generated.tasks.map(task => task.generation))
  assert.equal(canonical(await verifyProject(project)), canonical(project))
  assert.equal(evaluateReadiness(project).eligible, false, 'Generation provenance cannot qualify an authored answer key.')
  for (const mutate of [
    draft => { draft.tasks[0].generation.constructionSha256 = '0'.repeat(64) },
    draft => { draft.tasks[0].generation.choices.operand = 'value-99' },
    draft => { draft.tasks[0].expected = 'manually changed before detachment' },
  ]) {
    const forged = structuredClone(spec); mutate(forged)
    await assert.rejects(freezeStudy(forged), /tasks differ from their task recipe/)
  }
  const orphan = structuredClone(spec); delete orphan.corpusPlan
  await assert.rejects(freezeStudy(orphan), /attached task recipe/)
  // This is the exact detach transformation used by the mounted builder.
  const detached = structuredClone(spec)
  detached.corpusHistory = [{ kind: 'detached-recipe', recipe: detached.corpusPlan }]; delete detached.corpusPlan
  detached.tasks = detached.tasks.map(({ generation, ...task }) => ({ ...task, origin: { kind: 'detached-corpus', generation } }))
  detached.tasks[0].expected = 'An authored answer after explicit detachment.'
  const refrozen = await freezeStudy(detached)
  assert.equal(Object.hasOwn(refrozen, 'corpus'), false)
  assert.deepEqual(refrozen.spec.corpusHistory[0].recipe, spec.corpusPlan)
  assert.deepEqual(refrozen.tasks.map(task => task.origin.generation), project.tasks.map(task => task.generation))
  assert.ok(refrozen.tasks.every(task => !Object.hasOwn(task, 'generation')))
  assert.equal(canonical(await verifyProject(refrozen)), canonical(refrozen))
  assert.equal(evaluateReadiness(refrozen).eligible, false)
  for (const mutate of [
    draft => { draft.corpusHistory = {} },
    draft => { draft.corpusHistory[0].kind = 'executable-recipe' },
    draft => { draft.corpusHistory[0].beforeRun = 'reset' },
    draft => { draft.corpusHistory[0].recipe.selection = { kind: 'best-of', limit: 2 } },
    draft => { draft.tasks[0].origin.kind = 'qualified-corpus' },
    draft => { draft.tasks[0].origin.generation.recipeSha256 = ['0'.repeat(64)] },
    draft => { draft.tasks[0].origin.generation.choices.operand = { execute: 'extra capability' } },
    draft => { draft.tasks[0].origin.generation.ready = true },
  ]) {
    const malformed = structuredClone(detached); mutate(malformed)
    await assert.rejects(freezeStudy(malformed), /corpus|Corpus|Task origin|Selection|selection|unsupported/)
  }
})

test('version-2 replay workflow fixtures preserve legitimate task-stage envelopes and reject ignored or malformed mappings', async () => {
  const spec = await bindRuntimeSources(newExperimentDraft(workflowFixture(), { purpose: 'apparatus-development', initializePopulation: true }), sources)
  const project = await freezeStudy(spec)
  assert.deepEqual(project.spec.conditions[0].adapter.workflowResponses, spec.conditions[0].adapter.workflowResponses)
  assert.equal(assertCollectionAdmission(project, { operation: 'apparatus-development' }).eligible, true)
  assert.equal(canonical(await verifyProject(project)), canonical(project))
  const subset = structuredClone(spec); subset.tasks = subset.tasks.slice(1)
  assert.deepEqual((await freezeStudy(subset)).spec.conditions[0].adapter.workflowResponses, spec.conditions[0].adapter.workflowResponses)
  for (const mutate of [
    draft => { delete draft.conditions[0].workflowId },
    draft => { draft.conditions[0].adapter.mode = 'output' },
    draft => { draft.conditions[0].adapter.workflowResponses = [] },
    draft => { draft.conditions[0].adapter.workflowResponses['Invalid Task'] = {} },
    draft => { draft.conditions[0].adapter.workflowResponses['addition-a'].unknown = { output: '5' } },
    draft => { draft.conditions[0].adapter.workflowResponses['addition-a'].draft = '5' },
  ]) {
    const malformed = structuredClone(spec); mutate(malformed)
    await assert.rejects(freezeStudy(malformed), /[Ww]orkflow|[Rr]ecorded/)
  }
})


test('original wording provenance is a pinned source pointer and cannot declare execution capabilities', async () => {
  const spec = await experiment()
  spec.inputs.push({ path: 'original/task.txt', sha256: 'a'.repeat(64) })
  spec.tasks[0].provenance = { originalPromptPath: 'original/task.txt' }
  const project = await freezeStudy(spec)
  assert.deepEqual(project.spec.tasks[0].provenance, spec.tasks[0].provenance)
  await verifyProject(project)
  for (const provenance of [
    { originalPromptPath: '../outside.txt' },
    { originalPromptPath: 'not-pinned.txt' },
    { originalPromptPath: 'original/task.txt', qualified: true },
  ]) {
    const changed = structuredClone(spec); changed.tasks[0].provenance = provenance
    await assert.rejects(freezeStudy(changed), /pinned input manifest|unsupported fields/)
  }
})
