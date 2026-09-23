import { useArithmeticExample } from './lib/benchmark-example.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES, STUDY_VERSION, verifyProject } from '../../src/benchmark/study.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { genericActivationFixture } from './fixtures/research-benchmark-generic-activation.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
let installed, cryptoDescriptor, account, downloads
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const control = (view, name) => view.el.querySelector('[data-requirement-fields-' + name + ']')
async function idle(view) {
  for (let index = 0; index < 800; index++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('The readiness builder did not settle.')
}
const input = (node, value) => { assert.ok(node); assert.equal(node.disabled, false); node.value = value; node.dispatch('input') }
const fill = (view, name, value) => input(field(view, name), value)
const fillControl = (view, name, value) => input(control(view, name), value)
async function click(view, name) { const button = field(view, name); assert.ok(button, name); assert.equal(button.disabled, false, name + ': ' + field(view, 'status').textContent); button.click(); await idle(view) }
const clickControl = (view, name) => { const button = control(view, name); assert.equal(button.disabled, false); button.click() }
const memoryAccount = () => {
  const values = new Map()
  return { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } }, async putSetting(key, value) { values.set(key, value); return { ok: true } } }
}
async function mount(overrides = {}) {
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources, download: (name, contents) => downloads.push({ name, contents }), ...overrides })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); await useArithmeticExample(view); return view
}
async function importDraft(view, data) { const contents = JSON.stringify(data); field(view, 'import').files = [{ size: contents.length, text: async () => contents }]; field(view, 'import').dispatch('change'); await idle(view) }
async function exportedDraft(view) { await click(view, 'draft-export'); return JSON.parse(downloads.at(-1).contents) }
async function selectPurpose(view, purpose) { fill(view, 'execution-purpose', purpose); await click(view, 'apply-execution') }
async function prepareGeneric(view) {
  const fixture = await genericActivationFixture(), spec = newExperimentDraft(fixture.spec, { purpose: 'experiment', initializePopulation: true })
  delete spec.requirementPlan; spec.inputs = []
  await importDraft(view, spec)
  for (const [path, contents] of Object.entries(fixture.attachments)) {
    fill(view, 'attachment-path', path); fill(view, 'attachment-text', contents); await click(view, 'attach')
  }
  await click(view, 'prepare-requirement-fields')
  assert.equal(control(view, 'target').children.length, 1)
  return fixture
}
function fillGenericControl(view) {
  fillControl(view, 'rationale', 'Every generated occurrence must be active and distinguish its local alternative on both independent witness and selected input.')
  fillControl(view, 'reference', 'interpreters/direct.mjs'); fillControl(view, 'independent', 'interpreters/steps.mjs')
  fillControl(view, 'interpreter-rationale', 'Direct arithmetic and repeated signed unit steps are separately implemented algorithms over the bounded integer input domain.')
  fillControl(view, 'target-rationale', 'The declared first operand must contribute its actual value to the requested sum.')
  fillControl(view, 'activation-name', 'evaluated')
  const offset = view.el.querySelector('[data-requirement-fields-value-context="probe-0/input/offset"] [data-requirement-fields-value-text]')
  input(offset, '2')
  clickControl(view, 'add-assertion'); fillControl(view, 'assertion-path', '[]')
  let assertion = control(view, 'assertion')
  input(assertion.querySelector('[data-requirement-fields-value-kind]'), 'string')
  assertion = control(view, 'assertion'); input(assertion.querySelector('[data-requirement-fields-value-text]'), '7')
  clickControl(view, 'add-alternative'); fillControl(view, 'parameter', 'a')
  input(control(view, 'alternative').querySelector('[data-requirement-fields-value-text]'), '1')
  fillControl(view, 'alternative-rationale', 'Substituting one for the first operand subtracts one from the requested sum while leaving the other operands intact.')
}
function unzipStored(bytes) {
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
beforeEach(() => {
  installed = installDomStandIn(globalThis); cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto }); account = memoryAccount(); downloads = []
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
})

