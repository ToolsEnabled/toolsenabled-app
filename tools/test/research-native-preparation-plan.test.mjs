import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { canonical, createReviewRecord, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES, verifyProject } from '../../src/benchmark/study.mjs'
import { bindLeanReview, generateLeanProgram, inlineLeanProgram } from '../../src/benchmark/lean-codegen.mjs'
import { compileTask, deriveTaskExpected } from '../../src/benchmark/tasks.mjs'
import { createTaskReviewRecord } from '../../src/benchmark/information.mjs'
import { nativeControlContract, nativeControlSource, validateNativePreparationPlan, compileNativePreparationPlan } from '../../src/benchmark/requirements.mjs'
import { auditFileBytes, materializeNativeControl, verifyNativeControl } from '../../src/benchmark/audit.mjs'
import { operationalReferenceProgram, operationalCandidateFiles } from '../../src/benchmark/trading-study.mjs'
import { evaluateReadiness } from '../../src/benchmark/readiness.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { observationPlanFromSpec } from '../../src/benchmark/observations.mjs'
import { workflowDraft } from '../../src/benchmark/workflow.mjs'
import { activationFixture } from './fixtures/research-benchmark-activation.mjs'

// Pure source generation and verification. These controls never execute a
// generated program, native engine, provider, grader or collection adapter.
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const at = '2026-09-09T00:00:00.000Z', reviewer = 'SYNTHETIC NATIVE PLAN TEST; NO PERSONAL APPROVAL'
const inputs = { 'fixtures/notes.txt': 'Synthetic pinned parent input.\n', 'fixtures/bytes.bin': { encoding: 'base64', data: Buffer.from([0, 255, 123, 10]).toString('base64') } }
const copy = value => JSON.parse(canonical(value))
const digest = value => sha256(canonical(value))
const recipe = () => ({ version: 1, coverage: 'all-selected-readings-occurrences-and-probes', rationale: 'Synthetic complete registry materialization; no native execution.',
  referenceReplicates: 3, mutantReplicates: 1, budgets: { maxNativeExecutions: 100, executionTimeoutMs: 1000, attemptTimeoutMs: 31000, maxDurationMs: 60000 } })
