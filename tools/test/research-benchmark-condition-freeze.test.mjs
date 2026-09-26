import assert from 'node:assert/strict'
import test, { beforeEach, afterEach } from 'node:test'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES, bindRuntimeSources } from '../../src/benchmark/study.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { canonical } from '../../src/benchmark/prompts.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
let installed, cryptoDescriptor, fetchDescriptor, account, downloads, sourceLoads, networkCalls
const pause = () => new Promise(resolve => setTimeout(resolve, 2))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const cf = (view, name) => field(view, 'condition-fields-editor').querySelector('[data-condition-fields-' + name + ']')
const status = view => field(view, 'status').textContent
const specOf = view => JSON.parse(field(view, 'spec-json').value)
const rawFields = view => field(view, 'condition-fields').value
const fieldsOf = view => JSON.parse(rawFields(view))
const temperatureField = view => [...field(view, 'condition-fields-editor').querySelectorAll('[data-condition-fields-setting-row]')]
  .find(row => row.querySelector('[data-condition-fields-setting-key]').value === 'temperature')?.querySelector('[data-condition-fields-setting-text]')
async function idle(view) {
  for (let n = 0; n < 1000; n++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('Condition freeze did not settle: ' + status(view))
}
function input(node, value) {
  assert.ok(node, 'Required mounted field exists'); assert.equal(node.disabled, false)
  if (node.type === 'checkbox') node.checked = value; else node.value = value
  node.dispatch('input')
}
async function click(view, name) {
  const node = field(view, name); assert.ok(node, name); assert.equal(node.disabled, false, name + ': ' + status(view))
  node.click(); await idle(view)
}
function memoryAccount() {
  const values = new Map(), calls = { reads: 0, writes: 0 }
  return { values, calls, async getSetting(key) { calls.reads++; return { ok: true, value: values.get(key) ?? null } },
    async putSetting(key, value) { calls.writes++; values.set(key, value); return { ok: true } } }
}
async function mount(overrides = {}) {
  const view = createBenchmarkBuilder({ account, loadSources: async () => { sourceLoads++; return sources },
    download: (name, contents) => downloads.push({ name, contents }), ...overrides })
  for (const name of ['seed', 'replicates', 'attempts', 'total', 'timeout', 'duration']) {
    const node = field(view, name); let value = String(node.value)
    Object.defineProperty(node, 'value', { configurable: true, get: () => value, set: next => { value = String(next) } })
  }
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); return view
}
function fixture() {
  const spec = newExperimentDraft(genericStarter(), { initializePopulation: true })
  spec.id = 'condition-freeze-controls'; spec.name = 'Condition freeze controls'
  spec.conditions[0].model.settings = { temperature: 0.25, enabled: false }
  spec.conditions.push({ ...structuredClone(spec.conditions[0]), id: 'second', label: 'Second configuration' })
  return spec
}
async function prepare(view, original = fixture()) {
  input(field(view, 'spec-json'), JSON.stringify(original)); await click(view, 'apply-spec')
  assert.match(status(view), /Full specification applied/)
  await click(view, 'prepare-condition-fields'); await click(view, 'apply-condition-fields')
  assert.match(status(view), /Condition setup applied/)
  return original
}
async function draftExport(view) { await click(view, 'draft-export'); return JSON.parse(downloads.at(-1).contents) }
const editorTexts = view => Object.fromEntries(['conditions', 'workflow-config', 'observation-plan'].map(name => [name, field(view, name).value]))
async function editTemperature(view, text) {
  input(temperatureField(view), text); await click(view, 'apply-condition-fields')
}
async function retain(name, value) {
  const root = process.env.RESEARCH_CONDITION_FREEZE_EVIDENCE_DIR
  if (root) { await mkdir(root, { recursive: true }); await writeFile(resolve(root, name + '.json'), JSON.stringify(value, null, 2) + '\n') }
}

beforeEach(() => {
  installed = installDomStandIn(globalThis)
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  networkCalls = 0
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => { networkCalls++; throw new Error('Network is forbidden in condition-freeze authoring tests.') } })
  account = memoryAccount(); downloads = []; sourceLoads = 0
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
  if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor); else delete globalThis.fetch
  assert.equal(networkCalls, 0)
})

