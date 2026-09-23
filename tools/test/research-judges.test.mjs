import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { generatePipeline, emptyPipelineDraft, pipelineSettings } from '../../src/research-pipeline.mjs'
import { emptyProtocolDecisions } from '../../src/research-protocol.mjs'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { runProject } from '../../src/benchmark/cli.mjs'
import { developmentStarter } from './fixtures/research-benchmark-development.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const FAKE = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
const args = process.argv.slice(2), get = name => args[args.indexOf(name) + 1]
if (args.includes('--version')) { console.log('fake-judge 1'); process.exit(0) }
const surface = args.includes('exec') ? 'codex-cli' : args.includes('--setting-sources') ? 'claude-cli' : 'gemini-cli'
const prompt = surface === 'gemini-cli' ? get('-p') : readFileSync(0, 'utf8')
const model = surface === 'claude-cli' ? get('--model') : get('-m')
const mode = existsSync(process.env.JUDGE_CONTROL) ? readFileSync(process.env.JUDGE_CONTROL, 'utf8') : ''
const judging = prompt.includes('Evaluate the task and contestant response in the following JSON.')
let result = judging ? 'PASS' : 'Only this probe message is visible in the clean directory.'
const plant = join(process.cwd(), surface === 'claude-cli' ? 'CLAUDE.md' : surface === 'codex-cli' ? 'AGENTS.md' : 'GEMINI.md')
if (existsSync(plant)) result = readFileSync(plant, 'utf8').match(/LB-CANARY-[A-Z0-9]+/)[0] + '\n' + result
if (judging) appendFileSync(process.env.JUDGE_LOG, JSON.stringify({ prompt, model, surface, args, executable: basename(process.argv[1]), cwd: process.cwd(), settings: surface === 'gemini-cli' ? JSON.parse(readFileSync(join(process.env.HOME, '.gemini/settings.json'), 'utf8')) : null }) + '\n')
if (judging && model === 'judge-codex') {
  if (mode === 'quota') result = 'Quota exhausted. Please retry later.'
  if (mode === 'truncated') result = 'output token maximum exceeded'
  if (mode === 'empty') result = ''
  if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 3000))
}
if (surface === 'claude-cli') console.log(JSON.stringify({ result, usage: { input_tokens: 9, output_tokens: 1 }, modelUsage: { [model]: {} } }))
else if (surface === 'codex-cli') { writeFileSync(get('-o'), result); console.log(JSON.stringify({ type: 'thread.started', model })); console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 1 } })) }
else console.log(JSON.stringify({ response: result, stats: { models: { [model]: {} } } }))
if (mode === 'bad-canary' && !judging && model === 'judge-codex') process.exitCode = 1
if (mode === 'exit' && judging && model === 'judge-codex') process.exitCode = 7
`

async function fixture(t, { canary = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'research-judges-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const log = join(root, 'judge-calls.jsonl'), control = join(root, 'control.txt')
  const executables = {}
  for (const name of ['contestant', 'judge-claude', 'judge-codex', 'judge-gemini']) {
    executables[name] = join(root, name + '.mjs'); await writeFile(executables[name], FAKE)
  }
  const draft = { ...emptyPipelineDraft(), root: join(root, 'room'),
    rows: [{ surface: 'claude-cli', model: 'contestant', executable: executables.contestant, efforts: ['low'] }],
    judges: ['claude', 'codex', 'gemini'].map((name, index) => ({ surface: name + '-cli', model: 'judge-' + name, effort: ['high', 'max', 'medium'][index], executable: executables['judge-' + name], prompt: 'Judge ' + name + ': inspect the answer and return PASS or FAIL.' })) }
  const settings = pipelineSettings(emptyProtocolDecisions(), { timeoutMs: 500 })
  settings.canary.required = canary
  settings.envAllowlist = ['PATH', 'SystemRoot', 'windir', 'JUDGE_CONTROL', 'JUDGE_LOG']
  const generated = generatePipeline(draft, settings)
  const spec = developmentStarter()
  spec.inputs = await Promise.all(Object.entries(generated.files).map(async ([path, bytes]) => ({ path, sha256: await sha256(bytes) })))
  const project = await freezeStudy(await bindRuntimeSources(spec, sources))
  for (const [path, bytes] of Object.entries(await projectFiles(project, sources, generated.files))) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes)
  }
  await runProject(root, { output: join(root, 'results') })
  const run = script => spawnSync(process.execPath, [join(root, 'harness', script)], { cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: join(root, 'unused-profile'), USERPROFILE: join(root, 'unused-profile'), APPDATA: join(root, 'unused-appdata'), JUDGE_CONTROL: control, JUDGE_LOG: log } })
  const calls = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
  const records = async () => {
    const directory = join(root, 'results/judges'), names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    return Promise.all(names.map(async name => ({ name, value: JSON.parse(await readFile(join(directory, name), 'utf8')) })))
  }
  return { root, project, generated, control, log, run, calls, records }
}

test('exported judges consume retained answers, respect each executable/model and resume without new calls', async t => {
  const f = await fixture(t)
  const journal = await readFile(join(f.root, 'results/attempts.jsonl'))
  const refused = f.run('judge.mjs')
  assert.equal(refused.status, 1); assert.match(refused.stderr, /no same-day canary/); assert.equal((await f.calls()).length, 0)
  const canary = f.run('canary.mjs'); assert.equal(canary.status, 0, canary.stderr + canary.stdout)
  const judged = f.run('judge.mjs'); assert.equal(judged.status, 0, judged.stderr)
  const summary = JSON.parse(judged.stdout)
  assert.equal(summary.completed, 6); assert.equal(summary.incomplete, 0); assert.equal(summary.aggregation, 'separate')
  const calls = await f.calls(); assert.equal(calls.length, 6)
  for (const call of calls) {
    assert.equal(call.executable, call.model + '.mjs', 'a judge never inherits the contestant executable')
    assert.ok(call.prompt.startsWith('Judge ' + call.surface.split('-')[0]))
    const evidence = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n{"task":') + 1))
    assert.match(evidence.task.prompt, /Return only the result/)
    assert.ok(['5', '11'].includes(evidence.response))
    if (call.surface === 'claude-cli') assert.equal(call.args[call.args.indexOf('--effort') + 1], 'high')
    if (call.surface === 'codex-cli') assert.ok(call.args.includes('model_reasoning_effort=max'))
    if (call.surface === 'gemini-cli') assert.deepEqual(call.settings.modelConfigs.customOverrides, [{ match: { model: 'judge-gemini' }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: 'MEDIUM' } } } }])
  }
  const records = await f.records(); assert.equal(records.length, 6)
  for (const { value } of records) {
    assert.equal(value.verdict, 'PASS', 'a short verdict is not a provider notice')
    assert.equal(value.completion.status, 'complete'); assert.match(value.binding.responseSha256, /^[a-f0-9]{64}$/)
    assert.equal(value.judge.servedModel, value.judge.requestedModel)
    assert.equal(value.harness.isolation.cwdEmpty, true)
  }
  const again = f.run('judge.mjs'); assert.equal(again.status, 0, again.stderr)
  assert.equal(JSON.parse(again.stdout).reused, 6); assert.equal((await f.calls()).length, 6)
  assert.deepEqual(await readFile(join(f.root, 'results/attempts.jsonl')), journal, 'judging leaves collection and registered grades unchanged')
})

for (const [mode, reason] of [['quota','provider-blocked'], ['truncated','judge-truncation'], ['empty','judge-error'], ['exit','judge-error'], ['timeout','judge-error']]) {
  test('judge ' + mode + ' is retained as incomplete without an automatic retry', async t => {
    const f = await fixture(t, { canary: false }); await writeFile(f.control, mode)
    const result = f.run('judge.mjs'); assert.equal(result.status, 2, result.stderr)
    assert.equal(JSON.parse(result.stdout).completed, 4)
    const failed = (await f.records()).filter(({ value }) => value.judge.requestedModel === 'judge-codex')
    assert.equal(failed.length, 2)
    for (const { value } of failed) { assert.equal(value.verdict, null); assert.equal(value.completion.reason, reason) }
    const again = f.run('judge.mjs'); assert.equal(again.status, 2); assert.equal(JSON.parse(again.stdout).reused, 6)
    assert.equal((await f.calls()).length, 6)
  })
}

test('failed repeat canary revokes the judge certificate and prevents calls', async t => {
  const f = await fixture(t)
  assert.equal(f.run('canary.mjs').status, 0)
  await writeFile(f.control, 'bad-canary'); assert.equal(f.run('canary.mjs').status, 5)
  const result = f.run('judge.mjs'); assert.equal(result.status, 1); assert.match(result.stderr, /no same-day canary/)
  assert.equal((await f.calls()).length, 0)
})

test('interrupted reservations and altered retained answers stop judging before another call', async t => {
  const f = await fixture(t, { canary: false })
  assert.equal(f.run('judge.mjs').status, 0)
  const records = await f.records(), first = records[0]
  await rm(join(f.root, 'results/judges', first.name))
  const interrupted = f.run('judge.mjs'); assert.equal(interrupted.status, 1); assert.match(interrupted.stderr, /interrupted/)
  assert.equal((await f.calls()).length, 6)
  const files = await readdir(join(f.root, 'results/responses')), path = join(f.root, 'results/responses', files[0])
  const retained = JSON.parse(await readFile(path, 'utf8')); retained.response.output = 'changed answer'
  await writeFile(path, canonical(retained) + '\n')
  const changed = f.run('judge.mjs'); assert.equal(changed.status, 1); assert.match(changed.stderr, /differs from the attempt journal/)
  assert.equal((await f.calls()).length, 6)
})
