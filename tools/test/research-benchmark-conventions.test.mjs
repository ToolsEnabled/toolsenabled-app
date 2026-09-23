import assert from 'node:assert/strict'
import test from 'node:test'
import { freezeStudy } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { interpretationObservation } from '../../src/benchmark/conventions.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { informationFixture } from './fixtures/research-benchmark-information.mjs'
import { developmentDraft } from './fixtures/research-benchmark-development.mjs'

function ambiguousConventions() {
  const spec = developmentDraft(informationFixture()), information = spec.tasks[0].information
  information.responseMode = 'tagged-json'
  information.readings[0].conventions = { default: 'low' }
  information.readings[1].conventions = { default: 'high' }
  const third = structuredClone(information.readings[0])
  third.id = 'number-3'; third.root.slots.rule.params.value = 3; third.conventions.default = 'high'
  information.readings.push(third)
  spec.protocol.replicates = 4; spec.protocol.maxAttemptsPerTrial = 1
  return spec
}

test('equivalent readings count once and unresolved conventions retain their mass beside clarification and missing collection', async () => {
  const project = await freezeStudy(ambiguousConventions())
  const result = await runStudy(project, { adapter: async ({ trial }) => {
    if (trial.replicate === 4) throw new Error('Synthetic transport failure')
    return { output: trial.replicate === 3 ? { kind: 'clarification', message: 'Which number?' } : { kind: 'answer', answer: trial.replicate } }
  } })
  const ambiguous = result.summary.rows.find(row => row.replicate === 1)
  assert.deepEqual(ambiguous.information.matchingReadings, ['number-1', 'number-3'])
  assert.deepEqual(ambiguous.information.conventions.default, { kind: 'unresolved' })
  const resolved = result.summary.rows.find(row => row.replicate === 2)
  assert.deepEqual(resolved.information.conventions.default, { kind: 'resolved', value: 'high' })
  const distribution = result.summary.conventions.distributions.find(row => row.dimension === 'convention:default')
  assert.equal(distribution.scheduled, 4); assert.equal(distribution.completed, 3)
  assert.equal(distribution.bins.find(bin => bin.kind === 'unresolved').count, 1)
  assert.equal(distribution.bins.find(bin => bin.value === 'low').count, 0, 'no equal allocation to observationally ambiguous defaults')
  assert.equal(distribution.bins.find(bin => bin.disposition === 'transport-error').completedRate, 0)
  assert.equal(distribution.bins.find(bin => bin.disposition === 'clarification').completedRate, 1 / 3)
  for (const group of result.summary.conventions.distributions) {
    assert.equal(group.bins.reduce((sum, bin) => sum + bin.count, 0), 4)
    assert.equal(group.bins.reduce((sum, bin) => sum + bin.completedCount, 0), 3)
  }
  const files = await researchReportFiles(project, result.events)
  assert.match(files['report.html'], /Admissible \/ scheduled/)
  assert.doesNotMatch(files['report.html'], /Completed incorrect|<th[^>]*>Correct/)
  assert.match(files['report.html'], /Outside-declared-set means/)
  assert.match(files['tables/conventions.csv'], /unresolved/)
  assert.deepEqual(JSON.parse(files['conventions.json']), result.summary.conventions)
})

test('partial observable-class matches and fabricated admissibility cannot be promoted into a resolved convention', async () => {
  const task = (await freezeStudy(ambiguousConventions())).tasks[0]
  assert.throws(() => interpretationObservation(task, { grade: { passed: true, matchingReadings: ['number-1'] } }), /complete observable class/)
  assert.throws(() => interpretationObservation(task, { grade: { passed: true, matchingReadings: [] } }), /needs a frozen observable class/)
  assert.throws(() => interpretationObservation(task, { grade: { passed: false, matchingReadings: ['number-2'] } }), /cannot be recorded as outside/)
})

test('an unmeasured study retains every declared default category and no completed-rate estimates', async () => {
  const project = await freezeStudy(ambiguousConventions())
  const files = await researchReportFiles(project, []), summary = JSON.parse(files['summary.json'])
  const distribution = summary.conventions.distributions.find(row => row.dimension === 'convention:default')
  assert.ok(distribution.bins.filter(bin => bin.kind === 'resolved').every(bin => bin.count === 0))
  assert.ok(distribution.bins.every(bin => bin.completedRate === null))
  assert.equal(distribution.bins.find(bin => bin.disposition === 'not-attempted').count, 4)
})
