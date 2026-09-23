// The two receipts reach the report and the page through the CLI: `analyze`
// reads results/qualification.json and results/native-verification.json
// beside the journal, renders both, retains them under paper/ and embeds them
// in results/evidence.json with their digests; `run` embeds whatever receipts
// are already beside the journal. Nothing here runs an engine, a model or
// Docker: the lean fixture's native artifacts are synthetic retained bytes,
// and the qualification receipt comes from the real `qualify` command, which
// runs the JavaScript and Python interpreters over the frozen apparatus only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { PYTHON_COMMAND } from './lib/python-command.mjs'
import { endpointStudy } from './fixtures/research-benchmark-endpoints.mjs'
import { canonical, createReviewRecord, sha256 } from '../../src/benchmark/prompts.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { leanConfig } from '../../src/benchmark/lean-observations.mjs'
import { deriveTaskExpected } from '../../src/benchmark/tasks.mjs'
import { newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { qualifyProject } from '../../src/benchmark/qualify.mjs'
import { runProject } from '../../src/benchmark/cli.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const AT = '2026-09-09T00:00:00.000Z', json = value => canonical(value) + '\n'
const put = async (path, bytes) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes) }
const digestOf = value => sha256(canonical(JSON.parse(JSON.stringify(value))))
const retained = value => JSON.stringify(JSON.parse(canonical(value)), null, 2) + '\n'
const absent = path => assert.rejects(readFile(path), error => error.code === 'ENOENT', path + ' must not exist')
function cli(root, command, { output, extra = [], expected = 0 } = {}) {
  const result = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), command, '--project', root, ...(output ? ['--output', output] : []), ...extra],
    { cwd: tmpdir(), encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  assert.equal(result.status, expected, command + ': ' + (result.stderr || result.error?.message))
  return result
}

// A lean-python export with one completed, synthetically retained native
// attempt, laid out the way the verify-native suite lays it out. The
// hand-authored quiet trace agrees with the frozen task; no engine ran.
async function nativeFixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'receipts-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = resolve(directory, 'project'), output = resolve(directory, 'retained')
  const code = '# SYNTHETIC SAVED PROGRAM; NEVER EXECUTED BY THIS TEST\n'
  let spec = newExperimentDraft(leanStarter(), { purpose: 'apparatus-development', initializePopulation: true })
  const task = spec.tasks[0]
  task.root.slots.strategy.slots.buy_reason.params = { threshold: 1 }
  task.expected = await deriveTaskExpected(spec, task)
  assert.deepEqual(task.expected, [], 'every recorded bar leaves the explicit buy threshold unsatisfied')
  spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 30000 }
  spec.protocol.replicates = 1; spec.protocol.maxAttemptsPerTrial = 1; spec.protocol.maxTotalAttempts = 1
  spec.environment.leanImage = 'synthetic-unavailable-image@sha256:' + 'a'.repeat(64)
  spec.conditions = [{ id: 'saved-control', model: { provider: 'fixture', id: 'never-executed', settings: {} }, adapter: { kind: 'replay', responses: { [task.id]: code } } }]
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC CLI RECEIPT FIXTURE; NO PERSONAL APPROVAL', { at: AT })))
  const project = await freezeStudy(spec), trial = project.schedule[0], id = trial.id + '-1'
  const execution = { exitCode: 0, signal: null, stdout: 'SYNTHETIC PROCESS RECORD; NO NATIVE RUN', stderr: '' }
  const grade = { passed: true, score: 1, classification: 'correct', trace: [], directory: 'artifacts/' + id, files: [id + '.json'],
    image: spec.environment.leanImage, candidateSha256: await sha256(code.trim()), execution }
  const common = { projectSha256: project.sha256, trialId: trial.id, attempt: 1 }
  const events = [{ ...common, seq: 1, type: 'started', at: AT, promptSha256: project.tasks[0].compiled.promptSha256, readinessSha256: project.readiness.sha256, executionPurpose: 'apparatus-development' },
    { ...common, seq: 2, type: 'finished', at: AT, elapsedMs: 1, status: 'completed', response: { output: code }, grade }]
  for (const [name, bytes] of Object.entries(await projectFiles(project, sources))) await put(resolve(root, name), bytes)
  const native = resolve(output, 'artifacts', id)
  await put(resolve(native, 'algorithm', 'main.py'), code.trim() + '\n')
  await put(resolve(native, 'config.json'), json(leanConfig(id)))
  await put(resolve(native, 'execution.json'), json(execution))
  await put(resolve(native, 'results', id + '.json'), json({ state: { Status: 'Completed' }, orders: {} }))
  await put(resolve(output, 'attempts.jsonl'), events.map(json).join(''))
  return { directory, root, output, project, events }
}

