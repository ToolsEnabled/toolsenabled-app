// Run and result models for the research board: pure builders that merge what
// the research service answered into rows a renderer prints, without ever
// summarizing a failure into an empty table. The bridge-down case is CARRIED
// on the model as a sentence, not dropped — the board says it beside whatever
// local knowledge it still has.

import { postBridgeAction } from './mission-bridge.js'
import { MAX_PINNED_FILES } from './research-grid.js'

const RUN_STATE_WORD = Object.freeze({
  queued: 'queued',
  retry_wait: 'waiting to retry',
  leased: 'claimed',
  running: 'running',
  succeeded: 'finished',
  failed: 'failed',
  cancelled: 'cancelled',
  uncertain: 'uncertain',
  dispatched: 'dispatched · awaiting results',
  collected: 'results collected',
  executed: 'executed · no collected results',
  unverified: 'completed · unverified',
})

export function runStateWord(status) {
  return RUN_STATE_WORD[status] || String(status || 'unknown')
}

/**
 * The word for a run's task, which knows something the status alone does not:
 * a claimed or running task whose lease has expired is NOT running — nothing
 * holds it. The adversarial live review found the board saying "running" for a
 * run whose worker had been stopped for over an hour, next to "Run worker:
 * stopped." The service will reclaim it on the worker's next start, so the
 * honest word is "stalled" and the honest count is not "running".
 */
export function runTaskStateWord(task) {
  return runStateWord(runTaskDisplayStatus(task))
}

/** Queue completion is not the same fact as completed research. Old rows do
 * not gain evidence by being opened in a newer renderer. */
export function runEvidence(task) {
  const status = task?.result?.evidenceStatus
  if (status === 'dispatch-only') return {
    status, label: 'dispatch only',
    sentence: 'The agent was dispatched. This receipt does not confirm that the research finished or produced results.',
  }
  if (status === 'collected') return {
    status, label: 'records collected',
    sentence: 'Result records were collected and stored. Collection does not establish scientific validity or benchmark correctness.',
  }
  if (status === 'execution-only') return {
    status, label: 'execution only',
    sentence: 'The runner finished without result collection. No measured research result is established by this receipt.',
  }
  return {
    status: 'unverified', label: 'unverified',
    sentence: 'This run has no recognized evidence status. Treat its completion and any legacy records as unverified.',
  }
}

/** This is a presentation of a service receipt, not independent hash
 * verification. Keep that fact separate from collection/execution status. */
