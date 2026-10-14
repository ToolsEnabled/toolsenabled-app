import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { resolve } from 'node:path'
import { webcrypto } from 'node:crypto'
import test, { beforeEach, afterEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES, bindRuntimeSources, freezeStudy, validateStudy } from '../../src/benchmark/study.mjs'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { observationContract, observationPlanFromSpec, observeResponse } from '../../src/benchmark/observations.mjs'
import { collectionRequest } from '../../src/benchmark/workflow.mjs'
import { evaluateReadiness } from '../../src/benchmark/readiness.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
let installed, cryptoDescriptor, account, downloads, sourceLoads, fetchDescriptor, networkCalls
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const cf = (view, name) => field(view, 'condition-fields-editor').querySelector('[data-condition-fields-' + name + ']')
const status = view => field(view, 'status').textContent
const specOf = view => JSON.parse(field(view, 'spec-json').value)
const rawFields = view => field(view, 'condition-fields').value
const fieldsOf = view => JSON.parse(rawFields(view))
async function idle(view) {
  for (let n = 0; n < 1000; n++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('Condition field builder did not settle: ' + status(view))
}
function input(node, value) {
  assert.ok(node, 'Required field exists'); assert.equal(node.disabled, false)
  if (node.type === 'checkbox') node.checked = value; else node.value = value
  node.dispatch('input')
}
const fill = (view, name, value) => input(field(view, name), value)
const edit = (view, name, value) => input(cf(view, name), value)
async function click(view, name) {
  const node = field(view, name); assert.ok(node, name); assert.equal(node.disabled, false, name + ': ' + status(view))
  node.click(); await idle(view)
}
async function action(view, name) {
  const node = cf(view, name); assert.ok(node, name); assert.equal(node.disabled, false, name + ': ' + status(view))
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
  spec.id = 'condition-field-controls'; spec.name = 'Condition field controls'
  spec.tasks[0].expected = 'PRIVATE EXPECTED SENTINEL'
  spec.decisions = 'Synthetic authoring and response-contract controls only; no external model was called.'
  return spec
}
async function prepare(view, original = fixture()) {
  fill(view, 'spec-json', JSON.stringify(original)); await click(view, 'apply-spec')
  assert.match(status(view), /Full specification applied/)
  await click(view, 'prepare-condition-fields')
  assert.equal(fieldsOf(view).rows.length, original.conditions.length)
  return original
}
async function select(view, id) {
  const row = fieldsOf(view).rows.find(row => row.id === id); assert.ok(row, id)
  edit(view, 'row', row.key); await idle(view)
}
async function setting(view, key, type, text) {
  await action(view, 'add-setting')
  const rows = () => [...field(view, 'condition-fields-editor').querySelectorAll('[data-condition-fields-setting-row]')]
  const last = name => rows().at(-1).querySelector('[data-condition-fields-' + name + ']')
  input(last('setting-key'), key); input(last('setting-type'), type)
  if (type !== 'null') input(last('setting-text'), text)
}
function mapping(view, name, segments) {
  const host = () => field(view, 'condition-fields-editor').querySelector('[data-condition-fields-path="' + name + '"]')
  const rows = () => [...host().querySelectorAll('[data-condition-fields-path-segment]')]
  input(host().querySelector('[data-condition-fields-path-mode]'), 'set')
  input(host().querySelector('[data-condition-fields-path-mapped]'), true)
  while (rows().length < segments.length) host().querySelector('[data-condition-fields-add-segment]').click()
  while (rows().length > segments.length) rows().at(-1).querySelector('[data-condition-fields-remove-segment]').click()
  segments.forEach((segment, index) => {
    input(rows()[index].querySelector('[data-condition-fields-segment-kind]'), typeof segment === 'number' ? 'index' : 'key')
    input(rows()[index].querySelector('[data-condition-fields-segment-text]'), String(segment))
  })
}
async function addHttp(view, id, modelId) {
  edit(view, 'new-id', id); edit(view, 'new-profile', 'http'); await action(view, 'add'); await select(view, id)
  edit(view, 'model-present', true); edit(view, 'provider-present', true); edit(view, 'model-id-present', true)
  edit(view, 'provider', 'example-lab'); edit(view, 'model-id', modelId)
  edit(view, 'label-present', true); edit(view, 'label', 'Requested ' + id)
  edit(view, 'settings-present', true)
  edit(view, 'url', 'https://adapter.example.invalid/' + id)
  await action(view, 'require-checks')
}
async function twoHttp(view) {
  const original = await prepare(view)
  await addHttp(view, 'model-a', 'alpha-v1')
  edit(view, 'credential-present', true); edit(view, 'credential-env', 'MODEL_A_TOKEN')
  edit(view, 'system-kind', 'text'); edit(view, 'system', 'Keep the supplied public request.\nReturn its answer.')
  await setting(view, 'temperature', 'number', '0')
  await setting(view, 'enabled', 'boolean', 'false')
  await setting(view, 'literal', 'string', '0')
  await setting(view, 'unset', 'null', '')
  await setting(view, 'limits', 'array', '[1,false]')
  await setting(view, 'options', 'object', '{"format":"compact"}')
  await addHttp(view, 'model-b', 'beta-v2')
  await setting(view, 'temperature', 'number', '0.7')
  mapping(view, 'provider', ['meta.with.dot', 0, 'provider'])
  mapping(view, 'id', ['meta.with.dot', 0, 'id'])
  mapping(view, 'status', ['generation', 'state'])
  await select(view, 'recorded'); await action(view, 'remove')
  assert.deepEqual(fieldsOf(view).rows.map(row => row.id), ['model-a', 'model-b'])
  return original
}
const raw = view => Object.fromEntries(['condition-fields', 'conditions', 'workflow-config', 'observation-plan', 'inputs', 'environment', 'decisions',
  'seed', 'replicates', 'attempts', 'total', 'timeout', 'duration', 'grading'].map(name => [name, field(view, name).value]))
const state = view => ({ spec: field(view, 'spec-json').value, raw: raw(view), dirty: view.dirty, undo: field(view, 'undo').hidden,
  task: field(view, 'task').value, frozen: field(view, 'frozen').textContent, results: field(view, 'results').innerHTML,
  readiness: field(view, 'readiness').innerHTML, exportDisabled: field(view, 'export').disabled })
async function draft(view) { await click(view, 'draft-export'); return JSON.parse(downloads.at(-1).contents) }
async function applyFields(view) {
  const calls = structuredClone(account.calls), loads = sourceLoads, count = downloads.length
  await click(view, 'apply-condition-fields')
  assert.deepEqual(account.calls, calls); assert.equal(sourceLoads, loads); assert.equal(downloads.length, count)
  assert.equal(networkCalls, 0)
  assert.deepEqual((await draft(view)).pending, [], status(view))
}
async function retain(name, data) {
  const root = process.env.RESEARCH_CONDITION_FIELDS_EVIDENCE_DIR
  if (!root) return
  await mkdir(root, { recursive: true }); await writeFile(resolve(root, name + '.json'), JSON.stringify(data, null, 2) + '\n')
}

beforeEach(() => {
  installed = installDomStandIn(globalThis); cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch'); networkCalls = 0
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => { networkCalls++; throw new Error('Network is forbidden in mounted condition authoring controls.') } })
  account = memoryAccount(); downloads = []; sourceLoads = 0
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
  if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor); else delete globalThis.fetch
  assert.equal(networkCalls, 0)
})

