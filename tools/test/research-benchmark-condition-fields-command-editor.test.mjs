import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createConditionFieldsEditor } from '../../src/research-condition-fields.js'
import { createConditionFieldsDraft, compileConditionFields } from '../../src/research-condition-fields.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'

// The visible half of the local command collector. Before this, the editor
// offered only recorded responses and an HTTPS endpoint, so the two collectors
// a Lean Bench run needs -- a generated reference program and the model behind
// a command-line tool -- had no controls at all.

let installed
const editors = []
beforeEach(() => { installed = installDomStandIn(globalThis) })
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); installed.restore() })

const f = (editor, name) => editor.el.querySelector('[data-condition-fields-' + name + ']')
const all = (editor, name) => [...editor.el.querySelectorAll('[data-condition-fields-' + name + ']')]
const nested = (node, name) => node.querySelector('[data-condition-fields-' + name + ']')
function input(node, value) {
  assert.ok(node); assert.equal(node.disabled, false)
  if (node.type === 'checkbox') node.checked = value; else node.value = value
  node.dispatch('input')
}
const fill = (editor, name, value) => input(f(editor, name), value)
function click(editor, name) { const button = f(editor, name); assert.ok(button, name); assert.equal(button.disabled, false, name); button.click() }
function contextFor(source) {
  const spec = source || newExperimentDraft(genericStarter(), { initializePopulation: true })
  const workflow = { plan: spec.workflowPlan || null, assignments: Object.fromEntries(spec.conditions.map(row => [row.id, row.workflowId || null])) }
  const observationPlan = spec.observationPlan || null
  return { spec, protocolFields: Object.fromEntries(['protocol', 'conditions', 'inputs', 'environment', 'requireReview', 'decisions'].map(key => [key, structuredClone(spec[key])])),
    workflow, observationPlan, sourceText: { conditions: JSON.stringify(spec.conditions, null, 2), workflow: JSON.stringify(workflow), observations: JSON.stringify(observationPlan) } }
}
function mount(context = contextFor(), options = {}) {
  const editor = createConditionFieldsEditor(options); editors.push(editor); document.body.append(editor.el)
  editor.setContext({ context, draft: createConditionFieldsDraft(context), contextKey: 'account-a:project-a' }); return editor
}
function add(editor, id, profile) { fill(editor, 'new-id', id); fill(editor, 'new-profile', profile); click(editor, 'add'); assert.equal(f(editor, 'id').value, id) }
function addArgument(editor, value) {
  click(editor, 'add-arg')
  input(nested(all(editor, 'arg-row').at(-1), 'arg'), value)
}
function addVariable(editor, value) {
  click(editor, 'add-env')
  input(nested(all(editor, 'env-row').at(-1), 'env-name'), value)
}

test('a local command collector is offered, rendered and lowered to the adapter a run executes', () => {
  const context = contextFor(), editor = mount(context)
  add(editor, 'reference-program', 'command')
  assert.equal(f(editor, 'profile').value, 'command', 'the roster must offer and keep the local command collector')
  assert.ok(f(editor, 'command-collector'), 'a command collector must render its own controls')
  assert.ok(f(editor, 'command'), 'a command collector must render a command field')
  assert.equal(f(editor, 'replay'), null, 'a command collector must not render recorded-response controls')
  fill(editor, 'command', 'node')
  addArgument(editor, 'adapters/reference-program.mjs')
  fill(editor, 'model-present', true)
  input(nested(f(editor, 'identity'), 'provider'), 'apparatus-control')
  input(nested(f(editor, 'identity'), 'model-id'), 'generated-reference-program')
  const compiled = compileConditionFields(context, editor.getDraft()).protocolFields.conditions.find(row => row.id === 'reference-program')
  assert.deepEqual(compiled.adapter, { kind: 'command', command: 'node', args: ['adapters/reference-program.mjs'] })
})

test('the environment allowlist stays locked until it is declared, and then names variables only', () => {
  const context = contextFor(), editor = mount(context)
  add(editor, 'model-cli', 'command')
  fill(editor, 'command', 'node')
  addArgument(editor, 'adapters/model-cli.mjs')
  fill(editor, 'model-present', true)
  input(nested(f(editor, 'identity'), 'provider'), 'local-cli')
  input(nested(f(editor, 'identity'), 'model-id'), 'cli-default')
  assert.equal(f(editor, 'add-env').disabled, true, 'variable names cannot be added before the allowlist is declared')
  const withoutEnv = compileConditionFields(context, editor.getDraft()).protocolFields.conditions.find(row => row.id === 'model-cli')
  assert.equal(Object.hasOwn(withoutEnv.adapter, 'env'), false, 'an undeclared allowlist must not appear in the adapter')
  fill(editor, 'env-present', true)
  addVariable(editor, 'HOME')
  const withEnv = compileConditionFields(context, editor.getDraft()).protocolFields.conditions.find(row => row.id === 'model-cli')
  assert.deepEqual(withEnv.adapter, { kind: 'command', command: 'node', args: ['adapters/model-cli.mjs'], env: ['HOME'] })
})

