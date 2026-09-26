// Fresh native candidate-grader controls. Synthetic review records below are
// explicitly test fixtures, never an investigator's personal study approval.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { canonical, createReviewRecord, sha256 } from '../../../src/benchmark/prompts.mjs'
import { operationalStarter, operationalStrategy } from '../../../src/benchmark/trading-catalog.mjs'
import { compileTask, deriveTaskExpected } from '../../../src/benchmark/tasks.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { bindLeanReview } from '../../../src/benchmark/lean-codegen.mjs'
import { operationalReferenceProgram } from '../../../src/benchmark/trading-study.mjs'
import { gradeLean } from '../../../src/benchmark/lean-grade.mjs'
import { projectFiles } from '../../../src/benchmark/export.mjs'
import { qualifyProject } from '../../../src/benchmark/qualify.mjs'
import { QUALIFICATION_IMAGE } from './qualify-research-benchmark-lean.mjs'

const sourceRoot = fileURLToPath(new URL('../../../src/benchmark/', import.meta.url))
const json = value => JSON.stringify(value, null, 2) + '\n'
const wrap = (use, children) => ({ use, slots: Object.fromEntries(children.map((child, i) => ['child' + (i + 1), child])) })
export async function operationalStudyFixtures() {
  const spec = await operationalStarter(), base = spec.tasks[0], fixtures = []
  const add = (id, root, update = () => {}) => {
    const task = { ...structuredClone(base), id, root }; update(task); fixtures.push(task)
  }
  add('nested-canary', base.root)
  add('flat-labels', operationalStrategy())
  add('race-accepted', wrap('op-race-accepted-2', [operationalStrategy(), operationalStrategy()]))
  add('race-first-fill', wrap('op-race-filled-2', [operationalStrategy(), operationalStrategy()]))
  const delayed = operationalStrategy(); delayed.slots.buy_reason.params = { threshold: 11000 }
  const early = () => { const leaf = operationalStrategy(); leaf.slots.buy_process.params = { cashCapCents: 50000 }; return leaf }
  delayed.slots.buy_process.params = { cashCapCents: 50000 }
  add('cancel-and-submit', wrap('op-all-2', [wrap('op-race-filled-2', [early(), early()]), delayed]), task => {
    task.input.execution.cashCents = 200000
    task.input.bars.forEach((bar, i) => { bar.prices.SPY = i ? 12000 : 10000 })
  })
  add('pending-entry', operationalStrategy(), task => { task.input.market.delayBars = 20 })
  add('cash-contention', wrap('op-all-4', Array.from({ length: 4 }, () => operationalStrategy())), task => {
    task.input.execution.cashCents = 40000; task.input.bars = Array.from({ length: 19 }, (_, i) => ({ time: 1704205860 + 60 * i, prices: { SPY: 10000 } }))
  })
  for (const kind of ['event', 'reset']) add(kind + '-drain', wrap('op-' + kind + '-all-2', [operationalStrategy(), operationalStrategy()]), task => {
    task.root.params = { threshold: 11000 }
    for (const leaf of Object.values(task.root.slots)) {
      leaf.slots.buy_process.params = { cashCapCents: 50000 }
      leaf.slots.sell_reason.params = { bars: 100 }
    }
    task.input.execution.cashCents = 200000
    task.input.bars = Array.from({ length: 16 }, (_, i) => ({ time: 1704205860 + 60 * i, prices: { SPY: i >= 1 && i < 7 ? 12000 : 10000 } }))
  })
  add('missing-observations', operationalStrategy(), task => {
    task.input.execution.assets.push({ id: 'GATE', multiplier: 1, quantityStep: 1 })
    task.input.bars.forEach((bar, i) => { bar.prices.GATE = 100; if ([1, 3].includes(i)) bar.prices.SPY = null })
  })
  let deep = operationalStrategy()
  for (let i = 0; i < 7; i++) {
    const quiet = operationalStrategy(); quiet.slots.buy_reason.params = { threshold: 99999999 }
    deep = wrap(['op-all-2', 'op-sequence-2', 'op-race-accepted-2'][i % 3], [deep, quiet])
  }
  add('depth-eight', deep)
  for (const task of fixtures) task.expected = await deriveTaskExpected(spec, task)
  spec.tasks = fixtures
  return spec
}

