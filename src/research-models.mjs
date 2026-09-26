// Custom-named models: an HTTP endpoint the person names, with the API key
// held in the ToolsEnabled vault under a credential name. The study, the
// export and surfaces.json carry the name only; the run computer supplies the
// value as an environment variable of that name when the exported CLI runs.
// The harness's http surface reads it from its own environment and never
// passes it to a child process or a file.
const ID = /^[a-z][a-z0-9_-]{0,39}$/
const text = value => String(value ?? '').trim()
const slug = value => text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
export const CUSTOM_MODEL_LIMIT = 16
export const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]{0,99}$/
export const MODEL_KINDS = Object.freeze({
  'openai-chat': { label: 'OpenAI-compatible chat completions', url: 'https://api.openai.com/v1/chat/completions', auth: 'bearer', effort: 'reasoning_effort' },
  'openai-responses': { label: 'OpenAI responses API', url: 'https://api.openai.com/v1/responses', auth: 'bearer', effort: 'reasoning.effort' },
  'anthropic-messages': { label: 'Anthropic messages API', url: 'https://api.anthropic.com/v1/messages', auth: 'x-api-key', effort: 'none' },
  'google-generate': { label: 'Google Gemini generateContent', url: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent', auth: 'x-goog-api-key', effort: 'none' },
  'http-json': { label: 'Your own JSON endpoint (prompt in, output out)', url: '', auth: 'bearer', effort: 'field' },
})
export function emptyCustomModel() { return { id: '', name: '', kind: 'openai-chat', url: '', model: '', credential: '', provider: '' } }
export function normalizeCustomModel(raw) {
  if (!raw || typeof raw !== 'object') return null
  const model = emptyCustomModel()
  model.name = text(raw.name).slice(0, 80)
  model.id = ID.test(text(raw.id)) ? text(raw.id) : slug(raw.id || raw.name)
  model.kind = MODEL_KINDS[raw.kind] ? raw.kind : 'openai-chat'
  model.url = text(raw.url).slice(0, 400)
  model.model = text(raw.model).slice(0, 120)
  model.credential = CREDENTIAL_NAME.test(text(raw.credential)) ? text(raw.credential) : ''
  model.provider = text(raw.provider).slice(0, 40) || model.kind.split('-')[0]
  return model
}
export function normalizeCustomModels(raw) {
  const models = [], ids = new Set()
  for (const model of (Array.isArray(raw) ? raw : []).slice(0, CUSTOM_MODEL_LIMIT).map(normalizeCustomModel)) if (model && model.id && !ids.has(model.id)) { ids.add(model.id); models.push(model) }
  return models
}
// The endpoint a model calls: its own URL, else the kind's default, with the
// model id substituted where the vendor puts it in the path.
export function modelEndpoint(model) {
  const current = normalizeCustomModel(model)
  if (!current) return ''
  return (current.url || MODEL_KINDS[current.kind].url).replace('{model}', encodeURIComponent(current.model))
}
export function modelProblems(models, credentialNames = null) {
  const problems = []
  normalizeCustomModels(models).forEach((model, index) => {
    const missing = [!model.name && 'a name', !model.model && 'the model id the endpoint expects', !modelEndpoint(model) && 'an endpoint URL', !model.credential && 'a vault credential name'].filter(Boolean)
    if (missing.length) problems.push({ kind: 'incomplete', index, text: 'Model ' + (model.name || index + 1) + ' needs ' + missing.join(', ') + '.' })
    if (model.credential && Array.isArray(credentialNames) && !credentialNames.includes(model.credential)) problems.push({ kind: 'credential', index, text: 'Model ' + (model.name || index + 1) + ' names a credential that is not in the vault: ' + model.credential + '. Add it in Settings → Credentials, or on the run computer set the variable of that name.' })
    if (/^(?:sk-|AIza|xai-|Bearer )/i.test(model.credential) || model.credential.length > 40 && /[0-9]/.test(model.credential) && /[A-Z]/.test(model.credential) && /[a-z]/.test(model.credential)) problems.push({ kind: 'secret', index, text: 'Model ' + (model.name || index + 1) + ' has what looks like a key pasted where its name belongs. Put the key in the vault and name it here.' })
  })
  return problems
}
// The rows written to surfaces.json: never a value, only the credential name.
export function modelsForHarness(models) {
  return normalizeCustomModels(models).map(model => ({ id: model.id, name: model.name, kind: model.kind, url: modelEndpoint(model), model: model.model, credential: model.credential, provider: model.provider || model.kind.split('-')[0] }))
}
// Builds the HTTP request for one draw. Free of outside references so the
// harness embeds this very function; the key comes in as an argument and is
// used for the Authorization header only.
export function modelRequest(spec, prompt, effort, key, outputTokenCap) {
  const headers = { 'content-type': 'application/json' }
  const kind = spec.kind, cap = Number(outputTokenCap) || 64000
  if (kind === 'anthropic-messages') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01' }
  else if (kind === 'google-generate') headers['x-goog-api-key'] = key
  else headers.authorization = 'Bearer ' + key
  let body
  if (kind === 'openai-chat') { body = { model: spec.model, messages: [{ role: 'user', content: prompt }], max_completion_tokens: cap }; if (effort) body.reasoning_effort = effort }
  else if (kind === 'openai-responses') { body = { model: spec.model, input: prompt, max_output_tokens: cap }; if (effort) body.reasoning = { effort: effort } }
  else if (kind === 'anthropic-messages') body = { model: spec.model, max_tokens: cap, messages: [{ role: 'user', content: prompt }] }
  else if (kind === 'google-generate') body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: cap } }
  else body = { model: spec.model, prompt: prompt, effort: effort || null, maxOutputTokens: cap }
  return { url: spec.url, headers, body }
}
// Reads one response body into the harness's result shape: text, the served
// model, usage. Free of outside references for the same reason.
export function modelResult(spec, json) {
  const kind = spec.kind, j = json || {}
  const number = value => typeof value === 'number' ? value : undefined
  if (kind === 'openai-chat') { const choice = (j.choices || [])[0] || {}, usage = j.usage || {}; return { rawText: choice.message && typeof choice.message.content === 'string' ? choice.message.content : null, served: j.model || null, usage: { inputTokens: number(usage.prompt_tokens), outputTokens: number(usage.completion_tokens), cachedInputTokens: number(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens), reasoningTokens: number(usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens), toolCalls: 0 }, truncated: choice.finish_reason === 'length' } }
  if (kind === 'openai-responses') { let textOut = typeof j.output_text === 'string' ? j.output_text : null; if (textOut === null) { const parts = []; for (const item of j.output || []) for (const part of item.content || []) if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text); if (parts.length) textOut = parts.join('') } const usage = j.usage || {}; return { rawText: textOut, served: j.model || null, usage: { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), cachedInputTokens: number(usage.input_tokens_details && usage.input_tokens_details.cached_tokens), reasoningTokens: number(usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens), toolCalls: 0 }, truncated: j.status === 'incomplete' } }
  if (kind === 'anthropic-messages') { const parts = (j.content || []).filter(part => part.type === 'text').map(part => part.text), usage = j.usage || {}; return { rawText: parts.length ? parts.join('') : null, served: j.model || null, usage: { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), cachedInputTokens: number(usage.cache_read_input_tokens), toolCalls: 0 }, truncated: j.stop_reason === 'max_tokens' } }
  if (kind === 'google-generate') { const candidate = (j.candidates || [])[0] || {}, parts = ((candidate.content || {}).parts || []).map(part => part.text).filter(part => typeof part === 'string'), usage = j.usageMetadata || {}; return { rawText: parts.length ? parts.join('') : null, served: j.modelVersion || null, usage: { inputTokens: number(usage.promptTokenCount), outputTokens: number(usage.candidatesTokenCount), cachedInputTokens: number(usage.cachedContentTokenCount), reasoningTokens: number(usage.thoughtsTokenCount), toolCalls: 0 }, truncated: candidate.finishReason === 'MAX_TOKENS' } }
  return { rawText: typeof j.output === 'string' ? j.output : null, served: j.model || null, usage: { inputTokens: number(j.inputTokens), outputTokens: number(j.outputTokens), toolCalls: 0 }, truncated: j.truncated === true }
}
