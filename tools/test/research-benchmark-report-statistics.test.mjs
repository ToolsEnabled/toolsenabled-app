// Statistics the Research report prints: the Bonferroni family size for design-arm
// contrasts, the abstract headline's population and denominator, a degenerate
// bootstrap interval, and abstract number formatting. Synthetic recorded
// responses only; no collected model output.
//
// A degenerate interval is reported here, not withheld: the report keeps the
// number and names it as carrying no information about uncertainty, so the reader
// sees both the point estimate and why it has no width. The abstract must say so
// too, because it is read on its own.
import assert from 'node:assert/strict'
import test from 'node:test'
import { DESIGN_PLAN_VERSION } from '../../src/benchmark/analysis.mjs'
import { freezeStudy } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { developmentStarter } from './fixtures/research-benchmark-development.mjs'

// Six tasks in three families, so a family bootstrap has three clusters.
function tasksOf(spec, count = 6) {
  const template = spec.tasks[0]
  return Array.from({ length: count }, (_, i) => ({ ...structuredClone(template), id: `task-${i + 1}`,
    // A family may not cross splits, so the split prefixes the family id.
    familyId: `family-${i < 3 ? 'dev' : 'ho'}-${i % 3}`, split: i < 3 ? 'development' : 'held-out',
    variables: { a: i + 1, b: 10 }, expected: String(i + 11), factors: { depth: i % 2 + 1 } }))
}
const replay = (spec, correct) => Object.fromEntries(spec.tasks.map((task, i) => [task.id, correct(task, i) ? task.expected : 'wrong']))
// report.mjs escapes markdown punctuation with md() before it writes the abstract, so the stored text
// holds `0\.3` where a reader sees `0.3`; undo exactly that escaping so these assertions read as the
// rendered sentence does. The escaped set is the one md() escapes.
const unescapeMd = text => text.replace(/\\([\\`*_{}[\]()#+.!|<>])/g, '$1')
const abstractOf = files => unescapeMd(files['report.md'].split('## Abstract')[1].split('\n## ')[0])

// Three arms over three conditions, two declared arm contrasts, one condition contrast.
async function armStudy() {
  const spec = developmentStarter()
  // A design plan requires specification version 2 or later; the draft is already
  // the current schema, and forcing it back to 2 would pin its runtime inventory
  // to a version whose files this fixture did not bind.
  spec.tasks = tasksOf(spec)
  const pass = (task, i) => i % 3 !== 0
  spec.conditions = ['seq', 'iso', 'third'].map((id, c) => ({ ...spec.conditions[0], id,
    adapter: { kind: 'replay', responses: replay(spec, (task, i) => (c === 0 ? pass(task, i) : c === 1 ? i % 2 === 0 : i < 4)) } }))
  spec.protocol.replicates = 1; spec.protocol.maxTotalAttempts = 1000
  spec.analysisPlan.primaryPopulation = 'all'
  spec.analysisPlan.contrasts = [{ id: 'iso-vs-seq', first: 'iso', second: 'seq' }]
  spec.analysisPlan.multiplicity = 'bonferroni'
  spec.analysisPlan.uncertainty = { kind: 'family-bootstrap', seed: 4242, iterations: 2000, confidence: 0.95 }
  spec.designPlan = { version: DESIGN_PLAN_VERSION, rationale: 'Three synthetic arms, one per condition, with two declared arm contrasts.',
    arms: [{ id: 'a-seq', conditionIds: ['seq'] }, { id: 'a-iso', conditionIds: ['iso'] }, { id: 'a-third', conditionIds: ['third'] }],
    contrasts: [{ id: 'iso-vs-seq-arm', first: 'a-iso', second: 'a-seq' }, { id: 'third-vs-seq-arm', first: 'a-third', second: 'a-seq' }] }
  return runStudy(await freezeStudy(spec))
}

test('Bonferroni divides by the number of contrasts actually being reported, so two arm contrasts are wider than one condition contrast', async () => {
  const { summary } = await armStudy()
  const condition = summary.contrasts.find(row => row.id === 'iso-vs-seq')
  const arm = summary.design.contrasts.find(row => row.id === 'iso-vs-seq-arm')
  assert.ok(condition?.interval && arm?.interval, 'both contrasts need an interval for this comparison')
  assert.equal(condition.difference, arm.difference)
  assert.equal(arm.interval.multiplicity, 'bonferroni')
  // One condition contrast gives alpha/1; two simultaneous arm contrasts give alpha/2, which is strictly wider.
  assert.ok(arm.interval.high - arm.interval.low > condition.interval.high - condition.interval.low,
    `arm interval ${arm.interval.low}..${arm.interval.high} must be wider than condition interval ${condition.interval.low}..${condition.interval.high}`)
})

test('the abstract headline reports the declared primary population with the denominator it names', async () => {
  const spec = developmentStarter()
  spec.tasks = tasksOf(spec)
  // Development tasks all pass; held-out tasks all fail. All-task and held-out rates therefore differ.
  spec.conditions = [{ ...spec.conditions[0], id: 'only', adapter: { kind: 'replay', responses: replay(spec, task => task.split === 'development') } }]
  spec.protocol.replicates = 1; spec.protocol.maxTotalAttempts = 1000
  spec.analysisPlan.primaryPopulation = { kind: 'split', split: 'held-out' }
  spec.analysisPlan.contrasts = []
  const project = await freezeStudy(spec), result = await runStudy(project)
  const summary = result.summary, group = summary.groups[0]
  assert.equal(group.primary.scheduled, 3); assert.equal(group.scheduled, 6)
  assert.equal(group.primaryRate, 0); assert.equal(group.scheduledPassRate, 0.5)
  const abstract = abstractOf(await researchReportFiles(project, result.events))
  assert.match(abstract, /Headline: only 0\/3 \(0\.0%\)/, `headline must be the held-out primary population, got: ${abstract}`)
})

test('a bootstrap whose resamples are all identical is named as carrying no uncertainty, in the tables and in the abstract', async () => {
  const spec = developmentStarter()
  spec.tasks = tasksOf(spec)
  // Both conditions answer every task correctly: every resampled difference is exactly 0.
  spec.conditions = [{ ...spec.conditions[0], id: 'first', adapter: { kind: 'replay', responses: replay(spec, () => true) } },
    { ...spec.conditions[0], id: 'second', adapter: { kind: 'replay', responses: replay(spec, () => true) } }]
  spec.protocol.replicates = 1; spec.protocol.maxTotalAttempts = 1000
  spec.analysisPlan.primaryPopulation = 'all'
  spec.analysisPlan.contrasts = [{ id: 'first-second', first: 'first', second: 'second' }]
  spec.analysisPlan.uncertainty = { kind: 'family-bootstrap', seed: 11, iterations: 500, confidence: 0.95 }
  const project = await freezeStudy(spec), result = await runStudy(project)
  const contrast = result.summary.contrasts[0]
  assert.equal(contrast.difference, 0)
  // The interval is kept, so summary.json keeps its shape and the point estimate stays visible.
  assert.equal(contrast.interval.low, 0); assert.equal(contrast.interval.high, 0)
  const files = await researchReportFiles(project, result.events)
  const degenerate = /Degenerate: every resample gave the same value, so this interval carries no information about uncertainty and is not a confidence interval\./
  // The contrasts table names it.
  assert.match(unescapeMd(files['report.md']), degenerate, 'the contrasts table must name the degenerate interval')
  // And so must the abstract, which is read on its own and otherwise calls it a confidence interval.
  assert.match(abstractOf(files), degenerate, `the abstract must name the degenerate interval, got: ${abstractOf(files)}`)
})

test('the abstract prints contrast numbers at report precision, not raw doubles', async () => {
  const spec = developmentStarter()
  spec.tasks = tasksOf(spec, 10)
  spec.conditions = [{ ...spec.conditions[0], id: 'first', adapter: { kind: 'replay', responses: replay(spec, () => true) } },
    { ...spec.conditions[0], id: 'second', adapter: { kind: 'replay', responses: replay(spec, (task, i) => i < 7) } }]
  spec.protocol.replicates = 1; spec.protocol.maxTotalAttempts = 1000
  spec.analysisPlan.primaryPopulation = 'all'
  spec.analysisPlan.contrasts = [{ id: 'first-second', first: 'first', second: 'second' }]
  spec.analysisPlan.uncertainty = { kind: 'family-bootstrap', seed: 5, iterations: 500, confidence: 0.95 }
  const project = await freezeStudy(spec), result = await runStudy(project)
  assert.equal(result.summary.contrasts[0].difference, 1 - 0.7) // 0.30000000000000004
  const abstract = abstractOf(await researchReportFiles(project, result.events))
  assert.doesNotMatch(abstract, /\d\.\d{8,}/, `the abstract must not print raw doubles: ${abstract}`)
  assert.match(abstract, /differs by 0\.3\b/)
})

test('a span over fewer clusters than the coverage minimum is named a resampling range, not a level', async () => {
  const spec = developmentStarter()
  // Four families, below the five-cluster coverage minimum, and deliberately not degenerate:
  // one family differs between the conditions and three do not, so the resamples vary.
  spec.tasks = tasksOf(spec, 4)
  spec.conditions = [{ ...spec.conditions[0], id: 'first', adapter: { kind: 'replay', responses: replay(spec, (task, i) => i < 2) } },
    { ...spec.conditions[0], id: 'second', adapter: { kind: 'replay', responses: replay(spec, (task, i) => i < 1) } }]
  spec.protocol.replicates = 1; spec.protocol.maxTotalAttempts = 1000
  spec.analysisPlan.primaryPopulation = 'all'
  spec.analysisPlan.contrasts = [{ id: 'first-second', first: 'first', second: 'second' }]
  spec.analysisPlan.uncertainty = { kind: 'family-bootstrap', seed: 3, iterations: 500, confidence: 0.95 }
  const project = await freezeStudy(spec), result = await runStudy(project)
  const contrast = result.summary.contrasts[0]
  assert.equal(contrast.families, 4)
  assert.ok(contrast.interval, 'the span is still computed and printed; only its name changes')
  assert.notEqual(contrast.interval.low, contrast.interval.high, 'this case must not also be degenerate')
  const files = await researchReportFiles(project, result.events), md = unescapeMd(files['report.md'])
  // The table names it a range instead of a level.
  assert.match(md, /Resampling range \(too few clusters for coverage\): 4 clusters resampled, fewer than 5/)
  assert.doesNotMatch(md, /Level 0\.95; endpoints read/)
  // So does the abstract, which is read on its own.
  assert.match(abstractOf(files), /resampling range \(too few clusters for coverage\): 4 clusters resampled, fewer than the 5/)
  // And the methods text states the minimum and the reason for it.
  // The rule must be checkable from the report alone, and the threshold must not read as though
  // the cited work prescribed it.
  assert.match(md, /reported as a resampling range \(too few clusters for coverage\) rather than at its nominal level\./)
  assert.match(md, /The threshold of 5 is this template\u2019s own rule, not a value taken from the literature/)
  assert.match(md, /C\(2G-1, G\) distinct multisets, which is 3 at 2 clusters, 10 at 3, 35 at 4 and 126 at 5/)
  assert.match(md, /The cited work establishes that cluster-robust inference is unreliable with few clusters; it does not prescribe this threshold/)
})