test('ordinary fields build two HTTPS conditions with exact manual schema and public request bytes while retaining scientific and reported-response gates', async () => {
  const view = await mount(), original = await twoHttp(view), beforeApply = await draft(view)
  assert.ok(beforeApply.pending.includes('conditionFields'))
  await applyFields(view)
  const applied = specOf(view), controls = system => ({ comparisonUnit: 'model', instructions: { system, developer: null }, tools: [],
    contextConstruction: 'frozen-public-request', sessionIsolation: 'fresh-request' })
  const conditions = [
    { id: 'model-a', label: 'Requested model-a', model: { provider: 'example-lab', id: 'alpha-v1', settings: {
      temperature: 0, enabled: false, literal: '0', unset: null, limits: [1, false], options: { format: 'compact' } } },
      adapter: { kind: 'http', url: 'https://adapter.example.invalid/model-a', credentialEnv: 'MODEL_A_TOKEN' },
      collection: controls('Keep the supplied public request.\nReturn its answer.') },
    { id: 'model-b', label: 'Requested model-b', model: { provider: 'example-lab', id: 'beta-v2', settings: { temperature: 0.7 } },
      adapter: { kind: 'http', url: 'https://adapter.example.invalid/model-b' }, collection: controls(null) },
  ]
  const observationPlan = observationPlanFromSpec()
  observationPlan.overrides = Object.fromEntries(conditions.map(condition => [condition.id, {
    identity: { policy: 'require-match', fields: ['provider', 'id'] }, completion: { policy: 'require-complete' },
    mapping: condition.id === 'model-a'
      ? { identity: { provider: ['identity', 'provider'], id: ['identity', 'id'] }, completion: { status: ['completion', 'status'] } }
      : { identity: { provider: ['meta.with.dot', 0, 'provider'], id: ['meta.with.dot', 0, 'id'] }, completion: { status: ['generation', 'state'] } },
  }]))
  const manual = { ...structuredClone(original), conditions, observationPlan }
  assert.deepEqual(applied, manual)
  validateStudy(manual)
  assert.equal(fieldsOf(view).rows.every(row => row.sourceId === row.id), true, 'Apply creates a fresh bound roster.')
  const project = await freezeStudy(await bindRuntimeSources(applied, sources))
  const readiness = evaluateReadiness(project)
  assert.equal(readiness.eligible, false)
  assert.ok(readiness.blockers.some(row => row.code === 'independent-oracle-required'))
  assert.ok(!readiness.blockers.some(row => ['collection-controls-required', 'requested-context-unsupported', 'reported-identity-required', 'reported-completion-required'].includes(row.code)))
  const requests = []
  for (const condition of conditions) {
    const trial = project.schedule.find(row => row.conditionId === condition.id), task = project.tasks.find(row => row.id === trial.taskId)
    const request = collectionRequest(project, condition, task, trial, 1)
    const expected = { version: 1, projectSha256: project.sha256, trial, attempt: 1, prompt: task.compiled.text, input: task.input ?? null,
      model: condition.model, collection: condition.collection }
    assert.equal(canonical(request), canonical(expected)); requests.push(request)
    assert.doesNotMatch(canonical(request), /PRIVATE EXPECTED SENTINEL|MODEL_A_TOKEN/)
    assert.deepEqual(observationContract(applied, condition).identity, { policy: 'require-match', fields: ['provider', 'id'] })
    const reported = (provider = condition.model.provider, completion = 'complete') => ({ output: 'Explicit synthetic response',
      ...(condition.id === 'model-a' ? { identity: { provider, id: condition.model.id }, completion: { status: completion } }
        : { 'meta.with.dot': [{ provider, id: condition.model.id }], generation: { state: completion } }) })
    const response = reported()
    assert.equal(observeResponse(applied, condition, response).eligible, true)
    const missing = observeResponse(applied, condition, { output: response.output })
    assert.equal(missing.eligible, false); assert.ok(missing.ineligibility.includes('identity-unavailable')); assert.ok(missing.ineligibility.includes('completion-unverified'))
    const mismatch = observeResponse(applied, condition, reported('different'))
    assert.equal(mismatch.eligible, false); assert.ok(mismatch.ineligibility.includes('identity-mismatch'))
    const incomplete = observeResponse(applied, condition, reported(condition.model.provider, 'incomplete'))
    assert.equal(incomplete.eligible, false); assert.ok(incomplete.ineligibility.includes('incomplete-generation'))
    assert.equal(observeResponse(applied, condition, response).usage.outputTokens.status, 'unavailable')
  }
  await click(view, 'freeze')
  assert.equal(field(view, 'export').disabled, false); assert.equal(field(view, 'run').disabled, true)
  assert.equal(specOf(view).executionPlan.purpose, 'experiment'); assert.equal(specOf(view).requirementPlan, undefined)
  await retain('two-http-manual-spec', manual); await retain('two-http-public-requests', requests); await retain('two-http-readiness', readiness)
})

