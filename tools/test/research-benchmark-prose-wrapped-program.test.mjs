import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'
import { sha256 } from '../../src/benchmark/prompts.mjs'
import { pythonSource } from '../../src/benchmark/lean-observations.mjs'
import { gradeLean } from '../../src/benchmark/lean-grade.mjs'
import { deriveReadinessContract, evaluateReadiness } from '../../src/benchmark/readiness.mjs'
import { nativeEvidencePaths } from '../../src/benchmark/audit.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'

// A reply with prose around one fenced program used to reach the engine whole: pythonSource
// returned any text that did not start with a fence, the markdown became main.py, and the
// grade said the model's program crashed (execution-error) although that program never ran.
// The fixture is the claude-cli reply retained by lean-bench run 5b6ed8d2. That run leaked
// tools to the model and does not qualify; the reply is a real shape, not the run of record.
// Its recorded candidateSha256 is the hash of the whole reply, so the engine received all of it.
// The protocol refuses such a reply before any container; it never extracts the block.
const fixture = JSON.parse(await readFile(new URL('./fixtures/research-benchmark-prose-wrapped-reply.json', import.meta.url), 'utf8'))
const program = 'from AlgorithmImports import *\nclass FrozenBenchmark(QCAlgorithm):\n    def Initialize(self):\n        pass\n'
const block = '```python\n' + program + '```'
const violation = /text outside its code block/

test('the retained prose-wrapped reply is refused as a program, and it is exactly what the engine was given', async () => {
  assert.equal(await sha256(fixture.output), fixture.recordedGrade.candidateSha256)
  assert.equal(fixture.recordedGrade.classification, 'execution-error')
  assert.throws(() => pythonSource(fixture.output), violation)
})

test('prose then a block is refused like a block then prose; a bare program or one block alone is accepted', () => {
  assert.throws(() => pythonSource('Here is the algorithm.\n' + block), violation)
  assert.equal(pythonSource(block), program.trimEnd())
  assert.throws(() => pythonSource(block + '\nIt buys two shares.'), /surrounding prose/)
  assert.equal(pythonSource(program), program.trim())
})

test('a code block after any kind of prose is refused', () => {
  for (const reply of ["Here's the program:\n\n" + block, 'Fills:\n| bar | qty |\n|---|---|\n| 1 | 2 |\n\n' + block + '\n\nDone.',
    'Here it is:\n   ```python\n' + program + '   ```', 'First:\n' + block + '\nSecond:\n' + block, program + '\nAs a block:\n' + block]) {
    assert.throws(() => pythonSource(reply), violation, JSON.stringify(reply.slice(0, 30)))
  }
})

test('a bare program keeps code fences inside its strings and comments, byte for byte', () => {
  for (const source of [
    'from AlgorithmImports import *\nclass FrozenBenchmark(QCAlgorithm):\n    """Buys two shares.\n\n    ```python\n    self.MarketOrder("SPY", 2)\n    ```\n    """\n    def Initialize(self):\n        pass',
    '"""Frozen benchmark.\n\n```python\nFrozenBenchmark()\n```\n"""\n' + program,
    program + "EXAMPLE = '''\n```python\nprint(1)\n```\n'''",
    program + 'TEXT = """a \\""" b\n```\n"""',
    program + "QUOTE = r'\\''\nDOC = \"\"\"\n```\n\"\"\"",
    program + '    # ```python is not code here\n# ```',
  ]) assert.equal(pythonSource(source), source.trim())
})

test('the grader records the retained reply as a format violation at extraction, before any engine preparation', async () => {
  const spec = leanStarter(), task = await compileTask(spec, spec.tasks[0], { requireReview: false, requireTaskReview: false })
  const phases = [], measure = { span: (kind, work) => { phases.push(kind); return work() } }
  // An unpinned image stops the grader before any directory, data or container work, so a
  // reply that got past extraction fails here loudly instead of reaching Docker.
  const project = { sha256: 'a'.repeat(64), spec: { environment: { leanImage: 'unpinned' }, protocol: { grading: { kind: 'lean-python' } } } }
  const grade = await gradeLean(project, task, fixture.output, { measure })
  assert.deepEqual(phases, ['program-extraction'])
  assert.deepEqual({ ...grade, reason: undefined }, { passed: false, score: 0, classification: 'format-violation', reason: undefined })
  assert.match(grade.reason, violation)
})

