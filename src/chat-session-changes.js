import { CHANGE_LIMITS, boundedChangePatches, boundedChangeEdits, boundedChangeOriginals } from './session-change-patches.js'

export function createSessionChangeStore() {
  const batches = new Map()
  let limited = false, historyIncomplete = false
  /* WHICH FILES LOST HISTORY, not merely THAT history was lost. Evicting an old
     batch only makes the paths IN that batch unreconstructable: reversing the
     patches that remain would land on the file as it stood after the dropped
     edit, which is a version nobody can vouch for. Every other path still has
     its whole chain, and the global flag used to refuse those too -- one busy
     session turned the Compare window single-pane for files it had complete
     patches for. A provider-truncated batch (batch.limited) stays global on
     purpose: we cannot know which paths it dropped. */
  const droppedPaths = new Set()
  return {
    add(batch) {
      const key = batch.id || Symbol('change')
      const known = new Set()
      for (const [id, held] of batches) if (id !== key) for (const file of held.files) known.add(file.path)
      const admitted = batch.files.slice(0, CHANGE_LIMITS.files).filter(file => {
        if (!known.has(file.path) && known.size >= CHANGE_LIMITS.files) { limited = true; return false }
        known.add(file.path)
        return true
      }).map(file => ({ ...file }))
      batches.set(key, { files: admitted, patches: boundedChangePatches(batch.patches, admitted), edits: boundedChangeEdits(batch.edits, admitted), originals: boundedChangeOriginals(batch.originals, admitted) })
      if (batch.limited) { limited = true; historyIncomplete = true }
      if (batch.files.length > CHANGE_LIMITS.files) limited = true
      while (batches.size > CHANGE_LIMITS.events) {
        const oldestKey = batches.keys().next().value
        for (const file of batches.get(oldestKey)?.files || []) droppedPaths.add(file.path)
        batches.delete(oldestKey)
        limited = true
      }
      // Retain a bounded amount of patch text across the entire session.
      let retained = 0
      for (const value of [...batches.values()].reverse()) {
        value.patches = value.patches.filter(patch => {
          retained += patch.diff.length
          if (retained <= CHANGE_LIMITS.totalPatchChars) return true
          limited = true
          return false
        })
      }
    },
    read() {
      const files = new Map()
      for (const batch of batches.values()) for (const change of batch.files) {
        let file = files.get(change.path)
        if (!file) {
          if (files.size >= CHANGE_LIMITS.files) { limited = true; continue }
          const retained = !historyIncomplete && !droppedPaths.has(change.path)
          file = { ...change, added: 0, removed: 0, edits: 0, patches: [], substringEdits: [], originalCapture: null, editsReversible: retained, complete: retained && change.status !== 'R' }
          files.set(change.path, file)
        }
        /* THE EARLIEST CAPTURE WINS. Batches are walked oldest-first, so the
           first one holding this path holds the file as it stood before this
           session touched it; a later batch's capture is a later edit's
           before-text, which is a version the person never started from.
           This survives an evicted batch on purpose: unlike a patch chain, a
           whole-file original does not need the edits between it and now. */
        if (!file.originalCapture) {
          const captured = (batch.originals || []).find(entry => entry.path === change.path)
          if (captured) file.originalCapture = { ...captured }
        }
        file.status = change.status
        if (change.status === 'R') { file.complete = false; file.editsReversible = false }
        if (change.added === null || change.removed === null) {
          file.unmeasuredEdits = (file.unmeasuredEdits || 0) + 1
          file.complete = false
          /* An unmeasured edit that carried its own before/after text can still
             be reversed exactly. One that did not (a Write, which never sends
             the previous contents) ends the chain for this file -- a partial
             reversal would present a version that never existed. */
          const edit = (batch.edits || []).find(entry => entry.path === change.path)
          if (edit) file.substringEdits.push(edit)
          else file.editsReversible = false
        } else {
          file.added += change.added
          file.removed += change.removed
        }
        file.edits++
        const patch = batch.patches.find(entry => entry.path === change.path)
        if (patch) file.patches.push({ ...patch })
        else file.complete = false
      }
      return { files: [...files.values()], limited }
    },
    /* Clearing the batches clears what the flags were describing. They are
       derived from the held batches, so leaving them set would make a reused
       store permanently refuse originals it has complete patches for. */
    clear() { batches.clear(); droppedPaths.clear(); limited = false; historyIncomplete = false },
  }
}

