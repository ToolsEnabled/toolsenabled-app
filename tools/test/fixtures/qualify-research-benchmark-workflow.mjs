// Fresh native grading through the portable workflow runner. All generation
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
import { qualifyProject } from '../../../src/benchmark/qualify.mjs'
import { auditReferencePaths, sealAuditReference } from '../../../src/benchmark/audit.mjs'
import { operationalRequirementFixture } from './research-benchmark-requirements.mjs'
import { workflowFixture, workflowEnvelope } from './research-benchmark-workflow.mjs'
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
export async function qualifyNativeWorkflow(directory) {
  directory = resolve(directory); await mkdir(directory, { recursive: false })
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  let spec = await operationalRequirementFixture(); spec.tasks = [spec.tasks[0]]; delete spec.requirementPlan
  const task = spec.tasks[0]
  const wrongTask = structuredClone(task); wrongTask.root.slots.buy_process.params.quantity = 2; wrongTask.expected = await deriveTaskExpected(spec, wrongTask)
  const control = workflowFixture()
  spec.id = 'native-workflow-controls'; spec.name = 'Synthetic staged native LEAN controls'
  spec.protocol = { ...spec.protocol, replicates: 3, maxAttemptsPerTrial: 3, maxTotalAttempts: 18, timeoutMs: 120000, maxDurationMs: 3600000, grading: { kind: 'lean-python', executionTimeoutMs: 60000 } }
  spec.environment.leanImage = QUALIFICATION_IMAGE
  spec.observationPlan = control.observationPlan; spec.workflowPlan = control.workflowPlan
  spec.workflowPlan.workflows[0].rationale = 'Synthetic staged collection into actual native grading. Correct and wrong programs each run in three fresh containers. These are apparatus controls only.'
  spec.conditions = [0, 1].map(index => {
    const condition = structuredClone(control.conditions[0]); condition.id = index ? 'wrong' : 'correct'
    condition.label = index ? 'Wrong quantity program' : 'Reference program'
    condition.adapter.responses = {}
    condition.adapter.workflowResponses = { [task.id]: {
      draft: workflowEnvelope({ answer: 'SYNTHETIC DRAFT: NO EXECUTABLE PROGRAM', revise: true, scratch: 'PRIVATE STAGE NOTE' }, 4),
      revise: workflowEnvelope({ answer: 'PROGRAM BOUND AFTER APPARATUS SOURCE REVIEW' }, 5),
    } }
    return condition
  })
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC NATIVE WORKFLOW APPARATUS ONLY')))
  const correct = await compileTask(spec, task), wrong = await compileTask(spec, wrongTask)
  for (const condition of spec.conditions) condition.adapter.workflowResponses[task.id].revise.output.answer = operationalReferenceProgram(condition.id === 'correct' ? correct : wrong, sources)
  const project = await freezeStudy(spec), root = resolve(directory, 'project')
  for (const [file, content] of Object.entries(await projectFiles(project, sources))) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), content) }
  const independent = await qualifyProject(root, project)
  await writeFile(resolve(directory, 'independent-qualification.json'), json(independent))
  const report = { format: 'workflow-native-qualification', version: 1, status: 'running', projectSha256: project.sha256, runtimeSources: project.spec.runtimeSources,
    image: QUALIFICATION_IMAGE, countedStudy: false, personalApproval: false, controls: { correct, wrong }, runs: [] }
  const persist = () => writeFile(resolve(directory, 'qualification.json'), json(report))
  await persist(); console.log('Executing six frozen native trials through twelve retained workflow stages.')
  try {
    const result = await runProject(root, { output: resolve(directory, 'results') })
    assert.equal(result.summary.completed, 6); assert.equal(result.summary.attempts, 6)
    assert.equal(result.summary.workflows.stages.length, 12)
    const previous = new Map()
    for (const event of result.events.filter(event => event.type === 'finished')) {
      const trial = project.schedule.find(trial => trial.id === event.trialId), expectedPass = trial.conditionId === 'correct', expected = expectedPass ? correct.expected : wrong.expected
      assert.equal(event.grade.passed, expectedPass, event.grade.reason)
      assert.equal(event.grade.classification, expectedPass ? 'correct' : 'trace-mismatch', event.grade.reason)
      assert.equal(event.workflow.selectedStageId, 'revise'); assert.equal(event.workflow.stages.length, 2)
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
    report.status = 'qualified'; await persist()
    await writeFile(resolve(directory, 'artifact-hashes.json'), json(await fileHashes(directory)))
    console.log(json({ status: report.status, nativeExecutions: 6, workflowStages: 12, correct: 3, rejected: 3, projectSha256: project.sha256 }))
  } catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); await persist(); throw error }
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Supply a new evidence directory')
  await qualifyNativeWorkflow(process.argv[2])
}
