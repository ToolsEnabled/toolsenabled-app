import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { developmentStarter } from './fixtures/research-benchmark-development.mjs'
import { analyze, bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { runStudy, validateJournal } from '../../src/benchmark/runner.mjs'
import { createAdapter, readProject, runProject } from '../../src/benchmark/cli.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { pageReportOptions } from './fixtures/research-page-report-options.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'
import { createTaskReviewRecord, taskReviewStatus } from '../../src/benchmark/information.mjs'
import { auditReviewStatus, createAuditReviewRecord } from '../../src/benchmark/audit.mjs'
import { informationFixture } from './fixtures/research-benchmark-information.mjs'
import { auditFixture } from './fixtures/research-benchmark-audit.mjs'
import { createObservationMeter, metricAggregate, observationPlanFromSpec, observationTimingSummary, observeResponse, validateObservationPlan, validateTimings } from '../../src/benchmark/observations.mjs'

function specimen() {
  const spec = developmentStarter(); spec.observationPlan = observationPlanFromSpec()
  return { spec, condition: spec.conditions[0] }
}
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
async function exported(t, update = () => {}, attachments = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'benchmark-observations-')); t.after(() => rm(root, { recursive: true, force: true }))
  const { spec } = specimen(); spec.tasks.length = 1; update(spec)
  spec.inputs.push(...await Promise.all(Object.entries(attachments).map(async ([path, text]) => ({ path, sha256: await sha256(text) }))))
  const project = await freezeStudy(await bindRuntimeSources(spec, sources)), files = await projectFiles(project, sources, attachments)
  for (const [file, text] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text) }
  return { root, project, files, attachments }
}
test('requested model identity cannot fill a missing returned identity, and explicit zero differs from unavailable usage/cost', () => {
  const { spec, condition } = specimen(); validateObservationPlan(spec)
  const missing = observeResponse(spec, condition, { output: '5', usage: null })
  assert.equal(missing.identity.id.requested, 'arithmetic-v1'); assert.equal(missing.identity.id.value, null)
  assert.equal(missing.identityStatus, 'unavailable'); assert.equal(missing.usage.inputTokens.value, null)
  assert.equal(missing.reportedCost.amount, null); assert.equal(missing.estimatedCost.amount, null)
  const zero = observeResponse(spec, condition, { output: '5', identity: { provider: 'fixture', id: 'arithmetic-v1' }, usage: { inputTokens: 0, cost: { amount: 0, currency: 'USD' } } })
  assert.equal(zero.identityStatus, 'match'); assert.equal(zero.usage.inputTokens.status, 'observed')
  assert.equal(zero.reportedCost.amount, '0')
  assert.deepEqual(metricAggregate([zero.usage.inputTokens, missing.usage.inputTokens], 2), { status: 'partial', attempts: 2, observed: 1, unavailable: 1, invalid: 0, observedSubtotal: '0', total: null })
})
test('frozen mappings distinguish unavailable, invalid and mismatched metadata and require an explicitly declared identity', () => {
  const { spec, condition } = specimen()
  spec.observationPlan.identity.policy = 'require-match'
  spec.observationPlan.overrides[condition.id] = { mapping: { identity: { id: ['metadata', 'actualModel'] } } }
  validateObservationPlan(spec)
  const observed = observeResponse(spec, condition, { metadata: { actualModel: 'different-model' }, identity: { provider: 'fixture', id: 'arithmetic-v1' }, usage: { inputTokens: -1, outputTokens: 2.5, cost: { amount: 'unknown', currency: 'USD' } } })
  assert.equal(observed.identityStatus, 'mismatch'); assert.equal(observed.eligible, false)
  assert.equal(observed.identity.id.value, 'different-model'); assert.equal(observed.usage.inputTokens.status, 'invalid')
  assert.equal(observed.usage.outputTokens.status, 'invalid'); assert.equal(observed.reportedCost.status, 'invalid')
  spec.observationPlan.identity.fields.push('version')
  assert.throws(() => validateObservationPlan(spec), /explicit requested value/)
  spec.observationPlan.identity.policy = 'record'; spec.observationPlan.mapping.usage.typo = ['usage', 'count']
  assert.throws(() => validateObservationPlan(spec), /unsupported field/)
})
test('reported decimal costs sum exactly and estimates remain separate with missing quantities and explicit cached-token subtraction', () => {
  const { spec, condition } = specimen()
  spec.inputs = [{ path: 'prices.json', sha256: 'a'.repeat(64) }]
  spec.observationPlan.costEstimate = { kind: 'unit-prices', currency: 'USD', rationale: 'Synthetic price convention.', sourcePaths: ['prices.json'], terms: [
    { id: 'uncached', add: ['inputTokens'], subtract: ['cachedInputTokens'], amount: '2', per: 1000000 },
    { id: 'cached', add: ['cachedInputTokens'], subtract: [], amount: '0.2', per: 1000000 },
  ] }
  validateObservationPlan(spec)
  const first = observeResponse(spec, condition, { usage: { inputTokens: 1000000, cachedInputTokens: 500000, cost: { amount: '0.1', currency: 'USD' } } })
  const second = observeResponse(spec, condition, { usage: { cost: { amount: '0.2', currency: 'USD' } } })
  assert.equal(first.estimatedCost.amount, '1.1'); assert.equal(first.reportedCost.amount, '0.1')
  assert.equal(second.estimatedCost.amount, null)
  assert.equal(metricAggregate([first.reportedCost, second.reportedCost], 2, { money: true }).total, '0.3')
  spec.observationPlan.costEstimate = { kind: 'per-started-attempt', currency: 'USD', amount: '0.125', rationale: 'Explicit synthetic subscription allocation; not a billed charge.', sourcePaths: ['prices.json'] }
  validateObservationPlan(spec)
  const failed = observeResponse(spec, condition, undefined)
  assert.equal(failed.reportedCost.amount, null); assert.equal(failed.estimatedCost.amount, '0.125')
})
test('inclusive timing phases retain exclusive durations without double counting and cancelled work stays truncated', async () => {
  let clock = 0
  const meter = createObservationMeter(() => clock)
  await meter.span('collection', async collection => {
    clock = 2
    await collection.span('transport', async () => { clock = 10 })
    await collection.span('response-extraction', async () => { clock = 12 })
  })
  clock = 15
  const record = meter.finish('completed'), summary = observationTimingSummary(record)
  assert.equal(summary.totalMs, 15)
  assert.equal(summary.phases.find(span => span.kind === 'collection').inclusiveMs, 12)
  assert.equal(summary.phases.reduce((sum, span) => sum + span.exclusiveMs, 0), 15)
  const forged = structuredClone(record); forged.spans[2].endUs = 13000
  assert.throws(() => validateTimings(forged), /parent interval/)
  const cancelled = createObservationMeter(() => clock)
  let resolve
  const pending = cancelled.span('collection', () => new Promise(done => { resolve = done }))
  clock = 20
  const stopped = cancelled.finish('cancelled')
  assert.equal(stopped.spans[1].status, 'truncated'); assert.equal(observationTimingSummary(stopped).totalMs, 5)
  resolve(); await pending
  assert.equal(stopped.spans[1].status, 'truncated', 'A late completion cannot rewrite the retained cutoff')
})