const files = () => ({ runtimeFiles: { ...sources }, inputFiles: copy(inputs) })
async function retain(name, value) {
  if (!process.env.RESEARCH_NATIVE_PREPARATION_EVIDENCE) return
  const path = resolve(process.env.RESEARCH_NATIVE_PREPARATION_EVIDENCE, name); await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
}
async function makeFixture({ synchronous = false, information = false, workflow = false, mutate = () => {} } = {}) {
  let spec = synchronous ? leanStarter() : await activationFixture()
  if (synchronous) {
    const task = spec.tasks[0]
    for (const bar of task.input.bars) bar.prices.QQQ = bar.prices.SPY
    task.expected = await deriveTaskExpected(spec, task)
    const root = copy(task.root); root.slots.strategy.params.symbol = 'QQQ'
    spec.requirementPlan = { version: 1, selectedInput: { policy: 'require-composition', rationale: 'Keep unregistered synchronous occurrences visible.', timeoutMs: 30000 },
      targets: [{ id: 'strategy-symbol', taskId: task.id, requirementId: 'root/strategy#strategy', rationale: 'Synthetic isolated Strategy asset counterpart.',
        activation: [{ kind: 'transition', name: 'buy', minimum: 1 }], probes: [{ id: 'same-prices', input: copy(task.input), assertions: [{ path: [0, 'symbol'], equals: 'SPY' }] }],
        wrongReadings: [{ id: 'qqq', root, rationale: 'Change only the Strategy symbol.' }] }] }
  }
  if (information) {
    assert.equal(synchronous, false)
    const task = spec.tasks[0], originalTargets = copy(spec.requirementPlan.targets)
    task.familyId = 'explicit-quantities'
    task.information = { version: 1, scope: 'declared-set', responseMode: 'raw', withheldPaths: ['root/buy_process'], rationale: 'Two explicitly registered private quantity readings.',
      readings: [4, 3].map(quantity => { const root = copy(task.root); root.slots.buy_process.params.quantity = quantity; return { id: 'shares-' + quantity, root, rationale: 'Synthetic ' + quantity + ' shares.' } }) }
    spec.requirementPlan.targets = [4, 3].flatMap(quantity => originalTargets.map(original => {
      const target = copy(original); target.id += '-' + quantity; target.readingId = 'shares-' + quantity
      if (original.id !== 'entry-quantity') for (const wrong of target.wrongReadings) wrong.root.slots.buy_process.params.quantity = quantity
      if (original.id === 'entry-quantity') target.probes[0].assertions = [{ path: ['orders', 0, 'quantity'], equals: quantity }]
      if (original.id === 'private-exit-quantity') target.probes[0].assertions = [{ path: ['orders', 1, 'quantity'], equals: -quantity }]
      return target
    }))
  }
  spec = newExperimentDraft(spec, { purpose: 'apparatus-development', initializePopulation: true })
  spec.analysisPlan.cohort = 'qualification'
  spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 1000 }
  spec.environment.leanImage = 'synthetic-unexecuted-image@sha256:' + 'a'.repeat(64)
  spec.nativePreparationPlan = recipe()
  spec.inputs = await Promise.all(Object.entries(inputs).map(async ([path, value]) => ({ path, sha256: await sha256(auditFileBytes(value)) })))
  if (workflow) {
    spec.observationPlan = observationPlanFromSpec()
    spec.workflowPlan = workflowDraft(spec).plan
    for (const condition of spec.conditions) {
      condition.workflowId = 'prompt-flow'
      condition.adapter = { kind: 'replay', mode: 'envelope', responses: {}, workflowResponses: Object.fromEntries(spec.tasks.map(task => [task.id, { answer: { output: '# Synthetic workflow program', workflow: { toolCalls: [] } } }])) }
    }
  }
  await mutate(spec)
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, reviewer, { at })))
  if (spec.tasks.some(task => task.information)) spec.taskReviews = await Promise.all(spec.tasks.filter(task => task.information).map(async task => createTaskReviewRecord(await compileTask(spec, task, { requireTaskReview: false }), reviewer, at)))
  return freezeStudy(spec)
}
let operational, synchronous, information
const operation = () => operational ||= makeFixture()
const sync = () => synchronous ||= makeFixture({ synchronous: true })
const readings = () => information ||= makeFixture({ information: true, workflow: true })
const mutantJob = project => project.nativePreparation.jobs.find(job => job.kind === 'mutant' && ['other-asset', 'qqq'].includes(job.source.wrongReadingId))
async function sealedHash(object) { const { sha256: _hash, ...body } = object; return digest(body) }

test('complete operational controls retain every selected/probe obligation while counting deduplicated jobs honestly', async () => {
  const project = await operation(), plan = project.nativePreparation
  assert.deepEqual(plan.counts, { jobs: 6, referenceJobs: 1, mutantJobs: 5, nativeExecutions: 8, coverageRows: 10 })
  assert.equal(plan.coverageStatus, 'complete'); assert.deepEqual(plan.gaps, []); assert.equal(plan.executionStatus, 'not-run')
  assert.equal(new Set(plan.coverage.map(row => row.referenceJobId)).size, 1)
  assert.equal(plan.coverage.filter(row => row.scope === 'selected-input').length, 5)
  assert.equal(plan.coverage.filter(row => row.scope === 'probe').length, 5)
  for (const target of project.requirements.targets) {
    const rows = plan.coverage.filter(row => row.targetId === target.id)
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row.mutants.length === 1))
    assert.equal(rows[0].mutants[0].jobId, rows[1].mutants[0].jobId, 'Identical selected/probe input does not create another physical execution.')
  }
  assert.deepEqual(await compileNativePreparationPlan(copy(project.spec), copy(project.requirements)), plan)
  assert.equal(plan.sha256, await sealedHash(plan)); assert.equal(plan.recipeSha256, await digest(project.spec.nativePreparationPlan)); assert.equal(plan.requirementsSha256, project.requirements.sha256)
  assert.deepEqual(plan.runtimeSources, project.spec.runtimeSources); assert.deepEqual(plan.inputBindings, project.spec.inputs); assert.deepEqual(plan.environment, project.spec.environment)
  assert.deepEqual(plan.apparatusRequirements, project.requirements.selectedInput.apparatusRequirements)
  assert.ok(plan.apparatusRequirements.length > 0, 'Complete composition rows do not erase separate apparatus obligations.')
  assert.match(plan.scope, /No controls have run|No.*run/)
  assert.ok(evaluateReadiness(project, { operation: 'collect' }).blockers.some(row => row.code === 'native-admission-unavailable'))
  await retain('operational/project.json', project)
})

