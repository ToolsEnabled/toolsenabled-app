import assert from 'node:assert/strict'
import test from 'node:test'
import { tokenComposition, usageAnalysis, selectUsageRows, usageRowsCsv, turnResult, metricShare } from '../../src/metrics-analysis.js'
import { readLocalUsage } from '../../src/local-metrics.js'
import { metricsPeriod } from '../../src/metrics-period.js'
import { liveWindow, tokenBands, routingFlows, turnsInWindow } from '../../src/metrics-live-charts.js'
import { sampleUsageRaw } from '../../src/sample-usage.js'

const NOW = Date.UTC(2026, 8, 8, 12)
const parse = async entries => readLocalUsage({ agent: { usage: async () => ({ ok: true, verified: true, entries:
  entries.map((usage, index) => ({ sequence: index + 1, at: new Date(NOW).toISOString(), sessionId: `session-${index}`, usage })) }) } })

test('rounding never presents incomplete coverage as 100% or a real share as 0%', () => {
  assert.equal(metricShare(99999 / 100000), '>99.9%')
  assert.equal(metricShare(1 / 100000), '<0.1%')
  assert.equal(metricShare(1), '100%')
  assert.equal(metricShare(0), '0%')
  assert.equal(metricShare(null), '—')
})

test('cache is counted once in both input conventions, with reasoning inside output', () => {
  const included = { input: 100, cachedInput: 70, cacheCreation: 10, output: 20, reasoning: 15, totalTokens: 120, inputBasis: 'includes-cache' }
  const excluded = { ...included, input: 20, inputBasis: 'excludes-cache' }
  const expected = { input: 20, read: 70, write: 10, output: 20 }
  assert.deepEqual(tokenComposition(included), expected)
  assert.deepEqual(tokenComposition(excluded), expected)
  assert.equal(tokenComposition({ ...included, totalTokens: 200 }), null, 'inconsistent reported parts are not forced to fit')
  assert.equal(tokenComposition({ ...included, cachedInput: 101 }), null, 'a cache subset cannot exceed its input')
  assert.equal(tokenComposition({ ...included, input: null }), null)
})

test('composition, cache denominator, and data coverage state exactly which turns support them', () => {
  const result = usageAnalysis([
    { input: 100, cachedInput: 70, cacheCreation: 10, output: 20, totalTokens: 120, inputBasis: 'includes-cache', reportedTotal: true },
    { input: 20, cachedInput: 70, cacheCreation: 10, output: 20, totalTokens: 120, inputBasis: 'excludes-cache', derivedTotal: true },
    { input: 30, cachedInput: null, output: 10, totalTokens: 40, reportedTotal: true },
    { input: null, output: null, totalTokens: 200, reportedTotal: true },
    { input: 10, output: null, totalTokens: null },
    { totalTokens: 9999, basis: 'session-total' },
  ])
  assert.deepEqual(result.parts, { input: 70, read: 140, write: 20, output: 50, unclassified: 200 })
  assert.equal(Object.values(result.parts).reduce((a, b) => a + b), 480)
  assert.equal(result.total, 480)
  assert.equal(result.composed, 3)
  assert.deepEqual(result.cache, { turns: 2, cached: 140, input: 200, share: .7 })
  assert.deepEqual([result.known, result.unknown, result.reported, result.derived], [4, 1, 3, 1])
})

test('an incomplete total stays unknown while reported totals and real zeroes survive', async () => {
  const reading = await parse([
    { inputTokens: 100, outputTokens: null, inputBasis: 'includes-cache' },
    { outputTokens: 50, inputTokens: null, cachedInputTokens: 20, inputBasis: 'excludes-cache' },
    { inputTokens: 0, outputTokens: 0 },
    { totalTokens: 150, inputTokens: null },
    { inputTokens: 100, outputTokens: 50, cachedInputTokens: 80, inputBasis: 'includes-cache' },
  ])
  assert.deepEqual(reading.turns.map(turn => turn.totalTokens), [null, null, 0, 150, 150])
  const analysis = usageAnalysis(reading.turns)
  assert.equal(analysis.total, 300)
  assert.equal(analysis.unknown, 2)
  assert.equal(analysis.median, 150)
})

