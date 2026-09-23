import { useArithmeticExample } from './lib/benchmark-example.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { requirementFieldInventory } from '../../src/benchmark/requirement-fields.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
let installed, cryptoDescriptor, account, downloads
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const globalField = (view, name) => field(view, 'family-editor').querySelector('[data-composition-family-fields-' + name + ']')
const localField = (view, name) => field(view, 'family-occurrence-editor').querySelector('[data-composition-fields-' + name + ']')
const status = view => field(view, 'status').textContent
const raw = view => JSON.parse(field(view, 'composition-family-fields').value)
const specOf = view => JSON.parse(field(view, 'spec-json').value)
async function idle(view) {
  for (let index = 0; index < 800; index++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('Family builder did not settle: ' + status(view))
}
function input(node, value) {
  assert.ok(node); assert.equal(node.disabled, false)
  if (node.type === 'checkbox') node.checked = value; else node.value = value
  node.dispatch('input')
}
const fill = (view, name, value) => input(field(view, name), value)
const globalFill = (view, name, value) => input(globalField(view, name), value)
const localFill = (view, name, value) => input(localField(view, name), value)
async function click(view, name) {
  const button = field(view, name); assert.ok(button, name); assert.equal(button.disabled, false, name + ': ' + status(view)); button.click(); await idle(view)
}
async function globalClick(view, name) {
  const button = globalField(view, name); assert.ok(button, name); assert.equal(button.disabled, false); button.click(); await idle(view)
}
async function selectFamily(view, id) { globalFill(view, 'family', id); await idle(view) }
function memoryAccount() {
  const values = new Map()
  return { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } }, async putSetting(key, value) { values.set(key, value); return { ok: true } } }
}
async function mount(overrides = {}) {
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources, download: (name, contents) => downloads.push({ name, contents }), ...overrides })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); return view
}
async function draft(view) { await click(view, 'draft-export'); return JSON.parse(downloads.at(-1).contents) }
function fixture() {
  const spec = newExperimentDraft(genericStarter(), { initializePopulation: true })
  spec.catalog = [{ id: 'instruction', version: '1', kind: 'atom', role: 'node', parameters: { n: 1 },
    parameterSchema: { n: { type: 'integer', minimum: 0 } }, text: 'Wording {{n}}. Use the input number.', semantics: { kind: 'instruction', n: '{{n}}' } }]
  spec.tasks = [
    { id: 'source-a', familyId: 'original-a', split: 'development', root: { use: 'instruction' }, input: { number: 0 }, expected: 0 },
    { id: 'source-b', familyId: 'original-b', split: 'held-out', root: { use: 'instruction' }, input: { number: 9 }, expected: 9 },
  ]
  spec.protocol.grading = { kind: 'json' }
  spec.conditions[0].adapter.responses = { 'source-a': 0, 'source-b': 9 }
  return spec
}
function setChoice(view, index, id, value) {
  const choice = field(view, 'family-occurrence-editor').querySelectorAll('[data-composition-fields-choice]')[index]
  assert.ok(choice)
  input(choice.querySelector('[data-composition-fields-choice-id]'), id)
  // The component re-renders after changing the ID, so address the current row.
  const current = field(view, 'family-occurrence-editor').querySelectorAll('[data-composition-fields-choice]')[index]
  input(current.querySelector('[data-composition-fields-parameter-name="n"] [data-composition-fields-parameter-value]'), value)
}
function fillFamily(view, suffix) {
  localFill(view, 'family', 'generated-' + suffix)
  localFill(view, 'rationale', 'Construct both wording levels for source ' + suffix + ' without borrowing the other input.')
  localFill(view, 'expected-policy', 'reuse-base')
  localFill(view, 'expected-rationale', 'Source ' + suffix + ' retains only its own declared input-number answer for this construction control.')
  localFill(view, 'enabled', true); localFill(view, 'axis-id', 'wording')
  setChoice(view, 0, 'one', '1')
  localField(view, 'add-choice').click()
  setChoice(view, 1, 'two', '2')
}
async function prepare(view, limit = '4') {
  const original = fixture()
  fill(view, 'spec-json', JSON.stringify(original)); await click(view, 'apply-spec')
  assert.match(status(view), /Full specification applied/)
  await click(view, 'start-family-workspace')
  assert.match(status(view), /Family workspace started/)
  assert.equal(field(view, 'family-workspace').hidden, false)
  assert.equal(field(view, 'single-composition-controls').hidden, true)
  assert.equal(localField(view, 'seed'), null)
  assert.equal(localField(view, 'selection-limit'), null)
  assert.match(localField(view, 'shared-construction').textContent, /workspace owns the shared seed, sampling and coverage/)
  globalFill(view, 'rationale', 'One combined family sample; require every wording level separately inside each original family.')
  globalFill(view, 'selection-kind', 'balanced'); globalFill(view, 'selection-limit', limit)
  globalFill(view, 'coverage-kind', 'marginal'); globalFill(view, 'coverage-minimum', '1')
  fillFamily(view, 'a')
  globalFill(view, 'source', 'source-b'); await globalClick(view, 'add')
  assert.match(status(view), /Source family added/)
  assert.equal(globalField(view, 'family').value, 'source-b')
  fillFamily(view, 'b')
  assert.equal(raw(view).families.length, 2)
  return original
}
function unzipStored(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder(), files = {}
  let offset = 0
  while (data.getUint32(offset, true) === 0x04034b50) {
    assert.equal(data.getUint16(offset + 8, true), 0)
    const length = data.getUint32(offset + 18, true), nameLength = data.getUint16(offset + 26, true), extraLength = data.getUint16(offset + 28, true)
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)), start = offset + 30 + nameLength + extraLength
    files[name] = decoder.decode(bytes.subarray(start, start + length)); offset = start + length
  }
  assert.equal(data.getUint32(offset, true), 0x02014b50)
  return files
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

