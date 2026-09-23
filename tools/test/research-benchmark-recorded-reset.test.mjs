import assert from 'node:assert/strict'
import test from 'node:test'
import { resetRecordedResponses } from '../../src/research-recorded-responses.mjs'
import { createCompositionFamilySourceDraft } from '../../src/research-composition-source-draft.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { validateStudy, freezeStudy, gradeResponse } from '../../src/benchmark/study.mjs'
import { replayAdapter } from '../../src/benchmark/runner.mjs'
import { observationPlanFromSpec, observeResponse } from '../../src/benchmark/observations.mjs'
import { newWorkflowState, workflowRequest } from '../../src/benchmark/workflow.mjs'
import { assertCollectionAdmission } from '../../src/benchmark/readiness.mjs'
import { workflowFixture } from './fixtures/research-benchmark-workflow.mjs'

const clone = value => structuredClone(value)
const ownObjects = value => {
  const seen = new Set(), pending = [value]
  while (pending.length) {
    const next = pending.pop()
    if (next === null || typeof next !== 'object' || seen.has(next)) continue
    seen.add(next); pending.push(...Object.values(next))
  }
  return seen
}
// Exact former GUI reset shape, retained only as a deterministic regression
// counterexample. It discarded the investigator's response interpretation.
const formerWholesaleReset = conditions => clone(conditions.map(condition => condition.adapter?.kind === 'replay'
  ? { ...condition, adapter: { kind: 'replay', responses: {} } } : condition))
const signal = () => new AbortController().signal
const ordinary = () => newExperimentDraft(genericStarter(), { initializePopulation: true })

test('ordinary replay keeps absent or explicit output mode and never invents a workflow map', async () => {
  for (const mode of [undefined, 'output']) {
    const spec = ordinary()
    if (mode !== undefined) spec.conditions[0].adapter.mode = mode
    const before = clone(spec), result = resetRecordedResponses(spec.conditions)
    assert.deepEqual(result[0].adapter, { kind: 'replay', ...(mode === undefined ? {} : { mode }), responses: {} })
    assert.equal(Object.hasOwn(result[0].adapter, 'mode'), mode !== undefined)
    assert.equal(Object.hasOwn(result[0].adapter, 'workflowResponses'), false)
    assert.deepEqual(spec, before)
    const next = { ...spec, conditions: result }
    assert.doesNotThrow(() => validateStudy(next))
    const frozen = await freezeStudy(next)
    assert.deepEqual(frozen.spec.executionPlan, spec.executionPlan)
    assert.throws(() => assertCollectionAdmission(frozen), /independent-oracle-required/)
    await assert.rejects(replayAdapter({ condition: result[0], task: frozen.tasks[0], signal: signal() }), /No recorded response for addition-a/)
  }
})

test('explicitly refilled envelopes retain actual output extraction and accounting while the former wholesale reset misinterprets them', async () => {
  const spec = ordinary(); spec.tasks = [spec.tasks[0]]
  spec.conditions[0].adapter.mode = 'envelope'
  spec.conditions[0].adapter.responses = { 'addition-a': { output: 'STALE WRONG OUTPUT', usage: { outputTokens: 999 } } }
  spec.observationPlan = observationPlanFromSpec()
  spec.observationPlan.identity.policy = 'require-match'; spec.observationPlan.completion.policy = 'require-complete'
  const before = clone(spec), next = { ...clone(spec), conditions: resetRecordedResponses(spec.conditions) }
  const old = { ...clone(spec), conditions: formerWholesaleReset(spec.conditions) }
  assert.deepEqual(next.conditions[0].adapter.responses, {})
  const newResponse = { output: '5', identity: { provider: 'fixture', id: 'arithmetic-v1' }, completion: { status: 'complete', reason: 'Explicit new fixture.' },
    usage: { inputTokens: 0, outputTokens: 7, generationMs: 0, cost: { amount: '0', currency: 'USD' } } }
  next.conditions[0].adapter.responses['addition-a'] = clone(newResponse)
  old.conditions[0].adapter.responses['addition-a'] = clone(newResponse)
  const project = await freezeStudy(next), formerProject = await freezeStudy(old)
  const extracted = await replayAdapter({ condition: next.conditions[0], task: project.tasks[0], signal: signal() })
  const misinterpreted = await replayAdapter({ condition: old.conditions[0], task: formerProject.tasks[0], signal: signal() })
  assert.deepEqual(extracted, newResponse)
  assert.deepEqual(misinterpreted, { output: newResponse, usage: null })
  assert.deepEqual(gradeResponse(project, project.tasks[0], extracted.output), { passed: true, score: 1 })
  assert.deepEqual(gradeResponse(formerProject, formerProject.tasks[0], misinterpreted.output), { passed: false, score: 0 })
  const observation = observeResponse(next, next.conditions[0], extracted), lost = observeResponse(old, old.conditions[0], misinterpreted)
  assert.equal(observation.metadataOrigin, 'recorded-response'); assert.equal(observation.identityStatus, 'match'); assert.equal(observation.eligible, true)
  assert.equal(observation.usage.inputTokens.status, 'observed'); assert.equal(observation.usage.inputTokens.value, 0)
  assert.equal(observation.usage.outputTokens.value, 7); assert.equal(observation.usage.generationMs.value, 0)
  assert.equal(observation.reportedCost.status, 'observed'); assert.equal(observation.reportedCost.amount, '0')
  assert.equal(lost.usage.outputTokens.status, 'unavailable'); assert.equal(lost.usage.outputTokens.value, null)
  assert.equal(lost.identityStatus, 'unavailable'); assert.equal(lost.eligible, false)
  assert.equal(lost.reportedCost.status, 'unavailable')
  assert.deepEqual(next.observationPlan, spec.observationPlan); assert.deepEqual(next.analysisPlan, spec.analysisPlan)
  assert.throws(() => assertCollectionAdmission(project), /independent-oracle-required/)
  assert.deepEqual(spec, before)
})

