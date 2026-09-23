import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import { resolve } from 'node:path'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { canonical, createReviewRecord, sha256 } from '../../src/benchmark/prompts.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { leanConfig } from '../../src/benchmark/lean-observations.mjs'
import { deriveTaskExpected } from '../../src/benchmark/tasks.mjs'
import { newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { NATIVE_EVIDENCE_LIMITS, verifyNativeJournalEvidence } from '../../src/benchmark/audit.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36), B = 'rp-' + 'b'.repeat(36), views = []
const code = '# SYNTHETIC RETAINED SOURCE; NEVER EXECUTED BY THIS TEST\n', at = '2026-09-09T00:00:00.000Z'
const json = value => canonical(value) + '\n'
const pause = () => new Promise(resolve => setTimeout(resolve, 3))
const turn = () => new Promise(resolve => setImmediate(resolve))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const status = view => field(view, 'status').textContent
let installed, cryptoDescriptor, fetchDescriptor, account, downloads, networkCalls

async function until(predicate, message = 'Native evidence view did not settle.') {
  for (let n = 0; n < 1200; n++) { if (predicate()) return; await pause() }
  assert.fail(message)
}
async function idle(view) { await until(() => view.el.getAttribute('aria-busy') === 'false', status(view)) }
async function click(view, name) {
  const button = field(view, name); assert.ok(button, name); assert.equal(button.disabled, false, name + ': ' + status(view))
  button.click(); await idle(view)
}
function input(view, name, value) {
  const node = field(view, name); assert.ok(node, name); assert.equal(node.disabled, false, name)
  node.value = value; node.dispatch('input')
}
function sendFile(view, name, value, overrides = {}) {
  const node = field(view, name), text = typeof value === 'string' ? value : json(value)
  assert.ok(node, name); assert.equal(node.disabled, false, name)
  node.files = [{ name: 'synthetic-retained-evidence.json', size: Buffer.byteLength(text), text: async () => text, ...overrides }]
  node.dispatch('change')
}
async function importFile(view, name, value, overrides) { sendFile(view, name, value, overrides); await idle(view) }
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
async function retain(name, value) {
  const directory = process.env.RESEARCH_NATIVE_EVIDENCE_BUILDER_EVIDENCE
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}

// Independent, hand-authored quiet synchronous observation. These source and
// process records are synthetic data, not evidence that any program executed.
async function fixture() {
  let spec = newExperimentDraft(leanStarter(), { purpose: 'apparatus-development', initializePopulation: true })
  spec.id = 'native-evidence-mounted'; spec.name = 'Synthetic retained artifact import'
  const task = spec.tasks[0]
  task.root.slots.strategy.slots.buy_reason.params = { threshold: 1 }
  task.expected = await deriveTaskExpected(spec, task)
  assert.deepEqual(task.expected, [], 'Every recorded bar leaves the explicit buy threshold unsatisfied.')
  spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 30000 }
  spec.protocol.replicates = 1; spec.protocol.maxAttemptsPerTrial = 1; spec.protocol.maxTotalAttempts = 1
  spec.environment.leanImage = 'synthetic-unavailable-image@sha256:' + 'b'.repeat(64)
  spec.conditions = [{ id: 'saved-control', model: { provider: 'fixture', id: 'never-executed', settings: {} }, adapter: { kind: 'replay', responses: { [task.id]: code } } }]
  const privateBytes = 'Synthetic retained private input; never submitted.\n'
  spec.inputs = [{ path: 'inputs/private-fixture.txt', sha256: await sha256(privateBytes), instructions: 'Retained fixture bytes only.' }]
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC FIXTURE RECORD; NO PERSONAL APPROVAL', { at })))
  const project = await freezeStudy(spec), trial = project.schedule[0], id = trial.id + '-1'
  const execution = { exitCode: 0, signal: null, stdout: 'SYNTHETIC PROCESS RECORD; NO NATIVE RUN', stderr: '' }
  const grade = { passed: true, score: 1, classification: 'correct', trace: [], directory: 'artifacts/' + id, files: [id + '.json'],
    image: spec.environment.leanImage, candidateSha256: await sha256(code.trim()), execution }
  const common = { projectSha256: project.sha256, trialId: trial.id, attempt: 1 }
  const events = [{ ...common, seq: 1, type: 'started', at, promptSha256: project.tasks[0].compiled.promptSha256,
    readinessSha256: project.readiness.sha256, executionPurpose: 'apparatus-development' },
  { ...common, seq: 2, type: 'finished', at, elapsedMs: 1, status: 'completed', response: { output: code }, grade }]
  const prefix = 'native/' + id + '/'
  const files = { ...Object.fromEntries(Object.entries(sources).map(([name, contents]) => ['runtime/' + name, contents])),
    'inputs/inputs/private-fixture.txt': privateBytes, [prefix + 'main.py']: code.trim() + '\n',
    [prefix + 'config.json']: json(leanConfig(id)), [prefix + 'execution.json']: json(execution),
    [prefix + 'result.json']: json({ state: { Status: 'Completed' }, orders: {} }) }
  return { bundle: { format: 'benchmark-native-evidence', version: 1, project, events, files }, prefix }
}
async function frozenView(f) {
  const view = await mount()
  assert.equal(field(view, 'import-native-evidence').disabled, true)
  await importFile(view, 'import', f.bundle.project.spec); assert.match(status(view), /Draft imported/)
  await click(view, 'freeze'); assert.match(status(view), /Project frozen/)
  assert.match(field(view, 'frozen').textContent, new RegExp(f.bundle.project.sha256))
  assert.equal(field(view, 'run').disabled, true, 'Native collection is never enabled by this import flow.')
  assert.equal(field(view, 'import-native-evidence').disabled, false)
  return view
}
async function verifiedView(f) {
  const view = await frozenView(f)
  await importFile(view, 'import-native-evidence', f.bundle)
  assert.match(status(view), /Native artifacts verified for consistency/)
  return view
}
async function exported(view, name) { await click(view, name); return downloads.at(-1) }
async function evidenceState(view) {
  return { evidence: (await exported(view, 'export-evidence')).contents,
    receipt: (await exported(view, 'export-native-verification')).contents,
    frozen: field(view, 'frozen').textContent, results: field(view, 'results').innerHTML,
    verification: field(view, 'native-verification').textContent }
}
function noReceipt(view) {
  assert.equal(field(view, 'export-native-verification').disabled, true)
  assert.match(field(view, 'native-verification').textContent, /^No native artifact verification is loaded/)
}

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
  assert.equal(networkCalls, 0, 'Verification never collects a response or invokes a network endpoint.')
})