test('the family builder refuses pooled half-coverage, then generates all four cases and exports exact scoped metadata', async () => {
  const view = await mount(), original = await prepare(view, '2')
  await click(view, 'apply-composition-fields')
  assert.match(status(view), /Task recipe built/)
  assert.match(field(view, 'composition-fields-status').textContent, /2 source families; factor quotas are scoped within each family/)
  await click(view, 'generate-corpus')
  assert.match(status(view), /coverage-unmet.*previous task list is retained/)
  assert.deepEqual(specOf(view).tasks, original.tasks)
  const half = JSON.parse(field(view, 'corpus-ledger').textContent)
  assert.equal(half.selectedCount, 2); assert.equal(half.candidateCount, 4); assert.equal(half.unmetCoverage.length, 2)
  assert.equal(half.coverage.filter(row => row.dimension.startsWith('axis:')).length, 4)
  globalFill(view, 'selection-limit', '4')
  await click(view, 'apply-composition-fields')
  assert.match(status(view), /Task recipe built/)
  const retained = raw(view)
  await click(view, 'generate-corpus')
  assert.match(status(view), /4 tasks generated from 4 candidates/)
  assert.deepEqual(raw(view), retained)
  assert.match(field(view, 'composition-obligations').textContent, /4 exact occurrence controls across 4 generated tasks; at least 16 independent interpreter cases/)
  const exported = await draft(view)
  assert.equal(exported.spec.executionPlan.purpose, 'experiment')
  assert.equal(exported.spec.requireReview, original.requireReview)
  assert.deepEqual(exported.spec.analysisPlan, original.analysisPlan)
  assert.equal(exported.spec.requirementPlan, undefined)
  assert.equal(exported.spec.reviews?.length || 0, 0); assert.equal(exported.spec.taskReviews?.length || 0, 0)
  assert.deepEqual(exported.spec.conditions[0].adapter.responses, {})
  for (const [family, number, split] of [['generated-a', 0, 'development'], ['generated-b', 9, 'held-out']]) {
    const tasks = exported.spec.tasks.filter(task => task.familyId === family)
    assert.equal(tasks.length, 2)
    assert.deepEqual(tasks.map(task => task.root.params.n).sort((a, b) => a - b), [1, 2])
    assert.ok(tasks.every(task => task.input.number === number && task.expected === number && task.split === split))
  }
  assert.equal((await requirementFieldInventory(exported.spec)).rows.length, 4)
  await click(view, 'freeze')
  assert.equal(field(view, 'export').disabled, false)
  assert.equal(field(view, 'run').disabled, true)
  assert.match(field(view, 'readiness').textContent, /independent interpreter|independent.*oracle|source-pinned reference/i)
  await click(view, 'export')
  const zip = downloads.at(-1); assert.match(zip.name, /\.zip$/)
  const files = unzipStored(zip.contents), authoring = JSON.parse(files['corpus/field-authoring.json'])
  assert.deepEqual(authoring, exported.spec.corpusPlan.fieldAuthoring)
  assert.equal(authoring.families.length, 2); assert.equal(authoring.axisMappings.length, 2)
  assert.equal(new Set(authoring.axisMappings.map(row => row.recipeAxisId)).size, 2)
})

