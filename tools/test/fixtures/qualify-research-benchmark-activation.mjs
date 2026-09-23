// Fresh native grading only after the portable selected-input gate passes. All generation
// responses and resource metadata are explicit synthetic replay controls.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, createReviewRecord, sha256 } from '../../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { bindLeanReview } from '../../../src/benchmark/lean-codegen.mjs'
import { projectFiles } from '../../../src/benchmark/export.mjs'
import { compileTask, deriveTaskExpected } from '../../../src/benchmark/tasks.mjs'
import { operationalReferenceProgram } from '../../../src/benchmark/trading-study.mjs'
import { readProject, runProject } from '../../../src/benchmark/cli.mjs'
import { assertSelectedInputQualification } from '../../../src/benchmark/requirements.mjs'
import { auditReferencePaths, sealAuditReference } from '../../../src/benchmark/audit.mjs'
import { activationFixture } from './research-benchmark-activation.mjs'
import { QUALIFICATION_IMAGE } from './qualify-research-benchmark-lean.mjs'

const json = value => JSON.stringify(value, null, 2) + '\n'
async function fileHashes(root, prefix = '') {
  const hashes = {}
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name
    if (entry.isDirectory()) Object.assign(hashes, await fileHashes(root, name))
    else if (entry.isFile()) hashes[name] = await sha256(await readFile(resolve(root, name)))
  }
  return hashes
}
export async function qualifyNativeActivation(directory) {
  directory = resolve(directory); await mkdir(directory, { recursive: false })
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  let spec = await activationFixture()
  const task = spec.tasks[0]
  const wrongTask = structuredClone(task); wrongTask.root.slots.buy_process.params.quantity = 2; wrongTask.expected = await deriveTaskExpected(spec, wrongTask)
  spec.id = 'native-activation-controls'; spec.name = 'Synthetic qualified-input native LEAN controls'
  spec.protocol = { ...spec.protocol, replicates: 3, maxAttemptsPerTrial: 3, maxTotalAttempts: 18, timeoutMs: 120000, maxDurationMs: 3600000, grading: { kind: 'lean-python', executionTimeoutMs: 60000 } }
  spec.environment.leanImage = QUALIFICATION_IMAGE
  spec.conditions = ['correct', 'wrong'].map(id => ({ id, label: id === 'correct' ? 'Reference program' : 'Wrong quantity program',
    model: { provider: 'fixture', id: 'synthetic-native-control', settings: {} }, adapter: { kind: 'replay', responses: {} } }))
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC NATIVE ACTIVATION APPARATUS ONLY')))
  const correct = await compileTask(spec, task), wrong = await compileTask(spec, wrongTask)
  for (const condition of spec.conditions) condition.adapter.responses[task.id] = operationalReferenceProgram(condition.id === 'correct' ? correct : wrong, sources)
  const project = await freezeStudy(spec), root = resolve(directory, 'project')
  for (const [file, content] of Object.entries(await projectFiles(project, sources))) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), content) }
  const report = { format: 'activation-native-qualification', version: 1, status: 'running', projectSha256: project.sha256, runtimeSources: project.spec.runtimeSources,
    image: QUALIFICATION_IMAGE, countedStudy: false, personalApproval: false, controls: { correct, wrong }, runs: [] }
  const persist = () => writeFile(resolve(directory, 'qualification.json'), json(report))
  await persist(); console.log('Executing one source-bound selected-input qualification gate before six fresh native trials.')
  try {
    const result = await runProject(root, { output: resolve(directory, 'results') })
    assert.equal(result.summary.completed, 6); assert.equal(result.summary.attempts, 6)
    const gates = result.events.filter(event => event.type === 'qualification')
    assert.equal(gates.length, 1); assert.equal(result.events[0].type, 'qualification-started')
    assert.equal(gates[0].preparationSeq, result.events[0].seq); assert.equal(gates[0].budgetChargeMs, gates[0].elapsedMs)
    assertSelectedInputQualification(project, gates[0].record)
    assert.equal(gates[0].record.requirements.selectedInput.qualifiedOccurrences, 5)
    report.gateSequence = gates[0].seq; report.compositionOccurrences = 5; report.apparatusRequirements = 1
    const previous = new Map()
    for (const event of result.events.filter(event => event.type === 'finished')) {
      const trial = project.schedule.find(trial => trial.id === event.trialId), expectedPass = trial.conditionId === 'correct', expected = expectedPass ? correct.expected : wrong.expected
      assert.equal(event.grade.passed, expectedPass, event.grade.reason)
      assert.equal(event.grade.classification, expectedPass ? 'correct' : 'trace-mismatch', event.grade.reason)
      assert.equal(canonical(event.grade.trace), canonical(expected))
      const observationSha256 = await sha256(canonical(event.grade.trace))
      if (previous.has(trial.conditionId)) assert.equal(previous.get(trial.conditionId), observationSha256); previous.set(trial.conditionId, observationSha256)
      report.runs.push({ trialId: trial.id, condition: trial.conditionId, replicate: trial.replicate, passed: event.grade.passed, candidateSha256: event.grade.candidateSha256, observationSha256, directory: event.grade.directory })
    }
    await readProject(root)
    for (const file of RUNTIME_FILES) assert.equal(await sha256(await readFile(new URL('../../../src/benchmark/' + file, import.meta.url))), project.spec.runtimeSources[file])
    const referenceFiles = {}
    for (const item of auditReferencePaths(project, result.events)) referenceFiles[item.key] = await readFile(resolve(item.location === 'project' ? root : resolve(directory, 'results'), item.path), 'utf8')
    const reference = await sealAuditReference(project, result.events, referenceFiles)
    await writeFile(resolve(directory, 'results/reference-bundle.json'), canonical(reference) + '\n'); report.referenceSha256 = reference.sha256
    const resumed = await runProject(root, { output: resolve(directory, 'results') }); assert.equal(canonical(resumed.events), canonical(result.events))
    report.status = 'qualified'; await persist()
    await writeFile(resolve(directory, 'artifact-hashes.json'), json(await fileHashes(directory)))
    console.log(json({ status: report.status, nativeExecutions: 6, qualifiedOccurrences: 5, correct: 3, rejected: 3, projectSha256: project.sha256 }))
  } catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); await persist(); throw error }
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Supply a new evidence directory')
  await qualifyNativeActivation(process.argv[2])
}
