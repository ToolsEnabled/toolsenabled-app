import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES, V2_RUNTIME_FILES, runtimeFilesFor } from '../../src/benchmark/study.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { createAdapter, readProject } from '../../src/benchmark/cli.mjs'
import { runStudy, validateJournal, verifyResourceJournal } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { pageReportOptions } from './fixtures/research-page-report-options.mjs'
import { collectionRequest } from '../../src/benchmark/workflow.mjs'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { materializeExperimentTemplate } from '../../src/benchmark/templates.mjs'
import { RESOURCE_PRIVATE_SENTINELS, resourceTemplateFixture, resourceTemplateEnvelope, resourceTemplateControls } from './fixtures/research-benchmark-resource-template.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
async function exported(t, update = () => {}, label = 'export') {
  const base = process.env.RESOURCE_PORTABLE_EVIDENCE_DIR || tmpdir()
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'resource-' + label + '-'))
  if (!process.env.RESOURCE_PORTABLE_EVIDENCE_DIR) t.after(() => rm(root, { recursive: true, force: true }))
  else t.diagnostic('Retained export: ' + root)
  const spec = await resourceTemplateFixture(); await update(spec)
  const project = await freezeStudy(await bindRuntimeSources(spec, sources)), files = await projectFiles(project, sources)
  // Both inventories are stated, so adding a compiler module to the current one
  // cannot pass unnoticed and the frozen schema-2 list cannot drift either.
  assert.equal(V2_RUNTIME_FILES.length, 45, 'the schema-2 runtime inventory is frozen at 45 files')
  assert.equal(RUNTIME_FILES.length, 50, 'the schema-3 runtime inventory adds the benchmark registration seam')
  // The project pins the inventory for ITS OWN version, not the build's.
  assert.deepEqual(Object.keys(project.spec.runtimeSources).sort(), [...runtimeFilesFor(project)].sort())
  for (const [file, contents] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), contents) }
  return { root, project, files }
}
function cli(root, command, extra = []) {
  const result = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), command, '--project', root, ...extra], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  })
  assert.equal(result.error, undefined, result.error?.message)
  return result
}
function successful(result) {
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout)
  return JSON.parse(result.stdout)
}
async function journal(root) {
  const bytes = await readFile(resolve(root, 'results/attempts.jsonl'), 'utf8')
  return { bytes, events: bytes.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}
async function responseFiles(root) {
  const directory = resolve(root, 'results/responses')
  return Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async file => [file, await readFile(resolve(directory, file), 'utf8')])))
}
function assertPublicRequest(bytes, expected) {
  assert.equal(bytes, canonical(expected))
  for (const sentinel of Object.values(RESOURCE_PRIVATE_SENTINELS)) assert.equal(bytes.includes(sentinel), false)
  for (const field of ['private-sentinel', 'referencePlan', 'referenceObservation', 'initialSnapshot', 'runtimeSources']) assert.equal(bytes.includes(field), false)
  assert.deepEqual(Object.keys(expected).sort(), ['attempt', 'collection', 'input', 'model', 'projectSha256', 'prompt', 'trial', 'version'])
  assert.ok(expected.input.resources.every(resource => resource.id !== 'private-sentinel'))
  assert.ok(expected.prompt.includes(canonical(expected.input.actionContract)))
  assert.ok(expected.prompt.includes(canonical(expected.input.limits)))
}

