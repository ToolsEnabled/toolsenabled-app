import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import { resolve } from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { compilePrompt } from '../../src/benchmark/prompts.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { informationFixture } from './fixtures/research-benchmark-information.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
let installed, cryptoDescriptor, account, downloads
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const control = (view, name) => field(view, 'information-fields-editor').querySelector('[data-information-fields-' + name + ']')
const status = view => field(view, 'status').textContent
const specOf = view => JSON.parse(field(view, 'spec-json').value)
const fieldsOf = view => JSON.parse(field(view, 'information-fields').value)
const packetOf = view => JSON.parse(field(view, 'information-packet').textContent)
async function until(predicate, message = 'Information fields did not settle.') {
  for (let i = 0; i < 800; i++) { if (predicate()) return; await pause() }
  assert.fail(message)
}
async function idle(view) { await until(() => view.el.getAttribute('aria-busy') === 'false', status(view)) }
function input(node, value) {
  assert.ok(node, 'The actual field control exists.'); assert.equal(node.disabled, false)
  if (node.type === 'checkbox') node.checked = value; else node.value = value
  node.dispatch('input')
}
const fill = (view, name, value) => input(field(view, name), value)
const edit = (view, name, value) => input(control(view, name), value)
async function click(view, name) {
  const button = field(view, name); assert.ok(button, name); assert.equal(button.disabled, false, name + ': ' + status(view))
  button.click(); await idle(view)
}
function press(view, name) {
  const button = control(view, name); assert.ok(button, name); assert.equal(button.disabled, false, name)
  button.click()
  assert.equal(control(view, 'error'), null, 'An ordinary component action must not silently fail.')
}
function withhold(view, path) {
  const node = [...field(view, 'information-fields-editor').querySelectorAll('[data-information-fields-withhold]')]
    .find(node => node.getAttribute('data-information-fields-path') === path)
  input(node, true)
}
function addReading(view, id, source = 'baseline') {
  edit(view, 'source', source); press(view, 'add-reading')
  edit(view, 'reading-id', id); edit(view, 'reading-rationale', 'Synthetic explicitly declared reading ' + id + '.')
}
function addOverride(view, path, name, value) {
  const key = JSON.stringify([path, name]), select = control(view, 'parameter')
  assert.ok([...select.children].some(option => option.value === key), 'The occurrence and typed parameter are offered by the real selector.')
  input(select, key); press(view, 'add-edit')
  const values = [...field(view, 'information-fields-editor').querySelectorAll('[data-information-fields-edit-value]')]
  input(values.at(-1), value)
}
function declare(view, value) { edit(view, 'expected-mode', 'declare'); edit(view, 'expected-text', JSON.stringify(value)) }
function memoryAccount() {
  const values = new Map()
  return { values, async getSetting(key) { return { ok: true, value: values.get(key) ?? null } },
    async putSetting(key, value) { values.set(key, value); return { ok: true } } }
}
async function mount(overrides = {}) {
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources,
    download: (name, contents) => downloads.push({ name, contents }), ...overrides })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); return view
}
async function importDraft(view, value) {
  const text = JSON.stringify(value), node = field(view, 'import')
  node.files = [{ name: 'synthetic-information-fields.json', size: Buffer.byteLength(text), text: async () => text }]
  node.dispatch('change'); await idle(view); assert.match(status(view), /Draft imported/)
}
async function draft(view) { await click(view, 'draft-export'); return JSON.parse(downloads.at(-1).contents) }
async function retain(name, value) {
  const directory = process.env.RESEARCH_BENCHMARK_INFORMATION_FIELDS_EVIDENCE
  if (!directory) return
  await mkdir(directory, { recursive: true }); await writeFile(resolve(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n')
}
function fixture(kind = 'number') {
  const spec = newExperimentDraft(genericStarter(), { purpose: 'recorded-diagnostic', initializePopulation: true })
  const value = kind === 'number' ? 1 : true
  spec.id = 'information-fields-' + kind; spec.name = 'Synthetic explicit ' + kind + ' readings'; spec.requireReview = true
  spec.catalog = [{ id: 'answer', version: '1', kind: 'atom', text: 'Return {{value}}.', parameters: { value },
    parameterSchema: { value: { type: kind } }, semantics: { kind: 'constant', value: '{{value}}' } }]
  spec.tasks = [{ id: 'scalar-task', familyId: 'scalar-family', root: { use: 'answer', params: { value } },
    input: { retained: 'input' }, expected: value, split: 'development' }]
  spec.protocol.grading = { kind: 'json' }; spec.conditions[0].adapter.responses = { 'scalar-task': value }
  return spec
}
async function preparedScalar(view, kind = 'number') {
  await importDraft(view, fixture(kind)); await click(view, 'prepare-information-fields')
  assert.match(status(view), /Information fields prepared/)
  assert.equal(fieldsOf(view).readings.length, 0, 'Preparing does not invent a baseline reading.')
  edit(view, 'rationale', 'Synthetic omission of a scalar; only the declared alternatives are covered.')
  withhold(view, 'root')
}
const uiState = view => ({ dirty: view.dirty, undoHidden: field(view, 'undo').hidden,
  frozen: field(view, 'frozen').textContent, exportDisabled: field(view, 'export').disabled,
  evidenceDisabled: field(view, 'export-evidence').disabled, results: field(view, 'results').innerHTML })
async function refusal(view, expression) {
  const before = await draft(view), ui = uiState(view)
  await click(view, 'apply-information-fields'); assert.match(status(view), expression)
  assert.deepEqual(await draft(view), before, 'Failed publication preserves exact applied spec, all raw editors and pending groups.')
  assert.deepEqual(uiState(view), ui, 'Failure does not replace Undo, evidence or applied state.')
  return before
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

test('fields build distinct quantity readings on the actual 17-node operational tree only after explicit LEAN derivation', async () => {
  const view = await mount(); field(view, 'starter').value = 'lean-operational'; await click(view, 'use-starter')
  await click(view, 'prepare-information-fields')
  const original = structuredClone(specOf(view)), base = original.tasks[0]
  assert.equal((await compilePrompt(original.catalog, base.root)).nodeCount, 17)
  assert.equal(fieldsOf(view).readings.length, 0); assert.deepEqual(fieldsOf(view).withheldPaths, [])
  edit(view, 'family', 'declared-quantity-family'); edit(view, 'rationale', 'Synthetic local quantity omission in a nested composition.')
  withhold(view, 'root/child1/buy_process')
  for (const quantity of [2, 3]) {
    addReading(view, 'shares-' + quantity); addOverride(view, ['child1', 'buy_process'], 'quantity', String(quantity))
    assert.equal(control(view, 'expected-mode').value, '', 'The component requires an explicit policy instead of reusing the source answer.')
    assert.deepEqual(fieldsOf(view).readings.at(-1).expected, { mode: '', text: '' })
    if (quantity === 2) await refusal(view, /Choose retained, declare, or supported LEAN derivation/)
    edit(view, 'expected-mode', 'derive-lean')
  }
  const prior = await draft(view)
  await click(view, 'apply-information-fields'); assert.match(status(view), /Information treatment built from fields/)
  const built = specOf(view), task = built.tasks[0]
  assert.equal(field(view, 'information-fields').value, ''); assert.deepEqual((await draft(view)).pending, [])
  assert.deepEqual(task.root, base.root); assert.deepEqual(task.input, base.input); assert.deepEqual(task.expected, base.expected)
  assert.equal(task.familyId, 'declared-quantity-family'); assert.equal(task.information.scope, 'declared-set')
  assert.deepEqual(task.information.withheldPaths, ['root/child1/buy_process'])
  for (const [index, quantity] of [2, 3].entries()) {
    const reading = task.information.readings[index], expectedRoot = structuredClone(base.root)
    expectedRoot.slots.child1.slots.buy_process.params = { ...(expectedRoot.slots.child1.slots.buy_process.params || {}), quantity }
    assert.deepEqual(reading.root, expectedRoot, 'Every other nested branch remains byte-for-byte data equivalent.')
    assert.equal((await compilePrompt(built.catalog, reading.root)).nodeCount, 17)
    assert.ok(reading.expected.orders.some(order => order.quantity === quantity))
  }
  assert.notDeepEqual(task.information.readings[0].expected, task.information.readings[1].expected)
  await click(view, 'prepare-information')
  const packet = packetOf(view); assert.equal(packet.version, 2); assert.equal(packet.observableClasses.length, 2)
  assert.deepEqual(packet.readings.map(reading => reading.id), ['shares-2', 'shares-3'])
  assert.equal(built.executionPlan.purpose, 'experiment'); assert.equal(built.requireReview, true)
  assert.deepEqual(built.reviews || [], original.reviews || []); assert.deepEqual(built.taskReviews || [], [])
  assert.equal(built.requirementPlan, undefined); assert.equal(field(view, 'export-evidence').disabled, true)
  await click(view, 'freeze'); assert.equal(field(view, 'export').disabled, true); assert.match(status(view), /review/i)
  await retain('nested-quantity-fields', { prior, built, packet, freezeRefusal: status(view) })
})

test('generic fields retain zero and false as typed values and require investigator-declared numeric and boolean answers', async () => {
  const outcomes = []
  for (const [kind, value] of [['number', 0], ['boolean', false]]) {
    const view = await mount(); await preparedScalar(view, kind)
    addReading(view, 'unchanged-source')
    addReading(view, 'explicit-alternative'); addOverride(view, [], 'value', String(value))
    assert.equal(control(view, 'expected-mode').value, '')
    assert.ok(![...control(view, 'expected-mode').children].some(option => option.value === 'derive-lean'))
    await refusal(view, /Choose retained, declare, or supported LEAN derivation/)
    declare(view, value)
    await click(view, 'apply-information-fields'); assert.match(status(view), /Information treatment built from fields/)
    const built = specOf(view), reading = built.tasks[0].information.readings[1]
    assert.equal(reading.root.params.value, value); assert.equal(typeof reading.root.params.value, kind)
    assert.equal(reading.expected, value); assert.equal(typeof reading.expected, kind)
    assert.equal(built.tasks[0].information.readings[0].expected, kind === 'number' ? 1 : true)
    assert.equal(built.executionPlan.purpose, 'recorded-diagnostic'); assert.deepEqual(built.taskReviews || [], [])
    await click(view, 'prepare-information'); const packet = packetOf(view)
    assert.equal(packet.observableClasses.length, 2); assert.equal(packet.readings[1].expected, value)
    outcomes.push({ kind, built, packet })
  }
  await retain('generic-explicit-scalars', outcomes)
})

test('partial numbers and JSON refuse atomically; Prepare retains field edits while explicit Reset and Undo remain lossless', async () => {
  const view = await mount(); await preparedScalar(view)
  addReading(view, 'partial-reading'); addOverride(view, [], 'value', '1e'); declare(view, 0)
  const partial = await refusal(view, /Finish the finite numeric local parameter value/)
  const raw = field(view, 'information-fields').value
  await click(view, 'prepare-information-fields'); assert.equal(field(view, 'information-fields').value, raw)
  assert.deepEqual(specOf(view), partial.spec)
  input(control(view, 'edit-value'), '0'); edit(view, 'expected-text', '{unfinished expected')
  await refusal(view, /Declare one valid JSON expected observation/)
  edit(view, 'expected-text', '0'); edit(view, 'conventions-included', true); edit(view, 'conventions', '{unfinished conventions')
  const beforeReset = await refusal(view, /Conventions must be valid JSON/)
  await click(view, 'reset-information-fields')
  assert.equal(fieldsOf(view).readings.length, 0); assert.deepEqual(fieldsOf(view).withheldPaths, [])
  await click(view, 'undo'); assert.match(status(view), /Previous draft restored/)
  assert.deepEqual(await draft(view), beforeReset)
  await retain('partial-reset-undo', { partial, beforeReset, restored: await draft(view) })
})

test('changing the applied input makes retained fields stale; inspection cannot silently rebind them to a new source', async () => {
  const view = await mount(); await preparedScalar(view); addReading(view, 'baseline')
  const raw = field(view, 'information-fields').value, binding = fieldsOf(view).bindingSha256
  fill(view, 'input', '{"retained":"changed input"}'); await click(view, 'apply-input')
  assert.deepEqual(specOf(view).tasks[0].input, { retained: 'changed input' })
  await refusal(view, /Information fields are stale/)
  await click(view, 'prepare-information-fields')
  assert.equal(field(view, 'information-fields').value, raw); assert.equal(fieldsOf(view).bindingSha256, binding)
  assert.equal(control(view, 'rationale').disabled, true, 'Reinspection leaves stale controls read-only.')
  await refusal(view, /Information fields are stale/)
  await click(view, 'reset-information-fields')
  assert.notEqual(fieldsOf(view).bindingSha256, binding); assert.equal(fieldsOf(view).readings.length, 0)
  assert.equal(control(view, 'rationale').disabled, false)
  await retain('stale-input-refusal', { raw, refreshed: await draft(view) })
})

test('explicit Reset recovers malformed raw or decoded field drafts and Undo preserves the exact rejected text', async () => {
  const outcomes = []
  for (const malformed of ['syntax', 'reading', 'edit', 'path']) {
    const view = await mount(); await preparedScalar(view); addReading(view, 'retained')
    const valid = fieldsOf(view), bad = structuredClone(valid)
    if (malformed === 'reading') bad.readings = [null]
    if (malformed === 'edit') bad.readings[0].edits = [null]
    if (malformed === 'path') bad.readings[0].edits = [{ path: 'root', parameter: 'value', kind: 'number', text: '0' }]
    const raw = malformed === 'syntax' ? '{ unfinished raw information field draft\n' : JSON.stringify(bad, null, 2)
    fill(view, 'information-fields', raw)
    if (malformed !== 'syntax') {
      assert.match(control(view, 'error').textContent, /invalid reading or local-edit shape/)
      assert.equal(control(view, 'add-reading'), null, 'Malformed retained rows cannot be overwritten by publishing a partially rendered roster.')
    }
    const prior = await refusal(view, malformed === 'syntax' ? /Information fields.*valid JSON/ : /Information reading fields|Local reading edit|exact occurrence/)
    if (malformed === 'syntax') {
      await click(view, 'prepare-information-fields'); assert.match(status(view), /Information fields.*valid JSON/)
      assert.deepEqual(await draft(view), prior)
    }
    await click(view, 'reset-information-fields'); assert.match(status(view), /Information fields prepared/)
    assert.equal(fieldsOf(view).readings.length, 0); assert.equal(fieldsOf(view).bindingSha256, valid.bindingSha256)
    assert.equal(control(view, 'rationale').disabled, false)
    await click(view, 'undo'); assert.match(status(view), /Previous draft restored/)
    assert.equal(field(view, 'information-fields').value, raw); assert.deepEqual(await draft(view), prior)
    outcomes.push({ malformed, prior, restored: await draft(view) })
  }
  await retain('malformed-reset-undo', outcomes)
})

test('existing advanced reading roots, variables, conventions and optional presence survive a no-op field build and exact Undo', async () => {
  const view = await mount(), spec = newExperimentDraft(informationFixture(), { purpose: 'recorded-diagnostic', initializePopulation: true })
  spec.tasks[0].variables = { shared: 'retained task variable' }
  const information = spec.tasks[0].information
  information.responseMode = 'tagged-json'; information.readingPool = information.readings; delete information.readings
  information.readingPool[0].variables = { shared: 'reading-local', unused: 0 }
  information.readingPool[0].conventions = { sign: false, zero: 0, text: '' }; information.readingPool[0].label = ''
  information.readingPool[1].variables = { private: true }
  await importDraft(view, spec); await click(view, 'prepare-information-fields')
  const before = await draft(view), originalTask = structuredClone(specOf(view).tasks[0])
  assert.equal(control(view, 'selection').value, 'readingPool'); assert.equal(control(view, 'response-mode').value, 'tagged-json')
  assert.equal(control(view, 'label-included').checked, true); assert.equal(control(view, 'reading-label').value, '')
  assert.deepEqual(JSON.parse(control(view, 'conventions').value), { sign: false, zero: 0, text: '' })
  await click(view, 'save'); const savedRaw = field(view, 'information-fields').value
  edit(view, 'reading', fieldsOf(view).readings[1].key)
  assert.equal(view.dirty, false, 'Reading selection is navigation, not a pending authoring change.')
  assert.equal(field(view, 'information-fields').value, savedRaw)
  assert.equal(control(view, 'label-included').checked, false); assert.equal(control(view, 'conventions-included').checked, false)
  await click(view, 'apply-information-fields'); assert.match(status(view), /Information treatment built from fields/)
  assert.deepEqual(specOf(view).tasks[0], originalTask)
  assert.equal(field(view, 'information-fields').value, ''); assert.equal(field(view, 'export-evidence').disabled, true)
  await click(view, 'undo'); assert.deepEqual(await draft(view), before)
  await retain('advanced-noop-and-undo', { before, originalTask, restored: await draft(view) })
})

test('pending fields and expert text survive Save and remount, refuse mixed publication and remain scoped to project and account', async () => {
  const view = await mount(); await preparedScalar(view); addReading(view, 'unfinished')
  addOverride(view, [], 'value', '1e'); edit(view, 'reading-rationale', 'Unfinished investigator text retained exactly.')
  fill(view, 'conditions', '[unfinished condition JSON')
  const before = await refusal(view, /Apply the current protocol edits first/)
  await click(view, 'prepare-information-fields'); assert.match(status(view), /Apply the current protocol edits first/)
  assert.deepEqual(await draft(view), before)
  await click(view, 'save'); const restored = await mount()
  assert.deepEqual(await draft(restored), before)
  await click(restored, 'freeze'); assert.match(status(restored), /pending editor changes/)
  await restored.setContext(B, 'live'); await idle(restored)
  assert.equal(field(restored, 'information-fields').value, ''); assert.notEqual(field(restored, 'conditions').value, '[unfinished condition JSON')
  await restored.setContext(A, 'live'); await idle(restored); assert.deepEqual(await draft(restored), before)
  Object.assign(account, memoryAccount()); await restored.setContext(A, 'live', { reload: true }); await idle(restored)
  const newAccount = await draft(restored)
  assert.equal(field(restored, 'information-fields').value, ''); assert.deepEqual(newAccount.pending, [])
  assert.equal(field(restored, 'undo').hidden, true); assert.equal(field(restored, 'export-evidence').disabled, true)
  assert.equal(control(restored, 'reading-id'), null)
  await retain('pending-remount-and-isolation', { before, newAccount })
})

test('new starter and imported draft replacements clear private information fields while Undo restores their exact pending source', async () => {
  const outcomes = []
  for (const replacement of ['starter', 'import']) {
    const view = await mount(); await preparedScalar(view); addReading(view, 'private-source')
    edit(view, 'reading-rationale', 'PRIVATE_SYNTHETIC_READING_TEXT_RETAIN_ONLY_WITH_THIS_DRAFT')
    addOverride(view, [], 'value', '1e'); fill(view, 'input', '{ unfinished input before replacement')
    const before = await draft(view), oldControl = control(view, 'reading-rationale')
    if (replacement === 'starter') { field(view, 'starter').value = 'generic'; await click(view, 'use-starter') }
    else await importDraft(view, fixture('boolean'))
    const after = await draft(view)
    assert.equal(field(view, 'information-fields').value, ''); assert.deepEqual(after.pending, [])
    assert.equal(control(view, 'reading-rationale'), null); assert.equal(control(view, 'add-reading'), null)
    assert.ok(!field(view, 'information-fields-editor').textContent.includes('PRIVATE_SYNTHETIC_READING_TEXT'))
    oldControl.value = 'Old detached controls must not write into the new draft'; oldControl.dispatch('input')
    assert.deepEqual(await draft(view), after)
    assert.equal(field(view, 'export-evidence').disabled, true)
    await click(view, 'undo'); assert.deepEqual(await draft(view), before)
    assert.equal(field(view, 'input').value, '{ unfinished input before replacement')
    assert.equal(fieldsOf(view).readings[0].rationale, 'PRIVATE_SYNTHETIC_READING_TEXT_RETAIN_ONLY_WITH_THIS_DRAFT')
    outcomes.push({ replacement, before, after, restored: await draft(view) })
  }
  await retain('replacement-clears-private-fields', outcomes)
})

test('a delayed source preparation cannot publish fields from the prior account after reload', async () => {
  let hold = false, entered = false, release
  const view = await mount({ loadSources: async () => { if (hold) { entered = true; await new Promise(resolve => { release = resolve }) } return sources } })
  await importDraft(view, fixture()); hold = true; field(view, 'prepare-information-fields').click()
  await until(() => entered); Object.assign(account, memoryAccount())
  await view.setContext(A, 'live', { reload: true }); await idle(view)
  const afterSwitch = await draft(view)
  hold = false; release(); await pause(); await idle(view)
  assert.deepEqual(await draft(view), afterSwitch)
  assert.equal(field(view, 'information-fields').value, ''); assert.equal(field(view, 'undo').hidden, true)
  assert.equal(control(view, 'reading-id'), null); assert.equal(field(view, 'export-evidence').disabled, true)
  await retain('delayed-prepare-account', afterSwitch)
})

test('an in-flight compiled field build cannot publish the old task into a different project', async () => {
  const view = await mount(); await preparedScalar(view); addReading(view, 'unchanged')
  let held = true, entered = false, release, outstandingDigests = 0
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto), subtle: { digest: async (...args) => {
      outstandingDigests++
      try {
        if (held && !entered) { entered = true; await new Promise(resolve => { release = resolve }) }
        return await webcrypto.subtle.digest(...args)
      } finally { outstandingDigests-- }
    } },
  } })
  field(view, 'apply-information-fields').click(); await until(() => entered)
  held = false; await view.setContext(B, 'live'); await idle(view)
  const afterSwitch = await draft(view); release(); await pause(); await idle(view)
  await until(() => outstandingDigests === 0, 'The released old compiler must finish its bounded hash chain.')
  await pause()
  assert.deepEqual(await draft(view), afterSwitch)
  assert.equal(field(view, 'information-fields').value, ''); assert.equal(field(view, 'undo').hidden, true)
  await view.setContext(A, 'live'); await idle(view)
  const restored = await draft(view)
  assert.equal(restored.spec.tasks[0].information, undefined, 'The stale compile is discarded even when returning to its original project.')
  assert.equal(fieldsOf(view).readings[0].id, 'unchanged'); assert.ok(restored.pending.includes('informationFields'))
  await retain('delayed-build-project', { afterSwitch, restored })
})
