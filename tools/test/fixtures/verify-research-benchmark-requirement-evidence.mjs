// Rebuild every case from the frozen registry and regrade retained native
// artifacts. No container, provider call, or candidate diagnostic is trusted.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, sha256 } from '../../../src/benchmark/prompts.mjs'
import { readProject } from '../../../src/benchmark/cli.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { qualifyProject } from '../../../src/benchmark/qualify.mjs'
import { compileTask, deriveTaskExpected } from '../../../src/benchmark/tasks.mjs'
import { operationalCandidateFiles, operationalReferenceProgram } from '../../../src/benchmark/trading-study.mjs'
import { nativeObservation, pythonSource } from '../../../src/benchmark/lean-observations.mjs'

const json = async file => JSON.parse(await readFile(file, 'utf8'))
export async function verifyRequirementEvidence(directory) {
  directory = resolve(directory)
  const projectRoot = resolve(directory, 'project'), project = await readProject(projectRoot), report = await json(resolve(directory, 'qualification.json'))
  assert.equal(report.status, 'qualified'); assert.equal(report.projectSha256, project.sha256); assert.equal(report.registrySha256, project.requirements.sha256)
  assert.equal(report.countedStudy, false); assert.equal(report.personalApproval, false)
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  assert.deepEqual(report.runtimeSources, project.spec.runtimeSources)
  for (const file of RUNTIME_FILES) assert.equal(await sha256(sources[file]), project.spec.runtimeSources[file], 'Qualification source changed: ' + file)
  const hashes = await json(resolve(directory, 'artifact-hashes.json'))
  for (const [file, hash] of Object.entries(hashes)) assert.equal(await sha256(await readFile(resolve(directory, file))), hash, 'Retained artifact changed: ' + file)
  const independent = await qualifyProject(projectRoot, project)
  assert.equal(canonical(independent), canonical(await json(resolve(directory, 'independent-qualification.json'))), 'Recomputed independent witnesses differ')
  assert.equal(independent.requirements.status, 'qualified')
  const jobs = new Map()
  const add = async (task, candidateTask, witness, repetitions) => {
    const code = operationalReferenceProgram(candidateTask, sources), key = await sha256(canonical({ semantic: task.compiled.semantic, input: task.input, code }))
    if (jobs.has(key)) { const job = jobs.get(key); job.witnesses.push(witness); job.repetitions = Math.max(job.repetitions, repetitions); return }
    jobs.set(key, { id: 'case-' + (jobs.size + 1), key, task, candidateTask, code, witnesses: [witness], repetitions, expectedPass: canonical(task.expected) === canonical(candidateTask.expected) })
  }
  for (const target of project.requirements.targets) for (const probe of target.probes) {
    const identity = { targetId: target.id, probeId: probe.id }
    await add(probe.reference, probe.reference, { ...identity, kind: 'registered-reference' }, 3)
    for (const wrong of probe.wrongReadings) {
      await add(probe.reference, wrong.task, { ...identity, kind: 'registered-wrong-reading', wrongId: wrong.id }, 3)
      const shrink = independent.requirements.targets.find(row => row.id === target.id).probes.find(row => row.id === probe.id).wrongReadings.find(row => row.id === wrong.id).shrink
      assert.equal(shrink.oneMinimal, true)
      const compile = async task => {
        const source = { id: task.id, root: task.root, variables: task.variables, input: shrink.input, split: task.split }
        source.expected = await deriveTaskExpected(project.spec, source)
        return compileTask(project.spec, source)
      }
      const left = await compile(probe.reference), right = await compile(wrong.task)
      await add(left, left, { ...identity, kind: 'minimized-reference', wrongId: wrong.id }, 1)
      await add(left, right, { ...identity, kind: 'minimized-wrong-reading', wrongId: wrong.id }, 1)
    }
  }
  assert.equal(canonical([...jobs.values()]), canonical(report.jobs), 'Native programs or witness bindings differ from the frozen registry')
  const expectedRuns = [...jobs.values()].flatMap(job => Array.from({ length: job.repetitions }, (_, index) => job.id + '/' + (index + 1)))
  assert.deepEqual(report.runs.map(row => row.jobId + '/' + row.repeat).sort(), expectedRuns.sort())
  let rejectedPrograms = 0, registeredExecutions = 0, minimizedExecutions = 0
  const previous = new Map()
  for (const row of report.runs) {
    const job = [...jobs.values()].find(job => job.id === row.jobId), grade = await json(resolve(directory, row.gradeFile)), id = row.jobId + '-' + row.repeat
    assert.equal(grade.image, project.spec.environment.leanImage); assert.equal(report.image, grade.image)
    assert.equal(grade.candidateSha256, await sha256(pythonSource(job.code)))
    assert.equal(row.candidateSha256, grade.candidateSha256)
    assert.equal(grade.passed, job.expectedPass); assert.equal(row.passed, grade.passed)
    assert.equal(grade.classification, job.expectedPass ? 'correct' : 'trace-mismatch'); assert.equal(row.classification, grade.classification)
    const run = resolve(directory, grade.directory)
    for (const [file, contents] of Object.entries(operationalCandidateFiles(job.task, pythonSource(job.code), sources))) {
      assert.equal(await readFile(resolve(run, 'algorithm', file), 'utf8'), contents, 'Retained candidate or public environment differs')
    }
    const result = await json(resolve(run, 'results', id + '.json')), events = grade.files.includes(id + '-order-events.json') ? await json(resolve(run, 'results', id + '-order-events.json')) : null
    const actual = nativeObservation(result, events, job.task)
    assert.equal(canonical(actual), canonical(job.candidateTask.expected)); assert.equal(canonical(actual), canonical(grade.trace))
    assert.equal(canonical(actual) === canonical(job.task.expected), job.expectedPass)
    const hash = await sha256(canonical(actual)); assert.equal(row.observationSha256, hash)
    if (previous.has(job.id)) assert.equal(previous.get(job.id), hash); previous.set(job.id, hash)
    if (!job.expectedPass) rejectedPrograms++
    if (job.repetitions === 3) registeredExecutions++; else minimizedExecutions++
  }
  return { status: 'verified', runtimePins: RUNTIME_FILES.length, artifacts: Object.keys(hashes).length,
    targets: project.requirements.targets.length, unregisteredRequirements: project.requirements.unregistered.length,
    nativeJobs: jobs.size, registeredExecutions, minimizedExecutions, totalExecutions: report.runs.length, rejectedPrograms,
    minimizedWitnesses: independent.requirements.targets.reduce((count, target) => count + target.probes.reduce((sum, probe) => sum + probe.wrongReadings.filter(row => row.shrink?.oneMinimal).length, 0), 0),
    projectSha256: project.sha256, registrySha256: project.requirements.sha256, countedStudy: false, personalApproval: false }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Supply retained native requirement evidence')
  console.log(JSON.stringify(await verifyRequirementEvidence(process.argv[2]), null, 2))
}
