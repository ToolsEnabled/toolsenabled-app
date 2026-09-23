import test from 'node:test'
import assert from 'node:assert/strict'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'
import { compileRequirementPlan } from '../../src/benchmark/requirements.mjs'
import { materializeExperimentTemplate, compileExperimentTemplate } from '../../src/benchmark/templates.mjs'
import { observationPlanFromSpec } from '../../src/benchmark/observations.mjs'
import { validateExecutionPlan, deriveReadinessContract, readinessProjectFiles, evaluateReadiness, assertCollectionAdmission } from '../../src/benchmark/readiness.mjs'
import { genericActivationFixture } from './fixtures/research-benchmark-generic-activation.mjs'
import { resourceTemplateRecipe } from './fixtures/research-benchmark-resource-template.mjs'

const design = () => ({ schedule: 'crossed-task-condition', replicates: 'repeated-measurements', primaryOutcome: 'binary-pass', dependence: 'descriptive-only' })
function modern(spec, purpose = 'experiment') {
  spec.schemaVersion = 2
  spec.executionPlan = { version: 1, purpose, ...(purpose === 'experiment' ? { design: design() } : {}) }
  spec.analysisPlan.primaryPopulation = 'all'
  spec.analysisPlan.primaryDenominator = 'scheduled'; spec.analysisPlan.uncertainty = null; spec.analysisPlan.multiplicity = 'none-descriptive'
  return spec
}
async function compiled(spec) {
  const tasks = await Promise.all(spec.tasks.map(task => compileTask(spec, task, { requireReview: false, requireTaskReview: false })))
  const schedule = tasks.flatMap(task => spec.conditions.flatMap(condition => Array.from({ length: spec.protocol.replicates }, (_, i) => ({ id: `${task.id}.${condition.id}.${i + 1}`, taskId: task.id, conditionId: condition.id, replicate: i + 1 }))))
  // A small static compiler inventory. Full export/runner tests additionally
  // verify the authoritative current inventory and actual source file bytes.
  const runtimeFiles = ['prompts.mjs', 'readiness.mjs']
  spec.runtimeSources = Object.fromEntries(await Promise.all(runtimeFiles.map(async file => [file, await sha256('static-unit-source:' + file)])))
  const project = { format: 'research-benchmark', version: spec.schemaVersion, spec, tasks, schedule, ...(spec.schemaVersion === 2 ? { runtimeFiles } : {}) }
  if (spec.requirementPlan) project.requirements = await compileRequirementPlan(spec, tasks, { requireReview: false })
  if (spec.experimentTemplate) project.experimentTemplate = await compileExperimentTemplate(spec)
  project.readiness = await deriveReadinessContract(project)
  if (project.readiness === null) delete project.readiness
  return project
}
async function generic() { return compiled(modern((await genericActivationFixture()).spec)) }
const codes = (project, operation = 'collect') => evaluateReadiness(project, { operation }).blockers.map(row => row.code)
async function change(project, mutate) {
  const result = structuredClone(project); mutate(result); result.readiness = await deriveReadinessContract(result); return result
}

test('new execution purposes and scientific design fields are strict; legacy markers cannot downgrade', () => {
  assert.equal(validateExecutionPlan({ schemaVersion: 1 }), null)
  assert.throws(() => validateExecutionPlan({ schemaVersion: 1, executionPlan: undefined }), /legacy/)
  assert.throws(() => validateExecutionPlan({ schemaVersion: 2 }), /Execution plan/)
  const good = { schemaVersion: 2, executionPlan: { version: 1, purpose: 'experiment', design: design() } }
  assert.equal(validateExecutionPlan(good), good.executionPlan)
  for (const mutate of [
    spec => { spec.executionPlan.ready = true },
    spec => { spec.executionPlan.purpose = 'qualification' },
    spec => { delete spec.executionPlan.design },
    spec => { spec.executionPlan.design.schedule = 'selected-completed' },
    spec => { spec.executionPlan.design.replicates = 'independent-samples' },
    spec => { spec.executionPlan.design.primaryOutcome = 'arbitrary-module-score' },
    spec => { spec.executionPlan.design.dependence = 'independent' },
    spec => { spec.executionPlan.design.primarySplit = 'held-out' },
  ]) { const candidate = structuredClone(good); mutate(candidate); assert.throws(() => validateExecutionPlan(candidate)) }
  assert.ok(validateExecutionPlan({ schemaVersion: 2, executionPlan: { version: 1, purpose: 'recorded-diagnostic' } }))
})