test('unfinished global and family text survives Save, remount and project isolation while navigation stays view-only', async () => {
  let view = await mount(); await prepare(view)
  globalFill(view, 'selection-limit', 'unfinished global limit')
  setChoice(view, 1, 'two', '-')
  const retained = raw(view)
  await click(view, 'save'); assert.equal(view.dirty, false)
  const before = await draft(view)
  await selectFamily(view, 'source-a'); await selectFamily(view, 'source-b')
  assert.equal(view.dirty, false)
  assert.deepEqual(raw(view), retained)
  assert.deepEqual((await draft(view)).pending, before.pending)
  await view.setContext(B, 'live'); await idle(view)
  assert.equal(field(view, 'composition-family-fields').value, '')
  assert.equal(field(view, 'family-workspace').hidden, true)
  await view.setContext(A, 'live'); await idle(view)
  assert.deepEqual(raw(view), retained)
  view = await mount()
  assert.deepEqual(raw(view), retained)
  assert.equal(globalField(view, 'selection-limit').value, 'unfinished global limit')
  await selectFamily(view, 'source-b')
  assert.equal(field(view, 'family-occurrence-editor').querySelectorAll('[data-composition-fields-parameter-value]')[1].value, '-')
  await click(view, 'prepare-family-fields')
  assert.deepEqual(raw(view), retained)
  const separate = await mount({ account: memoryAccount() })
  assert.equal(field(separate, 'composition-family-fields').value, '')
  assert.equal((await draft(separate)).spec.id, 'my-benchmark')
  await click(view, 'apply-composition-fields')
  assert.match(status(view), /whole number.*selected task limit/)
  assert.deepEqual(raw(view), retained)
})

test('generation retains read-only capsules, live Undo restores originals, and a cold reload cannot invent missing source authority or Undo', async () => {
  const view = await mount(), original = await prepare(view)
  await click(view, 'apply-composition-fields'); const retained = raw(view)
  await click(view, 'generate-corpus'); assert.match(status(view), /4 tasks generated/)
  assert.match(field(view, 'family-source-status').textContent, /read-only.*Undo/i)
  assert.equal(localField(view, 'rationale').disabled, true)
  await click(view, 'save')
  await click(view, 'apply-composition-fields')
  assert.match(status(view), /original source task is unavailable.*Undo/i)
  assert.equal(specOf(view).tasks.length, 4); assert.deepEqual(raw(view), retained)
  assert.equal(field(view, 'undo').hidden, false)
  await click(view, 'undo')
  assert.deepEqual(specOf(view).tasks, original.tasks)
  assert.deepEqual(raw(view), retained)

  const cold = await mount()
  assert.equal(specOf(cold).tasks.length, 4)
  assert.deepEqual(raw(cold), retained)
  assert.equal(field(cold, 'undo').hidden, true)
  await selectFamily(cold, 'source-a')
  assert.match(field(cold, 'family-source-status').textContent, /Read-only retained source preview.*original task is unavailable/i)
  assert.equal(localField(cold, 'rationale').disabled, true)
  assert.equal(localField(cold, 'add-choice').disabled, true)
  assert.equal(specOf(cold).tasks.some(task => task.id === 'source-a'), false)
  await click(cold, 'apply-composition-fields')
  assert.match(status(cold), /original source task is unavailable.*Undo/i)
  assert.deepEqual(raw(cold), retained)
  await click(cold, 'reset-family-fields')
  assert.match(status(cold), /retained capsule cannot replace a missing live task/i)
  assert.equal(field(cold, 'undo').hidden, true)
})

