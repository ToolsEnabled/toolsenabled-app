// The Research page's Import run evidence keeps the receipts an exported
// evidence.json carries when report.mjs binds them to the frozen project and
// journal and their recorded digests match, drops any other receipt by name
// in the status line, records its own native verification the same way, and
// passes both to Export research report, so the page's report bytes equal
// the exported CLI's for the same project, journal and receipts. Nothing here
// executes a program, an engine or a provider.
import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { pageReportOptions } from './fixtures/research-page-report-options.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { canonical, createReviewRecord, sha256 } from '../../src/benchmark/prompts.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { attributionsMarkdown, bindLeanReview, provenanceDocument } from '../../src/benchmark/lean-codegen.mjs'
import { leanConfig } from '../../src/benchmark/lean-observations.mjs'
import { deriveTaskExpected } from '../../src/benchmark/tasks.mjs'
import { newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { verifyNativeJournalEvidence } from '../../src/benchmark/audit.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { zipFiles } from '../../src/benchmark/export.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), views = []
const code = '# SYNTHETIC RETAINED SOURCE; NEVER EXECUTED BY THIS TEST\n', at = '2026-09-09T00:00:00.000Z'
const json = value => canonical(value) + '\n'
const pause = () => new Promise(resolve => setTimeout(resolve, 3))
const turn = () => new Promise(resolve => setImmediate(resolve))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const status = view => field(view, 'status').textContent
let installed, cryptoDescriptor, fetchDescriptor, account, downloads, networkCalls

async function until(predicate, message = 'The Research view did not settle.') {
  for (let n = 0; n < 1200; n++) { if (predicate()) return; await pause() }
  assert.fail(message)
}
async function idle(view) { await until(() => view.el.getAttribute('aria-busy') === 'false', status(view)) }
async function click(view, name) {
  const button = field(view, name); assert.ok(button, name); assert.equal(button.disabled, false, name + ': ' + status(view))
  button.click(); await idle(view)
}
function sendFile(view, name, value) {
  const node = field(view, name), text = typeof value === 'string' ? value : json(value)
  assert.ok(node, name); assert.equal(node.disabled, false, name)
  node.files = [{ name: 'synthetic-evidence.json', size: Buffer.byteLength(text), text: async () => text }]
  node.dispatch('change')
}
async function importFile(view, name, value) { sendFile(view, name, value); await idle(view) }
function memoryAccount() {
  const values = new Map()
  return { values, async getSetting(key) { return { ok: true, value: values.get(key) ?? null } },
    async putSetting(key, value) { values.set(key, value); return { ok: true } } }
}
async function mount() {
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources,
    download: (name, contents) => downloads.push({ name, contents }) })
  views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); return view
}
async function exported(view, name) { await click(view, name); return downloads.at(-1) }
const parsed = download => JSON.parse(download.contents)
const bytes = value => Buffer.from(value)
// Report ZIPs are compared by Buffer equality, never by assert.deepEqual: a failing
// deepEqual over two 190 KB buffers spends more than a minute of CPU building its
// element-by-element diff (measured 62-85 s per test, 295 s for the file) and heats the
// machine for nothing. On a mismatch the entries that differ are named instead.
function zipDifferences(actual, expected) {
  const a = unzipStored(actual), e = unzipStored(expected), names = [...new Set([...Object.keys(a), ...Object.keys(e)])].sort()
  return names.filter(name => a[name] !== e[name]).map(name => name + (a[name] === undefined ? ' (missing from actual)' : e[name] === undefined ? ' (missing from expected)' : ' (bytes differ)'))
}
const sameZip = (actual, expected, message) => assert.ok(actual.equals(expected), message + ': differing entries ' + JSON.stringify(zipDifferences(actual, expected).slice(0, 12)))
const differentZip = (actual, expected, message) => assert.ok(!actual.equals(expected), message + ': the two ZIPs are byte-identical')
// What the exported CLI renders for the same inputs, packed the way the page packs it.
// The page renders from the project object it froze itself. That object hashes to the
// same SHA-256 as the fixture's, but freezeStudy keeps the key order of the spec it was
// given, and analysis.json, summary.json and the export manifest are written in that order;
// so the expected bytes are computed from the project the page's own Export runnable ZIP
// carries (project.json), never from a second object that merely hashes the same.
function unzipStored(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder(), files = {}
  let offset = 0
  while (offset + 30 <= bytes.byteLength && data.getUint32(offset, true) === 0x04034b50) {
    assert.equal(data.getUint16(offset + 8, true), 0, 'stored entries only')
    const size = data.getUint32(offset + 18, true), nameSize = data.getUint16(offset + 26, true), extraSize = data.getUint16(offset + 28, true)
    const start = offset + 30, body = start + nameSize + extraSize
    files[decoder.decode(bytes.subarray(start, start + nameSize))] = decoder.decode(bytes.subarray(body, body + size)); offset = body + size
  }
  return files
}
async function pageProject(view) {
  const exportedProject = unzipStored((await exported(view, 'export')).contents)
  assert.ok(exportedProject['project.json'], 'the runnable ZIP carries project.json')
  return JSON.parse(exportedProject['project.json'])
}
// What the exported CLI renders for the same inputs, packed the way the page packs it: the
// page passes the manifest of the export it would write beside the registry documents.
const expectedReportZip = async (f, receipts) => bytes(zipFiles(await researchReportFiles(f.pageProject, f.events, { ...(await pageReportOptions({ project: f.pageProject, sources, attachments: {} })), ...receipts })))

