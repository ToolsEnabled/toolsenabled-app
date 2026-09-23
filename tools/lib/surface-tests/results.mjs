import { validateJourneys } from './journeys.mjs'

const HOSTED_CASES = [
  'chromium-390x844', 'chromium-844x390', 'chromium-320x568', 'chromium-568x320',
  'webkit-390x844', 'webkit-844x390', 'webkit-320x568', 'webkit-568x320',
]

export function resultStatus(job, result, evidence, validateCompletion) {
  if (result.cleanupConfirmed !== true) return { status: 'FAIL', reason: 'Child/descendant shutdown is unconfirmed', stop: true, ...(job.kind === 'driver' && evidence ? { evidence } : {}) }
  if (job.journeys && evidence?.cleanupConfirmed !== true) return { status: 'FAIL', reason: 'Browser cleanup is unconfirmed', stop: true, evidence }
  if (result.error || result.signal || result.status !== 0) return { status: 'FAIL', reason: result.error?.code || result.signal || `exit ${result.status}`, ...(job.kind === 'driver' && evidence ? { evidence } : {}) }
  if (job.kind === 'engine') {
    const rows = evidence?.files
    if (!Array.isArray(rows) || rows.length !== job.files.length ||
        new Set(rows.map(row => row.file)).size !== rows.length || job.files.some(file => !rows.some(row => row.file === file)))
      return { status: 'FAIL', reason: 'Engine summary is incomplete or reports different files' }
    if (rows.some(row => row.status !== 'pass' || row.exitCode !== 0 || row.process?.exitCode !== 0 || row.process?.signal || row.process?.error ||
        !['process-exit', 'reconciled-tap'].includes(row.evidence?.kind) || row.evidence?.unexecuted > 0 ||
        (row.evidence.kind === 'reconciled-tap' && (!Number.isSafeInteger(row.evidence.counts?.tests) || row.evidence.counts.tests < 1 ||
          row.evidence.counts.pass !== row.evidence.counts.tests || row.evidence.counts.fail !== 0))))
      return { status: 'FAIL', reason: 'Engine summary contains failures/skips/unexecuted checks', evidence }
    return { status: 'PASS', evidence }
  }
  if (job.kind === 'tap') {
    try {
      const proof = validateCompletion(result)
      if (proof.kind !== 'reconciled-tap' || proof.unexecuted !== 0 || !Number.isSafeInteger(proof.counts?.tests) || proof.counts.tests < 1 ||
          proof.counts.pass !== proof.counts.tests || proof.counts.fail !== 0) throw Error('TAP must reconcile with positive checks and no skipped tests')
      return { status: 'PASS', evidence: proof }
    } catch (error) { return { status: 'FAIL', reason: error.message } }
  }
  if (job.id === 'packaged') return { status: 'PASS', evidence: { kind: 'existing-packaged-qa-exit-contract', scope: 'Selected drivers only; inspect log for instrumented-copy proof, not native release certification.' } }
  if (!evidence || evidence.ok !== true || !Number.isSafeInteger(evidence.tests) || evidence.tests < 1 || evidence.failed !== 0 ||
      !Array.isArray(evidence.checks) || evidence.checks.length !== evidence.tests || evidence.checks.some(check => check.ok !== true))
    return { status: 'FAIL', reason: 'Driver did not produce positive complete check evidence', ...(evidence ? { evidence } : {}) }
  if (job.id === 'hosted') {
    const requested = evidence.requestedCases
    const rows = evidence.results
    const completeCases = Array.isArray(requested) && requested.length === HOSTED_CASES.length &&
      requested.every((label, index) => label === HOSTED_CASES[index]) &&
      Array.isArray(rows) && rows.length === HOSTED_CASES.length &&
      rows.every((row, index) => row?.label === HOSTED_CASES[index] && row.ok === true && row.failed === 0 &&
        Number.isSafeInteger(row.passed) && Array.isArray(row.checks) && row.checks.length > 0 &&
        row.passed === row.checks.length && row.checks.every(check => check?.ok === true) &&
        Array.isArray(row.errors) && row.errors.length === 0 && Array.isArray(row.blocked) && row.blocked.length === 0)
    const passed = completeCases ? rows.reduce((total, row) => total + row.passed, 0) : null
    const startedAt = Date.parse(evidence.startedAt)
    const finishedAt = Date.parse(evidence.finishedAt)
    if (!completeCases || passed !== evidence.tests || !Number.isSafeInteger(evidence.passed) || evidence.passed !== evidence.tests ||
        !Array.isArray(evidence.errors) || evidence.errors.length !== 0 ||
        typeof evidence.startedAt !== 'string' || typeof evidence.finishedAt !== 'string' ||
        !Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt)
      return { status: 'FAIL', reason: 'Hosted summary is incomplete or contains unverified cases', evidence }
  }
  if (job.journeys) {
    if (!Array.isArray(evidence.cases) || evidence.cases.length !== job.caseLabels?.length ||
        evidence.requestedCases !== job.caseLabels.length)
      return { status: 'FAIL', reason: 'Driver omitted requested journey cases', evidence }
    for (let i = 0; i < job.caseLabels.length; i++) {
      const row = evidence.cases[i]
      if (row?.label !== job.caseLabels[i] || row?.ok !== true || row?.status !== 'PASS' || row?.cleanupConfirmed !== true)
        return { status: 'FAIL', reason: 'Incomplete, reordered or unclosed journey case: ' + job.caseLabels[i], evidence }
      const problem = validateJourneys(job.journeys, row.journeys)
      if (problem) return { status: 'FAIL', reason: row.label + ': ' + problem, evidence }
    }
  }
  return { status: 'PASS', evidence }
}

