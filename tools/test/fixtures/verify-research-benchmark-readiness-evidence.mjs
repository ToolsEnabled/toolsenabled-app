#!/usr/bin/env node
// Offline verification only: no collection, qualification, action execution,
// child process, network call or PID probe. Invalid clones exercise validators;
// they are not represented as historical executions or authenticated receipts.
import assert from 'node:assert/strict'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, sha256 } from '../../../src/benchmark/prompts.mjs'
import { readProject } from '../../../src/benchmark/cli.mjs'
import { RUNTIME_FILES, bindRuntimeSources, freezeStudy, analyze, verifyProject } from '../../../src/benchmark/study.mjs'
import { validateJournal, verifyResourceJournal } from '../../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../../src/benchmark/report.mjs'
import { resourcePreparationLedger, RESOURCE_PREPARATION_LIMITS } from '../../../src/benchmark/templates.mjs'
import { evaluateReadiness, assertCollectionAdmission, readinessProjectFiles } from '../../../src/benchmark/readiness.mjs'
import { genericStarter, newExperimentDraft } from '../../../src/benchmark/starters.mjs'
import { collectionRequest } from '../../../src/benchmark/workflow.mjs'
import { resourceTemplateFixture, resourceTemplateControls, resourceTemplateEnvelope, RESOURCE_PRIVATE_SENTINELS } from './research-benchmark-resource-template.mjs'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const same = (actual, expected, label) => assert.ok(canonical(actual) === canonical(expected), label)
const roleNames = ['artifact-drift', 'http-boundary', 'recovery', 'standalone']
async function regularFiles(directory) {
  const files = {}
  const rootInfo = await lstat(directory)
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'The evidence root must be a real directory: ' + directory)
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
  await verifyProject(project)
  const unfinished = validateJournal(project, events)
  assert.equal(unfinished.length, open)
  await verifyResourceJournal(project, events)
  assert.equal(events.filter(row => row.type === 'finished' && row.status === 'completed').length, completed)
  assert.equal(events.filter(row => row.type === 'finished' && row.status === 'failed').length, failed)
  assert.equal(events.filter(row => row.type === 'finished').length, completed + failed)
  assert.equal(events.filter(row => row.type === 'started').length, completed + failed + open)
  const preparations = events.filter(row => row.type === 'template-qualified')
  assert.equal(preparations.length, 1); assert.equal(preparations[0].seq, 2)
  assert.equal(events.filter(row => row.type.startsWith('template-')).length, 2)
  const intent = events[0], terminal = preparations[0]
  assert.equal(intent.type, 'template-preparation-started'); assert.equal(terminal.preparationSeq, intent.seq)
  assert.equal(intent.timeoutMs, Math.min(RESOURCE_PREPARATION_LIMITS.timeoutMs, project.spec.protocol.maxDurationMs))
  assert.equal(intent.reservedMs, intent.timeoutMs); assert.ok(terminal.elapsedMs >= 0)
  assert.equal(terminal.budgetChargeMs, terminal.elapsedMs)
  for (const start of events.filter(row => row.type === 'started')) {
    assert.equal(start.executionPurpose, 'experiment'); assert.equal(start.readinessSha256, project.readiness.sha256)
  }
  const ledger = resourcePreparationLedger(project, events)
  assert.equal(ledger.preparations, 1); assert.equal(ledger.qualified, 1); assert.equal(ledger.legacy, 0); assert.equal(ledger.open, 0)
  assert.equal(ledger.budgetChargeMs, terminal.elapsedMs); assert.equal(ledger.elapsedMs, terminal.elapsedMs)
  same(analyze(project, events).resourcePreparation, ledger, 'Summary must retain the exact preparation derivation.')
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
    fullQualificationProofs: 1, preparationIntents: 1, budgetChargeMs: terminal.budgetChargeMs, fixedControls: 12, selectedCaseControls: 8 }
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
    expectedSpec.conditions[0].collection.contextConstruction = 'frozen-public-request'
    expectedSpec.conditions[0].collection.sessionIsolation = 'fresh-request'
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
    const reports = await verifyReports(project, events, 'experiment')
    result.offlineCounterexamples = await verifyResourceCounterexamples(project, events)
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
    await verifyReports(project, events, 'experiment')
    assert.equal(events.filter(row => row.type === 'resource-prepared').length, 1)
    assert.equal(events.filter(row => row.type === 'resource-intent').length, 1)
    assert.equal(events.filter(row => row.type === 'resource-effect' || row.type === 'resource-closed').length, 0)
    assert.match(receipt.failure, /INJECTED_RESOURCE_JOURNAL_FAILURE/)
    assert.match(receipt.locked, /output directory is locked/)
    assert.match(receipt.recovery, /already has a retained system response.*cannot redraw/)
    assert.ok(Number.isSafeInteger(receipt.owner.pid) && receipt.owner.pid > 0)
    assert.match(receipt.owner.token, /^[a-f0-9-]{36}$/); assert.ok(Number.isFinite(Date.parse(receipt.owner.startedAt)))
    result.journalSha256 = receipt.journalSha256
    result.recoveryScope = 'The initial lock owner is retained in the fault receipt; explicit recovery may remove its stale lock. The retained failure/refusal receipt and unchanged unfinished journal/response are verified; no process is probed and recovery is not rerun.'
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

