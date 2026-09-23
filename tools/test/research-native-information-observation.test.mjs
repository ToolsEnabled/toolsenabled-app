import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonical, createReviewRecord, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { operationalStarter } from '../../src/benchmark/trading-catalog.mjs'
import { operationalCandidateFiles } from '../../src/benchmark/trading-study.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { compileTask, deriveTaskExpected } from '../../src/benchmark/tasks.mjs'
import { createTaskReviewRecord, decodeInformationResponse, gradeInterpretations, informationDisposition } from '../../src/benchmark/information.mjs'
import { leanConfig, nativeObservation } from '../../src/benchmark/lean-observations.mjs'
import { replayAdapter, runStudy, validateJournal } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { pageReportOptions } from './fixtures/research-page-report-options.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { sealAuditReference } from '../../src/benchmark/audit.mjs'
import { evaluateReadiness } from '../../src/benchmark/readiness.mjs'
import { developmentDraft } from './fixtures/research-benchmark-development.mjs'
import { leanInformationFixture } from './fixtures/research-benchmark-information.mjs'

// Saved apparatus controls only. Source/image/execution metadata below are
// synthetic and are never evidence that native LEAN or a provider executed.
const reviewer = 'SYNTHETIC NATIVE INFORMATION PROFILE TEST; NO INVESTIGATOR APPROVAL'
const at = '2026-09-09T00:00:00.000Z'
const code = '# SYNTHETIC SAVED SOURCE; NEVER EXECUTED IN LEAN'
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const evidenceRoot = process.env.RESEARCH_NATIVE_INFORMATION_EVIDENCE
async function retain(path, value) {
  if (!evidenceRoot) return
  const target = resolve(evidenceRoot, path); await mkdir(dirname(target), { recursive: true })
  await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
}
async function reviewed(source, { legacy = false } = {}) {
  let spec = legacy ? source : developmentDraft(source)
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, reviewer, { at })))
  const compiled = await compileTask(spec, spec.tasks[0], { requireTaskReview: false })
  spec.taskReviews = [await createTaskReviewRecord(compiled, reviewer, at)]
  return freezeStudy(spec)
}
function nativeSettings(spec) {
  spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 30000 }
  spec.protocol.maxTotalAttempts = 1; spec.protocol.maxAttemptsPerTrial = 1; spec.protocol.replicates = 1
  spec.environment.leanImage = 'synthetic-unavailable-image@sha256:' + 'a'.repeat(64)
  spec.conditions = [{ id: 'saved-control', adapter: { kind: 'replay', responses: { [spec.tasks[0].id]: code } } }]
  return spec
}
async function operationalSpec() {
  const spec = nativeSettings(await operationalStarter()), task = spec.tasks[0], stack = [task.root]
  while (stack.length) {
    const node = stack.pop()
    if (node.use === 'op-above') node.params = { ...(node.params || {}), threshold: 99999999 }
    stack.push(...Object.values(node.slots || {}))
  }
  task.expected = await deriveTaskExpected(spec, task); task.familyId = 'quiet-operational-readings'
  task.information = { version: 1, scope: 'declared-set', responseMode: 'raw',
    rationale: 'Synthetic inactive readings share one quiet observation. This is a representation control, not native qualification.',
    withheldPaths: ['root/child1/buy_process'], readings: [2, 3].map(quantity => {
      const root = structuredClone(task.root)
      root.slots.child1.slots.buy_process.params = { ...(root.slots.child1.slots.buy_process.params || {}), quantity }
      return { id: 'quantity-' + quantity, rationale: 'Synthetic inactive quantity ' + quantity + '.', root }
    }) }
  return spec
}
async function gradeFor(project, trace) {
  const id = project.schedule[0].id + '-1'
  return { ...gradeInterpretations(project.tasks[0], trace, 'json'), trace,
    directory: 'artifacts/' + id, files: [id + '.json'], image: project.spec.environment.leanImage,
    candidateSha256: await sha256(code), execution: { exitCode: 0, signal: null, stdout: 'SYNTHETIC PROCESS RECORD; NO NATIVE RUN', stderr: '' } }
}
let operationalRun
async function operational() {
  if (!operationalRun) operationalRun = (async () => {
    const project = await reviewed(await operationalSpec()), task = project.tasks[0]
    const raw = { state: { Status: 'Completed' }, orders: {}, algorithmConfiguration: { accountCurrency: 'USD' },
      totalPerformance: { portfolioStatistics: { startEquity: '1500', endEquity: '1500' } } }
    const trace = nativeObservation(raw, null, task), grade = await gradeFor(project, trace)
    assert.deepEqual(trace, task.expected); assert.equal(task.compiled.nodeCount, 17)
    assert.equal(task.informationPacket.observableClasses.length, 1)
    let gradeCalls = 0
    const run = await runStudy(project, { adapter: replayAdapter, grade: async () => { gradeCalls++; return grade } })
    assert.equal(gradeCalls, 1)
    return { project, task, raw, trace, grade, run }
  })()
  return operationalRun
}
const completion = events => events.find(event => event.type === 'finished')
const changedEvents = (events, update) => { const copy = structuredClone(events); update(completion(copy)); return copy }

