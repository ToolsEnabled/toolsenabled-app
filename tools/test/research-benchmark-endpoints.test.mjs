import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { analyze, endpointRecord, validateAnalysisPlan, ENDPOINT_RECORD_FIELDS } from '../../src/benchmark/analysis.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { pageReportOptions } from './fixtures/research-page-report-options.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { runProject } from '../../src/benchmark/cli.mjs'
import { observationPlanFromSpec } from '../../src/benchmark/observations.mjs'
import { endpointStudy, FIXED_NOW, RECORDED_GENERATOR } from './fixtures/research-benchmark-endpoints.mjs'
import { resourceTemplateFixture } from './fixtures/research-benchmark-resource-template.mjs'
const runtimeSources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))

// The project, journal and summary digests were recorded at the base commit
// named inside it, from the same fixture builder, before typed endpoints existed.
// The report file digests were re-recorded at filesRecorded.commit, when the
// report gained its venue sections. See docs/research-benchmark-endpoints.md.
const baseline = JSON.parse(await readFile(new URL('./fixtures/research-benchmark-endpoints-baseline.json', import.meta.url), 'utf8'))
const digest = text => createHash('sha256').update(text).digest('hex')
const endpoint = (id, kind, path, extra = {}) => ({ id, kind, source: { path }, direction: 'higher-better', primary: false, unit: 'units', rationale: 'Synthetic ' + id + ' endpoint.', ...extra })
const ticking = () => { let clock = FIXED_NOW; return () => (clock += 250) }
// Every value below is arithmetic in the task index (1..4) and condition, so
// each estimator can be checked by hand. `text` is deliberately not a number.
const grader = (project, task, output, { trial }) => {
  const index = Number(task.id.slice(-1)), scale = trial.conditionId === 'first' ? 1 : 2
  return { passed: output === task.expected, score: output === task.expected ? 1 : 0, conflicts: index * scale, completed: index, exposure: index === 2 ? 0 : index * 100,
    firstStallMs: index * 20000, text: 'not a number', ...(index % 2 ? { flag: index === 1 } : {}) }
}
function moduleStudy(endpoints, update = () => {}) {
  const spec = endpointStudy(baseline.runtimeSources)
  spec.protocol.grading = { kind: 'module', file: 'grader.mjs' }; spec.inputs = [{ path: 'grader.mjs', sha256: 'a'.repeat(64) }]
  spec.analysisPlan.endpoints = endpoints; update(spec); return spec
}
const typedEndpoints = () => [
  endpoint('pass', 'binary', ['passed']),
  endpoint('conflicts', 'count', ['grade', 'conflicts'], { direction: 'lower-better', primary: true, unit: 'events' }),
  endpoint('completions', 'rate', ['grade', 'completed'], { exposure: { path: ['grade', 'exposure'], unit: 'count' } }),
  endpoint('latency', 'duration', ['elapsedMs'], { direction: 'lower-better', unit: 'ms' }),
  endpoint('stall', 'event-time', ['grade', 'firstStallMs'], { cap: 60000, direction: 'lower-better', unit: 'ms' }),
  endpoint('flag', 'proportion', ['grade', 'flag']),
  endpoint('words', 'count', ['grade', 'text']),
]
const group = (summary, id, condition) => summary.endpoints.groups.find(row => row.endpoint === id && row.condition === condition)
const readinessBody = project => { const { bindings, sha256, ...body } = project.readiness; return body }

// The control below compares a frozen identity against a digest recorded by an earlier
// release, so every input to that identity has to be pinned or it re-freezes differently
// at each bump for reasons that say nothing about the study. The runtime digests were
// already supplied by the caller for exactly that reason; spec.generator was the one input
// left live, and compileStudy stamps it with the RUNNING release when the spec declares
// none (study.mjs:667). Declaring it is what a real frozen study does, and it costs no
// coverage: the stamp is asserted against package.json by
// research-benchmark-generator-identity.test.mjs, and a freeze that ignored the declared
// value and re-stamped anyway would move projectSha256 and fail the control below.
test('the fixture pins the release that recorded it, so nothing about the running application reaches the frozen identity', async () => {
  assert.deepEqual(endpointStudy(baseline.runtimeSources).generator, RECORDED_GENERATOR,
    'mutation `drop the fixture generator pin` survived: expected the fixture to declare the release it was recorded under')
  const project = await freezeStudy(endpointStudy(baseline.runtimeSources))
  assert.deepEqual(project.spec.generator, { ...RECORDED_GENERATOR },
    'mutation `re-stamp a declared generator at freeze` survived: expected the recorded release to be preserved, not overwritten with the running one')
})

