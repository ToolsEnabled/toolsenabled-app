import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import { resolve } from 'node:path'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { genericActivationFixture } from './fixtures/research-benchmark-generic-activation.mjs'
import { analyze, bindRuntimeSources, freezeStudy, RUNTIME_FILES, STUDY_VERSION } from '../../src/benchmark/study.mjs'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { qualifyRequirements, verifyQualificationJournal } from '../../src/benchmark/requirements.mjs'
import { runStudy, validateJournal } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
const at = '2026-09-09T00:00:00.000Z', pause = () => new Promise(resolve => setTimeout(resolve, 3))
const turn = () => new Promise(resolve => setImmediate(resolve))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const status = view => field(view, 'status').textContent
const json = value => canonical(value) + '\n'
let installed, cryptoDescriptor, fetchDescriptor, account, downloads, networkCalls, fixturePromise

// One small direct-API proof per test process. Both independent algorithms run
// in process; no module/process receipt, native run or personal approval is made.
async function createFixture() {
  const { spec } = await genericActivationFixture()
  delete spec.requirementPlan.interpreters; spec.inputs = []
  spec.tasks[0].input.sequence = ['a', 'b']
  spec.requirementPlan.targets[0].probes[0].input.sequence = ['a', 'b']
  spec.requirementPlan.shrink = { sequencePath: ['sequence'], maxEvaluations: 8 }
  const project = await freezeStudy(await bindRuntimeSources(spec, sources)), calls = { direct: 0, steps: 0 }
  const interpret = async task => {
    calls.direct++
    return { observation: String(task.compiled.semantic.a + task.compiled.semantic.b + task.input.offset),
      activation: { counters: { evaluated: 1 }, transitions: {} } }
  }
  const independent = async task => {
    calls.steps++; let result = 0
    for (const term of [task.compiled.semantic.a, task.compiled.semantic.b, task.input.offset]) {
      for (let count = 0; count < Math.abs(term); count++) result += Math.sign(term)
    }
    return { observation: String(result), activation: { counters: { evaluated: 1 }, transitions: {} } }
  }
  const record = { format: 'research-benchmark-qualification', version: 1, projectSha256: project.sha256,
    runtimeSources: project.spec.runtimeSources, requirements: await qualifyRequirements(project.requirements, { interpret, independent }),
    scope: 'Synthetic direct-API arithmetic callbacks only; no process or native execution claimed.' }
  const common = { projectSha256: project.sha256, at }, trial = project.schedule[0]
  const binding = { trialId: trial.id, attempt: 1 }
  const events = [
    { ...common, seq: 1, type: 'qualification-started', timeoutMs: 1000, settlementMs: 5000, reservedMs: 6000 },
    { ...common, seq: 2, type: 'qualification', preparationSeq: 1, elapsedMs: 13, budgetChargeMs: 13, record },
    { ...common, ...binding, seq: 3, type: 'started', readinessSha256: project.readiness.sha256,
      executionPurpose: 'apparatus-development', promptSha256: project.tasks[0].compiled.promptSha256 },
    { ...common, ...binding, seq: 4, type: 'finished', status: 'completed', elapsedMs: 7, response: { output: '6' }, grade: { passed: true, score: 1 } },
  ]
  assert.equal(project.version, STUDY_VERSION); assert.equal(project.tasks[0].expected, '6')
  assert.deepEqual(validateJournal(project, events), []); await verifyQualificationJournal(project, events)
  const shrink = record.requirements.targets[0].probes[0].wrongReadings[0].shrink
  assert.equal(shrink.oneMinimal, true); assert.equal(shrink.finalLength, 0)
  const evidence = { projectSha256: project.sha256, events, summary: analyze(project, events) }
  return { project, evidence, calls }
}
async function fixture() { fixturePromise ||= createFixture(); return structuredClone(await fixturePromise) }
function tampered(f) {
  const evidence = structuredClone(f.evidence)
  evidence.events.find(row => row.type === 'qualification').record.requirements.targets[0].probes[0].wrongReadings[0].shrink.attempts[0].inputSha256 = 'f'.repeat(64)
  return evidence
}
async function until(predicate, message = 'Qualification import did not settle.') {
  for (let n = 0; n < 1000; n++) { if (predicate()) return; await pause() }
  assert.fail(message)
}
async function idle(view) { await until(() => view.el.getAttribute('aria-busy') === 'false', status(view)) }
async function click(view, name) {
  const button = field(view, name); assert.ok(button, name); assert.equal(button.disabled, false, name + ': ' + status(view))
  button.click(); await idle(view)
}
function sendFile(view, name, value) {
  const node = field(view, name), text = json(value)
  assert.ok(node, name); assert.equal(node.disabled, false, name)
  node.files = [{ name: 'synthetic-qualification-evidence.json', size: Buffer.byteLength(text), text: async () => text }]
  node.dispatch('change')
}
async function importFile(view, name, value) { sendFile(view, name, value); await idle(view) }
function memoryAccount() {
  const values = new Map()
  return { values, async getSetting(key) { return { ok: true, value: values.get(key) ?? null } },
    async putSetting(key, value) { values.set(key, value); return { ok: true } } }
}
async function mounted(f) {
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources,
    download: (name, contents) => downloads.push({ name, contents }) })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view)
  await importFile(view, 'import', f.project.spec); assert.match(status(view), /Draft imported/)
  await click(view, 'freeze'); assert.match(status(view), /Project frozen/)
  assert.match(field(view, 'frozen').textContent, new RegExp(f.project.sha256))
  assert.equal(field(view, 'run').disabled, true, 'The selected-input apparatus remains a CLI/direct-API operation.')
  return view
}
async function exportedEvidence(view) {
  await click(view, 'export-evidence'); return downloads.at(-1).contents
}
async function retain(name, value) {
  const directory = process.env.RESEARCH_QUALIFICATION_IMPORT_EVIDENCE
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}
beforeEach(() => {
  installed = installDomStandIn(globalThis)
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  networkCalls = 0; Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => { networkCalls++; throw new Error('This import test must not collect external responses.') } })
  account = memoryAccount(); downloads = []
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await turn(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
  if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor); else delete globalThis.fetch
  assert.equal(networkCalls, 0)
})

