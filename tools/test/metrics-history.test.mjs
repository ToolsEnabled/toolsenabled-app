import assert from 'node:assert/strict'
import test from 'node:test'
import { selectRunHistory, runHistoryCsv } from '../../src/metrics-history.js'

const rows = [
  { sequence: 4, atMs: 4000, agent: 'Research', asked: 'Review the evidence', result: 'started', resultWord: 'started' },
  { sequence: 3, atMs: 3000, agent: 'Build', why: 'Sign in before starting', result: 'refused', resultWord: 'did not start' },
  { sequence: 2, atMs: 2000, agent: 'Research', asked: 'Find a source', result: null, resultWord: '' },
  { sequence: 1, atMs: null, agent: '', result: null, resultWord: '' },
]

test('history composes search, outcome, and the chart window without changing its source rows', () => {
  const before = JSON.stringify(rows)
  const found = selectRunHistory(rows, { query: ' RESEARCH ', outcome: 'started', window: { startMs: 2000, endMs: 5000 } })
  assert.deepEqual(found.map(run => run.sequence), [4])
  assert.deepEqual(selectRunHistory(rows, { query: 'sign in' }).map(run => run.sequence), [3])
  assert.deepEqual(selectRunHistory(rows, { query: 'source' }).map(run => run.sequence), [2])
  assert.equal(JSON.stringify(rows), before)
})

test('history range boundaries include the first instant and exclude the next bucket and unknown times', () => {
  assert.deepEqual(selectRunHistory(rows, { window: { startMs: 2000, endMs: 4000 } }).map(run => run.sequence), [3, 2])
  assert.deepEqual(selectRunHistory(rows, { window: { startMs: 5000, endMs: 6000 } }), [])
})

test('missing outcomes are searchable and filterable without being treated as starts', () => {
  assert.deepEqual(selectRunHistory(rows, { outcome: 'unrecorded' }).map(run => run.sequence), [2, 1])
  assert.deepEqual(selectRunHistory(rows, { query: 'not recorded' }).map(run => run.sequence), [2, 1])
  assert.deepEqual(selectRunHistory(rows, { outcome: 'started' }).map(run => run.sequence), [4])
})

test('oldest-first ordering keeps unknown timestamps at the end and breaks ties by sequence', () => {
  assert.deepEqual(selectRunHistory(rows, { order: 'oldest' }).map(run => run.sequence), [2, 3, 4, 1])
  const ties = [{ ...rows[0], sequence: 5 }, rows[0]]
  assert.deepEqual(selectRunHistory(ties).map(run => run.sequence), [5, 4])
  assert.deepEqual(selectRunHistory(ties, { order: 'oldest' }).map(run => run.sequence), [4, 5])
})

test('CSV exports just the selected rows and explicitly identifies example data', () => {
  const csv = runHistoryCsv(selectRunHistory(rows, { outcome: 'refused' }), { example: true })
  assert.equal(csv.split('\r\n').length, 3)
  assert.match(csv, /"Build"/)
  assert.doesNotMatch(csv, /Research/)
  assert.match(csv, /"Example data"/)
  assert.match(runHistoryCsv(rows), /"Recorded activity"/)
})

test('CSV preserves Unicode, quotes and multiline text with Windows-friendly encoding and UTC timestamps', () => {
  const csv = runHistoryCsv([{ ...rows[0], agent: 'Renée, 東京', asked: 'Read "this"\nthen continue' }])
  assert.equal(csv.charCodeAt(0), 0xFEFF)
  assert.match(csv, /"Renée, 東京"/)
  assert.match(csv, /"Read ""this""\nthen continue"/)
  assert.match(csv, /"1970-01-01T00:00:04.000Z"/)
  assert.ok(csv.endsWith('\r\n'))
  assert.match(runHistoryCsv([rows[3]]), /"1","","","Not recorded"/)
})

test('spreadsheet formulas in recorded names or tasks remain text on export', () => {
  for (const input of ['=HYPERLINK("x")', '+SUM(1)', '-1+2', '@SUM(1)', '  =1+2', '\t=1+2', '\r=1+2']) {
    const csv = runHistoryCsv([{ ...rows[0], agent: input, asked: input }])
    assert.ok(csv.includes(`"'${input.replaceAll('"', '""')}"`), input)
  }
})
