import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createConditionFieldsEditor } from '../../src/research-condition-fields.js'
import { createConditionFieldsDraft, compileConditionFields } from '../../src/research-condition-fields.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { observationPlanFromSpec } from '../../src/benchmark/observations.mjs'
import { workflowDraft } from '../../src/benchmark/workflow.mjs'
import { canonical } from '../../src/benchmark/prompts.mjs'

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
function selectId(editor, id) { const row = editor.getDraft().rows.find(row => row.id === id); assert.ok(row, id); fill(editor, 'row', row.key) }
function add(editor, id, profile) { fill(editor, 'new-id', id); fill(editor, 'new-profile', profile); click(editor, 'add'); assert.equal(f(editor, 'id').value, id) }
function setting(editor, key, type, text) {
  click(editor, 'add-setting')
  let row = all(editor, 'setting-row').at(-1)
  input(nested(row, 'setting-key'), key); input(nested(row, 'setting-type'), type)
  row = all(editor, 'setting-row').at(-1)
  if (type !== 'null') input(nested(row, 'setting-text'), text)
}
function path(editor, name) { return editor.el.querySelector('[data-condition-fields-path="' + name + '"]') }

test('two HTTPS conditions can be authored through ordinary controls with exact distinct setting types and returned-report checks', () => {
  const context = contextFor(), editor = mount(context)
  for (const [id, model, quantity] of [['alpha', 'requested-a', '0'], ['beta', 'requested-b', '2']]) {
    add(editor, id, 'http')
    assert.equal(f(editor, 'provider').value, ''); assert.equal(f(editor, 'model-id').value, '')
    fill(editor, 'provider', 'research-gateway'); fill(editor, 'model-id', model)
    fill(editor, 'url', 'https://gateway.example/' + id)
    fill(editor, 'label-present', true); fill(editor, 'label', 'Requested ' + id)
    fill(editor, 'settings-present', true)
    setting(editor, 'quantity', 'number', quantity)
    if (id === 'alpha') {
      setting(editor, 'enabled', 'boolean', 'false'); setting(editor, 'unset', 'null')
      setting(editor, 'literal', 'string', '0'); setting(editor, 'sequence', 'array', '[0, false, "0"]')
      setting(editor, 'options', 'object', '{\n  "nested": [0, false]\n}')
      fill(editor, 'credential-present', true); fill(editor, 'credential-env', 'ALPHA_GATEWAY_TOKEN')
      fill(editor, 'system-kind', 'text'); fill(editor, 'system', '  Exact requested system text\n')
    }
    click(editor, 'require-checks')
    assert.equal(f(editor, 'identity-policy').value, 'require-match')
    assert.equal(f(editor, 'completion-policy').value, 'require-complete')
  }
  selectId(editor, 'recorded'); assert.equal(f(editor, 'id').disabled, true); click(editor, 'remove')
  const setup = compileConditionFields(context, editor.getDraft())
  assert.deepEqual(setup.protocolFields.conditions, [
    { id: 'alpha', label: 'Requested alpha', model: { provider: 'research-gateway', id: 'requested-a', settings: {
      quantity: 0, enabled: false, unset: null, literal: '0', sequence: [0, false, '0'], options: { nested: [0, false] },
    } }, adapter: { kind: 'http', url: 'https://gateway.example/alpha', credentialEnv: 'ALPHA_GATEWAY_TOKEN' },
    collection: { comparisonUnit: 'model', instructions: { system: '  Exact requested system text\n', developer: null }, tools: [], contextConstruction: 'frozen-public-request', sessionIsolation: 'fresh-request' } },
    { id: 'beta', label: 'Requested beta', model: { provider: 'research-gateway', id: 'requested-b', settings: { quantity: 2 } },
      adapter: { kind: 'http', url: 'https://gateway.example/beta' }, collection: { comparisonUnit: 'model', instructions: { system: null, developer: null }, tools: [], contextConstruction: 'frozen-public-request', sessionIsolation: 'fresh-request' } },
  ])
  for (const id of ['alpha', 'beta']) {
    assert.deepEqual(setup.observationPlan.overrides[id], { identity: { policy: 'require-match', fields: ['provider', 'id'] }, completion: { policy: 'require-complete' },
      mapping: { identity: { provider: ['identity', 'provider'], id: ['identity', 'id'] }, completion: { status: ['completion', 'status'] } } })
  }
  assert.equal(setup.observationPlan.identity.policy, 'record', 'Explicit condition checks do not rewrite the shared policy.')
  assert.equal(setup.observationPlan.costEstimate, null)
  assert.deepEqual(setup.workflow, { plan: null, assignments: { alpha: null, beta: null } })
  for (const key of ['protocol', 'inputs', 'environment', 'requireReview', 'decisions']) assert.deepEqual(setup.protocolFields[key], context.protocolFields[key])
  assert.match(editor.el.textContent, /frozen-request JSON/)
  assert.match(editor.el.textContent, /do not authenticate/)
  assert.match(editor.el.textContent, /No endpoint is contacted/)
})

