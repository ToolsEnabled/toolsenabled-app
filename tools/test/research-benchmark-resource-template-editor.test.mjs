import assert from 'node:assert/strict'
import test, { beforeEach, afterEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createResourceTemplateEditor, defaultResourceTemplateFields } from '../../src/research-resource-template.js'

let installed
beforeEach(() => { installed = installDomStandIn(globalThis) })
afterEach(() => { installed.restore() })
const field = (editor, name) => editor.el.querySelector('[data-resource-template-' + name + ']')
const fields = (editor, name) => editor.el.querySelectorAll('[data-resource-template-' + name + ']')
const fill = (input, value) => { assert.equal(input.disabled, false); input.value = value; input.dispatch('input') }
const toggle = (input, value) => { assert.equal(input.disabled, false); input.checked = value; input.dispatch('input') }
const selectCase = (editor, index) => { const input = field(editor, 'case-select'); input.value = String(index); input.dispatch('change') }
const mount = onChange => { const editor = createResourceTemplateEditor({ onChange }); document.body.append(editor.el); return editor }

test('ordinary default fields separate visible resources, write permissions and task goals', () => {
  const editor = mount(), draft = editor.read()
  assert.equal(draft.kind, 'resource-action-plan'); assert.equal(draft.version, 1)
  assert.equal(draft.primaryCriterion, 'task-success-without-collateral-effect')
  assert.equal(draft.maxActions, '8'); assert.deepEqual(draft.cases.map(item => item.split), ['development', 'held-out'])
  assert.equal(draft.cases[0].resources.find(resource => resource.id === 'neighbor').writable, true)
  assert.equal(draft.cases[0].goals.some(goal => goal.resourceId === 'neighbor'), false)
  assert.deepEqual(draft.cases[0].resources.find(resource => resource.id === 'private-control'), {
    id: 'private-control', value: 'PRIVATE_RESOURCE_CONTROL_update-development', visible: false, writable: false,
  })
  assert.match(editor.el.textContent, /fresh bounded synthetic resource map/)
  assert.match(editor.el.textContent, /collateral/)
  assert.equal(fields(editor, 'resource-id').length, 3)
  assert.equal(fields(editor, 'goal-resource').length, 1)
  assert.ok(field(editor, 'case-instruction')); assert.ok(field(editor, 'primary-criterion'))
  assert.equal(field(editor, 'max-actions').getAttribute('type'), 'text', 'A number input would discard invalid text before Apply')
})

test('unfinished text survives edits, parent synchronization and a serialized remount without replacing the focused field', () => {
  let editor, changes = 0
  editor = mount(draft => { changes++; editor.write(JSON.parse(JSON.stringify(draft))) })
  const input = field(editor, 'max-actions')
  input.focus(); input.selectionStart = 3; input.selectionEnd = 3
  fill(input, ' 3e? ')
  assert.equal(editor.read().maxActions, ' 3e? ')
  assert.equal(field(editor, 'max-actions'), input)
  assert.equal(document.activeElement, input); assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 3)
  fill(field(editor, 'case-id'), ' incomplete case ID ')
  fill(field(editor, 'case-instruction'), 'Unfinished instruction\nwith exact spacing  ')
  fill(fields(editor, 'resource-value')[0], '  text\nvalue  ')
  fill(fields(editor, 'goal-value')[0], '  desired\nvalue  ')
  selectCase(editor, 1)
  fill(field(editor, 'case-family'), ' pending family ')
  const saved = JSON.parse(JSON.stringify(editor.read())), beforeRestore = changes
  const restored = mount(() => { changes++ }); restored.write(saved)
  assert.equal(changes, beforeRestore, 'Restoring fields must not mark the parent draft dirty')
  assert.deepEqual(restored.read(), saved)
  assert.equal(field(restored, 'max-actions').value, ' 3e? ')
  assert.equal(field(restored, 'case-id').value, ' incomplete case ID ')
  selectCase(restored, 1); assert.equal(field(restored, 'case-family').value, ' pending family ')
})

test('case and row actions change only the selected case and keep pending values in other cases', () => {
  const editor = mount()
  fill(fields(editor, 'resource-value')[0], 'first case pending value')
  field(editor, 'add-case').click()
  assert.equal(editor.read().cases.length, 3)
  assert.equal(field(editor, 'case-id').value, 'case-1')
  fill(field(editor, 'case-family'), 'independent-family')
  field(editor, 'add-resource').click(); field(editor, 'add-goal').click()
  assert.equal(fields(editor, 'resource-id').length, 4); assert.equal(fields(editor, 'goal-resource').length, 2)
  fill(fields(editor, 'resource-id')[3], 'new-target')
  fill(fields(editor, 'resource-value')[3], 'initial')
  fill(fields(editor, 'goal-resource')[1], 'new-target')
  fill(fields(editor, 'goal-value')[1], 'wanted')
  const updated = editor.read()
  assert.deepEqual(updated.cases[2].goals[1], { resourceId: 'new-target', op: 'set', value: 'wanted' })
  assert.equal(updated.cases[0].resources[0].value, 'first case pending value')
  fields(editor, 'remove-resource')[1].click(); fields(editor, 'remove-goal')[0].click()
  assert.equal(editor.read().cases[2].resources.length, 3); assert.equal(editor.read().cases[2].goals.length, 1)
  field(editor, 'remove-case').click()
  assert.equal(editor.read().cases.length, 2)
  selectCase(editor, 0); assert.equal(fields(editor, 'resource-value')[0].value, 'first case pending value')
})

