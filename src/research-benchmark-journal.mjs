// Page-only helpers for the Research page. This file is never a runtime file: nothing here is pinned
// into a frozen project, and nothing here computes a result. It puts the steps of a benchmark run in
// front of a person: what the frozen project will send and grade, when the retained journal ran and
// on what runtime, why each trial ended as it did, and what the native verification receipt checked.
// Every value is read from a field the frozen project, the attempt journal, the analysis summary or
// the receipt already retains; a field that is absent prints "Not declared" (never frozen) or
// "Unavailable" (frozen, but not recorded by this journal). Saved replay responses and credential
// values are never rendered.
import { canonical } from './benchmark/prompts.mjs'

export const NOT_DECLARED = 'Not declared'
export const UNAVAILABLE = 'Unavailable'
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const declared = value => value === undefined || value === null || value === '' ? NOT_DECLARED : String(value)
const IMAGE_DIGEST = /@sha256:[a-f0-9]{64}$/

export function scheduleRows(project) {
  return (project?.schedule || []).map(row => ({ trial: row.id, task: row.taskId, condition: row.conditionId, replicate: row.replicate }))
}

// The same target the exported report prints: a command line, a URL or a module file, never a
// credential. Replay conditions have no target; their saved responses are evidence, not configuration.
export function adapterTarget(adapter) {
  if (!adapter) return NOT_DECLARED
  if (adapter.kind === 'replay') return 'Saved responses; no provider call'
  if (adapter.kind === 'command') return [adapter.command, ...(adapter.args || [])].join(' ')
  if (adapter.kind === 'http') return declared(adapter.url)
  if (adapter.kind === 'module') return declared(adapter.file)
  return NOT_DECLARED
}

export function conditionRows(project) {
  return (project?.spec?.conditions || []).map(condition => ({
    id: condition.id, label: condition.label || '',
    provider: declared(condition.model?.provider), model: declared(condition.model?.id), surface: declared(condition.model?.surface),
    adapter: declared(condition.adapter?.kind), target: adapterTarget(condition.adapter),
    // Names of environment variables the adapter may read, never their values.
    environment: Array.isArray(condition.adapter?.env) && condition.adapter.env.length ? condition.adapter.env.join(', ') : 'none',
    credential: condition.adapter?.credentialEnv || 'none',
    settings: canonical(condition.model?.settings || {}),
    workflow: condition.workflowId || 'none',
  }))
}

export function apparatusRows(project) {
  const spec = project.spec, protocol = spec.protocol || {}, grading = protocol.grading || {}, environment = spec.environment || {}
  const rows = [
    ['Schedule', `${(project.tasks || []).length} tasks × ${(spec.conditions || []).length} conditions × ${declared(protocol.replicates)} replicates = ${(project.schedule || []).length} trials`],
    ['Execution purpose', spec.executionPlan?.purpose || 'legacy (no execution plan)'],
    ['Seed', declared(protocol.seed)],
    ['Replicates', declared(protocol.replicates)],
    ['Attempts per trial', declared(protocol.maxAttemptsPerTrial)],
    ['Attempts overall', declared(protocol.maxTotalAttempts)],
    ['Attempt timeout ms', declared(protocol.timeoutMs)],
    ['Study duration budget ms', declared(protocol.maxDurationMs)],
    ['Selection', declared(protocol.selection)],
    ['Stopping', declared(protocol.stopping)],
    ['Grading', declared(grading.kind)],
  ]
  if (grading.kind === 'lean-python') {
    const image = environment.leanImage || ''
    rows.push(['Engine execution timeout ms', declared(grading.executionTimeoutMs)],
      ['Pinned engine image', declared(image)],
      ['Image pinned by digest', IMAGE_DIGEST.test(image) ? 'yes' : 'no'],
      // The container flags and mounts are constants of the pinned grader, not values this journal
      // measures per attempt; naming the pinned digest tells the reader exactly which contract applied.
      ['Native execution contract', spec.runtimeSources?.['lean-grade.mjs']
        ? `lean-grade.mjs pinned at SHA-256 ${spec.runtimeSources['lean-grade.mjs']}; its container flags and mounts are listed in the exported report, not measured per attempt`
        : NOT_DECLARED])
  }
  rows.push(['Node requirement', declared(environment.node)],
    ['Python requirement', declared(environment.python)],
    ['Declared dependencies', Array.isArray(environment.dependencies) ? (environment.dependencies.length ? environment.dependencies.join(', ') : 'none') : NOT_DECLARED],
    ['Bundle reviews required to freeze', spec.requireReview ? 'yes' : 'no'],
    ['Runtime pins', spec.runtimeSources ? `${Object.keys(spec.runtimeSources).length} files` : NOT_DECLARED])
  return rows
}

