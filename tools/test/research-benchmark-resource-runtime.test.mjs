import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { runStudy, replayAdapter, validateJournal, verifyResourceJournal } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { resourceTemplateFixture, resourceTemplateControls } from './fixtures/research-benchmark-resource-template.mjs'

async function fixture() {
  const spec = await resourceTemplateFixture(), sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  return freezeStudy(await bindRuntimeSources(spec, sources))
}

test('generated resource episodes enforce fresh state and independent hand outcomes across conditions and replicates', async () => {
  const project = await fixture(), durable = []
  const result = await runStudy(project, { append: async event => durable.push(structuredClone(event)) })
  assert.deepEqual(result.events, durable)
  assert.equal(result.summary.completed, 8); assert.equal(result.summary.scheduled, 8)
  assert.equal(result.events[0].type, 'template-preparation-started')
  assert.equal(result.events.filter(event => event.type === 'template-qualified').length, 1)
  assert.equal(result.events.find(event => event.type === 'template-qualified').record.cases.length, 2)
  assert.deepEqual(result.summary.groups.map(group => group.primaryRate), [1, 0])
  assert.equal(result.summary.primaryPopulation.scheduled, 4)
  for (const event of result.events.filter(event => event.type === 'finished')) {
    const trial = project.schedule.find(trial => trial.id === event.trialId), task = project.tasks.find(task => task.id === trial.taskId)
    const expected = resourceTemplateControls(task.id).find(control => control.id === (trial.conditionId === 'target-only' ? 'goal-only' : 'goal-plus-collateral')).expectedGrade
    assert.deepEqual(event.grade, expected)
    const preparation = result.events.find(row => row.type === 'resource-prepared' && row.trialId === event.trialId)
    assert.deepEqual(preparation.snapshot, task.resource.initialSnapshot)
  }
  assert.deepEqual(validateJournal(project, durable), []); await verifyResourceJournal(project, durable)
  const report = await researchReportFiles(project, durable)
  assert.match(report['report.md'], /Observed resource effects/)
  assert.match(report['report.md'], /Success without collateral effect/)
  assert.equal(JSON.parse(report['resource-effects.json']).rows.length, 8)
  const repeated = await runStudy(project, { events: durable, adapter: () => assert.fail('Completed resource episodes must not recollect') })
  assert.deepEqual(repeated.events, durable)
  assert.deepEqual(await researchReportFiles(project, repeated.events), report)
})

test('altered resource outcomes, observed states, qualification and missing closure cannot enter reports', async () => {
  const project = await fixture(), { events } = await runStudy(project)
  for (const mutate of [
    rows => { rows.find(row => row.type === 'finished').grade.resourceEffects.everCollateralCount = 99 },
    rows => { const row = rows.find(row => row.type === 'resource-effect'); row.snapshot[0].value = 'forged' },
    rows => { rows.find(row => row.type === 'template-qualified').record.controls.pop() },
    rows => { rows.splice(rows.findIndex(row => row.type === 'resource-closed'), 1); rows.forEach((row, i) => { row.seq = i + 1 }) },
    rows => { rows.shift(); rows.forEach((row, i) => { row.seq = i + 1 }) },
  ]) {
    const changed = structuredClone(events); mutate(changed)
    await assert.rejects(researchReportFiles(project, changed))
  }
  const digestOnly = structuredClone(events), event = digestOnly.find(row => row.type === 'resource-effect')
  event.afterSha256 = await sha256(canonical({ invented: 'state' }))
  await assert.rejects(verifyResourceJournal(project, digestOnly), /hash|chain|binding|state/i)
})

test('durability failures at each resource boundary halt without a completed result or response redraw', async () => {
  const project = await fixture()
  for (const boundary of ['resource-prepared', 'resource-intent', 'resource-effect', 'resource-closed']) {
    let calls = 0, failed = false
    const durable = []
    await assert.rejects(runStudy(project, {
      adapter: async args => { calls++; return replayAdapter(args) },
      append: async event => {
        if (event.type === boundary && !failed) { failed = true; throw new Error('Synthetic disk full at ' + boundary) }
        durable.push(structuredClone(event))
      },
    }), error => { assert.equal(error.keepLock, true); assert.match(error.message, /Synthetic disk full/); return true })
    assert.equal(calls, 1); assert.equal(durable.filter(event => event.type === 'finished').length, 0)
    assert.equal(validateJournal(project, durable).length, 1); await verifyResourceJournal(project, durable)
    await assert.rejects(runStudy(project, { events: durable, adapter: () => assert.fail('An open resource episode cannot redraw') }), /interrupted/i)
    if (boundary === 'resource-intent') assert.equal(durable.filter(event => event.type === 'resource-effect').length, 0)
    // Direct API recovery can close an orphan as interrupted, never execute it.
    // CLI additionally refuses if its durable response file is already present.
    const recovered = await runStudy(project, { events: durable, recover: true, adapter: () => assert.fail('Recovery must not issue another request') })
    assert.equal(recovered.summary.completed, 0); assert.equal(recovered.summary.interrupted, 1)
    assert.deepEqual(validateJournal(project, recovered.events), [])
    await verifyResourceJournal(project, recovered.events)
    await assert.rejects(runStudy(project, { events: recovered.events }), /resource episode halted/i)
  }
})

test('cancel after observed effect retains a partial observation and never scores a censored episode', async () => {
  const project = await fixture(), controller = new AbortController()
  const result = await runStudy(project, { signal: controller.signal, onEvent: event => {
    if (event.type === 'resource-effect') controller.abort(new Error('Synthetic cancellation after first observed effect'))
  } })
  assert.equal(result.summary.completed, 0); assert.equal(result.summary.interrupted, 1)
  const row = result.summary.resourceEffects.rows.find(row => row.status === 'cancelled')
  assert.equal(row.effects, null); assert.ok(row.observedPrefix.observedActionCount >= 1)
  const report = await researchReportFiles(project, result.events)
  assert.match(report['tables/resource-observed-prefixes.csv'], /Observed prefix only/)
  assert.deepEqual(validateJournal(project, result.events), [])
})

test('a template requires source pins and rejects oversized direct responses before resource preparation', async () => {
  const unpinned = await freezeStudy(await resourceTemplateFixture())
  await assert.rejects(runStudy(unpinned, { adapter: () => assert.fail('Unqualified template cannot dispatch') }), /Pin the complete|complete-runtime-pins-required/)
  const project = await fixture()
  const result = await runStudy(project, { adapter: async () => ({ output: 'x'.repeat(project.experimentTemplate.limits.maxResponseBytes + 1) }) })
  assert.equal(result.summary.completed, 0); assert.equal(result.summary.failed, 1)
  assert.equal(result.events.filter(event => event.type.startsWith('resource-')).length, 0)
  const event = result.events.find(event => event.type === 'finished')
  assert.equal(event.response.rejectedResponse.complete, false)
  assert.equal(event.response.rejectedResponse.diagnosticPrefix.length, 4096)
  assert.equal(event.phase, 'extraction')
})