test('both profiles materialize asset mutants under their own task and public contract without altering baseline truths', async () => {
  for (const [name, project] of [['operational', await operation()], ['synchronous', await sync()]]) {
    const before = canonical(project), job = mutantJob(project), { reference, program } = nativeControlSource(project.requirements, job.source)
    assert.notDeepEqual(reference.expected, program.expected)
    assert.equal(job.referenceTaskSha256, await digest(reference)); assert.equal(job.programTaskSha256, await digest(program)); assert.equal(job.inputSha256, await digest(program.input))
    assert.equal(job.referenceContractSha256, await digest(nativeControlContract(reference))); assert.equal(job.programContractSha256, await digest(nativeControlContract(program)))
    assert.notEqual(job.referenceContractSha256, job.programContractSha256)
    const control = await materializeNativeControl(project, job.id, files()), child = control.controlProject
    assert.deepEqual(child.tasks[0].root, program.root); assert.deepEqual(child.tasks[0].expected, program.expected); assert.deepEqual(child.tasks[0].input, program.input)
    assert.notDeepEqual(child.tasks[0].expected, reference.expected)
    assert.equal(child.spec.executionPlan.purpose, 'apparatus-development'); assert.equal(child.spec.protocol.grading.kind, 'lean-python')
    assert.equal(child.spec.protocol.replicates, 1); assert.equal(child.schedule.length, 1)
    assert.equal(child.spec.analysisPlan.cohort, 'qualification'); assert.equal(child.spec.analysisPlan.primaryDenominator, 'scheduled')
    assert.equal(child.spec.analysisPlan.primaryPopulation, 'all')
    assert.deepEqual(child.spec.reviews, project.spec.reviews); assert.equal(Object.hasOwn(child.spec, 'taskReviews'), false)
    for (const key of ['nativePreparationPlan', 'requirementPlan', 'workflowPlan', 'observationPlan', 'corpusPlan', 'auditPlan']) assert.equal(Object.hasOwn(child.spec, key), false)
    assert.equal(Object.hasOwn(child.tasks[0], 'information'), false)
    assert.equal(control.parentProjectSha256, project.sha256); assert.equal(control.nativePlanSha256, project.nativePreparation.sha256)
    assert.equal(control.binding.requirementsSha256, project.requirements.sha256); assert.deepEqual(control.binding.job, job)
    assert.deepEqual(control.binding.referenceExpected, reference.expected); assert.deepEqual(control.binding.programExpected, program.expected)
    assert.match(control.binding.predicate, /own-task-native-observation-equals-mutant-expectation-and-differs-from-bound-reference-expectation/)
    const code = name === 'operational' ? operationalReferenceProgram(program, sources) : inlineLeanProgram(generateLeanProgram(program), sources)
    assert.equal(child.spec.conditions[0].adapter.responses.control, code.trim()); assert.equal(control.programSha256, await sha256(code.trim()))
    if (name === 'operational') assert.notEqual(operationalCandidateFiles(reference, code, sources)['main.py'], operationalCandidateFiles(program, code, sources)['main.py'])
    assert.equal(child.spec.inputs.find(row => row.path === 'native-control/binding.json').sha256, await sha256(canonical(control.binding) + '\n'))
    assert.equal(control.sha256, await sealedHash(control)); assert.equal(control.controlProjectSha256, child.sha256)
    assert.deepEqual(await verifyNativeControl({ parentProject: project, control }, files()), control)
    assert.equal(canonical(project), before)
    await retain(name + '/control.json', control); await retain(name + '/binding.json', canonical(control.binding) + '\n')
    await retain(name + '/project.json', project)
  }
})