test('a frozen project without endpoints analyzes and reports byte-identically to the base commit snapshot', async () => {
  const project = await freezeStudy(endpointStudy(baseline.runtimeSources))
  assert.equal(project.sha256, baseline.projectSha256, 'frozen project identity at base ' + baseline.baseCommit)
  const result = await runStudy(project, { now: () => FIXED_NOW })
  assert.equal(digest(canonical(result.events)), baseline.journalSha256)
  assert.equal(digest(canonical(result.summary)), baseline.summarySha256)
  assert.equal(result.summary.endpoints, undefined); assert.equal(result.summary.groups[0].primaryEndpoint, undefined)
  const files = await researchReportFiles(project, result.events)
  assert.deepEqual(Object.keys(files).sort(), Object.keys(baseline.files).sort())
  for (const [file, expected] of Object.entries(baseline.files)) assert.equal(digest(files[file]), expected, file + ' differs from the output recorded at ' + baseline.filesRecorded.commit)
})

test('validation refuses malformed, ambiguous and design-contradicting endpoint declarations', () => {
  const refuse = (mutate, pattern) => { const spec = moduleStudy([endpoint('pass', 'binary', ['passed'])]); mutate(spec); assert.throws(() => validateAnalysisPlan(spec), pattern) }
  refuse(spec => { spec.analysisPlan.endpoints[0].extra = 1 }, /unsupported fields/)
  refuse(spec => { spec.analysisPlan.endpoints.push(endpoint('pass', 'count', ['attempts'])) }, /distinct lowercase identifier/)
  refuse(spec => { spec.analysisPlan.endpoints = [endpoint('events', 'rate', ['grade', 'completed'])] }, /rate exposure must be an object/)
  refuse(spec => { spec.analysisPlan.endpoints = [endpoint('events', 'rate', ['grade', 'completed'], { exposure: { path: ['elapsedMs'], unit: 'hours' } })] }, /unit of ms, agent-ms, wall-ms or count/)
  refuse(spec => { spec.analysisPlan.endpoints = [endpoint('events', 'count', ['grade', 'completed'], { exposure: { path: ['elapsedMs'], unit: 'ms' } })] }, /only rate endpoints declare an exposure/)
  refuse(spec => { spec.analysisPlan.endpoints = [endpoint('events', 'count', ['grade', 'completed'], { cap: 10 })] }, /only event-time endpoints declare a censoring cap/)
  refuse(spec => { spec.analysisPlan.endpoints = [endpoint('stall', 'event-time', ['grade', 'firstStallMs'])] }, /positive integer cap/)
  refuse(spec => { spec.analysisPlan.endpoints = [endpoint('stall', 'event-time', ['grade', 'firstStallMs'], { cap: 0 })] }, /positive integer cap/)
  refuse(spec => { spec.analysisPlan.endpoints = [endpoint('a', 'count', ['attempts'], { primary: true }), endpoint('b', 'count', ['attempts'], { primary: true })] }, /at most one primary/)
  refuse(spec => { spec.analysisPlan.endpoints[0].kind = 'severity' }, /choose a binary, count, rate, duration, proportion or event-time/)
  refuse(spec => { spec.analysisPlan.endpoints[0].direction = 'up' }, /higher-better or lower-better/)
  refuse(spec => { spec.analysisPlan.endpoints[0].primary = 'yes' }, /declare primary as true or false/)
  refuse(spec => { spec.analysisPlan.endpoints[0].unit = ' ' }, /measurement unit/)
  refuse(spec => { spec.analysisPlan.endpoints[0].rationale = '' }, /endpoint rationale/)
  refuse(spec => { spec.analysisPlan.endpoints[0].id = 'Pass' }, /distinct lowercase identifier/)
  refuse(spec => { spec.analysisPlan.endpoints = [] }, /Declare 1–32 typed endpoints/)
  refuse(spec => { spec.analysisPlan.endpoints = null }, /Declare 1–32 typed endpoints/)
  for (const path of ['passed', [], ['passed', -1], ['passed', 1.5], ['passed', null], ['nonsense'], [{ key: 'passed' }], Array.from({ length: 17 }, () => 'grade')])
    refuse(spec => { spec.analysisPlan.endpoints[0].source = { path } }, /source path must be a nonempty array of strings or nonnegative integers/)
  refuse(spec => { spec.analysisPlan.endpoints[0].source = { path: ['passed'], transform: 'log' } }, /unsupported fields/)
  assert.deepEqual(ENDPOINT_RECORD_FIELDS, ['passed', 'score', 'elapsedMs', 'status', 'attempts', 'grade', 'reported', 'effects', 'response', 'unit'])
  // Uncertainty procedures: cluster units must be declared on every primary task.
  refuse(spec => { spec.analysisPlan.uncertainty = { kind: 'cluster-bootstrap', seed: 1, iterations: 100, confidence: 0.9 } }, /Cluster the bootstrap by familyId/)
  refuse(spec => { spec.analysisPlan.uncertainty = { kind: 'cluster-bootstrap', clusterBy: 'siteId', seed: 1, iterations: 100, confidence: 0.9 } }, /Cluster the bootstrap by familyId/)
  refuse(spec => { spec.analysisPlan.uncertainty = { kind: 'cluster-bootstrap', clusterBy: { factor: 'site' }, seed: 1, iterations: 100, confidence: 0.9 } }, /declared on every primary-population task/)
  refuse(spec => { spec.analysisPlan.uncertainty = { kind: 'cluster-bootstrap', clusterBy: { factor: 'depth', extra: 1 }, seed: 1, iterations: 100, confidence: 0.9 } }, /unsupported fields/)
  refuse(spec => { spec.analysisPlan.uncertainty = { kind: 'family-bootstrap', clusterBy: 'familyId', seed: 1, iterations: 100, confidence: 0.9 } }, /unsupported fields/)
  refuse(spec => { spec.analysisPlan.uncertainty = { kind: 'jackknife', seed: 1, iterations: 100, confidence: 0.9 } }, /family bootstrap, a cluster bootstrap, or null/)
  refuse(spec => { spec.analysisPlan.uncertainty = { kind: 'cluster-bootstrap', clusterBy: 'familyId', seed: 1, iterations: 100, confidence: 0.9 }; delete spec.tasks[0].familyId }, /explicit familyId for every primary-population task/)
  // The admitted experiment design declares the binary pass primary outcome.
  refuse(spec => { spec.executionPlan = { version: 1, purpose: 'experiment', design: { schedule: 'crossed-task-condition', replicates: 'repeated-measurements', primaryOutcome: 'binary-pass', dependence: 'family-clusters' } }; spec.analysisPlan.endpoints = [endpoint('conflicts', 'count', ['grade', 'conflicts'], { primary: true })] }, /binary pass primary outcome only/)
  const experiment = moduleStudy([endpoint('pass', 'binary', ['passed'], { primary: true }), endpoint('conflicts', 'count', ['grade', 'conflicts'])])
  experiment.executionPlan = { version: 1, purpose: 'experiment', design: { schedule: 'crossed-task-condition', replicates: 'repeated-measurements', primaryOutcome: 'binary-pass', dependence: 'family-clusters' } }
  validateAnalysisPlan(experiment)
  const accepted = moduleStudy(typedEndpoints(), spec => { spec.analysisPlan.uncertainty = { kind: 'cluster-bootstrap', clusterBy: { factor: 'depth' }, seed: 5, iterations: 100, confidence: 0.9 } })
  validateAnalysisPlan(accepted)
})