test('required identity failures retain the response, stop before grading and cannot redraw it on resume', async () => {
  const { spec } = specimen(); spec.observationPlan.identity.policy = 'require-match'; spec.protocol.maxAttemptsPerTrial = 3
  spec.protocol.grading = { kind: 'module', file: 'observation-boundary-grader.mjs' }
  spec.inputs.push({ path: 'observation-boundary-grader.mjs', sha256: await sha256('export const grade = () => ({passed:true,score:1})') })
  const project = await freezeStudy(spec)
  let calls = 0, grades = 0
  const result = await runStudy(project, { adapter: async () => { calls++; return { output: 'retained answer', identity: { provider: 'fixture', id: 'unexpected-model' }, usage: { outputTokens: 7 } } }, grade: () => { grades++; return { passed: true, score: 1 } } })
  assert.equal(calls, 1); assert.equal(grades, 0)
  const end = result.events[1]
  assert.equal(end.status, 'failed'); assert.equal(end.phase, 'observation'); assert.equal(end.response.output, 'retained answer')
  assert.equal(end.observations.reported.usage.outputTokens.value, 7)
  assert.equal(end.observations.reported.eligible, false); validateJournal(project, result.events)
  await assert.rejects(runStudy(project, { events: result.events }), /cannot redraw/)
  const changed = structuredClone(result.events); changed[1].observations.reported.usage.outputTokens.value = 0
  assert.throws(() => validateJournal(project, changed), /observation record disagrees/)
})

