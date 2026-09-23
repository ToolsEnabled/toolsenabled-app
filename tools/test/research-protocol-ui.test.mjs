import assert from 'node:assert/strict'
import { register } from 'node:module'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { PROTOCOL_FIELDS, decisionsText, effectiveValue, emptyProtocolDecisions, normalizeProtocolDecisions, protocolField, withLeanBench } from '../../src/research-protocol.mjs'
import { pipelineSettings } from '../../src/research-pipeline.mjs'

register('./css-loader.mjs', import.meta.url)
const { createProtocolEditor } = await import('../../src/research-protocol.js')
let installed
beforeEach(() => { installed = installDomStandIn(globalThis) })
afterEach(() => installed.restore())
function mount(state = emptyProtocolDecisions()) {
  const changes = [], editor = createProtocolEditor({ onChange: (state, id) => changes.push({ state, id }) })
  document.body.append(editor.el); editor.set(state)
  const q = name => editor.el.querySelector(`[data-proto-${name}]`)
  const choose = (name, value) => { const input = q(name); input.value = value; input.dispatch('change') }
  const check = (id, value) => { const input = q(`field="${id}"`); input.checked = value; input.dispatch('input'); input.dispatch('change') }
  return { editor, changes, q, choose, check }
}

test('grouped controls load every existing value once without changing saved or frozen decisions', () => {
  const original = withLeanBench(emptyProtocolDecisions())
  for (const field of PROTOCOL_FIELDS.filter(field => !field.managedBy)) {
    if (field.kind === 'choice') original.values[field.id] = field.options.at(-1)[0]
    if (field.kind === 'yesno') original.values[field.id] = 'no'
  }
  Object.assign(original.values, { noask: 'yes', 'noask-text': 'Retained only.', 'draw-timeout': 45, 'provider-notices': 'never' })
  original.notes = 'Keep the original study notes.'
  const { editor, changes, q } = mount(original)
  assert.equal(editor.el.querySelectorAll('[data-proto-section]').length, 7)
  const ids = [...editor.el.querySelectorAll('[data-proto-field]')].map(node => node.getAttribute('data-proto-field'))
  assert.deepEqual(ids.slice().sort(), PROTOCOL_FIELDS.filter(field => !field.managedBy).map(field => field.id).sort(), 'no option is lost or duplicated')
  for (const id of ids) {
    const field = protocolField(id), node = q(`field="${id}"`), expected = effectiveValue(original, field)
    if (node.getAttribute('type') === 'checkbox') assert.equal(node.checked, expected === 'yes', id)
    else if (node.tagName === 'SELECT') assert.equal(node.querySelector('[selected]')?.value, String(expected), id)
    else assert.equal(node.tagName === 'TEXTAREA' ? node.textContent : node.value, Array.isArray(expected) ? expected.join('\n') : String(expected), id)
  }
  assert.equal(q('preset="interruptions"').querySelector('[selected]')?.value, 'custom', 'a mixed saved policy is not replaced by a preset')
  assert.deepEqual(editor.value(), original)
  assert.equal(editor.text(), decisionsText(original))
  assert.deepEqual(pipelineSettings(editor.value()), pipelineSettings(original))
  assert.equal(changes.length, 0)
  assert.match(q('previous').textContent, /Retained only/)
})

test('policy presets update their individual rules together while custom edits preserve other settings', () => {
  const original = normalizeProtocolDecisions({ values: { 'output-cap': 12345, 'study-kind': 'exploratory', noask: 'yes' }, notes: 'Retain these notes.' })
  const { editor, changes, q, choose, check } = mount(original)
  choose('preset="interruptions"', 'custom')
  assert.equal(changes.length, 0, 'opening custom rules changes no study decision')
  assert.equal(q('overrides="interruptions"').open, true)
  choose('preset="interruptions"', 'as-outcomes')
  assert.equal(changes.length, 1)
  for (const id of ['fairness', 'infra-not-model', 'unreachable', 'quota-attrition', 'auth-outage']) assert.equal(editor.value().values[id], 'no', id)
  assert.equal(editor.value().values['provider-notices'], 'no-program')
  assert.equal(editor.value().values.truncation, 'no-program')
  check('fairness', true)
  assert.equal(changes.length, 2, 'a checkbox emits one change, not both input and change')
  assert.equal(q('preset="interruptions"').value, 'custom')
  assert.equal(editor.value().values['provider-notices'], 'no-program', 'one override does not overwrite another')
  choose('preset="retry-selection"', 'best')
  assert.equal(editor.value().values['engine-retry'], 'all')
  assert.equal(editor.value().values['late-response'], 'best')
  assert.equal(editor.value().values['no-best-of-k'], 'no')
  assert.match(editor.text(), /Retries until pass are allowed/)
  for (const [id, value] of Object.entries(original.values)) assert.deepEqual(editor.value().values[id], value, `${id} is outside these presets`)
  assert.equal(editor.value().notes, original.notes)
  assert.deepEqual(pipelineSettings(editor.value()), pipelineSettings(original), 'declarative policy changes do not silently change collector settings')
})

test('checkboxes feed the same harness settings; undecided decisions and read-only mode remain distinct', () => {
  const { editor, changes, q, choose, check } = mount()
  assert.equal(q('field="scope-closed"').tagName, 'SELECT')
  assert.equal(q('field="scope-closed"').value, '')
  check('cleanroom', false)
  check('canary-required', false)
  choose('field="canary-scope"', 'all')
  assert.equal(pipelineSettings(editor.value()).cleanRoom, false)
  assert.deepEqual(pipelineSettings(editor.value()).canary, { required: false, cadence: 'batch', scope: 'all', twoSided: true, certificate: true })
  choose('field="scope-closed"', 'no')
  assert.equal(editor.value().values['scope-closed'], 'no')
  choose('field="scope-closed"', '')
  assert.equal(editor.value().values['scope-closed'], undefined)
  assert.match(editor.text(), /NOT YET DECIDED/)
  const saved = editor.value(), count = changes.length
  editor.setDisabled(true)
  assert.ok([...editor.el.querySelectorAll('input')].every(node => node.disabled))
  choose('preset="interruptions"', 'as-outcomes'); check('cleanroom', true)
  q('use-all').click()
  assert.deepEqual(editor.value(), saved)
  assert.equal(changes.length, count)
})

test('section resets follow the consolidated group and preserve unrelated and retired values', () => {
  const original = withLeanBench(emptyProtocolDecisions())
  Object.assign(original.values, { 'cleanroom': 'no', 'max-turns': 3, 'safe-paths': 'no', noask: 'yes', 'engine-timeout': 123 })
  const { editor, q } = mount(original)
  q('clear-section="collection"').click()
  for (const id of ['cleanroom', 'max-turns', 'safe-paths', 'isolation-record', 'stage-instrumentation']) assert.equal(editor.value().values[id], undefined, id)
  for (const id of ['study-kind', 'engine-timeout', 'quota-attrition', 'noask']) assert.deepEqual(editor.value().values[id], original.values[id], id)
  q('use-section="collection"').click()
  assert.equal(editor.value().values.cleanroom, 'yes')
  assert.equal(editor.value().values['max-turns'], 1)
  assert.equal(editor.value().values['engine-timeout'], 123)
  assert.equal(editor.value().values.noask, 'yes')
})
