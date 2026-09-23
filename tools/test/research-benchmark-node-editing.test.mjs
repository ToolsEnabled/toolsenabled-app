import { useArithmeticExample } from './lib/benchmark-example.mjs'
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

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
let installed, cryptoDescriptor, account, downloads
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const nodeControl = (view, kind, path = '') => [...view.el.querySelectorAll('[data-node-' + kind + ']')].find(node => node.getAttribute('data-node-' + kind) === path)
const status = view => field(view, 'status').textContent
const specOf = view => JSON.parse(field(view, 'spec-json').value)
async function idle(view) {
  for (let i = 0; i < 800; i++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('Node editing did not settle: ' + status(view))
}
function input(node, value) {
  assert.ok(node); assert.equal(node.disabled, false)
  node.value = value; node.dispatch('input')
}
const fill = (view, name, value) => input(field(view, name), value)
async function click(view, name) {
  const button = field(view, name); assert.ok(button, name); assert.equal(button.disabled, false, name + ': ' + status(view))
  button.click(); await idle(view)
}
async function choose(view, path, id) {
  const select = nodeControl(view, 'use', path)
  assert.ok([...select.children].some(option => option.value === id), 'The real bundle selector offers ' + id)
  input(select, id); select.dispatch('change'); await idle(view)
}
function mode(view, path, value) {
  const select = nodeControl(view, 'replacement-mode', path)
  input(select, value); select.dispatch('change')
}
// This small DOM stand-in does not select a SELECT's first option implicitly.
// Read the native browser default when it has no explicitly selected value.
const modeValue = (view, path = '') => {
  const select = nodeControl(view, 'replacement-mode', path)
  return select.value || select.children[0]?.value
}
async function parameter(view, path, name, value) {
  const control = [...view.el.querySelectorAll('[data-node-param]')].find(node => node.dataset.nodePath === path && node.dataset.nodeParam === name)
  input(control, String(value)); control.dispatch('change'); await idle(view)
}
function memoryAccount() {
  const values = new Map()
  return { values, async getSetting(key) { return { ok: true, value: values.get(key) ?? null } },
    async putSetting(key, value) { values.set(key, value); return { ok: true } } }
}
async function mount() {
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources, download: (name, contents) => downloads.push({ name, contents }) })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); return view
}
async function draft(view) { await click(view, 'draft-export'); return JSON.parse(downloads.at(-1).contents) }
async function evidence(view) { await click(view, 'export-evidence'); return JSON.parse(downloads.at(-1).contents) }
async function importDraft(view, value) {
  const text = JSON.stringify(value), node = field(view, 'import')
  node.files = [{ name: 'synthetic-node-draft.json', size: Buffer.byteLength(text), text: async () => text }]
  node.dispatch('change'); await idle(view); assert.match(status(view), /Opened synthetic-node-draft\.json/)
}
async function retained(name, value) {
  const directory = process.env.RESEARCH_BENCHMARK_NODE_EDIT_EVIDENCE
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n')
}
const uiState = view => ({
  spec: field(view, 'spec-json').value, task: field(view, 'task-json').value, input: field(view, 'input').value,
  expected: field(view, 'expected').value, conditions: field(view, 'conditions').value, corpus: field(view, 'corpus-plan').value,
  dirty: view.dirty, undoHidden: field(view, 'undo').hidden, frozen: field(view, 'frozen').textContent,
  readiness: field(view, 'readiness').innerHTML, results: field(view, 'results').innerHTML,
  exportDisabled: field(view, 'export').disabled, runDisabled: field(view, 'run').disabled, evidenceDisabled: field(view, 'export-evidence').disabled,
})
const leaf = value => ({ use: 'leaf', params: { value } })
function fixture() {
  const spec = newExperimentDraft(genericStarter(), { purpose: 'recorded-diagnostic', initializePopulation: true })
  const template = (id, slots, factor) => ({ id, version: '1', kind: 'template', role: 'node', slots,
    parameters: { factor }, text: 'Factor {{factor}}. ' + Object.keys(slots).map(slot => '{{slot:' + slot + '}}').join(' '), semantics: { kind: id, factor: '{{factor}}' } })
  spec.catalog = [
    { id: 'leaf', version: '1', kind: 'atom', role: 'node', parameters: { value: 1 }, text: 'Number {{value}}.', semantics: { kind: 'number', value: '{{value}}' } },
    { id: 'process', version: '1', kind: 'atom', role: 'process', text: 'Process.', semantics: { kind: 'process' } },
    template('pair', { left: 'node', right: 'node' }, 10),
    template('pair-alternate', { left: 'node', right: 'node' }, 20),
    template('triple', { left: 'node', right: 'node', extra: 'node' }, 30),
    template('single', { left: 'node' }, 40),
    template('changed-role', { left: 'node', right: 'process' }, 50),
    template('wrapper', { inner: 'node' }, 60),
  ]
  spec.tasks = [{ id: 'tree', familyId: 'tree-family', root: { use: 'pair', params: { factor: 99 }, slots: {
    left: { use: 'wrapper', params: { factor: 77 }, slots: { inner: leaf(7) } }, right: { use: 'wrapper', params: { factor: 88 }, slots: { inner: leaf(8) } },
  } }, input: { independent: 'retained-input' }, expected: 'saved-control', split: 'development' }]
  spec.conditions[0].adapter.responses = { tree: 'saved-control' }
  return spec
}
async function generic(view, value = fixture()) { await importDraft(view, value); return specOf(view) }
async function operational(view) {
  field(view, 'starter').value = 'lean-operational'; await click(view, 'use-starter')
  await parameter(view, 'child1.buy_process', 'quantity', 2)
  await parameter(view, 'child2.child1.buy_process', 'quantity', 3)
  const spec = specOf(view); assert.equal((await compilePrompt(spec.catalog, spec.tasks[0].root)).nodeCount, 17)
  return spec
}
beforeEach(() => {
  installed = installDomStandIn(globalThis); cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  account = memoryAccount(); downloads = []
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
})