test('failed transport attempts retain reported resources, while extraction errors cannot become empty answers or retries', async () => {
  const { spec } = specimen(); spec.tasks = [spec.tasks[0]]; spec.protocol.maxAttemptsPerTrial = 2
  const project = await freezeStudy(spec)
  let calls = 0, clock = 0
  const result = await runStudy(project, { monotonic: () => clock, adapter: async ({ measure }) => measure.span('transport', async () => {
    clock += 20
    if (++calls === 1) throw Object.assign(new Error('Synthetic transport failure'), { evidence: { usage: { inputTokens: 3 } } })
    return { output: '5', usage: { inputTokens: 5 } }
  }) })
  assert.equal(calls, 2); assert.equal(result.summary.completed, 1); validateJournal(project, result.events)
  assert.deepEqual(result.events.filter(row => row.type === 'finished').map(row => row.observations.reported.usage.inputTokens.value), [3, 5])
  assert.deepEqual(result.events.filter(row => row.type === 'finished').map(row => row.elapsedMs), [20, 20])
  const malformed = await runStudy(project, { adapter: async () => ({ usage: { outputTokens: 4 } }) })
  assert.equal(malformed.events[1].phase, 'extraction'); assert.equal(malformed.events.length, 2)
  assert.equal(malformed.events[1].response.usage.outputTokens, 4)
  assert.equal(malformed.events[1].grade, undefined)
  await assert.rejects(runStudy(project, { events: malformed.events }), /cannot redraw/)
})

test('cancellation closes measured intervals before settlement and late responses cannot alter their cutoff', async () => {
  const { spec } = specimen(), project = await freezeStudy(spec), controller = new AbortController()
  let clock = 0, resolve
  const result = await runStudy(project, { signal: controller.signal, monotonic: () => clock,
    adapter: async ({ measure }) => measure.span('transport', async () => {
      clock = 10; controller.abort(new Error('Synthetic cancellation'))
      return new Promise(done => { resolve = done })
    }) })
  assert.equal(result.events[1].status, 'cancelled'); validateJournal(project, result.events)
  const retained = JSON.stringify(result.events)
  resolve({ output: 'late answer' }); await new Promise(done => setTimeout(done, 5))
  assert.equal(JSON.stringify(result.events), retained)
  assert.ok(result.events[1].observations.timings.spans.some(span => span.kind === 'transport' && span.status === 'truncated'))
})

test('reported completion stays separate from grading, and frozen completion admission stops before redraw', async () => {
  const { spec } = specimen(); spec.tasks.length = 1; spec.protocol.maxAttemptsPerTrial = 3
  spec.conditions[0].adapter = { kind: 'replay', mode: 'envelope', responses: { [spec.tasks[0].id]: { output: '5', completion: { status: 'incomplete', reason: 'synthetic token limit' } } } }
  const recorded = await runStudy(await freezeStudy(spec))
  assert.equal(recorded.summary.completed, 1)
  assert.deepEqual(recorded.summary.observations.totals.generation, { incomplete: 1 })
  spec.observationPlan.completion.policy = 'require-complete'
  const project = await freezeStudy(spec), stopped = await runStudy(project)
  assert.equal(stopped.events.length, 2); assert.equal(stopped.summary.rows[0].disposition, 'incomplete-generation')
  assert.equal(stopped.events[1].response.output, '5'); assert.equal(stopped.summary.completed, 0)
  await assert.rejects(runStudy(project, { events: stopped.events }), /cannot redraw/)
  const fabricated = structuredClone(stopped.events)
  fabricated.push({ ...fabricated[0], seq: 3, attempt: 2 })
  assert.throws(() => validateJournal(project, fabricated), /cannot redraw/)
  const unknown = await runStudy(project, { adapter: async () => ({ output: '5', completion: { reason: 'stop' } }) })
  assert.equal(unknown.summary.rows[0].disposition, 'completion-unverified')
  assert.equal(unknown.summary.observations.rows[0].reported.completion.status.value, null)
})

