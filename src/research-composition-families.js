const copy = value => structuredClone(value)
const rows = value => Array.isArray(value) ? value : []
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Root owns adding/removing source snapshots, compilation and Undo. This editor
// changes only global policy text; navigating families never rewrites a draft.
export function createCompositionFamilyEditor({ onChange = () => {}, onSelect = () => {}, onAdd = () => {}, onRemove = () => {} } = {}) {
  let workspace = null, sources = [], selectedTaskId = '', sourceTaskId = '', disabled = false, destroyed = false
  const el = document.createElement('div')
  const make = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node }
  const mark = (node, name) => { node.setAttribute('data-composition-family-fields-' + name, ''); return node }
  mark(el, 'editor')
  const label = (title, input) => { const node = make('label'); node.append(make('span', title), input); return node }
  const focusKey = (node, key) => { node.setAttribute('data-composition-family-fields-focus', key); return node }
  const families = () => rows(workspace?.families)
  const available = () => sources.filter(source => !families().some(family => family.sourceTask?.id === source.taskId))
  const canAdd = () => Boolean(sourceTaskId && available().some(source => source.taskId === sourceTaskId))
  const canRemove = () => Boolean(selectedTaskId && families().some(family => family.sourceTask?.id === selectedTaskId))
  function sync() {
    for (const tag of ['input', 'textarea', 'select', 'button']) for (const node of el.querySelectorAll(tag)) node.disabled = disabled
    const add = el.querySelector('[data-composition-family-fields-add]'), remove = el.querySelector('[data-composition-family-fields-remove]')
    if (add) add.disabled = disabled || !canAdd()
    if (remove) remove.disabled = disabled || !canRemove()
  }
  const bind = (input, update, emit = true) => {
    input.addEventListener('input', event => {
      event.stopPropagation()
      if (destroyed || disabled || input.disabled || !el.contains(input)) return
      update(input.value)
      if (emit) onChange(copy(workspace))
      sync()
    })
    input.addEventListener('change', event => event.stopPropagation())
  }
  const field = (title, name, value, update, multiline = false) => {
    const input = focusKey(mark(make(multiline ? 'textarea' : 'input'), name), name)
    if (multiline) input.setAttribute('rows', '2'); else { input.type = 'text'; input.setAttribute('type', 'text') }
    input.setAttribute('aria-label', title); input.value = value ?? ''; bind(input, update); return label(title, input)
  }
  const select = (title, name, value, options, update, emit = true) => {
    const input = focusKey(mark(make('select'), name), name), choices = [...options]
    if (!choices.some(([id]) => id === value)) choices.unshift([value ?? '', value ? String(value) + ' (unavailable)' : 'Choose a value'])
    for (const [id, title] of choices) { const option = make('option', title); option.value = id; option.setAttribute('value', id); input.append(option) }
    input.value = value ?? ''; input.setAttribute('aria-label', title); bind(input, update, emit); return label(title, input)
  }
  const button = (title, name, action, ready) => {
    const node = focusKey(mark(make('button', title), name), name); node.type = 'button'; node.setAttribute('type', 'button')
    node.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation()
      if (!disabled && !destroyed && !node.disabled && el.contains(node) && ready()) action()
    })
    return node
  }
  function renderContent() {
    el.replaceChildren()
    if (!workspace) { el.append(mark(make('p', 'Start a family workspace to retain several source families and build one combined task set with a shared sampling and coverage policy.'), 'status')); return }
    const retained = families(), missing = retained.filter(family => !sources.some(source => source.taskId === family.sourceTask?.id))
    el.append(mark(make('p', retained.length + ' retained source families. Family grouping is an investigator claim; the primary population and qualification admission are evaluated later.'), 'status'))
    el.append(make('p', 'Global sampling and coverage apply to the combined task set. Each family keeps its own split, expected-answer policy and occurrence choices. Source bindings are checked when building the recipe.'))
    if (missing.length) el.append(mark(make('p', 'Missing live source tasks: ' + missing.map(family => family.sourceTask?.id || '(unnamed)').join(', ')
      + '. Their retained fields remain inspectable, but building must refuse. Undo if available or import the original source draft. You can also export editable family sources and import that separate draft. Retained snapshots do not replace live tasks during building.'), 'source-status'))
    if (!object(workspace.selection) || !object(workspace.coverage)) {
      el.append(make('p', 'The retained workspace has incomplete global policy fields. Restore a complete source draft before building.')); return
    }
    el.append(field('Combined construction and sampling rationale', 'rationale', workspace.rationale, next => { workspace.rationale = next }, true),
      field('Shared frozen random seed', 'seed', workspace.seed, next => { workspace.seed = next }),
      select('Combined task selection', 'selection-kind', workspace.selection.kind, [['all', 'All candidates'], ['seeded', 'Seeded selection'], ['balanced', 'Balanced coverage selection']], next => { workspace.selection.kind = next }),
      field('Maximum selected tasks across all families', 'selection-limit', workspace.selection.limit, next => { workspace.selection.limit = next }),
      select('Coverage within each family', 'coverage-kind', workspace.coverage.kind, [['none', 'Family quota only'], ['marginal', 'Every factor choice within its family'], ['pairwise', 'Every pair of choices within its family']], next => { workspace.coverage.kind = next }),
      field('Minimum tasks per coverage cell', 'coverage-minimum', workspace.coverage.minimum, next => { workspace.coverage.minimum = next }))
    el.append(select('Family to inspect and edit', 'family', selectedTaskId, [['', 'Choose a retained family'], ...retained.map(family => {
      const taskId = family.sourceTask?.id || '', fields = family.fields || {}, missing = !sources.some(source => source.taskId === taskId)
      return [taskId, (fields.familyId || '(unnamed generated family)') + ' / ' + taskId + ' / ' + (fields.split || '(split not supplied)') + (missing ? ' (source task missing; import it before building)' : '')]
    })], next => {
      selectedTaskId = next
      if (retained.some(family => family.sourceTask?.id === next)) onSelect(next)
    }, false), button('Remove selected family', 'remove', () => onRemove(selectedTaskId), canRemove))
    el.append(select('Source task to add', 'source', sourceTaskId, [['', 'Choose an available source task'], ...available().map(source =>
      [source.taskId, (source.label || source.taskId) + ' / ' + source.taskId + ' / ' + (source.familyId || source.taskId) + ' / ' + source.split])], next => { sourceTaskId = next }, false),
    button('Add source family', 'add', () => onAdd(sourceTaskId), canAdd),
    make('p', 'Adding or removing a family is applied by the workspace with Undo. Two source tasks from one original family require an explicit supported design; selecting them does not establish independence.'))
  }
  function render() {
    if (destroyed) return
    const active = document.activeElement, key = el.contains(active) ? active.getAttribute('data-composition-family-fields-focus') : null
    const start = active?.selectionStart, end = active?.selectionEnd
    renderContent(); sync()
    if (key !== null) {
      const next = [...el.querySelectorAll('[data-composition-family-fields-focus]')].find(node => node.getAttribute('data-composition-family-fields-focus') === key)
      if (next && !next.disabled) { next.focus({ preventScroll: true }); if (typeof start === 'number' && typeof next.setSelectionRange === 'function') next.setSelectionRange(start, end) }
    }
  }
  render()
  return {
    el,
    setContext(context = {}) {
      if (destroyed) return
      workspace = context.workspace ? copy(context.workspace) : null; sources = copy(rows(context.sources))
      if (!workspace) { sourceTaskId = ''; selectedTaskId = '' }
      else if (context.selectedTaskId !== undefined) selectedTaskId = context.selectedTaskId ?? ''
      render()
    },
    setDisabled(value) { disabled = Boolean(value); sync() },
    destroy() { destroyed = true; el.replaceChildren() },
  }
}
