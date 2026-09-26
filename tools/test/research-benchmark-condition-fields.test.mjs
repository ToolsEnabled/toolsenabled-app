import assert from 'node:assert/strict'
import test from 'node:test'
import { createConditionFieldsDraft, conditionFieldsBinding, compileConditionFields, addConditionFieldsRow, duplicateConditionFieldsRow,
  removeConditionFieldsRow, conditionFieldsReferences, setConditionFieldsProfile, editConditionFieldsModel, requireConditionFieldsChecks } from '../../src/research-condition-fields.mjs'
import { applyWorkflowSetup } from '../../src/research-workflow-setup.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { freezeStudy } from '../../src/benchmark/study.mjs'
import { evaluateReadiness, assertCollectionAdmission } from '../../src/benchmark/readiness.mjs'
import { observationPlanFromSpec, observationContract, observeResponse } from '../../src/benchmark/observations.mjs'
import { collectionRequest, newWorkflowState, workflowRequest } from '../../src/benchmark/workflow.mjs'
import { replayAdapter } from '../../src/benchmark/runner.mjs'
import { workflowFixture } from './fixtures/research-benchmark-workflow.mjs'

const clone = value => structuredClone(value)
const ordinary = () => newExperimentDraft(genericStarter(), { initializePopulation: true })
function contextFor(spec = ordinary()) {
  const protocolFields = Object.fromEntries(['protocol', 'conditions', 'inputs', 'environment', 'requireReview', 'decisions'].map(key => [key, clone(spec[key])]))
  const workflow = { plan: spec.workflowPlan || null, assignments: Object.fromEntries(spec.conditions.map(row => [row.id, row.workflowId ?? null])) }
  const observationPlan = spec.observationPlan || null
  return { spec: clone(spec), protocolFields, workflow: clone(workflow), observationPlan: clone(observationPlan),
    sourceText: { conditions: JSON.stringify(protocolFields.conditions, null, 2), workflow: JSON.stringify(workflow, null, 2), observations: JSON.stringify(observationPlan, null, 2) } }
}
function refused(context, draft, pattern) {
  const before = clone({ context, draft })
  assert.throws(() => compileConditionFields(context, draft), pattern)
  assert.deepEqual({ context, draft }, before)
}
function fillHttp(row, modelId) {
  row.adapter.url = 'https://example.invalid/frozen-request'
  row.model.identity.provider.text = 'fixture-provider'; row.model.identity.id.text = modelId
  row.model.settingsPresent = true
  row.model.settings = [{ key: 'temperature', type: 'number', text: '0' }, { key: 'enabled', type: 'boolean', text: 'false' }]
  row.collection.system = { kind: 'text', text: 'Exact system text.\n' }; row.collection.developer = { kind: 'null', text: '' }
}

