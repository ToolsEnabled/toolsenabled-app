// The mechanical checks editor on its own: table rows whose kind decides the
// field shown, fixtures evaluated as they are typed, and code mode whose
// module must export grade. The host attaches the result; this only drafts.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { checksFiles } from '../../src/research-checks.mjs'

register('./css-loader.mjs', import.meta.url)
const { createChecksEditor } = await import('../../src/research-checks.js')
let installed
beforeEach(() => { installed = installDomStandIn(globalThis) })
afterEach(() => installed.restore())
function mount() {
  const changes = [], editor = createChecksEditor({ onChange: draft => changes.push(draft) })
  document.body.append(editor.el)
  const q = name => editor.el.querySelector(`[data-checks-${name}]`)
  const type = (name, value) => { const node = q(name); node.value = value; node.dispatch('input') }
  const choose = (name, value) => { const node = q(name); node.value = value; node.dispatch('change') }
  return { editor, changes, q, type, choose }
}

test('table rows: the kind decides the field shown and fixtures are evaluated as they are typed', () => {
  const { editor, changes, q, type, choose } = mount()
  assert.match(q('problems').textContent, /Add at least one check, or switch to code/)
  assert.match(q('results').textContent, /No fixtures yet/)
  q('add').click()
  assert.equal(changes.length, 1)
  assert.ok(q('pattern="0"') && q('flags="0"'), 'a pattern check asks for its pattern')
  assert.equal(q('expected="0"'), null); assert.equal(q('path="0"'), null)
  assert.match(q('problems').textContent, /check-1 needs a pattern/)
  type('name="0"', 'Final answer')
  assert.match(q('problems').textContent, /Final answer needs a pattern/)
  type('pattern="0"', 'FINAL ANSWER:\\s*(')
  assert.match(q('problems').textContent, /Final answer: the pattern is not a valid regular expression/)
  type('pattern="0"', 'FINAL ANSWER:\\s*42\\b')
  assert.equal(q('problems').textContent, 'Ready to attach.')
  assert.match(q('files').textContent, /checks\/mechanical\.mjs.*checks\/fixtures\.json.*checks\/run-fixtures\.mjs/)
  q('fixture-add').click()
  type('fixture-name="0"', 'A correct answer'); type('fixture-output="0"', 'The answer.\nFINAL ANSWER: 42\n')
  assert.match(q('fixture-result="0"').textContent, /^As registered: expects pass, gets pass\. every check passed$/)
  assert.match(q('results').textContent, /1\s*of 1 fixture get the verdict registered for it\.$/)
  choose('fixture-expect="0"', 'fail')
  assert.match(q('fixture-result="0"').textContent, /^Missed: expects fail, gets pass/)
  assert.match(q('results').textContent, /1\s*missed/)
  assert.match(q('problems').textContent, /Fixture A correct answer expects fail but gets pass: every check passed/)
  // Another kind swaps the field: a length limit is compared with the expected text.
  choose('kind="0"', 'max-chars')
  assert.equal(q('pattern="0"'), null); assert.ok(q('expected="0"')); assert.equal(q('fields="expected"') !== null, true)
  assert.match(q('problems').textContent, /Final answer needs the text or number to compare with/)
  type('expected="0"', '10')
  assert.match(q('fixture-result="0"').textContent, /^As registered: expects fail, gets fail\. Final answer: 29 characters$/)
  assert.equal(q('problems').textContent, 'Ready to attach.')
  choose('kind="0"', 'json-path')
  assert.ok(q('path="0"') && q('expected="0"'))
  assert.match(q('problems').textContent, /needs a JSON path/)
  type('path="0"', 'answer.value'); type('expected="0"', '42')
  type('fixture-output="0"', '{"answer": {"value": 42}}'); choose('fixture-expect="0"', 'pass')
  assert.match(q('fixture-result="0"').textContent, /^As registered: expects pass, gets pass/)
  const required = q('required="0"'); required.checked = false; required.dispatch('change')
  type('weight="0"', '2.5')
  assert.deepEqual(editor.value(), { version: 1, mode: 'table', code: '',
    checks: [{ id: 'check-1', name: 'Final answer', kind: 'json-path', pattern: 'FINAL ANSWER:\\s*42\\b', flags: '', expected: '42', path: 'answer.value', required: false, weight: 2.5 }],
    fixtures: [{ name: 'A correct answer', output: '{"answer": {"value": 42}}', expected: '', expect: 'pass' }] })
  assert.deepEqual(Object.keys(checksFiles(editor.value())), ['checks/mechanical.mjs', 'checks/fixtures.json', 'checks/run-fixtures.mjs'])
  // The draft round-trips through set(); a second check gets its own id even when named alike.
  const other = mount(); other.editor.set(editor.value())
  assert.deepEqual(other.editor.value(), editor.value())
  assert.equal(other.q('kind="0"').querySelector('[selected]').value, 'json-path')
  assert.equal(other.q('required="0"').checked, false); assert.equal(other.q('weight="0"').value, '2.5')
  other.q('add').click(); other.type('name="1"', 'Final answer')
  assert.deepEqual(other.editor.value().checks.map(check => check.id), ['check-1', 'check-2'])
  other.q('remove="0"').click()
  assert.deepEqual(other.editor.value().checks.map(check => check.id), ['check-2'])
  other.q('fixture-remove="0"').click()
  assert.equal(other.editor.value().fixtures.length, 0)
})

test('code mode: the module must export grade; fixtures wait for the run computer', () => {
  const { editor, q, type } = mount()
  const code = [...editor.el.querySelectorAll('[data-checks-mode]')].find(node => node.value === 'code')
  assert.equal(q('table').hidden, false); assert.equal(q('code-section').hidden, true)
  code.checked = true; code.dispatch('change')
  assert.equal(q('table').hidden, true); assert.equal(q('code-section').hidden, false)
  assert.match(q('problems').textContent, /Paste the grading module: it must export grade\(project, task, output\)/)
  type('code', 'export const answer = 42\n')
  assert.match(q('problems').textContent, /must export a function named grade\(project, task, output\)/)
  type('code', 'export async function grade(project, task, output) { const passed = /42/.test(String(output)); return { passed, score: passed ? 1 : 0 } }')
  assert.equal(q('problems').textContent, 'Ready to attach.')
  assert.match(q('files').textContent, /checks\/custom-grader\.mjs/)
  q('fixture-add').click(); type('fixture-output="0"', 'FINAL ANSWER: 42')
  assert.match(q('fixture-result="0"').textContent, /Code graders are checked on the run computer: node checks\/run-fixtures\.mjs/)
  assert.match(q('results').textContent, /1\s*fixture to check on the run computer/)
  assert.equal(editor.value().mode, 'code')
  assert.ok(checksFiles(editor.value())['checks/custom-grader.mjs'].startsWith('export async function grade'))
  const other = mount(); other.editor.set(editor.value())
  assert.equal(other.q('code-section').hidden, false)
  assert.match(other.q('code').textContent, /export async function grade/)
  other.editor.setDisabled(true)
  assert.equal(other.q('code').disabled, true); assert.equal(other.q('add').disabled, true)
  other.q('fixture-add').click()
  assert.equal(other.editor.value().fixtures.length, 1, 'a locked editor ignores clicks')
  other.editor.setDisabled(false)
  assert.equal(other.q('code').disabled, false)
})
