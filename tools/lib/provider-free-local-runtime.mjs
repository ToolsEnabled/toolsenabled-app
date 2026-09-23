import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const PROVIDER_FREE_MODEL = 'toolsenabled-qa-local'
const DEFAULT_RUNTIME_PORTS = Object.freeze([11434, 1234, 8080, 8000])
const DEFAULT_COMPLETION_WAIT_MS = 15_000

export function redirectLocalRuntimePorts(payloadRoot, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('the provider-free runtime needs a TCP port')
  const file = path.join(payloadRoot, 'src', 'lib', 'providers', 'local-node-runtime.js')
  let source = readFileSync(file, 'utf8')
  for (const original of DEFAULT_RUNTIME_PORTS) {
    const needle = new RegExp(`\\bport: ${original},`, 'g')
    const matches = source.match(needle) || []
    if (matches.length !== 1) {
      throw new Error(`the staged local runtime has ${matches.length} declarations for port ${original}; refusing an ambiguous QA rewrite`)
    }
    source = source.replace(needle, `port: ${port},`)
  }
  writeFileSync(file, source, 'utf8')
  return Object.freeze({ file, port, replaced: DEFAULT_RUNTIME_PORTS.length })
}

/* Routes an OpenAI-shaped POST counts as a finished completion under. lm-studio,
   llama-cpp and vllm all speak this one. */
const OPENAI_CHAT_PATH = '/v1/chat/completions'
/* Ollama does not: RUNTIMES.ollama in the real local-node-runtime.js gives it
   `chatPath: '/api/chat'` and, by the module's own DEFAULTS (gpuPolicy:
   'Require GPU'), a residency preflight over `/api/ps` and `/api/generate`
   BEFORE that chat call -- see ollama-gpu.js#ensureGpu(). Ollama is also the
   first entry in RUNTIME_ORDER, so it is the runtime detect() selects whenever
   several runtimes answer /v1/models at once, which is exactly what happens
   here: redirectLocalRuntimePorts() points every runtime's default port at
   this one server. Measured 2026-09-07: a local dispatch against this rig with
   only the OpenAI routes below threw LOCAL_NODE_GPU_UNVERIFIED out of
   ensureGpu() and never reached /v1/chat/completions at all -- the free local
   lane's completion was never posted because the rig could not answer the
   preflight the product's default runtime choice actually makes. */
const OLLAMA_CHAT_PATH = '/api/chat'
const OLLAMA_RESIDENCY_PATH = '/api/ps'
const OLLAMA_PRELOAD_PATH = '/api/generate'
const COMPLETION_PATHS = Object.freeze([OPENAI_CHAT_PATH, OLLAMA_CHAT_PATH])

export async function startProviderFreeLocalRuntime(payloadRoot) {
  const requests = []
  // Ollama residency state, captured off a real request's own `num_ctx` rather
  // than assumed, so this rig verifies whatever context length the caller
  // actually asked for instead of a value pinned here.
  let residentContextTokens = null
  const server = createServer((request, response) => {
    /* A request arriving is not proof that the worker completed it. Record only
       after Node reports the response fully handed off; the release gates wait
       for this exact observation before they green or reap the worker. */
    response.once('finish', () => {
      requests.push(Object.freeze({ method: request.method, url: request.url, completed: true }))
    })
    response.setHeader('content-type', 'application/json')
    response.setHeader('connection', 'close')
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.end(JSON.stringify({ object: 'list', data: [{ id: PROVIDER_FREE_MODEL, object: 'model' }] }))
      return
    }
    if (request.method === 'GET' && request.url === OLLAMA_RESIDENCY_PATH) {
      response.end(JSON.stringify({
        models: residentContextTokens === null ? [] : [{
          name: PROVIDER_FREE_MODEL, model: PROVIDER_FREE_MODEL,
          size: 1, size_vram: 1, context_length: residentContextTokens,
        }],
      }))
      return
    }
    if (request.method === 'POST' && (request.url === OLLAMA_PRELOAD_PATH || request.url === OLLAMA_CHAT_PATH)) {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        let body = null
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* answered below regardless */ }
        const numCtx = body && body.options && Number.isInteger(body.options.num_ctx) ? body.options.num_ctx : null
        if (numCtx !== null) residentContextTokens = numCtx
        if (request.url === OLLAMA_PRELOAD_PATH) {
          response.end(JSON.stringify({ model: PROVIDER_FREE_MODEL, done: true, done_reason: 'load' }))
          return
        }
        response.end(JSON.stringify({
          model: PROVIDER_FREE_MODEL,
          message: { role: 'assistant', content: 'ready\nVERDICT: PASSED' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 1,
          eval_count: 3,
        }))
      })
      return
    }
    if (request.method === 'POST' && request.url === OPENAI_CHAT_PATH) {
      request.resume()
      request.on('end', () => response.end(JSON.stringify({
        id: 'toolsenabled-provider-free-qa',
        object: 'chat.completion',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ready\nVERDICT: PASSED' } }],
        usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
      })))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'provider-free QA runtime only serves model discovery and completion' }))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  try {
    const patched = redirectLocalRuntimePorts(payloadRoot, address.port)
    return Object.freeze({
      ...patched,
      model: PROVIDER_FREE_MODEL,
      requests,
      close: () => new Promise(resolve => server.close(resolve)),
    })
  } catch (error) {
    await new Promise(resolve => server.close(resolve))
    throw error
  }
}

export async function waitForProviderFreeCompletion(runtime, {
  timeoutMs = DEFAULT_COMPLETION_WAIT_MS,
  pollMs = 25,
  afterCount = 0,
} = {}) {
  if (!runtime || !Array.isArray(runtime.requests)) return false
  const completed = () => providerFreeCompletionCount(runtime) > afterCount
  if (completed()) return true
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.max(1, Number(pollMs) || 1)))
    if (completed()) return true
  }
  return completed()
}

export function providerFreeCompletionCount(runtime) {
  if (!runtime || !Array.isArray(runtime.requests)) return 0
  return runtime.requests.filter(request => request?.completed === true
    && request.method === 'POST' && COMPLETION_PATHS.includes(request.url)).length
}
