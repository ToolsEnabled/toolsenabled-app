import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { bindRuntimeSources, freezeStudy, gradeResponse, LEGACY_RUNTIME_FILES, RUNTIME_FILES, verifyProject } from '../../src/benchmark/study.mjs'
import { runStudy, validateJournal } from '../../src/benchmark/runner.mjs'
import { resourcePreparationLedger, RESOURCE_PREPARATION_LIMITS } from '../../src/benchmark/templates.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { sha256 } from '../../src/benchmark/prompts.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { resourceTemplateFixture } from './fixtures/research-benchmark-resource-template.mjs'
import { auditFixture } from './fixtures/research-benchmark-audit.mjs'

const sourceBytes = async () => Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const legacy = spec => { spec.schemaVersion = 1; delete spec.executionPlan; return spec }
async function fixture({ maxDurationMs = 180000, legacyPins = false } = {}) {
  const spec = await resourceTemplateFixture({ replicates: 1 }), sources = await sourceBytes()
  spec.protocol.maxDurationMs = maxDurationMs
  if (legacyPins) {
    legacy(spec)
    spec.runtimeSources = Object.fromEntries(await Promise.all(LEGACY_RUNTIME_FILES.map(async file => [file, await sha256(sources[file])])) )
    return freezeStudy(spec)
  }
  return freezeStudy(await bindRuntimeSources(spec, sources))
}
const clockAt = clock => ({ monotonic: () => clock.ms, now: () => Date.UTC(2026, 0, 1) + clock.ms })
const terminal = event => ['template-qualified', 'template-requalified', 'template-preparation-failed'].includes(event.type)
async function onlyPreparation(project, events = [], extra = {}) {
  const controller = new AbortController()
  return runStudy(project, { events, signal: controller.signal, ...extra,
    adapter: () => assert.fail('No candidate is requested in a preparation-only invocation'),
    onEvent: event => { if (terminal(event)) controller.abort(new Error('Stop before collection')) },
  })
}
async function caught(promise) {
  try { await promise } catch (error) { return error }
  assert.fail('Expected the operation to refuse')
}
function oldReceipts(events) {
  return events.filter(event => event.type !== 'template-preparation-started').map((event, index) => {
    const row = structuredClone(event); row.seq = index + 1
    if (terminal(row)) { delete row.preparationSeq; delete row.elapsedMs; delete row.status }
    return row
  })
}

test('resource conformance starts with durable intent, before any complete proof or response', async () => {
  const project = await fixture(), attempted = []
  const error = await caught(runStudy(project, {
    adapter: () => assert.fail('A failed durable preparation start cannot collect'),
    append: async row => { attempted.push(row); throw new Error('Synthetic first append failure') },
  }))
  assert.match(error.message, /first append failure/)
  assert.equal(attempted.length, 1)
  assert.equal(attempted[0].type, 'template-preparation-started')
  assert.equal(attempted[0].record, undefined)
  assert.equal(attempted[0].timeoutMs, RESOURCE_PREPARATION_LIMITS.timeoutMs)
  assert.equal(attempted[0].reservedMs, 60000)
  const open = resourcePreparationLedger(project, attempted)
  assert.equal(open.open, 1); assert.equal(open.elapsedMs, null); assert.equal(open.budgetChargeMs, 60000)
})

test('a lost resource terminal leaves an orphan whose explicit recovery charges the reservation before fresh conformance', async () => {
  const project = await fixture(), durable = [], clock = { ms: 0 }
  const error = await caught(runStudy(project, { ...clockAt(clock),
    adapter: () => assert.fail('No response may precede the persisted proof'),
    append: async row => {
      if (terminal(row)) throw new Error('Synthetic conformance receipt disk failure')
      durable.push(structuredClone(row))
    },
  }))
  assert.match(error.message, /receipt disk failure/)
  assert.deepEqual(error.events, durable)
  assert.equal(error.keepLock, undefined); assert.equal(error.qualificationUnsettled, undefined)
  assert.equal(durable.length, 1); assert.deepEqual(validateJournal(project, durable), [])
  await assert.rejects(runStudy(project, { events: durable }), /Resource preparation was interrupted/)
  const recovered = await runStudy(project, { events: durable, recover: true, ...clockAt(clock) })
  assert.equal(recovered.summary.completed, project.schedule.length)
  assert.deepEqual(recovered.events.slice(0, 1), durable)
  const closed = recovered.events[1]
  assert.equal(closed.type, 'template-preparation-failed'); assert.equal(closed.status, 'interrupted')
  assert.equal(closed.elapsedMs, null); assert.equal(closed.budgetChargeMs, 60000)
  assert.equal(recovered.events[2].type, 'template-preparation-started')
  assert.equal(recovered.events[3].type, 'template-qualified')
  assert.equal(recovered.events.filter(row => row.type === 'started').length, project.schedule.length)
  assert.equal(recovered.summary.resourcePreparation.interrupted, 1)
  assert.equal(recovered.summary.resourcePreparation.open, 0)
  assert.equal(recovered.summary.resourcePreparation.budgetChargeMs, 60000)
  assert.deepEqual(validateJournal(project, recovered.events), [])
})

