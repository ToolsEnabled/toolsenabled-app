import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  PROJECTION_DOMAINS,
  ageMs,
  fetchAgents,
  fetchCoordinator,
  fetchFleet,
  fetchLedger,
  fetchMetrics,
  fetchOps,
  fetchProjection,
  fetchResearch,
  fetchStatus,
  fmtAge,
} from '../../src/live-status.js'

const FIXED_NOW = Date.parse('2026-08-25T12:00:00.000Z')

function response(value, { status = 200, statusText = 'OK', jsonError } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async json() {
      if (jsonError) throw jsonError
      return structuredClone(value)
    },
  }
}

function schemaFor(domain) {
  return JSON.parse(readFileSync(new URL(`../../public/data/schema/${domain}.schema.json`, import.meta.url), 'utf8'))
}

function unavailable(domain, reason = 'source-could-not-be-read') {
  return {
    schemaVersion: 1,
    domain,
    generatedAt: '2026-08-25T11:59:00.000Z',
    ok: false,
    reason,
    sources: [],
    data: null,
  }
}

test('the readers used by views request their own projection without caching', async () => {
  const readers = new Map([
    ['fleet', fetchFleet],
    ['agents', fetchAgents],
    ['metrics', fetchMetrics],
    ['ops', fetchOps],
    ['ledger', fetchLedger],
    ['coordinator', fetchCoordinator],
    ['research', fetchResearch],
  ])
  assert.deepEqual(
    [...readers.keys()],
    PROJECTION_DOMAINS,
    'every caller-facing reader must remain registered under its public domain',
  )
  assert.equal(Object.isFrozen(PROJECTION_DOMAINS), true, 'callers must not be able to rewrite the supported-domain contract')

  for (const [domain, read] of readers) {
    const calls = []
    const payload = unavailable(domain)
    const result = await read({
      fetchImpl: async (url, options) => {
        calls.push([url, options])
        return response(url.includes('/schema/') ? schemaFor(domain) : payload)
      },
    })
    assert.deepEqual(calls, [
      [`/data/${domain}.json`, { cache: 'no-store' }],
      [`/data/schema/${domain}.schema.json`, { cache: 'no-store' }],
    ], `${domain}: reader must request its data and schema with cache bypassed`)
    assert.equal(result.ok, false, `${domain}: an unavailable reading must never become a definite answer`)
    assert.equal(result.reason, payload.reason, `${domain}: users must receive the source's explanation`)
    assert.deepEqual(result.data, payload, `${domain}: callers must receive the validated unavailable envelope`)
  }
})

test('projection read failures stay uncertain and explain the failed stage', async () => {
  const cases = [
    ['connection', async () => { throw new Error('fixture offline') }, /network|reaching/i],
    ['data response', async url => response(null, url.includes('/schema/') ? {} : { status: 503, statusText: 'Unavailable' }), /data\/fleet\.json.*503/i],
    ['schema response', async url => response(null, url.includes('/schema/') ? { status: 404, statusText: 'Missing' } : {}), /schema\/fleet\.schema\.json.*404/i],
    ['JSON decoding', async url => response(url.includes('/schema/') ? {} : null, { jsonError: new SyntaxError('fixture broken') }), /parse|json/i],
    ['schema recognition', async url => response(url.includes('/schema/') ? {} : unavailable('fleet')), /schema.*unrecognized/i],
  ]

  for (const [stage, fetchImpl, explanation] of cases) {
    const result = await fetchProjection('fleet', { fetchImpl })
    assert.equal(result.ok, false, `${stage}: a could-not-read must not collapse into a definite answer`)
    assert.equal(typeof result.reason, 'string', `${stage}: refusal must include a user-readable explanation`)
    assert.match(result.reason, explanation, `${stage}: explanation must identify the stage that could not be read`)
  }

  const unknown = await fetchProjection('not-a-real-domain', { fetchImpl: assert.fail })
  assert.equal(unknown.ok, false, 'unsupported domains must be refused')
  assert.match(unknown.reason, /unknown.*domain/i, 'unsupported-domain refusal must explain what was refused')
})

test('status reads preserve availability and fail closed when no status can be read', async t => {
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  t.after(() => {
    globalThis.fetch = originalFetch
    Date.now = originalNow
  })
  Date.now = () => FIXED_NOW

  const unavailableStatus = { schemaVersion: 1, ok: false, reason: 'collector-unreachable' }
  globalThis.fetch = async () => response(unavailableStatus)
  assert.deepEqual(
    await fetchStatus(),
    { ok: false, reason: unavailableStatus.reason, data: unavailableStatus, fetchedAtMs: FIXED_NOW },
    'an unreadable status source must remain explicitly unavailable with its explanation',
  )

  globalThis.fetch = async () => response({ schemaVersion: 1, ok: true, active: 3 })
  const available = await fetchStatus()
  assert.equal(available.ok, true, 'a valid available status must reach the home view')
  assert.equal(available.data.active, 3, 'a real status value must not be replaced or invented')

  globalThis.fetch = async () => { throw new Error('fixture offline') }
  const offline = await fetchStatus()
  assert.equal(offline.ok, false, 'a status network failure must not become a definite answer')
  assert.match(offline.reason, /network|reaching/i, 'a status network refusal must explain the failed read')

  globalThis.fetch = async () => response({ schemaVersion: 2, ok: true })
  const wrongShape = await fetchStatus()
  assert.equal(wrongShape.ok, false, 'an unrecognized status payload must not become a definite answer')
  assert.match(wrongShape.reason, /shape|schemaVersion/i, 'an invalid-status refusal must identify the contract problem')
})

test('age helpers handle caller timestamps, bad readings, future clocks, and useful units', () => {
  assert.equal(ageMs('2026-08-25T11:58:30.000Z', FIXED_NOW), 90_000, 'ISO readings must be measured against the caller clock')
  assert.equal(ageMs(FIXED_NOW - 2_000, FIXED_NOW), 2_000, 'numeric readings must remain supported')
  assert.equal(ageMs('not-a-timestamp', FIXED_NOW), null, 'an unparseable reading must remain unknown')
  assert.equal(ageMs('2026-08-25T12:01:00.000Z', FIXED_NOW), 0, 'clock skew must not display a negative age')

  assert.equal(fmtAge(null), null, 'a missing age must remain unknown instead of looking current')
  assert.match(fmtAge(42_900), /^42s\s+ago$/, 'seconds must remain visible for a fresh reading')
  assert.match(fmtAge(3 * 3_600_000 + 12 * 60_000), /^3h\s+12m\s+ago$/, 'hour ages must retain useful remaining minutes')
  assert.match(fmtAge(2 * 86_400_000 + 5 * 3_600_000), /^2d\s+5h\s+ago$/, 'day ages must retain useful remaining hours')
})