test('two ordinary HTTP profiles lower to hand-authored existing-schema conditions and return exact public packets without granting admission', async () => {
  const context = contextFor(), initial = createConditionFieldsDraft(context)
  let draft = addConditionFieldsRow(context, initial, { id: 'model-a', profile: 'http' })
  fillHttp(draft.rows[1], 'requested-a')
  draft = requireConditionFieldsChecks(context, draft, draft.rows[1].key)
  draft = duplicateConditionFieldsRow(context, draft, draft.rows[1].key, 'model-b')
  draft.rows[2].model.identity.id.text = 'requested-b'
  draft = removeConditionFieldsRow(context, draft, draft.rows[0].key)
  const before = clone({ context, draft }), setup = compileConditionFields(context, draft)
  const expectedConditions = ['a', 'b'].map(suffix => ({ id: 'model-' + suffix, model: { provider: 'fixture-provider', id: 'requested-' + suffix,
    settings: { temperature: 0, enabled: false } }, adapter: { kind: 'http', url: 'https://example.invalid/frozen-request' },
    collection: { comparisonUnit: 'model', instructions: { system: 'Exact system text.\n', developer: null }, tools: [], contextConstruction: 'frozen-public-request', sessionIsolation: 'fresh-request' } }))
  assert.deepEqual(setup.protocolFields.conditions, expectedConditions)
  assert.deepEqual(setup.workflow, { plan: null, assignments: { 'model-a': null, 'model-b': null } })
  const expectedPlan = observationPlanFromSpec()
  expectedPlan.overrides = Object.fromEntries(['model-a', 'model-b'].map(id => [id, { identity: { policy: 'require-match', fields: ['provider', 'id'] },
    completion: { policy: 'require-complete' }, mapping: { identity: { provider: ['identity', 'provider'], id: ['identity', 'id'] }, completion: { status: ['completion', 'status'] } } }]))
  assert.deepEqual(setup.observationPlan, expectedPlan)
  for (const key of ['protocol', 'inputs', 'environment', 'requireReview', 'decisions']) assert.deepEqual(setup.protocolFields[key], context.protocolFields[key])
  const applied = applyWorkflowSetup(context.spec, setup), project = await freezeStudy(applied), trial = project.schedule[0]
  const task = project.tasks.find(row => row.id === trial.taskId), condition = project.spec.conditions.find(row => row.id === trial.conditionId)
  const packet = collectionRequest(project, condition, task, trial, 1)
  assert.deepEqual(packet.model, expectedConditions.find(row => row.id === trial.conditionId).model)
  assert.deepEqual(packet.collection, expectedConditions.find(row => row.id === trial.conditionId).collection)
  assert.equal(packet.prompt, task.compiled.text); assert.equal(packet.input, task.input)
  for (const key of ['expected', 'catalog', 'requirementPlan', 'credentialEnv', 'qualification']) assert.equal(Object.hasOwn(packet, key), false)
  const readiness = evaluateReadiness(project)
  assert.ok(readiness.blockers.some(row => row.code === 'independent-oracle-required'))
  for (const code of ['collection-controls-required', 'requested-context-unsupported', 'reported-identity-required', 'reported-completion-required']) assert.ok(!readiness.blockers.some(row => row.code === code), code)
  assert.throws(() => assertCollectionAdmission(project), /independent-oracle-required/)
  assert.deepEqual({ context, draft }, before)
  assert.deepEqual(initial, createConditionFieldsDraft(context))
})

test('typed settings retain zero, false, null, string, arrays, objects and safe own keys without input aliases', () => {
  const context = contextFor(), draft = createConditionFieldsDraft(context), row = draft.rows[0]
  row.model.settingsPresent = true
  row.model.settings = [
    { key: 'zero', type: 'number', text: '0' }, { key: 'off', type: 'boolean', text: 'false' }, { key: 'empty', type: 'null', text: 'null' },
    { key: 'string', type: 'string', text: '0' }, { key: 'array', type: 'array', text: ' [0, false, null, "é"] ' },
    { key: 'object', type: 'object', text: '{ "nested": [false, 0] }' }, { key: '__proto__', type: 'string', text: 'literal-own-value' },
  ]
  const before = clone({ context, draft }), setup = compileConditionFields(context, draft), settings = setup.protocolFields.conditions[0].model.settings
  assert.deepEqual(settings, JSON.parse('{"zero":0,"off":false,"empty":null,"string":"0","array":[0,false,null,"é"],"object":{"nested":[false,0]},"__proto__":"literal-own-value"}'))
  assert.equal(Object.getPrototypeOf(settings), Object.prototype)
  settings.object.nested[0] = true; setup.protocolFields.conditions[0].adapter.responses['addition-a'] = 'changed only returned copy'
  assert.deepEqual({ context, draft }, before)
})

test('unfinished numeric text, duplicate setting keys and mismatched JSON types refuse without erasing raw fields', () => {
  const context = contextFor()
  for (const text of ['', ' ', '1e', '0x10', '+1', '01', 'Infinity', '1e999', 'NaN']) {
    const draft = createConditionFieldsDraft(context); draft.rows[0].model.settingsPresent = true
    draft.rows[0].model.settings = [{ key: 'sample', type: 'number', text }]
    refused(context, draft, /complete finite JSON number/)
  }
  for (const [type, text] of [['boolean', ''], ['array', '{}'], ['object', '[]'], ['object', '{"n":1e999}'], ['array', '[unfinished']]) {
    const draft = createConditionFieldsDraft(context); draft.rows[0].model.settingsPresent = true
    draft.rows[0].model.settings = [{ key: 'sample', type, text }]; refused(context, draft)
  }
  const duplicate = createConditionFieldsDraft(context); duplicate.rows[0].model.settingsPresent = true
  duplicate.rows[0].model.settings = [{ key: 'same', type: 'string', text: 'first' }, { key: 'same', type: 'string', text: 'second' }]
  refused(context, duplicate, /keys must be distinct/)
})