test('ordinary ALL to SEQUENCE retains the actual 17-node operational tree and carries it into corpus generation', async () => {
  const view = await mount(), before = await operational(view), original = structuredClone(before.tasks[0])
  const priorUi = uiState(view), select = nodeControl(view, 'use')
  input(select, 'op-sequence-2')
  assert.deepEqual(uiState(view), priorUi, 'Input before the checked change must not publish or invalidate anything.')
  select.dispatch('change'); await idle(view)
  assert.match(status(view), /compatible child connections retained/)
  let current = specOf(view)
  assert.equal(current.tasks[0].root.use, 'op-sequence-2')
  assert.deepEqual(current.tasks[0].root.slots, original.root.slots)
  assert.equal(current.tasks[0].root.slots.child1.slots.buy_process.params.quantity, 2)
  assert.equal(current.tasks[0].root.slots.child2.slots.child1.slots.buy_process.params.quantity, 3)
  assert.equal((await compilePrompt(current.catalog, current.tasks[0].root)).nodeCount, 17)
  assert.deepEqual(current.tasks[0].input, original.input)
  assert.deepEqual(current.tasks[0].expected, original.expected, 'Changing the operator does not claim the old expected result was re-derived.')
  assert.equal(current.executionPlan.purpose, 'experiment'); assert.equal(current.requireReview, true)
  assert.deepEqual(current.reviews || [], before.reviews || []); assert.equal(current.requirementPlan, undefined)
  assert.equal(modeValue(view), 'preserve')
  await click(view, 'derive-expected')
  await click(view, 'seed-corpus')
  const recipe = JSON.parse(field(view, 'corpus-plan').value)
  assert.deepEqual(recipe.families[0].task.root, current.tasks[0].root)
  await click(view, 'generate-corpus')
  assert.match(status(view), /1 tasks generated from 1 candidates/)
  current = specOf(view)
  assert.equal(current.tasks.length, 1)
  assert.equal(current.tasks[0].root.use, 'op-sequence-2')
  assert.deepEqual(current.tasks[0].root.slots, original.root.slots)
  assert.equal((await compilePrompt(current.catalog, current.tasks[0].root)).nodeCount, 17)
  assert.equal(current.requirementPlan, undefined); assert.deepEqual(current.reviews || [], [])
  await retained('operational-preserved-and-generated', { original, generated: await draft(view), ledger: JSON.parse(field(view, 'corpus-ledger').textContent) })
})

