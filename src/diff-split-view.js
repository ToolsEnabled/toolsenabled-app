/* THE SIDE-BY-SIDE VIEW, DRAWN. src/diff-split.js decides what lines pair and
 * what folds; this file only puts that on screen.
 *
 * TWO SCROLLERS THAT MOVE TOGETHER. Each side is its own box so a long line
 * scrolls sideways within its side instead of wrapping and breaking the
 * alignment. Every row is one fixed height on both sides, so rows stay level
 * as long as the two boxes share a scroll offset. The side a person is using
 * leads; the other follows. Keeping one leader stops two boxes of different
 * widths from pulling each other's horizontal offset back and forth.
 *
 * FILE TEXT IS NEVER MARKUP. Every line goes in through textContent or a text
 * node, as it does in the editing panes.
 *
 * READ ALOUD PER SIDE. Each side is a labelled region holding a list; each
 * line says its number and whether it was removed or added before its text.
 * Empty cells, which only keep the rows level, are hidden from the reader. */
import { SPLIT_LIMITS, expandFold, wordDiff } from './diff-split.js'

const KIND_WORD = { removed: 'removed', added: 'added', change: null, same: null }

function rangeText(start, count) {
  if (count === 0) return start === 0 ? 'start of file' : `after line ${start}`
  return count === 1 ? `line ${start}` : `lines ${start}–${start + count - 1}`
}

/**
 * Draw `model` into `container`. `ui` is the caller's per-model memory
 * ({ blocks, limit, top, left }), kept across redraws of the window so an
 * expanded fold stays expanded and the scroll position survives.
 */
