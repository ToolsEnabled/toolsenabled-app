import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createCompositionFieldsEditor } from '../../src/research-composition-fields.js'
import { compositionFieldInventory, createCompositionFieldDraft, compileCompositionFields } from '../../src/benchmark/corpus.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'

let installed
const views = [], copy = value => structuredClone(value)
const get = (view, name) => view.el.querySelector('[data-composition-fields-' + name + ']')
const fill = (view, name, value) => {
  const input = get(view, name); assert.ok(input, name); assert.equal(input.disabled, false)
  if (input.type === 'checkbox') input.checked = value; else input.value = value
  input.dispatch('input'); return input
}
const click = (view, name) => { const input = get(view, name); assert.ok(input, name); assert.equal(input.disabled, false); input.click() }
const parameter = (view, name, choice = 0) => {
  const el = view.el.querySelectorAll('[data-composition-fields-choice]')[choice]
    .querySelector('[data-composition-fields-parameter-name="' + name + '"]')
  assert.ok(el, name); return { el }
}
const mount = (inventory, draft, onChange) => {
  const view = createCompositionFieldsEditor({ onChange }); views.push(view); document.body.append(view.el); view.setContext(inventory, draft); return view
}
beforeEach(() => { installed = installDomStandIn(globalThis) })
afterEach(() => { for (const view of views.splice(0)) { view.destroy(); view.el.remove() } installed.restore() })

// Hand-authored UI contract data deliberately repeats the same bundle in two
// siblings. No compiler or observer supplies the expected editing behavior.
function fixture() {
  const value = (kind, text, present = true) => ({ kind, text, present })
  const parameters = { threshold: value('number', '0'), flag: value('boolean', 'false'), note: value('string', ''),
    optional: value('number', '', false), excluded: value('string', 'keep this text', false), mode: value('number', '0') }
  const parameterSchema = { threshold: { type: 'number', minimum: 0, maximum: 100 }, flag: { type: 'boolean' },
    note: { type: 'string' }, optional: { type: 'number', required: false }, excluded: { type: 'string', required: false }, mode: { type: 'number', enum: [0, 1] } }
  const atom = path => ({ key: JSON.stringify(path), path, pathLabel: ['root', ...path].join('/'), requiredRole: 'entry', kind: 'atom',
    current: { bundleId: 'entry-a', parameters: copy(parameters) }, compatible: [
      { bundleId: 'entry-a', label: 'Entry A', parameters: copy(parameters), parameterSchema: copy(parameterSchema), slotOrder: [] },
      { bundleId: 'entry-b', label: 'Entry B', parameters: { replacement: value('number', '9') }, parameterSchema: { replacement: { type: 'number', required: true } }, slotOrder: [] },
    ] })
  const root = { key: '[]', path: [], pathLabel: 'root', requiredRole: 'Template', kind: 'template', current: { bundleId: 'pair', parameters: {} },
    compatible: [
      { bundleId: 'pair', label: 'Left then right', parameters: {}, parameterSchema: {}, slotOrder: ['left', 'right'] },
      { bundleId: 'reverse-pair', label: 'Right then left', parameters: {}, parameterSchema: {}, slotOrder: ['right', 'left'] },
    ] }
  const inventory = { version: 1, bindingSha256: 'a'.repeat(64), taskId: 'nested', taskName: 'Two independently varied entries', domain: 'generic',
    familyId: 'nested-family', split: 'development', seed: 42, rows: [root, atom(['left', 'entry']), atom(['right', 'entry'])],
    blocking: [], limits: { candidates: 4096, axes: 128, selection: 512 } }
  const draft = { version: 1, bindingSha256: inventory.bindingSha256, taskId: inventory.taskId, familyId: inventory.familyId, split: inventory.split,
    rationale: '', seed: '42', selection: { kind: 'all', limit: '512' }, coverage: { kind: 'marginal', minimum: '1' },
    expectedPolicy: { kind: '', rationale: '' }, occurrences: inventory.rows.map((row, index) => ({ key: row.key, path: copy(row.path),
      axisId: 'node-' + String(index + 1).padStart(4, '0'), enabled: false,
      choices: [{ id: 'current', bundleId: row.current.bundleId, parameters: copy(row.current.parameters) }] })) }
  return { inventory, draft }
}