// A lean-python project with one completed, synthetically retained native
// attempt, the native verification receipt verify-native would write for it,
// and a qualification receipt in the shape qualify writes, both bound to it.
async function fixture() {
  let spec = newExperimentDraft(leanStarter(), { purpose: 'apparatus-development', initializePopulation: true })
  spec.id = 'receipts-page-fixture'; spec.name = 'Receipts through the Research page'
  const task = spec.tasks[0]
  task.root.slots.strategy.slots.buy_reason.params = { threshold: 1 }
  task.expected = await deriveTaskExpected(spec, task)
  spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 30000 }
  spec.protocol.replicates = 1; spec.protocol.maxAttemptsPerTrial = 1; spec.protocol.maxTotalAttempts = 1
  spec.environment.leanImage = 'synthetic-unavailable-image@sha256:' + 'd'.repeat(64)
  spec.conditions = [{ id: 'saved-control', model: { provider: 'fixture', id: 'never-executed', settings: {} }, adapter: { kind: 'replay', responses: { [task.id]: code } } }]
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC FIXTURE RECORD; NO PERSONAL APPROVAL', { at })))
  const project = await freezeStudy(spec), trial = project.schedule[0], id = trial.id + '-1'
  const execution = { exitCode: 0, signal: null, stdout: 'SYNTHETIC PROCESS RECORD; NO NATIVE RUN', stderr: '' }
  const grade = { passed: true, score: 1, classification: 'correct', trace: [], directory: 'artifacts/' + id, files: [id + '.json'],
    image: spec.environment.leanImage, candidateSha256: await sha256(code.trim()), execution }
  const common = { projectSha256: project.sha256, trialId: trial.id, attempt: 1 }
  const events = [{ ...common, seq: 1, type: 'started', at, promptSha256: project.tasks[0].compiled.promptSha256, readinessSha256: project.readiness.sha256, executionPurpose: 'apparatus-development' },
    { ...common, seq: 2, type: 'finished', at, elapsedMs: 1, status: 'completed', response: { output: code }, grade }]
  const prefix = 'native/' + id + '/'
  const files = { ...Object.fromEntries(Object.entries(sources).map(([name, contents]) => ['runtime/' + name, contents])),
    [prefix + 'main.py']: code.trim() + '\n', [prefix + 'config.json']: json(leanConfig(id)), [prefix + 'execution.json']: json(execution),
    [prefix + 'result.json']: json({ state: { Status: 'Completed' }, orders: {} }) }
  const bundle = { format: 'benchmark-native-evidence', version: 1, project, events, files }
  const nativeVerification = await verifyNativeJournalEvidence(bundle)
  const qualification = { format: 'research-benchmark-qualification', version: 1, projectSha256: project.sha256, runtimeSources: project.spec.runtimeSources,
    environment: { node: 'v22.0.0', platform: 'linux', architecture: 'x64', python: 'python3' },
    checks: [{ fixtureId: 'flat-canary', passed: true, kind: 'apparatus-control', javascript: { trace: [] }, python: { result: { trace: [] }, process: { exitCode: 0 } } }],
    scope: 'PAGE FIXTURE SCOPE; no model or engine ran.' }
  return { project, events, bundle, nativeVerification, nativeVerificationSha256: await sha256(canonical(nativeVerification)), qualification, qualificationSha256: await sha256(canonical(qualification)) }
}
async function frozenView(f) {
  const view = await mount()
  await importFile(view, 'import', f.project.spec); assert.match(status(view), /Draft imported/)
  await click(view, 'freeze'); assert.match(status(view), /Project frozen/)
  assert.match(field(view, 'frozen').textContent, new RegExp(f.project.sha256), 'the page freezes the fixture to the same digest')
  f.pageProject = await pageProject(view)
  assert.equal(f.pageProject.sha256, f.project.sha256, 'the exported project is the frozen one')
  return view
}
const evidenceFile = (f, extra = {}) => ({ projectSha256: f.project.sha256, events: f.events, summary: { completed: 999 }, ...extra })