test('all explicit readings receive their own baseline associations and child projection drops the parent workflow/information', async () => {
  const project = await readings(), plan = project.nativePreparation
  assert.equal(plan.coverageStatus, 'complete'); assert.equal(plan.coverage.length, 20)
  assert.deepEqual(plan.counts, { jobs: 12, referenceJobs: 2, mutantJobs: 10, nativeExecutions: 16, coverageRows: 20 })
  for (const id of ['shares-4', 'shares-3']) assert.equal(plan.coverage.filter(row => row.readingId === id).length, 10)
  assert.ok(plan.coverage.every(row => row.readingId !== null))
  const rows = plan.coverage.filter(row => row.requirementId === 'root/buy_process#op-shares' && row.scope === 'selected-input')
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].mutants[0].jobId, rows[1].mutants[0].jobId, 'An identical two-share program is associated with two distinct baseline expectations.')
  const control = await materializeNativeControl(project, rows[1].mutants[0].jobId, files()), child = control.controlProject
  assert.ok(project.spec.workflowPlan && project.spec.observationPlan && project.spec.taskReviews.length === 1)
  for (const key of ['workflowPlan', 'observationPlan', 'requirementPlan', 'nativePreparationPlan', 'taskReviews']) assert.equal(Object.hasOwn(child.spec, key), false)
  assert.equal(Object.hasOwn(child.spec.conditions[0], 'workflowId'), false); assert.equal(Object.hasOwn(child.spec.conditions[0].adapter, 'workflowResponses'), false)
  assert.equal(Object.hasOwn(child.spec.tasks[0], 'information'), false); assert.equal(Object.hasOwn(child.tasks[0], 'interpretations'), false)
  assert.deepEqual(child.spec.reviews, project.spec.reviews)
  const referenceJob = plan.jobs.find(job => job.kind === 'reference'), reference = await materializeNativeControl(project, referenceJob.id, files())
  assert.equal(reference.controlProject.schedule.length, 3); assert.equal(reference.controlProject.spec.protocol.maxTotalAttempts, 3)
  assert.match(reference.binding.predicate, /^own-task-native-observation-equals-reference-expectation$/)
  await retain('readings/project.json', project); await retain('readings/control.json', control)
})

test('coverage gaps retain unregistered, missing, indistinguishable and unconstructible mutants without false completion', async () => {
  const partial = await sync()
  assert.equal(partial.nativePreparation.coverageStatus, 'incomplete')
  assert.ok(partial.nativePreparation.gaps.some(row => row.kind === 'unregistered-composition'))
  assert.deepEqual(partial.nativePreparation.counts, { jobs: 2, referenceJobs: 1, mutantJobs: 1, nativeExecutions: 4, coverageRows: 2 })
  const noMutant = await makeFixture({ mutate: spec => { spec.requirementPlan.targets[0].wrongReadings = [] } })
  const absentRows = noMutant.nativePreparation.coverage.filter(row => row.targetId === 'strict-entry-boundary')
  assert.equal(absentRows.length, 2); assert.ok(absentRows.every(row => row.mutants.length === 0))
  assert.equal(noMutant.nativePreparation.gaps.filter(row => row.kind === 'no-mutants').length, 2)
  const inactive = await makeFixture({ mutate: async spec => {
    for (const bar of spec.tasks[0].input.bars) bar.prices.SPY = 9000
    spec.tasks[0].expected = await deriveTaskExpected(spec, spec.tasks[0])
  } })
  assert.equal(inactive.nativePreparation.coverageStatus, 'incomplete')
  assert.ok(inactive.nativePreparation.gaps.some(row => row.kind === 'indistinguishable-mutant' && row.scope === 'selected-input'))
  assert.equal(inactive.nativePreparation.coverage.length, 10)
  const invalid = await makeFixture({ mutate: async spec => {
    const task = spec.tasks[0]; task.input.execution.assets = task.input.execution.assets.filter(row => row.id === 'SPY')
    for (const bar of task.input.bars) delete bar.prices.QQQ
    task.expected = await deriveTaskExpected(spec, task)
  } })
  const selected = invalid.nativePreparation.coverage.find(row => row.targetId === 'private-strategy-asset' && row.scope === 'selected-input')
  const probe = invalid.nativePreparation.coverage.find(row => row.targetId === 'private-strategy-asset' && row.scope === 'probe')
  assert.equal(selected.mutants[0].jobId, null); assert.equal(selected.mutants[0].gap.kind, 'mutant-construction')
  assert.equal(typeof probe.mutants[0].jobId, 'string'); assert.equal(invalid.nativePreparation.coverageStatus, 'incomplete')
  await retain('gaps/construction-plan.json', invalid.nativePreparation)
})