test('source-bound drafts reject raw expert edits, changed plans/purpose and attempts to replace existing IDs', () => {
  const context = contextFor(), draft = createConditionFieldsDraft(context)
  assert.equal(draft.binding, conditionFieldsBinding(context))
  for (const alter of [value => { value.sourceText.conditions += '\n' }, value => { value.sourceText.workflow = '{unfinished' },
    value => { value.sourceText.observations += ' ' }, value => { value.protocolFields.conditions[0].label = 'changed' },
    value => { value.spec.executionPlan.purpose = 'recorded-diagnostic' }, value => { value.spec.analysisPlan.primaryPopulation = { kind: 'split', split: 'held-out' } }]) {
    const changed = clone(context); alter(changed); refused(changed, draft, /stale/)
  }
  const renamed = clone(draft); renamed.rows[0].id = 'new-id'; refused(context, renamed, /read-only/)
  const unknown = clone(draft); unknown.executionPlan = { purpose: 'recorded-diagnostic' }; refused(context, unknown, /unsupported fields/)
  const extraContext = clone(context); extraContext.tasks = []; assert.throws(() => createConditionFieldsDraft(extraContext), /unsupported fields/)
})

test('unmodified ordinary and advanced command/module/legacy configurations retain exact values and optional presence', () => {
  for (const spec of [ordinary(), genericStarter()]) {
    spec.conditions[0].model.settings = { 'temperature': 0, enabled: false, nested: [null, '0'] }
    spec.conditions.push({ id: 'command', label: null, model: { provider: 'declared', id: 'local', settings: null }, adapter: { kind: 'command', command: 'not-run', args: ['$LITERAL'], env: [] } })
    spec.conditions.push({ id: 'module', adapter: { kind: 'module', file: 'adapters/fixture.mjs' } })
    spec.inputs.push({ path: 'adapters/fixture.mjs', sha256: 'a'.repeat(64) })
    if (spec.schemaVersion === 1) spec.conditions[1].retainedLegacy = { exact: 'é\n' }
    const context = contextFor(spec), draft = createConditionFieldsDraft(context), before = clone({ context, draft })
    assert.equal(draft.rows[1].profile, 'advanced'); assert.equal(draft.rows[2].profile, 'advanced')
    assert.deepEqual(compileConditionFields(context, draft).protocolFields.conditions, spec.conditions)
    assert.deepEqual({ context, draft }, before)
    assert.throws(() => setConditionFieldsProfile(context, draft, draft.rows[1].key, 'http'), /expert JSON/)
  }
})

test('unsupported model settings are retained until explicitly replaced with typed fields', () => {
  for (const model of [undefined, null, { provider: 'fixture', id: 'arithmetic-v1', settings: 0 }]) {
    const spec = ordinary(); if (model === undefined) delete spec.conditions[0].model; else spec.conditions[0].model = model
    const context = contextFor(spec), draft = createConditionFieldsDraft(context)
    assert.equal(draft.rows[0].model.mode, 'retain')
    if (model === null) refused(context, draft, /Requested model must be an object/)
    else assert.deepEqual(compileConditionFields(context, draft).protocolFields.conditions, spec.conditions)
    const edited = editConditionFieldsModel(context, draft, draft.rows[0].key)
    edited.rows[0].model.identity.provider = { present: true, text: 'explicit' }
    assert.deepEqual(compileConditionFields(context, edited).protocolFields.conditions[0].model, { provider: 'explicit' })
  }
})

test('configuration duplication resets only new maps and preserves source assignments and accounting overrides', () => {
  const spec = ordinary(); spec.observationPlan = observationPlanFromSpec()
  spec.conditions[0].adapter.mode = 'envelope'
  spec.observationPlan.overrides.recorded = { completion: { policy: 'require-complete' }, mapping: { usage: { outputTokens: ['reported', 'tokens'] } } }
  const context = contextFor(spec), draft = createConditionFieldsDraft(context)
  const next = duplicateConditionFieldsRow(context, draft, draft.rows[0].key, 'copy')
  const setup = compileConditionFields(context, next)
  assert.deepEqual(setup.protocolFields.conditions[0], spec.conditions[0])
  assert.deepEqual(setup.protocolFields.conditions[1], { ...spec.conditions[0], id: 'copy', adapter: { ...spec.conditions[0].adapter, responses: {} } })
  assert.deepEqual(setup.observationPlan.overrides, { recorded: spec.observationPlan.overrides.recorded, copy: spec.observationPlan.overrides.recorded })
  assert.equal(Object.hasOwn(setup.protocolFields.conditions[1].adapter, 'workflowResponses'), false)
  assert.throws(() => duplicateConditionFieldsRow(context, draft, draft.rows[0].key, 'recorded'), /new condition ID/)
})