// CSV is parsed, not split at commas: several scope and proof columns contain
// JSON and quoted multiline diagnostics.
function csvRows(text) {
  const rows = []; let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++ }
      else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(field); field = ''
      if (char === '\n') { rows.push(row); row = [] }
    } else field += char
  }
  assert.equal(quoted, false, 'Report CSV has an unterminated quoted field.')
  assert.equal(field, ''); assert.equal(row.length, 0)
  return rows
}

async function verifyReports(project, events, purpose) {
  const files = await researchReportFiles(project, events), summary = analyze(project, events)
  const execution = JSON.parse(files['execution.json']), manifest = JSON.parse(files['execution-manifest.json'])
  same(execution, summary.execution, 'Exported execution purpose differs from the frozen design.')
  assert.equal(execution.purpose, purpose)
  assert.equal(execution.experimentalCollection, purpose === 'experiment' ? 'requires-validated-admission-and-proofs' : 'not-admitted')
  assert.equal(execution.evidenceClass, purpose === 'experiment' ? 'experiment-attempts' : 'development-computations')
  same(execution.referenceAncestry, [], 'These controls have no reference source to upgrade.')
  same(manifest, { format: 'research-report-execution-scope', version: 1, projectSha256: project.sha256,
    execution, files: Object.keys(files).filter(file => file !== 'execution-manifest.json').sort() }, 'The scope manifest must cover every accompanying report file.')
  same(JSON.parse(files['summary.json']), summary, 'Report summary differs from journal analysis.')
  const analysis = JSON.parse(files['analysis.json'])
  same(analysis.summary, summary); assert.equal(analysis.summarySha256, await sha256(canonical(summary)))
  assert.equal(analysis.journalSha256, await sha256(canonical(events)))
  for (const name of ['report.html', 'report.md', 'figures/disposition.svg']) assert.ok(files[name].includes(execution.computationScope), name + ' omits the computation scope.')
  if (purpose === 'apparatus-development') {
    for (const name of ['report.html', 'report.md']) assert.ok(files[name].includes('Apparatus-development report'))
    assert.match(execution.computationScope, /no scientific inference or admitted experimental collection/)
  }
  for (const [name, text] of Object.entries(files).filter(([name]) => name.endsWith('.csv'))) {
    const [header, ...rows] = csvRows(text)
    const titles = name === 'results.csv' ? ['executionPurpose', 'evidenceClass', 'experimentalCollection', 'referenceExecutionPurposes']
      : ['Execution purpose', 'Evidence class', 'Experimental collection', 'Reference execution purposes']
    // The execution-scope table also displays two of these values as ordinary
    // visible columns. All matching cells must agree; the appended scope tuple
    // has its own fixed position and cannot be replaced by a duplicate label.
    if (name !== 'results.csv') same(header.slice(-4), titles, name + ' has a changed scope suffix.')
    const indices = titles.map(title => { const found = header.flatMap((value, index) => value === title ? [index] : []); assert.ok(found.length, name + ' omits ' + title); return found })
    for (const row of rows) {
      assert.equal(row.length, header.length, name + ' row has a different field count.')
      const expected = [purpose, execution.evidenceClass, execution.experimentalCollection, '[]']
      for (let column = 0; column < indices.length; column++)
        for (const index of indices[column]) assert.equal(row[index], expected[column], name + ' silently changes execution scope.')
    }
  }
  if (summary.resourcePreparation) same(JSON.parse(files['resource-preparation.json']), resourcePreparationLedger(project, events), 'Raw typed preparation summary was decorated or changed.')
  return files
}

