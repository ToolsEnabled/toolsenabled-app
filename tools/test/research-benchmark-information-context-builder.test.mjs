import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import { resolve } from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { createReviewRecord } from '../../src/benchmark/prompts.mjs'
import { newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { observationPlanFromSpec } from '../../src/benchmark/observations.mjs'
import { workflowDraft } from '../../src/benchmark/workflow.mjs'
import { informationFixture } from './fixtures/research-benchmark-information.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
const reviewer = 'SYNTHETIC MOUNTED INFORMATION CONTEXT; NO INVESTIGATOR APPROVAL'
let installed, cryptoDescriptor, account, downloads
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const status = view => field(view, 'status').textContent
const specOf = view => JSON.parse(field(view, 'spec-json').value)
const packetOf = view => JSON.parse(field(view, 'information-packet').textContent)
async function until(predicate, message = 'Information context did not settle.') {
  for (let i = 0; i < 800; i++) { if (predicate()) return; await pause() }
  assert.fail(message)
}
async function idle(view) { await until(() => view.el.getAttribute('aria-busy') === 'false', status(view)) }
function fill(view, name, value) {
  const node = field(view, name); assert.ok(node, name); assert.equal(node.disabled, false)
  if (node.type === 'checkbox') node.checked = value; else node.value = value
  node.dispatch('input')
}
async function click(view, name) {
  const button = field(view, name); assert.ok(button, name); assert.equal(button.disabled, false, name + ': ' + status(view))
  button.click(); await idle(view)
}
function memoryAccount() {
  const values = new Map()
  return { values, async getSetting(key) { return { ok: true, value: values.get(key) ?? null } },
    async putSetting(key, value) { values.set(key, value); return { ok: true } } }
}
async function mount(overrides = {}) {
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources, download: (name, contents) => downloads.push({ name, contents }), ...overrides })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); return view
}
async function importDraft(view, value) {
  const text = JSON.stringify(value), node = field(view, 'import')
  node.files = [{ name: 'synthetic-information-context.json', size: Buffer.byteLength(text), text: async () => text }]
  node.dispatch('change'); await idle(view); assert.match(status(view), /Draft imported/)
}
async function draft(view) { await click(view, 'draft-export'); return JSON.parse(downloads.at(-1).contents) }
async function retain(name, value) {
  const directory = process.env.RESEARCH_BENCHMARK_INFORMATION_CONTEXT_EVIDENCE
  if (!directory) return
  await mkdir(directory, { recursive: true }); await writeFile(resolve(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n')
}
async function fixture({ workflow = true } = {}) {
  const spec = newExperimentDraft(informationFixture(), { purpose: 'recorded-diagnostic', initializePopulation: true })
  spec.requireReview = true; spec.id = 'information-context-controls'; spec.name = 'Synthetic information context controls'
  spec.conditions = ['control', 'treatment'].map(id => ({ id,
    model: { provider: 'saved-fixture', id: id + '-model', settings: { temperature: 0 } },
    adapter: { kind: 'replay', responses: { 'number-task': 1 } },
  }))
  spec.protocol.maxTotalAttempts = 2
  if (workflow) {
    spec.observationPlan = observationPlanFromSpec()
    const base = workflowDraft(spec).plan.workflows[0]
    spec.workflowPlan = { version: 1, workflows: spec.conditions.map(condition => ({ ...structuredClone(base), id: condition.id + '-flow',
      purpose: 'treatment', rationale: 'Synthetic ' + condition.id + ' context, no additional number disclosed.',
    })) }
    for (const condition of spec.conditions) {
      condition.workflowId = condition.id + '-flow'
      condition.adapter = { kind: 'replay', mode: 'envelope', responses: {}, workflowResponses: { 'number-task': { answer: { output: 1, workflow: { toolCalls: [] } } } } }
    }
  }
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, reviewer)))
  return spec
}
async function currentReview(view, approved) {
  await until(() => approved
    ? /has a current review/.test(field(view, 'information-review-status').textContent)
    : /no current review/.test(field(view, 'information-review-status').textContent),
  'Expected information review status ' + approved + ': ' + field(view, 'information-review-status').textContent)
}
async function prepareAndReview(view) {
  await click(view, 'prepare-information')
  const packet = packetOf(view)
  assert.equal(packet.version, 2)
  assert.equal(packet.recipe.version, 1, 'The interpretation recipe version is separate from the new review packet.')
  assert.equal(packet.collectionContext.version, 1)
  assert.deepEqual(packet.collectionContext.conditions.map(row => row.id), ['control', 'treatment'])
  assert.deepEqual(packet.collectionContext.conditions.map(row => row.model.id), ['control-model', 'treatment-model'])
  assert.deepEqual(packet.collectionContext.conditions.map(row => row.adapterKind), ['replay', 'replay'])
  assert.deepEqual(packet.collectionContext.conditions.map(row => row.workflowId), specOf(view).workflowPlan ? ['control-flow', 'treatment-flow'] : [null, null])
  assert.deepEqual(packet.collectionContext.workflowPlan, specOf(view).workflowPlan || null)
  assert.equal(packet.collectionContext.ordinaryCollectionIncluded, !!specOf(view).observationPlan)
  assert.equal(packet.prompt, 'Produce the requested number.\n')
  assert.equal(packet.readings.length, 2)
  assert.equal(specOf(view).taskReviews?.length || 0, 0, 'Preparing never supplies an approval.')
  fill(view, 'information-reviewer', reviewer); await click(view, 'approve-information')
  await currentReview(view, true)
  assert.equal(specOf(view).taskReviews.length, 1)
  assert.equal(specOf(view).taskReviews[0].packetSha256, packet.sha256)
  await click(view, 'freeze'); assert.equal(field(view, 'export').disabled, false, status(view))
  assert.equal(field(view, 'export-evidence').disabled, true, 'A review and Freeze do not create execution evidence.')
  return packet
}
async function applyWorkflow(view, workflow) {
  fill(view, 'workflow-config', JSON.stringify(workflow, null, 2)); await click(view, 'apply-workflow')
  assert.match(status(view), /Workflow applied/)
}
async function staleFreeze(view, baseline) {
  await currentReview(view, false)
  const packet = packetOf(view)
  assert.notEqual(packet.sha256, baseline.sha256)
  assert.equal(specOf(view).taskReviews.length, 1)
  assert.equal(specOf(view).taskReviews[0].packetSha256, baseline.sha256)
  await click(view, 'approve-information'); assert.match(status(view), /Prepare and inspect/)
  assert.equal(specOf(view).taskReviews.length, 1)
  await click(view, 'freeze')
  assert.match(status(view), /review the current visible prompt and complete admissible-reading packet/)
  assert.equal(field(view, 'export').disabled, true); assert.equal(field(view, 'export-evidence').disabled, true)
  return packet
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

test('applied workflow disclosure invalidates the current information review and exact restored context restores only that original review', async () => {
  const view = await mount(); await importDraft(view, await fixture())
  const baseline = await prepareAndReview(view), original = JSON.parse(field(view, 'workflow-config').value)
  await applyWorkflow(view, original)
  await currentReview(view, true); assert.equal(packetOf(view).sha256, baseline.sha256)
  await click(view, 'freeze'); assert.equal(field(view, 'export').disabled, false)
  const edited = structuredClone(original), stage = edited.plan.workflows.find(row => row.id === 'treatment-flow').stages[0]
  stage.includeTaskPrompt = false
  stage.instructions.system = 'The required number is 2. Only 2 satisfies this task.'
  stage.instructions.user = 'Return the required number as JSON.'
  await applyWorkflow(view, edited)
  const changed = await staleFreeze(view, baseline)
  assert.deepEqual(changed.readings, baseline.readings, 'The platform invalidates the review instead of guessing new semantic readings.')
  const changedDraft = await draft(view)
  await applyWorkflow(view, original)
  await currentReview(view, true); assert.equal(packetOf(view).sha256, baseline.sha256)
  await click(view, 'freeze'); assert.equal(field(view, 'export').disabled, false, status(view))
  assert.equal(specOf(view).taskReviews.length, 1)
  assert.equal(specOf(view).executionPlan.purpose, 'recorded-diagnostic')
  await retain('workflow-disclosure-and-restoration', { baseline, changed, changedDraft, restored: await draft(view) })
})

test('swapping condition workflow assignments invalidates review even when the complete plan and task are unchanged', async () => {
  const view = await mount(); await importDraft(view, await fixture())
  const baseline = await prepareAndReview(view), original = JSON.parse(field(view, 'workflow-config').value)
  const swapped = structuredClone(original)
  swapped.assignments = { control: 'treatment-flow', treatment: 'control-flow' }
  await applyWorkflow(view, swapped)
  const changed = await staleFreeze(view, baseline)
  assert.deepEqual(specOf(view).workflowPlan, original.plan)
  assert.deepEqual(changed.readings, baseline.readings)
  await click(view, 'prepare-information'); assert.equal(packetOf(view).sha256, changed.sha256)
  assert.equal(specOf(view).taskReviews.length, 1)
  await currentReview(view, false)
  await retain('assignment-review-refusal', { baseline, changed, draft: await draft(view) })
})

test('ordinary requested model and settings changes without accounting invalidate an information review through Apply protocol', async () => {
  const view = await mount(); await importDraft(view, await fixture({ workflow: false }))
  const baseline = await prepareAndReview(view), original = structuredClone(specOf(view).conditions)
  assert.equal(specOf(view).observationPlan, undefined)
  const conditions = structuredClone(original)
  conditions[1].model.id = 'different-requested-model'; conditions[1].model.settings.temperature = 0.75
  fill(view, 'conditions', JSON.stringify(conditions, null, 2)); await click(view, 'apply-protocol')
  assert.match(status(view), /Protocol applied/)
  const changed = await staleFreeze(view, baseline)
  assert.equal(specOf(view).observationPlan, undefined)
  assert.deepEqual(specOf(view).conditions, conditions)
  fill(view, 'conditions', JSON.stringify(original, null, 2)); await click(view, 'apply-protocol')
  await currentReview(view, true); assert.equal(packetOf(view).sha256, baseline.sha256)
  await click(view, 'freeze'); assert.equal(field(view, 'export').disabled, false, status(view))
  await retain('no-accounting-model-change', { baseline, changed, restored: await draft(view) })
})

test('pending context text survives save and remount and cannot be approved or carried into another project or account', async () => {
  const view = await mount(); await importDraft(view, await fixture())
  const baseline = await prepareAndReview(view)
  fill(view, 'workflow-config', '{unfinished workflow context')
  fill(view, 'conditions', '[unfinished requested models')
  const before = await draft(view)
  assert.deepEqual(before.pending.sort(), ['protocol', 'workflow'])
  await click(view, 'prepare-information'); assert.match(status(view), /Apply the current.*protocol.*workflow.*edits first/)
  await click(view, 'approve-information'); assert.match(status(view), /Apply the current.*protocol.*workflow.*edits first/)
  assert.equal(specOf(view).taskReviews.length, 1)
  await click(view, 'save')
  const restored = await mount()
  assert.equal(field(restored, 'workflow-config').value, '{unfinished workflow context')
  assert.equal(field(restored, 'conditions').value, '[unfinished requested models')
  assert.equal(specOf(restored).taskReviews[0].packetSha256, baseline.sha256)
  await click(restored, 'freeze'); assert.match(status(restored), /pending editor changes/)
  await restored.setContext(B, 'live'); await idle(restored)
  assert.equal(specOf(restored).taskReviews?.length || 0, 0)
  assert.equal(field(restored, 'information-packet').textContent, '')
  assert.notEqual(field(restored, 'workflow-config').value, '{unfinished workflow context')
  await restored.setContext(A, 'live'); await idle(restored)
  assert.equal(field(restored, 'workflow-config').value, '{unfinished workflow context')
  Object.assign(account, memoryAccount())
  await restored.setContext(A, 'live', { reload: true }); await idle(restored)
  assert.equal(specOf(restored).taskReviews?.length || 0, 0)
  assert.equal(field(restored, 'information-packet').textContent, '')
  assert.equal(field(restored, 'information-reviewer').value, '')
  assert.deepEqual((await draft(restored)).pending, [])
  await retain('pending-save-and-isolation', { before, newAccount: await draft(restored) })
})

test('a delayed packet preparation cannot publish or approve the old context after an account reload', async () => {
  let held = false, release, entered = false
  const view = await mount({ loadSources: async () => {
    if (held) { entered = true; await new Promise(resolve => { release = resolve }) }
    return sources
  } })
  await importDraft(view, await fixture())
  held = true
  field(view, 'prepare-information').click()
  await until(() => entered)
  Object.assign(account, memoryAccount())
  await view.setContext(A, 'live', { reload: true }); await idle(view)
  const afterSwitch = await draft(view)
  held = false; release(); await pause(); await idle(view)
  assert.deepEqual((await draft(view)).spec, afterSwitch.spec)
  assert.equal(field(view, 'information-packet').textContent, '')
  assert.equal(specOf(view).taskReviews?.length || 0, 0)
  fill(view, 'information-reviewer', reviewer); await click(view, 'approve-information')
  assert.match(status(view), /Prepare and inspect/)
  assert.equal(specOf(view).taskReviews?.length || 0, 0)
  assert.equal(field(view, 'export-evidence').disabled, true)
  await retain('delayed-prepare-isolation', { afterSwitch, final: await draft(view) })
})
