import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sha256, canonical } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, RUNTIME_FILES, freezeStudy, safePath, summaryCsv, gradeResponse } from '../../src/benchmark/study.mjs'
import { genericStarter as legacyStarter } from '../../src/benchmark/starters.mjs'
import { developmentStarter } from './fixtures/research-benchmark-development.mjs'
import { runStudy, validateJournal } from '../../src/benchmark/runner.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { createAdapter, readProject, runProject } from '../../src/benchmark/cli.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
async function exported(t, update = () => {}, attachments = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'benchmark-runtime-')); t.after(() => rm(root, { recursive: true, force: true }))
  const spec = developmentStarter(); spec.tasks.length = 1; update(spec)
  spec.inputs.push(...await Promise.all(Object.entries(attachments).map(async ([path, text]) => ({ path, sha256: await sha256(text) }))))
  const project = await freezeStudy(await bindRuntimeSources(spec, sources)), files = await projectFiles(project, sources, attachments)
  for (const [file, text] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text) }
  return { root, project, files }
}

test('custom adapters and graders execute outside the runner and retain their raw output', async t => {
  const { root } = await exported(t, spec => {
    spec.conditions[0].adapter = { kind: 'module', file: 'adapters/example.mjs' }
    spec.protocol.grading = { kind: 'module', file: 'graders/example.mjs' }
  }, {
    'adapters/example.mjs': 'export async function run(request) { if ("expected" in request) throw Error("answer leak"); console.error("adapter log"); return {output:"5",usage:{tokens:3}} }',
    'graders/example.mjs': 'export function grade(project,task,output) { console.error("grader log"); return {passed:output===task.expected,score:output===task.expected?1:0} }',
  })
  const result = await runProject(root)
  assert.equal(result.summary.completed, 1); assert.equal(result.summary.groups[0].passed, 1)
  assert.match(result.events[1].response.process.stderr, /adapter log/)
  assert.match(result.events[1].grade.process.stderr, /grader log/)
})