test('goal choices expose only public writable resources and preserve invalid references until explicitly corrected', () => {
  const editor = mount(), goal = fields(editor, 'goal-resource')[0]
  assert.deepEqual(goal.querySelectorAll('option').map(option => option.value), ['target', 'neighbor'])
  fill(fields(editor, 'resource-id')[0], 'renamed-target')
  assert.equal(editor.read().cases[0].goals[0].resourceId, 'target')
  assert.equal(goal.value, 'target')
  assert.match(goal.querySelectorAll('option')[0].textContent, /not available/)
  fill(goal, 'renamed-target')
  toggle(fields(editor, 'resource-writable')[0], false)
  assert.equal(editor.read().cases[0].goals[0].resourceId, 'renamed-target')
  assert.match(goal.querySelectorAll('option')[0].textContent, /not available/)
  fill(goal, 'neighbor')
  fill(fields(editor, 'goal-op')[0], 'delete')
  assert.deepEqual(editor.read().cases[0].goals[0], { resourceId: 'neighbor', op: 'delete' })
  assert.equal(fields(editor, 'goal-value')[0].disabled, true)
  assert.equal(fields(editor, 'goal-value')[0].parentNode.hidden, true)
  fill(fields(editor, 'goal-op')[0], 'set')
  assert.equal(fields(editor, 'goal-value')[0].disabled, false)
  fill(fields(editor, 'goal-value')[0], 'restored goal text')
  assert.deepEqual(editor.read().cases[0].goals[0], { resourceId: 'neighbor', op: 'set', value: 'restored goal text' })
})

test('component events stay inside the editor while one cloned draft change reaches its parent callback', () => {
  let outerClicks = 0, outerInputs = 0, changes = 0
  const outer = document.createElement('div')
  outer.addEventListener('click', () => { outerClicks++ }); outer.addEventListener('input', () => { outerInputs++ })
  document.body.append(outer)
  const editor = createResourceTemplateEditor({ onChange(draft) { changes++; draft.cases[0].id = 'caller must not mutate editor' } })
  outer.append(editor.el)
  fill(field(editor, 'max-actions'), '12')
  field(editor, 'add-resource').click(); field(editor, 'add-goal').click(); field(editor, 'add-case').click()
  assert.equal(changes, 4); assert.equal(outerClicks, 0); assert.equal(outerInputs, 0)
  assert.equal(editor.read().cases[0].id, 'update-development')
  const exposed = editor.read(); exposed.cases[0].resources[0].value = 'external mutation'
  assert.equal(editor.read().cases[0].resources[0].value, 'draft')
})

test('locking prevents edits and structural changes while delete-only value fields remain disabled after unlock', () => {
  let changes = 0
  const editor = mount(() => { changes++ })
  selectCase(editor, 1)
  const original = editor.read()
  editor.setDisabled(true)
  for (const tag of ['input', 'select', 'textarea', 'button']) assert.ok(editor.el.querySelectorAll(tag).every(input => input.disabled))
  const max = field(editor, 'max-actions'); max.value = '999'; max.dispatch('input')
  field(editor, 'add-case').click()
  assert.deepEqual(editor.read(), original); assert.equal(changes, 0)
  editor.setDisabled(false)
  assert.equal(field(editor, 'case-id').disabled, false)
  assert.equal(fields(editor, 'goal-value')[0].disabled, true)
  assert.equal(fields(editor, 'goal-op')[0].disabled, false)
})

test('empty and over-limit editable rosters remain recoverable without silent truncation', () => {
  const editor = mount(), empty = defaultResourceTemplateFields(); empty.cases = []
  editor.write(empty)
  assert.deepEqual(editor.read().cases, []); assert.equal(field(editor, 'remove-case').disabled, true)
  field(editor, 'add-case').click(); assert.equal(editor.read().cases.length, 1)
  const oversized = defaultResourceTemplateFields()
  oversized.cases = Array.from({ length: 33 }, (_, index) => ({ ...structuredClone(oversized.cases[0]), id: 'case-' + index }))
  oversized.cases[0].resources = Array.from({ length: 33 }, (_, index) => ({ id: 'resource-' + index, value: 'x', visible: true, writable: true }))
  oversized.unsupportedDeclaration = 'Preserve so the compiler can reject it'
  editor.write(oversized)
  selectCase(editor, 0)
  assert.equal(editor.read().cases.length, 33); assert.equal(editor.read().cases[0].resources.length, 33)
  assert.equal(editor.read().unsupportedDeclaration, oversized.unsupportedDeclaration)
  assert.equal(field(editor, 'add-case').disabled, true); assert.equal(field(editor, 'add-resource').disabled, true)
  assert.equal(fields(editor, 'remove-resource')[0].disabled, false)
})

test('valid numeric recipes can be edited and resource text never becomes executable markup', () => {
  const editor = mount(), recipe = defaultResourceTemplateFields(); recipe.maxActions = 4
  recipe.cases[0].id = '<img src=x onerror=fail()>'
  recipe.cases[0].resources[0].id = '<script>resource</script>'
  recipe.cases[0].goals[0].resourceId = recipe.cases[0].resources[0].id
  recipe.cases[0].resources[0].value = '<b>literal value</b>'
  editor.write(recipe)
  assert.equal(editor.read().maxActions, '4')
  assert.equal(editor.el.querySelectorAll('img').length, 0); assert.equal(editor.el.querySelectorAll('script').length, 0)
  assert.equal(fields(editor, 'resource-value')[0].value, '<b>literal value</b>')
  assert.match(field(editor, 'case-select').textContent, /<img src=x onerror=fail\(\)>/)
})
