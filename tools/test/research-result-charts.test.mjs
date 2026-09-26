import test from 'node:test'
import assert from 'node:assert/strict'

import { chartRows, createResultChart } from '../../src/research-result-charts.js'

test('chart rows use the declared axes and keep measurements out of labels', () => {
  const model = {
    columns: ['dataset', 'samples', 'mean', 'margin'],
    axisNames: ['dataset', 'samples'],
    rows: [
      { runId: 'run-1', cells: ['alpha', 100, 0.42, 0.03] },
      { runId: 'run-2', cells: ['beta', 200, 0, 0.01] },
    ],
  }

  assert.deepEqual(
    chartRows(model, { name: 'mean', index: 2 }),
    [
      { label: 'alpha · 100', value: 0.42 },
      { label: 'beta · 200', value: 0 },
    ],
    'chart labels must contain only axis values while preserving a numeric zero',
  )
})

test('unreadable and non-numeric results never become definite chart values', () => {
  const model = {
    columns: ['case', 'score'],
    axisNames: ['case'],
    rows: [
      { runId: 'missing', cells: ['missing', undefined] },
      { runId: 'null', cells: ['null', null] },
      { runId: 'text', cells: ['text', '0.75'] },
      { runId: 'nan', cells: ['nan', Number.NaN] },
      { runId: 'infinite', cells: ['infinite', Number.POSITIVE_INFINITY] },
    ],
  }
  const column = { name: 'score', index: 1 }

  assert.deepEqual(
    chartRows(model, column),
    [],
    'unknown, malformed, and non-finite readings must not be plotted as definite answers',
  )
  assert.equal(
    createResultChart({}, { model, column }),
    null,
    'a result set with no readable finite number must decline to mount a chart',
  )
})

test('legacy result models retain useful labels and fall back to the run id', () => {
  const model = {
    columns: ['case', 'score'],
    rows: [
      { runId: 'run-named-by-axis', cells: ['gamma', 3] },
      { runId: 'run-fallback', cells: [null, 4] },
    ],
  }

  assert.deepEqual(
    chartRows(model, { name: 'score', index: 1 }),
    [
      { label: 'gamma', value: 3 },
      { label: 'run-fallback', value: 4 },
    ],
    'models without axis metadata must use other columns, then the run id, as labels',
  )
})