export function mountSplitView(container, model, documentRef, ui, labels = {}) {
  const doc = documentRef
  if (!ui.blocks) ui.blocks = model.blocks
  if (!ui.limit) ui.limit = SPLIT_LIMITS.pageRows
  const node = (tag, className, text) => {
    const element = doc.createElement(tag)
    if (className) element.className = className
    if (text !== undefined && text !== null) element.textContent = String(text)
    return element
  }
  container.textContent = ''

  const notes = []
  if (model.source === 'patch') notes.push('Only the changed parts are shown. The full earlier version of this file was not kept, so each part is numbered by its own recorded edit.')
  if (model.source === 'edits') notes.push('Only the changed parts are shown. The earlier version of this file was not kept, and these edits did not record their line numbers.')
  if (model.limited) notes.push(`Showing the first ${Number(model.maximum).toLocaleString('en-US')} recorded lines. Use Edit to see the whole current file.`)
  if (model.approximate) notes.push('Some large changed sections are shown as whole blocks rather than line by line.')
  if (model.identical) notes.push('The two versions match.')
  if (model.source === 'full' && model.beforeFinalNewline !== model.afterFinalNewline) {
    notes.push(model.afterFinalNewline ? 'The earlier version did not end with a newline; the current one does.' : 'The current version does not end with a newline; the earlier one did.')
  }
  for (const text of labels.notes || []) notes.push(text)
  if (notes.length) {
    const box = node('div', 'diff-split-notes')
    for (const text of notes) box.appendChild(node('p', 'diff-split-note', text))
    container.appendChild(box)
  }

  const body = node('div', 'diff-split-body')
  const sides = {}
  for (const side of ['before', 'after']) {
    const column = node('section', 'diff-split-col')
    column.setAttribute('data-split-side', side)
    const headId = `diff-split-head-${side}`
    const head = node('h3', 'diff-split-label')
    head.id = headId
    head.appendChild(node('span', 'diff-split-label-side', side === 'before' ? 'Before' : 'After'))
    const detail = side === 'before' ? labels.before : labels.after
    if (detail) head.appendChild(node('span', 'diff-split-label-detail', detail))
    const count = model.source === 'full'
      ? `${(side === 'before' ? model.beforeLines : model.afterLines).toLocaleString('en-US')} lines`
      : ''
    if (count) head.appendChild(node('span', 'diff-split-label-count', count))
    const scroller = node('div', 'diff-split-scroll')
    scroller.tabIndex = 0
    scroller.setAttribute('role', 'region')
    scroller.setAttribute('aria-labelledby', headId)
    const list = node('div', 'diff-split-lines')
    list.setAttribute('role', 'list')
    list.setAttribute('aria-label', side === 'before' ? 'Before' : 'After')
    scroller.appendChild(list)
    column.append(head, scroller)
    body.appendChild(column)
    sides[side] = { scroller, list, fragment: doc.createDocumentFragment() }
  }
  container.appendChild(body)

  const code = (text, segments) => {
    const element = node('code', 'dsl-code')
    if (!segments) { element.textContent = text === '' ? ' ' : text; return element }
    for (const segment of segments) {
      if (segment.changed) element.appendChild(node('mark', 'dsl-word', segment.text))
      else element.appendChild(doc.createTextNode(segment.text))
    }
    return element
  }
  const cell = (row, side) => {
    const text = side === 'before' ? row.lt : row.rt
    if (text === null) {
      const empty = node('div', 'dsl-row is-empty')
      empty.setAttribute('aria-hidden', 'true')
      empty.append(node('span', 'dsl-num'), node('code', 'dsl-code', ' '))
      return empty
    }
    const kind = row.kind === 'same' ? 'same' : side === 'before' ? 'removed' : 'added'
    const element = node('div', `dsl-row is-${kind}`)
    element.setAttribute('role', 'listitem')
    const number = side === 'before' ? row.ln : row.rn
    const gutter = node('span', 'dsl-num', number ?? '')
    gutter.setAttribute('aria-hidden', 'true')
    const spoken = node('span', 'sr-only', `${number ? `Line ${number}` : 'Line'}${KIND_WORD[kind] ? `, ${KIND_WORD[kind]}` : ''}: `)
    let segments = null
    if (row.kind === 'change') {
      if (row.words === undefined) row.words = wordDiff(row.lt, row.rt)
      segments = row.words ? (side === 'before' ? row.words.left : row.words.right) : null
    }
    element.append(gutter, spoken, code(text, segments))
    return element
  }
  const band = (className, beforeText, afterText, action = null) => {
    for (const side of ['before', 'after']) {
      const element = node('div', `dsl-band ${className}`)
      const text = side === 'before' ? beforeText : afterText
      if (action && side === 'before') {
        element.setAttribute('role', 'listitem')
        const button = node('button', 'dsl-band-btn', action.label)
        button.type = 'button'
        button.setAttribute('data-split-action', action.name)
        if (action.index !== undefined) button.setAttribute('data-split-block', String(action.index))
        element.appendChild(button)
        if (text) element.appendChild(node('span', 'dsl-band-meta', text))
      } else {
        if (action) element.setAttribute('aria-hidden', 'true')
        else element.setAttribute('role', 'listitem')
        element.appendChild(node('span', 'dsl-band-meta', text))
      }
      sides[side].fragment.appendChild(element)
    }
  }

  let drawn = 0, stopped = false
  const rows = model.rows
  ui.blocks.forEach((block, index) => {
    if (stopped) return
    if (block.type === 'rows') {
      for (let r = block.from; r < block.to; r++) {
        if (drawn >= ui.limit) { stopped = true; break }
        sides.before.fragment.appendChild(cell(rows[r], 'before'))
        sides.after.fragment.appendChild(cell(rows[r], 'after'))
        drawn++
      }
    } else if (block.type === 'fold') {
      const count = block.to - block.from
      const first = rows[block.from], last = rows[block.to - 1]
      const step = Math.min(count, SPLIT_LIMITS.foldStep)
      band('dsl-fold', `lines ${first.ln}–${last.ln}`, `${count.toLocaleString('en-US')} unchanged lines · lines ${first.rn}–${last.rn}`, {
        name: 'expand', index,
        label: step === count ? `Show ${count.toLocaleString('en-US')} unchanged lines` : `Show ${step} of ${count.toLocaleString('en-US')} unchanged lines`,
      })
    } else if (block.type === 'hunk') {
      band('dsl-hunk', `Before ${rangeText(block.before, block.beforeCount)}`, `After ${rangeText(block.after, block.afterCount)}`)
    } else {
      band(block.type === 'record' ? 'dsl-record' : 'dsl-note', block.text, block.text)
    }
  })
  if (stopped) {
    const left = ui.blocks.reduce((sum, block) => sum + (block.type === 'rows' ? block.to - block.from : 0), 0) - drawn
    band('dsl-more', '', `${left.toLocaleString('en-US')} more rows`, { name: 'more', label: `Show ${Math.min(left, SPLIT_LIMITS.pageRows).toLocaleString('en-US')} more rows` })
  }
  if (!rows.length && !notes.length) band('dsl-note', 'Nothing to show.', 'Nothing to show.')
  for (const side of ['before', 'after']) sides[side].list.appendChild(sides[side].fragment)

  /* The side a person is using leads; see the head of this file. */
  const before = sides.before.scroller, after = sides.after.scroller
  let leader = before
  for (const scroller of [before, after]) {
    for (const type of ['pointerenter', 'pointerdown', 'wheel', 'touchstart', 'focusin', 'keydown']) {
      scroller.addEventListener(type, () => { leader = scroller }, { passive: true })
    }
    scroller.addEventListener('scroll', () => {
      if (scroller !== leader) return
      const other = scroller === before ? after : before
      if (other.scrollTop !== scroller.scrollTop) other.scrollTop = scroller.scrollTop
      if (other.scrollLeft !== scroller.scrollLeft) other.scrollLeft = scroller.scrollLeft
      ui.top = scroller.scrollTop
      ui.left = scroller.scrollLeft
    }, { passive: true })
  }
  if (ui.top || ui.left) for (const scroller of [before, after]) { scroller.scrollTop = ui.top || 0; scroller.scrollLeft = ui.left || 0 }

  /* A property, not addEventListener: this function redraws into the same
     container, and each redraw must replace the handler rather than add one. */
  container.onclick = event => {
    const button = event.target?.closest?.('[data-split-action]')
    if (!button) return
    const action = button.getAttribute('data-split-action')
    if (action === 'expand') {
      const index = Number(button.getAttribute('data-split-block'))
      ui.blocks = expandFold(ui.blocks, index)
      ui.top = before.scrollTop
      ui.left = before.scrollLeft
      mountSplitView(container, model, documentRef, ui, labels)
      /* Focus stays where the person was: on the first revealed line's side. */
      container.querySelector('.diff-split-col[data-split-side="before"] .diff-split-scroll')?.focus({ preventScroll: true })
    } else if (action === 'more') {
      ui.limit += SPLIT_LIMITS.pageRows
      ui.top = before.scrollTop
      ui.left = before.scrollLeft
      mountSplitView(container, model, documentRef, ui, labels)
      container.querySelector('.diff-split-col[data-split-side="before"] .diff-split-scroll')?.focus({ preventScroll: true })
    }
  }
  return { drawn, stopped }
}