test('removal names contrast and final workflow references; unreferenced removal deletes only its own override', () => {
  const spec = ordinary(); spec.conditions.push({ ...clone(spec.conditions[0]), id: 'other' })
  spec.observationPlan = observationPlanFromSpec(); spec.observationPlan.overrides = { recorded: { identity: { policy: 'record', fields: ['id'] } }, other: { completion: { policy: 'record' } } }
  let context = contextFor(spec), draft = createConditionFieldsDraft(context)
  const removed = removeConditionFieldsRow(context, draft, draft.rows[0].key), setup = compileConditionFields(context, removed)
  assert.deepEqual(setup.observationPlan.overrides, { other: spec.observationPlan.overrides.other })
  assert.deepEqual(setup.protocolFields.conditions, [spec.conditions[1]])
  spec.analysisPlan.contrasts = [{ id: 'compare', first: 'recorded', second: 'other' }]
  context = contextFor(spec); draft = createConditionFieldsDraft(context)
  assert.doesNotThrow(() => compileConditionFields(context, draft))
  assert.deepEqual(conditionFieldsReferences(context, draft, draft.rows[0].key), ['analysisPlan.contrasts.compare'])
  assert.throws(() => removeConditionFieldsRow(context, draft, draft.rows[0].key), /analysisPlan.contrasts.compare/)
  const bypass = clone(draft); bypass.rows.shift(); refused(context, bypass, /analysisPlan.contrasts.compare/)
  const workflowSpec = newExperimentDraft(workflowFixture(), { initializePopulation: true })
  context = contextFor(workflowSpec); draft = createConditionFieldsDraft(context)
  assert.match(conditionFieldsReferences(context, draft, draft.rows[0].key)[0], /workflowPlan.workflows.revise/)
  assert.throws(() => removeConditionFieldsRow(context, draft, draft.rows[0].key), /last assignment/)
})

test('returned report edits scope to one condition while inheritance removes only selected paths and policies', () => {
  const spec = ordinary(); spec.conditions.push({ ...clone(spec.conditions[0]), id: 'sibling' })
  spec.observationPlan = observationPlanFromSpec()
  spec.observationPlan.overrides = { recorded: { mapping: { identity: { provider: ['custom', 'provider'], version: ['custom', 'version'] }, usage: { outputTokens: ['custom', 'tokens'] } } }, sibling: { completion: { policy: 'record' } } }
  const context = contextFor(spec), original = createConditionFieldsDraft(context)
  let draft = requireConditionFieldsChecks(context, original, original.rows[0].key)
  draft.rows[0].checks.paths.id.segments = [{ kind: 'key', text: 'choices' }, { kind: 'index', text: '0' }, { kind: 'key', text: 'model.id' }]
  const setup = compileConditionFields(context, draft), applied = applyWorkflowSetup(spec, setup)
  assert.deepEqual({ ...setup.observationPlan, overrides: {} }, { ...spec.observationPlan, overrides: {} })
  assert.deepEqual(setup.observationPlan.overrides.sibling, spec.observationPlan.overrides.sibling)
  assert.deepEqual(observationContract(applied, applied.conditions[1]), observationContract(spec, spec.conditions[1]))
  const response = { output: '5', custom: { provider: 'fixture' }, choices: [{ 'model.id': 'arithmetic-v1' }], completion: { status: 'complete' } }
  assert.equal(observeResponse(applied, applied.conditions[0], response).eligible, true)
  const wrong = clone(response); wrong.custom.provider = 'other'; assert.equal(observeResponse(applied, applied.conditions[0], wrong).eligible, false)
  const incomplete = clone(response); incomplete.completion.status = 'incomplete'; assert.equal(observeResponse(applied, applied.conditions[0], incomplete).eligible, false)
  assert.equal(observeResponse(applied, applied.conditions[0], response).usage.outputTokens.status, 'unavailable')
  draft.rows[0].checks.identityMode = 'inherit'; draft.rows[0].checks.completionMode = 'inherit'
  for (const field of Object.values(draft.rows[0].checks.paths)) field.mode = 'inherit'
  const inherited = compileConditionFields(context, draft).observationPlan.overrides.recorded
  assert.deepEqual(inherited, { mapping: { identity: { version: ['custom', 'version'] }, usage: { outputTokens: ['custom', 'tokens'] } } })
  const noPlan = contextFor(), unstarted = createConditionFieldsDraft(noPlan); unstarted.rows[0].checks.completionMode = 'set'
  refused(noPlan, unstarted, /Explicitly start an accounting plan/)
})

