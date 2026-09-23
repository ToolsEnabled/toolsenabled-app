// Real pinned LEAN execution with synthetic provider metadata. No model calls.
// Usage: node tools/test/fixtures/qualify-research-benchmark-observations.mjs /absolute/evidence
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { canonical, compilePrompt, createReviewRecord, sha256 } from '../../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { compileTask } from '../../../src/benchmark/tasks.mjs'
import { interpretLean, leanStarter } from '../../../src/benchmark/lean.mjs'
import { bindLeanReview, inlineLeanProgram, generateLeanProgram } from '../../../src/benchmark/lean-codegen.mjs'
import { observationPlanFromSpec } from '../../../src/benchmark/observations.mjs'
import { projectFiles } from '../../../src/benchmark/export.mjs'
import { researchReportFiles } from '../../../src/benchmark/report.mjs'
import { validateJournal } from '../../../src/benchmark/runner.mjs'
import { QUALIFICATION_IMAGE } from './qualify-research-benchmark-lean.mjs'
const encode = value => JSON.stringify(value, null, 2) + '\n'
const pause = () => new Promise(done => setTimeout(done, 200))

export async function qualifyObservations(directory) {
  const evidence = resolve(directory), sourceRoot = new URL('../../../src/benchmark/', import.meta.url)
  await mkdir(dirname(evidence), { recursive: true }); await mkdir(evidence)
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(file, sourceRoot), 'utf8')])))
  const spec = leanStarter(); spec.tasks.length = 1
  spec.name = 'Synthetic collection metadata with measured native execution'
  spec.protocol = { ...spec.protocol, replicates: 2, maxAttemptsPerTrial: 1, maxTotalAttempts: 6, timeoutMs: 120000, maxDurationMs: 600000,
    grading: { kind: 'lean-python', executionTimeoutMs: 30000 } }
  spec.environment.leanImage = QUALIFICATION_IMAGE
  spec.observationPlan = observationPlanFromSpec()
  spec.observationPlan.identity.policy = 'require-match'; spec.observationPlan.completion.policy = 'require-complete'
  spec.observationPlan.costEstimate = { kind: 'per-started-attempt', currency: 'USD', amount: '0.125', rationale: 'SYNTHETIC ALLOCATION ONLY; not a billed charge.', sourcePaths: ['fixtures/allocation.json'] }
  const task = await compileTask(spec, spec.tasks[0], { requireReview: false })
  const wrong = structuredClone(spec.tasks[0]); wrong.root.slots.strategy.slots.buy_process.params = { quantity: 1 }
  wrong.expected = interpretLean((await compilePrompt(spec.catalog, wrong.root)).semantic, wrong.input).trace
  const wrongTask = await compileTask(spec, wrong, { requireReview: false })
  const inline = task => inlineLeanProgram(generateLeanProgram(task), sources)
  const programs = { faithful: inline(task), 'wrong-quantity': inline(wrongTask), 'no-program': { explanation: 'Synthetic answer with no Python program.' },
    cancelled: 'from AlgorithmImports import *\nclass FrozenBenchmark(QCAlgorithm):\n    def initialize(self):\n        self.set_start_date(2024,1,2)\n        self.set_end_date(2024,1,2)\n        self.set_cash(10000)\n    def on_end_of_algorithm(self):\n        while True:\n            pass\n' }
  const controls = [{ id: 'faithful', classification: 'correct' }, { id: 'wrong-quantity', classification: 'trace-mismatch' }, { id: 'no-program', classification: 'no-program' }]
  const condition = id => ({ id, label: 'SYNTHETIC APPARATUS CONTROL ONLY', model: { provider: 'fixture', id: 'generated-program', version: '1', surface: 'local-command', settings: {} },
    collection: { comparisonUnit: 'apparatus', instructions: { system: null, developer: null }, tools: [], contextConstruction: 'Frozen synthetic program; no model.', sessionIsolation: 'One owned command process per attempt.' },
    adapter: { kind: 'command', command: process.execPath, args: ['adapters/candidate.mjs', id] } })
  spec.conditions = controls.map(control => condition(control.id))
  const files = { 'fixtures/allocation.json': encode({ purpose: 'SYNTHETIC ALLOCATION ONLY', amount: '0.125', currency: 'USD' }),
    'adapters/candidate.mjs': `const programs=${canonical(programs)};let text='';for await(const part of process.stdin)text+=part;const request=JSON.parse(text);if(Object.keys(request).sort().join(',')!=='attempt,collection,input,model,projectSha256,prompt,trial,version')throw Error('Unexpected request fields');const id=process.argv[2];console.log(JSON.stringify({output:programs[id],identity:{provider:'fixture',id:'generated-program',version:'1',surface:'local-command'},completion:{status:'complete',reason:'Synthetic completed program fixture.'},usage:id==='faithful'?{inputTokens:0,outputTokens:0,toolCalls:0,generationMs:1.25,cost:{amount:'0',currency:'USD'}}:id==='wrong-quantity'?{inputTokens:3,generationMs:2.5}:{}}));\n` }
  spec.inputs = [...spec.inputs, ...await Promise.all(Object.entries(files).map(async ([path, bytes]) => ({ path, sha256: await sha256(bytes) })))]
  async function prepare(draft, target) {
    const bound = await bindLeanReview(await bindRuntimeSources(draft, sources), sources)
    bound.reviews = await Promise.all(bound.catalog.map(bundle => createReviewRecord(bound.catalog, bundle.id, 'SYNTHETIC NATIVE ACCOUNTING FIXTURE ONLY')))
    const project = await freezeStudy(bound), exported = await projectFiles(project, sources, files)
    for (const [file, contents] of Object.entries(exported)) { const path = resolve(target, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents) }
    return project
  }
  const exported = resolve(evidence, 'exported-project'), output = resolve(evidence, 'results'), project = await prepare(spec, exported)
  for (const command of ['verify', 'qualify', 'run', 'analyze']) {
    console.log('Fresh native accounting export: ' + command)
    const result = spawnSync(process.execPath, [resolve(exported, 'cli.mjs'), command, '--output', output], { cwd: evidence, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 600000, windowsHide: true })
    await writeFile(resolve(evidence, command + '.log'), result.stdout + result.stderr)
    assert.equal(result.status, 0, result.stderr || result.error?.message)
  }
  const retained = JSON.parse(await readFile(resolve(output, 'evidence.json'), 'utf8')); validateJournal(project, retained.events)
  const accounting = retained.summary.observations
  assert.equal(retained.summary.completed, 6); assert.equal(accounting.totals.usage.inputTokens.observedSubtotal, '6'); assert.equal(accounting.totals.usage.inputTokens.total, null)
  assert.equal(accounting.totals.reportedCost.byOrigin[0].byCurrency[0].observedSubtotal, '0'); assert.equal(accounting.totals.reportedCost.byOrigin[0].byCurrency[0].total, null)
  assert.equal(accounting.totals.estimatedCost.byOrigin[0].byCurrency[0].total, '0.75')
  const report = { format: 'observation-native-controls', status: 'running', countedStudy: false, ownerApproved: false, metadata: 'synthetic', image: QUALIFICATION_IMAGE,
    projectSha256: project.sha256, runtimeSources: project.spec.runtimeSources, cases: [] }
  for (const control of controls) {
    const ends = retained.events.filter(event => event.type === 'finished' && project.schedule.find(trial => trial.id === event.trialId).conditionId === control.id)
    assert.equal(ends.length, 2)
    for (const end of ends) {
      assert.equal(end.grade.classification, control.classification)
      const phases = end.observations.timings.spans.map(span => span.kind)
      for (const phase of ['collection', 'transport', 'response-extraction', 'response-persistence', 'grading', 'program-extraction', 'settlement']) assert.ok(phases.includes(phase), control.id + ': missing ' + phase)
      if (control.id === 'no-program') assert.equal(phases.includes('native-execution'), false)
      else for (const phase of ['native-preparation', 'native-execution', 'native-observation', 'cleanup']) assert.ok(phases.includes(phase), phase)
    }
    const traces = ends.filter(end => end.grade.trace).map(end => canonical(end.grade.trace))
    assert.ok(!traces.length || new Set(traces).size === 1)
    report.cases.push({ id: control.id, repetitions: ends.length, nativeRuns: traces.length, classification: control.classification, traceSha256: traces.length ? await sha256(traces[0]) : null })
  }
  for (const [file, expected] of Object.entries(await researchReportFiles(project, retained.events))) assert.equal(await readFile(resolve(output, file), 'utf8'), expected, file)
  console.log('Native accounting cancellation: wait for the owned container to run, then signal its CLI')
  const cancelledSpec = structuredClone(spec); cancelledSpec.conditions = [condition('cancelled')]; cancelledSpec.protocol.replicates = 1; cancelledSpec.protocol.maxTotalAttempts = 1
  const cancelRoot = resolve(evidence, 'cancellation/exported-project'), cancelOutput = resolve(evidence, 'cancellation/results'), cancelProject = await prepare(cancelledSpec, cancelRoot)
  const child = spawn(process.execPath, [resolve(cancelRoot, 'cli.mjs'), 'run', '--output', cancelOutput], { cwd: evidence, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const stdout = [], stderr = []; child.stdout.on('data', part => stdout.push(part)); child.stderr.on('data', part => stderr.push(part))
  const closed = new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })) })
  let ownership, running = false
  try {
    const deadline = Date.now() + 40000
    while (Date.now() < deadline && child.exitCode === null) {
      try { ownership = JSON.parse(await readFile(resolve(cancelOutput, 'artifacts', cancelProject.schedule[0].id + '-1/ownership.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (ownership) {
        const inspected = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', ownership.container], { encoding: 'utf8', timeout: 5000, windowsHide: true })
        if (inspected.status === 0 && inspected.stdout.trim() === 'true') { running = true; break }
      }
      await pause()
    }
    assert.ok(running, 'The owned native container must be observed running before cancellation')
    await writeFile(resolve(evidence, 'cancellation/signal.json'), encode({ projectSha256: cancelProject.sha256, ownership, nativeObservedRunning: true, signal: 'SIGINT', at: new Date().toISOString() }))
    child.kill('SIGINT')
    const outcome = await closed; assert.equal(outcome.code, 130, Buffer.concat(stderr).toString())
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await closed }
    await writeFile(resolve(evidence, 'cancellation/run.log'), Buffer.concat([...stdout, ...stderr]))
  }
  const cancelled = JSON.parse(await readFile(resolve(cancelOutput, 'evidence.json'), 'utf8')); validateJournal(cancelProject, cancelled.events)
  const end = cancelled.events.find(event => event.type === 'finished')
  assert.equal(end.status, 'cancelled'); assert.equal(end.grade, undefined); assert.equal(end.observations.reported.reportedCost.amount, null)
  assert.ok(end.observations.timings.spans.some(span => span.kind === 'native-execution' && span.status === 'truncated'))
  assert.ok(end.observations.timings.spans.some(span => span.kind === 'settlement' && span.status === 'completed'))
  for (const name of [ownership.container, ownership.metadataContainer]) {
    const inspected = spawnSync('docker', ['inspect', name], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    assert.notEqual(inspected.status, 0); assert.match(inspected.stderr, /No such (object|container)/i)
  }
  report.cancellation = { projectSha256: cancelProject.sha256, runtimeSources: cancelProject.spec.runtimeSources, nativeObservedRunning: true, status: end.status, ownedContainersRemoved: true }
  report.status = 'passed'
  await writeFile(resolve(evidence, 'qualification.json'), encode(report)); console.log(encode(report)); return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Supply a fresh evidence directory; this runs local pinned Docker controls.')
  await qualifyObservations(process.argv[2])
}