test('CLI rechecks custom grades before status, analysis and resume without replacing original process evidence', async t => {
  const { root } = await exported(t, spec => { spec.protocol.grading = { kind: 'module', file: 'grade.mjs' } }, {
    'grade.mjs': 'export function grade(project,task,output) { console.error("original grading log"); const passed=output===task.expected; return {passed,score:Number(passed)} }',
  })
  const result = await runProject(root)
  assert.equal(result.summary.completed, 1)
  const journal = resolve(root, 'results/attempts.jsonl'), original = await readFile(journal, 'utf8')
  const invoke = action => spawnSync(process.execPath, [resolve(root, 'cli.mjs'), action], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  for (const action of ['status', 'analyze', 'run']) {
    const checked = invoke(action)
    assert.equal(checked.status, 0, checked.stderr || checked.error?.message)
    assert.equal(await readFile(journal, 'utf8'), original)
  }
  const edited = structuredClone(result.events)
  const completed = edited.find(event => event.status === 'completed')
  completed.grade = { ...completed.grade, passed: false, score: 0 }
  const forged = edited.map(canonical).join('\n') + '\n'
  await writeFile(journal, forged)
  for (const action of ['status', 'analyze', 'run']) {
    const checked = invoke(action)
    assert.notEqual(checked.status, 0)
    assert.match(checked.stderr, /recorded custom grade disagrees/)
    assert.equal(await readFile(journal, 'utf8'), forged)
  }
})

test('CPU-blocking module times out, closes its process, and retains output before releasing the run lock', async t => {
  const { root } = await exported(t, spec => {
    spec.conditions[0].adapter = { kind: 'module', file: 'hang.mjs' }; spec.protocol.timeoutMs = 250
  }, { 'hang.mjs': 'export function run() { process.stderr.write("entered hang\\n"); for (;;) {} }' })
  const result = await runProject(root)
  assert.equal(result.summary.completed, 0); assert.equal(result.summary.failed, 1)
  assert.match(result.events[1].reason, /budget exceeded/); assert.match(result.events[1].response.stderr, /entered hang/)
  await assert.rejects(readFile(resolve(root, 'results/.run-lock/owner.json')), { code: 'ENOENT' })
})

test('a timed-out custom grader retains both the system response and grader failure output', async t => {
  const { root } = await exported(t, spec => { spec.protocol.grading = { kind: 'module', file: 'hang.mjs' }; spec.protocol.timeoutMs = 250 }, {
    'hang.mjs': 'export function grade() { process.stderr.write("grader entered\\n"); for (;;) {} }',
  })
  const result = await runProject(root)
  assert.equal(result.events[1].response.output, '5'); assert.match(result.events[1].gradingEvidence.stderr, /grader entered/)
  assert.equal(result.summary.completed, 0)
})

test('split UTF-8 command chunks preserve the exact response bytes', async t => {
  const { root } = await exported(t, spec => {
    spec.tasks[0].expected = '🦉'; spec.conditions[0].adapter = { kind: 'command', command: process.execPath, args: ['unicode.mjs'] }
  }, { 'unicode.mjs': 'const b=Buffer.from(JSON.stringify({output:"🦉"})); for(const byte of b){process.stdout.write(Buffer.from([byte])); await new Promise(r=>setTimeout(r,2))}' })
  const result = await runProject(root); assert.equal(result.summary.groups[0].passed, 1)
  assert.equal(result.events[1].response.output, '🦉')
})

test('HTTP contract retains successful, malformed and failed response bodies without leaking credentials into requests', async t => {
  const project = await freezeStudy(developmentStarter()), task = project.tasks[0], trial = project.schedule.find(row => row.taskId === task.id)
  const condition = { ...project.spec.conditions[0], adapter: { kind: 'http', url: 'https://fixture.invalid/run' } }
  let body, mode = 'ok'
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, condition.adapter.url); assert.equal(options.redirect, 'error'); body = JSON.parse(options.body)
    return new Response(mode === 'ok' ? '{"output":"🦉"}' : 'malformed raw', { status: mode === 'error' ? 503 : 200 })
  })
  const invoke = () => createAdapter(tmpdir())({ project, task, trial, condition, attempt: 1, signal: new AbortController().signal })
  const result = await invoke(); assert.equal(result.output, '🦉'); assert.equal(result.http.body, '{"output":"🦉"}'); assert.equal('expected' in body, false)
  mode = 'malformed'; await assert.rejects(invoke(), error => error.evidence.body === 'malformed raw')
  mode = 'error'; await assert.rejects(invoke(), error => error.evidence.status === 503 && error.evidence.body === 'malformed raw')
})

test('changed module content changes the frozen project identity and export refuses undeclared attachments', async t => {
  const first = await exported(t, spec => { spec.conditions[0].adapter = { kind: 'module', file: 'adapter.mjs' } }, { 'adapter.mjs': 'export const run=()=>({output:"5"})' })
  const second = await exported(t, spec => { spec.conditions[0].adapter = { kind: 'module', file: 'adapter.mjs' } }, { 'adapter.mjs': 'export const run=()=>({output:"9"})' })
  assert.notEqual(first.project.sha256, second.project.sha256)
  await assert.rejects(projectFiles(first.project, sources, { 'unreviewed.mjs': '// absent from frozen inputs' }), /Pin attached file/)
  const manifest = JSON.parse(first.files['manifest.json'])
  await writeFile(resolve(first.root, 'runner.mjs'), '// substitute runtime')
  manifest.files['runner.mjs'] = await sha256('// substitute runtime')
  await writeFile(resolve(first.root, 'manifest.json'), canonical(manifest))
  await assert.rejects(readProject(first.root), /runtime source differs/)
})

