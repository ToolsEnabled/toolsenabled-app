// The generated harness against custom endpoints and fake vendor CLIs: how a
// draw reaches an endpoint, what a provider refusal becomes, what a key echoed
// back by an endpoint becomes, and how Gemini receives an effort. A loopback
// server stands in for every endpoint; nothing here leaves the machine.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { emptyPipelineDraft, generatePipeline, pipelineSettings } from '../../src/research-pipeline.mjs'
import { emptyProtocolDecisions } from '../../src/research-protocol.mjs'

// One loopback endpoint for every case, told apart by path. It logs the path
// and body of each request (never a header) and answers per path.
const ENDPOINT = `
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
const log = process.argv[2]
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
const server = createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
    appendFileSync(log, JSON.stringify({ url: req.url, body }) + '\\n')
    if (req.url.startsWith('/anthropic/refusal')) return json(res, 200, { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'I can start on th' }], stop_reason: 'refusal', usage: { input_tokens: 5, output_tokens: 4 } })
    if (req.url.startsWith('/anthropic/ok')) return json(res, 200, { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'A complete answer with a program.' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 7 } })
    if (req.url.startsWith('/anthropic/wording')) return json(res, 200, { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Set max_tokens to the limit you need; the quota resets hourly, so a 429 means wait.' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 20 } })
    if (req.url.startsWith('/echo')) return json(res, 401, { error: { message: 'invalid key ' + (req.headers['x-api-key'] || req.headers.authorization || '') } })
    if (req.url.startsWith('/slow')) { setTimeout(() => json(res, 200, { model: 'm', content: [{ type: 'text', text: 'late' }], stop_reason: 'end_turn' }), 10000); return }
    if (req.url.includes(':generateContent')) return json(res, 200, { candidates: [{ content: { parts: [{ text: 'A complete Gemini answer.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6, thoughtsTokenCount: 2 }, modelVersion: 'gemini-3.6-flash-001' })
    json(res, 404, { error: 'no such path' })
  })
})
server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\\n'))
`

// A fake vendor CLI (claude or gemini, by its flags) that records its argv and,
// for gemini, the isolated settings.json the harness wrote for it.
const FAKE_CLI = `
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const args = process.argv.slice(2), get = name => args[args.indexOf(name) + 1]
if (args.includes('--version')) { console.log('fake-cli 1'); process.exit(0) }
const gemini = !args.includes('--setting-sources')
appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ args, settings: gemini ? JSON.parse(readFileSync(join(process.env.HOME, '.gemini/settings.json'), 'utf8')) : null }) + '\\n')
if (gemini) console.log(JSON.stringify({ response: 'A complete Gemini CLI answer.', stats: { models: { [get('-m')]: {} } } }))
else if (process.env.FAKE_CLI_MODE === 'refusal') console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, stop_reason: 'refusal', result: "API Error: Sonnet 5 can't help with this. Start a new session to continue.", usage: { input_tokens: 10, output_tokens: 3 }, modelUsage: { [get('--model')]: {} } }))
else console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'A complete Claude answer.', usage: { input_tokens: 10, output_tokens: 3 }, modelUsage: { [get('--model')]: {} } }))
`

const request = conditionId => JSON.stringify({ version: 1, projectSha256: 'a'.repeat(64), trial: { id: 't1', taskId: 'task-1', conditionId, replicate: 1 }, attempt: 1, prompt: 'Buy SPY when its close crosses above its 100-day SMA.', input: null })

async function endpoint(t, root) {
  const script = join(root, 'endpoint.mjs'), log = join(root, 'endpoint-calls.jsonl')
  writeFileSync(script, ENDPOINT); writeFileSync(log, '')
  const child = spawn(process.execPath, [script, log], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => child.kill())
  const port = await new Promise((resolve, reject) => { child.stdout.once('data', data => resolve(String(data).trim())); child.once('exit', code => reject(new Error('endpoint exited ' + code))) })
  return { base: 'http://127.0.0.1:' + port, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}

function fixture(t, draftExtra, { timeoutMs } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'research-http-transport-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'harness'), { recursive: true })
  const fake = join(root, 'fake-cli.mjs'), cliLog = join(root, 'cli-calls.jsonl')
  writeFileSync(fake, FAKE_CLI)
  const draft = { ...emptyPipelineDraft(), root: join(root, 'room'), ...draftExtra(fake) }
  const settings = { ...pipelineSettings(emptyProtocolDecisions(), timeoutMs ? { timeoutMs } : {}), shapeTest: false, envAllowlist: ['PATH', 'SystemRoot', 'windir', 'FAKE_CLI_LOG', 'FAKE_CLI_MODE'] }
  settings.canary = { ...settings.canary, required: false }
  const generated = generatePipeline(draft, settings)
  for (const [path, contents] of Object.entries(generated.files)) writeFileSync(join(root, path), contents)
  const run = (args, conditionId, extraEnv = {}) => spawnSync(process.execPath, [join(root, 'harness/draw.mjs'), ...args], { cwd: root, input: request(conditionId), encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: 'test-only-anthropic-key', OPENAI_API_KEY: 'test-only-openai-key', GEMINI_API_KEY: 'test-only-gemini-key', FAKE_CLI_LOG: cliLog, ...extraEnv }, timeout: 60000, windowsHide: true })
  const cli = () => { try { return readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] } }
  return { root, generated, run, cli }
}