function handChecks(task, observation) {
  const fills = observation.events.filter(event => event.quantity).map(event => [(event.time - task.input.bars[0].time) / 60, event.order, event.quantity])
  if (['flat-labels', 'race-accepted', 'depth-eight'].includes(task.id)) assert.deepEqual(fills, [[1, 1, 2], [2, 1, 2], [3, 2, -2], [4, 2, -2]])
  if (task.id === 'race-first-fill') {
    assert.deepEqual(fills, [[1, 1, 2], [1, 2, 2], [2, 1, 2], [3, 3, -2], [3, 4, -2], [4, 3, -2]])
    assert.equal(observation.orders[1].status, 'cancelled'); assert.equal(observation.orders[1].unfilledQuantity, 2)
    assert.equal(observation.orders[3].reason, 'race-release')
  }
  if (task.id === 'pending-entry') { assert.equal(fills.length, 0); assert.deepEqual(observation.orders.map(order => [order.quantity, order.pending, order.status]), [[4, true, 'accepted']]) }
  if (task.id === 'cancel-and-submit') {
    const atOne = observation.events.filter(event => event.time === task.input.bars[1].time)
    assert.deepEqual(atOne.map(event => [event.order, event.status]), [[1, 'partial'], [2, 'partial'], [2, 'cancel-pending'], [2, 'cancelled'], [3, 'accepted']])
  }
  if (task.id === 'cash-contention') assert.deepEqual(observation.orders.filter(order => order.quantity > 0).map(order => (order.time - task.input.bars[0].time) / 60), [0, 4, 8, 12])
  if (task.id === 'missing-observations') assert.deepEqual(fills, [[2, 1, 2], [4, 1, 2], [5, 2, -2], [6, 2, -2]])
  if (task.id === 'event-drain') assert.ok(observation.orders.some(order => order.reason === 'gate-close'))
  if (task.id === 'reset-drain') assert.ok(observation.orders.some(order => order.reason === 'reset'))
}

// Separately handwritten code, with opaque labels and no interpreter/oracle.
export const handwrittenOperationalCandidate = `from AlgorithmImports import *
import json
class FrozenBenchmark(QCAlgorithm):
    def initialize(self):
        self.set_time_zone(TimeZones.UTC)
        self.set_start_date(2024, 1, 2)
        self.set_end_date(2024, 1, 2)
        self.set_cash(1500)
        self.asset = self.add_equity("SPY", Resolution.MINUTE, fill_forward=False, data_normalization_mode=DataNormalizationMode.RAW).symbol
        self.index = 0
    def on_data(self, data):
        if self.asset not in data.bars:
            return
        if self.index in (0, 2):
            buy = self.index == 0
            self.market_order(self.asset, 4 if buy else -4, True, tag=json.dumps(["LB-OP-1", "root", "opaque private lot", "entry" if buy else "exit", "open" if buy else "close"]))
        self.index += 1
`

async function hashes(directory) {
  const result = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) for (const [path, digest] of Object.entries(await hashes(resolve(directory, entry.name)))) result[entry.name + '/' + path] = digest
    else result[entry.name] = await sha256(await readFile(resolve(directory, entry.name)))
  }
  return result
}
async function command(args, cwd, file) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timeout = setTimeout(() => child.kill('SIGKILL'), 300000)
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.on('error', reject)
    child.on('close', async (code, signal) => { clearTimeout(timeout); await writeFile(file, json({ args, cwd, code, signal, stdout, stderr }));
      try { assert.equal(code, 0, stderr); done(JSON.parse(stdout)) } catch (error) { reject(error) } })
  })
}

