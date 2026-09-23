import assert from 'node:assert/strict'
import test from 'node:test'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { analyze, freezeStudy } from '../../src/benchmark/study.mjs'
import { genericStarter as legacyStarter } from '../../src/benchmark/starters.mjs'
import { developmentStarter } from './fixtures/research-benchmark-development.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { analysisArtifact } from '../../src/benchmark/analysis.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'

function familyStudy(replicates = 1) {
  const spec = developmentStarter(), template = spec.tasks[0]
  spec.tasks = Array.from({ length: 4 }, (_, i) => ({ ...structuredClone(template), id: `task-${i + 1}`, familyId: i < 2 ? 'family-a' : 'family-b',
    variables: { a: i + 1, b: 10 }, expected: String(i + 11), factors: { depth: i % 2 + 1 } }))
  const first = Object.fromEntries(spec.tasks.map((task, i) => [task.id, i < 2 ? task.expected : 'wrong']))
  const second = Object.fromEntries(spec.tasks.map(task => [task.id, 'wrong']))
  spec.conditions = [{ ...spec.conditions[0], id: 'first', adapter: { kind: 'replay', responses: first } }, { ...spec.conditions[0], id: 'second', adapter: { kind: 'replay', responses: second } }]
  spec.protocol.replicates = replicates; spec.protocol.maxTotalAttempts = 1000
  spec.analysisPlan.contrasts = [{ id: 'first-second', first: 'first', second: 'second' }]
  spec.analysisPlan.uncertainty = { kind: 'family-bootstrap', seed: 872, iterations: 500, confidence: 0.95 }
  return spec
}

test('all-scheduled and completed rates retain different denominators without relabeling collection failures', async () => {
  const project = await freezeStudy(developmentStarter())
  const result = await runStudy(project, { adapter: async ({ task }) => { if (task.id === 'addition-b') throw new Error('Collector failed'); return { output: task.expected } } })
  const group = result.summary.groups[0]
  assert.equal(group.scheduled, 2); assert.equal(group.measured, 1); assert.equal(group.passed, 1)
  assert.equal(group.scheduledPassRate, 0.5); assert.equal(group.passRate, 1)
  assert.equal(group.primaryDenominator, 'scheduled'); assert.equal(group.primaryRate, 0.5)
  assert.deepEqual(group.dispositions, { correct: 1, 'transport-error': 1 })
  const missing = result.summary.rows.find(row => row.taskId === 'addition-b')
  assert.equal(missing.passed, null); assert.equal(missing.score, null); assert.equal(missing.providerCompleted, false)
})

test('a collected but ungradable answer is an apparatus error and remains in the disposition ledger', async () => {
  const spec = developmentStarter(); spec.protocol.grading = { kind: 'module', file: 'grader.mjs' }; spec.inputs = [{ path: 'grader.mjs', sha256: 'a'.repeat(64) }]
  const result = await runStudy(await freezeStudy(spec), { grade: () => { throw new Error('broken grader') } })
  assert.equal(result.summary.rows.filter(row => row.disposition === 'apparatus-error').length, 1)
  assert.equal(result.summary.rows.filter(row => row.providerCompleted).length, 1)
  assert.equal(result.summary.pending, 1)
  assert.equal(result.summary.completed, 0)
})

test('paired family bootstrap is deterministic and does not treat repeated draws as independent families', async () => {
  const first = await runStudy(await freezeStudy(familyStudy(1)))
  const repeated = await runStudy(await freezeStudy(familyStudy(20)))
  const contrast = first.summary.contrasts[0]
  assert.equal(contrast.difference, 0.5)
  assert.equal(contrast.families, 2)
  assert.deepEqual([contrast.interval.low, contrast.interval.high], [0, 1])
  assert.deepEqual(repeated.summary.contrasts[0], contrast)
  const project = await freezeStudy(familyStudy(1))
  assert.deepEqual(analyze(project, first.events), first.summary)
  assert.equal(first.summary.strata.find(row => row.dimension === 'depth' && row.value === 1 && row.condition === 'first').scheduled, 2)
})

test('a family crossing splits, an undeclared family, and mixed legacy cohorts refuse before collection', async () => {
  const crossed = familyStudy(); crossed.tasks[1].split = 'held-out'
  await assert.rejects(freezeStudy(crossed), /cannot cross development/)
  const missing = familyStudy(); delete missing.tasks[0].familyId
  await assert.rejects(freezeStudy(missing), /explicit familyId/)
  const mixed = familyStudy(); mixed.tasks[0].cohort = 'legacy'
  await assert.rejects(freezeStudy(mixed), /cohort differs/)
  const unknown = familyStudy(); unknown.analysisPlan.contrasts[0].second = 'unfrozen'
  await assert.rejects(freezeStudy(unknown), /two distinct frozen conditions/)
})

test('empty and single-family uncertainty are left unestimated with reasons', async () => {
  const spec = familyStudy(); spec.tasks.forEach(task => { task.familyId = 'one-family' })
  const project = await freezeStudy(spec)
  const empty = analyze(project, [])
  assert.equal(empty.pending, 8)
  assert.equal(empty.contrasts[0].interval, null)
  const completed = await runStudy(project)
  assert.equal(completed.summary.contrasts[0].interval, null)
  assert.match(completed.summary.contrasts[0].intervalReason, /At least two task families/)
})

test('a missing analysis declaration does not acquire a primary endpoint or confirmatory label', async () => {
  const spec = legacyStarter(); delete spec.analysisPlan
  const summary = (await runStudy(await freezeStudy(spec))).summary
  assert.equal(summary.cohort, 'undeclared'); assert.equal(summary.groups[0].primaryRate, null)
  assert.ok(summary.limitations.some(text => text.includes('No structured analysis plan')))
  const crossed = familyStudy(); delete crossed.analysisPlan; crossed.tasks[1].split = 'held-out'
  await assert.rejects(freezeStudy(crossed), /cannot cross development/, 'family split integrity also applies without an analysis plan')
})

test('HTML, Markdown, SVG and canonical analysis derive reproducibly from the same validated journal', async () => {
  const spec = familyStudy(); spec.name = 'A <script>alert("x")</script> study'
  const project = await freezeStudy(spec), result = await runStudy(project)
  const files = await researchReportFiles(project, result.events)
  assert.deepEqual(await researchReportFiles(project, result.events), files)
  const artifact = JSON.parse(files['analysis.json'])
  assert.deepEqual(artifact.summary, result.summary)
  assert.equal(artifact.journalSha256, await sha256(canonical(result.events)))
  assert.equal(artifact.summarySha256, await sha256(canonical(result.summary)))
  assert.deepEqual(await analysisArtifact(project, result.events), artifact)
  assert.match(files['report.html'], /Apparatus-development report/)
  assert.equal(artifact.summary.execution.purpose, 'apparatus-development')
  assert.equal(artifact.summary.execution.experimentalCollection, 'not-admitted')
  assert.match(files['report.html'], /Development computations; no scientific inference/)
  assert.match(files['report.html'], /Passed \/ scheduled/)
  assert.match(files['report.html'], /&lt;script&gt;/)
  assert.doesNotMatch(files['report.html'], /<script>/)
  assert.match(files['report.md'], /first-second/)
  assert.match(files['figures/disposition.svg'], /n = 4/)
  assert.match(files['report.html'], new RegExp(artifact.summarySha256))
  const forged = structuredClone(result.events); forged.find(event => event.type === 'finished').grade.passed = !forged.find(event => event.type === 'finished').grade.passed
  await assert.rejects(researchReportFiles(project, forged), /recorded grade disagrees/)
})