test('all attempts retain resources and nested timing once; partial coverage and currencies cannot become complete totals', async () => {
  const { spec } = specimen(); spec.protocol.maxAttemptsPerTrial = 2
  let clock = 0
  const result = await runStudy(await freezeStudy(spec), { monotonic: () => clock, adapter: async ({ task, attempt, measure }) => measure.span('transport', async () => {
    clock += 5
    const usage = { inputTokens: attempt === 1 ? 3 : 7, cost: { amount: attempt === 1 ? '0.1' : '0.2', currency: task.id === 'addition-a' ? 'USD' : 'EUR' } }
    if (attempt === 1) throw Object.assign(new Error('synthetic retry'), { evidence: { usage } })
    return { output: task.expected, usage: { ...usage, outputTokens: 0, generationMs: 1.25 } }
  }) })
  const accounting = result.summary.observations
  assert.equal(result.summary.completed, 2); assert.equal(accounting.rows.length, 4)
  assert.equal(accounting.rows.filter(row => row.selectedForScore).length, 2)
  assert.equal(accounting.totals.usage.inputTokens.total, '20')
  assert.equal(accounting.totals.usage.outputTokens.observedSubtotal, '0')
  assert.equal(accounting.totals.usage.outputTokens.total, null)
  assert.equal(accounting.totals.usage.generationMs.observedSubtotal, '2.5')
  assert.equal(accounting.totals.host.attemptMs.total, '20')
  assert.equal(accounting.totals.host.phases.reduce((sum, phase) => sum + Number(phase.exclusiveSubtotalMs || 0), 0), 20)
  assert.deepEqual(accounting.totals.reportedCost.byOrigin[0].byCurrency.map(row => [row.currency, row.total]), [['EUR', '0.3'], ['USD', '0.3']])
  assert.equal(accounting.totals.reportedCost.byOrigin[0].total, undefined)
  const partial = await runStudy(await freezeStudy(spec), { adapter: async ({ task }) => ({ output: task.expected, ...(task.id === 'addition-a' ? { usage: { cost: { amount: '0.2', currency: 'USD' } } } : {}) }) })
  const cost = partial.summary.observations.totals.reportedCost.byOrigin[0]
  assert.equal(cost.status, 'partial'); assert.equal(cost.byCurrency[0].observedSubtotal, '0.2'); assert.equal(cost.byCurrency[0].total, null)
})

test('recovery and open attempts retain explicit allocation without inventing duration, output or reported charges', async () => {
  const { spec } = specimen(); spec.tasks.length = 1; spec.protocol.maxAttemptsPerTrial = 1
  spec.inputs = [{ path: 'allocation.txt', sha256: 'a'.repeat(64) }]
  spec.observationPlan.costEstimate = { kind: 'per-started-attempt', currency: 'USD', amount: '0.125', rationale: 'Synthetic allocation only.', sourcePaths: ['allocation.txt'] }
  const project = await freezeStudy(spec), result = await runStudy(project), open = result.events.slice(0, 1)
  const prior = analyze(project, open).observations
  assert.equal(prior.rows[0].status, 'open'); assert.equal(prior.totals.host.attemptMs.total, null)
  assert.equal(prior.totals.estimatedCost.byOrigin[0].byCurrency[0].total, '0.125')
  assert.equal(prior.totals.reportedCost.byOrigin[0].status, 'unavailable')
  const recovered = await runStudy(project, { events: open, recover: true, adapter: () => assert.fail('attempt budget exhausted') })
  const retained = recovered.summary.observations
  assert.equal(retained.rows[0].timing.totalMs, null); assert.equal(retained.rows[0].outputRetained, false)
  assert.equal(retained.totals.host.recoveryBudgetChargeMs, spec.protocol.timeoutMs)
  assert.equal(retained.totals.host.attemptMs.observedSubtotal, null)
  const resumed = await runStudy(project, { events: recovered.events })
  assert.deepEqual(resumed.summary.observations, retained)
})

