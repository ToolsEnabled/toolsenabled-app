import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { showTreeEditPicker } from '../../src/tree-edit-picker.js'

function fixture(t, options = {}) {
  const { document, restore } = installDomStandIn()
  const host = document.createElement('div'), opener = document.createElement('button')
  document.body.appendChild(host)
  host.appendChild(opener)
  opener.focus()
  const confirmed = [], cancelled = []
  const trees = Object.freeze([
    Object.freeze({ rootId: 'first', name: 'Controller tree', count: 18 }),
    Object.freeze({ rootId: 'second', name: 'Reviewer tree', count: 2 }),
    Object.freeze({ rootId: 'third', name: 'Research tree', count: 1 }),
  ])
  const controller = showTreeEditPicker({ host, trees, selectedRootIds: ['first'],
    onConfirm: ids => confirmed.push(ids), onCancel: () => cancelled.push(true), ...options })
  const backdrop = document.body.querySelector('.tree-edit-picker-backdrop')
  const dialog = backdrop.querySelector('.tree-edit-picker')
  const inputs = dialog.querySelectorAll('input')
  const confirm = dialog.querySelector('.tree-edit-picker-confirm')
  const cancel = dialog.querySelector('.tree-edit-picker-cancel')
  const selectAll = dialog.querySelector('.tree-edit-picker-select-all')
  t.after(() => { controller.close(); restore() })
  return { document, host, opener, controller, backdrop, dialog, inputs, confirm, cancel, selectAll, trees, confirmed, cancelled }
}

test('the picker exposes named trees and counts without editing its inputs or the surrounding graph', t => {
  const env = fixture(t), { dialog, inputs } = env
  assert.equal(env.backdrop.parentNode, env.document.body, 'the dialog is outside a graph containing block')
  assert.equal(env.host.children.length, 1, 'mounting does not replace the surrounding graph')
  assert.equal(dialog.getAttribute('role'), 'dialog')
  assert.equal(dialog.getAttribute('aria-modal'), 'true')
  assert.equal(dialog.querySelector(`#${dialog.getAttribute('aria-labelledby')}`).textContent, 'Choose trees to edit')
  assert.equal(dialog.querySelector(`#${dialog.getAttribute('aria-describedby')}`).textContent,
    'Shows every agent as fitted circles. Your usual view returns when you finish.')
  assert.deepEqual(dialog.querySelectorAll('.tree-edit-picker-name').map(node => node.textContent),
    ['Controller tree', 'Reviewer tree', 'Research tree'])
  assert.deepEqual(dialog.querySelectorAll('.tree-edit-picker-count').map(node => node.textContent), ['18 agents', '2 agents', '1 agent'])
  assert.ok(inputs.every(input => input.parentNode.tagName === 'LABEL' && input.type === 'checkbox'))
  assert.deepEqual(inputs.map(input => input.checked), [true, false, false])
  assert.equal(env.document.activeElement, inputs[0])
  assert.equal(env.confirm.disabled, false)
  assert.deepEqual(env.confirmed, [])
  assert.deepEqual(env.cancelled, [])
})

test('only explicit nonempty selection confirms, in the displayed tree order', t => {
  const selected = Object.freeze(['missing']), env = fixture(t, { selectedRootIds: selected })
  assert.equal(env.confirm.disabled, true)
  env.confirm.dispatch('click')
  assert.equal(env.backdrop.isConnected, true)
  assert.deepEqual(env.confirmed, [])
  for (const index of [2, 0]) { env.inputs[index].checked = true; env.inputs[index].dispatch('change') }
  assert.equal(env.confirm.disabled, false)
  assert.equal(env.dialog.querySelector('.tree-edit-picker-selection').textContent, '2 trees selected')
  env.confirm.click()
  assert.deepEqual(env.confirmed, [['first', 'third']])
  assert.deepEqual(selected, ['missing'])
  assert.equal(env.backdrop.isConnected, false)
  assert.equal(env.document.activeElement, env.opener)
  env.controller.close()
  env.confirm.click()
  assert.equal(env.confirmed.length, 1)
  assert.equal(env.cancelled.length, 0, 'confirmation cannot also emit cancellation')
})

