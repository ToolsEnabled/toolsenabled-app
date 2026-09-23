import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { runStudy, replayAdapter, verifyResourceJournal, validateJournal } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { collectionRequest } from '../../src/benchmark/workflow.mjs'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { resourceTemplateFixture, resourceTemplateEnvelope, RESOURCE_PRIVATE_SENTINELS } from './fixtures/research-benchmark-resource-template.mjs'

async function freeze(spec = null) {
  spec ||= await resourceTemplateFixture()
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
    [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  return freezeStudy(await bindRuntimeSources(spec, sources))
}

test('clean per-trial resumes retain one full qualification and bounded references without redrawing any response', async () => {
  const project = await freeze(), calls = new Map()
  let events = [], completed = 0, invocations = 0
  while (completed < project.schedule.length) {
    const controller = new AbortController()
    const result = await runStudy(project, { events, signal: controller.signal,
      adapter: async args => {
        calls.set(args.trial.id, (calls.get(args.trial.id) || 0) + 1)
        return replayAdapter(args)
      },
      onEvent: event => { if (event.type === 'finished') controller.abort(new Error('Stop between completed trials')) },
    })
    assert.equal(result.summary.completed, completed + 1)
    events = result.events; completed = result.summary.completed; invocations++
    assert.ok(invocations <= project.schedule.length)
  }
  const full = events.filter(event => event.type === 'template-qualified')
  const repeated = events.filter(event => event.type === 'template-requalified')
  assert.equal(full.length, 1, 'The entire source and all-case control trace must not be copied on every resume')
  assert.equal(repeated.length, project.schedule.length - 1)
  assert.ok(repeated.every(event => event.record === undefined && event.recordSha256 === full[0].record.sha256))
  assert.ok(Buffer.byteLength(canonical(events)) < project.experimentTemplate.projectedEvidence.limitBytes)
  assert.ok(Buffer.byteLength(canonical(events)) < project.experimentTemplate.projectedEvidence.estimatedBytes)
  assert.deepEqual([...calls.values()], Array(project.schedule.length).fill(1))
  assert.deepEqual(validateJournal(project, events), []); await verifyResourceJournal(project, events)
  const changed = structuredClone(events)
  changed.find(event => event.type === 'template-requalified').recordSha256 = '0'.repeat(64)
  await assert.rejects(researchReportFiles(project, changed), /qualification|receipt|binding|record|reference/i)
})

test('a failed qualification journal append cannot dispatch the first saved response', async () => {
  const project = await freeze()
  await assert.rejects(runStudy(project, {
    adapter: () => assert.fail('No response may be collected before its qualifying receipt is durable'),
    append: async event => { assert.equal(event.type, 'template-preparation-started'); throw new Error('Synthetic qualification storage failure') },
  }), /Synthetic qualification storage failure/)
})

test('two preparation-only invocations exhaust their cumulative time budget without a response call', async () => {
  const spec = await resourceTemplateFixture({ replicates: 1 })
  spec.protocol.maxDurationMs = 10000
  const project = await freeze(spec)
  let events = [], elapsed = 0
  for (let invocation = 0; invocation < 2; invocation++) {
    const controller = new AbortController()
    const result = await runStudy(project, { events, signal: controller.signal,
      // Six simulated seconds of durable-start latency belong to preparation.
      now: () => Date.UTC(2026, 0, 1) + elapsed,
      monotonic: () => elapsed,
      append: async event => { if (event.type === 'template-preparation-started') elapsed += 6000 },
      adapter: () => assert.fail('This invocation stops after preparation'),
      onEvent: event => { if (['template-qualified', 'template-requalified', 'template-preparation-failed'].includes(event.type)) controller.abort(new Error('Stop before collection')) },
    })
    events = result.events
    assert.equal(result.summary.completed, 0)
    assert.equal(events.filter(event => event.type === 'started').length, 0)
  }
  assert.equal(events.length, 4)
  assert.deepEqual(events.filter(event => event.budgetChargeMs !== undefined).map(event => event.budgetChargeMs), [6000, 6000])
  const exhausted = await runStudy(project, { events, monotonic: () => elapsed,
    now: () => assert.fail('An exhausted design must not prepare again'),
    adapter: () => assert.fail('Preparation time must survive invocation boundaries'),
  })
  assert.deepEqual(exhausted.events, events)
  assert.equal(exhausted.summary.scheduled, project.schedule.length)
  assert.equal(exhausted.summary.completed, 0)
})

test('preparation-count bound stops unlimited zero-progress invocations even with zero measured elapsed time', async () => {
  const spec = await resourceTemplateFixture({ replicates: 1 })
  spec.conditions = spec.conditions.slice(0, 1); spec.analysisPlan.contrasts = []
  const project = await freeze(spec)
  let events = []
  for (let invocation = 0; invocation < project.schedule.length + 1; invocation++) {
    const controller = new AbortController()
    const result = await runStudy(project, { events, signal: controller.signal, monotonic: () => 0,
      adapter: () => assert.fail('No response is requested by a preparation-only invocation'),
      onEvent: event => { if (['template-qualified', 'template-requalified'].includes(event.type)) controller.abort(new Error('Stop before collection')) },
    })
    events = result.events
  }
  assert.equal(events.length, 2 * (project.schedule.length + 1))
  assert.ok(events.filter(event => event.budgetChargeMs !== undefined).every(event => event.budgetChargeMs === 0))
  await assert.rejects(runStudy(project, { events, monotonic: () => 0,
    adapter: () => assert.fail('Zero-progress resumes cannot evade the preparation-count bound'),
  }), /preparation-count limit/i)
  const overLimit = structuredClone(events)
  overLimit.push({ ...overLimit.at(-1), seq: overLimit.length + 1 })
  await assert.rejects(researchReportFiles(project, overLimit), /count|preparation/i)
})

test('retained time charges gate later trial starts and later preparation while permitting a final overrun', async () => {
  const spec = await resourceTemplateFixture({ replicates: 1 })
  delete spec.observationPlan
  for (const condition of spec.conditions) {
    condition.adapter.mode = 'output'
    condition.adapter.responses = Object.fromEntries(Object.entries(condition.adapter.responses).map(([taskId, envelope]) => [taskId, envelope.output]))
  }
  const project = await freeze(spec), { events } = await runStudy(project)
  assert.equal(events.filter(event => event.type === 'finished').length, 4)
  const exhaustedPreparation = structuredClone(events)
  Object.assign(exhaustedPreparation.find(event => event.type === 'template-qualified'), { elapsedMs: project.spec.protocol.maxDurationMs, budgetChargeMs: project.spec.protocol.maxDurationMs })
  await assert.rejects(researchReportFiles(project, exhaustedPreparation), /budget|charge|time/i,
    'An exhausted preflight cannot be followed by completed trials in an internally consistent journal')

  const exhaustedAttempt = structuredClone(events)
  exhaustedAttempt.find(event => event.type === 'finished').elapsedMs = project.spec.protocol.maxDurationMs
  await assert.rejects(researchReportFiles(project, exhaustedAttempt), /budget|charge|time/i,
    'Elapsed time from the prior finished attempt must constrain the next trial')

  const finalPreparation = structuredClone(events.slice(0, 2))
  Object.assign(finalPreparation[1], { elapsedMs: project.spec.protocol.maxDurationMs + 1, budgetChargeMs: project.spec.protocol.maxDurationMs + 1 })
  assert.deepEqual(validateJournal(project, finalPreparation), [])
  assert.equal(JSON.parse((await researchReportFiles(project, finalPreparation))['summary.json']).completed, 0)
  const illegalRequalification = [...finalPreparation, { type: 'template-preparation-started', projectSha256: project.sha256,
    seq: 3, at: finalPreparation[0].at, timeoutMs: 1, reservedMs: 1 }]
  await assert.rejects(researchReportFiles(project, illegalRequalification), /budget|charge|time/i,
    'A compact receipt cannot authorize further preparation after the budget is exhausted')

  const finalAttempt = structuredClone(events.slice(0, events.findIndex(event => event.type === 'finished') + 1))
  finalAttempt.at(-1).elapsedMs = project.spec.protocol.maxDurationMs + 1
  assert.deepEqual(validateJournal(project, finalAttempt), [])
  assert.equal(JSON.parse((await researchReportFiles(project, finalAttempt))['summary.json']).completed, 1)
  for (const retained of [finalPreparation, finalAttempt]) {
    const stopped = await runStudy(project, { events: retained, adapter: () => assert.fail('A final overrun cannot lead to another response') })
    assert.deepEqual(stopped.events, retained)
  }
})

test('public collection excludes private fixtures and capability rejection preserves the observed goal prefix', async () => {
  const spec = await resourceTemplateFixture({ replicates: 1 })
  spec.conditions = spec.conditions.slice(0, 1); spec.analysisPlan.contrasts = []
  for (const task of spec.tasks) spec.conditions[0].adapter.responses[task.id] = resourceTemplateEnvelope({ actions: [
    ...task.resource.referencePlan.actions,
    { id: 'private-delete', op: 'delete', resourceId: 'private-sentinel' },
    { id: 'must-not-run', op: 'set', resourceId: 'collateral', value: 'damaged' },
  ] })
  const project = await freeze(spec)
  for (const trial of project.schedule) {
    const task = project.tasks.find(task => task.id === trial.taskId)
    const request = canonical(collectionRequest(project, project.spec.conditions[0], task, trial, 1))
    for (const sentinel of Object.values(RESOURCE_PRIVATE_SENTINELS)) assert.ok(!request.includes(sentinel))
    assert.ok(!request.includes('private-sentinel'))
    assert.ok(!request.includes('referencePlan'))
    assert.ok(request.includes('collateral'), 'Writable non-goal resources remain visible to exercise intended scope')
  }
  const result = await runStudy(project)
  for (const event of result.events.filter(event => event.type === 'finished')) {
    assert.equal(event.status, 'completed'); assert.equal(event.grade.passed, false)
    assert.equal(event.grade.resourceEffects.taskSuccess, true)
    assert.equal(event.grade.resourceEffects.validPlan, false)
    assert.equal(event.grade.resourceEffects.observedActionCount, 1)
    assert.deepEqual(event.grade.resourceEffects.everCollateralResourceIds, [])
    assert.deepEqual(event.grade.resourceEffects.rejectedActionIds, ['private-delete'])
    const own = result.events.filter(row => row.trialId === event.trialId)
    assert.equal(own.filter(row => row.type === 'resource-effect').length, 1)
    assert.equal(own.some(row => row.type === 'resource-intent' && row.action.id === 'must-not-run'), false)
  }
})

test('rejection accounting counts malformed actions without valid IDs and separates rejected envelopes', async () => {
  const spec = await resourceTemplateFixture({ replicates: 1 })
  for (const task of spec.tasks) {
    spec.conditions[0].adapter.responses[task.id] = resourceTemplateEnvelope({ actions: [
      ...task.resource.referencePlan.actions, { op: 'delete', resourceId: 'read-only' },
    ] })
    spec.conditions[1].adapter.responses[task.id] = resourceTemplateEnvelope({ actions: [], inventedOutcome: { passed: true } })
  }
  const project = await freeze(spec), result = await runStudy(project)
  assert.equal(result.summary.completed, 4)
  for (const row of result.summary.resourceEffects.rows) {
    assert.equal(row.effects.validPlan, false)
    assert.deepEqual(row.effects.rejectedActionIds, [], 'Neither malformed shape supplies a valid rejected action identity')
    assert.equal(row.rejectedActions, row.conditionId === 'target-only' ? 1 : 0)
    assert.equal(row.rejectedPlans, row.conditionId === 'collateral' ? 1 : 0)
  }
  const report = await researchReportFiles(project, result.events)
  assert.match(report['tables/resource-effects.csv'], /Rejected actions/)
  assert.match(report['tables/resource-effects.csv'], /Rejected plans/)
  const exported = JSON.parse(report['resource-effects.json'])
  assert.deepEqual(exported.rows.map(row => [row.rejectedActions, row.rejectedPlans]),
    result.summary.resourceEffects.rows.map(row => [row.rejectedActions, row.rejectedPlans]))
})