test('the attempt record exposes exactly the documented fields and nothing from failed attempts', async () => {
  const project = await freezeStudy(moduleStudy([endpoint('bytes', 'count', ['response', 'outputBytes'])]))
  const result = await runStudy(project, { now: ticking(), grade: grader })
  const row = result.summary.rows[0], attempts = result.events.filter(event => event.type === 'finished' && event.trialId === row.id)
  const record = endpointRecord(project, row, attempts.find(event => event.status === 'completed'), attempts.at(-1))
  assert.deepEqual(Object.keys(record), ENDPOINT_RECORD_FIELDS)
  assert.equal(record.passed, attempts[0].grade.passed); assert.equal(record.score, attempts[0].grade.score); assert.equal(record.elapsedMs, attempts[0].elapsedMs)
  assert.equal(record.status, 'completed'); assert.equal(record.attempts, 1); assert.deepEqual(record.grade, attempts[0].grade)
  assert.equal(record.reported, null); assert.equal(record.effects, null)
  assert.equal(record.response.outputBytes, new TextEncoder().encode(attempts[0].response.output).length)
  const empty = endpointRecord(project, { ...row, status: 'pending', attempts: 0 }, null, null)
  assert.deepEqual(empty, { passed: null, score: null, elapsedMs: null, status: 'pending', attempts: 0, grade: null, reported: null, effects: null, response: { outputBytes: null }, unit: null })
  const object = endpointRecord(project, row, { ...attempts[0], response: { output: { a: 1 } } }, attempts[0])
  assert.equal(object.response.outputBytes, canonical({ a: 1 }).length)
  const failed = endpointRecord(project, { ...row, status: 'failed', attempts: 1 }, null, { ...attempts[0], status: 'failed', grade: undefined })
  assert.equal(failed.grade, null); assert.equal(failed.elapsedMs, null)
})