test('distribution boundaries and percentiles use observed turns, including genuine zeroes', () => {
  const values = [0, 999, 1000, 4999, 5000, 19999, 20000, 49999, 50000, 99999, 100000]
  const analysis = usageAnalysis([...values.map(totalTokens => ({ totalTokens, reportedTotal: true })), { totalTokens: null }])
  assert.deepEqual(analysis.bins.map(bin => bin.count), [2, 2, 2, 2, 2, 1])
  assert.equal(analysis.median, 19999)
  assert.equal(analysis.p90, 99999)
  assert.equal(analysis.max, 100000)
  assert.equal(usageAnalysis([{ totalTokens: 2 }, { totalTokens: 5 }]).median, 3.5)
  assert.equal(usageAnalysis([]).p90, null)
  assert.equal(usageAnalysis([{ totalTokens: 0 }]).p90, 0)
})

test('histogram selections, result filters, and search select the same rows exported with exact source values', () => {
  const analysis = usageAnalysis([
    { sequence: 1, turnId: 'first', sessionId: 's', tier: 'luna', account: '=FORMULA()', atMs: NOW, totalTokens: 1000, input: null, output: 10, status: 'completed', reportedTotal: true },
    { sequence: 2, turnId: 'second', sessionId: 's', tier: 'claude-sonnet', atMs: NOW + 1, totalTokens: 5000, status: 'error', reportedTotal: true },
    { sequence: 3, turnId: 'third', sessionId: 's', atMs: NOW + 2, totalTokens: null, status: null },
  ], new Map([['s', { role: 'Build "α"' }]]))
  assert.deepEqual(selectUsageRows(analysis.rows, { size: 'medium' }).map(row => row.sequence), [1])
  assert.deepEqual(selectUsageRows(analysis.rows, { size: 'unknown' }).map(row => row.sequence), [3])
  assert.deepEqual(selectUsageRows(analysis.rows, { result: 'problem', query: 'sonnet' }).map(row => row.sequence), [2])
  assert.deepEqual(selectUsageRows(analysis.rows).map(row => row.sequence), [2, 1, 3])
  const csv = usageRowsCsv(selectUsageRows(analysis.rows, { size: 'medium' }), { example: true })
  assert.ok(csv.startsWith('\uFEFF'))
  assert.match(csv, /Build ""α""/)
  assert.match(csv, /'=FORMULA\(\)/)
  assert.match(csv, /"1000","Reported",""/)
  assert.match(csv, /Example data/)
  assert.equal(csv.split('\r\n').length, 3)
  assert.equal(turnResult('new-provider-status').key, 'unknown')
})

test('all period totals, model/sign-in rows, flows, histogram and composition reconcile against independently summed raw records', async () => {
  const entries = Array.from({ length: 360 }, (_, index) => {
    const inclusive = index % 2 === 0
    const input = index + 10, output = index % 13, cache = 5
    return { sequence: index + 1, at: new Date(NOW - index * 2 * 3600000).toISOString(), sessionId: `s-${Math.floor(index / 2)}`,
      usage: { inputTokens: input, outputTokens: output, cachedInputTokens: cache, cacheCreationInputTokens: 0,
        inputBasis: inclusive ? 'includes-cache' : 'excludes-cache', totalTokens: input + output + (inclusive ? 0 : cache),
        tier: inclusive ? 'luna' : 'claude-sonnet', account: inclusive ? 'seat-a' : 'seat-b', status: 'completed' } }
  })
  const usage = await readLocalUsage({ agent: { usage: async () => ({ ok: true, entries, verified: true }) } })
  const records = { sessions: { readable: true, supported: true, runs: [] }, usage }
  for (const range of ['24h', '7d', '30d']) {
    const window = liveWindow(range, NOW), period = metricsPeriod(records, window)
    const raw = entries.filter(entry => Date.parse(entry.at) >= window.startMs && Date.parse(entry.at) < window.endMs)
    const expected = raw.reduce((sum, entry) => sum + entry.usage.totalTokens, 0)
    const analysis = usageAnalysis(period.turns)
    assert.equal(period.tokens, expected)
    assert.equal(tokenBands(usage.turns, window).total, expected)
    assert.equal(routingFlows(turnsInWindow(usage.turns, window)).total, expected)
    for (const group of [period.local.usage.byAccount, period.local.usage.byModel]) assert.equal(group.rows.reduce((sum, row) => sum + row.tokens, 0), expected)
    assert.equal(analysis.total, expected)
    assert.equal(Object.values(analysis.parts).reduce((a, b) => a + b), expected)
    assert.equal(analysis.parts.unclassified, 0)
    assert.equal(analysis.bins.reduce((sum, bin) => sum + bin.count, 0), raw.length)
  }
})

test('built-in example totals never double-count cache or reasoning', async () => {
  const raw = sampleUsageRaw(NOW)
  for (const { usage } of raw.entries.filter(entry => entry.usage.basis === 'turn')) {
    if (usage.totalTokens == null) continue
    let expected = usage.inputTokens + usage.outputTokens
    if (usage.inputBasis === 'excludes-cache') expected += (usage.cachedInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
    assert.equal(usage.totalTokens, expected, usage.turnId)
  }
  const usage = await readLocalUsage({ agent: { usage: async () => raw } })
  const analysis = usageAnalysis(usage.turns)
  assert.equal(analysis.parts.unclassified, 0)
})

test('a zero-token period still draws the measured timeline and keeps unknown turns separate', async () => {
  const usage = await parse([{ totalTokens: 0, status: 'error' }, { inputTokens: 10, status: 'error' }])
  const bands = tokenBands(usage.turns, liveWindow('24h', NOW))
  assert.equal(bands.ok, true)
  assert.equal(bands.total, 0)
  assert.equal(usageAnalysis(usage.turns).unknown, 1)
})

test('an audit-off reading is never worded as a read fault in a quiet Metrics panel', async () => {
  const { readLocalSessions } = await import('../../src/local-activity.js')
  const { quietRecordNote, AUDIT_OFF_PANEL_NOTE } = await import('../../src/metrics-analysis.js')
  assert.equal(typeof quietRecordNote, 'function', 'quiet Metrics panels need one audit-off wording rule')
  // The exact answer the host gives while Signed activity audit is off (Basic default).
  const off = { ok: false, code: 'AUDIT_NOT_ENABLED', reason: 'Activity auditing is off; saved history is preserved.' }
  const usage = await readLocalUsage({ agent: { usage: async () => off } })
  const sessions = readLocalSessions(off)
  for (const reading of [usage, sessions]) {
    assert.equal(reading.disabled, true)
    assert.equal(reading.readable, false)
    for (const fault of ['Usage records could not be read. Try Refresh data.', 'Token records could not be read.', 'Turn results could not be read.', 'Start records could not be read.']) {
      const said = quietRecordNote(reading, fault)
      assert.equal(said, AUDIT_OFF_PANEL_NOTE)
      assert.doesNotMatch(said, /could not|cannot|unreadable|failed|stale|Try Refresh/i)
    }
  }
  // A genuine read fault keeps its own sentence.
  const broken = await readLocalUsage({ agent: { usage: async () => ({ ok: false, code: 'LEDGER_UNREADABLE' }) } })
  assert.equal(broken.disabled, false)
  assert.equal(quietRecordNote(broken, 'Token records could not be read.'), 'Token records could not be read.')
  assert.equal(quietRecordNote(null, 'x'), 'x')
})

test('every quiet Metrics panel asks whether auditing is off before it words an unreadable record as a fault', async () => {
  const { readFileSync } = await import('node:fs')
  const source = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
  const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const [file, sentences] of [
    ['../../src/metrics-analysis-panels.js', ['Usage records could not be read. Try Refresh data.']],
    ['../../src/views/metrics.js', ['Start records could not be read.', 'Token records could not be read.', 'Turn results could not be read.']],
  ]) {
    const text = source(file)
    for (const sentence of sentences) {
      const written = text.match(new RegExp(`'${escaped(sentence)}'`, 'g')) || []
      const routed = text.match(new RegExp(`quietRecordNote\\([^()]*, '${escaped(sentence)}'\\)`, 'g')) || []
      assert.ok(written.length > 0, `${file} no longer carries: ${sentence}`)
      assert.equal(routed.length, written.length, `${file} words an unreadable record as "${sentence}" without asking whether auditing is off`)
    }
  }
  assert.match(source('../../src/views/metrics.js'),
    /const runsWindowAbsence = \(\) => \{\s*if \(!records\?\.sessions\?\.readable\) return records\?\.sessions\?\.disabled === true \? LOCAL_METRICS_COPY\.disabled : LOCAL_METRICS_COPY\.unreadable/,
    'the Run activity panel must say auditing is off rather than that the record could not be opened')
})
