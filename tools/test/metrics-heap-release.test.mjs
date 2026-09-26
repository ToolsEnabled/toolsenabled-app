import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createUsageRecorder } from '../../shell/usage-record.cjs'
import { createSpawnRecorder } from '../../shell/spawn-record.cjs'
import { createHeapGuard } from '../../shell/heap-guard.cjs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const principal = `account:${'a'.repeat(32)}`
const time = Date.UTC(2026, 8, 23, 12)
const query = { principal, fromMs: time - 1000, toMs: time + 1000 }
const safeStorage = { isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() }
const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const inventorySource = declaredFunctionSource(main, 'heapGuardCaches')

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'metrics-heap-release-'))
  // Retained synthetic fixtures are deliberate; this suite never deletes files.
  t.after(() => t.diagnostic(`RETAINED_METRICS_HEAP ${directory}`))
  const options = { directory, safeStorage, now: () => new Date(time).toISOString() }
  const usage = createUsageRecorder(options), spawn = createSpawnRecorder(options)
  const sync = t.mock.method(fs, 'fsyncSync', () => {})
  try {
    for (let n = 0; n < 205; n++) {
      usage.recordTurn({ sessionId: `usage-${n}`, principal,
        usage: { totalTokens: n + 1, basis: 'turn' }, status: 'completed' })
      spawn.record({ action: 'agent_session_start', sessionId: `spawn-${n}`, principal, details: {} })
    }
  } finally { sync.mock.restore() }
  return { usage, spawn }
}

function inventory({ spawn = null, usage = null } = {}) {
  const dependencies = {
    spawnRecorder: spawn, usageRecorder: usage,
    getSpawnRecorder() { throw new Error('measurement must not construct a spawn recorder') },
    getUsageRecorder() { throw new Error('measurement must not construct a usage recorder') },
    treeNodeCommandBroker: { state: () => ({ queued: 3, known: 0 }), forgetKnownRequests: () => 0 },
    runningAgentCount: () => 2, localTreeCommands: new Map([['pending', {}]]),
    rendererPrefs: { snapshot: () => ({ values: {} }) },
  }
  return new Function(...Object.keys(dependencies), `return (${inventorySource})`)(...Object.values(dependencies))
}
const count = entry => typeof entry.size === 'function' ? entry.size() : entry.size
const next = page => ({ ...query, before: page.metrics.nextBefore,
  head: page.metrics.head, snapshot: page.metrics.snapshot })
const cached = recorder => Object.values(recorder.cacheState()).reduce((sum, value) => sum + value, 0)

async function allRows(read) {
  let page = await read({ metrics: query })
  const rows = []
  for (;;) {
    assert.equal(page.ok, true)
    rows.push(...page.entries)
    if (page.metrics.nextBefore === null) return rows
    page = await read({ metrics: next(page) })
  }
}

test('the public usage recorder releases retained snapshots and refreshes every saved token value', async t => {
  const { usage } = fixture(t)
  const first = await usage.usageAsync({ metrics: query })
  assert.equal(first.ok, true)
  assert.equal(first.metrics.count, 205)
  assert.equal(usage.cacheState().metrics, 1)
  assert.ok(usage.dropCaches() >= 1)
  assert.equal(usage.cacheState().metrics, 0)
  const refused = await usage.usageAsync({ metrics: next(first) })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'METRICS_SNAPSHOT_EXPIRED')
  const rows = await allRows(input => usage.usageAsync(input))
  assert.deepEqual(rows.map(row => row.usage.totalTokens).sort((a, b) => a - b),
    Array.from({ length: 205 }, (_, n) => n + 1))
})

test('main heap pressure releases both recorder snapshots and preserves live and queued work', async t => {
  const f = fixture(t)
  const spawnPage = await f.spawn.historyAsync({ metrics: query })
  const usagePage = await f.usage.usageAsync({ metrics: query })
  const caches = inventory(f), entries = caches()
  for (const [name, recorder] of [['spawnLedgerCaches', f.spawn], ['usageLedgerCaches', f.usage]]) {
    const entry = entries.find(row => row.name === name)
    assert.ok(entry, `${name} must be measurable and releasable`)
    assert.equal(count(entry), cached(recorder), `${name} must count its snapshots`)
  }
  const expected = cached(f.spawn) + cached(f.usage)
  const logs = []
  const guard = createHeapGuard({ memoryUsage: () => ({ heapUsed: 950, rss: 1200 }),
    heapStatistics: () => ({ heap_size_limit: 1000 }), caches, write: line => logs.push(line) })
  const result = guard.check()
  assert.equal(result.level, 'prune')
  assert.equal(result.pruned, expected)
  for (const recorder of [f.spawn, f.usage]) assert.equal(cached(recorder), 0)
  assert.equal((await f.spawn.historyAsync({ metrics: next(spawnPage) })).code, 'METRICS_SNAPSHOT_EXPIRED')
  assert.equal((await f.usage.usageAsync({ metrics: next(usagePage) })).code, 'METRICS_SNAPSHOT_EXPIRED')
  assert.equal((await allRows(input => f.spawn.historyAsync(input))).length, 205)
  assert.equal((await allRows(input => f.usage.usageAsync(input))).length, 205)
  for (const [name, size] of [['agentSessions', 2], ['localTreeCommands', 1], ['treeCommandQueue', 3]]) {
    const entry = caches().find(row => row.name === name)
    assert.equal(count(entry), size)
    assert.equal(entry.prune, undefined)
  }
  assert.ok(logs.some(line => line.includes('pruned usageLedgerCaches')))
})

test('heap measurement and pressure do not create lazy recorders', () => {
  const caches = inventory()
  for (const name of ['spawnLedgerCaches', 'usageLedgerCaches']) {
    const entry = caches().find(row => row.name === name)
    assert.ok(entry)
    assert.equal(count(entry), 0)
    assert.equal(entry.prune, undefined)
  }
  const guard = createHeapGuard({ memoryUsage: () => ({ heapUsed: 950 }),
    heapStatistics: () => ({ heap_size_limit: 1000 }), caches, write: () => {} })
  assert.equal(guard.check().pruned, 0)
})