test('each estimator reads the record, keeps scheduled denominators and counts unavailable, invalid, zero-exposure and censored values', async () => {
  const project = await freezeStudy(moduleStudy(typedEndpoints()))
  const result = await runStudy(project, { now: ticking(), grade: grader }), summary = result.summary
  assert.equal(summary.analysisVersion, 3); assert.equal(summary.endpoints.version, 1); assert.equal(summary.endpoints.primary, 'conflicts')
  const pass = group(summary, 'pass', 'first')
  assert.deepEqual([pass.scheduled, pass.unavailable, pass.invalid, pass.n, pass.k, pass.rate, pass.scheduledRate, pass.estimate], [8, 0, 0, 8, 6, 0.75, 0.75, 0.75])
  assert.deepEqual([group(summary, 'pass', 'second').k, group(summary, 'pass', 'second').rate], [2, 0.25])
  const conflicts = group(summary, 'conflicts', 'first')
  assert.deepEqual([conflicts.n, conflicts.total, conflicts.mean, conflicts.estimate, conflicts.primary], [8, 20, 2.5, 2.5, true])
  assert.deepEqual([group(summary, 'conflicts', 'second').total, group(summary, 'conflicts', 'second').mean], [40, 5])
  const completions = group(summary, 'completions', 'first')
  assert.deepEqual([completions.n, completions.zeroExposure, completions.unavailable, completions.numerator, completions.exposure, completions.unit, completions.rate], [6, 2, 0, 16, 1600, 'count', 0.01])
  const latency = group(summary, 'latency', 'first'), elapsed = [...new Set(result.events.filter(event => event.type === 'finished').map(event => event.elapsedMs))]
  assert.equal(elapsed.length, 1); assert.ok(elapsed[0] > 0)
  assert.deepEqual([latency.n, latency.mean, latency.median, latency.min, latency.max, latency.estimate], [8, elapsed[0], elapsed[0], elapsed[0], elapsed[0], elapsed[0]])
  const stall = group(summary, 'stall', 'first')
  assert.deepEqual([stall.n, stall.observed, stall.censored, stall.cap, stall.medianObserved, stall.estimate], [8, 4, 4, 60000, 40000, 40000])
  const flag = group(summary, 'flag', 'first')
  assert.deepEqual([flag.scheduled, flag.unavailable, flag.n, flag.k, flag.rate, flag.scheduledRate, flag.estimate], [8, 4, 4, 2, 0.5, 0.25, 0.5])
  const words = group(summary, 'words', 'first')
  assert.deepEqual([words.scheduled, words.unavailable, words.invalid, words.n, words.total, words.mean, words.estimate], [8, 0, 8, 0, 0, null, null])
  // Strata reuse the frozen split and factor cells over the primary population.
  const development = summary.endpoints.strata.find(row => row.endpoint === 'stall' && row.dimension === 'split' && row.value === 'development' && row.condition === 'first')
  assert.deepEqual([development.n, development.observed, development.censored, development.medianObserved], [4, 4, 0, 20000])
  const heldOut = summary.endpoints.strata.find(row => row.endpoint === 'stall' && row.dimension === 'split' && row.value === 'held-out' && row.condition === 'first')
  assert.deepEqual([heldOut.n, heldOut.observed, heldOut.censored, heldOut.medianObserved], [4, 0, 4, null])
  assert.equal(summary.endpoints.strata.length, summary.strata.length * summary.endpoints.declared.length)
  assert.deepEqual(summary.endpoints.strata.map(row => [row.dimension, canonical(row.value), row.condition]).filter((row, index) => index % 7 === 0), summary.strata.map(row => [row.dimension, canonical(row.value), row.condition]))
  // The declared primary replaces the pass rate and keeps it beside itself.
  for (const [condition, mean, passRate] of [['first', 2.5, 0.75], ['second', 5, 0.25]]) {
    const row = summary.groups.find(row => row.condition === condition)
    assert.equal(row.primaryRate, mean); assert.equal(row.primaryPassRate, passRate); assert.equal(row.primary.scheduledPassRate, passRate)
    assert.deepEqual(row.primaryEndpoint, { id: 'conflicts', kind: 'count', unit: 'events', direction: 'lower-better', estimate: mean })
  }
  const contrast = summary.endpoints.contrasts.find(row => row.endpoint === 'conflicts')
  assert.deepEqual([contrast.id, contrast.firstEstimate, contrast.secondEstimate, contrast.difference, contrast.clusters], ['first-second', 2.5, 5, -2.5, 2])
  assert.equal(summary.contrasts[0].difference, 0.5, 'the planned pass-rate contrast stays unchanged')
  // Exchangeability diagnostic by replicate index, descriptive only.
  assert.deepEqual(summary.endpoints.replicates.filter(row => row.endpoint === 'conflicts').map(row => [row.condition, row.replicate, row.n, row.estimate]), [['first', 1, 4, 2.5], ['first', 2, 4, 2.5], ['second', 1, 4, 5], ['second', 2, 4, 5]])
  const record = summary.endpoints.records.find(row => row.taskId === 'task-2' && row.conditionId === 'first' && row.replicate === 1)
  assert.deepEqual(record.values.completions, { status: 'zero-exposure', value: 2, exposure: 0 })
  assert.deepEqual(record.values.flag, { status: 'unavailable', value: null })
  assert.deepEqual(record.values.words, { status: 'invalid', value: null, reason: 'expected a nonnegative integer' })
  assert.deepEqual(summary.endpoints.records.find(row => row.taskId === 'task-4' && row.conditionId === 'first' && row.replicate === 2).values.stall, { status: 'censored', value: 60000 })
  for (const pattern of [/Rate endpoints need a declared exposure/, /censor values at their declared cap/, /primary endpoint conflicts replaces the binary pass/, /descriptive exchangeability diagnostics/])
    assert.ok(summary.limitations.some(text => pattern.test(text)), String(pattern))
  assert.deepEqual(analyze(project, result.events), summary)
})

