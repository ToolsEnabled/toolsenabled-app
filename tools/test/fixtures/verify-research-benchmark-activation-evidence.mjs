// Offline reconstruction of the selected-input gate, chosen program and native
// artifacts. This verifier starts no provider, process adapter or container.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, sha256 } from '../../../src/benchmark/prompts.mjs'
import { readProject } from '../../../src/benchmark/cli.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { validateJournal } from '../../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../../src/benchmark/report.mjs'
import { compileTask, deriveTaskExpected } from '../../../src/benchmark/tasks.mjs'
import { operationalCandidateFiles, operationalReferenceProgram } from '../../../src/benchmark/trading-study.mjs'
import { nativeObservation, pythonSource } from '../../../src/benchmark/lean-observations.mjs'
import { assertSelectedInputQualification } from '../../../src/benchmark/requirements.mjs'
import { verifyAuditReference } from '../../../src/benchmark/audit.mjs'

const json = async file => JSON.parse(await readFile(file, 'utf8'))
export async function verifyActivationEvidence(directory) {
  const root = resolve(directory, 'project'), project = await readProject(root), report = await json(resolve(directory, 'qualification.json'))
  assert.equal(report.status, 'qualified'); assert.equal(report.projectSha256, project.sha256); assert.equal(report.countedStudy, false); assert.equal(report.personalApproval, false)
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  for (const file of RUNTIME_FILES) assert.equal(await sha256(sources[file]), project.spec.runtimeSources[file])
  const hashes = await json(resolve(directory, 'artifact-hashes.json'))
  for (const [file, hash] of Object.entries(hashes)) assert.equal(await sha256(await readFile(resolve(directory, file))), hash, 'Retained artifact changed: ' + file)
  const evidence = await json(resolve(directory, 'results/evidence.json')), events = (await readFile(resolve(directory, 'results/attempts.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(canonical(events), canonical(evidence.events)); assert.deepEqual(validateJournal(project, events), [])
  const task = project.tasks[0], wrong = structuredClone(project.spec.tasks[0]); wrong.root.slots.buy_process.params.quantity = 2; wrong.expected = await deriveTaskExpected(project.spec, wrong)
  const controls = { correct: await compileTask(project.spec, project.spec.tasks[0]), wrong: await compileTask(project.spec, wrong) }
  assert.equal(canonical(controls), canonical(report.controls))
  assert.deepEqual(report.runs.map(row => row.trialId).sort(), project.schedule.map(trial => trial.id).sort())
  const gates = events.filter(event => event.type === 'qualification')
  assert.equal(gates.length, 1); assert.equal(report.gateSequence, gates[0].seq)
  if (gates[0].preparationSeq === undefined) assert.equal(gates[0].seq, 1)
  else {
    assert.equal(events[0].type, 'qualification-started'); assert.equal(gates[0].preparationSeq, events[0].seq)
    assert.equal(gates[0].seq, 2); assert.equal(gates[0].budgetChargeMs, gates[0].elapsedMs)
  }
  assertSelectedInputQualification(project, gates[0].record)
  assert.equal(gates[0].record.requirements.selectedInput.qualifiedOccurrences, 5)
  assert.equal(gates[0].record.requirements.selectedInput.apparatusRequirements.length, 1)
  const previous = new Map()
  for (const row of report.runs) {
    const event = events.find(event => event.type === 'finished' && event.trialId === row.trialId), control = controls[row.condition], grade = event.grade, code = operationalReferenceProgram(control, sources)
    assert.equal(event.response.output, code); assert.equal(grade.candidateSha256, await sha256(pythonSource(code))); assert.equal(row.candidateSha256, grade.candidateSha256)
    assert.equal(grade.image, project.spec.environment.leanImage); assert.equal(grade.image, report.image)
    const run = resolve(directory, 'results', grade.directory), id = row.trialId + '-' + event.attempt
    for (const [file, contents] of Object.entries(operationalCandidateFiles(task, pythonSource(code), sources))) assert.equal(await readFile(resolve(run, 'algorithm', file), 'utf8'), contents)
    const native = await json(resolve(run, 'results', id + '.json')), orders = grade.files.includes(id + '-order-events.json') ? await json(resolve(run, 'results', id + '-order-events.json')) : null
    const trace = nativeObservation(native, orders, task)
    assert.equal(canonical(trace), canonical(control.expected)); assert.equal(canonical(trace), canonical(grade.trace)); assert.equal(await sha256(canonical(trace)), row.observationSha256)
    const passed = canonical(trace) === canonical(task.expected)
    assert.equal(grade.passed, passed); assert.equal(row.passed, passed); assert.equal(passed, row.condition === 'correct')
    if (previous.has(row.condition)) assert.equal(previous.get(row.condition), row.observationSha256); previous.set(row.condition, row.observationSha256)
  }
  const files = await researchReportFiles(project, events)
  for (const [file, contents] of Object.entries(files)) assert.equal(await readFile(resolve(directory, 'results', file), 'utf8'), contents)
  const reference = await verifyAuditReference(await json(resolve(directory, 'results/reference-bundle.json')))
  assert.equal(reference.sha256, report.referenceSha256); assert.equal(canonical(reference.events), canonical(events))
  return { status: 'verified', projectSha256: project.sha256, runtimePins: RUNTIME_FILES.length, nativeExecutions: report.runs.length,
    qualifiedOccurrences: 5, gateSequence: 1, rejectedPrograms: report.runs.filter(row => !row.passed).length, retainedFiles: Object.keys(hashes).length, reportFiles: Object.keys(files).length, referenceSha256: reference.sha256 }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verifyActivationEvidence(resolve(process.argv[2])), null, 2))
