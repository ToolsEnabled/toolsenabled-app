import { addInformationFieldReading } from './research-information-fields.mjs'

const copy = value => structuredClone(value)
const rows = value => Array.isArray(value) ? value : []
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// These controls edit authoring fields only. The pure helper builds complete
// reading roots and invokes the canonical task compiler before publication.
export function createInformationFieldsEditor({ onChange = () => {} } = {}) {
  let inventory = null, draft = null, selected = '', sourceKey = '', parameterKey = ''
  let disabled = false, stale = false, unreadable = false, destroyed = false, revision = 0, message = ''
  const el = document.createElement('div')
  const make = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node }
  const mark = (node, name, value = '') => { node.setAttribute('data-information-fields-' + name, value); return node }
  const focus = (node, key) => mark(node, 'focus', key)
  mark(el, 'editor')
  const label = (text, input) => { const node = make('label'); node.append(make('span', text), input); return node }
  const editable = () => !disabled && !stale && !unreadable && !destroyed && !!inventory && !!draft
  const emit = () => onChange(copy(draft))
  const activeRow = () => rows(draft?.readings).find(row => row.key === selected)
  const sourceFor = row => rows(inventory?.sources).find(source => source.key === row?.sourceKey)
  const paramFor = (source, edit) => rows(source?.parameters).find(parameter => same(parameter.path, edit.path) && parameter.name === edit.parameter)
  function bind(input, update, { redraw = false, publish = true, navigate = false } = {}) {
    const at = revision
    input.addEventListener('input', event => {
      event.stopPropagation()
      if (destroyed || disabled || at !== revision || !el.contains(input) || input.disabled || (!navigate && !editable())) return
      try {
        update(input.type === 'checkbox' ? input.checked : input.value)
        message = ''; if (publish) emit(); if (redraw) render()
      } catch (error) { message = error.message; render() }
    })
    input.addEventListener('change', event => event.stopPropagation())
  }
  function field(title, name, value, update, { multiline = false, key = name, locked = false } = {}) {
    const input = focus(mark(make(multiline ? 'textarea' : 'input'), name), key)
    input.setAttribute('aria-label', title)
    if (multiline) input.setAttribute('rows', '3'); else { input.type = 'text'; input.setAttribute('type', 'text') }
    input.value = value ?? ''; if (locked) mark(input, 'locked')
    bind(input, update); return label(title, input)
  }
  function select(title, name, value, choices, update, options = {}) {
    const input = focus(mark(make('select'), name), options.key || name), available = [...choices]
    if (!available.some(([key]) => key === value)) available.unshift([value ?? '', value ? String(value) + ' (unavailable)' : 'Choose a value'])
    for (const [key, text] of available) { const option = make('option', text); option.value = key; option.setAttribute('value', key); input.append(option) }
    input.value = value ?? ''; input.setAttribute('aria-label', title)
    if (options.navigate) mark(input, 'navigation')
    bind(input, update, options); return label(title, input)
  }
  function checkbox(title, name, checked, update, { key = name, redraw = false } = {}) {
    const input = focus(mark(make('input'), name), key)
    input.type = 'checkbox'; input.setAttribute('type', 'checkbox'); input.checked = checked === true
    input.setAttribute('aria-label', title); bind(input, update, { redraw }); return label(title, input)
  }
  function button(title, name, action, { locked = false, key = name } = {}) {
    const node = focus(mark(make('button', title), name), key), at = revision
    node.type = 'button'; node.setAttribute('type', 'button'); if (locked) mark(node, 'locked')
    node.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation()
      if (!editable() || node.disabled || at !== revision || !el.contains(node)) return
      try { action(); message = ''; emit(); render() } catch (error) { message = error.message; render() }
    })
    return node
  }
  function lock() {
    for (const tag of ['input', 'textarea', 'select', 'button']) for (const node of el.querySelectorAll(tag))
      node.disabled = disabled || node.hasAttribute('data-information-fields-locked') || (!node.hasAttribute('data-information-fields-navigation') && !editable())
  }
  function expectedAfterEdit(row) {
    if (row.expected?.mode === 'retained') row.expected = { mode: '', text: '' }
  }
  function content() {
    revision++; unreadable = false; el.replaceChildren()
    if (!draft) { el.append(make('p', 'Prepare the applied task to enumerate its atom occurrences and exact source readings.')); return }
    if (!inventory) { el.append(make('p', 'Your field draft is retained. Prepare the current task to inspect its bound source roster.')); return }
    // Advanced draft text can be temporarily incomplete or have the wrong
    // shape. Preserve it for repair or explicit replacement; never render a
    // partial list and publish that list back over the retained source text.
    if (!Array.isArray(draft.readings) || draft.readings.some(row => !row || typeof row !== 'object'
      || !Array.isArray(row.edits) || row.edits.some(edit => !edit || typeof edit !== 'object' || !Array.isArray(edit.path)))) {
      unreadable = true
      el.append(mark(make('p', 'The retained draft has an invalid reading or local-edit shape. Repair its advanced field text, or explicitly replace fields from the applied task. Your text is unchanged.'), 'error'))
      return
    }
    const isStale = stale || draft.bindingSha256 !== inventory.bindingSha256 || draft.taskId !== inventory.taskId
    stale = isStale
    el.append(mark(make('p', isStale ? 'Source task or setup changed. Inspect retained fields, then explicitly replace them from the applied task if needed.'
      : 'Each reading copies an exact source root. Only the local parameter overrides you enter are changed; the canonical compiler checks all reading and prompt constraints.'), 'status'))
    if (message) el.append(mark(make('p', message), 'error'))
    el.append(field('Task family ID', 'family', draft.familyId, value => { draft.familyId = value }),
      field('Treatment rationale', 'rationale', draft.rationale, value => { draft.rationale = value }, { multiline: true }),
      select('Reading selection rule', 'selection', draft.selection, [['readings', 'Require all readings to agree on compiled task text'], ['readingPool', 'Filter candidates by compiled task text']], value => { draft.selection = value }),
      select('Response format', 'response-mode', draft.responseMode, [['raw', 'Requested answer only'], ['tagged-json', 'JSON answer, clarification or refusal']], value => { draft.responseMode = value }))
    const atoms = mark(make('fieldset'), 'atoms'); atoms.append(make('legend', 'Withheld atom occurrences'))
    for (const atom of rows(inventory.atoms)) {
      const control = checkbox(atom.path + ' / ' + atom.bundleId, 'withhold', rows(draft.withheldPaths).includes(atom.path), value => {
        const paths = rows(draft.withheldPaths)
        draft.withheldPaths = value ? [...new Set([...paths, atom.path])] : paths.filter(path => path !== atom.path)
      }, { key: 'withhold:' + atom.path })
      control.querySelector('input').setAttribute('data-information-fields-path', atom.path); atoms.append(control)
    }
    atoms.append(make('p', 'Only these baseline atoms can be withheld. Every reading must retain the selected paths; templates and execution appendices remain disclosed.'))
    el.append(atoms)
    if (!rows(inventory.sources).some(source => source.key === sourceKey)) sourceKey = inventory.sources[0]?.key || ''
    el.append(select('Source for a new reading', 'source', sourceKey, rows(inventory.sources).map(source => [source.key, source.label]), value => { sourceKey = value }, { publish: false }),
      button('Add reading from selected source', 'add-reading', () => {
        draft = addInformationFieldReading(inventory, draft, sourceKey); selected = draft.readings.at(-1).key; parameterKey = ''
      }, { locked: rows(draft.readings).length >= 64 || !sourceKey }))
    if (!rows(draft.readings).length) { el.append(make('p', 'Add a reading explicitly, give it an ID and rationale, and supply its intended alternatives. No reading is inferred.')); return }
    if (!draft.readings.some(row => row.key === selected)) selected = draft.readings[0].key
    el.append(select('Reading to edit', 'reading', selected, draft.readings.map((row, index) => [row.key, (row.id || 'Reading ' + (index + 1)) + ' / ' + row.sourceKey]), value => {
      selected = value; parameterKey = ''
    }, { redraw: true, publish: false, navigate: true }))
    const row = activeRow(), source = sourceFor(row)
    if (!row || !source) { el.append(make('p', 'The original source for this retained reading is unavailable. Its draft is preserved; no replacement was inferred.')); return }
    el.append(field('Reading ID', 'reading-id', row.id, value => { row.id = value }, { key: row.key + '/id' }),
      field('Reading rationale', 'reading-rationale', row.rationale, value => { row.rationale = value }, { multiline: true, key: row.key + '/rationale' }),
      checkbox('Include a reading label', 'label-included', row.label !== null, value => { row.label = value ? '' : null }, { key: row.key + '/include-label', redraw: true }))
    if (row.label !== null) el.append(field('Reading label', 'reading-label', row.label, value => { row.label = value }, { key: row.key + '/label' }))
    const parameters = rows(source.parameters)
    if (!parameters.some(parameter => parameter.key === parameterKey)) parameterKey = parameters[0]?.key || ''
    el.append(select('Local parameter to vary', 'parameter', parameterKey, parameters.map(parameter => [parameter.key,
      parameter.pathLabel + ' / ' + parameter.name + ' (' + parameter.kind + ')']), value => { parameterKey = value }, { publish: false }),
      button('Add local parameter override', 'add-edit', () => {
        const parameter = parameters.find(value => value.key === parameterKey)
        if (!parameter || rows(row.edits).some(edit => same(edit.path, parameter.path) && edit.parameter === parameter.name)) return
        row.edits.push({ path: copy(parameter.path), parameter: parameter.name, kind: parameter.kind, text: parameter.text })
        expectedAfterEdit(row)
      }, { locked: !parameters.length }))
    rows(row.edits).forEach((edit, index) => {
      const node = mark(make('fieldset'), 'edit', String(index)), key = row.key + '/edit/' + index
      const parameter = paramFor(source, edit)
      node.append(make('legend', 'root' + edit.path.map(part => '/' + part).join('') + ' / ' + edit.parameter + ' (' + edit.kind + ')'))
      if (!parameter) node.append(make('p', 'This retained local override is unavailable in its exact source; remove it or explicitly replace the stale draft.'))
      const update = value => { edit.text = value }
      if (edit.kind === 'boolean') node.append(select('Parameter value', 'edit-value', edit.text, [['true', 'true'], ['false', 'false']], update, { key: key + '/value' }))
      else node.append(field('Parameter value', 'edit-value', edit.text, update, { key: key + '/value' }))
      node.append(button('Remove this override', 'remove-edit', () => { row.edits.splice(index, 1) }, { key: key + '/remove' }))
      el.append(node)
    })
    el.append(make('p', 'Local edits retain the source root, variables and all other branches. Structural alternatives remain available in advanced reading JSON. After editing a generic reading, supply its expected answer explicitly.'))
    const modes = [['retained', 'Keep the unchanged source answer'], ['declare', 'Declare the expected answer']]
    if (inventory.domain === 'lean-bench') modes.push(['derive-lean', 'Derive with the existing LEAN interpreter'])
    el.append(select('Expected-answer policy', 'expected-mode', row.expected?.mode, modes, value => {
      row.expected = { mode: value, text: row.expected?.text || '' }
    }, { redraw: true, key: row.key + '/expected-mode' }))
    if (row.expected?.mode === 'declare') el.append(field(inventory.gradingKind === 'exact' ? 'Expected exact text' : 'Expected answer (JSON value)', 'expected-text', row.expected.text,
      value => { row.expected.text = value }, { multiline: true, key: row.key + '/expected-text' }))
    if (row.expected?.mode === 'derive-lean') el.append(make('p', 'Building explicitly derives this reading’s observation with the existing interpreter. The result still needs independent qualification and personal review.'))
    el.append(checkbox('Include convention assignments', 'conventions-included', row.conventionsText !== null, value => { row.conventionsText = value ? '{}' : null }, { key: row.key + '/include-conventions', redraw: true }))
    if (row.conventionsText !== null) el.append(field('Convention assignments (JSON object)', 'conventions', row.conventionsText, value => { row.conventionsText = value }, { multiline: true, key: row.key + '/conventions' }))
    const advanced = make('details'); advanced.append(make('summary', 'Exact source reading retained by these fields'), make('pre', JSON.stringify(source.reading, null, 2)))
    el.append(advanced, button('Remove reading', 'remove-reading', () => { draft.readings = draft.readings.filter(value => value.key !== selected); selected = ''; parameterKey = '' }, { key: row.key + '/remove' }))
  }
  function render() {
    if (destroyed) return
    const active = document.activeElement, key = el.contains(active) ? active.getAttribute('data-information-fields-focus') : null
    const start = active?.selectionStart, end = active?.selectionEnd
    content(); lock()
    if (key !== null) {
      const next = [...el.querySelectorAll('[data-information-fields-focus]')].find(node => node.getAttribute('data-information-fields-focus') === key)
      if (next && !next.disabled) { next.focus({ preventScroll: true }); if (typeof start === 'number' && typeof next.setSelectionRange === 'function') next.setSelectionRange(start, end) }
    }
  }
  render()
  return { el,
    setContext(nextInventory, nextDraft, options = {}) {
      if (destroyed) return
      const nextStale = options.stale === true || !!nextDraft && !!nextInventory && (nextDraft.bindingSha256 !== nextInventory.bindingSha256 || nextDraft.taskId !== nextInventory.taskId)
      if (same(inventory, nextInventory) && same(draft, nextDraft) && stale === nextStale) return
      inventory = nextInventory ? copy(nextInventory) : null; draft = nextDraft ? copy(nextDraft) : null; stale = nextStale; render()
    },
    getDraft: () => copy(draft),
    setDisabled(value) { disabled = !!value; lock() },
    destroy() { destroyed = true; revision++; el.replaceChildren() },
  }
}