test('an orphan that reserved the remaining study budget closes without another preparation or response', async () => {
  const project = await fixture({ maxDurationMs: 5000 }), clock = { ms: 0 }
  const intent = (await onlyPreparation(project, [], clockAt(clock))).events[0]
  assert.equal(intent.timeoutMs, 5000)
  const result = await runStudy(project, { events: [intent], recover: true, ...clockAt(clock),
    adapter: () => assert.fail('Recovery consumed the complete remaining budget'),
  })
  assert.equal(result.events.length, 2)
  assert.equal(result.summary.completed, 0)
  assert.equal(result.summary.resourcePreparation.elapsedMs, null)
  assert.equal(result.summary.resourcePreparation.budgetChargeMs, 5000)
  const report = await researchReportFiles(project, result.events)
  assert.deepEqual(JSON.parse(report['resource-preparation.json']), result.summary.resourcePreparation)
  assert.match(report['tables/resource-preparation.csv'], /interrupted/)
  assert.match(report['tables/resource-preparation.csv'], /Unavailable/)
  const openReport = await researchReportFiles(project, [intent])
  assert.equal(JSON.parse(openReport['resource-preparation.json']).open, 1)
  assert.equal(JSON.parse(openReport['resource-preparation.json']).budgetChargeMs, 5000)
})

test('resource preparation rejects forged charge, reservation, pairing, unfinished authorization and duplicate completion', async () => {
  const project = await fixture(), result = await runStudy(project, { ...clockAt({ ms: 0 }) })
  const changes = [
    rows => { rows[0].reservedMs-- },
    rows => { rows[0].timeoutMs = 60001; rows[0].reservedMs = 60001 },
    rows => { rows[1].budgetChargeMs = 1 },
    rows => { rows[1].preparationSeq = 99 },
    rows => { rows[1].elapsedMs = null },
    rows => { delete rows[1].preparationSeq },
    rows => { rows.splice(1, 1) },
    rows => { rows.splice(2, 0, structuredClone(rows[1])) },
    rows => { rows.splice(1, 0, structuredClone(rows[0])) },
    rows => { rows.splice(2, 0, { ...rows[0], timeoutMs: 1, reservedMs: 1 }); Object.assign(rows[1], { elapsedMs: project.spec.protocol.maxDurationMs, budgetChargeMs: project.spec.protocol.maxDurationMs }) },
  ]
  for (const change of changes) {
    const rows = structuredClone(result.events); change(rows); rows.forEach((row, i) => { row.seq = i + 1 })
    await assert.rejects(researchReportFiles(project, rows), /preparation|qualification|budget|charge|deadline|reservation|intent/i)
  }
})

test('cancellation after a durable resource intent settles and charges time before a later fresh qualification', async () => {
  const project = await fixture(), clock = { ms: 0 }, controller = new AbortController()
  const stopped = await runStudy(project, { ...clockAt(clock), signal: controller.signal,
    append: async event => { if (event.type === 'template-preparation-started') clock.ms += 37 },
    onEvent: event => { if (event.type === 'template-preparation-started') controller.abort(new Error('Synthetic pre-control cancellation')) },
    adapter: () => assert.fail('Cancelled preparation cannot collect'),
  })
  assert.equal(stopped.events.length, 2); assert.equal(stopped.events[1].status, 'cancelled')
  assert.equal(stopped.events[1].elapsedMs, 37); assert.equal(stopped.events[1].budgetChargeMs, 37)
  assert.equal(stopped.summary.resourcePreparation.open, 0)
  const resumed = await runStudy(project, { events: stopped.events, ...clockAt(clock) })
  assert.equal(resumed.events[2].type, 'template-preparation-started')
  assert.equal(resumed.events[3].type, 'template-qualified')
  assert.equal(resumed.summary.completed, project.schedule.length)
  assert.equal(resumed.summary.resourcePreparation.budgetChargeMs, 37)
})