test('a canonical operational information object survives completion, journal, report and completed resume without new grading', async () => {
  const { project, grade, raw, run } = await operational()
  assert.equal(grade.trace.format, 'lean-operational-observation'); assert.equal(grade.trace.version, 1)
  assert.deepEqual(grade.matchingReadings, ['quantity-2', 'quantity-3'])
  assert.equal(completion(run.events).status, 'completed'); assert.equal(run.summary.completed, 1)
  assert.deepEqual(validateJournal(project, run.events), [])
  const report = await researchReportFiles(project, run.events), analysis = JSON.parse(report['analysis.json'])
  assert.equal(analysis.summary.completed, 1); assert.equal(analysis.summary.groups[0].passed, 1)
  assert.equal(analysis.summary.execution.purpose, 'apparatus-development')
  assert.equal(analysis.summary.execution.experimentalCollection, 'not-admitted')
  const eventsBefore = canonical(run.events); let resumeGrades = 0, writes = 0
  const resumed = await runStudy(project, { events: run.events, adapter: replayAdapter,
    grade: async () => { resumeGrades++; throw new Error('Completed resume must not grade again.') }, append: async () => { writes++ } })
  assert.equal(resumeGrades, 0); assert.equal(writes, 0); assert.equal(canonical(resumed.events), eventsBefore)
  assert.deepEqual(resumed.summary, run.summary)
  await retain('operational/project.json', project); await retain('operational/events.json', run.events)
  await retain('operational/raw-synthetic-result.json', raw); await retain('operational/grade.json', grade)
  await retain('operational/summary.json', run.summary)
  for (const [file, text] of Object.entries(report)) await retain('operational/report/' + file, text)
})

test('the exported standalone CLI analyzes that same retained object journal with exact shared-report parity and no journal change', async t => {
  const { project, run } = await operational(), portable = await projectFiles(project, sources)
  const directory = evidenceRoot ? resolve(evidenceRoot, 'operational/portable') : await mkdtemp(resolve(tmpdir(), 'native-information-cli-'))
  if (!evidenceRoot) t.after(() => rm(directory, { recursive: true, force: true }))
  for (const [file, text] of Object.entries(portable)) { const target = resolve(directory, file); await mkdir(dirname(target), { recursive: true }); await writeFile(target, text) }
  const journal = canonical(run.events[0]) + '\n' + run.events.slice(1).map(canonical).join('\n') + '\n'
  await mkdir(resolve(directory, 'results'), { recursive: true }); await writeFile(resolve(directory, 'results/attempts.jsonl'), journal)
  const checked = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), 'analyze'], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(checked.status, 0, checked.stderr || checked.error?.message)
  const summary = JSON.parse(checked.stdout)
  assert.equal(summary.completed, 1); assert.equal(summary.execution.experimentalCollection, 'not-admitted')
  assert.equal(await readFile(resolve(directory, 'results/attempts.jsonl'), 'utf8'), journal)
  const expected = await researchReportFiles(project, run.events, await pageReportOptions({ project, sources })), parity = []
  for (const [file, text] of Object.entries(expected)) {
    const actual = await readFile(resolve(directory, 'results', file), 'utf8'); assert.equal(actual, text, file)
    parity.push({ file, sha256: await sha256(actual) })
  }
  await retain('operational/cli-analysis.json', { exitCode: checked.status, stdout: checked.stdout, stderr: checked.stderr, parity })
})

