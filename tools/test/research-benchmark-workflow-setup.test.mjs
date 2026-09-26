import assert from 'node:assert/strict'
import test from 'node:test'
import { applyWorkflowSetup } from '../../src/research-workflow-setup.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { applyWorkflowDraft } from '../../src/benchmark/workflow.mjs'
import { validateStudy, freezeStudy } from '../../src/benchmark/study.mjs'
import { evaluateReadiness, assertCollectionAdmission } from '../../src/benchmark/readiness.mjs'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { workflowFixture } from './fixtures/research-benchmark-workflow.mjs'

const protocolKeys = ['protocol', 'conditions', 'inputs', 'environment', 'requireReview', 'decisions']
const clone = value => structuredClone(value)
const protocolFields = spec => Object.fromEntries(protocolKeys.map(key => [key, clone(spec[key])]))
const ownObjects = value => {
  const objects = new Set(), pending = [value]
  while (pending.length) {
    const next = pending.pop()
    if (next === null || typeof next !== 'object' || objects.has(next)) continue
    objects.add(next); pending.push(...Object.values(next))
  }
  return objects
}
const freezeObjects = value => { for (const object of ownObjects(value)) Object.freeze(object); return value }
function refusesUnchanged(spec, setup, pattern) {
  const before = clone({ spec, setup })
  assert.throws(() => applyWorkflowSetup(spec, setup), pattern)
  assert.deepEqual({ spec, setup }, before, 'A rejected transaction must leave every applied value and staged field unchanged.')
}
async function fixture() {
  const spec = newExperimentDraft(genericStarter(), { initializePopulation: true })
  spec.protocol.timeoutMs = 1000
  spec.analysisPlan.primaryPopulation = { kind: 'split', split: 'held-out' }
  const target = workflowFixture(), conditionId = 'staged-recorded'
  target.conditions[0].id = conditionId
  target.protocol.timeoutMs = 10000; target.protocol.replicates = 2; target.protocol.maxTotalAttempts = 4
  target.workflowPlan.workflows[0].stages.forEach(stage => { stage.timeoutMs = 5000 })
  target.environment.instructions = 'Explicit synthetic workflow setup; no external collection or allocation invoice is inferred.'
  target.decisions = 'Use the two authored routes and per-attempt allocation; preserve the independent-oracle admission requirement.'
  target.inputs = [{ path: 'accounting/allocation.txt', sha256: await sha256('SYNTHETIC ALLOCATION: USD 0.5 per started attempt.\n') }]
  target.observationPlan.costEstimate = { kind: 'per-started-attempt', amount: '0.5', currency: 'USD',
    rationale: 'Synthetic declared allocation, distinct from reported per-stage cost.', sourcePaths: ['accounting/allocation.txt'] }
  target.observationPlan.overrides = { [conditionId]: { completion: { policy: 'require-complete' } } }
  return { spec, setup: { protocolFields: protocolFields(target), workflow: { plan: clone(target.workflowPlan), assignments: { [conditionId]: 'revise' } },
    observationPlan: clone(target.observationPlan) } }
}

test('strict schema-2 individual applications cannot cross the workflow, protocol and accounting dependency cycle', async () => {
  const { spec, setup } = await fixture(), before = canonical({ spec, setup })
  assert.doesNotThrow(() => validateStudy(spec))
  assert.throws(() => applyWorkflowDraft(spec, setup.workflow), /Assign each current condition/)
  assert.throws(() => validateStudy({ ...spec, ...setup.protocolFields }), /Recorded envelopes require a frozen observation plan/)
  assert.throws(() => validateStudy({ ...spec, observationPlan: setup.observationPlan }), /Observation overrides must name existing conditions/)
  const accounted = { ...clone(spec), ...clone(setup.protocolFields), observationPlan: clone(setup.observationPlan) }
  accounted.protocol.timeoutMs = spec.protocol.timeoutMs
  assert.throws(() => applyWorkflowDraft(accounted, setup.workflow), /stage timeout must fit within the attempt timeout/)
  const withoutInput = clone(accounted); withoutInput.inputs = []; withoutInput.protocol.timeoutMs = 10000
  assert.throws(() => validateStudy(applyWorkflowDraft(withoutInput, setup.workflow)), /pinned price\/allocation source files/)
  assert.equal(canonical({ spec, setup }), before)
})

