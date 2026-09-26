import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_RESULT_SCHEMA,
  axisRowsToObject,
  cellBrief,
  cellLabel,
  columnRowsToSchema,
  gridCellCount,
  gridCells,
  gridRunPreview,
  parseAxes,
  parseResultSchema,
  parseRunner,
} from '../../src/research-grid.js'

/* The grid engine: axes × values as data, refusals as sentences, and no
   domain vocabulary anywhere in the machinery. */

test('axes parse into ordered cells, and every refusal is a sentence', () => {
  const parsed = parseAxes({ first: ['a', 'b'], second: ['1', '2', '3'] })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.cellCount, 6)
  const cells = gridCells(parsed.axes)
  assert.equal(cells.length, 6)
  assert.deepEqual(cells[0], { first: 'a', second: '1' })
  assert.deepEqual(cells.at(-1), { first: 'b', second: '3' })
  assert.equal(gridCellCount(parsed.axes), 6)

  assert.match(parseAxes(null).sentence, /object/)
  assert.match(parseAxes({}).sentence, /at least one axis/)
  assert.match(parseAxes({ 'Bad Name': ['x'] }).sentence, /cannot name an axis/)
  assert.match(parseAxes({ a: [] }).sentence, /at least one value/)
  assert.match(parseAxes({ a: ['x', 'x'] }).sentence, /repeats a value/)
  const four = parseAxes({ a: ['1'], b: ['1'], c: ['1'], d: ['1'] })
  assert.match(four.sentence, /at most 3 axes/)
})

test('the reserved axis names are refused with the reason', () => {
  assert.match(parseAxes({ replicate: ['1', '2'] }).sentence, /reserved for the repeat counter/)
  assert.match(parseAxes({ dataset: ['a'] }).sentence, /reserved for the dataset path token/)
  assert.equal(parseAxes({ tier: ['luna'] }).ok, true, 'tier is the reserved-meaning axis and stays legal')
})

test('replicates multiply cells and carry a replicate field', () => {
  const parsed = parseAxes({ a: ['x', 'y'] })
  const cells = gridCells(parsed.axes, { replicates: 3 })
  assert.equal(cells.length, 6)
  assert.deepEqual(cells[0], { a: 'x', replicate: 1 })
  assert.deepEqual(cells.at(-1), { a: 'y', replicate: 3 })
  assert.equal(cellLabel(parsed.axes, cells[0]), 'x · #1')
})

test('the oversized grid is refused by count, not truncated', () => {
  const wide = { a: Array.from({ length: 24 }, (_v, i) => `a${i}`), b: Array.from({ length: 24 }, (_v, i) => `b${i}`) }
  assert.match(parseAxes(wide).sentence, /576 cells/, 'the refusal states the size it measured')
})

test('runner declarations validate per kind', () => {
  assert.equal(parseRunner({ kind: 'agent', briefTemplate: 'Do {a}.' }).ok, true)
  assert.equal(parseRunner({ kind: 'process', command: 'node', args: ['-e', '1'] }).ok, true)
  assert.equal(parseRunner({ kind: 'http', url: 'https://example.test/x' }).ok, true)
  assert.match(parseRunner({ kind: 'http', url: 'http://example.test/x' }).sentence, /https/)
  assert.match(parseRunner({ kind: 'process' }).sentence, /command/)
  assert.match(parseRunner({ kind: 'agent' }).sentence, /brief/)
  assert.match(parseRunner({ kind: 'other' }).sentence, /agent, process, or http/)
})

test('result columns parse shallowly with a frozen default', () => {
  assert.equal(parseResultSchema(undefined).resultSchema, DEFAULT_RESULT_SCHEMA)
  const parsed = parseResultSchema({ fields: { score: 'number', label: 'string' }, required: ['score'] })
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.resultSchema.required, ['score'])
  assert.match(parseResultSchema({ fields: { score: 'float' } }).sentence, /string, number, or boolean/)
  assert.match(parseResultSchema({ fields: { score: 'number' }, required: ['missing'] }).sentence, /must be one of the declared fields/)
})

/* The designer's builders compose through these three, so what they hand the
   engine is exactly what the engine's own parsers accept or refuse. */

test('axis rows compose into the axes object; blank rows skip, half rows and collisions refuse', () => {
  const composed = axisRowsToObject([
    { name: ' style ', values: ' terse , full ' },
    { name: '', values: '' },
  ])
  assert.equal(composed.ok, true)
  assert.deepEqual(composed.axesRaw, { style: ['terse', 'full'] })
  assert.equal(parseAxes(composed.axesRaw).ok, true)

  assert.match(axisRowsToObject([{ name: '', values: 'a' }]).sentence, /no name/)
  assert.match(axisRowsToObject([{ name: 'a', values: 'x' }, { name: 'a', values: 'y' }]).sentence, /own name/,
    'an object key would silently swallow the second row; the refusal must name the collision')
  const named = axisRowsToObject([{ name: 'a', values: ' , ' }])
  assert.equal(named.ok, true)
  assert.match(parseAxes(named.axesRaw).sentence, /at least one value/,
    'a named row with no values falls through to the engine refusal, never a silent empty axis')
  assert.deepEqual(axisRowsToObject(undefined), { ok: true, axesRaw: {} })
})

test('column rows compose into the result shape, and no named rows means the standard columns', () => {
  const none = columnRowsToSchema([{ name: ' ', kind: 'number', required: true }])
  assert.equal(none.ok, true)
  assert.equal(none.schemaRaw, undefined)
  assert.equal(parseResultSchema(none.schemaRaw).resultSchema, DEFAULT_RESULT_SCHEMA)

  const composed = columnRowsToSchema([
    { name: ' score ', kind: 'number', required: true },
    { name: 'note', kind: 'string', required: false },
  ])
  assert.equal(composed.ok, true)
  assert.deepEqual(composed.schemaRaw, { fields: { score: 'number', note: 'string' }, required: ['score'] })
  assert.equal(parseResultSchema(composed.schemaRaw).ok, true)
  assert.match(columnRowsToSchema([{ name: 'score', kind: 'number' }, { name: 'score', kind: 'string' }]).sentence, /own name/)
})

test('the run preview counts repeats, labels the first cells, and passes a refusal through', () => {
  const model = gridRunPreview({ tier: ['luna'], style: ['terse', 'full'] }, { replicates: 2, limit: 3 })
  assert.equal(model.ok, true)
  assert.equal(model.runCount, 4)
  assert.deepEqual(model.labels, ['luna · terse · #1', 'luna · terse · #2', 'luna · full · #1'])
  assert.equal(model.more, 1)

  const single = gridRunPreview({ tier: ['luna'] })
  assert.equal(single.runCount, 1)
  assert.deepEqual(single.labels, ['luna'])
  assert.equal(single.more, 0)

  const refused = gridRunPreview({ replicate: ['1'] })
  assert.equal(refused.ok, false)
  assert.match(refused.sentence, /reserved for the repeat counter/,
    'the preview shows the engine sentence, so the person reads the problem before Save')
})

test('a brief substitutes every axis token and refuses an unknown one', () => {
  const built = cellBrief('Run {a} against {b}.', { a: 'x', b: 'y' })
  assert.equal(built.ok, true)
  assert.equal(built.text, 'Run x against y.')
  const missing = cellBrief('Run {c}.', { a: 'x' })
  assert.equal(missing.ok, false)
  assert.match(missing.sentence, /no axis called c/, 'an empty substitution is how a wrong brief runs quietly')
})
