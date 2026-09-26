// The generated harness under a tool profile, a custom HTTP model and a
// recording policy. A fake claude CLI records the argv it was started with; a
// local HTTP server stands in for a custom-named model. Every fixture lives in
// a retained scratch directory (printed as a diagnostic) and the recording
// policy keeps each draw's working directory, so nothing here is removed.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { emptyPipelineDraft, generatePipeline, pipelineSettings, rowProblems } from '../../src/research-pipeline.mjs'
import { emptyProtocolDecisions } from '../../src/research-protocol.mjs'
import { commandAdapter } from '../../src/benchmark/cli.mjs'

const FAKE_CLAUDE = `
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write('fake-claude 1.0\\n'); process.exit(0) }
const prompt = readFileSync(0, 'utf8')
if (process.env.FAKE_ARGV_LOG) appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify({ args, env: Object.keys(process.env).filter(name => /^(RAG_|CLAUDE_)/.test(name)) }) + '\\n')
let result = 'Here is the program.\\n\`\`\`python\\nclass Algo(QCAlgorithm):\\n    pass\\n\`\`\`\\nDone.'
const plant = join(process.cwd(), 'CLAUDE.md')
if (existsSync(plant)) { const marker = (readFileSync(plant, 'utf8').match(/LB-CANARY-[A-Z0-9]+/) || [])[0]; if (marker) result = marker + '\\n' + result }
const model = args[args.indexOf('--model') + 1]
process.stdout.write(JSON.stringify({ result, is_error: false, num_turns: 2, duration_api_ms: 9, usage: { input_tokens: 21, output_tokens: 34, cache_read_input_tokens: 0 }, modelUsage: { [model]: {} } }) + '\\n')
`
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex')
const request = conditionId => JSON.stringify({ version: 1, projectSha256: 'a'.repeat(64), trial: { id: 't1', taskId: 'task-1', conditionId, replicate: 1 }, attempt: 1, prompt: 'Buy SPY when its close crosses above its 100-day SMA.', input: null })

function fixture(t, name, draftExtra, settingsExtra = {}) {
  const root = join('/tmp/te-research-tests', 'pipeline-' + name + '-' + Date.now() + '-' + process.pid)
  mkdirSync(join(root, 'harness'), { recursive: true })
  t.diagnostic('retained scratch directory: ' + root)
  const fake = join(root, 'fake-claude.mjs'), argvLog = join(root, 'argv.jsonl')
  writeFileSync(fake, FAKE_CLAUDE)
  const draft = { ...emptyPipelineDraft(), root: join(root, 'room'), ...draftExtra(fake) }
  const settings = { ...pipelineSettings(emptyProtocolDecisions()), shapeTest: false, envAllowlist: ['PATH', 'SystemRoot', 'windir', 'FAKE_ARGV_LOG'], ...settingsExtra }
  const generated = generatePipeline(draft, settings)
  for (const [path, contents] of Object.entries(generated.files)) writeFileSync(join(root, path), contents)
  const run = (script, args, input, extraEnv = {}) => spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, input, encoding: 'utf8', env: { ...process.env, FAKE_ARGV_LOG: argvLog, ...extraEnv }, timeout: 120000, windowsHide: true })
  const argv = () => { try { return readFileSync(argvLog, 'utf8').trim().split('\n').map(line => JSON.parse(line)) } catch { return [] } }
  return { root, draft, generated, run, argv }
}

