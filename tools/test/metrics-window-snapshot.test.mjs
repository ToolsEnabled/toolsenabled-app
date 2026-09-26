import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createUsageRecorder } from '../../shell/usage-record.cjs'
import { createSpawnRecorder } from '../../shell/spawn-record.cjs'
import { readMetricsRecords } from '../../src/metrics-records.js'

const A = `account:${'a'.repeat(32)}`, B = `account:${'b'.repeat(32)}`
const NOW = Date.UTC(2026, 8, 23, 12), DAY = 86400000
const window = { startMs: NOW - 30 * DAY, endMs: NOW + 1 }
const storage = { isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() }
function fixture(t, rows = 425) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'metrics-snapshot-'))
  t.after(() => {
    if (process.env.TOOLSENABLED_TEST_RETAIN_FIXTURES === '1') t.diagnostic(`RETAINED_METRICS_SNAPSHOT ${directory}`)
    else fs.rmSync(directory, { recursive: true, force: true })
  })
  const usage = createUsageRecorder({ directory, safeStorage: storage, now: () => new Date(NOW).toISOString() })
  // These synthetic fixture writes test no durability claim. Keep real writer
  // normalization, hashing/signing and file bytes, without 20,000 disk flushes.
  const sync = t.mock.method(fs, 'fsyncSync', () => {})
  try {
    for (let i = 0; i < rows; i++) usage.recordTurn({ sessionId: `turn-${i}`, principal: A,
      usage: { totalTokens: i + 1, basis: 'turn' }, status: 'completed' })
  } finally { sync.mock.restore() }
  const emptyHistory = async request => ({ ok: true, verified: true, entries: [],
    metrics: { v: 1, ...request.metrics, principal: A, head: 0, count: 0, nextBefore: null } })
  return { directory, usage, agent: { history: emptyHistory,
    usage: request => usage.usageAsync({ ...request, metrics: { ...request.metrics, principal: A } }) } }

}

test('a 20,000-row Metrics window reads and projects the token file once while retaining every value', async t => {
  const f = fixture(t, 20000)
  let reads = 0, parsedRows = 0
  const originalRead = fs.promises.readFile, originalParse = JSON.parse
  t.after(() => { fs.promises.readFile = originalRead; JSON.parse = originalParse })
  fs.promises.readFile = function(file, ...args) {
    if (String(file) === f.usage.ledgerPath) reads++
    return originalRead.call(this, file, ...args)
  }
  JSON.parse = function(text, ...args) {
    const parsed = originalParse.call(this, text, ...args)
    if (parsed?.action === 'agent_turn_usage') parsedRows++
    return parsed
  }
  const result = await readMetricsRecords({ agent: f.agent, window })
  assert.equal(result.usage.readable, true)
  assert.equal(result.usage.verified, true, 'the real signed token chain must verify')
  assert.equal(result.usage.turns.length, 20000)
  const actual = result.usage.turns.map(row => [row.sessionId, row.totalTokens]).sort((a, b) => a[1] - b[1])
  assert.deepEqual(actual, Array.from({ length: 20000 }, (_, i) => [`turn-${i}`, i + 1]))
  t.diagnostic(`TOKEN_FILE_READS ${reads}; TOKEN_ROWS_PARSED ${parsedRows}; RETURNED ${actual.length}`)
  assert.ok(reads <= 2, `one window must not reread the full file for each page; observed ${reads}`)
  assert.ok(parsedRows <= 40000, `one verifier pass plus one projection pass; observed ${parsedRows}`)
})

const query = (principal = A, scope) => ({ fromMs: window.startMs, toMs: window.endMs, principal, ...(scope ? { scope } : {}) })
const continuation = (page, principal = A) => ({ fromMs: window.startMs, toMs: window.endMs, principal,
  before: page.metrics.nextBefore, head: page.metrics.head, snapshot: page.metrics.snapshot,
  ...(page.metrics.scope ? { scope: page.metrics.scope } : {}) })

test('two concurrent snapshots retain their own rows while fresh reads observe an append', async t => {
  const f = fixture(t)
  const first = await f.usage.usageAsync({ metrics: query() })
  const second = await f.usage.usageAsync({ metrics: query(A, 'computer') })
  assert.notEqual(first.metrics.snapshot, second.metrics.snapshot)
  f.usage.recordTurn({ sessionId: 'new-turn', principal: A, usage: { totalTokens: 777, basis: 'turn' } })
  const originalRow = { sequence: first.entries[0].sequence,
    sessionId: first.entries[0].sessionId, totalTokens: first.entries[0].usage.totalTokens }
  first.entries[0].usage.totalTokens = 99999
  // A cursor above the snapshot head includes its original first row. Reuse
  // that snapshot, rather than a fresh disk read which would hide corruption.
  const retained = await f.usage.usageAsync({ metrics: {
    ...continuation(first), before: first.metrics.head + 1,
  } })
  assert.equal(retained.ok, true)
  assert.equal(retained.metrics.snapshot, first.metrics.snapshot)
  const retainedRow = retained.entries.find(row => row.sequence === originalRow.sequence)
  assert.ok(retainedRow, 'the same snapshot must return the originally mutated row')
  assert.equal(retainedRow.sessionId, originalRow.sessionId)
  assert.equal(retainedRow.usage.totalTokens, originalRow.totalTokens,
    'changing a nested value in a reply must not change the retained snapshot')
  const rest = await f.usage.usageAsync({ metrics: continuation(first) })
  const concurrent = await f.usage.usageAsync({ metrics: continuation(second) })
  for (const read of [rest, concurrent]) {
    assert.equal(read.ok, true)
    assert.equal(read.metrics.count, 425)
    assert.equal(read.metrics.head, first.metrics.head)
    assert.equal(read.entries[0].sessionId, 'turn-224')
  }
  const refreshed = await readMetricsRecords({ agent: f.agent, window })
  assert.equal(refreshed.usage.turns.length, 426)
  assert.equal(refreshed.usage.turns.find(row => row.sessionId === 'new-turn').totalTokens, 777)
  assert.equal(refreshed.usage.turns.find(row => row.sessionId === 'turn-424').totalTokens, 425)
})

