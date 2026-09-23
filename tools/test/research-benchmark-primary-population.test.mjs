import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES, verifyProject } from '../../src/benchmark/study.mjs'
import { analyze, resolveAnalysisPopulation } from '../../src/benchmark/analysis.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { readProject } from '../../src/benchmark/cli.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { materializeAudit } from '../../src/benchmark/audit.mjs'
import { primaryPopulationFixture } from './fixtures/research-benchmark-primary-population.mjs'
import { auditFixture } from './fixtures/research-benchmark-audit.mjs'
import { developmentDraft } from './fixtures/research-benchmark-development.mjs'

const runtimeSources = async () => Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const group = (summary, id) => summary.groups.find(row => row.condition === id)
const withBootstrap = spec => {
  spec.analysisPlan.uncertainty = { kind: 'family-bootstrap', seed: 734, iterations: 200, confidence: 0.95 }
  return spec
}

test('held-out primary rates reverse the all-trial ranking without removing development outcomes', async () => {
  const project = await freezeStudy(primaryPopulationFixture()), result = await runStudy(project), summary = result.summary
  assert.equal(group(summary, 'first').scheduledPassRate, 0.9)
  assert.equal(group(summary, 'second').scheduledPassRate, 0.1)
  assert.equal(group(summary, 'first').primaryRate, 0)
  assert.equal(group(summary, 'second').primaryRate, 1)
  assert.equal(summary.contrasts[0].difference, -1)
  assert.equal(summary.contrasts[0].firstRate, 0); assert.equal(summary.contrasts[0].secondRate, 1)
  assert.equal(summary.scheduled, 20); assert.equal(summary.completed, 20)
  assert.equal(summary.primaryPopulation.scheduled, 2); assert.equal(summary.primaryPopulation.excludedScheduled, 18)
  for (const row of summary.groups) {
    assert.equal(row.scheduled, 10); assert.equal(row.primary.scheduled, 1)
    assert.equal(row.primary.measured, 1); assert.equal(row.primary.excludedScheduled, 9)
  }
  assert.equal(summary.rows.filter(row => row.primaryIncluded).length, 2)
  assert.ok(summary.rows.filter(row => !row.primaryIncluded).every(row => row.split === 'development'
    && typeof row.primaryExclusionReason === 'string' && row.primaryExclusionReason.length > 0))
  assert.deepEqual(project.primaryPopulation, resolveAnalysisPopulation(project.spec))
  assert.deepEqual(analyze(project, JSON.parse(canonical(result.events))), summary)
})

test('uncollected primary trials keep scheduled denominators and never borrow completed development responses', async () => {
  for (const denominator of ['scheduled', 'completed']) {
    const spec = primaryPopulationFixture(); spec.analysisPlan.primaryDenominator = denominator
    const project = await freezeStudy(developmentDraft(spec)), pending = analyze(project, [])
    assert.equal(pending.primaryPopulation.scheduled, 2)
    for (const row of pending.groups) {
      assert.equal(row.primary.scheduled, 1); assert.equal(row.primary.measured, 0)
      assert.equal(row.primary.scheduledPassRate, 0); assert.equal(row.primary.passRate, null)
      assert.equal(row.primaryRate, denominator === 'scheduled' ? 0 : null)
    }
    const result = await runStudy(project, { adapter: async ({ task }) => {
      if (task.split === 'held-out') throw new Error('Synthetic held-out collection failure')
      return { output: task.expected }
    } })
    assert.equal(result.summary.completed, 18); assert.equal(result.summary.failed, 2)
    for (const row of result.summary.groups) {
      assert.equal(row.measured, 9); assert.equal(row.passRate, 1)
      assert.equal(row.primary.measured, 0); assert.equal(row.primary.scheduled, 1)
      assert.equal(row.primaryRate, denominator === 'scheduled' ? 0 : null)
      assert.deepEqual(row.primary.dispositions, { 'transport-error': 1 })
    }
    assert.equal(result.summary.contrasts[0].difference, denominator === 'scheduled' ? 0 : null)
    assert.ok(result.summary.rows.filter(row => row.primaryIncluded).every(row => row.passed === null && row.score === null))
  }
})