test('a row under a tool profile becomes its own condition and the draw starts the CLI with the translated tool flags', t => {
  const f = fixture(t, 'tools', fake => ({
    rows: [{ surface: 'claude-cli', model: 'claude-sonnet-5', executable: fake, efforts: ['low'], tools: 'rag' }, { surface: 'claude-cli', model: 'claude-sonnet-5', executable: fake, efforts: ['low'] }],
    tools: { servers: [{ id: 'lean-rag', name: 'LEAN docs retrieval', kind: 'stdio', command: 'python', args: ['/lb/rag/server.py'], tools: ['search_docs'], env: ['RAG_INDEX_DIR'] }], profiles: [{ id: 'rag', label: 'Retrieval', enabled: ['claude-cli/Read', 'server/lean-rag/search_docs'] }] },
    record: { keepDraws: true },
  }))
  assert.deepEqual(f.generated.conditions.map(item => [item.id, item.settings]), [['claude-claude-sonnet-5-low-rag', { effort: 'low', tools: 'rag' }], ['claude-claude-sonnet-5-low', { effort: 'low' }]], 'the same surface, model and effort with and without tools are two cells')
  assert.deepEqual(f.generated.conditions[0].adapter.args.slice(-2), ['--tools', 'rag'])
  assert.deepEqual(f.generated.conditions[0].adapter.env.slice(-1), ['RAG_INDEX_DIR'], 'the server\'s environment names are allowlisted on the condition'); assert.ok(!f.generated.conditions[1].adapter.env.includes('RAG_INDEX_DIR'))
  assert.deepEqual(rowProblems(f.draft), [])
  const config = JSON.parse(f.generated.files['harness/surfaces.json'])
  assert.deepEqual(config.toolServers[0].env, ['RAG_INDEX_DIR']); assert.ok(!JSON.stringify(config).includes('note'))
  assert.equal(f.run('harness/canary.mjs', [], '').status, 0)
  const unknown = f.run('harness/draw.mjs', ['--surface', 'claude-cli', '--model', 'claude-sonnet-5', '--effort', 'low', '--tools', 'ghost'], request('x'))
  assert.equal(unknown.status, 2); assert.match(unknown.stderr, /unknown tool profile ghost/)
  const drawn = f.run('harness/draw.mjs', ['--surface', 'claude-cli', '--model', 'claude-sonnet-5', '--effort', 'low', '--tools', 'rag'], request('claude-claude-sonnet-5-low-rag'), { RAG_INDEX_DIR: '/lb/rag/index' })
  assert.equal(drawn.status, 0, drawn.stderr)
  const envelope = JSON.parse(drawn.stdout)
  assert.equal(envelope.harness.tools, 'rag'); assert.equal(envelope.completion.status, 'complete')
  const started = f.argv().at(-1)
  const at = flag => started.args[started.args.indexOf(flag) + 1]
  assert.equal(at('--tools'), 'Read'); assert.equal(at('--allowedTools'), 'Read,mcp__lean-rag__search_docs')
  assert.deepEqual(JSON.parse(at('--mcp-config')), { mcpServers: { 'lean-rag': { command: 'python', args: ['/lb/rag/server.py'], env: {} } } })
  assert.ok(started.args.includes('--strict-mcp-config')); assert.ok(started.args.includes('--no-session-persistence'))
  assert.ok(started.env.includes('RAG_INDEX_DIR'), 'the environment names a server needs reach the CLI when set')
  const plain = f.run('harness/draw.mjs', ['--surface', 'claude-cli', '--model', 'claude-sonnet-5', '--effort', 'low'], request('claude-claude-sonnet-5-low'))
  assert.equal(plain.status, 0, plain.stderr)
  const off = f.argv().at(-1)
  assert.deepEqual(off.args.slice(off.args.indexOf('--strict-mcp-config'), off.args.indexOf('--strict-mcp-config') + 3), ['--strict-mcp-config', '--tools', ''], 'without a profile the draw is tools off, as before')
  assert.ok(!off.args.includes('--mcp-config'))
  assert.ok(readdirSync(join(f.root, 'room', 'runs')).some(name => name.startsWith('draw-')), 'draw directories are kept when the policy says so')
})

test('the recording policy reduces the envelope: extracted output with the full hash, no tokens, evidence always', t => {
  const f = fixture(t, 'record', fake => ({
    rows: [{ surface: 'claude-cli', model: 'claude-sonnet-5', executable: fake, efforts: ['low'] }],
    record: { output: 'extracted', pattern: '```python\\n([\\s\\S]*?)```', tokens: false, evidence: 'always', keepDraws: true },
  }))
  assert.equal(f.run('harness/canary.mjs', [], '').status, 0)
  const drawn = f.run('harness/draw.mjs', ['--surface', 'claude-cli', '--model', 'claude-sonnet-5', '--effort', 'low'], request('claude-claude-sonnet-5-low'))
  assert.equal(drawn.status, 0, drawn.stderr)
  const envelope = JSON.parse(drawn.stdout)
  assert.equal(envelope.output, 'class Algo(QCAlgorithm):\n    pass\n')
  assert.deepEqual(envelope.harness.extraction, { pattern: '```python\\n([\\s\\S]*?)```', flags: '', matched: true, fullChars: 'Here is the program.\n```python\nclass Algo(QCAlgorithm):\n    pass\n```\nDone.'.length })
  assert.equal(envelope.harness.outputSha256, sha256('Here is the program.\n```python\nclass Algo(QCAlgorithm):\n    pass\n```\nDone.'), 'the full text is hashed before extraction')
  assert.deepEqual(Object.keys(envelope.usage).sort(), ['generationMs', 'turns'], 'token counts are dropped, timing and turns kept; unknown tool counts are not invented')
  assert.equal(envelope.harness.evidence.exit, 0, 'evidence is recorded on success too')
  assert.equal(envelope.usage.turns, 2)
})

const FAKE_ENDPOINT = `
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
const log = process.argv[2]
const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    appendFileSync(log, JSON.stringify({ url: req.url, authorization: req.headers.authorization || null, body: JSON.parse(body) }) + '\\n')
    if (req.headers.authorization !== 'Bearer test-key-value') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"bad key"}'); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: 'lab-model-2026-01', choices: [{ message: { content: 'A substantive answer with a program.\\n\`\`\`python\\nprint(2)\\n\`\`\`' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }))
  })
})
server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\\n'))
`