test('workflow assignment, explicit envelope maps and removal remain coupled through unchanged validators', async () => {
  const spec = newExperimentDraft(workflowFixture(), { initializePopulation: true })
  spec.conditions[0].collection = { comparisonUnit: 'model', instructions: { system: null, developer: null }, tools: [], contextConstruction: 'frozen-workflow-projection', sessionIsolation: 'fresh-call-requested' }
  spec.workflowPlan.workflows[0].stages.forEach(stage => { stage.allowedTools = [] }); spec.workflowPlan.workflows[0].budgets.maxToolCalls = 0
  const context = contextFor(spec), draft = createConditionFieldsDraft(context)
  assert.equal(draft.rows[0].profile, 'replay')
  draft.rows[0].adapter.responsesText = '{}'; draft.rows[0].adapter.workflowResponses.text = '{}'
  const setup = compileConditionFields(context, draft), frozen = await freezeStudy(applyWorkflowSetup(spec, setup))
  const trial = frozen.schedule[0], state = newWorkflowState(frozen, trial, 1), request = workflowRequest(state)
  const condition = frozen.spec.conditions[0], task = frozen.tasks.find(row => row.id === trial.taskId)
  await assert.rejects(replayAdapter({ condition, task, request, signal: new AbortController().signal }), /No recorded workflow response/)
  assert.deepEqual(setup.workflow.plan, spec.workflowPlan)
  const removed = clone(draft); removed.rows[0].workflowId = ''; refused(context, removed, /Every workflow must be assigned/)
  const noMap = clone(draft); noMap.rows[0].adapter.workflowResponses.present = false; refused(context, noMap, /explicit task\/stage response fixtures/)
})

test('collector replacement is explicit, retains unrelated model fields and never refreshes saved responses on ordinary edits', () => {
  const context = contextFor(), initial = createConditionFieldsDraft(context), changed = clone(initial)
  changed.rows[0].label = { present: true, text: 'Only label changed' }
  assert.deepEqual(compileConditionFields(context, changed).protocolFields.conditions[0].adapter, context.spec.conditions[0].adapter)
  const http = setConditionFieldsProfile(context, initial, initial.rows[0].key, 'http')
  http.rows[0].adapter.url = 'https://example.invalid/frozen-request'
  assert.deepEqual(compileConditionFields(context, http).protocolFields.conditions[0].model, context.spec.conditions[0].model)
  assert.deepEqual(compileConditionFields(context, http).protocolFields.conditions[0].adapter, { kind: 'http', url: 'https://example.invalid/frozen-request' })
  assert.deepEqual(initial, createConditionFieldsDraft(context))
})

test('valid condition IDs matching object property names receive only explicitly authored report overrides', () => {
  const context = contextFor()
  let draft = addConditionFieldsRow(context, createConditionFieldsDraft(context), { id: 'constructor', profile: 'http' })
  fillHttp(draft.rows[1], 'explicit-model')
  draft = requireConditionFieldsChecks(context, draft, draft.rows[1].key)
  const setup = compileConditionFields(context, draft)
  assert.equal(Object.hasOwn(setup.observationPlan.overrides, 'constructor'), true)
  assert.deepEqual(setup.observationPlan.overrides.constructor.identity, { policy: 'require-match', fields: ['provider', 'id'] })
  assert.equal(Object.getPrototypeOf(setup.observationPlan.overrides), Object.prototype)
})
