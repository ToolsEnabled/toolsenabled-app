import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES, validateStudy } from '../../src/benchmark/study.mjs'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
let installed, cryptoDescriptor, account, downloads, sourceLoads
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const globalField = (view, name) => field(view, 'family-editor').querySelector('[data-composition-family-fields-' + name + ']')
const localField = (view, name, single = false) => field(view, single ? 'composition-fields-editor' : 'family-occurrence-editor').querySelector('[data-composition-fields-' + name + ']')
const status = view => field(view, 'status').textContent
const specOf = view => JSON.parse(field(view, 'spec-json').value)
const raw = view => field(view, 'composition-family-fields').value
async function idle(view) {
  for (let index = 0; index < 800; index++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('Source draft builder did not settle: ' + status(view))
}
function input(node, value) {
  assert.ok(node); assert.equal(node.disabled, false)
  if (node.type === 'checkbox') node.checked = value; else node.value = value
  node.dispatch('input')
}
const fill = (view, name, value) => input(field(view, name), value)
const globalFill = (view, name, value) => input(globalField(view, name), value)
async function click(view, name) {
  const button = field(view, name); assert.ok(button, name); assert.equal(button.disabled, false, name + ': ' + status(view)); button.click(); await idle(view)
}
async function globalClick(view, name) {
  const button = globalField(view, name); assert.ok(button); assert.equal(button.disabled, false); button.click(); await idle(view)
}
async function selectFamily(view, id) { globalFill(view, 'family', id); await idle(view) }
function memoryAccount() {
  const values = new Map(), calls = { reads: 0, writes: 0 }
  return { calls, values, async getSetting(key) { calls.reads++; return { ok: true, value: values.get(key) ?? null } },
    async putSetting(key, value) { calls.writes++; values.set(key, value); return { ok: true } } }
}
async function mount(overrides = {}) {
  const view = createBenchmarkBuilder({ account, loadSources: async () => { sourceLoads++; return sources },
    download: (name, contents) => downloads.push({ name, contents }), ...overrides })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); return view
}
async function ordinaryDraft(view) { await click(view, 'draft-export'); return JSON.parse(downloads.at(-1).contents) }
function fixture(purpose = 'experiment') {
  const spec = newExperimentDraft(genericStarter(), { purpose, initializePopulation: true })
  spec.catalog = [{ id: 'instruction', version: '1', kind: 'atom', role: 'node', parameters: { n: 1 },
    parameterSchema: { n: { type: 'integer', minimum: 0 } }, text: 'Wording {{n}}. Return the input number.', semantics: { kind: 'instruction', n: '{{n}}' } }]
  spec.tasks = [
    { id: 'source-a', familyId: 'original-a', split: 'development', root: { use: 'instruction' }, input: { number: 0 }, expected: 0 },
    { id: 'source-b', familyId: 'original-b', split: 'held-out', root: { use: 'instruction' }, input: { number: 9 }, expected: 9 },
  ]
  spec.protocol.grading = { kind: 'json' }; spec.conditions[0].adapter.responses = { 'source-a': 0, 'source-b': 9 }
  return spec
}
function fillFamily(view, suffix, single = false) {
  const fillLocal = (name, value) => input(localField(view, name, single), value)
  fillLocal('family', 'generated-' + suffix)
  fillLocal('rationale', 'Construct both wording levels for source ' + suffix + '.')
  fillLocal('expected-policy', 'reuse-base')
  fillLocal('expected-rationale', 'Retain source ' + suffix + ' declared answer for this construction control only.')
  fillLocal('enabled', true); fillLocal('axis-id', 'wording')
  const setChoice = (index, id, value) => {
    const container = field(view, single ? 'composition-fields-editor' : 'family-occurrence-editor')
    input(container.querySelectorAll('[data-composition-fields-choice]')[index].querySelector('[data-composition-fields-choice-id]'), id)
    input(container.querySelectorAll('[data-composition-fields-choice]')[index].querySelector('[data-composition-fields-parameter-value]'), value)
  }
  setChoice(0, 'one', '1'); localField(view, 'add-choice', single).click(); setChoice(1, 'two', '2')
}
async function generate(view, purpose = 'experiment') {
  fill(view, 'spec-json', JSON.stringify(fixture(purpose))); await click(view, 'apply-spec')
  await click(view, 'prepare-composition-fields'); fillFamily(view, 'a', true)
  input(localField(view, 'selection-limit', true), 'archived unfinished single limit')
  await click(view, 'start-family-workspace')
  globalFill(view, 'rationale', 'Keep both original families and all four scoped wording choices.')
  globalFill(view, 'selection-kind', 'all'); globalFill(view, 'selection-limit', '4')
  globalFill(view, 'source', 'source-b'); await globalClick(view, 'add'); fillFamily(view, 'b')
  await click(view, 'apply-composition-fields'); assert.match(status(view), /Task recipe built/)
  await click(view, 'generate-corpus'); assert.match(status(view), /4 tasks generated from 4 candidates/)
  assert.equal(specOf(view).tasks.length, 4)
}
function uiState(view) {
  return { spec: field(view, 'spec-json').value, family: raw(view), single: field(view, 'composition-fields').value,
    task: field(view, 'task-json').value, input: field(view, 'input').value, expected: field(view, 'expected').value,
    dirty: view.dirty, undoHidden: field(view, 'undo').hidden, frozen: field(view, 'frozen').textContent,
    readiness: field(view, 'readiness').innerHTML, results: field(view, 'results').innerHTML,
    exportDisabled: field(view, 'export').disabled, evidenceDisabled: field(view, 'export-evidence').disabled,
    familySelection: globalField(view, 'family')?.value }
}
async function exportSources(view) {
  const beforeDownloads = downloads.length, beforeLoads = sourceLoads, beforeCalls = structuredClone(account.calls)
  const button = field(view, 'export-family-sources'); assert.ok(button); assert.equal(button.disabled, false)
  button.click()
  assert.equal(downloads.length, beforeDownloads + 1, 'The source derivative is downloaded synchronously before the click returns.')
  assert.equal(sourceLoads, beforeLoads)
  assert.deepEqual(account.calls, beforeCalls)
  await idle(view)
  assert.match(status(view), /^Editable family source draft exported\./)
  assert.equal(sourceLoads, beforeLoads); assert.deepEqual(account.calls, beforeCalls)
  assert.match(downloads.at(-1).name, /-family-sources-draft\.json$/)
  return JSON.parse(downloads.at(-1).contents)
}
async function importDraft(view, value) {
  const text = JSON.stringify(value), control = field(view, 'import')
  control.files = [{ name: 'ordinary-schema2-draft.json', size: new TextEncoder().encode(text).byteLength, text: async () => text }]
  control.dispatch('change'); await idle(view)
  assert.equal(status(view), 'Opened ordinary-schema2-draft.json. Its experiment fields are loaded; you do not need an example preset. Unapplied editor text has been restored.')
}