test('unfinished field text and optional absence survive parent echo and remount without replacing the focused input', () => {
  const context = contextFor(); let editor, changes = 0
  editor = mount(context, { onChange(draft) { changes++; editor.setContext({ context, draft: JSON.parse(JSON.stringify(draft)), contextKey: 'account-a:project-a' }) } })
  setting(editor, 'unfinished', 'number', '1')
  const number = nested(all(editor, 'setting-row').at(-1), 'setting-text')
  number.focus(); number.selectionStart = 1; number.selectionEnd = 1
  input(number, '1e')
  assert.equal(nested(all(editor, 'setting-row').at(-1), 'setting-text'), number)
  assert.equal(document.activeElement, number); assert.equal(number.selectionStart, 1)
  assert.equal(number.getAttribute('type'), 'text')
  assert.throws(() => compileConditionFields(context, editor.getDraft()), /complete finite JSON number/)
  fill(editor, 'version-present', true); fill(editor, 'version', '  partial version  '); fill(editor, 'version-present', false)
  fill(editor, 'label-present', true); fill(editor, 'label', '')
  setting(editor, 'unfinished-json', 'object', '{ "exact":\n ')
  const saved = JSON.parse(JSON.stringify(editor.getDraft())), count = changes
  const restored = mount(context, { onChange() { changes++ } })
  restored.setContext({ context, draft: saved, contextKey: 'restored-account:project-a' })
  assert.deepEqual(restored.getDraft(), saved); assert.equal(changes, count)
  assert.deepEqual(saved.rows[0].model.identity.version, { present: false, text: '  partial version  ' })
  assert.deepEqual(saved.rows[0].label, { present: true, text: '' })
  assert.equal(all(restored, 'setting-row').at(-1).querySelector('textarea').value, '{ "exact":\n ')
  fill(restored, 'version-present', true); assert.equal(f(restored, 'version').value, '  partial version  ')
  const returned = restored.getDraft(); returned.rows[0].model.identity.provider.text = 'caller mutation'
  assert.equal(restored.getDraft().rows[0].model.identity.provider.text, 'fixture')
})

test('duplicate typed setting keys refuse without discarding either raw row or inferring a boolean', () => {
  const context = contextFor(), editor = mount(context)
  setting(editor, 'same', 'number', '0'); setting(editor, 'same', 'string', '0')
  const before = editor.getDraft()
  assert.throws(() => compileConditionFields(context, before), /keys must be distinct/)
  assert.deepEqual(editor.getDraft(), before)
  const second = all(editor, 'setting-row')[1]; input(nested(second, 'setting-key'), 'boolean')
  input(nested(second, 'setting-type'), 'boolean')
  assert.equal(editor.getDraft().rows[0].model.settings[1].text, '0', 'Changing a type preserves the pending text without inventing true/false.')
  assert.throws(() => compileConditionFields(context, editor.getDraft()), /choose true or false/)
  input(nested(all(editor, 'setting-row')[1], 'setting-text'), 'false')
  assert.deepEqual(compileConditionFields(context, editor.getDraft()).protocolFields.conditions[0].model.settings, { same: 0, boolean: false })
})