test('portable verification regenerates IR, prose, checklist and source maps even if their manifest hashes are rewritten', async t => {
  const { root, project, files } = await exported(t)
  const id = project.tasks[0].id, originalManifest = files['manifest.json']
  for (const file of ['composition/' + id + '.json', 'prompts/' + id + '.txt', 'checklists/' + id + '.json', 'source-maps/' + id + '.json']) {
    const changed = files[file] + ' ', manifest = JSON.parse(originalManifest)
    await writeFile(resolve(root, file), changed)
    manifest.files[file] = await sha256(changed)
    await writeFile(resolve(root, 'manifest.json'), canonical(manifest))
    await assert.rejects(readProject(root), /Generated composition artifact changed/)
    await writeFile(resolve(root, file), files[file])
    delete manifest.files[file]
    await writeFile(resolve(root, 'manifest.json'), canonical(manifest))
    await assert.rejects(readProject(root), /manifest omits a composition artifact/)
    await writeFile(resolve(root, 'manifest.json'), originalManifest)
  }
  assert.equal((await readProject(root)).sha256, project.sha256)
})

test('post-run verification rejects in-place input mutation while retaining every attempt', async t => {
  const { root } = await exported(t, spec => { spec.conditions[0].adapter = { kind: 'command', command: process.execPath, args: ['mutate.mjs'] } }, {
    'data.txt': 'fixed input',
    'mutate.mjs': 'import {writeFileSync} from "node:fs";writeFileSync("data.txt","changed");console.log(JSON.stringify({output:"5"}))',
  })
  await assert.rejects(runProject(root), /Frozen file changed/)
  const events = (await readFile(resolve(root, 'results/attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(events.length, 2); assert.equal(events[1].response.output, '5')
  await assert.rejects(readFile(resolve(root, 'results/summary.json')), { code: 'ENOENT' })
})

test('journal grades, elapsed time and cumulative recovery budgets cannot be rewritten or reset on resume', async () => {
  const spec = developmentStarter(); spec.tasks.length = 1; spec.protocol.maxAttemptsPerTrial = 2; spec.protocol.timeoutMs = 20; spec.protocol.maxDurationMs = 20
  const project = await freezeStudy(spec), result = await runStudy(project)
  const changed = structuredClone(result.events); changed[1].grade.score = 0
  assert.throws(() => validateJournal(project, changed), /disagrees/)
  changed[1] = { ...result.events[1], elapsedMs: -1 }; assert.throws(() => validateJournal(project, changed), /duration/)
  const recovered = await runStudy(project, { events: result.events.slice(0, 1), recover: true, adapter: () => assert.fail('budget already consumed') })
  assert.equal(recovered.summary.completed, 0); assert.equal(recovered.events[1].budgetChargeMs, 20)
  await runStudy(project, { events: recovered.events, adapter: () => assert.fail('resume must retain time budget') })
})

test('standalone qualification is an explicit portable apparatus check', async t => {
  const { root, project } = await exported(t)
  const result = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), 'qualify'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const record = JSON.parse(await readFile(resolve(root, 'results/qualification.json'), 'utf8'))
  assert.equal(record.projectSha256, project.sha256); assert.equal(record.checks[0].passed, true)
  assert.match(record.scope, /does not execute a model or the LEAN engine/)
})

test('portable paths reject Windows device aliases and CSV protects text formulas without changing numeric scores', () => {
  for (const path of ['data/CON.txt', 'aux', 'x\n.csv', 'x?.mjs', 'a/../b', 'C:/x', 'a\\b']) assert.equal(safePath(path), false, path)
  assert.equal(safePath('adapters/system.mjs'), true)
  const csv = summaryCsv({ execution: { purpose: 'apparatus-development', evidenceClass: 'development-computations', experimentalCollection: 'not-admitted', referenceAncestry: [] }, rows: [{ id: '  =1+1', score: -2 }] })
  assert.match(csv, /"'  =1\+1"/); assert.match(csv, /"-2"/); assert.doesNotMatch(csv, /"'-2"/)
})

test('exact text grading cannot coerce different objects or numeric types into a passing answer', async () => {
  const spec = legacyStarter(), project = await freezeStudy(spec), task = project.tasks[0]
  assert.equal(gradeResponse(project, task, '5').passed, true)
  assert.equal(gradeResponse(project, task, 5).passed, false)
  spec.tasks[0].expected = { answer: 5 }
  await assert.rejects(freezeStudy(spec), /exact text grading needs a string/)
})

test('grader failure retains the response and stops collection without retrying or redrawing on resume', async () => {
  const spec = developmentStarter(); spec.protocol.maxAttemptsPerTrial = 3
  spec.protocol.grading = { kind: 'module', file: 'broken-grader.mjs' }
  spec.inputs.push({ path: 'broken-grader.mjs', sha256: await sha256('export function grade() { throw new Error("Broken apparatus fixture") }') })
  const project = await freezeStudy(spec); let calls = 0
  const result = await runStudy(project, { adapter: async () => { calls++; return { output: 'retained response' } }, grade: () => { throw new Error('Broken apparatus fixture') } })
  assert.equal(calls, 1); assert.equal(result.summary.attempts, 1); assert.equal(result.summary.pending, 1)
  assert.equal(result.events[1].phase, 'grading'); assert.equal(result.events[1].response.output, 'retained response')
  await assert.rejects(runStudy(project, { events: result.events, adapter: () => assert.fail('must not redraw') }), /resuming cannot redraw/)
})

test('raw responses are durable before grading and interrupted grading cannot redraw them', async t => {
  const { root, project } = await exported(t)
  const result = await runProject(root)
  const start = result.events[0], responseFile = resolve(root, 'results/responses', `${start.trialId}-${start.attempt}.json`)
  assert.equal(start.runtime.node, process.version)
  const response = JSON.parse(await readFile(responseFile, 'utf8'))
  assert.equal(response.projectSha256, project.sha256); assert.equal(response.response.output, '5')
  await writeFile(resolve(root, 'results/attempts.jsonl'), canonical(start) + '\n')
  await assert.rejects(runProject(root, { recover: true }), /already has a retained system response/)
  assert.equal((await readFile(resolve(root, 'results/attempts.jsonl'), 'utf8')).trim().split('\n').length, 1)
  let durable = false
  const diagnostic = developmentStarter(); diagnostic.tasks.length = 1
  diagnostic.protocol.grading = { kind: 'module', file: 'durability-grader.mjs' }
  diagnostic.inputs.push({ path: 'durability-grader.mjs', sha256: await sha256('export const grade = () => ({passed:true,score:1})') })
  let grades = 0
  await runStudy(await freezeStudy(diagnostic), { recordResponse: async () => { durable = true }, grade: () => { grades++; assert.equal(durable, true); return { passed: true, score: 1 } } })
  assert.equal(grades, 1)
})

test('JSON string answers qualify through their declared wire format and exact Node pins are enforced', async t => {
  const { root } = await exported(t, spec => { spec.protocol.grading = { kind: 'json' }; spec.tasks[0].expected = 'hello' })
  const qualified = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), 'qualify'], { encoding: 'utf8' })
  assert.equal(qualified.status, 0, qualified.stderr)
  const pinned = await exported(t, spec => { spec.environment.nodeVersion = '22.0.9999' })
  await assert.rejects(readProject(pinned.root), /project pins Node/)
})

test('unconfirmed grader cleanup records the failure and requires retaining the output lock', async () => {
  const spec = developmentStarter()
  spec.protocol.grading = { kind: 'module', file: 'unsettled-grader.mjs' }
  spec.inputs.push({ path: 'unsettled-grader.mjs', sha256: await sha256('export function grade() { throw Object.assign(new Error("Owned execution cleanup unavailable"), {terminationConfirmed:false}) }') })
  const project = await freezeStudy(spec), records = []
  await assert.rejects(runStudy(project, { append: async record => records.push(record), grade: () => { throw Object.assign(new Error('Owned execution cleanup unavailable'), { terminationConfirmed: false }) }, settle: async () => true }), error => error.keepLock === true)
  assert.equal(records.length, 2); assert.equal(records[1].status, 'failed'); assert.equal(records[1].phase, 'grading')
  assert.equal(records[1].response.output, project.spec.conditions[0].adapter.responses[project.schedule[0].taskId])
})
