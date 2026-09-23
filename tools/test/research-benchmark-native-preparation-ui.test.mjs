import assert from 'node:assert/strict'
import test, { beforeEach, afterEach } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { activationFixture } from './fixtures/research-benchmark-activation.mjs'
import { bindRuntimeSources, freezeStudy, verifyProject, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { canonical, createReviewRecord, sha256 } from '../../src/benchmark/prompts.mjs'
import { newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { materializeNativeControl, verifyNativeControl } from '../../src/benchmark/audit.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
const at = '2026-09-09T00:00:00.000Z', pause = () => new Promise(resolve => setTimeout(resolve, 3)), turn = () => new Promise(resolve => setImmediate(resolve))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']'), status = view => field(view, 'status').textContent
const specOf = view => JSON.parse(field(view, 'spec-json').value), planOf = view => JSON.parse(field(view, 'native-preparation-plan').textContent)
let installed, cryptoDescriptor, fetchDescriptor, account, downloads, networkCalls
const recipe = { version: 1, coverage: 'all-selected-readings-occurrences-and-probes', rationale: 'Explicit synthetic native controls for five registered composition occurrences.',
  referenceReplicates: 3, mutantReplicates: 1, budgets: { maxNativeExecutions: 100, executionTimeoutMs: 120000, attemptTimeoutMs: 150000, maxDurationMs: 3600000 } }
const planFields = { rationale: recipe.rationale, 'reference-replicates': '3', 'mutant-replicates': '1', 'max-executions': '100',
  'execution-timeout': '120000', 'attempt-timeout': '150000', duration: '3600000' }
async function until(predicate, message = 'Native preparation fields did not settle.') {
  for (let n = 0; n < 1400; n++) { if (predicate()) return; await pause() }
  assert.fail(message)
}
async function idle(view) { await until(() => view.el.getAttribute('aria-busy') === 'false', status(view)) }
function input(view, name, value) {
  const node = field(view, name); assert.ok(node, name); assert.equal(node.disabled, false, name)
  node.value = value; node.dispatch('input')
}
async function click(view, name) {
  const node = field(view, name); assert.ok(node, name); assert.equal(node.disabled, false, name + ': ' + status(view))
  node.click(); await idle(view)
}
function memoryAccount() {
  const values = new Map()
  return { values, async getSetting(key) { return { ok: true, value: values.get(key) ?? null } },
    async putSetting(key, value) { values.set(key, value); return { ok: true } } }
}
async function mount(overrides = {}) {
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources,
    download: (name, contents, type) => downloads.push({ name, contents, type }), ...overrides })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); return view
}
async function fixture({ inactive = false } = {}) {
  let spec = newExperimentDraft(await activationFixture({ inactive }), { purpose: 'experiment', initializePopulation: true })
  spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 120000 }; spec.protocol.timeoutMs = 150000
  spec.environment.leanImage = 'synthetic-unavailable-image@sha256:' + 'c'.repeat(64)
  spec.conditions[0].adapter.responses = { [spec.tasks[0].id]: '# UNUSED SYNTHETIC RESPONSE; NO EXECUTION' }
  const attachments = { 'inputs/retained-note.txt': 'SYNTHETIC PRIVATE RETAINED INPUT; never sent to a provider.\n' }
  spec.inputs = [{ path: 'inputs/retained-note.txt', sha256: await sha256(attachments['inputs/retained-note.txt']) }]
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC TEST RECORD; NO PERSONAL APPROVAL', { at })))
  return { spec, attachments }
}
async function importDraft(view, f) {
  const text = JSON.stringify(f), node = field(view, 'import')
  node.files = [{ name: 'synthetic-native-control-draft.json', size: Buffer.byteLength(text), text: async () => text }]
  node.dispatch('change'); await idle(view); assert.match(status(view), /Draft imported/)
}
function fillPlan(view, fields = {}) {
  input(view, 'native-preparation-mode', 'planned')
  for (const [name, text] of Object.entries({ ...planFields, ...fields })) input(view, 'native-preparation-' + name, text)
}
async function applied(view, f = null) {
  f ||= await fixture()
  await importDraft(view, f); fillPlan(view); await click(view, 'apply-native-preparation')
  assert.match(status(view), /Native control plan applied/); return f
}
async function exportedDraft(view) { await click(view, 'draft-export'); return JSON.parse(downloads.at(-1).contents) }
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder(), files = {}
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    assert.equal(view.getUint16(offset + 8, true), 0, 'The portable ZIP uses stored UTF-8 files.')
    const size = view.getUint32(offset + 18, true), length = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true)
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + length)), start = offset + 30 + length + extra
    assert.equal(Object.hasOwn(files, name), false); files[name] = decoder.decode(bytes.subarray(start, start + size)); offset = start + size
  }
  return files
}
async function retain(name, value) {
  const directory = process.env.RESEARCH_NATIVE_PREPARATION_UI_EVIDENCE
  if (!directory) return
  await mkdir(directory, { recursive: true }); await writeFile(resolve(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}
beforeEach(() => {
  installed = installDomStandIn(globalThis); cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  networkCalls = 0; Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => { networkCalls++; throw new Error('Native preparation authoring must not collect or execute.') } })
  account = memoryAccount(); downloads = []
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await turn(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
  if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor); else delete globalThis.fetch
  assert.equal(networkCalls, 0)
})

