import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  createBridgeApiContract, validateBridgeApiContract, assessBridgeApiCompatibility,
} from '../../src/generated/bridge-api-contract.js'
import { bridgeApiContract, setBridgeTransport, resetBridgeSession } from '../../src/mission-bridge.js'

const originalWindow = globalThis.window
const originalFetch = globalThis.fetch
const contract = () => createBridgeApiContract({ '/v1/actions/dispatch': 'dispatch' })
afterEach(() => {
  setBridgeTransport(null)
  resetBridgeSession()
  globalThis.window = originalWindow
  globalThis.fetch = originalFetch
})

test('the generated browser contract applies the same closed schema and major/action compatibility rules', () => {
  assert.equal(validateBridgeApiContract(contract()), true)
  assert.deepEqual(assessBridgeApiCompatibility(contract(), { requiredActions: ['dispatch'] }), { ok: true, apiMajor: 1, apiMinor: 0 })
  assert.equal(assessBridgeApiCompatibility({ ...contract(), extra: true }).code, 'BRIDGE_API_CONTRACT_INVALID')
  assert.equal(assessBridgeApiCompatibility({ ...contract(), api: { ...contract().api, major: 2 } }).code, 'BRIDGE_API_MAJOR_UNSUPPORTED')
})

test('a public-origin client inspects its selected remote transport without looking at local state', async () => {
  globalThis.window = { location: { hostname: 'app.example.invalid', search: '' } }
  globalThis.fetch = () => { throw new Error('a remote contract check must not touch localhost') }
  const calls = []
  setBridgeTransport(async (pathname, options) => {
    calls.push({ pathname, method: options.method, body: options.body })
    return { ok: true, contract: contract() }
  })
  const result = await bridgeApiContract({ requiredActions: ['dispatch'] })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [{ pathname: '/v1/contract', method: 'GET', body: null }])
})

test('invalid, incompatible, missing and unreachable contracts are explicit failures', async () => {
  for (const [reply, code] of [
    [{ ok: true }, 'BRIDGE_API_CONTRACT_INVALID'],
    [{ ok: true, contract: { ...contract(), api: { ...contract().api, major: 2 } } }, 'BRIDGE_API_MAJOR_UNSUPPORTED'],
    [{ ok: false, code: 'BRIDGE_ROUTE_NOT_FOUND', reason: 'Old engine' }, 'BRIDGE_ROUTE_NOT_FOUND'],
  ]) {
    setBridgeTransport(async () => reply)
    const result = await bridgeApiContract()
    assert.equal(result.ok, false)
    assert.equal(result.code, code)
  }
  setBridgeTransport(async () => ({ ok: true, contract: contract() }))
  assert.equal((await bridgeApiContract({ requiredActions: ['missing'] })).code, 'BRIDGE_API_ACTION_UNAVAILABLE')
  setBridgeTransport(async () => { throw new Error('offline') })
  assert.equal((await bridgeApiContract()).ok, false)
})

test('the local client pins its own process and obtains a credential before reading a contract', async () => {
  const baseUrl = 'http://127.0.0.1:4610'
  const proof = 'p'.repeat(43)
  const calls = []
  globalThis.window = {
    location: { hostname: '127.0.0.1', search: '' },
    mcShell: {
      getBridgeEndpoint: async () => ({ ok: true, source: 'supervised', baseUrl, pid: 1234 }),
      getBridgeProof: async () => ({ ok: true, proof }),
    },
  }
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.authorization })
    const body = String(url).endsWith('/v1/runtime')
      ? { ok: true, baseUrl, port: 4610, startedAt: '2026-09-05T00:00:00.000Z', pid: 1234 }
      : String(url).includes('/v1/bootstrap?proof=')
        ? { ok: true, token: 'fixture-token' }
        : String(url).endsWith('/v1/contract') ? { ok: true, contract: contract() } : null
    assert.ok(body, `unexpected request: ${url}`)
    return { ok: true, status: 200, json: async () => body }
  }
  assert.equal((await bridgeApiContract()).ok, true)
  assert.deepEqual(calls, [
    { url: `${baseUrl}/v1/runtime`, authorization: undefined },
    { url: `${baseUrl}/v1/bootstrap?proof=${proof}`, authorization: undefined },
    { url: `${baseUrl}/v1/contract`, authorization: 'Bearer fixture-token' },
  ])
})
