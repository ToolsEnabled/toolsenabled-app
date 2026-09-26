import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bridgeControlState,
  bridgeStatus,
  configuredBaseUrl,
  resetBridgeSession,
  STATUS_TIMEOUT_MS,
  WELL_KNOWN_BRIDGE_PORTS,
} from '../../src/mission-bridge.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/* THE STATUS BUDGET WAS INSIDE THE DISTRIBUTION OF THE CALL IT BOUNDED.
 *
 * MEASURED 2026-09-03 from the live action ledger: system.status (what
 * bridgeStatus() calls over /v1/status) succeeded in as long as 31,121 ms --
 * one real sample already past the file's old 30,000 ms STATUS_TIMEOUT_MS. A
 * client budget under the real cost of a durable-audit-writing call does not
 * make the call faster; it manufactures a "timed out" for work the bridge was
 * about to finish, exactly the failure this file's ACTION_TIMEOUT_MS comment
 * already names for `dispatch`. Two sequential durable writes back it
 * (capability/src/lib/mission-bridge/actions.js status(): intentAudit, then
 * outcomeAudit per root), and the same ledger's host.exec "Durable audit
 * intent could not be recorded" failures show a single durable write on this
 * installation costing 4,619-53,012 ms under contention (50 records) -- so two
 * of them in series clearing only 30,000 ms was never a comfortable margin. */
test('the status budget clears the measured worst case, not the old single-sample guess (mutation: revert STATUS_TIMEOUT_MS to 30_000)', () => {
  assert.ok(
    STATUS_TIMEOUT_MS > 31_121,
    `STATUS_TIMEOUT_MS (${STATUS_TIMEOUT_MS} ms) must clear the measured 31,121 ms worst case, or a genuinely finished status call reports BRIDGE_TIMEOUT`,
  )
  assert.equal(
    STATUS_TIMEOUT_MS,
    120_000,
    'moved into the same tier as this file\'s other durable-audit-writing actions (dispatch, terminate, ledger-archive, cloud-accounts)',
  )
})

/* THE NUMBER BEING RIGHT DOES NOT MEAN THE CALL SITE READS IT. A budget fixed
 * here and left unwired -- bridgeStatus() still passing REQUEST_TIMEOUT_MS, or
 * a literal 30000 -- would pass the test above while the bridge kept reporting
 * the same false timeout. Read the source, not the behaviour a mock could
 * accidentally make look right. */
test('bridgeStatus and localTiersStatus both read the STATUS_TIMEOUT_MS binding, never a literal', () => {
  const source = withoutComments(readFileSync(path.join(repo, 'src', 'mission-bridge.js'), 'utf8'))
  const bridgeStatusBody = source.slice(source.indexOf('export function bridgeStatus'), source.indexOf('export function bridgeStatus') + 200)
  assert.match(bridgeStatusBody, /timeoutMs:\s*STATUS_TIMEOUT_MS/)
  const localTiersIndex = source.indexOf('local-tiers-status')
  const localTiersBody = source.slice(localTiersIndex - 40, localTiersIndex + 70)
  assert.match(localTiersBody, /timeoutMs:\s*STATUS_TIMEOUT_MS/)
})

test('bridge control state rejects a disabled control with no reason (mutation: bypass shared controlState)', () => {
  for (const missingReason of [undefined, null, '', '   ']) {
    assert.throws(
      () => bridgeControlState('unavailable', false, 'Unavailable', 'Blocked', missingReason),
      /controlState requires a reason when disabled/,
    )
  }
})

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
// Exactly 43 base64url characters, the shape shell/bridge-proof.cjs enforces.
const SHELL_PROOF = 'mission-bridge-fixture-bootstrap-proof-0001'.padEnd(43, '0')

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
  }
}

function runtime(port, overrides = {}) {
  return {
    ok: true,
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    startedAt: '2026-08-06T08:00:00.000Z',
    pid: 43210,
    ...overrides,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
  resetBridgeSession()
})