test('joint field Apply has page Undo for exact raw fields and never overwrites stale expert conditions including whitespace-only changes', async () => {
  const view = await mount(), original = await twoHttp(view), before = await draft(view)
  const rawBefore = raw(view)
  await applyFields(view); const applied = specOf(view)
  await click(view, 'undo')
  assert.deepEqual(specOf(view), original); assert.deepEqual(raw(view), rawBefore)
  assert.deepEqual((await draft(view)).pending, before.pending)
  await applyFields(view); assert.deepEqual(specOf(view), applied)
  await select(view, 'model-a'); edit(view, 'model-id', 'unsaved-new-model')
  const rawDraft = rawFields(view)
  fill(view, 'conditions', field(view, 'conditions').value + '\n ')
  const stale = state(view), count = downloads.length, calls = structuredClone(account.calls)
  await click(view, 'apply-condition-fields')
  assert.deepEqual(state(view), stale)
  assert.equal(rawFields(view), rawDraft)
  assert.match(status(view), /stale|changed|prepared|binding/i)
  assert.equal(downloads.length, count); assert.deepEqual(account.calls, calls)
  await retain('stale-whitespace-refusal', { status: status(view), raw: raw(view), spec: specOf(view) })
})

test('blank and malformed typed settings refuse atomically and preserve raw text across saved cold drafts and account/project switches', async () => {
  const view = await mount(); await twoHttp(view); await select(view, 'model-a')
  const rowNode = () => field(view, 'condition-fields-editor').querySelector('[data-condition-fields-setting-row]')
  input(rowNode().querySelector('[data-condition-fields-setting-text]'), '')
  const invalid = state(view), rawDraft = rawFields(view)
  await click(view, 'apply-condition-fields')
  assert.deepEqual(state(view), invalid); assert.match(status(view), /number|finite|blank|complete/i)
  assert.equal(fieldsOf(view).rows.find(row => row.id === 'model-a').model.settings[0].text, '')
  await click(view, 'save'); const saved = canonical([...account.values]), pending = (await draft(view)).pending
  const cold = await mount()
  assert.equal(rawFields(cold), rawDraft); assert.deepEqual((await draft(cold)).pending, pending)
  await select(cold, 'model-a')
  assert.equal(cf(cold, 'id').value, 'model-a')
  const same = state(cold); await click(cold, 'apply-condition-fields'); assert.deepEqual(state(cold), same)
  await cold.setContext(B, 'live'); await idle(cold)
  assert.equal(rawFields(cold), ''); assert.doesNotMatch(field(cold, 'condition-fields-editor').textContent, /alpha-v1|model-a/)
  const separateAccount = memoryAccount(), isolated = await mount({ account: separateAccount })
  assert.equal(rawFields(isolated), ''); assert.equal(separateAccount.calls.writes, 0)
  await cold.setContext(A, 'live'); await idle(cold)
  assert.equal(rawFields(cold), rawDraft); assert.deepEqual((await draft(cold)).pending, pending)
  assert.equal(canonical([...account.values]), saved)
  await select(cold, 'model-a')
  const settingInput = () => field(cold, 'condition-fields-editor').querySelector('[data-condition-fields-setting-text]')
  for (const text of ['1e', '0x10', '1e999']) {
    input(settingInput(), text); const current = state(cold)
    await click(cold, 'apply-condition-fields'); assert.deepEqual(state(cold), current)
    assert.equal(fieldsOf(cold).rows.find(row => row.id === 'model-a').model.settings[0].text, text)
  }
  input(settingInput(), '0'); await applyFields(cold)
  assert.equal(specOf(cold).conditions[0].model.settings.temperature, 0)
  await retain('cold-invalid-fields', { fields: JSON.parse(rawDraft), pending })
})