test('the cluster bootstrap is deterministic under its seed, follows the declared cluster unit and stays paired', async () => {
  const uncertainty = clusterBy => ({ kind: 'cluster-bootstrap', clusterBy, seed: 4242, iterations: 400, confidence: 0.9 })
  const byFamily = await freezeStudy(moduleStudy(typedEndpoints(), spec => { spec.analysisPlan.uncertainty = uncertainty('familyId') }))
  const first = await runStudy(byFamily, { now: ticking(), grade: grader }), second = await runStudy(byFamily, { now: ticking(), grade: grader })
  assert.deepEqual(second.summary, first.summary); assert.deepEqual(analyze(byFamily, first.events), first.summary)
  const conflicts = group(first.summary, 'conflicts', 'first')
  assert.equal(conflicts.clusters, 2); assert.equal(conflicts.interval.kind, 'family percentile bootstrap'); assert.equal(conflicts.interval.clusterBy, 'familyId')
  assert.ok(conflicts.interval.low <= conflicts.estimate && conflicts.estimate <= conflicts.interval.high); assert.equal(conflicts.interval.resamples, 400)
  const contrast = first.summary.endpoints.contrasts.find(row => row.endpoint === 'conflicts')
  assert.equal(contrast.interval.kind, 'paired family percentile bootstrap'); assert.ok(contrast.interval.low <= -2.5 && -2.5 <= contrast.interval.high)
  const stall = first.summary.endpoints.contrasts.find(row => row.endpoint === 'stall')
  assert.equal(stall.interval, null); assert.match(stall.intervalReason, /no estimable value|Both conditions need/)
  // A family bootstrap gives the same endpoint intervals as clustering by familyId.
  const family = await freezeStudy(moduleStudy(typedEndpoints(), spec => { spec.analysisPlan.uncertainty = { kind: 'family-bootstrap', seed: 4242, iterations: 400, confidence: 0.9 } }))
  const familyRun = await runStudy(family, { now: ticking(), grade: grader })
  assert.deepEqual(familyRun.summary.endpoints.groups.map(row => row.interval), first.summary.endpoints.groups.map(row => row.interval))
  const { clusterBy, ...passInterval } = first.summary.contrasts[0].interval
  assert.equal(clusterBy, 'familyId'); assert.deepEqual(passInterval, familyRun.summary.contrasts[0].interval)
  // A different seed moves the resamples; a factor unit reports its own clusters.
  const reseeded = await runStudy(await freezeStudy(moduleStudy(typedEndpoints(), spec => { spec.analysisPlan.uncertainty = { ...uncertainty('familyId'), seed: 7 } })), { now: ticking(), grade: grader })
  assert.notDeepEqual(reseeded.summary.endpoints.groups.map(row => row.interval), first.summary.endpoints.groups.map(row => row.interval))
  const byDepth = await runStudy(await freezeStudy(moduleStudy(typedEndpoints(), spec => { spec.analysisPlan.uncertainty = uncertainty({ factor: 'depth' }) })), { now: ticking(), grade: grader })
  const depth = group(byDepth.summary, 'conflicts', 'first')
  assert.equal(depth.clusters, 2); assert.equal(depth.interval.kind, 'cluster percentile bootstrap'); assert.deepEqual(depth.interval.clusterBy, { factor: 'depth' })
  assert.equal(byDepth.summary.contrasts[0].interval.kind, 'paired cluster percentile bootstrap'); assert.deepEqual(byDepth.summary.contrasts[0].interval.clusterBy, { factor: 'depth' })
  assert.ok(byDepth.summary.limitations.some(text => /independent sampled clusters of factor depth/.test(text)))
  assert.deepEqual(byDepth.summary.endpoints.uncertainty, { kind: 'cluster-bootstrap', clusterBy: { factor: 'depth' }, seed: 4242, iterations: 400, confidence: 0.9, multiplicity: 'none-descriptive' })
  const single = await runStudy(await freezeStudy(moduleStudy(typedEndpoints(), spec => { spec.tasks.forEach(task => { task.factors.depth = 1 }); spec.analysisPlan.uncertainty = uncertainty({ factor: 'depth' }) })), { now: ticking(), grade: grader })
  assert.equal(group(single.summary, 'conflicts', 'first').interval, null); assert.match(group(single.summary, 'conflicts', 'first').intervalReason, /At least two clusters/)
  assert.match(single.summary.contrasts[0].intervalReason, /At least two clusters/)
})