test('explicit one-shot branch replacement gives the legacy 11-node tree and Undo restores all 17 authored nodes', async () => {
  const view = await mount(), before = await operational(view), original = structuredClone(before.tasks[0])
  const state = uiState(view)
  mode(view, '', 'replace'); assert.deepEqual(uiState(view), state, 'Choosing a replacement mode is navigation only.')
  await choose(view, '', 'op-sequence-2')
  assert.match(status(view), /Branch replaced/)
  const replaced = specOf(view)
  assert.equal((await compilePrompt(replaced.catalog, replaced.tasks[0].root)).nodeCount, 11)
  assert.equal(replaced.tasks[0].root.slots.child2.use, 'op-strategy')
  assert.notDeepEqual(replaced.tasks[0].root.slots, original.root.slots)
  assert.equal(modeValue(view), 'preserve')
  assert.equal(field(view, 'undo').hidden, false)
  await click(view, 'undo')
  assert.deepEqual(specOf(view).tasks[0], original)
  assert.equal((await compilePrompt(specOf(view).catalog, specOf(view).tasks[0].root)).nodeCount, 17)
  assert.equal(modeValue(view), 'preserve')
  await retained('explicit-replacement-and-undo', { before, replaced, restored: await draft(view) })
})

test('arity growth creates a persistent explicit hole, refuses Freeze, then accepts the investigator-selected child', async () => {
  const view = await mount(), before = await generic(view)
  await choose(view, '', 'triple')
  let next = specOf(view)
  assert.deepEqual(next.tasks[0].root.slots.left, before.tasks[0].root.slots.left)
  assert.deepEqual(next.tasks[0].root.slots.right, before.tasks[0].root.slots.right)
  assert.deepEqual(next.tasks[0].root.params, { factor: 30 }, 'Selected node parameters use the new bundle defaults.')
  assert.deepEqual(next.tasks[0].root.slots.extra, { use: '' })
  assert.equal(nodeControl(view, 'use', 'extra').value, '')
  const unfilled = await draft(view)
  await click(view, 'freeze')
  assert.match(status(view), /bundle|unknown|Unknown|choose|Choose/)
  assert.equal(field(view, 'export').disabled, true); assert.equal(field(view, 'run').disabled, true)
  await click(view, 'save'); assert.equal(view.dirty, false)
  const restored = await mount()
  assert.deepEqual(specOf(restored).tasks[0].root.slots.extra, { use: '' })
  assert.equal(nodeControl(restored, 'use', 'extra').value, '')
  await choose(restored, 'extra', 'leaf')
  next = specOf(restored)
  assert.equal(next.tasks[0].root.slots.extra.use, 'leaf')
  assert.deepEqual(next.tasks[0].root.slots.left, before.tasks[0].root.slots.left)
  await click(restored, 'freeze')
  assert.equal(field(restored, 'export').disabled, false, status(restored))
  assert.equal(next.executionPlan.purpose, 'recorded-diagnostic')
  await retained('arity-hole-and-fill', { unfilled, filled: await draft(restored) })
})

test('lost or role-changed child refusals preserve a frozen saved-result project across input and change events', async () => {
  const view = await mount(); await generic(view)
  await click(view, 'freeze'); await click(view, 'run'); await click(view, 'save')
  const savedEvidence = await evidence(view), before = await draft(view), state = uiState(view)
  assert.equal(savedEvidence.summary.completed, 1)
  assert.equal(state.evidenceDisabled, false); assert.equal(state.dirty, false)
  for (const target of ['single', 'changed-role']) {
    const select = nodeControl(view, 'use')
    input(select, target); assert.deepEqual(uiState(view), state)
    select.dispatch('change'); await idle(view)
    assert.match(status(view), /remove or change the role of child right/)
    assert.equal(nodeControl(view, 'use').value, 'pair')
    assert.deepEqual(uiState(view), state)
    assert.deepEqual(await draft(view), before)
    assert.deepEqual(await evidence(view), savedEvidence)
  }
  await retained('atomic-refusal-with-saved-evidence', { before, evidence: savedEvidence, state })
})