async function verifyResourceCounterexamples(project, events) {
  const rejected = []
  const changes = {
    'undercharged-measured-preparation': rows => { rows[1].budgetChargeMs = rows[1].elapsedMs + 1 },
    'forged-recovery-reservation': rows => { rows[0].reservedMs-- },
    'completion-without-matching-intent': rows => { rows[1].preparationSeq = 99 },
    'legacy-receipt-after-modern-intent': rows => { delete rows[1].preparationSeq },
    'missing-preparation-completion': rows => { rows.splice(1, 1) },
    'changed-start-purpose': rows => { rows.find(row => row.type === 'started').executionPurpose = 'apparatus-development' },
    'changed-start-readiness-binding': rows => { rows.find(row => row.type === 'started').readinessSha256 = '0'.repeat(64) },
    'collection-after-budget-exhaustion': rows => { rows[1].elapsedMs = rows[1].budgetChargeMs = project.spec.protocol.maxDurationMs },
    'preparation-after-budget-exhaustion': rows => {
      rows.splice(2); rows[1].elapsedMs = rows[1].budgetChargeMs = project.spec.protocol.maxDurationMs
      rows.push({ ...rows[0], seq: 3, timeoutMs: 1, reservedMs: 1 })
    },
  }
  for (const [name, change] of Object.entries(changes)) {
    const rows = structuredClone(events); change(rows); rows.forEach((row, index) => { row.seq = index + 1 })
    assert.throws(() => validateJournal(project, rows), /preparation|qualification|intent|budget|charge|reservation|readiness|purpose/i, name)
    rejected.push(name)
  }
  // A synthetic retained prefix, derived from the real intent, checks recovery
  // accounting without invoking conformance or asserting a historical crash.
  const intent = structuredClone(events[0]), prefix = [intent]
  same(validateJournal(project, prefix), [])
  const open = resourcePreparationLedger(project, prefix)
  assert.equal(open.open, 1); assert.equal(open.elapsedMs, null); assert.equal(open.budgetChargeMs, intent.reservedMs)
  const interrupted = { type: 'template-preparation-failed', seq: 2, projectSha256: project.sha256,
    at: intent.at, preparationSeq: 1, status: 'interrupted', elapsedMs: null, budgetChargeMs: intent.reservedMs,
    reason: 'Offline validation control: charge a lost preparation reservation without inventing elapsed time.' }
  const recovered = [intent, interrupted]
  same(validateJournal(project, recovered), [])
  const ledger = resourcePreparationLedger(project, recovered)
  assert.equal(ledger.interrupted, 1); assert.equal(ledger.open, 0); assert.equal(ledger.elapsedMs, null)
  assert.equal(ledger.budgetChargeMs, intent.reservedMs); assert.equal(ledger.rows[0].settled, false)
  for (const [name, patch] of [['undercharged-orphan-recovery', { budgetChargeMs: intent.reservedMs - 1 }], ['invented-orphan-elapsed-time', { elapsedMs: 0 }]]) {
    assert.throws(() => validateJournal(project, [intent, { ...interrupted, ...patch }]), /reservation|elapsed/)
    rejected.push(name)
  }
  await verifyReports(project, recovered, 'experiment')
  return { rejected, acceptedAccountingPrefixes: ['open-reservation', 'interrupted-full-reservation'],
    scope: 'Offline validator controls only; no preparation, recovery or collection was executed.' }
}