test('a circular wrong answer key is only a recorded diagnostic and cannot acquire collection eligibility through cohort', async () => {
  const { spec } = await genericActivationFixture(); delete spec.requirementPlan; spec.inputs = []
  spec.tasks[0].expected = '999'; spec.conditions[0].adapter.responses = { 'addition-a': '999' }
  const project = await compiled(modern(spec))
  assert.ok(codes(project).includes('independent-oracle-required'))
  assert.ok(codes(project).includes('composition-policy-required'))
  for (const cohort of ['qualification', 'pilot', 'confirmatory']) {
    const altered = await change(project, p => { p.spec.analysisPlan.cohort = cohort })
    assert.throws(() => assertCollectionAdmission(altered), /independent-oracle-required/)
  }
  const diagnostic = await change(project, p => { p.spec.executionPlan = { version: 1, purpose: 'recorded-diagnostic' } })
  assert.equal(assertCollectionAdmission(diagnostic, { operation: 'diagnostic-replay', canonicalReplay: true }).eligible, true)
  assert.throws(() => assertCollectionAdmission(diagnostic), /experiment-purpose-required/)
  assert.throws(() => assertCollectionAdmission(diagnostic, { operation: 'diagnostic-replay' }), /canonical-replay-required/)
})

test('complete source-bound generic registration derives a static contract without predicting fresh proof success', async () => {
  const project = await generic(), result = evaluateReadiness(project)
  assert.equal(result.eligible, true); assert.equal(result.profile.id, 'generic-interpreted-answer')
  assert.deepEqual(result.requiredProofs.map(row => row.kind), ['selected-input-qualification'])
  assert.equal(project.readiness.coverage.occurrences, 1); assert.equal(project.readiness.coverage.registered, 1)
  assert.equal(Object.hasOwn(project.readiness, 'ready'), false)
  assert.match(result.scope, /Static operation eligibility only/)
  assert.equal(canonical(project.readiness), canonical(await deriveReadinessContract(JSON.parse(canonical(project)))))
  const { sha256: digest, ...body } = project.readiness; assert.equal(digest, await sha256(canonical(body)))
  assert.equal(Object.hasOwn(project.readiness.bindings, 'projectSha256'), false)
  assert.equal(project.readiness.bindings.specificationSha256, await sha256(canonical(project.spec)))
})

test('omitted gates, partial occurrence coverage, empty controls and invalid interpreter bindings fail closed', async () => {
  const project = await generic()
  const mutations = [
    [p => { delete p.requirements }, 'composition-policy-required'],
    [p => { p.requirements.selectedInput.policy = 'report' }, 'composition-policy-required'],
    [p => { p.requirements.selectedInput.policy = 'require-registered' }, 'composition-policy-required'],
    [p => { p.requirements.targets = [] }, 'composition-coverage-incomplete'],
    [p => { p.requirements.selectedInput.unregistered = [{ taskId: 'addition-a' }] }, 'composition-coverage-incomplete'],
    [p => { p.requirements.targets[0].selectedInput.wrongReadings = [] }, 'qualification-controls-incomplete'],
    [p => { p.requirements.targets[0].selectedInput.wrongReadings[0].constructionError = 'Invalid selected input' }, 'qualification-controls-incomplete'],
    [p => { p.requirements.targets[0].activation = [] }, 'qualification-controls-incomplete'],
    [p => { p.requirements.interpreters.independent.sha256 = p.requirements.interpreters.reference.sha256 }, 'independent-oracle-required'],
    [p => { p.spec.inputs = [] }, 'independent-oracle-required'],
    [p => { delete p.spec.requirementPlan.interpreters }, 'independent-oracle-required'],
  ]
  for (const [mutate, expected] of mutations) assert.ok(codes(await change(project, mutate)).includes(expected), expected)
})

test('coverage recomputes all admissible reading occurrences instead of trusting an authored occurrence count', async () => {
  const project = await generic()
  const altered = await change(project, p => {
    const task = p.tasks[0], first = { id: 'first', compiled: structuredClone(task.compiled) }, second = { id: 'second', compiled: structuredClone(task.compiled) }
    task.information = {}; task.interpretations = [first, second]
    p.requirements.targets[0].readingId = 'first'
    p.requirements.selectedInput.compositionOccurrences = 2; p.requirements.selectedInput.unregistered = []
  })
  assert.equal(altered.readiness.coverage.occurrences, 2)
  assert.equal(altered.readiness.coverage.missing[0].readingId, 'second')
  assert.ok(codes(altered).includes('composition-coverage-incomplete'))
})