test('same-bundle siblings remain independently editable and occurrence navigation is view-only', () => {
  const { inventory, draft } = fixture(), original = copy(draft), changes = [], view = mount(inventory, draft, value => changes.push(value))
  fill(view, 'occurrence', inventory.rows[1].key)
  assert.equal(changes.length, 0)
  fill(view, 'enabled', true); fill(view, 'axis-id', 'left-entry')
  click(view, 'add-choice')
  fill(parameter(view, 'threshold', 1), 'parameter-value', '12')
  const left = view.getDraft().occurrences[1], count = changes.length
  assert.deepEqual(left.choices.map(choice => choice.parameters.threshold.text), ['0', '12'])
  fill(view, 'occurrence', inventory.rows[2].key)
  assert.equal(changes.length, count, 'Selecting an occurrence does not make the saved draft pending.')
  assert.equal(get(view, 'enabled').checked, false)
  assert.equal(get(parameter(view, 'threshold'), 'parameter-value').value, '0')
  assert.equal(view.getDraft().occurrences[2].choices.length, 1)
  fill(parameter(view, 'flag'), 'parameter-value', 'true')
  assert.deepEqual(view.getDraft().occurrences[1], left)
  assert.equal(view.getDraft().occurrences[2].choices[0].parameters.flag.text, 'true')
  assert.deepEqual(draft, original, 'Caller data is never mutated.')
  changes.at(-1).occurrences[1].choices[0].parameters.threshold.text = '999'
  assert.equal(view.getDraft().occurrences[1].choices[0].parameters.threshold.text, '0', 'onChange receives a private copy.')
  fill(view, 'occurrence', inventory.rows[1].key)
  assert.match(get(view, 'status').textContent, /1 enabled factors/)
  assert.equal(get(view, 'axis-id').value, 'left-entry')
})

test('zero, false, empty strings and omitted parameters stay distinct; typing retains raw text and focus', () => {
  const { inventory, draft } = fixture(), view = mount(inventory, draft)
  fill(view, 'occurrence', inventory.rows[1].key)
  assert.equal(get(parameter(view, 'threshold'), 'parameter-value').value, '0')
  assert.equal(get(parameter(view, 'flag'), 'parameter-value').value, 'false')
  assert.equal(get(parameter(view, 'note'), 'parameter-value').value, '')
  assert.equal(get(parameter(view, 'note'), 'parameter-include').checked, true)
  assert.equal(get(parameter(view, 'optional'), 'parameter-include').checked, false)
  fill(parameter(view, 'optional'), 'parameter-value', '0')
  assert.equal(get(parameter(view, 'optional'), 'parameter-include').checked, true)
  fill(parameter(view, 'threshold'), 'parameter-include', false)
  assert.equal(get(parameter(view, 'threshold'), 'parameter-value').disabled, false, 'Omitted values remain editable.')
  const input = get(parameter(view, 'threshold'), 'parameter-value'); input.focus()
  input.value = '1e'; input.dispatch('input')
  assert.equal(document.activeElement, input)
  assert.equal(get(parameter(view, 'threshold'), 'parameter-value'), input, 'Scalar typing does not replace the form.')
  assert.equal(get(parameter(view, 'threshold'), 'parameter-include').checked, true)
  fill(parameter(view, 'flag'), 'parameter-value', 'false')
  fill(parameter(view, 'note'), 'parameter-value', '')
  fill(parameter(view, 'mode'), 'parameter-value', '1')
  const values = view.getDraft().occurrences[1].choices[0].parameters
  assert.deepEqual(values.threshold, { kind: 'number', text: '1e', present: true })
  assert.deepEqual(values.flag, { kind: 'boolean', text: 'false', present: true })
  assert.deepEqual(values.note, { kind: 'string', text: '', present: true })
  assert.deepEqual(values.optional, { kind: 'number', text: '0', present: true })
  assert.deepEqual(values.excluded, { kind: 'string', text: 'keep this text', present: false })
  assert.deepEqual(values.mode, { kind: 'number', text: '1', present: true })
  assert.match(parameter(view, 'threshold').el.textContent, /Required parameter.*Minimum 0.*Maximum 100/)
})

test('bundle changes reset only that choice local parameter map and show intentional template slot order', () => {
  const { inventory, draft } = fixture(), untouched = copy(inventory), view = mount(inventory, draft)
  fill(view, 'occurrence', inventory.rows[1].key)
  click(view, 'add-choice')
  fill({ el: view.el.querySelectorAll('[data-composition-fields-choice]')[1] }, 'bundle', 'entry-b')
  let choices = view.getDraft().occurrences[1].choices
  assert.equal(choices[0].bundleId, 'entry-a')
  assert.deepEqual(choices[1].parameters, { replacement: { kind: 'number', text: '9', present: true } })
  fill(parameter(view, 'replacement', 1), 'parameter-value', '17')
  fill({ el: view.el.querySelectorAll('[data-composition-fields-choice]')[1] }, 'bundle', 'entry-a')
  choices = view.getDraft().occurrences[1].choices
  assert.deepEqual(choices[1].parameters, draft.occurrences[1].choices[0].parameters)
  assert.deepEqual(inventory, untouched)
  fill(view, 'occurrence', inventory.rows[0].key)
  assert.match(get(view, 'slot-order').textContent, /left → right/)
  fill(view, 'bundle', 'reverse-pair')
  assert.match(get(view, 'slot-order').textContent, /right → left/)
  assert.match(get(view, 'slot-order').textContent, /changes the composition meaning/)
  assert.deepEqual(view.getDraft().occurrences.slice(1), [
    { ...draft.occurrences[1], choices }, draft.occurrences[2],
  ])
})

