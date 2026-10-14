// Custom-named models: an endpoint, a model id and the NAME of the credential
// that holds its key. The value never enters the draft, the export or a
// request record; the harness reads it from its own environment at run time.
import assert from 'node:assert/strict'
import test from 'node:test'
import { MODEL_KINDS, modelEndpoint, modelProblems, modelRequest, modelResult, modelsForHarness, normalizeCustomModels } from '../../src/research-models.mjs'

const models = () => normalizeCustomModels([
  { name: 'Lab Llama', kind: 'openai-chat', url: 'http://10.0.0.5:8000/v1/chat/completions', model: 'llama-4-70b', credential: 'LAB_LLAMA_KEY' },
  { name: 'Gem', kind: 'google-generate', model: 'gemini-3.6-pro', credential: 'GEMINI_KEY' },
  { name: 'Claude direct', kind: 'anthropic-messages', model: 'claude-sonnet-5', credential: '\x73k-ant-thisisakeynotaname0123456789' },
])

test('models normalize to ids and default endpoints, and a pasted key is refused as a name', () => {
  const current = models()
  assert.deepEqual(current.map(model => model.id), ['lab-llama', 'gem', 'claude-direct'])
  assert.equal(modelEndpoint(current[1]), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-pro:generateContent', 'the model id is substituted into the vendor path')
  assert.equal(current[2].credential, '', 'a key-shaped value is not a credential name')
  for (const credential of ['lower_key', '_KEY', 'A'.repeat(101)]) assert.equal(normalizeCustomModels([{ name: 'Invalid', credential }])[0].credential, '', 'unsupported names are refused without renaming')
  assert.equal(normalizeCustomModels([{ name: 'Long', credential: 'A'.repeat(100) }])[0].credential, 'A'.repeat(100), 'the model and exported adapter use the same exact-name limit')
  const problems = modelProblems(current, ['LAB_LLAMA_KEY'])
  assert.deepEqual(problems.map(problem => [problem.kind, problem.index]), [['credential', 1], ['incomplete', 2]])
  assert.match(problems[0].text, /not in the vault: GEMINI_KEY/)
  assert.deepEqual(modelProblems(current.slice(0, 1), null), [], 'without a vault listing, a well-formed name is accepted')
})

test('the harness rows carry the credential name only and every kind builds a request without echoing the key', () => {
  const rows = modelsForHarness(models())
  assert.deepEqual(rows[0], { id: 'lab-llama', name: 'Lab Llama', kind: 'openai-chat', url: 'http://10.0.0.5:8000/v1/chat/completions', model: 'llama-4-70b', credential: 'LAB_LLAMA_KEY', provider: 'openai' })
  for (const kind of Object.keys(MODEL_KINDS)) {
    const spec = { kind, url: MODEL_KINDS[kind].url.replace('{model}', 'm') || 'http://x/', model: 'm' }
    const request = modelRequest(spec, 'Buy SPY.', 'high', 'SECRET-VALUE', 1234)
    assert.equal(request.url, spec.url)
    assert.ok(JSON.stringify(request.headers).includes('SECRET-VALUE'), kind + ': the key is a header')
    assert.ok(!JSON.stringify(request.body).includes('SECRET-VALUE'), kind + ': never in the body')
    assert.ok(JSON.stringify(request.body).includes('Buy SPY.'))
  }
  assert.equal(modelRequest({ kind: 'openai-chat', url: 'u', model: 'm' }, 'p', 'high', 'k', 10).body.reasoning_effort, 'high')
  assert.equal(modelRequest({ kind: 'anthropic-messages', url: 'u', model: 'm' }, 'p', 'high', 'k', 10).headers['x-api-key'], 'k')
})

test('each vendor response shape becomes text, the served model, usage and a truncation flag', () => {
  assert.deepEqual(modelResult({ kind: 'openai-chat' }, { model: 'llama-4-70b-2026', choices: [{ message: { content: 'yo' }, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    { rawText: 'yo', served: 'llama-4-70b-2026', usage: { inputTokens: 3, outputTokens: 1, cachedInputTokens: undefined, reasoningTokens: undefined, toolCalls: 0 }, truncated: true, refused: null })
  assert.equal(modelResult({ kind: 'openai-responses' }, { output: [{ content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] }] }).rawText, 'ab')
  assert.equal(modelResult({ kind: 'anthropic-messages' }, { content: [{ type: 'text', text: 'hi' }], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 2 } }).truncated, true)
  assert.equal(modelResult({ kind: 'google-generate' }, { candidates: [{ content: { parts: [{ text: 'g' }] }, finishReason: 'STOP' }], modelVersion: 'gemini-3.6-pro-001' }).served, 'gemini-3.6-pro-001')
  assert.equal(modelResult({ kind: 'http-json' }, { output: 'o', inputTokens: 5 }).usage.inputTokens, 5)
  assert.equal(modelResult({ kind: 'openai-chat' }, {}).rawText, null, 'no text is a harness error, not an empty answer')
})

// A reply the provider's safety system stopped or withheld is not an answer,
// even when it carries partial text: Anthropic stop_reason "refusal", OpenAI
// finish_reason "content_filter" (content omitted by the filter) or a refusal
// message, a Responses refusal part or incomplete_details.reason
// "content_filter", and a Gemini safety finish reason or prompt block. Before,
// each was recorded as a complete observation whenever any text came back.
test('a provider refusal or content filter is never a complete answer, even with partial text', () => {
  const refused = (kind, json) => modelResult({ kind }, json).refused
  assert.equal(refused('anthropic-messages', { content: [{ type: 'text', text: 'I can start on th' }], stop_reason: 'refusal' }), 'refusal')
  assert.equal(refused('anthropic-messages', { content: [], stop_reason: 'refusal' }), 'refusal')
  assert.equal(refused('anthropic-messages', { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }), null)
  assert.equal(refused('openai-chat', { choices: [{ message: { content: 'partial' }, finish_reason: 'content_filter' }] }), 'content_filter')
  assert.equal(refused('openai-chat', { choices: [{ message: { content: null, refusal: 'I cannot help with that.' }, finish_reason: 'stop' }] }), 'refusal')
  assert.equal(refused('openai-chat', { choices: [{ message: { content: 'ok', refusal: null }, finish_reason: 'stop' }] }), null)
  const filtered = modelResult({ kind: 'openai-responses' }, { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [{ content: [{ type: 'output_text', text: 'part' }] }] })
  assert.equal(filtered.refused, 'content_filter'); assert.equal(filtered.truncated, false, 'a filtered reply is not a length cut-off')
  const cut = modelResult({ kind: 'openai-responses' }, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ content: [{ type: 'output_text', text: 'part' }] }] })
  assert.equal(cut.truncated, true); assert.equal(cut.refused, null)
  assert.equal(refused('openai-responses', { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] }), 'refusal')
  assert.equal(refused('openai-responses', { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'fine' }] }] }), null)
  for (const reason of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']) assert.equal(refused('google-generate', { candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: reason }] }), reason)
  assert.equal(refused('google-generate', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }), 'PROHIBITED_CONTENT')
  assert.equal(refused('google-generate', { candidates: [{ content: { parts: [{ text: 'g' }] }, finishReason: 'STOP' }] }), null)
  assert.equal(refused('google-generate', { candidates: [{ content: { parts: [{ text: 'g' }] }, finishReason: 'MAX_TOKENS' }] }), null)
  assert.equal(refused('http-json', { output: 'o' }), null)
})
