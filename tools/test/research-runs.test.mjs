import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chartableColumn,
  readRun,
  readRuns,
  resultTableModel,
  resultsExport,
  runBoardModel,
  runDrillModel,
  runIsTerminal,
  runStateWord,
  submitRun,
} from '../../src/research-runs.js'
import { chartRows } from '../../src/research-result-charts.js'

/* The board models: bridge-down is carried as a sentence beside the last
   knowledge, tables are generic axis-led columns, numbers stay numbers. */

const RUN = (id, status, params, extras = {}) => ({
  runId: id, params, task: { status }, ...extras,
})

test('state words are plain and terminality is exact', () => {
  assert.equal(runStateWord('retry_wait'), 'waiting to retry')
  assert.equal(runStateWord('succeeded'), 'finished')
  assert.equal(runStateWord('something_new'), 'something_new')
  assert.equal(runIsTerminal('succeeded'), true)
  assert.equal(runIsTerminal('retry_wait'), false)
})

test('a failed refresh keeps the last knowledge and says why', () => {
  const previous = [RUN('rr-1', 'running', { a: 'x' })]
  const model = runBoardModel({ read: { ok: false, reason: 'action bridge timed out' }, previousRuns: previous })
  assert.equal(model.runs, previous)
  assert.match(model.note, /could not be refreshed/)
  assert.match(model.note, /action bridge timed out/)
  const fresh = runBoardModel({ read: { ok: true, runs: [RUN('rr-1', 'succeeded', { a: 'x' })] } })
  assert.equal(fresh.note, null)
  assert.equal(fresh.terminal, true)
})

test('the result table leads with axis columns and keeps numbers numeric', () => {
  const runs = [
    RUN('rr-1', 'succeeded', { model_axis: 'm1', effort: 'low' }),
    RUN('rr-2', 'failed', { model_axis: 'm2', effort: 'high' }),
  ]
  const resultsByRun = new Map([
    ['rr-1', [{ record: { score: 0.81, label: 'pass' } }]],
  ])
  const schema = { fields: { score: 'number', label: 'string' }, required: [] }
  const model = resultTableModel({ runs, resultsByRun, resultSchema: schema })
  assert.deepEqual(model.columns, ['input:model_axis', 'input:effort', 'result:score', 'result:label'])
  assert.equal(model.rows.length, 2)
  assert.equal(model.rows[0].cells[2], 0.81, 'the number is a number, not text')
  assert.equal(model.rows[1].cells[2], null, 'a run without results shows absence, not zero')

  const chart = chartableColumn(model, schema)
  assert.equal(chart.name, 'score')

  const csv = resultsExport(model, 'csv')
  assert.match(csv.split('\n')[0], /runId.*status.*model_axis.*effort.*score.*label/)
  const json = JSON.parse(resultsExport(model, 'json'))
  assert.equal(json.version, 2)
  assert.equal(json.rows[0].result.score, 0.81)
  assert.equal(json.rows[0].inputs.model_axis, 'm1')
})

test('reads pass the bridge envelope through and validate shape', async () => {
  const refused = await readRuns('rx-1', { postAction: async () => ({ ok: false, reason: 'down', code: 'BRIDGE_UNREACHABLE' }) })
  assert.equal(refused.code, 'BRIDGE_UNREACHABLE')
  const hollow = await readRuns('rx-1', { postAction: async () => ({ ok: true, receipt: {} }) })
  assert.equal(hollow.code, 'RESEARCH_RUNS_INVALID')
  const good = await readRuns('rx-1', { postAction: async (action, body) => {
    assert.equal(action, 'research-runs')
    assert.equal(body.experimentId, 'rx-1')
    return { ok: true, receipt: { runs: [], pagination: { version: 1, experimentId: 'rx-1', snapshot: null, total: 0, offset: 0, nextCursor: null } } }
  } })
  assert.equal(good.ok, true)
})

test('the drill model states every absence instead of rendering it empty', () => {
  const bare = runDrillModel({ run: { runId: 'rr-1', params: { a: 'x' }, task: { status: 'queued' } } })
  assert.equal(bare.stateWord, 'queued')
  assert.match(bare.checkpointSummary, /No progress note/)
  assert.match(bare.artifactsSentence, /has not been read/)
  assert.equal(bare.errorSentence, null)

  const full = runDrillModel({
    run: {
      runId: 'rr-2', params: { a: 'x' }, artifactDir: 'state/research/p/e/rr-2',
      artifacts: [{ name: 'out.json', bytes: 7 }], artifactsTruncated: false,
      task: { status: 'failed', error: { code: 'RESEARCH_RUN_TIMEOUT', message: 'The declared command exceeded its limit and was stopped.' }, latestCheckpoint: { checkpoint: { summary: 'Runner finished; collecting results.' } } },
    },
    results: [{ record: { n: 1 } }],
  })
  assert.equal(full.checkpointSummary, 'Runner finished; collecting results.')
  assert.match(full.errorSentence, /exceeded its limit/)
  assert.match(full.artifactsSentence, /1 file\./)
  assert.equal(full.resultCount, 1)

  const unreadable = runDrillModel({ run: { runId: 'rr-3', params: {}, artifacts: null, artifactsNote: 'The artifact folder could not be read from here.', task: { status: 'succeeded' } } })
  assert.match(unreadable.artifactsSentence, /could not be read/)
})