test('primary population, scheduled denominator, crossed roster and dependence are mechanical requirements', async () => {
  const project = await generic()
  for (const [mutate, expected] of [
    [p => { delete p.spec.analysisPlan.primaryPopulation }, 'primary-population-required'],
    [p => { p.spec.analysisPlan.primaryPopulation = { kind: 'split', split: 'held-out' } }, 'primary-population-empty'],
    [p => { p.spec.analysisPlan.primaryDenominator = 'completed' }, 'scheduled-denominator-required'],
    [p => { p.spec.protocol.grading.primaryMetric = 'unimplemented' }, 'grading-configuration-unsupported'],
    [p => { p.schedule = [] }, 'crossed-schedule-required'],
    [p => { p.schedule.push(structuredClone(p.schedule[0])) }, 'crossed-schedule-required'],
    [p => { p.spec.analysisPlan.uncertainty = { kind: 'family-bootstrap' } }, 'descriptive-analysis-required'],
    [p => { p.spec.executionPlan.design.dependence = 'family-clusters' }, 'family-bootstrap-required'],
  ]) assert.ok(codes(await change(project, mutate)).includes(expected), expected)
  assert.deepEqual(project.readiness.population.taskIds, ['addition-a'])
  assert.deepEqual(project.readiness.population.ledger, [{ taskId: 'addition-a', split: 'development', included: true, reason: null }])
  const altered = await change(project, p => { p.primaryPopulation = { ...p.readiness.population, taskIds: [] } })
  assert.ok(codes(altered).includes('primary-population-drift'))
})

test('HTTPS collection requires reported identity and completion and explicit public collection controls', async () => {
  const project = await change(await generic(), p => { p.spec.conditions[0].adapter = { kind: 'http', url: 'https://invalid.example/never-called' } })
  assert.ok(codes(project).includes('reported-identity-required')); assert.ok(codes(project).includes('reported-completion-required'))
  const complete = await change(project, p => {
    p.spec.observationPlan = observationPlanFromSpec(); p.spec.observationPlan.identity.policy = 'require-match'; p.spec.observationPlan.completion.policy = 'require-complete'
    p.spec.conditions[0].collection = { comparisonUnit: 'model', instructions: { system: null, developer: null }, tools: [], contextConstruction: 'frozen-public-request', sessionIsolation: 'fresh-request' }
  })
  assert.equal(evaluateReadiness(complete).eligible, true)
  for (const [mutate, expected] of [
    [p => { p.spec.observationPlan.identity.fields = ['provider'] }, 'reported-identity-required'],
    [p => { p.spec.observationPlan.mapping.identity.id = null }, 'reported-identity-required'],
    [p => { p.spec.observationPlan.mapping.completion.status = null }, 'reported-completion-required'],
    [p => { p.spec.conditions[0].collection.tools = [{ name: 'arbitrary-filesystem' }] }, 'opaque-tools-unsupported'],
    [p => { p.spec.conditions[0].collection.comparisonUnit = 'system' }, 'collection-controls-required'],
    [p => { p.spec.conditions[0].collection.contextConstruction = 'Reuse previous condition outputs and hidden history.' }, 'requested-context-unsupported'],
    [p => { p.spec.conditions[0].collection.sessionIsolation = 'Persistent shared global conversation.' }, 'requested-context-unsupported'],
    [p => { p.spec.conditions[0].collection.contextConstruction = 'frozen-workflow-projection'; p.spec.conditions[0].collection.sessionIsolation = 'fresh-call-requested' }, 'requested-context-unsupported'],
    [p => { p.spec.conditions[0].adapter = { kind: 'module', file: 'adapter.mjs' } }, 'collector-unsupported'],
    [p => { p.spec.conditions[0].adapter = { kind: 'command', command: 'node', args: [] } }, 'collector-unsupported'],
    [p => { p.spec.environment.sharedState = true }, 'execution-environment-unsupported'],
  ]) assert.ok(codes(await change(complete, mutate)).includes(expected), expected)
  assert.match(complete.readiness.capabilities.requestedContext.scope, /Provider adherence, hidden history and actual session isolation remain unobserved/)
  assert.deepEqual(complete.readiness.capabilities.requestedContext.conditions, [{ conditionId: complete.spec.conditions[0].id,
    workflowId: null, contextConstruction: 'frozen-public-request', sessionIsolation: 'fresh-request' }])
  assert.throws(() => evaluateReadiness(complete, { host: { capabilities: ['native'] } }), /unsupported fields/)
})