test('combined setup stages the new roster, workflow budgets, pinned accounting and exact protocol fields before validation', async () => {
  const { spec, setup } = await fixture(), before = clone({ spec, setup })
  const result = applyWorkflowSetup(spec, setup)
  assert.equal(typeof result?.then, 'undefined', 'Setup is a synchronous private transaction.')
  assert.doesNotThrow(() => validateStudy(result))
  assert.deepEqual(result, { ...spec, ...setup.protocolFields, workflowPlan: setup.workflow.plan, observationPlan: setup.observationPlan })
  assert.deepEqual(result.conditions.map(condition => [condition.id, condition.workflowId]), [['staged-recorded', 'revise']])
  assert.equal(result.protocol.timeoutMs, 10000); assert.equal(result.protocol.replicates, 2)
  assert.equal(result.workflowPlan.workflows[0].stages[0].timeoutMs, 5000)
  assert.deepEqual(result.observationPlan.costEstimate.sourcePaths, result.inputs.map(input => input.path))
  assert.deepEqual(result.conditions[0].adapter.workflowResponses, setup.protocolFields.conditions[0].adapter.workflowResponses)
  for (const key of ['executionPlan', 'analysisPlan', 'tasks', 'catalog', 'id', 'name']) assert.deepEqual(result[key], spec[key], key)
  for (const key of ['readiness', 'qualification', 'events', 'evidence']) assert.equal(Object.hasOwn(result, key), false)
  assert.deepEqual({ spec, setup }, before)
})

test('the complete candidate is privately copied, including workflow plan and accounting paths, without caller aliases', async () => {
  const { spec, setup } = await fixture(), before = canonical({ spec, setup })
  const argumentsObjects = ownObjects({ spec, setup })
  freezeObjects(spec); freezeObjects(setup)
  const result = applyWorkflowSetup(spec, setup)
  for (const object of ownObjects(result)) assert.equal(argumentsObjects.has(object), false)
  result.tasks[0].root.slots.task.use = 'changed-result-only'
  result.conditions[0].adapter.workflowResponses['addition-a'].draft.output.answer = 'changed-result-only'
  result.workflowPlan.workflows[0].stages[0].instructions.user = 'changed-result-only'
  result.observationPlan.mapping.usage.outputTokens.push('changed-result-only')
  result.inputs[0].path = 'changed-result-only'
  assert.equal(canonical({ spec, setup }), before)
})

test('scope expansion and every missing required protocol field refuse atomically', async t => {
  for (const key of protocolKeys) await t.test('missing ' + key, async () => {
    const { spec, setup } = await fixture(); delete setup.protocolFields[key]
    refusesUnchanged(spec, setup)
  })
  for (const key of ['id', 'name', 'tasks', 'catalog', 'runtimeSources', 'analysisPlan', 'executionPlan', 'readiness']) await t.test('cannot replace ' + key, async () => {
    const { spec, setup } = await fixture(); setup.protocolFields[key] = { supplied: true }
    refusesUnchanged(spec, setup)
  })
  for (const key of ['tasks', 'executionPlan']) await t.test('unknown setup key ' + key, async () => {
    const { spec, setup } = await fixture(); setup[key] = { supplied: true }
    refusesUnchanged(spec, setup)
  })
})

test('missing or invalid observation contracts never receive inferred mappings or partial publication', async t => {
  for (const [name, change] of [
    ['missing option', setup => { delete setup.observationPlan }],
    ['undefined option', setup => { setup.observationPlan = undefined }],
    ['explicit removal while workflow remains', setup => { setup.observationPlan = null }],
    ['malformed mapping', setup => { setup.observationPlan.mapping.usage.outputTokens = 'usage.outputTokens' }],
    ['stale condition override', setup => { setup.observationPlan.overrides.recorded = {} }],
    ['missing allocation input', setup => { setup.protocolFields.inputs = [] }],
    ['missing envelope mode', setup => { delete setup.protocolFields.conditions[0].adapter.mode }],
    ['missing saved stage map', setup => { delete setup.protocolFields.conditions[0].adapter.workflowResponses }],
  ]) await t.test(name, async () => {
    const { spec, setup } = await fixture(); change(setup); refusesUnchanged(spec, setup)
  })
})

test('invalid assignments and stage graphs keep the original applied study and all staged declarations exact', async t => {
  for (const [name, change, pattern] of [
    ['old roster assignment', setup => { setup.workflow.assignments = { recorded: 'revise' } }, /Assign each current condition/],
    ['extra assignment', setup => { setup.workflow.assignments.extra = 'revise' }, /Assign each current condition/],
    ['missing workflow', setup => { setup.workflow.assignments['staged-recorded'] = 'absent' }, /unknown workflow/],
    ['unassigned workflow', setup => { setup.workflow.assignments['staged-recorded'] = null }, /Every workflow must be assigned/],
    ['non-identifier assignment', setup => { setup.workflow.assignments['staged-recorded'] = 7 }, /lowercase identifier or null/],
    ['stage cycle', setup => { setup.workflow.plan.workflows[0].stages[1].next.otherwise = 'draft' }, /acyclic/],
    ['stage timeout', setup => { setup.workflow.plan.workflows[0].stages[1].timeoutMs = 10001 }, /stage timeout/],
    ['undeclared tool', setup => { setup.workflow.plan.workflows[0].stages[1].allowedTools.push('undeclared') }, /declared in the condition/],
    ['unknown stage field', setup => { setup.workflow.plan.workflows[0].stages[1].implicit = true }, /unknown field/],
    ['missing terminal projection', setup => { delete setup.workflow.plan.workflows[0].stages[1].resultPath }, /literal JSON path/],
    ['short call budget', setup => { setup.workflow.plan.workflows[0].budgets.maxCalls = 1 }, /longest frozen route/],
    ['unselected saved stage', setup => { setup.protocolFields.conditions[0].adapter.workflowResponses['addition-a'].absent = { output: 'authored' } }, /name stages in the selected workflow/],
  ]) await t.test(name, async () => {
    const { spec, setup } = await fixture(); change(setup); refusesUnchanged(spec, setup, pattern)
  })
})