test('source changes and unrelated pending task input refuse existing condition fields without corrupting their prior Undo', async () => {
  const view = await mount(); await twoHttp(view)
  fill(view, 'input', '{ unfinished private task input')
  const before = state(view)
  await click(view, 'apply-condition-fields')
  assert.deepEqual(state(view), before); assert.match(status(view), /Apply the current input edits first/)
  assert.equal(field(view, 'input').value, '{ unfinished private task input')
  fill(view, 'input', '{"changedPublicInput":true}')
  await click(view, 'apply-input')
  const changed = state(view)
  await click(view, 'apply-condition-fields')
  assert.deepEqual(state(view), changed); assert.match(status(view), /stale|changed|prepared|binding/i)
  await click(view, 'undo')
  assert.equal(rawFields(view), '', 'Failed Apply did not overwrite the existing Prepare Undo state.')
  assert.deepEqual(specOf(view), fixture())
})

test('workflow assignment fields require explicit envelope and stage-map setup and an empty map never becomes a successful recorded answer', async () => {
  const view = await mount(), original = fixture(); original.executionPlan = { version: 1, purpose: 'recorded-diagnostic' }
  await prepare(view, original)
  await click(view, 'seed-workflow'); await click(view, 'seed-observations')
  const workflow = JSON.parse(field(view, 'workflow-config').value), observation = JSON.parse(field(view, 'observation-plan').value)
  await click(view, 'prepare-condition-fields'); await select(view, 'recorded')
  edit(view, 'workflow-id', 'prompt-flow'); edit(view, 'replay-mode', 'envelope')
  const missing = state(view)
  await click(view, 'apply-condition-fields')
  assert.deepEqual(state(view), missing); assert.match(status(view), /workflow.*map|workflow.*responses|stage.*map|stage.*fixtures/i)
  await action(view, 'initialize-stage-map')
  assert.deepEqual(fieldsOf(view).rows[0].adapter.workflowResponses, { present: true, text: '{}' })
  await applyFields(view)
  const applied = specOf(view)
  assert.deepEqual(applied.workflowPlan, workflow.plan); assert.deepEqual(applied.observationPlan, observation)
  assert.equal(applied.conditions[0].workflowId, 'prompt-flow'); assert.equal(applied.conditions[0].adapter.mode, 'envelope')
  assert.deepEqual(applied.conditions[0].adapter.workflowResponses, {})
  assert.deepEqual(applied.conditions[0].adapter.responses, original.conditions[0].adapter.responses)
  assert.equal(applied.executionPlan.purpose, 'recorded-diagnostic')
  await click(view, 'freeze'); assert.equal(field(view, 'run').disabled, false)
  await click(view, 'run'); await click(view, 'export-evidence')
  const evidence = JSON.parse(downloads.at(-1).contents)
  assert.equal(evidence.summary.completed, 0); assert.equal(evidence.summary.failed, 1)
  assert.match(JSON.stringify(evidence.events), /No recorded workflow response for .*\/answer/)
  assert.ok(evidence.events.every(row => row.type !== 'finished' || row.grade === undefined))
  await retain('workflow-empty-stage-journal', evidence)
})