test('default experiments refuse an unqualified matching answer key while explicit recorded diagnostics retain their limited scope', async () => {
  const view = await mount(), initial = await exportedDraft(view)
  assert.equal(initial.spec.schemaVersion, STUDY_VERSION); assert.equal(initial.spec.executionPlan.purpose, 'experiment')
  fill(view, 'expected', '"999"'); await click(view, 'apply-input')
  const conditions = JSON.parse(field(view, 'conditions').value); conditions[0].adapter.responses['addition-a'] = '999'
  fill(view, 'conditions', JSON.stringify(conditions)); await click(view, 'apply-protocol')
  await click(view, 'freeze')
  assert.equal(field(view, 'run').disabled, true)
  assert.match(field(view, 'readiness').textContent, /blocked|independent|requirement/i)
  await selectPurpose(view, 'recorded-diagnostic'); await click(view, 'freeze')
  assert.equal(field(view, 'run').disabled, false); await click(view, 'run'); await click(view, 'export-evidence')
  const evidence = JSON.parse(downloads.at(-1).contents)
  assert.equal(evidence.summary.completed, 2); assert.equal(evidence.summary.groups[0].passed, 2)
  assert.equal(evidence.summary.execution.purpose, 'recorded-diagnostic')
  assert.equal(evidence.summary.execution.experimentalCollection, 'not-admitted')
  assert.match(evidence.summary.execution.scope, /does not qualify the oracle/)
  assert.match(field(view, 'results').textContent, /diagnostic|no scientific inference/i)
})

test('saved execution fields preserve an unapplied legacy upgrade and Undo restores the original schema', async () => {
  let view = await mount(); await importDraft(view, genericStarter())
  assert.match(field(view, 'execution-status').textContent, /Legacy draft/)
  fill(view, 'execution-purpose', 'apparatus-development'); await click(view, 'save')
  view = await mount()
  assert.equal(field(view, 'execution-purpose').value, 'apparatus-development')
  let exported = await exportedDraft(view)
  assert.equal(exported.spec.schemaVersion, 1); assert.ok(exported.pending.includes('execution'))
  await click(view, 'apply-execution')
  exported = await exportedDraft(view)
  assert.equal(exported.spec.schemaVersion, STUDY_VERSION); assert.equal(exported.spec.executionPlan.purpose, 'apparatus-development')
  await click(view, 'undo')
  exported = await exportedDraft(view)
  assert.equal(exported.spec.schemaVersion, 1); assert.equal(exported.spec.executionPlan, undefined)
  assert.equal(field(view, 'execution-purpose').value, 'apparatus-development')
  assert.ok(exported.pending.includes('execution'))
})

test('ordinary investigator controls generate the complete bound plan and runnable export while browser execution waits for CLI proof', async t => {
  const view = await mount(), fixture = await prepareGeneric(view)
  fillGenericControl(view); await click(view, 'apply-requirement-fields')
  assert.match(field(view, 'status').textContent, /Qualification plan generated/)
  const draft = await exportedDraft(view), plan = draft.spec.requirementPlan
  assert.equal(draft.spec.executionPlan.purpose, 'experiment'); assert.equal(draft.spec.analysisPlan.primaryPopulation, 'all')
  assert.equal(plan.selectedInput.policy, 'require-composition'); assert.equal(plan.targets.length, 1)
  assert.equal(plan.targets[0].requirementId, 'root#task')
  assert.deepEqual(plan.targets[0].activation, [{ kind: 'counter', name: 'evaluated', minimum: 1 }])
  assert.deepEqual(plan.targets[0].probes[0].input, { offset: 2 })
  assert.deepEqual(plan.targets[0].probes[0].assertions, [{ path: [], equals: '7' }])
  assert.equal(plan.targets[0].wrongReadings[0].root.params.a, 1)
  assert.equal(draft.pending.includes('requirementFields'), false)
  assert.deepEqual(draft.attachments, fixture.attachments)
  await click(view, 'freeze')
  assert.equal(field(view, 'run').disabled, true)
  assert.match(field(view, 'frozen-details').textContent, /Selected-input qualification.*exported CLI/)
  assert.match(field(view, 'readiness').textContent, /Design eligible.*Fresh executed controls/)
  await click(view, 'export')
  const zip = downloads.at(-1).contents, files = unzipStored(zip), project = JSON.parse(files['project.json'])
  await verifyProject(project)
  assert.equal(project.requirements.selectedInput.unregistered.length, 0)
  assert.equal(project.requirements.targets[0].selectedInput.reference.input.offset, 1)
  for (const [path, contents] of Object.entries(fixture.attachments)) assert.equal(files[path], contents)
  for (const name of RUNTIME_FILES) assert.equal(await sha256(files[name]), project.spec.runtimeSources[name])
  const directory = await mkdtemp(resolve('..', 'readiness-ui-fields-'))
  await Promise.all([writeFile(resolve(directory, 'draft.json'), JSON.stringify(draft, null, 2)), writeFile(resolve(directory, 'project.json'), files['project.json']),
    writeFile(resolve(directory, 'registry.json'), files['requirements/registry.json']), writeFile(resolve(directory, 'experiment.zip'), zip),
    writeFile(resolve(directory, 'result.json'), JSON.stringify({ projectSha256: project.sha256, zipSha256: await sha256(zip), targets: 1, runtimePins: RUNTIME_FILES.length,
      ordinaryFieldAuthoring: true, selectedInputProofExecuted: false, browserRunDisabled: true, nativeRuns: 0, providerCalls: 0, personalApprovals: 0 }, null, 2))])
  t.diagnostic('Retained mounted field journey and export: ' + directory)
})