test('unfinished and stale drafts survive null context, remount and missing occurrences without automatic reset', () => {
  const { inventory, draft } = fixture(), changes = [], view = mount(null, draft, value => changes.push(value))
  assert.match(get(view, 'status').textContent, /Prepare composition fields/)
  assert.deepEqual(view.getDraft(), draft)
  view.setContext(inventory)
  fill(view, 'seed', 'not decided'); fill(view, 'occurrence', inventory.rows[1].key)
  fill(parameter(view, 'threshold'), 'parameter-value', '-')
  const retained = view.getDraft(), count = changes.length
  view.setContext({ ...inventory, bindingSha256: 'b'.repeat(64), rows: [inventory.rows[0], inventory.rows[2]] })
  assert.match(get(view, 'status').textContent, /fields are stale/)
  assert.match(view.el.textContent, /retained occurrence is absent/)
  assert.deepEqual(view.getDraft(), retained)
  view.setContext(null)
  assert.deepEqual(view.getDraft(), retained)
  view.setContext(inventory)
  assert.equal(get(parameter(view, 'threshold'), 'parameter-value').value, '-')
  assert.equal(changes.length, count)
  const remounted = mount(inventory, retained)
  assert.equal(get(remounted, 'seed').value, 'not decided')
  fill(remounted, 'occurrence', inventory.rows[1].key)
  assert.equal(get(parameter(remounted, 'threshold'), 'parameter-value').value, '-')
  view.setContext({ ...inventory, taskId: 'different-task' })
  assert.match(get(view, 'status').textContent, /fields are stale/)
})

test('ordinary policy controls retain explicit investigator choices and focus across an echoed context', () => {
  const { inventory, draft } = fixture(), view = mount(inventory, draft)
  assert.equal(get(view, 'expected-policy').value, '', 'A generic answer policy is not silently chosen.')
  const edits = [['family', 'independent-entries'], ['split', 'held-out'], ['rationale', 'Cover each sibling independently.'], ['seed', '3e'],
    ['selection-kind', 'balanced'], ['selection-limit', 'unfinished'], ['coverage-kind', 'pairwise'], ['coverage-minimum', '2'],
    ['expected-policy', 'reuse-base'], ['expected-rationale', 'These declared variants preserve the original observable answer.']]
  for (const [name, value] of edits) fill(view, name, value)
  const retained = view.getDraft()
  assert.equal(retained.familyId, 'independent-entries'); assert.equal(retained.split, 'held-out'); assert.equal(retained.seed, '3e')
  assert.deepEqual(retained.selection, { kind: 'balanced', limit: 'unfinished' })
  assert.deepEqual(retained.coverage, { kind: 'pairwise', minimum: '2' })
  assert.deepEqual(retained.expectedPolicy, { kind: 'reuse-base', rationale: edits.at(-1)[1] })
  const seed = get(view, 'seed'); seed.focus()
  view.setContext(inventory, retained)
  assert.equal(document.activeElement, get(view, 'seed'))
  assert.equal(get(view, 'seed').value, '3e')
  assert.ok(view.el.querySelectorAll('textarea').every(node => !node.value.includes('"occurrences"')))
  const lean = mount({ ...inventory, domain: 'lean-bench' }, { ...draft, expectedPolicy: { kind: 'derive-lean', rationale: '' } })
  assert.equal(get(lean, 'expected-policy').children.length, 1)
  assert.match(lean.el.textContent, /shared domain compiler derives observations/)
})

