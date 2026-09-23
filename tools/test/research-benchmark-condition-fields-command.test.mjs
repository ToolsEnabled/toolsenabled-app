import assert from 'node:assert/strict'
import test from 'node:test'
import { createConditionFieldsDraft, compileConditionFields, addConditionFieldsRow,
  setConditionFieldsProfile, duplicateConditionFieldsRow } from '../../src/research-condition-fields.mjs'
import { applyWorkflowSetup } from '../../src/research-workflow-setup.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { validateStudy } from '../../src/benchmark/study.mjs'

// A minimal Lean Bench run needs two live collectors that invoke a local
// program: a trusted generated reference program, and the model under test
// behind a command-line tool. Both are `command` adapters. The structured
// condition editor modelled only `replay` and `http`, so both were forced into
// the advanced profile ("This collector remains an exact advanced
// configuration.") and could only be hand-authored as expert JSON -- no command
// field, no arguments, no environment allowlist, and no field-level refusal
// when one of those was missing or malformed. Measured against the apparatus
// run that produced project efaa64a2: its two live conditions were written by
// hand in a build script, because the page could not express them.

const clone = value => structuredClone(value)
const ordinary = () => newExperimentDraft(genericStarter(), { initializePopulation: true })

function contextFor(spec = ordinary()) {
  const protocolFields = Object.fromEntries(['protocol', 'conditions', 'inputs', 'environment', 'requireReview', 'decisions'].map(key => [key, clone(spec[key])]))
  const workflow = { plan: spec.workflowPlan || null, assignments: Object.fromEntries(spec.conditions.map(row => [row.id, row.workflowId ?? null])) }
  const observationPlan = spec.observationPlan || null
  return { spec: clone(spec), protocolFields, workflow: clone(workflow), observationPlan: clone(observationPlan),
    sourceText: { conditions: JSON.stringify(protocolFields.conditions, null, 2), workflow: JSON.stringify(workflow, null, 2), observations: JSON.stringify(observationPlan, null, 2) } }
}

function refused(context, draft, pattern, label) {
  const before = clone({ context, draft })
  assert.throws(() => compileConditionFields(context, draft), pattern, label)
  assert.deepEqual({ context, draft }, before, label + ': a refused compile must leave the context and draft untouched')
}

const model = { provider: 'apparatus-control', id: 'generated-reference-program', surface: 'local-command', settings: {} }

// The two collectors of the measured apparatus run, verbatim in shape.
const REFERENCE = { id: 'reference-program', label: 'Trusted generated reference program (apparatus control)',
  model, adapter: { kind: 'command', command: 'node', args: ['adapters/reference-program.mjs'] } }
const CLI = { id: 'model-cli', label: 'Local command-line model', model: { provider: 'anthropic-claude-cli', id: 'claude-sonnet-5', surface: 'local-cli-print-mode',
    settings: { outputFormat: 'json', strictMcpConfig: true, allowedTools: 'none', workingDirectory: 'fresh-empty-temporary-directory' } },
  collection: { comparisonUnit: 'model', instructions: { system: null, developer: null }, tools: [],
    contextConstruction: 'frozen-public-request', sessionIsolation: 'fresh-request' },
  adapter: { kind: 'command', command: 'node', args: ['adapters/model-cli.mjs'], env: ['HOME'] } }

function withCommandConditions() {
  const spec = ordinary()
  spec.conditions = [...spec.conditions, clone(REFERENCE), clone(CLI)]
  spec.inputs = [...spec.inputs,
    { path: 'adapters/reference-program.mjs', sha256: 'a'.repeat(64) },
    { path: 'adapters/model-cli.mjs', sha256: 'b'.repeat(64) }]
  return spec
}

const rowById = (draft, id) => draft.rows.find(row => row.id === id)

function fillCommand(row, { command = 'node', args = ['adapters/model-cli.mjs'], provider = 'local-cli', id = 'cli-default' } = {}) {
  row.adapter.command = command
  row.adapter.args = args
  row.model.present = true
  row.model.identity.provider.present = true; row.model.identity.provider.text = provider
  row.model.identity.id.present = true; row.model.identity.id.text = id
  return row
}

test('a command collector gets ordinary editable fields instead of being retained as advanced expert JSON', () => {
  const context = contextFor(withCommandConditions()), draft = createConditionFieldsDraft(context)
  for (const id of ['reference-program', 'model-cli']) {
    const row = rowById(draft, id)
    assert.equal(row.profile, 'command', id + ' must be modelled as a command collector, not hidden behind expert JSON')
    assert.equal(row.advancedReason, '', id + ' must carry no advanced reason, got: ' + row.advancedReason)
  }
  const reference = rowById(draft, 'reference-program')
  assert.equal(reference.adapter.command, 'node')
  assert.deepEqual(reference.adapter.args, ['adapters/reference-program.mjs'])
  assert.deepEqual(reference.adapter.env, { present: false, names: [] }, 'an adapter without an environment allowlist reports it absent, never invented')
  assert.deepEqual(rowById(draft, 'model-cli').adapter.env, { present: true, names: ['HOME'] },
    'the environment allowlist the collector declares is shown as declared')
})