test('unfinished controls survive save and remount, project and account changes do not leak them, and stale input reset is reversible', async () => {
  let view = await mount(); await prepareGeneric(view); fillGenericControl(view)
  fillControl(view, 'timeout', 'not decided yet'); await click(view, 'apply-requirement-fields')
  assert.match(field(view, 'status').textContent, /whole number/)
  await click(view, 'save')
  const retained = JSON.parse(field(view, 'requirement-fields').value)
  await view.setContext(B, 'live'); await idle(view)
  assert.equal(field(view, 'requirement-fields').value, '')
  assert.doesNotMatch(field(view, 'requirement-fields-editor').textContent, /not decided yet|Direct arithmetic and repeated/)
  await view.setContext(A, 'live'); await idle(view)
  assert.deepEqual(JSON.parse(field(view, 'requirement-fields').value), retained)
  view = await mount(); await click(view, 'prepare-requirement-fields')
  assert.equal(control(view, 'timeout').value, 'not decided yet')
  const otherAccount = await mount({ account: memoryAccount() })
  assert.equal(field(otherAccount, 'requirement-fields').value, '')
  assert.equal((await exportedDraft(otherAccount)).spec.id, 'my-benchmark')
  fillControl(view, 'timeout', '120000')
  const beforeChange = JSON.parse(field(view, 'requirement-fields').value)
  fill(view, 'input', '{"offset":3}'); fill(view, 'expected', '"8"'); await click(view, 'apply-input')
  await click(view, 'apply-requirement-fields')
  assert.match(field(view, 'status').textContent, /changed.*Regenerate/)
  assert.equal(canonical(JSON.parse(field(view, 'requirement-fields').value)), canonical(beforeChange))
  await click(view, 'prepare-requirement-fields')
  assert.match(control(view, 'status').textContent, /fields are stale/)
  await click(view, 'reset-requirement-fields')
  let current = JSON.parse(field(view, 'requirement-fields').value)
  assert.notEqual(current.bindingSha256, beforeChange.bindingSha256)
  assert.equal(current.targets[0].probes[0].assertions.length, 0)
  await click(view, 'undo')
  current = JSON.parse(field(view, 'requirement-fields').value)
  assert.deepEqual(current, beforeChange)
  assert.equal(JSON.parse(field(view, 'input').value).offset, 3)
  await click(view, 'prepare-requirement-fields')
  assert.match(control(view, 'status').textContent, /fields are stale/)
})

test('changed attached interpreter bytes invalidate prepared controls until an explicit fresh roster', async () => {
  const view = await mount(), fixture = await prepareGeneric(view); fillGenericControl(view)
  const beforeChange = JSON.parse(field(view, 'requirement-fields').value)
  fill(view, 'attachment-path', 'interpreters/direct.mjs'); fill(view, 'attachment-text', fixture.attachments['interpreters/direct.mjs'] + '\n// Reviewed implementation revision\n')
  await click(view, 'attach'); await click(view, 'apply-requirement-fields')
  assert.match(field(view, 'status').textContent, /changed.*Regenerate/)
  assert.deepEqual(JSON.parse(field(view, 'requirement-fields').value), beforeChange)
  await click(view, 'prepare-requirement-fields')
  assert.match(control(view, 'status').textContent, /fields are stale/)
})