beforeEach(() => {
  installed = installDomStandIn(globalThis)
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  networkCalls = 0; Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => { networkCalls++; throw new Error('Network execution is forbidden in this mounted test.') } })
  account = memoryAccount(); downloads = []
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await turn(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
  if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor); else delete globalThis.fetch
  assert.equal(networkCalls, 0, 'Importing evidence never collects a response or invokes a network endpoint.')
})

test('imported evidence keeps both bound receipts, exports them again under their digests, and the page report equals the CLI report for the same receipts', async () => {
  const f = await fixture(), view = await frozenView(f)
  await importFile(view, 'import-evidence', evidenceFile(f, { qualification: f.qualification, qualificationSha256: f.qualificationSha256, nativeVerification: f.nativeVerification, nativeVerificationSha256: f.nativeVerificationSha256 }))
  assert.match(status(view), /Evidence imported; summary recomputed/); assert.doesNotMatch(status(view), /Ignored/)
  const evidence = parsed(await exported(view, 'export-evidence'))
  assert.deepEqual(Object.keys(evidence).sort(), ['events', 'nativeVerification', 'nativeVerificationSha256', 'projectSha256', 'qualification', 'qualificationSha256', 'summary'])
  assert.deepEqual(evidence.qualification, f.qualification); assert.equal(evidence.qualificationSha256, f.qualificationSha256)
  assert.deepEqual(evidence.nativeVerification, f.nativeVerification); assert.equal(evidence.nativeVerificationSha256, f.nativeVerificationSha256)
  assert.equal(evidence.summary.completed, 1, 'the summary is recomputed, never copied from the file')
  const report = await exported(view, 'export-report')
  assert.equal(report.name, 'receipts-page-fixture-report.zip')
  sameZip(bytes(report.contents), await expectedReportZip(f, { qualification: f.qualification, nativeVerification: f.nativeVerification }), 'page and CLI render the same bytes for the same receipts')
  differentZip(bytes(report.contents), await expectedReportZip(f, {}), 'the receipts change the report')
})

test('evidence without receipts imports as before, unknown keys are ignored, and the report says Not declared', async () => {
  const f = await fixture(), view = await frozenView(f)
  await importFile(view, 'import-evidence', evidenceFile(f, { futureKey: { anything: true } }))
  assert.match(status(view), /Evidence imported; summary recomputed/); assert.doesNotMatch(status(view), /Ignored/)
  const evidence = parsed(await exported(view, 'export-evidence'))
  assert.deepEqual(Object.keys(evidence).sort(), ['events', 'projectSha256', 'summary'])
  const files = await researchReportFiles(f.pageProject, f.events, await pageReportOptions({ project: f.pageProject, sources, attachments: {} }))
  assert.ok(files['report.html'].includes('Not declared. No qualification receipt') && files['report.html'].includes('Not declared. No native verification receipt'))
  sameZip(bytes((await exported(view, 'export-report')).contents), bytes(zipFiles(files)), 'the page report equals the registry render without receipts')
})

