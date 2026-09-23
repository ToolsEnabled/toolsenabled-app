// Real Docker grader controls. Synthetic apparatus qualification, never a counted study.
// Usage: node tools/test/fixtures/qualify-research-benchmark-lean-grader.mjs /absolute/evidence/directory
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { canonical, compilePrompt, sha256 } from '../../../src/benchmark/prompts.mjs'
import { leanStarter, leanCatalog } from '../../../src/benchmark/lean.mjs'
import { generateLeanProgram, inlineLeanProgram } from '../../../src/benchmark/lean-codegen.mjs'
import { gradeLean } from '../../../src/benchmark/lean-grade.mjs'
import { QUALIFICATION_IMAGE } from './qualify-research-benchmark-lean.mjs'

const root = fileURLToPath(new URL('../../../src/benchmark/', import.meta.url))
const encode = value => JSON.stringify(value, null, 2) + '\n'
export async function qualifyLeanGrader(evidenceDirectory) {
  const evidence = resolve(evidenceDirectory), artifacts = join(evidence, 'artifacts')
  await mkdir(artifacts, { recursive: true })
  const starter = leanStarter().tasks[0], compiled = await compilePrompt(leanCatalog(), starter.root), task = { ...starter, compiled }
  const reference = await readFile(join(root, 'lean-reference.py'), 'utf8')
  const execution = await readFile(join(root, 'execution_reference.py'), 'utf8')
  const inline = program => inlineLeanProgram(program, { 'lean-reference.py': reference, 'execution_reference.py': execution })
  const correct = inline(generateLeanProgram(task))
  const wrongTask = structuredClone(starter)
  wrongTask.root.slots.strategy.slots.buy_process.params = { quantity: 1 }
  const wrong = inline(generateLeanProgram({ ...wrongTask, compiled: await compilePrompt(leanCatalog(), wrongTask.root) }))
  const minimal = `from AlgorithmImports import *
class FrozenBenchmark(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2024, 1, 2)
        self.set_end_date(2024, 1, 2)
        self.set_time_zone(TimeZones.UTC)
        self.set_cash(10000)
`
  const candidates = [
    { id: 'correct', code: correct, classification: 'correct', passed: true },
    { id: 'wrong-quantity', code: wrong, classification: 'trace-mismatch', passed: false },
    { id: 'runtime-error', code: minimal.replace('self.set_cash(10000)', 'raise RuntimeError("fixture intentional error")'), classification: 'execution-error', passed: false },
    { id: 'malformed-python', code: 'from AlgorithmImports import *\nclass FrozenBenchmark(QCAlgorithm):\n    def initialize(self)\n        pass', classification: 'execution-error', passed: false },
    { id: 'log-spoof', code: minimal + `\n    def on_end_of_algorithm(self):\n        self.log(${JSON.stringify('BENCHMARK_TRACE ' + JSON.stringify(task.expected))})\n`, classification: 'trace-mismatch', passed: false },
    { id: 'no-program', code: { explanation: 'No Python program.' }, classification: 'no-program', passed: false },
  ]
  const project = { spec: { environment: { leanImage: QUALIFICATION_IMAGE }, protocol: { timeoutMs: 30000, grading: { kind: 'lean-python', executionTimeoutMs: 30000 } } } }
  project.sha256 = await sha256(canonical(project.spec))
  const report = { kind: 'lean-grader-controls', countedStudy: false, atomsApproved: false, image: QUALIFICATION_IMAGE, cases: [] }
  for (const candidate of candidates) {
    console.log(`Qualifying LEAN grader control ${candidate.id}`)
    const result = await gradeLean(project, task, candidate.code, { root, artifacts, trial: { id: candidate.id }, attempt: 1 })
    await writeFile(join(evidence, `${candidate.id}.json`), encode(result))
    assert.equal(result.classification, candidate.classification, `${candidate.id}: ${result.reason || result.execution?.stderr}`)
    assert.equal(result.passed, candidate.passed)
    report.cases.push({ id: candidate.id, status: 'passed', classification: result.classification })
    await writeFile(join(evidence, 'qualification.json'), encode(report))
  }
  console.log('Qualifying LEAN grader cancellation and owned-container cleanup')
  const cancelledCode = minimal + '\n    def on_end_of_algorithm(self):\n        while True:\n            pass\n'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Fixture cancelled an in-flight engine run')), 6000)
  try {
    await assert.rejects(gradeLean(project, task, cancelledCode, { root, artifacts, trial: { id: 'cancelled' }, attempt: 1, signal: controller.signal }), /Fixture cancelled/)
  } finally { clearTimeout(timer) }
  const ownership = JSON.parse(await readFile(join(artifacts, 'cancelled-1', 'ownership.json'), 'utf8'))
  for (const name of [ownership.container, ownership.metadataContainer]) {
    const inspect = spawnSync('docker', ['inspect', name], { encoding: 'utf8' })
    assert.notEqual(inspect.status, 0, `Owned container ${name} survived cancellation`)
    assert.match(inspect.stderr, /No such (object|container)/i)
  }
  report.cases.push({ id: 'cancelled', status: 'passed', containersRemoved: true })
  console.log('Qualifying LEAN grader execution timeout and artifact ownership')
  const timedProject = structuredClone(project)
  timedProject.spec.protocol.grading.executionTimeoutMs = 6000
  timedProject.sha256 = await sha256(canonical(timedProject.spec))
  const timed = await gradeLean(timedProject, task, cancelledCode, { root, artifacts, trial: { id: 'execution-timeout' }, attempt: 1 })
  assert.equal(timed.classification, 'execution-timeout')
  await writeFile(join(evidence, 'execution-timeout.json'), encode(timed))
  const timedOwnership = JSON.parse(await readFile(join(artifacts, 'execution-timeout-1', 'ownership.json'), 'utf8'))
  for (const name of [timedOwnership.container, timedOwnership.metadataContainer]) {
    const inspect = spawnSync('docker', ['inspect', name], { encoding: 'utf8' })
    assert.notEqual(inspect.status, 0, `Owned container ${name} survived timeout`)
    assert.match(inspect.stderr, /No such (object|container)/i)
  }
  const nativeFile = join(artifacts, 'correct-1', 'results', 'correct-1.json'), info = await stat(nativeFile)
  const native = JSON.parse(await readFile(nativeFile, 'utf8'))
  assert.equal(native.state.Status, 'Completed')
  if (process.getuid) assert.equal(info.uid, process.getuid(), 'Native artifacts must remain owned by the invoking account')
  report.cases.push({ id: 'execution-timeout', status: 'passed', containersRemoved: true })
  report.artifactsReadable = true
  report.artifactOwnerUid = info.uid
  report.status = 'passed'
  await writeFile(join(evidence, 'qualification.json'), encode(report))
  console.log(encode(report))
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Pass an evidence directory; this runs actual local Docker backtests.')
  await qualifyLeanGrader(process.argv[2])
}