export function markdown(report) {
  const clean = value => String(value ?? '').replace(/[|\r\n]/g, ' ')
  return `# Cross-surface test report\n\nStatus: ${report.status}. This is scoped regression evidence, not full-product certification.\n\n` +
    `Platform: ${report.platform}. Profile: ${report.profile}. Elapsed: ${report.elapsedMs} ms.\n\n` +
    '| Selection | Status | Elapsed ms | Reason |\n| --- | --- | ---: | --- |\n' +
    report.results.map(row => `| ${clean(row.id)} | ${row.status} | ${row.elapsedMs || 0} | ${clean(row.reason)} |`).join('\n') +
    journeyMarkdown(report) + '\n\n## Coverage limits\n\n' + report.limitations.map(line => '- ' + line).join('\n') +
    '\n\nSource/artifact identities, per-suite counts, exact argv and individual logs are in report.json. Retained output was not deleted.\n'
}

function journeyMarkdown(report) {
  const clean = value => String(value ?? '').replace(/[|\r\n]/g, ' ')
  const blocks = []
  for (const job of report.plan || []) {
    if (!job.journeys) continue
    const result = report.results.find(r => r.id === job.id)
    for (const label of job.caseLabels) {
      const cell = result?.evidence?.cases?.find(c => c.label === label)
      blocks.push('\n\n## User path: ' + clean(job.id + ' / ' + label) +
        '\n\nInput: ' + clean(cell?.inputMethod || 'Not executed') +
        '. Context closed: ' + (cell?.cleanupConfirmed === true ? 'yes' : 'unconfirmed') + '.')
      for (const expected of job.journeys) {
        const actual = cell?.journeys?.find(j => j.id === expected.id)
        blocks.push('\n\n### ' + clean(expected.title) + '\n\n' +
          'Status: ' + clean(actual?.status || 'NOT_RUN') +
          (actual?.error ? '. ' + clean(actual.error) : '') + '\n\n' +
          '| Step | User action | Expected result | Status | Observed result |\n| --- | --- | --- | --- | --- |\n' +
          expected.steps.map((step, i) => {
            const seen = actual?.steps?.find(s => s.id === step.id)
            return '| ' + (i + 1) + '. ' + clean(step.id) + ' | ' + clean(step.action) + ' | ' + clean(step.expected) +
              ' | ' + clean(seen?.status || 'NOT_RUN') + ' | ' + clean(seen?.error || seen?.observation?.observed || result?.reason || 'Not executed') + ' |'
          }).join('\n'))
      }
    }
  }
  return blocks.join('')
}