test('reports add endpoint tables, intervals and scope sentences while every passed-based table stays unchanged', async () => {
  const plain = await freezeStudy(endpointStudy(baseline.runtimeSources)), plainRun = await runStudy(plain, { now: () => FIXED_NOW })
  const typed = await freezeStudy(endpointStudy(baseline.runtimeSources, { endpoints: [endpoint('pass', 'binary', ['passed'], { primary: true }), endpoint('retries', 'count', ['attempts'], { direction: 'lower-better', unit: 'attempts' }), endpoint('size', 'count', ['response', 'outputBytes'], { unit: 'bytes' })] }))
  const typedRun = await runStudy(typed, { now: () => FIXED_NOW })
  const plainFiles = await researchReportFiles(plain, plainRun.events), files = await researchReportFiles(typed, typedRun.events)
  assert.deepEqual(await researchReportFiles(typed, typedRun.events), files)
  for (const file of ['tables/rates.csv', 'tables/primary-rates.csv', 'tables/primary-population.csv', 'tables/contrasts.csv', 'tables/strata.csv', 'tables/dispositions.csv', 'figures/disposition.svg'])
    assert.equal(files[file], plainFiles[file], file)
  assert.deepEqual(Object.keys(files).filter(file => !(file in plainFiles)).sort(), ['endpoints.json', 'tables/endpoint-conditions-pass.csv', 'tables/endpoint-conditions-retries.csv', 'tables/endpoint-conditions-size.csv', 'tables/endpoint-strata-pass.csv', 'tables/endpoint-strata-retries.csv', 'tables/endpoint-strata-size.csv', 'tables/endpoints-contrasts.csv', 'tables/endpoints-intervals.csv', 'tables/endpoints-records.csv', 'tables/endpoints-replicates.csv'])
  assert.deepEqual(JSON.parse(files['endpoints.json']), typedRun.summary.endpoints)
  assert.deepEqual(JSON.parse(files['summary.json']).endpoints, typedRun.summary.endpoints)
  assert.match(files['report.html'], /Typed endpoint development computations/); assert.match(files['report.md'], /Primary endpoint: pass \\\(binary, higher-better\\\) replaces the binary pass criterion/)
  assert.match(files['report.html'], /Rate endpoints need a declared exposure|Typed endpoints read literal frozen paths/)
  assert.match(files['tables/endpoint-conditions-retries.csv'], /^"Condition","Scheduled","Unavailable","Invalid","n","Total","Mean","Estimate"/)
  assert.match(files['tables/endpoint-conditions-retries.csv'], /"first","8","0","0","8","8","1","1"/)
  assert.match(files['tables/endpoints-intervals.csv'], /"pass","first-second \(first − second\)"/)
  assert.ok(JSON.parse(files['execution-manifest.json']).files.includes('tables/endpoints-records.csv'))
  // The typed primary is the binary pass itself here, so both primary rates agree.
  assert.deepEqual(typedRun.summary.groups.map(row => [row.primaryRate, row.primaryPassRate]), plainRun.summary.groups.map(row => [row.primaryRate, row.primaryRate]))
  // The frozen readiness contract does not change with secondary or development-only primary endpoints.
  assert.deepEqual(readinessBody(typed), readinessBody(plain))
  const forged = structuredClone(typedRun.events); forged.find(event => event.type === 'finished').grade.passed = !forged.find(event => event.type === 'finished').grade.passed
  await assert.rejects(researchReportFiles(typed, forged), /recorded grade disagrees/)
})