test('configuration duplication clears only duplicate maps and named workflow/contrast references visibly block removal', () => {
  const spec = newExperimentDraft(genericStarter(), { initializePopulation: true }), workflow = workflowDraft(spec)
  spec.workflowPlan = workflow.plan; spec.observationPlan = observationPlanFromSpec()
  spec.conditions[0].workflowId = 'prompt-flow'; spec.conditions[0].adapter.mode = 'envelope'
  spec.conditions[0].adapter.workflowResponses = { 'addition-a': { answer: { output: 'SOURCE RESPONSE', workflow: { toolCalls: [] } } } }
  const context = contextFor(spec), editor = mount(context), original = editor.getDraft().rows[0]
  assert.equal(f(editor, 'remove').disabled, true); assert.match(f(editor, 'references').textContent, /workflowPlan.workflows.prompt-flow \(last assignment\)/)
  fill(editor, 'duplicate-id', 'copied'); click(editor, 'duplicate')
  assert.equal(f(editor, 'id').disabled, false)
  const copied = editor.getDraft().rows[1]
  assert.deepEqual(editor.getDraft().rows[0], original)
  assert.equal(copied.adapter.responsesText, '{}'); assert.equal(copied.adapter.workflowResponses.text, '{}')
  assert.equal(copied.adapter.mode, 'envelope'); assert.equal(copied.workflowId, 'prompt-flow')
  assert.deepEqual(copied.model, original.model)
  const setup = compileConditionFields(context, editor.getDraft())
  assert.deepEqual(setup.protocolFields.conditions[0], spec.conditions[0])
  assert.deepEqual(setup.protocolFields.conditions[1].adapter, { kind: 'replay', mode: 'envelope', responses: {}, workflowResponses: {} })
  click(editor, 'remove'); assert.deepEqual(editor.getDraft().rows, [original])

  const contrasted = structuredClone(spec)
  contrasted.conditions.push({ ...structuredClone(contrasted.conditions[0]), id: 'other' })
  contrasted.analysisPlan.contrasts = [{ id: 'requested-difference', first: 'recorded', second: 'other' }]
  const otherContext = contextFor(contrasted)
  editor.setContext({ context: otherContext, draft: createConditionFieldsDraft(otherContext), contextKey: 'account-a:contrasted' })
  assert.equal(f(editor, 'remove').disabled, true)
  assert.match(f(editor, 'references').textContent, /analysisPlan.contrasts.requested-difference/)
})