test('readRun unwraps the single-run read and names an absent run', async () => {
  const good = await readRun('rr-9', { postAction: async (action, body) => {
    assert.equal(body.runId, 'rr-9')
    return { ok: true, receipt: { runs: [{ runId: 'rr-9' }] } }
  } })
  assert.equal(good.run.runId, 'rr-9')
  const missing = await readRun('rr-0', { postAction: async () => ({ ok: true, receipt: { runs: [] } }) })
  assert.equal(missing.code, 'RESEARCH_RUN_NOT_FOUND')
})

test('chartRows plots only real numbers and labels bars by the other columns', () => {
  const model = {
    columns: ['axis_a', 'score'],
    rows: [
      { runId: 'rr-1', status: 'succeeded', cells: ['x', 0.5] },
      { runId: 'rr-2', status: 'succeeded', cells: ['y', null] },
      { runId: 'rr-3', status: 'succeeded', cells: ['z', 0.9] },
    ],
  }
  const rows = chartRows(model, { name: 'score', index: 1 })
  assert.equal(rows.length, 2, 'a row without a number is not plotted as zero')
  assert.deepEqual(rows[0], { label: 'x', value: 0.5 })
  assert.deepEqual(rows[1], { label: 'z', value: 0.9 })
})

test('submitRun carries the inline spec on first submit and returns the durable run', async () => {
  const submitted = await submitRun({
    experiment: { projectId: 'rp-1', name: 'grid', runnerKind: 'process', runnerConfig: {}, resultSchema: {}, collector: {} },
    params: { a: 'x' },
  }, {
    postAction: async (action, body) => {
      assert.equal(action, 'research-run-submit')
      assert.equal(body.experiment.name, 'grid')
      assert.equal(body.experimentId, undefined, 'either the id or the spec rides, never both')
      return { ok: true, receipt: { disposition: 'submitted', run: { runId: 'rr-9' }, experiment: { experimentId: 'rx-9' } } }
    },
  })
  assert.equal(submitted.ok, true)
  assert.equal(submitted.run.runId, 'rr-9')
  const hollow = await submitRun({ experimentId: 'rx-9', params: {} }, { postAction: async () => ({ ok: true, receipt: {} }) })
  assert.equal(hollow.code, 'RESEARCH_RUN_RECEIPT_INVALID')
})