beforeEach(() => {
  installed = installDomStandIn(globalThis); cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  account = memoryAccount(); downloads = []; sourceLoads = 0
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
})

test('cold generated workspace exports exactly two raw source editors synchronously without changing saved or current state', async () => {
  const initial = await mount(); await generate(initial)
  globalFill(initial, 'selection-limit', 'unfinished family selection')
  await click(initial, 'save')
  const cold = await mount(); await selectFamily(cold, 'source-b')
  assert.equal(field(cold, 'undo').hidden, true)
  assert.equal(localField(cold, 'rationale').disabled, true)
  assert.equal(cold.dirty, false)
  const before = uiState(cold), saved = canonical([...account.values]), ordinary = await ordinaryDraft(cold)
  const derivative = await exportSources(cold)
  assert.deepEqual(uiState(cold), before)
  assert.equal(canonical([...account.values]), saved)
  assert.deepEqual(derivative.pending, ['compositionFamilies'])
  assert.deepEqual(Object.keys(derivative.editors).sort(), ['data-bench-composition-family-fields', 'data-bench-composition-fields'])
  assert.equal(derivative.editors['data-bench-composition-family-fields'], before.family)
  assert.equal(derivative.editors['data-bench-composition-fields'], before.single)
  assert.equal(JSON.parse(before.family).selection.limit, 'unfinished family selection')
  assert.equal(JSON.parse(before.single).selection.limit, 'archived unfinished single limit')
  assert.equal(derivative.taskIndex, 0); assert.equal(derivative.bundleIndex, 0)
  assert.deepEqual(derivative.spec.tasks, JSON.parse(before.family).families.map(entry => entry.sourceTask))
  assert.equal(derivative.spec.corpusPlan, undefined)
  assert.deepEqual(derivative.spec.corpusHistory.at(-1), { kind: 'detached-recipe', recipe: ordinary.spec.corpusPlan })
  assert.deepEqual(derivative.spec.conditions[0].adapter.responses, {})
  assert.equal(Object.hasOwn(derivative.spec.conditions[0].adapter, 'workflowResponses'), false)
  assert.deepEqual(derivative.spec.analysisPlan, ordinary.spec.analysisPlan)
  assert.equal(derivative.spec.executionPlan.purpose, 'experiment')
  for (const key of ['evidence', 'frozen', 'readiness', 'backup', 'dirty']) assert.equal(Object.hasOwn(derivative, key), false)
  assert.deepEqual((await ordinaryDraft(cold)).pending, ordinary.pending)
})

