import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  chartableColumn, chartableColumns, experimentExport, readResults, researchCsvCell,
  resultReadVersion, resultTableModel, resultsExport, runDrillModel, runEvidence, runInputChecks, runTaskDisplayStatus, runTaskStateWord,
} from '../../src/research-runs.js'
import { chartRows } from '../../src/research-result-charts.js'
import { cellsWithServiceStatus } from '../../src/research-experiments.js'

const schema = { fields: { score: 'number', status: 'string', okay: 'boolean' } }
const run = (id, params, evidenceStatus) => ({
  runId: id, experimentId: 'experiment-1', params, artifactDir: 'artifacts/attempt-2',
  task: { status: 'succeeded', attempt: 2, result: evidenceStatus ? { evidenceStatus, runnerKind: 'process' } : {} },
})
const modelFor = (runs, rows, resultSchema = schema) => resultTableModel({ runs, resultsByRun: new Map(rows), resultSchema })

// A small real CSV reader so assertions examine cells, not misleading commas
// inside a quoted source string or provenance object.
function csvRows(text) {
  const rows = [], row = []; let cell = '', quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i += 1 } else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(cell); cell = ''
      if (char === '\n') { rows.push([...row]); row.length = 0 }
    } else cell += char
  }
  row.push(cell); rows.push(row); return rows
}

test('a reported field cannot replace an identically named input, including an empty run row', () => {
  const runs = [run('one', { score: 5, status: 'input-status' }, 'collected'), run('empty', { score: 7, status: 'other-input' }, 'execution-only')]
  const model = modelFor(runs, [['one', [{ record: { score: 99, status: 'reported-status', okay: false } }]]])
  assert.deepEqual(model.columns, ['input:score', 'input:status', 'result:score', 'result:status', 'result:okay'])
  assert.deepEqual(model.rows[0].cells, [5, 'input-status', 99, 'reported-status', false])
  assert.deepEqual(model.rows[1].cells, [7, 'other-input', null, null, null])
  assert.ok(model.rows.every(row => row.cells.length === model.columns.length))
  assert.equal(runs[0].params.score, 5)
})

test('a missing reported number stays absent even when the input has that numeric name', () => {
  const model = modelFor([run('one', { score: 5 }, 'collected')], [['one', [{ record: { okay: true } }]]])
  assert.equal(model.rows[0].cells[1], null)
  assert.equal(chartableColumn(model, schema), null)
})

test('chart selection excludes non-finite values and labels a reported score with the true input score', () => {
  const runs = [run('bad', { score: 5 }), run('good', { score: 7 })]
  const model = modelFor(runs, [['bad', [{ record: { score: Infinity } }]], ['good', [{ record: { score: 12 } }]]])
  const column = chartableColumn(model, schema)
  assert.equal(column.index, 1)
  assert.deepEqual(chartRows(model, column), [{ label: '7', value: 12 }])
  for (const value of [NaN, Infinity, -Infinity, '5', null]) {
    const invalid = modelFor([runs[0]], [['bad', [{ record: { score: value } }]]])
    assert.deepEqual(chartableColumns(invalid, schema), [])
  }
})

test('JSON preserves typed inputs, complete results and the original provenance without metadata collisions', () => {
  const inputs = JSON.parse('{"runId":"axis-run","status":"axis-status","score":1,"__proto__":"axis-prototype"}')
  const record = { resultId: 'record-1', runId: 'real-run', recordKind: 'summary', recordHash: 'a'.repeat(64), artifactPath: 'attempt-2/out.json', createdAtMs: 42,
    record: { score: 11, status: '=reported', okay: false, extra: { list: [1, true, null] }, runId: 'reported-run' } }
  const model = modelFor([run('real-run', inputs, 'collected')], [['real-run', [record]]])
  const exported = JSON.parse(resultsExport(model, 'json'))
  const row = exported.rows[0]
  assert.equal(exported.version, 2)
  assert.equal(row.runId, 'real-run'); assert.equal(row.status, 'succeeded')
  assert.deepEqual(row.inputs, inputs); assert.deepEqual(row.result, record.record)
  assert.equal(row.evidenceStatus, 'collected')
  assert.equal(row.provenance.recordHash, record.recordHash)
  assert.equal(row.provenance.resultId, 'record-1')
  assert.equal(row.provenance.artifactPath, 'attempt-2/out.json')
  assert.equal(row.runProvenance.attempt, 2)
  assert.equal(row.runProvenance.artifactDir, 'artifacts/attempt-2')
  assert.deepEqual(row.taskResult, { evidenceStatus: 'collected', runnerKind: 'process' })
})

