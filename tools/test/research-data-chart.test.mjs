import test from 'node:test'
import assert from 'node:assert/strict'
import { chartTableData, chooseChartAxes } from '../../src/research-data-chart-model.mjs'

const fields = [{ name: 'station', type: 'string' }, { name: 'time', type: 'datetime' }, { name: 'reading', type: 'number' }]
const rows = [
  { values: ['North', '2026-01-01T12:01:00Z', 11] },
  { values: ['South', '2026-01-01T12:00:00Z', 300] },
  { values: ['North', '2026-01-01T12:00:00Z', 10] },
  { values: ['South', '2026-01-01T12:01:00Z', 301] },
]
const axes = { x: 1, y: 2, kind: 'line' }

test('mixed categories require an explicit decision before connecting rows', () => {
  const model = chartTableData(rows, fields, axes)
  assert.deepEqual(model.requiresSeries, ['station'])
  assert.equal(model.count, 0)
  assert.equal(chartTableData(rows, fields, { ...axes, kind: 'bar' }).count, 0)
})

test('chosen groups never connect different categories and each series sorts in UTC', () => {
  const model = chartTableData(rows, fields, { ...axes, series: 0 })
  assert.equal(model.count, 4)
  assert.deepEqual(model.groups, [
    { name: 'North', data: [[Date.parse('2026-01-01T12:00:00Z'), 10], [Date.parse('2026-01-01T12:01:00Z'), 11]] },
    { name: 'South', data: [[Date.parse('2026-01-01T12:00:00Z'), 300], [Date.parse('2026-01-01T12:01:00Z'), 301]] },
  ])
  assert.equal(rows[0].values[2], 11, 'source row order stays unchanged')
})

test('filtering to one category permits a line and explicit all-rows choice is respected', () => {
  assert.equal(chartTableData(rows.filter(row => row.values[0] === 'North'), fields, axes).count, 2)
  const combined = chartTableData(rows, fields, { ...axes, series: 'all' })
  assert.equal(combined.groups.length, 1)
  assert.equal(combined.count, 4)
  assert.equal(chartTableData(rows, fields, { ...axes, kind: 'scatter' }).count, 4)
})

test('grouping works with exact numeric identifiers without coercing missing data to zero', () => {
  const numericFields = [{ name: 'sample', type: 'integer' }, { name: 'step', type: 'integer' }, { name: 'value', type: 'number' }]
  const observations = [
    { values: [9007199254740992n, 1, 0] }, { values: [9007199254740993n, 1, 12] },
    { values: [null, 2, 8] }, { values: [9007199254740992n, 2, null] },
    { values: [9007199254740992n, 9007199254740993n, 9] }, { values: [9007199254740992n, NaN, 9] },
  ]
  const model = chartTableData(observations, numericFields, { x: 1, y: 2, series: 0 })
  assert.equal(model.count, 2)
  assert.deepEqual(model.groups.map(group => group.name), ['9007199254740992', '9007199254740993'])
  assert.deepEqual(model.groups[0].data, [[1, 0]])
})

// Axis defaults are chosen from the rows actually on the page. A column that
// holds one value there carries no information on an axis, whatever its
// position or declared type.
test('a datetime column with one distinct value on the page is not chosen as the X axis', () => {
  const fields = [{ name: 'snapshot_time', type: 'datetime' }, { name: 'underlying', type: 'string' }, { name: 'strike', type: 'number' }, { name: 'bid', type: 'number' }]
  const rows = [495, 500, 505, 758].map((strike, index) => ({ values: ['2026-08-23T18:12:00Z', 'QQQ', strike, 1.5 + index] }))
  const axes = chooseChartAxes(fields, rows)
  assert.notEqual(fields[axes.x].name, 'snapshot_time', 'one snapshot instant cannot separate the points')
  assert.equal(fields[axes.x].name, 'strike')
  assert.notEqual(axes.y, axes.x, 'a column cannot be plotted against itself')
  assert.equal(fields[axes.y].name, 'bid')
  const drawn = chartTableData(rows, fields, { x: axes.x, y: axes.y, series: 'all' })
  assert.equal(new Set(drawn.groups[0].data.map(point => point[0])).size, 4, 'the drawn chart is not a vertical line')
})

test('a datetime column that varies on the page is still preferred for the X axis', () => {
  const fields = [{ name: 'station', type: 'string' }, { name: 'time', type: 'datetime' }, { name: 'reading', type: 'number' }]
  const axes = chooseChartAxes(fields, rows)
  assert.equal(fields[axes.x].name, 'time')
  assert.equal(fields[axes.y].name, 'reading')
})

test('axis choice without measured rows, and with nothing that varies, stays defined rather than guessing', () => {
  const fields = [{ name: 'label', type: 'string' }, { name: 'time', type: 'datetime' }, { name: 'reading', type: 'number' }]
  assert.deepEqual(chooseChartAxes(fields, []), { x: 1, y: 2 }, 'with no rows read yet the declared types decide')
  const flat = [{ values: ['a', '2026-01-01T00:00:00Z', 5] }, { values: ['b', '2026-01-01T00:00:00Z', 5] }]
  const axes = chooseChartAxes(fields, flat)
  assert.equal(Number.isInteger(axes.x) && Number.isInteger(axes.y), true)
  assert.notEqual(axes.x, axes.y)
  assert.equal(chooseChartAxes([{ name: 'note', type: 'string' }], rows).y, -1, 'a table with no numeric column has no Y axis to offer')
})