test('source changes refuse old family fields and explicit replacement Undo preserves other families and global policy', async () => {
  const view = await mount(); await prepare(view)
  const retained = raw(view)
  field(view, 'task').value = '1'; field(view, 'task').dispatch('change'); await idle(view)
  fill(view, 'input', JSON.stringify({ number: 17 })); await click(view, 'apply-input')
  await click(view, 'apply-composition-fields')
  assert.match(status(view), /original source task changed.*stale/i)
  assert.deepEqual(raw(view), retained)
  await click(view, 'prepare-family-fields')
  assert.match(localField(view, 'status').textContent, /stale/i)
  assert.deepEqual(raw(view), retained)
  await click(view, 'reset-family-fields')
  assert.match(status(view), /Selected family fields replaced/)
  const replaced = raw(view)
  assert.deepEqual(replaced.families[0], retained.families[0])
  assert.deepEqual(replaced.selection, retained.selection); assert.deepEqual(replaced.coverage, retained.coverage)
  assert.deepEqual(replaced.families[1].sourceTask.input, { number: 17 })
  assert.ok(replaced.families[1].fields.occurrences.every(row => !row.enabled && row.choices.length === 1))
  assert.notEqual(replaced.families[1].fields.bindingSha256, retained.families[1].fields.bindingSha256)
  await click(view, 'undo')
  assert.deepEqual(raw(view), retained)
  assert.deepEqual(specOf(view).tasks[1].input, { number: 17 })
  await selectFamily(view, 'source-b')
  await click(view, 'apply-composition-fields')
  assert.match(status(view), /original source task changed.*stale/i)
  await click(view, 'leave-family-workspace')
  assert.equal(field(view, 'composition-family-fields').value, '')
  assert.equal(field(view, 'family-workspace').hidden, true)
  await click(view, 'undo')
  assert.deepEqual(raw(view), retained)
  assert.equal(field(view, 'family-workspace').hidden, false)
  assert.equal(specOf(view).executionPlan.purpose, 'experiment')
  assert.equal(canonical(specOf(view).analysisPlan), canonical(fixture().analysisPlan))
})

test('a failed family selection keeps the previous editor bound to its own capsule', async () => {
  const view = await mount(); await prepare(view); await selectFamily(view, 'source-a')
  const retainedB = structuredClone(raw(view).families[1])
  field(view, 'task').value = '1'; field(view, 'task').dispatch('change'); await idle(view)
  const invalid = JSON.parse(field(view, 'task-json').value); invalid.root.use = 'missing-bundle'
  fill(view, 'task-json', JSON.stringify(invalid)); await click(view, 'apply-task')
  await selectFamily(view, 'source-b')
  assert.match(status(view), /missing.*bundle|unknown.*bundle/i)
  assert.equal(globalField(view, 'family').value, 'source-a')
  assert.match(field(view, 'family-occurrence-editor').textContent, /Base task: source-a/)
  localFill(view, 'rationale', 'This edit still belongs to source A after source B failed to load.')
  assert.equal(raw(view).families[0].fields.rationale, 'This edit still belongs to source A after source B failed to load.')
  assert.deepEqual(raw(view).families[1], retainedB)
  assert.equal(raw(view).families[0].fields.taskId, 'source-a')
})

