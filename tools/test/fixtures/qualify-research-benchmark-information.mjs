// Native controls for set-valued grading. No provider calls or counted study.
// Usage: node tools/test/fixtures/qualify-research-benchmark-information.mjs /absolute/evidence
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { canonical, createReviewRecord, sha256 } from '../../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { compileTask } from '../../../src/benchmark/tasks.mjs'
import { createTaskReviewRecord } from '../../../src/benchmark/information.mjs'
import { bindLeanReview, inlineLeanProgram, generateLeanProgram } from '../../../src/benchmark/lean-codegen.mjs'
import { projectFiles } from '../../../src/benchmark/export.mjs'
import { validateJournal } from '../../../src/benchmark/runner.mjs'
import { leanInformationFixture } from './research-benchmark-information.mjs'
import { QUALIFICATION_IMAGE } from './qualify-research-benchmark-lean.mjs'

export async function qualifyInformation(directory) {
  const evidence = resolve(directory), exported = resolve(evidence, 'exported-project'), output = resolve(evidence, 'results')
  await mkdir(exported, { recursive: true })
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  let spec = leanInformationFixture()
  spec.name = 'Omitted quantity: native apparatus controls'
  spec.tasks[0].information.responseMode = 'tagged-json'
  spec.protocol = { ...spec.protocol, replicates: 3, maxAttemptsPerTrial: 1, maxTotalAttempts: 18, timeoutMs: 120000, maxDurationMs: 900000,
    grading: { kind: 'lean-python', executionTimeoutMs: 30000 } }
  spec.environment.leanImage = QUALIFICATION_IMAGE
  const task = await compileTask(spec, spec.tasks[0], { requireReview: false, requireTaskReview: false })
  const program = compiled => inlineLeanProgram(generateLeanProgram({ ...task, compiled }), sources)
  const controls = [
    { id: 'reading-one', response: { kind: 'answer', answer: program(task.interpretations[0].compiled) }, classification: 'admissible', readings: ['shares-1'] },
    { id: 'reading-three', response: { kind: 'answer', answer: program(task.interpretations[1].compiled) }, classification: 'admissible', readings: ['shares-3'] },
    { id: 'hidden-baseline', response: { kind: 'answer', answer: program(task.compiled) }, classification: 'outside-declared-set', readings: [] },
    { id: 'clarification', response: { kind: 'clarification', message: 'What purchase quantity is required?' }, classification: 'clarification', readings: [] },
    { id: 'refusal', response: { kind: 'refusal', message: 'Synthetic refusal control.' }, classification: 'refusal', readings: [] },
    { id: 'malformed', response: { kind: 'answer' }, classification: 'malformed-response', readings: [] },
  ]
  spec.conditions = controls.map(control => ({ id: control.id, label: 'Synthetic native apparatus control', model: { provider: 'fixture', id: 'generated-reference', settings: {} }, adapter: { kind: 'replay', responses: { [task.id]: control.response } } }))
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC NATIVE INFORMATION CONTROL ONLY')))
  spec.taskReviews = [await createTaskReviewRecord(await compileTask(spec, spec.tasks[0], { requireTaskReview: false }), 'SYNTHETIC NATIVE INFORMATION CONTROL ONLY')]
  const project = await freezeStudy(spec), files = await projectFiles(project, sources)
  for (const [file, contents] of Object.entries(files)) { const target = resolve(exported, file); await mkdir(dirname(target), { recursive: true }); await writeFile(target, contents) }
  for (const command of ['verify', 'qualify', 'run', 'analyze']) {
    console.log('Running fresh exported information control: ' + command)
    const result = spawnSync(process.execPath, [resolve(exported, 'cli.mjs'), command, '--output', output], { cwd: evidence, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    await writeFile(resolve(evidence, command + '.log'), result.stdout + result.stderr)
    assert.equal(result.status, 0, result.stderr)
  }
  const retained = JSON.parse(await readFile(resolve(output, 'evidence.json'), 'utf8'))
  validateJournal(project, retained.events)
  assert.equal(retained.summary.completed, 18)
  const report = { format: 'information-native-controls', status: 'passed', countedStudy: false, ownerApproved: false, image: QUALIFICATION_IMAGE,
    projectSha256: project.sha256, runtimeSources: project.spec.runtimeSources, cases: [] }
  for (const control of controls) {
    const trials = new Set(project.schedule.filter(trial => trial.conditionId === control.id).map(trial => trial.id))
    const ends = retained.events.filter(event => event.type === 'finished' && trials.has(event.trialId))
    assert.equal(ends.length, 3)
    for (const event of ends) {
      assert.equal(event.grade.classification, control.classification, control.id)
      assert.deepEqual(event.grade.matchingReadings, control.readings)
    }
    const traces = ends.filter(event => event.grade.trace).map(event => canonical(event.grade.trace))
    assert.ok(!traces.length || traces.length === 3)
    if (traces.length) assert.equal(new Set(traces).size, 1, control.id + ': all three native traces must be identical')
    report.cases.push({ id: control.id, repetitions: 3, classification: control.classification, matchingReadings: control.readings,
      nativeRuns: traces.length, nativeTraceSha256: traces.length ? await sha256(traces[0]) : null })
  }
  const forged = structuredClone(retained.events), altered = forged.find(event => event.grade?.classification === 'admissible')
  altered.grade.matchingReadings = ['shares-3']; altered.grade.trace = []
  assert.throws(() => validateJournal(project, forged), /retained engine trace/)
  report.retainedTraceMismatchRefused = true
  await writeFile(resolve(evidence, 'qualification.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Supply an evidence directory; this runs actual local Docker controls.')
  await qualifyInformation(process.argv[2])
}