test('explicit Prepare and view-only condition selection preserve a frozen recorded journal without source loads or account writes', async () => {
  const view = await mount(), original = newExperimentDraft(genericStarter(), { purpose: 'recorded-diagnostic', initializePopulation: true })
  fill(view, 'spec-json', JSON.stringify(original)); await click(view, 'apply-spec')
  await click(view, 'freeze'); await click(view, 'run'); await click(view, 'export-evidence')
  const evidence = JSON.parse(downloads.at(-1).contents)
  assert.equal(evidence.summary.completed, 2)
  const frozen = field(view, 'frozen').textContent, results = field(view, 'results').innerHTML, applied = specOf(view)
  const calls = structuredClone(account.calls), loads = sourceLoads
  await click(view, 'prepare-condition-fields')
  assert.equal(field(view, 'frozen').textContent, frozen); assert.equal(field(view, 'results').innerHTML, results)
  assert.deepEqual(specOf(view), applied); assert.equal(field(view, 'export-evidence').disabled, false)
  const beforeSelection = rawFields(view), pending = (await draft(view)).pending
  await select(view, 'recorded')
  assert.equal(rawFields(view), beforeSelection); assert.deepEqual((await draft(view)).pending, pending)
  assert.equal(sourceLoads, loads); assert.deepEqual(account.calls, calls)
  await click(view, 'export-evidence'); assert.deepEqual(JSON.parse(downloads.at(-1).contents), evidence)
  await retain('prepare-preserved-recorded-journal', evidence)
})