test('durable-start latency cannot evade the 60-second resource cap or repeated-invocation cumulative budget', async () => {
  const project = await fixture({ maxDurationMs: 120000 }), clock = { ms: 0 }
  let events = []
  for (let invocation = 0; invocation < 2; invocation++) {
    const result = await runStudy(project, { events, ...clockAt(clock),
      append: async event => { if (event.type === 'template-preparation-started') clock.ms += 60001 },
      adapter: () => assert.fail('An expired preparation cannot collect'),
    })
    events = result.events
    assert.equal(events.at(-1).status, 'timeout')
    assert.equal(events.at(-1).budgetChargeMs, 60001)
  }
  assert.deepEqual(events.filter(row => row.type === 'template-preparation-started').map(row => row.timeoutMs), [60000, 59999])
  assert.equal(events.filter(row => row.type === 'template-qualified').length, 0)
  const final = await runStudy(project, { events, ...clockAt(clock),
    adapter: () => assert.fail('Cumulative failed preparation exhausted the study'),
    append: () => assert.fail('There is no budget for another durable intent'),
  })
  assert.deepEqual(final.events, events)
  assert.deepEqual(validateJournal(project, events), [])
})

test('legacy measured resource receipts remain unchanged and modern continuation does not infer historical intent', async () => {
  const project = await fixture({ legacyPins: true }), clock = { ms: 0 }
  assert.equal(project.version, 1); assert.equal(project.readiness, undefined)
  assert.equal(project.spec.runtimeSources['readiness.mjs'], undefined)
  const completed = await runStudy(project, { ...clockAt(clock) })
  const oldCompleted = oldReceipts(completed.events), oldPreparation = oldCompleted.slice(0, 1)
  await verifyProject(project); assert.deepEqual(validateJournal(project, oldCompleted), [])
  const report = await researchReportFiles(project, oldPreparation)
  const ledger = JSON.parse(report['resource-preparation.json'])
  assert.equal(ledger.legacy, 1); assert.equal(ledger.rows[0].startSeq, null)
  assert.equal(ledger.rows[0].elapsedMs, null); assert.equal(ledger.rows[0].chargeBasis, 'measured')
  const continued = await runStudy(project, { events: oldPreparation, ...clockAt(clock) })
  assert.deepEqual(continued.events.slice(0, 1), oldPreparation)
  assert.equal(continued.events[1].type, 'template-preparation-started')
  assert.equal(continued.events[2].type, 'template-requalified')
  assert.equal(continued.summary.resourcePreparation.legacy, 1)
  assert.equal(continued.summary.completed, project.schedule.length)
  const unchanged = await runStudy(project, { events: oldCompleted,
    adapter: () => assert.fail('Complete legacy evidence cannot recollect'),
  })
  assert.deepEqual(unchanged.events, oldCompleted)
})

test('exact and JSON grading derive the frozen result despite an injected passing callback', async () => {
  for (const kind of ['exact', 'json']) {
    const spec = legacy(genericStarter()); spec.tasks.length = 1
    spec.protocol.grading.kind = kind
    if (kind === 'json') spec.tasks[0].expected = { answer: 5 }
    spec.conditions[0].adapter.responses = { 'addition-a': kind === 'exact' ? '999' : { answer: 999 } }
    const project = await freezeStudy(spec)
    let overrideCalls = 0
    const result = await runStudy(project, { grade: () => { overrideCalls++; return { passed: true, score: 1 } } })
    assert.equal(overrideCalls, 0)
    assert.equal(result.summary.completed, 1); assert.equal(result.summary.groups[0].passed, 0)
    assert.deepEqual(validateJournal(project, result.events), [])
    const finished = result.events.find(row => row.type === 'finished')
    assert.deepEqual(finished.grade, gradeResponse(project, project.tasks[0], finished.response.output))
  }
})

test('judge-audit grading retains the frozen reference interpretation despite an injected passing callback', async () => {
  const { spec } = await auditFixture(await sourceBytes())
  legacy(spec)
  for (const condition of spec.conditions) condition.adapter.responses = Object.fromEntries(spec.tasks.map(task =>
    [task.id, { verdict: task.expected === 'accept' ? 'reject' : 'accept' }]))
  const project = await freezeStudy(spec)
  let overrideCalls = 0
  const result = await runStudy(project, { grade: () => { overrideCalls++; return { passed: true, score: 1 } } })
  assert.equal(overrideCalls, 0)
  assert.equal(result.summary.completed, project.schedule.length)
  assert.ok(result.summary.groups.every(group => group.passed === 0))
  assert.deepEqual(validateJournal(project, result.events), [])
})