export function runInputChecks(run) {
  const receipt = run?.task?.result?.provenance ?? null
  if (receipt === null) return {
    status: 'absent', label: 'No input-check receipt', receipt: null,
    sentence: 'No pre/post input-check receipt was recorded for this attempt. Result collection alone does not establish input consistency.',
  }
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  const phase = value => value && Number.isSafeInteger(value.startedAtMs) && value.startedAtMs > 0
    && Number.isSafeInteger(value.checkedAtMs) && value.checkedAtMs >= value.startedAtMs
    && Array.isArray(value.files) && value.files.length > 0 && value.files.length <= MAX_PINNED_FILES
    && value.files.every(file => typeof file?.path === 'string' && digest(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0)
  const recognized = run?.task?.result?.runnerKind === 'process'
    && receipt.version === 1 && receipt.scope === 'declared-file-checks-at-process-boundaries'
    && typeof run?.artifactDir === 'string' && typeof run?.runId === 'string'
    && receipt.runId === run?.runId && receipt.invocation?.cwd === run?.artifactDir
    && typeof receipt.invocation?.command === 'string' && Array.isArray(receipt.invocation?.args)
    && receipt.invocation.args.every(arg => typeof arg === 'string')
    && ['none', 'params-json'].includes(receipt.invocation.stdin?.mode)
    && Number.isSafeInteger(receipt.invocation.stdin.bytes) && receipt.invocation.stdin.bytes >= 0 && digest(receipt.invocation.stdin.sha256)
    && Array.isArray(receipt.invocation.environmentKeys) && receipt.invocation.environmentKeys.every(key => typeof key === 'string')
    && digest(receipt.invocation.environmentSha256)
    && digest(receipt.invocationSha256) && digest(receipt.receiptSha256)
    && phase(receipt.before) && phase(receipt.after)
    && receipt.after.startedAtMs >= receipt.before.checkedAtMs
    && receipt.before.files.length === receipt.after.files.length
    && receipt.before.files.every((file, index) => ['path', 'sha256', 'bytes'].every(key => file[key] === receipt.after.files[index][key]))
  return {
    status: recognized ? 'recorded' : 'unrecognized', receipt,
    label: recognized ? 'Pre/post file-check receipt' : 'Unrecognized input-check receipt',
    sentence: recognized
      ? 'The service recorded matching declared file digests before and after the command. This view does not recheck files or authenticate receipt hashes. Boundary checks do not prove in-run immutability, a cleanroom, scientific validity or benchmark correctness.'
      : 'The stored input-check receipt is incomplete, unrecognized or bound to another run attempt. It is retained for inspection, not presented as matching input evidence.',
  }
}

export function runTaskDisplayStatus(task) {
  if (runTaskIsStalled(task)) return 'stalled'
  if (task?.status !== 'succeeded') return task?.status
  return ({ 'dispatch-only': 'dispatched', collected: 'collected', 'execution-only': 'executed' })[runEvidence(task).status] || 'unverified'
}

export function runTaskIsStalled(task) {
  /* leaseExpired is only ever true for a row the service stored as leased or
     running, so the flag alone is the whole test. The first version also
     required status to BE 'running' or 'leased' and therefore never fired:
     when a lease expires the service reports 'uncertain' (from running) or
     'expired' (from leased), not the stored word — so the board said
     "uncertain" at a person, and "stalled" appeared nowhere in the shipped
     app (measured on installed 1.0.11). */
  if (!task || task.leaseExpired !== true) return false
  // A finished run is finished however stale its lease record looks. The
  // service never sets the flag on a terminal row, so this only guards a
  // caller handing us a malformed one — cheap, and it keeps the word honest.
  return !runIsTerminal(task.status) && !runIsTerminal(task.storedStatus || task.status)
}

export function runIsTerminal(status) {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

/** Read complete membership for one experiment. Pages are never published as
 * a complete history; a failed/changed traversal preserves the caller's last
 * complete cache. Older services without completeness metadata are refused. */
export async function readRuns(experimentId, { postAction = postBridgeAction } = {}) {
  const runs = [], ids = new Set(), cursors = new Set()
  const limit = 200
  const encoder = new TextEncoder()
  let cursor, total, snapshot, bytes = 0
  const incomplete = reason => ({ ok: false, reason, code: 'RESEARCH_RUNS_INCOMPLETE' })
  for (;;) {
    let result
    try { result = await postAction('research-runs', { experimentId, limit, ...(cursor ? { cursor } : {}) }) }
    catch { return incomplete('The research history could not be completely read. Refresh it before exporting.') }
    if (result?.ok !== true) return result ?? { ok: false, reason: 'the research service did not answer' }
    const page = result.receipt?.runs, meta = result.receipt?.pagination
    if (!Array.isArray(page)) return { ok: false, reason: 'the research service answered without a run list', code: 'RESEARCH_RUNS_INVALID' }
    if (!meta || meta.version !== 1 || meta.experimentId !== experimentId
      || !Number.isSafeInteger(meta.total) || meta.total < 0 || meta.total > 100000
      || meta.offset !== runs.length || page.length !== Math.min(limit, meta.total - runs.length)
      || (meta.total === 0 ? meta.snapshot !== null : typeof meta.snapshot !== 'string' || !meta.snapshot)
      || (total !== undefined && (meta.total !== total || meta.snapshot !== snapshot))
      || (meta.nextCursor !== null && (typeof meta.nextCursor !== 'string' || !meta.nextCursor || meta.nextCursor.length > 1024 || cursors.has(meta.nextCursor)))
      || (meta.nextCursor === null) !== (runs.length + page.length === meta.total)) {
      return incomplete('The research service did not establish a complete, consistent run list. Refresh it with a current service before exporting.')
    }
    for (const run of page) {
      if (typeof run?.runId !== 'string' || !run.runId || run.experimentId !== experimentId || ids.has(run.runId)) {
        return incomplete('The research history page repeats or mismatches a run. No partial history was accepted.')
      }
      ids.add(run.runId)
    }
    bytes += encoder.encode(JSON.stringify(page)).byteLength
    if (bytes > 64 * 1024 * 1024) return incomplete('This research history exceeds the view’s safe read size. No partial history was accepted for export.')
    runs.push(...page); total = meta.total; snapshot = meta.snapshot
    if (meta.nextCursor === null) return { ok: true, runs }
    cursor = meta.nextCursor; cursors.add(cursor)
  }
}

/** The single-run drill read: carries the checkpoint body and artifact listing. */
export async function readRun(runId, { postAction = postBridgeAction } = {}) {
  const result = await postAction('research-runs', { runId })
  if (result?.ok !== true) return result ?? { ok: false, reason: 'the research service did not answer' }
  const run = Array.isArray(result.receipt?.runs) ? result.receipt.runs[0] : null
  if (!run) return { ok: false, reason: 'the research service has no run by that name', code: 'RESEARCH_RUN_NOT_FOUND' }
  return { ok: true, run }
}

export async function readResults(runId, { postAction = postBridgeAction } = {}) {
  const result = await postAction('research-results', { runId })
  if (result?.ok !== true) return result ?? { ok: false, reason: 'the research service did not answer' }
  const results = result.receipt?.results
  if (!Array.isArray(results)) return { ok: false, reason: 'the research service answered without results', code: 'RESEARCH_RESULTS_INVALID' }
  return { ok: true, results }
}

/**
 * Submit one run of a durable experiment. The full spec rides along on the
 * first submit (the service registers or matches it by configuration), so the
 * page needs no separate registration step.
 */
export async function submitRun({ experimentId, experiment, params }, { postAction = postBridgeAction } = {}) {
  const body = experimentId ? { experimentId, params } : { experiment, params }
  const result = await postAction('research-run-submit', body)
  if (result?.ok !== true) return result ?? { ok: false, reason: 'the submission did not reach the research service' }
  const receipt = result.receipt
  if (!receipt || !receipt.run || typeof receipt.run.runId !== 'string') {
    return { ok: false, reason: 'the research service accepted without returning the run', code: 'RESEARCH_RUN_RECEIPT_INVALID' }
  }
  return { ok: true, disposition: receipt.disposition, run: receipt.run, experiment: receipt.experiment }
}

/**
 * The board model for one experiment: each run with its plain state word, its
 * params, and timing. `note` carries the bridge refusal when the read failed;
 * the rows are then whatever was passed as the previous knowledge.
 */
export function runBoardModel({ read, previousRuns = [] }) {
  if (read?.ok !== true) {
    return {
      runs: previousRuns,
      note: `The run list could not be refreshed — ${read?.reason || 'the research service did not answer'}. Showing what this page last knew.`,
      terminal: previousRuns.every(run => runIsTerminal(run?.task?.status)),
    }
  }
  const runs = read.runs
  return {
    runs,
    note: null,
    terminal: runs.length > 0 && runs.every(run => runIsTerminal(run?.task?.status)),
  }
}

/**
 * The result table model: generic columns led by the run's params keys (the
 * grid axes), then the declared result fields, in declaration order. Numbers
 * stay numbers so an export or a chart can use them.
 */
export const resultReadVersion = run => JSON.stringify([run?.task?.attempt ?? null, run?.task?.status ?? null, run?.task?.completedAtMs ?? null])

export function resultTableModel({ runs, resultsByRun, resultSchema }) {
  const axisNames = []
  for (const run of runs) {
    for (const name of Object.keys(run?.params || {})) {
      if (!axisNames.includes(name)) axisNames.push(name)
    }
  }
  const fieldNames = Object.keys(resultSchema?.fields || {})
  const columnMeta = [
    ...axisNames.map(name => ({ id: `input:${name}`, name, kind: 'input', label: `${name} (input)` })),
    ...fieldNames.map(name => ({ id: `result:${name}`, name, kind: 'result', type: resultSchema.fields[name], label: `${name} (result)` })),
  ]
  const columns = columnMeta.map(column => column.id)
  const rows = []
  for (const run of runs) {
    const cached = resultsByRun.get(run.runId)
    const read = cached?.readVersion !== undefined && cached.readVersion !== resultReadVersion(run)
      ? { ok: false, reason: 'the run changed after these records were read; waiting for a fresh result read' } : cached
    const records = Array.isArray(read) ? read : read?.ok === true && Array.isArray(read.results) ? read.results : []
    const resultReadNote = read === undefined ? 'Result records have not been read yet.'
      : read?.ok === false ? `Results could not be read: ${read.reason || 'the research service did not answer'}.` : null
    const inputs = run?.params && typeof run.params === 'object' && !Array.isArray(run.params) ? { ...run.params } : {}
    const evidence = runEvidence(run?.task)
    for (const record of records.length ? records : [null]) {
      const payload = record?.record && typeof record.record === 'object' && !Array.isArray(record.record) ? record.record : null
      const provenance = record ? Object.fromEntries(Object.entries(record).filter(([name]) => name !== 'record')) : null
      rows.push({
        runId: run.runId,
        status: run?.task?.status || 'unknown',
        stateWord: runTaskStateWord(run?.task), evidence, inputChecks: runInputChecks(run), resultReadNote,
        inputs, result: payload, provenance,
        taskResult: run?.task?.result ?? null,
        runProvenance: { experimentId: run?.experimentId ?? null, artifactDir: run?.artifactDir ?? null, attempt: run?.task?.attempt ?? null, sessionRefKind: run?.sessionRefKind ?? null, sessionRef: run?.sessionRef ?? null },
        cells: columnMeta.map(column => {
          const source = column.kind === 'input' ? inputs : payload
          return source && Object.hasOwn(source, column.name) ? source[column.name] : null
        }),
      })
    }
  }
  return { columns, columnMeta, rows, axisNames }
}

// JSON cannot represent NaN/Infinity. Preserve malformed legacy values as an
// explicit tagged value, never silently turn them into an ordinary null.
const jsonValue = (_key, value) => typeof value === 'number' && !Number.isFinite(value)
  ? { $researchNonFinite: String(value) } : value
const jsonText = value => JSON.stringify(value, jsonValue)

/** Quoting alone does not neutralize a spreadsheet formula. Only strings are
 * prefixed: a real numeric -2 remains a number; JSON is the lossless typed copy. */
export function researchCsvCell(value) {
  let text = value === null || value === undefined ? ''
    : typeof value === 'object' ? jsonText(value) : String(value)
  if (typeof value === 'string' && (/^[\s\u0000-\u0020]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text
  return `"${text.replace(/"/g, '""')}"`
}

/** Versioned, separate inputs/results and retained provenance prevent a user
 * field named status/runId from overwriting report metadata. */
export function resultsExport(model, format) {
  const rows = model.rows.map(row => ({
    runId: row.runId, status: row.status, evidenceStatus: row.evidence?.status || 'unverified',
    inputs: row.inputs, result: row.result, provenance: row.provenance,
    taskResult: row.taskResult, runProvenance: row.runProvenance,
    resultReadNote: row.resultReadNote,
  }))
  if (format === 'json') {
    return JSON.stringify({ version: 2, columns: model.columnMeta, rows }, jsonValue, 2)
  }
  const lines = [['runId', 'status', 'evidenceStatus', ...model.columns, 'provenance:record', 'provenance:run', 'provenance:taskResult', 'meta:completeRecord', 'resultReadNote']]
  for (const row of model.rows) lines.push([row.runId, row.status, row.evidence?.status || 'unverified', ...row.cells, row.provenance, row.runProvenance, row.taskResult, row.result, row.resultReadNote])
  return lines.map(line => line.map(researchCsvCell).join(',')).join('\n')
}

/** The local session report obeys the same input/metadata and CSV boundaries. */
export function experimentExport(experiment, format) {
  const axisNames = experiment.axes.map(axis => axis.id)
  if (format === 'json') return JSON.stringify({ version: 2, name: experiment.name, cells: experiment.cells.map(cell => ({
    inputs: { ...cell.params }, status: cell.status,
    startedAtMs: cell.startedAtMs, endedAtMs: cell.endedAtMs,
    result: { reply: cell.replyExcerpt }, evidenceStatus: 'unverified',
    provenance: { runId: cell.runId ?? null, sessionId: cell.sessionId ?? null, nodeId: cell.nodeId ?? null },
  })) }, jsonValue, 2)
  const names = [...new Set([...axisNames, 'replicate'])]
  const rows = [[...names.map(name => `input:${name}`), 'status', 'evidenceStatus', 'startedAtMs', 'endedAtMs', 'result:reply', 'provenance:runId', 'provenance:sessionId', 'provenance:nodeId']]
  for (const cell of experiment.cells) rows.push([...names.map(name => cell.params[name] ?? (name === 'replicate' ? 1 : null)), cell.status, 'unverified', cell.startedAtMs, cell.endedAtMs, cell.replyExcerpt, cell.runId, cell.sessionId, cell.nodeId])
  return rows.map(row => row.map(researchCsvCell).join(',')).join('\n')
}

/**
 * The drill-in model for one run: everything a person opens a run to learn,
 * as plain words. `read` is the single-run service answer (which carries the
 * checkpoint body and the bounded artifact listing); `results` that run's
 * records. Absence is stated, never rendered as empty.
 */
export function runDrillModel({ run, results = [] }) {
  const checkpoint = run?.task?.latestCheckpoint?.checkpoint || null
  const artifacts = Array.isArray(run?.artifacts) ? run.artifacts : null
  return {
    runId: run?.runId || 'unknown',
    stateWord: runTaskStateWord(run?.task),
    evidence: runEvidence(run?.task),
    inputChecks: runInputChecks(run),
    inputReceiptText: run?.task?.result?.provenance === undefined ? null : JSON.stringify(run.task.result.provenance, jsonValue, 2),
    params: run?.params && typeof run.params === 'object' ? run.params : {},
    checkpointSummary: checkpoint && typeof checkpoint.summary === 'string' && checkpoint.summary.length > 0
      ? checkpoint.summary
      : 'No progress note has been written yet.',
    errorSentence: run?.task?.error
      ? `${run.task.error.message || 'It stopped without a message.'}`
      : null,
    artifacts,
    artifactsSentence: artifacts === null
      ? (run?.artifactsNote || 'The artifact folder has not been read.')
      : artifacts.length === 0
        ? 'The run has produced no files yet.'
        : `${artifacts.length} file${artifacts.length === 1 ? '' : 's'}${run?.artifactsTruncated ? ', showing the first fifty' : ''}.`,
    resultCount: results.length,
    artifactDir: typeof run?.artifactDir === 'string' ? run.artifactDir : null,
  }
}

/** Every declared numeric column with at least one number in the table. */
export function chartableColumns(model, resultSchema) {
  const numericNames = Object.entries(resultSchema?.fields || {})
    .filter(([, kind]) => kind === 'number').map(([name]) => name)
  const columns = []
  for (const name of numericNames) {
    const index = Array.isArray(model.columnMeta)
      ? model.columnMeta.findIndex(column => column.kind === 'result' && column.name === name)
      : model.columns.indexOf(name)
    if (index !== -1 && model.rows.some(row => typeof row.cells[index] === 'number' && Number.isFinite(row.cells[index]))) {
      columns.push({ name, index, label: model.columnMeta?.[index]?.label || name })
    }
  }
  return columns
}

/**
 * The default charted column. Axis parameters are inputs, not measurements —
 * charting one draws meaningless bars (measured on the 2026-08-15 stage:
 * the convergence grid charted "seed") — so the first numeric column that is
 * NOT an axis wins, and axes are only a last resort.
 */
export function chartableColumn(model, resultSchema, { axisIds } = {}) {
  const columns = chartableColumns(model, resultSchema)
  if (columns.length === 0) return null
  const axes = new Set(axisIds ?? model.axisNames ?? [])
  return columns.find(column => !axes.has(column.name)) || columns[0]
}