test('a late source-inventory digest cannot poison the next project inventory after its failed selection rerenders', async () => {
  const view = await mount(); await prepare(view); await selectFamily(view, 'source-a')
  let release, entered = false, completed = false
  const gate = new Promise(resolve => { release = resolve })
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async (algorithm, bytes) => {
    const text = new TextDecoder().decode(bytes)
    if (!entered && text.includes('"format":"benchmark-composition-field-source"') && text.includes('"id":"source-b"')) {
      entered = true; await gate
      const result = await webcrypto.subtle.digest(algorithm, bytes); completed = true; return result
    }
    return webcrypto.subtle.digest(algorithm, bytes)
  } } } })
  try {
    globalFill(view, 'family', 'source-b')
    for (let index = 0; index < 800 && !entered; index++) await pause()
    assert.equal(entered, true, 'The delayed operation reached the source inventory hash, beyond loading source files.')
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
    await view.setContext(B, 'live'); await idle(view)
    await useArithmeticExample(view)
    await click(view, 'start-family-workspace')
    globalFill(view, 'source', 'addition-b'); await globalClick(view, 'add')
    await selectFamily(view, 'addition-a')
    assert.equal(localField(view, 'occurrence').children.length, 2)
    const retainedB = structuredClone(raw(view).families[1])
    field(view, 'task').value = '1'; field(view, 'task').dispatch('change'); await idle(view)
    const invalid = JSON.parse(field(view, 'task-json').value); invalid.root.use = 'missing-in-new-project'
    fill(view, 'task-json', JSON.stringify(invalid)); await click(view, 'apply-task')
    release()
    for (let index = 0; index < 800 && !completed; index++) await pause()
    assert.equal(completed, true); await pause(); await pause()
    // This failure redraws from the retained inventory. A stale write hidden behind an epoch error becomes visible here.
    await selectFamily(view, 'addition-b')
    assert.match(status(view), /missing.*bundle|unknown.*bundle/i)
    assert.equal(globalField(view, 'family').value, 'addition-a')
    assert.equal(localField(view, 'occurrence').children.length, 2)
    assert.match(field(view, 'family-occurrence-editor').textContent, /Base task: addition-a/)
    assert.doesNotMatch(field(view, 'family-occurrence-editor').textContent, /Base task: source-b/)
    localFill(view, 'rationale', 'Only the new project source receives this edit.')
    assert.equal(raw(view).families[0].fields.taskId, 'addition-a')
    assert.equal(raw(view).families[0].fields.rationale, 'Only the new project source receives this edit.')
    assert.deepEqual(raw(view).families[1], retainedB)
  } finally { release(); Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto }) }
})

test('LEAN expectation derivation preserves pending family fields after an explicit source-input change', async () => {
  const view = await mount()
  field(view, 'starter').value = 'lean-operational'; await click(view, 'use-starter')
  await click(view, 'start-family-workspace')
  globalFill(view, 'rationale', 'Retain unfinished operational family controls while deriving the changed source observation.')
  globalFill(view, 'selection-limit', 'unfinished')
  localFill(view, 'rationale', 'Unapplied operational family rationale.')
  localFill(view, 'expected-rationale', 'The model-derived source answer still needs independent controls.')
  const retained = raw(view), originalExpected = structuredClone(specOf(view).tasks[0].expected)
  const changed = JSON.parse(field(view, 'input').value); changed.market.maxFillQuantity = 1
  fill(view, 'input', JSON.stringify(changed)); await click(view, 'apply-input')
  await click(view, 'derive-expected')
  assert.match(status(view), /Draft expected observation derived/)
  assert.deepEqual(raw(view), retained)
  assert.equal(globalField(view, 'selection-limit').value, 'unfinished')
  assert.equal(localField(view, 'rationale').value, 'Unapplied operational family rationale.')
  assert.equal(specOf(view).tasks[0].input.market.maxFillQuantity, 1)
  assert.notDeepEqual(specOf(view).tasks[0].expected, originalExpected)
  assert.equal(specOf(view).executionPlan.purpose, 'experiment')
  assert.equal(specOf(view).requirementPlan, undefined)
  assert.equal(specOf(view).reviews?.length || 0, 0)
  const saved = await draft(view)
  assert.ok(saved.pending.includes('compositionFamilies'))
  assert.equal(saved.pending.includes('input'), false)
})