test('the exported CLI analyze command writes the same endpoint tables under results/ as the browser report', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'benchmark-endpoints-')); t.after(() => rm(root, { recursive: true, force: true }))
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  const spec = endpointStudy(null, { endpoints: [endpoint('pass', 'binary', ['passed'], { primary: true }), endpoint('latency', 'duration', ['elapsedMs'], { direction: 'lower-better', unit: 'ms' }), endpoint('size', 'count', ['response', 'outputBytes'], { unit: 'bytes' })] })
  spec.analysisPlan.uncertainty = { kind: 'cluster-bootstrap', clusterBy: { factor: 'depth' }, seed: 11, iterations: 200, confidence: 0.9 }
  const project = await freezeStudy(await bindRuntimeSources(spec, sources)), files = await projectFiles(project, sources, {})
  for (const [file, text] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text) }
  const result = await runProject(root)
  assert.equal(result.summary.completed, 16); assert.equal(result.summary.endpoints.primary, 'pass')
  const analysis = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), 'analyze'], { encoding: 'utf8', timeout: 30000, windowsHide: true })
  assert.equal(analysis.status, 0, analysis.stderr)
  assert.deepEqual(JSON.parse(analysis.stdout).endpoints, result.summary.endpoints)
  const expected = await researchReportFiles(project, result.events, await pageReportOptions({ project, sources }))
  for (const file of ['tables/endpoint-conditions-pass.csv', 'tables/endpoint-conditions-latency.csv', 'tables/endpoint-strata-size.csv', 'tables/endpoints-intervals.csv', 'tables/endpoints-contrasts.csv', 'tables/endpoints-replicates.csv', 'tables/endpoints-records.csv', 'endpoints.json', 'summary.json', 'report.html'])
    assert.equal(await readFile(resolve(root, 'results', file), 'utf8'), expected[file], file)
  const size = group(result.summary, 'size', 'first')
  assert.deepEqual([size.n, size.total, size.mean], [8, 22, 2.75], 'three two-byte correct answers and one five-byte wrong answer per replicate')
  assert.equal(group(result.summary, 'latency', 'first').interval?.kind, 'cluster percentile bootstrap')
})

test('the reported root reads the completed attempt\'s observation record when an observation plan is frozen', async () => {
  const spec = endpointStudy(baseline.runtimeSources, { endpoints: [endpoint('tokens', 'count', ['reported', 'usage', 'outputTokens', 'value'], { unit: 'tokens' })] })
  spec.observationPlan = observationPlanFromSpec()
  for (const condition of spec.conditions) condition.adapter = { kind: 'replay', mode: 'envelope', responses: Object.fromEntries(spec.tasks.map((task, i) => [task.id, { output: condition.adapter.responses[task.id], ...(i < 3 ? { usage: { outputTokens: (i + 1) * 10 } } : {}) }])) }
  const project = await freezeStudy(spec), result = await runStudy(project, { now: () => FIXED_NOW })
  assert.equal(result.summary.completed, 16)
  const tokens = group(result.summary, 'tokens', 'first')
  assert.deepEqual([tokens.scheduled, tokens.unavailable, tokens.invalid, tokens.n, tokens.total, tokens.mean], [8, 2, 0, 6, 120, 20])
  assert.deepEqual(result.summary.endpoints.records.find(row => row.taskId === 'task-4').values.tokens, { status: 'unavailable', value: null })
  const finished = result.events.find(event => event.type === 'finished' && event.trialId === 'task-1.first.1'), row = result.summary.rows.find(row => row.id === 'task-1.first.1')
  assert.deepEqual(endpointRecord(project, row, finished, finished).reported, finished.observations.reported)
})