test('qualify, verify-native and analyze: the report prints both receipts under their digests and evidence.json embeds them with the same digests', async t => {
  const f = await nativeFixture(t)
  cli(f.root, 'qualify', { output: f.output, extra: ['--python', PYTHON_COMMAND] })
  const qualification = JSON.parse(await readFile(resolve(f.output, 'qualification.json'), 'utf8'))
  assert.equal(qualification.format, 'research-benchmark-qualification'); assert.equal(qualification.projectSha256, f.project.sha256)
  assert.ok(qualification.checks.length >= 11 && qualification.checks.every(check => check.passed === true), 'the real qualifier agreed with itself on every apparatus control and on the frozen task')
  cli(f.root, 'verify-native', { output: f.output })
  const verification = JSON.parse(await readFile(resolve(f.output, 'native-verification.json'), 'utf8'))
  assert.equal(verification.journalSha256, await digestOf(f.events), 'the real verifier hashed exactly this journal')
  cli(f.root, 'analyze', { output: f.output })
  const qualificationSha256 = await digestOf(qualification), nativeVerificationSha256 = await digestOf(verification)
  const markdown = await readFile(resolve(f.output, 'report.md'), 'utf8'), html = await readFile(resolve(f.output, 'report.html'), 'utf8')
  for (const text of [markdown, html]) {
    assert.ok(text.includes('Receipt SHA-256 ' + qualificationSha256), 'the qualification receipt is printed under its digest')
    assert.ok(text.includes('Receipt SHA-256 ' + nativeVerificationSha256), 'the native verification receipt is printed under its digest')
    assert.ok(text.includes('JavaScript and Python agree'), 'the interpreter agreement is recomputed from the real receipt')
    assert.ok(!text.includes('No qualification receipt') && !text.includes('No native verification receipt'), 'neither absence sentence appears beside a receipt')
  }
  assert.equal(await readFile(resolve(f.output, 'paper', 'qualification.json'), 'utf8'), retained(qualification))
  assert.equal(await readFile(resolve(f.output, 'paper', 'native-verification.json'), 'utf8'), retained(verification))
  const evidence = JSON.parse(await readFile(resolve(f.output, 'evidence.json'), 'utf8'))
  assert.deepEqual(Object.keys(evidence).sort(), ['events', 'nativeVerification', 'nativeVerificationSha256', 'projectSha256', 'qualification', 'qualificationSha256', 'summary'])
  assert.equal(evidence.projectSha256, f.project.sha256); assert.deepEqual(evidence.events, f.events)
  assert.deepEqual(evidence.qualification, qualification); assert.equal(evidence.qualificationSha256, qualificationSha256)
  assert.deepEqual(evidence.nativeVerification, verification); assert.equal(evidence.nativeVerificationSha256, nativeVerificationSha256)
  // analyze derives the same bytes again; it never accumulates or rewrites history.
  cli(f.root, 'analyze', { output: f.output })
  assert.equal(await readFile(resolve(f.output, 'evidence.json'), 'utf8'), JSON.stringify(evidence, null, 2) + '\n')
  assert.equal(await readFile(resolve(f.output, 'report.md'), 'utf8'), markdown)
})