test('primary family bootstrap excludes development families and does not inflate families with replicates', async () => {
  const one = await runStudy(await freezeStudy(withBootstrap(primaryPopulationFixture({ replicates: 5 }))))
  assert.equal(one.summary.contrasts[0].families, 1)
  assert.equal(one.summary.contrasts[0].interval, null)
  assert.match(one.summary.contrasts[0].intervalReason, /two task families/)
  const two = await runStudy(await freezeStudy(withBootstrap(primaryPopulationFixture({ heldOutTasks: 2 }))))
  const repeated = await runStudy(await freezeStudy(withBootstrap(primaryPopulationFixture({ heldOutTasks: 2, replicates: 5 }))))
  const contrast = two.summary.contrasts[0]
  assert.equal(contrast.families, 2); assert.equal(contrast.difference, -1)
  assert.deepEqual([contrast.interval.low, contrast.interval.high], [-1, -1])
  assert.deepEqual(repeated.summary.contrasts[0], contrast)
  const excludedWithoutFamilies = withBootstrap(primaryPopulationFixture({ heldOutTasks: 2 }))
  for (const task of excludedWithoutFamilies.tasks) if (task.split === 'development') delete task.familyId
  const selectedOnly = await runStudy(await freezeStudy(excludedWithoutFamilies))
  assert.deepEqual(selectedOnly.summary.contrasts[0], contrast)
})

test('an explicit task set preserves the declaration while resolving stable frozen task membership', async () => {
  const spec = primaryPopulationFixture(), declared = ['held-out-1', 'development-2']
  spec.analysisPlan.primaryPopulation = { kind: 'task-set', taskIds: declared }
  const population = resolveAnalysisPopulation(spec)
  assert.deepEqual(population.selection, { kind: 'task-set', taskIds: declared })
  assert.deepEqual(population.taskIds, ['development-2', 'held-out-1'])
  assert.deepEqual(population.ledger.map(row => row.taskId), spec.tasks.map(task => task.id))
  assert.deepEqual(population.ledger.filter(row => row.included).map(row => row.taskId), population.taskIds)
  assert.ok(population.ledger.every(row => row.split === spec.tasks.find(task => task.id === row.taskId).split))
  assert.equal(typeof population.label, 'string'); assert.ok(population.label.length > 0)
  const project = await freezeStudy(spec), secondFreeze = await freezeStudy(structuredClone(spec))
  assert.deepEqual(project.primaryPopulation, population); assert.equal(secondFreeze.sha256, project.sha256)
  const summary = (await runStudy(project)).summary
  assert.equal(summary.primaryPopulation.scheduled, 4); assert.equal(summary.primaryPopulation.excludedScheduled, 16)
  assert.ok(summary.groups.every(row => row.primary.scheduled === 2 && row.primaryRate === 0.5))
  assert.equal(summary.contrasts[0].difference, 0)
  const altered = structuredClone(project)
  altered.primaryPopulation.taskIds = ['development-1']
  const { sha256: oldHash, ...body } = altered; altered.sha256 = await sha256(canonical(body))
  await assert.rejects(verifyProject(altered), /frozen project changed/i)
})

test('bad, empty, duplicate and unsupported primary declarations cannot silently fall back to all tasks', async () => {
  const selectors = [null, 'held-out', 'reference-eligible', {}, { kind: 'all' },
    { kind: 'split', split: 'unknown' }, { kind: 'split', split: 'held-out', taskIds: ['development-1'] },
    { kind: 'task-set', taskIds: [] }, { kind: 'task-set', taskIds: ['missing-task'] },
    { kind: 'task-set', taskIds: ['held-out-1', 'held-out-1'] }, { kind: 'task-set', taskIds: [null] },
    { kind: 'task-set', taskIds: ['held-out-1'], outcome: 'passed' }]
  for (const selector of selectors) {
    const spec = primaryPopulationFixture(); spec.analysisPlan.primaryPopulation = selector
    await assert.rejects(freezeStudy(spec), undefined, 'The invalid selector was accepted: ' + JSON.stringify(selector))
  }
  const absent = primaryPopulationFixture({ heldOutTasks: 0 })
  await assert.rejects(freezeStudy(absent), /population|select|empty|task/i)
  for (const change of [
    spec => { spec.analysisPlan.primarySplit = 'held-out' },
    spec => { spec.analysisPlan.outcomeFilter = 'passed' },
    spec => { spec.analysisPlan.contrasts[0].primarySplit = 'development' },
    spec => { withBootstrap(spec).analysisPlan.uncertainty.unit = 'trial' },
  ]) {
    const spec = primaryPopulationFixture(); change(spec)
    await assert.rejects(freezeStudy(spec), /unsupported|field|analysis|contrast|uncertainty/i)
  }
})