test('arguments are separate entries and can be removed one at a time', () => {
  const context = contextFor(), editor = mount(context)
  add(editor, 'model-cli', 'command')
  fill(editor, 'command', 'node')
  for (const value of ['adapters/model-cli.mjs', '--first', '--second']) addArgument(editor, value)
  assert.equal(all(editor, 'arg-row').length, 3)
  fill(editor, 'model-present', true)
  input(nested(f(editor, 'identity'), 'provider'), 'local-cli')
  input(nested(f(editor, 'identity'), 'model-id'), 'cli-default')
  const three = compileConditionFields(context, editor.getDraft()).protocolFields.conditions.find(row => row.id === 'model-cli')
  assert.deepEqual(three.adapter.args, ['adapters/model-cli.mjs', '--first', '--second'])
  nested(all(editor, 'arg-row')[1], 'remove-arg').click()
  const two = compileConditionFields(context, editor.getDraft()).protocolFields.conditions.find(row => row.id === 'model-cli')
  assert.deepEqual(two.adapter.args, ['adapters/model-cli.mjs', '--second'])
})

function completeCommandEditor() {
  const context = contextFor(), editor = mount(context)
  add(editor, 'model-cli', 'command')
  fill(editor, 'command', 'node')
  fill(editor, 'provider', 'synthetic-cli'); fill(editor, 'model-id', 'synthetic-model')
  return { context, editor }
}
const commandFrom = (context, editor) => compileConditionFields(context, editor.getDraft()).protocolFields.conditions.find(row => row.id === 'model-cli')

test('an environment list stays enabled and editable until every variable row is removed', () => {
  const { context, editor } = completeCommandEditor()
  fill(editor, 'env-present', true)
  click(editor, 'add-env')
  assert.equal(f(editor, 'env-present').checked, true)
  assert.equal(f(editor, 'env-present').disabled, true, 'retained rows must not be hidden behind an unchecked declaration')
  assert.equal(f(editor, 'env-name').disabled, false, 'the incomplete name must remain editable')
  assert.throws(() => commandFrom(context, editor), /environment|variable/i)
  fill(editor, 'env-name', 'HOME')
  assert.deepEqual(commandFrom(context, editor).adapter.env, ['HOME'])
  assert.equal(f(editor, 'env-present').disabled, true, 'valid retained names also need explicit removal')
  click(editor, 'remove-env')
  assert.equal(f(editor, 'env-present').disabled, false)
  assert.deepEqual(commandFrom(context, editor).adapter.env, [], 'removing the last name leaves an explicitly empty list')
  fill(editor, 'env-present', false)
  assert.equal(Object.hasOwn(commandFrom(context, editor).adapter, 'env'), false)
  assert.equal(f(editor, 'add-env').disabled, true)
})

test('the credential choice refuses missing names and retains only a name when explicitly selected', () => {
  const { context, editor } = completeCommandEditor()
  assert.equal(f(editor, 'credential-env').disabled, true)
  fill(editor, 'credential-present', true)
  assert.throws(() => commandFrom(context, editor), /credential.*variable/i)
  fill(editor, 'credential-env', 'lowercase')
  assert.throws(() => commandFrom(context, editor), /credential.*variable/i)
  fill(editor, 'credential-env', 'SYNTHETIC_CREDENTIAL_NAME')
  assert.equal(commandFrom(context, editor).adapter.credentialEnv, 'SYNTHETIC_CREDENTIAL_NAME')
  fill(editor, 'credential-present', false)
  assert.equal(f(editor, 'credential-env').disabled, true)
  assert.equal(f(editor, 'credential-env').value, 'SYNTHETIC_CREDENTIAL_NAME')
  assert.equal(Object.hasOwn(commandFrom(context, editor).adapter, 'credentialEnv'), false)
})

test('literal argument text and stale removed controls cannot alter another command row', () => {
  const { context, editor } = completeCommandEditor()
  for (const arg of ['adapters/program with spaces.mjs', '', '  exact text  ', '$VARIABLE;$(literal)']) addArgument(editor, arg)
  const removed = nested(all(editor, 'arg-row')[1], 'arg')
  nested(all(editor, 'arg-row')[1], 'remove-arg').click()
  removed.value = 'stale input'; removed.dispatch('input')
  assert.deepEqual(commandFrom(context, editor).adapter.args, ['adapters/program with spaces.mjs', '  exact text  ', '$VARIABLE;$(literal)'])
  fill(editor, 'profile', 'replay')
  assert.equal(f(editor, 'command-collector'), null)
  assert.deepEqual(commandFrom(context, editor).adapter, { kind: 'replay', responses: {} })
})
