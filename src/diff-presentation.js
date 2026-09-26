import { CHANGE_LIMITS, parseUnifiedPatch } from './session-change-patches.js'

// Presentation only. The patch reader/reversal remains the authority for what
// changed; this projection supplies line numbers without interpreting code.
export function recordedPatchRows(patches, maximum = CHANGE_LIMITS.previewLines) {
  const rows = []
  let consumed = 0
  let unnumbered = false
  const records = Array.isArray(patches) ? patches : []
  for (let index = 0; index < records.length; index++) {
    const diff = records[index]?.diff
    if (typeof diff !== 'string') continue
    const lines = diff.replace(/\r\n/g, '\n').split('\n')
    if (lines.at(-1) === '') lines.pop()
    // The same parser used to measure/reconstruct a version decides whether
    // these coordinates can be trusted. Partial records remain visible text.
    const hunks = parseUnifiedPatch(diff)
    if (!hunks && lines.some(line => line.startsWith('@@ '))) unnumbered = true
    let hunkIndex = 0
    if (records.length > 1) rows.push({ kind: 'record', text: `Recorded edit ${index + 1} of ${records.length}` })
    let before = null, after = null, beforeRemaining = 0, afterRemaining = 0
    for (const line of lines) {
      if (consumed++ >= maximum) return { rows, limited: true, unnumbered }
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
      if (hunks && header) {
        const hunk = hunks[hunkIndex++]
        before = hunk.oldStart; after = hunk.newStart
        beforeRemaining = hunk.oldCount; afterRemaining = hunk.newCount
        rows.push({ kind: 'hunk', text: line, before, after,
          beforeCount: hunk.oldCount, afterCount: hunk.newCount, section: header[5].trim() })
        continue
      }
      if (before !== null && (beforeRemaining > 0 || afterRemaining > 0) && /^[ +\-]/.test(line)) {
        const kind = line[0] === '+' ? 'added' : line[0] === '-' ? 'removed' : 'context'
        if (kind !== 'added') beforeRemaining--
        if (kind !== 'removed') afterRemaining--
        rows.push({ kind, text: line.slice(1), before: kind === 'added' ? null : before++, after: kind === 'removed' ? null : after++ })
      } else if (line === '\\ No newline at end of file') {
        rows.push({ kind: 'note', text: 'No newline at end of file' })
      } else if (!/^(?:--- |\+\+\+ |diff --git |index )/.test(line)) {
        // Unknown metadata stays visible as literal text, never a fake source
        // line or a colored addition/deletion before a hunk has begun.
        rows.push({ kind: 'note', text: line })
      }
    }
  }
  return { rows, limited: false, unnumbered }
}

function rangeLabel(side, start, count) {
  if (count === 0) return `${side}: ${start === 0 ? 'start of file' : `after line ${start}`}`
  return count === 1 ? `${side} line ${start}` : `${side} lines ${start}–${start + count - 1}`
}

export function mountRecordedPatch(container, patches, documentRef) {
  const { rows, limited, unnumbered } = recordedPatchRows(patches)
  const element = (tag, className, text) => {
    const node = documentRef.createElement(tag)
    node.setAttribute('class', className)
    if (text !== undefined) node.textContent = String(text)
    return node
  }
  container.appendChild(element('p', 'diff-patch-basis',
    'Before and After refer to each recorded edit, not the current file. Other file sections are omitted.'))
  if (unnumbered) container.appendChild(element('p', 'diff-patch-notice',
    'Some retained patch text is incomplete or uses an unsupported format. Line numbers are unavailable for those records.'))
  if (!rows.length) {
    container.appendChild(element('p', 'diff-patch-notice', 'No source lines were retained in this patch.'))
    return
  }
  const columns = element('div', 'diff-patch-columns')
  for (const [name, className] of [['Before', 'diff-line-number'], ['After', 'diff-line-number'], ['Recorded patch', 'diff-patch-column-caption']]) {
    columns.appendChild(element('span', className, name))
  }
  container.appendChild(columns)
  for (const line of rows) {
    const row = element('div', `diff-patch-row diff-line-${line.kind}`)
    if (['added', 'removed', 'context'].includes(line.kind)) {
      for (const number of [line.before, line.after]) {
        const gutter = element('span', 'diff-line-number', number ?? '')
        gutter.setAttribute('aria-hidden', 'true')
        row.appendChild(gutter)
      }
      const prefix = element('span', 'diff-line-prefix', line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' ')
      prefix.setAttribute('aria-hidden', 'true')
      row.appendChild(prefix)
      row.appendChild(element('code', 'diff-line-code', line.text || ' '))
      row.setAttribute('aria-label', `${line.kind === 'added' ? 'Added' : line.kind === 'removed' ? 'Removed' : 'Context'}, ${line.kind === 'removed' ? `old line ${line.before}` : `line ${line.after}`}: ${line.text}`)
    } else if (line.kind === 'hunk') {
      const metadata = element('div', 'diff-line-meta')
      metadata.appendChild(element('strong', 'diff-hunk-range',
        `${rangeLabel('Before', line.before, line.beforeCount)} → ${rangeLabel('After', line.after, line.afterCount)}`))
      if (line.section) metadata.appendChild(element('code', 'diff-hunk-context', line.section))
      row.appendChild(metadata)
    } else row.appendChild(element('span', 'diff-line-meta', line.text))
    container.appendChild(row)
  }
  if (limited) container.appendChild(element('p', 'diff-patch-limit', 'Showing the first 2,000 patch lines. Remaining patch lines are not shown here.'))
}
