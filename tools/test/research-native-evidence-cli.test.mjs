import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm, rename, symlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonical, createReviewRecord, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { operationalStarter } from '../../src/benchmark/trading-catalog.mjs'
import { operationalCandidateFiles } from '../../src/benchmark/trading-study.mjs'
import { deriveTaskExpected } from '../../src/benchmark/tasks.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { leanConfig } from '../../src/benchmark/lean-observations.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { verifyNativeJournalEvidence, NATIVE_EVIDENCE_LIMITS } from '../../src/benchmark/audit.mjs'
import { evaluateReadiness } from '../../src/benchmark/readiness.mjs'
import { newExperimentDraft } from '../../src/benchmark/starters.mjs'

// Entirely synthetic retained bytes. Neither these journals nor their process
// records establish that a native engine, provider or candidate ever executed.
const code = '# SYNTHETIC SAVED PROGRAM; NEVER EXECUTED BY THIS TEST\n'
const at = '2026-09-09T00:00:00.000Z'
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const json = value => canonical(value) + '\n'
const outputNames = ['native-evidence.json', 'native-verification.json']
let retainedSequence = 0
async function retain(label, value) {
  const directory = process.env.RESEARCH_NATIVE_EVIDENCE_CLI_EVIDENCE
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, String(++retainedSequence).padStart(3, '0') + '-' + label + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}
async function put(path, bytes) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes) }
async function absentOutputs(fixture) {
  for (const name of outputNames) await assert.rejects(readFile(resolve(fixture.output, name)), error => error.code === 'ENOENT')
}
async function fixture(t, { operational = true, eventsFile = false, binary = false, purpose = 'apparatus-development' } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'native-evidence-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = resolve(directory, 'project'), output = resolve(directory, 'retained'), binaryBytes = Buffer.from([0, 255, 254, 128, 10])
  let spec = newExperimentDraft(operational ? await operationalStarter() : leanStarter(), { purpose, initializePopulation: true })
  const task = spec.tasks[0]
  if (operational) {
    const stack = [task.root]
    while (stack.length) {
      const node = stack.pop()
      if (node.use === 'op-above') node.params = { ...(node.params || {}), threshold: 99999999 }
      stack.push(...Object.values(node.slots || {}))
    }
  } else task.root.slots.strategy.slots.buy_reason.params = { threshold: 1 }
  task.expected = await deriveTaskExpected(spec, task)
  spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 30000 }
  spec.protocol.replicates = 1; spec.protocol.maxAttemptsPerTrial = 1; spec.protocol.maxTotalAttempts = 1
  spec.environment.leanImage = 'synthetic-unavailable-image@sha256:' + 'a'.repeat(64)
  spec.conditions = [{ id: 'saved-control', model: { provider: 'fixture', id: 'never-executed', settings: {} }, adapter: { kind: 'replay', responses: { [task.id]: code } } }]
  if (binary) spec.inputs = [{ path: 'inputs/binary-fixture.bin', sha256: await sha256(binaryBytes), instructions: 'Synthetic saved bytes; never mounted by this test.' }]
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC CLI ARTIFACT FIXTURE; NO PERSONAL APPROVAL', { at })))
  const project = await freezeStudy(spec), trial = project.schedule[0], id = trial.id + '-1'
  const trace = operational ? { format: 'lean-operational-observation', version: 1, orders: [], events: [], lots: [], cashFromFillsCents: 150000,
    positionsFromFills: [{ asset: 'SPY', quantity: 0 }], feesCents: 0, equityCents: { start: 150000, end: 150000 } } : []
  assert.deepEqual(trace, project.tasks[0].expected, 'The hand-authored quiet observation agrees with the frozen task; no native observer generates this oracle.')
  const execution = { exitCode: 0, signal: null, stdout: 'SYNTHETIC PROCESS RECORD; NO NATIVE RUN', stderr: '' }
  const grade = { passed: true, score: 1, classification: 'correct', trace, directory: 'artifacts/' + id,
    files: [id + '.json', ...(eventsFile ? [id + '-order-events.json'] : [])], image: spec.environment.leanImage, candidateSha256: await sha256(code.trim()), execution }
  const common = { projectSha256: project.sha256, trialId: trial.id, attempt: 1 }
  const events = [{ ...common, seq: 1, type: 'started', at, promptSha256: project.tasks[0].compiled.promptSha256,
    readinessSha256: project.readiness.sha256, executionPurpose: purpose },
  { ...common, seq: 2, type: 'finished', at, elapsedMs: 1, status: 'completed', response: { output: code }, grade }]
  const native = resolve(output, 'artifacts', id)
  const raw = operational ? { state: { Status: 'Completed' }, orders: {}, algorithmConfiguration: { accountCurrency: 'USD' },
    totalPerformance: { portfolioStatistics: { startEquity: '1500', endEquity: '1500' } } } : { state: { Status: 'Completed' }, orders: {} }
  const programs = operational ? operationalCandidateFiles(project.tasks[0], code.trim(), sources) : { 'main.py': code.trim() + '\n' }
  for (const [name, bytes] of Object.entries(await projectFiles(project, sources))) await put(resolve(root, name), bytes)
  if (binary) await put(resolve(root, 'inputs/binary-fixture.bin'), binaryBytes)
  for (const [name, bytes] of Object.entries(programs)) await put(resolve(native, 'algorithm', name), bytes)
  await put(resolve(native, 'config.json'), json(leanConfig(id)))
  await put(resolve(native, 'execution.json'), json(execution))
  await put(resolve(native, 'results', id + '.json'), json(raw))
  if (eventsFile) await put(resolve(native, 'results', id + '-order-events.json'), '[]\n')
  await put(resolve(output, 'attempts.jsonl'), events.map(json).join(''))
  return { directory, root, output, native, id, project, events, raw, binaryBytes }
}
async function cli(fixture, { args = [], expected = 0 } = {}) {
  const before = await readFile(resolve(fixture.output, 'attempts.jsonl'))
  // No Docker, Python or provider command can be found through this PATH. The
  // actual portable Node CLI must complete using retained bytes only.
  const result = spawnSync(process.execPath, [resolve(fixture.root, 'cli.mjs'), 'verify-native', '--project', fixture.root, '--output', fixture.output, ...args],
    { cwd: tmpdir(), env: { ...process.env, PATH: resolve(fixture.directory, 'no-executables') }, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
  await retain('cli-result', { args, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message || null })
  assert.equal(result.status, expected, result.stderr || result.error?.message)
  assert.deepEqual(await readFile(resolve(fixture.output, 'attempts.jsonl')), before, 'Verification must not change the retained journal.')
  return result
}

for (const operational of [false, true]) test('portable verify-native reconstructs ' + (operational ? 'operational objects' : 'synchronous arrays') + ' without execution or a project manifest', async t => {
  const f = await fixture(t, { operational, binary: true })
  await rm(resolve(f.root, 'manifest.json'))
  await put(resolve(f.native, 'results/engine.log'), 'Unrelated normal files are not captured or executed.\n')
  const result = await cli(f), summary = JSON.parse(result.stdout)
  assert.deepEqual(summary, { evidence: resolve(f.output, outputNames[0]), verification: resolve(f.output, outputNames[1]),
    projectSha256: f.project.sha256, evidenceStatus: 'retained-artifact-consistency', attempts: 1 })
  const bundle = JSON.parse(await readFile(summary.evidence)), receipt = JSON.parse(await readFile(summary.verification))
  assert.deepEqual(Object.keys(bundle).sort(), ['events', 'files', 'format', 'project', 'version'])
  assert.equal(bundle.format, 'benchmark-native-evidence'); assert.equal(bundle.version, 1)
  assert.deepEqual(bundle.project, f.project); assert.deepEqual(bundle.events, f.events)
  assert.deepEqual(bundle.files['inputs/inputs/binary-fixture.bin'], { encoding: 'base64', data: f.binaryBytes.toString('base64') })
  assert.ok(!Object.keys(bundle.files).some(name => name.endsWith('engine.log') || name.endsWith('order-events.json')))
  assert.deepEqual(receipt, await verifyNativeJournalEvidence({ project: bundle.project, events: bundle.events, files: bundle.files }))
  assert.equal(receipt.evidenceStatus, 'retained-artifact-consistency'); assert.equal(receipt.attempts.length, 1)
  assert.match(receipt.scope, /native execution, preparation and experimental admission are not established/)
  assert.equal(evaluateReadiness(f.project, { operation: 'collect' }).eligible, false)
  assert.ok(evaluateReadiness(f.project, { operation: 'collect' }).blockers.some(row => row.code === 'native-admission-unavailable'))
  await retain(operational ? 'operational-proof' : 'synchronous-proof', { summary, receipt, projectSha256: f.project.sha256, journalSha256: await sha256(await readFile(resolve(f.output, 'attempts.jsonl'))) })
})

test('optional order-event bytes are discovered independently of the claimed grade file list', async t => {
  const f = await fixture(t, { eventsFile: true })
  await cli(f)
  const bundle = JSON.parse(await readFile(resolve(f.output, 'native-evidence.json')))
  assert.equal(bundle.files['native/' + f.id + '/order-events.json'], '[]\n')
  for (const name of outputNames) await rm(resolve(f.output, name))
  f.events[1].grade.files = [f.id + '.json']
  await writeFile(resolve(f.output, 'attempts.jsonl'), f.events.map(json).join(''))
  const refused = await cli(f, { expected: 1 })
  assert.match(refused.stderr, /files|roster|artifact/i); await absentOutputs(f)
})

test('missing and tampered retained inputs fail before either verification artifact is published', async t => {
  for (const kind of ['missing-result', 'candidate', 'runtime', 'config', 'execution', 'raw-result']) {
    const f = await fixture(t)
    if (kind === 'missing-result') await rm(resolve(f.native, 'results', f.id + '.json'))
    if (kind === 'candidate') await writeFile(resolve(f.native, 'algorithm/candidate.py'), '# altered source\n')
    if (kind === 'runtime') await writeFile(resolve(f.root, 'prompts.mjs'), sources['prompts.mjs'] + '\n// changed\n')
    if (kind === 'config') await writeFile(resolve(f.native, 'config.json'), '{}\n')
    if (kind === 'execution') await writeFile(resolve(f.native, 'execution.json'), json({ ...f.events[1].grade.execution, exitCode: 1 }))
    if (kind === 'raw-result') await writeFile(resolve(f.native, 'results', f.id + '.json'), json({ ...f.raw, state: { Status: 'Running' } }))
    await cli(f, { expected: 1 }); await absentOutputs(f)
  }
})

test('required files, optional artifacts and directory components reject even in-root symlinks', async t => {
  for (const kind of ['runtime-file', 'algorithm-directory', 'optional-events', 'project-file']) {
    const f = await fixture(t)
    let target, destination
    if (kind === 'runtime-file') { target = resolve(f.root, 'prompts.mjs'); destination = resolve(f.root, 'original-prompts.mjs') }
    if (kind === 'algorithm-directory') { target = resolve(f.native, 'algorithm'); destination = resolve(f.native, 'original-algorithm') }
    if (kind === 'project-file') { target = resolve(f.root, 'project.json'); destination = resolve(f.root, 'original-project.json') }
    if (kind === 'optional-events') { target = resolve(f.native, 'results', f.id + '-order-events.json'); destination = resolve(f.native, 'results/saved-events.json'); await writeFile(destination, '[]\n') }
    else await rename(target, destination)
    await symlink(destination, target, kind === 'algorithm-directory' ? 'dir' : 'file')
    const result = await cli(f, { expected: 1 }); assert.match(result.stderr, /symlink/); await absentOutputs(f)
  }
})

test('file and cumulative input limits reject sparse oversized artifacts before verification or publication', async t => {
  for (const kind of ['project', 'journal', 'artifact', 'aggregate']) {
    const f = await fixture(t)
    const fileLimit = NATIVE_EVIDENCE_LIMITS.fileBytes
    if (kind === 'project') await truncate(resolve(f.root, 'project.json'), fileLimit + 1)
    if (kind === 'journal') await truncate(resolve(f.output, 'attempts.jsonl'), fileLimit + 1)
    if (kind === 'artifact') await truncate(resolve(f.native, 'results', f.id + '.json'), fileLimit + 1)
    if (kind === 'aggregate') for (const name of ['algorithm/main.py', 'algorithm/candidate.py', 'config.json', 'execution.json']) await truncate(resolve(f.native, name), fileLimit)
    const result = await cli(f, { expected: 1 }); assert.match(result.stderr, /file or aggregate byte limit/); await absentOutputs(f)
  }
})

test('escaped serialization is bounded independently of the captured decoded-file budget', async t => {
  const f = await fixture(t)
  await truncate(resolve(f.native, 'algorithm/candidate.py'), 12 * 1024 * 1024)
  const result = await cli(f, { expected: 1 }); assert.match(result.stderr, /Serialized native evidence exceeds 64 MiB/); await absentOutputs(f)
})

test('incomplete journals and execution-related options refuse without publication', async t => {
  const f = await fixture(t), journal = f.events.map(json).join('')
  await writeFile(resolve(f.output, 'attempts.jsonl'), journal.trimEnd())
  const invalid = await cli(f, { expected: 1 }); assert.match(invalid.stderr, /incomplete final write/); await absentOutputs(f)
  await writeFile(resolve(f.output, 'attempts.jsonl'), journal)
  for (const args of [['--recover'], ['--python', 'unavailable'], ['--compact']]) {
    const result = await cli(f, { expected: 1, args }); assert.match(result.stderr, /accepts only --project and --output/); await absentOutputs(f)
  }
})

test('exclusive publication preserves existing receipts and cleans only its own first output if the second already exists', async t => {
  for (const existing of outputNames) {
    const f = await fixture(t), contents = 'PRIOR RECEIPT MUST REMAIN EXACT\n'
    await writeFile(resolve(f.output, existing), contents)
    const result = await cli(f, { expected: 1 }); assert.match(result.stderr, /publication failed/)
    assert.equal(await readFile(resolve(f.output, existing), 'utf8'), contents)
    await assert.rejects(readFile(resolve(f.output, outputNames.find(name => name !== existing))), error => error.code === 'ENOENT')
  }
})

test('artifact verification cannot admit an otherwise identical native experiment through a claimed completed journal', async t => {
  const f = await fixture(t, { purpose: 'experiment' })
  assert.equal(f.project.spec.executionPlan.purpose, 'experiment')
  assert.ok(evaluateReadiness(f.project, { operation: 'collect' }).blockers.some(row => row.code === 'native-admission-unavailable'))
  const result = await cli(f, { expected: 1 }); assert.match(result.stderr, /Native candidate collection remains blocked|native-admission/)
  await absentOutputs(f)
})