test('analyze without receipts beside the journal says Not declared and writes an evidence.json with only the journal fields', async t => {
  const f = await nativeFixture(t), bare = resolve(f.directory, 'bare')
  await put(resolve(bare, 'attempts.jsonl'), f.events.map(json).join(''))
  cli(f.root, 'analyze', { output: bare })
  const html = await readFile(resolve(bare, 'report.html'), 'utf8')
  assert.ok(html.includes('Not declared. No qualification receipt (results/qualification.json, written by node cli.mjs qualify) was supplied with this journal'))
  assert.ok(html.includes('Not declared. No native verification receipt (results/native-verification.json, written by node cli.mjs verify-native) was supplied with this journal'))
  assert.ok(!html.includes('Receipt SHA-256'), 'no digest is invented')
  const evidence = JSON.parse(await readFile(resolve(bare, 'evidence.json'), 'utf8'))
  assert.deepEqual(Object.keys(evidence).sort(), ['events', 'projectSha256', 'summary'])
  assert.deepEqual(evidence.events, f.events)
  await absent(resolve(bare, 'paper', 'qualification.json')); await absent(resolve(bare, 'paper', 'native-verification.json'))
})

test('a receipt beside the journal that belongs to another project, or that is not JSON, stops analyze with a named refusal and writes nothing', async t => {
  const f = await nativeFixture(t)
  const stale = resolve(f.directory, 'stale'), broken = resolve(f.directory, 'broken')
  for (const directory of [stale, broken]) await put(resolve(directory, 'attempts.jsonl'), f.events.map(json).join(''))
  await put(resolve(stale, 'qualification.json'), JSON.stringify({ format: 'research-benchmark-qualification', version: 1, projectSha256: '0'.repeat(64), runtimeSources: f.project.spec.runtimeSources, checks: [], scope: 'stale' }) + '\n')
  const refused = cli(f.root, 'analyze', { output: stale, expected: 1 })
  assert.match(refused.stderr, /qualification receipt belongs to a different frozen project/)
  await absent(resolve(stale, 'report.md')); await absent(resolve(stale, 'evidence.json'))
  await put(resolve(broken, 'native-verification.json'), '{ not json\n')
  const unreadable = cli(f.root, 'analyze', { output: broken, expected: 1 })
  assert.match(unreadable.stderr, /native-verification\.json beside the journal is not readable JSON/)
  await absent(resolve(broken, 'report.md')); await absent(resolve(broken, 'evidence.json'))
})

test('run embeds a qualification receipt already beside the journal, with its digest, into evidence.json', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'receipts-run-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = resolve(directory, 'project'), output = resolve(root, 'results')
  const spec = endpointStudy(null)
  const project = await freezeStudy(await bindRuntimeSources(spec, sources))
  for (const [name, bytes] of Object.entries(await projectFiles(project, sources, {}))) await put(resolve(root, name), bytes)
  const receipt = JSON.parse(JSON.stringify(await qualifyProject(root, project)))
  assert.equal(receipt.projectSha256, project.sha256)
  await put(resolve(output, 'qualification.json'), JSON.stringify(receipt, null, 2) + '\n')
  const result = await runProject(root)
  assert.equal(result.summary.completed, result.summary.scheduled)
  const evidence = JSON.parse(await readFile(resolve(output, 'evidence.json'), 'utf8'))
  assert.deepEqual(Object.keys(evidence).sort(), ['events', 'projectSha256', 'qualification', 'qualificationSha256', 'summary'])
  assert.deepEqual(evidence.qualification, receipt); assert.equal(evidence.qualificationSha256, await digestOf(receipt))
  assert.deepEqual(evidence.events, result.events)
  assert.ok((await readFile(resolve(output, 'report.html'), 'utf8')).includes('Receipt SHA-256 ' + evidence.qualificationSha256), 'the run of a recorded project renders the receipt it found beside its journal')
})