test('generated resource criteria retain their independent observer and required conformance obligation', async () => {
  const { spec } = await genericActivationFixture(); delete spec.requirementPlan; spec.inputs = []
  const recipe = resourceTemplateRecipe(), generated = await materializeExperimentTemplate(recipe)
  Object.assign(spec, { experimentTemplate: recipe, catalog: generated.catalog, tasks: generated.tasks })
  spec.protocol.grading = { kind: 'resource-action-plan' }
  spec.conditions[0].adapter.responses = Object.fromEntries(spec.tasks.map(task => [task.id, task.resource.referencePlan]))
  const project = await compiled(modern(spec))
  assert.equal(evaluateReadiness(project).eligible, true)
  assert.equal(project.readiness.capabilities.state, 'fresh-owned-synthetic-resource-map')
  assert.deepEqual(project.readiness.requiredProofs.map(row => row.kind), ['source-bound-resource-conformance'])
  assert.ok(project.tasks.every(task => task.expected === null))
  assert.ok(codes(await change(project, p => { p.tasks[0].expected = true })).includes('resource-contract-required'))
})

test('native and arbitrary custom graders cannot acquire admission from semantic qualification or host flags', async () => {
  const project = await generic()
  const native = await change(project, p => { p.spec.domain = 'lean-bench'; p.spec.protocol.grading = { kind: 'lean-python' }; p.spec.environment.leanImage = 'image@sha256:' + 'a'.repeat(64) })
  assert.ok(codes(native).includes('native-admission-unavailable')); assert.match(native.readiness.profile.scope, /semantic answer qualification is insufficient/)
  const custom = await change(project, p => { p.spec.protocol.grading = { kind: 'module', file: 'grader.mjs' } })
  assert.ok(codes(custom).includes('scientific-endpoint-unsupported'))
  assert.throws(() => assertCollectionAdmission(native, { capabilities: ['native'] }), /unsupported fields/)
})

test('reference audit eligibility is bound to its exact source criterion with unresolved cases visible', async () => {
  const project = await generic(), hash = 'a'.repeat(64)
  const audit = await change(project, p => {
    p.spec.protocol.grading = { kind: 'judge-audit' }; p.spec.analysisPlan.primaryPopulation = 'reference-eligible'
    p.spec.auditPlan = { reference: { sha256: hash, project: { sha256: 'd'.repeat(64), spec: { schemaVersion: 2, executionPlan: { version: 1, purpose: 'apparatus-development' } } } } }
    p.audit = { sha256: 'b'.repeat(64), manifest: { referenceSha256: hash } }
    p.tasks[0].audit = { referenceSha256: hash, referenceVerdict: 'accept' }
    delete p.requirements; delete p.spec.requirementPlan
  })
  assert.equal(evaluateReadiness(audit).eligible, true); assert.equal(audit.readiness.profile.id, 'reference-audit')
  assert.equal(audit.readiness.referenceAncestry.sourcePurpose, 'apparatus-development')
  assert.match(audit.readiness.referenceAncestry.scope, /not upgraded/)
  assert.deepEqual(audit.readiness.population.taskIds, ['addition-a'])
  const unknown = await change(audit, p => { p.tasks[0].audit.referenceVerdict = null })
  assert.ok(codes(unknown).includes('primary-population-empty')); assert.equal(unknown.readiness.population.ledger[0].reason, 'unresolved-reference')
  assert.ok(codes(await change(audit, p => { p.tasks[0].audit.referenceSha256 = 'c'.repeat(64) })).includes('audit-reference-required'))
  assert.ok(codes(await change(audit, p => { delete p.spec.auditPlan.reference.project })).includes('audit-source-scope-required'))
})

test('explicit apparatus development can debug custom code but never returns experimental admission', async () => {
  const project = await change(await generic(), p => {
    p.spec.executionPlan = { version: 1, purpose: 'apparatus-development' }
    p.spec.protocol.grading = { kind: 'module', file: 'diagnostic-grader.mjs' }
    p.spec.conditions[0].adapter = { kind: 'command', command: 'local-diagnostic-command', args: [] }
  })
  assert.equal(assertCollectionAdmission(project, { operation: 'apparatus-development' }).eligible, true)
  assert.match(evaluateReadiness(project, { operation: 'apparatus-development' }).scope, /development computations only; no scientific inference/)
  assert.ok(project.readiness.scientificBlockers.some(row => row.code === 'scientific-endpoint-unsupported'))
  assert.ok(codes(project).includes('scientific-endpoint-unsupported')); assert.ok(codes(project).includes('experiment-purpose-required'))
  assert.deepEqual(project.readiness.requiredProofs.map(row => row.kind), ['selected-input-qualification'])
  assert.throws(() => assertCollectionAdmission(project, { operation: 'diagnostic-replay', canonicalReplay: true }), /diagnostic-purpose-required/)
  const changedCohort = await change(project, p => { p.spec.analysisPlan.cohort = 'confirmatory' })
  assert.throws(() => assertCollectionAdmission(changedCohort, { operation: 'apparatus-development' }), /development-cohort-required/)
  assert.throws(() => assertCollectionAdmission(changedCohort), /experiment-purpose-required/)
})

