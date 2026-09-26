import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { canonical, createReviewRecord, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, prepareStudyReview, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { qualifyProject } from '../../src/benchmark/qualify.mjs'
import { assertSelectedInputQualification, verifySelectedInputQualification, validateRequirementPlan } from '../../src/benchmark/requirements.mjs'
import { runStudy, validateJournal } from '../../src/benchmark/runner.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { readProject, runProject } from '../../src/benchmark/cli.mjs'
import { activationFixture } from './fixtures/research-benchmark-activation.mjs'
import { deriveTaskExpected } from '../../src/benchmark/tasks.mjs'
import { genericActivationFixture } from './fixtures/research-benchmark-generic-activation.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { qualificationFixtures } from '../../src/benchmark/lean-cases.mjs'

import { developmentDraft } from './fixtures/research-benchmark-development.mjs'

const sourceRoot = resolve('src/benchmark'), sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(resolve(sourceRoot, file), 'utf8')])))
const freeze = async spec => {
  spec = await bindLeanReview(await bindRuntimeSources(developmentDraft(spec), sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC SELECTED-INPUT APPARATUS ONLY')))
  return freezeStudy(spec)
}
async function exportGeneric(t, change = () => {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'generic-selected-input-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = await genericActivationFixture(); await change(fixture)
  fixture.spec.inputs = await Promise.all(Object.entries(fixture.attachments).map(async ([path, bytes]) => ({ path, sha256: await sha256(bytes) })))
  const project = await freezeStudy(await bindRuntimeSources(fixture.spec, sources)), files = await projectFiles(project, sources, fixture.attachments)
  for (const [file, bytes] of Object.entries(files)) { await mkdir(dirname(resolve(directory, file)), { recursive: true }); await writeFile(resolve(directory, file), bytes) }
  return { directory, project, files }
}

for (const cancellation of ['before-entry', 'during-compilation', 'none']) test(`Lean qualification checks ${cancellation} cancellation at the Python process boundary`, async () => {
  const project = await freeze(leanStarter()), controller = new AbortController()
  const reason = new Error('Owned qualification cancellation: ' + cancellation)
  const unavailable = new Error('Synthetic process boundary unavailable; no child created.')
  const calls = [], originalSpawn = childProcess.spawn
  childProcess.spawn = (...args) => {
    calls.push({ args, aborted: controller.signal.aborted })
    throw unavailable
  }
  syncBuiltinESMExports()
  try {
    if (cancellation === 'before-entry') controller.abort(reason)
    const pending = qualifyProject(sourceRoot, project, { signal: controller.signal })
    if (cancellation === 'during-compilation') queueMicrotask(() => controller.abort(reason))
    await assert.rejects(pending, error => {
      assert.equal(error, cancellation === 'none' ? unavailable : reason)
      assert.equal(error.partialQualification.checks.length, 0)
      assert.equal(error.partialQualification.projectSha256, project.sha256)
      return true
    })
    assert.equal(calls.length, cancellation === 'none' ? 1 : 0)
    if (calls.length) {
      assert.equal(calls[0].aborted, false)
      assert.deepEqual(calls[0].args[1], ['-B', resolve(sourceRoot, 'lean-reference.py')])
      assert.equal(calls[0].args[2].shell, false)
    }
  } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports() }
})

test('uncancelled Lean qualification preserves interpretation, receipts and frozen source bytes', async t => {
  const apparatus = await mkdtemp(resolve(tmpdir(), 'research-python-apparatus-'))
  t.after(() => rm(apparatus, { recursive: true, force: true }))
  const files = ['lean-reference.py', 'execution_reference.py']
  const measured = await Promise.all(files.map(file => readFile(resolve(sourceRoot, file))))
  await Promise.all(files.map((file, index) => writeFile(resolve(apparatus, file), measured[index])))
  const project = await freeze(leanStarter()), record = await qualifyProject(apparatus, project)
  assert.deepEqual((await readdir(apparatus)).sort(), files.toSorted(), 'qualification must not write bytecode caches into its frozen apparatus')
  for (const [index, file] of files.entries()) assert.deepEqual(await readFile(resolve(apparatus, file)), measured[index])
  assert.equal(record.projectSha256, project.sha256)
  assert.equal(record.checks.filter(check => check.kind === 'apparatus-control').length, qualificationFixtures().length)
  const selected = record.checks.find(check => check.kind === 'independent-interpretation' && check.taskId === 'flat-canary')
  assert.ok(selected)
  assert.deepEqual(selected.expected, leanStarter().tasks[0].expected)
  for (const check of record.checks) {
    assert.equal(check.passed, true)
    assert.equal(check.python.process.exitCode, 0)
    assert.deepEqual(check.javascript, check.python.result)
  }
})

test('portable generic counterparts execute selected inputs without answer keys and retain source-bound raw proof', async t => {
  const { directory, project, files } = await exportGeneric(t), result = await runProject(directory)
  assert.equal(result.summary.completed, 1); assert.equal(result.summary.groups[0].passed, 1)
  const record = result.events.find(event => event.type === 'qualification').record
  assert.equal(record.moduleExecutions.length, 10)
  assert.equal(record.requirements.selectedInput.compositionStatus, 'qualified')
  assertSelectedInputQualification(project, record)
  assert.deepEqual(await researchReportFiles(project, result.events), await researchReportFiles(project, JSON.parse(canonical(result.events))))
  for (const change of [
    proof => { proof.moduleExecutions.pop() },
    proof => { proof.moduleExecutions[0].binding.sha256 = 'other' },
    proof => { proof.moduleExecutions[2].request.task.input.offset = 999 },
    proof => { proof.moduleExecutions[2].process.stdout = '{"output":{"observation":"fabricated"}}' },
    proof => { proof.moduleExecutions[2].process.exitCode = 1 },
    proof => { proof.checks[0].reference.observation = 'not the selected answer' },
  ]) { const proof = structuredClone(record); change(proof); assert.throws(() => assertSelectedInputQualification(project, proof)) }
  const resumed = await runProject(directory); assert.deepEqual(resumed.events, result.events)
  assert.equal((await readdir(resolve(directory, 'results/preflight'))).length, 1)
  const manifest = JSON.parse(files['manifest.json']); delete manifest.files['interpreters/direct.mjs']
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(readProject(directory), /omits or changes a qualification interpreter/)
  await writeFile(resolve(directory, 'interpreters/direct.mjs'), 'export function interpret() {}\n')
  await assert.rejects(qualifyProject(directory, project), /interpreter source changed/)
})

test('stalled generic interpreter is killed before dispatch and its partial diagnostic receipt survives', async t => {
  const { directory } = await exportGeneric(t, ({ spec, attachments }) => {
    spec.requirementPlan.selectedInput.timeoutMs = 1000
    attachments['interpreters/direct.mjs'] = 'import { writeFileSync } from "node:fs"; export function interpret() { writeFileSync("interpreter.pid", String(process.pid)); while (true) {} }\n'
    spec.conditions[0].adapter = { kind: 'command', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("SHOULD-NOT-DISPATCH", "called")'] }
  })
  await assert.rejects(runProject(directory), /frozen time budget/)
  await assert.rejects(readFile(resolve(directory, 'SHOULD-NOT-DISPATCH')), { code: 'ENOENT' })
  const pid = Number(await readFile(resolve(directory, 'interpreter.pid'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  const [receipt] = await readdir(resolve(directory, 'results/preflight'))
  const failure = JSON.parse(await readFile(resolve(directory, 'results/preflight', receipt, 'failure.json'), 'utf8'))
  assert.equal(failure.cancelled, true); assert.equal(failure.partialQualification.moduleExecutions.length, 1)
  const stopped = failure.partialQualification.moduleExecutions[0].process
  assert.equal(stopped.signal, process.platform === 'win32' ? null : 'SIGKILL')
  if (process.platform === 'win32') assert.ok(Number.isInteger(stopped.exitCode) && stopped.exitCode !== 0, 'the terminated Windows interpreter must report a measured failure exit code')
  const journal = (await readFile(resolve(directory, 'results/attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(journal.map(event => event.type), ['qualification-started', 'qualification-failed'])
  assert.equal(journal[1].status, 'timeout'); assert.equal(journal[1].preparationSeq, journal[0].seq)
  assert.ok(journal[1].elapsedMs >= 1000); assert.equal(journal[1].budgetChargeMs, journal[1].elapsedMs)
})

test('generic source equality and missing modules refuse; disagreement cannot satisfy the gate', async t => {
  const { spec, attachments } = await genericActivationFixture()
  spec.inputs[1].sha256 = spec.inputs[0].sha256
  await assert.rejects(freezeStudy(spec), /Identical interpreter source/)
  const { directory, project } = await exportGeneric(t, ({ attachments }) => {
    attachments['interpreters/steps.mjs'] = 'export function interpret() { return { observation: "WRONG", activation: { counters: { evaluated: 1 }, transitions: {} } } }\n'
  })
  await assert.rejects(runProject(directory), /counterparts disagree/)
  await assert.rejects(projectFiles(project, sources, { 'interpreters/direct.mjs': attachments['interpreters/direct.mjs'] }), /Attach both qualification/)
})

test('selected-input gate reconstructs shrink minimality from source-bound raw comparisons and exact candidate digests', async t => {
  const { directory, project } = await exportGeneric(t, ({ spec }) => {
    spec.tasks[0].input.sequence = ['a', 'b']
    spec.requirementPlan.targets[0].probes[0].input.sequence = ['a', 'b']
    spec.requirementPlan.shrink = { sequencePath: ['sequence'], maxEvaluations: 8 }
  })
  const proof = await qualifyProject(directory, project)
  await verifySelectedInputQualification(project, proof)
  const witness = record => record.requirements.targets[0].probes[0].wrongReadings[0].shrink
  assert.equal(witness(proof).oneMinimal, true); assert.equal(witness(proof).finalLength, 0)
  for (const mutate of [
    row => { row.exhausted = true; row.originalLength = 987; row.finalLength = 123; row.keptIndices = [999]; row.input = { sequence: ['invented'] }; row.attempts = []; row.evaluations = 0 },
    row => { row.attempts[0].evidence.reference.reference.observation = 'forged' },
    row => { row.attempts.at(-1).preserved = false },
    row => { delete row.attempts[0].evidence },
    row => { row.input.offset = 999 },
  ]) { const forged = structuredClone(proof); mutate(witness(forged)); await assert.rejects(verifySelectedInputQualification(project, forged)) }
  const forged = structuredClone(proof); witness(forged).attempts[0].inputSha256 = 'f'.repeat(64)
  await assert.rejects(verifySelectedInputQualification(project, forged), /candidate digest/)
  let calls = 0
  await assert.rejects(runStudy(project, { qualify: async () => forged, adapter: async () => { calls++ } }), /candidate digest/)
  assert.equal(calls, 0)
  const result = await runStudy(project, { qualify: async () => proof })
  const forgedEvents = structuredClone(result.events)
  forgedEvents.find(event => event.type === 'qualification').record = forged
  await assert.rejects(researchReportFiles(project, forgedEvents), /candidate digest/)
})

test('separately qualified probes cannot certify inactive selected inputs or permit adapter dispatch', async () => {
  const project = await freeze(await activationFixture({ inactive: true })), record = await qualifyProject(sourceRoot, project)
  assert.equal(record.requirements.status, 'qualified')
  assert.equal(project.tasks[0].expected.orders.length, 0)
  assert.equal(record.requirements.selectedInput.registeredStatus, 'incomplete')
  assert.ok(record.requirements.targets.every(row => !row.selectedInput.active && row.selectedInput.status === 'incomplete'))
  assert.throws(() => assertSelectedInputQualification(project, record), /exact selected input/)
  let calls = 0, writes = 0
  await assert.rejects(runStudy(project, { qualify: async () => record, adapter: async () => { calls++ }, append: async () => { writes++ } }), /exact selected input/)
  assert.equal(calls, 0); assert.equal(writes, 2)
})

test('all composition occurrences can qualify while runtime appendices remain separately unassessed', async () => {
  const project = await freeze(await activationFixture()), record = await qualifyProject(sourceRoot, project), selected = record.requirements.selectedInput
  assert.equal(selected.compositionOccurrences, 5); assert.equal(selected.registeredOccurrences, 5)
  assert.equal(selected.compositionStatus, 'qualified'); assert.deepEqual(selected.unregistered, [])
  assert.equal(selected.apparatusRequirements.length, 1)
  assertSelectedInputQualification(project, record)
  let calls = 0
  const result = await runStudy(project, { qualify: async () => { calls++; return record } })
  assert.equal(result.summary.completed, 1); assert.equal(result.events[0].type, 'qualification-started')
  assert.equal(result.events[1].type, 'qualification'); assert.equal(result.events[1].preparationSeq, result.events[0].seq)
  assert.deepEqual(validateJournal(project, result.events), [])
  const resumed = await runStudy(project, { events: result.events, qualify: async () => { calls++; return record } })
  assert.equal(calls, 1); assert.deepEqual(resumed.events, result.events)
  const withoutProof = result.events.filter(event => !['qualification-started', 'qualification'].includes(event.type)).map((event, i) => ({ ...event, seq: i + 1 }))
  assert.throws(() => validateJournal(project, withoutProof), /without the required selected-input qualification/)
})

test('gate proof validation rejects forged statuses, counters, observations and project/occurrence bindings', async () => {
  const project = await freeze(await activationFixture()), good = await qualifyProject(sourceRoot, project)
  const mutate = [
    record => { record.projectSha256 = 'other' },
    record => { record.runtimeSources['requirements.mjs'] = 'changed' },
    record => { record.requirements.registrySha256 = 'other' },
    record => { record.requirements.targets.pop() },
    record => { record.requirements.targets[0].selectedInput.inputSha256 = 'other' },
    record => { record.requirements.targets[0].selectedInput.wrongReadings = [] },
    record => { record.requirements.targets[0].selectedInput.wrongReadings[0].detected = false },
    record => { record.requirements.targets[0].selectedInput.activation[0].actual = 0 },
    record => { record.requirements.targets[0].selectedInput.baseline.independent.observation.orders = [] },
    record => { for (const side of ['reference', 'independent']) record.requirements.targets[0].selectedInput.baseline[side].activation.counters.true = 999 },
    record => { record.requirements.selectedInput.compositionOccurrences = 999 },
    record => { record.requirements.targets[0].selectedInput.wrongReadings[0].shrink = { oneMinimal: true } },
    record => { record.requirements.unregistered = [] },
    record => { record.requirements.nativeValidated = true },
  ]
  for (const change of mutate) { const record = structuredClone(good); change(record); assert.throws(() => assertSelectedInputQualification(project, record)) }
})

test('require-composition refuses missing targets; registered scope retains those limitations', async () => {
  const spec = await activationFixture(); spec.requirementPlan.targets.pop()
  let project = await freeze(spec), record = await qualifyProject(sourceRoot, project)
  assert.equal(record.requirements.selectedInput.registeredStatus, 'qualified')
  assert.equal(record.requirements.selectedInput.compositionStatus, 'incomplete')
  assert.throws(() => assertSelectedInputQualification(project, record), /unregistered composition/)
  spec.requirementPlan.selectedInput.policy = 'require-registered'
  project = await freeze(spec); record = await qualifyProject(sourceRoot, project)
  assertSelectedInputQualification(project, record)
  assert.equal(record.requirements.selectedInput.unregistered.length, 1)
})

test('qualification cancellation, timeout and missing executor stop before collection', async () => {
  const spec = await activationFixture(); spec.requirementPlan.selectedInput.timeoutMs = 100
  const project = await freeze(spec)
  await assert.rejects(runStudy(project), /Use the exported CLI/)
  let calls = 0
  await assert.rejects(runStudy(project, { qualify: (current, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), adapter: async () => { calls++ } }), /frozen time budget/)
  const controller = new AbortController()
  await assert.rejects(runStudy(project, { signal: controller.signal, qualify: async () => { controller.abort(new Error('Synthetic cancellation')); return {} }, adapter: async () => { calls++ } }), /Synthetic cancellation/)
  assert.equal(calls, 0)
  const invalid = structuredClone(spec.requirementPlan); invalid.selectedInput.timeoutMs = 0
  assert.throws(() => validateRequirementPlan(invalid), /budget/)
})

test('durable qualification failure prevents dispatch; partial recovery qualifies again before the next attempt', async t => {
  const { directory, project } = await exportGeneric(t, ({ spec }) => { spec.protocol.maxAttemptsPerTrial = 2 })
  const proof = await qualifyProject(directory, project)
  await assert.rejects(runStudy(project, { qualify: async () => proof, append: async () => { throw new Error('Qualification journal disk full') },
    adapter: () => assert.fail('No dispatch before durable proof') }), /journal disk full/)
  const controller = new AbortController()
  const partial = await runStudy(project, { signal: controller.signal, qualify: async () => proof, adapter: async () => { controller.abort(); return { output: '6' } } })
  let calls = 0
  const resumed = await runStudy(project, { events: partial.events, qualify: async () => { calls++; return proof } })
  assert.equal(calls, 1); assert.equal(resumed.summary.completed, 1)
  assert.equal(resumed.events.filter(event => event.type === 'qualification').length, 2)
  assert.equal(resumed.events.findLast(event => event.type === 'started').attempt, 2)
  assert.deepEqual(validateJournal(project, resumed.events), [])
  const open = resumed.events.slice(0, resumed.events.findIndex(event => event.type === 'started') + 1)
  const recovered = await runStudy(project, { events: open, recover: true, qualify: async () => proof })
  assert.equal(recovered.summary.completed, 1); assert.equal(recovered.events[open.length].status, 'interrupted')
  assert.equal(recovered.events[open.length + 1].type, 'qualification-started')
  assert.equal(recovered.events[open.length + 2].type, 'qualification')
})

test('standalone gate retains failed proof and never executes a dispatch sentinel', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'selected-input-gate-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const spec = await activationFixture({ inactive: true })
  spec.conditions[0].adapter = { kind: 'command', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("SHOULD-NOT-DISPATCH", "called")'] }
  const project = await freeze(spec)
  for (const [file, bytes] of Object.entries(await projectFiles(project, sources))) { await mkdir(dirname(resolve(directory, file)), { recursive: true }); await writeFile(resolve(directory, file), bytes) }
  await assert.rejects(runProject(directory), /exact selected input/)
  await assert.rejects(readFile(resolve(directory, 'SHOULD-NOT-DISPATCH')), { code: 'ENOENT' })
  const journal = (await readFile(resolve(directory, 'results/attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(journal.map(event => event.type), ['qualification-started', 'qualification-failed'])
  assert.equal(journal[1].status, 'failed'); assert.equal(journal[1].budgetChargeMs, journal[1].elapsedMs)
  const preflight = await readdir(resolve(directory, 'results/preflight'))
  assert.equal(preflight.length, 1)
  const record = JSON.parse(await readFile(resolve(directory, 'results/preflight', preflight[0], 'qualification.json'), 'utf8'))
  assert.equal(record.requirements.selectedInput.registeredStatus, 'incomplete')
})

test('a wrong reading that cannot compile on the selected input remains unavailable, not detected', async () => {
  const spec = await activationFixture(), task = spec.tasks[0]
  task.input.execution.assets = task.input.execution.assets.filter(asset => asset.id === 'SPY')
  for (const bar of task.input.bars) delete bar.prices.QQQ
  task.expected = await deriveTaskExpected(spec, task)
  const prepared = await prepareStudyReview(spec), project = { ...prepared, sha256: 'SYNTHETIC UNFROZEN INVALID-WRONG-READING CONTROL' }
  const record = await qualifyProject(sourceRoot, project), target = record.requirements.targets.find(row => row.id === 'private-strategy-asset')
  assert.equal(target.status, 'qualified'); assert.equal(target.selectedInput.status, 'failed')
  assert.equal(target.selectedInput.wrongReadings[0].outcome.phase, 'construction')
  assert.equal(target.selectedInput.wrongReadings[0].detected, false)
  assert.throws(() => assertSelectedInputQualification(project, record), /lacks independently agreed execution/)
})

test('all-composition coverage includes every explicit admissible reading, never just the private baseline', async () => {
  const spec = await activationFixture(), task = spec.tasks[0], alternative = structuredClone(task.root)
  alternative.slots.buy_reason.params.threshold = 9999
  task.familyId = 'threshold-readings'
  task.information = { version: 1, scope: 'declared-set', responseMode: 'raw', withheldPaths: ['root/buy_reason'], rationale: 'Synthetic alternatives for occurrence coverage.',
    readings: [{ id: 'strict', root: structuredClone(task.root), rationale: 'Selected strict boundary.' }, { id: 'earlier', root: alternative, rationale: 'Alternative hidden threshold.' }] }
  for (const target of spec.requirementPlan.targets) target.readingId = 'strict'
  const project = { ...await prepareStudyReview(spec), sha256: 'SYNTHETIC UNFROZEN READING-COVERAGE CONTROL' }, record = await qualifyProject(sourceRoot, project)
  assert.equal(record.requirements.selectedInput.registeredStatus, 'qualified')
  assert.equal(record.requirements.selectedInput.compositionOccurrences, 10)
  assert.equal(record.requirements.selectedInput.unregistered.length, 5)
  assert.ok(record.requirements.selectedInput.unregistered.every(row => row.readingId === 'earlier'))
  assert.throws(() => assertSelectedInputQualification(project, record), /unregistered composition/)
})