test('ordinary fields apply the complete exact recipe and preview every occurrence without native qualification', async () => {
  const view = await mount(), f = await fixture()
  assert.equal(field(view, 'native-preparation-mode').value, 'none'); assert.equal(field(view, 'native-preparation-rationale').value, '')
  assert.equal(specOf(view).nativePreparationPlan, undefined)
  await applied(view, f)
  assert.deepEqual(specOf(view).nativePreparationPlan, recipe)
  assert.deepEqual(specOf(view).reviews, f.spec.reviews, 'No new review or approval was generated.')
  const plan = planOf(view)
  assert.deepEqual(plan.counts, { jobs: 6, referenceJobs: 1, mutantJobs: 5, nativeExecutions: 8, coverageRows: 10 })
  assert.equal(new Set(plan.coverage.map(row => row.requirementId)).size, 5)
  assert.deepEqual(plan.coverage.map(row => row.scope), Array.from({ length: 5 }, () => ['selected-input', 'probe']).flat())
  assert.equal(plan.coverageStatus, 'complete'); assert.equal(plan.executionStatus, 'not-run')
  assert.ok(plan.apparatusRequirements.length > 0)
  const before = await exportedDraft(view)
  await click(view, 'prepare-native-preparation'); assert.match(status(view), /roster previewed/)
  assert.deepEqual(await exportedDraft(view), before, 'Preview does not apply source pins, approvals or field changes.')
  assert.equal(field(view, 'export-native-control').disabled, true)
  await click(view, 'freeze'); assert.match(status(view), /Project frozen/)
  assert.match(field(view, 'readiness').textContent, /Native candidate collection remains blocked/)
  assert.equal(field(view, 'run').disabled, true); assert.equal(field(view, 'native-control-job').value, '')
  await retain('fields-and-plan', { draft: await exportedDraft(view), plan: planOf(view), readiness: field(view, 'readiness').textContent })
})

test('selected reference and mutant ZIPs equal shared generation and preserve the own-task oracle and parent binding', async () => {
  const view = await mount(), f = await applied(view)
  await click(view, 'freeze'); const parent = await freezeStudy(specOf(view)), plan = planOf(view), frozenText = field(view, 'frozen').textContent
  await click(view, 'export'); const parentFiles = unzip(downloads.at(-1).contents)
  assert.deepEqual(JSON.parse(parentFiles['native-preparation/plan.json']), parent.nativePreparation)
  assert.match(parentFiles['native-preparation/README.md'], /does not implement an owned preparation runner/)
  assert.match(parentFiles['native-preparation/README.md'], /does not enforce|do not enforce/)
  assert.ok(!Object.keys(parentFiles).some(name => name.includes('control-project/')))
  const retained = []
  for (const kind of ['reference', 'mutant']) {
    const job = plan.jobs.find(row => row.kind === kind), selected = field(view, 'native-control-job')
    input(view, 'native-control-job', job.id); selected.dispatch('change'); await idle(view)
    assert.equal(field(view, 'frozen').textContent, frozenText, 'Control navigation does not invalidate the parent.')
    await click(view, 'export-native-control'); assert.match(status(view), /Native control project exported/)
    const zipped = downloads.at(-1), files = unzip(zipped.contents), child = JSON.parse(files['project.json']), binding = JSON.parse(files['native-control/binding.json'])
    const envelope = await materializeNativeControl(parent, job.id, { runtimeFiles: sources, inputFiles: f.attachments })
    await verifyNativeControl({ parentProject: parent, control: envelope }, { runtimeFiles: sources, inputFiles: f.attachments })
    assert.deepEqual(files, await projectFiles(envelope.controlProject, sources, { ...f.attachments, 'native-control/binding.json': canonical(envelope.binding) + '\n' }))
    await verifyProject(child)
    assert.equal(binding.parentProjectSha256, parent.sha256); assert.equal(binding.jobId, job.id)
    assert.deepEqual(child.tasks[0].expected, binding.programExpected)
    if (kind === 'mutant') assert.notDeepEqual(binding.programExpected, binding.referenceExpected)
    assert.equal(child.spec.executionPlan.purpose, 'apparatus-development'); assert.equal(child.spec.analysisPlan.cohort, 'qualification')
    assert.equal(child.spec.analysisPlan.primaryDenominator, 'scheduled'); assert.equal(child.schedule.length, job.replicates)
    assert.equal(child.nativePreparation, undefined); assert.equal(child.spec.requirementPlan, undefined)
    assert.deepEqual(child.spec.reviews, parent.spec.reviews)
    assert.equal(await sha256(files['native-control/binding.json']), child.spec.inputs.find(row => row.path === 'native-control/binding.json').sha256)
    assert.equal(files['inputs/retained-note.txt'], f.attachments['inputs/retained-note.txt'])
    assert.match(field(view, 'native-control-status').textContent, /has not been executed or qualified/)
    retained.push({ kind, jobId: job.id, childProjectSha256: child.sha256, binding, zipSha256: await sha256(zipped.contents), files: Object.keys(files) })
  }
  assert.equal(field(view, 'run').disabled, true); assert.equal(field(view, 'frozen').textContent, frozenText)
  await retain('selected-exports', { parentProjectSha256: parent.sha256, jobs: retained })
})