async function assertSourcePins(project, sources) {
  await verifyProject(project)
  assert.equal(project.spec.schemaVersion, 2)
  same(Object.keys(project.spec.runtimeSources).sort(), [...RUNTIME_FILES].sort())
  for (const file of RUNTIME_FILES) assert.equal(project.spec.runtimeSources[file], await sha256(sources[file]), 'Retained control has stale source: ' + file)
}
async function expectedGeneric(sources, { development = false, jsonGrade = false, wrongKey = false, wrongResponse = false } = {}) {
  const seed = genericStarter(); seed.tasks.length = 1
  if (wrongKey) seed.tasks[0].expected = '999'
  if (wrongKey || wrongResponse) seed.conditions[0].adapter.responses = { 'addition-a': '999' }
  if (jsonGrade) { seed.protocol.grading.kind = 'json'; seed.tasks[0].expected = { answer: 5 } }
  if (!development) seed.analysisPlan.primaryPopulation = 'all'
  const spec = newExperimentDraft(seed, { purpose: development ? 'apparatus-development' : 'experiment' })
  if (development) spec.analysisPlan.cohort = 'qualification'
  return freezeStudy(await bindRuntimeSources(spec, sources))
}

async function verifyReadinessControls(base, sources) {
  const names = (await readdir(base)).sort(), exports = [], controls = []
  const expectedJson = ['immutable-observations.json', 'immutable-project.json', 'report-rejects-project-drift.json', 'wrong-oracle-cli-refusal.json']
  same(names.filter(name => name.endsWith('.json')), expectedJson, 'Retain exactly the four direct/CLI readiness control snapshots.')
  const directoryNames = names.filter(name => !name.endsWith('.json'))
  assert.equal(directoryNames.length, 2)
  for (const role of ['artifact-forgery', 'wrong-oracle']) {
    const matching = directoryNames.filter(name => name.startsWith('readiness-' + role + '-')); assert.equal(matching.length, 1)
    const directory = resolve(base, matching[0]), project = await readProject(directory)
    await assertSourcePins(project, sources)
    same(project, await expectedGeneric(sources, { wrongKey: role === 'wrong-oracle' }), 'Portable readiness design differs from its literal control.')
    const generated = readinessProjectFiles(project)
    for (const [name, text] of Object.entries(generated)) assert.equal(await readFile(resolve(directory, name), 'utf8'), text)
    const result = { role, directory, projectSha256: project.sha256, generatedReadinessArtifacts: Object.keys(generated).length }
    if (role === 'wrong-oracle') {
      const receipt = await json(resolve(base, 'wrong-oracle-cli-refusal.json'))
      assert.equal(receipt.projectSha256, project.sha256)
      same(receipt.readiness, { collect: evaluateReadiness(project, { operation: 'collect' }),
        diagnosticReplay: evaluateReadiness(project, { operation: 'diagnostic-replay' }),
        apparatusDevelopment: evaluateReadiness(project, { operation: 'apparatus-development' }) })
      assert.equal(receipt.readiness.collect.eligible, false)
      assert.ok(receipt.readiness.collect.blockers.some(row => row.code === 'independent-oracle-required'))
      assert.match(receipt.stderr, /independent-oracle|composition/)
      assert.equal(await readFile(resolve(directory, 'results/attempts.jsonl'), 'utf8'), '')
      await assert.rejects(lstat(resolve(directory, 'results/.run-lock')), { code: 'ENOENT' })
      assert.throws(() => assertCollectionAdmission(project, { operation: 'collect' }), /independent-oracle|composition/)
      assert.throws(() => assertCollectionAdmission(project, { operation: 'collect', hostCapabilities: ['independent-oracle'], ready: true }), /unsupported fields/)
      result.retainedStarts = 0; result.retainedQualifications = 0
    } else {
      const forged = structuredClone(project)
      forged.readiness.blockers = []; forged.readiness.scientificBlockers = []
      const { sha256: ignoredReadiness, ...body } = forged.readiness
      forged.readiness.sha256 = await sha256(canonical(body))
      const { sha256: ignoredProject, ...projectBody } = forged
      forged.sha256 = await sha256(canonical(projectBody))
      await assert.rejects(verifyProject(forged), /frozen project changed/)
      assert.equal(evaluateReadiness(forged).eligible, false)
      result.offlineCounterexamples = ['resealed-authored-readiness-claim']
      result.artifactScope = 'Restored exported artifacts are checked by readProject. The separate resealed-project clone is rejected offline; historical disk mutations are not rerun.'
    }
    const hashes = await regularFiles(directory)
    result.retainedFiles = Object.keys(hashes).length; result.retainedFilesSha256 = await sha256(canonical(hashes)); exports.push(result)
  }
  const immutable = await json(resolve(base, 'immutable-project.json'))
  await assertSourcePins(immutable.project, sources)
  same(immutable.project, await expectedGeneric(sources, { development: true }))
  same(validateJournal(immutable.project, immutable.events), [])
  assert.equal(immutable.rejectedMutations, 5)
  same(immutable.summary, analyze(immutable.project, immutable.events))
  assert.equal(immutable.summary.completed, 1); assert.equal(immutable.summary.groups[0].passed, 0)
  const finished = immutable.events.find(row => row.type === 'finished')
  assert.equal(immutable.project.tasks[0].expected, '5'); assert.equal(finished.response.output, '999'); assert.equal(finished.grade.passed, false)
  const immutableReports = await verifyReports(immutable.project, immutable.events, 'apparatus-development')
  controls.push({ id: 'immutable-project', projectSha256: immutable.project.sha256, rejectedMutationReceiptCount: 5, reportFiles: Object.keys(immutableReports).length, passed: 0 })

  const observations = await json(resolve(base, 'immutable-observations.json'))
  await assertSourcePins(observations.project, sources)
  same(observations.project, await expectedGeneric(sources, { development: true, jsonGrade: true }))
  same(validateJournal(observations.project, observations.events), [])
  assert.equal(observations.rejectedMutations, 7)
  const completed = observations.events.find(row => row.type === 'finished')
  same(observations.persisted, { projectSha256: observations.project.sha256, trialId: completed.trialId, attempt: 1, response: completed.response })
  assert.equal(observations.persisted.response.output.answer, 999); assert.equal(completed.grade.passed, false)
  const observationReports = await verifyReports(observations.project, observations.events, 'apparatus-development')
  controls.push({ id: 'immutable-observations', projectSha256: observations.project.sha256, rejectedMutationReceiptCount: 7, reportFiles: Object.keys(observationReports).length, passed: 0 })

  const drift = await json(resolve(base, 'report-rejects-project-drift.json'))
  await assertSourcePins(drift.original, sources)
  same(drift.original, await expectedGeneric(sources, { development: true, wrongResponse: true }))
  same(validateJournal(drift.original, drift.originalEvents), [])
  assert.equal(drift.alteredProject.sha256, drift.original.sha256)
  assert.equal(drift.alteredProject.tasks[0].expected, '999')
  assert.equal(drift.alteredEvents.find(row => row.type === 'finished').grade.passed, true)
  await assert.rejects(verifyProject(drift.alteredProject), /frozen project changed/)
  await assert.rejects(researchReportFiles(drift.alteredProject, drift.alteredEvents), /frozen project changed/)
  const driftReports = await verifyReports(drift.original, drift.originalEvents, 'apparatus-development')
  assert.equal(JSON.parse(driftReports['summary.json']).groups[0].passed, 0)
  controls.push({ id: 'report-project-drift', projectSha256: drift.original.sha256, rejected: true, reportFiles: Object.keys(driftReports).length, passed: 0 })
  return { exports, controls }
}