test('strict recipe limits refuse invalid schemas and preserve complete rosters when aggregate budgets are insufficient', async () => {
  const project = await operation()
  for (const change of [
    spec => { spec.schemaVersion = 1 }, spec => { spec.domain = 'generic' }, spec => { spec.protocol.grading.kind = 'json' },
    spec => { spec.requirementPlan.selectedInput.policy = 'report' }, spec => { spec.nativePreparationPlan.referenceReplicates = 2 },
    spec => { spec.nativePreparationPlan.mutantReplicates = 0 }, spec => { spec.nativePreparationPlan.budgets.attemptTimeoutMs = 30999 },
    spec => { spec.nativePreparationPlan.budgets.maxNativeExecutions = 100001 }, spec => { spec.nativePreparationPlan.budgets.maxDurationMs = Infinity },
    spec => { spec.nativePreparationPlan.coverage = 'sample-primary' }, spec => { spec.nativePreparationPlan.approved = true },
  ]) { const spec = copy(project.spec); change(spec); assert.throws(() => validateNativePreparationPlan(spec)) }
  const spec = copy(project.spec); spec.nativePreparationPlan.budgets.maxNativeExecutions = 7; spec.nativePreparationPlan.budgets.maxDurationMs = 30000
  const plan = await compileNativePreparationPlan(spec, project.requirements)
  assert.deepEqual(plan.counts, project.nativePreparation.counts); assert.equal(plan.coverage.length, 10)
  assert.deepEqual(plan.gaps.filter(row => row.kind === 'execution-budget'), [{ kind: 'execution-budget', required: 8, available: 7 }])
  assert.deepEqual(plan.gaps.filter(row => row.kind === 'duration-budget'), [{ kind: 'duration-budget', required: 31000, available: 30000 }])
  assert.equal(plan.coverageStatus, 'incomplete')
})

test('complete exact source and binary input bytes are required even for source-only materialization', async () => {
  const project = await operation(), job = mutantJob(project)
  const changes = [
    value => { delete value.runtimeFiles['runner.mjs'] }, value => { value.runtimeFiles['extra.mjs'] = 'extra' },
    value => { value.runtimeFiles['trading_broker.py'] += '\n# changed' }, value => { value.runtimeFiles['runner.mjs'] = { text: sources['runner.mjs'] } },
    value => { delete value.inputFiles['fixtures/bytes.bin'] }, value => { value.inputFiles['fixtures/extra.txt'] = 'extra' },
    value => { value.inputFiles['fixtures/notes.txt'] += 'changed' }, value => { value.inputFiles['fixtures/bytes.bin'].data = 'AAAA' },
  ]
  for (const change of changes) { const supplied = files(); change(supplied); await assert.rejects(materializeNativeControl(project, job.id, supplied), /source|runtime|input|pinned|complete|file/i) }
  await assert.rejects(materializeNativeControl(project, 'native-' + '0'.repeat(64), files()), /control|plan/i)
  const noReview = copy(project.spec); noReview.requireReview = false; noReview.reviews = []
  await assert.rejects(freezeStudy(noReview), /review/i, 'The existing Lean gate already forbids an unreviewed native parent.')
  const unreviewed = copy(project); unreviewed.spec.reviews = []; unreviewed.sha256 = await sealedHash(unreviewed)
  await assert.rejects(materializeNativeControl(unreviewed, mutantJob(project).id, files()), /review/i)
  assert.deepEqual(unreviewed.spec.reviews, [], 'The materializer cannot synthesize missing investigator reviews.')
})

test('verification regenerates child programs, predicates, source bindings and envelopes instead of trusting resealed hashes', async () => {
  const project = await operation(), control = await materializeNativeControl(project, mutantJob(project).id, files())
  for (const mutate of [
    value => { value.parentProjectSha256 = 'f'.repeat(64) }, value => { value.nativePlanSha256 = 'f'.repeat(64) },
    value => { value.binding.predicate = 'any-false-grade' }, value => { value.binding.referenceExpected.orders[0].asset = 'QQQ' },
    value => { value.binding.job.programContractSha256 = value.binding.job.referenceContractSha256 },
    value => { value.controlProject.spec.conditions[0].adapter.responses.control = '# invented program' },
    value => { value.controlProject.spec.tasks[0].expected = value.binding.referenceExpected },
    value => { value.controlProject.spec.inputs.find(row => row.path === 'native-control/binding.json').sha256 = '0'.repeat(64) },
    value => { value.binding.nativeExecuted = true },
  ]) {
    const changed = copy(control); mutate(changed); changed.sha256 = await sealedHash(changed)
    await assert.rejects(verifyNativeControl({ parentProject: project, control: changed }, files()), /regenerat|differs|control|apparatus/i)
  }
  await assert.rejects(verifyNativeControl({ parentProject: project, control, alreadyVerified: true }, files()), /unsupported|exact|parent project/i)
})