test('monotonic time survives wall-clock changes, and a backwards measurement clock is rejected', async () => {
  const { spec } = specimen(); let wall = 1000000000000, clock = 0
  const result = await runStudy(await freezeStudy(spec), { now: () => wall, monotonic: () => clock, adapter: async ({ task }) => {
    wall -= 86400000; clock += 5; return { output: task.expected }
  } })
  assert.equal(result.summary.completed, 2); assert.equal(result.summary.observations.totals.host.attemptMs.total, '10')
  const meter = createObservationMeter(() => clock); clock--
  assert.throws(() => meter.finish('failed'), /clock moved backwards/)
})

test('command retries retain failed billing metadata and requested controls; fresh CLI reports equal canonical browser artifacts', async t => {
  const { root, project, attachments } = await exported(t, spec => {
    spec.protocol.maxAttemptsPerTrial = 2
    spec.conditions[0].adapter = { kind: 'command', command: process.execPath, args: ['adapter.mjs'] }
    spec.conditions[0].collection = { comparisonUnit: 'system', instructions: { system: 'Synthetic system instruction', developer: null }, tools: [], contextConstruction: 'Only the current prompt and input.', sessionIsolation: 'New process per attempt.' }
  }, { 'adapter.mjs': `let text='';for await(const part of process.stdin)text+=part;const request=JSON.parse(text);console.error('fixture transport');console.log(JSON.stringify({output:'5',request,identity:{provider:'fixture',id:'arithmetic-v1'},completion:{status:'complete'},usage:{inputTokens:request.attempt,outputTokens:0,cost:{amount:request.attempt===1?'0.1':'0.2',currency:'USD'}}}));process.exitCode=request.attempt===1?9:0;` })
  const result = await runProject(root), accounting = result.summary.observations
  assert.equal(result.events.length, 4); assert.equal(result.summary.completed, 1)
  assert.deepEqual(accounting.totals.outcomes, { correct: 1, 'transport-error': 1 })
  assert.equal(accounting.totals.usage.inputTokens.total, '3')
  assert.equal(accounting.totals.reportedCost.byOrigin[0].byCurrency[0].total, '0.3')
  for (const event of result.events.filter(row => row.type === 'finished')) {
    assert.deepEqual(Object.keys(event.response.request).sort(), ['attempt', 'collection', 'input', 'model', 'projectSha256', 'prompt', 'trial', 'version'])
    assert.deepEqual(event.response.request.collection, project.spec.conditions[0].collection)
    assert.match(event.response.process.stderr, /fixture transport/)
    assert.ok(event.observations.timings.spans.some(span => span.kind === 'transport'))
    assert.ok(event.observations.timings.spans.some(span => span.kind === 'response-extraction'))
  }
  const analysis = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), 'analyze'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(analysis.status, 0, analysis.stderr)
  const files = await researchReportFiles(project, result.events, await pageReportOptions({ project, sources, attachments }))
  for (const [file, contents] of Object.entries(files)) assert.equal(await readFile(resolve(root, 'results', file), 'utf8'), contents, file)
  assert.ok(files['observations.json']); assert.match(files['report.html'], /Known subtotal/)
  assert.deepEqual(JSON.parse(await readFile(resolve(root, 'observations/plan.json'), 'utf8')), project.spec.observationPlan)
  await writeFile(resolve(root, 'observations/contracts.json'), '{}\n')
  await assert.rejects(readProject(root), /Frozen file changed/)
})

test('command extraction failures preserve raw bytes and available metadata and never retry; numeric overflow is not coerced', async t => {
  for (const response of ['{"usage":{"outputTokens":4}}', 'not JSON', '{"output":"5","usage":{"outputTokens":1e999}}']) {
    const { root } = await exported(t, spec => { spec.protocol.maxAttemptsPerTrial = 3; spec.conditions[0].adapter = { kind: 'command', command: process.execPath, args: ['adapter.mjs'] } },
      { 'adapter.mjs': 'process.stdout.write(' + JSON.stringify(response) + ')' })
    const result = await runProject(root), end = result.events[1]
    assert.equal(result.events.length, 2); assert.equal(end.phase, 'extraction'); assert.equal(end.grade, undefined)
    assert.equal(end.response.process?.stdout || end.response.stdout, response)
    assert.equal(end.observations.reported.usage.outputTokens.value, response.includes(':4') ? 4 : null)
    assert.equal(result.summary.rows[0].disposition, 'response-extraction-error')
    await assert.rejects(runProject(root), /cannot redraw/)
  }
})

