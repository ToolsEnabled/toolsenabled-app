import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createCompositionFieldsEditor } from '../../src/research-composition-fields.js'
import { compositionFieldInventory, createCompositionFieldDraft, compileCompositionFields } from '../../src/benchmark/corpus.mjs'
import { operationalStarter } from '../../src/benchmark/trading-catalog.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { materializeCorpus } from '../../src/benchmark/study.mjs'
import { requirementFieldInventory } from '../../src/benchmark/requirement-fields.mjs'
import { compilePrompt } from '../../src/benchmark/prompts.mjs'

let installed
const views = [], copy = value => structuredClone(value)
const get = (scope, name) => scope.el.querySelector('[data-composition-fields-' + name + ']')
const fill = (scope, name, value) => {
  const input = get(scope, name); assert.ok(input, name); assert.equal(input.disabled, false)
  if (input.type === 'checkbox') input.checked = value; else input.value = value
  input.dispatch('input'); return input
}
const click = (scope, name) => { const button = get(scope, name); assert.ok(button, name); assert.equal(button.disabled, false); button.click() }
const choice = (view, index = 0) => ({ el: view.el.querySelectorAll('[data-composition-fields-choice]')[index] })
const node = (view, path = [], index = 0) => {
  const el = choice(view, index).el.querySelectorAll('[data-composition-fields-structural-node]')
    .find(row => row.getAttribute('data-composition-fields-node-path') === JSON.stringify(path))
  assert.ok(el, 'Missing structural node ' + index + '/' + path.join('/')); return { el }
}
const parameter = (scope, name) => {
  const el = scope.el.querySelector('[data-composition-fields-parameter-name="' + name + '"]'); assert.ok(el, name); return { el }
}
const mount = (inventory, draft, onChange) => {
  const view = createCompositionFieldsEditor({ onChange }); views.push(view); document.body.append(view.el); view.setContext(inventory, draft); return view
}
beforeEach(() => { installed = installDomStandIn(globalThis) })
afterEach(() => { for (const view of views.splice(0)) { view.destroy(); view.el.remove() } installed.restore() })

function genericFixture() {
  const spec = genericStarter()
  spec.catalog = [
    { id: 'pair', version: '1', role: 'node', kind: 'template', text: '{{slot:left}} then {{slot:right}}', slots: { left: '*', right: 'node' },
      slotOrder: ['left', 'right'], parameters: { label: 'base' }, semantics: { kind: 'pair', label: '{{label}}' } },
    { id: 'triple', version: '1', role: 'node', kind: 'template', text: '{{slot:left}} {{slot:right}} {{slot:extra}}', slots: { left: '*', right: 'node', extra: 'metric' },
      slotOrder: ['left', 'right', 'extra'], parameters: { label: 'triple' }, semantics: { kind: 'triple' } },
    { id: 'other-triple', version: '1', role: 'node', kind: 'template', text: '{{slot:left}} {{slot:right}} {{slot:extra}}', slots: { left: '*', right: 'node', extra: 'node' },
      slotOrder: ['extra', 'right', 'left'], parameters: {}, semantics: { kind: 'other-triple' } },
    { id: 'box', version: '1', role: 'node', kind: 'template', text: '({{slot:item}})', slots: { item: 'node' }, parameters: {}, semantics: { kind: 'box' } },
    { id: 'metric', version: '1', role: 'metric', kind: 'atom', text: 'metric', parameters: {}, semantics: { kind: 'metric' } },
    { id: 'scalars', version: '1', role: 'node', kind: 'atom', text: '{{amount}} {{enabled}} [{{label}}]', parameters: { amount: 0, enabled: false, label: '' },
      parameterSchema: { amount: { type: 'integer', minimum: 0 }, enabled: { type: 'boolean' }, label: { type: 'string' }, optional: { type: 'number', required: false } },
      semantics: { kind: 'scalars', amount: '{{amount}}', enabled: '{{enabled}}', label: '{{label}}' } },
  ]
  spec.tasks = [{ id: 'typed', split: 'development', root: { use: 'pair', params: { label: 'authored root' }, slots: { left: { use: 'metric' }, right: { use: 'scalars' } } }, input: null, expected: null }]
  spec.protocol.grading = { kind: 'json' }
  return spec
}
async function setup(spec = genericFixture(), onChange) {
  const inventory = await compositionFieldInventory(spec, spec.tasks[0].id), draft = createCompositionFieldDraft(inventory)
  draft.rationale = 'Explicit synthetic topology controls; this is construction evidence only.'
  draft.expectedPolicy = { kind: spec.domain === 'lean-bench' ? 'derive-lean' : 'reuse-base', rationale: 'The declared fixture output is retained solely for this construction control; qualification remains separate.' }
  return { spec, inventory, draft, view: mount(inventory, draft, onChange) }
}