test('pending task, input, corpus, protocol, requirement and specification edits refuse source export with their raw text intact', async () => {
  const initial = await mount(); await generate(initial); await click(initial, 'save')
  for (const [editor, value, group] of [
    ['task-json', '{ unfinished task', 'task'], ['input', '{ unfinished input', 'input'],
    ['corpus-plan', '{ unfinished derived recipe', 'corpus'], ['conditions', '{ unfinished conditions', 'protocol'],
    ['requirement-plan', '{ unfinished controls', 'requirements'], ['spec-json', '{ unfinished full specification', 'specification'],
  ]) {
    const view = await mount(); fill(view, editor, value)
    const before = uiState(view), count = downloads.length, calls = structuredClone(account.calls), loads = sourceLoads
    await click(view, 'export-family-sources')
    assert.equal(status(view), `Apply the current ${group} edits first. Your text is preserved.`)
    assert.equal(field(view, editor).value, value)
    assert.equal(downloads.length, count); assert.equal(sourceLoads, loads); assert.deepEqual(account.calls, calls)
    assert.deepEqual(uiState(view), before)
  }
})

test('ordinary schema2 replay source export validates, imports, rebuilds, generates and freezes before Undo restores sources', async () => {
  const view = await mount(); await generate(view)
  const current = specOf(view), fields = raw(view), single = field(view, 'composition-fields').value
  const derivative = await exportSources(view)
  assert.doesNotThrow(() => validateStudy(derivative.spec), 'Ordinary replay source export must not introduce an unsupported workflow field.')
  assert.equal(specOf(view).tasks.length, 4)
  await importDraft(view, derivative)
  assert.deepEqual(specOf(view).tasks, derivative.spec.tasks)
  assert.deepEqual(specOf(view).tasks.map(task => task.id), ['source-a', 'source-b'])
  assert.equal(raw(view), fields); assert.equal(field(view, 'composition-fields').value, single)
  assert.equal(JSON.parse(field(view, 'task-json').value).id, 'source-a')
  assert.deepEqual(JSON.parse(field(view, 'input').value), { number: 0 })
  assert.deepEqual((await ordinaryDraft(view)).pending, ['compositionFamilies'])
  await click(view, 'freeze'); assert.match(status(view), /pending.*compositionFamilies/i)
  await selectFamily(view, 'source-a')
  assert.equal(localField(view, 'rationale').disabled, false)
  await click(view, 'apply-composition-fields'); assert.match(status(view), /Task recipe built/)
  await click(view, 'generate-corpus'); assert.match(status(view), /4 tasks generated from 4 candidates/)
  assert.deepEqual(specOf(view).tasks, current.tasks)
  assert.equal(raw(view), fields)
  await click(view, 'freeze')
  assert.equal(field(view, 'export').disabled, false, status(view))
  assert.match(field(view, 'frozen').textContent, /^4 tasks · 4 scheduled trials · SHA-256 [a-f0-9]{64}$/)
  assert.equal(field(view, 'run').disabled, true, 'A frozen source derivative still needs normal experimental admission.')
  assert.equal(specOf(view).executionPlan.purpose, 'experiment')
  assert.equal(specOf(view).reviews?.length || 0, 0)
  assert.equal(specOf(view).requirementPlan, undefined)
  await click(view, 'undo')
  assert.deepEqual(specOf(view).tasks, derivative.spec.tasks)
  assert.equal(raw(view), fields); assert.equal(field(view, 'composition-fields').value, single)
  assert.equal(specOf(view).executionPlan.purpose, current.executionPlan.purpose)
  assert.deepEqual(specOf(view).analysisPlan, current.analysisPlan)
})