test('legacy all-task plans remain all-task and a missing plan creates no primary endpoint', async () => {
  for (const explicit of [false, true]) {
    const spec = primaryPopulationFixture()
    if (explicit) spec.analysisPlan.primaryPopulation = 'all'
    else delete spec.analysisPlan.primaryPopulation
    const population = resolveAnalysisPopulation(spec)
    assert.equal(population.selection, 'all')
    assert.deepEqual(population.taskIds, spec.tasks.map(task => task.id))
    const summary = (await runStudy(await freezeStudy(spec))).summary
    assert.equal(group(summary, 'first').primaryRate, 0.9)
    assert.equal(group(summary, 'second').primaryRate, 0.1)
    assert.equal(summary.primaryPopulation.excludedScheduled, 0)
  }
  const spec = primaryPopulationFixture(); delete spec.analysisPlan
  assert.equal(resolveAnalysisPopulation(spec), null)
  const summary = (await runStudy(await freezeStudy(spec))).summary
  assert.equal(summary.primaryPopulation, null)
  assert.ok(summary.groups.every(row => row.primary === null && row.primaryRate === null))
  assert.ok(summary.rows.every(row => row.primaryIncluded === false && row.primaryExclusionReason === 'no-primary-plan'))
})

test('audit reference eligibility remains frozen and cannot be replaced by an ordinary selector', async () => {
  const { spec } = await auditFixture(await runtimeSources())
  spec.auditPlan.criterion.kind = 'admissible-witness'; spec.tasks = (await materializeAudit(spec.auditPlan)).tasks
  const population = resolveAnalysisPopulation(spec)
  assert.equal(population.selection, 'reference-eligible')
  const eligible = spec.tasks.filter(task => task.audit.referenceVerdict !== null).map(task => task.id)
  assert.deepEqual(population.taskIds, eligible)
  assert.ok(eligible.length > 0 && eligible.length < spec.tasks.length)
  assert.deepEqual(population.ledger.filter(row => !row.included).map(row => row.taskId), spec.tasks.filter(task => task.audit.referenceVerdict === null).map(task => task.id))
  for (const selector of ['all', { kind: 'split', split: 'held-out' }, { kind: 'task-set', taskIds: eligible }]) {
    const changed = structuredClone(spec); changed.analysisPlan.primaryPopulation = selector
    await assert.rejects(freezeStudy(changed), /reference-eligible/)
  }
})

test('portable verification rejects a false or missing population artifact even when its manifest is rehashed', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'primary-population-export-')); t.after(() => rm(root, { recursive: true, force: true }))
  const sources = await runtimeSources(), project = await freezeStudy(await bindRuntimeSources(primaryPopulationFixture(), sources))
  const files = await projectFiles(project, sources)
  assert.deepEqual(JSON.parse(files['analysis/population.json']), project.primaryPopulation)
  for (const [file, bytes] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), bytes) }
  assert.equal((await readProject(root)).sha256, project.sha256)
  const manifest = JSON.parse(files['manifest.json']), falsePopulation = structuredClone(project.primaryPopulation)
  falsePopulation.taskIds = ['development-1']
  falsePopulation.ledger.forEach(row => { row.included = row.taskId === 'development-1' })
  const changedBytes = JSON.stringify(falsePopulation, null, 2) + '\n'
  await writeFile(resolve(root, 'analysis/population.json'), changedBytes)
  manifest.files['analysis/population.json'] = await sha256(changedBytes)
  await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await assert.rejects(readProject(root), /population|analysis artifact/i)
  await writeFile(resolve(root, 'analysis/population.json'), files['analysis/population.json'])
  delete manifest.files['analysis/population.json']
  await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await assert.rejects(readProject(root), /population|analysis artifact/i)
})

test('primary report artifacts expose the selected comparison alongside the complete trial ledger', async () => {
  const project = await freezeStudy(primaryPopulationFixture()), result = await runStudy(project)
  const files = await researchReportFiles(project, result.events)
  const summary = JSON.parse(files['analysis.json']).summary
  assert.equal(summary.contrasts[0].difference, -1)
  assert.equal(group(summary, 'first').scheduledPassRate, 0.9)
  assert.equal(group(summary, 'first').primaryRate, 0)
  assert.ok(files['tables/primary-population.csv'].includes('development-1'))
  assert.ok(files['tables/primary-population.csv'].includes('held-out-1'))
  assert.ok(files['tables/primary-rates.csv'].includes('first'))
  assert.ok(files['tables/primary-rates.csv'].includes('second'))
  const scope = '"legacy","legacy-evidence","not-admitted","[]"'
  assert.ok(files['tables/primary-rates.csv'].split('\n').includes('"first","1","1","0","0.0%","9",' + scope))
  assert.ok(files['tables/primary-rates.csv'].split('\n').includes('"second","1","1","1","100.0%","9",' + scope))
  assert.ok(files['tables/rates.csv'].split('\n').includes('"first","10","10","9","0","90.0%","90.0%",' + scope))
  assert.match(files['report.html'], /primary-rates\.csv/)
  assert.match(files['report.md'], /primary-population\.csv/)
  assert.deepEqual(await researchReportFiles(project, JSON.parse(canonical(result.events))), files)
})
