/* Compare the editable drafts. File text is never parsed as markup. The work
 * budget bounds matching, not correctness: large changes become replacement
 * blocks, while the complete drafts remain available in the editing panes. */
export function compareVersionLines(before, after) {
  const a = String(before).match(/[^\n]*\n|[^\n]+$/g) || []
  const b = String(after).match(/[^\n]*\n|[^\n]+$/g) || []
  let prefix = 0, suffix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const rows = []
  let oldLine = 1, newLine = 1, added = 0, removed = 0
  const emit = (kind, text) => {
    rows.push({ kind, text: text.replace(/\n$/, ''), newline: text.endsWith('\n'), before: kind === 'added' ? null : oldLine++, after: kind === 'removed' ? null : newLine++ })
    if (kind === 'added') added++
    if (kind === 'removed') removed++
  }
  for (let i = 0; i < prefix; i++) emit('context', a[i])
  const n = a.length - prefix - suffix, m = b.length - prefix - suffix
  const block = n * m > 500000
  if (block) {
    for (let i = 0; i < n; i++) emit('removed', a[prefix + i])
    for (let j = 0; j < m; j++) emit('added', b[prefix + j])
  } else {
    const width = m + 1, table = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[prefix + i] === b[prefix + j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
    let i = 0, j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a[prefix + i] === b[prefix + j]) { emit('context', a[prefix + i++]); j++ }
      else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) emit('removed', a[prefix + i++])
      else emit('added', b[prefix + j++])
    }
  }
  for (let i = a.length - suffix; i < a.length; i++) emit('context', a[i])
  return { rows, added, removed, block }
}

export function mountLiveComparison(container, before, after, documentRef) {
  const diff = compareVersionLines(before, after)
  container.textContent = ''
  const element = (tag, cls, text, parent = container) => {
    const node = documentRef.createElement(tag)
    node.setAttribute('class', cls)
    node.textContent = text
    parent.appendChild(node)
    return node
  }
  element('p', 'diff-patch-basis', diff.added || diff.removed
    ? `Current comparison: +${diff.added} added, −${diff.removed} removed. Select a line to edit it below.`
    : 'The two versions match. Edit either version below to make a change.')
  if (diff.block) element('p', 'diff-patch-notice', 'Large changed sections are shown as replacement blocks. Both complete versions remain editable below.')
  const visible = new Set()
  diff.rows.forEach((row, i) => {
    if (row.kind !== 'context') for (let j = Math.max(0, i - 3); j <= Math.min(diff.rows.length - 1, i + 3); j++) visible.add(j)
  })
  let previous = -1, shown = 0
  for (const index of [...visible].sort((a, b) => a - b)) {
    if (shown++ === 2000) { element('p', 'diff-patch-limit', 'The preview stops here. Both complete versions remain editable below.'); break }
    if (index > previous + 1) element('p', 'diff-patch-notice', `${index - previous - 1} unchanged lines`)
    previous = index
    const row = diff.rows[index], side = row.kind === 'removed' ? 'original' : 'proposed'
    const button = element('button', `diff-patch-row diff-live-line diff-line-${row.kind}`, '')
    button.setAttribute('type', 'button')
    button.setAttribute('data-diff-action', 'edit-line')
    button.setAttribute('data-diff-side', side)
    button.setAttribute('data-diff-line', String(side === 'original' ? row.before : row.after))
    button.setAttribute('aria-label', `Edit ${side === 'original' ? 'original' : 'changed'} line ${side === 'original' ? row.before : row.after}`)
    element('span', 'diff-line-number', row.before ?? '', button)
    element('span', 'diff-line-number', row.after ?? '', button)
    element('span', 'diff-line-prefix', row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' ', button)
    element('code', 'diff-line-code', row.text, button)
    if (!row.newline) element('p', 'diff-patch-notice', 'No newline at end of this version')
  }
  return diff
}
