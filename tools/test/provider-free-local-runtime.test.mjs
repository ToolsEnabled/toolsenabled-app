import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  PROVIDER_FREE_MODEL,
  redirectLocalRuntimePorts,
  startProviderFreeLocalRuntime,
  waitForProviderFreeCompletion,
} from '../lib/provider-free-local-runtime.mjs'

const ORIGINAL_PORTS = [11434, 1234, 8080, 8000]

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'provider-free-local-runtime-'))
  const directory = path.join(root, 'src', 'lib', 'providers')
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'local-node-runtime.js'), [
    'const RUNTIMES = {',
    ...ORIGINAL_PORTS.map((port, index) => `  runtime${index}: { port: ${port}, marker: ${index} },`),
    '}',
    '',
  ].join('\n'))
  return root
}

test('the provider-free rig redirects every local runtime away from ambient services', () => {
  const root = fixture()
  try {
    const result = redirectLocalRuntimePorts(root, 45678)
    assert.equal(result.replaced, 4)
    const source = readFileSync(result.file, 'utf8')
    for (const port of ORIGINAL_PORTS) assert.doesNotMatch(source, new RegExp(`\\bport: ${port},`))
    assert.equal((source.match(/\bport: 45678,/g) || []).length, 4)
    assert.match(source, /marker: 3/, 'the rewrite must leave non-port payload code intact')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the deterministic local runtime serves discovery and a zero-cost completion', async () => {
  const root = fixture()
  let runtime = null
  try {
    runtime = await startProviderFreeLocalRuntime(root)
    const models = await (await fetch(`http://127.0.0.1:${runtime.port}/v1/models`)).json()
    assert.deepEqual(models.data.map(entry => entry.id), [PROVIDER_FREE_MODEL])
    const completion = await (await fetch(`http://127.0.0.1:${runtime.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: PROVIDER_FREE_MODEL, messages: [{ role: 'user', content: 'ready' }] }),
    })).json()
    assert.match(completion.choices[0].message.content, /VERDICT: PASSED/)
    assert.equal(runtime.requests.some(request => request.url === '/v1/models'), true)
    assert.equal(runtime.requests.some(request => request.url === '/v1/chat/completions'), true)
    assert.equal(await waitForProviderFreeCompletion(runtime, { timeoutMs: 50 }), true)
  } finally {
    if (runtime) await runtime.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('completion proof is bounded and requires a finished chat-completions POST', async () => {
  const runtime = { requests: [] }
  runtime.requests.push({ method: 'POST', url: '/v1/chat/completions', completed: false })
  assert.equal(await waitForProviderFreeCompletion(runtime, { timeoutMs: 5, pollMs: 1 }), false)

  setTimeout(() => runtime.requests.push({
    method: 'POST', url: '/v1/chat/completions', completed: true,
  }), 5)
  assert.equal(await waitForProviderFreeCompletion(runtime, { timeoutMs: 100, pollMs: 1 }), true)
})

test('an unfamiliar payload shape is refused instead of partially redirected', () => {
  const root = fixture()
  try {
    const file = path.join(root, 'src', 'lib', 'providers', 'local-node-runtime.js')
    writeFileSync(file, readFileSync(file, 'utf8').replace('port: 8000,', 'port: 8001,'))
    assert.throws(() => redirectLocalRuntimePorts(root, 45678), /0 declarations for port 8000/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