test('select all and individual checkboxes keep the action and selection summary synchronized', t => {
  const env = fixture(t, { selectedRootIds: [] })
  env.selectAll.click()
  assert.ok(env.inputs.every(input => input.checked))
  assert.equal(env.selectAll.disabled, true)
  assert.equal(env.dialog.querySelector('.tree-edit-picker-selection').textContent, '3 trees selected')
  for (const input of env.inputs) { input.checked = false; input.dispatch('change') }
  assert.equal(env.selectAll.disabled, false)
  assert.equal(env.confirm.disabled, true)
  assert.equal(env.dialog.querySelector('.tree-edit-picker-selection').textContent, '0 trees selected')
})

for (const action of ['cancel', 'escape', 'outside', 'close']) {
  test(`${action} dismisses once, returns focus, and never confirms a selection`, t => {
    const env = fixture(t)
    if (action === 'cancel') env.cancel.click()
    if (action === 'escape') assert.equal(env.inputs[0].dispatch('keydown', { key: 'Escape' }).defaultPrevented, true)
    if (action === 'outside') { env.backdrop.dispatch('pointerdown'); env.backdrop.click() }
    if (action === 'close') env.controller.close()
    assert.equal(env.backdrop.isConnected, false)
    assert.equal(env.document.activeElement, env.opener)
    assert.deepEqual(env.confirmed, [])
    assert.equal(env.cancelled.length, 1)
    env.controller.close()
    assert.equal(env.cancelled.length, 1)
  })
}

test('Tab stays inside the dialog and dragging out of a row does not dismiss it', t => {
  const env = fixture(t)
  env.confirm.focus()
  assert.equal(env.confirm.dispatch('keydown', { key: 'Tab' }).defaultPrevented, true)
  assert.equal(env.document.activeElement, env.selectAll)
  env.selectAll.dispatch('keydown', { key: 'Tab', shiftKey: true })
  assert.equal(env.document.activeElement, env.confirm)
  for (const input of env.inputs) { input.checked = false; input.dispatch('change') }
  env.cancel.focus()
  env.cancel.dispatch('keydown', { key: 'Tab' })
  assert.equal(env.document.activeElement, env.selectAll, 'disabled confirmation is not a focus stop')
  env.inputs[0].dispatch('pointerdown')
  env.backdrop.click()
  assert.equal(env.backdrop.isConnected, true)
  assert.deepEqual(env.cancelled, [])
  env.backdrop.dispatch('pointerdown')
  env.backdrop.click()
  assert.equal(env.cancelled.length, 1)
})

test('names remain literal text and duplicate or absent roots cannot become duplicate selections', t => {
  const name = '<img src=x onerror="startSession()"> & Controller'
  const env = fixture(t, { trees: [
    { rootId: 'one"<&', name, count: 1 }, { rootId: 'one"<&', name: 'Duplicate', count: 40 },
    { rootId: '', name: 'Missing' }, null,
  ], selectedRootIds: ['one"<&'] })
  assert.equal(env.inputs.length, 1)
  assert.equal(env.dialog.querySelector('.tree-edit-picker-name').textContent, name)
  assert.equal(env.dialog.querySelector('img'), null)
  assert.equal(env.dialog.querySelector('script'), null)
  env.confirm.click()
  assert.deepEqual(env.confirmed, [['one"<&']])
})

test('an empty fleet offers only cancellation and closing does not focus a detached opener', t => {
  const env = fixture(t, { trees: [] })
  assert.equal(env.inputs.length, 0)
  assert.equal(env.confirm.disabled, true)
  assert.equal(env.selectAll.disabled, true)
  assert.equal(env.document.activeElement, env.cancel)
  assert.equal(env.dialog.querySelector('.tree-edit-picker-empty').textContent, 'No trees are available to edit.')
  env.opener.remove()
  let focused = 0
  env.opener.focus = () => focused++
  env.controller.close()
  assert.equal(focused, 0)
})
