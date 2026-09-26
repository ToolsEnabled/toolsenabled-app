// The exported judge runner reads verdicts by the registered format and writes
// a summary beside the records. Fake judges answer by name; the fixture lives
// in a retained scratch directory (printed as a diagnostic) and the recording
// policy keeps working directories. Run with deletions refused: the runner's
// own lock removal at the end is tolerated when it is refused.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { generatePipeline, emptyPipelineDraft, pipelineSettings } from '../../src/research-pipeline.mjs'
import { emptyProtocolDecisions } from '../../src/research-protocol.mjs'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { openProject } from '../../src/benchmark/cli.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { developmentStarter } from './fixtures/research-benchmark-development.mjs'
import { JUDGE_RUNNER } from '../../src/research-judges.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const FAKE = String.raw`
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2), get = name => args[args.indexOf(name) + 1]
if (args.includes('--version')) { console.log('fake-judge 1'); process.exit(0) }
const prompt = readFileSync(0, 'utf8'), model = get('--model')
const judging = prompt.includes('Evaluate the task and contestant response in the following JSON.')
const answers = { 'pass-fail': { 'judge-yes': 'The program is correct. Verdict: PASS', 'judge-no': 'It fails the task. Verdict: FAIL', 'judge-maybe': 'I cannot tell.' }, score: { 'judge-yes': 'Reasoning... Score: 9/10', 'judge-no': 'Score: 3/10', 'judge-maybe': 'Score: 7/10' } }
let result = judging ? (answers[process.env.JUDGE_STYLE] || answers['pass-fail'])[model] : 'Only this probe message is visible in the clean directory.'
const plant = join(process.cwd(), 'CLAUDE.md')
if (existsSync(plant)) result = readFileSync(plant, 'utf8').match(/LB-CANARY-[A-Z0-9]+/)[0] + '\n' + result
console.log(JSON.stringify({ result, usage: { input_tokens: 9, output_tokens: 1 }, modelUsage: { [model]: {} } }))
`

const HTTP_JUDGE = String.raw`
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
const server = createServer((request, response) => {
  let bytes = ''
  request.on('data', chunk => { bytes += chunk })
  request.on('end', () => {
    const body = JSON.parse(bytes), judging = body.prompt.includes('Evaluate the task and contestant response in the following JSON.')
    appendFileSync(process.argv[2], JSON.stringify({ model: body.model, judging }) + '\n')
    if (request.headers.authorization !== 'Bearer fixture-key') { response.writeHead(401); response.end('{"error":"missing fixture credential"}'); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ model: body.model, output: judging ? body.model === 'judge-no' ? 'Verdict: FAIL' : 'Verdict: PASS' : 'Only this probe message is visible to this HTTP endpoint.', truncated: judging && body.model === 'judge-maybe' }))
  })
})
server.listen(0, '127.0.0.1', () => console.log(server.address().port))
`
const parseVerdict = new Function(JUDGE_RUNNER.slice(JUDGE_RUNNER.indexOf('function parseVerdict('), JUDGE_RUNNER.indexOf('function aggregateVerdicts(')) + '; return parseVerdict')()

async function fixture(t, name, verdicts, { http = false } = {}) {
  const root = join('/tmp/te-research-tests', 'judges-' + name + '-' + Date.now() + '-' + process.pid)
  mkdirSync(root, { recursive: true })
  t.diagnostic('retained scratch directory: ' + root)
  const fake = join(root, 'fake-claude.mjs'); writeFileSync(fake, FAKE)
  let url = null
  const callLog = join(root, 'http-judge-calls.jsonl')
  if (http) {
    const script = join(root, 'http-judge.mjs'); writeFileSync(script, HTTP_JUDGE)
    const endpoint = spawn(process.execPath, [script, callLog], { stdio: ['ignore', 'pipe', 'inherit'] })
    t.after(async () => { if (endpoint.exitCode === null && endpoint.signalCode === null) { const closed = new Promise(resolve => endpoint.once('close', resolve)); endpoint.kill(); await closed } })
    const port = await new Promise((resolve, reject) => { endpoint.stdout.once('data', data => resolve(String(data).trim())); endpoint.once('exit', code => reject(new Error('HTTP fixture exited ' + code))) })
    url = 'http://127.0.0.1:' + port + '/judge'
  }
  const draft = { ...emptyPipelineDraft(), root: join(root, 'room'),
    rows: [{ surface: 'claude-cli', model: 'contestant', executable: fake, efforts: ['low'] }],
    judges: ['yes', 'no', 'maybe'].map(id => ({ surface: http ? 'http' : 'claude-cli', model: 'judge-' + id, effort: 'low', executable: http ? '' : fake, prompt: 'Judge ' + id + ': inspect the answer.' })),
    models: http ? ['yes', 'no', 'maybe'].map(id => ({ id: 'judge-' + id, name: 'Judge ' + id, kind: 'http-json', url, model: 'judge-' + id, credential: 'JUDGE_HTTP_KEY' })) : [],
    verdicts, record: { keepDraws: true } }
  const settings = pipelineSettings(emptyProtocolDecisions(), { timeoutMs: 5000 })
  settings.shapeTest = false
  settings.envAllowlist = ['PATH', 'SystemRoot', 'windir', 'JUDGE_STYLE']
  const generated = generatePipeline(draft, settings)
  const spec = developmentStarter()
  spec.inputs = await Promise.all(Object.entries(generated.files).map(async ([path, bytes]) => ({ path, sha256: await sha256(bytes) })))
  const project = await freezeStudy(await bindRuntimeSources(spec, sources))
  for (const [path, bytes] of Object.entries(await projectFiles(project, sources, generated.files))) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes) }
  // Collection through the runner itself, writing the journal and retained responses exactly as the exported CLI
  // does, without the CLI's run lock: releasing that lock is a deletion, which this fixture never performs.
  const { project: opened } = await openProject(root)
  mkdirSync(join(root, 'results', 'responses'), { recursive: true })
  const journal = await open(join(root, 'results', 'attempts.jsonl'), 'a')
  await runStudy(opened, { events: [], runtime: { node: process.version, platform: process.platform, architecture: process.arch, versions: process.versions },
    recordResponse: async response => { const file = await open(join(root, 'results', 'responses', response.trialId + '-' + response.attempt + '.json'), 'wx'); try { await file.write(canonical(response) + '\n'); await file.sync() } finally { await file.close() } },
    append: async event => { await journal.write(canonical(event) + '\n'); await journal.sync() } })
  await journal.close()
  assert.ok(readFileSync(join(root, 'results', 'attempts.jsonl'), 'utf8').includes('"finished"'), 'collection wrote its journal')
  const run = script => spawnSync(process.execPath, [join(root, 'harness', script)], { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: join(root, 'unused-profile'), USERPROFILE: join(root, 'unused-profile'), JUDGE_STYLE: verdicts.format, ...(http ? { JUDGE_HTTP_KEY: 'fixture-key' } : {}) } })
  const records = () => readdirSync(join(root, 'results/judges')).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).map(file => JSON.parse(readFileSync(join(root, 'results/judges', file), 'utf8')))
  const summary = () => JSON.parse(readFileSync(join(root, 'results/judges/summary.json'), 'utf8'))
  return { root, run, records, summary, calls: () => http ? readFileSync(callLog, 'utf8').trim().split('\n').map(JSON.parse) : [] }
}

test('PASS/FAIL verdicts are read per judge and combined by the majority rule into a summary beside the records', async t => {
  const f = await fixture(t, 'pass-fail', { format: 'pass-fail', rule: 'majority', threshold: 0.7 })
  const canary = f.run('canary.mjs'); assert.equal(canary.status, 0, canary.stderr + canary.stdout)
  const judged = f.run('judge.mjs'); assert.equal(judged.status, 0, judged.stderr)
  const out = JSON.parse(judged.stdout)
  assert.equal(out.aggregation, 'majority'); assert.equal(out.format, 'pass-fail'); assert.equal(out.completed, out.responses * 3)
  const records = f.records()
  assert.deepEqual(new Set(records.map(record => canonical(record.parsed))), new Set([
    canonical({ format: 'pass-fail', score: 1, pass: true, malformed: false }), canonical({ format: 'pass-fail', score: 0, pass: false, malformed: false }), canonical({ format: 'pass-fail', score: null, pass: null, malformed: true })]))
  assert.ok(records.every(record => record.verdict.length > 0 && record.completion.status === 'complete'), 'the text verdict is still kept whole')
  const summary = f.summary()
  assert.equal(summary.rule, 'majority'); assert.equal(summary.responses.length, out.responses)
  assert.ok(summary.responses.every(response => response.judges === 3 && response.usable === 2 && response.pass === null), 'a malformed verdict leaves the response undecided rather than counting it either way')
  assert.equal(out.undecided, out.responses); assert.match(summary.note, /do not replace it/)
  assert.ok(readdirSync(join(f.root, 'room', 'runs')).length > 0, 'working directories are kept')
  const h = await fixture(t, 'http-pass-fail', { format: 'pass-fail', rule: 'majority', threshold: 0.7 }, { http: true })
  const httpCanary = h.run('canary.mjs'); assert.equal(httpCanary.status, 0, httpCanary.stderr + httpCanary.stdout)
  const httpJudged = h.run('judge.mjs'), httpOut = JSON.parse(httpJudged.stdout)
  assert.equal(httpOut.completed, httpOut.responses * 2, 'HTTP 200 final answers are completed judge results')
  assert.equal(httpJudged.status, 2, 'provider-truncated HTTP answers remain incomplete')
  assert.equal(httpOut.incomplete, httpOut.responses)
  assert.ok(h.records().filter(record => record.judge.requestedModel === 'judge-maybe').every(record => record.completion.reason === 'judge-truncation' && record.parsed === null))
  assert.ok(h.summary().responses.every(response => response.usable === 2 && response.pass === null))
  const callsBeforeReuse = h.calls().length, reused = h.run('judge.mjs')
  assert.equal(reused.status, 2); assert.equal(JSON.parse(reused.stdout).reused, httpOut.responses * 3)
  assert.equal(h.calls().length, callsBeforeReuse, 'reusing completed and incomplete HTTP verdicts makes no additional requests')
  for (const [pattern, answer] of [['^Verdict: (PASS|FAIL)$', 'The quoted example says PASS'], ['[', 'PASS'], ['^Verdict: (.*)$', 'Verdict: bypass']]) {
    assert.deepEqual(parseVerdict({ format: 'pass-fail', pattern }, answer), { format: 'pass-fail', score: null, pass: null, malformed: true }, 'only an actual PASS or FAIL captured by the registered pattern can be counted')
  }
  assert.equal(parseVerdict({ format: 'pass-fail', pattern: '^Verdict: (PASS|FAIL)$' }, 'Verdict: PASS').pass, true)
})

test('scores through the scale and threshold combine by the mean, and the text format scores nothing', async t => {
  const f = await fixture(t, 'score', { format: 'score', scale: 10, threshold: 0.6, rule: 'mean' })
  assert.equal(f.run('canary.mjs').status, 0)
  const judged = f.run('judge.mjs'); assert.equal(judged.status, 0, judged.stderr)
  const summary = f.summary()
  assert.equal(summary.rule, 'mean'); assert.equal(summary.threshold, 0.6)
  for (const response of summary.responses) {
    assert.equal(response.usable, 3); assert.equal(response.score, Math.round((0.9 + 0.3 + 0.7) / 3 * 10000) / 10000); assert.equal(response.pass, true, 'mean 0.6333 reaches 0.6')
    assert.deepEqual(response.verdicts.map(item => item.parsed.pass).sort(), [false, true, true])
  }
  assert.equal(JSON.parse(judged.stdout).passed, summary.responses.length)
  const g = await fixture(t, 'text', { format: 'text' })
  assert.equal(g.run('canary.mjs').status, 0)
  const plain = g.run('judge.mjs'); assert.equal(plain.status, 0, plain.stderr)
  assert.equal(JSON.parse(plain.stdout).aggregation, 'separate')
  assert.ok(g.records().every(record => record.parsed.format === 'text' && record.parsed.pass === null))
  assert.equal(g.summary().threshold, null)
  for (const pattern of ['^Score: ([0-9.]+)$', '[']) assert.deepEqual(parseVerdict({ format: 'score', pattern, scale: 1, threshold: 0.7 }, 'A quoted 0.9 is not the registered verdict.'), { format: 'score', score: null, pass: null, malformed: true }, 'a registered score pattern cannot fall back to an unrelated number')
  assert.equal(parseVerdict({ format: 'score', pattern: '^Score: ([0-9.]+)$', scale: 1, threshold: 0.7 }, 'Score: 0.9').pass, true)
})