test('literal path fields change only the selected override and inherited controls show the shared effective values', () => {
  const spec = newExperimentDraft(genericStarter(), { initializePopulation: true })
  spec.conditions.push({ ...structuredClone(spec.conditions[0]), id: 'second' })
  spec.observationPlan = observationPlanFromSpec()
  spec.observationPlan.overrides = {
    recorded: { identity: { policy: 'require-match', fields: ['provider', 'id'] }, mapping: { identity: { provider: ['first.report', 'provider'] }, usage: { outputTokens: ['meter', 'used'] } } },
    second: { completion: { policy: 'require-complete' }, mapping: { identity: { id: ['other', 'model'] } } },
  }
  const context = contextFor(spec), editor = mount(context), sibling = structuredClone(spec.observationPlan.overrides.second)
  let provider = path(editor, 'provider')
  assert.equal(nested(provider, 'path-mode').value, 'retain')
  input(provider.querySelectorAll('[data-condition-fields-segment-text]')[0], 'payload.with.dot')
  assert.equal(nested(path(editor, 'provider'), 'path-mode').value, 'set', 'Editing a path visibly changes its override scope.')
  nested(path(editor, 'provider'), 'add-segment').click()
  provider = path(editor, 'provider')
  input(provider.querySelectorAll('[data-condition-fields-segment-kind]')[2], 'index')
  input(path(editor, 'provider').querySelectorAll('[data-condition-fields-segment-text]')[2], '0')
  const edited = compileConditionFields(context, editor.getDraft())
  assert.deepEqual(edited.observationPlan.overrides.recorded.mapping.identity.provider, ['payload.with.dot', 'provider', 0])
  assert.deepEqual(edited.observationPlan.overrides.second, sibling)
  assert.deepEqual(edited.observationPlan.mapping, spec.observationPlan.mapping)
  fill(editor, 'identity-mode', 'inherit')
  assert.equal(f(editor, 'identity-policy').value, 'record'); assert.equal(f(editor, 'identity-policy').disabled, true)
  input(nested(path(editor, 'provider'), 'path-mode'), 'inherit')
  assert.deepEqual([...path(editor, 'provider').querySelectorAll('[data-condition-fields-segment-text]')].map(node => node.value), ['identity', 'provider'])
  assert.ok([...path(editor, 'provider').querySelectorAll('[data-condition-fields-segment-text]')].every(node => node.disabled))
  const inherited = compileConditionFields(context, editor.getDraft())
  assert.deepEqual(inherited.observationPlan.overrides.recorded, { mapping: { usage: { outputTokens: ['meter', 'used'] } } })
  assert.deepEqual(inherited.observationPlan.overrides.second, sibling)
})

test('navigation is read-only and stale, disabled, detached and destroyed controls cannot write across contexts', () => {
  const spec = newExperimentDraft(genericStarter(), { initializePopulation: true })
  spec.conditions.push({ ...structuredClone(spec.conditions[0]), id: 'second' })
  const context = contextFor(spec); let changes = 0
  const editor = mount(context, { onChange() { changes++ } }), initial = editor.getDraft()
  selectId(editor, 'second'); assert.equal(changes, 0); assert.deepEqual(editor.getDraft(), initial)
  const oldProvider = f(editor, 'provider')
  editor.setContext({ context, draft: initial, contextKey: 'account-a:project-a', readOnly: true })
  selectId(editor, 'recorded'); assert.equal(changes, 0)
  assert.equal(f(editor, 'provider').disabled, true); assert.equal(f(editor, 'add').disabled, true)
  oldProvider.value = 'detached writer'; oldProvider.dispatch('input'); assert.deepEqual(editor.getDraft(), initial)
  editor.setDisabled(true)
  for (const tag of ['input', 'textarea', 'select', 'button']) assert.ok([...editor.el.querySelectorAll(tag)].every(node => node.disabled))
  editor.setDisabled(false); assert.equal(f(editor, 'row').disabled, false); assert.equal(f(editor, 'provider').disabled, true)
  const staleContext = structuredClone(context); staleContext.sourceText.conditions += '\n '
  editor.setContext({ context: staleContext, draft: initial, contextKey: 'account-a:project-a' })
  assert.match(f(editor, 'status').textContent, /stale/); assert.equal(f(editor, 'provider').disabled, true)
  assert.deepEqual(editor.getDraft(), initial)
  const clean = contextFor(), next = createConditionFieldsDraft(clean)
  const previousFocused = f(editor, 'provider'); previousFocused.focus()
  editor.setContext({ context: clean, draft: next, contextKey: 'account-b:project-b' })
  assert.equal(f(editor, 'row').value, next.rows[0].key); assert.equal(f(editor, 'new-id').value, '')
  assert.equal(editor.getDraft().rows.length, 1)
  assert.notEqual(document.activeElement, f(editor, 'provider'), 'Replacing an account/project context does not transfer focus into its corresponding model field.')
  const active = f(editor, 'provider'); editor.destroy(); active.value = 'destroyed writer'; active.dispatch('input')
  assert.equal(editor.getDraft(), null); assert.equal(changes, 0)
})