test('parent and registry substitutions cannot be legitimized with a recomputed outer project hash', async () => {
  const project = await operation()
  for (const mutate of [
    value => { value.nativePreparation.jobs[0].inputSha256 = 'f'.repeat(64) },
    value => { value.nativePreparation.coverage.pop() },
    value => { value.requirements.targets[0].probes[0].reference.expected.orders[0].quantity = 99 },
    value => { value.nativePreparation.environment.leanImage = 'different@sha256:' + 'b'.repeat(64) },
  ]) {
    const changed = copy(project); mutate(changed); changed.sha256 = await sealedHash(changed)
    await assert.rejects(materializeNativeControl(changed, mutantJob(project).id, files()), /frozen project|changed|registry/i)
  }
  const changed = copy(project.requirements); changed.targets[0].probes[0].reference.expected.orders[0].quantity = 99
  await assert.rejects(compileNativePreparationPlan(project.spec, changed), /registry|changed|binding|hash/i)
})

test('public async compiler and materializers capture caller state before any awaited hashing', async () => {
  const project = await operation(), job = mutantJob(project), baseline = await materializeNativeControl(project, job.id, files())
  const spec = copy(project.spec), registry = copy(project.requirements), compiling = compileNativePreparationPlan(spec, registry)
  spec.nativePreparationPlan.referenceReplicates = 99; registry.targets[0].probes[0].reference.input.bars[0].prices.SPY = 999
  assert.deepEqual(await compiling, project.nativePreparation)
  const parent = copy(project), supplied = files(), making = materializeNativeControl(parent, job.id, supplied)
  parent.requirements.targets[0].selectedInput.reference.expected.orders[0].quantity = 999
  supplied.runtimeFiles['trading_broker.py'] = 'changed'; supplied.inputFiles['fixtures/bytes.bin'].data = 'AAAA'
  assert.deepEqual(await making, baseline)
  const input = { parentProject: copy(project), control: copy(baseline) }, verificationFiles = files(), verifying = verifyNativeControl(input, verificationFiles)
  input.control.binding.predicate = 'changed'; input.parentProject.spec.name = 'changed'; verificationFiles.inputFiles['fixtures/notes.txt'] = 'changed'
  assert.deepEqual(await verifying, baseline)
})

test('finite JSON capture refuses omitted, coerced and cyclic values before generating apparent control proof', async () => {
  const project = await operation(), job = mutantJob(project), baseline = await materializeNativeControl(project, job.id, files())
  for (const bad of [undefined, NaN, 1n, new Date(at)]) {
    const control = copy(baseline); control.extra = bad
    await assert.rejects(verifyNativeControl({ parentProject: project, control }, files()), /finite|plain JSON|acyclic/i)
  }
  const control = copy(baseline); control.loop = control
  await assert.rejects(verifyNativeControl({ parentProject: project, control }, files()), /finite|acyclic/i)
  const extra = files(); extra.inputFiles['fixtures/notes.txt'] = undefined
  await assert.rejects(materializeNativeControl(project, job.id, extra), /finite|plain JSON/i)
})

test('omitting the recipe preserves ordinary frozen projects and cannot silently enable legacy native preparation', async () => {
  const project = await operation(), spec = copy(project.spec); delete spec.nativePreparationPlan
  const ordinary = await freezeStudy(spec)
  assert.equal(Object.hasOwn(ordinary, 'nativePreparation'), false); assert.equal(await compileNativePreparationPlan(spec, ordinary.requirements), null)
  await verifyProject(ordinary)
  await assert.rejects(materializeNativeControl(ordinary, mutantJob(project).id, files()), /plan|control/i)
  spec.schemaVersion = 1; spec.nativePreparationPlan = recipe()
  await assert.rejects(freezeStudy(spec), /schema-2|schema|version/i)
  assert.equal(ordinary.spec.requireReview, project.spec.requireReview)
})