test('separate native import verifies retained bytes and exports the exact shared receipt without changing execution scope', async () => {
  const f = await fixture(), view = await verifiedView(f)
  const receipt = await verifyNativeJournalEvidence(f.bundle), actual = await exported(view, 'export-native-verification')
  assert.equal(actual.name, 'native-evidence-mounted-native-verification.json'); assert.equal(actual.contents, json(receipt))
  assert.equal(receipt.attempts.length, 1); assert.equal(receipt.attempts[0].observation.length, 0)
  assert.equal(Object.keys(receipt.attempts[0].sourceFileHashes).length, RUNTIME_FILES.length + 1, 'Every runtime source this study pinned, and the declared private input, were checked.')
  assert.equal(Object.keys(receipt.attempts[0].artifactFileHashes).length, 4)
  assert.equal(receipt.evidenceStatus, 'retained-artifact-consistency')
  assert.match(field(view, 'native-verification').textContent, /1 completed native results checked/)
  assert.match(field(view, 'native-verification').textContent, /native execution, preparation and experimental admission are not established/)
  // The receipt's detail view on the page: its status, every checked attempt and the limitations it states.
  assert.ok(field(view, 'native-verification-details'), 'the receipt detail container exists')
  assert.match(field(view, 'native-verification-details').textContent, /retained-artifact-consistency/)
  assert.match(field(view, 'native-verification-details').textContent, /do not authenticate who produced the artifacts/)
  assert.equal(view.el.querySelectorAll('[data-bench-journal-native-attempts] tbody tr').length, 1, 'one checked attempt row')
  const evidence = JSON.parse((await exported(view, 'export-evidence')).contents)
  assert.deepEqual(evidence.events, f.bundle.events); assert.equal(evidence.summary.completed, 1)
  assert.equal(evidence.summary.groups[0].passed, 1); assert.equal(evidence.summary.execution.purpose, 'apparatus-development')
  assert.equal(field(view, 'run').disabled, true)
  await retain('successful-import', { receipt, evidence, status: status(view), nativeStatus: field(view, 'native-verification').textContent })
})

test('wrong project, forged frozen content and tampered source/artifacts refuse atomically while preserving verified evidence', async () => {
  const f = await fixture(), view = await verifiedView(f), before = await evidenceState(view), refused = []
  for (const kind of ['wrong-project', 'forged-project', 'runtime', 'input', 'candidate', 'result', 'extra-file']) {
    const data = structuredClone(f.bundle)
    if (kind === 'wrong-project') data.project.sha256 = '0'.repeat(64)
    if (kind === 'forged-project') data.project.spec.name = 'Different declared experiment under the old digest'
    if (kind === 'runtime') data.files['runtime/prompts.mjs'] += '\n// changed bytes\n'
    if (kind === 'input') data.files['inputs/inputs/private-fixture.txt'] += 'changed'
    if (kind === 'candidate') data.files[f.prefix + 'main.py'] += '# changed candidate\n'
    if (kind === 'result') data.files[f.prefix + 'result.json'] = json({ state: { Status: 'Running' }, orders: {} })
    if (kind === 'extra-file') data.files[f.prefix + 'unplanned.txt'] = 'Not in the verifier roster.'
    await importFile(view, 'import-native-evidence', data)
    const reason = status(view); assert.doesNotMatch(reason, /^Native artifacts verified/)
    assert.match(reason, /different|changed|hash|source|candidate|result|did not complete|unexpected|reconstruct|digest/i)
    assert.deepEqual(await evidenceState(view), before, kind + ' must not partially replace results or the receipt.')
    refused.push({ kind, reason })
  }
  await retain('atomic-refusals', { projectSha256: f.bundle.project.sha256, refused })
})

