import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createRequirementFieldsEditor } from '../../src/research-requirement-fields.js'
import { requirementFieldInventory, createRequirementFieldDraft, compileRequirementFields } from '../../src/benchmark/requirement-fields.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { nestedRequirementFieldFixture } from './fixtures/research-benchmark-requirement-fields.mjs'

let installed
const views = [], get = (view, name) => view.el.querySelector('[data-requirement-fields-' + name + ']')
const fill = (view, name, value) => { const field = get(view, name); assert.ok(field, name); assert.equal(field.disabled, false); field.value = value; field.dispatch('input') }
const click = (view, name) => { const field = get(view, name); assert.equal(field.disabled, false); field.click() }
const mount = (inventory, draft, onChange) => { const view = createRequirementFieldsEditor({ onChange }); views.push(view); document.body.append(view.el); view.setContext(inventory, draft); return view }
beforeEach(() => { installed = installDomStandIn(globalThis) })
afterEach(() => { for (const view of views.splice(0)) { view.destroy(); view.el.remove() } installed.restore() })

test('null and stale inventory preserve unfinished investigator fields across component remounts', async () => {
  const { inventory, draft } = await nestedRequirementFieldFixture(), changes = []
  let view = mount(null, draft, value => changes.push(value))
  assert.match(view.el.textContent, /Prepare requirement fields/)
  assert.deepEqual(view.getDraft(), draft)
  view.setContext(inventory)
  fill(view, 'timeout', 'not decided yet')
  fill(view, 'target-rationale', 'A retained unfinished explanation.')
  const retained = view.getDraft()
  assert.equal(retained.timeoutMs, 'not decided yet')
  view.setContext({ ...inventory, bindingSha256: 'b'.repeat(64) })
  assert.match(get(view, 'status').textContent, /fields are stale/)
  assert.deepEqual(view.getDraft(), retained)
  view.setContext(null)
  assert.deepEqual(view.getDraft(), retained)
  view = mount(inventory, retained)
  assert.equal(get(view, 'timeout').value, 'not decided yet')
  assert.equal(get(view, 'target-rationale').value, 'A retained unfinished explanation.')
  assert.equal(changes.length, 2)
  const changed = mount(inventory, retained, value => changes.push(value))
  fill(changed, 'target', inventory.rows[3].key)
  assert.equal(changes.length, 2, 'Navigating occurrences is not a pending field edit.')
})

test('ordinary fields add independent assertions and typed local alternatives without an opaque JSON editor', async () => {
  const { inventory } = await nestedRequirementFieldFixture(), draft = createRequirementFieldDraft(inventory), view = mount(inventory, draft)
  assert.equal(get(view, 'target').children.length, 17)
  assert.equal(get(view, 'assertion'), null)
  assert.equal(get(view, 'alternative'), null)
  fill(view, 'target', inventory.rows[2].key)
  fill(view, 'activation', 'counter:true')
  click(view, 'add-assertion')
  fill(view, 'assertion-path', JSON.stringify(['orders', 0, 'quantity']))
  const assertion = get(view, 'assertion'), input = assertion.querySelector('[data-requirement-fields-value-text]')
  assert.equal(input.value, '', 'The platform does not prefill an expected truth value.')
  input.value = '4'; input.dispatch('input')
  click(view, 'add-alternative')
  fill(view, 'parameter', 'threshold')
  const alternative = get(view, 'alternative'), alternativeValue = alternative.querySelector('[data-requirement-fields-value-text]')
  alternativeValue.value = '11000'; alternativeValue.dispatch('input')
  fill(view, 'alternative-rationale', 'An alternative threshold blocks this entry on the supplied prices.')
  const target = view.getDraft().targets[2]
  assert.deepEqual(target.activation, [{ kind: 'counter', name: 'true', minimum: '1' }])
  assert.deepEqual(target.probes[0].assertions, [{ path: ['orders', 0, 'quantity'], value: { kind: 'number', text: '4' } }])
  assert.equal(target.wrongReadings[0].value.text, '11000')
  assert.ok([...view.el.querySelectorAll('textarea')].every(node => !node.value.includes('"targets"')))
})

test('all supplied nested fields compile after mounted edits while incomplete activation and raw witness numbers block', async () => {
  const { spec, inventory, draft } = await nestedRequirementFieldFixture(), view = mount(inventory, draft)
  fill(view, 'target', inventory.rows[3].key)
  fill(view, 'activation-minimum', '2')
  const compiled = await compileRequirementFields(spec, view.getDraft())
  assert.equal(compiled.registry.targets.length, 17)
  assert.equal(compiled.plan.targets[3].activation[0].minimum, 2)
  const barsTime = view.el.querySelector('[data-requirement-fields-value-context="probe-0/input/bars/0/time"] [data-requirement-fields-value-text]')
  assert.ok(barsTime)
  barsTime.value = '1e'; barsTime.dispatch('input')
  await assert.rejects(compileRequirementFields(spec, view.getDraft()), /unfinished/)
  assert.equal(barsTime.value, '1e')
  fill(view, 'activation-minimum', '')
  await assert.rejects(compileRequirementFields(spec, view.getDraft()), /whole number/)
})

test('generic interpreter bindings use ordinary file and rationale fields and disabled editors do not mutate', async () => {
  const spec = genericStarter(); spec.tasks = [{ id: 'addition', root: { use: 'task' }, input: null, expected: '5', split: 'development' }]
  spec.inputs = [{ path: 'reference.mjs', sha256: 'a'.repeat(64) }, { path: 'independent.mjs', sha256: 'b'.repeat(64) }]
  const inventory = await requirementFieldInventory(spec), view = mount(inventory, createRequirementFieldDraft(inventory))
  fill(view, 'reference', 'reference.mjs'); fill(view, 'independent', 'independent.mjs')
  fill(view, 'interpreter-rationale', 'Different implementation algorithms and separately inspected source files.')
  fill(view, 'activation-name', 'evaluated')
  const retained = view.getDraft()
  assert.equal(retained.interpreters.reference, 'reference.mjs')
  assert.equal(retained.interpreters.independent, 'independent.mjs')
  assert.equal(retained.targets[0].activation[0].name, 'evaluated')
  view.setDisabled(true)
  get(view, 'timeout').value = '25'; get(view, 'timeout').dispatch('input')
  get(view, 'add-probe').click()
  assert.deepEqual(view.getDraft(), retained)
  assert.ok(view.el.querySelectorAll('input').every(node => node.disabled))
  view.setDisabled(false)
  assert.equal(get(view, 'timeout').disabled, false)
})