test('the command collectors of the frozen apparatus round-trip through the fields unchanged', () => {
  const context = contextFor(withCommandConditions()), draft = createConditionFieldsDraft(context)
  const setup = compileConditionFields(context, draft)
  for (const source of [REFERENCE, CLI]) {
    const compiled = setup.protocolFields.conditions.find(row => row.id === source.id)
    assert.deepEqual(compiled, source, source.id + ': the full declaration must survive an edit round trip unchanged')
  }
  validateStudy(applyWorkflowSetup(context.spec, setup))
})

test('a command collector can be authored from nothing and lowers to the hand-authored adapter', () => {
  const context = contextFor()
  const draft = addConditionFieldsRow(context, createConditionFieldsDraft(context), { id: 'reference-program', profile: 'command' })
  const row = rowById(draft, 'reference-program')
  assert.equal(row.profile, 'command')
  fillCommand(row, { args: ['adapters/reference-program.mjs'], provider: 'apparatus-control', id: 'generated-reference-program' })
  const setup = compileConditionFields(context, draft)
  const compiled = setup.protocolFields.conditions.find(item => item.id === 'reference-program')
  assert.deepEqual(compiled.adapter, { kind: 'command', command: 'node', args: ['adapters/reference-program.mjs'] })
  assert.deepEqual(compiled.model, { provider: 'apparatus-control', id: 'generated-reference-program' })
  validateStudy(applyWorkflowSetup(context.spec, setup))
})

test('an environment allowlist is authored explicitly, and an absent one stays absent', () => {
  const context = contextFor()
  const draft = addConditionFieldsRow(context, createConditionFieldsDraft(context), { id: 'model-cli', profile: 'command' })
  const row = fillCommand(rowById(draft, 'model-cli'))
  const absent = compileConditionFields(context, draft).protocolFields.conditions.find(item => item.id === 'model-cli')
  assert.equal(Object.hasOwn(absent.adapter, 'env'), false, 'an unset allowlist must not appear as an empty array')
  row.adapter.env = { present: true, names: ['HOME', 'PATH'] }
  const setup = compileConditionFields(context, draft)
  const declared = setup.protocolFields.conditions.find(item => item.id === 'model-cli')
  assert.deepEqual(declared.adapter.env, ['HOME', 'PATH'])
  validateStudy(applyWorkflowSetup(context.spec, setup))
})

test('each missing or malformed command value is refused by name, in plain language', () => {
  const context = contextFor()
  const start = () => {
    const draft = addConditionFieldsRow(context, createConditionFieldsDraft(context), { id: 'model-cli', profile: 'command' })
    return { draft, row: fillCommand(rowById(draft, 'model-cli')) }
  }
  const cases = [
    ['an empty command', row => { row.adapter.command = '   ' }, /name the command/i],
    ['a non-string command', row => { row.adapter.command = 7 }, /command/i],
    ['a non-array argument list', row => { row.adapter.args = 'adapters/model-cli.mjs' }, /argument/i],
    ['a non-string argument', row => { row.adapter.args = ['ok', 3] }, /argument/i],
    ['a lowercase environment name', row => { row.adapter.env = { present: true, names: ['home'] } }, /environment/i],
    ['a non-array environment allowlist', row => { row.adapter.env = { present: true, names: 'HOME' } }, /environment/i],
    ['an undeclared environment presence flag', row => { row.adapter.env = { present: 'yes', names: [] } }, /environment/i],
  ]
  for (const [label, mutate, pattern] of cases) {
    const { draft, row } = start(); mutate(row)
    refused(context, draft, pattern, label)
  }
})

test('switching an ordinary collector to a command collector clears the former collector values', () => {
  const context = contextFor()
  const initial = createConditionFieldsDraft(context)
  const replay = initial.rows.find(row => row.profile === 'replay')
  assert.ok(replay, 'the ordinary starter supplies a recorded collector to switch')
  const draft = setConditionFieldsProfile(context, initial, replay.key, 'command')
  const row = draft.rows.find(item => item.key === replay.key)
  assert.equal(row.profile, 'command')
  assert.equal(row.adapter.command, '')
  assert.deepEqual(row.adapter.args, [])
  assert.deepEqual(row.adapter.env, { present: false, names: [] })
  assert.equal(row.adapter.responsesText, '{}', 'the recorded responses of the former collector must not be carried over')
})

test('duplicating a command collector keeps its command and arguments', () => {
  const context = contextFor(withCommandConditions()), initial = createConditionFieldsDraft(context)
  const source = rowById(initial, 'reference-program')
  const draft = duplicateConditionFieldsRow(context, initial, source.key, 'reference-program-2')
  const copy = rowById(draft, 'reference-program-2')
  assert.equal(copy.profile, 'command')
  assert.equal(copy.adapter.command, 'node')
  assert.deepEqual(copy.adapter.args, ['adapters/reference-program.mjs'])
})

