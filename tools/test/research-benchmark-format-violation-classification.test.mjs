import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'
import { pythonSource } from '../../src/benchmark/lean-observations.mjs'
// Namespace imports so a missing export fails the assertion that needs it, not the whole file.
import * as observations from '../../src/benchmark/lean-observations.mjs'
import { gradeLean } from '../../src/benchmark/lean-grade.mjs'
import { nativeEvidencePaths } from '../../src/benchmark/audit.mjs'
import * as reporting from '../../src/benchmark/report.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'

// Commit 1 refuses a program wrapped in prose, but records that refusal as no-program, the same
// class as a reply with no program in it at all. A reader of the report then cannot tell three
// things apart: a reply whose program was the wrong SHAPE, a reply with NO program, and a
// program that really ran and CRASHED. This file pins the distinct class.
// The fixture is the claude-cli reply retained by lean-bench run 5b6ed8d2, which leaked tools
// to the model and does not qualify; it is used as a real reply shape, never as a result.
const fixture = JSON.parse(await readFile(new URL('./fixtures/research-benchmark-prose-wrapped-reply.json', import.meta.url), 'utf8'))
const program = 'from AlgorithmImports import *\nclass FrozenBenchmark(QCAlgorithm):\n    def Initialize(self):\n        pass\n'
const block = '```python\n' + program + '```'

// An unpinned image stops the grader before any directory, data or container work, so a reply
// that got past extraction fails loudly here instead of reaching Docker.
const subject = { sha256: 'a'.repeat(64), spec: { environment: { leanImage: 'unpinned' }, protocol: { grading: { kind: 'lean-python' } } } }
async function graded(output) {
  const spec = leanStarter(), task = await compileTask(spec, spec.tasks[0], { requireReview: false, requireTaskReview: false })
  const phases = [], measure = { span: (kind, work) => { phases.push(kind); return work() } }
  return { grade: await gradeLean(subject, task, output, { measure }), phases }
}

test('a program in the wrong shape is classified apart from a reply with no program', async () => {
  const wrongShape = await graded(fixture.output)
  assert.equal(wrongShape.grade.classification, 'format-violation')
  assert.equal(wrongShape.grade.passed, false)
  assert.equal(wrongShape.grade.score, 0)
  assert.match(wrongShape.grade.reason, /text outside its code block/)
  assert.deepEqual(wrongShape.phases, ['program-extraction'])

  const nothing = await graded('')
  assert.equal(nothing.grade.classification, 'no-program')
  assert.match(nothing.grade.reason, /did not return Python source/)
  assert.notEqual(wrongShape.grade.classification, nothing.grade.classification)
})

test('every refusal of the extractor names which of the two it is, without reading its message', () => {
  const cases = [
    ['Here is the algorithm.\n' + block, 'format-violation'],
    [block + '\nIt buys two shares.', 'format-violation'],
    ['First:\n' + block + '\nSecond:\n' + block, 'format-violation'],
    ['', 'no-program'],
    ['   ', 'no-program'],
    [null, 'no-program'],
    [{ trace: [] }, 'no-program'],
  ]
  for (const [output, expected] of cases) {
    let error = null
    try { pythonSource(output) } catch (caught) { error = caught }
    assert.ok(error, 'expected a refusal')
    assert.equal(observations.sourceFailureClassification(error), expected, JSON.stringify(String(output).slice(0, 24)))
  }
})

test('a bare program and one fenced block are still accepted, so the new class never widens the protocol', () => {
  assert.equal(pythonSource(program), program.trim())
  assert.equal(pythonSource(block), program.trimEnd())
  const withDocstring = 'from AlgorithmImports import *\nclass FrozenBenchmark(QCAlgorithm):\n    """Buys two shares.\n\n    ```python\n    self.MarketOrder("SPY", 2)\n    ```\n    """\n    def Initialize(self):\n        pass'
  assert.equal(pythonSource(withDocstring), withDocstring.trim())
})

test('the report explains each grader class in words, and wrong shape, no program and a crash read differently', () => {
  for (const classification of ['format-violation', 'no-program', 'execution-error', 'execution-timeout', 'invalid-engine-result']) {
    const meaning = (reporting.CLASSIFICATION_MEANINGS || {})[classification]
    assert.equal(typeof meaning, 'string', classification)
    assert.ok(meaning.trim().length > 0, classification)
  }
  const meanings = reporting.CLASSIFICATION_MEANINGS || {}
  const shape = meanings['format-violation'], none = meanings['no-program'], crash = meanings['execution-error']
  assert.notEqual(shape, none)
  assert.notEqual(shape, crash)
  assert.notEqual(none, crash)
  assert.match(shape, /not run|never ran|nothing ran/i)
  assert.match(crash, /ran|engine/i)
})