test('HTTP response status, extraction, body errors and metadata are retained under one frozen accounting policy', async t => {
  const { spec } = specimen(); spec.tasks.length = 1
  spec.conditions[0].adapter = { kind: 'http', url: 'https://fixture.invalid/run' }
  spec.conditions[0].collection = { comparisonUnit: 'model', instructions: { system: null, developer: null }, tools: [], contextConstruction: 'Frozen prompt only.', sessionIsolation: 'Declared fresh request.' }
  const project = await freezeStudy(spec); let mode = 'ok', request
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = JSON.parse(options.body); assert.equal(url, 'https://fixture.invalid/run')
    if (mode === 'body-error') return { ok: true, status: 200, body: (async function* () { yield Buffer.from('{'); throw Error('Synthetic interrupted body') })() }
    const body = mode === 'invalid' ? '{' : JSON.stringify({ ...(mode === 'missing-output' ? {} : { output: '5' }), usage: { inputTokens: 0, cost: { amount: '0.1', currency: 'USD' } }, completion: { status: 'complete' } })
    return new Response(body, { status: mode === 'status-error' ? 503 : 200 })
  })
  for (mode of ['ok', 'missing-output', 'invalid', 'status-error', 'body-error']) {
    const result = await runStudy(project, { adapter: createAdapter(tmpdir()) }), end = result.events[1]
    assert.deepEqual(request.collection, spec.conditions[0].collection); assert.equal('expected' in request, false); assert.equal('measure' in request, false)
    assert.equal(end.status, mode === 'ok' ? 'completed' : 'failed')
    if (mode !== 'ok') assert.equal(end.phase, ['invalid', 'missing-output'].includes(mode) ? 'extraction' : 'transport')
    assert.equal(end.observations.reported.usage.inputTokens.value, ['invalid', 'body-error'].includes(mode) ? null : 0)
    assert.ok(end.response.http?.body || end.response.body)
    validateJournal(project, result.events)
  }
})

test('owned module serialization and grader boundaries retain accounting without promoting nonfinite outputs', async t => {
  const { root } = await exported(t, spec => {
    spec.conditions[0].adapter = { kind: 'module', file: 'adapter.mjs' }
    spec.protocol.grading = { kind: 'module', file: 'grader.mjs' }
  }, { 'adapter.mjs': 'export const run=()=>({output:"5",usage:{toolCalls:0}})', 'grader.mjs': 'export const grade=()=>({passed:true,score:1})' })
  const result = await runProject(root)
  assert.equal(result.summary.completed, 1); assert.equal(result.summary.observations.totals.usage.toolCalls.total, '0')
  const spans = result.events[1].observations.timings.spans, grader = spans.find(span => span.kind === 'module-grader')
  assert.ok(grader); assert.ok(spans.some(span => span.parentId === grader.id && span.kind === 'transport'))
  const malformed = await exported(t, spec => {
    spec.protocol.maxAttemptsPerTrial = 3; spec.conditions[0].adapter = { kind: 'module', file: 'invalid.mjs' }
  }, { 'invalid.mjs': 'export const run=()=>({output:NaN})' })
  const failure = await runProject(malformed.root)
  assert.equal(failure.events.length, 2); assert.equal(failure.events[1].phase, 'extraction')
  assert.match(failure.events[1].response.stderr, /serialization failed/)
  assert.equal(failure.events[1].response.output, undefined)
})

test('recorded and new adapter cost metadata stay in different origin groups', async () => {
  const { spec } = specimen(); spec.tasks.length = 1
  spec.conditions = ['recorded', 'command'].map(id => ({ ...spec.conditions[0], id, adapter: id === 'recorded' ? { kind: 'replay', mode: 'envelope', responses: {} } : { kind: 'command', command: 'fixture-unused', args: [] } }))
  const result = await runStudy(await freezeStudy(spec), { adapter: async () => ({ output: '5', usage: { cost: { amount: '1', currency: 'USD' } } }) })
  const costs = result.summary.observations.totals.reportedCost.byOrigin
  assert.deepEqual(costs.map(group => [group.origin, group.byCurrency[0].total]), [['adapter-reported', '1'], ['recorded-response', '1']])
})