test('first Freeze and ZIP export preserve editable condition settings, selected row and exact existing declarations', async () => {
  const view = await mount(), original = await prepare(view)
  const selected = fieldsOf(view).rows.find(row => row.id === 'second')
  input(cf(view, 'row'), selected.key)
  const beforeFields = fieldsOf(view), beforeTexts = editorTexts(view), calls = structuredClone(account.calls)
  await click(view, 'freeze'); assert.match(status(view), /Project frozen/)
  const frozen = specOf(view), { runtimeSources, ...withoutPins } = frozen
  assert.deepEqual(withoutPins, original)
  assert.equal(Object.keys(runtimeSources).length, RUNTIME_FILES.length)
  assert.deepEqual(editorTexts(view), beforeTexts)
  const afterFields = fieldsOf(view)
  assert.deepEqual({ ...afterFields, binding: beforeFields.binding }, beforeFields)
  assert.notEqual(afterFields.binding, beforeFields.binding)
  assert.equal(cf(view, 'row').value, selected.key)
  assert.equal(temperatureField(view).disabled, false)
  assert.equal(field(view, 'export').disabled, false); assert.equal(field(view, 'run').disabled, true)
  assert.match(field(view, 'readiness').textContent, /independent|oracle/i)
  const frozenText = field(view, 'frozen').textContent, rawBeforeExport = rawFields(view)
  await click(view, 'export'); assert.match(status(view), /Runnable project exported/)
  assert.ok(downloads.at(-1).name.endsWith('.zip')); assert.ok(downloads.at(-1).contents.byteLength > 0)
  assert.equal(field(view, 'frozen').textContent, frozenText)
  assert.equal(rawFields(view), rawBeforeExport)
  assert.deepEqual((await draftExport(view)).pending, [])
  assert.deepEqual(account.calls, calls)
  await editTemperature(view, '0.6'); assert.match(status(view), /Condition setup applied/)
  assert.equal(specOf(view).conditions.find(row => row.id === 'second').model.settings.temperature, 0.6)
  assert.equal(specOf(view).conditions.find(row => row.id === 'recorded').model.settings.temperature, 0.25)
  assert.equal(field(view, 'export').disabled, true, 'The deliberate setting edit invalidates the previous frozen artifact.')
  await retain('first-freeze-edit', { beforeFields, afterFields, original, frozen, afterEdit: specOf(view), sources: runtimeSources, sourceLoads })
})

test('already matching runtime pins preserve the same ordinary edit journey without changing the field binding', async () => {
  const view = await mount(), original = await bindRuntimeSources(fixture(), sources)
  await prepare(view, original)
  const before = rawFields(view)
  await click(view, 'freeze'); assert.match(status(view), /Project frozen/)
  await click(view, 'export'); assert.match(status(view), /Runnable project exported/)
  assert.equal(rawFields(view), before); assert.deepEqual(specOf(view), original)
  await editTemperature(view, '0.6'); assert.match(status(view), /Condition setup applied/)
  assert.equal(specOf(view).conditions[0].model.settings.temperature, 0.6)
  await retain('matching-pins-edit', { original, afterEdit: specOf(view) })
})

test('a previously declared runtime pin changing during Freeze keeps the old condition draft stale and exact', async () => {
  const view = await mount(), original = await bindRuntimeSources(fixture(), sources)
  original.runtimeSources['study.mjs'] = '0'.repeat(64)
  await prepare(view, original)
  const before = rawFields(view)
  await click(view, 'freeze'); assert.match(status(view), /Project frozen/)
  assert.notEqual(specOf(view).runtimeSources['study.mjs'], original.runtimeSources['study.mjs'])
  assert.equal(rawFields(view), before)
  await click(view, 'apply-condition-fields'); assert.match(status(view), /stale/)
  assert.equal(rawFields(view), before); assert.equal(temperatureField(view).disabled, true)
  await retain('changed-pin-stale', { refusal: status(view), originalPin: original.runtimeSources['study.mjs'], actualPin: specOf(view).runtimeSources['study.mjs'], rawFields: before })
})