test('advanced imports remain visible and exact, replacement of unsupported model shapes is explicit, and all user text stays literal', () => {
  const spec = newExperimentDraft(genericStarter(), { initializePopulation: true })
  spec.conditions[0].label = '<img src=x onerror=fail()>'
  spec.conditions[0].adapter = { kind: 'module', path: 'collect.mjs', customLegacy: { retained: ['unchanged'] } }
  const context = contextFor(spec), editor = mount(context), initial = editor.getDraft()
  assert.match(f(editor, 'advanced').textContent, /advanced configuration/)
  assert.equal(f(editor, 'profile'), null); assert.equal(f(editor, 'provider'), null)
  assert.match(editor.el.textContent, /customLegacy/)
  assert.equal(editor.el.querySelectorAll('img').length, 0); assert.equal(editor.el.querySelectorAll('script').length, 0)
  assert.deepEqual(editor.getDraft(), initial)
  const advancedLabelSpec = structuredClone(spec); advancedLabelSpec.conditions[0].label = null
  const advancedLabelContext = contextFor(advancedLabelSpec)
  editor.setContext({ context: advancedLabelContext, draft: createConditionFieldsDraft(advancedLabelContext), contextKey: 'advanced-label' })
  assert.equal(f(editor, 'label'), null); assert.equal(f(editor, 'label-present'), null)
  assert.match(editor.el.textContent, /advanced display label is retained exactly/)
  assert.equal(advancedLabelContext.protocolFields.conditions[0].label, null)
  const retainedSpec = newExperimentDraft(genericStarter(), { initializePopulation: true })
  retainedSpec.conditions[0].model.settings = ['legacy', false, 0]
  const retainedContext = contextFor(retainedSpec)
  editor.setContext({ context: retainedContext, draft: createConditionFieldsDraft(retainedContext), contextKey: 'legacy-settings' })
  assert.equal(editor.getDraft().rows[0].model.mode, 'retain'); assert.equal(f(editor, 'add-setting'), null)
  assert.match(editor.el.textContent, /legacy/)
  click(editor, 'model-edit')
  assert.equal(editor.getDraft().rows[0].model.mode, 'fields')
  assert.equal(f(editor, 'provider').value, ''); assert.equal(f(editor, 'model-id').value, '')
  assert.equal(editor.getDraft().rows[0].model.settingsPresent, false)
  assert.deepEqual(retainedSpec.conditions[0].model.settings, ['legacy', false, 0])
})

test('component events do not bubble, helper refusal preserves the draft, and callback mutation cannot change private state', () => {
  const context = contextFor(); let changes = 0, inputs = 0, clicks = 0
  const outer = document.createElement('div'); document.body.append(outer)
  outer.addEventListener('input', () => { inputs++ }); outer.addEventListener('click', () => { clicks++ })
  const editor = mount(context, { onChange(draft) { changes++; draft.rows[0].model.identity.provider.text = 'callback mutation' } }); outer.append(editor.el)
  fill(editor, 'provider', 'requested-provider'); assert.equal(changes, 1)
  assert.equal(editor.getDraft().rows[0].model.identity.provider.text, 'requested-provider')
  fill(editor, 'new-id', 'INVALID ID'); fill(editor, 'new-profile', 'http')
  const before = canonical(editor.getDraft()); click(editor, 'add')
  assert.match(f(editor, 'error').textContent, /lowercase condition ID/)
  assert.equal(canonical(editor.getDraft()), before); assert.equal(changes, 1)
  assert.equal(f(editor, 'new-id').value, 'INVALID ID')
  assert.equal(inputs, 0); assert.equal(clicks, 0)
})
