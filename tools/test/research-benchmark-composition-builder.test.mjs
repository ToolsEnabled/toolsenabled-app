import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { compilePrompt } from '../../src/benchmark/prompts.mjs'
import { requirementFieldInventory } from '../../src/benchmark/requirement-fields.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
let installed, cryptoDescriptor, account, downloads
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const control = (view, name) => view.el.querySelector('[data-composition-fields-' + name + ']')
const status = view => field(view, 'status').textContent
async function idle(view) {
  for (let index = 0; index < 800; index++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('Composition builder did not settle: ' + status(view))
}
const input = (node, value) => {
  assert.ok(node); assert.equal(node.disabled, false)
  if (node.type === 'checkbox') node.checked = value; else node.value = value
  node.dispatch('input')
}
const fill = (view, name, value) => input(field(view, name), value)
const fillControl = (view, name, value) => input(control(view, name), value)
async function click(view, name) {
  const button = field(view, name); assert.ok(button, name); assert.equal(button.disabled, false, name + ': ' + status(view)); button.click(); await idle(view)
}
const clickControl = (view, name) => { const button = control(view, name); assert.ok(button, name); assert.equal(button.disabled, false); button.click() }
function memoryAccount() {
  const values = new Map()
  return { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } }, async putSetting(key, value) { values.set(key, value); return { ok: true } } }
}
async function mount(overrides = {}) {
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources, download: (name, contents) => downloads.push({ name, contents }), ...overrides })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); return view
}
async function draft(view) { await click(view, 'draft-export'); return JSON.parse(downloads.at(-1).contents) }
const raw = view => JSON.parse(field(view, 'composition-fields').value)
async function operationalFields(view) {
  field(view, 'starter').value = 'lean-operational'; await click(view, 'use-starter')
  assert.equal(JSON.parse(field(view, 'spec-json').value).executionPlan.purpose, 'experiment')
  await click(view, 'prepare-composition-fields')
  assert.match(status(view), /Occurrence fields prepared/)
  assert.equal(control(view, 'occurrence').children.length, 17)
  assert.equal(control(view, 'expected-policy').value, 'derive-lean')
  fillControl(view, 'family', 'independent-operational')
  fillControl(view, 'rationale', 'Cross two declared process quantities at separate exact occurrences while preserving every other node.')
  fillControl(view, 'expected-rationale', 'Use the shared operational domain compiler for modeled observations; independent qualification and native evidence remain required.')
  fillControl(view, 'coverage-kind', 'pairwise')
}
function quantityChoices(view, path, axisId, values) {
  const occurrence = raw(view).occurrences.find(row => JSON.stringify(row.path) === JSON.stringify(path)); assert.ok(occurrence)
  fillControl(view, 'occurrence', occurrence.key); fillControl(view, 'enabled', true); fillControl(view, 'axis-id', axisId)
  const setQuantity = (index, value) => {
    const choice = view.el.querySelectorAll('[data-composition-fields-choice]')[index]
    input(choice.querySelector('[data-composition-fields-choice-id]'), 'quantity-' + value)
    input(choice.querySelector('[data-composition-fields-parameter-name="quantity"] [data-composition-fields-parameter-value]'), String(value))
  }
  setQuantity(0, values[0]); clickControl(view, 'add-choice'); setQuantity(1, values[1])
}
function fourChoices(view) {
  quantityChoices(view, ['child1', 'buy_process'], 'left-quantity', [1, 2])
  quantityChoices(view, ['child2', 'child1', 'buy_process'], 'nested-quantity', [3, 4])
}
beforeEach(() => {
  installed = installDomStandIn(globalThis); cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto }); account = memoryAccount(); downloads = []
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
})

