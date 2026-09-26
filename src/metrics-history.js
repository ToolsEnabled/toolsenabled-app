// Presentation of the run rows already read by Metrics. These helpers never
// fetch more history or imply that the loaded rows are the whole record.
export function runOutcomeLabel(run) {
  return run.result === 'started' ? 'Started' : run.result === 'refused' ? 'Did not start' : 'Not recorded'
}

export function selectRunHistory(rows, { query = '', outcome = 'all', window = null, order = 'newest' } = {}) {
  const needle = query.trim().toLocaleLowerCase()
  return rows.filter(run => {
    if (outcome !== 'all' && (run.result || 'unrecorded') !== outcome) return false
    if (window && !(Number.isFinite(run.atMs) && run.atMs >= window.startMs && run.atMs < window.endMs)) return false
    return !needle || [run.sequence, run.agent || 'Not recorded', run.asked, run.why, runOutcomeLabel(run), run.at]
      .some(value => String(value ?? '').toLocaleLowerCase().includes(needle))
  }).sort((a, b) => {
    // Unknown timestamps stay at the end in either order.
    const aKnown = Number.isFinite(a.atMs), bKnown = Number.isFinite(b.atMs)
    if (aKnown !== bKnown) return aKnown ? -1 : 1
    const delta = (aKnown ? a.atMs - b.atMs : 0) || a.sequence - b.sequence
    return order === 'oldest' ? delta : -delta
  })
}

export function csvCell(value) {
  let text = String(value ?? '')
  // A quoted cell can still be a spreadsheet formula. Keep names and tasks
  // as text when opened in Excel as well as in other spreadsheet programs.
  if (/^\s*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

export function runHistoryCsv(rows, { example = false } = {}) {
  const data = [['Run', 'Agent', 'Started at (UTC)', 'Outcome', 'Details', 'Source'], ...rows.map(run => [
    run.sequence,
    run.agent,
    Number.isFinite(run.atMs) ? new Date(run.atMs).toISOString() : '',
    runOutcomeLabel(run),
    run.why || run.asked,
    example ? 'Example data' : 'Recorded activity',
  ])]
  // UTF-8 BOM preserves names in Windows Excel; CRLF is portable to all hosts.
  return '\uFEFF' + data.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