const httpDraw = (model, effort) => ['--surface', 'http', '--model', model, '--effort', effort]

// Node's global fetch ends any request whose response headers take longer than
// 300 s (undici's headersTimeout), and a non-streaming model reply sends its
// headers only once the whole answer is written. Measured on Node 22.19 against
// a loopback server that answered after 305 s: "fetch failed", cause
// UND_ERR_HEADERS_TIMEOUT, at 300.7 s, although the caller's AbortSignal allowed
// 425 s. So every custom-endpoint draw longer than five minutes was a harness
// error whatever its per-draw timeout said (40 minutes by default). The draw
// must not depend on the global fetch; its own deadline is the only limit.
test('a custom-endpoint draw does not ride the global fetch, whose 300-second header limit cut long draws', async t => {
  const f0 = mkdtempSync(join(tmpdir(), 'research-http-endpoint-')); t.after(() => rmSync(f0, { recursive: true, force: true }))
  const server = await endpoint(t, f0)
  const f = fixture(t, () => ({ rows: [{ surface: 'http', model: 'lab', efforts: ['high'] }],
    models: [{ name: 'Lab', kind: 'anthropic-messages', url: server.base + '/anthropic/ok', model: 'claude-sonnet-5', credential: 'LAB_KEY' }] }))
  const preload = join(f.root, 'no-global-fetch.mjs')
  writeFileSync(preload, "globalThis.fetch = () => { throw new Error('the global fetch is not the research transport') }\n")
  const drawn = f.run(httpDraw('lab', 'high'), 'http-lab-high', { LAB_KEY: 'lab-key-value-0001', NODE_OPTIONS: '--import=' + preload })
  assert.equal(drawn.status, 0, drawn.stderr)
  const envelope = JSON.parse(drawn.stdout)
  assert.equal(envelope.completion.status, 'complete'); assert.equal(envelope.output, 'A complete answer with a program.')
  // The request itself reached the endpoint over the draw's own transport.
  assert.equal(server.calls().at(-1).body.model, 'claude-sonnet-5')
})

test('the draw deadline still ends a custom-endpoint draw that never answers', async t => {
  const f0 = mkdtempSync(join(tmpdir(), 'research-http-endpoint-')); t.after(() => rmSync(f0, { recursive: true, force: true }))
  const server = await endpoint(t, f0)
  const f = fixture(t, () => ({ rows: [{ surface: 'http', model: 'slow', efforts: ['low'] }],
    models: [{ name: 'Slow', kind: 'anthropic-messages', url: server.base + '/slow', model: 'm', credential: 'LAB_KEY' }] }), { timeoutMs: 1500 })
  const started = Date.now()
  const drawn = f.run(httpDraw('slow', 'low'), 'http-slow-low', { LAB_KEY: 'lab-key-value-0001' })
  const elapsed = Date.now() - started
  assert.equal(drawn.status, 4, drawn.stderr)
  const envelope = JSON.parse(drawn.stdout)
  assert.deepEqual(envelope.completion, { status: 'incomplete', reason: 'harness-error' })
  assert.ok(envelope.harness.wallMs >= 1400 && elapsed < 9000, 'ended by the 1.5 s draw deadline, not by the 10 s reply: ' + envelope.harness.wallMs + ' ms')
})

// Before, an Anthropic stop_reason "refusal" with partial text was recorded as a
// complete observation (exit 0), the partial text standing as the answer.
test('a provider refusal through a custom endpoint is a failed attempt with its stop reason, never an observation', async t => {
  const f0 = mkdtempSync(join(tmpdir(), 'research-http-endpoint-')); t.after(() => rmSync(f0, { recursive: true, force: true }))
  const server = await endpoint(t, f0)
  const f = fixture(t, () => ({ rows: [{ surface: 'http', model: 'lab', efforts: ['high'] }],
    models: [{ name: 'Lab', kind: 'anthropic-messages', url: server.base + '/anthropic/refusal', model: 'claude-sonnet-5', credential: 'LAB_KEY' }] }))
  const drawn = f.run(httpDraw('lab', 'high'), 'http-lab-high', { LAB_KEY: 'lab-key-value-0001' })
  assert.equal(drawn.status, 3, drawn.stderr)
  assert.match(drawn.stderr, /provider-refusal: refusal/)
  const envelope = JSON.parse(drawn.stdout)
  assert.deepEqual(envelope.completion, { status: 'incomplete', reason: 'provider-refusal' })
  assert.equal(envelope.harness.evidence.providerRefusal, 'refusal')
  assert.match(envelope.harness.evidence.stdoutTail, /"stop_reason":"refusal"/, 'the provider reply is kept as evidence')
})

