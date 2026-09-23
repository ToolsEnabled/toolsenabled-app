// Export a synthetic, reviewed-for-this-test-only Lean project and execute its
// dependency-free CLI against real Docker. No model provider is contacted.
// Usage: node tools/test/fixtures/qualify-research-benchmark-lean-cli.mjs /absolute/evidence/directory
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approveBundle, canonical, compilePrompt, sha256 } from '../../../src/benchmark/prompts.mjs'
import { leanCatalog, leanStarter } from '../../../src/benchmark/lean.mjs'
import { bindLeanReview, inlineLeanProgram, generateLeanProgram, leanProjectFiles } from '../../../src/benchmark/lean-codegen.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { projectFiles, zipFiles } from '../../../src/benchmark/export.mjs'
import { QUALIFICATION_IMAGE } from './qualify-research-benchmark-lean.mjs'

const sourceRoot = fileURLToPath(new URL('../../../src/benchmark/', import.meta.url))
const encode = value => JSON.stringify(value, null, 2) + '\n'
function execute(command, args, options = {}) {
  return new Promise((done, reject) => {
    const process = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = '', stderr = ''
    process.stdout.on('data', chunk => { stdout += chunk }); process.stderr.on('data', chunk => { stderr += chunk })
    process.on('error', reject)
    process.on('close', (code, signal) => done({ command, args, code, signal, stdout, stderr }))
  })
}
export async function qualifyLeanCli(evidenceDirectory) {
  const evidence = resolve(evidenceDirectory), extracted = join(evidence, 'standalone-project'), output = join(evidence, 'results')
  await mkdir(evidence, { recursive: true })
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(join(sourceRoot, file), 'utf8')])))
  let spec = leanStarter()
  spec.id = 'lean-cli-apparatus-fixture'; spec.name = 'Lean CLI synthetic apparatus fixture'
  spec.decisions = 'Synthetic apparatus qualification only. Review names below are explicit test markers, not a personal review or approval. No study or external model collection is authorized by this fixture.'
  spec.environment.leanImage = QUALIFICATION_IMAGE
  spec.protocol = { ...spec.protocol, replicates: 1, maxAttemptsPerTrial: 1, maxTotalAttempts: 4, timeoutMs: 45000, maxDurationMs: 240000, grading: { kind: 'lean-python', executionTimeoutMs: 30000 } }
  const starter = spec.tasks[0], compiled = await compilePrompt(leanCatalog(), starter.root)
  const inline = program => inlineLeanProgram(program, sources)
  const correct = inline(generateLeanProgram({ ...starter, compiled }))
  const wrong = structuredClone(starter)
  wrong.root.slots.strategy.slots.buy_process.params = { quantity: 1 }
  const wrongProgram = inline(generateLeanProgram({ ...wrong, compiled: await compilePrompt(leanCatalog(), wrong.root) }))
  const malformed = 'from AlgorithmImports import *\nclass FrozenBenchmark(QCAlgorithm):\n    def initialize(self)\n        pass'
  const logSpoof = `from AlgorithmImports import *
class FrozenBenchmark(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2024, 1, 2)
        self.set_end_date(2024, 1, 2)
        self.set_time_zone(TimeZones.UTC)
        self.set_cash(10000)
    def on_end_of_algorithm(self):
        self.log(${JSON.stringify('BENCHMARK_TRACE ' + JSON.stringify(starter.expected))})
`
  spec.conditions = [['known-correct', correct], ['wrong-quantity', wrongProgram], ['malformed-python', malformed], ['logged-claim-only', logSpoof]].map(([id, program]) => ({
    id, label: `Synthetic fixture ${id}`, model: { provider: 'fixture', id, settings: {} }, adapter: { kind: 'replay', responses: { [starter.id]: program } },
  }))
  spec = await bindRuntimeSources(spec, sources)
  spec = await bindLeanReview(spec, sources)
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, 'SYNTHETIC CLI APPARATUS FIXTURE ONLY', '2026-09-08T00:00:00.000Z', { catalog: spec.catalog })))
  const project = await freezeStudy(spec)
  const extras = leanProjectFiles(project, sources['lean-reference.py'], sources['execution_reference.py'])
  for (const task of project.tasks) extras[`lean/${task.id}/lean_reference.py`] = sources['lean-reference.py']
  const files = await projectFiles(project, { ...sources, ...extras })
  const archive = join(evidence, 'standalone-project.zip')
  await writeFile(archive, zipFiles(files))
  await mkdir(extracted, { recursive: true })
  const unpacked = await execute('python3', ['-c', 'import sys,zipfile; archive=zipfile.ZipFile(sys.argv[1]); assert archive.testzip() is None; archive.extractall(sys.argv[2])', archive, extracted])
  assert.equal(unpacked.code, 0, unpacked.stderr)
  const cli = async (id, args) => {
    console.log(`Standalone CLI: ${args.join(' ')}`)
    const result = await execute(process.execPath, [join(extracted, 'cli.mjs'), ...args, '--output', output], { cwd: extracted })
    await writeFile(join(evidence, `${id}.json`), encode(result))
    assert.equal(result.code, 0, `${id}: ${result.stderr}`)
    return JSON.parse(result.stdout)
  }
  const verified = await cli('verify', ['verify'])
  assert.equal(verified.ok, true); assert.equal(verified.trials, 4)
  const qualified = await cli('qualify', ['qualify'])
  assert.equal(qualified.checks.length, 11); assert.ok(qualified.checks.every(check => check.passed))
  const collected = await cli('run', ['run'])
  assert.equal(collected.completed, 4); assert.equal(collected.failed, 0)
  const journal = await readFile(join(output, 'attempts.jsonl'), 'utf8'), events = journal.trim().split('\n').map(JSON.parse)
  const grades = Object.fromEntries(events.filter(event => event.type === 'finished').map(event => [event.trialId.split('.')[1], event.grade.classification]))
  assert.deepEqual(grades, { 'known-correct': 'correct', 'wrong-quantity': 'trace-mismatch', 'malformed-python': 'execution-error', 'logged-claim-only': 'trace-mismatch' })
  const groups = collected.summary.groups
  assert.equal(groups.find(row => row.condition === 'known-correct').passRate, 1)
  assert.ok(groups.filter(row => row.condition !== 'known-correct').every(row => row.passRate === 0 && row.measured === 1))
  await cli('resume', ['run'])
  assert.equal(await readFile(join(output, 'attempts.jsonl'), 'utf8'), journal, 'Completed trials must not run again')
  await cli('analyze', ['analyze'])

  // Simulate a dead CLI owner that left one running container and its metadata
  // container. Recovery must verify project labels before removing either.
  console.log('Standalone CLI: recover simulated crash with owned containers')
  const container = 'research-lean-' + randomUUID(), metadataContainer = container + '-metadata'
  const ownership = { image: QUALIFICATION_IMAGE, projectSha256: project.sha256, container, metadataContainer }
  const orphanDirectory = join(output, 'artifacts', 'recovery-control')
  await mkdir(orphanDirectory, { recursive: true })
  await writeFile(join(orphanDirectory, 'ownership.json'), canonical(ownership) + '\n')
  try {
    for (const name of [container, metadataContainer]) {
      const created = await execute('docker', ['create', '--pull', 'never', '--name', name, '--label', `research-benchmark.project=${project.sha256}`, '--network', 'none', '--read-only', '--entrypoint', '/bin/sleep', QUALIFICATION_IMAGE, '600'])
      assert.equal(created.code, 0, created.stderr)
    }
    const started = await execute('docker', ['start', container])
    assert.equal(started.code, 0, started.stderr)
    const before = await execute('docker', ['inspect', '--format', '{{.State.Running}}', container])
    assert.equal(before.stdout.trim(), 'true')
    await writeFile(join(evidence, 'recovery-before.json'), encode({ ownership, before }))
    const deadPid = 2147483646
    assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' })
    await mkdir(join(output, '.run-lock'))
    await writeFile(join(output, '.run-lock', 'owner.json'), encode({ pid: deadPid, startedAt: '2026-09-08T00:00:00.000Z' }))
    await cli('recover', ['run', '--recover'])
    for (const name of [container, metadataContainer]) {
      const after = await execute('docker', ['inspect', name])
      assert.notEqual(after.code, 0); assert.match(after.stderr, /No such (object|container)/i)
    }
    assert.equal(await readFile(join(output, 'attempts.jsonl'), 'utf8'), journal)
  } finally {
    for (const name of [container, metadataContainer]) await execute('docker', ['rm', '-f', name])
  }
  const report = { kind: 'standalone-lean-cli-qualification', countedStudy: false, atomsApproved: false, reviewer: 'SYNTHETIC CLI APPARATUS FIXTURE ONLY',
    image: QUALIFICATION_IMAGE, projectSha256: project.sha256, zipSha256: await sha256(await readFile(archive)), runtimeSources: project.spec.runtimeSources,
    verified: true, independentChecks: qualified.checks.length, completed: 4, correct: 1, wrongOrInvalid: 3, grades, resumeDispatchedZeroTrials: true, recoveryRemovedOwnedContainers: true }
  await writeFile(join(evidence, 'qualification.json'), encode(report))
  console.log(encode(report))
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Pass an evidence directory; this exports and runs real local Docker backtests.')
  await qualifyLeanCli(process.argv[2])
}