test('discovery walks 4610-4619 in order and authenticates only after an exact valid tuple', async () => {
  // The shell proof is part of the bootstrap contract (shell/bridge-proof.cjs):
  // bootstrap refuses before it fetches anything when window.mcShell cannot
  // supply one, so a discovery fixture that omits it never reaches the walk's
  // conclusion. Stubbed here, NOT asserted away -- the plain-browser refusal
  // has its own case in bridge-proof.test.mjs.
  globalThis.window = { location: { hostname: '127.0.0.1', search: '' }, mcShell: { getBridgeProof: async () => ({ ok: true, proof: SHELL_PROOF }) } }
  const calls = []
  globalThis.fetch = async (url, options) => {
    const href = String(url)
    calls.push({ url: href, options })
    if (href === 'http://127.0.0.1:4610/v1/runtime') {
      return response(200, runtime(4612))
    }
    if (href === 'http://127.0.0.1:4611/v1/runtime') {
      return response(200, { ...runtime(4611), unexpected: true })
    }
    if (href === 'http://127.0.0.1:4612/v1/runtime') {
      return response(200, runtime(4612))
    }
    if (href === `http://127.0.0.1:4612/v1/bootstrap?proof=${SHELL_PROOF}`) {
      return response(200, { ok: true, token: 'fixture-bearer' })
    }
    if (href === 'http://127.0.0.1:4612/v1/status') {
      return response(200, { ok: true, actions: [] })
    }
    throw new Error(`unexpected fetch ${href}`)
  }

  const status = await bridgeStatus()
  assert.equal(status.ok, true)
  assert.deepEqual(calls.map(call => call.url), [
    'http://127.0.0.1:4610/v1/runtime',
    'http://127.0.0.1:4611/v1/runtime',
    'http://127.0.0.1:4612/v1/runtime',
    `http://127.0.0.1:4612/v1/bootstrap?proof=${SHELL_PROOF}`,
    'http://127.0.0.1:4612/v1/status',
  ])
  assert.equal(calls.slice(0, 4).some(call => Object.hasOwn(call.options.headers, 'authorization')), false)
  assert.equal(calls[4].options.headers.authorization, 'Bearer fixture-bearer')
})

test('discovery returns a typed unavailable result when no candidate answers validly', async () => {
  globalThis.window = { location: { hostname: '127.0.0.1', search: '' } }
  const calls = []
  globalThis.fetch = async url => {
    calls.push(url)
    if (url === 'http://127.0.0.1:4614/v1/runtime') return response(200, runtime(4614, { startedAt: 'not-a-date' }))
    throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
  }

  const configured = await configuredBaseUrl()
  assert.deepEqual(configured, {
    ok: false,
    reason: 'action bridge unavailable on the declared 127.0.0.1:4610-4619 range',
    code: 'BRIDGE_DISCOVERY_UNAVAILABLE',
  })
  assert.equal(calls.length, 10)
  assert.deepEqual(WELL_KNOWN_BRIDGE_PORTS, [4610, 4611, 4612, 4613, 4614, 4615, 4616, 4617, 4618, 4619])
})

test('an explicit bridge query remains first and bypasses well-known discovery', async () => {
  globalThis.window = { location: { hostname: '127.0.0.1', search: '?bridge=http%3A%2F%2F127.0.0.1%3A4700' } }
  let fetches = 0
  globalThis.fetch = async () => { fetches += 1; throw new Error('should not fetch') }

  assert.deepEqual(await configuredBaseUrl(), { ok: true, baseUrl: 'http://127.0.0.1:4700' })
  assert.equal(fetches, 0)
})

// --- security: the renderer must not discover its bridge by trusting the first
// structurally-valid /v1/runtime responder. A supervised shell names the exact
// origin it started; the renderer pins to it and never scans, so a local
// squatter on a lower port is never handed this boot's bootstrap proof. ---

const supervised = (port, pid = 43210) => ({
  location: { hostname: '127.0.0.1', search: '' },
  mcShell: {
    getBridgeProof: async () => ({ ok: true, proof: SHELL_PROOF }),
    getBridgeEndpoint: async () => ({ ok: true, source: 'supervised', baseUrl: `http://127.0.0.1:${port}`, pid }),
  },
})

test('a supervised shell pins to its own layer and never scans a squatter on a lower port', async () => {
  // The install's own layer sits on 4611; a squatter (or a benign foreign
  // ToolsEnabled bridge) holds the lower 4610. The renderer must talk only to
  // 4611 and must never fetch 4610 at all.
  globalThis.window = supervised(4611)
  const fetched = []
  globalThis.fetch = async (url) => {
    const href = String(url)
    fetched.push(href)
    if (href === 'http://127.0.0.1:4611/v1/runtime') return response(200, runtime(4611))
    throw new Error(`must not fetch ${href}`)
  }

  assert.deepEqual(await configuredBaseUrl(), { ok: true, baseUrl: 'http://127.0.0.1:4611' })
  assert.deepEqual(fetched, ['http://127.0.0.1:4611/v1/runtime'])
  assert.equal(fetched.some(href => href.includes(':4610')), false)
})

