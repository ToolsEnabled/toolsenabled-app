import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  DOMAINS,
  PROJECT_ROOT,
  assertValidProjection,
  readSchema,
  unavailableEnvelope,
  validateAgainstSchema,
} from '../gen-projection-lib.mjs'
import { fetchProjection, fetchStatus } from '../../src/live-status.js'

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

function response(value, { status = 200, statusText = 'OK', jsonError = null } = {}) {
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

function projectionFetch(domain, payload, schema = readSchema(domain)) {
  return async url => {
    if (url === `/data/${domain}.json`) return response(payload)
    if (url === `/data/schema/${domain}.schema.json`) return response(schema)
    return response(null, { status: 404, statusText: 'Not Found' })
  }
}

test('all projection schemas accept their explicit unavailable envelope', () => {
  for (const domain of DOMAINS) {
    const payload = unavailableEnvelope(domain, 'test-source-unavailable', [], '2026-08-05T00:00:00.000Z')
    assert.doesNotThrow(() => assertValidProjection(domain, payload))
  }
})

test('schemas reject the wrong version, wrong domain, and invented extra fields', () => {
  for (const domain of DOMAINS) {
    const schema = readSchema(domain)
    const base = unavailableEnvelope(domain, 'test-source-unavailable', [], '2026-08-05T00:00:00.000Z')
    assert.ok(validateAgainstSchema({ ...base, schemaVersion: 2 }, schema).length > 0)
    assert.ok(validateAgainstSchema({ ...base, domain: 'other' }, schema).length > 0)
    assert.ok(validateAgainstSchema({ ...base, fabricatedCount: 0 }, schema).length > 0)
  }
  assert.throws(
    () => assertValidProjection('fleet', unavailableEnvelope('fleet', 'test-source-unavailable', []), {}),
    error => error?.code === 'PROJECTION_SCHEMA_UNRECOGNIZED',
  )
})

test('reader returns a valid unavailable projection as ok:false end to end', async () => {
  const payload = unavailableEnvelope('fleet', 'source-unreachable', [], '2026-08-05T00:00:00.000Z')
  const result = await fetchProjection('fleet', { fetchImpl: projectionFetch('fleet', payload) })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'source-unreachable')
  assert.deepEqual(result.data, payload)
  assert.equal(typeof result.fetchedAtMs, 'number')
})

test('reader refuses missing, malformed, unrecognized-schema, and schema-invalid projections without throwing', async t => {
  await t.test('missing payload', async () => {
    const result = await fetchProjection('fleet', { fetchImpl: async url => url.includes('schema') ? response(readSchema('fleet')) : response(null, { status: 404, statusText: 'Not Found' }) })
    assert.equal(result.ok, false)
    assert.match(result.reason, /responded 404/)
  })

  await t.test('malformed JSON', async () => {
    const result = await fetchProjection('fleet', { fetchImpl: async url => url.includes('schema') ? response(readSchema('fleet')) : response(null, { jsonError: new SyntaxError('fixture malformed') }) })
    assert.equal(result.ok, false)
    assert.match(result.reason, /did not parse as JSON/)
  })

  await t.test('unrecognized schema', async () => {
    const payload = unavailableEnvelope('fleet', 'source-unreachable', [], '2026-08-05T00:00:00.000Z')
    const result = await fetchProjection('fleet', { fetchImpl: projectionFetch('fleet', payload, {}) })
    assert.equal(result.ok, false)
    assert.match(result.reason, /unrecognized schema contract/)
  })

  await t.test('payload rejected by schema', async () => {
    const payload = { ...unavailableEnvelope('fleet', 'source-unreachable', [], '2026-08-05T00:00:00.000Z'), schemaVersion: 2 }
    const result = await fetchProjection('fleet', { fetchImpl: projectionFetch('fleet', payload) })
    assert.equal(result.ok, false)
    assert.match(result.reason, /failed schema validation/)
  })

  await t.test('network error', async () => {
    const result = await fetchProjection('fleet', { fetchImpl: async () => { throw new Error('fixture offline') } })
    assert.equal(result.ok, false)
    assert.match(result.reason, /network error/)
  })
})