export async function qualifyOperationalStudy(directory) {
  directory = resolve(directory); await mkdir(directory, { recursive: false })
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(resolve(sourceRoot, file), 'utf8')])))
  let spec = await operationalStudyFixtures()
  spec.protocol = { ...spec.protocol, timeoutMs: 120000, maxTotalAttempts: 100, maxDurationMs: 3600000, grading: { kind: 'lean-python', executionTimeoutMs: 60000 } }
  spec.environment.leanImage = QUALIFICATION_IMAGE
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC NATIVE APPARATUS QUALIFICATION ONLY')))
  spec.conditions[0].adapter.responses = {}
  const project = await freezeStudy(spec), exported = resolve(directory, 'project'), files = await projectFiles(project, sources)
  for (const [file, contents] of Object.entries(files)) { await mkdir(dirname(resolve(exported, file)), { recursive: true }); await writeFile(resolve(exported, file), contents) }
  await writeFile(resolve(directory, 'independent-python.json'), json(await qualifyProject(exported, project)))
  const report = { format: 'operational-study-native-qualification', version: 1, countedStudy: false, personalApproval: false, status: 'running', projectSha256: project.sha256,
    runtimeSources: project.spec.runtimeSources, image: QUALIFICATION_IMAGE, repetitions: 3, runs: [], controls: [] }
  const persist = () => writeFile(resolve(directory, 'qualification.json'), json(report))
  await persist()
  try {
    const priority = ['cancel-and-submit', 'reset-drain', 'missing-observations', 'depth-eight']
    for (const task of [...project.tasks].sort((a, b) => (priority.includes(a.id) ? priority.indexOf(a.id) : 99) - (priority.includes(b.id) ? priority.indexOf(b.id) : 99))) {
      handChecks(task, task.expected)
      const code = task.id === 'flat-labels' ? handwrittenOperationalCandidate : operationalReferenceProgram(task, sources)
      let prior
      for (let repeat = 1; repeat <= 3; repeat++) {
        console.log(task.id + ': fresh native candidate run ' + repeat)
        const grade = await gradeLean(project, task, code, { root: exported, artifacts: resolve(directory, 'artifacts'), trial: { id: task.id }, attempt: repeat, signal: new AbortController().signal })
        await writeFile(resolve(directory, task.id + '-' + repeat + '-grade.json'), json(grade))
        assert.equal(grade.passed, true, task.id + ': ' + grade.classification + ': ' + grade.reason)
        handChecks(task, grade.trace)
        const observationSha256 = await sha256(canonical(grade.trace))
        if (prior) assert.equal(observationSha256, prior); prior = observationSha256
        report.runs.push({ taskId: task.id, repeat, passed: true, observationSha256, candidateSha256: grade.candidateSha256, directory: grade.directory })
        await persist()
      }
    }
    const race = project.tasks.find(task => task.id === 'race-first-fill'), alternate = project.tasks.find(task => task.id === 'race-accepted')
    const mutation = await gradeLean(project, race, operationalReferenceProgram(alternate, sources), { root: exported, artifacts: resolve(directory, 'artifacts'), trial: { id: 'wrong-race-policy' }, attempt: 1, signal: new AbortController().signal })
    await writeFile(resolve(directory, 'wrong-race-policy-grade.json'), json(mutation))
    assert.equal(mutation.classification, 'trace-mismatch'); assert.equal(mutation.passed, false)
    report.controls.push({ id: 'wrong-race-policy', passed: true, candidateDisposition: mutation.classification })
    // Exercise the real portable CLI run journal, native grading and reports.
    const cliSpec = structuredClone(spec)
    cliSpec.tasks = [cliSpec.tasks.find(task => task.id === 'flat-labels')]
    cliSpec.protocol.replicates = 3
    cliSpec.conditions[0].adapter.responses = { 'flat-labels': handwrittenOperationalCandidate }
    const cliProject = await freezeStudy(cliSpec), cliRoot = resolve(directory, 'cli-project')
    for (const [file, contents] of Object.entries(await projectFiles(cliProject, sources))) { await mkdir(dirname(resolve(cliRoot, file)), { recursive: true }); await writeFile(resolve(cliRoot, file), contents) }
    const summary = await command([resolve(cliRoot, 'cli.mjs'), 'run'], directory, resolve(directory, 'cli-run.json'))
    assert.equal(summary.completed, 3)
    const evidence = JSON.parse(await readFile(resolve(cliRoot, 'results/evidence.json'), 'utf8'))
    assert.equal(evidence.summary.groups[0].passed, 3)
    const resumed = await command([resolve(cliRoot, 'cli.mjs'), 'run'], directory, resolve(directory, 'cli-resume.json'))
    assert.equal(resumed.completed, 3)
    const journal = (await readFile(resolve(cliRoot, 'results/attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(journal.filter(event => event.type === 'started').length, 3)
    await command([resolve(cliRoot, 'cli.mjs'), 'reference'], directory, resolve(directory, 'cli-reference.json'))
    const reference = JSON.parse(await readFile(resolve(cliRoot, 'results/reference-bundle.json'), 'utf8'))
    assert.equal(Object.keys(reference.files).filter(file => file.endsWith('/candidate.py')).length, 3)
    assert.equal(Object.keys(reference.files).filter(file => file.endsWith('/order-events.json')).length, 3)
    report.controls.push({ id: 'native-cli-resume-report', passed: true, completed: 3, duplicateDispatches: 0 })
    report.controls.push({ id: 'native-audit-reference', passed: true, sourceTrials: 3, referenceSha256: reference.sha256 })
    report.status = 'qualified'; await persist()
    await writeFile(resolve(directory, 'artifact-hashes.json'), json(await hashes(directory)))
    return report
  } catch (error) { report.status = 'failed'; report.error = error.message; await persist(); throw error }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Supply a fresh evidence directory.')
  const report = await qualifyOperationalStudy(process.argv[2]); console.log(json({ status: report.status, runs: report.runs.length, controls: report.controls }))
}