export async function verifyReadinessEvidence({ readinessEvidence, resourceEvidence, root = APP_ROOT } = {}) {
  root = resolve(root)
  const sources = {}, runtimeSources = {}
  assert.ok(RUNTIME_FILES.includes('readiness.mjs') && RUNTIME_FILES.includes('requirement-fields.mjs'), 'The verifier needs the complete readiness runtime inventory.')
  for (const file of RUNTIME_FILES) {
    sources[file] = await readFile(resolve(root, 'src/benchmark', file), 'utf8')
    runtimeSources[file] = await sha256(sources[file])
    assert.equal(runtimeSources[file], await sha256(await readFile(resolve(APP_ROOT, 'src/benchmark', file))), 'The requested root differs from this verifier runtime: ' + file)
  }
  const readinessBase = resolve(readinessEvidence || resolve(root, '../readiness-portable-final'))
  const resourceBase = resolve(resourceEvidence || resolve(root, '../resource-portable-final'))
  // Validate the entire tree before any runtime reader can follow evidence.
  const readinessHashes = await regularFiles(readinessBase), resourceHashes = await regularFiles(resourceBase)
  const readiness = await verifyReadinessControls(readinessBase, sources)
  const directories = (await readdir(resourceBase, { withFileTypes: true })).filter(row => row.isDirectory()).map(row => resolve(resourceBase, row.name)).sort()
  const roles = directories.map(directory => roleNames.find(role => directory.split(/[\\/]/).at(-1).startsWith('resource-' + role + '-')))
  same([...roles].sort(), [...roleNames].sort(), 'Retain one final resource export for each of the four portable roles.')
  const resources = []
  for (let index = 0; index < directories.length; index++) resources.push(await verifyOne(directories[index], roles[index], sources))
  return { status: 'verified', format: 'readiness-portable-offline-verification', version: 1,
    runtimePins: RUNTIME_FILES.length, runtimeSources, runtimeSourcesSha256: await sha256(canonical(runtimeSources)),
    readiness, resources,
    retainedFiles: Object.keys(readinessHashes).length + Object.keys(resourceHashes).length,
    readinessFilesSha256: await sha256(canonical(readinessHashes)), resourceFilesSha256: await sha256(canonical(resourceHashes)),
    reportFiles: resources.reduce((sum, row) => sum + row.reportFiles, 0),
    generatedDevelopmentReportFiles: readiness.controls.reduce((sum, row) => sum + row.reportFiles, 0),
    experimentsRun: 0, providerCalls: 0, nativeRuns: 0, processProbes: 0,
    scope: 'Final source and generated-artifact bindings; independent hand-computed resource outcomes and retained proof/state validation; exact saved report bytes and frozen experiment/development scope; retained refusal and partial-write receipts; separately identified offline tamper and accounting controls. This verifies consistency, not execution authenticity, historical mutation counts, native or provider execution, scientific validity, personal approval or release readiness.' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {}, args = process.argv.slice(2), keys = { '--readiness-evidence': 'readinessEvidence', '--resource-evidence': 'resourceEvidence', '--root': 'root' }
    for (let index = 0; index < args.length; index += 2) {
      assert.ok(Object.hasOwn(keys, args[index]) && args[index + 1] && !args[index + 1].startsWith('--'),
        'Usage: node verify-research-benchmark-readiness-evidence.mjs [--readiness-evidence DIRECTORY] [--resource-evidence DIRECTORY] [--root APP_ROOT]')
      const key = keys[args[index]]; assert.equal(Object.hasOwn(options, key), false, 'Duplicate option: ' + args[index]); options[key] = args[index + 1]
    }
    process.stdout.write(JSON.stringify(await verifyReadinessEvidence(options), null, 2) + '\n')
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 }
}