test('assigned workflow stays structurally valid after reset but its actual frozen first-stage request cannot reuse stale or ordinary answers', async () => {
  const spec = newExperimentDraft(workflowFixture(), { initializePopulation: true }), before = clone(spec)
  const next = { ...clone(spec), conditions: resetRecordedResponses(spec.conditions) }
  assert.deepEqual(next.conditions[0].adapter, { ...spec.conditions[0].adapter, responses: {}, workflowResponses: {} })
  assert.equal(next.conditions[0].workflowId, 'revise')
  assert.deepEqual(next.workflowPlan, spec.workflowPlan); assert.deepEqual(next.observationPlan, spec.observationPlan)
  assert.doesNotThrow(() => validateStudy(next))
  const project = await freezeStudy(next), trial = project.schedule[0]
  const state = newWorkflowState(project, trial, 1), request = workflowRequest(state)
  assert.equal(request.workflow.id, 'revise'); assert.equal(request.workflow.stageId, 'draft')
  const condition = clone(project.spec.conditions[0]), task = project.tasks.find(row => row.id === trial.taskId)
  condition.adapter.responses[task.id] = { output: '5' }
  await assert.rejects(replayAdapter({ condition, task, signal: signal(), request }), new RegExp('No recorded workflow response for ' + task.id + '/draft'))
  assert.deepEqual(state.stages, []); assert.equal(state.next, 'draft')
  assert.throws(() => validateStudy({ ...clone(spec), conditions: formerWholesaleReset(spec.conditions) }), /Workflow replay needs envelope mode and explicit task\/stage response fixtures/)
  assert.deepEqual(spec, before)
})

test('reset privately copies every retained condition and configuration without changing nonreplay declarations', () => {
  const conditions = [
    { id: 'saved', workflowId: 'declared-flow', label: 'é界\r\n', model: { provider: 'fixture', id: 'model', settings: { temperature: 0, enabled: false } },
      adapter: { kind: 'replay', mode: 'envelope', credentialEnv: 'FIXTURE_KEY_NAME_ONLY', env: ['FIXTURE_OPTION'], responses: { old: 'discard' }, workflowResponses: { old: { stage: { output: 'discard' } } },
        configuration: { explicitEmpty: '', enabled: false } }, collection: { tools: [{ name: 'declared', parameters: { type: 'object' } }] } },
    { id: 'http', adapter: { kind: 'http', url: 'https://example.invalid/never-called', credentialEnv: 'FIXTURE_KEY_NAME_ONLY' } },
    { id: 'module', adapter: { kind: 'module', file: 'adapters/fixture.mjs', env: ['FIXTURE_ENV'] }, model: { settings: { nested: [0, false, ''] } } },
    { id: 'command', adapter: { kind: 'command', command: 'not-executed', args: ['literal\nargument', '$NO_EXPANSION'], env: [] } },
  ]
  const before = clone(conditions), inputObjects = ownObjects(conditions)
  for (const object of inputObjects) Object.freeze(object)
  const result = resetRecordedResponses(conditions)
  assert.deepEqual(result[0], { ...before[0], adapter: { ...before[0].adapter, responses: {}, workflowResponses: {} } })
  assert.deepEqual(result.slice(1), before.slice(1))
  for (const object of ownObjects(result)) assert.equal(inputObjects.has(object), false)
  result[0].collection.tools[0].parameters.type = 'changed-result-only'; result[0].adapter.env.push('RESULT_ONLY')
  result[2].model.settings.nested.push('changed-result-only'); result[3].adapter.args[0] = 'changed-result-only'
  assert.deepEqual(conditions, before)
})