test('ordinary root choices generate 2, 3 and 4 explicitly filled operational children with all 66 control obligations', async () => {
  const { spec, view } = await setup(await operationalStarter())
  fill(view, 'enabled', true)
  fill(choice(view), 'choice-kind', 'subtree')
  assert.deepEqual(view.getDraft().occurrences[0].choices[0].subtree.slots, {
    child1: { kind: 'copy', path: ['child1'] }, child2: { kind: 'copy', path: ['child2'] },
  })
  for (const arity of [3, 4]) {
    click(view, 'add-choice')
    const index = arity - 2
    fill(choice(view, index), 'choice-id', 'children-' + arity)
    fill(choice(view, index), 'choice-kind', 'subtree')
    fill(node(view, [], index), 'node-bundle', 'op-all-' + arity)
    for (let child = 3; child <= arity; child++) {
      const path = ['child' + child]
      assert.equal(get(node(view, path, index), 'node-kind').value, 'unfilled')
      await assert.rejects(compileCompositionFields(spec, view.getDraft()), /unfilled|Fill every/i)
      fill(node(view, path, index), 'node-kind', 'copy')
      assert.equal(get(node(view, path, index), 'copy-path').value, '', 'Copy mode chooses no branch automatically.')
      fill(node(view, path, index), 'copy-path', JSON.stringify(['child1']))
    }
  }
  const result = await compileCompositionFields(spec, view.getDraft()), generated = await materializeCorpus({ ...spec, corpusPlan: result.plan })
  assert.equal(generated.manifest.status, 'ready'); assert.equal(generated.tasks.length, 3)
  const nodeCounts = []
  for (const task of generated.tasks) nodeCounts.push((await compilePrompt(spec.catalog, task.root)).nodeCount)
  assert.deepEqual(nodeCounts, [17, 22, 27])
  const requirements = await requirementFieldInventory({ ...spec, tasks: generated.tasks, corpusPlan: result.plan })
  assert.equal(requirements.rows.length, 66); assert.equal(requirements.rows.length * 4, 264); assert.equal(requirements.appendices.length, 3)
  assert.deepEqual(requirements.blocking, [])
  assert.equal(generated.manifest.oracle.independentQualificationRequired, true)
  assert.equal(generated.tasks[2].root.slots.child3.use, 'op-strategy')
  assert.notEqual(generated.tasks[2].root.slots.child1, generated.tasks[2].root.slots.child3, 'Copies have separate mutable ownership.')
})

test('recursive Build requires explicit bundle and child choices, retains typed values and filters actual source roles', async () => {
  const { spec, inventory, view } = await setup()
  assert.equal(inventory.rows.find(row => row.pathLabel === 'root/left').requiredRole, '*')
  assert.equal(inventory.rows.find(row => row.pathLabel === 'root/left').role, 'metric')
  fill(view, 'enabled', true); fill(choice(view), 'choice-kind', 'subtree')
  assert.equal(view.getDraft().occurrences[0].choices[0].subtree.parameters.label.text, 'authored root')
  fill(node(view, ['right']), 'node-kind', 'bundle')
  assert.equal(get(node(view, ['right']), 'node-bundle').value, '')
  assert.ok(!get(node(view, ['right']), 'node-bundle').children.some(option => option.value === 'metric'))
  fill(node(view, ['right']), 'node-bundle', 'box')
  assert.equal(get(node(view, ['right', 'item']), 'node-kind').value, 'unfilled')
  fill(node(view, ['right', 'item']), 'node-kind', 'copy')
  assert.ok(!get(node(view, ['right', 'item']), 'copy-path').children.some(option => option.value === JSON.stringify(['left'])), 'A wildcard source parent cannot make its metric child satisfy a node destination.')
  fill(node(view, ['right', 'item']), 'node-kind', 'bundle')
  fill(node(view, ['right', 'item']), 'node-bundle', 'scalars')
  const scope = node(view, ['right', 'item'])
  fill(parameter(scope, 'amount'), 'parameter-value', '0')
  fill(parameter(scope, 'enabled'), 'parameter-value', 'false')
  fill(parameter(scope, 'label'), 'parameter-value', '')
  assert.equal(get(parameter(scope, 'optional'), 'parameter-include').checked, false)
  assert.match(parameter(scope, 'optional').el.textContent, /Omit local override.*bundle default or task variable may still apply/)
  const result = await compileCompositionFields(spec, view.getDraft()), params = result.plan.families[0].axes[0].choices[0].edits[0].value.slots.right.slots.item.params
  assert.deepEqual(params, { amount: 0, enabled: false, label: '' })
  const input = get(parameter(scope, 'amount'), 'parameter-value'); input.focus(); input.value = '1e'; input.dispatch('input')
  assert.equal(document.activeElement, input)
  assert.equal(get(parameter(node(view, ['right', 'item']), 'amount'), 'parameter-value'), input)
  await assert.rejects(compileCompositionFields(spec, view.getDraft()), /Finish the numeric value/)
})