test('CSV has collision-free namespace headers, keeps true numeric values, and neutralizes formula text', () => {
  const model = modelFor([run('one', { status: '=SUM(1,2)', score: -2 }, 'collected')], [['one', [{ record: { score: -4, status: '  @unsafe', okay: false, extra: 'kept' }, recordHash: 'b'.repeat(64) }]]])
  const [header, values] = csvRows(resultsExport(model, 'csv'))
  assert.equal(header.length, new Set(header).size)
  assert.equal(header.length, values.length)
  const at = name => values[header.indexOf(name)]
  assert.equal(at('input:status'), "'=SUM(1,2)")
  assert.equal(at('result:status'), "'  @unsafe")
  assert.equal(at('input:score'), '-2'); assert.equal(at('result:score'), '-4')
  assert.equal(at('result:okay'), 'false')
  assert.equal(JSON.parse(at('meta:completeRecord')).extra, 'kept')
  assert.equal(JSON.parse(at('provenance:record')).recordHash, 'b'.repeat(64))
  for (const value of ['=1+1', '+SUM(A1)', '-2', '@SUM(A1)', ' \t=1', '\u00a0=1', '\ufeff@SUM(A1)', '\tplain', '\rplain', '\nplain']) {
    assert.equal(csvRows(researchCsvCell(value))[0][0], "'" + value)
  }
  assert.equal(csvRows(researchCsvCell('plain "quoted", words'))[0][0], 'plain "quoted", words')
})

test('malformed non-finite legacy numbers are explicit in JSON, not silently exported as null', () => {
  const model = modelFor([run('one', { score: 5 })], [['one', [{ record: { score: Infinity } }]]])
  assert.deepEqual(JSON.parse(resultsExport(model, 'json')).rows[0].result.score, { $researchNonFinite: 'Infinity' })
})

test('an unreadable result response survives the model/export instead of becoming a false zero-result claim', async () => {
  const refused = await readResults('one', { postAction: async () => ({ ok: false, reason: 'read timed out', code: 'TIMEOUT' }) })
  const model = modelFor([run('one', { score: 1 }, 'collected')], [['one', refused]])
  assert.match(model.rows[0].resultReadNote, /read timed out/)
  assert.equal(model.rows[0].result, null)
  assert.match(JSON.parse(resultsExport(model, 'json')).rows[0].resultReadNote, /read timed out/)
  const view = readFileSync(new URL('../../src/views/research.js', import.meta.url), 'utf8')
  assert.match(view, /resultsByRun\.get\(run\.runId\)\?\.ok === false/, 'a refused read must retry at the next refresh')
  assert.doesNotMatch(view, /resultsByRun\.set\(run\.runId, results\.ok === true \? results\.results : \[\]\)/)
  assert.match(view, /resultsRead\.ok !== true\) body\.dataset\.loaded = ''/)
})

test('dispatch, collection, execution and missing legacy evidence remain distinct on board and drill', () => {
  const cases = [
    ['dispatch-only', 'dispatched', /dispatched.*awaiting results/, /does not confirm/],
    ['collected', 'collected', /results collected/, /does not establish scientific validity/],
    ['execution-only', 'executed', /executed.*no collected results/, /No measured research result/],
    [undefined, 'unverified', /completed.*unverified/, /legacy records as unverified/],
    ['future-status', 'unverified', /completed.*unverified/, /no recognized evidence/],
  ]
  for (const [status, key, word, sentence] of cases) {
    const item = run('one', {}, status)
    assert.equal(runTaskDisplayStatus(item.task), key)
    assert.match(runTaskStateWord(item.task), word)
    assert.match(runDrillModel({ run: item }).evidence.sentence, sentence)
    const displayed = cellsWithServiceStatus({ cells: [{ runId:'one', status:'queued', params:{} }] }, [item])
    assert.equal(displayed[0].status, key)
    assert.equal(item.task.status, 'succeeded', 'presentation must not mutate durable status')
  }
  assert.equal(runEvidence({ result: { evidenceStatus:'scientifically-verified' } }).status, 'unverified')
  assert.equal(runTaskStateWord({ status:'failed', result:{evidenceStatus:'collected'} }), 'failed')
})

test('a cached result from an earlier attempt cannot masquerade as the retried run’s result', () => {
  const item = run('one', {score:1}, 'collected')
  const cached = {ok:true,results:[{record:{score:99}}],readVersion:resultReadVersion(item)}
  item.task.attempt += 1
  const model = modelFor([item], [['one',cached]])
  assert.equal(model.rows[0].result,null)
  assert.equal(model.rows[0].cells[1],null)
  assert.match(model.rows[0].resultReadNote,/waiting for a fresh result read/)
  const fresh = {...cached,readVersion:resultReadVersion(item)}
  assert.equal(modelFor([item],[['one',fresh]]).rows[0].result.score,99)
})

