import test from 'node:test'
import assert from 'node:assert/strict'
import { readRuns, runBoardModel } from '../../src/research-runs.js'

const experimentId = 'rx-fixture'
const rows = Array.from({ length: 201 }, (_, index) => ({ runId: `rr-${index}`, experimentId, params: { index }, task: { status: 'succeeded' } }))
const page = (offset = 0) => ({ ok: true, receipt: { runs: structuredClone(rows.slice(offset, offset + 200)),
  pagination: { version: 1, experimentId, snapshot: 'rr-200', total: 201, offset, nextCursor: offset === 0 ? 'next-page' : null } } })

test('legacy responses without completeness metadata are refused even with a plausible run list', async () => {
  for (const runs of [[], rows.slice(0, 200)]) {
    const read = await readRuns(experimentId, { postAction: async () => ({ ok: true, receipt: { runs } }) })
    assert.equal(read.ok, false); assert.equal(read.code, 'RESEARCH_RUNS_INCOMPLETE')
    assert.equal(Object.hasOwn(read, 'runs'), false)
  }
})

test('a complete sequence uses the same experiment and returns every run only after the last page', async () => {
  const calls = []
  const result = await readRuns(experimentId, { postAction: async (action, body) => {
    calls.push({ action, body }); return page(body.cursor ? 200 : 0)
  } })
  assert.deepEqual(result, { ok: true, runs: rows })
  assert.deepEqual(calls, [
    { action: 'research-runs', body: { experimentId, limit: 200 } },
    { action: 'research-runs', body: { experimentId, limit: 200, cursor: 'next-page' } },
  ])
})

test('failed or malformed later pages never promote the first page to a complete cache/export input', async () => {
  const failure = { ok: false, code: 'RESEARCH_RUNS_CHANGED', reason: 'History changed' }
  const changes = [
    value => { value.receipt.pagination.total++ },
    value => { value.receipt.pagination.snapshot = 'another-snapshot' },
    value => { value.receipt.pagination.experimentId = 'another-experiment' },
    value => { value.receipt.pagination.offset = 0 },
    value => { value.receipt.pagination.nextCursor = 'next-page' },
    value => { value.receipt.runs[0].runId = rows[0].runId },
    value => { value.receipt.runs[0].experimentId = 'another-experiment' },
    value => { value.receipt.runs = [] },
    value => { delete value.receipt.pagination },
  ]
  for (const change of changes) {
    let calls = 0
    const read = await readRuns(experimentId, { postAction: async () => { calls++; const value = page(calls === 1 ? 0 : 200); if (calls === 2) change(value); return value } })
    assert.equal(read.ok, false); assert.equal(read.code, 'RESEARCH_RUNS_INCOMPLETE')
    assert.equal(Object.hasOwn(read, 'runs'), false); assert.equal(calls, 2)
    const old = [rows[0]], board = runBoardModel({ read, previousRuns: old })
    assert.equal(board.runs, old); assert.match(board.note, /could not be refreshed/)
  }
  for (const throws of [false, true]) {
    let calls = 0
    const read = await readRuns(experimentId, { postAction: async () => {
      if (++calls === 1) return page()
      if (throws) throw Error('transport unavailable')
      return failure
    } })
    assert.equal(read.ok, false); assert.equal(Object.hasOwn(read, 'runs'), false)
    if (!throws) assert.equal(read, failure)
  }
})

test('an early final page, unsafe declared total and empty nonfinal page are explicit failures', async () => {
  for (const change of [
    value => { value.receipt.pagination.nextCursor = null },
    value => { value.receipt.pagination.total = 100001 },
    value => { value.receipt.pagination.total = 1.5 },
    value => { value.receipt.runs = [] },
  ]) {
    const value = page(); change(value)
    const read = await readRuns(experimentId, { postAction: async () => value })
    assert.equal(read.ok, false); assert.equal(read.code, 'RESEARCH_RUNS_INCOMPLETE')
  }
})

test('the complete history budget admits exactly 64 MiB of UTF-8 across pages and refuses one extra byte', async () => {
  const maximum = 64 * 1024 * 1024
  const count = 201
  // Reuse one small string in 201 rows instead of retaining a 64 MiB fixture.
  // JSON adds only the measured ASCII row syntax: 漢 needs no escaping and
  // contributes three UTF-8 bytes for one JavaScript code unit.
  const base = Array.from({ length: count }, (_, index) => ({ runId: `budget-${index}`, experimentId, params: { note: '' } }))
  const syntaxBytes = Buffer.byteLength(JSON.stringify(base.slice(0, 200)), 'utf8')
    + Buffer.byteLength(JSON.stringify(base.slice(200)), 'utf8')
  const unitBytes = Buffer.byteLength('漢', 'utf8')
  assert.equal(unitBytes, 3)
  const repeats = Math.floor((maximum - syntaxBytes) / (count * unitBytes))
  const shared = '漢'.repeat(repeats)
  const padding = maximum - syntaxBytes - count * repeats * unitBytes
  for (const extra of [0, 1]) {
    const runs = base.map(run => ({ ...run, params: { note: shared } }))
    runs.at(-1).params.note += 'x'.repeat(padding + extra)
    assert.equal(syntaxBytes + count * Buffer.byteLength(shared, 'utf8') + padding + extra, maximum + extra)
    let calls = 0
    const result = await readRuns(experimentId, { postAction: async (_action, body) => {
      calls++
      const offset = body.cursor ? 200 : 0
      return { ok: true, receipt: { runs: runs.slice(offset, offset + 200),
        pagination: { version: 1, experimentId, snapshot: 'budget-snapshot', total: count, offset, nextCursor: offset === 0 ? 'budget-page-2' : null }
      } }
    } })
    assert.equal(calls, 2)
    assert.equal(result.ok, extra === 0, `UTF-8 payload bytes: ${maximum + extra}`)
    if (extra === 0) assert.deepEqual(result.runs, runs)
    else {
      assert.equal(result.code, 'RESEARCH_RUNS_INCOMPLETE')
      assert.equal(Object.hasOwn(result, 'runs'), false)
    }
  }
})