// The known key shapes (sk-, JWT, Bearer) were masked in evidence tails, but a
// key of any other shape that an endpoint or proxy echoed back was kept verbatim
// in the envelope and printed on stderr.
test('a key an endpoint echoes back never reaches the envelope or stderr, whatever its shape', async t => {
  const f0 = mkdtempSync(join(tmpdir(), 'research-http-endpoint-')); t.after(() => rmSync(f0, { recursive: true, force: true }))
  const server = await endpoint(t, f0)
  const key = 'lab-Q7x9ZtK2mVw4-secret'
  const f = fixture(t, () => ({ rows: [{ surface: 'http', model: 'lab', efforts: ['low'] }],
    models: [{ name: 'Lab', kind: 'anthropic-messages', url: server.base + '/echo', model: 'm', credential: 'LAB_KEY' }] }))
  const drawn = f.run(httpDraw('lab', 'low'), 'http-lab-low', { LAB_KEY: key })
  assert.equal(drawn.status, 4, drawn.stderr)
  const envelope = JSON.parse(drawn.stdout)
  assert.equal(envelope.harness.evidence.exit, 401)
  assert.match(envelope.harness.evidence.stderrTail, /invalid key <KEY>/, 'the echo is kept, the key is masked')
  for (const text of [drawn.stdout, drawn.stderr]) assert.ok(!text.includes(key), 'the key value appears nowhere')
})

// The Claude CLI reports a refusal as an error result with stop_reason
// "refusal" (measured on 2.1.281 against a loopback API that refused). It was a
// harness error; it is a provider refusal, the same as on an endpoint.
test('a Claude CLI refusal is recorded as a provider refusal', t => {
  const f = fixture(t, fake => ({ rows: [{ surface: 'claude-cli', model: 'claude-sonnet-5', executable: fake, efforts: ['low'] }] }))
  const drawn = f.run(['--surface', 'claude-cli', '--model', 'claude-sonnet-5', '--effort', 'low'], 'claude-claude-sonnet-5-low', { FAKE_CLI_MODE: 'refusal' })
  assert.equal(drawn.status, 3, drawn.stderr)
  const envelope = JSON.parse(drawn.stdout)
  assert.deepEqual(envelope.completion, { status: 'incomplete', reason: 'provider-refusal' })
  assert.equal(envelope.harness.evidence.providerRefusal, 'refusal')
  const plain = f.run(['--surface', 'claude-cli', '--model', 'claude-sonnet-5', '--effort', 'low'], 'claude-claude-sonnet-5-low')
  assert.equal(plain.status, 0, plain.stderr); assert.equal(JSON.parse(plain.stdout).completion.status, 'complete')
})

// A custom endpoint reports a quota, a rate limit or a sign-in failure as an HTTP
// status and a cut-off as a stop reason, both of which the draw reads
// structurally. The wording and truncation heuristics exist for vendor CLIs,
// which print such notices as their answer text; applied to a 200 answer they
// turned any short answer that mentions a limit, a quota or max_tokens into a
// provider notice or a truncation, a failed attempt redrawn until the budget ran
// out, for exactly the tasks whose subject is those words.
test('a complete endpoint answer that mentions limits, quotas or max_tokens is an answer, not a notice or a cut-off', async t => {
  const f0 = mkdtempSync(join(tmpdir(), 'research-http-endpoint-')); t.after(() => rmSync(f0, { recursive: true, force: true }))
  const server = await endpoint(t, f0)
  const f = fixture(t, () => ({ rows: [{ surface: 'http', model: 'lab', efforts: ['low'] }],
    models: [{ name: 'Lab', kind: 'anthropic-messages', url: server.base + '/anthropic/wording', model: 'claude-sonnet-5', credential: 'LAB_KEY' }] }))
  const drawn = f.run(httpDraw('lab', 'low'), 'http-lab-low', { LAB_KEY: 'lab-key-value-0001' })
  assert.equal(drawn.status, 0, drawn.stderr)
  const envelope = JSON.parse(drawn.stdout)
  assert.equal(envelope.completion.status, 'complete'); assert.match(envelope.output, /max_tokens to the limit/)
  // The judge runner classifies with the same exported helpers.
  const room = await import(pathToFileURL(join(f.root, 'harness/clean-room.mjs')).href)
  const config = JSON.parse(f.generated.files['harness/surfaces.json'])
  const verdict = 'Verdict: PASS. The answer stays within the rate limit and sets max_tokens.'
  assert.equal(room.providerBlocked(config, 'http', verdict, 5), false); assert.equal(room.truncated(config, verdict, 'http'), false)
  assert.equal(room.providerBlocked(config, 'claude-cli', "You've hit your session limit", 5), true, 'a vendor CLI notice printed as its answer is still a notice')
  assert.equal(room.truncated(config, "API Error: Claude's response exceeded the 64000 output token maximum.", 'claude-cli'), true, 'and a CLI cut-off notice is still a cut-off')
})
