import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { canonical, createReviewRecord } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, gradeResponse, materializeCorpus, RUNTIME_FILES, verifyProject } from '../../src/benchmark/study.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'
import { createTaskReviewRecord } from '../../src/benchmark/information.mjs'
import { corpusPlanFromTask } from '../../src/benchmark/corpus.mjs'
import { informationFixture as legacyInformationFixture, leanInformationFixture as legacyLeanInformationFixture } from './fixtures/research-benchmark-information.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { developmentDraft } from './fixtures/research-benchmark-development.mjs'

const informationFixture = () => developmentDraft(legacyInformationFixture())
const leanInformationFixture = () => developmentDraft(legacyLeanInformationFixture())


test('withheld requirements are private while every reading has the exact same visible prompt', async () => {
  const spec = informationFixture(), project = await freezeStudy(spec), task = project.tasks[0]
  assert.equal(task.compiled.text, 'Produce the requested number.\n')
  assert.equal(task.compiled.checklist.find(row => row.path === 'root/rule').disclosed, false)
  assert.ok(task.interpretations.every(reading => reading.compiled.text === task.compiled.text))
  assert.equal(task.informationPacket.observableClasses.length, 2)
  assert.equal(gradeResponse(project, task, 1).passed, true)
  assert.deepEqual(gradeResponse(project, task, 2).matchingReadings, ['number-2'])
  assert.equal(gradeResponse(project, task, 3).classification, 'outside-declared-set')
  assert.equal(gradeResponse(project, task, '{malformed').classification, 'malformed-response')
  await verifyProject(project)
})

test('a reading that changes disclosed wording or a missing/structural withheld path is refused', async () => {
  const visible = informationFixture(); visible.tasks[0].information.withheldPaths = []
  await assert.rejects(freezeStudy(visible), /changes disclosed prompt/)
  const missing = informationFixture(); missing.tasks[0].information.withheldPaths = ['root/missing']
  await assert.rejects(freezeStudy(missing), /Unknown withheld atom/)
  const structural = informationFixture(); structural.tasks[0].information.withheldPaths = ['root']
  await assert.rejects(freezeStudy(structural), /whole template/)
  const exhaustive = informationFixture(); exhaustive.tasks[0].information.scope = 'unique'
  await assert.rejects(freezeStudy(exhaustive), /finite agreement/)
})

test('tagged clarification, refusal, malformed output and actual answer remain separate measured dispositions', async () => {
  const spec = informationFixture(); spec.tasks[0].information.responseMode = 'tagged-json'
  spec.conditions = [
    ['answer', { kind: 'answer', answer: 1 }], ['question', { kind: 'clarification', message: 'Which number?' }],
    ['refusal', { kind: 'refusal', message: 'I decline.' }], ['malformed', { kind: 'clarification', answer: 1, message: 'Which?' }],
  ].map(([id, output]) => ({ ...spec.conditions[0], id, adapter: { kind: 'replay', responses: { 'number-task': output } } }))
  const project = await freezeStudy(spec), result = await runStudy(project)
  assert.match(project.tasks[0].compiled.text, /Response format/)
  assert.equal(result.summary.completed, 4)
  assert.deepEqual(Object.fromEntries(result.summary.rows.map(row => [row.conditionId, row.disposition])), { answer: 'admissible', question: 'clarification', refusal: 'refusal', malformed: 'malformed-response' })
  assert.equal(result.summary.groups.reduce((sum, group) => sum + group.passed, 0), 1)
})

test('a tagged JSON answer preserves its value type instead of parsing a string payload twice', async () => {
  const spec = informationFixture(), task = spec.tasks[0]
  task.expected = '2'; task.information.responseMode = 'tagged-json'
  task.information.readings.forEach(reading => { reading.expected = String(reading.expected) })
  const project = await freezeStudy(spec)
  assert.deepEqual(gradeResponse(project, project.tasks[0], { kind: 'answer', answer: '2' }).matchingReadings, ['number-2'])
  assert.equal(gradeResponse(project, project.tasks[0], { kind: 'answer', answer: 2 }).classification, 'outside-declared-set')
  assert.deepEqual(gradeResponse(project, project.tasks[0], '{"kind":"answer","answer":"1"}').matchingReadings, ['number-1'])
})

test('a corpus mechanically derives withheld variants and consistent reading subsets from a frozen pool', async () => {
  const spec = informationFixture(), information = spec.tasks[0].information
  information.readingPool = information.readings; delete information.readings; information.withheldPaths = []
  spec.corpusPlan = corpusPlanFromTask(spec.tasks[0])
  spec.corpusPlan.families[0].axes = [{ id: 'disclosure', choices: [{ id: 'full', edits: [] }, { id: 'withheld', edits: [{ kind: 'withhold', path: ['rule'] }] }] }]
  spec.tasks = (await materializeCorpus(spec)).tasks
  const project = await freezeStudy(spec)
  const full = project.tasks.find(task => task.factors.disclosure === 'full'), withheld = project.tasks.find(task => task.factors.disclosure === 'withheld')
  assert.deepEqual(full.interpretations.map(reading => reading.id), ['number-2'])
  assert.deepEqual(withheld.interpretations.map(reading => reading.id), ['number-1', 'number-2'])
  assert.equal(full.informationPacket.selection.candidates.find(row => row.id === 'number-1').disposition, 'disclosed-conflict')
  assert.notEqual(full.semanticId, withheld.semanticId)
})

