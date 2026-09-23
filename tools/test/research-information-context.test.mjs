import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { freezeStudy, verifyProject, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'
import { taskReviewStatus } from '../../src/benchmark/information.mjs'
import { workflowRequest, newWorkflowState, collectionRequest } from '../../src/benchmark/workflow.mjs'
import { runStudy, validateJournal } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { pageReportOptions } from './fixtures/research-page-report-options.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { informationFixture } from './fixtures/research-benchmark-information.mjs'
import { informationContextFixture, reviewInformationFixture } from './fixtures/research-benchmark-information-context.mjs'

const packet = spec => compileTask(spec, spec.tasks[0], { requireTaskReview: false })
const treatment = project => project.schedule.find(trial => trial.conditionId === 'treatment')
const stage = spec => spec.workflowPlan.workflows[1].stages[0]
const flow = spec => spec.workflowPlan.workflows[1]

test('workflow disclosure changes the actual request and refuses the old information review without rewriting its reading set', async () => {
  const spec = await informationContextFixture(), baseline = await freezeStudy(spec)
  const edited = structuredClone(spec)
  stage(edited).includeTaskPrompt = false
  stage(edited).instructions.system = 'The required number is 2. Only 2 satisfies this task.'
  stage(edited).instructions.user = 'Return the required number as JSON.'
  const before = baseline.tasks[0], after = await packet(edited)
  assert.equal(after.information.version, 1)
  assert.equal(after.informationPacket.version, 2)
  assert.notEqual(after.informationPacket.sha256, before.informationPacket.sha256)
  assert.deepEqual(after.interpretations, before.interpretations)
  assert.equal(after.compiled.text, before.compiled.text)
  assert.equal(taskReviewStatus(after, spec.taskReviews).approved, false)
  const records = canonical(edited.taskReviews)
  await assert.rejects(freezeStudy(edited), /complete admissible-reading packet.*workflow assignments/)
  assert.equal(canonical(edited.taskReviews), records, 'refusal cannot create or update approval')
  const reviewed = await freezeStudy(await reviewInformationFixture(edited))
  const originalRequest = workflowRequest(newWorkflowState(baseline, treatment(baseline), 1))
  const changedRequest = workflowRequest(newWorkflowState(reviewed, treatment(reviewed), 1))
  assert.notEqual(originalRequest.prompt, changedRequest.prompt)
  assert.equal(JSON.parse(changedRequest.prompt).taskPrompt, null)
  assert.equal(changedRequest.collection.instructions.system, stage(edited).instructions.system)
  assert.equal(taskReviewStatus(reviewed.tasks[0], reviewed.spec.taskReviews).approved, true)
})

test('every declared workflow input, projection, selection, instruction and budget remains review-bound', async t => {
  const spec = await informationContextFixture(), digest = (await packet(spec)).informationPacket.sha256
  const changes = [
    ['prompt visibility', s => { stage(s).includeTaskPrompt = false }],
    ['input visibility', s => { stage(s).includeTaskInput = false }],
    ['system instruction', s => { stage(s).instructions.system = 'Changed system context' }],
    ['developer instruction', s => { stage(s).instructions.developer = 'Changed developer context' }],
    ['user instruction', s => { stage(s).instructions.user = 'Changed user context' }],
    ['parent projection', s => { flow(s).stages[1].parents[0].path = [] }],
    ['terminal selection', s => { flow(s).stages[1].resultPath = [] }],
    ['conditional route', s => { stage(s).next.branches.push({ path: ['answer'], equals: 1, to: null }) }],
    ['tool allowlist', s => { stage(s).allowedTools = ['inspect'] }],
    ['stage timeout', s => { stage(s).timeoutMs -= 1 }],
    ['call budget', s => { flow(s).budgets.maxCalls += 1 }],
    ['request budget', s => { flow(s).budgets.maxRequestBytes -= 1 }],
    ['response budget', s => { flow(s).budgets.maxResponseBytes -= 1 }],
    ['tool budget', s => { flow(s).budgets.maxToolCalls = 1 }],
    ['token budget', s => { flow(s).budgets.maxOutputTokens = 20 }],
    ['treatment rationale', s => { flow(s).rationale += ' revised' }],
    ['condition assignments', s => { [s.conditions[0].workflowId, s.conditions[1].workflowId] = [s.conditions[1].workflowId, s.conditions[0].workflowId] }],
  ]
  for (const [name, change] of changes) await t.test(name, async () => {
    const next = structuredClone(spec); change(next)
    assert.notEqual((await packet(next)).informationPacket.sha256, digest)
    await assert.rejects(freezeStudy(next), /complete admissible-reading packet/)
    // Valid changed designs freeze after a new explicit synthetic review.
    await freezeStudy(await reviewInformationFixture(next))
  })
})

test('ordinary model and declared collection context bind without accounting, with exact scalar types', async t => {
  const spec = await informationContextFixture({ workflow: false }), project = await freezeStudy(spec)
  const context = project.tasks[0].informationPacket.collectionContext
  assert.equal(context.ordinaryCollectionIncluded, false)
  assert.equal(context.workflowPlan, null)
  assert.deepEqual(context.conditions[1].model.settings, { temperature: 0, enabled: false, optional: null, label: '0' })
  assert.equal(context.conditions[1].workflowId, null)
  const request = collectionRequest(project, project.spec.conditions[1], project.tasks[0], treatment(project), 1)
  assert.deepEqual(request.model, context.conditions[1].model)
  assert.equal(Object.hasOwn(request, 'collection'), false, 'binding declarations must not claim previously unsent controls were sent')
  for (const [name, alter] of [
    ['requested ID', c => { c.model.id += '-changed' }],
    ['numeric setting', c => { c.model.settings.temperature = 0.8 }],
    ['boolean setting', c => { c.model.settings.enabled = true }],
    ['setting value type', c => { c.model.settings.label = 0 }],
    ['ordinary instructions', c => { c.collection.instructions.system = 'Declared new context' }],
    ['tool definition', c => { c.collection.tools[0].description += ' changed' }],
    ['adapter kind', c => { c.adapter = { kind: 'command', command: 'node', args: ['adapter.mjs'] } }],
  ]) await t.test(name, async () => {
    const changed = structuredClone(spec); alter(changed.conditions[1])
    assert.notEqual((await packet(changed)).informationPacket.sha256, project.tasks[0].informationPacket.sha256)
    await assert.rejects(freezeStudy(changed), /complete admissible-reading packet/)
  })
})

test('unchanged and restored context reuse only the matching review; saved outputs do not become reviewed instructions', async () => {
  const spec = await informationContextFixture(), baseline = await freezeStudy(spec)
  assert.deepEqual(await freezeStudy(structuredClone(spec)), baseline)
  const changed = structuredClone(spec); stage(changed).instructions.system = 'changed'
  await assert.rejects(freezeStudy(changed), /complete admissible-reading packet/)
  changed.workflowPlan = structuredClone(spec.workflowPlan)
  assert.deepEqual(await freezeStudy(changed), baseline)
  const responseOnly = structuredClone(spec)
  responseOnly.conditions[1].adapter.workflowResponses['number-task'].answer.output.answer = 2
  const newProject = await freezeStudy(responseOnly)
  assert.notEqual(newProject.sha256, baseline.sha256)
  assert.equal(newProject.tasks[0].informationPacket.sha256, baseline.tasks[0].informationPacket.sha256)
  assert.equal(taskReviewStatus(newProject.tasks[0], responseOnly.taskReviews).approved, true)
  assert.ok(!canonical(newProject.tasks[0].informationPacket.collectionContext).includes('workflowResponses'))
})

test('the prepared collection context is a private snapshot of mutable authoring fields', async () => {
  const spec = await informationContextFixture(), compiled = await packet(spec)
  const retained = canonical(compiled.informationPacket.collectionContext)
  spec.conditions[1].model.settings.enabled = true
  spec.conditions[1].collection.instructions.system = 'later edit'
  stage(spec).instructions.user = 'later workflow edit'
  assert.equal(canonical(compiled.informationPacket.collectionContext), retained)
  assert.notEqual((await packet(spec)).informationPacket.sha256, compiled.informationPacket.sha256)
})

test('legacy packet and project reconstruction retain independent pre-change hashes; schema2 cannot request the old binding', async () => {
  // Generated independently with immutable parent a165, before this runtime edit.
  const legacy = await freezeStudy(await reviewInformationFixture(informationFixture()))
  assert.equal(legacy.sha256, '3facfaa72f49025ef45f9f0a6f92e1cb53da928744a830b8a954dbd0e530f263')
  assert.equal(legacy.tasks[0].informationPacket.sha256, '4f88d68426db4f4c212b237f1d53220cddcf8f04ae10d3772c0188d60232b443')
  assert.equal(legacy.tasks[0].informationPacket.version, 1)
  assert.equal(Object.hasOwn(legacy.tasks[0].informationPacket, 'collectionContext'), false)
  await verifyProject(legacy)
  const modern = await informationContextFixture({ workflow: false })
  const modernTask = await packet(modern), taskOnly = structuredClone(modernTask.informationPacket)
  taskOnly.version = 1; delete taskOnly.collectionContext; delete taskOnly.sha256
  modern.taskReviews[0].packetSha256 = await sha256(canonical(taskOnly))
  await assert.rejects(freezeStudy(modern), /complete admissible-reading packet/)
  modern.tasks[0].information.packetVersion = 1
  await assert.rejects(freezeStudy(modern), /unsupported field/)
  delete modern.tasks[0].information.packetVersion
  const historical = await freezeStudy(await reviewInformationFixture(modern))
  historical.tasks[0].informationPacket = { ...taskOnly, sha256: modern.taskReviews[0].packetSha256 }
  const original = canonical(historical)
  await assert.rejects(verifyProject(historical), /archived pinned runtime.*new draft/)
  assert.equal(canonical(historical), original, 'historical verification refusal must preserve the supplied artifact')
})

test('actual saved workflow requests exclude private readings; portable report and packet agree with the exact journal', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'information-context-export-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = await freezeStudy(await informationContextFixture())
  const result = await runStudy(project), starts = result.events.filter(event => event.type === 'workflow-started')
  assert.equal(result.summary.completed, 2)
  assert.equal(starts.length, 4)
  assert.deepEqual(validateJournal(project, result.events), [])
  for (const event of starts) {
    for (const forbidden of ['expected', 'interpretations', 'informationPacket', 'semantic', 'taskReviews']) assert.equal(Object.hasOwn(event.request, forbidden), false)
    assert.ok(!canonical(event.request).includes('The required number is'))
    if (event.stageId === 'finish') assert.deepEqual(JSON.parse(event.request.prompt).parents, [{ stageId: 'answer', path: ['answer'], output: 1 }])
  }
  const changed = structuredClone(project.spec); stage(changed).instructions.system = 'Changed declared context'
  const changedProject = await freezeStudy(await reviewInformationFixture(changed))
  await assert.rejects(runStudy(changedProject, { events: result.events }), /project/)
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  const files = await projectFiles(project, sources)
  assert.deepEqual(JSON.parse(files['information/number-task.json']), project.tasks[0].informationPacket)
  for (const [file, text] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text) }
  await mkdir(resolve(root, 'results')); await writeFile(resolve(root, 'results/attempts.jsonl'), result.events.map(event => JSON.stringify(event)).join('\n') + '\n')
  for (const command of ['verify', 'analyze']) {
    const result = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), command], { encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, result.stderr)
  }
  const report = await researchReportFiles(project, result.events, await pageReportOptions({ project, sources }))
  assert.match(report['report.md'], /exact compiled task text/)
  assert.match(report['report.md'], /One frozen task-level reading set/)
  assert.match(report['report.md'], /Actual dynamic workflow requests/)
  assert.ok(report['tables/information-contexts.csv'].includes('treatment-flow'))
  for (const [file, text] of Object.entries(report)) assert.equal(await readFile(resolve(root, 'results', file), 'utf8'), text, file)
})
