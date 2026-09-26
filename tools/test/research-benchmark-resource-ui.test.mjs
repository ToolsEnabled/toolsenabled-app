import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
let installed, cryptoDescriptor, account, downloads
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const field = (view, name) => view.el.querySelector(`[data-bench-${name}]`)
const resource = (view, name, index = 0) => view.el.querySelectorAll(`[data-resource-template-${name}]`)[index]
async function idle(view) {
  for (let i = 0; i < 400; i++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('The generated resource builder did not settle.')
}
function fillResource(view, name, value, index = 0) {
  const input = resource(view, name, index); assert.equal(input.disabled, false)
  if (input.type === 'checkbox') input.checked = value
  else input.value = value
  input.dispatch('input')
}
async function click(view, name) { assert.equal(field(view, name).disabled, false); field(view, name).click(); await idle(view) }
async function mount() {
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources, download: (name, contents) => downloads.push({ name, contents }) })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); return view
}
async function starter(view) { field(view, 'starter').value = 'resource-action-plan'; await click(view, 'use-starter') }
async function exportedDraft(view) { await click(view, 'draft-export'); return JSON.parse(downloads.at(-1).contents) }
beforeEach(() => {
  installed = installDomStandIn(globalThis)
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  const values = new Map(); downloads = []
  account = { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } }, async putSetting(key, value) { values.set(key, value); return { ok: true } } }
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
  else delete globalThis.crypto
})

test('resource starter generates usable recorded controls and public-only previews before a qualified portable run', async () => {
  const view = await mount(); await starter(view)
  const { spec } = await exportedDraft(view)
  assert.equal(spec.experimentTemplate.kind, 'resource-action-plan')
  assert.equal(spec.tasks.length, 2); assert.equal(spec.conditions.length, 2)
  assert.equal(spec.protocol.maxAttemptsPerTrial, 1)
  assert.equal(spec.protocol.grading.kind, 'resource-action-plan')
  assert.equal(spec.tasks[0].resource.resources.find(row => row.id === 'private-control').visible, false)
  assert.doesNotMatch(field(view, 'resource-preview').textContent, /PRIVATE_RESOURCE_CONTROL|private-control|referencePlan/)
  assert.match(field(view, 'resource-preview').textContent, /maxPlanBytes|logicalIdPattern/)
  await click(view, 'freeze')
  assert.equal(field(view, 'run').disabled, false, field(view, 'status').textContent)
  await click(view, 'run')
  assert.match(field(view, 'results').textContent, /4 of 4 trials completed/)
  assert.match(field(view, 'resource-results').textContent, /Observed resource effects/)
  assert.match(field(view, 'resource-results').textContent, /Ever collateral|Final collateral|Peak collateral/)
  await click(view, 'export-evidence')
  const evidence = JSON.parse(downloads.at(-1).contents)
  assert.equal(evidence.events[0].type, 'template-preparation-started')
  assert.equal(evidence.events[1].type, 'template-qualified')
  assert.equal(evidence.events[1].preparationSeq, evidence.events[0].seq)
  assert.equal(evidence.events.filter(row => row.type === 'resource-prepared').length, 4)
  assert.equal(evidence.events.filter(row => row.type === 'resource-closed').length, 4)
  assert.equal(evidence.events.filter(row => row.type === 'finished' && row.grade.passed).length, 2)
})

test('resource field changes block freezing and generation rebuilds prompts, packets and recorded responses from those fields', async () => {
  const view = await mount(); await starter(view)
  const previous = (await exportedDraft(view)).spec.tasks[0].resource.sha256
  fillResource(view, 'case-instruction', 'Set target to reviewed-value. Leave every other resource unchanged.')
  fillResource(view, 'goal-value', 'reviewed-value')
  fillResource(view, 'resource-value', 'fresh-initial-value')
  fillResource(view, 'resource-value', 'PRIVATE_UI_REGENERATION_SENTINEL', 2)
  await click(view, 'freeze')
  assert.match(field(view, 'status').textContent, /pending.*experiment|experiment.*edits/i)
  assert.equal((await exportedDraft(view)).spec.tasks[0].resource.sha256, previous, 'Unapplied fields do not silently replace the generated task.')
  await click(view, 'apply-resource-template')
  assert.match(field(view, 'status').textContent, /2 resource cases generated/)
  const { spec, pending } = await exportedDraft(view), task = spec.tasks[0]
  assert.notEqual(task.resource.sha256, previous)
  assert.equal(task.resource.resources.find(row => row.id === 'target').value, 'fresh-initial-value')
  assert.equal(task.resource.goals[0].value, 'reviewed-value')
  assert.equal(task.input.goals[0].value, 'reviewed-value')
  assert.equal(spec.conditions[0].adapter.responses[task.id].actions[0].value, 'reviewed-value')
  assert.equal(pending.includes('experiment'), false)
  assert.doesNotMatch(field(view, 'resource-preview').textContent, /PRIVATE_UI_REGENERATION_SENTINEL|private-control/)
  await click(view, 'freeze'); await click(view, 'run')
  assert.match(field(view, 'results').textContent, /4 of 4 trials completed/)
})

