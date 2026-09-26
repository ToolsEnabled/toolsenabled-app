import { PYTHON_COMMAND, PYTHON_ARGS } from './lib/python-command.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { approveBundle, compilePrompt, reviewStatus, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, RUNTIME_FILES, freezeStudy, verifyProject } from '../../src/benchmark/study.mjs'
import { developmentStarter } from './fixtures/research-benchmark-development.mjs'
import { runStudy, validateJournal } from '../../src/benchmark/runner.mjs'
import { projectFiles, zipFiles } from '../../src/benchmark/export.mjs'
import { readProject, runProject } from '../../src/benchmark/cli.mjs'
import { createBenchmarkStore } from '../../src/research-benchmark-store.js'
import { exportedBenchmarkExperiment } from '../../src/research-benchmark-dispatch.js'

const sourceNames = RUNTIME_FILES
const sources = Object.fromEntries(await Promise.all(sourceNames.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
async function exported(t, spec = developmentStarter(), extra = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'research-benchmark-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  spec = structuredClone(spec)
  for (const [path, text] of Object.entries(extra)) if (!spec.inputs.some(input => input.path === path)) spec.inputs.push({ path, sha256: await sha256(text) })
  const project = await freezeStudy(await bindRuntimeSources(spec, sources)), files = await projectFiles(project, sources, extra)
  for (const [file, text] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text) }
  return { root, project, files }
}

test('recursive slots compose child output and parameters without rescanning inserted text', async () => {
  const spec = developmentStarter()
  const root = { use: 'context', params: { instruction: 'Outer' }, slots: { task: { use: 'context', params: { instruction: 'Inner' }, slots: { task: { use: 'task', params: { a: 4, b: 9 } } } } } }
  const output = await compilePrompt(spec.catalog, root)
  assert.equal(output.text, 'Outer\n\nInner\n\nReturn only the result of 4 + 9.')
  assert.equal(output.depth, 2)
  assert.deepEqual(output.checklist.map(row => row.path), ['root', 'root/task', 'root/task/task'])
  root.params.instruction = '{{slot:task}}'
  assert.match((await compilePrompt(spec.catalog, root)).text, /^\{\{slot:task\}\}\n/)
})
test('missing slots, wrong roles, cycles, duplicate IDs and missing parameters are rejected', async () => {
  const spec = developmentStarter()
  await assert.rejects(compilePrompt(spec.catalog, { use: 'context' }), /fill the task/)
  const cycle = { use: 'context', slots: {} }; cycle.slots.task = cycle
  await assert.rejects(compilePrompt(spec.catalog, cycle), /cyclic/)
  await assert.rejects(compilePrompt([...spec.catalog, spec.catalog[0]], { use: 'task' }), /Duplicate/)
  // PROMPT B: the refusal names the role the bundle has and what the place
  // accepts, in whatever words that catalog uses, rather than a role name this
  // compiler carries.
  spec.catalog[0].role = 'quelque-chose'
  await assert.rejects(compilePrompt(spec.catalog, { use: 'task' }), /has role quelque-chose, and this place accepts node/)
  spec.catalog[0].role = 'node'; spec.catalog[0].parameters = {}
  await assert.rejects(compilePrompt(spec.catalog, { use: 'task' }), /missing parameter/)
})
test('review binds wording, behavior, hooks and tests; changing any invalidates it', async () => {
  const bundle = await approveBundle({ ...developmentStarter().catalog[0], hooks: { evaluate: 'v1' }, tests: ['case1'] }, 'TEST FIXTURE REVIEWER')
  assert.equal((await reviewStatus(bundle)).approved, true)
  for (const change of [v => { v.text += ' changed' }, v => { v.semantics.a = 9 }, v => { v.hooks.evaluate = 'v2' }, v => { v.tests.push('case2') }]) {
    const copy = structuredClone(bundle); change(copy); assert.equal((await reviewStatus(copy)).approved, false)
  }
  const spec = developmentStarter(); spec.requireReview = true
  await assert.rejects(freezeStudy(spec), /needs review/)
})
test('freezing is deterministic, detects mutations and rejects duplicate semantic tasks', async () => {
  const spec = developmentStarter(), project = await freezeStudy(spec)
  assert.deepEqual(project, await freezeStudy(spec)); await verifyProject(project)
  project.tasks[0].compiled.text = 'altered'
  await assert.rejects(verifyProject(project), /changed/)
  spec.tasks[1] = { ...spec.tasks[0], id: 'duplicate' }
  await assert.rejects(freezeStudy(spec), /duplicate semantic task/)
})
test('wrong answers are measured, never retried as transport failures', async () => {
  const spec = developmentStarter(); spec.conditions[0].adapter.responses['addition-b'] = 'wrong'; spec.protocol.maxAttemptsPerTrial = 3
  const result = await runStudy(await freezeStudy(spec))
  assert.equal(result.summary.completed, 2); assert.equal(result.summary.attempts, 2)
  assert.equal(result.summary.groups[0].passed, 1); assert.equal(result.summary.groups[0].passRate, .5)
  assert.equal(result.events[3].response.output, 'wrong')
})
test('transport retries obey both budgets and preserve raw failures', async () => {
  const spec = developmentStarter(); spec.protocol.maxAttemptsPerTrial = 3; spec.protocol.maxTotalAttempts = 2
  const result = await runStudy(await freezeStudy(spec), { adapter: async () => { const e = new Error('Bad command'); e.evidence = { stdout: 'raw', stderr: 'failed' }; throw e } })
  assert.equal(result.summary.attempts, 2); assert.equal(result.summary.failed, 1); assert.equal(result.summary.pending, 1)
  assert.equal(result.summary.groups[0].meanScore, null); assert.equal(result.events[1].response.stderr, 'failed')
})
test('cancel and late response cannot record success or dispatch another trial', async () => {
  const controller = new AbortController(), project = await freezeStudy(developmentStarter())
  let reply, calls = 0
  const result = await runStudy(project, { signal: controller.signal, adapter: async () => {
    calls++; queueMicrotask(() => controller.abort(new Error('Cancel test')))
    return new Promise(resolve => { reply = resolve })
  } })
  reply({ output: '5' }); await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(calls, 1); assert.equal(result.summary.completed, 0); assert.equal(result.events.at(-1).status, 'cancelled')
})
test('resume skips completed trials; recovery consumes attempts; duplicate and foreign journal records refuse', async () => {
  const spec = developmentStarter(); spec.protocol.maxAttemptsPerTrial = 2
  const project = await freezeStudy(spec), first = await runStudy(project)
  assert.deepEqual((await runStudy(project, { events: first.events, adapter: () => assert.fail('duplicate dispatch') })).events, first.events)
  const start = first.events.slice(0, 1)
  await assert.rejects(runStudy(project, { events: start }), /explicitly recover/)
  const recovered = await runStudy(project, { events: start, recover: true })
  assert.equal(recovered.events[1].status, 'interrupted'); assert.equal(recovered.events[2].attempt, 2); assert.equal(recovered.summary.attempts, 3)
  assert.throws(() => validateJournal(project, [...first.events, { ...first.events[1], seq: 5 }]), /duplicate/)
  assert.throws(() => validateJournal(project, [{ ...start[0], projectSha256: 'other' }]), /binding/)
})
test('failed durable start prevents dispatch', async () => {
  await assert.rejects(runStudy(await freezeStudy(developmentStarter()), { append: async () => { throw new Error('disk full') }, adapter: () => assert.fail('unrecorded dispatch') }), /disk full/)
})
test('clean exported CLI and ZIP run without the repository and agree with GUI grades and schedule', async t => {
  const { root, project, files } = await exported(t)
  for (const action of ['verify', 'run']) {
    const command = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), action], { cwd: tmpdir(), encoding: 'utf8' })
    assert.equal(command.status, 0, command.stderr)
  }
  const summary = JSON.parse(await readFile(resolve(root, 'results/summary.json'), 'utf8')), browser = await runStudy(project)
  assert.deepEqual(summary.groups, browser.summary.groups)
  assert.deepEqual(summary.rows.map(({ latencyMs, ...row }) => row), browser.summary.rows.map(({ latencyMs, ...row }) => row))
  const resumed = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), 'run'], { encoding: 'utf8' })
  assert.equal(JSON.parse(resumed.stdout).summary.attempts, 2)
  const zip = zipFiles(files); await writeFile(resolve(root, 'bundle.zip'), zip)
  const check = spawnSync(PYTHON_COMMAND, [...PYTHON_ARGS, '-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read("cli.mjs")', resolve(root, 'bundle.zip')], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr); assert.deepEqual(zip, zipFiles(files))
})
test('commands receive frozen prompts and settings without answer keys and preserve stdout/stderr', async t => {
  const spec = developmentStarter(); spec.conditions[0].adapter = { kind: 'command', command: process.execPath, args: ['adapter.mjs'] }
  const source = 'let s="";for await(const c of process.stdin)s+=c;const r=JSON.parse(s);if("expected"in r||!r.prompt)process.exit(3);const n=r.prompt.match(/(\\d+) \\+ (\\d+)/);console.error("adapter evidence");console.log(JSON.stringify({output:String(+n[1]+ +n[2]),usage:{tokens:7}}));\n'
  const { root } = await exported(t, spec, { 'adapter.mjs': source })
  const result = await runProject(root)
  assert.equal(result.summary.groups[0].passed, 2); assert.match(result.events[1].response.process.stderr, /adapter evidence/); assert.equal(result.events[1].response.usage.tokens, 7)
})
test('verification rejects changed source, missing inputs and escaped symlinks', async t => {
  const { root } = await exported(t); await writeFile(resolve(root, 'prompts.mjs'), '// modified')
  await assert.rejects(readProject(root), /Frozen file changed/)
  const spec = developmentStarter(); spec.inputs = [{ path: 'data/missing.txt', sha256: await sha256('expected') }]
  const other = await exported(t, spec); await assert.rejects(readProject(other.root), /ENOENT/)
  if (process.platform !== 'win32') { await mkdir(resolve(other.root, 'data')); await symlink(resolve(root, 'prompts.mjs'), resolve(other.root, 'data/missing.txt')); await assert.rejects(readProject(other.root), /leaves the project/) }
})
test('service declaration pins exact CLI/manifest, handles Linux and Windows, and refuses unfiled runs', async () => {
  const project = await freezeStudy(await bindRuntimeSources(developmentStarter(), sources)), files = await projectFiles(project, sources)
  for (const directory of ['/tmp/benchmark space', 'C:\\Benchmarks\\Study One']) {
    const spec = await exportedBenchmarkExperiment({ project, directory, command: 'node', files, projectId: 'rp-abcd' })
    assert.equal(spec.runner.pinnedFiles.length, sourceNames.length + 2); assert.equal(spec.runner.args[3], directory); assert.equal(spec.runner.pinnedFiles[0].sha256, await sha256(files['manifest.json']))
  }
  await assert.rejects(exportedBenchmarkExperiment({ project, directory: '/tmp/x', command: 'node', files }), /Choose a saved/)
})
test('chunked account save preserves prior revision on failure and isolates projects', async () => {
  const rows = new Map(); let rejectKey = null
  const account = { getSetting: async key => ({ ok: true, value: rows.get(key) ?? null }), putSetting: async (key, value) => { if (key === rejectKey) return { ok: false, reason: 'full' }; rows.set(key, value); return { ok: true } } }
  const store = createBenchmarkStore(account), value = { spec: developmentStarter(), editor: 'x'.repeat(90000) }
  await store.save('rp-abcd', value); assert.deepEqual(await store.read('rp-abcd'), value)
  rejectKey = 'research_benchmark_rp-abcd_1_1'
  await assert.rejects(store.save('rp-abcd', { ...value, editor: 'y'.repeat(90000) }), /full/)
  assert.deepEqual(await store.read('rp-abcd'), value); assert.equal(await store.read('rp-aaaa'), null)
})