async function addCommand(view, id, path) {
  edit(view, 'new-id', id); edit(view, 'new-profile', 'command'); await action(view, 'add'); await select(view, id)
  edit(view, 'command', 'node'); edit(view, 'provider', 'synthetic-local-program'); edit(view, 'model-id', id)
  await action(view, 'add-arg'); edit(view, 'arg', path)
}
// Same independent stored-ZIP reader used by research-benchmark-readiness-ui.
// Assertions below compare decoded fields and short source strings, never ZIP bytes.
function commandExportFiles(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder(), files = {}
  let offset = 0
  while (data.getUint32(offset, true) === 0x04034b50) {
    assert.equal(data.getUint16(offset + 8, true), 0)
    const size = data.getUint32(offset + 18, true), nameSize = data.getUint16(offset + 26, true), extraSize = data.getUint16(offset + 28, true)
    const start = offset + 30, body = start + nameSize + extraSize
    files[decoder.decode(bytes.subarray(start, start + nameSize))] = decoder.decode(bytes.subarray(body, body + size)); offset = body + size
  }
  return files
}

test('command fields apply and undo, retain the existing collection declaration, and export pinned attached programs without admission', async () => {
  const view = await mount(); await prepare(view)
  const attachments = {
    'adapters/reference-program.mjs': "process.stdout.write(JSON.stringify({ output: 'synthetic reference' }))\n",
    'adapters/model-cli.mjs': "process.stdout.write(JSON.stringify({ output: 'synthetic model' }))\n",
  }
  for (const [path, contents] of Object.entries(attachments)) {
    fill(view, 'attachment-path', path); fill(view, 'attachment-text', contents); await click(view, 'attach')
    assert.equal(specOf(view).inputs.find(row => row.path === path).sha256, await sha256(contents))
  }
  await click(view, 'prepare-condition-fields')
  const calls = structuredClone(account.calls), loads = sourceLoads
  await addCommand(view, 'reference-program', 'adapters/reference-program.mjs')
  await addCommand(view, 'model-cli', 'adapters/model-cli.mjs')
  edit(view, 'env-present', true); await action(view, 'add-env'); edit(view, 'env-name', 'HOME')
  assert.deepEqual(account.calls, calls); assert.equal(sourceLoads, loads)
  const before = specOf(view), rawBefore = raw(view)
  await applyFields(view)
  const applied = specOf(view)
  assert.deepEqual(applied.conditions.find(row => row.id === 'reference-program').adapter,
    { kind: 'command', command: 'node', args: ['adapters/reference-program.mjs'] })
  assert.deepEqual(applied.conditions.find(row => row.id === 'model-cli').adapter,
    { kind: 'command', command: 'node', args: ['adapters/model-cli.mjs'], env: ['HOME'] })
  await click(view, 'undo'); assert.deepEqual(specOf(view), before); assert.deepEqual(raw(view), rawBefore)
  await applyFields(view); assert.deepEqual(specOf(view), applied)

  // The established Conditions (JSON) path authors R2's full collection
  // declaration. RP5 adds command fields, not a new collection contract/editor.
  const collection = { comparisonUnit: 'model', instructions: { system: null, developer: null }, tools: [],
    contextConstruction: 'frozen-public-request', sessionIsolation: 'fresh-request' }
  const declarations = structuredClone(applied.conditions)
  declarations.find(row => row.id === 'model-cli').collection = collection
  fill(view, 'conditions', JSON.stringify(declarations)); await click(view, 'apply-protocol')
  assert.deepEqual(specOf(view).conditions, declarations)
  await click(view, 'prepare-condition-fields'); await select(view, 'model-cli')
  assert.equal(cf(view, 'profile').value, 'command')
  edit(view, 'label-present', true); edit(view, 'label', 'Retained collection declaration')
  await applyFields(view)
  assert.deepEqual(specOf(view).conditions.find(row => row.id === 'model-cli').collection, collection)
  await click(view, 'freeze')
  assert.equal(field(view, 'export').disabled, false)
  assert.equal(field(view, 'run').disabled, true, 'authoring a local command does not authorize the in-page runner')
  const project = await freezeStudy(specOf(view))
  assert.ok(evaluateReadiness(project).blockers.some(row => row.code === 'collector-unsupported'))
  await click(view, 'export')
  const files = commandExportFiles(downloads.at(-1).contents), exported = JSON.parse(files['project.json'])
  assert.deepEqual(exported.spec.conditions, specOf(view).conditions)
  assert.deepEqual(exported.runtimeFiles, RUNTIME_FILES)
  for (const [path, contents] of Object.entries(attachments)) {
    assert.equal(files[path], contents)
    assert.equal(exported.spec.inputs.find(row => row.path === path).sha256, await sha256(contents))
  }
  assert.equal(account.calls.writes, 0); assert.equal(networkCalls, 0)

  const wrongPins = structuredClone(specOf(view).inputs)
  wrongPins.find(row => row.path === 'adapters/model-cli.mjs').sha256 = '0'.repeat(64)
  fill(view, 'inputs', JSON.stringify(wrongPins)); await click(view, 'apply-protocol'); await click(view, 'freeze')
  assert.match(status(view), /attached contents disagree with the input manifest/)
  assert.equal(field(view, 'export').disabled, true)
})

