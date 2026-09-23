import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { fetchStatus } from '../../src/live-status.js'
import { assertValidProjection } from '../gen-projection-lib.mjs'

const DATA_URL = new URL('../../public/data/', import.meta.url)
const DOMAINS = ['fleet', 'agents', 'metrics', 'ops', 'ledger', 'coordinator', 'research']
const ENVELOPE_KEYS = ['data', 'domain', 'generatedAt', 'ok', 'reason', 'schemaVersion', 'sources']

async function readDataFile(name) {
  const url = new URL(`${name}.json`, DATA_URL)
  const raw = await readFile(fileURLToPath(url), 'utf8')
  return { raw, data: JSON.parse(raw) }
}

test('projection files ship schema-valid unavailable envelopes', async () => {
  for (const domain of DOMAINS) {
    const { data } = await readDataFile(domain)
    assert.doesNotThrow(() => assertValidProjection(domain, data), `${domain}: schema validation`)
    assert.deepEqual(Object.keys(data).sort(), ENVELOPE_KEYS, `${domain}: exact envelope keys`)
    assert.equal(data.schemaVersion, 1, `${domain}: schemaVersion`)
    assert.equal(data.domain, domain, `${domain}: domain`)
    assert.equal(data.ok, false, `${domain}: unavailable`)
    assert.equal(typeof data.reason, 'string', `${domain}: reason type`)
    assert.ok(data.reason.trim(), `${domain}: non-empty reason`)
    assert.ok(Array.isArray(data.sources), `${domain}: sources array`)
    assert.deepEqual(data.sources, [], `${domain}: no sources`)
    assert.equal(data.data, null, `${domain}: unavailable data`)
  }
})

test('shipped data files contain no owner identity or local addresses', async () => {
  for (const name of [...DOMAINS, 'status']) {
    const { raw } = await readDataFile(name)
    assert.doesNotMatch(raw, /joshp/i, `${name}: owner name`)
    assert.doesNotMatch(raw, /192\.168\.214\./, `${name}: private address`)
    assert.doesNotMatch(raw, /C:\\+Users/i, `${name}: Windows user path`)
    assert.doesNotMatch(raw, /C:\/Users/i, `${name}: slash user path`)
  }
})

test('status file ships an unavailable envelope', async () => {
  const { data } = await readDataFile('status')
  assert.equal(data.schemaVersion, 1)
  assert.equal(data.ok, false)
  assert.equal(typeof data.reason, 'string')
  assert.ok(data.reason.trim())
})

test('fetchStatus preserves an unavailable status payload', async () => {
  const { data } = await readDataFile('status')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => data,
  })

  try {
    const result = await fetchStatus()
    assert.equal(result.ok, false)
    assert.equal(result.reason, data.reason)
    assert.deepEqual(result.data, data)
  } finally {
    globalThis.fetch = originalFetch
  }
})
