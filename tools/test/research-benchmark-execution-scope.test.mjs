import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { analyze, executionScope } from '../../src/benchmark/analysis.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { evaluateReadiness } from '../../src/benchmark/readiness.mjs'
import { auditStudyFromReference, sealAuditReference } from '../../src/benchmark/audit.mjs'
import { primaryPopulationFixture } from './fixtures/research-benchmark-primary-population.mjs'

const sources = async () => Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
function familyControl() {
  const spec = primaryPopulationFixture({ developmentTasks: 0, heldOutTasks: 4 })
  spec.tasks.forEach((task, index) => { task.familyId = index < 2 ? 'family-a' : 'family-b' })
  spec.conditions[0].adapter.responses = Object.fromEntries(spec.tasks.map((task, index) => [task.id, index < 2 ? task.expected : 'wrong']))
  spec.conditions[1].adapter.responses = Object.fromEntries(spec.tasks.map(task => [task.id, 'wrong']))
  spec.analysisPlan.uncertainty = { kind: 'family-bootstrap', seed: 872, iterations: 200, confidence: 0.95 }
  return spec
}
const freeze = async (seed, purpose, bytes) => freezeStudy(await bindRuntimeSources(purpose === 'legacy' ? seed : newExperimentDraft(seed, { purpose }), bytes))

test('development preserves hand-computed rates and interval mathematics while refusing scientific collection claims', async () => {
  const bytes = await sources(), seed = familyControl()
  const development = await freeze(seed, 'apparatus-development', bytes)
  const diagnostic = await freeze(seed, 'recorded-diagnostic', bytes)
  const developed = await runStudy(development), replayed = await runStudy(diagnostic)
  assert.deepEqual(developed.summary.groups, replayed.summary.groups)
  assert.deepEqual(developed.summary.contrasts, replayed.summary.contrasts)
  assert.equal(developed.summary.groups[0].primaryRate, 0.5)
  assert.equal(developed.summary.groups[1].primaryRate, 0)
  assert.equal(developed.summary.contrasts[0].difference, 0.5)
  assert.equal(developed.summary.contrasts[0].families, 2)
  assert.deepEqual([developed.summary.contrasts[0].interval.low, developed.summary.contrasts[0].interval.high], [0, 1])
  assert.equal(developed.summary.execution.purpose, 'apparatus-development')
  assert.equal(developed.summary.execution.evidenceClass, 'development-computations')
  assert.equal(developed.summary.execution.experimentalCollection, 'not-admitted')
  assert.equal(evaluateReadiness(development, { operation: 'collect' }).eligible, false)
  assert.equal(replayed.summary.execution.purpose, 'recorded-diagnostic')
})

test('development scope travels with report titles, primary and interval tables, CSV, JSON and the standalone figure', async () => {
  const project = await freeze(familyControl(), 'apparatus-development', await sources())
  const result = await runStudy(project), before = canonical({ project, events: result.events }), files = await researchReportFiles(project, result.events)
  assert.equal(canonical({ project, events: result.events }), before)
  assert.deepEqual(JSON.parse(files['summary.json']), result.summary)
  assert.deepEqual(JSON.parse(files['analysis.json']).summary, result.summary)
  assert.deepEqual(JSON.parse(files['execution.json']), result.summary.execution)
  assert.deepEqual(JSON.parse(files['conventions.json']), result.summary.conventions, 'Typed analytical objects keep their original contract')
  const manifest = JSON.parse(files['execution-manifest.json'])
  assert.deepEqual(manifest.execution, result.summary.execution)
  assert.deepEqual(manifest.files, Object.keys(files).filter(file => file !== 'execution-manifest.json').sort())
  for (const file of ['report.html', 'report.md']) {
    assert.match(files[file], /Apparatus-development report/)
    assert.match(files[file], /Development computations; no scientific inference or admitted experimental collection/)
    assert.match(files[file], /Development primary rate/)
    assert.match(files[file], /Development interval/)
  }
  for (const [file, text] of Object.entries(files).filter(([file]) => file.endsWith('.csv'))) {
    assert.match(text.split('\n')[0], /executionPurpose|Execution purpose/, file)
    if (text.trim().split('\n').length > 1) assert.match(text, /apparatus-development/, file)
  }
  assert.match(files['tables/primary-rates.csv'], /50\.0%/)
  assert.match(files['tables/contrasts.csv'], /"0.5","0 to 1","2"/)
  assert.match(files['figures/disposition.svg'], /no scientific inference or admitted experimental collection/)
  assert.deepEqual(analyze(project, result.events), result.summary)
})