// THE TWO CLASSES HAVE TO BE GRADED, NOT NAMED. Passing the class as a string made this test
// pass for `correct` and for a nonsense string too: the planner's loop reads whether the retained
// grade records a candidate hash, never the class, and neither literal grade carried one, so the
// extractor was never reached. Both refusals are graded for real here, which is the only way the
// name's claim -- that the two classes plan alike -- is the thing being measured.
test('native evidence planning asks for no program files for a wrong-shape grade, as for no program at all', async () => {
  const trialId = 'flat-canary.claude-cli.1'
  const plan = grade => {
    const pinned = { version: 2, sha256: 'b'.repeat(64), tasks: [{ id: 'flat-canary', compiled: {} }], schedule: [{ id: trialId, taskId: 'flat-canary' }],
      spec: { schemaVersion: 2, inputs: [], protocol: { grading: { kind: 'lean-python' }, maxAttemptsPerTrial: 1, maxTotalAttempts: 1 },
        runtimeSources: Object.fromEntries(RUNTIME_FILES.map(file => [file, 'c'.repeat(64)])) } }
    const attempt = { trialId, attempt: 1, response: { output: fixture.output }, grade }
    return nativeEvidencePaths(pinned, [attempt]).files.filter(row => row.key.startsWith('native/')).map(row => row.key)
  }
  const wrongShape = (await graded(fixture.output)).grade, nothing = (await graded('')).grade
  assert.equal(wrongShape.classification, 'format-violation')
  assert.equal(nothing.classification, 'no-program')
  for (const grade of [wrongShape, nothing]) {
    assert.equal(Object.hasOwn(grade, 'candidateSha256'), false, grade.classification)
    assert.deepEqual(plan(grade), [], grade.classification)
  }
  // The contrast that makes the two empty plans mean something: the run of record handed the whole
  // reply to the engine, so the grade it retained carries a candidate hash and its artifacts are
  // still asked for. Without this arm the two lines above pass however the loop is written.
  assert.deepEqual(plan(fixture.recordedGrade), [`native/${trialId}-1/main.py`, `native/${trialId}-1/config.json`,
    `native/${trialId}-1/execution.json`, `native/${trialId}-1/result.json`, `native/${trialId}-1/order-events.json`])
})

/* T168. `execution-error` is returned by lean-grade.mjs at the line that reads
 * `if (execution.exitCode !== 0)`, AFTER the 125/126/127 infrastructure codes
 * have thrown. So it is emitted for ANY other non-zero exit, and that includes
 * the interpreter rejecting the file before a single line executes: a Python
 * syntax error exits non-zero having run nothing. A meaning that says "the
 * program ran in the engine" therefore asserts something the grader cannot
 * know, and asserts it in the report a reviewer reads. The sentence has to
 * state the fact the grader does have -- a non-zero exit -- and admit both
 * possibilities rather than pick the flattering one.
 *
 * The sibling classes are deliberately left alone: `execution-timeout` and
 * `invalid-engine-result` are only reached when the engine ran to a time limit
 * or returned a result, so for those "the program ran" is defensible. */
test('T168: the execution-error meaning never claims the program ran, because a non-zero exit includes never running', () => {
  const meanings = reporting.CLASSIFICATION_MEANINGS || {}
  const crash = meanings['execution-error']
  assert.equal(typeof crash, 'string')

  assert.doesNotMatch(crash, /program ran|ran in the engine|the program (?:was )?(?:executed|run)\b/i,
    'execution-error covers a file the interpreter refused before running a line, so the meaning must not assert the program ran')
  assert.match(crash, /exit|error/i, 'it still states what the grader does know: the engine exited with an error')
  assert.match(crash, /may|might|or the|cannot|without running|before running|never ran/i,
    'it must admit that the program may never have started')

  // The two engine-side classes must not read identically: a timeout really did
  // run to a limit, and conflating them would relabel the defect rather than fix it.
  assert.notEqual(crash, meanings['execution-timeout'])
  assert.match(meanings['execution-timeout'], /ran/i, 'the timeout meaning may still say the program ran')
})