let nextPanel = 0
export function mountChatSessionChanges(root, { onOpenDiff }) {
  const doc = root.ownerDocument || document
  const store = createSessionChangeStore()
  const host = doc.createElement('section')
  host.className = 'chat-session-changes'
  host.setAttribute('data-session-changes', '')
  const id = `session-changes-${++nextPanel}`
  const node = (tag, className, text = '', attributes = {}) => {
    const element = doc.createElement(tag)
    element.className = className
    element.textContent = text
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
    return element
  }
  const icon = (className, path) => {
    const element = node('span', className, '', { 'aria-hidden': 'true' })
    element.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="${path}"/></svg>`
    return element
  }
  const toggle = node('button', 'session-changes-toggle', '', { type: 'button', 'data-changes-toggle': '', 'aria-expanded': 'false', 'aria-controls': id })
  const arrow = icon('session-changes-chevron', 'm5 12 5-5 5 5')
  const count = node('span', 'session-changes-count', '0 files', { 'data-changes-count': '' })
  const totals = node('span', 'session-changes-totals', '', { 'data-changes-totals': '' })
  const totalAdded = node('span', 'session-change-added')
  const totalRemoved = node('span', 'session-change-removed')
  totals.append(totalAdded, totalRemoved)
  for (const child of [node('span', 'session-changes-grip', '', { 'aria-hidden': 'true' }), node('span', 'session-changes-title', 'Changes', { id: `${id}-label` }), count, totals, arrow]) toggle.appendChild(child)
  const panel = node('div', 'session-changes-panel', '', { id, 'data-changes-panel': '', role: 'region', 'aria-labelledby': `${id}-label` })
  panel.hidden = true
  const caption = node('div', 'session-changes-caption')
  const captionIcon = icon('session-changes-caption-icon', 'M5 3h6l4 4v10H5V3Zm6 0v4h4M8 11h4m-4 3h4')
  const captionText = node('div', 'session-changes-caption-text')
  const captionSummary = node('span', 'session-changes-summary', 'Your assistant’s file edits, in one place')
  captionText.append(node('strong', '', 'Changes in this chat'), captionSummary)
  const close = node('button', 'session-changes-close', '', { type: 'button', 'aria-label': 'Close changes' })
  close.appendChild(icon('', 'm6 6 8 8m0-8-8 8'))
  caption.append(captionIcon, captionText, close)
  const list = node('div', 'session-changes-list', '', { 'data-changes-list': '' })
  const limit = node('p', 'session-changes-limit', '', { 'data-changes-limit': '' })
  for (const child of [caption, list, limit]) panel.appendChild(child)
  host.appendChild(toggle)
  host.appendChild(panel)
  const dock = root.querySelector('.chat-composer-dock') || root
  dock.insertBefore(host, dock.querySelector('.chat-compose-surface') || dock.querySelector('.chat-input') || null)
  let expanded = false
  const setOpen = value => {
    expanded = value
    panel.hidden = !value
    toggle.setAttribute('aria-expanded', String(value))
    host.classList.toggle('is-open', value)
    if (value) paint()
  }
  toggle.addEventListener('click', () => setOpen(!expanded))
  close.addEventListener('click', () => { setOpen(false); toggle.focus() })
  const onEscape = event => {
    if (event.key !== 'Escape' || !expanded || event.defaultPrevented) return
    event.preventDefault(); event.stopPropagation(); setOpen(false); toggle.focus()
  }
  root.addEventListener('keydown', onEscape)
  host.addEventListener('keydown', event => {
    if (event.target === toggle && event.key === 'ArrowUp') {
      event.preventDefault(); setOpen(true); list.querySelector('button')?.focus()
    } else if (event.target?.hasAttribute?.('data-change-path') && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const rows = [...list.querySelectorAll('button')]
      const index = rows.indexOf(event.target)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : index + (event.key === 'ArrowUp' ? -1 : 1)
      rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus()
    }
  })
  function paint() {
    const snapshot = store.read()
    host.classList.toggle('has-changes', snapshot.files.length > 0)
    count.textContent = `${snapshot.files.length} ${snapshot.files.length === 1 ? 'file' : 'files'}`
    const added = snapshot.files.reduce((sum, file) => sum + file.added, 0)
    const removed = snapshot.files.reduce((sum, file) => sum + file.removed, 0)
    const partial = snapshot.files.some(file => file.unmeasuredEdits > 0)
    const measured = snapshot.files.some(file => file.edits > (file.unmeasuredEdits || 0))
    const edits = snapshot.files.reduce((sum, file) => sum + file.edits, 0)
    captionSummary.textContent = snapshot.files.length
      ? `${snapshot.files.length} ${snapshot.files.length === 1 ? 'file' : 'files'} · ${edits} reported ${edits === 1 ? 'edit' : 'edits'} · Select to compare`
      : 'Your assistant’s file edits, in one place'
    totalAdded.textContent = measured ? `+${added}${partial ? '*' : ''}` : snapshot.files.length ? '—' : ''
    totalRemoved.textContent = measured ? `−${removed}${partial ? '*' : ''}` : snapshot.files.length ? '—' : ''
    totals.setAttribute('aria-label', measured
      ? `${added} recorded lines added, ${removed} recorded lines removed${partial ? '; additional line counts unavailable, see the diff' : ''}`
      : 'Line counts unavailable, see the diff')
    if (!expanded) return
    const previousScroll = list.scrollTop
    const focusedPath = (root.ownerDocument || doc).activeElement?.getAttribute?.('data-change-path')
    list.textContent = ''
    if (!snapshot.files.length) {
      const empty = doc.createElement('p')
      empty.className = 'session-changes-empty'
      empty.append(icon('session-changes-empty-icon', 'M5 3h6l4 4v10H5V3Zm6 0v4h4m-7 4h4m-4 3h2'), node('strong', '', 'A place for every change'), node('span', '', 'When your assistant reports a file edit, review the changes here without leaving the conversation.'))
      list.appendChild(empty)
    }
    for (const file of snapshot.files) {
      const row = doc.createElement('button')
      row.type = 'button'
      row.className = 'session-change-file'
      row.setAttribute('data-change-path', file.path)
      row.setAttribute('data-change-status', file.status)
      const hasMeasured = file.edits > (file.unmeasuredEdits || 0)
      const counts = hasMeasured
        ? `${file.added} recorded lines added, ${file.removed} recorded lines removed${file.unmeasuredEdits ? '; additional line counts unavailable, see the diff' : ''}`
        : 'line counts unavailable, see the diff'
      row.setAttribute('aria-label', `${file.path}, ${counts}. Open diff`)
      const status = node('span', 'session-change-status', file.status, { 'aria-hidden': 'true' })
      status.title = ({ A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Changed' })[file.status] || 'Changed'
      const filename = file.path.replace(/\\/g, '/').split('/').pop() || file.path
      const directory = file.path.slice(0, file.path.length - filename.length).replace(/[\\/]$/, '')
      const path = node('span', 'session-change-path')
      path.appendChild(node('span', 'session-change-name', filename))
      if (directory) path.appendChild(node('span', 'session-change-directory', directory))
      const delta = node('span', 'session-change-delta')
      const deltaCounts = node('span', 'session-change-delta-counts')
      deltaCounts.append(node('span', `session-change-added${hasMeasured ? '' : ' is-unavailable'}`, hasMeasured ? `+${file.added}${file.unmeasuredEdits ? '*' : ''}` : '—'), node('span', `session-change-removed${hasMeasured ? '' : ' is-unavailable'}`, hasMeasured ? `−${file.removed}${file.unmeasuredEdits ? '*' : ''}` : '—'))
      delta.appendChild(deltaCounts)
      if (hasMeasured && file.added + file.removed > 0) {
        const bar = node('span', 'session-change-delta-bar', '', { 'aria-hidden': 'true' })
        for (const [kind, amount] of [['added', file.added], ['removed', file.removed]]) {
          if (!amount) continue
          const segment = node('span', `session-change-delta-${kind}`)
          segment.style.flexGrow = String(amount)
          bar.appendChild(segment)
        }
        delta.appendChild(bar)
      }
      row.append(status, path, delta, icon('session-change-open', 'M5 10h10m-4-4 4 4-4 4'))
      row.title = file.path
      row.addEventListener('click', () => onOpenDiff(file))
      list.appendChild(row)
      if (focusedPath === file.path) row.focus({ preventScroll: true })
    }
    list.scrollTop = previousScroll
    limit.textContent = snapshot.limited
      ? 'Shell and outside edits may be missing. History limit reached; showing up to 100 files and 200 change events. Some older diffs are unavailable.'
      : 'Shell and outside edits may be missing. Up to 100 files · 1 MB per file.'
    if (partial) limit.textContent = `${measured ? '* Partial counts. ' : ''}Some edits did not include line counts or an original version. ${limit.textContent}`
  }
  paint()
  return {
    add(batch) { store.add(batch); paint() },
    openFile(path) { const file = store.read().files.find(file => file.path === path); if (file) onOpenDiff(file) },
    dispose() { root.removeEventListener('keydown', onEscape); store.clear(); host.remove() },
  }
}
