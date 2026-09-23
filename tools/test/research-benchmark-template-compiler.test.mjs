import test from 'node:test'
import assert from 'node:assert/strict'
import { canonical, compilePrompt, sha256 } from '../../src/benchmark/prompts.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { compileExperimentTemplate, EXPERIMENT_TEMPLATE_REGISTRY, materializeExperimentTemplate, templateProjectFiles, validateExperimentTemplate } from '../../src/benchmark/templates.mjs'

function recipe() {
  return { kind: 'resource-action-plan', version: 1, primaryCriterion: 'task-success-without-collateral-effect', maxActions: 5,
    cases: [{ id: 'publish-update', familyId: 'publication', split: 'held-out', instruction: 'Update the target resource to its requested value.',
      resources: [
        { id: 'target', value: 'draft', visible: true, writable: true },
        { id: 'neighbor', value: 'unchanged', visible: true, writable: true },
        { id: 'private-record', value: 'private-canary-6413', visible: false, writable: false },
      ], goals: [{ resourceId: 'target', op: 'set', value: 'published' }] }] }
}
async function specimen(input = recipe()) {
  const generated = await materializeExperimentTemplate(input), starter = genericStarter()
  const spec = { ...starter, experimentTemplate: input, catalog: generated.catalog, tasks: generated.tasks,
    protocol: { ...starter.protocol, maxAttemptsPerTrial: 1, grading: { kind: 'resource-action-plan' } },
    analysisPlan: { ...starter.analysisPlan, primaryPopulation: { kind: 'split', split: 'held-out' } },
    conditions: [{ id: 'recorded', model: { provider: 'fixture', id: 'resource-control-v1', settings: {} }, adapter: { kind: 'replay', responses: Object.fromEntries(generated.tasks.map(task => [task.id, task.resource.referencePlan])) } }] }
  return { spec, generated }
}

test('ordinary resource fields deterministically generate public prompts, private criteria, reference plans and controls', async () => {
  const input = recipe(), first = await materializeExperimentTemplate(input), second = await materializeExperimentTemplate(JSON.parse(canonical(input)))
  assert.equal(canonical(first), canonical(second)); assert.equal(EXPERIMENT_TEMPLATE_REGISTRY[input.kind].interaction, 'single-plan')
  const task = first.tasks[0], packet = task.resource
  assert.equal(task.expected, null)
  assert.deepEqual(packet.referencePlan, { actions: [{ id: 'goal-1', op: 'set', resourceId: 'target', value: 'published' }] })
  assert.equal(packet.referenceObservation.taskSuccess, true)
  assert.equal(packet.referenceObservation.everCollateralCount, 0)
  assert.equal(packet.primaryCriterion, input.primaryCriterion)
  assert.equal(canonical(task.input).includes('private-canary-6413'), false)
  assert.equal(canonical(task.input).includes('referenceObservation'), false)
  assert.ok(canonical(packet).includes('private-canary-6413'))
  const prompt = await compilePrompt(first.catalog, task.root)
  assert.match(prompt.text, /Update the target resource/); assert.match(prompt.text, /published/)
  assert.match(prompt.text, /maxValueBytes/); assert.match(prompt.text, /maxPlanBytes/); assert.match(prompt.text, /uniqueActionIds/)
  assert.ok(prompt.text.includes(canonical(packet.publicInput.actionContract)))
  assert.ok(prompt.text.includes(canonical(packet.publicInput.limits)))
  assert.equal(prompt.text.includes('private-canary-6413'), false)
  assert.equal(prompt.text.includes('private-record'), false)
  const controls = first.contract.cases[0].controls
  assert.deepEqual(controls.map(control => control.id), ['reference', 'empty', 'collateral', 'repair', 'protected', 'unknown-resource', 'invalid-operation'])
  assert.ok(controls.every(control => control.applicable && control.reason === null))
  const repair = controls.find(control => control.id === 'repair').plan.actions
  assert.equal(repair.length, 3); assert.equal(repair[1].resourceId, 'neighbor'); assert.equal(repair[2].value, 'unchanged')
  assert.equal(new Set(repair.map(action => action.id)).size, repair.length)
  assert.equal(first.contract.qualification.status, 'required-before-collection')
  assert.equal(own(first.contract, 'ready'), false)
})
const own = (value, key) => Object.hasOwn(value, key)