test('an explicit analysis change before first Freeze cannot be mistaken for the pristine pin-publication case', async () => {
  const view = await mount(); await prepare(view)
  const before = rawFields(view)
  input(field(view, 'analysis-rationale'), 'Investigator explicitly changed the planned analysis.')
  await click(view, 'apply-analysis'); assert.match(status(view), /Analysis plan applied/)
  await click(view, 'freeze'); assert.match(status(view), /Project frozen/)
  assert.equal(rawFields(view), before)
  await click(view, 'apply-condition-fields'); assert.match(status(view), /stale/)
  assert.equal(rawFields(view), before)
  assert.equal(specOf(view).analysisPlan.rationale, 'Investigator explicitly changed the planned analysis.')
  await retain('analysis-stale', { refusal: status(view), rawFields: before, spec: specOf(view) })
})

test('pending ordinary field text blocks Freeze before source loading and survives save, remount and failed Apply', async () => {
  const view = await mount(); await prepare(view)
  input(temperatureField(view), '1e')
  const before = rawFields(view), applied = canonical(specOf(view)), loads = sourceLoads
  await click(view, 'freeze'); assert.match(status(view), /pending editor changes.*conditionFields/)
  assert.equal(sourceLoads, loads); assert.equal(rawFields(view), before); assert.equal(canonical(specOf(view)), applied)
  await click(view, 'save')
  const cold = await mount(); assert.equal(rawFields(cold), before)
  assert.ok((await draftExport(cold)).pending.includes('conditionFields'))
  await click(cold, 'freeze'); assert.match(status(cold), /pending editor changes.*conditionFields/)
  await click(cold, 'apply-condition-fields'); assert.match(status(cold), /complete finite JSON number/)
  assert.equal(rawFields(cold), before); assert.equal(fieldsOf(cold).rows[0].model.settings.find(row => row.key === 'temperature').text, '1e')
  await retain('pending-text', { refusal: status(cold), rawFields: before, spec: specOf(cold), sourceLoads })
})

test('independently edited expert buffers stay stale and counterfeit clean drafts never receive an automatic binding refresh', async () => {
  for (const kind of ['expert-text', 'field-values', 'field-format']) {
    const view = await mount(); await prepare(view)
    const prepared = fieldsOf(view)
    if (kind === 'expert-text') field(view, 'conditions').value += '\n '
    else if (kind === 'field-values') {
      const counterfeit = structuredClone(prepared); counterfeit.rows[0].model.settings.find(row => row.key === 'temperature').text = '0.6'
      field(view, 'condition-fields').value = JSON.stringify(counterfeit, null, 2)
    } else field(view, 'condition-fields').value += '\n '
    // Simulate a saved/imported buffer lacking its pending marker. The product
    // must inspect actual source/draft values rather than trust the marker.
    const before = rawFields(view), expertBefore = editorTexts(view)
    assert.deepEqual((await draftExport(view)).pending, [])
    await click(view, 'freeze'); assert.match(status(view), /Project frozen/)
    assert.equal(rawFields(view), before, kind)
    assert.deepEqual(editorTexts(view), expertBefore, kind)
    await click(view, 'apply-condition-fields'); assert.match(status(view), /stale/, kind)
    assert.equal(rawFields(view), before); assert.equal(specOf(view).conditions[0].model.settings.temperature, 0.25)
    await retain('not-pristine-' + kind, { refusal: status(view), rawFields: before, expertBefore, spec: specOf(view) })
  }
})

test('a project/account switch during source loading cannot publish old runtime pins, fields or frozen state into the new context', async () => {
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  const view = await mount({ loadSources: async () => { sourceLoads++; entered(); return held } })
  await prepare(view)
  const before = rawFields(view)
  field(view, 'freeze').click(); await started
  await view.setContext(B, 'live'); await idle(view)
  assert.equal(rawFields(view), '')
  const newSpec = canonical(specOf(view)), newStatus = status(view)
  release(sources); await pause(); await pause(); await idle(view)
  assert.equal(rawFields(view), ''); assert.equal(canonical(specOf(view)), newSpec); assert.equal(status(view), newStatus)
  assert.equal(specOf(view).runtimeSources, undefined); assert.equal(field(view, 'export').disabled, true)
  assert.doesNotMatch(field(view, 'condition-fields-editor').textContent, /condition-freeze-controls|Second configuration/)
  await view.setContext(A, 'live'); await idle(view)
  assert.equal(rawFields(view), before); assert.equal(specOf(view).runtimeSources, undefined)
  assert.equal(field(view, 'export').disabled, true)
  await retain('context-switch', { restoredRawFields: rawFields(view), sourceLoads, downloads: downloads.length, accountWrites: account.calls.writes })
})