test('ordinary evidence import recomputes results and explicitly clears any native verification receipt', async () => {
  const f = await fixture(), view = await verifiedView(f)
  await importFile(view, 'import-evidence', { projectSha256: f.bundle.project.sha256, events: f.bundle.events,
    summary: { completed: 999, passed: 999 }, nativeVerification: { verified: true } })
  assert.match(status(view), /Evidence imported; summary recomputed/); noReceipt(view)
  const evidence = JSON.parse((await exported(view, 'export-evidence')).contents)
  assert.equal(evidence.summary.completed, 1); assert.equal(evidence.summary.groups[0].passed, 1)
  assert.equal(Object.hasOwn(evidence, 'nativeVerification'), false)
})

test('an applied edit and a fresh freeze each clear native receipt authority', async () => {
  const f = await fixture(), view = await verifiedView(f)
  await click(view, 'freeze'); assert.match(status(view), /Project frozen/); noReceipt(view)
  await importFile(view, 'import-native-evidence', f.bundle); assert.match(status(view), /Native artifacts verified/)
  input(view, 'name', 'Explicit edited experiment name'); noReceipt(view)
  assert.equal(field(view, 'export-evidence').disabled, true); assert.equal(field(view, 'import-native-evidence').disabled, true)
  assert.equal(JSON.parse(field(view, 'spec-json').value).name, 'Explicit edited experiment name')
})

test('project navigation and account reload never restore cached native verification authority', async () => {
  const f = await fixture(), view = await verifiedView(f)
  await click(view, 'save')
  await view.setContext(B, 'live'); await idle(view); noReceipt(view)
  assert.equal(field(view, 'export-evidence').disabled, true)
  await view.setContext(A, 'live'); await idle(view); noReceipt(view)
  assert.equal(field(view, 'export-evidence').disabled, false, 'The ordinary cached journal can remain available independently.')
  await importFile(view, 'import-native-evidence', f.bundle); assert.match(status(view), /Native artifacts verified/)
  // Account changes use the public reload boundary even when the project ID is unchanged.
  account.values.clear(); await view.setContext(A, 'live', { reload: true }); await idle(view); noReceipt(view)
  assert.equal(field(view, 'export-evidence').disabled, true)
  assert.equal(field(view, 'import-native-evidence').disabled, true)
})

test('a native file read started in one context cannot publish into the next context', async () => {
  const f = await fixture(), view = await frozenView(f)
  let release, read = false
  const deferred = new Promise(resolve => { release = resolve })
  sendFile(view, 'import-native-evidence', f.bundle, { text: async () => { read = true; return deferred } })
  await until(() => read); assert.equal(view.el.getAttribute('aria-busy'), 'true')
  await view.setContext(B, 'live'); await idle(view)
  const before = { spec: field(view, 'spec-json').value, status: status(view), results: field(view, 'results').innerHTML }
  release(json(f.bundle)); await turn(); await turn()
  assert.deepEqual({ spec: field(view, 'spec-json').value, status: status(view), results: field(view, 'results').innerHTML }, before)
  noReceipt(view); assert.equal(field(view, 'export-evidence').disabled, true)
})

test('an in-progress byte-verification hash cannot publish after a project switch', async () => {
  const f = await fixture(), view = await frozenView(f)
  const hashes = Object.fromEntries(await Promise.all(Object.entries(f.bundle.files).map(async ([path, bytes]) => [path, await sha256(bytes)])))
  const finalBytes = canonical(hashes)
  let release, held = false, resumed = false
  const deferred = new Promise(resolve => { release = resolve })
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { async digest(algorithm, bytes) {
    if (!held && new TextDecoder().decode(bytes) === finalBytes) {
      held = true; await deferred
      const result = await webcrypto.subtle.digest(algorithm, bytes); resumed = true; return result
    }
    return webcrypto.subtle.digest(algorithm, bytes)
  } } } })
  sendFile(view, 'import-native-evidence', f.bundle)
  await until(() => held, 'The actual shared verifier must reach its final file-hash binding.')
  await view.setContext(B, 'live'); await idle(view)
  const before = { spec: field(view, 'spec-json').value, status: status(view), results: field(view, 'results').innerHTML }
  release(); await until(() => resumed); await turn(); await turn()
  assert.deepEqual({ spec: field(view, 'spec-json').value, status: status(view), results: field(view, 'results').innerHTML }, before)
  noReceipt(view); assert.equal(field(view, 'export-evidence').disabled, true)
})

test('oversized native file is refused before reading and leaves the previous receipt intact', async () => {
  const f = await fixture(), view = await verifiedView(f), before = await evidenceState(view)
  let reads = 0
  await importFile(view, 'import-native-evidence', '', { size: NATIVE_EVIDENCE_LIMITS.totalBytes + 1, text: async () => { reads++; throw new Error('Must never read an oversized file.') } })
  assert.equal(reads, 0); assert.match(status(view), /Native evidence files are limited to 64 MiB/)
  assert.deepEqual(await evidenceState(view), before)
})