test('source export leaves live frozen diagnostic evidence and the existing generation Undo untouched', async () => {
  const view = await mount(); await generate(view, 'recorded-diagnostic')
  const conditions = JSON.parse(field(view, 'conditions').value)
  conditions[0].adapter.responses = Object.fromEntries(specOf(view).tasks.map(task => [task.id, task.expected]))
  fill(view, 'conditions', JSON.stringify(conditions)); await click(view, 'apply-protocol')
  await click(view, 'freeze'); assert.equal(field(view, 'run').disabled, false)
  await click(view, 'run'); assert.match(status(view), /Recorded-response run finished/)
  await click(view, 'export-evidence')
  const evidence = JSON.parse(downloads.at(-1).contents)
  assert.equal(evidence.summary.completed, 4)
  await click(view, 'save')
  const before = uiState(view), saved = canonical([...account.values]), derivative = await exportSources(view)
  assert.deepEqual(uiState(view), before); assert.equal(canonical([...account.values]), saved)
  assert.equal(derivative.spec.executionPlan.purpose, 'recorded-diagnostic')
  assert.deepEqual(derivative.spec.conditions[0].adapter.responses, {})
  await click(view, 'export-evidence')
  assert.deepEqual(JSON.parse(downloads.at(-1).contents), evidence)
  await click(view, 'undo')
  assert.deepEqual(specOf(view).tasks.map(task => task.id), ['source-a', 'source-b'])
})

test('source derivative exports remain in their selected project and account without restoring capsules into other contexts', async () => {
  const view = await mount(); await generate(view); await click(view, 'save')
  const retained = raw(view), derivative = await exportSources(view)
  await view.setContext(B, 'live'); await idle(view)
  assert.equal(field(view, 'composition-family-fields').value, '')
  assert.equal(field(view, 'family-workspace').hidden, true)
  const count = downloads.length
  await click(view, 'export-family-sources')
  assert.equal(downloads.length, count)
  assert.match(status(view), /retained family workspace|source famil/i)
  const isolatedAccount = memoryAccount(), isolated = await mount({ account: isolatedAccount })
  assert.equal(field(isolated, 'composition-family-fields').value, '')
  assert.equal(specOf(isolated).tasks.some(task => task.id === 'source-a'), false)
  assert.equal(isolatedAccount.calls.writes, 0)
  await view.setContext(A, 'live'); await idle(view)
  assert.equal(raw(view), retained)
  assert.deepEqual(await exportSources(view), derivative)
  assert.equal(specOf(view).tasks.length, 4)
})