test('a pending task JSON blocks either replacement mode without losing task or other raw editor text', async () => {
  const view = await mount(); await generic(view)
  fill(view, 'task-json', '{"unfinished":')
  fill(view, 'conditions', '[unfinished condition roster')
  fill(view, 'corpus-plan', '{unfinished corpus recipe')
  const before = await draft(view), state = uiState(view)
  assert.ok(before.pending.includes('task')); assert.ok(before.pending.includes('protocol')); assert.ok(before.pending.includes('corpus'))
  for (const replacement of ['preserve', 'replace']) {
    mode(view, '', replacement)
    const select = nodeControl(view, 'use')
    input(select, 'pair-alternate'); assert.deepEqual(uiState(view), state)
    select.dispatch('change'); await idle(view)
    assert.match(status(view), /Apply the current task edits first/)
    assert.equal(nodeControl(view, 'use').value, 'pair')
    assert.deepEqual(uiState(view), state)
    assert.deepEqual(await draft(view), before)
  }
  await retained('pending-task-refusal', { before, after: await draft(view) })
})

test('successful node edits retain unrelated pending fields in Undo and one-shot modes stay within their context', async () => {
  const view = await mount(); await generic(view)
  fill(view, 'conditions', '[unfinished condition roster')
  fill(view, 'corpus-plan', '{unfinished corpus recipe')
  const before = await draft(view)
  await choose(view, '', 'pair-alternate')
  assert.deepEqual(specOf(view).tasks[0].root.slots, before.spec.tasks[0].root.slots)
  assert.equal(field(view, 'conditions').value, '[unfinished condition roster')
  assert.equal(field(view, 'corpus-plan').value, '{unfinished corpus recipe')
  const after = await draft(view)
  assert.deepEqual(after.pending, before.pending)
  await click(view, 'undo')
  const undone = await draft(view)
  assert.deepEqual(undone.spec, before.spec); assert.deepEqual(undone.pending, before.pending); assert.deepEqual(undone.editors, before.editors)
  mode(view, '', 'replace')
  await view.setContext(B, 'live'); await idle(view)
  await useArithmeticExample(view)
  assert.equal(modeValue(view), 'preserve')
  assert.notEqual(field(view, 'conditions').value, '[unfinished condition roster')
  await view.setContext(A, 'live'); await idle(view)
  assert.equal(modeValue(view), 'preserve', 'A previous account/context cannot arm a destructive future edit.')
  assert.deepEqual((await draft(view)).editors, before.editors)
  mode(view, 'left', 'replace')
  await choose(view, '', 'pair-alternate')
  assert.deepEqual(specOf(view).tasks[0].root.slots, before.spec.tasks[0].root.slots, 'A child mode cannot affect its parent selection.')
  assert.equal(modeValue(view, 'left'), 'preserve')
  mode(view, '', 'replace')
  const beforeAccountReload = await draft(view)
  Object.assign(account, memoryAccount())
  await view.setContext(A, 'live', { reload: true }); await idle(view)
  await useArithmeticExample(view)
  assert.equal(modeValue(view), 'preserve', 'An account reload on the same project/source must not retain an armed replacement mode.')
  assert.notEqual(field(view, 'conditions').value, '[unfinished condition roster')
  assert.notEqual(field(view, 'corpus-plan').value, '{unfinished corpus recipe')
  const afterAccountReload = await draft(view)
  assert.deepEqual(afterAccountReload.pending, [])
  assert.notDeepEqual(afterAccountReload.spec.tasks, before.spec.tasks)
  await retained('pending-undo-and-context-modes', { before, after, undone, beforeAccountReload, afterAccountReload })
})

test('an imported template missing its slots object can be completed through ordinary child selectors', async () => {
  const view = await mount(), imported = fixture()
  delete imported.tasks[0].root.slots
  await importDraft(view, imported)
  assert.equal(nodeControl(view, 'use', 'left').value, '')
  assert.equal(nodeControl(view, 'use', 'right').value, '')
  await choose(view, 'left', 'leaf')
  assert.equal(specOf(view).tasks[0].root.slots.left.use, 'leaf')
  assert.equal(specOf(view).tasks[0].root.slots.right, undefined)
  await choose(view, 'right', 'leaf')
  assert.equal(specOf(view).tasks[0].root.slots.right.use, 'leaf')
  assert.equal((await compilePrompt(specOf(view).catalog, specOf(view).tasks[0].root)).nodeCount, 3)
  await click(view, 'freeze')
  assert.equal(field(view, 'export').disabled, false, status(view))
  assert.equal(specOf(view).executionPlan.purpose, 'recorded-diagnostic')
  await retained('missing-slots-filled', await draft(view))
})