test('a custom-named model draws over HTTP with the key from its named variable, which never reaches a file or the envelope', async t => {
  // The endpoint is its own process: the harness runs under spawnSync, which would block a server in this process.
  const script = join('/tmp/te-research-tests', 'fake-endpoint-' + Date.now() + '-' + process.pid + '.mjs'), callsLog = script.replace(/\.mjs$/, '.calls.jsonl')
  writeFileSync(script, FAKE_ENDPOINT)
  const endpoint = spawn(process.execPath, [script, callsLog], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => endpoint.kill())
  const port = await new Promise((resolve, reject) => { endpoint.stdout.once('data', data => resolve(String(data).trim())); endpoint.once('exit', code => reject(new Error('endpoint exited ' + code))) })
  const calls = () => readFileSync(callsLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const url = 'http://127.0.0.1:' + port + '/v1/chat/completions'
  const f = fixture(t, 'http', () => ({
    rows: [{ surface: 'http', model: 'lab', efforts: ['medium'] }, { surface: 'http', model: 'nobody', efforts: ['low'] }],
    models: [{ name: 'Lab', kind: 'openai-chat', url, model: 'lab-model', credential: 'LAB_KEY' }],
    record: { keepDraws: true },
  }))
  assert.deepEqual(f.generated.conditions.map(item => [item.id, item.identity]), [['http-lab-medium', { provider: 'openai', id: 'lab-model', surface: 'http' }]], 'a row naming an unregistered model generates nothing')
  assert.deepEqual(rowProblems(f.draft).map(problem => problem.kind), ['model'])
  assert.equal(f.generated.conditions[0].adapter.credentialEnv, 'LAB_KEY', 'the exported CLI admits only the named credential')
  const config = JSON.parse(f.generated.files['harness/surfaces.json'])
  assert.deepEqual(config.models, [{ id: 'lab', name: 'Lab', kind: 'openai-chat', url, model: 'lab-model', credential: 'LAB_KEY', provider: 'openai' }])
  const canary = f.run('harness/canary.mjs', [], '', { LAB_KEY: 'test-key-value' })
  assert.equal(canary.status, 0, canary.stderr + canary.stdout)
  const pass = JSON.parse(readFileSync(join(f.root, 'room', 'CANARY-PASS-' + new Date().toISOString().slice(0, 10) + '.json'), 'utf8'))
  assert.deepEqual(pass.certified, ['http']); assert.equal(pass.results[0].plantApplicable, false, 'an endpoint reads no working directory, so only transport and substance are certified')
  const missing = f.run('harness/draw.mjs', ['--surface', 'http', '--model', 'lab', '--effort', 'medium'], request('http-lab-medium'))
  assert.equal(missing.status, 4); assert.match(missing.stderr, /credential named LAB_KEY is not set/)
  const drawn = f.run('harness/draw.mjs', ['--surface', 'http', '--model', 'lab', '--effort', 'medium'], request('http-lab-medium'), { LAB_KEY: 'test-key-value' })
  assert.equal(drawn.status, 0, drawn.stderr)
  const envelope = JSON.parse(drawn.stdout)
  assert.match(envelope.output, /print\(2\)/)
  assert.deepEqual(envelope.identity, { provider: 'openai', id: 'lab-model-2026-01', surface: 'http', version: 'node ' + process.version })
  assert.equal(envelope.usage.inputTokens, 3); assert.equal(envelope.usage.outputTokens, 4); assert.ok(envelope.usage.generationMs >= 0)
  assert.deepEqual(envelope.harness.argv, ['fetch', url])
  // Exercise the actual exported CLI transport: it filters its child environment.
  const previousKey = process.env.LAB_KEY
  let transported
  try {
    process.env.LAB_KEY = 'test-key-value'
    transported = await commandAdapter(f.root, f.generated.conditions[0].adapter, JSON.parse(request('http-lab-medium')), AbortSignal.timeout(120000))
  } finally { if (previousKey === undefined) delete process.env.LAB_KEY; else process.env.LAB_KEY = previousKey }
  assert.match(transported.output, /print\(2\)/)
  assert.ok(!JSON.stringify(transported).includes('test-key-value'), 'the real CLI transport retains no credential value')
  const call = calls().at(-1)
  assert.equal(call.body.model, 'lab-model'); assert.equal(call.body.reasoning_effort, 'medium'); assert.match(call.body.messages[0].content, /Buy SPY/)
  for (const text of [drawn.stdout, drawn.stderr, canary.stdout, f.generated.files['harness/surfaces.json'], f.generated.files['harness/README.md']]) assert.ok(!text.includes('test-key-value'), 'the key value appears nowhere')
  const denied = f.run('harness/draw.mjs', ['--surface', 'http', '--model', 'lab', '--effort', 'medium'], request('http-lab-medium'), { LAB_KEY: 'wrong' })
  assert.equal(denied.status, 4); assert.equal(JSON.parse(denied.stdout).completion.reason, 'harness-error'); assert.equal(JSON.parse(denied.stdout).harness.evidence.exit, 401)
})