test('synchronous fill-array information grades retain modern completion and legacy frozen-journal compatibility', async () => {
  const source = nativeSettings(leanInformationFixture()), project = await reviewed(source), task = project.tasks[0]
  const trace = task.interpretations[0].expected
  assert.ok(Array.isArray(trace)); assert.deepEqual(trace.map(fill => fill.quantity), [1, -1])
  const grade = await gradeFor(project, trace)
  const run = await runStudy(project, { adapter: replayAdapter, grade: async () => grade })
  assert.deepEqual(validateJournal(project, run.events), []); assert.equal(run.summary.groups[0].passed, 1)
  await researchReportFiles(project, run.events)
  let newGrades = 0
  await runStudy(project, { events: run.events, adapter: replayAdapter, grade: async () => { newGrades++; return grade } })
  assert.equal(newGrades, 0)
  // Explicit synthetic legacy records; no new legacy custom execution is dispatched.
  const legacy = await reviewed(nativeSettings(leanInformationFixture()), { legacy: true })
  assert.equal(legacy.version, 1); assert.equal(legacy.tasks[0].informationPacket.version, 1)
  const legacyGrade = await gradeFor(legacy, legacy.tasks[0].interpretations[0].expected)
  const events = run.events.map(row => {
    const next = { ...structuredClone(row), projectSha256: legacy.sha256, trialId: legacy.schedule[0].id }
    delete next.readinessSha256; delete next.executionPurpose
    if (next.type === 'finished') next.grade = legacyGrade
    return next
  })
  assert.deepEqual(validateJournal(legacy, events), [])
  const report = await researchReportFiles(legacy, events)
  assert.equal(JSON.parse(report['analysis.json']).summary.execution.purpose, 'legacy')
  await retain('synchronous/project.json', project); await retain('synchronous/events.json', run.events)
  await retain('synchronous/legacy-project.json', legacy); await retain('synchronous/legacy-events.json', events)
})

test('wrong-profile and malformed trace markers cannot pass validation or hide behind an explicit execution failure', async () => {
  const { project, task, run } = await operational(), rejected = []
  for (const [name, trace] of [['array', []], ['null', null], ['number', 0], ['string', 'trace'], ['missing-marker', {}],
    ['wrong-version', { format: 'lean-operational-observation', version: 2 }], ['wrong-format', { format: 'other-observation', version: 1 }]]) {
    const events = changedEvents(run.events, event => { event.grade = { ...event.grade, ...gradeInterpretations(task, trace, 'json'), trace } })
    assert.throws(() => validateJournal(project, events), /wrong observation profile/, name)
    await assert.rejects(researchReportFiles(project, events), /wrong observation profile/, name)
    const hidden = changedEvents(events, event => { event.grade = { passed: false, score: 0, classification: 'execution-error', trace } })
    assert.throws(() => validateJournal(project, hidden), /wrong observation profile/, name + ' cannot use failure fallback')
    rejected.push({ name, events, hidden })
  }
  const sync = await reviewed(nativeSettings(leanInformationFixture())), syncGrade = await gradeFor(sync, project.tasks[0].expected)
  const crossed = run.events.map(row => {
    const next = { ...structuredClone(row), projectSha256: sync.sha256, trialId: sync.schedule[0].id }
    if (next.type === 'started') {
      next.readinessSha256 = sync.readiness.sha256; next.executionPurpose = sync.spec.executionPlan.purpose
      next.promptSha256 = sync.tasks[0].compiled.promptSha256
    }
    if (next.type === 'finished') next.grade = syncGrade
    return next
  })
  assert.throws(() => validateJournal(sync, crossed), /wrong observation profile/)
  await retain('negative/profile-refusals.json', { rejected, synchronousObject: crossed })
})

test('complete interpretation-grade attribution is rederived from a profile-matching observation', async () => {
  const { project, run } = await operational(), rejected = []
  for (const [name, mutate] of [
    ['score', grade => { grade.score = 0 }], ['classification', grade => { grade.classification = 'correct' }],
    ['behavior', grade => { grade.behavior = 'refusal' }], ['scope', grade => { grade.interpretationScope = 'all-possible-meanings' }],
    ['subset-reading', grade => { grade.matchingReadings = ['quantity-2'] }],
    ['passed', grade => { grade.passed = false; grade.score = 0; grade.matchingReadings = [] }],
  ]) {
    const events = changedEvents(run.events, event => mutate(event.grade))
    assert.throws(() => validateJournal(project, events), /interpretation grade disagrees|complete observable class|matched observable class/, name)
    await assert.rejects(researchReportFiles(project, events), /interpretation grade disagrees|complete observable class|matched observable class/, name)
    rejected.push({ name, events })
  }
  await retain('negative/grade-refusals.json', rejected)
})