test('invalid text survives atomic refusal, save/remount and another panel apply; pending fields block freeze', async () => {
  let view = await mount(); await applied(view)
  input(view, 'native-preparation-execution-timeout', '12e')
  const before = await exportedDraft(view)
  await click(view, 'apply-native-preparation'); assert.match(status(view), /complete nonnegative integer/)
  assert.deepEqual(await exportedDraft(view), before)
  await click(view, 'freeze'); assert.match(status(view), /pending editor changes.*nativePreparation/)
  input(view, 'analysis-rationale', 'Explicit retained descriptive analysis rationale.'); await click(view, 'apply-analysis')
  assert.equal(field(view, 'native-preparation-execution-timeout').value, '12e')
  await click(view, 'save'); view.destroy(); view.el.remove()
  view = await mount()
  assert.equal(field(view, 'native-preparation-execution-timeout').value, '12e')
  assert.ok((await exportedDraft(view)).pending.includes('nativePreparation'))
  input(view, 'native-preparation-execution-timeout', '120000'); input(view, 'native-preparation-attempt-timeout', '149999')
  const invalid = await exportedDraft(view)
  await click(view, 'apply-native-preparation'); assert.match(status(view), /30000 ms/)
  assert.deepEqual(await exportedDraft(view), invalid)
  await retain('retained-invalid-fields', invalid)
})

test('explicit removal and Undo restore the applied plan and raw fields; incomplete controls remain visible', async () => {
  const view = await mount(); await applied(view, await fixture({ inactive: true }))
  const beforePlan = specOf(view).nativePreparationPlan, plan = planOf(view)
  assert.equal(plan.coverageStatus, 'incomplete'); assert.ok(plan.gaps.some(row => row.kind === 'indistinguishable-mutant'))
  assert.match(field(view, 'native-preparation-status').textContent, /Coverage incomplete/)
  input(view, 'native-preparation-mode', 'none'); const beforeRemoval = await exportedDraft(view)
  await click(view, 'apply-native-preparation'); assert.equal(specOf(view).nativePreparationPlan, undefined)
  await click(view, 'undo')
  const restored = await exportedDraft(view)
  assert.deepEqual(restored, beforeRemoval); assert.deepEqual(specOf(view).nativePreparationPlan, beforePlan)
  assert.equal(field(view, 'native-preparation-mode').value, 'none', 'Undo retains the pre-apply raw removal choice rather than inventing a fresh editor state.')
})

test('editing the frozen task invalidates generated job selection and refuses stale control export', async () => {
  const view = await mount(); await applied(view); await click(view, 'freeze')
  const job = planOf(view).jobs[0]
  input(view, 'native-control-job', job.id); field(view, 'native-control-job').dispatch('change'); await idle(view)
  assert.equal(field(view, 'export-native-control').disabled, false)
  input(view, 'input', '{"unfinished":')
  assert.equal(field(view, 'export-native-control').disabled, true); assert.equal(field(view, 'native-control-job').value, '')
  assert.equal(field(view, 'native-preparation-plan').textContent, '')
  await click(view, 'prepare-native-preparation'); assert.match(status(view), /Apply the current input edits first/)
  assert.equal(field(view, 'input').value, '{"unfinished":')
})

test('a delayed selected-control export cannot publish or retain job identities across a project/account reset', async () => {
  let hold = false, entered = false, release
  const deferred = new Promise(resolve => { release = resolve })
  const view = await mount({ loadSources: async () => { if (hold) { hold = false; entered = true; await deferred } return sources } })
  await applied(view); await click(view, 'freeze')
  input(view, 'native-control-job', planOf(view).jobs[0].id); field(view, 'native-control-job').dispatch('change'); await idle(view)
  hold = true; const count = downloads.length
  field(view, 'export-native-control').click(); await until(() => entered)
  await view.setContext(B, 'live', { reload: true }); await idle(view)
  const before = { spec: field(view, 'spec-json').value, status: status(view) }
  release(); await turn(); await turn()
  assert.equal(downloads.length, count); assert.deepEqual({ spec: field(view, 'spec-json').value, status: status(view) }, before)
  assert.equal(field(view, 'native-control-job').value, ''); assert.equal(field(view, 'native-preparation-rationale').value, '')
  assert.equal(field(view, 'native-preparation-mode').value, 'none'); assert.equal(field(view, 'native-preparation-plan').textContent, '')
  assert.equal(field(view, 'export-native-control').disabled, true)
})