test('unfinished authoring values and exact field absence survive without invented interpretation defaults', () => {
  const conditions = [
    { id: 'missing-adapter' }, { id: 'null-adapter', adapter: null },
    { id: 'unknown', adapter: { kind: 'unfinished', mode: '', configuration: { n: NaN } } },
    ...[undefined, null, '', 'not-yet-valid'].map((mode, index) => ({ id: 'pending-' + index,
      workflowId: '', model: { settings: { number: Infinity, zero: -0, choice: undefined } },
      adapter: { kind: 'replay', mode, workflowResponses: undefined, responses: { old: 'discard' } } })),
    { id: 'declared-null-map', adapter: { kind: 'replay', workflowResponses: null } },
  ]
  const before = clone(conditions), result = resetRecordedResponses(conditions)
  assert.deepEqual(result.slice(0, 3), before.slice(0, 3))
  for (let index = 3; index < 7; index++) {
    assert.deepEqual(result[index], { ...before[index], adapter: { ...before[index].adapter, responses: {} } })
    assert.equal(Object.hasOwn(result[index].adapter, 'mode'), true)
    assert.equal(Object.hasOwn(result[index].adapter, 'workflowResponses'), true)
    assert.equal(result[index].adapter.workflowResponses, undefined)
    assert.ok(Object.is(result[index].model.settings.zero, -0))
  }
  assert.deepEqual(result[7].adapter, { kind: 'replay', workflowResponses: {}, responses: {} })
  assert.equal(Object.hasOwn(result[7].adapter, 'mode'), false)
  assert.deepEqual(conditions, before)
  assert.deepEqual(resetRecordedResponses([]), [])
  for (const value of [undefined, null, {}, 'unfinished']) assert.throws(() => resetRecordedResponses(value), /condition list/)
})

test('source derivatives using the shared reset preserve schema-2 envelope and ordinary validity without inferring workflow maps', async () => {
  for (const envelope of [false, true]) {
    const spec = ordinary(), sourceTask = spec.tasks[0]
    if (envelope) { spec.conditions[0].adapter.mode = 'envelope'; spec.observationPlan = observationPlanFromSpec() }
    const familyFields = '\n ' + JSON.stringify({ version: 1, families: [{ sourceTask, fields: { taskId: sourceTask.id, familyId: 'source-family' } }] }) + '\n'
    const before = clone(spec), derivative = createCompositionFamilySourceDraft({ spec, familyFields })
    assert.deepEqual(derivative.spec.conditions, resetRecordedResponses(spec.conditions))
    assert.equal(Object.hasOwn(derivative.spec.conditions[0].adapter, 'workflowResponses'), false)
    assert.equal(derivative.editors['data-bench-composition-family-fields'], familyFields)
    assert.deepEqual(derivative.pending, ['compositionFamilies'])
    assert.doesNotThrow(() => validateStudy(derivative.spec))
    const frozen = await freezeStudy(derivative.spec)
    assert.deepEqual(frozen.spec.executionPlan, spec.executionPlan); assert.deepEqual(frozen.spec.analysisPlan, spec.analysisPlan)
    assert.throws(() => assertCollectionAdmission(frozen), /independent-oracle-required/)
    assert.deepEqual(spec, before)
  }
})

test('source-export finite-number guards still run before discarding non-finite saved response payloads', () => {
  const spec = ordinary(), sourceTask = spec.tasks[0]
  const workspace = { version: 1, families: [{ sourceTask, fields: { taskId: sourceTask.id, familyId: 'source-family' } }] }
  const familyFields = JSON.stringify(workspace)
  for (const value of [Infinity, -Infinity, NaN]) {
    const current = clone(spec); current.conditions[0].adapter.responses['addition-a'] = value
    assert.deepEqual(resetRecordedResponses(current.conditions)[0].adapter.responses, {})
    assert.throws(() => createCompositionFamilySourceDraft({ spec: current, familyFields }), /finite JSON numbers.*no value was replaced with null/)
    assert.ok(Object.is(current.conditions[0].adapter.responses['addition-a'], value))
  }
  const overflow = JSON.stringify(workspace).replace('"input":null', '"input":1e999')
  assert.notEqual(overflow, familyFields)
  assert.throws(() => createCompositionFamilySourceDraft({ spec, familyFields: overflow }), /finite JSON numbers/)
  assert.deepEqual(spec.conditions[0].adapter.responses, { 'addition-a': '5', 'addition-b': '11' })
})