test('bundle changes preserve only matching slot names and roles and incompatible conversion cannot discard children', async () => {
  const changes = [], { view } = await setup(undefined, value => changes.push(value))
  fill(choice(view), 'choice-kind', 'subtree')
  let original = view.getDraft().occurrences[0].choices[0]
  fill(choice(view), 'choice-kind', 'local')
  assert.equal(view.getDraft().occurrences[0].choices[0].parameters.label.text, 'authored root')
  fill(choice(view), 'choice-kind', 'subtree')
  assert.deepEqual(view.getDraft().occurrences[0].choices[0], original)
  fill(node(view), 'node-bundle', 'triple')
  assert.equal(get(node(view, ['extra']), 'node-kind').value, 'unfilled')
  fill(node(view, ['extra']), 'node-kind', 'copy'); fill(node(view, ['extra']), 'copy-path', JSON.stringify(['left']))
  const authored = view.getDraft(), count = changes.length
  assert.equal(get(choice(view), 'choice-kind').children.find(option => option.value === 'local').disabled, true)
  assert.match(get(choice(view), 'conversion-status').textContent, /cannot discard authored children/)
  fill(choice(view), 'choice-kind', 'local')
  assert.equal(changes.length, count); assert.deepEqual(view.getDraft(), authored)
  fill(node(view), 'node-bundle', 'other-triple')
  const branch = view.getDraft().occurrences[0].choices[0].subtree
  assert.deepEqual(branch.slots.left, { kind: 'copy', path: ['left'] })
  assert.deepEqual(branch.slots.right, { kind: 'copy', path: ['right'] })
  assert.deepEqual(branch.slots.extra, { kind: 'unfilled' }, 'Changing the incoming role invalidates the existing child choice.')
  assert.match(get(node(view), 'slot-order').textContent, /extra → right → left/)
  fill(node(view), 'node-bundle', '')
  assert.equal(get(node(view), 'node-bundle').value, '')
  assert.deepEqual(view.getDraft().occurrences[0].choices[0].subtree.slots, branch.slots)
})

test('unfinished topology and unavailable copies survive stale/null contexts and remount without navigation edits', async () => {
  const changes = [], { spec, inventory, view } = await setup(undefined, value => changes.push(value))
  fill(view, 'enabled', true); fill(choice(view), 'choice-kind', 'subtree')
  fill(node(view), 'node-bundle', 'triple')
  fill(node(view, ['extra']), 'node-kind', 'copy')
  const retained = view.getDraft(), count = changes.length
  assert.equal(retained.occurrences[0].choices[0].subtree.slots.extra.path, null)
  view.setContext(null); assert.deepEqual(view.getDraft(), retained)
  view.setContext({ ...inventory, bindingSha256: 'f'.repeat(64) })
  assert.match(get(view, 'status').textContent, /fields are stale/)
  assert.deepEqual(view.getDraft(), retained)
  fill(view, 'occurrence', inventory.rows[1].key); fill(view, 'occurrence', inventory.rows[0].key)
  assert.equal(changes.length, count)
  const remounted = mount(inventory, retained)
  assert.equal(get(node(remounted, ['extra']), 'copy-path').value, '')
  const changedSpec = copy(spec); changedSpec.tasks[0].input = { changed: true }
  await assert.rejects(compileCompositionFields(changedSpec, retained), /stale/)
  const unavailable = copy(retained); unavailable.occurrences[0].choices[0].subtree.slots.extra.path = ['missing']
  remounted.setContext(inventory, unavailable)
  assert.equal(get(node(remounted, ['extra']), 'copy-path').value, JSON.stringify(['missing']))
  await assert.rejects(compileCompositionFields(spec, unavailable), /The copied branch path is not in the selected source task/)
  remounted.setDisabled(true)
  const before = remounted.getDraft(), kind = get(node(remounted, ['extra']), 'node-kind')
  kind.value = 'bundle'; kind.dispatch('input')
  assert.deepEqual(remounted.getDraft(), before)
  assert.ok(remounted.el.querySelectorAll('select').every(input => input.disabled))
})

test('deep structural draft rendering introduces no depth-64 cutoff and retains every explicit branch', async () => {
  const { spec, inventory, draft } = await setup()
  let branch = { kind: 'bundle', bundleId: 'scalars', parameters: copy(inventory.bundles.find(bundle => bundle.bundleId === 'scalars').parameters), slots: {} }
  for (let depth = 0; depth < 80; depth++) branch = { kind: 'bundle', bundleId: 'box', parameters: {}, slots: { item: branch } }
  draft.occurrences[0].enabled = true; draft.occurrences[0].choices = [{ id: 'deep', subtree: branch }]
  const view = mount(inventory, draft)
  assert.equal(view.el.querySelectorAll('[data-composition-fields-structural-node]').length, 81)
  const result = await compileCompositionFields(spec, view.getDraft())
  const compiled = await compilePrompt(spec.catalog, result.plan.families[0].axes[0].choices[0].edits[0].value)
  assert.equal(compiled.nodeCount, 81); assert.equal(compiled.depth, 80)
  fill(parameter(node(view, Array(80).fill('item')), 'label'), 'parameter-value', 'retained deepest value')
  assert.equal(get(parameter(node(view, Array(80).fill('item')), 'label'), 'parameter-value').value, 'retained deepest value')
})