test('explicit absent-trace failures and tagged clarification/refusal keep their existing distinct outcomes', async () => {
  const { project, run } = await operational(), failures = []
  for (const classification of ['no-program', 'format-violation', 'execution-timeout', 'execution-error', 'invalid-engine-result']) {
    const events = changedEvents(run.events, event => {
      event.grade = { passed: false, score: 0, classification }
      if (classification === 'no-program') event.response.output = null
      if (classification === 'format-violation') event.response.output = 'Here is the algorithm.\n```python\nprint(1)\n```'
    })
    assert.deepEqual(validateJournal(project, events), [])
    const report = await researchReportFiles(project, events), summary = JSON.parse(report['analysis.json']).summary
    assert.equal(summary.completed, 1); assert.equal(summary.groups[0].passed, 0)
    failures.push({ classification, events })
  }
  const spec = await operationalSpec(); spec.tasks[0].information.responseMode = 'tagged-json'
  const outputs = [['question', { kind: 'clarification', message: 'Which quantity?' }], ['refusal', { kind: 'refusal', message: 'I decline.' }],
    ['malformed', { kind: 'clarification', message: 'Which?', answer: 2 }]]
  spec.conditions = outputs.map(([id, output]) => ({ id, adapter: { kind: 'replay', responses: { [spec.tasks[0].id]: output } } }))
  spec.protocol.maxTotalAttempts = 3
  const tagged = await reviewed(spec)
  const result = await runStudy(tagged, { adapter: replayAdapter, grade: async (_project, task, output) => informationDisposition(decodeInformationResponse(task, output)) })
  assert.deepEqual(validateJournal(tagged, result.events), [])
  assert.deepEqual(Object.fromEntries(result.summary.rows.map(row => [row.conditionId, row.disposition])),
    { question: 'clarification', refusal: 'refusal', malformed: 'malformed-response' })
  assert.equal(result.summary.completed, 3)
  for (const event of result.events.filter(event => event.type === 'finished')) assert.equal(Object.hasOwn(event.grade, 'trace'), false)
  const forged = changedEvents(result.events, event => { event.grade.score = 1 })
  assert.throws(() => validateJournal(tagged, forged), /information disposition disagrees/)
  await retain('failure-dispositions.json', { failures, project: tagged, events: result.events })
})

test('profile recognition preserves raw audit reconstruction and does not grant native scientific admission', async () => {
  const { project, task, run, raw, grade } = await operational(), id = project.schedule[0].id + '-1'
  const files = Object.fromEntries(Object.entries(sources).map(([file, source]) => ['runtime/' + file, source]))
  const programs = operationalCandidateFiles(task, code, sources)
  for (const [file, text] of Object.entries({ ...programs, 'config.json': canonical(leanConfig(id)), 'execution.json': canonical(grade.execution), 'result.json': canonical(raw) })) files['native/' + id + '/' + file] = text
  const reference = await sealAuditReference(project, run.events, files)
  const partial = { format: 'lean-operational-observation', version: 1 }
  const wrong = changedEvents(run.events, event => { event.grade = { ...event.grade, ...gradeInterpretations(task, partial, 'json'), trace: partial } })
  assert.deepEqual(validateJournal(project, wrong), [], 'This narrow gate recognizes the profile; it does not authenticate full raw artifacts.')
  await assert.rejects(sealAuditReference(project, wrong, files), /trace disagrees/)
  const mutated = { ...files, ['native/' + id + '/main.py']: files['native/' + id + '/main.py'] + '\n# changed public harness\n' }
  await assert.rejects(sealAuditReference(project, run.events, mutated), /program or public harness differs/)
  assert.ok(evaluateReadiness(project, { operation: 'collect' }).blockers.some(row => row.code === 'native-admission-unavailable'))
  await retain('audit/reference.json', reference); await retain('audit/header-only-refused.json', wrong)
})