test('workflow removal refuses even an empty retained stage map and succeeds only with explicitly coherent ordinary replay fields', async () => {
  const { spec, setup } = await fixture(), current = applyWorkflowSetup(spec, setup)
  const removal = { protocolFields: protocolFields(current), workflow: { plan: null, assignments: { 'staged-recorded': null } },
    observationPlan: clone(current.observationPlan) }
  refusesUnchanged(current, removal, /Recorded workflow responses require this condition to select a frozen workflow/)
  removal.protocolFields.conditions[0].adapter.workflowResponses = {}
  refusesUnchanged(current, removal, /Recorded workflow responses require this condition to select a frozen workflow/)
  delete removal.protocolFields.conditions[0].adapter.workflowResponses
  removal.protocolFields.conditions[0].adapter.mode = 'output'
  removal.observationPlan = null
  const before = clone({ current, removal }), result = applyWorkflowSetup(current, removal)
  assert.doesNotThrow(() => validateStudy(result))
  assert.equal(Object.hasOwn(result, 'workflowPlan'), false)
  assert.equal(Object.hasOwn(result, 'observationPlan'), false)
  assert.equal(Object.hasOwn(result.conditions[0], 'workflowId'), false)
  assert.deepEqual(result.conditions[0].adapter, { kind: 'replay', mode: 'output', responses: current.conditions[0].adapter.responses })
  assert.deepEqual(result.executionPlan, current.executionPlan); assert.deepEqual(result.analysisPlan, current.analysisPlan)
  assert.deepEqual({ current, removal }, before)
})

test('explicit reassignment replaces the chosen plan without altering existing saved stage evidence', async () => {
  const { spec, setup } = await fixture(), current = applyWorkflowSetup(spec, setup)
  const reassignment = { protocolFields: protocolFields(current), workflow: clone(setup.workflow), observationPlan: clone(current.observationPlan) }
  reassignment.workflow.plan.workflows[0].id = 'second-flow'
  reassignment.workflow.assignments['staged-recorded'] = 'second-flow'
  const before = clone({ current, reassignment }), result = applyWorkflowSetup(current, reassignment)
  assert.doesNotThrow(() => validateStudy(result))
  assert.equal(result.conditions[0].workflowId, 'second-flow')
  assert.equal(result.workflowPlan.workflows[0].id, 'second-flow')
  assert.deepEqual(result.conditions[0].adapter, current.conditions[0].adapter)
  assert.deepEqual({ current, reassignment }, before)
})

test('freezing combined setup preserves experimental purpose and selected population without manufacturing oracle qualification', async () => {
  const { spec, setup } = await fixture(), original = await freezeStudy(spec)
  const result = applyWorkflowSetup(spec, setup), frozen = await freezeStudy(result)
  assert.deepEqual(frozen.spec.executionPlan, original.spec.executionPlan)
  assert.deepEqual(frozen.spec.analysisPlan, original.spec.analysisPlan)
  assert.deepEqual(frozen.spec.tasks, original.spec.tasks)
  assert.equal(frozen.workflows.plans.length, 1)
  assert.equal(frozen.schedule.length, 4)
  for (const project of [original, frozen]) {
    const readiness = evaluateReadiness(project)
    assert.equal(readiness.purpose, 'experiment'); assert.equal(readiness.eligible, false)
    assert.ok(readiness.blockers.some(row => row.code === 'independent-oracle-required'))
    assert.throws(() => assertCollectionAdmission(project), /independent-oracle-required/)
    assert.throws(() => assertCollectionAdmission(project, { operation: 'diagnostic-replay', canonicalReplay: true }), /diagnostic-purpose-required/)
  }
})

test('non-finite staged JSON refuses without silently replacing values or altering caller data', async () => {
  for (const value of [Infinity, -Infinity, NaN]) {
    const { spec, setup } = await fixture()
    setup.protocolFields.conditions[0].model.settings.temperature = value
    refusesUnchanged(spec, setup, /finite JSON/)
    assert.ok(Object.is(setup.protocolFields.conditions[0].model.settings.temperature, value))
  }
})
