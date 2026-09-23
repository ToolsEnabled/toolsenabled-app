// Share the actual body height between context rows. Fixed clamps remain a
// first-paint fallback; resizing, zoom compensation and shorter neighbouring
// rows can then give their unused lines to the conversation or task.
export function fitTreePreview(container) {
  if (!container.isConnected || !container.clientHeight) return
  const rows = [...container.querySelectorAll('.chip-context-text, p')]
    .filter(node => node.getClientRects().length && getComputedStyle(node).display !== 'none')
  if (!rows.length) return
  for (const node of rows) {
    // Reset the previous viewport before measuring a resize or a new reply.
    node.style.display = ''
    node.style.maxHeight = ''
    node.style.webkitLineClamp = '1'
    node.scrollTop = 0
  }
  const bounds = container.getBoundingClientRect()
  const scale = bounds.height / container.offsetHeight
  if (!(scale > 0)) return
  const bottom = Math.max(...[...container.querySelectorAll('*')]
    .filter(node => node.getClientRects().length)
    .map(node => node.getBoundingClientRect().bottom))
  let remaining = (bounds.bottom - bottom) / scale - (parseFloat(getComputedStyle(container).paddingBottom) || 0)
  const budgets = rows.map(node => {
    const style = getComputedStyle(node)
    const height = parseFloat(style.lineHeight) || node.clientHeight
    const action = node.closest('.cl-tool') || node.parentElement.dataset.contextKind === 'action'
    // scrollHeight rounds to whole CSS pixels; a fractional one-line height
    // must not reserve a second line that this row cannot actually use.
    const demand = Math.max(1, Math.ceil((node.scrollHeight - 1) / height))
    return { node, height, lines: 1, demand: action ? 1 : Math.min(80, demand) }
  }).reverse() // Spend an unmatched last line on the most recent update.
  let allocated = true
  while (allocated) {
    allocated = false
    for (const row of budgets) {
      if (row.lines >= row.demand || remaining < row.height) continue
      row.lines++
      remaining -= row.height
      allocated = true
    }
  }
  for (const row of budgets) {
    if (row.node.dataset.previewTail === 'true') {
      // A line clamp hides the end regardless of scrollTop. Use the same
      // allocated height as a real scroll viewport and follow its newest line.
      // Only compact response rows opt in; the selected chat owns its scroll.
      row.node.style.webkitLineClamp = 'unset'
      row.node.style.display = 'block'
      row.node.style.maxHeight = `${row.lines * row.height}px`
      row.node.scrollTop = Math.max(0, row.node.scrollHeight - row.node.clientHeight)
    } else row.node.style.webkitLineClamp = String(row.lines)
  }
}

export class TreePreviewFitter {
  constructor() {
    this.pending = new Set()
    this.observer = new ResizeObserver(entries => {
      for (const { target } of entries) this.schedule(target)
    })
  }
  watch(record, container) {
    if (record.previewFitContainer !== container) {
      this.forget(record)
      record.previewFitContainer = container
      this.observer.observe(container)
    }
    this.schedule(container)
  }
  schedule(container) {
    this.pending.add(container)
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      for (const target of this.pending) fitTreePreview(target)
      this.pending.clear()
    })
  }
  forget(record) {
    const container = record.previewFitContainer
    if (container) { this.observer.unobserve(container); this.pending.delete(container) }
    record.previewFitContainer = null
  }
  destroy() {
    this.observer.disconnect()
    if (this.frame) cancelAnimationFrame(this.frame)
    this.pending.clear()
  }
}