test('snapshot identity refuses another account, scope, window, head or unknown token', async t => {
  const f = fixture(t)
  const first = await f.usage.usageAsync({ metrics: query() })
  const original = continuation(first)
  for (const change of [{ principal: B }, { scope: 'computer' }, { fromMs: window.startMs + 1 },
    { toMs: window.endMs + 1 }, { head: first.metrics.head - 1 }, { snapshot: 'f'.repeat(32) },
    { snapshot: 'invalid' }, { before: undefined }]) {
    const refused = await f.usage.usageAsync({ metrics: { ...original, ...change } })
    assert.equal(refused.ok, false, JSON.stringify(change))
    assert.equal(refused.code, 'METRICS_SNAPSHOT_EXPIRED')
  }
  assert.equal((await f.usage.usageAsync({ metrics: original })).ok, true)
})

test('eviction and heap-cache release refuse continuations instead of mixing snapshots', async t => {
  const f = fixture(t)
  const recorder = createSpawnRecorder({ directory: f.directory, safeStorage: storage, ledgerFile: 'agent-turn-usage-records.jsonl' })
  const first = await recorder.historyAsync({ metrics: query() })
  await recorder.historyAsync({ metrics: query(B) })
  const third = await recorder.historyAsync({ metrics: query(A, 'computer') })
  assert.equal(recorder.cacheState().metrics, 2)
  assert.equal((await recorder.historyAsync({ metrics: continuation(first) })).code, 'METRICS_SNAPSHOT_EXPIRED')
  assert.ok(recorder.dropCaches() >= 2)
  assert.equal(recorder.cacheState().metrics, 0)
  assert.equal((await recorder.historyAsync({ metrics: continuation(third) })).code, 'METRICS_SNAPSHOT_EXPIRED')
  assert.equal((await recorder.historyAsync({ metrics: query() })).metrics.count, 425)
})

test('expired snapshots refuse and histories above either cache bound remain complete through legacy paging', async () => {
  const { createMetricsSnapshots, SNAPSHOT_TTL_MS, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ROWS } = await import('../../shell/metrics-record-snapshot.cjs')
  let clock = 0
  const cache = createMetricsSnapshots({ now: () => clock })
  const rows = Array.from({ length: MAX_SNAPSHOT_ROWS + 1 }, (_, i) => ({ sequence: i + 1,
    at: new Date(NOW).toISOString(), principal: A, sessionId: `r-${i}`, action: 'agent_turn_usage', usage: { totalTokens: i + 1 } }))
  const first = cache.first(rows.slice(0, 425), query(), 200, true, true, 100)
  clock = SNAPSHOT_TTL_MS
  assert.throws(() => cache.read(continuation(first), 200), { code: 'METRICS_SNAPSHOT_EXPIRED' })
  for (const [entries, bytes] of [[rows, 100], [rows.slice(0, 425), MAX_SNAPSHOT_BYTES + 1]]) {
    let before, head, read, total = 0
    do {
      read = cache.first(entries, { ...query(), ...(before ? { before, head } : {}) }, 200, true, true, bytes)
      assert.equal(read.metrics.snapshot, undefined)
      assert.equal(read.metrics.count, entries.length)
      total += read.entries.length
      before = read.metrics.nextBefore; head = read.metrics.head
    } while (before !== null)
    assert.equal(total, entries.length)
  }
})

test('fresh reads reverify changed bytes while an existing snapshot retains its original verdict', async t => {
  const f = fixture(t)
  const first = await f.usage.usageAsync({ metrics: query() })
  const original = fs.readFileSync(f.usage.ledgerPath, 'utf8')
  fs.writeFileSync(f.usage.ledgerPath, original.replace('"totalTokens":1,', '"totalTokens":9,'))
  assert.notEqual(fs.readFileSync(f.usage.ledgerPath, 'utf8'), original, 'tamper must change the fixture')
  assert.equal((await f.usage.usageAsync({ metrics: continuation(first) })).verified, true)
  assert.equal((await f.usage.usageAsync({ metrics: query() })).verified, false)
})

test('a legacy host still pages fully; switched or dropped snapshot identity never becomes complete', async () => {
  const entries = [2, 1].map(sequence => ({ sequence, at: new Date(NOW).toISOString(),
    sessionId: `legacy-${sequence}`, action: 'agent_turn_usage', usage: { totalTokens: sequence } }))
  async function read(identity) {
    let calls = 0
    return readMetricsRecords({ window, agent: { usage: async request => {
      const index = calls++
      assert.equal(request.metrics.snapshot, index ? identity[0] : undefined)
      return { ok: true, verified: true, entries: [entries[index]], metrics: { v: 1, ...query(),
        head: 2, count: 2, nextBefore: index ? null : 2,
        ...(identity[index] === undefined ? {} : { snapshot: identity[index] }) } }
    } } })
  }
  assert.equal((await read([undefined, undefined])).usage.turns.length, 2)
  assert.equal((await read(['a'.repeat(32), 'a'.repeat(32)])).usage.turns.length, 2)
  for (const next of [undefined, 'b'.repeat(32), 'invalid']) {
    assert.equal((await read(['a'.repeat(32), next])).usage.readable, false)
  }
})