test('a line that would join simultaneous records reports how many, and a clean series reports none', () => {
  // Builder 3's Option quotes shape: many contracts quoted at the same minute.
  const quoteFields = [{ name: 'contract', type: 'string' }, { name: 'quoted_at', type: 'datetime' }, { name: 'bid', type: 'number' }]
  const simultaneous = [
    { values: ['A', '2026-01-01T12:00:00Z', 1] }, { values: ['B', '2026-01-01T12:00:00Z', 2] },
    { values: ['C', '2026-01-01T12:00:00Z', 3] }, { values: ['D', '2026-01-01T12:01:00Z', 4] },
  ]
  const joined = chartTableData(simultaneous, quoteFields, { x: 1, y: 2, kind: 'line', series: 'all' })
  assert.equal(joined.count, 4, 'an explicit all-rows choice is still drawn, never silently refused')
  assert.equal(joined.sharedX, 3, 'the three records quoted at the same minute are counted')
  assert.equal(chartTableData(simultaneous, quoteFields, { x: 1, y: 2, kind: 'scatter', series: 'all' }).sharedX, 3, 'the measurement does not depend on the chart kind')
  assert.equal(chartTableData(rows, fields, { x: 1, y: 2, kind: 'line', series: 0 }).sharedX, 0, 'a properly grouped series shares no X and reports nothing')
})

// a different case and stays drawn.
test('the default chart refuses to connect records that share an X, and names the way out', () => {
  const plain = [{ name: 'time', type: 'datetime' }, { name: 'value', type: 'number' }]
  const collide = [
    { values: ['2026-01-01T12:00:00Z', 10] }, { values: ['2026-01-01T12:00:00Z', 300] },
    { values: ['2026-01-01T12:01:00Z', 11] }, { values: ['2026-01-01T12:01:00Z', 301] },
  ]
  const refused = chartTableData(collide, plain, { x: 0, y: 1, kind: 'line' })
  assert.equal(refused.count, 0, 'nothing is drawn rather than a line through simultaneous records')
  assert.equal(refused.requiresScatter, true)
  assert.equal(refused.sharedX, 4, 'the refusal says how many records collided')

  // A constant text column gives the grouping prompt nothing to catch, which is
  // exactly the hole this closes.
  const withVenue = [{ name: 'venue', type: 'string' }, ...plain]
  const constant = collide.map(row => ({ values: ['ACME', ...row.values] }))
  assert.equal(chartTableData(constant, withVenue, { x: 1, y: 2, kind: 'line' }).requiresScatter, true)

  // Scatter implies no order, so it draws; the explicit choice is still honoured.
  assert.equal(chartTableData(collide, plain, { x: 0, y: 1, kind: 'scatter' }).count, 4)
  assert.equal(chartTableData(collide, plain, { x: 0, y: 1, kind: 'line', series: 'all' }).count, 4)
  // A default chart with no collisions is unaffected.
  const clean = [{ values: ['2026-01-01T12:00:00Z', 10] }, { values: ['2026-01-01T12:01:00Z', 11] }]
  const drawn = chartTableData(clean, plain, { x: 0, y: 1, kind: 'line' })
  assert.equal(drawn.count, 2)
  assert.equal(drawn.requiresScatter, undefined)
})

// comparable footing without changing what the column measures.
test('comparing series by change from their own first point reveals movement a shared axis flattens', () => {
  const fields = [{ name: 'symbol', type: 'string' }, { name: 'time', type: 'datetime' }, { name: 'price', type: 'number' }]
  const rows = []
  for (const [symbol, start] of [['TSLA', 191.65], ['SPY', 400.1], ['IWM', 173.3]])
    for (let i = 0; i < 4; i++) rows.push({ values: [symbol, `2026-01-01T12:0${i}:00Z`, start + i * 0.4] })
  const axisSpan = model => { const all = model.groups.flatMap(g => g.data.map(p => p[1])); return Math.max(...all) - Math.min(...all) }

  const actual = chartTableData(rows, fields, { x: 1, y: 2, series: 0 })
  assert.ok(axisSpan(actual) > 200, 'the shared axis has to cover the gap between price levels')
  assert.equal(actual.compare, undefined, 'nothing is transformed unless it is asked for')

  const changed = chartTableData(rows, fields, { x: 1, y: 2, series: 0, compare: 'change' })
  assert.equal(changed.compare, 'change')
  assert.ok(axisSpan(changed) < 2, 'each series now shares a scale on which its own movement is visible')
  assert.equal(changed.count, actual.count, 'no record is dropped by comparing')
  for (const group of changed.groups) assert.equal(group.data[0][1], 0, 'every series starts from its own baseline')
  assert.deepEqual(changed.baselines.map(item => item.base), [191.65, 400.1, 173.3], 'what was subtracted is reported, never hidden')
  assert.deepEqual(changed.baselines.map(item => item.name), actual.groups.map(group => group.name))

  // Subtraction keeps units, so a zero or negative baseline is ordinary.
  const signed = [{ values: ['A', '2026-01-01T12:00:00Z', 0] }, { values: ['A', '2026-01-01T12:01:00Z', -5] }]
  const fromZero = chartTableData(signed, fields, { x: 1, y: 2, series: 0, compare: 'change' })
  assert.deepEqual(fromZero.groups[0].data.map(point => point[1]), [0, -5], 'a baseline of zero needs no exclusion')
  assert.equal(fromZero.baselines[0].base, 0)
})
