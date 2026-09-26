#!/usr/bin/env node
// Offline verification only: no runStudy, resource executor, adapter, child
// process or network call. Design regeneration and retained-state checks do
// not rerun the experiments or authenticate the original execution.
import assert from 'node:assert/strict'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, sha256 } from '../../../src/benchmark/prompts.mjs'
import { readProject } from '../../../src/benchmark/cli.mjs'
import { RUNTIME_FILES, bindRuntimeSources, freezeStudy, analyze } from '../../../src/benchmark/study.mjs'
import { validateJournal, verifyResourceJournal } from '../../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../../src/benchmark/report.mjs'
import { collectionRequest } from '../../../src/benchmark/workflow.mjs'
import { resourceTemplateFixture, resourceTemplateControls, resourceTemplateEnvelope, RESOURCE_PRIVATE_SENTINELS } from './research-benchmark-resource-template.mjs'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const same = (actual, expected, label) => assert.ok(canonical(actual) === canonical(expected), label)
const roleNames = ['artifact-drift', 'http-boundary', 'recovery', 'standalone']
async function regularFiles(directory) {
  const files = {}
  async function walk(folder) {
    for (const name of (await readdir(folder)).sort()) {
      const path = resolve(folder, name), info = await lstat(path)
      assert.equal(info.isSymbolicLink(), false, 'Evidence cannot use symbolic links: ' + path)
      if (info.isDirectory()) await walk(path)
      else {
        assert.ok(info.isFile(), 'Evidence must contain regular files: ' + path)
        files[relative(directory, path).replaceAll('\\', '/')] = await sha256(await readFile(path))
      }
    }
  }
  await walk(directory)
  return files
}
async function readJournal(directory) {
  const bytes = await readFile(resolve(directory, 'results/attempts.jsonl'), 'utf8')
  assert.ok(bytes.endsWith('\n'), 'The retained journal needs its complete final newline.')
  return { bytes, events: bytes.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}
function trialContext(project, trialId) {
  const trial = project.schedule.find(row => row.id === trialId)
  assert.ok(trial, 'Evidence names an unscheduled trial: ' + trialId)
  return { trial, task: project.tasks.find(row => row.id === trial.taskId), condition: project.spec.conditions.find(row => row.id === trial.conditionId) }
}
function handControl(taskId, conditionId) {
  assert.ok(['target-only', 'collateral'].includes(conditionId))
  return resourceTemplateControls(taskId).find(row => row.id === (conditionId === 'target-only' ? 'goal-only' : 'goal-plus-collateral'))
}
function verifyPublicRequest(project, bytes) {
  const request = JSON.parse(bytes), { trial, task, condition } = trialContext(project, request.trial.id)
  assert.equal(bytes, canonical(collectionRequest(project, condition, task, trial, 1)), 'Public request bytes changed.')
  same(Object.keys(request).sort(), ['attempt', 'collection', 'input', 'model', 'projectSha256', 'prompt', 'trial', 'version'])
  for (const value of [...Object.values(RESOURCE_PRIVATE_SENTINELS), 'private-sentinel', 'referencePlan', 'referenceObservation', 'initialSnapshot', 'runtimeSources']) {
    assert.equal(bytes.includes(value), false, 'A private field reached the collection request: ' + value)
  }
  assert.ok(request.prompt.includes(canonical(request.input.actionContract)))
  assert.ok(request.prompt.includes(canonical(request.input.limits)))
  return request
}
async function verifyEvents(project, events, { completed, open = 0, failed = 0 }) {
  const unfinished = validateJournal(project, events)
  assert.equal(unfinished.length, open)
  await verifyResourceJournal(project, events)
  assert.equal(events.filter(row => row.type === 'finished' && row.status === 'completed').length, completed)
  assert.equal(events.filter(row => row.type === 'finished' && row.status === 'failed').length, failed)
  assert.equal(events.filter(row => row.type === 'finished').length, completed + failed)
  assert.equal(events.filter(row => row.type === 'started').length, completed + failed + open)
  const preparations = events.filter(row => row.type === 'template-qualified')
  assert.equal(preparations.length, 1); assert.equal(preparations[0].seq, 1)
  assert.equal(events.filter(row => row.type.startsWith('template-')).length, 1)
  const proof = preparations[0].record
  assert.equal(proof.controls.length, 12); assert.equal(proof.cases.length, 2)
  // These expected observations are authored in the separate hand fixture,
  // not calculated by the executor or read from the generated task oracle.
  const expectedControlIds = { reference: 'goal-only', 'no-op': 'empty-plan', collateral: 'goal-plus-collateral', repair: 'transient-repair' }
  for (const row of proof.cases) {
    assert.equal(row.controls.length, 4)
    for (const control of row.controls) {
      assert.equal(control.disposition, 'executed')
      const expected = resourceTemplateControls(row.caseId).find(item => item.id === expectedControlIds[control.id])
      assert.ok(expected, 'Unexpected selected-case preflight control.')
      same(control.grade, expected.expectedGrade, 'Selected-case control differs from the independent hand expectation.')
    }
  }
  for (const event of events.filter(row => row.type === 'resource-prepared')) {
    const { task, condition } = trialContext(project, event.trialId)
    same(event.snapshot, task.resource.initialSnapshot, 'A resource episode did not start from its exact fresh fixture.')
    same(event.output, handControl(task.id, condition.id).response, 'Retained raw plan differs from the hand fixture.')
  }
  for (const event of events.filter(row => row.type === 'finished' && row.status === 'completed')) {
    const { task, condition } = trialContext(project, event.trialId), expected = handControl(task.id, condition.id)
    same(event.response.output, expected.response, 'Candidate output differs from its saved hand control.')
    same(event.grade, expected.expectedGrade, 'A completed outcome differs from its independent hand expectation.')
    const { http, ...envelope } = event.response
    same(envelope, resourceTemplateEnvelope(expected.response), 'Retained response metadata changed.')
    if (condition.adapter.kind === 'http') {
      assert.equal(http.status, 200); assert.equal(http.body, canonical(envelope))
    } else assert.equal(http, undefined)
  }
  return { journalEvents: events.length, completedEpisodes: completed, openEpisodes: open, failedEpisodes: failed,
    fullQualificationProofs: 1, fixedControls: 12, selectedCaseControls: 8 }
}
async function verifyResponseFiles(directory, project, events) {
  const starts = events.filter(row => row.type === 'started'), names = (await readdir(resolve(directory, 'results/responses'))).sort()
  same(names, starts.map(row => row.trialId + '-' + row.attempt + '.json').sort(), 'Response files differ from the started-attempt ledger.')
  for (const start of starts) {
    const response = await json(resolve(directory, 'results/responses', start.trialId + '-' + start.attempt + '.json'))
    const { task, condition } = trialContext(project, start.trialId)
    same(response, { projectSha256: project.sha256, trialId: start.trialId, attempt: 1,
      response: resourceTemplateEnvelope(handControl(task.id, condition.id).response) }, 'A durable response changed.')
    const finished = events.find(row => row.type === 'finished' && row.trialId === start.trialId)
    if (finished) same(response.response, finished.response, 'The response file and journal disagree.')
  }
  return names
}
async function verifyOne(directory, role, sources) {
  const project = await readProject(directory)
  same(Object.keys(project.spec.runtimeSources).sort(), [...RUNTIME_FILES].sort(), 'The frozen project needs exactly the final runtime source set.')
  for (const file of RUNTIME_FILES) assert.equal(project.spec.runtimeSources[file], await sha256(sources[file]), 'Export has stale runtime source: ' + file)
  // Recompile the investigator fields only; no action plan or adapter runs.
  const expectedSpec = await resourceTemplateFixture()
  if (role === 'http-boundary') {
    expectedSpec.conditions = [expectedSpec.conditions[0]]
    expectedSpec.conditions[0].adapter = { kind: 'http', url: 'https://fixture.invalid/resource' }
    expectedSpec.conditions[0].collection.comparisonUnit = 'model'
    expectedSpec.protocol.replicates = 1; expectedSpec.analysisPlan.contrasts = []
  }
  const expectedProject = await freezeStudy(await bindRuntimeSources(expectedSpec, sources))
  assert.equal(project.sha256, expectedProject.sha256, 'Retained experiment differs from the exact hand fixture design.')
  const result = { role, directory, projectSha256: project.sha256, runtimePins: RUNTIME_FILES.length, reportFiles: 0 }
  if (role === 'standalone') {
    const { bytes, events } = await readJournal(directory), evidence = await json(resolve(directory, 'results/evidence.json'))
    assert.equal(evidence.projectSha256, project.sha256); same(evidence.events, events, 'Evidence and canonical journal disagree.')
    Object.assign(result, await verifyEvents(project, events, { completed: 8 }))
    assert.equal((await verifyResponseFiles(directory, project, events)).length, 8)
    const summary = analyze(project, events)
    same(evidence.summary, summary, 'Evidence summary differs from complete journal reanalysis.')
    assert.equal(summary.primaryPopulation.scheduled, 4); same(summary.groups.map(row => row.primaryRate), [1, 0])
    const reports = await researchReportFiles(project, events)
    for (const [file, expected] of Object.entries(reports)) assert.ok(await readFile(resolve(directory, 'results', file), 'utf8') === expected, 'Exact report bytes differ: ' + file)
    for (const trial of project.schedule) {
      const { task, condition } = trialContext(project, trial.id)
      verifyPublicRequest(project, canonical(collectionRequest(project, condition, task, trial, 1)))
    }
    result.reportFiles = Object.keys(reports).length; result.journalSha256 = await sha256(bytes)
  } else if (role === 'recovery') {
    const { bytes, events } = await readJournal(directory), receipt = await json(resolve(directory, 'injected-failure-receipt.json'))
    Object.assign(result, await verifyEvents(project, events, { completed: 0, open: 1 }))
    const names = await verifyResponseFiles(directory, project, events)
    same(names, receipt.responseFiles, 'Recovery receipt names a different retained response.')
    assert.equal(receipt.journalSha256, await sha256(bytes)); assert.equal(names.length, 1)
    assert.equal(events.filter(row => row.type === 'resource-prepared').length, 1)
    assert.equal(events.filter(row => row.type === 'resource-intent').length, 1)
    assert.equal(events.filter(row => row.type === 'resource-effect' || row.type === 'resource-closed').length, 0)
    assert.match(receipt.failure, /INJECTED_RESOURCE_JOURNAL_FAILURE/)
    assert.match(receipt.locked, /output directory is locked/)
    assert.match(receipt.recovery, /already has a retained system response.*cannot redraw/)
    assert.ok(Number.isSafeInteger(receipt.owner.pid) && receipt.owner.pid > 0)
    assert.match(receipt.owner.token, /^[a-f0-9-]{36}$/); assert.ok(Number.isFinite(Date.parse(receipt.owner.startedAt)))
    result.journalSha256 = receipt.journalSha256
    result.recoveryScope = 'Retained fault receipt and unchanged unfinished evidence verified; no process is probed and recovery is not rerun.'
  } else if (role === 'http-boundary') {
    const success = await json(resolve(directory, 'stub-http-success-evidence.json')), overflow = await json(resolve(directory, 'stub-http-overflow-evidence.json'))
    Object.assign(result, await verifyEvents(project, success.events, { completed: 2 }))
    assert.equal(success.requests.length, 2)
    same(success.requests.map(bytes => verifyPublicRequest(project, bytes).trial.id).sort(), project.schedule.map(row => row.id).sort(), 'HTTP requests differ from the exact trial schedule.')
    const overflowCounts = await verifyEvents(project, overflow.events, { completed: 0, failed: 1 })
    const bodyLimit = Math.floor((project.experimentTemplate.limits.maxResponseBytes - 512) / 3)
    assert.equal(overflow.bodyLimit, bodyLimit); assert.equal(overflow.consumedChunks, 2)
    assert.equal(overflow.events.filter(row => row.type.startsWith('resource-')).length, 0)
    const finished = overflow.events.find(row => row.type === 'finished'), receipt = finished.response.http || finished.response
    assert.equal(finished.phase, 'transport'); assert.equal(finished.status, 'failed')
    assert.equal(receipt.incomplete, true); assert.equal(receipt.reason, 'response-byte-limit'); assert.equal(receipt.status, 200)
    assert.equal(receipt.retainedBodyLimit, bodyLimit); assert.equal(Buffer.byteLength(receipt.body), bodyLimit)
    assert.ok(receipt.receivedBytesAtLeast > bodyLimit)
    assert.ok(Buffer.byteLength(canonical(finished.response)) <= project.experimentTemplate.limits.maxResponseBytes)
    const { task } = trialContext(project, finished.trialId)
    same(JSON.parse(receipt.body), resourceTemplateEnvelope(handControl(task.id, 'target-only').response), 'Overflow prefix lost or changed the parseable saved response.')
    result.overflow = overflowCounts; result.publicRequests = 2; result.diagnosticPrefixBytes = bodyLimit
    result.collectionScope = 'Retained stubbed-fetch transport evidence only; no provider request is made or inferred.'
  } else {
    // Tests restored these files after each rehashed mutation/omission. Offline
    // readProject verifies the restored artifacts; it does not rerun mutations.
    assert.equal(role, 'artifact-drift')
    const manifest = await json(resolve(directory, 'manifest.json'))
    result.generatedArtifacts = Object.keys(manifest.files).filter(file => file.startsWith('templates/')).length
    assert.equal(result.generatedArtifacts, 10)
  }
  const retainedFiles = await regularFiles(directory)
  result.retainedFiles = Object.keys(retainedFiles).length
  result.retainedFilesSha256 = await sha256(canonical(retainedFiles))
  return result
}

export async function verifyResourceEvidence({ evidence, project: selectedProject, root = APP_ROOT } = {}) {
  root = resolve(root)
  assert.ok(!(evidence && selectedProject), 'Choose --evidence or --project, not both.')
  assert.equal(RUNTIME_FILES.length, 43, 'This verifier qualifies the exact 43-file resource runtime.')
  const sources = {}
  for (const file of RUNTIME_FILES) {
    sources[file] = await readFile(resolve(root, 'src/benchmark', file), 'utf8')
    assert.equal(await sha256(sources[file]), await sha256(await readFile(resolve(APP_ROOT, 'src/benchmark', file))), 'The requested root differs from the verifier runtime: ' + file)
  }
  const base = resolve(evidence || resolve(root, '../resource-portable-final'))
  const directories = selectedProject ? [resolve(selectedProject)] : (await readdir(base, { withFileTypes: true })).filter(row => row.isDirectory()).map(row => resolve(base, row.name)).sort()
  const roles = directories.map(directory => roleNames.find(role => directory.split(/[\\/]/).at(-1).startsWith('resource-' + role + '-')))
  assert.ok(roles.every(Boolean), 'Evidence contains an unrecognized portable test export.')
  assert.equal(new Set(roles).size, roles.length, 'Select one final export for each portable test role.')
  if (!selectedProject) same([...roles].sort(), [...roleNames].sort(), 'The complete evidence set needs all four portable test exports.')
  const results = []
  for (let index = 0; index < directories.length; index++) results.push(await verifyOne(directories[index], roles[index], sources))
  const runtimeSources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await sha256(sources[file])])))
  return { status: 'verified', format: 'resource-portable-offline-verification', version: 1, runtimePins: 43,
    runtimeSources, runtimeSourcesSha256: await sha256(canonical(runtimeSources)), exports: results,
    retainedFiles: results.reduce((sum, row) => sum + row.retainedFiles, 0), reportFiles: results.reduce((sum, row) => sum + row.reportFiles, 0),
    experimentsRun: 0, providerCalls: 0, nativeRuns: 0,
    scope: 'Exact source/artifact bindings, independent retained-state proof validation, separate hand-computed fixture outcomes and report bytes. This does not authenticate execution, repeat fault injection or reestablish historical before/after filesystem comparisons.' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {}, args = process.argv.slice(2)
    for (let index = 0; index < args.length; index += 2) {
      assert.ok(['--evidence', '--project', '--root'].includes(args[index]) && args[index + 1] && !args[index + 1].startsWith('--'),
        'Usage: node verify-research-benchmark-resource-evidence.mjs [--evidence DIRECTORY | --project EXPORT] [--root APP_ROOT]')
      const key = args[index].slice(2); assert.equal(Object.hasOwn(options, key), false, 'Duplicate option: ' + args[index]); options[key] = args[index + 1]
    }
    process.stdout.write(JSON.stringify(await verifyResourceEvidence(options), null, 2) + '\n')
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 }
}
