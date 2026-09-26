let nextPickerId = 1

// This dialog owns only a temporary selection. The caller decides how to
// enter edit mode after receiving the selected root IDs.
export function showTreeEditPicker({ host, trees = [], selectedRootIds = [], onConfirm, onCancel } = {}) {
  const document = host?.ownerDocument || globalThis.document
  const opener = document.activeElement
  const create = (tag, className, text) => {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }
  const id = `tree-edit-picker-${nextPickerId++}`
  const backdrop = create('div', 'tree-edit-picker-backdrop')
  const dialog = create('section', 'tree-edit-picker')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', `${id}-title`)
  dialog.setAttribute('aria-describedby', `${id}-note`)
  dialog.setAttribute('tabindex', '-1')
  const title = create('h2', '', 'Choose trees to edit')
  title.id = `${id}-title`
  const note = create('p', 'tree-edit-picker-note', 'Shows every agent as fitted circles. Your usual view returns when you finish.')
  note.id = `${id}-note`
  const tools = create('div', 'tree-edit-picker-tools')
  const selectAll = create('button', 'tree-edit-picker-select-all', 'Select all')
  selectAll.type = 'button'
  const selection = create('span', 'tree-edit-picker-selection')
  selection.setAttribute('aria-live', 'polite')
  tools.append(selectAll, selection)
  const list = create('fieldset', 'tree-edit-picker-list')
  list.appendChild(create('legend', '', 'Trees'))
  const selected = new Set(Array.isArray(selectedRootIds) ? selectedRootIds : [])
  const available = new Map()
  for (const tree of Array.isArray(trees) ? trees : []) {
    if (typeof tree?.rootId === 'string' && tree.rootId && !available.has(tree.rootId)) available.set(tree.rootId, tree)
  }
  const inputs = []
  for (const [rootId, tree] of available) {
    const row = create('label', 'tree-edit-picker-row')
    const input = create('input')
    input.type = 'checkbox'
    input.value = rootId
    input.checked = selected.has(rootId)
    const count = Number.isFinite(tree.count) ? Math.max(0, Math.floor(tree.count)) : null
    row.append(input, create('span', 'tree-edit-picker-name', tree.name || 'Unnamed tree'),
      create('span', 'tree-edit-picker-count', count === null ? '' : `${count} ${count === 1 ? 'agent' : 'agents'}`))
    inputs.push(input)
    list.appendChild(row)
  }
  if (!inputs.length) list.appendChild(create('p', 'tree-edit-picker-empty', 'No trees are available to edit.'))
  const actions = create('div', 'tree-edit-picker-actions')
  const cancel = create('button', 'tree-edit-picker-cancel', 'Cancel')
  const confirm = create('button', 'tree-edit-picker-confirm', 'Edit selected trees')
  cancel.type = confirm.type = 'button'
  actions.append(cancel, confirm)
  dialog.append(title, note, tools, list, actions)
  backdrop.appendChild(dialog)
  // Graph containers establish a containing block and clip their descendants.
  // The viewport overlay belongs to the same document's uncontained body.
  document.body.appendChild(backdrop)

  let closed = false, outsidePress = null
  const values = () => inputs.filter(input => input.checked).map(input => input.value)
  const sync = () => {
    const count = values().length
    confirm.disabled = count === 0
    selectAll.disabled = count === inputs.length
    selection.textContent = `${count} ${count === 1 ? 'tree' : 'trees'} selected`
  }
  const finish = result => {
    if (closed) return
    closed = true
    backdrop.remove()
    if (opener?.isConnected) opener.focus({ preventScroll: true })
    if (result) onConfirm?.(result)
    else onCancel?.()
  }
  for (const input of inputs) input.addEventListener('change', sync)
  selectAll.addEventListener('click', () => {
    for (const input of inputs) input.checked = true
    sync()
  })
  cancel.addEventListener('click', () => finish(null))
  confirm.addEventListener('click', () => { const roots = values(); if (roots.length) finish(roots) })
  backdrop.addEventListener('pointerdown', event => { outsidePress = event.target === backdrop })
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop && outsidePress !== false) finish(null)
    outsidePress = null
  })
  backdrop.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish(null)
    } else if (event.key === 'Tab') {
      const stops = [selectAll, ...inputs, cancel, confirm].filter(element => !element.disabled)
      const first = stops[0], last = stops.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
  })
  sync()
  ;(inputs.find(input => input.checked) || inputs[0] || cancel).focus({ preventScroll: true })
  return { close: () => finish(null) }
}