test('proportion estimates are the observed share k over n while binary estimates follow the plan denominator, and the report says exactly that', async () => {
  const project = await freezeStudy(moduleStudy([endpoint('flag', 'proportion', ['grade', 'flag']), endpoint('pass', 'binary', ['passed'])], spec => { spec.analysisPlan.primaryDenominator = 'scheduled'; spec.analysisPlan.uncertainty = null }))
  const result = await runStudy(project, { now: () => FIXED_NOW, grade: grader })
  // Eight scheduled trials per condition; only the odd-numbered tasks report a boolean flag (four values), and only task 1 reports true (two values).
  const flag = group(result.summary, 'flag', 'first')
  assert.deepEqual([flag.scheduled, flag.n, flag.k, flag.unavailable, flag.rate, flag.scheduledRate, flag.estimate], [8, 4, 2, 4, 0.5, 0.25, 0.5])
  const pass = group(result.summary, 'pass', 'first')
  assert.equal(pass.n, 8); assert.equal(pass.estimate, pass.scheduledRate, 'a binary endpoint under the scheduled denominator estimates k over scheduled')
  const files = await researchReportFiles(project, result.events)
  assert.doesNotMatch(files['report.md'], /scheduled denominator for binary and proportion estimates/)
  assert.match(files['report.md'], /Binary estimates follow the frozen scheduled denominator/)
  assert.match(files['report.md'], /Proportion estimates are the observed share k \\?\/ n over trials with an available boolean value; k \\?\/ scheduled is shown beside them and never replaces the estimate/)
  const table = files['tables/endpoint-conditions-flag.csv'].split('\n').map(line => line.replace(/"/g, ''))
  assert.match(table[0], /^Condition,Scheduled,Unavailable,Invalid,n,k,k \/ n,k \/ scheduled,Estimate/)
  assert.match(table.find(line => line.startsWith('first,')), /^first,8,4,0,4,2,50\.0%,25\.0%,50\.0%/)
  const completed = await freezeStudy(moduleStudy([endpoint('pass', 'binary', ['passed'])], spec => { spec.analysisPlan.primaryDenominator = 'completed'; spec.analysisPlan.uncertainty = null }))
  const completedRun = await runStudy(completed, { now: () => FIXED_NOW, grade: grader })
  assert.equal(group(completedRun.summary, 'pass', 'first').estimate, group(completedRun.summary, 'pass', 'first').rate, 'under the completed denominator a binary endpoint estimates k over n')
  assert.match((await researchReportFiles(completed, completedRun.events))['report.md'], /Binary estimates follow the frozen completed denominator/)
})

test('a retained non-null resource effect reaches the estimator and the report, with unavailable values kept distinct', async () => {
  const spec = await resourceTemplateFixture()
  spec.analysisPlan.endpoints = [
    endpoint('collateral', 'count', ['effects', 'everCollateralCount'], { direction: 'lower-better', unit: 'resources' }),
    endpoint('success', 'proportion', ['effects', 'taskSuccess'], { unit: 'share' }),
    endpoint('actions', 'count', ['effects', 'observedActionCount'], { unit: 'actions' }),
  ]
  const project = await freezeStudy(await bindRuntimeSources(spec, runtimeSources))
  const result = await runStudy(project, { now: () => FIXED_NOW })
  assert.equal(result.summary.completed, result.summary.scheduled, 'every synthetic resource trial completed')
  // Endpoint estimates run over the frozen primary population (the fixture selects half of its trials).
  const scheduledPer = result.summary.rows.filter(row => row.conditionId === 'target-only' && row.primaryIncluded).length
  assert.ok(scheduledPer > 0); assert.equal(scheduledPer, result.summary.rows.filter(row => row.conditionId === 'collateral' && row.primaryIncluded).length)
  const targetOnly = group(result.summary, 'collateral', 'target-only'), collateral = group(result.summary, 'collateral', 'collateral')
  assert.deepEqual([targetOnly.unavailable, targetOnly.invalid, targetOnly.n, targetOnly.total], [0, 0, scheduledPer, 0], 'intended-only plans retain a non-null zero collateral count')
  assert.equal(collateral.unavailable, 0); assert.equal(collateral.n, scheduledPer); assert.ok(collateral.total >= collateral.n, 'every collateral plan retains at least one ever-collateral resource')
  assert.equal(group(result.summary, 'success', 'collateral').k, scheduledPer); assert.equal(group(result.summary, 'actions', 'collateral').total > 0, true)
  for (const record of result.summary.endpoints.records) assert.equal(record.values.collateral.status, 'observed')
  const files = await researchReportFiles(project, result.events)
  assert.match(files['tables/endpoint-conditions-collateral.csv'], /^"collateral","2","0","0","2","2","1","1"/m); assert.match(files['tables/endpoint-conditions-collateral.csv'], /^"target-only","2","0","0","2","0","0","0"/m)
  assert.ok(JSON.parse(files['endpoints.json']).records.every(record => Number.isSafeInteger(record.values.actions.value)))
  // Drop the last trial's journal records: its effect is unavailable, counted, never imputed.
  const dropped = result.summary.rows.find(row => row.conditionId === 'collateral' && row.primaryIncluded).id
  const partial = analyze(project, result.events.filter(event => event.trialId !== dropped))
  const partialGroup = partial.endpoints.groups.find(row => row.endpoint === 'collateral' && row.condition === 'collateral')
  assert.deepEqual([partialGroup.scheduled, partialGroup.n, partialGroup.unavailable], [scheduledPer, scheduledPer - 1, 1])
  assert.equal(partial.endpoints.records.find(record => record.trialId === dropped).values.collateral.status, 'unavailable')
})