test('a receipt that does not bind, or whose recorded digest does not match, is dropped and named in the status line, never exported or rendered', async () => {
  const f = await fixture(), view = await frozenView(f)
  await importFile(view, 'import-evidence', evidenceFile(f, { qualification: { ...f.qualification, projectSha256: '0'.repeat(64) }, qualificationSha256: f.qualificationSha256, nativeVerification: { verified: true } }))
  assert.match(status(view), /Evidence imported; summary recomputed/)
  assert.match(status(view), /Ignored the qualification receipt in this file: The qualification receipt belongs to a different frozen project\./)
  assert.match(status(view), /Ignored the native verification receipt in this file: The native verification receipt is not a version 1 benchmark-native-journal-verification record\./)
  assert.deepEqual(Object.keys(parsed(await exported(view, 'export-evidence'))).sort(), ['events', 'projectSha256', 'summary'])
  sameZip(bytes((await exported(view, 'export-report')).contents), await expectedReportZip(f, {}), 'nothing dropped is rendered')
  await importFile(view, 'import-evidence', evidenceFile(f, { qualification: f.qualification, qualificationSha256: 'f'.repeat(64), nativeVerification: f.nativeVerification, nativeVerificationSha256: f.nativeVerificationSha256 }))
  assert.match(status(view), /Ignored the qualification receipt in this file: its recorded SHA-256 does not match its bytes\./)
  const evidence = parsed(await exported(view, 'export-evidence'))
  assert.deepEqual(Object.keys(evidence).sort(), ['events', 'nativeVerification', 'nativeVerificationSha256', 'projectSha256', 'summary'], 'the receipt that binds is kept, the tampered one is not')
  sameZip(bytes((await exported(view, 'export-report')).contents), await expectedReportZip(f, { nativeVerification: f.nativeVerification }), 'the kept receipt is rendered, the tampered one is not')
})

test('Verify native evidence records its receipt in the exported evidence under its digest and the report renders it', async () => {
  const f = await fixture(), view = await frozenView(f)
  await importFile(view, 'import-native-evidence', f.bundle)
  assert.match(status(view), /Native artifacts verified for consistency/)
  const evidence = parsed(await exported(view, 'export-evidence'))
  assert.deepEqual(Object.keys(evidence).sort(), ['events', 'nativeVerification', 'nativeVerificationSha256', 'projectSha256', 'summary'])
  assert.deepEqual(evidence.nativeVerification, f.nativeVerification); assert.equal(evidence.nativeVerificationSha256, f.nativeVerificationSha256)
  sameZip(bytes((await exported(view, 'export-report')).contents), await expectedReportZip(f, { nativeVerification: f.nativeVerification }), 'the in-page verification is the receipt verify-native writes, rendered identically')
  assert.equal(parsed(await exported(view, 'export-native-verification')).journalSha256, f.nativeVerification.journalSha256, 'the separate receipt export is unchanged')
})

// Venue spec item 13 (Attribution and reused code) is rendered from the provenance registry
// this runtime carries. The page passes that registry itself; nothing here supplies it. So the
// report the page downloads must print the live registry's digest under item 13 and retain the
// live ATTRIBUTIONS.md, or the page has silently stopped attributing (board 23:58Z, Worker 6's
// alternative assigned to RP6).
test('the page renders spec item 13 from the live provenance registry, not from anything the caller supplies', async () => {
  const f = await fixture(), view = await frozenView(f)
  await importFile(view, 'import-evidence', evidenceFile(f))
  const report = unzipStored((await exported(view, 'export-report')).contents)
  const registrySha256 = await sha256(canonical(provenanceDocument()))
  assert.match(registrySha256, /^[a-f0-9]{64}$/)
  for (const name of ['report.md', 'report.html']) {
    const attribution = report[name].slice(report[name].indexOf('Attribution and reused code'))
    assert.ok(attribution.length > 100, name + ' carries the attribution section')
    assert.ok(attribution.includes('Registry SHA-256 ' + registrySha256), name + ' prints the live registry digest under item 13')
    assert.ok(!attribution.slice(0, attribution.indexOf('Registry SHA-256')).includes('Not declared'), name + ' does not disclaim the registry it was given')
  }
  assert.equal(report['paper/ATTRIBUTIONS.md'], attributionsMarkdown(), 'the live ATTRIBUTIONS.md is retained verbatim')
  assert.equal(report['paper/provenance.json'], JSON.stringify(provenanceDocument(), null, 2) + '\n', 'the live registry is retained as the report writes it')
})