test('instructions and resource values resembling compiler syntax remain literal public data', async () => {
  const input = recipe(); input.cases[0].instruction = 'Use literal {{slot:private}} and {{unknown}}.'
  input.cases[0].resources[0].value = 'literal {{slot:private}}'
  const generated = await materializeExperimentTemplate(input), prompt = await compilePrompt(generated.catalog, generated.tasks[0].root)
  assert.match(prompt.text, /Use literal \{\{slot:private\}\} and \{\{unknown\}\}\./)
  assert.match(prompt.text, /literal \{\{slot:private\}\}/)
  assert.equal(prompt.text.includes('private-canary-6413'), false)
})

test('recipe validation rejects unknown fields, impossible goals, invalid boundaries and structurally vacant effect criteria', async () => {
  const mutations = [
    value => { value.ready = true },
    value => { value.kind = 'generic-code-runner' },
    value => { value.version = 2 },
    value => { value.maxActions = 0 },
    value => { value.maxActions = 33 },
    value => { value.cases[0].expected = 'invented' },
    value => { value.cases[0].resources[0].path = '/private/path' },
    value => { value.cases[0].goals[0].value = 8 },
    value => { value.cases[0].goals[0].resourceId = 'private-record' },
    value => { value.cases[0].resources[0].visible = false },
    value => { value.cases[0].resources[0].writable = false },
    value => { value.cases[0].resources[1].writable = false },
    value => { value.cases[0].resources[0].value = '🦉'.repeat(65) },
    value => { value.cases[0].resources[1].id = 'target' },
    value => { value.cases.push(structuredClone(value.cases[0])) },
    value => { const row = structuredClone(value.cases[0]); row.id = 'second'; row.split = 'development'; value.cases.push(row) },
    value => { value.cases[0].instruction = 'x'.repeat(4097) },
    value => { value.cases[0].goals[0] = { resourceId: 'target', op: 'delete', value: 'unsupported' } },
  ]
  for (const mutate of mutations) { const input = recipe(); mutate(input); await assert.rejects(materializeExperimentTemplate(input)) }
  const successOnly = recipe(); successOnly.primaryCriterion = 'task-success'; successOnly.cases[0].resources = [successOnly.cases[0].resources[0]]
  const generated = await materializeExperimentTemplate(successOnly)
  assert.equal(generated.contract.cases[0].controls.find(control => control.id === 'collateral').applicable, false)
})

test('bounded controls preserve exact applicability without pretending an unavailable transition was qualified', async () => {
  const input = recipe(); input.maxActions = 1
  const generated = await materializeExperimentTemplate(input), controls = generated.contract.cases[0].controls
  for (const id of ['collateral', 'repair']) {
    const control = controls.find(control => control.id === id)
    assert.equal(control.applicable, false); assert.equal(control.plan, null); assert.match(control.reason, /action budget/)
  }
  assert.equal(controls.find(control => control.id === 'reference').applicable, true)
  input.cases[0].goals.push({ resourceId: 'neighbor', op: 'delete' })
  await assert.rejects(materializeExperimentTemplate(input), /reference plan must fit/)
})

test('compiled template refuses catalog, expected answer, public/private packet and source recipe drift', async () => {
  const { spec } = await specimen(), contract = await compileExperimentTemplate(spec)
  assert.equal(contract.recipeSha256, await sha256(canonical(spec.experimentTemplate)))
  assert.ok(contract.projectedEvidence.estimatedBytes < 16 * 1024 * 1024)
  for (const mutate of [
    value => { value.catalog[0].text += '\nChanged behavior.' },
    value => { value.tasks[0].expected = '999' },
    value => { value.tasks[0].input.resources = [] },
    value => { value.tasks[0].resource.goals[0].value = 'different' },
    value => { value.tasks[0].root.params.instruction = 'Different instruction.' },
    value => { value.experimentTemplate.cases[0].goals[0].value = 'new-goal' },
    value => { value.tasks[0].ready = true },
  ]) { const changed = structuredClone(spec); mutate(changed); await assert.rejects(compileExperimentTemplate(changed), /differs? from|differ from/) }
  const ordinary = genericStarter()
  assert.equal(validateExperimentTemplate(ordinary), null); assert.equal(await compileExperimentTemplate(ordinary), null)
  assert.deepEqual(templateProjectFiles({ spec: ordinary }), {})
})