test('the default chart skips axis columns; the person can chart any numeric column', async () => {
  const { chartableColumns } = await import('../../src/research-runs.js')
  // The 2026-08-15 stage measured this: seed and n are grid axes AND declared
  // numeric result fields, so declaration order charted "seed" — an input.
  const runs = [
    RUN('rr-1', 'succeeded', { seed: 11, n: 100 }),
    RUN('rr-2', 'succeeded', { seed: 11, n: 1000 }),
  ]
  const resultsByRun = new Map([
    ['rr-1', [{ record: { seed: 11, n: 100, mean: 0.49, sd_of_mean: 0.029 } }]],
    ['rr-2', [{ record: { seed: 11, n: 1000, mean: 0.5, sd_of_mean: 0.009 } }]],
  ])
  const schema = { fields: { seed: 'number', n: 'number', mean: 'number', sd_of_mean: 'number' }, required: [] }
  const model = resultTableModel({ runs, resultsByRun, resultSchema: schema })
  assert.deepEqual(model.axisNames, ['seed', 'n'], 'the model names its axis columns')

  const chart = chartableColumn(model, schema)
  assert.equal(chart.name, 'mean', 'the first NON-AXIS numeric column is the default, not "seed"')

  const all = chartableColumns(model, schema)
  assert.deepEqual(all.map(column => column.name), ['seed', 'n', 'mean', 'sd_of_mean'],
    'every numeric column with data stays choosable')

  const axesOnly = resultTableModel({ runs, resultsByRun: new Map([['rr-1', [{ record: { seed: 11, n: 100 } }]]]), resultSchema: { fields: { seed: 'number', n: 'number' }, required: [] } })
  assert.equal(chartableColumn(axesOnly, { fields: { seed: 'number', n: 'number' }, required: [] }).name, 'seed',
    'when only axes are numeric, the first still charts rather than nothing')

  const view = (await import('node:fs')).readFileSync(new URL('../../src/views/research.js', import.meta.url), 'utf8')
  assert.match(view, /data-chart-column/, 'the gathered panel lost its chart column picker')
  assert.match(view, /mountGatheredChart\(columns\.find/, 'the picker no longer remounts the chart on change')
})

test('a task whose lease expired reads stalled, not running', async () => {
  const { runTaskStateWord, runTaskIsStalled } = await import('../../src/research-runs.js')
  // The adversarial live review found the board saying "running" for this exact
  // shape while the run board also said "Run worker: stopped."
  assert.equal(runTaskStateWord({ status: 'running', leaseExpired: true }), 'stalled')
  assert.equal(runTaskStateWord({ status: 'leased', leaseExpired: true }), 'stalled')
  assert.equal(runTaskIsStalled({ status: 'running', leaseExpired: true }), true)
  // The service REPLACES the word when a lease dies: a stored 'running' is
  // reported 'uncertain' and a stored 'leased' is reported 'expired'. Keying
  // on the reported word meant the check never fired and a person read
  // "uncertain" (installed 1.0.11). The flag alone decides.
  assert.equal(runTaskStateWord({ status: 'uncertain', leaseExpired: true, storedStatus: 'running' }), 'stalled')
  assert.equal(runTaskStateWord({ status: 'expired', leaseExpired: true, storedStatus: 'leased' }), 'stalled')
  assert.equal(runTaskIsStalled({ status: 'uncertain', leaseExpired: true }), true)
  assert.equal(runTaskStateWord({ status: 'uncertain', leaseExpired: false }), 'uncertain',
    'an uncertain run with a LIVE lease is not stalled')
  // A live lease is not stalled, and a terminal state never is.
  assert.equal(runTaskStateWord({ status: 'running', leaseExpired: false }), 'running')
  assert.equal(runTaskStateWord({ status: 'leased', leaseExpired: false }), 'claimed')
  assert.equal(runTaskStateWord({ status: 'succeeded', leaseExpired: true }), 'completed · unverified',
    'a terminal run is not stalled, but missing evidence is never upgraded to a verified result')
  assert.equal(runTaskStateWord({ status: 'queued' }), 'queued')
  assert.equal(runTaskIsStalled(null), false)
  assert.equal(runDrillModel({ run: { task: { status: 'running', leaseExpired: true } } }).stateWord, 'stalled',
    'the drill must not contradict the board')

  const view = (await import('node:fs')).readFileSync(new URL('../../src/views/research.js', import.meta.url), 'utf8')
  const pulse = view.slice(view.indexOf('function renderStatusPulse'))
  assert.match(pulse, /lastKnownPulse/, 'the pulse no longer remembers what it last read whole')
  assert.match(pulse, /could not be read just now/, 'the pulse must name an unreadable service instead of counting for it')
  assert.match(pulse, /if \(queuedThrough && !serviceRead\) unread \+= 1/,
    'queue-dispatched cells with no service read must count as unread, never as queued')
  assert.match(pulse, /runTaskIsStalled\(run\?\.task\)/, 'the pulse counts a stalled run as running again')
})

test('chart bars are labelled by axes only, never by another measurement', () => {
  // Installed-build measurement 2026-08-15: charting `mean` printed the
  // sd_of_mean value beside each bar, so the number next to a bar was not the
  // bar's number. Labels come from the axes; other measurements stay out.
  const model = {
    columns: ['seed', 'n', 'mean', 'sd_of_mean'],
    axisNames: ['seed', 'n'],
    rows: [
      { runId: 'rr-1', status: 'succeeded', cells: [47, 10000, 0.5012, 0.00288] },
      { runId: 'rr-2', status: 'succeeded', cells: [11, 100, 0.4903, 0.0291] },
    ],
  }
  const rows = chartRows(model, { name: 'mean', index: 2 })
  assert.deepEqual(rows, [
    { label: '47 · 10000', value: 0.5012 },
    { label: '11 · 100', value: 0.4903 },
  ], 'the label is the axes; sd_of_mean must not appear beside a mean bar')

  const bySd = chartRows(model, { name: 'sd_of_mean', index: 3 })
  assert.deepEqual(bySd.map(row => row.label), ['47 · 10000', '11 · 100'],
    'the same axis label whichever measurement is charted')
  assert.deepEqual(bySd.map(row => row.value), [0.00288, 0.0291])

  // A model with no declared axes keeps the old labelling rather than losing it.
  const legacy = { columns: ['axis_a', 'score'], rows: [{ runId: 'rr-3', status: 'succeeded', cells: ['x', 0.5] }] }
  assert.deepEqual(chartRows(legacy, { name: 'score', index: 1 }), [{ label: 'x', value: 0.5 }])
})
