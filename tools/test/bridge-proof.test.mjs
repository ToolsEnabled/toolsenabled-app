import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import bridgeProof from '../../shell/bridge-proof.cjs'
import { bridgeStatus, resetBridgeSession } from '../../src/mission-bridge.js'

const { readBridgeProof } = bridgeProof
const PROOF_FILE = 'X:\\runtime\\mission-bridge-bootstrap-proof.json'
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
const originalFetch = globalThis.fetch
const originalWindow = globalThis.window

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
  resetBridgeSession()
})

function validRecord(token = TOKEN) {
  return JSON.stringify({
    version: 1,
    bootId: 'test-boot',
    token,
    createdAt: '2026-08-08T00:00:00.000Z',
  })
}

test('reports how to configure an unset proof file variable', () => {
  const result = readBridgeProof({ env: {}, readFileSync: assert.fail })
  assert.equal(result.ok, false)
  assert.match(result.reason, /MC_BRIDGE_PROOF_FILE/)
})

test('reports a missing configured proof file', () => {
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
  const result = readBridgeProof({
    env: { MC_BRIDGE_PROOF_FILE: PROOF_FILE },
    readFileSync: () => { throw missing },
  })
  assert.equal(result.ok, false, 'missing proof files must be rejected')
})

test('rejects malformed JSON', () => {
  const result = readBridgeProof({
    env: { MC_BRIDGE_PROOF_FILE: PROOF_FILE },
    readFileSync: () => '{not JSON',
  })
  assert.equal(result.ok, false, 'malformed proof JSON must be rejected')
})

test('rejects tokens that are not exactly 43 base64url characters', async (t) => {
  for (const token of ['', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(41)}+/`]) {
    await t.test(JSON.stringify(token), () => {
      const result = readBridgeProof({
        env: { MC_BRIDGE_PROOF_FILE: PROOF_FILE },
        readFileSync: () => validRecord(token),
      })
      assert.equal(result.ok, false, 'invalid proof tokens must be rejected')
    })
  }
})

test('returns the exact token from a valid record', () => {
  let requestedPath
  const result = readBridgeProof({
    env: { MC_BRIDGE_PROOF_FILE: PROOF_FILE },
    readFileSync: (path, encoding) => {
      requestedPath = path
      assert.equal(encoding, 'utf8')
      return validRecord()
    },
  })
  assert.deepEqual(result, { ok: true, proof: TOKEN })
  assert.equal(requestedPath, PROOF_FILE)
})

test('failure paths never leak proof material or call an injected logger', () => {
  let loggerCalls = 0
  const logger = () => { loggerCalls += 1 }
  const failures = [
    readBridgeProof({
      env: { MC_BRIDGE_PROOF_FILE: TOKEN },
      readFileSync: () => { throw Object.assign(new Error(TOKEN), { code: 'ENOENT' }) },
      logger,
    }),
    readBridgeProof({
      env: { MC_BRIDGE_PROOF_FILE: PROOF_FILE },
      readFileSync: () => `{${JSON.stringify(TOKEN)}`,
      logger,
    }),
    readBridgeProof({
      env: { MC_BRIDGE_PROOF_FILE: PROOF_FILE },
      readFileSync: () => validRecord(`${TOKEN}+`),
      logger,
    }),
    readBridgeProof({
      env: { MC_BRIDGE_PROOF_FILE: PROOF_FILE },
      readFileSync: () => JSON.stringify([{ token: TOKEN }]),
      logger,
    }),
    readBridgeProof({
      env: { MC_BRIDGE_PROOF_FILE: PROOF_FILE },
      readFileSync: () => { throw new Error(TOKEN) },
      logger,
    }),
  ]

  for (const result of failures) {
    assert.equal(result.ok, false)
    assert.equal(result.reason.includes(TOKEN), false)
  }
  assert.equal(loggerCalls, 0)
})

test('renderer bootstrap sends the shell proof as an encoded query parameter', async () => {
  globalThis.window = {
    location: { hostname: '127.0.0.1', search: '?bridge=http%3A%2F%2F127.0.0.1%3A4610' },
    mcShell: { getBridgeProof: async () => ({ ok: true, proof: TOKEN }) },
  }
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('/v1/bootstrap')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, token: 'bearer-token' }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, actions: [] }) }
  }

  const result = await bridgeStatus()

  assert.equal(result.ok, true)
  assert.deepEqual(calls.map(call => call.url), [
    `http://127.0.0.1:4610/v1/bootstrap?proof=${TOKEN}`,
    'http://127.0.0.1:4610/v1/status',
  ])
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(Object.hasOwn(calls[0].options.headers, 'authorization'), false)
  assert.equal(calls[1].options.headers.authorization, 'Bearer bearer-token')
})

test('plain-browser bootstrap degrades to a typed unavailable result without fetching', async () => {
  globalThis.window = {
    location: { hostname: '127.0.0.1', search: '?bridge=http%3A%2F%2F127.0.0.1%3A4610' },
  }
  let fetches = 0
  globalThis.fetch = async () => { fetches += 1; throw new Error('must not fetch') }

  const result = await bridgeStatus()

  assert.equal(result.ok, false)
  assert.equal(
    result.code,
    'BRIDGE_BOOTSTRAP_PROOF_UNAVAILABLE',
    'plain browsers must return the typed proof-unavailable result',
  )
  assert.equal(fetches, 0)
})
