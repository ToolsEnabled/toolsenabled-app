// Native witnesses for a frozen synthetic requirement registry. Registered
// cases run three times; minimized diagnostics are separate single-run probes.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, createReviewRecord, sha256 } from '../../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { bindLeanReview } from '../../../src/benchmark/lean-codegen.mjs'
import { projectFiles } from '../../../src/benchmark/export.mjs'
import { compileTask, deriveTaskExpected } from '../../../src/benchmark/tasks.mjs'
import { qualifyProject } from '../../../src/benchmark/qualify.mjs'
import { requirementReportFiles } from '../../../src/benchmark/requirements.mjs'
import { operationalReferenceProgram } from '../../../src/benchmark/trading-study.mjs'
import { gradeLean } from '../../../src/benchmark/lean-grade.mjs'
import { operationalRequirementFixture } from './research-benchmark-requirements.mjs'
import { QUALIFICATION_IMAGE } from './qualify-research-benchmark-lean.mjs'

const sourceRoot = fileURLToPath(new URL('../../../src/benchmark/', import.meta.url))
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

export async function qualifyNativeRequirements(directory) {
  directory = resolve(directory); await mkdir(directory, { recursive: false })
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(resolve(sourceRoot, file), 'utf8')])))
  let spec = await operationalRequirementFixture({ shrink: true })
  spec.protocol = { ...spec.protocol, timeoutMs: 120000, maxDurationMs: 3600000, grading: { kind: 'lean-python', executionTimeoutMs: 60000 } }
  spec.environment.leanImage = QUALIFICATION_IMAGE
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC NATIVE REQUIREMENT APPARATUS ONLY')))
  const project = await freezeStudy(spec), exported = resolve(directory, 'project')
  for (const [file, contents] of Object.entries(await projectFiles(project, sources))) { await mkdir(dirname(resolve(exported, file)), { recursive: true }); await writeFile(resolve(exported, file), contents) }
  const independent = await qualifyProject(exported, project)
  await writeFile(resolve(directory, 'independent-qualification.json'), json(independent))
  assert.equal(independent.requirements.status, 'qualified')
  for (const [file, contents] of Object.entries(requirementReportFiles(independent))) { await mkdir(dirname(resolve(directory, file)), { recursive: true }); await writeFile(resolve(directory, file), contents) }
  const jobs = new Map()
  const add = async (task, candidateTask, witness, repetitions) => {
    const code = operationalReferenceProgram(candidateTask, sources), key = await sha256(canonical({ semantic: task.compiled.semantic, input: task.input, code }))
    if (jobs.has(key)) { jobs.get(key).witnesses.push(witness); jobs.get(key).repetitions = Math.max(jobs.get(key).repetitions, repetitions); return }
    jobs.set(key, { id: 'case-' + (jobs.size + 1), key, task, candidateTask, code, witnesses: [witness], repetitions,
      expectedPass: canonical(task.expected) === canonical(candidateTask.expected) })
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
        source.expected = await deriveTaskExpected(spec, source)
        return compileTask(spec, source)
      }
      const minimized = await compile(probe.reference), minimizedWrong = await compile(wrong.task)
      await add(minimized, minimized, { ...identity, kind: 'minimized-reference', wrongId: wrong.id }, 1)
      await add(minimized, minimizedWrong, { ...identity, kind: 'minimized-wrong-reading', wrongId: wrong.id }, 1)
    }
  }
  const report = { format: 'requirement-native-qualification', version: 1, status: 'running', projectSha256: project.sha256, registrySha256: project.requirements.sha256,
    runtimeSources: project.spec.runtimeSources, image: QUALIFICATION_IMAGE, countedStudy: false, personalApproval: false,
    jobs: [...jobs.values()], runs: [], scope: 'Three fresh native observations per registered reference/wrong-reading program. Minimized diagnostic cases are single native probes and do not replace registered cases.' }
  const persist = () => writeFile(resolve(directory, 'qualification.json'), json(report))
  await persist()
  try {
    for (const job of jobs.values()) {
      let previous
      for (let repeat = 1; repeat <= job.repetitions; repeat++) {
        console.log(job.id + ': fresh native ' + repeat + '/' + job.repetitions + ' ' + job.witnesses.map(row => row.kind + '/' + row.targetId).join(', '))
        const grade = await gradeLean(project, job.task, job.code, { root: exported, artifacts: resolve(directory, 'artifacts'), trial: { id: job.id }, attempt: repeat, signal: new AbortController().signal })
        const gradeFile = job.id + '-' + repeat + '-grade.json'; await writeFile(resolve(directory, gradeFile), json(grade))
        assert.equal(grade.passed, job.expectedPass, grade.reason)
        assert.equal(grade.classification, job.expectedPass ? 'correct' : 'trace-mismatch', grade.reason)
        assert.equal(canonical(grade.trace), canonical(job.candidateTask.expected), 'Native observations differ from the independently qualified reading')
        const observationSha256 = await sha256(canonical(grade.trace))
        if (previous) assert.equal(previous, observationSha256, 'Fresh native repetitions disagree'); previous = observationSha256
        report.runs.push({ jobId: job.id, repeat, gradeFile, passed: grade.passed, classification: grade.classification, observationSha256, candidateSha256: grade.candidateSha256 })
        await persist()
      }
    }
    for (const file of RUNTIME_FILES) assert.equal(await sha256(await readFile(resolve(sourceRoot, file))), project.spec.runtimeSources[file], 'Source changed during qualification: ' + file)
    report.status = 'qualified'
  } catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); await persist(); throw error }
  await persist()
  await writeFile(resolve(directory, 'artifact-hashes.json'), json(await fileHashes(directory)))
  console.log(json({ status: report.status, jobs: report.jobs.length, executions: report.runs.length, projectSha256: project.sha256, registrySha256: project.requirements.sha256 }))
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Supply a new native evidence directory')
  await qualifyNativeRequirements(process.argv[2])
}