test('standalone resource export runs, reanalyzes every report byte and resumes without new episodes', async t => {
  const { root, project } = await exported(t, undefined, 'standalone')
  assert.equal((await readProject(root)).sha256, project.sha256)
  const first = successful(cli(root, 'run'))
  assert.equal(first.completed, 8); assert.equal(first.scheduled, 8)
  const before = await journal(root), responses = await responseFiles(root)
  assert.equal(Object.keys(responses).length, 8)
  assert.equal(before.events.filter(row => row.type === 'template-qualified').length, 1)
  assert.equal(before.events.filter(row => row.type === 'resource-prepared').length, 8)
  assert.equal(before.events.filter(row => row.type === 'resource-closed').length, 8)
  for (const event of before.events.filter(row => row.type === 'finished')) {
    const trial = project.schedule.find(trial => trial.id === event.trialId)
    const control = resourceTemplateControls(trial.taskId).find(row => row.id === (trial.conditionId === 'target-only' ? 'goal-only' : 'goal-plus-collateral'))
    assert.deepEqual(event.grade, control.expectedGrade)
  }
  assert.deepEqual(validateJournal(project, before.events), [])
  await verifyResourceJournal(project, before.events)
  const report = await researchReportFiles(project, before.events, await pageReportOptions({ project, sources }))
  for (const [file, bytes] of Object.entries(report)) assert.ok(await readFile(resolve(root, 'results', file), 'utf8') === bytes, 'Exact report bytes differ: ' + file)
  const evidence = JSON.parse(await readFile(resolve(root, 'results/evidence.json'), 'utf8'))
  assert.deepEqual(evidence.events, before.events)
  assert.deepEqual(await researchReportFiles(project, evidence.events, await pageReportOptions({ project, sources })), report)
  for (const command of ['status', 'analyze']) {
    const summary = successful(cli(root, command))
    assert.equal(summary.completed, 8); assert.equal(summary.primaryPopulation.scheduled, 4)
    assert.deepEqual(summary.groups.map(row => row.primaryRate), [1, 0])
  }
  assert.equal(successful(cli(root, 'run')).completed, 8)
  assert.equal((await journal(root)).bytes, before.bytes)
  assert.deepEqual(await responseFiles(root), responses)
  for (const [file, bytes] of Object.entries(report)) assert.ok(await readFile(resolve(root, 'results', file), 'utf8') === bytes, 'Exact report bytes differ after resume: ' + file)
  for (const trial of project.schedule) {
    const condition = project.spec.conditions.find(row => row.id === trial.conditionId), task = project.tasks.find(row => row.id === trial.taskId)
    const request = collectionRequest(project, condition, task, trial, 1)
    assertPublicRequest(canonical(request), request)
  }
  t.diagnostic(Object.keys(project.spec.runtimeSources).length + ' source pins; 8 completed synthetic episodes; ' + Object.keys(report).length + ' exact report files; 0 additional episodes on completed resume.')
})

test('generated template files cannot be replaced or omitted even after their manifest hashes are updated', async t => {
  const { root, project, files } = await exported(t, undefined, 'artifact-drift')
  const paths = Object.keys(files).filter(file => file.startsWith('templates/'))
  assert.equal(paths.length, 10)
  for (const file of paths) {
    const original = JSON.parse(files[file]), changed = Array.isArray(original) ? [...original, { invented: true }] : { ...original, invented: true }
    const contents = canonical(changed) + '\n', manifest = JSON.parse(files['manifest.json'])
    manifest.files[file] = await sha256(contents)
    await writeFile(resolve(root, file), contents); await writeFile(resolve(root, 'manifest.json'), canonical(manifest) + '\n')
    await assert.rejects(readProject(root), /generated experiment artifact changed/i, file)
    await writeFile(resolve(root, file), files[file])
    delete manifest.files[file]
    await writeFile(resolve(root, 'manifest.json'), canonical(manifest) + '\n')
    await assert.rejects(readProject(root), /manifest omits a generated experiment artifact/i, file)
    await writeFile(resolve(root, 'manifest.json'), files['manifest.json'])
  }
  assert.equal((await readProject(root)).sha256, project.sha256)
  t.diagnostic('10 generated artifacts each reject rehashed drift and manifest omission; original export restored.')
})

test('evidence projection includes every selected preflight control and all retained qualification copies', async () => {
  const spec = await resourceTemplateFixture(), generated = await materializeExperimentTemplate(spec.experimentTemplate)
  const budget = generated.contract.generatedEvidenceBudget
  assert.ok(budget.fixedConformanceBytes > 512 * 1024)
  assert.equal(budget.fullQualificationReceipts, 1)
  assert.equal(budget.maxQualificationReceipts, budget.scheduledTrials + 1)
  for (const row of budget.cases) {
    assert.deepEqual(row.conformanceControls.map(control => [control.id, control.actions]), [['reference', 1], ['no-op', 0], ['collateral', 2], ['repair', 3]])
    assert.equal(row.conformanceBytes, 4096 + row.conformanceControls.reduce((sum, control) => sum + control.bytes, 0))
  }
  assert.equal(budget.conformanceBytes, budget.fixedConformanceBytes + budget.compactQualificationBytes + budget.cases.reduce((sum, row) => sum + row.conformanceBytes, 0))
  const crowded = structuredClone(spec.experimentTemplate)
  crowded.cases = Array.from({ length: 32 }, (_, index) => ({ ...structuredClone(crowded.cases[0]), id: 'case-' + index, familyId: 'family-' + index }))
  await assert.rejects(materializeExperimentTemplate(crowded), /16 MiB evidence budget.*preflight control/)
})