test('owned cancellation retains late parsed usage while timing ends after process settlement and the lock is released', async t => {
  const { root } = await exported(t, spec => {
    spec.conditions[0].adapter = { kind: 'module', file: 'cancel.mjs' }
  }, { 'cancel.mjs': 'import {writeFileSync} from "node:fs";export function run(){return new Promise(()=>{process.stdout.write(JSON.stringify({usage:{inputTokens:0,cost:{amount:"0",currency:"USD"}}}),()=>{writeFileSync("cancel-ready","ready");for(;;){}})})}' })
  const controller = new AbortController(), pending = runProject(root, { signal: controller.signal })
  pending.catch(() => {}) // The bounded readiness check below still awaits the outcome.
  let ready = false
  for (let i = 0; i < 300 && !ready; i++) {
    try { ready = await readFile(resolve(root, 'cancel-ready'), 'utf8') === 'ready' } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 20))
  }
  controller.abort(new Error('Synthetic owned cancellation'))
  let result
  result = await pending
  assert.equal(ready, true, 'Cancel only after the owned process has actually flushed the usage receipt')
  const end = result.events[1]
  assert.equal(end.status, 'cancelled'); assert.equal(end.grade, undefined)
  assert.equal(end.observations.reported.usage.inputTokens.value, 0)
  assert.equal(end.observations.reported.reportedCost.amount, '0')
  assert.ok(end.observations.timings.spans.some(span => span.kind === 'transport' && span.status === 'truncated'))
  assert.ok(end.observations.timings.spans.some(span => span.kind === 'settlement' && span.status === 'completed'))
  await assert.rejects(readFile(resolve(root, 'results/.run-lock/owner.json')), { code: 'ENOENT' })
})

test('large exact estimates aggregate beyond individual reported-value bounds without rounding through binary floats', async () => {
  const { spec } = specimen(); spec.inputs = [{ path: 'prices.json', sha256: 'a'.repeat(64) }]
  spec.observationPlan.costEstimate = { kind: 'unit-prices', currency: 'USD', rationale: 'Synthetic extreme arithmetic control.', sourcePaths: ['prices.json'], terms: [{ id: 'input', add: ['inputTokens'], subtract: [], amount: '100000000000000000000e36', per: 1 }] }
  const result = await runStudy(await freezeStudy(spec), { adapter: async ({ task }) => ({ output: task.expected, usage: { inputTokens: Number.MAX_SAFE_INTEGER } }) })
  assert.equal(result.summary.observations.totals.estimatedCost.byOrigin[0].byCurrency[0].total, (2n * BigInt(Number.MAX_SAFE_INTEGER) * 10n ** 56n).toString())
})

test('information and audit reviews bind accounting policies and the requested conditions used for admission', async () => {
  const information = informationFixture(); information.observationPlan = observationPlanFromSpec()
  const original = await compileTask(information, information.tasks[0]), review = await createTaskReviewRecord(original, 'SYNTHETIC ACCOUNTING REVIEW ONLY')
  information.conditions[0].model.version = 'changed-declared-version'
  const changed = await compileTask(information, information.tasks[0])
  assert.equal(changed.compiled.text, original.compiled.text)
  assert.equal(taskReviewStatus(changed, [review]).approved, false)
  const { spec } = await auditFixture(sources); spec.observationPlan = observationPlanFromSpec()
  const audit = await freezeStudy(spec), record = await createAuditReviewRecord(audit.tasks[0], 'SYNTHETIC ACCOUNTING REVIEW ONLY')
  spec.observationPlan.completion.policy = 'require-complete'
  const updated = await freezeStudy(spec)
  assert.equal(updated.tasks[0].compiled.text, audit.tasks[0].compiled.text)
  assert.equal(auditReviewStatus(updated.tasks[0], [record]).approved, false)
  spec.conditions[0].model.id = 'changed-judge'
  const updatedIdentity = await freezeStudy(spec)
  assert.notEqual(updatedIdentity.tasks[0].auditPacket.sha256, updated.tasks[0].auditPacket.sha256)
})