test('legacy fetchStatus contract stays fail-closed and accepts its v1 snapshot', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  globalThis.fetch = async () => response({ schemaVersion: 1, generatedAt: '2026-08-05T00:00:00.000Z' })
  const valid = await fetchStatus()
  assert.equal(valid.ok, true)

  globalThis.fetch = async () => { throw new Error('fixture offline') }
  const network = await fetchStatus()
  assert.equal(network.ok, false)
  assert.match(network.reason, /network error/)

  globalThis.fetch = async () => response(null, { jsonError: new SyntaxError('fixture malformed') })
  const malformed = await fetchStatus()
  assert.equal(malformed.ok, false)
  assert.match(malformed.reason, /did not parse as JSON/)
})

test('checked-in generated payloads validate against their public schemas', () => {
  for (const domain of DOMAINS) {
    const path = join(PROJECT_ROOT, 'public', 'data', `${domain}.json`)
    const payload = readJson(path)
    assert.doesNotThrow(() => assertValidProjection(domain, payload), domain)
  }
})

// This test used to be `browser reader accepts all checked-in available
// projections` and asserted result.ok === true for every shipped file. That
// premise was deliberately reversed by T4c ("ship honest empty data instead of
// the owner's snapshot"): the seven shipped projections are now minimal
// unavailable envelopes, because the populated ones carried the owner's fleet
// state, machine addresses, and private report paths into the installer. So the
// old test demanded the exact thing a privacy fix had just removed.
//
// Asserting availability was never the point. What the reader owes callers is
// that it does not INVENT: an unavailable file must not be reported live, and an
// available one must not be reported dead. That is asserted here in both
// directions, and it stays correct whichever way the ship-the-data question is
// finally settled.
//
// The accept path is not dropped. It moves to research-generator.test.mjs
// ('a generated available payload is accepted by the browser reader'), which
// owns a deterministic fixture and can produce a genuinely available payload --
// something this file could only ever have borrowed from the owner's snapshot.
test('browser reader reports every checked-in projection exactly as that file states it', async () => {
  assert.ok(DOMAINS.length > 0, 'DOMAINS is empty, so this test would assert nothing')
  for (const domain of DOMAINS) {
    const payload = readJson(join(PROJECT_ROOT, 'public', 'data', `${domain}.json`))
    assert.doesNotThrow(() => assertValidProjection(domain, payload), domain)

    const result = await fetchProjection(domain, { fetchImpl: projectionFetch(domain, payload) })
    assert.deepEqual(result.data, payload, `${domain}: the reader must hand back the exact envelope it validated`)
    assert.equal(
      result.ok,
      payload.ok,
      `${domain}: reader availability must equal the file's own ok flag, never a reader-chosen default`,
    )

    if (payload.ok === true) {
      assert.equal(payload.reason, null, `${domain}: an available envelope carries no reason`)
      assert.notEqual(payload.data, null, `${domain}: an available envelope must carry data`)
      assert.equal(Object.hasOwn(result, 'reason'), false, `${domain}: the reader must not attach a reason to an available projection`)
    } else {
      assert.equal(payload.data, null, `${domain}: an unavailable envelope must carry no data`)
      assert.equal(
        result.reason,
        payload.reason,
        `${domain}: the reader must surface the file's own reason, not one it composed`,
      )
      assert.equal(typeof result.reason, 'string', `${domain}: reason must be readable text`)
      assert.notEqual(result.reason.length, 0, `${domain}: reason must not be empty`)
    }
    assert.equal(typeof result.fetchedAtMs, 'number', `${domain}: every read is stamped with the reader's own clock`)
  }
})
