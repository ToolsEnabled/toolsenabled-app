// Recheck retained native proof without rerunning containers or trusting logs.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, sha256 } from '../../../src/benchmark/prompts.mjs'
import { readProject } from '../../../src/benchmark/cli.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { nativeObservation, pythonSource } from '../../../src/benchmark/lean-observations.mjs'
import { operationalCandidateFiles, operationalReferenceProgram } from '../../../src/benchmark/trading-study.mjs'
import { verifyAuditReference } from '../../../src/benchmark/audit.mjs'
import { handwrittenOperationalCandidate } from './qualify-research-benchmark-operational-study.mjs'

const json = async path => JSON.parse(await readFile(path, 'utf8'))
export async function verifyOperationalEvidence(directory) {
  directory = resolve(directory)
  const report = await json(resolve(directory, 'qualification.json'))
  assert.equal(report.status, 'qualified'); assert.equal(report.countedStudy, false); assert.equal(report.personalApproval, false)
  assert.equal(report.runs.length, 33); assert.equal(report.repetitions, 3)
  const project = await readProject(resolve(directory, 'project'))
  assert.equal(project.sha256, report.projectSha256)
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  for (const file of RUNTIME_FILES) assert.equal(await sha256(sources[file]), report.runtimeSources[file], 'Current source differs from qualification: ' + file)
  const artifactHashes = await json(resolve(directory, 'artifact-hashes.json'))
  for (const [file, digest] of Object.entries(artifactHashes)) assert.equal(await sha256(await readFile(resolve(directory, file))), digest, 'Retained artifact changed: ' + file)
  const verified = [], byTask = new Map(), controls = new Map()
  const check = async (task, grade, id, code, expected) => {
    const run = resolve(directory, grade.directory), result = await json(resolve(run, 'results', id + '.json'))
    const events = grade.files.includes(id + '-order-events.json') ? await json(resolve(run, 'results', id + '-order-events.json')) : null
    const program = pythonSource(code)
    assert.equal(grade.image, project.spec.environment.leanImage)
    assert.equal(grade.candidateSha256, await sha256(program))
    for (const [file, text] of Object.entries(operationalCandidateFiles(task, program, sources))) assert.equal(await readFile(resolve(run, 'algorithm', file), 'utf8'), text)
    const actual = nativeObservation(result, events, task)
    assert.equal(canonical(actual), canonical(grade.trace))
    assert.equal(canonical(actual) === canonical(task.expected), expected)
    return { task, result, events, actual }
  }
  for (const row of report.runs) {
    const task = project.tasks.find(task => task.id === row.taskId), grade = await json(resolve(directory, row.taskId + '-' + row.repeat + '-grade.json'))
    assert.ok(task); assert.equal(grade.passed, true); assert.equal(grade.classification, 'correct')
    const code = task.id === 'flat-labels' ? handwrittenOperationalCandidate : operationalReferenceProgram(task, sources)
    const checked = await check(task, grade, row.taskId + '-' + row.repeat, code, true)
    const digest = await sha256(canonical(checked.actual)); assert.equal(digest, row.observationSha256)
    if (byTask.has(task.id)) assert.equal(byTask.get(task.id).digest, digest)
    else byTask.set(task.id, { digest, repetitions: [] })
    byTask.get(task.id).repetitions.push(row.repeat); verified.push({ taskId: task.id, repeat: row.repeat, observationSha256: digest })
    if (row.repeat === 1) controls.set(task.id, checked)
  }
  for (const value of byTask.values()) assert.deepEqual(value.repetitions.sort(), [1, 2, 3])
  assert.equal(byTask.size, 11)
  const race = project.tasks.find(task => task.id === 'race-first-fill'), alternative = project.tasks.find(task => task.id === 'race-accepted')
  const wrong = await json(resolve(directory, 'wrong-race-policy-grade.json'))
  assert.equal(wrong.passed, false); assert.equal(wrong.classification, 'trace-mismatch')
  await check(race, wrong, 'wrong-race-policy-1', operationalReferenceProgram(alternative, sources), false)
  let alteredArtifactRefusals = 0
  for (const id of ['flat-labels', 'race-first-fill', 'pending-entry']) {
    const source = controls.get(id)
    const mutations = [
      ({ result }) => { result.state.Status = 'RuntimeError' },
      ({ result }) => { Object.values(result.orders)[0].tag = '["LB-OP-1","root/foreign","lot","entry","order"]' },
      ({ result }) => { Object.values(result.orders)[0].quantity += 1 },
      ({ events }) => events.push(structuredClone(events[0])),
      ({ events }) => { events[0].time += 1 },
      ({ events }) => { events[0].orderFeeAmount = 1 },
      ({ events }) => { events[0].isAssignment = true },
      ({ result }) => { result.totalPerformance.portfolioStatistics.endEquity = '999999999' },
    ]
    for (const mutate of mutations) {
      const copy = structuredClone(source); mutate(copy)
      assert.throws(() => assert.equal(canonical(nativeObservation(copy.result, copy.events, copy.task)), canonical(copy.task.expected)))
      alteredArtifactRefusals++
    }
  }
  const cli = await readProject(resolve(directory, 'cli-project')), evidence = await json(resolve(directory, 'cli-project/results/evidence.json'))
  assert.equal(evidence.projectSha256, cli.sha256); assert.equal(evidence.events.filter(event => event.type === 'started').length, 3)
  assert.equal(evidence.events.filter(event => event.type === 'finished' && event.status === 'completed' && event.grade.passed === true).length, 3)
  const reference = await json(resolve(directory, 'cli-project/results/reference-bundle.json'))
  await verifyAuditReference(reference)
  assert.equal(reference.project.sha256, cli.sha256)
  return { verifiedRuns: verified.length, nativeCliTrials: 3, wrongPolicyRejected: true, nativeAuditReferenceSha256: reference.sha256,
    alteredArtifactRefusals, runtimePins: RUNTIME_FILES.length, artifactFiles: Object.keys(artifactHashes).length, cases: [...byTask.keys()] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Supply retained operational qualification evidence.')
  console.log(JSON.stringify(await verifyOperationalEvidence(process.argv[2]), null, 2))
}