test('invalid command drafts remain editable after refusal, cold save and project/account switches', async () => {
  const view = await mount(); await prepare(view); await addCommand(view, 'model-cli', 'adapters/model-cli.mjs')
  edit(view, 'credential-present', true)
  const invalid = state(view), text = rawFields(view)
  await click(view, 'apply-condition-fields')
  assert.deepEqual(state(view), invalid); assert.match(status(view), /credential.*variable/i)
  await click(view, 'save')
  const saved = canonical([...account.values]), cold = await mount()
  assert.equal(rawFields(cold), text); await select(cold, 'model-cli')
  assert.equal(cf(cold, 'credential-present').checked, true); assert.equal(cf(cold, 'credential-env').disabled, false)
  await cold.setContext(B, 'live'); await idle(cold)
  assert.equal(rawFields(cold), '')
  const separate = memoryAccount(), isolated = await mount({ account: separate })
  assert.equal(rawFields(isolated), ''); assert.equal(separate.calls.writes, 0)
  await cold.setContext(A, 'live'); await idle(cold); await select(cold, 'model-cli')
  assert.equal(rawFields(cold), text); assert.equal(canonical([...account.values]), saved)
  edit(cold, 'credential-env', 'SYNTHETIC_CREDENTIAL_NAME')
  edit(cold, 'env-present', true); await action(cold, 'add-env')
  const incompleteList = state(cold)
  await click(cold, 'apply-condition-fields')
  assert.deepEqual(state(cold), incompleteList); assert.match(status(cold), /environment|variable/i)
  assert.equal(cf(cold, 'env-present').checked, true); assert.equal(cf(cold, 'env-present').disabled, true)
  assert.equal(cf(cold, 'env-name').disabled, false)
  await action(cold, 'remove-env'); edit(cold, 'env-present', false); await applyFields(cold)
  assert.equal(specOf(cold).conditions.find(row => row.id === 'model-cli').adapter.credentialEnv, 'SYNTHETIC_CREDENTIAL_NAME')
  await select(cold, 'model-cli')
  edit(cold, 'command', 'changed-draft-only')
  fill(cold, 'conditions', field(cold, 'conditions').value + '\n ')
  const stale = state(cold)
  await click(cold, 'apply-condition-fields')
  assert.deepEqual(state(cold), stale); assert.match(status(cold), /stale|changed|prepared|binding/i)
})