test('review records bind the entire reading packet and are invalidated by changed rationale, roots or runtime pins', async () => {
  const spec = informationFixture(); spec.requireReview = true
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC INFORMATION FIXTURE ONLY')))
  await assert.rejects(freezeStudy(spec), /complete admissible-reading packet/)
  const compiled = await compileTask(spec, spec.tasks[0], { requireTaskReview: false })
  spec.taskReviews = [await createTaskReviewRecord(compiled, 'SYNTHETIC INFORMATION FIXTURE ONLY')]
  await freezeStudy(spec)
  for (const mutate of [copy => { copy.tasks[0].information.readings[0].rationale += ' changed' }, copy => { copy.runtimeSources = { 'tasks.mjs': 'a'.repeat(64) } }, copy => { copy.environment.fixturePin = 'changed' }]) {
    const copy = structuredClone(spec); mutate(copy)
    await assert.rejects(freezeStudy(copy), /complete admissible-reading packet/)
  }
  const text = informationFixture(); text.tasks[0].expected = '2'; text.tasks[0].information.readings.forEach(reading => { reading.expected = String(reading.expected) })
  const jsonTask = await compileTask(text, text.tasks[0])
  text.protocol.grading.kind = 'exact'
  const exactTask = await compileTask(text, text.tasks[0])
  assert.notEqual(jsonTask.informationPacket.sha256, exactTask.informationPacket.sha256, 'task review also binds the grader contract')
})

test('LEAN readings compile their own traces and finite observational agreement does not imply semantic uniqueness', async () => {
  const spec = leanInformationFixture(), task = spec.tasks[0]
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC LEAN INFORMATION ONLY')))
  const compiled = await compileTask(spec, task, { requireTaskReview: false })
  assert.deepEqual(compiled.interpretations.map(reading => reading.expected.map(fill => fill.quantity)), [[1, -1], [3, -3]])
  spec.taskReviews = [await createTaskReviewRecord(compiled, 'SYNTHETIC LEAN INFORMATION ONLY')]
  const project = await freezeStudy(spec)
  assert.equal(gradeResponse(project, project.tasks[0], compiled.interpretations[1].expected).passed, true)
  assert.equal(gradeResponse(project, project.tasks[0], task.expected).classification, 'outside-declared-set', 'the hidden donor is not the grading authority')
  const quiet = structuredClone(spec); quiet.tasks[0].input.bars.forEach(bar => { bar.prices.SPY = 11000 }); quiet.tasks[0].expected = []
  const indistinguishable = await compileTask(quiet, quiet.tasks[0], { requireTaskReview: false })
  assert.equal(indistinguishable.informationPacket.observableClasses.length, 1)
  assert.equal(indistinguishable.informationPacket.readings.length, 2)
  assert.equal(indistinguishable.informationPacket.scope, 'declared-set')
})

test('portable verification, qualification and grading retain every reading without sending private packets to adapters', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'information-export-')); t.after(() => rm(root, { recursive: true, force: true }))
  let spec = informationFixture()
  spec.conditions[0].adapter = { kind: 'command', command: process.execPath, args: ['adapter.mjs'] }
  const adapter = 'let s="";for await(const c of process.stdin)s+=c;const r=JSON.parse(s);if(["expected","interpretations","informationPacket","semantic"].some(k=>k in r)||r.prompt.includes("required number is"))process.exit(4);console.log(JSON.stringify({output:1}));\n'
  const { sha256 } = await import('../../src/benchmark/prompts.mjs')
  spec.inputs = [{ path: 'adapter.mjs', sha256: await sha256(adapter) }]
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
  spec = await bindRuntimeSources(spec, sources)
  const project = await freezeStudy(spec), files = await projectFiles(project, sources, { 'adapter.mjs': adapter })
  for (const [file, contents] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), contents) }
  for (const command of ['verify', 'qualify', 'run', 'analyze']) {
    const result = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), command], { cwd: tmpdir(), encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const evidence = JSON.parse(await readFile(resolve(root, 'results/evidence.json'), 'utf8'))
  assert.equal(evidence.summary.groups[0].passed, 1)
  assert.equal(evidence.events.find(row => row.type === 'finished').grade.classification, 'admissible')
  const packet = JSON.parse(await readFile(resolve(root, 'information/number-task.json'), 'utf8'))
  assert.equal(canonical(packet), canonical(project.tasks[0].informationPacket))
})

test('a LEAN export reconstructs every reading with its pinned helper, inputs and independently checked interpretation', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'lean-information-export-')); t.after(() => rm(root, { recursive: true, force: true }))
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
  const spec = await bindLeanReview(await bindRuntimeSources(leanInformationFixture(), sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC EXPORT TEST ONLY')))
  spec.taskReviews = [await createTaskReviewRecord(await compileTask(spec, spec.tasks[0], { requireTaskReview: false }), 'SYNTHETIC EXPORT TEST ONLY')]
  const project = await freezeStudy(spec), files = await projectFiles(project, sources)
  for (const reading of project.tasks[0].interpretations) {
    const prefix = `lean/${project.tasks[0].id}/readings/${reading.id}`
    assert.equal(files[`${prefix}/lean_reference.py`], sources['lean-reference.py'])
    assert.deepEqual(JSON.parse(files[`${prefix}/expected-trace.json`]).trace, reading.expected)
    assert.deepEqual(JSON.parse(files[`${prefix}/bars.json`]), project.tasks[0].input)
  }
  for (const [file, contents] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), contents) }
  for (const command of ['verify', 'qualify']) {
    const result = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), command], { cwd: tmpdir(), encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
})