test('ordinary builder fields generate four complete nested operational cases and expose all 68 controls without qualification', async () => {
  const view = await mount(); await operationalFields(view); fourChoices(view)
  const retained = raw(view)
  await click(view, 'freeze')
  assert.match(status(view), /pending editor changes.*compositionFields/)
  assert.equal(field(view, 'export').disabled, true)
  await click(view, 'apply-composition-fields')
  assert.match(status(view), /Task recipe built/)
  assert.match(field(view, 'composition-fields-status').textContent, /2 occurrence factors; 4 complete assignments/)
  let exported = await draft(view)
  assert.equal(exported.pending.includes('compositionFields'), false)
  assert.equal(exported.pending.includes('corpus'), true)
  assert.equal(exported.spec.tasks.length, 1, 'Building the recipe does not prematurely replace tasks.')
  const recipe = JSON.parse(field(view, 'corpus-plan').value)
  assert.deepEqual(recipe.families[0].axes.map(axis => axis.choices.map(choice => choice.edits[0].path)), [
    [['child1', 'buy_process'], ['child1', 'buy_process']],
    [['child2', 'child1', 'buy_process'], ['child2', 'child1', 'buy_process']],
  ])
  await click(view, 'generate-corpus')
  assert.match(status(view), /4 tasks generated from 4 candidates/)
  assert.equal(field(view, 'task').children.length, 4)
  assert.deepEqual(raw(view), retained)
  assert.match(field(view, 'composition-obligations').textContent, /68 exact occurrence controls across 4 generated tasks; at least 272 independent interpreter cases/)
  assert.match(field(view, 'composition-obligations').textContent, /128 targets and 512 cases.*4 runtime appendix obligations/)
  assert.match(field(view, 'composition-obligations').textContent, /Structural coverage does not establish activation, correct expected answers or independent qualification/)
  exported = await draft(view)
  assert.equal(exported.spec.executionPlan.purpose, 'experiment')
  assert.equal(exported.spec.requireReview, true)
  assert.equal(exported.spec.requirementPlan, undefined)
  assert.equal(exported.spec.reviews?.length || 0, 0)
  assert.equal(exported.spec.taskReviews?.length || 0, 0)
  assert.ok(exported.spec.conditions.every(condition => condition.adapter.kind !== 'replay' || Object.keys(condition.adapter.responses).length === 0))
  assert.deepEqual(exported.spec.tasks.map(task => task.expected.orders.map(order => order.quantity)), [
    [1, 3, -1, -3, 4, -4], [1, 4, -1, -4, 4, -4], [2, 3, -2, -3, 4, -4], [2, 4, -2, -4, 4, -4],
  ])
  for (const task of exported.spec.tasks) {
    const compiled = await compilePrompt(exported.spec.catalog, task.root)
    assert.equal(compiled.nodeCount, 17); assert.equal(compiled.depth, 3)
  }
  const ledger = JSON.parse(field(view, 'corpus-ledger').textContent)
  assert.equal(ledger.status, 'ready'); assert.equal(ledger.candidateCount, 4); assert.equal(ledger.selectedCount, 4)
  assert.equal(ledger.oracle.independentQualificationRequired, true)
  const pairCells = ledger.coverage.filter(cell => cell.dimension.includes(' × '))
  assert.equal(pairCells.length, 4); assert.ok(pairCells.every(cell => cell.selected === 1 && cell.available === 1))
  const requirements = await requirementFieldInventory(exported.spec)
  assert.equal(requirements.rows.length, 68); assert.equal(requirements.appendices.length, 4)
  assert.deepEqual(requirements.blocking, [])
  await click(view, 'freeze')
  assert.match(status(view), /needs review/)
  assert.equal(field(view, 'run').disabled, true); assert.equal(field(view, 'export-evidence').disabled, true)
  await click(view, 'prepare-requirement-fields')
  assert.equal(view.el.querySelector('[data-requirement-fields-target]').children.length, 68)
  assert.equal(JSON.parse(field(view, 'requirement-fields').value).targets.length, 68)
  assert.equal((await draft(view)).spec.requirementPlan, undefined)
})

test('unfinished composition fields survive save and remount without leaking into another project or account', async () => {
  let view = await mount(); await operationalFields(view); fourChoices(view)
  fillControl(view, 'selection-limit', 'unfinished selection')
  await click(view, 'apply-composition-fields')
  assert.match(status(view), /whole number.*selected task limit/)
  const retained = raw(view)
  await click(view, 'save')
  await view.setContext(B, 'live'); await idle(view)
  assert.equal(field(view, 'composition-fields').value, '')
  assert.doesNotMatch(field(view, 'composition-fields-editor').textContent, /unfinished selection|independent-operational/)
  await view.setContext(A, 'live'); await idle(view)
  assert.deepEqual(raw(view), retained)
  view = await mount(); await click(view, 'prepare-composition-fields')
  assert.deepEqual(raw(view), retained)
  assert.equal(control(view, 'selection-limit').value, 'unfinished selection')
  assert.equal(control(view, 'occurrence').children.length, 17)
  const other = await mount({ account: memoryAccount() })
  assert.equal(field(other, 'composition-fields').value, '')
  assert.equal((await draft(other)).spec.id, 'my-benchmark')
  fillControl(view, 'selection-limit', '512')
  await click(view, 'apply-composition-fields')
  assert.match(status(view), /Task recipe built/)
  assert.match(field(view, 'composition-fields-status').textContent, /4 complete assignments/)
})

test('changed source input refuses stale occurrence fields and explicit reset Undo preserves the authored matrix', async () => {
  const view = await mount(); await operationalFields(view); fourChoices(view)
  const retained = raw(view), previousInput = JSON.parse(field(view, 'input').value)
  const changedInput = structuredClone(previousInput); changedInput.market.maxFillQuantity = 1
  fill(view, 'input', JSON.stringify(changedInput)); await click(view, 'apply-input')
  await click(view, 'derive-expected')
  assert.match(status(view), /Draft expected observation derived/)
  assert.deepEqual(raw(view), retained, 'Deriving the applied source observation preserves every unapplied occurrence choice.')
  await click(view, 'apply-composition-fields')
  assert.match(status(view), /Retained composition fields are stale/)
  assert.deepEqual(raw(view), retained)
  assert.equal(JSON.parse(field(view, 'spec-json').value).corpusPlan, undefined)
  await click(view, 'prepare-composition-fields')
  assert.match(control(view, 'status').textContent, /fields are stale/)
  assert.deepEqual(raw(view), retained)
  await click(view, 'reset-composition-fields')
  const fresh = raw(view)
  assert.notEqual(fresh.bindingSha256, retained.bindingSha256)
  assert.ok(fresh.occurrences.every(row => !row.enabled && row.choices.length === 1))
  assert.equal(fresh.rationale, '')
  assert.equal(field(view, 'undo').hidden, false)
  await click(view, 'undo')
  assert.deepEqual(raw(view), retained)
  assert.deepEqual(JSON.parse(field(view, 'input').value), changedInput)
  await click(view, 'prepare-composition-fields')
  assert.match(control(view, 'status').textContent, /fields are stale/)
  await click(view, 'apply-composition-fields')
  assert.match(status(view), /Retained composition fields are stale/)
  assert.deepEqual(raw(view), retained)
})
