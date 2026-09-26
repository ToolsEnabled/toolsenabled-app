import test from 'node:test'
import assert from 'node:assert/strict'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'
import { sha256 } from '../../src/benchmark/prompts.mjs'
import { deriveReadinessContract, evaluateReadiness, assertCollectionAdmission } from '../../src/benchmark/readiness.mjs'

// The shipped Lean Bench starter replays its known trace (a JSON array) because
// its own grading is JSON. Switch the study to the documented native grader,
// lean-python, keep that canary, and every gate used to pass while the canary was
// guaranteed to record `no-program` -- after the engine run had been paid for.
// Measured on a real run: the recorded condition graded "no-program" while
// freeze, verify and qualify were all green. Readiness must say so before collection.

async function project(mutate = () => {}) {
  const spec = leanStarter()
  spec.schemaVersion = 2
  spec.executionPlan = { version: 1, purpose: 'apparatus-development' }
  spec.analysisPlan.primaryPopulation = 'all'
  spec.analysisPlan.primaryDenominator = 'scheduled'
  spec.analysisPlan.uncertainty = null
  spec.analysisPlan.multiplicity = 'none-descriptive'
  spec.protocol.grading = { kind: 'lean-python' }
  spec.environment.leanImage = 'image@sha256:' + 'a'.repeat(64)
  mutate(spec)
  const tasks = await Promise.all(spec.tasks.map(task => compileTask(spec, task, { requireReview: false, requireTaskReview: false })))
  const schedule = tasks.flatMap(task => spec.conditions.flatMap(condition => Array.from({ length: spec.protocol.replicates }, (_, index) =>
    ({ id: `${task.id}.${condition.id}.${index + 1}`, taskId: task.id, conditionId: condition.id, replicate: index + 1 }))))
  const runtimeFiles = ['prompts.mjs', 'readiness.mjs']
  spec.runtimeSources = Object.fromEntries(await Promise.all(runtimeFiles.map(async file => [file, await sha256('static-unit-source:' + file)])))
  const result = { format: 'research-benchmark', version: 2, spec, tasks, schedule, runtimeFiles }
  result.readiness = await deriveReadinessContract(result)
  return result
}

const development = candidate => evaluateReadiness(candidate, { operation: 'apparatus-development' })
const naming = (blockers, conditionId, taskId) => blockers.filter(row => row.path.includes(conditionId) && row.path.includes(taskId))
const program = 'from AlgorithmImports import *\nclass FrozenBenchmark(QCAlgorithm):\n    def Initialize(self):\n        pass\n'

test('a recorded replay response the native grader cannot read as a program is refused before collection, naming the condition and task', async () => {
  const shipped = await project()
  const result = development(shipped)
  assert.equal(result.eligible, false, 'a canary that can only grade no-program must not be admitted')
  assert.equal(naming(result.blockers, 'recorded', 'flat-canary').length, 1, 'the refusal names exactly which recorded response is unusable')
  assert.throws(() => assertCollectionAdmission(shipped, { operation: 'apparatus-development' }), /recorded|flat-canary|program/i)
  // The refusal is part of the frozen contract, so verify/readiness output shows it too.
  assert.equal(naming(shipped.readiness.blockers, 'recorded', 'flat-canary').length, 1)
})

test('a recorded response that is a program, as a string, { code } or one fenced block, is admitted', async () => {
  for (const response of [program, { code: program }, '```python\n' + program + '```']) {
    const candidate = await project(spec => { spec.conditions[0].adapter.responses['flat-canary'] = response })
    const result = development(candidate)
    assert.deepEqual(naming(result.blockers, 'recorded', 'flat-canary'), [])
    assert.equal(result.eligible, true, `a genuine program response must stay admissible: ${JSON.stringify(result.blockers)}`)
  }
})

test('any structured JSON answer the native grader cannot read as a program is refused, not only the starter trace', async () => {
  for (const response of [[], { trace: [] }, { code: 42 }, { answer: 'x' }]) {
    const candidate = await project(spec => { spec.conditions[0].adapter.responses['flat-canary'] = response })
    assert.equal(naming(development(candidate).blockers, 'recorded', 'flat-canary').length, 1, `structured non-program answer admitted: ${JSON.stringify(response)}`)
  }
})

test('an explicit empty response stays admissible as a negative control; the grader still classifies it no-program in the open', async () => {
  for (const response of [null, '']) {
    const candidate = await project(spec => { spec.conditions[0].adapter.responses['flat-canary'] = response })
    assert.deepEqual(naming(development(candidate).blockers, 'recorded', 'flat-canary'), [], `a deliberate absent-program control was refused: ${JSON.stringify(response)}`)
  }
})

test('the shipped starter under its own JSON grading is unaffected: a trace is the right answer shape there', async () => {
  const json = await project(spec => { spec.protocol.grading = { kind: 'json' } })
  const result = development(json)
  assert.deepEqual(naming(result.blockers, 'recorded', 'flat-canary'), [])
  assert.equal(result.eligible, true, JSON.stringify(result.blockers))
})