test('disabled and destroyed components cannot mutate retained drafts or emit edits', () => {
  const { inventory, draft } = fixture(), changes = [], view = mount(inventory, draft, value => changes.push(value))
  fill(view, 'occurrence', inventory.rows[1].key)
  const retained = view.getDraft(), seed = get(view, 'seed'), checkbox = get(view, 'enabled'), add = get(view, 'add-choice')
  view.setDisabled(true)
  for (const tag of ['input', 'textarea', 'select', 'button']) assert.ok(view.el.querySelectorAll(tag).every(node => node.disabled))
  seed.value = '25'; seed.dispatch('input'); checkbox.checked = true; checkbox.dispatch('input'); add.click()
  assert.deepEqual(view.getDraft(), retained); assert.equal(changes.length, 0)
  view.setContext(inventory, retained)
  assert.equal(get(view, 'seed').disabled, true)
  view.setDisabled(false); fill(view, 'seed', '7')
  assert.equal(view.getDraft().seed, '7'); assert.equal(changes.length, 1)
  const liveInput = get(view, 'seed')
  view.destroy(); liveInput.value = '9'; liveInput.dispatch('input'); view.setContext(inventory, draft)
  assert.equal(view.getDraft().seed, '7'); assert.equal(changes.length, 1); assert.equal(view.el.children.length, 0)
})

test('the editor retains the complete roster beyond compilation limits and can repair an empty choice list', () => {
  const { inventory, draft } = fixture()
  inventory.rows = Array.from({ length: 513 }, (_, index) => ({ ...copy(inventory.rows[1]), key: String(index), pathLabel: 'root/branch-' + index }))
  inventory.blocking = [{ code: 'too-many-occurrences', message: 'This composition exceeds the supported field compilation limit.' }]
  draft.occurrences = inventory.rows.map((row, index) => ({ ...copy(draft.occurrences[1]), key: row.key, axisId: 'node-' + index }))
  draft.occurrences[512].choices = []
  const view = mount(inventory, draft)
  assert.equal(get(view, 'occurrence').children.length, 513)
  assert.equal(view.getDraft().occurrences.length, 513)
  assert.match(get(view, 'blocking').textContent, /exceeds the supported/)
  fill(view, 'occurrence', '512')
  assert.match(view.el.textContent, /factor has no choices/)
  click(view, 'add-choice')
  assert.equal(view.getDraft().occurrences[512].choices.length, 1)
  assert.equal(view.getDraft().occurrences[512].choices[0].id, 'choice-1')
  click(view, 'remove-choice')
  assert.deepEqual(view.getDraft().occurrences[512].choices, [])
})

test('actual portable inventory and field draft compile mounted typed choices without changing the declared answer', async () => {
  const spec = genericStarter(), atom = spec.catalog.find(bundle => bundle.id === 'task')
  atom.parameters = { a: 2, b: 3, flag: false, note: '' }
  atom.parameterSchema = { a: { type: 'integer', minimum: 0, maximum: 20 }, b: { type: 'integer' },
    flag: { type: 'boolean' }, note: { type: 'string' }, optional: { type: 'integer', required: false } }
  const inventory = await compositionFieldInventory(spec, 'addition-a'), draft = createCompositionFieldDraft(inventory), view = mount(inventory, draft)
  assert.equal(inventory.rows.length, 2)
  assert.equal(get(view, 'occurrence').children.length, 2)
  assert.equal(get(view, 'expected-policy').value, '')
  fill(view, 'rationale', 'Compare two supplied local operand settings while retaining the surrounding instruction.')
  fill(view, 'expected-policy', 'reuse-base')
  fill(view, 'expected-rationale', 'The supplied alternatives are 2 + 3 and 0 + 5; both have the declared answer 5.')
  fill(view, 'occurrence', inventory.rows.find(row => row.pathLabel === 'root/task').key)
  fill(view, 'enabled', true); click(view, 'add-choice')
  fill(parameter(view, 'a', 1), 'parameter-value', '0')
  fill(parameter(view, 'b', 1), 'parameter-value', '5')
  assert.match(parameter(view, 'a', 1).el.textContent, /Required parameter.*Minimum 0.*Maximum 20/)
  assert.equal(get(parameter(view, 'optional', 1), 'parameter-include').checked, false)
  const compiled = await compileCompositionFields(spec, view.getDraft()), axis = compiled.plan.families[0].axes[0]
  assert.deepEqual(compiled.construction.axisPaths, [{ axisId: draft.occurrences[1].axisId, path: ['task'], choices: ['current', 'choice-1'] }])
  assert.equal(compiled.construction.requestedAssignments, 2)
  assert.deepEqual(axis.choices[1].edits, [{ kind: 'node', path: ['task'], value: { use: 'task', params: { a: 0, b: 5, flag: false, note: '' } } }])
  assert.equal(compiled.plan.families[0].task.expected, '5')
  fill(parameter(view, 'a', 1), 'parameter-value', '1e')
  await assert.rejects(compileCompositionFields(spec, view.getDraft()), /Finish the numeric value for a/)
  assert.equal(get(parameter(view, 'a', 1), 'parameter-value').value, '1e')
})