test('apparatus development retains finite budgets and pins while allowing analysis computations to be exercised', async () => {
  const project = await change(await generic(), p => {
    p.spec.executionPlan = { version: 1, purpose: 'apparatus-development' }
    p.spec.analysisPlan.primaryDenominator = 'completed'
    p.spec.analysisPlan.uncertainty = { kind: 'family-bootstrap', seed: 42, iterations: 100, confidence: 0.95 }
    p.spec.analysisPlan.multiplicity = 'bonferroni'; p.tasks[0].familyId = 'one-debug-family'
  })
  assert.equal(evaluateReadiness(project, { operation: 'apparatus-development' }).eligible, true)
  assert.ok(codes(project).includes('scheduled-denominator-required'))
  for (const mutate of [p => { p.spec.protocol.maxDurationMs = 86400001 }, p => { p.spec.protocol.maxTotalAttempts = 0 }]) {
    const candidate = structuredClone(project); mutate(candidate)
    assert.ok(evaluateReadiness(candidate, { operation: 'apparatus-development' }).blockers.some(row => row.code === 'development-budgets-required'))
  }
  const nonfinite = structuredClone(project); nonfinite.spec.protocol.maxDurationMs = Infinity
  await assert.rejects(deriveReadinessContract(nonfinite), /finite JSON/)
  const missingPins = await change(project, p => { p.spec.runtimeSources = {} })
  assert.throws(() => assertCollectionAdmission(missingPins, { operation: 'apparatus-development' }), /complete-runtime-pins-required/)
})

test('canonical readiness artifacts and stale-descriptor rejection preserve the distinction between generated and authored readiness', async () => {
  const project = await generic(), files = readinessProjectFiles(project)
  assert.deepEqual(Object.keys(files), ['readiness/contract.json', 'readiness/population.json'])
  assert.equal(files['readiness/contract.json'], canonical(project.readiness) + '\n')
  assert.equal(files['readiness/population.json'], canonical(project.readiness.population) + '\n')
  for (const mutate of [p => { delete p.readiness }, p => { p.readiness.profile.id = 'universally-ready' }, p => { p.readiness.ready = true }, p => { p.spec.analysisPlan.primaryDenominator = 'completed' }]) {
    const altered = structuredClone(project); mutate(altered)
    assert.ok(codes(altered).includes('readiness-contract-missing-or-changed'))
  }
})

test('the complete rebuilt runtime inventory is mandatory and separately bound for new contracts', async () => {
  const project = await generic()
  assert.equal(project.readiness.bindings.runtimeFilesSha256, await sha256(canonical(project.runtimeFiles)))
  for (const mutate of [
    p => { delete p.runtimeFiles },
    p => { p.runtimeFiles.push(p.runtimeFiles[0]) },
    p => { delete p.spec.runtimeSources['prompts.mjs'] },
    p => { p.spec.runtimeSources['unexpected.mjs'] = 'a'.repeat(64) },
    p => { p.spec.runtimeSources['readiness.mjs'] = 'not-a-digest' },
  ]) assert.ok(codes(await change(project, mutate)).includes('complete-runtime-pins-required'))
})

test('legacy bytes receive no readiness artifact and only canonical built-in replay can start diagnostic work', async () => {
  const project = await generic(); project.spec.schemaVersion = 1; delete project.spec.executionPlan; delete project.readiness
  const before = canonical(project)
  assert.equal(await deriveReadinessContract(project), null); assert.deepEqual(readinessProjectFiles(project), {})
  assert.equal(canonical(project), before)
  assert.throws(() => assertCollectionAdmission(project), /experiment-purpose-required/)
  assert.equal(assertCollectionAdmission(project, { operation: 'diagnostic-replay', canonicalReplay: true }).eligible, true)
  assert.throws(() => assertCollectionAdmission(project, { operation: 'diagnostic-replay', canonicalReplay: false }), /canonical-replay-required/)
  const external = structuredClone(project); external.spec.conditions[0].adapter.kind = 'http'
  assert.throws(() => assertCollectionAdmission(external, { operation: 'diagnostic-replay', canonicalReplay: true }), /recorded-responses-required/)
  const custom = structuredClone(project); custom.spec.protocol.grading.kind = 'module'
  assert.throws(() => assertCollectionAdmission(custom, { operation: 'diagnostic-replay', canonicalReplay: true }), /diagnostic-grader-unsupported/)
})