// The readiness project mirrors research-benchmark-replay-response-grader.test.mjs.
async function recordedBlockers(response) {
  const spec = leanStarter()
  spec.schemaVersion = 2
  spec.executionPlan = { version: 1, purpose: 'apparatus-development' }
  Object.assign(spec.analysisPlan, { primaryPopulation: 'all', primaryDenominator: 'scheduled', uncertainty: null, multiplicity: 'none-descriptive' })
  spec.protocol.grading = { kind: 'lean-python' }
  spec.environment.leanImage = 'image@sha256:' + 'a'.repeat(64)
  spec.conditions[0].adapter.responses['flat-canary'] = response
  const tasks = await Promise.all(spec.tasks.map(task => compileTask(spec, task, { requireReview: false, requireTaskReview: false })))
  const schedule = tasks.flatMap(task => spec.conditions.flatMap(condition => Array.from({ length: spec.protocol.replicates }, (_, index) =>
    ({ id: `${task.id}.${condition.id}.${index + 1}`, taskId: task.id, conditionId: condition.id, replicate: index + 1 }))))
  const runtimeFiles = ['prompts.mjs', 'readiness.mjs']
  spec.runtimeSources = Object.fromEntries(await Promise.all(runtimeFiles.map(async file => [file, await sha256('static-unit-source:' + file)])))
  const project = { format: 'research-benchmark', version: 2, spec, tasks, schedule, runtimeFiles }
  project.readiness = await deriveReadinessContract(project)
  return evaluateReadiness(project, { operation: 'apparatus-development' }).blockers.filter(row => row.path.includes('recorded') && row.path.includes('flat-canary'))
}

test('readiness refuses a recorded { code } response wrapped in prose; the same text as a string stays a visible negative control', async () => {
  const refused = await recordedBlockers({ code: fixture.output })
  assert.equal(refused.length, 1)
  assert.match(refused[0].message, violation)
  assert.deepEqual(await recordedBlockers(fixture.output), [])
})

// THE GRADE HAS TO BE THE ONE THE GRADER MAKES. Written as a literal, this test passed for
// `correct` and for a nonsense string alike: the planner's loop reads whether the retained grade
// records a candidate hash, never the class, and a literal grade carried no hash, so the extractor
// was never reached. Grading the reply for real supplies both halves the name claims -- the class,
// and the absence of a hash that is what actually empties the plan.
test('native evidence planning asks for no program files for the retained reply, matching its format-violation grade', async () => {
  const trialId = 'flat-canary.claude-cli.1'
  const plan = grade => {
    const project = { version: 2, sha256: 'b'.repeat(64), tasks: [{ id: 'flat-canary', compiled: {} }], schedule: [{ id: trialId, taskId: 'flat-canary' }],
      spec: { schemaVersion: 2, inputs: [], protocol: { grading: { kind: 'lean-python' }, maxAttemptsPerTrial: 1, maxTotalAttempts: 1 },
        runtimeSources: Object.fromEntries(RUNTIME_FILES.map(file => [file, 'c'.repeat(64)])) } }
    const attempt = { trialId, attempt: 1, response: { output: fixture.output }, grade }
    return nativeEvidencePaths(project, [attempt]).files.filter(row => row.key.startsWith('native/')).map(row => row.key)
  }
  const spec = leanStarter(), task = await compileTask(spec, spec.tasks[0], { requireReview: false, requireTaskReview: false })
  const subject = { sha256: 'a'.repeat(64), spec: { environment: { leanImage: 'unpinned' }, protocol: { grading: { kind: 'lean-python' } } } }
  const grade = await gradeLean(subject, task, fixture.output, { measure: { span: (kind, work) => work() } })
  assert.equal(grade.classification, 'format-violation')
  assert.equal(Object.hasOwn(grade, 'candidateSha256'), false)
  assert.deepEqual(plan(grade), [])
  // The contrast that makes the empty plan mean something. The run of record DID hand the whole
  // reply to the engine, so the grade it retained carries a candidate hash, and its artifacts are
  // still asked for whatever today's extractor makes of that reply. Without this arm the line
  // above passes even if the loop stops reading the attempt at all.
  assert.deepEqual(plan(fixture.recordedGrade), [`native/${trialId}-1/main.py`, `native/${trialId}-1/config.json`,
    `native/${trialId}-1/execution.json`, `native/${trialId}-1/result.json`, `native/${trialId}-1/order-events.json`])
})