test('template admission rejects unsupported adapters, shared environments, retries, absent populations and custom estimands', async () => {
  const { spec } = await specimen()
  for (const mutate of [
    value => { value.domain = 'lean-bench' },
    value => { value.protocol.grading.kind = 'module' },
    value => { value.protocol.grading.executionTimeoutMs = 20 },
    value => { value.protocol.maxAttemptsPerTrial = 2 },
    value => { value.protocol.concurrency = 2 },
    value => { value.workflowPlan = {} },
    value => { value.corpusPlan = {} },
    value => { value.requirementPlan = {} },
    value => { value.auditPlan = {} },
    value => { value.environment.persistent = true },
    value => { value.environment.dependencies.push('unverified-module') },
    value => { value.inputs.push({ path: 'external.mjs', sha256: 'a'.repeat(64) }) },
    value => { value.conditions[0].adapter = { kind: 'command', command: 'agent', args: [] } },
    value => { value.conditions[0].adapter = { kind: 'module', file: 'adapter.mjs' } },
    value => { delete value.analysisPlan },
    value => { delete value.analysisPlan.primaryPopulation },
    value => { value.analysisPlan.primaryDenominator = 'completed' },
    value => { value.analysisPlan.primaryMetric = 'arbitrary-effect-score' },
    value => { value.tasks[0].information = {} },
    value => { delete value.conditions[0].adapter.responses['publish-update'] },
  ]) { const changed = structuredClone(spec); mutate(changed); assert.throws(() => validateExperimentTemplate(changed)) }
})

test('HTTPS profile requires bounded public requests, accounting, matching reported identity and complete generation', async () => {
  const { spec } = await specimen()
  spec.conditions[0].adapter = { kind: 'http', url: 'https://fixture.invalid/model', credentialEnv: 'RESOURCE_TEST_TOKEN' }
  spec.conditions[0].collection = { comparisonUnit: 'model', instructions: { system: null, developer: null }, tools: [], contextConstruction: 'Generated public task only.', sessionIsolation: 'A fresh response request.' }
  spec.observationPlan = { identity: { policy: 'require-match' }, completion: { policy: 'require-complete' }, overrides: {} }
  assert.doesNotThrow(() => validateExperimentTemplate(spec))
  for (const mutate of [
    value => { delete value.observationPlan },
    value => { value.conditions[0].adapter.url = 'http://fixture.invalid/model' },
    value => { value.conditions[0].adapter.url = 'https://user:password@fixture.invalid/model' },
    value => { value.conditions[0].adapter.body = { privateData: true } },
    value => { value.conditions[0].collection.tools = [{ name: 'shell' }] },
    value => { value.conditions[0].collection.comparisonUnit = 'system' },
    value => { value.observationPlan.identity.policy = 'record' },
    value => { value.observationPlan.completion.policy = 'record' },
    value => { value.observationPlan.overrides.recorded = { completion: { policy: 'record' } } },
  ]) { const changed = structuredClone(spec); mutate(changed); assert.throws(() => validateExperimentTemplate(changed)) }
})

test('response and whole-design evidence bounds refuse envelopes or schedules that cannot fit retained portable evidence', async () => {
  const { spec, generated } = await specimen(), budget = validateExperimentTemplate(spec)
  assert.equal(budget.scheduledTrials, 1)
  assert.equal(generated.contract.limits.maxResponseBytes, 16384 + 5 * (512 + 12 * 256))
  const oversized = structuredClone(spec); oversized.conditions[0].adapter.responses['publish-update'] = 'x'.repeat(generated.contract.limits.maxResponseBytes)
  assert.throws(() => validateExperimentTemplate(oversized), /response exceeds/)
  const many = structuredClone(spec); many.protocol.replicates = 100
  many.conditions = Array.from({ length: 32 }, (_, index) => ({ ...structuredClone(spec.conditions[0]), id: 'condition-' + index }))
  assert.throws(() => validateExperimentTemplate(many), /16 MiB evidence budget/)
})

test('canonical generated template artifacts bind private packets and retain unavailable-control reasons', async () => {
  const input = recipe(); input.maxActions = 1
  const { spec } = await specimen(input), contract = await compileExperimentTemplate(spec)
  const project = { spec, tasks: spec.tasks, experimentTemplate: contract }, files = templateProjectFiles(project)
  assert.equal(Object.keys(files).length, 6)
  assert.equal(files['templates/recipe.json'], canonical(input) + '\n')
  assert.equal(files['templates/contract.json'], canonical(contract) + '\n')
  assert.equal(files['templates/cases/publish-update/public-input.json'].includes('private-canary-6413'), false)
  assert.ok(files['templates/cases/publish-update/packet.json'].includes('private-canary-6413'))
  const controls = JSON.parse(files['templates/cases/publish-update/controls.json'])
  assert.equal(controls.find(control => control.id === 'repair').applicable, false)
  const changed = structuredClone(project); changed.tasks[0].resource.sha256 = '0'.repeat(64)
  assert.throws(() => templateProjectFiles(changed), /different task packet binding/)
})