async function httpFixture(spec) {
  spec.conditions = [spec.conditions[0]]
  spec.conditions[0].adapter = { kind: 'http', url: 'https://fixture.invalid/resource' }
  spec.conditions[0].collection.comparisonUnit = 'model'
  spec.conditions[0].collection.contextConstruction = 'frozen-public-request'
  spec.conditions[0].collection.sessionIsolation = 'fresh-request'
  spec.protocol.replicates = 1
  spec.analysisPlan.contrasts = []
}
function fakeResponse(chunks) {
  return { ok: true, status: 200, body: { async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield Buffer.from(chunk) } } }
}

test('HTTP collection sends exact public bytes and bounds oversized response evidence before any resource effect', async t => {
  const { root, project } = await exported(t, httpFixture, 'http-boundary')
  const calls = [], adapter = createAdapter(root)
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://fixture.invalid/resource'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error')
    assert.deepEqual(options.headers, { 'content-type': 'application/json' })
    const request = JSON.parse(options.body), trial = project.schedule.find(row => row.id === request.trial.id)
    const task = project.tasks.find(row => row.id === trial.taskId), condition = project.spec.conditions[0]
    assertPublicRequest(options.body, collectionRequest(project, condition, task, trial, 1))
    calls.push(options.body)
    const envelope = resourceTemplateEnvelope(resourceTemplateControls(task.id).find(row => row.id === 'goal-only').response)
    const bytes = Buffer.from(canonical(envelope)), split = Math.floor(bytes.length / 2)
    return fakeResponse([bytes.subarray(0, split), bytes.subarray(split)])
  })
  const result = await runStudy(project, { adapter })
  assert.equal(result.summary.completed, 2); assert.equal(calls.length, 2)
  assert.equal(result.events.filter(row => row.type === 'resource-prepared').length, 2)
  await writeFile(resolve(root, 'stub-http-success-evidence.json'), canonical({ requests: calls, events: result.events }) + '\n')

  const bodyLimit = Math.floor((project.experimentTemplate.limits.maxResponseBytes - 512) / 3)
  let consumed = 0
  globalThis.fetch.mock.mockImplementation(async (_url, options) => {
    const request = JSON.parse(options.body), trial = project.schedule.find(row => row.id === request.trial.id), task = project.tasks.find(row => row.id === trial.taskId)
    assertPublicRequest(options.body, collectionRequest(project, project.spec.conditions[0], task, trial, 1))
    const valid = canonical(resourceTemplateEnvelope(task.resource.referencePlan))
    // A valid answer followed by legal JSON whitespace remains parseable in
    // the retained prefix. Transport failure must still prevent execution.
    const oversized = Buffer.from(valid + ' '.repeat(bodyLimit + 1024))
    return { ok: true, status: 200, body: { async *[Symbol.asyncIterator]() {
      consumed++; yield oversized.subarray(0, 113)
      consumed++; yield oversized.subarray(113)
      consumed++; assert.fail('Overflow must close the stream before reading more bytes')
    } } }
  })
  const overflow = await runStudy(project, { adapter })
  assert.equal(consumed, 2); assert.equal(overflow.summary.failed, 1); assert.equal(overflow.summary.completed, 0)
  assert.equal(overflow.events.filter(row => row.type.startsWith('resource-')).length, 0)
  const finish = overflow.events.find(row => row.type === 'finished'), evidence = finish.response.http || finish.response
  assert.equal(finish.phase, 'transport'); assert.equal(evidence.incomplete, true); assert.equal(evidence.reason, 'response-byte-limit')
  assert.equal(evidence.retainedBodyLimit, bodyLimit); assert.equal(Buffer.byteLength(evidence.body), bodyLimit)
  assert.ok(evidence.receivedBytesAtLeast > bodyLimit)
  assert.ok(Buffer.byteLength(canonical(finish.response)) <= project.experimentTemplate.limits.maxResponseBytes)
  assert.ok(JSON.parse(evidence.body).output.actions.length > 0)
  validateJournal(project, overflow.events); await verifyResourceJournal(project, overflow.events)
  await writeFile(resolve(root, 'stub-http-overflow-evidence.json'), canonical({ bodyLimit, consumedChunks: consumed, events: overflow.events }) + '\n')
  t.diagnostic('Stubbed fetch only: 2 valid public requests; oversized parseable prefix retained at ' + bodyLimit + ' bytes; 0 effects on overflow.')
})