test('local session JSON also preserves axis names that collide with metadata and CSV is safe', () => {
  const experiment = { name:'local', axes:[{id:'status'},{id:'reply'}], cells:[{
    params:{status:'=formula', reply:'axis-reply', replicate:2}, status:'finished', startedAtMs:1, endedAtMs:2,
    replyExcerpt:'@result', runId:'r', sessionId:'s', nodeId:'n',
  }] }
  const row = JSON.parse(experimentExport(experiment,'json')).cells[0]
  assert.equal(row.inputs.status,'=formula'); assert.equal(row.inputs.reply,'axis-reply')
  assert.equal(row.status,'finished'); assert.equal(row.result.reply,'@result')
  assert.equal(row.provenance.sessionId,'s'); assert.equal(row.evidenceStatus,'unverified')
  const [headers, cells] = csvRows(experimentExport(experiment,'csv'))
  assert.equal(cells[headers.indexOf('input:status')],"'=formula")
  assert.equal(cells[headers.indexOf('result:reply')],"'@result")
  assert.equal(cells[headers.indexOf('provenance:sessionId')],'s')
})

function receiptRun() {
  const item = run('receipt-run', { provenance: 'input provenance', invocation: 'input invocation', runId: 'input id' }, 'collected')
  const files = [{ path: '/synthetic/input.txt', sha256: 'a'.repeat(64), bytes: 12 }]
  item.task.result.provenance = {
    version: 1, scope: 'declared-file-checks-at-process-boundaries', runId: item.runId,
    invocation: { command: '<synthetic-command>', args: ['=argument', '\u03bb'], cwd: item.artifactDir,
      stdin: { mode: 'params-json', bytes: 12, sha256: 'b'.repeat(64) },
      environmentKeys: ['SYNTHETIC_KEY'], environmentSha256: 'c'.repeat(64) },
    invocationSha256: 'd'.repeat(64), receiptSha256: 'e'.repeat(64),
    before: { startedAtMs: 1, checkedAtMs: 2, files }, after: { startedAtMs: 3, checkedAtMs: 4, files: structuredClone(files) },
  }
  return item
}

test('invocation receipts survive drill and both exports without colliding with input/result provenance fields', () => {
  const item = receiptRun(), receipt = structuredClone(item.task.result.provenance)
  const reported = { provenance: 'result provenance', invocation: 'result invocation', runId: 'result id' }
  const model = modelFor([item], [[item.runId, [{ record: reported, recordHash: 'f'.repeat(64) }]]], { fields: { provenance: 'string', invocation: 'string', runId: 'string' } })
  const exported = JSON.parse(resultsExport(model, 'json')).rows[0]
  assert.deepEqual(exported.inputs, item.params)
  assert.deepEqual(exported.result, reported)
  assert.equal(exported.provenance.recordHash, 'f'.repeat(64))
  assert.deepEqual(exported.taskResult.provenance, receipt)
  const [headers, cells] = csvRows(resultsExport(model, 'csv'))
  assert.equal(new Set(headers).size, headers.length)
  assert.deepEqual(JSON.parse(cells[headers.indexOf('provenance:taskResult')]).provenance, receipt)
  const drill = runDrillModel({ run: item })
  assert.deepEqual(JSON.parse(drill.inputReceiptText), receipt)
  assert.equal(drill.inputChecks.status, 'recorded')
  assert.equal(drill.evidence.status, 'collected', 'input checks never promote collection to scientific verification')
  assert.match(drill.inputChecks.sentence, /does not recheck files or authenticate/)
  assert.match(drill.inputChecks.sentence, /do not prove in-run immutability, a cleanroom, scientific validity or benchmark correctness/)
  assert.deepEqual(item.task.result.provenance, receipt)
})

test('missing, mismatched and unrecognized receipts are retained without a matching-input claim', () => {
  assert.equal(runInputChecks(run('old', {}, 'collected')).status, 'absent')
  for (const change of [
    receipt => { receipt.runId = 'another-run' },
    receipt => { receipt.invocation.cwd = 'earlier-attempt' },
    receipt => { receipt.scope = 'scientifically-verified' },
    receipt => { receipt.after.files[0].sha256 = '0'.repeat(64) },
    receipt => { receipt.before.files = [] },
    receipt => { receipt.after.startedAtMs = 1 },
    receipt => { delete receipt.invocation.environmentSha256 },
    receipt => { receipt.invocation.args = [4] },
    receipt => { delete receipt.invocation.stdin },
    receipt => { delete receipt.invocation },
  ]) {
    const item = receiptRun()
    change(item.task.result.provenance)
    assert.equal(runInputChecks(item).status, 'unrecognized')
    assert.deepEqual(JSON.parse(runDrillModel({ run: item }).inputReceiptText), item.task.result.provenance)
  }
  const dispatched = receiptRun()
  dispatched.task.result.runnerKind = 'agent'
  dispatched.task.result.evidenceStatus = 'dispatch-only'
  assert.equal(runInputChecks(dispatched).status, 'unrecognized')
  assert.equal(runEvidence(dispatched.task).status, 'dispatch-only')
})