test('purpose cannot be promoted through a changed report project or a relabeled retained start', async () => {
  const bytes = await sources(), seed = familyControl(), development = await freeze(seed, 'apparatus-development', bytes)
  const result = await runStudy(development), experiment = await freeze(seed, 'experiment', bytes)
  assert.notEqual(experiment.sha256, development.sha256)
  await assert.rejects(researchReportFiles(experiment, result.events), /project binding/)
  const changed = structuredClone(result.events)
  changed.find(row => row.type === 'started').executionPurpose = 'experiment'
  await assert.rejects(researchReportFiles(development, changed), /readiness contract or execution purpose/)
  const label = structuredClone(development)
  label.spec.analysisPlan.cohort = 'confirmatory'
  assert.deepEqual(executionScope(label), executionScope(development), 'A cohort label cannot change purpose-derived evidence interpretation')
  assert.equal(evaluateReadiness(development, { operation: 'collect' }).eligible, false)
})

test('legacy and recorded-diagnostic reports preserve their evidence class without an experimental upgrade', async () => {
  const bytes = await sources(), seed = familyControl()
  for (const purpose of ['legacy', 'recorded-diagnostic']) {
    const project = await freeze(seed, purpose, bytes), result = await runStudy(project)
    const files = await researchReportFiles(project, result.events)
    assert.equal(result.summary.execution.purpose, purpose)
    assert.equal(result.summary.execution.experimentalCollection, 'not-admitted')
    assert.match(files['report.html'], purpose === 'legacy' ? /Legacy: Recorded-response apparatus report/ : /Recorded-diagnostic report/)
    assert.match(files['results.csv'], new RegExp('"' + purpose + '"'))
    assert.equal(result.summary.contrasts[0].difference, 0.5)
    assert.deepEqual([result.summary.contrasts[0].interval.low, result.summary.contrasts[0].interval.high], [0, 1])
  }
})

test('a later judge audit retains the development purpose of its sealed reference observations', async () => {
  const bytes = await sources(), source = await freeze(familyControl(), 'apparatus-development', bytes), original = await runStudy(source)
  const reference = await sealAuditReference(source, original.events, Object.fromEntries(Object.entries(bytes).map(([file, text]) => ['runtime/' + file, text])))
  const draft = await auditStudyFromReference(reference)
  draft.requireReview = false
  draft.conditions[0].adapter.responses = Object.fromEntries(draft.tasks.map(task => [task.id, { verdict: task.expected }]))
  const project = await freeze(draft, 'recorded-diagnostic', bytes), result = await runStudy(project)
  assert.equal(result.summary.execution.purpose, 'recorded-diagnostic')
  assert.equal(result.summary.execution.referenceAncestry.length, 1)
  assert.equal(result.summary.execution.referenceAncestry[0].projectSha256, source.sha256)
  assert.equal(result.summary.execution.referenceAncestry[0].purpose, 'apparatus-development')
  assert.equal(result.summary.execution.referenceAncestry[0].experimentalCollection, 'not-admitted')
  const files = await researchReportFiles(project, result.events)
  assert.match(files['report.html'], /Reference source purposes remain attached/)
  assert.match(files['tables/reference-execution-scope.csv'], /apparatus-development/)
  assert.match(files['results.csv'], /referenceExecutionPurposes/)
  assert.match(files['results.csv'], /apparatus-development/)
  assert.deepEqual(JSON.parse(files['audit.json']), result.summary.audit)
})