export function runtimePinRows(project) {
  return Object.entries(project?.spec?.runtimeSources || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

// The journal's own account of when it ran: started events carry a clock time, finished events
// carry only an elapsed time, so the end of an attempt is its start plus its elapsed milliseconds
// and the row says so. Nothing here is a measurement of the study's total wall-clock time.
export function runHeaderRows(project, events, summary) {
  const list = Array.isArray(events) ? events : []
  const started = list.filter(event => event?.type === 'started'), finished = list.filter(event => event?.type === 'finished')
  const starts = started.map(event => Date.parse(event.at)).filter(Number.isFinite)
  const ends = []
  for (const event of finished) {
    const start = started.find(row => row.trialId === event.trialId && row.attempt === event.attempt)
    const at = start ? Date.parse(start.at) : NaN
    if (Number.isFinite(at) && Number.isFinite(event.elapsedMs)) ends.push(at + event.elapsedMs)
  }
  const first = starts.length ? Math.min(...starts) : null, last = ends.length ? Math.max(...ends) : null
  // The exported runner records Node's process facts; a page run records the renderer's
  // user agent and platform. Each is shown as recorded; any other shape is shown verbatim.
  const runtime = [...new Set(started.map(event => !event.runtime ? null
    : event.runtime.node ? `node ${event.runtime.node} on ${event.runtime.platform}/${event.runtime.architecture}`
    : event.runtime.userAgent ? `${event.runtime.host || 'page'}: ${event.runtime.userAgent}${event.runtime.platform ? ' on ' + event.runtime.platform : ''}`
    : JSON.stringify(event.runtime)).filter(Boolean))]
  const readiness = [...new Set(started.map(event => event.readinessSha256).filter(Boolean))]
  const purposes = [...new Set(started.map(event => event.executionPurpose).filter(Boolean))]
  const execution = summary?.execution || {}
  const count = value => (Number.isFinite(value) ? String(value) : UNAVAILABLE)
  return [
    ['Frozen project SHA-256', declared(project?.sha256)],
    ['Execution purpose', execution.purpose || purposes.join(', ') || 'legacy'],
    ['Evidence class', declared(execution.evidenceClass)],
    ['Experimental collection', declared(execution.experimentalCollection)],
    ['Journal events', String(list.length)],
    ['Trials', `${count(summary?.scheduled)} scheduled · ${count(summary?.completed)} completed · ${count(summary?.failed)} failed · ${count(summary?.interrupted)} interrupted · ${count(summary?.pending)} pending`],
    ['Attempts', count(summary?.attempts)],
    ['First attempt started', iso(first) ?? UNAVAILABLE],
    ['Last attempt ended (start plus elapsed)', iso(last) ?? UNAVAILABLE],
    ['Journal span ms', first !== null && last !== null ? String(Math.max(0, last - first)) : UNAVAILABLE],
    ['Runtime', runtime.length ? runtime.join(' ; ') : UNAVAILABLE],
    ['Readiness contract', readiness.length ? readiness.join(' ; ') : UNAVAILABLE],
    ['Purpose recorded per attempt', purposes.length ? purposes.join(', ') : UNAVAILABLE],
  ]
}

// Why each scheduled trial ended as it did, per condition: the same rows the exported report's
// dispositions table prints, in the summary's own order.
export function dispositionRows(summary) {
  return (summary?.groups || []).flatMap(group => Object.entries(group.dispositions || {}).map(([disposition, trials]) => ({ condition: group.condition, disposition, trials })))
}

export function nativeVerificationRows(receipt) {
  const attempts = (receipt?.attempts || []).map(row => {
    const grade = row.reconstructedGrade
    const gradeText = grade ? `${declared(grade.classification)} (${grade.passed ? 'passed' : 'failed'})${grade.reason ? ': ' + grade.reason : ''}` : UNAVAILABLE
    return { trial: row.trialId, attempt: row.attempt, disposition: declared(row.disposition), evidenceStatus: declared(row.evidenceStatus), grade: gradeText,
      candidateSha256: row.candidateSha256 || UNAVAILABLE, responseSha256: row.responseSha256 || UNAVAILABLE,
      artifactFiles: Object.keys(row.artifactFileHashes || {}).length, sourceFiles: Object.keys(row.sourceFileHashes || {}).length }
  })
  const header = [
    ['Receipt', `${declared(receipt?.format)} version ${declared(receipt?.version)}`],
    ['Evidence status', declared(receipt?.evidenceStatus)],
    ['Scope', declared(receipt?.scope)],
    ['Project SHA-256', declared(receipt?.projectSha256)],
    ['Receipt journal SHA-256', declared(receipt?.journalSha256)],
    ['Retained files SHA-256', declared(receipt?.filesSha256)],
    ['Attempts checked', String(attempts.length)],
  ]
  return { header, attempts, limitations: Array.isArray(receipt?.limitations) ? receipt.limitations : [] }
}

const table = (hook, caption, head, body) => `<div class="bench-table-scroll" tabindex="0" role="region" aria-label="${esc(caption)}"><table ${hook}><caption>${esc(caption)}</caption><thead><tr>${head.map(cell => `<th>${esc(cell)}</th>`).join('')}</tr></thead><tbody>${body.map(cells => `<tr>${cells.map((cell, index) => (index === 0 ? `<th>${esc(cell)}</th>` : `<td>${esc(cell)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div>`
const pairs = (hook, caption, rows) => table(hook, caption, ['Field', 'Value'], rows)

export function frozenInspectionMarkup(project) {
  if (!project) return ''
  const pins = runtimePinRows(project)
  return `<section data-bench-journal-frozen aria-label="Frozen project inspection"><h3>Frozen project inspection</h3><p>What this frozen project will send and grade, read from the frozen specification itself. Saved replay responses and credential values are never shown here.</p>`
    + pairs('data-bench-journal-apparatus', 'Protocol and apparatus', apparatusRows(project))
    + table('data-bench-journal-conditions', 'Conditions as frozen', ['Condition', 'Label', 'Provider', 'Declared model', 'Surface', 'Adapter', 'Target', 'Environment variables (names)', 'Credential variable', 'Settings', 'Workflow'],
      conditionRows(project).map(row => [row.id, row.label, row.provider, row.model, row.surface, row.adapter, row.target, row.environment, row.credential, row.settings, row.workflow]))
    + table('data-bench-journal-schedule', 'Frozen schedule', ['Trial', 'Task', 'Condition', 'Replicate'], scheduleRows(project).map(row => [row.trial, row.task, row.condition, String(row.replicate)]))
    + `<details><summary>Runtime pins (${pins.length} files)</summary>` + table('data-bench-journal-pins', 'Pinned runtime files', ['Runtime file', 'SHA-256'], pins) + '</details></section>'
}

export function runJournalMarkup(project, events, summary) {
  return `<section data-bench-journal-run aria-label="Run journal"><h4>Run journal</h4><p>When the retained journal ran and on what runtime, read from its events, and why each trial ended as it did, per condition. Finished events carry no clock time, so an attempt's end is its start plus its elapsed time.</p>`
    + pairs('data-bench-journal-run-header', 'Run header', runHeaderRows(project, events, summary))
    + table('data-bench-journal-dispositions', 'Trial dispositions by condition', ['Condition', 'Disposition', 'Trials'], dispositionRows(summary).map(row => [row.condition, row.disposition, String(row.trials)]))
    + '</section>'
}

export function nativeVerificationMarkup(receipt) {
  if (!receipt) return ''
  const view = nativeVerificationRows(receipt)
  return `<section data-bench-journal-native aria-label="Native verification receipt"><h4>Native verification receipt</h4>`
    + pairs('data-bench-journal-native-receipt', 'Receipt', view.header)
    + `<h5>Limitations stated by the receipt</h5><ul>${view.limitations.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`
    + table('data-bench-journal-native-attempts', 'Attempts checked against retained artifacts', ['Trial', 'Attempt', 'Disposition', 'Evidence status', 'Reconstructed grade', 'Candidate SHA-256', 'Response SHA-256', 'Artifact files hashed', 'Source files hashed'],
      view.attempts.map(row => [row.trial, String(row.attempt), row.disposition, row.evidenceStatus, row.grade, row.candidateSha256, row.responseSha256, String(row.artifactFiles), String(row.sourceFiles)]))
    + '</section>'
}