test('actual standalone CLI retains its lock and response after an injected journal failure and refuses recovery redraw', async t => {
  const { root, project } = await exported(t, undefined, 'recovery')
  // Fault injection is outside the pinned export. It changes only the owned
  // child process file handle, at one durable resource-effect append boundary.
  const harness = resolve(dirname(root), 'fault-' + basename(root) + '.mjs')
  t.after(() => rm(harness, { force: true }))
  await writeFile(harness, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const originalOpen = fs.open;
fs.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (String(args[0]) === ${JSON.stringify(resolve(root, 'results/attempts.jsonl'))}) {
    const originalWrite = handle.write.bind(handle);
    handle.write = async (...values) => {
      if (JSON.parse(String(values[0])).type === 'resource-effect') {
        const error = new Error('INJECTED_RESOURCE_JOURNAL_FAILURE'); error.code = 'EIO'; throw error;
      }
      return originalWrite(...values);
    };
  }
  return handle;
};
syncBuiltinESMExports();
try { const { main } = await import(${JSON.stringify(pathToFileURL(resolve(root, 'cli.mjs')).href)}); await main(['run', '--project', ${JSON.stringify(root)}]); }
catch (error) { process.stderr.write(error.message + '\\n'); process.exitCode = 1; }
`)
  const failure = spawnSync(process.execPath, [harness], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  assert.equal(failure.error, undefined, failure.error?.message)
  assert.equal(failure.status, 1); assert.match(failure.stderr, /INJECTED_RESOURCE_JOURNAL_FAILURE/)
  const owner = JSON.parse(await readFile(resolve(root, 'results/.run-lock/owner.json'), 'utf8'))
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0)
  await assert.rejects(stat(resolve(root, 'results/.recovery-lock')), { code: 'ENOENT' })
  const before = await journal(root), responses = await responseFiles(root)
  assert.equal(Object.keys(responses).length, 1)
  assert.equal(before.events.filter(row => row.type === 'started').length, 1)
  assert.equal(before.events.filter(row => row.type === 'resource-prepared').length, 1)
  assert.equal(before.events.filter(row => row.type === 'resource-intent').length, 1)
  assert.equal(before.events.filter(row => row.type === 'resource-effect').length, 0)
  assert.equal(before.events.filter(row => row.type === 'finished').length, 0)
  assert.equal(validateJournal(project, before.events).length, 1)
  await verifyResourceJournal(project, before.events)
  const locked = cli(root, 'run')
  assert.equal(locked.status, 1); assert.match(locked.stderr, /lock|recover/i)
  const recovered = cli(root, 'run', ['--recover'])
  assert.equal(recovered.status, 1); assert.match(recovered.stderr, /already has a retained system response.*cannot redraw/i)
  assert.equal((await journal(root)).bytes, before.bytes)
  assert.deepEqual(await responseFiles(root), responses)
  await writeFile(resolve(root, 'injected-failure-receipt.json'), canonical({ owner, failure: failure.stderr, locked: locked.stderr, recovery: recovered.stderr, journalSha256: await sha256(before.bytes), responseFiles: Object.keys(responses) }) + '\n')
  t.diagnostic('Real CLI EIO boundary: lock retained, one response retained, no terminal score; --recover refused redraw and preserved exact bytes.')
})