test('a supervised shell ignores a ?bridge= override aimed at a squatter', async () => {
  // The second vector: a malicious shortcut appends ?bridge=<squatter>. In the
  // supervised path it must be ignored entirely -- the renderer only trusts the
  // origin the shell itself started.
  globalThis.window = supervised(4611)
  globalThis.window.location.search = '?bridge=http%3A%2F%2F127.0.0.1%3A4650'
  const fetched = []
  globalThis.fetch = async (url) => {
    const href = String(url)
    fetched.push(href)
    if (href === 'http://127.0.0.1:4611/v1/runtime') return response(200, runtime(4611))
    throw new Error(`must not fetch ${href}`)
  }

  assert.deepEqual(await configuredBaseUrl(), { ok: true, baseUrl: 'http://127.0.0.1:4611' })
  assert.equal(fetched.some(href => href.includes(':4650')), false)
})

test('a supervised layer whose live pid does not match fails closed without scanning', async () => {
  // The shell started pid 43210 on 4611; something else now answers there with
  // a different pid. Refuse rather than hand over the proof, and never fall back
  // to the range scan.
  globalThis.window = supervised(4611, 43210)
  const fetched = []
  globalThis.fetch = async (url) => {
    const href = String(url)
    fetched.push(href)
    if (href === 'http://127.0.0.1:4611/v1/runtime') return response(200, runtime(4611, { pid: 99999 }))
    throw new Error(`must not fetch ${href}`)
  }

  const configured = await configuredBaseUrl()
  assert.equal(configured.ok, false)
  assert.equal(configured.code, 'BRIDGE_OWN_LAYER_UNCONFIRMED')
  assert.deepEqual(fetched, ['http://127.0.0.1:4611/v1/runtime'])
})

test('a supervised layer that does not answer fails closed without scanning', async () => {
  globalThis.window = supervised(4611)
  const fetched = []
  globalThis.fetch = async (url) => {
    fetched.push(String(url))
    throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
  }

  const configured = await configuredBaseUrl()
  assert.equal(configured.ok, false)
  assert.equal(configured.code, 'BRIDGE_OWN_LAYER_UNCONFIRMED')
  // Exactly one attempt -- its own layer -- and no scan of the well-known range.
  assert.deepEqual(fetched, ['http://127.0.0.1:4611/v1/runtime'])
})

/* ------------------------------------------------------------------
   The public-origin gate. Everything above fakes a loopback origin because
   everything above is about what a page served BY the machine may do to it.
   These cases are the other half: a page served from a public origin -- the
   website, including a signed-in visitor at a friend's computer -- must never
   look for a bridge on the machine in front of it. Until this gate existed the
   rule was held by host-bridge.js answering a deliberately invalid endpoint; a
   convention a missing file turns off. These tests hold the RULE, not the
   convention: no fetch happens at all, whatever the host bridge says.
   ------------------------------------------------------------------ */

function refusesLoopback(label, windowFake) {
  test(label, async () => {
    let fetched = 0
    globalThis.fetch = async () => { fetched += 1; return response(200, runtime(4610)) }
    globalThis.window = windowFake
    const result = await configuredBaseUrl()
    assert.equal(result.ok, false)
    assert.equal(result.code, 'BRIDGE_FORBIDDEN_ON_PUBLIC_ORIGIN')
    assert.equal(fetched, 0, 'a public origin reached for the visitor\'s loopback')
    assert.match(result.reason, /relay transport/, 'the refusal must say where a signed-in page reaches a machine instead')
  })
}

refusesLoopback('a public origin never scans, even with no host bridge at all',
  { location: { hostname: 'toolsenabled.ai', search: '' } })

refusesLoopback('a public origin refuses ?bridge= outright instead of honouring it',
  { location: { hostname: 'toolsenabled.ai', search: '?bridge=http%3A%2F%2F127.0.0.1%3A4610' } })

refusesLoopback('a supervised endpoint pinning loopback is still refused on a public origin',
  {
    location: { hostname: 'toolsenabled.ai', search: '' },
    mcShell: {
      getBridgeEndpoint: async () => ({ ok: true, source: 'supervised', baseUrl: 'http://127.0.0.1:4611' }),
      getBridgeProof: async () => ({ ok: true, proof: SHELL_PROOF }),
    },
  })

test('a window with no hostname is treated as public, because unmeasured must fail closed', async () => {
  let fetched = 0
  globalThis.fetch = async () => { fetched += 1; return response(200, runtime(4610)) }
  globalThis.window = { location: { search: '' } }
  const result = await configuredBaseUrl()
  assert.equal(result.code, 'BRIDGE_FORBIDDEN_ON_PUBLIC_ORIGIN')
  assert.equal(fetched, 0)
})