test('ordinary evidence import preserves valid selected-input proof and recomputes the same summary as reporting', async () => {
  const f = await fixture(), view = await mounted(f)
  const supplied = structuredClone(f.evidence); supplied.summary = { completed: 999, passed: 999 }
  await importFile(view, 'import-evidence', supplied); assert.match(status(view), /Evidence imported; summary recomputed/)
  const imported = JSON.parse(await exportedEvidence(view)), report = await researchReportFiles(f.project, f.evidence.events)
  assert.deepEqual(imported.events, f.evidence.events); assert.deepEqual(imported.summary, f.evidence.summary)
  assert.deepEqual(imported.summary, JSON.parse(report['summary.json']))
  assert.equal(imported.summary.completed, 1); assert.equal(imported.summary.groups[0].passed, 1)
  assert.equal(imported.summary.selectedInputPreparation.qualified, 1); assert.equal(imported.summary.selectedInputPreparation.elapsedMs, 13)
  assert.equal(imported.summary.rows[0].latencyMs, 7); assert.equal(imported.summary.execution.purpose, 'apparatus-development')
  assert.match(field(view, 'results').textContent, /Selected-input preparation/)
  assert.equal(field(view, 'export-native-verification').disabled, true)
  await retain('valid-import', { project: f.project, evidence: imported, interpreterCalls: f.calls,
    statement: 'Direct in-process arithmetic callbacks only; zero module, native, provider or personal-approval executions.' })
})

test('tampered shrink candidate digest refuses atomically with the same error as report and completed resume', async () => {
  const f = await fixture(), forged = tampered(f), view = await mounted(f)
  // This is the exact gap: a structurally valid digest is insufficient; the
  // asynchronous check must bind it to the reconstructed candidate bytes.
  assert.deepEqual(validateJournal(f.project, forged.events), [])
  await assert.rejects(verifyQualificationJournal(f.project, forged.events), /shrink candidate digest differs/)
  await assert.rejects(researchReportFiles(f.project, forged.events), /shrink candidate digest differs/)
  let dispatches = 0
  await assert.rejects(runStudy(f.project, { events: forged.events,
    adapter: async () => { dispatches++; throw new Error('No response should be collected during rejected resume.') },
    qualify: async () => { dispatches++; throw new Error('No preparation should start during rejected resume.') } }), /shrink candidate digest differs/)
  assert.equal(dispatches, 0)
  await importFile(view, 'import-evidence', f.evidence); assert.match(status(view), /Evidence imported/)
  const before = { evidence: await exportedEvidence(view), frozen: field(view, 'frozen').textContent,
    results: field(view, 'results').innerHTML, nativeStatus: field(view, 'native-verification').textContent }
  await importFile(view, 'import-evidence', forged)
  const reason = status(view); assert.match(reason, /shrink candidate digest differs/)
  assert.deepEqual({ evidence: await exportedEvidence(view), frozen: field(view, 'frozen').textContent,
    results: field(view, 'results').innerHTML, nativeStatus: field(view, 'native-verification').textContent }, before)
  await retain('atomic-refusal', { projectSha256: f.project.sha256, reason, dispatches, forgedEvidence: forged, preservedEvidence: JSON.parse(before.evidence) })
})

for (const boundary of ['project', 'account-reload']) test('qualification hash cannot publish after a ' + boundary + ' context change', async () => {
  const f = await fixture(), view = await mounted(f)
  const proof = f.evidence.events.find(row => row.type === 'qualification').record
  const shrink = proof.requirements.targets[0].probes[0].wrongReadings[0].shrink
  const lastCandidate = canonical({ offset: 2, sequence: shrink.attempts.at(-1).keptIndices.map(index => ['a', 'b'][index]) })
  let held = false, resumed = false, release
  const deferred = new Promise(resolve => { release = resolve })
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { async digest(algorithm, bytes) {
    if (!held && new TextDecoder().decode(bytes) === lastCandidate) {
      held = true; await deferred
      const result = await webcrypto.subtle.digest(algorithm, bytes); resumed = true; return result
    }
    return webcrypto.subtle.digest(algorithm, bytes)
  } } } })
  sendFile(view, 'import-evidence', f.evidence)
  await until(() => held, 'The actual qualification verifier must await the retained candidate digest.')
  assert.equal(view.el.getAttribute('aria-busy'), 'true')
  if (boundary === 'project') await view.setContext(B, 'live')
  else { account.values.clear(); await view.setContext(A, 'live', { reload: true }) }
  await idle(view)
  const before = { spec: field(view, 'spec-json').value, status: status(view), results: field(view, 'results').innerHTML }
  release(); await until(() => resumed); await turn(); await turn()
  assert.deepEqual({ spec: field(view, 'spec-json').value, status: status(view), results: field(view, 'results').innerHTML }, before)
  assert.equal(field(view, 'export-evidence').disabled, true); assert.equal(field(view, 'export-native-verification').disabled, true)
  await retain(boundary + '-isolation', { held, resumed, evidenceExportDisabled: field(view, 'export-evidence').disabled,
    receiptExportDisabled: field(view, 'export-native-verification').disabled, projectAfter: JSON.parse(before.spec).id })
})