test('a collector shape the fields do not model is still retained as advanced expert JSON', () => {
  const spec = ordinary()
  // `module` collectors remain outside the ordinary fields; nothing about the
  // command profile may quietly widen what the editor claims to model.
  spec.conditions = [...spec.conditions, { id: 'module-collector', model, adapter: { kind: 'module', file: 'adapters/grader.mjs' } }]
  spec.inputs = [...spec.inputs, { path: 'adapters/grader.mjs', sha256: 'c'.repeat(64) }]
  const context = contextFor(spec), draft = createConditionFieldsDraft(context)
  const row = rowById(draft, 'module-collector')
  assert.equal(row.profile, 'advanced')
  assert.equal(row.advancedReason, 'This collector remains an exact advanced configuration.')
  assert.throws(() => addConditionFieldsRow(context, draft, { id: 'another', profile: 'module' }), /recorded replay, a local command or HTTPS/i)
})

// Worker 13's takeover cases: strict optional-name validation, explicit list
// removal, and complete collection retention. No command is invoked here.
test('a selected credential variable needs a valid nonempty name while an absent one stays absent', () => {
  const context = contextFor()
  const draft = addConditionFieldsRow(context, createConditionFieldsDraft(context), { id: 'model-cli', profile: 'command' })
  const row = fillCommand(rowById(draft, 'model-cli'))
  for (const name of ['', ' ', 'lowercase', '9NAME', 'NAME-WITH-DASH', 'A'.repeat(101)]) {
    row.adapter.credentialEnv = { present: true, text: name }
    refused(context, draft, /credential.*variable|variable.*name/i, 'an invalid selected credential name')
  }
  row.adapter.credentialEnv = { present: true, text: 'SYNTHETIC_CREDENTIAL_NAME' }
  let compiled = compileConditionFields(context, draft).protocolFields.conditions.find(item => item.id === row.id)
  assert.equal(compiled.adapter.credentialEnv, 'SYNTHETIC_CREDENTIAL_NAME')
  row.adapter.credentialEnv.present = false
  compiled = compileConditionFields(context, draft).protocolFields.conditions.find(item => item.id === row.id)
  assert.equal(Object.hasOwn(compiled.adapter, 'credentialEnv'), false)
  assert.equal(row.adapter.credentialEnv.text, 'SYNTHETIC_CREDENTIAL_NAME', 'turning the option off preserves the local draft name')
})

test('an environment list can be explicitly empty but cannot be hidden while names remain', () => {
  const context = contextFor()
  const draft = addConditionFieldsRow(context, createConditionFieldsDraft(context), { id: 'model-cli', profile: 'command' })
  const row = fillCommand(rowById(draft, 'model-cli'))
  row.adapter.env = { present: true, names: [] }
  const explicit = compileConditionFields(context, draft).protocolFields.conditions.find(item => item.id === row.id)
  assert.deepEqual(explicit.adapter.env, [])
  for (const names of [['HOME'], ['']]) {
    row.adapter.env = { present: false, names }
    refused(context, draft, /environment|variable/i, 'an absent list with retained names')
  }
  row.adapter.env = { present: false, names: [] }
  const absent = compileConditionFields(context, draft).protocolFields.conditions.find(item => item.id === row.id)
  assert.equal(Object.hasOwn(absent.adapter, 'env'), false)
})

test('command arguments retain empty entries, whitespace and shell characters literally without aliases', () => {
  const context = contextFor()
  const draft = addConditionFieldsRow(context, createConditionFieldsDraft(context), { id: 'model-cli', profile: 'command' })
  const args = ['adapters/program with spaces.mjs', '', '  exact text  ', '$VARIABLE', '$(literal)', '`literal`', ';literal']
  const row = fillCommand(rowById(draft, 'model-cli'), { args })
  const compiled = compileConditionFields(context, draft).protocolFields.conditions.find(item => item.id === row.id)
  assert.deepEqual(compiled.adapter.args, args)
  compiled.adapter.args[0] = 'returned-copy-only'
  assert.equal(row.adapter.args[0], 'adapters/program with spaces.mjs')
})

test('switching away from command removes its args and optional names without changing retained collection controls', () => {
  const context = contextFor(withCommandConditions())
  let draft = createConditionFieldsDraft(context)
  let row = rowById(draft, 'model-cli')
  row.adapter.credentialEnv = { present: true, text: 'SYNTHETIC_CREDENTIAL_NAME' }
  draft = setConditionFieldsProfile(context, draft, row.key, 'http')
  row = rowById(draft, 'model-cli'); row.adapter.url = 'https://example.invalid/frozen-request'
  let compiled = compileConditionFields(context, draft).protocolFields.conditions.find(item => item.id === row.id)
  assert.deepEqual(compiled.adapter, { kind: 'http', url: 'https://example.invalid/frozen-request' })
  assert.deepEqual(compiled.collection, CLI.collection)
  draft = setConditionFieldsProfile(context, draft, row.key, 'replay')
  compiled = compileConditionFields(context, draft).protocolFields.conditions.find(item => item.id === row.id)
  assert.deepEqual(compiled.adapter, { kind: 'replay', responses: {} })
  assert.deepEqual(compiled.collection, CLI.collection)
})