test('invalid action-limit field text survives generation refusal, saved project switches and a fresh builder mount', async () => {
  let view = await mount(); await starter(view)
  const invalid = 'not yet chosen'
  fillResource(view, 'max-actions', invalid)
  await click(view, 'apply-resource-template')
  assert.match(field(view, 'status').textContent, /actions|integer/i)
  assert.equal(resource(view, 'max-actions').value, invalid)
  assert.equal((await exportedDraft(view)).spec.experimentTemplate.maxActions, 8)
  await click(view, 'save'); await view.setContext(B, 'live')
  assert.equal(resource(view, 'max-actions').value, '8')
  await view.setContext(A, 'live')
  assert.equal(resource(view, 'max-actions').value, invalid)
  view.destroy(); view.el.remove(); views.splice(views.indexOf(view), 1)
  view = await mount()
  assert.equal(resource(view, 'max-actions').value, invalid)
  await click(view, 'freeze'); assert.match(field(view, 'status').textContent, /pending.*experiment|experiment.*edits/i)
  fillResource(view, 'max-actions', '8'); await click(view, 'apply-resource-template')
  await click(view, 'freeze'); assert.equal(field(view, 'run').disabled, false, field(view, 'status').textContent)
})

test('reducing the action budget regenerates a valid reference-only default without a stale generated contrast', async () => {
  const view = await mount(); await starter(view)
  fillResource(view, 'max-actions', '1'); await click(view, 'apply-resource-template')
  const { spec } = await exportedDraft(view)
  assert.equal(spec.conditions.length, 1)
  assert.equal(spec.conditions[0].id, 'reference-plan')
  assert.ok(spec.analysisPlan.contrasts.every(row => spec.conditions.some(condition => condition.id === row.first) && spec.conditions.some(condition => condition.id === row.second)))
  await click(view, 'freeze'); assert.equal(field(view, 'run').disabled, false, field(view, 'status').textContent)
  await click(view, 'run'); assert.match(field(view, 'results').textContent, /2 of 2 trials completed/)
})

test('regeneration refuses to remove a control used by an investigator-authored contrast and retains the pending fields', async () => {
  const view = await mount(); await starter(view)
  const contrast = [{ id: 'investigator-comparison', first: 'reference-plan', second: 'collateral-control' }]
  field(view, 'analysis-contrasts').value = JSON.stringify(contrast); field(view, 'analysis-contrasts').dispatch('input')
  await click(view, 'apply-analysis')
  fillResource(view, 'max-actions', '1'); await click(view, 'apply-resource-template')
  assert.match(field(view, 'status').textContent, /planned comparison.*remove|compatible analysis plan/i)
  const refused = await exportedDraft(view)
  assert.deepEqual(refused.spec.analysisPlan.contrasts, contrast)
  assert.equal(refused.spec.experimentTemplate.maxActions, 8)
  assert.equal(refused.spec.conditions.length, 2)
  assert.equal(resource(view, 'max-actions').value, '1')
  assert.ok(refused.pending.includes('experiment'))
  field(view, 'analysis-contrasts').value = '[]'; field(view, 'analysis-contrasts').dispatch('input')
  await click(view, 'apply-analysis')
  assert.equal(resource(view, 'max-actions').value, '1')
  await click(view, 'apply-resource-template')
  const applied = await exportedDraft(view)
  assert.equal(applied.spec.conditions.length, 1)
  assert.deepEqual(applied.spec.analysisPlan.contrasts, [])
  await click(view, 'freeze'); assert.equal(field(view, 'run').disabled, false, field(view, 'status').textContent)
})
